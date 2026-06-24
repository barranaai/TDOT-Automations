/**
 * Consultant Portal
 *   GET /admin/consultations          — the consultant's booked-consultation queue
 *   GET /admin/consultation/:leadId    — one consultation, fully assembled
 *
 * Static pages (like the dashboard / case cockpit); data comes from
 * /api/consultations and /api/consultation/:leadId (behind ADMIN_API_KEY, key
 * in sessionStorage). Phase A is read-only — the outcome/retainer action
 * controls are added in Phase B.
 */

const express = require('express');
const router  = express.Router();
const { SHARED_CSS_VARS, NAV_CSS, buildNavHeader, SHARED_AUTH_JS } = require('./adminShared');
const { OUTCOME_LABELS } = require('../services/consultantPortalService');

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Queue page ────────────────────────────────────────────────────────────────
function buildQueueHTML() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TDOT — Consultations</title><style>
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
  .card { background:white; border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; overflow:hidden; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { background:#f8fafc; text-align:left; padding:11px 14px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.7px; color:#94a3b8; border-bottom:2px solid #f1f5f9; }
  td { padding:12px 14px; border-bottom:1px solid #f8fafc; }
  tr.row { cursor:pointer; }
  tr.row:hover td { background:#f8faff; }
  .pill { display:inline-flex; align-items:center; padding:2px 9px; border-radius:20px; font-size:10px; font-weight:700; }
  .pill.green { background:#f0fdf4; color:#16a34a; } .pill.grey { background:#f1f5f9; color:#64748b; }
  .pill.amber { background:#fffbeb; color:#d97706; } .pill.blue { background:#eff6ff; color:#2563eb; }
  .tier { font-weight:700; color:var(--navy); }
  .empty { padding:40px; text-align:center; color:#94a3b8; }
</style></head><body>
${buildNavHeader('consultations')}
<main class="wrap">
  <div id="loading"><div class="spinner"></div><div class="muted">Loading consultations…</div></div>
  <div id="error-msg"></div>
  <div id="content">
    <h1 class="page-h">Consultations</h1>
    <p class="page-sub">Your booked consultations — soonest first. Click one to open.</p>
    <div class="card">
      <table>
        <thead><tr><th>Client</th><th>Service</th><th>Tier</th><th>Slot (Toronto)</th><th>Pre-consult</th><th>Outcome</th></tr></thead>
        <tbody id="qbody"></tbody>
      </table>
    </div>
  </div>
</main>
<script>
${SHARED_AUTH_JS}
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function load(){
  var key=getKey(); if(!key) return;
  fetch('/api/consultations',{headers:{'X-Api-Key':key}})
   .then(function(r){ if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); } return r.json(); })
   .then(function(d){
     var rows=(d.consultations||[]);
     var tb=document.getElementById('qbody');
     if(!rows.length){ tb.innerHTML='<tr><td colspan="6" class="empty">No booked consultations right now.</td></tr>'; }
     else tb.innerHTML=rows.map(function(c){
       var pc=c.preConsultSubmitted?'<span class="pill green">Submitted</span>':'<span class="pill amber">Pending</span>';
       var oc=c.outcome?('<span class="pill blue">'+escHtml(c.outcome)+'</span>'):'<span class="pill grey">—</span>';
       return '<tr class="row" data-id="'+escHtml(c.id)+'">'+
         '<td style="font-weight:600;color:var(--navy)">'+escHtml(c.name)+'</td>'+
         '<td style="color:var(--muted)">'+escHtml(c.service||'—')+'</td>'+
         '<td class="tier">'+escHtml(c.tier||'—')+'</td>'+
         '<td>'+escHtml(c.bookedSlot||'—')+'</td>'+
         '<td>'+pc+'</td><td>'+oc+'</td></tr>';
     }).join('');
     Array.prototype.forEach.call(document.querySelectorAll('tr.row'),function(tr){
       tr.onclick=function(){ window.location.href='/admin/consultation/'+encodeURIComponent(tr.getAttribute('data-id')); };
     });
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

// ─── Detail page ────────────────────────────────────────────────────────────────
function buildDetailHTML(leadId) {
  const safe = escAttr(leadId);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TDOT — Consultation</title><style>
  ${SHARED_CSS_VARS}
  ${NAV_CSS}
  body { background:#f1f5f9; }
  .wrap { max-width:1000px; margin:0 auto; padding:24px 22px 80px; }
  #loading { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:50vh; gap:16px; }
  .spinner { width:42px; height:42px; border:3px solid #e2e8f0; border-top-color:var(--navy); border-radius:50%; animation:spin .7s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .muted { color:var(--light); font-size:12px; }
  #error-msg { display:none; background:#fff1f2; border:1px solid #fda4af; color:#dc2626; padding:14px 18px; border-radius:12px; margin:24px auto; max-width:520px; text-align:center; }
  #content { display:none; }
  .back-lnk { display:inline-flex; gap:6px; font-size:12px; font-weight:600; color:var(--muted); text-decoration:none; margin-bottom:14px; }
  .back-lnk:hover { color:var(--navy); }
  .hd { background:white; border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; padding:20px 22px; margin-bottom:16px; }
  .hd-top { display:flex; justify-content:space-between; align-items:flex-start; gap:14px; flex-wrap:wrap; }
  .cname { font-size:22px; font-weight:800; color:var(--navy); letter-spacing:-.5px; margin:0; }
  .csub { font-size:12px; color:var(--light); margin-top:3px; font-weight:600; }
  .acts { display:flex; gap:8px; flex-wrap:wrap; }
  .btn { display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border-radius:8px; font-size:12px; font-weight:700; text-decoration:none; border:1px solid var(--border); color:var(--navy); background:white; cursor:pointer; font-family:inherit; }
  .btn:hover { border-color:var(--navy); background:#f0f4f8; }
  .btn.primary { background:var(--navy); color:white; border-color:var(--navy); } .btn.primary:hover { background:var(--navy-light); }
  .pill-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }
  .pill { display:inline-flex; gap:5px; padding:5px 12px; border-radius:20px; font-size:11px; font-weight:700; }
  .pill.grey { background:#f1f5f9; color:#475569; } .pill.green { background:#f0fdf4; color:#16a34a; }
  .pill.amber { background:#fffbeb; color:#d97706; } .pill.blue { background:#eff6ff; color:#2563eb; } .pill.red { background:#fef2f2; color:#dc2626; }
  .pill .pk { font-weight:600; opacity:.7; }
  .grid { display:grid; gap:16px; grid-template-columns:1fr 1fr; }
  @media (max-width:820px){ .grid{ grid-template-columns:1fr; } }
  .card { background:white; border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; padding:18px 20px; }
  .card-t { font-size:13px; font-weight:800; color:var(--navy); margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #f1f5f9; }
  .kv { display:flex; padding:6px 0; font-size:13px; border-top:1px solid #f8fafc; gap:10px; }
  .kv:first-child { border-top:none; }
  .kv .k { color:var(--muted); min-width:150px; flex-shrink:0; }
  .kv .v { color:var(--navy); font-weight:600; }
  .subhead { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.6px; color:#64748b; margin:14px 0 4px; }
  .rrow { border:1px dashed var(--border); border-radius:8px; padding:9px 12px; margin-top:8px; font-size:12.5px; color:var(--navy); line-height:1.55; }
  .notyet { color:#94a3b8; font-size:13px; font-style:italic; padding:8px 0; }
  .actions { margin-bottom:16px; }
  .obtns { display:flex; gap:8px; flex-wrap:wrap; margin-top:4px; }
  .obtn { padding:8px 13px; border:1px solid var(--border); border-radius:8px; background:white; font-size:12.5px; font-weight:600; cursor:pointer; color:var(--navy); font-family:inherit; }
  .obtn:hover:not(:disabled) { border-color:var(--navy); background:#f0f4f8; }
  .obtn.active { background:var(--navy); color:white; border-color:var(--navy); }
  .frow { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:6px; }
  .frow input { width:150px; padding:9px 11px; border:1px solid var(--border); border-radius:8px; font-size:14px; }
  .act-msg { display:none; padding:9px 12px; border-radius:8px; font-size:12.5px; margin-bottom:12px; font-weight:600; }
  .act-msg.info { background:#eff6ff; color:#2563eb; display:block; }
  .act-msg.ok { background:#f0fdf4; color:#16a34a; display:block; }
  .act-msg.err { background:#fef2f2; color:#dc2626; display:block; }
  button:disabled { opacity:.55; cursor:not-allowed; }
  .rp-field { margin-top:4px; }
  .rp-field select, .rp-field input { width:100%; max-width:380px; padding:9px 11px; border:1px solid var(--border); border-radius:8px; font-size:13px; font-family:inherit; }
  .rp-grid2 { display:flex; gap:10px; flex-wrap:wrap; }
  .rp-grid2 .rp-field { flex:1; min-width:170px; }
  .rp-check { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; color:var(--navy); margin-top:8px; }
  .rp-sugg { font-size:12px; color:#475569; background:#f8fafc; border-radius:8px; padding:9px 12px; line-height:1.55; }
  .rp-flag { display:inline-block; font-size:9.5px; font-weight:800; padding:1px 7px; border-radius:10px; margin-left:6px; text-transform:uppercase; letter-spacing:.4px; }
  .rp-flag.high { background:#f0fdf4; color:#16a34a; } .rp-flag.verify { background:#fffbeb; color:#d97706; }
  .rp-warn { background:#fffbeb; border:1px solid #fde68a; color:#92400e; padding:9px 12px; border-radius:8px; font-size:12px; margin:10px 0; line-height:1.5; }
  .rp-warn ul { margin:5px 0 0; padding-left:18px; }
  .dynamic-table { width:100%; border-collapse:collapse; margin-top:6px; font-size:12.5px; }
  .dynamic-table th { background:#f8fafc; text-align:left; padding:7px 9px; font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; color:#94a3b8; }
  .dynamic-table td { padding:5px 6px; border-bottom:1px solid #f5f7fa; vertical-align:middle; }
  .dynamic-table input { width:100%; padding:7px 9px; border:1px solid var(--border); border-radius:7px; font-size:12.5px; font-family:inherit; }
  .dynamic-table input:disabled { background:#f8fafc; color:#64748b; }
  .rm-btn { padding:5px 9px; border:1px solid var(--border); border-radius:7px; background:white; cursor:pointer; color:#dc2626; font-size:12px; font-family:inherit; }
  .rp-sum { font-weight:700; font-size:12px; }
  .rp-sum.ok { color:#16a34a; } .rp-sum.bad { color:#dc2626; }
</style></head><body>
${buildNavHeader('consultations')}
<main class="wrap">
  <a href="/admin/consultations" class="back-lnk">← All consultations</a>
  <div id="loading"><div class="spinner"></div><div class="muted">Loading consultation…</div></div>
  <div id="error-msg"></div>
  <div id="content">
    <div class="hd">
      <div class="hd-top">
        <div><h1 class="cname" id="c-name">—</h1><div class="csub" id="c-sub">—</div></div>
        <div class="acts" id="c-acts"></div>
      </div>
      <div class="pill-row" id="c-pills"></div>
    </div>

    <div class="card actions">
      <div class="card-t">⚡ Actions</div>
      <div id="act-msg" class="act-msg"></div>
      <div class="subhead">Record outcome</div>
      <div class="obtns" id="obtns"></div>
      <div class="subhead">Retainer</div>
      <div class="frow">
        <input id="fee" type="number" min="1" step="1" placeholder="Fee (CAD $)">
        <button class="btn" id="btn-fee">Set fee</button>
        <button class="btn" id="btn-signed">Mark retainer signed</button>
      </div>
      <div class="subhead">Client communications</div>
      <div class="frow">
        <button class="btn" id="btn-invite">Send booking invite</button>
        <button class="btn" id="btn-resend">Resend meeting + pre-consult links</button>
      </div>
      <div class="subhead">Initial consultation agreement <span class="muted" id="ca-sent"></span></div>
      <div id="ca-warn"></div>
      <div class="frow">
        <button class="btn" id="btn-consult-preview">👁 Preview agreement</button>
        <button class="btn" id="btn-consult-send">📄 Send consultation agreement</button>
      </div>
    </div>

    <div class="card retainer actions" style="margin-bottom:16px">
      <div class="card-t">📄 Retainer plan</div>
      <div id="rp-msg" class="act-msg"></div>
      <div id="rp-suggestion"></div>
      <div id="rp-warnings"></div>

      <div class="rp-grid2" style="margin-top:12px">
        <div class="rp-field">
          <div class="subhead">Signatory template</div>
          <select id="rp-template"></select>
        </div>
        <div class="rp-field">
          <div class="subhead">Scope annex</div>
          <select id="rp-annex"></select>
        </div>
      </div>

      <div class="rp-grid2" style="margin-top:10px">
        <div class="rp-field">
          <div class="subhead">Sub-type <span class="muted">(optional — drives extension/restoration)</span></div>
          <input id="rp-subtype" type="text" placeholder="e.g. Extension (Inside Canada)">
        </div>
        <div class="rp-field">
          <div class="subhead">Government fee (CAD, default — editable)</div>
          <input id="rp-govfee" type="number" min="0" step="0.01" placeholder="0.00">
          <label class="rp-check"><input id="rp-rprf" type="checkbox"> Include RPRF</label>
        </div>
      </div>

      <div id="rp-inviter" style="display:none;margin-top:8px">
        <div class="subhead">Inviter / sponsor</div>
        <div class="rp-grid2">
          <div class="rp-field"><input id="rp-inviterName" type="text" placeholder="Name"></div>
          <div class="rp-field"><input id="rp-inviterEmail" type="text" placeholder="Email"></div>
        </div>
        <div class="rp-grid2" style="margin-top:6px">
          <div class="rp-field"><input id="rp-inviterPhone" type="text" placeholder="Phone"></div>
          <div class="rp-field"><input id="rp-inviterAddress" type="text" placeholder="Address"></div>
        </div>
      </div>

      <div id="rp-employer" style="display:none;margin-top:8px">
        <div class="subhead">Employer / legal representative</div>
        <div class="rp-grid2">
          <div class="rp-field"><input id="rp-empRepName" type="text" placeholder="Legal rep name"></div>
          <div class="rp-field"><input id="rp-empRepEmail" type="text" placeholder="Rep email"></div>
        </div>
        <div class="rp-grid2" style="margin-top:6px">
          <div class="rp-field"><input id="rp-empRepPhone" type="text" placeholder="Rep phone"></div>
          <div class="rp-field"><input id="rp-empCompanyName" type="text" placeholder="Company / legal entity"></div>
        </div>
        <div class="rp-grid2" style="margin-top:6px">
          <div class="rp-field"><input id="rp-empCompanyPhone" type="text" placeholder="Company phone"></div>
          <div class="rp-field"><input id="rp-empCompanyAddress" type="text" placeholder="Company address"></div>
        </div>
      </div>

      <div class="subhead" style="margin-top:12px">Milestone schedule <span id="rp-mile-sum" class="rp-sum"></span></div>
      <table class="dynamic-table" id="milestone-table">
        <thead><tr><th style="width:42%">Label</th><th style="width:22%">Amount (CAD)</th><th style="width:28%">Trigger</th><th></th></tr></thead>
        <tbody id="milestone-body"></tbody>
      </table>
      <button class="btn" id="rp-add-mile" type="button" style="margin-top:8px">+ Add milestone</button>

      <div class="frow" style="margin-top:14px">
        <button class="btn" id="btn-retainer-preview" type="button">👁 Preview PDF</button>
        <button class="btn primary" id="btn-retainer-save" type="button">💾 Save retainer plan</button>
      </div>
    </div>

    <div class="grid">
      <div class="card"><div class="card-t">🧭 Consultation status</div><div id="c-status"></div></div>
      <div class="card"><div class="card-t">📋 Intake context</div><div id="c-intake"></div></div>
    </div>

    <div class="card" style="margin-top:16px"><div class="card-t">🎓 Eligibility profile <span class="muted" id="c-elig-when"></span></div><div id="c-elig"></div></div>

    <div class="card" style="margin-top:16px"><div class="card-t">🤖 AI triage notes</div><div id="c-ai"></div></div>
  </div>
</main>
<script>
var LEAD_ID=${JSON.stringify(leadId)};
var OUTCOMES=${JSON.stringify(OUTCOME_LABELS)};
${SHARED_AUTH_JS}
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function safeUrl(u){ u=String(u==null?'':u).trim(); return /^(https?:|mailto:)/i.test(u)?u:'#'; } // block javascript:/data: in href
var RP_HYDRATED=false; // hydrate the retainer panel from the detail payload only once (don't clobber edits)
function kv(k,v){ return v&&String(v).trim()?'<div class="kv"><span class="k">'+escHtml(k)+'</span><span class="v">'+escHtml(v)+'</span></div>':''; }
function scores(arr){ var p=(arr||[]).map(function(v){return String(v||'').trim();}); return p.some(Boolean)?p.map(function(v){return v||'—';}).join(' / '):''; }

function render(d){
  document.getElementById('c-name').textContent=d.name||d.leadId;
  document.getElementById('c-sub').textContent=(d.serviceRequired||'—')+'  ·  '+(d.tier?('Tier '+d.tier):'')+'  ·  lead '+d.leadId;

  var acts='';
  if(d.meetingLink) acts+='<a class="btn primary" href="'+escHtml(safeUrl(d.meetingLink))+'" target="_blank" rel="noopener">🎥 Join meeting</a>';
  if(d.preConsultPdf) acts+='<a class="btn" href="'+escHtml(safeUrl(d.preConsultPdf))+'" target="_blank" rel="noopener">📄 Dossier PDF</a>';
  if(d.recordingLink) acts+='<a class="btn" href="'+escHtml(safeUrl(d.recordingLink))+'" target="_blank" rel="noopener">⏺ Recording</a>';
  if(d.email) acts+='<a class="btn" href="'+escHtml(safeUrl('mailto:'+d.email))+'">✉ Email</a>';
  document.getElementById('c-acts').innerHTML=acts;

  var pills='';
  pills+='<span class="pill blue"><span class="pk">Slot</span> '+escHtml(d.bookedSlot||'—')+'</span>';
  pills+='<span class="pill '+(d.preConsultSubmitted?'green':'amber')+'"><span class="pk">Pre-consult</span> '+(d.preConsultSubmitted?'Submitted':'Pending')+'</span>';
  pills+='<span class="pill '+(d.outcome?'blue':'grey')+'"><span class="pk">Outcome</span> '+escHtml(d.outcome||'Not set')+'</span>';
  if(d.retainerFee) pills+='<span class="pill grey"><span class="pk">Fee</span> $'+escHtml(d.retainerFee)+'</span>';
  document.getElementById('c-pills').innerHTML=pills;
  highlightOutcome(d.outcome||'');
  var fee=document.getElementById('fee'); if(fee && !fee.value && d.retainerFee) fee.value=d.retainerFee;
  // Hydrate the retainer panel from the detail payload ONCE (saves a second
  // getLead round-trip); later renders (after an action) keep in-progress edits.
  if(!RP_HYDRATED){
    if(d.retainerPlan){ hydrateRetainer(d.retainerPlan); RP_HYDRATED=true; }
    else { loadRetainerPlan(); } // fallback: separate fetch (older payload)
  } else { updateMileSum(); } // keep the milestone sum in step with the fee

  var ca=d.consultAgreement||{};
  document.getElementById('ca-sent').textContent=ca.sent?('· sent '+ca.sent):'';
  var caw=document.getElementById('ca-warn');
  caw.innerHTML=(ca.warnings&&ca.warnings.length)
    ? '<div class="rp-warn"><b>Before sending:</b><ul>'+ca.warnings.map(function(w){return '<li>'+escHtml(w)+'</li>';}).join('')+'</ul></div>' : '';

  document.getElementById('c-status').innerHTML=
    kv('Booking status',d.bookingStatus)+kv('Consultation held',d.consultationHeld)+
    kv('Outcome',d.outcome||'Not set')+kv('Retainer fee',d.retainerFee?('$'+d.retainerFee):'')+
    kv('Retainer sent',d.retainerSent)+kv('Retainer signed',d.retainerSigned)+kv('Retainer paid',d.retainerPaid)+
    (d.clientMasterItemId?kv('Case created','Yes (handed off)'):'');

  document.getElementById('c-intake').innerHTML=
    kv('Email',d.email)+kv('Phone',d.phone)+kv('Country',d.country)+
    kv('Service',d.serviceRequired)+kv('Inside Canada',d.insideCanada)+kv('Current status',d.currentStatus)+
    kv('Spouse',d.hasSpouse)+kv('Children',d.childrenCount)+
    (d.situationDescription?'<div class="subhead">Their inquiry</div><div style="font-size:13px;color:var(--navy);line-height:1.6">'+escHtml(d.situationDescription)+'</div>':'');

  // Eligibility profile
  var e=d.eligibility||{};
  var el=document.getElementById('c-elig');
  document.getElementById('c-elig-when').textContent=e.submitted&&e.submittedAt?('· submitted '+new Date(e.submittedAt).toLocaleDateString()):'';
  if(!e.submitted){ el.innerHTML='<div class="notyet">The client hasn\\'t submitted the pre-consultation form yet.</div>'; }
  else {
    var p=e.personal||{}, l=e.language||{}, fam=e.family||{};
    var h='<div class="subhead">Personal</div>'+
      kv('Age',p.age)+kv('In Canada',p.inCanada)+kv('Entered Canada',p.entryDate)+kv('Entry visa',p.entryVisa)+
      kv('Current status',p.currentStatus)+kv('Permit expiry',p.permitExpiry)+kv('Marital status',p.marital)+
      kv('Children',p.children)+kv('Relatives in Canada (PR/citizen)',p.relatives);
    h+='<div class="subhead">Education</div>'+kv('Highest education',e.highestEducation);
    (e.education||[]).forEach(function(r,i){ h+='<div class="rrow"><b>Education '+(i+1)+':</b> '+escHtml([r.program,r.school,r.location,(r.start||r.end)?((r.start||'?')+'–'+(r.end||'?')):'',r.completed].filter(Boolean).join(' · '))+'</div>'; });
    h+='<div class="subhead">Employment</div>'+kv('Paid TEER 0–3 work (last 5y)',e.teer);
    (e.employment||[]).forEach(function(r,i){ h+='<div class="rrow"><b>Job '+(i+1)+':</b> '+escHtml([r.title,r.company,r.country,(r.start||r.end)?((r.start||'?')+'–'+(r.end||'?')):'',r.type,r.hours?(r.hours+'h/wk'):'',r.duties].filter(Boolean).join(' · '))+'</div>'; });
    h+=kv('Employer earned > $1M (PNP)',e.employerRevenue);
    h+='<div class="subhead">Language</div>'+kv('English test',l.englishTest)+kv('English type',l.englishType)+kv('English (L/R/W/S)',scores(l.english))+kv('French test',l.frenchTest)+kv('French (L/R/W/S)',scores(l.french));
    h+='<div class="subhead">Family for assessment</div>'+kv('Spouse / common-law',fam.hasSpouse)+kv('Consider spouse profile',fam.spouseConsider)+kv('Adult child (18+) to consider',fam.adultChild);
    if(e.finalNote) h+='<div class="subhead">Client note</div><div style="font-size:13px;color:var(--navy);line-height:1.6">'+escHtml(e.finalNote)+'</div>';
    el.innerHTML=h;
  }

  var ai='';
  if(d.aiTalkingPoints) ai+='<div class="subhead">Talking points</div><div style="font-size:13px;color:var(--navy);line-height:1.6;white-space:pre-wrap">'+escHtml(d.aiTalkingPoints)+'</div>';
  if(d.aiComplianceFlags) ai+='<div class="subhead">Compliance flags</div><div style="font-size:13px;color:#b45309;line-height:1.6;white-space:pre-wrap">'+escHtml(d.aiComplianceFlags)+'</div>';
  if(d.priorityReasons) ai+='<div class="subhead">Priority reasons</div><div style="font-size:13px;color:var(--navy);line-height:1.6">'+escHtml(d.priorityReasons)+'</div>';
  document.getElementById('c-ai').innerHTML=ai||'<div class="notyet">No AI notes on this lead.</div>';
}

function load(){
  var key=getKey(); if(!key) return;
  fetch('/api/consultation/'+encodeURIComponent(LEAD_ID),{headers:{'X-Api-Key':key}})
   .then(function(r){ if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); }
     if(r.status===404) throw new Error('Consultation not found'); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
   .then(function(d){ render(d); document.getElementById('loading').style.display='none'; document.getElementById('content').style.display='block'; })
   .catch(function(e){ if(e.message==='x')return;
     document.getElementById('loading').style.display='none';
     var el=document.getElementById('error-msg'); el.textContent='Failed to load: '+e.message; el.style.display='block'; });
}

// ── Phase B: write actions ────────────────────────────────────────────────
function setMsg(text,kind){ var el=document.getElementById('act-msg'); el.className='act-msg '+kind; el.textContent=text; }
function actButtons(){ return Array.prototype.slice.call(document.querySelectorAll('.actions button')); }
function disableActions(on){ actButtons().forEach(function(b){ b.disabled=on; }); }
function highlightOutcome(cur){ Array.prototype.forEach.call(document.querySelectorAll('.obtn'),function(b){ b.classList.toggle('active', b.getAttribute('data-outcome')===cur); }); }

// fetch with a hard timeout so a hung request (e.g. a stalled CloudConvert
// render) can't leave the action buttons disabled forever.
function fetchT(url,opts,ms){ var ac=new AbortController(); var to=setTimeout(function(){ac.abort();},ms||60000); opts=opts||{}; opts.signal=ac.signal; return fetch(url,opts).finally(function(){clearTimeout(to);}); }
function netErr(e){ return e&&e.name==='AbortError' ? 'Timed out — please try again.' : ('Failed: '+(e&&e.message||e)); }

function doAction(action,value,confirmMsg){
  if(confirmMsg && !window.confirm(confirmMsg)) return;
  var key=getKey(); if(!key) return;
  setMsg('Working…','info'); disableActions(true);
  fetchT('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/action',{
    method:'POST', headers:{'X-Api-Key':key,'Content-Type':'application/json'},
    body: JSON.stringify({ action:action, value:value })
  }).then(function(r){ return r.json().then(function(j){ return {status:r.status,j:j}; }); })
   .then(function(res){
     disableActions(false);
     if(res.status===401||res.status===403){ window.location.href='/admin'; return; }
     if(res.status!==200) throw new Error((res.j&&res.j.error)||('HTTP '+res.status));
     setMsg(res.j.message||'Done.','ok');
     if(action==='saveRetainerSelections') RP_HYDRATED=false; // re-hydrate the panel from the freshly-saved plan
     load(); // refresh consultation state (pills, status, outcome highlight)
   }).catch(function(e){ disableActions(false); setMsg(netErr(e),'err'); });
}

// ── Retainer plan panel ──────────────────────────────────────────────────
var RP_TPL_LABELS={ 'pa':'Principal Applicant only', 'pa-inviter':'PA + Inviter / Sponsor', 'employer':'Employer / Legal Rep' };
var RP_BLOCK_FIELDS=['inviterName','inviterAddress','inviterPhone','inviterEmail','empRepName','empCompanyName','empCompanyAddress','empCompanyPhone','empRepPhone','empRepEmail'];
function rpEl(id){ return document.getElementById(id); }
function escA(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function rpMsg(t,k){ var el=rpEl('rp-msg'); el.className='act-msg '+k; el.textContent=t; }

function loadRetainerPlan(){
  var key=getKey(); if(!key) return;
  fetch('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/retainer-plan',{headers:{'X-Api-Key':key}})
   .then(function(r){ if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); } if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
   .then(function(d){ hydrateRetainer(d); RP_HYDRATED=true; })
   .catch(function(e){ if(e.message==='x')return; rpEl('rp-suggestion').innerHTML='<div class="rp-sugg">Could not load retainer plan: '+escHtml(e.message)+'</div>'; });
}

function hydrateRetainer(d){
  var plan=d.plan||{}, annex=plan.annex||{};
  var tsel=rpEl('rp-template');
  tsel.innerHTML=(d.templateOptions||['pa','pa-inviter','employer']).map(function(t){ return '<option value="'+escA(t)+'">'+escHtml(RP_TPL_LABELS[t]||t)+'</option>'; }).join('');
  tsel.value=plan.template||'pa';
  var groups={};
  (d.annexOptions||[]).forEach(function(a){ if(!groups[a.group])groups[a.group]=[]; groups[a.group].push(a); });
  var html='<option value="">— select scope annex —</option>';
  [['permanent','Permanent'],['temporary','Temporary']].forEach(function(g){ var list=groups[g[0]]; if(list&&list.length){ html+='<optgroup label="'+g[1]+'">'+list.map(function(a){ return '<option value="'+escA(a.code)+'">['+escHtml(a.code)+'] '+escHtml(a.label)+'</option>'; }).join('')+'</optgroup>'; } });
  var asel=rpEl('rp-annex'); asel.innerHTML=html; asel.value=annex.code||'';
  rpEl('rp-subtype').value=plan.subType||'';
  var gov=plan.govFee||{}; rpEl('rp-govfee').value=(gov.dollars!=null)?gov.dollars:'';
  rpEl('rp-rprf').checked=(gov.withRprf!==false);
  var m=plan.mergeData||{};
  RP_BLOCK_FIELDS.forEach(function(k){ var el=rpEl('rp-'+k); if(el) el.value=m[k]||''; });
  rebuildMilestones(plan.milestones||[]);
  var flag=annex.code?(annex.needsVerify?'<span class="rp-flag verify">verify</span>':'<span class="rp-flag high">high</span>'):'';
  rpEl('rp-suggestion').innerHTML='<div class="rp-sugg"><b>Suggested:</b> '+escHtml(RP_TPL_LABELS[plan.template]||plan.template||'—')+' · '+(annex.code?('['+annex.code+'] '+escHtml(annex.label||'')):'no annex auto-selected')+flag+(annex.basis?('<br><span class="muted">'+escHtml(annex.basis)+'</span>'):'')+(d.saved?' <span class="muted">· saved plan loaded</span>':'')+'</div>';
  renderRpWarnings(plan.warnings||[]);
  toggleTemplateBlocks();
  updateMileSum();
}

function renderRpWarnings(ws){
  var el=rpEl('rp-warnings');
  if(!ws||!ws.length){ el.innerHTML=''; return; }
  el.innerHTML='<div class="rp-warn"><b>Before sending, please check:</b><ul>'+ws.map(function(w){ return '<li>'+escHtml(w)+'</li>'; }).join('')+'</ul></div>';
}
function toggleTemplateBlocks(){
  var t=rpEl('rp-template').value;
  rpEl('rp-inviter').style.display=(t==='pa-inviter')?'block':'none';
  rpEl('rp-employer').style.display=(t==='employer')?'block':'none';
}
function mileRowHtml(m,locked){
  return '<td><input class="m-label" type="text" value="'+escA(m.label||'')+'"'+(locked?' disabled':'')+'></td>'+
    '<td><input class="m-amount" type="number" min="0" step="0.01" value="'+(m.amountCents!=null?(m.amountCents/100):'')+'"></td>'+
    '<td><input class="m-trigger" type="text" value="'+escA(m.trigger||'')+'"></td>'+
    '<td>'+(locked?'<span class="muted">locked</span>':'<button type="button" class="rm-btn" data-rm="1">✕</button>')+'</td>';
}
function rebuildMilestones(rows){
  var tb=rpEl('milestone-body'); tb.innerHTML='';
  if(!rows||!rows.length) rows=[{label:'Non-refundable administrative fee',amountCents:0,locked:true}];
  rows.forEach(function(m,i){ var tr=document.createElement('tr'); tr.innerHTML=mileRowHtml(m,i===0); tb.appendChild(tr); });
  bindMile();
}
function addMile(){ var tr=document.createElement('tr'); tr.innerHTML=mileRowHtml({label:'',amountCents:null,trigger:''},false); rpEl('milestone-body').appendChild(tr); bindMile(); }
function bindMile(){
  Array.prototype.forEach.call(document.querySelectorAll('#milestone-body .m-amount'),function(i){ i.oninput=updateMileSum; });
  Array.prototype.forEach.call(document.querySelectorAll('#milestone-body [data-rm]'),function(b){ b.onclick=function(){ var tb=rpEl('milestone-body'); if(tb.rows.length>1){ b.closest('tr').remove(); updateMileSum(); } }; });
}
function feeCentsNow(){ var fe=rpEl('fee'); var f=Number(String((fe&&fe.value)||'').replace(/[^0-9.]/g,'')); return f>0?Math.round(f*100):0; }
function collectMilestones(){
  return Array.prototype.map.call(document.querySelectorAll('#milestone-body tr'),function(tr,i){
    return { label:(tr.querySelector('.m-label').value||'').trim(), amountCents:Math.round((Number(tr.querySelector('.m-amount').value)||0)*100), trigger:(tr.querySelector('.m-trigger').value||'').trim(), locked:i===0 };
  });
}
function updateMileSum(){
  var el=rpEl('rp-mile-sum'); if(!el) return;
  var sum=collectMilestones().reduce(function(s,m){return s+m.amountCents;},0);
  var fee=feeCentsNow(); var ok=(fee>0 && sum===fee); el.className='rp-sum '+(ok?'ok':'bad');
  el.textContent='— total $'+(sum/100).toFixed(2)+(fee>0?(' / fee $'+(fee/100).toFixed(2)+(ok?' ✓':(' (off by $'+Math.abs((sum-fee)/100).toFixed(2)+')'))):' (set the fee above first)');
}
function collectSelections(){
  var sel={ template:rpEl('rp-template').value, annexCode:rpEl('rp-annex').value, subType:(rpEl('rp-subtype').value||'').trim(),
    feeCents:feeCentsNow(), govFeeDollars: rpEl('rp-govfee').value!==''?Number(rpEl('rp-govfee').value):undefined,
    withRprf: rpEl('rp-rprf').checked, milestones:collectMilestones() };
  RP_BLOCK_FIELDS.forEach(function(k){ var el=rpEl('rp-'+k); if(el) sel[k]=(el.value||'').trim(); });
  return sel;
}
function previewRetainer(){
  var key=getKey(); if(!key) return;
  rpMsg('Rendering preview… (a few seconds)','info'); disableActions(true);
  fetchT('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/retainer-preview',{ method:'POST', headers:{'X-Api-Key':key,'Content-Type':'application/json'}, body:JSON.stringify({value:collectSelections()}) })
   .then(function(r){ disableActions(false); if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); } if(!r.ok){ return r.json().then(function(j){ throw new Error((j&&j.error)||('HTTP '+r.status)); }); } return r.blob(); })
   .then(function(blob){ window.open(URL.createObjectURL(blob),'_blank'); rpMsg('Preview opened in a new tab.','ok'); })
   .catch(function(e){ disableActions(false); if(e.message==='x')return; rpMsg(netErr(e),'err'); });
}
function saveRetainer(){ doAction('saveRetainerSelections', JSON.stringify(collectSelections()), 'Save this retainer plan (template, scope annex, fees, milestones)? This does not send anything to the client.'); }

function previewConsult(){
  var key=getKey(); if(!key) return;
  setMsg('Rendering consultation agreement…','info'); disableActions(true);
  fetchT('/api/consultation/'+encodeURIComponent(LEAD_ID)+'/consult-agreement-preview',{ method:'POST', headers:{'X-Api-Key':key} })
   .then(function(r){ disableActions(false); if(r.status===401||r.status===403){ window.location.href='/admin'; throw new Error('x'); } if(!r.ok){ return r.json().then(function(j){ throw new Error((j&&j.error)||('HTTP '+r.status)); }); } return r.blob(); })
   .then(function(blob){ window.open(URL.createObjectURL(blob),'_blank'); setMsg('Consultation agreement preview opened in a new tab.','ok'); })
   .catch(function(e){ disableActions(false); if(e.message==='x')return; setMsg(netErr(e),'err'); });
}

function initActions(){
  var obtns=document.getElementById('obtns');
  OUTCOMES.forEach(function(label){
    var b=document.createElement('button'); b.type='button'; b.className='obtn'; b.textContent=label; b.setAttribute('data-outcome',label);
    b.onclick=function(){
      var msg='';
      if(label==='Retain'){
        var hasFee=Number(String(document.getElementById('fee').value||'').replace(/[^0-9.]/g,''))>0;
        msg = hasFee
          ? 'Record the outcome as RETAIN? This emails the retainer agreement (stating the fee) to the client.'
          : 'Record the outcome as RETAIN?\\n\\nNo retainer fee is set yet — the agreement states the fee, so it will NOT be emailed until you set the fee. You can set the fee now or after. Continue?';
      }
      doAction('outcome',label,msg);
    };
    obtns.appendChild(b);
  });
  document.getElementById('btn-fee').onclick=function(){
    var fee=document.getElementById('fee').value;
    if(!fee||Number(fee)<=0){ setMsg('Enter a fee amount in CAD dollars first.','err'); return; }
    doAction('retainerFee', fee, 'Set the retainer fee to $'+fee+'? If the retainer is already signed, this emails the payment link to the client.');
  };
  document.getElementById('btn-signed').onclick=function(){
    doAction('retainerSigned','', 'Mark the retainer SIGNED? This creates the client case and emails the payment link to the client.');
  };
  document.getElementById('btn-invite').onclick=function(){
    doAction('bookingInvite',null,'Email the client their booking invite now?');
  };
  document.getElementById('btn-resend').onclick=function(){
    doAction('resendLinks',null,'Re-send the meeting and pre-consultation links to the client now?');
  };
  // Retainer panel
  rpEl('rp-template').onchange=toggleTemplateBlocks;
  rpEl('rp-add-mile').onclick=addMile;
  rpEl('btn-retainer-preview').onclick=previewRetainer;
  rpEl('btn-retainer-save').onclick=saveRetainer;
  var feeInput=document.getElementById('fee'); if(feeInput) feeInput.addEventListener('input', updateMileSum);
  document.getElementById('btn-consult-preview').onclick=previewConsult;
  document.getElementById('btn-consult-send').onclick=function(){
    doAction('sendConsultAgreement', null, 'Email the initial consultation agreement to the client now? It states the consultation fee, 30-minute duration, and the booked date. Make sure the client\\'s address is filled in first.');
  };
}

initActions();
startClock(); checkApiStatus(); load(); // render() hydrates the retainer panel from the detail payload
</script></body></html>`;
}

router.get('/consultations', (_req, res) => res.type('html').send(buildQueueHTML()));
router.get('/consultation/:leadId', (req, res) =>
  res.type('html').send(buildDetailHTML((req.params.leadId || '').trim())));

module.exports = router;
