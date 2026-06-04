'use strict';
module.exports = {
  caseType: "BCPNP",
  subType: "BC PNP+ Company Info",
  schemaVersion: 1,
  source: "Document Checklist Items/Provincial Nominee Programs/British Columbia/Document Checklist-BC PNP.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {
    spouseIncluded: { label: 'The applicant’s spouse and/or children are also applying' },
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
      { code: 'CDNEDUCATION', name: 'Canadian Education Documents', category: 'Academic' },
      { code: 'FOREIGNEDUCATION', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic' },
      { code: 'RESUME', name: 'Resume', category: 'Other' },
      { code: 'WORKEXPERIENCE', name: 'Proof of work experience for your qualifying work experience', category: 'Financial' },
      { code: 'JOBOFFER', name: 'Job Offer Letter', category: 'Other' },
      { code: 'INTENTRESIDE', name: 'Intention to Reside in BC', category: 'Other' },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity' },
    ] },
    { role: 'Spouse', label: 'Spouse / Common-Law Partner and Children', includeWhen: { caseFlag: 'spouseIncluded' }, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity' },
    ] },
  ],
};
