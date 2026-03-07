const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const CASE_STAGE_COLUMN_TITLE = 'Case Stage';
const DOCUMENT_COLLECTION_STARTED = 'Document Collection Started';

/**
 * Get the column id for "Case Stage" on the Client Master board.
 * @param {string|number} boardId - Board ID (defaults to config clientMasterBoardId)
 * @returns {Promise<string|null>} Column id or null if not found
 */
async function getCaseStageColumnId(boardId = clientMasterBoardId) {
  if (!boardId) {
    throw new Error('Client Master Board ID is not configured (MONDAY_CLIENT_MASTER_BOARD_ID)');
  }

  const data = await mondayApi.query(
    `query getBoardColumns($boardIds: [Int!]!) {
      boards(ids: $boardIds) {
        columns { id title }
      }
    }`,
    { boardIds: [Number(boardId)] }
  );

  const columns = data?.boards?.[0]?.columns;
  if (!columns?.length) {
    throw new Error(`Board ${boardId} not found or has no columns`);
  }

  const caseStageColumn = columns.find(
    (col) => col.title && col.title.trim().toLowerCase() === CASE_STAGE_COLUMN_TITLE.toLowerCase()
  );
  return caseStageColumn ? caseStageColumn.id : null;
}

/**
 * Fetch all items on Client Master board where Case Stage = "Document Collection Started".
 * @returns {Promise<Array>} List of items with id, name, and column_values
 */
async function getDocumentCollectionStartedItems() {
  const boardId = clientMasterBoardId;
  if (!boardId) {
    throw new Error('Client Master Board ID is not configured (MONDAY_CLIENT_MASTER_BOARD_ID)');
  }

  const columnId = await getCaseStageColumnId(boardId);
  if (!columnId) {
    throw new Error(`Column "${CASE_STAGE_COLUMN_TITLE}" not found on Client Master board`);
  }

  const data = await mondayApi.query(
    `query getItemsByCaseStage($boardId: Int!, $columnId: String!, $columnValue: String!) {
      items_by_column_values(
        board_id: $boardId,
        column_id: $columnId,
        column_value: $columnValue
      ) {
        id
        name
        column_values {
          id
          title
          text
          type
        }
      }
    }`,
    {
      boardId: Number(boardId),
      columnId,
      columnValue: DOCUMENT_COLLECTION_STARTED,
    }
  );

  const items = data?.items_by_column_values ?? [];
  return items;
}

module.exports = {
  getCaseStageColumnId,
  getDocumentCollectionStartedItems,
};
