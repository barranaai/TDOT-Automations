/**
 * Bulk import Spousal Sponsorship – Inside & Outside – April 2025 questionnaire
 * into "Inland Spousal Sponsorship" and "Outland Spousal Sponsorship" groups.
 *
 * Question naming convention:
 *   - No suffix       → Main Applicant (sponsored spouse)
 *   - (Sponsor)       → Sponsor-only questions (Part 2)
 *   - (Shared)        → Relationship questions for both parties (Part 3)
 *
 * Usage: node src/scripts/importSpousalSponsorshipQuestionnaire.js
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
  { groupId: 'group_mm12ep73', caseType: 'Inland Spousal Sponsorship',  prefix: 'ISS', subType: 'Inland'  },
  { groupId: 'group_mm12pgz2', caseType: 'Outland Spousal Sponsorship', prefix: 'OSS', subType: 'Outland' },
];

// ─── PART 1 — Main Applicant Questions ───────────────────────────────────────

const MAIN_QUESTIONS = [
  // ── Section 1: Personal Details ─────────────────────────────────────────
  { name: 'Email Address',                                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Family Name (Surname)',                                                           category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Given Name',                                                                      category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever used any other name?',                                              category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details.' },
  { name: 'Other Name – Family Name',                                                        category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: 'Required if you have used another name.' },
  { name: 'Other Name – Given Name',                                                         category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Eye Color',                                                                       category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Your height in cm',                                                               category: 'Personal',   inputType: 'Number',     required: 'Mandatory',   helpText: '' },
  { name: 'Mother Tongue',                                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Country of Citizenship',                                                          category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Current Residence Country',                                                       category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'In the last 5 years have you lived in any other country?',                        category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details.' },
  { name: 'Have you taken an English Test?',                                                 category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details.' },
  { name: 'Are you a permanent resident of the US with a valid green card?',                 category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Do you have a Canadian Visa? If Yes, Which one?',                                 category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // ── Section 1: First Entry to Canada ────────────────────────────────────
  { name: 'First Entry to Canada – Date (DD/MM/YYYY)',                                       category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: 'Format: DD/MM/YYYY' },
  { name: 'First Entry to Canada – Location',                                                category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'First Entry to Canada – Status',                                                  category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // ── Section 1: Latest Entry to Canada ───────────────────────────────────
  { name: 'Latest Entry to Canada – Date (DD/MM/YYYY)',                                      category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: 'Format: DD/MM/YYYY' },
  { name: 'Latest Entry to Canada – Location',                                               category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Latest Entry to Canada – Status',                                                 category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // ── Section 1: Flagged Polling ───────────────────────────────────────────
  { name: 'Have you ever flagged poled and entered Canada for yourself or friend or family?', category: 'Background', inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide the details below.' },
  { name: 'Flagged Poling – Date (DD/MM/YYYY)',                                              category: 'Background', inputType: 'Date',       required: 'Conditional', helpText: 'Format: DD/MM/YYYY' },
  { name: 'Flagged Poling – Location (Border Name)',                                         category: 'Background', inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Flagged Poling – Decision (Approved / Refused)',                                  category: 'Background', inputType: 'Dropdown',   required: 'Conditional', helpText: '' },

  // ── Section 1: Marital Status ────────────────────────────────────────────
  { name: 'Current Marital Status',                                                          category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Date of Marriage / Common Law (DD/MM/YYYY)',                                      category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: 'Required if currently married or in a common-law relationship.' },
  { name: "Spouse's Family Name",                                                            category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Given Name",                                                             category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Date of Birth",                                                          category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Have you previously been married or in a common-law relationship?',               category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details of your previous partner.' },
  { name: 'Previous Partner – Date of Marriage / Common Law (DD/MM/YYYY)',                   category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Divorce / Separation (DD/MM/YYYY)',                    category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Family Name',                                                  category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Given Name',                                                   category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Birth',                                                category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },

  // ── Section 2: Contact Details ───────────────────────────────────────────
  { name: 'Mobile Number',                                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Email Address (Contact)',                                                         category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Mailing Address',                                                                 category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },

  // ── Section 2: Address History (10 years) ────────────────────────────────
  { name: 'Address History – From Date (DD/MM/YYYY)',                                        category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: 'List all addresses (inside and outside Canada) for the past 10 years. Include full dates (DD-MM-YYYY). Do not leave any gaps.' },
  { name: 'Address History – To Date (DD/MM/YYYY)',                                          category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Unit / Apartment No.',                                          category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Address History – Street No.',                                                    category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Street Name',                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – City / Town',                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Province / State',                                              category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Country',                                                       category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Postal Code',                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 3: Education Level Summary ──────────────────────────────────
  { name: 'Elementary School (Grade 1–8) – Number of Years',                                 category: 'Education',  inputType: 'Number',     required: 'Mandatory',   helpText: 'Give the number of years of school you successfully completed for each level of education.' },
  { name: 'Secondary School / High School (Grade 9–12) – Number of Years',                   category: 'Education',  inputType: 'Number',     required: 'Mandatory',   helpText: '' },
  { name: 'University / College – Number of Years',                                          category: 'Education',  inputType: 'Number',     required: 'Mandatory',   helpText: '' },
  { name: 'Trade School or Other Post Secondary School – Number of Years',                   category: 'Education',  inputType: 'Number',     required: 'Mandatory',   helpText: '' },

  // ── Section 3: Education Detail ──────────────────────────────────────────
  { name: 'Education – Start Date (DD/MM/YYYY)',                                             category: 'Education',  inputType: 'Date',       required: 'Mandatory',   helpText: 'Include full dates (DD-MM-YYYY). Provide details of your education including High School, College, University or any apprentice training.' },
  { name: 'Education – End Date (DD/MM/YYYY)',                                               category: 'Education',  inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Education – Course / Program Name',                                               category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – Education Institute',                                                 category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – City',                                                                category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Education – Country',                                                             category: 'Education',  inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 4: Personal History (10-year timeline, no gaps) ─────────────
  { name: 'Personal History – Start Date (DD/MM/YYYY)',                                      category: 'Employment', inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide your personal history for the last 10 years including employment, education, and self-employment (Uber, Skip, DoorDash, etc.). There should be no gaps in your timeline.' },
  { name: 'Personal History – End Date (DD/MM/YYYY)',                                        category: 'Employment', inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Job Title / Education',                                        category: 'Employment', inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Company / School Name',                                        category: 'Employment', inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – City and Country',                                             category: 'Employment', inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Personal History – Status (Full-time, Part-time, Student, Unemployed)',           category: 'Employment', inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Have you declared your international experience in any of your previous IRCC applications?', category: 'Employment', inputType: 'Dropdown', required: 'Mandatory', helpText: 'E.g., Study Permit, Work Permit, Visitor Visa, PNP, etc. If No, please provide an explanation.' },

  // ── Section 5: Family – Parents & Spouse ─────────────────────────────────
  { name: 'Parents/Spouse – Full Name (As per Passport)',                                    category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: 'Provide details for father, mother, wife, or husband. If deceased, specify date and city/town of death. If in Canada, mention their immigration status with address.' },
  { name: 'Parents/Spouse – Marital Status',                                                 category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Parents/Spouse – Date of Birth',                                                  category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Parents/Spouse – Country of Birth',                                               category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Parents/Spouse – Full Address',                                                   category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: 'If residing in Canada, include immigration status.' },
  { name: 'Parents/Spouse – Current Occupation (Job Title)',                                 category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: "Father's Family Name at Birth",                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: "Mother's Family Name at Birth",                                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 5: Family – Children ─────────────────────────────────────────
  { name: 'Children – Full Name (As per Passport)',                                          category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: 'Include all sons, daughters, and adopted children. If deceased, specify date and city/town of death. If in Canada, include immigration status and address.' },
  { name: 'Children – Marital Status',                                                       category: 'Personal',   inputType: 'Dropdown',   required: 'Conditional', helpText: '' },
  { name: 'Children – Date of Birth',                                                        category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Children – Country of Birth',                                                     category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Children – Full Address',                                                         category: 'Personal',   inputType: 'Long Text',  required: 'Conditional', helpText: 'If residing in Canada, include immigration status.' },
  { name: 'Children – Current Occupation (Job Title)',                                       category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // ── Section 5: Family – Siblings ─────────────────────────────────────────
  { name: 'Siblings – Full Name (As per Passport)',                                          category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: 'Include brothers and sisters (including half-brothers/sisters and stepbrothers/sisters). If deceased, specify date and city/town of death. If in Canada, include immigration status and address.' },
  { name: 'Siblings – Marital Status',                                                       category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Siblings – Date of Birth',                                                        category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Siblings – Country of Birth',                                                     category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Siblings – Full Address',                                                         category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: 'If residing in Canada, include immigration status.' },
  { name: 'Siblings – Current Occupation (Job Title)',                                       category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 5: Family – Deceased ─────────────────────────────────────────
  { name: 'Deceased – Family Name (As per Passport)',                                        category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased – Given Name',                                                           category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased – Relationship',                                                         category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Deceased – Date of Death',                                                        category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Deceased – City and Country of Death',                                            category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // ── Section 6: Travel History ─────────────────────────────────────────────
  { name: 'Travel – Start Date (DD/MM/YYYY)',                                                category: 'Travel',     inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide your travel history for the past 10 years (including your home country). Include what your status was (Student, Visitor, Worker, Citizen, etc.).' },
  { name: 'Travel – End Date (DD/MM/YYYY)',                                                  category: 'Travel',     inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Status',                                                                 category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: 'E.g., Student, Visitor, Worker, Citizen.' },
  { name: 'Travel – City',                                                                   category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Country',                                                                category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Purpose of Travelling',                                                  category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Background / Admissibility Questions ────────────────────────────────
  { name: 'Within the past two years, have you or a family member had tuberculosis or been in close contact with a person with tuberculosis?',              category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Do you have any physical or mental disorder that would require social and/or health services, other than medication, during a stay in Canada?',  category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever remained beyond the validity of your status, attended school without authorization or worked without authorization in Canada?',    category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever been refused a visa or permit, denied entry or ordered to leave Canada or any other country or territory?',                       category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you previously applied to enter or remain in Canada?',                                                                                    category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever committed, been arrested, been charged with or convicted of any criminal offence in any country or territory?',                   category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Did you serve in any military, militia, or civil defence unit or security organization or police force?',                                       category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Are you or have you ever been a member of any political party or group which has engaged in or advocated violence to achieve political or religious objectives?', category: 'Legal', inputType: 'Dropdown', required: 'Mandatory', helpText: '' },
  { name: 'Have you ever witnessed or participated in the ill treatment of prisoners or civilians, looting or desecration of religious buildings?',         category: 'Legal',      inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Background Questions – Additional Details (if answered Yes to any above)',                                                                      category: 'Legal',      inputType: 'Long Text',  required: 'Conditional', helpText: 'Required if any background question was answered Yes.' },
];

// ─── PART 2 — Sponsor Questions ──────────────────────────────────────────────

const SPONSOR_QUESTIONS = [
  // ── Section 1: Personal Details ─────────────────────────────────────────
  { name: 'Family Name (Surname) (Sponsor)',                                                  category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Given Name (Sponsor)',                                                             category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Have you ever used any other name? (Sponsor)',                                     category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details.' },
  { name: 'Other Name – Family Name (Sponsor)',                                               category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Other Name – Given Name (Sponsor)',                                                category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Have you ever sponsored or are currently sponsoring any other family member? (Sponsor)', category: 'Personal', inputType: 'Dropdown', required: 'Mandatory',   helpText: '' },

  // ── Section 1: Sponsor Marital Status ────────────────────────────────────
  { name: 'Current Marital Status (Sponsor)',                                                 category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Date of Marriage (DD/MM/YYYY) (Sponsor)',                                          category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: "Spouse's Family Name (Sponsor)",                                                   category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Given Name (Sponsor)",                                                    category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: "Spouse's Date of Birth (Sponsor)",                                                 category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Have you previously been married or in a common-law relationship? (Sponsor)',      category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details of your previous partner.' },
  { name: 'Previous Partner – Date of Marriage (DD/MM/YYYY) (Sponsor)',                      category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Divorce / Separation / Death (DD/MM/YYYY) (Sponsor)',  category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Family Name (Sponsor)',                                         category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Given Name (Sponsor)',                                          category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Previous Partner – Date of Birth (Sponsor)',                                       category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },

  // ── Section 1: Sponsor Contact Details ───────────────────────────────────
  { name: 'Mobile Number (Sponsor)',                                                          category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Email Address (Sponsor)',                                                          category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Mailing Address (Sponsor)',                                                        category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Residential Address (Sponsor)',                                                    category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },

  // ── Section 2: Sponsor Address History (5 years) ─────────────────────────
  { name: 'Address History – From Date (DD-MM-YYYY) (Sponsor)',                               category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: 'List all addresses (inside and outside Canada) for the past 5 years. Include full dates (DD-MM-YYYY). Addresses must be consistent with your PR application. No gaps allowed.' },
  { name: 'Address History – To Date (DD-MM-YYYY) (Sponsor)',                                 category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Unit / Apartment No. (Sponsor)',                                 category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Address History – Street No. (Sponsor)',                                           category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Street Name (Sponsor)',                                          category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – City (Sponsor)',                                                 category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Province (Sponsor)',                                             category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Country (Sponsor)',                                              category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Address History – Postal Code (Sponsor)',                                          category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Section 3: Sponsor Education Level Summary ────────────────────────────
  { name: 'Elementary School (Grade 1–8) – Number of Years (Sponsor)',                        category: 'Education',  inputType: 'Number',     required: 'Mandatory',   helpText: '' },
  { name: 'Secondary School / High School (Grade 9–12) – Number of Years (Sponsor)',          category: 'Education',  inputType: 'Number',     required: 'Mandatory',   helpText: '' },
  { name: 'University / College – Number of Years (Sponsor)',                                 category: 'Education',  inputType: 'Number',     required: 'Mandatory',   helpText: '' },
  { name: 'Trade School or Other Post Secondary School – Number of Years (Sponsor)',          category: 'Education',  inputType: 'Number',     required: 'Mandatory',   helpText: '' },

  // ── Section 3: Sponsor Employment History ────────────────────────────────
  { name: 'Employment – Start Date (DD/MM/YYYY) (Sponsor)',                                   category: 'Employment', inputType: 'Date',       required: 'Mandatory',   helpText: 'Include full dates (DD-MM-YYYY). Include all employment for the past 5 years. Information must match your PR application exactly.' },
  { name: 'Employment – End Date (DD/MM/YYYY) (Sponsor)',                                     category: 'Employment', inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Employment – Job Title (Sponsor)',                                                 category: 'Employment', inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Employment – Company Details (Name, Full Address, Telephone) (Sponsor)',           category: 'Employment', inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Employment – Monthly Gross Salary (Sponsor)',                                      category: 'Employment', inputType: 'Number',     required: 'Mandatory',   helpText: 'Use gross amount (before taxes).' },

  // ── Section 4: Sponsor Travel History ────────────────────────────────────
  { name: 'Travel – Start Date (DD/MM/YYYY) (Sponsor)',                                       category: 'Travel',     inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide travel history for the past 10 years (including home country). Include what your status was (Student, Visitor, Worker, Citizen, etc.).' },
  { name: 'Travel – End Date (DD/MM/YYYY) (Sponsor)',                                         category: 'Travel',     inputType: 'Date',       required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Status (Sponsor)',                                                        category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: 'E.g., Student, Visitor, Worker, Citizen.' },
  { name: 'Travel – City (Sponsor)',                                                          category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Country (Sponsor)',                                                       category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Travel – Purpose of Travelling (Sponsor)',                                         category: 'Travel',     inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
];

// ─── PART 3 — Shared Relationship Questions ──────────────────────────────────

const SHARED_QUESTIONS = [
  // ── Communication ────────────────────────────────────────────────────────
  { name: 'What language do you communicate with each other? (Shared)',                       category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'How often do you communicate when you are not together and how? (Shared)',         category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },

  // ── Prior Connection ─────────────────────────────────────────────────────
  { name: 'Was the Sponsor related to you before this relationship? (Shared)',                category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details in the fields below.' },
  { name: 'Sponsor Relation – Family Name (Shared)',                                         category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Sponsor Relation – Given Name (Shared)',                                          category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Sponsor Relation – Date of Birth (DD/MM/YYYY) (Shared)',                          category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Sponsor Relation – Relationship (Shared)',                                        category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },

  // ── Family in Canada ─────────────────────────────────────────────────────
  { name: 'Do you have any family members living in Canada? (Shared)',                        category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If yes, provide details in the fields below.' },
  { name: 'Family in Canada – Family Name (Shared)',                                         category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Family in Canada – Given Name (Shared)',                                          category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Family in Canada – Date of Birth (Shared)',                                       category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Family in Canada – Place of Birth (Shared)',                                      category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Family in Canada – Marital Status (Shared)',                                      category: 'Personal',   inputType: 'Dropdown',   required: 'Conditional', helpText: '' },
  { name: 'Family in Canada – Relationship (Shared)',                                        category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Family in Canada – Current Complete Address (Shared)',                             category: 'Personal',   inputType: 'Long Text',  required: 'Conditional', helpText: '' },

  // ── Relationship Story ───────────────────────────────────────────────────
  { name: 'When was the first time you met in person? (Shared)',                              category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: 'Format: DD/MM/YYYY' },
  { name: 'Describe the circumstances of your first meeting (Shared)',                        category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Did anyone introduce you? If yes, provide details (Shared)',                       category: 'Personal',   inputType: 'Long Text',  required: 'Conditional', helpText: '' },
  { name: 'Did you have any contact before you met in person? If yes, provide details (Shared)', category: 'Personal', inputType: 'Long Text', required: 'Conditional', helpText: 'Include who initiated first contact, date, and method (phone, social media, etc.).' },
  { name: 'Are you living together now? How long? If not, explain why (Shared)',              category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Was your marriage arranged? (Shared)',                                             category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: 'Arranged Marriage – By Whom (Shared)',                                             category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Arranged Marriage – When (DD/MM/YYYY) (Shared)',                                  category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Arranged Marriage – Where (City, Country) (Shared)',                              category: 'Personal',   inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Are you pregnant? (Shared)',                                                       category: 'Personal',   inputType: 'Dropdown',   required: 'Conditional', helpText: '' },
  { name: 'Pregnancy – Due Date (Shared)',                                                    category: 'Personal',   inputType: 'Date',       required: 'Conditional', helpText: 'Required if pregnant.' },

  // ── Visits ───────────────────────────────────────────────────────────────
  { name: 'Visits – From Date (DD/MM/YYYY) (Shared)',                                        category: 'Travel',     inputType: 'Date',       required: 'Conditional', helpText: 'If not living together, provide details of visits to each other during your relationship.' },
  { name: 'Visits – To Date (DD/MM/YYYY) (Shared)',                                          category: 'Travel',     inputType: 'Date',       required: 'Conditional', helpText: '' },
  { name: 'Visits – Who Traveled to Visit Whom? (Shared)',                                   category: 'Travel',     inputType: 'Short Text', required: 'Conditional', helpText: '' },
  { name: 'Visits – Did You Stay Together at the Same Location? (Shared)',                   category: 'Travel',     inputType: 'Dropdown',   required: 'Conditional', helpText: '' },
  { name: 'Visits – Where Did You Stay? (Full Address) (Shared)',                            category: 'Travel',     inputType: 'Long Text',  required: 'Conditional', helpText: '' },

  // ── Relationship Witnesses ────────────────────────────────────────────────
  { name: 'Relationship Witnesses – Family Name (Shared)',                                    category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: 'Provide details of family and friends who know about your relationship.' },
  { name: 'Relationship Witnesses – Given Name (Shared)',                                     category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Relationship Witnesses – Related to Sponsor or Applicant (Shared)',                category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Relationship Witnesses – Relationship (Shared)',                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },
  { name: 'Relationship Witnesses – Date They Met Sponsor or Applicant (DD/MM/YYYY) (Shared)', category: 'Personal', inputType: 'Date',       required: 'Mandatory',   helpText: '' },

  // ── Ceremonies / Events ──────────────────────────────────────────────────
  { name: 'Ceremony – Date (DD/MM/YYYY) (Shared)',                                           category: 'Personal',   inputType: 'Date',       required: 'Mandatory',   helpText: 'Provide details of formal ceremonies or events (Engagement, Traditional Ceremony, Honeymoon, etc.).' },
  { name: 'Ceremony – Description (Shared)',                                                  category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Ceremony – Location (Full Address) (Shared)',                                      category: 'Personal',   inputType: 'Long Text',  required: 'Mandatory',   helpText: '' },
  { name: 'Ceremony – Number of Guests (Shared)',                                             category: 'Personal',   inputType: 'Number',     required: 'Mandatory',   helpText: '' },
  { name: 'Ceremony – Who Performed the Ceremony (Shared)',                                   category: 'Personal',   inputType: 'Short Text', required: 'Mandatory',   helpText: '' },

  // ── Family Participation ─────────────────────────────────────────────────
  { name: "Applicant's Parents Participated in Ceremonies / Events? (Shared)",               category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: 'If not, please explain why in the additional details field.' },
  { name: "Applicant's Other Family Members Participated? (Shared)",                         category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: "Applicant's Children Participated? (Shared)",                                     category: 'Personal',   inputType: 'Dropdown',   required: 'Conditional', helpText: '' },
  { name: "Sponsor's Parents Participated in Ceremonies / Events? (Shared)",                 category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: "Sponsor's Other Family Members Participated? (Shared)",                           category: 'Personal',   inputType: 'Dropdown',   required: 'Mandatory',   helpText: '' },
  { name: "Sponsor's Children Participated? (Shared)",                                       category: 'Personal',   inputType: 'Dropdown',   required: 'Conditional', helpText: '' },
  { name: 'Family Participation – Additional Details (Shared)',                               category: 'Personal',   inputType: 'Long Text',  required: 'Conditional', helpText: "If any family members did not participate, please explain why." },
];

const ALL_QUESTIONS = [...MAIN_QUESTIONS, ...SPONSOR_QUESTIONS, ...SHARED_QUESTIONS];

// ─── Create Item ─────────────────────────────────────────────────────────────

async function createItem({ name, code, category, inputType, required, helpText, groupId, caseType, subType }) {
  const columnValues = JSON.stringify({
    [COLS.questionCode]:             code,
    [COLS.primaryCaseType]:          { labels: [caseType] },
    ...(subType ? { [COLS.caseSubType]: subType } : {}),
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const totalItems = TARGET_GROUPS.length * ALL_QUESTIONS.length;
  console.log(`Importing ${ALL_QUESTIONS.length} questions`);
  console.log(`  ${MAIN_QUESTIONS.length} Main Applicant  |  ${SPONSOR_QUESTIONS.length} Sponsor  |  ${SHARED_QUESTIONS.length} Shared`);
  console.log(`× ${TARGET_GROUPS.length} groups = ${totalItems} items total\n`);

  let overallCreated = 0;
  let overallFailed  = 0;

  for (const group of TARGET_GROUPS) {
    console.log(`\n━━━ ${group.caseType} (${group.prefix}) ━━━`);
    let groupCreated = 0;

    for (let i = 0; i < ALL_QUESTIONS.length; i++) {
      const q    = ALL_QUESTIONS[i];
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
          subType:   group.subType,
        });
        console.log(`  [${i + 1}/${ALL_QUESTIONS.length}] ✓ ${code} — ${result?.name}`);
        groupCreated++;
        overallCreated++;
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        console.error(`  [${i + 1}/${ALL_QUESTIONS.length}] ✗ ${code} — ${err.message}`);
        overallFailed++;
      }
    }

    console.log(`  → ${groupCreated}/${ALL_QUESTIONS.length} created for ${group.caseType}`);
  }

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`Import complete — ${overallCreated} created, ${overallFailed} failed.`);
}

main().catch(console.error);
