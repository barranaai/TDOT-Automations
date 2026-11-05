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
 * spec: { facets: { key: { label, get(r) -> string | string[], none, order, text(v), fixed (always list every order value), quick } },
 *         sorts: { key: get(r) }, defaultSort: { key, dir } | null (null = keep the server order),
 *         search: { text(r) -> string | string[], chip }, flags: { key: { chip, test(r) } },
 *         date: { key, chip, get(r) -> 'YYYY-MM-DD' } | null }
 */

/* eslint-disable no-var */
function listCore(spec) {
  var NONE = '__none__';
  var FACETS = spec.facets || {}, SORTS = spec.sorts || {}, FLAGS = spec.flags || {}, DATE = spec.date || null, SEARCH = spec.search || null;
  var DEFAULT_SORT = spec.defaultSort || null;
  function s(v) { return String(v == null ? '' : v).trim(); }
  /** A row's value(s) for a facet; '' = the "none" choice. A facet may give several (a case's managers). */
  function valuesOf(f, r) {
    var v = FACETS[f].get(r);
    if (Array.isArray(v)) { var out = v.map(s).filter(Boolean); return out.length ? out : [NONE]; }
    v = s(v); return [v === '' ? NONE : v];
  }
  function labelOf(f, v) { if (v === NONE) return FACETS[f].none || 'None'; return FACETS[f].text ? FACETS[f].text(v) : v; }

  function emptyState() {
    var st = { q: '', from: '', to: '', sel: {}, sort: DEFAULT_SORT ? { key: DEFAULT_SORT.key, dir: DEFAULT_SORT.dir } : null };
    Object.keys(FLAGS).forEach(function (k) { st[k] = false; });
    return st;
  }
  /** A saved state, cleaned (anything unknown dropped). */
  function normalizeState(x) {
    var st = emptyState();
    if (!x || typeof x !== 'object') return st;
    st.q = s(x.q).slice(0, 100);
    Object.keys(FLAGS).forEach(function (k) { st[k] = x[k] === true; });
    if (DATE) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(s(x.from))) st.from = s(x.from);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s(x.to))) st.to = s(x.to);
    }
    var sel = x.sel || {};
    Object.keys(FACETS).forEach(function (f) { if (Array.isArray(sel[f]) && sel[f].length) st.sel[f] = sel[f].map(s).filter(Boolean).slice(0, 50); });
    if (x.sort && SORTS[x.sort.key]) st.sort = { key: x.sort.key, dir: x.sort.dir === 'asc' ? 'asc' : 'desc' };
    return st;
  }
  function range(st) { var a = s(st.from), b = s(st.to); return a && b && a > b ? [b, a] : [a, b]; }

  /** Does the row pass every filter except `skip` (a facet key, a flag key, or 'date')? */
  function passes(r, st, skip) {
    if (SEARCH) {
      var q = s(st.q).toLowerCase();
      if (q) {
        var t = SEARCH.text(r), list = Array.isArray(t) ? t : [t];
        if (!list.some(function (x) { return s(x).toLowerCase().indexOf(q) >= 0; })) return false;
      }
    }
    for (var k in FLAGS) { if (k !== skip && st[k] && !FLAGS[k].test(r)) return false; }
    if (DATE && skip !== 'date') {
      var ab = range(st), d = s(DATE.get(r));
      if (ab[0] && !(d && d >= ab[0])) return false;
      if (ab[1] && !(d && d <= ab[1])) return false;
    }
    for (var f in st.sel) {
      if (f === skip || !FACETS[f]) continue;
      var set = st.sel[f];
      if (set && set.length && !valuesOf(f, r).some(function (v) { return set.indexOf(v) >= 0; })) return false;
    }
    return true;
  }
  function filterRows(rows, st) { return (rows || []).filter(function (r) { return passes(r, st, ''); }); }

  /** A facet's choices with how many rows each would show — counted with the OTHER filters applied. */
  function facetCounts(rows, st, f) {
    var counts = {};
    (rows || []).forEach(function (r) { if (passes(r, st, f)) valuesOf(f, r).forEach(function (v) { counts[v] = (counts[v] || 0) + 1; }); });
    (st.sel[f] || []).forEach(function (v) { if (!(v in counts)) counts[v] = 0; });   // a ticked choice never disappears
    var order = FACETS[f].order;
    if (FACETS[f].fixed && order) order.forEach(function (v) { if (!(v in counts)) counts[v] = 0; });   // a short fixed list shows every choice, like the old drop-down
    var rank = function (v) { if (v === NONE) return 1000; if (!order) return 0; var i = order.indexOf(v.split(':')[0]); return i < 0 ? 99 : i; };
    return Object.keys(counts).sort(function (a, b) { return (rank(a) - rank(b)) || labelOf(f, a).localeCompare(labelOf(f, b)); })
      .map(function (v) { return { value: v, label: labelOf(f, v), count: counts[v] }; });
  }

  /** Sorted by the chosen column; an unknown column falls back to the list's default; no sort at all = the server order. Ties keep the server order. */
  function sortRows(rows, sort) {
    var key = sort && SORTS[sort.key] ? sort.key : (DEFAULT_SORT ? DEFAULT_SORT.key : null);
    if (!key) return (rows || []).slice();
    var dir = sort ? (sort.dir === 'asc' ? 1 : -1) : (DEFAULT_SORT.dir === 'asc' ? 1 : -1), get = SORTS[key];
    return (rows || []).map(function (r, i) { return { r: r, i: i, k: get(r) }; })
      .sort(function (a, b) { var c = a.k < b.k ? -1 : a.k > b.k ? 1 : 0; return (c * dir) || (a.i - b.i); })
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
    else if (DATE && key === DATE.key) { st.from = ''; st.to = ''; } else delete st.sel[key];
    return st;
  }
  /** "Clear filters": every chip filter off; the sort and the quick buttons stay. */
  function clearAll(st) {
    var next = emptyState();
    next.sort = st.sort;
    Object.keys(FACETS).forEach(function (f) { if (FACETS[f].quick && st.sel[f]) next.sel[f] = st.sel[f].slice(); });
    return next;
  }

  return { NONE: NONE, FACETS: FACETS, FLAGS: FLAGS, DATE: DATE, emptyState: emptyState, normalizeState: normalizeState, passes: passes,
    filterRows: filterRows, facetCounts: facetCounts, sortRows: sortRows, presetRange: presetRange, chips: chips, clearKey: clearKey, clearAll: clearAll, range: range,
    valuesOf: valuesOf, labelOf: labelOf };
}

/**
 * o: { key: sessionStorage key, ids: { head, chips, count, search, pop }, cols: [...], render: window function name,
 *      api: window name for { setRows, state, apply }, initial(state) (e.g. a link's choice), onChange(state) (a person changed something),
 *      quick: { facet, box, label, all, values: [...], hints: {} } (buttons above the table), countText(shown, total) }
 * A column: { id, label, title, menu, facets: [...], flags: [...], date: true, note, sort, sortText: [..], sortDirs: [first, second] }
 */
function listTableUi(LT, o, win) {
  var doc = win.document, KEY = o.key, ids = o.ids, COLS = o.cols;
  var state = LT.emptyState();
  try { state = LT.normalizeState(JSON.parse(win.sessionStorage.getItem(KEY) || 'null')); } catch (e) { /* private window: defaults */ }
  if (o.initial) { try { o.initial(state); } catch (e) { /* a bad link: defaults */ } }
  var ROWS = [], openCol = null, openBtn = null;
  var FUNNEL = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M1.5 2.5h13l-5 6v4.2l-3 1.6V8.5z"/></svg>';
  var pop = doc.getElementById(ids.pop);
  if (!pop) { pop = doc.createElement('div'); pop.id = ids.pop; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'false'); doc.body.appendChild(pop); }
  pop.classList.add('lt-pop');
  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function col(id) { for (var i = 0; i < COLS.length; i++) if (COLS[i].id === id) return COLS[i]; return null; }
  function save() { try { win.sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* not kept — fine */ } }
  function hasPanel(c) { return !!((c.facets && c.facets.length) || (c.flags && c.flags.length) || c.date); }
  function activeCount(c) {
    var n = 0;
    (c.flags || []).forEach(function (k) { if (state[k]) n++; });
    if (c.date && (state.from || state.to)) n++;
    (c.facets || []).forEach(function (f) { if (state.sel[f] && state.sel[f].length) n++; });
    return n;
  }
  function sortedBy(c) { return c.sort && state.sort && state.sort.key === c.sort; }

  function renderHead() {
    var tr = doc.getElementById(ids.head);
    if (!tr) return;
    var focusSort = doc.activeElement && tr.contains(doc.activeElement) && doc.activeElement.getAttribute('data-sortcol');
    tr.innerHTML = COLS.map(function (c) {
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
          + ' aria-label="Filter' + (c.sort ? ' and sort' : '') + ': ' + esc(c.label) + (n ? ' (' + n + ' active)' : '') + '">' + FUNNEL + (n ? '<span class="th-n">' + n + '</span>' : '') + '</button>' : '')
        + '</div></th>';
    }).join('');
    Array.prototype.forEach.call(tr.querySelectorAll('.th-f'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); var id = b.getAttribute('data-col'); if (openCol === id) close(true); else open(id); };
    });
    Array.prototype.forEach.call(tr.querySelectorAll('[data-sortcol]'), function (b) {
      b.onclick = function () {
        var c = col(b.getAttribute('data-sortcol')), dirs = c.sortDirs || ['asc', 'desc'];
        var dir = sortedBy(c) ? (state.sort.dir === dirs[0] ? dirs[1] : dirs[0]) : dirs[0];   // first click: the column's natural order; again: the other way
        state.sort = { key: c.sort, dir: dir }; apply('sort');
      };
    });
    if (focusSort) { var again = tr.querySelector('[data-sortcol="' + focusSort + '"]'); if (again) again.focus(); }   // keyboard: stay on the column
  }

  function countText(shown, total) { return o.countText ? o.countText(shown, total) : '(' + shown + (shown !== total ? ' of ' + total : '') + ')'; }
  function renderChips(shown, total) {
    var box = doc.getElementById(ids.chips), list = LT.chips(state), cnt = doc.getElementById(ids.count);
    if (cnt) cnt.textContent = countText(shown, total);
    if (!box) return;
    if (!list.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = list.map(function (c) {
      return '<span class="q-chip">' + esc(c.text) + '<button type="button" data-chip="' + esc(c.key) + '" aria-label="Remove filter: ' + esc(c.text) + '">×</button></span>';
    }).join('') + '<button type="button" class="q-clearall" data-clearall="1">Clear filters</button>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-chip]'), function (b) {
      b.onclick = function () { LT.clearKey(state, b.getAttribute('data-chip')); if (b.getAttribute('data-chip') === 'q') setSearch(''); apply('filter'); };
    });
    box.querySelector('[data-clearall]').onclick = function () { state = LT.clearAll(state); setSearch(''); close(false); apply('filter'); var s = doc.getElementById(ids.search); if (s) s.focus(); };
  }

  /* Buttons above the table for one facet (Retainers: the outcomes) — counts from the other filters; none on = all. */
  function renderQuick() {
    var q = o.quick; if (!q) return;
    var box = doc.getElementById(q.box); if (!box) return;
    var counts = {}; LT.facetCounts(ROWS, state, q.facet).forEach(function (x) { counts[x.value] = x.count; });
    var base = ROWS.filter(function (r) { return LT.passes(r, state, q.facet); }).length, sel = state.sel[q.facet] || [];
    var focusV = doc.activeElement && box.contains(doc.activeElement) ? doc.activeElement.getAttribute('data-quick') : null;
    function btn(v, label, count, on) { return '<button type="button" data-quick="' + esc(v) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (count ? '' : ' class="zero"') + (q.hints && q.hints[v] ? ' title="' + esc(q.hints[v]) + '"' : '') + '>' + esc(label) + ' <span class="qn">' + count + '</span></button>'; }
    box.innerHTML = (q.label ? '<span class="ql">' + esc(q.label) + '</span>' : '') + btn('', q.all || 'All', base, !sel.length)
      + q.values.map(function (v) { return btn(v, v, counts[v] || 0, sel.indexOf(v) >= 0); }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('button[data-quick]'), function (b) {
      b.onclick = function () {
        var v = b.getAttribute('data-quick'), next = (state.sel[q.facet] || []).slice();
        if (!v) next = []; else { var i = next.indexOf(v); if (i >= 0) next.splice(i, 1); else next.push(v); }
        if (next.length) state.sel[q.facet] = next; else delete state.sel[q.facet];
        apply('filter');
      };
      if (focusV !== null && b.getAttribute('data-quick') === focusV) b.focus();
    });
  }

  var started = false;
  function apply(why) {
    var rows = LT.sortRows(LT.filterRows(ROWS, state), state.sort);
    /* h.without(f): how many rows pass every filter except f (an empty list can say why it is empty) */
    var h = { total: ROWS.length, without: function (f) { return ROWS.filter(function (r) { return LT.passes(r, state, f); }).length; } };
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
          + '<span class="qp-c">' + ROWS.filter(function (r) { return LT.FLAGS[k].test(r) && LT.passes(r, state, k); }).length + '</span></label>';
      }).join('') + (c.note ? '<div class="qp-note">' + esc(c.note) + '</div>' : '') + '</div>';
    }
    if (c.date) {
      var ab = LT.range(state);
      h += '<div class="qp-sec"><div class="qp-t">' + esc(LT.DATE.chip) + '</div><div class="qp-presets">'
        + [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month']].map(function (p) {
          var r = LT.presetRange(p[0], Date.now()), on = r.from === ab[0] && r.to === ab[1];
          return '<button type="button" class="qp-btn' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-preset="' + p[0] + '">' + p[1] + '</button>';
        }).join('') + '</div>'
        + '<div class="qp-dates"><label>From<input type="date" data-date="from" value="' + esc(state.from) + '"></label><label>To<input type="date" data-date="to" value="' + esc(state.to) + '"></label></div>'
        + '<div class="qp-note">Both days included, Toronto time.</div></div>';
    }
    (c.facets || []).forEach(function (f) {
      var opts = LT.facetCounts(ROWS, state, f), sel = state.sel[f] || [];
      h += '<div class="qp-sec" data-facet="' + f + '">' + ((c.facets.length > 1 || c.sort || (c.flags && c.flags.length)) ? '<div class="qp-t">' + esc(LT.FACETS[f].label) + '</div>' : '')
        + (opts.length > 8 ? '<input type="search" class="qp-find" data-find="' + f + '" placeholder="Find…" aria-label="Find a ' + esc(LT.FACETS[f].label) + '">' : '')
        + '<div class="qp-list">' + (opts.length ? opts.map(function (x) {
          var on = sel.indexOf(x.value) >= 0;
          return '<label class="qp-row' + (x.count ? '' : ' zero') + '" data-label="' + esc(x.label.toLowerCase()) + '"><input type="checkbox" data-f="' + f + '" value="' + esc(x.value) + '"' + (on ? ' checked' : '') + '> <span>' + esc(x.label) + '</span><span class="qp-c">' + x.count + '</span></label>';
        }).join('') : '<div class="qp-note">Nothing to choose from.</div>') + '</div></div>';
    });
    if (c.note && !(c.flags && c.flags.length)) h += '<div class="qp-sec"><div class="qp-note">' + esc(c.note) + '</div></div>';
    h += '</div><div class="qp-f"><button type="button" class="qp-link" data-act="clear">Clear</button><button type="button" class="qp-done" data-act="close">Done</button></div>';
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
      if (c.date) { state.from = ''; state.to = ''; }
      (c.facets || []).forEach(function (f) { delete state.sel[f]; });
      apply('filter');
    };
    Array.prototype.forEach.call(pop.querySelectorAll('[data-sort]'), function (b) { b.onclick = function () { state.sort = { key: c.sort, dir: b.getAttribute('data-sort') }; apply('sort'); }; });
    Array.prototype.forEach.call(pop.querySelectorAll('[data-preset]'), function (b) { b.onclick = function () { var r = LT.presetRange(b.getAttribute('data-preset'), Date.now()); state.from = r.from; state.to = r.to; apply('filter'); }; });
    Array.prototype.forEach.call(pop.querySelectorAll('[data-date]'), function (i) { i.onchange = function () { state[i.getAttribute('data-date')] = i.value || ''; apply('filter'); }; });
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
  doc.addEventListener('mousedown', function (e) {
    if (!openCol) return;
    if (pop.contains(e.target) || (e.target.closest && e.target.closest('.th-f'))) return;
    close(false);
  });
  win.addEventListener('resize', function () { if (openCol) place(); });
  win.addEventListener('scroll', function () { if (openCol) place(); }, true);

  var search = doc.getElementById(ids.search);
  function setSearch(v) { if (search) search.value = v; }
  if (search) { search.value = state.q; search.addEventListener('input', function () { state.q = search.value; apply('filter'); }); }

  var api = {
    /** New rows from the server: the filters, the sort and the page stay as they are. */
    setRows: function (rows) { ROWS = rows || []; apply('data'); started = true; },
    state: function () { return state; },
    apply: function (why) { apply(why || 'filter'); },
    close: function () { close(false); },
  };
  win[o.api] = api;
  return api;
}

const LIST_TABLE_CSS = `
  .q-toolbar { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin:2px 0 10px; }
  .q-search { position:relative; }
  .q-search input { width:260px; max-width:70vw; padding:8px 12px 8px 32px; border:1px solid #e2e8f0; border-radius:9px; font:inherit; font-size:13px; color:var(--navy); background:#fff; }
  .q-search input:focus { outline:2px solid #bfdbfe; border-color:#93c5fd; }
  .q-search svg { position:absolute; left:10px; top:50%; transform:translateY(-50%); color:#94a3b8; pointer-events:none; }
  .q-chips { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:0 0 10px; }
  .q-chip { display:inline-flex; align-items:center; gap:4px; background:#eef2ff; color:#3730a3; border:1px solid #e0e7ff; border-radius:999px; padding:3px 4px 3px 11px; font-size:12px; font-weight:600; max-width:100%; }
  .q-chip button { border:none; background:transparent; color:#4f46e5; font-size:15px; line-height:1; width:22px; height:22px; border-radius:50%; cursor:pointer; }
  .q-chip button:hover, .q-chip button:focus-visible { background:#e0e7ff; outline:none; }
  .q-clearall { border:none; background:none; color:#64748b; font:inherit; font-size:12px; font-weight:700; cursor:pointer; padding:4px 6px; text-decoration:underline; }
  .q-clearall:hover { color:var(--navy); }
  .tbl-wrap { overflow-x:auto; }
  th .th-in { display:flex; align-items:center; gap:4px; white-space:nowrap; }
  th .th-sort { font-size:8px; color:var(--navy); }
  th .th-sortbtn { border:none; background:none; padding:2px 0; margin:0; font:inherit; color:inherit; letter-spacing:inherit; text-transform:inherit; cursor:pointer; border-radius:4px; }
  th .th-sortbtn:hover { color:var(--navy); text-decoration:underline; }
  th .th-sortbtn:focus-visible { outline:2px solid #93c5fd; outline-offset:2px; }
  th .th-f { display:inline-flex; align-items:center; gap:2px; border:1px solid transparent; background:transparent; color:#94a3b8; border-radius:6px; padding:3px 4px; min-width:24px; min-height:24px; cursor:pointer; margin-left:2px; }
  th .th-f:hover, th .th-f:focus-visible, th .th-f.open { background:#eef2f7; color:var(--navy); outline:none; }
  th .th-f.on { color:#4f46e5; background:#eef2ff; border-color:#e0e7ff; }
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
