/**
 * Case Structure Schema — Visitor Visa / Parents & Siblings.
 *
 * Source: Document Checklist Items/Visitor/Document Checklist- Visitor Visa-  Parents and siblings.pdf
 *
 * Parents (PA + optional second parent) + optional Sibling(s) + required
 * Inviter. Sibling role has its own 9-doc list. Inviter uses Birth Certificate.
 */

'use strict';

const PARENT_DOCUMENTS = [
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

const SIBLING_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' } },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents' },
  { code: 'INCOME',        category: 'Financial', name: 'Proof/source of Income (incl. academic docs if student)' },
  { code: 'BIRTHCERT',     category: 'Identity',  name: 'Birth Certificate' },
  { code: 'SUPPORTAFFIDAVIT', category: 'Financial', name: 'Support Affidavit' },
];

const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',  category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'CURSTATUS', category: 'Identity',  name: 'Current Status in the country' },
  { code: 'BIRTHCERT', category: 'Identity',  name: 'Birth Certificate (proves relationship)' },
  { code: 'IACD',      category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'POLC',      category: 'Other',     name: 'Proof of living in Canada (any 1)' },
  { code: 'INCOME',    category: 'Financial', name: 'Proof/source of Income' },
  { code: 'FUNDS',     category: 'Financial', name: 'Additional proof of Funds/investments/assets' },
];

module.exports = {
  caseType:      'Visitor Visa',
  subType:       'Parents & Siblings',
  schemaVersion: 1,
  source:        'Document Checklist Items/Visitor/Document Checklist- Visitor Visa-  Parents and siblings.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    spouseIncluded:   { label: 'A second parent is also applying' },
    siblingsIncluded: { label: 'One or more siblings are also applying' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Parent)', required: true, documents: PARENT_DOCUMENTS },
    { role: 'Spouse',             label: 'Second Parent',                includeWhen: { caseFlag: 'spouseIncluded' }, documents: PARENT_DOCUMENTS },
    { role: 'Sibling',            label: 'Sibling',                      includeWhen: { caseFlag: 'siblingsIncluded' }, multipleAllowed: true, documents: SIBLING_DOCUMENTS },
    { role: 'Sponsor',            label: 'Inviter (in Canada)',          required: true, documents: SPONSOR_DOCUMENTS },
  ],
};
