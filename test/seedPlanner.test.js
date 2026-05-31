'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { seedPlan } = require('../src/services/seedPlanner');
const schema = require('../src/data/caseSchemas/supervisa-parents.js');

// Convenience: count rows for a given role in a plan.
const countRole = (plan, role) => plan.filter((r) => r.role === role).length;
const hasDoc    = (plan, role, codeFragment) =>
  plan.some((r) => r.role === role && r.documentCode.includes(codeFragment));

// PA/Spouse have 11 doc definitions, 1 of which (NAMEAFFIDAVIT) is conditional
// on the member flag `nameChanged`. Sponsor has 7, all unconditional.
const PA_FULL = 11, PA_NO_AFFIDAVIT = 10, SPONSOR = 7;

test('PA applying alone — no spouse, no name change', () => {
  const plan = seedPlan({
    schema,
    composition: {
      caseFlags: { spouseIncluded: false },
      members:   [{ role: 'PrincipalApplicant', flags: { nameChanged: false } }],
    },
  });
  assert.equal(countRole(plan, 'PrincipalApplicant'), PA_NO_AFFIDAVIT);
  assert.equal(countRole(plan, 'Spouse'), 0, 'spouse must NOT be seeded');
  assert.equal(countRole(plan, 'Sponsor'), SPONSOR);
  assert.equal(plan.length, PA_NO_AFFIDAVIT + SPONSOR);
});

test('PA + Spouse, neither changed name', () => {
  const plan = seedPlan({
    schema,
    composition: {
      caseFlags: { spouseIncluded: true },
      members: [
        { role: 'PrincipalApplicant', flags: { nameChanged: false } },
        { role: 'Spouse',             flags: { nameChanged: false } },
      ],
    },
  });
  assert.equal(countRole(plan, 'PrincipalApplicant'), PA_NO_AFFIDAVIT);
  assert.equal(countRole(plan, 'Spouse'), PA_NO_AFFIDAVIT);
  assert.equal(countRole(plan, 'Sponsor'), SPONSOR);
  assert.equal(plan.length, PA_NO_AFFIDAVIT * 2 + SPONSOR);
});

test('per-doc conditional: only the member who changed name gets the affidavit', () => {
  const plan = seedPlan({
    schema,
    composition: {
      caseFlags: { spouseIncluded: true },
      members: [
        { role: 'PrincipalApplicant', flags: { nameChanged: true } },
        { role: 'Spouse',             flags: { nameChanged: false } },
      ],
    },
  });
  assert.equal(countRole(plan, 'PrincipalApplicant'), PA_FULL, 'PA gets the affidavit');
  assert.equal(countRole(plan, 'Spouse'), PA_NO_AFFIDAVIT, 'spouse does not');
  assert.ok(hasDoc(plan, 'PrincipalApplicant', 'NAMEAFFIDAVIT'));
  assert.ok(!hasDoc(plan, 'Spouse', 'NAMEAFFIDAVIT'));
});

test('SV-002 INVARIANT: Sponsor is seeded even when composition omits it', () => {
  // Client says "I'm applying alone." No Sponsor member, spouseIncluded false.
  // The schema marks Sponsor required → it MUST still be seeded. This is the
  // exact failure that produced 2026-SV-002's missing Sponsor rows.
  const plan = seedPlan({
    schema,
    composition: {
      caseFlags: { spouseIncluded: false },
      members:   [{ role: 'PrincipalApplicant', flags: {} }],
    },
  });
  assert.equal(countRole(plan, 'Sponsor'), SPONSOR, 'Sponsor docs must be present');
  assert.ok(hasDoc(plan, 'Sponsor', 'PASSPORT'), 'Sponsor passport row must exist');
});

test('determinism: identical input → identical output', () => {
  const composition = {
    caseFlags: { spouseIncluded: true },
    members: [
      { role: 'PrincipalApplicant', flags: { nameChanged: true } },
      { role: 'Spouse',             flags: { nameChanged: false } },
    ],
  };
  const a = seedPlan({ schema, composition });
  const b = seedPlan({ schema, composition });
  assert.deepEqual(a, b);
});

test('every documentCode in a plan is unique', () => {
  const plan = seedPlan({
    schema,
    composition: {
      caseFlags: { spouseIncluded: true },
      members: [
        { role: 'PrincipalApplicant', flags: { nameChanged: true } },
        { role: 'Spouse',             flags: { nameChanged: true } },
      ],
    },
  });
  const codes = plan.map((r) => r.documentCode);
  assert.equal(new Set(codes).size, codes.length);
});

test('row shape carries everything the I/O layer needs', () => {
  const plan = seedPlan({
    schema,
    composition: { caseFlags: {}, members: [{ role: 'PrincipalApplicant', flags: {} }] },
  });
  const row = plan[0];
  for (const key of ['role', 'applicantType', 'documentName', 'category', 'documentCode']) {
    assert.ok(row[key], `row must carry "${key}"`);
  }
  assert.equal(row.applicantType, 'Principal Applicant', 'camel role → clean label');
});
