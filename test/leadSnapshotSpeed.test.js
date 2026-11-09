'use strict';

// Step 6 task B (decision 7, 2026-11-09): page speed. A background job's change may show up to
// ~30 s late (serve the copy, re-read behind it); a staff member's OWN change shows at once;
// the Refresh button joins a recent read instead of queueing a second one; an idle board is
// not re-read every 3 minutes.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const snap   = require('../src/services/leadSnapshot');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const L = (id) => ({ id: String(id), name: `Lead ${id}`, fullName: `Lead ${id}` });
const tick = () => new Promise((r) => setImmediate(r));

/** A fake board: each read waits until the test releases it (a slow Monday read). */
function fakeBoard() {
  const b = { now: 1_000_000, reads: 0, rows: [L(1)], pending: [] };
  b.restore = [
    stub(snap.io, 'now', () => b.now),
    stub(snap.io, 'fetchLeads', () => { b.reads++; const rows = b.rows.slice(); return new Promise((res) => b.pending.push(() => res(rows))); }),
  ];
  b.release = async () => { while (b.pending.length) b.pending.shift()(); await tick(); };
  b.done = () => { b.restore.forEach((r) => r()); snap._reset(); };
  return b;
}
const ids = (leads) => leads.map((l) => l.id);

test('a background job change: the stale copy is served at once, ONE re-read runs behind it, the next view has the change', async () => {
  snap._reset(); const b = fakeBoard();
  try {
    const first = snap.leads(); await b.release(); assert.deepEqual(ids(await first), ['1']);
    b.rows = [L(1), L(2)];
    snap.runInBackground(() => snap.invalidate());          // e.g. the 5-minute payment check wrote a lead
    const views = await Promise.all([snap.leads(), snap.leads(), snap.leads()]);   // no read released: must not wait
    views.forEach((v) => assert.deepEqual(ids(v), ['1'], 'served the copy instantly'));
    assert.equal(b.reads, 2, 'exactly one background re-read for three views');
    await b.release();
    assert.deepEqual(ids(await snap.leads()), ['1', '2'], 'the next view has the background change');
    assert.equal(b.reads, 2, 'and no further read');
  } finally { b.done(); }
});

test('a background change during an in-flight read is not lost: another read follows behind it', async () => {
  snap._reset(); const b = fakeBoard();
  try {
    const first = snap.leads(); await b.release(); await first;
    b.now += snap.TTL_MS + 1;
    await snap.leads();                                      // starts a background read of the OLD rows
    assert.equal(b.reads, 2);
    b.rows = [L(1), L(3)];
    snap.runInBackground(() => snap.invalidate());
    assert.deepEqual(ids(await snap.leads()), ['1'], 'still instant');
    await b.release(); await tick(); await b.release();
    assert.deepEqual(ids(await snap.leads()), ['1', '3'], 'the re-read that began after the change landed');
  } finally { b.done(); }
});

test("a staff member's OWN write (outside the scheduler) still makes the next view wait for data read after it", async () => {
  snap._reset(); const b = fakeBoard();
  try {
    const first = snap.leads(); await b.release(); await first;
    b.rows = [L(1), L(4)];
    snap.invalidate();                                       // a request: e.g. Outcome set on the lead page
    let got = null; const view = snap.leads().then((v) => { got = v; });
    await tick(); assert.equal(got, null, 'waits — never shows the copy from before the write');
    await b.release(); await view;
    assert.deepEqual(ids(got), ['1', '4']);
  } finally { b.done(); }
});

test('an own write outranks a background mark made at the same time', async () => {
  snap._reset(); const b = fakeBoard();
  try {
    const first = snap.leads(); await b.release(); await first;
    b.rows = [L(9)];
    snap.runInBackground(() => snap.invalidate());
    snap.invalidate();
    const view = snap.leads(); await tick(); await b.release();
    assert.deepEqual(ids(await view), ['9']);
  } finally { b.done(); }
});

test('Refresh (fresh: true) joins a read that began within 30 s — no second read queued behind it', async () => {
  snap._reset(); const b = fakeBoard();
  try {
    const first = snap.leads(); await b.release(); await first;
    b.now += snap.TTL_MS + 1;
    await snap.leads();                                      // background read starts
    b.now += 10 * 1000;
    const refresh = snap.leads({ fresh: true });
    await tick();
    assert.equal(b.reads, 2, 'joined the read in flight');
    await b.release();
    await refresh;
    assert.equal(b.reads, 2);
  } finally { b.done(); }
});

test('Refresh does NOT join a read older than 30 s, nor one that began before an own write', async () => {
  snap._reset(); const b = fakeBoard();
  try {
    const first = snap.leads(); await b.release(); await first;
    b.now += snap.TTL_MS + 1;
    await snap.leads();                                      // read #2 in flight
    b.now += snap.JOIN_MS + 1;
    const refresh = snap.leads({ fresh: true });
    await b.release(); await tick(); await b.release();
    await refresh;
    assert.equal(b.reads, 3, 'a new read after the old one');

    b.now += snap.TTL_MS + 1;
    await snap.leads();                                      // read #4 in flight
    b.rows = [L(7)]; snap.invalidate();                      // own write while it runs
    const r2 = snap.leads({ fresh: true });
    await b.release(); await tick(); await b.release();
    assert.deepEqual(ids(await r2), ['7']);
    assert.equal(b.reads, 5);
  } finally { b.done(); }
});

test('warm(): no re-read while nobody looks at the lists; re-reads while they are in use and before the copy gets too old', async () => {
  snap._reset(); const b = fakeBoard();
  try {
    const w0 = snap.warm(); await b.release(); await w0;     // boot warm-up (no copy yet)
    assert.equal(b.reads, 1);
    for (let i = 0; i < 4; i++) { b.now += 3 * 60 * 1000; await snap.warm(); }
    assert.equal(b.reads, 1, '12 idle minutes: no re-reads');
    b.now += 3 * 60 * 1000;                                  // 15 min: within 5 min of HARD_MAX — keep a showable copy
    const w1 = snap.warm(); await tick(); await b.release(); await w1;
    assert.equal(b.reads, 2);
    await snap.leads();                                      // someone looks
    b.now += 3 * 60 * 1000;
    const w2 = snap.warm(); await tick(); await b.release(); await w2;
    assert.equal(b.reads, 3, 'in use: kept warm');
  } finally { b.done(); }
});

test('the scheduler runs every job (and the boot warm-ups) as a background job', () => {
  const src = fs.readFileSync(require.resolve('../src/services/scheduler'), 'utf8');
  assert.match(src, /const cron = \{ schedule: \(expr, fn, opts\) => nodeCron\.schedule\(expr, \(\.\.\.a\) => runInBackground\(\(\) => fn\(\.\.\.a\)\), opts\) \};/);
  assert.ok(!/^\s*setTimeout\(\(\) => (leadSnapshot|leadStatus)/m.test(src), 'boot jobs use bootDelay');
});
