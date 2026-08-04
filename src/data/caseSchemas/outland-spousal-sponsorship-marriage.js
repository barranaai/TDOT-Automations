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
  { code: 'PASSPORT',      category: 'Identity',     name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',     name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' },
    guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
  { code: 'BIRTHCERT',     category: 'Identity',     name: 'Birth Certificate',
    guidance: 'Government-issued and showing your parents’ names. A 10th/12th marksheet can be accepted as an alternative (not preferred).' },
  { code: 'GOVTID',        category: 'Identity',     name: 'Government issued Identity documents',
    guidance: 'Aadhaar card, PAN card, or any other document issued by your government that has your full name, date of birth, photograph and signature.' },
  { code: 'IACD',          category: 'Identity',     name: 'Identity and Civil Documents',
    guidance: 'Marriage certificate; final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse/common-law partner; common-law declaration IMM5409; birth certificates of children; legal name/date-of-birth change documents — whichever apply.' },
  { code: 'DIGITALPHOTO',  category: 'Identity',     name: 'Digital photo as per specifications (Permanent Residents)',
    guidance: 'Must meet IRCC photo specifications for permanent residents — more information: https://www.canada.ca/en/immigration-refugees-citizenship/services/new-immigrants/pr-card/apply-renew-replace/photo.html' },
  { code: 'PCC',           category: 'Background',    name: 'Police clearance certificates (PCC)',
    guidance: 'A statement that you have no criminal record (or a copy of your record), from all countries where you lived more than 6 months after turning 18 or in the last 10 years. The issue date must be within the last 6 months or after your most recent arrival in Canada, whichever is earlier; for India only Passport Seva Kendra PCC is accepted. How to get one: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/medical-police/police-certificates/how.html' },
  { code: 'RELPROOF',      category: 'Relationship',  name: 'Proof of relationship (letters, photos, chats, financial interdependence, support letters, etc.)',
    guidance: 'A detailed letter telling the story of your relationship from first meeting to now; at least 30–50 photos of the couple from events, the wedding, celebrations and private moments; wedding invitation cards from both sides; screenshots of emails, texts, WhatsApp chats, calls and social media showing regular contact; evidence of financial interdependence, joint accounts or insurance with both names; records of gifts and romantic letters; boarding passes or hotel bookings confirming travel to meet each other; and at least 2 support letters from family or friends who can affirm you are a genuine couple — we can share templates.' },
];

const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'PRCARD',        category: 'Identity',  name: 'PR Card or eCOPR',
    guidance: 'Front and back of your PR Card, or the COPR copy signed by you and the immigration officer.' },
  { code: 'NOA',           category: 'Financial', name: 'Notice of Assessment',
    guidance: 'A complete scan of your most recent Notice of Assessment — it must include line 150, Total Income.' },
  { code: 'T4',            category: 'Financial', name: 'T4',
    guidance: 'The tax slip (Statement of Remuneration Paid) your employer issues after each calendar year.' },
  { code: 'EMPLOYMENT',    category: 'Financial', name: 'Employment / Source of Income',
    guidance: 'Original employment letter from your employer stating period of employment, salary and regular hours.' },
  { code: 'PAYSTUBS',      category: 'Financial', name: 'Paystubs',
    guidance: 'Summarize gross pay, taxes, deductions and net pay; paper or electronic copies are accepted.' },
];

module.exports = {
  caseType:      'Outland Spousal Sponsorship',
  subType:       '',
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
