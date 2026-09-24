'use strict';

// Sponsor onboarding — the Family Members row it creates must change NOTHING
// about the checklist: a required Sponsor/Spouse role seeds the same document
// codes with or without a board row (seedPlanner's SV-002 invariant), so a
// re-seed after the sponsor row appears creates 0 rows. Study Permit's
// OPTIONAL Sponsor is the counter-example that documents the exclusion (D2).

const test   = require('node:test');
const assert = require('node:assert/strict');

const S   = require('../src/services/sponsorOnboardingService');
const reg = require('../src/services/caseSchemaService');
const { seedPlan, findOrphanMembers } = require('../src/services/seedPlanner');
const { diffPlan, planRowToUniqueKey } = require('../src/services/executionSeederService');
const { resolveMemberTypes, formEmbedsMembers } = require('../config/questionnaireFormMap');

const LEAD = { id: '9001', inviterName: 'Faheem Khan', inviterEmail: 'faheem@example.com' };
const CASES = [
  ['SOWP', 'Outland (Spouse or Child)'],
  ['SOWP', 'Inland - Established Relationship'],
  ['SCLPC WP', ''],
  ['Supervisa', 'Parents'],
  ['Visitor Visa', 'Spouse'],
  ['Inland Spousal Sponsorship', 'Marriage'],
];
const codes = (plan) => plan.map((r) => r.documentCode).sort();

for (const [caseType, subType] of CASES) {
  test(`${caseType} / ${subType || '(no sub type)'}: the sponsor row changes no document code; a re-seed creates 0 rows; the row is never an orphan`, () => {
    const schema = reg.lookup(caseType, subType);
    const sponsor = S.resolveSponsor({ claimants: [LEAD], caseType, caseSubType: subType, schema, memberTypes: resolveMemberTypes(caseType, subType), embedsAllMembers: formEmbedsMembers(caseType, subType) });
    assert.equal(sponsor.status, 'ok');
    const caseRef = '2026-TEST-001';
    const without = seedPlan({ schema, composition: { caseFlags: {}, members: [] } });
    const row = { role: sponsor.role, name: sponsor.name, memberKey: sponsor.memberKey, flags: {} };
    const withRow = seedPlan({ schema, composition: { caseFlags: {}, members: [row] } });
    assert.deepEqual(codes(withRow), codes(without), 'identical documentCode multiset');
    const existingKeys = new Set(without.map((r) => planRowToUniqueKey(caseRef, r)));
    const { toCreate } = diffPlan({ plan: withRow, existingKeys, caseRef });
    assert.equal(toCreate.length, 0, 'a re-seed after the row appears creates nothing');
    assert.deepEqual(findOrphanMembers({ schema, composition: { members: [row] } }), []);
    assert.equal(row.role, sponsor.boardMemberType === 'Spouse' ? 'Spouse' : 'Sponsor', 'the row role is the schema role (never WorkerSpouse)');
  });
}

test('SV-002: the Supervisa Sponsor seeds 7 documents with or without the row', () => {
  const schema = reg.lookup('Supervisa', 'Parents');
  const count = (members) => seedPlan({ schema, composition: { caseFlags: {}, members } }).filter((r) => r.role === 'Sponsor').length;
  assert.equal(count([]), 7);
  assert.equal(count([{ role: 'Sponsor', name: 'Faheem Khan', memberKey: 'sponsor', flags: {} }]), 7);
});

test('the sponsor row carries the memberKey seedPlanner expects (a singleton key, so codes never gain an index)', () => {
  for (const [caseType, subType] of CASES) {
    const schema = reg.lookup(caseType, subType);
    const sponsor = S.resolveSponsor({ claimants: [LEAD], caseType, caseSubType: subType, schema, memberTypes: [], embedsAllMembers: false });
    const plan = seedPlan({ schema, composition: { caseFlags: {}, members: [{ role: sponsor.role, memberKey: sponsor.memberKey, flags: {} }] } });
    assert.ok(plan.filter((r) => r.role === sponsor.role).every((r) => r.memberIndex === 1 && !/[A-Z]\d-/.test(r.documentCode.replace(/-001$/, ''))));
  }
});

test('Study Permit (Non SDS): a Sponsor row DOES change the plan — that Sponsor is optional, so it is NOT a sponsor to onboard', () => {
  const schema = reg.lookup('Study Permit', 'Non SDS - Accompanying Spouse or Child');
  const without = seedPlan({ schema, composition: { caseFlags: {}, members: [] } });
  const withRow = seedPlan({ schema, composition: { caseFlags: {}, members: [{ role: 'Sponsor', name: 'Uncle', memberKey: 'sponsor', flags: {} }] } });
  assert.ok(withRow.length > without.length, 'the supporter document set appears only with the row');
  const r = S.resolveSponsor({ claimants: [LEAD], caseType: 'Study Permit', caseSubType: 'Non SDS - Accompanying Spouse or Child', schema, memberTypes: resolveMemberTypes('Study Permit', 'Non SDS - Accompanying Spouse or Child'), embedsAllMembers: false });
  assert.equal(r.reason, 'not-applicable');
});
