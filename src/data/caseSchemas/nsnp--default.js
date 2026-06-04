'use strict';
module.exports = {
  caseType: "NSNP",
  subType: "",
  schemaVersion: 1,
  source: "Document Checklist Items/Provincial Nominee Programs/Nova Scotia/Document Checklist-NSNP.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    spouseIncluded: { label: 'An accompanying spouse / common-law partner or child is included in the application' },
  },
  memberFlags: {
    nameChanged: { label: 'Applicant name/surname differs across official documents' },
  },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'IDCIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications Permanent Residents', category: 'Identity' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'CDNEDU', name: 'Canadian Education Documents', category: 'Academic' },
      { code: 'FOREIGNEDU', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic' },
      { code: 'RESUME', name: 'Resume', category: 'Forms' },
      { code: 'WORKEXP', name: 'Proof of work experience for your qualifying work experience', category: 'Background' },
      { code: 'JOBOFFER', name: 'Job Offer Letter', category: 'Background' },
      { code: 'INTENTRESIDE', name: 'Intention to Reside in Nova Scotia', category: 'Other' },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity' },
      { code: 'NSNP200', name: 'NSNP 200 - Employer Information Form', category: 'Forms' },
      { code: 'SETTLEMENTFUNDS', name: 'Settlement Funds (please confirm with us in advance)', category: 'Financial' },
    ] },
    { role: 'Spouse', label: 'Spouse / Common-Law Partner', includeWhen: { caseFlag: 'spouseIncluded' }, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity' },
    ] },
  ],
};
