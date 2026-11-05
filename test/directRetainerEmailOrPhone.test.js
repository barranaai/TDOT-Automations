'use strict';

// The Direct retainer form (Faran 2026-11-04, team meeting point 1 part 2):
//  - an email OR a phone (either one) — a phone-only walk-in still gets a case;
//  - staff see a "No email" caution, and the retainer refuses BEFORE changing anything;
//  - the address is optional — but an agreement that prints it is never sent with a blank;
//  - Source / Reference (+ who referred them) and a note are required;
//  - attachments: Shafoli only, signed in with Monday, into the client's folder by id.
// No network: stubs only.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');

const portal = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi = require('../src/services/mondayApi');
const registry = require('../src/services/caseTypeRegistryService');
const blacklist = require('../src/services/blacklistService');
const handoff = require('../src/services/handoffService');
const clientMaster = require('../src/services/clientMasterService');
const accounts = require('../src/services/clientAccountService');
const retainer = require('../src/services/retainerService2');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');
const CASE_TYPE = CASE_TYPE_LABELS.find((t) => !(SUB_TYPES_BY_CASE[t] || []).length);
const CONSULTANT = Object.values(require('../config/consultantRouting').CONSULTANTS)[0].name;
const PHONE_ONLY = { fullName: 'Phone Only', email: '', phone: '416 555 0123', residentialAddress: '', caseType: CASE_TYPE, consultant: CONSULTANT, sourceChannel: 'Employee Referral', referredBy: 'Gauri Berde', notes: 'Needs a study permit — quoted $1,800.' };

function createWorld({ caseId = 'CM-1', byPhone = [] } = {}) {
  const calls = { created: [], updates: [], notes: [], lookups: [] };
  const restore = [
    stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
    stub(blacklist, 'check', async () => ({ checked: true, hit: false })),
    stub(leadService, 'findAllByColumnValue', async (k, v) => { calls.lookups.push([k, v]); return k === 'phone' ? byPhone : []; }),
    stub(portal, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] })),
    stub(leadService, 'createLead', async (f) => { calls.created.push(f); return { id: '900' }; }),
    stub(leadService, 'updateLead', async (id, f) => { calls.updates.push({ id, f }); }),
    stub(handoff, 'openCaseEarly', async () => caseId),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) calls.notes.push({ id: v.id, b: v.b }); if (/updates\(limit:30\)/.test(q)) return { items: [{ updates: [] }] }; return {}; }),
  ];
  return { calls, done: () => restore.reverse().forEach((r) => r()) };
}

test('a phone-only walk-in is created (no email, no address): the real source in Source / Reference, the "Direct Retainer Client" marker, the referrer; a "No email yet" line in the note', async () => {
  const w = createWorld();
  try {
    const r = await portal.createDirectClient(PHONE_ONLY);
    assert.equal(r.ok, true); assert.equal(r.caseOpened, true);
    assert.equal(w.calls.created[0].email, '', 'no email written');
    assert.equal(w.calls.created[0].sourceChannel, 'Employee Referral', 'one Source / Reference column holds the real source');
    assert.equal(w.calls.created[0].directClient, 'Yes', 'the marker is set AT creation');
    assert.equal(w.calls.created[0].referredBy, 'Gauri Berde');
    const wiring = w.calls.updates.find((u) => u.id === '900').f;
    assert.equal(wiring.sourceChannel, 'Employee Referral'); assert.equal(wiring.directClient, 'Yes');
    assert.equal(wiring.referredBy, 'Gauri Berde');
    assert.equal(wiring.residentialAddress, '', 'blank — buildCols skips it, nothing is cleared');
    const created = w.calls.notes.find((n) => /Direct retainer client created/.test(n.b)).b;
    assert.match(created, /Source \/ reference: Employee Referral · Referred by: Gauri Berde/);
    assert.match(created, /No email address yet<\/b> — the retainer agreement is sent by email/);
    assert.match(created, /No residential address yet/);
    assert.ok(w.calls.notes.some((n) => /\[Note/.test(n.b) && /quoted \$1,800/.test(n.b)), 'the required note is posted');
    // double-submit protection without an email: the reuse scan reads the phone forms
    assert.ok(w.calls.lookups.length && w.calls.lookups.every((l) => l[0] === 'phone'), 'no email lookup with a blank email');
    assert.ok(w.calls.lookups.some((l) => l[1] === '4165550123') && w.calls.lookups.some((l) => l[1] === '14165550123'));
  } finally { w.done(); }
});

test('phone-only double submit: the un-retained direct lead with the same phone + name is REUSED (no second client)', async () => {
  const w = createWorld({ byPhone: [{ id: '777', fullName: 'Phone Only', sourceChannel: 'Direct Retainer', retainerSent: '' }] });
  try {
    const r = await portal.createDirectClient(PHONE_ONLY);
    assert.equal(r.reused, true); assert.equal(r.leadId, '777');
    assert.equal(w.calls.created.length, 0);
  } finally { w.done(); }
});

test('the case-open failure note no longer promises "no action needed"', async () => {
  const restore = [];
  const w = createWorld();
  restore.push(stub(handoff, 'openCaseEarly', async () => { throw new Error('Lead 900 missing required field(s) for handoff: fullName'); }));
  const err = console.error; console.error = () => {};
  try {
    await portal.createDirectClient(PHONE_ONLY);
    const n = w.calls.notes.find((x) => /could not be opened yet/.test(x.b)).b;
    assert.ok(!/no action needed/.test(n));
    assert.match(n, /tries again when the retainer is signed/);
  } finally { console.error = err; restore.forEach((r) => r()); w.done(); }
});

test('handoff: a case opens with a phone only (email column left out); the same person is found by phone + name; neither → refused', async () => {
  process.env.MONDAY_CM_HANDOFF_GROUP_ID = 'gtest';
  const run = async (lead, { phoneHits = [] } = {}) => {
    const calls = [];
    const restore = [
      stub(leadService, 'getLead', async () => ({ id: '800', fullName: 'Phone Only', clientMasterItemId: '', confirmedCaseType: CASE_TYPE, oneDriveFolderId: 'F1', ...lead })),
      stub(leadService, 'updateLead', async () => {}),
      stub(clientMaster, 'findCasesByPhone', async (p) => { calls.push({ phoneLookup: p }); return phoneHits; }),
      stub(mondayApi, 'query', async (q, v) => {
        calls.push({ q, v });
        if (/create_item/.test(q)) return { create_item: { id: 'CM-NEW' } };
        if (/updates\(/.test(q)) return { items: [{ updates: [] }] };
        if (/column_values\(ids/.test(q)) return { items: [{ column_values: [] }] };
        return {};
      }),
      stub(registry, 'isCanonicalCaseType', async () => true),
    ];
    try { return { id: await handoff.openCaseEarly({ leadId: '800' }), calls }; } finally { restore.reverse().forEach((r) => r()); }
  };
  const a = await run({ email: '', phone: '4165550123' });
  assert.equal(a.id, 'CM-NEW');
  const create = a.calls.find((c) => c.q && /create_item/.test(c.q) && /item_name/.test(c.q));
  assert.ok(!JSON.parse(create.v.cols).text_mm0xw6bp && !('text_mm0xw6bp' in JSON.parse(create.v.cols)), 'no empty email written on the case');
  assert.ok(a.calls.some((c) => c.phoneLookup === '4165550123'), 'the same-person check used the phone');
  const b = await run({ email: '', phone: '4165550123' }, { phoneHits: [{ id: 'CM-OLD', name: 'phone  only', caseStage: 'Pre-Onboarding', paymentStatus: '', caseType: '' }, { id: 'CM-X', name: 'Someone Else' }] });
  assert.equal(b.id, 'CM-OLD', 'same phone + same name = the same person (lost-link recovery)');
  await assert.rejects(run({ email: '', phone: '' }), /missing required field\(s\) for handoff: email or phone/);
  assert.equal(await handoff.findClientMasterSamePerson({ email: '', phone: '4165550123', fullName: '' }), null, 'no name → never guess');
});

test('client accounts: same phone + same name is the same person when there is NO email; with an email the email still decides', () => {
  const P = { email: '', phone: '+1 416 555 0123', fullName: 'Phone Only' };
  assert.equal(accounts.classifyMatch(P, { email: 'po@x.co', phone: '4165550123', name: 'phone only' }).confidence, 'exact');
  assert.equal(accounts.classifyMatch(P, { email: '', phone: '4165550123', name: 'Other Person' }).confidence, 'review', 'a shared phone under another name is never merged');
  assert.equal(accounts.classifyMatch({ ...P, dob: '1990-01-01' }, { email: '', phone: '4165550123', name: 'Phone Only', dob: '1960-01-01' }).confidence, 'review', 'conflicting dates of birth veto');
  assert.equal(accounts.classifyMatch({ ...P, email: 'mine@x.co' }, { email: 'other@x.co', phone: '4165550123', name: 'Phone Only' }).confidence, 'review', 'with an email, a phone-only match stays weak');
});

test('Retain & send: no email (or, on the real templates, no address) is refused BEFORE the Outcome changes or a PDF is built; a re-issue never voids the live agreement', async () => {
  const lead = { id: '1', fullName: 'Phone Only', email: '', phone: '4165550123', outcome: 'Follow-Up', confirmedCaseType: CASE_TYPE, retainerFee: '2500', retainerSent: '', conversionStatus: '', residentialAddress: '' };
  const writes = [], sends = [];
  const restore = [
    stub(leadService, 'getLead', async () => lead),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
    stub(retainer, 'maybeSendRetainerAgreement', async () => { sends.push(1); return { status: 'sent' }; }),
    stub(retainer, 'voidAndReissueRetainer', async () => { sends.push('void'); return { status: 'sent' }; }),
    stub(mondayApi, 'query', async () => ({})),
    stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
  ];
  try {
    await assert.rejects(portal.applyAction({ leadId: '1', action: 'retainAndSend', value: '' }), (e) => e.badRequest && /no email address for this client/.test(e.message) && /Nothing was changed/.test(e.message));
    assert.deepEqual(writes, [], 'the Outcome was NOT set'); assert.deepEqual(sends, [], 'nothing generated or sent');
    lead.retainerSent = '2026-11-01';
    await assert.rejects(portal.applyAction({ leadId: '1', action: 'reissueRetainer', value: '' }), (e) => e.badRequest && /was NOT voided/.test(e.message));
    assert.deepEqual(sends, [], 'the live agreement was not voided');
  } finally { restore.reverse().forEach((r) => r()); }
  // the blocker itself
  const old = process.env.RETAINER_ENGINE;
  try {
    process.env.RETAINER_ENGINE = 'v1';
    assert.equal(retainer.sendBlocker({ email: 'a@b.co', residentialAddress: '' }), '', 'v1 never prints the address');
    process.env.RETAINER_ENGINE = 'v2';
    assert.match(retainer.sendBlocker({ email: 'a@b.co', residentialAddress: '', confirmedCaseType: CASE_TYPE }), /residential address is missing/);
    assert.equal(retainer.sendBlocker({ email: 'a@b.co', residentialAddress: '1 Main St', confirmedCaseType: CASE_TYPE }), '');
    assert.equal(retainer.agreementPrintsAddress('employer'), false);
    assert.equal(retainer.agreementPrintsAddress('pa'), true);
  } finally { if (old === undefined) delete process.env.RETAINER_ENGINE; else process.env.RETAINER_ENGINE = old; }
});

test('the send path itself: no email → "no-email" BEFORE any v2 PDF is built (no conversion spent)', async () => {
  const old = process.env.RETAINER_ENGINE;
  process.env.RETAINER_ENGINE = 'v2';
  const notes = []; let generated = 0;
  const restore = [
    stub(leadService, 'getLead', async () => ({ id: '1', fullName: 'P', email: '', outcome: 'Retain', retainerFee: '2500', retainerSent: '', retainerSigned: '', conversionStatus: '', leadToken: 'T' })),
    stub(require('../src/services/retainerDocService'), 'generate', async () => { generated++; return Buffer.from('pdf'); }),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(v.body || v.b); return {}; }),
  ];
  const warn = console.warn; console.warn = () => {};
  try {
    const r = await retainer.maybeSendRetainerAgreement('1', { notifyIfMissing: true });
    assert.equal(r.status, 'no-email');
    assert.equal(generated, 0, 'no PDF was built');
  } finally { console.warn = warn; restore.reverse().forEach((x) => x()); if (old === undefined) delete process.env.RETAINER_ENGINE; else process.env.RETAINER_ENGINE = old; }
});

test('payment notes say plainly when nothing was emailed', () => {
  const fs = require('fs');
  const pay = fs.readFileSync(require.resolve('../src/services/paymentService'), 'utf8');
  const ms = fs.readFileSync(require.resolve('../src/services/milestonePaymentService'), 'utf8');
  assert.ok(!pay.includes("(no email on lead)") && !ms.includes("(no email on lead)"), 'the old misleading "Emailed to (no email on lead)" is gone');
  assert.match(pay, /NOT emailed — there is no client email/);
  assert.match(ms, /NOT emailed — there is no client email/);
});

// ── the pages ────────────────────────────────────────────────────────────────

const scriptsOf = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

test('the walk-in form: Email and Phone (one of the two), optional address, Source / Reference picker, Notes *, the attach box; every script parses', () => {
  const html = require('../src/routes/adminConsultation').buildQueueHTML();
  for (const x of ['<label for="dc-email">Email</label>', '<label for="dc-phone">Phone</label>', 'An email <b>or</b> a phone number', '<label for="dc-address">Residential address <span class="dc-hint">(optional now',
    '<select id="dc-source"><option value="">— choose —</option>', 'id="dc-ref-emp"', 'id="dc-ref-cli"', '<label for="dc-notes">Notes *', 'id="dc-att-row" class="att-row" style="display:none"',
    "var DC_REF=tdotRef('dc');", "var DC_ATT=tdotAttach('dc');", 'sourceChannel:dcEl(\'dc-source\').value, referredBy:DC_REF.value(), referredFrom:DC_REF.from()',
    'DC_ATT.upload(res.j.leadId)']) assert.ok(html.includes(x), x);
  assert.ok(!html.includes('id="dc-referred"'), 'the old free-text Referred by box is gone');
  assert.ok(!html.includes('Name, email, phone, residential address, case type and consultant are required.'));
  for (const s of scriptsOf(html)) new vm.Script(s);
});

test('the consultation page: an amber "No email" box pointing to the lead page, and Retain & send greyed out with the reason', () => {
  const html = require('../src/routes/adminConsultation').buildDetailHTML ? require('../src/routes/adminConsultation').buildDetailHTML('123') : null;
  const src = html || require('fs').readFileSync(require.resolve('../src/routes/adminConsultation'), 'utf8');
  for (const x of ['<div id="email-warn"></div>', '<b>No email address on file.</b>', "rpNoEmail = !!(LAST_DETAIL && !String(LAST_DETAIL.email||'').trim())", 'RP_LOCKED || !RP_FEE_SET || !RP_PLAN_SAVED || rpNoEmail']) assert.ok(src.includes(x), x);
  if (html) for (const s of scriptsOf(html)) new vm.Script(s);
});

test('the lists: "No email" tags on Leads rows and on un-sent Retainers rows; a walk-in shows its source', () => {
  const leads = require('../src/routes/adminLeads').buildLeadsQueueHTML();
  assert.ok(leads.includes("var noEmail=(c.hasEmail===false)?' <span class=\"pill amber\""));
  const cons = require('../src/routes/adminConsultation').buildQueueHTML();
  assert.ok(cons.includes("((c.hasEmail===false && !c.retainerSent)?' <span class=\"pill amber\""));
  assert.ok(cons.includes("direct · '+escHtml(c.directSource)"));
});

test('the shared list copy keeps only "has an email: yes/no" — never the address', async () => {
  const snap = require('../src/services/leadSnapshot');
  const C = require('../src/data/newLeadsBoard.json').columns;
  snap._reset();
  const restore = [stub(mondayApi, 'query', async () => ({ boards: [{ items_page: { cursor: null, items: [
    { id: '1', name: 'A', created_at: '2026-11-01T00:00:00Z', column_values: [{ id: C.email, text: 'a@b.co', value: '{"email":"a@b.co","text":"a@b.co"}' }] },
    { id: '2', name: 'B', created_at: '2026-11-01T00:00:00Z', column_values: [] },
  ] } }] }))];
  try {
    const leads = await snap.leads();
    assert.deepEqual(leads.map((l) => [l.id, l.hasEmail, 'email' in l]), [['1', true, false], ['2', false, false]]);
    assert.ok(!JSON.stringify(leads).includes('a@b.co'));
  } finally { restore.forEach((r) => r()); snap._reset(); }
});

// ── attachments ──────────────────────────────────────────────────────────────

test('attachments: only the listed staff (Shafoli by default) — judged by the Monday sign-in email', () => {
  const rules = require('../config/staffAttachments');
  const old = process.env.STAFF_ATTACHMENT_EMAILS;
  try {
    delete process.env.STAFF_ATTACHMENT_EMAILS;
    assert.equal(rules.canAttach({ email: 'Shafoli@TDOTimm.com', name: 'Shafoli Kapur' }), true);
    assert.equal(rules.canAttach({ email: 'gauri@tdotimm.com' }), false);
    assert.equal(rules.canAttach(null), false, 'the shared key alone (no sign-in) is never enough');
    process.env.STAFF_ATTACHMENT_EMAILS = 'a@x.co, b@x.co';
    assert.equal(rules.canAttach({ email: 'b@x.co' }), true);
    assert.equal(rules.canAttach({ email: 'shafoli@tdotimm.com' }), false, 'the setting replaces the list');
  } finally { if (old === undefined) delete process.env.STAFF_ATTACHMENT_EMAILS; else process.env.STAFF_ATTACHMENT_EMAILS = old; }
  assert.equal(rules.extensionOf('Screen Shot.PNG'), '.png');
  assert.ok(!rules.EXTENSIONS['.exe'] && !rules.EXTENSIONS['.html'] && !rules.EXTENSIONS['.svg']);
});

test('attach: into the client folder BY ID ("Intake"), a dated name with who attached it, a note on the lead and the case; waits briefly for a brand-new folder, then refuses', async () => {
  const svc = require('../src/services/leadAttachmentService');
  const SHAF = { email: 'shafoli@tdotimm.com', name: 'Shafoli Kapur' };
  const file = { originalname: 'WhatsApp Image 2026.jpeg', buffer: Buffer.from('x'), size: 1 };
  const uploads = [], notes = []; let reads = 0;
  const orig = { ...svc.io };
  Object.assign(svc.io, {
    getLead: async () => { reads++; return { id: '900', oneDriveFolderId: reads >= 2 ? 'FOLDER-ID' : '', clientMasterItemId: 'CM-1' }; },
    upload: async (a) => { uploads.push(a); return { name: a.filename, url: 'https://org/link' }; },
    note: async (id, b) => { notes.push({ id, b }); },
    sleep: async () => {},
    now: () => new Date('2026-11-04T19:32:00Z'),
    caseFolderId: async () => '',          // the case row has no folder of its own here: the lead's is used
    ensureLeadFolder: async () => null,    // a no-case lead whose folder cannot be made right now
  });
  try {
    const r = await svc.attach({ leadId: '900', file, staff: SHAF });
    assert.equal(r.ok, true);
    assert.equal(uploads[0].folderId, 'FOLDER-ID'); assert.equal(uploads[0].subfolder, 'Intake');
    assert.equal(uploads[0].filename, '2026-11-04 1432 - Shafoli Kapur - WhatsApp Image 2026.jpeg');
    assert.deepEqual(notes.map((n) => n.id), ['900', 'CM-1']);
    assert.match(notes[0].b, /Attachment added by Shafoli Kapur<\/b>: <a href="https:\/\/org\/link">/);
    await assert.rejects(svc.attach({ leadId: '900', file, staff: { email: 'gauri@tdotimm.com' } }), (e) => e.forbidden);
    await assert.rejects(svc.attach({ leadId: '900', file: { ...file, originalname: 'x.exe' }, staff: SHAF }), (e) => e.badRequest && /Only pictures/.test(e.message));
    svc.io.getLead = async () => ({ id: '900', oneDriveFolderId: '', clientMasterItemId: '' });
    uploads.length = 0;
    await assert.rejects(svc.attach({ leadId: '900', file, staff: SHAF }), (e) => e.retry && /still being created/.test(e.message));
    assert.equal(uploads.length, 0, 'never resolved by name — nothing uploaded');
  } finally { Object.assign(svc.io, orig); }
});

test('the upload route: the Monday sign-in + allow-list gate runs BEFORE the upload slot and multer; the viewer says canAttach', () => {
  const server = require('fs').readFileSync(require.resolve('../src/server'), 'utf8');
  const i = server.indexOf("app.post('/api/leads/:leadId/attachments'");
  assert.ok(i > 0);
  const block = server.slice(i, i + 1600);
  assert.ok(block.indexOf('attachRules.canAttach(staff)') < block.indexOf('upl.uploadSlot'), 'gate first');
  assert.ok(block.indexOf('upl.uploadSlot') < block.indexOf('attachUpload(req, res'), 'then the slot, then multer');
  assert.match(server, /canAttach: require\('\.\.\/config\/staffAttachments'\)\.canAttach\(staff\)/);
});

test('attach box: no backslashes in the browser code (template-literal trap); hidden until the viewer says canAttach; on Add lead, the walk-in form and the lead page', () => {
  const { ATTACH_UI_JS } = require('../src/routes/attachUi');
  assert.ok(!ATTACH_UI_JS.includes('\\'), 'no backslash in the browser code');
  new vm.Script(ATTACH_UI_JS);
  assert.match(ATTACH_UI_JS, /allowed=!!\(v&&v\.canAttach\); if \(row\) row\.style\.display=allowed\?'':'none';/);
  const leads = require('../src/routes/adminLeads').buildLeadsQueueHTML();
  assert.ok(leads.includes('id="al-att-row"') && leads.includes("var AL_ATT=tdotAttach('al');") && leads.includes('AL_ATT.upload(res.j.leadId)'));
  for (const s of scriptsOf(leads)) new vm.Script(s);
});

// ── review round 1 (2026-11-04) ──────────────────────────────────────────────

test('one Source / Reference column (Faran 2026-11-04): "Walk-in" is a choice; the marker column is mapped; old and new direct clients are both recognised everywhere', () => {
  const C = require('../src/data/newLeadsBoard.json').columns;
  assert.equal(C.directClient, 'text_mm8smgwh', 'the "Direct Retainer Client" marker column');
  assert.ok(!('walkInSource' in C), 'no separate walk-in source column');
  assert.ok(require('../config/leadSources').LEAD_SOURCES.includes('Walk-in'));
  const { isDirectClient, shownSource } = require('../src/utils/directClient');
  assert.equal(isDirectClient({ sourceChannel: 'Walk-in', directClient: 'Yes' }), true, 'new: the marker');
  assert.equal(isDirectClient({ sourceChannel: 'Direct Retainer' }), true, 'old: the source label');
  assert.equal(isDirectClient({ sourceChannel: 'Walk-in' }), false, 'a Walk-in LEAD (Add lead) is a normal lead');
  assert.equal(shownSource({ sourceChannel: 'Direct Retainer' }), '');
  assert.equal(portal.classifyLead ? portal.classifyLead({ sourceChannel: 'Instagram', directClient: 'Yes' }) : 'retainer', 'retainer', 'a direct client is on Retainers, not Leads');
  // no service decides "direct" from the source label alone any more
  const fs = require('fs');
  for (const f of ['../src/services/kpiService', '../src/services/consultationService', '../src/services/retainerService2', '../src/services/bookingRemindersService', '../src/services/consultantPortalService']) {
    const src = fs.readFileSync(require.resolve(f), 'utf8');
    assert.ok(!/sourceChannel[^;\n]{0,40}===\s*(DIRECT_SOURCE|'Direct Retainer')/.test(src), f);
  }
  const snap = require('../src/services/leadSnapshot');
  assert.ok(snap.SNAPSHOT_KEYS.includes('directClient') && snap.SNAPSHOT_IDS.includes('text_mm8smgwh'));
});

test('review: an automatic onboarding start with no client email leaves a case note the Summary reads; a sent email leaves none', async () => {
  const email = require('../src/services/emailService');
  const notes = [];
  const restore = [stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(v); return {}; })];
  try {
    restore.push(stub(email, 'sendIntakeEmail', async () => ({ sent: false, to: '', caseRef: 'X', reason: 'This case has no client email on the Client Master row.' })));
    await email.sendIntakeEmailAuto('CM-7');
    assert.equal(notes.length, 1); assert.equal(notes[0].id, 'CM-7');
    assert.match(notes[0].b, /The client’s intake email did not go out/);
    assert.match(require('fs').readFileSync(require.resolve('../src/services/needsAttentionService'), 'utf8'), /intakeFailed:\s+\/The client.s intake email did not go out\/i/);
    restore.push(stub(email, 'sendIntakeEmail', async () => ({ sent: false, to: 'a@b.co', caseRef: '', reason: 'This case has no case reference yet.' })));
    await email.sendIntakeEmailAuto('CM-7');
    restore.push(stub(email, 'sendIntakeEmail', async () => ({ sent: true })));
    await email.sendIntakeEmailAuto('CM-7');
    assert.equal(notes.length, 1, 'only the no-email skip is noted');
  } finally { restore.reverse().forEach((r) => r()); }
  const fs = require('fs');
  for (const f of ['../src/routes/mondayWebhook', '../src/services/retainerService', '../src/services/caseRefService']) {
    const src = fs.readFileSync(require.resolve(f), 'utf8');
    assert.ok(src.includes('sendIntakeEmailAuto(') && !/emailService\.sendIntakeEmail\((pulseId|itemId)\)/.test(src), f);
  }
});

test('review: a phone-only case is created WITH its phone (the dedup key exists from the first moment); an odd phone never blocks the case', async () => {
  process.env.MONDAY_CM_HANDOFF_GROUP_ID = 'gtest';
  const run = async (failPhone) => {
    const creates = [];
    const restore = [
      stub(leadService, 'getLead', async () => ({ id: '800', fullName: 'Phone Only', email: '', phone: '4165550123', clientMasterItemId: '', confirmedCaseType: CASE_TYPE, oneDriveFolderId: 'F1' })),
      stub(leadService, 'updateLead', async () => {}),
      stub(clientMaster, 'findCasesByPhone', async () => []),
      stub(mondayApi, 'query', async (q, v) => {
        if (/create_item/.test(q) && /item_name/.test(q)) { const cols = JSON.parse(v.cols); creates.push(cols); if (failPhone && cols.phone_mm33zr0c) throw new Error('invalid phone'); return { create_item: { id: 'CM-NEW' } }; }
        if (/updates\(/.test(q)) return { items: [{ updates: [] }] };
        if (/column_values\(ids/.test(q)) return { items: [{ column_values: [] }] };
        return {};
      }),
      stub(registry, 'isCanonicalCaseType', async () => true),
    ];
    const warn = console.warn; console.warn = () => {};
    try { return { id: await handoff.openCaseEarly({ leadId: '800' }), creates }; } finally { console.warn = warn; restore.reverse().forEach((r) => r()); }
  };
  const a = await run(false);
  assert.deepEqual(a.creates[0].phone_mm33zr0c, { phone: '+14165550123', countryShortName: 'CA' });
  const b = await run(true);
  assert.equal(b.id, 'CM-NEW'); assert.equal(b.creates.length, 2); assert.ok(!b.creates[1].phone_mm33zr0c, 'retried without the phone');
});

test('review: an account made without an email is the same person when they come back with one (same phone + name)', () => {
  assert.equal(accounts.classifyMatch({ email: 'new@x.co', phone: '4165550123', fullName: 'Phone Only' }, { email: '', phone: '+14165550123', name: 'Phone Only' }).confidence, 'exact');
  assert.equal(accounts.classifyMatch({ email: 'new@x.co', phone: '4165550123', fullName: 'Phone Only' }, { email: 'old@x.co', phone: '4165550123', name: 'Phone Only' }).confidence, 'review', 'two different emails still need staff');
});

test('review: converting a lead with the Email box emptied is refused (the old email would silently stay and get the retainer); a kept address is noted', async () => {
  const run = async (existing, body) => {
    const notes = [];
    const restore = [
      stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
      stub(leadService, 'getLead', async () => ({ id: '300', fullName: 'Same Person', sourceChannel: 'Phone', clientMasterItemId: '', conversionStatus: '', retainerSent: '', ...existing })),
      stub(leadService, 'updateLead', async () => {}),
      stub(leadService, 'createLead', async () => { throw new Error('must not create'); }),
      stub(handoff, 'openCaseEarly', async () => 'CM-300'),
      stub(blacklist, 'check', async () => ({ checked: true, hit: false })),
      stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(v.b); return { items: [{ updates: [] }] }; }),
    ];
    try { await portal.createDirectClient({ ...PHONE_ONLY, fullName: 'Same Person', linkLeadId: '300', ...body }); return notes; } finally { restore.reverse().forEach((r) => r()); }
  };
  await assert.rejects(run({ email: 'old@x.co', phone: '4165550123' }, {}), (e) => e.badRequest && /already has the email old@x\.co/.test(e.message));
  const notes = await run({ email: '', phone: '4165550123', residentialAddress: '9 Old Rd, Toronto' }, {});
  assert.ok(notes.some((b) => /lead’s address was kept: “9 Old Rd, Toronto”/.test(b)));
});

test('review: payment toasts never claim an email went to a client with no email', async () => {
  const restore = [
    stub(leadService, 'getLead', async () => ({ id: '1', fullName: 'P', email: '', outcome: 'Retain', retainerFee: '2500', retainerSent: '2026-11-01', retainerSigned: '', conversionStatus: '' })),
    stub(require('../src/services/milestonePaymentService'), 'sendMilestoneEtransferRequest', async () => ({ ok: true, label: 'Milestone 1', reference: 'TDOT-1-1', emailed: false, etransferTo: 'pay@x.co' })),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await portal.applyAction({ leadId: '1', action: 'sendMilestoneEtransferRequest', value: '0' }).catch((e) => ({ message: e.message }));
    assert.match(r.message, /NOT emailed — there is no client email.*pay@x\.co.*TDOT-1-1/);
  } finally { restore.reverse().forEach((x) => x()); }
  const src = require('fs').readFileSync(require.resolve('../src/services/milestonePaymentService'), 'utf8');
  assert.match(src, /emailed = true;/); assert.match(src, /reference, emailed, etransferTo: ETRANSFER_EMAIL/);
});

test('review: attach uses the CASE folder when there is a case; no folder → make the lead folder (no case) or an admin message (case); a vanished folder says so', async () => {
  const svc = require('../src/services/leadAttachmentService');
  const SHAF = { email: 'shafoli@tdotimm.com', name: 'Shafoli Kapur' };
  const file = { originalname: 'a.png', buffer: Buffer.from('x'), size: 1 };
  const orig = { ...svc.io };
  const ups = [];
  try {
    Object.assign(svc.io, { sleep: async () => {}, note: async () => {}, upload: async (a) => { ups.push(a.folderId); return { name: 'a.png', url: 'u' }; },
      getLead: async () => ({ id: '9', oneDriveFolderId: 'LEAD-F', clientMasterItemId: 'CM-1' }), caseFolderId: async () => 'CASE-F', ensureLeadFolder: async () => { throw new Error('must not make a folder for a case'); } });
    await svc.attach({ leadId: '9', file, staff: SHAF });
    assert.equal(ups.pop(), 'CASE-F');
    svc.io.caseFolderId = async () => '';
    await svc.attach({ leadId: '9', file, staff: SHAF });
    assert.equal(ups.pop(), 'LEAD-F', 'the case has none: the lead folder');
    svc.io.getLead = async () => ({ id: '9', oneDriveFolderId: '', clientMasterItemId: 'CM-1' });
    await assert.rejects(svc.attach({ leadId: '9', file, staff: SHAF }), (e) => e.noFolder && /Case folder…/.test(e.message));
    svc.io.caseFolderId = async () => { throw new Error('Monday 503'); };
    await assert.rejects(svc.attach({ leadId: '9', file, staff: SHAF }), (e) => e.retry);
    svc.io.getLead = async () => ({ id: '9', fullName: 'N', oneDriveFolderId: '', clientMasterItemId: '' });
    svc.io.ensureLeadFolder = async () => ({ id: 'MADE-F' });
    await svc.attach({ leadId: '9', file, staff: SHAF });
    assert.equal(ups.pop(), 'MADE-F', 'no case: the lead folder is made / found now');
  } finally { Object.assign(svc.io, orig); }
  const od = require('fs').readFileSync(require.resolve('../src/services/oneDriveService'), 'utf8');
  assert.match(od, /if \(err\.response\?\.status === 404\) throw folderGone\(\);/);
});

test('review: the attach box re-asks who is signed in on each opening, never keeps a failed answer, and a retry sends only the files that failed', () => {
  const { ATTACH_UI_JS } = require('../src/routes/attachUi');
  assert.ok(!ATTACH_UI_JS.includes('\\'));
  assert.match(ATTACH_UI_JS, /if \(!v\) TDOT_ATT_VIEWER=null;/);
  assert.match(ATTACH_UI_JS, /refresh:function\(\)\{ TDOT_ATT_VIEWER=null;/);
  assert.match(ATTACH_UI_JS, /if \(r\.ok\)\{ out\.sent\+\+; myDone\[fkey\(f\)\]=1; \}/);
  // 2026-11-05: an upload belongs to the pick it started from — a reset (the form reopened for the next person) stops it writing into the form
  assert.ok(ATTACH_UI_JS.includes('var i=0, g=gen, myDone=done;') && ATTACH_UI_JS.includes('function say(t,cls){ if (g===gen) setStatus(t,cls); }'));
  assert.ok(ATTACH_UI_JS.includes('function reset(){ gen++; done={};'));
  assert.ok(ATTACH_UI_JS.includes("input.addEventListener('change',function(){ done={}; draw(); });"), 'a new pick on the same form never mutes the upload still running (only reset() does)');
  assert.ok(require('../src/routes/adminLeads').buildLeadDetailHTML('1').includes("else LA_ATT.setStatus((o.sent?o.sent+' attached; ':'')+o.failed.length+' not attached: '"), 'the lead page always says which files failed');
  assert.match(ATTACH_UI_JS, /filter\(function\(f\)\{ return !done\[fkey\(f\)\]; \}\)/);
  assert.ok(require('../src/routes/adminLeads').buildLeadsQueueHTML().includes('AL_ATT.reset(); AL_ATT.refresh();'));
  const cons = require('../src/routes/adminConsultation').buildQueueHTML();
  assert.ok(cons.includes('DC_ATT.refresh();'));
  assert.ok(cons.includes("DC_PROFILE_ADDR=String(id.address||'').split(String.fromCharCode(13)).join('').split(String.fromCharCode(10)).join('');"), 'a two-line carried address still asks for the tick');
});
