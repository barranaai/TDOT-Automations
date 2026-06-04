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
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages- Old and New', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'EDUCATION', name: 'Canadian Education Documents- (For each program)', category: 'Academic' },
      { code: 'IDENTITYCIVIL', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'PREVIOUSFORMS', name: 'Previous application Forms', category: 'Forms' },
      { code: 'LANGUAGETEST', name: 'Language Test Report', category: 'Academic' }
    ] }
  ],
};
