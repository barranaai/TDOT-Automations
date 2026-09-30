'use strict';

// A Review Note typed on a Reviewed / Received / Under Review document reopens
// it for a new copy (REVIEW_NOTE_REOPENS, OFF until "1"/"true"). The notes
// handler writes ONE column (status → Rework Required) and stops; the status
// event that write fires is the only owner of the rework side effects (count,
// escalation, client email, rework notes). OFF is today's handler exactly.

const test   = require('node:test');
const assert = require('node:assert/strict');

// Fakes go into require.cache BEFORE the service loads: it requires mondayApi
// and revisionNotificationService at load, and the real queue module reads
// .queue/ then. Both fakes THROW so any call that bypasses the io seam fails loudly.
const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
set('../src/services/mondayApi', { query: async () => { throw new Error('direct mondayApi call — Monday must go through io.query'); } });
set('../src/services/revisionNotificationService', { queueItem: () => { throw new Error('direct queueItem call — must go through io.queueItem'); } });

const svc = require('../src/services/documentReviewService');
const { clientMasterBoardId, executionBoardId } = require('../config/monday');

const EXEC_BOARD = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const CM_BOARD   = String(clientMasterBoardId);
const STATUS = 'color_mm0zwgvr', NOTES = 'long_text_mm0zbpr', REF = 'text_mm0z2cck', COUNT = 'numeric_mm0zwf95';
const REVIEW_DATE = 'date_mm0z7vfg', REVIEW_REQ = 'color_mm0z796e', ESCALATION = 'color_mm0zthce';
const ITEM = '11', CASE = '2026-CEC-EE-065';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

/**
 * One fake row behind io.query. A status write lands on the row (so a later
 * read sees it) but NO webhook is simulated — the test replays the status
 * event itself when it wants to, exactly as Monday would.
 */
function harness(opts = {}) {
  const { status = 'Reviewed', notes = 'Blurry scan', caseRef = CASE, count = '1', name = 'Passport',
          reopenFails = false, noteFails = false } = opts;
  // `switch: undefined` means "env var unset" — a destructuring default would turn it into ON.
  const sw    = 'switch' in opts ? opts.switch : '1';
  const row   = { name, cols: { [STATUS]: status, [NOTES]: notes, [REF]: caseRef, [COUNT]: count } };
  const calls = { writes: [], notes: [], queued: [], recalcs: [], reads: 0 };
  const real  = { ...svc.io };
  const savedEnv = process.env.REVIEW_NOTE_REOPENS;
  Object.assign(svc.io, {
    query: async (q, v) => {
      if (/change_multiple_column_values/.test(q)) {
        const cols = JSON.parse(v.colValues);
        const onlyStatus = Object.keys(cols).length === 1 && !!cols[STATUS];
        if (reopenFails && onlyStatus) throw new Error('503 from Monday');
        calls.writes.push({ boardId: String(v.boardId), itemId: String(v.itemId), cols });
        if (String(v.boardId) === EXEC_BOARD && cols[STATUS]) row.cols[STATUS] = cols[STATUS].label;
        return { change_multiple_column_values: { id: String(v.itemId) } };
      }
      if (/create_update/.test(q)) {
        if (noteFails) throw new Error('note 429');
        calls.notes.push({ itemId: String(v.itemId), body: v.body });
        return { create_update: { id: 'u1' } };
      }
      if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: [{ id: 'CM1' }] } };
      if (/items\(ids:/.test(q)) {
        calls.reads++;
        const ids = [...q.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
        return { items: [{ name: row.name, column_values: ids.map((id) => ({ id, text: row.cols[id] ?? '' })) }] };
      }
      throw new Error('unexpected query: ' + q.slice(0, 80));
    },
    queueItem: (...a) => { calls.queued.push(a); },
    recalc:    async (ref) => { calls.recalcs.push(ref); },
    now:       () => new Date('2026-09-30T18:32:00Z'),
  });
  if (sw === undefined) delete process.env.REVIEW_NOTE_REOPENS; else process.env.REVIEW_NOTE_REOPENS = sw;
  const restore = () => {
    Object.assign(svc.io, real);
    if (savedEnv === undefined) delete process.env.REVIEW_NOTE_REOPENS; else process.env.REVIEW_NOTE_REOPENS = savedEnv;
  };
  return { row, calls, restore };
}

const notesEvent  = (text, prev) => ({ itemId: ITEM, columnId: NOTES, value: { text }, previousValue: prev === undefined ? null : { text: prev } });
const statusEvent = (label, prev) => ({ itemId: ITEM, columnId: STATUS, value: { label: { text: label } },
  previousValue: prev === undefined ? undefined : { label: { text: prev } } });

const statusWrites = (calls) => calls.writes.filter((w) => w.boardId === EXEC_BOARD && w.cols[STATUS]);
const countWrites  = (calls) => calls.writes.filter((w) => w.cols[COUNT] !== undefined);
const cmWrites     = (calls) => calls.writes.filter((w) => w.boardId === CM_BOARD);
const REOPEN_WRITE = { boardId: EXEC_BOARD, itemId: ITEM, cols: { [STATUS]: { label: 'Rework Required' } } };
const TODAYS_QUEUE = [CASE, 'Passport', 'Blurry scan', 'document', ITEM];   // the row id: the batch dedups per ROW, not per name
const TODAYS_CM    = { boardId: CM_BOARD, itemId: 'CM1', cols: { color_mm0x7bje: { label: 'Yes' }, text_mm0xvpr9: `Document rework required — Passport (${CASE})` } };

// Today's notes path: nothing on the row, one queued email, one CM escalation, no notes.
function assertTodaysPath(calls) {
  assert.deepEqual(statusWrites(calls), [], 'no status write');
  assert.deepEqual(countWrites(calls), [], 'no count write');
  assert.deepEqual(calls.queued, [TODAYS_QUEUE], 'one queued client email');
  assert.deepEqual(cmWrites(calls), [TODAYS_CM], 'one CM escalation');
  assert.deepEqual(calls.notes, [], 'no notes posted');
  assert.deepEqual(calls.recalcs, [], 'the notes handler never recalculates — the status event does');
}

/* ───────────────────────── (32) the pure predicate ───────────────────────── */

test('decideReviewNote: every status × switch × same-text (reopen decided before the same-text comparison)', () => {
  const D = svc.decideReviewNote;
  const base = { notes: 'Blurry', previousNotes: null, caseRef: CASE, enabled: true };
  const STATUSES = ['Reviewed', 'Received', 'Under Review', 'Rework Required', 'Missing', ''];

  // switch ON, a new text
  const fresh = { Reviewed: 'reopen', Received: 'reopen', 'Under Review': 'reopen', 'Rework Required': 'notify', Missing: 'notify', '': 'notify' };
  for (const s of STATUSES) assert.equal(D({ ...base, status: s }), fresh[s], `ON, new text, status "${s}"`);

  // switch ON, the same text saved again (whitespace ignored): only Rework Required is a no-op
  const same = { Reviewed: 'reopen', Received: 'reopen', 'Under Review': 'reopen', 'Rework Required': 'ignore', Missing: 'notify', '': 'notify' };
  for (const s of STATUSES) assert.equal(D({ ...base, previousNotes: ' Blurry ', status: s }), same[s], `ON, same text, status "${s}"`);

  // switch OFF: today's path for everything — never a reopen, never a same-text ignore
  for (const s of STATUSES) {
    assert.equal(D({ ...base, enabled: false, status: s }), 'notify', `OFF, status "${s}"`);
    assert.equal(D({ ...base, enabled: false, previousNotes: 'Blurry', status: s }), 'notify', `OFF, same text, status "${s}"`);
  }

  // nothing to say, switch or not
  assert.equal(D({ ...base, notes: '' }), 'ignore');
  assert.equal(D({ ...base, caseRef: '' }), 'ignore');
  assert.equal(D({ ...base, notes: '', enabled: false }), 'ignore');
  assert.equal(D({ ...base, notes: '', status: 'Rework Required' }), 'ignore');

  // no previousValue from Monday never blocks; a different previous text is a new note
  assert.equal(D({ ...base, previousNotes: undefined, status: 'Rework Required' }), 'notify');
  assert.equal(D({ ...base, previousNotes: 'Old', status: 'Rework Required' }), 'notify');
});

/* ─────────────────── (33)(34) the reopen: one column, nothing else ─────────────────── */

for (const status of ['Reviewed', 'Received', 'Under Review']) {
  test(`note on a ${status} row, switch ON → exactly one status write (Rework Required), zero queue, zero CM, zero notes`, async () => {
    const h = harness({ status });
    try {
      await svc.onColumnChange(notesEvent('Blurry scan', null));
      await flush();
      assert.deepEqual(h.calls.writes, [REOPEN_WRITE], 'the one and only write');
      assert.deepEqual(h.calls.queued, [], 'the reopen path queues nothing — the status event emails');
      assert.deepEqual(cmWrites(h.calls), [], 'no CM escalation from the notes handler');
      assert.deepEqual(h.calls.notes, [], 'no notes from the notes handler');
      assert.deepEqual(h.calls.recalcs, [], 'no recalc from the notes handler');
      assert.equal(h.calls.reads, 1, 'one row read');
      assert.equal(h.row.cols[STATUS], 'Rework Required');
    } finally { h.restore(); }
  });
}

test('switch value "true" also reopens; "0", "off", "yes" and unset do not', async () => {
  for (const [sw, reopens] of [['true', true], ['TRUE', true], ['1', true], ['0', false], ['off', false], ['yes', false], [undefined, false]]) {
    const h = harness({ status: 'Reviewed', switch: sw });
    try {
      await svc.onColumnChange(notesEvent('Blurry scan', null));
      assert.equal(statusWrites(h.calls).length, reopens ? 1 : 0, `REVIEW_NOTE_REOPENS=${sw}`);
    } finally { h.restore(); }
  }
});

/* ─────────────── (35)(36) statuses that are never reopened: today's path ─────────────── */

for (const status of ['Rework Required', 'Missing', '']) {
  test(`note on a "${status || 'blank'}" row, switch ON → no status write; today's queue + CM escalation`, async () => {
    const h = harness({ status });
    try {
      await svc.onColumnChange(notesEvent('Blurry scan', 'Older note'));
      await flush();
      assertTodaysPath(h.calls);
    } finally { h.restore(); }
  });
}

/* ───────────────────────── (37) switch OFF = today ───────────────────────── */

test('switch OFF (unset or "0"): a note on a Reviewed row does exactly what it does today', async () => {
  for (const sw of [undefined, '0']) {
    const h = harness({ status: 'Reviewed', switch: sw });
    try {
      await svc.onColumnChange(notesEvent('Blurry scan', null));
      await flush();
      assertTodaysPath(h.calls);
      assert.equal(h.row.cols[STATUS], 'Reviewed', 'the row is left as it was');
    } finally { h.restore(); }
  }
});

/* ───────────────────── (38) the reopen write fails ───────────────────── */

test('reopen write throws → today\'s path (the client still hears) plus one plain-word "Could not reopen" note', async () => {
  const h = harness({ status: 'Reviewed', reopenFails: true });
  try {
    await svc.onColumnChange(notesEvent('Blurry scan', null));
    await flush();
    assert.deepEqual(statusWrites(h.calls), [], 'the failed write is not recorded');
    assert.deepEqual(countWrites(h.calls), []);
    assert.deepEqual(h.calls.queued, [TODAYS_QUEUE]);
    assert.deepEqual(cmWrites(h.calls), [TODAYS_CM]);
    assert.equal(h.calls.notes.length, 1);
    const { itemId, body } = h.calls.notes[0];
    assert.equal(itemId, ITEM);
    assert.match(body, /^⚠️ Could not reopen this document for a new copy\n\nDocument: Passport\nCase: 2026-CEC-EE-065\n\n/);
    assert.match(body, /typed while this document was Reviewed/);
    assert.match(body, /could not be set to Rework Required \(503 from Monday\)/);
    assert.match(body, /Please press Request Rework on the review page: https?:\/\/\S+\/d\/2026-CEC-EE-065\/review$/);
    assert.ok(!/Document Uploaded by Client/.test(body), 'the refile/audit parsers must ignore this note');
    assert.equal(h.row.cols[STATUS], 'Reviewed');
  } finally { h.restore(); }
});

test('reopen write AND the fallback note both fail → the client email is still queued and the escalation still raised', async () => {
  const h = harness({ status: 'Received', reopenFails: true, noteFails: true });
  try {
    await svc.onColumnChange(notesEvent('Blurry scan', null));
    await flush();
    assert.deepEqual(h.calls.queued, [TODAYS_QUEUE]);
    assert.deepEqual(cmWrites(h.calls), [TODAYS_CM]);
    assert.deepEqual(h.calls.notes, []);
  } finally { h.restore(); }
});

/* ───────────────────────── (39) same-text re-save ───────────────────────── */

test('same text saved again on a Rework Required row → nothing at all (today this re-emails)', async () => {
  const h = harness({ status: 'Rework Required', notes: 'Blurry scan' });
  try {
    await svc.onColumnChange(notesEvent('Blurry scan', '  Blurry scan '));
    await flush();
    assert.deepEqual(h.calls.writes, []);
    assert.deepEqual(h.calls.queued, []);
    assert.deepEqual(h.calls.notes, []);
    assert.equal(h.calls.reads, 1, 'one read, then nothing');
  } finally { h.restore(); }
});

test('same text saved again on a Reviewed row still reopens it (a document reviewed again can be sent back again)', async () => {
  const h = harness({ status: 'Reviewed', notes: 'Blurry scan' });
  try {
    await svc.onColumnChange(notesEvent('Blurry scan', 'Blurry scan'));
    assert.deepEqual(h.calls.writes, [REOPEN_WRITE]);
    assert.deepEqual(h.calls.queued, []);
  } finally { h.restore(); }
});

test('same text saved again on a Rework Required row with the switch OFF → today\'s re-email (the guard lives under the switch)', async () => {
  const h = harness({ status: 'Rework Required', notes: 'Blurry scan', switch: undefined });
  try {
    await svc.onColumnChange(notesEvent('Blurry scan', 'Blurry scan'));
    await flush();
    assertTodaysPath(h.calls);
  } finally { h.restore(); }
});

/* ───────────────────────── (40) nothing to act on ───────────────────────── */

test('empty notes in the event → no read; blank column or no case ref → no action, switch on or off', async () => {
  for (const sw of ['1', undefined]) {
    let h = harness({ status: 'Reviewed', switch: sw });
    try {
      await svc.onColumnChange(notesEvent('', null));
      assert.equal(h.calls.reads, 0, 'an emptied note is not read');
      assert.deepEqual(h.calls.writes, []);
    } finally { h.restore(); }

    h = harness({ status: 'Reviewed', notes: '', switch: sw });
    try {
      await svc.onColumnChange(notesEvent('typed', null));   // the column reads blank (cleared before we read it)
      assert.deepEqual(h.calls.writes, []);
      assert.deepEqual(h.calls.queued, []);
    } finally { h.restore(); }

    h = harness({ status: 'Reviewed', caseRef: '', switch: sw });
    try {
      await svc.onColumnChange(notesEvent('typed', null));
      assert.deepEqual(h.calls.writes, []);
      assert.deepEqual(h.calls.queued, []);
      assert.deepEqual(h.calls.notes, []);
    } finally { h.restore(); }
  }
});

test('a column that is neither notes nor status is ignored', async () => {
  const h = harness({});
  try {
    await svc.onColumnChange({ itemId: ITEM, columnId: 'text_mm261tka', value: { text: 'Identity' }, previousValue: null });
    await flush();
    assert.equal(h.calls.reads, 0);
    assert.deepEqual(h.calls.recalcs, []);
  } finally { h.restore(); }
});

/* ───────────── (41) the status event owns the side effects; same-label guard ───────────── */

const REWORK_SIDE_EFFECT = { boardId: EXEC_BOARD, itemId: ITEM, cols: { [ESCALATION]: { label: 'Triggered by Rework' }, [COUNT]: 2 } };

test('status → Rework Required from Reviewed: count +1, one queued email, one CM escalation, rework notes, one recalc', async () => {
  const h = harness({ status: 'Rework Required' });
  try {
    await svc.onColumnChange(statusEvent('Rework Required', 'Reviewed'));
    await flush();
    assert.deepEqual(countWrites(h.calls), [REWORK_SIDE_EFFECT]);
    assert.deepEqual(h.calls.queued, [TODAYS_QUEUE]);
    assert.deepEqual(cmWrites(h.calls), [TODAYS_CM]);
    assert.deepEqual(statusWrites(h.calls), [], 'the status handler never writes the status');
    assert.equal(h.calls.notes.length, 2, 'exec row note + Client Master note');
    assert.match(h.calls.notes[0].body, /^🔄 Rework Requested by Staff\n\nDocument: Passport\nCase: 2026-CEC-EE-065\n/);
    assert.match(h.calls.notes[0].body, /Rework count: 2/);
    assert.match(h.calls.notes[0].body, /📝 Notes for client:\nBlurry scan/);
    assert.equal(h.calls.notes[1].itemId, 'CM1');
    assert.deepEqual(h.calls.recalcs, [CASE]);
  } finally { h.restore(); }
});

test('status Rework Required re-saved as Rework Required, switch ON → no count, no queue, no notes; recalc still runs', async () => {
  const h = harness({ status: 'Rework Required' });
  try {
    await svc.onColumnChange(statusEvent('Rework Required', 'Rework Required'));
    await flush();
    assert.deepEqual(h.calls.writes, []);
    assert.deepEqual(h.calls.queued, []);
    assert.deepEqual(h.calls.notes, []);
    assert.deepEqual(h.calls.recalcs, [CASE]);
  } finally { h.restore(); }
});

test('status Rework Required without a previousValue → fails open: count write as today', async () => {
  const h = harness({ status: 'Rework Required' });
  try {
    await svc.onColumnChange(statusEvent('Rework Required', undefined));
    await flush();
    assert.deepEqual(countWrites(h.calls), [REWORK_SIDE_EFFECT]);
    assert.deepEqual(h.calls.queued, [TODAYS_QUEUE]);
  } finally { h.restore(); }
});

test('status Rework Required re-saved unchanged, switch OFF → count write as today (the guard is under the switch)', async () => {
  const h = harness({ status: 'Rework Required', switch: undefined });
  try {
    await svc.onColumnChange(statusEvent('Rework Required', 'Rework Required'));
    await flush();
    assert.deepEqual(countWrites(h.calls), [REWORK_SIDE_EFFECT]);
    assert.deepEqual(h.calls.queued, [TODAYS_QUEUE]);
    assert.deepEqual(h.calls.recalcs, [CASE]);
  } finally { h.restore(); }
});

/* ───────────────────────── (42) Reviewed same-label ───────────────────────── */

test('status → Reviewed from Received writes the review date + Review Required=No; Reviewed re-saved unchanged (switch ON) writes nothing', async () => {
  let h = harness({ status: 'Reviewed' });
  try {
    await svc.onColumnChange(statusEvent('Reviewed', 'Received'));
    await flush();
    assert.deepEqual(h.calls.writes, [{ boardId: EXEC_BOARD, itemId: ITEM, cols: { [REVIEW_DATE]: { date: '2026-09-30' }, [REVIEW_REQ]: { label: 'No' } } }]);
    assert.deepEqual(h.calls.recalcs, [CASE]);
  } finally { h.restore(); }

  h = harness({ status: 'Reviewed' });
  try {
    await svc.onColumnChange(statusEvent('Reviewed', 'Reviewed'));
    await flush();
    assert.deepEqual(h.calls.writes, [], 'no review-date write');
    assert.deepEqual(h.calls.recalcs, [CASE], 'readiness still recalculated');
  } finally { h.restore(); }

  h = harness({ status: 'Reviewed', switch: undefined });
  try {
    await svc.onColumnChange(statusEvent('Reviewed', 'Reviewed'));
    assert.equal(h.calls.writes.length, 1, 'switch OFF: today\'s write');
  } finally { h.restore(); }
});

test('status → Received: no side effects here beyond the recalc (the upload path and the reviewer ping own it)', async () => {
  const h = harness({ status: 'Received' });
  try {
    await svc.onColumnChange(statusEvent('Received', 'Rework Required'));
    await flush();
    assert.deepEqual(h.calls.writes, []);
    assert.deepEqual(h.calls.queued, []);
    assert.deepEqual(h.calls.recalcs, [CASE]);
  } finally { h.restore(); }
});

/* ───────────── (4f) the whole chain in one process: net effect = one Request Rework ───────────── */

test('note on Reviewed → reopen write → the status event Monday sends → count +1 once, one email, one CM escalation, one rework note; a late duplicate notes event adds no status write', async () => {
  const h = harness({ status: 'Reviewed', count: '0' });
  try {
    await svc.onColumnChange(notesEvent('Blurry scan', null));
    assert.deepEqual(h.calls.writes, [REOPEN_WRITE]);
    // Monday now sends the status event for the write we just made
    await svc.onColumnChange(statusEvent('Rework Required', 'Reviewed'));
    await flush();
    assert.equal(statusWrites(h.calls).length, 1, 'still the one reopen write');
    assert.deepEqual(countWrites(h.calls).map((w) => w.cols[COUNT]), [1]);
    assert.deepEqual(h.calls.queued, [TODAYS_QUEUE]);
    assert.deepEqual(cmWrites(h.calls), [TODAYS_CM]);
    assert.equal(h.calls.notes.filter((n) => /Rework Requested by Staff/.test(n.body)).length, 1);
    assert.deepEqual(h.calls.recalcs, [CASE]);
    // a duplicate / late notes event after the flip: the row reads Rework Required → today's path, deduped by name in the batch
    await svc.onColumnChange(notesEvent('Blurry scan', null));
    await flush();
    assert.equal(statusWrites(h.calls).length, 1, 'no second status write');
    assert.equal(countWrites(h.calls).length, 1, 'the count never moves from the notes handler');
    assert.equal(new Set(h.calls.queued.map((q) => q[1])).size, 1, 'one queued name');
  } finally { h.restore(); }
});

test('two racing reopen writes: the second status event carries previousValue Rework Required and is skipped', async () => {
  const h = harness({ status: 'Reviewed', count: '0' });
  try {
    await svc.onColumnChange(statusEvent('Rework Required', 'Reviewed'));
    await svc.onColumnChange(statusEvent('Rework Required', 'Rework Required'));
    await flush();
    assert.equal(countWrites(h.calls).length, 1);
    assert.equal(h.calls.queued.length, 1);
    assert.equal(cmWrites(h.calls).length, 1);
    assert.deepEqual(h.calls.recalcs, [CASE, CASE], 'both events recalculate');
  } finally { h.restore(); }
});

/* ───────────── (44) the /d + cockpit "Request Rework" button: notes + status in ONE mutation ───────────── */

for (const order of ['notes then status', 'status then notes']) {
  test(`Request Rework button replayed as two events (${order}), switch ON → one count write, one queued name, zero extra status writes`, async () => {
    // requestRework writes both columns in one mutation; by the time either
    // event reads the row, both are committed: the row reads Rework Required.
    const h = harness({ status: 'Rework Required', notes: 'Blurry scan', count: '1' });
    try {
      const events = [notesEvent('Blurry scan', null), statusEvent('Rework Required', 'Reviewed')];
      if (order === 'status then notes') events.reverse();
      for (const e of events) await svc.onColumnChange(e);
      await flush();
      assert.deepEqual(countWrites(h.calls), [REWORK_SIDE_EFFECT]);
      assert.equal(new Set(h.calls.queued.map((q) => q[1])).size, 1, 'one queued name (the batch dedups by name)');
      assert.deepEqual(statusWrites(h.calls), [], 'no extra status write — the row is already Rework Required');
      assert.equal(h.calls.notes.filter((n) => /Rework Requested by Staff/.test(n.body)).length, 1);
      assert.deepEqual(h.calls.recalcs, [CASE]);
    } finally { h.restore(); }
  });
}

/* ───────────────────────── (43) webhook wiring ───────────────────────── */

test('webhook: previousValue reaches onColumnChange; Received still pings the reviewer; Rework Required pings only when it is a change (fails open)', async () => {
  const router = require('../src/routes/mondayWebhook');
  const notify = require('../src/services/mondayNotificationService');
  const layer  = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const got = { onColumnChange: [], received: [], rework: [] };
  const stub = (obj, key, fn) => { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; };
  const restore = [
    stub(svc, 'onColumnChange', async (args) => { got.onColumnChange.push(args); }),
    stub(notify, 'onDocumentReceived', async (...a) => { got.received.push(a); }),
    stub(notify, 'onDocumentReworkRequired', async (...a) => { got.rework.push(a); }),
  ];
  const res = { json: () => {}, status: () => ({ json: () => {} }) };
  const send = (event) => handle({ body: { event: { type: 'update_column_value', boardId: String(executionBoardId), pulseId: 11, pulseName: 'Passport', ...event } } }, res);
  try {
    await send({ columnId: NOTES, value: { text: 'Blurry scan' }, previousValue: { text: 'Older note' } });
    await send({ columnId: STATUS, value: { label: { text: 'Received' } }, previousValue: { label: { text: 'Rework Required' } } });
    await send({ columnId: STATUS, value: { label: { text: 'Rework Required' } }, previousValue: { label: { text: 'Reviewed' } } });
    await send({ columnId: STATUS, value: { label: { text: 'Rework Required' } }, previousValue: { label: { text: 'Rework Required' } } });
    await send({ columnId: STATUS, value: { label: { text: 'Rework Required' } } });
    await flush();

    assert.equal(got.onColumnChange.length, 5, 'every exec-board column event reaches the service');
    assert.deepEqual(got.onColumnChange[0], { itemId: 11, columnId: NOTES, value: { text: 'Blurry scan' }, previousValue: { text: 'Older note' } });
    assert.deepEqual(got.onColumnChange[3].previousValue, { label: { text: 'Rework Required' } });
    assert.equal(got.onColumnChange[4].previousValue, undefined);

    assert.deepEqual(got.received, [[11, 'Passport']], 'Received pings the reviewer as before');
    assert.equal(got.rework.length, 2, 'a real change and the no-previousValue event ping; the unchanged re-save does not');
  } finally { restore.reverse().forEach((x) => x()); }
});

/* ───────────────────────── seam pin ───────────────────────── */

test('seam pin: Monday, the email queue and the recalc are reached only through io', () => {
  const fs  = require('fs');
  const src = fs.readFileSync(require.resolve('../src/services/documentReviewService'), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const direct = body.match(/mondayApi\.query\(/g) || [];
  assert.equal(direct.length, 1, 'mondayApi.query appears once: inside io');
  assert.equal((body.match(/revisionNotificationService\.queueItem\(/g) || []).length, 1, 'queueItem appears once: inside io');
  assert.equal((body.match(/calculateForCaseRef\(/g) || []).length, 1, 'the recalc appears once: inside io');
  // 4e: the notes handler never calls onReworkRequired itself — the reopen write's own status event does
  assert.equal((body.match(/await onReworkRequired\(/g) || []).length, 1, 'onReworkRequired is called from the status branch only');
  const notesHandler = body.slice(body.indexOf('async function onReviewNotesSet'), body.indexOf('async function onColumnChange'));
  assert.ok(!/onReworkRequired\(/.test(notesHandler), 'never from onReviewNotesSet');
  assert.deepEqual(Object.keys(svc.io).sort(), ['isReopenEnabled', 'now', 'query', 'queueItem', 'recalc']);
  assert.equal(typeof svc.decideReviewNote, 'function');
  assert.ok(!/notify client \+ set Rework Required status/.test(src), 'the false comment about a status write is gone');
});
