const express = require('express');
const router = express.Router();
const checklistService            = require('../services/checklistService');
const questionnaireService        = require('../services/questionnaireService');
const caseRefService              = require('../services/caseRefService');
const accessTokenService          = require('../services/accessTokenService');
const retainerService             = require('../services/retainerService');
const emailService                = require('../services/emailService');
const questionnaireReviewService  = require('../services/questionnaireReviewService');
const documentReviewService       = require('../services/documentReviewService');

const CLIENT_MASTER_BOARD_ID               = String(process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '');
const QUESTIONNAIRE_EXECUTION_BOARD_ID     = process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488';
const DOCUMENT_EXECUTION_BOARD_ID         = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';

const CASE_STAGE_COL_TITLE        = 'Case Stage';
const CASE_TYPE_COL_ID            = 'dropdown_mm0xd1qn';
const RETAINER_STATUS_COL_ID      = 'color_mm0x9fnn';
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
    const { type, columnTitle, columnId, value, pulseId, boardId } = event;
    const boardIdStr = String(boardId || '');

    // ── Questionnaire Execution Board events ─────────────────────────────
    if (boardIdStr === QUESTIONNAIRE_EXECUTION_BOARD_ID && type === 'update_column_value') {
      questionnaireReviewService.onColumnChange({ itemId: pulseId, columnId, value }).catch(err =>
        console.error('[QReview] Error:', err.message)
      );
      return;
    }

    // ── Document Checklist Execution Board events ─────────────────────────
    if (boardIdStr === DOCUMENT_EXECUTION_BOARD_ID && type === 'update_column_value') {
      documentReviewService.onColumnChange({ itemId: pulseId, columnId, value }).catch(err =>
        console.error('[DocReview] Error:', err.message)
      );
      return;
    }

    // ── Client Master Board events ────────────────────────────────────────

    // New item created → generate Access Token
    if (type === 'create_item') {
      console.log(`[Webhook] New item created: ${pulseId} on board ${boardId}`);
      accessTokenService.onItemCreated({ itemId: pulseId }).catch(err =>
        console.error('[AccessToken] Error:', err.message)
      );
      return;
    }

    if (type !== 'update_column_value') return;

    // Retainer Payment Status → Paid
    if (columnId === RETAINER_STATUS_COL_ID && value?.label?.text === 'Paid') {
      console.log(`[Webhook] Retainer marked as Paid for item ${pulseId}`);
      retainerService.onRetainerPaid({ itemId: pulseId }).catch(err =>
        console.error('[Retainer] Error:', err.message)
      );
    }

    // Primary Case Type set → generate Case Reference Number
    if (columnId === CASE_TYPE_COL_ID) {
      const caseType = value?.chosenValues?.[0]?.name || '';
      if (caseType) {
        console.log(`[Webhook] Primary Case Type set to "${caseType}" for item ${pulseId}`);
        caseRefService.onCaseTypeSet({ itemId: pulseId, caseType }).catch(err =>
          console.error('[CaseRef] Error assigning case ref:', err.message)
        );
      }
    }

    // Case Stage → Document Collection Started
    if (
      columnTitle === CASE_STAGE_COL_TITLE &&
      value?.label?.text === DOCUMENT_COLLECTION_STARTED
    ) {
      console.log(
        `[Webhook] Case Stage → "${DOCUMENT_COLLECTION_STARTED}" for item ${pulseId} on board ${boardId}`
      );

      await Promise.allSettled([
        checklistService.onDocumentCollectionStarted({ itemId: pulseId, boardId }),
        questionnaireService.onDocumentCollectionStarted({ itemId: pulseId, boardId }),
      ]);

      // Send client intake email with both form links
      emailService.sendIntakeEmail(pulseId).catch(err =>
        console.error('[Email] Failed to send intake email:', err.message)
      );
    }
  } catch (err) {
    console.error('[Webhook] Error handling event:', err.message);
  }
});

module.exports = router;
