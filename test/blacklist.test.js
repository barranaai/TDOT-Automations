'use strict';

// Gauri point 5 (2026-10-08), Faran's decisions 2026-10-15: FOUR outcomes
// (Retain / Follow-Up / Newsletter / Not Wanted); "Not Wanted" puts the person
// on the Not Wanted list — a separate board, one row per person — and staff are
// WARNED (never blocked, the client never sees it) when that email OR phone
// comes back: on the lead and consultation pages, on Add lead, on a direct
// client. Only named admins remove; the row is kept as Removed.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');

const outcomes    = require('../config/outcomes');
const bl          = require('../src/services/blacklistService');
const portal      = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const snap        = require('../src/services/leadSnapshot');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const CFG = { boardId: '18435601112', columns: { emails: 'text_e', phones: 'text_p', reason: 'lt_r', status: 'color_s', leadIds: 'text_l', addedBy: 'text_ab', addedOn: 'date_ao', source: 'text_src', removedBy: 'text_rb', removedOn: 'date_ro', removalReason: 'lt_rr' }, statusLabels: ['Active', 'Removed'] };
const E = (id, o) => ({ id: String(id), name: o.name || `Person ${id}`, emails: o.emails || [], phones: o.phones || [], reason: o.reason || '', status: o.status || 'Active', leadIds: o.leadIds || [], addedBy: o.addedBy || 'Shermin', addedOn: o.addedOn || '2026-10-01', source: o.source || 'portal', removedBy: '', removedOn: '', removalReason: '' });
const ADMIN = { name: 'Faran', email: 'f@tdotimm.com', verified: true };

/** A list with fixed entries; records writes. */
function world(entriesList, { lead } = {}) {
  const calls = { fetches: 0, creates: [], changes: [], notes: [], leadWrites: [] };
  const state = { entries: entriesList.slice(), lead: lead || null };
  bl._setConfig(CFG);
  const restore = [
    stub(bl.io, 'fetchEntries', async () => { calls.fetches++; return state.entries.map((e) => ({ ...e })); }),
    stub(mondayApi, 'query', async (q, vars) => {
      if (/create_update/.test(q)) { calls.notes.push({ id: vars.id, body: vars.b }); return { create_update: { id: 'u' } }; }
      if (/create_item/.test(q)) { calls.creates.push({ name: vars.n, cols: JSON.parse(vars.c) }); return { create_item: { id: '777' } }; }
      if (/change_multiple_column_values/.test(q)) { calls.changes.push({ id: vars.i, cols: JSON.parse(vars.c) }); return { change_multiple_column_values: { id: vars.i } }; }
      return {};
    }),
    stub(leadService, 'getLead', async (id) => (state.lead && String(state.lead.id) === String(id) ? { ...state.lead } : null)),
    stub(leadService, 'updateLead', async (id, fields) => { calls.leadWrites.push({ id, fields }); if (state.lead) Object.assign(state.lead, fields); }),
  ];
  return { calls, state, done: () => { restore.reverse().forEach((r) => r()); bl._reset(); } };
}

/* ── the outcomes ── */

test('outcomes: exactly four, byte-exact; the two retired labels read as their new meaning and are never written', () => {
  assert.deepEqual(outcomes.OUTCOME_LABELS, ['Retain', 'Follow-Up', 'Newsletter', 'Not Wanted']);
  assert.equal(portal.OUTCOME_LABELS, outcomes.OUTCOME_LABELS, 'the portal exports the same list (both pages build their buttons from it)');
  assert.equal(outcomes.canonicalOutcome('Don’t Retain — Ineligible'), 'Follow-Up');
  assert.equal(outcomes.canonicalOutcome('Don’t Retain — Not Wanted'), 'Not Wanted');
  assert.equal(outcomes.canonicalOutcome(' Not Wanted '), 'Not Wanted');
  assert.equal(outcomes.canonicalOutcome('Not wanted'), '', 'a near-miss means nothing');
  assert.equal(outcomes.canonicalOutcome(''), '');
  assert.equal(outcomes.isNotWanted('Don’t Retain — Not Wanted'), true);
  assert.equal(outcomes.isNotWanted('Retain'), false);
  for (const legacy of Object.keys(outcomes.LEGACY_OUTCOMES)) assert.equal(portal.validateAction('outcome', legacy).ok, false, `${legacy} is never written again`);
  // the board-columns script can never re-create the five-label column
  assert.ok(!fs.readFileSync(require.resolve('../scripts/create-leads-board-columns'), 'utf8').includes('Don’t Retain — Ineligible'));
});

test('validate outcome: a label or { label, reason }; Not Wanted needs 3–300 characters of reason; other labels drop a reason; JSON strings are accepted', () => {
  const v = (x) => portal.validateAction('outcome', x);
  assert.deepEqual(v('Follow-Up'), { ok: true, normalized: 'Follow-Up', reason: '' });
  assert.deepEqual(v({ label: 'Follow-Up', reason: 'ignored' }), { ok: true, normalized: 'Follow-Up', reason: '' });
  assert.deepEqual(v(JSON.stringify({ label: 'Not Wanted', reason: 'abusive\n on the call' })), { ok: true, normalized: 'Not Wanted', reason: 'abusive on the call' });
  for (const bad of ['Not Wanted', { label: 'Not Wanted' }, { label: 'Not Wanted', reason: 'ab' }, { label: 'Not Wanted', reason: 'x'.repeat(301) }, '{"label":"Not Wanted"', { label: 'Nope', reason: 'x' }, null, 42]) {
    assert.equal(v(bad).ok, false, JSON.stringify(bad));
  }
  assert.match(v({ label: 'Not Wanted' }).error, /reason/);
});

/* ── the list: reading and matching ── */

test('check: dormant without the board file; matches by email OR phone after normalisation; Removed rows never match; short phones never match; never throws', async () => {
  bl._setConfig(null);
  assert.deepEqual(await bl.check({ email: 'a@b.co', phone: '4165550100' }), { checked: false, hit: false, matchedOn: '', entries: [], dormant: true });
  bl._reset();
  const w = world([
    E(1, { name: 'Alpha', emails: ['alpha@x.com'], phones: ['4165550100'], reason: 'abusive', leadIds: ['101'] }),
    E(2, { name: 'Beta', emails: ['beta@x.com'], phones: [], status: 'Removed' }),
    E(3, { name: 'Gamma', emails: [], phones: ['6475550199'], reason: 'fraud' }),
  ]);
  try {
    const both = await bl.check({ email: ' ALPHA@X.com ', phone: '+1 (416) 555-0100' });
    assert.equal(both.hit, true); assert.equal(both.matchedOn, 'both'); assert.equal(both.checked, true);
    assert.deepEqual(both.entries.map((h) => [h.id, h.matchedOn, h.name, h.reason, h.leadIds]), [['1', 'both', 'Alpha', 'abusive', ['101']]]);
    const emailOnly = await bl.check({ email: 'alpha@x.com', phone: '9055550000' });
    assert.deepEqual([emailOnly.hit, emailOnly.matchedOn, emailOnly.entries[0].matchedOn], [true, 'email', 'email']);
    const phoneOnly = await bl.check({ email: 'new@x.com', phone: '16475550199' });
    assert.deepEqual([phoneOnly.hit, phoneOnly.matchedOn, phoneOnly.entries[0].name], [true, 'phone', 'Gamma']);
    const twoEntries = await bl.check({ email: 'alpha@x.com', phone: '6475550199' });
    assert.deepEqual([twoEntries.matchedOn, twoEntries.entries.map((h) => h.id)], ['both', ['1', '3']], 'email on one row, phone on another → both');
    assert.equal((await bl.check({ email: 'beta@x.com' })).hit, false, 'a Removed row is history');
    assert.equal((await bl.check({ phone: '555-0100' })).hit, false, 'fewer than 10 digits never match');
    assert.deepEqual(await bl.check({}), { checked: false, hit: false, matchedOn: '', entries: [] }.checked === undefined ? null : { checked: true, hit: false, matchedOn: '', entries: [] });
    assert.equal(w.calls.fetches, 1, 'one read, then the cache');
    bl.invalidate();
    await bl.check({ email: 'alpha@x.com' });
    assert.equal(w.calls.fetches, 2, 'invalidate forces a re-read');
  } finally { w.done(); }
  // a failed read: "not checked", never a throw
  bl._setConfig(CFG);
  const r1 = stub(bl.io, 'fetchEntries', async () => { throw new Error('Monday 503'); });
  try {
    const r = await bl.check({ email: 'alpha@x.com' });
    assert.deepEqual([r.checked, r.hit, r.error], [false, false, 'Monday 503']);
  } finally { r1(); bl._reset(); }
});

test('describe: one line for notes and banners', () => {
  assert.equal(bl.describe({ hit: true, matchedOn: 'both', entries: [{ name: 'Alpha', reason: 'abusive', addedBy: 'Shermin', addedOn: '2026-10-01' }] }),
    'On the Not Wanted list — matched by email and phone: Alpha — abusive (added by Shermin on 2026-10-01).');
  assert.equal(bl.describe({ hit: false }), '');
});

/* ── the list: writing ── */

test('addFromLead: a new row with normalised identifiers, the reason, who and when; an existing ACTIVE row for the same person is MERGED (one row per person); nothing new → "exists"; a Removed row is history', async () => {
  const w = world([
    E(1, { name: 'Alpha', emails: ['alpha@x.com'], phones: ['4165550100'], leadIds: ['101'], reason: 'abusive' }),
    E(2, { name: 'Beta', emails: ['beta@x.com'], phones: ['4165550222'], status: 'Removed' }),
  ]);
  try {
    const created = await bl.addFromLead({ lead: { id: '555', fullName: 'New Person', email: 'NEW@Y.com', phone: '(905) 555-0123' }, reason: 'threatened staff', actor: { name: 'Shafoli Kapur', verified: true }, source: 'portal' });
    assert.deepEqual(created, { ok: true, result: 'created', entryId: '777' });
    const c = w.calls.creates[0];
    assert.equal(c.name, 'New Person');
    assert.equal(c.cols.text_e, 'new@y.com'); assert.equal(c.cols.text_p, '9055550123');
    assert.deepEqual(c.cols.lt_r, { text: 'threatened staff' }); assert.deepEqual(c.cols.color_s, { label: 'Active' });
    assert.equal(c.cols.text_l, '555'); assert.equal(c.cols.text_ab, 'Shafoli Kapur'); assert.equal(c.cols.text_src, 'portal');
    assert.match(c.cols.date_ao.date, /^\d{4}-\d{2}-\d{2}$/);
    // same person (phone matches Alpha), new email + new lead → merged into row 1
    const merged = await bl.addFromLead({ lead: { id: '556', fullName: 'Alpha Again', email: 'alpha2@x.com', phone: '14165550100' }, reason: 'again', actor: { name: 'Melanie', verified: false } });
    assert.deepEqual(merged, { ok: true, result: 'merged', entryId: '1' });
    assert.deepEqual(w.calls.changes[0], { id: '1', cols: { text_e: 'alpha@x.com, alpha2@x.com', text_p: '4165550100', text_l: '101, 556' } }, 'identifiers and the lead id are added; the original reason is kept');
    // nothing new → exists (no write)
    const n = w.calls.changes.length;
    const again = await bl.addFromLead({ lead: { id: '101', fullName: 'Alpha', email: 'alpha@x.com', phone: '4165550100' }, reason: 'x', actor: { name: 'M', verified: false } });
    assert.deepEqual(again, { ok: true, result: 'exists', entryId: '1' });
    assert.equal(w.calls.changes.length, n);
    // Beta was Removed → a NEW row
    const beta = await bl.addFromLead({ lead: { id: '9', fullName: 'Beta', email: 'beta@x.com', phone: '4165550222' }, reason: 'back again', actor: { name: 'M', verified: false } });
    assert.equal(beta.result, 'created');
    assert.equal(w.calls.creates.length, 2);
    // no usable identifier → refused (badRequest), nothing written
    await assert.rejects(bl.addFromLead({ lead: { id: '7', fullName: 'Nobody', email: 'junk', phone: '12345' }, reason: 'x' }), (e) => e.badRequest === true);
    assert.equal(w.calls.creates.length, 2);
  } finally { w.done(); }
  bl._setConfig(null);
  await assert.rejects(bl.addFromLead({ lead: { id: '1', email: 'a@b.co' }, reason: 'x' }), (e) => e.dormant === true);
  bl._reset();
});

test('addFromLeadId (webhook / sweep): re-reads the lead and adds only when its outcome really is Not Wanted (the retired label counts)', async () => {
  const w = world([], { lead: { id: '300', fullName: 'Hand Edited', email: 'h@x.com', phone: '4165550300', outcome: 'Don’t Retain — Not Wanted' } });
  try {
    const r = await bl.addFromLeadId('300', { source: 'monday' });
    assert.deepEqual(r, { ok: true, result: 'created', entryId: '777' });
    assert.equal(w.calls.creates[0].cols.text_src, 'monday');
    assert.equal(w.calls.creates[0].cols.text_ab, 'set in Monday', 'no person is known on the webhook path');
    w.state.lead.outcome = 'Follow-Up';
    assert.deepEqual(await bl.addFromLeadId('300'), { ok: false, result: 'not-not-wanted', outcome: 'Follow-Up' });
    assert.deepEqual(await bl.addFromLeadId('999'), { ok: false, result: 'no-lead' });
    assert.equal(w.calls.creates.length, 1);
  } finally { w.done(); }
});

test('remove: a NAMED admin with a reason; the row becomes Removed with who/when/why (never deleted); the leads get a note; not-found / already-removed / no reason / not an admin are refused', async () => {
  const w = world([E(1, { name: 'Alpha', leadIds: ['101', '102'] }), E(2, { name: 'Beta', status: 'Removed' })]);
  try {
    const r = await bl.remove({ entryId: '1', reason: 'apologised; the RCIC agreed to take the case', actor: ADMIN });
    assert.deepEqual(r, { ok: true, entryId: '1', name: 'Alpha', leadIds: ['101', '102'] });
    assert.deepEqual(w.calls.changes[0].cols, { color_s: { label: 'Removed' }, text_rb: 'Faran', date_ro: w.calls.changes[0].cols.date_ro, lt_rr: { text: 'apologised; the RCIC agreed to take the case' } });
    assert.match(w.calls.changes[0].cols.date_ro.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(w.calls.notes.map((n) => n.id), ['101', '102']);
    assert.match(w.calls.notes[0].body, /✅ <b>Removed from the Not Wanted list<\/b> by Faran — reason: apologised; the RCIC agreed to take the case\./);
    for (const [args, re] of [
      [{ entryId: '2', reason: 'why not', actor: ADMIN }, /already removed/],
      [{ entryId: '404', reason: 'why not', actor: ADMIN }, /not on the list/],
      [{ entryId: '1', reason: '', actor: ADMIN }, /reason/],
      [{ entryId: '1', reason: 'why not', actor: { name: 'Melanie', verified: false } }, /named admin/],
    ]) await assert.rejects(bl.remove(args), (e) => re.test(e.message));
    assert.equal(w.calls.changes.length, 1);
  } finally { w.done(); }
});

test('sweep: every Not Wanted lead the list does not cover is added after a FRESH re-read; covered leads are skipped; failures are counted, never thrown', async () => {
  snap._reset();
  const w = world([E(1, { name: 'Covered', emails: ['c@x.com'], leadIds: ['1'] })], { lead: { id: '2', fullName: 'Uncovered', email: 'u@x.com', phone: '4165550002', outcome: 'Not Wanted' } });
  const rs = stub(snap.io, 'fetchLeads', async () => [
    { id: '1', fullName: 'Covered', outcome: 'Not Wanted' },
    { id: '2', fullName: 'Uncovered', outcome: 'Not Wanted' },
    { id: '3', fullName: 'Gone', outcome: 'Don’t Retain — Not Wanted' },   // getLead → null (deleted since the snapshot)
    { id: '4', fullName: 'Other', outcome: 'Retain' },
  ]);
  try {
    const r = await bl.sweep();
    assert.deepEqual(r, { candidates: 3, added: 1, failed: 0 });
    assert.equal(w.calls.creates.length, 1); assert.equal(w.calls.creates[0].cols.text_l, '2'); assert.equal(w.calls.creates[0].cols.text_src, 'sweep');
  } finally { rs(); w.done(); snap._reset(); }
  bl._setConfig(null);
  assert.deepEqual(await bl.sweep(), { skipped: 'dormant' });
  bl._reset();
});

/* ── the outcome action ── */

function actionWorld(lead) {
  const w = world([], { lead });
  const added = [];
  const ra = stub(bl, 'addFromLead', async (o) => { added.push(o); return { ok: true, result: 'created', entryId: '777' }; });
  const rn = stub(portal, 'notifyOutcomeChange', async (o) => { w.calls.notified = o; return { sent: false }; });
  return { ...w, added, done: () => { ra(); rn(); w.done(); } };
}

test('apply Not Wanted: writes the outcome, notes the reason and the VERIFIED name, notifies, adds the person to the list; Follow-Up stays a plain write', async () => {
  const w = actionWorld({ id: '555', fullName: 'Test Person', email: 'tp@x.com', phone: '4165550555', outcome: '', bookingStatus: 'Booked', bookedSlot: '2020-01-01 10:00' });
  try {
    const r = await portal.applyAction({ leadId: '555', action: 'outcome', value: { label: 'Not Wanted', reason: 'abusive on the call' }, staffName: 'Typed Name', actor: { name: 'Shermin Teymouri Mofrad', email: 's@tdotimm.com', verified: true } });
    assert.equal(r.ok, true);
    assert.equal(r.message, 'Outcome recorded: Not Wanted. They are now on the Not Wanted list — staff will be warned if they come back.');
    assert.deepEqual(w.calls.leadWrites, [{ id: '555', fields: { outcome: 'Not Wanted' } }]);
    assert.equal(w.calls.notes.length, 1, 'no live-item note: the booking is in the past');
    assert.match(w.calls.notes[0].body, /Outcome set to “Not Wanted” by Shermin Teymouri Mofrad — reason: abusive on the call\./);
    assert.equal(w.calls.notified.staffName, 'Shermin Teymouri Mofrad');
    assert.equal(w.added.length, 1);
    assert.deepEqual([w.added[0].lead.id, w.added[0].reason, w.added[0].actor, w.added[0].source], ['555', 'abusive on the call', { name: 'Shermin Teymouri Mofrad', verified: true }, 'portal']);
    // a plain label: unchanged behaviour, typed name used when nobody is signed in
    const r2 = await portal.applyAction({ leadId: '555', action: 'outcome', value: 'Follow-Up', staffName: 'Melanie', actor: { name: 'Melanie', email: '', verified: false } });
    assert.equal(r2.message, 'Outcome recorded: Follow-Up.');
    assert.match(w.calls.notes[1].body, /Outcome set to “Follow-Up” by Melanie\.$/);
    assert.equal(w.added.length, 1);
  } finally { w.done(); }
});

test('apply Not Wanted: a live retainer and an upcoming booking are NOT cancelled — the lead gets a note saying what is still live; a failed list add posts a retry note and the message says so', async () => {
  const future = new Date(Date.now() + 3 * 86400000);
  const slot = `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(future)} 10:00`;
  const w = actionWorld({ id: '556', fullName: 'Live Person', email: 'lp@x.com', phone: '4165550556', outcome: '', bookingStatus: 'Booked', bookedSlot: slot, retainerSent: '2026-10-10' });
  const rf = stub(bl, 'addFromLead', async () => { throw new Error('Monday 503'); });
  try {
    const r = await portal.applyAction({ leadId: '556', action: 'outcome', value: { label: 'Not Wanted', reason: 'fraudulent documents' }, staffName: 'Melanie', actor: { name: 'Melanie', verified: false } });
    assert.match(r.message, /could not be added to the Not Wanted list just now — the list is checked every 15 minutes/);
    assert.match(r.message, /a retainer and a booking are still live/);
    const bodies = w.calls.notes.map((n) => n.body);
    assert.match(bodies[1], /⚠ Not Wanted, but the retainer agreement sent 2026-10-10 is still live — if the client signs it, the case opens\. Void it in Documenso if that is not intended\. Also, the consultation booked for .* still stands and its reminders will still go out — cancel it in Square if that is intended\./);
    assert.match(bodies[2], /⚠ Not added to the Not Wanted list yet \(Monday 503\) — the 15-minute check will retry\./);
    assert.deepEqual(w.calls.leadWrites.map((x) => x.fields), [{ outcome: 'Not Wanted' }], 'only the outcome is written — nothing is cancelled');
  } finally { rf(); w.done(); }
  // signed retainer: nothing is "still live" about the agreement
  const w2 = actionWorld({ id: '557', fullName: 'Signed', email: 's@x.com', phone: '4165550557', retainerSent: '2026-10-01', retainerSigned: '2026-10-02' });
  try {
    await portal.applyAction({ leadId: '557', action: 'outcome', value: { label: 'Not Wanted', reason: 'later problems' }, staffName: 'M', actor: { name: 'M', verified: false } });
    assert.equal(w2.calls.notes.length, 1);
  } finally { w2.done(); }
});

test('apply Not Wanted with the list dormant: the outcome is still recorded and the message says nobody will be warned', async () => {
  const w = actionWorld({ id: '558', fullName: 'Dormant Case', email: 'd@x.com', phone: '4165550558' });
  bl._setConfig(null);
  try {
    const r = await portal.applyAction({ leadId: '558', action: 'outcome', value: { label: 'Not Wanted', reason: 'rude' }, staffName: 'M', actor: { name: 'M', verified: false } });
    assert.match(r.message, /The Not Wanted list is not set up on this server/);
    assert.equal(w.added.length, 0);
  } finally { w.done(); }
});

/* ── the warnings where staff look ── */

test('Add lead: a hit answers 409 with the warning (no duplicate needed); "create anyway" creates, notes the lead and returns the warning; the check runs on every submit', async () => {
  const created = []; const notes = [];
  bl._setConfig(CFG);
  const restore = [
    stub(bl.io, 'fetchEntries', async () => [E(1, { name: 'Alpha', emails: ['caller@x.com'], reason: 'abusive' })]),
    stub(portal, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] })),
    stub(leadService, 'createLead', async (f) => { created.push(f); return { id: '9100', ...f }; }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.b); return {}; }),
  ];
  const VALID = { fullName: 'Phone Caller', email: 'Caller@x.com', phone: '4165550001', sourceChannel: 'Phone', residentialAddress: '12 King St W, Toronto' };
  try {
    await assert.rejects(portal.createStaffLead(VALID), (e) => e.conflict === true && e.blacklist.hit === true && e.blacklist.matchedOn === 'email' && e.matches.leads.length === 0 && /Not Wanted list/.test(e.message));
    assert.equal(created.length, 0);
    const r = await portal.createStaffLead({ ...VALID, allowDuplicate: true });
    assert.equal(r.leadId, '9100'); assert.equal(r.blacklist.hit, true);
    assert.equal(created.length, 1);
    assert.ok(notes.some((b) => /⛔ <b>On the Not Wanted list — matched by email: Alpha — abusive/.test(b) && /Staff saw the warning and added this lead anyway\./.test(b)), notes.join('\n'));
    const r2 = await portal.createStaffLead({ ...VALID, email: 'someone.else@x.com', phone: '9055550000' });
    assert.equal(r2.blacklist.hit, false, 'no hit → no 409, created at once');
  } finally { restore.reverse().forEach((x) => x()); bl._reset(); }
});

test('Direct client (retained at creation): a hit with no choice answers 409 with the warning; "create anyway" creates and notes; a failed list read never blocks', async () => {
  const registry = require('../src/services/caseTypeRegistryService');
  const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');
  const CASE_TYPE = CASE_TYPE_LABELS.find((t) => !(SUB_TYPES_BY_CASE[t] || []).length);
  const CONSULTANT = Object.values(require('../config/consultantRouting').CONSULTANTS)[0].name;
  const notes = []; let created = 0;
  bl._setConfig(CFG);
  const restore = [
    stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
    stub(bl.io, 'fetchEntries', async () => [E(1, { name: 'Alpha', phones: ['4165550100'], reason: 'fraud', addedBy: 'Shafoli Kapur', addedOn: '2026-10-02' })]),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(portal, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] })),
    stub(leadService, 'createLead', async (f) => { created++; return { id: '900', ...f }; }),
    stub(leadService, 'updateLead', async () => {}),
    stub(require('../src/services/handoffService'), 'openCaseEarly', async () => '555'),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.b); return {}; }),
  ];
  const body = { fullName: 'Walkin Client', email: 'walkin@example.com', phone: '+1 416 555 0100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT };
  try {
    await assert.rejects(portal.createDirectClient(body), (e) => e.conflict === true && e.blacklist.hit === true && e.blacklist.matchedOn === 'phone' && /Not Wanted list/.test(e.message));
    // review 2026-10-15: "create anyway" / link chosen in the duplicate panel is NOT the acknowledgement — the warning must be seen
    await assert.rejects(portal.createDirectClient({ ...body, allowDuplicate: true }), (e) => e.conflict === true && e.blacklist.hit === true);
    await assert.rejects(portal.createDirectClient({ ...body, linkLeadId: '123' }), (e) => e.conflict === true && e.blacklist.hit === true);
    assert.equal(created, 0);
    const r = await portal.createDirectClient({ ...body, allowDuplicate: true, blacklistAck: true });
    assert.equal(r.ok, true); assert.equal(r.leadId, '900'); assert.equal(r.blacklist.hit, true);
    assert.ok(notes.some((b) => /⛔ <b>On the Not Wanted list — matched by phone: Alpha — fraud \(added by Shafoli Kapur on 2026-10-02\)\.<\/b> Staff saw the warning and created this direct retainer client anyway\./.test(b)), notes.join('\n'));
  } finally { restore.reverse().forEach((x) => x()); bl._reset(); }
  // the list unreadable → created without a word about the list (checked:false travels with the result)
  bl._setConfig(CFG);
  const restore2 = [
    stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
    stub(bl.io, 'fetchEntries', async () => { throw new Error('Monday 503'); }),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(portal, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] })),
    stub(leadService, 'createLead', async (f) => ({ id: '901', ...f })),
    stub(leadService, 'updateLead', async () => {}),
    stub(require('../src/services/handoffService'), 'openCaseEarly', async () => '556'),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await portal.createDirectClient(body);
    assert.equal(r.ok, true); assert.deepEqual([r.blacklist.checked, r.blacklist.error], [false, 'Monday 503']);
  } finally { restore2.reverse().forEach((x) => x()); bl._reset(); }
});

test('detail payloads: the lead page and the consultation page carry the check result', async () => {
  bl._setConfig(CFG);
  const restore = [
    stub(bl.io, 'fetchEntries', async () => [E(1, { name: 'Alpha', emails: ['alpha@x.com'], reason: 'abusive' })]),
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Alpha', email: 'alpha@x.com', phone: '4165550100', bookingStatus: 'Booked', inviteMessage: 'x' })),
  ];
  try {
    const c = await portal.getConsultationDetail('1');
    assert.deepEqual([c.blacklist.checked, c.blacklist.hit, c.blacklist.matchedOn, c.blacklist.entries[0].name], [true, true, 'email', 'Alpha']);
    const l = await portal.getLeadDetail('1');
    assert.deepEqual([l.blacklist.checked, l.blacklist.hit, l.blacklist.matchedOn], [true, true, 'email']);
  } finally { restore.reverse().forEach((x) => x()); bl._reset(); }
});

/* ── wiring: webhook, sweep, the admin route, the pages ── */

test('wiring: the Lead Board webhook adds on a hand-set Not Wanted (re-reading the lead); the sweep runs every 15 min; removal is a NAMED-admin route with its own wording; the payment wording is unchanged', () => {
  const phase2 = fs.readFileSync(require.resolve('../src/routes/phase2'), 'utf8');
  assert.match(phase2, /else if \(require\('\.\.\/\.\.\/config\/outcomes'\)\.isNotWanted\(outcome\)\) \{[\s\S]*?blacklistService'\)\.addFromLeadId\(String\(event\.pulseId\), \{ source: 'monday' \}\)/);
  const sched = fs.readFileSync(require.resolve('../src/services/scheduler'), 'utf8');
  assert.match(sched, /cron\.schedule\('3,18,33,48 \* \* \* \*', \(\) =>[\s\S]*?blacklistService'\)\.sweep\(\)/);
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(server, /app\.post\('\/admin\/blacklist\/:entryId\/remove', express\.json\(\), async \(req, res\) => \{\s*const r = require\('\.\/utils\/staffIdentity'\)\.namedAdminCheck\(tryStaffAuth\(req\), caseAccess\.isAdminEmail,\s*\{ what: 'remove someone from the Not Wanted list', hint: 'Ask an admin to do it\.' \}\);/);
  const { namedAdminCheck } = require('../src/utils/staffIdentity');
  assert.equal(namedAdminCheck(null, () => true, { what: 'remove someone from the Not Wanted list', hint: 'Ask an admin to do it.' }).error, 'Sign in with Monday to remove someone from the Not Wanted list — the shared admin key doesn’t say who you are.');
  assert.equal(namedAdminCheck({ email: 'k@x.com', name: 'K' }, () => false, { what: 'remove someone from the Not Wanted list', hint: 'Ask an admin to do it.' }).error, 'Only admins can remove someone from the Not Wanted list. Ask an admin to do it.');
  assert.equal(namedAdminCheck(null, () => true).error, 'Sign in with Monday to change a payment record — the shared admin key doesn’t say who you are.');
  assert.equal(namedAdminCheck({ email: 'k@x.com', name: 'K' }, () => false).error, 'Only admins can change a payment record. Use “Flag as wrong” to alert them.');
  assert.ok(!fs.existsSync(require.resolve('../src/data/blacklistBoard.json')) || require('../src/data/blacklistBoard.json').boardId === '18435601112', 'the live board');
});

test('pages: four outcome buttons (Retain stays in the retainer panel); "Not Wanted" opens the reason dialog; the banner slot, the dialogs and the Add-lead / direct-client warning blocks are emitted; every script parses; no retired label anywhere', () => {
  const ac = require('../src/routes/adminConsultation'), al = require('../src/routes/adminLeads');
  const pages = { cq: ac.buildQueueHTML(), cd: ac.buildDetailHTML('555'), lq: al.buildLeadsQueueHTML(), ld: al.buildLeadDetailHTML('555') };
  for (const [k, html] of Object.entries(pages)) {
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
    assert.ok(!/Ineligible|Don’t Retain/.test(html), `${k}: no retired label`);
  }
  for (const html of [pages.cd, pages.ld]) {
    for (const s of ['var OUTCOMES=["Retain","Follow-Up","Newsletter","Not Wanted"];', 'var OUTCOME_NOT_WANTED="Not Wanted";', 'id="bl-banner"', 'function tdotOpenNotWantedModal(o){', 'function tdotOpenBlacklistRemoveModal(entryId, name, onDone){', 'function tdotBlacklistHtml(r, opts){',
      "if(label===OUTCOME_NOT_WANTED){ tdotOpenNotWantedModal({", "JSON.stringify({label:label, reason:reason})", "fetch('/admin/blacklist/' + encodeURIComponent(entryId) + '/remove'", 'canRemove:true', '.blw {']) assert.ok(html.includes(s), s);
  }
  for (const s of ['id="dc-blacklist"', 'function dcRenderBlacklist(r){', 'id="dc-bl-ack"', 'dcRenderBlacklist(res.j.blacklist);', "tick the box above if you mean to set them up anyway", 'DC_BL_HIT=false; var blb=dcEl']) assert.ok(pages.cq.includes(s), s);
  for (const s of ['var bl=tdotBlacklistHtml(res.j.blacklist,{leadLinks:true});', 'To add this person anyway, click <b>Create lead</b> again.']) assert.ok(pages.lq.includes(s), s);
  assert.ok(pages.cq.includes('set Retain / Follow-Up / Newsletter / Not Wanted.'), 'the Needs-outcome banner names the four');
});

/* ── review 2026-10-15 (wf_42394dfd-c57): the fixes ── */

test('REVIEW: the 409 body carries the Not Wanted warning with the duplicates (both create routes use one helper); the duplicate lookup returns it too', () => {
  const err = Object.assign(new Error('This person is on the Not Wanted list.'), { conflict: true, matches: { leads: [], cases: [], clients: [] }, blacklist: { checked: true, hit: true, matchedOn: 'email', entries: [{ id: '1', name: 'Alpha' }] } });
  assert.deepEqual(portal.conflictBody(err), { error: 'This person is on the Not Wanted list.', matches: { leads: [], cases: [], clients: [] }, blacklist: err.blacklist });
  assert.deepEqual(portal.conflictBody(Object.assign(new Error('dup'), { conflict: true, matches: { leads: [{ id: '2' }], cases: [], clients: [] } })), { error: 'dup', matches: { leads: [{ id: '2' }], cases: [], clients: [] } });
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.equal((server.match(/if \(err\.conflict\)\s+return res\.status\(409\)\.json\(consultantPortalService\.conflictBody\(err\)\);/g) || []).length, 2, 'Add lead and direct client');
  assert.ok(!/status\(409\)\.json\(\{ error: err\.message, matches: err\.matches \}\)/.test(server), 'no route drops the warning any more');
  assert.match(server, /findClientMatches\(\{ email, phone \}\),\s*require\('\.\/services\/blacklistService'\)\.check\(\{ email, phone \}\),[\s\S]*?res\.json\(\{ \.\.\.matches, blacklist \}\);/);
});

test('REVIEW: an admin removal STANDS — the sweep and the webhook never re-add a lead a Removed row names; a consultant\'s fresh portal decision lists the person again (a new row)', async () => {
  snap._reset();
  const w = world([E(1, { name: 'Alpha', emails: ['a@x.com'], leadIds: ['10'], status: 'Removed' })], { lead: { id: '10', fullName: 'Alpha', email: 'a@x.com', phone: '4165550010', outcome: 'Not Wanted' } });
  const rs = stub(snap.io, 'fetchLeads', async () => [{ id: '10', fullName: 'Alpha', outcome: 'Not Wanted' }]);
  try {
    assert.deepEqual(await bl.sweep(), { candidates: 1, added: 0, failed: 0 });
    assert.deepEqual(await bl.addFromLeadId('10', { source: 'monday' }), { ok: true, result: 'removed-by-admin', entryId: '1' });
    assert.deepEqual(await bl.addFromLeadId('10', { source: 'sweep' }), { ok: true, result: 'removed-by-admin', entryId: '1' });
    assert.equal(w.calls.creates.length, 0, 'nothing re-added');
    const r = await bl.addFromLead({ lead: w.state.lead, reason: 'new incident', actor: { name: 'Shermin', verified: true }, source: 'portal' });
    assert.equal(r.result, 'created');
    assert.equal(w.calls.creates.length, 1);
  } finally { rs(); w.done(); snap._reset(); }
});

test('REVIEW: one add per lead — the portal add and its webhook echo never make two rows; a webhook-made row is COMPLETED by the portal\'s reason and name', async () => {
  // concurrent: both start before either writes
  const w = world([], { lead: { id: '20', fullName: 'Beta', email: 'b@x.com', phone: '4165550020', outcome: 'Not Wanted' } });
  const origFetch = bl.io.fetchEntries;
  bl.io.fetchEntries = async () => { w.calls.fetches++; await new Promise((r) => setTimeout(r, 5)); return w.state.entries.map((e) => ({ ...e })); };
  const origQuery = mondayApi.query;
  mondayApi.query = async (q, vars) => {
    const out = await origQuery(q, vars);
    if (/create_item/.test(q)) { const c = JSON.parse(vars.c); w.state.entries.push(E('777', { name: vars.n, emails: c.text_e ? c.text_e.split(', ') : [], phones: c.text_p ? c.text_p.split(', ') : [], leadIds: c.text_l.split(', '), reason: (c.lt_r || {}).text || '', addedBy: c.text_ab, source: c.text_src })); }
    if (/change_multiple_column_values/.test(q)) { const c = JSON.parse(vars.c); const en = w.state.entries.find((x) => x.id === String(vars.i)); if (en) { if (c.lt_r) en.reason = c.lt_r.text; if (c.text_ab) en.addedBy = c.text_ab; if (c.text_src) en.source = c.text_src; } }
    return out;
  };
  try {
    const [a, b] = await Promise.all([
      bl.addFromLead({ lead: w.state.lead, reason: 'abusive', actor: { name: 'Shermin', verified: true }, source: 'portal' }),
      bl.addFromLeadId('20', { source: 'monday' }),
    ]);
    assert.deepEqual([a.result, b.result], ['created', 'exists']);
    assert.equal(w.calls.creates.length, 1, 'ONE row');
    assert.equal(w.state.entries[0].reason, 'abusive');
    // the other order: the webhook got there first (no reason, "set in Monday") — the portal completes it
    w.state.entries.length = 0; w.calls.creates.length = 0; w.calls.changes.length = 0;
    await bl.addFromLeadId('20', { source: 'monday' });
    assert.equal(w.state.entries[0].addedBy, 'set in Monday');
    const c = await bl.addFromLead({ lead: w.state.lead, reason: 'abusive', actor: { name: 'Shermin', verified: true }, source: 'portal' });
    assert.equal(c.result, 'updated');
    assert.equal(w.calls.creates.length, 1, 'still ONE row');
    assert.deepEqual(w.calls.changes[0].cols, { lt_r: { text: 'abusive' }, text_ab: 'Shermin', text_src: 'portal' });
    assert.equal(w.state.entries[0].reason, 'abusive');
  } finally { bl.io.fetchEntries = origFetch; mondayApi.query = origQuery; w.done(); }
});

test('REVIEW: the portal puts the person on the list BEFORE writing the outcome (so the webhook echo finds them); a failed add is retried once after the write', async () => {
  const order = [];
  const w = actionWorld({ id: '30', fullName: 'Gamma', email: 'g@x.com', phone: '4165550030' });
  const r1 = stub(bl, 'addFromLead', async () => { order.push('list'); return { ok: true, result: 'created', entryId: '1' }; });
  const r2 = stub(leadService, 'updateLead', async (id, f) => { order.push('outcome'); w.calls.leadWrites.push({ id, fields: f }); });
  try {
    await portal.applyAction({ leadId: '30', action: 'outcome', value: { label: 'Not Wanted', reason: 'rude to staff' }, staffName: 'M', actor: { name: 'M', verified: false } });
    assert.deepEqual(order, ['list', 'outcome']);
  } finally { r2(); r1(); w.done(); }
  // first add fails, the retry after the write succeeds — no failure note
  const order2 = []; let n = 0;
  const w2 = actionWorld({ id: '31', fullName: 'Delta', email: 'd@x.com', phone: '4165550031' });
  const r3 = stub(bl, 'addFromLead', async () => { order2.push('list'); if (++n === 1) throw new Error('Monday 503'); return { ok: true, result: 'updated', entryId: '1' }; });
  const r4 = stub(leadService, 'updateLead', async () => { order2.push('outcome'); });
  try {
    const r = await portal.applyAction({ leadId: '31', action: 'outcome', value: { label: 'Not Wanted', reason: 'rude to staff' }, staffName: 'M', actor: { name: 'M', verified: false } });
    assert.deepEqual(order2, ['list', 'outcome', 'list']);
    assert.match(r.message, /They are on the Not Wanted list\./);
    assert.ok(!w2.calls.notes.some((x) => /Not added to the Not Wanted list yet/.test(x.body)));
  } finally { r4(); r3(); w2.done(); }
});

test('REVIEW: the list copy is generation-stamped — a read that began before a write never repopulates the cache', async () => {
  bl._setConfig(CFG);
  let release; const rows = [[E(1, { name: 'Old', emails: ['o@x.com'] })], [E(1, { name: 'Old', emails: ['o@x.com'], status: 'Removed' })]];
  let call = 0;
  const r = stub(bl.io, 'fetchEntries', () => { const i = call++; if (i === 0) return new Promise((res) => { release = () => res(rows[0]); }); return Promise.resolve(rows[1]); });
  try {
    const slow = bl.check({ email: 'o@x.com' });       // read #1 starts (sees Active)
    await new Promise((x) => setImmediate(x));
    bl.invalidate();                                    // an admin removal lands meanwhile
    release();
    await slow;
    const after = await bl.check({ email: 'o@x.com' }); // must NOT be served the pre-removal copy
    assert.equal(after.hit, false);
    assert.equal(call, 2);
  } finally { r(); bl._reset(); }
});

test('REVIEW: the direct-client modal shows the warning at lookup time, asks for the tick on EVERY hit, sends blacklistAck, and resets between openings; the dialog script has no backslash', () => {
  const ac = require('../src/routes/adminConsultation');
  const q = ac.buildQueueHTML();
  for (const s of [
    ".then(function(m){ if(m && seq===DC_MATCH_SEQ){ dcRenderMatches(m); dcRenderBlacklist(m.blacklist); } })",
    "box.innerHTML=html+(DC_BL_HIT?'<label",
    "if(DC_BL_HIT){\n    var ack=dcEl('dc-bl-ack');",
    'body.blacklistAck=true;',
    "DC_BL_HIT=false; var blb=dcEl('dc-blacklist'); if(blb){ blb.style.display='none'; blb.innerHTML=''; }\n  // A carried profile",
  ]) assert.ok(q.includes(s), s);
  assert.ok(!require('../src/routes/adminShared').BLACKLIST_UI_JS.includes(String.fromCharCode(92)), 'no backslash in the emitted dialog script');
});
