/**
 * Case Structure Schema — Visitor Visa / 1-2 Members.
 *
 * Source: Document Checklist Items/Visitor/Document Checklist- Visitor Visa- 1 or 2 members.pdf
 *
 * PA + optional dependent Spouse share an applicant list (PDF pp.1-2);
 * Inviter/Sponsor has its own list (PDF pp.3-4).
 *
 * NOTE for team review: Sponsor (Inviter) is marked required — the PDF treats
 * the Inviter as a standard section. Confirm whether a self-funded visitor with
 * no inviter should instead make this conditional.
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

const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',  category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'CURSTATUS', category: 'Identity',  name: 'Current Status in the country' },
  { code: 'RELPROOF',  category: 'Other',     name: 'Proof of Relationship with the applicants' },
  { code: 'IACD',      category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'POLC',      category: 'Other',     name: 'Proof of living in Canada (any 1)' },
  { code: 'INCOME',    category: 'Financial', name: 'Proof/source of Income' },
  { code: 'FUNDS',     category: 'Financial', name: 'Additional proof of Funds/investments/assets' },
];

module.exports = {
  caseType:      'Visitor Visa',
  subType:       '1-2 Members',
  schemaVersion: 1,
  source:        'Document Checklist Items/Visitor/Document Checklist- Visitor Visa- 1 or 2 members.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    spouseIncluded: { label: 'A dependent spouse is also applying' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant',           required: true, documents: PA_SPOUSE_DOCUMENTS },
    { role: 'Spouse',             label: 'Dependent Spouse',              includeWhen: { caseFlag: 'spouseIncluded' }, documents: PA_SPOUSE_DOCUMENTS },
    { role: 'Sponsor',            label: 'Inviter (in Canada)',           required: true, documents: SPONSOR_DOCUMENTS },
  ],
};
