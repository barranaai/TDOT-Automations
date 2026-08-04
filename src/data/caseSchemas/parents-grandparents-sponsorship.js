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
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Legal name/date-of-birth change documents; common-law declaration IMM5409; marriage certificate and final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse or common-law partner; birth certificates of children — whichever apply.' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' },
    guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents',
    guidance: 'Aadhar card, PAN card, Voter ID card, or any other document issued by your government that has your full name, date of birth, photograph and signature.' },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications (Permanent Residents)',
    guidance: 'Provide front and back of the picture, following IRCC permanent-resident photo specifications — see https://www.canada.ca/en/immigration-refugees-citizenship/services/new-immigrants/pr-card/apply-renew-replace/photo.html.' },
  { code: 'RESUME',        category: 'Forms',     name: 'Resume / Curriculum Vitae (CV)',
    guidance: 'Ensure the resume/CV includes information since the age of 18 and details of the employment, volunteer positions held and education.' },
  { code: 'GOVTEMP',       category: 'Other',     name: 'Details of government employment, police service, military experience',
    guidance: 'We will provide an additional information form that must be completed with precise information. Failure to provide information may lead to additional document requests, delay in processing or even refusal of the application.' },
  { code: 'PCC',           category: 'Background', name: 'Police certificates (PCC) — highly recommended',
    guidance: 'A statement that you don’t have a criminal record or, if you have one, a copy of your criminal record — provide PCC from all countries where you lived more than 6 months after turning 18 or in the last 10 years. The PCC issue date must be within the last 6 months or after the most recent arrival in Canada, whichever is earlier. How to get a police certificate: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/medical-police/police-certificates/how.html.' },
  { code: 'MEDICAL',       category: 'Medical',   name: 'Medical exam for permanent residence applicants',
    guidance: 'Only Panel Physicians approved by IRCC can do this exam, and you will have to bring a request letter from IRCC — we will inform you when we get it after submission of your application. Find a Panel Physician: https://secure.cic.gc.ca/PanelPhysicianMedecinDesigne/en/Home — more information: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/medical-police/medical-exams/requirements-permanent-residents.html.' },
];

// Child inside Canada — Sponsor + co-signer (PDF p.3).
const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',   category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'STATUS',     category: 'Identity',  name: 'Proof of status in the country (PR Card / COPR / Citizenship / Canadian Passport)',
    guidance: 'PR card (front and back of all PR cards ever issued); COPR with all pages signed by you and the officer; Canadian Citizenship Certificate or card; or Canadian passport with all pages.' },
  { code: 'BIRTHCERT',  category: 'Identity',  name: 'Birth Certificate or Grade 10-12 marksheets',
    guidance: 'The birth certificate should be government-issued and show your parents’ names. Marksheets must be official documents issued by the university and must include your parents’ names.' },
  { code: 'IACD',       category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Legal name/date-of-birth change documents; common-law declaration IMM5409; marriage certificate and final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse or common-law partner; birth certificates of children — whichever apply.' },
  { code: 'NOA',        category: 'Financial', name: 'Notice of Assessment (last 3 years)',
    guidance: 'The evaluation of your tax return that the Canada Revenue Agency sends every year after you file. This document is mandatory to prove the income eligibility — provide the Notice of Assessment for the last 3 years.' },
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
