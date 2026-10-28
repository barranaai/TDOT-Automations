'use strict';

/**
 * Leads list — filters and sorting IN THE COLUMN HEADERS (Faran 2026-10-28:
 * "all the filters are so scattered … integrate the filters in the respective
 * header of the column professionally and intelligently").
 *
 * Every column header has a small filter button; it opens a panel for THAT
 * column: tick boxes with how many leads each choice would show (counted with
 * the other filters applied), a search box when the list is long, sorting where
 * it makes sense, quick date ranges on Received. Active filters show as chips
 * above the table with "Clear all". Choices are remembered while the tab is open
 * (going to a lead and back keeps them).
 *
 * Two parts, both plain browser JavaScript injected with Function#toString (no
 * template-literal escaping — the inline-script trap):
 *   leadsTableCore()  — pure: filter, facet counts, sort, date presets, chips.
 *                       Unit-tested in Node.
 *   leadsTableUi(LT)  — the header buttons, the panel, the chips, the search.
 * The page keeps its own renderRows(rows) (the row HTML); the UI calls it.
 */

/* eslint-disable no-var */
function leadsTableCore() {
  var NONE = '__none__';
  var CST_ORDER = ['new', 'invite-sending', 'invite-failed', 'invite', 'reminder1', 'reminder2', 'remark', 'abandoned', 'holding', 'paid', 'booked', 'expired', 'outcome'];
  var STATUS_TEXT = { 'new': 'New', 'invite-sending': 'Invite sending', 'invite-failed': 'Invite failed', 'invite': 'Invite sent', 'reminder1': '1st reminder sent',
    'reminder2': '2nd reminder sent', 'remark': 'A remark', 'abandoned': 'Booking not finished', 'holding': 'Booking in progress', 'paid': 'Paid / fee recorded',
    'booked': 'Booked', 'expired': 'Expired' };
  function s(v) { return String(v == null ? '' : v).trim(); }
  function cstKey(r) { var st = r.status || {}; if (!st.key) return ''; return st.key === 'outcome' ? 'outcome:' + s(st.label) : st.key; }
  function cstText(key) { return key.indexOf('outcome:') === 0 ? key.slice(8) : (STATUS_TEXT[key] || key); }

  // The tick-box filters: what each lead's value is ('' = the "none" choice).
  var FACETS = {
    service:  { label: 'Service', get: function (r) { return s(r.service); }, none: 'Not set' },
    source:   { label: 'How they reached us', get: function (r) { return s(r.source); }, none: 'No source' },
    owner:    { label: 'Owner', get: function (r) { return s(r.owner); }, none: 'No owner' },
    tier:     { label: 'Tier', get: function (r) { return s(r.tier); }, none: 'No tier' },
    priority: { label: 'Priority', get: function (r) { return s(r.priority); }, none: 'No priority', order: ['Critical', 'High', 'Medium', 'Low'] },
    booking:  { label: 'Booking', get: function (r) { return s(r.bookingStatus) || 'Not Yet'; }, order: ['Not Yet', 'Slot Held', 'Abandoned'] },
    invite:   { label: 'Invite', get: function (r) { return r.inviteSent ? 'Sent' : 'Not sent'; }, order: ['Sent', 'Not sent'] },
    status:   { label: 'Current status', get: cstKey, text: cstText, order: CST_ORDER, none: 'No status' },
  };
  function valueOf(f, r) { var v = FACETS[f].get(r); return v === '' ? NONE : v; }
  function labelOf(f, v) { if (v === NONE) return FACETS[f].none || 'None'; return FACETS[f].text ? FACETS[f].text(v) : v; }

  function emptyState() { return { q: '', urgent: false, from: '', to: '', sel: {}, sort: { key: 'received', dir: 'desc' } }; }
  /** A saved state, cleaned (anything unknown dropped). */
  function normalizeState(x) {
    var st = emptyState();
    if (!x || typeof x !== 'object') return st;
    st.q = s(x.q).slice(0, 100); st.urgent = x.urgent === true;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s(x.from))) st.from = s(x.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s(x.to))) st.to = s(x.to);
    var sel = x.sel || {};
    Object.keys(FACETS).forEach(function (f) { if (Array.isArray(sel[f]) && sel[f].length) st.sel[f] = sel[f].map(s).filter(Boolean).slice(0, 50); });
    if (x.sort && SORTS[x.sort.key]) st.sort = { key: x.sort.key, dir: x.sort.dir === 'asc' ? 'asc' : 'desc' };
    return st;
  }
  function range(st) { var a = s(st.from), b = s(st.to); return a && b && a > b ? [b, a] : [a, b]; }

  /** Does the lead pass every filter except `skip` (a facet name, 'received' or 'lead')? */
  function passes(r, st, skip) {
    if (skip !== 'lead') {
      var q = s(st.q).toLowerCase();
      if (q && s(r.name).toLowerCase().indexOf(q) < 0) return false;
      if (st.urgent && !r.urgent) return false;
    }
    if (skip !== 'received') {
      var ab = range(st), d = s(r.createdDay);
      if (ab[0] && !(d && d >= ab[0])) return false;
      if (ab[1] && !(d && d <= ab[1])) return false;
    }
    for (var f in st.sel) {
      if (f === skip || !FACETS[f]) continue;
      var set = st.sel[f];
      if (set && set.length && set.indexOf(valueOf(f, r)) < 0) return false;
    }
    return true;
  }
  function filterRows(rows, st) { return (rows || []).filter(function (r) { return passes(r, st, ''); }); }

  /** A facet's choices with how many leads each would show — counted with the OTHER filters applied. */
  function facetCounts(rows, st, f) {
    var counts = {};
    (rows || []).forEach(function (r) { if (passes(r, st, f)) { var v = valueOf(f, r); counts[v] = (counts[v] || 0) + 1; } });
    (st.sel[f] || []).forEach(function (v) { if (!(v in counts)) counts[v] = 0; });   // a ticked choice never disappears
    var order = FACETS[f].order;
    var rank = function (v) { if (v === NONE) return 1000; if (!order) return 0; var i = order.indexOf(v.split(':')[0]); return i < 0 ? 99 : i; };
    return Object.keys(counts).sort(function (a, b) { return (rank(a) - rank(b)) || labelOf(f, a).localeCompare(labelOf(f, b)); })
      .map(function (v) { return { value: v, label: labelOf(f, v), count: counts[v] }; });
  }

  var PRI = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  var SORTS = {
    received: function (r) { return s(r.createdAt) || s(r.createdDay); },
    name:     function (r) { return s(r.name).toLowerCase(); },
    status:   function (r) { return (r.status && r.status.at) || 0; },
    priority: function (r) { var p = PRI[s(r.priority)]; return p == null ? 9 : p; },
    tier:     function (r) { return s(r.tier) || '~'; },
  };
  function sortRows(rows, sort) {
    var key = sort && SORTS[sort.key] ? sort.key : 'received', dir = sort && sort.dir === 'asc' ? 1 : -1, get = SORTS[key];
    return (rows || []).map(function (r, i) { return { r: r, i: i, k: get(r) }; })
      .sort(function (a, b) { var c = a.k < b.k ? -1 : a.k > b.k ? 1 : 0; return (c * dir) || (a.i - b.i); })
      .map(function (o) { return o.r; });
  }

  function torontoToday(now) { return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); }
  function addDays(day, n) { var p = day.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)).toISOString().slice(0, 10); }
  /** Quick ranges on Received, in Toronto days. */
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

  /** The active filters as chips: [{ key, text }]. */
  function chips(st) {
    var out = [];
    if (s(st.q)) out.push({ key: 'q', text: 'Name contains “' + s(st.q) + '”' });
    if (st.urgent) out.push({ key: 'urgent', text: 'Urgent only' });
    var ab = range(st);
    if (ab[0] || ab[1]) out.push({ key: 'received', text: 'Received ' + (ab[0] && ab[1] ? (ab[0] === ab[1] ? shortDay(ab[0]) : shortDay(ab[0]) + ' – ' + shortDay(ab[1])) : ab[0] ? 'from ' + shortDay(ab[0]) : 'until ' + shortDay(ab[1])) });
    Object.keys(FACETS).forEach(function (f) {
      var set = st.sel[f];
      if (set && set.length) out.push({ key: f, text: FACETS[f].label + ': ' + set.map(function (v) { return labelOf(f, v); }).join(', ') });
    });
    return out;
  }
  function clearKey(st, key) {
    if (key === 'q') st.q = ''; else if (key === 'urgent') st.urgent = false;
    else if (key === 'received') { st.from = ''; st.to = ''; } else delete st.sel[key];
    return st;
  }

  return { NONE: NONE, FACETS: FACETS, CST_ORDER: CST_ORDER, cstKey: cstKey, emptyState: emptyState, normalizeState: normalizeState, passes: passes,
    filterRows: filterRows, facetCounts: facetCounts, sortRows: sortRows, presetRange: presetRange, chips: chips, clearKey: clearKey, range: range };
}

function leadsTableUi(LT, win) {
  var doc = win.document, KEY = 'tdot_leads_table_v1';
  var state = LT.emptyState();
  try { state = LT.normalizeState(JSON.parse(win.sessionStorage.getItem(KEY) || 'null')); } catch (e) { /* private window: defaults */ }
  var ROWS = [], openCol = null, openBtn = null;
  var FUNNEL = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M1.5 2.5h13l-5 6v4.2l-3 1.6V8.5z"/></svg>';
  // One entry per column, in table order. menu: what the header's panel offers.
  var COLS = [
    { id: 'lead', label: 'Lead', menu: 'lead', sort: 'name', sortText: ['A → Z', 'Z → A'], sortDirs: ['asc', 'desc'] },
    { id: 'service', label: 'Service', menu: 'facet', facets: ['service'] },
    { id: 'source', label: 'Source', title: 'How they reached us · who owns the lead', menu: 'facet', facets: ['source', 'owner'] },
    { id: 'received', label: 'Received', title: 'The day the lead arrived, Toronto time', menu: 'date', sort: 'received', sortText: ['Newest first', 'Oldest first'], sortDirs: ['desc', 'asc'] },
    { id: 'tier', label: 'Tier', menu: 'facet', facets: ['tier'], sort: 'tier', sortText: ['A → Z', 'Z → A'], sortDirs: ['asc', 'desc'] },
    { id: 'priority', label: 'Priority', menu: 'facet', facets: ['priority'], sort: 'priority', sortText: ['Most urgent first', 'Least urgent first'], sortDirs: ['asc', 'desc'] },
    { id: 'booking', label: 'Booking', menu: 'facet', facets: ['booking'] },
    { id: 'invite', label: 'Invite', menu: 'facet', facets: ['invite'] },
    { id: 'status', label: 'Current status', title: 'Where the lead is with us: invite, reminders, the latest remark, booked, expired, or the Outcome', menu: 'facet', facets: ['status'], sort: 'status', sortText: ['Latest first', 'Oldest first'], sortDirs: ['desc', 'asc'] },
    { id: 'del', label: '' },
  ];
  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function col(id) { for (var i = 0; i < COLS.length; i++) if (COLS[i].id === id) return COLS[i]; return null; }
  function save() { try { win.sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* not kept — fine */ } }
  function activeCount(c) {
    if (c.menu === 'lead') return state.urgent ? 1 : 0;
    if (c.menu === 'date') return (state.from || state.to) ? 1 : 0;
    return (c.facets || []).reduce(function (n, f) { return n + ((state.sel[f] && state.sel[f].length) ? 1 : 0); }, 0);
  }

  function renderHead() {
    var tr = doc.getElementById('q-headrow');
    tr.innerHTML = COLS.map(function (c) {
      if (!c.menu) return '<th scope="col"><span class="sr-only">Actions</span></th>';
      var n = activeCount(c), sorted = c.sort && state.sort.key === c.sort;
      var arrow = sorted ? '<span class="th-sort" aria-hidden="true">' + (state.sort.dir === 'asc' ? '▲' : '▼') + '</span>' : '';
      var ariaSort = sorted ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      return '<th scope="col"' + (c.sort ? ' aria-sort="' + ariaSort + '"' : '') + (c.title ? ' title="' + esc(c.title) + '"' : '') + '><div class="th-in">'
        + '<span class="th-l">' + esc(c.label) + '</span>' + arrow
        + '<button type="button" class="th-f' + (n ? ' on' : '') + (openCol === c.id ? ' open' : '') + '" data-col="' + c.id + '" aria-haspopup="dialog" aria-expanded="' + (openCol === c.id) + '"'
        + ' aria-label="Filter' + (c.sort ? ' and sort' : '') + ': ' + esc(c.label) + (n ? ' (' + n + ' active)' : '') + '">' + FUNNEL + (n ? '<span class="th-n">' + n + '</span>' : '') + '</button>'
        + '</div></th>';
    }).join('');
    Array.prototype.forEach.call(tr.querySelectorAll('.th-f'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); var id = b.getAttribute('data-col'); if (openCol === id) close(true); else open(id); };
    });
  }

  function renderChips(shown) {
    var box = doc.getElementById('q-chips'), list = LT.chips(state);
    doc.getElementById('q-count').textContent = '(' + shown + (shown !== ROWS.length ? ' of ' + ROWS.length : '') + ')';
    if (!list.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = list.map(function (c) {
      return '<span class="q-chip">' + esc(c.text) + '<button type="button" data-chip="' + esc(c.key) + '" aria-label="Remove filter: ' + esc(c.text) + '">×</button></span>';
    }).join('') + '<button type="button" class="q-clearall" id="q-clearall">Clear all</button>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-chip]'), function (b) {
      b.onclick = function () { LT.clearKey(state, b.getAttribute('data-chip')); if (b.getAttribute('data-chip') === 'q') doc.getElementById('q-search').value = ''; apply(); };
    });
    doc.getElementById('q-clearall').onclick = function () { var sort = state.sort; state = LT.emptyState(); state.sort = sort; doc.getElementById('q-search').value = ''; close(false); apply(); };
  }

  function apply() {
    var rows = LT.sortRows(LT.filterRows(ROWS, state), state.sort);
    win.renderRows(rows);
    renderHead();
    renderChips(rows.length);
    if (openCol) renderPanel();
    save();
  }

  // ── the panel ──
  function panelHtml(c) {
    var h = '<div class="qp-h"><span>' + esc(c.label) + '</span><button type="button" class="qp-x" data-act="close" aria-label="Close">×</button></div><div class="qp-b">';
    if (c.sort) {
      h += '<div class="qp-sec"><div class="qp-t">Sort</div><div class="qp-sort">' + c.sortDirs.map(function (d, i) {
        var on = state.sort.key === c.sort && state.sort.dir === d;
        return '<button type="button" class="qp-btn' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-sort="' + d + '">' + esc(c.sortText[i]) + '</button>';
      }).join('') + '</div></div>';
    }
    if (c.menu === 'lead') {
      h += '<div class="qp-sec"><label class="qp-row"><input type="checkbox" data-urgent="1"' + (state.urgent ? ' checked' : '') + '> <span>Urgent only</span>'
        + '<span class="qp-c">' + ROWS.filter(function (r) { return r.urgent && LT.passes(r, state, 'lead'); }).length + '</span></label>'
        + '<div class="qp-note">Search by name in the box above the table.</div></div>';
    }
    if (c.menu === 'date') {
      var ab = LT.range(state);
      h += '<div class="qp-sec"><div class="qp-t">Received</div><div class="qp-presets">'
        + [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month']].map(function (p) {
          var r = LT.presetRange(p[0], Date.now()), on = r.from === ab[0] && r.to === ab[1];
          return '<button type="button" class="qp-btn' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-preset="' + p[0] + '">' + p[1] + '</button>';
        }).join('') + '</div>'
        + '<div class="qp-dates"><label>From<input type="date" data-date="from" value="' + esc(state.from) + '"></label><label>To<input type="date" data-date="to" value="' + esc(state.to) + '"></label></div>'
        + '<div class="qp-note">Both days included, Toronto time.</div></div>';
    }
    (c.facets || []).forEach(function (f) {
      var opts = LT.facetCounts(ROWS, state, f), sel = state.sel[f] || [];
      h += '<div class="qp-sec" data-facet="' + f + '">' + ((c.facets.length > 1 || c.sort) ? '<div class="qp-t">' + esc(LT.FACETS[f].label) + '</div>' : '')
        + (opts.length > 8 ? '<input type="search" class="qp-find" data-find="' + f + '" placeholder="Find…" aria-label="Find a ' + esc(LT.FACETS[f].label) + '">' : '')
        + '<div class="qp-list">' + (opts.length ? opts.map(function (o) {
          var on = sel.indexOf(o.value) >= 0;
          return '<label class="qp-row' + (o.count ? '' : ' zero') + '" data-label="' + esc(o.label.toLowerCase()) + '"><input type="checkbox" data-f="' + f + '" value="' + esc(o.value) + '"' + (on ? ' checked' : '') + '> <span>' + esc(o.label) + '</span><span class="qp-c">' + o.count + '</span></label>';
        }).join('') : '<div class="qp-note">Nothing to choose from.</div>') + '</div></div>';
    });
    h += '</div><div class="qp-f"><button type="button" class="qp-link" data-act="clear">Clear</button><button type="button" class="qp-done" data-act="close">Done</button></div>';
    return h;
  }
  function renderPanel() {
    var p = doc.getElementById('q-pop'), c = col(openCol);
    if (!c) return;
    var focusKey = doc.activeElement && p.contains(doc.activeElement) ? focusId(doc.activeElement) : null;
    var finds = {}; Array.prototype.forEach.call(p.querySelectorAll('[data-find]'), function (i) { finds[i.getAttribute('data-find')] = i.value; });
    p.innerHTML = panelHtml(c);
    p.setAttribute('aria-label', 'Filter: ' + c.label);
    Object.keys(finds).forEach(function (f) { var i = p.querySelector('[data-find="' + f + '"]'); if (i) { i.value = finds[f]; filterList(i); } });
    wirePanel(p, c);
    if (focusKey) { var el = p.querySelector(focusKey); if (el) el.focus(); }
  }
  function focusId(el) {
    if (el.getAttribute('data-f')) return '[data-f="' + el.getAttribute('data-f') + '"][value="' + String(el.value).replace(/"/g, '\\"') + '"]';
    var attrs = ['data-find', 'data-date', 'data-sort', 'data-preset', 'data-urgent', 'data-act'];
    for (var i = 0; i < attrs.length; i++) if (el.getAttribute(attrs[i])) return '[' + attrs[i] + '="' + el.getAttribute(attrs[i]) + '"]';
    return null;
  }
  function filterList(input) {
    var q = input.value.toLowerCase().trim(), sec = input.parentNode;
    Array.prototype.forEach.call(sec.querySelectorAll('.qp-row'), function (r) { r.style.display = !q || r.getAttribute('data-label').indexOf(q) >= 0 ? '' : 'none'; });
  }
  function wirePanel(p, c) {
    Array.prototype.forEach.call(p.querySelectorAll('[data-act="close"]'), function (b) { b.onclick = function () { close(true); }; });
    var clr = p.querySelector('[data-act="clear"]');
    if (clr) clr.onclick = function () {
      if (c.menu === 'lead') state.urgent = false;
      if (c.menu === 'date') { state.from = ''; state.to = ''; }
      (c.facets || []).forEach(function (f) { delete state.sel[f]; });
      apply();
    };
    Array.prototype.forEach.call(p.querySelectorAll('[data-sort]'), function (b) { b.onclick = function () { state.sort = { key: c.sort, dir: b.getAttribute('data-sort') }; apply(); }; });
    Array.prototype.forEach.call(p.querySelectorAll('[data-preset]'), function (b) { b.onclick = function () { var r = LT.presetRange(b.getAttribute('data-preset'), Date.now()); state.from = r.from; state.to = r.to; apply(); }; });
    Array.prototype.forEach.call(p.querySelectorAll('[data-date]'), function (i) { i.onchange = function () { state[i.getAttribute('data-date')] = i.value || ''; apply(); }; });
    var u = p.querySelector('[data-urgent]'); if (u) u.onchange = function () { state.urgent = u.checked; apply(); };
    Array.prototype.forEach.call(p.querySelectorAll('[data-f]'), function (i) {
      i.onchange = function () {
        var f = i.getAttribute('data-f'), set = (state.sel[f] || []).slice(), at = set.indexOf(i.value);
        if (i.checked && at < 0) set.push(i.value); if (!i.checked && at >= 0) set.splice(at, 1);
        if (set.length) state.sel[f] = set; else delete state.sel[f];
        apply();
      };
    });
    Array.prototype.forEach.call(p.querySelectorAll('[data-find]'), function (i) { i.oninput = function () { filterList(i); }; });
  }
  function place() {
    var p = doc.getElementById('q-pop');
    if (!openBtn || !openBtn.isConnected) { var b = doc.querySelector('.th-f[data-col="' + openCol + '"]'); if (b) openBtn = b; }
    if (!openBtn) return;
    var r = openBtn.getBoundingClientRect(), w = Math.min(300, win.innerWidth - 24);
    p.style.width = w + 'px';
    p.style.left = Math.max(12, Math.min(r.right - w, win.innerWidth - w - 12)) + 'px';
    p.style.top = (r.bottom + 6) + 'px';
    p.style.maxHeight = Math.max(200, win.innerHeight - r.bottom - 18) + 'px';
  }
  function open(id) {
    openCol = id; renderHead();
    openBtn = doc.querySelector('.th-f[data-col="' + id + '"]');
    var p = doc.getElementById('q-pop');
    p.style.display = 'flex';
    renderPanel(); place();
    var first = p.querySelector('.qp-b input, .qp-b button'); if (first) first.focus();
  }
  function close(refocus) {
    if (!openCol) return;
    var id = openCol; openCol = null;
    doc.getElementById('q-pop').style.display = 'none';
    renderHead();
    if (refocus) { var b = doc.querySelector('.th-f[data-col="' + id + '"]'); if (b) b.focus(); }
    openBtn = null;
  }
  doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openCol) { e.preventDefault(); close(true); } });
  doc.addEventListener('mousedown', function (e) {
    if (!openCol) return;
    var p = doc.getElementById('q-pop');
    if (p.contains(e.target) || (e.target.closest && e.target.closest('.th-f'))) return;
    close(false);
  });
  win.addEventListener('resize', function () { if (openCol) place(); });
  win.addEventListener('scroll', function () { if (openCol) place(); }, true);

  var search = doc.getElementById('q-search');
  search.value = state.q;
  search.addEventListener('input', function () { state.q = search.value; apply(); });

  win.LeadsTable = { setRows: function (rows) { ROWS = rows || []; apply(); }, state: function () { return state; } };
}

const LEADS_TABLE_CSS = `
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
  .tbl-wrap table { min-width:980px; }
  th .th-in { display:flex; align-items:center; gap:4px; white-space:nowrap; }
  th .th-sort { font-size:8px; color:var(--navy); }
  th .th-f { display:inline-flex; align-items:center; gap:2px; border:1px solid transparent; background:transparent; color:#94a3b8; border-radius:6px; padding:3px 4px; min-width:24px; min-height:24px; cursor:pointer; margin-left:2px; }
  th .th-f:hover, th .th-f:focus-visible, th .th-f.open { background:#eef2f7; color:var(--navy); outline:none; }
  th .th-f.on { color:#4f46e5; background:#eef2ff; border-color:#e0e7ff; }
  th .th-n { font-size:10px; font-weight:800; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  #q-pop { display:none; position:fixed; z-index:400; flex-direction:column; background:#fff; border:1px solid #e2e8f0; border-radius:12px; box-shadow:0 14px 40px rgba(15,23,42,.18); font-size:13px; color:var(--navy); text-transform:none; letter-spacing:0; }
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
  @media (prefers-reduced-motion: no-preference) { #q-pop { animation:qpin .12s ease-out; } @keyframes qpin { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } } }
`;

/** The browser script: the core, then the UI wired to the page. */
function leadsTableScript() {
  return `(function(){ var LT = (${leadsTableCore.toString()})(); (${leadsTableUi.toString()})(LT, window); })();`;
}

module.exports = { leadsTableCore, leadsTableScript, LEADS_TABLE_CSS };
