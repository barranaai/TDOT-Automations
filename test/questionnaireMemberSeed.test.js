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

test('a FAILED board read is not memoised as "no members": the next load (a writer seeding through loadMembers) sees the real family', async () => {
  install();
  boardComposition.members = [
    { role: 'DependentChild', name: 'Child 1 (from intake)', memberKey: 'child-1', flags: {} },
    { role: 'DependentChild', name: 'Child 2 (from intake)', memberKey: 'child-2', flags: {} },
  ];
  const healthy = compositionAdapter.readForCase;
  compositionAdapter.readForCase = async () => { throw new Error('Monday down'); };
  const caseRef = nextRef();
  const first = await svc.loadMembers({ clientName: 'X', caseRef });   // the cockpit page load, during the outage
  assert.equal(first.length, 1);
  assert.equal(uploads.length, 0);

  compositionAdapter.readForCase = healthy;                             // Monday is back within the minute
  const second = await svc.loadMembers({ clientName: 'X', caseRef });  // the staff send's loadMembers
  assert.deepEqual(second.map((m) => m.key), ['primary', 'child-1', 'child-2'], 'the outage was not remembered as an empty board');
  assert.equal(adapterCalls, 1, 'the healthy read happened');
  assert.equal(uploads.length, 1, 'seeded and persisted with the children');
  // and a manifest member added now keeps the children
  manifestBuf = Buffer.from(JSON.stringify(uploads[0].json));
  const added = await svc.addMember({ clientName: 'X', caseRef, memberType: 'Sponsor', label: 'Faheem Khan' });
  assert.equal(added.key, 'sponsor');
  assert.deepEqual(uploads[1].json.members.map((m) => m.key), ['primary', 'child-1', 'child-2', 'sponsor']);
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

// ─── Sponsor onboarding (2026-09-24) ─────────────────────────────────────────

test('a Sponsor board row seeds a Sponsor manifest member with the row name as its label', async () => {
  install();
  boardComposition.members = [
    { role: 'Sponsor', name: 'Faheem Khan', memberKey: 'sponsor', flags: {} },
  ];
  const members = await svc.loadMembers({ clientName: 'X', caseRef: nextRef() });
  assert.equal(members.length, 2);
  assert.equal(members[0].key, 'primary');
  const sp = members[1];
  assert.equal(sp.key, 'sponsor');
  assert.equal(sp.type, 'Sponsor');
  assert.equal(sp.label, 'Faheem Khan');
  assert.equal(sp.source, 'family-board');
  assert.equal(uploads.length, 1);
});

test('readMembersManifest: null when the file is absent — never seeds, never writes', async () => {
  install();
  boardComposition.members = [{ role: 'Spouse', name: 'Sunita', memberKey: 'spouse', flags: {} }];
  const r = await svc.readMembersManifest({ clientName: 'X', caseRef: nextRef() });
  assert.equal(r, null);
  assert.equal(adapterCalls, 0, 'the board is not consulted');
  assert.equal(uploads.length, 0);
});

test('readMembersManifest: the members when the file exists; an empty file reads as null', async () => {
  install();
  manifestBuf = Buffer.from(JSON.stringify({ members: [{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }] }));
  const r = await svc.readMembersManifest({ clientName: 'X', caseRef: nextRef() });
  assert.deepEqual(r.map((m) => m.key), ['primary']);
  manifestBuf = Buffer.from(JSON.stringify({ members: [] }));
  assert.equal(await svc.readMembersManifest({ clientName: 'X', caseRef: nextRef() }), null);
  assert.equal(uploads.length, 0);
});

test('readMembersManifest: a read failure THROWS with transient=true (an outage is not "no manifest")', async () => {
  install();
  oneDrive.readFile = async () => { throw new Error('Graph 503'); };
  await assert.rejects(svc.readMembersManifest({ clientName: 'X', caseRef: nextRef() }), (e) => e.transient === true && /Graph 503/.test(e.message));
  assert.equal(uploads.length, 0);
});

test('addMember: an explicit label is honoured; without one the generic label applies; a second Sponsor throws', async () => {
  install();
  manifestBuf = Buffer.from(JSON.stringify({ members: [{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }] }));
  const caseRef = nextRef();
  const a = await svc.addMember({ clientName: 'X', caseRef, memberType: 'Sponsor', label: '  Faheem Khan ' });
  assert.equal(a.key, 'sponsor');
  assert.equal(a.type, 'Sponsor');
  assert.equal(a.label, 'Faheem Khan');
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].json.members.map((m) => m.label), ['Primary Applicant', 'Faheem Khan']);

  const b = await svc.addMember({ clientName: 'X', caseRef: nextRef(), memberType: 'Sponsor' });
  assert.equal(b.label, 'Sponsor');
  const c = await svc.addMember({ clientName: 'X', caseRef: nextRef(), memberType: 'Sponsor', label: '   ' });
  assert.equal(c.label, 'Sponsor', 'a blank label falls back to the generic one');

  manifestBuf = Buffer.from(JSON.stringify(uploads[0].json));
  await assert.rejects(svc.addMember({ clientName: 'X', caseRef, memberType: 'Sponsor', label: 'Again' }), /A Sponsor has already been added/);
});
