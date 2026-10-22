import json
from pathlib import Path

for name in ["50895855-6ae3-4f5f-a5dd-e119258b8ee2", "de45d4cb-cffe-4e01-9318-1aafe1a9bb43"]:
    p = Path(rf"C:\Users\anugr\.cursor\projects\c-Users-anugr-POC-Worker-Celery\agent-transcripts\{name}\{name}.jsonl")
    ops = []
    for i, line in enumerate(p.open(encoding="utf-8"), 1):
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        for part in o.get("message", {}).get("content", []):
            if part.get("type") != "tool_use":
                continue
            path = part.get("input", {}).get("path", "")
            if "ContentLibraryPage.tsx" not in path.replace("\\", "/"):
                continue
            if part.get("name") in ("Write", "StrReplace"):
                ops.append((i, part["name"]))
    print(name, len(ops), "first", ops[:3] if ops else None)
