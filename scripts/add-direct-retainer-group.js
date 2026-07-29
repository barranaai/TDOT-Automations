/**
 * One-off — create the "Direct retainer clients" group on the Lead Board.
 * Direct retainer clients (walk-in/referral, case-first flow) keep a technical
 * engine row on the Lead Board (the retainer machinery is keyed to it), but it
 * lives in this dedicated group so it never sits among funnel leads. The group
 * id is saved to newLeadsBoard.json as "directRetainerGroupId" and used by
 * createDirectClient via leadService.createLead({ groupId }).
 *
 *   node scripts/add-direct-retainer-group.js            # dry-run
 *   node scripts/add-direct-retainer-group.js --write    # create if missing
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE    = process.argv.includes('--write');
const BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID || '18416845157';
const CFG_PATH = path.join(__dirname, '..', 'src', 'data', 'newLeadsBoard.json');
const TITLE    = 'Direct retainer clients';

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  console.log(`Mode: ${WRITE ? '✏  WRITE' : '🔍 DRY-RUN'}  |  board: ${BOARD_ID}`);
  if (cfg.directRetainerGroupId) { console.log(`Group already recorded (${cfg.directRetainerGroupId}). Nothing to do.`); return; }

  // Reuse an existing same-titled group if one was hand-made on the board.
  const data = await mondayApi.query(
    `query($b:[ID!]){ boards(ids:$b){ groups { id title } } }`, { b: [String(BOARD_ID)] });
  const groups = data?.boards?.[0]?.groups || [];
  const existing = groups.find((g) => g.title.trim().toLowerCase() === TITLE.toLowerCase());
  let id = existing && existing.id;
  console.log(existing ? `Found existing group "${TITLE}" (${id})` : `To create: group "${TITLE}"`);
  if (!WRITE) { console.log('(Dry-run. Re-run with --write.)'); return; }

  if (!id) {
    const created = await mondayApi.query(
      `mutation($b: ID!, $t: String!){ create_group(board_id: $b, group_name: $t){ id } }`,
      { b: String(BOARD_ID), t: TITLE });
    id = created?.create_group?.id;
    if (!id) throw new Error('create_group returned no id');
    console.log(`Created group ${id}`);
  }
  cfg.directRetainerGroupId = id;
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`✅ Saved directRetainerGroupId=${id} to newLeadsBoard.json`);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
