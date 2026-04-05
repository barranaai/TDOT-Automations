/**
 * rebuildQBoardV2.js  —  Questionnaire Template Board (full professional rebuild)
 *
 * Key improvements over V1:
 *  - Smart block parser: groups sub-field labels (Start Date, Location:, etc.) into
 *    their parent question's Help Text instead of creating separate rows
 *  - Instructions ("Ensure you include...") go into Help Text, not item names
 *  - Intelligent Input Type: Long Text for history/detail questions, Date for date
 *    fields, Dropdown for yes/no, Short Text for simple fields
 *  - All columns filled: Question Name, Question Code, Help Text (Client Facing),
 *    Form Field Label, Counts Toward Readiness, Blocking Question, Active Template,
 *    Editable Response, Required Type, Category, Version
 */

require('dotenv').config();
const path    = require('path');
const fs      = require('fs');
const XLSX    = require('xlsx');
const mammoth = require('mammoth');
const mondayApi = require('../services/mondayApi');
const { CASE_TYPES } = require('../../config/caseTypes');
const { SUB_TYPE_LABELS } = require('../../config/caseTypes');

const ROOT    = path.join(__dirname, '../../');
const Q_BOARD = process.env.MONDAY_QUESTIONNAIRE_TEMPLATE_BOARD_ID;

// ─── Column IDs ───────────────────────────────────────────────────────────────
const Q_COLS = {
  questionName: 'text_mm13d7f0',       // duplicate text col (same as item name)
  questionCode: 'text_mm1235b5',       // e.g., "VV-001"
  caseType:     'dropdown_mm124p5v',
  subType:      'dropdown_mm20h84d',
  category:     'dropdown_mm12w5fd',
  version:      'dropdown_mm12spk7',
  required:     'dropdown_mm12dqc7',
  inputType:    'dropdown_mm12pn7g',
  formLabel:    'text_mm12st9w',       // short form field label
  helpText:     'long_text_mm12df2b',  // Help Text (Client Facing) — used by form renderer
  countsReady:  'color_mm12ntk1',      // Counts Toward Readiness
  blocking:     'color_mm12v0q',       // Blocking Question
  active:       'color_mm12f5hm',      // Active Template
  editable:     'color_mm1a5at8',      // Editable Response
};

// ─── Case type → abbreviation for question codes ──────────────────────────────
const CASE_ABBR = {
  'AAIP': 'AAIP', 'Addition of Spouse': 'AOS', 'Amendment of Document': 'AMD',
  'Appeal': 'APPL', 'BCPNP': 'BCPNP', 'BOWP': 'BOWP',
  'Canadian Experience Class (EE after ITA)': 'CEC-EE',
  'Canadian Experience Class (Profile Recreation+ITA+Submission)': 'CEC-PR',
  'Canadian Experience Class (Profile+ITA+Submission)': 'CEC-PS',
  'Child Sponsorship': 'CSP', 'Citizenship': 'CIT', 'Co-op WP': 'COWP',
  'Concurrent WP': 'CWP', 'ETA': 'ETA', 'Employer Portal': 'EP',
  'Federal PR': 'FPR', 'Francophone Mobility WP': 'FMWP', 'H & C': 'HC',
  'ICAS/WES/IQAS': 'ICAS', 'Inland Spousal Sponsorship': 'ISS',
  'Invitation Letter': 'IL', 'LMIA': 'LMIA', 'LMIA Based WP': 'LBW',
  'LMIA Exempt WP': 'LEW', 'Manitoba PNP': 'MPNP', 'Miscellaneous': 'MISC',
  'NB WP Extension': 'NBWP', 'NSNP': 'NSNP', 'Notary': 'NOT',
  'OCI / Passport Surrender': 'OCI', 'OINP': 'OINP',
  'Outland Spousal Sponsorship': 'OSS', 'PFL': 'PFL', 'PGWP': 'PGWP',
  'PR Card Renewal': 'PCR', 'PRAA': 'PRAA', 'PRTD': 'PRTD',
  'Parents/Grandparents Sponsorship': 'PGP', 'RCIP': 'RCIP', 'RNIP': 'RNIP',
  'Reconsideration': 'RECON', 'Refugee': 'REF', 'Refugee WP': 'RWP',
  'Renunciation of PR': 'RPR', 'Request Letter': 'RL', 'SCLPC WP': 'SCLWP',
  'SNIP': 'SNIP', 'SOWP': 'SOWP', 'Study Permit': 'SP',
  'Study Permit Extension': 'SPE', 'Supervisa': 'SV', 'TRP': 'TRP',
  'TRV': 'TRV', 'USA Visa': 'UV', 'Visitor Record / Extension': 'VRE',
  'Visitor Visa': 'VV',
};

// ─── Excel → canonical case type mapping (from rebuildQBoard.js) ──────────────
const EXCEL_TO_CANONICAL = {
  'AAIP': { caseType: 'AAIP' }, 'OINP': { caseType: 'OINP' }, 'NSNP': { caseType: 'NSNP' },
  'BCPNP': { caseType: 'BCPNP' }, 'RCIP': { caseType: 'RCIP' }, 'Manitoba PNP': { caseType: 'Manitoba PNP' },
  'RNIP': { caseType: 'RNIP' }, 'SNIP': { caseType: 'SNIP' },
  'Canadian Experience Class (Profile Recreation+ITA+Submission)': { caseType: 'Canadian Experience Class (Profile Recreation+ITA+Submission)' },
  'Canadian Experience Class (Profile+ITA+Submission)':           { caseType: 'Canadian Experience Class (Profile+ITA+Submission)' },
  'EE after ITA ( ITA+submission)':                               { caseType: 'Canadian Experience Class (EE after ITA)' },
  'Inland Spousal Sponsorship (Marriage)':     { caseType: 'Inland Spousal Sponsorship', subType: 'Marriage' },
  'Inland Spousal Sponsorship (Common law)':   { caseType: 'Inland Spousal Sponsorship', subType: 'Common Law Partner' },
  'Outland Spousal Sonsorship (Marriage)':     { caseType: 'Outland Spousal Sponsorship' },
  'Parents/Grandparents Sponsorship':          { caseType: 'Parents/Grandparents Sponsorship' },
  'Child Sponsorship':                         { caseType: 'Child Sponsorship' },
  'Addition of Spouse':                        { caseType: 'Addition of Spouse' },
  'Federal PR':                                { caseType: 'Federal PR' },
  'BOWP': { caseType: 'BOWP' }, 'Co-op WP': { caseType: 'Co-op WP' }, 'Concurrent WP': { caseType: 'Concurrent WP' },
  'LMIA Based WP (Inside Canada)':   { caseType: 'LMIA Based WP', subType: 'Inside Canada' },
  'LMIA based WP Extension':         { caseType: 'LMIA Based WP', subType: 'Extension (Inside Canada)' },
  'LMIA Based WP (Outside Canada)':  { caseType: 'LMIA Based WP', subType: 'Outside Canada' },
  'LMIA Exempt WP':                  { caseType: 'LMIA Exempt WP' },
  'PGWP':                            { caseType: 'PGWP', subType: 'Single Applicant' },
  'PGWP Extension':                  { caseType: 'PGWP' },
  'Refugee WP': { caseType: 'Refugee WP' }, 'SCLPC WP': { caseType: 'SCLPC WP' },
  'SOWP Inland':  { caseType: 'SOWP' },
  'SOWP Outland': { caseType: 'SOWP', subType: 'Outland (Spouse or Child)' },
  'SOWP Extension ':  { caseType: 'SOWP', subType: 'Extension (Spouse or Child)' },
  'SOWP Extension':   { caseType: 'SOWP', subType: 'Extension (Spouse or Child)' },
  'NB WP Extension': { caseType: 'NB WP Extension' }, 'Francophone Mobility WP': { caseType: 'Francophone Mobility WP' },
  'Supervisa- Parents':      { caseType: 'Supervisa', subType: 'Parents' },
  'Supervisa- Grandparents': { caseType: 'Supervisa', subType: 'Grandparents' },
  'Employer Portal': { caseType: 'Employer Portal' }, 'LMIA': { caseType: 'LMIA' }, 'ETA': { caseType: 'ETA' },
  'PR Card Renewal': { caseType: 'PR Card Renewal' }, 'PRTD': { caseType: 'PRTD' },
  'Renunciation of PR': { caseType: 'Renunciation of PR' }, 'Citizenship': { caseType: 'Citizenship' },
  'TRP': { caseType: 'TRP' }, 'TRV': { caseType: 'TRV' },
  'Visitor Record+Restoration': { caseType: 'Visitor Record / Extension', subType: 'Visitor Record + Restoration' },
  'Visitor Extension':  { caseType: 'Visitor Record / Extension', subType: 'Visitor Extension' },
  'Visitor Record ':    { caseType: 'Visitor Record / Extension', subType: 'Visitor Record' },
  'Visitor Record':     { caseType: 'Visitor Record / Extension', subType: 'Visitor Record' },
  'Visitor Visa': { caseType: 'Visitor Visa' }, 'USA Visa': { caseType: 'USA Visa' },
  'Misc': { caseType: 'Miscellaneous' }, 'PFL': { caseType: 'PFL' }, 'Reconsideration': { caseType: 'Reconsideration' },
  'Request Letter': { caseType: 'Request Letter' }, 'Refugee': { caseType: 'Refugee' }, 'H & C': { caseType: 'H & C' },
  'Appeal': { caseType: 'Appeal' }, 'Amendment of document': { caseType: 'Amendment of Document' },
  'ICAS/WES/IQAS': { caseType: 'ICAS/WES/IQAS' }, 'Invitation letter': { caseType: 'Invitation Letter' },
  'Notary': { caseType: 'Notary' }, 'OCI +Passport Surrender': { caseType: 'OCI / Passport Surrender' },
  'PRAA': { caseType: 'PRAA' },
  'Study Permit  ':       { caseType: 'Study Permit' },
  'Study Permit':         { caseType: 'Study Permit' },
  'Study Permit Extension': { caseType: 'Study Permit Extension' },
};

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
  '15. Parents/Grandparents/Children sponsorship Questionnaire': null,
  '16. Addition of spouse- Relationship Questionnaire': null,
  '17. USA Visa  -  Questionnaire - April 2025':
    path.join(DOCX_BASE, 'USA Visa  -  Questionnaire - April 2025.docx'),
};

// ─── Parser helpers ────────────────────────────────────────────────────────────

// Lines to skip entirely
const SKIP_RE = /^(Questionnaire for|PLEASE READ|Main Applicant|Dependent Spouse|Accompanying|Please read the instruction|https?:\/\/|Note:|IMPORTANT:|N\.B\.)/i;
const DATE_FORMAT_RE = /^\(DD[\/-]MM[\/-]YYYY\)$/i;
// Generic date-in-parens or format reminders on their own line
const DATE_FORMAT_INLINE_RE = /^\(DD[\/-]MM[\/-]YYYY\)/i;

// Section headers — update category, do NOT create an item
const SECTION_RE = /^(Section\s+\d|Personal Details|Profile Details|Contact Details|^Education$|Employment History$|Employment$|Travel History$|Travel or Trip History$|Travel Trip History$|Immigration History$|Marital Status$|Background$|Financial (Background|History|Information)?$|Purpose of Visit$|Sponsor.s Details?$|Flagged Polling$|Family Information$|Language Skills?$|Additional Information$|Relation(ship)? Details?$|Other Information$)/i;

// Instructions — go into help text of current block
const INSTRUCTION_RE = /^(Ensure\s+you|Please ensure|Please note|Please include|Make sure|Important:|Include\s+all)/i;

// Lines that are definitely sub-fields REGARDLESS of context (colon at end catches most)
const COLON_END_RE = /:\s*$/;

// Always-subfield names (short, universal sub-field concepts)
const DEFINITE_SUBFIELDS = new Set([
  'start date', 'end date', 'from', 'to',
  'date of marriage', 'date of divorce', 'date of separation', 'date of death',
  'mobile number', 'phone number', 'email address', 'email',
  'submission date',
  // These are fine as always-subfields since a question "Date" alone is noise
  'date (dd/mm/yyyy)', 'date(dd/mm/yyyy)',
]);

// Contextual sub-fields — only treated as sub-fields when accMode is active
const CONTEXTUAL_SUBFIELD_RE = /^(job title|company name|company \/ employer|employer name|course|program name|course \/ program name|education institute|institution name|school name|city|province|country|postal code|street|unit|full address|full address in canada|decision|occupation|supervisor|contact person|duration)/i;

// Questions whose following short lines are sub-fields (accumulator blocks)
const ACCUMULATOR_RE = /^(provide details|please provide(?! your name| your date| your birth| your citizenship| your language| your passport)|describe your|explain your|list (all|your)|please indicate how long|indicate how long)/i;

// Category inference from section/content
const SECTION_CATEGORY_MAP = [
  [/personal|profile|contact|marital|family|name|address|birth|citizenship|language|spouse|child/i, 'Personal'],
  [/travel|entry|exit|trip|border|visa history|immigration history|stay/i, 'Travel'],
  [/education|school|university|college|degree|academic|training|course/i, 'Education'],
  [/employment|work|job|occupation|self.?employ|business|employer|company/i, 'Employment'],
  [/background|criminal|health|medical|military|sanction|security/i, 'Background'],
  [/financial|income|fund|asset|sponsor|bank|investment/i, 'Financial'],
  [/legal|police|clearance|court|conviction|offence|arrest/i, 'Legal'],
];

function inferCategory(text) {
  const s = (text || '').toLowerCase();
  for (const [re, cat] of SECTION_CATEGORY_MAP) {
    if (re.test(s)) return cat;
  }
  return 'Personal';
}

// Input type inference
const LONG_TEXT_RE = /employment history|work experience|self.?employ|education(?! institution| institute| level| type)|travel history|immigration history|stay history|provide details|please provide details|provide full details|list (all|your)|describe/i;
const DATE_RE      = /^(date of birth|date of marriage|date of divorce|date of death|date of separation|date of graduation|date of arrival|date of departure|date of landing|date:?\s*$)/i;
const YESNO_RE     = /^(are you|do you|have you|did you|were you|is your|was your|would you|will you|can you|has your|does your)/i;
const NUMBER_RE    = /amount|income|salary|fee|cost|how many|number of/i;

function inferInputType(name) {
  if (LONG_TEXT_RE.test(name))   return 'Long Text';
  if (DATE_RE.test(name))        return 'Date';
  if (NUMBER_RE.test(name))      return 'Number';
  if (YESNO_RE.test(name))       return 'Dropdown';
  return 'Short Text';
}

// ─── Smart DOCX block parser ──────────────────────────────────────────────────

async function parseDocxSmart(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];

  let result;
  try {
    result = await mammoth.extractRawText({ path: filePath });
  } catch (e) {
    console.warn('  DOCX parse error:', path.basename(filePath), '-', e.message);
    return [];
  }

  const rawLines = result.value.split('\n').map(l => l.trim()).filter(Boolean);
  const blocks   = [];
  let current    = null;       // { name, helpParts, subFields, category }
  let accMode    = false;      // true when current block expects sub-fields for history/details
  let category   = 'Personal';
  let seenFirstSection = false; // suppress preamble title lines

  function saveBlock() {
    if (current) blocks.push(current);
    current = null;
    accMode = false;
  }

  function newBlock(name) {
    saveBlock();
    current = { name, helpParts: [], subFields: [], category };
    accMode = ACCUMULATOR_RE.test(name);
  }

  function addSubField(text) {
    const clean = text
      .replace(/:\s*$/, '')
      .replace(/\s*\(DD[\/-]MM[\/-]YYYY\)/gi, '')
      .trim();
    if (clean && current) current.subFields.push(clean);
  }

  function addHelpText(text) {
    if (current) current.helpParts.push(text);
  }

  for (const line of rawLines) {
    // ── Skip global noise ──────────────────────────────────────────────────────
    if (SKIP_RE.test(line))                                    continue;
    if (DATE_FORMAT_RE.test(line))                             continue;
    if (DATE_FORMAT_INLINE_RE.test(line) && line.length < 25) continue;
    if (/^(\d+\.?\s*)$/.test(line))                            continue;
    if (line.length < 2)                                       continue;

    // ── Section headers ────────────────────────────────────────────────────────
    if (SECTION_RE.test(line)) {
      saveBlock();
      category = inferCategory(line);
      seenFirstSection = true;
      continue;
    }

    // ── Suppress document preamble lines (before first real section) ───────────
    // e.g. "Visitor Visa Outside Canada", "Study Permit Inside / Outside Canada"
    if (!seenFirstSection) continue;

    // ── Instructions → help text of current block ──────────────────────────────
    if (INSTRUCTION_RE.test(line)) {
      addHelpText(line);
      continue;
    }

    // ── Parenthetical notes → help text ────────────────────────────────────────
    if (/^\(.+\)$/.test(line)) {
      addHelpText(line.slice(1, -1).trim());
      continue;
    }

    // ── Lines ending with colon → definite sub-field ───────────────────────────
    if (COLON_END_RE.test(line)) {
      addSubField(line);
      continue;
    }

    // ── Always-subfield names ──────────────────────────────────────────────────
    if (DEFINITE_SUBFIELDS.has(line.toLowerCase())) {
      addSubField(line);
      continue;
    }

    // ── Contextual sub-fields (only when inside an accumulator block) ──────────
    if (accMode && current && CONTEXTUAL_SUBFIELD_RE.test(line)) {
      addSubField(line);
      continue;
    }

    // ── Any remaining short line in accMode is likely a sub-field ─────────────
    if (accMode && current && line.length <= 35 && !/\?/.test(line) && !YESNO_RE.test(line)) {
      addSubField(line);
      continue;
    }

    // ── Everything else: start a new question block ────────────────────────────
    newBlock(line);
  }

  saveBlock();

  // ── Convert blocks to items ────────────────────────────────────────────────
  return blocks
    .filter(b => b.name.length >= 4 && !/^(\(|\d+\.|https?)/.test(b.name))
    .map(b => {
      let helpText = '';
      if (b.helpParts.length) helpText += b.helpParts.join(' ').trim();
      if (b.subFields.length) {
        helpText += (helpText ? '\n\n' : '') +
          'Please provide the following: ' + b.subFields.join(', ') + '.';
      }
      const name = b.name.length > 255 ? b.name.slice(0, 252) + '...' : b.name;
      return {
        name,
        fullName:  b.name,
        helpText:  helpText.trim(),
        category:  b.category,
        inputType: inferInputType(b.name),
      };
    });
}

// ─── Monday API helpers ────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, retries = 5, baseDelay = 3000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status || err?.status;
      const isRetryable = !status || status === 502 || status === 503 || status === 504 || status === 429;
      if (!isRetryable || attempt === retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`  ⚠ API error (${status || err.message}), retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
      await sleep(delay);
    }
  }
}

async function deleteAllItemsInGroup(boardId, groupId) {
  let deleted = 0;
  while (true) {
    const r = await withRetry(() =>
      mondayApi.query(
        `query { boards(ids: ["${boardId}"]) { groups(ids: ["${groupId}"]) { items_page(limit: 100) { items { id } } } } }`
      )
    );
    const items = r.boards[0].groups[0].items_page.items;
    if (!items.length) break;
    for (const item of items) {
      await withRetry(() =>
        mondayApi.query(`mutation { delete_item(item_id: ${item.id}) { id } }`)
      );
      deleted++;
      await sleep(120);
    }
  }
  return deleted;
}

async function getGroupItemCount(boardId, groupId) {
  const r = await withRetry(() =>
    mondayApi.query(
      `query { boards(ids: ["${boardId}"]) { groups(ids: ["${groupId}"]) { items_page(limit: 1) { items { id } } } } }`
    )
  );
  return r.boards[0].groups[0].items_page.items.length;
}

async function createItem(boardId, groupId, itemName, colValues) {
  const cvJson = JSON.stringify(JSON.stringify(colValues));
  const data   = await withRetry(() =>
    mondayApi.query(
      `mutation {
         create_item(
           board_id: "${boardId}",
           group_id: "${groupId}",
           item_name: ${JSON.stringify(itemName)},
           column_values: ${cvJson}
         ) { id }
       }`
    )
  );
  return data?.create_item?.id;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('=== Rebuilding Questionnaire Template Board (V2 — Professional) ===\n');

  // 1. Load Excel mapping
  const wb   = XLSX.readFile(path.join(ROOT, 'Applications- Subtypes- Document Checklists-Questionnaire.xlsx'));
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  // 2. Fetch current group IDs
  const gData  = await mondayApi.query(`query { boards(ids: ["${Q_BOARD}"]) { groups { id title } } }`);
  const qGroups = {};
  for (const g of gData.boards[0].groups) qGroups[g.title] = g.id;
  console.log('Groups loaded:', Object.keys(qGroups).length);

  // 3. Build task map: caseType → [{ subType, docxPaths }]
  const qTasks = {};
  for (const row of rows) {
    const et   = String(row['Case Type'] || '').trim();
    const qName = String(row['Questionnaire Name'] || '').trim();
    const addQ  = String(row['Additional Questionnaire Name'] || '').trim();
    const canon = EXCEL_TO_CANONICAL[et];
    if (!canon) continue;
    const ct = canon.caseType;
    const st = canon.subType || '';
    if (!qTasks[ct]) qTasks[ct] = [];
    const docxPaths = [];
    for (const name of [qName, addQ]) {
      if (!name || name.toLowerCase().includes('to be finalized') || name === 'N/A') continue;
      const dp = Q_TO_DOCX[name];
      if (dp) docxPaths.push({ path: dp, name });
    }
    if (docxPaths.length) qTasks[ct].push({ subType: st, docxPaths });
  }

  // 4. Process each case type
  // Resume mode: pass --resume flag to skip groups that already have items
  const RESUME_MODE = process.argv.includes('--resume');
  if (RESUME_MODE) console.log('(Resume mode: skipping groups that already have items)\n');

  let totalItems = 0;
  let totalDeleted = 0;

  for (const ct of CASE_TYPES) {
    const groupId = qGroups[ct.caseType];
    if (!groupId) { console.warn('⚠ No group found for:', ct.caseType); continue; }

    const tasks = qTasks[ct.caseType] || [];
    if (!tasks.length) {
      if (!RESUME_MODE) {
        console.log(`${ct.caseType}: no questionnaire (TBF/N/A) — clearing group`);
        const d = await deleteAllItemsInGroup(Q_BOARD, groupId);
        totalDeleted += d;
      } else {
        console.log(`${ct.caseType}: no questionnaire (TBF/N/A) — skipped`);
      }
      continue;
    }

    // In resume mode: check if group already has items — if so, skip it
    if (RESUME_MODE) {
      const existingCount = await getGroupItemCount(Q_BOARD, groupId);
      if (existingCount > 0) {
        console.log(`${ct.caseType}: ✓ already populated (${existingCount}+ items) — skipping`);
        totalItems += existingCount;
        continue;
      }
    }

    // 4a. Clear existing items in this group (full rebuild mode only)
    process.stdout.write(`${ct.caseType}: clearing...`);
    const d = await deleteAllItemsInGroup(Q_BOARD, groupId);
    totalDeleted += d;
    process.stdout.write(` (${d} deleted) → parsing DOCX...\n`);

    // 4b. Dedup DOCX paths and determine sub-type tagging
    const docxUsageCount = {};
    for (const task of tasks) {
      for (const dp of task.docxPaths) {
        docxUsageCount[dp.path] = (docxUsageCount[dp.path] || 0) + 1;
      }
    }

    const seenDocx   = new Set();
    const abbr       = CASE_ABBR[ct.caseType] || 'Q';
    let   seqCounter = 1;

    for (const task of tasks) {
      for (const dp of task.docxPaths) {
        if (seenDocx.has(dp.path)) continue;
        seenDocx.add(dp.path);

        const qItems = await parseDocxSmart(dp.path);
        if (!qItems.length) { console.log('  ⚠ 0 items from:', path.basename(dp.path)); continue; }

        const subTypeTag = (docxUsageCount[dp.path] === 1) ? task.subType : '';
        console.log(`  ${subTypeTag ? ct.caseType + ' / ' + subTypeTag : ct.caseType}: ${qItems.length} questions from ${path.basename(dp.path)}`);

        for (const item of qItems) {
          const code = `${abbr}-${String(seqCounter).padStart(3, '0')}`;
          seqCounter++;

          const colVals = {
            [Q_COLS.questionName]: item.fullName || item.name,
            [Q_COLS.questionCode]: code,
            [Q_COLS.caseType]:     { labels: [ct.caseType] },
            [Q_COLS.category]:     { labels: [item.category] },
            [Q_COLS.version]:      { labels: ['v1.0'] },
            [Q_COLS.required]:     { labels: ['Mandatory'] },
            [Q_COLS.inputType]:    { labels: [item.inputType] },
            [Q_COLS.formLabel]:    item.name.slice(0, 80),
            [Q_COLS.countsReady]:  { label: 'Yes' },
            [Q_COLS.blocking]:     { label: 'No' },
            [Q_COLS.active]:       { label: 'Yes' },
            [Q_COLS.editable]:     { label: 'Yes' },
          };
          if (subTypeTag)    colVals[Q_COLS.subType]  = { labels: [subTypeTag] };
          if (item.helpText) colVals[Q_COLS.helpText]  = { text: item.helpText.slice(0, 2000) };

          await createItem(Q_BOARD, groupId, item.name, colVals);
          totalItems++;
          await sleep(150);
        }
      }
    }
  }

  console.log('\n=== Done ===');
  console.log(`Deleted: ${totalDeleted} old items`);
  console.log(`Created: ${totalItems} new items`);
}

if (process.argv.includes('--dry-run')) {
  console.log('[DRY RUN] Script invoked with --dry-run flag. No board changes will be made.');
  console.log('  Run without --dry-run to execute the actual rebuild.');
  process.exit(0);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
