/**
 * Case Structure Schema — Outland Spousal Sponsorship / Marriage.
 *
 * Source: Document Checklist Items/Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Outland.pdf
 *
 * Two required roles, no conditional roles:
 *   - PrincipalApplicant = the sponsored spouse abroad (PDF pp.1-2)
 *   - Sponsor            = the Canadian/PR spouse (PDF p.3)
 * Both always required for a spousal sponsorship.
 *
 * Review fixes vs the auto-draft:
 *   - added the Questionnaire row to both roles (parser skips it)
 *   - marked the name-change affidavit conditional on nameChanged
 *   - ADDED the Sponsor's "T4" (the parser dropped it — name was too short)
 *   - cleaned up the relationship-proof document name/category
 */

'use strict';

const PA_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',        name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',     name: 'Passport with all stamped pages' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',     name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' } },
  { code: 'BIRTHCERT',     category: 'Identity',     name: 'Birth Certificate' },
  { code: 'GOVTID',        category: 'Identity',     name: 'Government issued Identity documents' },
  { code: 'IACD',          category: 'Identity',     name: 'Identity and Civil Documents' },
  { code: 'DIGITALPHOTO',  category: 'Identity',     name: 'Digital photo as per specifications (Permanent Residents)' },
  { code: 'PCC',           category: 'Background',    name: 'Police clearance certificates (PCC)' },
  { code: 'RELPROOF',      category: 'Relationship',  name: 'Proof of relationship (letters, photos, chats, financial interdependence, support letters, etc.)' },
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
  caseType:      'Outland Spousal Sponsorship',
  subType:       'Marriage',
  schemaVersion: 1,
  source:        'Document Checklist Items/Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Outland.pdf',
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
