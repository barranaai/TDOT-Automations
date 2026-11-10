/**
 * Leads tab (consultant portal)
 *   GET /admin/leads         — the WHOLE Lead Board, newest first (pre-booking pipeline)
 *   GET /admin/lead/:leadId   — one lead with the complete intake submission
 *
 * The Consultations tab only shows booked consultations; this tab is where a
 * fresh intake submission appears the moment it arrives. Static pages like the
 * consultation views; data comes from /api/leads and /api/lead/:leadId
 * (behind ADMIN_API_KEY, key in sessionStorage).
 */

const express = require('express');
const { UPDATES_WIDGET_CSS, updatesWidgetHtml, UPDATES_WIDGET_JS } = require('./updatesWidget');
const { REMARKS_CSS, remarksHtml, REMARKS_JS } = require('./leadRemarksWidget');
const { leadsTableScript, LEADS_TABLE_CSS } = require('./leadsTableFilters');
const { REFERRAL_CSS, REFERRAL_UI_JS, referralFieldsHtml, sourceOptionsHtml } = require('./referralPicker');   // Source / Reference second question (2026-11-04)   // header filters + sorting on the Leads list
const { ATTACH_CSS, ATTACH_UI_JS, attachFieldHtml } = require('./attachUi');   // Shafoli's screenshot attachments (2026-11-04)
const { deadlineBoxHtml, DEADLINE_BOX_JS, DEADLINE_BOX_CSS } = require('./deadlineBox');   // the deadline box (2026-11-05)
const { OUTCOME_LABELS, REMARK_PRESETS } = require('../services/consultantPortalService');
const { OUTCOME_NOT_WANTED } = require('../../config/outcomes');
const router  = express.Router();
const { SHARED_CSS_VARS, NAV_CSS, buildNavHeader, SHARED_AUTH_JS, DELETE_UI_CSS, DELETE_UI_JS, BLACKLIST_UI_CSS, BLACKLIST_UI_JS, STAFF_OPTS, COUNTRY_OPTS, DIALOG_UI_JS, REPORTING_LINK_HTML } = require('./adminShared');

// ─── Inline icon set (same conventions as adminConsultation.js) ───────────────
const _svg = (p) => `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="flex:none;vertical-align:-.15em">${p}</svg>`;
const I = {
  back:  _svg('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
  mail:  _svg('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
  clip:  _svg('<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
  cpu:   _svg('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>'),
  bolt:  _svg('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>'),
  flag:  _svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><line x1="4" x2="4" y1="22" y2="15"/>'),
  clock: _svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  send:  _svg('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
  refresh: _svg('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>'),
  file:  _svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
  video: _svg('<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2"/>'),
  user:  _svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
};
// JSON.stringify does NOT escape </script>; neutralise `<` for safe inlining.
const jsLit = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// ─── Queue page ────────────────────────────────────────────────────────────────
function buildLeadsQueueHTML() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TDOT — Leads</title><style>
  ${SHARED_CSS_VARS}
  ${NAV_CSS}
  body { background:#f1f5f9; }
  /* Full width (staff request 2026-09-09): the queue is a wide table — every
     column gets the screen, with just enough side padding to clear the edge. */
  .wrap { max-width:none; margin:0; padding:22px 14px 80px; }
  #loading { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:50vh; gap:16px; }
  .spinner { width:42px; height:42px; border:3px solid #e2e8f0; border-top-color:var(--navy); border-radius:50%; animation:spin .7s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .muted { color:var(--light); font-size:13px; }
  #error-msg { display:none; background:#fff1f2; border:1px solid #fda4af; color:#dc2626; padding:14px 18px; border-radius:12px; margin:24px auto; max-width:520px; text-align:center; }
  #content { display:none; }
  .page-h { font-size:22px; font-weight:800; color:var(--navy); letter-spacing:-.5px; margin:0 0 4px; }
  .page-sub { font-size:12px; color:#94a3b8; margin:0 0 20px; font-weight:500; }
  /* Add lead: the shared pop-up (dialogUi.js); the field look matches the direct-client form. */
  .al-l { display:block; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:#64748b; margin:12px 0 4px; font-weight:700; }
  .al-yn { display:flex; gap:18px; font-size:13.5px; margin:2px 0; }
  .al-yn label { display:flex; gap:6px; align-items:center; cursor:pointer; }
  .al-hint { font-size:12px; color:#64748b; margin-top:3px; }
  #al-overlay input, #al-overlay select, #al-overlay textarea { width:100%; border:1px solid #e2e8f0; border-radius:8px; padding:8px 10px; font:inherit; font-size:13px; color:var(--navy); background:#fff; box-sizing:border-box; }
  #al-overlay .al-yn input { width:auto; }
  .al-sub { font-size:12.5px; color:#64748b; margin:0 0 12px; line-height:1.45; }
  #al-matches { display:none; background:#fff4e5; border:1px solid #f0c98a; border-radius:8px; padding:10px 12px; margin-top:12px; font-size:13px; color:#7a4b00; }
  .btn { display:inline-flex; align-items:center; gap:6px; border:1px solid #e2e8f0; background:#fff; color:var(--navy); border-radius:9px; padding:8px 14px; font:inherit; font-weight:600; font-size:13px; cursor:pointer; }
  .btn:hover { background:#f8fafc; }
  .btn.primary { background:var(--navy); border-color:var(--navy); color:#fff; }
  .btn.primary:hover { filter:brightness(1.12); }
  .btn:disabled { opacity:.55; cursor:default; }
  .card { background:white; border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; overflow:hidden; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { background:var(--th-bg); text-align:left; padding:11px 14px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.7px; color:var(--th-fg); border-bottom:2px solid var(--th-line); }
  td { padding:12px 14px; border-bottom:1px solid #f8fafc; }
  tr.row { cursor:pointer; }
  tr.row:hover td { background:#f8faff; }
  tr.row:hover td:first-child { box-shadow:inset 3px 0 0 var(--st-blue-solid); }   /* the row under the pointer: a blue bar at its start */
  .pill { display:inline-flex; align-items:center; padding:2px 9px; border-radius:20px; font-size:10px; font-weight:700; }
  .pill.green { background:var(--st-green-bg); color:var(--st-green-fg); } .pill.grey { background:var(--st-grey-bg); color:var(--st-grey-fg); }
  .pill.amber { background:var(--st-amber-bg); color:var(--st-amber-fg); } .pill.blue { background:var(--st-blue-bg); color:var(--st-blue-fg); }
  .pill.red { background:var(--st-red-bg); color:var(--st-red-fg); }
  .tier { font-weight:700; color:var(--navy); }
  .empty { padding:40px; text-align:center; color:#94a3b8; }
  .sec-h { font-size:15px; font-weight:800; color:var(--navy); margin:0; }
  ${LEADS_TABLE_CSS}
  /* The stage tabs' counts in the stage's colour (the same colours as the Current status pills). */
  #q-phase .lt-tab[data-quick="new"], #q-phase .lt-tab[data-quick="invite"] { --tn-bg:var(--st-blue-bg); --tn-fg:var(--st-blue-fg); --tn-solid:var(--st-blue-solid); }
  #q-phase .lt-tab[data-quick="reminder1"], #q-phase .lt-tab[data-quick="reminder2"] { --tn-bg:var(--st-amber-bg); --tn-fg:var(--st-amber-fg); --tn-solid:var(--st-amber-solid); }
  #q-phase .lt-tab[data-quick="expired"] { --tn-bg:var(--st-red-bg); --tn-fg:var(--st-red-fg); --tn-solid:var(--st-red-solid); }
  ${DELETE_UI_CSS}
  ${BLACKLIST_UI_CSS}
  ${REFERRAL_CSS}
  ${ATTACH_CSS}
  ${DEADLINE_BOX_CSS}
</style></head><body>
${buildNavHeader('leads')}
<main class="wrap">
  <div id="loading"><div class="spinner"></div><div class="muted">Loading leads…</div></div>
  <div id="error-msg"></div>
  <div id="content">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <h1 class="page-h" style="margin-bottom:0">Leads</h1>
      <span style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">${REPORTING_LINK_HTML}<button class="btn primary" id="btn-add-lead" type="button" title="Phone-in / walk-in caller — add them as a lead with the basics; send the booking invite from their page">＋ Add lead</button></span>
    </div>
    <p class="page-sub">Intake submissions awaiting a consultation booking — newest first, in tabs by how far the booking invite has gone. Once a consultation is booked, the lead moves to Consultations.</p>

    <div id="al-overlay" class="tdlg-ov" hidden>
      <div id="al-modal" class="tdlg" role="dialog" aria-modal="true" aria-labelledby="al-title">
        <button type="button" class="tdlg-x" aria-label="Close">&times;</button>
        <div class="tdlg-body">
        <h3 id="al-title">Add a lead</h3>
        <div class="al-sub">A caller's basics — the full name, an email or a phone number, and the source / reference are required; anything else can be added now or later on their lead page. The booking invite and pre-consultation form are sent from there. No case is opened.</div>
        <label class="al-l" for="al-name">Full name *</label><input id="al-name" type="text" maxlength="120" autocomplete="off">
        <label class="al-l" for="al-email">Email *</label><input id="al-email" type="email" maxlength="200" autocomplete="off">
        <label class="al-l" for="al-phone">Phone *</label><input id="al-phone" type="tel" maxlength="40" autocomplete="off">
        <div class="al-hint">An email or a phone number — one of the two is enough.</div>
        <label class="al-l" for="al-address">Residential address</label><input id="al-address" type="text" maxlength="500" autocomplete="off" placeholder="Street, city, province/state, postal code, country">
        <div class="al-l" id="al-incanada-l">In Canada now?</div>
        <div class="al-yn" role="radiogroup" aria-labelledby="al-incanada-l"><label><input type="radio" name="al-incanada" value="Yes"> Yes</label><label><input type="radio" name="al-incanada" value="No"> No</label></div>
        <div class="al-hint">Decides the HST on the consultation fee — no HST for clients outside Canada. Not sure yet? Leave it: HST is charged until it is set on the lead page.</div>
        <div id="al-country-row" style="display:none"><label class="al-l" for="al-country">Which country? *</label><select id="al-country">${COUNTRY_OPTS}</select></div>
        ${deadlineBoxHtml('al', { required: false, title: 'Deadline (if known)', hint: 'Is there a real deadline, or a date you promised the client? Optional here — it is asked again when the client is retained. Documents are needed 10–15 days before a promised date.' })}
        <div id="al-addedby-row"><label class="al-l" for="al-addedby">Added by</label><select id="al-addedby">${STAFF_OPTS}</select><div class="al-hint">Becomes the lead owner. Signed in with Monday? Your name is filled in for you.</div></div>
        <div id="al-signedin" class="al-hint" style="display:none;margin-top:10px"></div>
        <label class="al-l" for="al-source">Source / Reference *</label>
        <select id="al-source">${sourceOptionsHtml({ blank: true })}</select>${referralFieldsHtml('al')}
        <label class="al-l" for="al-casetype">Case type interest</label>
        <select id="al-casetype"><option value="">— not sure yet —</option></select>
        <label class="al-l" for="al-note">Note</label>
        <textarea id="al-note" rows="3" maxlength="2000" placeholder="What they told us on the call…"></textarea>${attachFieldHtml('al')}
        <div id="al-matches" role="region" aria-label="Already in the system"></div>
        <div id="al-err" class="tdlg-err" role="alert"></div>
        <div class="tdlg-actions">
          <button class="tdlg-btn" id="al-cancel" type="button" data-x>Cancel</button>
          <button class="tdlg-btn primary" id="al-create" type="button">Create lead</button>
        </div>
        </div>
      </div>
    </div>

    <div class="lt-tabs" id="q-phase" role="tablist" aria-label="Leads by stage"></div>
    <div class="q-toolbar">
      <h2 class="sec-h">Awaiting booking <span id="q-count" class="muted" style="font-weight:500" aria-live="polite"></span></h2>
      <div class="q-search"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 2a5 5 0 0 1 3.96 8.05l3 3-.92.92-3-3A5 5 0 1 1 7 2zm0 1.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4z"/></svg><input id="q-search" type="search" placeholder="Search by name, phone or email…" aria-label="Search leads by name, phone or email" autocomplete="off"></div>
    </div>
    <div id="q-chips" class="q-chips" style="display:none" aria-live="polite"></div>
    <div class="card"><div class="tbl-wrap">
      <table>
        <thead><tr id="q-headrow"></tr></thead>
        <tbody id="qbody"></tbody>
      </table>
    </div></div>
  </div>
  <div id="q-pop" role="dialog" aria-modal="false" class="lt-pop"></div>
</main>
<script>
${SHARED_AUTH_JS}
${DIALOG_UI_JS}
${DEADLINE_BOX_JS}
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
var ALLROWS=[];
function qpill(cls,txt){ return '<span class="pill '+cls+'">'+escHtml(txt)+'</span>'; }
function statusPill(s){
  /* The shared colours (2026-11-10): booked = done (green), a held slot = blue, nothing yet / given up = grey, anything else = amber. */
  if(s==='Booked') return qpill('green','Booked');
  if(s==='Slot Held') return qpill('blue','Slot Held');
  if(s==='Abandoned') return qpill('grey','Abandoned');
  if(!s||s==='Not Yet') return qpill('grey','Not Yet');
  return qpill('amber', s);
}
function createdOf(r){ return String(r.createdDay||''); }   // the Toronto day the lead arrived (server-made)
// Current status (Faran 2026-10-28): where the lead is with us — the label, then when (Toronto day).
function stDay(ms){ try { return new Date(ms).toLocaleDateString('en-CA',{ timeZone:'America/Toronto', month:'short', day:'numeric' }); } catch(e){ return ''; } }
function statusCell(st){
  if(!st||!st.label) return '<span class="pill grey">—</span>';
  var sub=st.slot?st.slot:(st.at?stDay(st.at):'');
  if(st.key==='remark' && st.by) sub=(sub?sub+' · ':'')+st.by;
  var tip=st.detail?' title="'+escHtml(st.detail)+'"':'';   // a remark's full text on hover
  return '<span'+tip+'>'+qpill(st.tone||'grey', st.label)+'</span>'+(sub?'<div class="muted" style="font-size:11.5px;margin-top:2px">'+escHtml(sub)+'</div>':'');
}
function invitePill(c){
  if(!c.inviteSent) return '<span class="pill grey">—</span>';
  return qpill('blue', c.inviteSentAt?('Sent '+String(c.inviteSentAt).slice(0,10)):'Sent');   /* sent = blue on every page */
}
function renderRows(rows,why,st,h){
  var tb=document.getElementById('qbody');
  if(!rows.length){
    var msg=ALLROWS.length?'No leads match your filters.':'No leads awaiting booking — new intake submissions land here.';
    /* A stage tab with nobody in it (2026-11-05): say which tab, and whether the filters hide them. */
    var tab=(ALLROWS.length && st && st.sel && st.sel.phase && st.sel.phase.length)?st.sel.phase[0]:'';
    if(tab && h && window.LeadsTable){ var tl=LeadsTable.label('phase',tab); msg=(h.without('phase')===ALLROWS.length)?('No leads in “'+tl+'” right now.'):('No leads in “'+tl+'” match your filters.'); }
    tb.innerHTML='<tr><td colspan="11" class="empty">'+escHtml(msg)+'</td></tr>'; return;
  }
  tb.innerHTML=rows.map(function(c){
    var urgent=c.urgent?(' '+qpill('red','URGENT')):'';
    // Non-booking intent ("Request quote", "Existing file update", …) — visible
    // before anyone opens the lead and reaches for the booking invite.
    var wants=(c.wantsTo&&c.wantsTo!=='Book consultation')?(' '+qpill('amber',c.wantsTo)):'';
    /* No email (2026-11-04): the booking invite and the retainer go by email — visible without opening the lead. */
    var noEmail=(c.hasEmail===false)?' <span class="pill amber" title="No email address — the booking invite and the retainer agreement cannot be emailed until one is added">No email</span>':'';
    return '<tr class="row" data-id="'+escHtml(c.id)+'">'+
      '<td style="font-weight:600;color:var(--navy)">'+escHtml(c.name)+urgent+wants+noEmail+'</td>'+
      '<td style="color:var(--muted)">'+escHtml(c.service||'—')+'</td>'+
      '<td>'+escHtml(c.source||'—')+(c.owner?'<div class="muted" style="font-size:11.5px">Owner: '+escHtml(c.owner)+'</div>':'')+'</td>'+
      '<td class="ref-by">'+(c.referredBy?escHtml(c.referredBy):'<span class="muted">—</span>')+'</td>'+
      '<td>'+escHtml(createdOf(c)||'—')+'</td>'+
      '<td class="tier">'+escHtml(c.tier||'—')+'</td>'+
      '<td>'+(c.priority?qpill(c.priority==='Critical'?'red':c.priority==='High'?'amber':'grey',c.priority):'<span class="pill grey">—</span>')+'</td>'+
      '<td>'+statusPill(c.bookingStatus)+'</td>'+
      '<td>'+invitePill(c)+'</td>'+
      '<td>'+statusCell(c.status)+'</td>'+
      '<td><button class="del-btn" type="button" data-del-lead="'+escHtml(c.id)+'" title="Delete this lead (careful — removes its Monday row and OneDrive folder)">'+TDOT_DEL_SVG+'</button></td></tr>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('tr.row'),function(tr){
    tr.onclick=function(){ window.location.href='/admin/lead/'+encodeURIComponent(tr.getAttribute('data-id')); };
  });
}
function load(){
  var key=getKey(); if(!key) return;
  fetch('/api/leads',{headers:{'X-Api-Key':key}})
   .then(function(r){
     if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); }
     if(!r.ok){ throw new Error('HTTP '+r.status); }
     return r.json();
   })
   .then(function(d){
     ALLROWS=(d.leads||[]);
     window.LeadsTable.setRows(ALLROWS);   // header filters + sorting (leadsTableFilters.js)
     document.getElementById('loading').style.display='none';
     document.getElementById('content').style.display='block';
   })
   .catch(function(e){ if(e.message==='x')return;
     document.getElementById('loading').style.display='none';
     var el=document.getElementById('error-msg'); el.textContent='Failed to load: '+e.message; el.style.display='block'; });
}
/* ── Add lead (staff phone-in — meeting 2026-08-13 "direct leads") ── */
${REFERRAL_UI_JS}
var AL_ALLOW=false, AL_SIGNED=false;
var AL_REF=tdotRef('al');   /* Source / Reference second question: which employee / which client (2026-11-04) */
var AL_DL=window.tdotDeadlineBox('al');   /* the deadline (2026-11-05): optional on this form, asked again at retain */
${ATTACH_UI_JS}
var AL_ATT=tdotAttach('al');   /* "Attach a screenshot": shows only for the staff allowed to (Shafoli), signed in with Monday */
function alEl(id){ return document.getElementById(id); }
var AL_DLG=null;   /* the shared pop-up (dialogUi.js): ×, Cancel, Escape; an outside click only while nothing is typed; no closing while saving */
function alDlg(){ if(!AL_DLG) AL_DLG=tdotDialog(alEl('al-overlay'),{ slowText:'Still waiting for an answer. You can close this window, but check the leads list before trying again, so the person is not added twice.' }); return AL_DLG; }
function alLoc(){ var r=document.querySelector('input[name="al-incanada"]:checked'); return r?r.value:''; }
function alOpen(){
  AL_ALLOW=false; alEl('al-err').textContent='';
  /* Always opens EMPTY (Faran 2026-11-05) — what was typed for the last caller never lands on the next one. */
  ['al-name','al-email','al-phone','al-address','al-note'].forEach(function(id){ var e=alEl(id); if(e) e.value=''; });
  alEl('al-casetype').selectedIndex=0;
  var cb=alEl('al-create'); cb.disabled=false; cb.textContent='Create lead';
  var m=alEl('al-matches'); m.style.display='none'; m.innerHTML='';
  /* Where the client is + who is adding them: asked fresh each time (a shared front-desk PC must not credit the last person). */
  Array.prototype.forEach.call(document.querySelectorAll('input[name="al-incanada"]'),function(r){ r.checked=false; });
  alEl('al-country').value=''; alEl('al-country-row').style.display='none'; alEl('al-addedby').value='';
  alEl('al-source').value='';   /* the source is a real choice each time — no carried-over pick */
  AL_DL.reset();
  AL_REF.reset();
  AL_ATT.reset(); AL_ATT.refresh();
  TDOT_BL.viewer=null;   /* re-check the Monday sign-in every time (the session lasts 8 h; the page may be open longer) */
  AL_SIGNED=false; alEl('al-addedby-row').style.display=''; alEl('al-signedin').style.display='none';
  tdotBlViewer(function(v){
    var signed=!!(v&&v.signedIn&&v.name);
    alEl('al-addedby-row').style.display=signed?'none':'';
    var s=alEl('al-signedin'); s.style.display=signed?'block':'none';
    s.textContent=signed?('Added by '+v.name+' (signed in with Monday) — you become the lead owner.'):'';
    AL_SIGNED=signed;
  });
  alDlg().open(); alEl('al-name').focus();
  var sel=alEl('al-casetype');
  if(sel.options.length<=1){ var key=getKey(); if(!key) return;
    fetch('/api/consultation/direct-client/options',{headers:{'X-Api-Key':key}})
      .then(function(r){ return r.json(); })
      .then(function(o){ sel.innerHTML='<option value="">— not sure yet —</option>'+(o.caseTypes||[]).map(function(c){ return '<option>'+escHtml(c)+'</option>'; }).join(''); })
      .catch(function(){ /* optional field — the list just stays empty */ });
  }
}
function alClose(){ alDlg().close(); }
function alSubmit(){
  var err=alEl('al-err'); err.textContent='';
  var body={ fullName:alEl('al-name').value, email:alEl('al-email').value, phone:alEl('al-phone').value,
    residentialAddress:alEl('al-address').value,
    sourceChannel:alEl('al-source').value, referredBy:AL_REF.value(), referredFrom:AL_REF.from(), caseTypeInterest:alEl('al-casetype').value, note:alEl('al-note').value,
    inCanada:alLoc(), currentCountry:alEl('al-country').value, addedBy:alEl('al-addedby').value };
  var dlv=AL_DL.read(); body.deadlineType=dlv.deadlineType; body.actualDeadline=dlv.actualDeadline; body.promisedSubmissionDate=dlv.promisedSubmissionDate;
  /* Required (2026-11-04): the full name, an email OR a phone number, and the source; what IS typed must make sense. The server checks the same. */
  if(!body.fullName.trim()){ err.textContent='Enter the full name.'; alEl('al-name').focus(); return; }
  if(!body.email.trim() && !body.phone.trim()){ err.textContent='Enter an email or a phone number — one of the two is required.'; alEl('al-email').focus(); return; }
  if(body.email.trim() && !/^[^ @]+@[^ @]+[.][^ @]+$/.test(body.email.trim())){ err.textContent='That email doesn\u2019t look right — fix it or leave it empty.'; alEl('al-email').focus(); return; }
  if(body.phone.trim() && body.phone.replace(/[^0-9]/g,'').length<7){ err.textContent='That phone number is too short — fix it or leave it empty.'; alEl('al-phone').focus(); return; }
  if(!body.sourceChannel){ err.textContent='Choose the source / reference.'; alEl('al-source').focus(); return; }
  var refErr=AL_REF.check(); if(refErr){ err.textContent=refErr; AL_REF.focus(); return; }
  if(body.inCanada==='No' && !body.currentCountry){ err.textContent='Choose the country the client is in now (or leave "In Canada now?" unanswered).'; alEl('al-country').focus(); return; }
  var dlErr=AL_DL.check(false); if(dlErr){ err.textContent=dlErr; AL_DL.focus(); return; }
  var attErr=AL_ATT.check(); if(attErr){ err.textContent=attErr; return; }
  if(AL_ALLOW) body.allowDuplicate=true;
  var key=getKey(); if(!key) return;
  var dlg=alDlg(), run=dlg.openId;   /* this opening — a late answer for an earlier caller is never painted into the form */
  var who=body.fullName.trim(), hadFiles=AL_ATT.files().length;
  var btn=alEl('al-create'); btn.disabled=true; btn.textContent='Creating…'; dlg.setBusy(true);
  fetch('/api/leads/create',{method:'POST',headers:{'X-Api-Key':key,'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){ return r.json().then(function(j){ return {s:r.status,j:j}; }); })
    .then(function(res){
      if(!dlg.still(run)){   /* closed after the long wait: never painted into the form; the outcome is not lost either */
        if(!(res.s<400 && res.j && res.j.leadId)) return;
        if(hadFiles && dlg.openId===run && AL_ATT.files().length){   /* closed, not reopened: the files picked are still this person's */
          AL_ATT.upload(res.j.leadId).then(function(o){ if(o.failed.length) window.alert('The lead for '+who+' was created. '+o.failed.length+' file(s) were not attached — add them from the lead page:'+String.fromCharCode(10)+o.failed.map(function(x){ return '• '+x.name+' — '+x.error; }).join(String.fromCharCode(10))); load(); });
          return;
        }
        if(hadFiles) window.alert('The lead for '+who+' was created, but its attached file(s) were not saved — add them from the lead page.');
        load(); return;
      }
      if(res.s===409){
        dlg.setBusy(false);
        AL_ALLOW=true;
        var m=res.j.matches||{}; var rows=[];
        (m.leads||[]).forEach(function(l){ rows.push('Existing lead: <a href="/admin/lead/'+encodeURIComponent(l.id)+'" target="_blank" rel="noopener">'+escHtml(l.name||l.id)+'</a>'); });
        (m.cases||[]).forEach(function(c){ rows.push('Open case: <a href="/admin/case/'+encodeURIComponent(c.caseRef||'')+'" target="_blank" rel="noopener">'+escHtml(c.caseRef||'(ref pending)')+'</a> — '+escHtml(c.name||'')); });
        (m.clients||[]).forEach(function(c){ rows.push('Client account: '+escHtml(c.name||'')); });
        var box=alEl('al-matches');
        /* The Not Wanted list (point 5): the warning comes with the 409 — a warning only; "Create lead" again adds them. */
        var bl=tdotBlacklistHtml(res.j.blacklist,{leadLinks:true});
        box.innerHTML=bl+(rows.length?'<b>Already in the system:</b><br>'+rows.join('<br>')+'<br><br>':'')+
          (bl?'To add this person anyway, click <b>Create lead</b> again.':'If this is a different person or a new matter, click <b>Create lead</b> again to add them anyway.');
        box.style.display='block';
        return;
      }
      if(res.s>=400){
        dlg.setBusy(false);
        /* The sign-in ran out while the form was open: show "Added by" again so it can be picked without retyping. */
        if(/Added by/.test(String(res.j.error||''))){ AL_SIGNED=false; TDOT_BL.viewer=null; alEl('al-addedby-row').style.display=''; alEl('al-signedin').style.display='none'; }
        err.textContent=res.j.error||('HTTP '+res.s); return;
      }
      /* The lead exists: attach the chosen files now (a failed file never undoes the lead), then open it. */
      /* Saved: the window closes BEFORE the page moves on — Back must never bring this caller's filled form (and a "create anyway") back. */
      var go=function(){ if(!dlg.still(run)){ load(); return; } AL_ALLOW=false; dlg.close(true); window.location.href='/admin/lead/'+encodeURIComponent(res.j.leadId); };
      if(!AL_ATT.files().length) return go();
      btn.textContent='Attaching…';
      return AL_ATT.upload(res.j.leadId).then(function(o){
        if(o.failed.length) window.alert('The lead for '+who+' was created. '+o.failed.length+' file(s) were not attached — add them from the lead page:'+String.fromCharCode(10)+o.failed.map(function(x){ return '• '+x.name+' — '+x.error; }).join(String.fromCharCode(10)));
        go();
      });
    })
    .catch(function(){ if(!dlg.still(run)) return; err.textContent='Network error — the lead may or may not have been created. Check the leads list before retrying to avoid a duplicate.'; })
    .finally(function(){ if(!dlg.still(run)) return; dlg.setBusy(false); btn.disabled=false; btn.textContent='Create lead'; });
}
(function(){
  var b=document.getElementById('btn-add-lead'); if(b) b.onclick=alOpen;
  Array.prototype.forEach.call(document.querySelectorAll('input[name="al-incanada"]'),function(r){ r.addEventListener('change',function(){ alEl('al-country-row').style.display=(alLoc()==='No')?'':'none'; }); });
  var c=document.getElementById('al-cancel'); if(c) c.onclick=alClose;
  var s=document.getElementById('al-create'); if(s) s.onclick=alSubmit;
  /* ×, Escape and the outside click are the shared pop-up's (alDlg). */
  // Any edit to the identity fields disarms a prior "create anyway" — a stale
  // allowDuplicate must never skip the duplicate scan for a DIFFERENT person
  // typed after a 409 (same rule as the direct-client modal's dcClearMatches).
  ['al-email','al-phone'].forEach(function(id){ var el=document.getElementById(id); if(el) el.addEventListener('input',function(){
    if(AL_ALLOW){ AL_ALLOW=false; var m=alEl('al-matches'); if(m){ m.style.display='none'; m.innerHTML=''; } }
  }); });
})();
${BLACKLIST_UI_JS}
${DELETE_UI_JS}
tdotBindDelete(function(){ load(); });
/* Back to this page from the browser's memory: read the list again (a lead added meanwhile shows). */
window.addEventListener('pageshow',function(e){ if(e.persisted) load(); });
startClock(); checkApiStatus(); load();
</script>
<script>${leadsTableScript()}</script></body></html>`;
}

// ─── Detail page ────────────────────────────────────────────────────────────────
function buildLeadDetailHTML(leadId) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TDOT — Lead</title><style>
  .al-l { display:block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#64748b; margin:10px 0 4px; font-weight:600; }
  .al-yn { display:flex; gap:18px; font-size:13.5px; margin:2px 0; }
  .al-yn label { display:flex; gap:6px; align-items:center; cursor:pointer; }
  ${SHARED_CSS_VARS}
  ${NAV_CSS}
  body { background:var(--bg); }
  /* Full width (Faran 2026-10-28), like the listing pages: the page gets the
     screen, with the same side padding as the header so the edges line up. */
  .wrap { max-width:none; margin:0; padding:20px 14px 90px; }
  #loading { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:50vh; gap:16px; }
  .spinner { width:42px; height:42px; border:3px solid #e2e8f0; border-top-color:var(--navy); border-radius:50%; animation:spin .7s linear infinite; }
  ${UPDATES_WIDGET_CSS}
  @keyframes spin { to { transform:rotate(360deg); } }
  .muted { color:var(--light); font-size:12px; }
  #error-msg { display:none; background:#fff1f2; border:1px solid #fda4af; color:#dc2626; padding:14px 18px; border-radius:12px; margin:24px auto; max-width:520px; text-align:center; }
  #content { display:none; }
  .back-lnk { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--muted); text-decoration:none; margin-bottom:12px; }
  .back-lnk:hover { color:var(--navy); }

  /* sticky context header */
  .ctx { position:sticky; top:var(--header-h); z-index:20; background:var(--card); border:1px solid #eef2f7; border-radius:var(--r); box-shadow:var(--shadow-sm); padding:16px 20px; margin-bottom:14px; }
  .ctx-top { display:flex; justify-content:space-between; align-items:flex-start; gap:14px; flex-wrap:wrap; }
  .ctx-id { display:flex; gap:13px; align-items:center; min-width:0; }
  .avatar { width:46px; height:46px; border-radius:50%; background:var(--navy); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; letter-spacing:.5px; flex:none; }
  .cname { font-size:21px; font-weight:800; color:var(--navy); letter-spacing:-.4px; margin:0; line-height:1.2; }
  .csub { font-size:12.5px; color:var(--muted); margin-top:2px; font-weight:500; }
  .ctx-acts { display:flex; gap:7px; align-items:center; flex-wrap:wrap; }
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:9px 13px; border-radius:8px; font-size:12.5px; font-weight:700; text-decoration:none; border:1px solid var(--border); color:var(--navy); background:white; cursor:pointer; font-family:inherit; transition:all .12s; }
  .btn:hover:not(:disabled) { border-color:var(--navy); background:#f0f4f8; }
  .btn:disabled { opacity:.55; cursor:not-allowed; }
  .btn.primary { background:var(--navy); color:white; border-color:var(--navy); } .btn.primary:hover:not(:disabled) { background:var(--navy-light); }
  .iconbtn { width:36px; height:36px; border-radius:var(--r-sm); border:1px solid var(--border); background:#fff; color:var(--muted); display:inline-flex; align-items:center; justify-content:center; font-size:17px; cursor:pointer; text-decoration:none; transition:all .15s; }
  .iconbtn:hover { border-color:var(--navy); color:var(--navy); background:#f5f8fc; }
  #btn-convert.disabled { opacity:.5; cursor:not-allowed; pointer-events:none; }
  .edit-email { font-size:12.5px; font-weight:600; color:#1d4ed8; text-decoration:underline; cursor:pointer; white-space:nowrap; }
  .ctx-meta { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:14px; }
  .chip { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700; padding:5px 11px; border-radius:20px; background:var(--st-grey-bg); color:var(--st-grey-fg); }
  .chip svg { font-size:13px; }
  .chip.blue { background:var(--st-blue-bg); color:var(--st-blue-fg); } .chip.green { background:var(--st-green-bg); color:var(--st-green-fg); }
  .chip.amber { background:var(--st-amber-bg); color:var(--st-amber-fg); } .chip.grey { background:var(--st-grey-bg); color:var(--st-grey-fg); }
  .chip.red { background:var(--st-red-bg); color:var(--st-red-fg); }
  .chip .pk { font-weight:500; opacity:1; }   /* the key word: lighter weight, full colour (a faded word fell under 4.5:1 on the tint) */

  /* urgency banner */
  ${BLACKLIST_UI_CSS}
  ${REFERRAL_CSS}
  ${ATTACH_CSS}
  ${DEADLINE_BOX_CSS}
  .alert { background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; border-radius:var(--r); padding:12px 16px; font-size:13px; font-weight:700; margin-bottom:14px; display:flex; gap:9px; align-items:flex-start; }
  .alert svg { font-size:16px; flex:none; margin-top:1px; }
  /* "No email" caution (2026-11-04): amber, not the red "review urgently" */
  .alert.amber { background:#fffbeb; border-color:#fde68a; color:#92400e; font-weight:500; }
  .alert.amber b { font-weight:700; }

  /* two-column working area — info leads, actions support */
  .cols { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr); gap:16px; align-items:start; }
  @media (max-width:900px){ .cols{ grid-template-columns:minmax(0,1fr); } .ctx{ position:static; } }
  .col { display:flex; flex-direction:column; gap:14px; }
  .card { background:var(--card); border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; padding:16px 18px; }
  .card-t { display:flex; align-items:center; gap:7px; font-size:13px; font-weight:800; color:var(--navy); margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #f1f5f9; }
  /* a card's heading: a slightly tinted band across the top of the card (only when the heading is the card's first thing) */
  .card > .card-t:first-child { margin:-16px -18px 12px; padding:11px 18px 10px; background:var(--head-bg); border-bottom:1px solid var(--border); border-radius:var(--r) var(--r) 0 0; }
  .card-t svg { font-size:15px; color:var(--navy); }
  .card-t .when { margin-left:auto; font-weight:500; font-size:11px; color:var(--muted); }
  .obtns { display:flex; flex-wrap:wrap; gap:6px; }
  .obtn { padding:8px 10px; border:1px solid var(--border, #e2e8f0); border-radius:8px; background:white; font-size:12.5px; font-weight:600; cursor:pointer; color:var(--navy, #1e3a5f); font-family:inherit; transition:all .12s; }
  .obtn:hover:not(:disabled) { border-color:var(--navy, #1e3a5f); background:#f0f4f8; }
  .obtn.active { background:var(--navy, #1e3a5f); color:white; border-color:var(--navy, #1e3a5f); }
  .obtn:disabled { opacity:.55; cursor:not-allowed; }
${REMARKS_CSS}
  /* Basic details (Faran 2026-10-28): editable on the lead page */
  .bd-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:2px 16px; }
  .bd-grid input, .bd-grid select, #inq-text { width:100%; box-sizing:border-box; border:1px solid #e2e8f0; border-radius:8px; padding:7px 10px; font:inherit; font-size:13px; color:var(--navy); background:#fff; }
  .bd-grid input[readonly] { background:#f8fafc; color:#64748b; }
  .bd-ref { max-width:460px; }
  .bd-ref input, .bd-ref select { width:100%; box-sizing:border-box; border:1px solid #e2e8f0; border-radius:8px; padding:7px 10px; font:inherit; font-size:13px; color:var(--navy); background:#fff; }
  .bd-ref .al-hint { font-size:12px; color:#64748b; margin-top:3px; }
  .card-t .tbtn { margin-left:auto; padding:4px 10px; font-size:12px; }
  .kv { display:flex; padding:6px 0; font-size:13px; border-top:1px solid #f8fafc; gap:10px; }
  .kv:first-child { border-top:none; }
  .kv .k { color:var(--muted); min-width:150px; flex-shrink:0; }
  .kv .v { color:var(--navy); font-weight:600; overflow-wrap:anywhere; }
  .kvgrid { display:grid; grid-template-columns:repeat(auto-fit, minmax(250px, 1fr)); column-gap:30px; align-items:start; }
  .kvgrid > *:not(.kv) { grid-column:1 / -1; }
  .kvgrid .kv .k { min-width:130px; }
  .kvgrid .kv { border-top:none; border-bottom:1px solid #f5f8fc; padding:6px 0; }
  .longtext { font-size:13px; color:var(--navy); line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; max-width:var(--read-max); }
  .notyet { color:#94a3b8; font-size:13px; font-style:italic; padding:8px 0; }
  .subhead { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.6px; color:#64748b; margin:0 0 6px; }
  .agroup { padding-top:13px; margin-top:13px; border-top:1px solid #f1f5f9; }
  .act-msg { display:none; padding:9px 12px; border-radius:8px; font-size:12.5px; margin:10px 0 0; font-weight:600; }
  .act-msg.info { background:var(--st-blue-bg); color:var(--st-blue-fg); display:block; }
  .act-msg.ok { background:var(--st-green-bg); color:var(--st-green-fg); display:block; }
  .act-msg.err { background:var(--st-red-bg); color:var(--st-red-fg); display:block; }
  .btn-col { display:flex; flex-direction:column; gap:8px; }
  #invite-msg { width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid var(--border); border-radius:8px; font-size:13px; font-family:inherit; line-height:1.55; color:var(--navy); resize:vertical; }
  #invite-msg:focus { outline:none; border-color:var(--navy); }
  .btn-row { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
  .btn-row .btn { flex:1 1 auto; }
  .file-row { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--navy); font-weight:600; padding:6px 0; border-top:1px solid #f8fafc; }
  .file-row:first-child { border-top:none; }
</style></head><body>
${buildNavHeader('leads')}
<main class="wrap">
  <div id="loading"><div class="spinner"></div><div class="muted">Loading lead…</div></div>
  <div id="error-msg"></div>
  <div id="content">
    <a href="/admin/leads" class="back-lnk">${I.back} All leads</a>

    <div class="ctx">
      <div class="ctx-top">
        <div class="ctx-id">
          <div class="avatar" id="c-avatar"></div>
          <div><h1 class="cname" id="c-name"></h1><div class="csub" id="c-sub"></div></div>
        </div>
        <div class="ctx-acts" id="c-acts"></div>
      </div>
      <div class="ctx-meta" id="c-pills"></div>
    </div>

    <div id="c-alert"></div>
    <div id="bl-banner"></div>
    <div id="email-warn"></div>

    <div class="cols">
      <div class="col">
        <div class="card" id="basic-card"><div class="card-t">${I.user} Basic details</div>
          <div class="bd-grid">
            <div><label class="al-l" for="bd-name">Full name</label><input id="bd-name" type="text" maxlength="120" autocomplete="off"></div>
            <div><label class="al-l" for="bd-email">Email</label><input id="bd-email" type="email" maxlength="200" autocomplete="off"></div>
            <div><label class="al-l" for="bd-phone">Phone</label><input id="bd-phone" type="tel" maxlength="40" autocomplete="off"></div>
            <div><label class="al-l" for="bd-source">Source / Reference</label><select id="bd-source">${sourceOptionsHtml()}</select></div>
            <div><label class="al-l" for="bd-casetype">Case type interest</label><select id="bd-casetype"><option value="">— not sure yet —</option></select></div>
          </div>
          <div class="bd-ref">${referralFieldsHtml('bd')}</div>
          <div class="al-hint" id="bd-lock" style="display:none;margin-top:8px"></div>
          <div style="margin-top:10px"><button class="btn" id="btn-bd-save" type="button">Save details</button></div>
          <div id="bd-msg" class="act-msg"></div>
          <div class="btn-row" id="convert-row" style="margin-top:12px;align-items:center">
            <a class="btn" id="btn-convert" title="Reuse THIS lead (no duplicate) and go straight to the retainer panel — also after a consultation">→ Convert to direct retainer</a>
            <span class="muted" id="convert-why" style="font-size:12px"></span>
          </div>
        </div>
        <div class="card" id="la-att-card" style="display:none"><div class="card-t">${I.clip} Attachments <span class="muted">(staff only — saved in the client’s folder)</span></div>${attachFieldHtml('la')}
          <div style="margin-top:8px"><button class="btn" id="btn-la-att" type="button">Attach</button></div>
        </div>
        <div class="card"><div class="card-t">${I.clip} Their inquiry <button class="btn tbtn" id="btn-inq-edit" type="button" title="Edit the inquiry text">Edit</button></div>
          <div id="c-inquiry"></div>
          <div id="inq-editor" style="display:none">
            <textarea id="inq-text" rows="6" maxlength="5000" placeholder="What the client is asking about…"></textarea>
            <div style="display:flex;gap:8px;margin-top:8px"><button class="btn" id="btn-inq-save" type="button">Save inquiry</button><button class="btn" id="btn-inq-cancel" type="button">Cancel</button></div>
          </div>
          <div id="inq-msg" class="act-msg"></div>
        </div>
        <!-- Residential address (Gauri 2026-09-04, point 07): required on every new lead since 2026-09-04,
             editable here for older leads and typos — it prints on the consultation agreement and the retainer. -->
        <div class="card"><div class="card-t">${I.clip} Residential address <span class="muted">(prints on the consultation agreement and retainer)</span></div>
          <textarea id="lead-address" rows="2" maxlength="500" placeholder="Street, city, province/state, postal code, country" style="width:100%;box-sizing:border-box;font:inherit;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;resize:vertical"></textarea>
          <div style="margin-top:8px"><button class="btn" id="btn-lead-addr">Save address</button></div>
          <div id="lead-addr-msg" class="act-msg"></div>
        </div>
        <!-- Add-lead group (2026-10-15): the lead owner (who follows it up — anyone can hand it on) and where the client
             is now (it sets the HST on the consultation fee: none outside Canada). -->
        <div class="card"><div class="card-t">${I.user} Owner &amp; where the client is</div>
          <label class="al-l" for="lead-owner">Lead owner <span style="text-transform:none;letter-spacing:0;font-weight:400">(follows up on this lead)</span></label>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><select id="lead-owner" style="border:1px solid #e2e8f0;border-radius:8px;padding:7px 10px;font:inherit;min-width:200px">${STAFF_OPTS}</select><button class="btn" id="btn-lead-owner">Save owner</button></div>
          <div id="lead-owner-msg" class="act-msg"></div>
          <div class="al-l" id="lead-incanada-l" style="margin-top:14px">In Canada now? <span style="text-transform:none;letter-spacing:0;font-weight:400">(sets the HST on the consultation fee)</span></div>
          <div class="al-yn" role="radiogroup" aria-labelledby="lead-incanada-l"><label><input type="radio" name="lead-incanada" value="Yes"> Yes</label><label><input type="radio" name="lead-incanada" value="No"> No</label></div>
          <div id="lead-country-row" style="display:none;margin-top:6px"><select id="lead-country" style="border:1px solid #e2e8f0;border-radius:8px;padding:7px 10px;font:inherit;min-width:200px">${COUNTRY_OPTS}</select></div>
          <div style="margin-top:8px"><button class="btn" id="btn-lead-loc">Save location</button></div>
          <div id="lead-loc-msg" class="act-msg"></div>
        </div>
        <!-- The client's deadline (team meeting 2026-11-05): real (its date) or imaginary (the date promised to the
             client). Asked at retain; kept in step with the case row. -->
        <div class="card" id="lead-dl-card"><div class="card-t">${I.clip} Deadline <span class="muted">(real or imaginary — asked when the client is retained; lands on the case)</span></div>
          ${deadlineBoxHtml('lead', { required: false, title: 'Deadline', hint: 'Real: the actual deadline date. Imaginary: no real deadline — the submission date promised to the client (documents are needed 10–15 days before it).' })}
          <div style="margin-top:8px"><button class="btn" id="btn-lead-dl">Save deadline</button></div>
          <div id="lead-dl-msg" class="act-msg"></div>
        </div>
        <div id="c-sections"></div>
        <div class="card" id="c-attach-card" style="display:none"><div class="card-t">${I.file} Attachments <span class="muted">(OneDrive · Intake)</span></div><div id="c-attach"></div></div>
      </div>

      <div class="col">
        <div class="card">
          <div class="card-t">${I.flag} Lead status</div>
          <div id="c-status"></div>
        </div>
        <div class="card" id="invite-card">
          <div class="card-t">${I.send} Booking invite email <span class="when" id="inv-when"></span></div>
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px">
            <div style="min-width:0;max-width:100%">
              <div class="subhead" style="margin:0 0 4px">Consultation with</div>
              <select id="inv-consultant" style="border:1px solid #e2e8f0;border-radius:8px;padding:7px 10px;font:inherit;min-width:min(230px,100%);max-width:100%"></select>
            </div>
            <span class="muted" id="inv-routed-hint" style="font-size:12px;margin-top:16px"></span>
          </div>
          <div id="invite-warn" style="display:none;background:#fff4e5;border:1px solid #f0c98a;border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:13px;color:#7a4b00"></div>
          <div class="muted" style="margin-bottom:8px;line-height:1.5">This is the invite email's body — the standard consultation-booking paragraph (no case-condition commentary, per firm policy). Edit only if needed, then send. The email adds the greeting, booking button and fee details around it.</div>
          <textarea id="invite-msg" rows="8" placeholder="The email will use the standard consultation-booking paragraph unless you write a message here."></textarea>
          <div class="btn-row" id="record-pay-row" style="display:none;margin-bottom:10px">
            <a class="btn" id="btn-record-pay" title="Paid by cash, e-transfer or an invoice the team sent — or waived: record it on the consultation page">${I.clip} <span id="btn-record-pay-lbl">Record payment / Waived</span></a>
            <span class="muted" id="record-pay-fee" style="font-size:12px;align-self:center"></span>
          </div>
          <div class="btn-row">
            <button class="btn" id="btn-save-msg" title="Save the message without sending">${I.clip} Save draft</button>
            <button class="btn primary" id="btn-invite" title="Email the client this message with their booking link">${I.send} Send booking invite</button>
          </div>
          <div id="inv-msg" class="act-msg"></div>
          <div class="muted" style="margin-top:8px;line-height:1.5">If the client does not book, the app emails them a reminder 48 hours and 5 days after the first invite. Setting an Outcome stops the reminders.</div>
        </div>
        <div class="card">
          <div class="card-t">${I.flag} Outcome &amp; remarks</div>
          <div class="subhead">Outcome</div>
          <div class="obtns" id="obtns"></div>
          <div id="oc-msg" class="act-msg"></div>
          <div class="subhead" style="margin-top:10px">Remarks <span class="muted">— what was done for this lead</span></div>
          ${remarksHtml('rmk')}
        </div>
        <div class="card" id="qa-card" style="display:none">
          <div class="card-t">${I.bolt} Quick actions</div>
          <div class="btn-col">
            <button class="btn" id="btn-resend" title="Resend meeting + pre-consult links">${I.refresh} Resend meeting + pre-consult links</button>
            <a class="btn primary" id="lnk-consult">${I.video} Open consultation view</a>
          </div>
          <div id="act-msg" class="act-msg"></div>
        </div>
        <div class="card"><div class="card-t">${I.cpu} AI triage notes</div><div id="c-ai"></div></div>
        <div class="card"><div class="card-t">💬 Updates</div>${updatesWidgetHtml('updw')}</div>
      </div>
    </div>
  </div>
</main>
<script>
${SHARED_AUTH_JS}
${DEADLINE_BOX_JS}
var LEAD_ID=${jsLit(String(leadId))};
var OUTCOMES=${jsLit(OUTCOME_LABELS)};
var OUTCOME_NOT_WANTED=${jsLit(OUTCOME_NOT_WANTED)};
var REMARKS=${jsLit(REMARK_PRESETS)};
${BLACKLIST_UI_JS}
${REMARKS_JS}
${UPDATES_WIDGET_JS}
tdotUpdatesMount({ prefix: 'updw', threadUrl: '/api/updates/' + encodeURIComponent(LEAD_ID), itemId: LEAD_ID });
tdotRemarksMount({ prefix:'rmk', leadId: LEAD_ID, presets: REMARKS, updatesPrefix:'updw' });
(function(){
  // Outcome buttons — same action + board column as the consultation view. "Retain" is
  // deliberately not a one-click here: it goes through the retainer panel (fee → plan → send).
  var box=document.getElementById('obtns'); if(!box) return;
  OUTCOMES.forEach(function(label){
    if(label==='Retain') return;
    var b=document.createElement('button'); b.type='button'; b.className='obtn'; b.textContent=label; b.setAttribute('data-outcome',label);
    b.onclick=function(){
      var self=this;
      var run=function(value){
        var p=doAction(self,'outcome',null,value,'oc-msg');
        if(!p) return;
        p.then(function(res){
          if(!res||!res.ok) return;                 // failure: nothing highlighted, message already shown
          load();                                   // re-render from the server's truth (Outcome row + .active)
          var r=window.tdotUpdatesReload_updw; if(typeof r==='function') r();
        });
      };
      // "Not Wanted" asks for the reason first — it goes on the lead and on the Not Wanted list.
      if(label===OUTCOME_NOT_WANTED){ tdotOpenNotWantedModal({ name:document.getElementById('c-name').textContent||'', onConfirm:function(reason){ run(JSON.stringify({label:label, reason:reason})); } }); return; }
      run(label);
    };
    box.appendChild(b);
  });
})();
var WANTS_TO=''; // the client's stated intent — set in render(d); gates the invite confirmation
var FEE_RECORDED=''; // a consultation fee staff already recorded — the invite warns (the booking link charges again)
var ICONS=${jsLit({ flag: I.flag, file: I.file, user: I.user, clock: I.clock })};
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function initials(n){ return String(n||'?').split(/\\s+/).map(function(w){return w.charAt(0);}).join('').slice(0,2).toUpperCase(); }
/* The email edit box is easier to find (step 3, 2026-11-09 — the lock rules are unchanged): a "Change" link
   beside the email (and "Add it here" on the No email warning) jumps to Basic details. Shown only while the
   email can be edited there: no case yet, or the email is empty. */
function emailEditable(d){ return !d.clientMasterItemId || !String(d.email||'').trim(); }
function emailEditLink(text){ return '<a class="edit-email" href="#basic-card" data-edit-email="1" onclick="return tdotEditEmail()">'+escHtml(text)+'</a>'; }
window.tdotEditEmail=function(){
  var card=document.getElementById('basic-card'), el=document.getElementById('bd-email');
  if(card && card.scrollIntoView) card.scrollIntoView({behavior:'smooth',block:'start'});
  if(el){ try{ el.focus({preventScroll:true}); }catch(e){ el.focus(); } if(el.select && el.value) el.select(); }
  return false;
};
function kv(k,v){ return '<div class="kv"><div class="k">'+escHtml(k)+'</div><div class="v">'+escHtml(v)+'</div></div>'; }

function render(d){
  WANTS_TO=d.wantsTo||'';
  var la=document.getElementById('lead-address');
  if(la && !ADDR_DIRTY && document.activeElement!==la) la.value=d.address||'';   // never overwrite what the staffer is typing
  hydrateOwnerLocation(d);
  hydrateBasic(d);
  hydrateDeadline(d);
  INQ_TEXT=d.situationDescription||'';
  var iw=document.getElementById('invite-warn');
  if(iw){
    if(WANTS_TO && WANTS_TO!=='Book consultation'){
      iw.textContent='⚠ This client selected "'+WANTS_TO+'" on the intake form — they did not ask to book a consultation. Consider reaching out about their actual request first.';
      iw.style.display='block';
    } else { iw.style.display='none'; }
  }
  document.getElementById('c-avatar').textContent=initials(d.name||d.leadId);
  document.getElementById('c-name').textContent=d.name||d.leadId;
  document.getElementById('c-sub').textContent=(d.service||'—')+'  ·  lead '+d.leadId;

  var acts='';
  if(d.email) acts+='<a class="iconbtn" title="Email client" aria-label="Email client" href="mailto:'+escHtml(d.email)+'">'+'✉'+'</a>';
  if(d.email && emailEditable(d)) acts+=' '+emailEditLink('Change email');
  document.getElementById('c-acts').innerHTML=acts;

  var pills='';
  pills+='<span class="chip grey">'+ICONS.clock+'<span class="pk">Received</span> '+escHtml(d.createdWhen ? d.createdWhen+' (Toronto)' : '—')+'</span>';
  var bs=d.bookingStatus||'Not Yet';
  pills+='<span class="chip '+(bs==='Booked'?'green':bs==='Slot Held'?'blue':(bs==='Abandoned'||bs==='Not Yet')?'grey':'amber')+'"><span class="pk">Booking</span> '+escHtml(bs)+'</span>';
  if(d.tier) pills+='<span class="chip blue"><span class="pk">Tier</span> '+escHtml(d.tier)+'</span>';
  if(d.priority) pills+='<span class="chip '+(d.priority==='Critical'?'red':d.priority==='High'?'amber':'grey')+'"><span class="pk">Priority</span> '+escHtml(d.priority)+'</span>';
  if(d.wantsTo && d.wantsTo!=='Book consultation') pills+='<span class="chip amber"><span class="pk">Asked for</span> '+escHtml(d.wantsTo)+'</span>';
  if(d.consultant) pills+='<span class="chip green">'+ICONS.user+' '+escHtml(d.consultant)+'</span>';
  if((d.flags||[]).length) pills+='<span class="chip red">'+ICONS.flag+' URGENT</span>';
  document.getElementById('c-pills').innerHTML=pills;

  document.getElementById('c-alert').innerHTML=(d.flags||[]).length
    ? '<div class="alert">'+ICONS.flag+'<div>'+d.flags.map(function(f){return escHtml(f);}).join(' · ')+' — review urgently</div></div>' : '';

  // No email (2026-11-04: an email OR a phone is enough to add a client): say plainly what cannot go out.
  document.getElementById('email-warn').innerHTML=String(d.email||'').trim() ? ''
    : '<div class="alert amber" role="status">'+ICONS.flag+'<div><b>No email address on file.</b> The booking invite, the retainer agreement, payment links and receipts are sent by email, so the system can'+String.fromCharCode(8217)+'t send them to this client. Add the client'+String.fromCharCode(8217)+'s email in <b>Basic details</b> below: '+emailEditLink('Add it here')+(d.phone?' (phone: '+escHtml(d.phone)+')':'')+'.</div></div>';

  // The Not Wanted list (point 5): the staff-only warning under the header; named admins get "Remove from the list…".
  (function(){
    var el=document.getElementById('bl-banner'); if(!el) return;
    var r=d.blacklist;
    if(!r||(r.checked!==false&&!r.hit)){ el.innerHTML=''; return; }
    el.innerHTML=tdotBlacklistHtml(r,{leadLinks:true});
    tdotBlViewer(function(v){
      if(!(v&&v.canUndo)) return;
      el.innerHTML=tdotBlacklistHtml(r,{leadLinks:true, canRemove:true});
      tdotBlacklistBind(el,function(){ load(); var rr=window.tdotUpdatesReload_updw; if(typeof rr==='function') rr(); });
    });
  })();

  document.getElementById('c-inquiry').innerHTML = d.situationDescription
    ? '<div class="longtext">'+escHtml(d.situationDescription)+'</div>'
    : '<div class="notyet">No inquiry text provided.</div>';

  var secs=(d.sections||[]);
  document.getElementById('c-sections').innerHTML = secs.length
    ? secs.map(function(s){
        return '<div class="card" style="margin-bottom:14px"><div class="card-t">'+ICONS.file+' '+escHtml(s.title)+'</div>'+
          '<div class="kvgrid">'+(s.rows||[]).map(function(r){ return kv(r.label,r.value); }).join('')+'</div></div>';
      }).join('')
    : '<div class="card"><div class="notyet">'+(d.hasIntakeArchive?'The intake archive is empty.':'Intake archive unavailable — showing lead-board data only (older lead or folder moved after case handoff).')+'</div></div>';

  if((d.attachments||[]).length){
    document.getElementById('c-attach-card').style.display='block';
    document.getElementById('c-attach').innerHTML=d.attachments.map(function(a){ return '<div class="file-row">'+ICONS.file+' '+escHtml(a)+'</div>'; }).join('');
  }

  var st='';
  st+=kv('Booking status', d.bookingStatus||'Not Yet');
  if(d.bookedSlot) st+=kv('Booked slot', d.bookedSlot);
  st+=kv('Booking invite', d.inviteSent?('Sent'+(d.inviteSentAt?(' · '+String(d.inviteSentAt).slice(0,10)):'')):'Not sent yet');
  if(d.bookingReminders) st+=kv('Booking reminders', d.bookingReminders);
  st+=kv('Pre-consult', d.preConsultSubmitted?'Submitted':'Pending');
  if(d.outcome) st+=kv('Outcome', d.outcome);
  Array.prototype.forEach.call(document.querySelectorAll('.obtn'),function(b){ b.classList.toggle('active', b.getAttribute('data-outcome')===(d.outcome||'')); });
  if(d.consultant) st+=kv('Consultant', d.consultant);
  st+=kv('Source / Reference', d.sourceChannel||'—');
  if(d.directRetainer) st+=kv('Direct retainer client', 'Yes');
  if(d.referredBy && tdotRefKind(d.sourceChannel)) st+=kv('Referred by', d.referredBy);
  if(d.originalChannel) st+=kv('Original channel', d.originalChannel);
  st+=kv('Lead owner', d.leadOwner||'Not set');
  st+=kv('Deadline', (d.deadline&&d.deadline.text)||'Not set');
  if(d.caseTypeInterest && d.caseTypeInterest!==d.service) st+=kv('Case type interest', d.caseTypeInterest);
  st+=kv('Intake archive', d.hasIntakeArchive?('Submitted '+String(d.intakeSubmittedAt||'').slice(0,10)):(d.staffAdded?((d.originalChannel==='Email'&&!d.leadOwner)?'None — came in by email':'None — added by staff'):'Not found'));
  if(d.consentsAt) st+=kv('Consents', String(d.consentsAt).slice(0,10));
  if(d.email) st+='<div class="kv"><div class="k">Email</div><div class="v">'+escHtml(d.email)+(emailEditable(d)?' '+emailEditLink('Change'):'')+'</div></div>';
  if(d.phone) st+=kv('Phone', d.phone);
  document.getElementById('c-status').innerHTML=st;

  var ai='';
  if(d.aiTalkingPoints) ai+='<div class="subhead">Talking points</div><div class="longtext" style="margin-bottom:10px">'+escHtml(d.aiTalkingPoints)+'</div>';
  if(d.priorityReasons) ai+='<div class="subhead">Priority reasons</div><div class="longtext" style="margin-bottom:10px">'+escHtml(d.priorityReasons)+'</div>';
  if(d.aiComplianceFlags) ai+='<div class="subhead">Compliance flags</div><div class="longtext">'+escHtml(d.aiComplianceFlags)+'</div>';
  document.getElementById('c-ai').innerHTML=ai||'<div class="notyet">No AI triage notes yet.</div>';

  // Invite email: pre-fill the (AI-drafted or staff-saved) message. Booked
  // leads no longer need an invite — swap the card for the quick actions.
  // NEVER clobber an unsaved draft: render() now runs again after an outcome
  // click, and the invite card sits right under the outcome buttons.
  if(!INV_DIRTY) document.getElementById('invite-msg').value=d.inviteMessage||'';
  document.getElementById('inv-when').textContent=d.inviteSent
    ? ('sent'+(d.inviteSentAt?(' '+String(d.inviteSentAt).slice(0,10)):'')+' — sending again re-emails the client') : '';
  // Consultant override (Melanie, 2026-08-17): show the auto-routing suggestion,
  // let staff pick, persist immediately so a "send later" keeps the choice too.
  var cs=document.getElementById('inv-consultant');
  if(cs){
    var names=d.consultants||[];
    cs.innerHTML=names.map(function(n){ return '<option value="'+escHtml(n)+'">'+escHtml(n)+(n===d.routedConsultant?' (suggested)':'')+'</option>'; }).join('');
    cs.value=d.consultant||d.routedConsultant||names[0]||'';
    cs._lastConfirmed=cs.value; // last value the server accepted — revert target on failure
    var hint=document.getElementById('inv-routed-hint');
    if(hint) hint.textContent=d.routedConsultant?('auto-routing suggests '+d.routedConsultant):'';
    cs.onchange=function(){
      var key=getKey(); if(!key){ cs.value=cs._lastConfirmed; return; }
      var want=cs.value;
      fetch('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/action',{method:'POST',headers:{'X-Api-Key':key,'Content-Type':'application/json'},body:JSON.stringify({action:'setConsultant',value:want})})
        .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if(!r.ok||(j&&j.error)) throw new Error((j&&j.error)||('HTTP '+r.status)); }); })
        .then(function(){ cs._lastConfirmed=want; })
        .catch(function(err){ cs.value=cs._lastConfirmed; alert('Could not change the consultant: '+(err.message||'please try again')); });
    };
  }
  // Booked leads get the consultation view; DIRECT retainer clients (walk-in /
  // referral — never book) get the same link, since the retainer panel lives there.
  FEE_RECORDED=d.feeRecorded||'';
  if(d.bookingStatus==='Booked' || d.directRetainer){
    var rpH=document.getElementById('record-pay-row'); if(rpH) rpH.style.display='none';
    document.getElementById('invite-card').style.display='none';
    document.getElementById('qa-card').style.display='block';
    var lc=document.getElementById('lnk-consult');
    lc.href='/admin/consultation/'+encodeURIComponent(d.leadId);
    if(d.directRetainer && d.bookingStatus!=='Booked'){
      lc.innerHTML=lc.innerHTML.replace('Open consultation view','Open retainer view');
      var rb=document.getElementById('btn-resend'); if(rb) rb.style.display='none'; // no meeting to resend
    }
  } else {
    // Paid another way (cash / e-transfer / invoice) or waived, and not booked in the app:
    // record it — with the switch on, the same box takes the booking and emails the
    // agreement and form. Never while the client is paying online, or once paid online.
    // (set outright on every render — the page re-renders after each save)
    var rp=document.getElementById('record-pay-row');
    if(rp){
      var showRp=!d.clientMasterItemId && !d.paidOnline && !d.heldOnline;
      rp.style.display=showRp?'flex':'none';
      document.getElementById('btn-record-pay').href='/admin/consultation/'+encodeURIComponent(d.leadId)+'?record=1';
      document.getElementById('btn-record-pay-lbl').textContent=d.feeRecorded?'Change payment record':(d.recordBooks?'Record payment / Waived (and book)':'Record payment / Waived');
      document.getElementById('record-pay-fee').textContent=d.feeRecorded?('Recorded: '+d.feeRecorded):'';
    }
  }
  renderConvert(d);
}

/* "Convert to direct retainer" (step 3, Faran 2026-11-09): ALWAYS on the lead page — also after booking and after the
   consultation. When the server would refuse, it is greyed out with the reason (the server keeps its refusals). */
var CONVERT_WHY={ 'case':'Has a case — open it', 'retainer':'A retainer is already in progress — continue on the Retainers page', 'booked':'Consultation booked — you can convert once it has happened', 'direct':'Already a direct retainer client' };
function renderConvert(d){
  var b=document.getElementById('btn-convert'), why=document.getElementById('convert-why'); if(!b) return;
  var code=d.convertBlock ? d.convertBlock.code : (d.directRetainer ? 'direct' : '');
  if(code){
    b.removeAttribute('href'); b.setAttribute('aria-disabled','true'); b.classList.add('disabled');
    b.title=(d.convertBlock && d.convertBlock.message) || CONVERT_WHY[code] || '';
    why.textContent=(code==='booked' && d.bookedSlot) ? ('Consultation booked for '+String(d.bookedSlot).slice(0,16)+' — you can convert once that time has passed') : (CONVERT_WHY[code] || '');
  } else {
    b.href='/admin/retainers?convertLead='+encodeURIComponent(d.leadId);
    b.removeAttribute('aria-disabled'); b.classList.remove('disabled');
    b.title='Reuse THIS lead (no duplicate) and go straight to the retainer panel — also after a consultation';
    why.textContent='';
  }
}

function actMsg(elId,cls,txt){ var el=document.getElementById(elId); el.className='act-msg '+cls; el.textContent=txt; }
function doAction(btn, action, confirmText, value, msgElId){
  if(confirmText && !window.confirm(confirmText)) return;
  var key=getKey(); if(!key) return;
  var mid=msgElId||'act-msg';
  var payload={action:action, staffName:(window.tdotRemarksName_rmk ? window.tdotRemarksName_rmk() : '')};
  if(value!==undefined) payload.value=value;
  btn.disabled=true; actMsg(mid,'info','Working…');
  return fetch('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/action',{
    method:'POST', headers:{'Content-Type':'application/json','X-Api-Key':key},
    body:JSON.stringify(payload)
  })
  .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
  .then(function(res){
    btn.disabled=false;
    if(res.ok) actMsg(mid,'ok', res.j.message||'Done.');
    else actMsg(mid,'err', res.j.error||'Action failed.');
    return res;
  })
  .catch(function(e){ btn.disabled=false; actMsg(mid,'err','Failed: '+e.message); return {ok:false}; });
}
// Unsaved-draft guard: set while the staffer is typing the invite message,
// cleared once that text is persisted (saved or sent). render() honours it.
var INV_DIRTY=false;
document.getElementById('invite-msg').addEventListener('input',function(){ INV_DIRTY=true; });
document.getElementById('btn-save-msg').onclick=function(){
  doAction(this,'saveInviteMessage',null,document.getElementById('invite-msg').value,'inv-msg')
    .then(function(res){ if(res&&res.ok) INV_DIRTY=false; });
};
document.getElementById('btn-invite').onclick=function(){
  // Intent-aware confirmation: a client who asked for a quote / file update /
  // general information did NOT ask to book — make staff say so explicitly
  // before the paid-consultation invite goes out.
  var btn=this;
  var pick=document.getElementById('inv-consultant');
  var withWho=pick&&pick.value?(' The booking will be with '+pick.value+'.'):'';
  // A fee already recorded by staff: the booking link would charge the client again.
  if(FEE_RECORDED && !confirm('A consultation fee is already recorded for this client ('+FEE_RECORDED+'). The booking link asks them to PAY. Send it anyway?')) return;
  var confirmTxt=(WANTS_TO && WANTS_TO!=='Book consultation')
    ? 'THIS CLIENT ASKED FOR "'+WANTS_TO+'" — not a consultation booking. Send the paid-consultation booking invite anyway?'+withWho
    : 'Email this client their consultation booking link with this message?'+withWho;
  if(!confirm(confirmTxt)) return;
  // PIN what is ON SCREEN before the invite goes out (Melanie, 2026-08-17):
  // the booking page reads the pinned consultant live, so the invite must
  // never race a routing recalculation. Pin first (post-confirm), then send.
  var key=getKey(); if(!key) return;
  var msgEl=document.getElementById('inv-msg');
  // Pin the on-screen consultant BEFORE sending — and if the pin fails, ABORT
  // the invite (do not send with a stale/wrong consultant while showing
  // success). fetch resolves on 4xx/5xx, so check r.ok AND the body's error.
  var pinDone = (pick&&pick.value)
    ? fetch('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/action',{method:'POST',headers:{'X-Api-Key':key,'Content-Type':'application/json'},body:JSON.stringify({action:'setConsultant',value:pick.value})})
        .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if(!r.ok||(j&&j.error)) throw new Error((j&&j.error)||('Could not set the consultant (HTTP '+r.status+')')); }); })
    : Promise.resolve();
  pinDone.then(function(){
    return doAction(btn,'bookingInvite',null,
      document.getElementById('invite-msg').value,'inv-msg')
      .then(function(res){ if(res&&res.ok) INV_DIRTY=false; });
  }).catch(function(err){
    if(msgEl){ msgEl.textContent='⚠ '+(err.message||'Could not pin the consultant')+' — the invite was NOT sent.'; msgEl.style.color='#b91c1c'; msgEl.style.display='block'; }
  });
};
document.getElementById('btn-resend').onclick=function(){
  doAction(this,'resendLinks','Resend the meeting + pre-consult links to this client?');
};

function load(){
  var key=getKey(); if(!key) return;
  fetch('/api/lead/'+encodeURIComponent(LEAD_ID),{headers:{'X-Api-Key':key}})
   .then(function(r){
     if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); }
     if(r.status===404){ throw new Error('Lead not found.'); }
     if(!r.ok){ throw new Error('HTTP '+r.status); }
     return r.json();
   })
   .then(function(d){
     render(d);
     document.getElementById('loading').style.display='none';
     document.getElementById('content').style.display='block';
   })
   .catch(function(e){ if(e.message==='x')return;
     document.getElementById('loading').style.display='none';
     var el=document.getElementById('error-msg'); el.textContent='Failed to load: '+e.message; el.style.display='block'; });
}
// Address box: typed-but-unsaved text survives any re-render (same guard as the
// invite draft); after a save the box shows the value the server actually stored.
// Basic details (Faran 2026-10-28): name, email, phone, how they reached us, case type interest.
// Unsaved edits survive any re-render (same guard as the address).
var BD_DIRTY=false, BD_TYPES=null, INQ_TEXT='';
${REFERRAL_UI_JS}
var BD_REF=tdotRef('bd', function(){ BD_DIRTY=true; });   /* Source / Reference second question (2026-11-04) */
${ATTACH_UI_JS}
/* Attachments (2026-11-04): only for the staff allowed to (Shafoli), signed in with Monday — the card stays hidden for everyone else. */
var LA_ATT=tdotAttach('la');
LA_ATT.ready.then(function(ok){ var c=document.getElementById('la-att-card'); if(c) c.style.display=ok?'':'none'; });
document.getElementById('btn-la-att').onclick=function(){
  var b=this, e=LA_ATT.check();
  if(e){ LA_ATT.setStatus(e,'err'); return; }
  if(!LA_ATT.files().length){ LA_ATT.setStatus('Choose a file first.','err'); return; }
  b.disabled=true;
  LA_ATT.upload(LEAD_ID).then(function(o){
    b.disabled=false;
    if(!o.failed.length){ LA_ATT.reset(); LA_ATT.setStatus(o.sent+' attached — the link is in the updates below.','ok'); }
    else LA_ATT.setStatus((o.sent?o.sent+' attached; ':'')+o.failed.length+' not attached: '+o.failed.map(function(x){ return x.name+' ('+x.error+')'; }).join('; ')+'. Attaching again sends only these.','err');   /* always said here too */
    var r=window.tdotUpdatesReload_updw; if(typeof r==='function') r();
  });
};
var BD_LOADED={ src:'', ref:'', email:'', phone:'' };
function bdEl(id){ return document.getElementById('bd-'+id); }
function bdOption(sel,val){ if(val && ![].some.call(sel.options,function(o){ return o.value===val; })){ var o=document.createElement('option'); o.value=val; o.textContent=val; sel.appendChild(o); } }
function hydrateBasic(d){
  var caseOpen=!!d.clientMasterItemId, direct=!!d.directRetainer;
  /* With a case the name, email and phone are locked — except an EMPTY email or phone, which can still be added (it goes on the case too). */
  bdEl('name').readOnly=caseOpen;
  bdEl('email').readOnly=caseOpen && !!String(d.email||'').trim();
  bdEl('phone').readOnly=caseOpen && !!String(d.phone||'').trim();
  bdEl('source').disabled=false;   /* a direct client keeps its real source now (2026-11-04) — editable like any other */
  var lock=bdEl('lock');
  lock.textContent=caseOpen?('This lead has a case — its name, email and phone can no longer be changed here'+((!String(d.email||'').trim()||!String(d.phone||'').trim())?' (an empty email or phone can still be added, and goes on the case too)':'')+'. Ask an admin to correct them on the case in Monday.'):'';
  lock.style.display=lock.textContent?'':'none';
  if(BD_DIRTY) return;
  bdEl('name').value=d.name||''; bdEl('email').value=d.email||''; bdEl('phone').value=d.phone||'';
  var src=bdEl('source'); bdOption(src,d.sourceChannel||''); src.value=d.sourceChannel||'Website';
  BD_REF.load(src.value, d.referredBy||''); BD_LOADED={ src:src.value, ref:d.referredBy||'', email:d.email||'', phone:d.phone||'' };
  var ct=bdEl('casetype'); bdOption(ct,d.caseTypeInterest||''); ct.value=d.caseTypeInterest||'';
  if(!BD_TYPES){ var key=getKey(); if(!key) return;
    BD_TYPES='loading';
    fetch('/api/consultation/direct-client/options',{headers:{'X-Api-Key':key}}).then(function(r){ return r.json(); })
      .then(function(o){ BD_TYPES=o.caseTypes||[]; var keep=ct.value;
        ct.innerHTML='<option value="">— not sure yet —</option>'+BD_TYPES.map(function(c){ return '<option>'+escHtml(c)+'</option>'; }).join('');
        bdOption(ct,keep); ct.value=keep; })
      .catch(function(){ BD_TYPES=null; });
  }
}
['name','email','phone','source','casetype'].forEach(function(k){ var el=bdEl(k); el.addEventListener(el.tagName==='SELECT'?'change':'input',function(){ BD_DIRTY=true; }); });
document.getElementById('btn-bd-save').onclick=function(){
  var body={ fullName:bdEl('name').value, email:bdEl('email').value, phone:bdEl('phone').value, sourceChannel:bdEl('source').value, caseTypeInterest:bdEl('casetype').value };
  /* Same rule as Add lead (2026-11-04): a save may not CLEAR the last email / phone. A lead that never had either
     (added before the rule) can still be edited. The server refuses the same. */
  var contactEdited=(body.email.trim()!==String(BD_LOADED.email).trim() || body.phone.trim()!==String(BD_LOADED.phone).trim());
  var pd=String(BD_LOADED.phone).replace(/[^0-9]/g,'').length;   /* the server's rule: a usable phone has 7–15 digits */
  var hadContact=(/^[^ @]+@[^ @]+[.][^ @]+$/.test(String(BD_LOADED.email).trim()) || (pd>=7 && pd<=15));
  if(contactEdited && hadContact && !body.email.trim() && !body.phone.trim()){ actMsg('bd-msg','err','Keep an email or a phone number — one of the two is required.'); bdEl('email').focus(); return; }
  /* Source / Reference second question: sent only for a referral source; checked when the source or the answer changed (the server does the same). */
  if(BD_REF.kind()){
    body.referredBy=BD_REF.value(); body.referredFrom=BD_REF.from();
    /* also when a client name was typed in the search box but not picked — never drop it silently */
    if(body.sourceChannel!==BD_LOADED.src || body.referredBy!==BD_LOADED.ref || BD_REF.pending()){ var re=BD_REF.check(); if(re){ actMsg('bd-msg','err',re); BD_REF.focus(); return; } }
  }
  var p=doAction(this,'saveBasicInfo',null,JSON.stringify(body),'bd-msg'); if(!p) return;
  p.then(function(res){ if(res&&res.ok){ BD_DIRTY=false; if(res.j&&res.j.warnings&&res.j.warnings.length) actMsg('bd-msg','info',res.j.message); load(); var r=window.tdotUpdatesReload_updw; if(typeof r==='function') r(); } });
};
// The inquiry: Edit → a text box with the current text; Save writes it (the old text is kept in a note).
function inqEditing(on){ document.getElementById('inq-editor').style.display=on?'':'none'; document.getElementById('c-inquiry').style.display=on?'none':''; document.getElementById('btn-inq-edit').style.display=on?'none':''; }
document.getElementById('btn-inq-edit').onclick=function(){ document.getElementById('inq-text').value=INQ_TEXT; inqEditing(true); document.getElementById('inq-text').focus(); };
document.getElementById('btn-inq-cancel').onclick=function(){ inqEditing(false); };
document.getElementById('btn-inq-save').onclick=function(){
  var p=doAction(this,'saveInquiry',null,document.getElementById('inq-text').value,'inq-msg'); if(!p) return;
  p.then(function(res){ if(res&&res.ok){ inqEditing(false); load(); var r=window.tdotUpdatesReload_updw; if(typeof r==='function') r(); } });
};
var ADDR_DIRTY=false;
var _addrEl=document.getElementById('lead-address'), _addrBtn=document.getElementById('btn-lead-addr');
if(_addrEl) _addrEl.addEventListener('input',function(){ ADDR_DIRTY=true; });
if(_addrBtn) _addrBtn.onclick=function(){
  doAction(_addrBtn,'saveResidentialAddress',null,_addrEl.value,'lead-addr-msg').then(function(res){
    if(res&&res.ok&&res.j&&res.j.residentialAddress){ ADDR_DIRTY=false; _addrEl.value=res.j.residentialAddress; load(); }
  });
};
// Owner + where the client is: unsaved choices survive any re-render (same guard as the address).
var OWNER_DIRTY=false, LOC_DIRTY=false;
function leadLoc(){ var r=document.querySelector('input[name="lead-incanada"]:checked'); return r?r.value:''; }
var DL_DIRTY=false, LEAD_DL=null;
function hydrateDeadline(d){
  if(!LEAD_DL){ LEAD_DL=window.tdotDeadlineBox('lead'); Array.prototype.forEach.call(document.querySelectorAll('#lead-dl input'),function(i){ i.addEventListener('change',function(){ DL_DIRTY=true; }); }); }
  if(!DL_DIRTY) LEAD_DL.set(d.deadline||{});
}
(function(){
  var b=document.getElementById('btn-lead-dl');
  if(b) b.onclick=function(){
    if(!LEAD_DL) LEAD_DL=window.tdotDeadlineBox('lead');
    var e=LEAD_DL.check(false); if(e){ actMsg('lead-dl-msg','err',e); LEAD_DL.focus(); return; }
    var p=doAction(b,'saveDeadline',null,JSON.stringify(LEAD_DL.read()),'lead-dl-msg'); if(!p) return;
    p.then(function(res){ if(res&&res.ok){ DL_DIRTY=false; load(); var r=window.tdotUpdatesReload_updw; if(typeof r==='function') r(); } });
  };
})();
function hydrateOwnerLocation(d){
  var os=document.getElementById('lead-owner');
  if(os && !OWNER_DIRTY){
    var val=d.leadOwner||'';
    if(val && ![].some.call(os.options,function(o){ return o.value===val; })){ var o=document.createElement('option'); o.value=val; o.textContent=val; os.appendChild(o); }
    os.value=val;
  }
  if(!LOC_DIRTY){
    var yn=d.insideCanada||(d.country?(d.country==='Canada'?'Yes':'No'):'');
    Array.prototype.forEach.call(document.querySelectorAll('input[name="lead-incanada"]'),function(r){ r.checked=(r.value===yn); });
    var cs=document.getElementById('lead-country'); var c=(yn==='No')?(d.country||''):'';
    if(c && ![].some.call(cs.options,function(o){ return o.value===c; })){ var o2=document.createElement('option'); o2.value=c; o2.textContent=c; cs.appendChild(o2); }
    cs.value=c;
    document.getElementById('lead-country-row').style.display=(yn==='No')?'':'none';
  }
}
(function(){
  var os=document.getElementById('lead-owner'), ob=document.getElementById('btn-lead-owner');
  if(os) os.addEventListener('change',function(){ OWNER_DIRTY=true; });
  if(ob) ob.onclick=function(){
    var p=doAction(ob,'saveLeadOwner',null,os.value,'lead-owner-msg'); if(!p) return;
    p.then(function(res){ if(res&&res.ok){ OWNER_DIRTY=false; load(); var r=window.tdotUpdatesReload_updw; if(typeof r==='function') r(); } });
  };
  Array.prototype.forEach.call(document.querySelectorAll('input[name="lead-incanada"]'),function(r){ r.addEventListener('change',function(){ LOC_DIRTY=true; document.getElementById('lead-country-row').style.display=(leadLoc()==='No')?'':'none'; }); });
  var cs=document.getElementById('lead-country'); if(cs) cs.addEventListener('change',function(){ LOC_DIRTY=true; });
  var lb=document.getElementById('btn-lead-loc');
  if(lb) lb.onclick=function(){
    var yn=leadLoc(), c=document.getElementById('lead-country').value;
    if(!yn){ actMsg('lead-loc-msg','err','Answer "In Canada now?" first.'); return; }
    if(yn==='No' && !c){ actMsg('lead-loc-msg','err','Choose the country.'); return; }
    var p=doAction(lb,'saveLocation',null,JSON.stringify({ inCanada: yn, country: c }),'lead-loc-msg'); if(!p) return;
    p.then(function(res){ if(res&&res.ok){ LOC_DIRTY=false; load(); var r=window.tdotUpdatesReload_updw; if(typeof r==='function') r(); } });
  };
})();
startClock(); checkApiStatus(); load();
</script></body></html>`;
}

// ─── Routes ────────────────────────────────────────────────────────────────────
router.get('/leads', (_req, res) => res.type('html').send(buildLeadsQueueHTML()));
router.get('/lead/:leadId', (req, res) => res.type('html').send(buildLeadDetailHTML((req.params.leadId || '').trim())));

module.exports = router;
module.exports.buildLeadsQueueHTML = buildLeadsQueueHTML;
module.exports.buildLeadDetailHTML = buildLeadDetailHTML;
