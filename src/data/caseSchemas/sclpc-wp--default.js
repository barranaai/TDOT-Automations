'use strict';
// SCLPC WP uses the "SOWP (Spousal Sponsorship in process)" checklist per the master
// mapping. (Replaces the prior sclpc-wp--default.js, which cited the wrong PDF.)
module.exports = {
  caseType: "SCLPC WP",
  subType: "",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- SOWP (Spousal Sponsorship in process).pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Background' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'IDCIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity' },
      { code: 'COHABITATION', name: 'Proof of cohabitation', category: 'Relationship' }
    ] },
    { role: 'Sponsor', label: 'Sponsoring Spouse', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'CURRENTSTATUS', name: 'Current Status in the country', category: 'Identity' },
      { code: 'INCOME', name: 'Proof/source of Income', category: 'Financial' }
    ] }
  ],
};
