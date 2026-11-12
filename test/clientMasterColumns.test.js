'use strict';

// Client Master view tabs: the agreed columns, one column each (team meeting 2026-11-10, item 12; layout chosen 2026-11-12).
//  - the data: each new board column parsed onto the row (empty cells too); the contact details and the portal link
//    leave the service only for the page's own route, after the access filter;
//  - the list engine: a column may belong to some tabs only (generic) — and a list without such a column is unchanged;
//  - the column sets: exact ids and order on Assigning / Deadlines / EE after ITA; All as it was;
//  - sorts, filters and the search (email, phone digits, dependents);
//  - the page code itself (the REAL emitted script): the cells, the portal link, the colspans, the wide-table look.
// All made-up data. Monday is stubbed; nothing leaves the machine.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');
const fs     = require('fs');

const dash      = require('../src/services/dashboardService');
const mondayApi = require('../src/services/mondayApi');
const cmv       = require('../src/services/clientMasterViews');
const S         = require('../src/routes/listSpecs');
const { listCore, listTableUi } = require('../src/routes/listFilters');

const VIEWS = cmv.pageViews();
const V = Object.fromEntries(VIEWS.map((v) => [v.key, v]));
const ALL_IDS = ['caseRef', 'clientName', 'caseType', 'caseStage', 'phase', 'deadline', 'promised', 'health', 'slaRisk', 'officer', 'manager', 'overallReadiness', 'daysElapsed', 'status', 'del'];
const VIEW_IDS = ['caseRef', 'clientName', 'dependents', 'clientEmail', 'clientPhone', 'caseTypeV', 'subType', 'actualDeadline', 'deadlineType', 'internalDeadline', 'phaseV',
  'retainedBy', 'retainerStatus', 'paymentStatus', 'stageV', 'portal', 'officerV', 'managerV', 'qPct', 'docPct'];
const VIEW_LABELS = ['Case Ref', 'Client', 'Dependents', 'Client email', 'Contact number', 'Case type', 'Sub-type', 'Actual deadline', 'Deadline type', 'Internal deadline', 'Phase',
  'Retained by', 'Retainer status', 'Payment status', 'Stage', 'Client portal', 'Support officer', 'Case manager', 'Questionnaire %', 'Documents uploaded %'];
const PORTAL = 'https://portal.example/client/2026-XX-001?token=made-up-token-1';

/* ── the data ── */

const people = (...ids) => JSON.stringify({ personsAndTeams: ids.map((id) => ({ id, kind: 'person' })) });
const FULL_CELLS = [
  { id: 'text_mm0x1zdk', text: ' Spouse: Rita Example; Child: Omar Example ', value: '"x"' },
  { id: 'text_mm0xw6bp', text: 'client.one@example.com', value: '"client.one@example.com"' },
  { id: 'phone_mm33zr0c', text: '14165550134', value: JSON.stringify({ phone: '14165550134', countryShortName: 'CA' }) },
  { id: 'dropdown_mm0x4t91', text: 'Inland', value: JSON.stringify({ ids: [3] }) },
  { id: 'text_mm21gw44', text: 'NOT WANTED: Sub Type Options', value: '"x"' },
  { id: 'multiple_person_mm334yp5', text: 'Staff One, Staff Two', value: people(11, 12) },
  { id: 'color_mm2yh6jd', text: 'PR Signed', value: JSON.stringify({ index: 2 }) },
  { id: 'color_mm6665mc', text: 'NOT WANTED: the other retainer column', value: JSON.stringify({ index: 1 }) },
  { id: 'color_mm0x9fnn', text: 'Paid', value: JSON.stringify({ index: 1 }) },
  { id: 'link_mm2vta5', text: 'Portal - ' + PORTAL, value: JSON.stringify({ url: PORTAL, text: 'Portal' }) },
  { id: 'numeric_mm0x9dea', text: '85', value: '"85"' },
  { id: 'numeric_mm2njqk1', text: '40', value: '"40"' },
];
const item = (id, cells, name) => ({ id: String(id), name: name || 'Client ' + id, created_at: '2026-11-01T00:00:00Z', group: { id: 'g1', title: 'November 2026' }, column_values: cells });

test('the board read asks for the seven new columns, by the ids agreed — and never for "Sub Type Options" or the other retainer column', () => {
  assert.deepEqual([dash.COLS.dependents, dash.COLS.clientEmail, dash.COLS.clientPhone, dash.COLS.caseSubType, dash.COLS.retainedBy, dash.COLS.retainerStatus, dash.COLS.portalLink],
    ['text_mm0x1zdk', 'text_mm0xw6bp', 'phone_mm33zr0c', 'dropdown_mm0x4t91', 'multiple_person_mm334yp5', 'color_mm2yh6jd', 'link_mm2vta5']);
  assert.deepEqual([dash.COLS.caseType, dash.COLS.actualDeadline, dash.COLS.deadlineType, dash.COLS.promisedDate, dash.COLS.phase, dash.COLS.paymentStatus, dash.COLS.qReadiness, dash.COLS.docUploaded],
    ['dropdown_mm0xd1qn', 'date_mm33sj6t', 'color_mm6w7cdd', 'date_mm3t66pa', 'color_mm3tf1ys', 'color_mm0x9fnn', 'numeric_mm0x9dea', 'numeric_mm2njqk1']);
  const ids = Object.values(dash.COLS);
  assert.ok(!ids.includes('text_mm21gw44') && !ids.includes('color_mm6665mc'));
  assert.equal(new Set(ids).size, ids.length, 'no column id twice');
  assert.deepEqual(dash.CONTACT_FIELDS, ['clientEmail', 'clientPhone', 'portalLink']);
});

test('parseItem: each new column lands on the row — text trimmed, people as names, the status label as it is, the phone as the board shows it, the link as its address', () => {
  const r = dash.parseItem(item(1, FULL_CELLS), 0);
  assert.equal(r.dependents, 'Spouse: Rita Example; Child: Omar Example');
  assert.equal(r.clientEmail, 'client.one@example.com');
  assert.equal(r.clientPhone, '14165550134');
  assert.equal(r.caseSubType, 'Inland');
  assert.equal(r.retainedBy, 'Staff One, Staff Two');
  assert.equal(r.retainerStatus, 'PR Signed');
  assert.equal(r.paymentStatus, 'Paid');
  assert.equal(r.portalLink, PORTAL, 'the url in the cell value, never the "label - url" text');
  assert.equal(r.qReadinessPct, 85);
  assert.equal(r.docUploadedPct, 40);
  assert.ok(!JSON.stringify(r).includes('NOT WANTED'), 'the two columns that are not wanted are never read onto the row');
});

test('parseItem: empty cells — \'\' for text, people and statuses (never Monday\'s id-5 label), null for a blank percentage, \'\' for no link', () => {
  const empty = dash.parseItem(item(2, [
    { id: 'text_mm0x1zdk', text: '', value: null }, { id: 'text_mm0xw6bp', text: null, value: null }, { id: 'phone_mm33zr0c', text: '', value: null },
    { id: 'dropdown_mm0x4t91', text: '', value: null }, { id: 'multiple_person_mm334yp5', text: '', value: null },
    { id: 'color_mm2yh6jd', text: 'Not Signed', value: null },   // an empty status cell reads the id-5 label as text: it must show as blank
    { id: 'color_mm0x9fnn', text: 'Not Paid', value: null },
    { id: 'link_mm2vta5', text: '', value: null }, { id: 'numeric_mm0x9dea', text: '', value: null }, { id: 'numeric_mm2njqk1', text: '', value: null },
  ]), 0);
  assert.deepEqual([empty.dependents, empty.clientEmail, empty.clientPhone, empty.caseSubType, empty.retainedBy, empty.retainerStatus, empty.paymentStatus, empty.portalLink],
    ['', '', '', '', '', '', '', '']);
  assert.deepEqual([empty.qReadinessPct, empty.docUploadedPct], [null, null]);
  assert.equal(empty.qReadiness, 0, 'the old number (0 for blank) is still there for the Summary page');
  // a row whose cells were not in the answer at all
  const none = dash.parseItem(item(3, []), 0);
  assert.deepEqual([none.dependents, none.clientEmail, none.clientPhone, none.caseSubType, none.retainedBy, none.retainerStatus, none.portalLink, none.qReadinessPct], ['', '', '', '', '', '', '', null]);
  // a 0% that was typed is a number, not a blank
  assert.equal(dash.parseItem(item(4, [{ id: 'numeric_mm0x9dea', text: '0', value: '"0"' }]), 0).qReadinessPct, 0);
});

test('the portal link: the cell value\'s url; else the cell text when it is a plain web address; anything else (script, spaces, markup, junk JSON) is no link', () => {
  const link = (cv) => dash.parseItem(item(5, [{ id: 'link_mm2vta5', ...cv }]), 0).portalLink;
  assert.equal(link({ text: '', value: JSON.stringify({ url: PORTAL }) }), PORTAL);
  assert.equal(link({ text: PORTAL, value: null }), PORTAL, 'the same fallback as the case cockpit');
  assert.equal(link({ text: PORTAL, value: '{not json' }), PORTAL);
  assert.equal(link({ text: 'Portal - ' + PORTAL, value: null }), '', 'label text is not an address');
  assert.equal(link({ text: '', value: JSON.stringify({ url: 'javascript:alert(1)' }) }), '');
  assert.equal(link({ text: '', value: JSON.stringify({ url: 'https://portal.example/x"><script>' }) }), '');
  assert.equal(link({ text: '', value: JSON.stringify({ url: { a: 1 } }) }), '');
  assert.equal(link({ text: 'ftp://portal.example/x', value: null }), '');
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

test('RBAC and the contact details: only the page\'s own route asks for them; a viewer gets them for the rows they may see and nothing of the others; nothing is logged; no write', async () => {
  const CSO = 'multiple_person_mm0xm710';
  const mine = item(1, FULL_CELLS.concat([{ id: CSO, text: 'Staff Nine', value: people(111) }]), 'Mine Example');
  const theirs = item(2, [
    { id: 'text_mm0xw6bp', text: 'hidden.person@example.com', value: '"x"' }, { id: 'phone_mm33zr0c', text: '19055550199', value: '"x"' },
    { id: 'link_mm2vta5', text: '', value: JSON.stringify({ url: 'https://portal.example/client/2026-XX-002?token=made-up-token-2' }) },
    { id: 'text_mm0x1zdk', text: 'Hidden Dependent', value: '"x"' }, { id: CSO, text: 'Staff Eight', value: people(222) },
  ], 'Theirs Example');
  const board = fakeBoard([mine, theirs]);
  const restoreClock = stub(dash._casesIo.io, 'now', () => Date.parse('2026-11-12T15:00:00Z'));
  const logged = [];
  const restoreLogs = ['log', 'warn', 'error', 'info'].map((k) => stub(console, k, (...a) => { logged.push(a.map(String).join(' ')); }));
  const prev = process.env.CASE_VISIBILITY;
  process.env.CASE_VISIBILITY = 'assigned';
  try {
    dash.invalidateCases(); dash._casesIo.overrides.clear();
    const viewer = { userId: '111', teamIds: [], isAdmin: false };
    const page = await dash.getDashboardStats(viewer, { contact: true });
    assert.deepEqual(page.cases.map((c) => [c.id, c.clientEmail, c.clientPhone, c.portalLink]), [['1', 'client.one@example.com', '14165550134', PORTAL]]);
    const text = JSON.stringify(page);
    for (const hidden of ['hidden.person@example.com', '19055550199', 'made-up-token-2', 'Hidden Dependent', 'Theirs Example']) assert.ok(!text.includes(hidden), hidden + ' never reaches a viewer who may not see the case');
    // every other caller (/api/dashboard/stats, the tests of old) gets the rows without the contact details and the link
    const plain = await dash.getDashboardStats(undefined);
    assert.equal(plain.cases.length, 2);
    for (const c of plain.cases) for (const f of dash.CONTACT_FIELDS) assert.ok(!(f in c), f + ' is not on the row unless asked for');
    assert.ok(!/@example\.com|made-up-token|14165550134/.test(JSON.stringify(plain)));
    assert.equal(plain.cases[0].dependents, 'Spouse: Rita Example; Child: Omar Example', 'the other new columns are plain case facts');
    const admin = await dash.getDashboardStats(undefined, { contact: true });
    assert.deepEqual(admin.cases.map((c) => c.portalLink), [PORTAL, 'https://portal.example/client/2026-XX-002?token=made-up-token-2']);
    // one read of the board served all three (the cache is the RAW rows; the filter and the strip run per call)
    assert.equal(board.calls.filter((q) => /items_page\(limit: 500/.test(q)).length, 1);
    const rowsQ = board.calls.find((q) => /items\(ids: \$ids, limit: 100\)/.test(q));
    for (const id of ['text_mm0x1zdk', 'text_mm0xw6bp', 'phone_mm33zr0c', 'dropdown_mm0x4t91', 'multiple_person_mm334yp5', 'color_mm2yh6jd', 'link_mm2vta5']) assert.ok(rowsQ.includes('"' + id + '"'), id + ' is in the board read');
    assert.ok(!rowsQ.includes('text_mm21gw44') && !rowsQ.includes('color_mm6665mc'));
    assert.ok(board.calls.every((q) => !/mutation/.test(q)), 'no Monday write');
    assert.ok(!/@example\.com|made-up-token|5550134|5550199/.test(logged.join('\n')), 'no email, phone or portal link in the logs');
  } finally {
    if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev;
    restoreLogs.forEach((r) => r()); restoreClock(); board.restore(); dash.invalidateCases();
  }
});

test('the route: /admin/dashboard-stats (the Client Master page) asks for the contact details; /api/dashboard/stats does not; the service and the route log nothing of a row', () => {
  const src = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const page = src.slice(src.indexOf("app.get('/admin/dashboard-stats'"), src.indexOf("app.get('/admin/needs-attention'"));
  assert.match(page, /const viewer = resolveViewer\(req\);\s+if \(!viewer\) \{\s+return res\.status\(401\)/, 'signed-in staff only');
  assert.match(page, /getDashboardStats\(viewer\.scope === 'all' \? undefined : viewer, \{ fresh: req\.query\.fresh === '1', contact: req\.query\.contact === '1' \}\)/);
  const api = src.slice(src.indexOf("app.get('/api/dashboard/stats'"), src.indexOf('function hasAdminKey'));
  assert.match(api, /dashboardService\.getDashboardStats\(\);/);
  const svc = fs.readFileSync(require.resolve('../src/services/dashboardService'), 'utf8');
  for (const line of (svc + page).split('\n').filter((l) => /console\.(log|warn|error|info)/.test(l))) assert.ok(!/portalLink|clientEmail|clientPhone|JSON\.stringify\((c|row|cases|stats)\b/.test(line), line);
});

/* ── the list engine: columns per tab (generic) ── */

test('colsOnTab: a column with `tabs` shows on those tabs only (\'\' = no tab chosen), one without shows everywhere; the order is the list\'s own', () => {
  const on = listCore({}).colsOnTab;
  const cols = [{ id: 'a' }, { id: 'b', tabs: [''] }, { id: 'c', tabs: ['x', 'y'] }, { id: 'd', tabs: [] }, { id: 'e' }];
  const ids = (tab) => on(cols, tab).map((c) => c.id).join('');
  assert.deepEqual([ids(''), ids('x'), ids('y'), ids('z'), ids(undefined), ids(null)], ['abe', 'ace', 'ace', 'ae', 'abe', 'abe']);
  assert.deepEqual(on(null, 'x'), []);
  const plain = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(on(plain, 'anything'), plain, 'no marker: every column on every tab');
});

/* A small page for the engine: the header row, the chips box and the tab box keep what is written into them. */
function enginePage(spec, opts, { store = {} } = {}) {
  const kept = new Map(Object.entries(store));
  const el = (o) => ({ innerHTML: '', value: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, contains() { return false; }, focus() {}, ...o });
  const els = { [opts.ids.head]: el(), [opts.ids.chips]: el(), [opts.ids.count]: el({ textContent: '' }) };
  if (opts.quick) els[opts.quick.box] = el();
  const drawn = [];
  const win = { document: { getElementById: (id) => els[id] || null, createElement: () => el(), body: el(), addEventListener() {}, activeElement: null, documentElement: el(), dispatchEvent() {} },
    sessionStorage: { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => { kept.set(k, String(v)); } }, addEventListener() {}, location: { search: '' }, innerWidth: 1200, innerHeight: 800,
    CustomEvent: function () {}, [opts.render]: (rows, why, st) => { drawn.push(rows.map((r) => r.id).join(',')); } };
  const api = listTableUi(listCore(spec), opts, win);
  const head = () => [...els[opts.ids.head].innerHTML.matchAll(/<th scope="col"[^>]*>(?:<div class="th-in">)?(?:<button[^>]*class="th-l th-sortbtn"[^>]*>|<span class="th-l">)?([^<]*)/g)].map((m) => m[1]);
  const chips = () => [...els[opts.ids.chips].innerHTML.matchAll(/<span class="q-chip[^"]*">([^<]*)</g)].map((m) => m[1]);
  return { api, els, kept, drawn, head, chips, tab(v) { if (v) api.state().sel[opts.quick.facet] = [v]; else delete api.state().sel[opts.quick.facet]; api.apply('filter'); } };
}
const casesSpec = () => S.casesListSpec({ healthOrder: { Red: 0, Orange: 1, Green: 2 }, views: VIEWS });
const casesOpts = () => S.casesListOpts({ views: VIEWS });

test('the column sets: exactly the agreed twenty, in order, on Assigning, Deadlines and EE after ITA; All keeps its fifteen', () => {
  const on = listCore({}).colsOnTab, cols = casesOpts().cols;
  assert.deepEqual(on(cols, '').map((c) => c.id), ALL_IDS);
  assert.deepEqual(on(cols, '').map((c) => c.label), ['Case Ref', 'Client', 'Type', 'Stage', 'Phase', 'Deadline', 'Promised', 'Health', 'SLA Risk', 'Support Officer', 'Manager', 'Readiness', 'Days', 'Status', '']);
  for (const key of ['assigning', 'deadlines', 'eeita']) {
    assert.deepEqual(on(cols, key).map((c) => c.id), VIEW_IDS, key);
    assert.deepEqual(on(cols, key).map((c) => c.label), VIEW_LABELS, key);
  }
  assert.deepEqual(VIEWS.map((v) => v.key), ['assigning', 'deadlines', 'eeita'], 'every view tab is covered above');
  assert.equal(new Set(cols.map((c) => c.id)).size, cols.length, 'a column id is never used twice');
  // every column is on a tab; only Case Ref and Client are on all of them
  assert.deepEqual(cols.filter((c) => !c.tabs).map((c) => c.id), ['caseRef', 'clientName']);
  // without the views (a page that has none) the list is the All tab's, as before
  assert.deepEqual(on(S.casesListOpts({}).cols, '').map((c) => c.id), ALL_IDS);
});

test('the header follows the tab on view: All draws its fifteen names, a view tab the agreed twenty — and back', () => {
  const p = enginePage(casesSpec(), casesOpts());
  p.api.setRows([{ id: '1', views: ['assigning'] }, { id: '2', views: [] }]);
  assert.deepEqual(p.head(), ['Case Ref', 'Client', 'Type', 'Stage', 'Phase', 'Deadline', 'Promised', 'Health', 'SLA Risk', 'Support Officer', 'Manager', 'Readiness', 'Days', 'Status', '']);
  p.tab('assigning');
  assert.deepEqual(p.head(), VIEW_LABELS);
  assert.equal(p.drawn[p.drawn.length - 1], '1');
  // a funnel only where the tab's column has a filter: Health's is gone, Retainer status has one
  const h = p.els['cs-headrow'].innerHTML;
  assert.ok(!h.includes('data-col="health"') && h.includes('data-col="retainerStatus"') && h.includes('data-col="stageV"') && !h.includes('data-col="caseStage"'));
  assert.ok(!h.includes('data-col="portal"') && !h.includes('data-sortcol="portal"'), 'Client portal neither sorts nor filters');
  p.tab('deadlines'); assert.deepEqual(p.head(), VIEW_LABELS);
  p.tab(''); assert.equal(p.head().length, 15);
  assert.ok(p.els['cs-headrow'].innerHTML.includes('data-col="health"'));
});

test('a kept filter on a column that is not on the tab on view stays on AND stays visible: its chip is above the table, × takes it off; "Clear filters" too', () => {
  const p = enginePage(casesSpec(), casesOpts());
  p.api.setRows([{ id: '1', views: ['assigning'], health: 'Red', retainerStatus: 'PR Signed' }, { id: '2', views: ['assigning'], health: 'Green', retainerStatus: 'ITA' }, { id: '3', views: [], health: 'Red' }]);
  p.api.state().sel.health = ['Red']; p.api.apply('filter');           // chosen on All (the Health column)
  assert.deepEqual(p.chips(), ['Health: Red']);
  p.tab('assigning');                                                   // Health is not a column here
  assert.ok(!p.head().includes('Health'));
  assert.equal(p.drawn[p.drawn.length - 1], '1', 'the filter still narrows the list …');
  assert.deepEqual(p.chips(), ['Health: Red'], '… and is never invisible: the chip says so');
  assert.ok(p.els['cs-chips'].innerHTML.includes('data-chip="health" aria-label="Remove filter: Health: Red"') && p.els['cs-chips'].innerHTML.includes('data-clearall="1"'));
  assert.notEqual(p.els['cs-chips'].style.display, 'none');
  // the other way round: a view tab's filter, seen from All
  p.api.core.clearKey(p.api.state(), 'health'); p.api.state().sel.retainerStatus = ['ITA']; p.api.apply('filter');
  assert.equal(p.drawn[p.drawn.length - 1], '2');
  p.tab('');
  assert.deepEqual(p.chips(), ['Retainer status: ITA']);
  assert.equal(p.drawn[p.drawn.length - 1], '2');
  p.api.clearFilters();
  assert.deepEqual(p.chips(), []);
  assert.equal(p.drawn[p.drawn.length - 1], '1,2,3');
  // every facet a column of ANY tab can set makes a chip (so no filter can ever be on without one)
  const LT = listCore(casesSpec());
  for (const c of casesOpts().cols) for (const f of c.facets || []) {
    const st = LT.emptyState(); st.sel[f] = ['x'];
    assert.equal(LT.chips(st).length, 1, f);
  }
});

test('a kept sort on a column that is not on the tab on view still sorts and still shows its "Sorted" chip (× goes back to the normal order); a shared sort takes the name of the column on view', () => {
  const p = enginePage(casesSpec(), casesOpts());
  p.api.setRows([{ id: 'g', views: ['assigning'], health: 'Green', actualDeadline: '2026-12-01' }, { id: 'r', views: ['assigning'], health: 'Red', actualDeadline: '2026-12-20' }]);
  p.api.state().sort = { key: 'health', dir: 'asc' }; p.api.apply('sort');
  assert.deepEqual(p.chips(), ['Sorted: Health (Red first)']);
  p.tab('assigning');
  assert.equal(p.drawn[p.drawn.length - 1], 'r,g');
  assert.deepEqual(p.chips(), ['Sorted: Health (Red first)'], 'the column is not here, the chip is');
  assert.ok(p.els['cs-chips'].innerHTML.includes('data-sortreset="1" aria-label="Back to the normal order: Monday\'s order for this view"'));
  assert.ok(!p.els['cs-chips'].innerHTML.includes('data-clearall'), 'a sort alone is not a filter: no "Clear filters"');
  // Actual Deadline sorts under both column sets: "Deadline" on All, "Actual deadline" on a view tab
  p.api.state().sort = { key: 'actualDeadline', dir: 'asc' }; p.api.apply('sort');
  assert.deepEqual(p.chips(), ['Sorted: Actual deadline (Soonest first)']);
  assert.ok(p.els['cs-headrow'].innerHTML.includes('aria-sort="ascending"'));
  p.tab('');
  assert.deepEqual(p.chips(), ['Sorted: Deadline (Soonest first)']);
  // a view tab's own sort, seen from All
  p.api.state().sort = { key: 'qPct', dir: 'desc' }; p.api.apply('sort');
  assert.deepEqual(p.chips(), ['Sorted: Questionnaire % (Highest first)']);
  assert.ok(!p.els['cs-headrow'].innerHTML.includes('aria-sort="descending"'), 'no header on All claims the sort');
});

test('a list WITHOUT the marker is unchanged: Leads, Consultations and Retainers have no column with `tabs`, and their header is every column on every tab', () => {
  const leads = require('../src/routes/leadsTableFilters');
  const lists = [['leads', leads.leadsTableSpec || leads.leadsListSpec, leads.leadsTableOpts, {}],
    ['consultations', S.consultListSpec, S.consultListOpts, { today: () => '2026-11-12' }],
    ['retainers', S.retainerListSpec, S.retainerListOpts, { outcomes: ['Retain', 'Follow-Up', 'Newsletter', 'Not Wanted', 'Retained'], apart: ['Retained'], today: () => '2026-11-12' }]];
  for (const [name, specFn, optsFn, ctx] of lists) {
    const opts = optsFn(ctx);
    assert.ok(opts.cols.every((c) => !('tabs' in c)), name + ': no column says which tabs it is on');
    assert.ok(!('pickCols' in opts), name + ': no chosen columns either (the Client Master page only)');
    if (typeof specFn !== 'function') continue;
    const p = enginePage(specFn(ctx), opts);
    p.api.setRows([]);
    const first = p.head();
    assert.equal(first.length, opts.cols.length, name + ': every column is drawn');
    if (opts.quick) for (const v of opts.quick.values.concat([''])) { p.tab(v); assert.deepEqual(p.head(), first, name + ' on tab ' + (v || 'All')); }
  }
  // the engine's own text: the per-tab code is behind the marker
  const ui = listTableUi.toString();
  assert.ok(ui.includes('var TABBED = COLS.some(function (c) { return !!c.tabs; });') && ui.includes('var PICKS = !!o.pickCols;') && ui.includes('if (!TABBED && !PICKS) return COLS;'));
});

/* ── sorts, filters and the search of the new columns ── */

const META = { stageOrder: [0, 1, 7, 2, 12, 16], phaseOrder: [1, 0, 4, 6, 7] };
const LTm = () => listCore(S.casesListSpec({ healthOrder: {}, views: VIEWS, meta: () => META }));
const order = (LT, rows, key, dir) => LT.sortRows(rows, { key, dir }).map((r) => r.id).join('');

test('the new columns sort: text A → Z, percentages by number, Real before Imaginary, Stage and Phase in the board\'s label order — blanks last BOTH ways', () => {
  const LT = LTm();
  const txt = (f) => [{ id: 'n', [f]: '' }, { id: 'b', [f]: 'beta' }, { id: 'a', [f]: 'Alpha' }, { id: 'c', [f]: 'charlie' }];
  for (const [key, field] of [['dependents', 'dependents'], ['clientEmail', 'clientEmail'], ['subType', 'caseSubType'], ['retainedBy', 'retainedBy'], ['retainerStatus', 'retainerStatus'], ['paymentStatus', 'paymentStatus']]) {
    assert.equal(order(LT, txt(field), key, 'asc'), 'abcn', key + ' A → Z');
    assert.equal(order(LT, txt(field), key, 'desc'), 'cban', key + ' Z → A, blanks still last');
  }
  // case type and manager: the "nothing there" words count as blank
  assert.equal(order(LT, [{ id: 'u', caseType: 'Unknown' }, { id: 'v', caseType: 'Visitor Visa' }, { id: 'e', caseType: 'Express Entry' }], 'caseTypeV', 'asc'), 'evu');
  assert.equal(order(LT, [{ id: 'u', manager: 'Unassigned' }, { id: 'z', manager: 'Zed' }, { id: 'a', manager: 'Abe' }], 'managerV', 'desc'), 'zau');
  // phone: by its digits
  assert.equal(order(LT, [{ id: 'n', clientPhone: '' }, { id: '9', clientPhone: '+1 (905) 555-0100' }, { id: '4', clientPhone: '14165550134' }], 'clientPhone', 'asc'), '49n');
  // percentages: numbers (9 before 85 before 100), a typed 0 is not a blank, blanks last both ways
  const pc = [{ id: 'n', qReadinessPct: null, docUploadedPct: null }, { id: 'h', qReadinessPct: 100, docUploadedPct: 9 }, { id: 'z', qReadinessPct: 0, docUploadedPct: 85 }, { id: 'm', qReadinessPct: 85, docUploadedPct: 100 }, { id: 'l', qReadinessPct: 9, docUploadedPct: 0 }];
  assert.equal(order(LT, pc, 'qPct', 'desc'), 'hmlzn');
  assert.equal(order(LT, pc, 'qPct', 'asc'), 'zlmhn');
  assert.equal(order(LT, pc, 'docPct', 'desc'), 'mzhln');
  // deadline type: Real, Imaginary, then not recorded
  const dt = [{ id: 'n', deadlineType: '' }, { id: 'i', deadlineType: 'Imaginary' }, { id: 'r', deadlineType: 'Deadline' }];
  assert.equal(order(LT, dt, 'deadlineType', 'asc'), 'rin');
  assert.equal(order(LT, dt, 'deadlineType', 'desc'), 'irn');
  // Stage: the board's label order (Submission Ready above Stuck, ADR last) — not A → Z; an empty stage (index 5) last
  const stg = [{ id: 'A', stageIdx: 16, caseStage: 'ADR' }, { id: 'S', stageIdx: 2, caseStage: 'Stuck' }, { id: 'R', stageIdx: 7, caseStage: 'Submission Ready' }, { id: '-', stageIdx: 5, caseStage: 'Unknown' },
    { id: 'D', stageIdx: 0, caseStage: 'Document Collection Started' }, { id: 'N', stageIdx: 19, caseStage: 'A label added since the read' }];
  assert.equal(order(LT, stg, 'stageBoard', 'asc'), 'DRSAN-', 'a label the board read does not know comes after the known ones');
  assert.equal(order(LT, stg, 'stageBoard', 'desc'), 'NASRD-');
  // Phase: Phase 7 (index 1) before Phase 8 (index 0), then Profile, Phase 11, N/A — the board's order
  const ph = [{ id: 'P', phaseIdx: 4, phase: 'Profile' }, { id: '11', phaseIdx: 6, phase: 'Phase 11' }, { id: '8', phaseIdx: 0, phase: 'Phase 8' }, { id: '-', phaseIdx: 5, phase: '' }, { id: '7', phaseIdx: 1, phase: 'Phase 7' }];
  assert.equal(order(LT, ph, 'phaseBoard', 'asc'), '78P11-');
  // the board order is not on the page (the meta read failed): A → Z, the numbers as numbers
  const noMeta = listCore(S.casesListSpec({ healthOrder: {}, views: VIEWS }));
  assert.equal(order(noMeta, stg, 'stageBoard', 'asc'), 'NADSR-');
  assert.equal(order(noMeta, ph, 'phaseBoard', 'asc'), '7811P-');
  assert.equal(order(listCore(S.casesListSpec({ meta: () => null })), ph, 'phaseBoard', 'asc'), '7811P-');
  // every sorting column of a view tab names a sort the spec has, with words for both ways
  const spec = casesSpec();
  for (const c of listCore({}).colsOnTab(casesOpts().cols, 'assigning')) {
    if (c.id === 'portal') { assert.equal(c.sort, undefined); continue; }
    assert.equal(typeof spec.sorts[c.sort], 'function', c.id + ' sorts');
    assert.ok(c.sortText.length === 2 && c.sortDirs.length === 2 && c.sortText.every(Boolean), c.id);
    assert.ok(spec.sortBlanksLast.includes(c.sort) || ['caseRef', 'clientName'].includes(c.sort), c.id + ': blanks last');
  }
  assert.deepEqual(['qPct', 'docPct'].map((id) => casesOpts().cols.find((c) => c.id === id).sortDirs[0]), ['desc', 'desc'], 'a percentage opens highest first');
});

test('the label-like columns filter: Sub-type, Deadline type, Phase, Retained by, Retainer status, Payment status, Support officer, Case manager, Stage and Case type — counts, blanks as their own choice, names one by one', () => {
  const LT = LTm(), cols = listCore({}).colsOnTab(casesOpts().cols, 'deadlines');
  assert.deepEqual(cols.filter((c) => c.facets).map((c) => [c.id, c.facets.join()]), [['caseTypeV', 'caseType'], ['subType', 'subType'], ['deadlineType', 'deadlineType'], ['phaseV', 'phase'],
    ['retainedBy', 'retainedBy'], ['retainerStatus', 'retainerStatus'], ['paymentStatus', 'paymentStatus'], ['stageV', 'stage'], ['officerV', 'officer'], ['managerV', 'manager']]);
  const rows = [
    { id: '1', caseType: 'Express Entry', caseSubType: 'Inland', deadlineType: 'Deadline', phase: 'Phase 8', retainedBy: 'Staff One, Staff Two', retainerStatus: 'PR Signed', paymentStatus: 'Paid', officer: 'Ann Lee, Bo Chan', manager: 'Gia', caseStage: 'Stuck' },
    { id: '2', caseType: 'Unknown', caseSubType: '', deadlineType: 'Imaginary', phase: 'Phase 11', retainedBy: 'Staff Two', retainerStatus: 'Hold for Now', paymentStatus: '', officer: '', manager: 'Unassigned', caseStage: 'Internal Review' },
    { id: '3', caseType: 'Express Entry', caseSubType: 'Outland', deadlineType: '', phase: '', retainedBy: '', retainerStatus: '', paymentStatus: 'Not Paid', officer: 'Ann Lee', manager: 'Gia, Mo', caseStage: 'Stuck' },
  ];
  const list = (f) => LT.facetCounts(rows, LT.emptyState(), f).map((x) => x.label + ' ' + x.count);
  assert.deepEqual(list('caseType'), ['Express Entry 2', 'No case type 1']);
  assert.deepEqual(list('subType'), ['Inland 1', 'Outland 1', 'No sub-type 1']);
  assert.deepEqual(list('deadlineType'), ['Real 1', 'Imaginary 1', 'Not recorded 1'], 'always the three, in this order');
  assert.deepEqual(list('phase'), ['Phase 8 1', 'Phase 11 1', 'No phase 1'], 'Phase 8 before Phase 11');
  assert.deepEqual(list('retainedBy'), ['Staff One 1', 'Staff Two 2', 'Nobody 1'], 'each person is a choice of their own');
  assert.deepEqual(list('retainerStatus'), ['Hold for Now 1', 'PR Signed 1', 'Not set 1'], 'the board\'s label text as it is');
  assert.deepEqual(list('paymentStatus'), ['Not Paid 1', 'Paid 1', 'Not set 1']);
  assert.deepEqual(list('officer'), ['Ann Lee 2', 'Bo Chan 1', 'Nobody 1']);
  assert.deepEqual(list('manager'), ['Gia 2', 'Mo 1', 'Unassigned 1']);
  const pick = (f, v) => { const st = LT.emptyState(); st.sel[f] = [v]; return LT.filterRows(rows, st).map((r) => r.id).join(''); };
  assert.equal(pick('retainedBy', 'Staff Two'), '12');
  assert.equal(pick('retainedBy', 'Staff'), '', 'whole names only');
  assert.equal(pick('officer', LT.NONE), '2');
  assert.equal(pick('deadlineType', 'none'), '3');
  assert.equal(pick('deadlineType', 'real'), '1');
  assert.equal(pick('retainerStatus', 'Hold for Now'), '2');
  assert.equal(pick('paymentStatus', LT.NONE), '2');
  assert.equal(pick('subType', LT.NONE), '2');
  assert.equal(pick('caseType', LT.NONE), '2');
  // the chips name the column as the header does
  const st = LT.emptyState(); st.sel.deadlineType = ['real', 'none']; st.sel.retainedBy = [LT.NONE];
  assert.deepEqual(LT.chips(st).map((c) => c.text), ['Deadline type: Real, Not recorded', 'Retained by: Nobody']);
  // the page hands the engine its own Real / Imaginary reading (clientMasterWindows.typeOf)
  const viaPage = listCore(S.casesListSpec({ typeOf: () => 'imaginary' }));
  assert.deepEqual(viaPage.valuesOf('deadlineType', { deadlineType: 'Deadline' }), ['imaginary']);
});

test('the natural order of a filter list is a facet\'s own choice: only a facet that asks for it gets it (the other lists\' panels are as they were)', () => {
  const rows = [{ p: 'Phase 11' }, { p: 'Phase 8' }, { p: 'Phase 9' }];
  const labels = (natural) => listCore({ facets: { p: { label: 'P', get: (r) => r.p, natural } } }).facetCounts(rows, { sel: {} }, 'p').map((x) => x.label);
  assert.deepEqual(labels(true), ['Phase 8', 'Phase 9', 'Phase 11']);
  assert.deepEqual(labels(undefined), ['Phase 11', 'Phase 8', 'Phase 9'], 'as before');
  const all = [S.consultListSpec({}), S.retainerListSpec({ outcomes: [] }), require('../src/routes/leadsTableFilters')].map((x) => JSON.stringify(Object.values((x && x.facets) || {}).map((f) => f.natural)));
  assert.ok(all.every((t) => !/true/.test(t)));
});

test('the search box finds a case by client email, by phone digits however the number is typed, and by dependents — on top of what it found before', () => {
  const LT = LTm();
  const rows = [
    { id: '1', clientName: 'Asha Example', caseRef: '2026-EE-101', caseType: 'Express Entry', officer: 'Ann Lee', clientEmail: 'Asha.Example@Mail.example', clientPhone: '14165550134', dependents: 'Spouse: Rita Example' },
    { id: '2', clientName: 'Bo Sample', caseRef: '2026-SP-416', caseType: 'Study Permit', officer: 'Bo Chan', clientEmail: 'bo@other.example', clientPhone: '+1 (905) 555-0199', dependents: '' },
    { id: '3', clientName: 'Chen Person', caseRef: '', caseType: 'Visitor Visa', officer: '', clientEmail: '', clientPhone: '', dependents: 'Inviter: Omar Host' },
  ];
  const find = (q) => { const st = LT.emptyState(); st.q = q; return LT.filterRows(rows, st).map((r) => r.id).join(''); };
  assert.equal(find('asha.example@mail'), '1', 'email, any case');
  assert.equal(find('@other.example'), '2');
  assert.equal(find('rita'), '1', 'a dependent');
  assert.equal(find('omar host'), '3');
  assert.equal(find('4165550134'), '1', 'the digits as the board keeps them');
  assert.equal(find('(416) 555-0134'), '1', 'the number as a person types it');
  assert.equal(find('416-555-0134'), '1');
  assert.equal(find('+1 905 555 0199'), '2', 'spaces and a plus against brackets and dashes on the board');
  assert.equal(find('905.555.0199'), '2');
  assert.equal(find('555'), '12', 'three digits are enough');
  assert.equal(find('416'), '12', 'a phone AND a case reference with those digits');
  assert.equal(find('5-5'), '', 'two digits are not a phone search (and no text reads so)');
  assert.equal(find('(555) 01'), '12', 'five digits, written with brackets');
  assert.equal(find('0134 asha'), '', 'words and digits together are a text search, as before');
  // what it found before, unchanged
  assert.equal(find('bo chan'), '2'); assert.equal(find('2026-ee'), '1'); assert.equal(find('visitor'), '3'); assert.equal(find('chen'), '3');
  // the chip says what was searched for
  assert.deepEqual(LT.chips({ q: '(416) 555-0134', sel: {} }).map((c) => c.text), ['Search “(416) 555-0134”']);
  // a list whose search has no phone digits (every other list) is not touched by a phone-shaped search
  const plain = listCore({ search: { text: (r) => r.name } });
  assert.equal(plain.filterRows([{ name: 'A 4165550134' }, { name: 'B' }], { q: '(416) 555-0134', sel: {} }).length, 0);
  assert.equal(plain.filterRows([{ name: 'A 4165550134' }, { name: 'B' }], { q: '4165550134', sel: {} }).length, 1);
});

/* ── the page code itself (the real emitted script) ── */

const router = require('../src/routes/adminDashboard');
function renderRoute(path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
}
function inlineScripts(html) { return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]); }
function fnSrc(script, name) {
  const i = script.indexOf('\nfunction ' + name + '(');
  assert.ok(i >= 0, name + ' is in the page');
  const line = script.slice(i + 1, script.indexOf('\n', i + 1));
  return /\}\s*$/.test(line) ? line : script.slice(i + 1, script.indexOf('\n}\n', i) + 2);
}
const PRE = cmv.PRE_ONBOARDING_INDEX;
async function rowPage({ admin = false } = {}) {
  const html = await renderRoute('/');
  const scripts = inlineScripts(html);
  for (const s of scripts) new vm.Script(s);   // every emitted script parses
  const main = scripts.find((s) => s.includes('function caseRow('));
  const made = [];
  const el = () => { const e = { innerHTML: '', style: {}, className: '', title: '', onclick: null, links: [], querySelector(sel) { if (sel === '.cm-portal' && this.innerHTML.includes('class="cm-portal"')) { const a = { onclick: null }; this.links.push(a); return a; } return null; } }; made.push(e); return e; };
  const ctx = { window: { TDOT_IS_ADMIN: admin }, document: { createElement: el, getElementById: () => null }, Date, isNaN, isFinite, String, Math,
    CM_FLASH: {}, CM_DL_FLASH: {}, TDOT_DEL_SVG: '[bin]', CM_PRE_ONBOARDING: PRE, _data: null, CM_TABCOLS: JSON.parse(main.match(/var CM_TABCOLS = (.*);/)[1]) };
  vm.createContext(ctx);
  const names = ['caseRow', 'cmColIds', 'cmTextCell', 'cmPctCell', 'cmPortalCell', 'escHtml', 'healthBadge', 'shortType', 'cmNoneDash', 'cmDay', 'cmFlashText', 'cmDlFlashText'];
  vm.runInContext(main.match(/var CMW = \(function clientMasterWindows[\s\S]*?\)\(CMW\);/)[0] + '\n' + names.map((n) => fnSrc(main, n)).join('\n'), ctx);
  const cells = (tr) => tr.innerHTML.split('</td>').slice(0, -1).map((c) => c + '</td>');
  return { html, main, ctx, cells, row: (c, v, today) => ctx.caseRow(c, v === undefined ? null : v, today || '2026-11-12') };
}
const FULL = { id: '9', caseRef: '2026-XX-001', clientName: 'Test Person', caseType: 'Express Entry — Canadian Experience Class', caseSubType: 'Inland', caseStage: 'Internal Review', stageIdx: 1, health: 'Green', slaRisk: 'Green',
  phase: 'Phase 11', phaseIdx: 6, deadlineType: 'Deadline', actualDeadline: '2026-11-20', promisedDate: '2026-11-18', officer: 'Ann Lee', manager: 'Gia Manager', overallReadiness: 60, daysElapsed: 12,
  dependents: 'Spouse: Rita Example; Child: Omar Example', clientEmail: 'client.one@example.com', clientPhone: '14165550134', retainedBy: 'Staff One, Staff Two', retainerStatus: 'PR Signed', paymentStatus: 'Paid',
  portalLink: PORTAL, qReadinessPct: 85, docUploadedPct: 40 };
const DASH = '<span style="color:var(--light)">—</span>';
const text = (td) => td.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('the page: CM_TABCOLS is the engine\'s own column sets; a view-tab row has exactly the twenty cells in the agreed order, each with its value', async () => {
  const p = await rowPage();
  assert.deepEqual(p.ctx.CM_TABCOLS, { '': ALL_IDS, assigning: VIEW_IDS, deadlines: VIEW_IDS, eeita: VIEW_IDS });
  for (const v of [V.assigning, V.deadlines, V.eeita]) {
    const tds = p.cells(p.row(FULL, v));
    assert.equal(tds.length, 20, v.key);
    assert.deepEqual(tds.map((td) => td.match(/^<td class="([^" ]+)/)[1]), ['cm-pin', 'cm-pin', 'cm-c-dep', 'cm-c-email', 'cm-c-phone', 'cm-c-type', 'cm-c-sub', 'cm-dl', 'cm-c-dt', 'cm-pr', 'cm-c-phase',
      'cm-c-ret', 'cm-c-rs', 'cm-c-pay', 'cm-c-stage', 'cm-c-portal', 'cm-off', 'cm-c-mgr', 'cm-c-q', 'cm-c-doc'], v.key);
    const t = tds.map(text);
    assert.deepEqual([t[0], t[1], t[2], t[3], t[4], t[5], t[6]], ['2026-XX-001', 'Test Person', 'Spouse: Rita Example; Child: Omar Example', 'client.one@example.com', '14165550134', 'Express Entry — Canadian Experience Class', 'Inland']);
    assert.ok(t[7].startsWith('Nov 20, 2026 Nov 16') || /^Nov 20, 2026 \S/.test(t[7]), 'the Actual deadline with its half-month window: ' + t[7]);
    assert.equal(t[8], 'Real');
    assert.ok(t[9].startsWith('Nov 18, 2026'), t[9]);
    assert.deepEqual([t[10], t[11], t[12], t[13], t[14], t[15], t[17], t[18], t[19]], ['Phase 11', 'Staff One, Staff Two', 'PR Signed', 'Paid', 'Internal Review', 'Open', 'Gia Manager', '85%', '40%']);
    assert.ok(t[16].startsWith('Ann Lee'));
    assert.ok(!/Health|SLA|badge green|readiness-bar|cm-del|del-btn/.test(tds.join('')), 'nothing beyond the agreed list');
  }
  // payment status: the label only — no date anywhere in the cell
  assert.equal(p.cells(p.row({ ...FULL, paymentStatus: 'Paid', paidAt: '2026-11-01' }, V.assigning))[13], '<td class="cm-c-pay">Paid</td>');
});

test('the page: blanks show "—" in every one of the new cells; a blank percentage is never a made-up 0%; a typed 0 shows 0%', async () => {
  const p = await rowPage();
  const blank = { id: '8', caseRef: '2026-XX-002', clientName: 'Blank Person', caseType: 'Unknown', caseStage: 'Unknown', stageIdx: 5, health: 'Green', slaRisk: 'Green', manager: 'Unassigned', officer: '',
    dependents: '', clientEmail: '', clientPhone: '', caseSubType: '', phase: '', deadlineType: '', actualDeadline: '', promisedDate: '', retainedBy: '', retainerStatus: '', paymentStatus: '', portalLink: '', qReadinessPct: null, docUploadedPct: null };
  const tds = p.cells(p.row(blank, V.eeita));
  for (const i of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19]) assert.ok(tds[i].endsWith('>' + DASH + '</td>'), i + ': ' + tds[i]);
  assert.ok(tds[16].includes('Nobody'), 'Support officer keeps its own word for nobody');
  const zero = p.cells(p.row({ ...blank, qReadinessPct: 0, docUploadedPct: 99.6 }, V.eeita));
  assert.deepEqual([text(zero[18]), text(zero[19])], ['0%', '100%']);
  // a row that came without the new fields at all (an older copy of the data) still draws
  const old = p.cells(p.row({ id: '7', caseRef: '2026-XX-003', clientName: 'Old Row', caseType: 'Visitor Visa', caseStage: 'Stuck', stageIdx: 2, health: 'Green', slaRisk: 'Green' }, V.assigning));
  assert.equal(old.length, 20);
  assert.ok(old[15].endsWith(DASH + '</td>') && old[18].endsWith(DASH + '</td>'));
});

test('the page: the Client portal cell is a short "Open" link in a new tab with rel="noopener noreferrer" — the address is escaped, never shown as text, and a click on it does not open the case', async () => {
  const p = await rowPage();
  const tr = p.row(FULL, V.assigning);
  const cell = p.cells(tr)[15];
  assert.equal(cell, '<td class="cm-c-portal"><a class="cm-portal" href="' + PORTAL + '" target="_blank" rel="noopener noreferrer" title="Open this client’s portal in a new tab" aria-label="Open the client portal of Test Person in a new tab">Open</a></td>');
  assert.equal(tr.innerHTML.split(PORTAL).length, 2, 'the address is in the page once: as the link\'s target');
  assert.equal(tr.innerHTML.split('made-up-token').length, 2);
  // the row's own click opens the case; the link's click is stopped before it gets there
  assert.equal(typeof tr.onclick, 'function');
  let stopped = 0;
  assert.equal(tr.links.length, 1);
  tr.links[0].onclick({ stopPropagation() { stopped++; } });
  assert.equal(stopped, 1);
  // escaped: an address with characters that could break out of the attribute
  const odd = p.cells(p.row({ ...FULL, portalLink: 'https://portal.example/c?a=1&b="><img src=x>', clientName: 'A "quoted" <b>name</b>' }, V.assigning))[15];
  assert.ok(odd.includes('href="https://portal.example/c?a=1&amp;b=&quot;&gt;&lt;img src=x&gt;"') && !odd.includes('<img') && !odd.includes('<b>'), odd);
  assert.ok(odd.includes('aria-label="Open the client portal of A &quot;quoted&quot; &lt;b&gt;name&lt;/b&gt; in a new tab"'));
  // empty, or anything that is not a web address: "—", no link
  for (const bad of ['', null, undefined, 'javascript:alert(1)', ' data:text/html,x', 'portal.example/client', '//portal.example/x']) {
    const c = p.cells(p.row({ ...FULL, portalLink: bad }, V.deadlines))[15];
    assert.equal(c, '<td class="cm-c-portal">' + DASH + '</td>', String(bad));
  }
  // the All tab has no such cell, and the page never asks for the address itself or writes it to the console
  assert.ok(!p.row(FULL, null).innerHTML.includes('portal'));
  assert.ok(!/fetch\([^)]*portalLink|console\.[a-z]+\([^)]*portalLink|location[^;\n]*portalLink|window\.open/.test(p.main));
  assert.equal(p.main.split('portalLink').length, 3, 'the page touches the link in one place: the cell (once in a comment, once in code)');
});

test('the page: what lived in the old cells still works on its tab — Assign…, the waiting line (Assigning), Change… and the flags (Deadlines), the window chip, the Real / Imaginary pill, REF PENDING, the row tints', async () => {
  const p = await rowPage();
  const c = (o, v) => p.cells(p.row({ ...FULL, ...o }, v));
  // Assign… in Support officer, on every view tab, only where the server allows it
  for (const v of [V.assigning, V.deadlines, V.eeita]) {
    assert.ok(c({ canAssign: true }, v)[16].includes('<button type="button" class="cm-assign" data-assign="9"'), v.key);
    assert.ok(!c({ canAssign: false }, v)[16].includes('cm-assign'));
  }
  // the Pre-Onboarding "waiting for" line: the Stage cell, Assigning only
  const w = { caseStage: 'Pre-Onboarding', stageIdx: PRE, waiting: { code: 'client-sign', also: ['payment'], partPaid: false } };
  assert.ok(c(w, V.assigning)[14].includes('Pre-Onboarding<div class="cm-wait" data-wait="client-sign"') && c(w, V.assigning)[14].includes('Waiting for: <b>client signature</b><span class="cm-wait-n">then payment</span>'));
  assert.ok(!c(w, V.deadlines).join('').includes('cm-wait') && !c(w, V.eeita).join('').includes('cm-wait'));
  // Change… with the Actual deadline: Deadlines only, only with canChangeDeadline
  assert.ok(c({ canChangeDeadline: true }, V.deadlines)[7].includes('<button type="button" class="dlc-btn" data-dl="9"'));
  assert.ok(!c({ canChangeDeadline: false }, V.deadlines)[7].includes('dlc-btn'));
  assert.ok(!c({ canChangeDeadline: true }, V.assigning).join('').includes('dlc-btn') && !c({ canChangeDeadline: true }, V.eeita).join('').includes('dlc-btn'));
  assert.ok(c({ actualDeadline: '', deadlineType: '', promisedDate: '', canChangeDeadline: true }, V.deadlines)[7].startsWith('<td class="cm-dl">' + DASH + ' <button type="button" class="dlc-btn"'), 'no date yet: the dash, and still the offer');
  // the half-month window chip sits with the Actual deadline; the type pill has its own column
  const dl = c({}, V.eeita);
  assert.match(dl[7], /^<td class="cm-dl"><span class="cm-date">Nov 20, 2026<\/span> <span class="cm-win" title="Counted in this half-month window">[^<]+<\/span><\/td>$/);
  assert.equal(dl[8], '<td class="cm-c-dt"><span class="cm-type real" title="Deadline Type: Deadline (a real deadline)">Real</span></td>');
  assert.ok(!dl[7].includes('cm-type'), 'the pill is no longer inside the date cell');
  const im = c({ deadlineType: 'Imaginary' }, V.eeita);
  assert.ok(im[8].includes('<span class="cm-type imag"') && im[7].includes('(by the promised date)'));
  // "May slide" / "Promise passed" with the Internal deadline: Deadlines only
  const late = { deadlineType: 'Imaginary', promisedDate: '2026-11-01', actualDeadline: '' };
  assert.match(c(late, V.deadlines)[9], /^<td class="cm-pr"><span class="cm-date">Nov 1, 2026<\/span> <span class="cm-flag passed" data-flag="passed"/);
  assert.ok(!c(late, V.assigning)[9].includes('cm-flag') && !c(late, V.eeita)[9].includes('cm-flag'));
  const slide = p.cells(p.row({ ...FULL, deadlineType: 'Imaginary', promisedDate: '2026-11-30', actualDeadline: '', docUploadedPct: 10 }, V.deadlines, '2026-11-24'));
  assert.ok(slide[9].includes('data-flag="slide"') || !slide[9].includes('cm-flag'), 'the slide rule is the windows helper\'s own (flagOf); the cell only shows it');
  // REF PENDING and Needs Case Type: the pill in the pinned Case Ref cell
  assert.equal(c({ caseRef: '' }, V.assigning)[0], '<td class="cm-pin cm-pin1"><span class="badge blue">Ref pending</span></td>');
  assert.equal(c({ caseRef: '', caseType: 'Unknown' }, V.assigning)[0], '<td class="cm-pin cm-pin1"><span class="badge orange">Needs Case Type</span></td>');
  // the client's name is whole in the title, cut on screen
  assert.equal(c({ clientName: 'A <b> & Co' }, V.assigning)[1], '<td class="cm-pin cm-pin2" title="A &lt;b&gt; &amp; Co"><span class="cm-ell">A &lt;b&gt; &amp; Co</span></td>');
  // long text: cut to two lines, the whole text in the title; everything escaped
  assert.equal(c({ dependents: 'Spouse: <i>R</i> & "Q"' }, V.assigning)[2], '<td class="cm-c-dep" title="Spouse: &lt;i&gt;R&lt;/i&gt; &amp; &quot;Q&quot;"><span class="cm-clip">Spouse: &lt;i&gt;R&lt;/i&gt; &amp; &quot;Q&quot;</span></td>');
  assert.ok(c({ clientEmail: 'a<b>@example.com' }, V.assigning)[3].includes('title="a&lt;b&gt;@example.com"'));
  // row tints and the way into the case
  assert.equal(p.row({ ...FULL, health: 'Red' }, V.assigning).className, 'row-red');
  assert.equal(p.row({ ...FULL, health: 'Orange' }, V.deadlines).className, 'row-orange');
  assert.equal(p.row(FULL, V.assigning).title, 'Open case cockpit');
});

test('the page: the All tab draws the fifteen cells it always drew — the type pill, date and window in ONE Deadline cell, Health, SLA risk, Readiness, Days, Status and the admin\'s delete', async () => {
  const p = await rowPage({ admin: true });
  const tds = p.cells(p.row({ ...FULL, clientBlocked: true }, null));
  assert.equal(tds.length, 15);
  assert.equal(tds[0], '<td style="font-weight:600;color:var(--navy);white-space:nowrap">2026-XX-001</td>');
  assert.equal(tds[1], '<td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Test Person</td>');
  assert.ok(tds[2].startsWith('<td style="color:var(--muted);font-size:11px">'));
  assert.equal(tds[3], '<td style="font-size:11px">Internal Review</td>');
  assert.equal(tds[4], '<td style="font-size:11px;white-space:nowrap">Phase 11</td>');
  assert.match(tds[5], /^<td class="cm-dl" style="font-size:11px"><span class="cm-type real"[^>]*>Real<\/span> <span class="cm-date">Nov 20, 2026<\/span> <span class="cm-win"/);
  assert.equal(tds[6], '<td class="cm-pr" style="font-size:11px"><span class="cm-date">Nov 18, 2026</span></td>');
  assert.ok(tds[9].startsWith('<td class="cm-off" style="font-size:11px">Ann Lee'));
  assert.equal(tds[10], '<td style="color:var(--muted);font-size:11px">Gia Manager</td>');
  assert.ok(tds[11].includes('<span class="r-bar-pct">60%</span>'));
  assert.equal(tds[12], '<td style="text-align:center;font-weight:600;color:var(--muted)">12</td>');
  assert.ok(tds[13].includes('<span class="badge orange" style="margin-right:3px">Blocked</span>'));
  assert.ok(tds[14].startsWith('<td class="cm-del"><button class="del-btn" type="button" data-del-case="2026-XX-001"'));
  assert.ok(!/cm-pin|cm-c-|client\.one@example\.com|14165550134|Rita|PR Signed/.test(tds.join('')), 'none of the view tabs\' cells, and no contact detail, on All');
});

/* the table drawing (renderViewTable) with the real code: the colspans and the wide-table mark per tab */
async function tablePage() {
  const html = await renderRoute('/');
  const main = inlineScripts(html).find((s) => s.includes('function renderViewTable('));
  const mk = (tag) => { const e = { tag, className: tag === 'table' ? 'data-table' : '', style: {}, kids: [], _html: '', onclick: null, appendChild(c) { this.kids.push(c); }, getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}, focus() {} };
    Object.defineProperty(e, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; this.kids = []; } }); return e; };
  const els = { 'all-cases-body': mk('tbody'), 'cm-head': mk('div'), 'cm-oc': mk('span'), 'all-cases-table': mk('table') };
  // the table's scroll box (.tbl-wrap): its class list, its attributes and its two widths
  const wrap = { cls: new Set(['tbl-wrap']), attrs: {}, scrollWidth: 1000, clientWidth: 1000 };
  wrap.classList = { contains: (c) => wrap.cls.has(c), toggle: (c, on) => { if (on) wrap.cls.add(c); else wrap.cls.delete(c); } };
  wrap.setAttribute = (k, v) => { wrap.attrs[k] = String(v); };
  wrap.removeAttribute = (k) => { delete wrap.attrs[k]; };
  els['all-cases-table'].parentNode = wrap;
  const ctx = vm.createContext({ window: { sessionStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: true }) }, JSON, String, Object, Array,
    document: { getElementById: (id) => els[id] || null, createElement: mk, activeElement: null, querySelectorAll: () => [] },
    CM_VIEWS: VIEWS, CM_PRE_ONBOARDING: PRE, CM_TABCOLS: JSON.parse(main.match(/var CM_TABCOLS = (.*);/)[1]), _data: { meta: null, cases: [] } });
  const names = ['renderCasesList', 'renderViewTable', 'renderCmHead', 'cmKept', 'cmKeptSave', 'cmGroupState', 'cmGroupTone', 'cmViewDef', 'cmView', 'cmInView', 'cmHm', 'cmDataTimeText', 'escHtml', 'cmColIds', 'cmScrollBox'];
  vm.runInContext(main.match(/var CMW = \(function clientMasterWindows[\s\S]*?\)\(CMW\);/)[0] + '\n' + main.match(/var CM_GRP_KEY = [\s\S]*?var CM_LAST = null;[^\n]*/)[0] + '\n' + names.map((n) => fnSrc(main, n)).join('\n') + '\n' +
    'function cmToday() { return "2026-11-12"; }\nfunction stageTone() { return "grey"; }\nfunction caseRow(c, v) { return { className: "", id: c.id, view: v }; }', ctx);
  return { els, wrap, draw(rows, view) { ctx._data.cases = rows; return ctx.renderCasesList(rows, 'filter', { q: '', sel: view ? { view: [view] } : {} }, { total: rows.length, defaultSort: true }); },
    heads: () => els['all-cases-body'].kids.filter((k) => /^cm-grp /.test(k.className)) };
}

test('the page: a group heading and the "no cases" line span the columns of the tab on view — 15 on All, 20 on each view tab — and only a view tab marks the table wide', async () => {
  const p = await tablePage();
  const rows = [{ id: 'a', groupId: 'g1', groupTitle: 'November 2026', boardIdx: 0, stageIdx: 1, caseStage: 'Internal Review', phaseIdx: 6, phase: 'Phase 11', views: ['assigning', 'deadlines', 'eeita'] }];
  p.draw(rows, null);
  assert.ok(p.heads()[0].innerHTML.startsWith('<td colspan="15"><span class="cm-grp-t">'));
  assert.equal(p.els['all-cases-table'].className, 'data-table');
  for (const key of ['assigning', 'deadlines', 'eeita']) {
    p.draw(rows, key);
    assert.equal(p.heads().length, 1, key);
    assert.ok(p.heads()[0].innerHTML.startsWith('<td colspan="20"><span class="cm-grp-t"><button type="button" class="cm-grp-b"'), key + ': the heading keeps its sticky title and its button');
    assert.equal(p.heads()[0].className, 'cm-grp open' + (key === 'assigning' ? ' tone-grey' : ''));
    assert.equal(p.els['all-cases-table'].className, 'data-table cm-wide', key);
    assert.equal(p.els['all-cases-body'].kids[1].view.key, key, 'the rows are drawn as that tab\'s rows');
  }
  // nothing to show: one full-width line, its words kept at the start of the wide table
  p.draw([], 'deadlines');
  const none = p.els['all-cases-body'].kids[0];
  assert.equal(none.className, 'cm-none');
  assert.equal(none.innerHTML, '<td colspan="20"><span class="cm-none-t">No cases in the Deadlines view right now.</span></td>');
  p.draw([], null);
  assert.equal(p.els['all-cases-body'].kids[0].innerHTML, '<td colspan="15"><span class="cm-none-t">No cases match the current filters.</span></td>');
  assert.equal(p.els['all-cases-table'].className, 'data-table', 'back on All: not wide');
});

test('the scroll box: a keyboard region with the pinned columns kept clear on a view tab (with rows or none); a plain box on All unless the table is wider than it', async () => {
  const p = await tablePage();
  const rows = [{ id: 'a', groupId: 'g1', groupTitle: 'November 2026', boardIdx: 0, stageIdx: 1, caseStage: 'Internal Review', phaseIdx: 6, phase: 'Phase 11', views: ['assigning', 'deadlines', 'eeita'] }];
  const REGION = { tabindex: '0', role: 'region', 'aria-label': 'Cases table, scrolls sideways' };
  p.draw(rows, null);
  assert.deepEqual(p.wrap.attrs, {});
  assert.ok(!p.wrap.cls.has('cm-scroll'));
  for (const [r, key] of [[rows, 'assigning'], [rows, 'deadlines'], [[], 'eeita']]) {
    p.draw(r, key);
    assert.deepEqual(p.wrap.attrs, REGION, key);
    assert.ok(p.wrap.cls.has('cm-scroll') && p.wrap.cls.has('tbl-wrap'), key);
  }
  p.draw(rows, null);
  assert.deepEqual(p.wrap.attrs, {}, 'back on All: taken off again');
  assert.ok(!p.wrap.cls.has('cm-scroll'));
  p.wrap.scrollWidth = 1300;   // All on a narrow screen: the table is wider than its box
  p.draw(rows, null);
  assert.deepEqual(p.wrap.attrs, REGION);
  assert.ok(!p.wrap.cls.has('cm-scroll'), 'nothing is pinned on All, so no room is kept');
  p.wrap.scrollWidth = 1000;
  p.draw([], null);
  assert.deepEqual(p.wrap.attrs, {});
});

test('the page: the wide table scrolls inside its own box with Case Ref and Client pinned (header and rows) and an edge shadow; the pinned cells carry the row tints; print un-pins them and keeps the last column', async () => {
  const html = await renderRoute('/');
  // the box scrolls sideways, not the page
  assert.match(html, /<div class="tbl-wrap">\s*<table class="data-table" id="all-cases-table">/);
  assert.ok(html.includes('.tbl-wrap { overflow-x:auto; }') && html.includes('.table-card .tbl-wrap { position:relative; }'));
  assert.ok(html.includes('#all-cases-table.cm-wide { width:max-content; min-width:100%; }'));
  // pinned: the first two header cells and the two row cells, the second starting where the first ends
  assert.ok(html.includes('#all-cases-table.cm-wide #cs-headrow th:nth-child(1), #all-cases-table.cm-wide td.cm-pin1 { position:sticky; left:0; z-index:2; box-sizing:border-box; width:126px; min-width:126px; max-width:126px; }'));
  assert.match(html, /#all-cases-table\.cm-wide #cs-headrow th:nth-child\(2\), #all-cases-table\.cm-wide td\.cm-pin2 \{ position:sticky; left:126px; z-index:2; box-sizing:border-box; width:172px; min-width:172px; max-width:172px; \}/);
  assert.match(html, /#all-cases-table\.cm-wide #cs-headrow th:nth-child\(2\)::after, #all-cases-table\.cm-wide td\.cm-pin2::after \{ content:''; position:absolute; top:0; bottom:0; left:100%; width:9px; pointer-events:none;\s+background:linear-gradient\(to right, rgba\(15,23,42,\.22\)/, 'the edge shadow: a strip just past the Client column, header and rows');
  assert.ok(html.includes('#all-cases-table.cm-wide #cs-headrow th:nth-child(-n+2) { z-index:3; }'), 'the header\'s pinned cells sit above the rows\' pinned cells');
  // a pinned cell is never see-through: white, or the row's tint, or its hover
  for (const rule of ['td.cm-pin { background:#fff; }', 'tr.row-red td.cm-pin { background:#fff8f8; }', 'tr.row-orange td.cm-pin { background:#fffdf5; }', 'tr:hover td.cm-pin { background:#f8faff; }',
    'tr.row-red:hover td.cm-pin { background:#ffeef0; }', 'tr.row-orange:hover td.cm-pin { background:#fff8e6; }']) assert.ok(html.includes('#all-cases-table.cm-wide ' + rule), rule);
  assert.ok(html.includes('.data-table tr.row-red    { background: #fff8f8; }') && html.includes('.data-table tr.row-orange { background: #fffdf5; }'), 'the same tints as the rows');
  // the group headings keep their sticky title and their open / closed look
  assert.ok(html.includes('.cm-grp-t { position:sticky; left:14px; display:inline-block; white-space:nowrap; }') && html.includes('.data-table tr.cm-grp.open td { background:#e2e8f0;'));
  // long text wraps to two lines; a phone gets narrower pinned columns
  assert.ok(html.includes('.cm-clip { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; overflow-wrap:anywhere; }'));
  assert.match(html, /@media \(max-width: 640px\) \{[^}]*\n\s+#all-cases-table\.cm-wide #cs-headrow th:nth-child\(1\), #all-cases-table\.cm-wide td\.cm-pin1 \{ width:100px;/);
  assert.match(html, /td\.cm-pin2 \{ left:100px; width:112px;/);
  // print: landscape, nothing pinned, no shadow, the columns as on screen — and the last column is hidden on All only (there it is the delete column)
  const print = html.slice(html.indexOf('@media print {', html.indexOf('@page { size: landscape')));
  assert.ok(print.includes('#all-cases-table.cm-wide #cs-headrow th, #all-cases-table.cm-wide td { position:static !important; box-shadow:none !important; width:auto !important; min-width:0 !important; max-width:none !important; }'));
  assert.ok(print.includes('#all-cases-table:not(.cm-wide) #cs-headrow th:last-child, #all-cases-table td.cm-del { display:none; }'), 'a view tab\'s last column (Documents uploaded %) prints');
  // … and on All made wide by added columns (2026-11-12, the Columns button): its last column is still the delete column
  assert.ok(print.includes('#all-cases-table.cm-wide-all #cs-headrow th:last-child { display:none; }'));
  assert.ok(!/[^)] #cs-headrow th:last-child/.test(print.replace('#all-cases-table:not(.cm-wide) #cs-headrow th:last-child', '').replace('#all-cases-table.cm-wide-all #cs-headrow th:last-child', '')));
  assert.ok(print.includes('td.cm-pin2::after { display:none; }'), 'no shadow strip on paper');
  assert.ok(print.includes('#all-cases-table.cm-wide { width:100%; min-width:0; font-size:7pt; }') && print.includes('.cm-clip, .cm-ell { display:block; overflow:visible; white-space:normal; }'));
  // the search box says what it finds; the engine gets the board order and the Real / Imaginary reading from the page
  assert.ok(html.includes('placeholder="Search by client, case ref, type, officer, email, phone…"'));
  assert.ok(html.includes('meta: function() { return (_data && _data.meta) || null; }, typeOf: CMW.typeOf }'));
  // the Summary page has no Client Master table and none of its look
  const sum = await renderRoute('/summary');
  assert.ok(!sum.includes('#all-cases-table.cm-wide') && !sum.includes('.cm-portal {') && !sum.includes('id="all-cases-table"'));
});

test('the page-script rule holds for the new code: no backtick, dollar-brace or backslash in the row code or the specs; every emitted script parses', async () => {
  const src = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  const block = src.slice(src.indexOf('/* The columns of a tab, in order'), src.indexOf('/* ── Assign the Case Support Officer'));
  assert.ok(block.length > 4000 && block.includes('function cmPortalCell(c)') && block.includes('function caseRow(c, v, today, wide)') && block.includes('function cmPickCols(cols, tab, all)'));
  assert.ok(!/[`\\]|\$\{/.test(block));
  for (const fn of [S.casesListSpec, S.casesListOpts]) assert.ok(!/[`\\]|\$\{/.test(fn.toString()), fn.name);
  for (const path of ['/', '/summary']) for (const s of inlineScripts(await renderRoute(path))) new vm.Script(s);
});

// ── Review points (2026-11-12): contact details on request only, never kept by the browser, the phone and paper layouts, the scroll box ──
test('the contact details are opt-in: the route passes them only for ?contact=1; the Client Master list asks, the Summary and the quiet waiting re-fetch do not', async () => {
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const route = server.slice(server.indexOf("app.get('/admin/dashboard-stats'"), server.indexOf("app.get('/admin/needs-attention'"));
  assert.ok(route.includes("contact: req.query.contact === '1'") && !/contact: true/.test(route));
  const src = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  // the main load: fresh=1 and contact=1 joined properly, contact=1 never on the Summary
  const load = src.slice(src.indexOf('var qs = [];'), src.indexOf('.then(function(r) {', src.indexOf('var qs = [];')));
  assert.ok(load.includes("if (fresh === true) qs.push('fresh=1');"));
  assert.ok(load.includes("if (VIEW !== 'summary') qs.push('contact=1');"));
  assert.ok(load.includes("fetch('/admin/dashboard-stats' + (qs.length ? '?' + qs.join('&') : ''), { headers: headers, credentials: 'same-origin' })"));
  const url = (fresh, VIEW) => { const qs = []; if (fresh === true) qs.push('fresh=1'); if (VIEW !== 'summary') qs.push('contact=1'); return '/admin/dashboard-stats' + (qs.length ? '?' + qs.join('&') : ''); };
  assert.equal(url(true, 'cases'), '/admin/dashboard-stats?fresh=1&contact=1');
  assert.equal(url(false, 'cases'), '/admin/dashboard-stats?contact=1');
  assert.equal(url(true, 'summary'), '/admin/dashboard-stats?fresh=1');
  assert.equal(url(false, 'summary'), '/admin/dashboard-stats');
  assert.equal((src.match(/contact=1'/g) || []).length, 1, 'asked for in one place only');
  // the quiet re-fetch: the bare address, and only c.waiting is copied onto the rows on screen (their contact details stay)
  const wait = src.slice(src.indexOf('function cmWaitLater()'), src.indexOf('// The shared engine hands over'));
  assert.ok(wait.includes("fetch('/admin/dashboard-stats', {") && !/contact/.test(wait));
  assert.ok(wait.includes('_data.cases.forEach(function(c) { if (c.waiting && byId[String(c.id)]) c.waiting = byId[String(c.id)]; });'));
  assert.ok(!/_data\.cases = |_data = j/.test(wait), 'the rows on screen are never replaced');
  // the service: without the flag the three fields are not on a row (run in the RBAC test above); here, the rule itself
  const svc = fs.readFileSync(require.resolve('../src/services/dashboardService'), 'utf8');
  assert.match(svc, /CONTACT_FIELDS = \[[^\]]*'clientEmail'[^\]]*'clientPhone'[^\]]*'portalLink'/);
});

test('never kept by the browser: /admin/dashboard-stats and /admin/case-data/:caseRef set private, no-store first, before any answer', () => {
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(server, /app\.get\('\/admin\/dashboard-stats', async \(req, res\) => \{\n  res\.set\('Cache-Control', 'private, no-store'\);\n  const viewer = resolveViewer\(req\);/);
  assert.match(server, /app\.get\('\/admin\/case-data\/:caseRef', async \(req, res\) => \{\n  res\.set\('Cache-Control', 'private, no-store'\);[^\n]*\n  const viewer = resolveViewer\(req\);/);
});

test('a phone: the pinned Case Ref shows whole (wraps, same 100px so Client still starts at 100px) and carries its title; paper: whole words; the scroll box is a keyboard region clear of the pinned columns', async () => {
  const html = await renderRoute('/');
  const phoneAt = html.indexOf('@media (max-width: 640px) {   /* a phone');
  const phone = html.slice(phoneAt, html.indexOf('@media (max-width: 760px)', phoneAt));
  assert.ok(phoneAt > 0 && phone.length > 300);
  assert.ok(phone.includes('td.cm-pin1 { width:100px; min-width:100px; max-width:100px;') && phone.includes('td.cm-pin2 { left:100px; width:112px;'));
  assert.ok(phone.includes('#all-cases-table.cm-wide td.cm-pin1 { white-space:normal; overflow-wrap:anywhere; text-overflow:clip; line-height:1.25; }'));
  assert.ok(phone.includes('.table-card .tbl-wrap.cm-scroll { scroll-padding-left:212px; }'), '100 + 112');
  assert.ok(html.includes('.table-card .tbl-wrap.cm-scroll { scroll-padding-left:298px; }'), '126 + 172');
  assert.ok(html.indexOf('scroll-padding-left:298px') < html.indexOf('scroll-padding-left:212px'), 'the phone value comes later, so it wins');
  assert.ok(html.includes('.table-card .tbl-wrap:focus-visible { outline:2px solid var(--navy); outline-offset:-2px; }'));
  const src = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  assert.ok(src.includes(`caseRef: pin ? '<td class="cm-pin cm-pin1"' + (c.caseRef ? ' title="' + escHtml(c.caseRef) + '"' : '') + '>' + refCell + '</td>'`));
  const box = src.slice(src.indexOf('function cmScrollBox(plain)'), src.indexOf('/* Above the table, on a view tab only'));
  assert.ok(box.includes("w.classList.toggle('cm-scroll', !plain);") && box.includes('if (!plain || w.scrollWidth > w.clientWidth + 1) {'));
  assert.ok(box.includes("w.setAttribute('tabindex', '0');") && box.includes("w.setAttribute('role', 'region');") && box.includes("w.setAttribute('aria-label', 'Cases table, scrolls sideways');"));
  assert.ok(box.includes("w.removeAttribute('tabindex');") && box.includes("w.removeAttribute('role');") && box.includes("w.removeAttribute('aria-label');"));
  assert.equal((src.match(/cmScrollBox\(!wide\);/g) || []).length, 2, 'after both ways out of the table drawing');
  // paper
  const print = html.slice(html.indexOf('@media print'));
  assert.ok(print.includes('#all-cases-table.cm-wide td, #all-cases-table.cm-wide tr.cm-grp td { font-size:7pt; white-space:normal; overflow-wrap:break-word; }'));
  assert.ok(print.includes('#all-cases-table.cm-wide .cm-clip { overflow-wrap:break-word; }'));
  const floor = print.indexOf('#all-cases-table.cm-wide td.cm-c-email { min-width:26mm !important; }');
  assert.ok(floor > print.indexOf('min-width:0 !important'), 'the email floor comes after the rule that removes every width');
  assert.ok(print.includes('#all-cases-table th .th-sortbtn { display:contents; }'), 'the repeated header row prints its column names');
});
