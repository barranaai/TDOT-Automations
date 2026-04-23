/**
 * Read-only diagnostic for a single case's questionnaire state.
 *
 * Usage (run on the production server where .env has MS + Monday credentials):
 *   node scripts/diagnose-questionnaire.js 2026-CEC-EE-004
 *
 * Reports:
 *   1. Monday.com Client Master state: clientName, caseType, subType,
 *      Q Readiness value, Q Completion Status, access token presence.
 *   2. OneDrive Questionnaire/ folder: list of all files with size + modified date.
 *   3. Members manifest: each member's key, type, label, submittedAt.
 *   4. Diagnosis: save vs submit state summary.
 *
 * This script performs NO writes of any kind.
 */

'use strict';

require('dotenv').config();

const axios     = require('axios');
const mondayApi = require('../src/services/mondayApi');
const { getAccessToken } = require('../src/services/microsoftMailService');
const { clientMasterBoardId } = require('../config/monday');

const DRIVE_USER = process.env.MS_FROM_EMAIL || 'noreply@tdotimm.com';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

const CM = {
  caseRef:           'text_mm142s49',
  caseType:          'dropdown_mm0xd1qn',
  caseSubType:       'dropdown_mm0xa0sp',
  accessToken:       'text_mm0x6haq',
  qReadiness:        'numeric_mm0x9dea',
  qCompletionStatus: 'color_mm0x9s08',
};

const caseRef = (process.argv[2] || '').trim();
if (!caseRef) {
  console.error('Usage: node scripts/diagnose-questionnaire.js <caseRef>');
  process.exit(1);
}

function userBase()        { return `${GRAPH_BASE}/users/${encodeURIComponent(DRIVE_USER)}/drive`; }
function childrenUrl(path) { return `${userBase()}/root:/${path.split('/').map(encodeURIComponent).join('/')}:/children`; }
function itemUrl(path)     { return `${userBase()}/root:/${path.split('/').map(encodeURIComponent).join('/')}:`; }

async function fetchCase() {
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(
         limit: 1, board_id: $boardId,
         columns: [{ column_id: $colId, column_values: [$val] }]
       ) {
         items {
           id
           name
           column_values(ids: [
             "${CM.caseRef}", "${CM.caseType}", "${CM.caseSubType}",
             "${CM.accessToken}", "${CM.qReadiness}", "${CM.qCompletionStatus}"
           ]) { id text value }
         }
       }
     }`,
    { boardId: String(clientMasterBoardId), colId: CM.caseRef, val: caseRef }
  );
  return data?.items_page_by_column_values?.items?.[0] || null;
}

async function listQuestionnaireFolder(token, clientName, caseRef) {
  const safeName = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
  const folderPath = `Client Documents/${safeName}/Questionnaire`;
  try {
    const res = await axios.get(
      childrenUrl(folderPath),
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { folderPath, files: res.data.value || [] };
  } catch (err) {
    if (err.response?.status === 404) return { folderPath, files: null };
    throw err;
  }
}

async function readFileIfExists(token, folderPath, filename) {
  try {
    const res = await axios.get(
      `${itemUrl(folderPath + '/' + filename)}/content`,
      { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data).toString('utf8');
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

function line(char = '─') { return char.repeat(72); }

async function run() {
  console.log(`\n${line('=')}`);
  console.log(`  Questionnaire Diagnostic — ${caseRef}`);
  console.log(`${line('=')}\n`);

  // 1. Monday Client Master ─────────────────────────────────────────────────
  console.log(`[1] Monday.com Client Master Board\n${line()}`);
  const item = await fetchCase();
  if (!item) {
    console.error(`  ✗ No case found with reference "${caseRef}".`);
    process.exit(1);
  }
  const col = (id) => item.column_values.find(c => c.id === id);
  const clientName = (item.name || '').trim() || 'Unknown Client';
  const caseType   = col(CM.caseType)?.text || '';
  const subType    = col(CM.caseSubType)?.text || '';
  const token      = col(CM.accessToken)?.text || '';
  const qReady     = col(CM.qReadiness)?.text || '';
  const qStatus    = col(CM.qCompletionStatus)?.text || '';

  console.log(`  Item ID:         ${item.id}`);
  console.log(`  Client Name:     ${clientName}`);
  console.log(`  Case Type:       ${caseType}${subType ? ' / ' + subType : ''}`);
  console.log(`  Access Token:    ${token ? '✓ present (' + token.length + ' chars)' : '✗ MISSING'}`);
  console.log(`  Q Readiness:     ${qReady === '' ? '✗ BLANK' : qReady + '%'}`);
  console.log(`  Q Status:        ${qStatus || '(unset)'}`);

  // 2. OneDrive Questionnaire folder ────────────────────────────────────────
  console.log(`\n[2] OneDrive — Questionnaire/ folder\n${line()}`);
  const msToken = await getAccessToken();
  const { folderPath, files } = await listQuestionnaireFolder(msToken, clientName, caseRef);
  console.log(`  Path: ${folderPath}\n`);
  if (files === null) {
    console.log(`  ✗ Folder does not exist (404).`);
  } else if (!files.length) {
    console.log(`  (empty)`);
  } else {
    for (const f of files) {
      const size = f.size != null ? `${f.size} B` : '—';
      const mod  = f.lastModifiedDateTime || '—';
      console.log(`  • ${f.name.padEnd(55)} ${size.padStart(10)}   ${mod}`);
    }
  }

  // 3. Members manifest ─────────────────────────────────────────────────────
  console.log(`\n[3] Members manifest\n${line()}`);
  const manifestName = `questionnaire-members-${caseRef}.json`;
  const manifestRaw  = await readFileIfExists(msToken, folderPath, manifestName);
  if (!manifestRaw) {
    console.log(`  (no manifest file — single-member case, default "primary" only)`);
  } else {
    try {
      const parsed = JSON.parse(manifestRaw);
      const members = Array.isArray(parsed.members) ? parsed.members : [];
      if (!members.length) {
        console.log(`  (manifest empty)`);
      } else {
        for (const m of members) {
          const submitted = m.submittedAt ? `✓ submittedAt: ${m.submittedAt}` : '✗ NOT submitted';
          console.log(`  • ${m.key.padEnd(20)} ${(m.type || '').padEnd(32)} ${submitted}`);
          if (m.label) console.log(`      label: ${m.label}`);
        }
      }
      console.log(`\n  updatedAt: ${parsed.updatedAt || '—'}`);
    } catch (err) {
      console.log(`  ✗ Could not parse manifest JSON: ${err.message}`);
    }
  }

  // 4. Diagnosis summary ────────────────────────────────────────────────────
  console.log(`\n[4] Diagnosis\n${line()}`);
  const dataFiles = (files || []).filter(f => /^questionnaire-.*\.json$/.test(f.name) && !f.name.startsWith('questionnaire-members-'));
  const hasData   = dataFiles.length > 0;
  const qBlank    = qReady === '';
  const manifest  = manifestRaw ? (JSON.parse(manifestRaw).members || []) : [];
  const anySubmitted = manifest.some(m => m.submittedAt);

  if (hasData && qBlank && !anySubmitted) {
    console.log(`  → Client SAVED but NEVER SUBMITTED.`);
    console.log(`    JSON files exist (autosave wrote them) but no member has a`);
    console.log(`    submittedAt timestamp and Q Readiness is blank. The client`);
    console.log(`    must click the final "Submit" button on the form for`);
    console.log(`    markSubmitted() to fire.`);
  } else if (hasData && qBlank && anySubmitted) {
    console.log(`  → PARTIAL SUBMIT FAILURE.`);
    console.log(`    At least one member has submittedAt set (markMemberSubmitted`);
    console.log(`    ran), but Q Readiness is still blank — the Monday column write`);
    console.log(`    in markSubmitted() Step 3 likely threw. Check Render logs for`);
    console.log(`    errors around the submittedAt timestamp.`);
  } else if (hasData && !qBlank) {
    console.log(`  → Submit appears to have completed (Q Readiness = ${qReady}%).`);
    console.log(`    If an Updates comment is missing, the create_update call in`);
    console.log(`    markSubmitted() Step 4 may have failed after Step 3 succeeded.`);
  } else if (!hasData) {
    console.log(`  → No questionnaire JSON files found.`);
    console.log(`    Either the client never opened/filled the form, or they are`);
    console.log(`    looking at a different case reference.`);
  }

  console.log(`\n${line('=')}\n`);
}

run().catch(err => {
  console.error('\n[Fatal]', err.response?.data || err.message);
  process.exit(1);
});
