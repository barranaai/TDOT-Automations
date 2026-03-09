/**
 * Bulk import questionnaire template items into Monday.com.
 * Usage: node src/scripts/importQuestionnaireTemplate.js
 */
require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID = '18402113809';
const GROUP_ID = 'group_mm123d40'; // Visitor Extension

// Column IDs
const COLS = {
  questionCode:             'text_mm1235b5',
  primaryCaseType:          'dropdown_mm124p5v',
  questionCategory:         'dropdown_mm12w5fd',
  requiredType:             'dropdown_mm12dqc7',
  inputType:                'dropdown_mm12pn7g',
  checklistTemplateVersion: 'dropdown_mm12spk7',
  helpText:                 'long_text_mm12df2b',
};

// Dropdown label → value for Monday API (use label name directly)
const PRIMARY_CASE_TYPE = 'Visitor Extension';
const VERSION           = 'v1.0';

// Questions definition
// Fields: name, code, category, inputType, requiredType
const QUESTIONS = [
  // ─── Section 1: Personal Details ────────────────────────────────────────────
  { name: 'Family Name (Surname)',                                                    code: 'VVE-P-001', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Given Name',                                                               code: 'VVE-P-002', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever used any other name?',                                       code: 'VVE-P-003', category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, please provide details — Family Name and Given Name.' },
  { name: 'Other Name – Family Name',                                                 code: 'VVE-P-004', category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Other Name – Given Name',                                                  code: 'VVE-P-005', category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Country of Citizenship',                                                   code: 'VVE-P-006', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Current Residence Country',                                                code: 'VVE-P-007', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Status in Current Country (Visitor, Student, Worker, Citizen)',            code: 'VVE-P-008', category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'  },
  { name: 'Native Language',                                                          code: 'VVE-P-009', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Are you a permanent resident of the US with a valid green card?',          code: 'VVE-P-010', category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'  },
  { name: 'Do you have a valid Language test report?',                                code: 'VVE-P-011', category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'  },
  { name: 'Are you a lawful permanent resident of the US with a valid USCIS number?', code: 'VVE-P-012', category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'  },
  { name: 'First Entry to Canada – Date (DD/MM/YYYY)',                                code: 'VVE-P-013', category: 'Personal',    inputType: 'Date',       required: 'Mandatory'  },
  { name: 'First Entry to Canada – Location',                                         code: 'VVE-P-014', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'First Entry to Canada – Status',                                           code: 'VVE-P-015', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Latest Entry to Canada – Date (DD/MM/YYYY)',                               code: 'VVE-P-016', category: 'Personal',    inputType: 'Date',       required: 'Mandatory'  },
  { name: 'Latest Entry to Canada – Location',                                        code: 'VVE-P-017', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Latest Entry to Canada – Status',                                          code: 'VVE-P-018', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Last Application to IRCC – Submission Date',                               code: 'VVE-P-019', category: 'Personal',    inputType: 'Date',       required: 'Mandatory'  },
  { name: 'Last Application to IRCC – Application Type',                              code: 'VVE-P-020', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Last Application to IRCC – Result (Approved / Refused)',                   code: 'VVE-P-021', category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'  },

  // ─── Section 1: Flagged Polling ─────────────────────────────────────────────
  { name: 'Have you ever flagged poled and entered Canada for yourself or friend or family?', code: 'VVE-B-001', category: 'Background', inputType: 'Dropdown',   required: 'Mandatory'  },
  { name: 'Flagged Poling – Date (DD/MM/YYYY)',                                              code: 'VVE-B-002', category: 'Background', inputType: 'Date',       required: 'Conditional' },
  { name: 'Flagged Poling – Location (Border Name)',                                         code: 'VVE-B-003', category: 'Background', inputType: 'Short Text', required: 'Conditional' },
  { name: 'Flagged Poling – Decision (Approved / Refused)',                                  code: 'VVE-B-004', category: 'Background', inputType: 'Dropdown',   required: 'Conditional' },

  // ─── Section 1: Marital Status ───────────────────────────────────────────────
  { name: 'Current Marital Status',                                                   code: 'VVE-P-022', category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'  },
  { name: 'Date of Marriage',                                                         code: 'VVE-P-023', category: 'Personal',    inputType: 'Date',       required: 'Conditional' },
  { name: "Spouse's Family Name",                                                     code: 'VVE-P-024', category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: "Spouse's Given Name",                                                      code: 'VVE-P-025', category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: "Spouse's Date of Birth",                                                   code: 'VVE-P-026', category: 'Personal',    inputType: 'Date',       required: 'Conditional' },
  { name: 'Have you previously been married or in a common-law relationship?',        code: 'VVE-P-027', category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'  },
  { name: 'Previous Partner – Date of Marriage',                                      code: 'VVE-P-028', category: 'Personal',    inputType: 'Date',       required: 'Conditional' },
  { name: 'Previous Partner – Date of Divorce / Separation',                          code: 'VVE-P-029', category: 'Personal',    inputType: 'Date',       required: 'Conditional' },
  { name: 'Previous Partner – Family Name',                                           code: 'VVE-P-030', category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Previous Partner – Given Name',                                            code: 'VVE-P-031', category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Previous Partner – Date of Birth',                                         code: 'VVE-P-032', category: 'Personal',    inputType: 'Date',       required: 'Conditional' },

  // ─── Section 1: Contact Details ─────────────────────────────────────────────
  { name: 'Mobile Number',                                                            code: 'VVE-P-033', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Email Address',                                                            code: 'VVE-P-034', category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Mailing Address',                                                          code: 'VVE-P-035', category: 'Personal',    inputType: 'Long Text',  required: 'Mandatory'  },
  { name: 'Residential Address',                                                      code: 'VVE-P-036', category: 'Personal',    inputType: 'Long Text',  required: 'Mandatory'  },

  // ─── Section 2: Education History ───────────────────────────────────────────
  { name: 'Education – Start Date (DD/MM/YYYY)',                                      code: 'VVE-E-001', category: 'Education',   inputType: 'Date',       required: 'Mandatory'  },
  { name: 'Education – End Date (DD/MM/YYYY)',                                        code: 'VVE-E-002', category: 'Education',   inputType: 'Date',       required: 'Mandatory'  },
  { name: 'Education – Course / Program Name',                                        code: 'VVE-E-003', category: 'Education',   inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Education – Education Institute',                                          code: 'VVE-E-004', category: 'Education',   inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Education – City',                                                         code: 'VVE-E-005', category: 'Education',   inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Education – Country',                                                      code: 'VVE-E-006', category: 'Education',   inputType: 'Short Text', required: 'Mandatory'  },

  // ─── Section 2: Employment History ──────────────────────────────────────────
  { name: 'Employment – Start Date (DD/MM/YYYY)',                                     code: 'VVE-EM-001', category: 'Employment',  inputType: 'Date',       required: 'Mandatory'  },
  { name: 'Employment – End Date (DD/MM/YYYY)',                                       code: 'VVE-EM-002', category: 'Employment',  inputType: 'Date',       required: 'Mandatory'  },
  { name: 'Employment – Job Title',                                                   code: 'VVE-EM-003', category: 'Employment',  inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Employment – Company Name',                                                code: 'VVE-EM-004', category: 'Employment',  inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Employment – City',                                                        code: 'VVE-EM-005', category: 'Employment',  inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Employment – Country',                                                     code: 'VVE-EM-006', category: 'Employment',  inputType: 'Short Text', required: 'Mandatory'  },

  // ─── Section 3: Travel History ───────────────────────────────────────────────
  { name: 'Travel – Start Date (DD/MM/YYYY)',                                         code: 'VVE-T-001', category: 'Travel',      inputType: 'Date',       required: 'Mandatory'  },
  { name: 'Travel – End Date (DD/MM/YYYY)',                                           code: 'VVE-T-002', category: 'Travel',      inputType: 'Date',       required: 'Mandatory'  },
  { name: 'Travel – Status (Student, Visitor, Worker, Citizen, etc.)',                code: 'VVE-T-003', category: 'Travel',      inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Travel – City',                                                            code: 'VVE-T-004', category: 'Travel',      inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Travel – Country',                                                         code: 'VVE-T-005', category: 'Travel',      inputType: 'Short Text', required: 'Mandatory'  },
  { name: 'Travel – Purpose of Travelling',                                           code: 'VVE-T-006', category: 'Travel',      inputType: 'Short Text', required: 'Mandatory'  },

  // ─── Section 4: Statutory Questions ─────────────────────────────────────────
  { name: 'Have you been convicted of a crime or offence in Canada for which a pardon has not been granted?',                                                code: 'VVE-L-001', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you ever committed, been arrested for, been charged with or convicted of any criminal offence in any country?',                              code: 'VVE-L-002', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you made previous claims for refugee protection in Canada or abroad, in any other country, or with the UNHCR?',                              code: 'VVE-L-003', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa (including CSQ or Provincial Nominee Program) to Canada?',       code: 'VVE-L-004', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa or visitor or temporary resident visa, to any country?',         code: 'VVE-L-005', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you ever been refused a visa or permit to Canada?',                                                                                         code: 'VVE-L-006', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you ever been refused a visa or permit to any other country?',                                                                               code: 'VVE-L-007', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you ever been denied entry or ordered to leave Canada?',                                                                                     code: 'VVE-L-008', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you ever been denied entry or ordered to leave any other country?',                                                                          code: 'VVE-L-009', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Refusal Details – Date of Refusal',                                                                                                              code: 'VVE-L-010', category: 'Legal', inputType: 'Date',     required: 'Conditional' },
  { name: 'Refusal Details – Visa Type',                                                                                                                    code: 'VVE-L-011', category: 'Legal', inputType: 'Short Text', required: 'Conditional' },
  { name: 'Refusal Details – Country',                                                                                                                      code: 'VVE-L-012', category: 'Legal', inputType: 'Short Text', required: 'Conditional' },
  { name: 'Refusal Details – Number of Refusals',                                                                                                           code: 'VVE-L-013', category: 'Legal', inputType: 'Number',    required: 'Conditional' },
  { name: 'Have you been involved in an act of genocide, a war crime or a crime against humanity?',                                                          code: 'VVE-L-014', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you used, planned or advocated the use of armed struggle or violence to reach political, religious or social objectives?',                   code: 'VVE-L-015', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you been associated with a group that used or advocates the use of armed struggle or violence?',                                             code: 'VVE-L-016', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you been a member of an organization engaged in a pattern of criminal activity?',                                                            code: 'VVE-L-017', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you been detained, incarcerated, or put in jail?',                                                                                          code: 'VVE-L-018', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Have you had any serious diseases or physical or mental disorder?',                                                                               code: 'VVE-L-019', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory' },
  { name: 'Statutory Questions – Additional Details (if answered Yes to any above)',                                                                         code: 'VVE-L-020', category: 'Legal', inputType: 'Long Text', required: 'Conditional' },
];

async function createItem(question, index, total) {
  const columnValues = JSON.stringify({
    [COLS.questionCode]:             question.code,
    [COLS.primaryCaseType]:          { labels: [PRIMARY_CASE_TYPE] },
    [COLS.questionCategory]:         { labels: [question.category] },
    [COLS.requiredType]:             { labels: [question.required] },
    [COLS.inputType]:                { labels: [question.inputType] },
    [COLS.checklistTemplateVersion]: { labels: [VERSION] },
    ...(question.helpText ? { [COLS.helpText]: { text: question.helpText } } : {}),
  });

  const data = await mondayApi.query(
    `mutation createItem(
      $boardId: ID!,
      $groupId: String!,
      $itemName: String!,
      $columnValues: JSON!
    ) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $columnValues
      ) { id name }
    }`,
    {
      boardId:      BOARD_ID,
      groupId:      GROUP_ID,
      itemName:     question.name,
      columnValues,
    }
  );

  const created = data?.create_item;
  console.log(`[${index + 1}/${total}] ✓ ${question.code} — ${created?.name} (id: ${created?.id})`);
  return created;
}

async function main() {
  console.log(`Starting import of ${QUESTIONS.length} questions into Visitor Extension group...\n`);
  let success = 0;
  let failed = 0;

  for (let i = 0; i < QUESTIONS.length; i++) {
    try {
      await createItem(QUESTIONS[i], i, QUESTIONS.length);
      success++;
      // Small delay to avoid hitting Monday API rate limits
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`[${i + 1}/${QUESTIONS.length}] ✗ ${QUESTIONS[i].code} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nImport complete — ${success} created, ${failed} failed.`);
}

main().catch(console.error);
