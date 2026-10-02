'use strict';

// "Not Applicable" documents (readiness item 2, built 2026-10-02).
//
// A checklist item that does not exist for a client (a marriage certificate
// for a single applicant) used to sit "Missing" forever and hold the
// readiness % down. Staff can now mark it Not Applicable WITH A REASON; the
// row stays (greyed, never deleted), drops out of every count, the client
// sees "not needed", and nothing emails or escalates. The webhook owns the
// reason column's lifecycle so every path (app button, hand change in Monday,
// client upload anyway) behaves the same.
//
// Rules proved here, in the order the plan listed them:
//   1. the helper module: switch + reason column = "ready"; reason text shape
//   2. readiness maths: an N/A row is skipped entirely (item 1 untouched)
//   3. a Review Note on an N/A row never emails the client (decided before the switch)
//   4. the status webhook: Review Required = No, no email / escalation / rework
//      count; a hand-set label gets a placeholder reason + a note asking for one;
//      leaving N/A clears the reason; the readiness recalc still fires
//   5. the writers: switch, reason, Rework Required / Reviewed refused, one
//      Monday write, two notes; undo → Received (file ever uploaded) or Missing
//   6. the three staff/client pages count and render N/A rows the same way
//   7. the seeder never prunes an N/A row; no label is ever auto-created on
//      the Documents board; the cockpit route needs a Monday sign-in and the
//      shared-key route refuses the two actions

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const na        = require('../src/services/documentNotApplicable');
const mondayApi = require('../src/services/mondayApi');

const EXEC_BOARD = '18401875593';
const STATUS   = 'color_mm0zwgvr';
const REQUIRED = 'color_mm0z796e';
const NOTES    = 'long_text_mm0zbpr';
const REF      = 'text_mm0z2cck';
const COUNT    = 'numeric_mm0zwf95';
const UPLOAD   = 'date_mm0zyw0m';
const REASON   = 'long_text_na_test';
const CM_BOARD = String(require('../config/monday').clientMasterBoardId);

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

/** Switch + reason column as the tests want them; returns the restore. */
function naState({ on = true, column = REASON } = {}) {
  const savedEnv = process.env.DOC_NOT_APPLICABLE;
  if (on) process.env.DOC_NOT_APPLICABLE = '1'; else delete process.env.DOC_NOT_APPLICABLE;
  na._setConfigForTests(column ? { boardId: EXEC_BOARD, columns: { notApplicableReason: column } } : null);
  return () => {
    if (savedEnv === undefined) delete process.env.DOC_NOT_APPLICABLE; else process.env.DOC_NOT_APPLICABLE = savedEnv;
    na._resetConfigForTests();
  };
}

/* ───────────────────────────── 1. the helper ───────────────────────────── */

test('ready = switch ON and the reason column recorded; reading N/A rows never depends on either', () => {
  let restore = naState({ on: false, column: REASON });
  try { assert.equal(na.isEnabled(), false); assert.equal(na.isReady(), false, 'switch off → not ready'); } finally { restore(); }
  restore = naState({ on: true, column: '' });
  try { assert.equal(na.isEnabled(), true); assert.equal(na.isReady(), false, 'no reason column yet → not ready'); } finally { restore(); }
  restore = naState({ on: true, column: REASON });
  try { assert.equal(na.isReady(), true); assert.equal(na.reasonColumnId(), REASON); } finally { restore(); }
  // the label text is the contract every page reads — never an index
  assert.equal(na.LABEL, 'Not Applicable');
  assert.equal(na.isNotApplicable(' Not Applicable '), true);
  assert.equal(na.isNotApplicable('Missing'), false);
});

test('reason text: the reason on line 1, "— who, when (Toronto)" on line 2; both halves read back', () => {
  const t = na.reasonText('  client is\n single ', 'Gauri Berde', Date.UTC(2026, 9, 2, 14, 5));
  const lines = t.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'client is single', 'whitespace collapsed, one line');
  assert.match(lines[1], /^— Gauri Berde, .*2026.*\(Toronto\)$/);
  assert.equal(na.reasonOnly(t), 'client is single');
  assert.equal(na.reasonBy(t), lines[1].slice(2));
  assert.equal(na.reasonBy('just a reason'), '', 'no second line → no "by"');
  assert.match(na.reasonText('x', ''), /^x\n— staff, /, 'no name → "staff"');
});

/* ─────────────────────── 2. readiness maths (item 1 untouched) ─────────────────────── */

test('calcDocMetrics: an N/A row is out of every count — total, uploaded, reviewed, missing-required', () => {
  const { calcDocMetrics, applySchemaDefaults } = require('../src/services/caseReadinessService')._internal;
  const D = { counts: 'lookup_mm0zhkkd', status: STATUS, blocking: 'lookup_mm0zb0p6', required: 'lookup_mm0z1chx', intakeId: 'text_mm0zfsp1' };
  const row = (status) => ({ id: 'x', column_values: [
    { id: D.intakeId, text: 'code:SCLPC-WP--PA-PASSPORT-001' }, { id: D.status, text: status },
    { id: D.counts, text: '' }, { id: D.blocking, text: '' }, { id: D.required, text: '' } ] });
  // the EE-070 shape: 11 reviewed, 1 marriage certificate that does not exist
  const items = [...Array(11).fill('Reviewed'), 'Not Applicable'].map(row);
  applySchemaDefaults(items);
  const m = calcDocMetrics(items);
  assert.deepEqual(m, { readinessPct: 100, uploadedPct: 100, blockingCount: 0, missingRequired: 0, totalCountable: 11 });
  // the same case before staff marked it: 92% / 1 missing — the number that held the case
  const before = [...Array(11).fill('Reviewed'), 'Missing'].map(row);
  applySchemaDefaults(before);
  assert.equal(calcDocMetrics(before).readinessPct, 92);
  assert.equal(calcDocMetrics(before).missingRequired, 1);
  // item 1 stays as it is: Received still does not count as reviewed
  const rec = [...Array(2).fill('Received'), 'Not Applicable'].map(row);
  applySchemaDefaults(rec);
  assert.deepEqual(calcDocMetrics(rec), { readinessPct: 0, uploadedPct: 100, blockingCount: 0, missingRequired: 0, totalCountable: 2 });
  // a BLOCKING (legacy Template-board) row marked N/A no longer holds the stage gate (Faran, 2026-10-02)
  const D2 = { ...D };
  const blockingRow = (status) => ({ id: 'b', column_values: [
    { id: D2.intakeId, text: '18401624999' }, { id: D2.status, text: status },
    { id: D2.counts, text: 'Yes' }, { id: D2.blocking, text: 'Yes' }, { id: D2.required, text: 'Mandatory' } ] });
  assert.equal(calcDocMetrics([blockingRow('Missing')]).blockingCount, 1, 'a missing blocking document blocks');
  assert.equal(calcDocMetrics([blockingRow('Received')]).blockingCount, 1, 'until it is reviewed');
  assert.equal(calcDocMetrics([blockingRow('Not Applicable')]).blockingCount, 0, 'a document that does not exist cannot block');
  assert.equal(calcDocMetrics([blockingRow('Not Applicable')]).missingRequired, 0);
  // every row N/A → nothing countable, not a division by zero
  const all = ['Not Applicable', 'Not Applicable'].map(row);
  applySchemaDefaults(all);
  assert.equal(calcDocMetrics(all).totalCountable, 0);
  assert.equal(calcDocMetrics(all).readinessPct, 0);
});

/* ─────────────── 3. a Review Note on an N/A row never emails ─────────────── */

test('decideReviewNote: Not Applicable → ignore, with the reopen switch ON and OFF, fresh or same text', () => {
  const D = require('../src/services/documentReviewService').decideReviewNote;
  for (const enabled of [true, false]) {
    for (const previousNotes of [null, 'Old note', 'Hello']) {
      assert.equal(D({ notes: 'Hello', previousNotes, caseRef: '2026-X-001', status: 'Not Applicable', enabled }), 'ignore',
        `enabled=${enabled} previousNotes=${JSON.stringify(previousNotes)}`);
    }
  }
  // the neighbours are unchanged
  assert.equal(D({ notes: 'Hello', previousNotes: null, caseRef: '2026-X-001', status: 'Missing', enabled: true }), 'notify');
  assert.equal(D({ notes: 'Hello', previousNotes: null, caseRef: '2026-X-001', status: 'Reviewed', enabled: true }), 'reopen');
});

/* ───────────────────────── 4. the status webhook ───────────────────────── */

const ITEM = '77001';

function webhookHarness({ status = 'Not Applicable', reason = '', caseRef = '2026-X-001', uploadDate = '', emptyRead = false, readFails = false } = {}) {
  const svc  = require('../src/services/documentReviewService');
  const row  = { name: 'Marriage certificate', cols: { [STATUS]: status, [NOTES]: '', [REF]: caseRef, [COUNT]: '0', [REASON]: reason, [UPLOAD]: uploadDate } };
  const calls = { writes: [], notes: [], queued: [], recalcs: [], cm: [] };
  const real = { ...svc.io };
  const savedReopen = process.env.REVIEW_NOTE_REOPENS;
  process.env.REVIEW_NOTE_REOPENS = '1';
  Object.assign(svc.io, {
    query: async (q, v) => {
      if (/change_multiple_column_values/.test(q)) {
        const cols = JSON.parse(v.colValues);
        calls.writes.push({ boardId: String(v.boardId), itemId: String(v.itemId), cols });
        if (String(v.boardId) === EXEC_BOARD) for (const [k, val] of Object.entries(cols)) row.cols[k] = val && val.label !== undefined ? val.label : val;
        return { change_multiple_column_values: { id: String(v.itemId) } };
      }
      if (/create_update/.test(q)) { calls.notes.push({ itemId: String(v.itemId ?? v.i), body: v.body ?? v.b }); return { create_update: { id: 'u1' } }; }
      if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: [{ id: 'CM1' }] } };
      if (/items\(ids:/.test(q)) {
        const ids = [...q.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
        if (ids.includes(REASON) && readFails) throw new Error('503 from Monday');
        if (ids.includes(REASON) && emptyRead) return { items: [] };
        return { items: [{ name: row.name, column_values: ids.map((id) => ({ id, text: row.cols[id] ?? '' })) }] };
      }
      throw new Error('unexpected query: ' + q.slice(0, 80));
    },
    queueItem: (...a) => { calls.queued.push(a); },
    recalc:    async (ref) => { calls.recalcs.push(ref); },
    now:       () => new Date('2026-10-02T14:00:00Z'),
  });
  const restoreNa = naState({ on: true, column: REASON });
  const restore = () => {
    Object.assign(svc.io, real); restoreNa();
    if (savedReopen === undefined) delete process.env.REVIEW_NOTE_REOPENS; else process.env.REVIEW_NOTE_REOPENS = savedReopen;
  };
  const statusEvent = (label, prev) => svc.onColumnChange({ itemId: ITEM, columnId: STATUS, value: { label: { text: label } },
    previousValue: prev === undefined ? undefined : { label: { text: prev } } });
  const settle = () => new Promise((r) => setImmediate(r));   // the recalc is fire-and-forget
  return { row, calls, restore, statusEvent, settle };
}

test('webhook: → Not Applicable with the app\'s reason already there: Review Required=No, nothing else — no email, no escalation, no rework count, no note', async () => {
  const h = webhookHarness({ reason: 'client is single\n— Gauri, 2 Oct 2026 10:00 (Toronto)' });
  try {
    await h.statusEvent('Not Applicable', 'Missing'); await h.settle();
    assert.deepEqual(h.calls.writes, [{ boardId: EXEC_BOARD, itemId: ITEM, cols: { [REQUIRED]: { label: 'No' } } }]);
    assert.deepEqual(h.calls.queued, [], 'no client email');
    assert.deepEqual(h.calls.notes, [], 'the app already posted its notes — the webhook adds none');
    assert.equal(h.row.cols[REASON].split('\n')[0], 'client is single', 'the reason is untouched');
    assert.deepEqual(h.calls.recalcs, ['2026-X-001'], 'readiness recalculates — the % just changed');
  } finally { h.restore(); }
});

test('webhook: label set BY HAND in Monday (no reason): placeholder reason written + a row note asking for the real one', async () => {
  const h = webhookHarness({ reason: '' });
  try {
    await h.statusEvent('Not Applicable', 'Missing'); await h.settle();
    assert.equal(h.calls.writes.length, 1);
    const cols = h.calls.writes[0].cols;
    assert.deepEqual(cols[REQUIRED], { label: 'No' });
    assert.match(cols[REASON], /^\(set directly in Monday — no reason recorded\)\n— Monday, /);
    assert.equal(h.calls.notes.length, 1);
    assert.equal(h.calls.notes[0].itemId, ITEM);
    assert.match(h.calls.notes[0].body, /marked Not Applicable directly in Monday\. Please add the reason/);
    assert.deepEqual(h.calls.queued, []);
  } finally { h.restore(); }
});

test('webhook: the row LEAVES Not Applicable by a hand change or a client upload: reason cleared + "applies again" note (wording from the upload date), with OR without previousValue; no rework side effects', async () => {
  for (const [to, uploadDate, how, prev] of [
    ['Received', '2026-10-02', ' (the uploaded file goes back to the reviewer)', 'Not Applicable'],       // the client uploaded anyway
    ['Received', '2026-09-14', ' (the uploaded file goes back to the reviewer)', undefined],              // hand change; Monday sent no previousValue
    ['Missing',  '',           '', 'Not Applicable'],
  ]) {
    const h = webhookHarness({ status: to, reason: 'client is single\n— Gauri, …', uploadDate });
    try {
      await h.statusEvent(to, prev); await h.settle();
      const reasonWrites = h.calls.writes.filter((w) => w.cols[REASON] !== undefined);
      assert.deepEqual(reasonWrites, [{ boardId: EXEC_BOARD, itemId: ITEM, cols: { [REASON]: '' } }], `${to}: the reason column is emptied`);
      assert.equal(h.calls.notes.length, 1);
      assert.equal(h.calls.notes[0].body, `↩️ Document applies again${how} — it is back on the checklist as "${to}".`);
      assert.deepEqual(h.calls.queued, [], 'no email');
      assert.ok(!h.calls.writes.some((w) => w.cols[COUNT] !== undefined), 'no rework count');
      assert.deepEqual(h.calls.recalcs, ['2026-X-001']);
    } finally { h.restore(); }
  }
});

test('webhook: the app\'s own undo already cleared the reason → a Received/Missing event does nothing more (no duplicate note)', async () => {
  for (const to of ['Received', 'Missing']) {
    const h = webhookHarness({ status: to, reason: '' });
    try {
      await h.statusEvent(to, 'Not Applicable'); await h.settle();
      assert.deepEqual(h.calls.writes, [], 'nothing to clear');
      assert.deepEqual(h.calls.notes, [], 'clearNotApplicable posted the row note itself');
    } finally { h.restore(); }
  }
});

test('webhook: a LATE or re-delivered "Not Applicable" event for a row that has since left N/A (undo, hand change) is ignored — no placeholder, no Review Required=No, no note', async () => {
  for (const now of ['Received', 'Missing']) {
    const h = webhookHarness({ status: now, reason: '' });
    try {
      await h.statusEvent('Not Applicable', 'Missing'); await h.settle();
      assert.deepEqual(h.calls.writes, [], `${now}: nothing written`);
      assert.deepEqual(h.calls.notes, [], `${now}: no "please add the reason" note`);
      assert.equal(h.row.cols[REASON], '');
    } finally { h.restore(); }
  }
});

test('webhook: a failed Review Required write on an N/A event is logged and never stops the readiness recalc', async () => {
  const h = webhookHarness({ reason: 'r\n— x' });
  const svc = require('../src/services/documentReviewService');
  const realQuery = svc.io.query;
  svc.io.query = async (gql, v) => { if (/change_multiple_column_values/.test(gql)) throw new Error('503 from Monday'); return realQuery(gql, v); };
  try {
    await h.statusEvent('Not Applicable', 'Missing'); await h.settle();
    assert.deepEqual(h.calls.recalcs, ['2026-X-001'], 'the % still recalculates');
  } finally { h.restore(); }
});

test('webhook: out-of-order delivery — a stale "Received" event while the row STILL reads Not Applicable leaves the reason alone', async () => {
  const h = webhookHarness({ status: 'Not Applicable', reason: 'client is single\n— Gauri, …' });
  try {
    await h.statusEvent('Received', 'Not Applicable'); await h.settle();
    assert.deepEqual(h.calls.writes, []);
    assert.deepEqual(h.calls.notes, []);
    assert.equal(h.row.cols[REASON].split('\n')[0], 'client is single');
  } finally { h.restore(); }
});

test('webhook: an EMPTY or FAILED reason read never writes the placeholder over the app\'s reason — Review Required=No only, no note, no throw', async () => {
  for (const opts of [{ emptyRead: true }, { readFails: true }]) {
    const h = webhookHarness({ reason: 'client is single\n— Gauri, …', ...opts });
    try {
      await h.statusEvent('Not Applicable', 'Missing'); await h.settle();
      assert.deepEqual(h.calls.writes, [{ boardId: EXEC_BOARD, itemId: ITEM, cols: { [REQUIRED]: { label: 'No' } } }], JSON.stringify(opts));
      assert.deepEqual(h.calls.notes, []);
      assert.equal(h.row.cols[REASON].split('\n')[0], 'client is single');
    } finally { h.restore(); }
  }
});

test('webhook: Not Applicable → Rework Required by hand still does today\'s rework path, AND clears the reason', async () => {
  const h = webhookHarness({ status: 'Rework Required', reason: 'r\n— x' });
  try {
    h.row.cols[NOTES] = 'Please upload';
    await h.statusEvent('Rework Required', 'Not Applicable'); await h.settle();
    assert.ok(h.calls.writes.some((w) => w.cols[COUNT] !== undefined), 'rework count incremented (today\'s path)');
    assert.ok(h.calls.writes.some((w) => w.cols[REASON] === ''), 'reason cleared');
  } finally { h.restore(); }
});

test('webhook: the same label re-saved ("Not Applicable" → "Not Applicable") does nothing twice', async () => {
  const h = webhookHarness({ reason: '' });
  try {
    await h.statusEvent('Not Applicable', 'Not Applicable'); await h.settle();
    assert.deepEqual(h.calls.writes, []);
    assert.deepEqual(h.calls.notes, []);
  } finally { h.restore(); }
});

test('webhook: switch OFF — an already-marked row is still handled (reading N/A never depends on the switch)', async () => {
  const h = webhookHarness({ reason: 'r\n— x' });
  delete process.env.DOC_NOT_APPLICABLE;
  try {
    await h.statusEvent('Not Applicable', 'Missing'); await h.settle();
    assert.deepEqual(h.calls.writes, [{ boardId: EXEC_BOARD, itemId: ITEM, cols: { [REQUIRED]: { label: 'No' } } }]);
    assert.deepEqual(h.calls.queued, []);
  } finally { h.restore(); }
});

/* ───────────────────────────── 5. the writers ───────────────────────────── */

function writerHarness({ status = 'Missing', uploadDate = '', name = 'Marriage certificate', rowCase = '2026-X-001' } = {}) {
  const calls = { writes: [], notes: [] };
  const restoreQ = stub(mondayApi, 'query', async (q, v) => {
    if (/change_multiple_column_values/.test(q)) { calls.writes.push({ boardId: String(v.boardId), itemId: String(v.itemId), cols: JSON.parse(v.cols) }); return { change_multiple_column_values: { id: v.itemId } }; }
    if (/create_update/.test(q)) { calls.notes.push({ itemId: String(v.i), body: v.b }); return { create_update: { id: 'u' } }; }
    if (/items_page_by_column_values/.test(q)) { assert.equal(String(v.b), CM_BOARD); return { items_page_by_column_values: { items: [{ id: 'CM9' }] } }; }
    if (/items\(ids:/.test(q)) {
      const ids = [...q.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
      const cols = { [STATUS]: status, [UPLOAD]: uploadDate, [REF]: rowCase };
      return { items: [{ name, column_values: ids.map((id) => ({ id, text: cols[id] ?? '' })) }] };
    }
    throw new Error('unexpected query: ' + q.slice(0, 60));
  });
  const restoreNa = naState({ on: true, column: REASON });
  return { calls, restore: () => { restoreQ(); restoreNa(); } };
}

const svcForm = () => require('../src/services/documentReviewFormService');

test('markNotApplicable: switch OFF or no reason column → a 400-class error, no Monday call', async () => {
  for (const state of [{ on: false, column: REASON }, { on: true, column: '' }]) {
    const restoreNa = naState(state);
    const restoreQ = stub(mondayApi, 'query', async () => { throw new Error('must not be called'); });
    try {
      await assert.rejects(svcForm().markNotApplicable('1', 'reason', 'Gauri', '2026-X-001'), (e) => e.badRequest === true && /switched off/.test(e.message));
    } finally { restoreQ(); restoreNa(); }
  }
});

test('markNotApplicable: a reason is required (and bounded); nothing is read or written without one', async () => {
  const restoreNa = naState();
  const restoreQ = stub(mondayApi, 'query', async () => { throw new Error('must not be called'); });
  try {
    for (const bad of ['', '   ', null, undefined, 'x'.repeat(301)]) {
      await assert.rejects(svcForm().markNotApplicable('1', bad, 'Gauri', '2026-X-001'), (e) => e.badRequest === true, `reason ${JSON.stringify(bad && bad.length)}`);
    }
  } finally { restoreQ(); restoreNa(); }
});

test('markNotApplicable: Rework Required and Reviewed rows are refused ("Undo first") — no write', async () => {
  for (const [status, re] of [['Rework Required', /Press Undo first — this document has an open rework request/], ['Reviewed', /already reviewed/]]) {
    const h = writerHarness({ status });
    try {
      await assert.rejects(svcForm().markNotApplicable('1', 'client is single', 'Gauri', '2026-X-001'), (e) => e.badRequest === true && re.test(e.message));
      assert.deepEqual(h.calls.writes, []); assert.deepEqual(h.calls.notes, []);
    } finally { h.restore(); }
  }
});

test('markNotApplicable on a Missing row: ONE write (status + reason + Review Required No), a row note and a case note, the reason in both', async () => {
  const h = writerHarness({ status: 'Missing' });
  try {
    const r = await svcForm().markNotApplicable('5001', '  client is   single ', 'Gauri Berde', '2026-X-001');
    assert.deepEqual(r, { ok: true });
    assert.equal(h.calls.writes.length, 1);
    const w = h.calls.writes[0];
    assert.equal(w.boardId, EXEC_BOARD); assert.equal(w.itemId, '5001');
    assert.deepEqual(w.cols[STATUS], { label: 'Not Applicable' });
    assert.deepEqual(w.cols[REQUIRED], { label: 'No' });
    assert.match(w.cols[REASON], /^client is single\n— Gauri Berde, .*\(Toronto\)$/);
    assert.ok(!(NOTES in w.cols), 'the reason NEVER goes in Review Notes (that emails the client)');
    assert.deepEqual(h.calls.notes.map((n) => n.itemId), ['5001', 'CM9'], 'row note then case note');
    for (const n of h.calls.notes) {
      assert.match(n.body, /⛔ <b>Document marked Not Applicable<\/b> — Marriage certificate — by Gauri Berde, .*\(Toronto\)\.<br>Reason: client is single$/);
    }
  } finally { h.restore(); }
});

test('markNotApplicable on a Received row (allowed, D4): the note says the uploaded file stays; a hostile reason is escaped', async () => {
  const h = writerHarness({ status: 'Received', name: 'Spouse <passport>' });
  try {
    await svcForm().markNotApplicable('5002', 'wrong <b>doc</b> & "x"', 'G', '2026-X-001');
    assert.match(h.calls.notes[0].body, /\(A file had been uploaded to this document; it stays in the folder\.\)$/);
    assert.match(h.calls.notes[0].body, /Spouse &lt;passport&gt;/);
    assert.match(h.calls.notes[0].body, /Reason: wrong &lt;b&gt;doc&lt;\/b&gt; &amp; &quot;x&quot;/);
    assert.ok(!/<b>doc<\/b>/.test(h.calls.notes[0].body));
  } finally { h.restore(); }
});

test('markNotApplicable on an already-N/A row: {already:true}, no write, no note', async () => {
  const h = writerHarness({ status: 'Not Applicable' });
  try {
    assert.deepEqual(await svcForm().markNotApplicable('5003', 'again', 'G', '2026-X-001'), { already: true });
    assert.deepEqual(h.calls.writes, []); assert.deepEqual(h.calls.notes, []);
  } finally { h.restore(); }
});

test('clearNotApplicable: back to "Missing" when no file was ever uploaded; "Received" + Review Required Yes when one was; clears the reason in the SAME write; row + case notes', async () => {
  for (const [uploadDate, back, tail] of [['', 'Missing', ''], ['2026-09-14', 'Received', ' \\(the file uploaded earlier goes back to the reviewer\\)']]) {
    const h = writerHarness({ status: 'Not Applicable', uploadDate });
    try {
      const r = await svcForm().clearNotApplicable('5004', 'Gauri', '2026-X-001');
      assert.deepEqual(r, { ok: true, status: back });
      assert.equal(h.calls.writes.length, 1);
      const cols = h.calls.writes[0].cols;
      assert.deepEqual(cols[STATUS], { label: back });
      if (back === 'Received') assert.deepEqual(cols[REQUIRED], { label: 'Yes' }, 'the reviewer looks again'); else assert.ok(!(REQUIRED in cols));
      assert.equal(cols[REASON], '', 'the undo never depends on the webhook seeing previousValue');
      assert.deepEqual(h.calls.notes.map((n) => n.itemId), ['5004', 'CM9'], 'row note then case note');
      for (const n of h.calls.notes) assert.match(n.body, new RegExp(`↩️ <b>Document applies again</b> — Marriage certificate — by Gauri, .*\\(Toronto\\)\\. It is back on the checklist as "${back}"${tail}\\.$`));
    } finally { h.restore(); }
  }
});

test('markNotApplicable / clearNotApplicable: a row that belongs to ANOTHER case (or no case named) is refused before any write — the case note can never land elsewhere', async () => {
  for (const [status, run] of [['Missing', (s) => s.markNotApplicable('5006', 'reason', 'G', '2026-X-001')], ['Not Applicable', (s) => s.clearNotApplicable('5006', 'G', '2026-X-001')]]) {
    const h = writerHarness({ status, rowCase: '2026-Y-999' });
    try {
      await assert.rejects(run(svcForm()), (e) => e.badRequest === true && /not on this case/.test(e.message));
      assert.deepEqual(h.calls.writes, []); assert.deepEqual(h.calls.notes, []);
    } finally { h.restore(); }
  }
  const h = writerHarness({ status: 'Missing' });
  try {
    await assert.rejects(svcForm().markNotApplicable('5006', 'reason', 'G', ''), (e) => e.badRequest === true);
    assert.deepEqual(h.calls.writes, []);
  } finally { h.restore(); }
});

test('the OLD writers refuse a Not Applicable row (a stale tab or a direct POST cannot turn it into Rework / Reviewed / Received); other rows proceed as before', async () => {
  const S = svcForm();
  const runs = [['markReviewed', (s) => s.markReviewed('5007')], ['requestRework', (s) => s.requestRework('5007', 'Blurry')], ['reopenDoc', (s) => s.reopenDoc('5007')]];
  for (const [name, run] of runs) {
    const h = writerHarness({ status: 'Not Applicable' });
    try {
      await assert.rejects(run(S), (e) => e.badRequest === true && /press "Applies again" first/.test(e.message), name);
      assert.deepEqual(h.calls.writes, [], `${name}: no write`);
    } finally { h.restore(); }
    const ok = writerHarness({ status: 'Received' });
    try {
      await run(S);
      assert.equal(ok.calls.writes.length, 1, `${name}: exactly one write on a Received row`);
    } finally { ok.restore(); }
  }
  // the pre-read also ties the row to the named case (a blank ref — legacy row — passes)
  for (const [name, run] of [['markReviewed', (s) => s.markReviewed('5007', '2026-X-001')], ['requestRework', (s) => s.requestRework('5007', 'Blurry', '2026-X-001')], ['reopenDoc', (s) => s.reopenDoc('5007', '2026-X-001')]]) {
    const other = writerHarness({ status: 'Received', rowCase: '2026-Y-999' });
    try {
      await assert.rejects(run(S), (e) => e.badRequest === true && /not on this case/.test(e.message), name);
      assert.deepEqual(other.calls.writes, []);
    } finally { other.restore(); }
    const blank = writerHarness({ status: 'Received', rowCase: '' });
    try { await run(S); assert.equal(blank.calls.writes.length, 1, `${name}: a blank ref passes`); } finally { blank.restore(); }
  }
  // a failed pre-read keeps today's behaviour (the writer proceeds)
  const restoreNa = naState();
  const restoreQ = stub(mondayApi, 'query', async (q) => { if (/items\(ids:/.test(q)) throw new Error('503'); return { change_multiple_column_values: { id: '1' } }; });
  try { await S.markReviewed('5008'); } finally { restoreQ(); restoreNa(); }
});

test('review page: a document NAME with quotes cannot break out of the button attributes (stored XSS) — names travel as data attributes', () => {
  const restore = naState();
  try {
    const items = [{ id: '9', name: `Spouse "passport" <b>x</b> ' onmouseover='alert(1)`, status: 'Missing', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: '', lastUpload: '' }];
    const html = svcForm().buildReviewPage({ caseRef: '2026-X-001', clientName: 'K', staffName: 'G', items, folderLinks: {} });
    for (const fn of ['openNaModal', 'openRework']) {
      const m = html.match(new RegExp(`<button[^>]*onclick="${fn}\\(this\\)"[^>]*>`));
      assert.ok(m, `${fn} takes the button, not an inline string`);
      assert.match(m[0], /data-name="Spouse &quot;passport&quot; &lt;b&gt;x&lt;\/b&gt; &#39; onmouseover=&#39;alert\(1\)"/, `${fn}: the name is entity-escaped inside the attribute`);
      assert.ok(!/onmouseover='alert/.test(m[0]), `${fn}: no raw quote reaches the markup`);
    }
    assert.ok(!html.includes(`openNaModal('9'`), 'no inline-string call form remains');
  } finally { restore(); }
});

test('documentFormService.getCaseDocuments: carries naReason from the recorded reason column (fresh load, fake board)', async () => {
  const restoreNa = naState();
  const set = (rel, exports) => { const p = require.resolve(rel); const prev = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports }; return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; }; };
  const asked = [];
  const undo = [
    set('../src/services/mondayApi', { query: async (q) => {
      if (q.includes('items_page_by_column_values')) {
        asked.push(q);
        return { items_page_by_column_values: { items: [{ id: '31', name: 'Marriage certificate', column_values: [
          { id: 'text_mm0zfsp1', text: 'code:X-001' }, { id: STATUS, text: 'Not Applicable' }, { id: REASON, text: 'client is single\n— Gauri, 2 Oct 2026 (Toronto)' } ] }] } };
      }
      return {};
    } }),
    set('../src/services/oneDriveService', {}), set('../src/services/caseReadinessService', { calculateForCaseRef: async () => {} }),
  ];
  const p = require.resolve('../src/services/documentFormService'); const prevMod = require.cache[p]; delete require.cache[p];
  try {
    const fresh = require(p);
    const docs = await fresh.getCaseDocuments('2026-X-001');
    assert.equal(docs.length, 1);
    assert.equal(docs[0].status, 'Not Applicable');
    assert.equal(docs[0].naReason, 'client is single\n— Gauri, 2 Oct 2026 (Toronto)');
    assert.ok(asked[0].includes(REASON), 'the reason column is asked for once it is recorded');
  } finally {
    delete require.cache[p]; if (prevMod) require.cache[p] = prevMod;
    undo.forEach((u) => u()); restoreNa();
  }
});

test('client upload routes refuse an N/A row server-side (409, one shared message) — hidden buttons are not the rule', () => {
  const portal = fs.readFileSync(require.resolve('../src/routes/clientPortal.js'), 'utf8');
  const legacy = fs.readFileSync(require.resolve('../src/routes/documentUploadForm.js'), 'utf8');
  assert.match(portal, /if \(item\.status === 'Not Applicable'\) return res\.status\(409\)\.json\(\{ success: false, error: docSvc\.NOT_APPLICABLE_UPLOAD_MESSAGE \}\);/);
  assert.ok(portal.indexOf("item.status === 'Not Applicable'") < portal.indexOf('docSvc.uploadFileToOneDrive('), 'portal: refused BEFORE the file is stored');
  assert.match(legacy, /else if \(row\.status === 'Not Applicable'\) return res\.status\(409\)\.json\(\{ success: false, error: NOT_APPLICABLE_UPLOAD_MESSAGE \}\);/);
  assert.match(legacy, /else if \(row\.caseRef && row\.caseRef !== caseRef\) return res\.status\(404\)/, 'legacy: a row naming another case is refused');
  assert.ok(legacy.indexOf("row.status === 'Not Applicable'") < legacy.indexOf('await uploadFileToOneDrive(itemId, caseRef'), 'legacy: refused BEFORE the file is stored');
  assert.match(legacy, /const row = await getDocumentRow\(itemId\);/, 'one row read, not a checklist scan');
  const { NOT_APPLICABLE_UPLOAD_MESSAGE } = require('../src/services/documentFormService');
  assert.match(NOT_APPLICABLE_UPLOAD_MESSAGE, /case officer confirmed this document is not needed/);
});

test('clearNotApplicable on a row that is not N/A: {already:true, status}, no write', async () => {
  const h = writerHarness({ status: 'Received' });
  try {
    assert.deepEqual(await svcForm().clearNotApplicable('5005', 'G', '2026-X-001'), { already: true, status: 'Received' });
    assert.deepEqual(h.calls.writes, []);
  } finally { h.restore(); }
});

/* ────────────────────── 6. the pages count and render alike ────────────────────── */

const DOCS = [
  { id: '11', name: 'Passport', status: 'Reviewed', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '2026-07-10' },
  { id: '12', name: 'Bank statement', status: 'Missing', category: 'Financial', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '' },
  { id: '13', name: 'Marriage certificate', status: 'Not Applicable', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '', naReason: 'client is single\n— Gauri, 2 Oct 2026 (Toronto)' },
];

test('cockpit summariseDocuments: counts.na, naReason on the row, and the page-level switch flag', () => {
  const { summariseDocuments } = require('../src/services/caseCockpitService');
  const restoreNa = naState();
  try {
    const out = summariseDocuments(DOCS);
    assert.deepEqual(out.counts, { total: 3, received: 0, reviewed: 1, rework: 0, missing: 1, na: 1 });
    const identity = out.byCategory.find((c) => c.category === 'Identity');
    const row = identity.items.find((i) => i.id === '13');
    assert.equal(row.naReason, 'client is single', 'reason line only — the cockpit script never splits');
    assert.equal(row.naBy, 'Gauri, 2 Oct 2026 (Toronto)');
    assert.equal(out.notApplicableEnabled, true);
  } finally { restoreNa(); }
  const restoreOff = naState({ on: false });
  try { assert.equal(summariseDocuments(DOCS).notApplicableEnabled, false); } finally { restoreOff(); }
});

test('client portal: N/A row reads "Not needed…", has no upload control, and is out of "X of Y"', () => {
  const { buildPortalPage, clientStage, toClientTimeline } = require('../src/services/clientPortalService');
  const html = buildPortalPage({
    clientName: 'Kamalpreet Singh', caseRef: '2026-SP-001', caseType: 'Study Permit', caseSubType: null,
    caseStage: 'Document Collection Started', accessToken: 'tok', qReadinessPct: 40, qCompletionStatus: '',
    docCounts: { total: 3, received: 0, reviewed: 1, rework: 0, missing: 1, na: 1 }, reworkDocs: [], totalMembers: 1, submittedMembers: 0,
    journey: clientStage('Document Collection Started'), timeline: toClientTimeline([]), payments: null, docItems: DOCS,
  });
  assert.ok(html.includes('Not needed for your application — confirmed by your case officer'));
  assert.equal((html.match(/data-item="/g) || []).length, 1, 'only the Missing row gets an upload input');
  assert.ok(!html.includes('data-item="13"'));
  assert.match(html, /1 of 2 documents? (received|uploaded)|1 \/ 2|1 of 2/, 'the N/A row is out of the denominator');
  assert.ok(html.includes('1 marked as not needed'));
  assert.ok(!html.includes('client is single'), 'the staff reason is never shown to the client');
});

test('client portal: a case whose only open rows are N/A emits no upload script (nothing to upload)', () => {
  const { buildPortalPage, clientStage, toClientTimeline } = require('../src/services/clientPortalService');
  const html = buildPortalPage({
    clientName: 'K', caseRef: '2026-SP-001', caseType: 'Study Permit', caseSubType: null, caseStage: 'Document Collection Started', accessToken: 'tok',
    qReadinessPct: 0, qCompletionStatus: '', docCounts: { total: 2, received: 0, reviewed: 1, rework: 0, missing: 0, na: 1 }, reworkDocs: [], totalMembers: 1, submittedMembers: 0,
    journey: clientStage('Document Collection Started'), timeline: toClientTimeline([]), payments: null, docItems: [DOCS[0], DOCS[2]],
  });
  assert.ok(!html.includes('<script>'));
});

test('legacy /documents page: N/A rows are greyed, read-only, and out of every count (page, step, category); the script still parses', () => {
  const { _formPage } = require('../src/routes/documentUploadForm');
  const members = [{ memberType: 'Principal Applicant', sections: [
    { category: 'Identity', items: [
      { id: '1', name: 'Passport', status: 'Received', documentName: 'Passport' },
      { id: '2', name: 'Marriage certificate', status: 'Not Applicable', documentName: 'Marriage certificate' } ] },
    { category: 'Financial', items: [ { id: '3', name: 'Bank statement', status: 'Missing', documentName: 'Bank statement' } ] },
  ] }];
  const html = _formPage('2026-TEST-001', 'Test Client', members, false, [], null);
  assert.match(html, /1 of 2 documents uploaded \(50%\)/, 'page total excludes the N/A row');
  assert.match(html, /let uploadedCount = 1;/); assert.match(html, /let totalCount\s+= 2;/);
  assert.match(html, /id="pmeta_0">1 of 1 uploaded</, 'Identity: 1 of 1 (not 1 of 2 or 2 of 2)');
  assert.match(html, /id="pmeta_1">0 of 1 uploaded</, 'Financial');
  assert.ok(html.includes('Confirmed by your case officer — nothing to upload'));
  assert.ok(html.includes('Not needed'));
  // the N/A row has no file input; the Missing + Received rows do
  const rows = html.split('<div class="doc-row');
  const naRow = rows.find((r) => r.includes('Marriage certificate'));
  assert.ok(naRow && !/type="file"/.test(naRow), 'no upload control on the N/A row');
  assert.ok(/type="file"/.test(rows.find((r) => r.includes('Bank statement'))));
  let n = 0;
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) { n++; assert.doesNotThrow(() => new Function(m[1])); }
  assert.ok(n >= 1);
  assert.match(html, /function applicableRows\(/, 'the live counters skip N/A rows too');
});

test('review page: "Doesn\'t apply" only on Missing/Received rows and only when ready; "Applies again" on N/A rows; the script parses', () => {
  const items = [
    { id: '1', name: 'Passport', status: 'Reviewed', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: '', lastUpload: '2026-07-10' },
    { id: '2', name: 'Bank statement', status: 'Missing', category: 'Financial', applicantType: 'Principal Applicant', reviewNotes: '', lastUpload: '' },
    { id: '3', name: 'Marriage certificate', status: 'Not Applicable', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: '', lastUpload: '', naReason: 'client is single\n— Gauri, 2 Oct 2026 (Toronto)' },
    { id: '4', name: 'Photo', status: 'Rework Required', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: 'blurry', lastUpload: '2026-07-11' },
  ];
  const build = () => svcForm().buildReviewPage({ caseRef: '2026-X-001', clientName: 'K', staffName: 'G', items, folderLinks: {} });
  const parse = (html) => { let n = 0; for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) { n++; assert.doesNotThrow(() => new Function(m[1])); } assert.ok(n >= 1); };
  let restore = naState();
  try {
    const html = build(); parse(html);
    const rowOf = (name) => html.split(/<tr\b|<div class="doc-row|<div class="row\b/).find((r) => r.includes(name)) || '';
    assert.match(rowOf('Bank statement'), /<button class="btn btn-na"\s+data-id="2" data-name="Bank statement" onclick="openNaModal\(this\)"/, 'Missing row offers Doesn\'t apply');
    const passBtn = rowOf('Passport').match(/<button[^>]*btn-na[^>]*>/);
    assert.ok(!passBtn || /\bdisabled\b/.test(passBtn[0]), 'Reviewed row: the N/A button is absent or disabled');
    const reworkBtn = rowOf('Photo').match(/<button[^>]*btn-na[^>]*>/);
    assert.ok(!reworkBtn || /\bdisabled\b/.test(reworkBtn[0]), 'Rework Required row: Undo first — the N/A button is absent or disabled');
    assert.match(rowOf('Marriage certificate'), /btn-applies/, 'N/A row offers Applies again');
    assert.match(rowOf('Marriage certificate'), /client is single/, 'staff see the reason');
    assert.ok(html.includes('id="na-modal"'));
    assert.ok(html.includes('"Not Applicable"') || html.includes("'Not Applicable'"));
  } finally { restore(); }
  restore = naState({ on: false });
  try {
    const html = build(); parse(html);
    const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
    assert.ok(!/openNaModal\(|appliesAgain\(/.test(markup) && !/class="btn btn-applies"/.test(markup), 'switch OFF: no N/A button in the markup');
    assert.ok(!html.includes('id="na-modal"'), 'switch OFF: no modal');
    const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
    assert.match(script, /if \(naModal\) naModal\.addEventListener\('click'/, 'backdrop closes the modal (guarded)');
    assert.match(script, /if \(naModal && !naSaving\(\)\) closeNaModal\(\)/, 'Esc closes it, but never mid-save');
    assert.ok(html.includes('Marriage certificate'), 'the N/A row is still shown');
  } finally { restore(); }
});

test('cockpit page: the emitted script knows both actions, asks for a reason, and parses', () => {
  const { buildCockpitHTML } = require('../src/routes/adminCase');
  const html = buildCockpitHTML('2026-X-001');
  let n = 0;
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) { n++; assert.doesNotThrow(() => new Function(m[1])); }
  assert.ok(n >= 1);
  assert.match(html, /data-doc-act="not_applicable"/);
  assert.match(html, /data-doc-act="applies_again"/);
  assert.match(html, /var NA_ENABLED = false;/);
  assert.match(html, /res\.status === 401\) \{[\s\S]*?Sign in with Monday<\/a>/, 'a 401 shows the server\'s words and the sign-in link');
  assert.match(html, /A reason is required\./);
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  const block = script.slice(script.indexOf('function renderDocRow'), script.indexOf('function renderDocCat'));
  assert.match(block, /Not applicable: /);
  assert.ok(!block.includes('\\') && !block.includes('`') && !block.includes('${'), 'renderDocRow stays inside the inline-JS rules (no backslash / backtick / ${)');
});

/* ───────────────── 7. seeder, label guard, and the two routes ───────────────── */

test('seeder: an N/A row is never pruned when the sub-type changes (the decision is the firm\'s record)', () => {
  const { selectStaleRows } = require('../src/services/executionSeederService');
  const rows = [
    { id: 'a', subType: 'CEC Single Applicant', status: 'Not Applicable', uniqueKey: '2026-X-a', templateRel: '' },
    { id: 'b', subType: 'CEC Single Applicant', status: 'Missing',        uniqueKey: '2026-X-b', templateRel: '' },
  ];
  assert.deepEqual(selectStaleRows(rows, 'CEC Family').map((r) => r.id), ['b']);
});

test('no code path auto-creates labels on the Documents board (the label is added once, by the script, outside slot 5)', () => {
  for (const f of ['documentReviewFormService', 'documentReviewService', 'documentFormService', 'executionSeederService', 'caseReadinessService']) {
    const src = fs.readFileSync(require.resolve(`../src/services/${f}.js`), 'utf8');
    assert.ok(!/create_labels_if_missing/.test(src), `${f} never uses create_labels_if_missing`);
  }
  const script = fs.readFileSync(require.resolve('../scripts/add-doc-not-applicable.js'), 'utf8');
  assert.match(script, /=== '5'\) throw new Error/, 'the script refuses the label in slot 5');
  assert.ok(!/create_labels_if_missing/.test(script));
  assert.doesNotMatch(script, /change_column_value\(|change_multiple_column_values|create_item|change_column_metadata\(/, 'the script writes no row and never pretends the API can add a label');
  assert.match(script, /Add it by hand first[\s\S]*?process\.exit\(1\)/, 'a missing label stops the script with the manual instruction');
  assert.equal((script.match(/writeFileSync/g) || []).length, 1);
  assert.match(script, /if \(WRITE\) \{ cfg\.boardId = BOARD_ID; fs\.writeFileSync/, 'the dry-run never writes the config file');
});

test('routes: the cockpit route needs a Monday sign-in for the two N/A actions; the shared-key /api route refuses them', () => {
  const SRC = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const i = SRC.indexOf("app.post('/admin/case-action/:caseRef/document/:itemId/status'");
  assert.ok(i !== -1);
  const body = SRC.slice(i, SRC.indexOf('\n});', i));
  assert.match(body, /const ACTIONS = \['reviewed', 'rework', 'not_applicable', 'applies_again'\]/);
  assert.match(body, /if \(action === 'not_applicable' \|\| action === 'applies_again'\) \{[\s\S]*?tryStaffAuth\(req\)[\s\S]*?status\(401\)/, 'Monday identity required');
  assert.match(body, /isReady\(\)\) return res\.status\(400\)/, 'switch checked');
  assert.match(body, /actorFromStaff\(staff\)\.name/, 'the recorded name is the Monday identity, never typed');
  assert.match(body, /markNotApplicable\(itemId, reason, actor, caseRef\)/);
  assert.match(body, /clearNotApplicable\(itemId, actor, caseRef\)/);
  assert.match(body, /err\.badRequest\) return res\.status\(400\)/);
  const k = SRC.indexOf("app.get('/admin/case-data/:caseRef'");
  const data = SRC.slice(k, SRC.indexOf('\n});', k));
  assert.match(data, /overview\.documents\.notApplicableEnabled = !!\(overview\.documents\.notApplicableEnabled && staff && \(staff\.name \|\| staff\.email\)\)/, 'the buttons show only to a Monday-signed-in staffer');
  const j = SRC.indexOf("app.post('/api/case/:caseRef/document/:itemId/status'");
  const api = SRC.slice(j, SRC.indexOf('\n});', j));
  assert.match(api, /action !== 'reviewed' && action !== 'rework'/, 'the shared-key route still takes only the two old actions');
  assert.ok(!/not_applicable/.test(api));
  assert.match(api, /if \(err\.badRequest\) return res\.status\(400\)/, 'an N/A row refused by the writer is a 400, not a 500');
  assert.match(api, /markReviewed\(itemId, caseRef\)/);
  // the /d review route: switch + reason checked before any Monday call; the staff name comes from the session
  const R = fs.readFileSync(require.resolve('../src/routes/documentReviewForm.js'), 'utf8');
  assert.match(R, /isReady\(\)\) \{\s*return res\.status\(400\)/);
  assert.match(R, /action === 'not_applicable' && !\(typeof reason === 'string' && reason\.trim\(\)\)/);
  assert.match(R, /markNotApplicable\(itemId, reason, staffName, caseRef\)/);
});

test('documentFormService reads the reason column only once it is recorded', () => {
  const src = fs.readFileSync(require.resolve('../src/services/documentFormService.js'), 'utf8');
  assert.match(src, /reasonColumnId\(\)/);
  assert.match(src, /naReason/);
});


test('documentFormService.getDocumentRow: status + case ref from one read; found:false on an empty read', async () => {
  const { getDocumentRow } = require('../src/services/documentFormService');
  let restore = stub(mondayApi, 'query', async (q, v) => {
    assert.match(q, /items\(ids: \$ids, limit: 1\)/); assert.deepEqual(v, { ids: ['42'] });
    return { items: [{ column_values: [{ id: STATUS, text: 'Not Applicable' }, { id: REF, text: '2026-X-001' }] }] };
  });
  try { assert.deepEqual(await getDocumentRow(42), { found: true, status: 'Not Applicable', caseRef: '2026-X-001' }); } finally { restore(); }
  restore = stub(mondayApi, 'query', async () => ({ items: [] }));
  try { assert.deepEqual(await getDocumentRow('42'), { found: false, status: '', caseRef: '' }); } finally { restore(); }
  restore = stub(mondayApi, 'query', async () => ({ items: [{ column_values: [{ id: STATUS, text: '' }, { id: REF, text: '' }] }] }));
  try { assert.deepEqual(await getDocumentRow('42'), { found: true, status: 'Missing', caseRef: '' }, 'a blank status reads Missing'); } finally { restore(); }
});
