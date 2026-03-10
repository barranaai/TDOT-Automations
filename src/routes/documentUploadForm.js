const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { getCaseDocuments, uploadFileToMonday, markDocumentReceived } = require('../services/documentFormService');
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
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f4f8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.10);padding:2.5rem 2rem;width:100%;max-width:440px;text-align:center}
.logo{font-size:2rem;margin-bottom:.5rem}
h1{font-size:1.5rem;color:#1e3a5f;margin-bottom:.5rem}
p{color:#64748b;font-size:.95rem;margin-bottom:1.75rem;line-height:1.5}
label{display:block;text-align:left;font-size:.85rem;font-weight:600;color:#374151;margin-bottom:.4rem}
input[type=text]{width:100%;padding:.7rem 1rem;border:1.5px solid #d1d5db;border-radius:8px;font-size:1rem;outline:none;transition:border .2s}
input[type=text]:focus{border-color:#2563eb}
.btn{display:block;width:100%;margin-top:1rem;padding:.8rem;background:#1e3a5f;color:#fff;font-size:1rem;font-weight:600;border:none;border-radius:8px;cursor:pointer;transition:background .2s}
.btn:hover{background:#2563eb}
.error{background:#fef2f2;border:1px solid #fca5a5;color:#dc2626;padding:.75rem 1rem;border-radius:8px;margin-bottom:1.25rem;font-size:.9rem}
.hint{font-size:.8rem;color:#9ca3af;margin-top:1rem}
</style>
</head>
<body>
<div class="card">
  <div class="logo">📁</div>
  <h1>Document Upload</h1>
  <p>Please enter your <strong>Case Reference Number</strong> to access and upload your required documents.</p>
  ${error ? `<div class="error">⚠️ ${esc(error)}</div>` : ''}
  <form method="GET" action="">
    <label for="caseRef">Case Reference Number</label>
    <input type="text" id="caseRef" name="ref" placeholder="e.g. 2026-SP-001" autocomplete="off" required>
    <button class="btn" type="submit">Access My Documents →</button>
  </form>
  <p class="hint">If you don't know your case reference, please contact your consultant.</p>
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
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f4f8;color:#1e293b;min-height:100vh}

.top-bar{background:#1e3a5f;color:#fff;padding:.7rem 1.25rem;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.top-bar-left h1{font-size:1rem;font-weight:700;line-height:1.3}
.top-bar-left .case-ref{font-size:.78rem;opacity:.7;margin-top:.1rem}

.progress-wrap{background:#1e3a5f;padding:.3rem 1.25rem .75rem;position:sticky;top:52px;z-index:199}
.progress-text{font-size:.72rem;color:rgba(255,255,255,.7);margin-bottom:.3rem}
.progress-track{background:rgba(255,255,255,.18);border-radius:99px;height:5px}
.progress-fill{background:#10b981;height:5px;border-radius:99px;transition:width .4s}

.steps-wrap{background:#fff;border-bottom:1px solid #e2e8f0;position:sticky;top:96px;z-index:198;overflow-x:auto;-webkit-overflow-scrolling:touch}
.steps-inner{display:flex;min-width:max-content}
.step-pill{display:flex;align-items:center;gap:.4rem;padding:.65rem 1.1rem;border:none;background:transparent;cursor:pointer;font-size:.8rem;color:#64748b;border-bottom:2px solid transparent;transition:all .2s;white-space:nowrap;font-family:inherit}
.step-pill:hover{background:#f8fafc;color:#1e3a5f}
.step-pill.active{color:#1e3a5f;border-bottom-color:#2563eb;font-weight:600;background:#eff6ff}
.step-pill.done{color:#10b981}
.step-pill.done .pill-num{background:#10b981;color:#fff}
.pill-num{width:20px;height:20px;border-radius:50%;background:#e2e8f0;color:#64748b;font-size:.7rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s}
.step-pill.active .pill-num{background:#2563eb;color:#fff}

.main{max-width:820px;margin:1.5rem auto;padding:0 1rem 4rem}

.panel{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);overflow:hidden}
.panel-header{padding:1.1rem 1.5rem;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between}
.panel-title{font-size:1.15rem;font-weight:700;color:#1e3a5f}
.panel-meta{font-size:.8rem;color:#64748b;background:#f1f5f9;padding:.2rem .65rem;border-radius:99px}
.panel-body{padding:.5rem 0}

.doc-row{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:1rem 1.5rem;border-bottom:1px solid #f8fafc;flex-wrap:wrap}
.doc-row:last-child{border-bottom:none}
.doc-info{flex:1;min-width:0}
.doc-top{display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem;flex-wrap:wrap}
.doc-code{font-size:.7rem;color:#94a3b8;font-family:monospace}
.badge{font-size:.65rem;font-weight:700;padding:.15rem .45rem;border-radius:4px;text-transform:uppercase;letter-spacing:.04em}
.badge.mandatory{background:#fef2f2;color:#dc2626}
.badge.optional{background:#f0fdf4;color:#16a34a}
.badge.blocking{background:#fff7ed;color:#ea580c}
.badge.action-required{background:#fff7ed;color:#ea580c;border:1px solid #fed7aa;font-weight:700}
.doc-row.needs-action{border:2px solid #f97316!important;background:#fff7ed!important;border-radius:10px}
.doc-name{font-size:.92rem;font-weight:500;color:#1e293b;line-height:1.4}
.doc-desc{font-size:.82rem;color:#475569;margin-top:.3rem;line-height:1.5}
.doc-instructions{font-size:.82rem;color:#2563eb;background:#eff6ff;padding:.35rem .6rem;border-radius:6px;margin-top:.35rem;line-height:1.5;border-left:3px solid #93c5fd}
.doc-review-note{font-size:.82rem;color:#9a3412;background:#ffedd5;padding:.4rem .7rem;border-radius:6px;margin-top:.35rem;line-height:1.5;border-left:3px solid #f97316}
.doc-meta{font-size:.75rem;color:#94a3b8;margin-top:.2rem}
.doc-actions{display:flex;flex-direction:column;align-items:flex-end;gap:.4rem;flex-shrink:0}
.doc-status{display:inline-flex;align-items:center;font-size:.75rem;font-weight:600;padding:.25rem .65rem;border-radius:99px;white-space:nowrap}
.btn-upload{display:inline-flex;align-items:center;padding:.4rem .9rem;background:#1e3a5f;color:#fff;border-radius:7px;font-size:.8rem;font-weight:600;cursor:pointer;transition:background .2s;white-space:nowrap}
.btn-upload:hover{background:#2563eb}
.reviewed-tag{font-size:.8rem;color:#16a34a;font-weight:600}
.upload-progress{width:120px;height:4px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin-top:.2rem}
.progress-bar-inner{height:4px;background:#2563eb;border-radius:99px;width:0;transition:width .3s}
.upload-msg{font-size:.75rem;color:#64748b;text-align:right;min-height:1em}

.panel-footer{display:flex;align-items:center;justify-content:flex-end;padding:1rem 1.5rem;border-top:1px solid #f1f5f9;background:#fafbfc;gap:.6rem}
.btn-nav{padding:.6rem 1.3rem;border:none;border-radius:8px;font-size:.88rem;font-weight:600;cursor:pointer;transition:background .2s;font-family:inherit}
.btn-back{background:#f1f5f9;color:#475569}
.btn-back:hover{background:#e2e8f0}
.btn-next{background:#2563eb;color:#fff}
.btn-next:hover{background:#1d4ed8}
.btn-done{background:#10b981;color:#fff}
.btn-done:hover{background:#059669}

.toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#1e293b;color:#fff;padding:.75rem 1.1rem;border-radius:8px;font-size:.88rem;box-shadow:0 4px 18px rgba(0,0,0,.2);opacity:0;transform:translateY(6px);transition:all .3s;pointer-events:none;z-index:999;max-width:280px}
.toast.show{opacity:1;transform:translateY(0)}
.toast.success{background:#10b981}
.toast.error{background:#dc2626}

.done-panel{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;padding:3.5rem 2rem}
.done-panel .d-icon{font-size:3.5rem;margin-bottom:1rem}
.done-panel h2{color:#10b981;font-size:1.6rem;margin-bottom:.6rem}
.done-panel p{color:#64748b;font-size:.95rem;line-height:1.6}

@media(max-width:600px){
  .doc-row{flex-direction:column}
  .doc-actions{align-items:flex-start;flex-direction:row;flex-wrap:wrap}
  .main{padding:0 .5rem 4rem}
}
</style>
</head>
<body>

<div class="top-bar">
  <div class="top-bar-left">
    <h1>📁 Document Upload</h1>
    <div class="case-ref">Case: ${esc(caseRef)}</div>
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
    await uploadFileToMonday(itemId, file.buffer, file.originalname, file.mimetype);
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
