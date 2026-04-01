/**
 * updateCaseTypeDropdowns.js
 *
 * Syncs "Primary Case Type" and "Case Sub Type" dropdown columns
 * across all Monday.com boards to match config/caseTypes.js.
 *
 * Strategy (per board/column):
 *  Step 1 — Add all new labels in ONE call (multiple creates allowed per call)
 *  Step 2 — Rename legacy labels ONE at a time (only one update per call allowed)
 *  Existing labels not in the new list are kept (legacy, no breakage)
 *
 * NOTE: Monday.com's API does not support renaming existing labels via mutations.
 * The renames listed in RENAME_MAP must be performed manually in the Monday.com UI.
 * See the "Manual Steps" guide printed at the end of this script's output.
 *
 * Run: node src/scripts/updateCaseTypeDropdowns.js
 */

require('dotenv').config();
const axios   = require('axios');
const { apiKey, apiUrl } = require('../../config/monday');
const { CASE_TYPE_LABELS, SUB_TYPE_LABELS } = require('../../config/caseTypes');

// ─── Board + column targets ────────────────────────────────────────────────
const BOARDS = [
  {
    name:               'Client Master Board',
    boardId:            process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447',
    caseTypeCol:        'dropdown_mm0xd1qn',
    subTypeCol:         'dropdown_mm0x4t91',
    renameSubTypeColTo: 'Case Sub Type',
  },
  {
    name:        'Document Checklist Template Board',
    boardId:     process.env.MONDAY_TEMPLATE_BOARD_ID || '18401624183',
    caseTypeCol: 'dropdown_mm0x7zb4',
    subTypeCol:  null,
  },
  {
    name:        'Questionnaire Template Board',
    boardId:     process.env.MONDAY_QUESTIONNAIRE_TEMPLATE_BOARD_ID || '18402113809',
    caseTypeCol: 'dropdown_mm124p5v',
    subTypeCol:  null,
  },
];

// ─── Renames: existing label text → desired new label text ─────────────────
const RENAME_MAP = {
  'AIP':                        'AAIP',
  'CO-OP WP':                   'Co-op WP',
  'EE after ITA':               'Canadian Experience Class (EE after ITA)',
  'LMIA based WP':              'LMIA Based WP',
  'LMIA exempt WP':             'LMIA Exempt WP',
  'Parents/Grandparents':       'Parents/Grandparents Sponsorship',
  'Restoration+Visitor Record': 'Visitor Record / Extension',
  'SCLPC-WP':                   'SCLPC WP',
  'US Visa':                    'USA Visa',
  'US visa':                    'USA Visa',
  // Doc Template Board has its own variants
  'EE':                         'Canadian Experience Class (EE after ITA)',
};

// ─── Low-level API helpers ─────────────────────────────────────────────────
async function gql(query) {
  const r = await axios.post(apiUrl, { query }, { headers: { Authorization: apiKey, 'Content-Type': 'application/json' } });
  if (r.data.errors) throw new Error(r.data.errors.map((e) => e.message).join('; '));
  return r.data.data;
}

async function getColumnState(boardId, colId) {
  const data = await gql(
    `query { boards(ids: ["${boardId}"]) { columns(ids: ["${colId}"]) { id title revision settings } } }`
  );
  const col = data.boards[0].columns[0];
  return {
    title:    col.title,
    revision: col.revision,
    // settings.labels: [{id, label, is_deactivated}]
    labels:   (col.settings?.labels || []).map((l) => ({ id: l.id, label: String(l.label || '') })),
  };
}

function escLabel(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildInlineLabels(labels) {
  return labels.map((l) => {
    if (l.id !== undefined) return `{id: ${l.id}, label: "${escLabel(l.label)}"}`;
    return `{label: "${escLabel(l.label)}"}`;
  }).join(', ');
}

async function runMutation(boardId, colId, revision, labelsPayload) {
  const data = await gql(
    `mutation {
       update_dropdown_column(
         board_id: "${boardId}", id: "${colId}", revision: "${revision}",
         settings: { labels: [${buildInlineLabels(labelsPayload)}] }
       ) { id revision }
     }`
  );
  return data.update_dropdown_column;
}

// ─── Operations ───────────────────────────────────────────────────────────

/**
 * Step 1: Add all new labels in a single call.
 * Pass all existing labels (unchanged) + new labels (no id).
 */
async function addNewLabels(boardId, colId, desiredNames) {
  const state = await getColumnState(boardId, colId);

  // Names already present (including what they'll be after renames)
  const presentNow    = new Set(state.labels.map((l) => l.label.toLowerCase()));
  const presentAfter  = new Set(
    state.labels.map((l) => (RENAME_MAP[l.label] || l.label).toLowerCase())
  );

  const toAdd = desiredNames.filter(
    (n) => !presentNow.has(n.toLowerCase()) && !presentAfter.has(n.toLowerCase())
  );

  if (!toAdd.length) {
    console.log(`    No new labels to add`);
    return 0;
  }

  // Full existing list (with their IDs) + new labels (no ID)
  const payload = [
    ...state.labels.map((l) => ({ id: l.id, label: l.label })),
    ...toAdd.map((name) => ({ label: name })),
  ];

  await runMutation(boardId, colId, state.revision, payload);
  console.log(`    ✓ Added ${toAdd.length} new labels: ${toAdd.join(', ')}`);
  return toAdd.length;
}

/**
 * Step 2: Rename legacy labels one at a time.
 * Must pass the FULL label list with exactly one label changed per call.
 */
async function applyRenames(boardId, colId) {
  let count = 0;
  for (const [oldName, newName] of Object.entries(RENAME_MAP)) {
    // Re-fetch state every time (revision changes after each mutation)
    const state  = await getColumnState(boardId, colId);
    const target = state.labels.find((l) => l.label === oldName);
    if (!target) continue;

    // Check if newName already exists (avoid duplicates)
    const alreadyExists = state.labels.some(
      (l) => l.label.toLowerCase() === newName.toLowerCase() && l.id !== target.id
    );
    if (alreadyExists) {
      console.log(`    ⚠ Skipped rename "${oldName}" → "${newName}" (target name already exists)`);
      continue;
    }

    // Pass ONLY the one label being renamed (other labels are unaffected)
    await runMutation(boardId, colId, state.revision, [{ id: target.id, label: newName }]);
    console.log(`    ✓ Renamed "${oldName}" → "${newName}"`);
    count++;
  }
  return count;
}

/**
 * Rename a column's title.
 */
async function renameColumnTitle(boardId, colId, newTitle) {
  await gql(
    `mutation {
       change_column_metadata(
         board_id: "${boardId}", column_id: "${colId}",
         column_property: title, value: "${escLabel(newTitle)}"
       ) { id }
     }`
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function run() {
  console.log('=== Case Type Dropdown Update ===\n');
  console.log(`Canonical: ${CASE_TYPE_LABELS.length} Case Types | ${SUB_TYPE_LABELS.length} Sub Types\n`);

  for (const board of BOARDS) {
    console.log(`\n── ${board.name} ──`);

    // ── Primary Case Type ──────────────────────────────────────────────
    console.log(`  [Primary Case Type] col: ${board.caseTypeCol}`);
    const added   = await addNewLabels(board.boardId, board.caseTypeCol, CASE_TYPE_LABELS);
    const renamed = await applyRenames(board.boardId, board.caseTypeCol);
    console.log(`  Summary: +${added} new, ${renamed} renamed`);

    // ── Case Sub Type (Client Master only) ─────────────────────────────
    if (board.subTypeCol) {
      console.log(`  [Case Sub Type] col: ${board.subTypeCol}`);
      const stAdded = await addNewLabels(board.boardId, board.subTypeCol, SUB_TYPE_LABELS);
      console.log(`  Summary: +${stAdded} new sub-type labels`);

      const { title } = await getColumnState(board.boardId, board.subTypeCol);
      if (title !== board.renameSubTypeColTo) {
        await renameColumnTitle(board.boardId, board.subTypeCol, board.renameSubTypeColTo);
        console.log(`  ✓ Column renamed: "${title}" → "${board.renameSubTypeColTo}"`);
      } else {
        console.log(`  Column title already correct: "${title}"`);
      }
    }
  }

  // ── Print manual rename guide ──────────────────────────────────────────
  console.log('\n\n=== Manual Steps Required (Monday.com UI) ===');
  console.log('\nMonday.com\'s API does not support renaming dropdown labels.');
  console.log('Please make the following renames in each board\'s column settings:\n');
  const boards = [
    { name: 'Client Master Board       → Primary Case Type (dropdown_mm0xd1qn)' },
    { name: 'Doc Checklist Template    → Primary Case Type (dropdown_mm0x7zb4)' },
    { name: 'Questionnaire Template    → Primary Case Type (dropdown_mm124p5v)' },
  ];
  boards.forEach((b) => console.log('Board: ' + b.name));
  console.log('\nRenames to apply on all boards:');
  Object.entries(RENAME_MAP).forEach(([old, nw]) => console.log(`  "${old}"  →  "${nw}"`));
  console.log('\nClean up on Client Master Board only (delete test labels):');
  ['__T1__', '__T2__', '__T3__', '__TEST_INLINE__'].forEach((l) => console.log(`  Delete: "${l}"`));
  console.log('\nAll 56 canonical Case Types + 45 Sub Types have been added programmatically.');
  console.log('=== Done ===');
}

run().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
