"""Content Library Upload API, /clinsync/uploads/* (upload-ingest-merge design.md §5.2a).

What the Add Content / Uploading screens call: check-duplicates → batches → initiate (presigned part URLs in the
answer, no presign call) → PUT parts to S3 → complete per file; discard before a Retry. Same services and tables as
/api/uploads/*. Ids are UUID strings. Errors are {"detail": …}, except complete: {"error": {code, message, request_id}}.
"""
import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Literal, TypeVar

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

from api.db import get_db_session
from api.repositories import files
from api.services import uploads

router = APIRouter(prefix="/clinsync/uploads", tags=["clinsync-uploads"])
T = TypeVar("T")


def _answer(call: Callable[[], T]) -> T:
    """Run a service call; an UploadRefused becomes its HTTP status with {"detail": …}."""
    try:
        return call()
    except uploads.UploadRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


# ── check-duplicates ────────────────────────────────────────────────────────

class EntryIn(BaseModel):
    """One file inside a ZIP."""

    fileName: str = Field(min_length=1)
    sizeBytes: int = Field(ge=0)


class FileIn(BaseModel):
    """One queued file; a ZIP lists its entries."""

    fileName: str = Field(min_length=1)
    sizeBytes: int = Field(ge=0)
    entries: list[EntryIn] | None = None


class CheckDuplicatesIn(BaseModel):
    """Every Ready file of one Upload click."""

    files: list[FileIn] = Field(min_length=1)


class MatchOut(BaseModel):
    """The library document a queued file clashes with."""

    fileId: str
    sizeBytes: int
    addedAt: datetime
    version: int
    specialties: list[str]
    documentType: str | None


class DuplicateOut(BaseModel):
    """One matched file; archiveName only for a ZIP entry."""

    archiveName: str | None = None
    fileName: str
    match: MatchOut


class CheckDuplicatesOut(BaseModel):
    """Only the files that matched; empty means no conflicts."""

    matches: list[DuplicateOut]


@router.post("/check-duplicates", response_model=CheckDuplicatesOut, response_model_exclude_unset=True)
def check_duplicates(body: CheckDuplicatesIn, db: Session = Depends(get_db_session)) -> CheckDuplicatesOut:
    """Same file name (case-insensitive) as a library document; size is not compared."""
    found = _answer(lambda: uploads.check_duplicates(db, [f.model_dump() for f in body.files]))
    return CheckDuplicatesOut(matches=[DuplicateOut(**m) for m in found])


# ── batches ─────────────────────────────────────────────────────────────────

class BatchOut(BaseModel):
    """The batch every initiate of this Upload click joins."""

    batchId: str


@router.post("/batches", response_model=BatchOut)
def create_batch(db: Session = Depends(get_db_session)) -> BatchOut:
    """One new batch per Upload click."""
    return BatchOut(batchId=str(_answer(lambda: uploads.create_batch(db))))


# ── initiate ────────────────────────────────────────────────────────────────

class InitiateIn(BaseModel):
    """One file of the batch; replace and replacesDocumentId travel together."""

    batchId: uuid.UUID
    fileName: str = Field(min_length=1)
    fileSize: int = Field(gt=0)
    contentType: str | None = None
    replace: bool = False
    replacesDocumentId: uuid.UUID | None = None
    entries: list[EntryIn] | None = None

    @model_validator(mode="after")
    def _replace_pair(self) -> "InitiateIn":
        """replace: true exactly when replacesDocumentId is sent."""
        if self.replace != (self.replacesDocumentId is not None):
            raise ValueError("replace and replacesDocumentId must be sent together")
        return self


class InitiateOut(BaseModel):
    """The new file's id, its multipart upload, and a presigned PUT URL per part."""

    kind: Literal["document", "archive"]
    fileId: str
    uploadId: str
    partSize: int
    parts: dict[str, str]


@router.post("/initiate", response_model=InitiateOut)
def initiate(body: InitiateIn, db: Session = Depends(get_db_session)) -> InitiateOut:
    """Register the file in its batch and start its multipart upload, with every part's URL."""
    started = _answer(lambda: uploads.initiate(db, filename=body.fileName, file_size=body.fileSize,
                                               content_type=body.contentType, batch_id=body.batchId,
                                               replaces_document_id=body.replacesDocumentId,
                                               content_library=True))
    kind: Literal["document", "archive"] = "archive" if files.file_ext_of(body.fileName) == "zip" else "document"
    return InitiateOut(kind=kind, fileId=str(started.file_id), uploadId=started.upload_id,
                       partSize=started.part_size, parts={str(n): url for n, url in started.part_urls.items()})


# ── complete ────────────────────────────────────────────────────────────────

class PartIn(BaseModel):
    """One part S3 accepted, with its ETag."""

    partNumber: int = Field(ge=1)
    etag: str


class CompleteIn(BaseModel):
    """The multipart upload and every part."""

    uploadId: str
    parts: list[PartIn]


class CompleteOut(BaseModel):
    """The file is in S3 and handed to the background."""

    fileId: str
    status: str


def _complete_code(detail: str, status: int) -> str:
    """Machine-readable code for a complete refusal."""
    lower = detail.lower()
    if status == 404:
        return "upload_not_found"
    if lower.startswith("uploaded ") and "expected" in lower:
        return "size_mismatch"
    if "expired" in lower:
        return "session_expired"
    if "must not be empty" in lower:
        return "empty_parts"
    if lower.startswith("s3 error"):
        return "invalid_parts"
    return "upload_rejected"


@router.post("/{file_id}/complete", response_model=CompleteOut)
def complete(file_id: uuid.UUID, body: CompleteIn, db: Session = Depends(get_db_session)) -> CompleteOut | JSONResponse:
    """Finish this file's S3 upload, then confirm it — once per file, as soon as its parts land."""
    try:
        done = uploads.complete(db, file_id=file_id, upload_id=body.uploadId,
                                parts=[p.model_dump() for p in body.parts], check_size=True)
    except uploads.UploadRefused as exc:
        return JSONResponse(status_code=exc.status, content={"error": {
            "code": _complete_code(exc.detail, exc.status), "message": exc.detail,
            "request_id": f"req-{uuid.uuid4().hex[:8]}"}})
    return CompleteOut(fileId=str(done.file_id), status=done.status)


# ── discard (before a Retry) ────────────────────────────────────────────────

class DiscardIn(BaseModel):
    """The failed file's multipart upload."""

    uploadId: str


@router.post("/{file_id}/discard")
def discard(file_id: uuid.UUID, body: DiscardIn, db: Session = Depends(get_db_session)) -> dict[str, bool]:
    """Remove a failed upload so Retry can initiate it again in the same batch."""
    _answer(lambda: uploads.discard(db, file_id=file_id, upload_id=body.uploadId))
    return {"ok": True}
