const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const WEBHOOK_URL = process.env.RENDER_URL
  ? `${process.env.RENDER_URL}/webhook/monday`
  : 'https://tdot-automations.onrender.com/webhook/monday';

async function ensureWebhookRegistered() {
  if (!clientMasterBoardId) {
    console.warn('[Webhook] MONDAY_CLIENT_MASTER_BOARD_ID not set — skipping webhook check');
    return;
  }

  try {
    // Check if our webhook is already registered
    const data = await mondayApi.query(
      `query($boardId: ID!) {
         webhooks(board_id: $boardId) { id event }
       }`,
      { boardId: String(clientMasterBoardId) }
    );

    const existing = (data.webhooks || []).find(
      wh => wh.event === 'change_column_value'
    );

    if (existing) {
      console.log(`[Webhook] Already registered (id: ${existing.id}) — no action needed`);
      return;
    }

    // Not found — register it
    console.log('[Webhook] Not registered, registering now...');
    const result = await mondayApi.query(
      `mutation($boardId: ID!, $url: String!, $event: WebhookEventType!) {
         create_webhook(board_id: $boardId, url: $url, event: $event) {
           id board_id
         }
       }`,
      {
        boardId: String(clientMasterBoardId),
        url:     WEBHOOK_URL,
        event:   'change_column_value',
      }
    );

    console.log(`[Webhook] Registered successfully (id: ${result.create_webhook.id})`);
  } catch (err) {
    // Non-fatal — log and continue. The server should still start.
    console.error('[Webhook] Failed to verify/register webhook:', err.message);
  }
}

module.exports = { ensureWebhookRegistered };
