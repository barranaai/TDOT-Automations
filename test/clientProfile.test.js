'use strict';

// Cross-application profile reuse (client accounts Phase 4). The rules protect
// legal documents: identity carries, slow circumstance carries as a CANDIDATE,
// volatile status is never carried, refusal history is display-only, and
// mining never re-reads its own prefill seed.

const test   = require('node:test');
const assert = require('node:assert/strict');

const profile = require('../src/services/clientProfileService');
const map     = require('../config/questionnairePrefillMap');

// ─── mineQuestionnaireProfile ────────────────────────────────────────────────

test('mining: identity labels are extracted, first occurrence wins (spouse block ignored)', () => {
  const got = profile.mineQuestionnaireProfile([
    { section: 'Personal', label: 'Family Name (Surname)', key: 'k1', value: 'Doe' },
    { section: 'Personal', label: 'Given Name', key: 'k2', value: 'Jane' },
    { section: 'Personal', label: 'Email Address', key: 'k3', value: 'jane@x.com' },
    { section: 'Spouse', label: 'Family Name (Surname)', key: 'k9', value: 'OtherName' }, // second occurrence
    { section: 'Personal', label: 'Current Residential Address', key: 'k4', value: '9 New St, Toronto' },
  ]);
  assert.equal(got.surname, 'Doe', 'first occurrence, never the spouse block');
  assert.equal(got.fullName, 'Jane Doe');
  assert.equal(got.email, 'jane@x.com');
  assert.equal(got.address, '9 New St, Toronto');
});

test('mining: prefill-tagged entries are SKIPPED — no circular laundering', () => {
  const got = profile.mineQuestionnaireProfile([
    { section: 'Pre-filled from intake', label: 'Email Address', key: 'prefill__email-address', value: 'stale@x.com', source: 'prefill' },
    { section: 'Personal', label: 'Email Address', key: 'real', value: 'current@x.com' },
    { section: 'Pre-filled from intake', label: 'Phone Number', key: 'prefill__phone-number', value: '000', source: 'prefill' },
  ]);
  assert.equal(got.email, 'current@x.com', 'the client-typed answer wins');
  assert.equal(got.phone, undefined, 'a prefill-only value never surfaces');
});

test('mining: VOLATILE fields (status in country) are never extracted', () => {
  const got = profile.mineQuestionnaireProfile([
    { label: 'Status in Current Country', key: 'k', value: 'Visitor' },
    { label: 'Status in Current Country (Visitor, Student, Worker, Citizen)', key: 'k2', value: 'Worker' },
    { label: 'Date of Refusal', key: 'k3', value: '2024-01-01' },
  ]);
  assert.deepEqual(got, {}, 'volatile + ratchet labels are not in REUSE_LABELS');
});

// ─── mergeProfileSources ─────────────────────────────────────────────────────

test('merge: latest savedAt wins; alternatives recorded; stale flagged after 12 months', () => {
  const { identity, fieldMeta } = profile.mergeProfileSources([
    { origin: 'questionnaire', savedAt: '2024-05-01T00:00:00Z', caseRef: 'R1', data: { address: '1 Old St' } },
    { origin: 'lead', savedAt: null, caseRef: 'R1', data: { address: '2 Newer St', email: 'a@x.com' } },
  ], { now: '2026-08-04T00:00:00Z' });
  assert.equal(identity.address, '1 Old St', 'timestamped source beats untimestamped');
  assert.equal(fieldMeta.address.stale, true, 'saved 2024 → stale by 2026');
  assert.equal(fieldMeta.address.alternatives.length, 1);
  assert.equal(identity.email, 'a@x.com', 'untimestamped fills fields the timestamped source lacks');
});

test('merge: with no timestamps anywhere, priority order decides', () => {
  const { identity } = profile.mergeProfileSources([
    { origin: 'lead', savedAt: null, data: { phone: '111' } },
    { origin: 'intake', savedAt: null, data: { phone: '222' } },
  ]);
  assert.equal(identity.phone, '111');
});

// ─── buildPrimaryFieldsFromProfile ───────────────────────────────────────────

test('profile pairs: only REUSE labels, previous-application section, name split', () => {
  const pairs = map.buildPrimaryFieldsFromProfile({
    fullName: 'Jane Anne Doe', email: 'j@x.com', address: '9 New St',
    maritalStatus: 'Married',
  });
  const byLabel = Object.fromEntries(pairs.map((p) => [p.label, p]));
  assert.equal(byLabel['Family Name (Surname)'].value, 'Doe');
  assert.equal(byLabel['Given Name'].value, 'Jane Anne');
  assert.equal(byLabel['Email Address'].value, 'j@x.com');
  assert.equal(byLabel['Current Marital Status'].value, 'Married');
  assert.ok(pairs.every((p) => /previous application/.test(p.section)), 'every pair carries the review section');
  assert.ok(!byLabel['Status in Current Country'], 'volatile labels can never be emitted');
});

// ─── createDirectClient: profileSourceCaseRef carry ──────────────────────────

test('createDirectClient: previousCaseRef stamped and the family roster carried as the retainer draft', async () => {
  const portal       = require('../src/services/consultantPortalService');
  const leadService  = require('../src/services/leadService');
  const mondayApi    = require('../src/services/mondayApi');
  const registry     = require('../src/services/caseTypeRegistryService');
  const handoff      = require('../src/services/handoffService');
  const compAdapter  = require('../src/services/compositionAdapter');
  const clientMaster = require('../src/services/clientMasterService');
  const accounts     = require('../src/services/clientAccountService');
  const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');
  const CASE_TYPE = CASE_TYPE_LABELS.find((ct) => !(SUB_TYPES_BY_CASE[ct] || []).length);

  function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
  const updates = [];
  const restore = [
    stub(registry, 'getCaseTypes', async () => { throw new Error('offline'); }),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(clientMaster, 'findCasesByEmail', async () => []),
    stub(clientMaster, 'findCasesByPhone', async () => []),
    stub(accounts, 'findMatches', async () => []),
    stub(leadService, 'createLead', async () => ({ id: '950' })),
    stub(leadService, 'updateLead', async (id, f) => { updates.push({ id, f }); }),
    stub(handoff, 'openCaseEarly', async () => 'CM-950'),
    stub(mondayApi, 'query', async () => ({})),
    stub(compAdapter, 'readForCase', async () => ({ members: [
      { role: 'PrincipalApplicant', name: 'Jane Doe', dateOfBirth: '1990-01-01' },
      { role: 'Spouse', name: 'John Doe', dateOfBirth: '1988-02-02', currentStatus: 'Visitor', countryOfResidence: 'Canada' },
      { role: 'Sponsor', name: 'Host Person', dateOfBirth: '' },
    ] })),
  ];
  try {
    const r = await portal.createDirectClient({
      fullName: 'Jane Doe', email: 'jane-new-app@x.com', phone: '4165550100',
      residentialAddress: '9 New St, Toronto', caseType: CASE_TYPE,
      consultant: 'Shermin Teymouri Mofrad', profileSourceCaseRef: '2026-VV-100',
    });
    assert.equal(r.ok, true);
    const w = updates.find((u) => u.id === '950' && u.f.previousCaseRef);
    assert.equal(w.f.previousCaseRef, '2026-VV-100');
    const fam = JSON.parse(w.f.retainerFamilyMembers);
    assert.equal(fam.length, 2, 'PA excluded; spouse + sponsor carried');
    const spouse = fam.find((m) => m.type === 'Spouse');
    assert.equal(spouse.name, 'John Doe');
    assert.equal(spouse.accompanying, true);
    assert.equal(fam.find((m) => m.type === 'Sponsor').accompanying, false, 'sponsors are already in Canada');
  } finally { restore.forEach((x) => x()); }
});

// ─── seedQuestionnairePrefill: previous-application source ───────────────────

test('prefill: current-case answers WIN; previous application fills only missing labels, in its own section', async () => {
  const htmlQ    = require('../src/services/htmlQuestionnaireService');
  const oneDrive = require('../src/services/oneDriveService');
  const leadSvc  = require('../src/services/leadService');
  const comp     = require('../src/services/compositionAdapter');
  const mondayApi = require('../src/services/mondayApi');

  function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
  let written = null;
  const restore = [
    stub(oneDrive, 'ensureClientFolder', async () => {}),
    stub(oneDrive, 'uploadFile', async ({ buffer }) => { written = JSON.parse(buffer.toString('utf8')); }),
    stub(oneDrive, 'readFile', async ({ subfolder, filename }) => {
      if (subfolder === 'Intake' && filename === 'intake-submission.json') {
        return Buffer.from(JSON.stringify({ fields: { fullName: 'Jane Doe', email: 'current@x.com' } }));
      }
      return null; // no pre-consult, empty questionnaire target
    }),
    stub(comp, 'readForCase', async () => ({ members: [] })),
    stub(leadSvc, 'findByColumnValue', async () => ({ id: '600', previousCaseRef: '2026-VV-100' })),
    stub(require('../src/services/clientProfileService'), 'gatherReusableProfile', async ({ sourceCaseRef }) => {
      assert.equal(sourceCaseRef, '2026-VV-100');
      return { identity: { email: 'old-stale@x.com', address: '1 Old St', maritalStatus: 'Married' }, fieldMeta: {}, family: [], priorFacts: {}, sourcedFrom: {} };
    }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await htmlQ.seedQuestionnairePrefill({
      clientName: 'Jane Doe', caseRef: 'TDOT-NEW', caseType: 'Citizenship', clientMasterItemId: '900',
    });
    assert.equal(r.ok, true);
    const byLabel = Object.fromEntries(written.fields.map((f) => [f.label, f]));
    assert.equal(byLabel['Email Address'].value, 'current@x.com', 'fresh intake beats the previous application');
    assert.equal(byLabel['Email Address'].section, 'Pre-filled from intake');
    assert.equal(byLabel['Current Residential Address'].value, '1 Old St', 'previous app fills the missing label');
    assert.match(byLabel['Current Residential Address'].section, /previous application/);
    assert.equal(byLabel['Current Marital Status'].value, 'Married');
    assert.equal(written.completionPct, 0, 'seeding never unlocks submit');
    assert.ok(written.fields.every((f) => f.source === 'prefill'));
  } finally { restore.forEach((x) => x()); }
});

// ─── Review-earned rails (2026-08-04): wrong-person carry prevention ─────────

test('mining: OTHER-PARTY sections are skipped — the sponsor\'s address is never the client\'s', () => {
  const got = profile.mineQuestionnaireProfile([
    // F10 spousal form shape: the only 'Residential Address' is the SPONSOR's.
    { section: "Sponsor's Details", label: 'Residential Address', key: 'k1', value: '55 Sponsor St, Toronto' },
    { section: 'Provide details for each dependent child', label: 'Family Name (Surname)', key: 'k2', value: 'ChildName' },
    { section: 'Personal Details', label: 'Email Address', key: 'k3', value: 'pa@x.com' },
  ]);
  assert.equal(got.address, undefined, 'sponsor-section address never mined');
  assert.equal(got.surname, undefined, 'child-section name never mined');
  assert.equal(got.email, 'pa@x.com', 'applicant-section fields still mine');
});

test('emission: Date of Birth is NEVER emitted; address emits only the applicant-anchored label', () => {
  const pairs = map.buildPrimaryFieldsFromProfile({ fullName: 'Jane Doe', dob: '1990-01-01', address: '9 New St' });
  const labels = pairs.map((p) => p.label);
  assert.ok(!labels.includes('Date of Birth'), 'bare DOB labels belong to child blocks in live forms');
  assert.ok(labels.includes('Current Residential Address'));
  assert.ok(!labels.includes('Residential Address'), 'the bare alias is the sponsor\'s field on F10');
});
