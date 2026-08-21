/**
 * Shared admin layout primitives.
 * Used by adminLogin, adminDashboard, and adminEngines.
 */

// ─── TDOT Logo — SELF-HOSTED (public/tdot-logo.png, served at /assets) ─────────
// Previously hot-linked from tdotimm.com's Next.js image optimizer; that URL now
// 404s (the marketing site moved to WordPress). Self-hosting = it never breaks
// again. The official logo is colour-on-white, so it sits on a white "chip" so it
// reads cleanly on the dark header.
const LOGO_URL = `${process.env.RENDER_URL || 'https://tdot-automations.onrender.com'}/assets/tdot-logo.png`;
const TDOT_LOGO_SVG = `<img src="${LOGO_URL}" alt="TDOT Immigration" style="height:34px;background:#fff;padding:4px 8px;border-radius:6px;object-fit:contain;display:block">`;

// ─── Larger variant used on the login page dark header ────────────────────────
const TDOT_LOGO_SVG_LARGE = `<img src="${LOGO_URL}" alt="TDOT Immigration" style="height:44px;background:#fff;padding:5px 10px;border-radius:8px;object-fit:contain;display:block">`;

// ─── Shared CSS variables + reset ────────────────────────────────────────────
const SHARED_CSS_VARS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --navy:         #1a3558;
    --navy-dark:    #111f35;
    --navy-light:   #224472;
    --navy-mid:     #1e3a5f;
    --orange:       #e65100;
    --orange-light: #ff6d00;
    --orange-pale:  #fff3ee;
    --green:        #16a34a;
    --green-bg:     #f0fdf4;
    --red:          #dc2626;
    --red-bg:       #fef2f2;
    --amber:        #d97706;
    --amber-bg:     #fffbeb;
    --blue:         #2563eb;
    --bg:           #f0f4f8;
    --card:         #ffffff;
    --border:       #e2e8f0;
    --text:         #1a202c;
    --muted:        #64748b;
    --light:        #94a3b8;
    --sidebar-w:    220px;
    --header-h:     60px;
    --shadow-sm:    0 1px 3px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.04);
    --shadow-md:    0 4px 8px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.05);
    --shadow-lg:    0 12px 28px rgba(0,0,0,.12), 0 4px 8px rgba(0,0,0,.06);
    --r:            12px;
    --r-sm:         8px;
  }

  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
`;

// ─── Shared top navigation bar ────────────────────────────────────────────────
//  Leads (whole Lead Board) + Consultations (booked only) are the nav
//  destinations — the Dashboard + Engine Controls links were retired so the
//  portal reads as a consultants-only tool. Those pages still render this bar
//  and remain reachable by direct URL (/admin/dashboard, /admin/engines).
//  activePage: 'leads' | 'consultations' | 'dashboard' (Cases) (others render the bar without an active link)
function buildNavHeader(activePage) {
  const isConsult = activePage === 'consultations';
  const isLeads   = activePage === 'leads';
  // The dashboard is the firm-wide Cases hub; the per-case cockpit also passes
  // 'dashboard', so "Cases" stays highlighted while viewing a single case.
  const isCases   = activePage === 'dashboard';

  return `<header class="admin-hdr">
  <div class="admin-hdr-left">
    <div class="admin-brand">
      ${TDOT_LOGO_SVG}
    </div>
    <div class="admin-divider"></div>
    <nav class="admin-nav">
      <a href="/admin/leads" class="nav-lnk${isLeads ? ' active' : ''}">
        <span class="nav-icon">📥</span> Leads
      </a>
      <a href="/admin/consultations" class="nav-lnk${isConsult ? ' active' : ''}">
        <span class="nav-icon">🗓️</span> Consultations
      </a>
      <a href="/admin/dashboard" class="nav-lnk${isCases ? ' active' : ''}">
        <span class="nav-icon">🗂️</span> Cases
      </a>
    </nav>
  </div>
  <div class="admin-hdr-right">
    <div class="status-pill" id="status-pill">
      <div class="status-dot pulse" id="sys-dot"></div>
      <span id="sys-text">Checking…</span>
    </div>
    <span class="hdr-clock" id="hdr-time"></span>
    <button class="sign-out-btn" onclick="signOut()">Sign Out</button>
  </div>
</header>`;
}

// ─── Shared nav CSS ───────────────────────────────────────────────────────────
const NAV_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');

  .admin-hdr {
    height: var(--header-h);
    background: linear-gradient(90deg, var(--navy-dark) 0%, var(--navy-mid) 100%);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 28px;
    position: sticky; top: 0; z-index: 300;
    box-shadow: 0 2px 16px rgba(0,0,0,.25);
  }

  .admin-hdr-left {
    display: flex; align-items: center; gap: 0;
  }

  .admin-brand {
    display: flex; align-items: center;
    padding-right: 22px;
  }

  .admin-divider {
    width: 1px; height: 28px;
    background: rgba(255,255,255,.15);
    margin-right: 20px;
  }

  .admin-nav {
    display: flex; align-items: center; gap: 4px;
  }

  .nav-lnk {
    display: flex; align-items: center; gap: 7px;
    padding: 7px 14px;
    border-radius: 8px;
    font-size: 13px; font-weight: 600;
    color: rgba(255,255,255,.65);
    text-decoration: none;
    transition: background .15s, color .15s;
    letter-spacing: -.1px;
  }

  .nav-lnk:hover { background: rgba(255,255,255,.1); color: white; }

  .nav-lnk.active {
    background: rgba(255,255,255,.14);
    color: white;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.15);
  }

  .nav-lnk.active::after {
    display: none;
  }

  .nav-icon { font-size: 14px; }

  .admin-hdr-right {
    display: flex; align-items: center; gap: 14px;
  }

  .status-pill {
    display: flex; align-items: center; gap: 7px;
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.14);
    padding: 5px 13px;
    border-radius: 20px;
    font-size: 12px; font-weight: 500;
    color: rgba(255,255,255,.8);
  }

  .status-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: #4ade80;
    flex-shrink: 0;
  }

  .status-dot.pulse { animation: dot-pulse 2s infinite; }
  .status-dot.offline { background: #f87171; animation: none; }

  @keyframes dot-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .35; }
  }

  .hdr-clock {
    font-size: 11px;
    color: rgba(255,255,255,.45);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .sign-out-btn {
    background: rgba(255,255,255,.09);
    border: 1px solid rgba(255,255,255,.18);
    color: rgba(255,255,255,.75);
    padding: 6px 14px;
    border-radius: 7px;
    font-size: 12px; font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all .15s;
    letter-spacing: -.1px;
  }

  .sign-out-btn:hover {
    background: rgba(255,255,255,.18);
    color: white;
    border-color: rgba(255,255,255,.3);
  }

  @media (max-width: 700px) {
    .hdr-clock { display: none; }
    .admin-hdr { padding: 0 16px; }
    .nav-lnk span.nav-icon ~ * { display: none; }
  }
`;

// ─── Shared auth + clock JS (injected into every protected page) ──────────────
const SHARED_AUTH_JS = `
  function getKey() {
    var k = sessionStorage.getItem('tdot_admin_key');
    if (!k) { window.location.replace('/admin'); return null; }
    return k;
  }

  // Non-redirecting read of the admin key — returns null when absent WITHOUT
  // bouncing to /admin. Use this on pages that also accept the Monday staff
  // cookie (e.g. the case cockpit): getKey()'s redirect would otherwise throw
  // a cookie-authenticated staffer off the page before the cookie-aware fetch
  // (credentials:'same-origin') ever runs.
  function peekKey() {
    return sessionStorage.getItem('tdot_admin_key') || null;
  }

  function signOut() {
    sessionStorage.removeItem('tdot_admin_key');
    window.location.replace('/admin');
  }

  function startClock() {
    function tick() {
      var el = document.getElementById('hdr-time');
      if (!el) return;
      var now = new Date();
      el.textContent =
        now.toLocaleDateString('en-GB',  { weekday: 'short', day: 'numeric', month: 'short' }) + '  ·  ' +
        now.toLocaleTimeString('en-GB',  { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    tick();
    setInterval(tick, 1000);
  }

  function checkApiStatus() {
    var key = getKey();
    if (!key) return;
    var dot = document.getElementById('sys-dot');
    var txt = document.getElementById('sys-text');
    fetch('/api/monday-test', { headers: { 'X-Api-Key': key } })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.connected) {
          dot.className = 'status-dot pulse';
          txt.textContent = 'Online';
        } else { throw new Error(); }
      })
      .catch(function() {
        if (dot) { dot.className = 'status-dot offline'; }
        if (txt) { txt.textContent = 'Monday API Offline'; }
      });
  }
`;

// ─── Careful delete UI (admin-only) ───────────────────────────────────────────
// Shared trash-icon + preview-confirm modal. Pages render a button
// `<button class="del-btn" data-del-lead="ID">` (or data-del-case="REF") in a
// row — visibility is the page's call — then call tdotBindDelete(refreshFn)
// once. The modal fetches /admin/delete/preview, lists exactly what will be
// removed, and requires re-typing the case reference (or DELETE) to enable
// the destroy button. Server enforces admin; the UI is only convenience.
const DELETE_UI_CSS = `
  .del-btn { border:none; background:transparent; padding:4px 6px; border-radius:6px; cursor:pointer; color:#94a3b8; line-height:0; }
  .del-btn:hover { background:#fee2e2; color:#dc2626; }
  .delm-overlay { position:fixed; inset:0; background:rgba(15,23,42,.5); display:flex; align-items:center; justify-content:center; z-index:1200; padding:20px; }
  .delm { background:#fff; border-radius:14px; padding:22px 24px; width:100%; max-width:520px; max-height:88vh; overflow-y:auto; box-shadow:0 20px 50px rgba(2,6,23,.4); font-size:13.5px; color:#0f172a; }
  .delm h3 { margin:0 0 4px; font-size:16px; color:#b91c1c; }
  .delm .delm-client { font-size:13px; color:#334155; margin:0 0 12px; }
  .delm ul { margin:8px 0; padding-left:20px; }
  .delm li { margin:3px 0; }
  .delm .delm-warn { background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:8px 12px; font-size:12.5px; color:#92400e; margin:10px 0; }
  .delm .delm-warn p { margin:4px 0; }
  .delm label { display:block; font-size:12px; font-weight:700; margin:14px 0 4px; }
  .delm input { width:100%; padding:8px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; font-family:inherit; box-sizing:border-box; }
  .delm-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
  .delm-btn { padding:9px 14px; border-radius:8px; border:1px solid #e2e8f0; background:#fff; color:#0f172a; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; }
  .delm-btn.danger { background:#dc2626; border-color:#dc2626; color:#fff; }
  .delm-btn.danger:disabled { opacity:.4; cursor:not-allowed; }
  .delm-err { color:#dc2626; font-size:12.5px; min-height:16px; margin-top:8px; }
  .delm-result { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:8px 12px; font-size:12.5px; color:#166534; margin-top:10px; }
  .delm-result.bad { background:#fef2f2; border-color:#fecaca; color:#991b1b; }
`;

const DELETE_UI_JS = `
  var TDOT_DEL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';

  function delEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function delHeaders(){
    var h = { 'Content-Type': 'application/json' };
    var k = sessionStorage.getItem('tdot_admin_key');
    if (k) h['X-Api-Key'] = k;
    return h;
  }

  function tdotOpenDeleteModal(target, onDone){
    var qs = target.caseRef ? ('caseRef=' + encodeURIComponent(target.caseRef)) : ('leadId=' + encodeURIComponent(target.leadId));
    var ov = document.createElement('div');
    ov.className = 'delm-overlay';
    ov.innerHTML = '<div class="delm" role="dialog" aria-modal="true"><h3>Delete record</h3><div class="delm-client">Loading preview&hellip;</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function(e){ if (e.target === ov) ov.remove(); });

    fetch('/admin/delete/preview?' + qs, { headers: delHeaders(), credentials: 'same-origin' })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function(res){
        var box = ov.querySelector('.delm');
        if (!res.ok) {
          var msg = (res.j && (res.j.message || res.j.error)) || ('HTTP ' + res.status);
          box.innerHTML = '<h3>Cannot delete</h3><div class="delm-client">' + delEsc(msg) + '</div>' +
            '<div class="delm-actions"><button class="delm-btn" type="button">Close</button></div>';
          box.querySelector('.delm-btn').onclick = function(){ ov.remove(); };
          return;
        }
        var p = res.j;
        var t = p.targets;
        var rows = [];
        if (t.clientMasterRow) rows.push('<li><b>1</b> Client Master case row (' + delEsc(p.caseRef) + ')</li>');
        if (t.checklistRows) rows.push('<li><b>' + t.checklistRows + '</b> document checklist rows</li>');
        if (t.questionnaireRows) rows.push('<li><b>' + t.questionnaireRows + '</b> questionnaire rows</li>');
        if (t.familyMemberRows) rows.push('<li><b>' + t.familyMemberRows + '</b> family member rows</li>');
        for (var i = 0; i < t.leadRows.length; i++) rows.push('<li>Lead row: ' + delEsc(t.leadRows[i]) + '</li>');
        for (var f = 0; f < t.oneDriveFolders.length; f++) rows.push('<li>OneDrive folder: ' + delEsc(t.oneDriveFolders[f]) + '</li>');
        var sq = t.squareAppointments || [];
        for (var q = 0; q < sq.length; q++) rows.push('<li>Square appointment (will be cancelled): ' + delEsc(sq[q]) + '</li>');
        if (!rows.length) rows.push('<li>Nothing found to remove.</li>');
        var warns = '';
        for (var w = 0; w < (p.warnings || []).length; w++) warns += '<p>' + delEsc(p.warnings[w]) + '</p>';

        box.innerHTML = '<h3>Delete ' + (p.kind === 'case' ? 'case ' + delEsc(p.caseRef) : 'lead') + '?</h3>' +
          '<div class="delm-client">' + delEsc(p.client.name) + (p.client.email ? ' &middot; ' + delEsc(p.client.email) : '') + '</div>' +
          '<div>This permanently removes from the live boards:</div><ul>' + rows.join('') + '</ul>' +
          (warns ? '<div class="delm-warn">' + warns + '</div>' : '') +
          '<label for="delm-confirm">Type <span style="font-family:monospace">' + delEsc(p.confirmText) + '</span> to confirm</label>' +
          '<input id="delm-confirm" type="text" autocomplete="off">' +
          '<div class="delm-err" role="alert"></div>' +
          '<div class="delm-actions"><button class="delm-btn" type="button" id="delm-cancel">Cancel</button>' +
          '<button class="delm-btn danger" type="button" id="delm-go" disabled>Delete permanently</button></div>';

        var input = box.querySelector('#delm-confirm');
        var go = box.querySelector('#delm-go');
        var err = box.querySelector('.delm-err');
        input.focus();
        input.oninput = function(){ go.disabled = (input.value.trim() !== p.confirmText); };
        box.querySelector('#delm-cancel').onclick = function(){ ov.remove(); };
        go.onclick = function(){
          go.disabled = true; go.textContent = 'Deleting\\u2026'; err.textContent = '';
          var body = { confirmText: input.value.trim(), kind: p.kind };
          if (target.caseRef) body.caseRef = target.caseRef; else body.leadId = target.leadId;
          fetch('/admin/delete/execute', { method: 'POST', headers: delHeaders(), credentials: 'same-origin', body: JSON.stringify(body) })
            .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
            .then(function(res){
              if (!res.ok) {
                err.textContent = (res.j && (res.j.message || res.j.error)) || 'Delete failed.';
                go.disabled = false; go.textContent = 'Delete permanently';
                return;
              }
              var d = res.j.deleted;
              var done = [];
              if (d.clientMasterRow) done.push(d.clientMasterRow + ' case row');
              if (d.checklistRows) done.push(d.checklistRows + ' checklist rows');
              if (d.questionnaireRows) done.push(d.questionnaireRows + ' questionnaire rows');
              if (d.familyMemberRows) done.push(d.familyMemberRows + ' family rows');
              if (d.leadRows) done.push(d.leadRows + ' lead row' + (d.leadRows > 1 ? 's' : ''));
              if (d.oneDriveFolders) done.push(d.oneDriveFolders + ' OneDrive folder' + (d.oneDriveFolders > 1 ? 's' : ''));
              // The preview promised a Square cancellation — the result must say
              // what actually happened to it, especially when the answer is
              // "nothing" (already cancelled / past / not found in Square).
              var sqNote = '';
              if (sq.length) {
                sqNote = d.squareAppointmentsCancelled
                  ? ' Square appointment' + (d.squareAppointmentsCancelled > 1 ? 's' : '') + ' cancelled: ' + d.squareAppointmentsCancelled + ' — the slot is freed.'
                  : ' Square appointment NOT cancelled (it was already cancelled, in the past, or gone from Square) \\u2014 check the Square calendar if you expected it to be freed.';
              }
              var cls = res.j.ok ? 'delm-result' : 'delm-result bad';
              var txt = res.j.ok ? ('Deleted: ' + (done.join(', ') || 'nothing found') + '. Recoverable from the Monday / OneDrive recycle bins.' + sqNote)
                                 : ('Partially deleted (' + (done.join(', ') || 'nothing') + '). FAILED: ' + res.j.failures.join(' | '));
              var wrap = document.createElement('div'); wrap.className = cls; wrap.textContent = txt;
              err.parentNode.insertBefore(wrap, err);
              go.style.display = 'none';
              var cancel = box.querySelector('#delm-cancel');
              cancel.textContent = 'Close';
              cancel.onclick = function(){ ov.remove(); if (onDone) onDone(); };
            })
            .catch(function(){
              // The server may STILL be finishing the cascade — re-enabling the
              // button here would let a second run interleave with the first.
              err.textContent = 'Network issue \\u2014 the delete may still be finishing on the server. Close this dialog, refresh the list, and only retry if the record is still there.';
              go.textContent = 'Delete permanently';
            });
        };
      })
      .catch(function(){
        var box = ov.querySelector('.delm');
        box.innerHTML = '<h3>Cannot delete</h3><div class="delm-client">Preview failed (network).</div>' +
          '<div class="delm-actions"><button class="delm-btn" type="button">Close</button></div>';
        box.querySelector('.delm-btn').onclick = function(){ ov.remove(); };
      });
  }

  function tdotBindDelete(onDone){
    document.addEventListener('click', function(e){
      var btn = e.target && e.target.closest ? e.target.closest('.del-btn') : null;
      if (!btn) return;
      e.stopPropagation(); e.preventDefault();
      var leadId = btn.getAttribute('data-del-lead');
      var caseRef = btn.getAttribute('data-del-case');
      if (!leadId && !caseRef) return;
      tdotOpenDeleteModal(caseRef ? { caseRef: caseRef } : { leadId: leadId }, onDone);
    }, true);
  }
`;

module.exports = {
  TDOT_LOGO_SVG,
  TDOT_LOGO_SVG_LARGE,
  SHARED_CSS_VARS,
  NAV_CSS,
  SHARED_AUTH_JS,
  DELETE_UI_CSS,
  DELETE_UI_JS,
  buildNavHeader,
};
