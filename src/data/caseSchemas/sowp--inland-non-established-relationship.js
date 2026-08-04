'use strict';
module.exports = {
  caseType: "SOWP",
  subType: "Inland - Non Established Relationship",
  schemaVersion: 1,
  source: "Document Checklist Items/Work Permits/Document Checklist- SOWP (Worker Spouse)- Non established Relationship-Inland.pdf",
  reviewedBy: 'Workflow review (Claude)',
  reviewedAt: '2026-05-13',
  caseFlags: {},
  memberFlags: { nameChanged: { label: 'Applicant name/surname differs across official documents' } },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'NAMEAFFIDAVIT', name: 'One and same name affidavit if name/surname changed', category: 'Identity', includeWhen: { memberFlag: 'nameChanged' },
        guidance: 'Affidavit of One and the Same Person, sworn (stamped and signed) by a practicing lawyer or notary public — we can share a template. Also provide legal proof of the name change as instructed by the government in your country.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Include all permits ever issued to you in Canada, such as visitor, student or worker permits.' },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity',
        guidance: 'Must meet IRCC temporary-resident photo specifications: https://www.canada.ca/en/immigration-refugees-citizenship/services/application/application-forms-guides/temporary-resident-visa-application-photograph-specifications.html' },
      { code: 'CIVILDOCS', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Legal name or date-of-birth change documents; common-law declaration IMM5409; marriage certificate, final divorce or annulment certificate (from each marriage if more than one); death certificate of former spouse or common-law partner; birth certificates of children — whichever apply.' },
      { code: 'COHABITATION', name: 'Proof of cohabitation', category: 'Relationship',
        guidance: 'Joint leases or rental agreements; bills for shared utility accounts such as gas, electricity, telephone or joint utility accounts; same-address documents such as driver’s licences, provincial ID card, insurance policies or joint bank statement.' }
    ] },
    { role: 'Spouse', label: 'Worker Spouse', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Include all permits ever issued to you in Canada, such as visitor, student or worker permits.' },
      { code: 'CANEDU', name: 'Canadian Education Documents (for each program if studied here)', category: 'Academic',
        guidance: 'Official marksheet or transcript showing the grades obtained in each subject for every year or semester of the program, plus degree certificates from the institution verifying completion of the course, degree, diploma or other qualifications.' },
      { code: 'INCOME', name: 'Proof/source of Income - Mandatory for Worker Spouse', category: 'Financial',
        guidance: 'Job letter from your current employer on company letterhead stating start date, job title, salary, hours worked and job duties — hand-signed, or electronic closely matching the original, or done through DocuSign (typed names are not acceptable); at least 3 pay slips; T4 issued by the employer; bank statement for the last 3 months with good funds.' },
      { code: 'RELATIONSHIPPROOF', name: 'Letters, printed text messages, emails, social media conversations and phone records showing regular contact', category: 'Relationship',
        guidance: 'A detailed letter telling the story of your relationship from when you first met up to now, highlighting important moments and changes; at least 2-3 hand-signed letters from family and friends confirming the relationship; at least 50 photos of the couple together, including wedding and early relationship photos; wedding cards from both sides; screenshots of emails, texts, WhatsApp chats, frequent phone calls, video calls and Facebook Messenger calls showing the genuine nature of the relationship; social media screenshots from Facebook, Instagram and others showing long-term friendship and interaction; wire transfers evidencing financial interdependence; medical or life insurance with both names and details of joint accounts, insurances or other shared financial arrangements; photos, receipts and screenshots of gifts exchanged along with handwritten or typed romantic letters; boarding passes or tickets confirming travel to meet each other.' }
    ] }
  ],
};
