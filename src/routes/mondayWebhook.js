const express = require('express');
const router = express.Router();
const checklistService = require('../services/checklistService');

const CASE_STAGE_COLUMN_TITLE = 'Case Stage';
const DOCUMENT_COLLECTION_STARTED = 'Document Collection Started';

router.post('/', async (req, res) => {
  // Monday.com challenge handshake (required when registering a webhook)
  if (req.body.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  const { event } = req.body;

  if (!event) {
    return res.status(400).json({ error: 'No event payload received' });
  }

  // Acknowledge immediately so Monday doesn't retry
  res.json({ status: 'received' });

  try {
    const { type, columnTitle, value, pulseId, boardId } = event;

    // Only act on column value changes for "Case Stage"
    if (
      type === 'update_column_value' &&
      columnTitle === CASE_STAGE_COLUMN_TITLE &&
      value?.label?.text === DOCUMENT_COLLECTION_STARTED
    ) {
      console.log(
        `[Webhook] Case Stage → "${DOCUMENT_COLLECTION_STARTED}" for item ${pulseId} on board ${boardId}`
      );
      await checklistService.onDocumentCollectionStarted({ itemId: pulseId, boardId });
    }
  } catch (err) {
    console.error('[Webhook] Error handling event:', err.message);
  }
});

module.exports = router;
