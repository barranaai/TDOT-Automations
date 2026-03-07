const mondayApi = require('./mondayApi');

/**
 * Fetch full board structure: groups and columns.
 * @param {string|number} boardId
 * @returns {{ groups: Array, columns: Array }}
 */
async function getBoardStructure(boardId) {
  const data = await mondayApi.query(
    `query getBoardStructure($boardIds: [ID!]!) {
      boards(ids: $boardIds) {
        id
        name
        groups {
          id
          title
        }
        columns {
          id
          title
          type
        }
      }
    }`,
    { boardIds: [String(boardId)] }
  );

  const board = data?.boards?.[0];
  if (!board) throw new Error(`Board ${boardId} not found`);
  return board;
}

module.exports = { getBoardStructure };
