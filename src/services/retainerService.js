const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const COLS = {
  paymentDate:              'date_mm0xgk76',
  caseStage:                'color_mm0x8faa',
  stageStartDate:           'date_mm0xjm1z',
  checklistTemplateApplied: 'color_mm0xs7kp',
  questionnaireApplied:     'color_mm0x3tpw',
  automationLock:           'color_mm0x3x1x',
  chasingStage:             'color_mm1abve4',
  reminderCount:            'numeric_mm1a4e8r',
};

async function onRetainerPaid({ itemId }) {
  const today = new Date().toISOString().split('T')[0];

  // ── Idempotency guard ──────────────────────────────────────────────────────
  // The Retainer Status column can be re-saved as "Paid" multiple times in a
  // case's life (refund-and-repay, manual edit, automation re-trigger). The
  // original implementation reset checklistTemplateApplied → "No" every time,
  // which caused the next webhook for caseStage = "Document Collection Started"
  // to regenerate the document checklist on top of the existing one. If the
  // sub-type had been edited between payments, the second run produced a new
  // set of execution rows tagged with the new sub-type — sitting alongside the
  // stale rows from the first run — because uniqueKey is per-template-item.
  //
  // Fix: detect re-payment by reading the current checklistTemplateApplied
  // value; if it's already "Yes" the case has been through Document Collection
  // setup before, so only refresh the paymentDate and leave everything else
  // untouched. First-time payments still get the full setup as before.
  let isFirstTimePayment = true;
  let stageAlreadyStarted = false;
  try {
    const data = await mondayApi.query(
      `query($itemId: ID!) {
         items(ids: [$itemId]) {
           column_values(ids: ["${COLS.checklistTemplateApplied}", "${COLS.caseStage}"]) { id text }
         }
       }`,
      { itemId: String(itemId) }
    );
    const cv = {};
    for (const c of (data?.items?.[0]?.column_values || [])) cv[c.id] = (c.text || '').trim();
    if ((cv[COLS.checklistTemplateApplied] || '').toLowerCase() === 'yes') {
      isFirstTimePayment = false;
    }
    stageAlreadyStarted = cv[COLS.caseStage] === 'Document Collection Started';
  } catch (err) {
    // Fail-open: if the read fails, fall back to original behaviour (full
    // reset) so we don't accidentally block a legitimate first-time payment.
    console.warn(`[Retainer] Could not read state for item ${itemId} (${err.message}) — falling back to full reset`);
  }

  let cols;
  if (isFirstTimePayment) {
    cols = {
      [COLS.paymentDate]:              { date: today },
      [COLS.stageStartDate]:           { date: today },
      [COLS.checklistTemplateApplied]: { label: 'No' },
      [COLS.questionnaireApplied]:     { label: 'No' },
      [COLS.automationLock]:           { label: 'No' },
    };
    // Only write the stage when it actually CHANGES. Monday fires
    // change_column_value even for same-label writes (the historical
    // re-payment double-seed bug) — a no-op DCS write here would race the
    // direct deferred-onboarding call below against the stage webhook.
    if (!stageAlreadyStarted) cols[COLS.caseStage] = { label: 'Document Collection Started' };
  } else {
    // Re-payment: refresh the payment date; do NOT clobber the checklist guard.
    cols = { [COLS.paymentDate]: { date: today } };
  }
  // Pre-staged cases sat in the chasing stage UNPAID with the clock running
  // (gate paused the emails, not the timer). On payment, restart the chasing
  // ladder cleanly — otherwise a client who just paid resumes at "Final
  // Notice"/escalation because stageStartDate is months old.
  if (stageAlreadyStarted) {
    cols[COLS.stageStartDate] = { date: today };
    cols[COLS.chasingStage]   = null;       // clear → ladder starts fresh
    cols[COLS.reminderCount]  = '0';
  }
  const colValues = JSON.stringify(cols);

  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(
         board_id:      $boardId,
         item_id:       $itemId,
         column_values: $colValues
       ) { id }
     }`,
    {
      boardId:   String(clientMasterBoardId),
      itemId:    String(itemId),
      colValues,
    }
  );

  if (isFirstTimePayment) {
    console.log(`[Retainer] Payment confirmed for item ${itemId} — stage set to Document Collection Started`);
  } else {
    console.log(`[Retainer] Re-payment detected for item ${itemId} (checklist already applied) — refreshed payment date only`);
  }

  // Deferred-onboarding resume: if staff had ALREADY moved the case to
  // "Document Collection Started" before payment, the payment-gated stage
  // webhook deferred onboarding — and our stage write above is a no-change
  // (same label), so Monday fires no new stage event. Start onboarding
  // directly here, mirroring the webhook handler (email first, then the
  // long-running checklist setup, both fire-and-forget).
  if (isFirstTimePayment && stageAlreadyStarted) {
    console.log(`[Retainer] Item ${itemId} was pre-staged before payment — starting deferred onboarding now`);
    const emailService     = require('./emailService');     // lazy: avoid require cycles
    const checklistService = require('./checklistService');
    emailService.sendIntakeEmail(itemId).catch(err =>
      console.error(`[Retainer] Deferred intake email failed for ${itemId}:`, err.message));
    checklistService.onDocumentCollectionStarted({ itemId, boardId: clientMasterBoardId })
      .then(() => console.log(`[Retainer] Deferred checklist setup complete for item ${itemId}`))
      .catch(err => console.error(`[Retainer] Deferred checklist setup failed for ${itemId}:`, err.message));
  }
}

module.exports = { onRetainerPaid };
