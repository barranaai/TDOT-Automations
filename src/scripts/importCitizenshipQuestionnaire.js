/**
 * Bulk import Citizenship questionnaire (April 2025) into the
 * "Citizenship" group on the Questionnaire Template Board.
 *
 * Usage: node src/scripts/importCitizenshipQuestionnaire.js
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
  { groupId: 'group_mm12kq85', caseType: 'Citizenship', prefix: 'CIT' },
];

const QUESTIONS = [
  // ── Section 1: Personal Details ─────────────────────────────────────────
  { name: 'Family Name (Surname)',                                                           category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Given Name',                                                                      category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever used any other name?',                                              category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide: Family Name and Given Name of other name(s) used.' },
  { name: 'Other Name – Family Name',                                                        category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: 'Required if you have used another name.' },
  { name: 'Other Name – Given Name',                                                         category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Have you changed your name since becoming a Permanent Resident?',                 category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide your current full name: Family Name and Given Name.' },
  { name: 'New Name – Family Name (after PR)',                                               category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: 'Required if you changed your name after becoming a Permanent Resident.' },
  { name: 'New Name – Given Name (after PR)',                                                category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Your Height',                                                                     category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Eye Colour',                                                                      category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 1: Marital Status ────────────────────────────────────────────
  { name: 'Current Marital Status',                                                          category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Date of Marriage (DD/MM/YYYY)',                                                   category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: 'Required if currently married.' },
  { name: "Spouse's Family Name",                                                            category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: 'Required if currently married.' },
  { name: "Spouse's Given Name",                                                             category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: 'Required if currently married.' },
  { name: "Spouse's Date of Birth",                                                          category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: 'Required if currently married.' },
  { name: 'Have you previously been married or in a common-law relationship?',               category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details of your previous partner.' },
  { name: 'Previous Partner – Date of Marriage',                                             category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Divorce / Separation',                                 category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Family Name',                                                  category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Given Name',                                                   category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Birth',                                                category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },

  // ── Section 1: Contact Details ───────────────────────────────────────────
  { name: 'Mobile Number',                                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Email Address',                                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Mailing Address',                                                                 category: 'Personal',    inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Residential Address',                                                             category: 'Personal',    inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },

  // ── Section 2: Address History (past 5 years) ────────────────────────────
  { name: 'Address History – From Date (DD-MM-YYYY)',                                        category: 'Personal',    inputType: 'Date',       required: 'Mandatory',   helpText: 'List all addresses (inside and outside Canada) for your entire 5-year eligibility period. Addresses must be consistent with your PR application. Do not leave any gaps. Include full dates (DD-MM-YYYY).' },
  { name: 'Address History – To Date (DD-MM-YYYY)',                                          category: 'Personal',    inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Unit / Apartment No.',                                          category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Address History – Street No.',                                                    category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Street Name',                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – City',                                                          category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Province',                                                      category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Address History – Country',                                                       category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Postal Code',                                                   category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // ── Section 3: Income Tax (citizenship physical presence + compliance) ───
  { name: 'SIN Number',                                                                      category: 'Financial',   inputType: 'Short Text', required: 'Mandatory',   helpText: 'Your Social Insurance Number. Required for citizenship income tax assessment.' },
  { name: 'Tax Year 2024 – Required to File',                                                category: 'Financial',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'Were you required to file income tax for the year 2024? If you did not file, please provide reasons.' },
  { name: 'Tax Year 2024 – Taxes Filed',                                                     category: 'Financial',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Tax Year 2023 – Required to File',                                                category: 'Financial',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Tax Year 2023 – Taxes Filed',                                                     category: 'Financial',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Tax Year 2022 – Required to File',                                                category: 'Financial',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Tax Year 2022 – Taxes Filed',                                                     category: 'Financial',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Tax Year 2021 – Required to File',                                                category: 'Financial',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Tax Year 2021 – Taxes Filed',                                                     category: 'Financial',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Tax Year 2020 – Required to File',                                                category: 'Financial',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Tax Year 2020 – Taxes Filed',                                                     category: 'Financial',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },

  // ── Section 4: Personal History (past 5 years, no gaps) ─────────────────
  { name: 'Personal History – From Date (DD-MM-YYYY)',                                       category: 'Employment',  inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide details of all full-time and part-time employment, self-employment, education, and unemployment for the past 5 years. Include full dates (DD-MM-YYYY). There should be no gaps. Information must match your PR application.' },
  { name: 'Personal History – To Date (DD-MM-YYYY)',                                         category: 'Employment',  inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Occupation / Activity',                                        category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: 'E.g., employment, education, unemployment.' },
  { name: 'Personal History – Company / Education Institute',                                category: 'Employment',  inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Personal History – Unit / Apartment No.',                                         category: 'Employment',  inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Personal History – Street No. and Name',                                          category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – City',                                                         category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Country',                                                      category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Postal Code',                                                  category: 'Employment',  inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // ── Section 5A: Immigration and Citizenship Status History ───────────────
  { name: 'Immigration Status History – Country',                                            category: 'Background',  inputType: 'Short Text', required: 'Mandatory',   helpText: 'List all immigration or citizenship statuses you have ever held in any country (Study, Visitor, Worker, PR, Citizenship), including Canada, your home country, and any other country. Include full dates (DD-MM-YYYY) as per your permit/visa/stamp.' },
  { name: 'Immigration Status History – Status',                                             category: 'Background',  inputType: 'Short Text', required: 'Mandatory',   helpText: 'E.g., Study, Visitor, Worker, PR, Citizenship.' },
  { name: 'Immigration Status History – From Date (DD-MM-YYYY)',                             category: 'Background',  inputType: 'Date',       required: 'Mandatory',   helpText: 'As per your permit, visa, or stamp.' },
  { name: 'Immigration Status History – To Date (DD-MM-YYYY)',                               category: 'Background',  inputType: 'Date',       required: 'Mandatory',   helpText: '' },

  // ── Section 5B: Travel History (past 5 years) ─────────────────────────────
  { name: 'Travel – From Date (DD-MM-YYYY)',                                                 category: 'Travel',      inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide your travel history for the past 5 years (including your home country). Include full dates (DD-MM-YYYY) and your status (Student, Visitor, Worker, Citizen, etc.). Note: if you were outside Canada for 183+ consecutive days in the past 4 years, a Police Clearance Certificate (PCC) may be required.' },
  { name: 'Travel – To Date (DD-MM-YYYY)',                                                   category: 'Travel',      inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Status',                                                                 category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: 'E.g., Student, Visitor, Worker, Citizen.' },
  { name: 'Travel – City',                                                                   category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Country',                                                                category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Purpose of Travelling',                                                  category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 5B: Standalone follow-up fields ──────────────────────────────
  { name: 'List all periods of military service or government positions held (write N/A if none)', category: 'Background', inputType: 'Long Text', required: 'Conditional', helpText: 'Include all military service and government positions. Write N/A if none.' },
  { name: 'List all memberships of associations or organizations (write N/A if none)',        category: 'Background',  inputType: 'Long Text',  required: 'Conditional', helpText: 'List all organizations you belong to or have belonged to. Write N/A if none.' },
  { name: 'List all government positions held such as civil servant, judge, police officer, employee in a security organization (write N/A if none)', category: 'Background', inputType: 'Long Text', required: 'Conditional', helpText: 'Write N/A if none.' },
  { name: 'Military / Government / Organization – Additional Details',                        category: 'Background',  inputType: 'Long Text',  required: 'Conditional', helpText: 'Required if you answered yes to any of the above.' },

  // ── Section 6: Statutory Questions ──────────────────────────────────────
  { name: 'Have you been convicted of a crime or offence in Canada for which a pardon has not been granted?',                                              category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If you answer Yes to any statutory question, please provide complete details in the text area below.' },
  { name: 'Have you ever committed, been arrested for, been charged with or convicted of any criminal offence in any country?',                            category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you made previous claims for refugee protection in Canada or abroad, in any other country, or with the UNHCR?',                            category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa (including CSQ or Provincial Nominee Program) to Canada?',     category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa or visitor or temporary resident visa, to any country?',       category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been refused a visa or permit to Canada?',                                                                                       category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been refused a visa or permit to any other country?',                                                                             category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been denied entry or ordered to leave Canada?',                                                                                   category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been denied entry or ordered to leave any other country?',                                                                        category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Refusal Details – Date of Refusal',                                                                                                            category: 'Legal',       inputType: 'Date',       required: 'Conditional', helpText: 'Required if any of the refusal/denial questions above were answered Yes.' },
  { name: 'Refusal Details – Visa Type',                                                                                                                  category: 'Legal',       inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Refusal Details – Country',                                                                                                                    category: 'Legal',       inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Refusal Details – Number of Refusals',                                                                                                         category: 'Legal',       inputType: 'Number',     required: 'Conditional', helpText: '' },
  { name: 'Have you been involved in an act of genocide, a war crime or a crime against humanity?',                                                        category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you used, planned or advocated the use of armed struggle or violence to reach political, religious or social objectives?',                 category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been associated with a group that used or advocates the use of armed struggle or violence?',                                           category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been a member of an organization engaged in a pattern of criminal activity?',                                                          category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been detained, incarcerated, or put in jail?',                                                                                        category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you had any serious diseases or physical or mental disorder?',                                                                             category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Statutory Questions – Additional Details (if answered Yes to any above)',                                                                       category: 'Legal',       inputType: 'Long Text',  required: 'Conditional', helpText: '' },
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
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
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
