// Consultation notes on the CASE page (plan case-notes, Faran's answers 2026-11-15; switch CASE_NOTES_PANEL).
//   step 0 — today's postConsultNotes behaviour, pinned (described, not changed)
//   step 1 — caseLeadSet / readLeadEntries / the GET route (light access, 503 rule, no-store)
//   step 2 — the panel on the case page (switch off = the page as before), the widget's script rules
//   step 3 — the POST route (Monday sign-in, leadId in the set, claimants) and the widget's one unsaved hook
//   step 7 — Otter entries the app filed, on their card
// Offline: Monday is stubbed (the no-network guard backs it). Every name and id here is invented.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');
const fs     = require('node:fs');

const mondayApi = require('../src/services/mondayApi');
const updates   = require('../src/services/updatesService');
const svc       = require('../src/services/caseNotesService');
const routes    = require('../src/routes/caseNotesRoutes');
const W         = require('../src/routes/caseNotesWidget');
const htmlQ     = require('../src/services/htmlQuestionnaireService');
const leadSvc   = require('../src/services/leadService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
function withEnv(vars, fn) {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const back = () => { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } };
  try { const r = fn(); if (r && typeof r.then === 'function') return r.finally(back); back(); return r; } catch (e) { back(); throw e; }
}

/* ══ step 0: today's postConsultNotes, pinned ═══════════════════════════════ */

function fakeMonday() {
  const store = []; const posted = []; let n = 0;
  const textBody = (b) => b.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const query = async (q, v) => {
    if (/create_update/.test(q)) { posted.push(v.b); n++; store.unshift({ id: String(100 + n), text_body: textBody(v.b), body: v.b, created_at: `2026-11-10T10:0${n}:00Z` }); return { create_update: { id: String(100 + n) } }; }
    return { items: [{ updates: store.slice() }] };
  };
  return { query, posted, store };
}

test('step 0 (today, described): A → B → A — the third save is taken as "already there" and nothing is posted', async () => {
  updates._resetConsultNotesGuard();
  const m = fakeMonday(); const r = stub(mondayApi, 'query', m.query);
  try {
    assert.deepEqual(await updates.postConsultNotes('123', { body: 'Version A', staffName: 'Gauri' }), { ok: true, updated: false });
    updates._resetConsultNotesGuard();
    assert.deepEqual(await updates.postConsultNotes('123', { body: 'Version B', staffName: 'Gauri' }), { ok: true, updated: true });
    updates._resetConsultNotesGuard();
    assert.deepEqual(await updates.postConsultNotes('123', { body: 'Version A', staffName: 'Gauri' }), { ok: true, already: true }, 'A again matches the earlier A entry — dropped (add-only: the B entry stays the newest)');
    assert.equal(m.posted.length, 2);
  } finally { r(); }
});

test('step 0 (today, described): a save that differs only in spacing is taken as "already there"', async () => {
  updates._resetConsultNotesGuard();
  const m = fakeMonday(); const r = stub(mondayApi, 'query', m.query);
  try {
    await updates.postConsultNotes('123', { body: 'Passport expires June 11', staffName: 'Gauri' });
    updates._resetConsultNotesGuard();
    assert.deepEqual(await updates.postConsultNotes('123', { body: 'Passport  expires\nJune11', staffName: 'Gauri' }), { ok: true, already: true });
    assert.equal(m.posted.length, 1);
    // what the case page posts is still a staff-typed entry: the marker readers skip it
    assert.equal(updates.isStaffTypedEntry(m.posted[0]), true);
  } finally { r(); }
});

/* ══ step 1: caseLeadSet ══════════════════════════════════════════════════════ */

const L = (id, o = {}) => ({ id: String(id), name: o.fullName || 'Asha Sample', fullName: 'Asha Sample', clientMasterItemId: '', bookedSlot: '', consultationHeld: '', assignedConsultant: 'Consultant One', consultOption: '', directClient: '', sourceChannel: 'Website form', caseDeleted: '', createdAt: '2026-10-01', ...o });
const dc = (caseRef) => JSON.stringify({ directConsult: { kind: 'Existing client', inSquare: true, caseRef } });

function stubSet({ linked = [], snapshot = null, live = {}, recordUrl } = {}) {
  const reads = [];
  const rs = [
    stub(svc.io, 'findLinked', async (id) => { reads.push(['linked', id]); if (linked instanceof Error) throw linked; return linked; }),
    stub(svc.io, 'snapshotLeads', () => snapshot),
    stub(svc.io, 'getLead', async (id) => { reads.push(['live', String(id)]); return live[String(id)] || null; }),
    stub(svc.io, 'query', async (q) => { reads.push(['row']); return { items: [{ id: '900', state: 'active', board: { id: require('../config/monday').clientMasterBoardId }, column_values: recordUrl ? [{ id: 'link_mm8txy20', value: JSON.stringify({ url: recordUrl }) }] : [] }] }; }),
  ];
  return { reads, restore: () => rs.reverse().forEach((r) => r()) };
}

test('caseLeadSet: every linked lead, newest consultation first; same person spelled differently is one claimant', async () => {
  const s = stubSet({ linked: [L(1, { bookedSlot: '2026-09-01 10:00' }), L(2, { bookedSlot: '2026-11-01 10:00', fullName: '  asha   SAMPLE ' }), L(1)] });
  try {
    const r = await svc.caseLeadSet('900', '2026-EE-900', { recordUrl: '' });
    assert.deepEqual(r.leads.map((l) => l.leadId), ['2', '1'], 'de-duplicated, newest first');
    assert.equal(r.multipleClaimants, false);
    assert.equal(r.leads[0].kind, 'booked');
    assert.deepEqual(Object.keys(r.leads[0]).sort(), ['bookedSlot', 'clientId', 'clientName', 'consultant', 'consultationHeld', 'kind', 'leadId', 'via']);
  } finally { s.restore(); }
});

test('caseLeadSet: the lead email only when asked (the Emails tab, withEmail) — the notes panel\'s set and its cards never carry one', async () => {
  const s = stubSet({ linked: [L(1, { email: 'asha.sample@example.test' })] });
  try {
    const plain = await svc.caseLeadSet('900', '2026-EE-900', { recordUrl: '' });
    assert.ok(!('email' in plain.leads[0]), 'the notes panel\'s set: no email (the pinned keys above)');
    const withEmail = await svc.caseLeadSet('900', '2026-EE-900', { recordUrl: '', withEmail: true });
    assert.deepEqual(Object.keys(withEmail.leads[0]).sort(), ['bookedSlot', 'clientId', 'clientName', 'consultant', 'consultationHeld', 'email', 'kind', 'leadId', 'via']);
    assert.equal(withEmail.leads[0].email, 'asha.sample@example.test');
    assert.ok(!('email' in routes.cardOf(withEmail.leads[0])), 'a card whitelists its fields: an email never reaches the panel');
  } finally { s.restore(); }
});

test('readCaseRow: extra columns (the Emails tab) come back as texts from the SAME read; without them the answer is as before', async () => {
  const qs = [];
  const r = stub(svc.io, 'query', async (q) => { qs.push(q); return { items: [{ id: '900', state: 'active', board: { id: require('../config/monday').clientMasterBoardId }, column_values: [{ id: 'text_mm0xw6bp', text: ' a@example.test ', value: '"a@example.test"' }, { id: 'text_mm142s49', text: '2026-EE-900', value: null }] }] }; });
  try {
    const plain = await svc.readCaseRow('900');
    assert.deepEqual(Object.keys(plain).sort(), ['assignees', 'recordUrl']);
    assert.ok(!qs[0].includes('text_mm0xw6bp'));
    const extra = await svc.readCaseRow('900', { extraColumns: ['text_mm0xw6bp', 'text_mm142s49', 'bad col"'] });
    assert.deepEqual(extra.texts, { text_mm0xw6bp: 'a@example.test', text_mm142s49: '2026-EE-900' });
    assert.equal(qs.length, 2, 'one read each');
    assert.ok(qs[1].includes('"text_mm0xw6bp","text_mm142s49"') && !qs[1].includes('bad col'));
  } finally { r(); }
});

test('caseLeadSet: two leads naming DIFFERENT people → multipleClaimants (the 2026-OINP-059 case)', async () => {
  const s = stubSet({ linked: [L(1), L(2, { fullName: 'Ravi Example' })] });
  try {
    const r = await svc.caseLeadSet('900', '2026-EE-900', { recordUrl: '' });
    assert.equal(r.multipleClaimants, true); assert.equal(r.claimantCount, 2);
  } finally { s.restore(); }
  assert.equal(svc.claimantsOf([{ leadId: '1', clientName: 'A B' }, { leadId: '2', clientName: '' }]).multipleClaimants, true, 'a record with no name is never taken for the same person');
  assert.equal(svc.nameKey('José  Núñez'), svc.nameKey('jose nunez'));
});

test('caseLeadSet: no lead at all → an empty set; the live lead query failing → the set fails (never "no consultations" as if true)', async () => {
  let s = stubSet({ linked: [] });
  try { const r = await svc.caseLeadSet('900', '2026-EE-900', { recordUrl: '' }); assert.deepEqual(r.leads, []); assert.equal(r.multipleClaimants, false); } finally { s.restore(); }
  s = stubSet({ linked: new Error('Monday down') });
  try { await assert.rejects(svc.caseLeadSet('900', '2026-EE-900', { recordUrl: '' }), /Monday down/); } finally { s.restore(); }
});

test('caseLeadSet: a direct consultation for this case (found in the snapshot) is kept only when its LIVE read still names this case', async () => {
  const snapshot = [L(7, { consultOption: dc('2026-EE-900') }), L(8, { consultOption: dc('2026-ee-900') }), L(9, { consultOption: dc('2026-EE-900') }), L(10, { consultOption: dc('2026-SP-001') })];
  const live = {
    7: L(7, { consultOption: dc('2026-EE-900'), directConsult: 'Existing client' }),       // still this case
    8: L(8, { consultOption: dc('2026-EE-900'), clientMasterItemId: '555' }),               // stale snapshot: now on another case
    // 9: gone (deleted since the snapshot)
  };
  const s = stubSet({ linked: [L(1)], snapshot, live });
  try {
    const r = await svc.caseLeadSet('900', '2026-EE-900', { recordUrl: '' });
    assert.deepEqual(r.leads.map((l) => [l.leadId, l.via]).sort(), [['1', 'link'], ['7', 'direct']]);
    assert.equal(r.leads.find((l) => l.leadId === '7').kind, 'direct-consult');
    assert.ok(!s.reads.some((x) => x[0] === 'live' && x[1] === '10'), 'a lead naming another case is never read');
  } finally { s.restore(); }
});

test('caseLeadSet: the consultation copy anchor counts only while it points here, or at no case and names no other one', async () => {
  const url = (id) => 'https://app.example.test/admin/consultation/' + id;
  const run = async (lead, recordUrl) => { const s = stubSet({ linked: [L(1)], live: { [lead.id]: lead }, recordUrl }); try { return (await svc.caseLeadSet('900', '2026-EE-900', { recordUrl })).leads.map((l) => l.leadId); } finally { s.restore(); } };
  assert.ok((await run(L(5, { clientMasterItemId: '900' }), url(5))).includes('5'), 'points at this case → kept');
  assert.ok((await run(L(5), url(5))).includes('5'), 'empty Client Master id, no other case → kept');
  assert.ok(!(await run(L(5, { clientMasterItemId: '777' }), url(5))).includes('5'), 'moved to another case → left out');
  assert.ok(!(await run(L(5, { caseDeleted: '2026-SP-002' }), url(5))).includes('5'), 'marks another deleted case → left out');
  assert.ok(!(await run(L(5, { consultOption: dc('2026-SP-003') }), url(5))).includes('5'), 'a direct consultation of another case → left out');
  assert.ok(!(await run(L(5), 'https://other.example/x')).includes('5'), 'not one of our record links → nothing');
  // no recordUrl handed in: the row is read here (one extra read) and its link used
  const s = stubSet({ linked: [], live: { 6: L(6) }, recordUrl: url(6) });
  try { assert.deepEqual((await svc.caseLeadSet('900', '2026-EE-900')).leads.map((l) => l.leadId), ['6']); assert.ok(s.reads.some((x) => x[0] === 'row')); } finally { s.restore(); }
});

test('caseLeadSet: a failed snapshot or anchor check leaves the linked leads (and says partial)', async () => {
  const w = stub(console, 'warn', () => {});
  const s = stubSet({ linked: [L(1)] });
  const r2 = stub(svc.io, 'snapshotLeads', () => { throw new Error('x'); });
  const r3 = stub(svc.io, 'query', async () => { throw new Error('y'); });
  try { const r = await svc.caseLeadSet('900', '2026-EE-900'); assert.deepEqual(r.leads.map((l) => l.leadId), ['1']); assert.equal(r.partial, true); }
  finally { r3(); r2(); s.restore(); w(); }
});

test('the Updates tab (getCaseThread) lists the SAME leads as the panel — the direct consultation and the anchor included', async () => {
  const s = stubSet({ linked: [L(1)], snapshot: [L(7, { consultOption: dc('2026-EE-900') })], live: { 7: L(7, { consultOption: dc('2026-EE-900') }), 5: L(5) }, recordUrl: 'https://x.test/admin/consultation/5' });
  const r1 = stub(htmlQ, 'validateAccessForStaff', async () => ({ itemId: '900', clientName: 'Asha Sample' }));
  const asked = [];
  const r2 = stub(mondayApi, 'query', async (q, v) => { asked.push(String(v.id && v.id[0])); return { items: [{ updates: [] }] }; });
  try {
    const t = await updates.getCaseThread('2026-EE-900');
    const set = await svc.caseLeadSet('900', '2026-EE-900');
    assert.deepEqual(t.leadIds.slice().sort(), set.leads.map((l) => l.leadId).sort());
    assert.deepEqual(t.leadIds.slice().sort(), ['1', '5', '7']);
    assert.deepEqual(asked.slice().sort(), ['1', '5', '7', '900']);
  } finally { r2(); r1(); s.restore(); }
});

/* ══ step 1 + 7: readLeadEntries ══════════════════════════════════════════════ */

const H = updates.OTTER_HEADER;
const u = (id, at, body, text) => ({ id: String(id), created_at: at, body, text_body: text == null ? body.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '') : text, creator: { name: 'Integration' } });
const SUMMARY = u('s1', '2026-11-12T19:40:00Z', `${H} — recorded Nov 12, 2026, 2:31 p.m. (Toronto) · matched by code<br><br><b>In short</b><br>Spouse work permit.<br><br>Recording in Otter: <a href="https://otter.ai/u/abc">https://otter.ai/u/abc</a><br>Otter recording ref: abcDEF123`);
const TLINK = u('s2', '2026-11-12T19:41:00Z', `${H} (transcript) — recorded Nov 12, 2026, 2:31 p.m. (Toronto)<br>Full transcript (in the client's folder): <a href="https://files.example.test/t.txt">https://files.example.test/t.txt</a><br>Otter transcript ref: abcDEF123`);
const TPART = u('s3', '2026-11-13T19:41:00Z', `${H} (transcript, part 1 of 2) — recorded Nov 13, 2026, 9:00 a.m. (Toronto)<br>0:00 Hello<br>0:05 Hi<br><br>The rest of the transcript is in Otter.<br>Otter transcript ref: xyz999`);
const SUMMARY2 = u('s4', '2026-11-13T19:40:00Z', `${H} — recorded Nov 13, 2026, 9:00 a.m. (Toronto) · assigned by Devon Support<br><br><b>Summary</b><br>Second call.<br>Otter recording ref: xyz999`);
const SEED = [
  u('n1', '2026-11-01T10:00:00Z', '<b>[Gauri]</b> 📝 <b>Consultation notes</b><br>First notes'),
  u('n2', '2026-11-02T10:00:00Z', '<b>[Shafoli]</b> 📝 <b>Consultation notes (updated)</b><br>Correction'),
  u('p1', '2026-11-03T10:00:00Z', '<b>[Gauri]</b> 🎙 <b>Consultation summary (Otter)</b><br>Pasted summary text'),
  u('r1', '2026-11-04T10:00:00Z', '📝 [Remark · Gauri] Called the client'),
  u('r2', '2026-11-04T11:00:00Z', '📝 [Note · Melanie] Walk-in client note'),
  u('x1', '2026-11-05T10:00:00Z', '✅ Consultation held — Zoom meeting ended'),
  SUMMARY, TLINK, TPART, SUMMARY2,
];

test('readLeadEntries: consultation notes, pasted Otter summaries and the Otter entries the app filed — NOT remarks, [Note · …] or system notes', async () => {
  const r1 = stub(svc.io, 'query', async () => ({ items: [{ id: '1', updates: SEED.slice().reverse() }] }));
  const r2 = stub(svc.io, 'transcriptHosts', async () => ['files.example.test']);
  try {
    const e = await svc.readLeadEntries('1');
    assert.deepEqual(e.notes.map((n) => [n.id, n.kind, n.by, n.updated, n.body]), [
      ['n1', 'typed', 'Gauri', false, 'First notes'],
      ['n2', 'typed', 'Shafoli', true, 'Correction'],
      ['p1', 'pasted', 'Gauri', false, 'Pasted summary text'],
    ], 'oldest first; remarks, direct-client notes and system notes left out');
    assert.equal(e.recordings.length, 2);
    const [a, b] = e.recordings;
    assert.equal(a.otterId, 'abcDEF123'); assert.equal(a.recorded, 'recorded Nov 12, 2026, 2:31 p.m. (Toronto)'); assert.equal(a.how, 'matched by code');
    assert.equal(a.summary.body, 'In short\nSpouse work permit.'); assert.deepEqual(a.summary.links, ['https://otter.ai/u/abc']);
    assert.equal(a.transcriptLink, 'https://files.example.test/t.txt'); assert.equal(a.transcript, null);
    assert.equal(b.how, 'assigned by Devon Support'); assert.equal(b.summary.body, 'Summary\nSecond call.');
    assert.equal(b.transcript.body, '0:00 Hello\n0:05 Hi\n\nThe rest of the transcript is in Otter.'); assert.equal(b.transcript.partOf, 2);
    assert.equal(e.olderNotLoaded, false);
  } finally { r2(); r1(); }
});

test('readLeadEntries: a transcript on a host the app did not upload to stays text, never a link; a pasted summary carrying a ref line is not "filed"', async () => {
  const fake = u('f1', '2026-11-12T19:00:00Z', '<b>[Gauri]</b> 🎙 <b>Consultation summary (Otter)</b><br>text<br>Otter recording ref: abcDEF123');
  const r1 = stub(svc.io, 'query', async () => ({ items: [{ id: '1', updates: [TLINK, fake] }] }));
  const r2 = stub(svc.io, 'transcriptHosts', async () => []);
  try {
    const e = await svc.readLeadEntries('1');
    assert.equal(e.recordings[0].transcriptLink, '');
    assert.match(e.recordings[0].transcriptText, /files\.example\.test/);
    assert.deepEqual(e.notes.map((n) => n.kind), ['pasted']);
  } finally { r2(); r1(); }
});

test('readLeadEntries: pages past 100 (page by page, duplicates dropped); at the page cap it says older entries were not loaded', async () => {
  const mkPage = (p, n) => Array.from({ length: n }, (_, i) => u(`${p}-${i}`, `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z`, `<b>[S]</b> 📝 <b>Consultation notes</b><br>note ${p}-${i}`));
  const asked = [];
  let r = stub(svc.io, 'query', async (q, v) => { asked.push(v.p); assert.match(q, /updates\(limit:100, page:\$p\)/); return { items: [{ id: '1', updates: v.p === 1 ? mkPage(1, 100) : [...mkPage(2, 30), mkPage(1, 1)[0]] }] }; });
  try { const e = await svc.readLeadEntries('1'); assert.deepEqual(asked, [1, 2]); assert.equal(e.notes.length, 130); assert.equal(e.olderNotLoaded, false); } finally { r(); }
  asked.length = 0;
  r = stub(svc.io, 'query', async (q, v) => { asked.push(v.p); return { items: [{ id: '1', updates: mkPage(v.p, 100) }] }; });
  try { const e = await svc.readLeadEntries('1', { maxPages: 3 }); assert.deepEqual(asked, [1, 2, 3]); assert.equal(e.olderNotLoaded, true); } finally { r(); }
  r = stub(svc.io, 'query', async () => ({ items: [] }));
  try { await assert.rejects(svc.readLeadEntries('1'), (e) => e.notFound); } finally { r(); }
  await assert.rejects(svc.readLeadEntries('12a'), /Invalid item id/);
});

/* ══ step 1 + 3: the routes ═══════════════════════════════════════════════════ */

function fakeRes() {
  return { statusCode: 200, headers: {}, body: null,
    set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const ADMIN = { isAdmin: true, scope: 'all', name: 'Admin' };
const STAFF = { isAdmin: false, userId: '42', teamIds: [], name: 'Devon Support', email: 'devon@example.test' };
const VERIFIED = { name: 'Devon Support', email: 'devon@example.test', verified: true };
const KEYONLY = { name: 'Unidentified (shared admin key)', email: '', verified: false };
const people = (ids) => ({ personIds: ids, teamIds: [] });

function fakeService(o = {}) {
  const calls = [];
  const set = o.set || { leads: [{ leadId: '11', clientName: 'Asha Sample', kind: 'booked', bookedSlot: '2026-11-10 10:00', consultationHeld: '', consultant: 'Consultant One', via: 'link' }], multipleClaimants: false, claimantCount: 1 };
  return {
    calls,
    enabled: () => o.enabled !== false,
    readCaseRow: async (id) => { calls.push(['row', id]); if (o.rowFails) throw new Error('cm down'); return { assignees: o.assignees || people(['42']), recordUrl: '' }; },
    caseLeadSet: async (id, ref, opts) => { calls.push(['set', id, ref, opts]); if (o.setFails) throw new Error('lead board down'); return set; },
    readLeadEntries: async (id) => { calls.push(['entries', id]); if (o.entriesFail) throw new Error('read failed'); return { notes: [{ id: 'n1', kind: 'typed', by: 'Gauri', updated: false, body: 'Secret client detail', at: '2026-11-10T10:00:00Z' }], recordings: [], olderNotLoaded: false }; },
  };
}
const deps = (viewer, actor, service, extra = {}) => ({ resolveViewer: () => viewer, staffActor: () => actor, service, lookupCase: async () => ({ itemId: '900', clientName: 'Asha Sample' }), ...extra });
const req = (o = {}) => ({ params: { caseRef: '2026-EE-900' }, body: {}, headers: {}, query: {}, ...o });

test('GET: switched off → 404 with a plain answer and no reads; always private, no-store', async () => {
  const s = fakeService({ enabled: false }); const res = fakeRes();
  await routes.get(req(), res, deps(ADMIN, VERIFIED, s));
  assert.equal(res.statusCode, 404); assert.match(res.body.error, /not switched on/);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(s.calls.length, 0);
  const p = fakeRes(); await routes.post(req({ body: { leadId: '11', body: 'x' } }), p, deps(ADMIN, VERIFIED, s));
  assert.equal(p.statusCode, 404); assert.equal(p.headers['Cache-Control'], 'private, no-store');
});

test('GET: the cards, Add note only for a Monday sign-in; the shared key alone reads', async () => {
  const s = fakeService(); let res = fakeRes();
  await routes.get(req(), res, deps(STAFF, VERIFIED, s));
  assert.equal(res.statusCode, 200); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.body.canAdd, true); assert.equal(res.body.signedIn, true); assert.equal(res.body.max, 20000);
  const c = res.body.consultations[0];
  assert.equal(c.recordingCode, 'TD-00011'); assert.equal(c.recordUrl, '/admin/consultation/11'); assert.equal(c.canAdd, true);
  assert.equal(c.notes[0].body, 'Secret client detail');
  assert.deepEqual(s.calls.map((x) => x[0]), ['row', 'set', 'entries'], 'the light read: the case row, never the full case');
  res = fakeRes(); await routes.get(req(), res, deps(ADMIN, KEYONLY, fakeService()));
  assert.equal(res.body.signedIn, false); assert.equal(res.body.canAdd, false); assert.equal(res.body.consultations[0].canAdd, false);
  assert.match(res.body.signInUrl, /^\/q\/auth\/monday\?returnTo=/);
});

test('GET: no sign-in → 401; RBAC in "assigned" mode → 403; the case row unreadable → 503 for staff (never 403), an admin still reads', async () => {
  let res = fakeRes(); await routes.get(req(), res, deps(null, KEYONLY, fakeService()));
  assert.equal(res.statusCode, 401); assert.ok(res.body.loginUrl);
  await withEnv({ CASE_VISIBILITY: 'assigned' }, async () => {
    res = fakeRes(); await routes.get(req(), res, deps(STAFF, VERIFIED, fakeService({ assignees: people(['7']) })));
    assert.equal(res.statusCode, 403);
    res = fakeRes(); await routes.get(req(), res, deps(STAFF, VERIFIED, fakeService({ assignees: people(['42']) })));
    assert.equal(res.statusCode, 200);
  });
  const w = stub(console, 'warn', () => {});
  try {
    res = fakeRes(); await routes.get(req(), res, deps(STAFF, VERIFIED, fakeService({ rowFails: true })));
    assert.equal(res.statusCode, 503);
    const s = fakeService({ rowFails: true });
    res = fakeRes(); await routes.get(req(), res, deps(ADMIN, KEYONLY, s));
    assert.equal(res.statusCode, 200);
    assert.equal(s.calls.find((x) => x[0] === 'set')[3].recordUrl, undefined, 'the anchor is read again by the set');
    // the case itself not found → 404; the lookup failing → 503
    res = fakeRes(); await routes.get(req(), res, deps(STAFF, VERIFIED, fakeService(), { lookupCase: async () => { throw new Error('Case not found.'); } }));
    assert.equal(res.statusCode, 404);
    res = fakeRes(); await routes.get(req(), res, deps(STAFF, VERIFIED, fakeService(), { lookupCase: async () => { throw new Error('timeout'); } }));
    assert.equal(res.statusCode, 503);
    res = fakeRes(); await routes.get(req({ params: { caseRef: '<x>' } }), res, deps(STAFF, VERIFIED, fakeService()));
    assert.equal(res.statusCode, 404);
  } finally { w(); }
});

test('GET: the lead set failing → 503 "Could not load notes"; one card failing → that card says so (never an empty list as if true)', async () => {
  const w = stub(console, 'warn', () => {});
  try {
    let res = fakeRes(); await routes.get(req(), res, deps(STAFF, VERIFIED, fakeService({ setFails: true })));
    assert.equal(res.statusCode, 503); assert.match(res.body.error, /Could not load notes/);
    res = fakeRes(); await routes.get(req(), res, deps(STAFF, VERIFIED, fakeService({ entriesFail: true })));
    assert.equal(res.statusCode, 200);
    assert.match(res.body.consultations[0].error, /Could not load notes/); assert.equal(res.body.consultations[0].canAdd, false);
  } finally { w(); }
});

test('GET: several client names → multipleClaimants and Add note off everywhere; a direct retainer has no code and no Add', async () => {
  const set = { leads: [{ leadId: '11', clientName: 'Asha Sample', kind: 'booked' }, { leadId: '12', clientName: 'Ravi Example', kind: 'direct-retainer' }], multipleClaimants: true, claimantCount: 2 };
  const res = fakeRes(); await routes.get(req(), res, deps(STAFF, VERIFIED, fakeService({ set })));
  assert.equal(res.body.multipleClaimants, true); assert.equal(res.body.claimantCount, 2); assert.equal(res.body.canAdd, false);
  assert.ok(res.body.consultations.every((c) => c.canAdd === false));
  assert.equal(res.body.consultations[1].recordingCode, '');
});

test('POST: Monday sign-in required — the shared key alone is refused and nothing is read or posted', async () => {
  const s = fakeService(); const res = fakeRes();
  const r = stub(updates, 'postConsultNotes', async () => { throw new Error('must not post'); });
  try {
    await routes.post(req({ body: { leadId: '11', body: 'note' } }), res, deps(ADMIN, KEYONLY, s));
    assert.equal(res.statusCode, 401); assert.match(res.body.error, /Sign in with Monday/); assert.equal(s.calls.length, 0);
    const r2 = fakeRes(); await routes.post(req({ body: { leadId: '11', body: 'note' } }), r2, deps(null, KEYONLY, s));
    assert.equal(r2.statusCode, 401);
  } finally { r(); }
});

test('POST: a leadId outside the case, any write while several people claim the case, and 20,001 characters are refused', async () => {
  const posted = [];
  const r = stub(updates, 'postConsultNotes', async (id, o) => { posted.push([id, o]); return { ok: true }; });
  try {
    let res = fakeRes(); await routes.post(req({ body: { leadId: '99', body: 'note' } }), res, deps(STAFF, VERIFIED, fakeService()));
    assert.equal(res.statusCode, 409); assert.equal(res.body.reason, 'not-on-case');
    const claim = fakeService({ set: { leads: [{ leadId: '11', clientName: 'A' }, { leadId: '12', clientName: 'B' }], multipleClaimants: true, claimantCount: 2 } });
    res = fakeRes(); await routes.post(req({ body: { leadId: '11', body: 'note' } }), res, deps(STAFF, VERIFIED, claim));
    assert.equal(res.statusCode, 409); assert.equal(res.body.reason, 'claimants'); assert.match(res.body.error, /linked to 2 client records/);
    const s = fakeService();
    res = fakeRes(); await routes.post(req({ body: { leadId: '11', body: 'x'.repeat(20001) } }), res, deps(STAFF, VERIFIED, s));
    assert.equal(res.statusCode, 400); assert.match(res.body.error, /20,000 characters — this is 1 over\. Nothing was saved/); assert.equal(s.calls.length, 0, 'refused before any read');
    res = fakeRes(); await routes.post(req({ body: { leadId: '11', body: '   ' } }), res, deps(STAFF, VERIFIED, s));
    assert.equal(res.statusCode, 400);
    res = fakeRes(); await routes.post(req({ body: { leadId: 'abc', body: 'n' } }), res, deps(STAFF, VERIFIED, s));
    assert.equal(res.statusCode, 400);
    assert.equal(posted.length, 0);
  } finally { r(); }
});

test('POST: the lead set is read AGAIN live, then postConsultNotes unchanged with the Monday name; the answer carries the entry', async () => {
  const posted = []; const logs = [];
  const r = stub(updates, 'postConsultNotes', async (id, o) => { posted.push([id, o]); return { ok: true, updated: true }; });
  const l = stub(console, 'log', (...a) => logs.push(a.join(' ')));
  try {
    const s = fakeService(); const res = fakeRes();
    await routes.post(req({ body: { leadId: '11', body: '  Secret client detail\r\nline two ', staffName: 'Typed Impostor' } }), res, deps(STAFF, VERIFIED, s));
    assert.equal(res.statusCode, 200); assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(posted, [['11', { body: 'Secret client detail\nline two', staffName: 'Devon Support' }]], 'never a typed name');
    assert.ok(s.calls.some((x) => x[0] === 'set'));
    assert.deepEqual({ ...res.body.entry, at: 'x' }, { kind: 'typed', by: 'Devon Support', updated: true, body: 'Secret client detail\nline two', at: 'x' });
    // logs: ids and counts only
    const all = logs.join('\n');
    assert.ok(all.includes('2026-EE-900') && all.includes('lead 11'));
    assert.ok(!/Secret|Devon|Asha/.test(all), all);
  } finally { l(); r(); }
});

test('POST: a duplicate is answered "already"; Monday failing is a plain 502; a refusal from the service is a 400', async () => {
  let r = stub(updates, 'postConsultNotes', async () => ({ ok: true, already: true }));
  try { const res = fakeRes(); await routes.post(req({ body: { leadId: '11', body: 'n' } }), res, deps(STAFF, VERIFIED, fakeService())); assert.equal(res.body.already, true); } finally { r(); }
  const e = stub(console, 'error', () => {});
  r = stub(updates, 'postConsultNotes', async () => { throw new Error('Monday down'); });
  try { const res = fakeRes(); await routes.post(req({ body: { leadId: '11', body: 'n' } }), res, deps(STAFF, VERIFIED, fakeService())); assert.equal(res.statusCode, 502); assert.match(res.body.error, /never makes a second copy/); } finally { r(); e(); }
  r = stub(updates, 'postConsultNotes', async () => { throw Object.assign(new Error('Invalid item id.'), { badRequest: true }); });
  try { const res = fakeRes(); await routes.post(req({ body: { leadId: '11', body: 'n' } }), res, deps(STAFF, VERIFIED, fakeService())); assert.equal(res.statusCode, 400); } finally { r(); }
});

test('GET logs carry ids and counts only — never note text or names', async () => {
  const logs = []; const l = stub(console, 'log', (...a) => logs.push(a.join(' ')));
  try { await routes.get(req(), fakeRes(), deps(STAFF, VERIFIED, fakeService())); } finally { l(); }
  assert.match(logs.join('\n'), /2026-EE-900: 1 consultation\(s\), 1 entry/);
  assert.ok(!/Secret|Gauri|Asha|Devon/.test(logs.join('\n')));
});

test('server wiring: GET + POST /admin/case-notes/:caseRef — not under /api, handed resolveViewer + staffActor', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.ok(src.includes("app.get('/admin/case-notes/:caseRef', (req, res) => require('./routes/caseNotesRoutes').get(req, res, { resolveViewer, staffActor }));"));
  assert.ok(src.includes("app.post('/admin/case-notes/:caseRef', express.json(), (req, res) => require('./routes/caseNotesRoutes').post(req, res, { resolveViewer, staffActor }));"));
  assert.ok(!/\/api\/case-notes/.test(src));
});

test('privacy: the client portal never carries consultation notes', async () => {
  for (const f of ['../src/services/clientPortalService.js', '../src/routes/clientPortal.js']) {
    const src = fs.readFileSync(require.resolve(f), 'utf8');
    for (const s of ['caseNotes', 'getConsultNotes', 'readLeadEntries', 'getCaseThread', 'getUpdatesForItem']) assert.ok(!src.includes(s), `${f} must not read ${s}`);
  }
  // the real snapshot pipeline, over a Monday whose every item carries a notes entry: none of it reaches the payload
  const portal = require('../src/services/clientPortalService');
  const docSvc = require('../src/services/documentFormService');
  const cockpit = require('../src/services/caseCockpitService');
  const NOTE = 'Private consultation detail QZX';
  const rs = [
    stub(mondayApi, 'query', async () => ({ items: [{ column_values: [{ id: 'color_mm0x8faa', text: 'Document Collection Started' }], updates: [{ id: '1', created_at: '2026-11-10T10:00:00Z', text_body: '[Gauri] 📝 Consultation notes\n' + NOTE, body: '<b>[Gauri]</b> 📝 <b>Consultation notes</b><br>' + NOTE }] }] })),
    stub(docSvc, 'getCaseSummary', async () => ({ items: [] })),
    stub(htmlQ, 'loadMembers', async () => []),
    stub(htmlQ, 'getMemberStatuses', async () => []),
    stub(cockpit, 'getLeadExtras', async () => ({ lead: { id: '11', createdAt: '2026-06-01' }, payments: null })),
  ];
  try {
    const snap = await portal.getPortalSnapshot({ caseRef: '2026-SP-001', validatedCase: { itemId: '1', clientName: 'Seam Client', caseType: 'Study Permit', caseSubType: null, accessToken: 'tok' } });
    assert.ok(!JSON.stringify(snap).includes(NOTE));
    const html = portal.buildPortalPage(snap, { mode: 'client' });
    assert.ok(!html.includes(NOTE) && !html.includes('Consultation notes'));
  } finally { rs.reverse().forEach((r) => r()); }
});

/* ══ step 2: the panel on the case page ═══════════════════════════════════════ */

const { buildCockpitHTML } = require('../src/routes/adminCase');
const scriptsOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('switch off (unset / "off" / anything but "on"): the case page has no panel, no grid change, no extra request', () => {
  for (const v of [null, 'off', '1', 'yes', 'ON ']) {
    withEnv({ CASE_NOTES_PANEL: v }, () => {
      const html = buildCockpitHTML('2026-XX-000');
      if (v === 'ON ') { assert.ok(html.includes('id="cnp"'), '"ON " trims and reads as on'); return; }
      for (const s of ['cnp', 'case-notes', 'case-body', 'case-main', '@container', 'tdotCaseNotesMount', 'tdot_cnotes_case_']) assert.ok(!html.includes(s), `${v}: ${s}`);
      assert.equal(html, buildCockpitHTML('2026-XX-000', { notesPanel: false }));
      assert.ok(html.includes('@media (max-width: 820px) { .sp-form { grid-template-columns:1fr; } }'));
      assert.ok(html.includes('    @media (max-width: 820px) {\n      .grid-2, .grid-3 { grid-template-columns:1fr; }'));
    });
  }
});

test('switch on: the panel is an <aside> OUTSIDE every tab panel, beside all of them, with container queries, hidden in print', () => {
  const html = buildCockpitHTML('2026-XX-000', { notesPanel: true });
  const aside = html.indexOf('<aside class="cnp" id="cnp"');
  const body = html.indexOf('<div class="case-body" id="case-body">'), main = html.indexOf('<div class="case-main">');
  const tabs = html.indexOf('<div class="tabbar" id="tabbar">'), firstPanel = html.indexOf('<div class="tab-panel'), hd = html.indexOf('<div class="case-hd">');
  const lastPanelEnd = html.indexOf('</div><!-- /case-main -->'), bodyEnd = html.indexOf('</div><!-- /case-body -->');
  // keyboard + screen-reader order (review 2026-11-15): the header, the tabs and the main content, THEN the panel
  assert.ok(hd < body && body < main && main < tabs && tabs < firstPanel, 'header, then the main column with the tabs');
  assert.ok(lastPanelEnd > html.indexOf('id="panel-updates"') && lastPanelEnd < aside && aside < bodyEnd, 'the panel comes after the whole main column, still inside .case-body');
  // the Emails tab (switch CASE_EMAILS_TAB) puts its panel INSIDE the main column too, never after it (critique #18)
  const both = buildCockpitHTML('2026-XX-000', { notesPanel: true, emailsTab: 'on' });
  const em = both.indexOf('id="panel-emails"'), bothEnd = both.indexOf('</div><!-- /case-main -->');
  assert.ok(em > both.indexOf('id="panel-updates"') && em < bothEnd && bothEnd < both.indexOf('<aside class="cnp" id="cnp"'), 'panel-emails sits inside .case-main, before the notes panel');
  // the wide grid places both by column AND row; under 1100px the bar is moved up between the header and the tabs
  assert.ok(html.includes('.case-main { grid-column:1; grid-row:1;') && html.includes('.cnp { grid-column:2; grid-row:1;'));
  const narrow = W.CASE_NOTES_CSS.slice(W.CASE_NOTES_CSS.indexOf('@media (max-width: 1099px) {'));
  assert.ok(/\.case-body, \.case-body\.cnp-railed \{ display:flex; flex-direction:column;/.test(narrow) && /\.cnp \{ order:-1; \}/.test(narrow.slice(0, narrow.indexOf('\n    }'))), 'the bar is shown first in the narrow column');
  assert.equal((html.match(/<aside /g) || []).length, 1);
  assert.ok(html.includes('@container casemain (max-width: 820px) { .sp-form { grid-template-columns:1fr; } }'));
  assert.ok(html.includes('@container casemain (max-width: 820px) {\n      .grid-2, .grid-3 { grid-template-columns:1fr; }\n      .doc-strip { grid-template-columns:repeat(3,1fr); }'));
  assert.ok(!html.includes('@media (max-width: 820px) { .sp-form'), 'the main column decides, not the window');
  for (const s of ['grid-template-columns:minmax(0,1fr) clamp(320px,26vw,420px)', 'container-type:inline-size', 'position:sticky', '@media (max-width: 1099px)', '@media print { .cnp { display:none !important; }',
    'Consultation notes <span class="cnp-badge" id="cnp-bar-n"></span>', '◂ Hide', 'tdotCaseNotesMount({ caseRef: CASE_REF });']) assert.ok(html.includes(s), s);
  // the mount runs after the shared auth helpers (peekKey) are defined
  assert.ok(html.indexOf('function peekKey') < html.indexOf('tdotCaseNotesMount({ caseRef: CASE_REF });'));
});

test('switch on: every emitted <script> parses (a hostile case ref too); the panel is never redrawn by render()/loadCase()', () => {
  for (const ref of ['2026-XX-000', '</script><img src=x onerror=alert(1)>']) {
    const html = buildCockpitHTML(ref, { notesPanel: true });
    const scripts = scriptsOf(html);
    assert.equal(scripts.length, 1);
    for (const s of scripts) new vm.Script(s);
    assert.ok(!html.includes('<img src=x'));
  }
  const page = fs.readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8');
  const renderFn = page.slice(page.indexOf('function render(d) {'), page.indexOf('var LAST_D = null;'));
  assert.ok(!/cnp|CaseNotes/.test(renderFn));
  const loadFn = page.slice(page.indexOf('function loadCase() {'), page.indexOf('// Tab switching'));
  assert.ok(!/cnp|CaseNotes/.test(loadFn));
});

test('widget script rules: no backtick, no backslash, no dollar-brace; entries by textContent — innerHTML is never used', () => {
  const js = W.CASE_NOTES_JS;
  assert.ok(!js.includes('`')); assert.ok(!js.includes('\\')); assert.ok(!js.includes('${'));
  assert.ok(!/innerHTML/.test(js));
  assert.ok(!/<\/script/i.test(js));
  new vm.Script(js);
  assert.equal(W.DRAFT_PREFIX, 'tdot_cnotes_case_');
  assert.ok(W.DRAFT_PREFIX.startsWith(require('../src/routes/consultNotesWidget').DRAFT_PREFIX), 'Sign Out clears it (adminShared.js removes every tdot_cnotes_ key)');
  assert.equal(W.MAX_CONSULT_NOTES, updates.MAX_CONSULT_NOTES);
});

/* ══ step 2/3/7: the widget in a small fake page ══════════════════════════════ */

function fakeDom() {
  const byId = {};
  function el(tag) {
    const l = {};
    const e = {
      tagName: String(tag || 'div').toUpperCase(), id: '', className: '', value: '', hidden: false, disabled: false, type: '', href: '', target: '', rel: '', title: '', placeholder: '', rows: 0, htmlFor: '',
      childNodes: [], parentNode: null, attrs: {}, focused: false, onclick: null, _text: '',
      get textContent() { return this.childNodes.length ? this.childNodes.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; this._text = String(v); },
      appendChild(c) { c.parentNode = this; this.childNodes.push(c); if (c.id) byId[c.id] = c; return c; },
      removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
      addEventListener(t, f) { (l[t] = l[t] || []).push(f); }, fire(t) { (l[t] || []).forEach((f) => f({ target: this })); },
      focus() { this.focused = true; },
      classList: null,
      all() { const out = []; const walk = (n) => n.childNodes.forEach((c) => { out.push(c); walk(c); }); walk(this); return out; },
      querySelector(sel) { const cls = sel.replace(/^\./, ''); return this.all().find((n) => (' ' + n.className + ' ').includes(' ' + cls + ' ')) || null; },
    };
    e.classList = {
      contains: (c) => (' ' + e.className + ' ').includes(' ' + c + ' '),
      add: (c) => { if (!e.classList.contains(c)) e.className = (e.className + ' ' + c).trim(); },
      remove: (c) => { e.className = (' ' + e.className + ' ').replace(' ' + c + ' ', ' ').trim(); },
      toggle: (c, on) => { const want = on === undefined ? !e.classList.contains(c) : !!on; if (want) e.classList.add(c); else e.classList.remove(c); return want; },
    };
    return e;
  }
  for (const id of ['case-body', 'cnp', 'cnp-list', 'cnp-msg', 'cnp-sign', 'cnp-warn', 'cnp-bar', 'cnp-rail', 'cnp-hide', 'cnp-refresh', 'cnp-bar-n', 'cnp-rail-n']) { byId[id] = el('div'); byId[id].id = id; }
  const document = { getElementById: (id) => byId[id] || null, createElement: el };
  const find = (pred) => [...new Set(Object.values(byId).flatMap((n) => [n, ...n.all()]))].filter(pred);
  return { document, byId, find };
}
function storage(mem = {}) {
  return { mem, getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; },
    get length() { return Object.keys(mem).length; }, key: (i) => Object.keys(mem)[i] || null };
}
const PAYLOAD = (o = {}) => ({ ok: true, caseRef: '2026-EE-900', signedIn: true, canAdd: true, signInUrl: '/q/auth/monday?returnTo=x', multipleClaimants: false, claimantCount: 2, max: 20000, consultations: [
  { leadId: '11', clientName: 'Asha Sample', kind: 'booked', bookedSlot: '2026-11-10 10:00', consultant: 'Consultant One', recordingCode: 'TD-00011', recordUrl: '/admin/consultation/11', canAdd: true,
    notes: [{ id: 'n1', kind: 'typed', by: 'Gauri', updated: false, body: '<b>not markup</b>', at: '2026-11-10T15:00:00Z' }], recordings: [] },
  { leadId: '12', clientName: 'Asha Sample', kind: 'direct-consult', bookedSlot: '2026-11-12 14:30', consultant: 'Consultant Two', recordingCode: 'TD-00012', recordUrl: '/admin/consultation/12', canAdd: true, notes: [],
    recordings: [{ otterId: 'abc', recorded: 'recorded Nov 12, 2026, 2:31 p.m. (Toronto)', how: 'matched by code', summary: { body: 'In short\nSpouse work permit.', links: ['https://otter.ai/u/abc', 'javascript:alert(1)'] }, transcriptLink: 'https://files.example.test/t.txt', transcript: { body: '0:00 Hello', partNo: 1, partOf: 1 } }] },
], ...o });

function widget({ payload = PAYLOAD(), status = 200, mem = {}, post } = {}) {
  const d = fakeDom(); const winL = {}; const posts = []; const gets = [];
  const window = { addEventListener(t, f) { (winL[t] = winL[t] || []).push(f); } };
  const ctx = {
    document: d.document, window, localStorage: storage(mem), peekKey: () => null, navigator: {}, Date, JSON, Number, String, Math, isNaN, setTimeout, encodeURIComponent,
    fetch: (url, o) => {
      if (o && o.method === 'POST') { posts.push({ url, body: JSON.parse(o.body), o }); return Promise.resolve(post ? post(posts.length) : { status: 200, json: () => Promise.resolve({ ok: true, entry: { kind: 'typed', by: 'Devon Support', updated: false, body: JSON.parse(o.body).body, at: '2026-11-15T10:00:00Z' } }) }); }
      gets.push({ url, o }); return Promise.resolve({ status, json: () => Promise.resolve(payload) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(W.CASE_NOTES_JS + '\ntdotCaseNotesMount({ caseRef: "2026-EE-900" });', ctx);
  const tas = () => d.find((n) => n.tagName === 'TEXTAREA');
  const leave = () => { const ev = { p: false, preventDefault() { this.p = true; } }; (winL.beforeunload || []).forEach((f) => f(ev)); return ev.p; };
  return { d, ctx, window, winL, posts, gets, mem: ctx.localStorage.mem, tas, leave, text: () => d.byId['cnp-list'].textContent };
}

test('widget: one card per consultation, its own fetch (no-store, same-origin), entries as text, the code with Copy and the hint', async () => {
  const w = widget(); await tick();
  assert.equal(w.gets.length, 1); assert.equal(w.gets[0].url, '/admin/case-notes/2026-EE-900');
  assert.equal(w.gets[0].o.cache, 'no-store'); assert.equal(w.gets[0].o.credentials, 'same-origin');
  const t = w.text();
  for (const s of ['Asha Sample', 'Booked', 'Direct consultation', 'Consultation Nov 10, 2026, 10:00 · Consultant One', 'Type in Otter (no Client ID yet)', 'TD-00011', 'Copy', 'Type this as the Otter recording title',
    'Typed by Gauri, ', '<b>not markup</b>', 'No consultation notes yet', 'Add note', 'Save note']) assert.ok(t.includes(s), s);
  assert.equal(w.tas().length, 2, 'one Add note box per consultation');
  assert.equal(w.d.byId['cnp-bar-n'].textContent, '2', 'the count: one note + one recording');
  const recLinks = w.d.find((n) => n.tagName === 'A' && n.className === 'cnp-rec-l').map((a) => a.href);
  assert.deepEqual(recLinks, ['/admin/consultation/11', '/admin/consultation/12']);
});

test('widget (step 7): the Otter source line, summary first, only https links, the transcript folded until asked; "Start a note" fills the box, saves nothing', async () => {
  const w = widget(); await tick();
  const t = w.text();
  assert.ok(t.includes('From Otter, recorded Nov 12, 2026, 2:31 p.m. (Toronto) · matched by code'));
  assert.ok(t.indexOf('Spouse work permit.') < t.indexOf('Show transcript'));
  const hrefs = w.d.find((n) => n.tagName === 'A' && n.className === 'sbtn').map((a) => a.href);
  assert.deepEqual(hrefs, ['https://otter.ai/u/abc', 'https://files.example.test/t.txt']);
  const tx = w.d.find((n) => n.className === 'cnp-text' && n.textContent === '0:00 Hello')[0];
  assert.equal(tx.hidden, true);
  w.d.find((n) => n.textContent === 'Show transcript' && n.tagName === 'BUTTON')[0].onclick();
  assert.equal(tx.hidden, false);
  const start = w.d.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Start a note from this summary');
  assert.equal(start.length, 1, 'only on the card with no typed notes');
  start[0].onclick();
  const ta = w.tas()[1];
  assert.equal(ta.value, 'In short\nSpouse work permit.');
  assert.equal(w.posts.length, 0, 'nothing is saved until the person presses Save note');
  assert.ok('tdot_cnotes_case_12' in w.mem, 'kept as a draft like any typed text');
});

test('widget (step 3): Save note posts { leadId, body } for ITS card; success adds the entry without a reload and clears the box + draft', async () => {
  const w = widget(); await tick();
  const ta = w.tas()[0];
  ta.value = '  Correction: expiry is June 11  '; ta.fire('input');
  assert.deepEqual(Object.keys(JSON.parse(w.mem.tdot_cnotes_case_11)), ['who', 'd'], 'the record page per-tab draft format');
  assert.equal(JSON.parse(w.mem.tdot_cnotes_case_11).who, 'Asha Sample');
  const btn = w.d.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Save note')[0];
  btn.onclick(); btn.onclick();
  assert.equal(w.posts.length, 1, 'a double click is one save');
  assert.deepEqual(w.posts[0].body, { leadId: '11', body: 'Correction: expiry is June 11' });
  assert.equal(w.posts[0].url, '/admin/case-notes/2026-EE-900');
  await tick();
  assert.equal(ta.value, ''); assert.equal('tdot_cnotes_case_11' in w.mem, false);
  assert.ok(w.text().includes('Typed by Devon Support, ') && w.text().includes('Correction: expiry is June 11'));
  assert.ok(w.text().includes('Note saved.'));
  assert.equal(w.gets.length, 1, 'no reload');
  assert.equal(w.d.byId['cnp-bar-n'].textContent, '3');
});

test('widget (step 3): a refusal keeps the text and the draft; over 20,000 is refused on the page; the counter shows from 18,000', async () => {
  const w = widget({ post: () => ({ status: 409, json: () => Promise.resolve({ ok: false, error: 'That consultation is not linked to this case any more, so nothing was saved. Reload the page.' }) }) }); await tick();
  const ta = w.tas()[0]; const btn = w.d.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Save note')[0];
  const cnt = w.d.find((n) => n.className.startsWith('cnp-count'))[0];
  ta.value = 'x'.repeat(17999); ta.fire('input'); assert.equal(cnt.textContent, '');
  ta.value = 'x'.repeat(18000); ta.fire('input'); assert.equal(cnt.textContent, '18,000 / 20,000 characters');
  ta.value = 'x'.repeat(20002); ta.fire('input'); assert.match(cnt.textContent, /2 over the limit/);
  btn.onclick(); assert.equal(w.posts.length, 0); assert.match(w.text(), /limited to 20,000 characters — this is 2 over\. Nothing was saved/);
  ta.value = 'keep me'; ta.fire('input'); btn.onclick(); await tick();
  assert.equal(ta.value, 'keep me'); assert.ok('tdot_cnotes_case_11' in w.mem);
  assert.match(w.text(), /not linked to this case any more.*Your note is kept on this device as a draft\./);
});

test('widget (step 3): ONE beforeunload and ONE tdotNotesUnsaved cover every box — Sign Out with two open boxes asks first', async () => {
  const w = widget(); await tick();
  assert.equal((w.winL.beforeunload || []).length, 1);
  assert.equal(w.window.tdotNotesUnsaved(), false); assert.equal(w.leave(), false);
  const [a, b] = w.tas();
  b.value = 'typed in the SECOND card'; b.fire('input');
  assert.equal(w.window.tdotNotesUnsaved(), true, 'the second box counts, not only the last mounted one');
  assert.equal(w.leave(), true);
  a.value = 'and the first'; a.fire('input'); b.value = ''; b.fire('input');
  assert.equal(w.window.tdotNotesUnsaved(), true);
  // Sign Out (adminShared.js) asks because of the hook, and names the client from the draft
  const { SHARED_AUTH_JS } = require('../src/routes/adminShared');
  const asked = [];
  const ctx = { sessionStorage: { length: 0, key: () => null, removeItem() {}, getItem: () => 'k' }, localStorage: storage(w.mem),
    window: { location: { replace() {} }, confirm: (m) => { asked.push(m); return false; }, tdotNotesUnsaved: w.window.tdotNotesUnsaved },
    fetch: () => Promise.resolve(), setTimeout() {}, document: { readyState: 'complete', getElementById: () => null } };
  vm.createContext(ctx); vm.runInContext(SHARED_AUTH_JS + '; signOut();', ctx);
  assert.equal(asked.length, 1); assert.match(asked[0], /^Consultation notes for Asha Sample were typed on this device but not saved/);
  assert.ok('tdot_cnotes_case_11' in w.mem, 'Cancel keeps the draft');
  // a second mount on the same page does not add a second hook
  vm.runInContext('tdotCaseNotesMount({ caseRef: "2026-EE-900" });', w.ctx);
  assert.equal((w.winL.beforeunload || []).length, 1);
});

test('widget (step 3): an earlier page hook is kept; the list is not refreshed while a box holds text; a draft comes back after a reload', async () => {
  const mem = {};
  const w = widget({ mem }); await tick();
  const ta = w.tas()[0]; ta.value = 'half typed'; ta.fire('input');
  w.d.byId['cnp-refresh'].onclick();
  assert.equal(w.gets.length, 1, 'no refresh over a box with text');
  assert.match(w.d.byId['cnp-msg'].textContent, /Save or clear the note you are typing first/);
  const again = widget({ mem }); await tick();
  assert.equal(again.tas()[0].value, 'half typed');
  // the earlier hook: kept and asked
  const d = fakeDom(); const window = { addEventListener() {}, tdotNotesUnsaved: () => true };
  const ctx = { document: d.document, window, localStorage: storage(), peekKey: () => null, Date, JSON, Number, String, Math, isNaN, setTimeout, encodeURIComponent, fetch: () => new Promise(() => {}) };
  vm.createContext(ctx); vm.runInContext(W.CASE_NOTES_JS + '\ntdotCaseNotesMount({ caseRef: "R" });', ctx);
  assert.equal(window.tdotNotesUnsaved(), true);
});

test('widget: the states — several client names (warning, no Add), the shared key (read only + sign-in), no lead, a direct retainer, a failed read (retry)', async () => {
  let w = widget({ payload: PAYLOAD({ multipleClaimants: true, claimantCount: 2, canAdd: false }) }); await tick();
  assert.equal(w.d.byId['cnp-warn'].textContent, 'This case is linked to 2 client records. Add note is off until the duplicate is fixed on the Consultations page.');
  assert.equal(w.tas().length, 0, 'Add note off on every card, whatever a card says');
  w = widget({ payload: PAYLOAD({ signedIn: false, canAdd: false, consultations: PAYLOAD().consultations.map((c) => ({ ...c, canAdd: false })) }) }); await tick();
  assert.equal(w.tas().length, 0);
  const sign = w.d.byId['cnp-sign'].childNodes[0];
  assert.equal(sign.textContent, 'Sign in with Monday to add notes'); assert.equal(sign.href, '/q/auth/monday?returnTo=x');
  w = widget({ payload: PAYLOAD({ consultations: [] }) }); await tick();
  assert.equal(w.text(), 'No consultation record for this case.');
  w = widget({ payload: PAYLOAD({ consultations: [{ leadId: '13', clientName: 'Asha Sample', kind: 'direct-retainer', recordingCode: '', recordUrl: '/admin/consultation/13', canAdd: false, notes: [], recordings: [] }] }) }); await tick();
  assert.ok(w.text().includes('Direct retainer: no consultation.')); assert.ok(!w.text().includes('Type in Otter')); assert.ok(!w.text().includes('No consultation notes yet'));
  w = widget({ status: 503, payload: { ok: false, error: 'Could not load notes — retry.' } }); await tick();
  assert.ok(w.text().startsWith('Could not load notes — retry')); assert.equal(w.d.byId['cnp-bar-n'].textContent, '', 'never a count of zero as if true');
  w.d.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Retry')[0].onclick(); await tick();
  assert.equal(w.gets.length, 2);
  w = widget({ payload: PAYLOAD({ consultations: [{ ...PAYLOAD().consultations[0], error: 'Could not load notes — retry.', notes: [], canAdd: false }] }) }); await tick();
  assert.ok(w.text().includes('Could not load notes — retry')); assert.ok(!w.text().includes('No consultation notes yet'));
  w = widget({ status: 403, payload: { ok: false } }); await tick();
  assert.equal(w.text(), 'You are not assigned to this case.');
});

test('widget: Hide is remembered per browser (try/catch); the narrow bar opens in place', async () => {
  const mem = {};
  const w = widget({ mem }); await tick();
  w.d.byId['cnp-hide'].onclick();
  assert.equal(mem.tdot_case_notes_hidden, '1');
  assert.ok(w.d.byId.cnp.classList.contains('cnp-hidden')); assert.ok(w.d.byId['case-body'].classList.contains('cnp-railed'));
  const again = widget({ mem }); await tick();
  assert.ok(again.d.byId.cnp.classList.contains('cnp-hidden'));
  again.d.byId['cnp-rail'].onclick(); assert.equal(mem.tdot_case_notes_hidden, '0');
  again.d.byId['cnp-bar'].onclick();
  assert.ok(again.d.byId.cnp.classList.contains('cnp-open')); assert.equal(again.d.byId['cnp-bar'].attrs['aria-expanded'], 'true');
  // storage that throws: the panel still works
  const d = fakeDom(); const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }, get length() { throw new Error('blocked'); }, key() { throw new Error('blocked'); } };
  const ctx = { document: d.document, window: { addEventListener() {} }, localStorage: bad, peekKey: () => null, Date, JSON, Number, String, Math, isNaN, setTimeout, encodeURIComponent,
    fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve(PAYLOAD()) }) };
  vm.createContext(ctx); vm.runInContext(W.CASE_NOTES_JS + '\ntdotCaseNotesMount({ caseRef: "R" });', ctx); await tick();
  d.byId['cnp-hide'].onclick();
  assert.ok(d.byId['cnp-list'].textContent.includes('Asha Sample'));
});

/* ══ the staff guide ══════════════════════════════════════════════════════════ */

test('staff guide: the how-to for the case page notes, marked as not switched on yet', () => {
  const g = JSON.parse(fs.readFileSync(require.resolve('../src/staffGuide/guide-data.json'), 'utf8'));
  const h = g.howto.find((x) => /consultation notes on the case page/i.test(x.q));
  assert.ok(h, 'the entry exists');
  assert.match(h.answer, /Not switched on yet/);
  assert.match(h.answer, /Sign in with Monday/);
});

/* ══ review fixes (2026-11-15) ════════════════════════════════════════════════ */

test('review 1: part of the consultations check failing (partial) → POST 503, nothing saved; GET shows no Add note', async () => {
  const set = { leads: [{ leadId: '11', clientName: 'Asha Sample', kind: 'booked' }], multipleClaimants: false, claimantCount: 1, partial: true };
  const posted = [];
  const r = stub(updates, 'postConsultNotes', async (id, o) => { posted.push([id, o]); return { ok: true }; });
  const w = stub(console, 'warn', () => {});
  try {
    const s = fakeService({ set }); let res = fakeRes();
    await routes.post(req({ body: { leadId: '11', body: 'note' } }), res, deps(STAFF, VERIFIED, s));
    assert.equal(res.statusCode, 503); assert.equal(res.body.ok, false); assert.equal(res.body.reason, 'partial');
    assert.match(res.body.error, /Could not check every consultation linked to this case, so nothing was saved\. Try again in a minute\./);
    assert.equal(posted.length, 0);
    assert.ok(!s.calls.some((x) => x[0] === 'entries'), 'refused before anything else is read');
    res = fakeRes(); await routes.get(req(), res, deps(STAFF, VERIFIED, fakeService({ set })));
    assert.equal(res.statusCode, 200); assert.equal(res.body.partial, true); assert.equal(res.body.canAdd, false);
    assert.ok(res.body.consultations.every((c) => c.canAdd === false));
    res = fakeRes(); await routes.get(req(), res, deps(STAFF, VERIFIED, fakeService()));
    assert.equal(res.body.partial, false); assert.equal(res.body.canAdd, true, 'a full read still offers Add note');
  } finally { w(); r(); }
});

test('review 1 (the scenario, the real caseLeadSet): a passing Monday error on the anchor, the admin row read or the snapshot never lets a note through', async () => {
  const url = (id) => 'https://app.example.test/admin/consultation/' + id;
  const posted = [];
  const r = stub(updates, 'postConsultNotes', async (id, o) => { posted.push([id, o]); return { ok: true }; });
  const w = stub(console, 'warn', () => {}); const l = stub(console, 'log', () => {});
  // case 910: lead 601 "Mira Test" linked by Client Master id; lead 888 "Tomas Fake" (empty id) is the Record anchor
  const service = (o = {}) => ({ ...svc, enabled: () => true, readCaseRow: async () => { if (o.rowFails) throw new Error('row down'); return { assignees: people(['42']), recordUrl: url(888) }; } });
  const run = async (viewer, o, prep) => {
    const s = stubSet({ linked: [L(601, { fullName: 'Mira Test', clientMasterItemId: '910' })], snapshot: [], live: { 888: L(888, { fullName: 'Tomas Fake' }) } });
    const undo = prep ? prep() : () => {};
    try {
      const d = deps(viewer, VERIFIED, service(o), { lookupCase: async () => ({ itemId: '910', clientName: 'Mira Test' }) });
      const p = fakeRes(); await routes.post(req({ params: { caseRef: '2026-TEST-910' }, body: { leadId: '601', body: 'Invented note' } }), p, d);
      const g = fakeRes(); await routes.get(req({ params: { caseRef: '2026-TEST-910' } }), g, d);
      return { p, g };
    } finally { undo(); s.restore(); }
  };
  try {
    // every read works: two different people → refused (the control)
    let x = await run(STAFF, {});
    assert.equal(x.p.statusCode, 409); assert.equal(x.p.body.reason, 'claimants'); assert.equal(x.g.body.canAdd, false);
    // the anchor's read throws → the set is partial → 503, nothing posted; GET offers no Add note
    x = await run(STAFF, {}, () => stub(svc.io, 'getLead', async () => { throw new Error('Monday blip'); }));
    assert.equal(x.p.statusCode, 503); assert.equal(x.g.body.partial, true); assert.equal(x.g.body.canAdd, false);
    // an admin whose row read fails: the set reads the row again, that fails too → partial
    x = await run(ADMIN, { rowFails: true }, () => stub(svc.io, 'query', async () => { throw new Error('Monday blip'); }));
    assert.equal(x.p.statusCode, 503); assert.equal(x.g.body.canAdd, false);
    // the snapshot step throws → partial
    x = await run(STAFF, {}, () => stub(svc.io, 'snapshotLeads', () => { throw new Error('snapshot broken'); }));
    assert.equal(x.p.statusCode, 503); assert.equal(x.g.body.canAdd, false);
    assert.equal(posted.length, 0, 'no note was posted in any of them');
  } finally { l(); w(); r(); }
});

test('review 2 (the scenario): a lead with 140 updates and its only note at update 120 — saving it again is "already", never a second copy', async () => {
  updates._resetConsultNotesGuard();
  // newest first, as Monday answers; the only consultation note sits past the newest 100
  const store = [];
  for (let i = 0; i < 140; i++) {
    const at = new Date(Date.UTC(2026, 10, 14, 12) - i * 60000).toISOString();
    store.push(i === 120 ? u('900' + i, at, '<b>[Gauri]</b> 📝 <b>Consultation notes</b><br>Invented note A<br>second line') : u('900' + i, at, 'Status changed to Document Collection'));
  }
  const posted = [];
  const r = stub(mondayApi, 'query', async (q, v) => {
    if (/create_update/.test(q)) { posted.push(v.b); return { create_update: { id: '1' } }; }
    const page = v.p || 1, n = v.n || 100;
    return { items: [{ id: '11', updates: store.slice((page - 1) * 100, (page - 1) * 100 + n) }] };
  });
  const l = stub(console, 'log', () => {}); const w = stub(console, 'warn', () => {});
  const service = { enabled: () => true, readCaseRow: async () => ({ assignees: people(['42']), recordUrl: '' }),
    caseLeadSet: async () => ({ leads: [{ leadId: '11', clientName: 'Asha Sample', kind: 'booked' }], multipleClaimants: false, claimantCount: 1, partial: false }),
    readLeadEntries: svc.readLeadEntries };
  try {
    // the panel shows the note …
    const e = await svc.readLeadEntries('11');
    assert.deepEqual(e.notes.map((n) => n.body), ['Invented note A\nsecond line']);
    // … postConsultNotes alone does not see it (its check reads the newest 100) — pinned, unchanged
    assert.equal((await updates.getConsultNotes('11')).length, 0);
    // the route answers "already" — spacing does not count, the same rule as postConsultNotes
    let res = fakeRes();
    await routes.post(req({ body: { leadId: '11', body: '  Invented  note A\n second line ' } }), res, deps(STAFF, VERIFIED, service));
    assert.equal(res.statusCode, 200); assert.deepEqual(res.body, { ok: true, already: true, updated: false });
    assert.equal(posted.length, 0, 'no second copy');
    // a different note is still posted (through postConsultNotes, unchanged)
    res = fakeRes();
    await routes.post(req({ body: { leadId: '11', body: 'Invented note B' } }), res, deps(STAFF, VERIFIED, service));
    assert.equal(res.statusCode, 200); assert.equal(res.body.already, false); assert.equal(posted.length, 1);
    assert.match(posted[0], /Invented note B/);
    // the keys never reach the page
    res = fakeRes(); await routes.get(req(), res, deps(STAFF, VERIFIED, service));
    assert.ok(!JSON.stringify(res.body).includes('typedKeys') && !JSON.stringify(res.body).includes('_keys'));
  } finally { w(); l(); r(); updates._resetConsultNotesGuard(); }
});

test('review 2: the earlier entries not readable before a save → postConsultNotes and its own guards decide (never a refusal)', async () => {
  const posted = [];
  const r = stub(updates, 'postConsultNotes', async (id, o) => { posted.push([id, o]); return { ok: true }; });
  const w = stub(console, 'warn', () => {}); const l = stub(console, 'log', () => {});
  try {
    const res = fakeRes(); await routes.post(req({ body: { leadId: '11', body: 'Secret client detail' } }), res, deps(STAFF, VERIFIED, fakeService({ entriesFail: true })));
    assert.equal(res.statusCode, 200); assert.equal(posted.length, 1);
    // the fake's note has the same text: answered "already" from the panel's entries, postConsultNotes not called
    const r2 = fakeRes(); await routes.post(req({ body: { leadId: '11', body: 'Secret  client\ndetail' } }), r2, deps(STAFF, VERIFIED, fakeService()));
    assert.equal(r2.body.already, true); assert.equal(posted.length, 1);
  } finally { l(); w(); r(); }
});

test('review 3: "Older entries not loaded" points at Monday, never at the record page (which reads fewer entries)', async () => {
  const w = widget({ payload: PAYLOAD({ consultations: [{ ...PAYLOAD().consultations[0], olderNotLoaded: true }] }) }); await tick();
  const old = w.d.find((n) => n.className === 'cnp-old');
  assert.equal(old.length, 1);
  assert.equal(old[0].textContent, 'Older entries not loaded — see the full history on Monday.');
  const line = W.CASE_NOTES_JS.split('\n').find((x) => x.includes('c.olderNotLoaded'));
  assert.ok(line && !/consultation record|open the/i.test(line), 'the old wording is gone');
});

test('review 4: the sticky panel always fits between the nav bar and the bottom of .case-body — one variable for the page padding and the height limit', () => {
  const css = W.CASE_NOTES_CSS;
  const v = (name) => { const m = new RegExp('--' + name + ':(\\d+)px').exec(css); return m ? Number(m[1]) : NaN; };
  assert.ok(css.includes('.wrap { padding-bottom:var(--case-pad-b); }'), 'the page padding comes from the variable');
  const cnp = /\.cnp \{ grid-column:2;[^}]*\}/.exec(css)[0];
  assert.ok(cnp.includes('top:calc(var(--header-h) + var(--cnp-gap))'));
  assert.ok(cnp.includes('max-height:calc(100vh - var(--header-h) - var(--cnp-gap) - var(--case-pad-b))'));
  // at the end of the page .case-body ends --case-pad-b above the window's bottom: the room below the sticky top
  // must hold the tallest panel, or the sticky box is pushed up under the nav bar
  for (const vh of [600, 813, 900, 1400]) {
    const header = 60, top = header + v('cnp-gap'), maxH = vh - header - v('cnp-gap') - v('case-pad-b');
    const bodyBottom = vh - v('case-pad-b');
    assert.ok(top + maxH <= bodyBottom, vh + ': the panel fits');
    assert.ok(bodyBottom - maxH >= header, vh + ': its top never goes above the nav bar');
  }
  // the override reaches the page AFTER the page's own .wrap rule (same specificity: the later one wins)
  const html = buildCockpitHTML('2026-XX-000', { notesPanel: true });
  assert.ok(html.indexOf('.wrap { max-width:none; margin:0; padding:26px var(--page-gutter) 80px; }') < html.indexOf('.wrap { padding-bottom:var(--case-pad-b); }'));
  // nothing else follows .case-body inside the content, so its bottom is the padding's top
  assert.match(html, /<\/div><!-- \/case-body -->\s*<\/div><!-- \/content -->\s*<\/main>/);
});

test('review 6: Hide and the rail say whether the panel is open (aria-expanded + aria-controls), kept in step by setHidden', async () => {
  const h = W.caseNotesHtml();
  assert.match(h, /id="cnp-hide"[^>]*aria-expanded="true" aria-controls="cnp-panel"/);
  assert.match(h, /id="cnp-rail"[^>]*aria-expanded="false" aria-controls="cnp-panel"/);
  assert.ok(h.includes('id="cnp-panel"'));
  const mem = {};
  const w = widget({ mem }); await tick();
  const hide = w.d.byId['cnp-hide'], rail = w.d.byId['cnp-rail'];
  hide.onclick();
  assert.equal(hide.attrs['aria-expanded'], 'false'); assert.equal(rail.attrs['aria-expanded'], 'false'); assert.equal(rail.focused, true);
  rail.onclick();
  assert.equal(hide.attrs['aria-expanded'], 'true'); assert.equal(rail.attrs['aria-expanded'], 'true'); assert.equal(hide.focused, true);
  // the saved "hidden" restored at mount sets the state too
  mem.tdot_case_notes_hidden = '1';
  const again = widget({ mem }); await tick();
  assert.equal(again.d.byId['cnp-hide'].attrs['aria-expanded'], 'false'); assert.equal(again.d.byId['cnp-rail'].attrs['aria-expanded'], 'false');
});

test('review 1 (page): a partial check shows a plain warning and no Add note box', async () => {
  const w = widget({ payload: PAYLOAD({ partial: true, canAdd: false }) }); await tick();
  assert.equal(w.d.byId['cnp-warn'].textContent, 'Could not check every consultation linked to this case, so Add note is off for now. Press Refresh in a minute.');
  assert.equal(w.tas().length, 0, 'Add note off on every card, whatever a card says');
});

// 2026-11-26 (Faran): the Client ID is what staff type in Otter when the client has one; the TD- code is the backup.
test('widget: a card with a Client ID shows "Type in Otter" + the Client ID and copies it; one without shows the code as the backup', async () => {
  const p = PAYLOAD();
  p.consultations[0] = { ...p.consultations[0], clientId: 'CL-2026-00042' };
  const w = widget({ payload: p }); await tick();
  const t = w.text();
  assert.ok(t.includes('Type in OtterCL-2026-00042') || (t.includes('Type in Otter') && t.includes('CL-2026-00042')), t.slice(0, 300));
  assert.ok(!t.includes('TD-00011'), 'the code is not shown when the client has a Client ID');
  assert.ok(t.includes('Type in Otter (no Client ID yet)') && t.includes('TD-00012'), 'the other card: the code');
  // Copy copies what is shown
  let copied = '';
  w.ctx.navigator.clipboard = { writeText: (v) => { copied = v; return Promise.resolve(); } };
  const btn = w.d.find((n) => n.tagName === 'BUTTON' && n.title === 'Copy what to type in Otter')[0];
  btn.onclick(); await tick();
  assert.equal(copied, 'CL-2026-00042');
});

test('caseLeadSet: each lead carries its Lead Board Client ID copy ("" when none) — the card shows it', async () => {
  const s = stubSet({ linked: [L(1, { bookedSlot: '2026-09-01 10:00', clientId: 'CL-2026-00042' }), L(2, { bookedSlot: '2026-11-01 10:00' })] });
  try {
    const r = await svc.caseLeadSet('900', '2026-EE-900', { recordUrl: '' });
    assert.deepEqual(r.leads.map((l) => [l.leadId, l.clientId]), [['2', ''], ['1', 'CL-2026-00042']]);
    assert.deepEqual(r.leads.map((l) => routes.cardOf(l).clientId), ['', 'CL-2026-00042']);
  } finally { s.restore(); }
});
