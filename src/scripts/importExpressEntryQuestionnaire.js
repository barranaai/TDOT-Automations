/**
 * Bulk import Express Entry / PNP – PR Application questionnaire (April 2025).
 *
 * Applicant types are separated using the Case Sub Type column:
 *   - Main Applicant
 *   - Spouse
 *   - Child
 *
 * Imported into 4 groups:
 *   - EE after ITA
 *   - Federal PR
 *   - OINP
 *   - NSNP
 *
 * Usage: node src/scripts/importExpressEntryQuestionnaire.js
 */
require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID = '18402113809';
const VERSION  = 'v1.0';

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
  { groupId: 'group_mm125mdm', caseType: 'EE after ITA', prefix: 'EE'   },
  { groupId: 'group_mm12e6e0', caseType: 'Federal PR',   prefix: 'FPR'  },
  { groupId: 'group_mm122xzw', caseType: 'OINP',         prefix: 'OINP' },
  { groupId: 'group_mm1283re', caseType: 'NSNP',         prefix: 'NSNP' },
];

// ── Main Applicant Questions (95) ────────────────────────────────────────────
const MAIN_QUESTIONS = [
  // Section 1 – Personal Details
  { name: 'Family Name (Surname)',                                                                                    category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: 'As per passport.' },
  { name: 'Given Name',                                                                                              category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: 'As per passport.' },
  { name: 'Have you ever used any other name?',                                                                      category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide Family Name and Given Name below.' },
  { name: 'Other Name – Family Name',                                                                                category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: 'Required if you have used another name.' },
  { name: 'Other Name – Given Name',                                                                                 category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Country of Citizenship',                                                                                  category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Current Residence Country',                                                                               category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Current Residential Address',                                                                             category: 'Personal',    inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Current Mailing Address (if different from residential)',                                                 category: 'Personal',    inputType: 'Long Text',  required: 'Conditional', helpText: 'Only required if different from residential address.' },
  { name: 'Height',                                                                                                  category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Eye Color',                                                                                               category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Phone Number',                                                                                            category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Email Address',                                                                                           category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Do you have any siblings in Canada who are Permanent Residents?',                                         category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Do you have an accompanying spouse?',                                                                     category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Do you have dependent children?',                                                                         category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever applied for Express Entry?',                                                                category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'When did you apply for Work Permit (exact dates required)?',                                              category: 'Employment',  inputType: 'Date',       required: 'Conditional', helpText: 'Exact dates required.' },
  { name: 'LinkedIn Profile Link',                                                                                   category: 'Employment',  inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // Section 1 – Flagged Polling
  { name: 'Have you ever flagged poled and entered Canada for yourself or friend or family?',                        category: 'Background',  inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide the details below.' },
  { name: 'Flagged Poling – Date (DD/MM/YYYY)',                                                                     category: 'Background',  inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Flagged Poling – Location (Border Name)',                                                                 category: 'Background',  inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Flagged Poling – Decision (Approved / Refused)',                                                         category: 'Background',  inputType: 'Dropdown',   required: 'Conditional', helpText: '' },

  // Section 1 – Marital Status
  { name: 'Current Marital Status',                                                                                  category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Date of Marriage (DD/MM/YYYY)',                                                                          category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: 'Required if currently married.' },
  { name: "Spouse's Family Name",                                                                                    category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Given Name",                                                                                     category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Date of Birth",                                                                                  category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Have you previously been married or in a common-law relationship?',                                       category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details of your previous partner.' },
  { name: 'Previous Partner – Date of Marriage',                                                                    category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Divorce / Separation',                                                        category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Family Name',                                                                         category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Given Name',                                                                          category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Birth',                                                                       category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },

  // Section 2 – Family Information (Living)
  { name: 'Family Member – Family Name (As per Passport)',                                                          category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: 'Provide details for father, mother, wife/husband, children, and siblings. If residing in Canada, include their immigration status and address.' },
  { name: 'Family Member – Given Name',                                                                             category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – Relationship',                                                                           category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – Date of Birth (DD/MM/YYYY)',                                                            category: 'Personal',    inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – Country of Birth',                                                                       category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – Current City and Country of Residence',                                                  category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: 'If in Canada, include immigration status and address.' },

  // Section 2 – Family Information (Deceased)
  { name: 'Deceased Family Member – Family Name (As per Passport)',                                                 category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: 'Complete this section for any deceased family member.' },
  { name: 'Deceased Family Member – Given Name',                                                                    category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased Family Member – Relationship',                                                                  category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased Family Member – Date of Birth (DD/MM/YYYY)',                                                   category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Deceased Family Member – Date of Death (DD/MM/YYYY)',                                                   category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Deceased Family Member – City and Country of Death',                                                     category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // Section 3 – Address Details (Past 10 Years)
  { name: 'Address – From Date (DD/MM/YYYY)',                                                                       category: 'Personal',    inputType: 'Date',       required: 'Mandatory',   helpText: 'List all addresses inside and outside Canada for the entire 10-year eligibility period. Include full dates (DD-MM-YYYY) with no gaps.' },
  { name: 'Address – To Date (DD/MM/YYYY)',                                                                         category: 'Personal',    inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Address – Unit / Apartment No.',                                                                         category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Address – Street No.',                                                                                    category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address – Street Name',                                                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address – City / Town',                                                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address – Province / State',                                                                              category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address – Country',                                                                                       category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address – Postal Code',                                                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // Section 4 – Education
  { name: 'Education – Start Date (DD/MM/YYYY)',                                                                     category: 'Education',   inputType: 'Date',       required: 'Mandatory',   helpText: 'Include full dates (DD-MM-YYYY). Include College, University, or any apprentice training.' },
  { name: 'Education – End Date (DD/MM/YYYY)',                                                                       category: 'Education',   inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Education – Course / Program Name',                                                                       category: 'Education',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – Education Institute',                                                                         category: 'Education',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – City',                                                                                        category: 'Education',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – Country',                                                                                     category: 'Education',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // Section 5 – Personal History (Past 10 Years)
  { name: 'Personal History – Start Date (DD/MM/YYYY)',                                                              category: 'Employment',  inputType: 'Date',       required: 'Mandatory',   helpText: 'Include all full-time, part-time, foreign work experience, self-employment (Uber, Skip, DoorDash, etc.) and education for the past 10 years. No gaps allowed.' },
  { name: 'Personal History – End Date (DD/MM/YYYY)',                                                                category: 'Employment',  inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Job Title / Education',                                                                category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Company / School Name',                                                                category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – City and Country',                                                                     category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Status (Student, Worker, Citizen)',                                                    category: 'Employment',  inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you declared your international experience in any previous IRCC applications (Study Permit, Work Permit, Visitor Visa, PNP, etc.)? If NO, please provide an explanation.', category: 'Employment', inputType: 'Long Text', required: 'Mandatory', helpText: 'If you answered No, explain why you did not declare your international experience.' },

  // Section 6 – Travel History (Past 10 Years)
  { name: 'Travel – Start Date (DD/MM/YYYY)',                                                                        category: 'Travel',      inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide travel history for the past 10 years (including home country). Include full dates (DD-MM-YYYY) and status. Note: if you were outside Canada for 6+ months in a row, a Police Clearance Certificate (PCC) is required.' },
  { name: 'Travel – End Date (DD/MM/YYYY)',                                                                          category: 'Travel',      inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Status (Student, Visitor, Worker, Citizen)',                                                     category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – City',                                                                                           category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Country',                                                                                        category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Purpose of Travelling',                                                                          category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // Statutory Questions
  { name: 'Have you been convicted of a crime or offence in Canada for which a pardon has not been granted?',                                                              category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If you answer Yes to any statutory question, please provide complete details in the text area below.' },
  { name: 'Have you ever committed, been arrested for, been charged with or convicted of any criminal offence in any country?',                                            category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you made previous claims for refugee protection in Canada or abroad, or with the UNHCR?',                                                                  category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa (including CSQ or Provincial Nominee Program) to Canada?',                     category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa or visitor or temporary resident visa, to any country?',                       category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been refused a visa or permit to Canada?',                                                                                                       category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been refused a visa or permit to any other country?',                                                                                             category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been denied entry or ordered to leave Canada?',                                                                                                   category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been denied entry or ordered to leave any other country?',                                                                                        category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Refusal Details – Date of Refusal',                                                                                                                            category: 'Legal',       inputType: 'Date',       required: 'Conditional', helpText: 'Required if any refusal/denial question was answered Yes.' },
  { name: 'Refusal Details – Visa Type',                                                                                                                                  category: 'Legal',       inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Refusal Details – Country',                                                                                                                                    category: 'Legal',       inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Refusal Details – Number of Refusals',                                                                                                                         category: 'Legal',       inputType: 'Number',     required: 'Conditional', helpText: '' },
  { name: 'Have you been involved in an act of genocide, a war crime or a crime against humanity?',                                                                        category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you used, planned or advocated the use of armed struggle or violence to reach political, religious or social objectives?',                                 category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been associated with a group that used or advocates the use of armed struggle or violence?',                                                           category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been a member of an organization engaged in a pattern of criminal activity?',                                                                          category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been detained, incarcerated, or put in jail?',                                                                                                        category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you had any serious diseases or physical or mental disorder?',                                                                                             category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Statutory Questions – Additional Details (if answered Yes to any above)',                                                                                       category: 'Legal',       inputType: 'Long Text',  required: 'Conditional', helpText: '' },
];

// ── Spouse Questions (93) ────────────────────────────────────────────────────
// Same as Main Applicant with:
//   - LinkedIn Profile Link removed
//   - "When did you enter Canada..." added
//   - "Have you declared international experience..." removed
//   - Deceased family member Date of Birth removed
const SPOUSE_QUESTIONS = [
  // Section 1 – Personal Details
  { name: 'Family Name (Surname)',                                                                                    category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: 'As per passport.' },
  { name: 'Given Name',                                                                                              category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: 'As per passport.' },
  { name: 'Have you ever used any other name?',                                                                      category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide Family Name and Given Name below.' },
  { name: 'Other Name – Family Name',                                                                                category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: 'Required if you have used another name.' },
  { name: 'Other Name – Given Name',                                                                                 category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Country of Citizenship',                                                                                  category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Current Residence Country',                                                                               category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Current Residential Address',                                                                             category: 'Personal',    inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Current Mailing Address (if different from residential)',                                                 category: 'Personal',    inputType: 'Long Text',  required: 'Conditional', helpText: 'Only required if different from residential address.' },
  { name: 'Height',                                                                                                  category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Eye Color',                                                                                               category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Phone Number',                                                                                            category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Email Address',                                                                                           category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Do you have any siblings in Canada who are Permanent Residents?',                                         category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Do you have an accompanying spouse?',                                                                     category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Do you have dependent children?',                                                                         category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever applied for Express Entry?',                                                                category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'When did you apply for Work Permit (exact dates required)?',                                              category: 'Employment',  inputType: 'Date',       required: 'Conditional', helpText: 'Exact dates required.' },
  { name: 'When did you enter Canada for the first time? What was the reason?',                                      category: 'Travel',      inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },

  // Section 1 – Flagged Polling
  { name: 'Have you ever flagged poled and entered Canada for yourself or friend or family?',                        category: 'Background',  inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide the details below.' },
  { name: 'Flagged Poling – Date (DD/MM/YYYY)',                                                                     category: 'Background',  inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Flagged Poling – Location (Border Name)',                                                                 category: 'Background',  inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Flagged Poling – Decision (Approved / Refused)',                                                         category: 'Background',  inputType: 'Dropdown',   required: 'Conditional', helpText: '' },

  // Section 1 – Marital Status
  { name: 'Current Marital Status',                                                                                  category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Date of Marriage (DD/MM/YYYY)',                                                                          category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: 'Required if currently married.' },
  { name: "Spouse's Family Name",                                                                                    category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Given Name",                                                                                     category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Date of Birth",                                                                                  category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Have you previously been married or in a common-law relationship?',                                       category: 'Personal',    inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details of your previous partner.' },
  { name: 'Previous Partner – Date of Marriage',                                                                    category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Divorce / Separation',                                                        category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Family Name',                                                                         category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Given Name',                                                                          category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Birth',                                                                       category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },

  // Section 2 – Family Information (Living)
  { name: 'Family Member – Family Name (As per Passport)',                                                          category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: 'Provide details for father, mother, wife/husband, children, and siblings. If residing in Canada, include their immigration status and address.' },
  { name: 'Family Member – Given Name',                                                                             category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – Relationship',                                                                           category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – Date of Birth (DD/MM/YYYY)',                                                            category: 'Personal',    inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – Country of Birth',                                                                       category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Family Member – City and Country of Residence',                                                         category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: 'If in Canada, include immigration status and address.' },

  // Section 2 – Family Information (Deceased) — Spouse version has no Date of Birth column
  { name: 'Deceased Family Member – Family Name (As per Passport)',                                                 category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: 'Complete this section for any deceased family member.' },
  { name: 'Deceased Family Member – Given Name',                                                                    category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased Family Member – Relationship',                                                                  category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased Family Member – Date of Death (DD/MM/YYYY)',                                                   category: 'Personal',    inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Deceased Family Member – City and Country of Death',                                                     category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // Section 3 – Address Details (Past 10 Years)
  { name: 'Address – From Date (DD/MM/YYYY)',                                                                       category: 'Personal',    inputType: 'Date',       required: 'Mandatory',   helpText: 'List all addresses inside and outside Canada for the entire 10-year eligibility period. Include full dates (DD-MM-YYYY) with no gaps.' },
  { name: 'Address – To Date (DD/MM/YYYY)',                                                                         category: 'Personal',    inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Address – Unit / Apartment No.',                                                                         category: 'Personal',    inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Address – Street No.',                                                                                    category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address – Street Name',                                                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address – City / Town',                                                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address – Province / State',                                                                              category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address – Country',                                                                                       category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address – Postal Code',                                                                                   category: 'Personal',    inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // Section 4 – Education
  { name: 'Education – Start Date (DD/MM/YYYY)',                                                                     category: 'Education',   inputType: 'Date',       required: 'Mandatory',   helpText: 'Include full dates (DD-MM-YYYY). Include College, University, or any apprentice training.' },
  { name: 'Education – End Date (DD/MM/YYYY)',                                                                       category: 'Education',   inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Education – Course / Program Name',                                                                       category: 'Education',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – Education Institute',                                                                         category: 'Education',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – City',                                                                                        category: 'Education',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – Country',                                                                                     category: 'Education',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // Section 5 – Personal History (Past 10 Years)
  { name: 'Personal History – Start Date (DD/MM/YYYY)',                                                              category: 'Employment',  inputType: 'Date',       required: 'Mandatory',   helpText: 'Include all full-time, part-time, foreign work experience, self-employment, and education for the past 10 years. No gaps allowed.' },
  { name: 'Personal History – End Date (DD/MM/YYYY)',                                                                category: 'Employment',  inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Job Title / Education',                                                                category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Company / School Name',                                                                category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – City and Country',                                                                     category: 'Employment',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Status (Student, Worker, Citizen)',                                                    category: 'Employment',  inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },

  // Section 6 – Travel History (Past 10 Years)
  { name: 'Travel – Start Date (DD/MM/YYYY)',                                                                        category: 'Travel',      inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide travel history for the past 10 years (including home country). Note: if you were outside Canada for 6+ months in a row, a Police Clearance Certificate (PCC) is required.' },
  { name: 'Travel – End Date (DD/MM/YYYY)',                                                                          category: 'Travel',      inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Status (Student, Visitor, Worker, Citizen)',                                                     category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – City',                                                                                           category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Country',                                                                                        category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Purpose of Travelling',                                                                          category: 'Travel',      inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // Statutory Questions (identical to Main Applicant)
  { name: 'Have you been convicted of a crime or offence in Canada for which a pardon has not been granted?',                                                              category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If you answer Yes to any statutory question, please provide complete details in the text area below.' },
  { name: 'Have you ever committed, been arrested for, been charged with or convicted of any criminal offence in any country?',                                            category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you made previous claims for refugee protection in Canada or abroad, or with the UNHCR?',                                                                  category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa (including CSQ or Provincial Nominee Program) to Canada?',                     category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been refused refugee status, or an immigrant or permanent resident visa or visitor or temporary resident visa, to any country?',                       category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been refused a visa or permit to Canada?',                                                                                                       category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been refused a visa or permit to any other country?',                                                                                             category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been denied entry or ordered to leave Canada?',                                                                                                   category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been denied entry or ordered to leave any other country?',                                                                                        category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Refusal Details – Date of Refusal',                                                                                                                            category: 'Legal',       inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Refusal Details – Visa Type',                                                                                                                                  category: 'Legal',       inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Refusal Details – Country',                                                                                                                                    category: 'Legal',       inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Refusal Details – Number of Refusals',                                                                                                                         category: 'Legal',       inputType: 'Number',     required: 'Conditional', helpText: '' },
  { name: 'Have you been involved in an act of genocide, a war crime or a crime against humanity?',                                                                        category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you used, planned or advocated the use of armed struggle or violence to reach political, religious or social objectives?',                                 category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been associated with a group that used or advocates the use of armed struggle or violence?',                                                           category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been a member of an organization engaged in a pattern of criminal activity?',                                                                          category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you been detained, incarcerated, or put in jail?',                                                                                                        category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you had any serious diseases or physical or mental disorder?',                                                                                             category: 'Legal',       inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Statutory Questions – Additional Details (if answered Yes to any above)',                                                                                       category: 'Legal',       inputType: 'Long Text',  required: 'Conditional', helpText: '' },
];

// ── Child Questions (15) ─────────────────────────────────────────────────────
const CHILD_QUESTIONS = [
  // Personal Details
  { name: 'Family Name',                                            category: 'Personal',   inputType: 'Short Text', required: 'Mandatory', helpText: '' },
  { name: 'Given Name',                                             category: 'Personal',   inputType: 'Short Text', required: 'Mandatory', helpText: '' },
  { name: 'Date of Birth',                                          category: 'Personal',   inputType: 'Date',       required: 'Mandatory', helpText: '' },
  { name: 'Eye Colour',                                             category: 'Personal',   inputType: 'Short Text', required: 'Mandatory', helpText: '' },
  { name: 'Height',                                                 category: 'Personal',   inputType: 'Short Text', required: 'Mandatory', helpText: '' },
  { name: 'Native Language',                                        category: 'Personal',   inputType: 'Short Text', required: 'Mandatory', helpText: '' },
  { name: 'City and Country of Birth',                              category: 'Personal',   inputType: 'Short Text', required: 'Mandatory', helpText: '' },
  { name: 'Country of Citizenship',                                 category: 'Personal',   inputType: 'Short Text', required: 'Mandatory', helpText: '' },
  { name: 'Current Residence Country',                              category: 'Personal',   inputType: 'Short Text', required: 'Mandatory', helpText: '' },

  // Section 5 – Personal History
  { name: 'Personal History – Start Date (DD/MM/YYYY)',             category: 'Employment', inputType: 'Date',       required: 'Mandatory', helpText: 'Include employment, education, and unemployment. No gaps in timeline.' },
  { name: 'Personal History – End Date (DD/MM/YYYY)',               category: 'Employment', inputType: 'Date',       required: 'Mandatory', helpText: '' },
  { name: 'Personal History – Job Title / Education',               category: 'Employment', inputType: 'Short Text', required: 'Mandatory', helpText: '' },
  { name: 'Personal History – Company / School Name',               category: 'Employment', inputType: 'Short Text', required: 'Mandatory', helpText: '' },
  { name: 'Personal History – City and Country',                    category: 'Employment', inputType: 'Short Text', required: 'Mandatory', helpText: '' },
  { name: 'Personal History – Status (Student, Worker, Citizen)',   category: 'Employment', inputType: 'Dropdown',   required: 'Mandatory', helpText: '' },
];

const APPLICANT_SETS = [
  { questions: MAIN_QUESTIONS,   subType: 'Main Applicant', subPrefix: 'M'  },
  { questions: SPOUSE_QUESTIONS, subType: 'Spouse',         subPrefix: 'SP' },
  { questions: CHILD_QUESTIONS,  subType: 'Child',          subPrefix: 'C'  },
];

async function createItem({ name, code, category, inputType, required, helpText, groupId, caseType, subType }) {
  const columnValues = JSON.stringify({
    [COLS.questionCode]:             code,
    [COLS.primaryCaseType]:          { labels: [caseType] },
    [COLS.caseSubType]:              subType,
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
  const totalPerGroup = APPLICANT_SETS.reduce((s, a) => s + a.questions.length, 0);
  const totalItems    = totalPerGroup * TARGET_GROUPS.length;
  console.log(`Importing ${totalPerGroup} questions × ${TARGET_GROUPS.length} groups = ${totalItems} total items\n`);

  let overallCreated = 0;
  let overallFailed  = 0;

  for (const group of TARGET_GROUPS) {
    console.log(`\n${'━'.repeat(55)}`);
    console.log(`GROUP: ${group.caseType} (${group.prefix})`);

    for (const set of APPLICANT_SETS) {
      console.log(`\n  ── ${set.subType} (${set.questions.length} questions) ──`);

      for (let i = 0; i < set.questions.length; i++) {
        const q    = set.questions[i];
        const code = `${group.prefix}-${set.subPrefix}-${String(i + 1).padStart(3, '0')}`;

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
            subType:   set.subType,
          });
          console.log(`    [${i + 1}/${set.questions.length}] ✓ ${code} — ${result?.name}`);
          overallCreated++;
          await new Promise((r) => setTimeout(r, 250));
        } catch (err) {
          console.error(`    [${i + 1}/${set.questions.length}] ✗ ${code} — ${err.message}`);
          overallFailed++;
        }
      }
    }
  }

  console.log(`\n${'━'.repeat(55)}`);
  console.log(`Import complete — ${overallCreated} created, ${overallFailed} failed.`);
}

main().catch(console.error);
