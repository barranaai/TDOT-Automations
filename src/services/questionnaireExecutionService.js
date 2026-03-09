const mondayApi = require('./mondayApi');
const { questionnaireExecutionBoardId } = require('../../config/monday');

// Questionnaire Execution Board column IDs
const EXEC_COLS = {
  caseReferenceNumber: 'text_mm12dgy9',
  intakeItemId:        'text_mm135c64',
  templateBoard:       'board_relation_mm12yvmf', // connect → Questionnaire Template Board
  clientMasterBoard:   'board_relation_mm12x2mj', // connect → Client Master Board
};

// Prefix to differentiate questionnaire unique keys from document checklist keys
const UNIQUE_KEY_PREFIX = 'Q';

const EXECUTION_GROUP_ID = 'topics';

/**
 * Fetch all question names already in the Execution Board for a given case reference.
 * Used as a lightweight duplicate check (by Case Reference + item name).
 *
 * @param {string} caseRef
 * @returns {Promise<Set<string>>} Set of "caseRef|questionName" strings
 */
async function getExistingQuestionKeys(caseRef) {
  const data = await mondayApi.query(
    `query getExistingQuestions($boardId: ID!, $colId: String!, $colValue: String!) {
      items_page_by_column_values(
        limit: 500,
        board_id: $boardId,
        columns: [{ column_id: $colId, column_values: [$colValue] }]
      ) {
        items {
          name
        }
      }
    }`,
    {
      boardId:  String(questionnaireExecutionBoardId),
      colId:    EXEC_COLS.caseReferenceNumber,
      colValue: caseRef,
    }
  );

  const items = data?.items_page_by_column_values?.items ?? [];
  return new Set(items.map((i) => `${caseRef}|${i.name}`));
}

/**
 * Create a single item in the Questionnaire Execution Board.
 *
 * @param {{
 *   name: string,
 *   caseRef: string,
 *   clientMasterItemId: string,
 *   templateItemId: string,
 * }} itemData
 */
async function createQuestionnaireItem(itemData) {
  const { name, caseRef, clientMasterItemId, templateItemId } = itemData;

  const columnValues = JSON.stringify({
    [EXEC_COLS.caseReferenceNumber]: caseRef,
    [EXEC_COLS.intakeItemId]:        templateItemId,
    [EXEC_COLS.templateBoard]:       { item_ids: [Number(templateItemId)] },
    [EXEC_COLS.clientMasterBoard]:   { item_ids: [Number(clientMasterItemId)] },
  });

  const data = await mondayApi.query(
    `mutation createQuestionnaireItem(
      $boardId: ID!,
      $groupId: String!,
      $itemName: String!,
      $columnValues: JSON!
    ) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
        name
      }
    }`,
    {
      boardId:      String(questionnaireExecutionBoardId),
      groupId:      EXECUTION_GROUP_ID,
      itemName:     name,
      columnValues,
    }
  );

  return data?.create_item;
}

/**
 * Create all missing questionnaire execution items for a client case.
 * Skips items that already exist (duplicate prevention by case ref + question name).
 *
 * @param {{
 *   caseRef: string,
 *   clientMasterItemId: string,
 *   templateItems: Array<{ id, name, questionCode }>,
 * }} params
 * @returns {Promise<{ created: number, skipped: number }>}
 */
async function createMissingQuestionnaireItems({ caseRef, clientMasterItemId, templateItems }) {
  const existingKeys = await getExistingQuestionKeys(caseRef);
  console.log(`[QuestionnaireExecutionService] Existing questions for "${caseRef}": ${existingKeys.size}`);

  let created = 0;
  let skipped = 0;

  for (const tmpl of templateItems) {
    if (!tmpl.name) continue;

    const dedupeKey = `${caseRef}|${tmpl.name}`;

    if (existingKeys.has(dedupeKey)) {
      console.log(`[QuestionnaireExecutionService] Skipping (exists): ${tmpl.name}`);
      skipped++;
      continue;
    }

    try {
      const result = await createQuestionnaireItem({
        name:               tmpl.name,
        caseRef,
        clientMasterItemId,
        templateItemId:     tmpl.id,
      });
      console.log(`[QuestionnaireExecutionService] Created: "${tmpl.name}" (id: ${result?.id})`);
      created++;
    } catch (err) {
      console.error(`[QuestionnaireExecutionService] Failed to create "${tmpl.name}":`, err.message);
    }
  }

  return { created, skipped };
}

module.exports = { createMissingQuestionnaireItems };
