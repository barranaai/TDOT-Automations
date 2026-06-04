/**
 * Case Structure Schema — Inland Spousal Sponsorship / Common Law Partner.
 *
 * Source: Document Checklist Items/Spousal Sponsorship/Document Checklist- Common Law Partner- Inland.pdf
 *
 * Structurally identical to Inland Spousal Sponsorship/Marriage (verified
 * against the PDF — same 9 PA docs + 7 Sponsor docs). The only difference is
 * descriptive text inside the "Identity and Civil Documents" row (common-law
 * declaration emphasis), which doesn't change the checklist rows.
 */

'use strict';

const PA_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',        name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',     name: 'Passport with all stamped pages' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',     name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' } },
  { code: 'PERMITS',       category: 'Identity',     name: 'All Permits ever held in Canada' },
  { code: 'BIRTHCERT',     category: 'Identity',     name: 'Birth Certificate' },
  { code: 'IACD',          category: 'Identity',     name: 'Identity and Civil Documents (incl. Common-Law declaration IMM5409)' },
  { code: 'DIGITALPHOTO',  category: 'Identity',     name: 'Digital photo as per specifications (Permanent Residents)' },
  { code: 'PCC',           category: 'Background',    name: 'Police clearance certificates (PCC)' },
  { code: 'RELPROOF',      category: 'Relationship',  name: 'Proof of relationship (letters, photos, chats, proof of living together, support letters, etc.)' },
];

const SPONSOR_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'PRCARD',        category: 'Identity',  name: 'PR Card or eCOPR' },
  { code: 'NOA',           category: 'Financial', name: 'Notice of Assessment' },
  { code: 'T4',            category: 'Financial', name: 'T4' },
  { code: 'EMPLOYMENT',    category: 'Financial', name: 'Employment / Source of Income' },
  { code: 'PAYSTUBS',      category: 'Financial', name: 'Paystubs' },
];

module.exports = {
  caseType:      'Inland Spousal Sponsorship',
  subType:       'Common Law Partner',
  schemaVersion: 1,
  source:        'Document Checklist Items/Spousal Sponsorship/Document Checklist- Common Law Partner- Inland.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {},
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Sponsored Partner)', required: true, documents: PA_DOCUMENTS },
    { role: 'Sponsor',            label: 'Sponsor (Canadian/PR Partner)',           required: true, documents: SPONSOR_DOCUMENTS },
  ],
};
