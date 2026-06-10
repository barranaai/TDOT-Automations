/**
 * One-time — register a Monday webhook on the Lead Board so Phase 2 reacts to
 * Outcome = Retain and the Retainer Signed confirmation.
 *
 * Run AFTER Phase 2 is deployed (needs the live RENDER_URL):
 *   RENDER_URL=https://tdot-automations.onrender.com node scripts/register-lead-webhook.js
 */

'use strict';

require('dotenv').config();
const mondayApi = require('../src/services/mondayApi');

const LEAD_BOARD_ID = process.env.MONDAY_LEAD_BOARD_ID;
const RENDER_URL    = process.env.RENDER_URL;

async function main() {
  if (!LEAD_BOARD_ID) throw new Error('MONDAY_LEAD_BOARD_ID not set');
  if (!RENDER_URL)    throw new Error('RENDER_URL not set (need the live URL)');

  const url = `${RENDER_URL.replace(/\/$/, '')}/webhook/lead`;
  const data = await mondayApi.query(
    `mutation($boardId: ID!, $url: String!, $event: WebhookEventType!) {
       create_webhook(board_id: $boardId, url: $url, event: $event) { id board_id }
     }`,
    { boardId: String(LEAD_BOARD_ID), url, event: 'change_column_value' }
  );
  console.log('✅ Lead Board webhook registered:', JSON.stringify(data.create_webhook));
  console.log('   URL:', url);
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
