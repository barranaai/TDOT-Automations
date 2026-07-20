'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { findOrphanMembers } = require('../src/services/seedPlanner');
const { summariseDocuments } = require('../src/services/caseCockpitService');
const { formEmbedsMembers, resolveMemberTypes } = require('../config/questionnaireFormMap');

// ─── Guardrail: findOrphanMembers ───────────────────────────────────────────────
test('findOrphanMembers: flags board members whose role the schema cannot seed', () => {
  const schema = { caseType: 'Visitor Visa', subType: '1-2 Members', roles: [
    { role: 'PrincipalApplicant' }, { role: 'Spouse' }, { role: 'Sponsor' },
  ] };
  // Board has a spouse (covered) + two children (NOT in this schema).
  const composition = { members: [
    { role: 'Spouse', memberKey: 'spouse' },
    { role: 'DependentChild', memberKey: 'child-1' },
    { role: 'DependentChild', memberKey: 'child-2' },
  ] };
  const orphans = findOrphanMembers({ schema, composition });
  assert.equal(orphans.length, 1, 'one orphaned role (DependentChild)');
  assert.equal(orphans[0].role, 'DependentChild');
  assert.equal(orphans[0].label, 'Dependent Child');
  assert.equal(orphans[0].count, 2, 'both children counted');
});

test('findOrphanMembers: empty when every board member has a matching schema role', () => {
  const schema = { roles: [{ role: 'PrincipalApplicant' }, { role: 'Spouse' }, { role: 'DependentChild' }] };
  const composition = { members: [{ role: 'Spouse' }, { role: 'DependentChild' }, { role: 'DependentChild' }] };
  assert.deepEqual(findOrphanMembers({ schema, composition }), []);
});

test('findOrphanMembers: NOT a false positive for NonAccompanyingSpouse/Child schemas (role-family match)', () => {
  // Single-applicant schema names the roles NonAccompanyingSpouse / NonAccompanyingChild;
  // seedPlan STILL seeds them via the derived caseFlag, so a board Spouse/DependentChild
  // is COVERED and must not be flagged.
  const schema = { roles: [{ role: 'PrincipalApplicant' }, { role: 'NonAccompanyingSpouse' }, { role: 'NonAccompanyingChild' }] };
  const composition = { members: [{ role: 'Spouse' }, { role: 'DependentChild' }] };
  assert.deepEqual(findOrphanMembers({ schema, composition }), [], 'covered by the non-accompanying roles → no false alarm');
});

test('findOrphanMembers: safe on empty/missing composition or schema', () => {
  assert.deepEqual(findOrphanMembers({ schema: { roles: [] }, composition: null }), []);
  assert.deepEqual(findOrphanMembers({ schema: {}, composition: { members: [{ role: 'Spouse' }] } }), [{ role: 'Spouse', label: 'Spouse', count: 1 }]);
});

// ─── Cockpit per-member grouping: summariseDocuments.byMember ────────────────────
test('summariseDocuments: byMember groups per applicant, Principal Applicant first', () => {
  const items = [
    { id: '1', name: 'Passport', category: 'Identity', status: 'Received', applicantType: 'Dependent Child 1' },
    { id: '2', name: 'Passport', category: 'Identity', status: 'Missing',  applicantType: 'Principal Applicant' },
    { id: '3', name: 'Photo',    category: 'Identity', status: 'Reviewed', applicantType: 'Spouse' },
    { id: '4', name: 'IELTS',    category: 'Academic', status: 'Missing',  applicantType: 'Principal Applicant' },
  ];
  const { byMember, byCategory } = summariseDocuments(items);
  assert.equal(byMember[0].member, 'Principal Applicant', 'PA sorts first');
  const members = byMember.map((m) => m.member);
  assert.deepEqual(members, ['Principal Applicant', 'Dependent Child 1', 'Spouse'], 'PA first, then alpha');
  // PA has 2 docs across categories
  const pa = byMember.find((m) => m.member === 'Principal Applicant');
  const paCount = pa.categories.reduce((a, c) => a + c.items.length, 0);
  assert.equal(paCount, 2);
  // byCategory still exists (Overview strip / back-compat)
  assert.ok(byCategory.some((c) => c.category === 'Identity'));
});

test('summariseDocuments: single-applicant case yields one member block', () => {
  const items = [
    { id: '1', name: 'Passport', category: 'Identity', status: 'Received', applicantType: 'Principal Applicant' },
    { id: '2', name: 'IELTS',    category: 'Academic', status: 'Missing',  applicantType: 'Principal Applicant' },
  ];
  const { byMember } = summariseDocuments(items);
  assert.equal(byMember.length, 1, 'one member block → renderer shows flat, no member header');
  assert.equal(byMember[0].member, 'Principal Applicant');
});

test('summariseDocuments: blank applicantType defaults to Principal Applicant', () => {
  const { byMember } = summariseDocuments([{ id: '1', name: 'X', category: 'Other', status: 'Missing' }]);
  assert.equal(byMember[0].member, 'Principal Applicant');
});

// ─── Questionnaire: formEmbedsMembers (spousal F10 must NOT split per-member) ────
test('formEmbedsMembers: true only for spousal sponsorship (embeds both spouses in F10)', () => {
  assert.equal(formEmbedsMembers('Inland Spousal Sponsorship', 'Marriage'), true);
  assert.equal(formEmbedsMembers('Outland Spousal Sponsorship', ''), true);
  assert.equal(formEmbedsMembers('TRV', ''), false, 'TRV can split per-member from the board');
  assert.equal(formEmbedsMembers('Study Permit', 'Non SDS - Accompanying Spouse or Child'), false);
});

test('resolveMemberTypes: member-less case types return [] (the board-aware fallback path)', () => {
  assert.deepEqual(resolveMemberTypes('TRV', ''), []);
  assert.deepEqual(resolveMemberTypes('USA Visa', ''), []);
  assert.ok(resolveMemberTypes('Study Permit', 'Non SDS - Accompanying Spouse or Child').length > 0);
});
