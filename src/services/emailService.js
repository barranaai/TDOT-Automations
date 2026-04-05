const { sendEmail }  = require('./microsoftMailService');
const mondayApi      = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const CM_COLS = {
  clientName:  'text_mm0x1zdk',
  clientEmail: 'text_mm0xw6bp',
  caseRef:     'text_mm142s49',
  caseType:    'dropdown_mm0xd1qn',
  accessToken: 'text_mm0x6haq',
  caseStage:   'color_mm0x8faa',
};

// Stages that indicate the intake email has already been sent.
// Only resend if the case is in one of these stages when the email is corrected.
// Early stages (before "Document Collection Started") are excluded — the email
// hasn't been sent yet, so the next normal send will use the corrected address.
// "Submitted" is excluded — the case is closed and resending serves no purpose.
const STAGES_REQUIRING_RESEND = new Set([
  'Document Collection Started',
  'Internal Review',
  'Submission Preparation',
  'Submission Ready',
]);

const BASE_URL       = process.env.RENDER_URL    || 'https://tdot-automations.onrender.com';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';

async function getClientDetails(itemId) {
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         column_values(ids: ${JSON.stringify(Object.values(CM_COLS))}) { id text }
       }
     }`,
    { itemId: String(itemId) }
  );

  const cols    = data.items[0]?.column_values || [];
  const col     = (id) => cols.find((c) => c.id === id)?.text?.replace(/\s+/g, ' ').trim() || '';

  return {
    clientName:  col(CM_COLS.clientName),
    clientEmail: col(CM_COLS.clientEmail),
    caseRef:     col(CM_COLS.caseRef),
    caseType:    col(CM_COLS.caseType),
    accessToken: col(CM_COLS.accessToken),
  };
}

function buildEmailHtml({ clientName, caseRef, caseType, accessToken, questionnaireUrl, documentsUrl }) {
  const firstName = clientName.split(' ')[0] || 'Client';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Case Is Ready — Action Required</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

      <!-- Header -->
      <tr><td style="background:#1e3a5f;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;">
        <div style="font-size:24px;color:#fff;font-weight:700;letter-spacing:-.3px;">TDOT Immigration</div>
        <div style="font-size:13px;color:rgba(255,255,255,.65);margin-top:4px;">Client Portal</div>
      </td></tr>

      <!-- Body -->
      <tr><td style="background:#fff;padding:36px 32px;">

        <p style="font-size:18px;font-weight:700;color:#1e293b;margin:0 0 8px;">Hi ${firstName},</p>
        <p style="font-size:15px;color:#475569;line-height:1.65;margin:0 0 24px;">
          Your case has been set up and is ready for the next step. To keep things moving smoothly,
          we need you to complete two things:
        </p>

        <!-- Step 1 -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:16px;">
          <tr><td style="padding:20px 24px;">
            <div style="display:flex;align-items:flex-start;gap:12px;">
              <div style="font-size:22px;margin-bottom:8px;">📋</div>
              <div>
                <div style="font-size:15px;font-weight:700;color:#1e293b;margin-bottom:4px;">Step 1 — Complete Your Questionnaire</div>
                <p style="font-size:14px;color:#64748b;margin:0 0 16px;line-height:1.6;">
                  Answer all the questions about your background, travel history, employment, and personal details.
                  You can save your progress and return at any time.
                </p>
                <a href="${questionnaireUrl}" style="display:inline-block;background:#2563eb;color:#fff;font-size:14px;font-weight:600;padding:11px 24px;border-radius:8px;text-decoration:none;">
                  Open Questionnaire →
                </a>
              </div>
            </div>
          </td></tr>
        </table>

        <!-- Step 2 -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:28px;">
          <tr><td style="padding:20px 24px;">
            <div style="font-size:22px;margin-bottom:8px;">📁</div>
            <div style="font-size:15px;font-weight:700;color:#1e293b;margin-bottom:4px;">Step 2 — Upload Your Documents</div>
            <p style="font-size:14px;color:#64748b;margin:0 0 16px;line-height:1.6;">
              Upload the required documents for your case. Each document shows what is needed and whether it is mandatory.
              You can upload files one at a time and re-upload if needed.
            </p>
            <a href="${documentsUrl}" style="display:inline-block;background:#1e3a5f;color:#fff;font-size:14px;font-weight:600;padding:11px 24px;border-radius:8px;text-decoration:none;">
              Upload Documents →
            </a>
          </td></tr>
        </table>

        <!-- Case details -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f9ff;border-radius:10px;border:1px solid #bae6fd;margin-bottom:28px;">
          <tr><td style="padding:16px 20px;">
            <div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Your Case Details</div>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Case Reference</td>
                <td style="font-size:13px;font-weight:700;color:#1e293b;">${caseRef}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Case Type</td>
                <td style="font-size:13px;font-weight:600;color:#1e293b;">${caseType}</td>
              </tr>
              ${accessToken ? `<tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Access Token</td>
                <td style="font-size:13px;font-family:monospace;color:#1e293b;">${accessToken}</td>
              </tr>` : ''}
            </table>
          </td></tr>
        </table>

        <p style="font-size:14px;color:#64748b;line-height:1.65;margin:0;">
          If you have any questions, please reply to this email or contact your assigned consultant directly.
          Please include your <strong>Case Reference Number</strong> in any correspondence.
        </p>

      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;">
        <p style="font-size:12px;color:#94a3b8;margin:0;line-height:1.6;">
          TDOT Immigration Services<br>
          This email was sent to you because your case has been activated in our system.<br>
          Please do not forward this email — the form links are specific to your case.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>

</body>
</html>`;
}

/**
 * Called when the "Client Email" column is corrected on the Client Master Board.
 *
 * If the case has already passed the intake-email stage, the officer has
 * corrected an address after the original email was sent to the wrong inbox.
 * This resends the intake email to the updated (correct) address and posts
 * an audit comment on the Monday item so the correction is traceable.
 *
 * Safe no-ops:
 *  - Email cleared / blank value            → skipped (logged)
 *  - Stage is before Document Collection    → skipped (email not yet sent)
 *  - Stage is "Submitted" (terminal)        → skipped (case is closed)
 */
async function onClientEmailChanged(itemId) {
  // Single query: fetch case stage, the now-updated email, and case ref
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         column_values(ids: [
           "${CM_COLS.caseStage}",
           "${CM_COLS.clientEmail}",
           "${CM_COLS.caseRef}"
         ]) { id text }
       }
     }`,
    { itemId: String(itemId) }
  );

  const cols      = data?.items?.[0]?.column_values || [];
  const col       = (id) => cols.find((c) => c.id === id)?.text?.replace(/\s+/g, ' ').trim() || '';
  const caseStage = col(CM_COLS.caseStage);
  const newEmail  = col(CM_COLS.clientEmail);
  const caseRef   = col(CM_COLS.caseRef);

  const label = caseRef || `item ${itemId}`;

  if (!newEmail) {
    console.log(`[Email] Client email cleared for ${label} — skipping resend`);
    return;
  }

  if (!STAGES_REQUIRING_RESEND.has(caseStage)) {
    console.log(`[Email] Client email updated for ${label}, stage "${caseStage || 'unknown'}" — intake email not yet sent, no resend needed`);
    return;
  }

  console.log(`[Email] Client email corrected for ${label} (stage: "${caseStage}") — resending intake email to ${newEmail}`);

  await sendIntakeEmail(itemId);

  // Audit comment on the Monday item so the correction is fully traceable
  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
    {
      itemId: String(itemId),
      body: `Intake email resent — client email address was corrected.\nNew address: ${newEmail}\nCase stage at time of correction: ${caseStage}`,
    }
  );

  console.log(`[Email] Audit comment posted on ${label} after email correction resend`);
}

/**
 * Send the client intake email with questionnaire + document upload links.
 * Called after both templates are applied for a case.
 */
async function sendIntakeEmail(itemId) {
  const client = await getClientDetails(itemId);

  if (!client.clientEmail) {
    console.warn(`[Email] No email address for item ${itemId} — skipping intake email`);
    return;
  }

  if (!client.caseRef) {
    console.warn(`[Email] No case ref for item ${itemId} — skipping intake email`);
    return;
  }

  const encodedRef      = encodeURIComponent(client.caseRef);
  // New HTML-form questionnaire URL — token is required for access
  const questionnaireUrl = client.accessToken
    ? `${BASE_URL}/q/${encodedRef}?t=${encodeURIComponent(client.accessToken)}`
    : `${BASE_URL}/q/${encodedRef}`;
  const documentsUrl     = `${BASE_URL}/documents/${encodedRef}`;

  await sendEmail({
    to:      client.clientEmail,
    subject: `Action Required — Your ${client.caseType || 'Immigration'} Case Is Ready (${client.caseRef})`,
    html:    buildEmailHtml({ ...client, questionnaireUrl, documentsUrl }),
    replyTo: EMAIL_REPLY_TO || undefined,
  });

  console.log(`[Email] Intake email sent to ${client.clientEmail} for case ${client.caseRef}`);
}

module.exports = { sendIntakeEmail, onClientEmailChanged };
