'use strict';
module.exports = {
  caseType: "OINP",
  subType: "Masters Graduate Stream",
  schemaVersion: 1,
  source: "Document Checklist Items/Provincial Nominee Programs/Ontario/Document Checklist- OINP- Masters Graduate Stream.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications Permanent Residents', category: 'Identity' },
      { code: 'IDCIVIL', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'CANEDU', name: 'Canadian Education Documents', category: 'Academic' },
      { code: 'FOREIGNEDU', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic' },
      { code: 'RESUME', name: 'Resume', category: 'Background' },
      { code: 'EMPLOYMENTPROOF', name: 'Current Employment Proof (reference letter, paystubs, T4, NOA for last 5 years)', category: 'Financial' },
      { code: 'JOBOFFER', name: 'Job Offer Letter', category: 'Background' },
      { code: 'SETTLEMENTFUNDS', name: 'Settlement Funds (please confirm with us in advance)', category: 'Financial' },
      { code: 'INTENTONTARIO', name: 'Intention to Reside in Ontario', category: 'Other' }
    ] },
    { role: 'NonAccompanyingSpouse', label: 'Non-Accompanying Spouse', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } }
    ] }
  ],
};
