'use strict';
// Francophone Mobility WP shares the "Work Permit Extension (NB)" checklist per the
// master mapping (Applications- Subtypes- Document Checklists-Questionnaire.xlsx).
module.exports = {
  caseType: "Francophone Mobility WP",
  subType: "",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- Work Permit Extension (NB) - Single or accompanying spouse.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'IDCIVIL', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'COHABITATION', name: 'Proof of cohabitation', category: 'Relationship' },
      { code: 'INCOME', name: 'Proof/source of Income- Mandatory for Worker Spouse', category: 'Financial' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } }
    ] }
  ],
};
