'use strict';

/**
 * The deadline box (team meeting 2026-11-05) — one piece of HTML + browser JS shared by the staff
 * Add-lead form, the direct-retainer form, the lead page and the record page:
 *   ( ) Real deadline      → Actual deadline [date]  (+ an optional promised date)
 *   ( ) Imaginary          → Promised submission date [date]
 * The server checks the same rules (deadlineService.validate); the box only keeps staff from a
 * round trip. Plain template text: NO backticks, NO dollar-brace, NO backslashes — the pages
 * interpolate it into their own template literals (see the inline-script trap in memory).
 *
 *   deadlineBoxHtml(prefix, { required, hint, title }) → the HTML (ids prefixed "<prefix>-dl…")
 *   DEADLINE_BOX_JS → defines window.tdotDeadlineBox(prefix) → { reset, set, read, check, blank }
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function deadlineBoxHtml(prefix, { required = true, hint = '', title = 'Deadline' } = {}) {
  const p = esc(prefix);
  return `
        <div class="dlx" id="${p}-dl">
          <div class="al-l" id="${p}-dl-l">${esc(title)}${required ? ' *' : ''}</div>
          <div class="al-yn" role="radiogroup" aria-labelledby="${p}-dl-l">
            <label><input type="radio" name="${p}-dltype" value="Deadline"> Real deadline</label>
            <label><input type="radio" name="${p}-dltype" value="Imaginary"> Imaginary (a promised date)</label>
          </div>
          <div id="${p}-dl-actual-row" style="display:none"><label class="al-l" for="${p}-dl-actual">Actual deadline *</label><input type="date" id="${p}-dl-actual"></div>
          <div id="${p}-dl-promised-row" style="display:none"><label class="al-l" for="${p}-dl-promised">Promised submission date <span id="${p}-dl-promised-req">*</span></label><input type="date" id="${p}-dl-promised"></div>
          ${hint ? `<div class="al-hint">${esc(hint)}</div>` : ''}
        </div>`;
}

const DEADLINE_BOX_JS = `
/* The deadline box (2026-11-05): shared by the Add-lead form, the direct-retainer form, the lead page and the record page. */
window.tdotDeadlineBox = function(prefix){
  function el(id){ return document.getElementById(prefix+'-'+id); }
  function radios(){ return document.querySelectorAll('input[name="'+prefix+'-dltype"]'); }
  function type(){ var r=document.querySelector('input[name="'+prefix+'-dltype"]:checked'); return r?r.value:''; }
  function sync(){
    var t=type();
    var ar=el('dl-actual-row'), pr=el('dl-promised-row'), req=el('dl-promised-req');
    if(ar) ar.style.display = t==='Deadline' ? '' : 'none';
    if(pr) pr.style.display = t ? '' : 'none';
    if(req) req.textContent = t==='Imaginary' ? '*' : '(optional)';
  }
  Array.prototype.forEach.call(radios(), function(r){ r.addEventListener('change', sync); });
  function todayStr(){ return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto'}).format(new Date()); }
  var box={
    reset: function(){ Array.prototype.forEach.call(radios(), function(r){ r.checked=false; }); var a=el('dl-actual'), p=el('dl-promised'); if(a) a.value=''; if(p) p.value=''; sync(); },
    set: function(d){ d=d||{}; Array.prototype.forEach.call(radios(), function(r){ r.checked=(r.value===(d.type||'')); }); var a=el('dl-actual'), p=el('dl-promised'); if(a) a.value=d.actualDeadline||''; if(p) p.value=d.promisedSubmissionDate||''; sync(); },
    read: function(){ var t=type(); var a=el('dl-actual'), p=el('dl-promised'); return { deadlineType:t, actualDeadline:(t==='Deadline'&&a)?a.value:'', promisedSubmissionDate:(t&&p)?p.value:'' }; },
    blank: function(){ var v=box.read(); return !v.deadlineType && !v.actualDeadline && !v.promisedSubmissionDate; },
    /* '' when fine, else the message (the server checks the same). required: a blank answer is refused. */
    check: function(required){
      var v=box.read(), today=todayStr();
      if(box.blank()) return required ? 'Set the deadline: a real deadline with its date, or imaginary with the submission date promised to the client.' : '';
      if(v.deadlineType==='Deadline' && !v.actualDeadline) return 'A real deadline needs the actual deadline date.';
      if(v.deadlineType==='Imaginary' && !v.promisedSubmissionDate) return 'An imaginary deadline needs the date promised to the client.';
      if(v.actualDeadline && v.actualDeadline<today) return 'The actual deadline is in the past.';
      if(v.promisedSubmissionDate && v.promisedSubmissionDate<today) return 'The promised submission date is in the past.';
      if(v.actualDeadline && v.promisedSubmissionDate && v.promisedSubmissionDate>v.actualDeadline) return 'The promised submission date is after the actual deadline.';
      return '';
    },
    focus: function(){ var v=box.read(); var id = !v.deadlineType ? null : (v.deadlineType==='Deadline' && !v.actualDeadline) ? 'dl-actual' : 'dl-promised'; var e = id ? el(id) : radios()[0]; if(e&&e.focus) e.focus(); },
    sync: sync
  };
  sync();
  return box;
};
`;

const DEADLINE_BOX_CSS = `
  .dlx { margin-top:12px; }
  .dlx input[type=date] { font:inherit; padding:7px 10px; border:1px solid #d1d5db; border-radius:6px; }
  .dlx .al-yn input { width:auto; }
`;

module.exports = { deadlineBoxHtml, DEADLINE_BOX_JS, DEADLINE_BOX_CSS };
