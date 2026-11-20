'use strict';

// The To-do tab on the Client Master page — stage 1, READ-ONLY (Faran 2026-11-19; switch TODO_TAB = off | admins | on).
// This file: the server side and the list engine's part.
//   - todoListService: the switch, who may have the tab, who "me" is, the answer part (pure — it cannot reach Monday);
//   - dashboardService: Case Manager ids on the row, leaving the service only on request; the board read unchanged;
//   - the /admin/dashboard-stats route, pinned by its source (server.js listens when loaded, so it cannot be run here)
//     and replayed line for line against the real services;
//   - listSpecs: the tab's column, filter, sort, words and the narrowing to the list on screen — and, with no such
//     tab on the page, everything exactly as it was (literal copies of the clean tree, 36636cd);
//   - the "Filtered" line's optional words.
// The page itself is in test/todoPage.test.js, the page helpers in test/todoUi.test.js.
// All made-up data (Officer One, Test Client A …). Monday is stubbed; nothing leaves the machine.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');
const crypto = require('crypto');

const T          = require('../src/services/todoListService');
const dash       = require('../src/services/dashboardService');
const mondayApi  = require('../src/services/mondayApi');
const cmv        = require('../src/services/clientMasterViews');
const caseAccess = require('../src/services/caseAccessService');
const S          = require('../src/routes/listSpecs');
const U          = require('../src/routes/clientMasterUi');
const CMW        = require('../src/routes/clientMasterWindows');
const { todoUi } = require('../src/routes/todoUi');
const { listCore, listTableUi, listTableScript } = require('../src/routes/listFilters');

const TDU = todoUi(CMW, U);
const VIEWS = cmv.pageViews();                       // the three Monday views — a page WITHOUT the tab
const VIEWS_ON = VIEWS.concat([T.PAGE_VIEW]);        // a page WITH the tab (To-do last)
/* What a page without the tab must never carry (spec §1). */
const TAB_WORDS = ['todoUi', 'tdot_list_cases_todo_who', 'To-do', 'view=todo', 'todoWith'];

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
/** Run with these environment values (undefined = not set), then put them back — also for an async body. */
function withEnv(vars, fn) {
  const keep = {};
  for (const k of Object.keys(vars)) { keep[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  const back = () => { for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } };
  let out;
  try { out = fn(); } catch (e) { back(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { back(); return v; }, (e) => { back(); throw e; });
  back();
  return out;
}
const ADMIN = { id: '501', name: 'Admin One', email: 'admin.one@example.com', teamIds: ['7'] };
const OFFICER = { id: '111', name: 'Officer One', email: 'officer.one@example.com', teamIds: [] };
const ADMINS = 'someone.else@example.com, Admin.One@Example.com';

/* ═══ todoListService ═══ */

test('the switch TODO_TAB: off by default; only "on" and "admins" (any case, spaces around) turn it on; anything else is off; read at call time', () => {
  const m = (v) => withEnv({ TODO_TAB: v }, () => T.mode());
  assert.equal(m(undefined), 'off');
  for (const v of ['', ' ', 'off', 'OFF', 'yes', 'true', '1', 'enabled', 'on,admins', 'admin', 'ons']) assert.equal(m(v), 'off', JSON.stringify(v));
  for (const v of ['on', 'ON', ' On ', 'on\n']) assert.equal(m(v), 'on', JSON.stringify(v));
  for (const v of ['admins', 'ADMINS', '  Admins\t']) assert.equal(m(v), 'admins', JSON.stringify(v));
  // call time, not load time: the same module answers the new value at once
  withEnv({ TODO_TAB: 'on' }, () => { assert.equal(T.mode(), 'on'); process.env.TODO_TAB = 'admins'; assert.equal(T.mode(), 'admins'); delete process.env.TODO_TAB; assert.equal(T.mode(), 'off'); });
});

test('allowed(): off = nobody; admins = only a Monday sign-in whose email is an admin\'s (no sign-in, the key alone, a non-admin: no); on = everybody, with or without a Monday sign-in', () => {
  const isAdmin = caseAccess.isAdminEmail;
  const table = (mode) => withEnv({ TODO_TAB: mode, ADMIN_EMAILS: ADMINS }, () => [
    T.allowed(null, isAdmin), T.allowed(undefined, isAdmin), T.allowed({ id: '9', name: 'No Email' }, isAdmin), T.allowed(OFFICER, isAdmin), T.allowed(ADMIN, isAdmin),
  ]);
  assert.deepEqual(table(undefined), [false, false, false, false, false]);
  assert.deepEqual(table('off'), [false, false, false, false, false]);
  assert.deepEqual(table('admins'), [false, false, false, false, true]);
  assert.deepEqual(table('on'), [true, true, true, true, true]);
  withEnv({ TODO_TAB: 'admins', ADMIN_EMAILS: ADMINS }, () => {
    // the check is the one handed in — and only a plain `true` from it counts
    assert.equal(T.allowed(ADMIN), false, 'no check given: not an admin');
    assert.equal(T.allowed(ADMIN, 'yes'), false);
    assert.equal(T.allowed(ADMIN, () => 'admin.one@example.com'), false, 'a truthy answer is not a yes');
    assert.equal(T.allowed(OFFICER, () => true), true);
    const seen = [];
    T.allowed(ADMIN, (e) => { seen.push(e); return true; });
    assert.deepEqual(seen, ['admin.one@example.com'], 'asked about the sign-in\'s own email, nothing else');
  });
  // an admin with no ADMIN_EMAILS set is nobody's admin
  assert.equal(withEnv({ TODO_TAB: 'admins', ADMIN_EMAILS: undefined }, () => T.allowed(ADMIN, isAdmin)), false);
});

test('meOf(): { id, name, teamIds } only for a plain Monday id (all digits); the name is the Monday name — never the email; team ids as strings, digits only', () => {
  assert.deepEqual(T.meOf(OFFICER), { id: '111', name: 'Officer One', teamIds: [] });
  assert.deepEqual(T.meOf({ id: 111, name: 'Officer One', email: 'officer.one@example.com', teamIds: [7, '8', 7, 'x9', null, ' 3', '', 12.5] }), { id: '111', name: 'Officer One', teamIds: ['7', '8'] });
  for (const bad of [null, undefined, {}, { id: null }, { id: '' }, { id: '12a' }, { id: ' 12' }, { id: '-5' }, { id: '1.5' }, { id: 'abc', name: 'X' }, { id: {} }]) assert.equal(T.meOf(bad), null, JSON.stringify(bad));
  // the name: one line, trimmed, at most 60; no name = '' (NOT the email, which the house helper staffIdentity falls back to)
  assert.equal(T.meOf({ id: '1', email: 'officer.one@example.com' }).name, '');
  assert.equal(T.meOf({ id: '1', name: '', email: 'officer.one@example.com' }).name, '');
  assert.equal(T.meOf({ id: '1', name: '   ', email: 'officer.one@example.com' }).name, '');
  assert.equal(T.meOf({ id: '1', name: 42 }).name, '');
  assert.equal(T.meOf({ id: '1', name: '  Officer \n One\t ' }).name, 'Officer One');
  assert.equal(T.meOf({ id: '1', name: 'A'.repeat(59) + ' ' + 'B'.repeat(30) }).name, 'A'.repeat(59), 'cut to 60, and no space left at the end');
  assert.equal(T.meOf({ id: '1', name: 'N'.repeat(200) }).name.length, 60);
  // a Monday account whose NAME is its email address (a shared login): no name at all
  assert.equal(T.meOf({ id: '1', name: 'shared.login@example.com', email: 'shared.login@example.com' }).name, '');
  assert.equal(T.meOf({ id: '1', name: 'Shared <shared.login@example.com>' }).name, '');
  // nothing else of the sign-in comes along
  assert.deepEqual(Object.keys(T.meOf({ ...ADMIN, iat: 1, exp: 2, extra: 'x' })), ['id', 'name', 'teamIds']);
  assert.deepEqual(T.meOf({ id: '1', name: 'Officer One', teamIds: 'not a list' }).teamIds, []);
});

const openRow = (id, extra = {}) => ({ id: String(id), views: ['assigning'], ...extra });

test('forAnswer(): not allowed = null and NO row is touched; allowed = every row in the Assigning view gets \'todo\' once, no other row, and the answer part is { me }', () => {
  const isAdmin = caseAccess.isAdminEmail;
  const rows = () => [openRow(1), { id: '2', views: ['deadlines'] }, { id: '3', views: [] }, openRow(4, { views: ['assigning', 'deadlines', 'eeita'] }), { id: '5' }, null, { id: '7', views: 'assigning' }];
  // off
  withEnv({ TODO_TAB: undefined, ADMIN_EMAILS: ADMINS }, () => {
    const r = rows(), before = JSON.stringify(r);
    assert.equal(T.forAnswer(r, ADMIN, isAdmin), null);
    assert.equal(JSON.stringify(r), before, 'off: not one row changed');
  });
  // admins: a non-admin, and nobody signed in
  withEnv({ TODO_TAB: 'admins', ADMIN_EMAILS: ADMINS }, () => {
    for (const who of [OFFICER, null]) { const r = rows(), before = JSON.stringify(r); assert.equal(T.forAnswer(r, who, isAdmin), null); assert.equal(JSON.stringify(r), before); }
    const r = rows();
    assert.deepEqual(T.forAnswer(r, ADMIN, isAdmin), { me: { id: '501', name: 'Admin One', teamIds: ['7'] } });
    assert.deepEqual(r.map((x) => x && x.views), [['assigning', 'todo'], ['deadlines'], [], ['assigning', 'deadlines', 'eeita', 'todo'], undefined, null, 'assigning']);
  });
  // on: also with no Monday sign-in — then there is no "me"
  withEnv({ TODO_TAB: 'on', ADMIN_EMAILS: undefined }, () => {
    const r = rows();
    assert.deepEqual(T.forAnswer(r, null, isAdmin), { me: null });
    assert.deepEqual(r[0].views, ['assigning', 'todo']);
    // once: a second pass over the same rows adds nothing
    assert.deepEqual(T.forAnswer(r, OFFICER, isAdmin), { me: { id: '111', name: 'Officer One', teamIds: [] } });
    assert.deepEqual(r.map((x) => x && x.views), [['assigning', 'todo'], ['deadlines'], [], ['assigning', 'deadlines', 'eeita', 'todo'], undefined, null, 'assigning']);
    // no list of rows at all: still an answer, nothing thrown
    assert.deepEqual(T.forAnswer(undefined, null, isAdmin), { me: null });
    assert.deepEqual(T.forAnswer(null, OFFICER, isAdmin).me.id, '111');
  });
  assert.equal(T.OPEN_VIEW, 'assigning');
  assert.ok(cmv.VIEW_KEYS.includes(T.OPEN_VIEW), 'the open rows are the rows of a Monday view the page has');
  assert.ok(!cmv.VIEW_KEYS.includes(T.PAGE_VIEW.key), 'the mark is never a Monday view\'s key');
});

test('forAnswer(): not allowed also takes a managerIds that came along off the rows (belt and braces); allowed leaves it', () => {
  const mk = () => [openRow(1, { managerIds: { personIds: ['211'], teamIds: [] } }), { id: '2', views: [], managerIds: { personIds: [], teamIds: [] } }];
  withEnv({ TODO_TAB: 'off' }, () => { const r = mk(); assert.equal(T.forAnswer(r, ADMIN, () => true), null); assert.ok(r.every((x) => !('managerIds' in x))); assert.deepEqual(r[0].views, ['assigning']); });
  withEnv({ TODO_TAB: 'on' }, () => { const r = mk(); assert.ok(T.forAnswer(r, null, () => false)); assert.deepEqual(r[0].managerIds, { personIds: ['211'], teamIds: [] }); });
});

test('the answer part never carries an email: no "@" anywhere in it, also when the sign-in has no name, and whatever else the sign-in holds', () => {
  withEnv({ TODO_TAB: 'on' }, () => {
    for (const staff of [
      { id: '111', name: '', email: 'officer.one@example.com', teamIds: [] },
      { id: '111', email: 'officer.one@example.com' },
      { id: '111', name: 'officer.one@example.com', email: 'officer.one@example.com', teamIds: ['officer.one@example.com'] },
      { id: 'officer.one@example.com', name: 'Officer One', email: 'officer.one@example.com' },
      OFFICER, ADMIN,
    ]) {
      const part = T.forAnswer([openRow(1)], staff, caseAccess.isAdminEmail);
      assert.ok(!JSON.stringify(part).includes('@'), JSON.stringify(part));
      assert.deepEqual(Object.keys(part), ['me']);
    }
  });
});

test('the shared team key is not an input: forAnswer / allowed take the Monday sign-in and the admin check, nothing else; the module requires nothing — it cannot reach Monday', () => {
  assert.equal(T.forAnswer.length, 3);
  assert.equal(T.allowed.length, 2);
  assert.equal(T.meOf.length, 1);
  const src = fs.readFileSync(require.resolve('../src/services/todoListService'), 'utf8');
  assert.ok(!/require\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')), 'no require at all');
  assert.ok(!/\b(fetch|axios|mondayApi|mutation|ADMIN_API_KEY|x-api-key|hasAdminKey|viewer)\b/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')), 'no request, no key and no `viewer` in the code');
  // Monday refuses every call: the service still answers
  let calls = 0;
  const restore = stub(mondayApi, 'query', async () => { calls++; throw new Error('Monday must not be called'); });
  try {
    withEnv({ TODO_TAB: 'on' }, () => {
      const rows = [openRow(1), openRow(2)];
      assert.deepEqual(T.forAnswer(rows, OFFICER, caseAccess.isAdminEmail), { me: { id: '111', name: 'Officer One', teamIds: [] } });
      assert.equal(T.allowed(null, caseAccess.isAdminEmail), true);
    });
  } finally { restore(); }
  assert.equal(calls, 0);
});

test('PAGE_VIEW and DEFAULT_COLS: the page-only view definition and the tab\'s twelve columns, exactly as agreed (plain data)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(T.PAGE_VIEW)), {
    key: 'todo', label: 'To-do', pageOnly: true, by: 'todo', dir: 'ASC', groupOrder: 'position', sort: null,
    stageStrip: false, deadlineBox: false, todoBox: true,
    hint: "Each person's open cases from Client Master: Case Support Officer, or Case Manager (for review). Soonest deadline first. Not the Monday to-do boards.",
  });
  assert.deepEqual([...T.DEFAULT_COLS], ['caseRef', 'clientName', 'todoWith', 'caseTypeV', 'subType', 'stageV', 'actualDeadline', 'deadlineType',
    'internalDeadline', 'officerV', 'qPct', 'docPct']);
  assert.ok(Object.isFrozen(T.PAGE_VIEW) && Object.isFrozen(T.DEFAULT_COLS), 'shared data: nobody changes it by accident');
  assert.ok(!/["\\`<>]/.test(T.PAGE_VIEW.hint), 'a plain tooltip, safe to put in the page');
  assert.ok(/^[a-z]+$/.test(T.PAGE_VIEW.key));
  // it is NOT a Monday view: clientMasterViews is untouched and would refuse it
  assert.deepEqual(cmv.pageViews().map((v) => v.key), ['assigning', 'deadlines', 'eeita']);
  assert.throws(() => cmv.compileView(T.PAGE_VIEW), /not modelled/);
  // every one of the twelve is a column of the list when the tab is on the page
  const ids = S.casesListOpts({ views: VIEWS_ON }).cols.map((c) => c.id);
  for (const id of T.DEFAULT_COLS) assert.ok(ids.includes(id), id);
});

/* ═══ dashboardService: Case Manager ids on the row, on request only ═══ */

const CSO = 'multiple_person_mm0xm710', MGR = 'multiple_person_mm0xhmgk', STAGE = 'color_mm0x8faa', RETAINED = 'multiple_person_mm334yp5';
const pt = (...list) => JSON.stringify({ personsAndTeams: list.map((x) => (typeof x === 'object' ? x : { id: x, kind: 'person' })) });
const team = (id) => ({ id, kind: 'team' });
const stage = (index, text) => ({ id: STAGE, text, value: JSON.stringify({ index }) });
const item = (id, cells, name) => ({ id: String(id), name: name || 'Test Client ' + id, created_at: '2026-11-01T00:00:00Z', group: { id: 'g1', title: 'November 2026' }, column_values: cells });

test('parseItem: managerIds is read like officerIds — people and teams apart, as strings, no id twice; an empty or unreadable cell is two empty lists', () => {
  const r = dash.parseItem(item(1, [
    { id: CSO, text: 'Officer One, Officer Two', value: pt(111, 112) },
    { id: MGR, text: 'Reviewer One, Team Eight, Reviewer One', value: pt(211, team(8), 211, { id: null, kind: 'person' }) },
  ]), 0);
  assert.deepEqual(r.officerIds, { personIds: ['111', '112'], teamIds: [] });
  assert.deepEqual(r.managerIds, { personIds: ['211'], teamIds: ['8'] });
  assert.equal(r.manager, 'Reviewer One, Team Eight, Reviewer One', 'the names stay as the cell has them');
  const empty = dash.parseItem(item(2, [{ id: MGR, text: '', value: null }]), 0);
  assert.deepEqual(empty.managerIds, { personIds: [], teamIds: [] });
  assert.equal(empty.manager, 'Unassigned');
  assert.deepEqual(dash.parseItem(item(3, []), 0).managerIds, { personIds: [], teamIds: [] }, 'no cell in the answer');
  assert.deepEqual(dash.parseItem(item(4, [{ id: MGR, text: 'Reviewer One', value: '{not json' }]), 0).managerIds, { personIds: [], teamIds: [] });
  // only the Case Manager cell: the other people columns never reach it
  const other = dash.parseItem(item(5, [{ id: RETAINED, text: 'Staff Nine', value: pt(311) }, { id: 'multiple_person_mm0xp0sq', text: 'Staff Ten', value: pt(312) }, { id: CSO, text: 'Officer One', value: pt(111) }]), 0);
  assert.deepEqual(other.managerIds, { personIds: [], teamIds: [] });
  assert.deepEqual(dash.TODO_FIELDS, ['managerIds']);
});

/* Literal copies of the row's keys on the clean tree (36636cd) — what every caller got before this stage. */
const KEYS_TODAY = ['id', 'createdAt', 'clientName', 'caseRef', 'caseType', 'caseStage', 'slaRisk', 'health', 'escalationRequired', 'expiryFlagged', 'clientBlocked', 'chasingStage',
  'reminderCount', 'qReadiness', 'docReadiness', 'docReviewed', 'overallReadiness', 'expectedReadiness', 'behindSchedule', 'blockingQ', 'blockingDoc', 'missingRequired', 'delayLevel',
  'daysElapsed', 'manager', 'supervisor', 'lastActivity', 'hardDeadline', 'assignees', 'boardIdx', 'groupId', 'groupTitle', 'stageIdx', 'phase', 'phaseIdx', 'deadlineType',
  'actualDeadline', 'promisedDate', 'caseTypeIds', 'officer', 'officerIds', 'docUploadedPct', 'paymentStatus', 'dependents', 'caseSubType', 'retainedBy', 'retainerStatus',
  'qReadinessPct', 'views'];
const KEYS_TODAY_CONTACT = ['id', 'createdAt', 'clientName', 'caseRef', 'caseType', 'caseStage', 'slaRisk', 'health', 'escalationRequired', 'expiryFlagged', 'clientBlocked', 'chasingStage',
  'reminderCount', 'qReadiness', 'docReadiness', 'docReviewed', 'overallReadiness', 'expectedReadiness', 'behindSchedule', 'blockingQ', 'blockingDoc', 'missingRequired', 'delayLevel',
  'daysElapsed', 'manager', 'supervisor', 'lastActivity', 'hardDeadline', 'assignees', 'boardIdx', 'groupId', 'groupTitle', 'stageIdx', 'phase', 'phaseIdx', 'deadlineType',
  'actualDeadline', 'promisedDate', 'caseTypeIds', 'officer', 'officerIds', 'docUploadedPct', 'paymentStatus', 'dependents', 'clientEmail', 'clientPhone', 'caseSubType', 'retainedBy',
  'retainerStatus', 'portalLink', 'qReadinessPct', 'more', 'views'];   // `more` (2026-11-20): the optional columns' values — with the contact details only, never on the plain rows above
const STATS_KEYS_TODAY = ['summary', 'byStage', 'byHealth', 'bySlaRisk', 'byType', 'byManager', 'byChasingStage', 'byDelayLevel', 'readinessByStage', 'cases', 'meta', 'dataAt', 'generatedAt'];
/* The columns the board read asks for, on the clean tree, in its order (FETCH_IDS). Case Manager was already among them. */
const FETCH_IDS_TODAY = ['text_mm142s49', 'dropdown_mm0xd1qn', 'color_mm0x8faa', 'color_mm0xszmm', 'color_mm0xf5ry', 'color_mm1a7vbn', 'color_mm0x7bje', 'numeric_mm0x9dea', 'numeric_mm0x5g9x',
  'numeric_mm2njqk1', 'numeric_mm0x58n1', 'color_mm1b5gqv', 'color_mm1abve4', 'numeric_mm1a4e8r', 'multiple_person_mm0xhmgk', 'multiple_person_mm0xp0sq', 'date_mm1amqyr', 'date_mm0x5pqd',
  'numeric_mm0xbpn1', 'numeric_mm0xje6p', 'numeric_mm0x6qy4', 'color_mm1bq05h', 'numeric_mm0xrbk1', 'color_mm3tf1ys', 'color_mm6w7cdd', 'date_mm33sj6t', 'date_mm3t66pa',
  'multiple_person_mm0xm710', 'color_mm0x9fnn', 'text_mm0x1zdk', 'text_mm0xw6bp', 'phone_mm33zr0c', 'dropdown_mm0x4t91', 'multiple_person_mm334yp5', 'color_mm2yh6jd', 'link_mm2vta5',
  'multiple_person_mm0xgpt', 'multiple_person_mm2nhsx1', 'multiple_person_mm0xrzve'];
/* Since 2026-11-20 the read also asks for fourteen more columns — the optional "More from the Monday board" columns (the other five of
   the nineteen were already read). They come right after the portal link, before the access filter's people columns. Nothing of the To-do tab. */
const FETCH_IDS_MORE = ['date_mm0xjm1z', 'date_mm0x26t4', 'date_mm0xfgbp', 'date_mm0xgk76', 'date_mm34x2ga', 'color_mm0x9s08', 'text_mm0xvpr9', 'link_mm47dng8', 'color_mm6be76m',
  'text_mm8t8zhx', 'text_mm8tmcm7', 'text_mm8tsw2c', 'text_mm8tqsa5', 'link_mm8txy20'];
const FETCH_IDS_NOW = FETCH_IDS_TODAY.slice(0, FETCH_IDS_TODAY.indexOf('link_mm2vta5') + 1).concat(FETCH_IDS_MORE, FETCH_IDS_TODAY.slice(FETCH_IDS_TODAY.indexOf('link_mm2vta5') + 1));

function fakeBoard(items) {
  const calls = [];
  const restore = stub(mondayApi, 'query', async (q, v) => {
    calls.push(q);
    if (/items_page\(limit: 500/.test(q)) return { boards: [{ items_page: { cursor: null, items: items.map((it) => ({ id: it.id })) } }] };
    if (/\{ groups \{ id title position \}/.test(q)) return { boards: [{ groups: [], columns: [] }] };
    if (/items\(ids: \$ids, limit: 100\)/.test(q)) { const by = new Map(items.map((it) => [it.id, it])); return { items: v.ids.map((id) => by.get(id)).filter(Boolean).map((it) => JSON.parse(JSON.stringify(it))) }; }
    throw new Error('unexpected query ' + q.slice(0, 60));
  });
  return { calls, restore };
}
/** A made-up board: five open cases and one that is not open. */
const BOARD = [
  item(1, [stage(1, 'Internal Review'), { id: CSO, text: 'Officer One', value: pt(111) }, { id: MGR, text: 'Reviewer One', value: pt(211) }, { id: 'text_mm142s49', text: '2026-EE-001', value: null }]),
  item(2, [stage(1, 'Internal Review'), { id: CSO, text: 'Officer One, Officer Two', value: pt(111, 112) }, { id: 'text_mm142s49', text: '2026-EE-002', value: null }]),
  item(3, [stage(12, 'Pre-Onboarding'), { id: RETAINED, text: 'Staff Nine', value: pt(311) }, { id: 'text_mm142s49', text: '2026-EE-003', value: null }]),   // somebody in another people column only
  item(4, [stage(0, 'Document Collection Started'), { id: CSO, text: 'Team Nine', value: pt(team(9)) }, { id: MGR, text: 'Team Eight', value: pt(team(8)) }, { id: 'text_mm142s49', text: '2026-EE-004', value: null }]),
  item(5, [stage(6, 'Application Submitted'), { id: CSO, text: 'Officer Two', value: pt(112) }, { id: MGR, text: 'Reviewer One', value: pt(211) }, { id: 'text_mm142s49', text: '2026-EE-005', value: null }]),   // not open
  item(6, [stage(2, 'Stuck'), { id: MGR, text: 'Reviewer One', value: pt(211) }, { id: 'text_mm142s49', text: '2026-EE-006', value: null }]),                 // a manager and no officer
];
/** Run against the made-up board with a still clock and a clean cache; everything is put back after. */
async function onBoard(items, fn) {
  const board = fakeBoard(items);
  const restoreClock = stub(dash._casesIo.io, 'now', () => Date.parse('2026-11-19T15:00:00Z'));
  dash.invalidateCases(); dash._casesIo.overrides.clear();
  try { return await fn(board); } finally { restoreClock(); board.restore(); dash.invalidateCases(); }
}

test('getDashboardStats: managerIds leaves the service ONLY with { todo: true } — every other caller gets the rows with exactly the keys they had before', async () => {
  await onBoard(BOARD, async (board) => {
    const plain = await dash.getDashboardStats();                                    // /api/dashboard/stats (the key-only route)
    assert.deepEqual(Object.keys(plain), STATS_KEYS_TODAY);
    for (const c of plain.cases) assert.deepEqual(Object.keys(c), KEYS_TODAY);
    const contact = await dash.getDashboardStats(undefined, { contact: true });      // the page's own route, tab not on for this viewer
    for (const c of contact.cases) assert.deepEqual(Object.keys(c), KEYS_TODAY_CONTACT);
    for (const opts of [{}, { fresh: false }, { contact: true, todo: false }, { todo: undefined }, { todo: null }, { todo: 1 }, { todo: 'true' }, { todo: 'on' }, { todo: {} }]) {
      const s = await dash.getDashboardStats(undefined, opts);
      assert.ok(s.cases.every((c) => !('managerIds' in c)), 'not kept for ' + JSON.stringify(opts) + ' — only a plain true keeps it');
      assert.ok(!JSON.stringify(s).includes('managerIds'));
    }
    // asked for: the same rows, plus the one field, right after officerIds
    const todo = await dash.getDashboardStats(undefined, { todo: true });
    const withIt = KEYS_TODAY.slice(); withIt.splice(withIt.indexOf('officerIds') + 1, 0, 'managerIds');
    for (const c of todo.cases) assert.deepEqual(Object.keys(c), withIt);
    assert.deepEqual(todo.cases.map((c) => [c.id, c.managerIds]), [
      ['1', { personIds: ['211'], teamIds: [] }], ['2', { personIds: [], teamIds: [] }], ['3', { personIds: [], teamIds: [] }],
      ['4', { personIds: [], teamIds: ['8'] }], ['5', { personIds: ['211'], teamIds: [] }], ['6', { personIds: ['211'], teamIds: [] }],
    ]);
    // both options together: the contact keys and the one field
    const both = await dash.getDashboardStats(undefined, { contact: true, todo: true });
    const bothKeys = KEYS_TODAY_CONTACT.slice(); bothKeys.splice(bothKeys.indexOf('officerIds') + 1, 0, 'managerIds');
    for (const c of both.cases) assert.deepEqual(Object.keys(c), bothKeys);
    // the option changes nothing else in the answer
    const strip = (s) => JSON.stringify({ ...s, generatedAt: null, cases: s.cases.map(({ managerIds, ...rest }) => rest) });
    assert.equal(strip(todo), strip(plain));
    // the service itself never marks a row for the tab — that is the route's step (todoListService.forAnswer)
    assert.ok(todo.cases.every((c) => !c.views.includes('todo')));
    // one read of the board served every call above; nothing was written
    assert.equal(board.calls.filter((q) => /items_page\(limit: 500/.test(q)).length, 1);
    assert.ok(board.calls.every((q) => !/mutation/.test(q)), 'no Monday write');
  });
});

test('the board read is unchanged: the same columns in the same order as before (Case Manager was already read) — no new Monday read for the tab', async () => {
  await onBoard(BOARD, async (board) => {
    await dash.getDashboardStats(undefined, { todo: true });
    await dash.getDashboardStats(undefined, { contact: true, todo: true });
    const rowsQ = board.calls.filter((q) => /items\(ids: \$ids, limit: 100\)/.test(q));
    assert.equal(rowsQ.length, 1, 'one batch read for the six rows, served to both calls');
    const ids = /column_values\(ids: \[([^\]]*)\]\)/.exec(rowsQ[0])[1].split(',').map((x) => JSON.parse(x));
    assert.deepEqual(ids, FETCH_IDS_NOW);
    assert.deepEqual(ids.filter((id) => !FETCH_IDS_MORE.includes(id)), FETCH_IDS_TODAY, 'without the optional columns of 2026-11-20: the read of before, to the letter');
    assert.equal(FETCH_IDS_NOW.length, FETCH_IDS_TODAY.length + 14);
    assert.ok(ids.includes(dash.COLS.caseManager) && ids.includes(dash.COLS.caseSupportOfficer));
    assert.equal(board.calls.length, 3, 'the id listing, the board meta and the rows — as before');
    assert.equal(rowsQ[0], 'query($ids: [ID!]) { items(ids: $ids, limit: 100) { id name created_at group { id title } column_values(ids: [' + FETCH_IDS_NOW.map((id) => '"' + id + '"').join(',') + ']) { id text value } } }');
  });
});

test('the access filter runs first: a viewer limited to their own cases gets managerIds only on the rows they may see', async () => {
  await withEnv({ CASE_VISIBILITY: 'assigned' }, () => onBoard(BOARD, async () => {
    const mine = await dash.getDashboardStats({ userId: '211', teamIds: [], isAdmin: false }, { todo: true });
    assert.deepEqual(mine.cases.map((c) => c.id), ['1', '5', '6'], 'the three cases the person is Case Manager on');
    assert.ok(mine.cases.every((c) => c.managerIds.personIds.includes('211')));
    const none = await dash.getDashboardStats({ userId: '999', teamIds: [], isAdmin: false }, { todo: true });
    assert.deepEqual(none.cases, []);
  }));
});

/* ═══ the route ═══ */

const SERVER = fs.readFileSync(require.resolve('../src/server'), 'utf8');
const ROUTE = SERVER.slice(SERVER.indexOf("app.get('/admin/dashboard-stats'"), SERVER.indexOf("app.get('/admin/needs-attention'"));
const API_ROUTE = SERVER.slice(SERVER.indexOf("app.get('/api/dashboard/stats'"), SERVER.indexOf('function hasAdminKey'));

test('the route, by its source: the To-do part is worked out from tryStaffAuth(req) — never from `viewer` — and `todo` is in the answer only when it is not null', () => {
  assert.ok(ROUTE.length > 1500 && ROUTE.length < 3000, 'the slice is the one route');
  // the Monday sign-in, read once, is what the service gets — both times
  assert.match(ROUTE, /const todoList = require\('\.\/services\/todoListService'\);\n\s+const staff = tryStaffAuth\(req\); const todoOk = todoList\.allowed\(staff, caseAccess\.isAdminEmail\);/);
  assert.match(ROUTE, /const todo = todoList\.forAnswer\(stats\.cases, staff, caseAccess\.isAdminEmail\);/);
  const calls = ROUTE.match(/todoList\.\w+\([^;]*\);/g);
  assert.deepEqual(calls, ['todoList.allowed(staff, caseAccess.isAdminEmail);', 'todoList.forAnswer(stats.cases, staff, caseAccess.isAdminEmail);'], 'the only two calls into the service');
  for (const c of calls) assert.ok(!/viewer|hasAdminKey|ADMIN_API_KEY|req\.(query|headers)/.test(c), c);
  assert.equal((ROUTE.match(/\bstaff\b/g) || []).length, 3, '`staff` is set once from tryStaffAuth(req) and used only in those two calls');
  // the rows keep managerIds only for a viewer the tab is on for
  assert.match(ROUTE, /getDashboardStats\(viewer\.scope === 'all' \? undefined : viewer, \{ fresh: req\.query\.fresh === '1', contact: req\.query\.contact === '1', todo: todoOk \}\)/);
  assert.ok(!/todo: true/.test(ROUTE));
  // the order: allowed → the rows → Assign's marks → the To-do marks → the answer
  const at = (t) => { const i = ROUTE.indexOf(t); assert.ok(i > 0, t); return i; };
  assert.ok(at('todoList.allowed(') < at('getDashboardStats(') && at('getDashboardStats(') < at('markAssignable(stats.cases, tryStaffAuth(req))')
    && at('markAssignable(stats.cases, tryStaffAuth(req))') < at('todoList.forAnswer(') && at('todoList.forAnswer(') < at('res.json({ ...stats'));
  // in the answer only when there is one
  assert.match(ROUTE, /res\.json\(\{ \.\.\.stats, waitingAt, viewer: \{ name: viewer\.name, email: viewer\.email, scope: viewer\.scope, isAdmin: viewer\.isAdmin, canAssign \}, \.\.\.\(todo \? \{ todo \} : \{\}\) \}\);/);
  assert.equal((ROUTE.match(/res\.json\(/g) || []).length, 1, 'one success answer');
  // nothing is hung on the shared board meta; nothing of a row or a person is logged; no write
  assert.ok(!/stats\.meta|\.meta\s*=|meta\./.test(ROUTE));
  assert.ok(!/mutation|invalidateCases|patchCachedColumn/.test(ROUTE));
  for (const line of ROUTE.split('\n').filter((l) => /console\./.test(l))) assert.ok(!/staff|todo|managerIds/.test(line), line);
  // still never kept by the browser, still signed-in staff only
  assert.match(ROUTE, /^app\.get\('\/admin\/dashboard-stats', async \(req, res\) => \{\n  res\.set\('Cache-Control', 'private, no-store'\);\n  const viewer = resolveViewer\(req\);\n  if \(!viewer\) \{\n    return res\.status\(401\)/);
});

test('by source: the key-only route /api/dashboard/stats never asks for the To-do fields; the service is used in the one route and nowhere else; there is no new route', () => {
  const api = API_ROUTE.slice(0, API_ROUTE.indexOf('});') + 3);            // the route itself, without the notes that follow it
  assert.ok(api.length > 150 && api.length < 500);
  assert.match(api, /^app\.get\('\/api\/dashboard\/stats', async \(req, res\) => \{\n  try \{\n    const stats = await dashboardService\.getDashboardStats\(\);\n    res\.json\(stats\);/);
  assert.ok(!/todo|managerIds|tryStaffAuth/i.test(api));
  assert.equal(SERVER.split("require('./services/todoListService')").length - 1, 1, 'required in one place');
  assert.equal((SERVER.match(/todoList\./g) || []).length, 2);
  assert.equal((SERVER.match(/todo: /g) || []).length, 1, 'the option is passed by one call');
  assert.equal((SERVER.match(/getDashboardStats\(/g) || []).length, 2, 'the two callers there always were');
  assert.ok(!/app\.(get|post|put|patch|delete|use)\(\s*['"][^'"]*to-?do/i.test(SERVER), 'no to-do route');
  // the dashboard service knows nothing of the switch or of who is asking
  const svc = fs.readFileSync(require.resolve('../src/services/dashboardService'), 'utf8');
  assert.ok(!/require\([^)]*todoListService|process\.env\.TODO_TAB|tryStaffAuth|staffAuth/.test(svc));
  assert.match(svc, /if \(todo !== true\) for \(const c of cases\) for \(const f of TODO_FIELDS\) delete c\[f\];/);
});

/**
 * The route's own To-do lines, replayed in its order against the real services (the source pins above hold the route
 * to these lines). staff = what tryStaffAuth(req) answers; the shared key is deliberately nowhere in here.
 */
async function pageAnswer(staff) {
  const todoOk = T.allowed(staff, caseAccess.isAdminEmail);
  const stats = await dash.getDashboardStats(undefined, { fresh: false, contact: true, todo: todoOk });
  const todo = T.forAnswer(stats.cases, staff, caseAccess.isAdminEmail);
  return JSON.parse(JSON.stringify({ ...stats, waitingAt: null, viewer: { name: 'Admin', email: '', scope: 'all', isAdmin: true, canAssign: !!staff }, ...(todo ? { todo } : {}) }));
}
const noTodoAnywhere = (a) => !('todo' in a) && a.cases.every((c) => !c.views.includes('todo') && !('managerIds' in c)) && !/managerIds|"todo"/.test(JSON.stringify(a));

test('the answer per mode: off = no `todo`, no row marked, no managerIds — for anyone; admins = only for a named admin signed in with Monday; on = for everybody, `me` from the Monday sign-in alone', async () => {
  await onBoard(BOARD, async (board) => {
    // off (and not set at all): exactly the answer of before, whoever asks
    for (const mode of [undefined, 'off', 'nonsense']) {
      await withEnv({ TODO_TAB: mode, ADMIN_EMAILS: ADMINS }, async () => {
        for (const staff of [null, OFFICER, ADMIN]) {
          const a = await pageAnswer(staff);
          assert.ok(noTodoAnywhere(a), String(mode));
          for (const c of a.cases) assert.deepEqual(Object.keys(c), KEYS_TODAY_CONTACT);
        }
      });
    }
    // admins
    await withEnv({ TODO_TAB: 'admins', ADMIN_EMAILS: ADMINS }, async () => {
      assert.ok(noTodoAnywhere(await pageAnswer(null)), 'the team key alone (no Monday sign-in): nothing — the key is not a person');
      assert.ok(noTodoAnywhere(await pageAnswer(OFFICER)), 'a Monday sign-in that is not an admin: nothing');
      const a = await pageAnswer(ADMIN);
      assert.deepEqual(a.todo, { me: { id: '501', name: 'Admin One', teamIds: ['7'] } });
      assert.deepEqual(a.cases.map((c) => [c.id, c.views.includes('todo'), 'managerIds' in c]), [['1', true, true], ['2', true, true], ['3', true, true], ['4', true, true], ['5', false, true], ['6', true, true]]);
    });
    // on
    await withEnv({ TODO_TAB: 'on', ADMIN_EMAILS: undefined }, async () => {
      const key = await pageAnswer(null);
      assert.deepEqual(key.todo, { me: null }, 'the team key alone: the lists, and nobody is "me"');
      assert.deepEqual(key.cases.filter((c) => c.views.includes('todo')).map((c) => c.id), ['1', '2', '3', '4', '6'], 'the open rows: the ones in the Assigning view');
      for (const c of key.cases) assert.deepEqual(c.views.filter((v) => v === 'todo').length, c.views.includes('assigning') ? 1 : 0);
      const mine = await pageAnswer(OFFICER);
      assert.deepEqual(mine.todo, { me: { id: '111', name: 'Officer One', teamIds: [] } });
      assert.ok(!JSON.stringify(mine.todo).includes('@'));
      // the answer says the same thing about the viewer as before (with the key: "Admin", everything) — `me` is the only person in it
      assert.deepEqual(mine.viewer, { name: 'Admin', email: '', scope: 'all', isAdmin: true, canAssign: true });
      // marking one answer's rows never reaches the next answer (the rows are parsed fresh for each)
      assert.ok(noTodoAnywhere(JSON.parse(JSON.stringify(await dash.getDashboardStats()))), 'the key-only route right after: nothing');
    });
    assert.ok(noTodoAnywhere(await withEnv({ TODO_TAB: 'off' }, () => pageAnswer(ADMIN))), 'switched off again: gone at the next answer');
    assert.ok(board.calls.every((q) => !/mutation/.test(q)), 'no Monday write in any mode');
    assert.equal(board.calls.filter((q) => /items_page\(limit: 500/.test(q)).length, 1, 'and no extra Monday read: one board read served every answer');
  });
});

test('from the board cells to the lists: the answer\'s rows give each person their list on the page — the other people columns never put a case on one', async () => {
  await onBoard(BOARD, async () => {
    const a = await withEnv({ TODO_TAB: 'on' }, () => pageAnswer({ id: '211', name: 'Reviewer One', email: 'reviewer.one@example.com', teamIds: [] }));
    const ppl = TDU.people(a.cases, a.todo.me, a.viewer.scope);
    assert.deepEqual(ppl.me, { key: 'me', name: 'Reviewer One', mine: 0, review: 2, total: 2 }, 'cases 1 and 6 (5 is not open)');
    assert.deepEqual(ppl.list.map((p) => [p.key, p.name, p.mine, p.review, p.total]), [
      ['p:111', 'Officer One', 2, 0, 2], ['p:112', 'Officer Two', 1, 0, 1], ['t:8', 'Team Eight', 0, 1, 1], ['t:9', 'Team Nine', 1, 0, 1]]);
    assert.deepEqual(ppl.nobody, { key: 'nobody', total: 1 }, 'case 3: somebody in Retained by only — still "No one assigned"');
    assert.deepEqual(a.cases.filter((c) => TDU.has(c, 'nobody', a.todo.me)).map((c) => c.id), ['3']);
    assert.deepEqual(a.cases.filter((c) => TDU.has(c, 'me', a.todo.me)).map((c) => c.id), ['1', '6']);
    assert.deepEqual(a.cases.filter((c) => TDU.has(c, 'p:112', a.todo.me)).map((c) => c.id), ['2'], 'case 5 has the same officer but is not open');
    assert.ok(!Object.keys(TDU.names(a.cases)).includes('p:311'), 'a person of another people column is not even known to the lists');
  });
});

/* ═══ the list engine's part (listSpecs) ═══ */

const colsOn = (opts, tab) => listCore({}).colsOnTab(opts.cols, tab).map((c) => c.id);
const ALL_IDS = ['caseRef', 'clientName', 'caseType', 'caseStage', 'phase', 'deadline', 'promised', 'health', 'slaRisk', 'officer', 'manager', 'overallReadiness', 'daysElapsed', 'status', 'del'];
const VIEW_IDS = ['caseRef', 'clientName', 'dependents', 'clientEmail', 'clientPhone', 'caseTypeV', 'subType', 'actualDeadline', 'deadlineType', 'internalDeadline', 'phaseV',
  'retainedBy', 'retainerStatus', 'paymentStatus', 'stageV', 'portal', 'officerV', 'managerV', 'qPct', 'docPct'];
/* Literal copies from the clean tree (36636cd), with the three Monday views: [id, label, tabs, sort, facets]. */
const VT3 = 'assigning|deadlines|eeita';
const COLS_TODAY = [
  ['caseRef', 'Case Ref', null, 'caseRef', null], ['clientName', 'Client', null, 'clientName', null], ['caseType', 'Type', 'ALL', 'caseType', null], ['caseStage', 'Stage', 'ALL', 'caseStage', 'stage'],
  ['phase', 'Phase', 'ALL', 'phase', null], ['deadline', 'Deadline', 'ALL', 'actualDeadline', null], ['promised', 'Promised', 'ALL', 'promisedDate', null], ['health', 'Health', 'ALL', 'health', 'health'],
  ['slaRisk', 'SLA Risk', 'ALL', 'slaRisk', null], ['officer', 'Support Officer', 'ALL', 'officer', null], ['manager', 'Manager', 'ALL', 'manager', 'manager'],
  ['overallReadiness', 'Readiness', 'ALL', 'overallReadiness', null], ['daysElapsed', 'Days', 'ALL', 'daysElapsed', null], ['status', 'Status', 'ALL', null, null], ['del', '', 'ALL', null, null],
  ['dependents', 'Dependents', VT3, 'dependents', null], ['clientEmail', 'Client email', VT3, 'clientEmail', null], ['clientPhone', 'Contact number', VT3, 'clientPhone', null],
  ['caseTypeV', 'Case type', VT3, 'caseTypeV', 'caseType'], ['subType', 'Sub-type', VT3, 'subType', 'subType'], ['actualDeadline', 'Actual deadline', VT3, 'actualDeadline', null],
  ['deadlineType', 'Deadline type', VT3, 'deadlineType', 'deadlineType'], ['internalDeadline', 'Internal deadline', VT3, 'promisedDate', null], ['phaseV', 'Phase', VT3, 'phaseBoard', 'phase'],
  ['retainedBy', 'Retained by', VT3, 'retainedBy', 'retainedBy'], ['retainerStatus', 'Retainer status', VT3, 'retainerStatus', 'retainerStatus'],
  ['paymentStatus', 'Payment status', VT3, 'paymentStatus', 'paymentStatus'], ['stageV', 'Stage', VT3, 'stageBoard', 'stage'], ['portal', 'Client portal', VT3, null, null],
  ['officerV', 'Support officer', VT3, 'officer', 'officer'], ['managerV', 'Case manager', VT3, 'managerV', 'manager'], ['qPct', 'Questionnaire %', VT3, 'qPct', null],
  ['docPct', 'Documents uploaded %', VT3, 'docPct', null]];
const COLS_SHA_TODAY = 'd88e1309ff4b2c3519f5c096d4b9c55b0abbb499b08e4c18c1d6b9acfb6a5738';   // sha256 of JSON.stringify(casesListOpts({ views: pageViews() }).cols) on the clean tree
const FACETS_TODAY = ['stage', 'health', 'manager', 'caseType', 'subType', 'deadlineType', 'phase', 'retainedBy', 'retainerStatus', 'paymentStatus', 'officer', 'view'];
const SORTS_TODAY = ['createdAt', 'caseRef', 'clientName', 'caseType', 'caseStage', 'phase', 'actualDeadline', 'promisedDate', 'health', 'slaRisk', 'officer', 'manager', 'overallReadiness',
  'daysElapsed', 'dependents', 'clientEmail', 'clientPhone', 'caseTypeV', 'subType', 'deadlineType', 'phaseBoard', 'stageBoard', 'retainedBy', 'retainerStatus', 'paymentStatus', 'managerV', 'qPct', 'docPct'];
const BLANKS_TODAY = ['actualDeadline', 'promisedDate', 'phase', 'officer', 'dependents', 'clientEmail', 'clientPhone', 'caseTypeV', 'subType', 'deadlineType', 'phaseBoard', 'stageBoard',
  'retainedBy', 'retainerStatus', 'paymentStatus', 'managerV', 'qPct', 'docPct'];
/* More from the Monday board (2026-11-20): nineteen optional columns, on no tab by default, come AFTER every column of before; six of them
   filter. They are pinned in test/clientMasterMoreColumns.test.js — here: the columns, filters and sorts of before are a literal prefix. */
const MORE_IDS = ['stageStart', 'hardDeadlineSys', 'softDeadlineSys', 'prepDeadlineSys', 'reminderCount', 'paymentConfirmed', 'retainerSigned', 'missingRequired', 'qStatus', 'lastActivity',
  'supervisor', 'escalationReason', 'folder', 'docsLocation', 'consultant', 'consultOutcome', 'consultFee', 'sourceRef', 'consultRecord'];
const MORE_FACETS = ['qStatus', 'docsLocation', 'supervisor', 'consultant', 'consultOutcome', 'sourceRef'];
const MORE_BLANKS = MORE_IDS.filter((id) => id !== 'folder' && id !== 'consultRecord');   // the two link columns sort by "has a link": no blank
const before = (opts) => ({ cols: opts.cols.filter((c) => !c.more) });
const shape = (opts) => opts.cols.map((c) => [c.id, c.label, !c.tabs ? null : c.tabs.length === 1 && c.tabs[0] === '' ? 'ALL' : c.tabs.join('|'), c.sort || null, (c.facets || []).join('|') || null]);

test('NO to-do view in ctx.views (a page without the tab): the columns, tabs, filters, sorts and words are exactly as before — literal copies of the clean tree', () => {
  for (const [name, ctx] of [['the three Monday views', { views: VIEWS }], ['the same, with a hook that must never be asked', { views: VIEWS, todoHas: () => { throw new Error('asked'); } }]]) {
    const o = S.casesListOpts(ctx), sp = S.casesListSpec(ctx);
    assert.deepEqual(shape(before(o)), COLS_TODAY, name);
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(before(o).cols)).digest('hex'), COLS_SHA_TODAY, name + ': every column of before, to the letter');
    // the optional columns: the last nineteen, on no tab
    assert.deepEqual(o.cols.slice(COLS_TODAY.length).map((c) => c.id), MORE_IDS, name);
    for (const c of o.cols.slice(COLS_TODAY.length)) assert.ok(c.more && Array.isArray(c.tabs) && c.tabs.length === 0, c.id);
    assert.deepEqual(Object.keys(o), ['key', 'ids', 'render', 'api', 'initial', 'onChange', 'pickCols', 'quick', 'sortReset', 'countText', 'cols']);
    assert.deepEqual(o.quick.values, ['assigning', 'deadlines', 'eeita']);
    assert.deepEqual(Object.keys(o.quick.hints), ['assigning', 'deadlines', 'eeita']);
    assert.deepEqual(Object.keys(sp), ['facets', 'sorts', 'sortBlanksLast', 'defaultSort', 'search']);
    assert.deepEqual(Object.keys(sp.facets), FACETS_TODAY.concat(MORE_FACETS));
    assert.deepEqual(Object.keys(sp.sorts), SORTS_TODAY.concat(MORE_IDS));
    assert.deepEqual(sp.sortBlanksLast, BLANKS_TODAY.concat(MORE_BLANKS));
    assert.deepEqual(sp.facets.view.order, ['assigning', 'deadlines', 'eeita']);
    assert.deepEqual([sp.facets.view.label, sp.facets.view.quick, sp.facets.view.fixed, sp.facets.view.none], ['View', true, true, 'No view']);
    assert.equal(o.sortReset({ sel: {} }), 'newest case first');
    for (const v of ['assigning', 'deadlines', 'eeita', 'todo']) assert.equal(o.sortReset({ sel: { view: [v] } }), "Monday's order for this view", v);
    // the view facet hands back the row's own list, whatever is in it — a row marked by the server included
    const marked = { views: ['assigning', 'todo'] };
    assert.equal(sp.facets.view.get(marked), marked.views);
    assert.deepEqual(sp.facets.view.get({}), []);
    for (const tab of ['assigning', 'deadlines', 'eeita']) assert.deepEqual(colsOn(o, tab), VIEW_IDS, tab);
    assert.deepEqual(colsOn(o, ''), ALL_IDS);
    assert.deepEqual(colsOn(o, 'todo'), ['caseRef', 'clientName'], 'no such tab: only the two columns every tab has');
  }
  // no views at all (a page that has none): as before too
  assert.deepEqual(S.casesListOpts({}).cols.map((c) => c.id), COLS_TODAY.map((c) => c[0]).concat(MORE_IDS));
  assert.deepEqual(Object.keys(S.casesListSpec({}).facets), FACETS_TODAY.concat(MORE_FACETS));
  // a kept or linked to-do tab on a page without it falls away by itself: the engine drops a tab it does not have
  const LT = listCore(S.casesListSpec({ views: VIEWS }));
  assert.deepEqual(LT.normalizeState({ sel: { view: ['todo'] } }).sel, {});
  assert.deepEqual(LT.normalizeState({ sel: { view: ['assigning'] } }).sel, { view: ['assigning'] });
});

test('WITH the to-do view: the Monday view tabs keep their twenty columns and All its fifteen; the To-do tab has exactly its twelve; "With" is its own column, filter and sort', () => {
  const o = S.casesListOpts({ views: VIEWS_ON }), sp = S.casesListSpec({ views: VIEWS_ON });
  // VT is built without the page-only view: nothing of the other tabs moves
  for (const tab of ['assigning', 'deadlines', 'eeita']) assert.deepEqual(colsOn(o, tab), VIEW_IDS, tab);
  assert.deepEqual(colsOn(o, ''), ALL_IDS);
  // the twelve: the same set as the tab's default order (the page draws them in DEFAULT_COLS order — CM_TABCOLS.todo)
  assert.deepEqual(colsOn(o, 'todo').slice().sort(), [...T.DEFAULT_COLS].sort());
  assert.equal(colsOn(o, 'todo').length, 12);
  // every column of before is still there, in its place and with its looks; the one new column comes last
  assert.deepEqual(before(o).cols.slice(0, -1).map((c) => [c.id, c.label, c.sort || null, (c.facets || []).join('|') || null]), COLS_TODAY.map((c) => [c[0], c[1], c[3], c[4]]));
  assert.deepEqual(o.cols.slice(COLS_TODAY.length, -1).map((c) => c.id), MORE_IDS, 'the optional columns (2026-11-20) sit between the columns of before and "With": on no tab, the To-do tab included');
  for (const c of o.cols.filter((x) => x.more)) assert.deepEqual(c.tabs, [], c.id);
  assert.deepEqual(o.cols.filter((c) => !c.tabs).map((c) => c.id), ['caseRef', 'clientName']);
  const onTodo = o.cols.filter((c) => c.tabs && c.tabs.includes('todo')).map((c) => c.id);
  assert.deepEqual(onTodo, ['caseTypeV', 'subType', 'actualDeadline', 'deadlineType', 'internalDeadline', 'stageV', 'officerV', 'qPct', 'docPct', 'todoWith']);
  for (const c of o.cols.filter((x) => x.tabs && x.tabs.includes('todo') && x.id !== 'todoWith')) assert.deepEqual(c.tabs, ['assigning', 'deadlines', 'eeita', 'todo'], c.id);
  for (const c of o.cols.filter((x) => x.tabs && !x.more && !x.tabs.includes('todo') && x.tabs[0] !== '')) assert.deepEqual(c.tabs, ['assigning', 'deadlines', 'eeita'], c.id);
  const w = o.cols[o.cols.length - 1];
  assert.deepEqual(w, { id: 'todoWith', label: 'With', title: 'Case Manager on Client Master: who has the case for review', menu: 'facet', facets: ['todoWith'], sort: 'todoWith',
    sortText: ['A → Z', 'Z → A'], sortDirs: ['asc', 'desc'], tabs: ['todo'] });
  assert.equal(w.id, T.DEFAULT_COLS[2]);
  assert.equal(new Set(o.cols.map((c) => c.id)).size, o.cols.length);
  // the tabs: To-do last, with its tooltip; the view facet lists it (a kept To-do tab is a tab the page has)
  assert.deepEqual(o.quick.values, ['assigning', 'deadlines', 'eeita', 'todo']);
  assert.equal(o.quick.hints.todo, T.PAGE_VIEW.hint);
  assert.deepEqual(sp.facets.view.order, ['assigning', 'deadlines', 'eeita', 'todo']);
  assert.equal(sp.facets.view.text('todo'), 'To-do');
  assert.deepEqual(listCore(sp).normalizeState({ sel: { view: ['todo'] } }).sel, { view: ['todo'] });
  // its own filter: the Case Manager names, the empty choice "Nobody" — the Manager filter is as it was
  assert.deepEqual(Object.keys(sp.facets), FACETS_TODAY.concat(MORE_FACETS, ['todoWith']));
  assert.deepEqual([sp.facets.todoWith.label, sp.facets.todoWith.none], ['With', 'Nobody']);
  assert.deepEqual(sp.facets.todoWith.get({ manager: 'Reviewer One, Reviewer Two' }), ['Reviewer One', 'Reviewer Two']);
  assert.deepEqual(sp.facets.todoWith.get({ manager: 'Unassigned' }), []);
  assert.deepEqual(sp.facets.todoWith.get({}), []);
  assert.deepEqual([sp.facets.manager.label, sp.facets.manager.none], ['Manager', 'Unassigned']);
  const LT = listCore(sp);
  const rows = [{ id: 'a', manager: 'Reviewer One' }, { id: 'b', manager: 'Unassigned' }, { id: 'c', manager: 'Reviewer Two, Reviewer One' }, { id: 'd', manager: '' }];
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'todoWith').map((x) => [x.label, x.count]), [['Reviewer One', 2], ['Reviewer Two', 1], ['Nobody', 2]], 'never "Unassigned"');
  const st = LT.emptyState(); st.sel.todoWith = ['Reviewer Two'];
  assert.deepEqual(LT.filterRows(rows, st).map((r) => r.id), ['c']);
  assert.deepEqual(LT.chips(st).map((c) => c.text), ['With: Reviewer Two']);
  st.sel.todoWith = [LT.NONE];
  assert.deepEqual(LT.filterRows(rows, st).map((r) => r.id), ['b', 'd']);
  // its own sort: by the manager names A → Z, a case with nobody last BOTH ways
  assert.deepEqual(Object.keys(sp.sorts), SORTS_TODAY.concat(MORE_IDS, ['todoWith']));
  assert.deepEqual(sp.sortBlanksLast, BLANKS_TODAY.concat(MORE_BLANKS, ['todoWith']));
  const sorted = (dir) => LT.sortRows([{ id: 'u', manager: 'Unassigned' }, { id: 'z', manager: 'Zed Reviewer' }, { id: 'n', manager: '' }, { id: 'a', manager: 'abe reviewer' }], { key: 'todoWith', dir }).map((r) => r.id).join('');
  assert.equal(sorted('asc'), 'azun');
  assert.equal(sorted('desc'), 'zaun');
  // every column's filter and sort exist in the spec
  for (const c of o.cols) { for (const f of (c.facets || [])) assert.ok(sp.facets[f], f); if (c.sort) assert.ok(sp.sorts[c.sort], c.sort); }
});

test('the sort chip\'s words: "soonest deadline first" on the To-do tab; the other tabs and All say what they always said', () => {
  const o = S.casesListOpts({ views: VIEWS_ON });
  assert.equal(o.sortReset({ sel: { view: ['todo'] } }), 'soonest deadline first');
  for (const v of ['assigning', 'deadlines', 'eeita']) assert.equal(o.sortReset({ sel: { view: [v] } }), "Monday's order for this view");
  assert.equal(o.sortReset({ sel: {} }), 'newest case first');
  assert.equal(o.sortReset({ sel: { view: [] } }), 'newest case first');
  assert.equal(o.sortReset(null), 'newest case first');
});

/* Rows as the page has them once the server marked the open ones. */
const LIST_ROWS = [
  { id: '1', clientName: 'Test Client A', caseStage: 'Internal Review', officer: 'Officer One', manager: 'Reviewer One', views: ['assigning', 'deadlines', 'todo'] },
  { id: '2', clientName: 'Test Client B', caseStage: 'Internal Review', officer: 'Officer One', manager: 'Unassigned', views: ['assigning', 'todo'] },
  { id: '3', clientName: 'Test Client C', caseStage: 'Stuck', officer: 'Officer Two', manager: 'Unassigned', views: ['assigning', 'todo'] },
  { id: '4', clientName: 'Test Client D', caseStage: 'Pre-Onboarding', officer: '', manager: 'Unassigned', views: ['assigning', 'eeita', 'todo'] },
  { id: '5', clientName: 'Test Client E', caseStage: 'Application Submitted', officer: 'Officer One', manager: 'Unassigned', views: ['deadlines'] },
  { id: '6', clientName: 'Test Client F', caseStage: '', officer: '', manager: 'Unassigned', views: [] },
];

test('the narrowing is INSIDE the view facet: a marked row stays under To-do only when ctx.todoHas says it is on the list on screen; no hook, no list or a failing hook = no row; the other tabs never move', () => {
  const run = (todoHas) => {
    const asked = [];
    const ctx = { views: VIEWS_ON };
    if (todoHas) ctx.todoHas = (r) => { asked.push(r.id); return todoHas(r); };
    const LT = listCore(S.casesListSpec(ctx));
    const st = LT.emptyState(); st.sel.view = ['todo'];
    const counts = Object.fromEntries(LT.facetCounts(LIST_ROWS, st, 'view').map((x) => [x.value, x.count]));
    return { LT, asked, on: LT.filterRows(LIST_ROWS, st).map((r) => r.id), counts, values: LIST_ROWS.map((r) => LT.valuesOf('view', r)) };
  };
  const OTHER = { assigning: 4, deadlines: 2, eeita: 1 };
  const none = run(null);
  assert.deepEqual(none.on, [], 'no hook: the tab is empty');
  assert.deepEqual(none.counts, { ...OTHER, todo: 0, [none.LT.NONE]: 1 }, 'its number is 0 — and still listed (a fixed tab)');
  const one = run((r) => r.officer === 'Officer One');
  assert.deepEqual(one.on, ['1', '2'], 'case 5 has the same officer but was not marked open by the server');
  assert.deepEqual(one.counts, { ...OTHER, todo: 2, [one.LT.NONE]: 1 });
  assert.deepEqual([...new Set(one.asked)].sort(), ['1', '2', '3', '4'], 'the hook is asked only about rows the server marked');
  assert.deepEqual(one.values[0], ['assigning', 'deadlines', 'todo']);
  assert.deepEqual(one.values[2], ['assigning'], 'not on the list: under its other tabs as always');
  assert.deepEqual(one.values[4], ['deadlines']);
  assert.deepEqual(run(() => true).on, ['1', '2', '3', '4']);
  assert.deepEqual(run(() => false).counts, { ...OTHER, todo: 0, [none.LT.NONE]: 1 });
  // truthy / falsy answers, and a hook that throws: never an error out of the list — the row is simply not on it
  assert.deepEqual(run((r) => (r.id === '3' ? 'yes' : 0)).on, ['3']);
  const broken = run(() => { throw new Error('the page hook failed'); });
  assert.deepEqual(broken.on, []);
  assert.deepEqual(broken.counts, { ...OTHER, todo: 0, [none.LT.NONE]: 1 }, 'the other tabs still count');
  // the row itself is never changed by the narrowing
  assert.deepEqual(LIST_ROWS[2].views, ['assigning', 'todo']);
});

/* A small page for the engine (as in test/clientMasterColumns.test.js): the header row, the chips, the count and the tab box keep what is written into them. */
function enginePage(spec, opts, { store = {} } = {}) {
  const kept = new Map(Object.entries(store));
  const el = (o) => ({ innerHTML: '', value: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, contains() { return false; }, focus() {}, ...o });
  const els = { [opts.ids.head]: el(), [opts.ids.chips]: el(), [opts.ids.count]: el({ textContent: '' }), [opts.quick.box]: el() };
  const drawn = [], whys = [];
  const win = { document: { getElementById: (id) => els[id] || null, createElement: () => el(), body: el(), addEventListener() {}, activeElement: null, documentElement: el(), dispatchEvent() {} },
    sessionStorage: { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => { kept.set(k, String(v)); } }, addEventListener() {}, location: { search: '' }, innerWidth: 1200, innerHeight: 800,
    CustomEvent: function () {}, [opts.render]: (rows, why) => { drawn.push(rows.map((r) => r.id).join(',')); whys.push(why); } };
  const api = listTableUi(listCore(spec), opts, win);
  const tabs = () => Object.fromEntries([...els[opts.quick.box].innerHTML.matchAll(/data-quick="([^"]*)"[^>]*>([^<]*) <span class="lt-tab-n">(\d+)<\/span>/g)].map((m) => [m[1] || 'all', Number(m[3])]));
  const labels = () => [...els[opts.quick.box].innerHTML.matchAll(/data-quick="([^"]*)"[^>]*>([^<]*) <span/g)].map((m) => m[2]);
  return { api, els, kept, drawn, whys, tabs, labels, count: () => els[opts.ids.count].textContent, chips: () => [...els[opts.ids.chips].innerHTML.matchAll(/<span class="q-chip[^"]*">([^<]*)</g)].map((m) => m[1]),
    last: () => drawn[drawn.length - 1], tab(v) { if (v) api.state().sel[opts.quick.facet] = [v]; else delete api.state().sel[opts.quick.facet]; api.apply('filter'); } };
}

test('through the real engine: choosing a list is one CasesTable.apply — the rows, the To-do tab\'s number, the count, the header-filter counts and the search are then all about the list on screen', () => {
  let list = '';                                         // the page's state: whose list is on screen ('' = none chosen)
  const onList = { one: ['1', '2'], two: ['3'], nobody: ['4'] };
  const changes = [];
  const ctx = { views: VIEWS_ON, todoHas: (r) => (onList[list] || []).includes(r.id), onChange: () => { changes.push(list); } };
  const p = enginePage(S.casesListSpec(ctx), S.casesListOpts(ctx));
  p.api.setRows(LIST_ROWS);
  assert.deepEqual(p.labels(), ['All', 'Assigning', 'Deadlines', 'EE after ITA', 'To-do'], 'the tab order: To-do last');
  assert.deepEqual(p.tabs(), { all: 6, assigning: 4, deadlines: 2, eeita: 1, todo: 0 }, 'nothing chosen: the To-do tab says 0, never every open case');
  p.tab('todo');
  assert.equal(p.last(), '', 'no list chosen: no rows');
  assert.equal(p.count(), '0 of 6 cases');
  assert.equal(p.kept.get('tdot_list_cases_tab'), 'todo', 'the tab is kept for this browser tab like any other');
  // choose a list: the page sets its state and calls apply — nothing else
  changes.length = 0;
  list = 'one'; p.api.apply('who');
  assert.equal(p.last(), '1,2');
  assert.equal(p.whys[p.whys.length - 1], 'who', 'the page\'s render is told why');
  assert.deepEqual(p.tabs(), { all: 6, assigning: 4, deadlines: 2, eeita: 1, todo: 2 }, 'the tab numbers are worked out again on that apply; the other tabs do not move');
  assert.equal(p.count(), '2 of 6 cases', 'until the page\'s render answers { shown, total } with the list\'s own size');
  assert.deepEqual(changes, ['one'], 'apply(\'who\') also runs the page\'s onChange, like every apply that is not new data');
  // the numbers inside a header filter are counted over the list on screen
  const core = p.api.core;
  assert.deepEqual(core.facetCounts(LIST_ROWS, p.api.state(), 'stage').map((x) => [x.label, x.count]), [['Internal Review', 2]]);
  assert.deepEqual(core.facetCounts(LIST_ROWS, p.api.state(), 'todoWith').map((x) => [x.label, x.count]), [['Reviewer One', 1], ['Nobody', 1]]);
  // the search looks only in the list on screen
  p.api.state().q = 'test client'; p.api.apply('filter');
  assert.equal(p.last(), '1,2');
  p.api.state().q = 'client c'; p.api.apply('filter');
  assert.equal(p.last(), '', 'Test Client C is on another list');
  assert.deepEqual(p.tabs(), { all: 1, assigning: 1, deadlines: 0, eeita: 0, todo: 0 });
  p.api.state().q = ''; p.api.apply('filter');
  // another list, then none
  list = 'two'; p.api.apply('who');
  assert.equal(p.last(), '3');
  assert.equal(p.tabs().todo, 1);
  list = 'nobody'; p.api.apply('who');
  assert.equal(p.last(), '4');
  // a filter of the person's own narrows the list, and Clear filters keeps the tab
  p.api.state().sel.stage = ['Stuck']; p.api.apply('filter');
  assert.equal(p.last(), '');
  assert.deepEqual(p.chips(), ['Stage: Stuck']);
  p.api.clearFilters();
  assert.equal(p.last(), '4');
  assert.deepEqual(p.api.state().sel, { view: ['todo'] });
  // new data (a refresh, or an Assign that moved a row): the same hook is asked again about the new rows
  onList.nobody = [];
  p.api.setRows(LIST_ROWS.map((r) => ({ ...r })));
  assert.equal(p.last(), '');
  assert.equal(p.tabs().todo, 0);
  // the other tabs draw as always, whatever list is chosen
  list = 'one';
  p.tab('assigning'); assert.equal(p.last(), '1,2,3,4');
  p.tab('deadlines'); assert.equal(p.last(), '1,5');
  p.tab(''); assert.equal(p.last().split(',').length, 6);
  // the sort chip on the To-do tab goes back to the deadline order in words
  p.tab('todo');
  p.api.state().sort = { key: 'clientName', dir: 'desc' }; p.api.apply('sort');
  assert.equal(p.last(), '2,1');
  assert.ok(p.els['cs-chips'].innerHTML.includes('aria-label="Back to the normal order: soonest deadline first"'));
  // nothing about whose list it is was kept by the engine: only the tab and the list's own filters
  assert.deepEqual([...p.kept.keys()].sort(), ['tdot_list_cases', 'tdot_list_cases_tab']);
  assert.ok(!/one|two|nobody/.test(p.kept.get('tdot_list_cases')));
});

test('a page WITHOUT the tab that is handed a kept To-do tab opens on All; the engine never draws a tab it was not given', () => {
  const ctx = { views: VIEWS };
  const p = enginePage(S.casesListSpec(ctx), S.casesListOpts(ctx), { store: { tdot_list_cases_tab: 'todo', tdot_list_cases: JSON.stringify({ sel: { view: ['todo'] } }) } });
  p.api.setRows(LIST_ROWS);
  assert.deepEqual(p.api.state().sel, {});
  assert.deepEqual(p.labels(), ['All', 'Assigning', 'Deadlines', 'EE after ITA']);
  assert.deepEqual(p.tabs(), { all: 6, assigning: 4, deadlines: 2, eeita: 1 }, 'rows the server marked change no number on a page without the tab');
  assert.equal(p.last().split(',').length, 6);
});

/* ═══ what is pasted into every page ═══ */

test('the shared list functions are pasted into EVERY Client Master page as text: they follow the injected-code rule and never name the tab or its column — so a page without the tab is free of it', () => {
  for (const fn of [S.casesListSpec, S.casesListOpts, U.clientMasterUi]) {
    const text = fn.toString();
    assert.ok(!/[`\\]|\$\{/.test(text), fn.name + ': no backtick, backslash or dollar-brace');
    for (const w of TAB_WORDS) assert.ok(!text.includes(w), fn.name + ' holds "' + w + '"');
    assert.ok(!/to-do/i.test(text), fn.name + ': not in any spelling');
  }
  // the column's id is the tab's key + 'With' — it equals the id the service lists
  assert.equal(T.PAGE_VIEW.key + 'With', T.DEFAULT_COLS[2]);
  // the list script parses with a page context that has the hook, and one that has not
  for (const ctx of ['{ healthOrder: {}, views: [], initial: function(){ return false; }, onChange: function(){} }',
    '{ healthOrder: {}, views: ' + JSON.stringify(VIEWS_ON) + ', initial: function(){ return false; }, onChange: function(){}, todoHas: function(r){ return false; }, meta: function(){ return null; } }']) {
    const src = listTableScript(S.casesListSpec, S.casesListOpts, ctx);
    new vm.Script(src);
    assert.ok(!src.includes('${'));
  }
});

function renderRoute(path) {
  const router = require('../src/routes/adminDashboard');
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
}
const inlineScripts = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('switched off: neither page variant carries a word of the tab, and every emitted <script> block parses (node --check does not see page script)', async () => {
  await withEnv({ TODO_TAB: undefined }, async () => {
    for (const path of ['/', '/summary']) {
      const html = await renderRoute(path);
      for (const w of TAB_WORDS) assert.ok(!html.includes(w), path + ' holds "' + w + '"');
      const scripts = inlineScripts(html);
      assert.ok(scripts.length >= 1);
      for (const s of scripts) new vm.Script(s);
    }
  });
});

/* ═══ the "Filtered" line ═══ */

test('the Filtered line takes optional words for a tab that is not a Monday view ("on this list"); without them the text is as it always was', () => {
  assert.equal(U.filteredLine(40, 156, true).text, "Filtered: 40 of 156 in Monday's view");
  assert.deepEqual(U.filteredLine(3, 22, true, 'on this list'), { shown: 3, total: 22, text: 'Filtered: 3 of 22 on this list' });
  assert.equal(U.filteredLine(3, 22, false, 'on this list'), null, 'only with a search or filter of the person\'s own on');
  for (const blank of [undefined, null, '', '   ']) assert.equal(U.filteredLine(3, 22, true, blank).text, "Filtered: 3 of 22 in Monday's view");
  assert.equal(U.filteredLine(0, 0, true, ' on this list ').text, 'Filtered: 0 of 0 on this list');
});
