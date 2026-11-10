/**
 * kpiService — automatic reporting/KPIs computed from the Lead Board.
 *
 * computeKpis() is PURE (leads array → metrics) so it's fully testable; getKpis()
 * reads the shared Lead Board snapshot (leadSnapshot — one cached copy for every list) and
 * computes for a given month. Windowing is by the event's own date: consultations
 * by bookedSlot, "held" by consultationHeld, retainer sent/signed/paid by their
 * dates, leads by createdAt. Consultation revenue = the fee (before HST) of each PAID
 * consult: the booking link's own payment (squareConsultTxnId; the per-booking fee or
 * the flat fee) plus the fees staff recorded as paid another way (consultPaymentService:
 * cash / e-transfer / invoice / other; waived counts separately, adds nothing);
 * retainer value = summed retainerFee of signed cases.
 *
 * Direct consultations (step 2, "＋ Direct consultation": booked outside the app, added
 * by hand) count in the consultation figures like any booking. In the FUNNEL (leads →
 * booked → consulted) only a "New" one counts: a "Follow-up" (the person's earlier
 * consultation already counted them) and an "Existing client" (about their current
 * file) are not new leads. An "Existing client" row is "existing" on the new / existing
 * card whatever its relationship label says. The kind is read from the row
 * (utils/directConsult.kindOf); a marked row whose kind cannot be read counts like any
 * lead, as before.
 *
 * COUNTING RULES (step 6, Faran 2026-11-09 — every month, past ones included):
 *   - Booked = a booked time in the month whose Booking Status is a real booking: "Booked",
 *     or a time recorded by hand with no hold status (leadStatusService.bookedByHand). A
 *     "Slot Held" hold still running and an "Abandoned" hold (it ran out unpaid) are NOT
 *     bookings: abandoned holds are their own number (consultations.abandonedHolds), holds
 *     still running are consultations.holdsInProgress. By consultant / by owner, the mode
 *     split, new/existing and the booking-link revenue use the same rule.
 *   - Consulted / held = a consultation in the month that has already happened (its booked
 *     time — or, with none, its held date — on or before NOW). A later one is "Upcoming".
 *     NOW is injected (opts.now) so the numbers are testable.
 *   - Retained = EVERY row with a Retainer Signed date in the month, walk-ins (direct
 *     retainers) included, split by where it came from: a booked consultation, a lead
 *     converted into a direct retainer, or a walk-in. retainedDirect (the old "+Direct")
 *     is kept only as converted + walk-in.
 *   - Paid: signersPaid = of the rows SIGNED in the month, how many have any paid date
 *     (rates.paidOfSigners); paid = rows with a paid date IN the month, whenever (or
 *     whether) they were signed.
 */

'use strict';

const { torontoWallClock } = require('../utils/torontoTime');
const consultPayment = require('./consultPaymentService');
const directConsult = require('../utils/directConsult');

function consultFeeDollars() {
  try { return (Number(require('./bookingService').CONSULT_FEE_CENTS) || 20000) / 100; }
  catch (_) { return 200; }
}

/**
 * 'YYYY-MM' — the TORONTO month — from an ISO instant (a lead's createdAt: an
 * evening lead is the next day in UTC), a 'YYYY-MM-DD' date or a
 * 'YYYY-MM-DD HH:MM' slot (both already Toronto); '' if unparseable.
 */
function monthKey(dateStr) {
  const m = torontoWallClock(dateStr).match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : '';
}
function feeToNum(v) { const n = parseFloat(String(v || '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; }

/** Temporary- vs permanent-resident from the case type, via the annex catalogue group. */
function trPrOf(caseType) {
  const t = String(caseType || '').trim(); if (!t) return null;
  try {
    const { pickAnnex } = require('./retainerPlanService');
    const { byCode } = require('../../config/annexCatalogue');
    const a = pickAnnex(t, '');
    const grp = a && a.code ? (byCode(a.code) || {}).group : null;
    return grp === 'permanent' ? 'PR' : grp === 'temporary' ? 'TR' : null;
  } catch (_) { return null; }
}
function isExistingClient(lead) {
  // NOTE: misses "Previous client with completed or inactive application" — fixed in step 6
  // (changing it now would move the months already reported). Direct rows are checked first.
  return /exist|return|prior|current/i.test(lead.relationshipWithTdot || '') || !!String(lead.existingFileType || '').trim();
}
/** 'YYYY-MM-DD HH:MM' in Toronto for an instant (ms or Date). */
function nowWall(now) { return torontoWallClock(new Date(now).toISOString()); }

/**
 * Is this booking a real one? (not a hold still running, not an abandoned hold)
 * A row that was paid (Square / staff-recorded) or whose consultation was held IS a booking,
 * whatever the status still says (a missed webhook leaves 'Slot Held'; a late payment after the
 * hold ran out leaves 'Abandoned') — the same signs leadStatusService reads. A 'Slot Held' whose
 * Slot Held Until has passed is a dead hold: abandoned, not running.
 */
function bookingKind(l, now = Date.now()) {
  const s = (v) => String(v || '').trim();
  const st = s(l.bookingStatus);
  if (st !== 'Abandoned' && st !== 'Slot Held') return 'booked';
  let paid = false;
  try { paid = !!consultPayment.paidState(l).paid; } catch (_) { /* unreadable: not paid */ }
  if (paid || s(l.squareConsultTxnId) || s(l.consultPayment) || s(l.consultationHeld)) return 'booked';
  if (st === 'Abandoned') return 'abandoned';
  const until = Date.parse(s(l.slotHeldUntil));
  if (Number.isFinite(until) && until <= now) return 'abandoned';
  return 'held';
}

function inc(o, k) { o[k] = (o[k] || 0) + 1; }
const SOURCE_BLANK = 'Not recorded';   // a lead with no Source / Reference

/** Distinct 'YYYY-MM' present across the KPI dates, newest first — drives the month picker. */
function distinctMonths(leads, now = Date.now()) {
  const cur = nowWall(now).slice(0, 7);   // no future months in the picker
  const set = new Set();
  for (const l of leads) {
    for (const d of [l.bookedSlot, l.consultationHeld, l.retainerSent, l.retainerSigned, l.retainerPaid, l.createdAt]) {
      const mk = monthKey(d); if (mk && mk <= cur) set.add(mk);
    }
  }
  return [...set].sort().reverse();
}

/**
 * Compute the KPI bundle for `month` ('YYYY-MM'), or all-time when month is ''.
 * PURE — no I/O. `leads` is the parsed Lead Board (leadService.parseItem shape).
 */
function computeKpis(leads = [], month = '', opts = {}) {
  const fee = consultFeeDollars();
  const nowMs = opts.now == null ? Date.now() : opts.now;
  const nowW = nowWall(nowMs);
  // Has this consultation happened? Its booked time, or (none) its held date, on or before now.
  const happened = (l) => {
    const slot = torontoWallClock(l.bookedSlot).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(slot)) return slot.slice(0, 16) <= nowW;
    const d = torontoWallClock(l.consultationHeld).slice(0, 10);
    return !!d && d <= nowW.slice(0, 10);
  };
  const inM = (d) => { const mk = monthKey(d); return month ? mk === month : !!mk; };
  const K = {
    month: month || 'all',
    totalLeads: leads.length,
    consultations: { booked: 0, held: 0, upcoming: 0, abandonedHolds: 0, holdsInProgress: 0, revenue: 0, paidByStaff: 0, waived: 0, virtual: 0, inPerson: 0, phone: 0, newClients: 0, existingClients: 0, byConsultant: {}, byLeadOwner: {} },
    retainers: { sent: 0, signed: 0, paid: 0, tr: 0, pr: 0, feeValue: 0, byConsultant: {} },
    funnel: { leads: 0, booked: 0, consulted: 0, retained: 0, retainedDirect: 0, signersPaid: 0, paid: 0,
      retainedFrom: { booked: 0, converted: 0, walkIn: 0 },
      // The same leads as funnel.leads, by their Source / Reference (blank = "Not recorded") — always sums to funnel.leads.
      leadsBySource: {} },
  };
  // Walk-in/referral clients enter at the retainer stage with no booking or
  // consultation — count their retentions separately so booked→retained
  // conversion isn't inflated by retentions that never entered the funnel.
  // Classified by the EXPLICIT tag (createDirectClient's Source Channel), never
  // by missing booking data — inference would silently reclassify historical
  // leads whose booking fields simply weren't stamped.
  const { isDirectClient: isDirect, shownSource } = require('../utils/directClient');   // the marker column, or the old "Direct Retainer" source
  for (const l of leads) {
    // A direct consultation (step 2): its kind — 'New' / 'Follow-up' / 'Existing client', or ''
    // (not one, or no kind readable). Only Follow-up and Existing client stay out of the funnel.
    const dcKind = directConsult.isDirectConsult(l) ? directConsult.kindOf(l) : '';
    const inFunnel = dcKind !== 'Follow-up' && dcKind !== directConsult.EXISTING;
    // Direct clients never enter the booking funnel — they'd deflate the
    // booked-from-leads rate. totalLeads still counts them.
    // A lead CONVERTED to a direct retainer was a lead first (Faran 2026-10-15): it still counts.
    if (inM(l.createdAt) && inFunnel && !(isDirect(l) && !String(l.originalChannel || '').trim())) {
      K.funnel.leads++;
      // The old "Direct Retainer" marker in Source / Reference is not a source: a lead converted before
      // 2026-11-04 keeps its real one in Original Channel (review 2026-11-10).
      inc(K.funnel.leadsBySource, shownSource(l) || String(l.originalChannel || '').trim() || SOURCE_BLANK);
    }
    const ps = consultPayment.paidState(l);
    const bk = bookingKind(l, nowMs);
    if (inM(l.bookedSlot) && bk === 'abandoned') K.consultations.abandonedHolds++;
    if (inM(l.bookedSlot) && bk === 'held') K.consultations.holdsInProgress++;
    if (inM(l.bookedSlot) && bk === 'booked') {
      K.consultations.booked++;           // every consultation, direct ones too
      if (inFunnel) K.funnel.booked++;     // the funnel: not a follow-up or an existing client's own file
      inc(K.consultations.byConsultant, l.assignedConsultant || 'Unassigned');
      inc(K.consultations.byLeadOwner, l.leadOwner || 'Unattributed');
      if (/person/i.test(l.meetingType || '')) K.consultations.inPerson++;
      else if (/phone/i.test(l.meetingType || '')) K.consultations.phone++;
      else if (String(l.meetingType || '').trim()) K.consultations.virtual++;
      if (dcKind === directConsult.EXISTING || isExistingClient(l)) K.consultations.existingClients++; else K.consultations.newClients++;
      if (ps.paid === 'app') {
        // Per-lead fee (the booking-page duration choice) when recorded; the
        // flat env fee covers legacy leads booked before per-duration pricing.
        let f = fee;
        try {
          const o = JSON.parse(l.consultOption || '');
          if (o && Number.isFinite(o.feeCents)) f = o.feeCents / 100;
        } catch (_) { /* legacy lead */ }
        K.consultations.revenue += f;
      }
    }
    // A fee recorded by staff (cash / e-transfer / invoice / other, the fee before
    // HST as entered; waived = nothing) counts in the consultation's month — or, for
    // a consultation with no booked time (the page's "No date" list: hand-booked
    // consults, exactly the ones paid outside the app), in the month it was received
    // (review 2026-10-15: those were never counted at all).
    if (ps.paid && ps.paid !== 'app' && bk === 'booked' && inM(l.bookedSlot || ps.on)) {
      if (ps.paid === 'waived') K.consultations.waived++;
      else { K.consultations.paidByStaff++; if (ps.paidCents != null) K.consultations.revenue += ps.paidCents / 100; }
    }
    // Consulted: held (date in the month) and its time has passed. Upcoming: a confirmed booking
    // whose time is still ahead — counted in its booked month (Consultation Held is normally blank
    // before the meeting), or the held month when there is no booked time.
    if (bk === 'booked') {
      if (happened(l)) {
        if (inM(l.consultationHeld)) { K.consultations.held++; if (inFunnel) K.funnel.consulted++; }
      } else if (inM(l.bookedSlot || l.consultationHeld)) K.consultations.upcoming++;
    }
    if (inM(l.retainerSent)) K.retainers.sent++;
    if (inM(l.retainerSigned)) {
      K.retainers.signed++;
      K.funnel.retained++;   // every signed retainer, walk-ins included
      if (!isDirect(l)) K.funnel.retainedFrom.booked++;
      else { K.funnel.retainedDirect++; if (String(l.originalChannel || '').trim()) K.funnel.retainedFrom.converted++; else K.funnel.retainedFrom.walkIn++; }
      if (String(l.retainerPaid || '').trim() && monthKey(l.retainerPaid)) K.funnel.signersPaid++;
      K.retainers.feeValue += feeToNum(l.retainerFee);
      const t = trPrOf(l.confirmedCaseType || l.caseTypeInterest);
      if (t === 'TR') K.retainers.tr++; else if (t === 'PR') K.retainers.pr++;
      inc(K.retainers.byConsultant, l.assignedConsultant || 'Unassigned');
    }
    if (inM(l.retainerPaid)) { K.retainers.paid++; K.funnel.paid++; }
  }
  K.consultations.revenue = Math.round(K.consultations.revenue * 100) / 100;
  K.retainers.feeValue = Math.round(K.retainers.feeValue * 100) / 100;
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  K.funnel.rates = {
    bookedFromLeads: pct(K.funnel.booked, K.funnel.leads),
    // Retained from a booked consultation over booked — walk-ins and converted leads are
    // left out so a month with walk-ins can't show >100% conversion.
    retainedFromBooked: pct(K.funnel.retainedFrom.booked, K.funnel.booked),
    // Of this month's signers, how many have paid (same group on both sides: never >100%).
    paidOfSigners: pct(K.funnel.signersPaid, K.funnel.retained),
  };
  return K;
}

/** The `count` calendar months ending at the Toronto month of `now`, oldest first: ['YYYY-MM', …]. Never a future month. */
function lastMonths(count = 12, now = Date.now()) {
  const cur = nowWall(now).slice(0, 7);
  let y = Number(cur.slice(0, 4)), m = Number(cur.slice(5, 7));
  const n = Math.max(1, Math.min(60, Math.floor(Number(count)) || 12));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m--; if (m === 0) { m = 12; y--; }
  }
  return out;
}

/** One month's chart numbers, READ from a computeKpis bundle — the only place the chart's numbers are picked. */
function trendPoint(K) {
  return {
    month: K.month,
    leads: K.funnel.leads,
    booked: K.funnel.booked,                 // confirmed bookings only (the funnel's "Booked")
    consulted: K.funnel.consulted,           // consultations that have happened
    retained: K.funnel.retained,             // every signed retainer
    retainedFrom: { ...K.funnel.retainedFrom },   // booked consultation / converted lead / walk-in
    paidThisMonth: K.funnel.paid,
    abandonedHolds: K.consultations.abandonedHolds,
    consultationsBooked: K.consultations.booked,   // every confirmed consultation (follow-ups too) — the "Consultations booked" card
    consultationsHeld: K.consultations.held,
  };
}

/**
 * The reporting charts' data. PURE — every number comes out of computeKpis for that month
 * (one set of counting rules: a chart can never disagree with the cards).
 *   trend:     one point per calendar month for the last `months` (default 12) Toronto months,
 *              oldest first, ending at the month of `now` — never a future month.
 *   breakdown: for `month` ('YYYY-MM'; default the current month; a future or unreadable one
 *              falls back to the current month): leads by source, consultations by consultant,
 *              retainers signed by consultant, TR vs PR.
 */
function computeTrend(leads = [], opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now;
  const list = lastMonths(opts.months == null ? 12 : opts.months, now);
  const cur = list[list.length - 1];
  const byMonth = new Map(list.map((mk) => [mk, computeKpis(leads, mk, { now })]));
  let sel = /^\d{4}-\d{2}$/.test(String(opts.month || '')) ? String(opts.month) : cur;
  if (sel > cur) sel = cur;
  const S = byMonth.get(sel) || computeKpis(leads, sel, { now });
  const signed = S.retainers.signed;
  return {
    months: list,
    trend: list.map((mk) => trendPoint(byMonth.get(mk))),
    breakdown: {
      month: sel,
      leads: S.funnel.leads,
      leadsBySource: { ...S.funnel.leadsBySource },
      consultationsByConsultant: { ...S.consultations.byConsultant },
      retainersSignedByConsultant: { ...S.retainers.byConsultant },
      trPr: { tr: S.retainers.tr, pr: S.retainers.pr, unclassified: Math.max(0, signed - S.retainers.tr - S.retainers.pr) },
    },
  };
}

// The shared Lead Board snapshot (leadSnapshot): one cached copy for every list
// page and the KPIs, refreshed in the background — the KPIs no longer page the
// whole board on their own.
async function loadLeads() { return require('./leadSnapshot').leads(); }

/** Fetch (cached) + compute. Returns the KPI bundle plus the months that have data. */
async function getKpis(month = '') {
  const leads = await loadLeads();
  const now = Date.now();
  return { ...computeKpis(leads, month, { now }), months: distinctMonths(leads, now) };
}

/** The charts' data from the SAME shared snapshot as getKpis — no board read of its own, and never Square. */
async function getTrend(month = '', months = 12) {
  const leads = await loadLeads();
  return computeTrend(leads, { month, months, now: Date.now() });
}

module.exports = { getKpis, getTrend, computeKpis, computeTrend, trendPoint, lastMonths, distinctMonths, monthKey, trPrOf, bookingKind, SOURCE_BLANK };
