'use strict';

// Staff-entered phone-in lead ("direct leads", meeting 2026-08-13): a normal
// funnel lead with the full intake wiring, NO case, NO retainer intent, with
// the direct-client modal's duplicate contract (409 + matches → allowDuplicate).

const test   = require('node:test');
const assert = require('node:assert/strict');

const svc         = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const VALID = { fullName: 'Phone Caller', email: 'caller@x.com', phone: '4165550001', sourceChannel: 'Phone',
                residentialAddress: '12 King St W, Toronto, ON M5H 1A1, Canada', inCanada: 'Yes', addedBy: 'Melanie' };

test('validation (2026-11-04): the name, an email OR a phone, and the source are required; what IS given must make sense; case type must be canonical', async () => {
  const created = [];
  const restore = [
    stub(svc, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] })),
    stub(leadService, 'createLead', async (f) => { created.push(f); return { id: '9200', ...f }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const expectMsg = async (bad, re) => {
      await assert.rejects(svc.createStaffLead(bad), (e) => e.badRequest === true && re.test(e.message), JSON.stringify(bad) + ' → ' + re);
    };
    await expectMsg({ ...VALID, fullName: '' }, /Full name is required/);
    await expectMsg({ ...VALID, fullName: '   ' }, /Full name is required/);
    // email OR phone: both empty (or whitespace) is refused; one of the two is enough
    await expectMsg({ ...VALID, email: '', phone: '' }, /email or a phone number/);
    await expectMsg({ ...VALID, email: '  ', phone: undefined }, /email or a phone number/);
    await expectMsg({ fullName: 'Name Only' }, /email or a phone number/);
    await expectMsg({ ...VALID, email: 'not-an-email' }, /email doesn/);
    await expectMsg({ ...VALID, phone: '12' }, /phone number is too short/);
    // the source is a real choice — no silent "Phone" default, no label minting
    await expectMsg({ ...VALID, sourceChannel: '' }, /source \/ reference from the list/);
    await expectMsg({ ...VALID, sourceChannel: undefined }, /source \/ reference from the list/);
    await expectMsg({ ...VALID, sourceChannel: 'Direct Retainer' }, /source \/ reference from the list/);   // set by the direct-client form only, never on Add lead
    await expectMsg({ ...VALID, sourceChannel: 'Carrier pigeon' }, /source \/ reference from the list/);
    await expectMsg({ ...VALID, caseTypeInterest: 'Made Up Type' }, /not a canonical case type/);
    assert.equal(created.length, 0);
    // name + phone + source is enough (a screenshot often has only the number)
    const r = await svc.createStaffLead({ fullName: 'Number Only', phone: '4165550001', sourceChannel: 'WhatsApp' });
    assert.equal(r.leadId, '9200');
    assert.deepEqual(created[0], { fullName: 'Number Only', phone: '4165550001', sourceChannel: 'WhatsApp' }, 'nothing empty is written');
    // name + email + source is enough too
    const r2 = await svc.createStaffLead({ fullName: 'Email Only', email: 'e@x.com', sourceChannel: 'Email' });
    assert.equal(r2.leadId, '9200');
    assert.deepEqual(created[1], { fullName: 'Email Only', email: 'e@x.com', sourceChannel: 'Email' });
  } finally { restore.reverse().forEach((x) => x()); }
});

test('the lead page "Edit basics": a save may not CLEAR the last email / phone; a lead that never had one (added before the rule) can still be edited', async () => {
  const blacklist = require('../src/services/blacklistService');
  const run = async (lead, body) => {
    const updates = [];
    const restore = [
      stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Someone Here', name: 'Someone Here', email: '', phone: '', sourceChannel: 'Phone', caseTypeInterest: '', ...lead })),
      stub(leadService, 'updateLead', async (id, f, o) => { updates.push({ f, o }); }),
      stub(leadService, 'renameLead', async () => {}),
      stub(mondayApi, 'query', async () => ({})),
      stub(svc, 'findClientMatches', async () => ({ leads: [], cases: [], clients: [] })),
      stub(blacklist, 'check', async () => ({ checked: true, hit: false })),
    ];
    try { await svc.applyAction({ leadId: '8', action: 'saveBasicInfo', value: JSON.stringify({ fullName: 'Someone Here', email: '', phone: '', sourceChannel: 'Phone', caseTypeInterest: '', ...body }), staffName: 'Gauri' }); return updates; }
    finally { restore.reverse().forEach((r) => r()); }
  };
  // clearing the only contact: refused (whitespace is empty)
  await assert.rejects(run({ email: 'a@x.com' }, { email: '' }), /email or a phone number/);
  await assert.rejects(run({ phone: '4165550001' }, { phone: '   ' }), /email or a phone number/);
  await assert.rejects(run({ email: 'a@x.com', phone: '4165550001' }, { email: '', phone: '' }), /email or a phone number/);
  // one of the two stays: fine
  assert.deepEqual((await run({ email: 'a@x.com', phone: '4165550001' }, { email: '', phone: '4165550001' }))[0].o, { clearKeys: ['email'] });
  // a contact-less OLD lead: other details still save
  assert.deepEqual((await run({}, { fullName: 'Someone Else' }))[0].f, { fullName: 'Someone Else' });
  assert.deepEqual((await run({}, { sourceChannel: 'Employee Referral', referredBy: 'Gauri Berde' }))[0].f, { sourceChannel: 'Employee Referral', referredBy: 'Gauri Berde' });
  // validateAction alone no longer decides it (it cannot see the stored values)
  assert.equal(svc.validateAction('saveBasicInfo', JSON.stringify({ fullName: 'Someone Here', email: '', phone: '' })).ok, true);
});

test('duplicate contract: matches → 409-shaped conflict; allowDuplicate creates anyway', async () => {
  const created = [];
  const restore = [
    stub(svc, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [{ id: '1', name: 'Existing' }] })),
    stub(leadService, 'createLead', async (f) => { created.push(f); return { id: '9100', ...f }; }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await assert.rejects(svc.createStaffLead(VALID), (e) => e.conflict === true && e.matches.leads.length === 1);
    assert.equal(created.length, 0, 'nothing created without the explicit choice');
    const r = await svc.createStaffLead({ ...VALID, allowDuplicate: true });
    assert.equal(r.leadId, '9100');
    assert.equal(created.length, 1);
  } finally { restore.reverse().forEach((x) => x()); }
});

test('creates a NORMAL funnel lead: existing source label, no case, no consultant, note carried', async () => {
  let created = null; const updates = [];
  const restore = [
    stub(svc, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] })),
    stub(leadService, 'createLead', async (f) => { created = f; return { id: '9101', ...f }; }),
    stub(leadService, 'updateLead', async (id, f) => { updates.push({ id, f }); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await svc.createStaffLead({ ...VALID, sourceChannel: 'WhatsApp', caseTypeInterest: 'Inland Spousal Sponsorship', note: 'Wants citizenship help' });
    assert.equal(r.leadId, '9101');
    assert.equal(created.sourceChannel, 'WhatsApp', 'existing board label only');
    assert.equal(created.caseTypeInterest, undefined,
      'canonical labels do NOT exist on the interest dropdown — create_item has no label minting, so the type must never ride the creation write');
    assert.ok(updates.some((u) => u.id === '9101' && u.f.caseTypeInterest === 'Inland Spousal Sponsorship'),
      'the type follows via updateLead (create_labels_if_missing — the sanctioned label path)');
    assert.equal(created.situationDescription, 'Wants citizenship help');
    assert.equal(created.confirmedCaseType, undefined, 'no case-type confirmation — this is a plain lead');
    assert.equal(created.assignedConsultant, undefined, 'no consultant pin');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('UI + route wiring (source contract)', () => {
  const fs = require('fs');
  const page = fs.readFileSync(require.resolve('../src/routes/adminLeads'), 'utf8');
  assert.match(page, /id="btn-add-lead"/);
  assert.match(page, /\/api\/leads\/create/);
  assert.match(page, /allowDuplicate=true/, '409 → create-anyway resubmit');
  assert.match(page, /AL_ALLOW=false; var m=alEl\('al-matches'\)/, 'identity edits disarm a stale create-anyway (different person must be re-scanned)');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(server, /app\.post\('\/api\/leads\/create'/);
  assert.match(server, /err\.conflict\)\s+return res\.status\(409\)/, 'duplicate contract surfaces as 409 + matches');
});

test('the address is written AT creation, so a mandatory field is never missing', async () => {
  const created = [];
  const restore = [
    stub(svc, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] })),
    stub(leadService, 'createLead', async (f) => { created.push(f); return { id: '9200', ...f }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await svc.createStaffLead({ ...VALID, residentialAddress: '  12 King St W, Toronto  ' });
    assert.equal(created.length, 1);
    assert.equal(created[0].residentialAddress, '12 King St W, Toronto', 'trimmed and passed to createLead itself');
  } finally { restore.reverse().forEach((x) => x()); }

  // leadService must actually carry it onto the board row at create time
  const src = require('fs').readFileSync(require.resolve('../src/services/leadService'), 'utf8');
  const i = src.indexOf('const createFields = {');
  assert.match(src.slice(i, src.indexOf('};', i)), /residentialAddress:\s*formData\.residentialAddress/);
});

test('the "Add lead" modal: name, email-or-phone and source are marked required; the address, case type, location and Added by stay optional', () => {
  const html = require('../src/routes/adminLeads').buildLeadsQueueHTML();
  assert.match(html, /id="al-address"/, 'the field exists');
  assert.match(html, /residentialAddress:alEl\('al-address'\)\.value/, 'sent to the API');
  assert.match(html, /<label class="al-l" for="al-name">Full name \*<\/label>/);
  for (const l of ['Email', 'Phone', 'Source / Reference']) assert.ok(html.includes(`>${l} *</label>`), `${l} is not marked required`);
  assert.match(html, /one of the two is enough/, 'the either-or hint');
  for (const l of ['Residential address', 'Added by', 'Case type interest', 'Note']) assert.ok(html.includes(`>${l}</label>`), `${l} must stay optional`);
  assert.ok(html.includes('<div class="al-l" id="al-incanada-l">In Canada now?</div>'));
  // the source opens on a blank choice (it used to open on "Phone", which made "required" meaningless)
  assert.match(html, /<select id="al-source"><option value="">— choose —<\/option><option>Phone<\/option>/);
  assert.match(html, /var refErr=AL_REF\.check\(\); if\(refErr\)/, 'the second question is checked before sending');
  assert.match(html, /alEl\('al-source'\)\.value='';/, 'reset on every open');
  // the browser-side checks mirror the server's
  assert.match(html, /if\(!body\.email\.trim\(\) && !body\.phone\.trim\(\)\)/);
  assert.match(html, /if\(!body\.sourceChannel\)/);
  assert.ok(!/only the full name is required/.test(html), 'the old name-only message is gone');
  assert.ok(!/Name, email, phone and residential address are all required/.test(html), 'the old all-required message is gone');
});

test('the lead page "Edit basics" box refuses to CLEAR both email and phone before calling the server (an old contact-less lead still saves)', () => {
  const html = require('../src/routes/adminLeads').buildLeadDetailHTML('123');
  assert.match(html, /var contactEdited=\(body\.email\.trim\(\)!==String\(BD_LOADED\.email\)\.trim\(\) \|\| body\.phone\.trim\(\)!==String\(BD_LOADED\.phone\)\.trim\(\)\);/);
  assert.match(html, /if\(contactEdited && hadContact && !body\.email\.trim\(\) && !body\.phone\.trim\(\)\)\{ actMsg\('bd-msg','err','Keep an email or a phone number/);
  assert.match(html, /BD_LOADED=\{ src:src\.value, ref:d\.referredBy\|\|'', email:d\.email\|\|'', phone:d\.phone\|\|'' \};/);
});
