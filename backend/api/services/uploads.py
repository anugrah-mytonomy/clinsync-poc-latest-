"""Uploads: confirm and hand to the background (R2), and Anugrah's Upload API behind /api/uploads/*
(upload-ingest-merge U1–U4, design.md §5.1)."""
import math
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any, TypeVar

from botocore.exceptions import BotoCoreError, ClientError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api import storage, task_producer
from api.naming import file_name_norm
from shared.config import get_settings
from shared import s3_paths
from shared import s3_paths
from shared import s3_paths
from shared.logging import get_logger
from api.repositories import audit, candidates, documents, files

log = get_logger(__name__)
Enqueue = Callable[[str, str], None]


@dataclass(frozen=True)
class Confirmed:
    """What confirm returns to the caller."""

    status: str
    enqueued: bool


def confirm(db: Session, file_id: uuid.UUID, enqueue: Enqueue | None = None) -> Confirmed | None:
    """staged|uploading → uploaded, commit, then enqueue once; later statuses come back unchanged. None if unknown."""
    result = files.confirm_upload(db, file_id)   # commits before returning
    if result is None:
        return None
    if not result.transitioned:
        return Confirmed(result.status, enqueued=False)
    delay = files.ingest_enqueue_countdown_seconds(db, file_id)
    try:
        if enqueue is not None:
            enqueue(str(file_id), str(result.organization_id))
        else:
            task_producer.enqueue_process_upload(str(file_id), str(result.organization_id), countdown=delay)
            if delay:
                log.info("ingest_staggered", file_id=str(file_id), countdown_seconds=delay)
            if delay:
                log.info("ingest_staggered", file_id=str(file_id), countdown_seconds=delay)
            if delay:
                log.info("ingest_staggered", file_id=str(file_id), countdown_seconds=delay)
    except Exception as exc:
        # R2.6: the file stays `uploaded`; the reconcile sweeper re-enqueues it.
        log.warning("enqueue_failed", file_id=str(file_id), error=repr(exc))
        return Confirmed("uploaded", enqueued=False)
    log.info("enqueued", file_id=str(file_id))
    return Confirmed("uploaded", enqueued=True)


# ── Anugrah's Upload API ────────────────────────────────────────────────────
# Error texts are his, word for word (U12.1); his client shows `detail` and spots duplicates by the word.

T = TypeVar("T")
MIB = 1024 * 1024
S3_NOT_FOUND = {"NoSuchUpload", "NoSuchKey", "NoSuchBucket"}


class UploadRefused(Exception):
    """An Upload API refusal: the route answers `status` with {"detail": detail}."""

    def __init__(self, status: int, detail: str) -> None:
        """Record the HTTP status and the detail text."""
        super().__init__(detail)
        self.status, self.detail = status, detail


def duplicate_message(filename: str) -> str:
    """Anugrah's duplicate text; the client marks a row Duplicate because it contains the word."""
    return f"Duplicate file — {filename} has already been uploaded."


def _s3(call: Callable[..., T], *args: Any) -> T:
    """Run one storage call, turning S3 failures into Anugrah's responses: 404/502 "S3 error (…)", 500 otherwise."""
    try:
        return call(*args)
    except ClientError as exc:
        error = exc.response.get("Error", {})
        code, message = error.get("Code", ""), error.get("Message", str(exc))
        raise UploadRefused(404 if code in S3_NOT_FOUND else 502, f"S3 error ({code}): {message}") from exc
    except BotoCoreError as exc:
        raise UploadRefused(500, f"Upload storage failed: {exc}") from exc


def _organization() -> uuid.UUID:
    """The one POC organization; auth and organizations are out of scope (requirements §1.2)."""
    organization_id = get_settings().POC_ORGANIZATION_ID
    if organization_id is None:
        raise UploadRefused(503, "POC_ORGANIZATION_ID is not set")
    return organization_id


def incoming_key(organization_id: uuid.UUID, batch_id: uuid.UUID, file_id: uuid.UUID, filename: str) -> str:
    """The server-built key (U1.6): clynsync/incoming/{batch}/{file_id}_{name}. Opaque to the client."""
    del organization_id  # org is not part of the S3 path in this POC layout
    return s3_paths.incoming_key(batch_id, file_id, filename)


def is_duplicate(db: Session, filename: str, file_size: int) -> bool:
    """A library document with this name (case-insensitive) and size exists (U6.1)."""
    found = documents.find_by_name_size(db, _organization(), filename, file_size)
    db.rollback()                        # read-only; end the transaction
    return found is not None


@dataclass(frozen=True)
class Initiated:
    """What initiate returns: Anugrah's fields plus the batch and presigned part PUT URLs."""

    file_id: uuid.UUID
    batch_id: uuid.UUID
    upload_id: str
    key: str
    part_size: int
    total_parts: int
    part_urls: dict[int, str]


MAX_ZIP_BYTES = 300 * MIB              # Content Library Upload API (design.md §5.2a)


def _size_limit(limit_bytes: int) -> str:
    """5368709120 → "5 GB", 314572800 → "300 MB"."""
    gib = limit_bytes / (1024 * MIB)
    return f"{gib:g} GB" if limit_bytes >= 1024 * MIB and gib == int(gib) else f"{limit_bytes // MIB} MB"


def initiate(db: Session, *, filename: str, file_size: int, content_type: str | None,
             batch_id: uuid.UUID | None, replaces_document_id: uuid.UUID | None = None,
             content_library: bool = False) -> Initiated:
    """Register a file and start its multipart upload (U1): 413 too big, 400 type, 409 duplicate or closed batch.

    content_library — the /clinsync/uploads/* rules (design.md §5.2a): the batch must exist, ZIPs are capped at
    300 MB, a duplicate is a library document with the same NAME (any size), and a replace names the document it
    supersedes (never for a ZIP).
    """
    s = get_settings()
    is_zip = files.file_ext_of(filename) == "zip"
    if file_size > s.MAX_UPLOAD_BYTES:
        limit = _size_limit(s.MAX_UPLOAD_BYTES) if content_library else f"{s.MAX_UPLOAD_BYTES // MIB} MB"
        raise UploadRefused(413, f"File exceeds the {limit} limit for cloud uploads.")
    if content_library and is_zip and file_size > MAX_ZIP_BYTES:
        raise UploadRefused(413, "ZIP exceeds the 300 MB limit.")
    if files.file_ext_of(filename) not in s.ALLOWED_TOP_LEVEL_EXT:
        raise UploadRefused(400, f"Unsupported file type: {filename}")
    if replaces_document_id is not None and is_zip:
        raise UploadRefused(400, "An archive cannot replace a library document.")
    organization_id = _organization()
    if replaces_document_id is not None:
        found = documents.exists(db, organization_id, replaces_document_id)
        db.rollback()
        if not found:
            raise UploadRefused(404, "The document to replace was not found in the library.")
    elif content_library:
        clash = documents.find_by_names(db, organization_id, [filename])
        db.rollback()
        if clash:
            raise UploadRefused(409, duplicate_message(filename))
    elif is_duplicate(db, filename, file_size):
        raise UploadRefused(409, duplicate_message(filename))
    if content_library:
        if batch_id is None:
            raise UploadRefused(400, "batchId is required.")
        batch_status = files.batch_status(db, batch_id)
        db.rollback()
        if batch_status is None:
            raise UploadRefused(404, f"Batch {batch_id} not found.")
    else:
        batch_id = batch_id or uuid.uuid4()
        batch_status = files.ensure_batch(db, batch_id, organization_id, s.POC_USER_ID)
    if batch_status in ("committed", "abandoned"):
        raise UploadRefused(409, f"Batch {batch_id} is already {batch_status}.")

    file_id = uuid.uuid4()
    key = incoming_key(organization_id, batch_id, file_id, filename)
    upload_id = _s3(storage.create_multipart, key, content_type)
    try:
        files.create_upload(db, file_id=file_id, batch_id=batch_id, organization_id=organization_id,
                            file_name=filename, size_bytes=file_size, content_type=content_type, s3_key=key,
                            upload_id=upload_id, replaces_document_id=replaces_document_id)
        db.commit()
    except Exception:
        db.rollback()
        storage.abort_multipart(key, upload_id)      # Anugrah's order: no multipart upload without its row
        raise
    total_parts = max(1, math.ceil(file_size / s.UPLOAD_PART_SIZE_BYTES))
    files.mark_uploading(db, file_id)
    part_urls = {n: _s3(storage.presign_part, key, upload_id, n) for n in range(1, total_parts + 1)}
    log.info("upload_initiated", file_id=str(file_id), batch_id=str(batch_id), size_bytes=file_size,
             total_parts=total_parts)
    return Initiated(file_id=file_id, batch_id=batch_id, upload_id=upload_id, key=key,
                     part_size=s.UPLOAD_PART_SIZE_BYTES, total_parts=total_parts, part_urls=part_urls)


def create_batch(db: Session) -> uuid.UUID:
    """A new open batch for one Upload click (design.md §5.2a)."""
    return files.create_batch(db, _organization(), get_settings().POC_USER_ID)


def check_duplicates(db: Session, uploads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Library documents with the same file name as a queued file — or, for a ZIP, as one of its entries (§5.2a).

    uploads: [{fileName, sizeBytes, entries?: [{fileName, sizeBytes}]}]. Answers only the matches, in request order.
    """
    names = [e["fileName"] for u in uploads for e in (u.get("entries") or [])]
    names += [u["fileName"] for u in uploads if not u.get("entries")]
    found = documents.find_by_names(db, _organization(), names)
    db.rollback()                        # read-only
    matches: list[dict[str, Any]] = []

    def add(file_name: str, archive_name: str | None) -> None:
        doc = found.get(file_name_norm(file_name))
        if doc is None:
            return
        entry: dict[str, Any] = {"fileName": file_name, "match": {
            "fileId": str(doc["document_id"]), "sizeBytes": doc["size_bytes"], "addedAt": doc["added_at"],
            "version": doc["current_version"], "specialties": [], "documentType": None}}
        if archive_name is not None:
            entry = {"archiveName": archive_name, **entry}
        matches.append(entry)

    for upload in uploads:
        if upload.get("entries"):
            for e in upload["entries"]:
                add(e["fileName"], upload["fileName"])
        else:
            add(upload["fileName"], None)
    return matches


def discard(db: Session, *, file_id: uuid.UUID, upload_id: str) -> None:
    """Before a Retry: abort the file's multipart upload (best effort) and delete its row if it never got past
    uploading, or failed (design.md §5.2a). Unknown or finished files are left alone."""
    row = files.find_by_file_and_upload(db, file_id, upload_id, lock=True)
    if row is None:
        db.rollback()
        return
    if row.status in ("staged", "uploading"):
        try:
            storage.abort_multipart(row.s3_key, row.upload_id)
        except Exception as exc:                          # the bucket's abort-incomplete rule cleans up later
            log.warning("discard_abort_failed", file_id=str(row.file_id), error=repr(exc))
    deleted = files.delete_failed_upload(db, row.file_id)
    db.commit()
    log.info("upload_discarded", file_id=str(row.file_id), deleted=deleted)


def _awaiting(db: Session, file_id: uuid.UUID, upload_id: str, *, lock: bool = False) -> files.UploadRow:
    """The file for this fileId + uploadId pair, still staged or uploading: else 404 or 409 (U2.2)."""
    row = files.find_by_file_and_upload(db, file_id, upload_id, lock=lock)
    if row is None:
        db.rollback()
        raise UploadRefused(404, "Upload not found.")
    if row.status not in ("staged", "uploading"):
        db.rollback()
        raise UploadRefused(409, "Upload is not awaiting completion.")
    return row


def presign(db: Session, *, file_id: uuid.UUID, upload_id: str, part_numbers: list[int]) -> dict[int, str]:
    """Presigned PUT URLs on the public host, one per part (U2); for retries after initiate."""
    if not part_numbers:
        raise UploadRefused(400, "partNumbers must not be empty.")
    row = _awaiting(db, file_id, upload_id)
    files.mark_uploading(db, row.file_id)
    return {n: _s3(storage.presign_part, row.s3_key, row.upload_id, n) for n in part_numbers}


def parts(db: Session, *, file_id: uuid.UUID, upload_id: str) -> list[dict[str, Any]]:
    """Parts already in S3, for resuming (U2.1); same pair check as presign."""
    row = _awaiting(db, file_id, upload_id)
    db.rollback()                        # read-only; end the transaction before the S3 call
    try:
        return _s3(storage.list_parts, row.s3_key, row.upload_id)
    except storage.NoSuchUpload as exc:
        raise UploadRefused(404, f"S3 error ({exc.code or 'NoSuchUpload'}): {exc}") from exc


def abort(db: Session, *, file_id: uuid.UUID, upload_id: str) -> None:
    """Cancel a staged or uploading file: abort its multipart upload, end it `error` "Upload cancelled" (U4.1).

    Any later status is left exactly as it is (D15): the client also sends abort when a finished row is removed.
    The row lock makes a racing complete either finish first (abort is then a no-op) or see the file cancelled.
    """
    row = files.find_by_file_and_upload(db, file_id, upload_id, lock=True)
    if row is None:
        db.rollback()
        raise UploadRefused(404, "Upload not found.")
    if row.status not in ("staged", "uploading"):
        db.rollback()
        log.info("abort_ignored", file_id=str(row.file_id), status=row.status)
        return
    try:
        _s3(storage.abort_multipart, row.s3_key, row.upload_id)
    except UploadRefused:
        db.rollback()                    # S3 still has the upload: leave the file as it was
        raise
    files.cancel_upload(db, row.file_id)
    db.commit()
    log.info("upload_cancelled", file_id=str(row.file_id), batch_id=str(row.batch_id))


def list_uploads(db: Session) -> list[dict[str, Any]]:
    """Uploads past `uploading`, newest first, in Anugrah's GET /api/uploads shape (U4.2).

    s3_location, parent_id and source_path have no LLD column and merged uploads have no parent: they are null.
    """
    rows = files.list_uploads(db, _organization())
    db.rollback()
    return [{"id": str(r["file_id"]), "filename": r["file_name"], "size_bytes": r["size_bytes"],
             "content_type": r["content_type"], "s3_key": r["s3_key"], "s3_location": None, "status": r["status"],
             "parent_id": None, "source_path": None, "created_at": r["created_at"]} for r in rows]


@dataclass(frozen=True)
class Completed:
    """What complete returns: Anugrah's fields plus the batch."""

    file_id: uuid.UUID
    batch_id: uuid.UUID
    key: str
    location: str
    status: str


def complete(db: Session, *, file_id: uuid.UUID, upload_id: str, parts: list[dict[str, Any]],
             check_size: bool = False) -> Completed:
    """Finish the S3 upload, then hand over exactly as the Ingest confirm does (U3, design.md §5.3).

    No download, no hashing, no validation — the Worker does those (U3.3). Called again for a file already past
    uploading, it returns the current status and enqueues nothing (U3.5). If S3 refuses the parts, or the upload
    has expired, the file's status does not change, so the client can retry (U3.6).
    """
    if not parts:
        raise UploadRefused(400, "parts must not be empty.")
    row = files.find_by_file_and_upload(db, file_id, upload_id)
    db.rollback()                        # read-only so far; confirm below runs its own transaction
    if row is None:
        raise UploadRefused(404, "Upload not found.")
    location = f"s3://{get_settings().S3_BUCKET}/{row.s3_key}"   # stable; never the internal hostname
    if row.status not in ("staged", "uploading"):
        return Completed(row.file_id, row.batch_id, row.s3_key, location, row.status)
    try:
        _s3(storage.complete_multipart, row.s3_key, row.upload_id, parts)
    except storage.NoSuchUpload as exc:
        # An earlier complete may have assembled the object and died before confirm: carry on if it is there.
        if not _s3(storage.exists, row.s3_key):
            raise UploadRefused(400, "Upload session expired — start the upload again") from exc
        log.info("complete_retry_after_s3_completion", file_id=str(row.file_id))
    except storage.InvalidParts as exc:
        raise UploadRefused(400, f"S3 error ({exc.code}): {exc}") from exc
    if check_size:                       # Content Library API (design.md §5.2a): the object must be the size declared
        expected = files.declared_size(db, row.file_id)
        actual = _s3(storage.object_size, row.s3_key)
        db.rollback()
        if expected is not None and actual is not None and actual != expected:
            message = f"Uploaded {actual} bytes, expected {expected}"
            files.mark_s3_upload_failed(db, row.file_id, message=message, attempt=1)
            db.commit()
            try:
                storage.delete(row.s3_key)
            except Exception as exc:     # the incoming/ lifecycle rule removes it later
                log.warning("size_mismatch_delete_failed", file_id=str(row.file_id), error=repr(exc))
            log.info("upload_size_mismatch", file_id=str(row.file_id), expected=expected, actual=actual)
            raise UploadRefused(400, message)
    result = confirm(db, row.file_id)    # the Ingest confirm: staged|uploading → uploaded, commit, THEN enqueue
    status = result.status if result else row.status
    log.info("upload_completed", file_id=str(row.file_id), batch_id=str(row.batch_id), status=status,
             enqueued=bool(result and result.enqueued))
    return Completed(row.file_id, row.batch_id, row.s3_key, location, status)


# ── Commit: add a batch's ready candidates to the library (U8, design.md §5.4) ──

ALREADY_IN_LIBRARY = "Already in the library"
SAME_FILE_IN_BATCH = "Same file as another in this batch"
TITLE_IN_LIBRARY = "A document with this title is already in the library"
REPLACE_TARGET_GONE = "The document to replace is no longer in the library"
IDENTICAL_TO_CURRENT = "Identical to the current version"


class BatchNotFound(Exception):
    """No such batch."""


@dataclass(frozen=True)
class CommitResult:
    """What a commit did: documents added, candidates skipped with reasons, files still in progress."""

    added: list[uuid.UUID]
    skipped: list[dict[str, Any]]
    still_in_progress: int
    replaced: list[dict[str, Any]] = field(default_factory=list)


def _replace(db: Session, organization_id: uuid.UUID, c: Any, replaced: list[dict[str, Any]],
             doomed: list[str]) -> str | None:
    """Move the candidate's target document to a new version (design.md §5.2a); the skip reason, or None if done."""
    target = documents.lock_for_replace(db, organization_id, c.replaces_document_id)
    if target is None:
        return REPLACE_TARGET_GONE
    if target.content_hash == c.content_hash:
        return IDENTICAL_TO_CURRENT
    if documents.other_with_content(db, organization_id, c.content_hash, target.document_id) is not None:
        return ALREADY_IN_LIBRARY
    version = target.current_version + 1
    key = documents.document_key(organization_id, target.document_id, c.file_name, version)
    documents.replace_version(db, document_id=target.document_id, version=version, file_name=c.file_name,
                              file_ext=c.file_ext, size_bytes=c.size_bytes, content_hash=c.content_hash, s3_key=key,
                              source_file_id=c.source_file_id, uploaded_by=get_settings().POC_USER_ID)
    storage.copy(c.s3_key, key)                                     # staging → processed, BEFORE db.commit
    if target.s3_key != key:
        doomed.append(target.s3_key)                                # the prior version is not retained
    replaced.append({"document_id": target.document_id, "version": version,
                     "previous_version": target.current_version})
    return None


def _is_title_clash(exc: IntegrityError) -> bool:
    """True if the insert broke uq_org_title (the only integrity error a commit turns into a skip)."""
    return getattr(getattr(exc.orig, "diag", None), "constraint_name", None) == "uq_org_title"


def commit(db: Session, batch_id: uuid.UUID) -> CommitResult:
    """Add whatever is ready in the batch; safe to call again, and again later (design.md §5.4).

    Order: organization lock, then batch lock; only candidates of FINISHED files; each processed one re-checked
    for duplicates under the lock (content, then title — including documents added earlier in this commit), then
    inserted in a savepoint and copied staging → processed BEFORE db.commit; candidates deleted; one audit row;
    the batch committed once nothing is left. Staging objects are deleted only AFTER db.commit — a crash in
    between leaves them to the bucket's 7-day staging expiry. document_id is uuid5(staged_id), so a re-run after a
    crash overwrites the same processed/ objects instead of orphaning them.
    """
    organization_id = files.batch_organization(db, batch_id)
    if organization_id is None:
        db.rollback()
        raise BatchNotFound(batch_id)
    documents.lock_organization(db, organization_id)               # 1 — organization first …
    files.lock_batch(db, batch_id)                                  # 2 — … then the batch, always in this order
    added: list[uuid.UUID] = []
    skipped: list[dict[str, Any]] = []
    replaced: list[dict[str, Any]] = []
    doomed: list[str] = []                                          # objects to delete AFTER the commit
    try:
        for c in candidates.of_finished_files(db, batch_id):        # 3 — only finished files
            if c.status == "rejected":
                candidates.resolve_and_delete(db, c.staged_id, None, None)
                continue
            if c.replaces_document_id is not None:                  # a replace never inserts (design.md §5.2a)
                reason = _replace(db, organization_id, c, replaced, doomed)
                if reason is None:
                    candidates.resolve_and_delete(db, c.staged_id, "replace_existing", c.proposed_title)
                else:
                    skipped.append({"staged_id": c.staged_id, "file_name": c.file_name, "reason": reason})
                    candidates.resolve_and_delete(db, c.staged_id, "discard", c.proposed_title)
                doomed.append(c.s3_key)
                continue
            document_id = documents.document_id_for(c.staged_id)
            key = documents.document_key(organization_id, document_id, c.file_name)
            reason = None
            duplicate = documents.find_duplicate(db, organization_id, c.content_hash, c.title_norm)   # 4 — re-check
            if duplicate is not None:
                reason = (TITLE_IN_LIBRARY if duplicate.kind == "same_title"
                          else SAME_FILE_IN_BATCH if duplicate.document_id in added else ALREADY_IN_LIBRARY)
            else:
                try:
                    with db.begin_nested():                         # 5 — a savepoint: a clash undoes only this
                        documents.insert(db, document_id=document_id, organization_id=organization_id,
                                         title=c.proposed_title, file_name=c.file_name, file_ext=c.file_ext,
                                         size_bytes=c.size_bytes, content_hash=c.content_hash, s3_key=key,
                                         source_file_id=c.source_file_id, uploaded_by=get_settings().POC_USER_ID)
                except IntegrityError as exc:
                    if not _is_title_clash(exc):
                        raise
                    reason = TITLE_IN_LIBRARY
            if reason is None:
                storage.copy(c.s3_key, key)                         # 6 — staging → processed, BEFORE db.commit
                added.append(document_id)
                candidates.resolve_and_delete(db, c.staged_id, "create_new", c.proposed_title)
            else:
                skipped.append({"staged_id": c.staged_id, "file_name": c.file_name, "reason": reason})
                doomed.append(key)            # a copy an earlier, crashed run made for this candidate, if any
                candidates.resolve_and_delete(db, c.staged_id, "discard", c.proposed_title)
            doomed.append(c.s3_key)
        still = files.unfinished_count(db, batch_id)
        details: dict[str, Any] = {"added": [str(d) for d in added], "still_in_progress": still,
                                   "skipped": [{"staged_id": str(s["staged_id"]), "reason": s["reason"]}
                                               for s in skipped]}
        if replaced:                                                # the superseded versions, for the record
            details["replaced"] = [{k: str(v) for k, v in r.items()} for r in replaced]
        audit.write(db, organization_id=organization_id, user_id=get_settings().POC_USER_ID,
                    action="batch_committed", entity_type="upload_batch", entity_id=str(batch_id), details=details)
        if still == 0 and not candidates.any_left(db, batch_id):
            files.mark_batch_committed(db, batch_id)
        db.commit()                                                 # 7 — the rows are safe from here
    except BaseException:
        db.rollback()
        raise
    try:
        storage.delete_many(doomed)                                 # 8 — only after the commit (U8.4)
    except Exception as exc:                                        # leftovers expire with the staging rule
        log.warning("commit_cleanup_failed", batch_id=str(batch_id), keys=len(doomed), error=repr(exc))
    log.info("batch_committed", batch_id=str(batch_id), added=len(added), skipped=len(skipped),
             replaced=len(replaced), still_in_progress=still)
    return CommitResult(added, skipped, still, replaced)
