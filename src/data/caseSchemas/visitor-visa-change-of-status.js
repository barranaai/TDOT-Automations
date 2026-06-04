/**
 * Case Structure Schema — Visitor Visa / Change of Status (Student/Worker to Visitor).
 *
 * Source: Document Checklist Items/Visitor/Document Checklist- Visitor Visa- Change of Status (from student or worker).pdf
 *
 * For someone already in Canada changing status to visitor — NO inviter role.
 * PA + optional dependent applicant (Spouse), each with the same 9-doc list.
 */

'use strict';

const PA_SPOUSE_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' } },
  { code: 'CURSTATUS',     category: 'Identity',  name: 'Current Status in the country (study/work permits ever held)' },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'INCOME',        category: 'Financial', name: 'Proof/source of Income' },
  { code: 'FINDOCS',       category: 'Financial', name: 'Financial Documents' },
  { code: 'POLC',          category: 'Other',     name: 'Proof of living in Canada (any 1)' },
];

module.exports = {
  caseType:      'Visitor Visa',
  subType:       'Change of Status (Student/Worker to Visitor)',
  schemaVersion: 1,
  source:        'Document Checklist Items/Visitor/Document Checklist- Visitor Visa- Change of Status (from student or worker).pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    spouseIncluded: { label: 'A dependent spouse is also changing status' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: PA_SPOUSE_DOCUMENTS },
    { role: 'Spouse',             label: 'Dependent Applicant',  includeWhen: { caseFlag: 'spouseIncluded' }, documents: PA_SPOUSE_DOCUMENTS },
  ],
};
