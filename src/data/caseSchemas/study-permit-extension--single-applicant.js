'use strict';
module.exports = {
  caseType: "Study Permit Extension",
  subType: "Single Applicant",
  schemaVersion: 1,
  source: "Document Checklist Items/Study Permit/Document Checklist- Study Permit  Extension- Single applicant.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'ADMISSION', name: 'Proof of Admission', category: 'Academic' },
      { code: 'FINANCIALSUPPORT', name: 'Proof of financial support while you study in Canada', category: 'Financial' }
    ] }
  ],
};
