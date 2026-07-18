'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const access = require('../src/services/caseAccessService');

// People-column values: Monday stores `{ personsAndTeams: [{id, kind}] }` per column.
function peopleCol(...entries) {
  return JSON.stringify({ personsAndTeams: entries });
}

test('assigneesFromColumnValues: collects person + team ids across all 7 people columns', () => {
  const vals = {
    'multiple_person_mm0xhmgk': peopleCol({ id: 101, kind: 'person' }),          // Case Manager
    'multiple_person_mm0xgpt':  peopleCol({ id: 202, kind: 'person' }),          // Stage Owner
    'multiple_person_mm2nhsx1': peopleCol({ id: 900, kind: 'team' }),            // Submission Team (a TEAM)
    'multiple_person_mm0xrzve': peopleCol({ id: 303, kind: 'person' }),          // Override Approved By
    'irrelevant_col':           peopleCol({ id: 999, kind: 'person' }),          // not a people column → ignored
  };
  const a = access.assigneesFromColumnValues(vals);
  assert.deepEqual(a.personIds.sort(), ['101', '202', '303']);
  assert.deepEqual(a.teamIds, ['900']);
  assert.ok(!a.personIds.includes('999'), 'non-people columns are ignored');
});

test('assigneesFromColumnValues: tolerates empty/blank/garbage values', () => {
  const a = access.assigneesFromColumnValues({
    'multiple_person_mm0xhmgk': '',
    'multiple_person_mm0xgpt':  'not json',
    'multiple_person_mm0xp0sq': JSON.stringify({}),
  });
  assert.deepEqual(a.personIds, []);
  assert.deepEqual(a.teamIds, []);
});

test('viewerCanSee: person match', () => {
  const assignees = { personIds: ['101', '202'], teamIds: [] };
  assert.equal(access.viewerCanSee(assignees, { userId: '202', teamIds: [] }), true);
  assert.equal(access.viewerCanSee(assignees, { userId: '303', teamIds: [] }), false);
});

test('viewerCanSee: team match (member of an assigned team)', () => {
  const assignees = { personIds: ['101'], teamIds: ['900'] };
  assert.equal(access.viewerCanSee(assignees, { userId: '55', teamIds: ['900', '901'] }), true, 'belongs to assigned team 900');
  assert.equal(access.viewerCanSee(assignees, { userId: '55', teamIds: ['902'] }), false, 'not in any assigned team');
});

test('viewerCanSee: admin always sees; empty assignees never match a non-admin', () => {
  assert.equal(access.viewerCanSee({ personIds: [], teamIds: [] }, { userId: '1', teamIds: [], isAdmin: true }), true);
  assert.equal(access.viewerCanSee({ personIds: [], teamIds: [] }, { userId: '1', teamIds: [] }), false);
  assert.equal(access.viewerCanSee(undefined, { userId: '1', teamIds: [] }), false);
  assert.equal(access.viewerCanSee({ personIds: ['1'] }, null), false, 'no viewer → no access');
});

test('isAdminEmail + viewerFromStaff: allowlist drives isAdmin (case-insensitive)', () => {
  const saved = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'Owner@tdotimm.com, boss@tdotimm.com';
  try {
    assert.equal(access.isAdminEmail('owner@tdotimm.com'), true);
    assert.equal(access.isAdminEmail('staff@tdotimm.com'), false);
    const v = access.viewerFromStaff({ id: 77, name: 'Owner', email: 'owner@tdotimm.com', teamIds: ['5'] });
    assert.equal(v.userId, '77');
    assert.deepEqual(v.teamIds, ['5']);
    assert.equal(v.isAdmin, true);
    const s = access.viewerFromStaff({ id: 88, name: 'Staff', email: 'staff@tdotimm.com', teamIds: [] });
    assert.equal(s.isAdmin, false);
  } finally { if (saved === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = saved; }
});
