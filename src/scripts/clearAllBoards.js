/**
 * clearAllBoards.js
 * Deletes ALL items from the 5 specified boards to prepare for clean testing.
 *
 * Boards cleared:
 *   1. Client Master Board
 *   2. Document Checklist Execution Board
 *   3. Questionnaire Execution Board
 *   4. Questionnaire Intake Board
 *   5. Document Intake Board
 *
 * Usage: node src/scripts/clearAllBoards.js
 */
require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARDS = [
  { name: 'Client Master Board',                id: process.env.MONDAY_CLIENT_MASTER_BOARD_ID           || '18401523447' },
  { name: 'Document Checklist Execution Board', id: process.env.MONDAY_EXECUTION_BOARD_ID               || '18401875593' },
  { name: 'Questionnaire Execution Board',      id: process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488' },
  { name: 'Questionnaire Intake Board',         id: '18402386590' },
  { name: 'Document Intake Board',              id: '18402395334' },
];

const PAGE_LIMIT = 100; // items per page

async function getPageOfItems(boardId, cursor) {
  if (cursor) {
    const data = await mondayApi.query(
      `query($cursor: String!) {
         next_items_page(limit: ${PAGE_LIMIT}, cursor: $cursor) {
           cursor
           items { id name }
         }
       }`,
      { cursor }
    );
    return data?.next_items_page ?? { cursor: null, items: [] };
  }

  const data = await mondayApi.query(
    `query($boardId: ID!) {
       boards(ids: [$boardId]) {
         items_page(limit: ${PAGE_LIMIT}) {
           cursor
           items { id name }
         }
       }
     }`,
    { boardId: String(boardId) }
  );
  return data?.boards?.[0]?.items_page ?? { cursor: null, items: [] };
}

async function getAllItems(boardId) {
  const allItems = [];
  let cursor = null;

  do {
    const page = await getPageOfItems(boardId, cursor);
    allItems.push(...(page.items ?? []));
    cursor = page.cursor ?? null;
  } while (cursor);

  return allItems;
}

async function deleteItem(itemId) {
  await mondayApi.query(
    `mutation($itemId: ID!) { delete_item(item_id: $itemId) { id } }`,
    { itemId: String(itemId) }
  );
}

async function clearBoard({ name, id: boardId }) {
  if (!boardId) {
    console.warn(`  ⚠  ${name} — board ID not available, skipping.`);
    return 0;
  }

  console.log(`\n━━━ ${name} (board ${boardId}) ━━━`);
  const items = await getAllItems(boardId);

  if (items.length === 0) {
    console.log('  Already empty — nothing to delete.');
    return 0;
  }

  console.log(`  Found ${items.length} item(s) — deleting…`);
  let deleted = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      await deleteItem(item.id);
      console.log(`  [${i + 1}/${items.length}] ✓  ${item.name}`);
      deleted++;
      // 250 ms between requests to respect Monday rate limits
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      console.error(`  [${i + 1}/${items.length}] ✗  ${item.name} — ${err.message}`);
    }
  }

  console.log(`  → Deleted ${deleted}/${items.length} items from "${name}"`);
  return deleted;
}

async function main() {
  console.log('=== TDOT Board Cleanup ===');
  console.log('Clearing all test data from 5 boards…\n');

  let grand = 0;
  for (const board of BOARDS) {
    grand += await clearBoard(board);
  }

  console.log(`\n✅  Done — ${grand} items deleted across all boards.`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
