/**
 * A search box on top of a long <select> (staff request 2026-11-26: "Case type
 * interest" on Add a lead is a long list — type a few letters, pick one).
 *
 * The <select> stays in the page and stays the one source of truth: the page
 * keeps reading and resetting it exactly as before. This module hides it, puts a
 * text box in its place and writes every pick back to it (with a `change` event).
 * If this script never runs, the plain select is still there and still works.
 *
 * Use on a page:
 *   <style> … ${SEARCH_SELECT_CSS} </style>
 *   <script> … ${SEARCH_SELECT_UI_JS}
 *     var X = tdotSearchSelect('the-select-id', { placeholder: '…' });
 *     … after the page fills or resets the select by code:  X.sync();
 *
 * The three functions below are real functions: the page gets their source
 * (fn.toString()) and the tests call the very same code. They are pasted into a
 * page script that lives inside a Node template literal, so inside them:
 * no backtick, no dollar-brace, no backslash (test/searchSelectUi.test.js checks).
 */

const SEARCH_SELECT_CSS = `
  .ss-wrap { scroll-margin:64px 0 88px; }   /* room for the pop-up's pinned title and pinned buttons when the list is scrolled into view */
  .ss-box { position:relative; }
  .ss-in { width:100%; box-sizing:border-box; }
  .ss-x { position:absolute; top:50%; right:4px; transform:translateY(-50%); width:28px; height:28px; display:flex; align-items:center; justify-content:center; border:0; border-radius:6px; background:transparent; color:var(--st-grey-solid, #64748b); font:inherit; font-size:18px; line-height:1; cursor:pointer; padding:0; }
  .ss-x[hidden] { display:none; }
  .ss-x:hover { background:var(--st-grey-bg, #e8edf3); color:var(--st-grey-fg, #334155); }
  .ss-list { position:relative; background:#fff; border:1px solid #cbd5e1; border-radius:8px; box-shadow:0 6px 18px rgba(15,23,42,.12); margin-top:4px; max-height:220px; overflow-y:auto; padding:4px; }   /* in the flow: a pop-up's scroll area would cut off a floating list */
  .ss-list[hidden] { display:none; }
  .ss-opt { border-radius:6px; padding:7px 9px; font-size:13px; line-height:1.35; color:#0f172a; cursor:pointer; overflow-wrap:anywhere; }
  .ss-opt.ss-blank { color:var(--st-grey-solid, #64748b); }
  .ss-opt:hover { background:#f1f5f9; }
  .ss-opt.on { background:var(--st-blue-bg, #dbeafe); color:var(--st-blue-fg, #1e40af); }
  .ss-opt[aria-selected="true"] { font-weight:700; }
  .ss-empty { padding:8px 9px; font-size:12.5px; color:var(--st-grey-solid, #64748b); }
  @media (max-width: 760px) {
    .ss-opt, .ss-empty { font-size:16px; }
    .ss-opt { padding:11px 10px; }
    .ss-list { max-height:184px; }
    .ss-x { width:36px; height:36px; }
  }
`;

/** Lower case, every kind of blank space turned into one plain space, none at the ends. */
function tdotSearchNorm(s) {
  s = String(s == null ? '' : s).toLowerCase();
  var out = '', i, c;
  for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); out += (c <= 32 || c === 160) ? ' ' : s.charAt(i); }
  return out.split(' ').filter(function (w) { return !!w; }).join(' ');
}

/** True when every typed word is somewhere in the name (any order, any case). Nothing typed matches everything. */
function tdotSearchMatch(name, query) {
  var n = tdotSearchNorm(name), words = tdotSearchNorm(query).split(' '), i;
  for (i = 0; i < words.length; i++) if (words[i] && n.indexOf(words[i]) < 0) return false;
  return true;
}

/** The names that match what was typed, in their own order. */
function tdotSearchFilter(names, query) {
  return (names || []).filter(function (n) { return tdotSearchMatch(n, query); });
}

/**
 * Turn <select id=selectId> into a search box. Returns { sync, input, list } —
 * call sync() after the page fills or resets the select by code (it sends no
 * event, so an untouched form stays "untouched").
 */
function tdotSearchSelect(selectId, opts) {
  opts = opts || {};
  var sel = document.getElementById(selectId);
  if (!sel || !sel.parentNode) return null;
  if (sel.tdotSearch) return sel.tdotSearch;
  var base = selectId + '-ss';
  var wrap = document.createElement('div'), box = document.createElement('div'), input = document.createElement('input'),
      clear = document.createElement('button'), list = document.createElement('div');
  var items = [], optEls = [], active = -1, opened = false, mine = false;

  wrap.className = 'ss-wrap'; wrap.id = base;
  box.className = 'ss-box';
  input.type = 'text'; input.id = base + '-in'; input.className = 'ss-in';
  input.setAttribute('autocomplete', 'off'); input.setAttribute('spellcheck', 'false');
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', base + '-list');
  input.setAttribute('placeholder', opts.placeholder || 'Type to search');
  input.style.paddingRight = '38px';   /* room for the clear button — set here, a page rule on its inputs would win over a class */
  clear.type = 'button'; clear.className = 'ss-x'; clear.textContent = '×'; clear.hidden = true;
  clear.setAttribute('tabindex', '-1'); clear.setAttribute('aria-label', 'Clear'); clear.setAttribute('title', 'Clear');
  list.id = base + '-list'; list.className = 'ss-list'; list.hidden = true; list.setAttribute('role', 'listbox');
  box.appendChild(input); box.appendChild(clear); wrap.appendChild(box); wrap.appendChild(list);

  var label = sel.labels && sel.labels[0];
  sel.parentNode.insertBefore(wrap, sel);
  if (label) { label.htmlFor = input.id; list.setAttribute('aria-label', label.textContent || ''); }
  else if (sel.getAttribute('aria-label')) { input.setAttribute('aria-label', sel.getAttribute('aria-label')); list.setAttribute('aria-label', sel.getAttribute('aria-label')); }
  sel.style.display = 'none';   /* hidden, not disabled: the page still reads its value */

  function all() { var out = [], o = sel.options, i; for (i = 0; i < o.length; i++) out.push({ v: o[i].value, t: o[i].text }); return out; }
  function blank() { var a = all(), i; for (i = 0; i < a.length; i++) if (a[i].v === '') return a[i]; return null; }
  function current() { var i = sel.selectedIndex, o = i >= 0 ? sel.options[i] : null; return o ? { v: o.value, t: o.text } : { v: '', t: '' }; }
  function shown() { var c = current(); return c.v === '' ? '' : c.t; }   /* the blank choice shows as an empty box */
  function setText() { input.value = shown(); input.title = input.value; clear.hidden = !input.value; }   /* the title shows a long name in full */
  /* What to filter by: the box showing exactly the picked value means "show the whole list". */
  function query() { return tdotSearchNorm(input.value) === tdotSearchNorm(shown()) ? '' : input.value; }
  function setActive(i) {
    var j, el;
    active = i;
    for (j = 0; j < optEls.length; j++) optEls[j].className = optEls[j].className.replace(' on', '') + (j === i ? ' on' : '');
    el = optEls[i];
    if (!el) { input.removeAttribute('aria-activedescendant'); return; }
    input.setAttribute('aria-activedescendant', el.id);
    /* keep it in sight inside the list only — the pop-up behind does not jump on every arrow key */
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
  }
  function render(q) {
    var a = all(), cur = current().v, b = null, first = -1, at = -1, i, d;
    items = []; optEls = [];
    for (i = 0; i < a.length; i++) {
      if (a[i].v === '') { if (!b) { b = a[i]; items.unshift(b); } }   /* the blank choice is always offered, first */
      else if (tdotSearchMatch(a[i].t, q)) items.push(a[i]);
    }
    while (list.firstChild) list.removeChild(list.firstChild);
    for (i = 0; i < items.length; i++) {
      d = document.createElement('div');
      d.className = 'ss-opt' + (items[i].v === '' ? ' ss-blank' : '');
      d.id = base + '-o' + i; d.setAttribute('role', 'option'); d.setAttribute('data-i', String(i));
      d.setAttribute('aria-selected', items[i].v === cur ? 'true' : 'false');
      d.textContent = items[i].t;   /* as text: a name is never read as HTML */
      list.appendChild(d); optEls.push(d);
      if (items[i].v === cur) at = i;
      if (first < 0 && items[i].v !== '') first = i;
    }
    if (first < 0 && tdotSearchNorm(q)) {
      d = document.createElement('div'); d.className = 'ss-empty'; d.textContent = 'No match. Try fewer letters.';
      list.appendChild(d);
    }
    /* typing: Enter takes the first match. Just opened: the arrow keys start from the picked one. */
    setActive(tdotSearchNorm(q) ? first : at);
  }
  function reveal() {
    var phone = false;
    try { phone = !!(window.matchMedia && window.matchMedia('(max-width: 760px)').matches); } catch (e) {}
    /* a phone has the keyboard over the lower half: the box goes to the top so the list has room */
    if (wrap.scrollIntoView) wrap.scrollIntoView({ block: phone ? 'start' : 'nearest' });
  }
  function open(q) {
    render(q);
    if (!opened) { opened = true; list.hidden = false; input.setAttribute('aria-expanded', 'true'); reveal(); }
  }
  function close() {
    opened = false; list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    while (list.firstChild) list.removeChild(list.firstChild);
    items = []; optEls = []; active = -1;
  }
  function choose(it) {
    var changed = sel.value !== it.v, ev;
    sel.value = it.v; setText();
    if (!changed) return;
    mine = true;
    try {
      if (typeof Event === 'function') ev = new Event('change', { bubbles: true });
      else { ev = document.createEvent('Event'); ev.initEvent('change', true, false); }
      sel.dispatchEvent(ev);
    } catch (e) {}
    mine = false;
  }
  function mark() { if (input.value && input.select && document.activeElement === input) input.select(); }   /* the pick is selected: typing again replaces it, it is not added to */
  function pick(i) { var it = items[i]; if (!it) return; choose(it); close(); mark(); }
  /* Leaving the box: only a real choice stays. Empty = the blank choice; a full name typed out = that one; anything else = back to the last pick. */
  function commit() {
    var t = tdotSearchNorm(input.value), a, i, b;
    if (t === tdotSearchNorm(shown())) { setText(); return; }
    if (!t) { b = blank(); if (b) choose(b); else setText(); return; }
    a = all();
    for (i = 0; i < a.length; i++) if (a[i].v !== '' && tdotSearchNorm(a[i].t) === t) { choose(a[i]); return; }
    setText();
  }
  /* The page filled or reset the select by code. No event goes out. Someone typing right now keeps their text. */
  function sync() {
    if (opened && document.activeElement === input) { render(query()); return; }
    close(); setText();
  }

  input.addEventListener('input', function () { clear.hidden = !input.value; open(input.value); });
  input.addEventListener('click', function () { if (!opened) { open(query()); if (!query()) mark(); } });
  input.addEventListener('focus', mark);
  input.addEventListener('keydown', function (e) {
    var k = e.key, n;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      if (!opened) { open(query()); return; }
      n = optEls.length; if (!n) return;
      setActive(active < 0 ? (k === 'ArrowDown' ? 0 : n - 1) : (active + (k === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (k === 'Enter') {
      if (!opened) return;
      e.preventDefault();
      if (active >= 0) pick(active);
    } else if (k === 'Escape' || k === 'Esc') {
      if (!opened) return;   /* list closed: Escape is the pop-up's */
      e.preventDefault(); e.stopPropagation();   /* list open: close the list only, never the pop-up */
      close(); setText(); mark();
    }
  });
  input.addEventListener('blur', function () {
    commit();   /* now, not later: a click on the page's Save button reads the select straight away */
    setTimeout(function () { if (document.activeElement !== input) close(); }, 150);
  });
  /* The box's own change event (the browser sends one when a typed-in box loses focus) stops here: the select's is the only one the page hears. */
  input.addEventListener('change', function (e) { e.stopPropagation(); });
  list.addEventListener('mousedown', function (e) { e.preventDefault(); });   /* keep focus in the box while clicking a choice */
  list.addEventListener('click', function (e) {
    var t = e.target, i;
    while (t && t !== list) {
      i = t.getAttribute ? t.getAttribute('data-i') : null;
      if (i != null) { pick(Number(i)); return; }
      t = t.parentNode;
    }
  });
  clear.addEventListener('mousedown', function (e) { e.preventDefault(); });
  clear.addEventListener('click', function () {
    var b = blank();
    if (b) choose(b);
    input.value = ''; clear.hidden = true; close();
    if (input.focus) input.focus();
  });
  sel.addEventListener('change', function () { if (!mine) sync(); });   /* the value moved from somewhere else */
  if (typeof MutationObserver === 'function') new MutationObserver(sync).observe(sel, { childList: true });   /* the list was loaded or re-loaded */

  setText();
  sel.tdotSearch = { sync: sync, input: input, list: list, select: sel };
  return sel.tdotSearch;
}

const NL = String.fromCharCode(10);
const SEARCH_SELECT_FUNCTIONS = [tdotSearchNorm, tdotSearchMatch, tdotSearchFilter, tdotSearchSelect];
/** For a page script: the four functions above, as written. */
const SEARCH_SELECT_UI_JS = '/* ── Search box on a long list (searchSelectUi.js) ── */' + NL
  + SEARCH_SELECT_FUNCTIONS.map(function (f) { return f.toString(); }).join(NL) + NL;

module.exports = { SEARCH_SELECT_CSS, SEARCH_SELECT_UI_JS, tdotSearchNorm, tdotSearchMatch, tdotSearchFilter, tdotSearchSelect };
