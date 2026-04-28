/**
 * Missing-Fields Email Service
 *
 * Sends a "soft-tone" email to the client listing the questionnaire fields
 * they still need to fill in, grouped by family member → section. Triggered
 * from the /save and /submit handlers in htmlQuestionnaireForm routes.
 *
 * Frequency rules (set in product spec):
 *   - Autosave (`manual: false`)               → never email
 *   - Manual Save (`manual: true`)             → email at most once per 24 hours
 *   - Submit                                    → email always (unless 0 missing)
 *
 * Throttle storage:
 *   OneDrive file: Client Documents/<clientName> - <caseRef>/Questionnaire/email-throttle.json
 *   Shape: { lastMissingEmailAt: ISO8601 }
 *
 * Failures here MUST NOT affect the save/submit response — wire as fire-and-forget.
 */

'use strict';

const oneDrive          = require('./oneDriveService');
const mondayApi         = require('./mondayApi');
const { sendEmail }     = require('./microsoftMailService');
const { clientMasterBoardId } = require('../../config/monday');

const QUESTIONNAIRE_SUBFOLDER = 'Questionnaire';
const THROTTLE_FILENAME       = 'email-throttle.json';
const THROTTLE_HOURS          = 24;

const BASE_URL       = process.env.RENDER_URL    || 'https://tdot-automations.onrender.com';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';

const CM_COLS = {
  clientEmail: 'text_mm0xw6bp',
  caseRef:     'text_mm142s49',
  accessToken: 'text_mm0x6haq',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function getClientByCaseRef(caseRef) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $caseRef: String!) {
       items_page_by_column_values(
         board_id: $boardId, limit: 1,
         columns: [{ column_id: "${CM_COLS.caseRef}", column_values: [$caseRef] }]
       ) {
         items {
           id name
           column_values(ids: ${JSON.stringify([CM_COLS.clientEmail, CM_COLS.accessToken])}) { id text }
         }
       }
     }`,
    { boardId: String(clientMasterBoardId), caseRef }
  );
  const item = data?.items_page_by_column_values?.items?.[0];
  if (!item) return null;
  const col = (id) => item.column_values.find(c => c.id === id)?.text?.trim() || '';
  return {
    clientName:  (item.name || '').trim() || 'Client',
    clientEmail: col(CM_COLS.clientEmail),
    accessToken: col(CM_COLS.accessToken),
  };
}

// ─── Throttle (24h gate for manual saves) ───────────────────────────────────

async function readThrottle({ clientName, caseRef }) {
  try {
    const buf = await oneDrive.readFile({
      clientName, caseRef,
      subfolder: QUESTIONNAIRE_SUBFOLDER,
      filename:  THROTTLE_FILENAME,
    });
    if (!buf) return null;
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

async function writeThrottle({ clientName, caseRef, lastMissingEmailAt }) {
  const buffer = Buffer.from(JSON.stringify({ lastMissingEmailAt }, null, 2), 'utf8');
  try {
    await oneDrive.uploadFile({
      clientName, caseRef,
      category: QUESTIONNAIRE_SUBFOLDER,
      filename: THROTTLE_FILENAME,
      buffer,
      mimeType: 'application/json',
    });
  } catch (err) {
    console.warn(`[MissingEmail] Could not write throttle for ${caseRef}: ${err.message}`);
  }
}

function isWithinThrottleWindow(iso) {
  if (!iso) return false;
  const last = new Date(iso).getTime();
  if (isNaN(last)) return false;
  const ageMs = Date.now() - last;
  return ageMs < THROTTLE_HOURS * 60 * 60 * 1000;
}

// ─── Email body ─────────────────────────────────────────────────────────────

/**
 * @param {{ clientName, caseRef, formUrl, missingByMember: [{ memberLabel, sections: [{ section, fields: [string] }] }], totalMissing }} params
 */
function buildEmailHtml({ clientName, caseRef, formUrl, missingByMember, totalMissing }) {
  const memberBlocks = missingByMember.map(m => {
    const sections = (m.sections || []).map(s => `
      <div style="margin-top:14px;">
        <div style="font-size:13px; font-weight:700; color:#0B1D32; margin-bottom:4px;">
          ${escHtml(s.section)}
        </div>
        <ul style="margin:0; padding-left:20px; color:#475569; font-size:13px; line-height:1.6;">
          ${(s.fields || []).map(f => `<li>${escHtml(f)}</li>`).join('')}
        </ul>
      </div>`).join('');
    return `
      <div style="margin-top:20px; padding:16px 20px; background:#FAF8F4; border-left:3px solid #C9A84C; border-radius:4px;">
        <div style="font-size:14px; font-weight:700; color:#0B1D32; margin-bottom:4px;">
          👤 ${escHtml(m.memberLabel || 'Applicant')}
        </div>
        ${sections}
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html><body style="font-family:'Segoe UI',Arial,sans-serif; background:#FAF8F4; margin:0; padding:24px; color:#1F2937;">
  <div style="max-width:640px; margin:0 auto; background:#FFFFFF; border-radius:12px; padding:0; box-shadow:0 2px 12px rgba(11,29,50,.06); overflow:hidden;">
    <div style="background:#0B1D32; padding:20px 32px 18px; border-bottom:3px solid #C9A84C; text-align:center;">
      <img src="https://tdotimm.com/_next/image?url=%2Ftdot_logo_inv.webp&w=160&q=75" alt="TDOT Immigration" style="height:36px;object-fit:contain;display:inline-block;">
    </div>
    <div style="padding:28px 32px;">
    <h2 style="color:#0B1D32; margin:0 0 12px;">Hello ${escHtml(clientName || 'there')},</h2>

    <p style="font-size:14px; line-height:1.6; color:#334155;">
      Thank you for working on your questionnaire for case <strong>${escHtml(caseRef)}</strong>.
      We've saved your progress.
    </p>

    <p style="font-size:14px; line-height:1.6; color:#334155;">
      To process your case, we still need the following information.
      Please complete these fields whenever you're able — your case officer cannot
      begin the next steps until the questionnaire is complete.
    </p>

    <p style="font-size:13px; color:#64748b; margin-top:14px;">
      <strong>${totalMissing}</strong> field${totalMissing === 1 ? '' : 's'} pending across
      ${missingByMember.length} ${missingByMember.length === 1 ? 'applicant' : 'applicants'}:
    </p>

    ${memberBlocks}

    <div style="margin-top:24px; text-align:center;">
      <a href="${escHtml(formUrl)}"
         style="display:inline-block; background:#8B0000; color:#fff; text-decoration:none;
                padding:11px 22px; border-radius:6px; font-weight:700; font-size:14px;">
        📝 Continue Filling Your Questionnaire
      </a>
    </div>

    <p style="font-size:12px; color:#6B7280; margin-top:22px; line-height:1.5;">
      If you have any questions, simply reply to this email and your case officer will get back to you.
    </p>
    </div>
  </div>
</body></html>`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send the missing-fields email to the client.
 *
 * @param {{
 *   caseRef:  string,
 *   isSubmit: boolean,                                  // true on submit/submit-all, false on save
 *   manual:   boolean,                                  // true on manual save (button click), false on autosave
 *   missingByMember: [{ memberLabel: string, sections: [{ section, fields: [string] }] }]
 * }} params
 */
async function sendMissingFieldsEmail({ caseRef, isSubmit, manual, missingByMember }) {
  // Aggregate total missing — bail if nothing to email about
  const list = (missingByMember || []).filter(m => m && Array.isArray(m.sections) && m.sections.length);
  const totalMissing = list.reduce((sum, m) => sum + m.sections.reduce((s, sec) => s + (sec.fields || []).length, 0), 0);
  if (!totalMissing) return; // nothing to nag about

  // Frequency rules
  if (!isSubmit && !manual) return;          // autosave — never email
  // (isSubmit OR manual) → continue, but manual saves are throttled below

  // Look up client
  const client = await getClientByCaseRef(caseRef).catch(() => null);
  if (!client?.clientEmail) {
    console.warn(`[MissingEmail] No client/email for case ${caseRef} — skipping`);
    return;
  }

  // Throttle for manual saves only
  if (!isSubmit && manual) {
    const t = await readThrottle({ clientName: client.clientName, caseRef });
    if (isWithinThrottleWindow(t?.lastMissingEmailAt)) {
      console.log(`[MissingEmail] Throttled (last sent ${t.lastMissingEmailAt}) for case ${caseRef}`);
      return;
    }
  }

  const tokenParam = client.accessToken ? `?t=${encodeURIComponent(client.accessToken)}` : '';
  const formUrl    = `${BASE_URL}/q/${encodeURIComponent(caseRef)}${tokenParam}`;

  const subject = `Information Still Needed for Your Case — ${caseRef}`;
  const html    = buildEmailHtml({
    clientName: client.clientName,
    caseRef,
    formUrl,
    missingByMember: list,
    totalMissing,
  });

  await sendEmail({
    to:      client.clientEmail,
    subject,
    html,
    replyTo: EMAIL_REPLY_TO || undefined,
  });

  console.log(`[MissingEmail] Sent to ${client.clientEmail} for ${caseRef} — ${totalMissing} field(s) across ${list.length} member(s) (${isSubmit ? 'submit' : 'manual save'})`);

  // Update throttle (covers both manual save and submit; submit also resets the 24h window)
  await writeThrottle({
    clientName: client.clientName,
    caseRef,
    lastMissingEmailAt: new Date().toISOString(),
  });
}

module.exports = { sendMissingFieldsEmail };
