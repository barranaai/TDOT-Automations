'use strict';

// The Add-lead group (Faran 2026-10-15 "yes. go ahead"):
//  1. "In Canada now?" on Add lead and on the lead page — it sets the HST on the
//     consultation fee (no HST outside Canada; Melanie's rule 2026-08-24).
//  2. Who added each lead → the Lead Owner: the Monday sign-in when there is one,
//     else the name picked in the form; the owner stays editable on the lead page.
//     The Leads list shows how they reached us and the owner.
//  3. A lead converted to a direct retainer keeps its original channel in its own
//     column (Source Channel must read "Direct Retainer"); it still counts as a lead.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');

const portal      = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const snap        = require('../src/services/leadSnapshot');
const roster      = require('../config/portalStaff');
const countries   = require('../config/countries');
const booking     = require('../src/services/bookingService');
const { computeKpis } = require('../src/services/kpiService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const VALID = { fullName: 'Phone Caller', email: 'caller@x.com', phone: '4165550001', sourceChannel: 'Phone', residentialAddress: '12 King St W, Toronto', inCanada: 'Yes', addedBy: 'Melanie' };

function world() {
  const calls = { created: [], updates: [], notes: [], matched: 0 };
  const restore = [
    stub(portal, 'findClientMatches', async () => { calls.matched++; return { clients: [], cases: [], leads: [] }; }),
    stub(leadService, 'createLead', async (f) => { calls.created.push(f); return { id: '9300', ...f }; }),
    stub(leadService, 'updateLead', async (id, f, o) => { calls.updates.push({ id, f, o }); }),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) calls.notes.push(v.b); return {}; }),
  ];
  return { calls, done: () => restore.reverse().forEach((r) => r()) };
}

/* ── 1. where the client is ── */

test('location: Yes → Canada; No + a listed country → that country; anything else refused', () => {
  const n = portal.normalizeLeadLocation;
  assert.deepEqual(n({ inCanada: 'Yes', country: 'India' }), { ok: true, insideCanada: 'Yes', country: 'Canada' });
  assert.deepEqual(n({ inCanada: 'No', country: ' India ' }), { ok: true, insideCanada: 'No', country: 'India' });
  for (const bad of [{}, { inCanada: 'yes' }, { inCanada: 'No' }, { inCanada: 'No', country: 'Canada' }, { inCanada: 'No', country: 'Narnia' }]) assert.equal(n(bad).ok, false, JSON.stringify(bad));
  assert.match(n({}).error, /In Canada now/);
});

test('countries: no Canada, no duplicates or blanks, and every one is HST-exempt for the consultation fee', () => {
  const c = countries.COUNTRIES;
  assert.ok(c.length > 190);
  assert.equal(new Set(c).size, c.length);
  assert.ok(!c.some((x) => !x.trim() || /^canada$/i.test(x)));
  assert.ok(c.every((x) => booking.isConsultHstExemptCountry(x)));
  assert.equal(booking.isConsultHstExemptCountry('Canada'), false);
});

test('Add lead: the location may be left for later (Faran 2026-10-28); "No" still needs a country, checked FIRST; Yes stores Canada at creation; No stores the country; the note says the HST', async () => {
  const w = world();
  try {
    await assert.rejects(portal.createStaffLead({ ...VALID, inCanada: 'No', currentCountry: '' }), (e) => e.badRequest && /country/.test(e.message));
    assert.equal(w.calls.matched, 0, 'refused before any duplicate lookup');
    await portal.createStaffLead({ ...VALID, email: 'later@x.com', inCanada: '' });
    assert.equal(w.calls.created[0].country, undefined, 'no location written');
    assert.ok(!w.calls.updates.some((u) => u.f.insideCanada), 'no In Canada answer written');
    assert.ok(w.calls.notes.some((b) => /Still to add on this page: where the client is now \(HST is charged on the consultation fee until it is set\)/.test(b)));
    w.calls.created.length = 0; w.calls.updates.length = 0; w.calls.notes.length = 0;
    await portal.createStaffLead(VALID);
    assert.equal(w.calls.created[0].country, 'Canada', 'on the creation write — an invite sent at once already prices it');
    assert.ok(w.calls.updates.some((u) => u.id === '9300' && u.f.insideCanada === 'Yes'));
    await portal.createStaffLead({ ...VALID, email: 'abroad@x.com', inCanada: 'No', currentCountry: 'India' });
    assert.equal(w.calls.created[1].country, 'India');
    assert.equal(booking.consultHstPctForLead({ country: w.calls.created[1].country }), 0, 'no HST for this client');
    assert.ok(w.calls.updates.some((u) => u.f.insideCanada === 'No'));
    assert.ok(w.calls.notes.some((b) => /Outside Canada now \(India\) — no HST on the consultation fee/.test(b)));
    assert.ok(w.calls.notes.some((b) => /In Canada now — HST applies to the consultation fee/.test(b)));
  } finally { w.done(); }
});

/* ── 2. who added it → the lead owner ── */

test('who added it: the Monday sign-in wins (matched to the roster name); without it, a roster name or nothing; it becomes the Lead Owner', async () => {
  const w = world();
  try {
    await portal.createStaffLead({ ...VALID, addedBy: 'Gauri' }, { actor: { name: 'Melanie Smith', email: 'm@tdotimm.com', verified: true } });
    assert.equal(w.calls.created[0].leadOwner, 'Melanie', 'the signed-in person, as the roster spells them — never the typed pick');
    assert.ok(w.calls.notes.some((b) => /Lead added by Melanie \(signed in with Monday\)/.test(b)));
    await portal.createStaffLead({ ...VALID, email: 'b@x.com', addedBy: 'Prajwal', sourceChannel: 'Instagram' }, { actor: { name: 'Unidentified (shared admin key)', verified: false } });
    assert.equal(w.calls.created[1].leadOwner, 'Prajwal');
    for (const addedBy of ['Somebody', 'melanie']) {
      await assert.rejects(portal.createStaffLead({ ...VALID, email: 'c@x.com', addedBy }, { actor: { name: 'x', verified: false } }), (e) => e.badRequest && /Added by/.test(e.message), addedBy);
    }
    await portal.createStaffLead({ ...VALID, email: 'e@x.com', addedBy: '' }, { actor: { name: 'x', verified: false } });
    assert.equal(w.calls.created[w.calls.created.length - 1].leadOwner, undefined, 'left empty: no owner');
    assert.ok(w.calls.notes.some((b) => /\[Consultant portal\]<\/b> Lead added \(phone intake\)/.test(b)));
    // a Monday name with markup is escaped in the note
    await portal.createStaffLead({ ...VALID, email: 'd@x.com' }, { actor: { name: 'Zed <b>X</b>', verified: true } });
    assert.ok(w.calls.notes.some((b) => b.includes('Zed &lt;b&gt;X&lt;/b&gt;')));
  } finally { w.done(); }
  assert.equal(roster.rosterNameFor('Shafoli Kapur'), 'Shafoli Kapur');
  assert.equal(roster.rosterNameFor('Faran Arshad'), 'Faran Arshad', 'not on the roster → the Monday name as it is');
  assert.ok(roster.staffRoster().includes('Shafoli Kapur') && roster.staffRoster().includes('Shermin Teymouri Mofrad'), 'the consultants are on the roster');
});

test('lead owner on the lead page: roster names only (or clear); a note says who changed it from what', async () => {
  assert.deepEqual(portal.validateAction('saveLeadOwner', 'Shafoli Kapur'), { ok: true, normalized: 'Shafoli Kapur' });
  assert.deepEqual(portal.validateAction('saveLeadOwner', ''), { ok: true, normalized: '' });
  assert.equal(portal.validateAction('saveLeadOwner', 'Nobody').ok, false);
  const w = world();
  const r1 = stub(leadService, 'getLead', async (id) => ({ id, leadOwner: 'Melanie' }));
  try {
    const r = await portal.applyAction({ leadId: '5', action: 'saveLeadOwner', value: 'Prajwal', staffName: 'X', actor: { name: 'Shafoli Kapur', verified: true } });
    assert.equal(r.message, 'Lead owner: Prajwal.');
    assert.deepEqual(w.calls.updates[0].f, { leadOwner: 'Prajwal' });
    assert.match(w.calls.notes[0], /Lead owner set to Prajwal \(was Melanie\) by Shafoli Kapur\./);
    const same = await portal.applyAction({ leadId: '5', action: 'saveLeadOwner', value: 'Melanie', staffName: 'X' });
    assert.equal(same.message, 'No change.');
    await portal.applyAction({ leadId: '5', action: 'saveLeadOwner', value: '', staffName: 'X' });
    assert.deepEqual(w.calls.updates[1].o, { clearKeys: ['leadOwner'] });
  } finally { r1(); w.done(); }
});

test('location on the lead page: writes both columns, notes old → new, and says what happens to a price already quoted or paid', async () => {
  assert.deepEqual(portal.validateAction('saveLocation', JSON.stringify({ inCanada: 'No', country: 'India' })), { ok: true, normalized: { insideCanada: 'No', country: 'India' } });
  assert.equal(portal.validateAction('saveLocation', { inCanada: 'No', country: 'Canada' }).ok, false);
  const OLD_PAGE = /payment page or invoice at the OLD price may still be open and payable/;
  const cases = [
    [{ bookingInvite: 'Sent', bookingStatus: 'Not Yet' }, /invite email quoted the old price/],
    [{ bookingStatus: 'Slot Held' }, OLD_PAGE],
    // review 2026-10-15: an invited lead with a held slot gets BOTH lines (the open page first)
    [{ bookingInvite: 'Sent', bookingStatus: 'Slot Held' }, /OLD price may still be open and payable — cancel it in Square \(or let the hold expire\) before re-sending\. The invite email quoted the old price/],
    [{ bookingStatus: 'Booked', squareConsultOrderId: 'O1' }, OLD_PAGE],   // hand-booked, the app link never paid
    [{ consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, invoiceId: 'inv_1' }) }, OLD_PAGE],
    [{ squareConsultTxnId: 'SQ1' }, /already paid does not change; any refund is done in Square/],
    [{}, /^Saved — no HST on the consultation fee\.$/],
  ];
  for (const [extra, re] of cases) {
    const w = world();
    const r1 = stub(leadService, 'getLead', async (id) => ({ id, insideCanada: 'Yes', country: 'Canada', ...extra }));
    try {
      const r = await portal.applyAction({ leadId: '6', action: 'saveLocation', value: { inCanada: 'No', country: 'India' }, staffName: 'Melanie', actor: { name: 'Melanie', verified: false } });
      assert.match(r.message, re, JSON.stringify(extra));
      assert.deepEqual(w.calls.updates[0].f, { insideCanada: 'No', country: 'India' });
      assert.match(w.calls.notes[0], /Where the client is now: outside Canada \(India\) — set by Melanie \(was: Canada\)\. no HST on the consultation fee\./);
      if (OLD_PAGE.test(r.message)) assert.match(w.calls.notes[0], /⚠ A payment page or invoice at the old price may still be open\./, 'kept on the note for whoever sees a later payment');
      assert.ok(!(extra.squareConsultTxnId && OLD_PAGE.test(r.message)), 'paid → no open-page warning');
    } finally { r1(); w.done(); }
  }
});

/* ── the lists and the lead page ── */

test('Leads list rows carry how they reached us and the owner; the service falls back to the staff-picked case type', async () => {
  snap._reset(); portal.invalidateLeadsQueue();
  const r = stub(snap.io, 'fetchLeads', async () => [{ id: '1', fullName: 'A', sourceChannel: 'WhatsApp', leadOwner: 'Prajwal', caseTypeInterest: 'Study Permit', createdAt: '2026-10-10T12:00:00Z' }]);
  try {
    const rows = await portal.getLeadsQueue();
    assert.deepEqual([rows[0].source, rows[0].owner, rows[0].service], ['WhatsApp', 'Prajwal', 'Study Permit']);
  } finally { r(); snap._reset(); portal.invalidateLeadsQueue(); }
});

test('lead page payload: channel, original channel, owner, staff-added, location; the intake section shows the corrected location', async () => {
  const r = stub(leadService, 'getLead', async (id) => ({ id, fullName: 'A', sourceChannel: 'Phone', leadOwner: 'Melanie', caseTypeInterest: 'Study Permit', insideCanada: 'No', country: 'India', inviteMessage: 'x', bookingInvite: 'Sent' }));
  try {
    const d = await portal.getLeadDetail('7');
    assert.deepEqual([d.sourceChannel, d.leadOwner, d.staffAdded, d.insideCanada, d.country, d.service], ['Phone', 'Melanie', true, 'No', 'India', 'Study Permit']);
  } finally { r(); }
  const { sections } = portal.buildIntakeSections({ insideCanada: 'Yes', currentCountry: '' }, { insideCanada: 'No', country: 'India' });
  const basic = sections.find((s) => s.title === 'Basic information');
  const val = (label) => (basic.rows.find((x) => x.label === label) || {}).value;
  assert.deepEqual([val('Inside Canada'), val('Country')], ['No', 'India'], 'the column (corrected by staff) wins over the original answer');
});

/* ── 3. the original channel ── */

test('convert to direct retainer: the original channel is kept in its own column (once); Source Channel still reads Direct Retainer', async () => {
  const registry = require('../src/services/caseTypeRegistryService');
  const handoff = require('../src/services/handoffService');
  const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');
  const CASE_TYPE = CASE_TYPE_LABELS.find((ct) => !(SUB_TYPES_BY_CASE[ct] || []).length);
  const run = async (existing) => {
    const updates = [];
    const restore = [
      stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
      stub(leadService, 'getLead', async () => ({ id: '300', fullName: 'Same Person', clientMasterItemId: '', conversionStatus: '', retainerSent: '', ...existing })),
      stub(leadService, 'updateLead', async (id, f) => { updates.push({ id, f }); }),
      stub(leadService, 'createLead', async () => { throw new Error('must not create'); }),
      stub(handoff, 'openCaseEarly', async () => 'CM-300'),
      stub(mondayApi, 'query', async () => ({})),
    ];
    try {
      await portal.createDirectClient({ fullName: 'Same Person', email: 'dup@x.co', phone: '4165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: 'Shermin Teymouri Mofrad', linkLeadId: '300' });
      return updates.find((u) => u.id === '300').f;
    } finally { restore.reverse().forEach((x) => x()); }
  };
  const a = await run({ sourceChannel: 'Website' });
  assert.deepEqual([a.sourceChannel, a.originalChannel], ['Direct Retainer', 'Website']);
  const b = await run({ sourceChannel: 'Phone', originalChannel: 'Instagram' });
  assert.equal('originalChannel' in b, false, 'never overwritten');
  const c = await run({ sourceChannel: 'Direct Retainer' });
  assert.equal('originalChannel' in c, false);
  const d = await run({ sourceChannel: '' });
  assert.equal('originalChannel' in d, false);
});

test('KPIs: a converted lead still counts as a lead; a walk-in direct client still does not', () => {
  const k = computeKpis([
    { sourceChannel: 'Direct Retainer', originalChannel: 'Website', createdAt: '2026-10-02T12:00:00Z' },
    { sourceChannel: 'Direct Retainer', createdAt: '2026-10-03T12:00:00Z' },
    { sourceChannel: 'Phone', createdAt: '2026-10-04T12:00:00Z' },
  ], '2026-10');
  assert.equal(k.funnel.leads, 2);
});

test('the Retainers row carries the original channel and the pill says it', async () => {
  snap._reset();
  const r = stub(snap.io, 'fetchLeads', async () => [{ id: '1', fullName: 'A', sourceChannel: 'Direct Retainer', originalChannel: 'Website', createdAt: '2026-10-01T00:00:00Z' }]);
  try {
    const b = await portal.getConsultationsBoard();
    assert.equal(b.retainers[0].originalChannel, 'Website');
  } finally { r(); snap._reset(); }
  assert.ok(snap.SNAPSHOT_KEYS.includes('originalChannel') && snap.SNAPSHOT_IDS.includes('text_mm85mpjf'));
  assert.equal(require('../src/data/newLeadsBoard.json').columns.originalChannel, 'text_mm85mpjf');
  const q = require('../src/routes/adminConsultation').buildQueueHTML();
  assert.ok(q.includes(">direct · '+escHtml(c.originalChannel)+'</span>"));
});

/* ── the pages ── */

test('pages: Add lead asks In Canada now? (+ country) and Added by (hidden when signed in); the list has Source; the lead page has the owner + location card; every script parses', () => {
  const al = require('../src/routes/adminLeads');
  const q = al.buildLeadsQueueHTML(), d = al.buildLeadDetailHTML('7');
  for (const html of [q, d]) for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
  for (const s of ['name="al-incanada" value="Yes"', 'name="al-incanada" value="No"', 'id="al-country"', '<option value="India">India</option>', 'id="al-addedby"', '<option value="Shafoli Kapur">', 'id="al-signedin"',
    "inCanada:alLoc(), currentCountry:alEl('al-country').value, addedBy:alEl('al-addedby').value", "if(!body.fullName.trim()){ err.textContent='Enter the full name — it is the only required field.'", 'tdotBlViewer(function(v){',
    "label: 'Source', title: 'How they reached us · who owns the lead'", 'colspan="10"']) assert.ok(q.includes(s), s);
  for (const s of ['id="lead-owner"', 'id="btn-lead-owner"', 'name="lead-incanada"', 'id="lead-country"', 'id="btn-lead-loc"', "doAction(ob,'saveLeadOwner',null,os.value,'lead-owner-msg')",
    "doAction(lb,'saveLocation',null,JSON.stringify({ inCanada: yn, country: c }),'lead-loc-msg')", 'hydrateOwnerLocation(d);', "kv('How they reached us'", "'None — added by staff'"]) assert.ok(d.includes(s), s);
  const server = require('fs').readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(server, /createStaffLead\(req\.body \|\| \{\}, \{ actor: staffActor\(req, \(req\.body \|\| \{\}\)\.addedBy\) \}\)/);
});

test('REVIEW: a staff-corrected country reaches the questionnaire pre-fill and the pre-consult form (the column first)', () => {
  const { _internal } = require('../config/questionnairePrefillMap');
  assert.equal(_internal.residenceCountry({ intake: { insideCanada: 'No', currentCountry: 'USA' }, lead: { insideCanada: 'No', country: 'India' } }), 'India');
  assert.equal(_internal.residenceCountry({ intake: { insideCanada: 'Yes' }, lead: { insideCanada: 'Yes', country: 'Canada' } }), 'Canada');
  assert.equal(_internal.residenceCountry({ intake: { insideCanada: 'No', currentCountry: 'USA' }, lead: {} }), 'USA', 'no column → the intake answer');
  const src = require('fs').readFileSync(require.resolve('../src/services/consultationService'), 'utf8');
  assert.ok(src.includes("radio('pc_inCanada', String(lead.insideCanada || '').trim() || A('insideCanada', 'insideCanada'))"));
});

test('REVIEW: Add lead re-checks the Monday sign-in on every open, and a server "Added by" refusal shows the picker again', () => {
  const q = require('../src/routes/adminLeads').buildLeadsQueueHTML();
  assert.ok(q.includes("TDOT_BL.viewer=null;   /* re-check the Monday sign-in every time"));
  assert.ok(q.includes("if(/Added by/.test(String(res.j.error||''))){ AL_SIGNED=false; TDOT_BL.viewer=null; alEl('al-addedby-row').style.display='';"));
});
