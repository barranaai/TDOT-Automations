'use strict';

// Block 3 (Client Master page): the view tabs' group headings, Monday's order, the
// counts above the table, blank dates last, and the page itself (tabs, links, the
// rename, the new address, the page-script rule). Plan sections 2–4, tests 4 and 9.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');
const fs     = require('fs');

const U    = require('../src/routes/clientMasterUi');
const cmv  = require('../src/services/clientMasterViews');
const dash = require('../src/services/dashboardService');
const S    = require('../src/routes/listSpecs');
const { listCore, listTableScript } = require('../src/routes/listFilters');
const META_FIX = require('./fixtures/client-master-board-meta.json');
const CAPTURE  = require('./fixtures/client-master-capture.json');

const V = Object.fromEntries(cmv.pageViews().map((v) => [v.key, v]));
const STAGE = 'color_mm0x8faa', PHASE = 'color_mm3tf1ys';
// the real board meta (no client data), through the service's own parser
const META = dash._casesIo.parseMeta({ groups: META_FIX.groups, columns: [STAGE, PHASE].map((id) => ({ id, settings_str: JSON.stringify(META_FIX.columns[id].settings) })) });

function captureRows() {
  const title = Object.fromEntries(META.groups.map((g) => [g.id, g.title]));
  return CAPTURE.rows.map((r, i) => dash.parseItem({ id: String(i), name: '', created_at: '', group: r.groupId ? { id: r.groupId, title: title[r.groupId] || '' } : null, column_values: r.cells }, i));
}
const titles = (groups) => groups.map((g) => g.title);
const counts = (groups) => groups.map((g) => g.title + ' ' + g.rows.length);

/* ── the page data ── */

test('pageViews: the four tabs in order, with what each groups by, its order and sort — from the view definitions', () => {
  assert.deepEqual(cmv.pageViews().map((v) => [v.key, v.label, v.by, v.dir, v.groupOrder, v.sort && v.sort.field]), [
    ['assigning', 'Assigning', 'stage', 'ASC', 'position', null],
    ['deadlines', 'Deadlines', 'phase', 'ASC', 'position', null],
    ['mahesh', 'Mahesh', 'phase', 'ASC', 'position', 'actualDeadline'],
    ['eeita', 'EE after ITA', 'board', 'ASC', 'position', null],
  ]);
  for (const v of cmv.pageViews()) assert.ok(/^Like Monday's /.test(v.hint) && !/["\\`]/.test(v.hint), v.key + ': a plain tooltip, safe to put in the page');
  assert.equal(cmv.PRE_ONBOARDING_INDEX, 12);
  assert.equal(JSON.parse(JSON.stringify(META_FIX.columns[STAGE].settings.labels))['12'], 'Pre-Onboarding');
});

/* ── test 4: the headings, the order, the counts ── */

test('groupRows on the real capture: the headings and counts per tab (Assigning by Case Stage label position; Deadlines / Mahesh by Phase; EE by board group)', () => {
  const rows = captureRows();
  const g = (key) => U.groupRows(V[key], U.viewOrder(V[key], rows.filter((r) => r.views.includes(key))), META);
  assert.deepEqual(counts(g('assigning')), ['Document Collection Started 22', 'Internal Review 84', 'Submission Ready 2', 'Stuck 9', 'Pre-Onboarding 34', 'ADR 5'],
    'by position: Submission Ready above Stuck, ADR last');
  assert.deepEqual(counts(g('deadlines')), ['Phase 8 11', 'Profile 31', 'Phase 11 66', 'N/A 3'], 'Profile before Phase 11');
  assert.deepEqual(counts(g('mahesh')), ['Phase 8 9', 'Phase 9 4', 'Profile 30', 'Phase 11 66', 'N/A 3']);
  assert.deepEqual(counts(g('eeita')), ['⏳ Pending — signatures & payment 1', 'October 2026 20', 'September  2026 7'], 'Pending first: positions are numbers, not text');
  // the Phase 11 heading: Real 44 · Imaginary 15 · Not recorded 7
  const p11 = g('deadlines').find((x) => x.title === 'Phase 11');
  assert.deepEqual(U.typeCounts(p11.rows), { real: 44, imaginary: 15, none: 7 });
  // Assigning: nobody in Case Support Officer
  assert.deepEqual(U.noOfficerCount(rows.filter((r) => r.views.includes('assigning')), cmv.PRE_ONBOARDING_INDEX), { n: 66, preOnboarding: 34 });
});

test('groupRows: the three heading-order modes tell Assigning apart (position, index, A → Z), and DESC reverses', () => {
  const st = (idx, name) => ({ stageIdx: idx, caseStage: name });
  const rows = [st(16, 'ADR'), st(2, 'Stuck'), st(7, 'Submission Ready'), st(12, 'Pre-Onboarding'), st(1, 'Internal Review'), st(0, 'Document Collection Started')];
  const v = (o) => ({ ...V.assigning, ...o });
  assert.deepEqual(titles(U.groupRows(v({ groupOrder: 'position' }), rows, META)), ['Document Collection Started', 'Internal Review', 'Submission Ready', 'Stuck', 'Pre-Onboarding', 'ADR']);
  assert.deepEqual(titles(U.groupRows(v({ groupOrder: 'index' }), rows, META)), ['Document Collection Started', 'Internal Review', 'Stuck', 'Submission Ready', 'Pre-Onboarding', 'ADR']);
  assert.deepEqual(titles(U.groupRows(v({ groupOrder: 'alpha' }), rows, META)), ['ADR', 'Document Collection Started', 'Internal Review', 'Pre-Onboarding', 'Stuck', 'Submission Ready']);
  assert.deepEqual(titles(U.groupRows(v({ dir: 'DESC' }), rows, META)), ['ADR', 'Pre-Onboarding', 'Stuck', 'Submission Ready', 'Internal Review', 'Document Collection Started']);
  // Phase by position: Profile (4) between Phase 10 and Phase 11 — index order happens to agree for the phases in use
  const ph = (idx, name) => ({ phaseIdx: idx, phase: name });
  const prow = [ph(7, 'N/A'), ph(6, 'Phase 11'), ph(4, 'Profile'), ph(0, 'Phase 8'), ph(1, 'Phase 7'), ph(8, 'Phase 12')];
  assert.deepEqual(titles(U.groupRows(V.deadlines, prow, META)), ['Phase 7', 'Phase 8', 'Profile', 'Phase 11', 'N/A', 'Phase 12']);
});

test('groupRows: board positions are numbers ("32754.0" before "114688.0"), titles come from the rows, unknown keys go LAST and are never dropped, the split is stable', () => {
  const meta = dash._casesIo.parseMeta({ groups: [{ id: 'g_late', title: 'Late', position: '114688.0' }, { id: 'g_early', title: 'Early', position: '32754.0' }], columns: [] });
  assert.deepEqual(meta.groups.map((g) => g.id), ['g_early', 'g_late']);
  const rows = [
    { id: 'a', groupId: 'g_late', groupTitle: 'Late (row title)' }, { id: 'b', groupId: 'g_new', groupTitle: 'Added after the read' },
    { id: 'c', groupId: 'g_early', groupTitle: 'Early' }, { id: 'd', groupId: 'g_late', groupTitle: 'Late (row title)' }, { id: 'e', groupId: 'g_new', groupTitle: 'Added after the read' },
  ];
  const out = U.groupRows(V.eeita, rows, meta);
  assert.deepEqual(out.map((g) => [g.title, g.rows.map((r) => r.id).join('')]), [['Early', 'c'], ['Late (row title)', 'ad'], ['Added after the read', 'be']]);
  // a status label missing from meta (added after the read) goes last, never dropped
  const st = U.groupRows(V.assigning, [{ stageIdx: 19, caseStage: 'New label' }, { stageIdx: 1, caseStage: 'Internal Review' }], META);
  assert.deepEqual(titles(st), ['Internal Review', 'New label']);
  // no meta at all (the meta read failed): status by label index, board groups in the order listed
  assert.deepEqual(titles(U.groupRows(V.assigning, [{ stageIdx: 7, caseStage: 'Submission Ready' }, { stageIdx: 2, caseStage: 'Stuck' }], null)), ['Stuck', 'Submission Ready']);
  assert.deepEqual(titles(U.groupRows(V.eeita, rows, null)), ['Late (row title)', 'Added after the read', 'Early']);
  // a blank title falls back to the board's label, else "—"
  assert.deepEqual(titles(U.groupRows(V.deadlines, [{ phaseIdx: 6, phase: '' }], META)), ['Phase 11']);
  assert.deepEqual(titles(U.groupRows(V.deadlines, [{ phaseIdx: 6, phase: '' }], null)), ['—']);
});

test('review round 1: a failed meta read (null meta) with a column sort chosen keeps the EE after ITA headings in board order, not the sort order', () => {
  // board order: g_pend (0, 1), g_oct (2, 3), g_sep (4); the column sort (client A → Z) brings October first
  const rows = [
    { id: 'a', name: 'Aaron', boardIdx: 2, groupId: 'g_oct', groupTitle: 'October 2026' }, { id: 'b', name: 'Bina', boardIdx: 4, groupId: 'g_sep', groupTitle: 'September 2026' },
    { id: 'c', name: 'Chen', boardIdx: 0, groupId: 'g_pend', groupTitle: 'Pending' }, { id: 'd', name: 'Dev', boardIdx: 3, groupId: 'g_oct', groupTitle: 'October 2026' },
    { id: 'e', name: 'Esha', boardIdx: 1, groupId: 'g_pend', groupTitle: 'Pending' },
  ];
  const ids = (list) => list.map((r) => r.id).join('');
  const out = U.groupRows(V.eeita, rows, null);
  assert.deepEqual(titles(out), ['Pending', 'October 2026', 'September 2026']);
  assert.deepEqual(titles(out), titles(U.groupRows(V.eeita, U.viewOrder(V.eeita, rows), null)), 'the same headings as with no column sort');
  assert.deepEqual(out.map((g) => ids(g.rows)), ['ce', 'ad', 'b'], 'the column sort is kept inside each heading');
  // a group missing from meta (added after the read) still goes last, and the unknown ones keep board order between them
  const meta = dash._casesIo.parseMeta({ groups: [{ id: 'g_sep', title: 'September 2026', position: '1.0' }], columns: [] });
  assert.deepEqual(titles(U.groupRows(V.eeita, rows, meta)), ['September 2026', 'Pending', 'October 2026']);
  // rows without a board place fall back to the order first seen, after the placed ones
  assert.deepEqual(titles(U.groupRows(V.eeita, [{ groupId: 'x', groupTitle: 'X' }, ...rows], null)), ['Pending', 'October 2026', 'September 2026', 'X']);
});

test('viewOrder: board order on Assigning / Deadlines / EE; Mahesh by Actual Deadline ascending, blanks LAST, ties in board order; a chosen column sort is kept inside each group', () => {
  const rows = [
    { id: 'p', boardIdx: 4, actualDeadline: '' }, { id: 'q', boardIdx: 1, actualDeadline: '2026-12-01' }, { id: 'r', boardIdx: 3, actualDeadline: '2026-11-20' },
    { id: 's', boardIdx: 0, actualDeadline: '' }, { id: 't', boardIdx: 2, actualDeadline: '2026-11-20' },
  ];
  const ids = (list) => list.map((r) => r.id).join('');
  assert.equal(ids(U.viewOrder(V.assigning, rows)), 'sqtrp', 'board order');
  assert.equal(ids(U.viewOrder(V.deadlines, rows)), 'sqtrp');
  assert.equal(ids(U.viewOrder(V.mahesh, rows)), 'trqsp', 'dated ascending (ties by board order), then the blanks in board order');
  assert.equal(ids(U.viewOrder({ ...V.mahesh, sort: { field: 'actualDeadline', dir: 'DESC' } }, rows)), 'qtrsp', 'DESC: blanks still last');
  // a column sort chosen: groupRows keeps the incoming order inside each heading
  const sorted = [{ id: 'z', stageIdx: 1, caseStage: 'Internal Review' }, { id: 'y', stageIdx: 0, caseStage: 'DCS' }, { id: 'x', stageIdx: 1, caseStage: 'Internal Review' }];
  assert.deepEqual(U.groupRows(V.assigning, sorted, META).map((g) => ids(g.rows)), ['y', 'zx']);
});

test('the counts above the table: no Support Officer (person or team) with the Pre-Onboarding split; a two-officer row counts as having one', () => {
  const o = (p, t) => ({ personIds: p, teamIds: t });
  const rows = [
    { stageIdx: 12, officerIds: o([], []) }, { stageIdx: 1, officerIds: o([], []) }, { stageIdx: 12, officerIds: o(['1'], []) },
    { stageIdx: 1, officerIds: o(['1', '2'], []) }, { stageIdx: 1, officerIds: o([], ['9']) }, { stageIdx: 12 },
  ];
  assert.deepEqual(U.noOfficerCount(rows, 12), { n: 3, preOnboarding: 2 });
  assert.deepEqual(U.typeCounts([{ deadlineType: 'Deadline' }, { deadlineType: 'Imaginary' }, { deadlineType: '' }, {}]), { real: 1, imaginary: 1, none: 2 });
});

test('the Filtered line: "Filtered: n of N in Monday\'s view" only when the person\'s own search or filter is on (the tab itself does not count)', () => {
  assert.equal(U.filteredLine(40, 156, false), null);
  assert.equal(U.filteredLine(40, 156, true).text, "Filtered: 40 of 156 in Monday's view");
  assert.equal(U.hasUserFilter({ q: '', sel: { view: ['assigning'] } }, 'view'), false);
  assert.equal(U.hasUserFilter({ q: 'asha', sel: { view: ['assigning'] } }, 'view'), true);
  assert.equal(U.hasUserFilter({ q: '', sel: { view: ['assigning'], stage: ['Stuck'] } }, 'view'), true);
  assert.equal(U.hasUserFilter({ q: '', sel: { stage: [] } }, 'view'), false);
});

/* ── the list engine: the view facet, blank dates last, the sort-reset words ── */

test('the view facet: a row is under every tab it is in; tabs are one at a time; Clear filters keeps the tab; a saved tab that no longer exists is dropped', () => {
  const ctx = { healthOrder: {}, views: cmv.pageViews() };
  const LT = listCore(S.casesListSpec(ctx));
  const rows = [{ id: '1', views: ['assigning', 'deadlines', 'mahesh'] }, { id: '2', views: ['deadlines'] }, { id: '3', views: [] }];
  const st = LT.emptyState();
  assert.deepEqual(LT.facetCounts(rows, st, 'view').map((x) => [x.value, x.count]), [['assigning', 1], ['deadlines', 2], ['mahesh', 1], ['eeita', 0], [LT.NONE, 1]]);
  st.sel.view = ['deadlines']; st.sel.stage = ['X'];
  assert.deepEqual(LT.clearAll(st).sel, { view: ['deadlines'] }, 'Clear filters: every filter off, the tab stays');
  assert.deepEqual(LT.chips({ q: '', sel: { view: ['mahesh'] } }), [], 'the tab is not a chip');
  assert.equal(LT.normalizeState({ sel: { view: ['gone'] } }).sel.view, undefined);
  assert.deepEqual(LT.normalizeState({ sel: { view: ['eeita'] } }).sel.view, ['eeita']);
  const q = S.casesListOpts(ctx).quick;
  assert.deepEqual([q.facet, q.box, q.tabs, q.allLast, q.all, q.default, q.storeKey], ['view', 'cs-quick', true, false, 'All', undefined, 'tdot_list_cases_tab'], 'All first; no default: a new browser tab opens on All');
  assert.deepEqual(q.values, ['assigning', 'deadlines', 'mahesh', 'eeita']);
  assert.ok(q.storeKey.indexOf('tdot_list_') === 0, 'Sign Out forgets the kept tab');
  assert.match(q.hints.assigning, /Grouped by Case Stage/);
});

test('the engine tells the page whether a column sort is chosen (h.defaultSort), so the page never keeps its own copy of the normal order', () => {
  const { listTableUi } = require('../src/routes/listFilters');
  const el = () => ({ setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, contains() { return false; } }, appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, contains() { return false; }, style: {} });
  const seen = [];
  const win = { document: { getElementById: () => null, createElement: el, body: el(), addEventListener() {}, activeElement: null, documentElement: el() },
    sessionStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, location: { search: '' }, renderCasesList: (rows, why, st, h) => { seen.push(h.defaultSort); } };
  const api = listTableUi(listCore(S.casesListSpec({ healthOrder: {}, views: cmv.pageViews() })), S.casesListOpts({ views: cmv.pageViews() }), win);
  api.setRows([{ id: '1' }]);
  api.state().sort = { key: 'caseRef', dir: 'asc' }; api.apply('sort');
  api.state().sort = { key: 'createdAt', dir: 'desc' }; api.apply('sort');
  assert.deepEqual(seen, [true, false, true]);
});

test('api.clearFilters (the Client Master "Filtered" line) clears the filters and puts focus in the search box, like the chips\' Clear filters', () => {
  const { listTableUi } = require('../src/routes/listFilters');
  const el = () => ({ setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, contains() { return false; } }, appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, contains() { return false; }, style: {} });
  const opts = S.casesListOpts({ views: cmv.pageViews() });
  let focused = 0, last = null;
  const search = { ...el(), value: '', focus() { focused++; } };
  const win = { document: { getElementById: (id) => (id === opts.ids.search ? search : null), createElement: el, body: el(), addEventListener() {}, activeElement: null, documentElement: el() },
    sessionStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, location: { search: '' }, renderCasesList: (rows, why, st) => { last = st; } };
  const api = listTableUi(listCore(S.casesListSpec({ healthOrder: {}, views: cmv.pageViews() })), opts, win);
  api.setRows([{ id: '1' }]);
  search.value = 'asha'; api.state().q = 'asha'; api.apply('filter');
  api.clearFilters();
  assert.equal(search.value, ''); assert.equal(last.q, '');
  assert.equal(focused, 1, 'focus goes to the search box, not the page body');
});

test('sortBlanksLast: a blank Actual Deadline / Promised date / Phase / Support Officer goes last in BOTH directions (Cases only — Leads and Retainers sort as before)', () => {
  const LT = listCore(S.casesListSpec({ healthOrder: {} }));
  const rows = [{ id: 'a', actualDeadline: '' }, { id: 'b', actualDeadline: '2026-12-01' }, { id: 'c', actualDeadline: '2026-11-01' }, { id: 'd', actualDeadline: '' }];
  const ids = (list) => list.map((r) => r.id).join('');
  assert.equal(ids(LT.sortRows(rows, { key: 'actualDeadline', dir: 'asc' })), 'cbad');
  assert.equal(ids(LT.sortRows(rows, { key: 'actualDeadline', dir: 'desc' })), 'bcad');
  assert.equal(ids(LT.sortRows(rows.map((r) => ({ id: r.id, promisedDate: r.actualDeadline })), { key: 'promisedDate', dir: 'desc' })), 'bcad');
  // a sort key NOT listed keeps the old rule (blank = smallest)
  assert.equal(ids(LT.sortRows(rows.map((r) => ({ id: r.id, caseRef: r.actualDeadline })), { key: 'caseRef', dir: 'asc' })), 'adcb');
  for (const spec of [S.consultListSpec({}), S.retainerListSpec({ outcomes: [], today: () => '' })]) assert.equal(spec.sortBlanksLast, undefined);
  // Phase sorts "Phase 8" before "Phase 11"; no phase / no officer last (A → Z opens on the cases that have one)
  const ph = [{ id: '-', phase: '' }, { id: '11', phase: 'Phase 11' }, { id: '8', phase: 'Phase 8' }, { id: 'P', phase: 'Profile' }];
  assert.equal(LT.sortRows(ph, { key: 'phase', dir: 'asc' }).map((r) => r.id).join(','), '8,11,P,-');
  assert.equal(LT.sortRows(ph, { key: 'phase', dir: 'desc' }).map((r) => r.id).join(','), 'P,11,8,-');
  assert.equal(LT.sortRows([{ id: 'n', officer: '' }, { id: 'b', officer: 'Bo' }, { id: 'a', officer: 'Ann' }], { key: 'officer', dir: 'asc' }).map((r) => r.id).join(''), 'abn');
  assert.deepEqual(S.casesListSpec({}).sortBlanksLast, ['actualDeadline', 'promisedDate', 'phase', 'officer']);
  // the search reads the Support Officer too
  const st = LT.emptyState(); st.q = 'officer b';
  assert.deepEqual(LT.filterRows([{ id: '1', officer: 'Officer A, Officer B' }, { id: '2', officer: 'Officer A' }], st).map((r) => r.id), ['1']);
});

/* ── the page ── */

function renderRoute(path) {
  const router = require('../src/routes/adminDashboard');
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
}
function inlineScripts(html) { return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]); }

test('the page: renamed Client Master; tabs + header box above the toolbar; every inline script parses; the helpers come in by toString', async () => {
  const html = await renderRoute('/');
  assert.match(html, /<title>TDOT — Client Master<\/title>/);
  assert.match(html, /<h1 class="dash-title">Client Master<\/h1>/);
  assert.ok(html.includes('The Client Master board, with its Monday views as tabs'));
  assert.ok(html.includes('<div class="sec-hd">📋 Client Master</div>'));
  assert.ok(html.indexOf('id="cs-quick"') < html.indexOf('id="cm-head"') && html.indexOf('id="cm-head"') < html.indexOf('id="search-box"'), 'tabs, then the header box, then the toolbar');
  assert.ok(html.includes('<div class="lt-tabs" id="cs-quick" role="tablist" aria-label="Client Master views"></div>'));
  // review round 1: the box above the table is redrawn on every search letter, so it is not a live region (#table-count says the count)
  assert.ok(html.includes('<div id="cm-head" class="cm-head"></div>'), 'no aria-live on #cm-head');
  assert.ok(html.includes('<span class="table-count" id="table-count" aria-live="polite"></span>'));
  // review round 1: the search also matches the Support Officer, and the box says so
  assert.ok(html.includes('placeholder="Search by client, case ref, type, officer…" aria-label="Search cases by client, case reference, type or Support Officer"'));
  for (const s of inlineScripts(html)) new vm.Script(s);
  assert.ok(html.includes('var CMW = (function clientMasterWindows() {') && html.includes('var CMU = (function clientMasterUi(W) {'));
  assert.ok(html.includes('var CM_VIEWS = [{"key":"assigning"'));
  assert.ok(html.includes('var CS_COLSPAN = 15;'), 'the full-width rows span every column (no hard-coded colspan)');
  assert.ok(!html.includes('colspan="11"'));
  assert.ok(html.includes("views: CM_VIEWS, initial: cmInitial, onChange: cmOnChange"));
  assert.ok(html.includes('onclick="loadData(true)"'), 'Refresh asks for a fresh read');
  assert.ok(html.includes("fetch('/admin/dashboard-stats' + (fresh === true ? '?fresh=1' : '')"));
  assert.ok(html.includes("'Monday data from ' + t"));
  assert.ok(html.includes('@page { size: landscape; margin: 10mm; }') && html.includes('#all-cases-table td.cm-del { display:none; }'));
  assert.ok(html.includes('.cm-grp-t { position:sticky; left:14px;'), 'a heading title stays in view when the table scrolls sideways');
  // the Summary page is unchanged: no tabs, no helpers, no landscape print
  const sum = await renderRoute('/summary');
  assert.ok(!sum.includes('id="cs-quick"') && !sum.includes('var CMW = (') && !sum.includes('@page'));
  assert.match(sum, /<title>TDOT — Summary<\/title>/);
  assert.ok(sum.includes('>📋 Client Master</a>'), 'the Summary page links to Client Master');
});

test('test 9: the new page code follows the page-script rule — the characters "→ – —" are written as themselves, never as escapes; no backtick, dollar-brace or backslash in what the template adds', async () => {
  const src = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  const block = src.slice(src.indexOf('/* ── The view tabs (block 3)'), src.indexOf('function renderPagination(total) {'));
  assert.ok(block.length > 3000, 'the view-tab code is in the page');
  assert.ok(!/[`\\]|\$\{/.test(block), 'no backtick, dollar-brace or backslash inside the template literal');
  assert.ok(block.includes('—') && !/\\u20(13|14)|\\u2192/.test(block));
  const css = src.slice(src.indexOf('const CM_CSS = `'), src.indexOf('function buildDashboardHTML'));
  assert.ok(!/\\|\$\{/.test(css.slice('const CM_CSS = `'.length, css.lastIndexOf('`'))));
  for (const fn of [U.clientMasterUi, require('../src/routes/clientMasterWindows').clientMasterWindows, S.casesListSpec, S.casesListOpts]) {
    assert.ok(!/[`\\]|\$\{/.test(fn.toString()), fn.name + ': safe to inject');
  }
  const ui = vm.runInNewContext('(' + U.clientMasterUi.toString() + ')((' + require('../src/routes/clientMasterWindows').clientMasterWindows.toString() + ')())');
  assert.equal(typeof ui.groupRows, 'function', 'the helpers refer to nothing outside themselves');
  // the list script for this page parses with the page's context
  new vm.Script(listTableScript(S.casesListSpec, S.casesListOpts, '{ healthOrder: {}, views: [], initial: function(){ return false; }, onChange: function(){} }'));
});

test('a view tab draws headings and no pages; the stage / manager blanks show "—" there only; the flags only on Deadlines and Mahesh (the page code)', async () => {
  const html = await renderRoute('/');
  assert.deepEqual(cmv.pageViews().map((v) => [v.key, v.stageStrip, v.deadlineBox]), [['assigning', true, false], ['deadlines', false, true], ['mahesh', false, true], ['eeita', false, false]],
    'what each tab adds is data from the server (Assigning: the stage counts; Deadlines, Mahesh: the windows, Real/Imaginary counts and flags)');
  assert.ok(html.includes("if (v) return renderViewTable(v, rows, st, !(h && h.defaultSort === false));"), 'a view tab is drawn by its own function, in Monday\'s order unless a column sort is chosen');
  assert.ok(html.includes("document.getElementById('pagination').innerHTML = '';"), 'no pages on a view tab');
  assert.ok(html.includes("var stage = v && (typeof c.stageIdx !== 'number' || c.stageIdx === CMU.EMPTY) ? cmNoneDash() : escHtml(c.caseStage);"));
  assert.ok(html.includes("var mgr = v && (!c.manager || c.manager === 'Unassigned') ? cmNoneDash() : escHtml(c.manager);"));
  assert.ok(html.includes("if (v && v.deadlineBox) {\n    var f = CMW.flagOf(c, today);"));
  assert.ok(html.includes("if (VIEW !== 'summary' && (!data || !Array.isArray(data.cases))) throw new Error('the case list did not come back');\n      _data = data;"), 'a bad answer never replaces the data the rows on screen came from');
  assert.ok(html.includes("function cmDataTimeText(data) { var t = cmHm((data && data.dataAt) || ''); return t ? 'Monday data from ' + t : ''; }"), 'never the time the answer was made');
  assert.equal(S.casesListOpts({}).cols.length, 15);
  assert.deepEqual(S.casesListOpts({}).cols.map((c) => c.id), ['caseRef', 'clientName', 'caseType', 'caseStage', 'phase', 'deadline', 'promised', 'health', 'slaRisk', 'officer', 'manager', 'overallReadiness', 'daysElapsed', 'status', 'del'],
    'Support Officer sits before Manager');
});

test('the new address: /admin/client-master (with or without a slash) → 302 /admin/dashboard, keeping the query; mounted as a plain app.get before the dashboard router', () => {
  const { clientMasterAlias } = require('../src/routes/adminDashboard');
  const go = (originalUrl) => { let out = null; clientMasterAlias({ originalUrl }, { redirect: (code, url) => { out = [code, url]; } }); return out; };
  assert.deepEqual(go('/admin/client-master'), [302, '/admin/dashboard']);
  assert.deepEqual(go('/admin/client-master/'), [302, '/admin/dashboard']);
  assert.deepEqual(go('/admin/client-master?view=assigning'), [302, '/admin/dashboard?view=assigning']);
  assert.deepEqual(go('/admin/client-master/?view=mahesh&x=1'), [302, '/admin/dashboard?view=mahesh&x=1']);
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const at = server.indexOf("app.get(['/admin/client-master', '/admin/client-master/'], adminDashboardRouter.clientMasterAlias);");
  assert.ok(at > 0 && at < server.indexOf("app.use('/admin/dashboard', adminDashboardRouter);"), 'before the dashboard router');
  assert.ok(!/app\.use\('\/admin\/client-master'/.test(server), 'not a router (it could catch other paths)');
});

test('the rename elsewhere: the top bar says Client Master (same link, same active key); the cockpit and the Retainers page point to it', () => {
  const { buildNavHeader } = require('../src/routes/adminShared');
  const nav = buildNavHeader('dashboard');
  assert.ok(nav.includes('<a href="/admin/dashboard" class="nav-lnk active" title="Client Master" aria-current="page">'));
  assert.ok(nav.includes('<span class="nav-txt">Client Master</span>') && !nav.includes('<span class="nav-txt">Cases</span>'));
  const cockpit = require('../src/routes/adminCase').buildCockpitHTML('2026-TEST-001');
  assert.ok(cockpit.includes('← Back to Client Master</a>'));
  const ret = require('../src/routes/adminConsultation').buildRetainersHTML();
  assert.ok(ret.includes('check the Client Master page') && ret.includes('the case is on the Client Master page. Not counted under All.'));
  assert.ok(!ret.includes('the Cases page'));
});
