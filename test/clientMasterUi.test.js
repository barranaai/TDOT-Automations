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
// No tab has a sort since the Mahesh tab was taken off (2026-11-12). The sort is still data: a page view shaped as that
// tab was (grouped by Phase, Actual Deadline ascending) proves the machinery that stays.
const SORTED = { key: 'sorted', label: 'Sorted', by: 'phase', dir: 'ASC', groupOrder: 'position', sort: { field: 'actualDeadline', dir: 'ASC' } };
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

test('pageViews: the three tabs in order, with what each groups by, its order and sort — from the view definitions', () => {
  assert.deepEqual(cmv.pageViews().map((v) => [v.key, v.label, v.by, v.dir, v.groupOrder, v.sort && v.sort.field]), [
    ['assigning', 'Assigning', 'stage', 'ASC', 'position', null],
    ['deadlines', 'Deadlines', 'phase', 'ASC', 'position', null],
    ['eeita', 'EE after ITA', 'board', 'ASC', 'position', null],
  ]);
  for (const v of cmv.pageViews()) assert.ok(/^Like Monday's /.test(v.hint) && !/["\\`]/.test(v.hint), v.key + ': a plain tooltip, safe to put in the page');
  assert.equal(cmv.PRE_ONBOARDING_INDEX, 12);
  assert.equal(JSON.parse(JSON.stringify(META_FIX.columns[STAGE].settings.labels))['12'], 'Pre-Onboarding');
});

/* ── test 4: the headings, the order, the counts ── */

test('groupRows on the real capture: the headings and counts per tab (Assigning by Case Stage label position; Deadlines by Phase; EE by board group)', () => {
  const rows = captureRows();
  const g = (key) => U.groupRows(V[key], U.viewOrder(V[key], rows.filter((r) => r.views.includes(key))), META);
  assert.deepEqual(counts(g('assigning')), ['Document Collection Started 22', 'Internal Review 84', 'Submission Ready 2', 'Stuck 9', 'Pre-Onboarding 34', 'ADR 5'],
    'by position: Submission Ready above Stuck, ADR last');
  assert.deepEqual(counts(g('deadlines')), ['Phase 8 11', 'Profile 31', 'Phase 11 66', 'N/A 3'], 'Profile before Phase 11');
  // a Phase the Deadlines tab has no row for (Phase 9) still takes its place by label position: the old Mahesh view's rows, drawn as a Phase tab
  const old = cmv.compileView({ key: 'old', label: 'Old', groupOrder: 'position', monday: { id: '283824419', ...JSON.parse(JSON.stringify(require('./fixtures/client-master-views-2026-11-08.json')['283824419'])) } });
  assert.deepEqual(counts(U.groupRows(SORTED, U.viewOrder(SORTED, rows.filter((r) => old.test(r))), META)), ['Phase 8 9', 'Phase 9 4', 'Profile 30', 'Phase 11 66', 'N/A 3']);
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

test('viewOrder: board order on Assigning / Deadlines / EE (no tab has a sort today); a view WITH a sort goes by Actual Deadline ascending, blanks LAST, ties in board order; a chosen column sort is kept inside each group', () => {
  const rows = [
    { id: 'p', boardIdx: 4, actualDeadline: '' }, { id: 'q', boardIdx: 1, actualDeadline: '2026-12-01' }, { id: 'r', boardIdx: 3, actualDeadline: '2026-11-20' },
    { id: 's', boardIdx: 0, actualDeadline: '' }, { id: 't', boardIdx: 2, actualDeadline: '2026-11-20' },
  ];
  const ids = (list) => list.map((r) => r.id).join('');
  assert.equal(ids(U.viewOrder(V.assigning, rows)), 'sqtrp', 'board order');
  assert.equal(ids(U.viewOrder(V.deadlines, rows)), 'sqtrp');
  assert.equal(ids(U.viewOrder(V.eeita, rows)), 'sqtrp');
  assert.equal(ids(U.viewOrder(SORTED, rows)), 'trqsp', 'dated ascending (ties by board order), then the blanks in board order');
  assert.equal(ids(U.viewOrder({ ...SORTED, sort: { field: 'actualDeadline', dir: 'DESC' } }, rows)), 'qtrsp', 'DESC: blanks still last');
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
  const rows = [{ id: '1', views: ['assigning', 'deadlines'] }, { id: '2', views: ['deadlines'] }, { id: '3', views: [] }];
  const st = LT.emptyState();
  assert.deepEqual(LT.facetCounts(rows, st, 'view').map((x) => [x.value, x.count]), [['assigning', 1], ['deadlines', 2], ['eeita', 0], [LT.NONE, 1]]);
  st.sel.view = ['deadlines']; st.sel.stage = ['X'];
  assert.deepEqual(LT.clearAll(st).sel, { view: ['deadlines'] }, 'Clear filters: every filter off, the tab stays');
  assert.deepEqual(LT.chips({ q: '', sel: { view: ['deadlines'] } }), [], 'the tab is not a chip');
  assert.equal(LT.normalizeState({ sel: { view: ['gone'] } }).sel.view, undefined);
  assert.equal(LT.normalizeState({ sel: { view: ['mahesh'] } }).sel.view, undefined, 'the tab taken off on 2026-11-12');
  assert.deepEqual(LT.normalizeState({ sel: { view: ['eeita'] } }).sel.view, ['eeita']);
  const q = S.casesListOpts(ctx).quick;
  assert.deepEqual([q.facet, q.box, q.tabs, q.allLast, q.all, q.default, q.storeKey], ['view', 'cs-quick', true, false, 'All', undefined, 'tdot_list_cases_tab'], 'All first; no default: a new browser tab opens on All');
  assert.deepEqual(q.values, ['assigning', 'deadlines', 'eeita']);
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
  assert.equal(S.retainerListSpec({ outcomes: [], today: () => '' }).sortBlanksLast, undefined);
  // Consultations got column sorts on 2026-11-11 (every column on 2026-11-12): a row with no service / consultant / mode / outcome / "Now" goes last both ways.
  assert.deepEqual(S.consultListSpec({}).sortBlanksLast, ['service', 'consultant', 'mode', 'outcome', 'now']);
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
  const block = src.slice(src.indexOf('/* ── The view tabs (block 3)'), src.indexOf('/* ── Helpers ─'));
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

test('a view tab draws headings and no pages; the stage / manager blanks show "—" there only; the flags only on Deadlines (the page code)', async () => {
  const html = await renderRoute('/');
  assert.deepEqual(cmv.pageViews().map((v) => [v.key, v.stageStrip, v.deadlineBox]), [['assigning', true, false], ['deadlines', false, true], ['eeita', false, false]],
    'what each tab adds is data from the server (Assigning: the stage counts; Deadlines: the windows, Real/Imaginary counts and flags)');
  assert.ok(html.includes("if (v) return renderViewTable(v, rows, st, !(h && h.defaultSort === false));"), 'a view tab is drawn by its own function, in Monday\'s order unless a column sort is chosen');
  assert.ok(!/pagination|PAGE_SIZE|renderTablePage|pg-btn/.test(html), 'no pages on any tab: the page has no paging code left');
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

/* ── the Mahesh tab taken off (2026-11-12): nobody is left on a tab that is not there ── */

// The page's own tab code (cmInitial and what it needs), run with the list engine in a made-up browser tab.
async function openClientMaster({ search = '', store = {} } = {}) {
  const html = await renderRoute('/');
  const from = html.indexOf('var CM_GONE = '), to = html.indexOf('function cmToday()');
  assert.ok(from > 0 && to > from, 'the tab code is in the page');
  const { listTableUi } = require('../src/routes/listFilters');
  const kept = new Map(Object.entries(store));
  const address = { href: 'https://staff.example/admin/dashboard' + search };
  const el = () => ({ setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, contains() { return false; } }, appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, contains() { return false; }, style: {} });
  const opts0 = S.casesListOpts({ views: cmv.pageViews() });
  const box = { ...el(), innerHTML: '' };
  const shown = [];
  const win = {
    document: { getElementById: (id) => (id === opts0.quick.box ? box : null), createElement: el, body: el(), addEventListener() {}, activeElement: null, documentElement: el() },
    sessionStorage: { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => { kept.set(k, String(v)); } },
    addEventListener() {},
    get location() { const u = new URL(address.href); return { href: u.href, search: u.search }; },
    renderCasesList: (rows) => { shown.push(rows.map((r) => r.id).join('')); },
  };
  const ctx = vm.createContext({ window: win, URL, URLSearchParams, history: { replaceState: (_s, _t, url) => { address.href = String(url); } }, CM_VIEWS: cmv.pageViews() });
  vm.runInContext(html.slice(from, to), ctx);
  const views = cmv.pageViews();
  const api = listTableUi(listCore(S.casesListSpec({ healthOrder: {}, views })), S.casesListOpts({ views, initial: ctx.cmInitial, onChange: ctx.cmOnChange }), win);
  api.setRows([{ id: 'a', views: ['assigning', 'deadlines'] }, { id: 'd', views: ['deadlines'] }, { id: 'e', views: ['assigning', 'eeita'] }, { id: 'n', views: [] }]);
  const active = [...box.innerHTML.matchAll(/class="lt-tab active[^"]*" data-quick="([^"]*)" aria-selected="true"/g)].map((m) => m[1]);
  const sv = api.state().sel.view;   // the page code runs in its own context: copy the list into this one
  return { view: sv ? Array.from(sv) : sv, active, rows: shown[shown.length - 1], kept, search: new URL(address.href).search, ctx, tabs: [...box.innerHTML.matchAll(/data-quick="([^"]*)"/g)].map((m) => m[1]) };
}
const TAB_KEY = 'tdot_list_cases_tab', STATE_KEY = 'tdot_list_cases';

test('the Mahesh tab is gone from the page: the tabs are All · Assigning · Deadlines · EE after ITA, and no row is listed under it', async () => {
  const p = await openClientMaster();
  assert.deepEqual(p.tabs, ['', 'assigning', 'deadlines', 'eeita']);
  assert.deepEqual([p.view, p.active, p.rows], [undefined, [''], 'aden'], 'a new browser tab opens on All, as before');
  const html = await renderRoute('/');
  assert.ok(!/"key":"mahesh"|>Mahesh</.test(html) && !html.includes("Monday's Mahesh view"), 'no tab, label or tooltip names it');
  assert.equal(p.ctx.CM_TAB_KEY, S.casesListOpts({}).quick.storeKey, 'the page reads the kept tab under the list\'s own key');
  assert.equal(S.casesListOpts({}).key, STATE_KEY);
  assert.deepEqual(Object.keys(p.ctx.CM_GONE), ['mahesh']);
  for (const to of Object.values(p.ctx.CM_GONE)) assert.ok(cmv.view(to), 'a retired tab points at a tab that exists');
});

test('an old link ?view=mahesh opens the Deadlines tab, the address then says view=deadlines, and that tab is the one kept', async () => {
  for (const search of ['?view=mahesh', '?view=Mahesh', '?x=1&view=%20MAHESH%20']) {
    const p = await openClientMaster({ search });
    assert.deepEqual([p.view, p.active, p.rows], [['deadlines'], ['deadlines'], 'ad'], search);
    assert.equal(new URLSearchParams(p.search).get('view'), 'deadlines', search + ': the address is corrected');
    assert.equal(p.kept.get(TAB_KEY), 'deadlines', 'kept for this browser tab (the way back from a case returns to it)');
    assert.ok(!JSON.stringify([...p.kept]).includes('mahesh'));
  }
  assert.equal(new URLSearchParams((await openClientMaster({ search: '?x=1&view=mahesh' })).search).get('x'), '1', 'the rest of the address is kept');
  // the old link wins over whatever tab this browser tab was on
  const over = await openClientMaster({ search: '?view=mahesh', store: { [TAB_KEY]: 'eeita', [STATE_KEY]: JSON.stringify({ sel: { view: ['eeita'] } }) } });
  assert.deepEqual([over.view, over.active], [['deadlines'], ['deadlines']]);
  // links to the tabs that stay, and unknown names, behave as before
  const ee = await openClientMaster({ search: '?view=eeita' });
  assert.deepEqual([ee.view, ee.active, ee.rows, ee.search], [['eeita'], ['eeita'], 'e', '?view=eeita']);
  const all = await openClientMaster({ search: '?view=all', store: { [TAB_KEY]: 'assigning' } });
  assert.deepEqual([all.view, all.active], [undefined, ['']]);
  const junk = await openClientMaster({ search: '?view=nope', store: { [TAB_KEY]: 'assigning' } });
  assert.deepEqual([junk.view, junk.active, junk.search], [['assigning'], ['assigning'], ''], 'an unknown name is no link: the kept tab stays and the address stops naming it');
});

test('a browser tab that was left on the Mahesh tab lands on Deadlines — never an empty table under a filter nobody can see', async () => {
  // what the old page kept: the tab under the list's storeKey, and the same choice inside the kept filter state
  const both = await openClientMaster({ store: { [TAB_KEY]: 'mahesh', [STATE_KEY]: JSON.stringify({ q: '', sel: { view: ['mahesh'] }, sort: { key: 'createdAt', dir: 'desc' } }) } });
  assert.deepEqual([both.view, both.active, both.rows], [['deadlines'], ['deadlines'], 'ad']);
  assert.equal(both.kept.get(TAB_KEY), 'deadlines', 'the kept tab is put right at once');
  assert.deepEqual(JSON.parse(both.kept.get(STATE_KEY)).sel, { view: ['deadlines'] });
  // the person's own filters on that tab are kept
  const filt = await openClientMaster({ store: { [TAB_KEY]: 'mahesh', [STATE_KEY]: JSON.stringify({ q: '', sel: { view: ['mahesh'], manager: ['Ann'] } }) } });
  assert.deepEqual(filt.view, ['deadlines']);
  assert.deepEqual(JSON.parse(filt.kept.get(STATE_KEY)).sel.manager, ['Ann']);
  // only the kept tab says it
  const tabOnly = await openClientMaster({ store: { [TAB_KEY]: 'mahesh' } });
  assert.deepEqual([tabOnly.view, tabOnly.active, tabOnly.rows], [['deadlines'], ['deadlines'], 'ad']);
  // only the kept filter state says it (the kept tab is authoritative; this pair is never written together, proved anyway):
  // the engine drops a tab that is not on the list, so the page shows the tab the kept key names — a real, highlighted tab
  const stAll = await openClientMaster({ store: { [TAB_KEY]: '', [STATE_KEY]: JSON.stringify({ sel: { view: ['mahesh'] } }) } });
  assert.deepEqual([stAll.view, stAll.active, stAll.rows], [undefined, [''], 'aden'], 'All');
  const stNone = await openClientMaster({ store: { [STATE_KEY]: JSON.stringify({ sel: { view: ['mahesh'] } }) } });
  assert.deepEqual([stNone.view, stNone.active, stNone.rows], [undefined, [''], 'aden'], 'All');
  const stEe = await openClientMaster({ store: { [TAB_KEY]: 'eeita', [STATE_KEY]: JSON.stringify({ sel: { view: ['mahesh'] } }) } });
  assert.deepEqual([stEe.view, stEe.active, stEe.rows], [['eeita'], ['eeita'], 'e']);
  // in every case exactly one tab is highlighted and nothing kept names the old tab any more
  for (const p of [both, filt, tabOnly, stAll, stNone, stEe]) { assert.equal(p.active.length, 1); assert.ok(!JSON.stringify([...p.kept]).includes('mahesh')); }
  // a kept tab that stays is untouched; a private window (no storage) opens on All
  const keep = await openClientMaster({ store: { [TAB_KEY]: 'assigning', [STATE_KEY]: JSON.stringify({ sel: { view: ['assigning'] } }) } });
  assert.deepEqual([keep.view, keep.active, keep.rows], [['assigning'], ['assigning'], 'ae']);
});

/* ── groups that open and close; the All tab grouped by board group (team meeting 2026-11-10, items 10 and 11) ── */

const G = (key, title, n = 1) => ({ key, title, rows: Array.from({ length: n }, (_, i) => ({ id: key + i })) });
const BOARD = [G('gp', '⏳ Pending — signatures & payment'), G('gl', 'Leads'), G('g11', 'November 2026'), G('g10', 'October 2026'), G('g9', 'September  2026'),
  G('gc', 'Cancel /Did not retained'), G('g5', 'May 2026'), G('gt', 'TEST'), G('gr', 'Retainers before May 2026')];

test('monthOf: a board group named "<Month> <Year>" is a month (extra spaces, any case, a short name); "Retainers before May 2026", Leads, TEST and the pending group are not', () => {
  assert.deepEqual(U.monthOf('November 2026'), { y: 2026, m: 11 });
  assert.deepEqual(U.monthOf('September  2026'), { y: 2026, m: 9 }, 'two spaces, as on the board');
  assert.deepEqual(U.monthOf('  oCTOBER 2026 '), { y: 2026, m: 10 });
  assert.deepEqual(U.monthOf('Sept 2026'), { y: 2026, m: 9 });
  assert.deepEqual(U.monthOf('May 2026'), { y: 2026, m: 5 });
  for (const t of ['Retainers before May 2026', 'Leads', 'TEST', '⏳ Pending — signatures & payment', 'Cancel /Did not retained', 'New Group', 'Ma 2026', 'November', '2026', 'November 26', 'Novembers 2026', '', null, undefined]) {
    assert.equal(U.monthOf(t), null, String(t));
  }
});

test('the All tab opens on the newest month only: this Toronto month; else the newest month group; else the first group — the view tabs open every group', () => {
  assert.equal(U.newestMonthId(BOARD, '2026-11-12'), 'g11');
  assert.equal(U.newestMonthId(BOARD, '2026-09-30'), 'g9', 'the group for the month it is, even when a newer one exists');
  assert.equal(U.newestMonthId(BOARD, '2026-12-01'), 'g11', 'no December group yet: the newest month there is');
  assert.equal(U.newestMonthId(BOARD.slice().reverse(), '2027-01-05'), 'g11', 'newest by date, not by place on the board');
  assert.equal(U.newestMonthId([G('a', 'December 2025'), G('b', 'January 2026')], '2026-06-01'), 'b', 'the year counts before the month');
  assert.equal(U.newestMonthId([G('gl', 'Leads'), G('gt', 'TEST')], '2026-11-12'), 'gl', 'no month group at all: the first group');
  assert.equal(U.newestMonthId([], '2026-11-12'), null);
  assert.deepEqual(U.defaultOpenIds(U.ALL_VIEW, BOARD, '2026-11-12'), ['g11']);
  assert.deepEqual(U.defaultOpenIds(U.ALL_VIEW, [], '2026-11-12'), []);
  for (const k of ['assigning', 'deadlines', 'eeita']) assert.deepEqual(U.defaultOpenIds(V[k], [G(1, 'A'), G(12, 'B')], '2026-11-12'), ['1', '12'], k + ': all open, as before');
  assert.deepEqual([U.ALL_VIEW.key, U.ALL_VIEW.by, U.ALL_VIEW.groupOrder, U.ALL_VIEW.dir], ['all', 'board', 'position', 'ASC'], 'All is grouped like the EE after ITA tab: board groups in board order');
  assert.ok(!cmv.VIEW_KEYS.includes('all'), 'no Monday view takes the All tab\'s key');
});

test('openMap: kept choices win over the default, by group key; with a search or filter on every group is open and only that search\'s own choices apply', () => {
  const open = (o) => Object.entries(U.openMap(U.ALL_VIEW, BOARD, { today: '2026-11-12', ...o })).filter(([, v]) => v).map(([k]) => k);
  assert.deepEqual(open({}), ['g11']);
  assert.deepEqual(open({ kept: { g10: true } }), ['g11', 'g10'], 'one more opened: the default month stays open');
  assert.deepEqual(open({ kept: { g11: false, gl: true } }), ['gl']);
  assert.deepEqual(open({ kept: { gone: true, g11: 'yes' } }), ['g11'], 'a group no longer there, or a value that is not true / false, changes nothing');
  // filtered: all open whatever was kept; a group closed under this search stays closed
  assert.equal(open({ filtered: true, kept: { g11: false, g10: false } }).length, BOARD.length, 'a closed group never hides a match');
  assert.deepEqual(open({ filtered: true, kept: { g11: false }, temp: { gl: false, gp: false } }), BOARD.map((g) => g.key).filter((k) => k !== 'gl' && k !== 'gp'));
  assert.deepEqual(open({ filtered: false, temp: { g11: false } }), ['g11'], 'a choice made under a search is not used once the search is off');
  // a view tab: numbers as keys (stage / phase index) are kept as text
  const st = U.openMap(V.assigning, [G(12, 'Pre-Onboarding'), G(0, 'Document Collection Started')], { kept: { 12: false } });
  assert.deepEqual(st, { 12: false, 0: true });
  assert.equal(Object.keys(U.openMap(V.eeita, [G('', '—')], {}))[0], '', 'a row with no group id still has a group (never dropped)');
});

test('setOpen / normalizeKept / filterSig / groupLabel: the small rules the page keeps to', () => {
  const a = { x: true };
  assert.deepEqual(U.setOpen(a, ['y', 3], false), { x: true, y: false, 3: false });
  assert.deepEqual(a, { x: true }, 'a copy: the map handed in is not changed');
  assert.deepEqual(U.setOpen(null, ['y'], true), { y: true });
  assert.deepEqual(U.normalizeKept({ all: { g: true, h: false, bad: 1 }, deadlines: 'x', eeita: ['a'], assigning: {} }), { all: { g: true, h: false }, assigning: {} });
  for (const junk of [null, undefined, 'x', 3, [1]]) assert.deepEqual(U.normalizeKept(junk), {});
  const sig = (st, tab = 'all') => U.filterSig(st, 'view', tab);
  assert.equal(sig({ q: ' Ann ', sel: { view: ['eeita'] } }), sig({ q: 'ann', sel: {} }), 'the tab choice and the letters\' case are not a new search');
  assert.notEqual(sig({ q: 'ann' }), sig({ q: 'anna' }));
  assert.notEqual(sig({ q: 'ann' }), sig({ q: 'ann' }, 'eeita'), 'another tab is another list');
  assert.notEqual(sig({ sel: { health: ['Red'] } }), sig({ sel: { health: ['Red', 'Green'] } }));
  assert.equal(sig({ sel: { health: ['Red', 'Green'], manager: ['A'] } }), sig({ sel: { manager: ['A'], health: ['Green', 'Red'], stage: [] } }), 'the order of the choices does not matter');
  assert.equal(U.groupLabel('November 2026', 28, true), 'November 2026, 28 cases, open — press to close');
  assert.equal(U.groupLabel('TEST', 1, false), 'TEST, 1 case, closed — press to open');
});

test('the All tab on the real capture: every row is under its board group, in the board\'s order (like EE after ITA), none dropped', () => {
  const rows = captureRows();
  const groups = U.groupRows(U.ALL_VIEW, rows, META);
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), rows.length);
  const order = META.groups.map((g) => String(g.id));
  const at = groups.map((g) => order.indexOf(g.key));
  assert.ok(at.every((i) => i >= 0) && at.every((i, k) => k === 0 || at[k - 1] < i), 'board order');
  assert.ok(groups.some((g) => U.monthOf(g.title)), 'the month groups are there');
  // a group the board read does not know goes last, and a failed board read keeps board order
  const extra = U.groupRows(U.ALL_VIEW, rows.concat([{ id: 'x', groupId: 'group_new', groupTitle: 'December 2026', boardIdx: 99999 }]), META);
  assert.equal(extra[extra.length - 1].title, 'December 2026');
  assert.equal(U.groupRows(U.ALL_VIEW, rows, null).reduce((n, g) => n + g.rows.length, 0), rows.length);
});

/* The page's own drawing code (renderCasesList → renderViewTable, the open / close functions), run on a small made-up page. */
function fnOf(script, name) {
  const i = script.indexOf('\nfunction ' + name + '(');
  assert.ok(i >= 0, name + ' is in the page');
  const line = script.slice(i + 1, script.indexOf('\n', i + 1));
  return /\}\s*$/.test(line) ? line : script.slice(i + 1, script.indexOf('\n}\n', i) + 2);
}
async function groupsPage({ store = {}, signedOut = false, noStorage = false, today = '2026-11-12' } = {}) {
  const html = await renderRoute('/');
  const main = inlineScripts(html).find((s) => s.includes('function renderViewTable('));
  const kept = new Map(Object.entries(store));
  const mk = (tag) => {
    const e = { tag, className: '', style: {}, kids: [], attrs: {}, _html: '', onclick: null,
      appendChild(c) { this.kids.push(c); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = String(v); },
      focus() { page.focused = this; }, scrollIntoView(o) { page.scrolled = { el: this, o }; } };
    Object.defineProperty(e, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; this.kids = []; } });
    return e;
  };
  const els = { 'all-cases-body': mk('tbody'), 'cm-head': mk('div'), 'cm-oc': mk('span') };
  const page = { focused: null, scrolled: null, reduced: false };
  const buttons = () => els['all-cases-body'].kids.filter((k) => /^cm-grp /.test(k.className)).map((k) => {
    const b = mk('button'); b.className = 'cm-grp-b'; b.attrs['data-gk'] = k.innerHTML.match(/data-gk="([^"]*)"/)[1]; b.row = k; return b;
  });
  const win = { TDOT_SIGNED_OUT: signedOut, matchMedia: () => ({ matches: page.reduced }),
    sessionStorage: noStorage ? { getItem() { throw new Error('no storage'); }, setItem() { throw new Error('no storage'); } }
      : { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => { kept.set(k, String(v)); } } };
  const ctx = vm.createContext({ window: win, JSON, String, Object, Array,
    document: { getElementById: (id) => els[id] || null, createElement: mk, activeElement: null, querySelectorAll: (sel) => { assert.equal(sel, '#all-cases-body .cm-grp-b'); return buttons(); } },
    CM_VIEWS: cmv.pageViews(), CM_PRE_ONBOARDING: cmv.PRE_ONBOARDING_INDEX, CS_COLSPAN: 15, _data: { meta: META, cases: [] } });
  const names = ['renderCasesList', 'renderViewTable', 'renderCmHead', 'cmKept', 'cmKeptSave', 'cmGroupState', 'cmSetOpen', 'cmGrpToggle', 'cmGrpAll', 'cmGrpButton', 'cmGrpGo',
    'cmGroupTone', 'cmViewDef', 'cmView', 'cmInView', 'cmHm', 'cmDataTimeText', 'escHtml'];
  vm.runInContext(main.match(/var CMW = \(function clientMasterWindows[\s\S]*?\)\(CMW\);/)[0] + '\n' +
    main.match(/var CM_GRP_KEY = [\s\S]*?var CM_LAST = null;[^\n]*/)[0] + '\n' + names.map((n) => fnOf(main, n)).join('\n') + '\n' +
    'function cmToday() { return ' + JSON.stringify(today) + '; }\nfunction stageTone() { return "grey"; }\n' +
    'function caseRow(c, v) { return { className: c.health === "Red" ? "row-red" : "", id: c.id, view: v }; }', ctx);
  const tb = els['all-cases-body'];
  const api = {
    ctx, els, kept, page, html, main,
    draw(rows, st = { q: '', sel: {} }, h = { total: 100, defaultSort: true }) { ctx._data.cases = rows; return ctx.renderCasesList(rows, 'filter', st, h); },
    heads: () => tb.kids.filter((k) => /^cm-grp /.test(k.className)),
    // "title n ▾ / ▸" per heading, with the ids of the rows drawn under it
    look: () => { const out = []; tb.kids.forEach((k) => { if (/^cm-grp /.test(k.className)) out.push(k.innerHTML.match(/<b>([^<]*)<\/b> · <span class="cm-grp-n">(\d+)/).slice(1).join(' ') + (/ open/.test(k.className) ? ' ▾' : ' ▸')); else out[out.length - 1] += ' ' + k.id; }); return out; },
    click(title) { const h = api.heads().find((k) => k.innerHTML.includes('<b>' + title + '</b>')); assert.ok(h, title); h.onclick(); },
    saved: () => JSON.parse(kept.get('tdot_list_cases_groups') || 'null'),
  };
  return api;
}
const row = (id, groupId, groupTitle, o = {}) => ({ id, groupId, groupTitle, boardIdx: Number(id.replace(/\D/g, '')) || 0, views: [], ...o });
const ALL_ROWS = [row('n1', 'group_mm8qqjyz', 'November 2026'), row('o2', 'group_mm7qvmt1', 'October 2026'), row('n3', 'group_mm8qqjyz', 'November 2026', { health: 'Red' }),
  row('l4', 'group_mm2tz8e1', 'Leads'), row('s5', 'group_mm6sykds', 'September  2026'), row('p6', 'group_mm6a68f5', '⏳ Pending — signatures & payment'), row('u7', 'group_unknown', 'Brand new group')];

test('the All tab (the page code): grouped by board group in board order, no pages, only the newest month open — the count is of every matching row, open or closed', async () => {
  const p = await groupsPage();
  const out = p.draw(ALL_ROWS, undefined, { total: 718, defaultSort: true });
  assert.deepEqual(p.look(), ['⏳ Pending — signatures &amp; payment 1 ▸', 'Leads 1 ▸', 'November 2026 2 ▾ n1 n3', 'October 2026 1 ▸', 'September  2026 1 ▸', 'Brand new group 1 ▸']);
  assert.deepEqual({ ...out }, { shown: 7, total: 718 }, 'six of the seven rows are in closed groups and are still counted');
  assert.equal(p.els['cm-head'].style.display, 'none', 'the box above the table stays a view-tab thing');
  // the rows of the All tab are drawn as before (no view), bound to their group, the last one closing it
  const rows = p.els['all-cases-body'].kids.filter((k) => k.id);
  assert.deepEqual(rows.map((r) => [r.id, r.view, r.className]), [['n1', null, 'cm-in'], ['n3', null, 'row-red cm-in cm-last']]);
  // a heading: a real button with the state said three ways (class, aria-expanded, the spoken name), the count, the tone kept
  const [pend, , nov] = p.heads();
  assert.equal(nov.className, 'cm-grp open');
  assert.equal(pend.className, 'cm-grp shut tone-amber');
  assert.ok(nov.innerHTML.includes('<button type="button" class="cm-grp-b" data-gk="group_mm8qqjyz" aria-expanded="true" aria-label="November 2026, 2 cases, open — press to close"><span class="cm-chev" aria-hidden="true"></span>'), nov.innerHTML);
  assert.ok(pend.innerHTML.includes('aria-expanded="false" aria-label="⏳ Pending — signatures &amp; payment, 1 case, closed — press to open"'));
  assert.ok(nov.innerHTML.startsWith('<td colspan="15"><span class="cm-grp-t">'), 'the heading words stay at the start when the table scrolls sideways');
  // a column sort is kept inside each group (the engine's order is not touched)
  p.draw([ALL_ROWS[2], ALL_ROWS[1], ALL_ROWS[0]], undefined, { total: 3, defaultSort: false });
  assert.deepEqual(p.look(), ['November 2026 2 ▾ n3 n1', 'October 2026 1 ▸']);
  // in a month with no group of its own, the newest month there is; with no month group, the first group
  const dec = await groupsPage({ today: '2026-12-02' });
  dec.draw(ALL_ROWS);
  assert.deepEqual(dec.look().filter((t) => t.includes('▾')), ['November 2026 2 ▾ n1 n3']);
  const none = await groupsPage();
  none.draw([ALL_ROWS[3], ALL_ROWS[6]]);
  assert.deepEqual(none.look(), ['Leads 1 ▾ l4', 'Brand new group 1 ▸']);
  // nothing matches: the usual line, and no Open all / Close all to press
  const empty = p.draw([], { q: 'zzz', sel: {} }, { total: 718 });
  assert.deepEqual({ ...empty }, { shown: 0, total: 718 });
  assert.ok(p.els['all-cases-body'].kids[0].innerHTML.includes('No cases match the current filters.'));
  assert.equal(p.els['cm-oc'].style.display, 'none');
});

test('opening and closing: a click on the heading, Open all, Close all — kept per tab by group id for this browser tab, and back after a redraw or new data', async () => {
  const p = await groupsPage();
  p.draw(ALL_ROWS);
  p.click('October 2026');
  assert.deepEqual(p.look().filter((t) => t.includes('▾')), ['November 2026 2 ▾ n1 n3', 'October 2026 1 ▾ o2']);
  assert.deepEqual(p.saved(), { all: { group_mm7qvmt1: true } }, 'kept by the board group id, not its title');
  p.click('November 2026');
  assert.deepEqual(p.look().filter((t) => t.includes('▾')), ['October 2026 1 ▾ o2']);
  assert.deepEqual(p.saved(), { all: { group_mm7qvmt1: true, group_mm8qqjyz: false } });
  // new data (a refresh, after Assign… or a deadline change the list is set again): the same groups are open; a renamed group keeps its state
  p.draw(ALL_ROWS.map((r) => (r.id === 'o2' ? { ...r, groupTitle: 'Oct 2026 (renamed)' } : r)));
  assert.deepEqual(p.look().filter((t) => t.includes('▾')), ['Oct 2026 (renamed) 1 ▾ o2']);
  // Close all / Open all
  p.ctx.cmGrpAll(false);
  assert.ok(p.look().every((t) => t.endsWith('▸')) && p.look().length === 6, 'closed: every heading still there with its count');
  p.ctx.cmGrpAll(true);
  assert.deepEqual(p.look().map((t) => t.split(' ▾')[1].trim()), ['p6', 'l4', 'n1 n3', 'o2', 's5', 'u7']);
  // a new browser page in the same tab reads the kept choices; another tab of the page has its own
  const again = await groupsPage({ store: { tdot_list_cases_groups: JSON.stringify({ all: { group_mm8qqjyz: false, group_mm2tz8e1: true }, eeita: { group_mm8qqjyz: false } }) } });
  again.draw(ALL_ROWS);
  assert.deepEqual(again.look().filter((t) => t.includes('▾')), ['Leads 1 ▾ l4']);
  const ee = ALL_ROWS.slice(0, 3).map((r) => ({ ...r, views: ['eeita'] }));
  again.draw(ee, { q: '', sel: { view: ['eeita'] } });
  assert.deepEqual(again.look(), ['November 2026 2 ▸', 'October 2026 1 ▾ o2'], 'EE after ITA: all open but the one this person closed there');
  assert.equal(again.els['cm-head'].style.display, '', 'a view tab keeps its box above the table');
  // the view tabs open with every group open, as before, and draw their rows as view rows
  const fresh = await groupsPage();
  fresh.draw(ee, { q: '', sel: { view: ['eeita'] } });
  assert.deepEqual(fresh.look(), ['November 2026 2 ▾ n1 n3', 'October 2026 1 ▾ o2']);
  assert.equal(fresh.els['all-cases-body'].kids.find((k) => k.id === 'n1').view.key, 'eeita');
  // kept junk, no storage (a private window) and Sign Out: the page still works; after Sign Out nothing is written
  const junk = await groupsPage({ store: { tdot_list_cases_groups: '{not json' } });
  junk.draw(ALL_ROWS);
  assert.deepEqual(junk.look().filter((t) => t.includes('▾')), ['November 2026 2 ▾ n1 n3']);
  const priv = await groupsPage({ noStorage: true });
  priv.draw(ALL_ROWS); priv.click('Leads');
  assert.deepEqual(priv.look().filter((t) => t.includes('▾')), ['Leads 1 ▾ l4', 'November 2026 2 ▾ n1 n3'], 'kept in memory for this page');
  const out = await groupsPage({ signedOut: true });
  out.draw(ALL_ROWS); out.click('Leads');
  assert.equal(out.saved(), null);
  assert.ok(S.casesListOpts({}).key === 'tdot_list_cases' && p.ctx.CM_GRP_KEY.indexOf('tdot_list_') === 0, 'under the lists\' prefix: Sign Out forgets it with the filters');
});

test('a search or a filter: a closed group never hides a match — every group with a match is open; closing then is only for that search; the kept choices come back unchanged', async () => {
  const p = await groupsPage();
  p.draw(ALL_ROWS);
  p.click('November 2026');                       // kept: November closed → nothing open
  assert.ok(p.look().every((t) => t.endsWith('▸')));
  const keptBefore = JSON.stringify(p.saved());
  const hits = [ALL_ROWS[1], ALL_ROWS[2], ALL_ROWS[4]];
  const out = p.draw(hits, { q: 'ann', sel: {} }, { total: 718 });
  assert.deepEqual(p.look(), ['November 2026 1 ▾ n3', 'October 2026 1 ▾ o2', 'September  2026 1 ▾ s5'], 'all three open, also the one closed by hand before');
  assert.deepEqual({ ...out }, { shown: 3, total: 718 });
  p.click('October 2026');                        // a temporary choice
  assert.deepEqual(p.look(), ['November 2026 1 ▾ n3', 'October 2026 1 ▸', 'September  2026 1 ▾ s5']);
  p.draw(hits, { q: 'ann', sel: {} });           // the same search drawn again (new data): the choice holds
  assert.equal(p.look()[1], 'October 2026 1 ▸');
  p.ctx.cmGrpAll(false);
  assert.ok(p.look().every((t) => t.endsWith('▸')));
  assert.equal(JSON.stringify(p.saved()), keptBefore, 'nothing done under a search is kept');
  p.draw(hits, { q: 'anna', sel: {} });          // the search changes: every match is on show again
  assert.ok(p.look().every((t) => t.includes('▾')));
  p.click('September  2026');
  p.draw(hits, { q: '', sel: { health: ['Red'] } });   // a filter instead of a search: the same rule
  assert.ok(p.look().every((t) => t.includes('▾')));
  p.draw(ALL_ROWS, { q: '', sel: {} });          // cleared: as it was left before the search
  assert.ok(p.look().every((t) => t.endsWith('▸')) && p.look().length === 6);
  assert.equal(JSON.stringify(p.saved()), keptBefore);
  p.draw(hits, { q: 'ann', sel: {} });           // the first search again: its old temporary choices are gone
  assert.ok(p.look().every((t) => t.includes('▾')));
  // the tab alone is not a filter
  const q = await groupsPage();
  q.draw(ALL_ROWS.map((r) => ({ ...r, views: ['eeita'] })), { q: '', sel: { view: ['eeita'] } });
  q.click('Leads');
  assert.deepEqual(q.saved(), { eeita: { group_mm2tz8e1: false } });
});

test('Assigning: each stage count is a button that opens its group, brings the heading into view and puts the focus on it; Deadlines keeps its Real / Imaginary counts on a closed heading', async () => {
  const p = await groupsPage();
  const a = [{ id: 'a1', stageIdx: 12, caseStage: 'Pre-Onboarding', views: ['assigning'], boardIdx: 1 }, { id: 'a2', stageIdx: 0, caseStage: 'Document Collection Started', views: ['assigning'], boardIdx: 2 },
    { id: 'a3', stageIdx: 12, caseStage: 'Pre-Onboarding', views: ['assigning'], boardIdx: 3 }];
  const st = { q: '', sel: { view: ['assigning'] } };
  p.draw(a, st);
  const strip = p.els['cm-head'].innerHTML.match(/<div class="cm-strip" id="cm-strip"[^>]*>(.*?)<\/div>/)[1];
  const btns = [...strip.matchAll(/<button type="button" class="cm-st tone-grey" data-go="(\d+)" onclick="cmGrpGo\(this\.dataset\.go\)" title="[^"]*">([^<]*) <b>(\d+)<\/b><\/button>/g)].map((m) => m.slice(1).join('|'));
  assert.equal(btns.length, 2, strip);
  assert.ok(btns.includes('12|Pre-Onboarding|2') && btns.some((b) => b.startsWith('0|')), 'a button per stage, keyed by the stage index, with its count');
  assert.ok(!/<span class="cm-st/.test(strip), 'no plain-text count left in the stage strip');
  p.click('Pre-Onboarding');
  assert.ok(p.look().some((t) => t === 'Pre-Onboarding 2 ▸'));
  p.ctx.cmGrpGo('12');
  assert.ok(p.look().some((t) => t === 'Pre-Onboarding 2 ▾ a1 a3'), 'opened');
  assert.deepEqual(p.saved(), { assigning: { 12: true } }, 'by the stage index');
  assert.equal(p.page.focused.attrs['data-gk'], '12');
  assert.deepEqual([p.page.scrolled.el.attrs['data-gk'], p.page.scrolled.o.behavior, p.page.scrolled.o.block], ['12', 'smooth', 'center']);
  p.page.reduced = true;
  p.ctx.cmGrpGo('0');
  assert.deepEqual([p.page.scrolled.el.attrs['data-gk'], p.page.scrolled.o.behavior], ['0', 'auto'], 'no gliding for someone who asked for less motion');
  assert.ok(p.look().some((t) => t.startsWith('Document Collection Started 1 ▾')), 'an open group stays open');
  p.ctx.cmGrpGo('999');   // a count whose group is not on screen any more: nothing happens, nothing breaks
  // the "waiting for" strip stays plain text
  assert.ok(p.main.includes("return '<span class=\"cm-st\" data-wait=\"'"));
  // a heading someone is on keeps the focus through a redraw (the keyboard: Enter closes, Enter opens again)
  p.ctx.document.activeElement = { className: 'cm-grp-b', getAttribute: () => '12' };
  p.page.focused = null;
  p.ctx.cmGrpToggle('12');
  assert.equal(p.page.focused.attrs['data-gk'], '12');
  p.ctx.document.activeElement = null;
  // Deadlines: the extra counts sit beside the button, whether the group is open or closed
  const d = await groupsPage();
  const dl = [{ id: 'd1', phaseIdx: 1, phase: 'Phase 1', views: ['deadlines'], deadlineType: 'Deadline', actualDeadline: '2026-12-01' }, { id: 'd2', phaseIdx: 1, phase: 'Phase 1', views: ['deadlines'] }];
  d.draw(dl, { q: '', sel: { view: ['deadlines'] } });
  d.click('Phase 1');
  const head = d.heads()[0].innerHTML;
  assert.deepEqual(d.look(), ['Phase 1 2 ▸']);
  assert.match(head, /<\/button> <span class="cm-grp-c">— Real \d · Imaginary \d · Not recorded \d<\/span><\/span><\/td>$/);
});

test('the look and the print: an open group is marked in navy and bound to its rows, a closed one is quiet; print shows what is on screen; Open all / Close all sit above the table', async () => {
  const html = await renderRoute('/');
  assert.ok(html.includes('.data-table tr.cm-grp.open td { background:#e2e8f0; border-top:2px solid var(--navy); border-bottom:1px solid var(--navy); color:var(--navy); }'));
  assert.ok(html.includes('.data-table tr.cm-grp td { background:#f8fafc; padding:7px 14px; font-size:12px; color:#334155; border-top:1px solid #e2e8f0; border-bottom:1px solid #e2e8f0; box-shadow:inset 4px 0 0 var(--grp, var(--navy)); cursor:pointer; }'));
  assert.ok(html.includes('.data-table tr.cm-in td:first-child { box-shadow:inset 4px 0 0 var(--grp, var(--navy)); }'), 'the group\'s colour runs down its rows');
  assert.ok(html.includes('#all-cases-table tr.cm-in.cm-last td { border-bottom:2px solid var(--navy); }'), 'and a navy line closes it');
  assert.ok(html.includes('.cm-grp.open .cm-chev { transform:rotate(90deg);'), 'not by colour alone: the chevron turns');
  assert.ok(html.includes('@media (prefers-reduced-motion: reduce) { .cm-chev { transition:none; } }'));
  assert.ok(html.includes('button.cm-st:focus-visible, .cm-oc-b:focus-visible, .cm-grp-b:focus-visible { outline:2px solid var(--navy); outline-offset:2px; }'));
  assert.ok(html.includes('.cm-grp.tone-amber, .cm-in.tone-amber, .cm-st.tone-amber { --grp:var(--st-amber-solid); }'), 'the group colours are kept, and reach the rows');
  const print = html.slice(html.indexOf('@media print {', html.indexOf('@page { size: landscape')));
  assert.ok(print.slice(0, 1800).includes('.cm-chev { display:none; }') && print.slice(0, 400).includes('.table-toolbar,'), 'print: no chevron, no Open all / Close all');
  const bar = html.slice(html.indexOf('<div class="table-toolbar">'), html.indexOf('id="cs-chips"'));
  assert.ok(bar.includes('<button type="button" class="cm-oc-b" id="cm-open-all" onclick="cmGrpAll(true)"') && bar.includes('>Open all</button>'));
  assert.ok(bar.includes('<button type="button" class="cm-oc-b" id="cm-close-all" onclick="cmGrpAll(false)"') && bar.includes('>Close all</button>'));
  assert.ok(bar.indexOf('id="search-box"') < bar.indexOf('id="cm-oc"') && bar.indexOf('id="cm-oc"') < bar.indexOf('id="table-count"'));
  assert.ok(!/id="cm-oc"|\.cm-grp-b \{/.test(await renderRoute('/summary')), 'the Summary page has neither the buttons nor the look');
});
