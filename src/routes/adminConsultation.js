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

// ─── Inline icon set (stroke, currentColor — inherits size/colour) ───────────────
// Replaces emoji as structural icons. `${I.name}` bakes the SVG markup into the
// page at render time; for icons needed inside client-side string-building, the
// same markup is shipped as a JSON ICONS object (see buildDetailHTML).
const _svg = (p) => `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="flex:none;vertical-align:-.15em">${p}</svg>`;
const I = {
  back:      _svg('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
  video:     _svg('<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2"/>'),
  file:      _svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
  dollar:    _svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v12"/><path d="M15 9.5a2.5 2.5 0 0 0-2.5-1.7h-1A2 2 0 0 0 9.5 10c0 1.1.9 1.8 2 2h1a2 2 0 0 1 0 4h-1a2.5 2.5 0 0 1-2.5-1.7"/>'),
  mail:      _svg('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
  disc:      _svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>'),
  clip:      _svg('<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
  cap:       _svg('<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c3 2.5 9 2.5 12 0v-5"/>'),
  cpu:       _svg('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>'),
  bolt:      _svg('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>'),
  flag:      _svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><line x1="4" x2="4" y1="22" y2="15"/>'),
  userCheck: _svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>'),
  check:     _svg('<polyline points="20 6 9 17 4 12"/>'),
  send:      _svg('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
  refresh:   _svg('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>'),
  eye:       _svg('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  save:      _svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>'),
  plus:      _svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  cols:      _svg('<rect width="7" height="18" x="3" y="3" rx="1"/><rect width="7" height="18" x="14" y="3" rx="1"/>'),
  clock:     _svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
};
// Serialise leadId / labels / icons into a <script> safely: JSON.stringify does
// NOT escape `</script>`, so neutralise every `<` to its < escape.
const jsLit = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

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
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TDOT — Consultation</title><style>
  ${SHARED_CSS_VARS}
  ${NAV_CSS}
  body { background:var(--bg); }
  .wrap { max-width:min(1560px, 95vw); margin:0 auto; padding:20px 30px 90px; }
  #loading { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:50vh; gap:16px; }
  .spinner { width:42px; height:42px; border:3px solid #e2e8f0; border-top-color:var(--navy); border-radius:50%; animation:spin .7s linear infinite; }
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
  .iconbtn { width:36px; height:36px; border-radius:var(--r-sm); border:1px solid var(--border); background:#fff; color:var(--muted); display:inline-flex; align-items:center; justify-content:center; font-size:17px; cursor:pointer; text-decoration:none; transition:all .15s; }
  .iconbtn:hover { border-color:var(--navy); color:var(--navy); background:#f5f8fc; }
  .ctx-meta { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:14px; }
  .chip { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700; padding:5px 11px; border-radius:20px; background:#f1f5f9; color:#475569; }
  .chip svg { font-size:13px; }
  .chip.blue { background:#eff6ff; color:#2563eb; } .chip.green { background:#f0fdf4; color:#16a34a; }
  .chip.amber { background:#fffbeb; color:#d97706; } .chip.grey { background:#f1f5f9; color:#64748b; }
  .chip .pk { font-weight:600; opacity:.65; }
  .chip-reason { font-size:11px; color:var(--light); font-weight:500; }

  /* lifecycle stepper */
  .stepper { display:flex; gap:4px; background:var(--card); border:1px solid #eef2f7; border-radius:var(--r); box-shadow:var(--shadow-sm); padding:14px 12px; margin-bottom:14px; overflow-x:auto; }
  .step { display:flex; flex-direction:column; align-items:center; gap:6px; flex:1; min-width:62px; }
  .step .dot { width:24px; height:24px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; border:1.5px solid var(--border); color:var(--light); background:#fff; }
  .step .dot svg { font-size:13px; }
  .step.done .dot { background:var(--green); border-color:var(--green); color:#fff; }
  .step.cur .dot { background:var(--navy); border-color:var(--navy); color:#fff; box-shadow:0 0 0 4px rgba(26,53,88,.12); }
  .step .lbl { font-size:10.5px; font-weight:600; color:var(--light); text-align:center; white-space:nowrap; }
  .step.done .lbl { color:var(--muted); } .step.cur .lbl { color:var(--navy); font-weight:700; }

  /* two-column working area */
  .cols { display:grid; grid-template-columns:minmax(0,1.75fr) minmax(0,1fr); gap:16px; align-items:start; }
  @media (max-width:900px){ .cols{ grid-template-columns:1fr; } .ctx{ position:static; } }
  .col { display:flex; flex-direction:column; gap:14px; }
  .card { background:var(--card); border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; padding:16px 18px; }
  .card-t { display:flex; align-items:center; gap:7px; font-size:13px; font-weight:800; color:var(--navy); margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #f1f5f9; }
  .card-t svg { font-size:15px; color:var(--navy); }
  .card-t .when { margin-left:auto; font-weight:500; font-size:11px; color:var(--light); }
  .kv { display:flex; padding:6px 0; font-size:13px; border-top:1px solid #f8fafc; gap:10px; }
  .kv:first-child { border-top:none; }
  .kv .k { color:var(--muted); min-width:150px; flex-shrink:0; }
  .kv .v { color:var(--navy); font-weight:600; }
  /* Flow dense key/value rows into responsive columns so wide cards use the
     horizontal space; subheads, free-text and rrows still span the full width. */
  .kvgrid { display:grid; grid-template-columns:repeat(auto-fit, minmax(250px, 1fr)); column-gap:30px; align-items:start; }
  .kvgrid > *:not(.kv) { grid-column:1 / -1; }
  .kvgrid .kv .k { min-width:130px; }
  .kvgrid .kv { border-top:none; border-bottom:1px solid #f5f8fc; padding:6px 0; }
  .subhead { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.6px; color:#64748b; margin:0 0 6px; }
  .kvgrid .subhead { margin-top:12px; }
  .kvgrid > .subhead:first-child { margin-top:0; }
  .rrow { border:1px dashed var(--border); border-radius:8px; padding:9px 12px; margin-top:8px; font-size:12.5px; color:var(--navy); line-height:1.55; }
  .notyet { color:#94a3b8; font-size:13px; font-style:italic; padding:8px 0; }

  /* action groups */
  .agroup { padding-top:13px; margin-top:13px; border-top:1px solid #f1f5f9; }
  .obtns { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:2px; }
  .obtn { padding:9px 10px; border:1px solid var(--border); border-radius:8px; background:white; font-size:12.5px; font-weight:600; cursor:pointer; color:var(--navy); font-family:inherit; text-align:center; transition:all .12s; }
  .obtn:hover:not(:disabled) { border-color:var(--navy); background:#f0f4f8; }
  .obtn.active { background:var(--navy); color:white; border-color:var(--navy); box-shadow:var(--shadow-sm); }
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:9px 13px; border-radius:8px; font-size:12.5px; font-weight:700; text-decoration:none; border:1px solid var(--border); color:var(--navy); background:white; cursor:pointer; font-family:inherit; transition:all .12s; }
  .btn:hover:not(:disabled) { border-color:var(--navy); background:#f0f4f8; }
  .btn.primary { background:var(--navy); color:white; border-color:var(--navy); } .btn.primary:hover:not(:disabled) { background:var(--navy-light); }
  .frow { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .frow input { width:150px; padding:9px 11px; border:1px solid var(--border); border-radius:8px; font-size:14px; font-family:inherit; }
  .act-msg { display:none; padding:9px 12px; border-radius:8px; font-size:12.5px; margin:10px 0 0; font-weight:600; }
  .act-msg.info { background:#eff6ff; color:#2563eb; display:block; }
  .act-msg.ok { background:#f0fdf4; color:#16a34a; display:block; }
  .act-msg.err { background:#fef2f2; color:#dc2626; display:block; }
  button:disabled { opacity:.55; cursor:not-allowed; }

  /* retainer plan */
  .rp-field { margin-top:4px; }
  .rp-field select, .rp-field input { width:100%; max-width:420px; padding:9px 11px; border:1px solid var(--border); border-radius:8px; font-size:13px; font-family:inherit; }
  .rp-grid2 { display:flex; gap:10px; flex-wrap:wrap; }
  .rp-grid2 .rp-field { flex:1; min-width:200px; }
  .rp-check { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; color:var(--navy); margin-top:8px; }
  .rp-sugg { font-size:12px; color:#475569; background:#f8fafc; border:1px solid #eef2f7; border-radius:8px; padding:9px 12px; line-height:1.55; }
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
  .m-due { display:inline-block; font-size:9px; font-weight:800; padding:1px 6px; border-radius:9px; background:#fef2f2; color:#dc2626; text-transform:uppercase; letter-spacing:.4px; vertical-align:middle; margin-left:6px; }
  .rp-stage { font-weight:700; color:var(--navy); }
  .rp-fs { border:0; padding:0; margin:0; min-width:0; }
  .rp-fs:disabled { opacity:.82; }
  .rp-lock { display:flex; align-items:center; gap:12px; justify-content:space-between; background:#fffbeb; border:1px solid #fde68a; border-radius:10px; padding:10px 14px; margin-bottom:12px; font-size:13px; color:#92400e; }
  .rp-lock.amending { background:#eff6ff; border-color:#bfdbfe; color:#1e40af; }
  .rp-lock #rp-amend { flex:none; }
  .ms-row { display:flex; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid #f1f5f9; flex-wrap:wrap; }
  .ms-row:last-child { border-bottom:0; }
  .ms-label { flex:1; min-width:150px; font-size:13px; font-weight:600; color:#33425a; }
  .ms-amt { font-size:13px; font-weight:700; color:var(--navy); font-variant-numeric:tabular-nums; }
  .ms-badge { display:inline-block; font-size:9.5px; font-weight:800; padding:2px 8px; border-radius:10px; text-transform:uppercase; letter-spacing:.4px; }
  .ms-badge.paid { background:#f0fdf4; color:#16a34a; }
  .ms-badge.sent { background:#eff6ff; color:#2563eb; }
  .ms-badge.due { background:#fffbeb; color:#d97706; }
  .ms-badge.pending { background:#f1f5f9; color:#64748b; }
  .ms-row button { padding:6px 12px; font-size:12px; }

  a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible { outline:2px solid var(--navy); outline-offset:2px; }
</style></head><body>
${buildNavHeader('consultations')}
<main class="wrap">
  <a href="/admin/consultations" class="back-lnk">${I.back} All consultations</a>
  <div id="loading"><div class="spinner"></div><div class="muted">Loading consultation…</div></div>
  <div id="error-msg"></div>
  <div id="content">

    <div class="ctx">
      <div class="ctx-top">
        <div class="ctx-id">
          <div class="avatar" id="c-avatar">—</div>
          <div><h1 class="cname" id="c-name">—</h1><div class="csub" id="c-sub">—</div></div>
        </div>
        <div class="ctx-acts" id="c-acts"></div>
      </div>
      <div class="ctx-meta">
        <span id="c-pills" style="display:contents"></span>
        <span id="c-consultant" style="display:contents"></span>
      </div>
    </div>

    <div class="stepper" id="c-stepper"></div>

    <div class="cols">
      <div class="col">
        <div class="card"><div class="card-t">${I.clip} Intake context</div><div id="c-intake" class="kvgrid"></div></div>
        <div class="card"><div class="card-t">${I.cap} Eligibility profile <span class="when" id="c-elig-when"></span></div><div id="c-elig" class="kvgrid"></div></div>
        <div class="card"><div class="card-t">${I.cpu} AI triage notes</div><div id="c-ai"></div></div>
      </div>

      <div class="col">
        <div class="card actions">
          <div class="card-t">${I.bolt} Actions</div>
          <div class="subhead">Record outcome</div>
          <div class="obtns" id="obtns"></div>
          <div id="act-msg" class="act-msg"></div>
          <div class="agroup">
            <div class="subhead">Client communications</div>
            <div class="frow"><button class="btn" id="btn-invite">${I.send} Send booking invite</button></div>
            <div class="frow" style="margin-top:7px"><button class="btn" id="btn-resend">${I.refresh} Resend meeting + pre-consult links</button></div>
          </div>
          <div class="agroup">
            <div class="subhead">Initial consultation agreement <span class="muted" id="ca-sent"></span></div>
            <div id="ca-warn"></div>
            <div class="frow"><button class="btn" id="btn-consult-preview">${I.eye} Preview</button><button class="btn" id="btn-consult-send">${I.send} Send</button></div>
          </div>
        </div>
        <div class="card"><div class="card-t">${I.flag} Case status</div><div id="c-status" class="kvgrid"></div></div>
      </div>
    </div>

    <div class="card retainer actions" style="margin-top:14px">
      <div class="card-t">${I.dollar} Retainer plan</div>
      <div id="rp-msg" class="act-msg" style="margin-top:0;margin-bottom:10px"></div>

      <div id="rp-lock" class="rp-lock" style="display:none">
        <span id="rp-lock-msg"></span>
        <button class="btn" id="rp-amend" type="button">✎ Amend</button>
      </div>
      <fieldset id="rp-lock-fs" class="rp-fs">
      <div class="subhead">Retainer fee</div>
      <div class="frow">
        <input id="fee" type="number" min="1" step="1" placeholder="Fee (CAD $)">
        <button class="btn" id="btn-fee">${I.check} Set fee</button>
      </div>

      <div id="rp-suggestion" style="margin-top:13px"></div>
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

      <div class="subhead" style="margin-top:14px">${I.userCheck} Family members <span class="muted">(consultant-set · only “accompanying” members get a checklist + questionnaire)</span></div>
      <table class="dynamic-table" id="family-table">
        <thead><tr><th style="width:34%">Type</th><th style="width:42%">Full name</th><th style="width:18%">Accompanying</th><th></th></tr></thead>
        <tbody id="family-body"></tbody>
      </table>
      <button class="btn" id="rp-add-family" type="button" style="margin-top:8px">${I.plus} Add family member</button>

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
      <div class="rp-grid2" style="margin-top:10px">
        <div class="rp-field">
          <div class="subhead">HST rate (%) <span class="muted">(13% default · 0 for HST-exempt)</span></div>
          <input id="rp-hst" type="number" min="0" step="0.5" value="13">
        </div>
        <div class="rp-field"></div>
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

      <div class="subhead" style="margin-top:12px">Fees (auto-calculated)</div>
      <div id="rp-fee-breakdown" class="rp-sugg" style="margin-top:4px"></div>

      <div class="subhead" style="margin-top:12px">Milestone schedule <span id="rp-mile-sum" class="rp-sum"></span> <span id="rp-case-stage" class="muted" style="font-weight:500"></span></div>
      <table class="dynamic-table" id="milestone-table">
        <thead><tr><th style="width:32%">Label</th><th style="width:16%">Amount (CAD)</th><th style="width:13%">HST</th><th style="width:13%">Total</th><th style="width:18%">Trigger</th><th></th></tr></thead>
        <tbody id="milestone-body"></tbody>
      </table>
      <button class="btn" id="rp-add-mile" type="button" style="margin-top:8px">${I.plus} Add milestone</button>
      <button class="btn" id="rp-split-mile" type="button" style="margin-top:8px;margin-left:6px">${I.cols} Split fee evenly</button>

      <div class="frow" style="margin-top:14px">
        <button class="btn" id="btn-retainer-preview" type="button">${I.eye} Preview retainer agreement</button>
        <button class="btn primary" id="btn-retainer-save" type="button">${I.save} Save retainer plan</button>
      </div>
      </fieldset>
      <div class="frow" style="margin-top:12px">
        <button class="btn" id="btn-signed">${I.userCheck} Mark retainer signed</button>
      </div>

      <div class="subhead" style="margin-top:16px">${I.dollar} Milestone payments</div>
      <div id="rp-milestone-pay"><span class="muted">Payment status appears here once the retainer plan is set. The first milestone is charged automatically at retain; later milestones show a “Generate payment link” button once they’re due.</span></div>
    </div>
  </div>
</main>
<script>
var LEAD_ID=${jsLit(leadId)};
var OUTCOMES=${jsLit(OUTCOME_LABELS)};
var ICONS=${jsLit({ video: I.video, file: I.file, disc: I.disc, mail: I.mail, userCheck: I.userCheck, clock: I.clock, check: I.check })};
${SHARED_AUTH_JS}
function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function safeUrl(u){ u=String(u==null?'':u).trim(); return /^(https?:|mailto:)/i.test(u)?u:'#'; } // block javascript:/data: in href
var RP_HYDRATED=false; // hydrate the retainer panel from the detail payload only once (don't clobber edits)
// Lock state: once the retainer agreement is sent, fee + plan are read-only unless the consultant "Amend"s.
var RP_LOCKED=false, RP_AMEND=false;
function kv(k,v){ return v&&String(v).trim()?'<div class="kv"><span class="k">'+escHtml(k)+'</span><span class="v">'+escHtml(v)+'</span></div>':''; }
function scores(arr){ var p=(arr||[]).map(function(v){return String(v||'').trim();}); return p.some(Boolean)?p.map(function(v){return v||'—';}).join(' / '):''; }
function initials(n){ var p=String(n||'').trim().split(/\\s+/).filter(Boolean); return (p.length?(p[0][0]+(p.length>1?p[p.length-1][0]:'')):'?').toUpperCase(); }

// Read-only lifecycle stepper, derived from the consultation's current columns.
function buildStepper(d){
  var steps=[
    { k:'Booked',   done:!!(d.bookedSlot||d.bookingStatus==='Booked'||d.bookingStatus==='Slot Held') },
    { k:'Consult',  done:!!(d.consultationHeld||d.outcome) },
    { k:'Outcome',  done:!!d.outcome },
    { k:'Retainer', done:!!(d.retainerSent && String(d.retainerSent).trim()) },
    { k:'Signed',   done:!!d.retainerSigned },
    { k:'Paid',     done:!!d.retainerPaid },
    { k:'Case',     done:!!d.clientMasterItemId }
  ];
  var cur=-1; for(var i=0;i<steps.length;i++){ if(!steps[i].done){ cur=i; break; } } if(cur<0) cur=steps.length-1;
  return steps.map(function(s,i){
    var cls=s.done?'done':(i===cur?'cur':'');
    var dot=s.done?ICONS.check:String(i+1);
    return '<div class="step '+cls+'"><span class="dot">'+dot+'</span><span class="lbl">'+s.k+'</span></div>';
  }).join('');
}

function render(d){
  document.getElementById('c-avatar').textContent=initials(d.name||d.leadId);
  document.getElementById('c-name').textContent=d.name||d.leadId;
  document.getElementById('c-sub').textContent=(d.serviceRequired||'—')+'  ·  '+(d.tier?('Tier '+d.tier):'')+'  ·  lead '+d.leadId;

  var acts='';
  if(d.meetingLink) acts+='<a class="btn primary" href="'+escHtml(safeUrl(d.meetingLink))+'" target="_blank" rel="noopener">'+ICONS.video+' Join meeting</a>';
  if(d.preConsultPdf) acts+='<a class="iconbtn" title="Dossier PDF" aria-label="Dossier PDF" href="'+escHtml(safeUrl(d.preConsultPdf))+'" target="_blank" rel="noopener">'+ICONS.file+'</a>';
  if(d.recordingLink) acts+='<a class="iconbtn" title="Recording" aria-label="Recording" href="'+escHtml(safeUrl(d.recordingLink))+'" target="_blank" rel="noopener">'+ICONS.disc+'</a>';
  if(d.transcriptLink) acts+='<a class="iconbtn" title="Transcript" aria-label="Transcript" href="'+escHtml(safeUrl(d.transcriptLink))+'" target="_blank" rel="noopener">'+ICONS.file+'</a>';
  if(d.email) acts+='<a class="iconbtn" title="Email client" aria-label="Email client" href="'+escHtml(safeUrl('mailto:'+d.email))+'">'+ICONS.mail+'</a>';
  document.getElementById('c-acts').innerHTML=acts;

  var pills='';
  pills+='<span class="chip blue">'+ICONS.clock+'<span class="pk">Slot</span> '+escHtml(d.bookedSlot||'—')+'</span>';
  pills+='<span class="chip '+(d.preConsultSubmitted?'green':'amber')+'"><span class="pk">Pre-consult</span> '+(d.preConsultSubmitted?'Submitted':'Pending')+'</span>';
  pills+='<span class="chip '+(d.outcome?'blue':'grey')+'"><span class="pk">Outcome</span> '+escHtml(d.outcome||'Not set')+'</span>';
  if(d.retainerFee) pills+='<span class="chip grey"><span class="pk">Fee</span> $'+escHtml(d.retainerFee)+'</span>';
  document.getElementById('c-pills').innerHTML=pills;

  var ac=d.assignedConsultant||{};
  document.getElementById('c-consultant').innerHTML = ac.name
    ? '<span class="chip green">'+ICONS.userCheck+escHtml(ac.name)+(ac.needsVerify?' <span class="rp-flag verify">verify</span>':'')+'</span>'+(ac.reason?'<span class="chip-reason">routed: '+escHtml(ac.reason)+'</span>':'')
    : '';

  document.getElementById('c-stepper').innerHTML=buildStepper(d);

  highlightOutcome(d.outcome||'');
  var fee=document.getElementById('fee'); if(fee && !fee.value && d.retainerFee) fee.value=d.retainerFee;
  // Hydrate the retainer panel from the detail payload ONCE (saves a second
  // getLead round-trip); later renders (after an action) keep in-progress edits.
  if(!RP_HYDRATED){
    if(d.retainerPlan){ hydrateRetainer(d.retainerPlan); RP_HYDRATED=true; }
    else { loadRetainerPlan(); } // fallback: separate fetch (older payload)
  } else { updateMileSum(); } // keep the milestone sum in step with the fee
  // Lock fee+plan once the agreement is sent (trim to match the server guard). Reset
  // amend on every render so the panel re-locks after any action, not just a committed one.
  RP_LOCKED = !!(d.retainerSent && String(d.retainerSent).trim()); RP_AMEND = false; applyRetainerLock();

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
    (d.situationDescription?'<div class="subhead" style="margin-top:10px">Their inquiry</div><div style="font-size:13px;color:var(--navy);line-height:1.6">'+escHtml(d.situationDescription)+'</div>':'');

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
    h+='<div class="subhead" style="margin-top:10px">Education</div>'+kv('Highest education',e.highestEducation);
    (e.education||[]).forEach(function(r,i){ h+='<div class="rrow"><b>Education '+(i+1)+':</b> '+escHtml([r.program,r.school,r.location,(r.start||r.end)?((r.start||'?')+'–'+(r.end||'?')):'',r.completed].filter(Boolean).join(' · '))+'</div>'; });
    h+='<div class="subhead" style="margin-top:10px">Employment</div>'+kv('Paid TEER 0–3 work (last 5y)',e.teer);
    (e.employment||[]).forEach(function(r,i){ h+='<div class="rrow"><b>Job '+(i+1)+':</b> '+escHtml([r.title,r.company,r.country,(r.start||r.end)?((r.start||'?')+'–'+(r.end||'?')):'',r.type,r.hours?(r.hours+'h/wk'):'',r.duties].filter(Boolean).join(' · '))+'</div>'; });
    h+=kv('Employer earned > $1M (PNP)',e.employerRevenue);
    h+='<div class="subhead" style="margin-top:10px">Language</div>'+kv('English test',l.englishTest)+kv('English type',l.englishType)+kv('English (L/R/W/S)',scores(l.english))+kv('French test',l.frenchTest)+kv('French (L/R/W/S)',scores(l.french));
    h+='<div class="subhead" style="margin-top:10px">Family for assessment</div>'+kv('Spouse / common-law',fam.hasSpouse)+kv('Consider spouse profile',fam.spouseConsider)+kv('Adult child (18+) to consider',fam.adultChild);
    if(e.finalNote) h+='<div class="subhead" style="margin-top:10px">Client note</div><div style="font-size:13px;color:var(--navy);line-height:1.6">'+escHtml(e.finalNote)+'</div>';
    el.innerHTML=h;
  }

  var ai='';
  if(d.aiTalkingPoints) ai+='<div class="subhead">Talking points</div><div style="font-size:13px;color:var(--navy);line-height:1.6;white-space:pre-wrap">'+escHtml(d.aiTalkingPoints)+'</div>';
  if(d.aiComplianceFlags) ai+='<div class="subhead" style="margin-top:10px">Compliance flags</div><div style="font-size:13px;color:#b45309;line-height:1.6;white-space:pre-wrap">'+escHtml(d.aiComplianceFlags)+'</div>';
  if(d.priorityReasons) ai+='<div class="subhead" style="margin-top:10px">Priority reasons</div><div style="font-size:13px;color:var(--navy);line-height:1.6">'+escHtml(d.priorityReasons)+'</div>';
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
    body: JSON.stringify({ action:action, value:value, amend: RP_AMEND })
  }).then(function(r){ return r.json().then(function(j){ return {status:r.status,j:j}; }); })
   .then(function(res){
     disableActions(false);
     if(res.status===401||res.status===403){ window.location.href='/admin'; return; }
     if(res.status!==200) throw new Error((res.j&&res.j.error)||('HTTP '+res.status));
     setMsg(res.j.message||'Done.','ok');
     if(action==='saveRetainerSelections'||action==='generateMilestoneLink') RP_HYDRATED=false; // re-hydrate the panel (fresh plan / milestone-payment status)
     load(); // refresh consultation state (pills, status, outcome highlight) — render() re-locks + resets amend
   }).catch(function(e){ disableActions(false); setMsg(netErr(e),'err'); });
}

// Lock/unlock the retainer fee + plan once the agreement is sent. A disabled
// <fieldset> also disables dynamically-rebuilt milestone/family rows. "Amend"
// re-enables it for a deliberate, logged change (the server records a note).
function applyRetainerLock(){
  var fs=document.getElementById('rp-lock-fs'), banner=document.getElementById('rp-lock'),
      msg=document.getElementById('rp-lock-msg'), amendBtn=document.getElementById('rp-amend');
  if(fs) fs.disabled = RP_LOCKED && !RP_AMEND;
  if(banner){ banner.style.display = RP_LOCKED ? 'flex' : 'none'; banner.className = 'rp-lock' + (RP_AMEND ? ' amending' : ''); }
  if(msg) msg.innerHTML = RP_AMEND
    ? '✎ <b>Amending a sent agreement.</b> Changes are recorded as a note — the client may hold the original terms.'
    : '🔒 <b>The retainer agreement has been sent.</b> The fee &amp; milestones are locked.';
  if(amendBtn) amendBtn.style.display = (RP_LOCKED && !RP_AMEND) ? 'inline-flex' : 'none';
}
function startAmend(){
  if(!window.confirm('The retainer agreement has already been emailed to the client. Amending the fee or milestones will NOT re-send it, and the client may hold an agreement stating the original terms — a staff note will record the change. Continue?')) return;
  RP_AMEND=true; applyRetainerLock();
}

// ── Retainer plan panel ──────────────────────────────────────────────────
var RP_TPL_LABELS={ 'pa':'Principal Applicant only', 'pa-inviter':'PA + Inviter / Sponsor', 'employer':'Employer / Legal Rep' };
var FAMILY_TYPES=['Spouse','Dependent Child','Parent','Sibling','Sponsor'];
// Curated case-stage triggers + the case's live stage (both hydrated from the
// retainer-plan payload). A milestone shows "DUE" when its trigger == CUR_CASE_STAGE.
var MILE_TRIGGER_STAGES=['Pre-Onboarding','Retainer Confirmed','Document Collection Started','Internal Review','Submission Preparation','Submission Ready','Application Submitted'];
var CUR_CASE_STAGE='';
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
  if(rpEl('rp-hst')) rpEl('rp-hst').value=(plan.hstRate!=null)?(Math.round(plan.hstRate*1000)/10):13;
  var m=plan.mergeData||{};
  RP_BLOCK_FIELDS.forEach(function(k){ var el=rpEl('rp-'+k); if(el) el.value=m[k]||''; });
  if(d.milestoneTriggerStages&&d.milestoneTriggerStages.length) MILE_TRIGGER_STAGES=d.milestoneTriggerStages;
  CUR_CASE_STAGE=d.currentCaseStage||'';
  var cs=rpEl('rp-case-stage'); if(cs) cs.innerHTML=CUR_CASE_STAGE?('· case is at <span class="rp-stage">'+escHtml(CUR_CASE_STAGE)+'</span>'):'';
  rebuildMilestones(plan.milestones||[]);
  if(d.familyMemberTypes&&d.familyMemberTypes.length) FAMILY_TYPES=d.familyMemberTypes;
  rebuildFamily(d.familyMembers||[]);
  renderMilestonePayments(d.milestonePayments||[]);
  var flag=annex.code?(annex.needsVerify?'<span class="rp-flag verify">verify</span>':'<span class="rp-flag high">high</span>'):'';
  rpEl('rp-suggestion').innerHTML='<div class="rp-sugg"><b>Suggested:</b> '+escHtml(RP_TPL_LABELS[plan.template]||plan.template||'—')+' · '+(annex.code?('['+escHtml(annex.code)+'] '+escHtml(annex.label||'')):'no annex auto-selected')+flag+(annex.basis?('<br><span class="muted">'+escHtml(annex.basis)+'</span>'):'')+(d.saved?' <span class="muted">· saved plan loaded</span>':'')+'</div>';
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
function mileTriggerCell(m){
  var trig=m.trigger||'';
  // Curated case-stage dropdown. Keep any legacy / off-list value as a selectable
  // option so an older free-text trigger is never silently dropped.
  var stages=MILE_TRIGGER_STAGES.slice();
  if(trig&&stages.indexOf(trig)<0) stages.unshift(trig);
  var opts='<option value="">— when due —</option>'+stages.map(function(s){ return '<option value="'+escA(s)+'"'+(s===trig?' selected':'')+'>'+escHtml(s)+'</option>'; }).join('');
  return '<td><select class="m-trigger">'+opts+'</select><span class="m-due" style="display:none">Due</span></td>';
}
function mileRowHtml(m,locked){
  return '<td><input class="m-label" type="text" value="'+escA(m.label||'')+'"'+(locked?' disabled':'')+'></td>'+
    '<td><input class="m-amount" type="number" min="0" step="0.01" value="'+(m.amountCents!=null?(m.amountCents/100):'')+'"></td>'+
    '<td class="m-hst muted" style="text-align:right;white-space:nowrap"></td>'+
    '<td class="m-total" style="text-align:right;white-space:nowrap;font-weight:600;color:var(--navy)"></td>'+
    mileTriggerCell(m)+
    '<td>'+(locked?'<span class="muted">locked</span>':'<button type="button" class="rm-btn" data-rm="1">✕</button>')+'</td>';
}
// Show "Due" on the milestone whose trigger stage the case has currently reached.
function updateDue(tr){
  var sel=tr.querySelector('.m-trigger'), badge=tr.querySelector('.m-due');
  if(!sel||!badge) return;
  badge.style.display=(CUR_CASE_STAGE&&sel.value&&sel.value===CUR_CASE_STAGE)?'inline-block':'none';
}
// Milestone payments panel (outside the locked plan editor — collecting a payment
// isn't editing the contract). A "Generate payment link" button shows on a
// pending milestone once it's due; status shows Paid / Link sent otherwise.
function renderMilestonePayments(list){
  var el=rpEl('rp-milestone-pay'); if(!el) return;
  if(!list||!list.length){ el.innerHTML='<span class="muted">No milestones set yet.</span>'; return; }
  el.innerHTML=list.map(function(m){
    var badge = m.status==='paid' ? '<span class="ms-badge paid">Paid</span>'
              : m.status==='sent' ? '<span class="ms-badge sent">Link sent</span>'
              : (m.due ? '<span class="ms-badge due">Due</span>' : '<span class="ms-badge pending">Pending</span>');
    var amt='$'+(Number(m.totalCents||0)/100).toFixed(2);
    var btn=(m.status==='pending'&&m.due)?'<button class="btn primary" type="button" data-msp="'+m.index+'">'+ICONS.check+' Generate payment link</button>':'';
    return '<div class="ms-row"><span class="ms-label">'+escHtml(m.label||('Milestone '+(m.index+1)))+'</span><span class="ms-amt">'+amt+'</span>'+badge+btn+'</div>';
  }).join('');
  Array.prototype.forEach.call(el.querySelectorAll('[data-msp]'),function(b){
    b.onclick=function(){ doAction('generateMilestoneLink', b.getAttribute('data-msp'), 'Generate and email the payment link for this milestone to the client now?'); };
  });
}
function rebuildMilestones(rows){
  var tb=rpEl('milestone-body'); tb.innerHTML='';
  if(!rows||!rows.length) rows=[{label:'Milestone 1 – Non-Refundable Admin Fee',amountCents:0,locked:true}];
  rows.forEach(function(m,i){ var tr=document.createElement('tr'); tr.innerHTML=mileRowHtml(m,i===0); tb.appendChild(tr); });
  bindMile();
}
function addMile(){ var tr=document.createElement('tr'); tr.innerHTML=mileRowHtml({label:'',amountCents:null,trigger:''},false); rpEl('milestone-body').appendChild(tr); bindMile(); }
function bindMile(){
  Array.prototype.forEach.call(document.querySelectorAll('#milestone-body .m-amount'),function(i){ i.oninput=updateMileSum; });
  Array.prototype.forEach.call(document.querySelectorAll('#milestone-body [data-rm]'),function(b){ b.onclick=function(){ var tb=rpEl('milestone-body'); if(tb.rows.length>1){ b.closest('tr').remove(); updateMileSum(); } }; });
  Array.prototype.forEach.call(document.querySelectorAll('#milestone-body tr'),function(tr){ var s=tr.querySelector('.m-trigger'); if(s) s.onchange=function(){ updateDue(tr); }; updateDue(tr); });
}
// ── Family members (consultant-set; materialised to the board at handoff) ──
function famRowHtml(m){
  var opts=FAMILY_TYPES.map(function(t){ return '<option value="'+escA(t)+'"'+(m.type===t?' selected':'')+'>'+escHtml(t)+'</option>'; }).join('');
  return '<td><select class="f-type">'+opts+'</select></td>'+
    '<td><input class="f-name" type="text" value="'+escA(m.name||'')+'" placeholder="Full name (optional)"></td>'+
    '<td style="text-align:center"><input class="f-acc" type="checkbox"'+(m.accompanying?' checked':'')+'></td>'+
    '<td><button type="button" class="rm-btn" data-rmf="1">✕</button></td>';
}
function rebuildFamily(rows){ var tb=rpEl('family-body'); if(!tb) return; tb.innerHTML=''; (rows||[]).forEach(function(m){ var tr=document.createElement('tr'); tr.innerHTML=famRowHtml(m); tb.appendChild(tr); }); bindFamily(); }
function addFamily(){ var tr=document.createElement('tr'); tr.innerHTML=famRowHtml({type:'Spouse',name:'',accompanying:true}); rpEl('family-body').appendChild(tr); bindFamily(); }
function bindFamily(){ Array.prototype.forEach.call(document.querySelectorAll('#family-body [data-rmf]'),function(b){ b.onclick=function(){ b.closest('tr').remove(); }; }); }
function collectFamily(){
  return Array.prototype.map.call(document.querySelectorAll('#family-body tr'),function(tr){
    return { type:((tr.querySelector('.f-type')||{}).value||'').trim(), name:((tr.querySelector('.f-name')||{}).value||'').trim(), accompanying:!!((tr.querySelector('.f-acc')||{}).checked) };
  }).filter(function(m){ return m.type; });
}
function feeCentsNow(){ var fe=rpEl('fee'); var f=Number(String((fe&&fe.value)||'').replace(/[^0-9.]/g,'')); return f>0?Math.round(f*100):0; }
function collectMilestones(){
  return Array.prototype.map.call(document.querySelectorAll('#milestone-body tr'),function(tr,i){
    return { label:(tr.querySelector('.m-label').value||'').trim(), amountCents:Math.round((Number(tr.querySelector('.m-amount').value)||0)*100), trigger:(tr.querySelector('.m-trigger').value||'').trim(), locked:i===0 };
  });
}
function fmtC(c){ return '$'+(c/100).toFixed(2); }
function hstRateNow(){ var el=rpEl('rp-hst'); var v=Number((el&&el.value)||'13'); return (Number.isFinite(v)&&v>=0)?v/100:0.13; }
function updateMileSum(){
  var fee=feeCentsNow(), rate=hstRateNow(), rpct=Math.round(rate*1000)/10;
  // Per-milestone HST + total (auto), and running sums.
  var sum=0, hstSum=0;
  Array.prototype.forEach.call(document.querySelectorAll('#milestone-body tr'),function(tr){
    var amt=Math.round((Number(tr.querySelector('.m-amount').value)||0)*100);
    var h=Math.round(amt*rate); sum+=amt; hstSum+=h;
    var hc=tr.querySelector('.m-hst'), tc=tr.querySelector('.m-total');
    if(hc) hc.textContent=fmtC(h); if(tc) tc.textContent=fmtC(amt+h);
  });
  var fb=rpEl('rp-fee-breakdown');
  if(fb){
    fb.innerHTML = fee>0
      ? ('Professional fee <b>'+fmtC(sum)+'</b> &nbsp;·&nbsp; HST ('+rpct+'%) <b>'+fmtC(hstSum)+'</b> &nbsp;·&nbsp; <b>Total (incl. HST) '+fmtC(sum+hstSum)+'</b>'
         + (rate===0?' &nbsp;<span class="muted">(HST-exempt)</span>':''))
      : '<span class="muted">Set the retainer fee (above) — HST &amp; totals calculate automatically per milestone.</span>';
  }
  var el=rpEl('rp-mile-sum'); if(!el) return;
  var ok=(fee>0 && sum===fee); el.className='rp-sum '+(ok?'ok':'bad');
  el.textContent='— milestones total '+fmtC(sum)+(fee>0?(' / fee '+fmtC(fee)+(ok?' ✓':(' (off by '+fmtC(Math.abs(sum-fee))+')'))):' (set the fee first)');
}
// Distribute the professional fee evenly across the current milestone rows
// (remainder on the last) so the schedule auto-sums to the fee.
function splitMilestones(){
  var rows=document.querySelectorAll('#milestone-body .m-amount');
  var n=rows.length, fee=feeCentsNow();
  if(n && fee>0){ var base=Math.floor(fee/n);
    Array.prototype.forEach.call(rows,function(inp,i){ var cents=base+(i===n-1?(fee-base*n):0); inp.value=(cents/100).toFixed(2); });
  }
  updateMileSum();
}
function collectSelections(){
  var sel={ template:rpEl('rp-template').value, annexCode:rpEl('rp-annex').value, subType:(rpEl('rp-subtype').value||'').trim(),
    feeCents:feeCentsNow(), govFeeDollars: rpEl('rp-govfee').value!==''?Number(rpEl('rp-govfee').value):undefined,
    hstRate: Math.round(hstRateNow()*1000)/10, withRprf: rpEl('rp-rprf').checked, milestones:collectMilestones(), familyMembers:collectFamily() };
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
  var amendBtn=document.getElementById('rp-amend'); if(amendBtn) amendBtn.onclick=startAmend;
  rpEl('rp-template').onchange=toggleTemplateBlocks;
  rpEl('rp-add-mile').onclick=addMile;
  rpEl('rp-add-family').onclick=addFamily;
  rpEl('rp-split-mile').onclick=splitMilestones;
  rpEl('rp-hst').oninput=updateMileSum;
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
module.exports.buildDetailHTML = buildDetailHTML;
module.exports.buildQueueHTML = buildQueueHTML;
