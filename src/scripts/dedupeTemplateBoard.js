/**
 * Deduplicate the Document Checklist Template Board.
 *
 * For each group: keep the FIRST item for each unique document name,
 * delete all subsequent duplicates.
 *
 * Run: node src/scripts/dedupeTemplateBoard.js
 * Dry-run: node src/scripts/dedupeTemplateBoard.js --dry-run
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID = process.env.MONDAY_TEMPLATE_BOARD_ID || '18401624183';
const DRY_RUN  = process.argv.includes('--dry-run');
const DELAY_MS = 700; // between deletes to avoid rate limits

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, retries = 4, base = 2000) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (err) {
      const status = err?.response?.status || err?.status;
      if ((!status || status === 429 || status === 502 || status === 503) && i < retries) {
        const delay = base * Math.pow(2, i);
        console.warn(`  ⚠ Retrying (${status || err.message}) in ${delay}ms…`);
        await sleep(delay);
      } else throw err;
    }
  }
}

async function fetchGroupItems(groupId) {
  let items = [], cursor = null;
  do {
    const data = await withRetry(() => mondayApi.query(
      cursor
        ? `query($c:String!){boards(ids:["${BOARD_ID}"]){groups(ids:["${groupId}"]){items_page(limit:200,cursor:$c){cursor items{id name}}}}}`
        : `{boards(ids:["${BOARD_ID}"]){groups(ids:["${groupId}"]){items_page(limit:200){cursor items{id name}}}}}`,
      cursor ? { c: cursor } : undefined
    ));
    const page = data.boards[0].groups[0].items_page;
    items.push(...page.items);
    cursor = page.cursor || null;
  } while (cursor);
  return items;
}

async function deleteItem(itemId) {
  return withRetry(() => mondayApi.query(
    `mutation($id:ID!){ delete_item(item_id:$id){ id } }`,
    { id: String(itemId) }
  ));
}

async function run() {
  console.log(DRY_RUN ? '🔍 DRY RUN — no changes will be made\n' : '🗑  LIVE RUN — duplicates will be deleted\n');

  const groupData = await mondayApi.query(
    `{ boards(ids: ["${BOARD_ID}"]) { groups { id title } } }`
  );
  const groups = groupData.boards[0].groups;
  console.log(`Found ${groups.length} groups\n`);

  let totalDeleted = 0;

  for (const group of groups) {
    const items    = await fetchGroupItems(group.id);
    const seen     = new Map();   // name → first item id
    const toDelete = [];

    for (const item of items) {
      const key = item.name.trim().toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, item.id);
      } else {
        toDelete.push(item.id);
      }
    }

    if (!toDelete.length) {
      console.log(`✓ ${group.title}: ${items.length} items, no duplicates`);
      continue;
    }

    console.log(`→ ${group.title}: ${items.length} items | ${seen.size} unique | deleting ${toDelete.length} duplicates`);

    if (!DRY_RUN) {
      for (const id of toDelete) {
        await deleteItem(id);
        await sleep(DELAY_MS);
      }
      totalDeleted += toDelete.length;
      console.log(`  ✓ deleted ${toDelete.length}`);
    }
  }

  console.log(`\n${DRY_RUN ? 'Would delete' : 'Deleted'} ${totalDeleted} duplicate items total.`);
}

run().catch(console.error);
