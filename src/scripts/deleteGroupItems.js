/**
 * Utility: delete all items from specified groups on a board.
 * Usage: node src/scripts/deleteGroupItems.js
 */
require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID = '18402113809';

// Groups to clear
const GROUPS_TO_CLEAR = [
  { groupId: 'group_mm12ep73', name: 'Inland Spousal Sponsorship'  },
  { groupId: 'group_mm12pgz2', name: 'Outland Spousal Sponsorship' },
];

async function getGroupItems(groupId) {
  const data = await mondayApi.query(
    `query getItems($boardId: ID!, $groupId: String!) {
      boards(ids: [$boardId]) {
        groups(ids: [$groupId]) {
          items_page(limit: 500) {
            items { id name }
          }
        }
      }
    }`,
    { boardId: BOARD_ID, groupId }
  );
  return data?.boards?.[0]?.groups?.[0]?.items_page?.items ?? [];
}

async function deleteItem(itemId) {
  await mondayApi.query(
    `mutation deleteItem($itemId: ID!) {
      delete_item(item_id: $itemId) { id }
    }`,
    { itemId }
  );
}

async function main() {
  let totalDeleted = 0;

  for (const group of GROUPS_TO_CLEAR) {
    console.log(`\nFetching items from "${group.name}"…`);
    const items = await getGroupItems(group.groupId);
    console.log(`  Found ${items.length} items — deleting…`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        await deleteItem(item.id);
        console.log(`  [${i + 1}/${items.length}] ✓ Deleted: ${item.name}`);
        totalDeleted++;
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        console.error(`  [${i + 1}/${items.length}] ✗ Failed: ${item.name} — ${err.message}`);
      }
    }
    console.log(`  → Cleared ${items.length} items from "${group.name}"`);
  }

  console.log(`\nDone — ${totalDeleted} items deleted total.`);
}

main().catch(console.error);
