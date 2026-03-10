const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const WEBHOOK_URL = process.env.RENDER_URL
  ? `${process.env.RENDER_URL}/webhook/monday`
  : 'https://tdot-automations.onrender.com/webhook/monday';

// Each board and its required webhook event types
const BOARD_CONFIGS = [
  {
    name:   'Client Master Board',
    boardId: clientMasterBoardId,
    events: [
      'change_column_value', // Case Stage, Case Type, Retainer Status changes
      'create_item',         // New item → generate Access Token
    ],
  },
  {
    name:    'Questionnaire Execution Board',
    boardId: process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488',
    events: ['change_column_value'], // Response Status changes
  },
  {
    name:    'Document Checklist Execution Board',
    boardId: process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593',
    events: ['change_column_value'], // Document Status changes
  },
];

async function ensureBoardWebhooks({ name, boardId, events }) {
  if (!boardId) {
    console.warn(`[Webhook] Board ID not set for "${name}" — skipping webhook check`);
    return;
  }

  try {
    const data = await mondayApi.query(
      `query($boardId: ID!) {
         webhooks(board_id: $boardId) { id event }
       }`,
      { boardId: String(boardId) }
    );

    const registered = new Set((data.webhooks || []).map(wh => wh.event));

    for (const event of events) {
      if (registered.has(event)) {
        const id = data.webhooks.find(wh => wh.event === event).id;
        console.log(`[Webhook] [${name}] "${event}" already registered (id: ${id})`);
        continue;
      }

      console.log(`[Webhook] [${name}] "${event}" not registered — registering now...`);
      const result = await mondayApi.query(
        `mutation($boardId: ID!, $url: String!, $event: WebhookEventType!) {
           create_webhook(board_id: $boardId, url: $url, event: $event) {
             id board_id
           }
         }`,
        { boardId: String(boardId), url: WEBHOOK_URL, event }
      );

      console.log(`[Webhook] [${name}] "${event}" registered successfully (id: ${result.create_webhook.id})`);
    }
  } catch (err) {
    console.error(`[Webhook] [${name}] Failed to verify/register webhooks:`, err.message);
  }
}

async function ensureWebhookRegistered() {
  for (const config of BOARD_CONFIGS) {
    await ensureBoardWebhooks(config);
  }
}

module.exports = { ensureWebhookRegistered };
