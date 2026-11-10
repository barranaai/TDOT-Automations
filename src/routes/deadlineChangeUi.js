'use strict';

/**
 * The "Change the client deadline" pop-up (2026-11-10) — ONE piece of HTML + browser JS + CSS
 * shared by the case page (beside the "Client deadline" pill) and the Client Master page
 * (the Deadline cell on the Deadlines tab). It is the shared pop-up (dialogUi.js tdotDialogNew)
 * with the shared deadline box (deadlineBox.js) and a required reason; the server
 * (caseDeadlineService) is the authority for every rule.
 *
 * The page must already carry: DIALOG_UI_JS/CSS (tdotDialogNew), escHtml(), peekKey().
 * Include DEADLINE_CHANGE_CSS in the page's <style>, DEADLINE_CHANGE_HTML once in the <body>,
 * DEADLINE_CHANGE_JS in the page's <script>.
 *
 * TEMPLATE-LITERAL TRAP: these strings are interpolated into the pages' own template literals —
 * NO backticks, NO dollar-brace, NO backslashes (test/caseDeadlineUi.test.js checks).
 *
 *   window.tdotDeadlineChange({ url, itemId, caseLine, current, onSaved, onCurrent, focusBack })
 *     current   { type, actualDeadline, promisedSubmissionDate } as the page shows it now
 *     onSaved   function(deadline, answer)  — Monday kept it (also called for "no change needed")
 *     onCurrent function(current)           — someone else changed it: the value Monday has now
 *     focusBack function()                  — after a save, put the focus back on the page's button
 */

const { deadlineBoxHtml, DEADLINE_BOX_JS, DEADLINE_BOX_CSS } = require('./deadlineBox');

const DEADLINE_CHANGE_CSS = DEADLINE_BOX_CSS + `
  .dlc-dlg .al-l { display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:#64748b; margin:12px 0 4px; font-weight:700; }
  .dlc-dlg .al-yn { display:flex; gap:18px; flex-wrap:wrap; font-size:13.5px; margin:2px 0; }
  .dlc-dlg .al-yn label { display:flex; gap:6px; align-items:center; cursor:pointer; }
  .dlc-dlg .al-hint { font-size:12px; color:#64748b; margin-top:3px; }
  .dlc-dlg .dlx .al-yn input { width:auto; }
  .dlc-case { font-size:13px; color:#334155; margin:2px 0 6px; }
  .dlc-now { font-size:13px; color:#334155; }
  .dlc-reason { display:block; width:100%; box-sizing:border-box; min-height:58px; border:1px solid #d1d5db; border-radius:6px; padding:7px 10px; font:inherit; font-size:14px; color:#0f172a; resize:vertical; }
  .dlc-what { font-size:12.5px; color:#475569; margin-top:10px; }
  .dlc-btn { margin-left:4px; border:1px solid #cbd5e1; background:#fff; color:var(--navy, #1a3558); border-radius:6px; padding:1px 7px; font:inherit; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap; }
  .dlc-btn:hover { border-color:var(--navy, #1a3558); background:#f8fafc; }
  .dlc-ok { margin-left:4px; font-size:11px; font-weight:700; color:#15803d; }
  @media (max-width: 760px) { .dlc-dlg input[type=date], .dlc-dlg .dlc-reason, .dlc-dlg .tdlg-btn { font-size:16px; } }
  @media print { .dlc-btn, .dlc-ok { display:none !important; } }
`;

/* Inert until the pop-up copies it in (a <template> is not part of the page, so its ids never clash). */
const DEADLINE_CHANGE_HTML = '<template id="dlc-tpl">' +
  deadlineBoxHtml('dlc', { required: true, title: 'New deadline' }) +
  '<label class="al-l" for="dlc-reason">Reason for the change *</label>' +
  '<textarea id="dlc-reason" class="dlc-reason" maxlength="300" rows="2" placeholder="e.g. The client’s permit expiry date was corrected."></textarea>' +
  '<div class="al-hint">The case will hold exactly what you save here. A date box left empty is removed from the case — keep the promised submission date in its box if it should stay.</div>' +
  '<div class="dlc-what">Saves the deadline on the case in Monday and adds a note on the case with your name and the reason. Nothing is sent to the client.</div>' +
  '</template>';

const DEADLINE_CHANGE_JS = DEADLINE_BOX_JS + `
/* Change the client deadline (2026-11-10): the shared pop-up for the case page and the Client Master page. */
function tdotDeadlineText(d){
  d = d || {};
  var day = function(x){ if(!x) return ''; try { return new Date(x+'T12:00:00Z').toLocaleDateString('en-CA',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}); } catch(e){ return x; } };
  if (d.type === 'Deadline') return 'Real deadline ' + day(d.actualDeadline) + (d.promisedSubmissionDate ? ' — promised ' + day(d.promisedSubmissionDate) : '');
  if (d.type === 'Imaginary') return 'Imaginary — promised ' + day(d.promisedSubmissionDate) + (d.actualDeadline ? ' (with an actual date ' + day(d.actualDeadline) + ')' : '');
  if (d.actualDeadline || d.promisedSubmissionDate) return 'Type not recorded' + (d.actualDeadline ? ' — actual ' + day(d.actualDeadline) : '') + (d.promisedSubmissionDate ? ' — promised ' + day(d.promisedSubmissionDate) : '');
  return 'Not set';
}
function tdotDeadlineRaw(d){ d = d || {}; return { type: String(d.type||''), actualDeadline: String(d.actualDeadline||''), promisedSubmissionDate: String(d.promisedSubmissionDate||'') }; }
window.tdotDeadlineChange = function(o){
  var tpl = document.getElementById('dlc-tpl');
  if (!tpl || typeof tdotDialogNew !== 'function') return;
  var st = { expected: tdotDeadlineRaw(o.current) };
  var c = tdotDialogNew({ cls: 'dlc-dlg', group: 'dlc', labelledBy: 'dlc-h' });
  c.box.innerHTML = '<h3 id="dlc-h">Change the client deadline</h3>' +
    (o.caseLine ? '<div class="dlc-case">' + escHtml(o.caseLine) + '</div>' : '') +
    '<div class="dlc-now" id="dlc-now"></div>' +
    tpl.innerHTML +
    '<div class="tdlg-err" id="dlc-err" role="alert"></div>' +
    '<div class="tdlg-actions" id="dlc-acts"><button type="button" class="tdlg-btn" data-x="1" id="dlc-cancel">Cancel</button><button type="button" class="tdlg-btn primary" id="dlc-go">Save deadline</button></div>';
  var box = window.tdotDeadlineBox('dlc');
  var err = c.box.querySelector('#dlc-err'), go = c.box.querySelector('#dlc-go'), reason = c.box.querySelector('#dlc-reason');
  var showNow = function(){ c.box.querySelector('#dlc-now').innerHTML = 'Now: <b>' + escHtml(tdotDeadlineText(st.expected)) + '</b>'; };
  showNow();
  /* the boxes start from what is there now (only a type the box knows) */
  if (st.expected.type === 'Deadline' || st.expected.type === 'Imaginary') box.set(st.expected);
  var signIn = function(j){
    var login = ((j && j.loginUrl) || '/q/auth/monday').split('?')[0] + '?returnTo=' + encodeURIComponent(location.pathname + location.search);
    return escHtml((j && j.error) || 'Please sign in with Monday.') + ' <a href="' + escHtml(login) + '">Sign in with Monday</a>';
  };
  var lock = function(on){
    c.setBusy(on);
    /* not a data-x button: the long-wait timer that lets Cancel and × close the pop-up must never let Save be sent twice */
    go.disabled = !!on;
    Array.prototype.forEach.call(c.box.querySelectorAll('.dlx input, #dlc-reason'), function(e){ e.disabled = !!on; });
  };
  c.box.querySelector('#dlc-cancel').onclick = function(){ c.tryClose('cancel'); };
  go.onclick = function(){
    if (c.busy) return;
    /* a promised date already on the case, left as it is beside a real deadline, is not refused for being in the past (the server agrees) */
    var m = box.check(true, { promisedSubmissionDate: st.expected.promisedSubmissionDate });
    if (m) { err.textContent = m; box.focus(); return; }
    var why = String(reason.value || '').split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(13)).join(' ').trim();
    if (why.length < 5) { err.textContent = 'Give a short reason for the change (at least 5 characters).'; try { reason.focus(); } catch(e){} return; }
    err.textContent = '';
    var id = c.openId, k = (typeof peekKey === 'function') ? peekKey() : '', h = { 'Content-Type': 'application/json' };
    if (k) h['X-Api-Key'] = k;
    var body = JSON.stringify({ itemId: String(o.itemId), deadline: box.read(), reason: why, expected: st.expected });
    lock(true);
    var done = function(){ if (!c.still(id)) return false; lock(false); return true; };
    fetch(o.url, { method: 'POST', headers: h, credentials: 'same-origin', body: body })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok && j.ok, status: r.status, j: j }; }); })
      .then(function(res){
        var j = res.j || {};
        if (res.ok) {
          /* the page follows what Monday kept, even when the pop-up was closed after the long wait */
          if (o.onSaved) o.onSaved(j.deadline, j);
          if (!c.still(id)) return;
          if (j.noteFailed) {
            c.setBusy(false);
            err.textContent = 'Saved. The note may not have been added — check the case’s updates before adding it by hand.';
            c.box.querySelector('#dlc-acts').innerHTML = '<button type="button" class="tdlg-btn primary" id="dlc-close">Close</button>';
            c.box.querySelector('#dlc-close').onclick = function(){ c.close(true, 'done'); };
            return;
          }
          c.close(true, 'done');
          if (o.focusBack) { try { o.focusBack(); } catch(e){} }
          return;
        }
        if (res.status === 409 && j.code === 'changed' && j.current) {
          /* Monday has another value now: the page and the pop-up show it, and Save asks again against the new value */
          if (o.onCurrent) o.onCurrent(j.current);
          if (!c.still(id)) return;
          st.expected = tdotDeadlineRaw(j.current);
          showNow();
          done();
          err.textContent = (j.error || 'Someone changed it since your page loaded.') + ' Press Save deadline again to replace it.';
          return;
        }
        if (!done()) return;
        if (res.status === 401) { err.innerHTML = signIn(j); return; }
        err.textContent = j.error || ('Something went wrong (' + res.status + '). The result is unknown — check the case before trying again.');
      })
      .catch(function(){
        if (!done()) return;
        err.textContent = 'No answer — the result is unknown. Check the case before trying again.';
      });
  };
  try { var first = c.box.querySelector('.dlx input'); if (first) first.focus(); } catch(e){}
  return c;
};
`;

module.exports = { DEADLINE_CHANGE_CSS, DEADLINE_CHANGE_HTML, DEADLINE_CHANGE_JS };
