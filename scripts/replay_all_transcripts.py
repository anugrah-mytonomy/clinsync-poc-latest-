"""Replay Write/StrReplace from ordered transcripts into repo (in-memory then flush)."""
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TRANSCRIPT_ROOT = (
    Path(r"C:\Users\anugr\.cursor\projects\c-Users-anugr-POC-Worker-Celery\agent-transcripts")
)
TRANSCRIPTS = [
    TRANSCRIPT_ROOT / "50895855-6ae3-4f5f-a5dd-e119258b8ee2" / "50895855-6ae3-4f5f-a5dd-e119258b8ee2.jsonl",
    TRANSCRIPT_ROOT / "de45d4cb-cffe-4e01-9318-1aafe1a9bb43" / "de45d4cb-cffe-4e01-9318-1aafe1a9bb43.jsonl",
]


def norm_path(p: str) -> Path | None:
    p = p.replace("\\", "/")
    marker = "POC-Worker-Celery/"
    if marker not in p:
        return None
    rel = p.split(marker, 1)[1]
    return REPO / rel.replace("/", os.sep)


def read_text(path: Path) -> str | None:
    if path.is_file():
        return path.read_text(encoding="utf-8")
    return None


def main() -> int:
    vfs: dict[str, str] = {}
    errors: list[str] = []
    writes = replaces = 0

    for transcript in TRANSCRIPTS:
        if not transcript.is_file():
            print("Skip missing", transcript, file=sys.stderr)
            continue
        print("Replay", transcript.name)
        for line in transcript.open(encoding="utf-8"):
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
                path = norm_path(inp.get("path", ""))
                if not path:
                    continue
                key = str(path.relative_to(REPO)).replace("\\", "/")
                if name == "Write":
                    vfs[key] = inp.get("contents", "")
                    writes += 1
                elif name == "StrReplace":
                    old, new = inp.get("old_string"), inp.get("new_string")
                    if old is None or new is None:
                        continue
                    cur = vfs.get(key)
                    if cur is None:
                        cur = read_text(path)
                    if cur is None:
                        errors.append(f"no base: {key}")
                        continue
                    if old not in cur:
                        errors.append(f"old not found: {key}")
                        continue
                    if inp.get("replace_all"):
                        cur = cur.replace(old, new)
                    else:
                        cur = cur.replace(old, new, 1)
                    vfs[key] = cur
                    replaces += 1

    print(f"Write: {writes}, StrReplace ok: {replaces}, vfs: {len(vfs)}, errors: {len(errors)}")
    for e in errors[:40]:
        print("ERR", e)
    if len(errors) > 40:
        print("...", len(errors) - 40, "more")

    for key, content in sorted(vfs.items()):
        out = REPO / key.replace("/", os.sep)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(content, encoding="utf-8", newline="\n")

    targets = [
        "frontend/src/pages/content-library/ContentLibraryPage.tsx",
        "frontend/src/utils/uploadConfig.ts",
        "frontend/src/utils/uploadsApi.ts",
    ]
    for t in targets:
        print("TARGET", t, "in vfs" if t in vfs else "MISSING")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
