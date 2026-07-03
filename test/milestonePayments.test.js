'use strict';

// Per-milestone payment tracking: the pure state + due logic that drives the
// panel (status from the milestonePayments JSON; "due" = the case has reached or
// passed the milestone's trigger stage, so the collect button stays available).

const test   = require('node:test');
const assert = require('node:assert/strict');

const { milestoneStates, parsePayments, paymentReference } = require('../src/services/milestonePaymentService');

const ORDER = ['Pre-Onboarding', 'Retainer Confirmed', 'Document Collection Started', 'Internal Review', 'Submission Preparation', 'Submission Ready', 'Application Submitted'];
const lead = {
  id: '1', fullName: 'Aarav', confirmedCaseType: 'Study permit', retainerFee: '2000', retainerHstRate: '13',
  retainerMilestones: JSON.stringify([
    { label: 'M1 admin',  amountCents: 100000, trigger: 'Retainer Confirmed', locked: true },
    { label: 'M2 filing', amountCents: 100000, trigger: 'Internal Review' },
  ]),
  milestonePayments: JSON.stringify({ '0': { status: 'paid', paidAt: '2026-06-30' } }),
};

test('parsePayments: valid object, junk/array → {}', () => {
  assert.deepEqual(parsePayments({ milestonePayments: '{"0":{"status":"paid"}}' }), { '0': { status: 'paid' } });
  assert.deepEqual(parsePayments({ milestonePayments: 'garbage' }), {});
  assert.deepEqual(parsePayments({ milestonePayments: '[1,2]' }), {}); // arrays rejected
  assert.deepEqual(parsePayments({}), {});
});

test('milestoneStates: HST-inclusive totals + status from the JSON', () => {
  const s = milestoneStates(lead, 'Internal Review', ORDER);
  assert.equal(s.length, 2);
  assert.equal(s[0].status, 'paid');            // from milestonePayments
  assert.equal(s[1].status, 'pending');
  assert.equal(s[0].totalCents, 113000);        // 100000 + 13% HST
  assert.ok(s[0].totalCents > s[0].amountCents);
});

test('due = reached OR passed the trigger stage (button stays until paid)', () => {
  // at Internal Review: M1 (Retainer Confirmed) is passed → due; M2 (Internal Review) is exactly reached → due
  const at = milestoneStates(lead, 'Internal Review', ORDER);
  assert.equal(at[0].due, true);
  assert.equal(at[1].due, true);
  // further along (Application Submitted): both still due (unpaid ones stay collectable)
  const later = milestoneStates(lead, 'Application Submitted', ORDER);
  assert.equal(later[1].due, true);
});

test('not due before the trigger stage, or with no case stage', () => {
  assert.equal(milestoneStates(lead, 'Pre-Onboarding', ORDER).every((m) => !m.due), true);
  assert.equal(milestoneStates(lead, '', ORDER).every((m) => !m.due), true);
});

test('unknown/side-state stage falls back to exact match', () => {
  // "Stuck" isn't in the lifecycle order → only an exact trigger match counts (neither here)
  assert.equal(milestoneStates(lead, 'Stuck', ORDER).every((m) => !m.due), true);
});

test('paymentReference: stable per-lead+milestone reference the client quotes', () => {
  assert.equal(paymentReference('12421713635', 0), 'TDOT-13635-M1');
  assert.equal(paymentReference('12421713635', 1), 'TDOT-13635-M2');
});

test('milestoneStates surfaces reference + requested status for the panel', () => {
  const l = {
    id: '9', retainerFee: '2000', retainerHstRate: '13',
    retainerMilestones: JSON.stringify([
      { label: 'M1', amountCents: 100000, trigger: 'Retainer Confirmed' },
      { label: 'M2', amountCents: 100000, trigger: 'Internal Review' },
    ]),
    milestonePayments: JSON.stringify({
      '0': { status: 'paid', paidAt: '2026-07-03', reference: 'CA000', method: 'e-transfer' },
      '1': { status: 'requested', reference: 'TDOT-00009-M2', method: 'e-transfer' },
    }),
  };
  const s = milestoneStates(l, 'Internal Review', ORDER);
  assert.equal(s[0].status, 'paid');
  assert.equal(s[0].reference, 'CA000');
  assert.equal(s[1].status, 'requested');
  assert.equal(s[1].reference, 'TDOT-00009-M2');
});
