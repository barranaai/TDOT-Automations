/**
 * backfillBoardRelation.js
 *
 * Re-links all Document Checklist Execution Board items to the correct ACTIVE
 * template board items.  Because the template board was rebuilt and de-duplicated
 * after the execution items were created, the stored intakeItemIds point to deleted
 * items that can no longer be used in a board_relation.
 *
 * Strategy:
 *   1. Build a lookup map:  documentCode → active template item ID
 *   2. For each execution item that still has a broken (empty) board_relation:
 *      a. Find the matching active template item by documentCode
 *      b. Update intakeItemId (text_mm0zfsp1) to the new template item ID
 *      c. Set board_relation_mm0zhagw to that template item
 *
 * This also repairs the mirror columns (Document Category, Required Type,
 * Blocking Document, Document Source) which all depend on this relation.
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const EXEC_BOARD         = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const TEMPLATE_BOARD     = process.env.MONDAY_TEMPLATE_BOARD_ID  || '18401624183';

// Execution board columns
const EXEC_CASE_REF_COL  = 'text_mm0z2cck';
const EXEC_DOC_CODE_COL  = 'text_mm0zr7tf';
const EXEC_INTAKE_ID_COL = 'text_mm0zfsp1';
const EXEC_TEMPLATE_REL  = 'board_relation_mm0zhagw';

// Template board columns
const TMPL_DOC_CODE_COL  = 'text_mm0xprz5';

const DELAY_MS = 350; // ms between write calls to stay within rate limits

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  // ── 1. Load all active template items keyed by Document Code ────────────────
  console.log('[Backfill] Loading active template items…');

  let cursor   = null;
  const codeToTemplateId = {};  // documentCode → templateItemId
  let tmplTotal = 0;

  do {
    let data;
    if (cursor) {
      data = await mondayApi.query(
        `query($cursor: String!) {
           boards(ids: ["${TEMPLATE_BOARD}"]) {
             items_page(limit: 500, cursor: $cursor) {
               cursor
               items {
                 id
                 column_values(ids: ["${TMPL_DOC_CODE_COL}"]) { id text }
               }
             }
           }
         }`, { cursor }
      );
    } else {
      data = await mondayApi.query(
        `{
           boards(ids: ["${TEMPLATE_BOARD}"]) {
             items_page(limit: 500) {
               cursor
               items {
                 id
                 column_values(ids: ["${TMPL_DOC_CODE_COL}"]) { id text }
               }
             }
           }
         }`
      );
    }
    const page = data.boards[0].items_page;
    for (const item of page.items) {
      const code = item.column_values[0]?.text?.trim() || '';
      if (code) {
        codeToTemplateId[code] = item.id;
        tmplTotal++;
      }
    }
    cursor = page.cursor || null;
  } while (cursor);

  console.log(`  → Loaded ${tmplTotal} active template items (${Object.keys(codeToTemplateId).length} unique document codes)\n`);

  // ── 2. Load all execution items ──────────────────────────────────────────────
  console.log('[Backfill] Loading execution items…');

  cursor = null;
  const execItems = [];

  do {
    let data;
    if (cursor) {
      data = await mondayApi.query(
        `query($cursor: String!) {
           boards(ids: ["${EXEC_BOARD}"]) {
             items_page(limit: 500, cursor: $cursor) {
               cursor
               items {
                 id
                 column_values(ids: [
                   "${EXEC_CASE_REF_COL}",
                   "${EXEC_DOC_CODE_COL}",
                   "${EXEC_INTAKE_ID_COL}",
                   "${EXEC_TEMPLATE_REL}"
                 ]) { id text value }
               }
             }
           }
         }`, { cursor }
      );
    } else {
      data = await mondayApi.query(
        `{
           boards(ids: ["${EXEC_BOARD}"]) {
             items_page(limit: 500) {
               cursor
               items {
                 id
                 column_values(ids: [
                   "${EXEC_CASE_REF_COL}",
                   "${EXEC_DOC_CODE_COL}",
                   "${EXEC_INTAKE_ID_COL}",
                   "${EXEC_TEMPLATE_REL}"
                 ]) { id text value }
               }
             }
           }
         }`
      );
    }
    const page = data.boards[0].items_page;
    execItems.push(...page.items);
    cursor = page.cursor || null;
  } while (cursor);

  console.log(`  → Loaded ${execItems.length} execution items\n`);

  // ── 3. Identify items needing repair ────────────────────────────────────────
  const toFix = execItems.filter((item) => {
    const relVal = item.column_values.find((c) => c.id === EXEC_TEMPLATE_REL)?.value || '';
    return !relVal || relVal === 'null';
  });

  console.log(`Items needing board_relation repair: ${toFix.length}\n`);
  if (!toFix.length) {
    console.log('[Backfill] Nothing to do — all items already have board_relation set.');
    return;
  }

  // ── 4. Re-link each item to its active template counterpart ─────────────────
  let patched  = 0;
  let noMatch  = 0;
  let failed   = 0;

  for (const item of toFix) {
    const caseRef = item.column_values.find((c) => c.id === EXEC_CASE_REF_COL)?.text?.trim() || '';
    const docCode = item.column_values.find((c) => c.id === EXEC_DOC_CODE_COL)?.text?.trim() || '';

    if (!docCode) {
      console.warn(`  ⚠ [${caseRef}] exec:${item.id} — no document code, skipping`);
      noMatch++;
      continue;
    }

    const activeTemplateId = codeToTemplateId[docCode];
    if (!activeTemplateId) {
      console.warn(`  ⚠ [${caseRef}] exec:${item.id} — no active template item for code "${docCode}"`);
      noMatch++;
      continue;
    }

    try {
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
           change_multiple_column_values(
             board_id:      $boardId,
             item_id:       $itemId,
             column_values: $colValues
           ) { id }
         }`,
        {
          boardId:   String(EXEC_BOARD),
          itemId:    String(item.id),
          colValues: JSON.stringify({
            [EXEC_TEMPLATE_REL]:  { item_ids: [Number(activeTemplateId)] },
            [EXEC_INTAKE_ID_COL]: activeTemplateId,   // keep text field in sync
          }),
        }
      );
      patched++;
      process.stdout.write(`  ✓ [${caseRef}] exec:${item.id} code:"${docCode}" → template:${activeTemplateId}\n`);
    } catch (err) {
      failed++;
      console.error(`  ✗ [${caseRef}] exec:${item.id} code:"${docCode}" → FAILED: ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n[Backfill] Done — patched: ${patched}, no match found: ${noMatch}, failed: ${failed}`);
}

run().catch((err) => {
  console.error('[Backfill] Fatal error:', err.message);
  process.exit(1);
});
