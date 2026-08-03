'use strict';
module.exports = {
  caseType: "PGWP",
  subType: "Extension - Single Applicant",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- PGWP Extension (Single Applicant)- Passport Validity.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms',
        guidance: 'Complete the questionnaire with full and accurate details. Any gaps will not be accepted.' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages- Old and New', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach all permits ever issued to you in Canada as a visitor, student or worker.' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity',
        guidance: 'Must meet IRCC temporary-resident photo specifications: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/temporary-resident-visa-application-photograph-specifications.html' },
      { code: 'EDUCATION', name: 'Canadian Education Documents- (For each program)', category: 'Academic',
        guidance: 'Official marksheet or transcript showing the grades obtained in each subject for every year or semester of the program; degree certificates; completion letter from the institution; official/unofficial break letter — if you had an unofficial break or changed your program/intake, provide supporting documents for clarification (failure to provide these may lead to refusal). Unofficial transcripts cannot be used for PGWP.' },
      { code: 'IDENTITYCIVIL', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Legal name or date-of-birth change documents; common-law declaration IMM5409; marriage certificate, final divorce or annulment certificate (from each marriage if more than one); death certificate of former spouse or common-law partner; birth certificates of children — whichever apply.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
      { code: 'PREVIOUSFORMS', name: 'Previous application Forms', category: 'Forms',
        guidance: 'If you have access to the previous forms you submitted, provide them to maintain consistency.' },
      { code: 'LANGUAGETEST', name: 'Language Test Report', category: 'Academic',
        guidance: 'Results must be no older than two years upon date of receipt; bachelor’s, master’s or doctoral graduates need CLB 7 in English or NCLC 7 in French in all four skill areas, while college or other university program graduates need CLB 5 or NCLC 5. Accepted tests: CELPIP-G, IELTS-G, PTE Core for English; TEF Canada and TCF Canada for French. More information: https://www.canada.ca/en/immigration-refugees-citizenship/services/study-canada/work/after-graduation/eligibility/study-requirements.html' }
    ] }
  ],
};
