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

test('a phone-only walk-in is created (no email, no address): source + referrer saved in their own columns, a "No email yet" line in the note', async () => {
  const w = createWorld();
  try {
    const r = await portal.createDirectClient(PHONE_ONLY);
    assert.equal(r.ok, true); assert.equal(r.caseOpened, true);
    assert.equal(w.calls.created[0].email, '', 'no email written');
    assert.equal(w.calls.created[0].sourceChannel, 'Direct Retainer', 'Source / Reference keeps the Direct Retainer marker');
    const wiring = w.calls.updates.find((u) => u.id === '900').f;
    assert.equal(wiring.walkInSource, 'Employee Referral', 'the real source goes in its own column');
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
  assert.ok(cons.includes("direct · '+escHtml(c.walkInSource)"));
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
    svc.io.getLead = async () => ({ id: '900', oneDriveFolderId: '' });
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
