/**
 * Case Structure Schema — Study Permit (SDS Stream, Single Applicant, Outland).
 *
 * Source: Document Checklist Items/Study Permit/Document Checklist- Study Permit - Single Applicant.pdf
 * Mapped as caseType 'Study Permit' with no sub-type (the base study permit).
 *
 * Two roles:
 *   - PrincipalApplicant (the student) — required, 16 docs.
 *   - Sponsor (Supporting Family Member / financial backer) — conditional; a
 *     student may self-fund (GIC + own funds), so it only seeds when a
 *     supporter is involved.
 *
 * Team-review note: confirm whether the Supporting Family Member should be
 * required vs conditional for your typical SDS cases.
 */

'use strict';

const STUDENT_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' } },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents (incl. Birth Certificate)' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'UPFRONTMEDICAL', category: 'Medical',  name: 'Upfront Medical exams' },
  { code: 'PCC',           category: 'Background', name: 'Police certificates (PCC)' },
  { code: 'LANGUAGETEST',  category: 'Academic',  name: 'English Language Test Report' },
  { code: 'RESUME',        category: 'Forms',     name: 'Resume' },
  { code: 'MARKSHEETS',    category: 'Academic',  name: 'All Marksheets and certificates' },
  { code: 'RECOMMENDATION', category: 'Academic', name: 'Recommendation Letters' },
  { code: 'ADMISSION',     category: 'Academic',  name: 'Proof of Admission (LOA, fee receipt, PAL/TAL)' },
  { code: 'GIC',           category: 'Financial', name: 'Guaranteed Investment Certificate (GIC)' },
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
  subType:       '',
  schemaVersion: 1,
  source:        'Document Checklist Items/Study Permit/Document Checklist- Study Permit - Single Applicant.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    supporterIncluded: { label: 'A supporting family member is funding the application' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Student)',     required: true, documents: STUDENT_DOCUMENTS },
    { role: 'Sponsor',            label: 'Supporting Family Member (funds)',  includeWhen: { caseFlag: 'supporterIncluded' }, documents: SUPPORTER_DOCUMENTS },
  ],
};
