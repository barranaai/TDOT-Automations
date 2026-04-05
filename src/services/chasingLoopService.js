const { sendEmail } = require('./microsoftMailService');
const mondayApi     = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');
const { resolveForm } = require('../../config/questionnaireFormMap');

const SLA_BOARD_ID   = process.env.MONDAY_SLA_CONFIG_BOARD_ID || '18402401449';
const BASE_URL       = process.env.RENDER_URL    || 'https://tdot-automations.onrender.com';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';

// ─── Column IDs — Client Master Board ────────────────────────────────────────
const CM = {
  caseStage:          'color_mm0x8faa',
  stageStartDate:     'date_mm0xjm1z',
  caseType:           'dropdown_mm0xd1qn',
  caseSubType:        'dropdown_mm0x4t91',
  caseRef:            'text_mm142s49',
  clientName:         'text_mm0x1zdk',
  clientEmail:        'text_mm0xw6bp',
  accessToken:        'text_mm0x6haq',
  automationLock:     'color_mm0x3x1x',
  manualOverride:     'color_mm0x975e',
  escalationRequired: 'color_mm0x7bje',
  qReadiness:         'numeric_mm0x9dea',
  docReadiness:       'numeric_mm0x5g9x',
  chasingStage:       'color_mm1abve4',
  reminderCount:      'numeric_mm1a4e8r',
  lastActivityDate:   'date_mm1amqyr',
};

// ─── Column IDs — SLA Config Board ───────────────────────────────────────────
const SLA_COLS = {
  r1Offset:      'numeric_mm13k4b4',
  r2Offset:      'numeric_mm13me73',
  finalOffset:   'numeric_mm13wm31',
  escalationOffset:'numeric_mm13vwg6',
  profileActive: 'color_mm1361s8',
};

// Chasing only applies to this stage
const CHASING_STAGE = 'Document Collection Started';

// Grace period — skip sending if client submitted within this many hours
const RECENT_ACTIVITY_HOURS = 24;

// ─── Load SLA reminder offsets ────────────────────────────────────────────────

async function loadReminderOffsets() {
  const data = await mondayApi.query(
    `query($boardId: ID!) {
       boards(ids: [$boardId]) {
         items_page(limit: 100) {
           items {
             name
             column_values(ids: [
               "${SLA_COLS.r1Offset}",
               "${SLA_COLS.r2Offset}",
               "${SLA_COLS.finalOffset}",
               "${SLA_COLS.escalationOffset}",
               "${SLA_COLS.profileActive}"
             ]) { id text }
           }
         }
       }
     }`,
    { boardId: SLA_BOARD_ID }
  );

  const offsets = {};
  for (const item of data.boards[0].items_page.items) {
    const col = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
    if (col(SLA_COLS.profileActive) !== 'Yes') continue;
    offsets[item.name] = {
      r1:         parseInt(col(SLA_COLS.r1Offset),       10) || 7,
      r2:         parseInt(col(SLA_COLS.r2Offset),       10) || 14,
      final:      parseInt(col(SLA_COLS.finalOffset),    10) || 21,
      escalation: parseInt(col(SLA_COLS.escalationOffset),10) || 30,
    };
  }
  console.log(`[ChasingLoop] Loaded reminder offsets for ${Object.keys(offsets).length} case types`);
  return offsets;
}

// ─── Fetch cases eligible for chasing ────────────────────────────────────────

async function fetchChasableCases() {
  const FETCH_IDS = [
    CM.caseStage, CM.stageStartDate, CM.caseType, CM.caseSubType,
    CM.caseRef, CM.clientName, CM.clientEmail, CM.accessToken,
    CM.automationLock, CM.manualOverride, CM.escalationRequired,
    CM.qReadiness, CM.docReadiness,
    CM.chasingStage, CM.reminderCount, CM.lastActivityDate,
  ];

  let items  = [];
  let cursor = null;

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
        `{
           boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200) {
               cursor
               items { id name column_values(ids: ${JSON.stringify(FETCH_IDS)}) { id text value } }
             }
           }
         }`
      );
    }
    const page = data.boards[0].items_page;
    items  = items.concat(page.items);
    cursor = page.cursor || null;
  } while (cursor);

  return items;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysBetween(dateStr) {
  if (!dateStr) return 0;
  const start = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((today - start) / 86400000));
}

function hoursSince(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr);
  return (Date.now() - d.getTime()) / 3600000;
}

// ─── Email templates ──────────────────────────────────────────────────────────

function buildChasingEmail(type, { clientName, caseRef, token, qLink }) {
  const docLink = `${BASE_URL}/documents/${encodeURIComponent(caseRef)}`;
  const name   = clientName || 'Client';

  const config = {
    'R1': {
      subject: `Action Required: Documents needed for your case – ${caseRef}`,
      heading: 'A friendly reminder from your immigration team',
      body: `
        <p>Hi ${name},</p>
        <p>We hope you're doing well. This is a friendly reminder that we are still waiting for your
        <strong>documents and questionnaire responses</strong> for your case <strong>${caseRef}</strong>.</p>
        <p>Submitting your documents on time helps us keep your case on track and meet important deadlines.</p>`,
      urgencyColour: '#2563eb',
      urgencyLabel:  'Reminder',
    },
    'R2': {
      subject: `Second Reminder: Your case ${caseRef} needs your attention`,
      heading: 'Please take action — your case needs your documents',
      body: `
        <p>Hi ${name},</p>
        <p>This is our <strong>second reminder</strong> regarding your case <strong>${caseRef}</strong>.
        We have not yet received all the required documents and questionnaire responses.</p>
        <p><strong>Please submit what is outstanding as soon as possible</strong> to avoid delays or risk to your application.</p>`,
      urgencyColour: '#f97316',
      urgencyLabel:  'Second Reminder',
    },
    'FINAL': {
      subject: `⚠️ Final Notice – Immediate action required for case ${caseRef}`,
      heading: '⚠️ Final Notice — Your case is at risk',
      body: `
        <p>Hi ${name},</p>
        <p>This is a <strong>final notice</strong> for your case <strong>${caseRef}</strong>.
        Despite our previous reminders, we have not received the required documents and questionnaire responses.</p>
        <p><strong>If we do not hear from you within the next 48 hours, your case may be significantly delayed
        or we may be unable to proceed further.</strong></p>
        <p>Please contact us immediately if you have any questions or are experiencing difficulties.</p>`,
      urgencyColour: '#dc2626',
      urgencyLabel:  'Final Notice',
    },
  };

  const t = config[type];

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px}
  .card{background:#fff;border-radius:12px;max-width:560px;margin:0 auto;padding:36px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
  .badge{display:inline-block;background:${t.urgencyColour};color:#fff;font-size:.72rem;font-weight:700;
         padding:.25rem .7rem;border-radius:20px;margin-bottom:16px;letter-spacing:.5px;text-transform:uppercase}
  h2{font-size:1.2rem;color:#111;margin:0 0 16px}
  p{color:#374151;line-height:1.65;margin:0 0 14px;font-size:.94rem}
  .btn-row{margin:24px 0}
  .btn{display:inline-block;padding:11px 22px;border-radius:8px;font-size:.9rem;font-weight:600;text-decoration:none;margin-right:10px;margin-bottom:10px}
  .btn-q{background:#2563eb;color:#fff}
  .btn-d{background:#059669;color:#fff}
  .divider{border:none;border-top:1px solid #e5e7eb;margin:24px 0}
  .footer{font-size:.78rem;color:#9ca3af;text-align:center}
  strong{color:#111}
</style></head>
<body>
<div class="card">
  <span class="badge">${t.urgencyLabel}</span>
  <h2>${t.heading}</h2>
  ${t.body}
  <div class="btn-row">
    <a href="${qLink}" class="btn btn-q">Complete Questionnaire</a>
    <a href="${docLink}" class="btn btn-d">Upload Documents</a>
  </div>
  <hr class="divider">
  <p style="font-size:.84rem;color:#4b5563">
    Need help? Reply to this email or contact your case officer directly.<br>
    Case Reference: <strong>${caseRef}</strong>
  </p>
  <p class="footer">TDOT Immigration &nbsp;|&nbsp; This email was sent regarding your active immigration case.</p>
</div>
</body></html>`;

  return { subject: t.subject, html };
}

// ─── Send one chasing email ───────────────────────────────────────────────────

async function sendChasingEmail(type, { clientEmail, clientName, caseRef, token }) {
  if (!clientEmail) {
    console.warn(`[ChasingLoop] No email for case ${caseRef} — skipping send`);
    return;
  }

  const { subject, html } = buildChasingEmail(type, { clientName, caseRef, token });

  await sendEmail({
    to:      clientEmail,
    subject,
    html,
    replyTo: EMAIL_REPLY_TO || undefined,
  });
  console.log(`[ChasingLoop] ✉ ${type} email sent to ${clientEmail} for case ${caseRef}`);
}

// ─── Update columns on one case ───────────────────────────────────────────────

async function updateCase(itemId, colValues) {
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
     }`,
    {
      boardId:   String(clientMasterBoardId),
      itemId:    String(itemId),
      colValues: JSON.stringify(colValues),
    }
  );
}

// ─── Process one case ─────────────────────────────────────────────────────────

async function processCase(item, offsets) {
  const col = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';

  // Only chase cases in Document Collection Started stage
  if (col(CM.caseStage) !== CHASING_STAGE) return 'skipped';

  // Respect governance flags
  if (col(CM.automationLock) === 'Yes')   return 'locked';
  if (col(CM.manualOverride) === 'Yes')   return 'override';

  const clientEmail = col(CM.clientEmail);
  const caseRef     = col(CM.caseRef);
  const caseType    = col(CM.caseType);
  const caseSubType = col(CM.caseSubType) || null;
  const startDate   = col(CM.stageStartDate);

  if (!startDate)     return 'no-start-date';
  if (!caseRef)       return 'no-case-ref';

  // If both boards are fully complete, mark resolved and stop chasing
  const qReady  = parseFloat(col(CM.qReadiness))  || 0;
  const docReady = parseFloat(col(CM.docReadiness)) || 0;
  if (qReady >= 100 && docReady >= 100) {
    await updateCase(item.id, { [CM.chasingStage]: { label: 'Resolved' } });
    return 'resolved';
  }

  // Grace period — don't send if client submitted very recently
  const lastActivity = col(CM.lastActivityDate);
  if (lastActivity && hoursSince(lastActivity) < RECENT_ACTIVITY_HOURS) {
    return 'grace-period';
  }

  const profile = offsets[caseType] || { r1: 7, r2: 14, final: 21, escalation: 30 };
  const daysElapsed   = daysBetween(startDate);
  const chasingStage  = col(CM.chasingStage);
  const reminderCount = parseInt(col(CM.reminderCount), 10) || 0;
  const token         = col(CM.accessToken);
  const clientName    = col(CM.clientName);

  // Build the correct questionnaire link depending on whether this case uses
  // the new HTML form system or the legacy Monday questionnaire board.
  const isHtmlFormCase = Boolean(resolveForm(caseType, caseSubType));
  const qLink = isHtmlFormCase && token
    ? `${BASE_URL}/q/${encodeURIComponent(caseRef)}?t=${encodeURIComponent(token)}`
    : `${BASE_URL}/questionnaire/${encodeURIComponent(caseRef)}`;

  const emailCtx = { clientEmail, clientName, caseRef, token, qLink };

  // ── Stage machine ────────────────────────────────────────────────────────────
  if (chasingStage === 'Client Blocked') {
    // Already at max escalation — nothing more to do automatically
    return 'already-blocked';
  }

  if ((chasingStage === 'Final Notice Sent') && daysElapsed >= profile.escalation) {
    // Escalate — set Escalation Required + Client Blocked, no client email
    await updateCase(item.id, {
      [CM.chasingStage]:       { label: 'Client Blocked' },
      [CM.escalationRequired]: { label: 'Yes' },
    });
    console.log(`[ChasingLoop] 🚨 ${caseRef} (${item.name}) → Client Blocked + Escalation after ${daysElapsed}d`);
    return 'escalated';
  }

  if ((chasingStage === 'Reminder 2 Sent') && daysElapsed >= profile.final) {
    await sendChasingEmail('FINAL', emailCtx);
    await updateCase(item.id, {
      [CM.chasingStage]:  { label: 'Final Notice Sent' },
      [CM.reminderCount]: reminderCount + 1,
    });
    console.log(`[ChasingLoop] ✉ FINAL sent — ${caseRef} (${daysElapsed}d elapsed)`);
    return 'final-sent';
  }

  if ((chasingStage === 'Reminder 1 Sent') && daysElapsed >= profile.r2) {
    await sendChasingEmail('R2', emailCtx);
    await updateCase(item.id, {
      [CM.chasingStage]:  { label: 'Reminder 2 Sent' },
      [CM.reminderCount]: reminderCount + 1,
    });
    console.log(`[ChasingLoop] ✉ R2 sent — ${caseRef} (${daysElapsed}d elapsed)`);
    return 'r2-sent';
  }

  if ((chasingStage === '' || chasingStage === 'Pending') && daysElapsed >= profile.r1) {
    await sendChasingEmail('R1', emailCtx);
    await updateCase(item.id, {
      [CM.chasingStage]:  { label: 'Reminder 1 Sent' },
      [CM.reminderCount]: reminderCount + 1,
    });
    console.log(`[ChasingLoop] ✉ R1 sent — ${caseRef} (${daysElapsed}d elapsed)`);
    return 'r1-sent';
  }

  return 'waiting';
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function runChasingLoop() {
  console.log('[ChasingLoop] Starting client chasing loop…');
  const startTime = Date.now();

  const [offsets, items] = await Promise.all([
    loadReminderOffsets(),
    fetchChasableCases(),
  ]);

  const tally = {};
  for (const item of items) {
    try {
      const result = await processCase(item, offsets);
      tally[result] = (tally[result] || 0) + 1;
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      tally['error'] = (tally['error'] || 0) + 1;
      console.error(`[ChasingLoop] ✗ Item ${item.id} (${item.name}):`, err.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const emailsSent = (tally['r1-sent'] || 0) + (tally['r2-sent'] || 0) + (tally['final-sent'] || 0);
  console.log(
    `[ChasingLoop] Done in ${elapsed}s | ` +
    `Emails sent: ${emailsSent} | ` +
    `Escalated: ${tally['escalated'] || 0} | ` +
    `Resolved: ${tally['resolved'] || 0} | ` +
    `Details: ${JSON.stringify(tally)}`
  );
  return tally;
}

module.exports = { runChasingLoop };
