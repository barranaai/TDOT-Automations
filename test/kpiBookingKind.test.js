'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeKpis, bookingKind } = require('../src/services/kpiService');

const NOW = Date.parse('2026-11-09T17:00:00Z');

test('a paid or held row still marked Slot Held / Abandoned is a booking', () => {
  assert.equal(bookingKind({ bookingStatus: 'Slot Held', squareConsultTxnId: 't1' }, NOW), 'booked');
  assert.equal(bookingKind({ bookingStatus: 'Abandoned', consultationHeld: '2026-11-02' }, NOW), 'booked');
  const K = computeKpis([{ id: 1, createdAt: '2026-11-01T12:00:00Z', bookingStatus: 'Slot Held', squareConsultTxnId: 't1',
    bookedSlot: '2026-11-02 10:00', consultationHeld: '2026-11-02' }], '2026-11', { now: NOW });
  assert.equal(K.consultations.booked, 1);
  assert.equal(K.consultations.held, 1);
  assert.equal(K.consultations.holdsInProgress, 0);
});

test('a Slot Held whose hold ran out is abandoned, not on hold now', () => {
  assert.equal(bookingKind({ bookingStatus: 'Slot Held', slotHeldUntil: '2026-10-20T12:00:00Z' }, NOW), 'abandoned');
  assert.equal(bookingKind({ bookingStatus: 'Slot Held', slotHeldUntil: '2026-11-09T18:00:00Z' }, NOW), 'held');
  const K = computeKpis([{ id: 2, bookingStatus: 'Slot Held', slotHeldUntil: '2026-10-20T12:00:00Z', bookedSlot: '2026-10-21 10:00' }], '2026-10', { now: NOW });
  assert.equal(K.consultations.holdsInProgress, 0);
  assert.equal(K.consultations.abandonedHolds, 1);
});

test('a confirmed future booking with no held date shows as Upcoming', () => {
  const K = computeKpis([{ id: 3, bookingStatus: 'Booked', bookedSlot: '2026-11-20 10:00' }], '2026-11', { now: NOW });
  assert.equal(K.consultations.booked, 1);
  assert.equal(K.consultations.upcoming, 1);
  assert.equal(K.consultations.held, 0);
});
