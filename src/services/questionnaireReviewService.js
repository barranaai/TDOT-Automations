const mondayApi                  = require('./mondayApi');
const revisionNotificationService = require('./revisionNotificationService');

const BOARD_ID            = process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488';
const RESPONSE_STATUS_COL = 'color_mm135pm1';
const REVIEW_REQUIRED_COL = 'color_mm13f095';
const REVIEW_DATE_COL     = 'date_mm13rn5h';
const ESCALATION_COL      = 'color_mm13gtd5';
const REVIEW_NOTES_COL    = 'long_text_mm13kr4w';
const CASE_REF_COL        = 'text_mm12dgy9';

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
 * Response Status → Reviewed
 * Set Review Completed Date = today, Review Required = No
 */
async function onResponseReviewed({ itemId }) {
  const today = new Date().toISOString().split('T')[0];
  await updateCols(itemId, {
    [REVIEW_DATE_COL]:     { date: today },
    [REVIEW_REQUIRED_COL]: { label: 'No' },
  });
  console.log(`[QReview] Response reviewed for item ${itemId} — date set, review required cleared`);
}

/**
 * Response Status → Needs Clarification
 * Set Escalation Required = Triggered by Clarification
 * Queue revision notification email to client
 */
async function onNeedsClarification({ itemId }) {
  await updateCols(itemId, {
    [ESCALATION_COL]: { label: 'Triggered by Clarification' },
  });
  console.log(`[QReview] Needs clarification for item ${itemId} — escalation triggered`);

  // Fetch item name, review notes and case reference for notification
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
    const item       = data?.items?.[0];
    const col        = (id) => item?.column_values?.find((c) => c.id === id)?.text?.trim() || '';
    const caseRef    = col(CASE_REF_COL);
    const reviewNotes = col(REVIEW_NOTES_COL);
    if (caseRef) {
      revisionNotificationService.queueItem(caseRef, item.name, reviewNotes, 'questionnaire');
    }
  } catch (err) {
    console.error(`[QReview] Failed to queue revision notification for item ${itemId}:`, err.message);
  }
}

/**
 * Main entry point — called from webhook handler when a column changes
 * on the Questionnaire Execution Board.
 */
async function onColumnChange({ itemId, columnId, value }) {
  if (columnId !== RESPONSE_STATUS_COL) return;

  const label = value?.label?.text || '';

  if (label === 'Reviewed') {
    await onResponseReviewed({ itemId });
  } else if (label === 'Needs Clarification') {
    await onNeedsClarification({ itemId });
  }
}

module.exports = { onColumnChange };
