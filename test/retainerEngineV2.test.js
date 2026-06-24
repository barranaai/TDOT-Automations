'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { overridesFromLead } = require('../src/services/retainerPlanBuilder');
const retainer2 = require('../src/services/retainerService2');

test('overridesFromLead reconstructs the saved plan from lead columns', () => {
  const lead = {
    selectedTemplate: 'pa-inviter', selectedScopeAnnex: 'P8', selectedSubType: 'Marriage',
    govFee: '1260', retainerWithRprf: 'No',
    retainerMilestones: JSON.stringify([{ label: 'Admin', amountCents: 100000 }]),
    inviterName: 'Inviter Co', empRepName: '',
  };
  const o = overridesFromLead(lead);
  assert.equal(o.template, 'pa-inviter');
  assert.equal(o.annexCode, 'P8');
  assert.equal(o.subType, 'Marriage');
  assert.equal(o.govFeeDollars, 1260);
  assert.equal(o.withRprf, false);
  assert.equal(o.milestones[0].amountCents, 100000);
  assert.equal(o.inviterName, 'Inviter Co');
  assert.ok(!('empRepName' in o)); // empty values are skipped
});

test('overridesFromLead tolerates garbage milestones JSON (degrades to default)', () => {
  assert.equal(overridesFromLead({ retainerMilestones: '{not json' }).milestones, undefined);
  assert.equal(overridesFromLead({}).milestones, undefined);
});

test('v1 is the default: getRetainerDocument returns the generic pdfkit PDF', async () => {
  delete process.env.RETAINER_ENGINE;
  const pdf = await retainer2.getRetainerDocument({
    id: '1', fullName: 'Test Client', email: 'x@y.com', caseTypeInterest: 'CEC', retainerFee: '2500',
  });
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
});

test('v2 holds (throws notReady) when the plan is incomplete — never reaches CloudConvert', async () => {
  process.env.RETAINER_ENGINE = 'v2';
  try {
    await assert.rejects(
      () => retainer2.getRetainerDocument({ id: '2-incomplete', fullName: 'X', email: 'x@y.com' }),
      (e) => e.notReady === true,
    );
  } finally {
    delete process.env.RETAINER_ENGINE;
  }
});
