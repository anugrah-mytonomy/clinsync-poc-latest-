"""In-memory replay of transcript Write/StrReplace; write final file states."""
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TRANSCRIPT = Path(
    r"C:\Users\anugr\.cursor\projects\c-Users-anugr-POC-Worker-Celery\agent-transcripts"
    r"\de45d4cb-cffe-4e01-9318-1aafe1a9bb43\de45d4cb-cffe-4e01-9318-1aafe1a9bb43.jsonl"
)

TARGETS = {
    "frontend/src/pages/content-library/ContentLibraryPage.tsx",
    "frontend/src/utils/uploadConfig.ts",
    "frontend/src/utils/uploadsApi.ts",
    "frontend/src/utils/contentValidation.ts",
    "frontend/src/utils/duplicateCheck.ts",
    "frontend/src/utils/reviewApi.ts",
    "frontend/src/pages/content-library/__tests__/ContentLibraryPage.test.tsx",
    "docker-compose.override.yml",
    "backend/tests/api/test_replace_and_batch.py",
}


def norm_path(p: str) -> str | None:
    p = p.replace("\\", "/")
    marker = "POC-Worker-Celery/"
    if marker not in p:
        return None
    return p.split(marker, 1)[1]


def main() -> int:
    if not TRANSCRIPT.is_file():
        print("Missing transcript", file=sys.stderr)
        return 1

    vfs: dict[str, str] = {}
    errors: list[str] = []
    writes = replaces = 0

    for line in TRANSCRIPT.open(encoding="utf-8"):
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        if o.get("role") != "assistant":
            continue
        for part in o.get("message", {}).get("content", []):
            if part.get("type") != "tool_use":
                continue
            name = part.get("name")
            inp = part.get("input", {})
            rel = norm_path(inp.get("path", ""))
            if not rel or rel not in TARGETS:
                continue
            if name == "Write":
                vfs[rel] = inp.get("contents", "")
                writes += 1
            elif name == "StrReplace":
                old, new = inp.get("old_string"), inp.get("new_string")
                if old is None or new is None:
                    continue
                cur = vfs.get(rel)
                if cur is None:
                    disk = REPO / rel.replace("/", os.sep)
                    if disk.is_file():
                        cur = disk.read_text(encoding="utf-8")
                    else:
                        errors.append(f"no base for {rel}")
                        continue
                if old not in cur:
                    errors.append(f"old_string not in {rel}")
                    continue
                if inp.get("replace_all"):
                    cur = cur.replace(old, new)
                else:
                    cur = cur.replace(old, new, 1)
                vfs[rel] = cur
                replaces += 1

    print(f"Write: {writes}, StrReplace on targets: {replaces}, vfs keys: {list(vfs)}")
    for e in errors:
        print("ERR", e)

    for rel, content in vfs.items():
        out = REPO / rel.replace("/", os.sep)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(content, encoding="utf-8", newline="\n")
        print("WROTE", rel, len(content))

    missing = TARGETS - set(vfs.keys())
    if missing:
        print("NOT IN VFS (no successful ops):", sorted(missing))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
