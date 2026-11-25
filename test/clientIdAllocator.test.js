'use strict';

// Client ID numbers (2026-11-25): one company-wide counter in OneDrive. The
// number is taken BY the conditional write of the counter (If-Match), so two
// app instances can never get the same one; next = last + 1 (never "board
// max + 1" — review #6); the boards only seed a missing file; a number typed
// on the board by hand is skipped (burnt); a damaged or unreadable file mints
// nothing; a block for the backfill is one write.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const mondayApi = require('../src/services/mondayApi');
const { torontoYear } = require('../src/utils/torontoTime');

const COLS = { clientsBoardId: '111', clientsCol: 'text_cid', cmBoardId: '222', cmCol: 'text_cmcid' };

const fresh = () => {
  const p = require.resolve('../src/services/clientIdAllocator');
  delete require.cache[p];
  const m = require(p);
  m._resetForTests();
  return m;
};
const quiet = (fn) => async () => { const o = [console.log, console.warn, console.error]; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { [console.log, console.warn, console.error] = o; } };

/**
 * A fake OneDrive file with eTags (create-only without an eTag, If-Match with
 * one) and a fake Clients board. `onRead` runs after every read — to let
 * "another instance" write between our read and our write.
 */
function harness({ file = { last: 41 }, board = [], taken = [], readFail = false, corrupt = null, cols = COLS, now = Date.parse('2026-06-01T12:00:00Z') } = {}) {
  const a = fresh();
  let ver = 1;
  let cur = file && !corrupt ? { data: { ...file }, etag: `e${ver}` } : null;   // a damaged file IS the file
  const seen = { reads: 0, writes: [], probes: [], boardReads: 0, backups: [], onRead: null };
  a.io.columns = () => cols;
  a.io.now = () => now;
  a.io.readCounter = async () => {
    seen.reads++;
    if (readFail) throw new Error('OneDrive down');
    if (corrupt) { const e = new Error('not a JSON object'); e.corrupt = true; e.etag = corrupt.etag; e.raw = corrupt.raw; throw e; }
    const r = cur ? { data: { ...cur.data }, etag: cur.etag } : null;
    if (seen.onRead) { const f = seen.onRead; seen.onRead = null; await f(); }
    return r;
  };
  a.io.writeCounter = async (data, etag) => {
    const clash = etag ? (!cur && !corrupt) || (cur ? cur.etag !== etag : corrupt.etag !== etag) : (!!cur || !!corrupt);
    if (clash) { const e = new Error('changed meanwhile'); e.conflict = true; throw e; }
    corrupt = null;
    ver++; cur = { data: { ...data }, etag: `e${ver}` };
    seen.writes.push({ ...data, _etag: etag });
    return { etag: cur.etag };
  };
  a.io.writeBackup = async (raw, at) => { seen.backups.push({ raw, at }); return {}; };
  a.io.numberTaken = async (n) => { seen.probes.push(n); return taken.includes(n); };
  a.io.boardValues = async () => { seen.boardReads++; return board.slice(); };
  /** another instance takes the next number between our read and our write */
  seen.otherInstanceWrites = (last) => { ver++; cur = { data: { last }, etag: `e${ver}` }; };
  seen.file = () => cur;
  return { a, seen };
}

test('next number = last + 1, labelled with the Toronto year of now; the counter moves to it', quiet(async () => {
  const { a, seen } = harness({ file: { last: 41 } });
  const r = await a.allocate();
  assert.equal(r.ok, true);
  assert.equal(r.id, 'CL-2026-00042');
  assert.equal(r.n, 42);
  assert.equal(r.year, 2026);
  assert.equal(seen.file().data.last, 42);
  assert.equal(seen.writes[0]._etag, 'e1', 'written only over the version that was read');
  assert.equal(seen.boardReads, 0, 'the boards are NOT scanned on a normal mint');
  assert.deepEqual(seen.probes, [42], 'one 1-row clash probe');
}));

test('the label year is the person\'s own when given; 31 Dec 23:30 Toronto is still that year', quiet(async () => {
  const { a } = harness({ file: { last: 9 }, now: Date.parse('2027-01-01T04:30:00Z') });   // 31 Dec 2026 23:30 Toronto
  assert.equal((await a.allocate()).id, 'CL-2026-00010');
  assert.equal((await a.allocate({ year: 2019 })).id, 'CL-2019-00011');
  const bad = await a.allocate({ year: 26 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-year');
}));

test('a hand-typed huge number on the board does NOT move the counter (review #6)', quiet(async () => {
  const { a, seen } = harness({ file: { last: 41 }, board: ['CL-2026-90000'] });
  assert.equal((await a.allocate()).n, 42);
  assert.equal(seen.boardReads, 0);
}));

test('a number already typed on the Clients board is skipped and burnt — the counter goes past it', quiet(async () => {
  const { a, seen } = harness({ file: { last: 41 }, taken: [42, 43] });
  const r = await a.allocate();
  assert.equal(r.id, 'CL-2026-00044');
  assert.deepEqual(r.skipped, [42, 43]);
  assert.deepEqual(seen.probes, [42, 43, 44]);
  assert.equal(seen.file().data.last, 44, 'the burnt numbers are never handed out later');
  assert.equal((await a.allocate()).n, 45);
}));

test('a CAS conflict (another instance took one meanwhile) re-reads and takes the NEXT number', quiet(async () => {
  const { a, seen } = harness({ file: { last: 41 } });
  seen.onRead = async () => seen.otherInstanceWrites(42);   // the other instance got 42 between our read and write
  const r = await a.allocate();
  assert.equal(r.n, 43);
  assert.equal(r.tries, 2);
  assert.equal(seen.file().data.last, 43);
}));

test('two app instances sharing one file never get the same number', quiet(async () => {
  // two separate module instances (separate locks, separate memory), one file
  let ver = 1, cur = { data: { last: 0 }, etag: 'e1' };
  const make = () => {
    const a = fresh();
    a.io.columns = () => COLS;
    a.io.numberTaken = async () => false;
    a.io.boardValues = async () => [];
    a.io.readCounter = async () => { const r = { data: { ...cur.data }, etag: cur.etag }; await new Promise((res) => setImmediate(res)); return r; };
    a.io.writeCounter = async (data, etag) => {
      await new Promise((res) => setImmediate(res));
      if (cur.etag !== etag) { const e = new Error('changed'); e.conflict = true; throw e; }
      ver++; cur = { data: { ...data }, etag: `e${ver}` }; return { etag: cur.etag };
    };
    return a;
  };
  const A = make(), B = make();
  const results = await Promise.all([A.allocate(), B.allocate(), A.allocate(), B.allocate(), A.allocate(), B.allocate()]);
  const got = results.filter((r) => r.ok).map((r) => r.n);
  assert.equal(new Set(got).size, got.length, `no number twice: ${got}`);
  assert.equal(cur.data.last, Math.max(...got));
  for (const r of results.filter((x) => !x.ok)) assert.equal(r.reason, 'busy', 'a loser after 5 tries gets NO number, never a shared one');
}));

test('in one process, calls at the same moment queue on the module\'s own lock', quiet(async () => {
  const { a } = harness({ file: { last: 0 } });
  const got = await Promise.all(Array.from({ length: 8 }, () => a.allocate()));
  assert.deepEqual(got.map((r) => r.n), [1, 2, 3, 4, 5, 6, 7, 8]);
}));

test('the lock is NOT the case-number allocator\'s (a case number never waits on a client number)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'clientIdAllocator.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/caseRefAllocator['"]\)/.test(src), 'no state shared with caseRefAllocator');
  assert.match(src, /let _lockTail = Promise\.resolve\(\)/);
});

test('a missing counter file is created (create-only) from the boards\' highest number', quiet(async () => {
  const { a, seen } = harness({ file: null, board: ['CL-2026-00007', 'cl 2025 12', 'junk', '2026-VV-00099', ''] });
  const r = await a.allocate();
  assert.equal(r.ok, true);
  assert.equal(r.n, 13, 'max of the readable Client IDs (12) + 1; a case ref is not one');
  assert.equal(r.seeded, true);
  assert.equal(seen.writes[0]._etag, '', 'create-only: refused if another instance made the file first');
  assert.equal(seen.boardReads, 1);
  assert.equal((await a.allocate()).n, 14);
  assert.equal(seen.boardReads, 1, 'once the file exists the boards are never read again');
}));

test('a missing file that another instance creates first: the create is refused, re-read, next number', quiet(async () => {
  const { a, seen } = harness({ file: null, board: ['CL-2026-00005'] });
  seen.onRead = async () => seen.otherInstanceWrites(6);
  const r = await a.allocate();
  assert.equal(r.n, 7);
  assert.equal(r.seeded, false);
}));

test('an unreadable counter mints NOTHING (no stale memory, nothing written)', quiet(async () => {
  const { a, seen } = harness({ readFail: true });
  const r = await a.allocate();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
  assert.equal(seen.writes.length, 0);
  assert.equal(seen.probes.length, 0);
}));

test('a damaged counter mints NOTHING and lowers nothing; a valid-JSON file without a whole "last" is damage too', quiet(async () => {
  const h1 = harness({ corrupt: { etag: 'eX', raw: '{"last": 57, oops' } });
  const r1 = await h1.a.allocate();
  assert.equal(r1.reason, 'corrupt');
  assert.equal(h1.seen.writes.length, 0);
  assert.equal(h1.seen.backups.length, 0, 'the mint path writes nothing at all');
  for (const bad of [{ last: '57' }, { last: -1 }, { last: 3.5 }, {}]) {
    const h = harness({ file: bad });
    const r = await h.a.allocate();
    assert.equal(r.reason, 'corrupt', JSON.stringify(bad));
    assert.equal(h.seen.writes.length, 0);
  }
}));

test('repairCounter: keeps a copy, writes UPWARD only (max of the readable file and the boards), over that damaged version', quiet(async () => {
  const { a, seen } = harness({ corrupt: { etag: 'eX', raw: '{"last": 57, "updatedAt": oops' }, board: ['CL-2026-00030'] });
  const r = await a.repairCounter();
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.equal(r.last, 57);
  assert.equal(seen.backups.length, 1);
  assert.equal(seen.backups[0].raw, '{"last": 57, "updatedAt": oops');
  assert.equal(seen.writes[0]._etag, 'eX', 'only over the damaged version');
  assert.equal((await a.allocate()).n, 58);

  const h2 = harness({ corrupt: { etag: 'eY', raw: 'garbage' }, board: ['CL-2026-00030'] });
  assert.equal((await h2.a.repairCounter()).last, 30, 'nothing readable in the file: the boards\' highest');
  const h3 = harness({ file: { last: 5 } });
  assert.equal((await h3.a.repairCounter()).repaired, false, 'a good file is never touched');
  assert.equal(h3.seen.writes.length, 0);
}));

test('salvageLast reads the highest "last" left in damaged text', () => {
  const { salvageLast } = fresh();
  assert.equal(salvageLast('{"last": 57, x'), 57);
  assert.equal(salvageLast('{"last":"12"} {"last": 9'), 12);
  assert.equal(salvageLast('nothing'), 0);
});

test('a Monday failure on the clash probe mints nothing and burns nothing', quiet(async () => {
  const { a, seen } = harness({ file: { last: 41 } });
  a.io.numberTaken = async () => { throw new Error('Monday 500'); };
  const r = await a.allocate();
  assert.equal(r.reason, 'unavailable');
  assert.equal(seen.writes.length, 0);
  assert.equal(seen.file().data.last, 41);
}));

test('25 typed numbers in a row: stops with no number', quiet(async () => {
  const taken = Array.from({ length: 30 }, (_, i) => 42 + i);
  const { a, seen } = harness({ file: { last: 41 }, taken });
  const r = await a.allocate();
  assert.equal(r.reason, 'no-free');
  assert.equal(seen.writes.length, 0);
}));

test('while the Client ID column is not set up (null in a config) nothing is read or written', quiet(async () => {
  for (const cols of [{ ...COLS, clientsCol: '' }, { ...COLS, clientsBoardId: '' }, {}, null]) {
    const { a, seen } = harness({ cols });
    for (const r of [await a.allocate(), await a.allocateBlock(3), await a.repairCounter()]) assert.equal(r.reason, 'not-configured');
    assert.equal(seen.reads + seen.writes.length + seen.probes.length + seen.boardReads, 0);
  }
  // and the shipped config (the columns made 2026-11-25): the real readColumns gives the Clients and Client Master Client ID columns
  const a = fresh();
  assert.deepEqual(a.readColumns(), { clientsBoardId: '18425020416', clientsCol: 'text_mm9ewm14', cmBoardId: '18401523447', cmCol: 'text_mm9ep9bw' });
}));

test('allocateBlock: ONE write moves the counter M → M+K; the block is contiguous', quiet(async () => {
  const { a, seen } = harness({ file: { last: 41 } });
  const r = await a.allocateBlock(10);
  assert.deepEqual([r.ok, r.first, r.last, r.count, r.burnt], [true, 42, 51, 10, 0]);
  assert.equal(seen.writes.length, 1);
  assert.equal(seen.file().data.last, 51);
  assert.equal((await a.allocate()).n, 52, 'a live mint after the block never lands inside it');
}));

test('allocateBlock: a block starts above every number already typed on the boards inside it (those are burnt)', quiet(async () => {
  const { a } = harness({ file: { last: 41 }, board: ['CL-2026-00045', 'CL-2026-00049', 'CL-2026-00200'] });
  const r = await a.allocateBlock(5);
  assert.deepEqual([r.first, r.last, r.burnt], [50, 54, 8]);
}));

test('allocateBlock: conflict retries, a missing file is seeded, bad counts and a damaged file reserve nothing', quiet(async () => {
  const h1 = harness({ file: { last: 41 } });
  h1.seen.onRead = async () => h1.seen.otherInstanceWrites(42);
  const r1 = await h1.a.allocateBlock(3);
  assert.deepEqual([r1.first, r1.last, r1.tries], [43, 45, 2]);

  const h2 = harness({ file: null, board: ['CL-2026-00007'] });
  const r2 = await h2.a.allocateBlock(3);
  assert.deepEqual([r2.first, r2.last, r2.seeded], [8, 10, true]);
  assert.equal(h2.seen.writes[0]._etag, '');

  const h3 = harness({ file: { last: 1 } });
  for (const k of [0, -1, 1.5, 'x', 5001]) assert.equal((await h3.a.allocateBlock(k)).reason, 'bad-count', String(k));
  assert.equal(h3.seen.writes.length, 0);

  const h4 = harness({ corrupt: { etag: 'e', raw: '{' } });
  assert.equal((await h4.a.allocateBlock(3)).reason, 'corrupt');
  assert.equal(h4.seen.writes.length, 0);
}));

test('the real seams: the clash probe is ONE row, every label year of the number, on the Clients column', quiet(async () => {
  const a = fresh();
  const calls = [];
  const orig = mondayApi.query;
  mondayApi.query = async (q, v) => { calls.push({ q, v }); return { items_page_by_column_values: { items: [{ id: '9' }] } }; };
  try {
    a.io.now = () => Date.parse('2026-06-01T12:00:00Z');
    assert.equal(await a.io.numberTaken(42, COLS), true);
  } finally { mondayApi.query = orig; }
  assert.equal(calls.length, 1);
  assert.match(calls[0].q, /items_page_by_column_values\(limit:1,/);
  assert.match(calls[0].q, /column_id:"text_cid"/);
  assert.equal(calls[0].v.b, '111');
  assert.ok(calls[0].v.v.includes('CL-2026-00042') && calls[0].v.v.includes('CL-2019-00042') && calls[0].v.v.includes('CL-2027-00042'));
  assert.ok(calls[0].v.v.every((x) => /^CL-\d{4}-00042$/.test(x)));
}));

test('the real seams: board values page with items_page limit 200 and the cursor (never items(ids:) — the 25-row cap)', quiet(async () => {
  const a = fresh();
  const calls = [];
  const orig = mondayApi.query;
  mondayApi.query = async (q, v) => {
    calls.push({ q, v });
    const board = v.b[0];
    if (board === '111' && !v.c) return { boards: [{ items_page: { cursor: 'p2', items: [{ column_values: [{ text: 'CL-2026-00001' }] }, { column_values: [{ text: '' }] }] } }] };
    if (board === '111') return { boards: [{ items_page: { cursor: null, items: [{ column_values: [{ text: 'CL-2026-00002' }] }] } }] };
    return { boards: [{ items_page: { cursor: null, items: [{ column_values: [{ text: ' CL-2026-00003 ' }] }] } }] };
  };
  let vals;
  try { vals = await a.io.boardValues(COLS); } finally { mondayApi.query = orig; }
  assert.deepEqual(vals, ['CL-2026-00001', 'CL-2026-00002', 'CL-2026-00003']);
  assert.equal(calls.length, 3);
  for (const c of calls) { assert.match(c.q, /items_page\(limit:200/); assert.doesNotMatch(c.q, /items\(ids:/); }
  assert.equal(calls[1].v.c, 'p2');
}));

test('the counter file lives outside "Client Documents"', () => {
  const a = fresh();
  assert.equal(a.COUNTER_PATH, 'TDOT System/client-id-counter.json');
  assert.equal(torontoYear(Date.parse('2027-01-01T04:30:00Z')), 2026);
});

// ─── the backfill lock (review 2026-11-25: the backfill cannot see the live server's switch) ───

test('the backfill lock: set in the counter file (over the version read); while it is there NO number is given; a block keeps it; cleared at the end', quiet(async () => {
  const { a, seen } = harness({ file: { last: 41 } });
  const set = await a.setBackfillLock({ by: 'boss@tdotimm.com' });
  assert.equal(set.ok, true); assert.equal(set.already, false);
  assert.equal(seen.file().data.last, 41, 'the number is untouched');
  assert.equal(seen.file().data.backfill.by, 'boss@tdotimm.com');
  assert.equal(seen.writes[0]._etag, 'e1', 'only over the version that was read');
  // a live mint on any server: refused, nothing written
  const writes = seen.writes.length;
  const live = await a.allocate();
  assert.equal(live.ok, false); assert.equal(live.reason, 'backfill');
  assert.match(live.message, /backfill is running/);
  assert.equal(seen.writes.length, writes);
  assert.deepEqual(await a.peekCounter(), { state: 'ok', last: 41, backfill: seen.file().data.backfill });
  // set again (a resumed apply): kept, no write
  assert.equal((await a.setBackfillLock({ by: 'x' })).already, true);
  assert.equal(seen.writes.length, writes);
  // the backfill's own block: allowed, and the lock stays in
  const b = await a.allocateBlock(3);
  assert.equal(b.ok, true); assert.deepEqual([b.first, b.last], [42, 44]);
  assert.ok(seen.file().data.backfill, 'the block keeps the lock');
  // cleared: live numbers again
  const cl = await a.clearBackfillLock();
  assert.equal(cl.cleared, true);
  assert.equal(seen.file().data.backfill, undefined);
  assert.equal(seen.file().data.last, 44);
  assert.deepEqual(await a.peekCounter(), { state: 'ok', last: 44 });
  const after = await a.allocate();
  assert.equal(after.ok, true); assert.equal(after.n, 45);
  assert.equal((await a.clearBackfillLock()).cleared, false, 'nothing to clear: fine');
}));

test('the backfill lock: a missing file is created (create-only, from the boards); a damaged or unreadable counter is refused', quiet(async () => {
  const m = harness({ file: null, board: ['CL-2025-00007'] });
  const r = await m.a.setBackfillLock({ by: 'b' });
  assert.equal(r.ok, true); assert.equal(m.seen.file().data.last, 7); assert.equal(m.seen.writes[0]._etag, '');
  assert.equal((await harness({ corrupt: { etag: 'c1', raw: '{' } }).a.setBackfillLock({ by: 'b' })).reason, 'corrupt');
  assert.equal((await harness({ readFail: true }).a.setBackfillLock({ by: 'b' })).reason, 'unavailable');
  // another instance writes between the read and the lock write: read again, then lock
  const c = harness({ file: { last: 5 } });
  c.seen.onRead = async () => c.seen.otherInstanceWrites(6);
  const r2 = await c.a.setBackfillLock({ by: 'b' });
  assert.equal(r2.ok, true); assert.equal(c.seen.file().data.last, 6); assert.ok(c.seen.file().data.backfill);
}));
