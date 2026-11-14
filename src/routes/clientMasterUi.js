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
   * The All tab's heading order (Faran 2026-11-14, "months by date"): the groups from groupRows (board order) put as
   *   0 · every other group (Pending, Leads, …) in board order;  1 · the month groups ("<Month> <Year>"), newest first;
   *   2 · "Retainers before …" (older history);  3 · Cancel groups, then TEST;  4 · rows with no group ("—") last, and with
   *   them a group the board read does not know (meta given) unless its title is a month — a month is placed by its date.
   *   With no meta (a failed board read) every group is placed by its title.
   * A stable re-order: never adds, drops or splits a group; equal ranks keep the order they came in.
   * Only the All tab uses it — the view tabs keep Monday's order.
   */
  function allGroupRank(g, meta) {
    var key = s(g && g.key), t = s(g && g.title).toLowerCase().split(' ').filter(function (x) { return x !== ''; }).join(' ');   // no backslash: this file is injected as text
    if (key === '' || t === '' || t === '—') return { band: 4, n: 0 };
    var mo = monthOf(g.title);
    if (mo) return { band: 1, n: -(mo.y * 12 + mo.m) };
    if (meta && meta.groups && meta.groups.length && !groupMeta(meta, key)) return { band: 4, n: 0 };
    if (t.indexOf('retainers before') === 0) return { band: 2, n: 0 };
    if (t.indexOf('cancel') === 0) return { band: 3, n: 0 };
    if (t === 'test') return { band: 3, n: 1 };
    return { band: 0, n: 0 };
  }
  function allGroupOrder(groups, meta) {
    return (groups || []).map(function (g, i) { return { g: g, i: i, r: allGroupRank(g, meta) }; })
      .sort(function (a, b) { return (a.r.band - b.r.band) || (a.r.n - b.r.n) || (a.i - b.i); })
      .map(function (o) { return o.g; });
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

  /* ── Columns a person chooses (team meeting 2026-11-10, item 13) ─────────────────────────────────
     Each tab has its own default columns (the list's own: listSpecs casesListOpts). A person may hide any of
     them except Case Ref and Client, and may add the columns of the OTHER tabs that have no equivalent on this
     one. Two columns that show the same board fact in two looks are equivalents (COL_SAME): one tab never
     offers both. What is kept is the DIFFERENCE from the default, per tab ({ hidden: [ids], added: [ids] }),
     so a column added to a default later shows up by itself and an id that is gone is simply ignored.
     tabCols: { '': [the All tab's column ids], viewKey: [ids], … } — the page's CM_TABCOLS. */
  var COL_LOCKED = ['caseRef', 'clientName'];   // always shown (and pinned in the wide table)
  var COL_FIXED = ['del'];                      // not a choice: stays where the tab has it, last
  /* All's column, then the view tabs' column for the same thing (All's "Deadline" also carries the type and the window;
     its own "Deadline type" column can still be added there). */
  var COL_SAME = [['caseType', 'caseTypeV'], ['caseStage', 'stageV'], ['phase', 'phaseV'], ['deadline', 'actualDeadline'],
    ['promised', 'internalDeadline'], ['officer', 'officerV'], ['manager', 'managerV']];
  function colList(v) { var out = []; (Array.isArray(v) ? v : []).forEach(function (x) { if (typeof x === 'string' && x && out.indexOf(x) < 0) out.push(x); }); return out; }
  /** The other ids that show the same thing as this one ([] = none). */
  function colSame(id) {
    var out = [];
    COL_SAME.forEach(function (g) { if (g.indexOf(id) >= 0) g.forEach(function (x) { if (x !== id && out.indexOf(x) < 0) out.push(x); }); });
    return out;
  }
  /** The storage name of a tab's choice ('' = the All tab). */
  function colTabKey(tab) { var t = s(tab); return t === '' ? 'all' : t; }
  /**
   * What a tab offers: { tab, own: the tab's default columns that can be chosen (table order, the locked two first as the
   * list has them), extra: the other tabs' columns with no equivalent here (their own order; All's first), locked, fixed:
   * the tab's columns that are not a choice }. An unknown tab is read as All.
   */
  function colPlan(tabCols, tab) {
    var tc = tabCols || {}, t = has(tc, s(tab)) ? s(tab) : '';
    var mine = colList(tc[t]), own = [], fixed = [], extra = [];
    mine.forEach(function (id) { (COL_FIXED.indexOf(id) >= 0 ? fixed : own).push(id); });
    function taken(id) { return colSame(id).some(function (x) { return own.indexOf(x) >= 0 || extra.indexOf(x) >= 0; }); }
    var keys = Object.keys(tc).filter(function (k) { return k !== t; }).sort(function (a, b) { return (a === '' ? 0 : 1) - (b === '' ? 0 : 1); });
    keys.forEach(function (k) {
      colList(tc[k]).forEach(function (id) {
        if (COL_FIXED.indexOf(id) >= 0 || own.indexOf(id) >= 0 || extra.indexOf(id) >= 0 || taken(id)) return;
        extra.push(id);
      });
    });
    return { tab: t, own: own, extra: extra, fixed: fixed, locked: own.filter(function (id) { return COL_LOCKED.indexOf(id) >= 0; }) };
  }
  /** A kept choice made safe for a plan: only ids the tab can hide (never the locked two) and ids it can add. */
  function colPref(plan, raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    return { hidden: colList(r.hidden).filter(function (id) { return plan.own.indexOf(id) >= 0 && plan.locked.indexOf(id) < 0; }),
      added: colList(r.added).filter(function (id) { return plan.extra.indexOf(id) >= 0; }) };
  }
  /** The columns to draw, in order: the tab's own (without the hidden), then the added in their own set's order, then the fixed (All's delete column). */
  function colIds(plan, raw) {
    var p = colPref(plan, raw);
    return plan.own.filter(function (id) { return p.hidden.indexOf(id) < 0; })
      .concat(plan.extra.filter(function (id) { return p.added.indexOf(id) >= 0; })).concat(plan.fixed);
  }
  /** The choice after one box is ticked or unticked. A locked column, a fixed one or an id the tab does not offer changes nothing. */
  function colToggle(plan, raw, id, on) {
    var p = colPref(plan, raw), show = on === true;
    function put(list, yes) { var at = list.indexOf(id); if (yes && at < 0) list.push(id); if (!yes && at >= 0) list.splice(at, 1); }
    if (plan.locked.indexOf(id) >= 0) return p;
    if (plan.own.indexOf(id) >= 0) put(p.hidden, !show);
    else if (plan.extra.indexOf(id) >= 0) put(p.added, show);
    return p;
  }
  /** How far a tab is from its default: { hidden, added, custom, text: '' | '3 hidden' | '2 added' | '3 hidden, 2 added' }. */
  function colSummary(plan, raw) {
    var p = colPref(plan, raw), parts = [];
    if (p.hidden.length) parts.push(p.hidden.length + ' hidden');
    if (p.added.length) parts.push(p.added.length + ' added');
    return { hidden: p.hidden.length, added: p.added.length, custom: parts.length > 0, text: parts.join(', ') };
  }
  /** What was kept, made safe in shape only: { tabKey: { hidden: [ids], added: [ids] } } from { v: 1, tabs: {…} }; anything else → {}. */
  function colStore(raw) {
    var out = {}, k, t = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.v === 1 ? raw.tabs : null;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return out;
    for (k in t) {
      if (!has(t, k) || !t[k] || typeof t[k] !== 'object' || Array.isArray(t[k])) continue;
      var e = { hidden: colList(t[k].hidden).slice(0, 100), added: colList(t[k].added).slice(0, 100) };
      if (e.hidden.length || e.added.length) out[k] = e;
    }
    return out;
  }
  /** The kept form of the choices: { v: 1, tabs } — or null when every tab is at its default (nothing to keep). */
  function colStoreOut(map) {
    var tabs = colStore({ v: 1, tabs: map || {} });
    return Object.keys(tabs).length ? { v: 1, tabs: tabs } : null;
  }
  /** Does this set of columns need the wide table (sideways scroll, Case Ref and Client pinned)? A view tab always; All once a column is added to it. */
  function colWide(tabCols, tab, ids) {
    if (s(tab) !== '') return true;
    var all = colList((tabCols || {})['']);
    return (ids || []).some(function (id) { return all.indexOf(id) < 0; });
  }
  /** The plain All table's least width: it was tuned for its fifteen columns (1260px); with columns hidden it follows the number shown.
      '' = leave it to the style sheet (the default fifteen or more). */
  function colMinWidth(n) {
    var k = Number(n);
    if (!isFinite(k) || k >= 15) return '';
    return Math.round(1260 * Math.max(1, Math.floor(k)) / 15) + 'px';
  }
  /** How small the wide table prints, by the number of columns that go on paper: 0 = up to twenty (as it always printed),
      1 = 21 to 23, 2 = 24 and more. The print rules step the letters and the padding down by this, so every chosen column is on the sheet. */
  function colPrintFit(n) {
    var k = Number(n);
    if (!isFinite(k) || k <= 20) return 0;
    return k <= 23 ? 1 : 2;
  }


  return { EMPTY: EMPTY, keyOf: keyOf, titleOf: titleOf, groupRows: groupRows, viewOrder: viewOrder, noOfficer: noOfficer,
    noOfficerCount: noOfficerCount, waitingWords: waitingWords, waitingCounts: waitingCounts, typeCounts: typeCounts, filteredLine: filteredLine, hasUserFilter: hasUserFilter,
    ALL_VIEW: ALL_VIEW, allGroupOrder: allGroupOrder, groupId: groupId, monthOf: monthOf, newestMonthId: newestMonthId, defaultOpenIds: defaultOpenIds, openMap: openMap, setOpen: setOpen,
    normalizeKept: normalizeKept, filterSig: filterSig, groupLabel: groupLabel,
    COL_LOCKED: COL_LOCKED, COL_FIXED: COL_FIXED, COL_SAME: COL_SAME, colSame: colSame, colTabKey: colTabKey, colPlan: colPlan, colPref: colPref, colIds: colIds,
    colToggle: colToggle, colSummary: colSummary, colStore: colStore, colStoreOut: colStoreOut, colWide: colWide, colMinWidth: colMinWidth, colPrintFit: colPrintFit };
}

module.exports = Object.assign({ clientMasterUi: clientMasterUi }, clientMasterUi(require('./clientMasterWindows')));
