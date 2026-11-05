/**
 * One pop-up for the whole staff app (team meeting 2026-11-05, point 3 — "every
 * pop-up looks and behaves the same").
 *
 * Every pop-up — Add lead, New direct retainer client, Delete, the payment
 * dialogs, the Not Wanted dialogs — is driven by tdotDialog(), so they all:
 *   - sit above the top bar (z-index 1200) and dim the whole page;
 *   - have a title, a × in the corner, and Cancel before the main button;
 *   - close on ×, Cancel and Escape — and on a click outside ONLY when nothing
 *     has been typed or chosen in them (Faran 2026-11-05: a half-filled form
 *     must never vanish because of a stray click), and only when the press
 *     started outside too (selecting text and letting go outside never closes);
 *   - can't be closed while they are saving — but never get stuck: after
 *     GRACE_MS without an answer they say so and can be closed again;
 *   - keep Tab inside, stop the page behind from scrolling, and give focus back
 *     to the button that opened them;
 *   - become a bottom sheet on a phone, with the title and buttons always in
 *     view.
 * Escape that something inside already used (the client search list) is left
 * alone: the listener is a document bubble listener that honours
 * e.defaultPrevented.
 *
 * TEMPLATE-LITERAL TRAP: DIALOG_UI_JS / DIALOG_UI_CSS are interpolated into the
 * pages' own template literals — NO backticks, NO dollar-brace, NO backslashes
 * (test/dialogUi.test.js checks). The code is idempotent: pages that include it
 * more than once (it travels inside the Delete, payment and Not Wanted modules)
 * share one state object on window.
 */

const GRACE_MS = 45000;

const DIALOG_UI_CSS = `
  .tdlg-ov { position:fixed; inset:0; background:rgba(15,23,42,.5); display:flex; align-items:center; justify-content:center; z-index:1200; padding:20px; }
  .tdlg-ov[hidden] { display:none; }
  .tdlg { position:relative; display:flex; flex-direction:column; width:100%; max-width:520px; max-height:88vh; background:#fff; border-radius:14px; box-shadow:0 20px 50px rgba(2,6,23,.4); color:#0f172a; font-size:13.5px; overflow:hidden; text-align:left; }
  .tdlg:focus { outline:none; }
  .tdlg.tdlg-narrow { max-width:460px; }
  .tdlg-body { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:20px 24px 18px; }
  /* Sticky offsets count from inside the body's padding: -20px / -18px pin the title and the buttons to the very edges. */
  .tdlg-body > h3:first-child { position:sticky; top:-20px; z-index:1; background:#fff; margin:-20px -24px 4px; padding:18px 56px 8px 24px; font-size:17px; line-height:1.3; color:var(--navy, #1a3558); }
  .tdlg-body > h3.danger:first-child { color:#b91c1c; }
  .tdlg-x { position:absolute; top:8px; right:8px; z-index:2; width:40px; height:40px; display:flex; align-items:center; justify-content:center; border:none; border-radius:10px; background:transparent; color:#64748b; font-size:22px; line-height:1; cursor:pointer; font-family:inherit; }
  .tdlg-x:hover { background:#f1f5f9; color:#0f172a; }
  .tdlg-x:focus-visible { outline:2px solid #2563eb; outline-offset:-2px; }
  .tdlg-x:disabled { opacity:.35; cursor:not-allowed; background:transparent; }
  .tdlg-body > .tdlg-actions, .tdlg-body > .paym-actions, .tdlg-body > .delm-actions, .tdlg-body > .blm-actions, .tdlg-body > .dc-actions {
    position:sticky; bottom:-18px; z-index:1; display:flex; justify-content:flex-end; flex-wrap:wrap; gap:8px; background:#fff; border-top:1px solid #f1f5f9; margin:14px -24px -18px; padding:12px 24px 16px; }
  .tdlg-btn, .tdlg .paym-btn, .tdlg .delm-btn, .tdlg .blm-btn, .tdlg .dc-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:38px; padding:8px 16px; border-radius:8px; border:1px solid #e2e8f0; background:#fff; color:var(--navy, #1a3558); font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; text-decoration:none; }
  .tdlg-btn:hover, .tdlg .paym-btn:hover, .tdlg .delm-btn:hover, .tdlg .blm-btn:hover, .tdlg .dc-btn:hover { background:#f8fafc; }
  .tdlg .primary, .tdlg-btn.primary { background:var(--navy, #1a3558); border-color:var(--navy, #1a3558); color:#fff; }
  .tdlg .primary:hover { background:var(--navy-light, #224472); }
  .tdlg .danger:not(h3), .tdlg-btn.danger { background:#dc2626; border-color:#dc2626; color:#fff; }
  .tdlg .danger:not(h3):hover { background:#b91c1c; }
  .tdlg button:disabled { opacity:.45; cursor:not-allowed; }
  .tdlg button:focus-visible, .tdlg a.paym-btn:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
  .tdlg-err, .tdlg .paym-err, .tdlg .delm-err, .tdlg .blm-err { color:#dc2626; font-size:12.5px; line-height:1.45; min-height:16px; margin-top:10px; }
  .tdlg-slow { background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:8px 12px; font-size:12.5px; color:#92400e; margin-top:10px; }
  /* The page behind does not scroll. Only html: overflow on body too would make body a scroll box and the sticky top bar would jump away. */
  html.tdlg-lock { overflow:hidden; }
  @media (prefers-reduced-motion: no-preference) {
    .tdlg-ov:not([hidden]) .tdlg { animation:tdlg-in .16s ease-out; }
    @keyframes tdlg-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  }
  /* Phones: a bottom sheet — full width, rounded top, the title and the buttons pinned, room for the home bar. */
  @media (max-width: 560px) {
    .tdlg-ov { align-items:flex-end; padding:0; }
    .tdlg, .tdlg.tdlg-narrow { max-width:none; max-height:92vh; max-height:92dvh; border-radius:16px 16px 0 0; }
    .tdlg-body { padding:18px 16px 18px; }
    .tdlg-body > h3:first-child { top:-18px; margin:-18px -16px 4px; padding:16px 52px 8px 16px; }
    .tdlg-body > .tdlg-actions, .tdlg-body > .paym-actions, .tdlg-body > .delm-actions, .tdlg-body > .blm-actions, .tdlg-body > .dc-actions {
      flex-wrap:nowrap; margin:14px -16px -18px; padding:12px 16px calc(14px + env(safe-area-inset-bottom)); }
    .tdlg-body > .tdlg-actions > *, .tdlg-body > .paym-actions > *, .tdlg-body > .delm-actions > *, .tdlg-body > .blm-actions > *, .tdlg-body > .dc-actions > * { flex:1 1 0; min-height:44px; }
  }
`;

const DIALOG_UI_JS = `
  /* ── The shared pop-up (dialogUi.js) ── */
  var TDOT_DLG = (typeof window === 'object' && window.TDOT_DLG) || { stack: [], bound: false, grace: ${GRACE_MS} };
  if (typeof window === 'object') window.TDOT_DLG = TDOT_DLG;   /* one state for every copy of this code on the page */
  var TDOT_DLG_FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function tdotDlgTop(){ var s = TDOT_DLG.stack; return s.length ? s[s.length - 1] : null; }
  function tdotDlgFocusables(frame){
    return Array.prototype.filter.call(frame.querySelectorAll(TDOT_DLG_FOCUSABLE), function(el){ return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); });
  }
  function tdotDlgBind(){
    if (TDOT_DLG.bound) return;
    TDOT_DLG.bound = true;
    document.addEventListener('keydown', function(e){
      var d = tdotDlgTop(); if (!d) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (e.defaultPrevented) return;   /* something inside used it (the client search list) */
        e.preventDefault(); d.tryClose('escape'); return;
      }
      if (e.key !== 'Tab') return;
      var f = tdotDlgFocusables(d.frame);
      if (!f.length) { e.preventDefault(); d.frame.focus(); return; }
      var first = f[0], last = f[f.length - 1], at = document.activeElement;
      var inside = d.frame.contains(at);
      if (e.shiftKey && (at === first || at === d.frame || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (at === last || !inside)) { e.preventDefault(); first.focus(); }
    });
    /* Focus that escapes the top pop-up (a click on the page behind is impossible; a script or the browser can) is brought back. */
    document.addEventListener('focusin', function(e){
      var d = tdotDlgTop(); if (!d || !e.target || d.frame.contains(e.target)) return;
      if (d.ov.contains(e.target)) return;
      try { d.frame.focus(); } catch (x) {}
    });
  }
  /* Back to this page from the browser's memory (Back button): no pop-up comes back half-way through saving. */
  if (typeof window === 'object' && window.addEventListener && !TDOT_DLG.pageshow) {
    TDOT_DLG.pageshow = true;
    window.addEventListener('pageshow', function(e){
      if (!e.persisted) return;
      TDOT_DLG.stack.slice().forEach(function(d){ try { d.setBusy(false); d.close(true, 'restore'); } catch (x) {} });
    });
  }
  function tdotDlgLock(){
    var on = TDOT_DLG.stack.length > 0;
    try { document.documentElement.classList.toggle('tdlg-lock', on); } catch (e) {}
  }
  /* A pop-up's controller. ov = the backdrop element (already in the page), opts:
       frame      the role=dialog element (default: ov's .tdlg)
       remove     true = take ov out of the page on close (pop-ups built on the fly); false = hide it (forms written in the page)
       group      opening one closes any other open pop-up of the same group (one payment dialog at a time)
       onClosed   runs after every close, however it happened: onClosed(how, wasBusy)
     Returns { ov, frame, open(), close(), tryClose(), setBusy(on), isOpen(), openId, dirty } */
  function tdotDialog(ov, opts){
    opts = opts || {};
    tdotDlgBind();
    var frame = opts.frame || ov.querySelector('.tdlg') || ov.firstElementChild;
    var c = { ov: ov, frame: frame, opts: opts, open: null, busy: false, slow: false, dirty: false, openId: 0, opener: null, group: opts.group || '' };
    var downOutside = false, slowTimer = null, xBtn = frame.querySelector('.tdlg-x');
    if (!xBtn) {
      xBtn = document.createElement('button');
      xBtn.type = 'button'; xBtn.className = 'tdlg-x'; xBtn.setAttribute('aria-label', 'Close'); xBtn.innerHTML = '&times;';
      frame.insertBefore(xBtn, frame.firstChild);
    }
    xBtn.addEventListener('click', function(){ c.tryClose('x'); });
    if (!frame.hasAttribute('tabindex')) frame.setAttribute('tabindex', '-1');
    frame.setAttribute('role', 'dialog'); frame.setAttribute('aria-modal', 'true');
    /* "Typed or chosen something" — real edits only (a value set by the page is not an edit). */
    frame.addEventListener('input', function(){ c.dirty = true; });
    frame.addEventListener('change', function(){ c.dirty = true; });
    /* Outside = the press AND the release are on the backdrop itself. */
    ov.addEventListener('pointerdown', function(e){ downOutside = (e.target === ov); });
    ov.addEventListener('click', function(e){
      var was = downOutside; downOutside = false;
      if (e.target !== ov || !was) return;
      if (e.detail > 1) return;   /* the second click of the double-click that opened it */
      if (c.dirty) return;   /* something typed or chosen: an outside click never throws it away */
      c.tryClose('outside');
    });
    function isOpen(){ return TDOT_DLG.stack.indexOf(c) >= 0; }
    c.isOpen = isOpen;
    c.open = function(){
      if (c.group) TDOT_DLG.stack.slice().forEach(function(o){ if (o !== c && o.group === c.group) o.close(true); });
      if (isOpen()) { try { frame.focus(); } catch (e) {} return c; }
      c.openId++; c.dirty = false; c.setBusy(false);
      c.opener = document.activeElement;
      ov.hidden = false; if (ov.style.display === 'none') ov.style.display = '';
      TDOT_DLG.stack.push(c); tdotDlgLock();
      /* An open list filter panel closes (Escape then belongs to the pop-up). */
      try { document.dispatchEvent(new CustomEvent('tdot-dialog-open')); } catch (e) {}
      /* Focus leaves the button at once (Enter pressed twice must not open a second one); the page then focuses its first box. */
      try { frame.focus(); } catch (e) {}
      return c;
    };
    /* A person closing it (×, Cancel, Escape, outside): refused while saving, until the wait has gone on too long. */
    c.tryClose = function(how){
      if (c.busy && !c.slow) return false;
      return c.close(true, how);
    };
    /* The page closing it. While saving it stays open unless forced. */
    c.close = function(force, how){
      if (!isOpen()) return false;
      if (c.busy && !c.slow && force !== true) return false;
      TDOT_DLG.stack.splice(TDOT_DLG.stack.indexOf(c), 1);
      var wasBusy = c.busy;   /* closed while a request still ran (after the long wait) */
      c.setBusy(false);
      if (opts.remove) { if (ov.parentNode) ov.parentNode.removeChild(ov); }
      else { ov.hidden = true; }
      tdotDlgLock();
      var opener = c.opener; c.opener = null;
      var under = tdotDlgTop();
      try {
        if (opener && opener.focus && document.body.contains(opener) && (!under || under.frame.contains(opener))) opener.focus();
        else if (under) under.frame.focus();
      } catch (e) {}
      if (opts.onClosed) { try { opts.onClosed(how || '', wasBusy); } catch (e) { setTimeout(function(){ throw e; }, 0); } }
      return true;
    };
    function slowNote(on){
      var n = frame.querySelector('.tdlg-slow');
      if (!on) { if (n && n.parentNode) n.parentNode.removeChild(n); return; }
      if (n) return;
      n = document.createElement('div'); n.className = 'tdlg-slow'; n.setAttribute('role', 'status');
      n.textContent = opts.slowText || 'Still waiting for an answer. You can close this window, but check the list before trying again, so nothing is done twice.';
      var body = frame.querySelector('.tdlg-body') || frame;
      var acts = null;
      for (var i = body.children.length - 1; i >= 0 && !acts; i--) {
        var k = body.children[i];
        if (['tdlg-actions', 'paym-actions', 'delm-actions', 'blm-actions', 'dc-actions'].some(function(n){ return k.classList.contains(n); })) acts = k;
      }
      body.insertBefore(n, acts);
    }
    /* Saving: no closing (the answer must land in THIS pop-up, for THIS person). After the grace time it can be closed again. */
    c.setBusy = function(on){
      on = !!on;
      clearTimeout(slowTimer); slowTimer = null;
      c.busy = on; c.slow = false; slowNote(false);
      xBtn.disabled = on;
      if (on) frame.setAttribute('aria-busy', 'true'); else frame.removeAttribute('aria-busy');
      Array.prototype.forEach.call(frame.querySelectorAll('[data-x]'), function(b){ if (b.tagName === 'BUTTON') b.disabled = on; });
      if (on) slowTimer = setTimeout(function(){ if (!c.busy) return; c.slow = true; xBtn.disabled = false; Array.prototype.forEach.call(frame.querySelectorAll('[data-x]'), function(b){ if (b.tagName === 'BUTTON') b.disabled = false; }); slowNote(true); }, TDOT_DLG.grace);
      return c;
    };
    /* After an await: is this still the same opening of the same pop-up? */
    c.still = function(id){ return isOpen() && id === c.openId; };
    return c;
  }
  /* A pop-up built on the fly: backdrop + frame + × + a scrolling body the caller fills (d.box). */
  function tdotDialogNew(o){
    o = o || {};
    var ov = document.createElement('div');
    ov.className = 'tdlg-ov' + (o.ovClass ? ' ' + o.ovClass : '');
    ov.innerHTML = '<div class="tdlg' + (o.cls ? ' ' + o.cls : '') + '"' + (o.labelledBy ? ' aria-labelledby="' + o.labelledBy + '"' : '') + '><button type="button" class="tdlg-x" aria-label="Close">&times;</button><div class="tdlg-body"></div></div>';
    document.body.appendChild(ov);
    var c = tdotDialog(ov, { remove: true, group: o.group, onClosed: o.onClosed, slowText: o.slowText });
    c.box = ov.querySelector('.tdlg-body');
    c.open();
    return c;
  }
`;

module.exports = { DIALOG_UI_CSS, DIALOG_UI_JS, GRACE_MS };
