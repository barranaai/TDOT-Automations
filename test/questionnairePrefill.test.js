'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const map = require('../config/questionnairePrefillMap');

// ─── Pure mapping: principal applicant ────────────────────────────────────────

function byLabel(pairs) {
  const m = {};
  for (const p of pairs) m[p.label] = p.value;
  return m;
}

test('splitName: last token is surname, rest is given', () => {
  assert.deepEqual(map.splitName('John Michael Doe'), { surname: 'Doe', given: 'John Michael' });
  assert.deepEqual(map.splitName('Cher'), { surname: 'Cher', given: '' });
  assert.deepEqual(map.splitName('  '), { surname: '', given: '' });
});

test('buildPrimaryFields: maps the strong contact/status/family fields', () => {
  const pairs = map.buildPrimaryFields({
    intake: {
      fullName: 'John Michael Doe', email: 'j@x.com', phone: '416-555-1212',
      residentialAddress: '1 King St, Toronto', currentStatus: 'Visitor',
      childrenCount: '2', hasSpouse: 'Yes', currentCountry: 'India',
    },
    lead: { insideCanada: 'Yes' },
  });
  const v = byLabel(pairs);
  assert.equal(v['Family Name (Surname)'], 'Doe');
  assert.equal(v['Given Name'], 'John Michael');
  assert.equal(v['Email Address'], 'j@x.com');
  assert.equal(v['Phone Number'], '416-555-1212');
  assert.equal(v['Mobile Number'], '416-555-1212');   // alt label emitted too
  assert.equal(v['Current Residential Address'], '1 King St, Toronto');
  assert.equal(v['Current Residence Country'], 'Canada'); // insideCanada=Yes ⇒ Canada
  assert.equal(v['Status in Current Country'], 'Visitor');
  assert.equal(v['Do you have dependent children?'], 'Yes'); // count>0
  assert.equal(v['Do you have an accompanying spouse?'], 'Yes');
});

test('buildPrimaryFields: residence country falls back to stated country when outside Canada', () => {
  const v = byLabel(map.buildPrimaryFields({ intake: { currentCountry: 'India' }, lead: { insideCanada: 'No' } }));
  assert.equal(v['Current Residence Country'], 'India');
});

test('buildPrimaryFields: dependent children = No when count is 0', () => {
  const v = byLabel(map.buildPrimaryFields({ intake: { childrenCount: '0' } }));
  assert.equal(v['Do you have dependent children?'], 'No');
});

test('buildPrimaryFields: refusal detail — explicit No suppresses, Yes/bare-date surfaces', () => {
  const no = byLabel(map.buildPrimaryFields({ intake: { recentRefusal: 'No', refusalDate: '2023-01-01', refusalType: 'Study Permit' } }));
  assert.equal(no['Date of Refusal'], undefined, 'an explicit No suppresses a lingering date');

  const yes = byLabel(map.buildPrimaryFields({ intake: { recentRefusal: 'Yes', refusalDate: '2023-01-01', refusalType: 'Study Permit' } }));
  assert.equal(yes['Date of Refusal'], '2023-01-01');
  assert.equal(yes['Visa Type'], 'Study Permit');

  // F9 / Lost-PR-Card sets a refusal date without the recentRefusal flag.
  const dateOnly = byLabel(map.buildPrimaryFields({ intake: { refusalDate: '2022-06-01' } }));
  assert.equal(dateOnly['Date of Refusal'], '2022-06-01', 'a bare refusal date is inferred as a refusal');
});

test('buildPrimaryFields: status emits BOTH the bare and the parenthetical (F6 select) labels', () => {
  const pairs = map.buildPrimaryFields({ intake: { currentStatus: 'Worker' } });
  const v = byLabel(pairs);
  assert.equal(v['Status in Current Country'], 'Worker');
  assert.equal(v['Status in Current Country (Visitor, Student, Worker, Citizen)'], 'Worker');
  // dead label dropped
  assert.equal(v['Current Immigration Status'], undefined);
});

test('buildPrimaryFields: marital "Separated / Divorced" normalises to a form option', () => {
  assert.equal(byLabel(map.buildPrimaryFields({ preConsult: { pc_marital: 'Separated / Divorced' } }))['Current Marital Status'], 'Separated');
  assert.equal(byLabel(map.buildPrimaryFields({ preConsult: { pc_marital: 'Married' } }))['Current Marital Status'], 'Married');
});

test('buildPrimaryFields: children fills both the Yes/No radio and the "How Many?" free-text variant', () => {
  const two = byLabel(map.buildPrimaryFields({ intake: { childrenCount: '2' } }));
  assert.equal(two['Do you have dependent children?'], 'Yes');
  assert.equal(two['Do you have dependent children? How Many?'], 'Yes - 2');
  const none = byLabel(map.buildPrimaryFields({ intake: { childrenCount: '0' } }));
  assert.equal(none['Do you have dependent children? How Many?'], 'No');
});

test('buildPrimaryFields: never emits blank values', () => {
  const pairs = map.buildPrimaryFields({ intake: { email: 'only@x.com' }, lead: {} });
  assert.ok(pairs.every(p => p.value && p.value.trim()), 'every emitted value is non-empty');
  const v = byLabel(pairs);
  assert.equal(v['Email Address'], 'only@x.com');
  assert.equal(v['Given Name'], undefined);
});

test('buildPrimaryFields: embedded spouse fields use a real spouse name only', () => {
  const real = byLabel(map.buildPrimaryFields({ intake: {}, spouse: { name: 'Sunita Sharma' } }));
  assert.equal(real["Spouse's Family Name"], 'Sharma');
  assert.equal(real["Spouse's Given Name"], 'Sunita');

  const placeholder = byLabel(map.buildPrimaryFields({ intake: {}, spouse: { name: 'Spouse (from intake)' } }));
  assert.equal(placeholder["Spouse's Family Name"], undefined, 'placeholder name is not seeded');
});

test('source precedence: intake archive overrides lead columns', () => {
  const v = byLabel(map.buildPrimaryFields({ intake: { email: 'archive@x.com' }, lead: { email: 'lead@x.com' } }));
  assert.equal(v['Email Address'], 'archive@x.com');
});

// ─── Pure mapping: family members ─────────────────────────────────────────────

test('buildMemberFields: splits a real member name, skips placeholders', () => {
  assert.deepEqual(byLabel(map.buildMemberFields({ name: 'Sunita Sharma' })), {
    'Family Name (Surname)': 'Sharma', 'Given Name': 'Sunita',
  });
  assert.deepEqual(map.buildMemberFields({ name: 'Child 1 (from intake)' }), []);
  assert.deepEqual(map.buildMemberFields({ name: 'Spouse' }), []);
});

test('buildMemberFields: uses board DOB/status/residence when present (future-proofing)', () => {
  const v = byLabel(map.buildMemberFields({ name: 'A B', dateOfBirth: '1990-05-01', currentStatus: 'Worker', countryOfResidence: 'India' }));
  assert.equal(v['Date of Birth'], '1990-05-01');
  assert.equal(v['Status in Current Country'], 'Worker');
  assert.equal(v['Current Residence Country'], 'India');
});

// ─── Seed I/O: the never-overwrite gate + a clean write ───────────────────────
// Monkeypatch the OneDrive + composition layers so no network is touched.

const oneDrive = require('../src/services/oneDriveService');
const composition = require('../src/services/compositionAdapter');
const svc = require('../src/services/htmlQuestionnaireService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

test('seedQuestionnairePrefill: NEVER overwrites a form that already has data', async () => {
  let uploads = 0;
  const restore = [
    stub(oneDrive, 'ensureClientFolder', async () => {}),
    stub(oneDrive, 'uploadFile', async () => { uploads++; }),
    stub(composition, 'readForCase', async () => ({ members: [] })),
    // loadFormData reads the Questionnaire subfolder → return EXISTING data.
    stub(oneDrive, 'readFile', async ({ subfolder }) => {
      if (subfolder === 'Questionnaire') return Buffer.from(JSON.stringify({ fields: [{ label: 'Email Address', value: 'client@typed.com' }], completionPct: 40 }));
      if (subfolder === 'Intake') return Buffer.from(JSON.stringify({ fields: { email: 'archive@x.com' } }));
      return null;
    }),
  ];
  try {
    const r = await svc.seedQuestionnairePrefill({ clientName: 'Test Client', caseRef: 'TDOT-1', caseType: 'Study Permit', clientMasterItemId: null });
    assert.equal(r.ok, true);
    assert.equal(r.seeded, 0, 'nothing seeded because the form already had data');
    assert.equal(uploads, 0, 'saveFormData/uploadFile must NOT be called when data exists');
  } finally {
    restore.forEach(fn => fn());
  }
});

test('seedQuestionnairePrefill: writes prefill fields (completionPct 0, source tag) into an empty form', async () => {
  let written = null;
  const restore = [
    stub(oneDrive, 'ensureClientFolder', async () => {}),
    stub(oneDrive, 'uploadFile', async ({ formKey, buffer }) => { written = { formKey, json: JSON.parse(buffer.toString('utf8')) }; }),
    stub(composition, 'readForCase', async () => ({ members: [] })),
    stub(oneDrive, 'readFile', async ({ subfolder, filename }) => {
      if (subfolder === 'Questionnaire') return null; // empty ⇒ seed proceeds
      if (subfolder === 'Intake' && filename === 'intake-submission.json') {
        return Buffer.from(JSON.stringify({ fields: {
          fullName: 'John Doe', email: 'j@x.com', phone: '416-555-1212', currentStatus: 'Visitor',
        } }));
      }
      return null;
    }),
  ];
  try {
    const r = await svc.seedQuestionnairePrefill({ clientName: 'Test Client', caseRef: 'TDOT-2', caseType: 'Study Permit', clientMasterItemId: null });
    assert.equal(r.ok, true);
    assert.ok(r.seeded > 0, 'seeded at least one field');
    assert.ok(written, 'uploadFile was called');
    assert.equal(written.json.completionPct, 0, 'progress stays at 0 so submit is not auto-unlocked');
    const emailField = written.json.fields.find(f => f.label === 'Email Address');
    assert.ok(emailField, 'Email Address seeded');
    assert.equal(emailField.value, 'j@x.com');
    assert.equal(emailField.source, 'prefill', 'field is tagged as pre-filled');
    assert.ok(written.json.fields.every(f => f.value && f.value.trim()), 'no blank fields written');
  } finally {
    restore.forEach(fn => fn());
  }
});

test('seedQuestionnairePrefill: unknown case type with no form is a safe no-op', async () => {
  const r = await svc.seedQuestionnairePrefill({ clientName: 'X', caseRef: 'TDOT-3', caseType: 'Totally Unknown Type', clientMasterItemId: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-form');
});
