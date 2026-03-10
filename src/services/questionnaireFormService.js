require('dotenv').config();
const mondayApi = require('./mondayApi');

const BOARD_ID               = process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488';
const TEMPLATE_BOARD_ID      = process.env.MONDAY_QUESTIONNAIRE_TEMPLATE_BOARD_ID  || '18402113809';
const CASE_REF_COL           = 'text_mm12dgy9';
const CLIENT_RESP_COL        = 'long_text_mm13xjp5';
const LAST_RESP_DATE         = 'date_mm13v6wg';
const TEMPLATE_RELATION_COL  = 'board_relation_mm12yvmf';
const HELP_TEXT_COL          = 'long_text_mm12df2b';

const FETCH_COLS = [
  'lookup_mm13fva6',        // Question Category
  'lookup_mm13nnd0',        // Input Type
  'lookup_mm1333gw',        // Required Type
  'lookup_mm12m2ej',        // Question Code
  CLIENT_RESP_COL,          // Client Response (current answer)
  TEMPLATE_RELATION_COL,    // Link to Questionnaire Template Board
];

/**
 * Fetch all questionnaire execution items for a given case reference.
 * Returns items sorted by category then question code.
 */
async function getCaseItems(caseRef) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $caseRef: String!) {
      items_page_by_column_values(
        limit: 500,
        board_id: $boardId,
        columns: [{ column_id: "${CASE_REF_COL}", column_values: [$caseRef] }]
      ) {
        items {
          id
          name
          column_values(ids: ${JSON.stringify(FETCH_COLS)}) {
            id text value
          }
        }
      }
    }`,
    { boardId: BOARD_ID, caseRef }
  );

  const items = data?.items_page_by_column_values?.items || [];
  if (!items.length) return [];

  // Collect linked template item IDs from the board_relation column
  const templateIdMap = {}; // executionItemId → templateItemId
  items.forEach((item) => {
    const relCol = item.column_values.find((c) => c.id === TEMPLATE_RELATION_COL);
    if (relCol?.value) {
      try {
        const parsed   = JSON.parse(relCol.value);
        const linkedId = (parsed.linkedPulseIds || [])[0];
        if (linkedId) templateIdMap[item.id] = String(linkedId);
      } catch { /* ignore */ }
    }
  });

  // Batch-fetch Help Text from the Questionnaire Template Board
  const helpTextMap = {};
  const templateIds = Object.values(templateIdMap);
  if (templateIds.length) {
    const tData = await mondayApi.query(
      `query($ids: [ID!]!) {
         items(ids: $ids) {
           id
           column_values(ids: ["${HELP_TEXT_COL}"]) { id text }
         }
       }`,
      { ids: templateIds }
    );
    (tData.items || []).forEach((tItem) => {
      const helpText = tItem.column_values.find((c) => c.id === HELP_TEXT_COL)?.text?.trim() || '';
      helpTextMap[String(tItem.id)] = helpText;
    });
  }

  return items
    .map((item) => {
      const col    = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
      const rawVal = item.column_values.find((c) => c.id === CLIENT_RESP_COL)?.value || '';

      let currentAnswer = '';
      if (rawVal) {
        try { currentAnswer = JSON.parse(rawVal)?.text || ''; } catch { currentAnswer = col(CLIENT_RESP_COL); }
      }

      const templateId = templateIdMap[item.id];
      const helpText   = templateId ? (helpTextMap[templateId] || '') : '';

      return {
        id:           item.id,
        name:         item.name,
        category:     col('lookup_mm13fva6') || 'General',
        inputType:    col('lookup_mm13nnd0') || 'Short Text',
        required:     col('lookup_mm1333gw') || 'Mandatory',
        questionCode: col('lookup_mm12m2ej') || '',
        currentAnswer,
        helpText,
      };
    })
    .sort((a, b) => {
      if (a.category < b.category) return -1;
      if (a.category > b.category) return 1;
      return (a.questionCode || '').localeCompare(b.questionCode || '', undefined, { numeric: true });
    });
}

/**
 * Persist one or more answers back to Monday execution board items.
 * answers: [{ itemId, answer }]
 */
async function saveAnswers(answers) {
  const today = new Date().toISOString().split('T')[0];

  const results = await Promise.allSettled(
    answers
      .filter(({ answer }) => answer !== undefined && answer !== null)
      .map(({ itemId, answer }) => {
        const colValues = JSON.stringify({
          [CLIENT_RESP_COL]: { text: String(answer) },
          [LAST_RESP_DATE]:  { date: today },
        });
        return mondayApi.query(
          `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
            change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
          }`,
          { boardId: BOARD_ID, itemId, colValues }
        );
      })
  );

  const failed = results.filter((r) => r.status === 'rejected').length;
  return { saved: answers.length - failed, failed };
}

/**
 * Mark all items for a case as submitted (update Last Response Date for all).
 */
async function submitQuestionnaire(caseRef) {
  const items = await getCaseItems(caseRef);
  if (!items.length) throw new Error(`No questionnaire items found for case: ${caseRef}`);

  const today   = new Date().toISOString().split('T')[0];
  const results = await Promise.allSettled(
    items.map(({ id: itemId }) => {
      const colValues = JSON.stringify({ [LAST_RESP_DATE]: { date: today } });
      return mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
          change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
        }`,
        { boardId: BOARD_ID, itemId, colValues }
      );
    })
  );

  const failed = results.filter((r) => r.status === 'rejected').length;
  return { submitted: items.length - failed, failed };
}

module.exports = { getCaseItems, saveAnswers, submitQuestionnaire };
