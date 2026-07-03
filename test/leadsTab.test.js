'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildIntakeSections } = require('../src/services/consultantPortalService');

function section(out, title) {
  return out.sections.find((s) => s.title === title) || null;
}
function rowVal(sec, label) {
  const r = (sec && sec.rows.find((x) => x.label === label)) || null;
  return r ? r.value : undefined;
}

test('buildIntakeSections: archive answers win, lead columns fall back', () => {
  const out = buildIntakeSections(
    { fullName: 'Archive Name', email: 'a@x.com' },
    { fullName: 'Lead Name', phone: '416-555-0000' }
  );
  const basic = section(out, 'Basic information');
  assert.equal(rowVal(basic, 'Full legal name'), 'Archive Name');
  assert.equal(rowVal(basic, 'Email'), 'a@x.com');
  assert.equal(rowVal(basic, 'Phone'), '416-555-0000'); // lead fallback
});

test('buildIntakeSections: empty rows dropped, empty sections omitted', () => {
  const out = buildIntakeSections({ email: 'only@x.com' }, {});
  const basic = section(out, 'Basic information');
  assert.ok(basic);
  assert.deepEqual(basic.rows.map((r) => r.label), ['Email']);
  assert.equal(section(out, 'Relationship with TDOT'), null);
  assert.equal(section(out, 'Urgency screening'), null);
});

test('buildIntakeSections: country derives Canada when inside', () => {
  const inside  = buildIntakeSections({ insideCanada: 'Yes' }, {});
  const outside = buildIntakeSections({ insideCanada: 'No', currentCountry: 'India' }, {});
  assert.equal(rowVal(section(inside, 'Basic information'), 'Country'), 'Canada');
  assert.equal(rowVal(section(outside, 'Basic information'), 'Country'), 'India');
});

test('buildIntakeSections: family gating — accompanying rows only when relevant', () => {
  const out = buildIntakeSections({ hasSpouse: 'No', childrenCount: '0', childrenAccompanying: 'All', spouseAccompanying: 'Yes' }, {});
  const fam = section(out, 'Family members');
  assert.equal(rowVal(fam, 'Spouse accompanying'), undefined, 'no spouse ⇒ no accompanying row');
  assert.equal(rowVal(fam, 'Children accompanying'), undefined, '0 children ⇒ no accompanying row');
});

test('buildIntakeSections: F-block answers use human labels with prettified fallback', () => {
  const out = buildIntakeSections({ f1_crsScore: '480', f1_hasIta: 'Yes', f2_someNewField: 'x' }, {});
  const fb = section(out, 'Service-specific answers');
  assert.equal(rowVal(fb, 'CRS score'), '480');
  assert.equal(rowVal(fb, 'Received an ITA?'), 'Yes');
  assert.equal(rowVal(fb, 'Some new field'), 'x'); // unknown key prettified
});

test('buildIntakeSections: urgency flags + composed refusal/deadline rows', () => {
  const out = buildIntakeSections({
    removalOrder: 'Yes', enforcementLetter: 'No',
    urgentDeadline: 'Yes', deadlineDate: '2026-08-01', deadlineReason: 'Court date',
    recentRefusal: 'Yes', refusalType: 'Study Permit', refusalDate: '2025-12-01',
  }, {});
  assert.deepEqual(out.flags, ['Removal / enforcement order', 'Urgent deadline']);
  const u = section(out, 'Urgency screening');
  assert.equal(rowVal(u, 'Urgent deadline'), '2026-08-01 — Court date');
  assert.equal(rowVal(u, 'Recent refusal'), 'Study Permit — 2025-12-01');
  assert.equal(rowVal(u, 'Removal / enforcement order'), 'Yes');
});

test('buildIntakeSections: no archive at all → sections from lead columns alone', () => {
  const out = buildIntakeSections({}, {
    fullName: 'Lead Only', email: 'l@x.com', insideCanada: 'Yes',
    currentStatus: 'Visitor', hasSpouse: 'Yes', childrenCount: '2',
    serviceRequired: 'Study Permit', situationDescription: 'Wants to study',
    howHeard: 'Google', deadlineDate: '2026-09-01',
  });
  assert.equal(rowVal(section(out, 'Basic information'), 'Full legal name'), 'Lead Only');
  assert.equal(rowVal(section(out, 'Current immigration status'), 'Status'), 'Visitor');
  assert.equal(rowVal(section(out, 'Service required'), 'Service'), 'Study Permit');
  assert.equal(rowVal(section(out, 'Source'), 'How they heard about TDOT'), 'Google');
  assert.deepEqual(out.flags, ['Urgent deadline']); // deadlineDate on the lead column
});

test('buildIntakeSections: nested objects (education rows etc.) never leak into values', () => {
  const out = buildIntakeSections({ email: 'x@y.com', education: [{ school: 'U of T' }] }, {});
  for (const s of out.sections) {
    for (const r of s.rows) assert.equal(typeof r.value, 'string');
  }
});
