'use strict';
module.exports = {
  caseType: "Federal PR",
  subType: "Non Express Entry - Non Accompanying Spouse",
  schemaVersion: 1,
  source: "Document Checklist Items/Non-Express Entry/Document Checklist- Non-Express Entry- Non accompanying spouse.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications Permanent Residents- Front and Back both required', category: 'Identity' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic' },
      { code: 'MEDICAL', name: 'Medical Exam', category: 'Medical' },
      { code: 'PCC', name: 'Police clearance certificates (PCC)', category: 'Background' },
      { code: 'CANEDU', name: 'Canadian Education Documents', category: 'Academic' },
      { code: 'FOREIGNEDU', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic' },
      { code: 'SIBLINGPROOF', name: 'Sibling- Proof of living in Canada', category: 'Relationship' },
      { code: 'WORKEXP', name: 'Proof of work experience for the claiming period (Inside and Outside Canada)', category: 'Financial' },
      { code: 'CIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'PROOFLIVING', name: 'Proof of living in Canada', category: 'Identity' }
    ] },
    { role: 'NonAccompanyingSpouse', label: 'Non-Accompanying Spouse', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications Permanent Residents', category: 'Identity' },
      { code: 'MEDICAL', name: 'Medical Exam', category: 'Medical' },
      { code: 'PCC', name: 'Police clearance certificates (PCC)', category: 'Background' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } }
    ] }
  ],
};
