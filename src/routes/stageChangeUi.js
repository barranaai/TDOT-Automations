'use strict';

/**
 * The "Change stage" pop-up (2026-11-26, switch STAGE_EDIT) — ONE piece of browser JS + CSS, built so the
 * case page can use it later; only the Client Master page carries it for now. It is the shared pop-up
 * (dialogUi.js tdotDialogNew). The server (caseStageService) is the authority for every rule: the pop-up
 * asks it first what each stage would do (a fresh read), shows that, and the server checks everything again.
 *
 * The page must already carry: DIALOG_UI_JS/CSS (tdotDialogNew), escHtml(), peekKey().
 * Include STAGE_CHANGE_CSS in the page's <style> and STAGE_CHANGE_JS in the page's <script>.
 *
 * TEMPLATE-LITERAL TRAP: these strings are interpolated into the pages' own template literals —
 * NO backticks, NO dollar-brace, NO backslashes (test/caseStageUi.test.js checks).
 *
 *   window.tdotStageChange({ previewUrl, url, itemId, caseLine, nowLabel, expected, onSaved, onCurrent, focusBack })
 *     nowLabel  the stage the page shows ('' = none); expected its label index (5 = blank)
 *     onSaved   function(answer)          — Monday kept it (also called for "no change needed")
 *     onCurrent function(current, row)    — Monday has another stage now: { index, label } (+ the row the server rebuilt, or null)
 *     focusBack function()                — after it closes with the focus lost (its button redrawn), put it on the page's button
 */

const STAGE_CHANGE_CSS = `
  .stc-dlg .stc-case { font-size:13px; color:#334155; margin:2px 0 6px; }
  .stc-dlg .stc-now { font-size:13px; color:#334155; }
  .stc-dlg .stc-lk { font-size:12px; color:#64748b; font-weight:400; }
  .stc-dlg .stc-moved { font-size:13px; color:#92400e; background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:6px 10px; margin:2px 0 8px; }
  .stc-dlg .stc-moved:empty { display:none; }
  .stc-dlg .stc-l { display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:#64748b; margin:12px 0 4px; font-weight:700; }
  .stc-dlg .stc-sel { display:block; width:100%; box-sizing:border-box; border:1px solid #d1d5db; border-radius:6px; padding:7px 10px; font:inherit; font-size:14px; color:#0f172a; background:#fff; }
  .stc-dlg .stc-hint { font-size:12px; color:#64748b; margin-top:3px; }
  .stc-dlg .stc-hint:empty { display:none; }
  .stc-dlg .stc-why { margin-top:10px; font-size:12px; color:#64748b; }
  .stc-dlg .stc-why summary { cursor:pointer; color:#475569; }
  .stc-dlg .stc-why summary:focus-visible { outline:2px solid #2563eb; outline-offset:2px; border-radius:3px; }
  .stc-dlg .stc-off { font-size:12px; color:#64748b; margin:6px 0 0; padding-left:18px; }
  .stc-dlg .stc-off li { margin:2px 0; }
  .stc-dlg .stc-fx { font-size:13px; color:#0f172a; margin:10px 0 0; padding:8px 12px 8px 28px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; }
  .stc-dlg .stc-fx:empty { display:none; }
  .stc-dlg .stc-fx li { margin:3px 0; }
  .stc-dlg .stc-fx li.warn { color:#92400e; font-weight:600; }
  .stc-dlg .stc-reason { display:block; width:100%; box-sizing:border-box; min-height:58px; border:1px solid #d1d5db; border-radius:6px; padding:7px 10px; font:inherit; font-size:14px; color:#0f172a; resize:vertical; }
  .stc-dlg .stc-what { font-size:12.5px; color:#475569; margin-top:10px; }
  .stc-btn { margin-left:4px; border:1px solid #cbd5e1; background:#fff; color:var(--navy, #1a3558); border-radius:6px; padding:1px 7px; font:inherit; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap; }
  .stc-btn:hover { border-color:var(--navy, #1a3558); background:#f8fafc; }
  .stc-btn:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
  /* the flash floats beside the button (out of the flow): showing it or taking it away never changes the row's height */
  .stc-wrap { position:relative; display:inline-block; }
  .stc-ok { position:absolute; left:100%; top:50%; transform:translateY(-50%); margin-left:6px; z-index:2; pointer-events:none; white-space:nowrap; font-size:11px; font-weight:700; color:#15803d; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:999px; padding:1px 8px; box-shadow:0 1px 2px rgba(15,23,42,.08); }
  @media (max-width: 760px) { .stc-dlg .stc-sel, .stc-dlg .stc-reason, .stc-dlg .tdlg-btn { font-size:16px; } }
  @media print { .stc-btn, .stc-ok { display:none !important; } }
`;

const STAGE_CHANGE_JS = `
/* Change the Case Stage (2026-11-26): the shared pop-up — the server says what each stage would do, and decides. */
window.tdotStageChange = function(o){
  if (typeof tdotDialogNew !== 'function') return;
  var st = { expected: o.expected, preview: null, sel: null, moved: false };
  /* Every close (saved, Cancel, the close button, Escape): when the button that opened it has gone (the row was redrawn),
     the focus would fall to the page top, so the page puts it back on the row's new button. */
  var focusBack = function(){
    if (!o.focusBack) return;
    try {
      var a = (typeof document !== 'undefined') ? document.activeElement : null;
      if (a && a !== document.body && document.body.contains(a)) return;
      o.focusBack();
    } catch(e){}
  };
  var c = tdotDialogNew({ cls: 'stc-dlg', group: 'stc', labelledBy: 'stc-h', onClosed: function(){ focusBack(); } });
  c.box.innerHTML = '<h3 id="stc-h">Change stage</h3>' +
    '<div class="stc-moved" id="stc-moved" role="status"></div>' +
    (o.caseLine ? '<div class="stc-case">' + escHtml(o.caseLine) + '</div>' : '') +
    '<div class="stc-now" id="stc-now"></div>' +
    '<label class="stc-l" for="stc-sel">New stage</label>' +
    '<select id="stc-sel" class="stc-sel" disabled><option value="">Checking the case…</option></select>' +
    '<ul class="stc-fx" id="stc-fx" aria-live="polite"></ul>' +
    '<label class="stc-l" for="stc-reason" id="stc-reason-l">Reason (optional)</label>' +
    '<textarea id="stc-reason" class="stc-reason" maxlength="300" rows="2" placeholder="Why are you changing the stage?" aria-describedby="stc-hint"></textarea>' +
    '<div class="stc-hint" id="stc-hint" aria-live="polite"></div>' +
    /* the reasons other stages cannot be chosen: about THOSE stages, not the chosen one — closed until asked */
    '<details class="stc-why" id="stc-why" hidden><summary>Why are some stages greyed out?</summary><ul class="stc-off" id="stc-off"></ul></details>' +
    '<div class="stc-what">Changes the Case Stage in Monday and adds a note on the case with your name and the reason. Monday then does what the lines above say.</div>' +
    '<div class="tdlg-err" id="stc-err" role="alert"></div>' +
    '<div class="tdlg-actions" id="stc-acts"><button type="button" class="tdlg-btn" data-x="1" id="stc-cancel">Cancel</button><button type="button" class="tdlg-btn primary" id="stc-go" disabled>Change stage</button></div>';
  var q = function(id){ return c.box.querySelector('#' + id); };
  var err = q('stc-err'), go = q('stc-go'), sel = q('stc-sel'), reason = q('stc-reason');
  go.disabled = true;   /* until the server has said what each stage would do, and a stage is chosen */
  var showNow = function(label, locked){ q('stc-now').innerHTML = 'Now: <b>' + escHtml(label || 'No stage') + '</b>' + (locked ? '<span class="stc-lk"> · locked</span>' : ''); };
  showNow(o.nowLabel);
  var signIn = function(j){
    var login = ((j && j.loginUrl) || '/q/auth/monday').split('?')[0] + '?returnTo=' + encodeURIComponent(location.pathname + location.search);
    return escHtml((j && j.error) || 'Please sign in with Monday.') + ' <a href="' + escHtml(login) + '">Sign in with Monday</a>';
  };
  var headers = function(json){ var k = (typeof peekKey === 'function') ? peekKey() : '', h = {}; if (k) h['X-Api-Key'] = k; if (json) h['Content-Type'] = 'application/json'; return h; };
  /* the reason as the server counts it: every run of white space (new lines, tabs, spaces) is one space, trimmed */
  var reasonText = function(){
    var raw = String(reason.value || ''), out = '', gap = false;
    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (ch.trim() === '') { gap = true; continue; }
      if (gap && out) out += ' ';
      gap = false; out += ch;
    }
    return out;
  };
  /* 401, or the shared key alone (403 key-only): the person must sign in with Monday — the link, same as Assign */
  var needsSignIn = function(res){ return res.status === 401 || !!(res.j && res.j.code === 'key-only'); };
  var optionOf = function(v){
    var p = st.preview, list = (p && p.options) || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].index) === String(v)) return list[i];
    return null;
  };
  var minReason = function(){ return (st.preview && st.preview.reasonMin) || 5; };
  var valid = function(){
    var opt = st.sel;
    if (!opt || !opt.allowed) return false;
    return !opt.reasonRequired || reasonText().length >= minReason();
  };
  var refresh = function(){
    var opt = st.sel, fx = q('stc-fx');
    fx.innerHTML = opt && opt.allowed ? (opt.effects || []).map(function(t, i){
      /* the server marks the warning lines (what goes out, locks, unlocks, waits) — never guessed from the words */
      var warn = !!(opt.warn && opt.warn[i]);
      return '<li' + (warn ? ' class="warn"' : '') + '>' + escHtml(t) + '</li>';
    }).join('') : '';
    q('stc-reason-l').textContent = opt && opt.reasonRequired ? 'Reason (required, at least ' + minReason() + ' characters)' : 'Reason (optional)';
    /* a quiet count while a required reason is still too short; nothing when it is optional or long enough */
    var need = opt && opt.allowed && opt.reasonRequired ? minReason() - reasonText().length : 0;
    q('stc-hint').textContent = need > 0 ? need + (need === 1 ? ' more character needed' : ' more characters needed') : '';
    go.disabled = c.busy || !valid();
  };
  var draw = function(p){
    st.preview = p; st.sel = null;
    st.expected = p.current ? p.current.index : st.expected;
    showNow(p.current && p.current.label, !!p.locked);
    /* Monday has another stage than the page showed when this was opened: one line at the top (the row is redrawn too) */
    st.moved = !!(p.current && String(p.current.index) !== String(o.expected));
    q('stc-moved').textContent = st.moved ? 'The stage changed since your page loaded — it is now ' + (p.current.label || 'No stage') + '.' : '';
    var cur = p.current ? String(p.current.index) : null;
    var h = '<option value="">Choose a stage…</option>', off = [];
    (p.options || []).forEach(function(x){
      var isNow = String(x.index) === cur;
      h += '<option value="' + escHtml(String(x.index)) + '"' + (x.allowed ? '' : ' disabled') + '>' + escHtml(x.label + (x.allowed ? '' : isNow ? ' (now)' : ' (not available)')) + '</option>';
      if (!x.allowed && x.why && !isNow) off.push('<li><b>' + escHtml(x.label) + '</b>: ' + escHtml(x.why) + '</li>');
    });
    sel.innerHTML = h;
    sel.disabled = false;
    q('stc-off').innerHTML = off.join('');
    q('stc-why').hidden = !off.length;
    refresh();
  };
  var load = function(after){
    var id = c.openId;
    sel.disabled = true;
    fetch(o.previewUrl + '?itemId=' + encodeURIComponent(String(o.itemId)) + '&expected=' + encodeURIComponent(String(st.expected)), { headers: headers(false), credentials: 'same-origin' })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok && j.ok, status: r.status, j: j }; }); })
      .then(function(res){
        var j = res.j || {};
        if (res.ok && j.current && String(j.current.index) !== String(o.expected) && o.onCurrent) o.onCurrent(j.current, j.row || null);
        if (!c.still(id)) return;
        if (res.ok) { draw(j); if (after) after(); try { sel.focus(); } catch(e){} return; }
        sel.innerHTML = '<option value="">Not available</option>';
        if (needsSignIn(res)) { err.innerHTML = signIn(j); return; }
        err.textContent = j.error || ('The stages could not be loaded (' + res.status + '). Please try again.');
      })
      .catch(function(){ if (!c.still(id)) return; sel.innerHTML = '<option value="">Not available</option>'; err.textContent = 'No answer — the stages could not be loaded. Please try again.'; });
  };
  sel.onchange = function(){ st.sel = optionOf(sel.value); err.textContent = ''; refresh(); };
  reason.oninput = refresh;
  q('stc-cancel').onclick = function(){ c.tryClose('cancel'); };
  var lock = function(on){
    c.setBusy(on);
    /* not a data-x button: the long-wait timer that lets Cancel and × close the pop-up must never let it be sent twice */
    go.disabled = !!on;
    sel.disabled = !!on; reason.disabled = !!on;
    if (!on) refresh();
  };
  go.onclick = function(){
    if (c.busy || !st.sel) return;
    var opt = st.sel, why = reasonText();
    if (!opt.allowed) { err.textContent = opt.why || 'This stage cannot be chosen.'; return; }
    if (opt.reasonRequired && why.length < minReason()) { err.textContent = 'Give a short reason for this change (at least ' + minReason() + ' characters).'; try { reason.focus(); } catch(e){} return; }
    err.textContent = '';
    var id = c.openId;
    var body = JSON.stringify({ itemId: String(o.itemId), index: opt.index, expected: st.expected, reason: why });
    lock(true);
    var done = function(){ if (!c.still(id)) return false; lock(false); return true; };
    fetch(o.url, { method: 'POST', headers: headers(true), credentials: 'same-origin', body: body })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok && j.ok, status: r.status, j: j }; }); })
      .then(function(res){
        var j = res.j || {};
        if (res.ok) {
          /* the page follows what Monday kept, even when the pop-up was closed after the long wait */
          if (o.onSaved) o.onSaved(j);
          if (!c.still(id)) return;
          /* changed, but something to check (the note, the lock, a renamed stage): say it, and let the person close */
          if (j.noteFailed || j.warning) {
            c.setBusy(false);
            err.textContent = 'Stage changed.' +
              (j.noteFailed ? ' The note may not have been added — check the case’s updates and add it by hand (who, what, why).' : '') +
              (j.warning ? ' ' + j.warning : '');
            q('stc-acts').innerHTML = '<button type="button" class="tdlg-btn primary" id="stc-close">Close</button>';
            q('stc-close').onclick = function(){ c.close(true, 'done'); };
            try { q('stc-close').focus(); } catch(e){}
            return;
          }
          c.close(true, 'done');   /* onClosed puts the focus back */
          return;
        }
        if (j.current && o.onCurrent) o.onCurrent(j.current, j.row || null);
        if (res.status === 409 && j.code === 'changed') {
          if (!done()) return;
          /* Monday has another stage now: ask again what each stage would do from there */
          var msg = (j.error || 'Someone changed the stage since your page loaded.') + ' Check what will happen and choose again.';
          /* the line at the top already says the stage now: here only that nothing was written */
          load(function(){ err.textContent = st.moved ? 'Nothing was changed. Check what will happen and choose again.' : msg; });
          return;
        }
        if (!done()) return;
        if (needsSignIn(res)) { err.innerHTML = signIn(j); return; }
        err.textContent = j.error || ('Something went wrong (' + res.status + '). The result is unknown — check the case before trying again.');
      })
      .catch(function(){
        if (!done()) return;
        err.textContent = 'No answer — the result is unknown. Check the case before trying again.';
      });
  };
  load();
  return c;
};
`;

module.exports = { STAGE_CHANGE_CSS, STAGE_CHANGE_JS };
