const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const CASE_STAGE_COLUMN_TITLE = 'Case Stage';
const DOCUMENT_COLLECTION_STARTED = 'Document Collection Started';

/**
 * Fetch board columns as a map of { [columnId]: columnTitle }.
 */
async function getBoardColumnMap(boardId) {
  const data = await mondayApi.query(
    `query getBoardColumns($boardIds: [ID!]!) {
      boards(ids: $boardIds) {
        columns { id title }
      }
    }`,
    { boardIds: [String(boardId)] }
  );

  const columns = data?.boards?.[0]?.columns;
  if (!columns?.length) {
    throw new Error(`Board ${boardId} not found or has no columns`);
  }

  const map = {};
  for (const col of columns) {
    map[col.id] = col.title;
  }
  return map;
}

/**
 * Fetch all items on Client Master board where Case Stage = "Document Collection Started".
 * Returns each item with a clean named `fields` object instead of a raw column_values array.
 * @returns {Promise<Array>}
 */
async function getDocumentCollectionStartedItems() {
  const boardId = clientMasterBoardId;
  if (!boardId) {
    throw new Error('Client Master Board ID is not configured (MONDAY_CLIENT_MASTER_BOARD_ID)');
  }

  // Fetch column map and Case Stage column id in parallel
  const columnMap = await getBoardColumnMap(boardId);

  const caseStageEntry = Object.entries(columnMap).find(
    ([, title]) => title.trim().toLowerCase() === CASE_STAGE_COLUMN_TITLE.toLowerCase()
  );
  if (!caseStageEntry) {
    throw new Error(`Column "${CASE_STAGE_COLUMN_TITLE}" not found on Client Master board`);
  }
  const caseStageColumnId = caseStageEntry[0];

  const data = await mondayApi.query(
    `query getItemsByCaseStage($boardId: ID!, $columnId: String!, $columnValue: String!) {
      items_page_by_column_values(
        limit: 500,
        board_id: $boardId,
        columns: [{ column_id: $columnId, column_values: [$columnValue] }]
      ) {
        cursor
        items {
          id
          name
          column_values {
            id
            text
          }
        }
      }
    }`,
    {
      boardId: String(boardId),
      columnId: caseStageColumnId,
      columnValue: DOCUMENT_COLLECTION_STARTED,
    }
  );

  const rawItems = data?.items_page_by_column_values?.items ?? [];

  // Shape each item into a clean object
  return rawItems.map((item) => {
    const fields = {};
    for (const col of item.column_values) {
      const title = columnMap[col.id];
      if (title && col.text) {
        fields[title] = col.text;
      }
    }
    return {
      id: item.id,
      name: item.name,
      fields,
    };
  });
}

module.exports = {
  getBoardColumnMap,
  getDocumentCollectionStartedItems,
};
