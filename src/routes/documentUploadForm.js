const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { getCaseDocuments, uploadFileToOneDrive, markDocumentReceived } = require('../services/documentFormService');
const { updateLastActivityDate } = require('../services/clientMasterService');
const { calculateForCaseRef }   = require('../services/caseReadinessService');

// Store uploads in memory (max 20 MB per file)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
});

// ─── Category display order ───────────────────────────────────────────────────
const CATEGORY_ORDER = ['Identity', 'Personal', 'Financial', 'Employment', 'Education', 'Travel', 'Legal', 'Supporting', 'General'];
const CATEGORY_ICONS = {
  Identity:   '🪪', Personal:  '👤', Financial: '💰', Employment: '💼',
  Education:  '🎓', Travel:    '✈️', Legal:     '⚖️', Supporting: '📎',
  General:    '📋',
};

const STATUS_STYLE = {
  'Missing':          { bg: '#fef2f2', color: '#dc2626', dot: '#dc2626' },
  'Received':         { bg: '#eff6ff', color: '#2563eb', dot: '#2563eb' },
  'Reviewed':         { bg: '#f0fdf4', color: '#16a34a', dot: '#16a34a' },
  'Rework Required':  { bg: '#fff7ed', color: '#ea580c', dot: '#ea580c' },
};

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function groupByCategory(items) {
  const map = {};
  items.forEach((item) => {
    const cat = item.category || 'General';
    if (!map[cat]) map[cat] = [];
    map[cat].push(item);
  });
  return CATEGORY_ORDER
    .filter((c) => map[c])
    .concat(Object.keys(map).filter((c) => !CATEGORY_ORDER.includes(c)))
    .map((c) => ({ category: c, items: map[c] }));
}

// ─── Landing page ─────────────────────────────────────────────────────────────
function landingPage(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Document Upload</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--brand:rgb(143,5,5);--brand-dark:#6d0404;--brand-faint:rgba(143,5,5,.08)}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;background:#e8e8e8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#fff;border-radius:18px;box-shadow:0 12px 48px rgba(0,0,0,.15);width:100%;max-width:420px;overflow:hidden;text-align:center}
.card-header{background:#1a1a1a;padding:1.75rem 2rem 1.6rem;display:flex;flex-direction:column;align-items:center;gap:.55rem}
.logo-img{height:38px;object-fit:contain}
.brand-sub{font-size:.65rem;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.38);font-weight:600}
.card-body{padding:1.85rem 2.25rem 2rem}
h1{font-size:1.2rem;color:#111;margin-bottom:.4rem;font-weight:700}
.card-body>p{color:#666;font-size:.9rem;margin-bottom:1.65rem;line-height:1.65}
label{display:block;text-align:left;font-size:.8rem;font-weight:600;color:#222;margin-bottom:.42rem;letter-spacing:.01em}
input[type=text]{width:100%;padding:.72rem 1rem;border:1.5px solid #ddd;border-radius:9px;font-size:.93rem;outline:none;transition:border-color .2s,box-shadow .2s;color:#111;background:#fff}
input[type=text]:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-faint)}
.btn{display:block;width:100%;margin-top:1.1rem;padding:.82rem;background:var(--brand);color:#fff;font-size:.92rem;font-weight:700;border:none;border-radius:9px;cursor:pointer;transition:background .2s;letter-spacing:.02em}
.btn:hover{background:var(--brand-dark)}
.error{background:#fff5f5;border:1.5px solid #fecaca;color:#9b1c1c;padding:.7rem 1rem;border-radius:9px;margin-bottom:1.2rem;font-size:.86rem;text-align:left;line-height:1.5}
.hint{font-size:.76rem;color:#aaa;margin-top:1rem;line-height:1.5}
.card-footer{padding:.8rem;background:#f5f5f5;border-top:1px solid #eee;font-size:.68rem;color:#bbb;letter-spacing:.06em;text-transform:uppercase}
</style>
</head>
<body>
<div class="card">
  <div class="card-header">
    <img src="https://tdotimm.com/_next/image?url=%2Ftdot_logo_inv.webp&w=128&q=75" alt="TDOT Immigration" class="logo-img">
    <span class="brand-sub">Client Portal</span>
  </div>
  <div class="card-body">
    <h1>Document Upload</h1>
    <p>Enter your <strong>Case Reference Number</strong> to access and upload your required documents.</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form method="GET" action="">
      <label for="caseRef">Case Reference Number</label>
      <input type="text" id="caseRef" name="ref" placeholder="e.g. 2026-SP-001" autocomplete="off" required>
      <button class="btn" type="submit">Access My Documents →</button>
    </form>
    <p class="hint">Don't know your case reference? Contact your consultant.</p>
  </div>
  <div class="card-footer">TDOT Immigration &nbsp;·&nbsp; Secure Client Portal</div>
</div>
<script>
  document.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const ref = document.getElementById('caseRef').value.trim();
    if (ref) window.location.href = '/documents/' + encodeURIComponent(ref);
  });
</script>
</body></html>`;
}

// ─── Main upload form ──────────────────────────────────────────────────────────
function formPage(caseRef, sections) {
  const totalDocs    = sections.reduce((s, sec) => s + sec.items.length, 0);
  const uploadedDocs = sections.reduce((s, sec) => s + sec.items.filter((i) => i.status !== 'Missing').length, 0);
  const pct          = totalDocs ? Math.round((uploadedDocs / totalDocs) * 100) : 0;
  const total        = sections.length;

  const stepPills = sections.map((sec, idx) => {
    const icon = CATEGORY_ICONS[sec.category] || '📋';
    return `<button class="step-pill" id="pill_${idx}" onclick="goToStep(${idx})" title="${esc(sec.category)}">
      <span class="pill-num">${idx + 1}</span>
      <span class="pill-label">${icon} ${esc(sec.category)}</span>
    </button>`;
  }).join('');

  const panels = sections.map((sec, idx) => {
    const icon    = CATEGORY_ICONS[sec.category] || '📋';
    const isLast  = idx === total - 1;
    const uploaded = sec.items.filter((i) => i.status !== 'Missing').length;

    const docsHtml = sec.items.map((doc) => {
      const st    = STATUS_STYLE[doc.status] || STATUS_STYLE['Missing'];
      const canUpload = doc.status !== 'Reviewed';
      return `
      <div class="doc-row${doc.status === 'Rework Required' ? ' needs-action' : ''}" id="doc_${doc.id}">
        <div class="doc-info">
          <div class="doc-top">
            <span class="doc-code">${esc(doc.documentCode)}</span>
            ${doc.status === 'Rework Required' ? '<span class="badge action-required">⚠️ Re-upload Required</span>' : (doc.requiredType === 'Mandatory' ? '<span class="badge mandatory">Required</span>' : `<span class="badge optional">${esc(doc.requiredType)}</span>`)}
            ${doc.blocking === 'Yes' ? '<span class="badge blocking">Blocking</span>' : ''}
          </div>
          <div class="doc-name">${esc(doc.name)}</div>
          ${doc.status === 'Rework Required' && doc.reviewNotes ? `<div class="doc-review-note">📋 <strong>Officer note:</strong> ${esc(doc.reviewNotes)}</div>` : ''}
          ${doc.description ? `<div class="doc-desc">${esc(doc.description)}</div>` : ''}
          ${doc.clientInstructions ? `<div class="doc-instructions">💡 ${esc(doc.clientInstructions)}</div>` : ''}
          ${doc.source ? `<div class="doc-meta">Source: ${esc(doc.source)}</div>` : ''}
          ${doc.lastUpload ? `<div class="doc-meta">Last uploaded: ${esc(doc.lastUpload)}</div>` : ''}
        </div>
        <div class="doc-actions">
          <span class="doc-status" style="background:${st.bg};color:${st.color}">
            <span style="background:${st.dot};width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:.35rem"></span>
            ${esc(doc.status)}
          </span>
          ${canUpload ? `
          <label class="btn-upload" for="file_${doc.id}">
            ${doc.status === 'Missing' ? '⬆ Upload' : '🔄 Re-upload'}
          </label>
          <input type="file" id="file_${doc.id}" style="display:none"
            accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.heic,.xlsx,.xls,.csv,.zip"
            onchange="handleUpload('${esc(doc.id)}', '${esc(caseRef)}', this)">
          ` : '<span class="reviewed-tag">✓ Reviewed</span>'}
          <div class="upload-progress" id="prog_${doc.id}" style="display:none">
            <div class="progress-bar-inner" id="pbar_${doc.id}"></div>
          </div>
          <div class="upload-msg" id="umsg_${doc.id}"></div>
        </div>
      </div>`;
    }).join('');

    return `
    <div class="panel" id="panel_${idx}" style="display:none">
      <div class="panel-header">
        <div class="panel-title">${icon} ${esc(sec.category)}</div>
        <div class="panel-meta" id="pmeta_${idx}">${uploaded} of ${sec.items.length} uploaded</div>
      </div>
      <div class="panel-body">${docsHtml}</div>
      <div class="panel-footer">
        <div class="footer-right">
          ${idx > 0 ? `<button class="btn-nav btn-back" onclick="goToStep(${idx - 1})">← Back</button>` : ''}
          ${isLast
            ? `<button class="btn-nav btn-done" onclick="showDone()">✅ Done</button>`
            : `<button class="btn-nav btn-next" onclick="goToStep(${idx + 1})">Next →</button>`
          }
        </div>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Documents — ${esc(caseRef)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--brand:rgb(143,5,5);--brand-dark:#6d0404;--brand-faint:rgba(143,5,5,.07)}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;background:#e8e8e8;color:#111;min-height:100vh}

.top-bar{background:#1a1a1a;color:#fff;padding:.65rem 1.5rem;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:0 2px 16px rgba(0,0,0,.45)}
.top-bar-brand{display:flex;align-items:center;gap:.85rem}
.top-bar-logo{height:30px;object-fit:contain;flex-shrink:0}
.top-bar-divider{width:1px;height:22px;background:rgba(255,255,255,.15);flex-shrink:0}
.top-bar-info h1{font-size:.88rem;font-weight:700;color:#fff;line-height:1.3}
.top-bar-info .case-ref{font-size:.7rem;color:rgba(255,255,255,.42);margin-top:.08rem}

.progress-wrap{background:#111;padding:.3rem 1.5rem .65rem;position:sticky;top:52px;z-index:199}
.progress-text{font-size:.67rem;color:rgba(255,255,255,.42);margin-bottom:.3rem;letter-spacing:.02em}
.progress-track{background:rgba(255,255,255,.13);border-radius:99px;height:3px}
.progress-fill{background:var(--brand);height:3px;border-radius:99px;transition:width .45s}

.steps-wrap{background:#fff;border-bottom:1px solid #e8e8e8;position:sticky;top:90px;z-index:198;overflow-x:auto;-webkit-overflow-scrolling:touch}
.steps-inner{display:flex;min-width:max-content}
.step-pill{display:flex;align-items:center;gap:.4rem;padding:.62rem 1.1rem;border:none;background:transparent;cursor:pointer;font-size:.77rem;color:#777;border-bottom:2.5px solid transparent;transition:all .2s;white-space:nowrap;font-family:inherit}
.step-pill:hover{background:#fafafa;color:#111}
.step-pill.active{color:var(--brand);border-bottom-color:var(--brand);font-weight:600;background:var(--brand-faint)}
.step-pill.done{color:#059669}
.step-pill.done .pill-num{background:#059669;color:#fff}
.pill-num{width:19px;height:19px;border-radius:50%;background:#e8e8e8;color:#777;font-size:.67rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s}
.step-pill.active .pill-num{background:var(--brand);color:#fff}

.main{max-width:800px;margin:1.5rem auto;padding:0 1rem 4rem}

.panel{background:#fff;border-radius:14px;box-shadow:0 2px 16px rgba(0,0,0,.07);overflow:hidden}
.panel-header{padding:1.1rem 1.5rem;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between}
.panel-title{font-size:1.08rem;font-weight:700;color:#111}
.panel-meta{font-size:.76rem;color:#888;background:#f3f3f3;padding:.2rem .65rem;border-radius:99px}
.panel-body{padding:.5rem 0}

.doc-row{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:1rem 1.5rem;border-bottom:1px solid #f5f5f5;flex-wrap:wrap}
.doc-row:last-child{border-bottom:none}
.doc-info{flex:1;min-width:0}
.doc-top{display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem;flex-wrap:wrap}
.doc-code{font-size:.67rem;color:#c0c0c0;font-family:monospace;letter-spacing:.04em}
.badge{font-size:.62rem;font-weight:700;padding:.15rem .5rem;border-radius:5px;text-transform:uppercase;letter-spacing:.05em}
.badge.mandatory{background:#fff0f0;color:#9b1c1c}
.badge.optional{background:#f0fdf4;color:#15803d}
.badge.blocking{background:#fff7ed;color:#c2410c}
.badge.action-required{background:#fff7ed;color:#ea580c;border:1px solid #fed7aa}
.doc-row.needs-action{border:2px solid #f97316!important;background:#fffbf5!important;border-radius:12px;margin:.25rem .75rem}
.doc-name{font-size:.9rem;font-weight:600;color:#111;line-height:1.4}
.doc-desc{font-size:.8rem;color:#555;margin-top:.3rem;line-height:1.5}
.doc-instructions{font-size:.8rem;color:#444;background:#f7f7f7;padding:.35rem .6rem;border-radius:7px;margin-top:.35rem;line-height:1.5;border-left:3px solid #ddd}
.doc-review-note{font-size:.8rem;color:#9a3412;background:#fff7ed;padding:.4rem .7rem;border-radius:7px;margin-top:.35rem;line-height:1.5;border-left:3px solid #fb923c}
.doc-meta{font-size:.73rem;color:#bbb;margin-top:.2rem}
.doc-actions{display:flex;flex-direction:column;align-items:flex-end;gap:.4rem;flex-shrink:0}
.doc-status{display:inline-flex;align-items:center;font-size:.73rem;font-weight:600;padding:.22rem .6rem;border-radius:99px;white-space:nowrap}
.btn-upload{display:inline-flex;align-items:center;padding:.38rem .9rem;background:var(--brand);color:#fff;border-radius:7px;font-size:.78rem;font-weight:700;cursor:pointer;transition:background .2s;white-space:nowrap;letter-spacing:.01em}
.btn-upload:hover{background:var(--brand-dark)}
.reviewed-tag{font-size:.78rem;color:#059669;font-weight:600}
.upload-progress{width:110px;height:3px;background:#e8e8e8;border-radius:99px;overflow:hidden;margin-top:.25rem}
.progress-bar-inner{height:3px;background:var(--brand);border-radius:99px;width:0;transition:width .3s}
.upload-msg{font-size:.73rem;color:#888;text-align:right;min-height:1em}

.panel-footer{display:flex;align-items:center;justify-content:flex-end;padding:.95rem 1.5rem;border-top:1px solid #f0f0f0;background:#fafafa;gap:.6rem}
.btn-nav{padding:.58rem 1.25rem;border:none;border-radius:8px;font-size:.85rem;font-weight:600;cursor:pointer;transition:all .2s;font-family:inherit}
.btn-back{background:#f0f0f0;color:#444}
.btn-back:hover{background:#e4e4e4}
.btn-next{background:var(--brand);color:#fff}
.btn-next:hover{background:var(--brand-dark)}
.btn-done{background:#059669;color:#fff}
.btn-done:hover{background:#047857}

.toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#1a1a1a;color:#fff;padding:.72rem 1.1rem;border-radius:9px;font-size:.85rem;box-shadow:0 4px 22px rgba(0,0,0,.28);opacity:0;transform:translateY(6px);transition:all .3s;pointer-events:none;z-index:999;max-width:280px}
.toast.show{opacity:1;transform:translateY(0)}
.toast.success{background:#059669}
.toast.error{background:var(--brand)}

.done-panel{background:#fff;border-radius:14px;box-shadow:0 2px 16px rgba(0,0,0,.07);text-align:center;padding:3.5rem 2rem}
.done-panel .d-icon{font-size:3rem;margin-bottom:1rem}
.done-panel h2{color:#059669;font-size:1.5rem;margin-bottom:.6rem;font-weight:700}
.done-panel p{color:#666;font-size:.93rem;line-height:1.65}

@media(max-width:600px){
  .top-bar{padding:.6rem 1rem}
  .top-bar-divider{display:none}
  .doc-row{flex-direction:column}
  .doc-actions{align-items:flex-start;flex-direction:row;flex-wrap:wrap}
  .main{padding:0 .5rem 4rem}
}
</style>
</head>
<body>

<div class="top-bar">
  <div class="top-bar-brand">
    <img src="https://tdotimm.com/_next/image?url=%2Ftdot_logo_inv.webp&w=128&q=75" alt="TDOT Immigration" class="top-bar-logo">
    <div class="top-bar-divider"></div>
    <div class="top-bar-info">
      <h1>Document Upload</h1>
      <div class="case-ref">Case Ref: ${esc(caseRef)}</div>
    </div>
  </div>
</div>

<div class="progress-wrap">
  <div class="progress-text" id="progressLabel">${uploadedDocs} of ${totalDocs} documents uploaded (${pct}%)</div>
  <div class="progress-track"><div class="progress-fill" id="progressFill" style="width:${pct}%"></div></div>
</div>

<div class="steps-wrap">
  <div class="steps-inner">${stepPills}</div>
</div>

<div class="main" id="mainContent">
  ${panels}
</div>

<div class="toast" id="toast"></div>

<script>
const CASE_REF  = ${JSON.stringify(caseRef)};
const TOTAL     = ${total};
let currentStep = 0;
let uploadedCount = ${uploadedDocs};
let totalCount    = ${totalDocs};

function goToStep(idx) {
  document.getElementById('panel_' + currentStep).style.display = 'none';
  currentStep = idx;
  document.getElementById('panel_' + idx).style.display = 'block';
  updateStepPills();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateStepPills() {
  for (let i = 0; i < TOTAL; i++) {
    const pill = document.getElementById('pill_' + i);
    pill.classList.remove('active', 'done');
    if (i === currentStep) pill.classList.add('active');
    else if (i < currentStep) pill.classList.add('done');
  }
  document.getElementById('pill_' + currentStep)
    .scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

goToStep(0);

function updateProgress() {
  const pct = totalCount ? Math.round((uploadedCount / totalCount) * 100) : 0;
  document.getElementById('progressLabel').textContent =
    uploadedCount + ' of ' + totalCount + ' documents uploaded (' + pct + '%)';
  document.getElementById('progressFill').style.width = pct + '%';
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.className = 'toast', 3500);
}

async function handleUpload(itemId, caseRef, input) {
  const file = input.files[0];
  if (!file) return;

  const prog  = document.getElementById('prog_' + itemId);
  const pbar  = document.getElementById('pbar_' + itemId);
  const msg   = document.getElementById('umsg_' + itemId);
  const row   = document.getElementById('doc_' + itemId);
  const label = row.querySelector('.btn-upload');

  prog.style.display = 'block';
  pbar.style.width   = '30%';
  msg.textContent    = 'Uploading…';
  if (label) { label.style.pointerEvents = 'none'; label.style.opacity = '.6'; }

  const formData = new FormData();
  formData.append('file', file);

  try {
    pbar.style.width = '60%';
    const res  = await fetch(
      '/documents/' + encodeURIComponent(caseRef) + '/upload/' + itemId,
      { method: 'POST', body: formData }
    );
    const data = await res.json();

    pbar.style.width = '100%';

    if (data.success) {
      msg.textContent = '✓ Uploaded successfully';
      msg.style.color = '#10b981';
      // Update status pill in row
      const statusEl = row.querySelector('.doc-status');
      if (statusEl) {
        statusEl.style.background = '#eff6ff';
        statusEl.style.color      = '#2563eb';
        statusEl.innerHTML = '<span style="background:#2563eb;width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:.35rem"></span>Received';
      }
      // Update panel meta count
      uploadedCount++;
      updateProgress();
      updatePanelMeta(currentStep);
      showToast('Document uploaded!');
    } else {
      msg.textContent = '⚠ Upload failed. Please try again.';
      msg.style.color = '#dc2626';
      showToast('Upload failed', 'error');
    }
  } catch (e) {
    msg.textContent = '⚠ Network error. Please try again.';
    msg.style.color = '#dc2626';
    showToast('Network error', 'error');
  } finally {
    setTimeout(() => { prog.style.display = 'none'; pbar.style.width = '0'; }, 1500);
    if (label) { label.style.pointerEvents = ''; label.style.opacity = ''; }
    input.value = '';
  }
}

function updatePanelMeta(idx) {
  const panel = document.getElementById('panel_' + idx);
  if (!panel) return;
  const rows   = panel.querySelectorAll('.doc-row');
  let uploaded = 0;
  rows.forEach(r => {
    const st = r.querySelector('.doc-status');
    if (st && !st.textContent.includes('Missing')) uploaded++;
  });
  const meta = document.getElementById('pmeta_' + idx);
  if (meta) meta.textContent = uploaded + ' of ' + rows.length + ' uploaded';
}

function showDone() {
  document.getElementById('mainContent').innerHTML = \`
    <div class="done-panel">
      <div class="d-icon">🎉</div>
      <h2>Documents Submitted!</h2>
      <p>Thank you. Your uploaded documents have been received by your consultant.<br><br>
         <strong>Case Reference: \${CASE_REF}</strong><br><br>
         You will be contacted if any additional documents are needed.</p>
    </div>\`;
  document.querySelector('.steps-wrap').style.display = 'none';
  document.querySelector('.progress-wrap').style.display = 'none';
}
</script>
</body></html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.send(landingPage(req.query.error || ''));
});

router.get('/:caseRef', async (req, res) => {
  const caseRef = decodeURIComponent(req.params.caseRef).trim();
  try {
    const items = await getCaseDocuments(caseRef);
    if (!items.length) {
      return res.redirect(`/documents?error=${encodeURIComponent(`No documents found for case "${caseRef}". Please check your case reference number.`)}`);
    }
    const sections = groupByCategory(items);
    res.send(formPage(caseRef, sections));
  } catch (err) {
    console.error('[DocForm] Error loading form:', err.message);
    res.status(500).send(landingPage('An error occurred. Please try again later.'));
  }
});

router.post('/:caseRef/upload/:itemId', upload.single('file'), async (req, res) => {
  const caseRef = decodeURIComponent(req.params.caseRef).trim();
  const itemId  = req.params.itemId;
  const file    = req.file;

  if (!file) {
    return res.status(400).json({ success: false, error: 'No file provided' });
  }

  try {
    await uploadFileToOneDrive(itemId, caseRef, file.buffer, file.originalname, file.mimetype);
    await markDocumentReceived(itemId);
    res.json({ success: true });
    // Non-blocking post-upload: update activity date + recalculate readiness
    updateLastActivityDate(caseRef).catch(() => {});
    calculateForCaseRef(caseRef).catch(() => {});
  } catch (err) {
    console.error('[DocForm] Upload error for item', itemId, ':', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
