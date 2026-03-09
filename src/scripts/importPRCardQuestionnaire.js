/**
 * Bulk import PR Card questionnaire (April 2025) into:
 *   - Lost PR Card    (new group)
 *   - PR Card Renewal (existing group)
 *   - PRTD            (existing group)
 *
 * All three case types share the exact same questionnaire (51 questions).
 *
 * Usage: node src/scripts/importPRCardQuestionnaire.js
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
  { groupId: 'group_mm19cwv',  caseType: 'Lost PR Card',    prefix: 'LPC' },
  { groupId: 'group_mm12kg5w', caseType: 'PR Card Renewal', prefix: 'PCR' },
  { groupId: 'group_mm124765', caseType: 'PRTD',            prefix: 'PRTD' },
];

const QUESTIONS = [
  // ── Section 1: Personal Details ──────────────────────────────────────────
  { name: 'Family Name (Surname)',                                                                       category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Given Name',                                                                                  category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever used any other name?',                                                          category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide: Family Name and Given Name of other name(s) used.' },
  { name: 'Other Name – Family Name',                                                                    category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: 'Required if you have used another name.' },
  { name: 'Other Name – Given Name',                                                                     category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Country of Citizenship',                                                                      category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Current Residence Country',                                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Date you became PR in Canada',                                                                category: 'Personal',    inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Place you became PR in Canada',                                                               category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Eye Color',                                                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Height (in cm)',                                                                              category: 'Personal',    inputType: 'Number',     required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been issued a removal order?',                                                  category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Has an immigration officer ever issued you an inadmissibility report under subsection 44(1) of the Immigration, Refugee and Protection Act?', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory', helpText: '' },
  { name: 'Have you ever lost your status as a PR of Canada?',                                           category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever submitted an appeal to the Immigration Appeal Division against a decision on the residence obligation?', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory', helpText: '' },
  { name: 'Have you ever been issued a Travel Document or PRTD?',                                        category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },

  // ── Section 1: Marital Status ─────────────────────────────────────────────
  { name: 'Current Marital Status',                                                                      category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Date of Marriage (DD/MM/YYYY)',                                                               category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: 'Required if currently married or in a common-law relationship.' },
  { name: "Spouse's Family Name",                                                                        category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Given Name",                                                                         category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Date of Birth",                                                                      category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },

  // ── Section 1: Contact Details ────────────────────────────────────────────
  { name: 'Mobile Number',                                                                               category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Email Address',                                                                               category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Mailing Address',                                                                             category: 'Personal',    inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Residential Address',                                                                         category: 'Personal',    inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },

  // ── Section 1: Address Details (Past 5 Years) ─────────────────────────────
  { name: 'Address History – From Date (DD-MM-YYYY)',                                                    category: 'Personal',    inputType: 'Date',       required: 'Mandatory',   helpText: 'List all addresses inside and outside Canada during your entire 5-year eligibility period. Include full dates (DD-MM-YYYY) with no gaps.' },
  { name: 'Address History – To Date (DD-MM-YYYY)',                                                      category: 'Personal',    inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Unit / Apartment No.',                                                      category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Address History – Street No.',                                                                category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Street Name',                                                               category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – City',                                                                      category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Province',                                                                  category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: 'Required for Canadian addresses.' },
  { name: 'Address History – Country',                                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Postal Code',                                                               category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: 'Required for Canadian addresses.' },

  // ── Section 1: Travel History (Past 5 Years) ──────────────────────────────
  { name: 'Travel – Start Date (DD/MM/YYYY)',                                                            category: 'Travel',      inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide your travel history for the past 5 years (including your home country). Include full dates (DD-MM-YYYY).' },
  { name: 'Travel – End Date (DD/MM/YYYY)',                                                              category: 'Travel',      inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Status',                                                                             category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: 'E.g., In Canada, Outside Canada, Visitor, Worker, etc.' },
  { name: 'Travel – City',                                                                               category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Country',                                                                            category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Purpose of Travelling',                                                              category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 1: Personal History (Past 5 Years) ────────────────────────────
  { name: 'Personal History – From Date (DD-MM-YYYY)',                                                   category: 'Employment',  inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide all full-time and part-time employment, self-employment, education, and unemployment history over the past 5 years. Include full dates (DD-MM-YYYY) with no gaps in your timeline.' },
  { name: 'Personal History – To Date (DD-MM-YYYY)',                                                     category: 'Employment',  inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Occupation / Activity',                                                    category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: 'E.g., Employed, Self-Employed, Student, Unemployed.' },
  { name: 'Personal History – Company / Education Institute',                                            category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Unit / Apartment No.',                                                     category: 'Employment',  inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Personal History – Street No. and Name',                                                      category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – City',                                                                     category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Country',                                                                  category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Postal Code',                                                              category: 'Employment',  inputType: 'Short Text', required: 'Conditional', helpText: 'Required for Canadian addresses.' },

  // ── Section 4: Statutory Questions ───────────────────────────────────────
  { name: 'Have you been employed on a full-time basis by a Canadian business outside Canada or in the federal/provincial public service while absent from Canada?', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory', helpText: 'If you answer Yes to any statutory question, please provide complete details.' },
  { name: 'Have you been accompanying a Canadian citizen who is your spouse, common-law partner, or parent, while absent from Canada?',                              category: 'Legal', inputType: 'Dropdown', required: 'Mandatory', helpText: '' },
  { name: 'Have you been accompanying a PR who is your spouse, common-law partner, or parent, and who is employed full-time by a Canadian business outside Canada?', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory', helpText: '' },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa (including CSQ or Provincial Nominee Program) to Canada?',               category: 'Legal', inputType: 'Dropdown', required: 'Mandatory', helpText: '' },
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
  console.log(`Importing ${QUESTIONS.length} questions into ${TARGET_GROUPS.length} groups\n`);

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
