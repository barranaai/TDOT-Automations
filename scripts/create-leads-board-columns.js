/**
 * One-time setup — add the 33-column schema to the "New Leads - From Automation"
 * board (Lead Board) per the Phase 2 Build Brief, Workstream 1.
 *
 * The item-name column = "Lead ID" (auto). This script adds the other 32 data
 * columns with correct types + dropdown/status options, then writes all column
 * IDs to src/data/newLeadsBoard.json for use when building WS2 (leadService).
 *
 * Safe: only creates columns on the new (empty) Lead Board. Touches nothing else.
 *   node scripts/create-leads-board-columns.js            # dry-run (list only)
 *   node scripts/create-leads-board-columns.js --write    # create columns
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const mondayApi = require('../src/services/mondayApi');

const WRITE    = process.argv.includes('--write');
const BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID || '18416845157';
const OUT_PATH = path.join(__dirname, '..', 'src', 'data', 'newLeadsBoard.json');
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

// Build Brief order. key = camelCase used in code; title = Monday display name.
const COLUMNS = [
  // IDENTITY
  { key: 'fullName',            title: 'Full Name',                 type: 'text' },
  { key: 'email',               title: 'Email',                     type: 'email' },
  { key: 'phone',               title: 'Phone',                     type: 'phone' },
  { key: 'country',             title: 'Country of Residence',      type: 'text' },
  { key: 'preferredContact',    title: 'Preferred Contact',         type: 'dropdown', labels: ['Email', 'Phone', 'WhatsApp'] },
  // SOURCE
  { key: 'sourceChannel',       title: 'Source Channel',            type: 'dropdown', labels: ['Website', 'Email', 'WhatsApp', 'Instagram', 'Phone', 'Other'] },
  { key: 'utmSource',           title: 'UTM Source',                type: 'text' },
  { key: 'utmMedium',           title: 'UTM Medium',                type: 'text' },
  { key: 'utmCampaign',         title: 'UTM Campaign',              type: 'text' },
  // QUALIFICATION
  { key: 'caseTypeInterest',    title: 'Case Type Interest',        type: 'dropdown', labels: ['Study Permit', 'Work Permit', 'Permanent Residence', 'Spousal Sponsorship', 'Visitor Visa', 'Citizenship', 'Other'] },
  { key: 'tier',                title: 'Tier',                      type: 'status',   labels: ['T0', 'T1', 'T2', 'T3', 'T4', 'Newsletter', 'Decline'] },
  { key: 'aiScore',             title: 'AI Eligibility Score',      type: 'numeric' },
  { key: 'aiTalkingPoints',     title: 'AI Talking Points',         type: 'long_text' },
  { key: 'aiComplianceFlags',   title: 'AI Compliance Flags',       type: 'long_text' },
  // BOOKING
  { key: 'bookingStatus',       title: 'Booking Status',            type: 'status',   labels: ['Not Yet', 'Slot Held', 'Booked', 'Abandoned'] },
  { key: 'slotHeldUntil',       title: 'Slot Held Until',           type: 'date' },
  { key: 'bookedSlot',          title: 'Booked Slot',               type: 'date' },
  { key: 'squareConsultTxnId',  title: 'Square Consultation Txn ID',   type: 'text' },
  { key: 'squareConsultOrderId',title: 'Square Consultation Order ID', type: 'text' },
  // CONSULTATION
  { key: 'preConsultSubmitted', title: 'Pre-Consult Submitted',     type: 'status',   labels: ['No', 'Yes'] },
  { key: 'consultationHeld',    title: 'Consultation Held',         type: 'date' },
  { key: 'zoomMeetingId',       title: 'Zoom Meeting ID',           type: 'text' },
  { key: 'outcome',             title: 'Outcome',                   type: 'status',   labels: ['Retain', 'Don’t Retain — Ineligible', 'Don’t Retain — Not Wanted', 'Newsletter', 'Follow-Up'] },
  // RETAINER
  { key: 'retainerSent',        title: 'Retainer Sent',             type: 'date' },
  { key: 'adobeSignAgreementId',title: 'Adobe Sign Agreement ID',   type: 'text' },
  { key: 'retainerSigned',      title: 'Retainer Signed',           type: 'date' },
  { key: 'squareRetainerTxnId', title: 'Square Retainer Txn ID',    type: 'text' },
  { key: 'squareRetainerOrderId',title: 'Square Retainer Order ID', type: 'text' },
  { key: 'retainerPaid',        title: 'Retainer Paid',             type: 'date' },
  // HANDOFF
  { key: 'clientMasterItemId',  title: 'Client Master Item ID',     type: 'text' },
  { key: 'conversionStatus',    title: 'Conversion Status',         type: 'status',   labels: ['New', 'Qualified', 'Booked', 'Consulted', 'Retained — Awaiting Payment', 'Retained — Paid', 'Lost'] },
  // ACCESS
  { key: 'leadToken',           title: 'Lead Token',                type: 'text' },
];

function defaultsFor(col) {
  if (col.type === 'status' && col.labels) {
    return { labels: Object.fromEntries(col.labels.map((l, i) => [String(i + 1), l])) };
  }
  if (col.type === 'dropdown' && col.labels) {
    return { settings: { labels: col.labels.map((name, i) => ({ id: i + 1, name })) } };
  }
  return null;
}

async function createColumn(col) {
  const defaults = defaultsFor(col);
  const data = await mondayApi.query(
    `mutation($boardId: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
       create_column(board_id: $boardId, title: $title, column_type: $type, defaults: $defaults) { id title type }
     }`,
    { boardId: String(BOARD_ID), title: col.title, type: col.type, defaults: defaults ? JSON.stringify(defaults) : null }
  );
  return data?.create_column?.id;
}

async function main() {
  console.log(`Mode: ${WRITE ? '✏  WRITE' : '🔍 DRY-RUN'}  |  board: ${BOARD_ID}\n`);
  console.log(`${COLUMNS.length} data columns (+ "Lead ID" item name = ${COLUMNS.length + 1} total):\n`);

  if (!WRITE) {
    for (const c of COLUMNS) console.log(`  ${c.title.padEnd(30)} [${c.type}]${c.labels ? '  {' + c.labels.join(', ') + '}' : ''}`);
    console.log('\n(Dry-run. Re-run with --write to create.)');
    return;
  }

  const ids = {};
  for (const col of COLUMNS) {
    try {
      const id = await createColumn(col);
      ids[col.key] = id;
      console.log(`  + ${col.title.padEnd(30)} [${col.type}] → ${id}`);
    } catch (err) {
      console.error(`  ✗ ${col.title}: ${err.message}`);
    }
    await sleep(300);
  }

  const out = { boardId: BOARD_ID, workspace: 'CRM', columns: ids, createdAt: new Date().toISOString() };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${Object.keys(ids).length} column IDs → ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
