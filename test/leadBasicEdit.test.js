'use strict';

// Lead page: the basic details are editable (Faran 2026-10-28) — name, email,
// phone, how they reached us, case type interest, and the inquiry. Every change
// leaves a note with the old value; a lead with a case keeps its name / email /
// phone (changed on the case); warnings, never blocks, for a resend / agreement /
// the same email elsewhere / the Not Wanted list. No network: stubs only.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');

const portal = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi = require('../src/services/mondayApi');
const blacklist = require('../src/services/blacklistService');
const registry = require('../src/services/caseTypeRegistryService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const BASE = { id: '5', fullName: 'Asha Rao', name: 'Asha Rao', email: 'asha@example.com', phone: '+1 416-555-0101', sourceChannel: 'Website', caseTypeInterest: '', bookingInvite: '', bookingStatus: 'Not Yet' };
const BODY = { fullName: 'Asha Rao', email: 'asha@example.com', phone: '4165550101', sourceChannel: 'Website', caseTypeInterest: '' };

function world(lead = {}, { matches = { leads: [], cases: [], clients: [] }, bl = { checked: true, hit: false } } = {}) {
  const calls = { updates: [], renames: [], notes: [] };
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ ...BASE, ...lead, id })),
    stub(leadService, 'updateLead', async (id, f, o) => { calls.updates.push({ id, f, o }); }),
    stub(leadService, 'renameLead', async (id, n) => { calls.renames.push(n); }),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) calls.notes.push(v.b); return {}; }),
    stub(portal, 'findClientMatches', async () => matches),
    stub(blacklist, 'check', async () => bl),
    stub(registry, 'getCaseTypes', async () => ['Express Entry', 'Study Permit', 'Visitor Visa']),
  ];
  const act = (body, extra = {}) => portal.applyAction({ leadId: '5', action: 'saveBasicInfo', value: JSON.stringify({ ...BODY, ...body }), staffName: 'Gauri', ...extra });
  return { calls, act, done: () => restore.reverse().forEach((r) => r()) };
}

test('checks: a name, a real email, a phone of 7–15 digits (or none), a source from the list', () => {
  const v = (b) => portal.validateAction('saveBasicInfo', JSON.stringify({ ...BODY, ...b }));
  assert.deepEqual(v({ fullName: '  Asha   Rao ', phone: '' }).normalized, { ...BODY, phone: '' });
  assert.match(v({ fullName: 'A' }).error, /full name/);
  for (const email of ['', 'asha', 'asha@x', 'a b@x.com']) assert.match(v({ email }).error, /valid email/, email);
  for (const phone of ['123', 'call me', '+1 416 555 0101 1234 5678']) assert.match(v({ phone }).error, /phone/, phone);
  assert.equal(portal.validateAction('saveBasicInfo', 'not json').ok, false);
  assert.equal(portal.validateAction('saveInquiry', 'x'.repeat(5001)).ok, false);
});

test('only what changed is written; the name also renames the row; a note lists old → new; a phone with spaces is the same phone', async () => {
  const w = world();
  try {
    assert.equal((await w.act({})).message, 'No change.', 'same values (phone formatting aside)');
    assert.equal(w.calls.updates.length, 0);
    const r = await w.act({ fullName: 'Asha K Rao', phone: '647 555 0199', sourceChannel: 'Phone', caseTypeInterest: 'Study Permit' });
    assert.deepEqual(w.calls.updates[0].f, { fullName: 'Asha K Rao', phone: '647 555 0199', sourceChannel: 'Phone', caseTypeInterest: 'Study Permit' });
    assert.deepEqual(w.calls.renames, ['Asha K Rao']);
    assert.match(w.calls.notes[0], /Basic details changed by Gauri: Name “Asha K Rao” \(was “Asha Rao”\); Phone “647 555 0199” \(was “\+1 416-555-0101”\); How they reached us “Phone” \(was “Website”\); Case type interest “Study Permit” \(was \(empty\)\)\./);
    assert.match(r.message, /^Saved: name, phone, how they reached us, case type interest\.$/);
    // clearing the phone / case type uses the column clear
    const w2 = world({ caseTypeInterest: 'Study Permit' });
    try {
      await w2.act({ phone: '', caseTypeInterest: '' });
      assert.deepEqual(w2.calls.updates[0], { id: '5', f: {}, o: { clearKeys: ['phone', 'caseTypeInterest'] } });
    } finally { w2.done(); }
  } finally { w.done(); }
});

test('refused: name / email / phone once a case is open; changing a Direct Retainer source; a case type not on the list', async () => {
  let w = world({ clientMasterItemId: '999' });
  try {
    await assert.rejects(w.act({ email: 'new@example.com' }), /has a case — change the client’s name, email or phone on the case page/);
    await w.act({ caseTypeInterest: 'Express Entry' });   // other details still save
    assert.deepEqual(w.calls.updates[0].f, { caseTypeInterest: 'Express Entry' });
  } finally { w.done(); }
  w = world({ sourceChannel: 'Direct Retainer' });
  try {
    await assert.rejects(w.act({ sourceChannel: 'Phone' }), /stays "Direct Retainer"/);
    await assert.rejects(w.act({ sourceChannel: 'Direct Retainer', caseTypeInterest: 'Made Up Visa' }), /not a case type from the list/);
    assert.equal(w.calls.updates.length, 0);
    await w.act({ sourceChannel: 'Direct Retainer', fullName: 'Asha R' });   // the page sends the unchanged source back
    assert.deepEqual(w.calls.updates[0].f, { fullName: 'Asha R' });
  } finally { w.done(); }
  w = world({ sourceChannel: 'Referral' });   // an older label not on today's list
  try {
    await w.act({ sourceChannel: 'Referral', fullName: 'Asha R' });
    assert.deepEqual(w.calls.updates[0].f, { fullName: 'Asha R' }, 'unchanged old label passes');
    await assert.rejects(w.act({ sourceChannel: 'TikTok' }), /from the list/);
    await assert.rejects(w.act({ sourceChannel: '' }), /from the list/);
  } finally { w.done(); }
});

test('warnings (the save still happens): new email after the invite, an agreement already sent, the same email elsewhere, the Not Wanted list', async () => {
  const w = world({ bookingInvite: 'Sent', consultAgreementSent: '2026-10-20' },
    { matches: { leads: [{ id: '5' }, { id: '77' }], cases: [{ caseRef: '2026-EE-001' }], clients: [] }, bl: { checked: true, hit: true } });
  try {
    const r = await w.act({ email: 'asha.rao@example.com' });
    assert.equal(w.calls.updates.length, 1);
    assert.equal(r.warnings.length, 4);
    assert.match(r.message, /send it again so the client gets it/);
    assert.match(r.message, /An agreement already sent keeps the old details\./);
    assert.match(r.message, /This email is also on lead 77, case 2026-EE-001\./, 'this lead itself is not listed');
    assert.match(r.message, /Not Wanted list/);
    assert.match(w.calls.notes[0], /send it again/);
  } finally { w.done(); }
});

test('the inquiry: saved, the old text kept in the note; emptied = cleared; same = no change', async () => {
  const w = world({ situationDescription: 'Old question about a study permit.' });
  try {
    const r = await portal.applyAction({ leadId: '5', action: 'saveInquiry', value: '  New question\r\nsecond line ', staffName: 'Kamal' });
    assert.equal(r.message, 'Inquiry saved.');
    assert.deepEqual(w.calls.updates[0], { id: '5', f: { situationDescription: 'New question\nsecond line' }, o: { clearKeys: [] } });
    assert.match(w.calls.notes[0], /Inquiry edited by Kamal\. It was: “Old question about a study permit\.”/);
    await portal.applyAction({ leadId: '5', action: 'saveInquiry', value: '', staffName: 'Kamal' });
    assert.deepEqual(w.calls.updates[1].o, { clearKeys: ['situationDescription'] });
    assert.equal((await portal.applyAction({ leadId: '5', action: 'saveInquiry', value: 'Old question about a study permit.' })).message, 'No change.');
  } finally { w.done(); }
});

test('renameLead writes the row name (trimmed, never empty)', async () => {
  const seen = [];
  const r = stub(mondayApi, 'query', async (q, v) => { seen.push([q, v]); return {}; });
  try {
    await leadService.renameLead('5', '  Asha   Rao ');
    assert.match(seen[0][0], /change_simple_column_value\(board_id: \$boardId, item_id: \$itemId, column_id: "name", value: \$v\)/);
    assert.equal(seen[0][1].v, 'Asha Rao');
    await assert.rejects(leadService.renameLead('5', '  '), /needs a name/);
  } finally { r(); }
});

test('the lead page: a Basic details card (locked fields for a case), an editable inquiry; every script parses', () => {
  const html = require('../src/routes/adminLeads').buildLeadDetailHTML('5');
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
  for (const x of ['id="bd-name"', 'id="bd-email" type="email"', 'id="bd-phone" type="tel"', 'id="bd-source"', 'id="bd-casetype"', 'id="btn-bd-save"',
    "doAction(this,'saveBasicInfo',null,JSON.stringify(body),'bd-msg')", "['name','email','phone'].forEach(function(k){ bdEl(k).readOnly=caseOpen; });",
    'id="btn-inq-edit"', 'id="inq-text"', "doAction(this,'saveInquiry',null,document.getElementById('inq-text').value,'inq-msg')", 'hydrateBasic(d);']) assert.ok(html.includes(x), x);
  assert.ok(html.indexOf('id="basic-card"') < html.indexOf('Their inquiry'), 'Basic details come first');
});
