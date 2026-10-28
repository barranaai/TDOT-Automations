'use strict';

// Document numbers on cases in later stages (Faran 2026-10-28, 2026-CEC-EE-110:
// moved to "Profile Created" the day before the client uploaded everything —
// Documents Uploaded kept reading 0%). Open stages outside the four
// collection/review stages now get the four document numbers recounted — and
// NOTHING else: no Doc Threshold Met / Ready for Review, no stage gate. Closed
// stages and locked cases are left alone. No network: stubs only.

const test = require('node:test');
const assert = require('node:assert/strict');

const CR = require('../src/services/caseReadinessService');
const mondayApi = require('../src/services/mondayApi');
const gates = require('../src/services/stageGateService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const COL = { status: 'color_mm0zwgvr', intake: 'text_mm0zdm3k' };
const CMC = { dr: 'numeric_mm0x5g9x', du: 'numeric_mm2njqk1', bd: 'numeric_mm0xje6p', mr: 'numeric_mm0x6qy4', rfr: 'color_mm0xh2fh', thr: 'color_mm0xvxq2' };

/** Schema-seeded checklist rows (code:…) — counted as Mandatory, Counts = Yes. */
const rows = (statuses) => statuses.map((st, i) => ({ id: String(i), column_values: [
  { id: 'color_mm0zwgvr', text: st }, { id: 'lookup_mm0zhkkd', text: '' }, { id: 'lookup_mm0z1chx', text: '' },
  { id: require('fs').readFileSync(require.resolve('../src/services/caseReadinessService'), 'utf8').match(/blockingDoc:\s*'([^']+)'/)[1], text: '' },
  { id: require('fs').readFileSync(require.resolve('../src/services/caseReadinessService'), 'utf8').match(/intakeItemId:\s*'([^']+)'/)[1], text: `code:DOC${i}` },
] }));

function world({ checklist = [], stored = {} } = {}) {
  const writes = [], gateCalls = [];
  const restore = [
    stub(mondayApi, 'query', async (q, v) => {
      if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: checklist } };
      if (/items\(ids:\$ids\)\{ id column_values/.test(q)) return { items: [{ id: v.ids[0], column_values: Object.entries(stored).map(([id, text]) => ({ id, text })) }] };
      if (/change_multiple_column_values/.test(q)) { writes.push(JSON.parse(v.colValues || v.cols)); return {}; }
      if (/SLA|sla/.test(q) || /items_page\(limit: 100\)/.test(q)) return { boards: [{ items_page: { items: [] } }] };
      return { boards: [{ items_page: { items: [] } }] };
    }),
    stub(gates, 'onThresholdMet', async () => { gateCalls.push('threshold'); }),
    stub(gates, 'onFullyComplete', async () => { gateCalls.push('complete'); }),
  ];
  return { writes, gateCalls, done: () => restore.reverse().forEach((r) => r()) };
}

test('which stages get what: the four → full; other open stages → the numbers only; closed → nothing', () => {
  for (const s of ['Document Collection Started', 'Internal Review', 'Submission Preparation', 'Stuck', '']) assert.equal(CR.stagePath(s), 'full', s);
  for (const s of ['Profile Created', 'Profile Linked', 'Application Submitted', 'ADR', 'Pre-Onboarding', 'Task Done', 'LMIA Submitted']) assert.equal(CR.stagePath(s), 'numbers', s);
  for (const s of ['Submitted', 'Approved', 'Refused', 'Closed', 'Withdrawn', 'Cancelled', 'Archived']) assert.equal(CR.stagePath(s), 'none', s);
});

test('Varshaben\'s case: "Profile Created", everything uploaded → 100% / 0 missing; ONLY the four numbers are written; no gate', async () => {
  const w = world({ checklist: rows(Array(10).fill('Received')), stored: { [CMC.dr]: '0', [CMC.du]: '0', [CMC.bd]: '0', [CMC.mr]: '10' } });
  try {
    const r = await CR.calculateForCase({ masterItemId: '13305672007', caseRef: '2026-CEC-EE-110', caseType: 'Canadian Experience Class (EE after ITA)', caseStage: 'Profile Created', storedQReadiness: 94, qSubmitted: true });
    assert.equal(r.numbersOnly, true); assert.equal(r.written, true);
    assert.deepEqual(r.after, { uploadedPct: 100, readinessPct: 0, blocking: 0, missingRequired: 0 });
    assert.equal(w.writes.length, 1);
    assert.deepEqual(Object.keys(w.writes[0]).sort(), [CMC.dr, CMC.du, CMC.bd, CMC.mr].sort(), 'never Ready for Review / Doc Threshold Met / Blocking Q');
    assert.deepEqual(w.gateCalls, [], 'no stage gate');
  } finally { w.done(); }
});

test('numbers already right → nothing written; no checklist → nothing; a closed stage → not even read', async () => {
  let w = world({ checklist: rows(['Received', 'Missing']), stored: { [CMC.dr]: '0', [CMC.du]: '50', [CMC.bd]: '0', [CMC.mr]: '1' } });
  try {
    const r = await CR.calculateForCase({ masterItemId: '1', caseRef: 'X-1', caseStage: 'Application Submitted' });
    assert.equal(r.changed, false); assert.equal(w.writes.length, 0);
  } finally { w.done(); }
  w = world({ checklist: [] });
  try { assert.equal(await CR.calculateForCase({ masterItemId: '1', caseRef: 'X-1', caseStage: 'Profile Created' }), null); assert.equal(w.writes.length, 0); } finally { w.done(); }
  let reads = 0;
  const r1 = stub(mondayApi, 'query', async () => { reads++; return {}; });
  try { assert.equal(await CR.calculateForCase({ masterItemId: '1', caseRef: 'X-1', caseStage: 'Cancelled' }), null); assert.equal(reads, 0); } finally { r1(); }
});

test('the four full stages still get the full calculation (status columns written, as before)', async () => {
  const w = world({ checklist: rows(['Reviewed', 'Reviewed']) });
  try {
    await CR.calculateForCase({ masterItemId: '1', caseRef: 'X-1', caseType: 'T', caseStage: 'Internal Review', storedQReadiness: 50, qSubmitted: false });
    assert.equal(w.writes.length, 1);
    assert.ok(CMC.rfr in w.writes[0] && CMC.thr in w.writes[0], 'Ready for Review + Doc Threshold Met still written in the full stages');
  } finally { w.done(); }
});

test('the admin refresh: open later-stage cases only, not locked; a dry run writes nothing', async () => {
  const cases = [
    { id: '1', column_values: [{ id: 'text_mm142s49', text: 'A-1' }, { id: 'color_mm0x8faa', text: 'Profile Created' }, { id: 'color_mm0x3x1x', text: 'No' }] },
    { id: '2', column_values: [{ id: 'text_mm142s49', text: 'A-2' }, { id: 'color_mm0x8faa', text: 'Internal Review' }, { id: 'color_mm0x3x1x', text: '' }] },
    { id: '3', column_values: [{ id: 'text_mm142s49', text: 'A-3' }, { id: 'color_mm0x8faa', text: 'Profile Created' }, { id: 'color_mm0x3x1x', text: 'Yes' }] },
    { id: '4', column_values: [{ id: 'text_mm142s49', text: 'A-4' }, { id: 'color_mm0x8faa', text: 'Cancelled' }, { id: 'color_mm0x3x1x', text: '' }] },
  ];
  const writes = []; const lookedAt = [];
  const r1 = stub(mondayApi, 'query', async (q, v) => {
    if (/items_page\(limit:200/.test(q)) return { boards: [{ items_page: { cursor: null, items: cases } }] };
    if (/items_page_by_column_values/.test(q)) { lookedAt.push(v.val); return { items_page_by_column_values: { items: rows(['Received']) } }; }
    if (/items\(ids:\$ids\)/.test(q)) return { items: [{ column_values: [{ id: CMC.du, text: '0' }] }] };
    if (/change_multiple_column_values/.test(q)) { writes.push(v.itemId); return {}; }
    return {};
  });
  try {
    const dry = await CR.refreshAllDocNumbers({ dryRun: true });
    assert.deepEqual(lookedAt, ['A-1'], 'only the open, unlocked later-stage case');
    assert.equal(dry.changed.length, 1); assert.equal(dry.changed[0].written, false);
    assert.equal(writes.length, 0, 'a dry run writes nothing');
    const real = await CR.refreshAllDocNumbers({ dryRun: false });
    assert.equal(real.changed[0].written, true); assert.deepEqual(writes, ['1']);
  } finally { r1(); }
});

test('the admin route is admin-only and defaults to a dry run', () => {
  const s = require('fs').readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(s, /app\.post\('\/admin\/readiness\/refresh-numbers', express\.json\(\), async \(req, res\) => \{\n  if \(!resolveAdminOrReject\(req, res, 'Only an admin can refresh the document numbers\.'\)\) return;/);
  assert.ok(s.includes("refreshAllDocNumbers({ dryRun: (req.body || {}).dryRun !== false })"));
});
