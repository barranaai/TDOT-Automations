'use strict';
// OINP Workforce Priority Stream — NEW client pathway (Express Entry/CEC
// profile creation + OINP EOI together). One of the two WPS sub-types added
// 2026-08-12 per the client's updated mapping Excel; the seven legacy OINP
// stream schemas stay registered untouched for existing clients.
//
// NOTE (per the source PDF's own closing note): this is the PROFILE-CREATION /
// EOI stage checklist only — more documents follow after an Invitation, from
// "Document Checklist- OINP- Ontario Workforce Priority stream.pdf", which is
// deliberately not wired yet.
module.exports = {
  caseType: "OINP",
  subType: "Workforce Priority Stream + CEC Profile (New Client)",
  schemaVersion: 1,
  source: "Document Checklist Items/Provincial Nominee Programs/Ontario/Document Checklist- Cec Profile creation +OINP EOI 1.pdf",
  reviewedBy: 'Claude (from the client-supplied EOI checklist PDF, 2026-08-12)',
  reviewedAt: '2026-08-12',
  caseFlags: {
    spouseIncluded: { label: 'An accompanying spouse/partner is included in the application' },
    childrenIncluded: { label: 'One or more dependent children (under 18) are included in the application' }
  },
  memberFlags: {
    hasCanadianSibling: { label: 'Applicant has a sibling living in Canada' }
  },
  roles: [
    { role: 'PrincipalApplicant', label: 'Principal Applicant', required: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus copies of your old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach every permit issued to you in Canada as a visitor, student or worker.' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic',
        guidance: 'Language test results must not be older than two years upon date of receipt.' },
      { code: 'JOBOFFERID', name: 'Job Offer ID', category: 'Other',
        guidance: 'Once your employer has successfully created a job offer in the OINP employer portal, you (the employee) receive an email with a Job Offer ID. That Job Offer ID is used to register your EOI.' },
      { code: 'CANEDU', name: 'Canadian Education Documents', category: 'Academic',
        guidance: 'Complete academic records and credentials: marksheets (detailed report cards or official transcripts showing the grades obtained in each subject for every year or semester) and certificates verifying completion of each course, degree, diploma or other qualification.' },
      { code: 'FOREIGNEDU', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic',
        guidance: 'Marksheets and certificates for your complete academic history, plus an Educational Credential Assessment (ECA) report comparing your foreign education to Canadian standards — providers include CES (University of Toronto), ICAS, ICES, IQAS and WES. More information: https://www.canada.ca/en/immigration-refugees-citizenship/corporate/partners-service-providers/immigrant-serving-organizations/best-practices/foreign-educational-credential-assessment.html' },
      { code: 'SIBLINGPROOF', name: 'Sibling — Proof of living in Canada', category: 'Identity', includeWhen: { memberFlag: 'hasCanadianSibling' },
        guidance: 'If applicable: your sibling’s driver’s licence (front and back), passport (front and back), PR card (front and back) or Canadian passport, birth certificate or 10th–12th marksheets, and their most recent utility bill.' },
      { code: 'WORKEXP', name: 'Proof of work experience for the claiming period (Inside and Outside Canada)', category: 'Financial',
        guidance: 'Full-time or part-time, for all claimed periods: all paystubs/pay slips for the claiming experience (paystubs summarize gross pay, taxes, deductions and net pay) OR bank statements showing salary deposits OR employer letter(s) confirming your annual salary/hourly wage (salary certificate); plus T4 (Statement of Remuneration Paid) or Form 16; plus an employment/reference letter for all qualifying periods (template available on request — start on these as soon as your profile is created). If an employment letter is not available, provide on a Word document: job title, working hours, hourly wage since the start of your position, and a detailed job description (important for determining the correct NOC and TEER category).' },
      { code: 'IDCIVIL', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Marriage certificate; final divorce or annulment certificate (from each marriage if married more than once); death certificate for a former spouse or common-law partner; common-law declaration IMM5409; birth certificates of children; legal documents showing name or date-of-birth changes — whichever apply.' },
    ] },
    { role: 'Spouse', label: 'Dependant Spouse/Partner', includeWhen: { caseFlag: 'spouseIncluded' }, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with your photo, name, signature, date/place of birth, place of issue and address — plus copies of your old and current passports showing entry/exit immigration stamps from countries you travelled to.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach every permit issued to you in Canada as a visitor, student or worker.' },
      { code: 'LANGUAGE', name: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/TCF Canada)', category: 'Academic',
        guidance: 'Language test results must not be older than two years upon date of receipt.' },
      { code: 'CANEDU', name: 'Canadian Education Documents', category: 'Academic',
        guidance: 'Complete academic records and credentials: marksheets and certificates verifying completion of each course, degree, diploma or other qualification.' },
      { code: 'FOREIGNEDU', name: 'Foreign Education Documents along with Educational Credential Assessment', category: 'Academic',
        guidance: 'Marksheets and certificates for the complete academic history, plus an Educational Credential Assessment (ECA) report — providers include CES (University of Toronto), ICAS, ICES, IQAS and WES.' },
      { code: 'WORKEXP', name: 'Proof of work experience for the claiming period (Inside and Outside Canada)', category: 'Financial',
        guidance: 'Full-time or part-time, for all claimed periods: paystubs OR bank statements showing salary deposits OR employer letter(s) confirming annual salary/hourly wage; plus T4 or Form 16; plus an employment/reference letter for the qualifying periods (template available on request).' },
      { code: 'IDCIVIL', name: 'Identity and Civil Documents', category: 'Identity',
        guidance: 'Marriage certificate; final divorce or annulment certificate; death certificate for a former spouse or common-law partner; common-law declaration IMM5409; birth certificates of children; legal documents showing name or date-of-birth changes — whichever apply.' },
    ] },
    { role: 'DependentChild', label: 'Dependant Child (under 18)', includeWhen: { caseFlag: 'childrenIncluded' }, multipleAllowed: true, documents: [
      { code: 'PASSPORT', name: 'Passport with all stamped pages', category: 'Identity',
        guidance: 'Pages with the child’s photo, name, signature, date/place of birth, place of issue and address — plus old and current passports showing entry/exit immigration stamps.' },
      { code: 'PERMITS', name: 'All Permits ever held in Canada', category: 'Identity',
        guidance: 'Attach every permit issued in Canada as a visitor, student or worker.' },
      { code: 'BIRTHCERT', name: 'Birth Certificate', category: 'Identity',
        guidance: 'Must be government-issued and show the parents’ names.' },
    ] },
  ],
};
