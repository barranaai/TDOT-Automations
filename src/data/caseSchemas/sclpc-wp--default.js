'use strict';
module.exports = {
  caseType: "SCLPC WP",
  subType: "",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- Open work permit (Worker Parent)- for child above 18 years of age.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'CIVILDOCS', name: 'Identity and Civil Documents', category: 'Relationship' },
      { code: 'MEDICAL', name: 'Upfront Medical exams', category: 'Medical' },
      { code: 'GOVTID', name: 'Government issued Identity documents', category: 'Identity' },
      { code: 'MARKSHEETRESUME', name: 'All Marksheet and certificates along with Resume', category: 'Academic' },
      { code: 'PCC', name: 'Police certificates (PCC)', category: 'Background' },
      { code: 'PROOFINCOME', name: 'Proof/source of Income', category: 'Financial' },
      { code: 'FINANCIALDOCS', name: 'Financial Documents', category: 'Financial' },
      { code: 'ADDLFUNDS', name: 'Additional proof of Funds/investments/assets', category: 'Financial' },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity' }
    ] },
    { role: 'Sponsor', label: 'Worker Parent', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Other' },
      { code: 'PROOFINCOME', name: 'Proof/source of Income', category: 'Financial' }
    ] }
  ],
};
