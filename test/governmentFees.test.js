'use strict';

// Government fees go onto a signed retainer agreement, so the reference values are
// pinned here and checked against the official IRCC fee list. Verified 2026-07-03
// against https://ircc.canada.ca/english/information/fees/fees.asp (post the
// 2026-04-30 PR fee increase). If IRCC changes a fee, this test fails on purpose —
// update config/governmentFees.js AND this test together after re-verifying.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { GOV_FEES } = require('../config/governmentFees');
const { computeGovFee } = require('../src/services/retainerPlanService');

test('GOV_FEES match the current official IRCC fee list (2026-07-03)', () => {
  assert.equal(GOV_FEES['economic-pr'].principal, 1590);              // $990 processing + $600 RPRF
  assert.equal(GOV_FEES['economic-pr'].withoutRprf.principal, 990);
  assert.equal(GOV_FEES['economic-pr'].child, 270);                   // child (no RPRF)
  assert.equal(GOV_FEES['spousal-sponsorship'].principal, 1260);     // published combined total (incl RPRF)
  assert.equal(GOV_FEES['spousal-sponsorship'].withoutRprf.principal, 660);
  assert.equal(GOV_FEES['spousal-sponsorship'].child, 180);
  assert.equal(GOV_FEES['pgp-sponsorship'].principal, 1260);
  assert.equal(GOV_FEES['study'].principal, 150);
  assert.equal(GOV_FEES['open-wp'].principal, 255);                   // WP $155 + open-holder $100
  assert.equal(GOV_FEES['employer-wp'].principal, 155);
  assert.equal(GOV_FEES['visitor'].principal, 100);
  assert.equal(GOV_FEES['visitor'].familyMax, 500);
  assert.equal(GOV_FEES['restoration-visitor'].principal, 246.25);
  assert.equal(GOV_FEES['biometrics'].principal, 85);
  assert.equal(GOV_FEES['biometrics'].familyMax, 170);
  assert.equal(GOV_FEES['citizenship'].principal, 653);              // adult grant incl RoC $123
  assert.equal(GOV_FEES['citizenship'].child, 100);
  assert.equal(GOV_FEES['pr-card'].principal, 50);
  assert.equal(GOV_FEES['prtd'].principal, 50);
  assert.equal(GOV_FEES['lmia'].flat, 1000);                         // ESDC, employer-paid per position
});

test('computeGovFee scales by applicants, applies the RPRF toggle + family caps', () => {
  // Economic PR couple + 1 child, with RPRF: each adult pays their own PR fee; child $270
  assert.equal(computeGovFee('economic-pr', { adults: 2, children: 1 }, { withRprf: true }).totalDollars, 1590 + 1590 + 270);
  // Same, RPRF deferred: adults drop to $990; child unchanged (children are RPRF-exempt)
  assert.equal(computeGovFee('economic-pr', { adults: 2, children: 1 }, { withRprf: false }).totalDollars, 990 + 990 + 270);
  // Visitor family of 6 is capped at the $500 family max
  assert.equal(computeGovFee('visitor', { adults: 2, children: 4 }).totalDollars, 500);
  // Biometrics capped at the $170 family max
  assert.equal(computeGovFee('biometrics', { adults: 2, children: 2 }).totalDollars, 170);
  // Study permit is per-person, no cap
  assert.equal(computeGovFee('study', { adults: 2, children: 2 }).totalDollars, 600);
  // Spousal sponsorship: one sponsored applicant
  assert.equal(computeGovFee('spousal-sponsorship', { adults: 1 }, { withRprf: true }).totalDollars, 1260);
  assert.equal(computeGovFee('spousal-sponsorship', { adults: 1 }, { withRprf: false }).totalDollars, 660);
  // LMIA is a flat, employer-paid ESDC fee
  const lmia = computeGovFee('lmia', { adults: 1 });
  assert.equal(lmia.totalDollars, 1000);
  assert.equal(lmia.employerPaid, true);
  // Unknown key → null (caller falls back / warns)
  assert.equal(computeGovFee('nope', { adults: 1 }), null);
});
