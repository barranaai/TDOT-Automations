/**
 * Case Structure Schema — Visitor Visa / Both Parents.
 *
 * Source: Document Checklist Items/Visitor/Document Checklist- Visitor Visa- Both Parents.pdf
 *
 * Both parents always apply → PA + Spouse both required (share applicant list).
 * Inviter (child in Canada) required.
 *
 * Delta vs other Visitor Visa sub-types: the Inviter list uses "Birth
 * Certificate" (to prove the parent-child relationship) instead of the generic
 * "Proof of Relationship".
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

const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',  category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'CURSTATUS', category: 'Identity',  name: 'Current Status in the country' },
  { code: 'BIRTHCERT', category: 'Identity',  name: 'Birth Certificate (proves parent-child relationship)' },
  { code: 'IACD',      category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'POLC',      category: 'Other',     name: 'Proof of living in Canada (any 1)' },
  { code: 'INCOME',    category: 'Financial', name: 'Proof/source of Income' },
  { code: 'FUNDS',     category: 'Financial', name: 'Additional proof of Funds/investments/assets' },
];

module.exports = {
  caseType:      'Visitor Visa',
  subType:       'Both Parents',
  schemaVersion: 1,
  source:        'Document Checklist Items/Visitor/Document Checklist- Visitor Visa- Both Parents.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {},
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Parent 1)', required: true, documents: PARENT_DOCUMENTS },
    { role: 'Spouse',             label: 'Dependent Applicant (Parent 2)',  required: true, documents: PARENT_DOCUMENTS },
    { role: 'Sponsor',            label: 'Inviter — Child in Canada',       required: true, documents: SPONSOR_DOCUMENTS },
  ],
};
