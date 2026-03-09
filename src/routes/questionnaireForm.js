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
  const totalQ    = sections.reduce((s, sec) => s + sec.items.length, 0);
  const answered  = sections.reduce((s, sec) => s + sec.items.filter((i) => i.currentAnswer).length, 0);
  const pct       = totalQ ? Math.round((answered / totalQ) * 100) : 0;

  const sectionsHtml = sections.map((sec, idx) => {
    const secAnswered = sec.items.filter((i) => i.currentAnswer).length;
    const icon = CATEGORY_ICONS[sec.category] || '📋';
    const catId = sec.category.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');

    const questionsHtml = sec.items.map((q) => `
      <div class="question" data-item-id="${q.id}" data-input-type="${esc(q.inputType)}">
        <div class="q-header">
          <span class="q-code">${esc(q.questionCode)}</span>
          ${q.required === 'Mandatory' ? '<span class="badge mandatory">Required</span>' : '<span class="badge conditional">Optional</span>'}
        </div>
        <label class="q-label" for="ans_${q.id}">${esc(q.name)}</label>
        ${renderInput(q)}
        <span class="save-indicator" id="si_${q.id}"></span>
      </div>`).join('');

    return `
    <div class="section" id="sec_${catId}">
      <div class="section-header" onclick="toggleSection('${catId}')">
        <span class="sec-title">${icon} ${esc(sec.category)}</span>
        <span class="sec-meta">${secAnswered}/${sec.items.length} answered</span>
        <span class="chevron" id="chev_${catId}">▼</span>
      </div>
      <div class="section-body" id="body_${catId}">
        <div class="questions-grid">${questionsHtml}</div>
        <div class="sec-footer">
          <span class="save-msg" id="smsg_${catId}"></span>
          <button class="btn-save" onclick="saveSection('${catId}')">💾 Save ${esc(sec.category)}</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const itemMap = JSON.stringify(
    sections.flatMap((s) => s.items.map((i) => ({ id: i.id, cat: i.category.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '') })))
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Questionnaire — ${esc(caseRef)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f4f8;color:#1e293b}
.top-bar{background:#1e3a5f;color:#fff;padding:.75rem 1.25rem;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.top-bar h1{font-size:1.1rem;font-weight:700}
.top-bar .case-ref{font-size:.85rem;opacity:.8;margin-top:.15rem}
.btn-submit-top{background:#10b981;color:#fff;border:none;padding:.5rem 1.1rem;border-radius:6px;font-weight:600;font-size:.9rem;cursor:pointer;transition:background .2s}
.btn-submit-top:hover{background:#059669}
.progress-bar-wrap{background:#1e3a5f;padding:.5rem 1.25rem 1rem;position:sticky;top:56px;z-index:99}
.progress-label{font-size:.78rem;color:rgba(255,255,255,.75);margin-bottom:.3rem}
.progress-track{background:rgba(255,255,255,.2);border-radius:99px;height:6px}
.progress-fill{background:#10b981;height:6px;border-radius:99px;transition:width .4s}
.main{max-width:860px;margin:1.5rem auto;padding:0 1rem 3rem}
.section{background:#fff;border-radius:10px;box-shadow:0 1px 6px rgba(0,0,0,.07);margin-bottom:1rem;overflow:hidden}
.section-header{display:flex;align-items:center;padding:1rem 1.25rem;cursor:pointer;user-select:none;gap:.5rem}
.section-header:hover{background:#f8fafc}
.sec-title{font-weight:700;font-size:1rem;flex:1;color:#1e3a5f}
.sec-meta{font-size:.8rem;color:#64748b;margin-right:.5rem}
.chevron{font-size:.8rem;color:#94a3b8;transition:transform .2s}
.chevron.open{transform:rotate(180deg)}
.section-body{border-top:1px solid #f1f5f9;display:none}
.section-body.open{display:block}
.questions-grid{padding:1.25rem 1.25rem 0}
.question{margin-bottom:1.25rem}
.q-header{display:flex;align-items:center;gap:.5rem;margin-bottom:.3rem}
.q-code{font-size:.72rem;color:#94a3b8;font-family:monospace}
.badge{font-size:.68rem;font-weight:600;padding:.1rem .4rem;border-radius:4px}
.badge.mandatory{background:#fef2f2;color:#dc2626}
.badge.conditional{background:#f0fdf4;color:#16a34a}
.q-label{display:block;font-size:.9rem;font-weight:500;color:#374151;margin-bottom:.4rem;line-height:1.4}
.form-input{width:100%;padding:.6rem .85rem;border:1.5px solid #d1d5db;border-radius:7px;font-size:.92rem;font-family:inherit;outline:none;transition:border .2s;background:#fff;color:#1e293b}
.form-input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.textarea{resize:vertical;min-height:72px}
.file-note{font-size:.83rem;color:#64748b;background:#f8fafc;padding:.6rem .85rem;border-radius:7px;border:1px dashed #cbd5e1}
.save-indicator{font-size:.75rem;color:#10b981;margin-top:.2rem;display:block;min-height:1em}
.sec-footer{display:flex;align-items:center;justify-content:flex-end;gap:1rem;padding:1rem 1.25rem;border-top:1px solid #f1f5f9;background:#fafafa}
.save-msg{font-size:.82rem;color:#10b981;flex:1}
.btn-save{background:#1e3a5f;color:#fff;border:none;padding:.55rem 1.2rem;border-radius:7px;font-size:.88rem;font-weight:600;cursor:pointer;transition:background .2s}
.btn-save:hover{background:#2563eb}
.btn-save:disabled{background:#94a3b8;cursor:not-allowed}
.submit-area{background:#fff;border-radius:10px;box-shadow:0 1px 6px rgba(0,0,0,.07);padding:1.5rem 1.25rem;text-align:center}
.submit-area p{font-size:.9rem;color:#64748b;margin-bottom:1rem}
.btn-submit-final{background:#10b981;color:#fff;border:none;padding:.8rem 2.5rem;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;transition:background .2s}
.btn-submit-final:hover{background:#059669}
.btn-submit-final:disabled{background:#94a3b8;cursor:not-allowed}
.toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#1e293b;color:#fff;padding:.8rem 1.2rem;border-radius:8px;font-size:.9rem;box-shadow:0 4px 16px rgba(0,0,0,.2);opacity:0;transform:translateY(8px);transition:all .3s;pointer-events:none;z-index:999}
.toast.show{opacity:1;transform:translateY(0)}
.toast.success{background:#10b981}
.toast.error{background:#dc2626}
.success-screen{text-align:center;padding:3rem 1.25rem}
.success-screen .icon{font-size:3rem;margin-bottom:1rem}
.success-screen h2{color:#10b981;font-size:1.5rem;margin-bottom:.5rem}
.success-screen p{color:#64748b;font-size:.95rem}
@media(max-width:600px){.top-bar{flex-wrap:wrap;gap:.5rem}.main{padding:0 .5rem 3rem}}
</style>
</head>
<body>

<div class="top-bar">
  <div>
    <div class="top-bar h1">📋 Client Questionnaire</div>
    <div class="case-ref">Case: ${esc(caseRef)}</div>
  </div>
  <button class="btn-submit-top" onclick="submitAll()">✓ Submit All</button>
</div>

<div class="progress-bar-wrap">
  <div class="progress-label" id="progressLabel">${answered} of ${totalQ} questions answered (${pct}%)</div>
  <div class="progress-track"><div class="progress-fill" id="progressFill" style="width:${pct}%"></div></div>
</div>

<div class="main" id="mainContent">
  ${sectionsHtml}

  <div class="section submit-area">
    <p>Once you have filled in all your answers above, click the button below to submit your questionnaire to your consultant.</p>
    <button class="btn-submit-final" onclick="submitAll()">✅ Submit Complete Questionnaire</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const CASE_REF  = ${JSON.stringify(caseRef)};
const ITEM_MAP  = ${itemMap};
let totalQ      = ${totalQ};
let answered    = ${answered};

// ── Section toggle ─────────────────────────────────────────────────────────
function toggleSection(catId) {
  const body  = document.getElementById('body_' + catId);
  const chev  = document.getElementById('chev_' + catId);
  const open  = body.classList.toggle('open');
  chev.classList.toggle('open', open);
}

// Open first section by default
(function() {
  const firstBody = document.querySelector('.section-body');
  const firstChev = document.querySelector('.chevron');
  if (firstBody) { firstBody.classList.add('open'); firstChev.classList.add('open'); }
})();

// ── Progress ───────────────────────────────────────────────────────────────
function updateProgress() {
  const allInputs = document.querySelectorAll('.form-input');
  let count = 0;
  allInputs.forEach(inp => { if (inp.value && inp.value.trim()) count++; });
  const pct = totalQ ? Math.round((count / totalQ) * 100) : 0;
  document.getElementById('progressLabel').textContent = count + ' of ' + totalQ + ' questions answered (' + pct + '%)';
  document.getElementById('progressFill').style.width = pct + '%';
}

document.querySelectorAll('.form-input').forEach(inp => {
  inp.addEventListener('input', updateProgress);
});

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.className = 'toast', 3500);
}

// ── Save section ───────────────────────────────────────────────────────────
async function saveSection(catId) {
  const body = document.getElementById('body_' + catId);
  const btn  = body.querySelector('.btn-save');
  const msg  = document.getElementById('smsg_' + catId);

  const inputs = body.querySelectorAll('.form-input');
  const answers = [];
  inputs.forEach(inp => {
    const question = inp.closest('.question');
    if (!question) return;
    const itemId = question.dataset.itemId;
    if (itemId) answers.push({ itemId, answer: inp.value });
  });

  if (!answers.length) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  msg.textContent = '';

  try {
    const res = await fetch('/questionnaire/' + encodeURIComponent(CASE_REF) + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    const data = await res.json();
    if (data.success) {
      msg.textContent = '✓ Saved ' + data.saved + ' answers';
      showToast('Section saved!');
      // Update save indicators
      inputs.forEach(inp => {
        const si = document.getElementById('si_' + inp.name?.replace('ans_',''));
        if (si && inp.value) si.textContent = '✓ Saved';
      });
    } else {
      msg.textContent = '⚠ Save failed. Please try again.';
      showToast('Save failed', 'error');
    }
  } catch (e) {
    msg.textContent = '⚠ Network error. Please try again.';
    showToast('Network error', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Save ' + catId.replace(/_/g, ' ');
  }
}

// ── Submit all ─────────────────────────────────────────────────────────────
async function submitAll() {
  // First save all sections
  const allCategories = [...new Set(ITEM_MAP.map(i => i.cat))];
  for (const cat of allCategories) {
    await saveSection(cat);
  }

  if (!confirm('Are you sure you want to submit your questionnaire? Your consultant will be notified.')) return;

  const btns = document.querySelectorAll('.btn-submit-top, .btn-submit-final');
  btns.forEach(b => { b.disabled = true; b.textContent = 'Submitting…'; });

  try {
    const res = await fetch('/questionnaire/' + encodeURIComponent(CASE_REF) + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('mainContent').innerHTML = \`
        <div class="section success-screen">
          <div class="icon">🎉</div>
          <h2>Questionnaire Submitted!</h2>
          <p>Thank you. Your responses have been submitted to your consultant.<br>
             Case Reference: <strong>\${CASE_REF}</strong><br><br>
             You will be contacted if any clarification is needed.</p>
        </div>\`;
    } else {
      showToast('Submission failed. Please try again.', 'error');
      btns.forEach(b => { b.disabled = false; b.textContent = '✅ Submit Complete Questionnaire'; });
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
