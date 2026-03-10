/**
 * Automation Lock Service
 *
 * Triggered by caseReadinessService when a case reaches 100% readiness
 * with zero blocking items.
 *
 * Actions:
 *  1. Set Automation Lock = Yes     (freeze the case)
 *  2. Set Case Stage → Internal Review
 *  3. Set Chasing Stage = Resolved  (stop reminder emails)
 *  4. Set Ready for Internal Review = Done
 *  5. Post a comment on the Master item (notifies Monday subscribers)
 *  6. Email Case Manager + Ops Supervisor via Resend (if configured)
 */

const { Resend }  = require('resend');
const mondayApi   = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const resend       = new Resend(process.env.RESEND_API_KEY);
const EMAIL_FROM   = process.env.EMAIL_FROM   || 'TDOT Immigration <noreply@tdotimmigration.ca>';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';
const BASE_URL     = process.env.RENDER_URL   || 'https://tdot-automations.onrender.com';

// ─── Column IDs — Client Master Board ────────────────────────────────────────
const CM = {
  caseStage:       'color_mm0x8faa',
  automationLock:  'color_mm0x3x1x',
  readyForReview:  'color_mm0xh2fh',
  chasingStage:    'color_mm1abve4',
  caseManager:     'multiple_person_mm0xhmgk',
  opsSupervisor:   'multiple_person_mm0xp0sq',
  clientName:      'text_mm0x1zdk',
  caseRef:         'text_mm142s49',
  caseType:        'dropdown_mm0xd1qn',
  qReadiness:      'numeric_mm0x9dea',
  docReadiness:    'numeric_mm0x5g9x',
};

// ─── Fetch item details needed for notification ───────────────────────────────

async function fetchCaseDetails(masterItemId) {
  const FETCH_IDS = [
    CM.caseRef, CM.caseType, CM.clientName,
    CM.caseManager, CM.opsSupervisor,
    CM.qReadiness, CM.docReadiness,
    CM.automationLock,
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

// ─── Extract person IDs from a people column value ────────────────────────────

function extractPersonIds(colValue) {
  try {
    const parsed = JSON.parse(colValue || '{}');
    return (parsed.personsAndTeams || [])
      .filter((p) => p.kind === 'person')
      .map((p) => p.id);
  } catch {
    return [];
  }
}

// ─── Fetch team member emails from Monday.com users API ──────────────────────

async function fetchUserEmails(userIds) {
  if (!userIds.length) return [];
  const data = await mondayApi.query(
    `query($ids: [ID!]!) { users(ids: $ids) { id name email } }`,
    { ids: userIds }
  );
  return data?.users || [];
}

// ─── Apply the lock sequence to the master item ──────────────────────────────

async function applyLock(masterItemId) {
  const colValues = {
    [CM.automationLock]: { label: 'Yes'                },
    [CM.caseStage]:      { label: 'Internal Review'    },
    [CM.readyForReview]: { label: 'Done'               },
    [CM.chasingStage]:   { label: 'Resolved'           },
  };
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

// ─── Post a comment on the Master item ───────────────────────────────────────

async function postMondayUpdate(masterItemId, caseRef, clientName, caseType) {
  const body =
    `✅ *Case Ready for Internal Review*\n\n` +
    `Case ${caseRef} (${clientName || 'client'} — ${caseType}) has reached 100% readiness ` +
    `with no blocking items.\n\n` +
    `The case has been automatically advanced to **Internal Review** and locked.\n\n` +
    `Please begin your internal review at your earliest convenience.`;

  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!) {
       create_update(item_id: $itemId, body: $body) { id }
     }`,
    { itemId: String(masterItemId), body }
  );
}

// ─── Send email notification to Case Manager + Ops Supervisor ────────────────

async function sendTeamNotification(users, { caseRef, clientName, caseType }) {
  if (!users.length) return;
  const to = users.map((u) => u.email).filter(Boolean);
  if (!to.length) return;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px}
  .card{background:#fff;border-radius:12px;max-width:540px;margin:0 auto;padding:36px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
  .badge{display:inline-block;background:#059669;color:#fff;font-size:.72rem;font-weight:700;
         padding:.25rem .7rem;border-radius:20px;margin-bottom:16px;letter-spacing:.5px;text-transform:uppercase}
  h2{font-size:1.15rem;color:#111;margin:0 0 16px}
  p{color:#374151;line-height:1.65;margin:0 0 12px;font-size:.94rem}
  .meta{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 18px;margin:18px 0;font-size:.88rem}
  .meta strong{color:#111}
  hr{border:none;border-top:1px solid #e5e7eb;margin:22px 0}
  .footer{font-size:.78rem;color:#9ca3af;text-align:center}
</style></head>
<body>
<div class="card">
  <span class="badge">Ready for Review</span>
  <h2>✅ Case ready for Internal Review</h2>
  <p>A client case has reached <strong>100% completion</strong> with no blocking items and is now ready for your internal review.</p>
  <div class="meta">
    <p><strong>Case Reference:</strong> ${caseRef}</p>
    <p><strong>Client:</strong> ${clientName || '—'}</p>
    <p><strong>Case Type:</strong> ${caseType || '—'}</p>
  </div>
  <p>The case has been automatically advanced to <strong>Internal Review</strong> and locked in the system. Please log in to Monday.com to begin your review.</p>
  <hr>
  <p class="footer">TDOT Immigration &nbsp;|&nbsp; Automated case readiness notification</p>
</div>
</body></html>`;

  const params = {
    from:    EMAIL_FROM,
    to,
    subject: `Case Ready for Internal Review — ${caseRef}`,
    html,
  };
  if (EMAIL_REPLY_TO) params.reply_to = EMAIL_REPLY_TO;

  await resend.emails.send(params);
  console.log(`[AutoLock] ✉ Team notification sent to: ${to.join(', ')}`);
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Called when caseReadinessService confirms a case is 100% complete
 * with zero blocking items.
 */
async function onCaseComplete({ masterItemId, caseRef, caseType }) {
  console.log(`[AutoLock] 🔒 Locking case ${caseRef} (item ${masterItemId})…`);

  // Fetch full item details (one query)
  const item = await fetchCaseDetails(masterItemId);
  if (!item) {
    console.error(`[AutoLock] Item ${masterItemId} not found — aborting`);
    return;
  }

  const col        = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
  const colValue   = (id) => item.column_values.find((c) => c.id === id)?.value || '';
  const clientName = col(CM.clientName);

  // Guard: don't double-lock
  if (col(CM.automationLock) === 'Yes') {
    console.log(`[AutoLock] Case ${caseRef} already locked — skipping`);
    return;
  }

  // Step 1 — Apply the lock + stage advance
  await applyLock(masterItemId);
  console.log(`[AutoLock] ✓ Case ${caseRef} locked, stage → Internal Review`);

  // Step 2 — Post Monday.com item update (notifies subscribers)
  await postMondayUpdate(masterItemId, caseRef, clientName, caseType);
  console.log(`[AutoLock] ✓ Monday.com update posted for ${caseRef}`);

  // Step 3 — Email Case Manager + Ops Supervisor
  try {
    const managerIds    = extractPersonIds(colValue(CM.caseManager));
    const supervisorIds = extractPersonIds(colValue(CM.opsSupervisor));
    const allIds        = [...new Set([...managerIds, ...supervisorIds])];
    const users         = await fetchUserEmails(allIds.map(String));
    await sendTeamNotification(users, { caseRef, clientName, caseType });
  } catch (err) {
    // Email failure should not abort the lock sequence
    console.warn(`[AutoLock] Team email failed for ${caseRef}:`, err.message);
  }

  console.log(`[AutoLock] ✅ Case ${caseRef} fully locked and team notified`);
}

module.exports = { onCaseComplete };
