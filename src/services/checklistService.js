const mondayApi = require('./mondayApi');

/**
 * Triggered automatically when an item's Case Stage changes to
 * "Document Collection Started" on the Client Master board.
 *
 * @param {{ itemId: string|number, boardId: string|number }} param
 */
async function onDocumentCollectionStarted({ itemId, boardId }) {
  console.log(`[ChecklistService] Running automation for item ${itemId} on board ${boardId}`);

  // Fetch the item details
  const data = await mondayApi.query(
    `query getItem($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        name
        column_values { id text }
      }
    }`,
    { itemId: String(itemId) }
  );

  const item = data?.items?.[0];
  if (!item) {
    console.warn(`[ChecklistService] Item ${itemId} not found`);
    return;
  }

  console.log(`[ChecklistService] Processing: "${item.name}" (id: ${item.id})`);

  // TODO: add your automation logic here, e.g.
  //   - send a notification / email
  //   - create sub-items or a checklist
  //   - update another column
  //   - post to Slack
}

module.exports = { onDocumentCollectionStarted };
