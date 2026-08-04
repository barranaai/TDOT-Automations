'use strict';
module.exports = {
  caseType: "Visitor Record / Extension",
  subType: "Visitor Record",
  schemaVersion: 1,
  source: "Document Checklist Items/Visitor/Document Checklist- Visitor Record (extension).pdf",
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
      { code: 'CURRENTSTATUS', name: 'Current Status in the country', category: 'Identity',
        guidance: 'Status documents you have ever held in the country: study permits, work permits and visitor records.' },
      { code: 'DIGITALPHOTO', name: 'Digital photo as per specifications of Temporary Residents', category: 'Identity',
        guidance: 'Must meet IRCC temporary-resident photo specifications (see canada.ca photo specifications page).' },
      { code: 'IDENTITYCIVIL', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Marriage certificate; final divorce/annulment certificates (from each marriage if more than one); death certificate of former spouse/common-law partner; legal name/date-of-birth change documents; common-law declaration IMM5409 — whichever apply.' },
      { code: 'INCOMEPROOF', name: 'Proof/source of Income (Back Home)', category: 'Financial',
        guidance: 'If you or the supporting family member is salaried: job letter on letterhead (start date, title, salary, hours, duties — hand-signed), at least 3 pay slips, T4/Form 16 or other tax proof. If self-employed: business establishment/incorporation proof, 3 months business bank statements, documents proving the business is legal and genuine.' },
      { code: 'FINANCIALDOCS', name: 'Financial Documents (bank statements, investments, support affidavit)', category: 'Financial',
        guidance: 'Higher funds raise approval chances. At least 3 months bank statements with no sudden deposits; investment proof in your name; notarized support affidavit if the assets belong to supporting family members.' },
      { code: 'ADDITIONALDOCS', name: 'Additional documents (Optional)', category: 'Other',
        guidance: 'Any other documents that support and justify why we need to apply for the extension of stay.' }
    ] },
    { role: 'Sponsor', label: 'Inviter / Sponsor', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with photo, name, signature, date/place of birth, place of issue and address.' },
      { code: 'CURRENTSTATUS', name: 'Current Status in the country', category: 'Identity',
        guidance: 'Status documents in Canada: study permit, work permit, Canadian passport or PR card. Canadian citizens: include the original country passport as well.' },
      { code: 'PROOFRELATIONSHIP', name: 'Proof of relationship', category: 'Relationship',
        guidance: 'Your case manager will advise which documents can be used based on your relationship with the applicant.' },
      { code: 'IDENTITYCIVIL', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Legal name/date-of-birth change documents; common-law declaration IMM5409; marriage/divorce/annulment certificates (each marriage if more than one); death certificate of former spouse/common-law partner; birth certificates of children — whichever apply.' },
      { code: 'PROOFLIVINGCANADA', name: 'Proof of living in Canada (any 1)', category: 'Identity',
        guidance: 'Any one of: driver’s licence (front and back), most recent credit card statement, most recent utility bill (electricity/gas), or provincial ID card.' },
      { code: 'INCOMEPROOF', name: 'Proof/source of Income (If you will support the applicant)', category: 'Financial',
        guidance: 'Notice of Assessment for last year and 3 months bank statements with good funds. If salaried: job letter (start date, title, salary, hours, duties), at least 3 pay slips, T4. If self-employed: business establishment/incorporation proof, 3 months business bank statements, documents proving the business is legal and genuine.' },
      { code: 'ADDITIONALFUNDS', name: 'Additional proof of Funds/investments/assets', category: 'Financial',
        guidance: 'Any funds, investments or assets that increase your net worth — disclose them with supporting documentation.' }
    ] }
  ],
};
