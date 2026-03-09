/**
 * Bulk import USA Visa questionnaire (April 2025) into the "US visa" group
 * on the Questionnaire Template Board.
 *
 * Single applicant type (Main Applicant).
 * Note: document is a lean first-pass form — Employment section is absent
 * despite being listed in the section title (likely a work-in-progress).
 *
 * Usage: node src/scripts/importUSAVisaQuestionnaire.js
 */
require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID = '18402113809';
const VERSION  = 'v1.0';

const COLS = {
  questionCode:             'text_mm1235b5',
  primaryCaseType:          'dropdown_mm124p5v',
  questionCategory:         'dropdown_mm12w5fd',
  requiredType:             'dropdown_mm12dqc7',
  inputType:                'dropdown_mm12pn7g',
  checklistTemplateVersion: 'dropdown_mm12spk7',
  helpText:                 'long_text_mm12df2b',
};

const TARGET_GROUPS = [
  { groupId: 'group_mm126xq6', caseType: 'US visa', prefix: 'USV' },
];

const QUESTIONS = [
  // ── Section 1: Personal Details ──────────────────────────────────────────
  { name: 'Family Name (Surname)',                                                                       category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Given Name',                                                                                  category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever used any other name?',                                                          category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide Family Name and Given Name of other name(s) used.' },
  { name: 'Other Name – Family Name',                                                                    category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: 'Required if you have used another name.' },
  { name: 'Other Name – Given Name',                                                                     category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Country of Citizenship',                                                                      category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Current Residence Country',                                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Current Residential Address',                                                                 category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Current Mailing Address (if different from residential)',                                     category: 'Personal',   inputType: 'Long Text',  required: 'Conditional', helpText: 'Only required if different from residential address.' },
  { name: 'Height',                                                                                      category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Eye Color',                                                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Phone Number',                                                                                category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Email Address',                                                                               category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 1: Marital Status ─────────────────────────────────────────────
  { name: 'Current Marital Status',                                                                      category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Date of Marriage (DD/MM/YYYY)',                                                               category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: 'Required if currently married.' },
  { name: "Spouse's Family Name",                                                                        category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Given Name",                                                                         category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Date of Birth",                                                                      category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Have you previously been married or in a common-law relationship?',                           category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details of your previous partner.' },
  { name: 'Previous Partner – Date of Marriage',                                                        category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Divorce / Separation',                                            category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Family Name',                                                             category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Given Name',                                                              category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Birth',                                                           category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },

  // ── Section 2: Family Information (Living) ────────────────────────────────
  { name: 'Family Member – Family Name (As per Passport)',                                              category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: 'Provide details for father, mother, wife/husband, children, and siblings. If deceased, specify date and city/town of death. If in Canada, include their immigration status and address.' },
  { name: 'Family Member – Given Name',                                                                 category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – Relationship',                                                               category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – Date of Birth (DD/MM/YYYY)',                                                category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – Country of Birth',                                                          category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – Current City and Country of Residence',                                     category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: 'If in Canada, include immigration status and address.' },

  // ── Section 2: Family Information (Deceased) ──────────────────────────────
  { name: 'Deceased Family Member – Family Name (As per Passport)',                                    category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: 'Complete for any deceased family member. Specify date and city/town of death.' },
  { name: 'Deceased Family Member – Given Name',                                                       category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased Family Member – Relationship',                                                     category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased Family Member – Date of Birth (DD/MM/YYYY)',                                      category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Deceased Family Member – Date of Death (DD/MM/YYYY)',                                      category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Deceased Family Member – City and Country of Death',                                       category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // ── Section 4: Education ──────────────────────────────────────────────────
  { name: 'Education – Start Date (DD/MM/YYYY)',                                                       category: 'Education',  inputType: 'Date',       required: 'Mandatory',   helpText: 'Include full dates (DD-MM-YYYY). Include College, University, or any apprentice training.' },
  { name: 'Education – End Date (DD/MM/YYYY)',                                                         category: 'Education',  inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Education – Course / Program Name',                                                         category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – Education Institute',                                                           category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – City',                                                                          category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – Country',                                                                       category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 6: Travel History (Past 10 Years) ─────────────────────────────
  { name: 'Travel – Start Date (DD/MM/YYYY)',                                                          category: 'Travel',     inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide travel history for the past 10 years (including home country). Include full dates (DD-MM-YYYY) and your status (Student, Visitor, Worker, Citizen, etc.).' },
  { name: 'Travel – End Date (DD/MM/YYYY)',                                                            category: 'Travel',     inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Status (Student, Visitor, Worker, Citizen)',                                       category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – City',                                                                             category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Country',                                                                          category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Purpose of Travelling',                                                            category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
];

async function createItem({ name, code, category, inputType, required, helpText, groupId, caseType }) {
  const columnValues = JSON.stringify({
    [COLS.questionCode]:             code,
    [COLS.primaryCaseType]:          { labels: [caseType] },
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
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues, create_labels_if_missing: true) {
        id name
      }
    }`,
    { boardId: BOARD_ID, groupId, itemName: name, columnValues }
  );
  return data?.create_item;
}

async function main() {
  console.log(`Importing ${QUESTIONS.length} questions into ${TARGET_GROUPS.length} group\n`);

  let overallCreated = 0;
  let overallFailed  = 0;

  for (const group of TARGET_GROUPS) {
    console.log(`\n━━━ ${group.caseType} (${group.prefix}) ━━━`);
    let groupCreated = 0;

    for (let i = 0; i < QUESTIONS.length; i++) {
      const q    = QUESTIONS[i];
      const code = `${group.prefix}-${String(i + 1).padStart(3, '0')}`;

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
        console.log(`  [${i + 1}/${QUESTIONS.length}] ✓ ${code} — ${result?.name}`);
        groupCreated++;
        overallCreated++;
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        console.error(`  [${i + 1}/${QUESTIONS.length}] ✗ ${code} — ${err.message}`);
        overallFailed++;
      }
    }

    console.log(`  → ${groupCreated}/${QUESTIONS.length} created for ${group.caseType}`);
  }

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`Import complete — ${overallCreated} created, ${overallFailed} failed.`);
}

main().catch(console.error);
