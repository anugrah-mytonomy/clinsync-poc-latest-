"""Replay transcript edits for one file (in order)."""
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
    return REPO / p.split(marker, 1)[1].replace("/", os.sep)


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: recover_file_from_transcript.py <relative-path>", file=sys.stderr)
        return 1
    target = (REPO / sys.argv[1]).resolve()
    ok = fail = 0
    for line in TRANSCRIPT.open(encoding="utf-8"):
        o = json.loads(line)
        if o.get("role") != "assistant":
            continue
        for part in o.get("message", {}).get("content", []):
            if part.get("type") != "tool_use":
                continue
            inp = part.get("input", {})
            path = norm_path(inp.get("path", ""))
            if path != target:
                continue
            if part["name"] == "Write":
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(inp.get("contents", ""), encoding="utf-8", newline="\n")
                ok += 1
            elif part["name"] == "StrReplace":
                old, new = inp.get("old_string"), inp.get("new_string")
                if not path.exists() or old not in path.read_text(encoding="utf-8"):
                    fail += 1
                    continue
                text = path.read_text(encoding="utf-8")
                text = text.replace(old, new) if inp.get("replace_all") else text.replace(old, new, 1)
                path.write_text(text, encoding="utf-8", newline="\n")
                ok += 1
    print(f"{target.relative_to(REPO)}: applied {ok}, skipped {fail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
