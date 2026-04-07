/**
 * backfillExecutionColumns.js
 *
 * Backfills two new direct-text columns on the Execution Board for all existing items:
 *   - Applicant Type   (text_mm26jcv7)
 *   - Document Category (text_mm261tka)
 *
 * Strategy:
 *   1. Fetch all execution items that have an intakeId stored (text_mm0zfsp1).
 *   2. Batch-fetch the Template Board items by those intakeIds.
 *   3. For each execution item, write the two column values in a single mutation.
 *
 * Run with: node src/scripts/backfillExecutionColumns.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const EXEC_BOARD_ID   = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const TMPL_BOARD_ID   = process.env.MONDAY_TEMPLATE_BOARD_ID  || '18401624183';

// Execution Board columns
const INTAKE_ID_COL    = 'text_mm0zfsp1';
const APPLICANT_TYPE_COL = 'text_mm26jcv7';
const DOC_CATEGORY_COL   = 'text_mm261tka';

// Template Board columns
const TMPL_CATEGORY_COL    = 'dropdown_mm0x41zm';
const TMPL_APPLICANT_TYPE_COL = 'dropdown_mm261bn6';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fetch all execution items (paginated) ────────────────────────────────────

async function fetchAllExecutionItems() {
  const items = [];
  let cursor = null;

  do {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const data = await mondayApi.query(
      `query {
         boards(ids: [${EXEC_BOARD_ID}]) {
           items_page(limit: 500${cursorArg}) {
             cursor
             items {
               id
               name
               column_values(ids: ["${INTAKE_ID_COL}", "${APPLICANT_TYPE_COL}", "${DOC_CATEGORY_COL}"]) {
                 id text
               }
             }
           }
         }
       }`
    );
    const page = data?.boards?.[0]?.items_page;
    if (!page) break;
    items.push(...(page.items || []));
    cursor = page.cursor || null;
    if (cursor) await sleep(300);
  } while (cursor);

  return items;
}

// ─── Batch-fetch template items by IDs ────────────────────────────────────────

async function fetchTemplateItems(intakeIds) {
  if (!intakeIds.length) return {};

  // Monday.com items() query supports up to 100 IDs at a time
  const CHUNK = 100;
  const map   = {};

  for (let i = 0; i < intakeIds.length; i += CHUNK) {
    const chunk = intakeIds.slice(i, i + CHUNK);
    const data  = await mondayApi.query(
      `query($ids: [ID!]!) {
         items(ids: $ids) {
           id
           column_values(ids: ["${TMPL_CATEGORY_COL}", "${TMPL_APPLICANT_TYPE_COL}"]) {
             id text
           }
         }
       }`,
      { ids: chunk }
    );
    for (const tmpl of data?.items || []) {
      const cat  = tmpl.column_values.find((c) => c.id === TMPL_CATEGORY_COL)?.text?.trim()       || '';
      const appt = tmpl.column_values.find((c) => c.id === TMPL_APPLICANT_TYPE_COL)?.text?.trim() || '';
      map[tmpl.id] = { category: cat, applicantType: appt };
    }
    if (i + CHUNK < intakeIds.length) await sleep(300);
  }

  return map;
}

// ─── Update a single execution item (with retry) ─────────────────────────────

async function updateItem(itemId, category, applicantType) {
  const colValues = {};
  if (category)      colValues[DOC_CATEGORY_COL]   = category;
  if (applicantType) colValues[APPLICANT_TYPE_COL]  = applicantType;
  if (!Object.keys(colValues).length) return;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await mondayApi.query(
        `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
           change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
         }`,
        {
          boardId:   String(EXEC_BOARD_ID),
          itemId:    String(itemId),
          colValues: JSON.stringify(colValues),
        }
      );
      await sleep(220);
      return;
    } catch (err) {
      if (attempt < 3) {
        console.warn(`  ↻ Retry ${attempt}/3 for item ${itemId}: ${err.message}`);
        await sleep(1500 * attempt);
      } else {
        throw err;
      }
    }
  }
}

// ─── Fetch ALL template items (for name-based fallback) ───────────────────────

async function fetchAllTemplateItems() {
  // Fetch all items from the template board grouped by name → pick first match
  // (same name can appear in multiple groups with the same category/applicantType)
  const nameMap = {};
  let cursor = null;

  do {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const data = await mondayApi.query(
      `query {
         boards(ids: [${TMPL_BOARD_ID}]) {
           items_page(limit: 500${cursorArg}) {
             cursor
             items {
               id name
               column_values(ids: ["${TMPL_CATEGORY_COL}", "${TMPL_APPLICANT_TYPE_COL}"]) {
                 id text
               }
             }
           }
         }
       }`
    );
    const page = data?.boards?.[0]?.items_page;
    if (!page) break;

    for (const tmpl of page.items || []) {
      const cat  = tmpl.column_values.find((c) => c.id === TMPL_CATEGORY_COL)?.text?.trim()       || '';
      const appt = tmpl.column_values.find((c) => c.id === TMPL_APPLICANT_TYPE_COL)?.text?.trim() || '';
      const key  = tmpl.name.trim().toLowerCase();
      // Store first occurrence per name (Principal Applicant preferred over others)
      if (!nameMap[key] || appt === 'Principal Applicant') {
        nameMap[key] = { category: cat, applicantType: appt || 'Principal Applicant' };
      }
    }

    cursor = page.cursor || null;
    if (cursor) await sleep(300);
  } while (cursor);

  return nameMap;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching all execution items…');
  const execItems = await fetchAllExecutionItems();
  console.log(`  Found ${execItems.length} execution items`);

  // Split into buckets
  const needsBackfill = execItems.filter((item) => {
    const catDone  = item.column_values.find((c) => c.id === DOC_CATEGORY_COL)?.text?.trim();
    const aptDone  = item.column_values.find((c) => c.id === APPLICANT_TYPE_COL)?.text?.trim();
    return !catDone || !aptDone;
  });

  const alreadyDone = execItems.length - needsBackfill.length;
  console.log(`  Needs backfill:  ${needsBackfill.length}`);
  console.log(`  Already filled:  ${alreadyDone}`);

  if (!needsBackfill.length) {
    console.log('\n✅ Nothing to backfill — all items already have values.');
    return;
  }

  // ── Pass 1: intakeId-based lookup ───────────────────────────────────────────
  const intakeIds = [
    ...new Set(
      needsBackfill
        .map((item) => item.column_values.find((c) => c.id === INTAKE_ID_COL)?.text?.trim())
        .filter(Boolean)
    ),
  ];
  console.log(`\nPass 1 — fetching ${intakeIds.length} template items by intakeId…`);
  const intakeMap = await fetchTemplateItems(intakeIds);
  console.log(`  Resolved ${Object.keys(intakeMap).length} via intakeId`);

  // ── Pass 2: name-based fallback for unresolved items ────────────────────────
  const unresolved = needsBackfill.filter((item) => {
    const intakeId = item.column_values.find((c) => c.id === INTAKE_ID_COL)?.text?.trim();
    return !intakeId || !intakeMap[intakeId];
  });

  let nameMap = {};
  if (unresolved.length) {
    console.log(`\nPass 2 — ${unresolved.length} items unresolved; building name-based lookup…`);
    nameMap = await fetchAllTemplateItems();
    console.log(`  Template name map: ${Object.keys(nameMap).length} unique names`);
  }

  // ── Apply updates ────────────────────────────────────────────────────────────
  console.log('\nApplying updates…');
  let updated      = 0;
  let skipped      = 0;
  let noMatch      = 0;

  for (const item of needsBackfill) {
    const intakeId    = item.column_values.find((c) => c.id === INTAKE_ID_COL)?.text?.trim() || '';
    const existingCat = item.column_values.find((c) => c.id === DOC_CATEGORY_COL)?.text?.trim()   || '';
    const existingApt = item.column_values.find((c) => c.id === APPLICANT_TYPE_COL)?.text?.trim() || '';

    // Try intakeId first, then name-based fallback using the item's own name
    let tmpl = intakeId ? intakeMap[intakeId] : null;
    if (!tmpl) {
      const execName = (item.name || '').trim().toLowerCase();
      tmpl = execName ? nameMap[execName] : null;
    }

    if (!tmpl) {
      noMatch++;
      continue;
    }

    const newCat  = tmpl.category     || existingCat;
    const newAppt = tmpl.applicantType || existingApt || 'Principal Applicant';

    if (newCat === existingCat && newAppt === existingApt) {
      skipped++;
      continue;
    }

    await updateItem(item.id, newCat, newAppt);
    updated++;

    if (updated % 50 === 0) console.log(`  … ${updated} updated so far`);
  }

  console.log(`\n${'═'.repeat(55)}`);
  console.log(`✅ Done`);
  console.log(`   Updated:         ${updated}`);
  console.log(`   Already correct: ${skipped}`);
  console.log(`   No match found:  ${noMatch}`);
}

main().catch((err) => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
