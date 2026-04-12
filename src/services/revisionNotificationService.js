const fs   = require('fs');
const path = require('path');
const { sendEmail } = require('./microsoftMailService');
const mondayApi     = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const BASE_URL       = process.env.RENDER_URL    || 'https://tdot-automations.onrender.com';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';

// Batch window — wait this many ms after the last change before sending
const BATCH_DELAY_MS = 2 * 60 * 1000; // 2 minutes

// Queue persisted to disk so pending emails survive server restarts
const QUEUE_DIR  = path.join(__dirname, '../../.queue');
const QUEUE_FILE = path.join(QUEUE_DIR, 'revision-queue.json');

// In-memory queue: caseRef → { questionnaire: [...], documents: [...], timer }
const queue = new Map();

// ─── Queue persistence ──────────────────────────────────────────────────────

function persistQueue() {
  try {
    const serializable = {};
    for (const [key, entry] of queue) {
      serializable[key] = { questionnaire: entry.questionnaire, documents: entry.documents };
    }
    if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(serializable, null, 2));
  } catch (err) {
    console.warn(`[RevisionNotify] Could not persist queue: ${err.message}`);
  }
}

function restoreQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    let restored = 0;
    for (const [caseRef, entry] of Object.entries(saved)) {
      if (!entry.questionnaire?.length && !entry.documents?.length) continue;
      queue.set(caseRef, {
        questionnaire: entry.questionnaire || [],
        documents:     entry.documents || [],
        timer: setTimeout(() => {
          flushQueue(caseRef).catch((err) =>
            console.error(`[RevisionNotify] Failed to send restored item for case ${caseRef}:`, err.message)
          );
        }, 5000), // fire quickly after restart — items already waited before restart
      });
      restored++;
    }
    if (restored > 0) {
      console.log(`[RevisionNotify] Restored ${restored} pending notification(s) from disk`);
    }
    // Clean up the file after restoring
    fs.unlinkSync(QUEUE_FILE);
  } catch (err) {
    console.warn(`[RevisionNotify] Could not restore queue: ${err.message}`);
  }
}

// Restore any pending items from a previous server instance
restoreQueue();

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
           name
           column_values(ids: [
             "text_mm0xw6bp",
             "text_mm142s49",
             "text_mm0x6haq"
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
    clientName:   (item.name || '').trim() || 'Valued Client',
    clientEmail:  col('text_mm0xw6bp'),
    caseRef:      col('text_mm142s49'),
    accessToken:  col('text_mm0x6haq'),
  };
}

// ─── Email builder ───────────────────────────────────────────────────────────

function buildRevisionEmailHtml({ clientName, caseRef, accessToken, questionnaire, documents }) {
  const encodedRef        = encodeURIComponent(caseRef);
  const tokenParam        = accessToken ? `?t=${encodeURIComponent(accessToken)}` : '';
  const questionnaireUrl  = `${BASE_URL}/q/${encodedRef}${tokenParam}`;
  const documentsUrl      = `${BASE_URL}/documents/${encodedRef}`;

  const qRows = questionnaire.map(({ name, notes }) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:600;color:#1e293b;font-size:.9rem;">${name}</div>
        <div style="margin-top:4px;font-size:.82rem;color:#475569;">${notes || 'Please review and update your answer for this question.'}</div>
      </td>
    </tr>`).join('');

  const dRows = documents.map(({ name, notes }) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:600;color:#1e293b;font-size:.9rem;">${name}</div>
        <div style="margin-top:4px;font-size:.82rem;color:#475569;">${notes || 'Please re-upload this document.'}</div>
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

  const { questionnaire, documents } = entry;
  if (!questionnaire.length && !documents.length) {
    queue.delete(caseRef);
    persistQueue();
    return;
  }

  const client = await getClientByCaseRef(caseRef);
  if (!client?.clientEmail) {
    console.warn(`[RevisionNotify] No client email found for case ${caseRef} — skipping`);
    queue.delete(caseRef);
    persistQueue();
    return;
  }

  const totalCount = questionnaire.length + documents.length;
  const subject    = `Action Required: ${totalCount} item${totalCount !== 1 ? 's' : ''} need${totalCount === 1 ? 's' : ''} your attention — Case ${caseRef}`;

  await sendEmail({
    to:      client.clientEmail,
    subject,
    html:    buildRevisionEmailHtml({ ...client, questionnaire, documents }),
    replyTo: EMAIL_REPLY_TO || undefined,
  });

  // Only remove from queue AFTER successful send — prevents data loss on failure
  queue.delete(caseRef);
  persistQueue();

  console.log(
    `[RevisionNotify] Sent to ${client.clientEmail} for case ${caseRef} — ` +
    `${questionnaire.length} questionnaire, ${documents.length} document items`
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
  persistQueue();
  console.log(`[RevisionNotify] Queued ${type} item "${itemName}" for case ${caseRef} (batch fires in 2 min)`);
}

module.exports = { queueItem };
