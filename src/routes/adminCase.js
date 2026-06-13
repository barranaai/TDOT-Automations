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
      <button class="tab" data-tab="payments">Payments <span class="soon">soon</span></button>
      <button class="tab" data-tab="meetings">Meetings <span class="soon">soon</span></button>
      <button class="tab" data-tab="timeline">Timeline <span class="soon">soon</span></button>
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

    <!-- Documents tab -->
    <div class="tab-panel" id="panel-documents">
      <div class="card placeholder">
        <div class="pic">📂</div>
        <h3>Document review</h3>
        <p>Mark documents reviewed, request rework with notes, and read client replies. This already runs as a dedicated staff page — opening it here while the actions move into the cockpit.</p>
        <a class="act-btn primary" id="doc-review-lnk" target="_blank" rel="noopener">Open document review →</a>
      </div>
    </div>

    <!-- Questionnaire tab -->
    <div class="tab-panel" id="panel-questionnaire">
      <div class="card placeholder">
        <div class="pic">📝</div>
        <h3>Questionnaire review</h3>
        <p>Review submitted answers, flag fields for correction, and notify the client. This already runs as a dedicated staff page — opening it here while the actions move into the cockpit.</p>
        <a class="act-btn primary" id="q-review-lnk" target="_blank" rel="noopener">Open questionnaire review →</a>
      </div>
    </div>

    <!-- Payments tab -->
    <div class="tab-panel" id="panel-payments">
      <div class="card placeholder">
        <div class="pic">💳</div>
        <h3>Payments — coming next</h3>
        <p>Consultation and retainer payment history, fee status, and the ability to send a payment link without opening Monday. Data already exists on the boards; this tab surfaces it.</p>
        <span class="muted">Current payment status is shown on the header pill above.</span>
      </div>
    </div>

    <!-- Meetings tab -->
    <div class="tab-panel" id="panel-meetings">
      <div class="card placeholder">
        <div class="pic">🎥</div>
        <h3>Meetings — coming next</h3>
        <p>Consultation slot, Teams join link, the pre-consult dossier PDF, and the meeting recording — all in one place. These live on the lead record today; this tab joins them to the case.</p>
      </div>
    </div>

    <!-- Timeline tab -->
    <div class="tab-panel" id="panel-timeline">
      <div class="card placeholder">
        <div class="pic">🕓</div>
        <h3>Timeline — coming next</h3>
        <p>A chronological view of stage transitions, emails sent, documents received, and submissions. Needs new stage-history capture (Monday stores only the current stage today), so this one builds forward from now.</p>
      </div>
    </div>

  </div><!-- /content -->
</main>

<script>
var CASE_REF = ${JSON.stringify(caseRef)};

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

  // Review-page links
  var t = encodeURIComponent(CASE_REF);
  document.getElementById('doc-review-lnk').href = '/d/' + t + '/review';
  document.getElementById('q-review-lnk').href   = '/q/' + t + '/review';
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
  res.type('html').send(buildCockpitHTML(caseRef));
});

module.exports = router;
