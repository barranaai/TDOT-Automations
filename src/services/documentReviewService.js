const mondayApi                  = require('./mondayApi');
const revisionNotificationService = require('./revisionNotificationService');
const { clientMasterBoardId }    = require('../../config/monday');

const BASE_URL            = process.env.RENDER_URL || 'https://tdot-automations.onrender.com';
const BOARD_ID            = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const DOC_STATUS_COL      = 'color_mm0zwgvr';
const REVIEW_REQUIRED_COL = 'color_mm0z796e';
const REVIEW_DATE_COL     = 'date_mm0z7vfg';
const ESCALATION_COL      = 'color_mm0zthce';
const REVIEW_NOTES_COL    = 'long_text_mm0zbpr';
const CASE_REF_COL        = 'text_mm0z2cck';
const REWORK_COUNT_COL    = 'numeric_mm0zwf95';

// Client Master column IDs — escalation
const CM_CASE_REF_COL         = 'text_mm142s49';
const CM_ESCALATION_REQ_COL   = 'color_mm0x7bje';
const CM_ESCALATION_REASON_COL = 'text_mm0xvpr9';

async function updateCols(itemId, colValues) {
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(
         board_id: $boardId, item_id: $itemId, column_values: $colValues
       ) { id }
     }`,
    { boardId: BOARD_ID, itemId: String(itemId), colValues: JSON.stringify(colValues) }
  );
}

/**
 * Look up the Client Master item ID for a given case reference, then set
 * Escalation Required = Yes and populate Escalation Reason.
 * The webhook on the Client Master board will pick up the Escalation Required
 * change and fire the supervisor/case-manager notification automatically.
 */
async function escalateToClientMaster(caseRef, documentName) {
  try {
    const data = await mondayApi.query(
      `query($boardId: ID!, $colId: String!, $val: String!) {
         items_page_by_column_values(
           limit: 1,
           board_id: $boardId,
           columns: [{ column_id: $colId, column_values: [$val] }]
         ) { items { id } }
       }`,
      {
        boardId: String(clientMasterBoardId),
        colId:   CM_CASE_REF_COL,
        val:     caseRef,
      }
    );

    const masterItemId = data?.items_page_by_column_values?.items?.[0]?.id;
    if (!masterItemId) {
      console.warn(`[DocReview] No Client Master item found for case ref "${caseRef}" — skipping escalation`);
      return;
    }

    await mondayApi.query(
      `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
         change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
       }`,
      {
        boardId:   String(clientMasterBoardId),
        itemId:    String(masterItemId),
        colValues: JSON.stringify({
          [CM_ESCALATION_REQ_COL]:    { label: 'Yes' },
          [CM_ESCALATION_REASON_COL]: `Document rework required — ${documentName} (${caseRef})`,
        }),
      }
    );

    console.log(`[DocReview] Escalation raised on Client Master for ${caseRef} — document: "${documentName}"`);
  } catch (err) {
    console.error(`[DocReview] Failed to escalate to Client Master for ${caseRef}:`, err.message);
  }
}

/**
 * Document Status → Reviewed
 * Set Review Completed Date = today, Review Required = No
 */
async function onDocumentReviewed({ itemId }) {
  const today = new Date().toISOString().split('T')[0];
  await updateCols(itemId, {
    [REVIEW_DATE_COL]:     { date: today },
    [REVIEW_REQUIRED_COL]: { label: 'No' },
  });
  console.log(`[DocReview] Document reviewed for item ${itemId} — date set, review required cleared`);
}

/**
 * Post a Monday Update (comment) on both the EXEC item and the Client Master
 * item announcing that staff has flagged a document for rework. Mirrors the
 * pattern used by documentFormService.postUploadUpdates() — same "two-sided"
 * notification so the case officer's Updates feed shows the action and the
 * document item itself shows the action in its history.
 *
 * Wired into onReworkRequired (status change). Not called from
 * onReviewNotesSet to avoid double-posting when the review form changes
 * both columns in a single mutation (Monday fires two webhook events).
 *
 * Failure here is non-fatal — the column writes and the email queue have
 * already happened by the time we get here. We log and move on.
 */
async function postReworkUpdates({ itemId, docName, reviewNotes, reworkCount, caseRef }) {
  try {
    const flaggedAt = new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: true });
    const reviewUrl = caseRef ? `${BASE_URL}/d/${encodeURIComponent(caseRef)}/review` : '';
    const reviewLine = reviewUrl ? `\n\n🔎 Open document review: ${reviewUrl}` : '';
    const notesLine  = reviewNotes ? `\n\n📝 Notes for client:\n${reviewNotes}` : '';
    const countLine  = reworkCount ? `\n\nRework count: ${reworkCount}` : '';

    // 1. Post on the EXEC item itself (so the document's update feed shows it)
    const docBody =
      `🔄 Rework Requested by Staff\n\n` +
      `Document: ${docName}\n` +
      `Case: ${caseRef || '(unknown)'}\n` +
      `Flagged: ${flaggedAt} (Toronto)` +
      countLine +
      notesLine +
      `\n\nStatus set to Rework Required — client will be emailed.${reviewLine}`;

    await mondayApi.query(
      `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      { itemId: String(itemId), body: docBody }
    );

    // 2. Post on the Client Master item (so the case team sees it in the case feed)
    if (!caseRef) return;
    const masterData = await mondayApi.query(
      `query($boardId: ID!, $caseRef: String!) {
         items_page_by_column_values(
           board_id: $boardId, limit: 1,
           columns: [{ column_id: "${CM_CASE_REF_COL}", column_values: [$caseRef] }]
         ) { items { id } }
       }`,
      { boardId: String(clientMasterBoardId), caseRef }
    );
    const masterItemId = masterData?.items_page_by_column_values?.items?.[0]?.id;
    if (!masterItemId) {
      console.warn(`[DocReview] No Client Master item found for case ${caseRef} — skipping master rework update`);
      return;
    }

    const masterBody =
      `🔄 Document Flagged for Client Rework\n\n` +
      `Document: ${docName}\n` +
      `Case: ${caseRef}\n` +
      `Flagged: ${flaggedAt} (Toronto)` +
      countLine +
      notesLine +
      `\n\nClient will be emailed in the next batch (≈2 min).${reviewLine}`;

    await mondayApi.query(
      `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      { itemId: String(masterItemId), body: masterBody }
    );
    console.log(`[DocReview] Posted rework Monday Updates for "${docName}" (case ${caseRef})`);
  } catch (err) {
    console.warn(`[DocReview] Could not post rework Monday Updates for item ${itemId}:`, err.message);
  }
}

/**
 * Document Status → Rework Required
 * Increment Rework Count, set Escalation Required,
 * and queue revision notification email to client.
 */
async function onReworkRequired({ itemId }) {
  try {
    // Fetch current count + notification data in one query
    const data = await mondayApi.query(
      `query($itemId: ID!) {
         items(ids: [$itemId]) {
           name
           column_values(ids: [
             "${REWORK_COUNT_COL}",
             "${REVIEW_NOTES_COL}",
             "${CASE_REF_COL}"
           ]) { id text }
         }
       }`,
      { itemId: String(itemId) }
    );
    const item         = data?.items?.[0];
    const col          = (id) => item?.column_values?.find((c) => c.id === id)?.text?.trim() || '';
    const currentCount = parseInt(col(REWORK_COUNT_COL), 10) || 0;
    const caseRef      = col(CASE_REF_COL);
    const reviewNotes  = col(REVIEW_NOTES_COL);

    // Increment count and set escalation in one write
    await updateCols(itemId, {
      [ESCALATION_COL]:   { label: 'Triggered by Rework' },
      [REWORK_COUNT_COL]: currentCount + 1,
    });
    console.log(
      `[DocReview] Rework required for item ${itemId} — ` +
      `rework count: ${currentCount + 1}, escalation triggered`
    );

    if (caseRef) {
      revisionNotificationService.queueItem(caseRef, item.name, reviewNotes, 'document');
      // Escalate to Client Master — webhook will fire onEscalationRequired notification
      await escalateToClientMaster(caseRef, item.name);
    }

    // Post a Monday Update (comment) on both the EXEC row and the Client
    // Master row so the case team sees the rework in the Updates feed.
    // Best-effort — non-fatal if it fails.
    await postReworkUpdates({
      itemId,
      docName:     item.name,
      reviewNotes,
      reworkCount: currentCount + 1,
      caseRef,
    });
  } catch (err) {
    console.error(`[DocReview] Failed to handle rework for item ${itemId}:`, err.message);
  }
}

/**
 * Review Notes column filled in → queue client email immediately.
 * The officer doesn't need to change the status separately.
 */
async function onReviewNotesSet({ itemId }) {
  try {
    const data = await mondayApi.query(
      `query($itemId: ID!) {
         items(ids: [$itemId]) {
           name
           column_values(ids: ["${REVIEW_NOTES_COL}", "${CASE_REF_COL}"]) { id text }
         }
       }`,
      { itemId: String(itemId) }
    );
    const item        = data?.items?.[0];
    const col         = (id) => item?.column_values?.find((c) => c.id === id)?.text?.trim() || '';
    const reviewNotes = col(REVIEW_NOTES_COL);
    const caseRef     = col(CASE_REF_COL);

    if (!reviewNotes || !caseRef) return;

    revisionNotificationService.queueItem(caseRef, item.name, reviewNotes, 'document');
    console.log(`[DocReview] Review notes set for item ${itemId} — queued client email for case ${caseRef}`);

    // Escalate to Client Master directly (don't call onReworkRequired to avoid
    // double escalation and duplicate rework count increment)
    await escalateToClientMaster(caseRef, item.name);
  } catch (err) {
    console.error(`[DocReview] Failed to handle review notes for item ${itemId}:`, err.message);
  }
}

/**
 * Main entry point — called from webhook handler when a column changes
 * on the Document Checklist Execution Board.
 */
async function onColumnChange({ itemId, columnId, value }) {
  // Review Notes filled in → notify client + set Rework Required status
  if (columnId === REVIEW_NOTES_COL) {
    const notes = value?.text || value?.value || '';
    if (notes) {
      await onReviewNotesSet({ itemId });
    }
    return;
  }

  if (columnId !== DOC_STATUS_COL) return;

  const label = value?.label?.text || '';

  if (label === 'Reviewed') {
    await onDocumentReviewed({ itemId });
  } else if (label === 'Rework Required') {
    await onReworkRequired({ itemId });
  }

  // Any document-status change (Received → Reviewed, Reviewed → Rework, etc.)
  // affects both Documents Readiness % and Documents Uploaded % on the master.
  // Fire-and-forget so a recalc failure can't block the webhook handler.
  triggerLiveRecalc(itemId).catch((err) =>
    console.warn(`[DocReview] Live readiness recalc failed for item ${itemId}:`, err.message)
  );
}

/**
 * Look up the case reference for an execution item and trigger a live
 * readiness recalculation on the Client Master Board.
 */
async function triggerLiveRecalc(itemId) {
  const data = await mondayApi.query(
    `query($id: ID!) {
       items(ids: [$id]) { column_values(ids: ["${CASE_REF_COL}"]) { text } }
     }`,
    { id: String(itemId) }
  );
  const caseRef = data?.items?.[0]?.column_values?.[0]?.text?.trim();
  if (!caseRef) return;
  await require('./caseReadinessService').calculateForCaseRef(caseRef);
}

module.exports = { onColumnChange };
