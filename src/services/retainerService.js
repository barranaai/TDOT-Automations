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
  paymentStatus:            'color_mm0x9fnn',
};

// Stages a case sits in BEFORE onboarding (same list as onboardingResumeService):
// a first payment at any other stage means staff moved the case on by hand.
const EARLY_STAGES = ['', 'Not Started', 'Pre-Onboarding', 'Retainer Confirmed'];
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function writeCols(itemId, cols) {
  return mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colValues) { id }
     }`,
    { boardId: String(clientMasterBoardId), itemId: String(itemId), colValues: JSON.stringify(cols) }
  );
}

const UNREADABLE_RETRY_MS = 3 * 60 * 1000;
const _unreadableRetry = new Set();   // item ids with a retry pending (one per case per process)

async function onRetainerPaid({ itemId, _retryOfUnreadable = false }) {
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
  let currentStage = '';
  let currentPayment = '';
  let stateRead = false;   // the state read succeeded (the guard below trusts only a real read)
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
               column_values(ids: ["${COLS.checklistTemplateApplied}", "${COLS.caseStage}", "${COLS.paymentStatus}"]) { id text }
             }
           }`,
          { itemId: String(itemId) }
        );
        const cv = {};
        for (const c of (data?.items?.[0]?.column_values || [])) cv[c.id] = (c.text || '').trim();
        if ((cv[COLS.checklistTemplateApplied] || '').toLowerCase() === 'yes') {
          isFirstTimePayment = false;
        }
        currentStage = cv[COLS.caseStage] || '';
        currentPayment = cv[COLS.paymentStatus] || '';
        stageAlreadyStarted = currentStage === 'Document Collection Started';
        readOk = true;
        stateRead = true;
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
      // The board automation used to cover this gap (it moved the stage anyway).
      // Now the app owns it: one more try in a few minutes, by the same path,
      // which proceeds only when the fresh read shows a genuine first payment
      // at an early stage (a case at Document Collection or later is left to
      // the stage webhook / staff — a second start there could double-email).
      if (!_retryOfUnreadable && !_unreadableRetry.has(String(itemId))) {   // never a retry of a retry
        _unreadableRetry.add(String(itemId));
        const t = setTimeout(() => {
          _unreadableRetry.delete(String(itemId));
          onRetainerPaid({ itemId, _retryOfUnreadable: true }).catch((err) => console.error(`[Retainer] Item ${itemId}: retry after unreadable state failed: ${err.message}`));
        }, UNREADABLE_RETRY_MS);
        if (t && t.unref) t.unref();
      }
      if (!_retryOfUnreadable) mondayApi.query(
        `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
        { i: String(itemId),
          b: '⚠️ <b>Payment recorded, but the case state could not be read.</b> To be safe, nothing was reset and no onboarding was re-triggered; the app tries once more in a few minutes. ' +
             'If this is a FIRST-TIME payment and the checklist/intake still has not started after that, set the Case Stage to <b>Document Collection Started</b> (away and back if it is already there).' }
      ).catch(() => {});
    }
  }

  // A retry after an unreadable state proceeds to a full start only from an
  // early stage; anywhere else it is a date refresh (the stage webhook or
  // staff own the case there — a second start could double-email).
  if (_retryOfUnreadable) {
    if (!stateRead) { console.warn(`[Retainer] Item ${itemId}: state still unreadable on retry — payment date only`); await writeCols(itemId, { [COLS.paymentDate]: { date: today } }).catch(() => {}); return; }
    // The flip may have been reverted in the meantime (a payment marked in
    // error is un-marked first): a case that is not Paid now gets nothing.
    if (currentPayment !== 'Paid') { console.log(`[Retainer] Item ${itemId}: retry after unreadable state — Payment Status is now "${currentPayment || 'blank'}", nothing written`); return; }
    if (isFirstTimePayment && stageAlreadyStarted) {
      // Already at Document Collection: the stage webhook / staff own the start
      // (a second start here could double-email). Record the payment, and the
      // explicit "No" the stage webhook's reminder-clock rule keys on, so a
      // restart from the stage still puts the client on the reminder ladder.
      console.log(`[Retainer] Item ${itemId}: retry after unreadable state — already at Document Collection, payment date + flag only`);
      await writeCols(itemId, { [COLS.paymentDate]: { date: today }, [COLS.checklistTemplateApplied]: { label: 'No' } }).catch((err) => console.warn(`[Retainer] Item ${itemId}: retry write failed (${err.message})`));
      return;
    }
    // Past Document Collection: the stage guard below records the payment and
    // tells staff (the same as a readable first pass would have).
    console.log(`[Retainer] Item ${itemId}: retry after unreadable state — ${isFirstTimePayment ? 'first payment, proceeding' : 're-payment, date only'}`);
  }

  // ── Past Document Collection: never pulled back (2026-10-02) ──────────────
  // The Monday board automation used to move ANY case to Document Collection
  // Started on a Paid flip, and this handler did the same for a case whose
  // checklist flag was not "Yes" (a legacy case, or one whose flag the
  // automation had just cleared). Thirteen Internal Review cases went
  // backwards in six weeks, and the stage webhook then re-sent "Your case is
  // ready". A case that staff have moved past Document Collection is theirs:
  // record the payment date, tell them how to start onboarding if it never
  // ran, and touch nothing else.
  if (isFirstTimePayment && stateRead && currentStage && !EARLY_STAGES.includes(currentStage) && !stageAlreadyStarted) {
    console.log(`[Retainer] Item ${itemId}: Paid while at "${currentStage}" — payment date only, the case stays where it is`);
    await writeCols(itemId, { [COLS.paymentDate]: { date: today } });
    // Still graduate the row from the pending group when the agreement is
    // complete (the same rule as a normal first payment; lead-less rows pass).
    try {
      const caseGate = require('./caseGateService');
      const claimants = await require('./leadService').findAllByColumnValue('clientMasterItemId', String(itemId));
      const gateOf = (l) => caseGate.signatureGateForLead({ ...l, retainerPaid: (l.retainerPaid && String(l.retainerPaid).trim()) || today });
      if (!claimants.length || claimants.some((l) => gateOf(l).complete)) await caseGate.moveCaseToActiveGroup(itemId);
    } catch (err) { console.warn(`[Retainer] Item ${itemId}: group move skipped (${err.message})`); }
    mondayApi.query(
      `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
      { i: String(itemId),
        b: `💵 <b>Payment marked while the case is at "${esc(currentStage)}".</b> The case stays at this stage — nothing was reset and no email was sent. ` +
           'If this client never had their document checklist and portal email, flip <b>Re-seed Checklist → Run</b> and use <b>Resend portal access</b> on the client page.' }
    ).catch((err) => console.warn(`[Retainer] Item ${itemId}: stage-guard note failed (${err.message})`));
    return;
  }

  // ── Manual-flip signature gate (meeting 2026-08-13) ────────────────────────
  // This handler also fires when staff flip Payment Status = "Paid" directly
  // on the board — historically the only path with NO signature check, so a
  // manual flip on an unsigned case started full onboarding (intake email +
  // checklist) against an unexecuted retainer. FIRST-TIME payments now verify
  // the linked lead's signatures (client + RCIC countersign for Documenso
  // signings). No linked lead (legacy/manual cases) passes as before; an
  // incomplete gate defers. The case is already "Paid", so the later signing /
  // countersign advance does NOT re-write it (no webhook fires again) — it hands
  // the held case to onboardingResumeService, which recognises the hold by the
  // note posted below. Keep that note's wording in step with its HELD_PATTERNS.
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
        // The case is held, not onboarded — but it must still LOOK paid and sit
        // at Document Collection Started, which is where the held-onboarding
        // service starts it from when the last signature lands. The Monday
        // board automation used to do these writes (2026-10-02: the app owns
        // them now, so the board automation can be switched off). Same values
        // as a first payment, minus the Stage Start Date: that date is the
        // "onboarding ran" marker and is set only when onboarding really starts.
        // Written BEFORE the hold note, so the resume service's "someone
        // changed the stage after the hold" check never trips on our own write.
        const held = {
          [COLS.paymentDate]:              { date: today },
          [COLS.checklistTemplateApplied]: { label: 'No' },
          [COLS.questionnaireApplied]:     { label: 'No' },
          [COLS.automationLock]:           { label: 'No' },
        };
        if (!stageAlreadyStarted) held[COLS.caseStage] = { label: 'Document Collection Started' };
        // As load-bearing as the note (nothing re-does this write later): one
        // retry after a beat; if it still fails, the hold note tells staff.
        let setupFailed = '';
        try { await writeCols(itemId, held); }
        catch (e1) {
          await new Promise((r) => setTimeout(r, 1500));
          try { await writeCols(itemId, held); }
          catch (e2) { setupFailed = e2.message; console.error(`[Retainer] Item ${itemId}: held-case setup write failed twice (${e2.message}) — stage/flags/payment date NOT written; the hold note tells staff`); }
        }
        // This note IS the hold's record: onboardingResumeService starts the case
        // from it when the last signature lands. So one retry, and a loud log.
        const postHold = () => mondayApi.query(
          `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
          { i: String(itemId), b: `⛔ <b>Payment marked, but onboarding is on hold</b> — missing: ${missing.join(' and ')}. ` +
            'The document checklist and client emails start automatically the moment the agreement is fully executed (meeting rule 2026-08-13: signed by both parties AND the consultant AND paid).' +
            (setupFailed ? ' ⚠ The case setup (stage, checklist flags, payment date) could not be written just now — once the agreement is signed, set <b>Checklist Template Applied</b> to No and the Case Stage to <b>Document Collection Started</b> by hand.' : '') }
        );
        await postHold()
          .catch(() => new Promise((r) => setTimeout(r, 1500)).then(postHold))
          .catch((err) => console.error(`[Retainer] Item ${itemId}: the on-hold note could NOT be posted (${err.message}) — this case will not start onboarding by itself when the agreement completes`));
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
  // The board automation used to write the stage and flags independently of
  // this write; now it is the only one (2026-10-02). One retry after a beat;
  // on a double failure a loud note says what to do — and nothing below runs
  // (a start whose record never landed must not email the client).
  try { await writeCols(itemId, cols); }
  catch (e1) {
    await new Promise((r) => setTimeout(r, 1500));
    try { await writeCols(itemId, cols); }
    catch (e2) {
      console.error(`[Retainer] Item ${itemId}: ${isFirstTimePayment ? 'first-payment setup' : 'payment date'} write failed twice (${e2.message}) — nothing started`);
      if (isFirstTimePayment) {
        await mondayApi.query(
          `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
          { i: String(itemId),
            b: '⚠️ <b>Payment recorded, but the case setup could not be written</b> (Monday did not accept the change). Nothing was started and no email was sent. ' +
               'Please set the Case Stage to <b>Document Collection Started</b> (away and back if it is already there) — the intake email, document checklist and questionnaire then start by themselves.' }
        ).catch(() => {});
      }
      return;
    }
  }

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
    // The sponsor's own portal email, same gates as the webhook path (lazy
    // require: the sponsor service reads leads, which read this module).
    require('./sponsorOnboardingService').ensureSponsor({ itemId, mode: 'onboard', trigger: 'retainer-paid' }).catch(err =>
      console.error(`[Retainer] Deferred sponsor onboarding failed for ${itemId}:`, err.message));
    checklistService.onDocumentCollectionStarted({ itemId, boardId: clientMasterBoardId })
      .then(() => console.log(`[Retainer] Deferred checklist setup complete for item ${itemId}`))
      .catch(err => console.error(`[Retainer] Deferred checklist setup failed for ${itemId}:`, err.message));
  }
}

module.exports = { onRetainerPaid, EARLY_STAGES, UNREADABLE_RETRY_MS, _unreadableRetry };
