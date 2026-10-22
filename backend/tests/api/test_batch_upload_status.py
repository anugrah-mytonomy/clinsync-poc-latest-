"""ClinSync upload flow: per-file complete with failed S3 + GET batch status."""
import uuid

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.api.test_upload_api import batch_files, initiate


def complete_by_id(
    client: TestClient,
    file_id: str,
    upload_id: str,
    *,
    status: str,
    attempt: int = 1,
    parts: list[dict[str, str | int]] | None = None,
    error_message: str | None = None,
) -> dict:
    """POST /api/uploads/{fileId}/complete with ClinSync body."""
    body: dict = {"uploadId": upload_id, "attempt": attempt, "status": status}
    if status == "success":
        body["parts"] = parts or [{"partNumber": 1, "etag": "etag-1"}]
    else:
        body["errorMessage"] = error_message or "S3 upload failed"
    response = client.post(f"/api/uploads/{file_id}/complete", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_batch_status_when_all_s3_fail(client: TestClient, db_session: Session) -> None:
    """Case 3: every Complete reports failed → batchStatus failed."""
    batch_id = uuid.uuid4()
    bodies = [
        initiate(client, f"miss-{i}.docx", batchId=str(batch_id)).json()
        for i in range(3)
    ]
    for body in bodies:
        complete_by_id(client, body["fileId"], body["uploadId"], status="failed", error_message="network error")

    response = client.get(f"/api/uploads/batches/{batch_id}/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["batchStatus"] == "failed"
    assert payload["inProgress"] == 0
    assert len(payload["files"]) == 3
    assert all(f["status"] == "error" for f in payload["files"])
    assert all(f["errorCode"] == "s3_upload_failed" for f in payload["files"])


def test_batch_status_partial_after_one_success_one_fail(
    client: TestClient, db_session: Session, fake_storage,
) -> None:
    """Case 2: mixed S3 outcomes → partially_successful once ingest finishes (here: uploaded vs error)."""
    batch_id = uuid.uuid4()
    good = initiate(client, "good.docx", batchId=str(batch_id)).json()
    bad = initiate(client, "bad.docx", batchId=str(batch_id)).json()

    etag = fake_storage.put_part(good["uploadId"], 1)
    complete_by_id(
        client,
        good["fileId"],
        good["uploadId"],
        status="success",
        parts=[{"partNumber": 1, "etag": etag}],
    )
    complete_by_id(client, bad["fileId"], bad["uploadId"], status="failed")

    response = client.get(f"/api/uploads/batches/{batch_id}/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["batchStatus"] in ("in_progress", "partially_successful", "successful")
    by_name = {f["fileName"]: f for f in payload["files"]}
    assert by_name["bad.docx"]["status"] == "error"
    assert by_name["good.docx"]["status"] in ("uploaded", "processing", "processed", "partial")
    assert len(batch_files(db_session, str(batch_id))) == 2
