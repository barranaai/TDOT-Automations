const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');
const { getQuestionnaireItemsByCaseType } = require('./questionnaireTemplateService');
const { createMissingQuestionnaireItems } = require('./questionnaireExecutionService');

// Client Master column IDs
const CM_COLS = {
  caseReferenceNumber:          'text_mm142s49',
  primaryCaseType:              'dropdown_mm0xd1qn',
  caseSubType:                  'dropdown_mm0x4t91',
  questionnaireTemplateApplied: 'color_mm0x3tpw',
};

const QUESTIONNAIRE_NOT_APPLIED_VALUE = 'No';

/**
 * Triggered when Case Stage → "Document Collection Started".
 * Runs only if "Questionnaire Template Applied" = "No" on the Client Master item.
 *
 * @param {{ itemId: string|number, boardId: string|number }} param
 */
async function onDocumentCollectionStarted({ itemId, boardId }) {
  console.log(`[QuestionnaireService] Triggered for item ${itemId} on board ${boardId}`);

  // 1. Fetch Client Master item
  const data = await mondayApi.query(
    `query getItem($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        name
        column_values(ids: [
          "${CM_COLS.caseReferenceNumber}",
          "${CM_COLS.primaryCaseType}",
          "${CM_COLS.caseSubType}",
          "${CM_COLS.questionnaireTemplateApplied}"
        ]) {
          id
          text
        }
      }
    }`,
    { itemId: String(itemId) }
  );

  const item = data?.items?.[0];
  if (!item) {
    console.warn(`[QuestionnaireService] Item ${itemId} not found`);
    return;
  }

  // 2. Extract columns
  const colMap = {};
  for (const col of item.column_values) {
    colMap[col.id] = col.text;
  }

  const caseRef             = (colMap[CM_COLS.caseReferenceNumber] || '').replace(/\s+/g, ' ').trim();
  const caseType            = (colMap[CM_COLS.primaryCaseType] || '').trim();
  const caseSubType         = (colMap[CM_COLS.caseSubType] || '').trim() || null;
  const questionnaireStatus = (colMap[CM_COLS.questionnaireTemplateApplied] || '').trim();

  console.log(
    `[QuestionnaireService] Item: "${item.name}" | Ref: ${caseRef} | ` +
    `Type: ${caseType} | SubType: ${caseSubType} | Questionnaire Applied: ${questionnaireStatus}`
  );

  // 3. Guard: only proceed if Questionnaire Template Applied = "No"
  if (questionnaireStatus && questionnaireStatus.trim().toLowerCase() !== QUESTIONNAIRE_NOT_APPLIED_VALUE.toLowerCase()) {
    console.log(`[QuestionnaireService] Questionnaire already applied ("${questionnaireStatus}"). Skipping.`);
    return;
  }

  if (!caseRef) {
    console.warn(`[QuestionnaireService] No Case Reference Number for item ${itemId}. Skipping.`);
    return;
  }

  if (!caseType) {
    console.warn(`[QuestionnaireService] No Primary Case Type for item ${itemId}. Skipping.`);
    return;
  }

  // 4. Fetch matching template questions
  let templateItems;
  try {
    templateItems = await getQuestionnaireItemsByCaseType(caseType, caseSubType);
    console.log(
      `[QuestionnaireService] Found ${templateItems.length} template questions for "${caseType}"` +
      (caseSubType ? ` (sub type: "${caseSubType}")` : ' (no sub type filter)')
    );
  } catch (err) {
    console.error(`[QuestionnaireService] Template lookup failed: ${err.message}`);
    return;
  }

  if (!templateItems.length) {
    console.warn(`[QuestionnaireService] No questionnaire items for case type "${caseType}". Nothing to create.`);
    return;
  }

  // 5. Create missing questionnaire execution items
  const { created, skipped } = await createMissingQuestionnaireItems({
    caseRef,
    clientMasterItemId: String(itemId),
    templateItems,
  });

  console.log(`[QuestionnaireService] Done — created: ${created}, skipped (already existed): ${skipped}`);

  // Mark questionnaire template as applied so the guard correctly blocks any future re-trigger
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
     }`,
    {
      boardId:   String(clientMasterBoardId),
      itemId:    String(itemId),
      colValues: JSON.stringify({ [CM_COLS.questionnaireTemplateApplied]: { label: 'Yes' } }),
    }
  );
  console.log(`[QuestionnaireService] Questionnaire Applied → Yes for ${caseRef}`);
}

module.exports = { onDocumentCollectionStarted };
