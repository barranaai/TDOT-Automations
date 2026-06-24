'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { parseSelections, validateAction } = require('../src/services/consultantPortalService');

const goodMilestones = [
  { label: 'Non-refundable administrative fee', amountCents: 100000, trigger: 'On signing' },
  { label: 'Milestone 2', amountCents: 150000, trigger: 'On submission' },
];

test('parseSelections normalises an object payload', () => {
  const s = parseSelections({
    template: 'pa', annexCode: 'P2', feeCents: 250000, govFeeDollars: 3450,
    withRprf: 'Yes', milestones: goodMilestones, inviterName: '  Inv  ',
  });
  assert.equal(s.template, 'pa');
  assert.equal(s.annexCode, 'P2');
  assert.equal(s.feeCents, 250000);
  assert.equal(s.govFeeDollars, 3450);
  assert.equal(s.withRprf, true);
  assert.equal(s.inviterName, 'Inv'); // trimmed
  assert.equal(s.milestones[0].locked, true);
  assert.equal(s.milestones[1].locked, false);
});

test('parseSelections accepts a JSON string and coerces milestone amounts', () => {
  const s = parseSelections(JSON.stringify({
    template: 'employer', annexCode: 'P6', feeCents: 500000,
    milestones: [{ label: 'Admin', amountCents: '250000.4' }, { label: 'Final', amountCents: 249999.6 }],
  }));
  assert.equal(s.template, 'employer');
  assert.equal(s.milestones[0].amountCents, 250000); // Math.round of "250000.4"
  assert.equal(s.milestones[1].amountCents, 250000);
});

test('parseSelections rejects malformed / unknown-template input', () => {
  assert.equal(parseSelections('not json'), null);
  assert.equal(parseSelections('[]'), null);          // array, not object
  assert.equal(parseSelections({}), null);            // empty
  assert.equal(parseSelections(null), null);
  assert.equal(parseSelections({ template: 'bogus' }), null); // unknown template
});

test('withRprf coercion handles bool and string forms', () => {
  assert.equal(parseSelections({ annexCode: 'P2', withRprf: false }).withRprf, false);
  assert.equal(parseSelections({ annexCode: 'P2', withRprf: 'No' }).withRprf, false);
  assert.equal(parseSelections({ annexCode: 'P2', withRprf: true }).withRprf, true);
});

test('validateAction(saveRetainerSelections) enforces template+annex+fee+milestone sum', () => {
  // happy
  const ok = validateAction('saveRetainerSelections', {
    template: 'pa', annexCode: 'P2', feeCents: 250000, milestones: goodMilestones,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.normalized.template, 'pa');

  // missing template/annex
  assert.equal(validateAction('saveRetainerSelections', { feeCents: 250000, milestones: goodMilestones }).ok, false);

  // missing fee
  assert.equal(validateAction('saveRetainerSelections', { template: 'pa', annexCode: 'P2', milestones: goodMilestones }).ok, false);

  // milestones don't sum to fee
  const bad = validateAction('saveRetainerSelections', {
    template: 'pa', annexCode: 'P2', feeCents: 999999, milestones: goodMilestones,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /milestone/i);

  // malformed
  assert.equal(validateAction('saveRetainerSelections', 'garbage').ok, false);
});
