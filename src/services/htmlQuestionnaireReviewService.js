/**
 * HTML Questionnaire Review Service  —  Staff-facing operations
 *
 * Handles everything a case officer needs after a client submits a questionnaire:
 *   • Loading / saving per-field correction flags in OneDrive
 *   • Building the staff review page HTML
 *   • Sending the "please correct these items" email to the client
 */

'use strict';

const { sendEmail }  = require('./microsoftMailService');
const mondayApi      = require('./mondayApi');
const oneDrive       = require('./oneDriveService');
const { clientMasterBoardId } = require('../../config/monday');

const QUESTIONNAIRE_SUBFOLDER = 'Questionnaire';

// ─── Column IDs — Client Master Board ────────────────────────────────────────

const CM = {
  caseRef:     'text_mm142s49',
  caseType:    'dropdown_mm0xd1qn',
  caseSubType: 'dropdown_mm0x4t91',
  clientEmail: 'text_mm0xw6bp',
  accessToken: 'text_mm0x6haq',
};

const BASE_URL       = process.env.RENDER_URL    || 'https://tdot-automations.onrender.com';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';

// ─── Flags helpers ─────────────────────────────────────────────────────────────
// Flags are stored as JSON: { [fieldKey]: { label, section, comment, flaggedBy, flaggedByEmail, flaggedAt } }

function flagsFilename(caseRef, formKey) {
  return `questionnaire-${caseRef}-${formKey}-flags.json`;
}

/**
 * Load active correction flags for a form.
 * Returns {} if no flags have been saved yet.
 */
async function loadFlags({ clientName, caseRef, formKey }) {
  try {
    const buf = await oneDrive.readFile({
      clientName,
      caseRef,
      subfolder: QUESTIONNAIRE_SUBFOLDER,
      filename:  flagsFilename(caseRef, formKey),
    });
    if (!buf) return {};
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    console.error(`[HtmlQReview] loadFlags failed for ${caseRef}/${formKey}:`, err.message);
    return {};
  }
}

/**
 * Save (replace) the flags object for a form.
 * Pass an empty object {} to clear all flags.
 */
async function saveFlags({ clientName, caseRef, formKey, flags }) {
  await oneDrive.ensureClientFolder({ clientName, caseRef });
  const buffer = Buffer.from(JSON.stringify(flags, null, 2), 'utf8');
  await oneDrive.uploadFile({
    clientName,
    caseRef,
    category: QUESTIONNAIRE_SUBFOLDER,
    filename: flagsFilename(caseRef, formKey),
    buffer,
    mimeType: 'application/json',
  });
  console.log(`[HtmlQReview] Saved ${Object.keys(flags).length} flag(s) for ${caseRef}/${formKey}`);
}

// ─── Monday lookup ────────────────────────────────────────────────────────────

/**
 * Look up client details from Monday for a given caseRef.
 * Used by the review/notify endpoints (no token validation needed — staff already authed).
 */
async function getCaseDetails(caseRef) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(
         limit: 1, board_id: $boardId,
         columns: [{ column_id: $colId, column_values: [$val] }]
       ) {
         items {
           id
           name
           column_values(ids: [
             "${CM.caseRef}", "${CM.caseType}", "${CM.caseSubType}",
             "${CM.clientEmail}", "${CM.accessToken}"
           ]) { id text }
         }
       }
     }`,
    { boardId: String(clientMasterBoardId), colId: CM.caseRef, val: caseRef }
  );

  const item = data?.items_page_by_column_values?.items?.[0];
  if (!item) return null;

  const col = (id) => item.column_values.find(c => c.id === id)?.text?.trim() || '';
  return {
    itemId:      item.id,
    /* Use item.name (Monday item title) — same source as documentFormService.js
     * so that flags land in the same OneDrive folder as uploaded documents.   */
    clientName:  (item.name || '').trim() || 'Unknown Client',
    caseType:    col(CM.caseType),
    caseSubType: col(CM.caseSubType) || null,
    clientEmail: col(CM.clientEmail),
    accessToken: col(CM.accessToken),
  };
}

// ─── Correction notification email ───────────────────────────────────────────

/**
 * Send a correction request email to the client and post a Monday audit comment.
 *
 * @param {{ caseRef, formKey, caseDetails, flags, formFields, staffName }} params
 *   formFields: [{ key, label, section, value }] — the submitted answers (for label lookup)
 *   flags:      { [key]: { label, section, comment, flaggedBy } }
 */
async function sendCorrectionEmail({ caseRef, formKey, caseDetails, flags, formFields, staffName }) {
  const { itemId, clientEmail, clientName, caseType, accessToken } = caseDetails;

  if (!clientEmail) {
    throw new Error('No client email address on record for this case.');
  }

  const flaggedKeys = Object.keys(flags);
  if (!flaggedKeys.length) {
    throw new Error('No flags to send — flag at least one field first.');
  }

  // Build label map from submitted field data
  const labelMap = {};
  for (const f of (formFields || [])) {
    labelMap[f.key] = { label: f.label, section: f.section };
  }

  // Gather flagged items for the email
  const flaggedItems = flaggedKeys.map(key => {
    const flag   = flags[key];
    const meta   = labelMap[key] || { label: flag.label || key, section: flag.section || '' };
    return {
      section: meta.section,
      label:   meta.label,
      comment: flag.comment,
    };
  });

  // Group items by section for the email layout
  const sections = {};
  for (const item of flaggedItems) {
    if (!sections[item.section]) sections[item.section] = [];
    sections[item.section].push(item);
  }

  const encodedRef  = encodeURIComponent(caseRef);
  const tokenParam  = accessToken ? `?t=${encodeURIComponent(accessToken)}` : '';

  // Build the form URL — use member key directly in the f= parameter
  // Legacy: 'additional' → f=2. Member keys: 'spouse' → f=spouse, 'child-1' → f=child-1
  let formParam;
  if (formKey === 'additional') {
    formParam = '&f=2'; // legacy dual-form
  } else if (formKey === 'primary') {
    formParam = tokenParam ? '&f=primary' : '?f=primary';
  } else {
    // Member key (e.g., 'spouse', 'child-1', 'spouse-additional')
    const memberKey = formKey.replace(/-additional$/, '');
    const formType  = formKey.endsWith('-additional') ? '&form=additional' : '';
    formParam = `${tokenParam ? '&' : '?'}f=${encodeURIComponent(memberKey)}${formType}`;
  }
  const formUrl = `${BASE_URL}/q/${encodedRef}${tokenParam}${formParam}`;

  // Derive member label from the formKey for the email subject
  const memberKey   = formKey.replace(/-additional$/, '');
  const memberLabel = memberKey !== 'primary'
    ? memberKey.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) // 'child-1' → 'Child 1'
    : '';
  const memberNote  = memberLabel ? ` (${memberLabel})` : '';

  const html = buildCorrectionEmailHtml({
    clientName, caseRef, caseType, flaggedItems, sections, formUrl, staffName, memberLabel,
  });

  await sendEmail({
    to:      clientEmail,
    subject: `Action Required — Please Update Your Questionnaire${memberNote} (${caseRef})`,
    html,
    replyTo: EMAIL_REPLY_TO || undefined,
  });

  // Post an audit comment on the Monday item
  const itemLines = flaggedItems
    .map(f => `  • ${f.section ? f.section + ' › ' : ''}${f.label}: "${f.comment}"`)
    .join('\n');

  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
    {
      itemId: String(itemId),
      body:   `📋 Correction Request Sent${memberNote}\n\nCase: ${caseRef}\nReviewed by: ${staffName}\nFlagged items (${flaggedKeys.length}):\n${itemLines}\n\nClient notified by email at ${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: true })} (Toronto).`,
    }
  );

  console.log(`[HtmlQReview] Correction email sent for ${caseRef}/${formKey} — ${flaggedKeys.length} flag(s). Reviewed by ${staffName}.`);
}

/**
 * Send a SINGLE consolidated correction email covering multiple family members.
 *
 * @param {{ caseRef, memberEntries, caseDetails, staffName }} params
 *   memberEntries: [{ memberKey, formKey, label, type, flags, formFields }]
 */
async function sendConsolidatedCorrectionEmail({ caseRef, memberEntries, caseDetails, staffName }) {
  const { itemId, clientEmail, clientName, caseType, accessToken } = caseDetails;

  if (!clientEmail) {
    throw new Error('No client email address on record for this case.');
  }

  // Filter to only members that have flags
  const withFlags = memberEntries.filter(m => Object.keys(m.flags).length > 0);
  if (!withFlags.length) {
    throw new Error('No flags to send — flag at least one field first.');
  }

  const encodedRef = encodeURIComponent(caseRef);
  const tokenParam = accessToken ? `?t=${encodeURIComponent(accessToken)}` : '';

  // Build per-member sections
  let totalFlags = 0;
  const memberSections = withFlags.map(entry => {
    const labelMap = {};
    for (const f of (entry.formFields || [])) {
      labelMap[f.key] = { label: f.label, section: f.section };
    }

    const flaggedItems = Object.keys(entry.flags).map(key => {
      const flag = entry.flags[key];
      const meta = labelMap[key] || { label: flag.label || key, section: flag.section || '' };
      return { section: meta.section, label: meta.label, comment: flag.comment };
    });

    totalFlags += flaggedItems.length;

    // Group by section
    const sections = {};
    for (const item of flaggedItems) {
      if (!sections[item.section]) sections[item.section] = [];
      sections[item.section].push(item);
    }

    // Build form URL — link to combined multi-member form (no f= param)
    // so all members display together with flags highlighted.
    // For additional-form cases, add form=additional to select the right form file.
    const isAdditionalForm = entry.formKey.endsWith('-additional');
    const additionalParam = isAdditionalForm ? `${tokenParam ? '&' : '?'}form=additional` : '';
    const formUrl = `${BASE_URL}/q/${encodedRef}${tokenParam}${additionalParam}`;

    return {
      label:       entry.label || entry.memberKey.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      type:        entry.type  || 'Principal Applicant',
      flagCount:   flaggedItems.length,
      sections,
      formUrl,
    };
  });

  const html = buildConsolidatedCorrectionEmailHtml({
    clientName, caseRef, caseType, memberSections, totalFlags, staffName,
  });

  await sendEmail({
    to:      clientEmail,
    subject: `Action Required — Please Update Your Questionnaire (${caseRef})`,
    html,
    replyTo: EMAIL_REPLY_TO || undefined,
  });

  // Post a single audit comment listing all members
  const auditLines = memberSections.map(m => {
    const items = Object.values(m.sections).flat();
    const lines = items.map(f => `    • ${f.section ? f.section + ' › ' : ''}${f.label}: "${f.comment}"`).join('\n');
    return `  ${m.label} (${m.flagCount} flag${m.flagCount !== 1 ? 's' : ''}):\n${lines}`;
  }).join('\n\n');

  await mondayApi.query(
    `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
    {
      itemId: String(itemId),
      body:   `📋 Correction Request Sent (${totalFlags} flags across ${memberSections.length} member${memberSections.length > 1 ? 's' : ''})\n\nCase: ${caseRef}\nReviewed by: ${staffName}\n\n${auditLines}\n\nClient notified by email at ${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: true })} (Toronto).`,
    }
  );

  console.log(`[HtmlQReview] Consolidated correction email sent for ${caseRef} — ${totalFlags} flag(s) across ${memberSections.length} member(s). Reviewed by ${staffName}.`);
}

function buildConsolidatedCorrectionEmailHtml({ clientName, caseRef, caseType, memberSections, totalFlags, staffName }) {
  const firstName = (clientName || '').split(' ')[0] || 'Client';

  const memberBlocksHtml = memberSections.map(member => {
    const sectionHtml = Object.entries(member.sections).map(([section, items]) => {
      const itemsHtml = items.map(item => `
        <tr>
          <td style="padding:10px 0 10px 20px;border-bottom:1px solid #f1f5f9;vertical-align:top;">
            <div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:4px;">${item.label}</div>
            <div style="font-size:13px;color:#dc2626;line-height:1.5;">\u{1F4AC} ${item.comment}</div>
          </td>
        </tr>`).join('');
      return `
        <div style="margin-bottom:12px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:6px;">${section || 'General'}</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e2e8f0;">
            ${itemsHtml}
          </table>
        </div>`;
    }).join('');

    return `
      <div style="margin-bottom:24px;">
        <div style="font-size:15px;font-weight:700;color:#1e3a5f;margin-bottom:4px;padding-bottom:8px;border-bottom:2px solid #1e3a5f;">
          ${member.label} <span style="font-size:12px;font-weight:400;color:#64748b;">\u2014 ${member.flagCount} item${member.flagCount > 1 ? 's' : ''}</span>
        </div>
        ${sectionHtml}
        <table cellpadding="0" cellspacing="0" style="margin-top:8px;">
          <tr><td style="border-radius:6px;background:#2563eb;">
            <a href="${member.formUrl}" style="display:inline-block;padding:10px 20px;color:#fff;font-size:13px;font-weight:600;text-decoration:none;">
              Update ${member.label}'s Questionnaire \u2192
            </a>
          </td></tr>
        </table>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

      <tr><td style="background:#1e3a5f;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;">
        <div style="font-size:24px;color:#fff;font-weight:700;">TDOT Immigration</div>
        <div style="font-size:13px;color:rgba(255,255,255,.65);margin-top:4px;">Client Portal</div>
      </td></tr>

      <tr><td style="background:#fff;padding:36px 32px;">
        <p style="font-size:18px;font-weight:700;color:#1e293b;margin:0 0 8px;">Hi ${firstName},</p>
        <p style="font-size:15px;color:#475569;line-height:1.65;margin:0 0 24px;">
          Your consultant has reviewed your questionnaire and needs clarification on
          <strong>${totalFlags} item${totalFlags > 1 ? 's' : ''}</strong> across
          <strong>${memberSections.length} member${memberSections.length > 1 ? 's' : ''}</strong>.
          Please log back in and update the highlighted fields for each member listed below.
        </p>

        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
          <div style="font-size:13px;font-weight:700;color:#c2410c;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px;">
            Items Requiring Your Attention
          </div>
          ${memberBlocksHtml}
        </div>

        <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 24px;">
          Your original answers are preserved — you only need to update the flagged fields.
          Use the buttons above to open each member's questionnaire directly.
        </p>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f9ff;border-radius:10px;border:1px solid #bae6fd;margin-bottom:24px;">
          <tr><td style="padding:16px 20px;">
            <div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Case Details</div>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Case Reference</td>
                <td style="font-size:13px;font-weight:700;color:#1e293b;">${caseRef}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Case Type</td>
                <td style="font-size:13px;font-weight:600;color:#1e293b;">${caseType}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Reviewed by</td>
                <td style="font-size:13px;color:#1e293b;">${staffName}</td>
              </tr>
            </table>
          </td></tr>
        </table>

        <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0;">
          If you have questions, please reply to this email or contact your consultant directly.
          Please include your Case Reference Number in any correspondence.
        </p>
      </td></tr>

      <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;">
        <p style="font-size:12px;color:#94a3b8;margin:0;line-height:1.6;">
          TDOT Immigration Services<br>
          Please do not forward this email — the questionnaire link is specific to your case.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function buildCorrectionEmailHtml({ clientName, caseRef, caseType, flaggedItems, sections, formUrl, staffName, memberLabel }) {
  const firstName   = (clientName || '').split(' ')[0] || 'Client';
  const count       = flaggedItems.length;
  const memberNote  = memberLabel ? ` for <strong>${memberLabel}</strong>` : '';

  const sectionHtml = Object.entries(sections).map(([section, items]) => {
    const itemsHtml = items.map(item => `
      <tr>
        <td style="padding:10px 0 10px 20px;border-bottom:1px solid #f1f5f9;vertical-align:top;">
          <div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:4px;">${item.label}</div>
          <div style="font-size:13px;color:#dc2626;line-height:1.5;">💬 ${item.comment}</div>
        </td>
      </tr>`).join('');
    return `
      <div style="margin-bottom:16px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:6px;">${section || 'General'}</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e2e8f0;">
          ${itemsHtml}
        </table>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

      <tr><td style="background:#1e3a5f;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;">
        <div style="font-size:24px;color:#fff;font-weight:700;">TDOT Immigration</div>
        <div style="font-size:13px;color:rgba(255,255,255,.65);margin-top:4px;">Client Portal</div>
      </td></tr>

      <tr><td style="background:#fff;padding:36px 32px;">
        <p style="font-size:18px;font-weight:700;color:#1e293b;margin:0 0 8px;">Hi ${firstName},</p>
        <p style="font-size:15px;color:#475569;line-height:1.65;margin:0 0 24px;">
          Your consultant has reviewed your questionnaire${memberNote} and needs clarification on
          <strong>${count} item${count > 1 ? 's' : ''}</strong>.
          Please log back in and update the highlighted fields.
        </p>

        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
          <div style="font-size:13px;font-weight:700;color:#c2410c;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px;">
            Items Requiring Your Attention
          </div>
          ${sectionHtml}
        </div>

        <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 24px;">
          Your original answers are preserved — you only need to update the flagged fields.
          Click the button below to open your questionnaire.
        </p>

        <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
          <tr><td style="border-radius:8px;background:#2563eb;">
            <a href="${formUrl}" style="display:inline-block;padding:13px 28px;color:#fff;font-size:15px;font-weight:600;text-decoration:none;">
              Update My Questionnaire →
            </a>
          </td></tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f9ff;border-radius:10px;border:1px solid #bae6fd;margin-bottom:24px;">
          <tr><td style="padding:16px 20px;">
            <div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Case Details</div>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Case Reference</td>
                <td style="font-size:13px;font-weight:700;color:#1e293b;">${caseRef}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Case Type</td>
                <td style="font-size:13px;font-weight:600;color:#1e293b;">${caseType}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#64748b;padding:3px 16px 3px 0;white-space:nowrap;">Reviewed by</td>
                <td style="font-size:13px;color:#1e293b;">${staffName}</td>
              </tr>
            </table>
          </td></tr>
        </table>

        <p style="font-size:13px;color:#94a3b8;line-height:1.6;margin:0;">
          If you have questions, please reply to this email or contact your consultant directly.
          Please include your Case Reference Number in any correspondence.
        </p>
      </td></tr>

      <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;">
        <p style="font-size:12px;color:#94a3b8;margin:0;line-height:1.6;">
          TDOT Immigration Services<br>
          Please do not forward this email — the questionnaire link is specific to your case.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ─── Staff review page ────────────────────────────────────────────────────────

/**
 * Build the full HTML review page for staff.
 *
 * @param {{ caseRef, formKey, formTitle, fields, flags, staffName, caseDetails }} params
 *   fields: [{ key, label, section, value }] from submitted CSV
 *   flags:  { [key]: { comment, flaggedBy, flaggedByEmail, flaggedAt } }
 */
function buildReviewPage({ caseRef, formKey, formTitle, fields, flags, staffName, caseDetails }) {
  const flagCount = Object.keys(flags).length;

  // Group fields by section for rendering
  const sections = {};
  for (const f of fields) {
    const sec = f.section || 'General';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(f);
  }

  const sectionHtml = Object.entries(sections).map(([section, sFields]) => {
    const rowsHtml = sFields.map(f => {
      const flag      = flags[f.key];
      const isFlagged = Boolean(flag);
      const escapedKey     = escHtml(f.key);
      const escapedLabel   = escHtml(f.label);
      const escapedSection = escHtml(f.section || '');
      const escapedValue   = escHtml(f.value || '');
      const flagComment    = isFlagged ? escHtml(flag.comment) : '';
      const hasReply       = isFlagged && flag.clientReply;
      const replyText      = hasReply ? escHtml(flag.clientReply) : '';
      const replyDate      = hasReply && flag.clientRepliedAt
        ? new Date(flag.clientRepliedAt).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';

      return `
        <div class="field-row${isFlagged ? ' flagged' : ''}" data-key="${escapedKey}">
          <div class="field-meta">
            <div class="field-label">${escapedLabel}</div>
            <div class="field-answer">${escapedValue || '<em style="color:#9ca3af">No answer provided</em>'}</div>
          </div>
          <div class="flag-area">
            ${isFlagged
              ? `<div class="flag-badge">🚩 Flagged</div>
                 <div class="flag-comment-text">${flagComment}</div>
                 ${hasReply
                   ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:6px 10px;max-width:260px;text-align:left;margin-top:4px;">
                        <div style="font-size:11px;font-weight:700;color:#2563eb;margin-bottom:2px;">✉️ Client reply</div>
                        <div style="font-size:12px;color:#1e40af;line-height:1.5;">${replyText}</div>
                        ${replyDate ? `<div style="font-size:10px;color:#6b7280;margin-top:3px;">${replyDate}</div>` : ''}
                      </div>`
                   : ''}
                 <button class="btn-edit-flag" onclick="openFlagForm('${escapedKey}', '${escapedLabel}', '${escapedSection}', \`${flagComment}\`)">✏️ Edit</button>
                 <button class="btn-remove-flag" onclick="removeFlag('${escapedKey}')">✕ Remove</button>`
              : `<button class="btn-flag" onclick="openFlagForm('${escapedKey}', '${escapedLabel}', '${escapedSection}', '')">🚩 Flag</button>`
            }
          </div>
        </div>`;
    }).join('');

    return `
      <div class="section-block">
        <div class="section-heading">${escHtml(section)}</div>
        ${rowsHtml}
      </div>`;
  }).join('');

  const notifyUrl   = `/q/${encodeURIComponent(caseRef)}/notify`;
  const flagUrl     = `/q/${encodeURIComponent(caseRef)}/flag`;
  const clientName  = caseDetails?.clientName || caseRef;
  const caseType    = caseDetails?.caseType || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review — ${escHtml(caseRef)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f4f8; color: #1e293b; }

    /* ── Top bar ── */
    .top-bar {
      position: sticky; top: 0; z-index: 100;
      background: #1e3a5f; color: #fff;
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 28px; gap: 16px; box-shadow: 0 2px 12px rgba(0,0,0,.2);
    }
    .top-bar-left h1  { font-size: 16px; font-weight: 700; }
    .top-bar-left p   { font-size: 12px; color: rgba(255,255,255,.65); margin-top: 2px; }
    .top-bar-right    { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
    .staff-badge      { font-size: 12px; color: rgba(255,255,255,.7); }
    #flag-counter     { font-size: 13px; font-weight: 700; color: #fbbf24; white-space: nowrap; }

    /* ── Notify button ── */
    #notify-btn {
      padding: 9px 20px; border: none; border-radius: 8px;
      background: #059669; color: #fff; font-size: 13px;
      font-weight: 700; cursor: pointer; white-space: nowrap;
      transition: background .15s;
    }
    #notify-btn:hover:not(:disabled)  { background: #047857; }
    #notify-btn:disabled { opacity: .45; cursor: not-allowed; }
    #notify-msg { font-size: 12px; color: #86efac; white-space: nowrap; }

    /* ── Content ── */
    .content { max-width: 900px; margin: 32px auto; padding: 0 20px 80px; }

    .summary-card {
      background: #fff; border-radius: 12px; padding: 20px 24px;
      box-shadow: 0 1px 8px rgba(0,0,0,.07); margin-bottom: 24px;
      display: flex; align-items: center; gap: 28px; flex-wrap: wrap;
    }
    .summary-stat { text-align: center; }
    .summary-stat .num { font-size: 28px; font-weight: 800; color: #1e3a5f; }
    .summary-stat .lbl { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .06em; }
    .summary-divider    { width: 1px; height: 40px; background: #e5e7eb; }

    /* ── Sections ── */
    .section-block {
      background: #fff; border-radius: 12px; margin-bottom: 20px;
      box-shadow: 0 1px 8px rgba(0,0,0,.07); overflow: hidden;
    }
    .section-heading {
      font-size: 12px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: #6b7280;
      background: #f8fafc; border-bottom: 1px solid #e5e7eb;
      padding: 10px 20px;
    }
    .field-row {
      display: flex; align-items: flex-start; gap: 16px;
      padding: 14px 20px; border-bottom: 1px solid #f1f5f9;
      transition: background .1s;
    }
    .field-row:last-child { border-bottom: none; }
    .field-row.flagged    { background: #fff7ed; }
    .field-meta   { flex: 1; min-width: 0; }
    .field-label  { font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 3px; }
    .field-answer { font-size: 14px; color: #1e293b; word-break: break-word; line-height: 1.5; }
    .flag-area    { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; min-width: 120px; }
    .flag-badge   { font-size: 12px; font-weight: 700; color: #ea580c; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 20px; padding: 3px 10px; }
    .flag-comment-text { font-size: 12px; color: #92400e; background: #fef3c7; border-radius: 6px; padding: 6px 10px; max-width: 260px; text-align: left; line-height: 1.5; }

    .btn-flag, .btn-edit-flag, .btn-remove-flag {
      border: none; border-radius: 6px; font-size: 12px; font-weight: 600;
      cursor: pointer; padding: 5px 12px; transition: background .15s;
    }
    .btn-flag       { background: #f1f5f9; color: #374151; }
    .btn-flag:hover { background: #e2e8f0; }
    .btn-edit-flag       { background: #fef3c7; color: #92400e; }
    .btn-edit-flag:hover { background: #fde68a; }
    .btn-remove-flag       { background: #fee2e2; color: #dc2626; }
    .btn-remove-flag:hover { background: #fecaca; }

    /* ── Flag modal ── */
    #flag-modal {
      display: none; position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,.45); align-items: center; justify-content: center;
    }
    #flag-modal.open { display: flex; }
    .modal-box {
      background: #fff; border-radius: 14px; padding: 28px; width: 100%;
      max-width: 480px; box-shadow: 0 8px 40px rgba(0,0,0,.2);
    }
    .modal-box h2   { font-size: 16px; margin-bottom: 6px; color: #1e3a5f; }
    .modal-box p    { font-size: 13px; color: #6b7280; margin-bottom: 16px; }
    .modal-box textarea {
      width: 100%; border: 1px solid #d1d5db; border-radius: 8px;
      padding: 10px 12px; font-size: 14px; resize: vertical; min-height: 90px;
      font-family: inherit; line-height: 1.5;
    }
    .modal-box textarea:focus { outline: none; border-color: #2563eb; }
    .modal-actions { display: flex; gap: 10px; margin-top: 14px; justify-content: flex-end; }
    .btn-modal-cancel { background: #f1f5f9; color: #374151; border: none; border-radius: 8px; padding: 9px 18px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .btn-modal-save   { background: #1e3a5f; color: #fff; border: none; border-radius: 8px; padding: 9px 18px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .btn-modal-save:hover { background: #2d5186; }
  </style>
</head>
<body>

  <!-- Top bar -->
  <div class="top-bar">
    <div class="top-bar-left">
      <h1>📋 Questionnaire Review — ${escHtml(clientName)}</h1>
      <p>${escHtml(caseRef)} · ${escHtml(caseType)} · ${escHtml(formTitle)}</p>
    </div>
    <div class="top-bar-right">
      <span class="staff-badge">Reviewing as ${escHtml(staffName)}</span>
      <span id="flag-counter">${flagCount} flag${flagCount !== 1 ? 's' : ''}</span>
      <span id="notify-msg"></span>
      <button id="notify-btn" ${flagCount === 0 ? 'disabled' : ''} onclick="sendNotification()">
        📧 Send Correction Request${flagCount > 0 ? ` (${flagCount})` : ''}
      </button>
    </div>
  </div>

  <!-- Content -->
  <div class="content">
    <div class="summary-card">
      <div class="summary-stat">
        <div class="num">${fields.length}</div>
        <div class="lbl">Total Fields</div>
      </div>
      <div class="summary-divider"></div>
      <div class="summary-stat">
        <div class="num">${fields.filter(f => f.value && f.value.trim()).length}</div>
        <div class="lbl">Answered</div>
      </div>
      <div class="summary-divider"></div>
      <div class="summary-stat">
        <div class="num">${fields.filter(f => !f.value || !f.value.trim()).length}</div>
        <div class="lbl">Empty</div>
      </div>
      <div class="summary-divider"></div>
      <div class="summary-stat">
        <div class="num" id="flag-count-stat">${flagCount}</div>
        <div class="lbl">Flagged</div>
      </div>
    </div>

    ${sectionHtml}
  </div>

  <!-- Flag modal -->
  <div id="flag-modal">
    <div class="modal-box">
      <h2>🚩 Flag for Correction</h2>
      <p id="modal-field-label">Loading…</p>
      <textarea id="modal-comment" placeholder="Write a note for the client explaining what needs to be corrected…"></textarea>
      <div class="modal-actions">
        <button class="btn-modal-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-modal-save"   onclick="saveFlag()">Save Flag</button>
      </div>
    </div>
  </div>

  <script>
    var CASE_REF  = ${JSON.stringify(String(caseRef))};
    var FORM_KEY  = ${JSON.stringify(String(formKey))};
    var FLAG_URL  = ${JSON.stringify(String(flagUrl))};
    var NOTIFY_URL = ${JSON.stringify(String(notifyUrl))};

    /* In-memory flags state — synced to server on every change */
    var flags = ${JSON.stringify(flags)};

    var _currentKey     = '';
    var _currentLabel   = '';
    var _currentSection = '';

    /* ── Flag modal ── */

    function openFlagForm(key, label, section, existingComment) {
      _currentKey     = key;
      _currentLabel   = label;
      _currentSection = section;
      document.getElementById('modal-field-label').textContent = label;
      document.getElementById('modal-comment').value = existingComment || '';
      document.getElementById('flag-modal').classList.add('open');
      setTimeout(function () { document.getElementById('modal-comment').focus(); }, 50);
    }

    function closeModal() {
      document.getElementById('flag-modal').classList.remove('open');
    }

    async function saveFlag() {
      var comment = (document.getElementById('modal-comment').value || '').trim();
      if (!comment) { alert('Please write a note for the client before saving.'); return; }

      flags[_currentKey] = {
        label:   _currentLabel,
        section: _currentSection,
        comment: comment,
      };

      closeModal();
      await persistFlags();
      refreshFlagUI();
    }

    async function removeFlag(key) {
      if (!confirm('Remove this flag?')) return;
      delete flags[key];
      await persistFlags();
      refreshFlagUI();
    }

    /* ── Persist flags to server ── */

    async function persistFlags() {
      try {
        var res = await fetch(FLAG_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ formKey: FORM_KEY, flags: flags }),
        });
        if (!res.ok) throw new Error('Status ' + res.status);
      } catch (err) {
        alert('Could not save flag to server: ' + err.message);
      }
    }

    /* ── Refresh UI after flag change ── */

    function refreshFlagUI() {
      var count = Object.keys(flags).length;

      document.getElementById('flag-counter').textContent    = count + ' flag' + (count !== 1 ? 's' : '');
      document.getElementById('flag-count-stat').textContent = count;

      var notifyBtn = document.getElementById('notify-btn');
      notifyBtn.disabled     = count === 0;
      notifyBtn.textContent  = '📧 Send Correction Request' + (count > 0 ? ' (' + count + ')' : '');

      /* Re-render each flagged row without a full page reload */
      var allRows = document.querySelectorAll('.field-row');
      allRows.forEach(function (row) {
        var key    = row.getAttribute('data-key');
        var flag   = flags[key];
        var area   = row.querySelector('.flag-area');
        if (!area) return;

        if (flag) {
          row.classList.add('flagged');
          area.innerHTML =
            '<div class="flag-badge">🚩 Flagged</div>' +
            '<div class="flag-comment-text">' + escHtml(flag.comment) + '</div>' +
            '<button class="btn-edit-flag" onclick="openFlagForm(' +
              JSON.stringify(key) + ',' + JSON.stringify(flag.label || key) + ',' + JSON.stringify(flag.section || '') + ',' + JSON.stringify(flag.comment) +
            ')">✏️ Edit</button>' +
            '<button class="btn-remove-flag" onclick="removeFlag(' + JSON.stringify(key) + ')">✕ Remove</button>';
        } else {
          row.classList.remove('flagged');
          area.innerHTML =
            '<button class="btn-flag" onclick="openFlagForm(' +
              JSON.stringify(key) + ',' + JSON.stringify(row.querySelector('.field-label')?.textContent || key) + ',\\'\\',\\'\\'' +
            ')">🚩 Flag</button>';
        }
      });
    }

    /* ── Send correction notification ── */

    async function sendNotification() {
      var count = Object.keys(flags).length;
      if (!count) { alert('Flag at least one field before sending.'); return; }

      var confirmed = confirm(
        'Send a correction request email to the client?\\n\\n' +
        count + ' flag' + (count !== 1 ? 's' : '') + ' will be included.\\n\\n' +
        'The client will receive an email with a direct link to update their questionnaire.'
      );
      if (!confirmed) return;

      var btn = document.getElementById('notify-btn');
      var msg = document.getElementById('notify-msg');
      btn.disabled    = true;
      btn.textContent = 'Sending…';

      try {
        var res = await fetch(NOTIFY_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ formKey: FORM_KEY }),
        });
        if (!res.ok) {
          var body = await res.json().catch(function () { return {}; });
          throw new Error(body.error || 'Status ' + res.status);
        }
        msg.textContent = '✓ Email sent at ' + new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
        btn.textContent = '📧 Send Correction Request (' + count + ')';
        setTimeout(function () { if (msg) msg.textContent = ''; }, 12000);
      } catch (err) {
        alert('Failed to send: ' + err.message);
        btn.textContent = '📧 Send Correction Request (' + count + ')';
      } finally {
        btn.disabled = false;
      }
    }

    function escHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /* Close modal on backdrop click */
    document.getElementById('flag-modal').addEventListener('click', function (e) {
      if (e.target === this) closeModal();
    });
  </script>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  loadFlags,
  saveFlags,
  getCaseDetails,
  sendCorrectionEmail,
  sendConsolidatedCorrectionEmail,
  buildReviewPage,
};
