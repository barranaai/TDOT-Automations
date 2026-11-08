'use strict';

// Assign the Case Support Officer from the Client Master page (block 3, step 3).
// Every Monday call goes through a fake mondayApi.query (no network): the tests
// read the EXACT mutation the service sends, and that nothing else is written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const mondayApi = require('../src/services/mondayApi');
const dashboardService = require('../src/services/dashboardService');
const svc = require('../src/services/caseAssignService');
const { clientMasterBoardId } = require('../config/monday');

const OFFICER = 'multiple_person_mm0xm710';
const ITEM = '5550001';
const ppl = (...ids) => JSON.stringify({ personsAndTeams: ids.map((x) => (typeof x === 'object' ? x : { id: Number(x), kind: 'person' })) });

const USERS = [
  { id: 1, name: 'Barrana AI', enabled: true, is_pending: false, is_view_only: false },     // the token's own account (me)
  { id: 11, name: 'Asha Officer', enabled: true, is_pending: false, is_view_only: false },
  { id: 12, name: 'Bo <Officer>', enabled: true, is_pending: false, is_view_only: false },
  { id: 13, name: 'Chen Officer', enabled: true, is_pending: false, is_view_only: false },
  { id: 21, name: 'Gone Person', enabled: false, is_pending: false, is_view_only: false },
  { id: 22, name: 'Pending Person', enabled: true, is_pending: true, is_view_only: false },
  { id: 23, name: 'Viewer Person', enabled: true, is_pending: false, is_view_only: true },
];
const STAFF = { id: '11', name: 'Asha Officer', email: 'asha@example.com', teamIds: [] };

/** A fake Monday: the item, what each call did, and switches for failures. */
function fakeMonday(o = {}) {
  const st = {
    item: { id: ITEM, name: 'Client X', state: 'active', board: { id: String(clientMasterBoardId) }, officer: ppl(12), officerText: 'Bo <Officer>', otherPeople: {} },
    writes: [], notes: [], reads: 0, readBacks: 0, calls: [], keep: true, ...o,
  };
  if (o.item) st.item = { ...{ id: ITEM, name: 'Client X', state: 'active', board: { id: String(clientMasterBoardId) }, officer: ppl(12), officerText: 'Bo <Officer>', otherPeople: {} }, ...o.item };
  mondayApi.query = async (gql, vars, retries) => {
    st.calls.push({ gql, vars, retries });
    if (/users\(kind: non_guests/.test(gql)) {
      if (st.usersFail) throw new Error('boom');
      const all = st.users || USERS, page = (vars && vars.p) || 1;
      st.userPages = (st.userPages || 0) + 1;
      return { ...(page === 1 ? { me: { id: '1' } } : {}), users: all.slice((page - 1) * 200, page * 200) };
    }
    if (/^mutation/.test(gql) && /change_multiple_column_values/.test(gql)) {
      if (st.writeFail) throw new Error('timeout');
      st.writes.push({ gql, vars, retries });
      if (st.keep) { const c = JSON.parse(vars.c)[OFFICER]; st.item.officer = JSON.stringify(c); st.item.officerText = USERS.find((u) => u.id === c.personsAndTeams[0].id).name; }
      return { change_multiple_column_values: { id: vars.i } };
    }
    if (/^mutation/.test(gql) && /create_update/.test(gql)) {
      st.notes.push({ vars, retries });
      if (st.noteFail) throw new Error('note timeout');
      return { create_update: { id: '9' } };
    }
    if (/column_values\(ids: \["multiple_person_mm0xm710"\]\)/.test(gql)) {
      st.readBacks++;
      if (st.readBackFail) throw new Error('network');
      return { items: [{ id: vars.ids[0], column_values: [{ id: OFFICER, text: st.item.officerText, value: st.item.officer }] }] };
    }
    if (/items\(ids: \$ids, limit: 1\) \{ id name state board/.test(gql)) {
      st.reads++;
      if (st.missing) return { items: [] };
      const it = st.item;
      const cvs = [{ id: OFFICER, text: it.officerText, value: it.officer }, { id: 'text_mm142s49', text: '2026-TEST-001', value: null }];
      for (const [k, v] of Object.entries(it.otherPeople)) cvs.push({ id: k, text: '', value: v });
      return { items: [{ id: it.id, name: it.name, state: it.state, board: it.board, column_values: cvs }] };
    }
    throw new Error('unexpected Monday call: ' + gql.slice(0, 80));
  };
  return st;
}

const realQuery = mondayApi.query, realPatch = dashboardService.patchCachedColumn, realInvalidate = dashboardService.invalidateCases;
let patches = [], invalidations = 0;
test.beforeEach(() => {
  svc._resetUsers(); svc._inFlight.clear();
  patches = []; invalidations = 0;
  dashboardService.patchCachedColumn = (itemId, colId, cell) => { patches.push({ itemId, colId, cell }); return true; };
  dashboardService.invalidateCases = () => { invalidations++; };
  delete process.env.CASE_VISIBILITY; delete process.env.ADMIN_EMAILS;
});
test.after(() => { mondayApi.query = realQuery; dashboardService.patchCachedColumn = realPatch; dashboardService.invalidateCases = realInvalidate; delete process.env.CASE_VISIBILITY; delete process.env.ADMIN_EMAILS; });

const body = (o = {}) => ({ itemId: ITEM, userId: '13', expected: { personIds: ['12'], teamIds: [] }, ...o });
async function refused(p, status, re) {
  await assert.rejects(svc.assign(p), (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.body.error, re); return true; });
}

// ── who ──
test('nobody signed in → 401 with the sign-in link; the shared key alone → 403 (the note must name a person)', async () => {
  const m = fakeMonday();
  await assert.rejects(svc.assign({ staff: null, hasKey: false, body: body() }), (e) => e.status === 401 && /^\/q\/auth\/monday/.test(e.body.loginUrl));
  await refused({ staff: null, hasKey: true, body: body() }, 403, /Sign in with Monday to assign, so the note can say who did it/);
  assert.equal(m.calls.length, 0, 'no Monday call before the sign-in check');
});

test('under "assigned": a staffer not on the case → 403, and the shared key does not count for the write', async () => {
  process.env.CASE_VISIBILITY = 'assigned';
  const m = fakeMonday({ item: { otherPeople: { multiple_person_mm0xhmgk: ppl(99) } } });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 403, /You are not assigned to this case/);
  await refused({ staff: STAFF, hasKey: true, body: body() }, 403, /You are not assigned to this case/);
  assert.equal(m.writes.length, 0); assert.equal(m.notes.length, 0);
});

test('under "assigned": the check runs on the FRESH people columns (assigned now → allowed), and ADMIN_EMAILS counts', async () => {
  process.env.CASE_VISIBILITY = 'assigned';
  let m = fakeMonday({ item: { otherPeople: { multiple_person_mm0xhmgk: ppl(11) } } });
  assert.equal((await svc.assign({ staff: STAFF, hasKey: false, body: body() })).ok, true);
  svc._resetUsers();
  process.env.ADMIN_EMAILS = 'boss@example.com';
  m = fakeMonday();
  const r = await svc.assign({ staff: { id: '77', name: 'Boss', email: 'boss@example.com' }, hasKey: false, body: body() });
  assert.equal(r.ok, true); assert.equal(m.writes.length, 1);
});

// ── validate ──
test('400 for anyone who is not an assignable staff member: unknown, guest, disabled, pending, view-only, the app\'s own account', async () => {
  for (const uid of ['999', '31', '21', '22', '23', '1']) {
    const m = fakeMonday();
    await refused({ staff: STAFF, hasKey: false, body: body({ userId: uid }) }, 400, /Not a staff member/);
    assert.equal(m.reads, 0, uid + ': no case read'); assert.equal(m.writes.length, 0);
  }
});

test('400 for a malformed body (ids not digits, expected missing)', async () => {
  fakeMonday();
  await refused({ staff: STAFF, hasKey: false, body: body({ itemId: '12; drop' }) }, 400);
  await refused({ staff: STAFF, hasKey: false, body: body({ userId: '' }) }, 400);
  await refused({ staff: STAFF, hasKey: false, body: body({ expected: null }) }, 400, /Reload the page/);
  await refused({ staff: STAFF, hasKey: false, body: body({ expected: { personIds: ['x'], teamIds: [] } }) }, 400);
});

test('the staff list: enabled people only, never the app\'s own account, A → Z, read once an hour for the pop-up', async () => {
  const m = fakeMonday();
  const u = await svc.assignableUsers();
  assert.deepEqual(u.list.map((x) => x.id), ['11', '12', '13']);
  await svc.assignableUsers();
  assert.equal(m.calls.filter((c) => /users\(kind/.test(c.gql)).length, 1, 'cached');
});

test('the people-cell parser is the one the Cases rows use (the stale check and the page never disagree)', () => {
  assert.equal(svc.peopleOf.toString().includes("require('./dashboardService').peopleIds"), true);
  assert.deepEqual(svc.peopleOf(ppl(12, { id: 5, kind: 'team' }, 12)), { personIds: ['12'], teamIds: ['5'] });
  assert.deepEqual(svc.peopleOf(null), { personIds: [], teamIds: [] });
});

// ── the case ──
test('404 when the case is archived, on another board, missing, or Monday gives back another item', async () => {
  for (const item of [{ state: 'archived' }, { board: { id: '1' } }, { id: '999' }]) {
    const m = fakeMonday({ item });
    await refused({ staff: STAFF, hasKey: false, body: body() }, 404, /not found on the Client Master board/);
    assert.equal(m.writes.length, 0);
  }
  const m = fakeMonday({ missing: true });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 404);
  assert.equal(m.writes.length, 0);
});

test('409 while the same case is being assigned', async () => {
  fakeMonday();
  svc._inFlight.add(ITEM);
  await refused({ staff: STAFF, hasKey: false, body: body() }, 409, /already being assigned/);
});

test('409 "changed": the value on Monday is not the one the page showed → the current value comes back and the cache is patched; nothing written', async () => {
  const m = fakeMonday({ item: { officer: ppl(11, 13), officerText: 'Asha Officer, Chen Officer' } });
  await assert.rejects(svc.assign({ staff: STAFF, hasKey: false, body: body() }), (e) => {
    assert.equal(e.status, 409); assert.equal(e.body.code, 'changed');
    assert.deepEqual(e.body.current, { names: ['Asha Officer', 'Chen Officer'], personIds: ['11', '13'], teamIds: [] });
    assert.match(e.body.error, /it is now Asha Officer, Chen Officer/);
    assert.ok(!/a moment ago/.test(e.body.error));
    return true;
  });
  assert.equal(m.writes.length, 0); assert.equal(m.notes.length, 0);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0], { itemId: ITEM, colId: OFFICER, cell: { value: ppl(11, 13), text: 'Asha Officer, Chen Officer' } });
  // expected compared as SETS (order does not matter); a team on Monday that the page did not know is a change
  fakeMonday({ item: { officer: ppl(13, 11), officerText: 'Chen Officer, Asha Officer' } });
  assert.equal((await svc.assign({ staff: STAFF, hasKey: false, body: body({ userId: '12', expected: { personIds: ['11', '13'], teamIds: [] } }) })).ok, true);
  fakeMonday({ item: { officer: ppl(12, { id: 5, kind: 'team' }), officerText: 'Bo <Officer>, Team' } });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 409, /changed since your page loaded/);
});

test('200 unchanged when that person already is the one officer: no write, no note', async () => {
  const m = fakeMonday();
  const r = await svc.assign({ staff: STAFF, hasKey: false, body: body({ userId: '12' }) });
  assert.equal(r.unchanged, true);
  assert.equal(m.writes.length, 0); assert.equal(m.notes.length, 0); assert.equal(patches.length, 0);
});

// ── the write ──
test('success: ONE mutation, on the Client Master board, the item Monday gave back, exactly one key = Case Support Officer, one person (replace)', async () => {
  const m = fakeMonday({ item: { officer: ppl(11, 12, { id: 5, kind: 'team' }), officerText: 'Asha Officer, Bo <Officer>, Ops Team' } });
  const r = await svc.assign({ staff: STAFF, hasKey: false, body: body({ expected: { personIds: ['12', '11'], teamIds: ['5'] } }) });
  assert.deepEqual(r, { ok: true, officer: { names: ['Chen Officer'], personIds: ['13'], teamIds: [] }, canAssign: true });
  assert.equal(m.writes.length, 1);
  const w = m.writes[0];
  assert.match(w.gql, /change_multiple_column_values\(board_id: \$b, item_id: \$i, column_values: \$c\)/);
  assert.ok(!/create_labels_if_missing|change_simple_column_value|change_column_value\b/.test(w.gql));
  assert.equal(w.vars.b, String(clientMasterBoardId));
  assert.equal(w.vars.i, ITEM);
  const cols = JSON.parse(w.vars.c);
  assert.deepEqual(Object.keys(cols), [OFFICER], 'one column only');
  assert.deepEqual(cols[OFFICER], { personsAndTeams: [{ id: 13, kind: 'person' }] });
  assert.equal(typeof cols[OFFICER].personsAndTeams[0].id, 'number');
  // no other mutation of any kind except the one note
  const muts = m.calls.filter((c) => /^mutation/.test(c.gql));
  assert.equal(muts.length, 2); assert.match(muts[1].gql, /create_update/);
  // the cache is PATCHED with the read-back, never invalidated
  assert.equal(invalidations, 0);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0], { itemId: ITEM, colId: OFFICER, cell: { value: ppl(13), text: 'Chen Officer' } });
  // every items(ids:) read has an explicit limit
  for (const c of m.calls.filter((x) => /items\(ids:/.test(x.gql))) assert.match(c.gql, /items\(ids: \$ids, limit: 1\)/);
});

test('the note: old → new (every removed officer, escaped), who did it, Toronto time — sent once, never retried', async () => {
  const m = fakeMonday({ item: { officer: ppl(11, 12), officerText: 'Asha Officer, Bo <Officer>' } });
  await svc.assign({ staff: { id: '11', name: 'Asha <b>Officer</b>', email: 'asha@example.com' }, hasKey: true, body: body({ expected: { personIds: ['11', '12'], teamIds: [] } }) });
  assert.equal(m.notes.length, 1);
  const n = m.notes[0];
  assert.equal(n.retries, 0, 'retries 0');
  assert.equal(n.vars.i, ITEM);
  assert.match(n.vars.b, /^👤 <b>Case Support Officer set<\/b>: Asha Officer, Bo &lt;Officer&gt; → Chen Officer\. Assigned on the Client Master page by Asha &lt;b&gt;Officer&lt;\/b&gt; · \d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} (am|pm) \(Toronto\)\.$/);
  assert.ok(!/Unidentified|shared admin key/.test(n.vars.b), 'the Monday person, never the key');
});

test('the note says "nobody" when the case had no officer', async () => {
  const m = fakeMonday({ item: { officer: null, officerText: '' } });
  await svc.assign({ staff: STAFF, hasKey: false, body: body({ expected: { personIds: [], teamIds: [] } }) });
  assert.match(m.notes[0].vars.b, /Case Support Officer set<\/b>: nobody → Chen Officer\./);
});

test('a failed note → 200 noteFailed (the officer IS set); the cache still follows the read-back', async () => {
  const m = fakeMonday({ noteFail: true });
  const r = await svc.assign({ staff: STAFF, hasKey: false, body: body() });
  assert.equal(r.ok, true); assert.equal(r.noteFailed, true);
  assert.equal(m.notes.length, 1, 'tried once');
  assert.equal(patches.length, 1);
});

test('502 when Monday did not keep the change: no note, no second write', async () => {
  const m = fakeMonday({ keep: false });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 502, /Monday did not keep the change — check the case in Monday before trying again\. Nothing else was touched\./);
  assert.equal(m.writes.length, 1); assert.equal(m.notes.length, 0); assert.equal(patches.length, 0);
  assert.equal(svc._inFlight.size, 0, 'the lock is released');
});

test('502 "result unknown" when the read-back cannot be read (the write may have landed): no note, no patch, never "did not keep"', async () => {
  const m = fakeMonday({ readBackFail: true });
  await assert.rejects(svc.assign({ staff: STAFF, hasKey: false, body: body() }), (e) => {
    assert.equal(e.status, 502); assert.match(e.body.error, /^The result is unknown — check the case in Monday before trying again/); assert.ok(!/did not keep/.test(e.body.error)); return true;
  });
  assert.equal(m.writes.length, 1); assert.equal(m.notes.length, 0); assert.equal(patches.length, 0); assert.equal(svc._inFlight.size, 0);
});

test('the staff list is read page by page (200 a page), never cut at the first page', async () => {
  const many = Array.from({ length: 230 }, (_, i) => ({ id: 1000 + i, name: 'Person ' + String(i).padStart(3, '0'), enabled: true, is_pending: false, is_view_only: false }));
  const m = fakeMonday({ users: many });
  const u = await svc.assignableUsers({ fresh: true });
  assert.equal(u.list.length, 230); assert.equal(m.userPages, 2);
  assert.ok(m.calls.filter((c) => /users\(kind/.test(c.gql)).every((c) => /limit: 200, page: \$p/.test(c.gql)));
});

const userReads = (m) => m.calls.filter((c) => /users\(kind/.test(c.gql)).length;

test('a write uses the cached staff list (plan §5.4 step 2): a warm cache and a failing Monday user read still assign, with no user read', async () => {
  const m = fakeMonday();
  await svc.assignableUsers();   // the pop-up's list (kept an hour)
  m.usersFail = true;
  const before = userReads(m);
  const r = await svc.assign({ staff: STAFF, hasKey: false, body: body() });
  assert.equal(r.ok, true); assert.equal(m.writes.length, 1);
  assert.equal(userReads(m), before, 'no Monday user read');
});

test('a busy case (409) costs no Monday call at all — not even the staff list', async () => {
  const m = fakeMonday();
  svc._inFlight.add(ITEM);
  await refused({ staff: STAFF, hasKey: false, body: body() }, 409, /already being assigned/);
  assert.equal(m.calls.length, 0);
  // and with an empty cache too
  svc._resetUsers();
  await refused({ staff: STAFF, hasKey: false, body: body() }, 409, /already being assigned/);
  assert.equal(userReads(m), 0);
});

test('someone not on the cached list (added to Monday since) triggers ONE fresh read, then is assigned', async () => {
  const m = fakeMonday();
  m.users = USERS.filter((u) => u.id !== 13);
  await svc.assignableUsers();   // the cached list does not have Chen (13)
  m.users = USERS;               // Chen is added in Monday
  const before = userReads(m);
  const r = await svc.assign({ staff: STAFF, hasKey: false, body: body() });
  assert.equal(r.ok, true); assert.equal(m.writes.length, 1);
  assert.equal(userReads(m), before + 1, 'one fresh read');
  // still not on the list after that read → 400, the lock released
  await refused({ staff: STAFF, hasKey: false, body: body({ userId: '999' }) }, 400, /Not a staff member/);
  assert.equal(svc._inFlight.size, 0);
});

test('502 only when there is no usable list: an empty or hour-old cache and a failing read; nothing read or written, lock released', async () => {
  const m = fakeMonday({ usersFail: true });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 502, /staff list could not be read/);
  assert.equal(m.reads, 0); assert.equal(m.writes.length, 0); assert.equal(svc._inFlight.size, 0);
  // an hour-old cache is not used
  const realNow = svc._io.now;
  let t = Date.parse('2026-11-08T15:00:00Z');
  svc._io.now = () => t;
  try {
    m.usersFail = false;
    await svc.assignableUsers();
    t += 60 * 60 * 1000 + 1;
    m.usersFail = true;
    await refused({ staff: STAFF, hasKey: false, body: body() }, 502, /staff list could not be read/);
    assert.equal(m.writes.length, 0);
  } finally { svc._io.now = realNow; }
});

test('the answer says whether this person may still assign the case (under "assigned" they can take themselves off it)', async () => {
  process.env.CASE_VISIBILITY = 'assigned';
  // Asha (11) is on the case only as its Support Officer and hands it to Chen (13)
  fakeMonday({ item: { officer: ppl(11), officerText: 'Asha Officer' } });
  let r = await svc.assign({ staff: STAFF, hasKey: false, body: body({ expected: { personIds: ['11'], teamIds: [] } }) });
  assert.equal(r.ok, true); assert.equal(r.canAssign, false);
  // still Case Manager → still allowed
  svc._resetUsers();
  fakeMonday({ item: { officer: ppl(11), officerText: 'Asha Officer', otherPeople: { multiple_person_mm0xhmgk: ppl(11) } } });
  r = await svc.assign({ staff: STAFF, hasKey: false, body: body({ expected: { personIds: ['11'], teamIds: [] } }) });
  assert.equal(r.canAssign, true);
});

test('502 "result unknown" when the write itself fails: no note, no patch', async () => {
  const m = fakeMonday({ writeFail: true });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 502, /result is unknown/);
  assert.equal(m.notes.length, 0); assert.equal(patches.length, 0); assert.equal(svc._inFlight.size, 0);
});

test('the item id written is the one Monday gave back, and the body cannot add columns', async () => {
  const m = fakeMonday();
  await svc.assign({ staff: STAFF, hasKey: false, body: { ...body(), columns: { color_mm3tf1ys: { index: 1 } }, boardId: '1', column_values: '{"x":1}' } });
  assert.equal(m.writes.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(m.writes[0].vars.c)), [OFFICER]);
  assert.equal(m.writes[0].vars.b, String(clientMasterBoardId));
});

// ── the page's button flags ──
test('markAssignable: key only → no button anywhere; a Monday sign-in → every row (policy "all")', () => {
  const rows = () => [{ assignees: { personIds: ['11'], teamIds: [] } }, { assignees: { personIds: [], teamIds: [] } }];
  let r = rows();
  assert.equal(svc.markAssignable(r, null), false);
  assert.deepEqual(r.map((x) => x.canAssign), [false, false]);
  r = rows();
  assert.equal(svc.markAssignable(r, STAFF), true);
  assert.deepEqual(r.map((x) => x.canAssign), [true, true]);
});

test('markAssignable under "assigned": only the rows the Monday person is on (even with the key on the page)', () => {
  process.env.CASE_VISIBILITY = 'assigned';
  const r = [{ assignees: { personIds: ['11'], teamIds: [] } }, { assignees: { personIds: ['99'], teamIds: [] } }, { assignees: { personIds: [], teamIds: ['7'] } }];
  assert.equal(svc.markAssignable(r, { ...STAFF, teamIds: ['7'] }), true);
  assert.deepEqual(r.map((x) => x.canAssign), [true, false, true]);
});

test('the routes: dashboard-stats sends viewer.canAssign from the Monday sign-in; assign + staff list are behind the same gate', () => {
  const src = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const i = src.indexOf("app.get('/admin/dashboard-stats'");
  const ds = src.slice(i, i + 1400);
  assert.match(ds, /markAssignable\(stats\.cases, tryStaffAuth\(req\)\)/);
  assert.match(ds, /viewer: \{[^}]*canAssign \}/);
  const a = src.indexOf("app.post('/admin/client-master/assign'");
  assert.ok(a > 0);
  assert.match(src.slice(a, a + 500), /caseAssignService'\)\.assign\(\{ staff, hasKey, body: req\.body \}\)/);
  const u = src.indexOf("app.get('/admin/client-master/assignable-users'");
  assert.match(src.slice(u, u + 500), /svc\.gate\(staff, hasKey\)/);
  // the write path never invalidates the Cases copy
  assert.ok(!/invalidateCases/.test(fs.readFileSync(require.resolve('../src/services/caseAssignService'), 'utf8')));
});

test('the dashboard rows (RBAC first) then the flags: a hidden row never reaches the page', async () => {
  process.env.CASE_VISIBILITY = 'assigned';
  const raw = (id, who) => ({ id, name: 'C' + id, created_at: '2026-11-01T00:00:00Z', group: { id: 'group_mm8qqjyz', title: 'November 2026' },
    column_values: [{ id: 'multiple_person_mm0xhmgk', text: '', value: ppl(who) }, { id: 'text_mm142s49', text: '2026-T-' + id, value: null }] });
  const io = dashboardService._casesIo;
  // a cache that is fresh: no Monday read
  const items = [raw('1', 11), raw('2', 99)];
  const realNow = io.io.now;
  io.io.now = () => 1e12;
  try {
    // fill the cache through the module's own read, with a stubbed Monday
    mondayApi.query = async (gql) => {
      if (/items_page/.test(gql)) return { boards: [{ items_page: { cursor: null, items: items.map((x) => ({ id: x.id })) } }] };
      if (/items\(ids: \$ids, limit: 100\)/.test(gql)) return { items };
      if (/groups \{ id title position \}/.test(gql)) return { boards: [{ groups: [], columns: [] }] };
      throw new Error('unexpected ' + gql.slice(0, 60));
    };
    await io.refresh();
    const viewer = { userId: '11', teamIds: [], isAdmin: false, email: 'asha@example.com', name: 'Asha' };
    const stats = await dashboardService.getDashboardStats(viewer);
    svc.markAssignable(stats.cases, STAFF);
    assert.deepEqual(stats.cases.map((c) => [c.id, c.canAssign]), [['1', true]]);
  } finally { io.io.now = realNow; }
});
