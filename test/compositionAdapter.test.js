'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { mapRowsToComposition } = require('../src/services/compositionAdapter');

test('maps member types to roles and derives spouseIncluded', () => {
  const comp = mapRowsToComposition([
    { memberType: 'Principal Applicant', flagsText: '',             name: 'Ramesh', memberKey: 'primary' },
    { memberType: 'Spouse',              flagsText: 'Name Changed', name: 'Sunita', memberKey: 'spouse'  },
    { memberType: 'Sponsor',             flagsText: '',             name: 'Arjun',  memberKey: 'sponsor' },
  ]);

  assert.equal(comp.members.length, 3);
  assert.deepEqual(comp.members.map((m) => m.role), ['PrincipalApplicant', 'Spouse', 'Sponsor']);
  assert.equal(comp.caseFlags.spouseIncluded, true);
  assert.equal(comp.caseFlags.childrenIncluded, false);
});

test('passes through per-member DOB / status / residence (for questionnaire pre-fill)', () => {
  const comp = mapRowsToComposition([
    { memberType: 'Spouse', flagsText: '', name: 'Sunita', memberKey: 'spouse',
      dateOfBirth: '1990-05-01', currentStatus: 'Worker', countryOfResidence: 'Canada' },
  ]);
  const m = comp.members[0];
  assert.equal(m.dateOfBirth, '1990-05-01');
  assert.equal(m.currentStatus, 'Worker');
  assert.equal(m.countryOfResidence, 'Canada');
});

test('parses multi-value Flags into memberFlag keys', () => {
  const comp = mapRowsToComposition([
    { memberType: 'Spouse', flagsText: 'Name Changed, Common-Law', name: 'X', memberKey: 'spouse' },
  ]);
  assert.deepEqual(comp.members[0].flags, { nameChanged: true, commonLaw: true });
});

test('no spouse row → spouseIncluded false', () => {
  const comp = mapRowsToComposition([
    { memberType: 'Principal Applicant', flagsText: '', name: 'Ramesh', memberKey: 'primary' },
    { memberType: 'Sponsor',             flagsText: '', name: 'Arjun',  memberKey: 'sponsor' },
  ]);
  assert.equal(comp.caseFlags.spouseIncluded, false);
});

test('blank / unmapped Member Type rows are skipped', () => {
  const comp = mapRowsToComposition([
    { memberType: '',         flagsText: '', name: 'Empty',   memberKey: '' },
    { memberType: 'Roommate', flagsText: '', name: 'Unknown', memberKey: '' },
    { memberType: 'Sponsor',  flagsText: '', name: 'Arjun',   memberKey: 'sponsor' },
  ]);
  assert.equal(comp.members.length, 1);
  assert.equal(comp.members[0].role, 'Sponsor');
});

test('unknown flag labels are ignored, known ones kept', () => {
  const comp = mapRowsToComposition([
    { memberType: 'Spouse', flagsText: 'Name Changed, Mystery Flag', name: 'X', memberKey: 'spouse' },
  ]);
  assert.deepEqual(comp.members[0].flags, { nameChanged: true });
});

test('handles empty input', () => {
  const comp = mapRowsToComposition([]);
  assert.deepEqual(comp.members, []);
  assert.equal(comp.caseFlags.spouseIncluded, false);
});
