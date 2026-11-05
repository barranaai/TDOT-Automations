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
    ['Name contains “asha”', 'Consultant: Unassigned', 'Paid: Paid (app), Paid — recorded by staff']);
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
  assert.deepEqual(first, { caseRef: 'asc', clientName: 'asc', caseType: 'asc', caseStage: 'asc', health: 'asc', slaRisk: 'asc', manager: 'asc', overallReadiness: 'desc', daysElapsed: 'desc' });
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
  assert.equal(S.casesListOpts({}).sortReset, 'newest case first');
  assert.equal(S.consultListOpts({}).countable, 'consultCountable');
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

