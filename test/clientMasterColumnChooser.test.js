'use strict';

// Client Master: the "Columns" button (team meeting 2026-11-10, item 13 — choose the columns of a tab; Faran 2026-11-12:
// each person's choice is remembered on their own browser).
//  - the rules (pure, clientMasterUi.js): what a tab offers, the equivalents, the locked two, the order, what is kept;
//  - the shared list engine: the generic pickCols hook — and the lists without it are unchanged;
//  - the page: the REAL emitted scripts (the whole page script and the engine script) run over a small fake page —
//    the header, the rows, the colspans, the wide table, the button, the panel, what the browser keeps.
// All made-up data. Nothing leaves the machine.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');
const fs     = require('fs');

const U   = require('../src/routes/clientMasterUi');
const CUI = require('../src/routes/clientMasterColumnsUi');
const cmv = require('../src/services/clientMasterViews');
const S   = require('../src/routes/listSpecs');
const { listCore, listTableUi } = require('../src/routes/listFilters');
const router = require('../src/routes/adminDashboard');

const VIEWS = cmv.pageViews();
const KEY = 'tdot_view_cm_columns_v1';
const ALL_IDS = ['caseRef', 'clientName', 'caseType', 'caseStage', 'phase', 'deadline', 'promised', 'health', 'slaRisk', 'officer', 'manager', 'overallReadiness', 'daysElapsed', 'status', 'del'];
const VIEW_IDS = ['caseRef', 'clientName', 'dependents', 'clientEmail', 'clientPhone', 'caseTypeV', 'subType', 'actualDeadline', 'deadlineType', 'internalDeadline', 'phaseV',
  'retainedBy', 'retainerStatus', 'paymentStatus', 'stageV', 'portal', 'officerV', 'managerV', 'qPct', 'docPct'];
const ALL_LABELS = ['Case Ref', 'Client', 'Type', 'Stage', 'Phase', 'Deadline', 'Promised', 'Health', 'SLA Risk', 'Support Officer', 'Manager', 'Readiness', 'Days', 'Status', ''];
const VIEW_LABELS = ['Case Ref', 'Client', 'Dependents', 'Client email', 'Contact number', 'Case type', 'Sub-type', 'Actual deadline', 'Deadline type', 'Internal deadline', 'Phase',
  'Retained by', 'Retainer status', 'Payment status', 'Stage', 'Client portal', 'Support officer', 'Case manager', 'Questionnaire %', 'Documents uploaded %'];
const ALL_CAN_ADD = ['dependents', 'clientEmail', 'clientPhone', 'subType', 'deadlineType', 'retainedBy', 'retainerStatus', 'paymentStatus', 'portal', 'qPct', 'docPct'];
const VIEW_CAN_ADD = ['health', 'slaRisk', 'overallReadiness', 'daysElapsed', 'status'];
const TC = { '': ALL_IDS, assigning: VIEW_IDS, deadlines: VIEW_IDS, eeita: VIEW_IDS };

/* ── the rules (pure) ── */

test('the column sets the rules are built on are the list\'s own (so the expectations below are about the real page)', () => {
  const cols = S.casesListOpts({ views: VIEWS }).cols, on = listCore({}).colsOnTab;
  assert.deepEqual(on(cols, '').map((c) => c.id), ALL_IDS);
  for (const v of VIEWS) assert.deepEqual(on(cols, v.key).map((c) => c.id), VIEW_IDS, v.key);
  assert.deepEqual(VIEWS.map((v) => v.key), ['assigning', 'deadlines', 'eeita']);
});

test('what a tab offers: its own columns, plus the other set\'s columns that have no equivalent on it — All can add eleven, a view tab five', () => {
  const all = U.colPlan(TC, '');
  assert.deepEqual(all.own, ALL_IDS.slice(0, -1), 'All\'s own, in table order, without the delete column');
  assert.deepEqual(all.fixed, ['del'], 'the delete column is not a choice: it stays');
  assert.deepEqual(all.locked, ['caseRef', 'clientName']);
  assert.deepEqual(all.extra, ALL_CAN_ADD, 'in the view tabs\' own order');
  for (const v of VIEWS) {
    const p = U.colPlan(TC, v.key);
    assert.deepEqual(p.own, VIEW_IDS, v.key);
    assert.deepEqual(p.fixed, [], v.key + ': no delete column on a view tab');
    assert.deepEqual(p.locked, ['caseRef', 'clientName']);
    assert.deepEqual(p.extra, VIEW_CAN_ADD, v.key + ': Health, SLA Risk, Readiness, Days, Status — in All\'s order');
  }
  // an unknown tab reads as All; nothing given = nothing offered
  assert.deepEqual(U.colPlan(TC, 'no-such-tab'), all);
  assert.deepEqual(U.colPlan(TC, null), all);
  assert.deepEqual(U.colPlan(null, ''), { tab: '', own: [], extra: [], fixed: [], locked: [] });
});

test('the equivalents are data, defined once: seven pairs, each All column with the view tabs\' column for the same thing — never both on one tab', () => {
  assert.deepEqual(U.COL_SAME, [['caseType', 'caseTypeV'], ['caseStage', 'stageV'], ['phase', 'phaseV'], ['deadline', 'actualDeadline'],
    ['promised', 'internalDeadline'], ['officer', 'officerV'], ['manager', 'managerV']]);
  for (const [a, b] of U.COL_SAME) {
    assert.ok(ALL_IDS.includes(a) && VIEW_IDS.includes(b), a + ' / ' + b + ' are real columns, one of each set');
    assert.deepEqual(U.colSame(a), [b]); assert.deepEqual(U.colSame(b), [a]);
    for (const tab of Object.keys(TC)) {
      const p = U.colPlan(TC, tab), offered = p.own.concat(p.extra);
      assert.ok(!(offered.includes(a) && offered.includes(b)), tab + ': ' + a + ' and ' + b + ' are never both offered');
      // … and never both drawn, whatever was kept
      const ids = U.colIds(p, { hidden: [], added: [a, b] });
      assert.ok(!(ids.includes(a) && ids.includes(b)));
    }
  }
  assert.deepEqual(U.colSame('health'), []); assert.deepEqual(U.colSame('deadlineType'), [], 'Deadline type is its own column: All may add it beside its Deadline');
  // every column of either set is either on a tab, addable to it, or the equivalent of one that is
  for (const tab of Object.keys(TC)) {
    const p = U.colPlan(TC, tab), offered = p.own.concat(p.extra, p.fixed);
    for (const id of new Set(ALL_IDS.concat(VIEW_IDS))) {
      if (id === 'del') continue;
      assert.ok(offered.includes(id) || U.colSame(id).some((x) => offered.includes(x)), tab + ': ' + id + ' is reachable');
    }
  }
  // two extras that are equivalents of each other (neither on the tab): only the first is offered
  assert.deepEqual(U.colPlan({ x: ['caseRef'], '': ['caseRef', 'phase'], y: ['caseRef', 'phaseV', 'qPct'] }, 'x').extra, ['phase', 'qPct']);
});

test('the columns to draw: the default with no choice; hidden ones go; added ones come after the tab\'s own in their own set\'s order, before All\'s delete column', () => {
  const all = U.colPlan(TC, ''), asg = U.colPlan(TC, 'assigning');
  assert.deepEqual(U.colIds(all, null), ALL_IDS);
  assert.deepEqual(U.colIds(all, undefined), ALL_IDS);
  assert.deepEqual(U.colIds(all, { hidden: [], added: [] }), ALL_IDS);
  assert.deepEqual(U.colIds(asg, null), VIEW_IDS);
  // ticked in the "wrong" order: the place is fixed
  assert.deepEqual(U.colIds(all, { hidden: ['status', 'health'], added: ['docPct', 'portal', 'dependents'] }),
    ['caseRef', 'clientName', 'caseType', 'caseStage', 'phase', 'deadline', 'promised', 'slaRisk', 'officer', 'manager', 'overallReadiness', 'daysElapsed', 'dependents', 'portal', 'docPct', 'del']);
  assert.deepEqual(U.colIds(asg, { hidden: ['dependents', 'docPct'], added: ['status', 'health'] }),
    VIEW_IDS.filter((id) => id !== 'dependents' && id !== 'docPct').concat(['health', 'status']));
});

test('Case Ref and Client are always shown — a kept "hidden" for them is ignored and a toggle changes nothing — so the table can never be emptied', () => {
  for (const tab of Object.keys(TC)) {
    const p = U.colPlan(TC, tab);
    const everything = { hidden: p.own.concat(p.fixed, ['del']), added: [] };
    assert.deepEqual(U.colIds(p, everything), ['caseRef', 'clientName'].concat(p.fixed), tab + ': the two (and All\'s delete column) always remain');
    assert.deepEqual(U.colPref(p, everything).hidden, p.own.slice(2));
    let pr = null;
    for (const id of p.own) pr = U.colToggle(p, pr, id, false);
    assert.deepEqual(U.colIds(p, pr).slice(0, 2), ['caseRef', 'clientName'], tab);
    assert.deepEqual(U.colToggle(p, null, 'caseRef', false), { hidden: [], added: [] });
    assert.deepEqual(U.colToggle(p, null, 'clientName', false), { hidden: [], added: [] });
    assert.deepEqual(U.colToggle(p, null, 'del', false), { hidden: [], added: [] }, 'the delete column is not a choice');
  }
});

test('unknown and stale ids are ignored: an id that is gone, an equivalent, another tab\'s own column, junk shapes', () => {
  const all = U.colPlan(TC, ''), asg = U.colPlan(TC, 'assigning');
  assert.deepEqual(U.colIds(all, { hidden: ['gone', 'dependents', 42, null], added: ['nope', 'caseTypeV', 'stageV', 'health', 'qPct', 'qPct', {}] }), ALL_IDS.slice(0, -1).concat(['qPct', 'del']),
    'caseTypeV / stageV are equivalents of columns All has; health is All\'s own; qPct counts once');
  assert.deepEqual(U.colPref(all, { hidden: ['gone', 'health'], added: ['nope', 'qPct'] }), { hidden: ['health'], added: ['qPct'] });
  assert.deepEqual(U.colIds(asg, { hidden: ['health'], added: ['dependents', 'caseType', 'del'] }), VIEW_IDS, 'hiding a column the tab does not have, adding one it already has / an equivalent / the delete column');
  for (const junk of ['x', 7, [], true, { hidden: 'health', added: { a: 1 } }, { hidden: null }]) assert.deepEqual(U.colIds(all, junk), ALL_IDS, JSON.stringify(junk));
  assert.deepEqual(U.colToggle(all, null, 'no-such-column', true), { hidden: [], added: [] });
  assert.deepEqual(U.colToggle(all, null, 'caseTypeV', true), { hidden: [], added: [] }, 'an equivalent cannot be added');
});

test('a toggle: untick one of the tab\'s own = hidden, tick it = back; tick one of the others = added, untick = gone; back at the default nothing is left', () => {
  const p = U.colPlan(TC, '');
  let pr = U.colToggle(p, null, 'health', false);
  assert.deepEqual(pr, { hidden: ['health'], added: [] });
  pr = U.colToggle(p, pr, 'health', false);
  assert.deepEqual(pr, { hidden: ['health'], added: [] }, 'twice is once');
  pr = U.colToggle(p, pr, 'portal', true);
  assert.deepEqual(pr, { hidden: ['health'], added: ['portal'] });
  assert.deepEqual(U.colSummary(p, pr), { hidden: 1, added: 1, custom: true, text: '1 hidden, 1 added' });
  pr = U.colToggle(p, pr, 'health', true);
  assert.deepEqual(U.colSummary(p, pr), { hidden: 0, added: 1, custom: true, text: '1 added' });
  pr = U.colToggle(p, pr, 'portal', false);
  assert.deepEqual(pr, { hidden: [], added: [] });
  assert.deepEqual(U.colSummary(p, pr), { hidden: 0, added: 0, custom: false, text: '' });
  assert.deepEqual(U.colSummary(p, { hidden: ['phase', 'status', 'slaRisk', 'gone'], added: [] }).text, '3 hidden', 'a stale id is not counted');
  // the input is never changed
  const kept = { hidden: ['health'], added: [] };
  U.colToggle(p, kept, 'phase', false);
  assert.deepEqual(kept, { hidden: ['health'], added: [] });
});

test('only the DIFFERENCE is kept, so a later release changes the default by itself: a new default column shows; a hidden one stays hidden; an added one that became a default is just there', () => {
  const kept = { hidden: ['health'], added: ['portal', 'qPct'] };
  // a release adds "newCol" to All's default and makes Client portal a default column of All
  const TC2 = { ...TC, '': ['caseRef', 'clientName', 'caseType', 'newCol', 'caseStage', 'phase', 'deadline', 'promised', 'health', 'slaRisk', 'officer', 'manager', 'overallReadiness', 'daysElapsed', 'status', 'portal', 'del'] };
  const p2 = U.colPlan(TC2, '');
  assert.deepEqual(U.colIds(p2, kept), ['caseRef', 'clientName', 'caseType', 'newCol', 'caseStage', 'phase', 'deadline', 'promised', 'slaRisk', 'officer', 'manager', 'overallReadiness', 'daysElapsed', 'status', 'portal', 'qPct', 'del']);
  assert.deepEqual(U.colSummary(p2, kept), { hidden: 1, added: 1, custom: true, text: '1 hidden, 1 added' });
  // a release takes Health off All altogether: the kept "hidden: health" is ignored (and Health can be added from nowhere)
  const TC3 = { ...TC, '': ALL_IDS.filter((id) => id !== 'health') };
  assert.deepEqual(U.colIds(U.colPlan(TC3, ''), kept), ALL_IDS.filter((id) => id !== 'health' && id !== 'del').concat(['portal', 'qPct', 'del']));
  // a new column on the view tabs is offered to All, unticked
  const TC4 = { ...TC, assigning: VIEW_IDS.concat(['brandNew']) };
  assert.ok(U.colPlan(TC4, '').extra.includes('brandNew'));
  assert.ok(!U.colIds(U.colPlan(TC4, ''), kept).includes('brandNew'));
  assert.ok(U.colIds(U.colPlan(TC4, 'assigning'), null).includes('brandNew'), 'and shows on its own tab at once');
});

test('what is kept: one versioned value, per tab, shape-checked — another version, junk, or an empty choice is nothing', () => {
  assert.deepEqual(U.colStore({ v: 1, tabs: { all: { hidden: ['health'], added: [] }, assigning: { hidden: [], added: ['status', 'status', 5] }, deadlines: { hidden: [], added: [] }, eeita: 'x', bad: null, arr: [] } }),
    { all: { hidden: ['health'], added: [] }, assigning: { hidden: [], added: ['status'] } });
  for (const junk of [null, undefined, 'x', 3, [], {}, { v: 2, tabs: { all: { hidden: ['health'] } } }, { tabs: { all: { hidden: ['health'] } } }, { v: 1 }, { v: 1, tabs: [] }, { v: 1, tabs: 'x' }]) assert.deepEqual(U.colStore(junk), {}, JSON.stringify(junk));
  assert.deepEqual(U.colStoreOut({ all: { hidden: ['health'], added: [] } }), { v: 1, tabs: { all: { hidden: ['health'], added: [] } } });
  assert.equal(U.colStoreOut({ all: { hidden: [], added: [] } }), null, 'every tab at its default: nothing to keep');
  assert.equal(U.colStoreOut({}), null); assert.equal(U.colStoreOut(null), null);
  assert.equal(U.colTabKey(''), 'all'); assert.equal(U.colTabKey(null), 'all'); assert.equal(U.colTabKey('assigning'), 'assigning');
  assert.ok(!VIEWS.some((v) => v.key === 'all'), 'no view tab is called "all" (All\'s storage name)');
});

test('the wide table: a view tab always; All only once a column of the view tabs is added (hiding columns does not make it wide)', () => {
  assert.equal(U.colWide(TC, '', ALL_IDS), false);
  assert.equal(U.colWide(TC, '', ['caseRef', 'clientName', 'del']), false);
  assert.equal(U.colWide(TC, '', ALL_IDS.concat(['portal'])), true);
  for (const v of VIEWS) { assert.equal(U.colWide(TC, v.key, VIEW_IDS), true); assert.equal(U.colWide(TC, v.key, ['caseRef', 'clientName']), true); }
});

test('the rules are plain browser code: injected whole (the function refers to nothing outside itself), no template-literal traps', () => {
  for (const fn of [U.clientMasterUi, CUI.clientMasterColumnsUi]) {
    const src = fn.toString();
    assert.ok(!/`|\$\{|<\/script/i.test(src), fn.name);
    new vm.Script('(' + src + ')');
  }
  const made = vm.runInNewContext('(' + U.clientMasterUi.toString() + ')({ typeOf: function () { return "none"; } })');
  assert.deepEqual(JSON.parse(JSON.stringify(made.colPlan(TC, 'assigning').extra)), VIEW_CAN_ADD);
  assert.equal(CUI.CM_COLUMNS_KEY, KEY);
});

/* ── the shared list engine: the generic hook ── */

function enginePage(spec, opts, extra) {
  const el = (o) => ({ innerHTML: '', value: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, contains() { return false; }, focus() {}, ...o });
  const els = { [opts.ids.head]: el(), [opts.ids.chips]: el(), [opts.ids.count]: el({ textContent: '' }) };
  if (opts.quick) els[opts.quick.box] = el();
  const kept = new Map(), drawn = [];
  const win = { document: { getElementById: (id) => els[id] || null, createElement: () => el(), body: el(), addEventListener() {}, activeElement: null, documentElement: el(), dispatchEvent() {} },
    sessionStorage: { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => { kept.set(k, String(v)); } }, addEventListener() {}, location: { search: '' }, innerWidth: 1200, innerHeight: 800,
    CustomEvent: function () {}, [opts.render]: (rows) => { drawn.push(rows.map((r) => r.id).join(',')); }, ...(extra || {}) };
  const api = listTableUi(listCore(spec), opts, win);
  const head = () => [...els[opts.ids.head].innerHTML.matchAll(/<th scope="col"[^>]*>(?:<div class="th-in">)?(?:<button[^>]*class="th-l th-sortbtn"[^>]*>|<span class="th-l">)?([^<]*)/g)].map((m) => m[1]);
  const chips = () => [...els[opts.ids.chips].innerHTML.matchAll(/<span class="q-chip[^"]*">([^<]*)</g)].map((m) => m[1]);
  return { api, els, win, drawn, head, chips, html: () => els[opts.ids.head].innerHTML, tab(v) { if (v) api.state().sel[opts.quick.facet] = [v]; else delete api.state().sel[opts.quick.facet]; api.apply('filter'); } };
}

test('the engine hook (pickCols): a page may answer the columns to draw, in its order — only this list\'s columns count; no answer, an empty one, junk or an error = the list\'s own columns', () => {
  const spec = { facets: { kind: { label: 'Kind', get: (r) => r.kind }, tab: { label: 'Tab', quick: true, order: ['x'], get: (r) => r.tab } }, sorts: { name: (r) => r.name }, defaultSort: null };
  const mk = () => ({ key: 'tdot_list_t', ids: { head: 'h', chips: 'c', count: 'n', search: 's', pop: 'p' }, render: 'draw', api: 'T', pickCols: 'pick', sortReset: 'the normal order',
    quick: { facet: 'tab', box: 'q', tabs: true, values: ['x'] },
    cols: [{ id: 'a', label: 'A', sort: 'name', sortText: ['A → Z', 'Z → A'], sortDirs: ['asc', 'desc'] }, { id: 'b', label: 'B', menu: 'facet', facets: ['kind'] }, { id: 'c', label: 'C', tabs: ['x'] }, { id: 'd', label: 'D', tabs: [''] }] });
  const calls = [];
  let answer = (cols, tab, all) => { calls.push([cols.map((c) => c.id).join(''), tab, all.map((c) => c.id).join('')]); return [all[3], all[0]]; };
  const o = mk(), p = enginePage(spec, o, { pick: (...a) => answer(...a) });
  p.api.setRows([{ id: '1', kind: 'k', name: 'n' }]);
  assert.deepEqual(p.head(), ['D', 'A'], 'the page\'s columns, in the page\'s order');
  assert.deepEqual(calls[0], ['abd', '', 'abcd'], 'it is handed the tab\'s columns, the tab and every column');
  p.tab('x');
  assert.deepEqual(calls[calls.length - 1], ['abc', 'x', 'abcd']);
  // a filter and a sort on columns that are not drawn stay on and stay visible
  p.api.state().sel.kind = ['k']; p.api.state().sort = { key: 'name', dir: 'asc' };
  answer = (cols, tab, all) => [all[2]];
  p.api.apply('filter');
  assert.deepEqual(p.head(), ['C']);
  assert.deepEqual(p.chips(), ['Sorted: A (A → Z)', 'Kind: k'], 'never an invisible filter or sort');
  // what does not count
  const own = ['A', 'B', 'C'];
  for (const [bad, why] of [[() => null, 'no answer'], [() => [], 'an empty answer'], [() => 'abc', 'not a list'], [() => { throw new Error('boom'); }, 'an error'], [() => [{ id: 'a', label: 'A' }, { id: 'zz', label: 'ZZ' }], 'columns that are not this list\'s own objects']]) {
    answer = bad; p.api.apply('filter');
    assert.deepEqual(p.head(), own, why);
  }
  answer = (cols, tab, all) => [all[1], { id: 'zz', label: 'ZZ' }, all[1], all[0]]; p.api.apply('filter');
  assert.deepEqual(p.head(), ['B', 'A'], 'a foreign column is dropped, a column named twice is drawn once');
  // the function is not on the page at all: the list's own columns
  const q = enginePage(spec, mk());
  q.api.setRows([]);
  assert.deepEqual(q.head(), ['A', 'B', 'D']);
});

test('pages WITHOUT the hook are unchanged: Leads, Consultations and Retainers do not ask for it, and their header is the same text with a pickCols function on the page as without one', () => {
  const leads = require('../src/routes/leadsTableFilters');
  const lists = [['leads', leads.leadsTableSpec || leads.leadsListSpec, leads.leadsTableOpts, {}],
    ['consultations', S.consultListSpec, S.consultListOpts, { today: () => '2026-11-12' }],
    ['retainers', S.retainerListSpec, S.retainerListOpts, { outcomes: ['Retain', 'Follow-Up', 'Newsletter', 'Not Wanted', 'Retained'], apart: ['Retained'], today: () => '2026-11-12' }]];
  let checked = 0;
  for (const [name, specFn, optsFn, ctx] of lists) {
    assert.ok(!('pickCols' in optsFn(ctx)), name + ' does not ask for chosen columns');
    assert.ok(!/pickCols/.test(optsFn.toString()), name);
    if (typeof specFn !== 'function') continue;
    // the same list twice: once with stray functions named like the Client Master's on the page — they are never called
    let called = 0;
    const plain = enginePage(specFn(ctx), optsFn(ctx));
    const stray = enginePage(specFn(ctx), optsFn(ctx), { cmPickCols: () => { called++; return []; }, pickCols: () => { called++; return []; }, undefined: () => { called++; return []; } });
    for (const p of [plain, stray]) p.api.setRows([]);
    assert.equal(plain.head().length, optsFn(ctx).cols.length, name + ': every column is drawn');
    assert.equal(stray.html(), plain.html(), name + ': the very same header html');
    const opts = optsFn(ctx);
    if (opts.quick) for (const v of opts.quick.values.concat([''])) { plain.tab(v); stray.tab(v); assert.equal(stray.html(), plain.html(), name + ' on tab ' + (v || 'All')); }
    assert.equal(called, 0, name);
    checked++;
  }
  assert.ok(checked >= 2, 'at least Consultations and Retainers were run through the engine');
  // only the Client Master list asks
  assert.equal(S.casesListOpts({ views: VIEWS }).pickCols, 'cmPickCols');
  // the engine's own text: without the hook (and without per-tab columns) the old one-line answer
  assert.ok(listTableUi.toString().includes('if (!TABBED && !PICKS) return COLS;'));
});

/* ── the page: the real emitted scripts over a small fake page ── */

function renderRoute(path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
}
function inlineScripts(html) { return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]); }

/* A browser store: a Map behind the Storage methods. blocked = every use throws (storage switched off). */
function storage(init, blocked) {
  const m = new Map(Object.entries(init || {})), writes = [];
  const no = () => { throw new Error('storage is blocked'); };
  if (blocked) return { m, writes, api: { getItem: no, setItem: no, removeItem: no, key: no, get length() { return no(); } } };
  return { m, writes, api: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { writes.push(['set', k]); m.set(k, String(v)); }, removeItem: (k) => { writes.push(['remove', k]); m.delete(k); },
    key: (i) => [...m.keys()][i] === undefined ? null : [...m.keys()][i], get length() { return m.size; } } };
}

let PAGE_HTML = null;
/* The Client Master page in a fake window: BOTH emitted scripts run as they are (the page script, then the list engine's). */
async function cmPage({ local = {}, session = {}, blocked = false, noLocal = false, view = '', admin = true } = {}) {
  PAGE_HTML = PAGE_HTML || await renderRoute('/');
  const scripts = inlineScripts(PAGE_HTML);
  assert.equal(scripts.length, 2, 'the page script and the list engine\'s');
  const els = {}, listeners = {};
  const doc = { activeElement: null, readyState: 'loading' };
  function mk(tag, id) {
    const e = { tag, id: id || '', _html: '', kids: [], style: {}, attrs: {}, className: '', value: '', title: '', textContent: '', disabled: false, onclick: null, parentNode: null, scrollWidth: 1000, clientWidth: 1000,
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.kids.push(c); c.parentNode = this; return c; }, insertBefore(c) { this.kids.push(c); return c; }, removeChild() {}, addEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, contains(x) { return x === this; }, closest() { return null; }, focus() { doc.activeElement = this; }, scrollIntoView() {},
      getBoundingClientRect() { return { left: 640, right: 720, top: 270, bottom: 300, width: 80, height: 30 }; } };
    const words = () => e.className.split(/\s+/).filter(Boolean);
    e.classList = { contains: (c) => words().includes(c), add: (c) => { if (!words().includes(c)) e.className = words().concat([c]).join(' '); }, remove: (c) => { e.className = words().filter((w) => w !== c).join(' '); },
      toggle: (c, on) => { const has = words().includes(c), want = on === undefined ? !has : !!on; if (want && !has) e.classList.add(c); if (!want && has) e.classList.remove(c); return want; } };
    Object.defineProperty(e, 'innerHTML', { get() { return this._html; }, set(v) { this._html = String(v); this.kids = []; } });
    return e;
  }
  const get = (id) => els[id] || null;
  // what the page's html has (the ids the scripts use); the two pop-ups are made by the scripts themselves
  for (const id of ['cs-quick', 'cm-head', 'search-box', 'cm-oc', 'cm-cols-btn', 'table-count', 'cs-chips', 'cs-headrow', 'all-cases-body', 'refresh-btn', 'loading', 'content', 'error-msg']) els[id] = mk('div', id);
  for (const id of ['search-box', 'cm-oc', 'cm-cols-btn', 'table-count', 'cs-chips', 'cs-headrow', 'all-cases-body']) assert.ok(PAGE_HTML.includes('id="' + id + '"'), id + ' is in the page');
  els['all-cases-table'] = mk('table', 'all-cases-table'); els['all-cases-table'].className = 'data-table';
  const wrap = mk('div'); wrap.className = 'tbl-wrap'; els['all-cases-table'].parentNode = wrap;
  els['cm-cols-btn'].className = 'cm-oc-b cm-cols-b'; els['cm-cols-btn'].attrs = { 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': 'Columns' }; els['cm-cols-btn']._html = 'Columns';
  const body = mk('body');
  body.appendChild = (c) => { if (c.id) els[c.id] = c; return c; };
  Object.assign(doc, { getElementById: get, createElement: (t) => mk(t), body, documentElement: mk('html'), querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, dispatchEvent: (ev) => { (listeners[ev.type] || []).forEach((f) => f(ev)); return true; } });
  const ls = storage(local, blocked), ss = storage(session, blocked);
  const ctx = { document: doc, console, URL, URLSearchParams, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame() {},
    location: { search: view ? '?view=' + view : '', href: 'https://staff.example/admin/dashboard' + (view ? '?view=' + view : ''), pathname: '/admin/dashboard', replace() {} }, history: { replaceState() {} },
    innerWidth: 1440, innerHeight: 900, addEventListener() {}, matchMedia: () => ({ matches: true }), fetch: () => new Promise(() => {}), TDOT_IS_ADMIN: admin,
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; } };
  ctx.sessionStorage = ss.api;
  if (!noLocal) Object.defineProperty(ctx, 'localStorage', blocked ? { get() { throw new Error('storage is blocked'); }, configurable: true } : { value: ls.api, writable: true, configurable: true });
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const s of scripts) vm.runInContext(s, ctx);
  ctx.cmToday = () => '2026-11-12';   // a fixed day (the windows and the flags are counted from it)
  const fire = (type, ev) => doc.dispatchEvent({ type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...ev });
  const headRow = els['cs-headrow'];
  const p = { ctx, els, wrap, ls, ss, doc, fire,
    cols: () => ctx.CMCOLS, btn: els['cm-cols-btn'], pop: () => els['cm-cols-pop'] || null, table: els['all-cases-table'],
    setRows(rows) { ctx._data = { meta: null, cases: rows }; ctx.CasesTable.setRows(rows); },
    tab(v) { const st = ctx.CasesTable.state(); if (v) st.sel.view = [v]; else delete st.sel.view; ctx.CasesTable.apply('filter'); },
    headHtml: () => headRow.innerHTML,
    head: () => [...headRow.innerHTML.matchAll(/<th scope="col"[^>]*>(?:<div class="th-in">)?(?:<button[^>]*class="th-l th-sortbtn"[^>]*>|<span class="th-l">)?([^<]*)/g)].map((m) => m[1]),
    chips: () => [...els['cs-chips'].innerHTML.matchAll(/<span class="q-chip[^"]*">([^<]*)</g)].map((m) => m[1]),
    groups: () => els['all-cases-body'].kids.filter((k) => /^cm-grp /.test(k.className)),
    rows: () => els['all-cases-body'].kids.filter((k) => /(^| )cm-in( |$)/.test(k.className)),
    none: () => els['all-cases-body'].kids.find((k) => k.className === 'cm-none') || null,
    cells: (tr) => tr.innerHTML.split('</td>').slice(0, -1).map((c) => c + '</td>'),
    spans: () => p.groups().map((g) => Number(g.innerHTML.match(/^<td colspan="(\d+)"/)[1])),
    boxes: () => [...(p.pop() ? p.pop().innerHTML : '').matchAll(/<input type="checkbox" data-colpick="([^"]+)"( checked)?( disabled)?>/g)].map((m) => m[1] + (m[2] ? '+' : '-') + (m[3] ? '!' : '')),
    kept: () => (ls.m.has(KEY) ? JSON.parse(ls.m.get(KEY)) : null),
    /** header, every row and every group heading agree on n columns */
    agree(n, why) {
      assert.equal(p.head().length, n, why + ': the header');
      assert.ok(p.rows().length > 0, why + ': rows are drawn');
      for (const r of p.rows()) assert.equal(p.cells(r).length, n, why + ': a row\'s cells');
      for (const s of p.spans()) assert.equal(s, n, why + ': a group heading\'s colspan');
    } };
  return p;
}
const PORTAL = 'https://portal.example/client/2026-XX-001?token=made-up-token-1';
const CASES = [
  { id: '1', caseRef: '2026-XX-001', clientName: 'Test Person', caseType: 'Express Entry — Canadian Experience Class', caseSubType: 'Inland', caseStage: 'Pre-Onboarding', stageIdx: cmv.PRE_ONBOARDING_INDEX, health: 'Red', slaRisk: 'Green',
    phase: 'Phase 11', phaseIdx: 6, deadlineType: 'Deadline', actualDeadline: '2026-11-20', promisedDate: '2026-11-18', officer: 'Ann Lee', manager: 'Gia Manager', overallReadiness: 60, daysElapsed: 12,
    dependents: 'Spouse: Rita Example', clientEmail: 'client.one@example.com', clientPhone: '14165550134', retainedBy: 'Staff One', retainerStatus: 'PR Signed', paymentStatus: 'Paid', portalLink: PORTAL, qReadinessPct: 85, docUploadedPct: 40,
    groupId: 'g_nov', groupTitle: 'November 2026', boardIdx: 0, createdAt: '2026-11-03T10:00:00Z', views: ['assigning', 'deadlines', 'eeita'], canAssign: true, canChangeDeadline: true, officerIds: { personIds: ['1'], teamIds: [] },
    waiting: { code: 'payment', also: [], partPaid: false } },
  { id: '2', caseRef: '2026-XX-002', clientName: 'Second Sample', caseType: 'Visitor Visa', caseSubType: '', caseStage: 'Internal Review', stageIdx: 1, health: 'Green', slaRisk: 'Orange',
    phase: 'Phase 8', phaseIdx: 4, deadlineType: 'Imaginary', actualDeadline: '2026-12-02', promisedDate: '2026-11-10', officer: '', manager: 'Unassigned', overallReadiness: 20, daysElapsed: 3,
    dependents: '', clientEmail: '', clientPhone: '', retainedBy: '', retainerStatus: '', paymentStatus: '', portalLink: '', qReadinessPct: null, docUploadedPct: 10,
    groupId: 'g_nov', groupTitle: 'November 2026', boardIdx: 1, createdAt: '2026-11-02T10:00:00Z', views: ['assigning', 'deadlines'], canAssign: true, canChangeDeadline: true, officerIds: { personIds: [], teamIds: [] } },
  { id: '3', caseRef: '', clientName: 'No Ref Yet', caseType: 'Study Permit', caseSubType: 'Extension', caseStage: 'Document Collection Started', stageIdx: 0, health: 'Orange', slaRisk: 'Green',
    phase: '', deadlineType: '', actualDeadline: '', promisedDate: '', officer: 'Ben Roy', manager: 'Gia Manager', overallReadiness: 75, daysElapsed: 40, clientBlocked: true,
    dependents: 'Child: Omar Example', clientEmail: 'third@example.com', clientPhone: '19055550199', retainedBy: 'Staff Two', retainerStatus: 'Sent', paymentStatus: 'Not Paid', portalLink: '', qReadinessPct: 0, docUploadedPct: 10,
    groupId: 'g_nov', groupTitle: 'November 2026', boardIdx: 2, createdAt: '2026-11-01T10:00:00Z', views: ['assigning'], officerIds: { personIds: ['2'], teamIds: [] } },
  { id: '4', caseRef: '2026-XX-004', clientName: 'Older Case', caseType: 'PR Card', caseSubType: '', caseStage: 'Submitted', stageIdx: 2, health: 'Green', slaRisk: 'Green',
    phase: 'Phase 2', phaseIdx: 1, deadlineType: '', actualDeadline: '', promisedDate: '', officer: 'Ann Lee', manager: 'Gia Manager', overallReadiness: 100, daysElapsed: 90,
    groupId: 'g_oct', groupTitle: 'October 2026', boardIdx: 3, createdAt: '2026-10-05T10:00:00Z', views: [], officerIds: { personIds: ['1'], teamIds: [] } },
];
const rowsCopy = () => JSON.parse(JSON.stringify(CASES));

test('every emitted script parses; the Columns code is on the Client Master page only — the Summary page has none of it', async () => {
  const html = await renderRoute('/');
  for (const s of inlineScripts(html)) new vm.Script(s);
  const main = inlineScripts(html)[0];
  assert.ok(main.includes('var CMCOLS = (function clientMasterColumnsUi(win, CMU, cfg) {') && main.includes('key: "' + KEY + '"') && main.includes('function cmPickCols(cols, tab, all) {'));
  assert.ok(inlineScripts(html)[1].includes("pickCols: 'cmPickCols'"));
  // the names the panel lists are the list's own column names
  const names = JSON.parse(main.match(/var CM_COLNAMES = (\{.*?\});/)[1]);
  const cols = S.casesListOpts({ views: VIEWS }).cols;
  assert.deepEqual(names, Object.fromEntries(cols.filter((c) => c.label).map((c) => [c.id, c.label])));
  assert.ok(!('del' in names));
  const sum = await renderRoute('/summary');
  for (const s of inlineScripts(sum)) new vm.Script(s);
  assert.ok(!sum.includes('function clientMasterColumnsUi') && !sum.includes('var CMCOLS') && !sum.includes('cm-cols-btn') && !sum.includes('CM_COLNAMES') && !sum.includes(KEY));
  // the function cmColIds the Summary script still carries never touches CMCOLS when it is not on the page
  assert.ok(inlineScripts(sum)[0].includes("(typeof CMCOLS !== 'undefined' && CMCOLS) ? CMCOLS.ids(k) : CM_TABCOLS[k]"));
});

test('the button: a real button in the table toolbar, after Open all / Close all, outside their group (it stays when the list is empty), with the pop-up attributes; hidden on paper with the rest of the toolbar', async () => {
  const html = await renderRoute('/');
  const bar = html.slice(html.indexOf('<div class="table-toolbar">'), html.indexOf('<div id="cs-chips"'));
  assert.match(bar, /id="cm-close-all"[^>]*>Close all<\/button>\s*<\/span>\s*<!--[^>]*-->\s*<button type="button" class="cm-oc-b cm-cols-b" id="cm-cols-btn" aria-haspopup="dialog" aria-expanded="false" aria-label="Columns" title="Choose the columns of this tab">Columns<\/button>\s*<span class="table-count"/);
  assert.ok(bar.indexOf('id="cm-oc"') < bar.indexOf('id="cm-cols-btn"') && bar.indexOf('</span>', bar.indexOf('id="cm-close-all"')) < bar.indexOf('id="cm-cols-btn"'));
  assert.ok(html.includes('.cm-cols-b.on { border-color:var(--st-blue-solid); background:var(--st-blue-bg); color:var(--st-blue-fg); }'));
  assert.ok(html.includes('.cm-oc-b:focus-visible') && html.includes('.table-toolbar {') && /display: flex; align-items: center; gap: 12px; flex-wrap: wrap;/.test(html), 'the toolbar wraps on a narrow screen');
  const print = html.slice(html.indexOf('@media print {', html.indexOf('@page { size: landscape')));
  assert.match(print, /\.table-toolbar,[^{]*\.lt-pop[^{]*\{ display:none !important; \}/);
  // with nothing to show the Open all / Close all group is hidden — the Columns button is not inside it
  const p = await cmPage();
  p.setRows([]);
  assert.equal(p.els['cm-oc'].style.display, 'none');
  assert.notEqual(p.btn.style.display, 'none');
});

test('All at its default is exactly what it was: the same header html and the same row html as a page without the chooser, the plain table, the plain scroll box', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  assert.deepEqual(p.head(), ALL_LABELS);
  assert.equal(p.table.className, 'data-table');
  assert.deepEqual(p.wrap.attrs, {}); assert.ok(!p.wrap.classList.contains('cm-scroll'));
  p.agree(15, 'All');
  assert.equal(p.btn.innerHTML, 'Columns'); assert.equal(p.btn.attrs['aria-label'], 'Columns on All'); assert.ok(!p.btn.classList.contains('on'));
  assert.equal(p.ls.writes.length, 0, 'looking at the page keeps nothing');
  // the header: the engine with no hook on the page (the code path of before this change) gives the very same html
  const opts = S.casesListOpts({ views: VIEWS });
  const spec = S.casesListSpec({ healthOrder: { Red: 0, Orange: 1, Green: 2 }, views: VIEWS });
  const base = enginePage(spec, opts);
  base.api.setRows(rowsCopy());
  assert.equal(p.headHtml(), base.html());
  // the rows: caseRow without the chooser on the page (CMCOLS undefined → CM_TABCOLS, as before) gives the very same html
  const row = (c, v) => { const saved = p.ctx.CMCOLS; p.ctx.CMCOLS = undefined; try { return p.ctx.caseRow(c, v, '2026-11-12').innerHTML; } finally { p.ctx.CMCOLS = saved; } };
  const drawn = p.rows().map((r) => r.innerHTML);
  assert.deepEqual(drawn, [CASES[0], CASES[1], CASES[2]].map((c) => row(c, null)), 'November is open (the newest month): its three rows, newest first');
  assert.equal(p.cells(p.rows()[0])[0], '<td style="font-weight:600;color:var(--navy);white-space:nowrap">2026-XX-001</td>');
  assert.equal(p.cells(p.rows()[0])[1], '<td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Test Person</td>');
  assert.ok(!/cm-pin|cm-c-|example\.com|14165550134|made-up-token/.test(drawn.join('')), 'no view-tab cell and no contact detail on All at its default');
  // … and the same on each view tab
  for (const v of VIEWS) {
    p.tab(v.key);
    assert.deepEqual(p.head(), VIEW_LABELS, v.key);
    base.tab(v.key);
    assert.equal(p.headHtml(), base.html(), v.key);
    assert.equal(p.table.className, 'data-table cm-wide', v.key);
    const mine = CASES.filter((c) => c.views.includes(v.key));
    assert.deepEqual(p.rows().map((r) => r.innerHTML).sort(), mine.map((c) => row(c, v)).sort(), v.key);
    p.agree(20, v.key);
    assert.equal(p.btn.attrs['aria-label'], 'Columns on ' + v.label);
  }
});

test('the panel: named for the tab on view, the tab\'s columns as tick boxes in table order, then "More columns"; Case Ref and Client ticked, disabled, "Always shown"; the delete column is not listed', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  assert.equal(p.pop(), null, 'no panel until it is asked for');
  p.btn.onclick({ stopPropagation() {} });
  assert.ok(p.cols().isOpen());
  const pop = p.pop();
  assert.ok(pop.classList.contains('lt-pop'), 'the look of the lists\' filter panels');
  assert.deepEqual([pop.attrs.role, pop.attrs['aria-modal'], pop.attrs['aria-label']], ['dialog', 'false', 'Columns on All']);
  assert.equal(pop.style.display, 'flex');
  assert.equal(p.btn.attrs['aria-expanded'], 'true'); assert.ok(p.btn.classList.contains('open'));
  assert.ok(pop.innerHTML.startsWith('<div class="qp-h"><span>Columns on All</span><button type="button" class="qp-x" data-act="close" aria-label="Close">×</button></div>'));
  assert.deepEqual(p.boxes(), ['caseRef+!', 'clientName+!'].concat(ALL_IDS.slice(2, -1).map((id) => id + '+'), ALL_CAN_ADD.map((id) => id + '-')));
  assert.ok(!pop.innerHTML.includes('data-colpick="del"'));
  assert.equal((pop.innerHTML.match(/<span class="qp-c">Always shown<\/span>/g) || []).length, 2);
  assert.match(pop.innerHTML, /<label class="qp-row cmc-lock"><input type="checkbox" data-colpick="caseRef" checked disabled> <span>Case Ref<\/span><span class="qp-c">Always shown<\/span><\/label>/);
  assert.match(pop.innerHTML, /<label class="qp-row"><input type="checkbox" data-colpick="deadline" checked> <span>Deadline<\/span><\/label>/, 'a real tick box inside its label (keyboard: Tab and Space)');
  assert.ok(pop.innerHTML.indexOf('data-colpick="status"') < pop.innerHTML.indexOf('<div class="qp-t">More columns</div>') && pop.innerHTML.indexOf('<div class="qp-t">More columns</div>') < pop.innerHTML.indexOf('data-colpick="dependents"'));
  const names = [...pop.innerHTML.matchAll(/data-colpick="[^"]+"[^>]*> <span>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(names, ['Case Ref', 'Client', 'Type', 'Stage', 'Phase', 'Deadline', 'Promised', 'Health', 'SLA Risk', 'Support Officer', 'Manager', 'Readiness', 'Days', 'Status',
    'Dependents', 'Client email', 'Contact number', 'Sub-type', 'Deadline type', 'Retained by', 'Retainer status', 'Payment status', 'Client portal', 'Questionnaire %', 'Documents uploaded %']);
  assert.ok(pop.innerHTML.endsWith('<div class="qp-f"><button type="button" class="qp-link" data-act="reset" disabled>Reset to default</button><button type="button" class="qp-done" data-act="close">Done</button></div>'), 'Reset is off at the default');
  // placed under the button, inside the window — also on a 520px screen
  assert.deepEqual([pop.style.width, pop.style.left, pop.style.top, pop.style.maxHeight], ['300px', '420px', '306px', '582px']);
  p.ctx.innerWidth = 520; p.ctx.innerHeight = 700; p.btn.getBoundingClientRect = () => ({ left: 35, right: 122, top: 374, bottom: 412 });
  p.cols().close(); p.cols().open();
  const left = parseInt(pop.style.left, 10), width = parseInt(pop.style.width, 10);
  assert.ok(left >= 12 && left + width <= 520 - 12, 'not clipped at 520px: ' + pop.style.left + ' + ' + pop.style.width);
  assert.ok(parseInt(pop.style.top, 10) + parseInt(pop.style.maxHeight, 10) <= 700, 'and not taller than the window (the list scrolls inside)');
  // a view tab: its twenty, then the five it can add
  p.cols().close(); p.tab('assigning'); p.cols().open();
  assert.equal(pop.attrs['aria-label'], 'Columns on Assigning');
  assert.ok(pop.innerHTML.includes('<span>Columns on Assigning</span>'));
  assert.deepEqual(p.boxes(), ['caseRef+!', 'clientName+!'].concat(VIEW_IDS.slice(2).map((id) => id + '+'), VIEW_CAN_ADD.map((id) => id + '-')));
  p.cols().close(); p.tab('eeita'); p.cols().open();
  assert.ok(pop.innerHTML.includes('<span>Columns on EE after ITA</span>'));
});

test('the panel behaves like the filter panels: the button toggles it, Escape closes and gives the focus back, a press outside closes, a pop-up or another list panel opening closes it, changing the tab closes it', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  const press = () => p.btn.onclick({ stopPropagation() {} });
  const seen = []; p.doc.addEventListener('tdot-list-open', (e) => seen.push(e.detail));
  press();
  assert.ok(p.cols().isOpen());
  assert.deepEqual(seen, [KEY], 'opening tells the lists\' panels to close (the engine closes its own on another key)');
  press();
  assert.ok(!p.cols().isOpen() && p.pop().style.display === 'none' && p.btn.attrs['aria-expanded'] === 'false', 'the button closes it again');
  assert.equal(p.doc.activeElement, p.btn, 'the focus is back on the button');
  // Escape
  press(); p.doc.activeElement = null;
  const esc = { key: 'Escape' };
  p.fire('keydown', esc);
  assert.ok(!p.cols().isOpen()); assert.equal(p.doc.activeElement, p.btn);
  // Escape belongs to an open pop-up first
  press(); p.ctx.TDOT_DLG = { stack: [1] };
  p.fire('keydown', { key: 'Escape' });
  assert.ok(p.cols().isOpen(), 'a dialog on top: its Escape, not ours');
  p.ctx.TDOT_DLG = { stack: [] };
  p.fire('keydown', { key: 'a' }); assert.ok(p.cols().isOpen());
  // a press inside the panel or on the button does not close; a press anywhere else does (and the focus is left where the press put it)
  p.fire('mousedown', { target: p.pop() }); assert.ok(p.cols().isOpen());
  p.fire('mousedown', { target: p.btn }); assert.ok(p.cols().isOpen());
  p.doc.activeElement = null;
  p.fire('mousedown', { target: p.els['search-box'] });
  assert.ok(!p.cols().isOpen()); assert.equal(p.doc.activeElement, null);
  // a dialog opening; a column's filter panel opening
  press(); p.fire('tdot-dialog-open', {}); assert.ok(!p.cols().isOpen());
  press(); p.fire('tdot-list-open', { detail: 'tdot_list_cases' }); assert.ok(!p.cols().isOpen());
  press(); p.fire('tdot-list-open', { detail: KEY }); assert.ok(p.cols().isOpen(), 'its own announcement does not close it');
  // the tab changes under an open panel (keyboard): it closes — it listed the other tab's columns
  p.tab('deadlines');
  assert.ok(!p.cols().isOpen());
  assert.equal(p.btn.attrs['aria-label'], 'Columns on Deadlines');
});

test('tick and untick: the header, every row, every group heading and the "no cases" line follow at once, together — and the open and closed groups, the search, the filters and the sort stay', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  const st = p.ctx.CasesTable.state();
  // a search, a filter, a sort and a group opened by hand
  p.ctx.cmGrpAll(true);
  assert.equal(p.rows().length, 4, 'both months open');
  st.sort = { key: 'clientName', dir: 'asc' }; st.sel.manager = ['Gia Manager']; p.ctx.CasesTable.apply('filter');
  const order = () => p.rows().map((r) => p.cells(r)[1].replace(/<[^>]*>/g, ''));
  assert.deepEqual(order(), ['No Ref Yet', 'Test Person', 'Older Case']);
  p.cols().open();
  const was = p.rows().map((r) => p.cells(r));
  p.cols().toggle('', 'health', false);
  assert.deepEqual(p.head(), ALL_LABELS.filter((l) => l !== 'Health'));
  p.agree(14, 'Health hidden');
  assert.deepEqual(p.rows().map((r) => p.cells(r)), was.map((c) => c.slice(0, 7).concat(c.slice(8))), 'every row lost exactly its Health cell; the other cells are the same html');
  assert.deepEqual(order(), ['No Ref Yet', 'Test Person', 'Older Case'], 'the sort and the filter are as they were');
  assert.deepEqual(p.chips(), ['Sorted: Client (A → Z)', 'Manager: Gia Manager']);
  assert.equal(p.groups().length, 2); assert.ok(p.groups().every((g) => g.className.startsWith('cm-grp open')), 'the groups opened by hand are still open');
  assert.ok(p.cols().isOpen(), 'the panel stays open while boxes are ticked');
  // add two: after All's own columns, before the delete column
  p.cols().toggle('', 'docPct', true); p.cols().toggle('', 'clientEmail', true);
  assert.deepEqual(p.head(), ALL_LABELS.filter((l) => l !== 'Health').slice(0, -1).concat(['Client email', 'Documents uploaded %', '']));
  p.agree(16, 'two added');
  const cells = p.cells(p.rows()[1]);
  assert.equal(cells[13], '<td class="cm-c-email" title="client.one@example.com"><span class="cm-clip">client.one@example.com</span></td>');
  assert.equal(cells[14], '<td class="cm-c-doc cm-pct">40%</td>');
  assert.ok(cells[15].startsWith('<td class="cm-del"><button class="del-btn"'), 'the admin\'s delete cell is still the last one');
  // close a group: the choice of columns does not reopen it
  st.sel = {}; st.sort = null; p.ctx.CasesTable.apply('filter');
  p.ctx.cmGrpToggle('g_oct');
  assert.deepEqual(p.groups().map((g) => g.className.split(' ')[1]), ['open', 'shut']);
  p.cols().toggle('', 'phase', false);
  assert.deepEqual(p.groups().map((g) => g.className.split(' ')[1]), ['open', 'shut']);
  p.agree(15, 'Phase hidden too');
  // nothing matches: the one full-width line spans the chosen columns
  st.q = 'nobody-has-this-name'; p.ctx.CasesTable.apply('filter');
  assert.equal(p.none().innerHTML, '<td colspan="15"><span class="cm-none-t">No cases match the current filters.</span></td>');
  assert.equal(p.head().length, 15);
  p.cols().toggle('', 'portal', true);
  assert.equal(p.none().innerHTML, '<td colspan="16"><span class="cm-none-t">No cases match the current filters.</span></td>');
  assert.equal(st.q, 'nobody-has-this-name', 'the search is still on');
  assert.deepEqual(p.chips(), ['Search “nobody-has-this-name”']);
});

test('a filter or a sort on a column that is then hidden stays on and stays visible as its chip — hiding a column never leaves an invisible filter; × on the chip takes it off', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  const st = p.ctx.CasesTable.state();
  p.ctx.cmGrpAll(true);
  st.sel.health = ['Green']; st.sort = { key: 'slaRisk', dir: 'asc' }; p.ctx.CasesTable.apply('filter');
  assert.deepEqual(p.rows().map((r) => p.cells(r)[0].replace(/<[^>]*>/g, '')), ['2026-XX-002', '2026-XX-004']);
  assert.ok(p.headHtml().includes('data-col="health"'));
  p.cols().toggle('', 'health', false); p.cols().toggle('', 'slaRisk', false);
  assert.ok(!p.head().includes('Health') && !p.head().includes('SLA Risk') && !p.headHtml().includes('data-col="health"'));
  assert.deepEqual(p.rows().map((r) => p.cells(r)[0].replace(/<[^>]*>/g, '')), ['2026-XX-002', '2026-XX-004'], 'still filtered, still sorted');
  assert.deepEqual(p.chips(), ['Sorted: SLA Risk (Red first)', 'Health: Green']);
  assert.ok(p.els['cs-chips'].innerHTML.includes('data-chip="health" aria-label="Remove filter: Health: Green"') && p.els['cs-chips'].innerHTML.includes('data-sortreset="1"') && p.els['cs-chips'].innerHTML.includes('data-clearall="1"'));
  assert.notEqual(p.els['cs-chips'].style.display, 'none');
  assert.deepEqual(st.sel.health, ['Green']);
  // the same for a view tab's column, and for a column ADDED to a tab and then taken off again
  p.tab('assigning');
  p.cols().toggle('assigning', 'status', true);
  st.sel.retainerStatus = ['PR Signed']; p.ctx.CasesTable.apply('filter');
  p.cols().toggle('assigning', 'retainerStatus', false);
  assert.ok(!p.head().includes('Retainer status'));
  assert.deepEqual(p.chips(), ['Sorted: SLA Risk (Red first)', 'Health: Green', 'Retainer status: PR Signed']);
  // every facet any column can set makes a chip, whatever is hidden (so no filter can ever be on without one)
  const LT = p.ctx.CasesTable.core;
  for (const c of S.casesListOpts({ views: VIEWS }).cols) for (const f of c.facets || []) { const s2 = LT.emptyState(); s2.sel[f] = ['x']; assert.equal(LT.chips(s2).length, 1, f); }
});

test('the button says when a tab is not at its default — "Columns · 3 hidden", "· 2 added", both — in words a screen reader gets too; Reset to default puts the tab on view back, and only that tab', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  p.cols().toggle('', 'health', false); p.cols().toggle('', 'phase', false); p.cols().toggle('', 'status', false);
  assert.equal(p.btn.innerHTML, 'Columns<span class="cm-cols-n"> · 3 hidden</span>');
  assert.equal(p.btn.attrs['aria-label'], 'Columns on All: 3 hidden');
  assert.ok(p.btn.classList.contains('on'));
  assert.match(p.btn.attrs.title, /does not show its default columns \(3 hidden\)/);
  p.cols().toggle('', 'portal', true); p.cols().toggle('', 'qPct', true);
  assert.equal(p.btn.innerHTML, 'Columns<span class="cm-cols-n"> · 3 hidden, 2 added</span>');
  p.cols().toggle('', 'health', true); p.cols().toggle('', 'phase', true); p.cols().toggle('', 'status', true);
  assert.equal(p.btn.innerHTML, 'Columns<span class="cm-cols-n"> · 2 added</span>');
  assert.equal(p.btn.attrs['aria-label'], 'Columns on All: 2 added');
  // another tab has its own choice — and its own words on the button
  p.tab('deadlines');
  assert.equal(p.btn.innerHTML, 'Columns'); assert.ok(!p.btn.classList.contains('on')); assert.equal(p.btn.attrs.title, 'Choose the columns of this tab');
  p.cols().toggle('deadlines', 'dependents', false);
  assert.equal(p.btn.innerHTML, 'Columns<span class="cm-cols-n"> · 1 hidden</span>');
  assert.deepEqual(p.kept(), { v: 1, tabs: { all: { hidden: [], added: ['portal', 'qPct'] }, deadlines: { hidden: ['dependents'], added: [] } } });
  // the panel on Deadlines: Reset is on; pressing it resets Deadlines only
  p.cols().open();
  assert.ok(p.pop().innerHTML.includes('<button type="button" class="qp-link" data-act="reset">Reset to default</button>'));
  assert.deepEqual(p.boxes().filter((b) => b.startsWith('dependents')), ['dependents-']);
  p.cols().reset('deadlines');
  assert.deepEqual(p.head(), VIEW_LABELS); p.agree(20, 'Deadlines after Reset');
  assert.equal(p.btn.innerHTML, 'Columns'); assert.equal(p.btn.attrs['aria-label'], 'Columns on Deadlines');
  assert.deepEqual(p.kept(), { v: 1, tabs: { all: { hidden: [], added: ['portal', 'qPct'] } } }, 'All keeps its own choice');
  assert.ok(p.cols().panelHtml('deadlines').includes('data-act="reset" disabled>'), 'Reset is off again');
  p.cols().close(); p.tab('');
  assert.equal(p.head().length, 17);
  p.cols().reset('');
  assert.deepEqual(p.head(), ALL_LABELS); assert.equal(p.table.className, 'data-table');
  assert.equal(p.kept(), null, 'every tab at its default: the key is removed');
  assert.ok(!p.ls.m.has(KEY));
});

test('remembered on this browser, per tab: a new page opens with each tab\'s kept choice; stale ids in it are ignored; a column a later release adds to a default shows by itself', async () => {
  const first = await cmPage();
  first.setRows(rowsCopy());
  first.cols().toggle('', 'health', false); first.cols().toggle('', 'subType', true);
  first.tab('assigning'); first.cols().toggle('assigning', 'status', true);
  const stored = first.ls.m.get(KEY);
  assert.equal(stored, '{"v":1,"tabs":{"all":{"hidden":["health"],"added":["subType"]},"assigning":{"hidden":[],"added":["status"]}}}', 'the difference from the default, per tab, under one versioned key');
  assert.ok(first.ls.writes.every(([, k]) => k === KEY), 'the chooser writes its own key only');
  assert.ok(![...first.ss.m.keys()].includes(KEY), 'not in the browser tab\'s own store: it must outlive the tab');
  // a new page (another day, another browser tab) with what was kept
  const next = await cmPage({ local: { [KEY]: stored } });
  next.setRows(rowsCopy());
  assert.deepEqual(next.head(), ALL_LABELS.filter((l) => l !== 'Health').slice(0, -1).concat(['Sub-type', '']));
  assert.equal(next.table.className, 'data-table cm-wide cm-wide-all');
  assert.equal(next.btn.innerHTML, 'Columns<span class="cm-cols-n"> · 1 hidden, 1 added</span>');
  next.agree(15, 'All as kept');
  next.tab('assigning');
  assert.deepEqual(next.head(), VIEW_LABELS.concat(['Status'])); next.agree(21, 'Assigning as kept');
  next.tab('deadlines');
  assert.deepEqual(next.head(), VIEW_LABELS, 'a tab with nothing kept is at its default');
  assert.equal(next.ls.writes.length, 0, 'reading keeps nothing');
  // stale and unknown ids, an equivalent, a tab that is gone, another version
  const odd = await cmPage({ local: { [KEY]: JSON.stringify({ v: 1, tabs: { all: { hidden: ['gone', 'caseRef', 'clientName', 'del', 'phase'], added: ['nope', 'caseTypeV', 'qPct'] }, mahesh: { hidden: ['phaseV'], added: [] } } }) } });
  odd.setRows(rowsCopy());
  assert.deepEqual(odd.head(), ALL_LABELS.filter((l) => l !== 'Phase').slice(0, -1).concat(['Questionnaire %', '']), 'Case Ref, Client and the delete column cannot be hidden; an equivalent cannot be added');
  assert.equal(odd.btn.innerHTML, 'Columns<span class="cm-cols-n"> · 1 hidden, 1 added</span>', 'only what counts is counted');
  for (const bad of ['{not json', '"x"', '[]', JSON.stringify({ v: 2, tabs: { all: { hidden: ['phase'] } } }), JSON.stringify({ v: 1, tabs: 'x' })]) {
    const q = await cmPage({ local: { [KEY]: bad } });
    q.setRows(rowsCopy());
    assert.deepEqual(q.head(), ALL_LABELS, bad);
    assert.equal(q.btn.innerHTML, 'Columns');
  }
  // a later release: the kept difference over a default that grew (the page's own code, another column set)
  const grown = await cmPage({ local: { [KEY]: stored } });
  grown.ctx.CM_TABCOLS[''] = ['caseRef', 'clientName', 'caseType', 'retainedBy'].concat(ALL_IDS.slice(3));
  const api = vm.runInContext('(' + CUI.clientMasterColumnsUi.toString() + ')(window, CMU, { key: "' + KEY + '", tabCols: CM_TABCOLS, names: CM_COLNAMES, ids: { btn: "cm-cols-btn", pop: "cm-cols-pop" } })', grown.ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(api.ids(''))), ['caseRef', 'clientName', 'caseType', 'retainedBy'].concat(ALL_IDS.slice(3, -1).filter((id) => id !== 'health'), ['subType', 'del']));
});

test('a choice made in another browser tab for ANOTHER Client Master tab is not written over; the stored value is read again before each write', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  p.cols().toggle('', 'health', false);
  // meanwhile, elsewhere: Deadlines was customised
  p.ls.m.set(KEY, JSON.stringify({ v: 1, tabs: { all: { hidden: ['health'], added: [] }, deadlines: { hidden: ['portal'], added: [] } } }));
  p.cols().toggle('', 'phase', false);
  assert.deepEqual(p.kept(), { v: 1, tabs: { all: { hidden: ['health', 'phase'], added: [] }, deadlines: { hidden: ['portal'], added: [] } } });
});

test('storage blocked (or missing): the page works, the choice lasts for the page view, nothing throws', async () => {
  for (const how of [{ blocked: true }, { noLocal: true }]) {
    const p = await cmPage(how);
    p.setRows(rowsCopy());
    assert.deepEqual(p.head(), ALL_LABELS, JSON.stringify(how));
    p.cols().toggle('', 'health', false); p.cols().toggle('', 'portal', true);
    assert.deepEqual(p.head(), ALL_LABELS.filter((l) => l !== 'Health').slice(0, -1).concat(['Client portal', '']));
    p.agree(15, 'storage blocked');
    assert.equal(p.btn.innerHTML, 'Columns<span class="cm-cols-n"> · 1 hidden, 1 added</span>');
    p.tab('assigning'); p.tab('');
    assert.equal(p.head().length, 15, 'still there after a look at another tab');
    p.cols().open(); p.cols().reset('');
    assert.deepEqual(p.head(), ALL_LABELS);
    assert.equal(p.ls.m.size, 0);
  }
});

test('signed out: nothing is written (the table still follows a tick); and the Sign Out clean-up — the real one — leaves the columns choice while it removes the lists\' filters, the kept key and the notes drafts', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  p.cols().toggle('', 'health', false);
  const before = p.ls.m.get(KEY);
  p.ctx.TDOT_SIGNED_OUT = true;
  const n = p.ls.writes.length;
  p.cols().toggle('', 'phase', false); p.cols().reset('');
  assert.equal(p.ls.writes.length, n, 'no write once the page is signed out');
  assert.equal(p.ls.m.get(KEY), before);
  assert.deepEqual(p.head(), ALL_LABELS, 'the table on screen followed the Reset');
  // the real Sign Out over a browser that holds everything
  const q = await cmPage({
    local: { [KEY]: before, tdot_admin_key_keep: 'made-up-key', tdot_cnotes_lead_1: JSON.stringify({ who: 'Test Client', d: {} }), tdot_staff_name: 'Sample Staff' },
    session: { tdot_admin_key: 'made-up-key', tdot_list_cases: '{"q":"Test Person"}', tdot_list_cases_tab: 'assigning', tdot_list_cases_groups: '{}', tdot_list_leads: '{}', tdot_leads_table_v1: '{}' } });
  q.setRows(rowsCopy());
  q.ctx.confirm = () => true;
  assert.equal(typeof q.ctx.signOut, 'function');
  q.ctx.signOut();
  assert.equal(q.ctx.TDOT_SIGNED_OUT, true);
  assert.deepEqual([...q.ss.m.keys()].filter((k) => k.indexOf('tdot_list_') === 0 || k === 'tdot_leads_table_v1' || k === 'tdot_admin_key'), [], 'the lists\' filters, tabs and groups and the key are gone');
  assert.ok(!q.ls.m.has('tdot_admin_key_keep') && !q.ls.m.has('tdot_cnotes_lead_1'));
  assert.equal(q.ls.m.get(KEY), before, 'the columns choice is still there: it is a view preference, not case data');
  assert.ok(KEY.indexOf('tdot_list_') !== 0 && KEY.indexOf('tdot_cnotes_') !== 0 && KEY !== 'tdot_admin_key_keep' && KEY !== 'tdot_leads_table_v1');
  // it holds column ids only — never a search, a name or a case
  assert.ok(!/Test Person|example\.com|2026-XX/.test(before));
  // the next person at this computer sees the kept columns, and the page still works
  const again = await cmPage({ local: Object.fromEntries(q.ls.m) });
  again.setRows(rowsCopy());
  assert.deepEqual(again.head(), ALL_LABELS.filter((l) => l !== 'Health'));
});

test('the wide table follows the chosen columns: All turns wide (Case Ref and Client pinned, the scroll box a keyboard region) when a column is added, and back to exactly its old self when the last added column goes; hiding alone never makes it wide; a view tab is always wide', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  const REGION = { tabindex: '0', role: 'region', 'aria-label': 'Cases table, scrolls sideways' };
  const plainRow = p.rows()[0].innerHTML, plainHead = p.headHtml();
  p.cols().toggle('', 'health', false);
  assert.equal(p.table.className, 'data-table', 'hidden only: the plain table');
  assert.deepEqual(p.wrap.attrs, {}); assert.ok(!p.wrap.classList.contains('cm-scroll'));
  assert.ok(p.cells(p.rows()[0])[0].startsWith('<td style="font-weight:600;'), 'the plain Case Ref cell');
  p.cols().toggle('', 'clientPhone', true);
  assert.equal(p.table.className, 'data-table cm-wide cm-wide-all');
  assert.deepEqual(p.wrap.attrs, REGION); assert.ok(p.wrap.classList.contains('cm-scroll') && p.wrap.classList.contains('tbl-wrap'));
  for (const r of p.rows()) {
    const c = p.cells(r);
    assert.ok(c[0].startsWith('<td class="cm-pin cm-pin1"') && c[1].startsWith('<td class="cm-pin cm-pin2"'), 'Case Ref and Client are the pinned cells');
    assert.ok(c[c.length - 1].startsWith('<td class="cm-del">'));
  }
  assert.ok(p.rows()[0].className.includes('row-red'), 'the row tint class the pinned cells take their colour from');
  assert.equal(p.cells(p.rows()[0])[13], '<td class="cm-c-phone">14165550134</td>');
  // the empty list too
  p.ctx.CasesTable.state().q = 'zzzz'; p.ctx.CasesTable.apply('filter');
  assert.equal(p.table.className, 'data-table cm-wide cm-wide-all'); assert.deepEqual(p.wrap.attrs, REGION);
  p.ctx.CasesTable.state().q = ''; p.ctx.CasesTable.apply('filter');
  // back
  p.cols().toggle('', 'clientPhone', false); p.cols().toggle('', 'health', true);
  assert.equal(p.table.className, 'data-table'); assert.deepEqual(p.wrap.attrs, {}); assert.ok(!p.wrap.classList.contains('cm-scroll'));
  assert.equal(p.rows()[0].innerHTML, plainRow); assert.equal(p.headHtml(), plainHead);
  // a view tab with nearly everything hidden is still the wide table (its two pinned columns need it)
  p.tab('eeita');
  for (const id of VIEW_IDS.slice(2)) p.cols().toggle('eeita', id, false);
  assert.deepEqual(p.head(), ['Case Ref', 'Client']); p.agree(2, 'EE after ITA, two columns');
  assert.equal(p.table.className, 'data-table cm-wide'); assert.deepEqual(p.wrap.attrs, REGION);
  // the css: the page itself never scrolls sideways — the table does, inside its box; paper drops All's delete header in the wide table too
  const html = PAGE_HTML;
  assert.ok(html.includes('.tbl-wrap { overflow-x:auto; }') && html.includes('#all-cases-table.cm-wide { width:max-content; min-width:100%; }'));
  assert.ok(html.includes('#all-cases-table.cm-wide-all #cs-headrow th:last-child { display:none; }'));
  assert.ok(html.includes('#all-cases-table.cm-wide #cs-headrow th:nth-child(1), #all-cases-table.cm-wide td.cm-pin1 { position:sticky; left:0;'), 'the pinned pair is the first two columns — the two that can never be hidden');
});

/* ── review round (2026-11-12): paper, the short window, the narrow All table, the two-column view tab ── */

test('the sizes that follow the number of columns (pure): the print step — up to twenty as always, 21 to 23, 24 and more; the plain All table\'s least width — 84px a column under fifteen, the style sheet\'s own at fifteen', () => {
  for (const n of [0, 1, 2, 14, 19, 20]) assert.equal(U.colPrintFit(n), 0, String(n));
  for (const n of [21, 22, 23]) assert.equal(U.colPrintFit(n), 1, String(n));
  for (const n of [24, 25, 26, 40]) assert.equal(U.colPrintFit(n), 2, String(n));
  for (const junk of [null, undefined, '', 'x', NaN, Infinity]) assert.equal(U.colPrintFit(junk), 0);
  assert.equal(U.colMinWidth(15), ''); assert.equal(U.colMinWidth(16), ''); assert.equal(U.colMinWidth(26), '');
  assert.equal(U.colMinWidth(14), '1176px'); assert.equal(U.colMinWidth(11), '924px'); assert.equal(U.colMinWidth(3), '252px');
  assert.equal(U.colMinWidth(0), '84px', 'never nothing');
  for (const junk of [null, undefined, 'x', NaN]) assert.ok(['', '84px'].includes(U.colMinWidth(junk)));
});

test('paper follows the chosen columns: the wide table carries the number of columns it prints (All\'s delete column is not one) and a print step past twenty; the print rules shrink by that step, let every cell wrap between whole words, and drop the readiness bar\'s track', async () => {
  const p = await cmPage({ view: 'assigning' });
  p.setRows(rowsCopy());
  const at = () => [p.table.attrs['data-ncols'], p.table.attrs['data-pfit']];
  assert.deepEqual(at(), ['20', undefined], 'the default twenty: no step — it prints as it always did');
  p.cols().toggle('assigning', 'health', true);
  assert.deepEqual(at(), ['21', '1']);
  for (const id of VIEW_CAN_ADD) p.cols().toggle('assigning', id, true);
  p.agree(25, 'Assigning with all five added');
  assert.deepEqual(at(), ['25', '2']);
  assert.equal(p.head()[24], 'Status');
  p.cols().toggle('assigning', 'dependents', false);
  assert.deepEqual(at(), ['24', '2']);
  p.cols().reset('assigning');
  assert.deepEqual(at(), ['20', undefined], 'back at the default: the step is gone');
  // All: plain = nothing on the table; wide = the count without the delete column
  p.tab('');
  assert.deepEqual(at(), [undefined, undefined]);
  for (const id of ALL_CAN_ADD) p.cols().toggle('', id, true);
  p.agree(26, 'All with all eleven added (and the delete column)');
  assert.deepEqual(at(), ['25', '2'], '25 on paper: the delete column is not printed');
  assert.equal(p.head()[24], 'Documents uploaded %');
  for (const id of ALL_CAN_ADD.slice(5)) p.cols().toggle('', id, false);
  assert.deepEqual(at(), ['19', undefined], 'All with five added: under twenty, no step');
  p.cols().reset('');
  assert.deepEqual(at(), [undefined, undefined]);
  // the empty list keeps the step (the header still prints)
  p.tab('assigning'); for (const id of VIEW_CAN_ADD) p.cols().toggle('assigning', id, true);
  p.ctx.CasesTable.state().q = 'zzzz'; p.ctx.CasesTable.apply('filter');
  assert.deepEqual(at(), ['25', '2']);
  // the print rules
  const html = PAGE_HTML, print = html.slice(html.indexOf('@media print {', html.indexOf('@page { size: landscape')));
  const block = print.slice(0, print.indexOf('.cm-portal { color:inherit;'));
  assert.ok(block.length > 500);
  for (const rule of [
    '#all-cases-table.cm-wide { width:100%; min-width:0; font-size:7pt; }',
    // the cells brought over from All: their own letter size and their one-line rule are inline styles, so these must win
    '#all-cases-table.cm-wide td { font-size:7pt !important; white-space:normal !important; }',
    '#all-cases-table.cm-wide .readiness-bar { display:block; }',
    '#all-cases-table.cm-wide .r-bar-bg { display:none; }',
    '#all-cases-table.cm-wide .r-bar-pct { font-size:inherit; min-width:0; }',
    '#all-cases-table.cm-wide[data-pfit] th, #all-cases-table.cm-wide[data-pfit] td { padding:2px 3px; }',
    '#all-cases-table.cm-wide[data-pfit] td * { white-space:normal !important; font-size:inherit !important; letter-spacing:0; }',
    '#all-cases-table.cm-wide[data-pfit="1"] td, #all-cases-table.cm-wide[data-pfit="1"] tr.cm-grp td { font-size:6pt !important; }',
    '#all-cases-table.cm-wide[data-pfit="1"] th { font-size:5.5pt; }',
    '#all-cases-table.cm-wide[data-pfit="2"] td, #all-cases-table.cm-wide[data-pfit="2"] tr.cm-grp td { font-size:5.5pt !important; }',
    '#all-cases-table.cm-wide[data-pfit="2"] th { font-size:5pt; }',
    // whole words: a cell wraps between words (break-word never breaks one that fits); only the email may break inside a word
    '#all-cases-table.cm-wide td, #all-cases-table.cm-wide tr.cm-grp td { font-size:7pt; white-space:normal; overflow-wrap:break-word; }',
    '#all-cases-table.cm-wide td.cm-c-email .cm-clip { overflow-wrap:anywhere; }',
  ]) assert.ok(block.includes(rule), rule);
  assert.equal((block.match(/overflow-wrap:anywhere/g) || []).length, 1, 'only the email breaks inside a word on paper');
  assert.ok(!/table-layout:\s*fixed/.test(block), 'the columns keep their own widths on paper');
  // the step rules are print-only: on screen the table is not touched by data-pfit
  assert.ok(!html.slice(0, html.indexOf('@page { size: landscape')).includes('data-pfit'));
  // the page sets both attributes where it sets the table's class, from the pure rule
  const main = inlineScripts(html)[0];
  assert.ok(main.includes("var onPaper = span - (isAll ? 1 : 0), fit = wide ? CMU.colPrintFit(onPaper) : 0;"));
});

test('the Columns panel never runs off a short window: it is capped to the room there is and opens upward when there is more room above the button — the heading and Reset to default / Done stay on screen, the list scrolls inside', async () => {
  const p = await cmPage({ view: 'assigning' });
  p.setRows(rowsCopy());
  const openAt = (top, bottom, innerHeight, panelHeight) => {
    if (p.cols().isOpen()) p.cols().close();
    p.ctx.innerHeight = innerHeight;
    p.btn.getBoundingClientRect = () => ({ left: 640, right: 720, top, bottom, width: 80, height: bottom - top });
    if (p.pop()) p.pop().offsetHeight = panelHeight;   // the drawn panel's height (not given = as tall as its cap: 25 rows always fill it)
    p.btn.onclick({ stopPropagation() {} });
    if (p.pop().offsetHeight !== panelHeight) { p.pop().offsetHeight = panelHeight; p.cols().close(); p.btn.onclick({ stopPropagation() {} }); }
    const st = p.pop().style, t = parseFloat(st.top), h = parseFloat(st.maxHeight);
    return { top: t, max: h, bottom: t + h };
  };
  // plenty of room below: under the button, as before
  let r = openAt(270, 300, 900);
  assert.deepEqual([r.top, r.max], [306, 582]);
  assert.ok(r.bottom <= 900);
  // the Assigning tab on a 520 x 700 window (the review's case): the button's bottom edge is at 622 — the old panel spanned 628..828
  r = openAt(583, 622, 700, 520);
  assert.deepEqual([r.top, r.max], [57, 520], 'opens upward, its bottom edge just above the button');
  assert.ok(r.top >= 12 && r.bottom <= 583 - 6 && r.bottom <= 700);
  // the same button on an 813-high window (173px below: the old floor of 200 cut the footer off)
  r = openAt(583, 622, 813, 520);
  assert.ok(r.top >= 12 && r.bottom <= 577, 'upward: more room above than below');
  // a laptop: 1440 wide, 650 high, the button at 414..447 — 185px below, 396 above
  r = openAt(414, 447, 650, 396);
  assert.deepEqual([r.top, r.max], [12, 396]);
  assert.ok(r.bottom <= 414 - 6);
  // a little more room below than above: it stays below, capped to that room (never taller than the window allows)
  r = openAt(200, 233, 480);
  assert.deepEqual([r.top, r.max], [239, 229]);
  assert.ok(r.bottom <= 480 - 12);
  // a panel shorter than the room above sits right on the button, not at the top of the window
  r = openAt(583, 622, 700, 300);
  assert.equal(r.top, 583 - 6 - 300);
  // in every window tried the whole panel is inside it
  for (const [top, bottom, ih] of [[583, 622, 700], [584, 623, 700], [414, 447, 700], [379, 412, 700], [275, 308, 700], [374, 413, 613], [500, 533, 560], [60, 93, 400]]) {
    r = openAt(top, bottom, ih);
    assert.ok(r.top >= 12 && r.bottom <= ih - 12, JSON.stringify([top, bottom, ih, r]));
  }
  // the list is the part that gives: it scrolls inside the panel, between a heading and a footer that do not shrink
  const html = PAGE_HTML;
  assert.ok(html.includes('#cm-cols-pop .qp-b { min-height:0; }'));
  assert.ok(html.includes('.qp-b { overflow-y:auto; padding:4px 12px 8px; flex:1 1 auto; }') && html.includes('.lt-pop { display:none; position:fixed;') && /\.lt-pop \{[^}]*flex-direction:column;/.test(html));
  const ui = CUI.clientMasterColumnsUi.toString();
  assert.ok(!ui.includes('Math.max(200,'), 'the old floor of 200px (taller than the room) is gone');
});

test('hiding columns on All makes the plain table narrower: its least width follows the number of columns shown; at the default it is exactly the style sheet\'s 1260px (no inline width); the wide table and paper are not touched by it', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  const html = PAGE_HTML;
  assert.ok(html.includes('#all-cases-table { min-width:1260px; }'), 'the default: as it has always been');
  assert.equal(p.table.style.minWidth, '', 'All at its default: no inline width');
  assert.equal(p.table.className, 'data-table');
  p.cols().toggle('', 'health', false);
  assert.equal(p.table.style.minWidth, '1176px', '14 columns');
  for (const id of ['slaRisk', 'overallReadiness', 'daysElapsed']) p.cols().toggle('', id, false);
  assert.equal(p.table.style.minWidth, '924px', '11 columns: 84px each');
  for (const id of ALL_IDS.slice(2, -1)) p.cols().toggle('', id, false);
  assert.deepEqual(p.head(), ['Case Ref', 'Client', '']);
  assert.equal(p.table.style.minWidth, '252px', 'Case Ref, Client and the delete column: no longer stretched over 1260px');
  assert.equal(p.table.className, 'data-table', 'still the plain table');
  // the empty list too
  p.ctx.CasesTable.state().q = 'zzzz'; p.ctx.CasesTable.apply('filter');
  assert.equal(p.table.style.minWidth, '252px');
  p.ctx.CasesTable.state().q = ''; p.ctx.CasesTable.apply('filter');
  // a column added: the wide table has its own width rule — the inline one is cleared, whatever is hidden
  p.cols().toggle('', 'portal', true);
  assert.equal(p.table.className, 'data-table cm-wide cm-wide-all'); assert.equal(p.table.style.minWidth, '');
  p.cols().toggle('', 'portal', false);
  assert.equal(p.table.style.minWidth, '252px');
  // a view tab: never an inline width; back on All the choice is still there; reset = the style sheet's width again
  p.tab('deadlines'); assert.equal(p.table.style.minWidth, '');
  p.tab(''); assert.equal(p.table.style.minWidth, '252px');
  p.cols().reset(''); assert.equal(p.table.style.minWidth, ''); p.agree(15, 'All, reset');
  // paper: an inline width would beat the print rule, so the print rule is !important
  const print = html.slice(html.indexOf('@media print {', html.indexOf('@page { size: landscape')));
  assert.ok(print.includes('#all-cases-table { min-width:0 !important; font-size:10pt; }'));
  assert.ok(inlineScripts(html)[0].includes("tbl.style.minWidth = wide ? '' : CMU.colMinWidth(span);"));
});

test('a view tab with only Case Ref and Client has no phantom sideways scroll: the pinned edge\'s shadow strip is dropped when Client is the last column (it stuck out 9px past the table)', async () => {
  const html = PAGE_HTML || await renderRoute('/');
  const strip = '#all-cases-table.cm-wide #cs-headrow th:nth-child(2)::after, #all-cases-table.cm-wide td.cm-pin2::after { content:\'\'; position:absolute; top:0; bottom:0; left:100%; width:9px;';
  const drop = '#all-cases-table.cm-wide #cs-headrow th:nth-child(2):last-child::after, #all-cases-table.cm-wide td.cm-pin2:last-child::after { display:none; }';
  assert.ok(html.includes(strip), 'the strip itself stays (with more columns the rest scrolls under it)');
  assert.ok(html.includes(drop));
  const screen = html.slice(0, html.indexOf('@page { size: landscape'));
  assert.ok(screen.indexOf(drop) > screen.indexOf(strip), 'after the strip\'s rule, on screen (not only on paper), so it wins');
  // the page: with every other column hidden, Client IS the last cell of the header and of every row — what the rule matches
  const p = await cmPage({ view: 'assigning' });
  p.setRows(rowsCopy());
  for (const id of VIEW_IDS.slice(2)) p.cols().toggle('assigning', id, false);
  assert.deepEqual(p.head(), ['Case Ref', 'Client']);
  for (const r of p.rows()) { const c = p.cells(r); assert.equal(c.length, 2); assert.ok(c[1].startsWith('<td class="cm-pin cm-pin2"')); }
  // on All the wide table always ends with the delete column, so the strip stays there
  p.tab(''); p.cols().toggle('', 'portal', true);
  for (const r of p.rows()) { const c = p.cells(r); assert.ok(c[c.length - 1].startsWith('<td class="cm-del">') && !c[c.length - 1].includes('cm-pin2')); }
});

test('what lives in a cell keeps working wherever its column is shown: Assign…, Change… and the flags (Deadlines), the waiting line (Assigning), the window chip, REF PENDING, the portal "Open" link — also in a column added to another tab', async () => {
  const p = await cmPage();
  p.setRows(rowsCopy());
  // All with the view tabs' columns added
  for (const id of ALL_CAN_ADD) p.cols().toggle('', id, true);
  p.agree(26, 'All with everything added');
  assert.deepEqual(p.head(), ALL_LABELS.slice(0, -1).concat(['Dependents', 'Client email', 'Contact number', 'Sub-type', 'Deadline type', 'Retained by', 'Retainer status', 'Payment status', 'Client portal', 'Questionnaire %', 'Documents uploaded %', '']));
  const one = p.cells(p.rows()[0]), blank = p.cells(p.rows()[2]);
  assert.match(one[5], /^<td class="cm-dl" style="font-size:11px"><span class="cm-type real"[^>]*>Real<\/span> <span class="cm-date">Nov 20, 2026<\/span> <span class="cm-win"/, 'All\'s own Deadline cell: type, date, window');
  assert.ok(!one[5].includes('dlc-btn'), 'Change… belongs to the Deadlines tab');
  assert.ok(one[9].includes('class="cm-assign" data-assign="1"'), 'Assign… on All');
  assert.match(one[18], /^<td class="cm-c-dt"><span class="cm-type real"/, 'the added Deadline type column');
  assert.match(one[22], /^<td class="cm-c-portal"><a class="cm-portal" href="https:\/\/portal\.example\/client\/2026-XX-001\?token=made-up-token-1" target="_blank" rel="noopener noreferrer"[^>]*>Open<\/a><\/td>$/);
  assert.ok(!one[22].replace(/href="[^"]*"/, '').includes('made-up-token'), 'the address is the link\'s target only');
  assert.deepEqual([one[23], one[24]], ['<td class="cm-c-q cm-pct">85%</td>', '<td class="cm-c-doc cm-pct">40%</td>']);
  assert.ok(blank[0].includes('<span class="badge orange">Needs Case Type</span>') || blank[0].includes('Ref pending'), 'a case without a reference says so in the pinned cell');
  assert.ok(blank[0].startsWith('<td class="cm-pin cm-pin1">'));
  assert.ok(!one.join('').includes('class="cm-wait'), 'the waiting line belongs to Assigning');
  // the data: the page asks for the contact details once, for every tab (contact=1) — the Summary never does
  assert.ok(inlineScripts(PAGE_HTML)[0].includes("if (VIEW !== 'summary') qs.push('contact=1');"));
  // Assigning with All's five added
  p.tab('assigning');
  for (const id of VIEW_CAN_ADD) p.cols().toggle('assigning', id, true);
  p.agree(25, 'Assigning with everything added');
  assert.deepEqual(p.head(), VIEW_LABELS.concat(['Health', 'SLA Risk', 'Readiness', 'Days', 'Status']));
  const pre = p.rows().map((r) => p.cells(r)).find((c) => c[0].includes('2026-XX-001'));
  assert.match(pre[14], /^<td class="cm-c-stage">Pre-Onboarding<div class="cm-wait" data-wait="payment"/, 'the waiting line under the stage');
  assert.ok(pre[16].includes('class="cm-assign" data-assign="1"'));
  assert.ok(pre[20].includes('badge') && /Red/i.test(pre[20]) && pre[21].includes('badge'), 'Health and SLA Risk as on All');
  assert.ok(pre[22].includes('<span class="r-bar-pct">60%</span>'));
  assert.equal(pre[23], '<td style="text-align:center;font-weight:600;color:var(--muted)">12</td>');
  const blocked = p.rows().map((r) => p.cells(r)).find((c) => c[1].includes('No Ref Yet'));
  assert.ok(blocked[24].includes('<span class="badge orange" style="margin-right:3px">Blocked</span>'));
  assert.ok(!pre.join('').includes('dlc-btn'));
  // Deadlines: Change… and the flag stay in their cells, with a column hidden before them and one added after
  p.tab('deadlines');
  p.cols().toggle('deadlines', 'dependents', false); p.cols().toggle('deadlines', 'health', true);
  p.agree(20, 'Deadlines');
  const d1 = p.rows().map((r) => p.cells(r)).find((c) => c[0].includes('2026-XX-001')), d2 = p.rows().map((r) => p.cells(r)).find((c) => c[0].includes('2026-XX-002'));
  assert.ok(d1[6].startsWith('<td class="cm-dl">') && d1[6].includes('class="dlc-btn" data-dl="1"') && d1[6].includes('class="cm-win"'), 'Change… and the window chip in the Actual deadline cell');
  assert.ok(d2[8].startsWith('<td class="cm-pr">') && /class="cm-flag /.test(d2[8]), 'the flag with the Internal deadline: ' + d2[8]);
  assert.ok(d1[19].includes('badge'));
  // hide the column a feature lives in: the feature goes with it, nothing else moves
  p.cols().toggle('deadlines', 'actualDeadline', false);
  assert.ok(!p.rows().some((r) => r.innerHTML.includes('dlc-btn')));
  p.agree(19, 'Deadlines without Actual deadline');
});

test('the page-script rule holds for the new code in the page file: no backtick, dollar-brace or backslash; wording on screen is plain and in sentence case', async () => {
  const src = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  const block = src.slice(src.indexOf('/* The columns of a tab, in order'), src.indexOf('/* A view-tab cell of plain text'));
  assert.ok(block.includes('function cmColIds(v)') && block.includes('function cmPickCols(cols, tab, all)'));
  assert.ok(!/[`\\]|\$\{/.test(block));
  const ui = CUI.clientMasterColumnsUi.toString();
  for (const words of ["'Columns'", 'Reset to default', 'Always shown', 'More columns', "'Columns on '", 'Done']) assert.ok(ui.includes(words), words);
  assert.ok(!/Reset To Default|Always Shown|RESET|More Columns/.test(ui));
});
