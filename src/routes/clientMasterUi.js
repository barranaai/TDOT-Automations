'use strict';

/**
 * The Client Master page's view tabs (block 3): the group headings, Monday's order
 * inside a view, and the counts above the table. Pure helpers, no DOM.
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
   * sort (Mahesh: Actual Deadline ascending), that date with blanks LAST in either direction, ties in board order.
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
  /** Real / Imaginary / Not recorded counts (a Phase heading on Deadlines and Mahesh). */
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

  return { EMPTY: EMPTY, keyOf: keyOf, titleOf: titleOf, groupRows: groupRows, viewOrder: viewOrder, noOfficer: noOfficer,
    noOfficerCount: noOfficerCount, typeCounts: typeCounts, filteredLine: filteredLine, hasUserFilter: hasUserFilter };
}

module.exports = Object.assign({ clientMasterUi: clientMasterUi }, clientMasterUi(require('./clientMasterWindows')));
