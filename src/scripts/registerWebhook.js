/**
 * Run this script once to register the Monday.com webhook on the Client Master board.
 * Usage: node src/scripts/registerWebhook.js
 */
require('dotenv').config();
const mondayApi = require('../services/mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const WEBHOOK_URL = process.env.RENDER_URL
  ? `${process.env.RENDER_URL}/webhook/monday`
  : 'https://tdot-automations.onrender.com/webhook/monday';

async function registerWebhook() {
  if (!clientMasterBoardId) {
    throw new Error('MONDAY_CLIENT_MASTER_BOARD_ID is not set in .env');
  }

  console.log(`Registering webhook on board ${clientMasterBoardId}`);
  console.log(`Webhook URL: ${WEBHOOK_URL}`);

  const data = await mondayApi.query(
    `mutation createWebhook($boardId: ID!, $url: String!, $event: WebhookEventType!) {
      create_webhook(board_id: $boardId, url: $url, event: $event) {
        id
        board_id
      }
    }`,
    {
      boardId: String(clientMasterBoardId),
      url: WEBHOOK_URL,
      event: 'change_column_value',
    }
  );

  console.log('Webhook registered:', data.create_webhook);
}

registerWebhook().catch((err) => {
  console.error('Failed to register webhook:', err.message);
  process.exit(1);
});
