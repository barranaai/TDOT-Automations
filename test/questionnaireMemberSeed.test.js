'use strict';

// Tests for seedMembersFromBoard / loadMembers board-seeding in
// htmlQuestionnaireService: when a case has no questionnaire member manifest,
// the family recorded on the Family Members board is carried over so the
// client's first questionnaire visit shows every member.
//
// Monday + OneDrive are stubbed by patching the shared module objects the
// service holds references to (same resolved modules, so property patches
// take effect regardless of require order).

const test   = require('node:test');
const assert = require('node:assert/strict');

const oneDrive           = require('../src/services/oneDriveService');
const compositionAdapter = require('../src/services/compositionAdapter');
const svc                = require('../src/services/htmlQuestionnaireService');

// ── stubs ────────────────────────────────────────────────────────────────────
let uploads;       // captured saveMembers writes
let manifestBuf;   // what readFile returns (null = no manifest on OneDrive)
let adapterCalls;
let boardComposition;

function install() {
  uploads = [];
  manifestBuf = null;
  adapterCalls = 0;
  boardComposition = { caseFlags: {}, members: [] };

  oneDrive.readFile           = async () => manifestBuf;
  oneDrive.ensureClientFolder = async () => {};
  oneDrive.uploadFile         = async ({ filename, buffer }) => {
    uploads.push({ filename, json: JSON.parse(buffer.toString('utf8')) });
  };
  compositionAdapter.readForCase = async () => {
    adapterCalls += 1;
    return boardComposition;
  };
}

// Each test uses a distinct caseRef — the service memoizes seed results per
// caseRef for 60s, so reuse would leak state across tests.
let refSeq = 0;
const nextRef = () => `2026-TEST-${String(++refSeq).padStart(3, '0')}`;

// ── tests ────────────────────────────────────────────────────────────────────

test('seeds spouse + child from board with intake keys and placeholder-free labels', async () => {
  install();
  boardComposition.members = [
    { role: 'Spouse',         name: 'Spouse (from intake)',  memberKey: 'spouse',  flags: {} },
    { role: 'DependentChild', name: 'Child 1 (from intake)', memberKey: 'child-1', flags: {} },
  ];

  const caseRef = nextRef();
  const members = await svc.loadMembers({ clientName: 'Barrana Test', caseRef });

  assert.deepEqual(members.map((m) => m.key), ['primary', 'spouse', 'child-1']);
  assert.deepEqual(members.map((m) => m.type), [
    'Principal Applicant', 'Spouse / Common-Law Partner', 'Dependent Child',
  ]);
  // placeholder row names must not become labels
  assert.deepEqual(members.slice(1).map((m) => m.label), ['Spouse', 'Child']);

  // manifest persisted once, to the right file
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].filename, `questionnaire-members-${caseRef}.json`);
  assert.equal(uploads[0].json.members.length, 3);
});

test('uses real board row names as labels', async () => {
  install();
  boardComposition.members = [
    { role: 'Spouse',         name: 'Sunita Sharma', memberKey: 'spouse',  flags: {} },
    { role: 'DependentChild', name: 'Aarav Sharma',  memberKey: 'child-1', flags: {} },
  ];

  const members = await svc.loadMembers({ clientName: 'X', caseRef: nextRef() });
  assert.deepEqual(members.slice(1).map((m) => m.label), ['Sunita Sharma', 'Aarav Sharma']);
});

test('PrincipalApplicant board row is not duplicated into the manifest', async () => {
  install();
  boardComposition.members = [
    { role: 'PrincipalApplicant', name: 'Barrana Test', memberKey: 'primary', flags: {} },
    { role: 'Spouse',             name: '',             memberKey: 'spouse',  flags: {} },
  ];

  const members = await svc.loadMembers({ clientName: 'X', caseRef: nextRef() });
  assert.deepEqual(members.map((m) => m.key), ['primary', 'spouse']);
});

test('empty board → primary-only default, nothing persisted', async () => {
  install();

  const members = await svc.loadMembers({ clientName: 'X', caseRef: nextRef() });
  assert.equal(members.length, 1);
  assert.equal(members[0].key, 'primary');
  assert.equal(uploads.length, 0);
});

test('adapter failure → primary-only default, nothing persisted', async () => {
  install();
  compositionAdapter.readForCase = async () => { throw new Error('Monday down'); };

  const members = await svc.loadMembers({ clientName: 'X', caseRef: nextRef() });
  assert.equal(members.length, 1);
  assert.equal(uploads.length, 0);
});

test('malformed or colliding board keys fall back to generated keys', async () => {
  install();
  boardComposition.members = [
    { role: 'Spouse',         name: '', memberKey: 'PRIMARY!!',  flags: {} }, // malformed
    { role: 'DependentChild', name: '', memberKey: 'child-1',    flags: {} },
    { role: 'DependentChild', name: '', memberKey: 'child-1',    flags: {} }, // collision
  ];

  const members = await svc.loadMembers({ clientName: 'X', caseRef: nextRef() });
  assert.deepEqual(members.map((m) => m.key), ['primary', 'spouse', 'child-1', 'child-2']);
});

test('existing manifest wins — board is not consulted', async () => {
  install();
  manifestBuf = Buffer.from(JSON.stringify({
    members: [{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }],
  }));
  boardComposition.members = [
    { role: 'Spouse', name: '', memberKey: 'spouse', flags: {} },
  ];

  const members = await svc.loadMembers({ clientName: 'X', caseRef: nextRef() });
  assert.equal(members.length, 1);
  assert.equal(adapterCalls, 0);
  assert.equal(uploads.length, 0);
});

test('seed result is memoized — repeated loads hit Monday once', async () => {
  install();
  boardComposition.members = [
    { role: 'Spouse', name: '', memberKey: 'spouse', flags: {} },
  ];

  const caseRef = nextRef();
  await svc.loadMembers({ clientName: 'X', caseRef });
  await svc.loadMembers({ clientName: 'X', caseRef }); // manifest still "missing" (stub)
  assert.equal(adapterCalls, 1);
});
