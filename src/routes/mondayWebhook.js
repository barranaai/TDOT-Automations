const express    = require('express');
const router     = express.Router();
const mondayApi  = require('../services/mondayApi');
const checklistService            = require('../services/checklistService');
const questionnaireService        = require('../services/questionnaireService');
const caseRefService              = require('../services/caseRefService');
const accessTokenService          = require('../services/accessTokenService');
const retainerService             = require('../services/retainerService');
const emailService                = require('../services/emailService');
const questionnaireReviewService  = require('../services/questionnaireReviewService');
const documentReviewService       = require('../services/documentReviewService');
const stageGateService            = require('../services/stageGateService');
const { onStageAdvanced, onCaseClosed, TERMINAL_STAGES } = stageGateService;
const notify                      = require('../services/mondayNotificationService');

const CLIENT_MASTER_BOARD_ID               = String(process.env.MONDAY_CLIENT_MASTER_BOARD_ID || '');
const QUESTIONNAIRE_EXECUTION_BOARD_ID     = process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488';
const DOCUMENT_EXECUTION_BOARD_ID         = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';

// Column IDs — Document Execution Board
const DOC_STATUS_COL     = 'color_mm0zwgvr';
// Column IDs — Questionnaire Execution Board
const Q_RESPONSE_COL     = 'color_mm135pm1';
// Column IDs — Client Master Board
const CASE_HEALTH_COL    = 'color_mm0xf5ry';
const EXPIRY_FLAG_COL    = 'color_mm1a7vbn';
const CLIENT_BLOCKED_COL = 'color_mm1b5gqv';
const ESCALATION_CM_COL  = 'color_mm0x7bje';

const CASE_STAGE_COL_ID           = 'color_mm0x8faa';
const CASE_STAGE_COL_TITLE        = 'Case Stage';
const CASE_TYPE_COL_ID            = 'dropdown_mm0xd1qn';
const RETAINER_STATUS_COL_ID      = 'color_mm0x9fnn';
const CASE_REF_COL_ID             = 'text_mm142s49';
const DOCUMENT_COLLECTION_STARTED = 'Document Collection Started';
const SUBMISSION_READY            = 'Submission Ready';

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

    const itemName = event.pulseName || event.itemName || String(pulseId);

    // ── Questionnaire Execution Board events ─────────────────────────────
    if (boardIdStr === QUESTIONNAIRE_EXECUTION_BOARD_ID && type === 'update_column_value') {
      questionnaireReviewService.onColumnChange({ itemId: pulseId, columnId, value }).catch(err =>
        console.error('[QReview] Error:', err.message)
      );

      // Notify reviewer when a response is answered
      if (columnId === Q_RESPONSE_COL) {
        const label = value?.label?.text || '';
        if (label === 'Answered') {
          notify.onResponseAnswered(pulseId, itemName).catch(() => {});
        }
        if (label === 'Needs Clarification') {
          notify.onNeedsClarificationNotify(pulseId, itemName).catch(() => {});
        }
      }
      return;
    }

    // ── Document Checklist Execution Board events ─────────────────────────
    if (boardIdStr === DOCUMENT_EXECUTION_BOARD_ID && type === 'update_column_value') {
      documentReviewService.onColumnChange({ itemId: pulseId, columnId, value }).catch(err =>
        console.error('[DocReview] Error:', err.message)
      );

      // Notify reviewer when a document is received
      if (columnId === DOC_STATUS_COL) {
        const label = value?.label?.text || '';
        if (label === 'Received') {
          notify.onDocumentReceived(pulseId, itemName).catch(() => {});
        }
        if (label === 'Rework Required') {
          notify.onDocumentReworkRequired(pulseId, itemName).catch(() => {});
        }
      }
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

    // ── Client Master notification triggers ───────────────────────────────

    // Case Health → Red
    if (columnId === CASE_HEALTH_COL && value?.label?.text === 'Red') {
      const caseRef = event.value?.label?.text || '';
      notify.onCaseHealthRed(pulseId, itemName, caseRef).catch(() => {});
    }

    // Expiry Risk Flag → Flagged
    if (columnId === EXPIRY_FLAG_COL && value?.label?.text === 'Flagged') {
      const caseRef = await mondayApi.query(
        `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${CASE_REF_COL_ID}"]) { text } } }`,
        { id: String(pulseId) }
      ).then(d => d?.items?.[0]?.column_values?.[0]?.text?.trim() || '').catch(() => '');
      notify.onExpiryFlagged(pulseId, itemName, caseRef).catch(() => {});
    }

    // Client-Blocked Status → Yes
    if (columnId === CLIENT_BLOCKED_COL && value?.label?.text === 'Yes') {
      const caseRef = await mondayApi.query(
        `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${CASE_REF_COL_ID}"]) { text } } }`,
        { id: String(pulseId) }
      ).then(d => d?.items?.[0]?.column_values?.[0]?.text?.trim() || '').catch(() => '');
      notify.onClientBlocked(pulseId, itemName, caseRef).catch(() => {});
    }

    // Escalation Required → Yes (Client Master only)
    if (columnId === ESCALATION_CM_COL && value?.label?.text === 'Yes') {
      const caseRef = await mondayApi.query(
        `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${CASE_REF_COL_ID}"]) { text } } }`,
        { id: String(pulseId) }
      ).then(d => d?.items?.[0]?.column_values?.[0]?.text?.trim() || '').catch(() => '');
      notify.onEscalationRequired(pulseId, itemName, caseRef).catch(() => {});
    }

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

    // Case Stage changes
    if (columnTitle === CASE_STAGE_COL_TITLE) {
      const newStage = value?.label?.text || '';

      // → Document Collection Started: create execution rows + send intake email
      if (newStage === DOCUMENT_COLLECTION_STARTED) {
        console.log(`[Webhook] Case Stage → "${DOCUMENT_COLLECTION_STARTED}" for item ${pulseId}`);
        await Promise.allSettled([
          checklistService.onDocumentCollectionStarted({ itemId: pulseId, boardId }),
          questionnaireService.onDocumentCollectionStarted({ itemId: pulseId, boardId }),
        ]);
        emailService.sendIntakeEmail(pulseId).catch(err =>
          console.error('[Email] Failed to send intake email:', err.message)
        );
      }

      // → Submission Ready (set manually by supervisor): lock the case
      if (newStage === SUBMISSION_READY) {
        console.log(`[Webhook] Case Stage → "${SUBMISSION_READY}" for item ${pulseId} — locking`);
        // Fetch case ref for logging
        const itemData = await mondayApi.query(
          `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${CASE_REF_COL_ID}"]) { text } } }`,
          { id: String(pulseId) }
        ).catch(() => null);
        const caseRef = itemData?.items?.[0]?.column_values?.[0]?.text?.trim() || String(pulseId);
        stageGateService.onSubmissionReady({ masterItemId: pulseId, caseRef }).catch(err =>
          console.error('[StageGate] Submission Ready lock failed:', err.message)
        );
      }

      // → Internal Review or Submission Preparation: reset Stage Start Date
      // Covers both manual changes and automated gate advances (harmless duplicate in the latter case).
      if (newStage === 'Internal Review' || newStage === 'Submission Preparation') {
        const refData = await mondayApi.query(
          `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${CASE_REF_COL_ID}"]) { text } } }`,
          { id: String(pulseId) }
        ).catch(() => null);
        const caseRef = refData?.items?.[0]?.column_values?.[0]?.text?.trim() || String(pulseId);
        console.log(`[Webhook] Case Stage → "${newStage}" for ${caseRef} — resetting Stage Start Date`);
        onStageAdvanced({ masterItemId: pulseId, newStage, caseRef }).catch(err =>
          console.error('[StageGate] Stage Start Date reset failed:', err.message)
        );
      }

      // → Terminal stage (Closed / Withdrawn / Cancelled): lock case + clear chasing/escalation
      if (TERMINAL_STAGES.has(newStage)) {
        const refData = await mondayApi.query(
          `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${CASE_REF_COL_ID}"]) { text } } }`,
          { id: String(pulseId) }
        ).catch(() => null);
        const caseRef = refData?.items?.[0]?.column_values?.[0]?.text?.trim() || String(pulseId);
        console.log(`[Webhook] Case Stage → "${newStage}" for ${caseRef} — locking case`);
        onCaseClosed({ masterItemId: pulseId, newStage, caseRef }).catch(err =>
          console.error('[StageGate] Case closure lock failed:', err.message)
        );
      }
    }
  } catch (err) {
    console.error('[Webhook] Error handling event:', err.message);
  }
});

module.exports = router;
