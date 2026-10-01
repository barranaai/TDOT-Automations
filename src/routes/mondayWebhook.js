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
const { onStageAdvanced, onCaseClosed, onEscalationCleared, TERMINAL_STAGES } = stageGateService;
const notify                      = require('../services/mondayNotificationService');
const { ASSIGNMENT_COL_IDS }      = notify;

const { clientMasterBoardId, executionBoardId, questionnaireExecutionBoardId } = require('../../config/monday');
const CLIENT_MASTER_BOARD_ID           = String(clientMasterBoardId);
const QUESTIONNAIRE_EXECUTION_BOARD_ID = String(questionnaireExecutionBoardId);
const DOCUMENT_EXECUTION_BOARD_ID      = String(executionBoardId);

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
const CASE_SUB_TYPE_COL_ID        = 'dropdown_mm0x4t91';
const RETAINER_STATUS_COL_ID      = 'color_mm0x9fnn';
const CASE_REF_COL_ID             = 'text_mm142s49';
const CLIENT_EMAIL_COL_ID         = 'text_mm0xw6bp';
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

    // ── Questionnaire Execution Board — RETIRED (HTML form is source of truth) ──
    if (boardIdStr === QUESTIONNAIRE_EXECUTION_BOARD_ID) {
      return;
    }

    // ── Document Checklist Execution Board events ─────────────────────────
    if (boardIdStr === DOCUMENT_EXECUTION_BOARD_ID && type === 'update_column_value') {
      documentReviewService.onColumnChange({ itemId: pulseId, columnId, value, previousValue: event.previousValue }).catch(err =>
        console.error('[DocReview] Error:', err.message)
      );

      // Notify reviewer when a document is received
      if (columnId === DOC_STATUS_COL) {
        const label = value?.label?.text || '';
        if (label === 'Received') {
          notify.onDocumentReceived(pulseId, itemName).catch(() => {});
        }
        // A "Rework Required" re-saved unchanged is not a new flag — don't ping
        // the case team again. Fails open when Monday sends no previousValue.
        if (label === 'Rework Required' && event.previousValue?.label?.text !== 'Rework Required') {
          notify.onDocumentReworkRequired(pulseId, itemName).catch(() => {});
        }
      }
      return;
    }

    // ── Client Master Board events ────────────────────────────────────────

    // New item created → generate Access Token (Client Master board only)
    if (type === 'create_item') {
      if (CLIENT_MASTER_BOARD_ID && boardIdStr !== CLIENT_MASTER_BOARD_ID) {
        console.log(`[Webhook] Ignoring create_item from non-client-master board ${boardId}`);
        return;
      }
      console.log(`[Webhook] New item created: ${pulseId} on board ${boardId}`);
      accessTokenService.onItemCreated({ itemId: pulseId }).catch(err =>
        console.error('[AccessToken] Error:', err.message)
      );
      return;
    }

    if (type !== 'update_column_value') return;

    // All remaining handlers are Client Master Board only
    if (boardIdStr !== CLIENT_MASTER_BOARD_ID) return;

    // ── Client Master notification triggers ───────────────────────────────
    // Fetch case ref once if this event is for any of the notification columns.
    const isCMNotificationCol = (
      columnId === CASE_HEALTH_COL    ||
      columnId === EXPIRY_FLAG_COL    ||
      columnId === CLIENT_BLOCKED_COL ||
      columnId === ESCALATION_CM_COL
    );

    if (isCMNotificationCol) {
      const caseRef = await mondayApi.query(
        `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${CASE_REF_COL_ID}"]) { text } } }`,
        { id: String(pulseId) }
      ).then(d => d?.items?.[0]?.column_values?.[0]?.text?.trim() || '').catch(() => '');

      const colLabel = value?.label?.text || '';

      // Case Health → Red
      if (columnId === CASE_HEALTH_COL && colLabel === 'Red')
        notify.onCaseHealthRed(pulseId, itemName, caseRef).catch(() => {});

      // Expiry Risk Flag → Flagged
      if (columnId === EXPIRY_FLAG_COL && colLabel === 'Flagged')
        notify.onExpiryFlagged(pulseId, itemName, caseRef).catch(() => {});

      // Client-Blocked Status → Yes
      if (columnId === CLIENT_BLOCKED_COL && colLabel === 'Yes')
        notify.onClientBlocked(pulseId, itemName, caseRef).catch(() => {});

      // Escalation Required → Yes
      if (columnId === ESCALATION_CM_COL && colLabel === 'Yes')
        notify.onEscalationRequired(pulseId, itemName, caseRef).catch(() => {});

      // Escalation Required → No: clear stale Escalation Reason
      if (columnId === ESCALATION_CM_COL && colLabel === 'No')
        onEscalationCleared({ masterItemId: pulseId, caseRef }).catch(err =>
          console.error('[StageGate] Escalation clear failed:', err.message)
        );
    }

    // Retainer Payment Status → Paid
    if (columnId === RETAINER_STATUS_COL_ID && value?.label?.text === 'Paid') {
      console.log(`[Webhook] Retainer marked as Paid for item ${pulseId}`);
      retainerService.onRetainerPaid({ itemId: pulseId }).catch(err =>
        console.error('[Retainer] Error:', err.message)
      );
      // Staff record e-transfers by setting this label by hand. That used to
      // start onboarding without ever telling the LEAD, so the consultant
      // portal, the case cockpit and the KPI dashboard went on showing the
      // client as unpaid. Carry the payment back to the lead so every surface
      // tells the same story.
      require('../services/retainerStatusReconciler').reconcileCase(pulseId).catch(err =>
        console.warn('[StatusSync] Lead back-stamp failed:', err.message)
      );
    }

    // Client Email corrected → resend intake email if already sent to wrong address
    if (columnId === CLIENT_EMAIL_COL_ID) {
      emailService.onClientEmailChanged(pulseId).catch(err =>
        console.error('[Email] Failed to handle client email change:', err.message)
      );
    }

    // People column changed → notify newly assigned person
    if (ASSIGNMENT_COL_IDS.includes(columnId)) {
      notify.onCaseAssigned({
        masterItemId: pulseId,
        itemName,
        columnId,
        newValue: JSON.stringify(value || {}),
      }).catch(() => {});
    }

    // Re-seed Checklist button: staff set "Run" → additive re-seed → Done ✓/Failed ⚠.
    // Only the exact "Run" label acts — our own result writes and clears are ignored.
    {
      const reseedButtonService = require('../services/reseedButtonService');
      if (columnId === reseedButtonService.RESEED_COL && value?.label?.text === reseedButtonService.LABEL_RUN) {
        reseedButtonService.onReseedButton(pulseId).catch(err =>
          console.error('[Reseed] Button handler error:', err.message));
      }
    }

    // Case Sub Type set LATE (after the payment trigger already fired):
    // the multi-variant gate blocked seeding while the sub-type was blank, and
    // the one-shot DCS/payment triggers never re-fire — so the case sat paid
    // with no checklist (live: 2026-CEC-PS-064). Resume seeding; the service
    // re-checks the exact stranded state (Paid + DCS + not applied) itself, so
    // sub-type edits on healthy or already-seeded cases are no-ops.
    if (columnId === CASE_SUB_TYPE_COL_ID) {
      const newSub  = (value?.chosenValues || []).map((c) => c && c.name).filter(Boolean).join(', ');
      const prevSub = (event.previousValue?.chosenValues || []).map((c) => c && c.name).filter(Boolean).join(', ');
      // Only a REAL arrival acts: a clear (blank) or a same-value re-save
      // (Monday fires change_column_value for those too) must not re-trigger.
      if (newSub && newSub !== prevSub) {
        require('../services/checklistService').resumeSeedingAfterSubType({ itemId: pulseId }).catch(err =>
          console.error('[Checklist] Sub-type resume failed:', err.message));
        // The sponsor's document list depends on the sub type, so a case that
        // was Paid + DCS with the sub type blank had no sponsor email either.
        // The sub-type gate is the checklist resume's: Paid, stage exactly
        // Document Collection Started, applied exactly No (the payment flow's
        // explicit value — a blank legacy case never sends), plus the signature
        // gate and the once-per-case marker. So this is a no-op — nothing sent
        // AND nothing created — on unpaid, healthy, legacy or already-onboarded
        // cases; before payment the case-ref chain's 'prepare' pass (after the
        // intake's family rows) creates the row.
        require('../services/sponsorOnboardingService').ensureSponsor({ itemId: pulseId, mode: 'onboard', trigger: 'sub-type' }).catch(err =>
          console.error('[Sponsor] sub-type onboarding failed:', err.message));
      }
    }

    // Primary Case Type set → generate Case Reference Number
    if (columnId === CASE_TYPE_COL_ID) {
      const caseType = value?.chosenValues?.[0]?.name || '';
      if (caseType) {
        console.log(`[Webhook] Primary Case Type set to "${caseType}" for item ${pulseId}`);
        caseRefService.onCaseTypeSet({ itemId: pulseId, caseType }).catch(err =>
          console.error(`[CaseRef] Error assigning case ref to item ${pulseId} (${caseType}):`, err.message)
        );
      }
    }

    // Case Stage changes (matched by column ID; title kept as fallback label only)
    if (columnId === CASE_STAGE_COL_ID) {
      const newStage = value?.label?.text || '';

      // → Document Collection Started: create execution rows + send intake email
      if (newStage === DOCUMENT_COLLECTION_STARTED) {
        // No-change guard: Monday DOES fire change_column_value for same-label
        // writes (documented by the historical re-payment double-seed bug in
        // retainerService). A DCS→DCS "change" must never re-run onboarding.
        if (event.previousValue?.label?.text === DOCUMENT_COLLECTION_STARTED) {
          console.log(`[Webhook] Item ${pulseId}: stage re-saved as "${DOCUMENT_COLLECTION_STARTED}" (no change) — ignoring`);
          return;
        }
        console.log(`[Webhook] Case Stage → "${DOCUMENT_COLLECTION_STARTED}" for item ${pulseId}`);

        // HARD GATE: onboarding (intake email + checklist + the chasing that
        // follows) requires Payment Status = Paid. Staff can move the stage
        // manually on unpaid cases — that must NOT start emailing the client.
        // When the case is later marked Paid, retainerService.onRetainerPaid
        // starts onboarding directly (the stage won't re-fire this webhook).
        // FAIL CLOSED on read errors: a wrongly-deferred paid client is a
        // visible staff note fixed in minutes; a wrongly-emailed unpaid client
        // cannot be un-emailed.
        let isPaid = false;
        let readFailed = false;
        try {
          const payData = await mondayApi.query(
            `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${RETAINER_STATUS_COL_ID}"]) { text } } }`,
            { id: String(pulseId) }
          );
          isPaid = (payData?.items?.[0]?.column_values?.[0]?.text || '').trim() === 'Paid';
        } catch (err) {
          readFailed = true;
          console.warn(`[Webhook] Payment status read failed for ${pulseId} (${err.message}) — deferring (fail-closed)`);
        }
        if (!isPaid) {
          console.log(`[Webhook] Item ${pulseId} moved to "${DOCUMENT_COLLECTION_STARTED}" but Payment Status ≠ Paid — onboarding DEFERRED`);
          mondayApi.query(
            `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
            { itemId: String(pulseId),
              body: readFailed
                ? '⏸ <b>Onboarding NOT started:</b> the payment status could not be verified just now. ' +
                  'Once you confirm the payment is marked Paid, retry by switching the Case Stage away and back to Document Collection Started.'
                : '⏸ <b>Onboarding deferred:</b> this case was moved to Document Collection Started, but Payment Status is not "Paid". ' +
                  'The client intake email, document checklist, and reminders will start automatically the moment the payment is marked Paid.' }
          ).catch(() => {});
          return;
        }

        // SIGNATURE GATE (meeting 2026-08-13): a manual stage drag must not
        // out-run the signatures either. The PAYMENT leg is already proven by
        // the board (the Paid hard gate above), so it is forced here and only
        // signatures are verified — on ALL claiming leads (shared cases). A
        // case that has ALREADY been onboarded (checklist applied) is exempt:
        // re-drags of pre-gate cases must never re-defer them. No linked lead
        // = legacy/manual case → passes as before.
        let startDateBlank = false;   // read alongside the flag — see the chasing restart below
        try {
          const chkData = await mondayApi.query(
            `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["color_mm0xs7kp", "date_mm0xjm1z"]) { id text } } }`,
            { id: String(pulseId) }
          ).catch(() => null);
          const chk = {};
          for (const c of (chkData?.items?.[0]?.column_values || [])) chk[c.id] = (c.text || '').trim();
          const alreadyOnboarded = (chk.color_mm0xs7kp || '').toLowerCase() === 'yes';
          // Only a payment-flow case (the explicit "No" the payment webhook writes
          // on a first payment and on a hold) — a legacy, manually-managed case (blank) is
          // never put on the reminder ladder by a re-drag.
          startDateBlank = !!chkData?.items?.[0] && !chk.date_mm0xjm1z && (chk.color_mm0xs7kp || '').toLowerCase() === 'no';
          if (!alreadyOnboarded) {
            const claimants = await require('../services/leadService').findAllByColumnValue('clientMasterItemId', String(pulseId));
            const caseGate = require('../services/caseGateService');
            const today = new Date().toISOString().slice(0, 10);
            const gateOf = (l) => caseGate.signatureGateForLead({ ...l, retainerPaid: (l.retainerPaid && String(l.retainerPaid).trim()) || today });
            if (claimants.length && !claimants.some((l) => gateOf(l).complete)) {
              const missing = gateOf(claimants[0]).missing;
              console.log(`[Webhook] Item ${pulseId} at DCS but activation gate incomplete (missing: ${missing.join(', ')}) — onboarding DEFERRED`);
              // This note IS the hold's record (onboardingResumeService starts the
              // case from it when the last signature lands): one retry, loud failure.
              const postHold = () => mondayApi.query(
                `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
                { itemId: String(pulseId),
                  body: `⛔ <b>Onboarding deferred:</b> missing ${missing.join(' and ')}. ` +
                    'The intake email and checklist start automatically once the agreement is fully executed and paid (meeting rule 2026-08-13).' }
              );
              postHold()
                .catch(() => new Promise((r) => setTimeout(r, 1500)).then(postHold))
                .catch((err) => console.error(`[Webhook] Item ${pulseId}: the on-hold note could NOT be posted (${err.message}) — this case will not start onboarding by itself when the agreement completes`));
              return;
            }
          }
        } catch (err) {
          console.warn(`[Webhook] Signature-gate read failed for ${pulseId}: ${err.message} — proceeding (payment gate already passed)`);
        }

        // The document-chasing clock. The payment webhook sets it on a normal
        // first payment, but a case that was HELD for signatures and is now
        // started by moving it (back) to this stage never got one — and with
        // no Stage Start Date the reminders never run. Same payload as the
        // payment webhook's; only when blank (and the checklist flag reads the
        // explicit "No"), so no existing clock is moved.
        if (startDateBlank) {
          mondayApi.query(
            `mutation($b: ID!, $i: ID!, $c: JSON!){ change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c){ id } }`,
            { b: String(boardId), i: String(pulseId),
              c: JSON.stringify({ date_mm0xjm1z: { date: new Date().toISOString().slice(0, 10) }, color_mm1abve4: null, numeric_mm1a4e8r: '0' }) }
          ).catch((err) => console.warn(`[Webhook] Chasing clock not started for ${pulseId}: ${err.message}`));
        }

        // Fire the intake email immediately — it only needs the case ref and access token,
        // both of which are already set before the stage change. Do NOT await the checklist
        // setup first: that can take 1-2 minutes for large templates and will be killed by
        // a Render deploy mid-flight, causing the email to never fire.
        emailService.sendIntakeEmail(pulseId).catch(err =>
          console.error('[Email] Failed to send intake email:', err.message)
        );
        // The sponsor / inviter's own portal email (same link, their document
        // list). The service re-checks Paid + stage + not-yet-applied + the
        // signature gate itself and sends once per case (OneDrive marker), so
        // a re-drag or a duplicate delivery cannot email the sponsor twice.
        require('../services/sponsorOnboardingService').ensureSponsor({ itemId: pulseId, mode: 'onboard', trigger: 'dcs' }).catch(err =>
          console.error('[Sponsor] onboarding failed:', err.message)
        );

        // Run the long-running setup tasks in parallel (fire-and-forget from Express's
        // perspective). Node.js will keep them alive until the process exits.
        // Q execution board retired — questionnaires are HTML-form based (see htmlQuestionnaireService).
        checklistService.onDocumentCollectionStarted({ itemId: pulseId, boardId })
          .then(() => console.log(`[Webhook] Checklist setup complete for item ${pulseId}`))
          .catch(err => console.error(`[Webhook] Checklist setup failed for ${pulseId}:`, err.message));
      }

      // Fetch case ref once for all stage actions that need it (not Document Collection Started)
      if (newStage !== DOCUMENT_COLLECTION_STARTED) {
        const refData = await mondayApi.query(
          `query($id: ID!) { items(ids: [$id]) { column_values(ids: ["${CASE_REF_COL_ID}"]) { text } } }`,
          { id: String(pulseId) }
        ).catch(() => null);
        const caseRef = refData?.items?.[0]?.column_values?.[0]?.text?.trim() || String(pulseId);

        // → Submission Ready (set manually by supervisor): lock the case
        if (newStage === SUBMISSION_READY) {
          console.log(`[Webhook] Case Stage → "${SUBMISSION_READY}" for ${caseRef} — locking`);
          stageGateService.onSubmissionReady({ masterItemId: pulseId, caseRef }).catch(err =>
            console.error('[StageGate] Submission Ready lock failed:', err.message)
          );
        }

        // → Internal Review or Submission Preparation: reset Stage Start Date
        // Covers both manual changes and automated gate advances (harmless duplicate in the latter case).
        if (newStage === 'Internal Review' || newStage === 'Submission Preparation') {
          console.log(`[Webhook] Case Stage → "${newStage}" for ${caseRef} — resetting Stage Start Date`);
          onStageAdvanced({ masterItemId: pulseId, newStage, caseRef }).catch(err =>
            console.error('[StageGate] Stage Start Date reset failed:', err.message)
          );
        }

        // → Terminal stage (Closed / Withdrawn / Cancelled): lock case + clear chasing/escalation
        if (TERMINAL_STAGES.has(newStage)) {
          console.log(`[Webhook] Case Stage → "${newStage}" for ${caseRef} — locking case`);
          onCaseClosed({ masterItemId: pulseId, newStage, caseRef }).catch(err =>
            console.error('[StageGate] Case closure lock failed:', err.message)
          );
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Error handling event:', err.message);
  }
});

module.exports = router;
