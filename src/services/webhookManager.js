const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const WEBHOOK_URL = process.env.RENDER_URL
  ? `${process.env.RENDER_URL}/webhook/monday`
  : 'https://tdot-automations.onrender.com/webhook/monday';

// Webhooks we need registered on the Client Master Board
const REQUIRED_WEBHOOKS = [
  'change_column_value', // Case Stage changes, Case Type changes, etc.
  'create_item',         // New item created → generate Access Token
];

async function ensureWebhookRegistered() {
  if (!clientMasterBoardId) {
    console.warn('[Webhook] MONDAY_CLIENT_MASTER_BOARD_ID not set — skipping webhook check');
    return;
  }

  try {
    const data = await mondayApi.query(
      `query($boardId: ID!) {
         webhooks(board_id: $boardId) { id event }
       }`,
      { boardId: String(clientMasterBoardId) }
    );

    const registered = new Set((data.webhooks || []).map(wh => wh.event));

    for (const event of REQUIRED_WEBHOOKS) {
      if (registered.has(event)) {
        const id = data.webhooks.find(wh => wh.event === event).id;
        console.log(`[Webhook] "${event}" already registered (id: ${id})`);
        continue;
      }

      console.log(`[Webhook] "${event}" not registered — registering now...`);
      const result = await mondayApi.query(
        `mutation($boardId: ID!, $url: String!, $event: WebhookEventType!) {
           create_webhook(board_id: $boardId, url: $url, event: $event) {
             id board_id
           }
         }`,
        {
          boardId: String(clientMasterBoardId),
          url:     WEBHOOK_URL,
          event,
        }
      );

      console.log(`[Webhook] "${event}" registered successfully (id: ${result.create_webhook.id})`);
    }
  } catch (err) {
    console.error('[Webhook] Failed to verify/register webhooks:', err.message);
  }
}

module.exports = { ensureWebhookRegistered };
