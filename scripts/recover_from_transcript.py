"""Replay Write/StrReplace from agent transcript onto the repo (recovery after git clean)."""
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TRANSCRIPT = Path(
    r"C:\Users\anugr\.cursor\projects\c-Users-anugr-POC-Worker-Celery\agent-transcripts"
    r"\de45d4cb-cffe-4e01-9318-1aafe1a9bb43\de45d4cb-cffe-4e01-9318-1aafe1a9bb43.jsonl"
)


def norm_path(p: str) -> Path | None:
    p = p.replace("\\", "/")
    marker = "POC-Worker-Celery/"
    if marker not in p:
        return None
    rel = p.split(marker, 1)[1]
    return REPO / rel.replace("/", os.sep)


def main() -> int:
    if not TRANSCRIPT.is_file():
        print("Transcript not found:", TRANSCRIPT, file=sys.stderr)
        return 1
    touched: set[Path] = set()
    writes = replaces = 0
    errors: list[str] = []

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
            path = norm_path(inp.get("path", ""))
            if not path:
                continue
            if name == "Write":
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(inp.get("contents", ""), encoding="utf-8", newline="\n")
                touched.add(path)
                writes += 1
            elif name == "StrReplace":
                old, new = inp.get("old_string"), inp.get("new_string")
                if old is None or new is None:
                    continue
                if not path.exists():
                    errors.append(f"missing for replace: {path.relative_to(REPO)}")
                    continue
                text = path.read_text(encoding="utf-8")
                if old not in text:
                    errors.append(f"old_string not found: {path.relative_to(REPO)}")
                    continue
                if inp.get("replace_all"):
                    text = text.replace(old, new)
                else:
                    text = text.replace(old, new, 1)
                path.write_text(text, encoding="utf-8", newline="\n")
                touched.add(path)
                replaces += 1

    print(f"Write: {writes}, StrReplace: {replaces}, files touched: {len(touched)}, errors: {len(errors)}")
    for e in errors[:30]:
        print("ERR", e)
    if len(errors) > 30:
        print(f"... and {len(errors) - 30} more errors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
