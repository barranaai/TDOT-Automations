/**
 * Shared PDF-checklist parsing library.
 *
 * Extracted from scripts/audit-templates-vs-pdfs.js so both the audit and the
 * schema generator read from ONE source of truth for:
 *   - parsePdf()      — extract document names grouped by applicant section
 *   - detectSection() — map a PDF section heading to applicant role(s)
 *   - buildPdfMap()   — the authoritative (caseType, subType, pdfPath) mapping
 *   - normalize(), isLikelyArtifact() — cleaning helpers
 *
 * Pure parsing/IO over the PDF files. No Monday calls.
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const pdfParse = require('pdf-parse');

const PDF_ROOT = path.join(__dirname, '..', '..', 'Document Checklist Items');

/**
 * Map a "Documents for the …" heading to the applicant role(s) it introduces.
 * Returns an array of applicant labels, or null if the line isn't a heading.
 */
function detectSection(line) {
  const l = line.toLowerCase();
  if (!/documents for/i.test(line)) return null;
  if (/principal applicant/i.test(l) && /dependent spouse/i.test(l))
    return ['Principal Applicant', 'Spouse / Common-Law Partner'];
  if (/principal applicant/i.test(l)) return ['Principal Applicant'];
  if (/dependent spouse/i.test(l))    return ['Spouse / Common-Law Partner'];
  if (/non[\s-]?accompanying spouse/i.test(l)) return ['Non-Accompanying Spouse'];
  if (/spouse/i.test(l))              return ['Spouse / Common-Law Partner'];
  if (/inviter|sponsor/i.test(l))     return ['Sponsor'];
  if (/dependent child|child/i.test(l)) return ['Dependent Child'];
  if (/parent/i.test(l) && /sibling/i.test(l)) return ['Parent', 'Sibling'];
  if (/parent/i.test(l))              return ['Parent'];
  if (/sibling/i.test(l))             return ['Sibling'];
  if (/worker spouse/i.test(l))       return ['Worker Spouse'];
  return null;
}

function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/[^a-z0-9]/g, '');
}

/** Looks like a partial / instructional fragment rather than a real doc? */
function isLikelyArtifact(name) {
  if (!name) return true;
  if (name.length > 180) return true;
  if (name.length < 4) return true;
  if (/^if\b/i.test(name)) return true;
  if (/^or\b/i.test(name)) return true;
  if (/^and\b/i.test(name)) return true;
  if (/^the\b/i.test(name)) return true;
  if (/^see\b/i.test(name)) return true;
  if (/^note:?/i.test(name)) return true;
  return false;
}

/**
 * Parse a PDF and extract document names grouped by applicant section.
 * @returns {Promise<{ [applicantLabel]: string[] }>}
 */
async function parsePdf(filePath) {
  const buf  = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  const lines = data.text.split('\n').map((l) => l.trim()).filter(Boolean);

  const result = {};
  let currentApplicants = null;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    const sectionApps = detectSection(ln);
    if (sectionApps) {
      currentApplicants = sectionApps;
      for (const app of sectionApps) if (!result[app]) result[app] = [];
      continue;
    }

    if (ln === '☐' && lines[i + 1] && currentApplicants) {
      let docName = lines[i + 1];
      if (/^questionnaire$/i.test(docName)) continue;
      docName = docName.replace(/[:.\-]+\s*$/g, '').trim();
      if (isLikelyArtifact(docName)) continue;
      for (const app of currentApplicants) {
        if (!result[app].some((d) => normalize(d) === normalize(docName))) {
          result[app].push(docName);
        }
      }
    }
  }
  return result;
}

/**
 * Flat parse — every document (any line after a ☐) with NO section grouping.
 * Fallback for single-applicant checklists that lack "Documents for the …"
 * headings, where parsePdf() would return {} because no section is ever set.
 * @returns {Promise<string[]>}
 */
async function parsePdfFlat(filePath) {
  const buf  = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  const lines = data.text.split('\n').map((l) => l.trim()).filter(Boolean);
  const docs = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '☐' && lines[i + 1]) {
      let docName = lines[i + 1];
      if (/^questionnaire$/i.test(docName)) continue;
      docName = docName.replace(/[:.\-]+\s*$/g, '').trim();
      if (isLikelyArtifact(docName)) continue;
      if (!docs.some((d) => normalize(d) === normalize(docName))) docs.push(docName);
    }
  }
  return docs;
}

/**
 * The authoritative mapping: which (caseType, subType) does each PDF represent.
 * @returns {Array<{ caseType, subType, pdfPath, pdfRelative }>}
 */
function buildPdfMap() {
  const entries = [];
  const add = (caseType, subType, pdfRelativePath) => {
    const full = path.join(PDF_ROOT, pdfRelativePath);
    if (!fs.existsSync(full)) { console.warn(`  ⚠ PDF not found: ${pdfRelativePath}`); return; }
    entries.push({ caseType, subType, pdfPath: full, pdfRelative: pdfRelativePath });
  };

  for (const ct of ['Canadian Experience Class (Profile Recreation+ITA+Submission)',
                    'Canadian Experience Class (Profile+ITA+Submission)',
                    'Canadian Experience Class (EE after ITA)']) {
    add(ct, 'CEC Single Applicant',            'CEC/Document Checklist- CEC- Single applicant.pdf');
    add(ct, 'CEC Accompanying Spouse & Child', 'CEC/Document Checklist- CEC- Accompanying spouse and child.pdf');
  }

  add('Citizenship', '', 'Citizenship/Document Checklist- Citizenship- Accompanying spouse or child.pdf');

  add('Federal PR', 'Non Express Entry - Accompanying Spouse & Child',
      'Non-Express Entry/Document Checklist- Non-Express Entry- Accompanying spouse and child.pdf');
  add('Federal PR', 'Non Express Entry - Non Accompanying Spouse',
      'Non-Express Entry/Document Checklist- Non-Express Entry- Non accompanying spouse.pdf');

  add('PR Card Renewal',    '', 'PR Card/Document Checklist- PR Card Renewal-Accompanying spouse or child.pdf');
  add('PRTD',               '', 'PR Card/Document Checklist- PRTD- Accompanying spouse or child.pdf');
  add('Renunciation of PR', '', 'PR Card/Document Checklist-Voluntary Renunciation of PR- Accompanying spouse or child.pdf');

  add('Parents/Grandparents Sponsorship', '',
      'Parents and Grandparents/Document Checklist- Parents & Grandparents Sponsorship.pdf');

  add('AAIP', 'Express Entry Stream',         'Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Express Entry Stream.pdf');
  add('AAIP', 'Opportunity Stream',           'Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Opportunity Stream.pdf');
  add('AAIP', 'Tourism & Hospitality Stream', 'Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Tourism & Hospitality Stream.pdf');
  add('AAIP', 'Rural Renewal Stream',         'Provincial Nominee Programs/Alberta/Document Checklist- AAIP-Rural Renewal Stream.pdf');

  add('BCPNP', 'BC PNP+ Company Info', 'Provincial Nominee Programs/British Columbia/Document Checklist-BC PNP.pdf');

  add('NSNP', '', 'Provincial Nominee Programs/Nova Scotia/Document Checklist-NSNP.pdf');

  add('OINP', 'Foreign Worker Stream',           'Provincial Nominee Programs/Ontario/Document Checklist- OINP- Foreign Worker Stream.pdf');
  add('OINP', 'Human Capital Priorities Stream', 'Provincial Nominee Programs/Ontario/Document Checklist- OINP- Human Capital Priorities Stream.pdf');
  add('OINP', 'In-demand Skills Stream',         'Provincial Nominee Programs/Ontario/Document Checklist- OINP- In-Demand Skills Stream.pdf');
  add('OINP', 'International Student Stream',     'Provincial Nominee Programs/Ontario/Document Checklist- OINP- International Student Stream.pdf');
  add('OINP', 'Masters Graduate Stream',         'Provincial Nominee Programs/Ontario/Document Checklist- OINP- Masters Graduate Stream.pdf');
  add('OINP', 'PhD Graduate Stream',             'Provincial Nominee Programs/Ontario/Document Checklist- OINP- PhD Graduate Stream.pdf');
  add('OINP', 'Skilled Trades Stream',           'Provincial Nominee Programs/Ontario/Document Checklist- OINP- Skilled Trades Stream.pdf');

  add('Inland Spousal Sponsorship',  'Marriage',           'Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Inland.pdf');
  add('Inland Spousal Sponsorship',  'Common Law Partner', 'Spousal Sponsorship/Document Checklist- Common Law Partner- Inland.pdf');
  add('Outland Spousal Sponsorship', 'Marriage',           'Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Outland.pdf');

  add('Study Permit',           '',                                          'Study Permit/Document Checklist- Study Permit - Single Applicant.pdf');
  add('Study Permit',           'Non SDS Stream - Single Applicant',         'Study Permit/Document Checklist- Study Permit - Non SDS Stream- Single Applicant.pdf');
  add('Study Permit',           'Non SDS Stream - Accompanying Spouse/Child','Study Permit/Document Checklist- Study Permit- Non SDS Stream- Accompanying spouse or child.pdf');
  add('Study Permit',           'SDS Stream - Accompanying Spouse/Child',    'Study Permit/Document Checklist- Study Permit- SDS Stream- Accompanying spouse or child.pdf');
  add('Study Permit',           'Dependent Child - Outland',                 'Study Permit/Document Checklist- Study Permit for dependent child- Outland.pdf');
  add('Study Permit',           'Change of Status (Visitor to Student)',     'Study Permit/Document Checklist- Study Permit-Change of status (Visitor to Student) Single Applicant.pdf');
  add('Study Permit Extension', 'Single Applicant',                          'Study Permit/Document Checklist- Study Permit  Extension- Single applicant.pdf');
  add('Study Permit Extension', 'Accompanying Spouse/Child',                 'Study Permit/Document Checklist- Study Permit  Extension- Accompanying spouse or child.pdf');

  add('Supervisa', 'Parents',      'Supervisa/Document Checklist- Supervisa- Parents.pdf');
  add('Supervisa', 'Grandparents', 'Supervisa/Document Checklist- Supervisa- GrandParents.pdf');

  add('TRV', '', 'Visitor/Document Checklist- TRV.pdf');

  add('Visitor Record / Extension', 'Visitor Record + Restoration', 'Visitor/Document Checklist- Visitor Record (extension).pdf');
  add('Visitor Record / Extension', 'Visitor Record',               'Visitor/Document Checklist- Visitor Record (extension).pdf');
  add('Visitor Record / Extension', 'Visitor Extension',            'Visitor/Document Checklist- Visitor Record (extension).pdf');

  add('Visitor Visa', 'Both Parents',                               'Visitor/Document Checklist- Visitor Visa- Both Parents.pdf');
  add('Visitor Visa', 'Single Parent',                              'Visitor/Document Checklist- Visitor Visa-  Single Parent.pdf');
  add('Visitor Visa', '1-3 Members',                                'Visitor/Document Checklist- Visitor Visa-  1,2 or 3 members.pdf');
  add('Visitor Visa', '1-2 Members',                                'Visitor/Document Checklist- Visitor Visa- 1 or 2 members.pdf');
  add('Visitor Visa', 'Parents & Siblings',                         'Visitor/Document Checklist- Visitor Visa-  Parents and siblings.pdf');
  add('Visitor Visa', 'Spouse',                                     'Visitor/Document Checklist- Visitor Visa- Spouse.pdf');
  add('Visitor Visa', 'Spousal Sponsorship in Process',             'Visitor/Document Checklist- Visitor Visa- Spouse  (Spousal Sponsorship in process).pdf');
  add('Visitor Visa', 'Change of Status (Student/Worker to Visitor)','Visitor/Document Checklist- Visitor Visa- Change of Status (from student or worker).pdf');

  add('BOWP',            '',                                  'Work Permits/Document Checklist- BOWP- Single ,accompanying spouse or child.pdf');
  add('Concurrent WP',   '',                                  'Work Permits/Document Checklist- Concurrent Work permit- Single or accompanying spouse.pdf');
  add('LMIA Exempt WP',  '',                                  'Work Permits/Document Checklist- LMIA exempt Work permit- Single or accompanying spouse.pdf');
  add('LMIA Based WP',   'Inside Canada',                     'Work Permits/Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Inside Canada.pdf');
  add('LMIA Based WP',   'Outside Canada',                    'Work Permits/Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Outside Canada.pdf');
  add('LMIA Based WP',   'Extension (Inside Canada)',         'Work Permits/Document Checklist- LMIA Based Work permit Extension- Single or accompanying spouse- Inside Canada.pdf');
  add('SCLPC WP',        '',                                  'Work Permits/Document Checklist- Open work permit (Worker Parent)- for child above 18 years of age.pdf');
  add('PGWP',            '',                                  'Work Permits/Document Checklist- PGWP (Single Applicant).pdf');
  add('PGWP',            'Extension - Single Applicant',      'Work Permits/Document Checklist- PGWP Extension (Single Applicant)- Passport Validity.pdf');
  add('PGWP',            'Extension - Accompanying Spouse/Child','Work Permits/Document Checklist- PGWP Extension - Accompanying spouse established relationship or child- Passport Validity.pdf');
  add('PGWP',            'Inside Canada - Accompanying Spouse/Child','Work Permits/Document Checklist- PGWP- Accompanying spouse established relationship or child- Inside Canada.pdf');
  add('SOWP',            'Spousal Sponsorship in Process',    'Work Permits/Document Checklist- SOWP (Spousal Sponsorship in process).pdf');
  add('SOWP',            'Inland - Established Relationship',  'Work Permits/Document Checklist- SOWP (Worker Spouse)- Established Relationship-Inland.pdf');
  add('SOWP',            'Inland - Non Established Relationship','Work Permits/Document Checklist- SOWP (Worker Spouse)- Non established Relationship-Inland.pdf');
  add('SOWP',            'Outland (Spouse or Child)',         'Work Permits/Document Checklist- SOWP (Worker Spouse)- spouse or child- Outland.pdf');
  add('SOWP',            'Extension (Spouse or Child)',       'Work Permits/Document Checklist- SOWP Extension (Worker Spouse)- spouse or child.pdf');
  add('NB WP Extension', '',                                  'Work Permits/Document Checklist- Work Permit Extension (NB) - Single or accompanying spouse.pdf');

  return entries;
}

module.exports = { PDF_ROOT, detectSection, normalize, isLikelyArtifact, parsePdf, parsePdfFlat, buildPdfMap };
