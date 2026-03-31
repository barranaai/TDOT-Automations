const mondayApi                  = require('./mondayApi');
const revisionNotificationService = require('./revisionNotificationService');
const { clientMasterBoardId }    = require('../../config/monday');

const BOARD_ID               = process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488';
const RESPONSE_STATUS_COL    = 'color_mm135pm1';
const REVIEW_REQUIRED_COL    = 'color_mm13f095';
const REVIEW_DATE_COL        = 'date_mm13rn5h';
const ESCALATION_COL         = 'color_mm13gtd5';
const REVIEW_NOTES_COL       = 'long_text_mm13kr4w';
const CASE_REF_COL           = 'text_mm12dgy9';
const CLARIFICATION_COUNT_COL = 'numeric_mm13sx0f';

// Client Master column IDs — escalation
const CM_CASE_REF_COL          = 'text_mm142s49';
const CM_ESCALATION_REQ_COL    = 'color_mm0x7bje';
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
 * The webhook on the Client Master board will pick up the change and fire
 * the supervisor/case-manager notification automatically.
 */
async function escalateToClientMaster(caseRef, questionName) {
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
      console.warn(`[QReview] No Client Master item found for case ref "${caseRef}" — skipping escalation`);
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
          [CM_ESCALATION_REASON_COL]: `Questionnaire clarification required — ${questionName} (${caseRef})`,
        }),
      }
    );

    console.log(`[QReview] Escalation raised on Client Master for ${caseRef} — question: "${questionName}"`);
  } catch (err) {
    console.error(`[QReview] Failed to escalate to Client Master for ${caseRef}:`, err.message);
  }
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
 * Increment Clarification Count, set Escalation Required,
 * and queue revision notification email to client.
 */
async function onNeedsClarification({ itemId }) {
  try {
    // Fetch current count + notification data in one query
    const data = await mondayApi.query(
      `query($itemId: ID!) {
         items(ids: [$itemId]) {
           name
           column_values(ids: [
             "${CLARIFICATION_COUNT_COL}",
             "${REVIEW_NOTES_COL}",
             "${CASE_REF_COL}"
           ]) { id text }
         }
       }`,
      { itemId: String(itemId) }
    );
    const item              = data?.items?.[0];
    const col               = (id) => item?.column_values?.find((c) => c.id === id)?.text?.trim() || '';
    const currentCount      = parseInt(col(CLARIFICATION_COUNT_COL), 10) || 0;
    const caseRef           = col(CASE_REF_COL);
    const reviewNotes       = col(REVIEW_NOTES_COL);

    // Increment count and set escalation in one write
    await updateCols(itemId, {
      [ESCALATION_COL]:          { label: 'Triggered by Clarification' },
      [CLARIFICATION_COUNT_COL]: currentCount + 1,
    });
    console.log(
      `[QReview] Needs clarification for item ${itemId} — ` +
      `clarification count: ${currentCount + 1}, escalation triggered`
    );

    if (caseRef) {
      revisionNotificationService.queueItem(caseRef, item.name, reviewNotes, 'questionnaire');
      // Escalate to Client Master — webhook will fire onEscalationRequired notification
      await escalateToClientMaster(caseRef, item.name);
    }
  } catch (err) {
    console.error(`[QReview] Failed to handle clarification for item ${itemId}:`, err.message);
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
