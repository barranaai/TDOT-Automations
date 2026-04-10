/**
 * importProfileCreationChecklist.js
 *
 * Imports Profile Creation document checklist items to the Template Board
 * and tags all existing items with "Checklist Phase" = "Submission".
 *
 * Two modes:
 *   1. TAG EXISTING:  Sets "Checklist Phase" = "Submission" on all current items
 *      that don't already have a phase set (backward-compat tagging).
 *
 *   2. IMPORT NEW:    Parses the Profile Creation checklist document(s) and
 *      creates new items in the relevant case type groups with
 *      "Checklist Phase" = "Profile Creation".
 *
 * Usage:
 *   Tag existing items only (safe first step):
 *     node src/scripts/importProfileCreationChecklist.js --tag-existing
 *
 *   Import Profile Creation items (after checklist content is ready):
 *     node src/scripts/importProfileCreationChecklist.js --import <path-to-checklist.pdf>
 *
 *   Both:
 *     node src/scripts/importProfileCreationChecklist.js --tag-existing --import <path-to-checklist.pdf>
 *
 * AWAITING: The actual Profile Creation checklist document from Gauri's Google Drive.
 *           Once received, update the PROFILE_CREATION_ITEMS section below with the
 *           parsed document items.
 */

'use strict';

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

// ─── Config ──────────────────────────────────────────────────────────────────

const TEMPLATE_BOARD_ID    = process.env.MONDAY_TEMPLATE_BOARD_ID || '18401624183';
const PHASE_COL_ID         = 'dropdown_mm297t2e';  // "Checklist Phase" dropdown
const RATE_LIMIT_MS        = 250;

// Case types that have Profile Creation checklists (from Gauri's Excel)
const PROFILE_CREATION_CASE_TYPES = [
  'AAIP',
  'OINP',
  'NSNP',
  'BCPNP',
  'RCIP',
  'Manitoba PNP',
  'RNIP',
  'SNIP',
  'Canadian Experience Class (Profile Recreation+ITA+Submission)',
  'Canadian Experience Class (Profile+ITA+Submission)',
  'Federal PR',
];

// Group IDs from templateService.js GROUP_MAP (for the above case types)
const GROUP_MAP = {
  'AAIP':                                                          'group_mm20pzmk',
  'OINP':                                                          'group_mm205n4v',
  'NSNP':                                                          'group_mm20yspz',
  'BCPNP':                                                         'group_mm20pk4z',
  'RCIP':                                                          'group_mm20thv5',
  'Manitoba PNP':                                                  'group_mm20wr7c',
  'RNIP':                                                          'group_mm20ydwb',
  'SNIP':                                                          'group_mm20mgtf',
  'Canadian Experience Class (Profile Recreation+ITA+Submission)': 'group_mm20rprs',
  'Canadian Experience Class (Profile+ITA+Submission)':            'group_mm20npqs',
  'Federal PR':                                                    'group_mm20v0tw',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getGroupItems(groupId) {
  const allItems = [];
  let cursor = null;

  const first = await mondayApi.query(
    `query($boardId: ID!, $groupId: String!) {
       boards(ids: [$boardId]) {
         groups(ids: [$groupId]) {
           items_page(limit: 500) {
             cursor
             items { id name column_values(ids: ["${PHASE_COL_ID}"]) { id text } }
           }
         }
       }
     }`,
    { boardId: TEMPLATE_BOARD_ID, groupId }
  );
  const fp = first?.boards?.[0]?.groups?.[0]?.items_page;
  if (!fp) return [];
  allItems.push(...(fp.items || []));
  cursor = fp.cursor;

  while (cursor) {
    const next = await mondayApi.query(
      `query($cursor: String!) {
         next_items_page(limit: 500, cursor: $cursor) {
           cursor
           items { id name column_values(ids: ["${PHASE_COL_ID}"]) { id text } }
         }
       }`,
      { cursor }
    );
    const p = next?.next_items_page;
    if (!p) break;
    allItems.push(...(p.items || []));
    cursor = p.cursor;
  }
  return allItems;
}

async function setPhase(itemId, phaseLabel) {
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colId: String!, $value: String!) {
       change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $colId, value: $value) { id }
     }`,
    {
      boardId: TEMPLATE_BOARD_ID,
      itemId:  String(itemId),
      colId:   PHASE_COL_ID,
      value:   phaseLabel,
    }
  );
}

// ─── Tag Existing Items ──────────────────────────────────────────────────────

async function tagExistingItems() {
  console.log('═══ Tagging Existing Items as "Submission" ═══\n');

  let tagged = 0;
  let skipped = 0;

  for (const [caseType, groupId] of Object.entries(GROUP_MAP)) {
    console.log(`━━━ ${caseType} ━━━`);
    const items = await getGroupItems(groupId);
    console.log(`  ${items.length} items`);

    for (const item of items) {
      const currentPhase = item.column_values.find(c => c.id === PHASE_COL_ID)?.text?.trim() || '';

      if (currentPhase) {
        skipped++;
        continue; // Already has a phase — don't overwrite
      }

      try {
        await setPhase(item.id, 'Submission');
        tagged++;
        await sleep(RATE_LIMIT_MS);
      } catch (err) {
        console.error(`  Failed: "${item.name}" — ${err.message}`);
      }
    }
    console.log(`  Tagged: ${tagged}, Skipped (already set): ${skipped}`);
  }

  console.log(`\nDone: ${tagged} items tagged as "Submission"\n`);
}

// ─── Import Profile Creation Items ───────────────────────────────────────────
// Parsed from: Document Checklist Items/Provincial Nominee Programs/Document Checklist- Profile Creation.pdf

const PROFILE_CREATION_ITEMS = [
  // ── Principal Applicant & Dependant Spouse/Partner ─────────────────────────
  {
    name: 'Passport with all stamped pages',
    documentCode: 'PC-PA-ID-001',
    category: 'Identity',
    applicantType: 'Principal Applicant',
    description: 'This includes pages with your photo, name, signature, date of birth, place of birth, place of issue, address, etc. Copies of your old and current passport on which travelled to other countries showing entry/exit immigration stamps.',
    instructions: 'Upload clear scans of ALL pages of your current and old passports, including pages with entry/exit immigration stamps.',
  },
  {
    name: 'All Permits ever held in Canada',
    documentCode: 'PC-PA-ID-002',
    category: 'Identity',
    applicantType: 'Principal Applicant',
    description: 'Permits issued as visitor/student/worker to be attached.',
    instructions: 'Upload copies of all visitor permits, study permits, and work permits you have ever held in Canada.',
  },
  {
    name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)',
    documentCode: 'PC-PA-EDU-001',
    category: 'Education',
    applicantType: 'Principal Applicant',
    description: 'Language test results must not be older than two years upon date of receipt.',
    instructions: 'Upload your language test results. Accepted tests: IELTS General, CELPIP General, PTE Core, TEF Canada, or TCF Canada. Results must be less than 2 years old.',
  },
  {
    name: 'Canadian Education Documents',
    documentCode: 'PC-PA-EDU-002',
    category: 'Education',
    applicantType: 'Principal Applicant',
    description: 'Provide complete academic records and credentials. This typically includes:\n- Marksheet: A detailed report card or official transcript showing the grades or marks obtained in each subject for every year or semester of your academic program.\n- Certificates: Official documents issued by educational institutions verifying the completion of a course, degree, diploma, or other educational qualifications.',
    instructions: 'Upload your Canadian education transcripts (marksheets) and certificates/diplomas for all programs completed in Canada.',
  },
  {
    name: 'Foreign Education Documents along with Educational Credential Assessment',
    documentCode: 'PC-PA-EDU-003',
    category: 'Education',
    applicantType: 'Principal Applicant',
    description: 'Provide complete academic records and credentials. This typically includes:\n- Marksheet: A detailed report card or official transcript showing the grades or marks obtained in each subject for every year or semester of your academic program.\n- Certificates: Official documents issued by educational institutions verifying the completion of a course, degree, diploma, or other educational qualifications.\n\nEducational Credential Assessment (ECA) reports are used to check and compare an applicant\'s foreign education to Canadian standards. These reports help decide if someone gets immigration points or is eligible for certain programs.\n\nAccepted ECA providers:\n- Comparative Education Service (CES), University of Toronto\n- International Credential Assessment Service of Canada (ICAS)\n- International Credential Evaluation Service (ICES)\n- International Qualifications Assessment Service (IQAS)\n- World Education Services (WES)\n\nMore information here: https://www.canada.ca/en/immigration-refugees-citizenship/corporate/partners-service-providers/immigrant-serving-organizations/best-practices/foreign-educational-credential-assessment.html',
    instructions: 'Upload your foreign education transcripts (marksheets), certificates/diplomas, AND your Educational Credential Assessment (ECA) report from an approved provider (WES, IQAS, ICAS, ICES, or CES).\n\nMore information here: https://www.canada.ca/en/immigration-refugees-citizenship/corporate/partners-service-providers/immigrant-serving-organizations/best-practices/foreign-educational-credential-assessment.html',
  },
  {
    name: 'Sibling - Proof of living in Canada (if applicable)',
    documentCode: 'PC-PA-FAM-001',
    category: 'Other',
    applicantType: 'Principal Applicant',
    description: 'If you have a sibling living in Canada, provide the following:\n- Drivers license (front and back)\n- Passport (front and back)\n- PR Card (front and back) or Canadian Passport\n- Birth Certificate / 10-12th Marksheets\n- Most recent Utility Bill',
    instructions: 'If applicable, upload proof that your sibling lives in Canada: their driver\'s license, passport, PR card or Canadian passport, birth certificate or marksheets, and a recent utility bill.',
  },
  {
    name: 'Proof of work experience for the claiming period (Inside and Outside Canada)',
    documentCode: 'PC-PA-EMP-001',
    category: 'Employment',
    applicantType: 'Principal Applicant',
    description: '- All paystubs/pay slips for the claiming experience. Paystubs summarize an employee\'s gross pay, taxes, deductions, and net pay. It may be issued as a paper document alongside a pay cheque or provided electronically OR bank statements showing salary deposits OR letter(s) from employer(s) confirming your annual salary/hourly wage (Salary Certificate).\n- T4 or also known as Statement of Remuneration Paid, is a tax slip that employers issue to employees after each calendar year OR Form 16.\n- Employment/Reference letter for all periods of qualifying work experience you identify in your application.\n\nWe can share a template upon request. Please ensure that you begin working on your employment letters as soon as your profile is created. If your employment letter is not available, kindly provide the following details on a word document:\n- Job title\n- Working hours\n- Hourly wage since the start of your position\n- Detailed job description (this is important for determining the correct NOC and TEER category)',
    instructions: 'Upload the following for each period of work experience:\n- Paystubs or bank statements showing salary deposits\n- T4 slips (or Form 16)\n- Employment/Reference letters\n\nIf your employment letter is not yet available, provide a Word document with: job title, working hours, hourly wage, and a detailed job description.',
  },
  {
    name: 'Identity and Civil Documents',
    documentCode: 'PC-PA-LEG-001',
    category: 'Legal',
    applicantType: 'Principal Applicant',
    description: 'Marriage Certificate, Final Divorce or Annulment Certificate. If married more than once, include certificates from each marriage and divorce you have had (if applicable).\nDeath certificate for former spouse or common law partner (if applicable).\nCommon Law declaration - imm5409 (if applicable).\nBirth certificate of children (if applicable).\nLegal documents showing name or date of birth changes (if applicable).',
    instructions: 'Upload all applicable civil documents:\n- Marriage certificate\n- Divorce/annulment certificates (if applicable)\n- Death certificate of former spouse (if applicable)\n- Common-law declaration IMM5409 (if applicable)\n- Children\'s birth certificates (if applicable)\n- Legal name/DOB change documents (if applicable)',
  },

  // ── Dependant Children under 18 ───────────────────────────────────────────
  {
    name: 'Passport with all stamped pages',
    documentCode: 'PC-DC-ID-001',
    category: 'Identity',
    applicantType: 'Dependent Child',
    description: 'This includes pages with your photo, name, signature, date of birth, place of birth, place of issue, address, etc. Copies of your old and current passport on which travelled to other countries showing entry/exit immigration stamps.',
    instructions: 'Upload clear scans of ALL pages of your child\'s current and old passports, including pages with entry/exit immigration stamps.',
  },
  {
    name: 'All Permits ever held in Canada',
    documentCode: 'PC-DC-ID-002',
    category: 'Identity',
    applicantType: 'Dependent Child',
    description: 'Permits issued as visitor/student/worker to be attached.',
    instructions: 'Upload copies of all permits (visitor, study, work) ever held by your child in Canada.',
  },
  {
    name: 'Birth Certificate',
    documentCode: 'PC-DC-LEG-001',
    category: 'Legal',
    applicantType: 'Dependent Child',
    description: 'It should be issued by the government and should have parents name on it.',
    instructions: 'Upload a government-issued birth certificate for your child. It must include the parents\' names.',
  },
];

async function importProfileCreationItems() {
  if (!PROFILE_CREATION_ITEMS.length) {
    console.log('═══ Profile Creation Import ═══\n');
    console.log('  No items defined in PROFILE_CREATION_ITEMS array.');
    console.log('  Awaiting checklist content from Gauri.');
    console.log('  Once the checklist document is received, populate the array and re-run.\n');
    return;
  }

  console.log(`═══ Importing ${PROFILE_CREATION_ITEMS.length} Profile Creation Items ═══\n`);

  const DOC_COLS = {
    caseType:     'dropdown_mm0x7zb4',
    category:     'dropdown_mm0x41zm',
    phase:        PHASE_COL_ID,
    applicantType:'dropdown_mm261bn6',
    description:  'long_text_mm0zmb7j',
    instructions: 'long_text_mm0z10mg',
    documentCode: 'text_mm0xprz5',
    required:     'dropdown_mm0x9v5q',
    version:      'dropdown_mm0xm5zg',
  };

  let created = 0;

  for (const [caseType, groupId] of Object.entries(GROUP_MAP)) {
    console.log(`━━━ ${caseType} ━━━`);

    for (const item of PROFILE_CREATION_ITEMS) {
      // Build column values — exclude phase (set separately via change_simple_column_value)
      const colVals = {
        [DOC_COLS.caseType]:     { labels: [caseType] },
        [DOC_COLS.category]:     { labels: [item.category || 'General'] },
        [DOC_COLS.applicantType]:{ labels: [item.applicantType || 'Principal Applicant'] },
        [DOC_COLS.required]:     { labels: ['Mandatory'] },
        [DOC_COLS.version]:      { labels: ['v1.0'] },
      };

      if (item.documentCode) colVals[DOC_COLS.documentCode] = item.documentCode;
      if (item.description)  colVals[DOC_COLS.description]  = { text: item.description.slice(0, 2000) };
      if (item.instructions) colVals[DOC_COLS.instructions] = { text: item.instructions.slice(0, 2000) };

      try {
        // Step 1: Create the item
        const result = await mondayApi.query(
          `mutation($boardId: ID!, $groupId: String!, $itemName: String!, $colValues: JSON!) {
             create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $colValues) { id }
           }`,
          {
            boardId:   TEMPLATE_BOARD_ID,
            groupId,
            itemName:  item.name.slice(0, 255),
            colValues: JSON.stringify(colVals),
          }
        );

        const newItemId = result?.create_item?.id;

        // Step 2: Set the Checklist Phase to "Profile Creation"
        if (newItemId) {
          await setPhase(newItemId, 'Profile Creation');
        }

        created++;
        console.log(`  + "${item.name}" (${item.applicantType})`);
        await sleep(RATE_LIMIT_MS);
      } catch (err) {
        console.error(`  Failed: "${item.name}" — ${err.message}`);
      }
    }
  }

  console.log(`\nDone: ${created} Profile Creation items created across ${Object.keys(GROUP_MAP).length} case types\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const doTag    = args.includes('--tag-existing');
  const doImport = args.includes('--import');

  if (!doTag && !doImport) {
    console.log('Usage:');
    console.log('  node src/scripts/importProfileCreationChecklist.js --tag-existing');
    console.log('  node src/scripts/importProfileCreationChecklist.js --import');
    console.log('  node src/scripts/importProfileCreationChecklist.js --tag-existing --import');
    return;
  }

  if (doTag) await tagExistingItems();
  if (doImport) await importProfileCreationItems();
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
