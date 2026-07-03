'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildIntakeSections, validateAction } = require('../src/services/consultantPortalService');

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

// ─── Invite-message actions ───────────────────────────────────────────────────

test('validateAction bookingInvite: null = leave draft untouched; string = normalized message', () => {
  assert.deepEqual(validateAction('bookingInvite', undefined), { ok: true, normalized: null });
  assert.deepEqual(validateAction('bookingInvite', null), { ok: true, normalized: null });
  assert.deepEqual(validateAction('bookingInvite', '  Hi there  '), { ok: true, normalized: 'Hi there' });
  assert.deepEqual(validateAction('bookingInvite', ''), { ok: true, normalized: '' }); // explicit clear
  const long = validateAction('bookingInvite', 'x'.repeat(2001));
  assert.equal(long.ok, false);
});

test('validateAction saveInviteMessage: trims, caps at 2000 chars', () => {
  assert.deepEqual(validateAction('saveInviteMessage', ' A short pitch. '), { ok: true, normalized: 'A short pitch.' });
  assert.deepEqual(validateAction('saveInviteMessage', undefined), { ok: true, normalized: '' });
  assert.equal(validateAction('saveInviteMessage', 'y'.repeat(2001)).ok, false);
});

test('validateAction: non-string invite payloads are rejected (never email "[object Object]")', () => {
  assert.equal(validateAction('bookingInvite', {}).ok, false);
  assert.equal(validateAction('bookingInvite', 42).ok, false);
  assert.equal(validateAction('saveInviteMessage', ['x']).ok, false);
});

// ─── applyAction wiring (stubbed I/O) — covers the send/save paths end to end ─

const { applyAction } = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

async function withStubs(fn) {
  const writes = [];
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Stub Lead', retainerSent: '' })),
    stub(leadService, 'updateLead', async (id, fields, opts) => { writes.push({ fields, opts }); }),
    stub(mondayApi, 'query', async () => ({})), // postPortalNote audit note
  ];
  try { return await fn(writes); } finally { restore.forEach((r) => r()); }
}

test('applyAction saveInviteMessage: saves the draft (clearKeys so an empty save truly clears)', async () => {
  await withStubs(async (writes) => {
    const r = await applyAction({ leadId: '1', action: 'saveInviteMessage', value: ' Custom pitch ' });
    assert.equal(r.ok, true);
    assert.deepEqual(writes[0].fields, { inviteMessage: 'Custom pitch' });
    assert.deepEqual(writes[0].opts, { clearKeys: ['inviteMessage'] });

    writes.length = 0;
    await applyAction({ leadId: '1', action: 'saveInviteMessage', value: '' });
    assert.deepEqual(writes[0].fields, { inviteMessage: '' }, 'explicit clear reaches Monday');
    assert.deepEqual(writes[0].opts, { clearKeys: ['inviteMessage'] });
  });
});

test('applyAction bookingInvite: message saved FIRST, then the Send trigger; null leaves the draft alone', async () => {
  await withStubs(async (writes) => {
    const r = await applyAction({ leadId: '1', action: 'bookingInvite', value: 'Personal pitch' });
    assert.equal(r.ok, true);
    assert.deepEqual(writes.map((w) => w.fields), [
      { inviteMessage: 'Personal pitch' },
      { bookingInvite: 'Send' },
    ], 'message write precedes the Send trigger');

    writes.length = 0;
    await applyAction({ leadId: '1', action: 'bookingInvite' }); // consultations-page button: no value
    assert.deepEqual(writes.map((w) => w.fields), [{ bookingInvite: 'Send' }], 'no value ⇒ saved draft untouched');

    writes.length = 0;
    await applyAction({ leadId: '1', action: 'bookingInvite', value: '' }); // explicitly cleared textarea
    assert.deepEqual(writes.map((w) => w.fields), [
      { inviteMessage: '' },
      { bookingInvite: 'Send' },
    ], 'explicit clear writes through before sending (standard intro will be used)');
  });
});
