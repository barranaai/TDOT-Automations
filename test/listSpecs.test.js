'use strict';

// One filter look for every list (team meeting point 3, Faran 2026-11-05): Consultations, Retainers and
// Cases moved from drop-down rows to the Leads-style filters in the column headers. The promise: the SAME
// filters give the SAME rows. Each old drop-down choice is checked here against a FROZEN COPY of the page
// code it replaced (git e0bbd79), on generated rows, for every combination of choices. The two deliberate
// differences are tested on their own, at the end.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { listCore, listTableScript } = require('../src/routes/listFilters');
const S = require('../src/routes/listSpecs');
const { OUTCOME_LABELS } = require('../config/outcomes');

/* a small deterministic generator */
function rng(seed) { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }
const pick = (r, list) => list[Math.floor(r() * list.length)];
const ids = (rows) => rows.map((x) => x.id).join(',');
function product(lists) { return lists.reduce((acc, l) => acc.flatMap((a) => l.map((v) => a.concat([v]))), [[]]); }

/* ── Consultations ── */

// FROZEN COPY (adminConsultation.js @ e0bbd79): paidMatch, passesCommon and the filter part of applyFilters.
function oldPaidMatch(r, paid) {
  if (!paid) return true;
  if (paid === 'paid') return !!(r.paid && r.paid !== 'waived');
  if (paid === 'app') return r.paid === 'app';
  if (paid === 'staff') return !!(r.paid && r.paid !== 'app' && r.paid !== 'waived');
  if (paid === 'waived') return r.paid === 'waived';
  if (paid === 'none') return !r.paid;
  return true;
}
function oldPassesCommon(r, q, con) {
  if (q && String(r.name || '').toLowerCase().indexOf(q) < 0) return false;
  if (con === '__none') { if (r.consultant) return false; } else if (con && r.consultant !== con) return false;
  return true;
}
function oldConsultKeep(rows, f) {
  const q = (f.q || '').toLowerCase().trim();
  return rows.filter((r) => {
    if (!oldPassesCommon(r, q, f.con)) return false;
    if (f.mode && r.meetingType !== f.mode) return false;
    if (!oldPaidMatch(r, f.paid)) return false;
    if (f.ag === 'signed' && !r.agreementSigned) return false;
    if (f.ag === 'sent' && !(r.agreementSent && !r.agreementSigned)) return false;
    if (f.ag === 'none' && r.agreementSent) return false;
    return true;
  });
}
// The old choices as ticks in the column headers.
const PAID_TICKS = { '': null, paid: ['app', 'staff'], app: ['app'], staff: ['staff'], waived: ['waived'], none: ['none'] };
function consultState(LT, f) {
  const st = LT.emptyState();
  st.q = f.q || '';
  if (f.con) st.sel.consultant = [f.con === '__none' ? LT.NONE : f.con];
  if (f.mode) st.sel.mode = [f.mode];
  if (PAID_TICKS[f.paid]) st.sel.paid = PAID_TICKS[f.paid];
  if (f.ag) st.sel.agreement = [f.ag];
  return st;
}
function consultRows(n) {
  const r = rng(7), out = [];
  for (let i = 0; i < n; i++) {
    const signed = r() < 0.3 ? '2026-10-0' + (1 + Math.floor(r() * 9)) : '';
    out.push({ id: String(i), name: pick(r, ['Asha Rao', 'Bo Li', 'Chen Wu', 'Dev Patel', 'asha khan']),
      consultant: pick(r, ['Shafoli Kapur', 'Shermin T', '']), meetingType: pick(r, ['In-person', 'Virtual', 'Phone Call', '']),
      paid: pick(r, ['app', 'cash', 'e-transfer', 'invoice', 'other', 'waived', '']),
      // signed rows are nearly always sent too — a few are not (the case the old "Not sent" also listed)
      agreementSent: (signed && r() < 0.9) || (!signed && r() < 0.5) ? '2026-09-30' : '', agreementSigned: signed });
  }
  return out;
}

test('Consultations: every combination of the old drop-downs gives the same rows as the header filters', () => {
  const LT = listCore(S.consultListSpec({}));
  const rows = consultRows(400);
  const combos = product([['', 'asha', 'LI '], ['', 'Shafoli Kapur', '__none'], ['', 'In-person', 'Virtual', 'Phone Call'], Object.keys(PAID_TICKS), ['', 'signed', 'sent']]);
  for (const [q, con, mode, paid, ag] of combos) {
    const f = { q, con, mode, paid, ag };
    assert.equal(ids(LT.filterRows(rows, consultState(LT, f))), ids(oldConsultKeep(rows, f)), JSON.stringify(f));
  }
  assert.ok(combos.length > 400);
});

test('Consultations: "Not sent" now means not sent — a signed agreement with no sent date is under Signed only (deliberate; it was in both)', () => {
  const LT = listCore(S.consultListSpec({}));
  const rows = consultRows(400);
  for (const f of [{ ag: 'none' }, { ag: 'none', paid: 'app' }, { ag: 'none', con: '__none' }]) {
    const now = LT.filterRows(rows, consultState(LT, f)), before = oldConsultKeep(rows, f);
    assert.equal(ids(now), ids(before.filter((r) => !r.agreementSigned)), JSON.stringify(f));
  }
  const odd = { id: 'x', agreementSigned: '2026-10-01', agreementSent: '' };
  assert.deepEqual(LT.valuesOf('agreement', odd), ['signed']);
});

test('Consultations: the header choices read like the old drop-downs; the server order is kept (no sort)', () => {
  const LT = listCore(S.consultListSpec({}));
  const rows = consultRows(60);
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'paid').map((o) => o.label), ['Paid (app)', 'Paid — recorded by staff', 'Waived', 'Not paid']);
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'agreement').map((o) => o.label), ['Signed', 'Sent, not signed', 'Not sent']);
  assert.ok(LT.facetCounts(rows, LT.emptyState(), 'consultant').some((o) => o.label === 'Unassigned' && o.value === LT.NONE));
  assert.equal(ids(LT.sortRows(rows, LT.emptyState().sort)), ids(rows), 'earliest consultation first, as the server sent them');
  assert.deepEqual(LT.chips(consultState(LT, { q: 'asha', paid: 'paid', con: '__none' })).map((c) => c.text),
    ['Search “asha”', 'Consultant: Unassigned', 'Paid: Paid (app), Paid — recorded by staff']);
});

test('a short fixed list shows every choice even when none of the rows has it (like the old drop-down); open lists show only what is there', () => {
  const LT = listCore(S.consultListSpec({}));
  const rows = [{ id: '1', paid: 'app', consultant: 'A', meetingType: 'Virtual' }];
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'paid').map((o) => [o.label, o.count]), [['Paid (app)', 1], ['Paid — recorded by staff', 0], ['Waived', 0], ['Not paid', 0]]);
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'consultant').map((o) => o.label), ['A'], 'consultants: only the ones on the list');
  const C = listCore(S.casesListSpec({}));
  assert.deepEqual(C.facetCounts([{ health: 'Red' }], C.emptyState(), 'health').map((o) => o.label), ['Red', 'Orange', 'Green']);
});

/* ── Retainers & follow-ups ── */

// FROZEN COPY (adminConsultation.js @ e0bbd79): renderRetainers' filter, then the outcome buttons (ROUT).
function oldRetGroup(r) { return OUTCOME_LABELS.indexOf(r.outcomeGroup) >= 0 ? r.outcomeGroup : OUTCOME_LABELS[0]; }
function oldRetainerRows(rows, f, t) {
  const q = (f.q || '').toLowerCase().trim();
  const base = rows.filter((r) => {
    if (!oldPassesCommon(r, q, f.con)) return false; if (f.st && r.stage !== f.st) return false; if (f.kind && r.kind !== f.kind) return false;
    if (f.fu === 'due' && !(r.followUpDate && r.followUpDate <= t)) return false;
    if (f.fu === 'has' && !r.followUpDate) return false;
    if (f.paid && ((r.kind === 'direct' && !r.paid) || !oldPaidMatch(r, f.paid))) return false;
    return true;
  });
  const rout = f.rout || [];
  return { base, rows: rout.length ? base.filter((r) => rout.indexOf(oldRetGroup(r)) >= 0) : base };
}
const FU_TICKS = { '': null, due: ['due'], has: ['due', 'later'] };
function retainerState(LT, f) {
  const st = LT.emptyState();
  st.q = f.q || '';
  if (f.con) st.sel.consultant = [f.con === '__none' ? LT.NONE : f.con];
  if (f.st) st.sel.stage = [f.st];
  if (f.kind) st.sel.kind = [f.kind];
  if (FU_TICKS[f.fu]) st.sel.followUp = FU_TICKS[f.fu];
  if (PAID_TICKS[f.paid]) st.sel.paid = PAID_TICKS[f.paid];
  if (f.rout && f.rout.length) st.sel.outcome = f.rout.slice();
  return st;
}
function retainerRows(n) {
  const r = rng(11), out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: String(i), name: pick(r, ['Asha Rao', 'Bo Li', 'Chen Wu', 'Dev Patel']), consultant: pick(r, ['Shafoli Kapur', 'Shermin T', '']),
      stage: pick(r, ['Paid', 'Signed', 'Sent', 'Fee set', 'Retain', 'New', '']), kind: pick(r, ['direct', 'booked']),
      followUpDate: pick(r, ['', '', '2026-11-01', '2026-11-05', '2026-11-06', '2026-12-01']),
      paid: pick(r, ['app', 'cash', 'waived', '', '']), outcomeGroup: pick(r, OUTCOME_LABELS.concat(['', 'junk'])) });
  }
  return out;
}

test('Retainers: every combination of the old drop-downs and the outcome buttons gives the same rows; the button counts match', () => {
  const today = '2026-11-05';
  const LT = listCore(S.retainerListSpec({ outcomes: OUTCOME_LABELS, today: () => today }));
  const rows = retainerRows(400);
  const combos = product([['', 'asha'], ['', 'Shermin T', '__none'], ['', 'Paid', 'Retain', 'New'], ['', 'direct', 'booked'], Object.keys(FU_TICKS), Object.keys(PAID_TICKS),
    [[], ['Follow-Up'], ['Retain', 'Not Wanted']]]);
  for (const [q, con, st, kind, fu, paid, rout] of combos) {
    const f = { q, con, st, kind, fu, paid, rout };
    const state = retainerState(LT, f), old = oldRetainerRows(rows, f, today);
    assert.equal(ids(LT.filterRows(rows, state)), ids(old.rows), JSON.stringify(f));
    // the buttons: "All" = the other filters' rows; each outcome counted after the other filters (the old renderQuick)
    assert.equal(rows.filter((r) => LT.passes(r, state, 'outcome')).length, old.base.length);
    const counts = {}; LT.facetCounts(rows, state, 'outcome').forEach((o) => { counts[o.value] = o.count; });
    for (const o of OUTCOME_LABELS) assert.equal(counts[o] || 0, old.base.filter((r) => oldRetGroup(r) === o).length, o + ' ' + JSON.stringify(f));
  }
  assert.ok(combos.length > 2000);
});

test('Retainers: a direct client with no consultation fee is under no fee choice — "Not paid" never lists one (the old rule)', () => {
  const LT = listCore(S.retainerListSpec({ outcomes: OUTCOME_LABELS, today: () => '2026-11-05' }));
  assert.deepEqual(LT.valuesOf('paid', { kind: 'direct', paid: '' }), ['na']);
  assert.deepEqual(LT.valuesOf('paid', { kind: 'direct', paid: 'cash' }), ['staff'], 'a direct client who did pay a fee is counted as paid');
  assert.deepEqual(LT.valuesOf('paid', { kind: 'booked', paid: '' }), ['none']);
  assert.deepEqual(LT.valuesOf('outcome', { outcomeGroup: 'junk' }), [OUTCOME_LABELS[0]], 'no group = under Retain');
  assert.equal(LT.chips(retainerState(LT, { fu: 'due', rout: ['Follow-Up'] })).map((c) => c.text).join(' | '), 'Follow-up: Due (today or earlier)',
    'the follow-up chip says Follow-up; the outcome buttons are not repeated as chips');
  const st = retainerState(LT, { fu: 'due', con: 'Shermin T', rout: ['Follow-Up'] });
  const cleared = LT.clearAll(st);
  assert.deepEqual(cleared.sel, { outcome: ['Follow-Up'] }, 'Clear filters keeps the outcome buttons (they have their own All)');
});

/* ── Cases ── */

// FROZEN COPY (adminDashboard.js @ e0bbd79): filterTable and sortTable's compare.
const HEALTH_ORDER = { Red: 0, Orange: 1, Green: 2 };
function oldCasesFilter(cases, f) {
  const q = (f.q || '').toLowerCase();
  return cases.filter((c) => {
    if (q && !((c.clientName || '').toLowerCase().includes(q) || (c.caseRef || '').toLowerCase().includes(q) || (c.caseType || '').toLowerCase().includes(q))) return false;
    if (f.stage && c.caseStage !== f.stage) return false;
    if (f.health && c.health !== f.health) return false;
    if (f.mgr && !(c.manager || '').includes(f.mgr)) return false;
    return true;
  });
}
function oldSortKey(col) {
  return (c) => {
    let v = c[col];
    if (col === 'health' || col === 'slaRisk') return HEALTH_ORDER[v] !== undefined ? HEALTH_ORDER[v] : 2;
    if (typeof v === 'number') return v;
    return (v || '').toLowerCase();
  };
}
function casesRows(n) {
  const r = rng(5), out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: String(i), caseRef: '2026-' + pick(r, ['EE', 'SP', 'VV']) + '-' + String(100 + i), clientName: pick(r, ['Asha Rao', 'Bo Li', 'Chen Wu', 'Dev Patel']),
      caseType: pick(r, ['Express Entry', 'Study Permit', 'Visitor Visa']), caseStage: pick(r, ['Document Collection', 'Review', 'Submitted']),
      health: pick(r, ['Red', 'Orange', 'Green']), slaRisk: pick(r, ['Red', 'Orange', 'Green', '']),
      manager: pick(r, ['Gauri', 'Melanie', 'Gauri, Melanie', 'Unassigned']), overallReadiness: Math.floor(r() * 100), daysElapsed: Math.floor(r() * 60),
      createdAt: '2026-' + String(1 + Math.floor(r() * 9)).padStart(2, '0') + '-1' + Math.floor(r() * 9) + 'T10:00:00Z' });
  }
  return out;
}

test('Cases: every combination of the old search and drop-downs gives the same cases (whole manager names)', () => {
  const LT = listCore(S.casesListSpec({ healthOrder: HEALTH_ORDER }));
  const rows = casesRows(300);
  const combos = product([['', 'asha', 'ee', 'visa'], ['', 'Review', 'Submitted'], ['', 'Red', 'Green'], ['', 'Gauri', 'Melanie']]);
  for (const [q, stage, health, mgr] of combos) {
    const st = LT.emptyState();
    st.q = q; if (stage) st.sel.stage = [stage]; if (health) st.sel.health = [health]; if (mgr) st.sel.manager = [mgr];
    assert.equal(ids(LT.filterRows(rows, st)), ids(oldCasesFilter(rows, { q, stage, health, mgr })), JSON.stringify({ q, stage, health, mgr }));
  }
});

test('Cases: the sort — newest case first by default; each column sorts the same way it did (first click and second)', () => {
  const LT = listCore(S.casesListSpec({ healthOrder: HEALTH_ORDER }));
  const rows = casesRows(120);
  const keys = (list, col) => list.map(oldSortKey(col)).join('|');
  assert.deepEqual(LT.emptyState().sort, { key: 'createdAt', dir: 'desc' });
  const newest = LT.sortRows(rows, LT.emptyState().sort);
  assert.equal(keys(newest, 'createdAt'), keys(rows.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)), 'createdAt'));
  const opts = S.casesListOpts({});
  for (const col of opts.cols.filter((c) => c.sort)) {
    for (const dir of col.sortDirs) {
      const want = rows.slice().sort((a, b) => { const k = oldSortKey(col.sort), av = k(a), bv = k(b); const d = dir === 'asc' ? 1 : -1; return av < bv ? -d : av > bv ? d : 0; });
      assert.equal(keys(LT.sortRows(rows, { key: col.sort, dir }), col.sort), keys(want, col.sort), col.sort + ' ' + dir);
    }
  }
  // the first click goes the way the old header did: Health / SLA risk Red first, Readiness / Days highest first, the rest A → Z
  const first = Object.fromEntries(opts.cols.filter((c) => c.sort).map((c) => [c.sort, c.sortDirs[0]]));
  // block 3 adds only the four new columns' sorts (Phase, Deadline, Promised, Support Officer), each A → Z / soonest first
  assert.deepEqual(first, { caseRef: 'asc', clientName: 'asc', caseType: 'asc', caseStage: 'asc', health: 'asc', slaRisk: 'asc', manager: 'asc', overallReadiness: 'desc', daysElapsed: 'desc',
    officer: 'asc', phase: 'asc', actualDeadline: 'asc', promisedDate: 'asc' });
});

test('Cases: deliberate — a manager is chosen by whole name (no "Ana" matching "Anabel"), and "Unassigned" can be chosen', () => {
  const LT = listCore(S.casesListSpec({ healthOrder: HEALTH_ORDER }));
  const rows = [{ id: '1', manager: 'Anabel' }, { id: '2', manager: 'Ana, Gauri' }, { id: '3', manager: '' }, { id: '4', manager: 'Unassigned' }];
  const st = LT.emptyState(); st.sel.manager = ['Ana'];
  assert.equal(ids(LT.filterRows(rows, st)), '2');
  st.sel.manager = [LT.NONE];
  assert.equal(ids(LT.filterRows(rows, st)), '3,4', 'no manager and the literal "Unassigned" are the same choice');
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'manager').map((o) => [o.label, o.count]), [['Ana', 1], ['Anabel', 1], ['Gauri', 1], ['Unassigned', 2]]);
});

/* ── the browser code ── */

test('every list script parses and follows the page-script rule (no template-literal escaping inside)', () => {
  for (const [spec, opts, ctx] of [[S.consultListSpec, S.consultListOpts], [S.retainerListSpec, S.retainerListOpts, '{ outcomes: [], today: function(){ return ""; } }'], [S.casesListSpec, S.casesListOpts, '{ healthOrder: {} }']]) {
    const src = listTableScript(spec, opts, ctx);
    new vm.Script(src);
    assert.ok(!src.includes('${'), 'no dollar-brace');
  }
  // every column's facet exists in its spec
  for (const [spec, opts] of [[S.consultListSpec, S.consultListOpts], [S.retainerListSpec, S.retainerListOpts], [S.casesListSpec, S.casesListOpts]]) {
    const sp = spec({ outcomes: OUTCOME_LABELS, today: () => '' }), op = opts({ outcomes: OUTCOME_LABELS });
    for (const c of op.cols) for (const f of (c.facets || [])) assert.ok(sp.facets[f], f);
    for (const c of op.cols) if (c.sort) assert.ok(sp.sorts[c.sort], c.sort);
    assert.ok(op.key.indexOf('tdot_list_') === 0, 'saved under tdot_list_* — Sign Out forgets them');
  }
});

test('Sign Out forgets every list’s saved filters (a search holds a client’s name)', () => {
  const { SHARED_AUTH_JS } = require('../src/routes/adminShared');
  assert.ok(SHARED_AUTH_JS.includes("if (sk && (sk.indexOf('tdot_list_') === 0 || sk === 'tdot_leads_table_v1')) sessionStorage.removeItem(sk);"));
  const store = { tdot_admin_key: 'k', tdot_list_cases: '{}', tdot_list_retainers: '{}', tdot_leads_table_v1: '{}', tdot_fam_add_x: 'job' };
  const sessionStorage = { get length() { return Object.keys(store).length; }, key: (i) => Object.keys(store)[i], removeItem: (k) => { delete store[k]; }, getItem: (k) => store[k] };
  const ctx = { sessionStorage, localStorage: { removeItem() {} }, window: { location: { replace() {} } }, fetch: () => Promise.resolve(), setTimeout() {}, document: { readyState: 'complete', getElementById: () => null } };
  vm.createContext(ctx);
  vm.runInContext(SHARED_AUTH_JS + '; signOut();', ctx);
  assert.deepEqual(Object.keys(store), ['tdot_fam_add_x'], 'the key and the filters are gone; other tab state (a family add in progress) stays');
});

test('review 2026-11-05: a saved outcome button that no longer exists (a renamed outcome) is dropped on restore — the list never sits empty with no button pressed', () => {
  const LT = listCore(S.retainerListSpec({ outcomes: OUTCOME_LABELS, today: () => '' }));
  assert.equal(LT.normalizeState({ sel: { outcome: ['Follow Up'] } }).sel.outcome, undefined);
  assert.deepEqual(LT.normalizeState({ sel: { outcome: ['Follow Up', 'Newsletter'] } }).sel.outcome, ['Newsletter']);
  assert.deepEqual(LT.normalizeState({ sel: { stage: ['Gone stage'] } }).sel.stage, ['Gone stage'], 'an open list keeps its value (it shows ticked, with 0, and can be unticked)');
});

test('review 2026-11-05: Sign Out stops a list read still running from saving the filters again; the Cases normal order can always be brought back', () => {
  const { SHARED_AUTH_JS } = require('../src/routes/adminShared');
  const { listTableUi } = require('../src/routes/listFilters');
  assert.ok(SHARED_AUTH_JS.indexOf('window.TDOT_SIGNED_OUT = true;') < SHARED_AUTH_JS.indexOf('forgetLists();'));
  assert.ok(SHARED_AUTH_JS.includes('function leave() { if (!gone) { gone = true; forgetLists(); window.location.replace'));
  assert.ok(/function save\(\) \{\s+if \(win\.TDOT_SIGNED_OUT\) return;/.test(listTableUi.toString()), 'nothing is saved after Sign Out — the kept tab neither (it is written below the guard)');
  const sv = listTableUi.toString(), sf = sv.slice(sv.indexOf('function save() {'), sv.indexOf('function countRows()'));
  assert.ok(sf.indexOf('if (win.TDOT_SIGNED_OUT) return;') >= 0 && sf.indexOf('if (win.TDOT_SIGNED_OUT) return;') < sf.indexOf('win.sessionStorage.setItem(o.quick.storeKey, (state.sel[o.quick.facet]'), 'in save(): the guard first');
  assert.ok(require('../src/routes/adminConsultation').buildQueueHTML().includes("function ssSet(k,v){ if(window.TDOT_SIGNED_OUT) return;"));
  // block 3: the words depend on the tab — newest case first on All, Monday's order on a view tab
  assert.equal(S.casesListOpts({}).sortReset({ sel: {} }), 'newest case first');
  assert.equal(S.casesListOpts({}).sortReset({ sel: { view: ['deadlines'] } }), "Monday's order for this view");
  assert.equal(S.consultListOpts({}).countable, undefined, 'the Date filter is the engine’s own now: every row counts');
});

test('2026-11-05 point 7: the Retainers outcome tabs work like the Leads tabs — a new browser tab opens on Retain, the tab shown is kept until it closes (All too, and a tab a link opened), one tab at a time', () => {
  const { listTableUi } = require('../src/routes/listFilters');
  const el = () => ({ setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, contains() { return false; } }, appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, contains() { return false; }, style: {} });
  const start = (store, initial, signedOut) => {
    const win = { TDOT_SIGNED_OUT: !!signedOut, document: { getElementById: () => null, createElement: el, body: el(), addEventListener() {}, activeElement: null, documentElement: el() },
      sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }, addEventListener() {}, location: { search: '' }, renderRetainerList: () => {} };
    const o = S.retainerListOpts({ outcomes: OUTCOME_LABELS, initial, onChange() {} });
    const api = listTableUi(listCore(S.retainerListSpec({ outcomes: OUTCOME_LABELS, today: () => '' })), o, win) || win[o.api];
    return api.state().sel.outcome;
  };
  const q = S.retainerListOpts({ outcomes: OUTCOME_LABELS }).quick;
  assert.deepEqual([q.facet, q.box, q.tabs, q.allLast, q.all, q.default, q.storeKey], ['outcome', 'r-quick', true, true, 'All', 'Retain', 'tdot_list_retainers_tab']);
  assert.ok(q.storeKey.indexOf('tdot_list_') === 0, 'Sign Out forgets it');
  assert.equal(q.label, undefined, 'no "Show" label in front of tabs');
  assert.deepEqual(start({}), ['Retain'], 'a new browser tab opens on Retain');
  assert.deepEqual(start({ tdot_list_retainers_tab: 'Follow-Up' }), ['Follow-Up'], 'the tab chosen is kept');
  assert.equal(start({ tdot_list_retainers_tab: '' }), undefined, 'All is kept too');
  assert.deepEqual(start({ tdot_list_retainers_tab: 'Follow Up' }), ['Retain'], 'a kept tab that no longer exists: Retain');
  // an older saved view with several outcomes on (the buttons could be combined) shows one tab
  assert.deepEqual(start({ tdot_list_retainers: JSON.stringify({ sel: { outcome: ['Newsletter', 'Follow-Up'] } }), tdot_list_retainers_tab: 'Newsletter' }), ['Newsletter']);
  const store = { tdot_list_retainers_tab: 'Follow-Up' };
  assert.deepEqual(start(store, (st) => { st.sel.outcome = ['Not Wanted', 'Retain']; return true; }), ['Not Wanted'], 'a link wins, one tab');
  assert.equal(store.tdot_list_retainers_tab, 'Not Wanted', 'and is kept: the way back from a record (plain /admin/retainers) returns to it');
  assert.deepEqual(start(store), ['Not Wanted'], 'the way back');
  const s2 = { tdot_list_retainers_tab: 'Follow-Up' };
  assert.equal(start(s2, (st) => { delete st.sel.outcome; return true; }), undefined, 'a link to All');
  assert.equal(s2.tdot_list_retainers_tab, '', 'All kept');
  const s3 = { tdot_list_retainers_tab: 'Follow-Up' };
  start(s3, (st) => { st.sel.outcome = ['Newsletter']; return true; }, true);
  assert.equal(s3.tdot_list_retainers_tab, 'Follow-Up', 'never written after Sign Out');
  assert.deepEqual(start({ tdot_list_retainers_tab: 'Follow-Up' }, () => false), ['Follow-Up'], 'not a link: the kept tab');
  // Back brings an older copy of the page out of the browser's memory: it reads the list again (setRows), and the kept
  // tab becomes the tab that copy shows — so the way back from a record returns to the tab on screen (review round 2)
  const s4 = {};
  const win4 = { document: { getElementById: () => null, createElement: el, body: el(), addEventListener() {}, activeElement: null, documentElement: el() },
    sessionStorage: { getItem: (k) => (k in s4 ? s4[k] : null), setItem: (k, v) => { s4[k] = String(v); } }, addEventListener() {}, location: { search: '' }, renderRetainerList: () => {} };
  const o4 = S.retainerListOpts({ outcomes: OUTCOME_LABELS, onChange() {} });
  const api4 = listTableUi(listCore(S.retainerListSpec({ outcomes: OUTCOME_LABELS, today: () => '' })), o4, win4) || win4[o4.api];
  api4.setRows([]);
  assert.equal(s4.tdot_list_retainers_tab, 'Retain', 'shown = kept');
  s4.tdot_list_retainers_tab = 'Follow-Up';   // a newer copy of the page, on Follow-Up, then Back to this one
  api4.setRows([]);
  assert.equal(s4.tdot_list_retainers_tab, 'Retain', 'the copy on screen decides');
  win4.TDOT_SIGNED_OUT = true; s4.tdot_list_retainers_tab = 'x'; api4.setRows([]);
  assert.equal(s4.tdot_list_retainers_tab, 'x', 'nothing written after Sign Out');
  // the click: one value, stored ('' = All) — the same code path as the Leads tabs
  const src = listTableUi.toString();
  assert.ok(src.includes("if (!v) next = []; else if (q.tabs) next = [v];") && src.includes("win.sessionStorage.setItem(q.storeKey, v || '')"));
});


test('point 8 (2026-11-05): a tab kept apart (Retained) is never under All — not its rows, not the header counts — and has its own tab with its own count; lists that keep nothing apart are unchanged', () => {
  const LT = listCore(S.retainerListSpec({ outcomes: [...OUTCOME_LABELS, 'Retained'], apart: ['Retained'], today: () => '' }));
  const rows = [
    { id: '1', outcomeGroup: 'Retain', consultant: 'A' }, { id: '2', outcomeGroup: 'Follow-Up', consultant: 'A' },
    { id: '3', outcomeGroup: 'Retained', consultant: 'A', retained: true }, { id: '4', outcomeGroup: 'Retained', consultant: 'B', retained: true },
  ];
  const st = LT.emptyState();
  assert.deepEqual(LT.filterRows(rows, st).map((r) => r.id), ['1', '2'], 'All: everyone still being worked');
  const tabCounts = Object.fromEntries(LT.facetCounts(rows, st, 'outcome').map((x) => [x.value, x.count]));
  assert.equal(tabCounts.Retained, 2, 'the Retained tab still counts its rows');
  assert.equal(tabCounts.Retain, 1);
  assert.deepEqual(Object.fromEntries(LT.facetCounts(rows, st, 'consultant').map((x) => [x.value, x.count])), { A: 2 }, 'a header filter on All counts only the working rows');
  assert.equal(LT.apartOf('outcome', rows[2]), true); assert.equal(LT.apartOf('outcome', rows[0]), false);
  st.sel.outcome = ['Retained'];
  assert.deepEqual(LT.filterRows(rows, st).map((r) => r.id), ['3', '4'], 'its own tab');
  assert.deepEqual(Object.fromEntries(LT.facetCounts(rows, st, 'consultant').map((x) => [x.value, x.count])), { A: 1, B: 1 });
  st.sel.outcome = ['Follow-Up'];
  assert.deepEqual(LT.filterRows(rows, st).map((r) => r.id), ['2']);
  // nothing kept apart (the Leads tabs, the old Retainers spec): All is everyone, as before
  const plain = listCore(S.retainerListSpec({ outcomes: OUTCOME_LABELS, today: () => '' }));
  assert.deepEqual(plain.filterRows(rows, plain.emptyState()).map((r) => r.id), ['1', '2', '3', '4'], 'an unknown group still falls under Retain, and All shows it');
  assert.equal(plain.apartOf('outcome', rows[2]), false);
  // the tabs: the kept-apart one comes AFTER All, and All counts without it (the page code: listTableUi renderQuick)
  const ui = require('../src/routes/listFilters').listTableUi.toString();
  assert.ok(ui.includes("box.innerHTML = (q.allLast ? tabs.join('') + allTab : allTab + tabs.join('')) + side.join('');"));
  assert.ok(ui.includes('return LT.passesAll(r, state, q.facet) && !LT.apartOf(q.facet, r); }).length'));
  // …and for a list with one date range (every list but Consultations) passesAll IS passes with the tabs skipped
  const stA = LT.emptyState(); stA.sel.consultant = ['A'];
  for (const r of rows) assert.equal(LT.passesAll(r, stA, 'outcome'), LT.passes(r, stA, 'outcome'), r.id);
});

// Consultations: filters and sorting on every column, like the Leads list (Faran 2026-11-11).
test('Consultations: Service, Pre-consult and Outcome filter; Time, Client, Service and Consultant sort; no sort = the server order', () => {
  const spec = S.consultListSpec({}), LT = listCore(spec), o = S.consultListOpts({});
  const rows = [
    { id: '1', name: 'bo Li', service: 'Study Permit', consultant: '', bookedSlot: '2026-11-12T10:00', preConsultSubmitted: true, outcome: 'Retain' },
    { id: '2', name: 'Asha Rao', service: '', consultant: 'Shermin T', bookedSlot: '2026-11-11T09:00', preConsultSubmitted: false, outcome: '' },
    { id: '3', name: 'Chen Wu', service: 'express Entry', consultant: 'Shafoli Kapur', bookedSlot: '2026-11-13T15:30', preConsultSubmitted: false, outcome: 'Follow-Up' },
  ];
  const st = (sel) => { const x = LT.emptyState(); x.sel = sel; return x; };
  assert.equal(ids(LT.filterRows(rows, st({ service: ['Study Permit'] }))), '1');
  assert.equal(ids(LT.filterRows(rows, st({ service: [LT.NONE] }))), '2');
  assert.equal(ids(LT.filterRows(rows, st({ preconsult: ['pending'] }))), '2,3');
  assert.equal(ids(LT.filterRows(rows, st({ outcome: [LT.NONE, 'Retain'] }))), '1,2');
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'preconsult').map((x) => [x.label, x.count]), [['Submitted', 1], ['Pending', 2]]);
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'outcome').map((x) => x.label), ['Retain', 'Follow-Up', 'No outcome yet']);
  assert.deepEqual(LT.chips(st({ outcome: ['Follow-Up'], service: [LT.NONE] })).map((c) => c.text).sort(), ['Outcome: Follow-Up', 'Service: Not set']);

  assert.equal(LT.emptyState().sort, null);
  assert.equal(ids(LT.sortRows(rows, null)), '1,2,3', 'no column chosen: as the server sent them');
  assert.equal(ids(LT.sortRows(rows, { key: 'date', dir: 'asc' })), '2,1,3');
  assert.equal(ids(LT.sortRows(rows, { key: 'date', dir: 'desc' })), '3,1,2');
  assert.equal(ids(LT.sortRows(rows, { key: 'time', dir: 'asc' })), '2,1,3', 'the time of day: 09:00, 10:00, 15:30');
  assert.equal(ids(LT.sortRows(rows, { key: 'client', dir: 'asc' })), '2,1,3', 'names sort without regard to capitals');
  assert.equal(ids(LT.sortRows(rows, { key: 'service', dir: 'asc' })), '3,1,2', 'no service goes last');
  assert.equal(ids(LT.sortRows(rows, { key: 'service', dir: 'desc' })), '1,3,2', 'no service goes last both ways');
  assert.equal(ids(LT.sortRows(rows, { key: 'consultant', dir: 'asc' })), '3,2,1', 'unassigned goes last');

  // Every column but the delete button has a filter or a sort; the sort can be undone.
  for (const c of o.cols) if (c.id !== 'del') assert.ok(c.sort || (c.facets && c.facets.length), c.id);
  for (const c of o.cols) { if (c.sort) { assert.ok(spec.sorts[c.sort], c.id); assert.equal(c.sortText.length, 2); } (c.facets || []).forEach((f) => assert.ok(spec.facets[f], f)); }
  assert.equal(o.sortReset, 'earliest consultation first');
});

// Consultations: the Date column's filter replaced the Today / This week / This month / All buttons (Faran 2026-11-11).
test('Consultations: the Date filter — choices that look ahead; each tab has its own range; the Booked tab opens on today', () => {
  const today = '2026-11-11';   // a Wednesday
  const spec = S.consultListSpec({ today: () => today }), LT = listCore(spec), o = S.consultListOpts({});
  const now = Date.parse('2026-11-11T17:00:00Z');
  assert.deepEqual(LT.presetRange('today', now), { from: today, to: today });
  assert.deepEqual(LT.presetRange('tomorrow', now), { from: '2026-11-12', to: '2026-11-12' });
  assert.deepEqual(LT.presetRange('week', now), { from: '2026-11-09', to: '2026-11-15' }, 'Monday to Sunday');
  assert.deepEqual(LT.presetRange('nextweek', now), { from: '2026-11-16', to: '2026-11-22' });
  assert.deepEqual(LT.presetRange('fullmonth', now), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(LT.presetRange('week', Date.parse('2026-11-15T17:00:00Z')), { from: '2026-11-09', to: '2026-11-15' }, 'a Sunday belongs to the week before');
  assert.deepEqual(LT.presetRange('week', Date.parse('2026-11-16T03:30:00Z')), { from: '2026-11-09', to: '2026-11-15' }, 'late Sunday evening in Toronto is still Sunday');
  assert.deepEqual(LT.presetRange('fullmonth', Date.parse('2028-02-10T17:00:00Z')), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(spec.date.presets.map((p) => p[1]), ['Today', 'Tomorrow', 'This week', 'Next week', 'This month']);

  const rows = [
    { id: 'today', bookedSlot: '2026-11-11 10:00' },
    { id: 'tomorrow', bookedSlot: '2026-11-12 10:00' },
    { id: 'needs', bookedSlot: '2026-11-03 10:00', outcome: '' },                       // passed, nothing recorded
    { id: 'pastdone', bookedSlot: '2026-11-03 11:00', outcome: 'Retain' },
    { id: 'pastfile', bookedSlot: '2026-11-03 12:00', direct: 'Existing client' },     // nothing to decide: an ordinary row
    { id: 'nodate', bookedSlot: '' },
  ];
  // on All (no tab chosen) the range is All's own: it narrows every row — one with no date is hidden while it is on
  const on = (from, to) => LT.setDates(LT.emptyState(), from, to);
  assert.equal(ids(LT.filterRows(rows, on(today, today))), 'today');
  assert.equal(ids(LT.filterRows(rows, on('2026-11-12', '2026-11-12'))), 'tomorrow');
  assert.equal(ids(LT.filterRows(rows, on('2026-11-01', '2026-11-05'))), 'needs,pastdone,pastfile');
  assert.equal(ids(LT.filterRows(rows, on('2026-11-05', '2026-11-01'))), 'needs,pastdone,pastfile', 'From after To: read the other way round');
  assert.equal(ids(LT.filterRows(rows, LT.emptyState())), 'today,tomorrow,needs,pastdone,pastfile,nodate', 'no date chosen: everything');
  assert.deepEqual(LT.chips(on(today, today)).map((c) => c.text), ['Date Nov 11']);
  const cleared = on(today, today); LT.clearKey(cleared, 'date'); assert.deepEqual(cleared.dates, {});
  assert.deepEqual(spec.date.per, { facet: 'tab', all: 'all', none: ['nodate'], legacy: 'booked' });
  assert.equal(spec.date.exempt, undefined, 'the old "booked rows only" rule is gone');

  assert.equal(o.defaultDateScope, 'booked');
  assert.equal(o.defaultDate, 'today');
  assert.deepEqual(o.cols.slice(0, 2).map((c) => [c.id, c.menu || '', c.sort]), [['date', 'date', 'date'], ['time', 'facet', 'time']]);
  // The Leads list is untouched: no opening date, its own choices, nothing exempt.
  const leads = require('../src/routes/leadsTableFilters');
  assert.equal(leads.leadsTableOpts().defaultDate, undefined);
  assert.equal(leads.leadsTableSpec().date.presets, undefined);
  assert.equal(leads.leadsTableSpec().date.exempt, undefined);
});

// The opening date in the browser part (review 2026-11-11): a new tab — or a tab from before this rule — opens on today;
// a date taken off stays off; a tab left on "today" overnight moves on, at start AND at a redraw (refresh / Back);
// a chosen other day or range is kept. The mark beside the kept filters is the day only while the filter is "today".
test('listTableUi opening date: default today, kept choices, overnight roll-over (also on a redraw); Leads has none of it', () => {
  const { listTableUi } = require('../src/routes/listFilters');
  const K = 'tdot_list_consultations', realNow = Date.now;
  const el = () => ({ setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, contains() { return false; } }, appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, contains() { return false; }, style: {} });
  const open = (store, opts) => {
    const seen = [];
    const win = { document: { getElementById: () => null, createElement: el, body: el(), addEventListener() {}, activeElement: null, documentElement: el() },
      sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }, addEventListener() {}, location: { search: '' },
      renderConsultList: (rows, why, st) => { const d = LT.getDates(st, 'booked'); seen.push(d.from + '..' + d.to); return null; }, renderRows: (rows, why, st) => { seen.push(st.from + '..' + st.to); } };
    const o = opts || Object.assign({}, S.consultListOpts({}), { serverSearch: null });
    const LT = opts ? require('../src/routes/leadsTableFilters').leadsTableCore() : listCore(S.consultListSpec({}));
    const api = listTableUi(LT, o, win) || win[o.api];
    api.setRows([]);
    return { seen, api, store };
  };
  const saved = (from, to) => JSON.stringify({ q: '', from, to, sel: {} });
  try {
    Date.now = () => Date.parse('2026-11-11T17:00:00Z');
    let r = open({});
    assert.deepEqual(r.seen, ['2026-11-11..2026-11-11'], 'a new browser tab');
    assert.equal(r.store[K + '_day'], '2026-11-11');
    r = open({ [K]: saved('', '') });
    assert.deepEqual(r.seen, ['2026-11-11..2026-11-11'], 'a tab from before this rule (filters kept, no mark)');
    r = open({ [K]: saved('', ''), [K + '_day']: '' });
    assert.deepEqual(r.seen, ['..'], 'the date was taken off: kept off');
    r = open({ [K]: saved('2026-11-10', '2026-11-10'), [K + '_day']: '2026-11-10' });
    assert.deepEqual(r.seen, ['2026-11-11..2026-11-11'], 'left on today overnight, then reloaded');
    r = open({ [K]: saved('2026-11-20', '2026-11-20'), [K + '_day']: '' });
    assert.deepEqual(r.seen, ['2026-11-20..2026-11-20'], 'a chosen other day');
    r = open({ [K]: saved('2026-11-09', '2026-11-15'), [K + '_day']: '' });
    assert.deepEqual(r.seen, ['2026-11-09..2026-11-15'], 'a chosen range');

    // the page stays open over midnight: the next redraw (refresh, Back, a click) moves on, and the mark with it
    r = open({});
    Date.now = () => Date.parse('2026-11-12T14:00:00Z');
    r.api.setRows([]);
    assert.deepEqual(r.seen, ['2026-11-11..2026-11-11', '2026-11-12..2026-11-12']);
    assert.equal(r.store[K + '_day'], '2026-11-12');
    assert.equal(JSON.parse(r.store[K]).dates.booked.from, '2026-11-12');
    // …but a day chosen by hand yesterday is not "today": it stays
    Date.now = () => Date.parse('2026-11-11T17:00:00Z');
    r = open({ [K]: saved('2026-11-12', '2026-11-12'), [K + '_day']: '' });
    Date.now = () => Date.parse('2026-11-12T14:00:00Z');
    r.api.setRows([]);
    assert.deepEqual(r.seen, ['2026-11-12..2026-11-12', '2026-11-12..2026-11-12']);
    // choosing today by hand becomes "today" (it rolls); taking the date off writes the empty mark
    r.api.core.setDates(r.api.state(), '', '', 'booked'); r.api.apply('filter');
    assert.equal(r.store[K + '_day'], '');

    // Leads: no opening date, no mark
    Date.now = () => Date.parse('2026-11-11T17:00:00Z');
    const lo = Object.assign({}, require('../src/routes/leadsTableFilters').leadsTableOpts(), { serverSearch: null, quick: null });
    r = open({}, lo);
    assert.deepEqual(r.seen, ['..']);
    assert.ok(!((lo.key + '_day') in r.store));
  } finally { Date.now = realNow; }
});

/* ── A date range per tab (Faran 2026-11-12: filters and sorting on every column, on every Consultations tab) ── */

// The engine, on a list of its own: spec.date.per gives every tab (and All) its own from/to.
test('engine, a date range per tab: each tab keeps its own range; a tab\'s number = the rows it shows; All has its own; a tab can have no date filter; without `per` nothing changes', () => {
  const spec = () => ({
    facets: { kind: { label: 'Kind', quick: true, get: (r) => r.kind, order: ['a', 'b', 'x'] }, colour: { label: 'Colour', get: (r) => r.colour } },
    date: { key: 'day', chip: 'Day', get: (r) => r.day, per: { facet: 'kind', all: '*', none: ['x'], legacy: 'a' } },
    search: { text: (r) => r.id },
  });
  const LT = listCore(spec());
  const rows = [
    { id: 'a1', kind: 'a', day: '2026-01-01', colour: 'red' }, { id: 'a2', kind: 'a', day: '2026-01-05', colour: 'blue' },
    { id: 'b1', kind: 'b', day: '2026-01-01', colour: 'red' }, { id: 'b2', kind: 'b', day: '2026-01-09', colour: 'red' }, { id: 'b3', kind: 'b', day: '', colour: 'blue' },
    { id: 'x1', kind: 'x', day: '', colour: 'red' }, { id: 'x2', kind: 'x', day: '2026-01-05', colour: 'red' },
  ];
  const st = LT.emptyState();
  assert.deepEqual(st.dates, {});
  LT.setDates(st, '2026-01-05', '2026-01-05', 'a');
  LT.setDates(st, '2026-01-01', '2026-01-09', 'b');
  LT.setDates(st, '2026-01-01', '2026-01-01', '*');
  LT.setDates(st, '2026-01-05', '2026-01-05', 'x');
  assert.deepEqual(st.dates, { a: { from: '2026-01-05', to: '2026-01-05' }, b: { from: '2026-01-01', to: '2026-01-09' }, '*': { from: '2026-01-01', to: '2026-01-01' } }, 'a tab with no date filter never holds a range');
  const onTab = (k, base) => { const x = JSON.parse(JSON.stringify(base || st)); if (k === '*') delete x.sel.kind; else x.sel.kind = [k]; return x; };
  const shown = (k, base) => ids(LT.filterRows(rows, onTab(k, base)));
  assert.deepEqual([shown('a'), shown('b'), shown('x'), shown('*')], ['a2', 'b1,b2', 'x1,x2', 'a1,b1']);
  // the numbers on the tabs — whichever tab is on view — are the rows each tab shows when opened
  for (const view of ['a', 'b', 'x', '*']) {
    const v = onTab(view), counts = Object.fromEntries(LT.facetCounts(rows, v, 'kind').map((c) => [c.value, c.count]));
    for (const k of ['a', 'b', 'x']) assert.equal(counts[k], LT.filterRows(rows, onTab(k)).length, `on ${view}: the ${k} tab`);
    assert.equal(rows.filter((r) => LT.passesAll(r, v, 'kind')).length, 2, `on ${view}: All`);
  }
  // …with the shared filters and the search on top
  const red = onTab('b'); red.sel.colour = ['red']; red.q = '1';
  assert.equal(ids(LT.filterRows(rows, red)), 'b1');
  assert.deepEqual(Object.fromEntries(LT.facetCounts(rows, red, 'kind').map((c) => [c.value, c.count])), { b: 1, x: 1 });
  assert.equal(rows.filter((r) => LT.passesAll(r, red, 'kind')).length, 2);
  // another column's choices are counted inside the tab on view and its range
  assert.deepEqual(Object.fromEntries(LT.facetCounts(rows, onTab('b'), 'colour').map((c) => [c.value, c.count])), { red: 2 });
  assert.deepEqual(Object.fromEntries(LT.facetCounts(rows, onTab('x'), 'colour').map((c) => [c.value, c.count])), { red: 2 });
  // one tab's range never changes another tab's number
  const before = Object.fromEntries(LT.facetCounts(rows, st, 'kind').map((c) => [c.value, c.count]));
  const moved = onTab('a'); LT.setDates(moved, '2030-01-01', '2030-01-01');
  const after = Object.fromEntries(LT.facetCounts(rows, moved, 'kind').map((c) => [c.value, c.count]));
  assert.deepEqual([after.a || 0, after.b, after.x], [0, before.b, before.x]);
  // reading and showing: the tab on view
  assert.deepEqual(LT.getDates(onTab('b')), { from: '2026-01-01', to: '2026-01-09' });
  assert.deepEqual(LT.range(onTab('x')), ['', '']);
  assert.deepEqual([LT.scopeOf(onTab('b')), LT.scopeOf(onTab('*')), LT.hasDates('x'), LT.hasDates('b'), LT.hasDates('*')], ['b', '*', false, true, true]);
  assert.deepEqual(LT.chips(onTab('a')).map((c) => c.text), ['Day Jan 5']);
  assert.deepEqual(LT.chips(onTab('x')), []);
  // the chip's × and "Clear filters": the tab on view only
  const c1 = LT.clearKey(onTab('b'), 'day');
  assert.deepEqual(Object.keys(c1.dates).sort(), ['*', 'a']);
  const withColour = onTab('*'); withColour.sel.colour = ['red'];
  const c2 = LT.clearAll(withColour);
  assert.deepEqual([Object.keys(c2.dates).sort().join(), c2.sel.colour, c2.sel.kind], ['a,b', undefined, undefined]);
  assert.deepEqual(LT.clearAll(onTab('x')).dates, st.dates, 'on a tab with no date filter nothing is cleared unseen');
  assert.deepEqual(LT.clearAll(onTab('b')).sel.kind, ['b'], 'the tab stays');
  // a kept state: cleaned; unknown tabs and bad days dropped; a state from before (one from/to) was the `legacy` tab's
  assert.deepEqual(LT.normalizeState(JSON.parse(JSON.stringify(st))).dates, st.dates);
  assert.deepEqual(LT.normalizeState({ dates: { a: { from: 'x', to: '2026-02-02' }, x: { from: '2026-01-01', to: '2026-01-01' }, zz: { from: '2026-01-01', to: '2026-01-01' }, b: 'no', constructor: { from: '2026-01-01' } } }).dates, { a: { from: '', to: '2026-02-02' } });
  assert.deepEqual(LT.normalizeState({ from: '2026-03-01', to: '2026-03-02', sel: { kind: ['b'] } }).dates, { a: { from: '2026-03-01', to: '2026-03-02' } });
  assert.deepEqual(LT.normalizeState({ from: '2026-03-01', to: '2026-03-02', dates: {} }).dates, {}, 'a new state never takes the old pair');
  assert.deepEqual(LT.normalizeState({ from: '', to: '' }).dates, {});
  for (const bad of [null, 5, 'x', { dates: null }, { dates: 7, from: 3 }, { dates: [] }]) assert.deepEqual(LT.normalizeState(bad).dates, {}, JSON.stringify(bad));

  // WITHOUT `per` (Leads, Retainers, Client Master): one from/to in the state, exactly as before
  const plainSpec = spec(); delete plainSpec.date.per;
  const P = listCore(plainSpec), ps = P.emptyState();
  assert.equal('dates' in ps, false);
  P.setDates(ps, '2026-01-05', '2026-01-05', 'b');
  assert.deepEqual([ps.from, ps.to, P.getDates(ps, 'a'), P.scopeOf(ps), P.hasDates('x')], ['2026-01-05', '2026-01-05', { from: '2026-01-05', to: '2026-01-05' }, '', true]);
  ps.sel.kind = ['b'];
  assert.equal(ids(P.filterRows(rows, ps)), '', 'one range for every tab');
  assert.deepEqual(Object.fromEntries(P.facetCounts(rows, ps, 'kind').map((c) => [c.value, c.count])), { a: 1, b: 0, x: 1 });
  for (const r of rows) assert.equal(P.passesAll(r, ps, 'kind'), P.passes(r, ps, 'kind'));
  assert.deepEqual(P.normalizeState({ from: '2026-03-01', to: 'nope', dates: { a: { from: '2026-01-01', to: '2026-01-01' } } }), Object.assign(P.emptyState(), { from: '2026-03-01' }));
  assert.deepEqual(P.clearAll(ps).from, '');
  // the Leads list really has no `per`
  const leads = require('../src/routes/leadsTableFilters');
  assert.equal(leads.leadsTableSpec().date.per, undefined);
  assert.equal('dates' in leads.leadsTableCore().emptyState(), false);
});

test('Consultations: Mode, Agreement, Pre-consult, Paid, Outcome and Now sort in the order their filter lists them; "not set" goes last both ways; ties keep the order given', () => {
  const spec = S.consultListSpec({ today: () => '2026-11-12' }), LT = listCore(spec), o = S.consultListOpts({});
  const rows = [
    { id: '1', meetingType: 'Phone Call', agreementSent: '2026-11-01', preConsultSubmitted: false, paid: 'cash', outcome: 'Not Wanted', done: true, now: 'Closed' },
    { id: '2', meetingType: '', agreementSigned: '2026-11-02', agreementSent: '2026-11-01', preConsultSubmitted: true, paid: '', outcome: '', done: false, now: '' },
    { id: '3', meetingType: 'In-person', preConsultSubmitted: true, paid: 'waived', outcome: 'Retain', done: true, now: 'Retained' },
    { id: '4', meetingType: 'Virtual', agreementSigned: '2026-11-03', preConsultSubmitted: false, paid: 'app', outcome: 'Follow-Up', done: true, now: 'Following up' },
    { id: '5', meetingType: 'Virtual', agreementSent: '2026-11-04', preConsultSubmitted: true, paid: 'app', outcome: 'Newsletter', done: true, now: '' },
    { id: '6', meetingType: 'Zoom', preConsultSubmitted: false, paid: 'invoice', outcome: 'Some old outcome', done: true, now: 'Retainer sent' },
  ];
  const by = (key, dir) => ids(LT.sortRows(rows, { key, dir }));
  assert.equal(by('mode', 'asc'), '3,4,5,1,6,2', 'In-person, Virtual, Phone Call, a value the list does not know, then not set');
  assert.equal(by('mode', 'desc'), '6,1,4,5,3,2', 'not set stays last; equal rows keep their order');
  assert.equal(by('agreement', 'asc'), '2,4,1,5,3,6', 'Signed, Sent not signed, Not sent');
  assert.equal(by('agreement', 'desc'), '3,6,1,5,2,4');
  assert.equal(by('preconsult', 'asc'), '2,3,5,1,4,6');
  assert.equal(by('preconsult', 'desc'), '1,4,6,2,3,5');
  assert.equal(by('paid', 'asc'), '4,5,1,6,3,2', 'Paid (app), recorded by staff, Waived, Not paid');
  assert.equal(by('paid', 'desc'), '2,3,1,6,4,5');
  assert.equal(by('outcome', 'asc'), '3,4,5,1,6,2', 'Retain, Follow-Up, Newsletter, Not Wanted, an old label, then no outcome');
  assert.equal(by('outcome', 'desc'), '6,1,5,4,3,2');
  assert.equal(by('now', 'asc'), '3,6,4,1,2,5', 'Retained … Closed; nothing in the cell goes last');
  assert.equal(by('now', 'desc'), '1,4,6,3,2,5');
  // the sort order IS the filter list's order
  for (const f of ['mode', 'agreement', 'preconsult', 'paid', 'outcome']) {
    const listed = LT.facetCounts(rows, LT.emptyState(), f).filter((x) => x.count && x.value !== LT.NONE).map((x) => x.value);
    const sorted = LT.sortRows(rows, { key: f, dir: 'asc' }).map((r) => LT.valuesOf(f, r)[0]).filter((v, i, a) => v !== LT.NONE && a.indexOf(v) === i);
    assert.deepEqual(sorted, listed, f);
  }
  // every column but the delete button: a sort both ways, said plainly
  for (const c of o.cols) {
    if (c.id === 'del') { assert.equal(c.sort, undefined); continue; }
    assert.ok(spec.sorts[c.sort], c.id + ' sorts');
    assert.deepEqual([c.sortDirs.join(), c.sortText.length, c.sortText.every((t) => t && t[0] === t[0].toUpperCase())], ['asc,desc', 2, true], c.id);
  }
  assert.deepEqual(o.cols.filter((c) => c.sort).map((c) => c.sortText[0]), ['Earliest first', 'Earliest in the day first', 'A → Z', 'A → Z', 'A → Z', 'In-person first', 'Signed first', 'Submitted first', 'Paid first', 'Retain first', 'Retained first']);
  // every column but Client and the delete button has a filter; Client points to the search box (like the Leads "Lead" column)
  for (const c of o.cols) if (c.id !== 'del' && c.id !== 'client') assert.ok(c.date || (c.facets && c.facets.length), c.id + ' filters');
  const client = o.cols.find((c) => c.id === 'client');
  assert.deepEqual([client.facets, client.flags, client.menu, client.note], [undefined, undefined, 'lead', 'To filter by client, use the search box above the table (name, phone or email).']);
  // the panel: a column with a sort and a note has one (sort both ways + the note, no "Clear"); the other lists' columns are as before
  const ui = require('../src/routes/listFilters').listTableUi.toString();
  assert.ok(ui.includes('function hasPanel(c) { return hasFilter(c) || !!(c.sort && c.note); }'));
  assert.ok(ui.includes("(hasFilter(c) ? '<button type=\"button\" class=\"qp-link\" data-act=\"clear\">Clear</button>' : '<span></span>')"));
  const others = [require('../src/routes/leadsTableFilters').leadsTableOpts(), S.retainerListOpts({ outcomes: OUTCOME_LABELS }), S.casesListOpts({})];
  for (const op of others) for (const c of op.cols) if (c.note) assert.ok((c.flags && c.flags.length) || (c.facets && c.facets.length) || c.date, 'a note-only column exists on Consultations only');
});

test('Consultations: the Time filter — Morning before 12:00, Afternoon 12:00 to before 17:00, Evening from 17:00, No time; always the four, in that order', () => {
  const LT = listCore(S.consultListSpec({ today: () => '2026-11-12' })), o = S.consultListOpts({});
  const band = (slot) => LT.valuesOf('time', { bookedSlot: slot })[0];
  const cases = [['2026-11-12 00:00', 'morning'], ['2026-11-12 09:30', 'morning'], ['2026-11-12 11:59', 'morning'], ['2026-11-12 12:00', 'afternoon'], ['2026-11-12 16:59', 'afternoon'],
    ['2026-11-12 17:00', 'evening'], ['2026-11-12 23:59', 'evening'], ['2026-11-12T08:15', 'morning'], ['', 'none'], [null, 'none'], [undefined, 'none'], ['2026-11-12', 'none'], ['2026-11-12 ', 'none'],
    ['10:00', 'none'], ['not a date 10:00', 'none'], ['2026-11-12 1pm', 'none']];
  for (const [slot, want] of cases) assert.equal(band(slot), want, JSON.stringify(slot));
  const rows = [{ id: 'm', bookedSlot: '2026-11-12 11:59' }, { id: 'a', bookedSlot: '2026-11-12 12:00' }, { id: 'a2', bookedSlot: '2026-11-13 16:59' }, { id: 'e', bookedSlot: '2026-11-12 17:00' }, { id: 'z', bookedSlot: '' }];
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'time').map((x) => [x.label, x.count]),
    [['Morning (before 12:00)', 1], ['Afternoon (12:00 to 16:59)', 2], ['Evening (17:00 and later)', 1], ['No time', 1]]);
  assert.deepEqual(LT.facetCounts([rows[0]], LT.emptyState(), 'time').map((x) => [x.value, x.count]), [['morning', 1], ['afternoon', 0], ['evening', 0], ['none', 0]], 'all four are always listed');
  const st = LT.emptyState(); st.sel.time = ['afternoon', 'none'];
  assert.equal(ids(LT.filterRows(rows, st)), 'a,a2,z');
  assert.deepEqual(LT.chips(st).map((c) => c.text), ['Time: Afternoon (12:00 to 16:59), No time']);
  assert.deepEqual(LT.clearKey(st, 'time').sel, {});
  assert.deepEqual(o.cols.find((c) => c.id === 'time').facets, ['time']);
  // the Time sort is untouched by the filter of the same name
  assert.equal(ids(LT.sortRows(rows.slice(0, 4), { key: 'time', dir: 'desc' })), 'e,a2,a,m');
});

// The sample the tab-count tests share: today is 2026-11-12.
function consultSample() {
  return [
    { id: 'b1', name: 'Asha', bookedSlot: '2026-11-12 09:00', consultant: 'S' }, { id: 'b2', name: 'Bo', bookedSlot: '2026-11-13 14:00', consultant: 'T' }, { id: 'b3', name: 'Chen', bookedSlot: '2026-11-20 18:00', consultant: 'S' },
    { id: 'n1', name: 'Dev', bookedSlot: '2026-11-03 10:00', consultant: 'S' }, { id: 'n2', name: 'Eli', bookedSlot: '2026-11-10 11:00', consultant: 'T' }, { id: 'n3', name: 'Fay', bookedSlot: '2026-10-28 16:59', consultant: 'S' },
    { id: 'd1', name: 'Gia', bookedSlot: '2026-11-05 10:00', done: true, outcome: 'Retain', now: 'Retained', consultant: 'S' }, { id: 'd2', name: 'Hal', bookedSlot: '2026-10-15 13:00', done: true, outcome: 'Follow-Up', now: 'Following up', consultant: 'T' },
    { id: 'd3', name: 'Ida', bookedSlot: '2026-09-02 09:00', done: true, outcome: 'Not Wanted', now: 'Closed', consultant: 'S' }, { id: 'd4', name: 'Jo', bookedSlot: '', done: true, outcome: 'Retain', now: 'Retained', consultant: 'S' },
    { id: 'z1', name: 'Kai', bookedSlot: '', consultant: 'T' },
  ];
}

test('Consultations: each tab\'s number = the rows that tab shows when opened, with its own date range plus the shared filters and search (table-driven)', () => {
  const LT = listCore(S.consultListSpec({ today: () => '2026-11-12' }));
  const rows = consultSample();
  const TABS = ['booked', 'needs', 'done', 'nodate', 'all'];
  const D = (a, b) => ({ from: a, to: b === undefined ? a : b });
  // [what, the ranges per tab, the shared filters, the rows each tab must show]
  const table = [
    ['no ranges', {}, {}, { booked: 'b1,b2,b3', needs: 'n1,n2,n3', done: 'd1,d2,d3,d4', nodate: 'z1', all: 'b1,b2,b3,n1,n2,n3,d1,d2,d3,d4,z1' }],
    ['Booked on today only', { booked: D('2026-11-12') }, {}, { booked: 'b1', needs: 'n1,n2,n3', done: 'd1,d2,d3,d4', nodate: 'z1', all: 'b1,b2,b3,n1,n2,n3,d1,d2,d3,d4,z1' }],
    ['a different range on every tab', { booked: D('2026-11-12'), needs: D('2026-11-01', '2026-11-05'), done: D('2026-10-01', '2026-10-31'), all: D('2026-11-01', '2026-11-30') }, {},
      { booked: 'b1', needs: 'n1', done: 'd2', nodate: 'z1', all: 'b1,b2,b3,n1,n2,d1' }],
    ['…with a consultant ticked', { booked: D('2026-11-12', '2026-11-30'), needs: D('2026-11-01', '2026-11-05'), done: D('', '2026-10-31'), all: D('2026-11-01', '') }, { sel: { consultant: ['S'] } },
      { booked: 'b1,b3', needs: 'n1', done: 'd3', nodate: '', all: 'b1,b3,n1,d1' }],
    ['…with a search', { needs: D('2026-10-01', '2026-10-31'), all: D('2026-09-01', '2026-09-30') }, { q: 'a' },
      { booked: 'b1', needs: 'n3', done: 'd1,d2,d3', nodate: 'z1', all: 'd3' }],
    ['a part of the day and a range that matches nothing', { booked: D('2027-01-01'), done: D('2026-11-05') }, { sel: { time: ['morning'] } },
      { booked: '', needs: 'n1,n2', done: 'd1', nodate: '', all: 'b1,n1,n2,d1,d3' }],
    ['From after To is read the other way round', { needs: D('2026-11-10', '2026-11-01') }, {}, { booked: 'b1,b2,b3', needs: 'n1,n2', done: 'd1,d2,d3,d4', nodate: 'z1', all: 'b1,b2,b3,n1,n2,n3,d1,d2,d3,d4,z1' }],
  ];
  for (const [what, ranges, shared, want] of table) {
    const base = LT.emptyState();
    for (const k of Object.keys(ranges)) LT.setDates(base, ranges[k].from, ranges[k].to, k);
    base.q = shared.q || ''; Object.assign(base.sel, shared.sel || {});
    const on = (tab) => { const st = JSON.parse(JSON.stringify(base)); if (tab !== 'all') st.sel.tab = [tab]; return st; };
    for (const tab of TABS) assert.equal(ids(LT.filterRows(rows, on(tab))), want[tab], `${what}: the ${tab} tab shows`);
    // the numbers on the five tabs, read from EVERY tab: always the rows that tab shows
    for (const view of TABS) {
      const st = on(view), counts = Object.fromEntries(LT.facetCounts(rows, st, 'tab').map((x) => [x.value, x.count]));
      for (const tab of TABS.slice(0, 4)) assert.equal(counts[tab] || 0, want[tab] ? want[tab].split(',').length : 0, `${what}: the ${tab} number, seen from ${view}`);
      assert.equal(rows.filter((r) => LT.passesAll(r, st, 'tab')).length, want.all ? want.all.split(',').length : 0, `${what}: the All number, seen from ${view}`);
    }
  }
  // the No date tab never takes a range, and a kept state naming one for it is cleaned
  const st = LT.emptyState(); st.sel.tab = ['nodate']; LT.setDates(st, '2026-11-12', '2026-11-12');
  assert.deepEqual([st.dates, LT.chips(st), ids(LT.filterRows(rows, st))], [{}, [], 'z1']);
  assert.deepEqual(LT.normalizeState({ dates: { nodate: D('2026-11-12'), all: D('2026-11-01', '2026-11-30') } }).dates, { all: D('2026-11-01', '2026-11-30') });
  // every other column still filters and sorts there
  const nd = [{ id: 'p', bookedSlot: '', paid: 'app', name: 'Zed' }, { id: 'q', bookedSlot: '', paid: '', name: 'Amy' }];
  const s2 = LT.emptyState(); s2.sel.tab = ['nodate']; s2.sel.paid = ['none'];
  assert.equal(ids(LT.filterRows(nd, s2)), 'q');
  assert.equal(ids(LT.sortRows(nd, { key: 'client', dir: 'asc' })), 'q,p');
  // a filter panel's numbers (another column) are counted inside the tab on view and ITS range
  const p = LT.emptyState(); p.sel.tab = ['needs']; LT.setDates(p, '2026-11-01', '2026-11-05'); LT.setDates(p, '2026-11-12', '2026-11-12', 'booked');
  assert.deepEqual(Object.fromEntries(LT.facetCounts(rows, p, 'consultant').map((x) => [x.value, x.count])), { S: 1 });
});

// The browser part, on the real Consultations spec and options: what a person sees and what is kept.
test('listTableUi, Consultations dates per tab: Booked opens on today and rolls over (also while another tab is on view); the other tabs open on every date; an old kept range becomes Booked\'s; the tab numbers are the rows shown', () => {
  const { listTableUi } = require('../src/routes/listFilters');
  const K = 'tdot_list_consultations', TK = 'tdot_list_consult_tab4', realNow = Date.now;
  const el = () => ({ innerHTML: '', textContent: '', setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, contains() { return false; } }, appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, contains() { return false; }, focus() {}, style: {} });
  const open = (store, rows, signedOut) => {
    const shown = [], els = { 'cq-tabs': el(), 'cq-chips': el(), 'cq-headrow': el() };
    const win = { document: { getElementById: (id) => els[id] || null, createElement: el, body: el(), addEventListener() {}, activeElement: null, documentElement: el() },
      sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }, addEventListener() {}, location: { search: '' }, TDOT_SIGNED_OUT: !!signedOut,
      renderConsultList: (list) => { shown.push(ids(list)); return null; } };
    const o = Object.assign({}, S.consultListOpts({}), { serverSearch: null });
    const LT = listCore(S.consultListSpec({ today: () => LT0.presetRange('today', Date.now()).from }));
    const api = listTableUi(LT, o, win) || win[o.api];
    api.setRows(rows || []);
    const go = (tab) => { if (tab === 'all') delete api.state().sel.tab; else api.state().sel.tab = [tab]; api.apply('filter'); return shown[shown.length - 1]; };
    const nums = () => { const out = {}; els['cq-tabs'].innerHTML.replace(/data-quick="([^"]*)"[^>]*>[^<]*<span class="lt-tab-n">(\d+)<\/span>/g, (m, k, n) => { out[k || 'all'] = Number(n); }); return out; };
    const dates = (tab) => { const d = LT.getDates(api.state(), tab); return d.from + '..' + d.to; };
    return { api, LT, store, shown, go, nums, dates, els };
  };
  const LT0 = listCore(S.consultListSpec({}));
  try {
    Date.now = () => Date.parse('2026-11-12T17:00:00Z');
    // a new browser tab: Booked on today; every other tab on every date
    let r = open({}, consultSample());
    assert.deepEqual(['booked', 'needs', 'done', 'all', 'nodate'].map(r.dates), ['2026-11-12..2026-11-12', '..', '..', '..', '..']);
    assert.equal(r.shown[0], 'b1');
    assert.deepEqual(r.nums(), { booked: 1, needs: 3, done: 4, nodate: 1, all: 11 });
    assert.match(r.els['cq-chips'].innerHTML, /data-chip="date"/);
    // each tab: its own range, set the way the panel sets it; the numbers = the rows each tab shows
    r.go('needs'); assert.ok(!/data-chip="date"/.test(r.els['cq-chips'].innerHTML), 'Needs outcome opens on every date: no Date chip');
    r.LT.setDates(r.api.state(), '2026-11-01', '2026-11-05'); r.api.apply('filter');
    assert.match(r.els['cq-chips'].innerHTML, /Date Nov 1 – Nov 5/);
    r.go('done'); r.LT.setDates(r.api.state(), '2026-10-01', '2026-10-31'); r.api.apply('filter');
    r.go('all'); r.LT.setDates(r.api.state(), '2026-11-01', '2026-11-30'); r.api.apply('filter');
    const want = { booked: 'b1', needs: 'n1', done: 'd2', nodate: 'z1', all: 'b1,b2,b3,n1,n2,d1' };
    for (const view of Object.keys(want)) {
      assert.equal(r.go(view), want[view], view + ' shows');
      assert.deepEqual(r.nums(), { booked: 1, needs: 1, done: 1, nodate: 1, all: 6 }, 'the numbers, seen from ' + view);
    }
    // the header: the Date column has its funnel (1 active) on the four tabs with dates — on No date only the name sorts
    const dateTh = () => r.els['cq-headrow'].innerHTML.split('</th>')[0];
    r.go('needs'); assert.match(dateTh(), /class="th-f on"[^>]*data-col="date"[^>]*aria-label="Filter and sort: Date \(1 active\)"/);
    r.go('nodate'); assert.ok(!dateTh().includes('th-f') && dateTh().includes('data-sortcol="date"'), 'No date: no Date filter button, the name still sorts');
    assert.ok(!/data-chip="date"/.test(r.els['cq-chips'].innerHTML));
    assert.match(r.els['cq-headrow'].innerHTML, /data-col="time"[^>]*aria-label="Filter and sort: Time"/, 'every other column still filters there');
    assert.match(r.els['cq-headrow'].innerHTML, /data-col="client"[^>]*aria-label="Sort: Client"/, 'Client: a sort panel with the pointer to the search box');
    // "Clear filters" (the core's clearAll, as the button calls it) on a tab: that tab's range only
    r.go('needs'); r.api.clearFilters();
    assert.deepEqual(['booked', 'needs', 'done', 'all'].map(r.dates), ['2026-11-12..2026-11-12', '..', '2026-10-01..2026-10-31', '2026-11-01..2026-11-30']);
    assert.deepEqual(r.nums(), { booked: 1, needs: 3, done: 1, nodate: 1, all: 6 });
    // kept for the browser tab: the same ranges after a reload, on the tab that was on view
    const kept = JSON.parse(r.store[K]);
    assert.deepEqual(kept.dates, { booked: { from: '2026-11-12', to: '2026-11-12' }, done: { from: '2026-10-01', to: '2026-10-31' }, all: { from: '2026-11-01', to: '2026-11-30' } });
    assert.deepEqual([kept.from, kept.to, r.store[K + '_day'], r.store[TK]], ['', '', '2026-11-12', 'needs']);
    let again = open(r.store, consultSample());
    assert.deepEqual([again.shown[0], again.nums()], ['n1,n2,n3', { booked: 1, needs: 3, done: 1, nodate: 1, all: 6 }]);

    // overnight, with Completed on view: Booked moves on to the new day — Completed's range does not move, nor does it get "today"
    r.go('done');
    Date.now = () => Date.parse('2026-11-13T14:00:00Z');
    r.api.setRows(consultSample());
    assert.deepEqual(['booked', 'needs', 'done', 'all'].map(r.dates), ['2026-11-13..2026-11-13', '..', '2026-10-01..2026-10-31', '2026-11-01..2026-11-30']);
    assert.equal(r.store[K + '_day'], '2026-11-13');
    assert.equal(r.nums().booked, 1, 'b2 is today now (b1 has moved to Needs outcome)');
    // a day chosen by hand on another tab that happens to be yesterday never rolls
    r.go('needs'); r.LT.setDates(r.api.state(), '2026-11-13', '2026-11-13'); r.api.apply('filter');
    Date.now = () => Date.parse('2026-11-14T14:00:00Z');
    r.api.setRows(consultSample());
    assert.deepEqual(['booked', 'needs'].map(r.dates), ['2026-11-14..2026-11-14', '2026-11-13..2026-11-13']);
    // Booked's date taken off stays off (the empty mark) — also after a reload
    r.go('booked'); r.api.clearFilters();
    assert.deepEqual([r.dates('booked'), r.store[K + '_day']], ['..', '']);
    again = open(r.store, consultSample());
    assert.equal(again.dates('booked'), '..');

    // a state kept BEFORE this release: one from/to (+ the day mark) — it becomes Booked's, whichever tab was on view
    Date.now = () => Date.parse('2026-11-12T17:00:00Z');
    const old = (from, to, sel) => JSON.stringify({ q: '', from, to, sel: sel || {}, sort: null });
    r = open({ [K]: old('2026-11-12', '2026-11-12'), [K + '_day']: '2026-11-12', [TK]: 'done' }, consultSample());
    assert.deepEqual(['booked', 'needs', 'done', 'all'].map(r.dates), ['2026-11-12..2026-11-12', '..', '..', '..'], 'Completed was on view: it does not take the old range');
    assert.equal(r.shown[0], 'd1,d2,d3,d4');
    r = open({ [K]: old('2026-11-11', '2026-11-11'), [K + '_day']: '2026-11-11', [TK]: '' }, consultSample());
    assert.deepEqual(['booked', 'all'].map(r.dates), ['2026-11-12..2026-11-12', '..'], 'left on today overnight before the release, on All: Booked rolls on, All shows every date');
    assert.equal(r.shown[0].split(',').length, 11);
    r = open({ [K]: old('2026-11-16', '2026-11-22', { consultant: ['S'], tab: ['needs'] }), [K + '_day']: '', [TK]: 'needs' }, consultSample());
    assert.deepEqual(['booked', 'needs'].map(r.dates), ['2026-11-16..2026-11-22', '..'], 'a chosen week stays Booked\'s');
    assert.equal(r.shown[0], 'n1,n3', 'the shared filters are kept');
    r = open({ [K]: old('', ''), [K + '_day']: '', [TK]: 'booked' }, consultSample());
    assert.equal(r.dates('booked'), '..', 'the date had been taken off: kept off');
    r = open({ [K]: old('', '') }, consultSample());
    assert.equal(r.dates('booked'), '2026-11-12..2026-11-12', 'no day mark at all (older still): today, on Booked only');
    assert.deepEqual(['needs', 'done', 'all'].map(r.dates), ['..', '..', '..']);
    // rubbish in the kept state never breaks the page
    for (const junk of ['{', 'null', '7', '"x"', '{"dates":7,"sel":5}', '{"dates":{"booked":"x","needs":{"from":"13/11/2026"}},"from":{},"sort":{"key":"nope"}}', '[1,2]']) {
      r = open({ [K]: junk, [K + '_day']: '' }, consultSample());
      assert.deepEqual(['booked', 'needs', 'done', 'all'].map(r.dates), ['..', '..', '..', '..'], junk);
      assert.equal(r.shown[0], 'b1,b2,b3', junk);
    }
    // signed out: nothing is written
    const s3 = {}; open(s3, consultSample(), true);
    assert.deepEqual(Object.keys(s3), []);
  } finally { Date.now = realNow; }
});

// Review 2026-11-12: the tab numbers are counted without a filter that belongs to another tab's column; the Date quick choices fit the tab.
test('consultations: a Now choice does not zero the numbers on Booked / Needs outcome / No date; the Date quick choices look back on Needs outcome and Completed', () => {
  const { listCore } = require('../src/routes/listFilters');
  const { consultListSpec } = require('../src/routes/listSpecs');
  const spec = consultListSpec({ today: () => '2026-11-12' });
  const LT = listCore(spec);
  const rows = [
    { id: 'b1', name: 'A', bookedSlot: '2026-11-20 10:00' }, { id: 'b2', name: 'B', bookedSlot: '2026-11-21 10:00' },
    { id: 'n1', name: 'C', bookedSlot: '2026-10-01 10:00' },
    { id: 'd1', name: 'D', bookedSlot: '2026-10-02 10:00', done: true, now: 'Retained' }, { id: 'd2', name: 'E', bookedSlot: '2026-10-03 10:00', done: true, now: 'Closed' },
    { id: 'x1', name: 'F', bookedSlot: '' },
  ];
  const st = { q: '', sel: { tab: ['done'], now: ['Retained'] } };
  const counts = {}; LT.facetCounts(rows, st, 'tab').forEach((x) => { counts[x.value] = x.count; });
  assert.deepEqual([counts.booked, counts.needs, counts.done, counts.nodate], [2, 1, 1, 1], 'the other tabs count without Now; Completed counts with it');
  assert.equal(rows.filter((r) => LT.passesAll(r, st, 'tab')).length, 1, 'All has the Now column: it counts with it');
  assert.equal(LT.filterRows(rows, st).map((r) => r.id).join(), 'd1');
  // a facet that is not tab-bound still narrows every tab's number
  const st2 = { q: '', sel: { tab: ['done'], outcome: ['Retain'] } };
  const c2 = {}; LT.facetCounts(rows, st2, 'tab').forEach((x) => { c2[x.value] = x.count; });
  assert.equal(c2.booked || 0, 0);
  // quick choices per tab: each one offered on Needs outcome and Completed can reach a past day
  const P = spec.date.presetsBy, now = Date.parse('2026-11-12T17:00:00Z');
  for (const tab of ['needs', 'done']) for (const [name] of P[tab]) assert.ok(LT.presetRange(name, now).from <= '2026-11-12', tab + ' ' + name);
  assert.equal(P.booked, undefined, 'Booked keeps the look-ahead list');
  assert.ok(!P.needs.some((p) => p[0] === 'tomorrow' || p[0] === 'nextweek'));
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/listFilters.js'), 'utf8');
  assert.ok(src.includes('(LT.DATE.presetsBy && LT.scopeOf && LT.DATE.presetsBy[LT.scopeOf(state)]) || LT.DATE.presets ||'));
});
