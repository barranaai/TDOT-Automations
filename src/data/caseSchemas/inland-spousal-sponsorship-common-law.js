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
  { code: 'QUESTIONNAIRE', category: 'Forms',        name: 'Questionnaire',
    guidance: 'Complete the questionnaire with full and accurate details. Any gaps will not be accepted.' },
  { code: 'PASSPORT',      category: 'Identity',     name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',     name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' },
    guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
  { code: 'PERMITS',       category: 'Identity',     name: 'All Permits ever held in Canada',
    guidance: 'All permits issued to you in Canada as a visitor, student or worker.' },
  { code: 'BIRTHCERT',     category: 'Identity',     name: 'Birth Certificate',
    guidance: 'Government-issued and showing your parents’ names. A 10th/12th marksheet can be accepted as an alternative (not preferred).' },
  { code: 'IACD',          category: 'Identity',     name: 'Identity and Civil Documents (incl. Common-Law declaration IMM5409)',
    guidance: 'Marriage certificate; final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse/common-law partner; common-law declaration IMM5409; birth certificates of children; legal name/date-of-birth change documents — whichever apply.' },
  { code: 'DIGITALPHOTO',  category: 'Identity',     name: 'Digital photo as per specifications (Permanent Residents)',
    guidance: 'Must meet IRCC photo specifications for permanent residents — more information: https://www.canada.ca/en/immigration-refugees-citizenship/services/new-immigrants/pr-card/apply-renew-replace/photo.html' },
  { code: 'PCC',           category: 'Background',    name: 'Police clearance certificates (PCC)',
    guidance: 'A statement that you have no criminal record (or a copy of your record), from all countries where you lived more than 6 months after turning 18 or in the last 10 years. The issue date must be within the last 6 months or after your most recent arrival in Canada, whichever is earlier; for India only BLS PCC is accepted. How to get one: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/medical-police/police-certificates/how.html' },
  { code: 'RELPROOF',      category: 'Relationship',  name: 'Proof of relationship (letters, photos, chats, proof of living together, support letters, etc.)',
    guidance: 'A detailed letter telling the story of your relationship from first meeting to now; at least 30–50 photos of the couple from events, celebrations and private moments; screenshots of emails, texts, WhatsApp chats, calls and social media showing regular contact; evidence of financial interdependence, joint accounts or insurance with both names; records of gifts and romantic letters; boarding passes or hotel bookings confirming travel to meet each other; proof of living together (lease agreement, joint utility bills, joint bank account, credit card statement and government-issued IDs at the same address); and at least 2 support letters from family or friends who can affirm you are a genuine couple — we can share templates.' },
];

const SPONSOR_DOCUMENTS = [
  { code: 'QUESTIONNAIRE', category: 'Forms',     name: 'Questionnaire',
    guidance: 'Complete the questionnaire with full and accurate details. Any gaps will not be accepted.' },
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'PRCARD',        category: 'Identity',  name: 'PR Card or eCOPR',
    guidance: 'Front and back of your PR Card, or the COPR copy signed by you and the immigration officer.' },
  { code: 'NOA',           category: 'Financial', name: 'Notice of Assessment',
    guidance: 'A complete scan of your most recent Notice of Assessment — it must include line 150, Total Income.' },
  { code: 'T4',            category: 'Financial', name: 'T4',
    guidance: 'T4/Form 16 (Statement of Remuneration Paid) — the tax slip employers issue to employees after each calendar year.' },
  { code: 'EMPLOYMENT',    category: 'Financial', name: 'Employment / Source of Income',
    guidance: 'Original employment letter from your employer stating period of employment, salary and regular hours.' },
  { code: 'PAYSTUBS',      category: 'Financial', name: 'Paystubs',
    guidance: 'Summarize gross pay, taxes, deductions and net pay; paper or electronic copies are accepted.' },
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
