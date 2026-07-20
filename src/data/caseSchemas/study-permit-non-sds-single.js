/**
 * Case Structure Schema — Study Permit / Non SDS Stream - Single Applicant.
 *
 * Source: Document Checklist Items/Study Permit/Document Checklist- Study Permit - Non SDS Stream- Single Applicant.pdf
 *
 * Same as the SDS base Study Permit MINUS three SDS-only docs on the student:
 * Police certificates (PCC), English Language Test, and GIC. Supporting Family
 * Member list is identical to the SDS base.
 */

'use strict';

const STUDENT_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' } },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'UPFRONTMEDICAL', category: 'Medical',  name: 'Upfront Medical exams' },
  { code: 'RESUME',        category: 'Forms',     name: 'Resume' },
  { code: 'MARKSHEETS',    category: 'Academic',  name: 'All Marksheets and certificates' },
  { code: 'RECOMMENDATION', category: 'Academic', name: 'Recommendation Letters' },
  { code: 'ADMISSION',     category: 'Academic',  name: 'Proof of Admission (LOA, fee receipt, PAL/TAL)' },
  { code: 'SOP',           category: 'Forms',     name: 'Statement of Purpose' },
  { code: 'WORKEXP',       category: 'Financial', name: 'Proof of work experience (highly recommended)' },
];

const SUPPORTER_DOCUMENTS = [
  { code: 'GOVTID',  category: 'Identity',  name: 'Government issued Identity documents' },
  { code: 'INCOME',  category: 'Financial', name: 'Proof/source of Income' },
  { code: 'IACD',    category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'FUNDS',   category: 'Financial', name: 'Proof/source of Income — funds/assets (mandatory)' },
];

module.exports = {
  caseType:      'Study Permit',
  subType:       'Single Applicant',
  schemaVersion: 1,
  source:        'Document Checklist Items/Study Permit/Document Checklist- Study Permit - Non SDS Stream- Single Applicant.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    supporterIncluded: { label: 'A supporting family member is funding the application' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Student)',    required: true, documents: STUDENT_DOCUMENTS },
    { role: 'Sponsor',            label: 'Supporting Family Member (funds)', includeWhen: { caseFlag: 'supporterIncluded' }, documents: SUPPORTER_DOCUMENTS },
  ],
};
