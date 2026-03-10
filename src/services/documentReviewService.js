const mondayApi                  = require('./mondayApi');
const revisionNotificationService = require('./revisionNotificationService');

const BOARD_ID            = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const DOC_STATUS_COL      = 'color_mm0zwgvr';
const REVIEW_REQUIRED_COL = 'color_mm0z796e';
const REVIEW_DATE_COL     = 'date_mm0z7vfg';
const ESCALATION_COL      = 'color_mm0zthce';
const REVIEW_NOTES_COL    = 'long_text_mm0zbpr';
const CASE_REF_COL        = 'text_mm0z2cck';
const REWORK_COUNT_COL    = 'numeric_mm0zwf95';

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
    }
  } catch (err) {
    console.error(`[DocReview] Failed to handle rework for item ${itemId}:`, err.message);
  }
}

/**
 * Main entry point — called from webhook handler when a column changes
 * on the Document Checklist Execution Board.
 */
async function onColumnChange({ itemId, columnId, value }) {
  if (columnId !== DOC_STATUS_COL) return;

  const label = value?.label?.text || '';

  if (label === 'Reviewed') {
    await onDocumentReviewed({ itemId });
  } else if (label === 'Rework Required') {
    await onReworkRequired({ itemId });
  }
}

module.exports = { onColumnChange };
