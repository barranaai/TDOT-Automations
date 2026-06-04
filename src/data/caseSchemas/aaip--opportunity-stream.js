'use strict';
module.exports = {
  caseType: "AAIP",
  subType: "Opportunity Stream",
  schemaVersion: 1,
  source: "Document Checklist Items/Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Opportunity Stream.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'IDENTITYCIVIL', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'CANEDU', name: 'Canadian Education Documents', category: 'Academic' },
      { code: 'FOREIGNEDU', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic' },
      { code: 'RESUME', name: 'Resume', category: 'Forms' },
      { code: 'LMIA', name: 'Labour Market Impact Assessment (if applicable)', category: 'Background' },
      { code: 'EMPLOYERDECL', name: 'Employer Declaration and Authorization Form', category: 'Forms' },
      { code: 'WORKEXP', name: 'Proof of work experience for your qualifying work experience', category: 'Background' },
      { code: 'JOBOFFER', name: 'Job Offer Letter', category: 'Background' }
    ] },
    { role: 'NonAccompanyingSpouse', label: 'Non-Accompanying Spouse', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } }
    ] }
  ],
};
