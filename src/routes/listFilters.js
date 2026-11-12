'use strict';

/**
 * One filter look for every list (team meeting 2026-11-05, point 3 — Faran: filters
 * in the column headers on EVERY list, like the Leads list; remembered until the
 * browser tab is closed).
 *
 * This is the Leads list engine (leadsTableFilters.js, 2026-10-28) made general:
 * each column header has a small filter button that opens a panel for THAT column
 * — tick boxes with how many rows each choice would show (counted with the other
 * filters on), sorting where the list has it, quick dates where the list has them.
 * Active filters show as chips above the table with one "Clear filters". The
 * column name itself sorts, where the column sorts. Choices are kept in this
 * tab's sessionStorage (Sign Out forgets them).
 *
 * Three parts, all plain browser JavaScript injected with Function#toString (no
 * template-literal escaping — the inline-script trap):
 *   listCore(spec)          — pure: filter, facet counts, sort, date presets, chips.
 *                             Unit-tested in Node.
 *   listTableUi(LT, o, win) — the header buttons, the panel, the chips, the search.
 *   a page's spec + options — functions in leadsTableFilters.js / listSpecs.js.
 * The page keeps its own row HTML: o.render names a window function that gets the
 * filtered, sorted rows (and may return { shown, total } for the count).
 *
 * spec: { facets: { key: { label, get(r) -> string | string[], none, order, text(v), fixed (always list every order value), quick,
 *                          natural: true (its choices list with the numbers inside the text compared as numbers — "Phase 8" before "Phase 11"),
 *                          apart: [values] (rows with one of these values show only when that choice is on — never under
 *                          "no choice" / All; the Retainers page's Retained tab) } },
 *         sorts: { key: get(r) }, defaultSort: { key, dir } | null (null = keep the server order),
 *         sortBlanksLast: [sort keys] (their blank values go last in both directions),
 *         search: { text(r) -> string | string[], chip, id(r) (the row's lead id — the server search answers ids),
 *                   digits(r) -> the row's phone digits (a search text that is a phone number — digits, spaces, + ( ) - . only, three
 *                   digits or more — also finds the rows whose digits contain its digits, however either is written) },
 *         flags: { key: { chip, test(r) } },
 *         date: { key, chip, get(r) -> 'YYYY-MM-DD',
 *                 per: { facet, all, none: [values], legacy } (a date range PER TAB — Consultations 2026-11-12: the facet is the
 *                   list's one-at-a-time tabs; each tab value, and `all` for no tab chosen, keeps its own from/to in
 *                   state.dates[value]; a value in `none` has no date filter at all; `legacy` is the tab an older kept
 *                   state's single from/to belongs to. A row is tested against the range of the tab on view — and, when
 *                   the tabs themselves are counted, against the range of the row's OWN tab, so each tab's number is the
 *                   number of rows it shows when opened. Without `per`: one from/to for the list, as always.) } | null }
 */

/* eslint-disable no-var */
function listCore(spec) {
  var NONE = '__none__';
  var FACETS = spec.facets || {}, SORTS = spec.sorts || {}, FLAGS = spec.flags || {}, DATE = spec.date || null, SEARCH = spec.search || null;
  var DEFAULT_SORT = spec.defaultSort || null;
  var BLANKS_LAST = spec.sortBlanksLast || [];   // sort keys whose blank values go last in BOTH directions (Cases: the dates)
  var PER = (DATE && DATE.per && FACETS[DATE.per.facet]) ? DATE.per : null;   // a date range per tab (see the header); null = one range for the list
  function s(v) { return String(v == null ? '' : v).trim(); }
  /** A row's value(s) for a facet; '' = the "none" choice. A facet may give several (a case's managers). */
  function valuesOf(f, r) {
    var v = FACETS[f].get(r);
    if (Array.isArray(v)) { var out = v.map(s).filter(Boolean); return out.length ? out : [NONE]; }
    v = s(v); return [v === '' ? NONE : v];
  }
  function labelOf(f, v) { if (v === NONE) return FACETS[f].none || 'None'; return FACETS[f].text ? FACETS[f].text(v) : v; }
  /** Is the row one a facet keeps apart (shown only when its own choice is on)? */
  function apartOf(f, r) { var ap = FACETS[f] && FACETS[f].apart; return !!(ap && ap.length && valuesOf(f, r).some(function (v) { return ap.indexOf(v) >= 0; })); }

  function emptyState() {
    var st = { q: '', from: '', to: '', sel: {}, sort: DEFAULT_SORT ? { key: DEFAULT_SORT.key, dir: DEFAULT_SORT.dir } : null };
    Object.keys(FLAGS).forEach(function (k) { st[k] = false; });
    if (PER) st.dates = {};
    return st;
  }
  /* ── the date range: one for the list, or one per tab (spec.date.per) ── */
  function okDay(v) { v = s(v); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }
  /** The tab on view, as a date scope ('' when the list has one range). */
  function scopeOf(st) { if (!PER) return ''; var l = st && st.sel && st.sel[PER.facet]; return (l && l.length) ? l[0] : PER.all; }
  /** Does that tab have a date filter? (Consultations: "No date" has none.) */
  function hasDates(scope) { return !PER || (PER.none || []).indexOf(scope == null ? '' : scope) < 0; }
  function dateScopes() { return PER ? (FACETS[PER.facet].order || []).concat([PER.all]).filter(hasDates) : []; }
  /** The from/to as chosen — of the tab on view, or of the tab named. */
  function getDates(st, scope) {
    if (!PER) return { from: s(st.from), to: s(st.to) };
    if (scope == null) scope = scopeOf(st);
    var d = hasDates(scope) && st.dates && Object.prototype.hasOwnProperty.call(st.dates, scope) ? st.dates[scope] : null;
    return { from: d ? s(d.from) : '', to: d ? s(d.to) : '' };
  }
  function setDates(st, from, to, scope) {
    from = s(from); to = s(to);
    if (!PER) { st.from = from; st.to = to; return st; }
    if (scope == null) scope = scopeOf(st);
    if (!hasDates(scope)) return st;
    if (!st.dates) st.dates = {};
    if (from || to) st.dates[scope] = { from: from, to: to }; else delete st.dates[scope];
    return st;
  }
  /** A saved state, cleaned (anything unknown dropped). */
  function normalizeState(x) {
    var st = emptyState();
    if (!x || typeof x !== 'object') return st;
    st.q = s(x.q).slice(0, 100);
    Object.keys(FLAGS).forEach(function (k) { st[k] = x[k] === true; });
    if (PER) {
      /* One range per tab. A state kept before that (one from/to, no `dates`) was the `legacy` tab's range. */
      var src = (x.dates && typeof x.dates === 'object') ? x.dates : null;
      if (!src && PER.legacy != null) { src = {}; src[PER.legacy] = { from: x.from, to: x.to }; }
      dateScopes().forEach(function (k) {
        var d = src && Object.prototype.hasOwnProperty.call(src, k) ? src[k] : null;
        if (!d || typeof d !== 'object') return;
        var a = okDay(d.from), b = okDay(d.to);
        if (a || b) st.dates[k] = { from: a, to: b };
      });
    } else if (DATE) {
      st.from = okDay(x.from);
      st.to = okDay(x.to);
    }
    var sel = x.sel || {};
    Object.keys(FACETS).forEach(function (f) {
      if (!Array.isArray(sel[f]) || !sel[f].length) return;
      var vals = sel[f].map(s).filter(Boolean).slice(0, 50);
      /* A quick facet's buttons are a fixed list: a saved value that is no longer on it (a renamed outcome) is dropped. */
      if (FACETS[f].quick && FACETS[f].order) vals = vals.filter(function (v) { return FACETS[f].order.indexOf(v) >= 0; });
      if (vals.length) st.sel[f] = vals;
    });
    if (x.sort && SORTS[x.sort.key]) st.sort = { key: x.sort.key, dir: x.sort.dir === 'asc' ? 'asc' : 'desc' };
    return st;
  }
  /** The range in order [from, to] — of the tab on view, or of the tab named. */
  function range(st, scope) { var d = getDates(st, scope), a = d.from, b = d.to; return a && b && a > b ? [b, a] : [a, b]; }

  /* The server search's answer (name, phone or email → lead ids; step 3, 2026-11-09) for ONE search text. Kept out of
     the saved state. While there is no answer for the text in the box, the search is the name-contains one. */
  var serverHit = null;
  function setServerHits(q, ids) {
    if (!ids) { serverHit = null; return; }
    var set = {};
    ids.forEach(function (x) { set[s(x)] = true; });
    serverHit = { q: s(q).toLowerCase(), set: set };
  }
  function hasServerHits(q) { return !!(serverHit && serverHit.q === s(q).toLowerCase()); }

  /** A search text that is a phone number, against the row's phone digits (spec.search.digits) — "(416) 555-0134" finds 14165550134. */
  function digitsHit(r, q) {
    if (!SEARCH.digits || !/^[0-9+()\-.\s]+$/.test(q)) return false;
    var qd = q.replace(/[^0-9]/g, '');
    return qd.length >= 3 && s(SEARCH.digits(r)).replace(/[^0-9]/g, '').indexOf(qd) >= 0;
  }

  /** Does the row pass every filter except `skip` (a facet key, a flag key, or 'date')?
      A list with a date range per tab: the row is tested against the range of the tab on view; with the tabs themselves
      skipped (their counts) against the range of the row's own tab; `scope` names a tab outright (the All count). */
  function passes(r, st, skip, scope) {
    if (SEARCH) {
      var q = s(st.q).toLowerCase();
      if (q && SEARCH.id && serverHit && serverHit.q === q) {
        if (!serverHit.set[s(SEARCH.id(r))]) return false;
      } else if (q) {
        var t = SEARCH.text(r), list = Array.isArray(t) ? t : [t];
        if (!list.some(function (x) { return s(x).toLowerCase().indexOf(q) >= 0; }) && !digitsHit(r, q)) return false;
      }
    }
    for (var k in FLAGS) { if (k !== skip && st[k] && !FLAGS[k].test(r)) return false; }
    /* DATE.exempt(r): a row the date filter never hides (Consultations: the "Needs outcome" and "No date" lists). */
    if (DATE && skip !== 'date' && !(DATE.exempt && DATE.exempt(r))) {
      var ab = range(st, !PER ? undefined : scope != null ? scope : skip === PER.facet ? valuesOf(PER.facet, r)[0] : undefined), d = s(DATE.get(r));
      if (ab[0] && !(d && d >= ab[0])) return false;
      if (ab[1] && !(d && d <= ab[1])) return false;
    }
    /* A facet with onlyOn: [tabs] belongs to those tabs' column only (Consultations: "Now" is the Completed / All column and the
       page takes its choice off when another tab is opened) — so the number on another tab is counted without it. */
    var ownTab = (PER && skip === PER.facet && scope == null) ? valuesOf(PER.facet, r)[0] : null;
    for (var f in st.sel) {
      if (f === skip || !FACETS[f]) continue;
      if (ownTab !== null && FACETS[f].onlyOn && FACETS[f].onlyOn.indexOf(ownTab) < 0) continue;
      var set = st.sel[f];
      if (set && set.length && !valuesOf(f, r).some(function (v) { return set.indexOf(v) >= 0; })) return false;
    }
    /* A row kept apart shows only when its facet has a choice on (with no choice — All — it is left out). */
    for (var g in FACETS) {
      if (g === skip || !FACETS[g].apart) continue;
      if (st.sel[g] && st.sel[g].length) continue;
      if (apartOf(g, r)) return false;
    }
    return true;
  }
  function filterRows(rows, st) { return (rows || []).filter(function (r) { return passes(r, st, ''); }); }
  /** Would the row show under "All" of facet f (no choice on)? With a date range per tab on f: tested against All's own range. */
  function passesAll(r, st, f) { return passes(r, st, f, PER && PER.facet === f ? PER.all : undefined); }

  /** A facet's choices with how many rows each would show — counted with the OTHER filters applied. */
  function facetCounts(rows, st, f) {
    var counts = {};
    (rows || []).forEach(function (r) { if (passes(r, st, f)) valuesOf(f, r).forEach(function (v) { counts[v] = (counts[v] || 0) + 1; }); });
    (st.sel[f] || []).forEach(function (v) { if (!(v in counts)) counts[v] = 0; });   // a ticked choice never disappears
    var order = FACETS[f].order;
    if (FACETS[f].fixed && order) order.forEach(function (v) { if (!(v in counts)) counts[v] = 0; });   // a short fixed list shows every choice, like the old drop-down
    var rank = function (v) { if (v === NONE) return 1000; if (!order) return 0; var i = order.indexOf(v.split(':')[0]); return i < 0 ? 99 : i; };
    var nat = FACETS[f].natural ? { numeric: true } : undefined;
    return Object.keys(counts).sort(function (a, b) { return (rank(a) - rank(b)) || (nat ? labelOf(f, a).localeCompare(labelOf(f, b), undefined, nat) : labelOf(f, a).localeCompare(labelOf(f, b))); })
      .map(function (v) { return { value: v, label: labelOf(f, v), count: counts[v] }; });
  }

  /** Sorted by the chosen column; an unknown column falls back to the list's default; no sort at all = the server order. Ties keep the server order.
      A key in spec.sortBlanksLast puts its blank values ('' / null) last whichever way it sorts. */
  function sortRows(rows, sort) {
    var key = sort && SORTS[sort.key] ? sort.key : (DEFAULT_SORT ? DEFAULT_SORT.key : null);
    if (!key) return (rows || []).slice();
    var dir = sort ? (sort.dir === 'asc' ? 1 : -1) : (DEFAULT_SORT.dir === 'asc' ? 1 : -1), get = SORTS[key];
    var bl = BLANKS_LAST.indexOf(key) >= 0;
    function isBlank(k) { return k == null || k === ''; }
    return (rows || []).map(function (r, i) { return { r: r, i: i, k: get(r) }; })
      .sort(function (a, b) {
        if (bl) { var ab = isBlank(a.k), bb = isBlank(b.k); if (ab !== bb) return ab ? 1 : -1; if (ab) return a.i - b.i; }
        var c = a.k < b.k ? -1 : a.k > b.k ? 1 : 0; return (c * dir) || (a.i - b.i);
      })
      .map(function (o) { return o.r; });
  }

  function torontoToday(now) { return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); }
  function addDays(day, n) { var p = day.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)).toISOString().slice(0, 10); }
  /** Quick date ranges, in Toronto days. */
  function presetRange(name, now) {
    var t = torontoToday(now);
    if (name === 'today') return { from: t, to: t };
    if (name === '7d') return { from: addDays(t, -6), to: t };
    if (name === '30d') return { from: addDays(t, -29), to: t };
    if (name === 'month') return { from: t.slice(0, 8) + '01', to: t };
    if (name === 'lastmonth') { var end = addDays(t.slice(0, 8) + '01', -1); return { from: end.slice(0, 8) + '01', to: end }; }
    /* Looking ahead (Consultations, 2026-11-11): tomorrow, the week Monday–Sunday, next week, the whole month. */
    if (name === 'tomorrow') return { from: addDays(t, 1), to: addDays(t, 1) };
    if (name === 'week' || name === 'nextweek') {
      var p = t.split('-'), dow = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();   // 0 = Sunday
      var mon = addDays(t, -((dow + 6) % 7) + (name === 'nextweek' ? 7 : 0));
      return { from: mon, to: addDays(mon, 6) };
    }
    if (name === 'fullmonth') {
      var q = t.split('-'), last = new Date(Date.UTC(+q[0], +q[1], 0)).toISOString().slice(0, 10);
      return { from: t.slice(0, 8) + '01', to: last };
    }
    return { from: '', to: '' };
  }
  function shortDay(day) { var p = day.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric' }); }

  /** The active filters as chips: [{ key, text }]. A "quick" facet (buttons above the table) shows as its pressed buttons instead. */
  function chips(st) {
    var out = [];
    if (SEARCH && s(st.q)) out.push({ key: 'q', text: (SEARCH.chip || 'Search') + ' “' + s(st.q) + '”' });
    Object.keys(FLAGS).forEach(function (k) { if (st[k]) out.push({ key: k, text: FLAGS[k].chip }); });
    if (DATE) {
      var ab = range(st);
      if (ab[0] || ab[1]) out.push({ key: DATE.key, text: DATE.chip + ' ' + (ab[0] && ab[1] ? (ab[0] === ab[1] ? shortDay(ab[0]) : shortDay(ab[0]) + ' – ' + shortDay(ab[1])) : ab[0] ? 'from ' + shortDay(ab[0]) : 'until ' + shortDay(ab[1])) });
    }
    Object.keys(FACETS).forEach(function (f) {
      var set = st.sel[f];
      if (!FACETS[f].quick && set && set.length) out.push({ key: f, text: FACETS[f].label + ': ' + set.map(function (v) { return labelOf(f, v); }).join(', ') });
    });
    return out;
  }
  function clearKey(st, key) {
    if (key === 'q') st.q = ''; else if (FLAGS[key]) st[key] = false;
    else if (DATE && key === DATE.key) setDates(st, '', ''); else delete st.sel[key];
    return st;
  }
  /** "Clear filters": every chip filter off; the sort and the quick buttons stay.
      A date range per tab: only the range of the tab on view goes — the other tabs keep theirs. */
  function clearAll(st) {
    var next = emptyState();
    next.sort = st.sort;
    Object.keys(FACETS).forEach(function (f) { if (FACETS[f].quick && st.sel[f]) next.sel[f] = st.sel[f].slice(); });
    if (PER) { var on = scopeOf(st); dateScopes().forEach(function (k) { if (k === on) return; var d = getDates(st, k); if (d.from || d.to) next.dates[k] = d; }); }
    return next;
  }

  /** The columns of the tab on view (tab = the quick facet's choice; '' = no choice, the "All" tab): a column with
      `tabs: [...]` shows only on those tabs, a column without it on every tab. The order is the list's own. */
  function colsOnTab(cols, tab) {
    tab = tab == null ? '' : String(tab);
    return (cols || []).filter(function (c) { return !c.tabs || c.tabs.indexOf(tab) >= 0; });
  }

  return { NONE: NONE, FACETS: FACETS, colsOnTab: colsOnTab, FLAGS: FLAGS, DATE: DATE, DEFAULT_SORT: DEFAULT_SORT, emptyState: emptyState, normalizeState: normalizeState, passes: passes, setServerHits: setServerHits, hasServerHits: hasServerHits,
    filterRows: filterRows, facetCounts: facetCounts, sortRows: sortRows, presetRange: presetRange, chips: chips, clearKey: clearKey, clearAll: clearAll, range: range,
    passesAll: passesAll, scopeOf: scopeOf, hasDates: hasDates, getDates: getDates, setDates: setDates,
    valuesOf: valuesOf, labelOf: labelOf, apartOf: apartOf };
}

/**
 * o: { key: sessionStorage key, ids: { head, chips, count, search, pop }, cols: [...], render: window function name,
 *      api: window name for { setRows, state, apply }, initial(state) (e.g. a link's choice), onChange(state) (a person changed something),
 *      quick: { facet, box, label, all, values: [...], hints: {} } (buttons above the table), countText(shown, total);
 *        quick.tabs: drawn as tabs (one at a time, arrow keys move); quick.allLast: "All" is the last tab;
 *        quick.storeKey + quick.default: a new browser tab opens on the default; the choice (All too) is kept for this tab
 *        (a link chosen by initial() returning true wins, and is kept),
 *      serverSearch: a POST url ('/api/leads/search') — the search box also finds phone and email on the server (answers lead ids),
 *      countable: window function name (r) -> boolean — only these rows are counted beside the choices (Consultations: the date range),
 *      panelCountable: window function name (r) -> boolean — a narrower set for the counts INSIDE a column's filter panel only, never the
 *        tabs above the table (Consultations: the month on view on the Completed and All tabs),
 *      defaultDateScope: with a date range per tab (spec.date.per), the tab the opening date belongs to (Consultations: 'booked'),
 *      sortReset: 'newest case first' (or a function(state) giving the words) — the list's normal order has no column, so a column
        sort shows as a chip whose × goes back to it }
 * A column: { id, label, title, menu, facets: [...], flags: [...], date: true, note, sort, sortText: [..], sortDirs: [first, second],
 *             tabs: [quick values] }
 *   (a column with only a sort and a note still has a panel: the sort both ways and the note — Consultations "Client")
 *   tabs (Client Master, 2026-11-12): the column belongs to those tabs only ('' = the "All" tab, no choice on) — the header is drawn,
 *   and panels are offered, for the columns of the tab on view (LT.colsOnTab); the page draws its rows from the same set. No column
 *   with `tabs` = every column on every tab, as always. What a person chose on a column that is not on the tab on view STAYS ON and
 *   is never hidden: a filter shows as its chip above the table (× takes it off, "Clear filters" too), a sort as the "Sorted" chip.
 */
function listTableUi(LT, o, win) {
  var doc = win.document, KEY = o.key, ids = o.ids, COLS = o.cols;
  var state = LT.emptyState();
  /* o.defaultDate (Consultations: 'today'): a new browser tab opens with that date choice on. It is a filter like any
     other — the chip's × or "Clear filters" takes it off, and that is kept for the tab. Beside the kept filters sits a
     mark (KEY + '_day'): the day, while the date filter is exactly "that day = today"; empty otherwise. No mark at all =
     this tab has not opened the list with this rule yet (a new tab, or one from before the rule) → the default goes on.
     A mark from an earlier day = the tab was left on "today" overnight → it moves on to the new day (checked at every
     redraw, so the page's own refresh and Back do it too). */
  var dayMark = null;
  try { dayMark = win.sessionStorage.getItem(KEY + '_day'); state = LT.normalizeState(JSON.parse(win.sessionStorage.getItem(KEY) || 'null')); } catch (e) { /* private window: defaults */ }
  function today() { return LT.presetRange('today', Date.now()).from; }
  function rollDay() {
    if (!o.defaultDate || !LT.DATE) return;
    /* a date range per tab: the opening date is one tab's (o.defaultDateScope) — never another tab's, whichever is on view */
    var t = today(), sc = o.defaultDateScope, cur = LT.getDates(state, sc);
    if (dayMark === null) { var dd = LT.presetRange(o.defaultDate, Date.now()); LT.setDates(state, dd.from, dd.to, sc); }
    else if (dayMark && dayMark !== t && cur.from === dayMark && cur.to === dayMark) LT.setDates(state, t, t, sc);
    cur = LT.getDates(state, sc);
    dayMark = (cur.from === t && cur.to === t) ? t : '';
  }
  rollDay();
  /* initial() returns true when a link chose the tab (Retainers ?outcome=): it wins over the kept tab, and is kept itself
     (below) — it is the tab this browser tab is on, so the way back from a record returns to it. */
  var linked = false;
  if (o.initial) { try { linked = o.initial(state) === true; } catch (e) { /* a bad link: defaults */ } }
  var ROWS = [], openCol = null, openBtn = null;
  /* Tabs (Leads by stage, 2026-11-05): a new browser tab opens on the default; the choice — All too — is kept for this tab. */
  if (o.quick && o.quick.storeKey && !linked) {
    var tk = null; try { tk = win.sessionStorage.getItem(o.quick.storeKey); } catch (e) { /* defaults */ }
    if (tk === null) { if (o.quick.default) state.sel[o.quick.facet] = [o.quick.default]; else delete state.sel[o.quick.facet]; }
    else if (tk === '') delete state.sel[o.quick.facet];
    else if (o.quick.values.indexOf(tk) >= 0) state.sel[o.quick.facet] = [tk];
    else if (o.quick.default) state.sel[o.quick.facet] = [o.quick.default];
  }
  /* Tabs show one at a time: a link (or an older saved view) naming several keeps the first. */
  if (o.quick && o.quick.tabs && state.sel[o.quick.facet] && state.sel[o.quick.facet].length > 1) state.sel[o.quick.facet] = [state.sel[o.quick.facet][0]];
  if (linked && o.quick && o.quick.storeKey && !win.TDOT_SIGNED_OUT) { try { win.sessionStorage.setItem(o.quick.storeKey, (state.sel[o.quick.facet] || [''])[0]); } catch (e) { /* not kept — fine */ } }
  var FUNNEL = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M1.5 2.5h13l-5 6v4.2l-3 1.6V8.5z"/></svg>';
  var pop = doc.getElementById(ids.pop);
  if (!pop) { pop = doc.createElement('div'); pop.id = ids.pop; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'false'); doc.body.appendChild(pop); }
  pop.classList.add('lt-pop');
  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function col(id) { for (var i = 0; i < COLS.length; i++) if (COLS[i].id === id) return COLS[i]; return null; }
  /* Columns per tab (a column's `tabs`): the columns of the tab on view. A list with no such column: all of them, always. */
  var TABBED = COLS.some(function (c) { return !!c.tabs; });
  function shownCols() { if (!TABBED) return COLS; var l = o.quick && state.sel[o.quick.facet]; return LT.colsOnTab(COLS, (l && l.length) ? l[0] : ''); }
  function save() {
    if (win.TDOT_SIGNED_OUT) return;
    try { win.sessionStorage.setItem(KEY, JSON.stringify(state)); if (o.defaultDate && dayMark !== null) win.sessionStorage.setItem(KEY + '_day', dayMark); } catch (e) { /* not kept — fine */ }
    /* Tabs: the kept tab is always the tab shown — also after Back brings an older copy of the page out of the browser's
       memory, so the way back from a record (and the top bar) returns to the tab on screen (review 2026-11-05). */
    if (o.quick && o.quick.storeKey) { try { win.sessionStorage.setItem(o.quick.storeKey, (state.sel[o.quick.facet] || [''])[0]); } catch (e) { /* not kept — fine */ } }
  }
  /* The rows the counts beside the choices are taken from (Consultations: only the date range on view, with its two folds). */
  function countRows() { return o.countable && typeof win[o.countable] === 'function' ? ROWS.filter(function (r) { return win[o.countable](r); }) : ROWS; }
  /* The rows the counts inside a filter panel are taken from: the page may narrow them to what its table can show. */
  function panelRows() { var rows = countRows(); return o.panelCountable && typeof win[o.panelCountable] === 'function' ? rows.filter(function (r) { return win[o.panelCountable](r); }) : rows; }
  /* The column's date filter is on offer — not on a tab that has no dates (a date range per tab: Consultations "No date"). */
  function dateOn(c) { return !!(c.date && LT.DATE && LT.hasDates(LT.scopeOf(state))); }
  function hasFilter(c) { return !!((c.facets && c.facets.length) || (c.flags && c.flags.length) || dateOn(c)); }
  function hasPanel(c) { return hasFilter(c) || !!(c.sort && c.note); }
  function activeCount(c) {
    var n = 0, dd = dateOn(c) ? LT.getDates(state) : null;
    (c.flags || []).forEach(function (k) { if (state[k]) n++; });
    if (dd && (dd.from || dd.to)) n++;
    (c.facets || []).forEach(function (f) { if (state.sel[f] && state.sel[f].length) n++; });
    return n;
  }
  function sortedBy(c) { return c.sort && state.sort && state.sort.key === c.sort; }

  function renderHead() {
    var tr = doc.getElementById(ids.head);
    if (!tr) return;
    var focusSort = doc.activeElement && tr.contains(doc.activeElement) && doc.activeElement.getAttribute('data-sortcol');
    tr.innerHTML = shownCols().map(function (c) {
      if (!hasPanel(c) && !c.sort) return '<th scope="col"' + (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + (c.label ? esc(c.label) : '<span class="sr-only">Actions</span>') + '</th>';
      var n = activeCount(c), sorted = sortedBy(c);
      var arrow = sorted ? '<span class="th-sort" aria-hidden="true">' + (state.sort.dir === 'asc' ? '▲' : '▼') + '</span>' : '';
      var ariaSort = sorted ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      /* The column name sorts (where the column sorts); the funnel opens the panel. */
      var name = c.sort
        ? '<button type="button" class="th-l th-sortbtn" data-sortcol="' + c.id + '" title="Sort by ' + esc(c.label) + '">' + esc(c.label) + '</button>'
        : '<span class="th-l">' + esc(c.label) + '</span>';
      return '<th scope="col"' + (c.sort ? ' aria-sort="' + ariaSort + '"' : '') + (c.title ? ' title="' + esc(c.title) + '"' : '') + '><div class="th-in">'
        + name + arrow
        + (hasPanel(c) ? '<button type="button" class="th-f' + (n ? ' on' : '') + (openCol === c.id ? ' open' : '') + '" data-col="' + c.id + '" aria-haspopup="dialog" aria-expanded="' + (openCol === c.id) + '"'
          + ' aria-label="' + (hasFilter(c) ? 'Filter' + (c.sort ? ' and sort' : '') : 'Sort') + ': ' + esc(c.label) + (n ? ' (' + n + ' active)' : '') + '">' + FUNNEL + (n ? '<span class="th-n">' + n + '</span>' : '') + '</button>' : '')
        + '</div></th>';
    }).join('');
    Array.prototype.forEach.call(tr.querySelectorAll('.th-f'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); var id = b.getAttribute('data-col'); if (openCol === id) close(true); else open(id); };
    });
    Array.prototype.forEach.call(tr.querySelectorAll('[data-sortcol]'), function (b) {
      b.onclick = function () {
        var sid = b.getAttribute('data-sortcol'), c = col(sid), dirs = c.sortDirs || ['asc', 'desc'];
        var dir = sortedBy(c) ? (state.sort.dir === dirs[0] ? dirs[1] : dirs[0]) : dirs[0];   // first click: the column's natural order; again: the other way
        close(false);   /* a filter panel open: closed by this click (the press does not close it — it would rebuild the header under the click) */
        state.sort = { key: c.sort, dir: dir }; apply('sort');
        var tr2 = doc.getElementById(ids.head), again = tr2 && tr2.querySelector('[data-sortcol="' + sid + '"]'); if (again) again.focus();
      };
    });
    if (focusSort) { var again = tr.querySelector('[data-sortcol="' + focusSort + '"]'); if (again) again.focus(); }   // keyboard: stay on the column
  }

  function countText(shown, total) { return o.countText ? o.countText(shown, total) : '(' + shown + (shown !== total ? ' of ' + total : '') + ')'; }
  /* The list's normal order has no column (Cases: newest case first; on a view tab Monday's order): a column sort shows as
     a chip; its × goes back. o.sortReset is the words for the normal order, or a function(state) giving them. */
  function resetText() { return typeof o.sortReset === 'function' ? o.sortReset(state) : o.sortReset; }
  function sortChip() {
    var d = LT.DEFAULT_SORT, st = state.sort, reset = resetText();
    if (!reset || !st || !st.key || (d && st.key === d.key && st.dir === d.dir)) return '';   /* a list with no default column (Consultations): any column sort shows the chip */
    /* the column of the tab on view that sorts so; else (the sort was chosen on another tab's column) that column — the chip is never lost */
    var c = null, shown = shownCols(); for (var i = 0; i < shown.length; i++) if (shown[i].sort === st.key) c = shown[i];
    if (!c) for (var j = 0; j < COLS.length; j++) if (COLS[j].sort === st.key) c = COLS[j];
    if (!c) return '';
    var t = 'Sorted: ' + c.label + ' (' + c.sortText[Math.max(0, (c.sortDirs || []).indexOf(st.dir))] + ')';
    return '<span class="q-chip q-chip-sort">' + esc(t) + '<button type="button" data-sortreset="1" aria-label="Back to the normal order: ' + esc(reset) + '" title="Back to ' + esc(reset) + '">×</button></span>';
  }
  function renderChips(shown, total) {
    var box = doc.getElementById(ids.chips), list = LT.chips(state), cnt = doc.getElementById(ids.count), sc = sortChip();
    if (cnt) cnt.textContent = countText(shown, total);
    if (!box) return;
    if (!list.length && !sc) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = sc + list.map(function (c) {
      return '<span class="q-chip">' + esc(c.text) + '<button type="button" data-chip="' + esc(c.key) + '" aria-label="Remove filter: ' + esc(c.text) + '">×</button></span>';
    }).join('') + (list.length ? '<button type="button" class="q-clearall" data-clearall="1">Clear filters</button>' : '');
    var rs = box.querySelector('[data-sortreset]');
    if (rs) rs.onclick = function () { state.sort = LT.DEFAULT_SORT ? { key: LT.DEFAULT_SORT.key, dir: LT.DEFAULT_SORT.dir } : null; apply('sort'); };
    Array.prototype.forEach.call(box.querySelectorAll('[data-chip]'), function (b) {
      b.onclick = function () { LT.clearKey(state, b.getAttribute('data-chip')); if (b.getAttribute('data-chip') === 'q') setSearch(''); apply('filter'); };
    });
    var ca = box.querySelector('[data-clearall]');
    if (ca) ca.onclick = function () { state = LT.clearAll(state); setSearch(''); close(false); apply('filter'); var s = doc.getElementById(ids.search); if (s) s.focus(); };
  }

  /* Buttons above the table for one facet (Retainers: the outcomes) — counts from the other filters; none on = all. */
  function renderQuick() {
    var q = o.quick; if (!q) return;
    var box = doc.getElementById(q.box); if (!box) return;
    var CR = countRows();
    var counts = {}; LT.facetCounts(CR, state, q.facet).forEach(function (x) { counts[x.value] = x.count; });
    /* All counts the rows with no choice on — never the ones kept apart (the Retained tab) */
    var base = CR.filter(function (r) { return LT.passesAll(r, state, q.facet) && !LT.apartOf(q.facet, r); }).length, sel = state.sel[q.facet] || [];
    var apart = (LT.FACETS[q.facet] && LT.FACETS[q.facet].apart) || [];
    var focusV = doc.activeElement && box.contains(doc.activeElement) ? doc.activeElement.getAttribute('data-quick') : null;
    var tip = function (v) { return q.hints && q.hints[v] ? ' title="' + esc(q.hints[v]) + '"' : ''; };
    if (q.tabs) {
      /* One at a time, like the Consultations page tabs: role=tablist, the chosen tab is the one Tab reaches, arrows move. */
      var chosen = sel.length ? sel[0] : '';
      var tab = function (v, label, count) {
        var cur = v === chosen;
        return '<button type="button" role="tab" class="lt-tab' + (cur ? ' active' : '') + (count ? '' : ' zero') + '" data-quick="' + esc(v) + '" aria-selected="' + (cur ? 'true' : 'false') + '" tabindex="' + (cur ? '0' : '-1') + '"' + tip(v) + '>'
          + esc(label) + ' <span class="lt-tab-n">' + count + '</span></button>';
      };
      /* A tab kept apart (Retained) comes after All: All is the sum of the tabs before it, never of that one. */
      var tabs = q.values.filter(function (v) { return apart.indexOf(v) < 0; }).map(function (v) { return tab(v, LT.labelOf(q.facet, v), counts[v] || 0); }), allTab = tab('', q.all || 'All', base);
      var side = q.values.filter(function (v) { return apart.indexOf(v) >= 0; }).map(function (v) { return tab(v, LT.labelOf(q.facet, v), counts[v] || 0); });
      box.setAttribute('role', 'tablist');
      box.innerHTML = (q.allLast ? tabs.join('') + allTab : allTab + tabs.join('')) + side.join('');
    } else {
      var btn = function (v, label, count, on) { return '<button type="button" data-quick="' + esc(v) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (count ? '' : ' class="zero"') + tip(v) + '>' + esc(label) + ' <span class="qn">' + count + '</span></button>'; };
      box.innerHTML = (q.label ? '<span class="ql">' + esc(q.label) + '</span>' : '') + btn('', q.all || 'All', base, !sel.length)
        + q.values.map(function (v) { return btn(v, v, counts[v] || 0, sel.indexOf(v) >= 0); }).join('');
    }
    var btns = box.querySelectorAll('button[data-quick]');
    Array.prototype.forEach.call(btns, function (b, idx) {
      b.onclick = function () {
        var v = b.getAttribute('data-quick'), next = (state.sel[q.facet] || []).slice();
        if (!v) next = []; else if (q.tabs) next = [v]; else { var i = next.indexOf(v); if (i >= 0) next.splice(i, 1); else next.push(v); }
        if (next.length) state.sel[q.facet] = next; else delete state.sel[q.facet];
        if (q.storeKey && !win.TDOT_SIGNED_OUT) { try { win.sessionStorage.setItem(q.storeKey, v || ''); } catch (e) { /* not kept — fine */ } }
        apply('filter');
      };
      if (q.tabs) b.onkeydown = function (e) {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;   /* Alt/Cmd + arrow = the browser's Back: left alone */
        var to = e.key === 'ArrowRight' ? idx + 1 : e.key === 'ArrowLeft' ? idx - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : null;
        if (to === null) return;
        e.preventDefault();
        to = (to + btns.length) % btns.length;
        box.setAttribute('data-focus', String(to));
        btns[to].click();
      };
      if (focusV !== null && b.getAttribute('data-quick') === focusV) b.focus();
    });
    var ft = box.getAttribute('data-focus');   /* arrows: the newly chosen tab keeps the focus after the redraw */
    if (ft !== null) { box.removeAttribute('data-focus'); var nb = box.querySelectorAll('button[data-quick]')[Number(ft)]; if (nb) nb.focus(); }
  }

  var started = false;
  function apply(why) {
    rollDay();   // a list left open on "today" overnight moves on to the new day
    if (openCol && TABBED && shownCols().indexOf(col(openCol)) < 0) close(false);   // the open panel's column is not on the tab now on view
    var rows = LT.sortRows(LT.filterRows(ROWS, state), state.sort);
    /* h.without(f): how many rows pass every filter except f (an empty list can say why it is empty);
       h.defaultSort: true when the list is in its normal order (no column sort chosen) */
    var d = LT.DEFAULT_SORT, cur = state.sort;
    var h = { total: ROWS.length, without: function (f) { return countRows().filter(function (r) { return LT.passes(r, state, f); }).length; },
      defaultSort: !d || !cur || (cur.key === d.key && cur.dir === d.dir) };
    var out = win[o.render](rows, why || 'filter', state, h);
    var shown = rows.length, total = ROWS.length;
    if (typeof out === 'number') shown = out;
    else if (out && typeof out === 'object') { if (out.shown != null) shown = out.shown; if (out.total != null) total = out.total; }
    renderHead();
    renderChips(shown, total);
    renderQuick();
    if (openCol) renderPanel();
    save();
    if (started && why !== 'data' && o.onChange) { try { o.onChange(state); } catch (e) { /* the page's extra, never the list */ } }
  }

  // ── the panel ──
  function panelHtml(c) {
    var h = '<div class="qp-h"><span>' + esc(c.label) + '</span><button type="button" class="qp-x" data-act="close" aria-label="Close">×</button></div><div class="qp-b">';
    if (c.sort) {
      h += '<div class="qp-sec"><div class="qp-t">Sort</div><div class="qp-sort">' + c.sortDirs.map(function (d, i) {
        var on = sortedBy(c) && state.sort.dir === d;
        return '<button type="button" class="qp-btn' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-sort="' + d + '">' + esc(c.sortText[i]) + '</button>';
      }).join('') + '</div></div>';
    }
    if (c.flags && c.flags.length) {
      h += '<div class="qp-sec">' + c.flags.map(function (k) {
        return '<label class="qp-row"><input type="checkbox" data-flag="' + k + '"' + (state[k] ? ' checked' : '') + '> <span>' + esc(LT.FLAGS[k].chip) + '</span>'
          + '<span class="qp-c">' + panelRows().filter(function (r) { return LT.FLAGS[k].test(r) && LT.passes(r, state, k); }).length + '</span></label>';
      }).join('') + (c.note ? '<div class="qp-note">' + esc(c.note) + '</div>' : '') + '</div>';
    }
    if (dateOn(c)) {
      var ab = LT.range(state), dd = LT.getDates(state);
      h += '<div class="qp-sec"><div class="qp-t">' + esc(LT.DATE.chip) + '</div><div class="qp-presets">'
        + ((LT.DATE.presetsBy && LT.scopeOf && LT.DATE.presetsBy[LT.scopeOf(state)]) || LT.DATE.presets || [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month']]).map(function (p) {
          var r = LT.presetRange(p[0], Date.now()), on = r.from === ab[0] && r.to === ab[1];
          return '<button type="button" class="qp-btn' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-preset="' + p[0] + '">' + p[1] + '</button>';
        }).join('') + '</div>'
        + '<div class="qp-dates"><label>From<input type="date" data-date="from" value="' + esc(dd.from) + '"></label><label>To<input type="date" data-date="to" value="' + esc(dd.to) + '"></label></div>'
        + '<div class="qp-note">Both days included, Toronto time.</div></div>';
    }
    (c.facets || []).forEach(function (f) {
      var opts = LT.facetCounts(panelRows(), state, f), sel = state.sel[f] || [];
      h += '<div class="qp-sec" data-facet="' + f + '">' + ((c.facets.length > 1 || c.sort || (c.flags && c.flags.length)) ? '<div class="qp-t">' + esc(LT.FACETS[f].label) + '</div>' : '')
        + (opts.length > 8 ? '<input type="search" class="qp-find" data-find="' + f + '" placeholder="Find…" aria-label="Find a ' + esc(LT.FACETS[f].label) + '">' : '')
        + '<div class="qp-list">' + (opts.length ? opts.map(function (x) {
          var on = sel.indexOf(x.value) >= 0;
          return '<label class="qp-row' + (x.count ? '' : ' zero') + '" data-label="' + esc(x.label.toLowerCase()) + '"><input type="checkbox" data-f="' + f + '" value="' + esc(x.value) + '"' + (on ? ' checked' : '') + '> <span>' + esc(x.label) + '</span><span class="qp-c">' + x.count + '</span></label>';
        }).join('') : '<div class="qp-note">Nothing to choose from.</div>') + '</div></div>';
    });
    if (c.note && !(c.flags && c.flags.length)) h += '<div class="qp-sec"><div class="qp-note">' + esc(c.note) + '</div></div>';
    h += '</div><div class="qp-f">' + (hasFilter(c) ? '<button type="button" class="qp-link" data-act="clear">Clear</button>' : '<span></span>') + '<button type="button" class="qp-done" data-act="close">Done</button></div>';
    return h;
  }
  function renderPanel() {
    var c = col(openCol);
    if (!c) return;
    var focusKey = doc.activeElement && pop.contains(doc.activeElement) ? focusId(doc.activeElement) : null;
    var finds = {}; Array.prototype.forEach.call(pop.querySelectorAll('[data-find]'), function (i) { finds[i.getAttribute('data-find')] = i.value; });
    pop.innerHTML = panelHtml(c);
    pop.setAttribute('aria-label', 'Filter: ' + c.label);
    Object.keys(finds).forEach(function (f) { var i = pop.querySelector('[data-find="' + f + '"]'); if (i) { i.value = finds[f]; filterList(i); } });
    wirePanel(c);
    if (focusKey) { var el = pop.querySelector(focusKey); if (el) el.focus(); }
  }
  function focusId(el) {
    if (el.getAttribute('data-f')) return '[data-f="' + el.getAttribute('data-f') + '"][value="' + String(el.value).replace(/"/g, '\\"') + '"]';
    var attrs = ['data-find', 'data-date', 'data-sort', 'data-preset', 'data-flag', 'data-act'];
    for (var i = 0; i < attrs.length; i++) if (el.getAttribute(attrs[i])) return '[' + attrs[i] + '="' + el.getAttribute(attrs[i]) + '"]';
    return null;
  }
  function filterList(input) {
    var q = input.value.toLowerCase().trim(), sec = input.parentNode;
    Array.prototype.forEach.call(sec.querySelectorAll('.qp-row'), function (r) { r.style.display = !q || r.getAttribute('data-label').indexOf(q) >= 0 ? '' : 'none'; });
  }
  function wirePanel(c) {
    Array.prototype.forEach.call(pop.querySelectorAll('[data-act="close"]'), function (b) { b.onclick = function () { close(true); }; });
    var clr = pop.querySelector('[data-act="clear"]');
    if (clr) clr.onclick = function () {
      (c.flags || []).forEach(function (k) { state[k] = false; });
      if (dateOn(c)) LT.setDates(state, '', '');
      (c.facets || []).forEach(function (f) { delete state.sel[f]; });
      apply('filter');
    };
    Array.prototype.forEach.call(pop.querySelectorAll('[data-sort]'), function (b) { b.onclick = function () { state.sort = { key: c.sort, dir: b.getAttribute('data-sort') }; apply('sort'); }; });
    Array.prototype.forEach.call(pop.querySelectorAll('[data-preset]'), function (b) { b.onclick = function () { var r = LT.presetRange(b.getAttribute('data-preset'), Date.now()); LT.setDates(state, r.from, r.to); apply('filter'); }; });
    Array.prototype.forEach.call(pop.querySelectorAll('[data-date]'), function (i) { i.onchange = function () { var d = LT.getDates(state); d[i.getAttribute('data-date')] = i.value || ''; LT.setDates(state, d.from, d.to); apply('filter'); }; });
    Array.prototype.forEach.call(pop.querySelectorAll('[data-flag]'), function (u) { u.onchange = function () { state[u.getAttribute('data-flag')] = u.checked; apply('filter'); }; });
    Array.prototype.forEach.call(pop.querySelectorAll('[data-f]'), function (i) {
      i.onchange = function () {
        var f = i.getAttribute('data-f'), set = (state.sel[f] || []).slice(), at = set.indexOf(i.value);
        if (i.checked && at < 0) set.push(i.value); if (!i.checked && at >= 0) set.splice(at, 1);
        if (set.length) state.sel[f] = set; else delete state.sel[f];
        apply('filter');
      };
    });
    Array.prototype.forEach.call(pop.querySelectorAll('[data-find]'), function (i) { i.oninput = function () { filterList(i); }; });
  }
  function headBtn(id) { var tr = doc.getElementById(ids.head); return tr ? tr.querySelector('.th-f[data-col="' + id + '"]') : null; }
  function place() {
    if (!openBtn || !openBtn.isConnected) { var b = headBtn(openCol); if (b) openBtn = b; }
    if (!openBtn) return;
    var r = openBtn.getBoundingClientRect(), w = Math.min(300, win.innerWidth - 24);
    pop.style.width = w + 'px';
    pop.style.left = Math.max(12, Math.min(r.right - w, win.innerWidth - w - 12)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.maxHeight = Math.max(200, win.innerHeight - r.bottom - 18) + 'px';
  }
  function open(id) {
    try { doc.dispatchEvent(new CustomEvent('tdot-list-open', { detail: KEY })); } catch (e) { /* old browser: the outside press closes it */ }
    openCol = id; renderHead();
    openBtn = headBtn(id);
    pop.style.display = 'flex';
    renderPanel(); place();
    var first = pop.querySelector('.qp-b input, .qp-b button'); if (first) first.focus();
  }
  function close(refocus) {
    if (!openCol) return;
    var id = openCol; openCol = null;
    pop.style.display = 'none';
    renderHead();
    if (refocus) { var b = headBtn(id); if (b) b.focus(); }
    openBtn = null;
  }
  doc.addEventListener('keydown', function (e) {
    if (win.TDOT_DLG && win.TDOT_DLG.stack && win.TDOT_DLG.stack.length) return;   /* a pop-up is open: Escape is its */
    if (e.key === 'Escape' && openCol && !e.defaultPrevented) { e.preventDefault(); close(true); }
  });
  doc.addEventListener('tdot-dialog-open', function () { close(false); });
  doc.addEventListener('tdot-list-open', function (e) { if (!e || e.detail !== KEY) close(false); });   /* another list's panel opened */
  doc.addEventListener('mousedown', function (e) {
    if (!openCol) return;
    var tr = doc.getElementById(ids.head);
    /* this list's own funnels and column names handle the press themselves (a name closes the panel in its click) */
    if (pop.contains(e.target) || (tr && tr.contains(e.target) && e.target.closest && e.target.closest('.th-f, [data-sortcol]'))) return;
    close(false);
  });
  win.addEventListener('resize', function () { if (openCol) place(); });
  win.addEventListener('scroll', function () { if (openCol) place(); }, true);

  var search = doc.getElementById(ids.search);
  function setSearch(v) { if (search) search.value = v; if (!v && LT.setServerHits) LT.setServerHits('', null); }
  /* Search by phone and email on the server (step 3, 2026-11-09): the box text is POSTed (never in a URL), the answer is
     lead ids only. Until it comes — and when it fails — the list shows the name-contains search, and says so on failure. */
  var srvSeq = 0, srvTimer = null, srvNote = null;
  function srvSay(msg) {
    if (!search) return;
    if (!srvNote) {
      srvNote = doc.createElement('div'); srvNote.className = 'q-search-note'; srvNote.setAttribute('aria-live', 'polite');
      var box = search.parentNode; if (box && box.parentNode) box.parentNode.insertBefore(srvNote, box.nextSibling);
    }
    srvNote.textContent = msg || ''; srvNote.style.display = msg ? '' : 'none';
  }
  function srvKey() { try { return win.sessionStorage.getItem('tdot_admin_key') || ''; } catch (e) { return ''; } }
  function serverSearch() {
    if (!o.serverSearch || typeof win.fetch !== 'function') return;
    var q = String(state.q || '').replace(/^\s+|\s+$/g, '');
    var my = ++srvSeq;
    if (srvTimer) win.clearTimeout(srvTimer);
    if (!q) { LT.setServerHits('', null); srvSay(''); return; }
    if (LT.hasServerHits(q)) return;
    srvTimer = win.setTimeout(function () {
      win.fetch(o.serverSearch, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Api-Key': srvKey() }, body: JSON.stringify({ q: q }) })
        .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (res) {
          if (my !== srvSeq) return;   /* an older answer: the box changed since */
          if (res.s !== 200 || !res.j || !res.j.ok || !Array.isArray(res.j.ids)) { srvSay('Phone and email search is not available right now — searching names only.'); return; }
          srvSay('');
          if (res.j.mode === 'short') return;   /* too short to search: the name-contains search stays */
          LT.setServerHits(q, res.j.ids); apply('filter');
        })
        .catch(function () { if (my === srvSeq) srvSay('Phone and email search is not available right now — searching names only.'); });
    }, 250);
  }
  if (search) { search.value = state.q; search.addEventListener('input', function () { state.q = search.value; apply('filter'); serverSearch(); }); }
  if (state.q) serverSearch();

  var api = {
    /** New rows from the server: the filters, the sort and the page stay as they are. */
    setRows: function (rows) { ROWS = rows || []; apply('data'); started = true; },
    state: function () { return state; },
    core: LT,   // the pure part (a page asks it which tab a row is under)
    apply: function (why) { apply(why || 'filter'); },
    close: function () { close(false); },
    label: function (facet, v) { return LT.labelOf(facet, v); },
    /** "Clear filters" from elsewhere on the page (the Client Master "Filtered" line): the same as the chips' button (focus goes to the search box, as there) — the tab and the sort stay. */
    clearFilters: function () { state = LT.clearAll(state); setSearch(''); close(false); apply('filter'); var s = doc.getElementById(ids.search); if (s) s.focus(); },
  };
  win[o.api] = api;
  return api;
}

const LIST_TABLE_CSS = `
  .q-toolbar { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin:2px 0 10px; }
  .q-search { position:relative; }
  .q-search input { width:260px; max-width:70vw; padding:8px 12px 8px 32px; border:1px solid #e2e8f0; border-radius:9px; font:inherit; font-size:13px; color:var(--navy); background:#fff; }
  .q-search-note { font-size:12px; color:#64748b; }
  .q-search input:focus { outline:2px solid var(--st-focus); outline-offset:1px; border-color:var(--st-focus); }
  .q-search svg { position:absolute; left:10px; top:50%; transform:translateY(-50%); color:#94a3b8; pointer-events:none; }
  .q-chips { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:0 0 10px; }
  .q-chip { display:inline-flex; align-items:center; gap:4px; background:var(--st-blue-bg); color:var(--st-blue-fg); border:1px solid var(--st-blue-bg); border-radius:999px; padding:3px 4px 3px 11px; font-size:12px; font-weight:600; max-width:100%; }
  .q-chip button { border:none; background:transparent; color:var(--st-blue-fg); font-size:15px; line-height:1; width:22px; height:22px; border-radius:50%; cursor:pointer; }
  .q-chip button:hover, .q-chip button:focus-visible { background:white; outline:2px solid var(--st-blue-solid); outline-offset:-2px; }
  .q-chip-sort { background:#f8fafc; color:#334155; border-color:#e2e8f0; }
  .q-chip-sort button { color:#64748b; }
  .lt-tabs { display:flex; align-items:flex-end; flex-wrap:wrap; gap:2px; border-bottom:2px solid #e2e8f0; margin:0 0 12px; }   /* wraps on a phone, like the Consultations tabs: no tab is ever hidden */
  .lt-tab { appearance:none; background:none; border:0; border-bottom:3px solid transparent; margin-bottom:-2px; padding:9px 13px; font:inherit; font-size:13.5px; font-weight:700; color:var(--th-fg); cursor:pointer; white-space:nowrap; }
  .lt-tab:hover { color:var(--navy); background:var(--head-bg); border-radius:6px 6px 0 0; }
  .lt-tab.active { color:var(--navy); border-bottom-color:var(--navy); }
  @media (max-width: 760px) { .lt-tab { min-height:44px; } }   /* a finger-sized tab on a phone */
  .lt-tab:focus-visible { outline:2px solid var(--st-focus); outline-offset:-2px; border-radius:6px 6px 0 0; }
  /* a tab's count: a page may give a tab its status colour by setting --tn-bg / --tn-fg / --tn-solid on it (2026-11-10) */
  .lt-tab .lt-tab-n { display:inline-block; min-width:18px; padding:0 6px; border-radius:10px; background:var(--tn-bg, var(--st-grey-bg)); color:var(--tn-fg, var(--st-grey-fg)); font-size:11px; margin-left:4px; text-align:center; font-variant-numeric:tabular-nums; }
  .lt-tab.active .lt-tab-n { background:var(--tn-solid, var(--navy)); color:#fff; }
  .lt-tab.zero:not(.active) { font-weight:500; }   /* an empty tab: lighter, never fainter than 4.5:1 */
  .q-clearall { border:none; background:none; color:#64748b; font:inherit; font-size:12px; font-weight:700; cursor:pointer; padding:4px 6px; text-decoration:underline; }
  .q-clearall:hover { color:var(--navy); }
  .tbl-wrap { overflow-x:auto; }
  /* the header's hidden words (.sr-only) are position:absolute: without this they are placed against the page, at the wide table's far right,
     and the whole page scrolls sideways on a narrow screen (the same fix as the Client Master table; found by the 2026-11-10 width check) */
  .tbl-wrap { position:relative; }
  th .th-in { display:flex; align-items:center; gap:4px; white-space:nowrap; }
  th .th-sort { font-size:8px; color:var(--navy); }
  th .th-sortbtn { border:none; background:none; padding:2px 0; margin:0; font:inherit; color:inherit; letter-spacing:inherit; text-transform:inherit; cursor:pointer; border-radius:4px; }
  th .th-sortbtn:hover { color:var(--navy); text-decoration:underline; }
  th .th-sortbtn:focus-visible { outline:2px solid var(--st-focus); outline-offset:2px; }
  th .th-f { display:inline-flex; align-items:center; gap:2px; border:1px solid transparent; background:transparent; color:var(--st-grey-solid); border-radius:6px; padding:3px 4px; min-width:24px; min-height:24px; cursor:pointer; margin-left:2px; }
  th .th-f:hover, th .th-f:focus-visible, th .th-f.open { background:white; color:var(--navy); outline:none; }
  th .th-f:focus-visible { outline:2px solid var(--st-focus); outline-offset:1px; }
  th .th-f.on { color:var(--st-blue-fg); background:var(--st-blue-bg); border-color:var(--st-blue-solid); }
  th .th-n { font-size:10px; font-weight:800; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .lt-pop { display:none; position:fixed; z-index:400; flex-direction:column; background:#fff; border:1px solid #e2e8f0; border-radius:12px; box-shadow:0 14px 40px rgba(15,23,42,.18); font-size:13px; color:var(--navy); text-transform:none; letter-spacing:0; }
  .qp-h { display:flex; justify-content:space-between; align-items:center; padding:10px 12px 8px; font-weight:800; border-bottom:1px solid #f1f5f9; }
  .qp-x { border:none; background:none; font-size:18px; line-height:1; color:#94a3b8; cursor:pointer; width:28px; height:28px; border-radius:8px; }
  .qp-x:hover, .qp-x:focus-visible { background:#f1f5f9; color:var(--navy); outline:none; }
  .qp-b { overflow-y:auto; padding:4px 12px 8px; flex:1 1 auto; }
  .qp-sec { padding:8px 0; border-bottom:1px solid #f8fafc; }
  .qp-sec:last-child { border-bottom:none; }
  .qp-t { font-size:10.5px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; color:#64748b; margin:0 0 6px; }
  .qp-row { display:flex; align-items:center; gap:8px; padding:5px 4px; border-radius:6px; cursor:pointer; min-height:28px; }
  .qp-row:hover { background:#f8fafc; }
  .qp-row input { margin:0; width:15px; height:15px; flex:none; }
  .qp-row span:first-of-type { flex:1 1 auto; overflow-wrap:anywhere; }
  .qp-row.zero { color:#94a3b8; }
  .qp-c { font-size:11.5px; color:#94a3b8; font-variant-numeric:tabular-nums; }
  .qp-find { width:100%; box-sizing:border-box; padding:6px 9px; border:1px solid #e2e8f0; border-radius:8px; font:inherit; font-size:12.5px; margin:0 0 6px; }
  .qp-sort, .qp-presets { display:flex; flex-wrap:wrap; gap:6px; }
  .qp-btn { border:1px solid #e2e8f0; background:#fff; color:var(--navy); border-radius:999px; padding:5px 11px; font:inherit; font-size:12px; font-weight:600; cursor:pointer; min-height:28px; }
  .qp-btn:hover { border-color:var(--navy); }
  .qp-btn.on { background:var(--navy); border-color:var(--navy); color:#fff; }
  .qp-dates { display:flex; gap:8px; margin-top:10px; }
  .qp-dates label { flex:1; display:flex; flex-direction:column; gap:3px; font-size:11px; font-weight:700; color:#64748b; }
  .qp-dates input { padding:6px 8px; border:1px solid #e2e8f0; border-radius:8px; font:inherit; font-size:12.5px; color:var(--navy); min-width:0; }
  .qp-note { font-size:11.5px; color:#94a3b8; margin-top:6px; }
  .qp-f { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-top:1px solid #f1f5f9; }
  .qp-link { border:none; background:none; color:#64748b; font:inherit; font-size:12.5px; font-weight:700; cursor:pointer; padding:6px 4px; }
  .qp-link:hover { color:var(--navy); text-decoration:underline; }
  .qp-done { border:none; background:var(--navy); color:#fff; border-radius:8px; padding:7px 16px; font:inherit; font-size:12.5px; font-weight:700; cursor:pointer; }
  @media (prefers-reduced-motion: no-preference) { .lt-pop { animation:qpin .12s ease-out; } @keyframes qpin { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } } }
  /* Phones: the search box takes the whole row. */
  @media (max-width: 760px) { .q-toolbar .q-search, .q-toolbar .q-search input, .q-head .q-search, .q-head .q-search input { width:100%; max-width:none; } }
`;

/**
 * The browser script for one list: the core, the page's spec and options, then the UI.
 * specFn / optsFn are functions (injected with toString); ctxExpr is page JS handed to them
 * (e.g. "{ outcomes: RET_OUTCOMES, today: todayStr }").
 */
function listTableScript(specFn, optsFn, ctxExpr) {
  const ctx = ctxExpr || '{}';
  return `(function(){ var listCore = (${listCore.toString()}); var CTX = ${ctx};`
    + ` var LT = listCore((${specFn.toString()})(CTX)); (${listTableUi.toString()})(LT, (${optsFn.toString()})(CTX), window); })();`;
}

/** Sign Out forgets every list's saved filters (a search holds a client's name; front-desk PCs are shared). */
const LIST_STATE_KEYS_PREFIX = 'tdot_list_';

module.exports = { listCore, listTableUi, listTableScript, LIST_TABLE_CSS, LIST_STATE_KEYS_PREFIX };
