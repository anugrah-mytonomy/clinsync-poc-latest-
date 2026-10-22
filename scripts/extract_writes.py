"""Extract full Write contents for a file from transcript JSONL."""
import json
import sys
from pathlib import Path

TRANSCRIPT = Path(sys.argv[1])
SUB = sys.argv[2].replace("\\", "/").lower()

for line in TRANSCRIPT.open(encoding="utf-8"):
    try:
        o = json.loads(line)
    except json.JSONDecodeError:
        continue
    for part in o.get("message", {}).get("content", []):
        if part.get("type") != "tool_use" or part.get("name") != "Write":
            continue
        p = part.get("input", {}).get("path", "").replace("\\", "/")
        if SUB in p.lower():
            print(part["input"]["contents"])
