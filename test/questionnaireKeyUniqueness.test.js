'use strict';

// Field-key uniqueness across EVERY questionnaire form (guard for the
// 2026-08-19 smear bug, case 2026-ISS-010): dynamic-table keys are built as
//   slug(section + '--tbl-' + slug(tableId) + '--r' + N + '--' + header)
// with a 90-char cap. The old code could truncate away the "-rN-header" tail,
// giving every cell of a table ONE key — a single value then smeared across
// all columns on reload. The fix keeps the discriminating tail regardless of
// prefix length. This test replays the FIXED algorithm over every dynamic
// table in every form file, at prefix lengths from 0 to 250, and fails on any
// collision — so the next long-headed form is caught the day it's added.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const FORMS_DIR = path.join(__dirname, '..', 'Questionnair Documents');

// ── the engine's key math, replicated exactly (source-pinned below) ──────────
const slugify     = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/, '').slice(0, 90);
const slugifyFull = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/, '');
function tableKey(section, tableId, rowNum, header) {
  const full = slugifyFull(section + '--tbl-' + slugify(tableId) + '--r' + rowNum + '--' + header);
  if (full.length <= 90) return full;
  const tail = '-tbl-' + slugifyFull(tableId) + '-r' + rowNum + '-' + slugifyFull(header);
  return slugifyFull(section).slice(0, Math.max(0, 90 - tail.length)) + tail;
}

function extractTables(html) {
  const out = [];
  const re = /<table[^>]*class="[^"]*dynamic-table[^"]*"[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/table>/g;
  let m;
  while ((m = re.exec(html))) {
    const headers = [...m[2].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
      .map((h) => h[1].replace(/<[^>]+>/g, '').trim())
      .filter((h) => h && h.toLowerCase() !== 'remove');
    if (headers.length) out.push({ id: m[1], headers });
  }
  return out;
}

test('every dynamic table on every form keeps distinct keys at ANY section depth', () => {
  const forms = fs.readdirSync(FORMS_DIR).filter((f) => f.endsWith('.html'));
  assert.ok(forms.length >= 15, `expected the form catalogue, found ${forms.length}`);
  let tablesChecked = 0;
  const offenders = [];
  for (const form of forms) {
    const tables = extractTables(fs.readFileSync(path.join(FORMS_DIR, form), 'utf8'));
    for (const prefixLen of [0, 40, 70, 85, 90, 120, 180, 250]) {
      const section = 'Main Applicant › ' + 'Section With A Deliberately Long Heading '.repeat(7).slice(0, prefixLen);
      const seenAcrossForm = new Map();   // cross-table collisions within one form/section too
      for (const t of tables) {
        tablesChecked++;
        for (let r = 1; r <= 4; r++) {
          for (const h of t.headers) {
            const k = tableKey(section, t.id, r, h);
            const at = `${form} #${t.id} r${r} "${h}" (prefix ${prefixLen})`;
            if (seenAcrossForm.has(k)) offenders.push(`${at}  ==  ${seenAcrossForm.get(k)}\n    key: ${k}`);
            else seenAcrossForm.set(k, at);
          }
        }
      }
    }
  }
  assert.ok(tablesChecked > 400, `sanity: swept ${tablesChecked} table×depth combinations`);
  assert.deepEqual(offenders.slice(0, 8), [], `key collisions found:\n${offenders.slice(0, 8).join('\n')}`);
});

test('the FIXED tail-preserving algorithm is present in BOTH engine copies (no drift)', () => {
  const src = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService'), 'utf8');
  assert.equal((src.match(/function slugifyFull\(/g) || []).length, 2, 'slugifyFull in client + review engines');
  assert.equal((src.match(/90 - tail2\.length/g) || []).length, 2, 'tail-preserving trim in client + review engines');
  // labeled fields stay collision-proof via the occurrence counter
  assert.equal((src.match(/keyMap\[counterKey\]\+\+/g) || []).length, 2, 'makeKey dedup counter in both engines');
});
