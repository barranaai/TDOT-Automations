'use strict';
/**
 * Block 3 step 1: the Client Master data the tabs need — dashboardService reads and cache.
 *  7. RBAC: an assigned-policy viewer gets only the rows they may see, each with its views;
 *  8. the board meta read (after the listing, own failure path, string positions), dataAt,
 *     Refresh (fresh) honoured only after 30 s and sharing a read in flight, and the
 *     patched cell surviving an older in-flight read.
 * Monday is stubbed (mondayApi.query); nothing leaves the machine.
 */
const test   = require('node:test');
const assert = require('node:assert/strict');

const dash      = require('../src/services/dashboardService');
const mondayApi = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const CSO = 'multiple_person_mm0xm710', CM = 'multiple_person_mm0xhmgk';
const people = (...ids) => JSON.stringify({ personsAndTeams: ids.map((id) => ({ id, kind: 'person' })) });

function item(id, { stage = 1, phase = null, group = 'group_mm7qvmt1', cso = null, csoText = '', manager = null, types = null } = {}) {
  return {
    id: String(id), name: 'Client ' + id, created_at: '2026-10-0' + (id % 9 + 1) + 'T00:00:00Z', group: group ? { id: group, title: 'G ' + group } : null,
    column_values: [
      { id: 'color_mm0x8faa', text: '', value: stage == null ? null : JSON.stringify({ index: stage }) },
      { id: 'color_mm3tf1ys', text: '', value: phase == null ? null : JSON.stringify({ index: phase }) },
      { id: 'dropdown_mm0xd1qn', text: '', value: types ? JSON.stringify({ ids: types }) : null },
      { id: CSO, text: csoText, value: cso },
      { id: CM, text: '', value: manager },
    ],
  };
}

const META_ANSWER = {
  boards: [{
    groups: [
      { id: 'group_late', title: 'Late', position: '114688.0' },
      { id: 'group_mm6a68f5', title: 'Pending', position: '32754.0' },
      { id: 'group_mid', title: 'Mid', position: '65668.0' },
      { id: 'group_nopos', title: 'No position', position: null },
    ],
    columns: [
      { id: 'color_mm0x8faa', settings_str: JSON.stringify({ labels: { 0: 'Document Collection Started', 1: 'Internal Review', 2: 'Stuck', 7: 'Submission Ready' }, labels_positions_v2: { 0: 1, 1: 2, 2: 6, 5: 7, 7: 4 } }) },
      { id: 'color_mm3tf1ys', settings_str: JSON.stringify({ labels: { 0: 'Phase 8', 4: 'Profile', 6: 'Phase 11', 7: 'N/A' }, labels_positions_v2: { 0: 1, 4: 5, 5: 4, 6: 6, 7: 7 } }) },
    ],
  }],
};

/** A fake Monday board. `hold` makes the next listing wait until released (a read in flight). */
function fakeBoard(initial) {
  const st = { items: initial.slice(), calls: [], metaFails: false, holds: [], holdNext: false, onListing: null };
  const restore = stub(mondayApi, 'query', async (q, v) => {
    st.calls.push(q);
    if (/items_page\(limit: 500/.test(q)) {
      const snapshot = st.items.slice();
      if (st.onListing) st.onListing();
      if (st.holdNext) { st.holdNext = false; await new Promise((res) => st.holds.push(res)); }
      return { boards: [{ items_page: { cursor: null, items: snapshot.map((it) => ({ id: it.id })) } }] };
    }
    if (/\{ groups \{ id title position \}/.test(q)) {
      if (st.metaFails) throw new Error('Monday 500 on meta');
      return META_ANSWER;
    }
    if (/items\(ids: \$ids, limit: 100\)/.test(q)) {
      const byId = new Map(st.items.map((it) => [it.id, it]));
      return { items: v.ids.map((id) => byId.get(id)).filter(Boolean).map((it) => JSON.parse(JSON.stringify(it))) };
    }
    throw new Error('unexpected query ' + q.slice(0, 60));
  });
  st.listings = () => st.calls.filter((q) => /items_page\(limit: 500/.test(q)).length;
  st.release = () => { const r = st.holds.shift(); if (r) r(); };
  st.restore = restore;
  return st;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

let clock = Date.parse('2026-11-08T15:00:00Z');
function useClock() { return stub(dash._casesIo.io, 'now', () => clock); }
function reset() { dash.invalidateCases(); dash._casesIo.overrides.clear(); }

/* ── 7. RBAC ── */

test('RBAC: an assigned-policy viewer gets only the rows they may see, each with its views; a hidden row never reaches the page', async () => {
  const board = fakeBoard([
    item(1, { stage: 1, phase: 6, cso: people(111) }),            // mine (Case Support Officer)
    item(2, { stage: 1, phase: 6, manager: people(222) }),        // someone else's
    item(3, { stage: 16, phase: 2, manager: people(111) }),       // mine (Case Manager)
    item(4, { stage: 1, phase: 6, types: [6] }),                  // nobody's
  ]);
  const restoreClock = useClock();
  const prev = process.env.CASE_VISIBILITY;
  process.env.CASE_VISIBILITY = 'assigned';
  try {
    reset();
    const viewer = { userId: '111', teamIds: [], isAdmin: false };
    const mine = await dash.getDashboardStats(viewer);
    assert.deepEqual(mine.cases.map((c) => c.id), ['1', '3']);
    assert.deepEqual(mine.cases.map((c) => c.views), [['assigning', 'deadlines'], ['assigning']]);
    assert.equal(mine.summary.total, 2, 'every count is after visibility');
    assert.ok(!JSON.stringify(mine).includes('Client 4') && !JSON.stringify(mine).includes('Client 2'), 'hidden rows are not in the answer at all');
    const all = await dash.getDashboardStats(undefined);          // the admin key / scope 'all'
    assert.deepEqual(all.cases.map((c) => c.id), ['1', '2', '3', '4']);
    assert.deepEqual(all.cases.find((c) => c.id === '4').views, ['assigning', 'deadlines', 'eeita']);
    assert.deepEqual(all.cases.map((c) => c.boardIdx), [0, 1, 2, 3], 'board order kept');
    process.env.CASE_VISIBILITY = 'all';
    assert.equal((await dash.getDashboardStats(viewer)).cases.length, 4, 'policy all: every signed-in staffer sees every row');
  } finally {
    if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev;
    restoreClock(); board.restore(); reset();
  }
});

/* ── 8. reads and cache ── */

test('the board meta: read once per fresh read, AFTER the listing; string positions sorted as numbers; label positions give the heading order', async () => {
  const board = fakeBoard([item(1), item(2)]);
  const restoreClock = useClock();
  try {
    reset();
    const s = await dash.getDashboardStats();
    assert.match(board.calls[0], /items_page\(limit: 500/, 'the listing is still the first call');
    assert.equal(board.calls.filter((q) => /\{ groups \{ id title position \}/.test(q)).length, 1);
    assert.deepEqual(s.meta.groups.map((g) => g.id), ['group_mm6a68f5', 'group_mid', 'group_late', 'group_nopos'],
      '"32754.0" before "65668.0" before "114688.0" (numbers, not text); no position goes last');
    assert.deepEqual(s.meta.groups.map((g) => g.position), [32754, 65668, 114688, null]);
    assert.deepEqual(s.meta.stageOrder, [0, 1, 7, 2, 5], 'by labels_positions_v2: Submission Ready above Stuck, the empty slot after');
    assert.deepEqual(s.meta.phaseOrder, [0, 5, 4, 6, 7], 'Profile between the empty slot and Phase 11 (label position)');
    assert.equal(s.meta.stageLabels[7], 'Submission Ready');
    assert.equal(s.meta.phaseLabels[4], 'Profile');
    assert.deepEqual(dash.getCasesMeta(), s.meta);
    // a fresh read reads the meta again
    clock += 61 * 1000;
    await dash.getDashboardStats(undefined, { fresh: true });
    assert.equal(board.calls.filter((q) => /\{ groups \{ id title position \}/.test(q)).length, 2);
  } finally { restoreClock(); board.restore(); reset(); }
});

test('a failed meta read still loads the rows (and the view filters still work); the last good meta is kept', async () => {
  const board = fakeBoard([item(1, { stage: 1, phase: 6 }), item(2, { stage: 8 })]);
  const restoreClock = useClock();
  const warn = console.warn; const warned = []; console.warn = (m) => warned.push(String(m));
  try {
    reset();
    // keep no older meta for the first part
    board.metaFails = true;
    const s = await dash.getDashboardStats();
    assert.equal(s.cases.length, 2, 'rows loaded');
    assert.deepEqual(s.cases[0].views, ['assigning', 'deadlines'], 'filters work without the meta');
    assert.ok(warned.some((m) => /board meta read failed/.test(m)), 'a warning is logged');
    // a good read, then a failing one: the good meta stays
    board.metaFails = false; clock += 61 * 1000; reset();
    const good = await dash.getDashboardStats();
    assert.ok(good.meta && good.meta.groups.length === 4);
    board.metaFails = true; clock += 61 * 1000; reset();
    const again = await dash.getDashboardStats();
    assert.deepEqual(again.meta, good.meta, 'the headings keep the last good order');
  } finally { console.warn = warn; restoreClock(); board.restore(); reset(); }
});

test('the first meta read failing gives meta null (the page falls back), not an error', async () => {
  // a fresh module copy so no earlier good meta exists
  const path = require.resolve('../src/services/dashboardService');
  delete require.cache[path];
  const fresh = require('../src/services/dashboardService');
  const board = fakeBoard([item(1)]);
  const warn = console.warn; console.warn = () => {};
  try {
    board.metaFails = true;
    const s = await fresh.getDashboardStats();
    assert.equal(s.meta, null);
    assert.equal(s.cases.length, 1);
    assert.equal(fresh.getCasesMeta(), null);
  } finally { console.warn = warn; board.restore(); delete require.cache[path]; require('../src/services/dashboardService'); }
});

test('dataAt is when Monday was read (the read\'s start), not when the read landed nor when the answer was made', async () => {
  const board = fakeBoard([item(1)]);
  const restoreClock = useClock();
  try {
    reset();
    const readAt = clock;
    board.onListing = () => { clock += 12 * 1000; };    // the board read takes 12 s
    await dash.getDashboardStats();
    board.onListing = null;
    clock += 30 * 1000;                                  // later: still served from the copy
    const s = await dash.getDashboardStats();
    assert.equal(s.dataAt, new Date(readAt).toISOString(), 'every cell is at least this new');
    assert.notEqual(s.dataAt, s.generatedAt);
    assert.equal(board.listings(), 1, 'no second read');
  } finally { restoreClock(); board.restore(); reset(); }
});

test('Refresh (fresh) asks Monday again only when the copy is older than 30 s, and shares a read already in flight', async () => {
  const board = fakeBoard([item(1)]);
  const restoreClock = useClock();
  try {
    reset();
    await dash.getDashboardStats();
    assert.equal(board.listings(), 1);
    clock += 10 * 1000;
    const young = await dash.getDashboardStats(undefined, { fresh: true });
    assert.equal(board.listings(), 1, '10 s old: the copy is served');
    clock += 21 * 1000;                                  // 31 s old
    board.items.push(item(2));
    board.holdNext = true;
    const a = dash.getDashboardStats(undefined, { fresh: true });
    await tick();
    const b = dash.getDashboardStats(undefined, { fresh: true });   // a second click while the read is in flight
    await tick();
    assert.equal(board.listings(), 2, 'one new read, shared');
    const startedAt = clock;
    clock += 2000;
    board.release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(ra.cases.map((c) => c.id), ['1', '2'], 'the new row is there');
    assert.deepEqual(rb.cases.map((c) => c.id), ['1', '2']);
    assert.equal(ra.dataAt, new Date(startedAt).toISOString(), 'dataAt moved to the new read');
    assert.notEqual(ra.dataAt, young.dataAt);
    // a plain load is still cache-first
    clock += 40 * 1000;
    await dash.getDashboardStats();
    assert.equal(board.listings(), 2, 'a plain load under 60 s never re-reads');
  } finally { restoreClock(); board.restore(); reset(); }
});

test('Refresh: a failed re-read serves the copy in hand (its time says how old it is)', async () => {
  const board = fakeBoard([item(1)]);
  const restoreClock = useClock();
  const warn = console.warn; console.warn = () => {};
  try {
    reset();
    const readAt = clock;
    await dash.getDashboardStats();
    clock += 35 * 1000;
    const orig = mondayApi.query;
    mondayApi.query = async () => { throw new Error('Monday 503'); };
    const s = await dash.getDashboardStats(undefined, { fresh: true });
    mondayApi.query = orig;
    assert.equal(s.cases.length, 1);
    assert.equal(s.dataAt, new Date(readAt).toISOString());
  } finally { console.warn = warn; restoreClock(); board.restore(); reset(); }
});

test('Refresh past the 20-minute hard limit waits for a fresh read, and a failure shows as one (never 45-min-old rows quietly)', async () => {
  const board = fakeBoard([item(1)]);
  const restoreClock = useClock();
  const warn = console.warn; console.warn = () => {};
  try {
    reset();
    await dash.getDashboardStats();
    clock += dash._casesIo.CASES_HARD_MS + 60 * 1000;
    const orig = mondayApi.query;
    mondayApi.query = async () => { throw new Error('Monday 503'); };
    await assert.rejects(dash.getDashboardStats(undefined, { fresh: true }), /Monday 503/);
    await assert.rejects(dash.getDashboardStats(), /Monday 503/, 'the plain load says it too');
    mondayApi.query = orig;
    board.items.push(item(2));
    const s = await dash.getDashboardStats(undefined, { fresh: true });
    assert.deepEqual(s.cases.map((c) => c.id), ['1', '2']);
  } finally { console.warn = warn; restoreClock(); board.restore(); reset(); }
});

test('an invalidation still wins over Refresh: the next load waits for a read begun after it', async () => {
  const board = fakeBoard([item(1), item(2)]);
  const restoreClock = useClock();
  try {
    reset();
    await dash.getDashboardStats();
    // an OLDER background read begins (its listing still has both cases)…
    clock += 61 * 1000;
    board.holdNext = true;
    await dash.getDashboardStats();
    await tick();
    assert.equal(board.listings(), 2, 'an older background read is in flight');
    // …then a case is deleted, and the copy is more than 30 s old (so Refresh would re-read)
    board.items = [item(1)];
    dash.invalidateCases();
    const invAt = clock;
    clock += 1000;
    const p = dash.getDashboardStats(undefined, { fresh: true });
    await tick();
    board.release();
    const s = await p;
    assert.deepEqual(s.cases.map((c) => c.id), ['1']);
    assert.ok(Date.parse(s.dataAt) >= invAt + 1000, 'the answer comes from a read begun after the invalidation, not the older one it could have joined');
  } finally { board.holdNext = false; while (board.holds.length) board.release(); restoreClock(); board.restore(); reset(); }
});

test('patchCachedColumn: the row changes at once (officer, ids, RBAC assignees, views) without re-reading the board', async () => {
  const board = fakeBoard([item(1, { cso: people(111), csoText: 'Old Person' }), item(2)]);
  const restoreClock = useClock();
  try {
    reset();
    await dash.getDashboardStats();
    const n = board.calls.length;
    assert.equal(dash.patchCachedColumn('1', CSO, { value: people(333), text: 'New Person' }), true);
    assert.equal(dash.patchCachedColumn('999', CSO, { value: people(333), text: 'X' }), false, 'not in the copy: nothing patched');
    dash._casesIo.overrides.delete('999|' + CSO);
    const s = await dash.getDashboardStats();
    const r = s.cases.find((c) => c.id === '1');
    assert.equal(r.officer, 'New Person');
    assert.deepEqual(r.officerIds, { personIds: ['333'], teamIds: [] });
    assert.deepEqual(r.assignees.personIds, ['333'], 'RBAC follows the patch');
    assert.equal(board.calls.length, n, 'no Monday read');
    // RBAC on the patched value
    const prev = process.env.CASE_VISIBILITY; process.env.CASE_VISIBILITY = 'assigned';
    try {
      assert.deepEqual((await dash.getDashboardStats({ userId: '333', teamIds: [], isAdmin: false })).cases.map((c) => c.id), ['1']);
      assert.deepEqual((await dash.getDashboardStats({ userId: '111', teamIds: [], isAdmin: false })).cases.map((c) => c.id), []);
    } finally { if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev; }
    // never an invalidation: the patch module never calls it
    const src = require('fs').readFileSync(require.resolve('../src/services/dashboardService'), 'utf8');
    const body = src.slice(src.indexOf('function patchCachedColumn'), src.indexOf('function _refreshCases'));
    assert.ok(!/invalidateCases|_casesGen/.test(body), 'a patch never invalidates the copy');
  } finally { restoreClock(); board.restore(); reset(); }
});

test('patchCachedColumn: a parsed value object is stored as Monday\'s JSON string (parseItem reads it the same)', async () => {
  const board = fakeBoard([item(1, { cso: people(111), csoText: 'Old Person' })]);
  const restoreClock = useClock();
  try {
    reset();
    await dash.getDashboardStats();
    dash.patchCachedColumn('1', CSO, { value: { personsAndTeams: [{ id: 333, kind: 'person' }] }, text: 'New Person' });
    const r = (await dash.getDashboardStats()).cases[0];
    assert.deepEqual(r.officerIds, { personIds: ['333'], teamIds: [] });
    assert.deepEqual(r.assignees.personIds, ['333']);
    dash.patchCachedColumn('1', CSO, { value: null, text: null });
    const e = (await dash.getDashboardStats()).cases[0];
    assert.deepEqual(e.officerIds, { personIds: [], teamIds: [] }, 'cleared');
    assert.equal(e.officer, '');
  } finally { restoreClock(); board.restore(); reset(); }
});

test('the patch survives an OLDER in-flight read; a read that began after the patch drops the override', async () => {
  const board = fakeBoard([item(1, { cso: people(111), csoText: 'Old Person' })]);
  const restoreClock = useClock();
  try {
    reset();
    await dash.getDashboardStats();
    // a background read begins (it will bring the OLD officer)…
    clock += 61 * 1000;
    board.holdNext = true;
    await dash.getDashboardStats();                      // > 60 s: served from the copy, background refresh starts
    await tick();
    assert.equal(board.listings(), 2, 'background read in flight');
    // …then the Assign lands
    clock += 1000;
    dash.patchCachedColumn('1', CSO, { value: people(333), text: 'New Person' });
    // Monday now has the new value, but the in-flight read captured its listing earlier and reads items now:
    // make its item read return the OLD value to prove the override, not Monday, keeps the new one
    board.release();
    await tick(); await tick();
    let s = await dash.getDashboardStats();
    assert.equal(s.cases[0].officer, 'New Person', 'the older read did not bring the old officer back');
    assert.equal(dash._casesIo.overrides.size, 1, 'kept until a read that began after the patch');
    // a read that began AFTER the patch: Monday's value wins (here someone changed it again by hand)
    board.items = [item(1, { cso: people(444), csoText: 'Hand Changed' })];
    clock += 31 * 1000;
    s = await dash.getDashboardStats(undefined, { fresh: true });
    assert.equal(s.cases[0].officer, 'Hand Changed');
    assert.equal(dash._casesIo.overrides.size, 0, 'override dropped');
  } finally { restoreClock(); board.restore(); reset(); }
});

test('an override never outlives 20 minutes', async () => {
  const board = fakeBoard([item(1, { cso: people(111), csoText: 'Old Person' })]);
  const restoreClock = useClock();
  try {
    reset();
    await dash.getDashboardStats();
    clock += 61 * 1000;
    board.holdNext = true;
    await dash.getDashboardStats();                      // background read starts (old value)
    await tick();
    clock += 1000;
    dash.patchCachedColumn('1', CSO, { value: people(333), text: 'New Person' });
    clock += dash._casesIo.OVERRIDE_MAX_MS + 1000;       // the read lands 20+ min later
    board.release();
    await tick(); await tick();
    assert.equal(dash._casesIo.overrides.size, 0);
    const s = await dash.getDashboardStats(undefined, {});
    assert.equal(s.cases[0].officer, 'Old Person', 'after 20 min the board read is believed');
  } finally { restoreClock(); board.restore(); reset(); }
});

test('the read asks for the group and the new columns, every items(ids:) with an explicit limit', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/dashboardService'), 'utf8');
  assert.match(src, /items\(ids: \$ids, limit: \$\{CASES_BATCH\}\) \{ id name created_at group \{ id title \} column_values/);
  for (const id of ['color_mm3tf1ys', 'color_mm6w7cdd', 'date_mm33sj6t', 'date_mm3t66pa', 'multiple_person_mm0xm710']) assert.ok(src.includes(`'${id}'`), id);
  for (const id of ['date_mm0x26t4', 'date_mm0xfgbp']) assert.ok(!src.includes(id), `${id} (Soft / Prep Deadline, SLA outputs) is not read`);
  assert.equal((src.match(/items\(ids:/g) || []).length, (src.match(/items\(ids: \$ids, limit:/g) || []).length, 'every items(ids:) has a limit');
  assert.deepEqual(dash.COLS.actualDeadline, 'date_mm33sj6t');
  assert.deepEqual(dash.COLS.promisedDate, 'date_mm3t66pa');
});

test('the dashboard-stats route passes Refresh through (fresh=1 only)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(src, /getDashboardStats\(viewer\.scope === 'all' \? undefined : viewer, \{ fresh: req\.query\.fresh === '1', contact: req\.query\.contact === '1' \}\)/);
});
