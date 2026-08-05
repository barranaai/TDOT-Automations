/**
 * Retainer Status Reconciler — keeps the Client Master "Payment Status" and the
 * Lead Board's retainer dates telling the SAME story about a case.
 *
 * WHY THIS EXISTS
 * ---------------
 * The lead→case status bridge is a chain of best-effort Monday writes. Every
 * link is individually idempotent, but each one is also individually skippable:
 *
 *   - paymentService.recordRetainerPaid stamps `retainerPaid` on the lead FIRST,
 *     then flips Client Master → "Paid". If that second write fails (Monday 5xx,
 *     rate limit, a Render deploy killing the request mid-flight) the lead is
 *     marked paid and the case is not. Every retry path then short-circuits on
 *     `if (lead.retainerPaid) … return` — the webhook redelivery, the 5-minute
 *     payment reconciler, and a staff re-click of "Mark paid" all skip it. The
 *     case never onboards and nothing ever says so.
 *
 *   - handoffService.ensureSignedState has the same shape: the Payment Status
 *     stamp is `.catch(warn)`, the lead's conversionStatus flip that follows is
 *     not, and the once-only gate keys off that conversionStatus. A stamp that
 *     failed once is never attempted again.
 *
 *   - The reverse direction had no bridge at all. Staff record e-transfers by
 *     setting Payment Status = "Paid" directly on the board; that starts
 *     onboarding (retainerService.onRetainerPaid) but never wrote the payment
 *     back to the lead, so the consultant portal, the case cockpit and the KPI
 *     dashboard kept showing the client as unpaid.
 *
 * Those individual call sites are now fixed to retry, but a retry only helps
 * while the process is alive. This sweep is the durable backstop: it re-derives
 * what each case's Payment Status SHOULD be from the lead and repairs whatever
 * disagrees, on a schedule, forever.
 *
 * SAFETY: evidence of money is only ever ADDITIVE here.
 *   - A case may be upgraded to "Paid". It is NEVER downgraded from "Paid" —
 *     if the board says paid and the lead does not, the LEAD is corrected, on
 *     the principle that a human marking the board paid is the firm's actual
 *     record of an e-transfer arriving.
 *   - "Signed (Unpaid)" is only ever written over a blank cell or the board
 *     automation's own default. A staff-chosen label ("Not Paid", "Working on
 *     it") is left alone — it says the same thing and a human chose it.
 */

'use strict';

const mondayApi   = require('./mondayApi');
const leadService = require('./leadService');
const { clientMasterBoardId } = require('../../config/monday');

const CM = {
  paymentStatus:   'color_mm0x9fnn',
  paymentConfDate: 'date_mm0xgk76',
  caseRef:         'text_mm142s49',
  caseStage:       'color_mm0x8faa',
};

/**
 * Labels a Payment Status cell can hold that carry no staff intent — a blank
 * cell, or the value the board's own automation stamps on every new item
 * ("Alreaday Sent" is the board's spelling, not a typo here). Only these may be
 * overwritten with "Signed (Unpaid)".
 */
const UNAUTHORED_LABELS = ['', 'alreaday sent', 'already sent'];

const PAID = 'Paid';
const SIGNED_UNPAID = 'Signed (Unpaid)';

const s = (v) => String(v == null ? '' : v).trim();
const todayISO = () => new Date().toISOString().split('T')[0];

/**
 * What the Client Master Payment Status should read, given the lead's retainer
 * dates. Returns null when we have no business touching the cell.
 *
 * Note the paid-BEFORE-signed case deliberately derives null rather than
 * "Paid": a walk-in who pays at the desk before signing has genuinely paid, but
 * "Paid" on the case is the onboarding trigger, and onboarding must not start
 * against an unsigned retainer (paymentService.recordRetainerPaid defers it for
 * exactly this reason). handoffService.ensureSignedState runs the deferred
 * advance the moment they sign; until then the cell is left alone.
 *
 * @returns {'Paid'|'Signed (Unpaid)'|null}
 */
function deriveCmPaymentStatus(lead) {
  if (!lead) return null;
  const signed = s(lead.retainerSigned);
  if (!signed) return null;                    // unsigned: nothing to assert, either way
  return s(lead.retainerPaid) ? PAID : SIGNED_UNPAID;
}

/**
 * Compare one lead against its case row and decide the single repair to make.
 * Pure — all the judgement lives here so it can be tested exhaustively.
 *
 * @param {object}  lead              lead with retainerSigned/retainerPaid/clientMasterItemId
 * @param {?string} cmPaymentStatus   current Payment Status text, or null if the row is gone
 * @returns {{action:string, to?:string, reason:string}}
 *   action: 'none' | 'upgrade-cm' | 'backstamp-lead' | 'no-case' | 'dangling'
 */
function classifyDrift(lead, cmPaymentStatus) {
  if (!lead) return { action: 'none', reason: 'no lead' };

  const want = deriveCmPaymentStatus(lead);
  const linked = s(lead.clientMasterItemId);

  if (!linked) {
    // A signed or paid lead with no case row is a broken handoff, not a status
    // drift — it needs a human, so surface it rather than inventing a case.
    return want
      ? { action: 'no-case', reason: `lead is ${want === PAID ? 'paid' : 'signed'} but has no Client Master row` }
      : { action: 'none', reason: 'no case row, no retainer activity' };
  }
  if (cmPaymentStatus == null) {
    return { action: 'dangling', reason: `lead points at Client Master item ${linked}, which no longer exists` };
  }

  const have = s(cmPaymentStatus);
  const havePaid = have.toLowerCase() === 'paid';

  // The board says paid and the lead doesn't: staff recorded an e-transfer
  // directly on the board. Correct the lead — never the other way round.
  if (havePaid && !s(lead.retainerPaid)) {
    return { action: 'backstamp-lead', reason: 'case is marked Paid but the lead has no retainer payment date' };
  }
  if (want === PAID && !havePaid) {
    return { action: 'upgrade-cm', to: PAID, reason: `lead was paid on ${s(lead.retainerPaid)} but the case still reads "${have || '(blank)'}"` };
  }
  if (want === SIGNED_UNPAID && have !== SIGNED_UNPAID && UNAUTHORED_LABELS.includes(have.toLowerCase())) {
    return { action: 'upgrade-cm', to: SIGNED_UNPAID, reason: `lead signed on ${s(lead.retainerSigned)} but the case still reads "${have || '(blank)'}"` };
  }
  return { action: 'none', reason: 'in sync' };
}

/* ───────────────────────────── I/O ───────────────────────────── */

// Monday's items(ids:) lookup is ACCOUNT-GLOBAL, not board-scoped: a stale or
// mistyped clientMasterItemId happily resolves to an item on some other board,
// whose column ids simply don't exist there. Read blindly, that comes back as a
// blank Payment Status and looks exactly like a case needing repair — so every
// read here is pinned to the Client Master board and anything else is "gone".
const COLS_Q = `["${CM.paymentStatus}","${CM.caseRef}","${CM.paymentConfDate}"]`;

function parseCaseItem(item) {
  if (!item || (item.state && item.state !== 'active')) return null;
  if (String((item.board && item.board.id) || '') !== String(clientMasterBoardId)) return null;
  const cv = {};
  for (const c of item.column_values || []) cv[c.id] = s(c.text);
  return { paymentStatus: cv[CM.paymentStatus] || '', caseRef: cv[CM.caseRef] || '', paymentDate: cv[CM.paymentConfDate] || '' };
}

/** Current Payment Status for a Client Master item, or null if it is gone. */
async function readCasePaymentStatus(cmItemId) {
  const d = await mondayApi.query(
    `query($ids:[ID!]){ items(ids:$ids){ id state board{id} column_values(ids:${COLS_Q}){ id text } } }`,
    { ids: [String(cmItemId)] }
  );
  return parseCaseItem(d && d.items && d.items[0]);
}

/**
 * Write the derived Payment Status onto the case. Same-label writes are
 * harmless (Monday accepts them), so this is safe to call speculatively — which
 * is exactly what the retry paths in paymentService/handoffService do.
 */
async function writeCasePaymentStatus(cmItemId, label, { paymentDate = '' } = {}) {
  const cols = { [CM.paymentStatus]: { label } };
  if (label === PAID && paymentDate) cols[CM.paymentConfDate] = { date: paymentDate };
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols, create_labels_if_missing: true) { id }
     }`,
    { boardId: String(clientMasterBoardId), itemId: String(cmItemId), cols: JSON.stringify(cols) }
  );
}

async function postLeadNote(leadId, body) {
  try {
    await mondayApi.query(
      `mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
      { i: String(leadId), b: body });
  } catch (_) { /* notes are best-effort */ }
}

/**
 * Read many cases in one round-trip. Ids that no longer resolve (deleted rows)
 * are simply absent from the returned map, which classifyDrift reads as
 * "dangling". Batched so the sweep stays a handful of API calls no matter how
 * many retained clients the firm accumulates.
 * @returns {Map<string, {paymentStatus, caseRef, paymentDate}>}
 */
async function readCasesBulk(cmItemIds, { chunk = 50 } = {}) {
  const out = new Map();
  const ids = [...new Set(cmItemIds.map(s).filter(Boolean))];
  for (let i = 0; i < ids.length; i += chunk) {
    const batch = ids.slice(i, i + chunk);
    const d = await mondayApi.query(
      `query($ids:[ID!]){ items(ids:$ids){ id state board{id} column_values(ids:${COLS_Q}){ id text } } }`,
      { ids: batch }
    );
    for (const item of (d && d.items) || []) {
      const parsed = parseCaseItem(item);   // deleted, archived, or off-board ⇒ absent ⇒ "dangling"
      if (parsed) out.set(String(item.id), parsed);
    }
  }
  return out;
}

/**
 * Apply one already-classified verdict. Split out so the single-case path and
 * the batched sweep repair drift through exactly the same code.
 */
async function applyVerdict(lead, verdict, cm, { dryRun = false } = {}) {
  const base = { ...verdict, changed: false, leadId: String(lead.id), caseRef: cm ? cm.caseRef : '' };
  if (dryRun || verdict.action === 'none' || verdict.action === 'dangling' || verdict.action === 'no-case') return base;

  if (verdict.action === 'upgrade-cm') {
    await writeCasePaymentStatus(lead.clientMasterItemId, verdict.to, { paymentDate: s(lead.retainerPaid) });
    console.log(`[StatusSync] Case ${base.caseRef || lead.clientMasterItemId} Payment Status → "${verdict.to}" (${verdict.reason})`);
    // Reaching "Paid" is the onboarding trigger. The board webhook normally
    // carries it from here; if this repair ran because that webhook was missed
    // in the first place, retainerService.onRetainerPaid is the same entry point
    // it would have used, and it is idempotent.
    if (verdict.to === PAID) {
      try { await require('./retainerService').onRetainerPaid({ itemId: lead.clientMasterItemId }); }
      catch (err) { console.warn(`[StatusSync] onRetainerPaid after repair failed for ${lead.clientMasterItemId}: ${err.message}`); }
    }
    return { ...base, changed: true };
  }

  if (verdict.action === 'backstamp-lead') {
    const when = (cm && cm.paymentDate) || todayISO();
    await leadService.updateLead(lead.id, { retainerPaid: when });
    await postLeadNote(lead.id,
      `💵 <b>Retainer payment recorded from the case board.</b> Case ${base.caseRef || lead.clientMasterItemId} ` +
      `is marked <b>Paid</b>, so the retainer payment date has been set to ${when} here to keep the lead, the ` +
      `consultant portal and the reporting in step with it.`);
    console.log(`[StatusSync] Lead ${lead.id} retainerPaid ← ${when} (case ${base.caseRef} already Paid)`);
    // Signed + paid ⇒ Retained. Both-gated and idempotent inside.
    try { await require('./paymentService').maybeMarkRetained(lead.id); }
    catch (err) { console.warn(`[StatusSync] maybeMarkRetained after backstamp failed for lead ${lead.id}: ${err.message}`); }
    return { ...base, changed: true };
  }

  return base;
}

/**
 * Reconcile ONE case. Safe to call from anywhere, any number of times — it reads
 * the case first and only writes when the two sides actually disagree.
 * @param {string|object} leadOrId
 * @param {object} opts
 * @param {boolean} opts.dryRun  classify only, write nothing
 * @returns {{action:string, changed:boolean, reason:string, leadId:string, caseRef?:string}}
 */
async function reconcileLead(leadOrId, { dryRun = false } = {}) {
  const lead = (leadOrId && typeof leadOrId === 'object') ? leadOrId : await leadService.getLead(leadOrId);
  if (!lead) return { action: 'none', changed: false, reason: 'lead not found', leadId: String(leadOrId) };

  let cm = null;
  if (s(lead.clientMasterItemId)) {
    try {
      cm = await readCasePaymentStatus(lead.clientMasterItemId);
    } catch (err) {
      // Fail closed: an unreadable case tells us nothing, so change nothing.
      return { action: 'none', changed: false, reason: `case read failed: ${err.message}`, leadId: String(lead.id) };
    }
  }
  return applyVerdict(lead, classifyDrift(lead, cm ? cm.paymentStatus : null), cm, { dryRun });
}

/**
 * Reconcile from the CASE side — the entry point for the Client Master webhook,
 * where all we have is the item id. Resolves the lead that owns the case and
 * hands off to reconcileLead.
 *
 * Refuses to act when more than one lead claims the same case row: back-stamping
 * a payment onto the wrong applicant is worse than leaving the drift visible, so
 * that case is logged for a human instead.
 */
async function reconcileCase(cmItemId) {
  const id = s(cmItemId);
  if (!id) return { action: 'none', changed: false, reason: 'no case id' };
  let leads = [];
  try {
    leads = await leadService.findAllByColumnValue('clientMasterItemId', id);
  } catch (err) {
    console.warn(`[StatusSync] Could not resolve the lead for case ${id}: ${err.message}`);
    return { action: 'none', changed: false, reason: `lead lookup failed: ${err.message}` };
  }
  if (!leads.length) return { action: 'none', changed: false, reason: 'no lead owns this case (legacy or staff-created row)' };
  if (leads.length > 1) {
    console.warn(`[StatusSync] Case ${id} is claimed by ${leads.length} leads (${leads.map((l) => l.id).join(', ')}) — ` +
      'refusing to back-stamp a payment onto an ambiguous applicant');
    return { action: 'ambiguous', changed: false, reason: `${leads.length} leads point at this case` };
  }
  return reconcileLead(leads[0]);
}

/**
 * Cases the automation has quietly stopped working on: staff have moved them
 * into document collection, but Payment Status never became "Paid", so
 * chasingLoopService classifies them "unpaid" and sends no document reminders
 * (chasingLoopService.js — payment, not stage, is the licence to chase).
 *
 * These are almost always staff-created rows with no lead behind them, so the
 * repair paths above can't see them and MUST NOT guess: marking a case paid
 * without evidence would be inventing a financial record. Reporting is the
 * whole job — a human decides whether it is "Paid" or genuinely "Not Paid".
 */
const CHASING_STAGE = 'Document Collection Started';

async function findStalledCases() {
  const out = [];
  let cursor = null;
  do {
    const d = await mondayApi.query(
      `query($b:ID!,$c:String){ boards(ids:[$b]){ items_page(limit:100, cursor:$c){ cursor items{ id name
         column_values(ids:["${CM.paymentStatus}","${CM.caseStage}","${CM.caseRef}"]){ id text } } } } }`,
      { b: String(clientMasterBoardId), c: cursor }
    );
    const p = d && d.boards && d.boards[0] && d.boards[0].items_page;
    if (!p) break;
    for (const it of p.items || []) {
      const cv = {};
      for (const c of it.column_values || []) cv[c.id] = s(c.text);
      if (cv[CM.caseStage] === CHASING_STAGE && cv[CM.paymentStatus].toLowerCase() !== 'paid') {
        out.push({ cmId: String(it.id), name: it.name || '', caseRef: cv[CM.caseRef] || '', paymentStatus: cv[CM.paymentStatus] || '(blank)' });
      }
    }
    cursor = p.cursor;
  } while (cursor);
  return out;
}

/**
 * Sweep every lead that has any retainer activity and repair what disagrees.
 * Cron entry point; also the engine behind the admin status-audit endpoint.
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun  report only (used by the audit endpoint)
 * @returns {{checked:number, repaired:Array, attention:Array}}
 */
async function sweepRetainerStatus({ dryRun = false } = {}) {
  let leads = [];
  try {
    leads = await leadService.listAllLeads();
  } catch (err) {
    console.error(`[StatusSync] Could not list leads: ${err.message}`);
    return { checked: 0, repaired: [], attention: [], error: err.message };
  }

  // Only cases with retainer activity can drift. Everything else has nothing to
  // compare and would just burn API calls.
  const candidates = leads.filter((l) => s(l.retainerSigned) || s(l.retainerPaid) || s(l.clientMasterItemId));

  // One bulk read for every case, rather than one call per lead — this runs four
  // times an hour forever, so its cost must not grow with the client base.
  let cases;
  try {
    cases = await readCasesBulk(candidates.map((l) => l.clientMasterItemId));
  } catch (err) {
    console.error(`[StatusSync] Could not read the case rows: ${err.message}`);
    return { checked: 0, repaired: [], attention: [], error: err.message };
  }

  const repaired = [], attention = [];
  for (const lead of candidates) {
    const cm = cases.get(s(lead.clientMasterItemId)) || null;
    let r;
    try {
      r = await applyVerdict(lead, classifyDrift(lead, cm ? cm.paymentStatus : null), cm, { dryRun });
    } catch (err) {
      attention.push({ leadId: String(lead.id), name: lead.fullName || '', action: 'error', reason: err.message });
      continue;
    }
    if (r.changed) repaired.push({ leadId: r.leadId, name: lead.fullName || '', caseRef: r.caseRef, action: r.action, to: r.to, reason: r.reason });
    else if (r.action !== 'none') attention.push({ leadId: r.leadId, name: lead.fullName || '', caseRef: r.caseRef, action: r.action, to: r.to, reason: r.reason });
  }

  if (repaired.length) console.log(`[StatusSync] Repaired ${repaired.length} case(s) whose payment status had drifted`);
  if (attention.length) console.warn(`[StatusSync] ${attention.length} case(s) need a human: ` +
    attention.map((a) => `${a.name || a.leadId} (${a.action})`).join(', '));

  // Board-side check: report-only, never repaired (see findStalledCases).
  let stalled = [];
  try {
    stalled = await findStalledCases();
    if (stalled.length) console.warn(`[StatusSync] ${stalled.length} case(s) sit in "${CHASING_STAGE}" without Payment Status "Paid" — ` +
      'document reminders are switched off for them until someone sets the payment status');
  } catch (err) {
    console.warn(`[StatusSync] Stalled-case scan failed: ${err.message}`);
  }

  return { checked: candidates.length, repaired, attention, stalled };
}

module.exports = {
  deriveCmPaymentStatus, classifyDrift,          // pure
  reconcileLead, reconcileCase, sweepRetainerStatus, // I/O
  readCasePaymentStatus, readCasesBulk, writeCasePaymentStatus, applyVerdict, findStalledCases,
  PAID, SIGNED_UNPAID, UNAUTHORED_LABELS,
};
