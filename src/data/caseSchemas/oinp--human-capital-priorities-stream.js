'use strict';
module.exports = {
  caseType: "OINP",
  subType: "Human Capital Priorities Stream",
  schemaVersion: 1,
  source: "Document Checklist Items/Provincial Nominee Programs/Ontario/Document Checklist- OINP- Human Capital Priorities Stream.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    spouseIncluded: { label: 'An accompanying spouse / common-law partner is included' },
    childrenIncluded: { label: 'Accompanying dependent children are included' },
  },
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications Permanent Residents', category: 'Identity' },
      { code: 'IDCIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'RESUME', name: 'Resume', category: 'Other' },
      { code: 'CDNEDU', name: 'Canadian Education Documents', category: 'Academic' },
      { code: 'FOREIGNEDU', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic' },
      { code: 'JOBOFFER', name: 'Job Offer Letter', category: 'Background' },
      { code: 'CURREMPLOY', name: 'Current Employment Proof', category: 'Background' },
      { code: 'LICENCE', name: 'Licence or authorization', category: 'Background' },
      { code: 'WORKEXP', name: 'Proof of work experience (Inside and Outside Canada)', category: 'Background' },
      { code: 'INTENTRESIDE', name: 'Intention to Reside in Ontario', category: 'Other' },
      { code: 'SETTLEMENTFUNDS', name: 'Settlement Funds (please confirm with us in advance)', category: 'Financial' },
      { code: 'RELATIVESCDN', name: 'Documents for relatives in Canada', category: 'Relationship' }
    ] },
    { role: 'Spouse', label: 'Accompanying Spouse / Common-Law Partner', includeWhen: { caseFlag: 'spouseIncluded' }, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'CDNEDU', name: 'Canadian Education Documents', category: 'Academic' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic' },
      { code: 'WORKEXP', name: 'Proof of work experience (Inside Canada)', category: 'Background' }
    ] },
    { role: 'DependentChild', label: 'Dependent Child', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'CDNEDU', name: 'Canadian Education Documents', category: 'Academic' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic' }
    ] }
  ],
};
