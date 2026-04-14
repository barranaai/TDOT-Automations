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
      return `<textarea id="${id}" name="${id}" class="${cls} textarea" rows="6">${v}</textarea>`;

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
      // All questions use a textarea so clients have enough room to answer fully
      return `<textarea id="${id}" name="${id}" class="${cls} textarea" rows="3">${v}</textarea>`;
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
:root{--brand:#8f0505;--brand-dark:#6d0404;--brand-faint:rgba(143,5,5,.07)}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;background:#eceef1;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#fff;border-radius:18px;box-shadow:0 8px 40px rgba(0,0,0,.14),0 2px 10px rgba(0,0,0,.06);width:100%;max-width:420px;overflow:hidden;text-align:center;border:1px solid #e5e7eb}
.card-header{background:#1a1a1a;padding:1.8rem 2rem 1.65rem;display:flex;flex-direction:column;align-items:center;gap:.55rem;border-bottom:2px solid var(--brand)}
.logo-img{height:38px;object-fit:contain}
.brand-sub{font-size:.63rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.35);font-weight:600}
.card-body{padding:2rem 2.25rem 2.1rem}
h1{font-size:1.18rem;color:#111;margin-bottom:.45rem;font-weight:800;letter-spacing:-.01em}
.card-body>p{color:#6b7280;font-size:.88rem;margin-bottom:1.7rem;line-height:1.7}
label{display:block;text-align:left;font-size:.78rem;font-weight:700;color:#374151;margin-bottom:.42rem;letter-spacing:.02em;text-transform:uppercase}
input[type=text]{width:100%;padding:.76rem 1rem;border:1.5px solid #e5e7eb;border-radius:10px;font-size:.93rem;outline:none;transition:border-color .2s,box-shadow .2s;color:#111;background:#fff;font-family:inherit}
input[type=text]:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-faint)}
.btn{display:block;width:100%;margin-top:1.1rem;padding:.84rem;background:var(--brand);color:#fff;font-size:.91rem;font-weight:700;border:none;border-radius:10px;cursor:pointer;transition:background .2s,transform .12s;letter-spacing:.02em;font-family:inherit}
.btn:hover{background:var(--brand-dark);transform:translateY(-1px)}
.btn:active{transform:translateY(0)}
.error{background:#fef2f2;border:1.5px solid #fecaca;color:#9b1c1c;padding:.75rem 1rem;border-radius:10px;margin-bottom:1.2rem;font-size:.84rem;text-align:left;line-height:1.55}
.hint{font-size:.74rem;color:#9ca3af;margin-top:1.1rem;line-height:1.6}
.card-footer{padding:.85rem;background:#f9fafb;border-top:1px solid #f3f4f6;font-size:.65rem;color:#d1d5db;letter-spacing:.08em;text-transform:uppercase;font-weight:500}
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
          ${needsAction ? '<span class="badge action-required">⚠️ Action Required</span>' : ''}
        </div>
        <label class="q-label" for="ans_${q.id}">${esc(q.name)}</label>
        ${needsAction ? `
        <div class="q-review-note">
          <div class="q-review-note-header">💬 Feedback from your case officer</div>
          <div class="q-review-note-body">${q.reviewNotes ? esc(q.reviewNotes) : 'Please review and update your answer for this question.'}</div>
        </div>` : ''}
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
:root{
  --brand:#8f0505;--brand-dark:#6d0404;--brand-faint:rgba(143,5,5,.06);
  --green:#059669;--green-bg:#ecfdf5;
  --amber:#b45309;--amber-bg:#fffbeb;--amber-border:#fde68a;
  --orange:#ea580c;--orange-bg:#fff7ed;--orange-border:#fed7aa;
  --red:#dc2626;--red-bg:#fef2f2;--red-border:#fecaca;
  --gray-50:#f9fafb;--gray-100:#f3f4f6;--gray-200:#e5e7eb;--gray-300:#d1d5db;
  --gray-400:#9ca3af;--gray-500:#6b7280;--gray-600:#4b5563;--gray-700:#374151;--gray-900:#111827;
  --shadow-md:0 4px 20px rgba(0,0,0,.08),0 2px 8px rgba(0,0,0,.04);
  --radius:14px;--radius-sm:9px;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;background:#eceef1;color:var(--gray-900);min-height:100vh;line-height:1.5}

/* ── Top bar ── */
.top-bar{background:#1a1a1a;color:#fff;padding:.7rem 1.6rem;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:0 2px 20px rgba(0,0,0,.5);border-bottom:2px solid var(--brand)}
.top-bar-brand{display:flex;align-items:center;gap:.9rem}
.top-bar-logo{height:30px;object-fit:contain;flex-shrink:0}
.top-bar-divider{width:1px;height:24px;background:rgba(255,255,255,.14);flex-shrink:0}
.top-bar-info h1{font-size:.9rem;font-weight:700;color:#fff;line-height:1.3;letter-spacing:.01em}
.top-bar-info .case-ref{font-size:.68rem;color:rgba(255,255,255,.38);margin-top:.1rem;letter-spacing:.04em;text-transform:uppercase}
.btn-submit-top{background:var(--brand);color:#fff;border:none;padding:.44rem 1.05rem;border-radius:var(--radius-sm);font-weight:700;font-size:.76rem;cursor:pointer;white-space:nowrap;letter-spacing:.02em;transition:background .18s;flex-shrink:0;font-family:inherit}
.btn-submit-top:hover{background:var(--brand-dark)}

/* ── Progress bar ── */
.progress-wrap{background:#141414;padding:.35rem 1.6rem .7rem;position:sticky;top:54px;z-index:199}
.progress-text{font-size:.66rem;color:rgba(255,255,255,.38);margin-bottom:.32rem;letter-spacing:.04em;text-transform:uppercase}
.progress-track{background:rgba(255,255,255,.1);border-radius:99px;height:4px}
.progress-fill{background:linear-gradient(90deg,var(--brand),#c0392b);height:4px;border-radius:99px;transition:width .5s ease}

/* ── Step pills ── */
.steps-wrap{background:#fff;border-bottom:1px solid var(--gray-200);position:sticky;top:96px;z-index:198;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.steps-wrap::-webkit-scrollbar{display:none}
.steps-inner{display:flex;min-width:max-content;padding:0 .5rem}
.step-pill{display:flex;align-items:center;gap:.45rem;padding:.68rem 1rem;border:none;background:transparent;cursor:pointer;font-size:.76rem;color:var(--gray-400);border-bottom:2.5px solid transparent;transition:all .18s;white-space:nowrap;font-family:inherit;font-weight:500}
.step-pill:hover{color:var(--gray-700);background:var(--gray-50)}
.step-pill.active{color:var(--brand);border-bottom-color:var(--brand);font-weight:700;background:var(--brand-faint)}
.step-pill.done{color:var(--green)}
.step-pill.done .pill-num{background:var(--green);color:#fff}
.step-pill.flagged{color:var(--amber);border-bottom-color:var(--amber-border)!important}
.step-pill.flagged .pill-num{background:var(--amber-bg);color:var(--amber);border:1.5px solid var(--amber-border)}
.pill-num{width:20px;height:20px;border-radius:50%;background:var(--gray-200);color:var(--gray-500);font-size:.66rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .18s}
.step-pill.active .pill-num{background:var(--brand);color:#fff}

/* ── Main layout ── */
.main{max-width:820px;margin:1.5rem auto;padding:0 1.1rem 5rem}

/* ── Panel / Card ── */
.panel{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow-md);overflow:hidden;border:1px solid var(--gray-200)}
.panel-header{padding:1.15rem 1.6rem;border-bottom:1px solid var(--gray-100);display:flex;align-items:center;justify-content:space-between;background:var(--gray-50)}
.panel-title{font-size:1.05rem;font-weight:700;color:var(--gray-900)}
.panel-meta{font-size:.72rem;color:var(--gray-500);background:var(--gray-200);padding:.2rem .7rem;border-radius:99px;font-weight:500}
.panel-body{padding:1.35rem 1.6rem}

/* ── Questions ── */
.question{margin-bottom:1.5rem;padding-bottom:1.5rem;border-bottom:1px solid var(--gray-100)}
.question:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}
.q-header{display:flex;align-items:center;gap:.45rem;margin-bottom:.35rem;flex-wrap:wrap}
.q-code{font-size:.65rem;color:var(--gray-400);font-family:'SF Mono',SFMono-Regular,Consolas,monospace;letter-spacing:.06em;background:var(--gray-100);padding:.1rem .38rem;border-radius:4px}
.badge{font-size:.6rem;font-weight:700;padding:.15rem .52rem;border-radius:5px;text-transform:uppercase;letter-spacing:.06em}
.badge.action-required{background:var(--orange-bg);color:var(--orange);border:1px solid var(--orange-border)}
.q-label{display:block;font-size:.92rem;font-weight:600;color:var(--gray-800, #1f2937);margin-bottom:.4rem;line-height:1.55}
.q-help{font-size:.79rem;color:#92400e;background:var(--amber-bg);border:1px solid var(--amber-border);border-left:3px solid #f59e0b;padding:.45rem .7rem;border-radius:var(--radius-sm);margin-bottom:.5rem;line-height:1.55;white-space:pre-line}
.needs-action{border:2px solid #f87171!important;background:#fef2f2!important;border-radius:12px;padding:.9rem 1.1rem!important;box-shadow:0 2px 12px rgba(220,38,38,.12)}
.needs-action .q-label{color:#dc2626;font-weight:700}
.q-review-note{background:var(--red-bg);border:1px solid var(--red-border);border-left:4px solid var(--red);border-radius:var(--radius-sm);overflow:hidden;margin-bottom:.65rem;margin-top:.15rem}
.q-review-note-header{font-size:.71rem;font-weight:700;color:#991b1b;padding:.35rem .75rem;background:#fee2e2;border-bottom:1px solid var(--red-border);letter-spacing:.03em;text-transform:uppercase}
.q-review-note-body{font-size:.84rem;color:#7f1d1d;padding:.45rem .75rem;line-height:1.55;white-space:pre-wrap}
.form-input{width:100%;padding:.65rem .95rem;border:1.5px solid var(--gray-200);border-radius:var(--radius-sm);font-size:.9rem;font-family:inherit;outline:none;transition:border-color .18s,box-shadow .18s;background:#fff;color:var(--gray-900)}
.form-input:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-faint)}
.textarea{resize:vertical;min-height:88px;line-height:1.6}
select.form-input{cursor:pointer}
.file-note{font-size:.8rem;color:var(--gray-500);background:var(--gray-50);padding:.65rem .95rem;border-radius:var(--radius-sm);border:1.5px dashed var(--gray-300);line-height:1.5}

/* ── Footer nav ── */
.panel-footer{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.6rem;border-top:1px solid var(--gray-100);background:var(--gray-50);gap:.75rem;flex-wrap:wrap}
.footer-left{flex:1;min-width:0}
.footer-right{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.save-msg{font-size:.78rem;color:var(--green);font-weight:600}
.btn-nav{padding:.58rem 1.3rem;border:none;border-radius:var(--radius-sm);font-size:.84rem;font-weight:600;cursor:pointer;transition:all .18s;font-family:inherit;letter-spacing:.01em}
.btn-back{background:var(--gray-200);color:var(--gray-600)}
.btn-back:hover{background:var(--gray-300)}
.btn-save{background:#1a1a1a;color:#fff}
.btn-save:hover{background:#2d2d2d}
.btn-next{background:var(--brand);color:#fff;box-shadow:0 2px 8px rgba(143,5,5,.25)}
.btn-next:hover{background:var(--brand-dark)}
.btn-submit{background:var(--green);color:#fff;box-shadow:0 2px 8px rgba(5,150,105,.2)}
.btn-submit:hover{background:#047857}
.btn-nav:disabled{opacity:.45;cursor:not-allowed}

/* ── Toast ── */
.toast{position:fixed;bottom:1.6rem;right:1.6rem;background:#1e1e1e;color:#fff;padding:.75rem 1.15rem;border-radius:10px;font-size:.84rem;box-shadow:0 6px 28px rgba(0,0,0,.28);opacity:0;transform:translateY(8px);transition:all .28s ease;pointer-events:none;z-index:999;max-width:290px;font-weight:500}
.toast.show{opacity:1;transform:translateY(0)}
.toast.success{background:var(--green)}
.toast.error{background:var(--brand)}

/* ── Success screen ── */
.success-panel{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow-md);text-align:center;padding:4rem 2rem;border:1px solid var(--gray-200)}
.success-panel .s-icon{font-size:3.5rem;margin-bottom:1.1rem;display:block}
.success-panel h2{color:var(--green);font-size:1.55rem;margin-bottom:.65rem;font-weight:800}
.success-panel p{color:var(--gray-500);font-size:.93rem;line-height:1.7}

/* ── Flagged banner ── */
.flagged-banner{display:flex;align-items:center;gap:.9rem;background:var(--amber-bg);border:1.5px solid var(--amber-border);border-left:4px solid #f59e0b;border-radius:var(--radius-sm);padding:.95rem 1.2rem;margin:1rem auto;max-width:820px;width:calc(100% - 2.2rem);flex-wrap:wrap}
.flagged-banner-icon{font-size:1.4rem;flex-shrink:0}
.flagged-banner-text{flex:1;font-size:.84rem;color:#78350f;line-height:1.55}
.flagged-banner-text strong{color:#78350f}
.flagged-banner-btn{flex-shrink:0;background:#d97706;color:#fff;border:none;border-radius:var(--radius-sm);padding:.44rem 1.05rem;font-size:.8rem;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit;transition:background .18s}
.flagged-banner-btn:hover{background:#b45309}

/* ── Responsive ── */
@media(max-width:600px){
  .top-bar{padding:.65rem 1rem;gap:.5rem}
  .top-bar-divider{display:none}
  .panel-header{flex-direction:column;align-items:flex-start;gap:.35rem}
  .panel-body{padding:1.1rem}
  .panel-footer{padding:.85rem 1rem}
  .footer-right{width:100%;justify-content:flex-end}
  .main{padding:0 .6rem 5rem}
  .flagged-banner{gap:.6rem;width:calc(100% - 1.2rem)}
  .flagged-banner-btn{width:100%;text-align:center}
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
