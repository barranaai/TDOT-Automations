const { Resend } = require('resend');
const mondayApi  = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const BASE_URL      = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';
const EMAIL_FROM    = process.env.EMAIL_FROM || 'TDOT Immigration <noreply@tdotimmigration.ca>';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';

// Batch window — wait this many ms after the last change before sending
const BATCH_DELAY_MS = 2 * 60 * 1000; // 2 minutes

// In-memory queue: caseRef → { questionnaire: [...], documents: [...], timer }
const queue = new Map();

// ─── Client lookup ──────────────────────────────────────────────────────────

async function getClientByCaseRef(caseRef) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $caseRef: String!) {
       items_page_by_column_values(
         limit: 1,
         board_id: $boardId,
         columns: [{ column_id: "text_mm142s49", column_values: [$caseRef] }]
       ) {
         items {
           column_values(ids: [
             "text_mm0x1zdk",
             "text_mm0xw6bp",
             "text_mm142s49"
           ]) { id text }
         }
       }
     }`,
    { boardId: String(clientMasterBoardId), caseRef }
  );

  const item = data?.items_page_by_column_values?.items?.[0];
  if (!item) return null;

  const col = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
  return {
    clientName:  col('text_mm0x1zdk') || 'Valued Client',
    clientEmail: col('text_mm0xw6bp'),
    caseRef:     col('text_mm142s49'),
  };
}

// ─── Email builder ───────────────────────────────────────────────────────────

function buildRevisionEmailHtml({ clientName, caseRef, questionnaire, documents }) {
  const encodedRef        = encodeURIComponent(caseRef);
  const questionnaireUrl  = `${BASE_URL}/questionnaire/${encodedRef}`;
  const documentsUrl      = `${BASE_URL}/documents/${encodedRef}`;

  const qRows = questionnaire.map(({ name, notes }) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:600;color:#1e293b;font-size:.9rem;">${name}</div>
        ${notes ? `<div style="margin-top:4px;font-size:.82rem;color:#475569;">${notes}</div>` : ''}
      </td>
    </tr>`).join('');

  const dRows = documents.map(({ name, notes }) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:600;color:#1e293b;font-size:.9rem;">${name}</div>
        ${notes ? `<div style="margin-top:4px;font-size:.82rem;color:#475569;">${notes}</div>` : ''}
      </td>
    </tr>`).join('');

  const qSection = questionnaire.length ? `
    <h3 style="margin:24px 0 8px;font-size:1rem;color:#1e293b;">📝 Questions requiring your attention</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:collapse;margin-bottom:16px;">
      ${qRows}
    </table>
    <p style="margin:0 0 20px;">
      <a href="${questionnaireUrl}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-size:.9rem;">
        Update Questionnaire →
      </a>
    </p>` : '';

  const dSection = documents.length ? `
    <h3 style="margin:24px 0 8px;font-size:1rem;color:#1e293b;">📂 Documents requiring re-upload</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:collapse;margin-bottom:16px;">
      ${dRows}
    </table>
    <p style="margin:0 0 20px;">
      <a href="${documentsUrl}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-size:.9rem;">
        Upload Documents →
      </a>
    </p>` : '';

  const totalCount = questionnaire.length + documents.length;

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
    <div style="background:#dc2626;padding:24px 32px;">
      <h1 style="margin:0;color:#fff;font-size:1.2rem;">⚠️ Action Required — ${totalCount} item${totalCount !== 1 ? 's' : ''} need${totalCount === 1 ? 's' : ''} your attention</h1>
    </div>
    <div style="padding:28px 32px;">
      <p style="margin:0 0 16px;color:#374151;">Dear ${clientName},</p>
      <p style="margin:0 0 20px;color:#374151;">
        Our case officer has reviewed your submission for case <strong>${caseRef}</strong> and requires
        clarification or updated materials on the following item${totalCount !== 1 ? 's' : ''}:
      </p>
      ${qSection}
      ${dSection}
      <p style="margin:24px 0 0;font-size:.82rem;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
        If you have any questions please reply to this email or contact your case manager.
        <br>TDOT Immigration Services
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ─── Send ────────────────────────────────────────────────────────────────────

async function flushQueue(caseRef) {
  const entry = queue.get(caseRef);
  if (!entry) return;
  queue.delete(caseRef);

  const { questionnaire, documents } = entry;
  if (!questionnaire.length && !documents.length) return;

  const client = await getClientByCaseRef(caseRef);
  if (!client?.clientEmail) {
    console.warn(`[RevisionNotify] No client email found for case ${caseRef} — skipping`);
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const totalCount = questionnaire.length + documents.length;
  const subject    = `Action Required: ${totalCount} item${totalCount !== 1 ? 's' : ''} need${totalCount === 1 ? 's' : ''} your attention — Case ${caseRef}`;

  const emailOptions = {
    from:    EMAIL_FROM,
    to:      client.clientEmail,
    subject,
    html:    buildRevisionEmailHtml({ ...client, questionnaire, documents }),
  };
  if (EMAIL_REPLY_TO) emailOptions.reply_to = EMAIL_REPLY_TO;

  const { data, error } = await resend.emails.send(emailOptions);
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);

  console.log(
    `[RevisionNotify] Sent to ${client.clientEmail} for case ${caseRef} — ` +
    `${questionnaire.length} questionnaire, ${documents.length} document items (id: ${data.id})`
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Queue a revision notification for a case.
 * type: 'questionnaire' | 'document'
 */
function queueItem(caseRef, itemName, reviewNotes, type) {
  if (!caseRef) return;

  let entry = queue.get(caseRef);
  if (entry) {
    clearTimeout(entry.timer);
  } else {
    entry = { questionnaire: [], documents: [] };
  }

  const bucket = type === 'document' ? entry.documents : entry.questionnaire;
  // Avoid duplicates within same batch
  if (!bucket.find((i) => i.name === itemName)) {
    bucket.push({ name: itemName, notes: reviewNotes || '' });
  }

  entry.timer = setTimeout(() => {
    flushQueue(caseRef).catch((err) =>
      console.error(`[RevisionNotify] Failed to send for case ${caseRef}:`, err.message)
    );
  }, BATCH_DELAY_MS);

  queue.set(caseRef, entry);
  console.log(`[RevisionNotify] Queued ${type} item "${itemName}" for case ${caseRef} (batch fires in 2 min)`);
}

module.exports = { queueItem };
