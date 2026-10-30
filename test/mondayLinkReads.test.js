'use strict';

// Monday returns `text` AND `value` as null for "connect boards" (link) and
// mirror cells in every API version it serves (checked 2026-10-22): the ids come
// only through the typed fragment. Reads that relied on value.linkedPulseIds saw
// every link as empty — client-account links were overwritten, the checklist
// prune could not see Template rows. These pin the shared reader and its users.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const { RELATION_FIELDS, MIRROR_FIELDS, linkedIds, displayValue } = require('../src/services/mondayColumnRead');

test('linkedIds: the typed-fragment ids as strings; the old value shape as a fallback; NULL (never []) when unreadable', () => {
  assert.deepEqual(linkedIds({ id: 'r', text: null, value: null, linked_item_ids: ['12', 34] }), ['12', '34']);
  assert.deepEqual(linkedIds({ id: 'r', text: null, value: null, linked_item_ids: [] }), []);
  assert.deepEqual(linkedIds({ value: JSON.stringify({ linkedPulseIds: [{ linkedPulseId: 7 }] }) }), ['7']);
  assert.deepEqual(linkedIds({ value: JSON.stringify({ linkedPulseIds: [] }) }), []);
  for (const unreadable of [null, undefined, {}, { text: null, value: null }, { value: '{}' }, { value: 'not json' }, { linked_item_ids: 'x' }]) {
    assert.equal(linkedIds(unreadable), null, JSON.stringify(unreadable));
  }
});

test('displayValue: the fragment text first, then text, else ""', () => {
  assert.equal(displayValue({ text: null, display_value: 'Passport' }), 'Passport');
  assert.equal(displayValue({ text: null, display_value: '' }), '');
  assert.equal(displayValue({ text: 'Old' }), 'Old');
  assert.equal(displayValue({ text: null }), '');
  assert.equal(displayValue(null), '');
});

test('the fragments are the GraphQL Monday answers with ids/text', () => {
  assert.equal(RELATION_FIELDS, '... on BoardRelationValue { linked_item_ids display_value }');
  assert.equal(MIRROR_FIELDS, '... on MirrorValue { display_value }');
});

test('no app code reads link ids from value.linkedPulseIds any more (only the shared reader, as its fallback)', () => {
  const path = require('path');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/^_backup/.test(e.name)) walk(p); } else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(__dirname, '..', 'src'));
  const offenders = files.filter((f) => !f.endsWith('mondayColumnRead.js') && /linkedPulseId/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('backfillBoardRelation (manual script): reads the link through the fragment and only ever touches Template-built rows with a READABLE empty link — never a "code:" schema row', () => {
  const src = fs.readFileSync(require.resolve('../src/scripts/backfillBoardRelation.js'), 'utf8');
  assert.equal((src.match(/\]\) \{ id text value \$\{RELATION_FIELDS\} \}/g) || []).length, 2, 'both page reads ask for the ids');
  const filter = src.slice(src.indexOf('const toFix = execItems.filter'), src.indexOf('console.log(`Items needing'));
  assert.match(filter, /if \(!\/\^\\d\+\$\/\.test\(intake\)\) return false;/, 'numeric intake id only');
  assert.match(filter, /Array\.isArray\(ids\) && ids\.length === 0/, 'unreadable (null) is not "empty"');
  assert.doesNotMatch(filter, /\.value/, 'never decides from the null value');
});

/* ── the escalation reminder's "Complete Questionnaire" button ── */

test('escalation email: the questionnaire button opens the client\'s own /q link with the access code; with no code it is left out (never the dead /questionnaire page)', () => {
  const { buildClientEmailHtml } = require('../src/services/escalationRoutingService');
  const withCode = buildClientEmailHtml('Please finish.', '2026-PGWP-030', 'Ana', false, { accessToken: 'ab c/d' });
  assert.match(withCode, /href="[^"]*\/q\/2026-PGWP-030\?t=ab%20c%2Fd"\s+class="btn btn-q">Complete Questionnaire<\/a>/);
  assert.doesNotMatch(withCode, /\/questionnaire\//);
  // the documents page checks the same code since 2026-10-31 — the button carries it
  assert.match(withCode, /\/documents\/2026-PGWP-030\?t=ab%20c%2Fd" class="btn btn-d">Upload Documents/);
  const noCode = buildClientEmailHtml('Please finish.', '2026-PGWP-030', 'Ana', true);
  assert.doesNotMatch(noCode, /Complete Questionnaire|\/questionnaire\//);
  assert.match(noCode, /\/documents\/2026-PGWP-030" class="btn btn-d">Upload Documents/);
  assert.match(noCode, /Final Notice/);
});

test('escalation email: both client sends pass the case\'s access code, which the case read fetches', () => {
  const src = fs.readFileSync(require.resolve('../src/services/escalationRoutingService.js'), 'utf8');
  assert.equal((src.match(/buildClientEmailHtml\(body, caseRef, clientName, (false|true), \{ accessToken: col\(CM\.accessToken\) \}\)/g) || []).length, 2);
  assert.match(src, /CM\.caseRef, CM\.clientEmail, CM\.accessToken,/);
});
