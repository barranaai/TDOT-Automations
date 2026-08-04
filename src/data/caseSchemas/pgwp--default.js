'use strict';
module.exports = {
  caseType: "PGWP",
  subType: "Single Applicant",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- PGWP (Single Applicant).pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach all permits issued to you in Canada as a visitor, student or worker.' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity',
        guidance: 'Must meet IRCC temporary-resident photo specifications (see https://www.canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/temporary-resident-visa-application-photograph-specifications.html).' },
      { code: 'EDUCATION', name: 'Canadian Education Documents (for each program)', category: 'Academic',
        guidance: 'For each program: unconditional Letter of Acceptance for every public and private college you were enrolled at; official marksheet/transcript for every year or semester; degree certificates; completion letter from the institution; and an official break letter, or supporting documents clarifying any unofficial break or program/intake change — failure to provide these may lead to refusal. Unofficial transcripts cannot be used for PGWP.' },
      { code: 'IDCIVIL', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Legal name/date-of-birth change documents; common-law declaration IMM5409; marriage certificate and final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse/common-law partner; birth certificates of children — whichever apply.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
      { code: 'LANGUAGETEST', name: 'Language Test Report', category: 'Academic',
        guidance: 'Results must not be older than two years upon date of receipt. Graduates of a bachelor’s, master’s or doctoral program need CLB 7 in English or NCLC 7 in French in all four skill areas (listening, speaking, reading, writing); graduates of college or other university programs need CLB 5 or NCLC 5 in all four. Accepted tests — English: CELPIP-G, IELTS-G, PTE Core; French: TEF Canada, TCF Canada (more information: https://www.canada.ca/en/immigration-refugees-citizenship/services/study-canada/work/after-graduation/eligibility/study-requirements.html).' }
    ] }
  ],
};
