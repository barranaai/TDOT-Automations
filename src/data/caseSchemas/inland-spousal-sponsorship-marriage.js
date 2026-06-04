/**
 * Case Structure Schema — Inland Spousal Sponsorship / Marriage.
 *
 * Source: Document Checklist Items/Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Inland.pdf
 *
 * Mirrors Outland Spousal/Marriage, with inland-specific differences on the PA:
 *   - "All Permits ever held in Canada" replaces "Government issued Identity docs"
 *   - relationship proof additionally expects "proof of living together"
 * Sponsor list is identical to Outland (T4 included — the parser had dropped it).
 */

'use strict';

const PA_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',        name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',     name: 'Passport with all stamped pages' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',     name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' } },
  { code: 'PERMITS',       category: 'Identity',     name: 'All Permits ever held in Canada' },
  { code: 'BIRTHCERT',     category: 'Identity',     name: 'Birth Certificate' },
  { code: 'IACD',          category: 'Identity',     name: 'Identity and Civil Documents' },
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
  subType:       'Marriage',
  schemaVersion: 1,
  source:        'Document Checklist Items/Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Inland.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {},
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Sponsored Spouse)', required: true, documents: PA_DOCUMENTS },
    { role: 'Sponsor',            label: 'Sponsor (Canadian/PR Spouse)',           required: true, documents: SPONSOR_DOCUMENTS },
  ],
};
