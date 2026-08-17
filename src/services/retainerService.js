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
  {
    // The read decides between a harmless date-refresh and a FULL RESET that
    // clears both "Applied" flags and re-fires onboarding (intake email
    // included). It used to fail OPEN into the reset — and on 2026-08-05 a
    // rate-limit burst during a batch payment-marking made three healthy,
    // fully-seeded cases (2026-SV-004/007/009) read as first-time payments:
    // flags wiped, deferred onboarding re-fired at clients mid-case. The harm
    // is asymmetric: a wrongly-SKIPPED reset is a payment date refresh staff
    // can fix with one click (Re-seed → Run), while a wrongly-RUN reset
    // re-emails real clients and cannot be unsent. So: retry once, and on
    // persistent failure fail CLOSED (re-payment semantics) with a loud note.
    let readOk = false, lastErr = null;
    for (let attempt = 1; attempt <= 2 && !readOk; attempt++) {
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
        readOk = true;
      } catch (err) {
        lastErr = err;
        console.warn(`[Retainer] State read attempt ${attempt} failed for item ${itemId}: ${err.message}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!readOk) {
      isFirstTimePayment = false;   // fail CLOSED: date refresh only, never a blind reset
      stageAlreadyStarted = false;
      console.error(`[Retainer] State unreadable for item ${itemId} after retries (${lastErr && lastErr.message}) — treating as re-payment; NOT resetting flags`);
      mondayApi.query(
        `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
        { i: String(itemId),
          b: '⚠️ <b>Payment recorded, but the case state could not be read.</b> To be safe, nothing was reset and no onboarding was re-triggered. ' +
             'If this is a FIRST-TIME payment and the checklist/intake never started, flip <b>Re-seed Checklist → Run</b> (and resend the intake email if needed).' }
      ).catch(() => {});
    }
  }

  // ── Manual-flip signature gate (meeting 2026-08-13) ────────────────────────
  // This handler also fires when staff flip Payment Status = "Paid" directly
  // on the board — historically the only path with NO signature check, so a
  // manual flip on an unsigned case started full onboarding (intake email +
  // checklist) against an unexecuted retainer. FIRST-TIME payments now verify
  // the linked lead's signatures (client + RCIC countersign for Documenso
  // signings). No linked lead (legacy/manual cases) passes as before; an
  // incomplete gate defers — the signing/countersign triggers re-advance later
  // (advanceCaseToPaid re-writes "Paid", which re-fires this webhook cleanly).
  if (isFirstTimePayment) {
    try {
      const leadService = require('./leadService');
      const caseGate    = require('./caseGateService');
      // The Paid flip being processed IS the payment record, so the paid leg
      // is forced and only SIGNATURES are verified here. ALL claiming leads
      // are consulted (shared cases can carry several; one fully-executed
      // claimant is sufficient evidence the agreement is real).
      const gateOf = (l) => caseGate.signatureGateForLead({ ...l, retainerPaid: (l.retainerPaid && String(l.retainerPaid).trim()) || today });
      let claimants = await leadService.findAllByColumnValue('clientMasterItemId', String(itemId));
      let pass = !claimants.length || claimants.some((l) => gateOf(l).complete);
      if (!pass) {
        // One retry after a beat — the legit advance path writes the lead's
        // countersign state moments before writing "Paid"; a stale read here
        // must not bounce a genuinely complete gate.
        await new Promise((r) => setTimeout(r, 2000));
        claimants = await leadService.findAllByColumnValue('clientMasterItemId', String(itemId)).catch(() => claimants);
        pass = !claimants.length || claimants.some((l) => gateOf(l).complete);
      }
      if (!pass) {
        const missing = gateOf(claimants[0]).missing;
        console.warn(`[Retainer] Item ${itemId}: Paid flip with activation gate incomplete (missing: ${missing.join(', ')}) — onboarding DEFERRED`);
        await mondayApi.query(
          `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
          { i: String(itemId), b: `⛔ <b>Payment marked, but onboarding is on hold</b> — missing: ${missing.join(' and ')}. ` +
            'The document checklist and client emails start automatically the moment the agreement is fully executed (meeting rule 2026-08-13: signed by both parties AND the consultant AND paid).' }
        ).catch(() => {});
        return;
      }
      // Gate passed on a first-time payment — graduate the row from the
      // pending group (best-effort; no-op for rows already active).
      await caseGate.moveCaseToActiveGroup(itemId);
    } catch (err) {
      console.warn(`[Retainer] Signature-gate check failed for item ${itemId}: ${err.message} — proceeding (legacy behaviour)`);
    }
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
