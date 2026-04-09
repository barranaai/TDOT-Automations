/**
 * fixDuplicatePassportTemplateItems.js
 *
 * ROOT CAUSE FIX — duplicate "Passport with all stamped pages." items in template board.
 *
 * The template board contains 21 pairs where:
 *   "Passport with all stamped pages"   (correct)
 *   "Passport with all stamped pages."  (duplicate — trailing period)
 * …exist in the same group + sub-type + applicant-type combination.
 *
 * Because the two items have different Document Codes, createMissingExecutionItems
 * treats them as distinct documents and creates execution items for both, causing
 * duplicate rows in the client-facing document upload form.
 *
 * Fix: delete all 21 trailing-period variants.
 *
 * Affected groups: Visitor Visa (13), Visitor Record / Extension (6), Supervisa (2)
 *
 * Run with: node src/scripts/fixDuplicatePassportTemplateItems.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID = '18401624183';

// IDs confirmed by audit — all are "Passport with all stamped pages." (with trailing period)
// paired against a "Passport with all stamped pages" (no period) in the same group/sub/appType
const ITEMS_TO_DELETE = [
  // Visitor Visa — Principal Applicant
  { id: '11662043997', group: 'Visitor Visa', sub: 'Both Parents',                   app: 'Principal Applicant' },
  { id: '11662048002', group: 'Visitor Visa', sub: 'Single Parent',                  app: 'Principal Applicant' },
  { id: '11662044494', group: 'Visitor Visa', sub: '1-3 Members',                    app: 'Principal Applicant' },
  { id: '11662052149', group: 'Visitor Visa', sub: '1-2 Members',                    app: 'Principal Applicant' },
  { id: '11662066298', group: 'Visitor Visa', sub: 'Parents & Siblings',             app: 'Principal Applicant' },
  { id: '11662055776', group: 'Visitor Visa', sub: 'Spouse',                         app: 'Principal Applicant' },
  { id: '11662083022', group: 'Visitor Visa', sub: 'Spousal Sponsorship in Process', app: 'Principal Applicant' },
  // Visitor Visa — Spouse / Common-Law Partner
  { id: '11688693538', group: 'Visitor Visa', sub: 'Spouse',                         app: 'Spouse / Common-Law Partner' },
  { id: '11688707231', group: 'Visitor Visa', sub: '1-2 Members',                    app: 'Spouse / Common-Law Partner' },
  { id: '11688749839', group: 'Visitor Visa', sub: '1-3 Members',                    app: 'Spouse / Common-Law Partner' },
  { id: '11688703827', group: 'Visitor Visa', sub: 'Both Parents',                   app: 'Spouse / Common-Law Partner' },
  { id: '11688750381', group: 'Visitor Visa', sub: 'Parents & Siblings',             app: 'Spouse / Common-Law Partner' },
  { id: '11688718706', group: 'Visitor Visa', sub: 'Spousal Sponsorship in Process', app: 'Spouse / Common-Law Partner' },
  // Visitor Record / Extension — Principal Applicant
  { id: '11662033572', group: 'Visitor Record / Extension', sub: 'Visitor Record + Restoration', app: 'Principal Applicant' },
  { id: '11662034189', group: 'Visitor Record / Extension', sub: 'Visitor Extension',            app: 'Principal Applicant' },
  { id: '11662034524', group: 'Visitor Record / Extension', sub: 'Visitor Record',               app: 'Principal Applicant' },
  // Visitor Record / Extension — Spouse / Common-Law Partner
  { id: '11689009487', group: 'Visitor Record / Extension', sub: 'Visitor Extension',            app: 'Spouse / Common-Law Partner' },
  { id: '11688999540', group: 'Visitor Record / Extension', sub: 'Visitor Record',               app: 'Spouse / Common-Law Partner' },
  { id: '11689002772', group: 'Visitor Record / Extension', sub: 'Visitor Record + Restoration', app: 'Spouse / Common-Law Partner' },
  // Supervisa — Parents
  { id: '11650148050', group: 'Supervisa', sub: 'Parents', app: 'Principal Applicant' },
  { id: '11689029605', group: 'Supervisa', sub: 'Parents', app: 'Spouse / Common-Law Partner' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`▶  Deleting ${ITEMS_TO_DELETE.length} duplicate "Passport with all stamped pages." template items …\n`);

  let deleted = 0;
  let failed  = 0;

  for (const item of ITEMS_TO_DELETE) {
    console.log(`   [${item.group}] ${item.sub} / ${item.app}  →  deleting id:${item.id}`);
    try {
      await mondayApi.query(
        `mutation($itemId: ID!) {
           delete_item(item_id: $itemId) { id }
         }`,
        { itemId: item.id }
      );
      deleted++;
    } catch (err) {
      console.error(`   ❌ Failed id:${item.id} — ${err.message}`);
      failed++;
    }
    await sleep(150);
  }

  console.log(`\n✅ Done`);
  console.log(`   Deleted : ${deleted}`);
  console.log(`   Failed  : ${failed}`);
  console.log(`\nNew cases will no longer get duplicate Passport rows in the upload form.`);
  console.log(`Existing execution items for live cases are unchanged.`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
