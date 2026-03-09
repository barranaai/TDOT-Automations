/**
 * Bulk import Work Permit Inside Canada questionnaire into 5 case type groups.
 * Usage: node src/scripts/importWorkPermitQuestionnaire.js
 */
require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID = '18402113809';
const VERSION  = 'v1.0';

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

// Target groups: { groupId, caseTypeLabel, codePrefix }
const TARGET_GROUPS = [
  { groupId: 'group_mm12pwz4', caseType: 'PGWP',                  prefix: 'PGWP' },
  { groupId: 'group_mm12xza9', caseType: 'SOWP',                  prefix: 'SOWP' },
  { groupId: 'group_mm12cgfa', caseType: 'BOWP',                  prefix: 'BOWP' },
  { groupId: 'group_mm12v89',  caseType: 'LMIA',                  prefix: 'LMIA' },
  { groupId: 'group_mm12e00c', caseType: 'Work Permit Extension',  prefix: 'WPE'  },
];

// Questions: { name, category, inputType, required }
// Code is generated per group using the group prefix
const QUESTIONS = [
  // ─── Section 1: Personal Details ────────────────────────────────────────────
  { name: 'Family Name (Surname)',                                                            category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Given Name',                                                                       category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Have you ever used any other name?',                                               category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Other Name – Family Name',                                                         category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Other Name – Given Name',                                                          category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Country of Citizenship',                                                           category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Current Residence Country',                                                        category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Status in Current Country (Visitor, Student, Worker, Citizen)',                    category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Native Language',                                                                  category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Are you a permanent resident of the US with a valid green card?',                  category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Do you have a valid Language test report?',                                        category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Are you a lawful permanent resident of the US with a valid USCIS number?',         category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'First Entry to Canada – Date (DD/MM/YYYY)',                                        category: 'Personal',    inputType: 'Date',       required: 'Conditional' },
  { name: 'First Entry to Canada – Location',                                                 category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'First Entry to Canada – Status',                                                   category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Latest Entry to Canada – Date (DD/MM/YYYY)',                                       category: 'Personal',    inputType: 'Date',       required: 'Conditional' },
  { name: 'Latest Entry to Canada – Location',                                                category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Latest Entry to Canada – Status',                                                  category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Last Application to IRCC – Submission Date',                                       category: 'Personal',    inputType: 'Date',       required: 'Conditional' },
  { name: 'Last Application to IRCC – Application Type',                                      category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Last Application to IRCC – Result (Approved / Refused)',                           category: 'Personal',    inputType: 'Dropdown',   required: 'Conditional' },

  // ─── Section 1: Flagged Polling ─────────────────────────────────────────────
  { name: 'Have you ever flagged poled and entered Canada for yourself or friend or family?', category: 'Background',  inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Flagged Poling – Date (DD/MM/YYYY)',                                               category: 'Background',  inputType: 'Date',       required: 'Conditional' },
  { name: 'Flagged Poling – Location (Border Name)',                                          category: 'Background',  inputType: 'Short Text', required: 'Conditional' },
  { name: 'Flagged Poling – Decision (Approved / Refused)',                                   category: 'Background',  inputType: 'Dropdown',   required: 'Conditional' },

  // ─── Section 1: Marital Status ───────────────────────────────────────────────
  { name: 'Current Marital Status',                                                           category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Date of Marriage (DD/MM/YYYY)',                                                    category: 'Personal',    inputType: 'Date',       required: 'Conditional' },
  { name: "Spouse's Family Name",                                                             category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: "Spouse's Given Name",                                                              category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: "Spouse's Date of Birth",                                                           category: 'Personal',    inputType: 'Date',       required: 'Conditional' },
  { name: 'Have you previously been married or in a common-law relationship?',                category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Previous Partner – Date of Marriage',                                              category: 'Personal',    inputType: 'Date',       required: 'Conditional' },
  { name: 'Previous Partner – Date of Divorce / Separation',                                  category: 'Personal',    inputType: 'Date',       required: 'Conditional' },
  { name: 'Previous Partner – Family Name',                                                   category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Previous Partner – Given Name',                                                    category: 'Personal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Previous Partner – Date of Birth',                                                 category: 'Personal',    inputType: 'Date',       required: 'Conditional' },

  // ─── Section 1: Contact Details ─────────────────────────────────────────────
  { name: 'Mobile Number',                                                                    category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Email Address',                                                                    category: 'Personal',    inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Mailing Address',                                                                  category: 'Personal',    inputType: 'Long Text',  required: 'Mandatory'   },
  { name: 'Residential Address',                                                              category: 'Personal',    inputType: 'Long Text',  required: 'Mandatory'   },

  // ─── Section 2: Education History ───────────────────────────────────────────
  { name: 'Education – Start Date (DD/MM/YYYY)',                                              category: 'Education',   inputType: 'Date',       required: 'Mandatory'   },
  { name: 'Education – End Date (DD/MM/YYYY)',                                                category: 'Education',   inputType: 'Date',       required: 'Mandatory'   },
  { name: 'Education – Course / Program Name',                                                category: 'Education',   inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Education – Education Institute',                                                  category: 'Education',   inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Education – City',                                                                 category: 'Education',   inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Education – Country',                                                              category: 'Education',   inputType: 'Short Text', required: 'Mandatory'   },

  // ─── Section 2: Employment History ──────────────────────────────────────────
  { name: 'Employment – Start Date (DD/MM/YYYY)',                                             category: 'Employment',  inputType: 'Date',       required: 'Mandatory'   },
  { name: 'Employment – End Date (DD/MM/YYYY)',                                               category: 'Employment',  inputType: 'Date',       required: 'Mandatory'   },
  { name: 'Employment – Job Title',                                                           category: 'Employment',  inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Employment – Company Name',                                                        category: 'Employment',  inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Employment – City',                                                                category: 'Employment',  inputType: 'Short Text', required: 'Mandatory'   },
  { name: 'Employment – Country',                                                             category: 'Employment',  inputType: 'Short Text', required: 'Mandatory'   },

  // ─── International Experience Declaration ────────────────────────────────────
  { name: 'Have you declared your international experience in any of your previous IRCC applications? (If No, provide explanation)', category: 'Employment', inputType: 'Dropdown', required: 'Mandatory' },

  // ─── Section 4: Statutory Questions ─────────────────────────────────────────
  { name: 'Have you been convicted of a crime or offence in Canada for which a pardon has not been granted?',                                               category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you ever committed, been arrested for, been charged with or convicted of any criminal offence in any country?',                             category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you made previous claims for refugee protection in Canada or abroad, in any other country, or with the UNHCR?',                             category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa (including CSQ or Provincial Nominee Program) to Canada?',      category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa or visitor or temporary resident visa, to any country?',        category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you ever been refused a visa or permit to Canada?',                                                                                        category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you ever been refused a visa or permit to any other country?',                                                                              category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you ever been denied entry or ordered to leave Canada?',                                                                                    category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you ever been denied entry or ordered to leave any other country?',                                                                         category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Refusal Details – Date of Refusal',                                                                                                             category: 'Legal',    inputType: 'Date',       required: 'Conditional' },
  { name: 'Refusal Details – Visa Type',                                                                                                                   category: 'Legal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Refusal Details – Country',                                                                                                                     category: 'Legal',    inputType: 'Short Text', required: 'Conditional' },
  { name: 'Refusal Details – Number of Refusals',                                                                                                          category: 'Legal',    inputType: 'Number',     required: 'Conditional' },
  { name: 'Have you been involved in an act of genocide, a war crime or a crime against humanity?',                                                         category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you used, planned or advocated the use of armed struggle or violence to reach political, religious or social objectives?',                  category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you been associated with a group that used or advocates the use of armed struggle or violence?',                                            category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you been a member of an organization engaged in a pattern of criminal activity?',                                                           category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you been detained, incarcerated, or put in jail?',                                                                                         category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Have you had any serious diseases or physical or mental disorder?',                                                                              category: 'Legal',    inputType: 'Dropdown',   required: 'Mandatory'   },
  { name: 'Statutory Questions – Additional Details (if answered Yes to any above)',                                                                        category: 'Legal',    inputType: 'Long Text',  required: 'Conditional' },
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
  const totalItems = TARGET_GROUPS.length * QUESTIONS.length;
  console.log(`Importing ${QUESTIONS.length} questions × ${TARGET_GROUPS.length} groups = ${totalItems} items total\n`);

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
