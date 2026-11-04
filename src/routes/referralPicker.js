'use strict';

/**
 * "Source / Reference" second question (team meeting, Faran 2026-11-04) — the
 * shared browser pieces for the Add-lead pop-up (prefix "al") and the lead
 * page's Edit basics box (prefix "bd"):
 *   Employee Referral                  → "Which employee?" (the 14 names)
 *   Existing Client / Client Referral  → "Which client?": search the OLD
 *     Consultations board (POST /api/old-clients/search), or "Not in the list
 *     — type the name".
 * The server re-checks everything (config/leadSources.js checkReferral).
 *
 * TEMPLATE-LITERAL TRAP: REFERRAL_UI_JS is browser code inside a Node template
 * literal — no backslashes at all in it (a \n or \d is silently eaten), no
 * backticks, no ${ } except the constants injected below. The tests parse the
 * emitted <script>.
 */

const SRC = require('../../config/leadSources');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsLit = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

/** <option>s for the Source / Reference select. blank: a "— choose —" first option (Add lead). */
function sourceOptionsHtml({ blank = false } = {}) {
  return (blank ? '<option value="">— choose —</option>' : '') + SRC.LEAD_SOURCES.map((s) => `<option>${esc(s)}</option>`).join('');
}

const REFERRAL_CSS = `
  .ref-row{margin-top:2px}
  .ref-search{position:relative}
  .ref-search input{width:100%;box-sizing:border-box}
  .ref-list{background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 6px 18px rgba(15,23,42,.12);margin-top:4px;max-height:260px;overflow:auto;padding:4px}   /* in the flow: never covers the "type the name" link below */
  .ref-opt{display:block;width:100%;text-align:left;background:none;border:0;border-radius:6px;padding:7px 9px;font:inherit;font-size:13px;color:#0f172a;cursor:pointer}
  .ref-opt:hover,.ref-opt.on{background:#eef2ff}
  .ref-opt .ref-meta{display:block;font-size:11.5px;color:#64748b;margin-top:1px}
  .ref-tag{display:inline-block;font-size:10.5px;font-weight:600;color:#166534;background:#dcfce7;border-radius:999px;padding:0 6px;margin-left:6px;vertical-align:1px}
  .ref-empty{padding:8px 9px;font-size:12.5px;color:#64748b}
  .ref-picked{font-size:12px;color:#166534;margin-top:4px}
  .ref-toggle{display:inline-block;margin-top:5px;font-size:12px;color:#1d4ed8;text-decoration:underline;cursor:pointer;background:none;border:0;padding:0;font-family:inherit}
`;

/** The two hidden rows that follow a Source / Reference select with id `${p}-source`. */
function referralFieldsHtml(p) {
  const emp = SRC.REFERRAL_EMPLOYEES.map((n) => `<option>${esc(n)}</option>`).join('');
  return `
        <div id="${p}-ref-emp-row" class="ref-row" style="display:none">
          <label class="al-l" for="${p}-ref-emp">Which employee? *</label>
          <select id="${p}-ref-emp"><option value="">— choose —</option>${emp}</select>
        </div>
        <div id="${p}-ref-cli-row" class="ref-row" style="display:none">
          <label class="al-l" for="${p}-ref-cli" id="${p}-ref-cli-l">Which client? *</label>
          <div class="ref-search">
            <input id="${p}-ref-cli" type="text" maxlength="${SRC.REFERRED_BY_MAX}" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${p}-ref-list" placeholder="Search: 2+ letters of the name, or 4+ digits of the phone">
            <div id="${p}-ref-list" class="ref-list" role="listbox" aria-label="Clients found" hidden></div>
          </div>
          <div id="${p}-ref-state" class="al-hint" aria-live="polite"></div>
          <button type="button" class="ref-toggle" id="${p}-ref-mode">Not in the list — type the name</button>
        </div>`;
}

/**
 * Browser code. tdotRef(p, onEdit) → controller for the select `${p}-source`:
 *   sync()        show the row the current source asks for
 *   reset()       empty everything, search mode
 *   load(src,ref) fill from a lead's stored values (the lead page)
 *   value()/from()/kind()  what to send: referredBy, referredFrom ('list'|'typed')
 *   check()       '' or the error to show (mirrors checkReferral)
 *   focus()       focus the open second question
 */
const REFERRAL_UI_JS = `
var REF_EMPLOYEE = ${jsLit(SRC.EMPLOYEE_REFERRAL)};
var REF_CLIENT_SOURCES = ${jsLit(SRC.CLIENT_REFERRAL_SOURCES)};
var REF_EMPLOYEES = ${jsLit(SRC.REFERRAL_EMPLOYEES)};
function tdotRefKind(src){ src = String(src || ''); return src === REF_EMPLOYEE ? 'employee' : (REF_CLIENT_SOURCES.indexOf(src) >= 0 ? 'client' : ''); }
function tdotRefEsc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function tdotRef(p, onEdit){
  function el(id){ return document.getElementById(p + '-' + id); }
  var srcEl = el('source'), empRow = el('ref-emp-row'), emp = el('ref-emp'), cliRow = el('ref-cli-row'), cli = el('ref-cli'),
      list = el('ref-list'), state = el('ref-state'), modeBtn = el('ref-mode'), cliLabel = el('ref-cli-l');
  var mode = 'search', picked = null, seq = 0, timer = null, results = [], active = -1;
  function edited(){ if (typeof onEdit === 'function') onEdit(); }
  function key(){ try { return sessionStorage.getItem('tdot_admin_key') || ''; } catch (e) { return ''; } }
  function closeList(){ list.hidden = true; list.innerHTML = ''; cli.setAttribute('aria-expanded', 'false'); cli.removeAttribute('aria-activedescendant'); results = []; active = -1; }
  function setState(t){ state.textContent = t || ''; }
  function setMode(m){
    mode = m; picked = null; closeList();
    if (m === 'manual') {
      modeBtn.textContent = 'Search the client list instead';
      cli.placeholder = 'Type the client' + String.fromCharCode(39) + 's full name';
      cli.setAttribute('role', 'textbox'); cli.removeAttribute('aria-autocomplete');
      setState('Typed by hand — not linked to the old Consultations board.');
    } else {
      modeBtn.textContent = 'Not in the list — type the name';
      cli.placeholder = 'Search: 2+ letters of the name, or 4+ digits of the phone';
      cli.setAttribute('role', 'combobox'); cli.setAttribute('aria-autocomplete', 'list');
      setState('');
    }
  }
  function sync(){
    var k = tdotRefKind(srcEl.value);
    empRow.style.display = k === 'employee' ? '' : 'none';
    cliRow.style.display = k === 'client' ? '' : 'none';
    if (k === 'client') cliLabel.textContent = srcEl.value === 'Client Referral' ? 'Which client referred them? *' : 'Which client? *';
    if (k !== 'client') closeList();
  }
  function reset(){ emp.value = ''; cli.value = ''; setMode('search'); sync(); }
  function ensureEmpOption(v){
    if (!v) return;
    for (var i = 0; i < emp.options.length; i++) if (emp.options[i].value === v) return;
    var o = document.createElement('option'); o.value = v; o.textContent = v + ' (not on the list)'; emp.appendChild(o);
  }
  function load(src, ref){
    ref = String(ref || '');
    emp.value = ''; cli.value = ''; setMode('search');
    var k = tdotRefKind(src);
    if (k === 'employee') { ensureEmpOption(ref); emp.value = ref; }
    else if (ref) { setMode('manual'); cli.value = ref; setState('Saved on this lead.'); }
    sync();
  }
  function render(r){
    results = r.results || []; active = -1;
    if (!results.length) {
      list.innerHTML = '<div class="ref-empty">No client found. Check the spelling, try the phone number, or use “Not in the list — type the name”.</div>';
    } else {
      list.innerHTML = results.map(function(x, i){
        var meta = [];
        if (x.phoneLast3) meta.push('phone ending ' + tdotRefEsc(x.phoneLast3));
        if (x.lastConsult) meta.push('last consultation ' + tdotRefEsc(x.lastConsult));
        if (x.consults > 1) meta.push(x.consults + ' consultations');
        return '<button type="button" class="ref-opt" role="option" id="' + p + '-ref-o' + i + '" data-i="' + i + '">' + tdotRefEsc(x.name)
          + (x.retained ? '<span class="ref-tag">retained</span>' : '')
          + '<span class="ref-meta">' + (meta.join(' · ') || 'no phone on file') + '</span></button>';
      }).join('') + (r.more ? '<div class="ref-empty">More found — type more of the name to narrow it down.</div>' : '');
    }
    list.hidden = false; cli.setAttribute('aria-expanded', 'true');
  }
  function highlight(i){
    var opts = list.querySelectorAll('.ref-opt');
    if (!opts.length) return;
    active = (i + opts.length) % opts.length;
    for (var j = 0; j < opts.length; j++) opts[j].classList.toggle('on', j === active);
    cli.setAttribute('aria-activedescendant', opts[active].id);
    if (opts[active].scrollIntoView) opts[active].scrollIntoView({ block: 'nearest' });
  }
  function pick(i){
    var x = results[i]; if (!x) return;
    picked = { name: x.name, id: x.id };
    cli.value = x.name; closeList();
    setState('Picked from the old Consultations board' + (x.phoneLast3 ? ' (phone ending ' + x.phoneLast3 + ')' : '') + '.');
    edited();
  }
  function search(){
    var q = cli.value.replace(/^ +| +$/g, '');
    var letters = q.replace(/[^A-Za-z]/g, '').length, digits = q.replace(/[^0-9]/g, '').length;
    if (letters < 2 && digits < 4 && q.indexOf('@') < 0) { closeList(); setState(q ? 'Keep typing — 2+ letters of the name, or 4+ digits of the phone.' : ''); return; }
    var my = ++seq; setState('Searching…');
    fetch('/api/old-clients/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key() }, body: JSON.stringify({ q: q }) })
      .then(function(r){ return r.json().then(function(j){ return { s: r.status, j: j }; }); })
      .then(function(res){
        if (my !== seq || mode !== 'search') return;   /* an older answer, or the box changed mode */
        if (res.s !== 200 || !res.j || !res.j.ok) { closeList(); setState((res.j && res.j.error) || 'The client search failed — try again, or type the name.'); return; }
        setState(res.j.stale ? 'The client list may be a few hours old.' : '');
        render(res.j);
      })
      .catch(function(){ if (my === seq) { closeList(); setState('The client search failed — try again, or type the name.'); } });
  }
  cli.addEventListener('input', function(){
    edited();
    if (mode !== 'search') return;
    if (picked) { picked = null; }
    clearTimeout(timer); timer = setTimeout(search, 250);
  });
  cli.addEventListener('keydown', function(e){
    if (mode !== 'search' || list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pick(active); } }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeList(); }   /* close the list only — not the pop-up */
  });
  cli.addEventListener('blur', function(){ setTimeout(function(){ if (document.activeElement !== cli) closeList(); }, 150); });
  list.addEventListener('mousedown', function(e){ e.preventDefault(); });   /* keep focus in the box while clicking a result */
  list.addEventListener('click', function(e){
    var b = e.target && e.target.closest ? e.target.closest('.ref-opt') : null;
    if (b) pick(Number(b.getAttribute('data-i')));
  });
  modeBtn.addEventListener('click', function(){ var keep = cli.value; setMode(mode === 'search' ? 'manual' : 'search'); cli.value = mode === 'manual' ? keep : ''; edited(); cli.focus(); });
  emp.addEventListener('change', edited);
  srcEl.addEventListener('change', sync);
  return {
    sync: sync, reset: reset, load: load,
    kind: function(){ return tdotRefKind(srcEl.value); },
    value: function(){
      var k = tdotRefKind(srcEl.value);
      if (k === 'employee') return emp.value;
      if (k === 'client') return mode === 'search' ? (picked ? picked.name : '') : cli.value.replace(/^ +| +$/g, '');
      return '';
    },
    from: function(){ return (tdotRefKind(srcEl.value) === 'client' && mode === 'search' && picked) ? 'list' : 'typed'; },
    check: function(){
      var k = tdotRefKind(srcEl.value);
      if (k === 'employee' && !emp.value) return 'Choose which employee referred them.';
      if (k === 'client' && mode === 'search' && !picked) return cli.value.replace(/ /g, '') ? 'Pick the client from the search results — or use “Not in the list — type the name”.' : 'Choose the client from the list, or type their name.';
      if (k === 'client' && mode === 'manual' && !cli.value.replace(/ /g, '')) return 'Type the client' + String.fromCharCode(39) + 's name.';
      return '';
    },
    focus: function(){ var k = tdotRefKind(srcEl.value); if (k === 'employee') emp.focus(); else if (k === 'client') cli.focus(); }
  };
}
`;

module.exports = { REFERRAL_CSS, REFERRAL_UI_JS, referralFieldsHtml, sourceOptionsHtml };
