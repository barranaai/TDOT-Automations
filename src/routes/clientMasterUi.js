'use strict';

/**
 * The Client Master page's tabs (block 3): the group headings, Monday's order
 * inside a view, the counts above the table, and which groups are open. Pure helpers, no DOM.
 *
 * Plain browser JavaScript injected with Function#toString (like listCore): the
 * function below refers to nothing outside itself. Node requires this file for the
 * tests.
 *
 * Everything here works on the rows the shared filter engine already chose (after
 * RBAC on the server, the tab and any search or filter): it never adds, removes or
 * moves a row between groups — it only splits and counts.
 *
 * A view (from clientMasterViews.pageViews()): { key, label, by: 'stage' | 'phase' |
 * 'board', dir: 'ASC' | 'DESC', groupOrder: 'position' | 'index' | 'alpha',
 * sort: { field, dir } | null }.
 * meta (from the board read; may be null): { groups: [{ id, title, position }] sorted
 * by position, stageOrder: [label index…], phaseOrder: [label index…], stageLabels, phaseLabels }.
 */

/* eslint-disable no-var */
function clientMasterUi(W) {
  var EMPTY = 5;   // Monday: an empty status cell = label index 5
  function s(v) { return String(v == null ? '' : v).trim(); }
  function idx(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v ? v : EMPTY; }

  /** A row's heading key in a view: the stage index, the phase index, or the board group id. */
  function keyOf(view, r) {
    if (view.by === 'stage') return idx(r.stageIdx);
    if (view.by === 'phase') return idx(r.phaseIdx);
    return s(r.groupId);
  }
  /** A heading's title, from the rows (the status text / group title); the board labels only when a row has none. */
  function titleOf(view, r, meta) {
    var t = '';
    if (view.by === 'stage') t = idx(r.stageIdx) === EMPTY ? '' : s(r.caseStage);
    else if (view.by === 'phase') t = s(r.phase);
    else t = s(r.groupTitle);
    if (t && t !== 'Unknown') return t;
    var labels = meta && (view.by === 'stage' ? meta.stageLabels : view.by === 'phase' ? meta.phaseLabels : null);
    var k = keyOf(view, r);
    if (labels && labels[k]) return s(labels[k]);
    if (view.by === 'board') { var g = groupMeta(meta, k); if (g && g.title) return s(g.title); }
    return '—';   // an empty stage / phase / group, as Monday shows a blank
  }
  function groupMeta(meta, id) {
    var list = (meta && meta.groups) || [];
    for (var i = 0; i < list.length; i++) if (s(list[i].id) === id) return list[i];
    return null;
  }
  /** The rank of a heading key (lower first); null = not in the board's meta (it goes last, never dropped). */
  function rankOf(view, key, meta) {
    var mode = view.groupOrder || 'position';
    if (view.by === 'board') {
      var list = (meta && meta.groups) || [];
      for (var i = 0; i < list.length; i++) if (s(list[i].id) === key) return i;   // meta.groups comes sorted by position (as numbers)
      return null;
    }
    if (mode === 'index') return key;
    var order = meta && (view.by === 'stage' ? meta.stageOrder : meta.phaseOrder);
    if (!order || !order.length) return key;     // no meta: label-index order (the fallback)
    var at = order.indexOf(key);
    return at < 0 ? null : at;
  }
  /**
   * The rows split into headings: [{ key, title, rows }] — a STABLE split (each heading keeps the rows' order).
   * Heading order: the view's groupOrder ('position': Monday's label / group order from meta; 'index'; 'alpha'),
   * reversed for DESC; a key the meta does not know goes last (in board order: its first row's boardIdx, then the
   * order first seen), never dropped — so a failed meta read keeps board order even with a column sort chosen.
   */
  function groupRows(view, rows, meta) {
    var groups = [], byKey = {};
    (rows || []).forEach(function (r) {
      var k = keyOf(view, r), id = typeof k + ':' + k;
      var g = byKey[id];
      if (!g) { g = byKey[id] = { key: k, title: titleOf(view, r, meta), rows: [], seen: groups.length, minIdx: Infinity }; groups.push(g); }
      if (typeof r.boardIdx === 'number' && r.boardIdx < g.minIdx) g.minIdx = r.boardIdx;
      g.rows.push(r);
    });
    var alpha = view.groupOrder === 'alpha';
    var desc = view.dir === 'DESC';
    groups.forEach(function (g) { g.rank = alpha ? null : rankOf(view, g.key, meta); });
    groups.sort(function (a, b) {
      var ua = !alpha && a.rank === null, ub = !alpha && b.rank === null;
      if (ua !== ub) return ua ? 1 : -1;                 // unknown keys last, whatever the direction
      if (ua && ub) return (a.minIdx === b.minIdx ? 0 : a.minIdx < b.minIdx ? -1 : 1) || (a.seen - b.seen);   // board order, whatever the column sort
      var c = alpha ? a.title.toLowerCase().localeCompare(b.title.toLowerCase()) : a.rank - b.rank;
      if (desc) c = -c;
      return c || (a.seen - b.seen);
    });
    return groups.map(function (g) { return { key: g.key, title: g.title, rows: g.rows }; });
  }
  function blank(v) { return v == null || s(v) === ''; }
  function boardCmp(a, b) {
    var x = a.r.boardIdx, y = b.r.boardIdx, nx = typeof x !== 'number', ny = typeof y !== 'number';
    if (nx !== ny) return nx ? 1 : -1;
    return (nx ? 0 : x - y) || (a.i - b.i);
  }
  /**
   * Monday's order for a view, used when no column sort is chosen: board order (boardIdx) — or, for a view with a
   * sort (none today; the old Mahesh tab: Actual Deadline ascending), that date with blanks LAST in either direction, ties in board order.
   */
  function viewOrder(view, rows) {
    var list = (rows || []).map(function (r, i) { return { r: r, i: i }; });
    var srt = view && view.sort;
    list.sort(function (a, b) {
      if (srt) {
        var av = s(a.r[srt.field]), bv = s(b.r[srt.field]), ab = blank(av), bb = blank(bv);
        if (ab !== bb) return ab ? 1 : -1;
        if (!ab && av !== bv) return (av < bv ? -1 : 1) * (srt.dir === 'DESC' ? -1 : 1);
      }
      return boardCmp(a, b);
    });
    return list.map(function (o) { return o.r; });
  }

  /** Nobody in Case Support Officer: no person and no team. */
  function noOfficer(r) {
    var o = (r && r.officerIds) || {};
    return !((o.personIds && o.personIds.length) || (o.teamIds && o.teamIds.length));
  }
  /** Assigning's line: how many rows have no Support Officer, and how many of them are Pre-Onboarding. */
  function noOfficerCount(rows, preOnboardingIdx) {
    var n = 0, pre = 0;
    (rows || []).forEach(function (r) { if (noOfficer(r)) { n++; if (idx(r.stageIdx) === preOnboardingIdx) pre++; } });
    return { n: n, preOnboarding: pre };
  }
  /* The "Waiting for" codes on a Pre-Onboarding row (from the server: preOnboardingWaiting), in the order of the process. */
  var WAIT_CODES = ['not-sent', 'client-sign', 'countersign', 'payment', 'ready', 'unclear', 'unchecked'];
  var WAIT_PILL = { 'not-sent': 'No agreement on record', 'client-sign': 'Client signature', 'countersign': 'Our countersignature',
    'payment': 'Payment', 'ready': 'Ready — should have started', 'unclear': 'Not clear', 'unchecked': 'Not checked yet' };
  var WAIT_STEP = { 'client-sign': 'client signature', 'countersign': 'our countersignature', 'payment': 'payment' };
  function waitCode(w) { var c = s(w && w.code); return WAIT_PILL[c] ? c : 'unclear'; }   // a code this page does not know is never guessed at
  /**
   * The words for one row's "Waiting for" value { code, also, partPaid, why }:
   * { code, lead, label, then, extra, tip } — lead + label is the first line ("Waiting for: client signature"),
   * then = what comes after it ("then payment"), extra = the part-payment words, tip = the full sentence.
   */
  function waitingWords(w) {
    var code = waitCode(w), also = [];
    if (code === 'not-sent') also.push(WAIT_STEP['client-sign']);
    ((w && w.also) || []).forEach(function (c) { if (WAIT_STEP[c] && also.indexOf(WAIT_STEP[c]) < 0) also.push(WAIT_STEP[c]); });
    var step = code === 'client-sign' || code === 'countersign' || code === 'payment';
    var lead = step || code === 'unclear' ? 'Waiting for:' : '';
    var label = step ? WAIT_STEP[code] : code === 'unclear' ? 'not clear' : WAIT_PILL[code];
    var then = also.length && code !== 'ready' && code !== 'unclear' && code !== 'unchecked' ? 'then ' + also.join(', ') : '';
    var extra = w && w.partPaid === true ? 'part-payment recorded' : '';
    var tip;
    if (code === 'not-sent') tip = 'The app has no record of a retainer agreement being sent, and no signature or payment on the client’s record. (An agreement sent by hand or signed on paper shows here until it is marked signed.)';
    else if (code === 'client-sign') tip = 'There is no client signature on the client’s record yet. (An agreement sent by hand or signed on paper shows here until it is marked signed.)';
    else if (code === 'countersign') tip = 'The client has signed. Our countersignature is still to come.';
    else if (code === 'payment') tip = 'The agreement is signed. There is no retainer payment on the client’s record yet.';
    else if (code === 'ready') tip = 'Signed and paid on the client’s record, but the case is still Pre-Onboarding. Please check why it has not started. Nothing is changed from here.';
    else if (code === 'unchecked') tip = 'The client records are still being read. Press Refresh in a minute.';
    else if (s(w && w.why) === 'no-lead') tip = 'No client record is linked to this case (it may have been run by hand), so the app cannot say what it is waiting for.';
    else if (s(w && w.why) === 'leads-disagree') tip = 'More than one client record is linked to this case and they do not agree, so the app cannot say what it is waiting for.';
    else if (s(w && w.why) === 'paid-conflict') tip = 'The client’s record shows signed and paid, but the case’s Payment Status was set to Not Paid or Working on it by hand. The app does not start a case like this. Please check the payment: set Payment Status back to Paid, or clear the Retainer Paid date on the client’s record.';
    else if (s(w && w.why) === 'pro-bono') tip = 'Payment Status says Pro Bono, so the app cannot say what this case is still waiting for.';
    else tip = 'The app cannot say what this case is waiting for.';
    if (then) tip += ' After that: ' + also.join(', ') + '.';
    if (extra) tip += ' A first part-payment is recorded; the balance is still owed.';
    return { code: code, lead: lead, label: label, then: then, extra: extra, tip: tip };
  }
  /**
   * The strip above Assigning: how many Pre-Onboarding rows ON SCREEN wait for what —
   * { total, list: [{ code, label, n }] (process order, zero counts left out), partPaid }. Rows without a value are not counted.
   */
  function waitingCounts(rows, preOnboardingIdx) {
    var n = {}, total = 0, part = 0;
    (rows || []).forEach(function (r) {
      if (!r || !r.waiting || idx(r.stageIdx) !== preOnboardingIdx) return;
      var c = waitCode(r.waiting);
      n[c] = (n[c] || 0) + 1; total++;
      if (r.waiting.partPaid === true) part++;
    });
    var list = [];
    WAIT_CODES.forEach(function (c) { if (n[c]) list.push({ code: c, label: WAIT_PILL[c], n: n[c] }); });
    return { total: total, list: list, partPaid: part };
  }
  /** Real / Imaginary / Not recorded counts (a Phase heading on Deadlines). */
  function typeCounts(rows) {
    var c = { real: 0, imaginary: 0, none: 0 };
    (rows || []).forEach(function (r) { c[W.typeOf(r)]++; });
    return c;
  }
  /**
   * The "Filtered" line on a view tab: shown only when a search or a filter of the person's own is on.
   * shown = rows on screen; inView = the rows of Monday's view this person may see (before their own filters).
   */
  function filteredLine(shown, inView, hasUserFilter) {
    if (!hasUserFilter) return null;
    return { shown: shown, total: inView, text: 'Filtered: ' + shown + ' of ' + inView + " in Monday's view" };
  }
  /** Is any search or filter of the person's own on (anything but the tab)? */
  function hasUserFilter(st, tabFacet) {
    if (!st) return false;
    if (s(st.q)) return true;
    var sel = st.sel || {};
    for (var f in sel) if (f !== tabFacet && sel[f] && sel[f].length) return true;
    return false;
  }


  /* ── Groups that open and close (team meeting 2026-11-10, items 10 and 11) ──────────────────────
     Every tab draws its rows under group headings a person can close and open. The All tab is grouped
     like Monday's main table (by board group) and opens on the newest month only; the view tabs open
     with every group open. What a person opens or closes is kept per tab, by the group's KEY (stage
     index / phase index / board group id), never by its title. With a search or a filter on, a closed
     group must never hide a match: every group with a match is open, and what a person closes then is
     only for that search (forgotten when it changes); the kept choices are left as they were. */
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  /** The All tab as a view: grouped by board group in the board's order, opening on the newest month. */
  var ALL_VIEW = { key: 'all', label: 'All', by: 'board', dir: 'ASC', groupOrder: 'position', sort: null, open: 'newest-month' };
  /** A heading's key as kept text (what the page stores and puts on the heading). */
  function groupId(key) { return String(key == null ? '' : key); }
  /** "November 2026", "september  2026", "Sept 2026" → { y, m }; anything else (also "Retainers before May 2026") → null. */
  function monthOf(title) {
    var p = s(title).toLowerCase().split(/[^a-z0-9]+/).filter(function (x) { return x !== ''; });
    if (p.length !== 2 || p[0].length < 3 || !/^[0-9]{4}$/.test(p[1])) return null;
    for (var i = 0; i < 12; i++) if (MONTHS[i].indexOf(p[0]) === 0) return { y: Number(p[1]), m: i + 1 };
    return null;
  }
  /**
   * The id of the month group to open on the All tab: the group named for today's month (today = Toronto YYYY-MM-DD);
   * if there is none, the newest group whose title reads "<Month> <Year>"; if none reads so, the first group. null = no groups.
   */
  function newestMonthId(groups, today) {
    var list = groups || [], t = s(today), ty = Number(t.slice(0, 4)), tm = Number(t.slice(5, 7)), best = null, bestN = -1;
    for (var i = 0; i < list.length; i++) {
      var mo = monthOf(list[i].title);
      if (!mo) continue;
      if (mo.y === ty && mo.m === tm) return groupId(list[i].key);
      if (mo.y * 12 + mo.m > bestN) { bestN = mo.y * 12 + mo.m; best = groupId(list[i].key); }
    }
    if (best !== null) return best;
    return list.length ? groupId(list[0].key) : null;
  }
  /** The ids of the groups that start open on a tab nobody has touched: the newest month (All) or every group (a view tab). */
  function defaultOpenIds(view, groups, today) {
    if (view && view.open === 'newest-month') { var id = newestMonthId(groups, today); return id === null ? [] : [id]; }
    return (groups || []).map(function (g) { return groupId(g.key); });
  }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  /**
   * Which groups are open: { id: true | false } for every group on screen.
   * o: { kept: this tab's kept choices { id: true | false }, filtered: is a search or filter on,
   *      temp: the choices made under this search / filter { id: true | false }, today }.
   * Not filtered: a kept choice, else the tab's default. Filtered: OPEN, unless the person closed it under this very search.
   */
  function openMap(view, groups, o) {
    o = o || {};
    var out = {}, def = {}, pick = (o.filtered ? o.temp : o.kept) || {};
    if (!o.filtered) defaultOpenIds(view, groups, o.today).forEach(function (id) { def[id] = true; });
    (groups || []).forEach(function (g) {
      var id = groupId(g.key);
      out[id] = has(pick, id) && typeof pick[id] === 'boolean' ? pick[id] : (o.filtered ? true : def[id] === true);
    });
    return out;
  }
  /** A copy of a choices map with these ids set open or closed. */
  function setOpen(map, ids, open) {
    var out = {}, k;
    for (k in (map || {})) if (has(map, k) && typeof map[k] === 'boolean') out[k] = map[k];
    (ids || []).forEach(function (id) { out[groupId(id)] = open === true; });
    return out;
  }
  /** What was kept, made safe: { tabKey: { groupId: true | false } } — anything else in it is dropped. */
  function normalizeKept(v) {
    var out = {}, t, k;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (t in v) {
      if (!has(v, t) || !v[t] || typeof v[t] !== 'object' || Array.isArray(v[t])) continue;
      out[t] = {};
      for (k in v[t]) if (has(v[t], k) && typeof v[t][k] === 'boolean') out[t][k] = v[t][k];
    }
    return out;
  }
  /** The search and filters in words a change can be seen in (the tab too): the choices made under one are forgotten at the next. */
  function filterSig(st, tabFacet, tabKey) {
    var sel = (st && st.sel) || {}, parts = [];
    Object.keys(sel).sort().forEach(function (f) { if (f !== tabFacet && sel[f] && sel[f].length) parts.push([f, sel[f].slice().sort()]); });
    return JSON.stringify([s(tabKey), s(st && st.q).toLowerCase(), parts]);
  }
  /** The heading button's spoken name: "November 2026, 28 cases, open — press to close". */
  function groupLabel(title, n, open) {
    return s(title) + ', ' + n + ' case' + (n === 1 ? '' : 's') + ', ' + (open ? 'open — press to close' : 'closed — press to open');
  }

  return { EMPTY: EMPTY, keyOf: keyOf, titleOf: titleOf, groupRows: groupRows, viewOrder: viewOrder, noOfficer: noOfficer,
    noOfficerCount: noOfficerCount, waitingWords: waitingWords, waitingCounts: waitingCounts, typeCounts: typeCounts, filteredLine: filteredLine, hasUserFilter: hasUserFilter,
    ALL_VIEW: ALL_VIEW, groupId: groupId, monthOf: monthOf, newestMonthId: newestMonthId, defaultOpenIds: defaultOpenIds, openMap: openMap, setOpen: setOpen,
    normalizeKept: normalizeKept, filterSig: filterSig, groupLabel: groupLabel };
}

module.exports = Object.assign({ clientMasterUi: clientMasterUi }, clientMasterUi(require('./clientMasterWindows')));
