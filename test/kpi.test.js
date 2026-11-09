'use strict';

// KPI aggregation is pure (leads → metrics), windowed by each event's own date.
// Locks the counting, the month window, revenue, TR/PR split, and funnel rates.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { computeKpis, distinctMonths, trPrOf } = require('../src/services/kpiService');
const CONSULT_FEE = (Number(require('../src/services/bookingService').CONSULT_FEE_CENTS) || 20000) / 100;

const LEADS = [
  { assignedConsultant: 'Shermin Teymouri Mofrad', leadOwner: 'Prajwal', bookedSlot: '2026-07-10 16:00', consultationHeld: '2026-07-10', meetingType: 'Virtual',   squareConsultTxnId: 't1', confirmedCaseType: 'Study Permit',                retainerSent: '2026-07-11', retainerSigned: '2026-07-12', retainerPaid: '2026-07-13', retainerFee: '2000', createdAt: '2026-07-01T10:00:00Z' },
  { assignedConsultant: 'Shafoli Kapur',            bookedSlot: '2026-07-15 14:00', consultationHeld: '2026-07-16', meetingType: 'In-person', squareConsultTxnId: 't2', existingFileType: 'PR', confirmedCaseType: 'Inland Spousal Sponsorship', retainerSent: '2026-07-17', retainerSigned: '2026-07-18', retainerFee: '5000', createdAt: '2026-07-05T10:00:00Z' },
  { assignedConsultant: 'Shermin Teymouri Mofrad', bookedSlot: '2026-06-20 10:00', consultationHeld: '2026-06-20', meetingType: 'Virtual',   squareConsultTxnId: 't3', confirmedCaseType: 'Visitor Visa', createdAt: '2026-06-01T10:00:00Z' },
];

test('trPrOf derives TR vs PR from the case type (via the annex group)', () => {
  assert.equal(trPrOf('Study Permit'), 'TR');
  assert.equal(trPrOf('Inland Spousal Sponsorship'), 'PR');
  assert.equal(trPrOf(''), null);          // no case type → unclassified
});

test('computeKpis windows by each event date and counts correctly (July)', () => {
  const k = computeKpis(LEADS, '2026-07');
  // consultations
  assert.equal(k.consultations.booked, 2);        // the June one is excluded
  assert.equal(k.consultations.held, 2);
  assert.equal(k.consultations.revenue, 2 * CONSULT_FEE); // both paid (txn present)
  assert.equal(k.consultations.virtual, 1);
  assert.equal(k.consultations.inPerson, 1);
  assert.equal(k.consultations.newClients, 1);
  assert.equal(k.consultations.existingClients, 1); // lead 2 has existingFileType
  assert.equal(k.consultations.byLeadOwner.Prajwal, 1);        // attribution credit
  assert.equal(k.consultations.byLeadOwner.Unattributed, 1);   // lead 2 has no owner
  // retainers
  assert.equal(k.retainers.sent, 2);
  assert.equal(k.retainers.signed, 2);
  assert.equal(k.retainers.paid, 1);              // only lead 1 paid
  assert.equal(k.retainers.tr, 1);                // Study Permit
  assert.equal(k.retainers.pr, 1);                // Inland Spousal
  assert.equal(k.retainers.feeValue, 7000);
  // funnel + rates
  assert.deepEqual(
    { l: k.funnel.leads, b: k.funnel.booked, c: k.funnel.consulted, r: k.funnel.retained, p: k.funnel.paid },
    { l: 2, b: 2, c: 2, r: 2, p: 1 },
  );
  assert.equal(k.funnel.rates.paidOfSigners, 50);
});

test('all-time (no month) includes every dated event', () => {
  const k = computeKpis(LEADS, '');
  assert.equal(k.consultations.booked, 3);  // includes June
  assert.equal(k.consultations.held, 3);
});

test('distinctMonths lists the months that have data, newest first', () => {
  assert.deepEqual(distinctMonths(LEADS), ['2026-07', '2026-06']);
});

// ─── Step 6 counting rules (Faran 2026-11-09, every month) ───────────────────
const NOW = Date.parse('2026-11-09T17:00:00Z');   // 12:00 Toronto, 9 Nov 2026
const NOV = [
  // booked through the link, held in the past, signed + paid in Nov
  { id: 'b1', bookingStatus: 'Booked', assignedConsultant: 'Shermin', leadOwner: 'Prajwal', bookedSlot: '2026-11-03 10:00', consultationHeld: '2026-11-03', meetingType: 'Virtual', retainerSigned: '2026-11-04', retainerPaid: '2026-11-05', createdAt: '2026-11-01T14:00:00Z' },
  // a confirmed booking later today (future) → Upcoming, still Booked
  { id: 'b2', bookingStatus: 'Booked', assignedConsultant: 'Shafoli', leadOwner: 'Melanie', bookedSlot: '2026-11-09 15:00', consultationHeld: '2026-11-09', meetingType: 'Virtual', createdAt: '2026-10-20T14:00:00Z' },
  // a future slot later in the month
  { id: 'b3', bookingStatus: 'Booked', assignedConsultant: 'Shafoli', bookedSlot: '2026-11-25 11:00', consultationHeld: '2026-11-25', meetingType: 'In-person', createdAt: '2026-11-02T14:00:00Z' },
  // an abandoned hold and a hold still running: not bookings
  { id: 'h1', bookingStatus: 'Abandoned', assignedConsultant: 'Shermin', leadOwner: 'Prajwal', bookedSlot: '2026-11-06 10:00', meetingType: 'Virtual', createdAt: '2026-11-02T14:00:00Z' },
  { id: 'h2', bookingStatus: 'Slot Held', assignedConsultant: 'Shermin', bookedSlot: '2026-11-12 10:00', meetingType: 'Virtual', createdAt: '2026-11-08T14:00:00Z' },
  // a walk-in direct retainer, signed, unpaid
  { id: 'd1', directClient: 'Yes', assignedConsultant: 'Shafoli', retainerSigned: '2026-11-06', retainerFee: '3000', createdAt: '2026-11-06T14:00:00Z' },
  // a lead converted into a direct retainer, signed + paid in Nov
  { id: 'd2', directClient: 'Yes', originalChannel: 'Website', assignedConsultant: 'Shafoli', retainerSigned: '2026-11-07', retainerPaid: '2026-11-07', createdAt: '2026-10-10T14:00:00Z' },
  // signed in October, paid in November
  { id: 'p1', directClient: 'Yes', retainerSigned: '2026-10-28', retainerPaid: '2026-11-02', createdAt: '2026-10-28T14:00:00Z' },
  // paid in November with no signed date
  { id: 'p2', retainerPaid: '2026-11-03', createdAt: '2026-10-01T14:00:00Z' },
];

test('step 6 — Retained counts every signed retainer, walk-ins included, split by source', () => {
  const k = computeKpis(NOV, '2026-11', { now: NOW });
  assert.equal(k.funnel.retained, 3);
  assert.equal(k.retainers.signed, 3);
  assert.deepEqual(k.funnel.retainedFrom, { booked: 1, converted: 1, walkIn: 1 });
  assert.equal(k.funnel.retainedDirect, 2, 'the old "+Direct" = converted + walk-in');
  assert.deepEqual(k.retainers.byConsultant, { Shermin: 1, Shafoli: 2 });
});

test('step 6 — Paid: of this month\'s signers vs paid this month (a prior-month signing and paid-without-signed count only in the second)', () => {
  const k = computeKpis(NOV, '2026-11', { now: NOW });
  assert.equal(k.funnel.signersPaid, 2, 'b1 + d2; the walk-in d1 is unpaid');
  assert.equal(k.funnel.rates.paidOfSigners, 66.7);
  assert.equal(k.funnel.paid, 4, 'b1, d2, p1 (signed in Oct), p2 (no signed date)');
  assert.equal(k.retainers.paid, 4);
  const oct = computeKpis(NOV, '2026-10', { now: NOW });
  assert.equal(oct.funnel.retained, 1);
  assert.equal(oct.funnel.signersPaid, 1, 'p1 signed in Oct has paid (in Nov)');
  assert.equal(oct.funnel.paid, 0);
});

test('step 6 — Booked counts real bookings only; abandoned holds and running holds are their own numbers, also by consultant / owner', () => {
  const k = computeKpis(NOV, '2026-11', { now: NOW });
  assert.equal(k.consultations.booked, 3);
  assert.equal(k.funnel.booked, 3);
  assert.equal(k.consultations.abandonedHolds, 1);
  assert.equal(k.consultations.holdsInProgress, 1);
  assert.deepEqual(k.consultations.byConsultant, { Shermin: 1, Shafoli: 2 });
  assert.deepEqual(k.consultations.byLeadOwner, { Prajwal: 1, Melanie: 1, Unattributed: 1 });
  assert.equal(k.consultations.virtual, 2);
  assert.equal(k.consultations.inPerson, 1);
});

test('step 6 — Consulted counts consultations on or before now; later ones are Upcoming', () => {
  const k = computeKpis(NOV, '2026-11', { now: NOW });
  assert.equal(k.consultations.held, 1);
  assert.equal(k.funnel.consulted, 1);
  assert.equal(k.consultations.upcoming, 2, 'later today and the 25th');
  const later = computeKpis(NOV, '2026-11', { now: Date.parse('2026-11-30T17:00:00Z') });
  assert.equal(later.consultations.held, 3);
  assert.equal(later.consultations.upcoming, 0);
  // no booked time: the held date decides
  const dateOnly = [{ consultationHeld: '2026-11-09' }, { consultationHeld: '2026-11-10' }];
  const d = computeKpis(dateOnly, '2026-11', { now: NOW });
  assert.equal(d.consultations.held, 1);
  assert.equal(d.consultations.upcoming, 1);
});

test('step 6 — the month picker never lists a future month', () => {
  const rows = [...NOV, { bookedSlot: '2026-12-02 10:00', bookingStatus: 'Booked', createdAt: '2026-11-08T14:00:00Z' }];
  assert.deepEqual(distinctMonths(rows, NOW), ['2026-11', '2026-10']);
});
