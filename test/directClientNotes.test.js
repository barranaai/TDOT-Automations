'use strict';

// The new direct-retainer popup has a Notes field (Faran 2026-10-28): what staff
// type there is saved as an update on the client's lead row AND on their case
// (Client Master) in Monday — once, with the signed-in name, line breaks kept,
// escaped. A re-submit never posts it twice. No network: stubs only.

const test = require('node:test');
const assert = require('node:assert/strict');

const portal = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi = require('../src/services/mondayApi');
const registry = require('../src/services/caseTypeRegistryService');
const blacklist = require('../src/services/blacklistService');
const handoff = require('../src/services/handoffService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');
const CASE_TYPE = CASE_TYPE_LABELS.find((t) => !(SUB_TYPES_BY_CASE[t] || []).length);
const CONSULTANT = Object.values(require('../config/consultantRouting').CONSULTANTS)[0].name;
const BODY = { fullName: 'Walkin Client', email: 'walkin@example.com', phone: '+1 416 555 0100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT };

function world({ caseId = '555', existingUpdates = [], reusable = null, failOn = null } = {}) {
  const posts = [];
  const restore = [
    stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
    stub(blacklist, 'check', async () => ({ checked: true, hit: false })),
    stub(leadService, 'findAllByColumnValue', async () => (reusable ? [reusable] : [])),
    stub(portal, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] })),
    stub(leadService, 'createLead', async (f) => ({ id: '900', ...f })),
    stub(leadService, 'updateLead', async () => {}),
    stub(handoff, 'openCaseEarly', async () => caseId),
    stub(mondayApi, 'query', async (q, v) => {
      if (/create_update/.test(q)) { if (failOn && v.id === failOn) throw new Error('Monday 503'); posts.push({ id: v.id, b: v.b }); return { create_update: { id: 'u' } }; }
      if (/updates\(limit:30\)/.test(q)) return { items: [{ updates: existingUpdates }] };
      return {};
    }),
  ];
  return { posts, done: () => restore.reverse().forEach((r) => r()) };
}
const noteBodies = (w) => w.posts.filter((p) => /\[Note/.test(p.b));

test('the note lands on the client\'s lead row AND on the case, after the "created" note, with the signed-in name', async () => {
  const w = world();
  try {
    const r = await portal.createDirectClient({ ...BODY, notes: '  Needs a study permit extension.\r\nBrings passport Monday. <b>urgent</b>  ' },
      { actor: { name: 'Gauri Sharma', verified: true } });
    assert.equal(r.notesSaved, 2);
    const n = noteBodies(w);
    assert.deepEqual(n.map((p) => p.id), ['900', '555'], 'lead row, then the case');
    assert.equal(n[0].b, '📝 <b>[Note · Gauri Sharma]</b> Needs a study permit extension.<br>Brings passport Monday. &lt;b&gt;urgent&lt;/b&gt;');
    assert.equal(n[1].b, n[0].b);
    const created = w.posts.findIndex((p) => /Direct retainer client created/.test(p.b));
    assert.ok(created >= 0 && created < w.posts.indexOf(n[0]), 'after the "created" note');
  } finally { w.done(); }
});

test('no notes typed → nothing extra posted; no sign-in → no name; no case yet → the lead row only', async () => {
  let w = world();
  try {
    const r = await portal.createDirectClient({ ...BODY, notes: '   ' });
    assert.equal(r.notesSaved, 0);
    assert.equal(noteBodies(w).length, 0);
  } finally { w.done(); }
  w = world({ caseId: '' });
  try {
    await portal.createDirectClient({ ...BODY, notes: 'Walk-in, referred by a friend.' }, { actor: { name: 'Shared key', verified: false } });
    assert.deepEqual(noteBodies(w).map((p) => [p.id, p.b]), [['900', '📝 <b>[Note]</b> Walk-in, referred by a friend.']]);
  } finally { w.done(); }
});

test('a re-submit (lost response, double click) never posts the note twice', async () => {
  const w = world({ reusable: { id: '777', fullName: 'Walkin Client', email: 'walkin@example.com', sourceChannel: 'Direct Retainer', confirmedCaseType: CASE_TYPE, clientMasterItemId: '556' },
    existingUpdates: [{ text_body: '📝 [Note · Gauri Sharma] Needs a study permit extension. Brings passport Monday.' }] });
  try {
    const r = await portal.createDirectClient({ ...BODY, notes: 'Needs a study permit extension.\nBrings passport Monday.' }, { actor: { name: 'Gauri Sharma', verified: true } });
    assert.equal(r.reused, true);
    assert.equal(r.notesSaved, 0);
    assert.equal(noteBodies(w).length, 0);
  } finally { w.done(); }
  // the reused client WITHOUT the note yet (the first submit died before posting) → posted now, on its case too
  const w2 = world({ reusable: { id: '777', fullName: 'Walkin Client', email: 'walkin@example.com', sourceChannel: 'Direct Retainer', confirmedCaseType: CASE_TYPE, clientMasterItemId: '556' } });
  try {
    await portal.createDirectClient({ ...BODY, notes: 'Needs a study permit extension.' });
    assert.deepEqual(noteBodies(w2).map((p) => p.id), ['777', '556']);
  } finally { w2.done(); }
});

test('linking an existing lead posts the note on that lead and its new case', async () => {
  const w = world({ caseId: '558' });
  const r1 = stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Walkin Client', email: 'walkin@example.com', sourceChannel: 'Phone' }));
  try {
    const r = await portal.createDirectClient({ ...BODY, linkLeadId: '300', notes: 'Converted from a phone lead.' });
    assert.equal(r.linked, true);
    assert.deepEqual(noteBodies(w).map((p) => p.id), ['300', '558']);
  } finally { r1(); w.done(); }
});

test('a note that fails on the case never undoes the client (best-effort)', async () => {
  const w = world({ failOn: '555' });
  const warn = console.warn; console.warn = () => {};
  try {
    const r = await portal.createDirectClient({ ...BODY, notes: 'x' });
    assert.equal(r.ok, true); assert.equal(r.leadId, '900'); assert.equal(r.notesSaved, 1);
  } finally { console.warn = warn; w.done(); }
});

test('the popup: a Notes box (optional), cleared on open, sent with the form; the route passes the signed-in person', () => {
  const html = require('../src/routes/adminConsultation').buildQueueHTML ? require('../src/routes/adminConsultation').buildQueueHTML() : require('fs').readFileSync(require.resolve('../src/routes/adminConsultation'), 'utf8');
  for (const x of ['<label for="dc-notes">Notes', '<textarea id="dc-notes" rows="3" maxlength="2000"', "'dc-referred','dc-notes'].forEach(", "notes:dcEl('dc-notes').value"]) assert.ok(html.includes(x), x);
  const server = require('fs').readFileSync(require.resolve('../src/server'), 'utf8');
  assert.ok(server.includes("createDirectClient(req.body || {}, { actor: staffActor(req, '') })"));
});
