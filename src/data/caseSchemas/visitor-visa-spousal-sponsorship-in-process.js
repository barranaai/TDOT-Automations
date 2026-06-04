/**
 * Case Structure Schema — Visitor Visa / Spousal Sponsorship in Process.
 *
 * Source: Document Checklist Items/Visitor/Document Checklist- Visitor Visa- Spouse  (Spousal Sponsorship in process).pdf
 *
 * Same document structure as Visitor Visa/Spouse (PA 8 + Inviter 7). The PDF
 * only differs in annotations (income "highly recommended", financial docs
 * "optional") — same rows.
 */

'use strict';

const PA_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' } },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents' },
  { code: 'INCOME',        category: 'Financial', name: 'Proof/source of Income (highly recommended)' },
  { code: 'FINDOCS',       category: 'Financial', name: 'Financial Documents (optional — case-manager decision)' },
];

const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',  category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'CURSTATUS', category: 'Identity',  name: 'Current Status in the country' },
  { code: 'BIRTHCERT', category: 'Identity',  name: 'Birth Certificate' },
  { code: 'IACD',      category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'POLC',      category: 'Other',     name: 'Proof of living in Canada (any 1)' },
  { code: 'INCOME',    category: 'Financial', name: 'Proof/source of Income' },
  { code: 'FUNDS',     category: 'Financial', name: 'Additional proof of Funds/investments/assets' },
];

module.exports = {
  caseType:      'Visitor Visa',
  subType:       'Spousal Sponsorship in Process',
  schemaVersion: 1,
  source:        'Document Checklist Items/Visitor/Document Checklist- Visitor Visa- Spouse  (Spousal Sponsorship in process).pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {},
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Spouse — sponsorship in process)', required: true, documents: PA_DOCUMENTS },
    { role: 'Sponsor',            label: 'Inviter (Spouse in Canada)',                            required: true, documents: SPONSOR_DOCUMENTS },
  ],
};
