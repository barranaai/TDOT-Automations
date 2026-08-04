/**
 * Case Structure Schema — Visitor Visa / Spouse.
 *
 * Source: Document Checklist Items/Visitor/Document Checklist- Visitor Visa- Spouse.pdf
 *
 * Visiting spouse (PA) + required Inviter (the spouse in Canada). Same applicant
 * + inviter lists as Single Parent (inviter uses Birth Certificate per the PDF).
 */

'use strict';

const PA_DOCUMENTS = [
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' },
    guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents',
    guidance: 'Must meet IRCC temporary-resident photo specifications (see canada.ca photo specifications page).' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Marriage certificate; final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse/common-law partner; legal name/date-of-birth change documents; common-law declaration IMM5409 — whichever apply.' },
  { code: 'GOVTID',        category: 'Identity',  name: 'Government issued Identity documents',
    guidance: 'Aadhar card, PAN card, or any other government-issued document showing your full name, date of birth, photograph and signature.' },
  { code: 'INCOME',        category: 'Financial', name: 'Proof/source of Income',
    guidance: 'If salaried: job letter on letterhead (start date, title, salary, hours, duties — hand-signed), at least 3 pay slips, Form 16 or other tax proof. If self-employed: business establishment proof, tax payment proof, 3 months business bank statements. If pensioner/unemployed: pension confirmation and bank statement, or support documents from immediate family apart from the inviter.' },
  { code: 'FINDOCS',       category: 'Financial', name: 'Financial Documents',
    guidance: 'Higher funds raise approval chances. At least 3 months bank statements with no sudden deposits; investment proof in your name; property/gold evaluation reports; net-worth (CA) certificate recommended; notarized support affidavit if the assets belong to supporting family members.' },
];

const SPONSOR_DOCUMENTS = [
  { code: 'PASSPORT',  category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with photo, name, signature, date/place of birth, place of issue and address.' },
  { code: 'CURSTATUS', category: 'Identity',  name: 'Current Status in the country',
    guidance: 'Status documents in Canada: study permit, work permit, Canadian passport or PR card. Canadian citizens: include the original country passport as well.' },
  { code: 'BIRTHCERT', category: 'Identity',  name: 'Birth Certificate',
    guidance: 'Government-issued and showing the parents’ names. A 10th/12th marksheet can be accepted as an alternative (not preferred).' },
  { code: 'IACD',      category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Legal name/date-of-birth change documents; common-law declaration IMM5409; marriage/divorce/annulment certificates (each marriage if more than one); death certificate of former spouse/common-law partner; birth certificates of children — whichever apply.' },
  { code: 'POLC',      category: 'Other',     name: 'Proof of living in Canada (any 1)',
    guidance: 'Any one of: driver’s licence (front and back), most recent credit card statement, most recent utility bill (electricity/gas), or provincial ID card.' },
  { code: 'INCOME',    category: 'Financial', name: 'Proof/source of Income',
    guidance: 'Notice of Assessment for last year and 3 months bank statements with good funds. If salaried: job letter (start date, title, salary, hours, duties), at least 3 pay slips, T4. If self-employed: business establishment/incorporation proof, 3 months business bank statements, documents proving the business is legal and genuine.' },
  { code: 'FUNDS',     category: 'Financial', name: 'Additional proof of Funds/investments/assets',
    guidance: 'Any funds, investments or assets that increase your net worth — disclose them with supporting documentation.' },
];

module.exports = {
  caseType:      'Visitor Visa',
  subType:       'Spouse',
  schemaVersion: 1,
  source:        'Document Checklist Items/Visitor/Document Checklist- Visitor Visa- Spouse.pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {},
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant (Visiting Spouse)', required: true, documents: PA_DOCUMENTS },
    { role: 'Sponsor',            label: 'Inviter (Spouse in Canada)',            required: true, documents: SPONSOR_DOCUMENTS },
  ],
};
