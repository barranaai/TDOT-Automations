'use strict';

// Client-portal timeline truthfulness (user report 2026-07-31, case 2026-VV-009):
// the portal claimed a FUTURE consultation "took place" (consultationHeld is
// stamped with the slot date at booking time) and showed the first payment
// twice (generic retainerPaid event + the milestone Paid event — same money).

const test   = require('node:test');
const assert = require('node:assert/strict');

const { toClientTimeline } = require('../src/services/clientPortalService');

const TODAY = '2026-07-31';

test('a future consultation never reads as having taken place', () => {
  const out = toClientTimeline([
    { date: '2026-08-03 16:30', title: 'Consultation scheduled', detail: 'Virtual meeting', kind: 'meeting' },
    { date: '2026-08-03',       title: 'Consultation held', detail: 'with Shermin Teymouri Mofrad', kind: 'meeting' },
  ], TODAY);
  assert.equal(out.length, 1, '"held" is suppressed until the day arrives');
  assert.equal(out[0].title, 'Your consultation is scheduled', 'future slot reads as upcoming, not "was booked"');
});

test('once the day arrives, the consultation reads as booked + took place', () => {
  const out = toClientTimeline([
    { date: '2026-07-20 15:00', title: 'Consultation scheduled', detail: 'Virtual meeting', kind: 'meeting' },
    { date: '2026-07-20',       title: 'Consultation held', detail: 'with Shermin Teymouri Mofrad', kind: 'meeting' },
  ], TODAY);
  assert.deepEqual(out.map((e) => e.title),
    ['Your consultation was booked', 'Your consultation took place']);
});

test('the generic first-payment event is dropped when a milestone Paid event exists', () => {
  const out = toClientTimeline([
    { date: '2026-07-31', title: 'First retainer payment recorded', kind: 'payment' },
    { date: '2026-07-31', title: 'e-Transfer requested — Milestone 1', detail: 'ref X', kind: 'payment' },
    { date: '2026-07-31', title: 'Paid — Milestone 1', detail: 'ref X', kind: 'payment' },
  ], TODAY);
  assert.deepEqual(out.map((e) => e.title), [
    'Payment requested — Milestone 1',
    'Payment received — Milestone 1 — thank you',
  ], 'the same money never shows twice, and request precedes receipt');
});

test('without milestone events, the generic first-payment event still shows', () => {
  const out = toClientTimeline([{ date: '2026-07-31', title: 'First retainer payment recorded', kind: 'payment' }], TODAY);
  assert.deepEqual(out.map((e) => e.title), ['Your first payment was received — thank you']);
});

test('unknown staff titles are still dropped, never leaked', () => {
  const out = toClientTimeline([{ date: '2026-07-31', title: 'Internal escalation — SLA breach', kind: 'lead' }], TODAY);
  assert.deepEqual(out, []);
});
