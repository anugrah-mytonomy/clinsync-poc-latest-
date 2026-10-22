const fs = require('fs');
const jsonlPath = process.argv[2];
const outDir = process.argv[3];
const targetSubstrings = [
  'content-library/contentlibrarypage.tsx',
  'utils/uploadconfig.ts',
  'utils/uploadsapi.ts',
  'utils/contentvalidation.ts',
  'utils/duplicatecheck.ts',
  'utils/reviewapi.ts',
  'contentlibrarypage.test.tsx',
  'docker-compose.override.yml',
  'test_replace_and_batch.py',
];

function norm(p) {
  return p.replace(/\\/g, '/').toLowerCase();
}

function matches(p) {
  const n = norm(p);
  return targetSubstrings.some((t) => n.includes(t.replace(/-/g, '')));
}

const fileContents = new Map(); // norm path -> {path, content}
const strReplaceOps = new Map(); // norm path -> array

for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  for (const block of obj.message?.content || []) {
    if (block.type !== 'tool_use') continue;
    const inp = block.input || {};
    const p = inp.path;
    if (!p || !matches(p)) continue;
    const key = norm(p);
    if (block.name === 'Write' && inp.contents != null) {
      fileContents.set(key, { path: p, content: inp.contents });
    }
    if (block.name === 'StrReplace') {
      const arr = strReplaceOps.get(key) || [];
      arr.push({ old_string: inp.old_string, new_string: inp.new_string });
      strReplaceOps.set(key, arr);
    }
    if (block.name === 'Read' && inp.path && matches(inp.path)) {
      // Read results aren't in JSONL typically - skip
    }
  }
}

// Apply str replaces on last known content or skip if no base
function applyReplaces(base, ops) {
  let cur = base;
  for (const op of ops) {
    if (cur == null) break;
    if (!cur.includes(op.old_string)) {
      console.warn('MISSING old_string in', ops.length, 'ops');
      continue;
    }
    cur = cur.replace(op.old_string, op.new_string);
  }
  return cur;
}

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

for (const [key, { path, content }] of fileContents) {
  const baseName = path.split(/[/\\]/).pop();
  const outPath = `${outDir}/${baseName}.extracted`;
  fs.writeFileSync(outPath, content, 'utf8');
  console.log('WRITE extracted', path, content.length);
}

// ContentLibraryPage - try git-less: read current from repo as base? No - use first Read won't work
// Export str replace count
for (const [key, ops] of strReplaceOps) {
  console.log('StrReplace', key, ops.length);
}

// Try reconstruct ContentLibraryPage if we have a write - we don't
// Dump all StrReplace for contentlibrarypage to separate file for manual merge
const clKey = [...strReplaceOps.keys()].find((k) => k.includes('contentlibrarypage.tsx') && !k.includes('test'));
if (clKey) {
  fs.writeFileSync(`${outDir}/ContentLibraryPage.strreplaces.json`, JSON.stringify(strReplaceOps.get(clKey), null, 2));
}

console.log('Done');
