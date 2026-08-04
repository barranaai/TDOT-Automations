/**
 * Case Structure Schema — Visitor Visa / Change of Status (Student/Worker to Visitor).
 *
 * Source: Document Checklist Items/Visitor/Document Checklist- Visitor Visa- Change of Status (from student or worker).pdf
 *
 * For someone already in Canada changing status to visitor — NO inviter role.
 * PA + optional dependent applicant (Spouse), each with the same 9-doc list.
 */

'use strict';

const PA_SPOUSE_DOCUMENTS = [
  { code: 'PASSPORT',      category: 'Identity',  name: 'Passport with all stamped pages',
    guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
  { code: 'NAMEAFFIDAVIT', category: 'Identity',  name: 'One and same name affidavit if name/surname changed',
    includeWhen: { memberFlag: 'nameChanged' },
    guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
  { code: 'CURSTATUS',     category: 'Identity',  name: 'Current Status in the country (study/work permits ever held)',
    guidance: 'Status documents you have ever held in the country: study permits and work permits.' },
  { code: 'DIGITALPHOTO',  category: 'Identity',  name: 'Digital photo as per specifications of Temporary Residents',
    guidance: 'Must meet IRCC temporary-resident photo specifications (see canada.ca photo specifications page).' },
  { code: 'IACD',          category: 'Identity',  name: 'Identity and Civil Documents',
    guidance: 'Marriage certificate; final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse/common-law partner; legal name/date-of-birth change documents; common-law declaration IMM5409 — whichever apply.' },
  { code: 'INCOME',        category: 'Financial', name: 'Proof/source of Income',
    guidance: 'Notice of Assessment for last year and 3 months bank statements with good funds. If salaried: job letter on letterhead (start date, title, salary, hours, duties — hand-signed), at least 3 pay slips, T4/Form 16 or other tax proof. If self-employed: business establishment/incorporation proof, 3 months business bank statements, documents proving the business is legal and genuine.' },
  { code: 'FINDOCS',       category: 'Financial', name: 'Financial Documents',
    guidance: 'Higher funds raise approval chances — the case manager will let you know if you need these additional documents. At least 3 months bank statements with no sudden deposits; investment proof in your name; property/gold evaluation reports; net-worth (CA) certificate recommended; notarized support affidavit if the assets belong to supporting family members.' },
  { code: 'POLC',          category: 'Other',     name: 'Proof of living in Canada (any 1)',
    guidance: 'Any one of: driver’s licence (front and back), most recent credit card statement, most recent utility bill (electricity/gas), or provincial ID card.' },
];

module.exports = {
  caseType:      'Visitor Visa',
  subType:       'Change of Status (Student/Worker to Visitor)',
  schemaVersion: 1,
  source:        'Document Checklist Items/Visitor/Document Checklist- Visitor Visa- Change of Status (from student or worker).pdf',
  reviewedBy:    'Faran + Claude (batch review)',
  reviewedAt:    '2026-05-13',

  caseFlags: {
    spouseIncluded: { label: 'A dependent spouse is also changing status' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant’s name/surname differs across official documents' },
  },

  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: PA_SPOUSE_DOCUMENTS },
    { role: 'Spouse',             label: 'Dependent Applicant',  includeWhen: { caseFlag: 'spouseIncluded' }, documents: PA_SPOUSE_DOCUMENTS },
  ],
};
