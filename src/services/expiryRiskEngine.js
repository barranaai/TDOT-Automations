/**
 * Expiry Risk Engine
 *
 * Runs AFTER slaRiskEngine in the daily job.
 * The SLA engine has already set the Expiry Risk Flag and forced the
 * risk band up. This engine handles the governance layer:
 *
 *   - Detects NEW expiry flags (first time a case crosses the warning window)
 *   - Detects escalation from Warning → Critical (< 30 days)
 *   - Sets Escalation Required = Yes + Escalation Reason
 *   - Sends alert email to Ops Supervisor (once per severity level)
 *   - Tracks notification state via Expiry Alert Sent column
 *   - Clears escalation when expiry risk is resolved
 *
 * Expiry Alert Sent states:
 *   (empty)        — not yet alerted
 *   Warning Sent   — alerted at warning level (within Expiry Warning Days)
 *   Critical Sent  — alerted at critical level (within 30 days)
 */

const { Resend } = require('resend');
const mondayApi  = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const resend       = new Resend(process.env.RESEND_API_KEY);
const EMAIL_FROM   = process.env.EMAIL_FROM    || 'TDOT Immigration <noreply@tdotimmigration.ca>';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';

const SLA_BOARD_ID     = process.env.MONDAY_SLA_CONFIG_BOARD_ID || '18402401449';
const CRITICAL_DAYS    = 30;

// ─── Column IDs — Client Master Board ────────────────────────────────────────
const CM = {
  caseStage:          'color_mm0x8faa',
  caseType:           'dropdown_mm0xd1qn',
  caseRef:            'text_mm142s49',
  clientName:         'text_mm0x1zdk',
  passportExpiry:     'date_mm0xe7fp',
  ieltsExpiry:        'date_mm0xvb0g',
  medicalExpiry:      'date_mm0x8c3t',
  expiryRiskFlag:     'color_mm1a7vbn',
  expiryAlertSent:    'color_mm1bjskf',   // Warning Sent / Critical Sent
  escalationRequired: 'color_mm0x7bje',
  escalationReason:   'text_mm0xvpr9',
  opsSupervisor:      'multiple_person_mm0xp0sq',
  caseManager:        'multiple_person_mm0xhmgk',
};

const SLA_EXPIRY_DAYS_COL = 'numeric_mm1a5694';
const SLA_ACTIVE_COL      = 'color_mm1361s8';

// Active stages only
const ACTIVE_STAGES = new Set([
  'Document Collection Started',
  'Internal Review',
  'Submission Preparation',
  'Stuck',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const expiry = new Date(dateStr);
  const today  = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((expiry - today) / 86400000);
}

function extractPersonIds(colValue) {
  try {
    const parsed = JSON.parse(colValue || '{}');
    return (parsed.personsAndTeams || [])
      .filter((p) => p.kind === 'person')
      .map((p) => String(p.id));
  } catch { return []; }
}

async function fetchUserEmails(userIds) {
  if (!userIds.length) return [];
  const data = await mondayApi.query(
    `query($ids: [ID!]!) { users(ids: $ids) { id name email } }`,
    { ids: userIds }
  );
  return data?.users || [];
}

// ─── Load expiry warning windows ─────────────────────────────────────────────

async function loadExpiryWindows() {
  const data = await mondayApi.query(
    `query($boardId: ID!) {
       boards(ids: [$boardId]) {
         items_page(limit: 100) {
           items {
             name
             column_values(ids: ["${SLA_EXPIRY_DAYS_COL}", "${SLA_ACTIVE_COL}"]) { id text }
           }
         }
       }
     }`,
    { boardId: SLA_BOARD_ID }
  );
  const windows = {};
  for (const item of data.boards[0].items_page.items) {
    const col = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
    if (col(SLA_ACTIVE_COL) !== 'Yes') continue;
    windows[item.name] = parseFloat(col(SLA_EXPIRY_DAYS_COL)) || 90;
  }
  return windows;
}

// ─── Fetch cases to check ────────────────────────────────────────────────────

async function fetchCases() {
  const FETCH_IDS = [
    CM.caseStage, CM.caseType, CM.caseRef, CM.clientName,
    CM.passportExpiry, CM.ieltsExpiry, CM.medicalExpiry,
    CM.expiryRiskFlag, CM.expiryAlertSent,
    CM.escalationRequired, CM.escalationReason,
    CM.opsSupervisor, CM.caseManager,
  ];

  let items = [], cursor = null;
  do {
    let data;
    if (cursor) {
      data = await mondayApi.query(
        `query($cursor: String!) {
           boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200, cursor: $cursor) {
               cursor
               items { id name column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text value } }
             }
           }
         }`,
        { cursor }
      );
    } else {
      data = await mondayApi.query(
        `{ boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200) {
               cursor
               items { id name column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text value } }
             }
           } }`
      );
    }
    const page = data.boards[0].items_page;
    items  = items.concat(page.items);
    cursor = page.cursor || null;
  } while (cursor);
  return items;
}

// ─── Email templates ──────────────────────────────────────────────────────────

function buildExpiryEmail({ level, expiryLabel, daysLeft, caseRef, clientName, caseType }) {
  const isWarning = level === 'warning';
  const colour    = isWarning ? '#f97316' : '#dc2626';
  const badge     = isWarning ? 'Expiry Warning' : '⚠️ Expiry Critical';
  const subject   = isWarning
    ? `Expiry Warning — ${expiryLabel} expiring in ${daysLeft} days — ${caseRef}`
    : `🚨 CRITICAL: ${expiryLabel} expiring in ${daysLeft} days — ${caseRef}`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px}
  .card{background:#fff;border-radius:12px;max-width:540px;margin:0 auto;padding:36px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
  .badge{display:inline-block;background:${colour};color:#fff;font-size:.72rem;font-weight:700;
         padding:.25rem .7rem;border-radius:20px;margin-bottom:16px;letter-spacing:.5px;text-transform:uppercase}
  h2{font-size:1.15rem;color:#111;margin:0 0 16px}
  p{color:#374151;line-height:1.65;margin:0 0 12px;font-size:.94rem}
  .meta{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 18px;margin:18px 0;font-size:.88rem}
  .meta p{margin:0 0 6px}.meta p:last-child{margin:0}
  hr{border:none;border-top:1px solid #e5e7eb;margin:22px 0}
  .footer{font-size:.78rem;color:#9ca3af;text-align:center}
  strong{color:#111}
</style></head><body><div class="card">
  <span class="badge">${badge}</span>
  <h2>${isWarning ? '⏳ Document Expiry Approaching' : '🚨 Document Expiry Critical'}</h2>
  <p>A document expiry date is ${isWarning ? 'approaching' : 'critically close'} for the following case.
  ${isWarning ? 'Please review and advise the client.' : '<strong>Immediate action required.</strong>'}</p>
  <div class="meta">
    <p><strong>Case Reference:</strong> ${caseRef}</p>
    <p><strong>Client:</strong> ${clientName || '—'}</p>
    <p><strong>Case Type:</strong> ${caseType || '—'}</p>
    <p><strong>Document:</strong> ${expiryLabel}</p>
    <p><strong>Days Remaining:</strong> <span style="color:${colour};font-weight:700">${daysLeft} days</span></p>
  </div>
  <p>Please log in to Monday.com and take the appropriate action for this case.</p>
  <hr>
  <p class="footer">TDOT Immigration &nbsp;|&nbsp; Automated expiry risk notification</p>
</div></body></html>`;

  return { subject, html };
}

async function sendExpiryAlert(users, emailData) {
  const to = users.map((u) => u.email).filter(Boolean);
  if (!to.length) return;
  const { subject, html } = buildExpiryEmail(emailData);
  const params = { from: EMAIL_FROM, to, subject, html };
  if (EMAIL_REPLY_TO) params.reply_to = EMAIL_REPLY_TO;
  await resend.emails.send(params);
  console.log(`[ExpiryEngine] ✉ ${emailData.level.toUpperCase()} alert sent to: ${to.join(', ')}`);
}

// ─── Process one case ─────────────────────────────────────────────────────────

async function processCase(item, expiryWindows) {
  const col      = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
  const colValue = (id) => item.column_values.find((c) => c.id === id)?.value || '';

  const caseStage = col(CM.caseStage);
  if (!ACTIVE_STAGES.has(caseStage)) return 'skipped';

  const caseType   = col(CM.caseType);
  const caseRef    = col(CM.caseRef);
  if (!caseRef) return 'no-case-ref';

  const warningDays = expiryWindows[caseType] || 90;

  // Check each expiry date
  const expiryChecks = [
    { label: 'Passport',  date: col(CM.passportExpiry) },
    { label: 'IELTS',     date: col(CM.ieltsExpiry)    },
    { label: 'Medical',   date: col(CM.medicalExpiry)  },
  ].map((e) => ({ ...e, daysLeft: daysUntil(e.date) }))
   .filter((e) => e.date && e.daysLeft >= 0);

  const flagged      = expiryChecks.some((e) => e.daysLeft <= warningDays);
  const critical     = expiryChecks.some((e) => e.daysLeft <= CRITICAL_DAYS);
  const currentAlert = col(CM.expiryAlertSent);   // Warning Sent / Critical Sent / empty

  // Determine if we need to act
  const needsWarningAlert  = flagged && !critical && currentAlert === '';
  const needsCriticalAlert = critical && currentAlert !== 'Critical Sent';
  const needsClear         = !flagged && currentAlert !== '';

  if (!needsWarningAlert && !needsCriticalAlert && !needsClear) return 'no-change';

  // Find the most urgent expiry for the notification
  const urgentExpiry = expiryChecks
    .filter((e) => e.daysLeft <= (critical ? CRITICAL_DAYS : warningDays))
    .sort((a, b) => a.daysLeft - b.daysLeft)[0];

  const level = critical ? 'critical' : 'warning';

  // Build column updates
  const updates = {};

  if (needsClear) {
    updates[CM.expiryRiskFlag]  = { label: 'Clear' };
    updates[CM.expiryAlertSent] = '';   // clear status
    console.log(`[ExpiryEngine] ✓ ${caseRef} — expiry risk cleared`);
    await applyUpdates(item.id, updates);
    return 'cleared';
  }

  // Flagged — escalate
  const reason = `${urgentExpiry.label} expiry in ${urgentExpiry.daysLeft} days`;
  updates[CM.expiryRiskFlag]     = { label: 'Flagged' };
  updates[CM.expiryAlertSent]    = { label: critical ? 'Critical Sent' : 'Warning Sent' };
  updates[CM.escalationRequired] = { label: 'Yes' };
  updates[CM.escalationReason]   = reason;

  await applyUpdates(item.id, updates);
  console.log(`[ExpiryEngine] 🔴 ${caseRef} — ${level.toUpperCase()} expiry: ${reason}`);

  // Send notification
  try {
    const ids   = [...new Set([
      ...extractPersonIds(colValue(CM.opsSupervisor)),
      ...extractPersonIds(colValue(CM.caseManager)),
    ])];
    const users = await fetchUserEmails(ids);
    await sendExpiryAlert(users, {
      level,
      expiryLabel: urgentExpiry.label,
      daysLeft:    urgentExpiry.daysLeft,
      caseRef,
      clientName: col(CM.clientName),
      caseType,
    });
  } catch (err) {
    console.warn(`[ExpiryEngine] Email failed for ${caseRef}:`, err.message);
  }

  return level === 'critical' ? 'critical-alert' : 'warning-alert';
}

async function applyUpdates(itemId, updates) {
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
     }`,
    {
      boardId:   String(clientMasterBoardId),
      itemId:    String(itemId),
      colValues: JSON.stringify(updates),
    }
  );
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function runExpiryCheck() {
  console.log('[ExpiryEngine] Starting expiry risk check…');
  const start = Date.now();

  const [windows, items] = await Promise.all([
    loadExpiryWindows(),
    fetchCases(),
  ]);

  const tally = {};
  for (const item of items) {
    try {
      const result = await processCase(item, windows);
      tally[result] = (tally[result] || 0) + 1;
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      tally['error'] = (tally['error'] || 0) + 1;
      console.error(`[ExpiryEngine] Error for item ${item.id}:`, err.message);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const alerts  = (tally['warning-alert'] || 0) + (tally['critical-alert'] || 0);
  console.log(
    `[ExpiryEngine] Done in ${elapsed}s | Alerts sent: ${alerts} | ` +
    `Cleared: ${tally['cleared'] || 0} | Details: ${JSON.stringify(tally)}`
  );
  return tally;
}

module.exports = { runExpiryCheck };
