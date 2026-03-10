const express = require('express');
const router  = express.Router();
const { getCaseItems, saveAnswers, submitQuestionnaire } = require('../services/questionnaireFormService');

// ─── Category display order ───────────────────────────────────────────────────
const CATEGORY_ORDER = ['Personal', 'Background', 'Travel', 'Education', 'Employment', 'Legal', 'Financial', 'General'];
const CATEGORY_ICONS = {
  Personal: '👤', Background: '🔍', Travel: '✈️', Education: '🎓',
  Employment: '💼', Legal: '⚖️', Financial: '💰', General: '📋',
};

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInput(q) {
  const v   = esc(q.currentAnswer);
  const id  = `ans_${q.id}`;
  const cls = 'form-input';

  switch (q.inputType) {
    case 'Long Text':
      return `<textarea id="${id}" name="${id}" class="${cls} textarea" rows="3">${v}</textarea>`;

    case 'Date':
      return `<input type="date" id="${id}" name="${id}" class="${cls}" value="${v}">`;

    case 'Number':
      return `<input type="number" id="${id}" name="${id}" class="${cls}" value="${v}" step="any">`;

    case 'Dropdown': {
      const opts = ['', 'Yes', 'No', 'Approved', 'Refused', 'Single', 'Married', 'Common-law', 'Divorced', 'Widowed', 'Separated'];
      const options = opts.map((o) => `<option value="${esc(o)}" ${q.currentAnswer === o ? 'selected' : ''}>${o || 'Select…'}</option>`).join('');
      return `<select id="${id}" name="${id}" class="${cls}">${options}</select>`;
    }

    case 'File Upload':
      return `<p class="file-note">📎 Please email supporting documents to your assigned consultant referencing your case number.</p>`;

    default:
      return `<input type="text" id="${id}" name="${id}" class="${cls}" value="${v}">`;
  }
}

function groupByCategory(items) {
  const map = {};
  items.forEach((item) => {
    const cat = item.category || 'General';
    if (!map[cat]) map[cat] = [];
    map[cat].push(item);
  });

  return CATEGORY_ORDER
    .filter((cat) => map[cat])
    .concat(Object.keys(map).filter((cat) => !CATEGORY_ORDER.includes(cat)))
    .map((cat) => ({ category: cat, items: map[cat] }));
}

// ─── Landing page ─────────────────────────────────────────────────────────────
function landingPage(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Client Questionnaire</title>
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
  <div class="logo">📋</div>
  <h1>Client Questionnaire</h1>
  <p>Please enter your <strong>Case Reference Number</strong> to access and complete your questionnaire.</p>
  ${error ? `<div class="error">⚠️ ${esc(error)}</div>` : ''}
  <form method="GET" action="">
    <label for="caseRef">Case Reference Number</label>
    <input type="text" id="caseRef" name="ref" placeholder="e.g. TDOT-2025-001" autocomplete="off" required>
    <button class="btn" type="submit">Access My Questionnaire →</button>
  </form>
  <p class="hint">If you don't know your case reference, please contact your consultant.</p>
</div>
<script>
  const form = document.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const ref = document.getElementById('caseRef').value.trim();
    if (ref) window.location.href = '/questionnaire/' + encodeURIComponent(ref);
  });
</script>
</body></html>`;
}

// ─── Main questionnaire form ──────────────────────────────────────────────────
function formPage(caseRef, sections) {
  const totalQ   = sections.reduce((s, sec) => s + sec.items.length, 0);
  const answered = sections.reduce((s, sec) => s + sec.items.filter((i) => i.currentAnswer).length, 0);
  const pct      = totalQ ? Math.round((answered / totalQ) * 100) : 0;
  const total    = sections.length;

  // Build step indicator pills
  const stepPills = sections.map((sec, idx) => {
    const icon = CATEGORY_ICONS[sec.category] || '📋';
    return `<button class="step-pill" id="pill_${idx}" onclick="goToStep(${idx})" title="${esc(sec.category)}">
      <span class="pill-num">${idx + 1}</span>
      <span class="pill-label">${icon} ${esc(sec.category)}</span>
    </button>`;
  }).join('');

  // Build all section panels (hidden except active)
  const panels = sections.map((sec, idx) => {
    const secAnswered = sec.items.filter((i) => i.currentAnswer).length;
    const icon = CATEGORY_ICONS[sec.category] || '📋';
    const isLast = idx === total - 1;

    const questionsHtml = sec.items.map((q) => `
      <div class="question" data-item-id="${q.id}">
        <div class="q-header">
          <span class="q-code">${esc(q.questionCode)}</span>
          ${q.required === 'Mandatory' ? '<span class="badge mandatory">Required</span>' : '<span class="badge optional">Optional</span>'}
        </div>
        <label class="q-label" for="ans_${q.id}">${esc(q.name)}</label>
        ${renderInput(q)}
      </div>`).join('');

    return `
    <div class="panel" id="panel_${idx}" style="display:none">
      <div class="panel-header">
        <div class="panel-title">${icon} ${esc(sec.category)}</div>
        <div class="panel-meta" id="pmeta_${idx}">${secAnswered} of ${sec.items.length} answered</div>
      </div>
      <div class="panel-body">${questionsHtml}</div>
      <div class="panel-footer">
        <div class="footer-left">
          <span class="save-msg" id="smsg_${idx}"></span>
        </div>
        <div class="footer-right">
          ${idx > 0 ? `<button class="btn-nav btn-back" onclick="navigate(${idx - 1})">← Back</button>` : ''}
          ${isLast
            ? `<button class="btn-nav btn-save" onclick="saveCurrent(${idx})">💾 Save Section</button>
               <button class="btn-nav btn-submit" onclick="submitAll()">✅ Submit Questionnaire</button>`
            : `<button class="btn-nav btn-next" onclick="navigate(${idx + 1}, true)">Save &amp; Continue →</button>`
          }
        </div>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Questionnaire — ${esc(caseRef)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f4f8;color:#1e293b;min-height:100vh}

/* ── Top bar ── */
.top-bar{background:#1e3a5f;color:#fff;padding:.7rem 1.25rem;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.top-bar-left h1{font-size:1rem;font-weight:700;line-height:1.3}
.top-bar-left .case-ref{font-size:.78rem;opacity:.7;margin-top:.1rem}
.btn-submit-top{background:#10b981;color:#fff;border:none;padding:.45rem 1rem;border-radius:6px;font-weight:600;font-size:.82rem;cursor:pointer;white-space:nowrap}
.btn-submit-top:hover{background:#059669}

/* ── Progress bar ── */
.progress-wrap{background:#1e3a5f;padding:.3rem 1.25rem .75rem;position:sticky;top:52px;z-index:199}
.progress-text{font-size:.72rem;color:rgba(255,255,255,.7);margin-bottom:.3rem}
.progress-track{background:rgba(255,255,255,.18);border-radius:99px;height:5px}
.progress-fill{background:#10b981;height:5px;border-radius:99px;transition:width .4s}

/* ── Step pills ── */
.steps-wrap{background:#fff;border-bottom:1px solid #e2e8f0;position:sticky;top:96px;z-index:198;overflow-x:auto;-webkit-overflow-scrolling:touch}
.steps-inner{display:flex;gap:0;min-width:max-content;padding:0}
.step-pill{display:flex;align-items:center;gap:.4rem;padding:.65rem 1.1rem;border:none;background:transparent;cursor:pointer;font-size:.8rem;color:#64748b;border-bottom:2px solid transparent;transition:all .2s;white-space:nowrap;font-family:inherit}
.step-pill:hover{background:#f8fafc;color:#1e3a5f}
.step-pill.active{color:#1e3a5f;border-bottom-color:#2563eb;font-weight:600;background:#eff6ff}
.step-pill.done{color:#10b981}
.step-pill.done .pill-num{background:#10b981;color:#fff}
.pill-num{width:20px;height:20px;border-radius:50%;background:#e2e8f0;color:#64748b;font-size:.7rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s}
.step-pill.active .pill-num{background:#2563eb;color:#fff}

/* ── Panel ── */
.main{max-width:820px;margin:1.5rem auto;padding:0 1rem 4rem}
.panel{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);overflow:hidden}
.panel-header{padding:1.1rem 1.5rem;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between}
.panel-title{font-size:1.15rem;font-weight:700;color:#1e3a5f}
.panel-meta{font-size:.8rem;color:#64748b;background:#f1f5f9;padding:.2rem .65rem;border-radius:99px}
.panel-body{padding:1.25rem 1.5rem}

/* ── Questions ── */
.question{margin-bottom:1.4rem;padding-bottom:1.4rem;border-bottom:1px solid #f8fafc}
.question:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}
.q-header{display:flex;align-items:center;gap:.5rem;margin-bottom:.35rem}
.q-code{font-size:.7rem;color:#94a3b8;font-family:monospace;letter-spacing:.02em}
.badge{font-size:.65rem;font-weight:700;padding:.15rem .45rem;border-radius:4px;text-transform:uppercase;letter-spacing:.04em}
.badge.mandatory{background:#fef2f2;color:#dc2626}
.badge.optional{background:#f0fdf4;color:#16a34a}
.q-label{display:block;font-size:.9rem;font-weight:500;color:#374151;margin-bottom:.45rem;line-height:1.5}
.form-input{width:100%;padding:.6rem .9rem;border:1.5px solid #d1d5db;border-radius:8px;font-size:.9rem;font-family:inherit;outline:none;transition:border .2s,box-shadow .2s;background:#fff;color:#1e293b}
.form-input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.textarea{resize:vertical;min-height:80px}
.file-note{font-size:.82rem;color:#64748b;background:#f8fafc;padding:.6rem .9rem;border-radius:8px;border:1px dashed #cbd5e1;line-height:1.4}

/* ── Footer nav ── */
.panel-footer{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem;border-top:1px solid #f1f5f9;background:#fafbfc;gap:.75rem;flex-wrap:wrap}
.footer-left{flex:1;min-width:0}
.footer-right{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.save-msg{font-size:.82rem;color:#10b981}
.btn-nav{padding:.6rem 1.3rem;border:none;border-radius:8px;font-size:.88rem;font-weight:600;cursor:pointer;transition:background .2s,opacity .2s;font-family:inherit}
.btn-back{background:#f1f5f9;color:#475569}
.btn-back:hover{background:#e2e8f0}
.btn-save{background:#1e3a5f;color:#fff}
.btn-save:hover{background:#2563eb}
.btn-next{background:#2563eb;color:#fff}
.btn-next:hover{background:#1d4ed8}
.btn-submit{background:#10b981;color:#fff}
.btn-submit:hover{background:#059669}
.btn-nav:disabled{opacity:.5;cursor:not-allowed}

/* ── Toast ── */
.toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#1e293b;color:#fff;padding:.75rem 1.1rem;border-radius:8px;font-size:.88rem;box-shadow:0 4px 18px rgba(0,0,0,.2);opacity:0;transform:translateY(6px);transition:all .3s;pointer-events:none;z-index:999;max-width:280px}
.toast.show{opacity:1;transform:translateY(0)}
.toast.success{background:#10b981}
.toast.error{background:#dc2626}

/* ── Success screen ── */
.success-panel{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;padding:3.5rem 2rem}
.success-panel .s-icon{font-size:3.5rem;margin-bottom:1rem}
.success-panel h2{color:#10b981;font-size:1.6rem;margin-bottom:.6rem}
.success-panel p{color:#64748b;font-size:.95rem;line-height:1.6}

@media(max-width:600px){
  .top-bar{flex-wrap:wrap;gap:.4rem}
  .panel-header{flex-direction:column;align-items:flex-start;gap:.35rem}
  .panel-body{padding:1rem}
  .panel-footer{padding:.85rem 1rem}
  .footer-right{width:100%;justify-content:flex-end}
  .main{padding:0 .5rem 4rem}
}
</style>
</head>
<body>

<!-- Top bar -->
<div class="top-bar">
  <div class="top-bar-left">
    <h1>📋 Client Questionnaire</h1>
    <div class="case-ref">Case: ${esc(caseRef)}</div>
  </div>
  <button class="btn-submit-top" onclick="submitAll()">✓ Submit All</button>
</div>

<!-- Progress -->
<div class="progress-wrap">
  <div class="progress-text" id="progressLabel">${answered} of ${totalQ} questions answered (${pct}%)</div>
  <div class="progress-track"><div class="progress-fill" id="progressFill" style="width:${pct}%"></div></div>
</div>

<!-- Step pills -->
<div class="steps-wrap">
  <div class="steps-inner" id="stepsInner">${stepPills}</div>
</div>

<!-- Panels -->
<div class="main" id="mainContent">
  ${panels}
</div>

<div class="toast" id="toast"></div>

<script>
const CASE_REF = ${JSON.stringify(caseRef)};
const TOTAL    = ${total};
let currentStep = 0;
let totalQ     = ${totalQ};

// ── Init ───────────────────────────────────────────────────────────────────
function goToStep(idx) {
  document.getElementById('panel_' + currentStep).style.display = 'none';
  currentStep = idx;
  const panel = document.getElementById('panel_' + idx);
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  updateStepPills();
}

function updateStepPills() {
  for (let i = 0; i < TOTAL; i++) {
    const pill = document.getElementById('pill_' + i);
    pill.classList.remove('active', 'done');
    if (i === currentStep) pill.classList.add('active');
    else if (i < currentStep) pill.classList.add('done');
  }
  // Scroll the active pill into view
  const activePill = document.getElementById('pill_' + currentStep);
  if (activePill) activePill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

// Show first panel on load
goToStep(0);

// ── Progress ───────────────────────────────────────────────────────────────
function updateProgress() {
  let count = 0;
  document.querySelectorAll('.form-input').forEach(inp => {
    if (inp.value && inp.value.trim()) count++;
  });
  const pct = totalQ ? Math.round((count / totalQ) * 100) : 0;
  document.getElementById('progressLabel').textContent = count + ' of ' + totalQ + ' questions answered (' + pct + '%)';
  document.getElementById('progressFill').style.width = pct + '%';
}

function updatePanelMeta(idx) {
  const panel = document.getElementById('panel_' + idx);
  if (!panel) return;
  const inputs = panel.querySelectorAll('.form-input');
  let a = 0;
  inputs.forEach(inp => { if (inp.value && inp.value.trim()) a++; });
  const meta = document.getElementById('pmeta_' + idx);
  if (meta) meta.textContent = a + ' of ' + inputs.length + ' answered';
}

document.querySelectorAll('.form-input').forEach(inp => {
  inp.addEventListener('input', () => { updateProgress(); updatePanelMeta(currentStep); });
});

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.className = 'toast', 3500);
}

// ── Save current section ───────────────────────────────────────────────────
async function saveCurrent(idx, silent = false) {
  const panel = document.getElementById('panel_' + idx);
  const msg   = document.getElementById('smsg_' + idx);

  const answers = [];
  panel.querySelectorAll('.question').forEach(q => {
    const itemId = q.dataset.itemId;
    const inp    = q.querySelector('.form-input');
    if (itemId && inp) answers.push({ itemId, answer: inp.value });
  });

  if (!answers.length) return true;

  const saveBtn = panel.querySelector('.btn-save, .btn-next');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  if (msg) msg.textContent = '';

  try {
    const res = await fetch('/questionnaire/' + encodeURIComponent(CASE_REF) + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    const data = await res.json();
    if (data.success) {
      if (msg) msg.textContent = '✓ ' + data.saved + ' answers saved';
      if (!silent) showToast('Section saved!');
      return true;
    } else {
      if (msg) msg.textContent = '⚠ Save failed. Please try again.';
      showToast('Save failed', 'error');
      return false;
    }
  } catch (e) {
    if (msg) msg.textContent = '⚠ Network error.';
    showToast('Network error', 'error');
    return false;
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = saveBtn.classList.contains('btn-next') ? 'Save & Continue →' : '💾 Save Section';
    }
  }
}

// ── Navigate (save then move) ──────────────────────────────────────────────
async function navigate(targetIdx, saveFirst = false) {
  if (saveFirst) {
    await saveCurrent(currentStep, true);
  }
  goToStep(targetIdx);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Submit all ─────────────────────────────────────────────────────────────
async function submitAll() {
  // Save current section first
  await saveCurrent(currentStep, true);

  if (!confirm('Are you sure you want to submit your questionnaire? Your consultant will be notified.')) return;

  const btns = document.querySelectorAll('.btn-submit-top, .btn-submit');
  btns.forEach(b => { b.disabled = true; b.textContent = 'Submitting…'; });

  try {
    const res = await fetch('/questionnaire/' + encodeURIComponent(CASE_REF) + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('mainContent').innerHTML = \`
        <div class="success-panel">
          <div class="s-icon">🎉</div>
          <h2>Questionnaire Submitted!</h2>
          <p>Thank you. Your responses have been submitted to your consultant.<br><br>
             <strong>Case Reference: \${CASE_REF}</strong><br><br>
             You will be contacted if any clarification is needed.</p>
        </div>\`;
      document.querySelector('.steps-wrap').style.display = 'none';
      document.querySelector('.progress-wrap').style.display = 'none';
    } else {
      showToast('Submission failed. Please try again.', 'error');
      btns.forEach(b => { b.disabled = false; b.textContent = '✅ Submit Questionnaire'; });
    }
  } catch (e) {
    showToast('Network error. Please try again.', 'error');
    btns.forEach(b => { b.disabled = false; });
  }
}
</script>
</body></html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /questionnaire  — landing page
router.get('/', (req, res) => {
  const error = req.query.error || '';
  res.send(landingPage(error));
});

// GET /questionnaire/:caseRef  — questionnaire form
router.get('/:caseRef', async (req, res) => {
  const caseRef = decodeURIComponent(req.params.caseRef).trim();

  try {
    const items = await getCaseItems(caseRef);
    if (!items.length) {
      return res.redirect(`/questionnaire?error=${encodeURIComponent(`No questionnaire found for case "${caseRef}". Please check your case reference number.`)}`);
    }

    const sections = groupByCategory(items);
    res.send(formPage(caseRef, sections));
  } catch (err) {
    console.error('[QuestionnaireForm] Error loading form:', err.message);
    res.status(500).send(landingPage('An error occurred. Please try again later.'));
  }
});

// POST /questionnaire/:caseRef/save  — save section answers
router.post('/:caseRef/save', async (req, res) => {
  const caseRef = decodeURIComponent(req.params.caseRef).trim();
  const { answers } = req.body;

  if (!answers || !Array.isArray(answers)) {
    return res.status(400).json({ success: false, error: 'Invalid payload' });
  }

  try {
    const result = await saveAnswers(answers);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[QuestionnaireForm] Save error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /questionnaire/:caseRef/submit  — mark questionnaire as submitted
router.post('/:caseRef/submit', async (req, res) => {
  const caseRef = decodeURIComponent(req.params.caseRef).trim();

  try {
    const result = await submitQuestionnaire(caseRef);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[QuestionnaireForm] Submit error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
