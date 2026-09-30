'use strict';

// The file reached OneDrive but Monday refused the status write. The client
// was told "saved — do not send it again", so the row must be marked without
// them: three in-process attempts at +1, +5 and +15 minutes, one job per row.
// Each attempt: post every upload note that never landed (the file's record)
// → stop if staff changed the status OR the Review Notes after the write was
// ATTEMPTED → write the status → recovery note.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
set('../src/services/mondayApi', { query: async () => { throw new Error('the real mondayApi must not be reached — the seam is io.query'); } });
set('../src/services/oneDriveService', {});
set('../src/services/caseReadinessService', { calculateForCaseRef: async () => {} });
const svc = require('../src/services/documentFormService');

const T0 = '2026-09-30T18:32:10.000Z';
const NOTE = '📄 Document Uploaded by Client\n\nDocument: Passport\nFile: Passport – PA – 2026-09-30 14-32 – passport.pdf\nCategory: Identity\nCase: 2026-CEC-EE-065 (Jane)\n…';

/**
 * Drive the service with a fake clock and fake timers. `hooks` shape the fake
 * Monday: statusChangedAt (ISO or ''), noteFails (count), statusFails (count),
 * readFails (count).
 */
function withFake(hooks, fn) {
  const real = { ...svc.io };
  svc._resetForTests();
  const timers = [];                       // { fn, ms, fired }
  const calls  = [];                       // [kind, ...]
  const h = { noteFails: 0, statusFails: 0, readFails: 0, statusChangedAt: '', notesChangedAt: '', ...hooks };
  let nowMs = Date.parse(h.startAt || T0);
  Object.assign(svc.io, {
    now:        () => new Date(nowMs),
    setTimer:   (f, ms) => { const t = { fn: f, ms, fired: false, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    query: async (q, vars) => {
      if (q.includes('column_values(ids: ["color_mm0zwgvr", "long_text_mm0zbpr"]) { id value }')) {
        calls.push(['readStatus', vars.ids[0]]);
        if (h.readFails > 0) { h.readFails--; throw new Error('read 500'); }
        return { items: [{ column_values: [
          { id: 'color_mm0zwgvr', value: h.statusChangedAt === null ? null : JSON.stringify({ index: 1, changed_at: h.statusChangedAt }) },
          { id: 'long_text_mm0zbpr', value: h.notesChangedAt ? JSON.stringify({ text: 'n', changed_at: h.notesChangedAt }) : null },
        ] }] };
      }
      if (q.includes('create_update')) {
        calls.push(['note', vars.itemId, vars.body]);
        if (h.noteFails > 0) { h.noteFails--; throw new Error('note 500'); }
        return {};
      }
      if (q.includes('change_multiple_column_values')) {
        calls.push(['status', vars.itemId, JSON.parse(vars.colValues)]);
        if (h.statusFails > 0) { h.statusFails--; throw new Error('status 502'); }
        return {};
      }
      throw new Error('unexpected query: ' + q.slice(0, 60));
    },
  });
  const fire = async (i) => { const t = timers[i]; assert.ok(t && !t.cleared, `timer ${i} pending`); t.fired = true; nowMs += t.ms; await t.fn(); await flush(); };
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const capture = (level) => { const lines = []; const orig = console[level]; console[level] = (...a) => lines.push(a.join(' ')); return { lines, restore: () => { console[level] = orig; } }; };
  return Promise.resolve(fn({ timers, calls, fire, flush, capture, notes: () => calls.filter((c) => c[0] === 'note').map((c) => c[2]), statuses: () => calls.filter((c) => c[0] === 'status') }))
    .finally(() => { Object.assign(svc.io, real); svc._resetForTests(); });
}

const saved = (over = {}) => ({ id: 'i1', name: 'Passport – PA – 2026-09-30 14-32 – passport.pdf', url: 'https://org/i1', webUrl: 'https://web/i1', replaced: false, docName: 'Passport', originalName: 'passport.pdf', noteBody: NOTE, notePosted: true, ...over });
const fail = (over = {}) => svc.onStatusWriteFailed({ itemId: '11', caseRef: '2026-CEC-EE-065', saved: saved(over), error: 'Monday 502', ...over.args });

test('the ⚠️ note is posted at once and the first retry is armed for +1 minute (unref\'d through the seam)', () => withFake({}, async ({ timers, notes, calls }) => {
  await fail();
  assert.deepEqual(timers.map((t) => t.ms), [60 * 1000]);
  assert.equal(notes().length, 1);
  assert.match(notes()[0], /^⚠️ File saved, but the status could not be set to Received\n\nDocument: Passport\nFile: Passport – PA – 2026-09-30 14-32 – passport\.pdf\nCase: 2026-CEC-EE-065\nSaved: 30 Sep 2026, 2:32 pm \(Toronto\)\n\n🔗 Open this upload: https:\/\/org\/i1\n\nMonday refused the status write \(Monday 502\)\. The app will try again by itself after 1, 5 and 15 minutes; the client was told the file is saved and not to send it again\. If this row is still not Received in half an hour, set it by hand\.$/);
  assert.equal(calls.filter((c) => c[0] === 'status').length, 0, 'nothing written yet');
  assert.deepEqual(svc.pendingStatusRetries(), ['11']);
  assert.ok(!notes()[0].includes('Document Uploaded by Client'), 'the re-file/audit parsers ignore it');
}));

test('(a) note AND status both failed → the job carries the note body; attempt 1 posts the note, then the status, then the recovery note — and stops', () => withFake({}, async ({ timers, fire, calls, notes, statuses }) => {
  await fail({ notePosted: false });
  assert.equal(notes().length, 1, 'only the ⚠️ note so far');
  await fire(0);
  const kinds = calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['note', 'note', 'readStatus', 'status', 'note'], 'the upload note FIRST (the file\'s record), then the guard read, the status, the recovery');
  assert.equal(notes()[1], NOTE, 'the exact upload note, so the file is on record before the status pings the reviewer');
  assert.deepEqual(statuses()[0][2], { color_mm0zwgvr: { label: 'Received' }, date_mm0zyw0m: { date: '2026-09-30' }, color_mm0z796e: { label: 'Yes' } }, 'the UPLOAD\'s Toronto date, not the retry\'s');
  assert.match(notes()[2], /^✅ Status set to Received \(recovered\)\n\nDocument: Passport\nFile: Passport – PA – 2026-09-30 14-32 – passport\.pdf\nCase: 2026-CEC-EE-065\n\nThe status write that failed at 30 Sep 2026, 2:32 pm succeeded on retry at 30 Sep 2026, 2:33 pm\.$/);
  assert.equal(timers.length, 1, 'no further attempt armed');
  assert.deepEqual(svc.pendingStatusRetries(), []);
}));

test('(a\') the note already landed → attempt 1 does not post it again', () => withFake({}, async ({ fire, calls }) => {
  await fail({ notePosted: true });
  await fire(0);
  assert.deepEqual(calls.map((c) => c[0]), ['note', 'readStatus', 'status', 'note']);
}));

test('(b) the status column changed AFTER the write was attempted (staff acted) → the carried note is still posted (the file\'s record), then stop: no status write, one warn line, no more timers', () => withFake({ statusChangedAt: '2026-09-30T18:40:00.000Z' }, async ({ timers, fire, calls, capture, notes }) => {
  await fail({ notePosted: false });
  const warn = capture('warn');
  try { await fire(0); } finally { warn.restore(); }
  assert.deepEqual(calls.map((c) => c[0]), ['note', 'note', 'readStatus'], 'the upload note goes up whatever the status decision; then the guard read, then nothing');
  assert.equal(notes()[1], NOTE);
  assert.equal(warn.lines.filter((l) => /status retry for item 11 .* stopped: the row was changed at 2026-09-30T18:40:00\.000Z, after the failed write attempted at 2026-09-30T18:32:10\.000Z/.test(l)).length, 1);
  assert.equal(timers.length, 1);
  assert.deepEqual(svc.pendingStatusRetries(), []);
}));

test('(b2) a Review Note edited after the attempt is a staff decision too (a note on a Rework Required row): stop', () => withFake({ statusChangedAt: '2026-09-30T18:00:00.000Z', notesChangedAt: '2026-09-30T18:33:00.000Z' }, async ({ fire, statuses, capture }) => {
  await fail();
  const warn = capture('warn');
  try { await fire(0); } finally { warn.restore(); }
  assert.equal(statuses().length, 0);
  assert.deepEqual(svc.pendingStatusRetries(), []);
}));

test('(b3) the reference time is when the route ATTEMPTED the write, not when it gave up: a staff change during the write\'s own retries stops the job', () => withFake({ statusChangedAt: '2026-09-30T18:31:00.000Z' }, async ({ fire, statuses, notes, capture }) => {
  // attempted 18:30:00, the write's retries gave up at 18:32:10 (T0 = io.now()); staff acted at 18:31 — after the attempt
  await fail({ args: { attemptedAt: '2026-09-30T18:30:00.000Z' } });
  assert.match(notes()[0], /Saved: 30 Sep 2026, 2:30 pm \(Toronto\)/, 'the ⚠️ note dates the attempt');
  const warn = capture('warn');
  try { await fire(0); } finally { warn.restore(); }
  assert.equal(statuses().length, 0, 'the reviewer\'s decision stands');
}));

test('(b\') a change BEFORE the attempt, or a status never set, is no reason to stop — and the retry writes the UPLOAD\'s Toronto date even across midnight', async () => {
  await withFake({ statusChangedAt: '2026-09-30T18:00:00.000Z' }, async ({ fire, statuses }) => {
    await fail();
    await fire(0);
    assert.equal(statuses().length, 1);
  });
  await withFake({ startAt: '2026-10-01T04:01:00.000Z' }, async ({ fire, statuses }) => {
    // attempted 23:59:30 Toronto on the 30th; the write gave up at 00:01 on 1 Oct and the retry runs at 00:02
    await fail({ args: { attemptedAt: '2026-10-01T03:59:30.000Z' } });
    await fire(0);
    assert.equal(statuses()[0][2].date_mm0zyw0m.date, '2026-09-30', 'the date the client uploaded, not the date the retry ran');
  });
  await withFake({ statusChangedAt: null }, async ({ fire, statuses }) => {
    await fail();
    await fire(0);
    assert.equal(statuses().length, 1, 'a blank status column (value null) still gets marked');
  });
});

test('(c) three failures → attempts at +1, +5, +15 min, then UNMARKED-FOR-GOOD on console.error and no fourth timer', () => withFake({ statusFails: 3 }, async ({ timers, fire, capture, statuses }) => {
  await fail();
  const warn = capture('warn'); const err = capture('error');
  try {
    await fire(0);
    assert.deepEqual(timers.map((t) => t.ms), [60 * 1000, 5 * 60 * 1000]);
    await fire(1);
    assert.deepEqual(timers.map((t) => t.ms), [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]);
    await fire(2);
  } finally { warn.restore(); err.restore(); }
  assert.equal(timers.length, 3, 'no fourth attempt');
  assert.equal(statuses().length, 3);
  assert.equal(warn.lines.filter((l) => /status retry [12]\/3 failed for item 11/.test(l)).length, 2);
  const forGood = err.lines.filter((l) => l.includes('UNMARKED-FOR-GOOD'));
  assert.equal(forGood.length, 1);
  assert.ok(forGood[0].includes('item 11') && forGood[0].includes('case 2026-CEC-EE-065') && forGood[0].includes('file "Passport – PA – 2026-09-30 14-32 – passport.pdf"') && forGood[0].includes('link https://org/i1'), forGood[0]);
  assert.deepEqual(svc.pendingStatusRetries(), []);
}));

test('(c\') a guard-read failure counts as a failed attempt (retried later), never as "stop"', () => withFake({ readFails: 1 }, async ({ timers, fire, statuses, capture }) => {
  await fail();
  const warn = capture('warn');
  try { await fire(0); } finally { warn.restore(); }
  assert.equal(statuses().length, 0);
  assert.equal(timers.length, 2, 'second attempt armed');
  await fire(1);
  assert.equal(statuses().length, 1, 'recovered on attempt 2');
}));

test('(d) one job per row: a second failure on the same row replaces the first (its timer cleared) — never two jobs; different rows keep their own', () => withFake({}, async ({ timers, fire, calls, statuses }) => {
  await fail({ name: 'first.pdf' });
  await fail({ name: 'second.pdf' });
  assert.equal(timers.length, 2);
  assert.equal(timers[0].cleared, true, 'the first job\'s timer is cancelled');
  assert.equal(timers[1].cleared, false);
  assert.deepEqual(svc.pendingStatusRetries(), ['11']);
  await svc.onStatusWriteFailed({ itemId: '12', caseRef: '2026-CEC-EE-065', saved: saved(), error: 'x' });
  assert.deepEqual(svc.pendingStatusRetries().sort(), ['11', '12']);
  await fire(1);
  assert.equal(statuses().length, 1);
  assert.equal(statuses()[0][1], '11');
  assert.deepEqual(svc.pendingStatusRetries(), ['12']);
  // firing the cancelled timer anyway (a stale closure) does nothing
  calls.length = 0;
  await timers[0].fn(); await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0, 'a replaced job is inert');
}));

test('(e) a status success on attempt 2 posts the recovery note exactly once', () => withFake({ statusFails: 1 }, async ({ timers, fire, notes, statuses, capture }) => {
  await fail();
  const warn = capture('warn');
  try { await fire(0); await fire(1); } finally { warn.restore(); }
  assert.equal(statuses().length, 2);
  assert.equal(notes().filter((n) => n.startsWith('✅ Status set to Received (recovered)')).length, 1);
  assert.equal(timers.length, 2);
  assert.match(notes()[1], /failed at 30 Sep 2026, 2:32 pm succeeded on retry at 30 Sep 2026, 2:38 pm/, '+1 then +5 minutes');
}));

test('a recovery-note failure after a successful status write is only a warning (the row IS Received)', () => withFake({ noteFails: 2 }, async ({ fire, statuses, capture }) => {
  const w0 = capture('warn');
  try { await fail(); } finally { w0.restore(); }                       // the ⚠️ note fails (1st) — still scheduled
  assert.deepEqual(svc.pendingStatusRetries(), ['11']);
  const warn = capture('warn');
  try { await fire(0); } finally { warn.restore(); }                    // the recovery note fails (2nd)
  assert.equal(statuses().length, 1);
  assert.ok(warn.lines.some((l) => /recovered, but the recovery note failed for item 11/.test(l)));
  assert.deepEqual(svc.pendingStatusRetries(), []);
}));

test('the OFF path: a job carries the client\'s own name, so File: is never empty; an absent `saved` still schedules', () => withFake({}, async ({ notes, timers }) => {
  await svc.onStatusWriteFailed({ itemId: '11', caseRef: '2026-CEC-EE-065', saved: { name: '', url: '', webUrl: 'https://web/x', originalName: 'passport.pdf', docName: 'Passport', noteBody: 'old body', notePosted: true }, error: 'e' });
  assert.match(notes()[0], /\nFile: passport\.pdf\n/);
  assert.match(notes()[0], /🔗 Open this upload: https:\/\/web\/x/);
  await svc.onStatusWriteFailed({ itemId: '12', caseRef: '2026-CEC-EE-065', saved: undefined, error: 'e' });
  assert.match(notes()[1], /\nFile: \nCase: 2026-CEC-EE-065\n/);
  assert.ok(!notes()[1].includes('Open this upload'), 'no link line when there is no link');
  assert.equal(timers.length, 2);
}));

test('seam pin: the retry, the notes and the status write reach Monday only through io.query; timers only through io.setTimer/clearTimer', () => {
  const src = fs.readFileSync(require.resolve('../src/services/documentFormService'), 'utf8');
  const from = src.indexOf('// ─── Saved but not marked');
  const to   = src.indexOf('const io = {');
  assert.ok(from > 0 && to > from);
  const block = src.slice(from, to);
  assert.doesNotMatch(block, /mondayApi\./, 'no direct Monday call in the retry code');
  assert.doesNotMatch(block, /\bsetTimeout\(|\bclearTimeout\(/, 'no bare timers');
  assert.match(block, /io\.setTimer\(/); assert.match(block, /io\.clearTimer\(/); assert.match(block, /io\.query\(/);
  assert.match(block, /STATUS_RETRY_DELAYS_MS = \[60 \* 1000, 5 \* 60 \* 1000, 15 \* 60 \* 1000\]/);
  const io = src.slice(to, src.indexOf('};', to));
  assert.match(io, /t\.unref\(\)/, 'a pending retry never keeps the process alive');
  // markDocumentReceived and the awaited row note go through io.query too
  const mark = src.slice(src.indexOf('async function markDocumentReceived('), src.indexOf('\n}\n', src.indexOf('async function markDocumentReceived(')));
  assert.match(mark, /await io\.query\(/);
  assert.match(mark, /naming\.torontoDate\(io\.now\(\)\)/, 'the Toronto date, from the seam\'s clock');
});

test("(d') a replaced job's UNPOSTED upload note travels into the new job — file A keeps its record", () => withFake({}, async ({ fire, calls, notes, statuses }) => {
  await fail({ name: 'A.pdf', noteBody: 'NOTE A', notePosted: false });
  await fail({ name: 'B.pdf', noteBody: 'NOTE B', notePosted: false });
  await fire(1);
  assert.deepEqual(calls.map((c) => c[0]), ['note', 'note', 'note', 'note', 'readStatus', 'status', 'note']);
  assert.deepEqual([notes()[2], notes()[3]], ['NOTE A', 'NOTE B'], 'both files on record, in order, before the status');
  assert.equal(statuses().length, 1);
}));

test("(d'') a second failure while the job is MID-ATTEMPT merges into it: no orphan, no lost note, one status write", () => withFake({}, async ({ timers, fire, calls, notes, statuses, flush }) => {
  await fail({ name: 'A.pdf', noteBody: 'NOTE A', notePosted: false });
  // make the guard read hang until we say so
  let release; const gate = new Promise((r) => { release = r; });
  const q = svc.io.query;
  svc.io.query = async (g, v) => { if (g.includes('column_values(ids: ["color_mm0zwgvr"')) { await gate; } return q(g, v); };
  const running = timers[0].fn();          // attempt 1 starts: posts NOTE A, then blocks on the guard read
  await flush();
  await fail({ name: 'B.pdf', noteBody: 'NOTE B', notePosted: false });   // arrives mid-attempt
  assert.equal(timers.length, 1, 'merged into the running job — no second timer');
  release(); await running; await flush();
  assert.deepEqual(notes().filter((n) => /^NOTE [AB]$/.test(n)), ['NOTE A', 'NOTE B']);
  assert.equal(statuses().length, 1, 'one status write, the newer file\'s');
  const order = calls.map((c) => (c[0] === 'note' ? c[2] : c[0]));
  assert.ok(order.indexOf('NOTE B') < order.indexOf('status'), 'the merged note is on record BEFORE the status flips and pings the reviewer');
  assert.deepEqual(svc.pendingStatusRetries(), []);
}));

test('(f) the recovery note and the UNMARKED-FOR-GOOD line name unposted notes so nothing is silently missing', () => withFake({ statusFails: 3, noteFails: 99 }, async ({ fire, capture }) => {
  const w0 = capture('warn'); try { await fail({ noteBody: 'NOTE A', notePosted: false }); } finally { w0.restore(); }
  const warn = capture('warn'); const err = capture('error');
  try { await fire(0); await fire(1); await fire(2); } finally { warn.restore(); err.restore(); }
  assert.ok(err.lines.some((l) => l.includes('UNMARKED-FOR-GOOD') && l.includes('1 upload note(s) never posted')));
}));
