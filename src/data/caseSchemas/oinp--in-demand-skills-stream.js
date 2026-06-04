'use strict';
module.exports = {
  caseType: "OINP",
  subType: "In-demand Skills Stream",
  schemaVersion: 1,
  source: "Document Checklist Items/Provincial Nominee Programs/Ontario/Document Checklist- OINP- In-Demand Skills Stream.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
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
      { code: 'CDNEDUCATION', name: 'Canadian Education Documents', category: 'Academic' },
      { code: 'FOREIGNEDUCATION', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic' },
      { code: 'JOBOFFER', name: 'Job Offer Letter', category: 'Forms' },
      { code: 'CURRENTEMPLOYMENT', name: 'Current Employment Proof', category: 'Financial' },
      { code: 'LICENCE', name: 'Licence or authorization', category: 'Other' },
      { code: 'WORKEXPERIENCE', name: 'Proof of work experience (Inside and Outside Canada)', category: 'Financial' },
      { code: 'INTENTRESIDE', name: 'Intention to Reside in Ontario', category: 'Other' },
      { code: 'CVOR', name: "Commercial Vehicle Operator's Registration (CVOR) Certificate", category: 'Other' },
      { code: 'EMPLOYERFORM', name: 'Application for Approval of an Employment Position (Employer Form)', category: 'Forms' }
    ] },
    { role: 'NonAccompanyingSpouse', label: 'Non-Accompanying Spouse', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } }
    ] }
  ],
};
