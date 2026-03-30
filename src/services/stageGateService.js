/**
 * Stage Gate Service
 *
 * Manages automated case stage transitions based on readiness thresholds.
 *
 * Stage progression:
 *  Document Collection Started
 *    → Internal Review        (min threshold % met + no blocking items)
 *    → Submission Preparation (100% readiness + no blocking items)
 *    → Submission Ready       ← MANUAL — set by case supervisor in Monday.com
 *    → Automation Lock = Yes  ← triggered automatically when supervisor sets Submission Ready
 *
 * Two entry points:
 *  onThresholdMet()    — called by caseReadinessService when minThreshold crossed
 *  onFullyComplete()   — called by caseReadinessService when 100% + blocking = 0
 *  onSubmissionReady() — called by webhook handler when supervisor sets Submission Ready
 */

const { sendEmail: msSend } = require('./microsoftMailService');
const mondayApi             = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';

// ─── Column IDs — Client Master Board ────────────────────────────────────────
const CM = {
  caseStage:           'color_mm0x8faa',
  stageStartDate:      'date_mm0xjm1z',
  automationLock:      'color_mm0x3x1x',
  readyForReview:      'color_mm0xh2fh',
  readyForSubPrep:     'color_mm0xqsk4',
  chasingStage:        'color_mm1abve4',
  docThresholdMet:     'color_mm0xvxq2',
  caseManager:         'multiple_person_mm0xhmgk',
  opsSupervisor:       'multiple_person_mm0xp0sq',
  clientName:          'text_mm0x1zdk',
  caseRef:             'text_mm142s49',
  caseType:            'dropdown_mm0xd1qn',
  qReadiness:          'numeric_mm0x9dea',
  docReadiness:        'numeric_mm0x5g9x',
  escalationRequired:  'color_mm0x7bje',
  escalationReason:    'text_mm0xvpr9',
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

function extractPersonIds(colValue) {
  try {
    const parsed = JSON.parse(colValue || '{}');
    return (parsed.personsAndTeams || [])
      .filter((p) => p.kind === 'person')
      .map((p) => String(p.id));
  } catch {
    return [];
  }
}

async function fetchUserEmails(userIds) {
  if (!userIds.length) return [];
  const data = await mondayApi.query(
    `query($ids: [ID!]!) { users(ids: $ids) { id name email } }`,
    { ids: userIds }
  );
  return data?.users || [];
}

async function fetchCaseDetails(masterItemId) {
  const FETCH_IDS = [
    CM.caseRef, CM.caseType, CM.clientName, CM.caseStage, CM.automationLock,
    CM.caseManager, CM.opsSupervisor, CM.qReadiness, CM.docReadiness,
  ];
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         name
         column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text value }
       }
     }`,
    { itemId: String(masterItemId) }
  );
  return data?.items?.[0] || null;
}

async function updateColumns(masterItemId, colValues) {
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
     }`,
    {
      boardId:   String(clientMasterBoardId),
      itemId:    String(masterItemId),
      colValues: JSON.stringify(colValues),
    }
  );
}

async function postMondayComment(masterItemId, body) {
  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
    { itemId: String(masterItemId), body }
  );
}

async function sendEmail(to, subject, html) {
  if (!to.length) return;
  await msSend({ to, subject, html, replyTo: EMAIL_REPLY_TO || undefined });
  console.log(`[StageGate] ✉ Email sent to: ${to.join(', ')}`);
}

function teamEmailHtml({ badge, badgeColour, heading, body, caseRef, clientName, caseType }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px}
  .card{background:#fff;border-radius:12px;max-width:540px;margin:0 auto;padding:36px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
  .badge{display:inline-block;background:${badgeColour};color:#fff;font-size:.72rem;font-weight:700;
         padding:.25rem .7rem;border-radius:20px;margin-bottom:16px;letter-spacing:.5px;text-transform:uppercase}
  h2{font-size:1.15rem;color:#111;margin:0 0 16px}
  p{color:#374151;line-height:1.65;margin:0 0 12px;font-size:.94rem}
  .meta{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 18px;margin:18px 0;font-size:.88rem}
  .meta p{margin:0 0 6px}.meta p:last-child{margin:0}
  hr{border:none;border-top:1px solid #e5e7eb;margin:22px 0}
  .footer{font-size:.78rem;color:#9ca3af;text-align:center}
  strong{color:#111}
</style></head>
<body><div class="card">
  <span class="badge">${badge}</span>
  <h2>${heading}</h2>
  ${body}
  <div class="meta">
    <p><strong>Case Reference:</strong> ${caseRef}</p>
    <p><strong>Client:</strong> ${clientName || '—'}</p>
    <p><strong>Case Type:</strong> ${caseType || '—'}</p>
  </div>
  <hr>
  <p class="footer">TDOT Immigration &nbsp;|&nbsp; Automated stage gate notification</p>
</div></body></html>`;
}

// ─── Gate 1: Threshold met → Internal Review ──────────────────────────────────

/**
 * Called when readiness ≥ minThreshold AND blocking = 0.
 * Case must currently be in Document Collection Started.
 */
async function onThresholdMet({ masterItemId, caseRef, caseType }) {
  const item = await fetchCaseDetails(masterItemId);
  if (!item) return;

  const col      = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
  const colValue = (id) => item.column_values.find((c) => c.id === id)?.value || '';

  // Only advance from Document Collection Started
  if (col(CM.caseStage) !== 'Document Collection Started') {
    console.log(`[StageGate] ${caseRef} not in Document Collection Started — skipping threshold gate`);
    return;
  }

  const clientName = col(CM.clientName);
  const qPct       = col(CM.qReadiness);
  const docPct     = col(CM.docReadiness);
  const today      = new Date().toISOString().split('T')[0];

  // Advance stage + reset Stage Start Date for fresh SLA clock
  await updateColumns(masterItemId, {
    [CM.caseStage]:      { label: 'Internal Review' },
    [CM.stageStartDate]: { date: today              },
    [CM.readyForReview]: { label: 'Done'            },
    [CM.docThresholdMet]:{ label: 'Yes'             },
    [CM.chasingStage]:   { label: 'Resolved'        },
  });
  console.log(`[StageGate] ✓ ${caseRef} → Internal Review (Q:${qPct}% Doc:${docPct}%)`);

  // Post Monday.com comment
  await postMondayComment(
    masterItemId,
    `📋 *Case Ready for Internal Review*\n\n` +
    `${caseRef} (${clientName || 'client'}) has met the readiness threshold.\n` +
    `Q: ${qPct}% | Docs: ${docPct}% | No blocking items.\n\n` +
    `The case has been moved to **Internal Review**. Please review the client submissions.`
  );

  // Notify Ops Supervisor + Case Manager
  try {
    const ids   = [...new Set([
      ...extractPersonIds(colValue(CM.opsSupervisor)),
      ...extractPersonIds(colValue(CM.caseManager)),
    ])];
    const users = await fetchUserEmails(ids);
    const to    = users.map((u) => u.email).filter(Boolean);
    await sendEmail(
      to,
      `Internal Review Required — ${caseRef}`,
      teamEmailHtml({
        badge: 'Internal Review', badgeColour: '#2563eb',
        heading: '📋 Case ready for Internal Review',
        body: `<p>A client case has reached the readiness threshold and is now ready for your internal review.</p>
               <p>Questionnaire: <strong>${qPct}%</strong> | Documents: <strong>${docPct}%</strong> | No blocking items.</p>
               <p>Please log in to Monday.com and begin your review at your earliest convenience.</p>`,
        caseRef, clientName, caseType,
      })
    );
  } catch (err) {
    console.warn(`[StageGate] Notification email failed for ${caseRef}:`, err.message);
  }
}

// ─── Gate 2: Fully complete → Submission Preparation ─────────────────────────

/**
 * Called when readiness = 100% AND blocking = 0 on both boards.
 * Case must currently be in Internal Review.
 */
async function onFullyComplete({ masterItemId, caseRef, caseType }) {
  const item = await fetchCaseDetails(masterItemId);
  if (!item) return;

  const col      = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
  const colValue = (id) => item.column_values.find((c) => c.id === id)?.value || '';

  // Only advance from Internal Review
  if (col(CM.caseStage) !== 'Internal Review') {
    console.log(`[StageGate] ${caseRef} not in Internal Review — skipping submission prep gate`);
    return;
  }

  const clientName = col(CM.clientName);
  const today      = new Date().toISOString().split('T')[0];

  // Advance stage + reset Stage Start Date for fresh SLA clock
  await updateColumns(masterItemId, {
    [CM.caseStage]:      { label: 'Submission Preparation' },
    [CM.stageStartDate]: { date: today                    },
    [CM.readyForSubPrep]:{ label: 'Done'                  },
  });
  console.log(`[StageGate] ✓ ${caseRef} → Submission Preparation (100% complete)`);

  await postMondayComment(
    masterItemId,
    `✅ *Case Ready for Submission Preparation*\n\n` +
    `${caseRef} (${clientName || 'client'}) has reached 100% readiness with no blocking items.\n\n` +
    `The case has been moved to **Submission Preparation**. Please complete your review and mark the case as Submission Ready when ready.`
  );

  // Notify Case Manager
  try {
    const ids   = extractPersonIds(colValue(CM.caseManager));
    const users = await fetchUserEmails(ids);
    const to    = users.map((u) => u.email).filter(Boolean);
    await sendEmail(
      to,
      `Submission Preparation — ${caseRef}`,
      teamEmailHtml({
        badge: 'Submission Prep', badgeColour: '#059669',
        heading: '✅ Case ready for Submission Preparation',
        body: `<p>A client case has reached <strong>100% completion</strong> with no blocking items and is now ready for submission preparation.</p>
               <p>Please complete your review and mark the case as <strong>Submission Ready</strong> in Monday.com when you are satisfied with all submissions.</p>`,
        caseRef, clientName, caseType,
      })
    );
  } catch (err) {
    console.warn(`[StageGate] Submission prep email failed for ${caseRef}:`, err.message);
  }
}

// ─── Gate 3: Supervisor manually sets Submission Ready → lock ─────────────────

/**
 * Called via webhook when case supervisor manually changes
 * Case Stage → Submission Ready.
 * Sets Automation Lock = Yes to freeze further changes.
 */
async function onSubmissionReady({ masterItemId, caseRef }) {
  console.log(`[StageGate] 🔒 Supervisor marked ${caseRef} as Submission Ready — locking`);

  await updateColumns(masterItemId, {
    [CM.automationLock]: { label: 'Yes' },
  });

  await postMondayComment(
    masterItemId,
    `🔒 *Case Locked — Submission Ready*\n\n` +
    `${caseRef} has been marked as Submission Ready by the case supervisor.\n` +
    `The case is now locked. No further automated changes will be made.`
  );

  console.log(`[StageGate] ✅ ${caseRef} locked at Submission Ready`);
}

// ─── Terminal stage: lock case and stop all engines ───────────────────────────

/**
 * Update these labels if your Monday.com board uses different values for
 * terminal (end-of-case) stages.
 */
const TERMINAL_STAGES = new Set(['Closed', 'Withdrawn', 'Cancelled']);

/**
 * Called by the webhook when Case Stage is set to a terminal value
 * (Closed, Withdrawn, Cancelled) in Monday.com.
 *
 * Sets Automation Lock = Yes so all daily engines skip the item going forward,
 * resets Chasing Stage to Resolved to stop any in-flight chasing state,
 * and clears Escalation Required / Escalation Reason.
 *
 * Safe to call multiple times — all writes are idempotent.
 *
 * @param {{ masterItemId: string|number, newStage: string, caseRef: string }} param
 */
async function onCaseClosed({ masterItemId, newStage, caseRef }) {
  await updateColumns(masterItemId, {
    [CM.automationLock]:     { label: 'Yes'      },
    [CM.chasingStage]:       { label: 'Resolved' },
    [CM.escalationRequired]: { label: 'No'       },
    [CM.escalationReason]:   '',
  });

  await postMondayComment(
    masterItemId,
    `🔒 *Case ${newStage}*\n\n` +
    `${caseRef} has been marked as **${newStage}**.\n` +
    `Automation Lock has been set — all automated engines (SLA, health, chasing, escalation) will now skip this case.`
  );

  console.log(`[StageGate] 🔒 ${caseRef} → ${newStage} — locked and chasing cleared`);
}

// ─── Manual stage advance: reset Stage Start Date ─────────────────────────────

/**
 * Called by the webhook when Case Stage is manually set to "Internal Review"
 * or "Submission Preparation" directly in Monday.com (bypassing the automated
 * threshold gates).
 *
 * Also fires when the automated gates advance the stage (since they update
 * Case Stage via a mutation which triggers the webhook). In that case the
 * Stage Start Date was already set to today in the same mutation, so writing
 * it again is a harmless no-op.
 *
 * Deliberately does NOT touch Chasing Stage — the automated path already
 * sets it to "Resolved" in the same mutation, and we must not overwrite it.
 *
 * @param {{ masterItemId: string|number, newStage: string, caseRef: string }} param
 */
async function onStageAdvanced({ masterItemId, newStage, caseRef }) {
  const today = new Date().toISOString().split('T')[0];
  await updateColumns(masterItemId, {
    [CM.stageStartDate]: { date: today },
  });
  console.log(`[StageGate] Stage Start Date reset to ${today} for ${caseRef} (→ ${newStage})`);
}

module.exports = { onThresholdMet, onFullyComplete, onSubmissionReady, onStageAdvanced, onCaseClosed, TERMINAL_STAGES };
