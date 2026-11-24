/**
 * One-off — the Monday columns for the readable Client ID ("CL-2026-00042"),
 * Faran 2026-11-25 (decision 9):
 *
 *   Clients board   "Client ID"  [text]  — the source of truth   → clientsBoard.json columns.clientId
 *   Client Master   "Client ID"  [text]  — a plain mirror        → clientsBoard.json cmLinkColumns.clientId
 *   Lead Board      "Client ID"  [text]  — a plain mirror        → clientsBoard.json leadLinkColumns.clientId
 *   Client Master   rename "Client Account Id" (text_mm5xmeka) → "Client account (system)"
 *                   (it holds a Monday item id, not the Client ID — staff must not confuse the two)
 *
 * The new ids are saved into src/data/clientsBoard.json (one file for the whole
 * feature; a null id there keeps the feature inert). Saved after EACH column,
 * so a run stopped half way keeps what it made; a re-run adopts a "Client ID"
 * text column that is already on the board instead of making a second one.
 *
 *   node scripts/add-client-id-columns.js            # dry run (default): says what it would do, calls nothing
 *   node scripts/add-client-id-columns.js --apply    # creates / renames on Monday and saves the ids
 *
 * A Monday WRITE — run it only with Faran's go-ahead.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const CFG_PATH   = path.join(__dirname, '..', 'src', 'data', 'clientsBoard.json');
const LEADS_PATH = path.join(__dirname, '..', 'src', 'data', 'newLeadsBoard.json');
const TITLE      = 'Client ID';
const OLD_TITLE  = 'Client Account Id';
const NEW_TITLE  = 'Client account (system)';

/** Where each new column goes: the board (from config) and the config slot that receives its id. */
function targets(cfg, leadBoardId) {
  return [
    { key: 'clients', label: 'Clients board', boardId: String(cfg.boardId || ''),             slot: ['columns', 'clientId'] },
    { key: 'cm',      label: 'Client Master', boardId: String(cfg.clientMasterBoardId || ''), slot: ['cmLinkColumns', 'clientId'] },
    { key: 'lead',    label: 'Lead Board',    boardId: String(leadBoardId || ''),             slot: ['leadLinkColumns', 'clientId'] },
  ];
}
const getSlot = (cfg, [a, b]) => ((cfg[a] || {})[b]) || '';
const setSlot = (cfg, [a, b], v) => { cfg[a] = cfg[a] || {}; cfg[a][b] = v; };

/** PURE — what a run would do, in words (the dry run prints this). */
function planSteps(cfg, leadBoardId) {
  const steps = [];
  for (const t of targets(cfg, leadBoardId)) {
    const have = getSlot(cfg, t.slot);
    steps.push(have
      ? { kind: 'keep', target: t.key, text: `${t.label} (${t.boardId}): "${TITLE}" already set up (${have}) — nothing to do` }
      : { kind: 'create', target: t.key, text: `${t.label} (${t.boardId}): add text column "${TITLE}" (or adopt one already there) → ${t.slot.join('.')}` });
  }
  const oldCol = getSlot(cfg, ['cmLinkColumns', 'clientAccountId']);
  steps.push(oldCol
    ? { kind: 'rename', target: 'cm', text: `Client Master: rename "${OLD_TITLE}" (${oldCol}) → "${NEW_TITLE}" (skipped if already renamed)` }
    : { kind: 'skip', target: 'cm', text: `Client Master: no "${OLD_TITLE}" column in the config — nothing to rename` });
  return steps;
}

async function boardColumns(api, boardId) {
  const d = await api.query('query($b:[ID!]){ boards(ids:$b){ id columns{ id title type } } }', { b: [String(boardId)] });
  const b = ((d && d.boards) || [])[0];
  if (!b) throw new Error(`board ${boardId} not found`);
  return b.columns || [];
}

/**
 * Do it. `apply` false = print the plan only (no call at all).
 * @param {{ apply?: boolean, api?: {query: Function}, cfgPath?: string, leadBoardId?: string, log?: Function, pause?: Function }} opts
 * @returns {Promise<{ applied: boolean, done: string[], steps: object[] }>}
 */
async function run({ apply = false, api = null, cfgPath = CFG_PATH, leadBoardId = '', log = console.log, pause = () => new Promise((r) => setTimeout(r, 250)) } = {}) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const leadId = String(leadBoardId || process.env.MONDAY_LEAD_BOARD_ID || JSON.parse(fs.readFileSync(LEADS_PATH, 'utf8')).boardId || '');
  const steps = planSteps(cfg, leadId);
  log(`Mode: ${apply ? 'APPLY (writes to Monday)' : 'DRY RUN (nothing is called or written)'}`);
  for (const st of steps) log(`  - ${st.text}`);
  if (!apply) { log('(Dry run. Re-run with --apply to do it.)'); return { applied: false, done: [], steps }; }
  if (!api) throw new Error('run: no Monday api given');

  const save = () => fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  const done = [];
  for (const t of targets(cfg, leadId)) {
    if (!t.boardId) throw new Error(`${t.label}: no board id`);
    const cols = await boardColumns(api, t.boardId);
    const have = getSlot(cfg, t.slot);
    if (have) {
      if (!cols.some((c) => c.id === have)) throw new Error(`${t.label}: the config says "${TITLE}" is ${have}, but the board has no such column — stopped (fix the config by hand)`);
      log(`  = ${t.label}: ${have} already there`);
      continue;
    }
    const same = cols.filter((c) => String(c.title).trim().toLowerCase() === TITLE.toLowerCase());
    if (same.length > 1) throw new Error(`${t.label}: ${same.length} columns are titled "${TITLE}" — stopped (keep one by hand)`);
    let id;
    if (same.length === 1) {
      if (same[0].type !== 'text') throw new Error(`${t.label}: a "${TITLE}" column of type ${same[0].type} is already there — stopped`);
      id = same[0].id;
      log(`  = ${t.label}: adopted the "${TITLE}" column already there (${id})`);
    } else {
      const d = await api.query(
        'mutation($b:ID!,$t:String!){ create_column(board_id:$b, title:$t, column_type:text){ id title type } }',
        { b: t.boardId, t: TITLE });
      id = d && d.create_column && d.create_column.id;
      if (!id) throw new Error(`${t.label}: Monday gave no column id`);
      log(`  + ${t.label}: "${TITLE}" → ${id}`);
      await pause();
    }
    setSlot(cfg, t.slot, id);
    save();
    done.push(`${t.key}:${id}`);
  }

  const oldCol = getSlot(cfg, ['cmLinkColumns', 'clientAccountId']);
  if (oldCol) {
    const cols = await boardColumns(api, cfg.clientMasterBoardId);
    const col = cols.find((c) => c.id === oldCol);
    if (!col) log(`  ! Client Master: column ${oldCol} not found — nothing renamed`);
    else if (col.title === NEW_TITLE) log(`  = Client Master: ${oldCol} is already "${NEW_TITLE}"`);
    else {
      await api.query(
        'mutation($b:ID!,$c:String!,$t:String!){ change_column_title(board_id:$b, column_id:$c, title:$t){ id title } }',
        { b: String(cfg.clientMasterBoardId), c: oldCol, t: NEW_TITLE });
      log(`  ~ Client Master: "${col.title}" (${oldCol}) → "${NEW_TITLE}"`);
      done.push(`rename:${oldCol}`);
    }
  }
  log(`Saved ${path.relative(process.cwd(), cfgPath)}. Done.`);
  return { applied: true, done, steps };
}

module.exports = { run, planSteps, targets, TITLE, OLD_TITLE, NEW_TITLE };

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  (async () => {
    let api = null;
    if (apply) { require('dotenv').config(); api = require('../src/services/mondayApi'); }
    await run({ apply, api });
  })().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
