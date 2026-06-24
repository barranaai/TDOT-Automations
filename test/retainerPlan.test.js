'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  pickAnnex, suggestTemplate, applicantCount, computeFees, computeGovFee,
  defaultMilestones, validateMilestones,
} = require('../src/services/retainerPlanService');

// ---- pickAnnex (§6) ----

test('CEC variants → P2 (high)', () => {
  for (const ct of ['CEC', 'Canadian Experience Class (EE after ITA)',
                    'Canadian Experience Class (Profile+ITA+Submission)']) {
    const r = pickAnnex(ct, '');
    assert.equal(r.code, 'P2');
    assert.equal(r.confidence, 'high');
    assert.equal(r.annexId, 'canadian-experience-class');
  }
});

test('PNP family → P5 (high); pilots → P5 (low/verify)', () => {
  assert.equal(pickAnnex('OINP', 'Masters Graduate Stream').code, 'P5');
  assert.equal(pickAnnex('OINP', '').confidence, 'high');
  const pilot = pickAnnex('RNIP', '');
  assert.equal(pilot.code, 'P5');
  assert.equal(pilot.needsVerify, true);
});

test('sub-type selects base vs extension', () => {
  assert.equal(pickAnnex('LMIA Based WP', 'Inside Canada').code, 'T5');
  assert.equal(pickAnnex('LMIA Based WP', 'Extension (Inside Canada)').code, 'T6');
  assert.equal(pickAnnex('PGWP', 'Single Applicant').code, 'T3');
  assert.equal(pickAnnex('PGWP', 'Extension - Single Applicant').code, 'T4');
  assert.equal(pickAnnex('SOWP', 'Inland - Established Relationship').code, 'T10');
  assert.equal(pickAnnex('SOWP', 'Extension (Spouse or Child)').code, 'T11');
  assert.equal(pickAnnex('Visitor Record / Extension', 'Visitor Record + Restoration').code, 'T12');
  assert.equal(pickAnnex('Visitor Visa', '').code, 'T13');
  assert.equal(pickAnnex('Visitor Visa', 'Change of Status (Student/Worker to Visitor)').code, 'T15');
});

test('Federal PR is flagged for P3-vs-P4 verification', () => {
  const r = pickAnnex('Federal PR', '');
  assert.equal(r.code, 'P3');
  assert.equal(r.needsVerify, true);
});

test('coverage gaps and unknowns return no annex', () => {
  assert.equal(pickAnnex('Co-op WP', '').code, null);
  assert.equal(pickAnnex('Totally Unknown Type', '').code, null);
  assert.equal(pickAnnex('', '').code, null);
});

// ---- suggestTemplate (§9) ----

test('suggestTemplate by signal and by annex', () => {
  assert.equal(suggestTemplate({}), 'pa');
  assert.equal(suggestTemplate({ hasInviter: true }), 'pa-inviter');
  assert.equal(suggestTemplate({ isEmployer: true }), 'employer');
  assert.equal(suggestTemplate({ annexCode: 'P8' }), 'pa-inviter');
  assert.equal(suggestTemplate({ annexCode: 'P6' }), 'employer');
});

// ---- applicantCount (§11) ----

test('applicantCount from spouse + children', () => {
  assert.deepEqual(applicantCount({}), { adults: 1, children: 0, total: 1 });
  assert.deepEqual(applicantCount({ hasSpouse: true, childrenCount: 2 }), { adults: 2, children: 2, total: 4 });
  assert.deepEqual(applicantCount({ childrenCount: '3' }), { adults: 1, children: 3, total: 4 });
});

// ---- computeFees (HST) ----

test('computeFees applies 13% HST', () => {
  const f = computeFees(250000); // $2,500.00
  assert.equal(f.hstCents, 32500);
  assert.equal(f.totalCents, 282500);
});

// ---- computeGovFee (§11) ----

test('economic PR scales by applicants, RPRF toggle', () => {
  const withR = computeGovFee('economic-pr', { adults: 2, children: 1 });
  assert.equal(withR.totalDollars, 1590 + 1590 + 270); // 3450
  const without = computeGovFee('economic-pr', { adults: 2, children: 1 }, { withRprf: false });
  assert.equal(without.totalDollars, 990 + 990 + 270); // 2250
});

test('LMIA is a flat employer-paid ESDC fee', () => {
  const r = computeGovFee('lmia', { adults: 3 });
  assert.equal(r.totalDollars, 1000);
  assert.equal(r.employerPaid, true);
});

test('visitor family max caps the total', () => {
  const r = computeGovFee('visitor', { adults: 2, children: 5 }); // 7 * 100 = 700 → cap 500
  assert.equal(r.totalDollars, 500);
  assert.equal(r.breakdown.capped, true);
});

test('biometrics scales per person up to the family max', () => {
  assert.equal(computeGovFee('biometrics', { adults: 1, children: 0 }).totalDollars, 85);
  const fam = computeGovFee('biometrics', { adults: 2, children: 3 }); // 5*85=425 → cap 170
  assert.equal(fam.totalDollars, 170);
  assert.equal(fam.breakdown.capped, true);
});

// ---- milestones (§10) ----

test('defaultMilestones: 4 rows summing exactly to the fee, row 1 locked admin', () => {
  const rows = defaultMilestones(250003); // odd cents → remainder lands on last row
  assert.equal(rows.length, 4);
  assert.equal(rows[0].label, 'Non-refundable administrative fee');
  assert.equal(rows[0].locked, true);
  assert.equal(rows.reduce((s, r) => s + r.amountCents, 0), 250003);
});

test('validateMilestones flags wrong sum and missing admin row', () => {
  const good = defaultMilestones(250000);
  assert.equal(validateMilestones(good, 250000).ok, true);

  const wrongSum = [{ label: 'Non-refundable administrative fee', amountCents: 100000 }, { label: 'Final', amountCents: 100000 }];
  assert.equal(validateMilestones(wrongSum, 250000).ok, false);

  const noAdmin = [{ label: 'Deposit', amountCents: 250000 }];
  const v = validateMilestones(noAdmin, 250000);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /administrative fee/i.test(e)));
});
