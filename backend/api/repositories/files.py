"""upload_file repository: claim and the fenced writes that follow it (design.md §6.2)."""
import uuid
from dataclasses import dataclass
from pathlib import PurePosixPath

from sqlalchemy import text
from sqlalchemy.orm import Session

from shared.errors import ClaimSuperseded, InvalidInput
from shared.logging import get_logger

log = get_logger(__name__)

TERMINAL_STATUSES = frozenset({"processed", "partial", "rejected", "error"})
STATUS_MESSAGE_MAX = 512                 # upload_file.status_message is VARCHAR(512)

# Every write after claim is fenced on both the token and the status (R4.4).
_FENCE = "WHERE file_id = :file_id AND claim_token = :token AND status = 'processing'"
_PROGRESS_FIELDS = ("entries_total", "entries_done", "detected_type")

# design.md §6.2 — atomic, one statement (R3.2, R3.3, R3.5).
_CLAIM_SQL = text("""
UPDATE upload_file
SET status = 'processing',
    attempt_count = attempt_count + 1,
    heartbeat_at  = now(),
    claim_token   = gen_random_uuid(),
    updated_at    = now()
WHERE file_id = :file_id
  AND attempt_count < :max_attempts
  AND ( status = 'uploaded'
        OR (status = 'processing' AND heartbeat_at < now() - make_interval(secs => :stale)) )
RETURNING file_id, organization_id, batch_id, s3_key, file_name, file_ext,
          is_archive, entries_done, attempt_count, claim_token;
""")


@dataclass(frozen=True)
class FileClaim:
    """A successful claim: the file's identity plus the token every later write must carry."""

    file_id: uuid.UUID
    organization_id: uuid.UUID
    batch_id: uuid.UUID
    s3_key: str
    file_name: str
    file_ext: str
    is_archive: bool
    entries_done: int
    attempt_count: int
    claim_token: uuid.UUID


def claim(session: Session, file_id: uuid.UUID, *, max_attempts: int, stale_after_seconds: int) -> FileClaim | None:
    """Claim the file for one worker and commit; return None if it is not claimable.

    Must be the first statement in its session's transaction: now() is fixed at transaction
    start, so an older transaction would stamp an already-aged heartbeat_at and judge staleness
    against a past instant.
    """
    row = session.execute(
        _CLAIM_SQL, {"file_id": file_id, "max_attempts": max_attempts, "stale": stale_after_seconds}
    ).mappings().one_or_none()
    session.commit()
    return FileClaim(**row) if row is not None else None


def _fenced_update(session: Session, file_id: uuid.UUID, token: uuid.UUID, set_clause: str,
                   params: dict[str, object], returning: str = "file_id") -> dict[str, object]:
    """Run one fenced UPDATE; roll back and raise ClaimSuperseded if it matched no row."""
    row = session.execute(
        text(f"UPDATE upload_file SET {set_clause} {_FENCE} RETURNING {returning}"),
        {**params, "file_id": file_id, "token": token},
    ).mappings().one_or_none()
    if row is None:
        session.rollback()
        raise ClaimSuperseded(file_id)
    return dict(row)


def heartbeat(session: Session, file_id: uuid.UUID, token: uuid.UUID) -> None:
    """Refresh the heartbeat of a file this token owns."""
    _fenced_update(session, file_id, token, "heartbeat_at = now(), updated_at = now()", {})
    session.commit()


def progress(session: Session, file_id: uuid.UUID, token: uuid.UUID, *, entries_total: int | None = None,
             entries_done: int | None = None, detected_type: str | None = None) -> None:
    """Set only the progress fields passed (None means not passed), and refresh the heartbeat."""
    values = {"entries_total": entries_total, "entries_done": entries_done, "detected_type": detected_type}
    passed = {name: values[name] for name in _PROGRESS_FIELDS if values[name] is not None}
    if not passed:
        raise InvalidInput("progress() needs at least one of entries_total, entries_done, detected_type")
    assignments = "".join(f"{name} = :{name}, " for name in passed)   # names from the fixed allow-list
    _fenced_update(session, file_id, token, f"{assignments}heartbeat_at = now(), updated_at = now()", passed)
    session.commit()


def truncate_message(message: str | None) -> str | None:
    """Fit a status message into VARCHAR(512), ending with "…" when cut."""
    if message is None or len(message) <= STATUS_MESSAGE_MAX:
        return message
    return message[: STATUS_MESSAGE_MAX - 1] + "…"


def finish(session: Session, file_id: uuid.UUID, token: uuid.UUID, status: str,
           status_message: str | None = None) -> str:
    """Set a terminal status and message, clear the claim token (R10.3); return the status actually stored.

    For `processed` / `partial` the candidate rows decide (rev 1.3): `processed` becomes `partial` if any candidate
    is rejected (never the reverse), and an archive must have exactly `entries_total` candidates, or InvalidInput.
    Rejecting an archive also rejects its `processed` candidates (§8.5a); `error` leaves candidates unchanged.
    """
    if status not in TERMINAL_STATUSES:
        raise InvalidInput(f"finish() needs a terminal status, got {status!r}")
    row = _fenced_update(
        session, file_id, token,
        "status = :status, status_message = :status_message, claim_token = NULL, updated_at = now()",
        {"status": status, "status_message": truncate_message(status_message)},
        returning="file_id, is_archive, entries_total",
    )
    # The fenced UPDATE holds the row lock until the single commit below: a takeover or a late upsert from the old
    # owner waits for it, then sees the file rejected and its token cleared.
    if status == "rejected" and row["is_archive"]:                        # design.md §8.5a step 2
        session.execute(text("""
            UPDATE staged_document
            SET status = 'rejected', reject_reason = :reason, s3_key = NULL, updated_at = now()
            WHERE source_file_id = :id AND status = 'processed'"""),
            {"id": file_id, "reason": truncate_message(f"Archive rejected: {status_message}" if status_message
                                                       else "Archive rejected")})
    if status in ("processed", "partial"):
        counts = session.execute(text("""
            SELECT count(*) AS total, count(*) FILTER (WHERE status = 'rejected') AS rejected
            FROM staged_document WHERE source_file_id = :id"""), {"id": file_id}).one()
        if row["is_archive"] and counts.total != row["entries_total"]:
            session.rollback()
            raise InvalidInput(f"archive has {counts.total} candidates but entries_total is "
                               f"{row['entries_total']}; every entry needs a candidate before finish")
        if status == "processed" and counts.rejected:                 # R7.6 — decided from the candidate rows
            session.execute(text("UPDATE upload_file SET status = 'partial' WHERE file_id = :id"), {"id": file_id})
            status = "partial"
    session.commit()
    return status


def release(session: Session, file_id: uuid.UUID, token: uuid.UUID, reason: str) -> None:
    """Hand the file back to `uploaded` before a retry; reset uploaded_at so reconcile waits (rev 1.2)."""
    row = _fenced_update(
        session, file_id, token,
        "status = 'uploaded', claim_token = NULL, uploaded_at = now(), updated_at = now()",
        {}, returning="file_id, attempt_count",
    )
    session.commit()
    log.info("released", file_id=str(file_id), attempt=row["attempt_count"], reason=reason)


@dataclass(frozen=True)
class SeededFile:
    """A file row created by seed_batch."""

    file_id: uuid.UUID
    file_name: str
    is_archive: bool
    status: str


def file_ext_of(file_name: str) -> str:
    """Lower-case extension without the dot ('' when there is none)."""
    return PurePosixPath(file_name).suffix.lower().lstrip(".")


def check_seed_files(files: list[tuple[str, str]], allowed_ext: list[str]) -> None:
    """Raise InvalidInput unless every (file_name, s3_key) has an allowed extension and a key under incoming/."""
    if not files:
        raise InvalidInput("files must not be empty")
    for file_name, s3_key in files:
        if file_ext_of(file_name) not in allowed_ext:
            raise InvalidInput(f"{file_name!r}: extension not allowed (allowed: {', '.join(allowed_ext)})")
        if not s3_key.startswith("clynsync/incoming/"):
            raise InvalidInput(f"{s3_key!r}: s3_key must be under clynsync/incoming/")


def seed_batch(session: Session, organization_id: uuid.UUID, created_by: int, files: list[tuple[str, str, int]],
               allowed_ext: list[str]) -> tuple[uuid.UUID, list[SeededFile]]:
    """POC only: create a batch and `staged` file rows for (file_name, s3_key, size_bytes) of objects in incoming/."""
    check_seed_files([(file_name, s3_key) for file_name, s3_key, _ in files], allowed_ext)
    batch_id = session.execute(
        text("INSERT INTO upload_batch (organization_id, created_by) VALUES (:org, :by) RETURNING batch_id"),
        {"org": organization_id, "by": created_by},
    ).scalar_one()
    seeded = []
    for file_name, s3_key, size_bytes in files:
        ext = file_ext_of(file_name)
        row = session.execute(text("""
            INSERT INTO upload_file (batch_id, organization_id, file_name, file_ext, size_bytes, is_archive, s3_key)
            VALUES (:batch_id, :org, :file_name, :ext, :size_bytes, :is_archive, :s3_key)
            RETURNING file_id, file_name, is_archive, status"""),
            {"batch_id": batch_id, "org": organization_id, "file_name": file_name, "ext": ext,
             "size_bytes": size_bytes, "is_archive": ext == "zip", "s3_key": s3_key}).mappings().one()
        seeded.append(SeededFile(**row))
    session.commit()
    return batch_id, seeded


def file_exists(session: Session, file_id: uuid.UUID) -> tuple[uuid.UUID, str] | None:
    """Return (organization_id, status) of the file, or None if it does not exist."""
    row = session.execute(text("SELECT organization_id, status FROM upload_file WHERE file_id = :id"),
                          {"id": file_id}).one_or_none()
    session.rollback()                   # read-only; end the transaction
    return (row.organization_id, row.status) if row else None


_CONFIRM_SQL = text("""
UPDATE upload_file
SET status = 'uploaded', uploaded_at = now(), updated_at = now()
WHERE file_id = :file_id AND status IN ('staged', 'uploading')
RETURNING organization_id
""")


@dataclass(frozen=True)
class ConfirmResult:
    """Outcome of confirm_upload: the status now, and whether this call made the transition."""

    status: str
    organization_id: uuid.UUID
    transitioned: bool


def ingest_enqueue_countdown_seconds(session: Session, file_id: uuid.UUID) -> int:
    """Celery countdown so batch files enter `processing` one after another (local/demo)."""
    from shared.config import get_settings

    stagger = get_settings().INGEST_STAGGER_SECONDS
    if stagger <= 0:
        return 0
    ord_row = session.execute(
        text("""
        WITH ranked AS (
            SELECT file_id,
                   row_number() OVER (ORDER BY created_at, file_name, file_id) - 1 AS ord
            FROM upload_file
            WHERE batch_id = (SELECT batch_id FROM upload_file WHERE file_id = :f)
        )
        SELECT ord FROM ranked WHERE file_id = :f
        """),
        {"f": file_id},
    ).scalar_one_or_none()
    session.rollback()
    if ord_row is None:
        return 0
    return int(ord_row * stagger)


def ingest_enqueue_countdown_seconds(session: Session, file_id: uuid.UUID) -> int:
    """Celery countdown so batch files enter `processing` one after another (local/demo)."""
    from shared.config import get_settings

    stagger = get_settings().INGEST_STAGGER_SECONDS
    if stagger <= 0:
        return 0
    ord_row = session.execute(
        text("""
        WITH ranked AS (
            SELECT file_id,
                   row_number() OVER (ORDER BY created_at, file_name, file_id) - 1 AS ord
            FROM upload_file
            WHERE batch_id = (SELECT batch_id FROM upload_file WHERE file_id = :f)
        )
        SELECT ord FROM ranked WHERE file_id = :f
        """),
        {"f": file_id},
    ).scalar_one_or_none()
    session.rollback()
    if ord_row is None:
        return 0
    return int(ord_row * stagger)


def ingest_enqueue_countdown_seconds(session: Session, file_id: uuid.UUID) -> int:
    """Celery countdown so batch files enter `processing` one after another (local/demo)."""
    from shared.config import get_settings

    stagger = get_settings().INGEST_STAGGER_SECONDS
    if stagger <= 0:
        return 0
    ord_row = session.execute(
        text("""
        WITH ranked AS (
            SELECT file_id,
                   row_number() OVER (ORDER BY created_at, file_name, file_id) - 1 AS ord
            FROM upload_file
            WHERE batch_id = (SELECT batch_id FROM upload_file WHERE file_id = :f)
        )
        SELECT ord FROM ranked WHERE file_id = :f
        """),
        {"f": file_id},
    ).scalar_one_or_none()
    session.rollback()
    if ord_row is None:
        return 0
    return int(ord_row * stagger)


def confirm_upload(session: Session, file_id: uuid.UUID) -> ConfirmResult | None:
    """Move staged|uploading → uploaded in one conditional UPDATE and commit; None if the file does not exist.

    R2.1 and R2.5; `staged` is the LLD's starting status (upload-ingest-merge U3.2).
    """
    row = session.execute(_CONFIRM_SQL, {"file_id": file_id}).one_or_none()
    if row is not None:
        session.commit()
        return ConfirmResult("uploaded", row.organization_id, transitioned=True)
    # Already past uploading (or unknown): read the current status for the response only; nothing is written.
    current = session.execute(text("SELECT status, organization_id FROM upload_file WHERE file_id = :id"),
                              {"id": file_id}).one_or_none()
    session.rollback()
    return ConfirmResult(current.status, current.organization_id, transitioned=False) if current else None


def batch_exists(session: Session, batch_id: uuid.UUID) -> bool:
    """True if the batch exists."""
    return session.execute(text("SELECT 1 FROM upload_batch WHERE batch_id = :b"), {"b": batch_id}).first() is not None


def list_batch_files(session: Session, batch_id: uuid.UUID) -> list[dict[str, object]] | None:
    """Every file of the batch with its status fields (R14.1), oldest first then by name; None if no such batch."""
    if not batch_exists(session, batch_id):
        return None
    rows = session.execute(text("""
        SELECT file_id, client_ref, file_name, status, entries_total, entries_done, attempt_count, detected_type,
               status_message, is_archive
        FROM upload_file WHERE batch_id = :b ORDER BY created_at, file_name, file_id"""), {"b": batch_id}).mappings()
    return [dict(r) for r in rows]


# ── Anugrah's Upload API (upload-ingest-merge U1–U4) ────────────────────────

_ENSURE_BATCH_SQL = text("""
INSERT INTO upload_batch (batch_id, organization_id, created_by)
VALUES (:batch_id, :org, :created_by)
ON CONFLICT (batch_id) DO NOTHING
""")


def create_batch(session: Session, organization_id: uuid.UUID, created_by: int) -> uuid.UUID:
    """Create an empty upload batch for one Upload click; commit and return its id."""
    batch_id = session.execute(
        text("INSERT INTO upload_batch (organization_id, created_by) VALUES (:org, :by) RETURNING batch_id"),
        {"org": organization_id, "by": created_by},
    ).scalar_one()
    session.commit()
    return batch_id


def create_batch(session: Session, organization_id: uuid.UUID, created_by: int) -> uuid.UUID:
    """Create an empty upload batch for one Upload click; commit and return its id."""
    batch_id = session.execute(
        text("INSERT INTO upload_batch (organization_id, created_by) VALUES (:org, :by) RETURNING batch_id"),
        {"org": organization_id, "by": created_by},
    ).scalar_one()
    session.commit()
    return batch_id


def ensure_batch(session: Session, batch_id: uuid.UUID, organization_id: uuid.UUID, created_by: int) -> str:
    """Create the batch on first sight, or find it; commit; return its status (D4).

    Parallel callers with one new batch_id all land in the one row: the second INSERT waits for the first to
    commit, then does nothing.
    """
    session.execute(_ENSURE_BATCH_SQL, {"batch_id": batch_id, "org": organization_id, "created_by": created_by})
    status = session.execute(text("SELECT status FROM upload_batch WHERE batch_id = :b"),
                             {"b": batch_id}).scalar_one()
    session.commit()
    return str(status)


def create_upload(session: Session, *, file_id: uuid.UUID, batch_id: uuid.UUID, organization_id: uuid.UUID,
                  file_name: str, size_bytes: int, content_type: str | None, s3_key: str, upload_id: str,
                  replaces_document_id: uuid.UUID | None = None) -> None:
    """Insert a `staged` upload_file row for a multipart upload just started (U1.3); a replace records its target
    (design.md §5.2a). The caller commits."""
    ext = file_ext_of(file_name)
    session.execute(text("""
        INSERT INTO upload_file (file_id, batch_id, organization_id, file_name, file_ext, size_bytes, content_type,
                                 s3_key, upload_id, is_archive, intent, replaces_document_id)
        VALUES (:file_id, :batch_id, :org, :file_name, :ext, :size_bytes, :content_type, :s3_key, :upload_id,
                :is_archive, :intent, :replaces)"""),
        {"file_id": file_id, "batch_id": batch_id, "org": organization_id, "file_name": file_name, "ext": ext,
         "size_bytes": size_bytes, "content_type": content_type, "s3_key": s3_key, "upload_id": upload_id,
         "is_archive": ext == "zip", "intent": "replace" if replaces_document_id else "new",
         "replaces": replaces_document_id})


def declared_size(session: Session, file_id: uuid.UUID) -> int | None:
    """The size the client declared at initiate, or None if there is no such file."""
    size = session.execute(text("SELECT size_bytes FROM upload_file WHERE file_id = :id"), {"id": file_id}).scalar()
    return None if size is None else int(size)


def batch_status(session: Session, batch_id: uuid.UUID) -> str | None:
    """The batch's status, or None if there is no such batch."""
    status = session.execute(text("SELECT status FROM upload_batch WHERE batch_id = :b"), {"b": batch_id}).scalar()
    return None if status is None else str(status)


def create_batch(session: Session, organization_id: uuid.UUID, created_by: int) -> uuid.UUID:
    """Insert a new open batch and return its id (design.md §5.2a). Commits."""
    batch_id = session.execute(
        text("INSERT INTO upload_batch (organization_id, created_by) VALUES (:org, :by) RETURNING batch_id"),
        {"org": organization_id, "by": created_by}).scalar_one()
    session.commit()
    return batch_id


def delete_failed_upload(session: Session, file_id: uuid.UUID) -> bool:
    """Delete a staged, uploading or error file that has no candidates, before a Retry re-initiates it (§5.2a).
    True if a row went. The caller commits."""
    deleted = session.execute(text("""
        DELETE FROM upload_file f
        WHERE f.file_id = :id AND f.status IN ('staged', 'uploading', 'error')
          AND NOT EXISTS (SELECT 1 FROM staged_document c WHERE c.source_file_id = f.file_id)
        RETURNING f.file_id"""), {"id": file_id}).first()
    return deleted is not None


@dataclass(frozen=True)
class UploadRow:
    """The upload_file fields the Upload API works with."""

    file_id: uuid.UUID
    batch_id: uuid.UUID
    s3_key: str
    upload_id: str
    status: str


def find_by_upload(session: Session, upload_id: str, s3_key: str, *, lock: bool = False) -> UploadRow | None:
    """The file whose multipart upload id AND key both match, or None (U2.2); FOR UPDATE when lock is set."""
    row = session.execute(text(f"""
        SELECT file_id, batch_id, s3_key, upload_id, status FROM upload_file
        WHERE upload_id = :upload_id AND s3_key = :key {"FOR UPDATE" if lock else ""}"""),
        {"upload_id": upload_id, "key": s3_key}).mappings().one_or_none()
    return UploadRow(**row) if row else None


def find_by_file_and_upload(session: Session, file_id: uuid.UUID, upload_id: str, *,
                            lock: bool = False) -> UploadRow | None:
    """The upload row for this fileId + uploadId pair, or None (U2.2); FOR UPDATE when lock is set."""
    row = session.execute(text(f"""
        SELECT file_id, batch_id, s3_key, upload_id, status FROM upload_file
        WHERE file_id = :file_id AND upload_id = :upload_id {"FOR UPDATE" if lock else ""}"""),
        {"file_id": file_id, "upload_id": upload_id}).mappings().one_or_none()
    return UploadRow(**row) if row else None


def find_by_file_and_upload(session: Session, file_id: uuid.UUID, upload_id: str, *,
                            lock: bool = False) -> UploadRow | None:
    """The upload row for this fileId + uploadId pair, or None (U2.2); FOR UPDATE when lock is set."""
    row = session.execute(text(f"""
        SELECT file_id, batch_id, s3_key, upload_id, status FROM upload_file
        WHERE file_id = :file_id AND upload_id = :upload_id {"FOR UPDATE" if lock else ""}"""),
        {"file_id": file_id, "upload_id": upload_id}).mappings().one_or_none()
    return UploadRow(**row) if row else None


def mark_uploading(session: Session, file_id: uuid.UUID) -> None:
    """staged → uploading on the first presign (U1.3); any other status is left alone. Commits."""
    session.execute(text("UPDATE upload_file SET status = 'uploading', updated_at = now() "
                         "WHERE file_id = :id AND status = 'staged'"), {"id": file_id})
    session.commit()


def cancel_upload(session: Session, file_id: uuid.UUID) -> None:
    """A staged or uploading file ends `error` "Upload cancelled" (U4.1, D10). The caller holds the row lock."""
    session.execute(text("""
        UPDATE upload_file SET status = 'error', status_message = 'Upload cancelled', claim_token = NULL,
                               updated_at = now()
        WHERE file_id = :id AND status IN ('staged', 'uploading')"""), {"id": file_id})


def mark_s3_upload_failed(session: Session, file_id: uuid.UUID, *, message: str, attempt: int) -> None:
    """Record a failed browser→S3 upload; terminal `error`, not queued for ingest."""
    session.execute(text("""
        UPDATE upload_file
        SET status = 'error', status_message = :message, claim_token = NULL,
            attempt_count = greatest(attempt_count, :attempt), updated_at = now()
        WHERE file_id = :id AND status IN ('staged', 'uploading')"""),
        {"id": file_id, "message": truncate_message(message), "attempt": attempt})


def mark_s3_upload_failed(session: Session, file_id: uuid.UUID, *, message: str, attempt: int) -> None:
    """Record a failed browser→S3 upload; terminal `error`, not queued for ingest."""
    session.execute(text("""
        UPDATE upload_file
        SET status = 'error', status_message = :message, claim_token = NULL,
            attempt_count = greatest(attempt_count, :attempt), updated_at = now()
        WHERE file_id = :id AND status IN ('staged', 'uploading')"""),
        {"id": file_id, "message": truncate_message(message), "attempt": attempt})


def list_uploads(session: Session, organization_id: uuid.UUID) -> list[dict[str, object]]:
    """The organization's uploads past `uploading`, newest first, for GET /api/uploads (U4.2)."""
    rows = session.execute(text("""
        SELECT file_id, file_name, size_bytes, content_type, s3_key, status, created_at FROM upload_file
        WHERE organization_id = :org AND status NOT IN ('staged', 'uploading')
        ORDER BY created_at DESC, file_id"""), {"org": organization_id}).mappings()
    return [dict(r) for r in rows]


# ── Commit (upload-ingest-merge U8, design.md §5.4) ─────────────────────────

_UNFINISHED = "status NOT IN ('processed', 'partial', 'rejected', 'error')"


def batch_organization(session: Session, batch_id: uuid.UUID) -> uuid.UUID | None:
    """The batch's organization (a plain read, before any lock), or None if there is no such batch."""
    return session.execute(text("SELECT organization_id FROM upload_batch WHERE batch_id = :b"),
                           {"b": batch_id}).scalar_one_or_none()


def lock_batch(session: Session, batch_id: uuid.UUID) -> None:
    """SELECT … FOR UPDATE on the batch row: one commit of a batch at a time. Take the organization lock first."""
    session.execute(text("SELECT batch_id FROM upload_batch WHERE batch_id = :b FOR UPDATE"), {"b": batch_id})


def unfinished_count(session: Session, batch_id: uuid.UUID) -> int:
    """How many of the batch's files are not yet terminal (staged, uploading, uploaded or processing)."""
    return session.execute(text(f"SELECT count(*) FROM upload_file WHERE batch_id = :b AND {_UNFINISHED}"),
                           {"b": batch_id}).scalar_one()


def mark_batch_committed(session: Session, batch_id: uuid.UUID) -> None:
    """The batch is done: every file finished and every candidate committed or discarded (U8.4)."""
    session.execute(text("UPDATE upload_batch SET status = 'committed' WHERE batch_id = :b"), {"b": batch_id})
