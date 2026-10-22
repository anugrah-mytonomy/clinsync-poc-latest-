import json
from pathlib import Path

p = Path(r"C:\Users\anugr\.cursor\projects\c-Users-anugr-POC-Worker-Celery\agent-transcripts\50895855-6ae3-4f5f-a5dd-e119258b8ee2\50895855-6ae3-4f5f-a5dd-e119258b8ee2.jsonl")
ops = []
for i, line in enumerate(p.open(encoding="utf-8"), 1):
    o = json.loads(line)
    for part in o.get("message", {}).get("content", []):
        if part.get("type") != "tool_use":
            continue
        path = part.get("input", {}).get("path", "")
        if "ContentLibraryPage.tsx" not in path.replace("\\", "/"):
            continue
        if part.get("name") == "StrReplace":
            ops.append({"line": i, "input": part["input"]})
Path(r"c:\Users\anugr\POC-Worker-Celery\scripts\ContentLibraryPage_ops508.json").write_text(
    json.dumps(ops, indent=2), encoding="utf-8"
)
print(len(ops))
