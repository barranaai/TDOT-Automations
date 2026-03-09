/**
 * Bulk import Super Visa – Outside Canada questionnaire (April 2025) into
 * the "Supervisa" group on the Questionnaire Template Board.
 *
 * Usage: node src/scripts/importSuperVisaQuestionnaire.js
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
  { groupId: 'group_mm12ard', caseType: 'Supervisa', prefix: 'SV' },
];

const QUESTIONS = [
  // ── Section 1: Personal Details ─────────────────────────────────────────
  { name: 'Family Name (Surname)',                                                           category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Given Name',                                                                      category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever used any other name?',                                              category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide: Family Name and Given Name of other name(s) used.' },
  { name: 'Other Name – Family Name',                                                        category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: 'Required if you have used another name.' },
  { name: 'Other Name – Given Name',                                                         category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Country of Citizenship',                                                          category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Current Residence Country',                                                       category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Status in Current Country (Visitor, Student, Worker, Citizen)',                   category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'E.g., Visitor, Student, Worker, Citizen.' },
  { name: 'Native Language',                                                                 category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Are you a permanent resident of the US with a valid green card?',                 category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Do you have a Canadian Visa? If Yes, Which one?',                                 category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'First Entry to Canada – Date (DD/MM/YYYY)',                                       category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: 'Format: DD/MM/YYYY' },
  { name: 'First Entry to Canada – Location',                                                category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'First Entry to Canada – Status',                                                  category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Latest Entry to Canada – Date (DD/MM/YYYY)',                                      category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: 'Format: DD/MM/YYYY' },
  { name: 'Latest Entry to Canada – Location',                                               category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Latest Entry to Canada – Status',                                                 category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Last Application to IRCC – Submission Date',                                      category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Last Application to IRCC – Application Type',                                     category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Last Application to IRCC – Result (Approved / Refused)',                          category: 'Personal',   inputType: 'Dropdown',   required: 'Conditional', helpText: '' },

  // ── Section 1: Flagged Polling ───────────────────────────────────────────
  { name: 'Have you ever flagged poled and entered Canada for yourself or friend or family?', category: 'Background', inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide the details below.' },
  { name: 'Flagged Poling – Date (DD/MM/YYYY)',                                              category: 'Background', inputType: 'Date',       required: 'Conditional', helpText: 'Format: DD/MM/YYYY' },
  { name: 'Flagged Poling – Location (Border Name)',                                         category: 'Background', inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Flagged Poling – Decision (Approved / Refused)',                                  category: 'Background', inputType: 'Dropdown',   required: 'Conditional', helpText: '' },

  // ── Section 1: Marital Status ────────────────────────────────────────────
  { name: 'Current Marital Status',                                                          category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Date of Marriage (DD/MM/YYYY)',                                                   category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: 'Required if currently married.' },
  { name: "Spouse's Family Name",                                                            category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: 'Required if currently married.' },
  { name: "Spouse's Given Name",                                                             category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: 'Required if currently married.' },
  { name: "Spouse's Date of Birth",                                                          category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: 'Required if currently married.' },
  { name: 'Have you previously been married or in a common-law relationship?',               category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details of your previous partner.' },
  { name: 'Previous Partner – Date of Marriage',                                             category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Divorce / Separation / Death',                         category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Family Name',                                                  category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Given Name',                                                   category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Birth',                                                category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },

  // ── Section 1: Contact Details ───────────────────────────────────────────
  { name: 'Mobile Number',                                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Email Address',                                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Mailing Address',                                                                 category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Residential Address',                                                             category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },

  // ── Section 2: Purpose of Visit ──────────────────────────────────────────
  { name: 'Purpose of Visit',                                                                category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Planned Stay – From Date (DD/MM/YYYY)',                                           category: 'Travel',     inputType: 'Date',       required: 'Mandatory',   helpText: 'Format: DD/MM/YYYY' },
  { name: 'Planned Stay – To Date (DD/MM/YYYY)',                                             category: 'Travel',     inputType: 'Date',       required: 'Mandatory',   helpText: 'Format: DD/MM/YYYY' },
  { name: 'Sponsor 1 – Name',                                                                category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: 'The child or grandchild in Canada who is inviting you.' },
  { name: 'Sponsor 1 – Relationship',                                                        category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Sponsor 1 – Full Address in Canada',                                              category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Sponsor 2 – Name',                                                                category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Sponsor 2 – Relationship',                                                        category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Sponsor 2 – Full Address in Canada',                                              category: 'Personal',   inputType: 'Long Text',  required: 'Conditional', helpText: '' },

  // ── Section 2: Education History ─────────────────────────────────────────
  { name: 'Education – Start Date (DD/MM/YYYY)',                                             category: 'Education',  inputType: 'Date',       required: 'Mandatory',   helpText: 'Include full dates (DD-MM-YYYY). Provide details of your education including College, University or any apprentice training.' },
  { name: 'Education – End Date (DD/MM/YYYY)',                                               category: 'Education',  inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Education – Course / Program Name',                                               category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – Education Institute',                                                 category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – City',                                                                category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – Country',                                                             category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 2: Employment History (full — not capped at 3) ───────────────
  { name: 'Employment – Start Date (DD/MM/YYYY)',                                            category: 'Employment', inputType: 'Date',       required: 'Mandatory',   helpText: 'Include full dates (DD-MM-YYYY). Include all part-time, full-time, foreign work experience, and self-employment (Uber, Skip, DoorDash, etc.).' },
  { name: 'Employment – End Date (DD/MM/YYYY)',                                              category: 'Employment', inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Employment – Job Title',                                                          category: 'Employment', inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Employment – Company Name',                                                       category: 'Employment', inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Employment – City',                                                               category: 'Employment', inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Employment – Country',                                                            category: 'Employment', inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 3: Travel History (past 10 years) ─────────────────────────────
  { name: 'Travel – Start Date (DD/MM/YYYY)',                                                category: 'Travel',     inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide your travel history for the past 10 years (including your home country). Include full dates (DD-MM-YYYY) and what your status was (Student, Visitor, Worker, Citizen, etc.).' },
  { name: 'Travel – End Date (DD/MM/YYYY)',                                                  category: 'Travel',     inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Status',                                                                 category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: 'E.g., Student, Visitor, Worker, Citizen.' },
  { name: 'Travel – City',                                                                   category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Country',                                                                category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Purpose of Travelling',                                                  category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 4: Family – Parents & Spouse ─────────────────────────────────
  { name: 'Parents/Spouse – Full Name (As per Passport)',                                    category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: 'Provide details for father, mother, wife, or husband. If deceased, specify date and city/town of death. If in Canada, mention their immigration status with address.' },
  { name: 'Parents/Spouse – Marital Status',                                                 category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Parents/Spouse – Date of Birth',                                                  category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Parents/Spouse – Country of Birth',                                               category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Parents/Spouse – Full Address',                                                   category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: 'If residing in Canada, include immigration status.' },
  { name: 'Parents/Spouse – Current Occupation (Job Title)',                                 category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 4: Family – Children ─────────────────────────────────────────
  { name: 'Children – Full Name (As per Passport)',                                          category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: 'Include all sons, daughters, and adopted children. If deceased, specify date and city/town of death. If in Canada, include immigration status and address.' },
  { name: 'Children – Marital Status',                                                       category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Children – Date of Birth',                                                        category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Children – Country of Birth',                                                     category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Children – Full Address',                                                         category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: 'If residing in Canada, include immigration status.' },
  { name: 'Children – Current Occupation (Job Title)',                                       category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 4: Family – Siblings ─────────────────────────────────────────
  { name: 'Siblings – Full Name (As per Passport)',                                          category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: 'Include brothers and sisters (including half-brothers/sisters and stepbrothers/sisters). If deceased, specify date and city/town of death. If in Canada, include immigration status and address.' },
  { name: 'Siblings – Marital Status',                                                       category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Siblings – Date of Birth',                                                        category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Siblings – Country of Birth',                                                     category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Siblings – Full Address',                                                         category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: 'If residing in Canada, include immigration status.' },
  { name: 'Siblings – Current Occupation (Job Title)',                                       category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 4: Family – Deceased ─────────────────────────────────────────
  { name: 'Deceased – Family Name (As per Passport)',                                        category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased – Given Name',                                                           category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased – Relationship',                                                         category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased – Date of Death',                                                        category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Deceased – City and Country of Death',                                            category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // ── Section 4: Statutory Questions ──────────────────────────────────────
  { name: 'Have you been convicted of a crime or offence in Canada for which a pardon has not been granted?',                                              category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If you answer Yes to any statutory question, please provide complete details in the text area below.' },
  { name: 'Have you ever committed, been arrested for, been charged with or convicted of any criminal offence in any country?',                            category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you made previous claims for refugee protection in Canada or abroad, in any other country, or with the UNHCR?',                            category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa (including CSQ or Provincial Nominee Program) to Canada?',     category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa or visitor or temporary resident visa, to any country?',       category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been refused a visa or permit to Canada?',                                                                                       category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been refused a visa or permit to any other country?',                                                                             category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been denied entry or ordered to leave Canada?',                                                                                   category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been denied entry or ordered to leave any other country?',                                                                        category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Refusal Details – Date of Refusal',                                                                                                            category: 'Legal',      inputType: 'Date',       required: 'Conditional', helpText: 'Required if any of the refusal/denial questions above were answered Yes.' },
  { name: 'Refusal Details – Visa Type',                                                                                                                  category: 'Legal',      inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Refusal Details – Country',                                                                                                                    category: 'Legal',      inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Refusal Details – Number of Refusals',                                                                                                         category: 'Legal',      inputType: 'Number',     required: 'Conditional', helpText: '' },
  { name: 'Have you been involved in an act of genocide, a war crime or a crime against humanity?',                                                        category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you used, planned or advocated the use of armed struggle or violence to reach political, religious or social objectives?',                 category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been associated with a group that used or advocates the use of armed struggle or violence?',                                           category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been a member of an organization engaged in a pattern of criminal activity?',                                                          category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been detained, incarcerated, or put in jail?',                                                                                        category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you had any serious diseases or physical or mental disorder?',                                                                             category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Statutory Questions – Additional Details (if answered Yes to any above)',                                                                       category: 'Legal',      inputType: 'Long Text',  required: 'Conditional', helpText: '' },
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
