'use strict';

/**
 * The Client Master page's "Columns" button (team meeting 2026-11-10, item 13: "making a view, like selecting
 * columns, hiding them or making them visible"; Faran 2026-11-12: each person's choice is remembered on their
 * own browser).
 *
 * A button in the table toolbar opens a small panel — the same look and behaviour as the lists' filter panels —
 * with the columns of the tab on view as tick boxes. The rules (what a tab offers, the equivalents, the order,
 * what is kept) are pure and live in clientMasterUi.js (colPlan, colIds, colToggle …); this is only the keeping,
 * the panel and the button.
 *
 * Kept in this browser's localStorage under ONE versioned key, as the difference from each tab's default
 * ({ v: 1, tabs: { all | viewKey: { hidden: [ids], added: [ids] } } }). It is a view preference, not case data:
 * it holds column ids only, and Sign Out leaves it (the sign-out clean-up removes the lists' filters — the
 * sessionStorage keys starting tdot_list_ — and the notes drafts, never this key). Storage blocked: the choice
 * lasts for the page view. Never written once the page is signed out (window.TDOT_SIGNED_OUT).
 *
 * Plain browser JavaScript injected with Function#toString (like listCore): the function refers to nothing
 * outside itself. Node requires this file for the tests.
 *
 * cfg: { key, tabCols: { '': [ids], viewKey: [ids] }, names: { id: label }, tabName(tab) -> 'All' | 'Assigning' …,
 *        tab() -> the tab on view ('' = All), onChange() (redraw the table and its header), ids: { btn, pop } }
 */

/* eslint-disable no-var */
function clientMasterColumnsUi(win, CMU, cfg) {
  var doc = win.document, KEY = cfg.key, TC = cfg.tabCols || {}, NAMES = cfg.names || {};
  var prefs = {};                 // { all | viewKey: { hidden, added } } — the choices, in memory (and kept, where the browser lets us)
  var plans = {}, chosen = {};    // per tab: what it offers, and the ids to draw (worked out once per change)
  var isOpen = false, openTab = '', pop = null, wired = false;

  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function read() { try { return CMU.colStore(JSON.parse(win.localStorage.getItem(KEY) || 'null')); } catch (e) { return null; } }
  var kept = read();
  if (kept) prefs = kept;

  function plan(tab) { var t = tab == null ? '' : String(tab); if (!plans[t]) plans[t] = CMU.colPlan(TC, t); return plans[t]; }
  function pref(tab) { var p = plan(tab); return CMU.colPref(p, prefs[CMU.colTabKey(p.tab)]); }
  /** The column ids to draw on a tab, in order. */
  function ids(tab) { var p = plan(tab); if (!chosen[p.tab]) chosen[p.tab] = CMU.colIds(p, prefs[CMU.colTabKey(p.tab)]); return chosen[p.tab]; }
  function summary(tab) { return CMU.colSummary(plan(tab), prefs[CMU.colTabKey(plan(tab).tab)]); }
  function wide(tab) { return CMU.colWide(TC, plan(tab).tab, ids(tab)); }
  function nameOf(id) { return NAMES[id] || id; }
  function tabName(tab) { var n = ''; try { n = cfg.tabName ? cfg.tabName(plan(tab).tab) : ''; } catch (e) { n = ''; } return n || 'All'; }
  function nowTab() { var t = ''; try { t = cfg.tab ? cfg.tab() : ''; } catch (e) { t = ''; } return plan(t).tab; }

  /* Keep one tab's choice. The stored value is read again first, so a choice made for ANOTHER tab in another browser
     tab is not written over. Nothing to keep on any tab = the key is removed. */
  function keep(tab) {
    if (win.TDOT_SIGNED_OUT) return;
    try {
      var k = CMU.colTabKey(tab), now = read() || {};
      if (prefs[k]) now[k] = prefs[k]; else delete now[k];
      var out = CMU.colStoreOut(now);
      if (out) win.localStorage.setItem(KEY, JSON.stringify(out)); else win.localStorage.removeItem(KEY);
    } catch (e) { /* not kept — the choice lasts for this page view */ }
  }
  function setPref(tab, next) {
    var p = plan(tab), k = CMU.colTabKey(p.tab), clean = CMU.colPref(p, next);
    if (clean.hidden.length || clean.added.length) prefs[k] = clean; else delete prefs[k];
    chosen[p.tab] = null;
    keep(p.tab);
    try { if (cfg.onChange) cfg.onChange(p.tab); } catch (e) { /* the redraw is the page's */ }
    sync(nowTab());
  }
  function toggle(tab, id, on) { var p = plan(tab); setPref(p.tab, CMU.colToggle(p, prefs[CMU.colTabKey(p.tab)], String(id), on === true)); }
  function reset(tab) { setPref(tab, null); }

  // ── the button ──
  function btn() { return doc.getElementById(cfg.ids.btn); }
  function drawBtn(tab) {
    var b = btn();
    if (!b) return;
    var sum = summary(tab), name = tabName(tab);
    b.innerHTML = 'Columns' + (sum.custom ? '<span class="cm-cols-n"> · ' + esc(sum.text) + '</span>' : '');
    b.setAttribute('aria-label', 'Columns on ' + name + (sum.custom ? ': ' + sum.text : ''));
    b.setAttribute('title', sum.custom ? 'This tab does not show its default columns (' + sum.text + '). Press to choose the columns, or to go back to the default.' : 'Choose the columns of this tab');
    b.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (b.classList) { b.classList.toggle('on', sum.custom); b.classList.toggle('open', isOpen); }
  }

  // ── the panel ──
  function popEl() {
    if (pop) return pop;
    pop = doc.getElementById(cfg.ids.pop);
    if (!pop) { pop = doc.createElement('div'); pop.id = cfg.ids.pop; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'false'); doc.body.appendChild(pop); }
    if (pop.classList) pop.classList.add('lt-pop');
    return pop;
  }
  function panelHtml(tab) {
    var p = plan(tab), pr = pref(p.tab), sum = summary(p.tab);
    function row(id, on) {
      var lock = p.locked.indexOf(id) >= 0;
      return '<label class="qp-row' + (lock ? ' cmc-lock' : '') + '"><input type="checkbox" data-colpick="' + esc(id) + '"' + (on ? ' checked' : '') + (lock ? ' disabled' : '') + '> <span>' + esc(nameOf(id)) + '</span>'
        + (lock ? '<span class="qp-c">Always shown</span>' : '') + '</label>';
    }
    return '<div class="qp-h"><span>Columns on ' + esc(tabName(p.tab)) + '</span><button type="button" class="qp-x" data-act="close" aria-label="Close">×</button></div><div class="qp-b">'
      + '<div class="qp-sec"><div class="qp-list">' + p.own.map(function (id) { return row(id, pr.hidden.indexOf(id) < 0); }).join('') + '</div></div>'
      + (p.extra.length ? '<div class="qp-sec"><div class="qp-t">More columns</div><div class="qp-list">' + p.extra.map(function (id) { return row(id, pr.added.indexOf(id) >= 0); }).join('') + '</div></div>' : '')
      + '</div><div class="qp-f"><button type="button" class="qp-link" data-act="reset"' + (sum.custom ? '' : ' disabled') + '>Reset to default</button>'
      + '<button type="button" class="qp-done" data-act="close">Done</button></div>';
  }
  function each(sel, fn) { var el = popEl(); if (el.querySelectorAll) Array.prototype.forEach.call(el.querySelectorAll(sel), fn); }
  function drawPanel() {
    var el = popEl();
    el.innerHTML = panelHtml(openTab);
    el.setAttribute('aria-label', 'Columns on ' + tabName(openTab));
    each('[data-act="close"]', function (b) { b.onclick = function () { close(true); }; });
    each('[data-act="reset"]', function (b) {
      b.onclick = function () {
        reset(openTab);
        if (!isOpen) return;
        drawPanel();   // every box back to the default; the Reset button is off now, so the focus goes to Done
        var done = popEl().querySelector ? popEl().querySelector('.qp-done') : null;
        if (done) done.focus();
      };
    });
    each('[data-colpick]', function (i) { i.onchange = function () { toggle(openTab, i.getAttribute('data-colpick'), i.checked === true); }; });
  }
  function place() {
    var b = btn(), el = popEl();
    if (!b || !b.getBoundingClientRect) return;
    var r = b.getBoundingClientRect(), w = Math.min(300, win.innerWidth - 24);
    el.style.width = w + 'px';
    el.style.left = Math.max(12, Math.min(r.right - w, win.innerWidth - w - 12)) + 'px';
    // never taller than the room there is: below the button — or above it when there is more room there — so the
    // heading, Reset to default and Done stay on screen and the list scrolls inside the panel
    var below = win.innerHeight - r.bottom - 18, above = r.top - 18;
    if (below >= 260 || below >= above) {
      el.style.maxHeight = Math.max(120, below) + 'px';
      el.style.top = (r.bottom + 6) + 'px';
    } else {
      var h = Math.max(120, Math.min(above, 520));
      el.style.maxHeight = h + 'px';
      el.style.top = Math.max(12, r.top - 6 - Math.min(h, el.offsetHeight || h)) + 'px';
    }
  }
  function open() {
    wire();
    try { doc.dispatchEvent(new win.CustomEvent('tdot-list-open', { detail: KEY })); } catch (e) { /* old browser: the outside press closes the other panel */ }
    isOpen = true; openTab = nowTab();
    var el = popEl();
    el.style.display = 'flex';
    drawPanel(); place(); drawBtn(openTab);
    var first = el.querySelector ? el.querySelector('.qp-b input:not([disabled])') : null;
    if (first) first.focus();
  }
  function close(refocus) {
    if (!isOpen) return;
    isOpen = false;
    popEl().style.display = 'none';
    drawBtn(nowTab());
    if (refocus) { var b = btn(); if (b) b.focus(); }
  }
  /** After every draw of the table: the button says how far the tab on view is from its default; a panel open for another tab closes. */
  function sync(tab) {
    wire();
    var t = plan(tab).tab;
    if (isOpen && t !== openTab) close(false);
    drawBtn(t);
    if (isOpen) {   // the Reset button follows the choice (the boxes are the person's own clicks: left as they are)
      var rs = popEl().querySelector ? popEl().querySelector('[data-act="reset"]') : null;
      if (rs) rs.disabled = !summary(t).custom;
    }
  }
  function inside(node, target) { return !!(node && target && node.contains && node.contains(target)); }
  function wire() {
    var b = btn();
    if (b && !b.onclick) b.onclick = function (e) { if (e && e.stopPropagation) e.stopPropagation(); if (isOpen) close(true); else open(); };
    if (wired) return;
    wired = true;
    doc.addEventListener('keydown', function (e) {
      if (win.TDOT_DLG && win.TDOT_DLG.stack && win.TDOT_DLG.stack.length) return;   /* a pop-up is open: Escape is its */
      if (e.key === 'Escape' && isOpen && !e.defaultPrevented) { e.preventDefault(); close(true); }
    });
    doc.addEventListener('mousedown', function (e) { if (isOpen && !inside(popEl(), e.target) && !inside(btn(), e.target)) close(false); });
    doc.addEventListener('tdot-dialog-open', function () { close(false); });
    doc.addEventListener('tdot-list-open', function (e) { if (!e || e.detail !== KEY) close(false); });   /* a column's filter panel opened */
    win.addEventListener('resize', function () { if (isOpen) place(); });
    win.addEventListener('scroll', function () { if (isOpen) place(); }, true);
  }
  if (btn()) { wire(); drawBtn(nowTab()); }

  return { key: KEY, ids: ids, plan: plan, pref: pref, summary: summary, wide: wide, toggle: toggle, reset: reset, sync: sync,
    open: open, close: function () { close(false); }, isOpen: function () { return isOpen; }, panelHtml: panelHtml };
}

module.exports = { clientMasterColumnsUi: clientMasterColumnsUi, CM_COLUMNS_KEY: 'tdot_view_cm_columns_v1' };
