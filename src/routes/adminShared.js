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
    /* Matches the listing pages' side padding so the logo lines up with the
       first table column (staff request 2026-09-09: full-width listings). */
    padding: 0 14px;
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

// ─── Payment corrections UI (both payment panels) ────────────────────────────
// One module embedded by the cockpit Payments tab AND the consultation page's
// retainer panel, so the two can never drift: the small "who changed it, when"
// tooltip, the Mark-paid confirmation (client name, amount, the reference we
// asked for, a warning when no request was ever sent), "Undo…" for named
// admins, and "Flag as wrong" for everyone else. The server enforces every
// rule; this is presentation only.
//
// Plain template text: NO backticks, NO dollar-brace, NO backslashes — it is
// interpolated into the pages' own template literals (see inline-script trap).
const PAYMENT_UI_CSS = `
  .pay-info { position:relative; display:inline-flex; align-items:center; justify-content:center; width:15px; height:15px; border-radius:50%; background:#e2e8f0; color:#475569; font-size:10px; font-weight:800; font-style:italic; font-family:Georgia,serif; cursor:help; margin-left:6px; vertical-align:middle; flex:none; }
  .pay-info:hover, .pay-info:focus { background:#cbd5e1; outline:none; }
  .pay-info:hover::after, .pay-info:focus::after { content:attr(data-tip); position:absolute; bottom:calc(100% + 6px); left:50%; transform:translateX(-50%); background:#0f172a; color:#fff; font:500 11.5px/1.45 -apple-system,sans-serif; font-style:normal; padding:6px 9px; border-radius:6px; white-space:pre-line; width:max-content; max-width:280px; z-index:50; box-shadow:0 6px 18px rgba(2,6,23,.25); }
  .pay-fix { display:inline-flex; gap:6px; align-items:center; }
  .pay-fix .pay-signin { font-size:11px; color:#64748b; text-decoration:underline; }
  .paym-overlay { position:fixed; inset:0; background:rgba(15,23,42,.5); display:flex; align-items:center; justify-content:center; z-index:1200; padding:20px; }
  .paym { background:#fff; border-radius:14px; padding:22px 24px; width:100%; max-width:520px; max-height:88vh; overflow-y:auto; box-shadow:0 20px 50px rgba(2,6,23,.4); font-size:13.5px; color:#0f172a; }
  .paym h3 { margin:0 0 4px; font-size:16px; }
  .paym h3.danger { color:#b91c1c; }
  .paym .paym-client { font-size:13px; color:#334155; margin:0 0 12px; }
  .paym .paym-rec { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px 12px; margin:8px 0; }
  .paym .paym-amt { font-weight:700; }
  .paym .paym-muted { color:#64748b; font-size:12px; font-weight:400; }
  .paym ul { margin:6px 0; padding-left:20px; }
  .paym li { margin:3px 0; }
  .paym .paym-sec { font-size:11px; font-weight:800; letter-spacing:.04em; text-transform:uppercase; color:#475569; margin:12px 0 2px; }
  .paym .paym-warn { background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:8px 12px; font-size:12.5px; color:#92400e; margin:8px 0; }
  .paym .paym-info { background:#f1f5f9; border:1px solid #e2e8f0; border-radius:8px; padding:8px 12px; font-size:12.5px; color:#334155; margin:8px 0; }
  .paym .paym-stop { background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:10px 12px; font-size:13px; color:#991b1b; margin:8px 0; }
  .paym label { display:block; font-size:12px; font-weight:700; margin:12px 0 4px; }
  .paym input, .paym textarea { width:100%; padding:8px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; font-family:inherit; box-sizing:border-box; }
  .paym textarea { min-height:64px; resize:vertical; }
  .paym-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
  .paym-btn { padding:9px 14px; border-radius:8px; border:1px solid #e2e8f0; background:#fff; color:#0f172a; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; }
  .paym-btn.primary { background:#0f2d52; border-color:#0f2d52; color:#fff; }
  .paym-btn.danger { background:#dc2626; border-color:#dc2626; color:#fff; }
  .paym-btn:disabled { opacity:.4; cursor:not-allowed; }
  .paym-err { color:#dc2626; font-size:12.5px; min-height:16px; margin-top:8px; }
  .paym-ok { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:10px 12px; font-size:13px; color:#166534; margin-top:10px; }
`;

const PAYMENT_UI_JS = `
  var TDOT_PAY = { viewer: null, waiting: null };
  var TDOT_PAY_NL = String.fromCharCode(10);

  function payEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function payHeaders(){ var h = { 'Content-Type': 'application/json' }; var k = null; try { k = sessionStorage.getItem('tdot_admin_key'); } catch(e){} if (k) h['X-Api-Key'] = k; return h; }
  function payWhen(iso){ if (!iso) return ''; var d = new Date(iso); if (isNaN(d.getTime())) return String(iso); return d.toLocaleString('en-CA', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
  function payFirst(n){ var t = String(n||'').trim().split(' ')[0]; return t || 'this client'; }
  function payAmount(m){ return '$' + (Number(m.totalCents||0)/100).toFixed(2); }
  function payTypedName(){ try { return localStorage.getItem('tdot_staff_name') || ''; } catch(e){ return ''; } }
  function paySaveName(n){ try { if (n) localStorage.setItem('tdot_staff_name', n); } catch(e){} }

  /* Loads once per page; calls back with { signedIn, name, canUndo, adminsConfigured, signInUrl }. */
  function tdotPayViewer(cb){
    if (TDOT_PAY.viewer) { cb(TDOT_PAY.viewer); return; }
    if (TDOT_PAY.waiting) { TDOT_PAY.waiting.push(cb); return; }
    TDOT_PAY.waiting = [cb];
    fetch('/admin/payments/viewer', { headers: payHeaders(), credentials: 'same-origin' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .catch(function(){ return null; })
      .then(function(v){
        TDOT_PAY.viewer = v || { signedIn:false, name:'', canUndo:false, adminsConfigured:false, signInUrl:'/q/auth/monday' };
        var w = TDOT_PAY.waiting; TDOT_PAY.waiting = null;
        w.forEach(function(f){ try { f(TDOT_PAY.viewer); } catch(e){} });
      });
  }

  /* "Who changed it, when" for a milestone row — empty when there is nothing to say. */
  function tdotPayAuditText(m){
    var lines = [];
    if (m.status === 'paid' && m.markedBy) lines.push('Marked paid by ' + m.markedBy + (m.markedVerified ? '' : ' (name as typed)') + (m.markedAt ? ' · ' + payWhen(m.markedAt) : ''));
    if (m.undoneBy) lines.push('A payment record was removed by ' + m.undoneBy + (m.undoneAt ? ' · ' + payWhen(m.undoneAt) : ''));
    return lines.join(TDOT_PAY_NL);
  }
  function tdotPayAuditHtml(m){
    var t = tdotPayAuditText(m);
    return t ? '<span class="pay-info" tabindex="0" role="note" data-tip="' + payEsc(t) + '" aria-label="' + payEsc(t) + '">i</span>' : '';
  }

  /* The correction actions for one row, given the viewer. btnClass = the page's own button class. */
  function tdotPayRowActions(m, ctx, btnClass){
    var v = TDOT_PAY.viewer || {};
    var html = '';
    if (m.status === 'paid') {
      if (v.canUndo) html += '<button type="button" class="' + btnClass + '" data-pay-undo="' + m.index + '" title="Remove this payment record (admins only)">Undo…</button>';
      else {
        html += '<button type="button" class="' + btnClass + '" data-pay-flag="' + m.index + '" title="Alert the admins that this payment was recorded in error">Flag as wrong</button>';
        if (v.adminsConfigured && !v.signedIn) html += '<a class="pay-signin" href="' + payEsc((v.signInUrl || '/q/auth/monday') + '?returnTo=' + encodeURIComponent(location.pathname + location.search + location.hash)) + '">Admin? Sign in with Monday to undo</a>';
      }
    } else if (m.index === 0 && ctx.retainerPaid && v.canUndo) {
      html += '<button type="button" class="' + btnClass + '" data-pay-undo="0" title="The client still carries a Retainer Paid date although this row is not paid">Remove payment date…</button>';
    }
    return html ? '<span class="pay-fix">' + html + '</span>' : '';
  }

  /* Wire the buttons rendered by tdotPayRowActions inside root. ctx: { leadId, clientName, rows, reload } */
  function tdotPayBind(root, ctx){
    Array.prototype.forEach.call(root.querySelectorAll('[data-pay-undo]'), function(b){
      b.onclick = function(){ tdotOpenUndoPaymentModal({ leadId: ctx.leadId, index: Number(b.getAttribute('data-pay-undo')), onDone: ctx.reload }); };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-pay-flag]'), function(b){
      var i = Number(b.getAttribute('data-pay-flag'));
      var row = (ctx.rows || []).filter(function(r){ return r.index === i; })[0] || { index: i };
      b.onclick = function(){ tdotOpenFlagPaymentModal({ leadId: ctx.leadId, clientName: ctx.clientName, m: row, onDone: ctx.reload }); };
    });
  }

  function payOverlay(){
    /* One payment dialog at a time — a double-click must never stack two. */
    Array.prototype.forEach.call(document.querySelectorAll('.paym-overlay'), function(x){ if (x.parentNode) x.parentNode.removeChild(x); });
    var ov = document.createElement('div');
    ov.className = 'paym-overlay';
    ov.innerHTML = '<div class="paym" role="dialog" aria-modal="true"></div>';
    document.body.appendChild(ov);
    var box = ov.querySelector('.paym');
    function close(){ if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    function onKey(e){ if (e.key === 'Escape') close(); }
    ov.addEventListener('click', function(e){ if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    return { ov: ov, box: box, close: close };
  }

  /* Mark paid, with the facts that would have stopped the 2026-09-22 mistake in front of the person. */
  function tdotOpenMarkPaidModal(o){
    var m = o.m, v = TDOT_PAY.viewer || {};
    var d = payOverlay();
    var never = !(m.status === 'requested' || m.legacySent);
    var expected = (m.status === 'requested' && m.reference) ? m.reference : '';
    d.box.innerHTML =
      '<h3>Record a payment</h3>' +
      '<div class="paym-client">For <b>' + payEsc(o.clientName || 'this client') + '</b>' + (o.caseRef ? ' · ' + payEsc(o.caseRef) : '') + '</div>' +
      '<div class="paym-rec"><div>' + payEsc(m.label || ('Milestone ' + (m.index + 1))) + '</div>' +
        '<div class="paym-amt">' + payAmount(m) + ' <span class="paym-muted">scheduled amount, incl. HST</span></div>' +
        (expected ? '<div class="paym-muted">The client was asked to put <b>' + payEsc(expected) + '</b> in the e-transfer message.</div>' : '') +
      '</div>' +
      (never ? '<div class="paym-warn">No payment request was ever sent for this milestone. Before recording it, check the e-transfer really came from <b>' + payEsc(o.clientName || 'this client') + '</b>.</div>' : '') +
      '<label>Reference from the bank notification <span class="paym-muted">(optional)</span></label>' +
      '<input class="paym-ref" type="text" maxlength="120" autocomplete="off">' +
      (v.signedIn
        ? '<div class="paym-muted" style="margin-top:10px">Recorded as <b>' + payEsc(v.name) + '</b> (signed in with Monday).</div>'
        : '<label>Your name</label><input class="paym-by" type="text" maxlength="60" value="' + payEsc(payTypedName()) + '">') +
      '<div class="paym-err"></div>' +
      '<div class="paym-actions"><button type="button" class="paym-btn" data-x>Cancel</button>' +
      '<button type="button" class="paym-btn primary" data-go>Record payment for ' + payEsc(payFirst(o.clientName)) + '</button></div>';
    d.box.querySelector('[data-x]').onclick = d.close;
    d.box.querySelector('[data-go]').onclick = function(){
      var ref = d.box.querySelector('.paym-ref').value.trim();
      var byEl = d.box.querySelector('.paym-by');
      var by = byEl ? byEl.value.trim() : (v.name || '');
      if (!by) { d.box.querySelector('.paym-err').textContent = 'Enter your name — it is recorded with the payment.'; return; }
      if (byEl) paySaveName(by);
      d.close();
      o.onConfirm(ref, by);
    };
    setTimeout(function(){ var el = d.box.querySelector('.paym-ref'); if (el) el.focus(); }, 30);
  }

  function payList(title, items, cls){
    if (!items || !items.length) return '';
    return (title ? '<div class="paym-sec">' + payEsc(title) + '</div>' : '') +
      items.map(function(x){ return '<div class="' + cls + '">' + payEsc(x.message || x) + '</div>'; }).join('');
  }

  /* Undo mark paid — preview first; reason + typed confirmation; the server re-checks everything. */
  function tdotOpenUndoPaymentModal(o){
    var d = payOverlay();
    d.box.innerHTML = '<h3 class="danger">Remove payment record</h3><div class="paym-client">Loading…</div>';
    fetch('/admin/retainer/' + encodeURIComponent(o.leadId) + '/milestone/' + encodeURIComponent(o.index) + '/undo-preview', { headers: payHeaders(), credentials: 'same-origin' })
      .then(function(r){ return r.json().then(function(j){ return { status: r.status, j: j }; }); })
      .then(function(res){
        if (res.status === 401) { d.box.innerHTML = '<h3 class="danger">Remove payment record</h3><div class="paym-stop">' + payEsc(res.j.error || 'Sign in with Monday first.') + '</div><div class="paym-actions"><a class="paym-btn primary" href="' + payEsc('/q/auth/monday?returnTo=' + encodeURIComponent(location.pathname + location.search)) + '">Sign in with Monday</a><button type="button" class="paym-btn" data-x>Close</button></div>'; d.box.querySelector('[data-x]').onclick = d.close; return; }
        if (res.status !== 200 || !res.j.ok) { d.box.innerHTML = '<h3 class="danger">Remove payment record</h3><div class="paym-stop">' + payEsc((res.j && res.j.error) || 'Could not load the preview.') + '</div><div class="paym-actions"><button type="button" class="paym-btn" data-x>Close</button></div>'; d.box.querySelector('[data-x]').onclick = d.close; return; }
        renderUndo(d, o, res.j);
      })
      .catch(function(e){ d.box.innerHTML = '<h3 class="danger">Remove payment record</h3><div class="paym-stop">Could not load the preview: ' + payEsc(e.message) + '</div><div class="paym-actions"><button type="button" class="paym-btn" data-x>Close</button></div>'; d.box.querySelector('[data-x]').onclick = d.close; });
  }

  function renderUndo(d, o, pv){
    var p = pv.plan, c = pv.client || {};
    var head = '<h3 class="danger">Remove payment record</h3>' +
      '<div class="paym-client"><b>' + payEsc(c.name) + '</b> · lead ' + payEsc(c.leadId) + (c.caseRef ? ' · case ' + payEsc(c.caseRef) : '') + '</div>';
    if (!p.ok) {
      d.box.innerHTML = head + '<div class="paym-stop">' + payEsc(p.refusal.message) + '</div>' +
        (p.refusal.detail && p.refusal.detail.signals && p.refusal.detail.signals.length ? '<div class="paym-muted">' + payEsc(p.refusal.detail.signals.join(' · ')) + '</div>' : '') +
        '<div class="paym-actions"><button type="button" class="paym-btn" data-x>Close</button></div>';
      d.box.querySelector('[data-x]').onclick = d.close;
      return;
    }
    var b = p.before || {};
    var rec = p.mode === 'milestone'
      ? '<div>' + payEsc(p.label) + '</div><div class="paym-amt">' + payEsc('$' + (Number(p.totalCents||0)/100).toFixed(2)) + ' <span class="paym-muted">scheduled amount</span></div>' +
        '<div class="paym-muted">Recorded as paid ' + payEsc(b.paidAt || '') + (b.method ? ' by ' + payEsc(b.method) : '') + (b.reference ? ' · ref ' + payEsc(b.reference) : '') + (b.marked && b.marked.by ? ' · by ' + payEsc(b.marked.by) : '') + '</div>'
      : '<div>' + payEsc(p.label) + '</div><div class="paym-muted">Retainer Paid date on the client: ' + payEsc(p.expect.retainerPaid) + '</div>';
    d.box.innerHTML = head +
      '<div class="paym-rec">' + rec + '</div>' +
      payList('', p.warnings, 'paym-warn') + payList('', p.info, 'paym-info') +
      '<div class="paym-sec">Will change</div><ul>' + p.willChange.map(function(x){ return '<li>' + payEsc(x) + '</li>'; }).join('') + '</ul>' +
      '<div class="paym-sec">Will not change</div><ul>' + p.willNotChange.map(function(x){ return '<li>' + payEsc(x) + '</li>'; }).join('') + '</ul>' +
      '<label>Reason <span class="paym-muted">(goes on the record)</span></label><textarea class="paym-why" maxlength="1000" placeholder="e.g. This e-transfer was from a different client"></textarea>' +
      '<label>Type <b>' + payEsc(p.confirmText) + '</b> to confirm</label><input class="paym-confirm" type="text" autocomplete="off">' +
      '<div class="paym-err"></div>' +
      '<div class="paym-actions"><button type="button" class="paym-btn" data-x>Cancel</button><button type="button" class="paym-btn danger" data-go disabled>Remove payment record</button></div>';
    var why = d.box.querySelector('.paym-why'), conf = d.box.querySelector('.paym-confirm'), go = d.box.querySelector('[data-go]'), err = d.box.querySelector('.paym-err');
    function check(){ go.disabled = !(why.value.trim().length >= 10 && conf.value.trim() === p.confirmText); }
    why.oninput = check; conf.oninput = check;
    d.box.querySelector('[data-x]').onclick = d.close;
    go.onclick = function(){
      go.disabled = true; err.textContent = 'Removing…';
      fetch('/admin/retainer/' + encodeURIComponent(o.leadId) + '/milestone/' + encodeURIComponent(o.index) + '/undo', {
        method: 'POST', headers: payHeaders(), credentials: 'same-origin',
        body: JSON.stringify({ confirmText: conf.value.trim(), reason: why.value.trim(), expect: p.expect })
      })
      .then(function(r){ return r.json().then(function(j){ return { status: r.status, j: j }; }); })
      .then(function(res){
        if (res.status === 200 && res.j.ok) {
          var removed = res.j.removed && res.j.removed.reference ? '<div class="paym-muted">Removed reference: <b>' + payEsc(res.j.removed.reference) + '</b>' + (res.j.removed.paidAt ? ' (' + payEsc(res.j.removed.paidAt) + ')' : '') + '</div>' : '';
          d.box.innerHTML = head + '<div class="paym-ok">' + payEsc(res.j.message || 'Removed.') + '</div>' + removed +
            payList('', res.j.warnings, 'paym-warn') +
            ((res.j.next || []).length ? '<div class="paym-sec">Next</div><ul>' + res.j.next.map(function(x){ return '<li>' + payEsc(x) + '</li>'; }).join('') + '</ul>' : '') +
            '<div class="paym-actions"><button type="button" class="paym-btn primary" data-x>Done</button></div>';
          d.box.querySelector('[data-x]').onclick = function(){ d.close(); if (o.onDone) o.onDone(); };
          return;
        }
        err.textContent = (res.j && res.j.error) || ('Failed (HTTP ' + res.status + ').');
        if (res.j && (res.j.code === 'CHANGED_SINCE_PREVIEW' || res.j.code === 'ONBOARDING_STARTED_DURING_UNDO' || res.j.code === 'UNDO_INCOMPLETE')) { go.disabled = true; }
        else { check(); }
      })
      .catch(function(){ err.textContent = 'The connection dropped — reload the page and check the row before trying again.'; go.disabled = true; });
    };
    setTimeout(function(){ why.focus(); }, 30);
  }

  /* For staff who can't undo: flag it — changes nothing, alerts the admins and the RCIC. */
  function tdotOpenFlagPaymentModal(o){
    var m = o.m || {}, v = TDOT_PAY.viewer || {};
    var d = payOverlay();
    d.box.innerHTML =
      '<h3>Flag payment as wrong</h3>' +
      '<div class="paym-client"><b>' + payEsc(o.clientName || 'This client') + '</b>' + (m.label ? ' · ' + payEsc(m.label) : '') + '</div>' +
      '<div class="paym-info">Nothing changes on the payment. The admins are alerted to check it and remove it if it’s wrong' + (m.index === 0 ? ', and the RCIC is asked not to countersign until they have' : '') + '.</div>' +
      '<label>What’s wrong?</label><textarea class="paym-why" maxlength="600" placeholder="e.g. This e-transfer was from a different client"></textarea>' +
      (v.signedIn ? '' : '<label>Your name</label><input class="paym-by" type="text" maxlength="60" value="' + payEsc(payTypedName()) + '">') +
      '<div class="paym-err"></div>' +
      '<div class="paym-actions"><button type="button" class="paym-btn" data-x>Cancel</button><button type="button" class="paym-btn primary" data-go>Alert the admins</button></div>';
    d.box.querySelector('[data-x]').onclick = d.close;
    var go = d.box.querySelector('[data-go]'), err = d.box.querySelector('.paym-err');
    go.onclick = function(){
      var note = d.box.querySelector('.paym-why').value.trim();
      var byEl = d.box.querySelector('.paym-by');
      var by = byEl ? byEl.value.trim() : (v.name || '');
      if (note.length < 10) { err.textContent = 'Say briefly what’s wrong (at least 10 characters).'; return; }
      if (!by) { err.textContent = 'Enter your name so the admins know who flagged it.'; return; }
      if (byEl) paySaveName(by);
      go.disabled = true; err.textContent = 'Sending…';
      fetch('/admin/retainer/' + encodeURIComponent(o.leadId) + '/milestone/' + encodeURIComponent(m.index) + '/flag-error', {
        method: 'POST', headers: payHeaders(), credentials: 'same-origin', body: JSON.stringify({ note: note, staffName: by })
      })
      .then(function(r){ return r.json().then(function(j){ return { status: r.status, j: j }; }); })
      .then(function(res){
        if (res.status === 200 && res.j.ok) {
          d.box.innerHTML = '<h3>Flag payment as wrong</h3><div class="paym-ok">' + payEsc(res.j.message || 'Flagged.') + '</div><div class="paym-actions"><button type="button" class="paym-btn primary" data-x>Done</button></div>';
          d.box.querySelector('[data-x]').onclick = function(){ d.close(); if (o.onDone) o.onDone(); };
          return;
        }
        go.disabled = false; err.textContent = (res.j && res.j.error) || ('Failed (HTTP ' + res.status + ').');
      })
      .catch(function(e){ go.disabled = false; err.textContent = 'Failed: ' + e.message; });
    };
  }
`;

module.exports = {
  PAYMENT_UI_CSS, PAYMENT_UI_JS,
  TDOT_LOGO_SVG,
  TDOT_LOGO_SVG_LARGE,
  SHARED_CSS_VARS,
  NAV_CSS,
  SHARED_AUTH_JS,
  DELETE_UI_CSS,
  DELETE_UI_JS,
  buildNavHeader,
};
