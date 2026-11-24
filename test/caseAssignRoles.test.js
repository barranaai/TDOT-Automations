'use strict';

// The case page's "Team on this case" box (Faran 2026-11-24): four roles by stage, ADD alongside, REMOVE one
// person. Every Monday call goes through a fake mondayApi.query (no network); the case lookup is the service's
// own io seam. The tests read the EXACT mutation sent, and that nothing else is ever written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const mondayApi = require('../src/services/mondayApi');
const dashboardService = require('../src/services/dashboardService');
const svc = require('../src/services/caseAssignService');
const { clientMasterBoardId } = require('../config/monday');

const COL = { officer: 'multiple_person_mm0xm710', manager: 'multiple_person_mm0xhmgk', submission: 'multiple_person_mm2nhsx1', ops: 'multiple_person_mm0xp0sq' };
const NEVER = ['multiple_person_mm334yp5', 'multiple_person_mm6rzg0h', 'multiple_person_mm0xgpt', 'multiple_person_mm0xrzve'];
const ITEM = '7770001', REF = '2026-TEST-077';
const ppl = (...ids) => JSON.stringify({ personsAndTeams: ids.map((x) => (typeof x === 'object' ? x : { id: Number(x), kind: 'person' })) });
const T = (id) => ({ id, kind: 'team' });

const USERS = [
  { id: 1, name: 'Barrana AI', enabled: true, is_pending: false, is_view_only: false },
  { id: 11, name: 'Asha Officer', enabled: true, is_pending: false, is_view_only: false },
  { id: 12, name: 'Bo Manager', enabled: true, is_pending: false, is_view_only: false },
  { id: 13, name: 'Chen Sub', enabled: true, is_pending: false, is_view_only: false },
  { id: 14, name: 'Monica Paola', enabled: true, is_pending: false, is_view_only: false },
  { id: 21, name: 'Gone Person', enabled: false, is_pending: false, is_view_only: false },
];
const nameOf = (x) => (x.kind === 'team' ? 'Team ' + x.id : (USERS.find((u) => u.id === x.id) || { name: 'Someone' }).name);
const STAFF = { id: '11', name: 'Asha Officer', email: 'asha@example.com', teamIds: [] };

/** A fake Monday: the item's people cells, what each call did, and switches for failures. */
function fakeMonday(o = {}) {
  const st = { cells: {}, ref: REF, writes: [], notes: [], reads: 0, calls: [], keep: true, ...o };
  st.cells = { ...(o.cells || {}) };
  mondayApi.query = async (gql, vars, retries) => {
    st.calls.push({ gql, vars, retries });
    if (/users\(kind: non_guests/.test(gql)) {
      if (st.usersFail) throw new Error('boom');
      return { me: { id: '1' }, users: USERS };
    }
    if (/^mutation/.test(gql) && /change_multiple_column_values/.test(gql)) {
      st.writes.push({ gql, vars, retries });
      const c = JSON.parse(vars.c);
      const [col] = Object.keys(c);
      if (st.keep === true) st.cells[col] = { value: JSON.stringify(c[col]), text: c[col].personsAndTeams.map(nameOf).join(', ') };
      else if (typeof st.keep === 'function') st.cells[col] = st.keep(col, c[col]);
      return { change_multiple_column_values: { id: vars.i } };
    }
    if (/^mutation/.test(gql) && /create_update/.test(gql)) {
      st.notes.push({ vars, retries });
      if (st.noteFail) throw new Error('note timeout');
      return { create_update: { id: '9' } };
    }
    let m = /column_values\(ids: \["([a-z_0-9]+)"\]\)/.exec(gql);
    if (m) {
      const cv = st.cells[m[1]] || { value: null, text: '' };
      return { items: [{ id: vars.ids[0], column_values: [{ id: m[1], text: cv.text, value: cv.value }] }] };
    }
    if (/items\(ids: \$ids, limit: 1\) \{ id name state board/.test(gql)) {
      st.reads++;
      const cvs = Object.entries(st.cells).map(([id, cv]) => ({ id, text: cv.text, value: cv.value }));
      cvs.push({ id: 'text_mm142s49', text: st.ref, value: null });
      return { items: [{ id: vars.ids[0], name: 'Client X', state: 'active', board: { id: String(clientMasterBoardId) }, column_values: cvs }] };
    }
    throw new Error('unexpected Monday call: ' + gql.slice(0, 80));
  };
  return st;
}

const realQuery = mondayApi.query, realPatch = dashboardService.patchCachedColumn, realInvalidate = dashboardService.invalidateCases, realLookup = svc._io.lookupCase;
let patches = [], invalidations = 0, lookups = [];
test.beforeEach(() => {
  svc._resetUsers(); svc._inFlight.clear();
  patches = []; invalidations = 0; lookups = [];
  dashboardService.patchCachedColumn = (itemId, colId, cell) => { patches.push({ itemId, colId, cell }); return true; };
  dashboardService.invalidateCases = () => { invalidations++; };
  svc._io.lookupCase = async (ref) => { lookups.push(ref); return { itemId: ITEM }; };
  delete process.env.CASE_VISIBILITY; delete process.env.ADMIN_EMAILS;
});
test.after(() => {
  mondayApi.query = realQuery; dashboardService.patchCachedColumn = realPatch; dashboardService.invalidateCases = realInvalidate; svc._io.lookupCase = realLookup;
  delete process.env.CASE_VISIBILITY; delete process.env.ADMIN_EMAILS;
});

const onCase = (body, o = {}) => svc.assignOnCase({ staff: STAFF, hasKey: false, caseRef: REF, ...o, body });
async function refused(p, status, re) {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.body.error, re); return true; });
}

// ── the stage map (pure) ──
test('stageRoles: the role that fits the stage first and highlighted, the others listed, Ops Supervisor last and never highlighted', () => {
  const R = (s) => { const r = svc.stageRoles(s); return [r.highlight.join('+'), r.order.join(',')]; };
  assert.deepEqual(R('Pre-Onboarding'), ['officer', 'officer,manager,submission,ops']);
  assert.deepEqual(R('Document Collection Started'), ['officer', 'officer,manager,submission,ops']);
  assert.deepEqual(R('Internal Review'), ['officer+manager', 'officer,manager,submission,ops'], 'both, the Support Officer first');
  assert.deepEqual(R('Submission Ready'), ['submission', 'submission,officer,manager,ops']);
  assert.deepEqual(R('Stuck'), ['officer', 'officer,manager,submission,ops']);
  assert.deepEqual(R('ADR'), ['officer', 'officer,manager,submission,ops']);
  // round 2 (A4): Submission Preparation highlights the same two as Internal Review
  assert.deepEqual(R('Submission Preparation'), ['officer+manager', 'officer,manager,submission,ops']);
  for (const other of ['Application Submitted', 'Profile Created', 'LMIA', 'LMIA Submitted', 'Cancelled', '', null, 'Not Started']) {
    assert.deepEqual(R(other), ['', 'officer,manager,submission,ops'], `${other}: no highlight, all roles plainly`);
    assert.equal(svc.stageRoles(other).hint, '');
  }
  assert.deepEqual(R('  internal   review '), ['officer+manager', 'officer,manager,submission,ops'], 'spaces and case do not matter');
  assert.ok(!['Pre-Onboarding', 'Internal Review', 'Submission Ready', 'Stuck', 'ADR', 'LMIA'].some((s) => svc.stageRoles(s).highlight.includes('ops')), 'Ops Supervisor is never highlighted');
  assert.match(svc.stageRoles('Internal Review').hint, /Case Support Officer prepares .* then the Case Manager reviews/);
});

test('the whitelist: exactly the four role columns, never Retained by / Dup. of Retained by / Stage Owner / Override Approved By', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(svc.ROLES).map(([k, v]) => [k, v.col])), COL);
  assert.deepEqual(svc.ROLE_KEYS, ['officer', 'manager', 'submission', 'ops']);
  for (const c of NEVER) assert.ok(!fs.readFileSync(require.resolve('../src/services/caseAssignService'), 'utf8').includes(c), c + ' is not in the service at all');
  assert.ok(Object.isFrozen(svc.ROLES) && Object.isFrozen(svc.ROLES.officer));
});

test('a role outside the whitelist (or a column id, or a prototype key) → 400 before ANY Monday call', async () => {
  const m = fakeMonday();
  for (const role of ['retainedBy', 'stageOwner', 'overrideApprovedBy', '__proto__', 'toString', 'constructor', ...NEVER, COL.manager, 'OFFICER']) {
    await refused(onCase({ role, op: 'add', userId: '14', expected: { personIds: [], teamIds: [] } }), 400, /This role cannot be set here/);
    await refused(svc.assign({ staff: STAFF, hasKey: false, body: { itemId: ITEM, role, userId: '14', expected: { personIds: [], teamIds: [] } } }), 400, /This role cannot be set here/);
  }
  await refused(onCase({ role: 'manager', op: 'replace', userId: '14', expected: { personIds: [], teamIds: [] } }), 400);
  assert.equal(m.calls.length, 0); assert.equal(lookups.length, 0);
});

// ── who ──
test('the case route: nobody → 401 with the sign-in link; the shared key alone → 403; no lookup, no Monday call', async () => {
  const m = fakeMonday();
  await assert.rejects(svc.assignOnCase({ staff: null, hasKey: false, caseRef: REF, body: { role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } } }),
    (e) => e.status === 401 && /^\/q\/auth\/monday/.test(e.body.loginUrl));
  await refused(svc.assignOnCase({ staff: null, hasKey: true, caseRef: REF, body: { role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } } }), 403, /Sign in with Monday to assign, so the note can say who did it/);
  assert.equal(m.calls.length, 0); assert.equal(lookups.length, 0);
});

test('under "assigned": a staffer not on the case → 403 (the key does not count); assigned on ANY people column → allowed', async () => {
  process.env.CASE_VISIBILITY = 'assigned';
  let m = fakeMonday({ cells: { [COL.manager]: { value: ppl(99), text: 'X' } } });
  await refused(onCase({ role: 'manager', userId: '14', expected: { personIds: ['99'], teamIds: [] } }, { hasKey: true }), 403, /You are not assigned to this case/);
  assert.equal(m.writes.length, 0);
  m = fakeMonday({ cells: { multiple_person_mm0xgpt: { value: ppl(11), text: 'Asha Officer' } } });   // Stage Owner: read for access, never written
  const r = await onCase({ role: 'submission', userId: '13', expected: { personIds: [], teamIds: [] } });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(JSON.parse(m.writes[0].vars.c)), [COL.submission]);
});

// ── the case: from its number, never from the body ──
test('the route finds the item from the case number: an item id in the body is ignored; a lookup that gives another case → 404, nothing written', async () => {
  let m = fakeMonday({ cells: { [COL.manager]: { value: null, text: '' } } });
  const r = await onCase({ itemId: '1234567', boardId: '1', role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } });
  assert.equal(r.ok, true);
  assert.deepEqual(lookups, [REF]);
  assert.equal(m.writes[0].vars.i, ITEM, 'the looked-up item, not the body');
  assert.equal(m.writes[0].vars.b, String(clientMasterBoardId));
  // the fresh read carries another case number → refused
  m = fakeMonday({ ref: '2026-TEST-999' });
  await refused(onCase({ role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } }), 404, /not found on the Client Master board/);
  assert.equal(m.writes.length, 0); assert.equal(m.notes.length, 0);
  // the same number in other letter case is the same case
  m = fakeMonday({ ref: REF.toLowerCase() });
  assert.equal((await onCase({ role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } })).ok, true);
});

test('the route: an unknown case → 404; a failed lookup → 502; a malformed number → 404 with no lookup', async () => {
  let m = fakeMonday();
  svc._io.lookupCase = async () => null;
  await refused(onCase({ role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } }), 404);
  svc._io.lookupCase = async () => { throw new Error('network'); };
  await refused(onCase({ role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } }), 502, /could not be read from Monday\. Nothing was changed/);
  let asked = 0;
  svc._io.lookupCase = async () => { asked++; return { itemId: ITEM }; };
  await refused(onCase({ role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } }, { caseRef: '2026"; drop' }), 404);
  await refused(onCase({ role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } }, { caseRef: '' }), 404);
  assert.equal(asked, 0); assert.equal(m.writes.length, 0);
});

// ── add ──
test('ADD: the persons AND teams there stay, the new person is appended — one mutation, one column; note, patch, answer', async () => {
  const m = fakeMonday({ cells: { [COL.manager]: { value: ppl(12, T(5)), text: 'Bo Manager, Team 5' } } });
  const r = await onCase({ role: 'manager', op: 'add', userId: '14', expected: { personIds: ['12'], teamIds: ['5'] } });
  assert.equal(m.writes.length, 1);
  const cols = JSON.parse(m.writes[0].vars.c);
  assert.deepEqual(Object.keys(cols), [COL.manager], 'one column only');
  assert.deepEqual(cols[COL.manager], { personsAndTeams: [{ id: 12, kind: 'person' }, { id: 5, kind: 'team' }, { id: 14, kind: 'person' }] });
  assert.deepEqual(r, { ok: true, role: 'manager', canAssign: true, cell: {
    names: ['Bo Manager', 'Team 5', 'Monica Paola'], personIds: ['12', '14'], teamIds: ['5'],
    entries: [{ id: '12', kind: 'person', name: 'Bo Manager' }, { id: '5', kind: 'team', name: 'Team 5' }, { id: '14', kind: 'person', name: 'Monica Paola' }] } });
  // the note, once, never retried
  assert.equal(m.notes.length, 1); assert.equal(m.notes[0].retries, 0); assert.equal(m.notes[0].vars.i, ITEM);
  assert.match(m.notes[0].vars.b, /^👤 <b>Case Manager: added Monica Paola<\/b> \(now: Bo Manager, Team 5, Monica Paola\)\. On the case page by Asha Officer · \d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} (am|pm) \(Toronto\)\.$/);
  // the cache follows the read-back for THAT column, never invalidated
  assert.equal(invalidations, 0);
  assert.deepEqual(patches, [{ itemId: ITEM, colId: COL.manager, cell: m.cells[COL.manager] }]);
  // no other mutation of any kind
  assert.equal(m.calls.filter((c) => /^mutation/.test(c.gql)).length, 2);
});

test('ADD for each role writes that role\'s column and nothing else', async () => {
  for (const [role, col] of Object.entries(COL)) {
    svc._inFlight.clear();
    const m = fakeMonday();
    await onCase({ role, userId: '13', expected: { personIds: [], teamIds: [] } });
    assert.deepEqual(Object.keys(JSON.parse(m.writes[0].vars.c)), [col], role);
    for (const c of NEVER) assert.ok(!m.writes[0].vars.c.includes(c));
    assert.match(m.notes[0].vars.b, new RegExp('<b>' + svc.ROLES[role].label + ': added Chen Sub</b>'));
  }
});

test('ADD someone already in the cell = no-op: no write, no note, no patch ("No change needed")', async () => {
  const m = fakeMonday({ cells: { [COL.officer]: { value: ppl(11, 14), text: 'Asha Officer, Monica Paola' } } });
  const r = await onCase({ role: 'officer', userId: '14', expected: { personIds: ['14', '11'], teamIds: [] } });
  assert.equal(r.unchanged, true); assert.equal(r.ok, true);
  assert.equal(m.writes.length, 0); assert.equal(m.notes.length, 0); assert.equal(patches.length, 0);
});

test('ADD: a person not assignable (disabled, the app\'s own account, unknown) → 400, nothing read or written', async () => {
  for (const uid of ['21', '1', '999']) {
    const m = fakeMonday();
    await refused(onCase({ role: 'manager', userId: uid, expected: { personIds: [], teamIds: [] } }), 400, /Not a staff member/);
    assert.equal(m.reads, 0); assert.equal(m.writes.length, 0);
  }
});

// ── remove ──
test('REMOVE: only that person goes; the other persons and the teams stay; the note says "removed"', async () => {
  const m = fakeMonday({ cells: { [COL.officer]: { value: ppl(11, T(5), 14), text: 'Asha Officer, Team 5, Monica Paola' } } });
  const r = await onCase({ role: 'officer', op: 'remove', userId: '14', expected: { personIds: ['11', '14'], teamIds: ['5'] } });
  assert.deepEqual(JSON.parse(m.writes[0].vars.c)[COL.officer], { personsAndTeams: [{ id: 11, kind: 'person' }, { id: 5, kind: 'team' }] });
  assert.deepEqual(r.cell.personIds, ['11']); assert.deepEqual(r.cell.teamIds, ['5']);
  assert.equal(r.canAssign, true); assert.ok(!r.lostAccess);
  assert.match(m.notes[0].vars.b, /^👤 <b>Case Support Officer: removed Monica Paola<\/b> \(now: Asha Officer, Team 5\)\. On the case page by Asha Officer · /);
  assert.deepEqual(patches.map((p) => p.colId), [COL.officer]);
});

test('REMOVE the last person: the cell is written empty ({"personsAndTeams":[]}) and an empty read-back is kept; "now: nobody"', async () => {
  const m = fakeMonday({ cells: { [COL.submission]: { value: ppl(13), text: 'Chen Sub' } }, keep: (col) => ({ value: null, text: '' }) });
  const r = await onCase({ role: 'submission', op: 'remove', userId: '13', expected: { personIds: ['13'], teamIds: [] } });
  assert.deepEqual(JSON.parse(m.writes[0].vars.c), { [COL.submission]: { personsAndTeams: [] } });
  assert.deepEqual(r.cell, { names: [], personIds: [], teamIds: [], entries: [] });
  assert.match(m.notes[0].vars.b, /Submission Team: removed Chen Sub<\/b> \(now: nobody\)/);
});

test('REMOVE needs no staff list (a person who has left Monday can still be taken off); a person not there = no-op; a team → 400', async () => {
  let m = fakeMonday({ usersFail: true, cells: { [COL.ops]: { value: ppl(21, 12), text: 'Gone Person, Bo Manager' } } });
  const r = await onCase({ role: 'ops', op: 'remove', userId: '21', expected: { personIds: ['21', '12'], teamIds: [] } });
  assert.equal(r.ok, true, 'the staff list failing does not stop a remove (review 2026-11-24: it is read only to NAME the person)');
  assert.equal(m.writes.length, 1);
  // two people and no staff list: Monday's text could only GUESS who is who by position — the note names the id (review round 2)
  assert.match(m.notes[0].vars.b, /Ops Supervisor: removed user 21<\/b> \(now: Bo Manager\)/);
  m = fakeMonday({ cells: { [COL.ops]: { value: ppl(12, T(5)), text: 'Bo Manager, Team 5' } } });
  assert.equal((await onCase({ role: 'ops', op: 'remove', userId: '14', expected: { personIds: ['12'], teamIds: ['5'] } })).unchanged, true);
  await refused(onCase({ role: 'ops', op: 'remove', userId: '5', expected: { personIds: ['12'], teamIds: ['5'] } }), 400, /A team cannot be removed here/);
  assert.equal(m.writes.length, 0); assert.equal(m.notes.length, 0);
});

test('REMOVE yourself under "assigned": the answer says you lost access (canAssign false + the message); still the right write', async () => {
  process.env.CASE_VISIBILITY = 'assigned';
  const m = fakeMonday({ cells: { [COL.manager]: { value: ppl(11, 12), text: 'Asha Officer, Bo Manager' } } });
  const r = await onCase({ role: 'manager', op: 'remove', userId: '11', expected: { personIds: ['11', '12'], teamIds: [] } });
  assert.equal(r.ok, true); assert.equal(r.canAssign, false); assert.equal(r.lostAccess, true);
  assert.equal(r.message, svc.LOST_ACCESS);
  assert.match(r.message, /You took yourself off this case/);
  assert.deepEqual(JSON.parse(m.writes[0].vars.c)[COL.manager], { personsAndTeams: [{ id: 12, kind: 'person' }] });
  // still on the case through ANOTHER column → keeps access
  svc._inFlight.clear();
  fakeMonday({ cells: { [COL.manager]: { value: ppl(11), text: 'Asha Officer' }, [COL.ops]: { value: ppl(11), text: 'Asha Officer' } } });
  const r2 = await onCase({ role: 'manager', op: 'remove', userId: '11', expected: { personIds: ['11'], teamIds: [] } });
  assert.equal(r2.canAssign, true); assert.ok(!r2.lostAccess);
});

// ── stale, read-back, lock ──
test('changed in Monday since the page loaded: NOT refused (round 2, B7) — the cell is built from the fresh read; add and remove; changedMeanwhile + the fresh cell come back', async () => {
  // add: the page showed [Bo], Monday has [Bo, team 5] → Bo and the team stay, Monica is added
  let m = fakeMonday({ cells: { [COL.manager]: { value: ppl(12, T(5)), text: 'Bo Manager, Team 5' } } });
  let r = await onCase({ role: 'manager', userId: '14', expected: { personIds: ['12'], teamIds: [] } });
  assert.equal(r.ok, true); assert.equal(r.changedMeanwhile, true);
  assert.deepEqual(JSON.parse(m.writes[0].vars.c), { [COL.manager]: { personsAndTeams: [{ id: 12, kind: 'person' }, { id: 5, kind: 'team' }, { id: 14, kind: 'person' }] } });
  assert.deepEqual(r.cell.personIds, ['12', '14']); assert.deepEqual(r.cell.teamIds, ['5']);
  // remove: the page showed [Bo], Monday has [Bo, Monica] → only Bo goes
  svc._inFlight.clear();
  m = fakeMonday({ cells: { [COL.manager]: { value: ppl(12, 14), text: 'Bo Manager, Monica Paola' } } });
  r = await onCase({ role: 'manager', op: 'remove', userId: '12', expected: { personIds: ['12'], teamIds: [] } });
  assert.equal(r.changedMeanwhile, true);
  assert.deepEqual(JSON.parse(m.writes[0].vars.c), { [COL.manager]: { personsAndTeams: [{ id: 14, kind: 'person' }] } });
  // a remove of someone already gone: no write, no 409 — "No change needed" with the cell as it is now (and the cache follows it)
  svc._inFlight.clear(); patches = [];
  m = fakeMonday({ cells: { [COL.manager]: { value: ppl(14), text: 'Monica Paola' } } });
  r = await onCase({ role: 'manager', op: 'remove', userId: '12', expected: { personIds: ['12'], teamIds: [] } });
  assert.equal(r.unchanged, true); assert.equal(r.changedMeanwhile, true);
  assert.deepEqual(r.cell.entries, [{ id: '14', kind: 'person', name: 'Monica Paola' }]);
  assert.equal(m.writes.length, 0); assert.equal(m.notes.length, 0);
  assert.deepEqual(patches, [{ itemId: ITEM, colId: COL.manager, cell: { value: ppl(14), text: 'Monica Paola' } }]);
  // nothing in the service throws a 409 "changed" any more
  assert.ok(!/code: 'changed'/.test(fs.readFileSync(require.resolve('../src/services/caseAssignService'), 'utf8')));
});

test('502 when the read-back is not EXACTLY the intended cell (a person or a team missing or extra): no note, no patch, lock released', async () => {
  const cases = [
    (col, c) => ({ value: ppl(12), text: 'Bo Manager' }),                                  // the new person was not kept
    (col, c) => ({ value: ppl(12, 14), text: 'Bo Manager, Monica Paola' }),                 // the team was dropped
    (col, c) => ({ value: ppl(12, T(5), 14, 99), text: 'a, b, c, d' }),                     // someone extra
  ];
  for (const keep of cases) {
    svc._inFlight.clear(); patches = [];
    const m = fakeMonday({ keep, cells: { [COL.manager]: { value: ppl(12, T(5)), text: 'Bo Manager, Team 5' } } });
    await refused(onCase({ role: 'manager', userId: '14', expected: { personIds: ['12'], teamIds: ['5'] } }), 502, /^Monday did not keep the change — check the case in Monday before trying again/);
    assert.equal(m.writes.length, 1); assert.equal(m.notes.length, 0); assert.equal(patches.length, 0);
    assert.equal(svc._inFlight.size, 0);
  }
});

test('one change at a time per case (any role): a busy case → 409 with no Monday read of the case', async () => {
  const m = fakeMonday();
  svc._inFlight.add(ITEM);
  await refused(onCase({ role: 'ops', userId: '14', expected: { personIds: [], teamIds: [] } }), 409, /already being assigned/);
  assert.equal(m.reads, 0); assert.equal(m.writes.length, 0);
});

test('the Client Master route still works as before for the Support Officer (role and op default to officer / add) and answers { officer }', async () => {
  const m = fakeMonday({ cells: { [COL.officer]: { value: ppl(11), text: 'Asha Officer' } } });
  const r = await svc.assign({ staff: STAFF, hasKey: false, body: { itemId: ITEM, userId: '14', expected: { personIds: ['11'], teamIds: [] } } });
  assert.deepEqual(r, { ok: true, officer: { names: ['Asha Officer', 'Monica Paola'], personIds: ['11', '14'], teamIds: [] }, canAssign: true });
  assert.match(m.notes[0].vars.b, /On the Client Master page by Asha Officer/);
  assert.equal(lookups.length, 0, 'the Client Master route takes the row\'s item id (checked against Monday) — no lookup');
});

// ── the case page's box (pure) ──
test('describeForCase: the four roles in the stage order with their entries; canAssign only for a Monday sign-in who may see the case', () => {
  const cells = { [COL.officer]: { value: ppl(11), text: 'Asha Officer' }, [COL.manager]: { value: ppl(12, T(5)), text: 'Bo Manager, Ops' },
    [COL.submission]: { value: null, text: '' }, [COL.ops]: { value: ppl(14), text: 'Monica Paola' }, multiple_person_mm334yp5: { value: ppl(99), text: 'Retainer Person' } };
  const assignees = { personIds: ['11', '12', '14', '99'], teamIds: ['5'] };
  let t = svc.describeForCase({ cells, stage: 'Submission Ready', staff: STAFF, assignees });
  assert.equal(t.available, true); assert.equal(t.canAssign, true); assert.equal(t.signedIn, true); assert.equal(t.me, '11');
  assert.deepEqual(t.roles.map((r) => [r.role, r.highlight]), [['submission', true], ['officer', false], ['manager', false], ['ops', false]]);
  assert.deepEqual(t.roles.map((r) => r.label), ['Submission Team', 'Case Support Officer', 'Case Manager', 'Ops Supervisor']);
  // cold staff list, two entries named from the text: the person's name is a guess by position (round 2, A1 — no ✕ for it)
  assert.deepEqual(t.roles[2].entries, [{ id: '12', kind: 'person', name: 'Bo Manager', guess: true }, { id: '5', kind: 'team', name: 'Ops' }]);
  assert.ok(!JSON.stringify(t).includes('Retainer Person'), 'Retained by is never offered');
  assert.equal(t.hint, 'At this stage: Submission Team.');
  // the shared key alone / nobody: shown, not changeable
  t = svc.describeForCase({ cells, stage: 'Internal Review', staff: null, assignees });
  assert.equal(t.canAssign, false); assert.equal(t.signedIn, false); assert.equal(t.me, '');
  assert.deepEqual(t.roles.filter((r) => r.highlight).map((r) => r.role), ['officer', 'manager']);
  // under "assigned": a staffer not on the case cannot change it
  process.env.CASE_VISIBILITY = 'assigned';
  t = svc.describeForCase({ cells, stage: 'Stuck', staff: { id: '77', name: 'Zed', email: 'z@example.com' }, assignees });
  assert.equal(t.canAssign, false); assert.equal(t.signedIn, true);
  // the row could not be read: not available, nothing changeable
  t = svc.describeForCase({ cells: null, stage: '', staff: STAFF, assignees, cmUnavailable: true });
  assert.equal(t.available, false); assert.equal(t.canAssign, false);
  assert.ok(t.roles.every((r) => r.entries.length === 0));
});

test('entriesOf: Monday\'s text when it lines up with the entries (the cell\'s own order), else known names, "user <id>" / "team <id>"', () => {
  assert.deepEqual(svc.entriesOf({ value: ppl(T(5), 12), text: 'Ops, Bo' }).map((e) => e.name), ['Ops', 'Bo']);
  assert.deepEqual(svc.entriesOf({ value: ppl(T(5), 12), text: 'Bo' }, new Map([['12', 'Bo M']])).map((e) => e.name), ['team 5', 'Bo M']);
  assert.deepEqual(svc.entriesOf({ value: ppl(12, 12), text: 'Bo' }).map((e) => [e.id, e.name]), [['12', 'Bo']], 'one entry per person');
  assert.deepEqual(svc.entriesOf({ value: 'not json', text: 'x' }), []);
  assert.deepEqual(svc.entriesOf({ value: ppl(33), text: '' }, null, { 33: 'New One' }).map((e) => e.name), ['New One']);
});

// ── the routes (source) ──
test('the routes: the case route resolves the case from the URL and goes through the same gate; case-data hands the box over and drops the raw cells', () => {
  const src = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const a = src.indexOf("app.post('/admin/case-action/:caseRef/assign'");
  assert.ok(a > 0);
  const route = src.slice(a, src.indexOf('\n});', a));
  assert.match(route, /assignWho\(req\)/);
  assert.match(route, /const caseRef = \(req\.params\.caseRef \|\| ''\)\.trim\(\);/);
  assert.match(route, /assignOnCase\(\{ staff, hasKey, caseRef, body: req\.body \}\)/);
  assert.ok(!/itemId/.test(route), 'no item id taken from the request');
  assert.match(route, /if \(err\.status && err\.body\) return res\.status\(err\.status\)\.json\(err\.body\);/);
  const d = src.indexOf("app.get('/admin/case-data/:caseRef'");
  const data = src.slice(d, src.indexOf('\n});', d));
  assert.match(data, /getCaseOverview\(\(req\.params\.caseRef \|\| ''\)\.trim\(\), \{ team: true \}\)/);
  assert.match(data, /overview\.team = require\('\.\/services\/caseAssignService'\)\.describeForCase\(\{ cells: overview\.teamCells, stage: overview\.caseStage, staff: tryStaffAuth\(req\), assignees: overview\.assignees, cmUnavailable: overview\.cmUnavailable \}\);\n    delete overview\.teamCells;/);
  // the key-only /api/case route is unchanged (no team box, no raw cells)
  const k = src.indexOf("app.get('/api/case/:caseRef'");
  assert.match(src.slice(k, k + 300), /getCaseOverview\(\(req\.params\.caseRef \|\| ''\)\.trim\(\)\);/);
  assert.ok(!/invalidateCases/.test(fs.readFileSync(require.resolve('../src/services/caseAssignService'), 'utf8')));
});

test('getCaseOverview: the people cells are read with the case row (no extra Monday read) and handed over only when asked ({ team: true })', async () => {
  const cockpit = require('../src/services/caseCockpitService');
  const restore = mondayApi.query;
  mondayApi.query = async (gql) => {
    assert.match(gql, /multiple_person_mm2nhsx1/, 'the people columns are in the one row read');
    return { items: [{ column_values: [{ id: COL.manager, text: 'Bo Manager', value: ppl(12) }, { id: 'color_mm0x8faa', text: 'Internal Review', value: null }] }] };
  };
  try {
    const cm = await cockpit.readClientMaster('4001');
    assert.deepEqual(cm.peopleCells[COL.manager], { text: 'Bo Manager', value: ppl(12) });
    assert.deepEqual(cm.peopleCells[COL.officer], { text: '', value: null });
  } finally { mondayApi.query = restore; }
  const src = fs.readFileSync(require.resolve('../src/services/caseCockpitService'), 'utf8');
  assert.match(src, /if \(opts && opts\.team\) overview\.teamCells = cm\._unavailable \? null : \(cm\.peopleCells \|\| null\);\n  return overview;/);
});

// ── the case page ──
function pageScripts(html) { return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]); }

test('the case page: every emitted script parses (with and without the notes panel / emails tab), the box and its click handler are on the page', () => {
  const { buildCockpitHTML } = require('../src/routes/adminCase');
  for (const o of [{}, { notesPanel: true, emailsTab: 'on' }, { notesPanel: false, emailsTab: 'off' }, { notesPanel: true, emailsTab: 'admins' }]) {
    const html = buildCockpitHTML('2026-EE-001', o);
    const scripts = pageScripts(html);
    assert.ok(scripts.length >= 1);
    for (const js of scripts) { assert.doesNotThrow(() => new Function(js)); assert.doesNotThrow(() => new vm.Script(js)); }
    assert.ok(html.includes('<div class="card team-card" id="team-card" style="display:none"></div>'));
    assert.ok(html.includes("document.getElementById('team-card').addEventListener('click', teamClick);"));
    assert.ok(html.includes("fetch('/admin/case-action/' + encodeURIComponent(CASE_REF) + '/assign'"));
    assert.ok(html.includes("fetch('/admin/client-master/assignable-users'"), 'the staff list is the Client Master one');
    assert.ok(/renderPills\(d\);\n  \/\/ Team on this case \(2026-11-24\)\n  renderTeam\(d\.team\);/.test(html));
  }
});

test('the case page at phone width: 44px tap targets (✕, +, the suggestion, + Other role, Undo, the handover box) and a 16px select for the box', () => {
  const html = require('../src/routes/adminCase').buildCockpitHTML('2026-EE-001', {});
  const phone = /@media \(max-width: 600px\) \{\s*\.team-role \{[^}]*\}\s*\.team-x, \.team-plus \{ width:44px; height:44px;[^}]*\}\s*\.team-add, \.team-sug, \.team-more, \.team-undo \{ min-height:44px; font-size:16px; \}\s*\.team-sel \{ min-height:44px; \}\s*\.team-also \{ min-height:44px; font-size:16px; \}\s*\.team-also input \{ width:22px; height:22px; \}\s*\}/;
  assert.match(html, phone);
  assert.match(html, /\.team-sel \{[^}]*font-size:16px;/);
});

/** The box's code, run on its own with a tiny DOM. */
function boxHarness() {
  const html = require('../src/routes/adminCase').buildCockpitHTML('2026-EE-001', {});
  const js = pageScripts(html)[0];
  const start = js.indexOf('/* ── Team on this case (2026-11-24)');
  const block = js.slice(start, js.indexOf('function render(d) {', start));
  const esc = js.slice(js.indexOf('function escHtml(s) {'), js.indexOf('function pctColor')) +
    js.slice(js.indexOf('function remSignInHtml(res) {'), js.indexOf('function remFail('));   // the box's sign-in link is the reminders' one
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', className: '', style: {} });
  const ctx = { document: { getElementById: el, querySelector: () => null }, location: { pathname: '/admin/case/2026-EE-001', search: '' }, encodeURIComponent,
    peekKey: () => '', LAST_D: null, renderPills: () => { ctx.pills = (ctx.pills || 0) + 1; } };
  vm.createContext(ctx);
  vm.runInContext(esc + '\n' + block + '\nvar LAST_D = null;', ctx);
  return { ctx, el };
}
const TEAM = (o = {}) => ({ available: true, stage: 'Internal Review', hint: 'At this stage: the Case Support Officer prepares the file, then the Case Manager reviews it.', canAssign: true, signedIn: true, me: '11',
  roles: [
    { role: 'officer', label: 'Case Support Officer', highlight: true, names: ['Asha Officer'], personIds: ['11'], teamIds: [], entries: [{ id: '11', kind: 'person', name: 'Asha Officer' }] },
    { role: 'manager', label: 'Case Manager', highlight: true, names: ['Bo <M>', 'Ops'], personIds: ['12'], teamIds: ['5'], entries: [{ id: '12', kind: 'person', name: 'Bo <M>' }, { id: '5', kind: 'team', name: 'Ops' }] },
    { role: 'submission', label: 'Submission Team', highlight: false, names: [], personIds: [], teamIds: [], entries: [] },
    { role: 'ops', label: 'Ops Supervisor', highlight: false, names: [], personIds: [], teamIds: [], entries: [] },
  ], ...o });

test('the box (round 2): only the roles that fit the stage or have someone; "this stage" badge, no Stage / hint line; ✕ on each PERSON only; a compact + on a filled row; the rest behind "+ Other role" (kept open); names escaped', () => {
  const { ctx, el } = boxHarness();
  ctx.LAST_D = { team: TEAM() };
  ctx.renderTeam(ctx.LAST_D.team);
  let h = el('team-card').innerHTML;
  assert.equal(el('team-card').style.display, '');
  assert.ok(h.startsWith('<div class="card-title">👥 Team on this case</div>'), 'no Stage in the title (the header pill shows it)');
  assert.ok(!/team-hint|The other roles can still be set|Fits this stage/.test(h));
  const rows = (x) => [...x.matchAll(/<div class="team-row( fit)?" data-role="([a-z]+)">/g)].map((m) => [m[2], !!m[1]]);
  assert.deepEqual(rows(h), [['officer', true], ['manager', true]], 'Submission Team and Ops Supervisor (empty, not this stage) are folded');
  assert.equal((h.match(/<span class="team-fit">this stage<\/span>/g) || []).length, 2);
  assert.equal((h.match(/data-team-rm=/g) || []).length, 2, 'Asha and Bo — never the team');
  assert.ok(h.includes('data-team-rm="manager" data-uid="12"') && !h.includes('data-uid="5"'));
  assert.ok(h.includes('Ops<span class="team-kind">team</span></span>'));
  assert.ok(h.includes('<button type="button" class="team-plus" data-team-add="officer" aria-label="Add another Case Support Officer" title="Add another Case Support Officer">+</button>'));
  assert.equal((h.match(/data-team-add=/g) || []).length, 2);
  assert.ok(h.includes('<button type="button" class="team-more" data-team-more="1" aria-expanded="false">+ Other role</button>'));
  assert.ok(h.includes('Bo &lt;M&gt;') && !h.includes('Bo <M>'));
  assert.ok(!h.includes('Nobody'), '"Nobody" only in the read-only view');
  // "+ Other role" opens the rest inline: an empty row has one clear button, "+ Add <role>"
  ctx.teamClick({ target: { closest: () => ({ getAttribute: (k) => (k === 'data-team-more' ? '1' : null) }) } });
  h = el('team-card').innerHTML;
  assert.deepEqual(rows(h), [['officer', true], ['manager', true], ['submission', false], ['ops', false]]);
  assert.ok(h.includes('<button type="button" class="sbtn team-add" data-team-add="submission">+ Add Submission Team</button>'));
  assert.ok(h.includes('<button type="button" class="sbtn team-add" data-team-add="ops">+ Add Ops Supervisor</button>'));
  assert.ok(!h.includes('team-more'), 'opened');
  // kept open across a redraw (an answer redraws the box)
  ctx.renderTeam(ctx.LAST_D.team);
  assert.equal(rows(el('team-card').innerHTML).length, 4);
});

test('the box without the right to change it: no buttons; the key alone is told to sign in with Monday; unreadable row says so', () => {
  const { ctx, el } = boxHarness();
  ctx.renderTeam(TEAM({ canAssign: false, signedIn: false }));
  let h = el('team-card').innerHTML;
  assert.ok(!/data-team-(add|rm)/.test(h));
  assert.ok(h.includes('To change who is on this case, sign in with Monday') && h.includes('href="/q/auth/monday?returnTo=%2Fadmin%2Fcase%2F2026-EE-001"'));
  ctx.renderTeam(TEAM({ canAssign: false, signedIn: true }));
  assert.ok(el('team-card').innerHTML.includes('Only staff on this case can change who is on it.'));
  ctx.renderTeam(TEAM({ available: false }));
  h = el('team-card').innerHTML;
  assert.ok(h.includes('could not be read just now') && !/team-row/.test(h));
  ctx.renderTeam(null);
  assert.equal(el('team-card').style.display, 'none');
});

test('the box after an answer: the cell follows the server; a Case Manager change redraws the Manager pill; losing access turns the box read-only without a crash', () => {
  const { ctx, el } = boxHarness();
  ctx.LAST_D = { caseRef: '2026-EE-001', clientName: 'X', manager: 'Bo', team: TEAM() };
  ctx.teamApply('manager', { names: ['Bo', 'Monica Paola'], personIds: ['12', '14'], teamIds: [], entries: [{ id: '12', kind: 'person', name: 'Bo' }, { id: '14', kind: 'person', name: 'Monica Paola' }] }, true);
  assert.equal(ctx.LAST_D.manager, 'Bo, Monica Paola');
  assert.equal(ctx.pills, 1);
  assert.ok(el('team-card').innerHTML.includes('data-team-rm="manager" data-uid="14"'));
  ctx.teamApply('officer', { names: [], personIds: [], teamIds: [], entries: [] }, false, 'You took yourself off this case. You can no longer change who is on it, and you may not be able to open it after a reload.');
  const h = el('team-card').innerHTML;
  assert.ok(!/data-team-(add|rm)/.test(h), 'read-only now');
  assert.ok(h.includes('You took yourself off this case.'));
  assert.equal(ctx.pills, 1, 'the pill is redrawn for the Case Manager only');
});

// ── the Client Master page (decision 5: Assign… adds) ──
test('the Client Master page: Assign… says it ADDS (who is there stays); no "replace" wording left in the Assign code; its scripts parse', async () => {
  const dash = require('../src/routes/adminDashboard');
  const layer = dash.stack.find((l) => l.route && l.route.path === '/');
  const html = await new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
  for (const js of pageScripts(html)) assert.doesNotThrow(() => new vm.Script(js));
  const src = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  const asg = src.slice(src.indexOf('/* ── Assign the Case Support Officer'), src.indexOf('/* ── Change the client deadline'));
  assert.ok(asg.includes('Adds the person as Case Support Officer in Monday — who is there now stays — and adds a note on the case. Nothing else changes.'));
  assert.ok(asg.includes("rm = 'Keeps ' + cmAnd(st.names) + ' and adds ' + ch.name + '.';"));
  assert.ok(asg.includes("' is already a Case Support Officer on this case — nothing will change.'"));
  assert.ok(!/[Rr]eplaces|to replace it|This removes/.test(asg));
  assert.ok(src.includes('title="Add a Case Support Officer in Monday (who is there now stays; a note is added on the case)">Assign…</button>'));
});

// ── the staff guide ──
test('the staff guide: the Client Master how-to says it adds; the case page has its own how-to, linked to a real step', () => {
  const g = JSON.parse(require('../src/services/staffGuideService').data());
  const step = g.steps.find((s) => s.id === 'cases-assign-officer');
  assert.ok(!/[Rr]eplaces/.test(JSON.stringify(step)));
  const caseStep = g.steps.find((s) => s.id === 'case-assign-team');
  assert.ok(caseStep && /case page/i.test(caseStep.where));
  const h = g.howto.find((x) => x.q === 'How do I assign people to a case from the case page?');
  assert.ok(h && h.step_ids.includes('case-assign-team'));
  assert.ok(!/replaces/.test(g.howto.find((x) => x.q === 'How do I set who the Case Support Officer is?').answer));
});

// ── review 2026-11-24 ──
test('review [1][3] entriesOf: a PERSON is named by id (staff list / just added), never by position in Monday\'s text; the text names only what the ids cannot', () => {
  const names = new Map([['1', 'Ann'], ['2', 'Bob'], ['3', 'Alice']]);
  // the text in another order than the value
  assert.deepEqual(svc.entriesOf({ value: ppl(1, 2), text: 'Bob, Ann' }, names).map((e) => [e.id, e.name]), [['1', 'Ann'], ['2', 'Bob']]);
  // a mixed cell: value [Alice, team 9, Bob], text persons-first — the team keeps its own name, Bob keeps his
  assert.deepEqual(svc.entriesOf({ value: ppl(3, T(9), 2), text: 'Alice, Bob, Intake' }, names).map((e) => [e.kind, e.id, e.name]),
    [['person', '3', 'Alice'], ['team', '9', 'Intake'], ['person', '2', 'Bob']]);
  // the person just added (not yet on the cached list) by id too
  assert.deepEqual(svc.entriesOf({ value: ppl(3, T(9), 44), text: 'Alice, Newbie, Intake' }, names, { 44: 'Newbie' }).map((e) => e.name), ['Alice', 'Intake', 'Newbie']);
  // a known name missing from the text: the text does not line up → the team is "team <id>", never a person's name
  assert.deepEqual(svc.entriesOf({ value: ppl(1, T(9)), text: 'Ann B, Intake' }, names).map((e) => e.name), ['Ann', 'team 9']);
  // a person NOT on the staff list among known ones: the leftover text part, in order
  assert.deepEqual(svc.entriesOf({ value: ppl(1, 77), text: 'Ann, Former Staff' }, names).map((e) => e.name), ['Ann', 'Former Staff']);
  // nothing known (cold cache): the text in order, as before
  assert.deepEqual(svc.entriesOf({ value: ppl(1, T(9)), text: 'Ann, Intake' }).map((e) => e.name), ['Ann', 'Intake']);
  // a prototype key is never a name
  assert.deepEqual(svc.entriesOf({ value: ppl(5), text: '' }, null, Object.create({ 5: 'Inherited' })).map((e) => e.name), ['user 5']);
});

test('review [1][3] REMOVE with Monday\'s text in another order: the note and the answer name the person whose id was removed (warm or cold staff list)', async () => {
  for (const warm of [true, false]) {
    svc._resetUsers(); svc._inFlight.clear();
    const m = fakeMonday({ cells: { [COL.manager]: { value: ppl(11, 14), text: 'Monica Paola, Asha Officer' } } });
    if (warm) await svc.assignableUsers();
    const r = await onCase({ role: 'manager', op: 'remove', userId: '11', expected: { personIds: ['11', '14'], teamIds: [] } });
    assert.match(m.notes[0].vars.b, /<b>Case Manager: removed Asha Officer<\/b> \(now: Monica Paola\)/, warm ? 'warm' : 'cold');
    assert.deepEqual(r.cell.entries, [{ id: '14', kind: 'person', name: 'Monica Paola' }]);
    assert.equal(m.calls.filter((c) => /users\(kind/.test(c.gql)).length, warm ? 1 : 1, 'one list read at most (the warm-up, or the remove\'s own when cold)');
  }
});

test('review [1][3] ADD into a cell with a team: the team keeps its name and the new person is named by id, whatever order Monday\'s text comes back in', async () => {
  const m = fakeMonday({ cells: { [COL.officer]: { value: ppl(11, T(9)), text: 'Asha Officer, Intake' } },
    keep: (col, cell) => ({ value: JSON.stringify(cell), text: 'Asha Officer, Monica Paola, Intake' }) });   // persons first in the text
  const r = await onCase({ role: 'officer', userId: '14', expected: { personIds: ['11'], teamIds: ['9'] } });
  assert.deepEqual(r.cell.entries, [{ id: '11', kind: 'person', name: 'Asha Officer' }, { id: '9', kind: 'team', name: 'Intake' }, { id: '14', kind: 'person', name: 'Monica Paola' }]);
  assert.match(m.notes[0].vars.b, /added Monica Paola<\/b> \(now: Asha Officer, Intake, Monica Paola\)/);
});

test('review [1] the page load: warmUsersForPage reads the staff list once for a Monday sign-in (never for the key alone / nobody), never throws, never waits long; the box then names by id', async () => {
  let m = fakeMonday();
  await svc.warmUsersForPage(null); await svc.warmUsersForPage({});
  assert.equal(m.calls.length, 0, 'no read without a Monday sign-in');
  await Promise.all([svc.warmUsersForPage(STAFF), svc.warmUsersForPage(STAFF)]);
  assert.equal(m.calls.filter((c) => /users\(kind/.test(c.gql)).length, 1, 'one read for two page loads at once');
  await svc.warmUsersForPage(STAFF);
  assert.equal(m.calls.length, 1, 'kept (an hour)');
  const t = svc.describeForCase({ cells: { [COL.manager]: { value: ppl(11, 14), text: 'Monica Paola, Asha Officer' } }, stage: '', staff: STAFF, assignees: { personIds: ['11', '14'], teamIds: [] } });
  assert.deepEqual(t.roles.find((x) => x.role === 'manager').entries.map((e) => [e.id, e.name]), [['11', 'Asha Officer'], ['14', 'Monica Paola']]);
  // a failing read: no throw, the page goes on
  svc._resetUsers();
  m = fakeMonday({ usersFail: true });
  await svc.warmUsersForPage(STAFF);
  // a read that hangs: the page waits at most timeoutMs
  svc._resetUsers();
  mondayApi.query = () => new Promise(() => {});
  const t0 = Date.now();
  await svc.warmUsersForPage(STAFF, { timeoutMs: 30 });
  assert.ok(Date.now() - t0 < 1000);
  svc._resetUsers();
  // the route warms the list before the box is described (and not when the row could not be read)
  const src = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  // round 2 (B1): started BESIDE the case read, awaited before the box is described
  const d = src.slice(src.indexOf("app.get('/admin/case-data/:caseRef'"));
  const warmAt = d.indexOf("const teamWarm = require('./services/caseAssignService').warmUsersForPage(tryStaffAuth(req));");
  const readAt = d.indexOf('await caseCockpitService.getCaseOverview(');
  assert.ok(warmAt > 0 && warmAt < readAt, 'the staff list starts before the case read');
  assert.ok(d.includes("    await teamWarm;\n    overview.team = require('./services/caseAssignService').describeForCase("));
});

test('review [2] the Client Master route only ADDS a Case Support Officer: another role or a remove → 400 before any Monday call; "officer" / "add" named outright still work', async () => {
  const m = fakeMonday({ cells: { [COL.officer]: { value: ppl(11), text: 'Asha Officer' }, [COL.manager]: { value: ppl(12), text: 'Bo Manager' } } });
  const cm = (extra) => svc.assign({ staff: STAFF, hasKey: false, body: { itemId: ITEM, userId: '12', expected: { personIds: ['12'], teamIds: [] }, ...extra } });
  await refused(cm({ role: 'manager', op: 'remove' }), 400, /This role cannot be set here/);
  await refused(cm({ role: 'manager' }), 400, /This role cannot be set here/);
  await refused(cm({ op: 'remove' }), 400, /Reload the page/);
  await refused(cm({ role: 'officer', op: 'remove' }), 400, /Reload the page/);
  assert.equal(m.calls.length, 0); assert.equal(m.writes.length, 0);
  const r = await svc.assign({ staff: STAFF, hasKey: false, body: { itemId: ITEM, role: 'officer', op: 'add', userId: '14', expected: { personIds: ['11'], teamIds: [] } } });
  assert.equal(r.ok, true); assert.deepEqual(r.officer.personIds, ['11', '14']);
  assert.deepEqual(Object.keys(JSON.parse(m.writes[0].vars.c)), [COL.officer]);
  assert.match(m.notes[0].vars.b, /Case Support Officer: added Monica Paola.*On the Client Master page/);
});

/** The box's send code with a fake pop-up and a fake fetch. */
function sendHarness(answer) {
  const h = boxHarness();
  const { ctx, el } = h;
  ctx.msgs = []; ctx.loads = 0;
  ctx.actMsg = (id, cls, txt) => { ctx.msgs.push([id, cls, txt]); const e = el(id); e.className = 'act-msg ' + cls; e.textContent = txt; };
  ctx.loadCase = () => { ctx.loads++; };
  ctx.CASE_REF = '2026-EE-001';
  ctx.sent = [];
  ctx.fetch = (url, o) => {
    ctx.sent.push({ url, body: o && o.body ? JSON.parse(o.body) : null });
    if (/assignable-users/.test(url)) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, users: [{ id: '11', name: 'Asha Officer' }, { id: '12', name: 'Bo' }, { id: '14', name: 'Monica Paola' }] }) });
    const a = typeof answer === 'function' ? answer() : answer;
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve({ ok: a.status < 300, status: a.status, json: async () => a.j });
  };
  const dlg = { open: true, closed: 0 };
  ctx.tdotDialogNew = () => {
    const els = {};
    const box = { innerHTML: '', querySelector: (sel) => (els[sel] = els[sel] || { innerHTML: '', textContent: '', value: '', disabled: false, focus() {} }) };
    dlg.c = { box, openId: 1, busy: false, still: () => dlg.open, setBusy: (b) => { dlg.c.busy = b; }, close: () => { dlg.closed++; dlg.open = false; }, tryClose: () => { dlg.open = false; } };
    return dlg.c;
  };
  ctx.LAST_D = { caseRef: '2026-EE-001', clientName: 'X', manager: 'Bo', team: TEAM() };
  return { ...h, dlg };
}
const ticks = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

test('review [4] an error after the pop-up was closed is never dropped: it goes under the box (non-ok answer and no answer); no whole-case reload', async () => {
  for (const answer of [{ status: 502, j: { ok: false, error: 'The result is unknown — check the case in Monday before trying again. Nothing else was touched.' } }, new Error('network')]) {
    const { ctx, dlg } = sendHarness(answer);
    ctx.teamRmDlg('manager', '12');
    dlg.c.box.querySelector('#team-go').onclick();
    dlg.open = false;   // closed after the long wait, before the answer
    await ticks();
    assert.equal(ctx.msgs.length, 1);
    assert.equal(ctx.msgs[0][0], 'team-msg'); assert.equal(ctx.msgs[0][1], 'err');
    assert.match(ctx.msgs[0][2], answer instanceof Error ? /No answer — the result is unknown/ : /The result is unknown — check the case in Monday/);
    assert.equal(ctx.loads, 0, 'no whole-case reload: a next change on an out-of-date box is caught by the server (409 "changed")');
  }
  // still open: the pop-up shows it, nothing under the box, no reload
  const { ctx, dlg } = sendHarness({ status: 502, j: { ok: false, error: 'Monday did not keep the change.' } });
  ctx.teamRmDlg('manager', '12');
  dlg.c.box.querySelector('#team-go').onclick();
  await ticks();
  assert.equal(dlg.c.box.querySelector('#team-err').textContent, 'Monday did not keep the change.');
  assert.equal(ctx.msgs.length, 0); assert.equal(ctx.loads, 0);
});

test('review [6] a 403 key-only (the Monday sign-in expired, the team key left) shows the sign-in link like a 401, and the box stops offering Add… / ✕', async () => {
  for (const a of [{ status: 403, j: { ok: false, code: 'key-only', error: 'Sign in with Monday to assign, so the note can say who did it.' } },
    { status: 401, j: { ok: false, error: 'Sign in with Monday to assign.', loginUrl: '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard' } }]) {
    const { ctx, el, dlg } = sendHarness(a);
    ctx.renderTeam(ctx.LAST_D.team);
    ctx.teamRmDlg('manager', '12');
    dlg.c.box.querySelector('#team-go').onclick();
    await ticks();
    const e = dlg.c.box.querySelector('#team-err').innerHTML;
    assert.ok(e.includes(a.j.error) && e.includes('<a href="/q/auth/monday?returnTo=%2Fadmin%2Fcase%2F2026-EE-001">Sign in with Monday</a>'), String(a.status));
    assert.equal(ctx.LAST_D.team.canAssign, false); assert.equal(ctx.LAST_D.team.signedIn, false);
    const h = el('team-card').innerHTML;
    assert.ok(!/data-team-(add|rm)/.test(h) && h.includes('To change who is on this case, sign in with Monday'));
  }
  // any other 403 (not assigned) stays plain text, the box unchanged
  const { ctx, dlg } = sendHarness({ status: 403, j: { ok: false, error: 'You are not assigned to this case.' } });
  ctx.teamRmDlg('manager', '12');
  dlg.c.box.querySelector('#team-go').onclick();
  await ticks();
  assert.equal(dlg.c.box.querySelector('#team-err').textContent, 'You are not assigned to this case.');
  assert.equal(ctx.LAST_D.team.canAssign, true);
  // the staff list route says key-only too (so the Add pop-up can show the link)
  const src = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const g = src.slice(src.indexOf("app.get('/admin/client-master/assignable-users'"));
  assert.ok(g.slice(0, 600).includes("...(g.loginUrl ? { loginUrl: g.loginUrl } : { code: g.code })"));
});

test('review [7] the staff guide: the case page entry and the Overview step name the Team on this case box and link its how-to; the Manager pill is no longer called read-only', () => {
  const g = JSON.parse(require('../src/services/staffGuideService').data());
  const open = g.steps.find((s) => s.id === 'case-page-open');
  // round 2: the box sits under the readiness meters; its buttons are + / ✕
  assert.match(open.options.find((o) => o.label === 'Overview').does, /^Tab: readiness meters, the Team on this case box under them \(who is on the case by role; \+ \/ ✕ when signed in with Monday\)/);
  assert.ok(open.related.includes('case-assign-team'));
  const pill = open.options.find((o) => o.label.startsWith('Stage · Payment'));
  assert.ok(!/Read-only/.test(pill.does) && /Manager pill follows a Case Manager change made in the Team on this case box/.test(pill.does));
  const ov = g.steps.find((s) => s.id === 'case-readiness-overview');
  assert.match(ov.where, /Overview tab → "📝 Questionnaire readiness", "📂 Document readiness", "👥 Team on this case"/, 'round 2: under the meters');
  assert.ok(ov.related.includes('case-assign-team'));
});

// ── round 2 (Faran 2026-11-24: "simple, efficient, intelligent") ──
const STAGE_COL = 'color_mm0x8faa';
/** A cached Cases row as Monday gives it: open (Assigning view) unless closed (stage index 6 = a closed stage). */
const rawRow = (id, cells, closed) => ({ id: String(id), name: 'C' + id, created_at: '2026-11-01T00:00:00Z', group: { id: 'group_mm8qqjyz', title: 'November 2026' },
  column_values: [{ id: STAGE_COL, text: closed ? 'Application Submitted' : 'Internal Review', value: JSON.stringify({ index: closed ? 6 : 1 }) },
    ...Object.entries(cells).map(([role, v]) => ({ id: COL[role], text: '', value: v }))] });
const realPeek = svc._io.peekCache;
function withCache(items) { let version = 1; svc._resetStats(); svc._io.peekCache = () => (items ? { items, version, at: 0 } : null); return { bump: () => { version++; } }; }
test.afterEach(() => { svc._io.peekCache = realPeek; svc._resetStats(); svc._recentAdds.clear(); });

test('round 2 roleStatsOf / suggestFor: counted on OPEN cases only; a person is suggested only when they hold MORE than half of the role\'s filled cells; a team counts as filled', () => {
  const open = (cells) => ({ open: true, cells: Object.fromEntries(Object.entries(cells).map(([r, v]) => [r, { personIds: v.p || [], teamIds: v.t || [] }])) });
  const list = USERS.filter((u) => u.id !== 1 && u.enabled).map((u) => ({ id: String(u.id), name: u.name }));
  // Monica on 3 of 5 filled manager cells (> half) — the closed case and the empty cells do not count
  let stats = svc.roleStatsOf([open({ manager: { p: ['14'] } }), open({ manager: { p: ['14'] } }), open({ manager: { p: ['14', '12'] } }), open({ manager: { p: ['12'] } }), open({ manager: { t: ['5'] } }),
    open({}), { open: false, cells: { manager: { personIds: ['12'], teamIds: [] } } }]);
  assert.equal(stats.manager.filled, 5);
  assert.deepEqual({ ...stats.manager.counts }, { 14: 3, 12: 2 });
  assert.deepEqual(svc.suggestFor('manager', stats, list), { id: '14', name: 'Monica Paola', open: 3 });
  assert.deepEqual(svc.usualFor('manager', stats, list).map((u) => [u.name, u.open]), [['Bo Manager', 2], ['Monica Paola', 3]], 'fewest open first');
  // exactly half is NOT more than half → no suggestion
  stats = svc.roleStatsOf([open({ ops: { p: ['14'] } }), open({ ops: { p: ['14'] } }), open({ ops: { p: ['12'] } }), open({ ops: { t: ['5'] } })]);
  assert.equal(svc.suggestFor('ops', stats, list), null);
  // the top person is not on the staff list (left Monday / the app's own account): no suggestion, and not in the picker
  stats = svc.roleStatsOf([open({ officer: { p: ['21'] } }), open({ officer: { p: ['21'] } }), open({ officer: { p: ['11'] } })]);
  assert.equal(svc.suggestFor('officer', stats, list), null);
  assert.deepEqual(svc.usualFor('officer', stats, list).map((u) => u.id), ['11']);
  // nobody in the role anywhere: nothing
  assert.equal(svc.suggestFor('submission', stats, list), null);
  assert.deepEqual(svc.usualFor('submission', stats, list), []);
});

test('round 2 describeForCase: the usual person on an EMPTY role that fits the stage and on an empty Ops Supervisor — from the CACHED rows only; never on a filled role or a role that does not fit', async () => {
  fakeMonday();
  await svc.assignableUsers();
  const rows = [rawRow(1, { manager: ppl(14), ops: ppl(13), officer: ppl(11), submission: ppl(12) }), rawRow(2, { manager: ppl(14), ops: ppl(13), officer: ppl(11), submission: ppl(12) }),
    rawRow(3, { manager: ppl(12), ops: ppl(13), officer: ppl(12) }), rawRow(4, { manager: ppl(12) }, true), rawRow(5, { manager: ppl(12) }, true)];
  withCache(rows);
  mondayApi.query = async () => { throw new Error('the page never reads Monday for the suggestion'); };
  const t = svc.describeForCase({ cells: { [COL.officer]: { value: ppl(12), text: 'Bo Manager' } }, stage: 'Internal Review', staff: STAFF, assignees: { personIds: ['12', '11'], teamIds: [] } });
  const by = Object.fromEntries(t.roles.map((r) => [r.role, r]));
  assert.deepEqual(by.manager.suggest, { id: '14', name: 'Monica Paola' }, 'empty + fits Internal Review; the closed cases with Bo do not count');
  assert.deepEqual(by.ops.suggest, { id: '13', name: 'Chen Sub' }, 'an empty Ops Supervisor, any stage');
  assert.equal(by.officer.suggest, undefined, 'filled (Bo): no chip');
  assert.equal(by.submission.suggest, undefined, 'empty but not this stage: no chip');
  assert.deepEqual(by.manager.usual, [{ id: '12', open: 1 }, { id: '14', open: 2 }]);
  // at another stage the Case Manager is not suggested; the Ops Supervisor still is
  const t2 = svc.describeForCase({ cells: {}, stage: 'Application Submitted', staff: STAFF, assignees: { personIds: ['11'], teamIds: [] } });
  assert.deepEqual(t2.roles.filter((r) => r.suggest).map((r) => r.role), ['ops']);
  // Submission Preparation behaves as Internal Review (A4)
  const t3 = svc.describeForCase({ cells: {}, stage: 'Submission Preparation', staff: STAFF, assignees: { personIds: ['11'], teamIds: [] } });
  assert.deepEqual(t3.roles.filter((r) => r.suggest).map((r) => r.role).sort(), ['manager', 'officer', 'ops']);
});

test('round 2 a cold cache = no chip and no counts (the plain list): no cached rows, or no staff list yet; the read-only view gets neither', async () => {
  fakeMonday();
  await svc.assignableUsers();
  withCache(null);
  let t = svc.describeForCase({ cells: {}, stage: 'Internal Review', staff: STAFF, assignees: { personIds: ['11'], teamIds: [] } });
  assert.ok(t.roles.every((r) => r.suggest === undefined && r.usual === undefined));
  assert.ok(Array.isArray(t.staff), 'the staff list still comes with the page');
  // rows cached but the staff list cold: no chip (it could name nobody), no staff list sent
  withCache([rawRow(1, { manager: ppl(14) })]);
  svc._resetUsers();
  t = svc.describeForCase({ cells: {}, stage: 'Internal Review', staff: STAFF, assignees: { personIds: ['11'], teamIds: [] } });
  assert.ok(t.roles.every((r) => r.suggest === undefined) && t.staff === undefined);
  // the shared key alone / nobody: shown, no suggestion, no staff list
  await svc.assignableUsers();
  t = svc.describeForCase({ cells: {}, stage: 'Internal Review', staff: null, assignees: { personIds: [], teamIds: [] } });
  assert.ok(t.roles.every((r) => r.suggest === undefined && r.usual === undefined) && t.staff === undefined);
  // the dashboard's own peek: never a Monday read; null past 20 minutes; version moves on a patch
  const io = dashboardService._casesIo;
  const realNow = io.io.now;
  let clock = 2e12;
  io.io.now = () => clock;
  try {
    mondayApi.query = async (gql) => {
      if (/items_page/.test(gql)) return { boards: [{ items_page: { cursor: null, items: [{ id: '1' }] } }] };
      if (/items\(ids: \$ids, limit: 100\)/.test(gql)) return { items: [rawRow(1, { manager: ppl(14) })] };
      if (/groups \{ id title position \}/.test(gql)) return { boards: [{ groups: [], columns: [] }] };
      throw new Error('unexpected ' + gql.slice(0, 60));
    };
    await io.refresh();
    mondayApi.query = async () => { throw new Error('peek never reads Monday'); };
    const p1 = dashboardService.peekCachedItems();
    assert.equal(p1.items.length, 1);
    realPatch('1', COL.manager, { value: ppl(12), text: 'Bo Manager' });
    assert.ok(dashboardService.peekCachedItems().version > p1.version, 'a patch is a new version');
    clock += io.CASES_HARD_MS + 1000;
    assert.equal(dashboardService.peekCachedItems(), null, 'older than 20 minutes: no copy (no counts, no chip)');
  } finally { io.io.now = realNow; io.overrides.clear(); }
});

test('round 2 the staff list is sent with the page (B2) for someone who may change the case; the Add pop-up then opens ready, with no fetch', async () => {
  fakeMonday();
  await svc.assignableUsers();
  const t = svc.describeForCase({ cells: {}, stage: '', staff: STAFF, assignees: { personIds: ['11'], teamIds: [] } });
  assert.deepEqual(t.staff, [{ id: '11', name: 'Asha Officer' }, { id: '12', name: 'Bo Manager' }, { id: '13', name: 'Chen Sub' }, { id: '14', name: 'Monica Paola' }]);
  const { ctx, dlg } = sendHarness({ status: 200, j: { ok: true } });
  ctx.LAST_D.team.staff = t.staff;
  ctx.teamAddDlg('manager');
  assert.equal(ctx.sent.length, 0, 'no staff-list fetch');
  const sel = dlg.c.box.querySelector('#team-sel');
  assert.equal(sel.disabled, false);
  assert.match(sel.innerHTML, /<option value="12" disabled>Bo Manager — already on<\/option>/);
  assert.ok(!/Now:|team-dcase|team-dnow/.test(dlg.c.box.innerHTML), 'B6: no case line, no "Now:" line');
  assert.ok(dlg.c.box.innerHTML.includes('<div class="team-what">Monday tells them; a note is added on the case.</div>'));
});

test('round 2 the picker: "Usually <role>" with "— N open", fewest first, then "Everyone else" A → Z; people already on greyed out; no counts = the plain list', () => {
  const { ctx } = boxHarness();
  const staff = [{ id: '11', name: 'Asha Officer' }, { id: '12', name: 'Bo Manager' }, { id: '13', name: 'Chen Sub' }, { id: '14', name: 'Monica Paola' }];
  const r = { label: 'Case Manager', usual: [{ id: '12', open: 3 }, { id: '14', open: 12 }, { id: '99', open: 1 }] };
  assert.equal(ctx.teamOptions(r, staff, ['12']),
    '<option value="">Choose a person…</option><optgroup label="Usually Case Manager"><option value="12" disabled>Bo Manager — 3 open — already on</option><option value="14">Monica Paola — 12 open</option></optgroup>' +
    '<optgroup label="Everyone else"><option value="11">Asha Officer</option><option value="13">Chen Sub</option></optgroup>');
  assert.equal(ctx.teamOptions({ label: 'Case Manager' }, staff, []),
    '<option value="">Choose a person…</option><option value="11">Asha Officer</option><option value="12">Bo Manager</option><option value="13">Chen Sub</option><option value="14">Monica Paola</option>');
});

test('round 2 the fold: nothing fits the stage and nobody is set → the Case Support Officer shows with "+ Other role"; a role with someone always shows; the chip on an empty fitting row', () => {
  const { ctx, el } = boxHarness();
  const empty = (role, label, o) => ({ role, label, highlight: false, names: [], personIds: [], teamIds: [], entries: [], ...o });
  ctx.LAST_D = { team: TEAM({ roles: [empty('officer', 'Case Support Officer'), empty('manager', 'Case Manager'), empty('submission', 'Submission Team'), empty('ops', 'Ops Supervisor')] }) };
  ctx.renderTeam(ctx.LAST_D.team);
  let h = el('team-card').innerHTML;
  assert.deepEqual([...h.matchAll(/data-role="([a-z]+)"/g)].map((m) => m[1]), ['officer']);
  assert.ok(h.includes('+ Other role'));
  // review: all empty, nothing fits, but the Ops Supervisor has a one-tap name → the Case Support Officer still shows, beside the chip
  ctx.LAST_D.team.roles[3] = empty('ops', 'Ops Supervisor', { suggest: { id: '13', name: 'Chen Sub' } });
  ctx.renderTeam(ctx.LAST_D.team);
  h = el('team-card').innerHTML;
  assert.deepEqual([...h.matchAll(/data-role="([a-z]+)"/g)].map((m) => m[1]), ['officer', 'ops']);
  assert.ok(h.includes('data-team-sug="ops"') && h.includes('+ Other role'));
  // Ops Supervisor set → shown, without a highlight
  ctx.LAST_D.team.roles[3] = empty('ops', 'Ops Supervisor', { names: ['Chen'], personIds: ['13'], entries: [{ id: '13', kind: 'person', name: 'Chen' }] });
  ctx.renderTeam(ctx.LAST_D.team);
  h = el('team-card').innerHTML;
  assert.deepEqual([...h.matchAll(/data-role="([a-z]+)"/g)].map((m) => m[1]), ['ops']);
  // the chip: "+ Monica Paola", and the other button says "Someone else…"
  ctx.LAST_D.team.roles[1] = empty('manager', 'Case Manager', { highlight: true, suggest: { id: '14', name: 'Monica <P>' } });
  ctx.renderTeam(ctx.LAST_D.team);
  h = el('team-card').innerHTML;
  assert.ok(h.includes('<button type="button" class="team-sug" data-team-sug="manager" data-uid="14" title="Add Monica &lt;P&gt; as Case Manager now (Undo for 30 seconds)">+ Monica &lt;P&gt;</button>'));
  assert.ok(h.includes('<button type="button" class="sbtn team-add" data-team-add="manager">Someone else…</button>'));
  // an empty Ops Supervisor with a one-tap name is shown (not folded), without the "this stage" tint
  ctx.LAST_D.team.roles[3] = empty('ops', 'Ops Supervisor', { suggest: { id: '13', name: 'Chen Sub' } });
  ctx.renderTeam(ctx.LAST_D.team);
  h = el('team-card').innerHTML;
  assert.deepEqual([...h.matchAll(/<div class="team-row( fit)?" data-role="([a-z]+)">/g)].map((m) => [m[2], !!m[1]]), [['manager', true], ['ops', false]]);
  // the read-only view: "Nobody", no chip
  ctx.renderTeam({ ...ctx.LAST_D.team, canAssign: false });
  h = el('team-card').innerHTML;
  assert.ok(h.includes('<span class="team-none">Nobody</span>') && !h.includes('team-sug'));
});

test('round 2 A1: a person named only by position in Monday\'s text (guess) gets no ✕ and no remove pop-up; the server marks it only when two or more entries are unknown', () => {
  assert.deepEqual(svc.entriesOf({ value: ppl(1, 2), text: 'Ann, Bob' }).map((e) => e.guess), [true, true]);
  assert.deepEqual(svc.entriesOf({ value: ppl(1), text: 'Ann' }).map((e) => e.guess), [undefined], 'one unknown entry and one name left: not a guess');
  assert.deepEqual(svc.entriesOf({ value: ppl(1, 2), text: 'Bob, Ann' }, new Map([['1', 'Ann']])).map((e) => [e.name, e.guess]), [['Ann', undefined], ['Bob', undefined]]);
  const { ctx, el, dlg } = sendHarness({ status: 200, j: { ok: true } });
  ctx.LAST_D.team.roles[0] = { ...ctx.LAST_D.team.roles[0], names: ['Ann', 'Bob'], personIds: ['1', '2'], entries: [{ id: '1', kind: 'person', name: 'Ann', guess: true }, { id: '2', kind: 'person', name: 'Bob', guess: true }] };
  ctx.renderTeam(ctx.LAST_D.team);
  const h = el('team-card').innerHTML;
  assert.ok(!h.includes('data-team-rm="officer"'));
  assert.ok(h.includes('<span class="team-chip guess">Ann</span>'));
  ctx.teamRmDlg('officer', '1');
  assert.equal(dlg.c, undefined, 'no pop-up for a guessed name');
});

/** The one-tap chip + Undo with a fake clock and timers. */
function quickHarness(answers) {
  const h = sendHarness(() => answers.shift());
  const { ctx, el } = h;
  ctx.timers = [];
  ctx.setTimeout = (fn, ms) => { ctx.timers.push({ fn, ms }); return ctx.timers.length; };
  ctx.clearTimeout = (i) => { if (ctx.timers[i - 1]) ctx.timers[i - 1].fn = null; };
  ctx.document.querySelector = (sel) => (sel === '#team-msg [data-team-undo]' && /data-team-undo/.test(el('team-msg').innerHTML)
    ? { parentNode: { removeChild: () => { el('team-msg').innerHTML = el('team-msg').innerHTML.replace(/ <button type="button" class="team-undo"[^]*<\/button>/, ''); } } } : null);
  ctx.LAST_D.team.roles[2] = { role: 'submission', label: 'Submission Team', highlight: true, names: [], personIds: [], teamIds: [], entries: [], suggest: { id: '14', name: 'Monica Paola' } };
  return h;
}
const added = { names: ['Monica Paola'], personIds: ['14'], teamIds: [], entries: [{ id: '14', kind: 'person', name: 'Monica Paola' }] };
const none = { names: [], personIds: [], teamIds: [], entries: [] };

test('round 2 C1: one tap adds the suggested person at once (no pop-up) and offers Undo for 30 s; Undo removes that id with no confirm (undo: true); the timer takes Undo away', async () => {
  const { ctx, el } = quickHarness([{ status: 200, j: { ok: true, role: 'submission', cell: added, canAssign: true } }, { status: 200, j: { ok: true, role: 'submission', cell: none, canAssign: true } }]);
  ctx.teamClick({ target: { closest: () => ({ getAttribute: (k) => ({ 'data-team-sug': 'submission', 'data-uid': '14' }[k] || null) }) } });
  await ticks();
  assert.deepEqual(ctx.sent[0].body, { role: 'submission', op: 'add', userId: '14', expected: { personIds: [], teamIds: [] } });
  assert.equal(el('team-msg').className, 'act-msg ok');
  assert.ok(el('team-msg').innerHTML.startsWith('✓ Monica Paola added as Submission Team. <button type="button" class="team-undo" data-team-undo="1"'));
  assert.equal(ctx.timers[0].ms, 30000);
  assert.ok(el('team-card').innerHTML.includes('data-team-rm="submission" data-uid="14"'));
  ctx.teamUndoClick({ target: { closest: () => ({}) } });
  await ticks();
  assert.deepEqual(ctx.sent[1].body, { role: 'submission', op: 'remove', userId: '14', undo: true, expected: { personIds: ['14'], teamIds: [] } });
  assert.match(ctx.msgs.pop()[2], /^Undone — Monica Paola is no longer Submission Team\.$/);
  // a second chip add; then the 30 s pass: Undo is gone and does nothing
  const q = quickHarness([{ status: 200, j: { ok: true, role: 'submission', cell: added, canAssign: true } }]);
  q.ctx.teamQuick('submission', '14');
  await ticks();
  q.ctx.timers[0].fn();
  assert.ok(!/data-team-undo/.test(q.el('team-msg').innerHTML), 'Undo taken away after 30 s');
  q.ctx.teamUndo();
  await ticks();
  assert.equal(q.ctx.sent.length, 1, 'nothing sent');
});

test('round 2 C1: no Undo when nothing was added ("No change needed") or when the tap failed; a tap for a person who is not the suggestion does nothing', async () => {
  let q = quickHarness([{ status: 200, j: { ok: true, unchanged: true, role: 'submission', cell: added, canAssign: true } }]);
  q.ctx.teamQuick('submission', '14');
  await ticks();
  assert.ok(!/data-team-undo/.test(q.el('team-msg').innerHTML));
  assert.deepEqual(q.ctx.msgs.pop(), ['team-msg', 'ok', 'No change needed.']);
  q = quickHarness([{ status: 502, j: { ok: false, error: 'Monday did not keep the change — check the case in Monday before trying again.' } }]);
  q.ctx.teamQuick('submission', '14');
  await ticks();
  assert.deepEqual(q.ctx.msgs.pop(), ['team-msg', 'err', 'Monday did not keep the change — check the case in Monday before trying again.']);
  assert.equal(q.ctx.TEAM_UNDO, null);
  q = quickHarness([]);
  q.ctx.teamQuick('submission', '12');
  assert.equal(q.ctx.sent.length, 0);
});

test('round 2 C1 server: Undo removes only YOUR add made a moment ago on this case — another staffer, no add, a second Undo, after the time, or on the Client Master route → refused, nothing written', async () => {
  const m = fakeMonday({ cells: { [COL.manager]: { value: null, text: '' } } });
  await onCase({ role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } });
  assert.equal(m.writes.length, 1);
  // another staffer cannot use it
  const other = { id: '12', name: 'Bo Manager', email: 'bo@example.com', teamIds: [] };
  await refused(onCase({ role: 'manager', op: 'remove', userId: '14', undo: true, expected: { personIds: ['14'], teamIds: [] } }, { staff: other }), 409, /Undo is no longer possible/);
  // undo of someone never added by an Undo-able add
  await refused(onCase({ role: 'manager', op: 'remove', userId: '12', undo: true, expected: { personIds: ['14'], teamIds: [] } }), 409, /Undo is no longer possible/);
  assert.equal(m.writes.length, 1, 'nothing written by the refusals');
  // your own: removed, no confirm needed; the note says it was an Undo
  const r = await onCase({ role: 'manager', op: 'remove', userId: '14', undo: true, expected: { personIds: ['14'], teamIds: [] } });
  assert.equal(r.ok, true); assert.deepEqual(r.cell.personIds, []);
  assert.match(m.notes[1].vars.b, /<b>Case Manager: removed Monica Paola<\/b> \(now: nobody\) — Undo of the add a moment ago\. On the case page by Asha Officer/);
  // once only
  await refused(onCase({ role: 'manager', op: 'remove', userId: '14', undo: true, expected: { personIds: [], teamIds: [] } }), 409, /Undo is no longer possible/);
  // after the time
  const realNow = svc._io.now;
  await onCase({ role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } });
  svc._io.now = () => realNow() + svc.UNDO_MS + 1000;
  try { await refused(onCase({ role: 'manager', op: 'remove', userId: '14', undo: true, expected: { personIds: ['14'], teamIds: [] } }), 409, /Undo is no longer possible/); }
  finally { svc._io.now = realNow; }
  // undo is a remove only, and never through the Client Master route
  await refused(onCase({ role: 'manager', op: 'add', userId: '14', undo: true, expected: { personIds: [], teamIds: [] } }), 400);
  await refused(svc.assign({ staff: STAFF, hasKey: false, body: { itemId: ITEM, op: 'remove', undo: true, userId: '14', expected: { personIds: ['14'], teamIds: [] } } }), 400);
});

test('review: the note names a removed person by id only — the staff list cannot be read and the cell has two people in Monday\'s reverse text order → "user 14", never the other person; an expired list still names them', async () => {
  const m = fakeMonday({ usersFail: true, cells: { [COL.manager]: { value: ppl(14, 15), text: 'Bob B, Monica P' } } });
  const r = await onCase({ role: 'manager', op: 'remove', userId: '14', expected: { personIds: ['14', '15'], teamIds: [] } });
  assert.equal(r.ok, true); assert.deepEqual(r.cell.personIds, ['15']);
  assert.match(m.notes[0].vars.b, /<b>Case Manager: removed user 14<\/b>/);
  assert.ok(!/removed Bob B/.test(m.notes[0].vars.b));
  // the list read once (warm), then expired and unreadable: its names still name by id
  svc._resetUsers(); svc._inFlight.clear();
  const m2 = fakeMonday({ cells: { [COL.manager]: { value: ppl(14, 15), text: 'Bob B, Monica P' } } });
  await svc.assignableUsers();
  m2.usersFail = true;
  const realNow = svc._io.now;
  svc._io.now = () => realNow() + 3 * 60 * 60 * 1000;
  try { await onCase({ role: 'manager', op: 'remove', userId: '14', expected: { personIds: ['14', '15'], teamIds: [] } }); }
  finally { svc._io.now = realNow; }
  assert.match(m2.notes[0].vars.b, /<b>Case Manager: removed Monica Paola<\/b>/);
});

test('review: Undo never removes someone another staffer took off and put back, or after the cell changed in any other way', async () => {
  const other = { id: '12', name: 'Bo Manager', email: 'bo@example.com', teamIds: [] };
  const undoBody = { role: 'manager', op: 'remove', userId: '14', undo: true, expected: { personIds: ['14'], teamIds: [] } };
  // ✕ by another staffer, then put back from the Client Master route? (manager: the case page) — here: ✕ then a re-add on Monday
  let m = fakeMonday({ cells: { [COL.manager]: { value: null, text: '' } } });
  await onCase({ role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } });
  await onCase({ role: 'manager', op: 'remove', userId: '14', expected: { personIds: ['14'], teamIds: [] } }, { staff: other });
  m.cells[COL.manager] = { value: ppl(14), text: 'Monica Paola' };   // put back directly in Monday
  await refused(onCase(undoBody), 409, /Undo is no longer possible/);
  assert.equal(m.writes.length, 2, 'the Undo wrote nothing');
  // the officer: ✕ by another staffer, then re-added from the Client Master page
  svc._recentAdds.clear();
  m = fakeMonday({ cells: { [COL.officer]: { value: null, text: '' } } });
  const oBody = { role: 'officer', op: 'remove', userId: '13', undo: true, expected: { personIds: ['13'], teamIds: [] } };
  await onCase({ role: 'officer', userId: '13', expected: { personIds: [], teamIds: [] } });
  await onCase({ role: 'officer', op: 'remove', userId: '13', expected: { personIds: ['13'], teamIds: [] } }, { staff: other });
  await svc.assign({ staff: other, hasKey: false, body: { itemId: ITEM, userId: '13', expected: { personIds: [], teamIds: [] } } });
  await refused(onCase(oBody), 409, /Undo is no longer possible/);
  assert.equal(m.writes.length, 3);
  // someone else added beside the person in the meantime: the cell is no longer what the add left → refused
  svc._recentAdds.clear();
  m = fakeMonday({ cells: { [COL.manager]: { value: null, text: '' } } });
  await onCase({ role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } });
  m.cells[COL.manager] = { value: ppl(14, 12), text: 'Monica Paola, Bo Manager' };
  await refused(onCase({ ...undoBody, expected: { personIds: ['14', '12'], teamIds: [] } }), 409, /Undo is no longer possible/);
  assert.equal(m.writes.length, 1);
  // unchanged: the Undo still works
  svc._recentAdds.clear();
  m = fakeMonday({ cells: { [COL.manager]: { value: null, text: '' } } });
  await onCase({ role: 'manager', userId: '14', expected: { personIds: [], teamIds: [] } });
  const r = await onCase(undoBody);
  assert.equal(r.ok, true); assert.deepEqual(r.cell.personIds, []);
});

test('round 2 C2 handover: add a Case Support Officer and take the other off in ONE write with ONE note ("added X, removed Y"); the case route and the Client Master route', async () => {
  for (const viaCm of [false, true]) {
    svc._inFlight.clear(); patches = [];
    const m = fakeMonday({ cells: { [COL.officer]: { value: ppl(11, T(5)), text: 'Asha Officer, Team 5' } } });
    const b = { role: 'officer', userId: '14', alsoRemove: ['11'], expected: { personIds: ['11'], teamIds: ['5'] } };
    const r = viaCm ? await svc.assign({ staff: STAFF, hasKey: false, body: { itemId: ITEM, ...b, role: undefined } }) : await onCase(b);
    assert.equal(m.writes.length, 1, 'one write');
    assert.deepEqual(JSON.parse(m.writes[0].vars.c), { [COL.officer]: { personsAndTeams: [{ id: 5, kind: 'team' }, { id: 14, kind: 'person' }] } }, 'the team stays');
    assert.equal(m.notes.length, 1, 'one note');
    assert.match(m.notes[0].vars.b, new RegExp('<b>Case Support Officer: added Monica Paola, removed Asha Officer</b> \\(now: Team 5, Monica Paola\\)\\. On the ' + (viaCm ? 'Client Master page' : 'case page') + ' by Asha Officer'));
    assert.deepEqual(r.removed, [{ id: '11', name: 'Asha Officer' }]);
    assert.equal(r.lostAccess, undefined, 'policy "all": still allowed');
    assert.deepEqual((viaCm ? r.officer : r.cell).personIds, ['14']);
    assert.equal(patches.length, 1);
  }
  // only with an ADD of a Case Support Officer; a team is never taken off; someone already gone is simply not there
  const m = fakeMonday({ cells: { [COL.officer]: { value: ppl(11, T(5)), text: 'Asha Officer, Team 5' }, [COL.manager]: { value: ppl(12), text: 'Bo Manager' } } });
  await refused(onCase({ role: 'manager', userId: '14', alsoRemove: ['12'], expected: { personIds: ['12'], teamIds: [] } }), 400);
  await refused(onCase({ role: 'officer', op: 'remove', userId: '11', alsoRemove: ['12'], expected: { personIds: ['11'], teamIds: ['5'] } }), 400);
  await refused(onCase({ role: 'officer', userId: '14', alsoRemove: 'x', expected: { personIds: ['11'], teamIds: ['5'] } }), 400);
  await refused(onCase({ role: 'officer', userId: '14', alsoRemove: ['5'], expected: { personIds: ['11'], teamIds: ['5'] } }), 400, /A team cannot be removed here/);
  assert.equal(m.writes.length, 0);
  const r = await onCase({ role: 'officer', userId: '14', alsoRemove: ['13'], expected: { personIds: ['11'], teamIds: ['5'] } });
  assert.equal(r.removed, undefined);
  assert.deepEqual(JSON.parse(m.writes[0].vars.c)[COL.officer].personsAndTeams.map((x) => x.id), [11, 5, 14]);
});

test('round 2 C2 page: the Add pop-up for a Case Support Officer has an UNTICKED "Also take <name> off this case" per person (never a team, never a guess); ticked → alsoRemove; other roles have none', async () => {
  const { ctx, dlg } = sendHarness({ status: 200, j: { ok: true, role: 'officer', cell: { names: ['Monica Paola'], personIds: ['14'], teamIds: [], entries: [{ id: '14', kind: 'person', name: 'Monica Paola' }] }, removed: [{ id: '11', name: 'Asha Officer' }], canAssign: true } });
  ctx.LAST_D.team.staff = [{ id: '11', name: 'Asha Officer' }, { id: '14', name: 'Monica Paola' }];
  ctx.LAST_D.team.roles[0].entries.push({ id: '5', kind: 'team', name: 'Ops' }, { id: '7', kind: 'person', name: 'Maybe', guess: true });
  ctx.teamAddDlg('officer');
  const html = dlg.c.box.innerHTML;
  assert.ok(html.includes('<label class="team-also"><input type="checkbox" data-also="11"> Also take Asha Officer off this case</label>'));
  assert.equal((html.match(/data-also=/g) || []).length, 1, 'not the team, not the guessed name');
  assert.ok(!/checked/.test(html), 'unticked');
  const box = { checked: true, getAttribute: () => '11' };
  dlg.c.box.querySelectorAll = (sel) => (sel === 'input[data-also]' ? [box] : []);
  dlg.c.box.querySelector('#team-sel').value = '14';
  dlg.c.box.querySelector('#team-go').onclick();
  await ticks();
  assert.deepEqual(ctx.sent.pop().body, { role: 'officer', op: 'add', userId: '14', expected: { personIds: ['11'], teamIds: [] }, alsoRemove: ['11'] });
  assert.deepEqual(ctx.msgs.pop(), ['team-msg', 'ok', '✓ Monica Paola added as Case Support Officer. Asha Officer taken off.']);
  // the Case Manager pop-up has no handover box
  const h2 = sendHarness({ status: 200, j: { ok: true } });
  h2.ctx.LAST_D.team.staff = [{ id: '11', name: 'Asha Officer' }];
  h2.ctx.teamAddDlg('manager');
  assert.ok(!/data-also/.test(h2.dlg.c.box.innerHTML));
});

test('round 2 B7 pages: no 409 "changed" branch left on either page; a change made in Monday meanwhile is said in the success line', async () => {
  const cur = { names: ['Bo', 'Monica Paola'], personIds: ['12', '14'], teamIds: [], entries: [{ id: '12', kind: 'person', name: 'Bo' }, { id: '14', kind: 'person', name: 'Monica Paola' }] };
  const { ctx, dlg } = sendHarness({ status: 200, j: { ok: true, changedMeanwhile: true, role: 'manager', cell: cur, canAssign: true } });
  ctx.LAST_D.team.staff = [{ id: '14', name: 'Monica Paola' }];
  ctx.teamAddDlg('manager');
  dlg.c.box.querySelector('#team-sel').value = '14';
  dlg.c.box.querySelector('#team-go').onclick();
  await ticks();
  assert.equal(dlg.closed, 1);
  assert.deepEqual(ctx.msgs.pop(), ['team-msg', 'ok', '✓ Monica Paola added as Case Manager. (It had changed in Monday since the page loaded — the box shows it as it is now.)']);
  assert.deepEqual(ctx.LAST_D.team.roles[1].personIds, ['12', '14']);
  const caseSrc = fs.readFileSync(require.resolve('../src/routes/adminCase'), 'utf8');
  const dashSrc = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  assert.ok(!/j\.code === 'changed'/.test(caseSrc) && !/j\.code === 'changed'/.test(dashSrc));
});

test('round 2 the case page layout: the box sits below the readiness meters; the Undo has its own listener; every emitted script parses', () => {
  const { buildCockpitHTML } = require('../src/routes/adminCase');
  const html = buildCockpitHTML('2026-EE-001', {});
  const meters = html.indexOf('id="d-sub"'), card = html.indexOf('<div class="card team-card" id="team-card"'), rem = html.indexOf('id="rem-ov"');
  assert.ok(meters > 0 && meters < card && card < rem, 'below the readiness grid, above the reminders');
  assert.ok(html.includes("document.getElementById('team-msg').addEventListener('click', teamUndoClick);"));
  for (const js of pageScripts(html)) assert.doesNotThrow(() => new vm.Script(js));
});

/** The Client Master page's Assign code, run with a tiny DOM. */
async function cmHarness() {
  const dash = require('../src/routes/adminDashboard');
  const layer = dash.stack.find((l) => l.route && l.route.path === '/');
  const html = await new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
  const js = pageScripts(html).join('\n');
  const block = js.slice(js.indexOf('/* ── Assign the Case Support Officer'), js.indexOf('/* ── Change the client deadline'));
  const escFn = js.slice(js.indexOf('function escHtml('), js.indexOf('}', js.indexOf('function escHtml(')) + 1);
  const ctx = { document: { querySelector: () => null }, Date, setTimeout: () => 0, location: { pathname: '/admin/dashboard', search: '' }, encodeURIComponent, peekKey: () => '', _data: { cases: [] }, CasesTable: { setRows() {} } };
  vm.createContext(ctx);
  vm.runInContext(escFn + '\n' + block, ctx);
  const els = {};
  const inputs = [];
  const box = { querySelector: (sel) => (els[sel] = els[sel] || { innerHTML: '', textContent: '', value: '', disabled: false, focus() {}, querySelectorAll: () => inputs }) };
  const c = { box, busy: false };
  return { ctx, c, els, inputs, html };
}

test('round 2 Client Master parity: the list puts who usually holds the role first with "— N open" (the server\'s counts), the handover box, Assign off when the person is already there, the sign-in link on key-only', async () => {
  const { ctx, c, els, inputs, html } = await cmHarness();
  for (const js of pageScripts(html)) assert.doesNotThrow(() => new vm.Script(js));
  ctx.CM_STAFF = [{ id: '11', name: 'Asha Officer' }, { id: '12', name: 'Bo' }, { id: '14', name: 'Monica Paola' }];
  vm.runInContext("CM_STAFF = this.CM_STAFF; CM_USUAL = [{ id: '14', open: 4 }, { id: '11', open: 9 }];", ctx);
  const st = { itemId: '1', expected: { personIds: ['11'], teamIds: [] }, names: ['Asha Officer'], sel: els['#cm-asg-sel'] = { innerHTML: '', value: '', disabled: true, focus() {} } };
  ctx.cmAsgFill(c, st);
  assert.equal(st.sel.innerHTML, '<option value="">Choose a person…</option><optgroup label="Usually assigned"><option value="14">Monica Paola — 4 open</option><option value="11">Asha Officer — 9 open</option></optgroup><optgroup label="Everyone else"><option value="12">Bo</option></optgroup>');
  assert.equal(els['#cm-asg-also'].innerHTML, '<label class="cm-asg-also"><input type="checkbox" data-also="11"> Also take Asha Officer off this case</label>');
  // ticked → the line says it; the person already there → Assign off
  inputs.push({ checked: true, getAttribute: () => '11' });
  st.sel.value = '14';
  ctx.cmAsgSync(c, st);
  assert.equal(els['#cm-asg-rm'].textContent, 'Adds Monica Paola and takes Asha Officer off.');
  assert.equal(els['#cm-asg-go'].disabled, false);
  st.sel.value = '11';
  ctx.cmAsgSync(c, st);
  assert.equal(els['#cm-asg-go'].disabled, true, 'already there: nothing to send');
  assert.equal(ctx.cmAsgNeedsSignIn({ status: 403, j: { code: 'key-only' } }), true);
  assert.equal(ctx.cmAsgNeedsSignIn({ status: 403, j: { error: 'You are not assigned to this case.' } }), false);
  const src = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  const asg = src.slice(src.indexOf('/* ── Assign the Case Support Officer'), src.indexOf('/* ── Change the client deadline'));
  assert.ok(asg.includes('cmAsgNeedsSignIn(res) ? cmAsgSignIn(res.j)') && asg.includes('if (cmAsgNeedsSignIn(res)) { err.innerHTML = cmAsgSignIn(j); return; }'), 'both the staff-list load and the send');
  assert.ok(asg.includes('alsoRemove: ticked'));
  // the staff-list route sends the counts
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.ok(server.includes("usual: svc.pickerHints(u.list) });"));
  // pickerHints: null on a cold cache, else every role's list
  withCache(null);
  assert.equal(svc.pickerHints([]), null);
  withCache([rawRow(1, { officer: ppl(11) }), rawRow(2, { officer: ppl(11, 14) })]);
  assert.deepEqual(svc.pickerHints([{ id: '11', name: 'Asha Officer' }, { id: '14', name: 'Monica Paola' }]), { officer: [{ id: '14', open: 1 }, { id: '11', open: 2 }], manager: [], submission: [], ops: [] });
});

test('round 2 the staff guide: the simpler card, the one-tap name + Undo, the handover box and "+ Other role" are explained; the Client Master how-to names the handover', () => {
  const g = JSON.parse(require('../src/services/staffGuideService').data());
  const step = g.steps.find((s) => s.id === 'case-assign-team');
  const labels = step.options.map((o) => o.label);
  for (const l of ['+ Other role', '+ <name>', 'Undo', 'Also take <name> off this case', '✕']) assert.ok(labels.includes(l), l);
  const all = JSON.stringify(step);
  assert.ok(/Submission Preparation/.test(all) && /30 seconds/.test(all) && /more than half/.test(all));
  assert.ok(!/Fits this stage|This changed since your page loaded/.test(all), 'the old wording is gone');
  assert.ok(!/This changed since your page loaded/.test(JSON.stringify(g.steps.find((s) => s.id === 'cases-assign-officer'))));
  assert.match(g.howto.find((x) => x.q === 'How do I set who the Case Support Officer is?').answer, /Also take <name> off this case/);
  assert.match(g.howto.find((x) => x.q === 'How do I assign people to a case from the case page?').answer, /Undo is there for 30 seconds/);
});
