require('dotenv').config();
const mondayApi = require('./mondayApi');

const BOARD_ID          = process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488';
const TEMPLATE_BOARD_ID = process.env.MONDAY_QUESTIONNAIRE_TEMPLATE_BOARD_ID  || '18402113809';
const CASE_REF_COL      = 'text_mm12dgy9';
const CLIENT_RESP_COL   = 'long_text_mm13xjp5';
const LAST_RESP_DATE    = 'date_mm13v6wg';

const FETCH_COLS = [
  'lookup_mm13fva6',   // Question Category
  'lookup_mm13nnd0',   // Input Type
  'lookup_mm1333gw',   // Required Type
  'lookup_mm12m2ej',   // Question Code
  CLIENT_RESP_COL,     // Client Response (current answer)
];

/**
 * Fetch all template help texts keyed by question name (item name).
 * The Question Code mirror on the execution board returns null, so we
 * match by the question text which is identical on both boards.
 */
async function getTemplateHelpTextByName() {
  const map  = {};
  let cursor = null;

  do {
    let data;
    if (cursor) {
      data = await mondayApi.query(
        `query($cursor: String!) {
           boards(ids: ["${TEMPLATE_BOARD_ID}"]) {
             items_page(limit: 200, cursor: $cursor) {
               cursor
               items {
                 name
                 column_values(ids: ["long_text_mm12df2b"]) { id text }
               }
             }
           }
         }`,
        { cursor }
      );
    } else {
      data = await mondayApi.query(
        `{
           boards(ids: ["${TEMPLATE_BOARD_ID}"]) {
             items_page(limit: 200) {
               cursor
               items {
                 name
                 column_values(ids: ["long_text_mm12df2b"]) { id text }
               }
             }
           }
         }`
      );
    }

    const page = data.boards[0].items_page;
    for (const item of page.items) {
      const helpText = item.column_values.find((c) => c.id === 'long_text_mm12df2b')?.text?.trim() || '';
      if (item.name && helpText) map[item.name.trim()] = helpText;
    }
    cursor = page.cursor || null;
  } while (cursor);

  return map;
}

/**
 * Fetch all questionnaire execution items for a given case reference.
 * Returns items sorted by category then question code.
 */
async function getCaseItems(caseRef) {
  const [data, helpTextMap] = await Promise.all([
    mondayApi.query(
      `query($boardId: ID!, $caseRef: String!) {
         items_page_by_column_values(
           limit: 500,
           board_id: $boardId,
           columns: [{ column_id: "${CASE_REF_COL}", column_values: [$caseRef] }]
         ) {
           items {
             id
             name
             column_values(ids: ${JSON.stringify(FETCH_COLS)}) { id text value }
           }
         }
       }`,
      { boardId: BOARD_ID, caseRef }
    ),
    getTemplateHelpTextByName(),
  ]);

  const items = data?.items_page_by_column_values?.items || [];
  if (!items.length) return [];

  return items
    .map((item) => {
      const col    = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
      const rawVal = item.column_values.find((c) => c.id === CLIENT_RESP_COL)?.value || '';

      let currentAnswer = '';
      if (rawVal) {
        try { currentAnswer = JSON.parse(rawVal)?.text || ''; } catch { currentAnswer = col(CLIENT_RESP_COL); }
      }

      return {
        id:           item.id,
        name:         item.name,
        category:     col('lookup_mm13fva6') || 'General',
        inputType:    col('lookup_mm13nnd0') || 'Short Text',
        required:     col('lookup_mm1333gw') || 'Mandatory',
        questionCode: col('lookup_mm12m2ej') || '',
        currentAnswer,
        helpText:     helpTextMap[item.name.trim()] || '',
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
