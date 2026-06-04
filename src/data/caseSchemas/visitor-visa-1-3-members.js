/**
 * Case Structure Schema — Visitor Visa / 1-3 Members.
 *
 * Source: Document Checklist Items/Visitor/Document Checklist- Visitor Visa-  1,2 or 3 members.pdf
 *
 * Same as Visitor Visa/1-2 Members (PA + optional Spouse + required Inviter)
 * PLUS a Dependent Child role (PDF pp.3-4), conditional and multiple-allowed.
 *
 * Team-review note: Inviter marked required (standard PDF section). Child's
 * "if student" academics row is included as one row — client uploads if it
 * applies.
 */

'use strict';

const PA_SPOUSE_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' } },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents' },
  { code: 'INCOME',        category: 'Financial', name: 'Proof/source of Income' },
  { code: 'FINDOCS',       category: 'Financial', name: 'Financial Documents' },
];

const CHILD_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents' },
  { code: 'STUDENTDOCS',   category: 'Other',     name: 'If student: academic documents (marksheets, enrolment letter, school ID)' },
  { code: 'BIRTHCERT',     category: 'Identity',  name: 'Birth Certificate' },
  { code: 'SUPPORTAFFIDAVIT', category: 'Financial', name: 'Support Affidavit' },
];

const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',  category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'CURSTATUS', category: 'Identity',  name: 'Current Status in the country' },
  { code: 'RELPROOF',  category: 'Other',     name: 'Proof of Relationship' },
  { code: 'IACD',      category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'POLC',      category: 'Other',     name: 'Proof of living in Canada (any 1)' },
  { code: 'INCOME',    category: 'Financial', name: 'Proof/source of Income' },
  { code: 'FUNDS',     category: 'Financial', name: 'Additional proof of Funds/investments/assets' },
];

module.exports = {
  caseType:      'Visitor Visa',
  subType:       '1-3 Members',
  schemaVersion: 1,
  source:        'Document Checklist Items/Visitor/Document Checklist- Visitor Visa-  1,2 or 3 members.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    spouseIncluded:   { label: 'A dependent spouse is also applying' },
    childrenIncluded: { label: 'One or more dependent children are applying' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant',  required: true, documents: PA_SPOUSE_DOCUMENTS },
    { role: 'Spouse',             label: 'Dependent Spouse',     includeWhen: { caseFlag: 'spouseIncluded' }, documents: PA_SPOUSE_DOCUMENTS },
    { role: 'DependentChild',     label: 'Dependent Child',      includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: CHILD_DOCUMENTS },
    { role: 'Sponsor',            label: 'Inviter (in Canada)',  required: true, documents: SPONSOR_DOCUMENTS },
  ],
};
