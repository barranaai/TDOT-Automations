'use strict';

// Annex B must state the 50% non-refundable admin fee with the ACTUAL dollar
// figures (user directive 2026-07-31): the first milestone row is asterisked and
// the note names the milestone amount and the 50% portion explicitly.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { computeMilestoneSchedule } = require('../src/services/retainerPlanService');
const { buildMilestoneAnnexPdf }   = require('../src/services/milestoneAnnexService');

test('Annex B: 50% non-refundable note carries the computed amounts', async () => {
  const schedule = computeMilestoneSchedule([
    { label: 'Milestone 1 – Admin Fee (50% Non-Refundable)', amountCents: 250001 }, // odd cents → $1,250.01 half
    { label: 'Milestone 2 – On submission', amountCents: 250000 },
  ], 0.13);
  const pdf = await buildMilestoneAnnexPdf({ schedule, hstRate: 0.13, paName: 'T', applicationType: 'CEC' });
  const { text } = await require('pdf-parse')(pdf);
  const t = text.replace(/\s+/g, ' ');
  assert.match(t, /Of the first milestone payment of \$2,500\.01 \(before HST\), fifty percent \(50%\) — \$1,250\.01 —/,
    'note states both the milestone amount and its 50% portion');
  assert.match(t, /constitutes a non-\s?refundable administrative fee, charged upon engagement/);
  assert.match(t, /remainder of the first milestone is subject to the refund terms/,
    'the refundable remainder is stated too — the whole milestone is NOT non-refundable');
  // The label may wrap mid-word in the column; extraction then splits it — match tolerantly.
  assert.match(t, /Refundable\)\s*\*/, 'first table row carries the footnote asterisk');
});
