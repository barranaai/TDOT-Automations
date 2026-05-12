/**
 * Comprehensive audit — compares every Document Checklist Items PDF against
 * the Monday Template Board, per (case type × sub-type × applicant).
 *
 * Read-only. Produces:
 *   - Console summary
 *   - scripts/audit-templates-vs-pdfs.json  (full machine-readable findings)
 *   - scripts/audit-templates-vs-pdfs.md    (human-readable report)
 *
 * For each PDF:
 *   1. Parse it. Extract document names per applicant section. Section
 *      headers look like "Documents for the Principal Applicant" or
 *      "Documents for the Sponsor" or "Documents for the Dependent Child",
 *      etc. Documents are lines that come after a ☐ checkbox.
 *
 *   2. Map the PDF to a (caseType, subType) tuple using the file path
 *      conventions + the Excel mapping as a fallback.
 *
 *   3. Query the Monday Template Board's matching group for that
 *      (caseType, subType, applicant) combination.
 *
 *   4. Compare and report:
 *        ✓ both sides match
 *        ⚠ PDF has docs that aren't on Template Board (missing)
 *        ⚠ Template Board has docs that aren't in PDF (extra/misallocated)
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const pdfParse  = require('pdf-parse');
const mondayApi = require('../src/services/mondayApi');

const PDF_ROOT      = path.join(__dirname, '..', 'Document Checklist Items');
const TEMPLATE_BOARD = process.env.MONDAY_TEMPLATE_BOARD_ID || '18401624183';

// Column IDs on the Template Board
const COL = {
  documentCode:    'text_mm0xprz5',
  caseSubType:     'dropdown_mm204y6w',
  applicantType:   'dropdown_mm261bn6',
  documentCategory:'dropdown_mm0x41zm',
  checklistPhase:  'dropdown_mm297t2e',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Step 1: PDF parsing ────────────────────────────────────────────────────

/**
 * Parse a PDF and extract document names grouped by applicant section.
 * Returns: { [applicantLabel]: [docName, ...] }
 *
 * Section headers detected (case-insensitive substring match):
 *   "Documents for the Principal Applicant" → "Principal Applicant"
 *   "Documents for the Inviter"               → "Sponsor"
 *   "Documents for the Sponsor"               → "Sponsor"
 *   "Documents for the Dependent Child"       → "Dependent Child"
 *   "Documents for the Spouse"                → "Spouse / Common-Law Partner"
 *   ...
 *
 * Documents are lines immediately following a "☐" character.
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

async function parsePdf(filePath) {
  const buf = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  const lines = data.text.split('\n').map(l => l.trim()).filter(Boolean);

  const result = {};        // applicantLabel → [docName]
  let currentApplicants = null;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // Section header?
    const sectionApps = detectSection(ln);
    if (sectionApps) {
      currentApplicants = sectionApps;
      for (const app of sectionApps) {
        if (!result[app]) result[app] = [];
      }
      continue;
    }

    // Document item? Lines starting with ☐ followed by the doc name on the next line
    if (ln === '☐' && lines[i + 1] && currentApplicants) {
      let docName = lines[i + 1];
      // Skip "Questionnaire" meta-entry (it's not a real doc)
      if (/^questionnaire$/i.test(docName)) continue;
      // Clean trailing colons / dashes / periods often left over from PDF layout
      docName = docName.replace(/[:.\-]+\s*$/g, '').trim();
      if (isLikelyArtifact(docName)) continue;
      for (const app of currentApplicants) {
        if (!result[app].some(d => normalize(d) === normalize(docName))) {
          result[app].push(docName);
        }
      }
    }
  }

  return result;
}

// ─── Step 2: Map PDF filename → (caseType, subType) ─────────────────────────

/**
 * The fundamental mapping: which system case type + sub-type does each PDF
 * file represent? Built from PDF folder structure + filename conventions.
 *
 * Returns array of (caseType, subType, pdfPath) entries.
 */
function buildPdfMap() {
  const entries = [];

  // Helper to push an entry. caseType MUST match a system case type
  // (per config/caseTypes.js). subType MUST match a sub-type in that
  // case type's array (or be '' for case types without sub-types).
  const add = (caseType, subType, pdfRelativePath) => {
    const full = path.join(PDF_ROOT, pdfRelativePath);
    if (!fs.existsSync(full)) {
      console.warn(`  ⚠ PDF not found: ${pdfRelativePath}`);
      return;
    }
    entries.push({ caseType, subType, pdfPath: full, pdfRelative: pdfRelativePath });
  };

  // CEC (two case types share the same PDFs)
  for (const ct of ['Canadian Experience Class (Profile Recreation+ITA+Submission)',
                    'Canadian Experience Class (Profile+ITA+Submission)',
                    'Canadian Experience Class (EE after ITA)']) {
    add(ct, 'CEC Single Applicant',           'CEC/Document Checklist- CEC- Single applicant.pdf');
    add(ct, 'CEC Accompanying Spouse & Child','CEC/Document Checklist- CEC- Accompanying spouse and child.pdf');
  }

  // Citizenship
  add('Citizenship', '', 'Citizenship/Document Checklist- Citizenship- Accompanying spouse or child.pdf');

  // Federal PR / Non-Express Entry
  add('Federal PR', 'Non Express Entry - Accompanying Spouse & Child',
      'Non-Express Entry/Document Checklist- Non-Express Entry- Accompanying spouse and child.pdf');
  add('Federal PR', 'Non Express Entry - Non Accompanying Spouse',
      'Non-Express Entry/Document Checklist- Non-Express Entry- Non accompanying spouse.pdf');

  // PR Card
  add('PR Card Renewal', '', 'PR Card/Document Checklist- PR Card Renewal-Accompanying spouse or child.pdf');
  add('PRTD',           '', 'PR Card/Document Checklist- PRTD- Accompanying spouse or child.pdf');
  add('Renunciation of PR', '', 'PR Card/Document Checklist-Voluntary Renunciation of PR- Accompanying spouse or child.pdf');

  // Parents and Grandparents Sponsorship
  add('Parents/Grandparents Sponsorship', '',
      'Parents and Grandparents/Document Checklist- Parents & Grandparents Sponsorship.pdf');

  // AAIP
  add('AAIP', 'Express Entry Stream',        'Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Express Entry Stream.pdf');
  add('AAIP', 'Opportunity Stream',          'Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Opportunity Stream.pdf');
  add('AAIP', 'Tourism & Hospitality Stream','Provincial Nominee Programs/Alberta/Document Checklist- AAIP- Tourism & Hospitality Stream.pdf');
  add('AAIP', 'Rural Renewal Stream',        'Provincial Nominee Programs/Alberta/Document Checklist- AAIP-Rural Renewal Stream.pdf');

  // BCPNP
  add('BCPNP', 'BC PNP+ Company Info', 'Provincial Nominee Programs/British Columbia/Document Checklist-BC PNP.pdf');

  // NSNP
  add('NSNP', '', 'Provincial Nominee Programs/Nova Scotia/Document Checklist-NSNP.pdf');

  // OINP - 7 streams
  add('OINP', 'Foreign Worker Stream',          'Provincial Nominee Programs/Ontario/Document Checklist- OINP- Foreign Worker Stream.pdf');
  add('OINP', 'Human Capital Priorities Stream','Provincial Nominee Programs/Ontario/Document Checklist- OINP- Human Capital Priorities Stream.pdf');
  add('OINP', 'In-demand Skills Stream',        'Provincial Nominee Programs/Ontario/Document Checklist- OINP- In-Demand Skills Stream.pdf');
  add('OINP', 'International Student Stream',   'Provincial Nominee Programs/Ontario/Document Checklist- OINP- International Student Stream.pdf');
  add('OINP', 'Masters Graduate Stream',        'Provincial Nominee Programs/Ontario/Document Checklist- OINP- Masters Graduate Stream.pdf');
  add('OINP', 'PhD Graduate Stream',            'Provincial Nominee Programs/Ontario/Document Checklist- OINP- PhD Graduate Stream.pdf');
  add('OINP', 'Skilled Trades Stream',          'Provincial Nominee Programs/Ontario/Document Checklist- OINP- Skilled Trades Stream.pdf');

  // Spousal Sponsorship
  add('Inland Spousal Sponsorship',  'Marriage',        'Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Inland.pdf');
  add('Inland Spousal Sponsorship',  'Common Law Partner','Spousal Sponsorship/Document Checklist- Common Law Partner- Inland.pdf');
  add('Outland Spousal Sponsorship', 'Marriage',        'Spousal Sponsorship/Document Checklist- Spousal Sponsorship - Outland.pdf');

  // Study Permit + Study Permit Extension
  add('Study Permit',           '',                                   'Study Permit/Document Checklist- Study Permit - Single Applicant.pdf');
  add('Study Permit',           'Non SDS Stream - Single Applicant',  'Study Permit/Document Checklist- Study Permit - Non SDS Stream- Single Applicant.pdf');
  add('Study Permit',           'Non SDS Stream - Accompanying Spouse/Child', 'Study Permit/Document Checklist- Study Permit- Non SDS Stream- Accompanying spouse or child.pdf');
  add('Study Permit',           'SDS Stream - Accompanying Spouse/Child',     'Study Permit/Document Checklist- Study Permit- SDS Stream- Accompanying spouse or child.pdf');
  add('Study Permit',           'Dependent Child - Outland',          'Study Permit/Document Checklist- Study Permit for dependent child- Outland.pdf');
  add('Study Permit',           'Change of Status (Visitor to Student)', 'Study Permit/Document Checklist- Study Permit-Change of status (Visitor to Student) Single Applicant.pdf');
  add('Study Permit Extension', 'Single Applicant',                  'Study Permit/Document Checklist- Study Permit  Extension- Single applicant.pdf');
  add('Study Permit Extension', 'Accompanying Spouse/Child',         'Study Permit/Document Checklist- Study Permit  Extension- Accompanying spouse or child.pdf');

  // Supervisa
  add('Supervisa', 'Parents',       'Supervisa/Document Checklist- Supervisa- Parents.pdf');
  add('Supervisa', 'Grandparents',  'Supervisa/Document Checklist- Supervisa- GrandParents.pdf');

  // TRV
  add('TRV', '', 'Visitor/Document Checklist- TRV.pdf');

  // Visitor Record / Extension
  add('Visitor Record / Extension', 'Visitor Record + Restoration', 'Visitor/Document Checklist- Visitor Record (extension).pdf');
  add('Visitor Record / Extension', 'Visitor Record',               'Visitor/Document Checklist- Visitor Record (extension).pdf');
  add('Visitor Record / Extension', 'Visitor Extension',            'Visitor/Document Checklist- Visitor Record (extension).pdf');

  // Visitor Visa
  add('Visitor Visa', 'Both Parents',                              'Visitor/Document Checklist- Visitor Visa- Both Parents.pdf');
  add('Visitor Visa', 'Single Parent',                             'Visitor/Document Checklist- Visitor Visa-  Single Parent.pdf');
  add('Visitor Visa', '1-3 Members',                               'Visitor/Document Checklist- Visitor Visa-  1,2 or 3 members.pdf');
  add('Visitor Visa', '1-2 Members',                               'Visitor/Document Checklist- Visitor Visa- 1 or 2 members.pdf');
  add('Visitor Visa', 'Parents & Siblings',                        'Visitor/Document Checklist- Visitor Visa-  Parents and siblings.pdf');
  add('Visitor Visa', 'Spouse',                                    'Visitor/Document Checklist- Visitor Visa- Spouse.pdf');
  add('Visitor Visa', 'Spousal Sponsorship in Process',            'Visitor/Document Checklist- Visitor Visa- Spouse  (Spousal Sponsorship in process).pdf');
  add('Visitor Visa', 'Change of Status (Student/Worker to Visitor)','Visitor/Document Checklist- Visitor Visa- Change of Status (from student or worker).pdf');

  // Work Permits
  add('BOWP', '', 'Work Permits/Document Checklist- BOWP- Single ,accompanying spouse or child.pdf');
  add('Concurrent WP', '', 'Work Permits/Document Checklist- Concurrent Work permit- Single or accompanying spouse.pdf');
  add('LMIA Exempt WP', '', 'Work Permits/Document Checklist- LMIA exempt Work permit- Single or accompanying spouse.pdf');
  add('LMIA Based WP', 'Inside Canada',             'Work Permits/Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Inside Canada.pdf');
  add('LMIA Based WP', 'Outside Canada',            'Work Permits/Document Checklist- LMIA Based Work permit- Single or accompanying spouse- Outside Canada.pdf');
  add('LMIA Based WP', 'Extension (Inside Canada)', 'Work Permits/Document Checklist- LMIA Based Work permit Extension- Single or accompanying spouse- Inside Canada.pdf');
  add('SCLPC WP', '',                               'Work Permits/Document Checklist- Open work permit (Worker Parent)- for child above 18 years of age.pdf');
  add('PGWP', '',                                   'Work Permits/Document Checklist- PGWP (Single Applicant).pdf');
  add('PGWP', 'Extension - Single Applicant',       'Work Permits/Document Checklist- PGWP Extension (Single Applicant)- Passport Validity.pdf');
  add('PGWP', 'Extension - Accompanying Spouse/Child', 'Work Permits/Document Checklist- PGWP Extension - Accompanying spouse established relationship or child- Passport Validity.pdf');
  add('PGWP', 'Inside Canada - Accompanying Spouse/Child', 'Work Permits/Document Checklist- PGWP- Accompanying spouse established relationship or child- Inside Canada.pdf');
  add('SOWP', 'Spousal Sponsorship in Process',     'Work Permits/Document Checklist- SOWP (Spousal Sponsorship in process).pdf');
  add('SOWP', 'Inland - Established Relationship',  'Work Permits/Document Checklist- SOWP (Worker Spouse)- Established Relationship-Inland.pdf');
  add('SOWP', 'Inland - Non Established Relationship', 'Work Permits/Document Checklist- SOWP (Worker Spouse)- Non established Relationship-Inland.pdf');
  add('SOWP', 'Outland (Spouse or Child)',          'Work Permits/Document Checklist- SOWP (Worker Spouse)- spouse or child- Outland.pdf');
  add('SOWP', 'Extension (Spouse or Child)',        'Work Permits/Document Checklist- SOWP Extension (Worker Spouse)- spouse or child.pdf');
  add('NB WP Extension', '',                        'Work Permits/Document Checklist- Work Permit Extension (NB) - Single or accompanying spouse.pdf');

  return entries;
}

// ─── Step 3: Fetch Monday Template Board (one query, all items) ─────────────

const GROUP_MAP = {
  'AAIP':                                                          'group_mm20pzmk',
  'Addition of Spouse':                                            'group_mm20p681',
  'Amendment of Document':                                         'group_mm20kqx8',
  'Appeal':                                                        'group_mm20kkgb',
  'BCPNP':                                                         'group_mm20pk4z',
  'BOWP':                                                          'group_mm20z1tm',
  'Canadian Experience Class (EE after ITA)':                      'group_mm20jxgj',
  'Canadian Experience Class (Profile Recreation+ITA+Submission)': 'group_mm20rprs',
  'Canadian Experience Class (Profile+ITA+Submission)':            'group_mm20npqs',
  'Child Sponsorship':                                             'group_mm20f7ks',
  'Citizenship':                                                   'group_mm20fk69',
  'Co-op WP':                                                      'group_mm209dn7',
  'Concurrent WP':                                                 'group_mm20hga4',
  'ETA':                                                           'group_mm20pn8z',
  'Employer Portal':                                               'group_mm20j3xz',
  'Federal PR':                                                    'group_mm20v0tw',
  'Francophone Mobility WP':                                       'group_mm20zfw7',
  'H & C':                                                         'group_mm204whx',
  'ICAS/WES/IQAS':                                                 'group_mm2032z6',
  'Inland Spousal Sponsorship':                                    'group_mm20gaqa',
  'Invitation Letter':                                             'group_mm20dne6',
  'LMIA':                                                          'group_mm20e45m',
  'LMIA Based WP':                                                 'group_mm203qtg',
  'LMIA Exempt WP':                                                'group_mm20h35m',
  'Manitoba PNP':                                                  'group_mm20wr7c',
  'Miscellaneous':                                                 'group_mm206pay',
  'NB WP Extension':                                               'group_mm20zefz',
  'NSNP':                                                          'group_mm20yspz',
  'Notary':                                                        'group_mm208x0f',
  'OCI / Passport Surrender':                                      'group_mm20vard',
  'OINP':                                                          'group_mm205n4v',
  'Outland Spousal Sponsorship':                                   'group_mm20ark6',
  'PFL':                                                           'group_mm20wze6',
  'PGWP':                                                          'group_mm201tn9',
  'PR Card Renewal':                                               'group_mm20qncv',
  'PRAA':                                                          'group_mm20sk4',
  'PRTD':                                                          'group_mm20905c',
  'Parents/Grandparents Sponsorship':                              'group_mm20cssz',
  'RCIP':                                                          'group_mm20thv5',
  'RNIP':                                                          'group_mm20ydwb',
  'Reconsideration':                                               'group_mm20mcvq',
  'Refugee':                                                       'group_mm20ebkq',
  'Refugee WP':                                                    'group_mm20616',
  'Renunciation of PR':                                            'group_mm20p4n1',
  'Request Letter':                                                'group_mm20z8xw',
  'SCLPC WP':                                                      'group_mm20z5wq',
  'SNIP':                                                          'group_mm20mgtf',
  'SOWP':                                                          'group_mm20rbw2',
  'Study Permit':                                                  'group_mm203je0',
  'Study Permit Extension':                                        'group_mm20k9f8',
  'Supervisa':                                                     'group_mm205fc9',
  'TRP':                                                           'group_mm20c4q8',
  'TRV':                                                           'group_mm20sqwz',
  'USA Visa':                                                      'group_mm20d6yy',
  'Visitor Record / Extension':                                    'group_mm20emfw',
  'Visitor Visa':                                                  'group_mm20tt4n',
};

async function fetchTemplateGroupItems(caseType) {
  const groupId = GROUP_MAP[caseType];
  if (!groupId) return null;
  const data = await mondayApi.query(
    `query { boards(ids:[${TEMPLATE_BOARD}]) { groups(ids:["${groupId}"]) { items_page(limit:500) { items { id name column_values(ids:["${COL.documentCode}","${COL.caseSubType}","${COL.applicantType}","${COL.documentCategory}","${COL.checklistPhase}"]) { id text } } } } } }`
  );
  const items = data?.boards?.[0]?.groups?.[0]?.items_page?.items || [];
  return items.map(it => {
    const m = {};
    for (const c of it.column_values) m[c.id] = c.text || '';
    return {
      id: it.id,
      name: (it.name || '').trim(),
      documentCode:     m[COL.documentCode]    || '',
      caseSubType:      m[COL.caseSubType]     || '',
      applicantType:    m[COL.applicantType]   || 'Principal Applicant',
      documentCategory: m[COL.documentCategory]|| '',
      checklistPhase:   m[COL.checklistPhase]  || '',
    };
  });
}

/**
 * Aggressive name normalization for fuzzy matching:
 *   - Lowercase
 *   - Strip all non-alphanumeric (so "(IELTS- G/CELPIP-G)" and
 *     "(IELTS-G/CELPIP-G)" both collapse to "ieltsgcelpipg")
 *   - Strip trailing punctuation
 *   - Collapse to single string with NO whitespace
 *
 * This loses some signal (e.g., "Birth Certificate" and "Birth Certificate."
 * are matched, which is what we want; but "Identity Documents" and
 * "Identity Document" also match — slight false-positive risk). Acceptable
 * trade-off for catching the formatting differences between Excel and
 * Template Board.
 */
function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/[^a-z0-9]/g, '');
}

/** Looks like a partial / instructional fragment? Skip these. */
function isLikelyArtifact(name) {
  if (!name) return true;
  if (name.length > 180) return true;             // huge — almost certainly instruction text
  if (name.length < 4) return true;               // way too short
  if (/^if\b/i.test(name)) return true;           // "If salaried-", "If pensioner-" etc
  if (/^or\b/i.test(name)) return true;           // "Or any other..."
  if (/^and\b/i.test(name)) return true;          // "And any..."
  if (/^the\b/i.test(name)) return true;          // "The applicant..."
  if (/^see\b/i.test(name)) return true;          // "See note..."
  if (/^note:?/i.test(name)) return true;
  return false;
}

// ─── Step 4: Compare PDF vs Template Board for one entry ────────────────────

function compareEntry(entry, pdfDocs, templateItems) {
  const result = {
    caseType:   entry.caseType,
    subType:    entry.subType,
    pdfRelative: entry.pdfRelative,
    perApplicant: {},
  };

  // Filter template items to those matching this sub-type (or no sub-type set)
  const relevantTemplates = templateItems.filter(t => {
    if (!entry.subType) return !t.caseSubType;
    return !t.caseSubType || t.caseSubType === entry.subType;
  });

  // Group templates by applicant
  const tplByApp = {};
  for (const t of relevantTemplates) {
    if (!tplByApp[t.applicantType]) tplByApp[t.applicantType] = [];
    tplByApp[t.applicantType].push(t);
  }

  // For each applicant that the PDF expects, compare
  const allApps = new Set([...Object.keys(pdfDocs), ...Object.keys(tplByApp)]);
  for (const app of allApps) {
    const pdfList = pdfDocs[app] || [];
    const tplList = tplByApp[app] || [];
    const pdfNorm = new Set(pdfList.map(normalize));
    const tplNorm = new Set(tplList.map(t => normalize(t.name)));

    const missingInTemplate = pdfList.filter(p => !tplNorm.has(normalize(p)));
    const extraInTemplate   = tplList.filter(t => !pdfNorm.has(normalize(t.name)));

    result.perApplicant[app] = {
      pdfCount:        pdfList.length,
      templateCount:   tplList.length,
      missingInTemplate, // PDF says these docs are needed; not on Template Board
      extraInTemplate:   extraInTemplate.map(t => ({ name: t.name, code: t.documentCode })),
      matches:           pdfList.length - missingInTemplate.length,
    };
  }
  return result;
}

// ─── Step 5: Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('Building PDF → (caseType, subType) map…');
  const entries = buildPdfMap();
  console.log(`  → ${entries.length} entries\n`);

  // Pre-fetch all template groups we need (one query per unique caseType)
  console.log('Fetching Monday Template Board groups…');
  const caseTypes = [...new Set(entries.map(e => e.caseType))];
  const templateByCaseType = {};
  for (const ct of caseTypes) {
    try {
      const items = await fetchTemplateGroupItems(ct);
      templateByCaseType[ct] = items || [];
      console.log(`  • ${ct}: ${items?.length ?? '(no group)'} items`);
    } catch (err) {
      console.warn(`  ✗ ${ct}: ${err.message}`);
      templateByCaseType[ct] = [];
    }
    await sleep(150);
  }

  // Process each entry
  console.log('\nProcessing PDFs and comparing…\n');
  const findings = [];
  for (const entry of entries) {
    try {
      const pdfDocs = await parsePdf(entry.pdfPath);
      const templateItems = templateByCaseType[entry.caseType] || [];
      const cmp = compareEntry(entry, pdfDocs, templateItems);

      // Simple summary
      let issues = 0, ok = 0;
      for (const [app, r] of Object.entries(cmp.perApplicant)) {
        issues += r.missingInTemplate.length + r.extraInTemplate.length;
        if (r.missingInTemplate.length === 0 && r.extraInTemplate.length === 0) ok++;
      }
      const sym = issues === 0 ? '✓' : '⚠';
      console.log(`  ${sym} [${entry.caseType}] / ${entry.subType || '(no sub)'} — ${Object.keys(cmp.perApplicant).length} applicants, ${issues} discrepancies`);
      findings.push(cmp);
    } catch (err) {
      console.error(`  ✗ ${entry.pdfRelative}: ${err.message}`);
      findings.push({ ...entry, error: err.message });
    }
  }

  // Write JSON report
  const jsonPath = path.join(__dirname, 'audit-templates-vs-pdfs.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), findings }, null, 2));
  console.log(`\nJSON report: ${jsonPath}`);

  // Write Markdown report
  const md = buildMarkdownReport(findings);
  const mdPath = path.join(__dirname, 'audit-templates-vs-pdfs.md');
  fs.writeFileSync(mdPath, md);
  console.log(`Markdown report: ${mdPath}`);
}

function buildMarkdownReport(findings) {
  const lines = [];
  lines.push('# Template Board vs PDF Source — Audit Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Aggregate stats
  let totalEntries = 0, totalCleanEntries = 0, totalMissing = 0, totalExtra = 0;
  for (const f of findings) {
    if (f.error) continue;
    totalEntries++;
    let entryMissing = 0, entryExtra = 0;
    for (const [, r] of Object.entries(f.perApplicant)) {
      entryMissing += r.missingInTemplate.length;
      entryExtra   += r.extraInTemplate.length;
    }
    if (entryMissing === 0 && entryExtra === 0) totalCleanEntries++;
    totalMissing += entryMissing;
    totalExtra   += entryExtra;
  }
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Total (caseType, subType) entries audited | ${totalEntries} |`);
  lines.push(`| Entries with NO discrepancies (clean) | ${totalCleanEntries} |`);
  lines.push(`| Entries with discrepancies | ${totalEntries - totalCleanEntries} |`);
  lines.push(`| Total docs in PDF but missing on Template Board | **${totalMissing}** |`);
  lines.push(`| Total docs on Template Board but not in PDF | **${totalExtra}** |`);
  lines.push('');

  // Group findings by case type
  const byType = {};
  for (const f of findings) {
    const ct = f.caseType || '(unknown)';
    if (!byType[ct]) byType[ct] = [];
    byType[ct].push(f);
  }

  lines.push('## Findings by Case Type');
  lines.push('');
  for (const ct of Object.keys(byType).sort()) {
    lines.push(`### ${ct}`);
    lines.push('');
    for (const f of byType[ct]) {
      if (f.error) {
        lines.push(`- ✗ **${f.subType || '(no sub-type)'}** — error: ${f.error}`);
        continue;
      }
      let entryMissing = 0, entryExtra = 0;
      for (const [, r] of Object.entries(f.perApplicant)) {
        entryMissing += r.missingInTemplate.length;
        entryExtra   += r.extraInTemplate.length;
      }
      const sym = (entryMissing + entryExtra) === 0 ? '✓' : '⚠';
      lines.push(`#### ${sym} ${f.subType || '(no sub-type)'}`);
      lines.push(`PDF: \`${f.pdfRelative}\``);
      lines.push('');
      lines.push('| Applicant | PDF docs | Template docs | Missing from Template | Extra in Template |');
      lines.push('|---|---|---|---|---|');
      for (const [app, r] of Object.entries(f.perApplicant)) {
        const missList = r.missingInTemplate.length ? r.missingInTemplate.map(d => `\`${d}\``).join('<br>') : '—';
        const extraList = r.extraInTemplate.length ? r.extraInTemplate.map(t => `\`${t.name}\``).join('<br>') : '—';
        lines.push(`| ${app} | ${r.pdfCount} | ${r.templateCount} | ${missList} | ${extraList} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
