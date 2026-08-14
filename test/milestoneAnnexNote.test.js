'use strict';

// Annex B must state that the FIRST MILESTONE IS the non-refundable admin fee,
// with the ACTUAL dollar figure (meeting decision 2026-08-13 — supersedes the
// 2026-07-31 "50% of it" wording). Plans saved under the old default label must
// render normalized, so the table can never contradict the note below it.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { computeMilestoneSchedule } = require('../src/services/retainerPlanService');
const { buildMilestoneAnnexPdf }   = require('../src/services/milestoneAnnexService');

async function annexText(rows) {
  const schedule = computeMilestoneSchedule(rows, 0.13);
  const pdf = await buildMilestoneAnnexPdf({ schedule, hstRate: 0.13, paName: 'T', applicationType: 'CEC' });
  const { text } = await require('pdf-parse')(pdf);
  return text.replace(/\s+/g, ' ');
}

test('Annex B: the non-refundable note carries the full first-milestone amount', async () => {
  const t = await annexText([
    { label: 'Milestone 1 – Admin Fee (Non-Refundable)', amountCents: 250001 },
    { label: 'Milestone 2 – On submission', amountCents: 250000 },
  ]);
  assert.match(t, /The first milestone payment of \$2,500\.01 \(before HST\) constitutes the non-\s?refundable administrative fee, charged upon engagement/,
    'the whole first milestone is the admin fee — no percentage carve-out');
  assert.ok(!/50%|fifty percent/i.test(t), 'no trace of the superseded 50% wording');
  assert.ok(!/remainder of the first milestone/.test(t), 'no refundable-remainder clause anymore');
  // The label may wrap mid-word in the column; extraction then splits it — match tolerantly.
  assert.match(t, /Refundable\)\s*\*/, 'first table row carries the footnote asterisk');
});

test('Annex B: a pre-2026-08-13 plan with the old 50% label renders normalized', async () => {
  const t = await annexText([
    { label: 'Milestone 1 – Admin Fee (50% Non-Refundable)', amountCents: 250000 },   // as saved on old leads
    { label: 'Milestone 2 – On submission', amountCents: 250000 },
  ]);
  assert.ok(!/50%|fifty percent/i.test(t),
    'the stale stored label must not resurrect the 50% wording next to the full-fee note');
});
