'use strict';

/**
 * Undo mark paid — the admin correction for a milestone payment recorded in error.
 *
 * Incident 2026-09-22 (case 2026-OINP-059): Milestone 1 was marked paid on the
 * wrong client. That one click stamped the lead's Retainer Paid date; the
 * signing later flipped the lead to "Retained" on the strength of it; and the
 * RCIC countersignature was armed to start onboarding — intake email, checklist,
 * chasing — for a client who had not paid. There was no way to take it back.
 *
 * Shape (the retainerStatusReconciler / careful-delete pattern):
 *   - planMilestonePaidReversal — PURE. Every judgement lives here.
 *   - previewMilestonePaidReversal — fresh reads + the plan, never a write.
 *   - executeMilestonePaidReversal — under the lead lock (the one the e-sign
 *     capture holds when the countersignature completes): re-read, re-plan,
 *     check the preview still matches, write the reversal as ONE lead mutation,
 *     hold the lock until it reads back, then post the record and notify.
 *   - flagPaymentError — for staff who cannot undo: records the concern and
 *     alerts the admins and the RCIC. Changes no payment state.
 *
 * It refuses whenever reversing would be unsafe:
 *   - the payment came through Square (Square would simply record it again);
 *   - onboarding has started (the case reads Paid — emails can't be recalled);
 *   - the case cannot be read (fail closed).
 * It never emails the client, never writes the case, never deletes a Monday
 * update, and never touches "Retained by" (an RBAC assignment a human may own).
 */

const crypto      = require('crypto');
const leadService = require('./leadService');
const mondayApi   = require('./mondayApi');
const ms          = require('./milestonePaymentService');
const { clientMasterBoardId, leadBoardId } = require('../../config/monday');

const CM = {
  paymentStatus:    'color_mm0x9fnn',
  paymentConfDate:  'date_mm0xgk76',
  caseRef:          'text_mm142s49',
  caseStage:        'color_mm0x8faa',
  checklistApplied: 'color_mm0xs7kp',
};
const RETAINED_LABELS = ['retained', 'retained — paid'];
const AWAITING_PAYMENT = 'Retained — Awaiting Payment';
const PRE_ONBOARDING_STAGES = ['', 'pre-onboarding', 'not started'];
const MAX_INDEX = 20;
const REASON_MIN = 10;
const REASON_MAX = 1000;
const LOCK_WAIT_MS = 20000;          // an undo queued behind a hung e-sign capture gives up, changing nothing
const VERIFY_READS = 4;
const VERIFY_GAP_MS = 700;
const FLAG_COOLDOWN_MS = 10 * 60 * 1000;   // one flag per payment row per 10 minutes — the first one already alerted everyone

const s = (v) => String(v == null ? '' : v).trim();
const oneLine = (v) => s(v).replace(/\s+/g, ' ');
/** "(name as typed)" when the name was not a Monday sign-in; nothing for the shared-key placeholder. */
function typedMark(stamp) {
  if (!stamp || stamp.verified || /^Unidentified/.test(s(stamp.by))) return '';
  return ' (name as typed)';
}
const lower = (v) => s(v).toLowerCase();
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function dollars(cents) { return (Math.round(Number(cents) || 0) / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' }); }

/**
 * A short, stable identity for one stored payment entry. The preview echoes it
 * back at execute, so a stale tab or a replayed request can never remove a
 * DIFFERENT record — e.g. the same payment marked again after an earlier undo
 * (that entry carries a new "marked" time and the earlier undo's marker).
 */
function entryFingerprint(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const key = [entry.status, entry.paidAt, entry.reference, entry.method, entry.txnId,
    entry.marked && entry.marked.at, entry.undone && entry.undone.at].map((x) => s(x)).join('|');
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/**
 * What the milestone entry goes back to. Mark-paid kept no copy of the entry it
 * replaced, so the prior state is inferred from what the e-transfer request
 * writes. Restoring "requested" where a request really went out matters: a
 * signed lead whose first milestone reads "pending" is sent the request
 * automatically on the next fee edit or re-sign — a duplicate email.
 */
function restoredEntry(leadId, index, before) {
  const keep = {};
  for (const k of ['amountCents', 'orderId', 'url']) if (before && before[k] != null && before[k] !== '') keep[k] = before[k];
  if (before && s(before.requestedAt)) {
    return { status: 'requested', reference: ms.paymentReference(leadId, index), method: 'e-transfer', requestedAt: before.requestedAt, ...keep, ...(s(before.sentAt) ? { sentAt: before.sentAt } : {}) };
  }
  if (before && s(before.sentAt)) return { status: 'sent', sentAt: before.sentAt, ...keep };   // legacy Square-era request
  return { status: 'pending' };
}

/** The Conversion Status the lead should carry once its payment is removed. */
function conversionFor(lead, index) {
  if (Number(index) !== 0) return null;
  if (!s(lead.retainerSigned)) return null;                    // unsigned: the flip never happened
  const cs = s(lead.conversionStatus);
  if (!RETAINED_LABELS.includes(cs.toLowerCase())) return null; // a human's label — leave it
  // Derived, not "restored": this is the label the system writes for a signed,
  // unpaid lead, and it keeps the once-only signed-state gate closed.
  return { from: cs, to: AWAITING_PAYMENT };
}

/** Signs that a case was onboarded before, even though it no longer reads Paid. */
function onboardingSignals(cm) {
  if (!cm) return [];
  const out = [];
  if (s(cm.checklistApplied)) out.push(`Checklist applied: ${cm.checklistApplied}`);
  if (s(cm.paymentConfDate)) out.push(`Payment confirmed on ${cm.paymentConfDate}`);
  if (!PRE_ONBOARDING_STAGES.includes(lower(cm.caseStage))) out.push(`Stage: ${cm.caseStage}`);
  return out;
}

function confirmTextFor(lead, cm, shared) {
  // Two client records share this case: the case ref would not tell them apart,
  // so the confirmation names the exact record being changed.
  if (shared) return `LEAD-${s(lead.id)}`;
  if (cm && s(cm.caseRef)) return s(cm.caseRef);
  if (s(lead.clientMasterItemId)) return `CASE-${s(lead.clientMasterItemId)}`;
  return `LEAD-${s(lead.id)}`;
}

/**
 * PURE. Decide whether milestone `index` of `lead` can be un-marked, and exactly
 * what to write.
 *
 * @param {object}  p.lead         fresh getLead() result
 * @param {number}  p.index        milestone index (0 = the retainer payment)
 * @param {?object} p.cm           the case, board-pinned (readCase), or null
 * @param {?string} p.cmReadError  the case read threw — fail closed for index 0
 * @param {boolean} p.cmMissing    the lead points at a case that no longer exists
 * @param {?object} p.actor        { name, email } — who is undoing
 * @param {?string} p.now          ISO timestamp for the audit marker
 * @returns {{ok:false, refusal:{code,message,detail?}} | {ok:true, ...plan}}
 */
function planMilestonePaidReversal({ lead, index, cm = null, cmReadError = null, cmMissing = false, claimants, actor = null, now = null } = {}) {
  const refuse = (code, message, detail) => ({ ok: false, refusal: { code, message, ...(detail ? { detail } : {}) } });
  if (!lead || !s(lead.id)) return refuse('NO_LEAD', 'That client record could not be found.');
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i > MAX_INDEX) return refuse('BAD_INDEX', 'That milestone does not exist.');

  const { pay, unreadable } = ms.readPayments(lead);
  if (unreadable) {
    return refuse('PAYMENTS_UNREADABLE', 'The payment records on this client can’t be read, so nothing can be changed safely. Ask Faran to check the lead’s “Milestone Payments (JSON)” column.');
  }
  const before = (pay[i] && typeof pay[i] === 'object') ? pay[i] : null;
  const retainerPaid = s(lead.retainerPaid);
  const isRetainer = i === 0;

  let mode;
  if (before && before.status === 'paid') mode = 'milestone';
  // The first milestone reads unpaid, yet the lead still carries a payment date —
  // the case board was set to Paid by hand (the sync then stamps the lead), or an
  // earlier undo was only half applied. Same correction, minus the entry.
  else if (isRetainer && retainerPaid) mode = 'retainer-date';
  else return refuse('NOT_PAID', 'This milestone isn’t recorded as paid, so there is nothing to undo. Reload the page — someone may already have undone it.');

  if ((before && s(before.txnId)) || (isRetainer && (s(lead.squareRetainerTxnId) || s(lead.squareRetainerOrderId)))) {
    return refuse('SQUARE_PAYMENT', 'This payment is linked to Square. Removing it here would not stick — the Square sync records it again within minutes. Refund or void it in Square first, then ask Faran to reconcile the record.');
  }
  if (isRetainer && s(lead.clientMasterItemId) && cmReadError) {
    return refuse('CASE_UNREADABLE', 'Couldn’t read the case from Monday, so it isn’t safe to confirm onboarding hasn’t started. Nothing was changed — try again in a minute.', { error: String(cmReadError).slice(0, 200) });
  }
  if (isRetainer && cm && lower(cm.paymentStatus) === 'paid') {
    const signals = onboardingSignals(cm);
    return refuse('ONBOARDING_STARTED',
      'Onboarding has already started for this case (Payment Status reads Paid), so emails may have gone to the client. ' +
      'If the payment really was wrong: set the case’s Payment Status to “Not Paid” on Monday (only “Not Paid” or “Working on it” hold — any other label is changed back to Paid), then Undo here. Tell the client — sent emails can’t be recalled.',
      { signals });
  }

  const at = s(now) || new Date().toISOString();
  const by = oneLine((actor && (actor.name || actor.email)) || '').slice(0, 60) || 'Unknown';
  const undone = { by, at: at.slice(0, 16) + 'Z', was: entryFingerprint(before) };
  if (before && before.marked && s(before.marked.by)) { undone.prevBy = oneLine(before.marked.by).slice(0, 60); undone.prevAt = s(before.marked.at); }

  // milestone mode: the row goes back to its prior state, with the marker.
  // retainer-date mode: the row keeps its status — it only gains the marker, so
  // the "i" still shows who removed the payment date and when.
  const after = mode === 'milestone' ? { ...restoredEntry(lead.id, i, before), undone }
    : (before ? { ...before, undone } : { status: 'pending', undone });
  const clearKeys = (isRetainer && retainerPaid) ? ['retainerPaid'] : [];
  const conversionStatus = conversionFor(lead, i);

  const postPay = { ...pay };
  postPay[i] = after;
  const paymentsText = JSON.stringify(postPay);
  if (paymentsText && paymentsText.length > ms.MAX_PAYMENTS_JSON) {
    return refuse('PAYMENTS_TOO_LARGE', 'The payment records on this client are too long to update safely. Ask Faran to check the lead.');
  }
  const postLead = {
    ...lead,
    milestonePayments: paymentsText,
    ...(clearKeys.length ? { retainerPaid: '' } : {}),
    ...(conversionStatus ? { conversionStatus: conversionStatus.to } : {}),
  };

  const caseGate = require('./caseGateService');
  const recon = require('./retainerStatusReconciler');
  const gateBefore = caseGate.signatureGateForLead(lead);

  // INVARIANT (index 0): after the reversal nothing may be able to start
  // onboarding, and the 15-minute sync must have nothing to put back.
  if (isRetainer) {
    const gateAfter = caseGate.signatureGateForLead(postLead);
    const derived = recon.deriveCmPaymentStatus(postLead);
    const drift = recon.classifyDrift(postLead, cm ? cm.paymentStatus : null);
    const unsafe = gateAfter.complete || derived === recon.PAID || drift.action === 'backstamp-lead' ||
      drift.action === 'conflict' || (drift.action === 'upgrade-cm' && drift.to === recon.PAID);
    if (unsafe) return refuse('INVARIANT', 'This undo would leave the record in a state the payment sync would change back, so nothing was done. Ask Faran to look at this client.', { drift: drift.action, gate: gateAfter.missing });
  }

  const warnings = [];
  const info = [];
  if (isRetainer && cm && onboardingSignals(cm).length) {
    warnings.push({ code: 'ONBOARDING_RAN_EARLIER', message: `This case looks like it was onboarded before (${onboardingSignals(cm).join('; ')}). Undo corrects the payment record only — it doesn’t unsend emails, remove checklist items or move the case back.` });
  }
  if (s(lead.clientMasterItemId) && cmMissing) {
    warnings.push({ code: 'CASE_MISSING', message: 'The case this client points at no longer exists on the Cases board. Undo will correct the client’s record only.' });
  }
  const shared = Array.isArray(claimants) && claimants.length > 1;
  if (shared) {
    warnings.push({ code: 'SHARED_CASE', message: `This case is linked to ${claimants.length} client records (${claimants.map((c) => `${oneLine(c.name) || 'unnamed'} #${c.id}`).join(', ')}). You are changing ${oneLine(lead.fullName) || 'this client'} #${s(lead.id)} only — check it is the right one.` });
  } else if (claimants === null && s(lead.clientMasterItemId)) {
    info.push({ code: 'CLAIMANTS_UNKNOWN', message: 'Couldn’t check whether another client record shares this case — make sure this is the right client.' });
  }
  if (cm && cm.archived) {
    warnings.push({ code: 'CASE_ARCHIVED', message: 'This client’s case is archived.' });
  }
  const otherPaid = Object.keys(pay).filter((k) => /^\d+$/.test(k) && Number(k) !== i && pay[k] && pay[k].status === 'paid');
  if (otherPaid.length) {
    warnings.push({ code: 'OTHER_PAID', message: `${otherPaid.map((k) => `Milestone ${Number(k) + 1}`).join(', ')} ${otherPaid.length > 1 ? 'are' : 'is'} also recorded as paid. Undo ${otherPaid.length > 1 ? 'them' : 'it'} separately if ${otherPaid.length > 1 ? 'they were' : 'it was'} also wrong.` });
  }
  if (isRetainer && gateBefore.complete && !(cm && lower(cm.paymentStatus) === 'paid')) {
    warnings.push({ code: 'ACTIVATION_IMMINENT', message: 'Every signature and the payment are in, but the case isn’t marked Paid yet — the 15-minute sync would start onboarding. Undoing stops that.' });
  } else if (isRetainer && gateBefore.missing.length === 1 && gateBefore.missing[0] === 'RCIC countersignature') {
    info.push({ code: 'COUNTERSIGN_ARMED', message: 'The RCIC countersignature is still pending. While this payment stands, countersigning would start onboarding for this client. Undoing removes that trigger.' });
  }
  if (mode === 'retainer-date') {
    info.push({ code: 'RETAINER_DATE_ONLY', message: `The milestone row isn’t marked paid, but the client still has a Retainer Paid date (${retainerPaid}) — usually because the case board was set to Paid by hand. Undo clears that date${conversionStatus ? ' and the “Retained” status' : ''}.` });
  }
  if (mode === 'milestone' && after.status === 'pending' && (!isRetainer || s(lead.retainerSigned))) {
    info.push({ code: 'NEVER_REQUESTED', message: 'The client has never been sent the e-Transfer request for this milestone. Use “Send e-Transfer request” when you’re ready — the client’s portal may say the details are on their way.' });
  }

  const rows = ms.scheduleRows(lead);
  const row = rows[i] || {};
  const label = s(require('./retainerPlanService').displayMilestoneLabel(row.label)) || `Milestone ${i + 1}`;

  const willChange = [];
  if (mode === 'milestone') willChange.push(`Milestone goes back to “${after.status === 'requested' ? 'requested' : after.status === 'sent' ? 'requested (old Square link)' : 'not requested'}”`);
  if (clearKeys.length) willChange.push(`Retainer Paid date (${retainerPaid}) is cleared`);
  if (conversionStatus) willChange.push(`Conversion Status changes from “${conversionStatus.from}” to “${conversionStatus.to}”`);
  const willNotChange = ['No money moves, and nothing is sent to the client', 'Signatures (client and RCIC) and “Retained by”', 'Emails already sent, and Monday history'];
  if (isRetainer && cm) willNotChange.push('The case’s Payment Status — the 15-minute sync may change “Already Sent” to “Signed (Unpaid)”');

  return {
    ok: true,
    leadId: s(lead.id), index: i, mode, isRetainer, label, totalCents: row.totalCents || 0,
    before, after, clearKeys, conversionStatus, paymentsText,
    cm, warnings, info, willChange, willNotChange,
    expect: { mode, entry: entryFingerprint(before), retainerPaid },
    confirmText: confirmTextFor(lead, cm, shared),
  };
}

/** Bounds and shapes for an execute request. Returns an error message, or null. */
function validateUndoRequest({ leadId, index, confirmText, reason, expect, actor } = {}) {
  if (!/^\d{3,20}$/.test(s(leadId))) return 'Unknown client.';
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i > MAX_INDEX) return 'That milestone does not exist.';
  const r = s(reason);
  if (r.length < REASON_MIN) return `Give a reason of at least ${REASON_MIN} characters — it goes on the record.`;
  if (r.length > REASON_MAX) return `Keep the reason under ${REASON_MAX} characters.`;
  if (typeof confirmText !== 'string' || confirmText.length > 60) return 'Type the confirmation shown in the dialog.';
  if (!expect || typeof expect !== 'object' || !['milestone', 'retainer-date'].includes(expect.mode) ||
      typeof expect.entry !== 'string' || expect.entry.length > 20 ||
      typeof expect.retainerPaid !== 'string' || expect.retainerPaid.length > 20) return 'This dialog is out of date — close it and open it again.';
  if (!actor || !s(actor.email)) return 'Sign in with Monday to undo a payment.';
  return null;
}

/* ─────────────────────────────── I/O ─────────────────────────────── */

/** The case, pinned to the Cases board. Archived rows are returned (flagged) so
 *  a Paid case can't slip past the refusal by being archived; deleted or
 *  off-board ids are null. */
async function readCase(cmItemId) {
  const cols = JSON.stringify(Object.values(CM));
  const d = await mondayApi.query(
    `query($ids:[ID!]){ items(ids:$ids){ id state board{id} column_values(ids:${cols}){ id text } } }`,
    { ids: [String(cmItemId)] });
  const item = d && d.items && d.items[0];
  if (!item || item.state === 'deleted') return null;
  if (String((item.board && item.board.id) || '') !== String(clientMasterBoardId)) return null;
  const cv = {};
  for (const c of item.column_values || []) cv[c.id] = s(c.text);
  return {
    itemId: String(item.id), archived: !!(item.state && item.state !== 'active'),
    paymentStatus: cv[CM.paymentStatus] || '', paymentConfDate: cv[CM.paymentConfDate] || '',
    caseRef: cv[CM.caseRef] || '', caseStage: cv[CM.caseStage] || '', checklistApplied: cv[CM.checklistApplied] || '',
  };
}

function codeError(code, message) { const e = new Error(message); e.code = code; return e; }

/**
 * The reversal, as ONE lead mutation, inside the payment-write queue so no
 * other payment write can interleave. Compare-and-swap against FRESH state —
 * the queue may have waited — and the Conversion Status is decided from that
 * fresh read too (a signing could have landed since the plan).
 */
async function commitReversal(plan) {
  return ms.withPaymentWriteQueue(plan.leadId, async () => {
    const fresh = await leadService.getLead(plan.leadId);
    if (!fresh) throw codeError('NO_LEAD', 'That client record could not be found.');
    const { pay, unreadable } = ms.readPayments(fresh);
    if (unreadable) throw codeError('PAYMENTS_UNREADABLE', 'The payment records on this client can’t be read — nothing was changed.');
    if (entryFingerprint(pay[plan.index]) !== plan.expect.entry) {
      throw codeError('CHANGED_SINCE_PREVIEW', 'This payment changed while the undo was being prepared — nothing was changed. Close the dialog and open it again.');
    }
    if (s(fresh.retainerPaid) !== plan.expect.retainerPaid) {
      throw codeError('CHANGED_SINCE_PREVIEW', 'The client’s payment date changed while the undo was being prepared — nothing was changed. Close the dialog and open it again.');
    }
    const conversion = conversionFor(fresh, plan.index);
    const fields = {};
    pay[plan.index] = plan.after;                                   // the reversal (milestone) or just the marker (retainer-date)
    fields.milestonePayments = ms.serializePayments(plan.leadId, pay);
    if (plan.clearKeys.length) fields.retainerPaid = '';
    if (conversion) fields.conversionStatus = conversion.to;
    if (Object.keys(fields).length) await leadService.updateLead(plan.leadId, fields, { clearKeys: plan.clearKeys });
    return { conversion };
  });
}

async function postNote(itemId, body) {
  await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`,
    { i: String(itemId), b: body });
}

/** The side effects, behind one seam — the tests replace all of it. */
const io = {
  getLead:          (id) => leadService.getLead(id),
  readCase:         (id) => readCase(id),
  commit:           (plan) => commitReversal(plan),
  writeLeadFields:  (id, fields, opts) => leadService.updateLead(id, fields, opts),
  postNote:         (itemId, body) => postNote(itemId, body),
  notify:           (userId, text, itemId) => require('./mondayNotificationService').sendNotification(userId, text, itemId),
  resolveUserId:    (email) => require('./paymentService').resolveMondayUserIdByEmail(email),
  consultantFor:    (lead) => require('../../config/consultantRouting').resolveConsultant(lead),
  adminEmails:      () => String(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  invalidateQueues: () => {
    const c = require('./consultantPortalService');
    try { c.invalidateDirectRetainerQueue(); } catch (_) { /* cache only */ }
    try { c.invalidateLeadsQueue(); } catch (_) { /* cache only */ }
  },
  withLeadLock:     (key, fn) => require('./leadMutex').withLeadLock(key, fn),
  isLeadItem:       async (id) => {
    const d = await mondayApi.query(`query($ids:[ID!]){ items(ids:$ids){ id state board{id} } }`, { ids: [String(id)] });
    const it = d && d.items && d.items[0];
    return !!(it && it.state !== 'deleted' && String((it.board && it.board.id) || '') === String(leadBoardId));
  },
  findClaimants:    async (cmItemId) => (await leadService.findAllByColumnValue('clientMasterItemId', String(cmItemId)))
    .map((l) => ({ id: String(l.id), name: s(l.fullName) || s(l.name) })),
  caseAssignees:    async (cmItemId) => {
    const ca = require('./caseAccessService');
    const cols = JSON.stringify(ca.PEOPLE_COLUMNS || []);
    const d = await mondayApi.query(`query($ids:[ID!]){ items(ids:$ids){ column_values(ids:${cols}){ id value } } }`, { ids: [String(cmItemId)] });
    const byId = {};
    for (const c of ((d && d.items && d.items[0] && d.items[0].column_values) || [])) byId[c.id] = c.value;
    return ca.assigneesFromColumnValues(byId);
  },
  now:              () => Date.now(),
  nowIso:           () => new Date().toISOString(),
  sleep:            (msec) => new Promise((r) => setTimeout(r, msec)),
};

async function readState(leadId) {
  let lead;
  try { lead = await io.getLead(leadId); }
  catch (err) { return { error: 'Couldn’t read this client from Monday — nothing was changed. Try again in a minute.', status: 503, code: 'LEAD_UNREADABLE' }; }
  if (!lead) return { error: 'That client record could not be found.', status: 404, code: 'NO_LEAD' };
  // Any Monday item id reads back as a "lead" — make sure this one is on the Leads board.
  let isLead;
  try { isLead = await io.isLeadItem(leadId); }
  catch (err) { return { error: 'Couldn’t confirm this client record on Monday — nothing was changed. Try again in a minute.', status: 503, code: 'LEAD_UNREADABLE' }; }
  if (!isLead) return { error: 'That isn’t a client record.', status: 404, code: 'NOT_A_LEAD' };
  let cm = null, cmReadError = null, cmMissing = false, claimants = null;
  if (s(lead.clientMasterItemId)) {
    try { cm = await io.readCase(lead.clientMasterItemId); if (!cm) cmMissing = true; }
    catch (err) { cmReadError = err.message || 'read failed'; }
    try { claimants = await io.findClaimants(lead.clientMasterItemId); } catch (_) { claimants = null; }
  } else {
    claimants = [];
  }
  return { lead, cm, cmReadError, cmMissing, claimants };
}

/** The WHOLE post-state holds — not just "the row reads unpaid". A retry after a
 *  half-applied reversal must converge, never report success over it. */
function reversalHolds(lead, index, expect) {
  const e = ms.readPayments(lead).pay[index] || {};
  if (e.status === 'paid') return false;
  if (expect.mode === 'milestone' && !(e.undone && e.undone.was === expect.entry)) return false;
  if (Number(index) === 0) {
    if (s(lead.retainerPaid)) return false;
    if (conversionFor(lead, index)) return false;
  }
  return true;
}

/** Hold until the reversal reads back (a read straight after a write can lag, and
 *  whoever takes the lock next must see it); converge once if part is missing. */
async function verifyReversal(plan) {
  const missingIn = (lead) => {
    const out = [];
    const e = ms.readPayments(lead).pay[plan.index] || {};
    if (plan.mode === 'milestone' && e.status === 'paid') out.push('milestone');
    if (plan.clearKeys.length && s(lead.retainerPaid)) out.push('retainerPaid');
    // After a lost response, "landed" means OUR write is there — the marker we planned.
    if (plan._readOnly && !(e.undone && e.undone.at === plan.after.undone.at && e.undone.was === plan.expect.entry)) out.push('marker');
    return out;
  };
  let lead = null, missing = ['unread'];
  for (let n = 0; n < VERIFY_READS; n++) {
    if (n) await io.sleep(VERIFY_GAP_MS);
    try { lead = await io.getLead(plan.leadId); } catch (_) { continue; }
    missing = lead ? missingIn(lead) : ['unread'];
    if (!missing.length) return { ok: true, lead };
  }
  if (plan._readOnly) return { ok: false, missing, lead };
  // Converge once — the payment date FIRST: it is the field every activation
  // path keys on, so it is the dangerous one to leave behind.
  try {
    if (missing.includes('retainerPaid')) await io.writeLeadFields(plan.leadId, { retainerPaid: '' }, { clearKeys: ['retainerPaid'] });
    if (missing.includes('milestone') || missing.includes('unread')) await io.commit(plan).catch(() => {});
    await io.sleep(VERIFY_GAP_MS);
    lead = await io.getLead(plan.leadId);
    missing = lead ? missingIn(lead) : ['unread'];
  } catch (_) { /* reported below */ }
  return missing.length ? { ok: false, missing, lead } : { ok: true, lead };
}

/** Admins (other than the actor) and the RCIC on the case — best-effort.
 *  Returns how many were alerted, and whether the RCIC was one of them. */
async function notifyPeopleDetailed(lead, text, targetItemId, actorEmail) {
  const ids = new Set();
  const emails = new Set(io.adminEmails());
  let rcicId = '', rcicEmail = '';
  try {
    const c = io.consultantFor(lead);
    if (c && c.mondayUserId) { rcicId = String(c.mondayUserId); ids.add(rcicId); }
    else if (c && c.email) { rcicEmail = lower(c.email); emails.add(rcicEmail); }
  } catch (_) { /* best-effort */ }
  emails.delete(lower(actorEmail));
  for (const email of emails) {
    try {
      const id = await io.resolveUserId(email);
      if (id) { ids.add(String(id)); if (email === rcicEmail) rcicId = String(id); }
    } catch (_) { /* best-effort */ }
  }
  let sent = 0, rcic = false;
  for (const id of ids) {
    try { await io.notify(id, text, targetItemId); sent++; if (id === rcicId) rcic = true; } catch (_) { /* best-effort */ }
  }
  return { sent, rcic };
}
async function notifyPeople(lead, text, targetItemId, actorEmail) {
  return (await notifyPeopleDetailed(lead, text, targetItemId, actorEmail)).sent;
}

function publicPlan(plan) {
  if (!plan.ok) return plan;
  const { paymentsText, ...rest } = plan;   // eslint-disable-line no-unused-vars
  return rest;
}

/** Read-only: what an undo of milestone `index` would do right now. */
async function previewMilestonePaidReversal({ leadId, index, actor = null } = {}) {
  const st = await readState(leadId);
  if (st.error) return { ok: false, status: st.status, code: st.code, error: st.error };
  const plan = planMilestonePaidReversal({ ...st, index, actor, now: io.nowIso() });
  return {
    ok: true,
    client: { name: oneLine(st.lead.fullName) || 'Client', leadId: s(st.lead.id), caseRef: (st.cm && st.cm.caseRef) || '' },
    plan: publicPlan(plan),
  };
}

function removedLine(plan) {
  const b = plan.before || {};
  return b.status === 'paid'
    ? `recorded as paid on ${esc(b.paidAt || '?')} (${esc(b.method || 'e-transfer')}${b.reference ? `, ref ${esc(b.reference)}` : ''})${b.marked && b.marked.by ? ` by ${esc(oneLine(b.marked.by))}${typedMark(b.marked)}` : ''}`
    : `a Retainer Paid date of ${esc(plan.expect.retainerPaid)} with no paid milestone row`;
}

/**
 * Remove a payment recorded in error. Returns { ok, ... } or { ok:false, status, code, error }.
 * @param {object} p.actor  { name, email, verified:true } — a named admin (the route enforces it)
 */
const _inFlight = new Set();
async function executeMilestonePaidReversal({ leadId, index, confirmText, reason, expect, actor } = {}) {
  const bad = validateUndoRequest({ leadId, index, confirmText, reason, expect, actor });
  if (bad) return { ok: false, status: 400, code: 'BAD_REQUEST', error: bad };
  const key = s(leadId);
  const i = Number(index);
  if (_inFlight.has(key)) return { ok: false, status: 409, code: 'BUSY', error: 'An undo for this client is already running — wait a moment, then reload.' };
  _inFlight.add(key);
  const queuedAt = io.now();
  let outcome;
  try {
    outcome = await io.withLeadLock(key, async () => {
      if (io.now() - queuedAt > LOCK_WAIT_MS) {
        return { ok: false, status: 409, code: 'BUSY', error: 'This client’s record is busy (a signature is being processed). Nothing was changed — try again in a minute.' };
      }
      const st = await readState(key);
      if (st.error) return { ok: false, status: st.status, code: st.code, error: st.error };
      if (reversalHolds(st.lead, i, expect)) {
        return { ok: true, already: true, message: 'This payment has already been removed. Nothing more was needed.' };
      }
      const plan = planMilestonePaidReversal({ ...st, index: i, actor, now: io.nowIso() });
      if (!plan.ok) return { ok: false, status: 409, code: plan.refusal.code, error: plan.refusal.message, refusal: plan.refusal };

      // The preview must still describe what is there. One allowed transition:
      // our own earlier undo landed the row but not the date (a half-applied
      // reversal) — converging it is exactly what the retry is for.
      const sameEntry = plan.expect.entry === expect.entry && plan.expect.mode === expect.mode;
      const converging = expect.mode === 'milestone' && plan.mode === 'retainer-date' &&
        ((ms.readPayments(st.lead).pay[i] || {}).undone || {}).was === expect.entry;
      if ((!sameEntry && !converging) || plan.expect.retainerPaid !== expect.retainerPaid) {
        return { ok: false, status: 409, code: 'CHANGED_SINCE_PREVIEW', error: 'This payment changed since you opened the dialog. Close it and open it again.' };
      }
      if (s(confirmText) !== plan.confirmText) {
        return { ok: false, status: 400, code: 'CONFIRM_MISMATCH', error: `Type ${plan.confirmText} exactly to confirm.` };
      }

      let committed;
      try { committed = await io.commit(plan); }
      catch (err) {
        if (err.code === 'CHANGED_SINCE_PREVIEW') return { ok: false, status: 409, code: err.code, error: err.message };
        // A write whose response was lost may still have landed. Read back: if it
        // did, carry on as a success so the record and the alerts are not lost.
        const landed = err.code ? { ok: false } : await verifyReversal({ ...plan, _readOnly: true });
        if (!landed.ok) {
          return { ok: false, status: 503, code: err.code || 'COMMIT_FAILED',
            error: err.code ? err.message : 'Monday didn’t accept the change — nothing was changed. Try again in a minute.' };
        }
        committed = { conversion: conversionFor(st.lead, i), recovered: true };
      }
      const verified = await verifyReversal(plan);
      let raced = false;
      if (plan.isRetainer && s(st.lead.clientMasterItemId)) {
        try { const now = await io.readCase(st.lead.clientMasterItemId); raced = !!(now && lower(now.paymentStatus) === 'paid'); }
        catch (_) { /* nothing to add — the refusal already checked before the write */ }
      }
      return { ok: true, plan, committed, verified, raced, lead: st.lead, cm: st.cm, cmMissing: st.cmMissing };
    });
  } finally {
    _inFlight.delete(key);
  }
  if (!outcome.ok || outcome.already) return outcome;

  // ── After the lock: the record, the notes and the notifications ──
  const { plan, verified, raced, lead, cm } = outcome;
  const conversion = (outcome.committed && outcome.committed.conversion) || plan.conversionStatus;
  const who = esc(s(actor.name) || s(actor.email));
  const when = io.nowIso().slice(0, 10);
  const what = `${esc(plan.label)} (${dollars(plan.totalCents)})`;
  // The case note is the one the case team is subscribed to; skip it only when
  // the case row is known to be gone.
  const caseItem = (s(lead.clientMasterItemId) && !outcome.cmMissing) ? s(lead.clientMasterItemId) : '';
  const warnings = [...plan.warnings];

  const changed = [];
  if (plan.mode === 'milestone') changed.push(`milestone set back to “${plan.after.status === 'pending' ? 'not requested' : 'requested'}”`);
  if (plan.clearKeys.length) changed.push(`Retainer Paid date (${esc(plan.expect.retainerPaid)}) cleared`);
  if (conversion) changed.push(`Conversion Status changed from “${esc(conversion.from)}” to “${esc(conversion.to)}”`);

  const leadBody =
    `↩️ <b>Payment record removed</b> — ${what}, ${removedLine(plan)}.<br>` +
    `Removed by ${who} on ${when}. <b>Reason:</b> ${esc(s(reason))}<br>` +
    `<b>Changed:</b> ${changed.join(' · ') || 'nothing further'}.<br>` +
    `<b>Not changed:</b> signatures, “Retained by”, and anything already sent to the client. No money moved.` +
    (plan.isRetainer ? ' Onboarding starts only once the real payment is recorded and every signature is in.' : '') +
    '<br>If this payment belongs to another client, record it on that client’s file.' +
    (plan.mode === 'milestone' ? `<br><small>Removed record: ${esc(JSON.stringify(plan.before))}</small>` : '');
  const caseBody = plan.mode === 'milestone'
    ? `↩️ <b>Payment record removed</b> — ${what} had been recorded as paid in error. Removed by ${who} on ${when}. <b>Reason:</b> ${esc(s(reason))}. Details are on the client’s lead record.`
    : `↩️ <b>Retainer Paid date removed</b> (${esc(plan.expect.retainerPaid)}) — the client’s record said the retainer was paid, but no milestone payment was recorded. Removed by ${who} on ${when}. <b>Reason:</b> ${esc(s(reason))}.`;

  let notesFailed = false;
  try { await io.postNote(lead.id, leadBody); } catch (_) { notesFailed = true; }
  if (caseItem) { try { await io.postNote(caseItem, caseBody); } catch (_) { notesFailed = true; } }
  if (notesFailed) warnings.push({ code: 'NOTES_FAILED', message: 'The payment was removed, but posting the note on Monday failed — add a short note by hand.' });

  if (raced || !verified.ok) {
    const alarm = raced
      ? '⚠️ <b>Undo raced with onboarding.</b> The case was marked Paid while this undo ran, so onboarding has started. Within 15 minutes the payment sync will put the payment date back on the client. If the client has NOT paid, set the case’s Payment Status to <b>Not Paid</b> before then, then run Undo again.'
      : `⚠️ <b>Undo incomplete.</b> Monday didn’t confirm every change (still showing: ${esc(verified.missing.join(', '))}). An admin must check the client’s Retainer Paid date and payment row now — a payment date left behind can start onboarding.`;
    try { await io.postNote(lead.id, alarm); } catch (_) { /* best-effort */ }
    if (caseItem) { try { await io.postNote(caseItem, alarm); } catch (_) { /* best-effort */ } }
  }

  const notified = await notifyPeople(lead,
    `Payment record removed for ${s(lead.fullName) || 'a client'}${(cm && cm.caseRef) ? ` (${cm.caseRef})` : ''}: ${s(plan.label)}. By ${s(actor.name) || s(actor.email)} — ${s(reason).slice(0, 120)}`,
    caseItem || lead.id, actor.email).catch(() => 0);
  try { io.invalidateQueues(); } catch (_) { /* cache only */ }

  if (raced) return { ok: false, status: 409, code: 'ONBOARDING_STARTED_DURING_UNDO', error: 'The case was marked Paid while this undo ran, so onboarding started. Set the case’s Payment Status to “Not Paid” within 15 minutes, then run Undo again.' };
  if (!verified.ok) return { ok: false, status: 500, code: 'UNDO_INCOMPLETE', error: `Monday didn’t confirm every change (${verified.missing.join(', ')}). Check this client’s record now.` };

  const next = [];
  if (plan.info.some((x) => x.code === 'NEVER_REQUESTED')) next.push('The client has never been sent the e-Transfer request for this milestone — use “Send e-Transfer request” when you’re ready.');
  next.push('If this payment belongs to another client, record it on that client’s file.');
  return {
    ok: true,
    message: plan.mode === 'milestone'
      ? `Removed. ${plan.label} now reads “${plan.after.status === 'pending' ? 'not requested' : 'requested'}”.`
      : `Removed the Retainer Paid date (${plan.expect.retainerPaid}). The milestone row was not paid and is unchanged.`,
    undone: { index: plan.index, mode: plan.mode, before: plan.before, after: plan.after, clearedRetainerPaid: !!plan.clearKeys.length, conversionStatus: conversion || null },
    removed: plan.mode === 'milestone' && plan.before
      ? { reference: plan.before.reference || '', paidAt: plan.before.paidAt || '', amount: dollars(plan.totalCents) }
      : { retainerPaidDate: plan.expect.retainerPaid },
    warnings, notified, next,
  };
}

/**
 * For staff who can't undo: record that a payment looks wrong and alert the
 * admins and the RCIC. Changes NO payment state.
 */
const _flaggedAt = new Map();   // "leadId#index" → when it was last flagged (per process)
async function flagPaymentError({ leadId, index, actor, note, viewer = null } = {}) {
  const i = Number(index);
  if (!/^\d{3,20}$/.test(s(leadId))) return { ok: false, status: 400, error: 'Unknown client.' };
  if (!Number.isInteger(i) || i < 0 || i > MAX_INDEX) return { ok: false, status: 400, error: 'That milestone does not exist.' };
  const n = s(note);
  if (n.length < REASON_MIN) return { ok: false, status: 400, error: `Say briefly what’s wrong (at least ${REASON_MIN} characters).` };
  if (n.length > 600) return { ok: false, status: 400, error: 'Keep it under 600 characters.' };
  const name = oneLine(actor && (actor.name || actor.email)).slice(0, 60);
  if (!name) return { ok: false, status: 400, error: 'Enter your name so the admins know who flagged it.' };
  const flagKey = `${s(leadId)}#${i}`;
  const last = _flaggedAt.get(flagKey);
  if (last && io.now() - last < FLAG_COOLDOWN_MS) {
    return { ok: false, status: 429, error: 'This payment was flagged a few minutes ago and the admins were alerted then. Nothing new was sent.' };
  }

  const st = await readState(leadId);
  if (st.error) return { ok: false, status: st.status, error: st.error };
  const lead = st.lead;
  // Under CASE_VISIBILITY=assigned a staffer may flag only a case they can see.
  if (viewer && !viewer.isAdmin && viewer.scope === 'assigned') {
    let canSee = false;
    if (s(lead.clientMasterItemId) && !st.cmMissing) {
      try { canSee = require('./caseAccessService').viewerCanSee(await io.caseAssignees(lead.clientMasterItemId), viewer); }
      catch (_) { return { ok: false, status: 503, error: 'Couldn’t check your access to this case — try again in a minute.' }; }
    }
    if (!canSee) return { ok: false, status: 403, error: 'You can flag payments only on cases you’re assigned to. Tell an admin directly.' };
  }
  const entry = ms.readPayments(lead).pay[i] || {};
  const row = ms.scheduleRows(lead)[i] || {};
  const label = s(require('./retainerPlanService').displayMilestoneLabel(row.label)) || `Milestone ${i + 1}`;
  const gate = require('./caseGateService').signatureGateForLead(lead);
  // Ask the RCIC to hold only while a payment actually stands — the countersignature
  // is what would start onboarding on top of it.
  const holdCountersign = i === 0 && gate.missing.includes('RCIC countersignature') &&
    (entry.status === 'paid' || !!s(lead.retainerPaid));
  const recorded = entry.status === 'paid'
    ? `recorded as paid on ${esc(entry.paidAt || '?')}${entry.reference ? `, ref ${esc(entry.reference)}` : ''}${entry.marked && entry.marked.by ? ` by ${esc(oneLine(entry.marked.by))}${typedMark(entry.marked)}` : ''}`
    : (i === 0 && s(lead.retainerPaid) ? `not recorded as paid, but the client has a Retainer Paid date (${esc(lead.retainerPaid)})` : 'not recorded as paid');
  const body =
    `🚩 <b>Payment flagged as recorded in error</b> — ${esc(label)} (${dollars(row.totalCents)}), ${recorded}.<br>` +
    `Flagged by ${esc(name)}${actor && actor.verified ? '' : ' (name as typed)'}: ${esc(n)}<br>` +
    '<b>Admins:</b> please review, and use “Undo…” on the payment row if it is wrong.' +
    (holdCountersign ? '<br><b>RCIC:</b> please don’t countersign this retainer until an admin has confirmed — countersigning now would start onboarding.' : '');
  const caseItem = s(lead.clientMasterItemId) && !st.cmMissing ? s(lead.clientMasterItemId) : '';
  try { await io.postNote(caseItem || lead.id, body); }
  catch (_) { return { ok: false, status: 503, error: 'Couldn’t post the flag on Monday — try again in a minute.' }; }
  if (caseItem) { try { await io.postNote(lead.id, body); } catch (_) { /* the case note is the one people see */ } }
  _flaggedAt.set(flagKey, io.now());
  const alerted = await notifyPeopleDetailed(lead,
    `Payment flagged as wrong on ${oneLine(lead.fullName) || 'a client'}${st.cm && st.cm.caseRef ? ` (${st.cm.caseRef})` : ''}: ${label}. ${holdCountersign ? 'Please don’t countersign yet. ' : ''}Flagged by ${name}.`,
    caseItem || lead.id, actor && actor.email).catch(() => ({ sent: 0, rcic: false }));
  const message = alerted.sent
    ? `Flagged. The note is on the case, and ${alerted.sent} ${alerted.sent === 1 ? 'person was' : 'people were'} alerted on Monday (the admins${alerted.rcic ? ' and the RCIC' : ''}).`
    : 'Flagged — the note is on the case, but nobody could be alerted automatically. Tell an admin directly.';
  return { ok: true, message, notified: alerted.sent };
}

module.exports = {
  planMilestonePaidReversal, validateUndoRequest,
  previewMilestonePaidReversal, executeMilestonePaidReversal, flagPaymentError,
  // helpers exported for tests
  entryFingerprint, restoredEntry, conversionFor, onboardingSignals, reversalHolds, readCase, commitReversal,
  io, AWAITING_PAYMENT, LOCK_WAIT_MS, FLAG_COOLDOWN_MS,
  _resetFlagThrottle: () => _flaggedAt.clear(),
};
