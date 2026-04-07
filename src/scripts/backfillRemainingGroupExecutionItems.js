/**
 * backfillRemainingGroupExecutionItems.js
 *
 * Backfills missing Execution Board items (Spouse / Dependent Child) for all
 * existing Client Master cases in the 9 newly-fixed case types:
 *   - Visitor Record / Extension
 *   - Supervisa
 *   - TRV
 *   - Co-op WP
 *   - SCLPC WP
 *   - AAIP
 *   - BCPNP
 *   - NSNP
 *   - OINP
 *
 * Safe to re-run — duplicate prevention via Unique Key column.
 *
 * Run with: node src/scripts/backfillRemainingGroupExecutionItems.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');
const { getTemplateItemsByCaseType } = require('../services/templateService');
const { createMissingExecutionItems } = require('../services/executionService');

const CLIENT_MASTER_BOARD_ID = process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401510522';

const CM_COLS = {
  caseReferenceNumber: 'text_mm142s49',
  primaryCaseType:     'dropdown_mm0xd1qn',
  caseSubType:         'dropdown_mm0x4t91',
};

// Case types to backfill
const TARGET_CASE_TYPES = new Set([
  'Visitor Record / Extension',
  'Supervisa',
  'TRV',
  'Co-op WP',
  'SCLPC WP',
  'AAIP',
  'BCPNP',
  'NSNP',
  'OINP',
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Fetch all matching cases from Client Master ───────────────────────────────

async function fetchTargetCases() {
  const cases = [];
  let cursor = null;

  do {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const data = await mondayApi.query(`
      query {
        boards(ids: [${CLIENT_MASTER_BOARD_ID}]) {
          items_page(limit: 500${cursorArg}) {
            cursor
            items {
              id
              name
              column_values(ids: [
                "${CM_COLS.caseReferenceNumber}",
                "${CM_COLS.primaryCaseType}",
                "${CM_COLS.caseSubType}"
              ]) { id text }
            }
          }
        }
      }
    `);

    const page = data?.boards?.[0]?.items_page;
    if (!page) break;

    for (const item of (page.items || [])) {
      const colMap = {};
      for (const col of item.column_values) colMap[col.id] = col.text?.trim() || '';

      const caseType = colMap[CM_COLS.primaryCaseType];
      if (!TARGET_CASE_TYPES.has(caseType)) continue;

      cases.push({
        id:          item.id,
        name:        item.name,
        caseRef:     colMap[CM_COLS.caseReferenceNumber],
        caseType,
        caseSubType: colMap[CM_COLS.caseSubType] || null,
      });
    }

    cursor = page.cursor || null;
  } while (cursor);

  return cases;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('▶  Backfilling missing Execution items for 9 newly-fixed case types\n');

  const cases = await fetchTargetCases();
  console.log(`Found ${cases.length} case(s) across target case types\n`);

  if (!cases.length) {
    console.log('Nothing to do.');
    return;
  }

  // Group by case type for clean output
  const byCaseType = {};
  for (const c of cases) {
    if (!byCaseType[c.caseType]) byCaseType[c.caseType] = [];
    byCaseType[c.caseType].push(c);
  }

  let totalCreated = 0;
  let totalSkipped = 0;

  for (const [caseType, typeCases] of Object.entries(byCaseType)) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`▶  ${caseType} (${typeCases.length} case(s))`);

    for (const c of typeCases) {
      console.log(`\n── "${c.name}" | Ref: ${c.caseRef} | SubType: ${c.caseSubType || '(none)'}`);

      if (!c.caseRef) {
        console.warn('   ⚠️  No Case Reference Number — skipping');
        continue;
      }

      let templateItems;
      try {
        templateItems = await getTemplateItemsByCaseType(c.caseType, c.caseSubType);
        console.log(`   Template items: ${templateItems.length}`);
      } catch (err) {
        console.error(`   ❌ Template lookup failed: ${err.message}`);
        continue;
      }

      if (!templateItems.length) {
        console.warn('   ⚠️  No template items found — skipping');
        continue;
      }

      const { created, skipped } = await createMissingExecutionItems({
        caseRef:            c.caseRef,
        clientMasterItemId: c.id,
        templateItems,
        categoryLinks:      {},
      });

      totalCreated += created;
      totalSkipped += skipped;
      console.log(`   ✅ Created: ${created}  |  Skipped (already existed): ${skipped}`);

      await sleep(300);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Done — total created: ${totalCreated}, total skipped: ${totalSkipped}`);
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
