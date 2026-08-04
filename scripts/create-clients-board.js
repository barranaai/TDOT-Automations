/**
 * One-time setup — create the "Clients" board (the client registry).
 *
 * One row = one PERSON. A client can have multiple applications (Client
 * Master cases); this board is the cross-application identity: match keys
 * (email/phone), durable profile fields, and navigation to every case.
 * Spouses sharing an email get TWO rows (one per person) — same email on
 * two rows is allowed and correct.
 *
 * Creates a NEW empty board. Touches nothing existing. The only reference to
 * an existing board is the board_relation column pointing at Client Master
 * (read-only link; does not modify Client Master).
 *
 * After creation, writes the board id + column ids to
 * src/data/clientsBoard.json — clientAccountService treats a missing file as
 * "feature dormant", so merely running this script changes no behavior.
 *
 * IMPORTANT: keep this board automation-free in Monday. A board automation
 * stamping labels on new items has burned us before (the Client Master
 * "Alreaday Sent" stamp) — the matcher relies on writing exact values.
 *
 * Safety: default DRY-RUN. Pass --write to actually create.
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE            = process.argv.includes('--write');
const CLIENT_MASTER_ID = process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '18401523447';
const WORKSPACE_ID     = process.env.MONDAY_WORKSPACE_ID || '14447959'; // "TDOT Boards"
const OUT_PATH         = path.join(__dirname, '..', 'src', 'data', 'clientsBoard.json');

const STATUS_LABELS           = ['Active', 'Merged', 'Archived'];
const PREFERRED_CONTACT_LABELS = ['Email', 'Phone', 'WhatsApp'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createColumn(boardId, title, columnType, defaults) {
  const data = await mondayApi.query(
    `mutation($boardId: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
       create_column(board_id: $boardId, title: $title, column_type: $type, defaults: $defaults) {
         id title type
       }
     }`,
    { boardId: String(boardId), title, type: columnType, defaults: defaults ? JSON.stringify(defaults) : null }
  );
  const col = data?.create_column;
  console.log(`   + ${title.padEnd(22)} [${columnType}] → ${col?.id}`);
  return col?.id;
}

async function main() {
  console.log(`Mode: ${WRITE ? '✏  WRITE (live)' : '🔍 DRY-RUN'}\n`);
  if (!WRITE) {
    console.log('Would create board "Clients" (public) with columns:');
    console.log('   • Primary Email         [email]         — MATCH KEY; always written lowercased');
    console.log('   • Alt Emails            [text]          — informational, comma-separated');
    console.log('   • Phone                 [phone]         — second match key');
    console.log('   • Residential Address   [long_text]');
    console.log('   • Date of Birth         [date]          — Sr/Jr disambiguator');
    console.log(`   • Preferred Contact     [status]        — ${PREFERRED_CONTACT_LABELS.join(' / ')}`);
    console.log('   • Client Notes          [long_text]     — person-level staff notes');
    console.log('   • Cases                 [board_relation]→ Client Master (navigation only)');
    console.log('   • Square Customer Id    [text]');
    console.log(`   • Status                [status]        — ${STATUS_LABELS.join(' / ')}`);
    console.log('   • Merged Into           [text]          — item id when Status=Merged');
    console.log('   • Source                [text]          — handoff / direct / backfill / manual');
    console.log('\n(Dry-run only. Re-run with --write to create.)');
    return;
  }

  // ── 1. Create the board (in the target workspace) ──────────────────────────
  const boardData = await mondayApi.query(
    `mutation($name: String!, $workspaceId: ID!) {
       create_board(board_name: $name, board_kind: public, workspace_id: $workspaceId) { id name }
     }`,
    { name: 'Clients', workspaceId: String(WORKSPACE_ID) }
  );
  const boardId = boardData?.create_board?.id;
  if (!boardId) throw new Error('Board creation returned no id');
  console.log(`Created board "Clients" → ${boardId} (workspace ${WORKSPACE_ID})\n`);
  console.log('Creating columns:');

  // ── 2. Columns ─────────────────────────────────────────────────────────────
  const cols = {};
  cols.primaryEmail = await createColumn(boardId, 'Primary Email', 'email');
  await sleep(200);
  cols.altEmails = await createColumn(boardId, 'Alt Emails', 'text');
  await sleep(200);
  cols.phone = await createColumn(boardId, 'Phone', 'phone');
  await sleep(200);
  cols.residentialAddress = await createColumn(boardId, 'Residential Address', 'long_text');
  await sleep(200);
  cols.dateOfBirth = await createColumn(boardId, 'Date of Birth', 'date');
  await sleep(200);
  cols.preferredContact = await createColumn(boardId, 'Preferred Contact', 'status',
    { labels: Object.fromEntries(PREFERRED_CONTACT_LABELS.map((l, i) => [String(i + 1), l])) });
  await sleep(200);
  cols.clientNotes = await createColumn(boardId, 'Client Notes', 'long_text');
  await sleep(200);

  // board_relation to Client Master (best-effort — functional linkage lives in
  // the clientAccountId TEXT column on Client Master, not here)
  try {
    cols.cases = await createColumn(boardId, 'Cases', 'board_relation', { boardIds: [Number(CLIENT_MASTER_ID)] });
  } catch (err) {
    console.warn(`     ⚠ board_relation "Cases" failed (${err.message}). Skipping — text linkage columns are the functional key.`);
    cols.cases = null;
  }
  await sleep(200);

  cols.squareCustomerId = await createColumn(boardId, 'Square Customer Id', 'text');
  await sleep(200);
  cols.status = await createColumn(boardId, 'Status', 'status',
    { labels: Object.fromEntries(STATUS_LABELS.map((l, i) => [String(i + 1), l])) });
  await sleep(200);
  cols.mergedInto = await createColumn(boardId, 'Merged Into', 'text');
  await sleep(200);
  cols.source = await createColumn(boardId, 'Source', 'text');

  // ── 3. Persist board + column ids for clientAccountService ────────────────
  const out = {
    boardId,
    clientMasterBoardId: CLIENT_MASTER_ID,
    columns: cols,
    statusLabels: STATUS_LABELS,
    preferredContactLabels: PREFERRED_CONTACT_LABELS,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote board config → ${path.relative(process.cwd(), OUT_PATH)}`);
  console.log('\nNext: scripts/add-client-account-columns.js (Lead + Client Master linkage columns).');
  console.log('Done.');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
