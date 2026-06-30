'use strict';

// Milestone trigger = a curated Client Master Case Stage. Asserts the offered
// stage list is the payment-relevant lifecycle (no side-states), and that a
// stage value chosen as a trigger survives parseSelections into storage.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { parseSelections, MILESTONE_TRIGGER_STAGES } = require('../src/services/consultantPortalService');

test('MILESTONE_TRIGGER_STAGES is the curated lifecycle, in order, excluding side-states', () => {
  assert.deepEqual(MILESTONE_TRIGGER_STAGES, [
    'Pre-Onboarding',
    'Retainer Confirmed',
    'Document Collection Started',
    'Internal Review',
    'Submission Preparation',
    'Submission Ready',
    'Application Submitted',
  ]);
  // side-states that exist on the board but are not payment triggers
  ['Stuck', 'Cancelled', 'Ads posted', 'Task Done', 'Profile Created', 'Profile Linked', 'Reconsideration']
    .forEach((s) => assert.ok(!MILESTONE_TRIGGER_STAGES.includes(s), `${s} must not be a trigger`));
});

test('parseSelections preserves a case-stage trigger on a milestone', () => {
  const sel = parseSelections({
    template: 'pa',
    milestones: [
      { label: 'Milestone 1 – Non-Refundable Admin Fee', amountCents: 100000, trigger: 'Retainer Confirmed' },
      { label: 'Milestone 2 – eAPR Filing',               amountCents: 100000, trigger: 'Internal Review' },
    ],
  });
  assert.equal(sel.milestones[0].trigger, 'Retainer Confirmed');
  assert.equal(sel.milestones[0].locked, true);   // first milestone stays the admin fee
  assert.equal(sel.milestones[1].trigger, 'Internal Review');
});
