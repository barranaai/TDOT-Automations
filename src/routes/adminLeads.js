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
const router  = express.Router();
const { SHARED_CSS_VARS, NAV_CSS, buildNavHeader, SHARED_AUTH_JS, DELETE_UI_CSS, DELETE_UI_JS } = require('./adminShared');

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
  .wrap { max-width:1100px; margin:0 auto; padding:26px 24px 80px; }
  #loading { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:50vh; gap:16px; }
  .spinner { width:42px; height:42px; border:3px solid #e2e8f0; border-top-color:var(--navy); border-radius:50%; animation:spin .7s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .muted { color:var(--light); font-size:13px; }
  #error-msg { display:none; background:#fff1f2; border:1px solid #fda4af; color:#dc2626; padding:14px 18px; border-radius:12px; margin:24px auto; max-width:520px; text-align:center; }
  #content { display:none; }
  .page-h { font-size:22px; font-weight:800; color:var(--navy); letter-spacing:-.5px; margin:0 0 4px; }
  .page-sub { font-size:12px; color:#94a3b8; margin:0 0 20px; font-weight:500; }
  .al-l { display:block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#64748b; margin:10px 0 4px; font-weight:600; }
  #al-overlay input, #al-overlay select, #al-overlay textarea { width:100%; border:1px solid #e2e8f0; border-radius:8px; padding:8px 10px; font:inherit; box-sizing:border-box; }
  #al-overlay { overflow-y:auto; }
  #al-overlay > div { max-height:calc(100vh - 96px); overflow-y:auto; }
  .btn { display:inline-flex; align-items:center; gap:6px; border:1px solid #e2e8f0; background:#fff; color:var(--navy); border-radius:9px; padding:8px 14px; font:inherit; font-weight:600; font-size:13px; cursor:pointer; }
  .btn:hover { background:#f8fafc; }
  .btn.primary { background:var(--navy); border-color:var(--navy); color:#fff; }
  .btn.primary:hover { filter:brightness(1.12); }
  .btn:disabled { opacity:.55; cursor:default; }
  .card { background:white; border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; overflow:hidden; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { background:#f8fafc; text-align:left; padding:11px 14px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.7px; color:#94a3b8; border-bottom:2px solid #f1f5f9; }
  td { padding:12px 14px; border-bottom:1px solid #f8fafc; }
  tr.row { cursor:pointer; }
  tr.row:hover td { background:#f8faff; }
  .pill { display:inline-flex; align-items:center; padding:2px 9px; border-radius:20px; font-size:10px; font-weight:700; }
  .pill.green { background:#f0fdf4; color:#16a34a; } .pill.grey { background:#f1f5f9; color:#64748b; }
  .pill.amber { background:#fffbeb; color:#d97706; } .pill.blue { background:#eff6ff; color:#2563eb; }
  .pill.red { background:#fef2f2; color:#dc2626; }
  .tier { font-weight:700; color:var(--navy); }
  .empty { padding:40px; text-align:center; color:#94a3b8; }
  .sec-h { font-size:15px; font-weight:800; color:var(--navy); margin:0; }
  .q-head { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin:2px 0 10px; }
  .q-filters { display:flex; gap:8px; flex-wrap:wrap; }
  .q-filters input, .q-filters select { padding:7px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:12.5px; font-family:inherit; background:#fff; color:var(--navy); }
  .q-filters input { width:150px; }
  ${DELETE_UI_CSS}
</style></head><body>
${buildNavHeader('leads')}
<main class="wrap">
  <div id="loading"><div class="spinner"></div><div class="muted">Loading leads…</div></div>
  <div id="error-msg"></div>
  <div id="content">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <h1 class="page-h" style="margin-bottom:0">Leads</h1>
      <button class="btn primary" id="btn-add-lead" type="button" title="Phone-in / walk-in caller — add them as a lead with the basics; send the booking invite from their page">＋ Add lead</button>
    </div>
    <p class="page-sub">Intake submissions awaiting a consultation booking — newest first. Once a consultation is booked, the lead moves to Consultations.</p>

    <div id="al-overlay" style="display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:60;align-items:flex-start;justify-content:center;padding:48px 16px">
      <div style="background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);max-width:460px;width:100%;padding:24px">
        <h3 style="margin:0 0 4px;font-size:17px">Add a lead</h3>
        <div class="muted" style="font-size:12.5px;margin-bottom:14px">A caller's basics — everything else (booking invite, pre-consultation form) is sent from their lead page afterwards. No case is opened.</div>
        <label class="al-l" for="al-name">Full name *</label><input id="al-name" type="text" maxlength="120" autocomplete="off">
        <label class="al-l" for="al-email">Email *</label><input id="al-email" type="email" maxlength="200" autocomplete="off">
        <label class="al-l" for="al-phone">Phone *</label><input id="al-phone" type="tel" maxlength="40" autocomplete="off">
        <label class="al-l" for="al-source">How they reached us</label>
        <select id="al-source"><option>Phone</option><option>WhatsApp</option><option>Email</option><option>Instagram</option><option>Other</option></select>
        <label class="al-l" for="al-casetype">Case type interest (optional)</label>
        <select id="al-casetype"><option value="">— not sure yet —</option></select>
        <label class="al-l" for="al-note">Note (optional)</label>
        <textarea id="al-note" rows="3" maxlength="2000" placeholder="What they told us on the call…"></textarea>
        <div id="al-matches" style="display:none;background:#fff4e5;border:1px solid #f0c98a;border-radius:8px;padding:10px 12px;margin-top:12px;font-size:13px;color:#7a4b00"></div>
        <div id="al-err" style="color:#c0392b;font-size:13px;margin-top:10px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
          <button class="btn" id="al-cancel" type="button">Cancel</button>
          <button class="btn primary" id="al-create" type="button">Create lead</button>
        </div>
      </div>
    </div>

    <div class="q-head">
      <h2 class="sec-h">Awaiting booking <span id="q-count" class="muted" style="font-weight:500"></span></h2>
      <div class="q-filters">
        <input id="f-search" type="text" placeholder="Search lead…">
        <select id="f-status"><option value="">All statuses</option><option>Not Yet</option><option>Slot Held</option><option>Abandoned</option></select>
        <select id="f-service"><option value="">All services</option></select>
        <select id="f-month"><option value="">All months</option></select>
        <select id="f-urgent"><option value="">Urgency: any</option><option value="urgent">Urgent only</option></select>
        <select id="f-invite"><option value="">Invite: any</option><option value="sent">Invite sent</option><option value="not">No invite yet</option></select>
      </div>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Lead</th><th>Service</th><th>Created</th><th>Tier</th><th>Priority</th><th>Booking</th><th>Invite</th><th></th></tr></thead>
        <tbody id="qbody"></tbody>
      </table>
    </div>
  </div>
</main>
<script>
${SHARED_AUTH_JS}
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
var ALLROWS=[];
function qpill(cls,txt){ return '<span class="pill '+cls+'">'+escHtml(txt)+'</span>'; }
function statusPill(s){
  if(s==='Slot Held') return qpill('blue','Slot Held');
  if(s==='Abandoned') return qpill('grey','Abandoned');
  return qpill('amber', s||'Not Yet');
}
function createdOf(r){ return String(r.createdAt||'').slice(0,10); }
function invitePill(c){
  if(!c.inviteSent) return '<span class="pill grey">—</span>';
  return qpill('green', c.inviteSentAt?('Sent '+String(c.inviteSentAt).slice(0,10)):'Sent');
}
function renderRows(rows){
  var tb=document.getElementById('qbody');
  if(!rows.length){ tb.innerHTML='<tr><td colspan="8" class="empty">'+(ALLROWS.length?'No leads match your filters.':'No leads awaiting booking — new intake submissions land here.')+'</td></tr>'; return; }
  tb.innerHTML=rows.map(function(c){
    var urgent=c.urgent?(' '+qpill('red','URGENT')):'';
    // Non-booking intent ("Request quote", "Existing file update", …) — visible
    // before anyone opens the lead and reaches for the booking invite.
    var wants=(c.wantsTo&&c.wantsTo!=='Book consultation')?(' '+qpill('amber',c.wantsTo)):'';
    return '<tr class="row" data-id="'+escHtml(c.id)+'">'+
      '<td style="font-weight:600;color:var(--navy)">'+escHtml(c.name)+urgent+wants+'</td>'+
      '<td style="color:var(--muted)">'+escHtml(c.service||'—')+'</td>'+
      '<td>'+escHtml(createdOf(c)||'—')+'</td>'+
      '<td class="tier">'+escHtml(c.tier||'—')+'</td>'+
      '<td>'+(c.priority?qpill(c.priority==='Critical'?'red':c.priority==='High'?'amber':'grey',c.priority):'<span class="pill grey">—</span>')+'</td>'+
      '<td>'+statusPill(c.bookingStatus)+'</td>'+
      '<td>'+invitePill(c)+'</td>'+
      '<td><button class="del-btn" type="button" data-del-lead="'+escHtml(c.id)+'" title="Delete this lead (careful — removes its Monday row and OneDrive folder)">'+TDOT_DEL_SVG+'</button></td></tr>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('tr.row'),function(tr){
    tr.onclick=function(){ window.location.href='/admin/lead/'+encodeURIComponent(tr.getAttribute('data-id')); };
  });
}
function monthOf(r){ var m=String(r.createdAt||'').match(/^(\\d{4}-\\d{2})/); return m?m[1]:''; }
function distinctVals(rows,fn){ var s={}; rows.forEach(function(r){ var v=fn(r); if(v) s[v]=1; }); return Object.keys(s).sort(); }
function fillSel(id,vals,label){ var el=document.getElementById(id); var cur=el.value; el.innerHTML='<option value="">'+label+'</option>'+vals.map(function(v){return '<option value="'+escHtml(v)+'">'+escHtml(v)+'</option>';}).join(''); el.value=cur; }
function populateFilters(rows){
  fillSel('f-service', distinctVals(rows,function(r){return r.service;}), 'All services');
  fillSel('f-month', distinctVals(rows,monthOf).reverse(), 'All months');
}
function applyFilters(){
  var q=(document.getElementById('f-search').value||'').toLowerCase().trim();
  var st=document.getElementById('f-status').value, sv=document.getElementById('f-service').value;
  var mo=document.getElementById('f-month').value, ur=document.getElementById('f-urgent').value;
  var inv=document.getElementById('f-invite').value;
  var rows=ALLROWS.filter(function(r){
    if(q && String(r.name||'').toLowerCase().indexOf(q)<0) return false;
    if(st && (r.bookingStatus||'Not Yet')!==st) return false;
    if(sv && r.service!==sv) return false;
    if(mo && monthOf(r)!==mo) return false;
    if(ur==='urgent' && !r.urgent) return false;
    if(inv==='sent' && !r.inviteSent) return false;
    if(inv==='not' && r.inviteSent) return false;
    return true;
  });
  document.getElementById('q-count').textContent='('+rows.length+(rows.length!==ALLROWS.length?(' of '+ALLROWS.length):'')+')';
  renderRows(rows);
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
     populateFilters(ALLROWS);
     applyFilters();
     document.getElementById('loading').style.display='none';
     document.getElementById('content').style.display='block';
   })
   .catch(function(e){ if(e.message==='x')return;
     document.getElementById('loading').style.display='none';
     var el=document.getElementById('error-msg'); el.textContent='Failed to load: '+e.message; el.style.display='block'; });
}
['f-search','f-status','f-service','f-month','f-urgent','f-invite'].forEach(function(id){ var el=document.getElementById(id); if(el) el.addEventListener(el.tagName==='SELECT'?'change':'input', applyFilters); });
/* ── Add lead (staff phone-in — meeting 2026-08-13 "direct leads") ── */
var AL_ALLOW=false;
function alEl(id){ return document.getElementById(id); }
function alOpen(){
  AL_ALLOW=false; alEl('al-err').textContent='';
  var m=alEl('al-matches'); m.style.display='none'; m.innerHTML='';
  alEl('al-overlay').style.display='flex'; alEl('al-name').focus();
  var sel=alEl('al-casetype');
  if(sel.options.length<=1){ var key=getKey(); if(!key) return;
    fetch('/api/consultation/direct-client/options',{headers:{'X-Api-Key':key}})
      .then(function(r){ return r.json(); })
      .then(function(o){ sel.innerHTML='<option value="">— not sure yet —</option>'+(o.caseTypes||[]).map(function(c){ return '<option>'+escHtml(c)+'</option>'; }).join(''); })
      .catch(function(){ /* optional field — the list just stays empty */ });
  }
}
function alClose(){ alEl('al-overlay').style.display='none'; }
function alSubmit(){
  var err=alEl('al-err'); err.textContent='';
  var body={ fullName:alEl('al-name').value, email:alEl('al-email').value, phone:alEl('al-phone').value,
    sourceChannel:alEl('al-source').value, caseTypeInterest:alEl('al-casetype').value, note:alEl('al-note').value };
  if(AL_ALLOW) body.allowDuplicate=true;
  var key=getKey(); if(!key) return;
  var btn=alEl('al-create'); btn.disabled=true; btn.textContent='Creating…';
  fetch('/api/leads/create',{method:'POST',headers:{'X-Api-Key':key,'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){ return r.json().then(function(j){ return {s:r.status,j:j}; }); })
    .then(function(res){
      if(res.s===409){
        AL_ALLOW=true;
        var m=res.j.matches||{}; var rows=[];
        (m.leads||[]).forEach(function(l){ rows.push('Existing lead: <a href="/admin/lead/'+encodeURIComponent(l.id)+'" target="_blank" rel="noopener">'+escHtml(l.name||l.id)+'</a>'); });
        (m.cases||[]).forEach(function(c){ rows.push('Open case: <a href="/admin/case/'+encodeURIComponent(c.caseRef||'')+'" target="_blank" rel="noopener">'+escHtml(c.caseRef||'(ref pending)')+'</a> — '+escHtml(c.name||'')); });
        (m.clients||[]).forEach(function(c){ rows.push('Client account: '+escHtml(c.name||'')); });
        var box=alEl('al-matches');
        box.innerHTML='<b>Already in the system:</b><br>'+rows.join('<br>')+'<br><br>If this is a different person or a new matter, click <b>Create lead</b> again to add them anyway.';
        box.style.display='block';
        return;
      }
      if(res.s>=400){ err.textContent=res.j.error||('HTTP '+res.s); return; }
      window.location.href='/admin/lead/'+encodeURIComponent(res.j.leadId);
    })
    .catch(function(){ err.textContent='Network error — nothing was created; try again.'; })
    .finally(function(){ btn.disabled=false; btn.textContent='Create lead'; });
}
(function(){
  var b=document.getElementById('btn-add-lead'); if(b) b.onclick=alOpen;
  var c=document.getElementById('al-cancel'); if(c) c.onclick=alClose;
  var s=document.getElementById('al-create'); if(s) s.onclick=alSubmit;
  var o=document.getElementById('al-overlay'); if(o) o.addEventListener('click',function(e){ if(e.target===o) alClose(); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape' && o && o.style.display!=='none') alClose(); });
  // Any edit to the identity fields disarms a prior "create anyway" — a stale
  // allowDuplicate must never skip the duplicate scan for a DIFFERENT person
  // typed after a 409 (same rule as the direct-client modal's dcClearMatches).
  ['al-email','al-phone'].forEach(function(id){ var el=document.getElementById(id); if(el) el.addEventListener('input',function(){
    if(AL_ALLOW){ AL_ALLOW=false; var m=alEl('al-matches'); if(m){ m.style.display='none'; m.innerHTML=''; } }
  }); });
})();
${DELETE_UI_JS}
tdotBindDelete(function(){ load(); });
startClock(); checkApiStatus(); load();
</script></body></html>`;
}

// ─── Detail page ────────────────────────────────────────────────────────────────
function buildLeadDetailHTML(leadId) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TDOT — Lead</title><style>
  ${SHARED_CSS_VARS}
  ${NAV_CSS}
  body { background:var(--bg); }
  .wrap { max-width:1140px; margin:0 auto; padding:20px 30px 90px; }
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
  .ctx-meta { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:14px; }
  .chip { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700; padding:5px 11px; border-radius:20px; background:#f1f5f9; color:#475569; }
  .chip svg { font-size:13px; }
  .chip.blue { background:#eff6ff; color:#2563eb; } .chip.green { background:#f0fdf4; color:#16a34a; }
  .chip.amber { background:#fffbeb; color:#d97706; } .chip.grey { background:#f1f5f9; color:#64748b; }
  .chip.red { background:#fef2f2; color:#dc2626; }
  .chip .pk { font-weight:600; opacity:.65; }

  /* urgency banner */
  .alert { background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; border-radius:var(--r); padding:12px 16px; font-size:13px; font-weight:700; margin-bottom:14px; display:flex; gap:9px; align-items:flex-start; }
  .alert svg { font-size:16px; flex:none; margin-top:1px; }

  /* two-column working area — info leads, actions support */
  .cols { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr); gap:16px; align-items:start; }
  @media (max-width:900px){ .cols{ grid-template-columns:1fr; } .ctx{ position:static; } }
  .col { display:flex; flex-direction:column; gap:14px; }
  .card { background:var(--card); border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; padding:16px 18px; }
  .card-t { display:flex; align-items:center; gap:7px; font-size:13px; font-weight:800; color:var(--navy); margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #f1f5f9; }
  .card-t svg { font-size:15px; color:var(--navy); }
  .card-t .when { margin-left:auto; font-weight:500; font-size:11px; color:var(--light); }
  .kv { display:flex; padding:6px 0; font-size:13px; border-top:1px solid #f8fafc; gap:10px; }
  .kv:first-child { border-top:none; }
  .kv .k { color:var(--muted); min-width:150px; flex-shrink:0; }
  .kv .v { color:var(--navy); font-weight:600; overflow-wrap:anywhere; }
  .kvgrid { display:grid; grid-template-columns:repeat(auto-fit, minmax(250px, 1fr)); column-gap:30px; align-items:start; }
  .kvgrid > *:not(.kv) { grid-column:1 / -1; }
  .kvgrid .kv .k { min-width:130px; }
  .kvgrid .kv { border-top:none; border-bottom:1px solid #f5f8fc; padding:6px 0; }
  .longtext { font-size:13px; color:var(--navy); line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; }
  .notyet { color:#94a3b8; font-size:13px; font-style:italic; padding:8px 0; }
  .subhead { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.6px; color:#64748b; margin:0 0 6px; }
  .agroup { padding-top:13px; margin-top:13px; border-top:1px solid #f1f5f9; }
  .act-msg { display:none; padding:9px 12px; border-radius:8px; font-size:12.5px; margin:10px 0 0; font-weight:600; }
  .act-msg.info { background:#eff6ff; color:#2563eb; display:block; }
  .act-msg.ok { background:#f0fdf4; color:#16a34a; display:block; }
  .act-msg.err { background:#fef2f2; color:#dc2626; display:block; }
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

    <div class="cols">
      <div class="col">
        <div class="card"><div class="card-t">${I.clip} Their inquiry</div><div id="c-inquiry"></div></div>
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
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <div>
              <div class="subhead" style="margin:0 0 4px">Consultation with</div>
              <select id="inv-consultant" style="border:1px solid #e2e8f0;border-radius:8px;padding:7px 10px;font:inherit;min-width:230px"></select>
            </div>
            <span class="muted" id="inv-routed-hint" style="font-size:12px;margin-top:16px"></span>
          </div>
          <div id="invite-warn" style="display:none;background:#fff4e5;border:1px solid #f0c98a;border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:13px;color:#7a4b00"></div>
          <div class="muted" style="margin-bottom:8px;line-height:1.5">This is the invite email's body — the standard consultation-booking paragraph (no case-condition commentary, per firm policy). Edit only if needed, then send. The email adds the greeting, booking button and fee details around it.</div>
          <textarea id="invite-msg" rows="8" placeholder="The email will use the standard consultation-booking paragraph unless you write a message here."></textarea>
          <div class="btn-row" id="convert-row" style="display:none;margin-bottom:10px">
            <a class="btn" id="btn-convert" title="Returning/existing client who doesn't need a consultation — reuse THIS lead (no duplicate) and go straight to the retainer panel">→ Convert to direct retainer</a>
          </div>
          <div class="btn-row">
            <button class="btn" id="btn-save-msg" title="Save the message without sending">${I.clip} Save draft</button>
            <button class="btn primary" id="btn-invite" title="Email the client this message with their booking link">${I.send} Send booking invite</button>
          </div>
          <div id="inv-msg" class="act-msg"></div>
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
var LEAD_ID=${jsLit(String(leadId))};
${UPDATES_WIDGET_JS}
tdotUpdatesMount({ prefix: 'updw', threadUrl: '/api/updates/' + encodeURIComponent(LEAD_ID), itemId: LEAD_ID });
var WANTS_TO=''; // the client's stated intent — set in render(d); gates the invite confirmation
var ICONS=${jsLit({ flag: I.flag, file: I.file, user: I.user, clock: I.clock })};
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function initials(n){ return String(n||'?').split(/\\s+/).map(function(w){return w.charAt(0);}).join('').slice(0,2).toUpperCase(); }
function kv(k,v){ return '<div class="kv"><div class="k">'+escHtml(k)+'</div><div class="v">'+escHtml(v)+'</div></div>'; }

function render(d){
  WANTS_TO=d.wantsTo||'';
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
  document.getElementById('c-acts').innerHTML=acts;

  var pills='';
  pills+='<span class="chip grey">'+ICONS.clock+'<span class="pk">Created</span> '+escHtml(String(d.createdAt||'').slice(0,10)||'—')+'</span>';
  var bs=d.bookingStatus||'Not Yet';
  pills+='<span class="chip '+(bs==='Booked'?'green':bs==='Slot Held'?'blue':bs==='Abandoned'?'grey':'amber')+'"><span class="pk">Booking</span> '+escHtml(bs)+'</span>';
  if(d.tier) pills+='<span class="chip blue"><span class="pk">Tier</span> '+escHtml(d.tier)+'</span>';
  if(d.priority) pills+='<span class="chip amber"><span class="pk">Priority</span> '+escHtml(d.priority)+'</span>';
  if(d.wantsTo && d.wantsTo!=='Book consultation') pills+='<span class="chip amber"><span class="pk">Asked for</span> '+escHtml(d.wantsTo)+'</span>';
  if(d.consultant) pills+='<span class="chip green">'+ICONS.user+' '+escHtml(d.consultant)+'</span>';
  if((d.flags||[]).length) pills+='<span class="chip red">'+ICONS.flag+' URGENT</span>';
  document.getElementById('c-pills').innerHTML=pills;

  document.getElementById('c-alert').innerHTML=(d.flags||[]).length
    ? '<div class="alert">'+ICONS.flag+'<div>'+d.flags.map(function(f){return escHtml(f);}).join(' · ')+' — review urgently</div></div>' : '';

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
  st+=kv('Pre-consult', d.preConsultSubmitted?'Submitted':'Pending');
  if(d.outcome) st+=kv('Outcome', d.outcome);
  if(d.consultant) st+=kv('Consultant', d.consultant);
  st+=kv('Intake archive', d.hasIntakeArchive?('Submitted '+String(d.intakeSubmittedAt||'').slice(0,10)):'Not found');
  if(d.consentsAt) st+=kv('Consents', String(d.consentsAt).slice(0,10));
  if(d.email) st+=kv('Email', d.email);
  if(d.phone) st+=kv('Phone', d.phone);
  document.getElementById('c-status').innerHTML=st;

  var ai='';
  if(d.aiTalkingPoints) ai+='<div class="subhead">Talking points</div><div class="longtext" style="margin-bottom:10px">'+escHtml(d.aiTalkingPoints)+'</div>';
  if(d.priorityReasons) ai+='<div class="subhead">Priority reasons</div><div class="longtext" style="margin-bottom:10px">'+escHtml(d.priorityReasons)+'</div>';
  if(d.aiComplianceFlags) ai+='<div class="subhead">Compliance flags</div><div class="longtext">'+escHtml(d.aiComplianceFlags)+'</div>';
  document.getElementById('c-ai').innerHTML=ai||'<div class="notyet">No AI triage notes yet.</div>';

  // Invite email: pre-fill the (AI-drafted or staff-saved) message. Booked
  // leads no longer need an invite — swap the card for the quick actions.
  document.getElementById('invite-msg').value=d.inviteMessage||'';
  document.getElementById('inv-when').textContent=d.inviteSent
    ? ('sent'+(d.inviteSentAt?(' '+String(d.inviteSentAt).slice(0,10)):'')+' — sending again re-emails the client') : '';
  // Consultant override (Melanie, 2026-08-17): show the auto-routing suggestion,
  // let staff pick, persist immediately so a "send later" keeps the choice too.
  var cs=document.getElementById('inv-consultant');
  if(cs){
    var names=d.consultants||[];
    cs.innerHTML=names.map(function(n){ return '<option value="'+escHtml(n)+'">'+escHtml(n)+(n===d.routedConsultant?' (suggested)':'')+'</option>'; }).join('');
    cs.value=d.consultant||d.routedConsultant||names[0]||'';
    var hint=document.getElementById('inv-routed-hint');
    if(hint) hint.textContent=d.routedConsultant?('auto-routing suggests '+d.routedConsultant):'';
    cs.onchange=function(){
      var key=getKey(); if(!key) return;
      fetch('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/action',{method:'POST',headers:{'X-Api-Key':key,'Content-Type':'application/json'},body:JSON.stringify({action:'setConsultant',value:cs.value})})
        .then(function(r){ return r.json(); })
        .then(function(j){ if(j&&j.error){ alert(j.error); } })
        .catch(function(){});
    };
  }
  // Booked leads get the consultation view; DIRECT retainer clients (walk-in /
  // referral — never book) get the same link, since the retainer panel lives there.
  if(d.bookingStatus==='Booked' || d.directRetainer){
    document.getElementById('invite-card').style.display='none';
    document.getElementById('qa-card').style.display='block';
    var lc=document.getElementById('lnk-consult');
    lc.href='/admin/consultation/'+encodeURIComponent(d.leadId);
    if(d.directRetainer && d.bookingStatus!=='Booked'){
      lc.innerHTML=lc.innerHTML.replace('Open consultation view','Open retainer view');
      var rb=document.getElementById('btn-resend'); if(rb) rb.style.display='none'; // no meeting to resend
    }
  } else {
    // Un-booked, non-direct lead: returning clients can skip the consultation
    // entirely (team feedback 2026-08-13) — convert THIS lead into a direct
    // retainer client. The Consultations page opens with the modal pre-filled
    // and linked to this lead, so no duplicate row is minted; the server still
    // refuses leads that are already booked/sent/retained.
    // Mirror the server's link-conversion guards (booked / slot held / open
    // case are refused there) — never offer a button that's guaranteed to 409.
    var cr=document.getElementById('convert-row');
    if(cr && !d.clientMasterItemId && d.bookingStatus!=='Slot Held' && !d.bookedSlot){
      cr.style.display='flex';
      document.getElementById('btn-convert').href='/admin/consultation?convertLead='+encodeURIComponent(d.leadId);
    }
  }
}

function actMsg(elId,cls,txt){ var el=document.getElementById(elId); el.className='act-msg '+cls; el.textContent=txt; }
function doAction(btn, action, confirmText, value, msgElId){
  if(confirmText && !window.confirm(confirmText)) return;
  var key=getKey(); if(!key) return;
  var mid=msgElId||'act-msg';
  var payload={action:action};
  if(value!==undefined) payload.value=value;
  btn.disabled=true; actMsg(mid,'info','Working…');
  fetch('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/action',{
    method:'POST', headers:{'Content-Type':'application/json','X-Api-Key':key},
    body:JSON.stringify(payload)
  })
  .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
  .then(function(res){
    btn.disabled=false;
    if(res.ok) actMsg(mid,'ok', res.j.message||'Done.');
    else actMsg(mid,'err', res.j.error||'Action failed.');
  })
  .catch(function(e){ btn.disabled=false; actMsg(mid,'err','Failed: '+e.message); });
}
document.getElementById('btn-save-msg').onclick=function(){
  doAction(this,'saveInviteMessage',null,document.getElementById('invite-msg').value,'inv-msg');
};
document.getElementById('btn-invite').onclick=function(){
  // Intent-aware confirmation: a client who asked for a quote / file update /
  // general information did NOT ask to book — make staff say so explicitly
  // before the paid-consultation invite goes out.
  var btn=this;
  var pick=document.getElementById('inv-consultant');
  var withWho=pick&&pick.value?(' The booking will be with '+pick.value+'.'):'';
  var confirmTxt=(WANTS_TO && WANTS_TO!=='Book consultation')
    ? 'THIS CLIENT ASKED FOR "'+WANTS_TO+'" — not a consultation booking. Send the paid-consultation booking invite anyway?'+withWho
    : 'Email this client their consultation booking link with this message?'+withWho;
  if(!confirm(confirmTxt)) return;
  // PIN what is ON SCREEN before the invite goes out (Melanie, 2026-08-17):
  // the booking page reads the pinned consultant live, so the invite must
  // never race a routing recalculation. Pin first (post-confirm), then send.
  var key=getKey(); if(!key) return;
  var pinDone = (pick&&pick.value)
    ? fetch('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/action',{method:'POST',headers:{'X-Api-Key':key,'Content-Type':'application/json'},body:JSON.stringify({action:'setConsultant',value:pick.value})}).catch(function(){})
    : Promise.resolve();
  pinDone.then(function(){
    doAction(btn,'bookingInvite',null,
      document.getElementById('invite-msg').value,'inv-msg');
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
startClock(); checkApiStatus(); load();
</script></body></html>`;
}

// ─── Routes ────────────────────────────────────────────────────────────────────
router.get('/leads', (_req, res) => res.type('html').send(buildLeadsQueueHTML()));
router.get('/lead/:leadId', (req, res) => res.type('html').send(buildLeadDetailHTML((req.params.leadId || '').trim())));

module.exports = router;
module.exports.buildLeadsQueueHTML = buildLeadsQueueHTML;
module.exports.buildLeadDetailHTML = buildLeadDetailHTML;
