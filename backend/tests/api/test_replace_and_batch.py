"""Content Library Upload API, /clinsync/uploads/*, and the replace commit (upload-ingest-merge design.md §5.2a)."""
import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from api.naming import file_name_norm
from api.repositories import documents
from api.services import uploads
from api.services.uploads import ALREADY_IN_LIBRARY, IDENTICAL_TO_CURRENT, REPLACE_TARGET_GONE
from tests.api.test_commit import HASH_A, HASH_B, HASH_C, add_candidate, library, library_document, new_file
from tests.api.test_upload_api import MIB, client  # noqa: F401 — client is a fixture
from tests.db_helpers import POC_ORG
from tests.upload_fakes import FakeStorage, Recorder, enqueued, fake_storage  # noqa: F401 — fixtures

API = "/clinsync/uploads"


def library_doc(db: Session, name: str, size: int, content_hash: str = HASH_A) -> uuid.UUID:
    """A library document with this file name and size (title = the name's stem)."""
    document_id = library_document(db, name.rsplit(".", 1)[0], content_hash)
    db.execute(text("UPDATE documents SET file_name = :n, file_name_norm = :norm, size_bytes = :s "
                    "WHERE document_id = :id"), {"n": name, "norm": file_name_norm(name), "s": size, "id": document_id})
    db.commit()
    return document_id


def file_row(db: Session, file_id: str) -> dict[str, Any] | None:
    """The upload_file row, or None."""
    row = db.execute(text("SELECT * FROM upload_file WHERE file_id = :f"), {"f": file_id}).mappings().one_or_none()
    return dict(row) if row else None


def new_batch(client: TestClient) -> str:  # noqa: F811
    """POST /batches; the new batch id."""
    response = client.post(f"{API}/batches", json={})
    assert response.status_code == 200
    return response.json()["batchId"]


def initiate(client: TestClient, batch_id: str, name: str = "Guide.docx", size: int = 1000,  # noqa: F811
             **extra: Any) -> Any:
    """POST initiate with the Content Library body."""
    return client.post(f"{API}/initiate", json={"batchId": batch_id, "fileName": name, "fileSize": size,
                                                 "contentType": "application/octet-stream", **extra})


# ── batches ─────────────────────────────────────────────────────────────────

def test_batches_creates_an_open_batch(client: TestClient, db_session: Session) -> None:  # noqa: F811
    """One upload_batch row per Upload click, still in progress."""
    batch_id = new_batch(client)
    status = db_session.execute(text("SELECT status FROM upload_batch WHERE batch_id = :b"),
                                {"b": batch_id}).scalar_one()
    assert status == "in_progress"


# ── check-duplicates ────────────────────────────────────────────────────────

def test_check_duplicates_is_empty_when_nothing_clashes(client: TestClient) -> None:  # noqa: F811
    """No library document with these names: matches is empty, so the modal is skipped."""
    response = client.post(f"{API}/check-duplicates", json={"files": [{"fileName": "New.docx", "sizeBytes": 5}]})
    assert response.status_code == 200 and response.json() == {"matches": []}


def test_check_duplicates_matches_by_name_only(client: TestClient, db_session: Session) -> None:  # noqa: F811
    """Same name, any case, a different size: still a match, with the library document's details."""
    document_id = library_doc(db_session, "Whipple Procedure.docx", 3355443)
    response = client.post(f"{API}/check-duplicates", json={"files": [
        {"fileName": "whipple procedure.DOCX", "sizeBytes": 3412000},
        {"fileName": "Other.pdf", "sizeBytes": 10}]})
    (match,) = response.json()["matches"]
    assert match["fileName"] == "whipple procedure.DOCX" and "archiveName" not in match
    assert match["match"]["fileId"] == str(document_id)
    assert (match["match"]["sizeBytes"], match["match"]["version"]) == (3355443, 1)
    assert (match["match"]["specialties"], match["match"]["documentType"]) == ([], None)


def test_check_duplicates_lists_zip_entry_matches_with_the_archive(client: TestClient,  # noqa: F811
                                                                     db_session: Session) -> None:
    """A ZIP answers its entries' matches, each naming the ZIP; never the ZIP's own name."""
    library_doc(db_session, "Famotidine.pdf", 98304)
    library_doc(db_session, "Pack.zip", 1)
    response = client.post(f"{API}/check-duplicates", json={"files": [{
        "fileName": "Pack.zip", "sizeBytes": 100,
        "entries": [{"fileName": "Famotidine.pdf", "sizeBytes": 102400}, {"fileName": "Echo.pdf", "sizeBytes": 5}]}]})
    (match,) = response.json()["matches"]
    assert (match["archiveName"], match["fileName"]) == ("Pack.zip", "Famotidine.pdf")


def test_check_duplicates_needs_a_file(client: TestClient) -> None:  # noqa: F811
    """An empty files list is a 422 with FastAPI's detail body."""
    response = client.post(f"{API}/check-duplicates", json={"files": []})
    assert response.status_code == 422 and isinstance(response.json()["detail"], list)


# ── initiate ────────────────────────────────────────────────────────────────

def test_initiate_returns_kind_ids_and_a_url_per_part(client: TestClient, db_session: Session) -> None:  # noqa: F811
    """ceil(size / partSize) part URLs keyed "1".."n"; the row joins the batch; no presign call needed."""
    batch_id = new_batch(client)
    body = initiate(client, batch_id, "Big.pdf", 20 * MIB).json()
    assert body["kind"] == "document" and body["partSize"] == 8 * MIB
    assert sorted(body["parts"]) == ["1", "2", "3"]
    row = file_row(db_session, body["fileId"])
    assert row is not None and str(row["batch_id"]) == batch_id and row["intent"] == "new"
    assert initiate(client, batch_id, "Pack.zip", 5 * MIB).json()["kind"] == "archive"


def test_initiate_refuses_an_unknown_batch(client: TestClient) -> None:  # noqa: F811
    """The batch comes from POST /batches; an unknown id is 404."""
    response = initiate(client, str(uuid.uuid4()))
    assert response.status_code == 404 and "not found" in response.json()["detail"]


def test_initiate_refuses_a_library_name_unless_replacing(client: TestClient, db_session: Session) -> None:  # noqa: F811
    """Same name as a library document: 409 Duplicate; with replace + replacesDocumentId it is accepted."""
    document_id = library_doc(db_session, "Whipple.docx", 42)
    batch_id = new_batch(client)
    refused = initiate(client, batch_id, "WHIPPLE.docx", 99)
    assert refused.status_code == 409 and refused.json()["detail"] == uploads.duplicate_message("WHIPPLE.docx")
    accepted = initiate(client, batch_id, "WHIPPLE.docx", 99, replace=True, replacesDocumentId=str(document_id))
    assert accepted.status_code == 200
    row = file_row(db_session, accepted.json()["fileId"])
    assert row is not None and (row["intent"], row["replaces_document_id"]) == ("replace", document_id)


def test_initiate_replace_rules(client: TestClient, db_session: Session) -> None:  # noqa: F811
    """replace and replacesDocumentId travel together; a ZIP never replaces; the target must exist."""
    document_id = str(library_doc(db_session, "Doc.docx", 1))
    batch_id = new_batch(client)
    assert initiate(client, batch_id, replace=True).status_code == 422
    assert initiate(client, batch_id, replacesDocumentId=document_id).status_code == 422
    zip_replace = initiate(client, batch_id, "Pack.zip", replace=True, replacesDocumentId=document_id)
    assert (zip_replace.status_code, zip_replace.json()["detail"]) == (400, "An archive cannot replace a library document.")
    gone = initiate(client, batch_id, "Doc.docx", replace=True, replacesDocumentId=str(uuid.uuid4()))
    assert gone.status_code == 404


def test_initiate_caps_a_zip_at_300_mb(client: TestClient) -> None:  # noqa: F811
    """A ZIP over 300 MB is 413."""
    response = initiate(client, new_batch(client), "Huge.zip", 301 * MIB)
    assert (response.status_code, response.json()["detail"]) == (413, "ZIP exceeds the 300 MB limit.")


# ── complete and discard ────────────────────────────────────────────────────

def test_complete_per_file_answers_uploaded(client: TestClient, db_session: Session,  # noqa: F811
                                            fake_storage: FakeStorage, enqueued: Recorder) -> None:  # noqa: F811
    """PUT every part to its URL, then POST /{fileId}/complete: uploaded, enqueued once."""
    body = initiate(client, new_batch(client), "Guide.docx", 9 * MIB).json()
    parts = [{"partNumber": int(n), "etag": fake_storage.put_part(body["uploadId"], int(n))} for n in body["parts"]]
    response = client.post(f"{API}/{body['fileId']}/complete", json={"uploadId": body["uploadId"], "parts": parts})
    assert response.status_code == 200 and response.json() == {"fileId": body["fileId"], "status": "uploaded"}
    assert len(enqueued.calls) == 1


def test_complete_refusals_use_the_error_envelope(client: TestClient) -> None:  # noqa: F811
    """Unknown file: 404 {"error": {code, message, request_id}}; empty parts: 400 empty_parts."""
    unknown = client.post(f"{API}/{uuid.uuid4()}/complete", json={"uploadId": "u", "parts": [{"partNumber": 1,
                                                                                              "etag": "e"}]})
    error = unknown.json()["error"]
    assert unknown.status_code == 404 and error["code"] == "upload_not_found" and error["request_id"]
    empty = client.post(f"{API}/{uuid.uuid4()}/complete", json={"uploadId": "u", "parts": []})
    assert empty.status_code == 400 and empty.json()["error"]["code"] == "empty_parts"


def test_discard_removes_a_failed_upload_so_retry_can_initiate_again(client: TestClient, db_session: Session,  # noqa: F811
                                                                     fake_storage: FakeStorage) -> None:  # noqa: F811
    """The row goes and its multipart upload is aborted; initiate again in the same batch works."""
    batch_id = new_batch(client)
    body = initiate(client, batch_id).json()
    assert client.post(f"{API}/{body['fileId']}/discard", json={"uploadId": body["uploadId"]}).json() == {"ok": True}
    assert file_row(db_session, body["fileId"]) is None
    assert initiate(client, batch_id).status_code == 200


# ── commit with replace ─────────────────────────────────────────────────────

def replace_file(db: Session, target: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    """A processed file in its own batch that replaces target."""
    batch_id, file_id = new_file(db)
    db.execute(text("UPDATE upload_file SET intent = 'replace', replaces_document_id = :t WHERE file_id = :f"),
               {"t": target, "f": file_id})
    db.commit()
    return batch_id, file_id


def test_a_replace_moves_the_document_to_version_2(db_session: Session, fake_storage: FakeStorage) -> None:  # noqa: F811
    """Same id and title, the new name/hash/key; copied to v2_; the v1 object deleted after the commit."""
    target = library_doc(db_session, "Whipple.docx", 42, HASH_A)
    old_key = documents.document_key(POC_ORG, target, "Whipple.docx")
    batch_id, file_id = replace_file(db_session, target)
    add_candidate(db_session, file_id, "whipple v2.docx", HASH_B)
    result = uploads.commit(db_session, batch_id)

    assert (result.added, result.skipped) == ([], [])
    assert result.replaced == [{"document_id": target, "version": 2, "previous_version": 1}]
    (doc,) = library(db_session)
    new_key = documents.document_key(POC_ORG, target, "whipple v2.docx", 2)
    assert (doc["document_id"], doc["title"], doc["current_version"], doc["file_name"], doc["content_hash"],
            doc["s3_key"], doc["source_file_id"]) == (target, "Whipple", 2, "whipple v2.docx", HASH_B, new_key, file_id)
    assert fake_storage.copies == [(f"ClinSync/staging/x/{file_id}/whipple v2.docx", new_key)]
    assert old_key in fake_storage.deleted


def test_a_replace_with_the_same_content_is_skipped(db_session: Session, fake_storage: FakeStorage) -> None:  # noqa: F811
    """Identical bytes: nothing changes; the candidate is skipped with its reason."""
    target = library_doc(db_session, "Same.docx", 1, HASH_A)
    batch_id, file_id = replace_file(db_session, target)
    add_candidate(db_session, file_id, "Same.docx", HASH_A)
    result = uploads.commit(db_session, batch_id)
    assert [s["reason"] for s in result.skipped] == [IDENTICAL_TO_CURRENT] and result.replaced == []
    assert library(db_session)[0]["current_version"] == 1


def test_a_replace_matching_another_document_or_a_gone_target_is_skipped(db_session: Session,  # noqa: F811
                                                                         fake_storage: FakeStorage) -> None:  # noqa: F811
    """Content of a different library document: Already in the library. Target gone: its own reason."""
    target = library_doc(db_session, "Target.docx", 1, HASH_A)
    library_doc(db_session, "Other.docx", 1, HASH_C)
    batch_id, file_id = replace_file(db_session, target)
    add_candidate(db_session, file_id, "Target.docx", HASH_C)
    assert [s["reason"] for s in uploads.commit(db_session, batch_id).skipped] == [ALREADY_IN_LIBRARY]


    class Gone:                                   # the FK keeps a real row pointing at a live document
        replaces_document_id = uuid.uuid4()

    assert uploads._replace(db_session, POC_ORG, Gone(), [], []) == REPLACE_TARGET_GONE


def test_the_commit_route_lists_what_was_replaced(client: TestClient, db_session: Session,  # noqa: F811
                                                  fake_storage: FakeStorage) -> None:  # noqa: F811
    """POST /api/v1/uploads/batches/{id}/commit answers replaced: [{document_id, version, previous_version}]."""
    target = library_doc(db_session, "Route.docx", 1, HASH_A)
    batch_id, file_id = replace_file(db_session, target)
    add_candidate(db_session, file_id, "Route.docx", HASH_B)
    body = client.post(f"/api/v1/uploads/batches/{batch_id}/commit").json()
    assert body["replaced"] == [{"document_id": str(target), "version": 2, "previous_version": 1}]


def test_complete_refuses_a_size_mismatch_and_removes_the_object(client: TestClient, db_session: Session,  # noqa: F811
                                                                   fake_storage: FakeStorage) -> None:  # noqa: F811
    """The object is not the size declared at initiate: 400 size_mismatch, the row ends error, the object goes."""
    body = initiate(client, new_batch(client), "Short.pdf", 43008).json()
    parts = [{"partNumber": 1, "etag": fake_storage.put_part(body["uploadId"], 1)}]
    row = file_row(db_session, body["fileId"])
    assert row is not None
    fake_storage.sizes[row["s3_key"]] = 41000
    response = client.post(f"{API}/{body['fileId']}/complete", json={"uploadId": body["uploadId"], "parts": parts})
    error = response.json()["error"]
    assert (response.status_code, error["code"], error["message"]) == (400, "size_mismatch",
                                                                       "Uploaded 41000 bytes, expected 43008")
    after = file_row(db_session, body["fileId"])
    assert after is not None and after["status"] == "error" and row["s3_key"] in fake_storage.deleted


def test_initiate_states_the_size_limit_in_gb(client: TestClient) -> None:  # noqa: F811
    """Over MAX_UPLOAD_BYTES: 413 with the limit in GB, as the Add Content screen shows it."""
    response = initiate(client, new_batch(client), "Huge.pdf", 6 * 1024 * MIB)
    assert (response.status_code, response.json()["detail"]) == (413, "File exceeds the 5 GB limit for cloud uploads.")
