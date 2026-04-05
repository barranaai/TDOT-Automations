/**
 * rebuildQBoard.js  —  Questionnaire Template Board only
 * Runs the Q-board portion of the rebuild using corrected deduplication logic.
 */
require('dotenv').config();
const path     = require('path');
const fs       = require('fs');
const XLSX     = require('xlsx');
const mammoth  = require('mammoth');
const mondayApi = require('../services/mondayApi');
const { CASE_TYPES } = require('../../config/caseTypes');

const ROOT   = path.join(__dirname, '../../');
const Q_BOARD = process.env.MONDAY_QUESTIONNAIRE_TEMPLATE_BOARD_ID;

const Q_COLS = {
  caseType:  'dropdown_mm124p5v',
  subType:   'dropdown_mm20h84d',
  category:  'dropdown_mm12w5fd',
  version:   'dropdown_mm12spk7',
  required:  'dropdown_mm12dqc7',
  inputType: 'dropdown_mm12pn7g',
};

// ── Same mappings as rebuildTemplateBoards.js ──────────────────────────────
const EXCEL_TO_CANONICAL = {
  'AAIP': { caseType: 'AAIP' }, 'OINP': { caseType: 'OINP' }, 'NSNP': { caseType: 'NSNP' },
  'BCPNP': { caseType: 'BCPNP' }, 'RCIP': { caseType: 'RCIP' }, 'Manitoba PNP': { caseType: 'Manitoba PNP' },
  'RNIP': { caseType: 'RNIP' }, 'SNIP': { caseType: 'SNIP' },
  'Canadian Experience Class (Profile Recreation+ITA+Submission)': { caseType: 'Canadian Experience Class (Profile Recreation+ITA+Submission)' },
  'Canadian Experience Class (Profile+ITA+Submission)': { caseType: 'Canadian Experience Class (Profile+ITA+Submission)' },
  'EE after ITA ( ITA+submission)': { caseType: 'Canadian Experience Class (EE after ITA)' },
  'Inland Spousal Sponsorship (Marriage)': { caseType: 'Inland Spousal Sponsorship', subType: 'Marriage' },
  'Inland Spousal Sponsorship (Common law)': { caseType: 'Inland Spousal Sponsorship', subType: 'Common Law Partner' },
  'Outland Spousal Sonsorship (Marriage)': { caseType: 'Outland Spousal Sponsorship' },
  'Parents/Grandparents Sponsorship': { caseType: 'Parents/Grandparents Sponsorship' },
  'Child Sponsorship': { caseType: 'Child Sponsorship' },
  'Addition of Spouse': { caseType: 'Addition of Spouse' },
  'Federal PR': { caseType: 'Federal PR' },
  'BOWP': { caseType: 'BOWP' }, 'Co-op WP': { caseType: 'Co-op WP' }, 'Concurrent WP': { caseType: 'Concurrent WP' },
  'LMIA Based WP (Inside Canada)': { caseType: 'LMIA Based WP', subType: 'Inside Canada' },
  'LMIA based WP Extension': { caseType: 'LMIA Based WP', subType: 'Extension (Inside Canada)' },
  'LMIA Based WP (Outside Canada)': { caseType: 'LMIA Based WP', subType: 'Outside Canada' },
  'LMIA Exempt WP': { caseType: 'LMIA Exempt WP' },
  'PGWP': { caseType: 'PGWP', subType: 'Single Applicant' },
  'PGWP Extension': { caseType: 'PGWP' },
  'Refugee WP': { caseType: 'Refugee WP' }, 'SCLPC WP': { caseType: 'SCLPC WP' },
  'SOWP Inland': { caseType: 'SOWP' },
  'SOWP Outland': { caseType: 'SOWP', subType: 'Outland (Spouse or Child)' },
  'SOWP Extension ': { caseType: 'SOWP', subType: 'Extension (Spouse or Child)' },
  'SOWP Extension': { caseType: 'SOWP', subType: 'Extension (Spouse or Child)' },
  'NB WP Extension': { caseType: 'NB WP Extension' }, 'Francophone Mobility WP': { caseType: 'Francophone Mobility WP' },
  'Supervisa- Parents': { caseType: 'Supervisa', subType: 'Parents' },
  'Supervisa- Grandparents': { caseType: 'Supervisa', subType: 'Grandparents' },
  'Employer Portal': { caseType: 'Employer Portal' }, 'LMIA': { caseType: 'LMIA' }, 'ETA': { caseType: 'ETA' },
  'PR Card Renewal': { caseType: 'PR Card Renewal' }, 'PRTD': { caseType: 'PRTD' },
  'Renunciation of PR': { caseType: 'Renunciation of PR' }, 'Citizenship': { caseType: 'Citizenship' },
  'TRP': { caseType: 'TRP' }, 'TRV': { caseType: 'TRV' },
  'Visitor Record+Restoration': { caseType: 'Visitor Record / Extension', subType: 'Visitor Record + Restoration' },
  'Visitor Extension': { caseType: 'Visitor Record / Extension', subType: 'Visitor Extension' },
  'Visitor Record ': { caseType: 'Visitor Record / Extension', subType: 'Visitor Record' },
  'Visitor Record': { caseType: 'Visitor Record / Extension', subType: 'Visitor Record' },
  'Visitor Visa': { caseType: 'Visitor Visa' }, 'USA Visa': { caseType: 'USA Visa' },
  'Misc': { caseType: 'Miscellaneous' }, 'PFL': { caseType: 'PFL' }, 'Reconsideration': { caseType: 'Reconsideration' },
  'Request Letter': { caseType: 'Request Letter' }, 'Refugee': { caseType: 'Refugee' }, 'H & C': { caseType: 'H & C' },
  'Appeal': { caseType: 'Appeal' }, 'Amendment of document': { caseType: 'Amendment of Document' },
  'ICAS/WES/IQAS': { caseType: 'ICAS/WES/IQAS' }, 'Invitation letter': { caseType: 'Invitation Letter' },
  'Notary': { caseType: 'Notary' }, 'OCI +Passport Surrender': { caseType: 'OCI / Passport Surrender' },
  'PRAA': { caseType: 'PRAA' },
  'Study Permit  ': { caseType: 'Study Permit' }, 'Study Permit': { caseType: 'Study Permit' },
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

const SECTION_TO_CATEGORY = {
  'profile': 'Personal', 'personal': 'Personal', 'family': 'Personal', 'address': 'Personal',
  'marital': 'Personal', 'contact': 'Personal', 'travel': 'Travel', 'trip': 'Travel',
  'immigration': 'Travel', 'education': 'Education', 'academic': 'Education',
  'employment': 'Employment', 'work': 'Employment', 'occupation': 'Employment', 'job': 'Employment',
  'background': 'Background', 'criminal': 'Background', 'health': 'Background', 'medical': 'Background',
  'financial': 'Financial', 'finance': 'Financial', 'income': 'Financial', 'asset': 'Financial',
  'legal': 'Legal', 'sponsor': 'Legal', 'relationship': 'Legal',
};

function inferCategory(s) {
  const lower = (s || '').toLowerCase();
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
      if (line.match(/^section\s+\d/i) || line.match(/^(personal|family|travel|education|employment|background|financial|legal|address|marital|contact|immigration|sponsor|relationship)/i)) {
        category = inferCategory(line); continue;
      }
      if (
        line.length < 3 ||
        line.match(/^(DD\/MM|From|To|Date|Family Name|Given Name|Relationship|Country|Province|City|Street|Unit|Postal)/i) ||
        line.match(/^(PLEASE READ|Questionnaire for|Main Applicant|Dependent Spouse|Accompanying)/i) ||
        line.match(/^(\d+\.?\s*$)/) || line.match(/^\(.*\)$/) || line.match(/https?:\/\//)
      ) continue;
      items.push({ name: line.slice(0, 255), category });
    }
    return items;
  } catch (e) {
    console.warn('  DOCX parse error:', path.basename(filePath), '-', e.message);
    return [];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function run() {
  console.log('=== Rebuilding Questionnaire Template Board ===\n');

  // Load Excel
  const wb   = XLSX.readFile(path.join(ROOT, 'Applications- Subtypes- Document Checklists-Questionnaire.xlsx'));
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  // Fetch existing groups
  const gData = await mondayApi.query(`query { boards(ids: ["${Q_BOARD}"]) { groups { id title } } }`);
  const qGroups = {};
  for (const g of gData.boards[0].groups) qGroups[g.title] = g.id;
  console.log('Q groups loaded:', Object.keys(qGroups).length, '\n');

  // Build qTasks
  const qTasks = {};
  for (const row of rows) {
    const et = String(row['Case Type'] || '').trim();
    const qName  = String(row['Questionnaire Name'] || '').trim();
    const addQ   = String(row['Additional Questionnaire Name'] || '').trim();
    const canon  = EXCEL_TO_CANONICAL[et];
    if (!canon) continue;
    const ct = canon.caseType;
    const st = canon.subType || '';
    if (!qTasks[ct]) qTasks[ct] = [];
    const docxPaths = [];
    if (qName && !qName.toLowerCase().includes('to be finalized') && qName !== 'N/A') {
      const dp = Q_TO_DOCX[qName];
      if (dp) docxPaths.push({ path: dp, name: qName });
    }
    if (addQ && addQ !== 'N/A' && !addQ.toLowerCase().includes('to be finalized')) {
      const dp = Q_TO_DOCX[addQ];
      if (dp) docxPaths.push({ path: dp, name: addQ });
    }
    if (docxPaths.length) qTasks[ct].push({ subType: st, docxPaths });
  }

  // Populate
  let qItemCount = 0;
  for (const ct of CASE_TYPES) {
    const groupId = qGroups[ct.caseType];
    if (!groupId) { console.warn('⚠ No group found for:', ct.caseType); continue; }
    const tasks = qTasks[ct.caseType] || [];
    if (!tasks.length) { console.log(ct.caseType + ': no questionnaire (TBF/N/A)'); continue; }

    // Count how many sub-type tasks use each DOCX path
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
        if (!qItems.length) { console.log('  ⚠ 0 items from:', path.basename(dp.path)); continue; }

        // Only tag sub-type when this docx is exclusive to one sub-type task
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

  console.log('\n=== Done ===');
  console.log('Questionnaire Board: created', qItemCount, 'items');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
