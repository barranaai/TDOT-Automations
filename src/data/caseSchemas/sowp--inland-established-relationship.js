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
      { code: 'QUESTIONNAIRE', name: 'Questionnaire', category: 'Forms',
        guidance: 'Complete the questionnaire with full and accurate details. Any gaps will not be accepted.' },
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Include all permits ever issued to you in Canada, such as visitor, student or worker permits.' },
      { code: 'PHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity',
        guidance: 'Must meet IRCC temporary-resident photo specifications: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/temporary-resident-visa-application-photograph-specifications.html' },
      { code: 'CIVILDOCS', name: 'Identity and Civil Documents (legal name/DOB change, IMM5409 common-law declaration, marriage/divorce/annulment certificates, death certificate for former spouse, birth certificate of children)', category: 'Identity',
        guidance: 'Legal name or date-of-birth change documents; common-law declaration IMM5409; marriage certificate, final divorce or annulment certificate (from each marriage if more than one); death certificate of former spouse or common-law partner; birth certificates of children — whichever apply.' },
      { code: 'COHABITATION', name: 'Proof of cohabitation (joint leases/rental agreements, shared utility bills, same-address documents)', category: 'Relationship',
        guidance: 'Joint leases or rental agreements; bills for shared utility accounts such as gas, electricity, telephone or joint utility accounts; same-address documents such as driver’s licences, provincial ID card, insurance policies or joint bank statement.' }
    ] },
    { role: 'Spouse', label: 'Worker Spouse', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Include all permits ever issued to you in Canada, such as visitor, student or worker permits.' },
      { code: 'CANEDU', name: 'Canadian Education Documents - for each program if studied here (official marksheet, degree certificates)', category: 'Academic',
        guidance: 'Official marksheet or transcript showing the grades obtained in each subject for every year or semester of the program, plus degree certificates from the institution verifying completion of the course, degree, diploma or other qualifications.' },
      { code: 'INCOME', name: 'Proof/source of Income - Mandatory for Worker Spouse (job letter, at least three pay slips, T4, bank statement for last 3 months)', category: 'Financial',
        guidance: 'Job letter from your current employer on company letterhead stating start date, job title, salary, hours worked and job duties — hand-signed, or electronic closely matching the original, or done through DocuSign (typed names are not acceptable); at least 3 pay slips; T4 issued by the employer; bank statement for the last 3 months with good funds.' }
    ] }
  ],
};
