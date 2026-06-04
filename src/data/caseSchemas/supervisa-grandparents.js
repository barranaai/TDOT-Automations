/**
 * Case Structure Schema — Supervisa / Grandparents.
 *
 * Source: Document Checklist Items/Supervisa/Document Checklist- Supervisa- GrandParents.pdf
 *
 * Identical to Supervisa/Parents except the applicant section adds a standalone
 * "Support Affidavit" document (PDF page 3). Same role structure: PA + optional
 * Spouse + always-required Sponsor (Inviter).
 *
 * Reviewed against the PDF — see review note in caseSchemaService registration.
 */

'use strict';

const CASE_TYPE     = 'Supervisa';
const CASE_SUB_TYPE = 'Grandparents';

// PA + Dependent Spouse share an identical list (PDF pp.1-3). One row per ☐.
const PA_SPOUSE_DOCUMENTS = [
  { code: 'QUESTIONNAIRE',   category: 'Forms',     name: 'Questionnaire' },
  { code: 'PASSPORT',        category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'NAMEAFFIDAVIT',   category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' } },
  { code: 'DIGITALPHOTO',    category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents' },
  { code: 'UPFRONTMEDICAL',  category: 'Medical',   name: 'Upfront Medical' },
  { code: 'IACD',            category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'GOVTID',          category: 'Identity',  name: 'Government issued Identity documents' },
  { code: 'INCOME',          category: 'Financial', name: 'Proof/source of Income' },
  { code: 'FINDOCS',         category: 'Financial', name: 'Financial Documents' },
  { code: 'HEALTHINS',       category: 'Insurance', name: 'Health Insurance' },
  { code: 'SUPPORTAFFIDAVIT', category: 'Financial', name: 'Support Affidavit' },
  { code: 'GOVTEMP',         category: 'Other',     name: 'Details of government employment, police service, military experience' },
];

// Sponsor / Inviter list (PDF pp.4-5).
const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',  category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'CURSTATUS', category: 'Other',     name: 'Current Status in the country' },
  { code: 'BIRTHCERT', category: 'Identity',  name: 'Birth Certificate' },
  { code: 'IACD',      category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'POLC',      category: 'Other',     name: 'Proof of living in Canada (any 1)' },
  { code: 'INCOME',    category: 'Financial', name: 'Proof/source of Income' },
  { code: 'FUNDS',     category: 'Financial', name: 'Additional proof of Funds/investments/assets' },
];

module.exports = {
  caseType:      CASE_TYPE,
  subType:       CASE_SUB_TYPE,
  schemaVersion: 1,
  source:        'Document Checklist Items/Supervisa/Document Checklist- Supervisa- GrandParents.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    spouseIncluded: { label: 'The applicant’s spouse is also applying for the Super Visa' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Grandparent)', required: true,  documents: PA_SPOUSE_DOCUMENTS },
    { role: 'Spouse',             label: 'Dependent Spouse (Grandparent)',    includeWhen: { caseFlag: 'spouseIncluded' }, documents: PA_SPOUSE_DOCUMENTS },
    { role: 'Sponsor',            label: 'Sponsor / Inviter (in Canada)',     required: true,  documents: SPONSOR_DOCUMENTS },
  ],
};
