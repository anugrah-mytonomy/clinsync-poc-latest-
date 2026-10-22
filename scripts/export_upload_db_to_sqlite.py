"""Export upload + library tables from Postgres to a SQLite file (DB Browser for SQLite)."""
from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

import psycopg

REPO = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get("SQLITE_OUT", str(REPO / "data" / "file_upload_documents.sqlite")))

TABLES = (
    "organizations",
    "documents",
    "upload_batch",
    "upload_file",
    "staged_document",
    "audit_log",
)


def database_url() -> str:
    raw = os.environ.get("DATABASE_URL", "")
    if not raw:
        print("DATABASE_URL is not set", file=sys.stderr)
        sys.exit(1)
    return raw.replace("postgresql+psycopg://", "postgresql://", 1)


def export_table(pg: psycopg.Connection, sqlite: sqlite3.Connection, table: str) -> int:
    """Copy one public table into SQLite; values stored as text for easy browsing."""
    with pg.cursor() as cur:
        cur.execute(f'SELECT * FROM "{table}"')
        rows = cur.fetchall()
        if cur.description is None:
            return 0
        colnames = [d.name for d in cur.description]
    col_defs = ", ".join(f'"{c}" TEXT' for c in colnames)
    sqlite.execute(f'CREATE TABLE "{table}" ({col_defs})')
    placeholders = ", ".join("?" for _ in colnames)
    for row in rows:
        sqlite.execute(
            f'INSERT INTO "{table}" VALUES ({placeholders})',
            tuple(str(v) if v is not None else None for v in row),
        )
    return len(rows)


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.is_file():
        OUT.unlink()
    sqlite = sqlite3.connect(OUT)
    try:
        with psycopg.connect(database_url()) as pg:
            counts: list[tuple[str, int]] = []
            for table in TABLES:
                counts.append((table, export_table(pg, sqlite, table)))
        sqlite.commit()
    finally:
        sqlite.close()
    print(f"Wrote {OUT}")
    for name, n in counts:
        print(f"  {name}: {n} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
