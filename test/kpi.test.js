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
  assert.equal(k.funnel.rates.paidFromRetained, 50);
});

test('all-time (no month) includes every dated event', () => {
  const k = computeKpis(LEADS, '');
  assert.equal(k.consultations.booked, 3);  // includes June
  assert.equal(k.consultations.held, 3);
});

test('distinctMonths lists the months that have data, newest first', () => {
  assert.deepEqual(distinctMonths(LEADS), ['2026-07', '2026-06']);
});
