const mondayApi = require('./mondayApi');

const BOARD_ID            = process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488';
const RESPONSE_STATUS_COL = 'color_mm135pm1';
const REVIEW_REQUIRED_COL = 'color_mm13f095';
const REVIEW_DATE_COL     = 'date_mm13rn5h';
const ESCALATION_COL      = 'color_mm13gtd5';

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
 */
async function onNeedsClarification({ itemId }) {
  await updateCols(itemId, {
    [ESCALATION_COL]: { label: 'Triggered by Clarification' },
  });
  console.log(`[QReview] Needs clarification for item ${itemId} — escalation triggered`);
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
