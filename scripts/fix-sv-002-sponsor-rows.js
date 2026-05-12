/**
 * One-off — add the 7 missing Sponsor execution rows for case 2026-SV-002.
 *
 * Background: the Supervisa-Parents Template Board entry on Monday is
 * misconfigured against the source PDF. The PDF defines two applicant
 * sections (Principal Applicant + Dependent Spouse, and Sponsor/Inviter)
 * but the Template Board only has PA and Spouse — with 4 of the Sponsor's
 * 7 documents wrongly assigned to PA and Spouse instead. Result: when
 * 2026-SV-002 was created, no Sponsor rows existed.
 *
 * This script adds the 7 Sponsor rows DIRECTLY to the case's execution
 * rows (without going through the Template Board). The Template Board
 * itself remains misconfigured — that's a separate cleanup task.
 *
 * Document list is from:
 *   Document Checklist Items/Supervisa/Document Checklist- Supervisa- Parents.pdf
 *   page 4 "Documents for the Inviter"
 *
 * Safety:
 *   - Idempotent: re-running won't create duplicates (skips if the
 *     uniqueKey already exists on the Execution Board for this case).
 *   - Doesn't touch existing rows (including the 4 misallocated rows on
 *     PA/Spouse — those have client uploads attached and need manual
 *     review by the case officer).
 *   - Default dry-run; --write to apply.
 */

'use strict';

require('dotenv').config();
const mondayApi = require('../src/services/mondayApi');

const WRITE = process.argv.includes('--write');

const EXEC_BOARD_ID = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const CM_BOARD_ID   = process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const EXECUTION_GROUP_ID = 'topics';

const EXEC_COL = {
  caseReferenceNumber: 'text_mm0z2cck',
  uniqueKey:           'text_mm15dwah',
  documentCode:        'text_mm0zr7tf',
  caseSubType:         'text_mm17zdy7',
  intakeItemId:        'text_mm0zfsp1',
  documentFolder:      'link_mm1yrnz1',
  applicantType:       'text_mm26jcv7',
  documentCategory:    'text_mm261tka',
  clientCase:          'board_relation_mm0zwb5',
  clientMasterBoard:   'board_relation_mm0z5p76',
};

const CASE_REF       = '2026-SV-002';
const CASE_SUB_TYPE  = 'Parents';
const APPLICANT_TYPE = 'Sponsor';

// 7 Sponsor docs from Supervisa-Parents PDF, page 4 "Documents for the Inviter"
// Each entry: { name, category, code, folderUrlKey }
const SPONSOR_DOCS = [
  { name: 'Passport with all stamped pages',                                  category: 'Identity',  code: 'SV-PARENTS-SPONSOR-PASSPORT-001' },
  { name: 'Current Status in the country',                                    category: 'Other',     code: 'SV-PARENTS-SPONSOR-CURSTATUS-001' },
  { name: 'Birth Certificate',                                                category: 'Identity',  code: 'SV-PARENTS-SPONSOR-BIRTHCERT-001' },
  { name: 'Identity and Civil Documents',                                     category: 'Identity',  code: 'SV-PARENTS-SPONSOR-IACD-001' },
  { name: 'Proof of living in Canada (any 1)',                                category: 'Other',     code: 'SV-PARENTS-SPONSOR-POLC-001' },
  { name: 'Proof/source of Income',                                           category: 'Financial', code: 'SV-PARENTS-SPONSOR-INCOME-001' },
  { name: 'Additional proof of Funds/investments/assets',                     category: 'Financial', code: 'SV-PARENTS-SPONSOR-FUNDS-001' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`Mode: ${WRITE ? '✏  WRITE (live)' : '🔍 DRY-RUN'}  |  case: ${CASE_REF}\n`);

  // ── 1. Locate the Client Master item for this case
  const cmData = await mondayApi.query(
    `query { items_page_by_column_values(limit:1, board_id:${CM_BOARD_ID}, columns:[{column_id:"text_mm142s49", column_values:["${CASE_REF}"]}]) { items { id name } } }`
  );
  const cmItem = cmData?.items_page_by_column_values?.items?.[0];
  if (!cmItem) {
    console.error(`✗ Case ${CASE_REF} not found on Client Master.`);
    process.exit(1);
  }
  console.log(`Client Master: ${cmItem.id} (${cmItem.name})`);

  // ── 2. Gather existing exec rows so we can:
  //       (a) determine the OneDrive folder URL per category (reuse existing),
  //       (b) detect dupes by uniqueKey (idempotency).
  const existing = await mondayApi.query(
    `query { items_page_by_column_values(limit:500, board_id:${EXEC_BOARD_ID}, columns:[{column_id:"${EXEC_COL.caseReferenceNumber}", column_values:["${CASE_REF}"]}]) { items { id name column_values(ids:["${EXEC_COL.uniqueKey}","${EXEC_COL.documentCategory}","${EXEC_COL.applicantType}","${EXEC_COL.documentFolder}"]) { id text } } } }`
  );
  const existingItems = existing?.items_page_by_column_values?.items || [];

  const folderByCategory = {};
  const existingUniqueKeys = new Set();
  const existingSponsorRows = [];
  for (const it of existingItems) {
    const cv = {};
    it.column_values.forEach(c => { cv[c.id] = c.text || ''; });
    if (cv[EXEC_COL.uniqueKey]) existingUniqueKeys.add(cv[EXEC_COL.uniqueKey]);
    if (cv[EXEC_COL.applicantType] === APPLICANT_TYPE) existingSponsorRows.push({ id: it.id, name: it.name });
    const cat    = cv[EXEC_COL.documentCategory];
    const folder = cv[EXEC_COL.documentFolder];
    if (cat && folder && !folderByCategory[cat]) {
      const m = folder.match(/(https?:\/\/\S+)/);
      if (m) folderByCategory[cat] = m[1];
    }
  }

  console.log(`Existing exec rows on this case: ${existingItems.length}`);
  console.log(`Existing Sponsor rows: ${existingSponsorRows.length}  (idempotency check)`);
  if (existingSponsorRows.length) {
    for (const r of existingSponsorRows) console.log(`   already exists: id=${r.id} "${r.name}"`);
  }
  console.log(`Folder URLs by category: ${JSON.stringify(folderByCategory, null, 2)}`);
  console.log('');

  // ── 3. Plan which rows to add
  const toAdd = [];
  for (const doc of SPONSOR_DOCS) {
    const uniqueKey = `${CASE_REF}-${doc.code}`;
    if (existingUniqueKeys.has(uniqueKey)) {
      console.log(`  ⊘ skipped (uniqueKey exists): ${doc.name}`);
      continue;
    }
    // Skip if a Sponsor row with same name already exists
    if (existingSponsorRows.some(r => r.name === doc.name)) {
      console.log(`  ⊘ skipped (Sponsor row already named ${JSON.stringify(doc.name)})`);
      continue;
    }
    toAdd.push({ ...doc, uniqueKey, folderUrl: folderByCategory[doc.category] || '' });
  }

  console.log('');
  console.log(`Will add ${toAdd.length} Sponsor row(s):`);
  for (const r of toAdd) {
    console.log(`  + [${r.category}] ${r.name}  (code: ${r.code})`);
  }

  if (!WRITE) {
    console.log('\n(Dry-run only. Re-run with --write to create the rows.)');
    return;
  }
  if (!toAdd.length) {
    console.log('\nNothing to add.');
    return;
  }

  // ── 4. Create rows
  console.log('');
  let created = 0, failed = 0;
  for (const r of toAdd) {
    const createColValues = {
      [EXEC_COL.caseReferenceNumber]: CASE_REF,
      [EXEC_COL.uniqueKey]:           r.uniqueKey,
      [EXEC_COL.documentCode]:        r.code,
      [EXEC_COL.caseSubType]:         CASE_SUB_TYPE,
      [EXEC_COL.intakeItemId]:        '',  // No linked Template Board item — Template Board needs separate fix
      [EXEC_COL.documentCategory]:    r.category,
      [EXEC_COL.applicantType]:       APPLICANT_TYPE,
    };
    if (r.folderUrl) {
      createColValues[EXEC_COL.documentFolder] = { url: r.folderUrl, text: `${r.category} Folder` };
    }
    try {
      const result = await mondayApi.query(
        `mutation($boardId: ID!, $groupId: String!, $itemName: String!, $cols: JSON!) {
           create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $cols) { id name }
         }`,
        {
          boardId:  String(EXEC_BOARD_ID),
          groupId:  EXECUTION_GROUP_ID,
          itemName: r.name,
          cols:     JSON.stringify(createColValues),
        }
      );
      const newId = result?.create_item?.id;
      // Now attach board_relation columns (they're rejected by create_item)
      if (newId) {
        try {
          await mondayApi.query(
            `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
               change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
             }`,
            {
              boardId: String(EXEC_BOARD_ID),
              itemId:  String(newId),
              cols:    JSON.stringify({
                [EXEC_COL.clientCase]:        { item_ids: [Number(cmItem.id)] },
                [EXEC_COL.clientMasterBoard]: { item_ids: [Number(cmItem.id)] },
              }),
            }
          );
        } catch (relErr) {
          console.warn(`     ⚠ Could not link Client Master relations: ${relErr.message}`);
        }
      }
      console.log(`  ✓ created: ${r.name}  (id: ${newId})`);
      created++;
    } catch (err) {
      console.error(`  ✗ failed: ${r.name}  — ${err.message}`);
      failed++;
    }
    await sleep(250);
  }

  // ── 5. Post an audit Monday Update on the Client Master so staff knows
  if (created > 0) {
    const today = new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: true });
    const lines = toAdd.slice(0, created).map(r => `  • [${r.category}] ${r.name}`).join('\n');
    const body =
      `🛠 Sponsor documents added to checklist\n\n` +
      `Case: ${CASE_REF}  (${cmItem.name})\n` +
      `Added on: ${today} (Toronto)\n\n` +
      `Per the Supervisa-Parents PDF, the case requires 7 Sponsor (Inviter) documents that were missing from the Template Board.\n\n` +
      `New Sponsor rows added to the document checklist:\n${lines}\n\n` +
      `⚠ Manual review needed for the 4 misallocated rows already on PA/Spouse:\n` +
      `  • Current Status in the country (currently on PA — likely an Inviter doc)\n` +
      `  • Birth Certificate (on PA + Spouse — Inviter doc)\n` +
      `  • Proof of living in Canada (on PA + Spouse — Inviter doc)\n` +
      `  • Additional proof of Funds/investments/assets (on PA + Spouse — Inviter doc)\n\n` +
      `Some of these have already been uploaded by the client to the WRONG rows. Case officer should verify the files and, if appropriate, mark the new Sponsor rows as Received with a reference to the original upload location.\n\n` +
      `Root cause: Template Board misconfigured for Supervisa-Parents. Affects all future Supervisa cases on this sub-type until the Template Board is rebuilt.`;
    try {
      await mondayApi.query(
        `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
        { itemId: String(cmItem.id), body }
      );
      console.log(`\n✓ Posted audit Update on Client Master row ${cmItem.id}`);
    } catch (err) {
      console.warn(`\n⚠ Could not post audit Update: ${err.message}`);
    }
  }

  console.log(`\nDone. Created: ${created}  Failed: ${failed}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
