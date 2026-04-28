const path    = require('path');
const express = require('express');
const multer  = require('multer');
const router  = express.Router();

const { getCaseSummary, uploadFileToOneDrive, markDocumentReceived } = require('../services/documentFormService');
const { updateLastActivityDate } = require('../services/clientMasterService');
const { calculateForCaseRef }   = require('../services/caseReadinessService');
const mondayApi = require('../services/mondayApi');

// ─── File upload config ───────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 }, // 20 MB per file
});

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx',
  '.jpg', '.jpeg', '.png', '.heic', '.webp',
  '.xlsx', '.xls', '.csv',
  '.zip',
]);

// ─── Input validation helpers ────────────────────────────────────────────────

const CASE_REF_PATTERN = /^[A-Za-z0-9\- ]+$/;
const MAX_REPLY_LENGTH = 5000;

function validateCaseRef(caseRef) {
  return caseRef && caseRef.length <= 50 && CASE_REF_PATTERN.test(caseRef);
}

function validateItemId(itemId) {
  return itemId && /^\d+$/.test(itemId);
}

// ─── Display config ───────────────────────────────────────────────────────────

const CATEGORY_ORDER = [
  'Identity', 'Personal', 'Financial', 'Employment',
  'Education', 'Travel', 'Legal', 'Medical', 'Supporting', 'General', 'Other',
];

const CATEGORY_ICONS = {
  Identity:   '🪪',
  Personal:   '👤',
  Financial:  '💰',
  Employment: '💼',
  Education:  '🎓',
  Travel:     '✈️',
  Legal:      '⚖️',
  Medical:    '🏥',
  Supporting: '📎',
  General:    '📋',
  Other:      '📋',
};

const STATUS_STYLE = {
  'Missing':         { bg: '#fef2f2', color: '#dc2626', dot: '#dc2626', ring: 'rgba(220,38,38,.15)' },
  'Received':        { bg: '#eff6ff', color: '#2563eb', dot: '#2563eb', ring: 'rgba(37,99,235,.15)'  },
  'Reviewed':        { bg: '#f0fdf4', color: '#16a34a', dot: '#16a34a', ring: 'rgba(22,163,74,.15)'  },
  'Rework Required': { bg: '#fff7ed', color: '#ea580c', dot: '#ea580c', ring: 'rgba(234,88,12,.15)'  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MEMBER_ICONS = {
  'Principal Applicant':       '👤',
  'Spouse / Common-Law Partner': '👫',
  'Dependent Child':           '👶',
  'Sponsor':                   '🤝',
  'Worker Spouse':             '💼',
};

function memberIcon(memberType) {
  return MEMBER_ICONS[memberType] || '👤';
}

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert raw Client-Facing Instruction text into structured HTML.
 *
 * Detection order:
 *  1. Existing bullet chars (•, -, –) → split into <ul><li> list
 *  2. Multi-line text (newline-separated) → each line becomes a <li>
 *  3. Single line with multiple sentences → split on sentence boundaries
 *  4. Single sentence → plain <span> (no bullet list needed)
 *
 * URLs are always rendered as clickable <a> links.
 */
function formatInstructions(raw) {
  if (!raw || !raw.trim()) return '';
  const text = raw.trim();

  // Render a text fragment safely, converting bare URLs to clickable links.
  // Before splitting, reassemble URLs that were broken by spaces during PDF import
  // (e.g. "https://example.com/path- segment/file.html" → single URL).
  function renderFrag(str) {
    const repaired = reassembleUrls(str);
    const parts = repaired.split(/(https?:\/\/[^\s)<>"]+)/);
    return parts.map((part, i) => {
      if (i % 2 === 0) return esc(part);
      // Strip trailing punctuation from the URL (period, comma, etc.)
      const clean = part.replace(/[.,;:!?)\]}>]+$/, '');
      const trail = part.slice(clean.length);
      return `<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer">${esc(clean)}</a>${esc(trail)}`;
    }).join('');
  }

  /**
   * Reassemble URLs that were split by spaces during PDF line-wrap import.
   *
   * Iterates through the string, finds URLs, then greedily absorbs subsequent
   * space-separated fragments that look like URL path continuations rather than
   * normal English words.
   */
  function reassembleUrls(str) {
    if (!str || !/https?:\/\//.test(str)) return str;

    const nonUrlWords = new Set([
      'the','a','an','and','or','but','for','to','of','in','on','at','by',
      'is','are','was','were','be','been','have','has','do','does','did',
      'will','would','could','should','may','might','this','that','these',
      'those','it','its','they','them','their','we','us','our','you','your',
      'he','she','him','her','his','if','then','else','when','where','which',
      'who','what','how','not','no','yes','all','each','every','any','some',
      'most','please','provide','include','submit','ensure','must','note',
      'can','also','only','with','from','about','into','more','such','as',
    ]);

    function isUrlContinuation(urlSoFar, frag) {
      if (!frag) return false;
      const lower = frag.replace(/[.,;:!?)]+$/, '').toLowerCase();
      if (nonUrlWords.has(lower)) return false;
      if (/^[A-Z][a-z]/.test(frag) && !frag.includes('/') && !frag.includes('.')) return false;
      if (frag.includes('/')) return true;
      if (/\.(html?|php|aspx?|pdf|xml|json|jsp|do)\b/i.test(frag)) return true;
      if (/[-/]$/.test(urlSoFar)) return true;
      if (/[a-z]$/.test(urlSoFar) && /^[a-z]/.test(frag) && frag.length > 3) return true;
      return false;
    }

    let result = str;
    const urlRe = /https?:\/\/\S+/g;
    let m;

    while ((m = urlRe.exec(result)) !== null) {
      let end = m.index + m[0].length;
      let changed = false;

      while (end < result.length && result[end] === ' ') {
        const rest = result.substring(end + 1);
        const fm = rest.match(/^(\S+)/);
        if (!fm) break;
        const url = result.substring(m.index, end);
        if (isUrlContinuation(url, fm[1])) {
          result = result.substring(0, end) + result.substring(end + 1);
          end += fm[1].length;
          changed = true;
        } else {
          break;
        }
      }

      urlRe.lastIndex = end;
    }

    return result;
  }

  function wrapItems(arr) {
    const clean = arr.map(s => s.trim()).filter(s => s.length > 2);
    if (clean.length === 1) return `<span>${renderFrag(clean[0])}</span>`;
    return `<ul>${clean.map(s => `<li>${renderFrag(s)}</li>`).join('')}</ul>`;
  }

  // ── 1. Already uses bullet characters (•  -  –) ──────────────────────────
  if (/^[•\-–]\s/m.test(text)) {
    const lines  = text.split('\n').map(l => l.trim()).filter(Boolean);
    const bullets = [];
    let cur = '';
    for (const line of lines) {
      if (/^[•\-–]\s/.test(line)) {
        if (cur) bullets.push(cur);
        cur = line.replace(/^[•\-–]\s+/, '').trim();
      } else if (cur) {
        cur += ' ' + line;         // continuation of previous bullet
      } else {
        bullets.push(line);        // header-like line before first bullet
      }
    }
    if (cur) bullets.push(cur);
    if (bullets.length > 0) return wrapItems(bullets);
  }

  // ── 2. Multi-line text ────────────────────────────────────────────────────
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    // Merge continuation lines (no sentence-ending punctuation + starts lowercase)
    const merged = [];
    for (const line of lines) {
      const last = merged[merged.length - 1];
      if (last && !/[.!?:,]$/.test(last) && /^[a-z]/.test(line)) {
        merged[merged.length - 1] = last + ' ' + line;
      } else {
        merged.push(line);
      }
    }
    return wrapItems(merged);
  }

  // ── 3. Single line — split on sentence boundaries ────────────────────────
  const sentences = text
    .split(/(?<=[.!])\s+(?=[A-Z])/)
    .map(s => s.trim())
    .filter(s => s.length > 5);
  if (sentences.length > 1) return wrapItems(sentences);

  // ── 4. Single sentence ────────────────────────────────────────────────────
  return `<span>${renderFrag(text)}</span>`;
}

// Canonical order for member types (Principal Applicant always first)
const MEMBER_ORDER = [
  'Principal Applicant',
  'Spouse / Common-Law Partner',
  'Dependent Child',
  'Sponsor',
  'Worker Spouse',
];

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

/**
 * Group items by applicant type → then by category within each member group.
 * Returns { isMultiMember: bool, members: [{ memberType, sections }] }
 */
function groupByMemberAndCategory(items) {
  const memberMap = {};
  items.forEach((item) => {
    const mt = item.applicantType || 'Principal Applicant';
    if (!memberMap[mt]) memberMap[mt] = [];
    memberMap[mt].push(item);
  });

  const memberTypes = MEMBER_ORDER
    .filter((m) => memberMap[m])
    .concat(Object.keys(memberMap).filter((m) => !MEMBER_ORDER.includes(m)));

  const isMultiMember = memberTypes.length > 1;

  const members = memberTypes.map((mt) => ({
    memberType: mt,
    sections:   groupByCategory(memberMap[mt]),
  }));

  return { isMultiMember, members };
}

// Phase ordering — Profile Creation always first
const PHASE_ORDER = ['Profile Creation', 'Submission'];

/**
 * Split items by Checklist Phase → then delegate each phase's items
 * to groupByMemberAndCategory for the existing member + category grouping.
 *
 * Returns { hasDualPhase: bool, phases: [{ phase, isMultiMember, members }] }
 */
function groupByPhase(items) {
  const hasProfileCreation = items.some(i => i.checklistPhase === 'Profile Creation');

  if (!hasProfileCreation) {
    // No dual-phase — return single phase with all items (backward compatible)
    const { isMultiMember, members } = groupByMemberAndCategory(items);
    return { hasDualPhase: false, phases: [{ phase: '', isMultiMember, members }] };
  }

  // Split items into Profile Creation vs Submission (default for blank phase)
  const phaseMap = { 'Profile Creation': [], 'Submission': [] };
  items.forEach(item => {
    const p = item.checklistPhase === 'Profile Creation' ? 'Profile Creation' : 'Submission';
    phaseMap[p].push(item);
  });

  const phases = PHASE_ORDER
    .filter(p => phaseMap[p] && phaseMap[p].length > 0)
    .map(p => {
      const { isMultiMember, members } = groupByMemberAndCategory(phaseMap[p]);
      return { phase: p, isMultiMember, members };
    });

  return { hasDualPhase: phases.length > 1, phases };
}

// ─── Landing page ─────────────────────────────────────────────────────────────

function landingPage(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Document Upload — TDOT Immigration</title>
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
    <h1>Document Upload</h1>
    <p>Enter your <strong>Case Reference Number</strong> to access and upload your required documents.</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form method="GET" action="/documents">
      <label for="caseRef">Case Reference Number</label>
      <input type="text" id="caseRef" name="ref" placeholder="e.g. 2026-SP-001" autocomplete="off" required>
      <button class="btn" type="submit">Access My Documents →</button>
    </form>
    <p class="hint">Don't know your case reference? Contact your consultant.</p>
  </div>
  <div class="card-footer">TDOT Immigration &nbsp;·&nbsp; Secure Client Portal</div>
</div>
</body>
</html>`;
}

// ─── Shared HTML helpers ───────────────────────────────────────────────────────

function docRowHtml(doc, caseRef) {
  const st        = STATUS_STYLE[doc.status] || STATUS_STYLE['Missing'];
  const canUpload = doc.status !== 'Reviewed';
  return `
        <div class="doc-row${doc.status === 'Rework Required' ? ' needs-action' : ''}"
             id="doc_${doc.id}"
             data-status="${esc(doc.status)}">
          <div class="doc-info">
            <div class="doc-top">
              <span class="doc-code">${esc(doc.documentCode)}</span>
              ${doc.status === 'Rework Required' ? '<span class="badge action-required">⚠️ Re-upload Required</span>' : ''}
            </div>
            <div class="doc-name">${esc(doc.name)}</div>
            ${doc.status === 'Rework Required' ? `
            <div class="doc-review-note" id="note_${doc.id}">
              <div class="doc-review-note-header">\ud83d\udcac Feedback from your case officer</div>
              <div class="doc-review-note-body">${doc.reviewNotes ? esc(doc.reviewNotes) : 'Please re-upload this document with the necessary corrections.'}</div>
              <div class="doc-reply-area" id="reply-area_${doc.id}">
                <button class="doc-reply-btn" onclick="openDocReply('${esc(doc.id)}')">
                  \u21a9\ufe0f Reply to case officer
                </button>
              </div>
            </div>` : ''}
            ${doc.clientInstructions ? `<div class="doc-instructions">💡 ${formatInstructions(doc.clientInstructions)}</div>` : ''}
            ${doc.lastUpload ? `<div class="doc-meta">Last uploaded: ${esc(doc.lastUpload)}</div>` : ''}
          </div>
          <div class="doc-actions">
            <span class="doc-status" style="background:${st.bg};color:${st.color};box-shadow:0 0 0 1px ${st.ring}">
              <span style="width:7px;height:7px;border-radius:50%;background:${st.dot};display:inline-block;flex-shrink:0"></span>
              ${esc(doc.status)}
            </span>
            ${canUpload ? `
            <label class="btn-upload" for="file_${doc.id}">
              ${doc.status === 'Missing' ? '⬆ Upload' : '🔄 Re-upload'}
            </label>
            <input type="file" id="file_${doc.id}" style="display:none" multiple
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.heic,.webp,.xlsx,.xls,.csv,.zip"
              onchange="handleUpload('${esc(doc.id)}', '${esc(caseRef)}', this)">
            <div class="upload-hint">Multiple files allowed</div>
            ` : '<span class="reviewed-tag">✓ Reviewed</span>'}
            <div class="upload-progress" id="prog_${doc.id}" style="display:none">
              <div class="progress-bar-inner" id="pbar_${doc.id}"></div>
            </div>
            <div class="upload-msg" id="umsg_${doc.id}"></div>
          </div>
        </div>`;
}

// ─── Main upload form ──────────────────────────────────────────────────────────

/**
 * @param {string}       caseRef
 * @param {string}       clientName
 * @param {Array}        members       - [{ memberType, sections: [{ category, items }] }]
 * @param {boolean}      isMultiMember - show member tabs when true
 * @param {string[]}     disclaimer    - case-specific disclaimer bullets from PDF
 * @param {Array|null}   phases        - if dual-phase, array of { phase, isMultiMember, members }
 */
function formPage(caseRef, clientName, members, isMultiMember, disclaimer = [], phases = null) {
  // Flatten all items for global counts (across all phases)
  const allPhaseMembers = phases ? phases.flatMap(p => p.members) : members;
  const allItems     = allPhaseMembers.flatMap((m) => m.sections.flatMap((s) => s.items));
  const totalDocs    = allItems.length;
  const uploadedDocs = allItems.filter((i) => i.status !== 'Missing').length;
  const pct          = totalDocs ? Math.round((uploadedDocs / totalDocs) * 100) : 0;

  // Build flat step list.
  // When dual-phase, each phase's items produce their own steps, tagged with phase name.
  // Phase dividers are inserted into the pill bar for visual separation.

  function buildStepsForPhase(phaseMembers, phaseIsMultiMember, phaseName) {
    let phaseSteps;
    if (phaseIsMultiMember) {
      phaseSteps = phaseMembers.map((m) => ({
        label:     m.memberType,
        icon:      memberIcon(m.memberType),
        items:     m.sections.flatMap((s) => s.items),
        sections:  m.sections,
        isMember:  true,
        phase:     phaseName,
      }));
    } else {
      phaseSteps = phaseMembers[0].sections.map((sec) => ({
        label:    sec.category,
        icon:     CATEGORY_ICONS[sec.category] || '📋',
        items:    sec.items,
        sections: [sec],
        isMember: false,
        phase:    phaseName,
      }));
    }
    return phaseSteps;
  }

  let steps;
  let phaseBoundaries = []; // indices where a new phase starts (for dividers in pill bar)
  if (phases && phases.length > 1) {
    steps = [];
    for (const p of phases) {
      phaseBoundaries.push({ idx: steps.length, phase: p.phase });
      steps.push(...buildStepsForPhase(p.members, p.isMultiMember, p.phase));
    }
  } else {
    steps = buildStepsForPhase(members, isMultiMember, '');
  }

  const total = steps.length;

  let firstFlaggedStep = -1;
  let flaggedCount     = 0;
  steps.forEach((step, idx) => {
    const flagged = step.items.filter((i) => i.status === 'Rework Required');
    flaggedCount += flagged.length;
    if (firstFlaggedStep === -1 && flagged.length > 0) firstFlaggedStep = idx;
  });

  // Build a Set of phase boundary indices for quick lookup
  const phaseBoundaryMap = {};
  phaseBoundaries.forEach(b => { phaseBoundaryMap[b.idx] = b.phase; });

  const stepPills = steps
    .map((step, idx) => {
      const hasFlagged = step.items.some((i) => i.status === 'Rework Required');

      // Insert a phase divider before the first step of each phase
      const phaseLabel = phaseBoundaryMap[idx];
      const divider = phaseLabel
        ? `<div class="phase-divider"><span class="phase-divider-label">${phaseLabel === 'Profile Creation' ? '📋' : '📁'} ${esc(phaseLabel)}</span></div>`
        : '';

      return `${divider}<button class="step-pill${hasFlagged ? ' flagged' : ''}" id="pill_${idx}" onclick="goToStep(${idx})" title="${esc(step.label)}">
        <span class="pill-num">${idx + 1}</span>
        <span class="pill-label">${step.icon} ${esc(step.label)}${hasFlagged ? ' ⚠️' : ''}</span>
      </button>`;
    })
    .join('');

  const panels = steps
    .map((step, idx) => {
      const isLast   = idx === total - 1;
      const uploaded = step.items.filter((i) => i.status !== 'Missing').length;

      // Build body: if isMember, render category sub-headers within the panel;
      // otherwise just render doc rows directly
      let bodyHtml;
      if (step.isMember) {
        bodyHtml = step.sections.map((sec) => {
          const catIcon  = CATEGORY_ICONS[sec.category] || '📋';
          const catUpl   = sec.items.filter((i) => i.status !== 'Missing').length;
          return `
      <div class="cat-group">
        <div class="cat-header">
          <span class="cat-title">${catIcon} ${esc(sec.category)}</span>
          <span class="cat-count">${catUpl} / ${sec.items.length}</span>
        </div>
        ${sec.items.map((doc) => docRowHtml(doc, caseRef)).join('')}
      </div>`;
        }).join('');
      } else {
        bodyHtml = step.items.map((doc) => docRowHtml(doc, caseRef)).join('');
      }

      const phaseTag = step.phase
        ? `<span class="phase-tag" style="font-size:.7rem;font-weight:700;color:${step.phase === 'Profile Creation' ? '#2563eb' : '#7c3aed'};background:${step.phase === 'Profile Creation' ? '#eff6ff' : '#f5f3ff'};padding:2px 8px;border-radius:4px;margin-left:8px">${esc(step.phase)}</span>`
        : '';

      return `
    <div class="panel" id="panel_${idx}" style="display:none">
      <div class="panel-header">
        <div class="panel-title">${step.icon} ${esc(step.label)}${phaseTag}</div>
        <div class="panel-meta" id="pmeta_${idx}">${uploaded} of ${step.items.length} uploaded</div>
      </div>
      <div class="panel-body">${bodyHtml}</div>
      <div class="panel-footer">
        <div class="footer-right">
          ${idx > 0 ? `<button class="btn-nav btn-back" onclick="goToStep(${idx - 1})">← Back</button>` : ''}
          ${isLast
            ? `<button class="btn-nav btn-done" onclick="submitDone()">✅ Done</button>`
            : `<button class="btn-nav btn-next" onclick="goToStep(${idx + 1})">Next →</button>`}
        </div>
      </div>
    </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Documents — ${esc(caseRef)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --brand:#8B0000;--brand-dark:#6B0000;--brand-faint:rgba(139,0,0,.06);--brand-light:rgba(139,0,0,.10);
  --gold:#C9A84C;--navy:#0B1D32;--bg-warm:#FAF8F4;
  --green:#059669;--green-bg:#ecfdf5;--green-text:#065f46;
  --blue:#2563eb;--blue-bg:#eff6ff;--blue-text:#1e40af;
  --amber:#b45309;--amber-bg:#fffbeb;--amber-border:#fde68a;
  --orange:#ea580c;--orange-bg:#fff7ed;--orange-border:#fed7aa;
  --red:#dc2626;--red-bg:#fef2f2;--red-border:#fecaca;
  --gray-50:#f9fafb;--gray-100:#f3f4f6;--gray-200:#e5e7eb;--gray-300:#d1d5db;
  --gray-400:#9ca3af;--gray-500:#6b7280;--gray-600:#4b5563;--gray-700:#374151;--gray-900:#111827;
  --shadow-sm:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.04);
  --shadow-md:0 4px 20px rgba(0,0,0,.08),0 2px 8px rgba(0,0,0,.04);
  --radius:14px;--radius-sm:9px;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;background:var(--bg-warm);color:var(--gray-900);min-height:100vh;line-height:1.5}

/* ── Top bar ── */
.top-bar{background:var(--navy);color:#fff;padding:.7rem 1.6rem;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:0 2px 20px rgba(0,0,0,.4);border-bottom:3px solid var(--gold)}
.top-bar-brand{display:flex;align-items:center;gap:.9rem}
.top-bar-logo{height:30px;object-fit:contain;flex-shrink:0}
.top-bar-divider{width:1px;height:24px;background:rgba(255,255,255,.14);flex-shrink:0}
.top-bar-info h1{font-size:.9rem;font-weight:700;color:#fff;line-height:1.3;letter-spacing:.01em}
.top-bar-info .case-ref{font-size:.68rem;color:rgba(255,255,255,.38);margin-top:.1rem;letter-spacing:.04em;text-transform:uppercase}

/* ── Progress bar ── */
.progress-wrap{background:var(--navy);padding:.35rem 1.6rem .7rem;position:sticky;top:54px;z-index:199}
.progress-text{font-size:.66rem;color:rgba(255,255,255,.38);margin-bottom:.32rem;letter-spacing:.04em;text-transform:uppercase}
.progress-track{background:rgba(255,255,255,.1);border-radius:99px;height:4px}
.progress-fill{background:linear-gradient(90deg,var(--brand),#c0392b);height:4px;border-radius:99px;transition:width .5s ease}

/* ── Step pills (tab bar) ── */
.steps-wrap{background:#fff;border-bottom:1px solid var(--gray-200);position:sticky;top:96px;z-index:198;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.steps-wrap::-webkit-scrollbar{display:none}
.steps-inner{display:flex;min-width:max-content;padding:0 .5rem}
.phase-divider{display:flex;align-items:center;padding:.5rem 1rem;width:100%}
.phase-divider-label{font-size:.72rem;font-weight:700;color:var(--brand);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;border-bottom:2px solid var(--brand);padding-bottom:4px}
.step-pill{display:flex;align-items:center;gap:.45rem;padding:.68rem 1rem;border:none;background:transparent;cursor:pointer;font-size:.76rem;color:var(--gray-400);border-bottom:2.5px solid transparent;transition:all .18s;white-space:nowrap;font-family:inherit;font-weight:500}
.step-pill:hover{color:var(--gray-700);background:var(--gray-50)}
.step-pill.active{color:var(--brand);border-bottom-color:var(--brand);font-weight:700;background:var(--brand-faint)}
.step-pill.done{color:var(--green)}
.step-pill.done .pill-num{background:var(--green);color:#fff}
.step-pill.flagged{color:var(--orange)}
.step-pill.flagged .pill-num{background:var(--orange-bg);color:var(--orange);border:1.5px solid var(--orange-border)}
.pill-num{width:20px;height:20px;border-radius:50%;background:var(--gray-200);color:var(--gray-500);font-size:.66rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .18s}
.step-pill.active .pill-num{background:var(--brand);color:#fff}

/* ── Main layout ── */
.main{max-width:820px;margin:1.5rem auto;padding:0 1.1rem 5rem}

/* ── Card / Panel ── */
.panel{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow-md);overflow:hidden;border:1px solid var(--gray-200)}
.panel-header{padding:1.15rem 1.6rem;border-bottom:1px solid var(--gray-100);display:flex;align-items:center;justify-content:space-between;background:var(--gray-50)}
.panel-title{font-size:1.05rem;font-weight:700;color:var(--gray-900);display:flex;align-items:center;gap:.45rem}
.panel-meta{font-size:.72rem;color:var(--gray-500);background:var(--gray-200);padding:.2rem .7rem;border-radius:99px;font-weight:500}
.panel-body{padding:.25rem 0}

/* ── Category sub-header (multi-member view) ── */
.cat-group{border-bottom:1px solid var(--gray-100)}
.cat-group:last-child{border-bottom:none}
.cat-header{display:flex;align-items:center;justify-content:space-between;padding:.6rem 1.6rem .5rem;background:var(--gray-50);border-bottom:1px solid var(--gray-100);border-left:3px solid var(--gray-300)}
.cat-title{font-size:.78rem;font-weight:700;color:var(--gray-600);letter-spacing:.02em;text-transform:uppercase}
.cat-count{font-size:.7rem;color:var(--gray-400);background:var(--gray-200);padding:.1rem .55rem;border-radius:99px;font-weight:500}

/* ── Document row ── */
.doc-row{display:flex;align-items:flex-start;justify-content:space-between;gap:1.2rem;padding:1.1rem 1.6rem;border-bottom:1px solid var(--gray-100);transition:background .15s;flex-wrap:wrap}
.doc-row:last-child{border-bottom:none}
.doc-row:hover{background:var(--gray-50)}
.doc-row.needs-action{border:2px solid #fb923c!important;background:#fffbf5!important;border-radius:12px;margin:.3rem .9rem;box-shadow:0 2px 12px rgba(249,115,22,.12)}
.doc-info{flex:1;min-width:0}
.doc-top{display:flex;align-items:center;gap:.45rem;margin-bottom:.3rem;flex-wrap:wrap}
.doc-code{font-size:.65rem;color:var(--gray-400);font-family:'SF Mono',SFMono-Regular,Consolas,monospace;letter-spacing:.06em;background:var(--gray-100);padding:.1rem .38rem;border-radius:4px}
.badge{font-size:.6rem;font-weight:700;padding:.15rem .52rem;border-radius:5px;text-transform:uppercase;letter-spacing:.06em}
.badge.action-required{background:var(--orange-bg);color:var(--orange);border:1px solid var(--orange-border)}
.doc-name{font-size:.93rem;font-weight:600;color:var(--gray-900);line-height:1.45}
.doc-desc{font-size:.8rem;color:var(--gray-500);margin-top:.32rem;line-height:1.55}
.doc-instructions{font-size:.79rem;color:#92400e;background:var(--amber-bg);border:1px solid var(--amber-border);border-left:3px solid #f59e0b;padding:.5rem .75rem;border-radius:var(--radius-sm);margin-top:.45rem;line-height:1.6}
.doc-instructions ul{list-style:none;padding:0;margin:.2rem 0 0;display:flex;flex-direction:column;gap:.3rem}
.doc-instructions li{display:flex;align-items:flex-start;gap:.5rem}
.doc-instructions li::before{content:'';display:block;width:5px;height:5px;border-radius:50%;background:#f59e0b;margin-top:.52em;flex-shrink:0}
.doc-instructions a{color:#92400e;text-decoration:underline;word-break:break-all}
.doc-review-note{background:var(--red-bg);border:1px solid var(--red-border);border-left:4px solid var(--red);border-radius:var(--radius-sm);margin-top:.55rem;overflow:hidden}
.doc-review-note-header{font-size:.71rem;font-weight:700;color:#991b1b;padding:.35rem .75rem;background:#fee2e2;border-bottom:1px solid var(--red-border);letter-spacing:.03em;text-transform:uppercase}
.doc-review-note-body{font-size:.82rem;color:#7f1d1d;padding:.45rem .75rem;line-height:1.55}
.doc-reply-area{padding:.5rem .75rem;background:#fafafa;border-top:1px solid #f0f0f0}
.doc-reply-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;background:var(--brand);color:#fff;border:none;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s}
.doc-reply-btn:hover{background:var(--brand-dark)}
.doc-reply-editor{padding:.6rem .75rem;background:#f0f7ff;border-top:1px solid #bfdbfe}
.doc-reply-editor textarea{width:100%;min-height:60px;border:1px solid #93c5fd;border-radius:6px;padding:8px 10px;font-size:.8rem;font-family:inherit;line-height:1.5;resize:vertical;box-sizing:border-box;color:#1e293b;background:#fff}
.doc-reply-editor textarea:focus{outline:none;border-color:var(--brand)}
.doc-reply-actions{display:flex;gap:8px;margin-top:8px;justify-content:flex-end}
.doc-reply-cancel{padding:6px 16px;background:#e5e7eb;color:#374151;border:none;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer;font-family:inherit}
.doc-reply-send{padding:6px 16px;background:var(--brand);color:#fff;border:none;border-radius:6px;font-size:.72rem;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s}
.doc-reply-send:hover{background:#1d4ed8}
.doc-reply-sent{padding:8px 10px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:.78rem;color:#1e40af;line-height:1.5}
.doc-reply-sent strong{color:var(--brand)}
.doc-meta{font-size:.7rem;color:var(--gray-300);margin-top:.25rem}

/* ── Actions column ── */
.doc-actions{display:flex;flex-direction:column;align-items:flex-end;gap:.45rem;flex-shrink:0}
.doc-status{display:inline-flex;align-items:center;gap:.3rem;font-size:.71rem;font-weight:600;padding:.24rem .65rem;border-radius:99px;white-space:nowrap;letter-spacing:.01em}
.btn-upload{display:inline-flex;align-items:center;gap:.35rem;padding:.42rem 1rem;background:var(--brand);color:#fff;border-radius:var(--radius-sm);font-size:.78rem;font-weight:700;cursor:pointer;transition:background .18s,transform .12s;white-space:nowrap;letter-spacing:.01em;user-select:none}
.btn-upload:hover{background:var(--brand-dark);transform:translateY(-1px)}
.btn-upload:active{transform:translateY(0)}
.reviewed-tag{font-size:.77rem;color:var(--green);font-weight:600;display:inline-flex;align-items:center;gap:.25rem}
.upload-hint{font-size:.64rem;color:var(--gray-300);text-align:right;letter-spacing:.01em}
.upload-progress{width:120px;height:4px;background:var(--gray-200);border-radius:99px;overflow:hidden;margin-top:.25rem}
.progress-bar-inner{height:4px;background:linear-gradient(90deg,var(--brand),#c0392b);border-radius:99px;width:0;transition:width .35s ease}
.upload-msg{font-size:.71rem;color:var(--gray-400);text-align:right;min-height:1.1em;max-width:160px}

/* ── Flagged banner ── */
.flagged-banner{display:flex;align-items:center;gap:.9rem;background:var(--amber-bg);border:1.5px solid var(--amber-border);border-left:4px solid #f59e0b;border-radius:var(--radius-sm);padding:.95rem 1.2rem;margin:1rem auto;max-width:820px;flex-wrap:wrap}
.flagged-banner-icon{font-size:1.4rem;flex-shrink:0}
.flagged-banner-text{flex:1;font-size:.84rem;color:#78350f;line-height:1.55}
.flagged-banner-btn{padding:.44rem 1.05rem;background:#d97706;color:#fff;border:none;border-radius:var(--radius-sm);font-size:.8rem;font-weight:700;cursor:pointer;white-space:nowrap;transition:background .18s;font-family:inherit}
.flagged-banner-btn:hover{background:#b45309}

/* ── Panel footer / nav ── */
.panel-footer{display:flex;align-items:center;justify-content:flex-end;padding:1rem 1.6rem;border-top:1px solid var(--gray-100);background:var(--gray-50);gap:.65rem}
.btn-nav{padding:.58rem 1.3rem;border:none;border-radius:var(--radius-sm);font-size:.84rem;font-weight:600;cursor:pointer;transition:all .18s;font-family:inherit;letter-spacing:.01em}
.btn-back{background:var(--gray-200);color:var(--gray-600)}
.btn-back:hover{background:var(--gray-300)}
.btn-next{background:var(--brand);color:#fff;box-shadow:0 2px 8px rgba(143,5,5,.25)}
.btn-next:hover{background:var(--brand-dark);box-shadow:0 3px 12px rgba(143,5,5,.3)}
.btn-done{background:var(--green);color:#fff;box-shadow:0 2px 8px rgba(5,150,105,.2)}
.btn-done:hover{background:#047857}
.btn-done:disabled{opacity:.55;cursor:not-allowed}

/* ── Toast notifications ── */
.toast{position:fixed;bottom:1.6rem;right:1.6rem;background:#1e1e1e;color:#fff;padding:.75rem 1.15rem;border-radius:10px;font-size:.84rem;box-shadow:0 6px 28px rgba(0,0,0,.28);opacity:0;transform:translateY(8px);transition:all .28s ease;pointer-events:none;z-index:999;max-width:290px;font-weight:500}
.toast.show{opacity:1;transform:translateY(0)}
.toast.success{background:var(--green)}
.toast.error{background:var(--brand)}

/* ── Done panel ── */
.done-panel{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow-md);text-align:center;padding:4rem 2rem;border:1px solid var(--gray-200)}
.done-panel .d-icon{font-size:3.5rem;margin-bottom:1.1rem;display:block}
.done-panel h2{color:var(--green);font-size:1.55rem;margin-bottom:.65rem;font-weight:800}
.done-panel p{color:var(--gray-500);font-size:.93rem;line-height:1.7}
.done-panel strong{color:var(--gray-700)}

/* ── Responsive ── */
@media(max-width:600px){
  .top-bar{padding:.65rem 1rem}
  .top-bar-divider{display:none}
  .doc-row{flex-direction:column;gap:.75rem}
  .doc-actions{align-items:flex-start;flex-direction:row;flex-wrap:wrap;gap:.4rem}
  .main{padding:0 .6rem 5rem}
  .panel-header,.panel-footer,.doc-row{padding-left:1rem;padding-right:1rem}
  .cat-header{padding-left:1rem;padding-right:1rem}
  .upload-msg{max-width:100%}
}

/* ── Disclaimer modal ── */
.disc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem;backdrop-filter:blur(3px)}
.disc-modal{background:#fff;border-radius:18px;max-width:560px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,.35);overflow:hidden;animation:discIn .28s cubic-bezier(.34,1.56,.64,1)}
@keyframes discIn{from{opacity:0;transform:scale(.92) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}
.disc-header{background:#1a1a1a;padding:1.4rem 1.8rem 1.3rem;display:flex;align-items:center;gap:.85rem;border-bottom:2px solid var(--brand)}
.disc-header img{height:32px;object-fit:contain;flex-shrink:0}
.disc-header-text h2{font-size:.85rem;font-weight:700;color:#fff;letter-spacing:.01em}
.disc-header-text p{font-size:.63rem;color:rgba(255,255,255,.4);letter-spacing:.08em;text-transform:uppercase;margin-top:.1rem}
.disc-body{padding:1.7rem 1.8rem 1.4rem}
.disc-label{font-size:.65rem;font-weight:800;color:var(--brand);letter-spacing:.12em;text-transform:uppercase;margin-bottom:.7rem;display:flex;align-items:center;gap:.4rem}
.disc-label::before{content:'';display:inline-block;width:3px;height:13px;background:var(--brand);border-radius:2px}
.disc-text{background:#fef2f2;border:1.5px solid rgba(143,5,5,.15);border-radius:10px;padding:1rem 1.15rem;font-size:.84rem;color:#374151;line-height:1.75;margin-bottom:1.5rem}
.disc-text ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.55rem}
.disc-text li{display:flex;align-items:flex-start;gap:.65rem}
.disc-text li::before{content:'';display:block;width:6px;height:6px;border-radius:50%;background:var(--brand);margin-top:.52em;flex-shrink:0}
.disc-footer{display:flex;align-items:center;gap:.75rem}
.disc-checkbox-wrap{display:flex;align-items:center;gap:.55rem;cursor:pointer;flex:1}
.disc-checkbox-wrap input[type=checkbox]{width:17px;height:17px;accent-color:var(--brand);cursor:pointer;flex-shrink:0}
.disc-checkbox-wrap span{font-size:.78rem;color:var(--gray-600);line-height:1.4;user-select:none}
.disc-btn{padding:.72rem 1.4rem;background:#ccc;color:#fff;border:none;border-radius:9px;font-size:.85rem;font-weight:700;cursor:not-allowed;transition:background .2s,transform .1s;white-space:nowrap;font-family:inherit;flex-shrink:0}
.disc-btn.ready{background:var(--brand);cursor:pointer}
.disc-btn.ready:hover{background:var(--brand-dark);transform:translateY(-1px)}
.disc-btn.ready:active{transform:translateY(0)}
@media(max-width:520px){
  .disc-body{padding:1.3rem 1.2rem 1.1rem}
  .disc-footer{flex-direction:column;align-items:stretch}
  .disc-btn{text-align:center}
}
</style>
</head>
<body>

<!-- ── Disclaimer modal ── -->
<div class="disc-overlay" id="discOverlay">
  <div class="disc-modal" role="dialog" aria-modal="true" aria-labelledby="discTitle">
    <div class="disc-header">
      <img src="https://tdotimm.com/_next/image?url=%2Ftdot_logo_inv.webp&w=128&q=75" alt="TDOT Immigration">
      <div class="disc-header-text">
        <h2 id="discTitle">Document Submission Guidelines</h2>
        <p>Please read before uploading</p>
      </div>
    </div>
    <div class="disc-body">
      <div class="disc-label">Disclaimer</div>
      <div class="disc-text">
        <ul>${(Array.isArray(disclaimer) ? disclaimer : [disclaimer])
          .map(b => `<li><span>${esc(b.trim())}</span></li>`)
          .join('')}</ul>
      </div>
      <div class="disc-footer">
        <label class="disc-checkbox-wrap">
          <input type="checkbox" id="discCheck" onchange="toggleDiscBtn()">
          <span>I have read and understood the above disclaimer</span>
        </label>
        <button class="disc-btn" id="discBtn" disabled onclick="dismissDisclaimer()">I Understand</button>
      </div>
    </div>
  </div>
</div>

<div class="top-bar">
  <div class="top-bar-brand">
    <img src="https://tdotimm.com/_next/image?url=%2Ftdot_logo_inv.webp&w=128&q=75" alt="TDOT Immigration" class="top-bar-logo">
    <div class="top-bar-divider"></div>
    <div class="top-bar-info">
      <h1>${esc(clientName)}</h1>
      <div class="case-ref">Case Ref: ${esc(caseRef)}</div>
    </div>
  </div>
</div>

<div class="progress-wrap">
  <div class="progress-text" id="progressLabel">${uploadedDocs} of ${totalDocs} documents uploaded (${pct}%)</div>
  <div class="progress-track"><div class="progress-fill" id="progressFill" style="width:${pct}%"></div></div>
</div>

${flaggedCount > 0 ? `
<div class="flagged-banner" id="flaggedBanner">
  <span class="flagged-banner-icon">⚠️</span>
  <span class="flagged-banner-text">
    <strong>${flaggedCount} document${flaggedCount !== 1 ? 's' : ''} require${flaggedCount === 1 ? 's' : ''} re-upload.</strong>
    Our case officer has left notes — please review and re-upload the highlighted documents.
  </span>
  <button class="flagged-banner-btn" onclick="jumpToFirstFlagged()">Review Now →</button>
</div>` : ''}

<div class="steps-wrap">
  <div class="steps-inner">${stepPills}</div>
</div>

<div class="main" id="mainContent">
  ${panels}
</div>

<div class="toast" id="toast"></div>

<script>
const CASE_REF      = ${JSON.stringify(caseRef)};
const TOTAL         = ${total};
const FIRST_FLAGGED = ${firstFlaggedStep};
let currentStep   = 0;
let uploadedCount = ${uploadedDocs};
let totalCount    = ${totalDocs};

// ── Disclaimer modal ──────────────────────────────────────────────────────────
function toggleDiscBtn() {
  const checked = document.getElementById('discCheck').checked;
  const btn     = document.getElementById('discBtn');
  btn.disabled  = !checked;
  btn.classList.toggle('ready', checked);
}
function dismissDisclaimer() {
  const overlay = document.getElementById('discOverlay');
  if (!document.getElementById('discCheck').checked) return;
  overlay.style.opacity    = '0';
  overlay.style.transition = 'opacity .25s';
  setTimeout(() => {
    overlay.style.display        = 'none';
    document.body.style.overflow = '';   // restore page scrolling
  }, 260);
}
// Prevent background scroll while modal is open
document.body.style.overflow = 'hidden';
// ─────────────────────────────────────────────────────────────────────────────

const FLAGGED_SECTIONS = new Set(${JSON.stringify(
  steps
    .map((sec, idx) => (sec.items.some((i) => i.status === 'Rework Required') ? idx : -1))
    .filter((i) => i !== -1)
)});

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
    if (FLAGGED_SECTIONS.has(i)) pill.classList.add('flagged');
    if (i === currentStep) pill.classList.add('active');
    else if (i < currentStep) pill.classList.add('done');
  }
  document.getElementById('pill_' + currentStep)
    .scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

function jumpToFirstFlagged() {
  if (FIRST_FLAGGED === -1) return;
  goToStep(FIRST_FLAGGED);
  setTimeout(() => {
    const first = document.querySelector('#panel_' + FIRST_FLAGGED + ' .needs-action');
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      first.style.transition = 'box-shadow .3s';
      first.style.boxShadow  = '0 0 0 3px rgba(249,115,22,.5)';
      setTimeout(() => { first.style.boxShadow = ''; }, 1800);
    }
  }, 350);
}

if (FIRST_FLAGGED !== -1) {
  jumpToFirstFlagged();
} else {
  goToStep(0);
}

// ── Document reply to case officer note ──────────────────────────────────────

function openDocReply(itemId) {
  const area = document.getElementById('reply-area_' + itemId);
  if (!area) return;
  // Check if editor already open
  if (area.querySelector('.doc-reply-editor')) return;

  // Hide the reply button
  const btn = area.querySelector('.doc-reply-btn');
  if (btn) btn.style.display = 'none';

  const editor = document.createElement('div');
  editor.className = 'doc-reply-editor';

  const ta = document.createElement('textarea');
  ta.placeholder = 'Type your reply or question for your case officer...';
  editor.appendChild(ta);

  const actions = document.createElement('div');
  actions.className = 'doc-reply-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'doc-reply-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = function () {
    editor.remove();
    if (btn) btn.style.display = '';
  };

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'doc-reply-send';
  sendBtn.textContent = 'Send Reply';
  sendBtn.onclick = async function () {
    const reply = ta.value.trim();
    if (!reply) { alert('Please type a reply before sending.'); return; }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';

    try {
      const res = await fetch('/documents/' + encodeURIComponent(CASE_REF) + '/reply-note', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ itemId: itemId, reply: reply }),
      });
      if (!res.ok) throw new Error('Server error ' + res.status);

      // Replace editor with sent confirmation
      editor.remove();
      if (btn) btn.remove();

      const sent = document.createElement('div');
      sent.className = 'doc-reply-sent';
      sent.innerHTML = '<strong>\u2709\ufe0f Your reply:</strong> ' +
        reply.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') +
        '<div style="font-size:.65rem;color:#6b7280;margin-top:4px;">Sent just now</div>';
      area.appendChild(sent);

      showToast('Reply sent to case officer', 'success');
    } catch (err) {
      alert('Could not send reply: ' + err.message);
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Reply';
    }
  };

  actions.appendChild(cancelBtn);
  actions.appendChild(sendBtn);
  editor.appendChild(actions);
  area.appendChild(editor);
  ta.focus();
}

function updateProgress() {
  const pct = totalCount ? Math.round((uploadedCount / totalCount) * 100) : 0;
  document.getElementById('progressLabel').textContent =
    uploadedCount + ' of ' + totalCount + ' documents uploaded (' + pct + '%)';
  document.getElementById('progressFill').style.width = pct + '%';
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast'; }, 3500);
}

async function handleUpload(itemId, caseRef, input) {
  const files = Array.from(input.files);
  if (!files.length) return;

  const prog  = document.getElementById('prog_'  + itemId);
  const pbar  = document.getElementById('pbar_'  + itemId);
  const msg   = document.getElementById('umsg_'  + itemId);
  const row   = document.getElementById('doc_'   + itemId);
  const label = row.querySelector('.btn-upload');

  const wasAlreadyUploaded = row.dataset.status && row.dataset.status !== 'Missing';

  prog.style.display = 'block';
  pbar.style.width   = '0%';
  msg.textContent    = files.length > 1 ? \`Uploading 1 of \${files.length}…\` : 'Uploading…';
  msg.style.color    = '#888';
  if (label) { label.style.pointerEvents = 'none'; label.style.opacity = '.6'; }

  let succeeded = 0;
  let failed    = 0;
  const failedNames = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    // Progress reflects files done so far
    pbar.style.width = Math.round((i / files.length) * 90) + '%';
    if (files.length > 1) {
      msg.textContent = \`Uploading \${i + 1} of \${files.length}: \${file.name}\`;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res  = await fetch(
        '/documents/' + encodeURIComponent(caseRef) + '/upload/' + itemId,
        { method: 'POST', body: formData }
      );
      const data = await res.json();

      if (data.success) {
        succeeded++;
      } else {
        failed++;
        failedNames.push(file.name);
        showToast('Failed: ' + file.name, 'error');
      }
    } catch (e) {
      failed++;
      failedNames.push(file.name);
      showToast('Network error: ' + file.name, 'error');
    }
  }

  pbar.style.width = '100%';

  if (succeeded > 0) {
    const uploadLabel = succeeded === 1 ? '1 file' : succeeded + ' files';
    msg.textContent = failed === 0
      ? (files.length > 1 ? \`✓ \${uploadLabel} uploaded\` : '✓ Uploaded successfully')
      : \`✓ \${uploadLabel} uploaded, \${failed} failed\`;
    msg.style.color = failed > 0 ? '#d97706' : '#10b981';

    row.dataset.status = 'Received';
    const statusEl = row.querySelector('.doc-status');
    if (statusEl) {
      statusEl.style.background = '#eff6ff';
      statusEl.style.color      = '#2563eb';
      statusEl.style.boxShadow  = '0 0 0 1px rgba(37,99,235,.15)';
      statusEl.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#2563eb;display:inline-block;flex-shrink:0"></span>Received';
    }

    if (!wasAlreadyUploaded) {
      uploadedCount++;
      updateProgress();
      updatePanelMeta(currentStep);
    }

    showToast(files.length > 1 ? \`\${succeeded} file\${succeeded !== 1 ? 's' : ''} uploaded!\` : 'Document uploaded!');
  } else {
    msg.textContent = '⚠ All uploads failed. Please try again.';
    msg.style.color = '#dc2626';
    showToast('Upload failed', 'error');
  }

  setTimeout(() => { prog.style.display = 'none'; pbar.style.width = '0'; }, 1800);
  if (label) { label.style.pointerEvents = ''; label.style.opacity = ''; }
  input.value = '';
}

function updatePanelMeta(idx) {
  const panel = document.getElementById('panel_' + idx);
  if (!panel) return;
  const rows     = panel.querySelectorAll('.doc-row');
  let   uploaded = 0;
  rows.forEach((r) => {
    if (r.dataset.status && r.dataset.status !== 'Missing') uploaded++;
  });
  const meta = document.getElementById('pmeta_' + idx);
  if (meta) meta.textContent = uploaded + ' of ' + rows.length + ' uploaded';
  // Also update cat-count badges inside member panels
  panel.querySelectorAll('.cat-group').forEach((grp) => {
    const grpRows = grp.querySelectorAll('.doc-row');
    let grpUpl = 0;
    grpRows.forEach((r) => { if (r.dataset.status && r.dataset.status !== 'Missing') grpUpl++; });
    const badge = grp.querySelector('.cat-count');
    if (badge) badge.textContent = grpUpl + ' / ' + grpRows.length;
  });
}

async function submitDone() {
  const btn = document.querySelector('.btn-done');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

  try {
    await fetch('/documents/' + encodeURIComponent(CASE_REF) + '/complete', { method: 'POST' });
  } catch (_) {
    // Best-effort — show the done panel regardless
  }

  document.getElementById('mainContent').innerHTML = \`
    <div class="done-panel">
      <div class="d-icon">🎉</div>
      <h2>Documents Submitted!</h2>
      <p>Thank you. Your uploaded documents have been received by your consultant.<br><br>
         <strong>Case Reference: \${CASE_REF}</strong><br><br>
         You will be contacted if any additional documents are needed.</p>
    </div>\`;
  document.querySelector('.steps-wrap').style.display   = 'none';
  document.querySelector('.progress-wrap').style.display = 'none';
}
</script>
</body>
</html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Landing page — also handles ?ref= redirect (works with and without JS)
router.get('/', (req, res) => {
  const ref = req.query.ref?.trim();
  if (ref) return res.redirect(`/documents/${encodeURIComponent(ref)}`);
  res.send(landingPage(req.query.error || ''));
});

// Document upload form
router.get('/:caseRef', async (req, res) => {
  const caseRef = decodeURIComponent(req.params.caseRef).trim();
  try {
    const { items, clientName, disclaimer } = await getCaseSummary(caseRef);
    if (!items.length) {
      return res.redirect(
        `/documents?error=${encodeURIComponent(
          `No documents found for case "${caseRef}". Please check your case reference number.`
        )}`
      );
    }
    const { hasDualPhase, phases } = groupByPhase(items);
    // For backward compat: single-phase cases pass members/isMultiMember directly
    const { isMultiMember, members } = phases[0];
    res.send(formPage(caseRef, clientName, members, isMultiMember, disclaimer, hasDualPhase ? phases : null));
  } catch (err) {
    console.error('[DocForm] Error loading form:', err.message);
    res.redirect(
      `/documents?error=${encodeURIComponent('An error occurred. Please try again later.')}`
    );
  }
});

// File upload handler
router.post('/:caseRef/upload/:itemId', upload.single('file'), async (req, res) => {
  const caseRef = decodeURIComponent(req.params.caseRef).trim();
  const itemId  = req.params.itemId;
  const file    = req.file;

  if (!validateCaseRef(caseRef)) {
    return res.status(400).json({ success: false, error: 'Invalid case reference format.' });
  }
  if (!validateItemId(itemId)) {
    return res.status(400).json({ success: false, error: 'Invalid item ID.' });
  }
  if (!file) {
    return res.status(400).json({ success: false, error: 'No file provided.' });
  }

  // Server-side file type validation
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return res.status(400).json({
      success: false,
      error:   `File type "${ext}" is not allowed. Accepted: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    });
  }

  try {
    await uploadFileToOneDrive(itemId, caseRef, file.buffer, file.originalname, file.mimetype);
    await markDocumentReceived(itemId);
    res.json({ success: true });

    // Non-blocking post-upload housekeeping
    updateLastActivityDate(caseRef).catch((e) =>
      console.error('[DocForm] updateLastActivityDate failed:', e.message)
    );
    calculateForCaseRef(caseRef).catch((e) =>
      console.error('[DocForm] calculateForCaseRef failed:', e.message)
    );
  } catch (err) {
    console.error('[DocForm] Upload error for item', itemId, ':', err.message);
    res.status(500).json({ success: false, error: 'Upload failed. Please try again.' });
  }
});

// ─── Client reply to document review note ───────────────────────────────────

router.post('/:caseRef/reply-note', async (req, res) => {
  const caseRef = decodeURIComponent(req.params.caseRef).trim();
  const { itemId, reply } = req.body || {};

  if (!validateCaseRef(caseRef)) {
    return res.status(400).json({ success: false, error: 'Invalid case reference format.' });
  }
  if (!validateItemId(itemId)) {
    return res.status(400).json({ success: false, error: 'Invalid item ID.' });
  }
  if (!reply || !reply.trim()) {
    return res.status(400).json({ success: false, error: 'Reply text is required.' });
  }
  if (reply.length > MAX_REPLY_LENGTH) {
    return res.status(400).json({ success: false, error: `Reply must be under ${MAX_REPLY_LENGTH} characters.` });
  }

  try {
    // Post the client's reply as a Monday.com comment on the document execution item
    await mondayApi.query(
      `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      {
        itemId: String(itemId),
        body:   `\u2709\ufe0f Client Reply\n\nCase: ${caseRef}\n\n"${reply.trim()}"\n\nPosted from the Document Upload Portal at ${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: true })} (Toronto).`,
      }
    );

    console.log(`[DocForm] Client reply posted for item ${itemId} on case ${caseRef}`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[DocForm] Reply error for item ${itemId}:`, err.message);
    return res.status(500).json({ success: false, error: 'Could not post reply.' });
  }
});

// Done handler — client explicitly marks all documents as submitted
router.post('/:caseRef/complete', (req, res) => {
  const caseRef = decodeURIComponent(req.params.caseRef).trim();
  console.log(`[DocForm] Client marked case ${caseRef} as complete`);
  res.json({ success: true });
});

module.exports = router;
