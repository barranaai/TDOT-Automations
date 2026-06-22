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
  .actbar { background:#fffef5; border:1px solid #fde68a; border-radius:var(--r); padding:14px 18px; margin-bottom:16px; font-size:12.5px; color:#92400e; }
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

    <div class="actbar">⚙️ Outcome &amp; retainer actions arrive in the next step — for now this view is read-only. Today the consultant records the outcome and retainer on the Monday board.</div>

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
${SHARED_AUTH_JS}
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function kv(k,v){ return v&&String(v).trim()?'<div class="kv"><span class="k">'+escHtml(k)+'</span><span class="v">'+escHtml(v)+'</span></div>':''; }
function scores(arr){ var p=(arr||[]).map(function(v){return String(v||'').trim();}); return p.some(Boolean)?p.map(function(v){return v||'—';}).join(' / '):''; }

function render(d){
  document.getElementById('c-name').textContent=d.name||d.leadId;
  document.getElementById('c-sub').textContent=(d.serviceRequired||'—')+'  ·  '+(d.tier?('Tier '+d.tier):'')+'  ·  lead '+d.leadId;

  var acts='';
  if(d.meetingLink) acts+='<a class="btn primary" href="'+escHtml(d.meetingLink)+'" target="_blank" rel="noopener">🎥 Join meeting</a>';
  if(d.preConsultPdf) acts+='<a class="btn" href="'+escHtml(d.preConsultPdf)+'" target="_blank" rel="noopener">📄 Dossier PDF</a>';
  if(d.recordingLink) acts+='<a class="btn" href="'+escHtml(d.recordingLink)+'" target="_blank" rel="noopener">⏺ Recording</a>';
  if(d.email) acts+='<a class="btn" href="mailto:'+escHtml(d.email)+'">✉ Email</a>';
  document.getElementById('c-acts').innerHTML=acts;

  var pills='';
  pills+='<span class="pill blue"><span class="pk">Slot</span> '+escHtml(d.bookedSlot||'—')+'</span>';
  pills+='<span class="pill '+(d.preConsultSubmitted?'green':'amber')+'"><span class="pk">Pre-consult</span> '+(d.preConsultSubmitted?'Submitted':'Pending')+'</span>';
  pills+='<span class="pill '+(d.outcome?'blue':'grey')+'"><span class="pk">Outcome</span> '+escHtml(d.outcome||'Not set')+'</span>';
  if(d.retainerFee) pills+='<span class="pill grey"><span class="pk">Fee</span> $'+escHtml(d.retainerFee)+'</span>';
  document.getElementById('c-pills').innerHTML=pills;

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
startClock(); checkApiStatus(); load();
</script></body></html>`;
}

router.get('/consultations', (_req, res) => res.type('html').send(buildQueueHTML()));
router.get('/consultation/:leadId', (req, res) =>
  res.type('html').send(buildDetailHTML((req.params.leadId || '').trim())));

module.exports = router;
