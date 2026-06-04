/**
 * Case Structure Schema — Parents/Grandparents Sponsorship (PGP, PR sponsorship).
 *
 * Source: Document Checklist Items/Parents and Grandparents/Document Checklist- Parents & Grandparents Sponsorship.pdf
 *
 * Distinct from Supervisa. Three roles:
 *   - PrincipalApplicant = the parent/grandparent being sponsored (PDF pp.1-2)
 *   - Spouse             = dependent spouse, shares the applicant doc list (conditional)
 *   - Sponsor            = the Child inside Canada (sponsor + co-signer, PDF p.3)
 *
 * No sub-type (registry now supports subType: '').
 *
 * Review fix vs the auto-draft: the parser mislabelled the "Applicant and
 * dependent spouse" heading as Spouse-only and produced no Principal Applicant.
 */

'use strict';

// Applicant + Dependent Spouse share this list (PDF pp.1-2).
const APPLICANT_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all pages' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' } },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents' },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications (Permanent Residents)' },
  { code: 'RESUME',        category: 'Forms',     name: 'Resume / Curriculum Vitae (CV)' },
  { code: 'GOVTEMP',       category: 'Other',     name: 'Details of government employment, police service, military experience' },
  { code: 'PCC',           category: 'Background', name: 'Police certificates (PCC) — highly recommended' },
  { code: 'MEDICAL',       category: 'Medical',   name: 'Medical exam for permanent residence applicants' },
];

// Child inside Canada — Sponsor + co-signer (PDF p.3).
const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',   category: 'Identity',  name: 'Passport with all stamped pages' },
  { code: 'STATUS',     category: 'Identity',  name: 'Proof of status in the country (PR Card / COPR / Citizenship / Canadian Passport)' },
  { code: 'BIRTHCERT',  category: 'Identity',  name: 'Birth Certificate or Grade 10-12 marksheets' },
  { code: 'IACD',       category: 'Identity',  name: 'Identity and Civil Documents' },
  { code: 'NOA',        category: 'Financial', name: 'Notice of Assessment (last 3 years)' },
];

module.exports = {
  caseType:      'Parents/Grandparents Sponsorship',
  subType:       '',
  schemaVersion: 1,
  source:        'Document Checklist Items/Parents and Grandparents/Document Checklist- Parents & Grandparents Sponsorship.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    spouseIncluded: { label: 'A dependent spouse is also being sponsored' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Parent/Grandparent)', required: true, documents: APPLICANT_DOCUMENTS },
    { role: 'Spouse',             label: 'Dependent Spouse',                          includeWhen: { caseFlag: 'spouseIncluded' }, documents: APPLICANT_DOCUMENTS },
    { role: 'Sponsor',            label: 'Sponsor — Child inside Canada (co-signer)', required: true, documents: SPONSOR_DOCUMENTS },
  ],
};
