'use strict';

// LMIA advertisement fee (team feedback 2026-08-13, point 11): a manual
// disbursement amount entered on the retainer panel for LMIA-family cases,
// stored on the lead, and printed on Annex B beside the government fee.
// It is NOT part of the professional fee, the milestone sum, or HST.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildRetainerPlan, overridesFromLead, milestoneAnnexFromPlan } = require('../src/services/retainerPlanBuilder');
const { parseSelections } = require('../src/services/consultantPortalService');
const { buildMilestoneAnnexPdf } = require('../src/services/milestoneAnnexService');
const { computeMilestoneSchedule } = require('../src/services/retainerPlanService');

const lmiaLead = (extra = {}) => ({
  id: '1', fullName: 'Emp Rep', email: 'e@x.com', residentialAddress: '1 Bay St',
  confirmedCaseType: 'LMIA', retainerFee: '3000', ...extra,
});

test('overridesFromLead maps the stored advertisementFee', () => {
  assert.equal(overridesFromLead(lmiaLead({ advertisementFee: '450.50' })).adFeeDollars, 450.5);
  assert.equal(overridesFromLead(lmiaLead()).adFeeDollars, undefined, 'absent stays absent');
});

test('the plan carries adFee and hands it to the annex payload', () => {
  const plan = buildRetainerPlan(lmiaLead(), { adFeeDollars: 450.5 });
  assert.equal(plan.adFee.dollars, 450.5);
  assert.equal(milestoneAnnexFromPlan(plan).adFeeDollars, 450.5);
  const bare = buildRetainerPlan(lmiaLead(), {});
  assert.equal(bare.adFee.dollars, null, 'no entry → null, and the annex line is suppressed');
  assert.equal(bare.fees.serviceFeeCents, 300000, 'ad fee never touches the professional fee');
});

test('parseSelections whitelists adFeeDollars (finite, >= 0)', () => {
  assert.equal(parseSelections({ template: 'pa', adFeeDollars: '450.5' }).adFeeDollars, 450.5);
  assert.equal(parseSelections({ template: 'pa', adFeeDollars: -3 }).adFeeDollars, undefined);
  assert.equal(parseSelections({ template: 'pa', adFeeDollars: 'NaNny' }).adFeeDollars, undefined);
});

test('Annex B prints the advertisement line only when a positive amount is set', async () => {
  const schedule = computeMilestoneSchedule([{ label: 'Milestone 1 – Admin Fee (Non-Refundable)', amountCents: 300000 }], 0.13);
  const withAd = await buildMilestoneAnnexPdf({ schedule, hstRate: 0.13, govFeeDollars: 1000, govFeeEmployerPaid: true, adFeeDollars: 450.5, paName: 'T', applicationType: 'LMIA' });
  const t1 = (await require('pdf-parse')(withAd)).text.replace(/\s+/g, ' ');
  assert.match(t1, /Advertisement fee \(recruitment — third-party disbursement\)/);
  assert.match(t1, /\$450\.50 — for job advertisement placement/);
  assert.match(t1, /employer-paid to ESDC/, 'gov-fee line unaffected');
  const withoutAd = await buildMilestoneAnnexPdf({ schedule, hstRate: 0.13, paName: 'T', applicationType: 'CEC' });
  const t2 = (await require('pdf-parse')(withoutAd)).text.replace(/\s+/g, ' ');
  assert.ok(!/Advertisement fee/.test(t2), 'non-LMIA agreements are untouched');
});
