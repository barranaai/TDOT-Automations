/**
 * Patch script: imports the Family section questions (Parents/Spouse, Children,
 * Siblings, Deceased) that failed in the initial Outside Canada import because
 * 'Family' was not a valid category label. Re-imports them with category = 'Personal'.
 *
 * Usage: node src/scripts/patchOutsideCanadaFamilyItems.js
 */
require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID = '18402113809';
const VERSION  = 'v1.0';
const SUB_TYPE = 'Outside Canada';

const COLS = {
  questionCode:             'text_mm1235b5',
  primaryCaseType:          'dropdown_mm124p5v',
  caseSubType:              'text_mm198npt',
  questionCategory:         'dropdown_mm12w5fd',
  requiredType:             'dropdown_mm12dqc7',
  inputType:                'dropdown_mm12pn7g',
  checklistTemplateVersion: 'dropdown_mm12spk7',
  helpText:                 'long_text_mm12df2b',
};

const TARGET_GROUPS = [
  { groupId: 'group_mm12xza9', caseType: 'SOWP', prefix: 'SOWP-OC', startIndex: 57 },
  { groupId: 'group_mm12v89',  caseType: 'LMIA', prefix: 'LMIA-OC', startIndex: 57 },
];

// Only the Family section questions (Main Applicant)
const FAMILY_MAIN = [
  { name: 'Parents/Spouse – Full Name (As per Passport)',   category: 'Personal', inputType: 'Short Text', required: 'Mandatory',   helpText: 'Provide details for father, mother, wife, or husband. If deceased, specify date and city/town of death. If in Canada, mention their immigration status with address.' },
  { name: 'Parents/Spouse – Marital Status',               category: 'Personal', inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Parents/Spouse – Date of Birth',                category: 'Personal', inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Parents/Spouse – Country of Birth',             category: 'Personal', inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Parents/Spouse – Full Address',                 category: 'Personal', inputType: 'Long Text',  required: 'Mandatory',   helpText: 'If residing in Canada, please mention their immigration status with address.' },
  { name: 'Parents/Spouse – Current Occupation (Job Title)', category: 'Personal', inputType: 'Short Text', required: 'Mandatory', helpText: '' },
  { name: 'Children – Full Name (As per Passport)',        category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: 'Include all sons, daughters, and adopted children. If deceased, specify date and city/town of death. If in Canada, include immigration status and address.' },
  { name: 'Children – Marital Status',                     category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Children – Date of Birth',                      category: 'Personal', inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Children – Country of Birth',                   category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Children – Full Address',                       category: 'Personal', inputType: 'Long Text',  required: 'Conditional', helpText: 'If residing in Canada, please mention their immigration status with address.' },
  { name: 'Children – Current Occupation (Job Title)',     category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Siblings – Full Name (As per Passport)',        category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: 'Include brothers and sisters (including half-brothers/sisters and stepbrothers/sisters). If deceased, specify date and city/town of death. If in Canada, include immigration status and address.' },
  { name: 'Siblings – Marital Status',                     category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Siblings – Date of Birth',                      category: 'Personal', inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Siblings – Country of Birth',                   category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Siblings – Full Address',                       category: 'Personal', inputType: 'Long Text',  required: 'Conditional', helpText: 'If residing in Canada, please mention their immigration status with address.' },
  { name: 'Siblings – Current Occupation (Job Title)',     category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased – Family Name (As per Passport)',      category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased – Given Name',                         category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased – Relationship',                       category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased – Date of Death',                      category: 'Personal', inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Deceased – City and Country of Death',          category: 'Personal', inputType: 'Short Text', required: 'Conditional', helpText: '' },
];

// Dependent versions (same items with "(Dependent)" suffix)
const FAMILY_DEPENDENT = FAMILY_MAIN.map((q) => ({ ...q, name: `${q.name} (Dependent)` }));

// Combined: main first, then dependent
// In the original script, main has 100 questions (indices 1-100) and
// family starts at index 58 (1-based). Dependent starts at index 101 with
// the same relative positions (family at 101+48 offset from dependent start).
// For the patch we just need unique codes - use P (patch) suffix to avoid collision.
const ALL_PATCH = [...FAMILY_MAIN, ...FAMILY_DEPENDENT];

async function createItem({ name, code, category, inputType, required, helpText, groupId, caseType }) {
  const columnValues = JSON.stringify({
    [COLS.questionCode]:             code,
    [COLS.primaryCaseType]:          { labels: [caseType] },
    [COLS.caseSubType]:              SUB_TYPE,
    [COLS.questionCategory]:         { labels: [category] },
    [COLS.requiredType]:             { labels: [required] },
    [COLS.inputType]:                { labels: [inputType] },
    [COLS.checklistTemplateVersion]: { labels: [VERSION] },
    ...(helpText ? { [COLS.helpText]: { text: helpText } } : {}),
  });

  const data = await mondayApi.query(
    `mutation createItem(
      $boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!
    ) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id name
      }
    }`,
    { boardId: BOARD_ID, groupId, itemName: name, columnValues }
  );
  return data?.create_item;
}

async function main() {
  console.log(`Patching ${ALL_PATCH.length} Family section questions × ${TARGET_GROUPS.length} groups = ${ALL_PATCH.length * TARGET_GROUPS.length} items\n`);

  let overallCreated = 0;
  let overallFailed  = 0;

  for (const group of TARGET_GROUPS) {
    console.log(`\n━━━ ${group.caseType} – Outside Canada (Family patch) ━━━`);
    let groupCreated = 0;

    for (let i = 0; i < ALL_PATCH.length; i++) {
      const q    = ALL_PATCH[i];
      // Use original position codes: main family starts at item 58, dependent at 101+(58-1)=158
      const isMD = q.name.includes('(Dependent)');
      const baseIdx = isMD
        ? 100 + (group.startIndex + 1) + i - FAMILY_MAIN.length  // dependent offset
        : group.startIndex + 1 + i;                               // main offset (1-based)
      const code = `${group.prefix}-${String(baseIdx).padStart(3, '0')}`;

      try {
        const result = await createItem({
          name:      q.name,
          code,
          category:  q.category,
          inputType: q.inputType,
          required:  q.required,
          helpText:  q.helpText || '',
          groupId:   group.groupId,
          caseType:  group.caseType,
        });
        console.log(`  [${i + 1}/${ALL_PATCH.length}] ✓ ${code} — ${result?.name}`);
        groupCreated++;
        overallCreated++;
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        console.error(`  [${i + 1}/${ALL_PATCH.length}] ✗ ${code} — ${err.message}`);
        overallFailed++;
      }
    }

    console.log(`  → ${groupCreated}/${ALL_PATCH.length} created for ${group.caseType}`);
  }

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`Patch complete — ${overallCreated} created, ${overallFailed} failed.`);
}

main().catch(console.error);
