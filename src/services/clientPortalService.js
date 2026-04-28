/**
 * Client Portal Service
 *
 * Builds the unified client-facing landing page at /client/:caseRef?t=<token>.
 * One URL, one bookmarkable view that surfaces:
 *   - Case header (name, ref, current stage)
 *   - Pending actions banner (rework docs, missing Q fields)
 *   - Questionnaire card (completion %, last saved, "Continue" button)
 *   - Documents card (received/total, "Manage Documents" button)
 *   - Contact strip
 *
 * All state is queried LIVE from Monday + OneDrive on every page load — no
 * caching. The portal never writes; it's a read-only aggregator over data
 * the existing services own. That means:
 *   - Webhook automation logic is untouched
 *   - The questionnaire and document upload flows continue to work as the
 *     authoritative entry points; the portal just routes clients to them
 *
 * Token security mirrors /q/<caseRef> exactly — uses
 * htmlQuestionnaireService.validateAccess so a stale or wrong token returns
 * the same error as the Q page would.
 */

'use strict';

const mondayApi    = require('./mondayApi');
const docFormSvc   = require('./documentFormService');
const htmlQ        = require('./htmlQuestionnaireService');
const { clientMasterBoardId } = require('../../config/monday');

const BASE_URL = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';

// Reuse the same column IDs the rest of the system uses.
const CM = {
  caseRef:           'text_mm142s49',
  caseType:          'dropdown_mm0xd1qn',
  caseStage:         'color_mm0x8faa',
  qReadiness:        'numeric_mm0x9dea',
  qCompletionStatus: 'color_mm0x9s08',
  caseManager:       'multiple_person_mm0xhmgk',
  clientEmail:       'text_mm0xw6bp',
};

// ─── HTML escaping ──────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Live data fetch ────────────────────────────────────────────────────────

/**
 * Fetch every piece of live state needed to render the portal in ONE
 * Monday round-trip + parallel OneDrive/document calls.
 */
async function getPortalSnapshot({ caseRef, validatedCase }) {
  // validatedCase already has: itemId, clientName, caseType, caseSubType, accessToken, formFiles
  const itemId = validatedCase.itemId;

  // 1. Pull stage + Q readiness directly off the CM row
  const cmData = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         column_values(ids: [
           "${CM.caseStage}", "${CM.qReadiness}", "${CM.qCompletionStatus}"
         ]) { id text value }
       }
     }`,
    { itemId: String(itemId) }
  ).catch(() => null);
  const cmCols = cmData?.items?.[0]?.column_values || [];
  const colTxt = (id) => (cmCols.find(c => c.id === id)?.text || '').trim();

  const caseStage         = colTxt(CM.caseStage)         || 'Not Started';
  const qReadinessRaw     = colTxt(CM.qReadiness);
  const qReadinessPct     = qReadinessRaw ? Math.max(0, Math.min(100, Math.round(Number(qReadinessRaw)))) : 0;
  const qCompletionStatus = colTxt(CM.qCompletionStatus) || '';

  // 2. Document summary + Q members in parallel
  const [docSummary, members] = await Promise.all([
    docFormSvc.getCaseSummary(caseRef).catch(() => ({ items: [] })),
    htmlQ.loadMembers({ clientName: validatedCase.clientName, caseRef }).catch(() => []),
  ]);

  // 3. Compute document counts
  const docItems = docSummary?.items || [];
  const docCounts = { total: docItems.length, received: 0, reviewed: 0, rework: 0, missing: 0 };
  const reworkDocs = [];
  for (const it of docItems) {
    const s = it.status || 'Missing';
    if (s === 'Received')               docCounts.received++;
    else if (s === 'Reviewed')          docCounts.reviewed++;
    else if (s === 'Rework Required') { docCounts.rework++; reworkDocs.push(it); }
    else                                docCounts.missing++;
  }

  // 4. Questionnaire status — submitted member count from manifest
  const totalMembers     = members.length || 1;
  const submittedMembers = members.filter(m => m.submittedAt).length;

  return {
    clientName: validatedCase.clientName,
    caseRef,
    caseType:    validatedCase.caseType,
    caseSubType: validatedCase.caseSubType,
    caseStage,
    accessToken: validatedCase.accessToken,
    qReadinessPct,
    qCompletionStatus,
    docCounts,
    reworkDocs,
    totalMembers,
    submittedMembers,
  };
}

// ─── Page builder ───────────────────────────────────────────────────────────

function buildPortalPage(snap) {
  const tokenParam   = snap.accessToken ? `?t=${encodeURIComponent(snap.accessToken)}` : '';
  const encodedRef   = encodeURIComponent(snap.caseRef);
  const qUrl         = `${BASE_URL}/q/${encodedRef}${tokenParam}`;
  const docUrl       = `${BASE_URL}/documents/${encodedRef}`;

  // Q card colour cue based on readiness
  const qPct      = snap.qReadinessPct;
  const qDone     = snap.submittedMembers === snap.totalMembers && qPct >= 100;
  const qLabel    = qDone ? 'Submitted' : (qPct > 0 ? 'In Progress' : 'Not Started');
  const qBtnText  = qDone ? 'Review Your Answers →' : (qPct > 0 ? 'Continue Filling →' : 'Start Questionnaire →');

  // Doc card status
  const docTotal      = snap.docCounts.total;
  const docDone       = docTotal > 0 ? (snap.docCounts.received + snap.docCounts.reviewed) : 0;
  const docPct        = docTotal > 0 ? Math.round(docDone / docTotal * 100) : 0;
  const docBtnText    = docTotal === 0 ? 'View Your Documents →' : (docPct === 100 ? 'Review Documents →' : 'Continue Uploading →');

  // Pending actions list
  const pending = [];
  if (snap.docCounts.rework > 0) {
    pending.push(`📂 ${snap.docCounts.rework} document${snap.docCounts.rework === 1 ? '' : 's'} need re-upload (rework requested)`);
  }
  if (!qDone && qPct < 100) {
    pending.push(`📝 Questionnaire is ${qPct}% complete — please finish remaining fields`);
  }
  if (snap.totalMembers > 1 && snap.submittedMembers < snap.totalMembers) {
    const remaining = snap.totalMembers - snap.submittedMembers;
    pending.push(`👥 ${remaining} family member${remaining === 1 ? '' : 's'} still need${remaining === 1 ? 's' : ''} their questionnaire submitted`);
  }
  if (!pending.length) {
    pending.push('✅ Nothing pending right now — your case officer will be in touch.');
  }

  const pendingHtml = pending.map(p => `<li style="margin:6px 0;">${escHtml(p)}</li>`).join('');

  // Rework doc bullet list (top 5)
  const reworkSnippet = snap.reworkDocs.length
    ? `<div style="margin-top:10px;padding:10px 14px;background:#fef2f2;border-left:3px solid #fca5a5;border-radius:6px;">
         <strong style="color:#991b1b;font-size:13px;">Documents needing re-upload:</strong>
         <ul style="margin:6px 0 0 18px;padding:0;color:#7f1d1d;font-size:13px;">
           ${snap.reworkDocs.slice(0, 5).map(d => `<li>${escHtml(d.name || 'Document')}</li>`).join('')}
           ${snap.reworkDocs.length > 5 ? `<li style="font-style:italic;">+${snap.reworkDocs.length - 5} more</li>` : ''}
         </ul>
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Client Portal — ${escHtml(snap.caseRef)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #FAF8F4; color: #1F2937; }

    /* Dark brand header */
    .top {
      background:#0B1D32; color:#fff; padding:18px 28px;
      box-shadow:0 2px 8px rgba(0,0,0,.18);
      border-bottom:3px solid #C9A84C;        /* gold accent stripe */
      display:flex; align-items:center; justify-content:space-between; gap:20px; flex-wrap:wrap;
    }
    .top-brand { display:flex; align-items:center; gap:14px; min-width:0; }
    .top-brand img { height:38px; object-fit:contain; }
    .top h1 { font-size:18px; font-weight:700; line-height:1.25; }
    .top p  { font-size:12px; color:rgba(255,255,255,.65); margin-top:3px; }
    .stage-pill {
      display:inline-block; background:rgba(201,168,76,.18); color:#C9A84C;
      border:1px solid rgba(201,168,76,.35);
      font-size:11px; font-weight:700; padding:3px 10px; border-radius:999px;
      letter-spacing:.04em; margin-left:8px; vertical-align:middle;
    }

    .content { max-width: 760px; margin: 24px auto; padding: 0 18px 60px; }

    .pending {
      background:#FFF8E6; border:1px solid #F0D98A; border-radius:10px;
      padding:14px 18px; margin-bottom:20px;
      border-left:4px solid #C9A84C;
    }
    .pending h2 { font-size:13px; font-weight:700; color:#7A5F1F; margin-bottom:6px;
                  text-transform:uppercase; letter-spacing:.06em; }
    .pending ul { list-style:none; padding-left:0; font-size:14px; color:#5C4716; line-height:1.6; }

    .card {
      background:#FFFFFF; border-radius:12px; padding:22px 26px;
      box-shadow:0 1px 8px rgba(11,29,50,.06);
      border:1px solid #E7E2D6; margin-bottom:18px;
    }
    .card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:14px; }
    .card h3 { font-size:16px; color:#0B1D32; margin-bottom:4px; }
    .card .sub { font-size:12px; color:#6B7280; }
    .badge { display:inline-block; padding:3px 10px; border-radius:999px;
             font-size:11px; font-weight:700; letter-spacing:.03em; }
    .badge-ok      { background:#f0fdf4; color:#166534; border:1px solid #bbf7d0; }
    .badge-prog    { background:#FFF8E6; color:#7A5F1F; border:1px solid #F0D98A; }
    .badge-todo    { background:#F4F0E6; color:#6B7280; border:1px solid #E7E2D6; }
    .badge-warn    { background:#fef2f2; color:#991b1b; border:1px solid #fca5a5; }

    .progress-row { margin-top:14px; }
    .progress-bar { height:8px; background:#E7E2D6; border-radius:999px; overflow:hidden; }
    .progress-fill { height:100%; background:#8B0000; border-radius:999px; transition:width .3s; }
    .progress-meta { font-size:12px; color:#6B7280; margin-top:6px; display:flex; justify-content:space-between; }

    .btn {
      display:inline-block; margin-top:14px;
      background:#8B0000; color:#fff; padding:10px 20px;
      border-radius:8px; font-size:14px; font-weight:700; text-decoration:none;
      transition: background .15s;
    }
    .btn:hover { background:#6B0000; }
    .btn-light { background:#FFFFFF; color:#8B0000; border:1px solid #8B0000; }
    .btn-light:hover { background:#FAF1F1; }

    .case-meta {
      background:#FFFFFF; border:1px solid #E7E2D6; border-radius:10px;
      padding:12px 18px; margin-bottom:18px;
      display:flex; flex-wrap:wrap; gap:18px 24px; font-size:13px; color:#6B7280;
    }
    .case-meta strong { color:#0B1D32; }

    .footer {
      margin-top:24px; text-align:center; font-size:12px; color:#6B7280; line-height:1.6;
      padding-top:18px; border-top:1px solid #E7E2D6;
    }
    .footer-brand { color:#8B0000; font-weight:700; letter-spacing:.04em; }
  </style>
</head>
<body>
  <header class="top">
    <div class="top-brand">
      <img src="https://tdotimm.com/_next/image?url=%2Ftdot_logo_inv.webp&w=128&q=75" alt="TDOT Immigration">
      <div>
        <h1>${escHtml(snap.clientName)}<span class="stage-pill">${escHtml(snap.caseStage)}</span></h1>
        <p>Case ${escHtml(snap.caseRef)} · ${escHtml(snap.caseType || '')}${snap.caseSubType ? ' / ' + escHtml(snap.caseSubType) : ''}</p>
      </div>
    </div>
  </header>

  <main class="content">

    <div class="case-meta">
      <div>📋 <strong>Case:</strong> ${escHtml(snap.caseRef)}</div>
      <div>📌 <strong>Stage:</strong> ${escHtml(snap.caseStage)}</div>
      ${snap.totalMembers > 1 ? `<div>👥 <strong>Applicants:</strong> ${snap.submittedMembers} / ${snap.totalMembers} submitted</div>` : ''}
    </div>

    <section class="pending">
      <h2>📌 What's pending</h2>
      <ul>${pendingHtml}</ul>
    </section>

    <!-- Questionnaire card -->
    <section class="card">
      <div class="card-head">
        <div>
          <h3>📝 Questionnaire</h3>
          <div class="sub">Tell us about your background, history, and details for your case.</div>
        </div>
        <span class="badge ${qDone ? 'badge-ok' : (qPct > 0 ? 'badge-prog' : 'badge-todo')}">${escHtml(qLabel)}</span>
      </div>
      <div class="progress-row">
        <div class="progress-bar"><div class="progress-fill" style="width:${qPct}%;"></div></div>
        <div class="progress-meta">
          <span>${qPct}% complete</span>
          ${snap.totalMembers > 1 ? `<span>${snap.submittedMembers} of ${snap.totalMembers} family members submitted</span>` : ''}
        </div>
      </div>
      <a href="${escHtml(qUrl)}" class="btn">${escHtml(qBtnText)}</a>
    </section>

    <!-- Documents card -->
    <section class="card">
      <div class="card-head">
        <div>
          <h3>📂 Documents</h3>
          <div class="sub">${docTotal} document${docTotal === 1 ? '' : 's'} requested for this case.</div>
        </div>
        <span class="badge ${snap.docCounts.rework > 0 ? 'badge-warn' : (docPct === 100 ? 'badge-ok' : (docDone > 0 ? 'badge-prog' : 'badge-todo'))}">${docPct}% uploaded</span>
      </div>
      <div class="progress-row">
        <div class="progress-bar"><div class="progress-fill" style="width:${docPct}%;background:${snap.docCounts.rework > 0 ? '#8B0000' : '#0B1D32'};"></div></div>
        <div class="progress-meta">
          <span>${docDone} of ${docTotal} ready</span>
          ${snap.docCounts.rework > 0 ? `<span style="color:#991b1b;font-weight:700;">${snap.docCounts.rework} need re-upload</span>` : ''}
        </div>
      </div>
      ${reworkSnippet}
      <a href="${escHtml(docUrl)}" class="btn ${snap.docCounts.rework > 0 ? '' : 'btn-light'}">${escHtml(docBtnText)}</a>
    </section>

    <p class="footer">
      If you have questions, simply reply to the email your case officer sent you.<br>
      Please include your <strong>Case Reference Number</strong> in any correspondence.<br>
      <span class="footer-brand">TDOT IMMIGRATION SERVICES</span>
    </p>

  </main>
</body>
</html>`;
}

// ─── Helper used by caseRefService and backfill script ──────────────────────

function buildPortalUrl({ caseRef, accessToken }) {
  const tokenParam = accessToken ? `?t=${encodeURIComponent(accessToken)}` : '';
  return `${BASE_URL}/client/${encodeURIComponent(caseRef)}${tokenParam}`;
}

module.exports = {
  getPortalSnapshot,
  buildPortalPage,
  buildPortalUrl,
};
