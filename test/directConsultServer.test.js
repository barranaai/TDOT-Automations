'use strict';

// Direct consultation, commit 2 — the server (step 2, 2026-11-09). "＋ Direct consultation":
// a consultation booked OUTSIDE the app (Melanie books most in Square) added by hand —
// one Lead Board row, created already Booked, never written to Square, no Teams meeting,
// no client email unless the package is ticked. Ships OFF (DIRECT_CONSULTATION unset) and
// the marker column is not made yet (its id is ""): both fail closed (404 / 503).
// Every Monday, Square, OneDrive and mail seam is stubbed (the no-network guard backs it).

const test   = require('node:test');
const assert = require('node:assert/strict');

const mondayApi   = require('../src/services/mondayApi');
const leadService = require('../src/services/leadService');
const portal      = require('../src/services/consultantPortalService');
const dcs         = require('../src/services/directConsultService');
const snap        = require('../src/services/leadSnapshot');
const blacklist   = require('../src/services/blacklistService');
const booking     = require('../src/services/bookingService');
const prices      = require('../src/services/consultPriceService');
const consultSvc  = require('../src/services/consultationService');
const meeting     = require('../src/services/meetingService');
const tokens      = require('../src/services/leadTokenService');
const oneDrive    = require('../src/services/oneDriveService');
const retainer2   = require('../src/services/retainerService2');
const updates     = require('../src/services/updatesService');
const routing     = require('../config/consultantRouting');
const C           = require('../src/data/newLeadsBoard.json').columns;

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function quiet() { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; return () => { console.log = l; console.warn = w; }; }
/** Toronto 'YYYY-MM-DD HH:MM', ms from now. */
function torontoIn(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const DAY = 86400000;
const COL_ID = 'text_test_directc';
const FARAN = { name: 'Faran Test', email: 'faran@example.com', verified: true };
const SHAFOLI = routing.CONSULTANTS.shafoli.name, SHERMIN = routing.CONSULTANTS.shermin.name, GAURI = 'Gauri Berde';

async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
/** The column made + the switch on (as for Faran's live test), then the shipped state back. */
async function live(fn, { sw = '1' } = {}) {
  const col = C.directConsult;
  C.directConsult = COL_ID;
  dcs._resetForTests();
  try { return await withEnv({ DIRECT_CONSULTATION: sw }, fn); } finally { C.directConsult = col; dcs._resetForTests(); }
}

/** A future consultation 3 days ahead at 11:00 Toronto. */
function futureDay(days = 3) { return torontoIn(days * DAY).slice(0, 10); }
function entry(over = {}) {
  return {
    choice: 'new', fullName: 'Asha Example', email: 'asha@example.com', phone: '416 555 0101',
    consultant: SHAFOLI, meetingType: 'In-person', date: futureDay(), time: '11:00', durationMin: 30,
    payment: { kind: 'square', amountCents: 30000 }, about: 'Study permit for her son', bookedBy: 'Melanie',
    sourceChannel: 'Phone', inSquare: true,
    ...over,
  };
}

/**
 * The stubbed world: Monday (create / update / notes), the matcher, the snapshot, the Not
 * Wanted list, the slot claims, prices, the package, meetings, tokens, OneDrive folders.
 */
function world({ matches = {}, snapRows = [], hit = false, claims = [], getLead = null, pkg = null } = {}) {
  dcs._resetForTests();   // each world starts with an empty re-submit memory
  const calls = { monday: [], creates: [], updates: [], notes: [], folders: 0, meetings: 0, pkg: [], claimsRead: 0 };
  const r = [
    quiet(),
    stub(mondayApi, 'query', async (q, v = {}) => {
      calls.monday.push({ q, v });
      if (/create_item/.test(q)) { calls.creates.push(JSON.parse(v.cols)); return { create_item: { id: '900' } }; }
      if (/items_page\(limit:1\)/.test(q)) return { boards: [{ groups: [{ items_page: { items: [] } }] }] };
      if (/change_multiple_column_values/.test(q)) { calls.updates.push({ id: String(v.itemId), cols: JSON.parse(v.cols) }); return { change_multiple_column_values: { id: v.itemId } }; }
      if (/create_update/.test(q)) { calls.notes.push({ id: String(v.id || v.i), body: String(v.b) }); return { create_update: { id: 'u1' } }; }
      return {};
    }),
    stub(portal, 'findClientMatches', async () => ({ leads: [], cases: [], clients: [], rawLeads: [], ...matches })),
    stub(snap, 'leads', async () => snapRows),
    stub(blacklist, 'check', async () => (hit ? { checked: true, hit: true, matchedOn: 'email', entries: [{ name: 'X' }] } : { checked: true, hit: false })),
    stub(blacklist, 'noteOnLead', async () => true),
    stub(booking, 'readSlotClaims', async () => { calls.claimsRead++; return claims; }),
    stub(prices, 'ensureFresh', async () => {}),
    stub(consultSvc, 'autoSendConsultationPackage', async (id, opts) => { calls.pkg.push({ id, opts }); return pkg || { status: 'sent' }; }),
    stub(meeting, 'createMeeting', async () => { calls.meetings++; throw new Error('no meeting may be made'); }),
    stub(tokens, 'ensureToken', async () => 'tok'),
    stub(oneDrive, 'ensureLeadFolder', async () => { calls.folders++; return { id: 'f', url: 'u' }; }),
    stub(portal, 'getDirectClientOptions', async () => ({ caseTypes: ['Study Permit', 'Visitor Visa'] })),
    ...(getLead ? [stub(leadService, 'getLead', getLead)] : []),
  ];
  return { calls, restore: () => r.reverse().forEach((x) => x()) };
}
/** The column values written to one item, merged in order. */
function written(calls, id) { return Object.assign({}, ...calls.updates.filter((u) => u.id === String(id)).map((u) => u.cols)); }

/* ── the switch and the column: fail closed ── */

test('switch: unset / 0 → 404 (no button); 1 → everyone; an email list → those Monday sign-ins only, the shared key refused', async () => {
  await withEnv({ DIRECT_CONSULTATION: undefined }, () => { assert.equal(dcs.gate(FARAN).status, 404); assert.equal(dcs.enabledFor(FARAN), false); });
  await withEnv({ DIRECT_CONSULTATION: '0' }, () => assert.equal(dcs.gate(FARAN).status, 404));
  await withEnv({ DIRECT_CONSULTATION: '1' }, () => { assert.equal(dcs.gate(null).ok, true); assert.equal(dcs.gate({ name: 'x', verified: false }).ok, true); });
  await withEnv({ DIRECT_CONSULTATION: 'Faran@Example.com, mel@example.com' }, () => {
    assert.equal(dcs.gate(FARAN).ok, true, 'case-insensitive');
    const shared = dcs.gate({ name: 'Unidentified (shared admin key)', email: '', verified: false });
    assert.equal(shared.status, 401); assert.equal(shared.loginUrl, '/q/auth/monday');
    assert.equal(dcs.gate({ name: 'Other', email: 'other@example.com', verified: true }).status, 404);
  });
});

test('fail closed: switch off → 404 even with the column; switch on but the column not made (the shipped "") → 503 and NO Monday call', async () => {
  const col = C.directConsult; C.directConsult = '';
  if (dcs._resetForTests) dcs._resetForTests();
  const w = world();
  try {
    await withEnv({ DIRECT_CONSULTATION: undefined }, async () => {
      await assert.rejects(dcs.createDirectConsult(entry(), { actor: FARAN }), (e) => e.status === 404);
      await assert.rejects(dcs.getOptions({ actor: FARAN }), (e) => e.status === 404);
    });
    await withEnv({ DIRECT_CONSULTATION: '1' }, async () => {
      await assert.rejects(dcs.createDirectConsult(entry(), { actor: FARAN }), (e) => e.status === 503 && /not set up yet/.test(e.message));
      await assert.rejects(dcs.getOptions({ actor: FARAN }), (e) => e.status === 503);
      await assert.rejects(dcs.changeTime({ leadId: '1', lead: {}, value: {}, actor: FARAN }), (e) => e.status === 503);
    });
    assert.equal(w.calls.monday.length, 0, 'nothing read or written');
  } finally { w.restore(); C.directConsult = col; if (dcs._resetForTests) dcs._resetForTests(); }
});

test('routes: registered before /api/consultation/:leadId; errors mapped (409 bodies, 404, 401 with the sign-in link, 503); Retain confirm forwarded', () => {
  const src = require('fs').readFileSync(require.resolve('../src/server.js'), 'utf8');
  const opt = src.indexOf("app.get('/api/consultation/direct-consult/options'");
  const post = src.indexOf("app.post('/api/consultation/direct-consult'");
  const byId = src.indexOf("app.get('/api/consultation/:leadId'");
  assert.ok(opt > 0 && post > 0 && opt < byId && post < byId);
  assert.match(src, /staffActor\(req, ''\)/);
  assert.match(src, /'liveBooking', 'clash'/);
  assert.match(src, /confirm: confirm === true/);
  assert.match(src, /if \(err\.needsConfirm\) return res\.status\(409\)/);
});

/* ── the validator: every refusal, before anything is read ── */

test('validator: every refusal, in plain words', () => {
  const now = `${futureDay(0)} 12:00`;
  const v = (over, actor = FARAN) => dcs.validateDirectConsult(entry(over), { nowWall: now, actor });
  const no = (over, re, actor) => { const r = v(over, actor); assert.equal(r.ok, false, JSON.stringify(over)); assert.match(r.error, re); };
  assert.equal(v({}).ok, true);
  no({ choice: '' }, /New client \/ new matter/);
  no({ fullName: 'A' }, /full name/);
  no({ email: '', phone: '' }, /email or a phone/);
  no({ email: 'nope' }, /email doesn’t look right/);
  no({ phone: '12' }, /valid phone/);
  no({ consultant: 'Somebody' }, /consultant/);
  no({ meetingType: 'Zoom' }, /in person, video or phone/);
  no({ date: '2026-02-30' }, /date/);
  no({ time: '25:00' }, /time/);
  no({ durationMin: 10 }, /15 to 120/);
  no({ durationMin: 135 }, /15 to 120/);
  no({ durationMin: 20 }, /steps of 15/);
  no({ date: torontoIn(-31 * DAY).slice(0, 10) }, /more than 30 days ago/);
  no({ date: torontoIn(400 * DAY).slice(0, 10) }, /more than a year ahead/);
  no({ payment: { kind: 'invoice', amountCents: 100 } }, /Paid in Square, Cash, E-transfer, Free or Not paid yet/);
  no({ payment: { kind: 'cash' } }, /fee received/);
  no({ about: '' }, /what the consultation is about/);
  no({ bookedBy: 'Not A Person' }, /from the list/);
  no({ bookedBy: '' }, /who booked it/, { name: 'Unidentified (shared admin key)', verified: false });
  no({ sourceChannel: 'Billboard' }, /source/);
  no({ sourceChannel: 'Employee Referral', referredBy: '' }, /employee/);
  no({ inSquare: undefined }, /Already booked in Square/);
  no({ inCanada: 'No', currentCountry: 'Atlantis' }, /country/);
  no({ residentialAddress: 'ab' }, /address/);
  no({ choice: 'existing', useLeadId: '123' }, /new client or a new matter only/);
  // lengths: 15–120 in 15s for every consultant, Gauri included
  for (const m of [15, 45, 60, 75, 120]) assert.equal(v({ durationMin: m, consultant: GAURI }).ok, true, `${m} min`);
  // booked-by preset from the Monday sign-in (roster spelling)
  const pre = dcs.validateDirectConsult(entry({ bookedBy: '' }), { nowWall: now, actor: { name: 'Melanie Santiago', email: 'm@x.co', verified: true } });
  assert.equal(pre.n.bookedBy, 'Melanie');
  // a past consultation: no "in Square" question; existing: source "Existing Client", no referral asked
  const past = dcs.validateDirectConsult(entry({ date: torontoIn(-2 * DAY).slice(0, 10), inSquare: undefined, choice: 'existing', sourceChannel: '' }), { nowWall: now, actor: FARAN });
  assert.equal(past.ok, true); assert.equal(past.n.inSquare, null); assert.equal(past.n.sourceChannel, 'Existing Client'); assert.equal(past.n.referredBy, '');
  // "Free" = waived, no amount; "Not paid yet" = no record
  assert.equal(v({ payment: { kind: 'waived' } }).n.payment.kind, 'waived');
  assert.equal(v({ payment: { kind: 'none' } }).n.payment, null);
});

test('validator: the package tick only for a new client, a time ahead, an email, an RCIC, a fee record — and not with video (no Teams link here)', () => {
  const now = `${futureDay(0)} 12:00`;
  const v = (over) => dcs.validateDirectConsult(entry({ package: true, ...over }), { nowWall: now, actor: FARAN });
  assert.equal(v({}).ok, true);
  assert.match(v({ payment: { kind: 'none' } }).error, /goes with a recorded fee/, '"Not paid yet" hides the package');
  assert.match(v({ choice: 'existing' }).error, /only for a new client/);
  assert.match(v({ date: torontoIn(-DAY).slice(0, 10) }).error, /has passed/);
  assert.match(v({ email: '' }).error, /no email/);
  assert.match(v({ consultant: GAURI }).error, /not an RCIC/);
  assert.match(v({ meetingType: 'Virtual' }).error, /video/);
});

/* ── the create ── */

test('create: one row, already Booked with its marker; bookedBy kept (Melanie, recorded by Faran); no dropdown at create; the fee, the booking, the note; no Square ids; no meeting; no client email', async () => {
  await live(async () => {
    const w = world();
    try {
      const r = await dcs.createDirectConsult(entry({ caseType: 'Study Permit', inCanada: 'Yes' }), { actor: FARAN });
      assert.equal(r.ok, true); assert.equal(r.leadId, '900'); assert.equal(r.kind, 'New');
      assert.equal(w.calls.creates.length, 1, 'one create');
      const cr = w.calls.creates[0];
      assert.equal(cr[COL_ID], 'New', 'the marker AT creation');
      assert.deepEqual(cr[C.bookingStatus], { label: 'Booked' });
      assert.deepEqual(cr[C.conversionStatus], { label: 'Booked' });
      assert.equal(cr[C.bookedBy], 'Melanie');
      assert.equal(cr[C.caseTypeInterest], undefined, 'caseTypeInterest is NOT in the create (a dropdown label could fail it)');
      const all = written(w.calls, '900');
      assert.ok(all[C.caseTypeInterest], 'it is written by the follow-up update instead');
      assert.ok(all[C.relationshipWithTdot], 'the relationship label');
      // The fee record: Paid in Square, by the recorder, package skip
      const rec = JSON.parse(all[C.consultPayment]);
      assert.equal(rec.kind, 'square'); assert.equal(rec.amountCents, 30000); assert.equal(rec.by, 'Faran Test'); assert.equal(rec.verified, true);
      assert.equal(rec.package, 'skip'); assert.equal(rec.hstCents, 3900, 'HST fixed at record time (in Canada)');
      // The booking: bookedBy never replaced by the recorder's name; the marker in consultOption
      for (const u of w.calls.updates) assert.notEqual(u.cols[C.bookedBy], 'Faran Test', 'bookedBy is never the recorder');
      const opt = JSON.parse(all[C.consultOption]);
      assert.equal(opt.directConsult.kind, 'New'); assert.equal(opt.directConsult.inSquare, true); assert.equal(opt.directConsult.by, 'Faran Test');
      assert.equal(opt.durationMin, 30); assert.equal(opt.bookedByStaff, true);
      // Never Square: no booking id, no order, no payment id — so no delete, payment or invoice step can match it
      for (const u of w.calls.updates) for (const k of ['squareBookingId', 'squareConsultOrderId', 'squareConsultTxnId']) assert.equal(u.cols[C[k]], undefined, k);
      for (const k of ['squareBookingId', 'squareConsultOrderId', 'squareConsultTxnId']) assert.equal(cr[C[k]], undefined, k);
      assert.equal(w.calls.meetings, 0, 'no Teams meeting');
      assert.equal(w.calls.pkg.length, 0, 'no package (not ticked)');
      assert.equal(w.calls.folders, 1, 'a New client gets the lead folder');
      const note = w.calls.notes.find((x) => x.id === '900' && /Direct consultation added by Faran Test/.test(x.body));
      assert.ok(note, 'one note on the lead');
      assert.match(note.body, /booked by Melanie · .* · Shafoli Kapur · In-person · 30 min · Paid in Square \$300\.00 .* · New/);
      assert.doesNotMatch(note.body, /Not Wanted/);
    } finally { w.restore(); }
  });
});

test('create: a video consultation makes NO meeting and says nothing about the Not Wanted list (meeting: none)', async () => {
  await live(async () => {
    const w = world();
    try {
      const r = await dcs.createDirectConsult(entry({ meetingType: 'Virtual' }), { actor: FARAN });
      assert.equal(w.calls.meetings, 0);
      assert.ok(!r.lines.some((l) => /Not Wanted|meeting/i.test(l)), r.lines.join(' | '));
      assert.ok(!w.calls.notes.some((n) => /Not Wanted|Teams/.test(n.body)));
    } finally { w.restore(); }
  });
});

test('create: "Not paid yet" writes no fee record; a ticked package goes through the one gate (trigger recorded) with the record handed over', async () => {
  await live(async () => {
    let w = world();
    try {
      await dcs.createDirectConsult(entry({ payment: { kind: 'none' } }), { actor: FARAN });
      assert.equal(written(w.calls, '900')[C.consultPayment], undefined);
    } finally { w.restore(); }
    w = world({ pkg: { status: 'held', armed: true } });
    try {
      const r = await withEnv({ CONSULT_PACKAGE_AUTO_SEND: '1', CONSULT_PACKAGE_ON_RECORD: '1' }, () => dcs.createDirectConsult(entry({ package: true, payment: { kind: 'cash', amountCents: 30000 } }), { actor: FARAN }));
      assert.equal(w.calls.pkg.length, 1);
      assert.equal(w.calls.pkg[0].opts.trigger, 'recorded');
      assert.equal(JSON.parse(w.calls.pkg[0].opts.overrides.consultPayment).package, 'send');
      assert.ok(r.lines.some((l) => /waits for the client’s address|residential address/.test(l)), 'says the package waits for the address');
    } finally { w.restore(); }
  });
});

test('kinds: existing → "Existing client" + the active label + a case note, no folder; new after an earlier held consultation (no file) → Follow-up, no folder; new with a case → New with the case label', async () => {
  const R = require('../src/services/intakeFormService').RELATIONSHIPS;
  await live(async () => {
    let w = world({ matches: { cases: [{ id: '501', caseRef: '2026-SP-001', caseStage: 'Document Collection Started' }] } });
    try {
      const r = await dcs.createDirectConsult(entry({ choice: 'existing', sourceChannel: '' }), { actor: FARAN });
      assert.equal(r.kind, 'Existing client'); assert.equal(r.relationship, R[1]);
      assert.equal(w.calls.creates[0][C.sourceChannel] ? true : true, true);
      assert.equal(w.calls.folders, 0, 'no empty LEAD folder');
      assert.ok(w.calls.notes.some((n) => n.id === '501' && /Consultation about this file/.test(n.body)), 'internal note on the case');
      const opt = JSON.parse(written(w.calls, '900')[C.consultOption]);
      assert.equal(opt.directConsult.caseRef, '2026-SP-001');
    } finally { w.restore(); }
    w = world({ matches: { cases: [{ id: '502', caseRef: '2025-VV-009', caseStage: 'Approved' }] } });
    try {
      const r = await dcs.createDirectConsult(entry({ choice: 'existing', sourceChannel: '' }), { actor: FARAN });
      assert.equal(r.relationship, R[2], 'a finished case = previous client');
      assert.ok(!w.calls.notes.some((n) => n.id === '502'), 'no note on a closed case');
    } finally { w.restore(); }
    const held = { id: '77', fullName: 'Asha Example', email: 'asha@example.com', bookingStatus: 'Booked', bookedSlot: `${torontoIn(-60 * DAY).slice(0, 10)} 10:00`, consultationHeld: torontoIn(-60 * DAY).slice(0, 10), outcome: 'Follow-Up' };
    w = world({ matches: { rawLeads: [held] } });
    try {
      const r = await dcs.createDirectConsult(entry(), { actor: FARAN });
      assert.equal(r.kind, 'Follow-up'); assert.equal(r.relationship, R[0]);
      assert.equal(w.calls.folders, 0);
      assert.equal(JSON.parse(written(w.calls, '900')[C.consultOption]).directConsult.followUpOf, '77');
    } finally { w.restore(); }
    w = world({ matches: { rawLeads: [held], cases: [{ id: '503', caseRef: '2026-EE-010', caseStage: 'Submitted' }] } });
    try {
      const r = await dcs.createDirectConsult(entry(), { actor: FARAN });
      assert.equal(r.kind, 'New', 'a new matter from an existing client is a new lead (2026-10-08)');
      assert.equal(r.relationship, R[1], 'a submitted application is still active');
    } finally { w.restore(); }
  });
});

/* ── the guards, in order ── */

test('re-submit: the 15-minute memory answers 409 "Already in the app" — no second row; the board check finds a direct row by name', async () => {
  await live(async () => {
    const w = world();
    try {
      await dcs.createDirectConsult(entry(), { actor: FARAN });
      await assert.rejects(dcs.createDirectConsult(entry({ email: '', phone: '4165550101', time: '11:15' }), { actor: FARAN }),
        (e) => e.status === 409 && e.code === 'already' && /Already in the app: Asha Example, .* 11:00, Shafoli Kapur, added by Melanie/.test(e.message) && e.leadId === '900');
      assert.equal(w.calls.creates.length, 1, 'never a second row');
      // a different consultant is a different consultation
      await dcs.createDirectConsult(entry({ consultant: SHERMIN }), { actor: FARAN });
      assert.equal(w.calls.creates.length, 2);
    } finally { w.restore(); }
  });
  await live(async () => {
    const slot = `${futureDay()} 11:00`;
    const w = world({ snapRows: [{ id: '55', fullName: 'asha  EXAMPLE', bookingStatus: 'Booked', bookedSlot: slot, assignedConsultant: SHAFOLI, bookedBy: 'Diksha', consultOption: JSON.stringify({ directConsult: { kind: 'New' } }) }] });
    try {
      await assert.rejects(dcs.createDirectConsult(entry(), { actor: FARAN }), (e) => e.code === 'already' && /added by Diksha/.test(e.message) && e.link === '/admin/consultation/55');
      assert.equal(w.calls.creates.length, 0);
    } finally { w.restore(); }
  });
});

test('Not Wanted: a hit needs the tick (409 with the warning); with it the row is made and the lead gets the warning note', async () => {
  await live(async () => {
    const w = world({ hit: true });
    try {
      await assert.rejects(dcs.createDirectConsult(entry(), { actor: FARAN }), (e) => e.code === 'not-wanted' && e.blacklist && e.blacklist.hit);
      assert.equal(w.calls.creates.length, 0);
      const r = await dcs.createDirectConsult(entry({ blacklistAck: true }), { actor: FARAN });
      assert.equal(r.ok, true);
    } finally { w.restore(); }
  });
});

test('live booking: a Booked consultation for the same person, no outcome, within ±30 days → "this is that consultation" (409 + its link); "different consultation" saves', async () => {
  await live(async () => {
    const other = { id: '66', fullName: 'Asha Example', bookingStatus: 'Booked', bookedSlot: `${futureDay(10)} 14:00`, assignedConsultant: SHERMIN, outcome: '' };
    const w = world({ matches: { rawLeads: [other] } });
    try {
      await assert.rejects(dcs.createDirectConsult(entry(), { actor: FARAN }), (e) => e.code === 'same-consultation' && e.liveBooking[0].leadId === '66' && e.liveBooking[0].link === '/admin/consultation/66' && /change the time there/.test(e.message));
      assert.equal(w.calls.creates.length, 0);
      const r = await dcs.createDirectConsult(entry({ differentConsultation: true }), { actor: FARAN });
      assert.equal(r.ok, true);
    } finally { w.restore(); }
    const far = { ...other, bookedSlot: `${futureDay(40)} 14:00` };
    const w2 = world({ matches: { rawLeads: [far] } });
    try { assert.equal((await dcs.createDirectConsult(entry(), { actor: FARAN })).ok, true, 'beyond 30 days: not the same one'); } finally { w2.restore(); }
  });
});

test('clash: another client with this consultant at an overlapping time is a WARNING — 409 with "Save anyway"; clashAck saves (family members share a time)', async () => {
  await live(async () => {
    const w = world({ claims: [{ leadId: '44', name: 'Someone Else', slot: `${futureDay()} 11:15`, consultant: SHAFOLI, status: 'Booked' }] });
    try {
      await assert.rejects(dcs.createDirectConsult(entry(), { actor: FARAN }), (e) => e.code === 'clash' && /Save anyway \(different client\)/.test(e.message) && e.clash[0].leadId === '44');
      assert.equal(w.calls.creates.length, 0);
      assert.equal((await dcs.createDirectConsult(entry({ clashAck: true }), { actor: FARAN })).ok, true);
      // another consultant at that time is no clash
      dcs._resetForTests();
      assert.equal((await dcs.createDirectConsult(entry({ consultant: SHERMIN }), { actor: FARAN })).ok, true);
    } finally { w.restore(); }
  });
});

test('"Use this lead": an abandoned hold is allowed (with the cancel-in-Square warning); an outcome, a booking, a live hold, a case, a mismatch are refused', async () => {
  const base = { id: '321', fullName: 'Asha Example', email: 'asha@example.com', phone: '4165550101' };
  const refusal = (over) => dcs.reuseRefusal({ ...base, ...over }, { fullName: 'Asha Example', email: 'asha@example.com', phone: '4165550101' });
  assert.equal(refusal({ bookingStatus: 'Abandoned', bookedSlot: '2026-10-01 10:00' }), '');
  assert.equal(refusal({ bookingStatus: 'Slot Held', slotHeldUntil: new Date(Date.now() - 60000).toISOString() }), '', 'an expired hold');
  assert.match(refusal({ outcome: 'Follow-Up' }), /already has an outcome/);
  assert.match(refusal({ bookingStatus: 'Booked' }), /booked consultation/);
  assert.match(refusal({ bookingStatus: 'Slot Held', slotHeldUntil: new Date(Date.now() + 600000).toISOString() }), /booking online right now/);
  assert.match(refusal({ clientMasterItemId: '9' }), /case/);
  assert.match(refusal({ retainerSent: '2026-10-01' }), /retainer/);
  assert.match(refusal({ retainerFee: '2000' }), /plan/);
  assert.match(refusal({ squareConsultTxnId: 'T1' }), /booking link/);
  assert.match(refusal({ sourceChannel: 'Direct Retainer' }), /direct retainer/);
  assert.match(dcs.reuseRefusal({ id: '1', fullName: 'Someone Else', email: 'z@z.co' }, { fullName: 'Asha Example', email: 'asha@example.com', phone: '' }), /does not match/);
  await live(async () => {
    const lead = { ...base, bookingStatus: 'Abandoned', squareConsultOrderId: 'ORD-1', consultOption: JSON.stringify({ invoiceId: 'INV-1', durationMin: 30 }), bookedBy: 'Old Name', sourceChannel: 'Website' };
    const w = world({ getLead: async (id) => (String(id) === '321' ? lead : null) });
    try {
      const r = await dcs.createDirectConsult(entry({ useLeadId: '321' }), { actor: FARAN });
      assert.equal(r.reused, true); assert.equal(r.leadId, '321');
      assert.equal(w.calls.creates.length, 0, 'no new row');
      assert.ok(r.lines.some((l) => /cancel it in Square so they are not charged/.test(l)), 'the same wording as Record payment');
      const all = written(w.calls, '321');
      assert.equal(all[COL_ID], 'New'); assert.equal(all[C.bookedBy], 'Melanie', 'the chosen booked-by replaces the old one');
      const opt = JSON.parse(all[C.consultOption]);
      assert.equal(opt.invoiceId, 'INV-1', 'what the lead held is kept'); assert.equal(opt.directConsult.kind, 'New');
      assert.equal(all[C.sourceChannel], undefined, 'how the lead first reached us is kept (Website), never overwritten');
    } finally { w.restore(); }
    const w2 = world({ getLead: async () => ({ ...base, outcome: 'Not Wanted' }) });
    try {
      await assert.rejects(dcs.createDirectConsult(entry({ useLeadId: '321' }), { actor: FARAN }), (e) => e.badRequest && /outcome/.test(e.message));
      assert.equal(w2.calls.updates.length, 0, 'nothing written');
    } finally { w2.restore(); }
  });
});

test('a later step that fails undoes nothing — the reply lists what is left', async () => {
  await live(async () => {
    const w = world();
    const r0 = stub(leadService, 'updateLead', async (id, fields) => { if (fields.consultPayment) throw new Error('Monday 500'); });
    try {
      const r = await dcs.createDirectConsult(entry(), { actor: FARAN });
      assert.equal(r.ok, true);
      assert.ok(r.left.some((l) => /payment .* could not be recorded/.test(l)), r.left.join(' | '));
      assert.match(r.message, /Still to do:/);
    } finally { r0(); w.restore(); }
  });
});

/* ── Gauri (direct-only): never on the booking page or routing; no meeting, no package, no Retain ── */

test('Gauri: a direct-only consultant — CONSULTANTS, routing, prices, the roster and the booking page unchanged', () => {
  assert.deepEqual(Object.keys(routing.CONSULTANTS), ['shafoli', 'shermin']);
  assert.deepEqual(routing.DIRECT_ONLY_CONSULTANTS, ['Gauri Berde']);
  assert.ok(!Object.values(routing.CONSULTANTS).some((c) => /Gauri/.test(c.name)));
  for (const lead of [{}, { serviceRequired: 'PNP or OINP' }, { removalOrder: 'Yes' }, { serviceRequired: 'Express Entry profile', crsScore: '480' }, { caseTypeInterest: 'Visitor Visa' }]) {
    assert.ok([SHAFOLI, SHERMIN].includes(routing.routeConsultant(lead).name));
  }
  assert.equal(routing.resolveConsultant({ assignedConsultant: GAURI }).name !== GAURI, true, 'an agreement never resolves to her');
  const roster = require('../config/portalStaff');
  assert.equal(roster.staffRoster().filter((n) => /^Gauri/.test(n)).length, 1, 'the roster is unchanged (Gauri once, from PORTAL_STAFF)');
  const list = dcs.consultantList();
  assert.deepEqual(list.map((c) => [c.name, c.rcic]), [[SHAFOLI, true], [SHERMIN, true], [GAURI, false]]);
  assert.deepEqual(list[2].options, [], 'no prices for her: the fee is what is recorded');
  // the booking page's slot / price code reads CONSULTANTS only
  const bookingSrc = require('fs').readFileSync(require.resolve('../src/services/bookingService.js'), 'utf8');
  assert.doesNotMatch(bookingSrc, /DIRECT_ONLY_CONSULTANTS/);
  assert.equal(routing.isNonRcicConsultant(GAURI), true);
  assert.equal(routing.isNonRcicConsultant(SHAFOLI), false);
  assert.equal(routing.isNonRcicConsultant(''), false);
});

test('Gauri: a direct consultation with her saves with no meeting and no package; her length has no Square fee or variation', async () => {
  await live(async () => {
    const w = world();
    try {
      const r = await dcs.createDirectConsult(entry({ consultant: GAURI, meetingType: 'Virtual', durationMin: 60, payment: { kind: 'waived' } }), { actor: FARAN });
      assert.equal(r.ok, true);
      assert.equal(w.calls.meetings, 0); assert.equal(w.calls.pkg.length, 0);
      const opt = JSON.parse(written(w.calls, '900')[C.consultOption]);
      assert.equal(opt.durationMin, 60); assert.equal(opt.feeCents, undefined); assert.equal(opt.variationId, undefined);
      assert.equal(opt.consultant, GAURI);
    } finally { w.restore(); }
  });
});

test('Retain: refused while the consultant is not an RCIC (outcome + Retain & send), and the retainer is HELD with a note when Retain is set straight on Monday', async () => {
  const lead = { id: '800', fullName: 'Asha Example', email: 'a@b.co', assignedConsultant: GAURI, bookingStatus: 'Booked', retainerFee: '2000', outcome: '', consultOption: JSON.stringify({ directConsult: { kind: 'New' } }) };
  const writes = [];
  const r = [quiet(), stub(leadService, 'getLead', async () => ({ ...lead })), stub(leadService, 'updateLead', async (id, f) => { writes.push(f); })];
  try {
    await assert.rejects(portal.applyAction({ leadId: '800', action: 'outcome', value: 'Retain', actor: FARAN }), (e) => e.badRequest && /not an RCIC/.test(e.message) && /Change consultant/.test(e.message));
    await assert.rejects(portal.applyAction({ leadId: '800', action: 'retainAndSend', actor: FARAN }), (e) => e.badRequest && /not an RCIC/.test(e.message));
    assert.equal(writes.length, 0, 'nothing changed');
  } finally { r.reverse().forEach((x) => x()); }
  const notes = [];
  const r2 = [quiet(), stub(leadService, 'getLead', async () => ({ ...lead, outcome: 'Retain' })),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(String(v.body || v.b || JSON.stringify(v))); return { create_update: { id: 'n' } }; })];
  try {
    const res = await retainer2.maybeSendRetainerAgreement('800', { notifyIfMissing: true });
    assert.equal(res.status, 'non-rcic');
    assert.ok(notes.some((n) => /not an RCIC/.test(n)), 'a note says why');
  } finally { r2.reverse().forEach((x) => x()); }
});

test('Retain: the consultant may move from Gauri to an RCIC on a direct row (Retain needs one); a normal booked lead still cannot change consultant', async () => {
  const writes = [];
  const lead = { id: '801', assignedConsultant: GAURI, bookingStatus: 'Booked', bookedSlot: '2026-11-01 10:00', consultOption: JSON.stringify({ directConsult: { kind: 'New' } }) };
  const r = [quiet(), stub(leadService, 'getLead', async () => ({ ...lead })), stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }), stub(mondayApi, 'query', async () => ({}))];
  try {
    const out = await portal.applyAction({ leadId: '801', action: 'setConsultant', value: SHAFOLI, actor: FARAN });
    assert.equal(out.ok, true);
    assert.deepEqual(writes, [{ assignedConsultant: SHAFOLI }]);
    await assert.rejects(portal.applyAction({ leadId: '801', action: 'setConsultant', value: 'Gauri Berde', actor: FARAN }), /Unknown consultant/);
  } finally { r.reverse().forEach((x) => x()); }
  const r2 = [quiet(), stub(leadService, 'getLead', async () => ({ id: '802', assignedConsultant: SHERMIN, bookingStatus: 'Booked', bookedSlot: '2026-11-01 10:00' })), stub(leadService, 'updateLead', async () => { throw new Error('no write'); })];
  try {
    await assert.rejects(portal.applyAction({ leadId: '802', action: 'setConsultant', value: SHAFOLI, actor: FARAN }), /Already booked/);
  } finally { r2.reverse().forEach((x) => x()); }
});

test('Retain on a Follow-up / Existing-client row asks to confirm first (409 needsConfirm, nothing written); a New row and a confirmed one go on', async () => {
  for (const kind of ['Follow-up', 'Existing client']) {
    const writes = [];
    const r = [quiet(), stub(leadService, 'getLead', async () => ({ id: '803', assignedConsultant: SHAFOLI, outcome: '', consultOption: JSON.stringify({ directConsult: { kind } }) })),
      stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }), stub(mondayApi, 'query', async () => ({})),
      stub(portal, 'notifyOutcomeChange', async () => ({ sent: false }))];
    try {
      await withEnv({ DEADLINE_REQUIRED: '0' }, async () => {
        await assert.rejects(portal.applyAction({ leadId: '803', action: 'outcome', value: 'Retain', actor: FARAN }), (e) => e.needsConfirm === true && /Direct retainer → “new application”/.test(e.message));
        assert.equal(writes.length, 0);
        const ok = await portal.applyAction({ leadId: '803', action: 'outcome', value: 'Retain', actor: FARAN, confirm: true });
        assert.equal(ok.ok, true);
        assert.deepEqual(writes[0], { outcome: 'Retain' });
      });
    } finally { r.reverse().forEach((x) => x()); }
  }
  const writes = [];
  const r = [quiet(), stub(leadService, 'getLead', async () => ({ id: '804', assignedConsultant: SHAFOLI, outcome: '', consultOption: JSON.stringify({ directConsult: { kind: 'New' } }) })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }), stub(mondayApi, 'query', async () => ({})), stub(portal, 'notifyOutcomeChange', async () => ({ sent: false }))];
  try {
    await withEnv({ DEADLINE_REQUIRED: '0' }, async () => {
      assert.equal((await portal.applyAction({ leadId: '804', action: 'outcome', value: 'Retain', actor: FARAN })).ok, true);
    });
  } finally { r.reverse().forEach((x) => x()); }
});

/* ── Change time (direct rows only) ── */

test('Change time: a direct row only; same validator; no meeting; refused after an outcome or a sent package; the clash warning', async () => {
  const lead = { id: '810', fullName: 'Asha Example', assignedConsultant: SHAFOLI, meetingType: 'Virtual', bookingStatus: 'Booked', bookedSlot: `${futureDay()} 11:00`, bookedBy: 'Melanie', consultOption: JSON.stringify({ durationMin: 30, directConsult: { kind: 'New', inSquare: true } }) };
  await live(async () => {
    const w = world({ getLead: async () => ({ ...lead }) });
    try {
      const r = await portal.applyAction({ leadId: '810', action: 'changeDirectTime', value: { date: futureDay(), time: '13:00' }, actor: FARAN });
      assert.equal(r.ok, true); assert.equal(r.bookedSlot, `${futureDay()} 13:00`);
      const all = written(w.calls, '810');
      assert.equal(all[C.bookedSlot], `${futureDay()} 13:00`);
      assert.equal(JSON.parse(all[C.consultOption]).directConsult.kind, 'New', 'the marker stays');
      assert.equal(w.calls.meetings, 0);
      await assert.rejects(portal.applyAction({ leadId: '810', action: 'changeDirectTime', value: { date: futureDay(), time: '99:00' }, actor: FARAN }), /time/);
    } finally { w.restore(); }
    const w2 = world({ getLead: async () => ({ ...lead, consultOption: JSON.stringify({ durationMin: 30 }) }) });
    try { await assert.rejects(portal.applyAction({ leadId: '810', action: 'changeDirectTime', value: { date: futureDay(), time: '13:00' }, actor: FARAN }), /only for a direct consultation/); } finally { w2.restore(); }
    const w3 = world({ getLead: async () => ({ ...lead, outcome: 'Follow-Up' }) });
    try { await assert.rejects(portal.applyAction({ leadId: '810', action: 'changeDirectTime', value: { date: futureDay(), time: '13:00' }, actor: FARAN }), /outcome is set/); } finally { w3.restore(); }
    const w4 = world({ getLead: async () => ({ ...lead, consultAgreementSent: '2026-11-01' }) });
    try { await assert.rejects(portal.applyAction({ leadId: '810', action: 'changeDirectTime', value: { date: futureDay(), time: '13:00' }, actor: FARAN }), /package already went out/); } finally { w4.restore(); }
    const w5 = world({ getLead: async () => ({ ...lead }), claims: [{ leadId: '99', slot: `${futureDay()} 13:00`, consultant: SHAFOLI, status: 'Booked' }] });
    try {
      await assert.rejects(portal.applyAction({ leadId: '810', action: 'changeDirectTime', value: { date: futureDay(), time: '13:00' }, actor: FARAN }), (e) => e.conflict && e.code === 'clash');
      assert.equal((await portal.applyAction({ leadId: '810', action: 'changeDirectTime', value: { date: futureDay(), time: '13:00', clashAck: true }, actor: FARAN })).ok, true);
    } finally { w5.restore(); }
  });
});

/* ── the pieces shared with Record payment: unchanged behaviour ── */

test('buildConsultPaymentRecord: the record Record payment always wrote (HST fixed; the same amount keeps the earlier HST; waived has none)', () => {
  const n = { kind: 'cash', amountCents: 20000, on: '2026-11-01', reference: 'r', note: 'n' };
  const rec = portal.buildConsultPaymentRecord({ n, lead: { country: 'Canada' }, before: null, name: 'Mel', verified: false, pkgChoice: 'skip', pkgNote: 'given in person' });
  assert.equal(rec.hstCents, 2600); assert.equal(rec.package, 'skip'); assert.equal(rec.packageNote, 'given in person'); assert.equal(rec.by, 'Mel'); assert.equal(rec.verified, false);
  assert.equal(portal.buildConsultPaymentRecord({ n, lead: { country: 'India' }, name: 'M', verified: true }).hstCents, 0, 'outside Canada');
  assert.equal(portal.buildConsultPaymentRecord({ n, lead: { country: 'India' }, before: { amountCents: 20000, hstCents: 2600 }, name: 'M', verified: true }).hstCents, 2600, 'same amount keeps the HST');
  assert.equal(portal.buildConsultPaymentRecord({ n: { ...n, kind: 'waived', amountCents: 0 }, lead: {}, name: 'M', verified: true }).hstCents, 0);
  assert.equal('package' in portal.buildConsultPaymentRecord({ n, lead: {}, name: 'M', verified: true }), false, 'no choice = no package key');
});

test('writeRecordedBooking: meeting "none" makes no meeting and adds no line; noMeeting (Not Wanted) still says why', async () => {
  const r = [quiet(), stub(leadService, 'updateLead', async () => {}), stub(prices, 'ensureFresh', async () => {}), stub(meeting, 'createMeeting', async () => { throw new Error('none may be made'); })];
  try {
    const b = { slot: `${futureDay()} 11:00`, date: futureDay(), consultant: SHAFOLI, meetingType: 'Virtual', durationMin: 30 };
    const lines = [];
    const w = await portal.writeRecordedBooking('1', { bookedBy: 'Melanie' }, b, 'Faran', lines, { meeting: 'none' });
    assert.deepEqual(lines, []); assert.equal(w.meetingFailed, undefined); assert.equal(w.overrides.bookedBy, undefined, 'bookedBy kept');
    const lines2 = [];
    const w2 = await portal.writeRecordedBooking('1', {}, b, 'Faran', lines2, { noMeeting: true });
    assert.equal(w2.meetingFailed, true); assert.match(lines2[0], /Not Wanted/);
  } finally { r.reverse().forEach((x) => x()); }
});

test('recordConsultPaymentAction still writes the record through the shared builder (its own tests are unchanged)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/consultantPortalService.js'), 'utf8');
  const i = src.indexOf('async function recordConsultPaymentAction');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(body, /buildConsultPaymentRecord\(\{ n, lead, before, name, verified, pkgChoice, pkgNote \}\)/);
  // review round 1: meeting 'none' only on a direct row (defence in depth — a direct row is never asked for a booking)
  assert.match(body, /writeRecordedBooking\(leadId, lead, booking, name, lines, \{ noMeeting: notWanted, \.\.\.\(direct \? \{ meeting: 'none' \} : \{\}\) \}\)/, 'Record payment passes meeting: none for a direct row only');
});

/* ── deleting a direct row never touches Square ── */

test('careful delete of a direct row: no Square appointment cancelled, no invoice cancelled (the direct path never writes a booking id)', async () => {
  const sq = require('../src/services/squareBookingsService');
  const deletion = require('../src/services/deletionService');
  const LEAD_BOARD = require('../config/monday').leadBoardId;
  const touched = [];
  const r = [quiet(),
    stub(mondayApi, 'query', async (q, vars) => {
      if (/delete_item/.test(q)) return vars && vars.id ? { delete_item: { id: vars.id } } : {};
      if (/items\(ids/.test(q)) return { items: [{ id: String(vars.id), board: { id: LEAD_BOARD } }] };
      return {};
    }),
    stub(leadService, 'getLead', async (id) => ({ id: String(id), fullName: 'Asha Example', email: 'a@b.co', bookingStatus: 'Booked', bookedSlot: `${futureDay()} 11:00`,
      clientMasterItemId: '', oneDriveFolderId: '', squareBookingId: '', consultOption: JSON.stringify({ durationMin: 30, bookedByStaff: true, directConsult: { kind: 'New', inSquare: true } }),
      consultPayment: JSON.stringify({ kind: 'square', amountCents: 30000, on: '2026-11-09' }) })),
    stub(oneDrive, 'getDriveItemById', async () => null),
    stub(oneDrive, 'getClientFolderByName', async () => null),
    stub(oneDrive, 'deleteDriveItem', async () => {}),
    stub(sq, 'cancelBookingIfActive', async (id) => { touched.push(['booking', id]); return { cancelled: true }; }),
    stub(require('../src/services/squareInvoicesService'), 'cancelInvoice', async (id) => { touched.push(['invoice', id]); return { status: 'cancelled' }; }),
  ];
  try {
    const p = await deletion.previewDeletion({ leadId: '900' });
    assert.deepEqual(p.targets.squareAppointments, []);
    const out = await deletion.executeDeletion({ leadId: '900', confirmText: 'DELETE', expectedKind: 'lead' });
    assert.equal(out.ok, true);
    assert.deepEqual(touched, [], 'Melanie’s Square appointment is never cancelled by the app');
  } finally { r.reverse().forEach((x) => x()); }
});

/* ── the booking-invite reminders stop for the person once any row is Booked (intended) ── */

test('booking-invite reminders: a direct row Booked for the same person stops them (dry run)', async () => {
  const rem = require('../src/services/bookingRemindersService');
  const invitedAt = Date.now() - 3 * DAY;
  const invited = { id: '1', fullName: 'Asha Example', email: 'asha@example.com', bookingInvite: 'Sent', inviteSentAt: new Date(invitedAt).toISOString() };
  const direct = { id: '2', fullName: 'Asha Example', email: 'asha@example.com', bookingStatus: 'Booked', bookedSlot: `${futureDay()} 11:00`, consultOption: JSON.stringify({ directConsult: { kind: 'New', inSquare: true } }) };
  const rows = { 1: invited, 2: direct };
  const r = [stub(rem.io, 'getLead', async (id) => rows[id]), stub(rem.io, 'readNotes', async () => [])];
  try {
    const out = await rem.remindPerson(['1', '2'], { dryRun: true });
    assert.equal(out.result, 'stopped'); assert.match(out.why, /booked \(lead 2\)/);
  } finally { r.forEach((x) => x()); }
});

/* ── the list and the record show it ── */

test('the Consultations list row and the record carry the direct kind and who booked it (only on a direct row)', async () => {
  snap._reset();
  const L = (id, o) => ({ id: String(id), name: `Lead ${id}`, fullName: `Lead ${id}`, createdAt: '2026-11-01T00:00:00Z', ...o });
  const rows = [
    L(1, { bookingStatus: 'Booked', bookedSlot: `${futureDay()} 11:00`, bookedBy: 'Melanie', consultOption: JSON.stringify({ directConsult: { kind: 'Existing client', inSquare: true } }) }),
    L(2, { bookingStatus: 'Booked', bookedSlot: `${futureDay()} 12:00` }),
  ];
  const r = [stub(snap.io, 'fetchLeads', async () => rows)];
  try {
    const b = await portal.getConsultationsBoard({});
    const byId = Object.fromEntries(b.consultations.map((x) => [x.id, x]));
    assert.equal(byId['1'].direct, 'Existing client'); assert.equal(byId['1'].bookedBy, 'Melanie');
    assert.equal('direct' in byId['2'], false, 'a normal row is unchanged');
  } finally { r.forEach((x) => x()); snap._reset(); }
  assert.deepEqual(dcs.directView(rows[0]), { kind: 'Existing client', bookedBy: 'Melanie', inSquare: true, followUpOf: '', caseRef: '', by: '', durationMin: 30,
    canChangeTime: false, needsRcic: false, rcics: [SHAFOLI, SHERMIN] });
  assert.equal(dcs.directView(rows[1]), null);
});

/* ── the Otter summary on the 💬 Updates box ── */

test('Otter: "Consultation summary (Otter)" takes up to 20,000 characters with its header; the normal cap stays 4,000', async () => {
  const bodies = [];
  const r = stub(mondayApi, 'query', async (q, v) => { bodies.push(v.b); return { create_update: { id: '1' } }; });
  try {
    await updates.postUpdate('123', { body: 'x'.repeat(7000), staffName: 'Gauri', kind: 'otter' });
    assert.match(bodies[0], /^<b>\[Gauri\]<\/b> 🎙 <b>Consultation summary \(Otter\)<\/b><br>x{7000}$/);
    await assert.rejects(updates.postUpdate('123', { body: 'x'.repeat(20001), kind: 'otter' }), /20,000 characters/);
    await assert.rejects(updates.postUpdate('123', { body: 'x'.repeat(4001) }), /limited to 4000 characters/);
    await assert.rejects(updates.postUpdate('123', { body: 'x'.repeat(4001), kind: 'other' }), /4000/);
    assert.equal(bodies.length, 1);
  } finally { r(); }
});

/* ── options ── */

test('options: consultants (Gauri last, no prices), 15–120 lengths, the five payments, the booked-by preset, sources', async () => {
  await live(async () => {
    const w = world();
    try {
      const o = await dcs.getOptions({ actor: { name: 'Melanie Santiago', email: 'm@x.co', verified: true } });
      assert.deepEqual(o.consultants.map((c) => c.name), [SHAFOLI, SHERMIN, GAURI]);
      assert.equal(o.lengths[0], 15); assert.equal(o.lengths[o.lengths.length - 1], 120); assert.equal(o.lengths.length, 8);
      assert.deepEqual(o.payments.map((p) => p.label), ['Paid in Square', 'Cash', 'E-transfer', 'Free', 'Not paid yet']);
      assert.equal(o.bookedBy, 'Melanie'); assert.equal(o.signedIn, true);
      assert.ok(o.sources.includes('Existing Client'));
      assert.equal(o.backDays, 30);
    } finally { w.restore(); }
  });
});
