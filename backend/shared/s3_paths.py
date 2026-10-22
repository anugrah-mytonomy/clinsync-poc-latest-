"""S3 object keys for upload and ingest (POC layout: clynsync/incoming|processing/{batch}/…)."""
import uuid
from pathlib import PurePosixPath

INCOMING_PREFIX = "clynsync/incoming/"
PROCESSING_PREFIX = "clynsync/processing/"


def _basename(filename: str) -> str:
    """The last path segment of a client filename."""
    return PurePosixPath(filename or "upload.bin").name


def incoming_key(batch_id: uuid.UUID, file_id: uuid.UUID, filename: str) -> str:
    """Multipart upload target; file_id prefixes the name so one batch can hold many uploads safely."""
    name = _basename(filename)
    return f"{INCOMING_PREFIX}{batch_id}/{file_id}_{name}"


def processing_key(batch_id: uuid.UUID, filename: str) -> str:
    """Staged document after ingest (single file or one ZIP member)."""
    return f"{PROCESSING_PREFIX}{batch_id}/{_basename(filename)}"


def disambiguate_basename(basename: str, seen: dict[str, int]) -> str:
    """Return basename, or 'name (1).ext' when the same name was already used in this batch extract."""
    count = seen.get(basename, 0)
    seen[basename] = count + 1
    if count == 0:
        return basename
    path = PurePosixPath(basename)
    suffix = "".join(path.suffixes)
    stem = basename[: len(basename) - len(suffix)] if suffix else basename
    return f"{stem} ({count}){suffix}"


def incoming_key_allowed(s3_key: str) -> bool:
    """True when a seed or POC key is under the incoming prefix."""
    return s3_key.startswith(INCOMING_PREFIX)
