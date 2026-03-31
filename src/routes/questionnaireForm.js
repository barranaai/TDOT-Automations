const express = require('express');
const router  = express.Router();
const { getCaseItems, saveAnswers, submitQuestionnaire } = require('../services/questionnaireFormService');
const { updateLastActivityDate } = require('../services/clientMasterService');
const { calculateForCaseRef }   = require('../services/caseReadinessService');

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
    <h1>Client Questionnaire</h1>
    <p>Enter your <strong>Case Reference Number</strong> to access and complete your questionnaire.</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form method="GET" action="">
      <label for="caseRef">Case Reference Number</label>
      <input type="text" id="caseRef" name="ref" placeholder="e.g. 2026-SP-001" autocomplete="off" required>
      <button class="btn" type="submit">Access My Questionnaire →</button>
    </form>
    <p class="hint">Don't know your case reference? Contact your consultant.</p>
  </div>
  <div class="card-footer">TDOT Immigration &nbsp;·&nbsp; Secure Client Portal</div>
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

  // Find the first section containing a flagged question and total flagged count
  let firstFlaggedStep = -1;
  let flaggedCount = 0;
  sections.forEach((sec, idx) => {
    const flagged = sec.items.filter((i) => i.responseStatus === 'Needs Clarification');
    flaggedCount += flagged.length;
    if (firstFlaggedStep === -1 && flagged.length > 0) firstFlaggedStep = idx;
  });

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

    const questionsHtml = sec.items.map((q) => {
      const needsAction = q.responseStatus === 'Needs Clarification';
      return `
      <div class="question${needsAction ? ' needs-action' : ''}" data-item-id="${q.id}">
        <div class="q-header">
          <span class="q-code">${esc(q.questionCode)}</span>
          ${needsAction ? '<span class="badge action-required">⚠️ Action Required</span>' : (q.required === 'Mandatory' ? '<span class="badge mandatory">Required</span>' : '<span class="badge optional">Optional</span>')}
        </div>
        <label class="q-label" for="ans_${q.id}">${esc(q.name)}</label>
        ${needsAction && q.reviewNotes ? `<div class="q-review-note">📋 <strong>Officer note:</strong> ${esc(q.reviewNotes)}</div>` : ''}
        ${!needsAction && q.helpText ? `<div class="q-help">💡 ${esc(q.helpText)}</div>` : ''}
        ${renderInput(q)}
      </div>`;
    }).join('');

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
:root{--brand:rgb(143,5,5);--brand-dark:#6d0404;--brand-faint:rgba(143,5,5,.07)}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;background:#e8e8e8;color:#111;min-height:100vh}

/* ── Top bar ── */
.top-bar{background:#1a1a1a;color:#fff;padding:.65rem 1.5rem;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:0 2px 16px rgba(0,0,0,.45)}
.top-bar-brand{display:flex;align-items:center;gap:.85rem}
.top-bar-logo{height:30px;object-fit:contain;flex-shrink:0}
.top-bar-divider{width:1px;height:22px;background:rgba(255,255,255,.15);flex-shrink:0}
.top-bar-info h1{font-size:.88rem;font-weight:700;color:#fff;line-height:1.3}
.top-bar-info .case-ref{font-size:.7rem;color:rgba(255,255,255,.42);margin-top:.08rem}
.btn-submit-top{background:var(--brand);color:#fff;border:none;padding:.42rem 1rem;border-radius:7px;font-weight:700;font-size:.77rem;cursor:pointer;white-space:nowrap;letter-spacing:.02em;transition:background .2s;flex-shrink:0}
.btn-submit-top:hover{background:var(--brand-dark)}

/* ── Progress bar ── */
.progress-wrap{background:#111;padding:.3rem 1.5rem .65rem;position:sticky;top:52px;z-index:199}
.progress-text{font-size:.67rem;color:rgba(255,255,255,.42);margin-bottom:.3rem;letter-spacing:.02em}
.progress-track{background:rgba(255,255,255,.13);border-radius:99px;height:3px}
.progress-fill{background:var(--brand);height:3px;border-radius:99px;transition:width .45s}

/* ── Step pills ── */
.steps-wrap{background:#fff;border-bottom:1px solid #e8e8e8;position:sticky;top:90px;z-index:198;overflow-x:auto;-webkit-overflow-scrolling:touch}
.steps-inner{display:flex;min-width:max-content}
.step-pill{display:flex;align-items:center;gap:.4rem;padding:.62rem 1.1rem;border:none;background:transparent;cursor:pointer;font-size:.77rem;color:#777;border-bottom:2.5px solid transparent;transition:all .2s;white-space:nowrap;font-family:inherit}
.step-pill:hover{background:#fafafa;color:#111}
.step-pill.active{color:var(--brand);border-bottom-color:var(--brand);font-weight:600;background:var(--brand-faint)}
.step-pill.done{color:#059669}
.step-pill.done .pill-num{background:#059669;color:#fff}
.pill-num{width:19px;height:19px;border-radius:50%;background:#e8e8e8;color:#777;font-size:.67rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s}
.step-pill.active .pill-num{background:var(--brand);color:#fff}

/* ── Panel ── */
.main{max-width:800px;margin:1.5rem auto;padding:0 1rem 4rem}
.panel{background:#fff;border-radius:14px;box-shadow:0 2px 16px rgba(0,0,0,.07);overflow:hidden}
.panel-header{padding:1.1rem 1.5rem;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between}
.panel-title{font-size:1.08rem;font-weight:700;color:#111}
.panel-meta{font-size:.76rem;color:#888;background:#f3f3f3;padding:.2rem .65rem;border-radius:99px}
.panel-body{padding:1.25rem 1.5rem}

/* ── Questions ── */
.question{margin-bottom:1.4rem;padding-bottom:1.4rem;border-bottom:1px solid #f3f3f3}
.question:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}
.q-header{display:flex;align-items:center;gap:.5rem;margin-bottom:.35rem;flex-wrap:wrap}
.q-code{font-size:.67rem;color:#c0c0c0;font-family:monospace;letter-spacing:.04em}
.badge{font-size:.62rem;font-weight:700;padding:.15rem .5rem;border-radius:5px;text-transform:uppercase;letter-spacing:.05em}
.badge.mandatory{background:#fff0f0;color:#9b1c1c}
.badge.optional{background:#f0fdf4;color:#15803d}
.q-label{display:block;font-size:.9rem;font-weight:500;color:#222;margin-bottom:.35rem;line-height:1.55}
.q-help{font-size:.79rem;color:#555;background:#f7f7f7;padding:.35rem .65rem;border-radius:7px;margin-bottom:.45rem;line-height:1.5;border-left:3px solid #ddd}
.needs-action{border:2px solid #f97316!important;background:#fffbf5!important;border-radius:12px;padding:.85rem 1rem!important}
.needs-action .q-label{color:#c2410c}
.q-review-note{font-size:.8rem;color:#9a3412;background:#fff7ed;padding:.4rem .7rem;border-radius:7px;margin-bottom:.45rem;line-height:1.5;border-left:3px solid #fb923c}
.badge.action-required{background:#fff7ed;color:#ea580c;border:1px solid #fed7aa}
.form-input{width:100%;padding:.62rem .9rem;border:1.5px solid #ddd;border-radius:9px;font-size:.9rem;font-family:inherit;outline:none;transition:border-color .2s,box-shadow .2s;background:#fff;color:#111}
.form-input:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-faint)}
.textarea{resize:vertical;min-height:80px;line-height:1.55}
.file-note{font-size:.8rem;color:#888;background:#f9f9f9;padding:.6rem .9rem;border-radius:9px;border:1.5px dashed #e0e0e0;line-height:1.4}

/* ── Footer nav ── */
.panel-footer{display:flex;align-items:center;justify-content:space-between;padding:.95rem 1.5rem;border-top:1px solid #f0f0f0;background:#fafafa;gap:.75rem;flex-wrap:wrap}
.footer-left{flex:1;min-width:0}
.footer-right{display:flex;gap:.55rem;align-items:center;flex-wrap:wrap}
.save-msg{font-size:.79rem;color:#059669;font-weight:500}
.btn-nav{padding:.58rem 1.25rem;border:none;border-radius:8px;font-size:.85rem;font-weight:600;cursor:pointer;transition:all .2s;font-family:inherit}
.btn-back{background:#f0f0f0;color:#444}
.btn-back:hover{background:#e4e4e4}
.btn-save{background:#1a1a1a;color:#fff}
.btn-save:hover{background:#333}
.btn-next{background:var(--brand);color:#fff}
.btn-next:hover{background:var(--brand-dark)}
.btn-submit{background:#059669;color:#fff}
.btn-submit:hover{background:#047857}
.btn-nav:disabled{opacity:.45;cursor:not-allowed}

/* ── Toast ── */
.toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#1a1a1a;color:#fff;padding:.72rem 1.1rem;border-radius:9px;font-size:.85rem;box-shadow:0 4px 22px rgba(0,0,0,.28);opacity:0;transform:translateY(6px);transition:all .3s;pointer-events:none;z-index:999;max-width:280px}
.toast.show{opacity:1;transform:translateY(0)}
.toast.success{background:#059669}
.toast.error{background:var(--brand)}

/* ── Success screen ── */
.success-panel{background:#fff;border-radius:14px;box-shadow:0 2px 16px rgba(0,0,0,.07);text-align:center;padding:3.5rem 2rem}
.success-panel .s-icon{font-size:3rem;margin-bottom:1rem}
.success-panel h2{color:#059669;font-size:1.5rem;margin-bottom:.6rem;font-weight:700}
.success-panel p{color:#666;font-size:.93rem;line-height:1.65}

.step-pill.flagged{border-color:#f59e0b!important;color:#92400e!important}
.step-pill.flagged .pill-num{background:#f59e0b!important}
.flagged-banner{display:flex;align-items:center;gap:1rem;background:#fff3cd;border:1.5px solid #f59e0b;border-radius:10px;padding:.85rem 1.2rem;margin:0 auto 1rem;max-width:900px;width:calc(100% - 2rem)}
.flagged-banner-icon{font-size:1.3rem;flex-shrink:0}
.flagged-banner-text{flex:1;font-size:.88rem;color:#92400e;line-height:1.5}
.flagged-banner-text strong{color:#78350f}
.flagged-banner-btn{flex-shrink:0;background:#f59e0b;color:#fff;border:none;border-radius:6px;padding:.45rem .9rem;font-size:.82rem;font-weight:600;cursor:pointer;white-space:nowrap}
.flagged-banner-btn:hover{background:#d97706}

@media(max-width:600px){
  .top-bar{padding:.6rem 1rem;gap:.5rem}
  .top-bar-divider{display:none}
  .panel-header{flex-direction:column;align-items:flex-start;gap:.35rem}
  .panel-body{padding:1rem}
  .panel-footer{padding:.8rem 1rem}
  .footer-right{width:100%;justify-content:flex-end}
  .main{padding:0 .5rem 4rem}
  .flagged-banner{flex-wrap:wrap;gap:.6rem}
  .flagged-banner-btn{width:100%}
}
</style>
</head>
<body>

<!-- Top bar -->
<div class="top-bar">
  <div class="top-bar-brand">
    <img src="https://tdotimm.com/_next/image?url=%2Ftdot_logo_inv.webp&w=128&q=75" alt="TDOT Immigration" class="top-bar-logo">
    <div class="top-bar-divider"></div>
    <div class="top-bar-info">
      <h1>Client Questionnaire</h1>
      <div class="case-ref">Case Ref: ${esc(caseRef)}</div>
    </div>
  </div>
  <button class="btn-submit-top" onclick="submitAll()">Submit All</button>
</div>

<!-- Flagged items alert banner -->
${flaggedCount > 0 ? `
<div class="flagged-banner" id="flaggedBanner">
  <span class="flagged-banner-icon">⚠️</span>
  <span class="flagged-banner-text">
    <strong>${flaggedCount} question${flaggedCount !== 1 ? 's' : ''} need${flaggedCount === 1 ? 's' : ''} your attention.</strong>
    Our case officer has left notes — please review and update your answers.
  </span>
  <button class="flagged-banner-btn" onclick="jumpToFirstFlagged()">Review Now →</button>
</div>` : ''}

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
const CASE_REF          = ${JSON.stringify(caseRef)};
const TOTAL             = ${total};
const FIRST_FLAGGED     = ${firstFlaggedStep};   // -1 if no flagged items
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
    pill.classList.remove('active', 'done', 'flagged');
    if (i === currentStep) pill.classList.add('active');
    else if (i < currentStep) pill.classList.add('done');
  }
  // Mark pills that contain flagged items
  document.querySelectorAll('.step-pill').forEach((pill, i) => {
    const panel = document.getElementById('panel_' + i);
    if (panel && panel.querySelector('.needs-action')) pill.classList.add('flagged');
  });
  // Scroll the active pill into view
  const activePill = document.getElementById('pill_' + currentStep);
  if (activePill) activePill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

// Jump to first flagged question (called by banner button and on load)
function jumpToFirstFlagged() {
  if (FIRST_FLAGGED === -1) return;
  goToStep(FIRST_FLAGGED);
  // After the panel is visible, scroll to the first flagged question within it
  setTimeout(() => {
    const firstFlagged = document.querySelector('#panel_' + FIRST_FLAGGED + ' .needs-action');
    if (firstFlagged) {
      firstFlagged.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight pulse to draw the eye
      firstFlagged.style.transition = 'box-shadow .3s';
      firstFlagged.style.boxShadow = '0 0 0 3px rgba(239,68,68,.5)';
      setTimeout(() => { firstFlagged.style.boxShadow = ''; }, 1800);
    }
  }, 350);
}

// On load: jump to first flagged section if any, otherwise show step 0
if (FIRST_FLAGGED !== -1) {
  jumpToFirstFlagged();
} else {
  goToStep(0);
}

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
    // Non-blocking post-save: update activity date + recalculate readiness
    updateLastActivityDate(caseRef).catch(() => {});
    calculateForCaseRef(caseRef).catch(() => {});
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
