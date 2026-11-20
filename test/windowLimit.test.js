'use strict';

// The limit of 20 per half-month window (Gauri, 2026-11-19: "20 for the whole firm"). On Client Master → Deadlines each of
// the four window boxes gets a third line, "Whole firm: N of 20", and the word "Full" at 20 or more. Display only.
//   - the count: clientMasterWindows.firmLoad — every OPEN case (a row on the Assigning view), by the standing date rule;
//   - the page: worked out from every case the page holds, never from the rows on screen; no line for a viewer cut to
//     their own cases, none when the page has no cases list; the two lines of before stay word for word.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

const W        = require('../src/routes/clientMasterWindows');
const cmv      = require('../src/services/clientMasterViews');
const dash     = require('../src/services/dashboardService');
const todoList = require('../src/services/todoListService');
const router   = require('../src/routes/adminDashboard');
const CAPTURE  = require('./fixtures/client-master-capture.json');
const META_FIX = require('./fixtures/client-master-board-meta.json');

const TODAY = '2026-11-20';   // windows: Nov 16–30 (now), Dec 1–15, Dec 16–31, Jan 1–15
const KEYS  = ['2026-11-2', '2026-12-1', '2026-12-2', '2027-01-1'];
const src   = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

/* ═══ the count (the pure function) ═══ */

// Case Stage label ids and board groups, as on the board (test/fixtures/client-master-board-meta.json)
const STAGE = { docs: 0, review: 1, stuck: 2, none: 5, submitted: 6, cancelled: 8, ads: 11, pre: 12, adr: 16 };
const PHASE = { p8: 0, none: 5, p11: 6 };
const GROUP = { nov: 'group_mm8qqjyz', leads: 'group_mm2tz8e1', cancel: 'group_mm3b9tap', test: 'group_mm3842s' };
/** A row whose views are worked out by the app's own view code, as the board read does (dashboardService parseRow). */
function viewRow(o) {
  const r = { groupId: GROUP.nov, stageIdx: STAGE.review, phaseIdx: PHASE.p11, caseTypeIds: [], deadlineType: 'Deadline', actualDeadline: '2026-11-25', promisedDate: '', ...o };
  r.views = cmv.viewsOf(r);
  return r;
}
/** n open cases with a Real deadline on one day. */
const openOn = (n, day, o) => Array.from({ length: n }, () => viewRow({ actualDeadline: day, ...o }));
const ns = (load) => load.map((w) => w.n);
const fulls = (load) => load.map((w) => w.full);

test('the fixture labels are the ones this file names (so "Cancelled", "Ads posted", "ADR" below mean what they say)', () => {
  const stage = META_FIX.columns['color_mm0x8faa'].settings.labels, title = Object.fromEntries(META_FIX.groups.map((g) => [g.id, g.title]));
  assert.deepEqual([STAGE.docs, STAGE.review, STAGE.stuck, STAGE.submitted, STAGE.cancelled, STAGE.ads, STAGE.pre, STAGE.adr].map((i) => stage[i]),
    ['Document Collection Started', 'Internal Review', 'Stuck', 'Application Submitted', 'Cancelled', 'Ads posted', 'Pre-Onboarding', 'ADR']);
  assert.equal(stage[STAGE.none], undefined, 'id 5 is the empty cell');
  assert.deepEqual([GROUP.nov, GROUP.leads, GROUP.cancel, GROUP.test].map((g) => title[g]), ['November 2026', 'Leads', 'Cancel /Did not retained', 'TEST']);
});

test('WINDOW_LIMIT is 20: set in ONE place, and on the module\'s answer (Node and the page read the same number)', () => {
  assert.equal(W.WINDOW_LIMIT, 20);
  const fn = W.clientMasterWindows.toString();
  assert.equal(fn.split('var WINDOW_LIMIT = 20;').length, 2, 'set once');
  assert.equal((fn.match(/WINDOW_LIMIT\s*=[^=]/g) || []).length, 1, 'and never set again');
  assert.equal(W.clientMasterWindows().WINDOW_LIMIT, 20);
  // nothing else in the app carries the number: the page reads it from the count's answer
  const page = src('src/routes/adminDashboard.js');
  assert.ok(!page.includes('WINDOW_LIMIT = ') && !/of 20\b/.test(page) && !/>= ?20\b/.test(page));
});

test('firmLoad: the box\'s own four windows, each { key, n, limit, full } — full at exactly 20, not at 19, still full at 21', () => {
  const load = W.firmLoad([...openOn(19, '2026-11-25'), ...openOn(20, '2026-12-01'), ...openOn(21, '2026-12-31')], TODAY);
  assert.deepEqual(load, [
    { key: '2026-11-2', n: 19, limit: 20, full: false },
    { key: '2026-12-1', n: 20, limit: 20, full: true },
    { key: '2026-12-2', n: 21, limit: 20, full: true },
    { key: '2027-01-1', n: 0, limit: 20, full: false },
  ]);
  assert.deepEqual(load.map((w) => w.key), W.windowsBox([], TODAY).windows.map((w) => w.key), 'the same windows as the box, in the same order');
  // the edges of a window: its first and its last day count, the days beside them do not
  assert.deepEqual(ns(W.firmLoad([...openOn(1, '2026-11-16'), ...openOn(1, '2026-11-30'), ...openOn(1, '2026-11-15'), ...openOn(1, '2027-01-15'), ...openOn(1, '2027-01-16')], TODAY)), [2, 0, 0, 1]);
  // an open case whose date has already passed inside this half-month still counts; an earlier half does not
  assert.deepEqual(ns(W.firmLoad([...openOn(3, '2026-11-17'), ...openOn(4, '2026-11-10')], TODAY)), [3, 0, 0, 0]);
});

test('the number is one line: with the constant swapped to 25 in a copy of the source, full starts at 25', () => {
  const fn = W.clientMasterWindows.toString();
  const W25 = vm.runInNewContext('(' + fn.replace('var WINDOW_LIMIT = 20;', 'var WINDOW_LIMIT = 25;') + ')()');
  assert.equal(W25.WINDOW_LIMIT, 25);
  const load = W25.firmLoad([...openOn(24, '2026-11-25'), ...openOn(25, '2026-12-01'), ...openOn(20, '2026-12-31')], TODAY);
  assert.deepEqual(Array.from(load, (w) => [w.n, w.limit, w.full].join(' ')), ['24 25 false', '25 25 true', '20 25 false', '0 25 false']);
});

test('only OPEN cases count — a row on the Assigning view: not a cancelled, submitted, "Ads posted" or no-stage row, and not a row in Leads, Cancel or TEST, even with a Phase and a date in the window', () => {
  const open = [viewRow({}), viewRow({ stageIdx: STAGE.docs }), viewRow({ stageIdx: STAGE.stuck }), viewRow({ stageIdx: STAGE.pre })];
  assert.ok(open.every((r) => r.views.includes('assigning')));
  assert.deepEqual(ns(W.firmLoad(open, TODAY)), [4, 0, 0, 0]);
  const notOpen = [
    viewRow({ stageIdx: STAGE.cancelled }), viewRow({ stageIdx: STAGE.submitted }), viewRow({ stageIdx: STAGE.ads }), viewRow({ stageIdx: STAGE.none }),
    viewRow({ groupId: GROUP.leads }), viewRow({ groupId: GROUP.cancel }), viewRow({ groupId: GROUP.test }),
  ];
  assert.ok(notOpen.every((r) => !r.views.includes('assigning')));
  // … although most of them are listed on the Deadlines tab (they have a Phase) and so are in the box that follows the rows on screen
  assert.deepEqual(notOpen.map((r) => r.views.includes('deadlines')), [true, false, true, true, true, true, true]);
  assert.deepEqual(ns(W.firmLoad(notOpen, TODAY)), [0, 0, 0, 0]);
  assert.equal(W.windowsBox(notOpen, TODAY).windows[0].total, 7, 'the windows box itself is as it was: it counts whatever rows it is handed');
  assert.deepEqual(ns(W.firmLoad(open.concat(notOpen), TODAY)), [4, 0, 0, 0]);
});

test('an open case with no Phase (not on the Deadlines tab) still counts, and so does an ADR case (open, never on that tab)', () => {
  const noPhase = viewRow({ phaseIdx: PHASE.none }), adr = viewRow({ stageIdx: STAGE.adr }), adrNoPhase = viewRow({ stageIdx: STAGE.adr, phaseIdx: PHASE.none, actualDeadline: '2026-12-02' });
  assert.deepEqual([noPhase, adr, adrNoPhase].map((r) => r.views), [['assigning'], ['assigning'], ['assigning']]);
  assert.deepEqual(ns(W.firmLoad([noPhase, adr, adrNoPhase], TODAY)), [2, 1, 0, 0]);
});

test('"open" is the app\'s one meaning of it: the same view the staff lists use, read from the row\'s views list and nothing else', () => {
  assert.equal(todoList.OPEN_VIEW, 'assigning');
  const day = { deadlineType: 'Deadline', actualDeadline: '2026-11-25' };
  assert.deepEqual(ns(W.firmLoad([{ ...day, views: [todoList.OPEN_VIEW] }, { ...day, views: ['deadlines', todoList.OPEN_VIEW, 'eeita'] }], TODAY)), [2, 0, 0, 0]);
  // never guessed from the stage, the group or the Phase: a row is open only when its views say so
  assert.deepEqual(ns(W.firmLoad([{ ...day, views: ['deadlines', 'eeita'], stageIdx: STAGE.review, caseStage: 'Internal Review', groupId: GROUP.nov }, { ...day, views: [] }, { ...day }], TODAY)), [0, 0, 0, 0]);
});

test('the date rule is the standing one: Real by Actual Deadline, Imaginary by the promise, not recorded by Actual Deadline, no date not counted — a Real case with both dates counts ONCE, under its Actual Deadline', () => {
  const sla = { hardDeadline: '2026-11-21', softDeadline: '2026-11-22', prepDeadline: '2026-11-23' };
  const one = (o) => ns(W.firmLoad([viewRow({ ...sla, actualDeadline: '', promisedDate: '', ...o })], TODAY));
  assert.deepEqual(one({ deadlineType: 'Deadline', actualDeadline: '2026-11-25' }), [1, 0, 0, 0]);
  assert.deepEqual(one({ deadlineType: 'Imaginary', promisedDate: '2026-12-03' }), [0, 1, 0, 0]);
  assert.deepEqual(one({ deadlineType: 'Imaginary', promisedDate: '2026-12-03', actualDeadline: '2026-11-25' }), [0, 1, 0, 0], 'Imaginary: the promise, not the Actual Deadline');
  assert.deepEqual(one({ deadlineType: '', actualDeadline: '2026-12-20' }), [0, 0, 1, 0], 'not recorded: the Actual Deadline');
  assert.deepEqual(one({ deadlineType: 'Deadline', actualDeadline: '2026-11-25', promisedDate: '2026-12-03' }), [1, 0, 0, 0], 'Real with both dates: once, under the Actual Deadline');
  assert.deepEqual(one({ deadlineType: 'Deadline', actualDeadline: '2027-01-10', promisedDate: '2026-11-25' }), [0, 0, 0, 1], 'a Real case never fills the window of its promise');
  // no countable date: not counted (and the SLA dates are never used)
  assert.deepEqual(one({ deadlineType: 'Deadline' }), [0, 0, 0, 0]);
  assert.deepEqual(one({ deadlineType: '' }), [0, 0, 0, 0]);
  assert.deepEqual(one({ deadlineType: '', promisedDate: '2026-11-25' }), [0, 0, 0, 0], 'not recorded with a promise only');
  assert.deepEqual(one({ deadlineType: 'Imaginary', actualDeadline: '2026-11-25' }), [0, 0, 0, 0], 'Imaginary with no promise has no window');
  // every open case is in the firm count at most once, and exactly when the box would put it in one of the four windows
  const mix = [
    viewRow({ deadlineType: 'Deadline', actualDeadline: '2026-11-25', promisedDate: '2026-12-03' }), viewRow({ deadlineType: 'Imaginary', promisedDate: '2026-12-31' }),
    viewRow({ deadlineType: '', actualDeadline: '2027-01-01' }), viewRow({ deadlineType: 'Deadline', actualDeadline: '2027-02-01' }), viewRow({ deadlineType: 'Deadline', actualDeadline: '2026-10-01' }), viewRow({ deadlineType: '', actualDeadline: '' }),
  ];
  const load = W.firmLoad(mix, TODAY), box = W.windowsBox(mix, TODAY);
  assert.deepEqual(ns(load), box.windows.map((w) => w.total));
  assert.equal(ns(load).reduce((a, b) => a + b, 0), mix.length - box.later - box.earlier - box.noDate);
});

test('empty and odd input: no rows, no list, junk in the list — zeros and no throw; a day that is not a day — no answer; the rows are never changed', () => {
  const zero = KEYS.map((key) => ({ key, n: 0, limit: 20, full: false }));
  for (const rows of [[], null, undefined, {}, 'assigning', 7, { length: 3 }]) assert.deepEqual(W.firmLoad(rows, TODAY), zero, JSON.stringify(rows));
  const day = { deadlineType: 'Deadline', actualDeadline: '2026-11-25' };
  const junk = [null, undefined, 0, '', 'assigning', [], {}, { views: null }, { ...day, views: 'assigning' }, { ...day, views: { 0: 'assigning', length: 1 } }, { ...day, views: ['Assigning'] }, { ...day, views: ['assigning '] },
    { views: ['assigning'] }, { views: ['assigning'], deadlineType: 'Deadline', actualDeadline: 'soon' }, { views: ['assigning'], deadlineType: 'Deadline', actualDeadline: null }];
  assert.deepEqual(W.firmLoad(junk, TODAY), zero, 'not one of them is an open case with a date');
  assert.deepEqual(ns(W.firmLoad(junk.concat([{ ...day, views: ['assigning'] }]), TODAY)), [1, 0, 0, 0]);
  for (const bad of ['', null, undefined, 'today', '2026-13-01']) assert.equal(W.firmLoad(openOn(3, '2026-11-25'), bad), null, String(bad));
  assert.deepEqual(W.firmLoad(openOn(1, '2026-11-25'), '2026-11-20T09:00:00Z'), W.firmLoad(openOn(1, '2026-11-25'), TODAY), 'a day with a time is read by its day, as the box does');
  const rows = [viewRow({}), viewRow({ stageIdx: STAGE.cancelled })], before = JSON.stringify(rows);
  W.firmLoad(rows, TODAY);
  assert.equal(JSON.stringify(rows), before);
  assert.ok(Array.isArray(W.firmLoad(rows, TODAY)) && W.firmLoad(rows, TODAY) !== W.firmLoad(rows, TODAY), 'a new answer each time');
});

test('the windows follow the day: across the 15th / 16th and the year end the firm count moves with the box', () => {
  const rows = [...openOn(2, '2026-11-25'), ...openOn(3, '2026-12-10'), ...openOn(4, '2027-01-20')];
  assert.deepEqual(W.firmLoad(rows, '2026-11-15').map((w) => [w.key, w.n]), [['2026-11-1', 0], ['2026-11-2', 2], ['2026-12-1', 3], ['2026-12-2', 0]]);
  assert.deepEqual(W.firmLoad(rows, '2026-11-16').map((w) => [w.key, w.n]), [['2026-11-2', 2], ['2026-12-1', 3], ['2026-12-2', 0], ['2027-01-1', 0]]);
  assert.deepEqual(W.firmLoad(rows, '2026-12-16').map((w) => [w.key, w.n]), [['2026-12-2', 0], ['2027-01-1', 0], ['2027-01-2', 4], ['2027-02-1', 0]]);
});

test('pinned on the repo\'s anonymised 8 Nov board copy, through the real board parser and view code, today = 2026-11-20: 22, 14, 5, 2 — only the first is full', () => {
  const rows = CAPTURE.rows.map((r, i) => dash.parseItem({ id: String(i), name: '', created_at: '', group: r.groupId ? { id: r.groupId, title: '' } : null, column_values: r.cells }, i));
  assert.equal(rows.length, 718);
  assert.equal(rows.filter((r) => r.views.includes('assigning')).length, 156, 'the open cases');
  const load = W.firmLoad(rows, TODAY);
  assert.deepEqual(load.map((w) => w.key), KEYS);
  assert.deepEqual(ns(load), [22, 14, 5, 2]);
  assert.deepEqual(fulls(load), [true, false, false, false]);
  // the two numbers of one box differ, in both directions: the tab's own rows give 21 for the first window
  assert.deepEqual(W.windowsBox(rows.filter((r) => r.views.includes('deadlines')), TODAY).windows.map((w) => w.total), [21, 12, 4, 2]);
});

test('page-script rule: the injected source (now with the limit and the count) has no backtick, no dollar-brace, no backslash, and works in a bare context', () => {
  const fn = W.clientMasterWindows.toString();
  assert.ok(fn.includes('function firmLoad(rows, today)') && fn.includes('firmLoad: firmLoad') && fn.includes('WINDOW_LIMIT: WINDOW_LIMIT'));
  assert.ok(!/[`\\]|\$\{/.test(fn));
  new vm.Script('(' + fn + ')()');
  const api = vm.runInNewContext('(' + fn + ')()');
  // rows made in another realm (as on the page, where the list comes from JSON): arrays are still arrays
  assert.deepEqual(JSON.parse(JSON.stringify(api.firmLoad(openOn(20, '2026-11-25'), TODAY))), [{ key: '2026-11-2', n: 20, limit: 20, full: true }, ...KEYS.slice(1).map((key) => ({ key, n: 0, limit: 20, full: false }))]);
  // display only: the count reads rows and a day; it reaches for nothing
  const body = fn.slice(fn.indexOf('function firmLoad('), fn.indexOf('function flagOf('));
  assert.ok(!/fetch|document|window\.|XMLHttp|localStorage|sessionStorage|Date\.now|new Date/.test(body), body);
  // the rules of before are not touched: the date rule and the box are the same functions, word for word
  assert.ok(fn.includes("if (t === 'imaginary') return p;\n    return a;   // Real, and Not recorded with an Actual Deadline"));
  assert.ok(fn.includes("if (d >= box[i].start && d <= box[i].end) { box[i][typeOf(r)]++; box[i].total++; return; }"));
});

/* ═══ the page: the real emitted scripts over a small made-up page ═══ */

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
function renderRoute(p) {
  const layer = router.stack.find((l) => l.route && l.route.path === p);
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
}
const pageOff = () => withEnv({ TODO_TAB: undefined }, () => renderRoute('/'));
const pageOn  = () => withEnv({ TODO_TAB: 'on' }, () => renderRoute('/'));
function inlineScripts(html) { return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]); }
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const plain = (html) => unesc(String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());

/**
 * The Client Master page in a made-up window: every emitted script runs exactly as it is (todo: with the To-do tab).
 * The day is fixed (TODAY) and can be moved; nothing is ever fetched — a fetch is noted, not answered.
 */
async function openPage({ todo = false } = {}) {
  const html = await (todo ? pageOn() : pageOff());
  const scripts = inlineScripts(html);
  const els = {}, fetched = [];
  const doc = { activeElement: null, readyState: 'loading' };
  function mk(tag, id) {
    const e = { tag, tagName: String(tag).toUpperCase(), id: id || '', _html: '', kids: [], style: {}, attrs: {}, className: '', value: '', title: '', textContent: '', disabled: false, onclick: null, parentNode: null, scrollWidth: 1000, clientWidth: 1000,
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
  for (const id of ['cs-quick', 'cm-head', 'search-box', 'cm-oc', 'cm-cols-btn', 'table-count', 'cs-chips', 'cs-headrow', 'all-cases-body', 'refresh-btn', 'loading', 'content', 'error-msg']) els[id] = mk('div', id);
  els['all-cases-table'] = mk('table', 'all-cases-table'); els['all-cases-table'].className = 'data-table';
  const wrap = mk('div'); wrap.className = 'tbl-wrap'; els['all-cases-table'].parentNode = wrap;
  els['cm-cols-btn'].className = 'cm-oc-b cm-cols-b';
  const body = mk('body');
  body.appendChild = (c) => { if (c.id) els[c.id] = c; return c; };
  Object.assign(doc, { getElementById: (id) => els[id] || null, createElement: (t) => mk(t), body, documentElement: mk('html'), querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, dispatchEvent() { return true; } });
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, key: () => null, length: 0 }; };
  const ctx = { document: doc, console, URL, URLSearchParams, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame() {},
    history: { replaceState() {} }, innerWidth: 1440, innerHeight: 900, addEventListener() {}, matchMedia: () => ({ matches: true }),
    fetch: (url) => { fetched.push(String(url)); return new Promise(() => {}); }, TDOT_IS_ADMIN: true,
    CustomEvent: function (type) { this.type = type; }, sessionStorage: store(), localStorage: store(),
    location: { href: 'https://staff.example/admin/dashboard', search: '', pathname: '/admin/dashboard', replace() {} } };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const s of scripts) vm.runInContext(s, ctx);
  let day = TODAY;
  ctx.cmToday = () => day;
  const head = els['cm-head'];
  const p = {
    ctx, els, html, scripts, fetched,
    /** New data arrives (the first load, Refresh, the quiet re-fetch): the page's own road in. */
    answer(cases, viewer) {
      const d = { meta: null, cases, dataAt: '2026-11-20T14:05:00Z' };
      if (viewer !== null) d.viewer = viewer || { name: 'Admin', email: '', scope: 'all', isAdmin: true, canAssign: true };
      ctx._data = d;
      ctx.initAllCasesTable(d);
      return d;
    },
    tab(v) { const st = ctx.CasesTable.state(); if (v) st.sel.view = [v]; else delete st.sel.view; ctx.CasesTable.apply('filter'); },
    search(q) { ctx.CasesTable.state().q = q; ctx.CasesTable.apply('filter'); },
    filter(key, values) { const st = ctx.CasesTable.state(); if (values) st.sel[key] = values; else delete st.sel[key]; ctx.CasesTable.apply('filter'); },
    setDay(d) { day = d; },
    head: () => head._html,
    /** The windows part of the box above the table ('' when it is not drawn). */
    wins: () => { const h = head._html, i = h.indexOf('<div class="cm-wins"'); return i < 0 ? '' : h.slice(i); },
    /** The four window boxes, each as its lines in words: ['Now · Nov 16–30 · 14', 'Real 9 · Imaginary 4 · Not recorded 1', 'Whole firm: 20 of 20 Full']. */
    boxes: () => [...p.wins().matchAll(/<div class="cm-win-box( now)?" data-win="([^"]*)">([\s\S]*?)<\/div><\/div>/g)].map((m) => (m[3] + '</div>').split('</div>').filter(Boolean).map(plain)),
    /** The third line of each window box (null where there is none). */
    firm: () => p.boxes().map((b) => (b.length > 2 ? b[2] : null)),
    /** The rows-on-screen number of each window box. */
    onScreen: () => p.boxes().map((b) => Number(b[0].split(' · ').pop())),
    rest: () => (p.wins().match(/<div class="cm-win-box rest">[\s\S]*?<\/div><\/div>/) || [''])[0],
    drawnRows: () => els['all-cases-body'].kids.filter((k) => /(^| )cm-in( |$)/.test(k.className)).length,
    groups: () => els['all-cases-body'].kids.filter((k) => /^cm-grp /.test(k.className)).length,
  };
  return p;
}

/* The box of BEFORE this change, to the letter (adminDashboard.js renderCmHead at 4e4a63e): what every window box must still begin with. */
const oldLines = (i, key, label, total, real, imaginary, none) =>
  '<div class="cm-win-box' + (i === 0 ? ' now' : '') + '" data-win="' + key + '"><div class="cm-win-l">' + (i === 0 ? 'Now · ' : '') + label + ' · <b>' + total + '</b></div>' +
  '<div class="cm-win-n">Real ' + real + ' · Imaginary ' + imaginary + ' · Not recorded ' + none + '</div>';
const oldRest = (later, earlier, noDate) =>
  '<div class="cm-win-box rest"><div class="cm-win-n">Later <b data-n="later">' + later + '</b> · Earlier dates <b data-n="earlier">' + earlier + '</b> · No date <b data-n="nodate">' + noDate + '</b></div></div>';
const OLD_OPEN = '<div class="cm-wins" id="cm-wins" role="group" aria-label="Half-month windows">';
const TIP = 'Every open case in the firm with a real deadline or a promised date in this half-month, not only the rows listed below. The limit is 20 per half-month. A guide only: nothing is blocked.';
const firmLine = (n, full) => '<div class="cm-win-n cm-win-f" title="' + TIP + '">Whole firm: <b>' + n + '</b> of 20' + (full ? ' <span class="cm-win-full">Full</span>' : '') + '</div>';

let SEQ = 0;
/** A case as the page gets it. tab: on the Deadlines tab (it has a Phase); open: on the Assigning view. */
function pageRow(o = {}) {
  const { open = true, tab = true, ...rest } = o;
  const id = String(++SEQ);
  return { id, caseRef: '2026-XX-' + id.padStart(3, '0'), clientName: 'Made Up ' + id, caseType: 'Visitor Visa', caseSubType: '', caseStage: 'Internal Review', stageIdx: 1, health: 'Green', slaRisk: 'Green',
    phase: tab ? 'Phase 11' : '', phaseIdx: tab ? 6 : 5, deadlineType: 'Deadline', actualDeadline: '2026-11-25', promisedDate: '', officer: '', manager: 'Unassigned', canChangeDeadline: true,
    groupId: 'g_nov', groupTitle: 'November 2026', boardIdx: Number(id), createdAt: '2026-11-01T10:00:00Z',
    views: [].concat(open ? ['assigning'] : [], tab ? ['deadlines'] : []), officerIds: { personIds: [], teamIds: [] }, ...rest };
}
const many = (n, o) => Array.from({ length: n }, () => pageRow(o));
/* The cases of the page tests (today = 2026-11-20):
   Nov 16–30 — 20 open: 12 on the Deadlines tab (Real 7, Imaginary 4, not recorded 1) + 8 with no Phase (not on the tab);
               and 2 rows on the tab that are NOT open (a Cancel-group row, a cancelled case)        → on screen 14, whole firm 20
   Dec 1–15  — 19 open, all on the tab (Real)                                                         → on screen 19, whole firm 19
   Dec 16–31 — nothing                                                                                → 0 and 0
   Jan 1–15  — 1 open on the tab, 1 not open on the tab                                               → on screen 2, whole firm 1
   and on the tab: 1 later (Feb), 1 earlier (Oct), 2 with no date. */
function CASES() {
  SEQ = 0;
  return [
    ...many(7, { actualDeadline: '2026-11-25' }),
    ...many(4, { deadlineType: 'Imaginary', actualDeadline: '', promisedDate: '2026-11-28', health: 'Red' }),
    ...many(1, { deadlineType: '', actualDeadline: '2026-11-16' }),
    ...many(8, { tab: false, actualDeadline: '2026-11-30' }),
    pageRow({ open: false, actualDeadline: '2026-11-20', groupId: 'g_cancel', groupTitle: 'Cancel /Did not retained' }),
    pageRow({ open: false, actualDeadline: '2026-11-21', caseStage: 'Cancelled', stageIdx: 8 }),
    ...many(19, { actualDeadline: '2026-12-01', phase: 'Phase 8', phaseIdx: 0 }),
    pageRow({ actualDeadline: '2027-01-15', clientName: 'Zed Farthest' }),
    pageRow({ open: false, actualDeadline: '2027-01-02', caseStage: 'Ads posted', stageIdx: 11 }),
    pageRow({ actualDeadline: '2027-02-01' }), pageRow({ actualDeadline: '2026-10-01' }), pageRow({ actualDeadline: '' }), pageRow({ deadlineType: 'Imaginary', actualDeadline: '2026-11-25', promisedDate: '' }),
  ];
}

test('the Deadlines boxes: the two lines of before, word for word, then "Whole firm: 20 of 20" with the word "Full" — "19 of 20" has no pill; the last box is as it was', async () => {
  const p = await openPage();
  const atLoad = p.fetched.length;
  p.answer(CASES());
  p.tab('deadlines');
  assert.equal(p.wins(), OLD_OPEN +
    oldLines(0, '2026-11-2', 'Nov 16–30', 14, 9, 4, 1) + firmLine(20, true) + '</div>' +
    oldLines(1, '2026-12-1', 'Dec 1–15', 19, 19, 0, 0) + firmLine(19, false) + '</div>' +
    oldLines(2, '2026-12-2', 'Dec 16–31', 0, 0, 0, 0) + firmLine(0, false) + '</div>' +
    oldLines(3, '2027-01-1', 'Jan 1–15', 2, 2, 0, 0) + firmLine(1, false) + '</div>' +
    oldRest(1, 1, 2) + '</div>');
  // as a person reads it: the visible words stand on their own (a phone has no hover)
  assert.deepEqual(p.boxes(), [
    ['Now · Nov 16–30 · 14', 'Real 9 · Imaginary 4 · Not recorded 1', 'Whole firm: 20 of 20 Full'],
    ['Dec 1–15 · 19', 'Real 19 · Imaginary 0 · Not recorded 0', 'Whole firm: 19 of 20'],
    ['Dec 16–31 · 0', 'Real 0 · Imaginary 0 · Not recorded 0', 'Whole firm: 0 of 20'],
    ['Jan 1–15 · 2', 'Real 2 · Imaginary 0 · Not recorded 0', 'Whole firm: 1 of 20'],
  ]);
  assert.equal(p.wins().split('cm-win-full').length - 1, 1, 'one pill: only the window that is full');
  assert.equal(p.wins().split('Whole firm:').length - 1, 4, 'the four windows, not the last box');
  assert.equal(p.rest(), oldRest(1, 1, 2));
  assert.ok(!p.rest().includes('Whole firm') && !p.rest().includes('title='));
  // one more than 20 is still "Full" and says the real number
  p.answer(CASES().concat(many(1, { tab: false, actualDeadline: '2026-11-29' })));
  assert.equal(p.firm()[0], 'Whole firm: 21 of 20 Full');
  // no board read, no write: the number is worked out on the page — drawing it asks the server for nothing
  assert.equal(p.fetched.length, atLoad);
});

test('the firm number does not follow the rows on screen: a search, a header filter and closed groups move the first two lines only', async () => {
  const p = await openPage();
  p.answer(CASES());
  p.tab('deadlines');
  const firm = ['Whole firm: 20 of 20 Full', 'Whole firm: 19 of 20', 'Whole firm: 0 of 20', 'Whole firm: 1 of 20'];
  assert.deepEqual([p.onScreen(), p.firm()], [[14, 19, 0, 2], firm]);
  // a search that leaves one row
  p.search('Zed Farthest');
  assert.deepEqual([p.onScreen(), p.firm()], [[0, 0, 0, 1], firm]);
  assert.equal(p.boxes()[3][1], 'Real 1 · Imaginary 0 · Not recorded 0');
  assert.equal(p.rest(), oldRest(0, 0, 0));
  // a search that leaves nothing: the boxes read 0 and the firm is as it was
  p.search('nobody-has-this-name');
  assert.deepEqual([p.onScreen(), p.firm(), p.drawnRows()], [[0, 0, 0, 0], firm, 0]);
  p.search('');
  // a header filter (Health: Red = the four Imaginary cases)
  p.filter('health', ['Red']);
  assert.deepEqual([p.onScreen(), p.firm()], [[4, 0, 0, 0], firm]);
  assert.equal(p.boxes()[0][1], 'Real 0 · Imaginary 4 · Not recorded 0');
  p.filter('health', null);
  // every group closed: no row is drawn, the box still counts the matching rows (as before) and the firm is as it was
  const open = p.drawnRows();
  p.ctx.cmGrpAll(false);
  assert.ok(open > 0 && p.drawnRows() === 0 && p.groups() > 0);
  assert.deepEqual([p.onScreen(), p.firm()], [[14, 19, 0, 2], firm]);
  p.ctx.cmGrpAll(true);
  assert.deepEqual([p.onScreen(), p.firm(), p.drawnRows()], [[14, 19, 0, 2], firm, open]);
});

test('an in-page deadline change moves the firm numbers at once (no board read); new data and a new day move them too', async () => {
  const p = await openPage();
  const cases = CASES();
  p.answer(cases);
  p.tab('deadlines');
  const before = p.fetched.length;
  assert.deepEqual(p.firm().slice(0, 2), ['Whole firm: 20 of 20 Full', 'Whole firm: 19 of 20']);
  // "Change…" on a row of the tab: its Real deadline goes from Nov 25 to Dec 5 — the next window
  p.ctx.cmDlApply(cases[0].id, { type: 'Deadline', actualDeadline: '2026-12-05', promisedSubmissionDate: '' });
  assert.deepEqual(p.firm().slice(0, 2), ['Whole firm: 19 of 20', 'Whole firm: 20 of 20 Full'], 'the word "Full" moves with the case');
  assert.deepEqual(p.onScreen().slice(0, 2), [13, 20], 'and the rows-on-screen numbers follow as before');
  assert.equal(p.fetched.length, before, 'nothing was asked of the server');
  // an open case that is NOT on the tab (no Phase): the same road moves the firm number and not the rows on screen
  const hidden = cases.find((c) => c.views.length === 1 && c.views[0] === 'assigning');
  p.ctx.cmDlApply(hidden.id, { type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2026-12-20' });
  assert.deepEqual([p.firm().slice(0, 3), p.onScreen().slice(0, 3)], [['Whole firm: 18 of 20', 'Whole firm: 20 of 20 Full', 'Whole firm: 1 of 20'], [13, 20, 0]]);
  // a deadline taken off: the case leaves the count
  p.ctx.cmDlApply(hidden.id, { type: '', actualDeadline: '', promisedSubmissionDate: '' });
  assert.equal(p.firm()[2], 'Whole firm: 0 of 20');
  // new data (Refresh, the quiet re-fetch): a new count, and the tab on screen stays
  p.answer(CASES());
  assert.deepEqual([p.firm().slice(0, 2), p.onScreen().slice(0, 2)], [['Whole firm: 20 of 20 Full', 'Whole firm: 19 of 20'], [14, 19]]);
  // the page left open over the end of the half-month: at the next redraw the windows and the firm numbers are the new day's
  p.setDay('2026-12-01');
  p.ctx.CasesTable.setRows(p.ctx._data.cases);
  assert.deepEqual(p.boxes().map((b) => [b[0], b[2]]), [['Now · Dec 1–15 · 19', 'Whole firm: 19 of 20'], ['Dec 16–31 · 0', 'Whole firm: 0 of 20'], ['Jan 1–15 · 2', 'Whole firm: 1 of 20'], ['Jan 16–31 · 0', 'Whole firm: 0 of 20']]);
  assert.equal(p.rest(), oldRest(1, 15, 2), 'November is now "Earlier dates"');
});

test('a viewer limited to their own cases gets no "Whole firm" line and no "Full" — the page does not hold the firm\'s cases; with all cases the line is there', async () => {
  const p = await openPage();
  const mine = { name: 'Officer One', email: 'officer.one@example.com', scope: 'assigned', isAdmin: false, canAssign: false };
  p.answer(CASES(), mine);
  p.tab('deadlines');
  assert.ok(p.head().includes('<div class="cm-note">Showing only your cases; ask an admin to see everyone’s.</div>'), 'the line of before says why');
  assert.ok(!p.head().includes('Whole firm') && !p.head().includes('cm-win-full') && !p.head().includes('Full') && !p.head().includes('cm-win-f'), p.head());
  // … and the boxes are the ones of before, to the letter
  const old = OLD_OPEN + oldLines(0, '2026-11-2', 'Nov 16–30', 14, 9, 4, 1) + '</div>' + oldLines(1, '2026-12-1', 'Dec 1–15', 19, 19, 0, 0) + '</div>' +
    oldLines(2, '2026-12-2', 'Dec 16–31', 0, 0, 0, 0) + '</div>' + oldLines(3, '2027-01-1', 'Jan 1–15', 2, 2, 0, 0) + '</div>' + oldRest(1, 1, 2) + '</div>';
  assert.equal(p.wins(), old);
  // an admin, the shared team key (scope 'all'): the line
  p.answer(CASES(), { name: 'Admin', email: '', scope: 'all', isAdmin: true, canAssign: true });
  assert.ok(!p.head().includes('Showing only your cases'));
  assert.deepEqual(p.firm(), ['Whole firm: 20 of 20 Full', 'Whole firm: 19 of 20', 'Whole firm: 0 of 20', 'Whole firm: 1 of 20']);
  // an answer that says nothing about the viewer: the same rule as the "Showing only your cases" line — the two always go together
  p.answer(CASES(), null);
  assert.ok(!p.head().includes('Showing only your cases') && p.firm()[0] === 'Whole firm: 20 of 20 Full');
});

test('the page has no data, or data with no cases list: the boxes are drawn exactly as before — no third line, nothing throws', async () => {
  const p = await openPage();
  p.answer(CASES());
  p.tab('deadlines');
  const V = cmv.pageViews().find((v) => v.key === 'deadlines');
  const rows = CASES().filter((c) => c.views.includes('deadlines'));
  const old = OLD_OPEN + oldLines(0, '2026-11-2', 'Nov 16–30', 14, 9, 4, 1) + '</div>' + oldLines(1, '2026-12-1', 'Dec 1–15', 19, 19, 0, 0) + '</div>' +
    oldLines(2, '2026-12-2', 'Dec 16–31', 0, 0, 0, 0) + '</div>' + oldLines(3, '2027-01-1', 'Jan 1–15', 2, 2, 0, 0) + '</div>' + oldRest(1, 1, 2) + '</div>';
  for (const data of [null, undefined, {}, { dataAt: '2026-11-20T15:00:00.000Z', waitingAt: null }, { cases: null }, { cases: 'x' }, { cases: { length: 2 } }, { viewer: { scope: 'all' } }]) {
    p.ctx._data = data;
    assert.doesNotThrow(() => p.ctx.renderCmHead(V, rows, { q: '', sel: { view: ['deadlines'] } }, [], rows.length), JSON.stringify(data));
    assert.equal(p.wins(), old, JSON.stringify(data));
  }
  // a cases list that is there but empty IS the firm as the page knows it: the line, with 0
  p.ctx._data = { cases: [] };
  p.ctx.renderCmHead(V, rows, { q: '', sel: { view: ['deadlines'] } }, [], rows.length);
  assert.deepEqual([p.onScreen(), p.firm()], [[14, 19, 0, 2], ['Whole firm: 0 of 20', 'Whole firm: 0 of 20', 'Whole firm: 0 of 20', 'Whole firm: 0 of 20']]);
});

test('only the Deadlines tab: no firm line on Assigning, EE after ITA or All — and with the To-do tab on the page, the Deadlines boxes read the same and the To-do tab has none', async () => {
  const p = await openPage();
  p.answer(CASES().map((c) => ({ ...c, views: c.views.concat(['eeita']) })));
  for (const tab of ['assigning', 'eeita', '']) { p.tab(tab); assert.ok(!p.head().includes('Whole firm') && !p.head().includes('cm-win'), tab || 'All'); }
  p.tab('deadlines');
  const off = p.wins();
  assert.equal(p.firm()[0], 'Whole firm: 20 of 20 Full');
  const on = await openPage({ todo: true });
  on.answer(CASES().map((c) => ({ ...c, views: c.views.concat(['eeita'], c.views.includes('assigning') ? ['todo'] : []) })));
  on.tab('deadlines');
  assert.equal(on.wins(), off, 'the same boxes, to the letter');
  on.tab('todo');
  assert.ok(!on.head().includes('Whole firm') && !on.head().includes('cm-win'));
});

/* ═══ the page source and the rules it must keep ═══ */

test('the emitted page, with and without the To-do tab: every inline script parses; the new code keeps the page-script rule; one style rule for the pill, from the shared colours', async () => {
  for (const [what, html] of [['tab off', await pageOff()], ['tab on', await pageOn()]]) {
    const scripts = inlineScripts(html);
    assert.ok(scripts.length >= 2, what);
    scripts.forEach((s, i) => { try { new vm.Script(s); } catch (e) { assert.fail(what + ': script #' + (i + 1) + ' does not parse: ' + e.message); } });
    const main = scripts.find((s) => s.includes('function renderCmHead('));
    assert.ok(main.includes('function firmLoad(rows, today)'), what + ': the count is on the page, inside the windows helper');
    assert.equal(main.split('var WINDOW_LIMIT = 20;').length, 2, what);
    // the pill: the shared red tokens, a 1px border for paper, no colour of its own
    const rule = html.match(/\.cm-win-full \{([^}]*)\}/);
    assert.ok(rule, what);
    assert.ok(/background:var\(--st-red-bg\); color:var\(--st-red-fg\); border:1px solid var\(--st-red-solid\);/.test(rule[1]), rule[1]);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgb\(/.test(rule[1]), 'no hard-coded colour');
    assert.equal(html.split('.cm-win-full').length, 2, what + ': the one rule');
    // the "Now" box keeps its own blue border: a full box gets the word, never a border of its own
    assert.ok(html.includes('.cm-win-box.now { border-color:var(--st-blue-solid); background:var(--st-blue-bg); }'));
    assert.ok(!/\.cm-win-box\.full/.test(html));
    // paper: the boxes are not in the print hide list
    const hide = html.match(/@media print \{[\s\S]*?\{ display:none !important; \}/)[0];
    assert.ok(!/cm-win/.test(hide), what);
  }
});

test('by source: renderCmHead asks the count directly (no new page function) from every case the page holds; the server, the data service and Monday are not touched', () => {
  const page = src('src/routes/adminDashboard.js');
  const head = page.slice(page.indexOf('\nfunction renderCmHead('), page.indexOf('\n}\n', page.indexOf('\nfunction renderCmHead(')));
  assert.ok(head.includes("? CMW.firmLoad(_data.cases, winDay) : null;"), 'from _data.cases — never from the rows handed in');
  assert.ok(head.includes("_data && Array.isArray(_data.cases) && !(_data.viewer && _data.viewer.scope === 'assigned')"));
  assert.ok(head.includes('CMW.windowsBox(rows, winDay)'), 'the box of before still follows the rows on screen');
  assert.ok(!/fetch\(|XMLHttpRequest|location\./.test(head), 'display only');
  // the new lines keep the page-script rule (the page code sits in a Node template literal)
  const added = head.slice(head.indexOf('if (v.deadlineBox) {'));
  assert.ok(!/[`\\]|\$\{/.test(added));
  // the only page functions that name the count: renderCmHead (the four existing test sandboxes pull page functions out by name)
  assert.equal(page.split('firmLoad').length - 1, 1);
  assert.ok(!/function cmFirm|function cmWindowLimit/.test(page));
  // nothing of it on the server side, in the data service, or anywhere that writes
  const named = (rel) => /firmLoad|WINDOW_LIMIT|Whole firm|cm-win-full/.test(src(rel));
  const all = [];
  (function walk(dir) { for (const f of fs.readdirSync(path.resolve(__dirname, '..', dir), { withFileTypes: true })) { if (f.isDirectory()) walk(dir + '/' + f.name); else if (f.name.endsWith('.js')) all.push(dir + '/' + f.name); } })('src');
  assert.ok(all.includes('src/server.js') && all.includes('src/services/dashboardService.js') && all.length > 50);
  assert.deepEqual(all.filter(named).sort(), ['src/routes/adminDashboard.js', 'src/routes/clientMasterWindows.js'], 'two files, both page code');
  assert.ok(!/require\(|mondayApi|monday\.|fetch/.test(W.clientMasterWindows.toString()), 'the windows helper talks to nothing');
});
