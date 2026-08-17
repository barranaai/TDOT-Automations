/**
 * One-off — create the "⏳ Pending — signatures & payment" group on the
 * Client Master Board and record BOTH group ids the case-activation gate
 * needs (meeting decision 2026-08-13: a case sits in the pending group until
 * client signature + RCIC countersign + payment are ALL in; then it moves to
 * the active group).
 *
 * Writes src/data/clientMasterBoard.json: { pendingGroupId, activeGroupId }.
 * The active group is resolved with the SAME title heuristic the handoff has
 * always used to pick its creation group.
 *
 *   node scripts/add-cm-pending-group.js            # dry-run
 *   node scripts/add-cm-pending-group.js --write    # create/record
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE    = process.argv.includes('--write');
const BOARD_ID = process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const CFG_PATH = path.join(__dirname, '..', 'src', 'data', 'clientMasterBoard.json');
const TITLE    = '⏳ Pending — signatures & payment';

async function main() {
  const cfg = fs.existsSync(CFG_PATH) ? JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) : {};
  console.log(`Mode: ${WRITE ? '✏  WRITE' : '🔍 DRY-RUN'}  |  board: ${BOARD_ID}`);

  const data = await mondayApi.query(
    `query($b:[ID!]){ boards(ids:$b){ groups { id title } } }`, { b: [String(BOARD_ID)] });
  const groups = data?.boards?.[0]?.groups || [];
  console.log('Existing groups:', groups.map((g) => `"${g.title}" (${g.id})`).join(', '));

  // Active group — the handoff's historical creation-target heuristic. The
  // pending group itself is excluded so a re-run can never record it as both.
  const isPending = (g) => g.title.trim() === TITLE || /pending.*signature/i.test(g.title);
  const candidates = groups.filter((g) => !isPending(g));
  const active = candidates.find((g) => /retainer sent|new client|active|main/i.test(g.title))
              || candidates.find((g) => /lead/i.test(g.title))
              || candidates[0];
  if (!active) throw new Error('No non-pending groups found on Client Master Board');
  console.log(`Active group: "${active.title}" (${active.id})`);

  const existing = groups.find((g) => g.title.trim() === TITLE || /pending.*signature/i.test(g.title));
  let pendingId = existing && existing.id;
  console.log(existing ? `Found existing pending group (${pendingId})` : `To create: group "${TITLE}"`);
  if (!WRITE) { console.log('(Dry-run. Re-run with --write.)'); return; }

  if (!pendingId) {
    const created = await mondayApi.query(
      `mutation($b: ID!, $t: String!){ create_group(board_id: $b, group_name: $t){ id } }`,
      { b: String(BOARD_ID), t: TITLE });
    pendingId = created?.create_group?.id;
    if (!pendingId) throw new Error('create_group returned no id');
    console.log(`Created group ${pendingId}`);
  }
  const next = { ...cfg, pendingGroupId: pendingId, activeGroupId: active.id };
  fs.writeFileSync(CFG_PATH, JSON.stringify(next, null, 2) + '\n');
  console.log(`✅ Saved pendingGroupId=${pendingId}, activeGroupId=${active.id} to clientMasterBoard.json`);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
