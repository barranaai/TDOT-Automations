const mondayApi = require('./mondayApi');

const BOARD_ID            = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const DOC_STATUS_COL      = 'color_mm0zwgvr';
const REVIEW_REQUIRED_COL = 'color_mm0z796e';
const REVIEW_DATE_COL     = 'date_mm0z7vfg';
const ESCALATION_COL      = 'color_mm0zthce';

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
 * Set Escalation Required = Triggered by Rework
 */
async function onReworkRequired({ itemId }) {
  await updateCols(itemId, {
    [ESCALATION_COL]: { label: 'Triggered by Rework' },
  });
  console.log(`[DocReview] Rework required for item ${itemId} — escalation triggered`);
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
