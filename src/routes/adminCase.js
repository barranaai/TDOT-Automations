/**
 * Staff Case Cockpit
 * Served at GET /admin/case/:caseRef
 *
 * One screen per case so staff run a file without opening Monday. The page is
 * static HTML (like the dashboard); all data comes from GET /api/case/:caseRef
 * (behind ADMIN_API_KEY, key carried in sessionStorage). Tabbed shell built
 * out one tab at a time — Overview is live; Documents/Questionnaire route to
 * the existing staff review pages; Payments/Meetings/Timeline are placeholders.
 */

const express = require('express');
const router  = express.Router();
const { SHARED_CSS_VARS, NAV_CSS, buildNavHeader, SHARED_AUTH_JS } = require('./adminShared');

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildCockpitHTML(caseRef) {
  const safeRef = escAttr(caseRef);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TDOT — Case ${safeRef}</title>
  <style>
    ${SHARED_CSS_VARS}
    ${NAV_CSS}

    body { background: #f1f5f9; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 26px 24px 80px; }

    #loading { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:55vh; gap:18px; }
    .spinner { width:44px; height:44px; border:3px solid #e2e8f0; border-top-color:var(--navy); border-radius:50%; animation:spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { color:var(--muted); font-size:13px; font-weight:600; }
    #error-msg { display:none; background:#fff1f2; border:1px solid #fda4af; color:#dc2626; padding:16px 20px; border-radius:12px; margin:32px auto; max-width:560px; text-align:center; font-size:14px; }
    #content { display:none; animation: fadeUp .4s ease both; }
    @keyframes fadeUp { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:translateY(0); } }

    .back-lnk { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--muted); text-decoration:none; margin-bottom:16px; }
    .back-lnk:hover { color:var(--navy); }

    /* Case header card */
    .case-hd { background:white; border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; padding:22px 24px; margin-bottom:18px; }
    .case-hd-top { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
    .case-name { font-size:23px; font-weight:800; color:var(--navy); letter-spacing:-.5px; margin:0; }
    .case-sub { font-size:12px; color:var(--light); margin-top:3px; font-weight:600; }
    .case-actions { display:flex; gap:8px; flex-wrap:wrap; }
    .act-btn { display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border-radius:8px; font-size:12px; font-weight:700; text-decoration:none; border:1px solid var(--border); color:var(--navy); background:white; transition:all .15s; }
    .act-btn:hover { border-color:var(--navy); background:#f0f4f8; }
    .act-btn.primary { background:var(--navy); color:white; border-color:var(--navy); }
    .act-btn.primary:hover { background:var(--navy-light); }

    .pill-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:16px; }
    .pill { display:inline-flex; align-items:center; gap:5px; padding:5px 12px; border-radius:20px; font-size:11px; font-weight:700; letter-spacing:.2px; }
    .pill.grey { background:#f1f5f9; color:#475569; }
    .pill.green { background:#f0fdf4; color:#16a34a; }
    .pill.red { background:#fef2f2; color:#dc2626; }
    .pill.amber { background:#fffbeb; color:#d97706; }
    .pill.blue { background:#eff6ff; color:#2563eb; }
    .pill .pk { font-weight:600; opacity:.7; }

    /* Tabs */
    .tabbar { display:flex; gap:2px; border-bottom:1px solid var(--border); margin-bottom:22px; overflow-x:auto; }
    .tab { padding:11px 18px; font-size:13px; font-weight:700; color:var(--muted); background:none; border:none; border-bottom:2px solid transparent; cursor:pointer; font-family:inherit; white-space:nowrap; display:flex; align-items:center; gap:7px; }
    .tab:hover { color:var(--navy); }
    .tab.active { color:var(--navy); border-bottom-color:var(--navy); }
    .tab .soon { font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:.5px; color:#94a3b8; background:#f1f5f9; padding:2px 6px; border-radius:10px; }
    .tab-panel { display:none; }
    .tab-panel.active { display:block; animation: fadeUp .3s ease both; }

    /* Generic section card */
    .grid { display:grid; gap:16px; }
    .grid-2 { grid-template-columns: 1fr 1fr; }
    .grid-3 { grid-template-columns: repeat(3, 1fr); }
    .card { background:white; border-radius:var(--r); box-shadow:var(--shadow-sm); border:1px solid #eef2f7; padding:18px 20px; }
    .card-title { font-size:13px; font-weight:800; color:var(--navy); margin-bottom:14px; display:flex; align-items:center; gap:8px; padding-bottom:11px; border-bottom:1px solid #f1f5f9; }
    .card-title .cnt { margin-left:auto; font-size:11px; font-weight:700; color:var(--light); }

    /* Readiness meters */
    .meter { display:flex; align-items:center; gap:12px; }
    .meter-num { font-size:30px; font-weight:800; letter-spacing:-1.5px; min-width:74px; }
    .meter-bar { flex:1; height:8px; background:#f1f5f9; border-radius:4px; overflow:hidden; }
    .meter-fill { height:100%; border-radius:4px; transition:width .8s cubic-bezier(.4,0,.2,1); }

    /* Member rows */
    .mrow { display:flex; align-items:center; gap:10px; padding:9px 0; border-top:1px solid #f6f8fb; font-size:13px; }
    .mrow:first-child { border-top:none; }
    .mrow .mname { font-weight:600; color:var(--navy); }
    .mrow .mtype { font-size:11px; color:var(--light); margin-left:auto; }
    .mrow .mflag { font-size:10px; font-weight:700; color:#d97706; background:#fffbeb; padding:2px 7px; border-radius:10px; }
    .status-tag { font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.4px; padding:3px 9px; border-radius:12px; }
    .status-tag.done { background:#f0fdf4; color:#16a34a; }
    .status-tag.prog { background:#eff6ff; color:#2563eb; }
    .status-tag.none { background:#f1f5f9; color:#94a3b8; }

    /* Doc counts strip */
    .doc-strip { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:6px; }
    .doc-stat { text-align:center; background:#f8fafc; border-radius:8px; padding:12px 6px; }
    .doc-stat .n { font-size:22px; font-weight:800; letter-spacing:-1px; }
    .doc-stat .l { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; color:#94a3b8; margin-top:2px; }
    .cat-block { margin-top:14px; }
    .cat-head { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.6px; color:#64748b; margin-bottom:6px; }
    .doc-line { display:flex; align-items:center; gap:8px; padding:6px 0; font-size:12px; border-top:1px solid #f6f8fb; }
    .doc-line:first-child { border-top:none; }
    .doc-line .dn { color:var(--navy); }
    .doc-line .dt { font-size:10px; color:var(--light); margin-left:auto; white-space:nowrap; }
    .dotc { width:8px; height:8px; border-radius:50%; flex-shrink:0; }

    .placeholder { text-align:center; padding:48px 20px; color:var(--muted); }
    .placeholder .pic { font-size:34px; margin-bottom:12px; }
    .placeholder h3 { font-size:16px; color:var(--navy); margin-bottom:6px; }
    .placeholder p { font-size:13px; max-width:420px; margin:0 auto 14px; }
    .muted { color:var(--light); font-size:12px; }

    /* Tab-panel building blocks (Documents / Payments / Meetings / Timeline) */
    .sbtn { display:inline-flex; align-items:center; gap:5px; padding:5px 11px; border-radius:7px; font-size:11.5px; font-weight:700; border:1px solid var(--border); color:var(--navy); background:white; cursor:pointer; font-family:inherit; transition:all .12s; text-decoration:none; }
    .sbtn:hover:not(:disabled) { border-color:var(--navy); background:#f0f4f8; }
    .sbtn:disabled { opacity:.5; cursor:not-allowed; }
    .sbtn.primary { background:var(--navy); color:white; border-color:var(--navy); }
    .sbtn.danger:hover:not(:disabled) { border-color:#dc2626; color:#dc2626; background:#fef2f2; }
    .tab-actions { display:flex; gap:8px; flex-wrap:wrap; }
    .act-msg { display:none; padding:9px 12px; border-radius:8px; font-size:12.5px; margin-top:12px; font-weight:600; }
    .act-msg.info { background:#eff6ff; color:#2563eb; display:block; }
    .act-msg.ok { background:#f0fdf4; color:#16a34a; display:block; }
    .act-msg.err { background:#fef2f2; color:#dc2626; display:block; }

    .drow { display:flex; align-items:center; gap:9px; padding:9px 0; border-top:1px solid #f6f8fb; font-size:12.5px; flex-wrap:wrap; }
    .drow:first-child { border-top:none; }
    .drow .dn { color:var(--navy); font-weight:600; }
    .drow .dmeta { font-size:11px; color:var(--light); }
    .drow .dacts { margin-left:auto; display:flex; gap:6px; }
    .dnote { flex-basis:100%; font-size:11.5px; color:#b45309; background:#fffbeb; border-radius:7px; padding:6px 10px; margin:2px 0 2px 17px; }

    .pay-strip { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
    .ms-row { display:flex; align-items:center; gap:10px; padding:11px 0; border-top:1px solid #f6f8fb; font-size:13px; flex-wrap:wrap; }
    .ms-row:first-child { border-top:none; }
    .ms-row .ms-label { font-weight:600; color:var(--navy); }
    .ms-row .ms-amt { font-weight:800; color:var(--navy); font-variant-numeric:tabular-nums; }
    .ms-row .ms-meta { font-size:11px; color:var(--light); }
    .ms-row .ms-acts { margin-left:auto; display:flex; gap:6px; }

    .kvline { display:flex; gap:10px; padding:8px 0; border-top:1px solid #f6f8fb; font-size:13px; align-items:center; flex-wrap:wrap; }
    .kvline:first-child { border-top:none; }
    .kvline .k { color:var(--muted); min-width:170px; }
    .kvline .v { color:var(--navy); font-weight:600; }

    .tl { position:relative; padding-left:24px; }
    .tl::before { content:""; position:absolute; left:7px; top:6px; bottom:6px; width:2px; background:#e8edf4; border-radius:1px; }
    .tl-ev { position:relative; padding:0 0 16px 8px; }
    .tl-ev:last-child { padding-bottom:2px; }
    .tl-dot { position:absolute; left:-24px; top:3px; width:12px; height:12px; border-radius:50%; border:2.5px solid white; box-shadow:0 0 0 1.5px #e2e8f0; }
    .tl-date { font-size:10.5px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:.4px; }
    .tl-title { font-size:13px; font-weight:700; color:var(--navy); margin-top:1px; }
    .tl-detail { font-size:12px; color:var(--muted); margin-top:1px; }

    @media (max-width: 820px) {
      .grid-2, .grid-3 { grid-template-columns:1fr; }
      .doc-strip { grid-template-columns:repeat(3,1fr); }
    }
  </style>
</head>
<body>

${buildNavHeader('dashboard')}

<main class="wrap">
  <a href="/admin/dashboard" class="back-lnk">← Back to dashboard</a>

  <div id="loading">
    <div class="spinner"></div>
    <div class="loading-text">Loading case ${safeRef}…</div>
  </div>

  <div id="error-msg"></div>

  <div id="content">
    <!-- Case header -->
    <div class="case-hd">
      <div class="case-hd-top">
        <div>
          <h1 class="case-name" id="c-name">—</h1>
          <div class="case-sub" id="c-sub">—</div>
        </div>
        <div class="case-actions" id="c-actions"></div>
      </div>
      <div class="pill-row" id="c-pills"></div>
    </div>

    <!-- Tabs -->
    <div class="tabbar" id="tabbar">
      <button class="tab active" data-tab="overview">Overview</button>
      <button class="tab" data-tab="documents">Documents</button>
      <button class="tab" data-tab="questionnaire">Questionnaire</button>
      <button class="tab" data-tab="payments">Payments</button>
      <button class="tab" data-tab="meetings">Meetings</button>
      <button class="tab" data-tab="timeline">Timeline</button>
    </div>

    <!-- Overview -->
    <div class="tab-panel active" id="panel-overview">
      <div class="grid grid-2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-title">📝 Questionnaire readiness</div>
          <div class="meter">
            <div class="meter-num" id="q-pct">—</div>
            <div class="meter-bar"><div class="meter-fill" id="q-bar" style="width:0%"></div></div>
          </div>
          <div class="muted" id="q-sub" style="margin-top:10px"></div>
        </div>
        <div class="card">
          <div class="card-title">📂 Document readiness</div>
          <div class="meter">
            <div class="meter-num" id="d-pct">—</div>
            <div class="meter-bar"><div class="meter-fill" id="d-bar" style="width:0%"></div></div>
          </div>
          <div class="muted" id="d-sub" style="margin-top:10px"></div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-title">👪 Family on this case <span class="cnt" id="fam-cnt"></span></div>
          <div id="fam-list"></div>
        </div>
        <div class="card">
          <div class="card-title">🧾 Questionnaire members <span class="cnt" id="qm-cnt"></span></div>
          <div id="qm-list"></div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">📑 Documents <span class="cnt" id="doc-total"></span></div>
        <div class="doc-strip" id="doc-strip"></div>
        <div id="doc-cats"></div>
      </div>
    </div>

    <!-- Documents tab — inline review actions -->
    <div class="tab-panel" id="panel-documents">
      <div class="card">
        <div class="card-title">📂 Document review
          <span class="cnt"><a class="act-btn" id="doc-review-lnk" target="_blank" rel="noopener" style="font-size:11px;padding:5px 10px">Full review page (uploads &amp; replies) →</a></span>
        </div>
        <div class="muted" style="margin-bottom:10px">Mark a received document reviewed, or send it back with a note — the client is notified automatically.</div>
        <div id="docs-actionable"></div>
        <div id="doc-act-msg" class="act-msg"></div>
      </div>
    </div>

    <!-- Questionnaire tab — member sections + links -->
    <div class="tab-panel" id="panel-questionnaire">
      <div class="card">
        <div class="card-title">📝 Questionnaire
          <span class="cnt" id="qt-cnt"></span>
        </div>
        <div class="tab-actions" id="q-actions"></div>
        <div id="qt-list" style="margin-top:12px"></div>
        <div id="qt-embed" style="margin-top:14px"></div>
      </div>
    </div>

    <!-- Payments tab — retainer + milestone e-Transfers -->
    <div class="tab-panel" id="panel-payments">
      <div class="card">
        <div class="card-title">💳 Retainer &amp; milestone payments <span class="cnt" id="pay-cnt"></span></div>
        <div id="pay-body"></div>
        <div id="pay-act-msg" class="act-msg"></div>
      </div>
    </div>

    <!-- Meetings tab — consultation artifacts from the linked lead -->
    <div class="tab-panel" id="panel-meetings">
      <div class="card">
        <div class="card-title">🎥 Consultation meeting</div>
        <div id="meet-body"></div>
      </div>
    </div>

    <!-- Timeline tab — derived from recorded timestamps -->
    <div class="tab-panel" id="panel-timeline">
      <div class="card">
        <div class="card-title">🕓 Case timeline <span class="cnt" id="tl-cnt"></span></div>
        <div class="muted" style="margin-bottom:12px">Built from the dates the system records — inquiry, invite, consultation, retainer, payments, submissions and document uploads.</div>
        <div id="tl-list"></div>
      </div>
    </div>

  </div><!-- /content -->
</main>

<script>
var CASE_REF = ${JSON.stringify(caseRef).replace(/</g, '\\u003c')};

${SHARED_AUTH_JS}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function pctColor(p) { return p >= 80 ? '#16a34a' : (p >= 50 ? '#d97706' : '#dc2626'); }

var ROLE_LABEL = {
  PrincipalApplicant: 'Principal applicant', Spouse: 'Spouse', DependentChild: 'Dependent child',
  Sponsor: 'Sponsor', WorkerSpouse: 'Worker spouse', Parent: 'Parent', Sibling: 'Sibling'
};

function statusTag(s) {
  if (s === 'Submitted') return '<span class="status-tag done">Submitted</span>';
  if (s === 'In Progress') return '<span class="status-tag prog">In progress</span>';
  return '<span class="status-tag none">Not started</span>';
}

var DOC_DOT = { Reviewed:'#16a34a', Received:'#2563eb', 'Rework Required':'#dc2626', Missing:'#cbd5e1' };

function render(d) {
  document.getElementById('c-name').textContent = d.clientName || d.caseRef;
  document.getElementById('c-sub').textContent =
    d.caseRef + '  ·  ' + (d.caseType || '—') + (d.caseSubType ? ('  ·  ' + d.caseSubType) : '');

  // Action buttons
  var acts = '';
  if (d.portalLink) acts += '<a class="act-btn" href="' + escHtml(d.portalLink) + '" target="_blank" rel="noopener">🏠 Client portal</a>';
  if (d.folderLink) acts += '<a class="act-btn" href="' + escHtml(d.folderLink) + '" target="_blank" rel="noopener">📁 OneDrive</a>';
  if (d.clientEmail) acts += '<a class="act-btn" href="mailto:' + escHtml(d.clientEmail) + '">✉ Email client</a>';
  document.getElementById('c-actions').innerHTML = acts;

  // Pills
  var payCls = d.paymentStatus === 'Paid' ? 'green' : (/unpaid/i.test(d.paymentStatus) ? 'red' : 'amber');
  var healthCls = d.health === 'Red' ? 'red' : (d.health === 'Orange' ? 'amber' : (d.health === 'Green' ? 'green' : 'grey'));
  var pills = '';
  pills += '<span class="pill blue"><span class="pk">Stage</span> ' + escHtml(d.caseStage) + '</span>';
  pills += '<span class="pill ' + payCls + '"><span class="pk">Payment</span> ' + escHtml(d.paymentStatus) + '</span>';
  pills += '<span class="pill ' + healthCls + '"><span class="pk">Health</span> ' + escHtml(d.health) + '</span>';
  pills += '<span class="pill grey"><span class="pk">Manager</span> ' + escHtml(d.manager) + '</span>';
  if (d.deadline) pills += '<span class="pill amber"><span class="pk">Deadline</span> ' + escHtml(d.deadline) + '</span>';
  document.getElementById('c-pills').innerHTML = pills;

  // Readiness meters
  var q = d.qReadinessPct || 0, dd = d.docReadinessPct || 0;
  var qp = document.getElementById('q-pct'); qp.textContent = q + '%'; qp.style.color = pctColor(q);
  var dp = document.getElementById('d-pct'); dp.textContent = dd + '%'; dp.style.color = pctColor(dd);
  var qb = document.getElementById('q-bar'); qb.style.width = q + '%'; qb.style.background = pctColor(q);
  var db = document.getElementById('d-bar'); db.style.width = dd + '%'; db.style.background = pctColor(dd);
  document.getElementById('q-sub').textContent =
    (d.questionnaire.submitted || 0) + ' of ' + (d.questionnaire.total || 0) + ' member section(s) submitted';
  document.getElementById('d-sub').textContent =
    (d.documents.counts.received + d.documents.counts.reviewed) + ' of ' + d.documents.counts.total + ' document(s) in';

  // Family
  var fam = d.family || [];
  document.getElementById('fam-cnt').textContent = fam.length + ' member' + (fam.length !== 1 ? 's' : '');
  var famHtml = fam.length ? fam.map(function(m) {
    var flags = (m.flags || []).map(function(f) { return '<span class="mflag">' + escHtml(f) + '</span>'; }).join(' ');
    return '<div class="mrow"><span class="mname">' + escHtml(m.name || (ROLE_LABEL[m.role] || m.role)) + '</span> ' +
      flags + '<span class="mtype">' + escHtml(ROLE_LABEL[m.role] || m.role) + '</span></div>';
  }).join('') : '<div class="muted">No family members recorded on the board.</div>';
  document.getElementById('fam-list').innerHTML = famHtml;

  // Questionnaire members
  var qm = d.questionnaire.members || [];
  document.getElementById('qm-cnt').textContent = qm.length + ' section' + (qm.length !== 1 ? 's' : '');
  document.getElementById('qm-list').innerHTML = qm.length ? qm.map(function(m) {
    return '<div class="mrow"><span class="mname">' + escHtml(m.label || m.key) + '</span>' +
      '<span class="mtype" style="margin-right:8px">' + escHtml(m.type || '') + '</span>' + statusTag(m.status) + '</div>';
  }).join('') : '<div class="muted">Primary applicant only.</div>';

  // Documents
  var c = d.documents.counts;
  document.getElementById('doc-total').textContent = c.total + ' total';
  document.getElementById('doc-strip').innerHTML =
    [['Missing', c.missing, '#94a3b8'], ['Received', c.received, '#2563eb'], ['Reviewed', c.reviewed, '#16a34a'],
     ['Rework', c.rework, '#dc2626'], ['Total', c.total, '#1a3558']]
    .map(function(s) { return '<div class="doc-stat"><div class="n" style="color:' + s[2] + '">' + s[1] + '</div><div class="l">' + s[0] + '</div></div>'; }).join('');

  var cats = d.documents.byCategory || [];
  document.getElementById('doc-cats').innerHTML = cats.length ? cats.map(function(cat) {
    var lines = cat.items.map(function(it) {
      return '<div class="doc-line"><span class="dotc" style="background:' + (DOC_DOT[it.status] || '#cbd5e1') + '"></span>' +
        '<span class="dn">' + escHtml(it.name) + '</span><span class="dt">' + escHtml(it.applicantType) + ' · ' + escHtml(it.status) + '</span></div>';
    }).join('');
    return '<div class="cat-block"><div class="cat-head">' + escHtml(cat.category) + '</div>' + lines + '</div>';
  }).join('') : '<div class="muted" style="margin-top:10px">No checklist rows seeded yet.</div>';

  // Review-page link + the tab panels
  document.getElementById('doc-review-lnk').href = '/d/' + encodeURIComponent(CASE_REF) + '/review';
  LAST_D = d;
  renderDocsTab(d);
  renderQTab(d);
  renderPaymentsTab(d);
  renderMeetingsTab(d);
  renderTimelineTab(d);
}

var LAST_D = null;
function actMsg(id, cls, txt) { var el = document.getElementById(id); if (!el) return; el.className = 'act-msg ' + cls; el.textContent = txt; }

// ── Documents tab: full checklist with inline review actions ────────────────
function renderDocsTab(d) {
  var cats = d.documents.byCategory || [];
  var html = cats.map(function(cat) {
    var lines = cat.items.map(function(it) {
      var acts = '';
      if (it.id && it.status === 'Received') acts += '<button class="sbtn" data-doc-act="reviewed" data-doc-id="' + escHtml(it.id) + '">✓ Mark reviewed</button>';
      if (it.id && (it.status === 'Received' || it.status === 'Reviewed')) acts += '<button class="sbtn danger" data-doc-act="rework" data-doc-id="' + escHtml(it.id) + '" data-doc-name="' + escHtml(it.name) + '">⟲ Request rework</button>';
      var note = (it.status === 'Rework Required' && it.reviewNotes) ? '<div class="dnote">Rework note: ' + escHtml(it.reviewNotes) + '</div>' : '';
      return '<div class="drow"><span class="dotc" style="background:' + (DOC_DOT[it.status] || '#cbd5e1') + '"></span>' +
        '<span class="dn">' + escHtml(it.name) + '</span>' +
        '<span class="dmeta">' + escHtml(it.applicantType) + ' · ' + escHtml(it.status) + (it.lastUpload ? (' · uploaded ' + escHtml(it.lastUpload)) : '') + '</span>' +
        '<span class="dacts">' + acts + '</span>' + note + '</div>';
    }).join('');
    return '<div class="cat-block"><div class="cat-head">' + escHtml(cat.category) + '</div>' + lines + '</div>';
  }).join('');
  document.getElementById('docs-actionable').innerHTML = html || '<div class="muted">No checklist rows seeded yet — they appear when Document Collection starts.</div>';
  Array.prototype.forEach.call(document.querySelectorAll('#docs-actionable [data-doc-act]'), function(btn) {
    btn.onclick = function() { docAction(btn); };
  });
}
function docAction(btn) {
  var act = btn.getAttribute('data-doc-act'), id = btn.getAttribute('data-doc-id');
  var notes = '';
  if (act === 'rework') {
    notes = window.prompt('What needs fixing on "' + (btn.getAttribute('data-doc-name') || 'this document') + '"? The client sees this note.');
    if (notes == null) return;
    if (!notes.trim()) { actMsg('doc-act-msg', 'err', 'A note is required for rework.'); return; }
  } else if (!window.confirm('Mark this document as reviewed?')) { return; }
  var key = getKey(); if (!key) return;
  btn.disabled = true; actMsg('doc-act-msg', 'info', 'Working…');
  fetch('/api/case/' + encodeURIComponent(CASE_REF) + '/document/' + encodeURIComponent(id) + '/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
    body: JSON.stringify({ action: act, notes: notes })
  })
  .then(function(r) { return r.json().then(function(j) { return { ok: r.ok && j.ok, j: j }; }); })
  .then(function(res) {
    if (res.ok) { actMsg('doc-act-msg', 'ok', act === 'reviewed' ? '✓ Marked reviewed.' : '✓ Rework requested — the client will see your note.'); loadCase(); }
    else { btn.disabled = false; actMsg('doc-act-msg', 'err', (res.j && res.j.error) || 'Action failed.'); }
  })
  .catch(function(e) { btn.disabled = false; actMsg('doc-act-msg', 'err', 'Failed: ' + e.message); });
}

// ── Questionnaire tab: member sections + review / export / client link ──────
function renderQTab(d) {
  var qm = d.questionnaire.members || [];
  document.getElementById('qt-cnt').textContent = (d.questionnaire.submitted || 0) + ' of ' + (d.questionnaire.total || 0) + ' submitted';
  var t = encodeURIComponent(CASE_REF);
  // Carry the admin key on the staff review/PDF links so they work in a new tab
  // (that tab's sessionStorage is empty; the review route accepts ?key=).
  var kq = (getKey() ? ('?key=' + encodeURIComponent(getKey())) : '');
  var acts = '<button class="sbtn primary" id="q-show-embed">Show questionnaire ▾</button>' +
    '<a class="sbtn" href="/q/' + t + '/review' + kq + '" target="_blank" rel="noopener">Open full page →</a>' +
    '<a class="sbtn" href="/q/' + t + '/export-pdf' + kq + '" target="_blank" rel="noopener">Export PDF</a>';
  if (d.accessToken) acts += '<button class="sbtn" id="q-copy-lnk">Copy client link</button>';
  document.getElementById('q-actions').innerHTML = acts;
  // Inline embed: load the generated questionnaire (sections + answers) right
  // in the cockpit, so staff see it next to the document checklist.
  var embed = document.getElementById('qt-embed');
  var shown = false;
  var showBtn = document.getElementById('q-show-embed');
  if (showBtn) showBtn.onclick = function() {
    shown = !shown;
    showBtn.textContent = shown ? 'Hide questionnaire ▴' : 'Show questionnaire ▾';
    if (shown && !embed.querySelector('iframe')) {
      var src = '/q/' + t + '/review?embed=1' + (getKey() ? ('&key=' + encodeURIComponent(getKey())) : '');
      embed.innerHTML = '<iframe title="Questionnaire review" src="' + src + '" ' +
        'style="width:100%;height:70vh;border:1px solid #E2E5EA;border-radius:12px;background:#fff"></iframe>';
    }
    embed.style.display = shown ? 'block' : 'none';
  };
  var copyBtn = document.getElementById('q-copy-lnk');
  if (copyBtn) copyBtn.onclick = function() {
    var url = window.location.origin + '/q/' + t + '?t=' + encodeURIComponent(d.accessToken);
    navigator.clipboard.writeText(url).then(function() {
      copyBtn.textContent = '✓ Copied';
      setTimeout(function() { copyBtn.textContent = 'Copy client link'; }, 2000);
    });
  };
  document.getElementById('qt-list').innerHTML = qm.length ? qm.map(function(m) {
    var sub = m.submittedAt ? ('<span class="dmeta" style="margin-right:8px">submitted ' + escHtml(String(m.submittedAt).slice(0, 10)) + '</span>') : '';
    return '<div class="mrow"><span class="mname">' + escHtml(m.label || m.key) + '</span>' +
      '<span class="mtype" style="margin-right:8px">' + escHtml(m.type || '') + '</span>' + sub + statusTag(m.status) + '</div>';
  }).join('') : '<div class="muted">No questionnaire members yet — they appear once the case checklist is provisioned.</div>';
}

// ── Payments tab: retainer state + milestone e-Transfers with actions ───────
function renderPaymentsTab(d) {
  var body = document.getElementById('pay-body');
  var p = d.payments, L = d.lead;
  document.getElementById('pay-cnt').textContent = '';
  if (!L) { body.innerHTML = '<div class="muted">No linked lead record — this case predates the lead pipeline, so payment history lives on the boards.</div>'; return; }
  if (!p) { body.innerHTML = '<div class="muted">Payment details unavailable right now — reload to retry.</div>'; return; }

  var strip = '<span class="pill ' + (L.retainerSigned ? 'green' : 'grey') + '"><span class="pk">Retainer</span> ' + (p.retainerFee ? ('$' + escHtml(p.retainerFee)) : 'fee not set') + '</span>';
  if (L.retainerSent)   strip += '<span class="pill blue"><span class="pk">Sent</span> ' + escHtml(L.retainerSent) + '</span>';
  if (L.retainerSigned) strip += '<span class="pill green"><span class="pk">Signed</span> ' + escHtml(L.retainerSigned) + '</span>';
  if (L.consultPaid)    strip += '<span class="pill green"><span class="pk">Consult fee</span> paid · Square</span>';
  var html = '<div class="pay-strip">' + strip + '</div>';

  var ms = p.milestones || [];
  document.getElementById('pay-cnt').textContent = ms.length ? (ms.filter(function(m) { return m.status === 'paid'; }).length + ' of ' + ms.length + ' paid') : '';
  if (!ms.length) {
    html += '<div class="muted">No milestone schedule yet — build the retainer plan on the consultation page first.</div>';
  } else {
    html += '<div class="muted" style="margin-bottom:4px">Clients pay by Interac e-Transfer to <b>' + escHtml(p.etransferEmail || '') + '</b> — the reference code ties each transfer to its milestone.</div>';
    html += ms.map(function(m) {
      var amt = '$' + ((m.totalCents || 0) / 100).toFixed(2);
      var st;
      if (m.status === 'paid') st = '<span class="pill green">PAID</span><span class="ms-meta">' + escHtml(m.paidAt || '') + (m.reference ? (' · ref ' + escHtml(m.reference)) : '') + '</span>';
      else if (m.status === 'requested') st = '<span class="pill blue">REQUESTED</span><span class="ms-meta">' + (m.reference ? ('ref ' + escHtml(m.reference)) : '') + '</span>';
      else st = '<span class="pill grey">PENDING</span>';
      if (m.due && m.status !== 'paid') st += '<span class="pill amber">DUE</span>';
      var acts = '';
      if (m.status !== 'paid') {
        // Request only when it can actually succeed AND is due (parity with the
        // consultation page): pending+due, or a legacy Square-era row that never
        // got proper e-Transfer details (server allows a deliberate re-issue).
        if ((m.status === 'pending' && m.due) || m.legacySent) {
          acts += '<button class="sbtn" data-ms-act="request" data-ms-i="' + m.index + '">' +
                  (m.legacySent ? 'Send e-Transfer details' : 'Send e-Transfer request') + '</button>';
        }
        acts += '<button class="sbtn primary" data-ms-act="paid" data-ms-i="' + m.index + '">Mark paid</button>';
      }
      return '<div class="ms-row"><span class="ms-label">' + escHtml(m.label || ('Milestone ' + (m.index + 1))) + '</span>' +
        '<span class="ms-amt">' + amt + '</span>' + st +
        (m.trigger ? '<span class="ms-meta">trigger: ' + escHtml(m.trigger) + '</span>' : '') +
        '<span class="ms-acts">' + acts + '</span></div>';
    }).join('');
  }
  body.innerHTML = html;
  Array.prototype.forEach.call(document.querySelectorAll('#pay-body [data-ms-act]'), function(btn) {
    btn.onclick = function() { msAction(btn); };
  });
}
function msAction(btn) {
  var L = LAST_D && LAST_D.lead; if (!L) return;
  var act = btn.getAttribute('data-ms-act'), i = parseInt(btn.getAttribute('data-ms-i'), 10);
  var payload;
  if (act === 'request') {
    if (!window.confirm('Email the client an e-Transfer request for this milestone?')) return;
    payload = { action: 'sendMilestoneEtransferRequest', value: i };
  } else {
    var ref = window.prompt('e-Transfer reference from the bank notification (optional):');
    if (ref == null) return;
    payload = { action: 'markMilestonePaid', value: JSON.stringify({ index: i, reference: ref.trim() }) };
  }
  var key = getKey(); if (!key) return;
  btn.disabled = true; actMsg('pay-act-msg', 'info', 'Working…');
  fetch('/api/consultation/' + encodeURIComponent(L.leadId) + '/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
    body: JSON.stringify(payload)
  })
  .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
  .then(function(res) {
    if (res.ok) { actMsg('pay-act-msg', 'ok', (res.j && res.j.message) || 'Done.'); loadCase(); }
    else { btn.disabled = false; actMsg('pay-act-msg', 'err', (res.j && res.j.error) || 'Action failed.'); }
  })
  .catch(function(e) { btn.disabled = false; actMsg('pay-act-msg', 'err', 'Failed: ' + e.message); });
}

// ── Meetings tab: consultation artifacts from the linked lead ───────────────
function renderMeetingsTab(d) {
  var body = document.getElementById('meet-body'), L = d.lead;
  if (!L) { body.innerHTML = '<div class="muted">No linked lead record — meeting artifacts live on the lead, which this case predates.</div>'; return; }
  var rows = '';
  rows += '<div class="kvline"><span class="k">Consultation slot</span><span class="v">' + escHtml(L.bookedSlot || '—') + (L.meetingType ? (' · ' + escHtml(L.meetingType)) : '') + '</span></div>';
  rows += '<div class="kvline"><span class="k">Consultation held</span><span class="v">' + escHtml(L.consultationHeld || 'Not yet') + '</span></div>';
  if (L.assignedConsultant) rows += '<div class="kvline"><span class="k">Consultant</span><span class="v">' + escHtml(L.assignedConsultant) + '</span></div>';
  var links = '';
  if (L.meetingLink)    links += '<a class="sbtn primary" href="' + escHtml(L.meetingLink) + '" target="_blank" rel="noopener">🎥 Join meeting</a>';
  if (L.preConsultPdf)  links += '<a class="sbtn" href="' + escHtml(L.preConsultPdf) + '" target="_blank" rel="noopener">📄 Pre-consult dossier</a>';
  if (L.recordingLink)  links += '<a class="sbtn" href="' + escHtml(L.recordingLink) + '" target="_blank" rel="noopener">📼 Recording</a>';
  if (L.transcriptLink) links += '<a class="sbtn" href="' + escHtml(L.transcriptLink) + '" target="_blank" rel="noopener">📝 Transcript</a>';
  rows += '<div class="kvline"><span class="k">Artifacts</span><span class="tab-actions">' + (links || '<span class="muted">None captured yet — the recording and transcript appear after the meeting.</span>') + '</span></div>';
  rows += '<div class="kvline"><span class="k">Consultation record</span><span class="v"><a class="sbtn" href="/admin/consultation/' + encodeURIComponent(L.leadId) + '">Open consultation view →</a></span></div>';
  body.innerHTML = rows;
}

// ── Timeline tab: chronological events derived from recorded dates ──────────
var TL_DOT = { lead: '#2563eb', meeting: '#7c3aed', doc: '#64748b', retainer: '#1a3558', payment: '#16a34a', questionnaire: '#d97706' };
function renderTimelineTab(d) {
  var ev = d.timeline || [];
  document.getElementById('tl-cnt').textContent = ev.length + ' event' + (ev.length !== 1 ? 's' : '');
  document.getElementById('tl-list').innerHTML = ev.length ? ('<div class="tl">' + ev.map(function(e) {
    var dt = String(e.date || '').replace('T', ' ').slice(0, 16);
    return '<div class="tl-ev"><span class="tl-dot" style="background:' + (TL_DOT[e.kind] || '#94a3b8') + '"></span>' +
      '<div class="tl-date">' + escHtml(dt) + '</div>' +
      '<div class="tl-title">' + escHtml(e.title) + '</div>' +
      (e.detail ? '<div class="tl-detail">' + escHtml(e.detail) + '</div>' : '') + '</div>';
  }).join('') + '</div>') : '<div class="muted">No recorded events yet.</div>';
}

function loadCase() {
  var key = getKey();
  if (!key) return;
  fetch('/api/case/' + encodeURIComponent(CASE_REF), { headers: { 'X-Api-Key': key } })
    .then(function(r) {
      if (r.status === 401 || r.status === 403) { window.location.href = '/admin'; throw new Error('Unauthorized'); }
      if (r.status === 404) throw new Error('Case not found: ' + CASE_REF);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(d) {
      render(d);
      document.getElementById('loading').style.display = 'none';
      document.getElementById('content').style.display = 'block';
    })
    .catch(function(e) {
      if (e.message === 'Unauthorized') return;
      document.getElementById('loading').style.display = 'none';
      var el = document.getElementById('error-msg');
      el.textContent = 'Failed to load case: ' + e.message;
      el.style.display = 'block';
    });
}

// Tab switching
document.getElementById('tabbar').addEventListener('click', function(e) {
  var btn = e.target.closest('.tab');
  if (!btn) return;
  var tab = btn.getAttribute('data-tab');
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.toggle('active', t === btn); });
  document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.toggle('active', p.id === 'panel-' + tab); });
});

startClock();
checkApiStatus();
loadCase();
</script>
</body>
</html>`;
}

router.get('/:caseRef', (req, res) => {
  const caseRef = (req.params.caseRef || '').trim();
  // Defense in depth: real refs are e.g. "2026-VV-006" — anything outside this
  // charset can only be a probe, so reject before it reaches the HTML.
  if (!/^[A-Za-z0-9\- ]{1,100}$/.test(caseRef)) {
    return res.status(404).type('html').send('Case not found.');
  }
  res.type('html').send(buildCockpitHTML(caseRef));
});

module.exports = router;
module.exports.buildCockpitHTML = buildCockpitHTML; // exported for the render harness / script validation
