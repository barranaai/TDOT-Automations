/**
 * rebuildTemplateBoards.js
 *
 * Rebuilds the Document Checklist Template Board and Questionnaire Template Board
 * from scratch, using:
 *   - config/caseTypes.js  (canonical 56 Case Types + Sub Types)
 *   - Applications- Subtypes- Document Checklists-Questionnaire.xlsx  (mapping)
 *   - Document Checklist Items/  (PDF checklists)
 *   - Questionnair Documents/    (DOCX questionnaires)
 *
 * Run AFTER clearing both boards:
 *   node src/scripts/rebuildTemplateBoards.js
 */

require('dotenv').config();
const path     = require('path');
const fs       = require('fs');
const XLSX     = require('xlsx');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const mondayApi = require('../services/mondayApi');
const { CASE_TYPES } = require('../../config/caseTypes');

const ROOT = path.join(__dirname, '../../');

// ─── Board / column IDs ────────────────────────────────────────────────────
const DOC_BOARD  = process.env.MONDAY_TEMPLATE_BOARD_ID              || '18401624183';
const Q_BOARD    = process.env.MONDAY_QUESTIONNAIRE_TEMPLATE_BOARD_ID || '18402113809';

// Doc Checklist Template columns
const DOC_COLS = {
  caseType:    'dropdown_mm0x7zb4',
  subType:     'dropdown_mm204y6w',
  category:    'dropdown_mm0x41zm',
  version:     'dropdown_mm0xm5zg',
  required:    'dropdown_mm0x9v5q',
  reviewer:    'dropdown_mm0zfq2v',
  source:      'dropdown_mm0z8ztk',
  format:      'dropdown_mm0za6r4',
};

// Questionnaire Template columns
const Q_COLS = {
  caseType:  'dropdown_mm124p5v',
  subType:   'dropdown_mm20h84d',
  category:  'dropdown_mm12w5fd',
  version:   'dropdown_mm12spk7',
  required:  'dropdown_mm12dqc7',
  inputType: 'dropdown_mm12pn7g',
};

// ─── Excel mapping ─────────────────────────────────────────────────────────
function loadExcel() {
  const wb   = XLSX.readFile(path.join(ROOT, 'Applications- Subtypes- Document Checklists-Questionnaire.xlsx'));
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows.map(r => ({
    excelCaseType:   String(r['Case Type'] || '').trim(),
    checklistName:   String(r['Checklist Name'] || '').trim(),
    questionnaireName: String(r['Questionnaire Name'] || '').trim(),
    additionalQ:     String(r['Additional Questionnaire Name'] || '').trim(),
  }));
}

// ─── Excel Case Type → Canonical Case Type + Sub Type mapping ─────────────
// Maps the (sometimes slightly different) Excel case type names to our canonical names
const EXCEL_TO_CANONICAL = {
  'AAIP':                                                               { caseType: 'AAIP' },
  'OINP':                                                               { caseType: 'OINP' },
  'NSNP':                                                               { caseType: 'NSNP' },
  'BCPNP':                                                              { caseType: 'BCPNP' },
  'RCIP':                                                               { caseType: 'RCIP' },
  'Manitoba PNP':                                                       { caseType: 'Manitoba PNP' },
  'RNIP':                                                               { caseType: 'RNIP' },
  'SNIP':                                                               { caseType: 'SNIP' },
  'Canadian Experience Class (Profile Recreation+ITA+Submission)':      { caseType: 'Canadian Experience Class (Profile Recreation+ITA+Submission)' },
  'Canadian Experience Class (Profile+ITA+Submission)':                 { caseType: 'Canadian Experience Class (Profile+ITA+Submission)' },
  'EE after ITA ( ITA+submission)':                                     { caseType: 'Canadian Experience Class (EE after ITA)' },
  'Inland Spousal Sponsorship (Marriage)':                              { caseType: 'Inland Spousal Sponsorship', subType: 'Marriage' },
  'Inland Spousal Sponsorship (Common law)':                            { caseType: 'Inland Spousal Sponsorship', subType: 'Common Law Partner' },
  'Outland Spousal Sonsorship (Marriage)':                              { caseType: 'Outland Spousal Sponsorship' },
  'Parents/Grandparents Sponsorship':                                   { caseType: 'Parents/Grandparents Sponsorship' },
  'Child Sponsorship':                                                  { caseType: 'Child Sponsorship' },
  'Addition of Spouse':                                                 { caseType: 'Addition of Spouse' },
  'Federal PR':                                                         { caseType: 'Federal PR' },
  'BOWP':                                                               { caseType: 'BOWP' },
  'Co-op WP':                                                           { caseType: 'Co-op WP' },
  'Concurrent WP':                                                      { caseType: 'Concurrent WP' },
  'LMIA Based WP (Inside Canada)':                                      { caseType: 'LMIA Based WP', subType: 'Inside Canada' },
  'LMIA based WP Extension':                                            { caseType: 'LMIA Based WP', subType: 'Extension (Inside Canada)' },
  'LMIA Based WP (Outside Canada)':                                     { caseType: 'LMIA Based WP', subType: 'Outside Canada' },
  'LMIA Exempt WP':                                                     { caseType: 'LMIA Exempt WP' },
  'PGWP':                                                               { caseType: 'PGWP', subType: 'Single Applicant' },
  'PGWP Extension':                                                     { caseType: 'PGWP' },
  'Refugee WP':                                                         { caseType: 'Refugee WP' },
  'SCLPC WP':                                                           { caseType: 'SCLPC WP' },
  'SOWP Inland':                                                        { caseType: 'SOWP' },
  'SOWP Outland':                                                       { caseType: 'SOWP', subType: 'Outland (Spouse or Child)' },
  'SOWP Extension ':                                                    { caseType: 'SOWP', subType: 'Extension (Spouse or Child)' },
  'SOWP Extension':                                                     { caseType: 'SOWP', subType: 'Extension (Spouse or Child)' },
  'NB WP Extension':                                                    { caseType: 'NB WP Extension' },
  'Francophone Mobility WP':                                            { caseType: 'Francophone Mobility WP' },
  'Supervisa- Parents':                                                 { caseType: 'Supervisa', subType: 'Parents' },
  'Supervisa- Grandparents':                                            { caseType: 'Supervisa', subType: 'Grandparents' },
  'Employer Portal':                                                    { caseType: 'Employer Portal' },
  'LMIA':                                                               { caseType: 'LMIA' },
  'ETA':                                                                { caseType: 'ETA' },
  'PR Card Renewal':                                                    { caseType: 'PR Card Renewal' },
  'PRTD':                                                               { caseType: 'PRTD' },
  'Renunciation of PR':                                                 { caseType: 'Renunciation of PR' },
  'Citizenship':                                                        { caseType: 'Citizenship' },
  'TRP':                                                                { caseType: 'TRP' },
  'TRV':                                                                { caseType: 'TRV' },
  'Visitor Record+Restoration':                                         { caseType: 'Visitor Record / Extension', subType: 'Visitor Record + Restoration' },
  'Visitor Extension':                                                  { caseType: 'Visitor Record / Extension', subType: 'Visitor Extension' },
  'Visitor Record ':                                                    { caseType: 'Visitor Record / Extension', subType: 'Visitor Record' },
  'Visitor Record':                                                     { caseType: 'Visitor Record / Extension', subType: 'Visitor Record' },
  'Visitor Visa':                                                       { caseType: 'Visitor Visa' },
  'USA Visa':                                                           { caseType: 'USA Visa' },
  'Misc':                                                               { caseType: 'Miscellaneous' },
  'PFL':                                                                { caseType: 'PFL' },
  'Reconsideration':                                                    { caseType: 'Reconsideration' },
  'Request Letter':                                                     { caseType: 'Request Letter' },
  'Refugee':                                                            { caseType: 'Refugee' },
  'H & C':                                                              { caseType: 'H & C' },
  'Appeal':                                                             { caseType: 'Appeal' },
  'Amendment of document':                                              { caseType: 'Amendment of Document' },
  'ICAS/WES/IQAS':                                                      { caseType: 'ICAS/WES/IQAS' },
  'Invitation letter':                                                  { caseType: 'Invitation Letter' },
  'Notary':                                                             { caseType: 'Notary' },
  'OCI +Passport Surrender':                                            { caseType: 'OCI / Passport Surrender' },
  'PRAA':                                                               { caseType: 'PRAA' },
  'Study Permit  ':                                                     { caseType: 'Study Permit' },
  'Study Permit':                                                       { caseType: 'Study Permit' },
  'Study Permit Extension':                                             { caseType: 'Study Permit Extension' },
};

// Checklist sub-type from Excel "Checklist Name" (for cases where the row implies a sub-type via checklist name)
const CHECKLIST_NAME_TO_SUBTYPE = {
  // AAIP
  'Tourism & Hopsitality Stream':       'Tourism & Hospitality Stream',
  'Rural Renewal Stream':               'Rural Renewal Stream',
  'Opportunity Stream':                 'Opportunity Stream',
  'Express Entry Stream':               'Express Entry Stream',
  // OINP
  'International Student Stream':       'International Student Stream',
  'Foreign Worker Stream':              'Foreign Worker Stream',
  'Skilled Trades Stream':              'Skilled Trades Stream',
  'Human Capital Priorities Stream':    'Human Capital Priorities Stream',
  'In demand Skills Stream':            'In-demand Skills Stream',
  'PhD Graduate Stream':                'PhD Graduate Stream',
  'Masters Graduate Stream':            'Masters Graduate Stream',
  // BCPNP
  'BC PNP+ Company Info BCPNP':         'BC PNP+ Company Info',
  // Federal PR
  'Non Express Entry- Accompanying spouse & child':  'Non Express Entry - Accompanying Spouse & Child',
  'Non Express Entry- Non accompanying spouse ':     'Non Express Entry - Non Accompanying Spouse',
  // CEC
  'CEC Single Applicant':               'CEC Single Applicant',
  'CEC Accompanying spouse & child':    'CEC Accompanying Spouse & Child',
  // PGWP extensions
  'Document Checklist- PGWP Extension - Accompanying spouse established relationship or child- Passport Validity': 'Extension - Accompanying Spouse/Child',
  'Document Checklist- PGWP Extension (Single Applicant)- Passport Validity': 'Extension - Single Applicant',
  // SOWP Inland (both with and without trailing space as Excel has trailing spaces)
  'SOWP (Worker spouse) established relationship ':    'Inland - Established Relationship',
  'SOWP (Worker spouse) established relationship':     'Inland - Established Relationship',
  'SOWP (Worker spouse) non established relationship ': 'Inland - Non Established Relationship',
  'SOWP (Worker spouse) non established relationship':  'Inland - Non Established Relationship',
  // Study Permit
  'Document Checklist- Study Permit - Single Applicant': 'Single Applicant',
  'Document Checklist- Study Permit- Non SDS Stream- Accompanying spouse or child': 'Non SDS - Accompanying Spouse or Child',
  'Document Checklist- Study Permit for dependent child- Outland': 'Dependent Child (Outland)',
  'Document Checklist- Study Permit-Change of status (Visitor to Student) Single Applicant': 'Change of Status (Visitor to Student)',
  // Study Permit Extension
  'Document Checklist- Study Permit  Extension- Single applicant': 'Single Applicant',
  'Document Checklist- Study Permit  Extension- Accompanying spouse or child': 'Accompanying Spouse or Child',
  // Visitor Visa
  'Visitor Visa- Both Parents':        'Both Parents',
  'Visitor Visa- Single Parent':       'Single Parent',
  'Visitor Visa- 1 ,2 or 3 members':  '1-3 Members',
  'Visitor Visa- 1 or 2 members':     '1-2 Members',
  'Visitor Visa- parents & siblings':  'Parents & Siblings',
  'Visitor Visa- Spouse':              'Spouse',
  'Visitor Visa- change of status( from student/worker)': 'Change of Status (Student/Worker to Visitor)',
  'Visitor Visa- Spousal Sponsorship in Process': 'Spousal Sponsorship in Process',
  // Supervisa
  'Supervisa- Parents':    'Parents',
  'Supervisa- Grandparents': 'Grandparents',
};

// ─── PDF file mapping: checklist name → PDF path ──────────────────────────
const PDF_BASE = path.join(ROOT, 'Document Checklist Items');
const CHECKLIST_TO_PDF = {
  // AAIP
  'Tourism & Hopsitality Stream':       path.join(PDF_BASE, 'Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Tourism & Hospitality Stream.pdf'),
  'Rural Renewal Stream':               path.join(PDF_BASE, 'Provincial Nominee Programs/Alberta/Document Checklist- AAIP-Rural Renewal Stream.pdf'),
  'Opportunity Stream':                 path.join(PDF_BASE, 'Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Opportunity Stream.pdf'),
  'Express Entry Stream':               path.join(PDF_BASE, 'Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Express Entry Stream.pdf'),
  // OINP
  'International Student Stream':       path.join(PDF_BASE, 'Provincial Nominee Programs/Ontario/Document Checklist- OINP- International Student Stream.pdf'),
  'Foreign Worker Stream':              path.join(PDF_BASE, 'Provincial Nominee Programs/Ontario/Document Checklist- OINP- Foreign Worker Stream.pdf'),
  'Skilled Trades Stream':              path.join(PDF_BASE, 'Provincial Nominee Programs/Ontario/Document Checklist- OINP- Skilled Trades Stream.pdf'),
  'Human Capital Priorities Stream':    path.join(PDF_BASE, 'Provincial Nominee Programs/Ontario/Document Checklist- OINP- Human Capital Priorities Stream.pdf'),
  'In demand Skills Stream':            path.join(PDF_BASE, 'Provincial Nominee Programs/Ontario/Document Checklist- OINP- In-Demand Skills Stream.pdf'),
  'PhD Graduate Stream':                path.join(PDF_BASE, 'Provincial Nominee Programs/Ontario/Document Checklist- OINP- PhD Graduate Stream.pdf'),
  'Masters Graduate Stream':            path.join(PDF_BASE, 'Provincial Nominee Programs/Ontario/Document Checklist- OINP- Masters Graduate Stream.pdf'),
  // NSNP
  'NSNP':                               path.join(PDF_BASE, 'Provincial Nominee Programs/Nova Scotia/Document Checklist-NSNP.pdf'),
  // BCPNP
  'BC PNP+ Company Info BCPNP':         path.join(PDF_BASE, 'Provincial Nominee Programs/British Columbia/Document Checklist-BC PNP.pdf'),
  // CEC
  'CEC Single Applicant':               path.join(PDF_BASE, 'CEC/Document Checklist- CEC- Single applicant.pdf'),
  'CEC Accompanying spouse & child':    path.join(PDF_BASE, 'CEC/Document Checklist- CEC- Accompanying spouse and child.pdf'),
  // Spousal
  'Spousal Sponsorship Inland':         path.join(PDF_BASE, 'Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Inland.pdf'),
  'Spousal Sponsorship Outland':        path.join(PDF_BASE, 'Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Outland.pdf'),
  'Common Law Partner Inland':          path.join(PDF_BASE, 'Spousal Sponsorship/Document Checklist- Common Law Partner- Inland.pdf'),
  // Parents/Grandparents
  'Parents & Grandparents Sponsorship': path.join(PDF_BASE, 'Parents and Grandparents/Document Checklist- Parents & Grandparents Sponsorship.pdf'),
  'Children Sponsorship':               null, // no file found
  'Addition of Spouse':                 null,
  // Federal PR
  'Non Express Entry- Accompanying spouse & child':  path.join(PDF_BASE, 'Non-Express Entry/Document Checklist- Non-Express Entry- Accompanying spouse and child.pdf'),
  'Non Express Entry- Non accompanying spouse ':     path.join(PDF_BASE, 'Non-Express Entry/Document Checklist- Non-Express Entry- Non accompanying spouse.pdf'),
  // Work Permits
  'Document Checklist- BOWP- Single ,accompanying spouse or child.pdf': path.join(PDF_BASE, 'Work Permits/Document Checklist- BOWP- Single ,accompanying spouse or child.pdf'),
  'PGWP Single applicant':              path.join(PDF_BASE, 'Work Permits/Document Checklist- PGWP (Single Applicant).pdf'),
  'Document Checklist- Concurrent Work permit- Single or accompanying spouse.pdf': path.join(PDF_BASE, 'Work Permits/Document Checklist- Concurrent Work permit- Single or accompanying spouse.pdf'),
  'Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Inside Canada.pdf': path.join(PDF_BASE, 'Work Permits/Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Inside Canada.pdf'),
  'Document Checklist- LMIA Based Work permit Extension- Single or accompanying spouse- Inside Canada': path.join(PDF_BASE, 'Work Permits/Document Checklist- LMIA Based Work permit Extension- Single or accompanying spouse- Inside Canada.pdf'),
  'Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Outside Canada': path.join(PDF_BASE, 'Work Permits/Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Outside Canada.pdf'),
  'Document Checklist- LMIA exempt Work permit- Single or accompanying spouse': path.join(PDF_BASE, 'Work Permits/Document Checklist- LMIA exempt Work permit- Single or accompanying spouse.pdf'),
  'Document Checklist- PGWP Extension - Accompanying spouse established relationship or child- Passport Validity': path.join(PDF_BASE, 'Work Permits/Document Checklist- PGWP Extension - Accompanying spouse established relationship or child- Passport Validity.pdf'),
  'Document Checklist- PGWP Extension (Single Applicant)- Passport Validity': path.join(PDF_BASE, 'Work Permits/Document Checklist- PGWP Extension (Single Applicant)- Passport Validity.pdf'),
  'SOWP (Spousal Sponsorship in process)': path.join(PDF_BASE, 'Work Permits/Document Checklist- SOWP (Spousal Sponsorship in process).pdf'),
  'SOWP (Worker spouse) established relationship ':  path.join(PDF_BASE, 'Work Permits/Document Checklist- SOWP (Worker Spouse)- Established Relationship-Inland.pdf'),
  'SOWP (Worker spouse) established relationship':   path.join(PDF_BASE, 'Work Permits/Document Checklist- SOWP (Worker Spouse)- Established Relationship-Inland.pdf'),
  'SOWP (Worker spouse) non established relationship ': path.join(PDF_BASE, 'Work Permits/Document Checklist- SOWP (Worker Spouse)- Non established Relationship-Inland.pdf'),
  'SOWP (Worker spouse) non established relationship':  path.join(PDF_BASE, 'Work Permits/Document Checklist- SOWP (Worker Spouse)- Non established Relationship-Inland.pdf'),
  'SOWP (Worker spouse) - spouse or child outland': path.join(PDF_BASE, 'Work Permits/Document Checklist- SOWP (Worker Spouse)- spouse or child- Outland.pdf'),
  'SOWP Extension (worker spouse)- spouse or child': path.join(PDF_BASE, 'Work Permits/Document Checklist- SOWP Extension (Worker Spouse)- spouse or child.pdf'),
  'Work Permit Extension (NB)- Single or accompanying spouse': path.join(PDF_BASE, 'Work Permits/Document Checklist- Work Permit Extension (NB) - Single or accompanying spouse.pdf'),
  // Supervisa
  'Supervisa- Parents':     path.join(PDF_BASE, 'Supervisa/Document Checklist- Supervisa- Parents.pdf'),
  'Supervisa- Grandparents': path.join(PDF_BASE, 'Supervisa/Document Checklist- Supervisa- GrandParents.pdf'),
  // PR Card
  'PR Card Renewal- Accompanying spouse or child': path.join(PDF_BASE, 'PR Card/Document Checklist- PR Card Renewal-Accompanying spouse or child.pdf'),
  'PRTD- Accompanying spouse or child': path.join(PDF_BASE, 'PR Card/Document Checklist- PRTD- Accompanying spouse or child.pdf'),
  'Voluntary Renunciation of PR- Accompanying spouse or child': path.join(PDF_BASE, 'PR Card/Document Checklist-Voluntary Renunciation of PR- Accompanying spouse or child.pdf'),
  // Citizenship
  'Citizenship- Accompanying spouse & child': path.join(PDF_BASE, 'Citizenship/Document Checklist- Citizenship- Accompanying spouse or child.pdf'),
  // Visitor
  'TRV':                             path.join(PDF_BASE, 'Visitor/Document Checklist- TRV.pdf'),
  'Visitor Record (extension)':      path.join(PDF_BASE, 'Visitor/Document Checklist- Visitor Record (extension).pdf'),
  'Visitor Visa- Both Parents':      path.join(PDF_BASE, 'Visitor/Document Checklist- Visitor Visa- Both Parents.pdf'),
  'Visitor Visa- Single Parent':     path.join(PDF_BASE, 'Visitor/Document Checklist- Visitor Visa-  Single Parent.pdf'),
  'Visitor Visa- 1 ,2 or 3 members': path.join(PDF_BASE, 'Visitor/Document Checklist- Visitor Visa-  1,2 or 3 members.pdf'),
  'Visitor Visa- 1 or 2 members':    path.join(PDF_BASE, 'Visitor/Document Checklist- Visitor Visa- 1 or 2 members.pdf'),
  'Visitor Visa- parents & siblings': path.join(PDF_BASE, 'Visitor/Document Checklist- Visitor Visa-  Parents and siblings.pdf'),
  'Visitor Visa- Spouse':            path.join(PDF_BASE, 'Visitor/Document Checklist- Visitor Visa- Spouse.pdf'),
  'Visitor Visa- change of status( from student/worker)': path.join(PDF_BASE, 'Visitor/Document Checklist- Visitor Visa- Change of Status (from student or worker).pdf'),
  'Visitor Visa- Spousal Sponsorship in Process': path.join(PDF_BASE, 'Visitor/Document Checklist- Visitor Visa- Spouse  (Spousal Sponsorship in process).pdf'),
  // Study Permit
  'Document Checklist- Study Permit - Single Applicant': path.join(PDF_BASE, 'Study Permit/Document Checklist- Study Permit - Single Applicant.pdf'),
  'Document Checklist- Study Permit- Non SDS Stream- Accompanying spouse or child': path.join(PDF_BASE, 'Study Permit/Document Checklist- Study Permit- Non SDS Stream- Accompanying spouse or child.pdf'),
  'Document Checklist- Study Permit for dependent child- Outland': path.join(PDF_BASE, 'Study Permit/Document Checklist- Study Permit for dependent child- Outland.pdf'),
  'Document Checklist- Study Permit-Change of status (Visitor to Student) Single Applicant': path.join(PDF_BASE, 'Study Permit/Document Checklist- Study Permit-Change of status (Visitor to Student) Single Applicant.pdf'),
  'Document Checklist- Study Permit  Extension- Single applicant': path.join(PDF_BASE, 'Study Permit/Document Checklist- Study Permit  Extension- Single applicant.pdf'),
  'Document Checklist- Study Permit  Extension- Accompanying spouse or child': path.join(PDF_BASE, 'Study Permit/Document Checklist- Study Permit  Extension- Accompanying spouse or child.pdf'),
};

// ─── DOCX file mapping: questionnaire name → DOCX path ───────────────────
const DOCX_BASE = path.join(ROOT, 'Questionnair Documents');
const Q_TO_DOCX = {
  '1. Express Entry - PNP - PR Application -  Questionnaire - April 2025':
    path.join(DOCX_BASE, '1. Express Entry - PNP - PR Application -  Questionnaire - April 2025.docx'),
  '2. Work Permit Application Inside Canada (PGWP -SOWP- BOWP -LMIA - EXTENSION  - Questionnaire - April 2025':
    path.join(DOCX_BASE, '2. Work Permit Application Inside Canada (PGWP -SOWP- BOWP -LMIA - EXTENSION  - Questionnair - April 2025.docx'),
  '3. Work Permit Outside Canada (SOWP - LMIA )- Questionnaires - April 2025':
    path.join(DOCX_BASE, '3. Work Permit Outside Canada (SOWP - LMIA )- Questionnaires - April 2025.docx'),
  '4. Citizenship - Questionnaires - April 2025':
    path.join(DOCX_BASE, '4. Citizenship - Questionnaires - April 2025.docx'),
  '5. Study Permit Extension - Questionnaires - April 2025':
    path.join(DOCX_BASE, '5. Study Permit Extension - Questionnaires - April 2025.docx'),
  '6. Express Entry Profile Creation - Questionnair - July 2025':
    path.join(DOCX_BASE, '6. Express Entry Profile - PNP Profile Creation - Questionnair - July 2025.docx'),
  '7. Study Permit - Inside and Outside  - Questionnaires - April 2025':
    path.join(DOCX_BASE, '7. Study Permit - Inside and Outside  - Questionnaires - April 2025.docx'),
  '8. Visitor Visa - Outside  - Questionnaire - April 2025':
    path.join(DOCX_BASE, '8. VisItor Visa - Outside  - Questionnaires - April 2025.docx'),
  '9. Lost PR Card - PR Card Renewal  - Questionnair - April 2025':
    path.join(DOCX_BASE, '9. Lost PR Card - PR Card Renewal - PR TD   - Questionnair - April 2025.docx'),
  '10. Spousal Sponsorship Questionnaires - Inside and Outside - April 2025':
    path.join(DOCX_BASE, '10. Spousal Sponsorship Quetsionaires - Inside and Outside - April 2025.docx'),
  '11. Super Visa - Outside  - Questionnaires - April 2025':
    path.join(DOCX_BASE, '11. Super Visa - Outside  - Questionnaires - April 2025.docx'),
  '12. Visitor Visa Extension - Questionnaire - April 2025':
    path.join(DOCX_BASE, '12. Visitor Visa Extension - Questionnair - April 2025.docx'),
  '13. TRV - Questionnaire - April 2025':
    path.join(DOCX_BASE, '13. TRV - Questionnair - April 2025.docx'),
  '14. Indian Passport Surrender Application':
    path.join(DOCX_BASE, 'Indian Passport Surrender Application.docx'),
  '15. Parents/Grandparents/Children sponsorship Questionnaire':
    null,
  '16. Addition of spouse- Relationship Questionnaire':
    null,
  '17. USA Visa  -  Questionnaire - April 2025':
    path.join(DOCX_BASE, 'USA Visa  -  Questionnaire - April 2025.docx'),
};

// ─── Document category inference ──────────────────────────────────────────
const DOC_CATEGORY_RULES = [
  [/passport|photo|birth certificate|pr card|citizenship card|status card|travel document|id card|identity|sin\b|national id|marriage certificate/i, 'Identity'],
  [/bank statement|proof of funds|savings|financial|income|tax|noa|pay stub|investment|asset|rrsp|tfsa|fund/i, 'Financial'],
  [/degree|transcript|diploma|education|academic|school|college|university|evaluation|wes|icas|iqas|credential/i, 'Education'],
  [/employment|job offer|lmia|support letter|pay\s?stub|t4|record of employment|roe|offer of employment|work\s?contract|business/i, 'Employment'],
  [/travel|entry|exit|stamp|itinerary|return ticket|boarding|flight/i, 'Travel'],
  [/medical|health|vaccination|vaccine|inoculation|panel physician|exam report/i, 'Medical'],
  [/police|clearance|criminal|background check|pcc|court/i, 'Legal'],
];
function inferDocCategory(name) {
  for (const [re, cat] of DOC_CATEGORY_RULES) {
    if (re.test(name)) return cat;
  }
  return 'Other';
}

// ─── PDF parser ────────────────────────────────────────────────────────────
const CHECKBOX_RE = /^[\s\u00a0]*[☐\u2610\u25a1]\s*/;
const NOISE_RE    = /^(Page \d+|www\.|Disclaimer:|Documents for |Document Checklist:|Your application|20 De Boers|\d+ of \d+$)/i;

async function parsePdf(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const buf  = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    const lines = data.text.split('\n').map(l => l.trim()).filter(Boolean);
    const items = [];
    let current      = null;
    let expectName   = false;  // true when ☐ was on its own line, next non-noise line is the name

    for (const line of lines) {
      const isCheckboxOnly = CHECKBOX_RE.test(line) && line.replace(CHECKBOX_RE, '').trim() === '';
      const isCheckboxWithName = CHECKBOX_RE.test(line) && line.replace(CHECKBOX_RE, '').trim() !== '';
      const isNoise = NOISE_RE.test(line);

      if (isCheckboxWithName) {
        // Pattern A: "☐ Passport with all stamped pages"
        if (current) items.push(current);
        const name = line.replace(CHECKBOX_RE, '').trim();
        current = { name, description: '' };
        expectName = false;
      } else if (isCheckboxOnly) {
        // Pattern B: "☐" alone — next non-noise line is the name
        if (current) items.push(current);
        current = null;
        expectName = true;
      } else if (expectName && !isNoise && line.length > 1) {
        // The line after a lone ☐ — this is the document name
        current = { name: line, description: '' };
        expectName = false;
      } else if (current && !isNoise) {
        // Description continuation line
        current.description += (current.description ? ' ' : '') + line;
      }
    }
    if (current) items.push(current);
    return items;
  } catch (e) {
    console.warn('  PDF parse error:', path.basename(filePath), '-', e.message);
    return [];
  }
}

// ─── DOCX parser ───────────────────────────────────────────────────────────
const SECTION_TO_CATEGORY = {
  'profile': 'Personal', 'personal': 'Personal', 'family': 'Personal',
  'address': 'Personal', 'marital': 'Personal', 'contact': 'Personal',
  'travel': 'Travel', 'trip': 'Travel', 'immigration': 'Travel',
  'education': 'Education', 'academic': 'Education',
  'employment': 'Employment', 'work': 'Employment', 'occupation': 'Employment', 'job': 'Employment',
  'background': 'Background', 'criminal': 'Background', 'health': 'Background', 'medical': 'Background',
  'financial': 'Financial', 'finance': 'Financial', 'income': 'Financial', 'asset': 'Financial',
  'legal': 'Legal', 'sponsor': 'Legal', 'relationship': 'Legal',
};

function inferCategory(sectionHeader) {
  const lower = (sectionHeader || '').toLowerCase();
  for (const [key, cat] of Object.entries(SECTION_TO_CATEGORY)) {
    if (lower.includes(key)) return cat;
  }
  return 'Personal';
}

async function parseDocx(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    const lines  = result.value.split('\n').map(l => l.trim()).filter(Boolean);
    const items  = [];
    let category = 'Personal';
    for (const line of lines) {
      // Section header detection (short lines that look like section titles)
      if (line.match(/^section\s+\d/i) || line.match(/^(personal|family|travel|education|employment|background|financial|legal|address|marital|contact|immigration|sponsor|relationship)/i)) {
        category = inferCategory(line);
        continue;
      }
      // Skip table headers, one-char lines, and page-level noise
      if (
        line.length < 3 ||
        line.match(/^(DD\/MM|From|To|Date|Family Name|Given Name|Relationship|Country|Province|City|Street|Unit|Postal)/i) ||
        line.match(/^(PLEASE READ|Questionnaire for|Main Applicant|Dependent Spouse|Accompanying)/i) ||
        line.match(/^(\d+\.?\s*$)/) ||
        line.match(/^\(.*\)$/) ||
        line.match(/https?:\/\//)
      ) continue;
      items.push({ name: line, category });
    }
    return items;
  } catch (e) {
    console.warn('  DOCX parse error:', path.basename(filePath), '-', e.message);
    return [];
  }
}

// ─── Monday.com helpers ────────────────────────────────────────────────────
async function createGroup(boardId, title) {
  const data = await mondayApi.query(
    `mutation { create_group(board_id: "${boardId}", group_name: "${title.replace(/"/g, '\\"')}") { id } }`
  );
  return data?.create_group?.id;
}

async function createItem(boardId, groupId, itemName, colValues) {
  const cvJson = JSON.stringify(JSON.stringify(colValues));
  const data = await mondayApi.query(
    `mutation {
       create_item(
         board_id: "${boardId}",
         group_id: "${groupId}",
         item_name: ${JSON.stringify(itemName)},
         column_values: ${cvJson}
       ) { id }
     }`
  );
  return data?.create_item?.id;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ──────────────────────────────────────────────────────────────────
async function run() {
  console.log('=== Rebuilding Template Boards ===\n');
  const excelRows = loadExcel();
  console.log('Loaded', excelRows.length, 'Excel rows\n');

  // ── Step 1: Fetch existing groups (already created) ───────────────────────
  console.log('Fetching existing groups...');
  const docGroups = {};
  const qGroups   = {};

  const gData = await mondayApi.query(
    `query {
       docBoard: boards(ids: ["${DOC_BOARD}"]) { groups { id title } }
       qBoard:   boards(ids: ["${Q_BOARD}"])   { groups { id title } }
     }`
  );
  for (const g of gData.docBoard[0].groups) docGroups[g.title] = g.id;
  for (const g of gData.qBoard[0].groups)   qGroups[g.title]   = g.id;

  console.log('Doc groups found:', Object.keys(docGroups).length);
  console.log('Q groups found:',   Object.keys(qGroups).length, '\n');

  // ── Step 2: Build per-group task list from Excel rows ────────────────────
  const docTasks = {};  // caseType → [{ subType, pdfPath }]
  const qTasks   = {};  // caseType → [{ subType, docxPaths[] }]

  for (const row of excelRows) {
    const canon = EXCEL_TO_CANONICAL[row.excelCaseType];
    if (!canon) {
      console.warn('⚠ Unknown Excel case type:', row.excelCaseType);
      continue;
    }
    const ct = canon.caseType;
    // Determine sub-type: prefer the explicit mapping, fall back to checklist name lookup
    let st = canon.subType || CHECKLIST_NAME_TO_SUBTYPE[row.checklistName] || '';

    // DOC task
    if (!docTasks[ct]) docTasks[ct] = [];
    const pdfPath = CHECKLIST_TO_PDF[row.checklistName] || null;
    if (row.checklistName && !row.checklistName.toLowerCase().includes('to be finalized') && row.checklistName !== 'N/A') {
      docTasks[ct].push({ subType: st, pdfPath, checklistLabel: row.checklistName });
    }

    // Q task
    if (!qTasks[ct]) qTasks[ct] = [];
    const docxPaths = [];
    if (row.questionnaireName && !row.questionnaireName.toLowerCase().includes('to be finalized') && row.questionnaireName !== 'N/A') {
      const dp = Q_TO_DOCX[row.questionnaireName];
      if (dp) docxPaths.push({ path: dp, name: row.questionnaireName });
    }
    if (row.additionalQ && row.additionalQ !== 'N/A' && !row.additionalQ.toLowerCase().includes('to be finalized')) {
      const dp = Q_TO_DOCX[row.additionalQ];
      if (dp) docxPaths.push({ path: dp, name: row.additionalQ });
    }
    if (docxPaths.length) {
      qTasks[ct].push({ subType: st, docxPaths });
    }
  }

  // ── Step 3: Populate Doc Checklist Template Board ────────────────────────
  console.log('=== Populating Doc Checklist Template Board ===\n');
  let docItemCount = 0;

  for (const ct of CASE_TYPES) {
    const groupId = docGroups[ct.caseType];
    const tasks   = docTasks[ct.caseType] || [];
    if (!tasks.length) {
      console.log(ct.caseType + ': no checklist (TBF/N/A)');
      continue;
    }

    // Deduplicate: same PDF may appear for multiple sub-types
    const seenPdfs = new Set();
    for (const task of tasks) {
      if (!task.pdfPath) {
        console.log('  ⚠ No PDF mapped for:', task.checklistLabel);
        continue;
      }
      const pdfKey = task.pdfPath + '|' + (task.subType || '');
      if (seenPdfs.has(pdfKey)) continue;
      seenPdfs.add(pdfKey);

      const docItems = await parsePdf(task.pdfPath);
      if (!docItems.length) {
        console.log('  ⚠ 0 items parsed from:', path.basename(task.pdfPath));
        continue;
      }

      console.log(ct.caseType + (task.subType ? ' / ' + task.subType : '') + ': ' + docItems.length + ' items from ' + path.basename(task.pdfPath));

      for (const item of docItems) {
        const colVals = {
          [DOC_COLS.caseType]: { labels: [ct.caseType] },
          [DOC_COLS.category]: { labels: [inferDocCategory(item.name)] },
          [DOC_COLS.version]:  { labels: ['v1.0'] },
          [DOC_COLS.required]: { labels: ['Mandatory'] },
          [DOC_COLS.reviewer]: { labels: ['Case Support'] },
          [DOC_COLS.source]:   { labels: ['Client'] },
          [DOC_COLS.format]:   { labels: ['PDF'] },
        };
        if (task.subType) colVals[DOC_COLS.subType] = { labels: [task.subType] };
        if (item.description) colVals['long_text_mm0zmb7j'] = { text: item.description.slice(0, 2000) };

        const truncatedName = item.name.slice(0, 255);
        await createItem(DOC_BOARD, groupId, truncatedName, colVals);
        docItemCount++;
        await sleep(150);
      }
    }
  }
  console.log('\nDoc Checklist Board: created', docItemCount, 'items\n');

  // ── Step 4: Populate Questionnaire Template Board ─────────────────────────
  console.log('=== Populating Questionnaire Template Board ===\n');
  let qItemCount = 0;

  for (const ct of CASE_TYPES) {
    const groupId = qGroups[ct.caseType];
    const tasks   = qTasks[ct.caseType] || [];
    if (!tasks.length) {
      console.log(ct.caseType + ': no questionnaire (TBF/N/A)');
      continue;
    }

    // Deduplicate by DOCX path only — if multiple sub-types share the same
    // questionnaire file, add those questions ONCE (no sub-type tag).
    // If sub-types use DIFFERENT questionnaire files, add each file's questions
    // tagged with the sub-type that uniquely identifies them.
    const docxUsageCount = {};
    for (const task of tasks) {
      for (const dp of task.docxPaths) {
        docxUsageCount[dp.path] = (docxUsageCount[dp.path] || 0) + 1;
      }
    }

    const seenDocx = new Set();
    for (const task of tasks) {
      for (const dp of task.docxPaths) {
        if (seenDocx.has(dp.path)) continue;
        seenDocx.add(dp.path);

        const qItems = await parseDocx(dp.path);
        if (!qItems.length) {
          console.log('  ⚠ 0 items from:', path.basename(dp.path));
          continue;
        }

        // Only tag sub-type if this docx is unique to one sub-type for this case type
        const subTypeTag = (docxUsageCount[dp.path] === 1) ? task.subType : '';
        console.log(ct.caseType + (subTypeTag ? ' / ' + subTypeTag : '') + ': ' + qItems.length + ' questions from ' + path.basename(dp.path));

        for (const item of qItems) {
          const colVals = {
            [Q_COLS.caseType]:  { labels: [ct.caseType] },
            [Q_COLS.category]:  { labels: [item.category] },
            [Q_COLS.version]:   { labels: ['v1.0'] },
            [Q_COLS.required]:  { labels: ['Mandatory'] },
            [Q_COLS.inputType]: { labels: ['Short Text'] },
          };
          if (subTypeTag) colVals[Q_COLS.subType] = { labels: [subTypeTag] };

          await createItem(Q_BOARD, groupId, item.name, colVals);
          qItemCount++;
          await sleep(150);
        }
      }
    }
  }
  console.log('\nQuestionnaire Board: created', qItemCount, 'items\n');

  console.log('=== Rebuild Complete ===');
  console.log('Doc items:', docItemCount, '| Q items:', qItemCount);
}

run().catch((err) => {
  console.error('Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
