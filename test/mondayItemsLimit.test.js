'use strict';

// Monday's items(ids:) SILENTLY returns only 25 items when no explicit `limit`
// is given, however many ids you pass. Live proof 2026-08-17: the status
// reconciler asked for 50 and got 25, so 20 healthy cases were reported as
// deleted ("dangling") — and, worse, were invisible to the sweep that is the
// activation gate's resume backstop. The same shape truncated document
// checklists (30-60 rows) to their first 25 templates/folders/replies.
//
// RULE: every items(ids: $ids) read of a LIST must pass an explicit limit and
// chunk to <= 100 (Monday's per-query maximum).

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const ROOTS = ['src', 'scripts'];
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|_backup/.test(p)) walk(p); }
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(path.join(__dirname, '..', 'src'));
for (const extra of ['scripts']) {
  const d = path.join(__dirname, '..', extra);
  if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.endsWith('.js')) files.push(path.join(d, f));
}

test('every LIST items(ids:) read passes an explicit limit', () => {
  // A call is a LIST read when the ids VARIABLE it passes is a real collection
  // (chunk / batch / .slice( / .map( / a bare array variable). Single-id reads
  // — `{ id: [String(x)] }`, `{ ids: [id] }` — can never hit the 25 cap.
  const SINGLE = /\{\s*\w+\s*:\s*\[\s*(String\()?[\w.]+\)?\s*\]\s*[,}]/;   // [$one] literal
  const LISTY  = /\{\s*\w+\s*:\s*(\w*(chunk|batch|Ids|ids)\w*|[\w.]+\.(slice|map)\()/i;
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/items\s*\(\s*ids\s*:/.test(line)) return;
      const window = lines.slice(i, i + 6).join('\n');       // query line + its variables
      if (/limit\s*:/.test(window)) return;                  // explicit limit ✓
      if (SINGLE.test(window)) return;                       // single-id read ✓
      if (!LISTY.test(window)) return;                       // not a collection
      offenders.push(`${path.relative(path.join(__dirname, '..'), file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    'these list reads silently truncate at 25 items — add `limit:` (and chunk to <= 100):\n' + offenders.join('\n'));
});

test('the six known batch readers chunk to <= 100 and pass a matching limit', () => {
  const checks = [
    ['src/services/retainerStatusReconciler.js', /items\(ids:\$ids, limit:\$lim\)/, /chunk = 50/],
    ['src/services/caseReadinessService.js',     /items\(ids: \$ids, limit: \$lim\)/, /BATCH\s*=\s*100/],
    ['src/services/documentFormService.js',      /items\(ids: \$ids, limit: \$lim\)/, /TMPL_CHUNK = 100/],
    ['src/services/documentReviewFormService.js', /items\(ids: \$ids, limit: \$lim\)/, /CHUNK = 100/],
    ['src/scripts/backfillExecutionColumns.js',  /items\(ids: \$ids, limit: \$lim\)/, /CHUNK = 100/],
  ];
  for (const [file, limitRe, chunkRe] of checks) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(src, limitRe, `${file}: query must pass an explicit limit`);
    assert.match(src, chunkRe, `${file}: batch size must be bounded (<= 100)`);
  }
  // the replies reader carries BOTH limits (items + per-item updates)
  const rev = fs.readFileSync(path.join(__dirname, '..', 'src/services/documentReviewFormService.js'), 'utf8');
  assert.match(rev, /items\(ids: \$ids, limit: \$ilim\)[\s\S]{0,120}updates\(limit: \$limit\)/,
    'client replies: items limit AND updates limit');
});
