const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const COLS = {
  paymentDate:              'date_mm0xgk76',
  caseStage:                'color_mm0x8faa',
  stageStartDate:           'date_mm0xjm1z',
  checklistTemplateApplied: 'color_mm0xs7kp',
  questionnaireApplied:     'color_mm0x3tpw',
  automationLock:           'color_mm0x3x1x',
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
  try {
    const data = await mondayApi.query(
      `query($itemId: ID!) {
         items(ids: [$itemId]) {
           column_values(ids: ["${COLS.checklistTemplateApplied}"]) { id text }
         }
       }`,
      { itemId: String(itemId) }
    );
    const currentApplied = (data?.items?.[0]?.column_values?.[0]?.text || '').trim().toLowerCase();
    if (currentApplied === 'yes') {
      isFirstTimePayment = false;
    }
  } catch (err) {
    // Fail-open: if the read fails, fall back to original behaviour (full
    // reset) so we don't accidentally block a legitimate first-time payment.
    console.warn(`[Retainer] Could not read state for item ${itemId} (${err.message}) — falling back to full reset`);
  }

  const colValues = isFirstTimePayment
    ? JSON.stringify({
        [COLS.paymentDate]:              { date: today },
        [COLS.caseStage]:                { label: 'Document Collection Started' },
        [COLS.stageStartDate]:           { date: today },
        [COLS.checklistTemplateApplied]: { label: 'No' },
        [COLS.questionnaireApplied]:     { label: 'No' },
        [COLS.automationLock]:           { label: 'No' },
      })
    : JSON.stringify({
        // Re-payment: only refresh the payment date. Do NOT clobber case state
        // or the checklist guard — the case is already in flight.
        [COLS.paymentDate]: { date: today },
      });

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
}

module.exports = { onRetainerPaid };
