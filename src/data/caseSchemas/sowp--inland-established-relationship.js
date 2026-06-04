'use strict';
module.exports = {
  caseType: "SOWP",
  subType: "Inland - Established Relationship",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- SOWP (Worker Spouse)- Established Relationship-Inland.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity' },
      { code: 'CIVILDOCS', name: 'Identity and Civil Documents (legal name/DOB change, IMM5409 common-law declaration, marriage/divorce/annulment certificates, death certificate for former spouse, birth certificate of children)', category: 'Identity' },
      { code: 'COHABITATION', name: 'Proof of cohabitation (joint leases/rental agreements, shared utility bills, same-address documents)', category: 'Relationship' }
    ] },
    { role: 'Spouse', label: 'Worker Spouse', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' } },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity' },
      { code: 'CANEDU', name: 'Canadian Education Documents - for each program if studied here (official marksheet, degree certificates)', category: 'Academic' },
      { code: 'INCOME', name: 'Proof/source of Income - Mandatory for Worker Spouse (job letter, at least three pay slips, T4, bank statement for last 3 months)', category: 'Financial' }
    ] }
  ],
};
