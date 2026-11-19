'use strict';

/**
 * The To-do tab of the Client Master page (stage 1, READ-ONLY; Faran 2026-11-19): ALL of the
 * tab's own page code. adminDashboard.js puts it into the page only when the tab is on it
 * (buildDashboardHTML(view, { todo: true })); the common page code calls it through small guarded
 * hooks (v && v.todoBox && typeof cmTodoX === 'function'), so nothing here runs on the other tabs'
 * draw path and a page without the tab carries none of it.
 *
 * What is here:
 *   TODO_CSS      the tab's own look (the list picker, the phone select, the lines, the "With"
 *                 pill, the status line) and its print rules (the picker is not printed);
 *   TODO_PAGE_JS  plain page JavaScript for the page's main script: what the tab keeps, and the
 *                 functions below, pasted in with Function#toString;
 *   TODO_BOOT_JS  one call, placed right after the list script: from then on every new set of
 *                 rows is followed, and the top bar lights "To-do" while the tab is on screen.
 *
 * The lists themselves are worked out by the pure helper todoUi.js (TDU on the page) from the rows
 * the page already has; the narrowing to the list on screen happens INSIDE the list engine (its
 * view facet asks cmTodoHas), so the engine's own numbers are about that list. Nothing is ever
 * written to Monday from here and nothing is asked of the server: this file makes no request.
 *
 * INJECTED-CODE RULE (tests enforce it on what is pasted into the page): no backslash, no backtick
 * and no dollar-brace inside the functions below or the page strings. Write [0-9] for a digit and
 * join strings with +.
 *
 * The functions below are browser code: they run in the page, never in Node (Node only reads
 * their text). They use the page's own globals: window, document, history, URL, _data,
 * CasesTable, CMU, TDU, CM_VIEWS and the page functions escHtml, cmToday, cmView, cmGroupTone,
 * cmDataTimeText, cmAnd.
 */

/* eslint-disable no-var, no-undef, no-unused-vars */

/* ── what the tab keeps on the page (page JavaScript, as text) ── */
const TODO_STATE_JS = [
  '/* ── The To-do tab (stage 1, read-only): whose list is on screen, the box above the table, and the hooks the common code calls ── */',
  "var CM_TODO_WHO_KEY = 'tdot_list_cases_todo_who';   // whose list this browser tab is on: exactly me | nobody | p:<digits> | t:<digits> (Sign Out forgets every tdot_list_ key)",
  "var CM_TODO_COL = 'todoWith';                       // the id of the With column (listSpecs: the tab's key + 'With')",
  'var CM_TODO_KEPT = null;      // the kept choice ("" = none); null = not read yet',
  'var CM_TODO_C = null;         // what the newest data says: who has a list, and the list on screen (worked out once per set of rows)',
  'var CM_TODO_L = null;         // the list as last drawn (its title and groups)',
  'var CM_TODO_SEC = {};         // item id -> mine | review | nobody, for the rows last drawn (the "With" pill reads it)',
  'var CM_TODO_MSG = null;       // { text, until }: the line shown for a few seconds after an Assign took a case off the list on screen',
  'var CM_TODO_MORE = false;     // is "More about this list" open (the box is redrawn at every draw)',
].join(String.fromCharCode(10));

/* The kept choice, read once from this browser tab's store; after that the page's own copy is the truth. */
function cmTodoKept() {
  if (CM_TODO_KEPT !== null) return CM_TODO_KEPT;
  var raw = null;
  try { raw = window.sessionStorage.getItem(CM_TODO_WHO_KEY); } catch (e) { raw = null; }
  CM_TODO_KEPT = TDU.normWho(raw);
  return CM_TODO_KEPT;
}
/* The kept choice is always the one of the page on screen (also after Back brings an older copy of the page out of the browser's
   memory). Only ever one of the four shapes; nothing once Sign Out has begun; never the address, never localStorage. */
function cmTodoSave() {
  if (window.TDOT_SIGNED_OUT || CM_TODO_KEPT === null) return;
  try {
    if (CM_TODO_KEPT) window.sessionStorage.setItem(CM_TODO_WHO_KEY, CM_TODO_KEPT);
    else window.sessionStorage.removeItem(CM_TODO_WHO_KEY);
  } catch (e) {}
}
function cmTodoKeep(who) {
  CM_TODO_KEPT = TDU.normWho(who);
  CM_TODO_C = null;
  cmTodoSave();
}
/* A link's ?who= (cmInitial calls this only when the link opens this tab): read ONCE. Only "me" and "nobody" are taken (a person
   is never named in an address); the value is kept for this browser tab and who= is taken off the address either way.
   Touches only window, URL and history: there is no data and no page yet when it runs. */
function cmTodoLink() {
  var u = null, w = null;
  try { u = new URL(window.location.href); w = u.searchParams.get('who'); } catch (e) { return; }
  if (w === null) return;
  w = String(w).trim().toLowerCase();
  if (w === 'me' || w === 'nobody') {
    CM_TODO_KEPT = w;
    CM_TODO_C = null;
    if (!window.TDOT_SIGNED_OUT) { try { window.sessionStorage.setItem(CM_TODO_WHO_KEY, w); } catch (e) {} }
  }
  try { u.searchParams.delete('who'); history.replaceState(null, '', u.toString()); } catch (e) {}
}
/* cmOnChange's address (u, a URL it is about to write): it only ever carries the tab. A stray who= goes. */
function cmTodoAddress(u) { u.searchParams.delete('who'); }

/* New rows are on their way (every CasesTable.setRows): what was worked out from the old ones is dropped. */
function cmTodoFresh() { CM_TODO_C = null; }
/* What the newest answer says, worked out once per set of rows (the list engine asks about every open row at every draw):
   ok     the answer carries the lists (its todo part) — read from EVERY answer, never kept from the first load;
   me     the Monday sign-in of that answer ({ id, name, teamIds }) or null;
   ppl    who has a list (TDU.people, counted from ALL the page's rows — never from the engine's filtered rows);
   who    the list on screen: the kept choice if it is still offered, else "My list" with a Monday sign-in, else none ('');
   size   that list's size before the person's own search and filters;  on: the ids of the cases on it. */
function cmTodoNow() {
  var d = (typeof _data !== 'undefined' && _data) || null, rows = (d && d.cases) || null, C = CM_TODO_C;
  if (C && C.data === d && C.cases === rows) return C;
  var t = d && d.todo && typeof d.todo === 'object' ? d.todo : null;
  C = { data: d, cases: rows, ok: !!t, me: (t && t.me) || null, ppl: { me: null, list: [], nobody: null }, who: '', names: {}, size: 0, on: {} };
  if (t) {
    C.names = TDU.names(rows || []);
    C.ppl = TDU.people(rows || [], C.me, d.viewer && d.viewer.scope);
    C.who = TDU.resolveWho(cmTodoKept(), C.ppl);
    C.size = TDU.sizeOf(C.ppl, C.who);
    if (C.who) (rows || []).forEach(function(r) { if (TDU.has(r, C.who, C.me)) C.on[String(r.id)] = true; });
  }
  CM_TODO_C = C;
  return C;
}
/* The list engine's hook (the view facet, listSpecs casesListSpec ctx.todoHas): is this row on the list on screen? */
function cmTodoHas(r) { var C = cmTodoNow(); return C.ok && C.who !== '' && TDU.has(r, C.who, C.me); }
/* The list on screen, as its who value ('' = none): open / closed choices made under a search are per list. */
function cmTodoWho() { var C = cmTodoNow(); return C.ok ? C.who : ''; }
function cmTodoCases(n) { return n + ' case' + (n === 1 ? '' : 's'); }

/* renderViewTable on this tab: the engine's rows (already the list on screen, searched and filtered) in deadline order — unless a
   column sort is chosen (deadlineOrder false: the engine's order stays) — split under the list's headings. Never CMU.groupRows /
   CMU.viewOrder with this tab's own definition. Answers { groups, size (the list before the person's own filters), none (the
   words for an empty table, as HTML; '' = no line), extra(g) (a heading's "— 3 passed · 9 no deadline") }. */
function cmTodoDraw(rows, st, deadlineOrder) {
  var C = cmTodoNow(), sec = {};
  var L = TDU.listFor(deadlineOrder ? TDU.order(rows) : rows, C.ok ? C.who : '', { me: C.me, names: C.names, meta: (_data && _data.meta) || null, today: cmToday() });
  L.groups.forEach(function(g) { g.rows.forEach(function(r) { sec[String(r.id)] = g.section; }); });
  CM_TODO_SEC = sec;
  CM_TODO_L = L;
  cmTodoSave();
  return { groups: L.groups, size: C.size, none: cmTodoNone(C), extra: cmTodoGrpExtra };
}
/* The empty table's words. Never "No cases in the … view right now." and never "in Monday's view" on this tab. */
function cmTodoNone(C) {
  if (!C.ok) return '';   // the lists are not in the answer: the box above the table says why, and there is no line here
  if (!C.who) return 'Choose a list above.';
  if (C.size) return 'No cases on this list match. The search looks only in the list chosen above.';
  if (C.who === 'me') return 'You have no open cases as Case Support Officer or Case Manager. Choose a name above to see another list.';
  if (C.who === 'nobody') return 'Every open case has a Case Support Officer or a Case Manager.';
  return escHtml(TDU.nameOf(C.who, C.names)) + ' has no open cases as Case Support Officer or Case Manager.';
}
function cmTodoGrpExtra(g) {
  var parts = [];
  if (g && g.passed) parts.push(g.passed + ' passed');
  if (g && g.noDate) parts.push(g.noDate + ' no deadline');
  return parts.length ? ' <span class="cm-grp-c">— ' + parts.join(' · ') + '</span>' : '';
}

/* The box above the table on this tab (renderCmHead hands over): the title (it says whose list, so a printed list does too), the
   data time and Print; who is signed in; the choice of list (buttons — one select on a phone, both from the same people data); the
   status line; the Filtered line; what the list is, in two plain lines; the stage counts on "No one assigned"; "More about this list".
   Every name from Monday is escaped as text. The answer has no lists (an admin's Monday sign-in ended): one line, nothing else. */
function cmTodoHead(el, v, rows, st, groups, inView) {
  var C = cmTodoNow(), here = String(window.location.pathname || '/admin/dashboard') + '?view=' + encodeURIComponent(v.key);
  if (!C.ok) {
    el.innerHTML = '<div class="cm-line cm-todo-ended" id="cm-todo-ended">Your Monday sign-in has ended. <a href="/q/auth/monday?returnTo=' + escHtml(encodeURIComponent(here)) + '">Sign in with Monday again</a> to see the to-do lists.</div>';
    return;
  }
  // a redraw must not take the focus off the picker or "More about this list" (new data can arrive while someone is on them):
  // a picker button is remembered by its own data-who, so the focus comes back to the SAME button — which need not be the pressed one
  var act = document.activeElement, keep = '', at = null;
  if (act && act.getAttribute && el.contains && el.contains(act) && act !== el) {
    at = act.getAttribute('data-who');
    keep = act.id === 'cm-todo-sel' ? 'select' : at !== null ? 'button' : act.id === 'cm-todo-more-s' ? 'more' : '';
  }
  var L = CM_TODO_L || { title: v.label };
  var h = '<div class="cm-top"><span class="cm-title" id="cm-todo-title">' + escHtml(L.title) + '</span>' +
    '<span class="cm-dataat" id="cm-dataat">' + escHtml(cmDataTimeText(_data)) + '</span>' +
    '<button type="button" class="cm-print" id="cm-print" onclick="window.print()" title="Print this list (landscape)">🖨 Print</button></div>';
  var mine = C.ppl.me ? String(C.ppl.me.name || '') : '';
  if (C.me) h += '<div class="cm-note cm-todo-in" id="cm-todo-in">' + (mine ? 'Signed in with Monday as ' + escHtml(mine) + '.' : 'Signed in with Monday.') + '</div>';
  else h += '<div class="cm-note cm-todo-in" id="cm-todo-in"><a href="/q/auth/monday?returnTo=' + escHtml(encodeURIComponent(here + '&who=me')) + '">Sign in with Monday</a> to open on your own list.</div>';
  var opts = [];
  if (C.ppl.me) opts.push({ key: 'me', name: 'My list', n: C.ppl.me.total });
  (C.ppl.list || []).forEach(function(p) { opts.push({ key: p.key, name: p.name, n: p.total }); });
  if (C.ppl.nobody) opts.push({ key: 'nobody', name: 'No one assigned', n: C.ppl.nobody.total });
  if (opts.length) {
    // the chosen list: pressed, filled, and a leading tick — never by colour alone
    h += '<div class="cm-strip cm-todo-pick" id="cm-todo-pick" role="group" aria-label="Whose to-do list">' + opts.map(function(o) {
      var on = o.key === C.who;
      return '<button type="button" class="cm-st cm-todo-b" data-who="' + escHtml(o.key) + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + escHtml(o.name + ', ' + cmTodoCases(o.n)) + '" onclick="cmTodoPick(this)">' +
        (on ? '<span class="cm-todo-tick" aria-hidden="true">✓</span> ' : '') + escHtml(o.name) + ' <b>' + o.n + '</b></button>';
    }).join('') + '</div>';
    h += '<div class="cm-todo-phone" id="cm-todo-phone"><label class="cm-todo-sel-l" for="cm-todo-sel">Whose list</label>' +
      '<select class="cm-todo-sel" id="cm-todo-sel" onchange="cmTodoPick(this)">' + (C.who ? '' : '<option value="" selected>Choose a list…</option>') + opts.map(function(o) {
        return '<option value="' + escHtml(o.key) + '"' + (o.key === C.who ? ' selected' : '') + '>' + escHtml(o.name + ' (' + o.n + ')') + '</option>';
      }).join('') + '</select></div>';
  }
  h += '<div class="cm-todo-status" id="cm-todo-status" role="status">' + escHtml(CM_TODO_MSG && CM_TODO_MSG.until > Date.now() ? CM_TODO_MSG.text : '') + '</div>';
  var fl = C.who ? CMU.filteredLine(rows.length, inView, CMU.hasUserFilter(st, 'view'), 'on this list') : null;
  if (fl) h += '<div class="cm-filtered" id="cm-filtered">' + escHtml(fl.text) + '<span class="cm-clear-w"> · <button type="button" class="cm-clear" id="cm-clear" onclick="CasesTable.clearFilters()">Clear filters</button></span></div>';
  if (_data && _data.viewer && _data.viewer.scope === 'assigned') h += '<div class="cm-note">Showing only your cases; ask an admin to see everyone’s.</div>';
  if (C.who === 'nobody') h += '<div class="cm-line" id="cm-todo-l1">Open cases with no Case Support Officer and no Case Manager. Cases are usually given to someone at Internal Review; earlier stages show here until then.</div>';
  else h += '<div class="cm-line" id="cm-todo-l1">From Client Master: cases where the person is Case Support Officer, and cases where they are Case Manager (for review). Soonest deadline first (Actual deadline; Internal deadline for an Imaginary case).</div>';
  h += '<div class="cm-line" id="cm-todo-l2">This list can differ from the Monday to-do boards. Those boards are not changed.</div>';
  if (C.who === 'nobody' && groups && groups.length) {
    // the stage counts, as on the Assigning tab: each is a button that opens that stage's group and goes to it
    h += '<div class="cm-strip" id="cm-strip" role="group" aria-label="Cases by stage: press a stage to go to its group">' + groups.map(function(g) {
      return '<button type="button" class="cm-st' + cmGroupTone(v, g) + '" data-go="' + escHtml(CMU.groupId(g.key)) + '" onclick="cmGrpGo(this.dataset.go)" title="Go to this group in the table (opens it if it is closed)">' + escHtml(g.title) + ' <b>' + g.rows.length + '</b></button>';
    }).join('') + '</div>';
  }
  h += '<details class="cm-todo-more" id="cm-todo-more"' + (CM_TODO_MORE ? ' open' : '') + ' ontoggle="cmTodoMore(this.open)"><summary id="cm-todo-more-s">More about this list</summary><ul>' +
    '<li>Only cases on the Assigning tab are listed.</li>' +
    "<li>A case passed for review stays on the officer's list, marked 'With …'. The mark shows only when a Case Manager is set on Client Master.</li>" +
    '<li>A case with two officers is on both lists.</li>' +
    '<li>Work that has no case on Client Master is not listed.</li>' +
    '<li>Looking at a list changes nothing in Monday. Assign… works here as on the Assigning tab: it sets the Case Support Officer in Monday.</li>' +
    '</ul></details>';
  el.innerHTML = h;
  if (keep === 'more') { var s = document.getElementById('cm-todo-more-s'); if (s) { try { s.focus({ preventScroll: true }); } catch (e) {} } }
  else if (keep) cmTodoFocus(keep, keep === 'button' ? at : null);
}
function cmTodoMore(open) { CM_TODO_MORE = open === true; }

/* Focus on the control that shows the chosen list: the pressed button (found by its data-who), or the select — on a phone the
   buttons are hidden and only the select can take it. how: 'select' | 'button' | nothing (whichever is on show).
   same (only the box's own redraw gives it): the data-who of the button the person was on — that button gets the focus back while
   it is still drawn (a redraw they did not cause must not move them to the pressed one); when it is gone, the pressed one. */
function cmTodoFocus(how, same) {
  var C = cmTodoNow(), sel = document.getElementById('cm-todo-sel'), b = null, was = null;
  var list = document.querySelectorAll('#cm-todo-pick button');
  for (var i = 0; i < list.length; i++) {
    var w = list[i].getAttribute('data-who');
    if (w === C.who) b = list[i];
    if (typeof same === 'string' && w === same) was = list[i];
  }
  if (was) b = was;
  var to = how === 'select' ? (sel || b) : (b && b.offsetParent !== null ? b : (sel || b));
  if (!to) return;
  try { to.focus({ preventScroll: true }); } catch (e) { try { to.focus(); } catch (e2) {} }
}
/* A list is chosen (a picker button, or the phone select): keep it for this browser tab — sessionStorage only, never the address —
   then ONE CasesTable.apply: the engine filters again, so the rows, the tab's number, the count and the header-filter counts are
   all about the new list; then the focus goes back to the same control. */
function cmTodoPick(el) {
  if (!el) return;
  var isSel = String(el.tagName || '').toLowerCase() === 'select';
  var w = TDU.normWho(String((isSel ? el.value : el.getAttribute('data-who')) || ''));
  if (!w) return;
  cmTodoKeep(w);
  if (window.CasesTable) window.CasesTable.apply('who');
  cmTodoFocus(isSel ? 'select' : 'button');
}

/* caseRow's "With" cell: the names for the pill ({ lead, list }). On this tab the person whose list is on screen is left out
   ("With …" in their own cases, "Also with …" in their review cases); on any other tab, every Case Manager. */
function cmTodoWith(c, v) {
  var C = cmTodoNow(), on = !!(v && v.todoBox) && C.ok && C.who !== '';
  return TDU.withNames(c, on ? C.who : '', on ? (CM_TODO_SEC[String(c.id)] || '') : '', C.names, C.me);
}
/* caseRow's "Passed" pill: the column that holds the date this row is ordered by, when that date has passed ('' = no pill). */
function cmTodoPassed(c, today) { return TDU.duePassed(c, today) ? TDU.dueField(c) : ''; }

/* Every CasesTable.setRows goes through here (cmTodoBoot): what was worked out from the old rows is dropped first, so the lists
   always follow the newest rows — a Refresh, and an Assign, which changes a row in place and hands the SAME rows over again.
   Only that second kind can be an Assign made here: when it took a case off the list on screen, the status line says where it went. */
function cmTodoSetRows(set, rows) {
  var before = CM_TODO_C, v = window.CasesTable ? cmView(window.CasesTable.state()) : null;
  cmTodoFresh();
  var out = set(rows);
  if (v && v.todoBox && before && before.ok && before.who && before.cases === rows) cmTodoMoved(before);
  return out;
}
/* The rows were changed in place: one case that was on the list on screen is not on it any more — "<case ref> is now on <Name>'s
   list." (the case reference only, never the client's name) for about six seconds, and the focus goes to the chosen picker control
   when it would otherwise be nowhere (the row and its Assign button are gone) — never while a pop-up is still open, and never
   away from something a person is on. Nothing is asked of the server. */
function cmTodoMoved(before) {
  var C = cmTodoNow(), gone = [];
  (C.cases || []).forEach(function(r) { if (before.on[String(r.id)] === true && !TDU.has(r, before.who, C.me)) gone.push(r); });
  if (gone.length !== 1) return;
  var ref = String(gone[0].caseRef || '').trim() || 'The case';
  var to = String(gone[0].officer || '').split(',').map(function(x) { return x.trim(); }).filter(Boolean);
  cmTodoSay(ref + (to.length === 1 ? ' is now on ' + to[0] + "'s list." : to.length ? ' is now on the lists of ' + cmAnd(to) + '.' : ' now has no Case Support Officer.'));
  setTimeout(function() {
    if (window.TDOT_DLG && window.TDOT_DLG.stack && window.TDOT_DLG.stack.length) return;   // the Assign pop-up stayed open (it has more to say): the focus is its own
    var a = document.activeElement;
    if (!a || a === document.body || !document.body.contains(a)) cmTodoFocus();
  }, 0);
}
function cmTodoSay(text) {
  CM_TODO_MSG = { text: String(text), until: Date.now() + 6000 };
  var e = document.getElementById('cm-todo-status');
  if (e) e.textContent = CM_TODO_MSG.text;
  setTimeout(function() {
    if (CM_TODO_MSG && CM_TODO_MSG.until <= Date.now()) CM_TODO_MSG = null;
    var x = document.getElementById('cm-todo-status');
    if (x && !CM_TODO_MSG) x.textContent = '';
  }, 6100);
}

/* The top bar: "To-do" is lit while this tab is on screen, else "Client Master" (v = the tab on view, null on All).
   Does nothing when the bar has no To-do link (the switch is not fully on). */
function cmTodoNav(v) {
  if (typeof document === 'undefined') return;
  var t = document.getElementById('nav-todo');
  if (!t) return;
  var cm = null, list = document.querySelectorAll('.admin-nav .nav-lnk'), on = !!(v && v.todoBox);
  for (var i = 0; i < list.length; i++) if (list[i].getAttribute('href') === '/admin/dashboard') cm = list[i];
  [[t, on], [cm, !on]].forEach(function(p) {
    if (!p[0]) return;
    p[0].classList.toggle('active', p[1]);
    if (p[1]) p[0].setAttribute('aria-current', 'page'); else p[0].removeAttribute('aria-current');
  });
}
/* Once, right after the list script has started (before any data): setRows is followed from now on, and the top bar says which tab this is. */
function cmTodoBoot() {
  var api = window.CasesTable;
  if (!api || api.cmTodoFollows) return;
  var set = api.setRows;
  api.setRows = function(rows) { return cmTodoSetRows(set, rows); };
  api.cmTodoFollows = true;
  cmTodoNav(cmView(api.state()));
}

/** The tab's page functions, in the order they are pasted into the page. */
const TODO_FUNCTIONS = [cmTodoKept, cmTodoSave, cmTodoKeep, cmTodoLink, cmTodoAddress, cmTodoFresh, cmTodoNow, cmTodoHas, cmTodoWho, cmTodoCases,
  cmTodoDraw, cmTodoNone, cmTodoGrpExtra, cmTodoHead, cmTodoMore, cmTodoFocus, cmTodoPick, cmTodoWith, cmTodoPassed,
  cmTodoSetRows, cmTodoMoved, cmTodoSay, cmTodoNav, cmTodoBoot];

/** For the page's main script (after TDU): the state, then every function. */
const TODO_PAGE_JS = TODO_STATE_JS + String.fromCharCode(10) + TODO_FUNCTIONS.map(function (f) { return f.toString(); }).join(String.fromCharCode(10)) + String.fromCharCode(10);

/** Right after the list script (CasesTable exists by then). */
const TODO_BOOT_JS = 'cmTodoBoot();';

/* The tab's own look. The picker sits on the stage strip's pill look (cm-st) with a class of its own: no "go to" arrow, and the
   chosen list is filled navy with white text and a tick. At 760px and below the buttons give way to ONE native select with a
   visible label (16px, so a phone does not zoom in). The status line stays where it is in the box above the table (role=status) but
   is SHOWN at the foot of the window while it has words: after an Assign far down a long list the box is out of view. The picker,
   the sign-in line, the status line and "More about this list" are not printed: the paper carries the title (it says whose list),
   the lines and the table. */
const TODO_CSS = [
  '    /* ── The To-do tab (stage 1, read-only; the switch TODO_TAB) ── */',
  "    button.cm-todo-b::after { content:none; }   /* a choice of list, not a count that goes to a group: no arrow */",
  '    .cm-todo-b { min-height:28px; }',
  '    .cm-todo-b[aria-pressed="true"], .cm-todo-b[aria-pressed="true"]:hover { background:var(--navy); border-color:var(--navy); color:#fff; }',
  '    .cm-todo-b[aria-pressed="true"] b { color:#fff; }',
  '    .cm-todo-tick { font-weight:800; }',
  '    .cm-todo-phone { display:none; align-items:center; gap:8px; flex-wrap:wrap; }',
  '    .cm-todo-sel-l { font-size:13px; font-weight:700; color:#334155; }',
  '    .cm-todo-sel { flex:1 1 200px; max-width:100%; min-height:44px; border:1px solid #cbd5e1; border-radius:8px; padding:6px 10px; font:inherit; font-size:16px; background:#fff; color:#0f172a; }',
  '    .cm-todo-sel:focus-visible { outline:2px solid var(--navy); outline-offset:2px; }',
  '    @media (max-width: 760px) { .cm-todo-pick { display:none; } .cm-todo-phone { display:flex; } .cm-todo-sel-l { font-size:16px; } .cm-todo-more summary { font-size:14px; padding:8px 4px; } }',
  '    .cm-todo-in a, .cm-todo-ended a { color:var(--st-blue-fg); font-weight:700; }',
  '    .cm-todo-status { font-size:12.5px; font-weight:700; color:var(--st-green-fg); background:var(--st-green-bg); border:1px solid var(--st-green-solid); border-radius:8px; padding:6px 10px; }',
  '    .cm-todo-status:empty { display:none; }',
  '    /* The line is written in the box above the table, which is far out of view once the list is scrolled (the page scrolls, not the',
  '       table): while it has words it is shown at the foot of the window, where the person is looking. THE TWO RULES ARE A PAIR. A fixed',
  '       box is placed against the window only when no box around it keeps a transform, and the fade-in of the page leaves one on #content',
  '       when it ends (its fill is "both"). With the first rule the fade-in still plays and leaves nothing behind; without it the second',
  '       rule puts the line at the foot of the PAGE, out of view again. The line takes no clicks from the row under it. */',
  '    .wrap > #content { animation-fill-mode:backwards; }',
  '    .cm-todo-status:not(:empty) { position:fixed; left:16px; right:16px; bottom:16px; z-index:310; width:fit-content; margin:0 auto; box-shadow:var(--shadow-md); pointer-events:none; }',
  '    .cm-todo-more { font-size:12.5px; color:#334155; }',
  '    .cm-todo-more summary { cursor:pointer; font-weight:700; color:var(--navy); width:fit-content; padding:2px 4px; margin-left:-4px; border-radius:5px; }',
  '    .cm-todo-more summary:focus-visible { outline:2px solid var(--navy); outline-offset:2px; }',
  '    .cm-todo-more ul { margin:6px 0 0 18px; padding:0; }',
  '    .cm-todo-more li { margin:2px 0; }',
  '    /* "With": who has the case for review (waiting on someone: the amber of the status scale) */',
  '    .cm-with { display:inline-block; border-radius:6px; padding:1px 6px; font-size:10px; font-weight:700; background:var(--st-amber-bg); color:var(--st-amber-fg); white-space:normal; }',
  '    #all-cases-table.cm-wide td.cm-c-with { min-width:110px; max-width:220px; white-space:normal; }',
  '    @media print { .cm-todo-pick, .cm-todo-phone, .cm-todo-in, .cm-todo-status, .cm-todo-more, .cm-todo-ended { display:none !important; } }',
  '',
].join(String.fromCharCode(10));

module.exports = { TODO_CSS, TODO_PAGE_JS, TODO_BOOT_JS, TODO_STATE_JS, TODO_FUNCTIONS };
