'use strict';

// Client Master: "More from the Monday board" — nineteen optional columns behind the Columns button (Faran 2026-11-20:
// "add those 15 or so useful columns to the optional columns checklist"). Switched off by default on every tab.
//  - the data: each board column parsed onto the row inside `more` (empty cells too); `more` leaves the service only for the
//    page's own load (the same rule as the contact details), after the access filter; the columns never to be read are not read;
//  - the defaults: CM_TABCOLS is to the letter what it was — with and without the To-do tab;
//  - the rules (pure) and the Columns panel: a group of its own on every tab, last, all unticked;
//  - the page (the REAL emitted scripts over a small fake page): the header, the cells, the links, the wide table, what is kept;
//  - sorts and filters; the search box is unchanged; the system dates are shown only.
// All made-up data. Monday is stubbed; nothing leaves the machine.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');
const fs     = require('fs');

const dash      = require('../src/services/dashboardService');
const mondayApi = require('../src/services/mondayApi');
const cmv       = require('../src/services/clientMasterViews');
const todoList  = require('../src/services/todoListService');
const S         = require('../src/routes/listSpecs');
const U         = require('../src/routes/clientMasterUi');
const CUI       = require('../src/routes/clientMasterColumnsUi');
const CMW       = require('../src/routes/clientMasterWindows');
const { listCore } = require('../src/routes/listFilters');
const router    = require('../src/routes/adminDashboard');

const VIEWS = cmv.pageViews();
const VIEWS_ON = VIEWS.concat([JSON.parse(JSON.stringify(todoList.PAGE_VIEW))]);
const KEY = 'tdot_view_cm_columns_v1';

/* The nineteen, in the panel's order: [page id, the name on screen (Monday's own), how it is shown, the Monday column]. */
const MORE = [
  ['stageStart', 'Stage start date', 'date', 'date_mm0xjm1z'],
  ['hardDeadlineSys', 'Hard deadline (system)', 'date', 'date_mm0x5pqd'],
  ['softDeadlineSys', 'Soft deadline (system)', 'date', 'date_mm0x26t4'],
  ['prepDeadlineSys', 'Submission prep deadline (system)', 'date', 'date_mm0xfgbp'],
  ['reminderCount', 'Reminder count', 'num', 'numeric_mm1a4e8r'],
  ['paymentConfirmed', 'Payment confirmation date', 'date', 'date_mm0xgk76'],
  ['retainerSigned', 'Retainer signed date', 'date', 'date_mm34x2ga'],
  ['missingRequired', 'Missing required documents', 'num', 'numeric_mm0x6qy4'],
  ['qStatus', 'Questionnaire completion status', 'status', 'color_mm0x9s08'],
  ['lastActivity', 'Last client activity date', 'date', 'date_mm1amqyr'],
  ['supervisor', 'Ops supervisor', 'names', 'multiple_person_mm0xp0sq'],
  ['escalationReason', 'Escalation reason', 'clip', 'text_mm0xvpr9'],
  ['folder', 'OneDrive folder', 'link', 'link_mm47dng8'],
  ['docsLocation', 'Documents location', 'status', 'color_mm6be76m'],
  ['consultant', 'Consultant', 'text', 'text_mm8t8zhx'],
  ['consultOutcome', 'Consultation outcome', 'text', 'text_mm8tmcm7'],
  ['consultFee', 'Consultation fee', 'text', 'text_mm8tsw2c'],
  ['sourceRef', 'Source / Reference', 'text', 'text_mm8tqsa5'],
  ['consultRecord', 'Consultation record', 'link', 'link_mm8txy20'],
];
const MORE_IDS = MORE.map((m) => m[0]), MORE_LABELS = MORE.map((m) => m[1]);
const SYS_IDS = ['hardDeadlineSys', 'softDeadlineSys', 'prepDeadlineSys'];
const SYS_WORDS = 'Set by the system from the stage timings. Not the client’s deadline (see Actual deadline).';
/* The three columns that must never be read, sent or shown (spec rule 7). */
const NEVER = { 'Case Access Token': 'text_mm0x6haq', 'OneDrive Folder Id': 'text_mm47y540', 'Client Account Id': 'text_mm5xmeka' };

/* Today's tabs, hard-coded (commit 4b950aa — what is live): the column ids of each tab, in order. */
const ALL_IDS = ['caseRef', 'clientName', 'caseType', 'caseStage', 'phase', 'deadline', 'promised', 'health', 'slaRisk', 'officer', 'manager', 'overallReadiness', 'daysElapsed', 'status', 'del'];
const VIEW_IDS = ['caseRef', 'clientName', 'dependents', 'clientEmail', 'clientPhone', 'caseTypeV', 'subType', 'actualDeadline', 'deadlineType', 'internalDeadline', 'phaseV',
  'retainedBy', 'retainerStatus', 'paymentStatus', 'stageV', 'portal', 'officerV', 'managerV', 'qPct', 'docPct'];
const TODO_IDS = ['caseRef', 'clientName', 'todoWith', 'caseTypeV', 'subType', 'stageV', 'actualDeadline', 'deadlineType', 'internalDeadline', 'officerV', 'qPct', 'docPct'];
const TABCOLS_OFF = { '': ALL_IDS, assigning: VIEW_IDS, deadlines: VIEW_IDS, eeita: VIEW_IDS };
const TABCOLS_ON = { '': ALL_IDS, assigning: VIEW_IDS, deadlines: VIEW_IDS, eeita: VIEW_IDS, todo: TODO_IDS };
/* The emitted line, byte for byte, as the live page has it. */
const TABCOLS_OFF_TEXT = '{"":["caseRef","clientName","caseType","caseStage","phase","deadline","promised","health","slaRisk","officer","manager","overallReadiness","daysElapsed","status","del"],'
  + '"assigning":["caseRef","clientName","dependents","clientEmail","clientPhone","caseTypeV","subType","actualDeadline","deadlineType","internalDeadline","phaseV","retainedBy","retainerStatus","paymentStatus","stageV","portal","officerV","managerV","qPct","docPct"],'
  + '"deadlines":["caseRef","clientName","dependents","clientEmail","clientPhone","caseTypeV","subType","actualDeadline","deadlineType","internalDeadline","phaseV","retainedBy","retainerStatus","paymentStatus","stageV","portal","officerV","managerV","qPct","docPct"],'
  + '"eeita":["caseRef","clientName","dependents","clientEmail","clientPhone","caseTypeV","subType","actualDeadline","deadlineType","internalDeadline","phaseV","retainedBy","retainerStatus","paymentStatus","stageV","portal","officerV","managerV","qPct","docPct"]}';
const TABCOLS_ON_TEXT = TABCOLS_OFF_TEXT.slice(0, -1)
  + ',"todo":["caseRef","clientName","todoWith","caseTypeV","subType","stageV","actualDeadline","deadlineType","internalDeadline","officerV","qPct","docPct"]}';
const ALL_LABELS = ['Case Ref', 'Client', 'Type', 'Stage', 'Phase', 'Deadline', 'Promised', 'Health', 'SLA Risk', 'Support Officer', 'Manager', 'Readiness', 'Days', 'Status', ''];
const VIEW_LABELS = ['Case Ref', 'Client', 'Dependents', 'Client email', 'Contact number', 'Case type', 'Sub-type', 'Actual deadline', 'Deadline type', 'Internal deadline', 'Phase',
  'Retained by', 'Retainer status', 'Payment status', 'Stage', 'Client portal', 'Support officer', 'Case manager', 'Questionnaire %', 'Documents uploaded %'];
const ALL_CAN_ADD = ['dependents', 'clientEmail', 'clientPhone', 'subType', 'deadlineType', 'retainedBy', 'retainerStatus', 'paymentStatus', 'portal', 'qPct', 'docPct'];
const VIEW_CAN_ADD = ['health', 'slaRisk', 'overallReadiness', 'daysElapsed', 'status'];

/* The switch is read from the environment at call time: every page here is asked for with the switch said out loud. */
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
function renderRoute(path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
}
const pageOff = (path) => withEnv({ TODO_TAB: undefined }, () => renderRoute(path || '/'));
const pageOn = () => withEnv({ TODO_TAB: 'on' }, () => renderRoute('/'));
function inlineScripts(html) { return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]); }

/* ═══ the data ═══ */

const FOLDER = 'https://files.example/personal/staff/Documents/Clients/Sample%20Person%20-%202026-XX-001';
const RECORD = 'https://app.example/admin/consultation/900000001';
const people = (...ids) => JSON.stringify({ personsAndTeams: ids.map((id) => ({ id, kind: 'person' })) });
const FULL_CELLS = [
  { id: 'date_mm0xjm1z', text: '2026-11-03', value: JSON.stringify({ date: '2026-11-03' }) },
  { id: 'date_mm0x5pqd', text: '2026-12-20', value: JSON.stringify({ date: '2026-12-20' }) },
  { id: 'date_mm0x26t4', text: '2026-12-10', value: JSON.stringify({ date: '2026-12-10' }) },
  { id: 'date_mm0xfgbp', text: '2026-12-01 09:30', value: JSON.stringify({ date: '2026-12-01', time: '09:30:00' }) },
  { id: 'numeric_mm1a4e8r', text: '3', value: '"3"' },
  { id: 'date_mm0xgk76', text: '2026-10-28', value: JSON.stringify({ date: '2026-10-28' }) },
  { id: 'date_mm34x2ga', text: '2026-10-27', value: JSON.stringify({ date: '2026-10-27' }) },
  { id: 'numeric_mm0x6qy4', text: '4', value: '"4"' },
  { id: 'color_mm0x9s08', text: 'In Progress', value: JSON.stringify({ index: 1 }) },
  { id: 'date_mm1amqyr', text: '2026-11-18', value: JSON.stringify({ date: '2026-11-18' }) },
  { id: 'multiple_person_mm0xp0sq', text: 'Super One, Super Two', value: people(31, 32) },
  { id: 'text_mm0xvpr9', text: '  Client has not answered three reminders; the passport copy is still missing.  ', value: '"x"' },
  { id: 'link_mm47dng8', text: 'Folder - ' + FOLDER, value: JSON.stringify({ url: FOLDER, text: 'Folder' }) },
  { id: 'color_mm6be76m', text: 'OneDrive', value: JSON.stringify({ index: 2 }) },
  { id: 'text_mm8t8zhx', text: 'Consultant One', value: '"x"' },
  { id: 'text_mm8tmcm7', text: 'Retain', value: '"x"' },
  { id: 'text_mm8tsw2c', text: '$300.00 paid (app)', value: '"x"' },
  { id: 'text_mm8tqsa5', text: 'Referral — Friend Example', value: '"x"' },
  { id: 'link_mm8txy20', text: 'Open consultation record - ' + RECORD, value: JSON.stringify({ url: RECORD, text: 'Open consultation record' }) },
  // never wanted: must not reach the row whatever the board answers
  { id: NEVER['Case Access Token'], text: 'NOT-WANTED-token', value: '"x"' },
  { id: NEVER['OneDrive Folder Id'], text: 'NOT-WANTED-folder-id', value: '"x"' },
  { id: NEVER['Client Account Id'], text: 'NOT-WANTED-account-id', value: '"x"' },
];
const FULL_MORE = {
  stageStart: '2026-11-03', hardDeadlineSys: '2026-12-20', softDeadlineSys: '2026-12-10', prepDeadlineSys: '2026-12-01', reminderCount: 3, paymentConfirmed: '2026-10-28',
  retainerSigned: '2026-10-27', missingRequired: 4, qStatus: 'In Progress', lastActivity: '2026-11-18', supervisor: 'Super One, Super Two',
  escalationReason: 'Client has not answered three reminders; the passport copy is still missing.', folder: FOLDER, docsLocation: 'OneDrive', consultant: 'Consultant One',
  consultOutcome: 'Retain', consultFee: '$300.00 paid (app)', sourceRef: 'Referral — Friend Example', consultRecord: RECORD,
};
const EMPTY_MORE = {
  stageStart: '', hardDeadlineSys: '', softDeadlineSys: '', prepDeadlineSys: '', reminderCount: null, paymentConfirmed: '', retainerSigned: '', missingRequired: null, qStatus: '',
  lastActivity: '', supervisor: '', escalationReason: '', folder: '', docsLocation: '', consultant: '', consultOutcome: '', consultFee: '', sourceRef: '', consultRecord: '',
};
const item = (id, cells, name) => ({ id: String(id), name: name || 'Client ' + id, created_at: '2026-11-01T00:00:00Z', group: { id: 'g1', title: 'November 2026' }, column_values: cells });

test('the nineteen columns: the same ids, names and order in the list, the service and the page — each on NO tab, each with how it is shown; the Monday ids as agreed', async () => {
  for (const views of [VIEWS, VIEWS_ON, []]) {
    const cols = S.casesListOpts({ views }).cols.filter((c) => c.more);
    assert.deepEqual(cols.map((c) => [c.id, c.label, c.more]), MORE.map((m) => [m[0], m[1], m[2]]));
    for (const c of cols) assert.deepEqual(c.tabs, [], c.id + ' is on no tab by default');
    for (const c of cols) assert.ok(c.title && c.sort === c.id && c.sortText.length === 2 && c.sortDirs.length === 2, c.id + ': a tooltip and a sort both ways');
  }
  assert.equal(MORE.length, 19);
  assert.deepEqual(dash.MORE_KEYS, MORE_IDS);
  assert.deepEqual(dash.MORE_FIELDS, ['more']);
  // the board columns: fourteen new ids, five that were read already — one id each, none twice
  const C = dash.COLS;
  assert.deepEqual([C.stageStart, C.hardDeadline, C.softDeadline, C.prepDeadline, C.reminderCount, C.paymentConfirmed, C.retainerSigned, C.missingRequired, C.qStatus, C.lastActivityDate,
    C.opsSupervisor, C.escalationReason, C.folderLink, C.docsLocation, C.consultant, C.consultOutcome, C.consultFee, C.sourceRef, C.consultRecord], MORE.map((m) => m[3]));
  assert.equal(new Set(Object.values(C)).size, Object.values(C).length, 'no column id twice');
  // the page: CM_MORE is the same nineteen with how each is shown, and the panel is given them in that order
  for (const html of [await pageOff(), await pageOn()]) {
    const main = inlineScripts(html)[0];
    assert.deepEqual(JSON.parse(main.match(/var CM_MORE = (\{.*?\});/)[1]), Object.fromEntries(MORE.map((m) => [m[0], m[2]])));
    assert.deepEqual(Object.keys(JSON.parse(main.match(/var CM_MORE = (\{.*?\});/)[1])), MORE_IDS);
    assert.ok(main.includes('tabCols: CM_TABCOLS, names: CM_COLNAMES, moreCols: Object.keys(CM_MORE), ids: { btn: "cm-cols-btn", pop: "cm-cols-pop" }'));
    const names = JSON.parse(main.match(/var CM_COLNAMES = (\{.*?\});/)[1]);
    assert.deepEqual(MORE_IDS.map((id) => names[id]), MORE_LABELS);
  }
});

test('parseItem: each of the nineteen lands in the row\'s `more` — a date as its plain day (a time is dropped, the day never moves), a number as a number, a status as its label, people as names, text trimmed, a link as its address', () => {
  const r = dash.parseItem(item(1, FULL_CELLS), 0);
  assert.deepEqual(r.more, FULL_MORE);
  assert.deepEqual(Object.keys(r.more), MORE_IDS, 'in the panel\'s order');
  assert.ok(!JSON.stringify(r).includes('NOT-WANTED'), 'the access token, the folder id and the account id are never read onto the row');
  // the fields the Summary page and the other callers have always had are as they were (0 for a blank number, the raw date text)
  assert.deepEqual([r.reminderCount, r.missingRequired, r.supervisor, r.lastActivity, r.hardDeadline], [3, 4, 'Super One, Super Two', '2026-11-18', '2026-12-20']);
  // a Monday date is a plain day: whatever the server's time zone, it comes out as the day on the board
  const prev = process.env.TZ;
  try {
    for (const tz of ['America/Toronto', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      process.env.TZ = tz;
      const day = dash.parseItem(item(2, [{ id: 'date_mm0xjm1z', text: '2026-11-01', value: JSON.stringify({ date: '2026-11-01' }) }, { id: 'date_mm0xgk76', text: '2026-03-08 02:30', value: '{}' }]), 0).more;
      assert.deepEqual([day.stageStart, day.paymentConfirmed], ['2026-11-01', '2026-03-08'], tz);
    }
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
});

test('parseItem: empty cells — \'\' for a date, text, people, a status (never Monday\'s id-5 label) and a link; null for a blank number, never a made-up 0', () => {
  const empty = dash.parseItem(item(2, MORE.map((m) => ({ id: m[3], text: m[2] === 'status' ? 'Not Started' : '', value: null }))), 0);   // an empty status cell reads the id-5 label as text
  assert.deepEqual(empty.more, EMPTY_MORE);
  assert.deepEqual([empty.reminderCount, empty.missingRequired], [0, 0], 'the old numbers (0 for blank) are still there for the Summary page');
  // a row whose cells were not in the answer at all
  assert.deepEqual(dash.parseItem(item(3, []), 0).more, EMPTY_MORE);
  // a 0 that is on the board is a number, not a blank; junk in a date cell is no date
  const z = dash.parseItem(item(4, [{ id: 'numeric_mm1a4e8r', text: '0', value: '"0"' }, { id: 'numeric_mm0x6qy4', text: '0', value: '"0"' }, { id: 'date_mm0xjm1z', text: 'soon', value: '"x"' }]), 0).more;
  assert.deepEqual([z.reminderCount, z.missingRequired, z.stageStart], [0, 0, '']);
});

test('link safety (the service): only a whole https:// address is kept — http, another scheme, a "label - url" text, spaces, markup or junk JSON is no link', () => {
  for (const col of ['link_mm47dng8', 'link_mm8txy20']) {
    const key = col === 'link_mm47dng8' ? 'folder' : 'consultRecord';
    const link = (cv) => dash.parseItem(item(5, [{ id: col, ...cv }]), 0).more[key];
    assert.equal(link({ text: '', value: JSON.stringify({ url: FOLDER }) }), FOLDER);
    assert.equal(link({ text: FOLDER, value: null }), FOLDER, 'the cell text when it is the address itself');
    assert.equal(link({ text: FOLDER, value: '{not json' }), FOLDER);
    assert.equal(link({ text: '', value: JSON.stringify({ url: 'https://files.example/Clients/O\'Sample%20Person' }) }), 'https://files.example/Clients/O\'Sample%20Person', 'an apostrophe in a folder name is fine');
    assert.equal(link({ text: 'Folder - ' + FOLDER, value: null }), '', 'label text is not an address');
    assert.equal(link({ text: '', value: JSON.stringify({ url: 'http://files.example/x' }) }), '', 'http is not https');
    assert.equal(link({ text: 'http://files.example/x', value: null }), '');
    assert.equal(link({ text: '', value: JSON.stringify({ url: 'javascript:alert(1)' }) }), '');
    assert.equal(link({ text: '', value: JSON.stringify({ url: 'data:text/html,x' }) }), '');
    assert.equal(link({ text: '', value: JSON.stringify({ url: 'https://files.example/x"><script>' }) }), '');
    assert.equal(link({ text: '', value: JSON.stringify({ url: 'https://files.example/a b' }) }), '');
    assert.equal(link({ text: '', value: JSON.stringify({ url: 'https://' }) }), '');
    assert.equal(link({ text: '', value: JSON.stringify({ url: '//files.example/x' }) }), '');
    assert.equal(link({ text: '', value: JSON.stringify({ url: { a: 1 } }) }), '');
    assert.equal(link({ text: 'ftp://files.example/x', value: null }), '');
  }
});

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
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

test('the delivery rule: `more` rides ONLY on the page\'s own load (contact) — after the access filter; every other caller gets rows without it; the three columns never to be read are not asked for; nothing is logged; no write', async () => {
  const CSO = 'multiple_person_mm0xm710';
  const mine = item(1, FULL_CELLS.concat([{ id: CSO, text: 'Staff Nine', value: people(111) }]), 'Mine Example');
  const theirs = item(2, [
    { id: 'text_mm0xvpr9', text: 'Hidden reason about another client', value: '"x"' }, { id: 'text_mm8tsw2c', text: '$999.00 hidden fee', value: '"x"' },
    { id: 'link_mm47dng8', text: '', value: JSON.stringify({ url: 'https://files.example/Clients/Hidden-Folder-2' }) },
    { id: 'link_mm8txy20', text: '', value: JSON.stringify({ url: 'https://app.example/admin/consultation/900000002' }) }, { id: CSO, text: 'Staff Eight', value: people(222) },
  ], 'Theirs Example');
  const board = fakeBoard([mine, theirs]);
  const restoreClock = stub(dash._casesIo.io, 'now', () => Date.parse('2026-11-20T15:00:00Z'));
  const logged = [];
  const restoreLogs = ['log', 'warn', 'error', 'info', 'debug'].map((k) => stub(console, k, (...a) => { logged.push(a.map(String).join(' ')); }));
  const prev = process.env.CASE_VISIBILITY;
  process.env.CASE_VISIBILITY = 'assigned';
  try {
    dash.invalidateCases(); dash._casesIo.overrides.clear();
    // the page's own load, a viewer limited to their own cases: `more` on the row they may see — and nothing of the other case
    const viewer = { userId: '111', teamIds: [], isAdmin: false };
    const page = await dash.getDashboardStats(viewer, { contact: true });
    assert.deepEqual(page.cases.map((c) => [c.id, c.more]), [['1', FULL_MORE]]);
    for (const hidden of ['Hidden reason', '$999.00', 'Hidden-Folder-2', '900000002', 'Theirs Example']) assert.ok(!JSON.stringify(page).includes(hidden), hidden + ' never reaches a viewer who may not see the case');
    // every other caller: /api/dashboard/stats (no options), the Summary page and the page's quiet re-fetch (no contact), the To-do option alone
    const others = { 'no options': undefined, 'an empty object': {}, 'contact false': { contact: false }, 'fresh only': { fresh: true }, 'the To-do option alone': { todo: true } };
    for (const [what, opts] of Object.entries(others)) {
      const plain = await dash.getDashboardStats(undefined, opts);
      assert.equal(plain.cases.length, 2, what);
      for (const c of plain.cases) assert.ok(!('more' in c), what + ': no `more` on the row');
      const text = JSON.stringify(plain);
      for (const v of [FOLDER, RECORD, 'Hidden-Folder-2', '900000002', 'has not answered three reminders', '$300.00 paid', '$999.00', 'Consultant One', 'Referral — Friend Example', 'In Progress', '2026-12-10', '2026-12-01', '2026-11-03', '2026-10-27']) {
        assert.ok(!text.includes(v), what + ': ' + v + ' is not in the answer');
      }
      for (const k of MORE_IDS.filter((id) => !['reminderCount', 'missingRequired', 'lastActivity', 'supervisor'].includes(id))) assert.ok(!text.includes('"' + k + '"'), what + ': no key ' + k);
    }
    const admin = await dash.getDashboardStats(undefined, { contact: true });
    assert.deepEqual(admin.cases.map((c) => [c.more.folder, c.more.consultRecord]), [[FOLDER, RECORD], ['https://files.example/Clients/Hidden-Folder-2', 'https://app.example/admin/consultation/900000002']]);
    // the summary numbers are the same with and without it (nothing new is counted)
    const strip = (s) => JSON.stringify({ ...s, cases: null, generatedAt: null });
    assert.equal(strip(admin), strip(await dash.getDashboardStats(undefined)));
    // one read of the board served every call; it asks for the fourteen new columns and never for the three that are not wanted
    assert.equal(board.calls.filter((q) => /items_page\(limit: 500/.test(q)).length, 1);
    const rowsQ = board.calls.find((q) => /items\(ids: \$ids, limit: 100\)/.test(q));
    for (const m of MORE) assert.ok(rowsQ.includes('"' + m[3] + '"'), m[3] + ' (' + m[1] + ') is in the board read');
    for (const [name, id] of Object.entries(NEVER)) assert.ok(!board.calls.some((q) => q.includes(id)), name + ' is never asked for');
    assert.ok(board.calls.every((q) => !/mutation/.test(q)), 'no Monday write');
    assert.ok(!/files\.example|app\.example|reminders|\$300|\$999|Consultant One|Friend Example/.test(logged.join('\n')), 'nothing of the new fields in the logs');
  } finally {
    if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev;
    restoreLogs.forEach((r) => r()); restoreClock(); board.restore(); dash.invalidateCases();
  }
});

test('the delivery rule in the code: one request flag (contact=1) — the route passes it only when asked, the list page asks, the Summary and the quiet re-fetch do not, /api/dashboard/stats never; the three unwanted ids are nowhere in the service', async () => {
  const svc = fs.readFileSync(require.resolve('../src/services/dashboardService'), 'utf8');
  assert.match(svc, /if \(!contact\) for \(const c of cases\) for \(const f of MORE_FIELDS\) delete c\[f\];/);
  assert.match(svc, /if \(!contact\) for \(const c of cases\) for \(const f of CONTACT_FIELDS\) delete c\[f\];/, 'the contact details\' own rule is as it was');
  for (const [name, id] of Object.entries(NEVER)) assert.ok(!svc.includes(id), name + ' is not in the service');
  assert.ok(!/console\.[a-z]+\([^)]*\bmore\b/.test(svc), 'the service never logs the row\'s more');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const route = server.slice(server.indexOf("app.get('/admin/dashboard-stats'"), server.indexOf("app.get('/admin/needs-attention'"));
  assert.ok(route.includes("contact: req.query.contact === '1'") && !/contact: true/.test(route) && !/\bmore\b/.test(route), 'no new flag on the route');
  const api = server.slice(server.indexOf("app.get('/api/dashboard/stats'"), server.indexOf("app.get('/admin/dashboard-stats'"));
  assert.ok(api.includes('dashboardService.getDashboardStats();'), 'the key-only route asks for nothing');
  const main = inlineScripts(await pageOff())[0];
  assert.ok(main.includes("if (VIEW !== 'summary') qs.push('contact=1');"));
  assert.ok(main.includes("fetch('/admin/dashboard-stats', { headers: key ? { 'X-Api-Key': key } : {}, credentials: 'same-origin' })"), 'the quiet re-fetch asks without contact=1');
  const wait = main.slice(main.indexOf('function cmWaitLater()'), main.indexOf('function renderCasesList('));
  assert.ok(!/\.more\b/.test(wait), 'and copies nothing but the waiting label onto the rows on screen');
  // the Summary page has none of the new page code's data
  const sum = await pageOff('/summary');
  assert.ok(!sum.includes('var CM_MORE =') && !sum.includes('CM_COLNAMES'));
  for (const s of inlineScripts(sum)) new vm.Script(s);
});

/* ═══ rule 1: every tab is exactly what it was ═══ */

test('OFF BY DEFAULT: CM_TABCOLS is to the letter what it was — on the page without the To-do tab and on the page with it; no tab of the list has any of the nineteen', async () => {
  const tabcols = (html) => inlineScripts(html)[0].match(/var CM_TABCOLS = (.*);/)[1];
  const off = await pageOff(), on = await pageOn();
  assert.equal(tabcols(off), TABCOLS_OFF_TEXT, 'without the To-do tab: byte for byte');
  assert.equal(tabcols(on), TABCOLS_ON_TEXT, 'with the To-do tab: byte for byte');
  assert.deepEqual(JSON.parse(tabcols(off)), TABCOLS_OFF);
  assert.deepEqual(JSON.parse(tabcols(on)), TABCOLS_ON);
  assert.equal(tabcols(await pageOff('/summary')), TABCOLS_OFF_TEXT, 'the Summary page\'s copy too');
  // the engine's own answer per tab
  const on2 = listCore({}).colsOnTab;
  for (const [views, want] of [[VIEWS, TABCOLS_OFF], [VIEWS_ON, TABCOLS_ON]]) {
    const cols = S.casesListOpts({ views }).cols;
    for (const tab of Object.keys(want)) {
      const got = on2(cols, tab).map((c) => c.id);
      if (tab === 'todo') assert.deepEqual(got.slice().sort(), want[tab].slice().sort()); else assert.deepEqual(got, want[tab], tab || 'All');
      for (const id of MORE_IDS) assert.ok(!got.includes(id), id + ' is not on ' + (tab || 'All'));
    }
    for (const tab of ['no-such-tab', 'more', 'undefined', 'null']) assert.deepEqual(on2(cols, tab).map((c) => c.id), ['caseRef', 'clientName'], 'an unknown tab: only the two columns every tab has');
  }
  // the default plan of every tab draws exactly the tab's own columns
  for (const [tc, moreIds] of [[TABCOLS_OFF, MORE_IDS], [TABCOLS_ON, MORE_IDS]]) {
    for (const tab of Object.keys(tc)) {
      const plan = U.colPlan(tc, tab, moreIds);
      for (const raw of [undefined, null, {}, { hidden: [], added: [] }]) assert.deepEqual(U.colIds(plan, raw), tc[tab], (tab || 'All') + ' with nothing chosen');
      assert.deepEqual(U.colSummary(plan, null), { hidden: 0, added: 0, custom: false, text: '' });
    }
  }
});

/* ═══ the rules (pure) ═══ */

test('the rules: every tab offers the nineteen in a group of its own (the same order everywhere); what the tab offered before is untouched; one that is switched on is drawn after the tab\'s other columns', () => {
  for (const [tc, name] of [[TABCOLS_OFF, 'no To-do tab'], [TABCOLS_ON, 'with the To-do tab']]) {
    for (const tab of Object.keys(tc)) {
      const before = U.colPlan(tc, tab), plan = U.colPlan(tc, tab, MORE_IDS);
      assert.deepEqual(plan.more, MORE_IDS, name + ' / ' + (tab || 'All'));
      assert.deepEqual([plan.tab, plan.own, plan.extra, plan.fixed, plan.locked], [before.tab, before.own, before.extra, before.fixed, before.locked], 'own, extra, fixed and locked are as they were');
      assert.deepEqual(before.more, []);
      for (const id of MORE_IDS) assert.ok(!plan.own.includes(id) && !plan.extra.includes(id), id + ' is offered once');
    }
  }
  const all = U.colPlan(TABCOLS_OFF, '', MORE_IDS), view = U.colPlan(TABCOLS_OFF, 'deadlines', MORE_IDS);
  assert.deepEqual(all.extra, ALL_CAN_ADD); assert.deepEqual(view.extra, VIEW_CAN_ADD);
  // switched on: after the tab's own, after the other tabs' added columns, before All's delete column — in the panel's order whatever order they were ticked in
  assert.deepEqual(U.colIds(all, { added: ['folder', 'stageStart'] }), ALL_IDS.slice(0, -1).concat(['stageStart', 'folder', 'del']));
  assert.deepEqual(U.colIds(all, { added: ['consultRecord', 'docPct', 'reminderCount'] }), ALL_IDS.slice(0, -1).concat(['docPct', 'reminderCount', 'consultRecord', 'del']));
  assert.deepEqual(U.colIds(view, { hidden: ['portal'], added: ['qStatus', 'health'] }), VIEW_IDS.filter((id) => id !== 'portal').concat(['health', 'qStatus']));
  // a toggle: tick = added, untick = gone, back at the default nothing is left; the summary counts them as added
  let pref = U.colToggle(view, null, 'supervisor', true);
  assert.deepEqual(pref, { hidden: [], added: ['supervisor'] });
  pref = U.colToggle(view, pref, 'escalationReason', true);
  assert.deepEqual(U.colSummary(view, pref), { hidden: 0, added: 2, custom: true, text: '2 added' });
  pref = U.colToggle(view, U.colToggle(view, pref, 'supervisor', false), 'escalationReason', false);
  assert.deepEqual(pref, { hidden: [], added: [] });
  // an optional column can never be "hidden" (it is not one of the tab's own), and junk ids are ignored
  assert.deepEqual(U.colPref(view, { hidden: ['stageStart', 'folder'], added: ['folder', 'no-such', 'del', 'caseRef', 'folder'] }), { hidden: [], added: ['folder'] });
  // without the list of optional columns (older page code, the Summary) nothing of them is offered or drawn
  assert.deepEqual(U.colIds(U.colPlan(TABCOLS_OFF, ''), { added: ['stageStart'] }), ALL_IDS);
  // what is kept is the same shape as always
  assert.deepEqual(U.colStoreOut({ all: { hidden: ['phase'], added: ['stageStart', 'docPct'] } }), { v: 1, tabs: { all: { hidden: ['phase'], added: ['stageStart', 'docPct'] } } });
  // the wide table: All turns wide once one of them is added (it is not one of All's own columns); a view tab is always wide
  assert.equal(U.colWide(TABCOLS_OFF, '', U.colIds(all, { added: ['stageStart'] })), true);
  assert.equal(U.colWide(TABCOLS_OFF, '', U.colIds(all, null)), false);
  // the rules are still plain browser code
  for (const fn of [U.clientMasterUi, CUI.clientMasterColumnsUi, S.casesListSpec, S.casesListOpts]) assert.ok(!/[`\\]|\$\{|<\/script/i.test(fn.toString()), fn.name + ': no backslash, backtick or dollar-brace');
});

/* ═══ sorts, filters, the search ═══ */

const row = (id, more, rest) => ({ id: String(id), clientName: 'Person ' + id, caseRef: '2026-XX-00' + id, caseType: 'Visitor Visa', views: [], more, ...rest });

test('each of the nineteen sorts: dates soonest / latest, numbers, text A → Z — blanks last both ways; a link column by whether the case has the link', () => {
  const LT = listCore(S.casesListSpec({ views: VIEWS }));
  const cols = Object.fromEntries(S.casesListOpts({ views: VIEWS }).cols.map((c) => [c.id, c]));
  const order = (key, dir, rows) => LT.sortRows(rows, { key, dir }).map((r) => r.id).join('');
  // dates
  for (const id of MORE.filter((m) => m[2] === 'date').map((m) => m[0])) {
    const rows = [row('a', { [id]: '2026-12-05' }), row('b', { [id]: '' }), row('c', { [id]: '2026-02-20' }), row('d', {}), row('e', { [id]: '2027-01-01' }), row('f', undefined)];
    assert.equal(order(id, 'asc', rows), 'caebdf', id + ' soonest first');
    assert.equal(order(id, 'desc', rows), 'eacbdf', id + ' latest first — the blanks still last');
    assert.ok(['Soonest first', 'Latest first'].includes(cols[id].sortText[0]) && cols[id].sortText[0] !== cols[id].sortText[1], id + ': the sort is named in words');
  }
  for (const id of SYS_IDS) assert.deepEqual([cols[id].sortText, cols[id].sortDirs], [['Soonest first', 'Latest first'], ['asc', 'desc']], id + ': like the Actual deadline');
  // numbers — as numbers (10 after 9), a 0 is a value, a blank is last
  for (const id of ['reminderCount', 'missingRequired']) {
    const rows = [row('a', { [id]: 10 }), row('b', { [id]: null }), row('c', { [id]: 9 }), row('d', { [id]: 0 }), row('e', {})];
    assert.equal(order(id, 'desc', rows), 'acdbe', id + ' most first');
    assert.equal(order(id, 'asc', rows), 'dcabe', id + ' fewest first');
    assert.deepEqual([cols[id].sortText, cols[id].sortDirs], [['Most first', 'Fewest first'], ['desc', 'asc']]);
  }
  // text, statuses, people
  for (const id of MORE.filter((m) => ['status', 'names', 'text', 'clip'].includes(m[2])).map((m) => m[0])) {
    const rows = [row('a', { [id]: 'beta' }), row('b', { [id]: '' }), row('c', { [id]: 'Alpha' }), row('d', {}), row('e', { [id]: 'gamma' })];
    assert.equal(order(id, 'asc', rows), 'caebd', id + ' A → Z, capitals ignored');
    assert.equal(order(id, 'desc', rows), 'eacbd', id + ' Z → A');
    assert.deepEqual([cols[id].sortText, cols[id].sortDirs], [['A → Z', 'Z → A'], ['asc', 'desc']]);
  }
  // links: with a link first / without first; the address is never the sort key
  for (const id of ['folder', 'consultRecord']) {
    const rows = [row('a', { [id]: '' }), row('b', { [id]: 'https://files.example/zzz' }), row('c', {}), row('d', { [id]: 'https://files.example/aaa' })];
    assert.equal(order(id, 'asc', rows), 'bdac', id + ' with a link first (the board order inside)');
    assert.equal(order(id, 'desc', rows), 'acbd', id + ' without a link first');
    assert.deepEqual(cols[id].sortText, ['With a link first', 'Without a link first']);
  }
  // every one of the nineteen has its sort in the spec, and the old sorts are all still there
  const sp = S.casesListSpec({ views: VIEWS });
  for (const id of MORE_IDS) assert.equal(typeof sp.sorts[id], 'function', id);
  for (const k of ['createdAt', 'actualDeadline', 'promisedDate', 'qPct', 'docPct', 'managerV']) assert.equal(typeof sp.sorts[k], 'function', k);
});

test('the ordinary value filter on the six status / people / short-text columns: the choices with their counts, the empty choice in words, a chip; no filter on the dates, numbers, the long reason or the links', () => {
  const sp = S.casesListSpec({ views: VIEWS }), LT = listCore(sp);
  const cols = Object.fromEntries(S.casesListOpts({ views: VIEWS }).cols.map((c) => [c.id, c]));
  const FILTERS = { qStatus: ['Questionnaire status', 'Not set'], docsLocation: ['Documents location', 'Not set'], supervisor: ['Ops supervisor', 'Nobody'], consultant: ['Consultant', 'No consultant'],
    consultOutcome: ['Consultation outcome', 'No outcome'], sourceRef: ['Source / Reference', 'No source'] };
  for (const id of MORE_IDS) {
    if (FILTERS[id]) { assert.deepEqual([cols[id].menu, cols[id].facets], ['facet', [id]], id); assert.deepEqual([sp.facets[id].label, sp.facets[id].none], FILTERS[id], id); }
    else assert.ok(!cols[id].menu && !cols[id].facets && !cols[id].flags && !cols[id].date, id + ' has no filter');
  }
  const rows = [row(1, { qStatus: 'Done', supervisor: 'Super One, Super Two', consultant: 'Consultant One' }), row(2, { qStatus: 'In Progress', supervisor: 'Super Two' }),
    row(3, { qStatus: '', supervisor: '' }), row(4, undefined), row(5, { qStatus: 'Done', supervisor: 'Super One', consultant: 'Consultant Two' })];
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'qStatus').map((x) => [x.label, x.count]), [['Done', 2], ['In Progress', 1], ['Not set', 2]]);
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'supervisor').map((x) => [x.label, x.count]), [['Super One', 2], ['Super Two', 2], ['Nobody', 2]], 'each name is its own choice');
  const st = LT.emptyState(); st.sel.qStatus = ['Done']; st.sel.supervisor = ['Super Two'];
  assert.deepEqual(LT.filterRows(rows, st).map((r) => r.id), ['1']);
  assert.deepEqual(LT.chips(st).map((c) => c.text).sort(), ['Ops supervisor: Super Two', 'Questionnaire status: Done']);
  const none = LT.emptyState(); none.sel.consultant = [LT.NONE];
  assert.deepEqual(LT.filterRows(rows, none).map((r) => r.id), ['2', '3', '4'], 'a row without the values at all counts as empty');
});

test('the search box is unchanged: it does not look in any of the nineteen', () => {
  const sp = S.casesListSpec({ views: VIEWS }), LT = listCore(sp);
  const r = { id: '1', clientName: 'Sample Person', caseRef: '2026-XX-001', caseType: 'Visitor Visa', officer: 'Ann Lee', clientEmail: 'sample@example.com', clientPhone: '14165550134', dependents: 'Child: Omar Example', views: [], more: FULL_MORE };
  assert.deepEqual(sp.search.text(r), ['Sample Person', '2026-XX-001', 'Visitor Visa', 'Ann Lee', 'sample@example.com', '14165550134', 'Child: Omar Example']);
  for (const q of ['Consultant One', 'reminders', 'Super One', 'Retain', 'Friend Example', 'files.example', 'In Progress', 'OneDrive', '2026-12-10', '$300']) {
    const st = LT.emptyState(); st.q = q;
    assert.deepEqual(LT.filterRows([r], st), [], 'searching "' + q + '" finds nothing');
  }
  const st = LT.emptyState(); st.q = 'omar';
  assert.equal(LT.filterRows([r], st).length, 1, 'the old search still works');
});

test('the three system dates are shown only: they do not put a case in a view, in a half-month window, under a flag or on the To-do order — and their tooltip says so in plain words', async () => {
  const cols = Object.fromEntries(S.casesListOpts({ views: VIEWS_ON }).cols.map((c) => [c.id, c]));
  assert.equal(cols.hardDeadlineSys.title, 'Hard Deadline. ' + SYS_WORDS);
  assert.equal(cols.softDeadlineSys.title, 'Soft Deadline. ' + SYS_WORDS);
  assert.equal(cols.prepDeadlineSys.title, 'Submission Prep Deadline. ' + SYS_WORDS);
  for (const id of MORE_IDS.filter((x) => !SYS_IDS.includes(x))) assert.ok(!cols[id].title.includes('Set by the system'), id);
  // two cases that differ ONLY in the system dates: the same views, the same window, the same flag, the same counts
  const base = { id: '1', caseStage: 'Internal Review', stageIdx: 1, phase: 'Phase 8', phaseIdx: 4, deadlineType: 'Imaginary', actualDeadline: '2026-12-02', promisedDate: '2026-11-22', docUploadedPct: 10,
    groupId: 'g_nov', groupTitle: 'November 2026', caseTypeIds: [1], officerIds: { personIds: [], teamIds: [] } };
  const a = { ...base, more: { ...EMPTY_MORE } };
  const b = { ...base, more: { ...EMPTY_MORE, hardDeadlineSys: '2026-11-01', softDeadlineSys: '2026-10-01', prepDeadlineSys: '2026-09-01' } };
  assert.deepEqual(cmv.viewsOf(a), cmv.viewsOf(b));
  assert.equal(CMW.bucketDate(a), CMW.bucketDate(b));
  assert.deepEqual(CMW.windowOf(CMW.bucketDate(a)), CMW.windowOf(CMW.bucketDate(b)));
  assert.deepEqual(CMW.flagOf(a, '2026-11-20'), CMW.flagOf(b, '2026-11-20'));
  assert.deepEqual(CMW.windowsBox([a], '2026-11-20'), CMW.windowsBox([b], '2026-11-20'));
  // the code that decides views, windows, flags and the To-do lists never reads the row's `more`
  for (const f of ['../src/services/clientMasterViews', '../src/routes/clientMasterWindows', '../src/routes/todoUi', '../src/routes/todoPage', '../src/services/todoListService']) {
    const src = fs.readFileSync(require.resolve(f), 'utf8');
    assert.ok(!/\.more\b|DeadlineSys|softDeadline|prepDeadline/.test(src), f + ' does not read the optional columns');
  }
});

/* ═══ the page: the real emitted scripts over a small fake page ═══ */

function storage(init) {
  const m = new Map(Object.entries(init || {})), writes = [];
  return { m, writes, api: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { writes.push(['set', k]); m.set(k, String(v)); }, removeItem: (k) => { writes.push(['remove', k]); m.delete(k); },
    key: (i) => [...m.keys()][i] === undefined ? null : [...m.keys()][i], get length() { return m.size; } } };
}
let PAGE_HTML = null;
/* The Client Master page (no To-do tab) in a fake window: BOTH emitted scripts run as they are. A drawn row answers
   querySelectorAll('.cm-olink') with one stand-in per link in its html, so the test can press them. */
async function cmPage({ local = {}, view = '' } = {}) {
  PAGE_HTML = PAGE_HTML || await pageOff();
  const scripts = inlineScripts(PAGE_HTML);
  assert.equal(scripts.length, 2, 'the page script and the list engine\'s');
  const els = {}, listeners = {};
  const doc = { activeElement: null, readyState: 'loading' };
  function mk(tag, id) {
    const e = { tag, id: id || '', _html: '', kids: [], style: {}, attrs: {}, className: '', value: '', title: '', textContent: '', disabled: false, onclick: null, parentNode: null, scrollWidth: 1000, clientWidth: 1000, links: null,
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.kids.push(c); c.parentNode = this; return c; }, insertBefore(c) { this.kids.push(c); return c; }, removeChild() {}, addEventListener() {},
      querySelector() { return null; },
      querySelectorAll(sel) { if (sel !== '.cm-olink') return []; this.links = this.links || (this._html.match(/class="cm-olink"/g) || []).map(() => ({ onclick: null })); return this.links; },
      contains(x) { return x === this; }, closest() { return null; }, focus() { doc.activeElement = this; }, scrollIntoView() {},
      getBoundingClientRect() { return { left: 640, right: 720, top: 270, bottom: 300, width: 80, height: 30 }; } };
    const words = () => e.className.split(/\s+/).filter(Boolean);
    e.classList = { contains: (c) => words().includes(c), add: (c) => { if (!words().includes(c)) e.className = words().concat([c]).join(' '); }, remove: (c) => { e.className = words().filter((w) => w !== c).join(' '); },
      toggle: (c, on) => { const has = words().includes(c), want = on === undefined ? !has : !!on; if (want && !has) e.classList.add(c); if (!want && has) e.classList.remove(c); return want; } };
    Object.defineProperty(e, 'innerHTML', { get() { return this._html; }, set(v) { this._html = String(v); this.kids = []; this.links = null; } });
    return e;
  }
  for (const id of ['cs-quick', 'cm-head', 'search-box', 'cm-oc', 'cm-cols-btn', 'table-count', 'cs-chips', 'cs-headrow', 'all-cases-body', 'refresh-btn', 'loading', 'content', 'error-msg']) els[id] = mk('div', id);
  els['all-cases-table'] = mk('table', 'all-cases-table'); els['all-cases-table'].className = 'data-table';
  const wrap = mk('div'); wrap.className = 'tbl-wrap'; els['all-cases-table'].parentNode = wrap;
  els['cm-cols-btn'].className = 'cm-oc-b cm-cols-b'; els['cm-cols-btn']._html = 'Columns';
  const body = mk('body');
  body.appendChild = (c) => { if (c.id) els[c.id] = c; return c; };
  Object.assign(doc, { getElementById: (id) => els[id] || null, createElement: (t) => mk(t), body, documentElement: mk('html'), querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, dispatchEvent: (ev) => { (listeners[ev.type] || []).forEach((f) => f(ev)); return true; } });
  const ls = storage(local), ss = storage({});
  const went = [];
  const ctx = { document: doc, console, URL, URLSearchParams, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame() {},
    history: { replaceState() {} }, innerWidth: 1440, innerHeight: 900, addEventListener() {}, matchMedia: () => ({ matches: true }), fetch: () => new Promise(() => {}), TDOT_IS_ADMIN: true,
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; }, sessionStorage: ss.api, localStorage: ls.api };
  const loc = { search: view ? '?view=' + view : '', pathname: '/admin/dashboard', replace() {} };
  Object.defineProperty(loc, 'href', { get() { return 'https://staff.example/admin/dashboard' + loc.search; }, set(v) { went.push(String(v)); } });
  ctx.location = loc;
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const s of scripts) vm.runInContext(s, ctx);
  ctx.cmToday = () => '2026-11-20';   // a fixed day (the windows and the flags are counted from it)
  const headRow = els['cs-headrow'];
  const p = { ctx, els, wrap, ls, doc, went,
    cols: () => ctx.CMCOLS, btn: els['cm-cols-btn'], pop: () => els['cm-cols-pop'] || null, table: els['all-cases-table'],
    setRows(rows) { ctx._data = { meta: null, cases: rows }; ctx.CasesTable.setRows(rows); },
    tab(v) { const st = ctx.CasesTable.state(); if (v) st.sel.view = [v]; else delete st.sel.view; ctx.CasesTable.apply('filter'); },
    headHtml: () => headRow.innerHTML,
    head: () => [...headRow.innerHTML.matchAll(/<th scope="col"[^>]*>(?:<div class="th-in">)?(?:<button[^>]*class="th-l th-sortbtn"[^>]*>|<span class="th-l">)?([^<]*)/g)].map((m) => m[1]),
    /** the header cell of one column, by its name on screen */
    th: (label) => (headRow.innerHTML.split('</th>').find((h) => h.includes('>' + label + '</button>') || h.includes('<span class="th-l">' + label + '</span>')) || '') + '</th>',
    chips: () => [...els['cs-chips'].innerHTML.matchAll(/<span class="q-chip[^"]*">([^<]*)</g)].map((m) => m[1]),
    groups: () => els['all-cases-body'].kids.filter((k) => /^cm-grp /.test(k.className)),
    rows: () => els['all-cases-body'].kids.filter((k) => /(^| )cm-in( |$)/.test(k.className)),
    cells: (tr) => tr.innerHTML.split('</td>').slice(0, -1).map((c) => c + '</td>'),
    spans: () => p.groups().map((g) => Number(g.innerHTML.match(/^<td colspan="(\d+)"/)[1])),
    /** the panel: [[heading, [id+ticked…]], …] — a section with no heading is the tab's own columns */
    sections: () => (p.pop() ? p.pop().innerHTML : '').split('<div class="qp-sec">').slice(1).map((sec) => [(sec.match(/<div class="qp-t">([^<]*)<\/div>/) || [null, ''])[1],
      [...sec.matchAll(/<input type="checkbox" data-colpick="([^"]+)"( checked)?( disabled)?>/g)].map((m) => m[1] + (m[2] ? '+' : '-'))]),
    names: () => [...(p.pop() ? p.pop().innerHTML : '').matchAll(/data-colpick="([^"]+)"[^>]*> <span>([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]),
    kept: () => (ls.m.has(KEY) ? JSON.parse(ls.m.get(KEY)) : null),
    agree(n, why) {
      assert.equal(p.head().length, n, why + ': the header');
      assert.ok(p.rows().length > 0, why + ': rows are drawn');
      for (const r of p.rows()) assert.equal(p.cells(r).length, n, why + ': a row\'s cells');
      for (const s of p.spans()) assert.equal(s, n, why + ': a group heading\'s colspan');
    } };
  return p;
}
const dash0 = '<span style="color:var(--light)">—</span>';
const CASES = [
  { id: '1', caseRef: '2026-XX-001', clientName: 'Sample Person', caseType: 'Visitor Visa', caseSubType: 'Inland', caseStage: 'Internal Review', stageIdx: 1, health: 'Green', slaRisk: 'Green',
    phase: 'Phase 8', phaseIdx: 4, deadlineType: 'Deadline', actualDeadline: '2026-11-03', promisedDate: '', officer: 'Ann Lee', manager: 'Gia Manager', overallReadiness: 60, daysElapsed: 12,
    dependents: '', clientEmail: 'sample@example.com', clientPhone: '14165550134', retainedBy: '', retainerStatus: '', paymentStatus: 'Paid', portalLink: '', qReadinessPct: 85, docUploadedPct: 40,
    groupId: 'g_nov', groupTitle: 'November 2026', boardIdx: 0, createdAt: '2026-11-03T10:00:00Z', views: ['assigning', 'deadlines', 'eeita'], officerIds: { personIds: ['1'], teamIds: [] }, more: FULL_MORE },
  { id: '2', caseRef: '2026-XX-002', clientName: 'Blank Sample', caseType: 'Study Permit', caseSubType: '', caseStage: 'Internal Review', stageIdx: 1, health: 'Green', slaRisk: 'Green',
    phase: '', deadlineType: '', actualDeadline: '', promisedDate: '', officer: '', manager: 'Unassigned', overallReadiness: 0, daysElapsed: 0,
    groupId: 'g_nov', groupTitle: 'November 2026', boardIdx: 1, createdAt: '2026-11-02T10:00:00Z', views: ['assigning', 'deadlines', 'eeita'], officerIds: { personIds: [], teamIds: [] }, more: EMPTY_MORE },
  // a row that came without the values at all (an answer that did not carry them): every optional cell is the dash
  { id: '3', caseRef: '2026-XX-003', clientName: 'Bare Sample', caseType: 'PR Card', caseStage: 'Internal Review', stageIdx: 1, health: 'Green', slaRisk: 'Green', manager: 'Unassigned',
    groupId: 'g_nov', groupTitle: 'November 2026', boardIdx: 2, createdAt: '2026-11-01T10:00:00Z', views: ['assigning', 'deadlines', 'eeita'], officerIds: { personIds: [], teamIds: [] } },
];
const rowsCopy = () => JSON.parse(JSON.stringify(CASES));

test('every tab opens exactly as before: the same header names, the same number of cells, not one optional cell — the plain All table, the wide view tabs', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  assert.deepEqual(p.head(), ALL_LABELS);
  assert.equal(p.table.className, 'data-table');
  p.agree(15, 'All');
  assert.equal(p.btn.innerHTML, 'Columns'); assert.ok(!p.btn.classList.contains('on'));
  assert.equal(p.ls.writes.length, 0, 'looking at the page keeps nothing');
  for (const v of VIEWS) {
    p.tab(v.key);
    assert.deepEqual(p.head(), VIEW_LABELS, v.key);
    p.agree(20, v.key);
    assert.equal(p.table.className, 'data-table cm-wide', v.key);
  }
  for (const r of p.rows()) assert.ok(!/cm-c-more|cm-olink|cm-num/.test(r.innerHTML));
  const drawn = p.rows().map((r) => r.innerHTML).join('');
  for (const v of [FOLDER, RECORD, 'Consultant One', 'reminders', 'Super One', 'Dec 10, 2026']) assert.ok(!drawn.includes(v), v + ' is not on screen until its column is switched on');
});

test('the Columns panel on EVERY tab: the tab\'s own columns, "More columns" as before, then "More from the Monday board" — the nineteen in order, all unticked, by their names', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  const want = { '': [ALL_IDS.slice(0, -1), ALL_CAN_ADD], assigning: [VIEW_IDS, VIEW_CAN_ADD], deadlines: [VIEW_IDS, VIEW_CAN_ADD], eeita: [VIEW_IDS, VIEW_CAN_ADD] };
  for (const tab of Object.keys(want)) {
    p.cols().close(); p.tab(tab); p.cols().open();
    const sec = p.sections();
    assert.equal(sec.length, 3, tab || 'All');
    assert.deepEqual(sec[0], ['', want[tab][0].map((id) => id + '+')], (tab || 'All') + ': the tab\'s own, ticked');
    assert.deepEqual(sec[1], ['More columns', want[tab][1].map((id) => id + '-')], (tab || 'All') + ': the other tabs\' columns, as before');
    assert.deepEqual(sec[2], ['More from the Monday board', MORE_IDS.map((id) => id + '-')], (tab || 'All') + ': the group of its own, last, all off');
    assert.deepEqual(p.names().slice(-19), MORE.map((m) => [m[0], m[1]]));
    assert.match(p.pop().innerHTML, /<label class="qp-row"><input type="checkbox" data-colpick="stageStart"> <span>Stage start date<\/span><\/label>/, 'a real tick box inside its label');
    assert.ok(p.pop().innerHTML.endsWith('<div class="qp-f"><button type="button" class="qp-link" data-act="reset" disabled>Reset to default</button><button type="button" class="qp-done" data-act="close">Done</button></div>'));
  }
  // the panel is never taller than the room there is (the longer list scrolls inside it)
  assert.ok(parseInt(p.pop().style.top, 10) + parseInt(p.pop().style.maxHeight, 10) <= 900);
  assert.ok(PAGE_HTML.includes('#cm-cols-pop .qp-b { min-height:0; }'));
});

test('switch one on: it is added after the tab\'s other columns (before All\'s delete column), the table goes wide and pinned as for any added column, the button says "1 added", the choice is kept — and Reset puts the tab back', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  p.cols().open();
  p.cols().toggle('', 'stageStart', true);
  assert.deepEqual(p.head(), ALL_LABELS.slice(0, -1).concat(['Stage start date', '']));
  p.agree(16, 'All with one optional column');
  assert.equal(p.table.className, 'data-table cm-wide cm-wide-all', 'All is the wide table now');
  assert.ok(p.wrap.classList.contains('cm-scroll'), 'the sideways scroll box');
  assert.match(p.cells(p.rows()[0])[0], /^<td class="cm-pin cm-pin1"/); assert.match(p.cells(p.rows()[0])[1], /^<td class="cm-pin cm-pin2"/);
  assert.equal(p.cells(p.rows()[0])[14], '<td class="cm-c-more"><span class="cm-date">Nov 3, 2026</span></td>');
  assert.ok(p.cells(p.rows()[0])[15].startsWith('<td class="cm-del">'), 'the admin\'s delete cell is still last');
  assert.equal(p.btn.innerHTML, 'Columns<span class="cm-cols-n"> · 1 added</span>');
  assert.equal(p.btn.attrs['aria-label'], 'Columns on All: 1 added');
  assert.deepEqual(p.kept(), { v: 1, tabs: { all: { hidden: [], added: ['stageStart'] } } }, 'the same kept shape as always');
  // a second and a third, ticked out of order: drawn in the panel's order, after the other tabs' added columns
  p.cols().toggle('', 'folder', true); p.cols().toggle('', 'reminderCount', true); p.cols().toggle('', 'docPct', true);
  assert.deepEqual(p.head(), ALL_LABELS.slice(0, -1).concat(['Documents uploaded %', 'Stage start date', 'Reminder count', 'OneDrive folder', '']));
  p.agree(19, 'four added');
  assert.equal(p.table.attrs['data-ncols'], '18', 'paper: the delete column is not printed');
  // the other tabs are untouched by All's choice
  p.cols().close(); p.tab('deadlines');
  assert.deepEqual(p.head(), VIEW_LABELS);
  p.cols().toggle('deadlines', 'qStatus', true);
  assert.deepEqual(p.head(), VIEW_LABELS.concat(['Questionnaire completion status']));
  p.agree(21, 'Deadlines with one optional column');
  assert.equal(p.table.className, 'data-table cm-wide');
  assert.deepEqual([p.table.attrs['data-ncols'], p.table.attrs['data-pfit']], ['21', '1'], 'paper steps down past twenty columns, as for any added column');
  assert.deepEqual(p.kept().tabs.deadlines, { hidden: [], added: ['qStatus'] });
  // untick: gone again, and the tab is at its default
  p.cols().toggle('deadlines', 'qStatus', false);
  assert.deepEqual(p.head(), VIEW_LABELS);
  assert.ok(!('deadlines' in p.kept().tabs));
  // Reset to default on All: exactly its old self
  p.tab(''); p.cols().reset('');
  assert.deepEqual(p.head(), ALL_LABELS);
  assert.equal(p.table.className, 'data-table');
  assert.equal(p.kept(), null, 'nothing left to keep');
});

test('a choice saved before this change keeps working unchanged; a saved choice with the new columns opens with them; stale ids are ignored', async () => {
  // what a browser kept last week: hidden and added on two tabs
  const old = { v: 1, tabs: { all: { hidden: ['phase', 'slaRisk'], added: ['clientEmail'] }, assigning: { hidden: ['portal'], added: ['health'] } } };
  const p = await cmPage({ local: { [KEY]: JSON.stringify(old) } });
  p.setRows(rowsCopy());
  assert.deepEqual(p.head(), ALL_LABELS.filter((l) => l !== 'Phase' && l !== 'SLA Risk').slice(0, -1).concat(['Client email', '']));
  p.tab('assigning');
  assert.deepEqual(p.head(), VIEW_LABELS.filter((l) => l !== 'Client portal').concat(['Health']));
  assert.equal(p.ls.writes.length, 0, 'reading it changes nothing');
  assert.deepEqual(p.kept(), old);
  // a kept choice that already names the new columns (and one id that does not exist)
  const q = await cmPage({ local: { [KEY]: JSON.stringify({ v: 1, tabs: { eeita: { hidden: [], added: ['consultRecord', 'no-such-column', 'lastActivity'] } } }) }, view: 'eeita' });
  q.setRows(rowsCopy());
  assert.deepEqual(q.head(), VIEW_LABELS.concat(['Last client activity date', 'Consultation record']));
  q.agree(22, 'EE after ITA with two optional columns');
});

test('the cells: a date like the Actual deadline\'s date (no window, no flag), a number, a status, names, text, a long reason cut to two lines with the whole text in the title — and the dash for every empty cell, never a made-up 0 or date', async () => {
  const p = await cmPage({ view: 'deadlines' });
  p.setRows(rowsCopy());
  for (const id of MORE_IDS) p.cols().toggle('deadlines', id, true);
  assert.deepEqual(p.head(), VIEW_LABELS.concat(MORE_LABELS));
  p.agree(39, 'every optional column on');
  const cellsOf = (n) => { const tr = p.rows().find((r) => p.cells(r)[0].includes('2026-XX-00' + n)); return Object.fromEntries(MORE_IDS.map((id, i) => [id, p.cells(tr)[20 + i]])); };
  const full = cellsOf(1);
  const date = (t) => '<td class="cm-c-more"><span class="cm-date">' + t + '</span></td>';
  assert.equal(full.stageStart, date('Nov 3, 2026'));
  assert.equal(full.hardDeadlineSys, date('Dec 20, 2026'));
  assert.equal(full.softDeadlineSys, date('Dec 10, 2026'));
  assert.equal(full.prepDeadlineSys, date('Dec 1, 2026'));
  assert.equal(full.paymentConfirmed, date('Oct 28, 2026'));
  assert.equal(full.retainerSigned, date('Oct 27, 2026'));
  assert.equal(full.lastActivity, date('Nov 18, 2026'));
  // … the very words the Actual deadline's own date has for the same day (2026-11-03 on this row)
  const actual = p.cells(p.rows().find((r) => p.cells(r)[0].includes('2026-XX-001')))[VIEW_IDS.indexOf('actualDeadline')];
  assert.ok(actual.includes('<span class="cm-date">Nov 3, 2026</span>') && actual.includes('cm-win'), 'the Actual deadline: the same date words, with its window');
  for (const id of MORE.filter((m) => m[2] === 'date').map((m) => m[0])) assert.ok(!/cm-win|cm-flag|Passed|dlc-btn/.test(full[id]), id + ': no window, no flag, no Passed, no Change…');
  assert.equal(full.reminderCount, '<td class="cm-c-more cm-num">3</td>');
  assert.equal(full.missingRequired, '<td class="cm-c-more cm-num">4</td>');
  assert.equal(full.qStatus, '<td class="cm-c-more">In Progress</td>');
  assert.equal(full.docsLocation, '<td class="cm-c-more">OneDrive</td>');
  assert.equal(full.supervisor, '<td class="cm-c-more cm-c-mnames">Super One, Super Two</td>');
  assert.equal(full.escalationReason, '<td class="cm-c-more cm-c-mclip" title="Client has not answered three reminders; the passport copy is still missing."><span class="cm-clip">Client has not answered three reminders; the passport copy is still missing.</span></td>');
  assert.equal(full.consultant, '<td class="cm-c-more cm-c-mtext">Consultant One</td>');
  assert.equal(full.consultOutcome, '<td class="cm-c-more cm-c-mtext">Retain</td>');
  assert.equal(full.consultFee, '<td class="cm-c-more cm-c-mtext">$300.00 paid (app)</td>', 'the fee as it is stored');
  assert.equal(full.sourceRef, '<td class="cm-c-more cm-c-mtext">Referral — Friend Example</td>');
  // empty board cells, and a row that came without the values at all: the page's ordinary dash in every one of the nineteen
  for (const n of [2, 3]) {
    const blank = cellsOf(n);
    for (const id of MORE_IDS) {
      assert.ok(blank[id].endsWith('>' + dash0 + '</td>'), 'row ' + n + ' ' + id + ': the dash');
      assert.ok(!/>0<|1970|Invalid|NaN|undefined|null/.test(blank[id]), 'row ' + n + ' ' + id + ': nothing made up');
    }
  }
  // a 0 that is on the board shows as 0
  const z = rowsCopy(); z[1].more = { ...EMPTY_MORE, reminderCount: 0, missingRequired: 0 };
  p.setRows(z);
  assert.equal(cellsOf(2).reminderCount, '<td class="cm-c-more cm-num">0</td>');
  assert.equal(cellsOf(2).missingRequired, '<td class="cm-c-more cm-num">0</td>');
  // text from the board is text, never markup
  const x = rowsCopy(); x[0].more = { ...FULL_MORE, consultant: '<img src=x onerror=1>', escalationReason: 'a "quoted" <b>reason</b>', qStatus: '<i>Done</i>', supervisor: 'Super <One>' };
  p.setRows(x);
  const esc = cellsOf(1);
  assert.equal(esc.consultant, '<td class="cm-c-more cm-c-mtext">&lt;img src=x onerror=1&gt;</td>');
  assert.equal(esc.escalationReason, '<td class="cm-c-more cm-c-mclip" title="a &quot;quoted&quot; &lt;b&gt;reason&lt;/b&gt;"><span class="cm-clip">a &quot;quoted&quot; &lt;b&gt;reason&lt;/b&gt;</span></td>');
  assert.equal(esc.qStatus, '<td class="cm-c-more">&lt;i&gt;Done&lt;/i&gt;</td>');
  assert.equal(esc.supervisor, '<td class="cm-c-more cm-c-mnames">Super &lt;One&gt;</td>');
  // a date is a plain day on the page too: the cell code never builds a Date from it
  const main = inlineScripts(PAGE_HTML)[0];
  const cellCode = main.slice(main.indexOf('function cmMoreVal('), main.indexOf('function caseRow('));
  assert.ok(cellCode.includes('function cmMoreCell(c, id)') && !/new Date|Date\.|toLocale/.test(cellCode));
});

test('link safety (the page): only an https address becomes a link — a short word, a new tab, rel="noopener noreferrer", the address escaped and never shown as text; anything else is the dash; a press on the link does not open the case', async () => {
  const p = await cmPage({ view: 'assigning' });
  p.setRows(rowsCopy());
  p.cols().toggle('assigning', 'folder', true); p.cols().toggle('assigning', 'consultRecord', true);
  assert.deepEqual(p.head(), VIEW_LABELS.concat(['OneDrive folder', 'Consultation record']));
  const tr = () => p.rows().find((r) => p.cells(r)[0].includes('2026-XX-001'));
  const [folder, record] = p.cells(tr()).slice(20);
  assert.equal(folder, '<td class="cm-c-more"><a class="cm-olink" href="' + FOLDER + '" target="_blank" rel="noopener noreferrer" title="Open this case’s OneDrive folder in a new tab" aria-label="Open the OneDrive folder of Sample Person in a new tab">Open folder</a></td>');
  assert.equal(record, '<td class="cm-c-more"><a class="cm-olink" href="' + RECORD + '" target="_blank" rel="noopener noreferrer" title="Open this client’s consultation record in a new tab" aria-label="Open the consultation record of Sample Person in a new tab">Open record</a></td>');
  // the address is in the link's target only — not as text, not in a title, not in the spoken name
  for (const cell of [folder, record]) {
    const noHref = cell.replace(/ href="[^"]*"/, '');
    assert.ok(!/https|files\.example|app\.example/.test(noHref), 'the address is nowhere but the href');
  }
  // the links never open the case: each one stops the press from reaching the row
  const links = tr().querySelectorAll('.cm-olink');
  assert.equal(links.length, 2);
  for (const a of links) { let stopped = 0; assert.equal(typeof a.onclick, 'function'); a.onclick({ stopPropagation() { stopped++; } }); assert.equal(stopped, 1); }
  assert.deepEqual(p.went, [], 'pressing a link did not open the case');
  tr().onclick();
  assert.deepEqual(p.went, ['/admin/case/2026-XX-001'], 'the row itself still opens the case');
  // anything that is not an https address is the dash — whatever reaches the page
  const bad = ['http://files.example/x', 'javascript:alert(1)', 'data:text/html,x', '//files.example/x', 'files.example/x', ' ', 'HTTPS', 'ftp://files.example/x', 'vbscript:x', 'https:/files.example'];
  for (const u of bad) {
    const rows = rowsCopy(); rows[0].more = { ...FULL_MORE, folder: u, consultRecord: u };
    p.setRows(rows);
    for (const cell of p.cells(tr()).slice(20)) assert.equal(cell, '<td class="cm-c-more">' + dash0 + '</td>', JSON.stringify(u) + ' is no link');
  }
  // an address with characters that matter in html is escaped inside the href (the service would not send one; the page is safe by itself)
  const rows = rowsCopy(); rows[0].more = { ...FULL_MORE, folder: 'https://files.example/x?a=1&b="><script>alert(1)</script>', consultRecord: '' }; rows[0].clientName = 'Sample "Quoted" <Person>';
  p.setRows(rows);
  const odd = p.cells(tr())[20];
  assert.ok(odd.includes('href="https://files.example/x?a=1&amp;b=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"') && !odd.includes('<script>') && odd.includes('of Sample &quot;Quoted&quot; &lt;Person&gt; in a new tab'));
  // the look and the paper: like the Client portal link; on paper plain text
  assert.ok(PAGE_HTML.includes('.cm-olink { display:inline-block; color:var(--st-blue-fg); font-weight:700; text-decoration:underline;'));
  const print = PAGE_HTML.slice(PAGE_HTML.indexOf('@media print {', PAGE_HTML.indexOf('@page { size: landscape')));
  assert.ok(print.includes('.cm-olink { color:inherit; text-decoration:none; }'));
});

test('the header of a switched-on column: its name sorts, the six with a filter have the funnel, and the three system dates say in their tooltip that they are not the client\'s deadline', async () => {
  const p = await cmPage({ view: 'deadlines' });
  p.setRows(rowsCopy());
  for (const id of MORE_IDS) p.cols().toggle('deadlines', id, true);
  for (const [label, name] of [['Hard deadline (system)', 'Hard Deadline'], ['Soft deadline (system)', 'Soft Deadline'], ['Submission prep deadline (system)', 'Submission Prep Deadline']]) {
    const th = p.th(label);
    assert.ok(th.includes(' title="' + name + '. ' + SYS_WORDS + '"'), label + ': the tooltip');
    assert.ok(th.includes('class="th-l th-sortbtn"') && !th.includes('class="th-f'), label + ': sorts, no filter');
  }
  assert.ok(!p.th('Stage start date').includes('Set by the system'));
  for (const label of ['Questionnaire completion status', 'Documents location', 'Ops supervisor', 'Consultant', 'Consultation outcome', 'Source / Reference']) assert.ok(p.th(label).includes('class="th-f'), label + ': the filter funnel');
  for (const label of ['Reminder count', 'Escalation reason', 'OneDrive folder', 'Consultation record', 'Consultation fee', 'Last client activity date']) assert.ok(!p.th(label).includes('class="th-f'), label + ': no filter');
  // a sort on one of them: the chip says so; hiding the column leaves the chip (never an invisible sort)
  const st = p.ctx.CasesTable.state();
  st.sort = { key: 'softDeadlineSys', dir: 'asc' }; p.ctx.CasesTable.apply('sort');
  assert.deepEqual(p.chips(), ['Sorted: Soft deadline (system) (Soonest first)']);
  assert.deepEqual(p.rows().map((r) => p.cells(r)[0].replace(/<[^>]*>/g, '')), ['2026-XX-001', '2026-XX-002', '2026-XX-003'], 'the case with the date first, the blanks after it');
  p.cols().toggle('deadlines', 'softDeadlineSys', false);
  assert.deepEqual(p.chips(), ['Sorted: Soft deadline (system) (Soonest first)']);
  // a filter on one of them works on the rows on screen
  st.sort = null; st.sel.qStatus = ['In Progress']; p.ctx.CasesTable.apply('filter');
  assert.deepEqual(p.rows().map((r) => p.cells(r)[0].replace(/<[^>]*>/g, '')), ['2026-XX-001']);
  assert.deepEqual(p.chips(), ['Questionnaire status: In Progress']);
});

test('the page code: every emitted script parses with and without the To-do tab and on the Summary page; the new code has no backtick, dollar-brace or backslash; the page without the To-do tab still has not a word of it; the look is in the page\'s own style', async () => {
  const off = await pageOff(), on = await pageOn(), sum = await pageOff('/summary');
  for (const [name, html] of [['no To-do tab', off], ['with the To-do tab', on], ['Summary', sum]]) {
    const scripts = inlineScripts(html);
    assert.ok(scripts.length >= 1, name);
    for (const s of scripts) new vm.Script(s);
  }
  assert.equal(inlineScripts(off).length, 2); assert.equal(inlineScripts(on).length, 2);
  for (const w of ['todoUi', 'tdot_list_cases_todo_who', 'To-do', 'view=todo', 'todoWith']) assert.ok(!off.includes(w), 'the page without the tab holds "' + w + '"');
  const src = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  const block = src.slice(src.indexOf('/* More from the Monday board (Faran 2026-11-20): the optional columns a person may switch on'), src.indexOf('/* One case row. v = the view tab'));
  assert.ok(block.length > 1500 && block.includes('function cmMoreLinkCell(c, id)') && block.includes('function cmMoreCell(c, id)'));
  assert.ok(!/[`\\]|\$\{/.test(block), 'the new page functions');
  const rowEnd = src.slice(src.indexOf('var rowHtml = cmColIds(v)'), src.indexOf('/* ── Assign the Case Support Officer'));
  assert.ok(rowEnd.includes("if (rowHtml.indexOf('class=\"cm-olink\"') >= 0)") && !/[`\\]|\$\{/.test(rowEnd));
  // the look: the wide table's cells, one line for a date / status / number, wrapped names and text, the long reason clipped
  assert.ok(off.includes('#all-cases-table.cm-wide td.cm-c-more { min-width:96px; }'));
  assert.ok(off.includes('#all-cases-table.cm-wide td.cm-c-mclip { min-width:170px; max-width:260px; white-space:normal; }'));
  assert.ok(off.includes('.cm-num { font-variant-numeric:tabular-nums; font-weight:600; color:var(--navy); }'));
  // paper and the phone keep their rules for an added column: the wide table's cells lose their widths on paper, and the phone's pinned columns are as they were
  const print = off.slice(off.indexOf('@media print {', off.indexOf('@page { size: landscape')));
  assert.ok(print.includes('#all-cases-table.cm-wide #cs-headrow th, #all-cases-table.cm-wide td { position:static !important; box-shadow:none !important; width:auto !important; min-width:0 !important; max-width:none !important; }'));
  assert.ok(off.includes('@media (max-width: 640px) {   /* a phone: the two pinned columns are narrower, so more of the rest shows beside them */'));
});
