/**
 * kpiService — automatic reporting/KPIs computed from the Lead Board.
 *
 * computeKpis() is PURE (leads array → metrics) so it's fully testable; getKpis()
 * paginates the whole board (leadService.listAllLeads), caches it briefly, and
 * computes for a given month. Windowing is by the event's own date: consultations
 * by bookedSlot, "held" by consultationHeld, retainer sent/signed/paid by their
 * dates, leads by createdAt. Consultation revenue = a fixed fee per PAID consult
 * (squareConsultTxnId present); retainer value = summed retainerFee of signed cases.
 */

'use strict';

const leadService = require('./leadService');

function consultFeeDollars() {
  try { return (Number(require('./bookingService').CONSULT_FEE_CENTS) || 20000) / 100; }
  catch (_) { return 200; }
}

/** 'YYYY-MM' from an ISO date, a 'YYYY-MM-DD HH:MM' slot, or '' if unparseable. */
function monthKey(dateStr) {
  const m = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})/);
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
  return /exist|return|prior|current/i.test(lead.relationshipWithTdot || '') || !!String(lead.existingFileType || '').trim();
}
function inc(o, k) { o[k] = (o[k] || 0) + 1; }

/** Distinct 'YYYY-MM' present across the KPI dates, newest first — drives the month picker. */
function distinctMonths(leads) {
  const set = new Set();
  for (const l of leads) {
    for (const d of [l.bookedSlot, l.consultationHeld, l.retainerSent, l.retainerSigned, l.retainerPaid, l.createdAt]) {
      const mk = monthKey(d); if (mk) set.add(mk);
    }
  }
  return [...set].sort().reverse();
}

/**
 * Compute the KPI bundle for `month` ('YYYY-MM'), or all-time when month is ''.
 * PURE — no I/O. `leads` is the parsed Lead Board (leadService.parseItem shape).
 */
function computeKpis(leads = [], month = '') {
  const fee = consultFeeDollars();
  const inM = (d) => { const mk = monthKey(d); return month ? mk === month : !!mk; };
  const K = {
    month: month || 'all',
    totalLeads: leads.length,
    consultations: { booked: 0, held: 0, revenue: 0, virtual: 0, inPerson: 0, newClients: 0, existingClients: 0, byConsultant: {} },
    retainers: { sent: 0, signed: 0, paid: 0, tr: 0, pr: 0, feeValue: 0, byConsultant: {} },
    funnel: { leads: 0, booked: 0, consulted: 0, retained: 0, paid: 0 },
  };
  for (const l of leads) {
    if (inM(l.createdAt)) K.funnel.leads++;
    if (inM(l.bookedSlot)) {
      K.consultations.booked++; K.funnel.booked++;
      inc(K.consultations.byConsultant, l.assignedConsultant || 'Unassigned');
      if (/person/i.test(l.meetingType || '')) K.consultations.inPerson++;
      else if (String(l.meetingType || '').trim()) K.consultations.virtual++;
      if (isExistingClient(l)) K.consultations.existingClients++; else K.consultations.newClients++;
      if (String(l.squareConsultTxnId || '').trim()) K.consultations.revenue += fee;
    }
    if (inM(l.consultationHeld)) { K.consultations.held++; K.funnel.consulted++; }
    if (inM(l.retainerSent)) K.retainers.sent++;
    if (inM(l.retainerSigned)) {
      K.retainers.signed++; K.funnel.retained++;
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
    retainedFromBooked: pct(K.funnel.retained, K.funnel.booked),
    paidFromRetained: pct(K.funnel.paid, K.funnel.retained),
  };
  return K;
}

// The board scan is heavy — cache it briefly so month-switching / reloads don't
// re-paginate the whole board on every request.
const CACHE_MS = 60 * 1000;
let _cache = { at: 0, leads: null };
async function loadLeads() {
  if (!_cache.leads || (Date.now() - _cache.at) > CACHE_MS) {
    _cache = { at: Date.now(), leads: await leadService.listAllLeads() };
  }
  return _cache.leads;
}

/** Fetch (cached) + compute. Returns the KPI bundle plus the months that have data. */
async function getKpis(month = '') {
  const leads = await loadLeads();
  return { ...computeKpis(leads, month), months: distinctMonths(leads) };
}

module.exports = { getKpis, computeKpis, distinctMonths, monthKey, trPrOf };
