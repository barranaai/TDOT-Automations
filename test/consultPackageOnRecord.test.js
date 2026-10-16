'use strict';

// The consultation package after a staff-recorded payment (Gauri 2026-10-08:
// "everyone who pays a consultation fee, cash included, gets the agreement and
// form; waived bookings get a send / don't-send option"). Faran 2026-10-16: the
// record box also asks for the booking (time, consultant, in person / video /
// phone, length); video creates the Teams meeting; waived must choose each time;
// a paid client who already has them can be skipped with a reason. Ships OFF
// (CONSULT_PACKAGE_ON_RECORD), needs CONSULT_PACKAGE_AUTO_SEND on as well.
//
// Every outbound seam is stubbed; the no-network guard (npm test) refuses the rest
// and these tests also assert that no send result carries its refusal.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');

const cp                  = require('../src/services/consultPaymentService');
const consultationService = require('../src/services/consultationService');
const portal              = require('../src/services/consultantPortalService');
const leadService         = require('../src/services/leadService');
const mondayApi           = require('../src/services/mondayApi');
const meetingService      = require('../src/services/meetingService');
const bookingService      = require('../src/services/bookingService');
const blacklistService    = require('../src/services/blacklistService');
const microsoftMail       = require('../src/services/microsoftMailService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function withEnv(vars, fn) {
  return async () => {
    const prev = {};
    for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
    consultationService._resetSentMemory();
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      consultationService._resetSentMemory();
    }
  };
}
const ON  = { CONSULT_PACKAGE_AUTO_SEND: '1', CONSULT_PACKAGE_ON_RECORD: '1' };
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const FUTURE = `${day(3)} 11:00`;
const PAST   = `${day(-2)} 11:00`;
const NOW_WALL = '2026-10-16 10:00';
const TODAY_TO = cp.torontoToday();   // the Toronto day — the record refuses a received date in the future
const rec = (over = {}) => JSON.stringify({ kind: 'cash', amountCents: 20000, hstCents: 2600, on: TODAY_TO, by: 'Melanie', at: new Date().toISOString(), verified: false, package: 'send', ...over });
const baseLead = (over = {}) => ({ id: '901', fullName: 'Test Client', email: 't@c.co', phone: '4165550000', residentialAddress: '1 Main St', bookingStatus: 'Booked', bookedSlot: FUTURE, meetingType: 'In-person', assignedConsultant: 'Shafoli Kapur', consultPayment: rec(), ...over });

/* ── the shape: validateBooking / validateRecord ── */

test('validateBooking: a real future Toronto time, a registry consultant, in person / video / phone, a length that consultant offers', () => {
  const v = (b) => cp.validateBooking(b, { nowWall: NOW_WALL });
  const ok = { date: '2026-10-20', time: '11:00', consultant: 'Shafoli Kapur', meetingType: 'In-person', durationMin: 45 };
  assert.deepEqual(v(ok), { ok: true, booking: { slot: '2026-10-20 11:00', date: '2026-10-20', time: '11:00', consultant: 'Shafoli Kapur', meetingType: 'In-person', durationMin: 45 } });
  assert.equal(v({ ...ok, durationMin: '30' }).ok, true, 'a select value (string digits) is fine');
  assert.match(v({ ...ok, date: '2026-10-16', time: '09:59' }).error, /already passed/);
  assert.match(v({ ...ok, date: '2026-10-16', time: '10:00' }).error, /already passed/, 'now is not the future');
  assert.equal(v({ ...ok, date: '2026-10-16', time: '10:01' }).ok, true);
  assert.match(v({ ...ok, date: '2026-02-30' }).error, /date/);
  assert.match(v({ ...ok, time: '24:00' }).error, /time/);
  assert.match(v({ ...ok, time: '9:00' }).error, /time/);
  assert.match(v({ ...ok, date: '2027-10-20' }).error, /more than a year/);
  assert.match(v({ ...ok, consultant: 'Shafoli' }).error, /consultant/);
  assert.match(v({ ...ok, meetingType: 'Zoom' }).error, /in person, video or phone/);
  assert.match(v({ ...ok, durationMin: 15 }).error, /30 or 45 minutes with Shafoli Kapur/, 'Shafoli offers 30 / 45');
  assert.equal(v({ ...ok, consultant: 'Shermin Teymouri Mofrad', durationMin: 15 }).ok, true, 'Shermin offers 30 / 15');
  for (const bad of [null, 'x', [], { ...ok, durationMin: true }, { ...ok, durationMin: '1e1' }]) assert.equal(v(bad).ok, false, JSON.stringify(bad));
});

test('validateRecord: carries the package choice, its reason and the booking; an unknown choice is refused; a bad booking refuses the whole record', () => {
  const v = (o) => cp.validateRecord(o, { today: '2026-10-16', nowWall: NOW_WALL });
  const r = v({ kind: 'cash', amountCents: 20000, package: 'send', booking: { date: '2026-10-20', time: '11:00', consultant: 'Shafoli Kapur', meetingType: 'Virtual', durationMin: 30 } });
  assert.equal(r.ok, true); assert.equal(r.normalized.package, 'send'); assert.equal(r.normalized.booking.slot, '2026-10-20 11:00');
  assert.deepEqual(v({ kind: 'waived', package: 'skip', packageNote: '  returning   client ' }).normalized, { kind: 'waived', amountCents: 0, on: '2026-10-16', reference: '', note: '', package: 'skip', packageNote: 'returning client', booking: null });
  assert.equal(v({ kind: 'cash', amountCents: 1, package: 'maybe' }).ok, false);
  assert.match(v({ kind: 'cash', amountCents: 1, package: 'send', booking: { date: '2026-10-20' } }).error, /time/);
  // stored, read back
  const p = cp.parseConsultPayment({ consultPayment: rec({ package: 'skip', packageNote: 'given in person' }) });
  assert.deepEqual([p.package, p.packageNote], ['skip', 'given in person']);
  assert.equal(cp.parseConsultPayment({ consultPayment: rec({ package: 'sendx' }) }).package, '', 'an unknown stored value never reads as send');
  assert.equal(cp.parseConsultPayment({ consultPayment: JSON.stringify({ kind: 'cash', amountCents: 1, on: '2026-10-01' }) }).package, '', 'a record made before this asked nothing');
});

/* ── the switch and the pure rules ── */

test('the switch: OFF by default; needs the automatic package on too; "1" = every lead; a list = those leads only', withEnv({ CONSULT_PACKAGE_AUTO_SEND: null, CONSULT_PACKAGE_ON_RECORD: null }, async () => {
  const en = consultationService.packageOnRecordEnabled;
  assert.equal(en('901'), false);
  process.env.CONSULT_PACKAGE_ON_RECORD = '1';
  assert.equal(en('901'), false, 'the automatic package is off');
  process.env.CONSULT_PACKAGE_AUTO_SEND = '1';
  assert.equal(en('901'), true); assert.equal(en('1'), true);
  process.env.CONSULT_PACKAGE_ON_RECORD = ' 901 , 902 ';
  assert.equal(en('901'), true); assert.equal(en(902), true); assert.equal(en('903'), false); assert.equal(en(''), false);
  process.env.CONSULT_PACKAGE_ON_RECORD = 'no';
  assert.equal(en('901'), false);
}));

test('the pure rules: who a recorded payment may email at all, "already sent", "wanted", "booked with a time"', () => {
  const app = consultationService.packageApplicable;
  assert.deepEqual(app(baseLead()), { ok: true });
  assert.equal(app(baseLead({ sourceChannel: 'Direct Retainer' })).why, 'direct');
  assert.equal(app(baseLead({ clientMasterItemId: '5' })).why, 'case');
  assert.equal(app(baseLead({ conversionStatus: 'Retained' })).why, 'case');
  assert.equal(app(baseLead({ retainerSent: '2026-10-01' })).why, 'retainer');
  assert.equal(app(baseLead({ outcome: 'Follow-Up' })).why, 'outcome');
  const sent = consultationService.packageAlreadySent;
  assert.equal(sent(baseLead()), false);
  assert.equal(sent(baseLead({ consultAgreementSent: '2026-10-10' })), true);
  assert.equal(sent(baseLead({ consultCountersign: JSON.stringify({ packageEmailedAt: '2026-10-10T00:00:00Z' }) })), true);
  assert.equal(sent(baseLead({ consultCountersign: JSON.stringify({ clientEnvelopeId: 'env_1' }) })), true, 'a signing request is out');
  const want = consultationService.recordedPackageWanted;
  assert.deepEqual(want(baseLead()), { ok: true });
  assert.equal(want(baseLead({ consultPayment: rec({ package: 'skip' }) })).why, 'not-chosen');
  assert.equal(want(baseLead({ consultPayment: JSON.stringify({ kind: 'cash', amountCents: 1, on: '2026-10-01' }) })).why, 'not-chosen', 'a record that never asked never sends');
  assert.equal(want(baseLead({ consultPayment: '' })).why, 'not-chosen');
  assert.equal(want(baseLead({ squareConsultTxnId: 'SQ1' })).why, 'app-paid');
  const booked = consultationService.hasBookedTime;
  assert.equal(booked(baseLead()), true);
  assert.equal(booked(baseLead({ bookedSlot: day(3) })), false, 'a date alone is not a time');
  assert.equal(booked(baseLead({ bookingStatus: 'Slot Held' })), false);
});

/* ── the automatic path: trigger 'recorded' ── */

function harness(leadObj) {
  const sends = [], notes = [], writes = [];
  let current = { ...leadObj };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); current = { ...current, ...f }; }),
    stub(consultationService, 'sendConsultationPackage', async (id, opts) => { sends.push({ id, opts }); return { ok: true, via: 'documenso' }; }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.body); return { create_update: { id: '1' } }; }),
  ];
  return { sends, notes, writes, lead: () => current, set: (f) => { current = { ...current, ...f }; }, restore: () => restore.reverse().forEach((r) => r()) };
}
const cs = (h) => { try { return JSON.parse(h.lead().consultCountersign || '{}'); } catch (_) { return {}; } };

test('recorded: a record that says "send" on a booked lead with a future time, an address and an email → sent once, with the values just written handed over', withEnv(ON, async () => {
  const h = harness(baseLead());
  try {
    const r = await consultationService.autoSendConsultationPackage('901', { trigger: 'recorded', overrides: { meetingType: 'Phone Call' } });
    assert.equal(r.status, 'sent');
    assert.equal(h.sends.length, 1);
    assert.deepEqual(h.sends[0].opts.overrides, { meetingType: 'Phone Call' });
    assert.equal(h.sends[0].opts.fromAuto, true);
    const again = await consultationService.autoSendConsultationPackage('901', { trigger: 'recorded' });
    assert.equal(again.status, 'already', 'the sent memory stops a second one');
    assert.equal(h.sends.length, 1);
    assert.equal(h.notes.length, 0, 'a clean send posts no extra note (the record\'s own note says it)');
  } finally { h.restore(); }
}));

test('recorded: not wanted / not ready / too late are QUIET — no marker, no note, nothing sent', withEnv(ON, async () => {
  const cases = [
    [{ consultPayment: rec({ package: 'skip' }) }, 'not-wanted', 'not-chosen'],
    [{ consultPayment: JSON.stringify({ kind: 'cash', amountCents: 1, on: '2026-10-01' }) }, 'not-wanted', 'not-chosen'],
    [{ squareConsultTxnId: 'SQ9' }, 'not-wanted', 'app-paid'],
    [{ outcome: 'Retain' }, 'not-wanted', 'outcome'],
    [{ bookingStatus: 'Invite Sent' }, 'not-ready', 'no-booking'],
    [{ bookedSlot: '' }, 'not-ready', 'no-booking'],
    [{ email: '' }, 'not-ready', 'no-email'],
    [{ bookedSlot: PAST }, 'too-late', undefined],
  ];
  for (const [over, status, reason] of cases) {
    const h = harness(baseLead(over));
    try {
      const r = await consultationService.autoSendConsultationPackage('901', { trigger: 'recorded' });
      assert.equal(r.status, status, JSON.stringify(over)); assert.equal(r.reason, reason, JSON.stringify(over));
      assert.equal(h.sends.length, 0); assert.equal(h.writes.length, 0, `no marker for ${JSON.stringify(over)}`); assert.equal(h.notes.length, 0);
    } finally { h.restore(); }
  }
}));

test('recorded: switched on for OTHER leads only → nothing for this one', withEnv({ ...ON, CONSULT_PACKAGE_ON_RECORD: '12345' }, async () => {
  const h = harness(baseLead());
  try {
    const r = await consultationService.autoSendConsultationPackage('901', { trigger: 'recorded' });
    assert.deepEqual([r.status, r.reason], ['not-wanted', 'disabled']);
    assert.equal(h.sends.length, 0); assert.equal(h.writes.length, 0);
  } finally { h.restore(); }
}));

test('recorded: never past a marker it did not place — sent, emailed, pending, stalled, expired, a person hold', withEnv(ON, async () => {
  const cases = [
    [{ consultAgreementSent: '2026-10-10' }, 'already'],
    [{ consultCountersign: JSON.stringify({ packageEmailedAt: '2026-10-10T00:00:00Z' }) }, 'already'],
    [{ consultCountersign: JSON.stringify({ packagePending: new Date().toISOString() }) }, 'already'],
    [{ consultCountersign: JSON.stringify({ packageStalled: '2026-10-10T00:00:00Z' }) }, 'needs-person'],
    [{ consultCountersign: JSON.stringify({ packageExpired: '2026-10-10T00:00:00Z' }) }, 'needs-person'],
    [{ consultCountersign: JSON.stringify({ packageHeld: 'slot-clash', packageHeldAt: '2026-10-10T00:00:00Z' }) }, 'needs-person'],
    [{ consultCountersign: JSON.stringify({ packageHeld: 'blank-address', packageHeldAt: '2026-10-10T00:00:00Z' }) }, 'needs-person'],   // a PAYMENT trigger's hold
  ];
  for (const [over, status] of cases) {
    const h = harness(baseLead(over));
    try {
      const r = await consultationService.autoSendConsultationPackage('901', { trigger: 'recorded' });
      assert.equal(r.status, status, JSON.stringify(over));
      assert.equal(h.sends.length, 0); assert.equal(h.writes.length, 0, JSON.stringify(over));
    } finally { h.restore(); }
  }
}));

test('recorded: a blank address HOLDS (marked as the record\'s); entering the address sends once; a changed or removed record retires the hold instead', withEnv(ON, async () => {
  let h = harness(baseLead({ residentialAddress: '' }));
  try {
    const r = await consultationService.autoSendConsultationPackage('901', { trigger: 'recorded' });
    assert.deepEqual([r.status, r.reason], ['held', 'blank-address']);
    assert.equal(cs(h).packageHeld, 'blank-address'); assert.equal(cs(h).packageHeldBy, 'recorded');
    assert.equal(h.notes.length, 1); assert.match(h.notes[0], /HELD — no residential address/);
    // a second record save while still blank stays quiet
    assert.equal((await consultationService.autoSendConsultationPackage('901', { trigger: 'recorded' })).status, 'held');
    assert.equal(h.notes.length, 1);
    // the address arrives → released, once
    h.set({ residentialAddress: '1 Main St' });
    const rel = await consultationService.autoSendConsultationPackage('901', { trigger: 'address', overrides: { residentialAddress: '1 Main St' } });
    assert.equal(rel.status, 'sent'); assert.equal(h.sends.length, 1);
    assert.equal(cs(h).packageHeldBy, undefined, 'the release dropped every hold key');
  } finally { h.restore(); }

  for (const change of [{ consultPayment: rec({ package: 'skip' }) }, { consultPayment: '' }, { outcome: 'Newsletter' }, { bookingStatus: 'Abandoned' }]) {
    consultationService._resetSentMemory();
    h = harness(baseLead({ residentialAddress: '', consultCountersign: JSON.stringify({ packageHeld: 'blank-address', packageHeldAt: '2026-10-15T00:00:00Z', packageHeldBy: 'recorded', packageAttempts: 1, envKeep: 'x' }) }));
    try {
      h.set({ ...change, residentialAddress: '9 New Rd' });
      const r = await consultationService.autoSendConsultationPackage('901', { trigger: 'address' });
      assert.equal(r.status, 'not-wanted', JSON.stringify(change)); assert.equal(r.retired, true);
      assert.equal(h.sends.length, 0);
      assert.deepEqual(cs(h), { envKeep: 'x' }, 'the hold, its owner and its attempts are gone — nothing else touched');
    } finally { h.restore(); }
  }
  // the record path itself retires it too (Remove record / "No")
  consultationService._resetSentMemory();
  h = harness(baseLead({ residentialAddress: '', consultPayment: rec({ package: 'skip' }), consultCountersign: JSON.stringify({ packageHeld: 'blank-address', packageHeldBy: 'recorded' }) }));
  try {
    const r = await consultationService.autoSendConsultationPackage('901', { trigger: 'recorded' });
    assert.deepEqual([r.status, r.retired], ['not-wanted', true]); assert.deepEqual(cs(h), {});
  } finally { h.restore(); }
}));

test('recorded hold, address released by the sweep: the same re-check (a record changed in Monday is honoured)', withEnv(ON, async () => {
  const h = harness(baseLead({ consultPayment: rec({ package: 'skip' }), consultCountersign: JSON.stringify({ packageHeld: 'blank-address', packageHeldAt: '2026-10-15T00:00:00Z', packageHeldBy: 'recorded' }) }));
  const r2 = stub(leadService, 'findAllByColumnValue', async () => [h.lead()]);
  try {
    const out = await consultationService.sweepConsultPackages();
    assert.equal(out.released, 1);
    assert.equal(h.sends.length, 0, 'the record says No now — nothing sent');
    assert.deepEqual(cs(h), {});
  } finally { r2(); h.restore(); }
}));

test('the gate: a payment arriving while a recorded run holds the gate WAITS and decides for itself — it never adopts the record\'s "not wanted"', withEnv(ON, async () => {
  const h = harness(baseLead({ consultPayment: rec({ package: 'skip' }), bookingStatus: 'Booked' }));
  let release; const gate = new Promise((r) => { release = r; });
  let first = true;
  const r2 = stub(leadService, 'getLead', async () => { if (first) { first = false; await gate; } return { ...h.lead() }; });
  try {
    const recorded = consultationService.autoSendConsultationPackage('901', { trigger: 'recorded' });
    const payment  = consultationService.autoSendConsultationPackage('901', { trigger: 'payment' });
    release();
    const [a, b] = await Promise.all([recorded, payment]);
    assert.equal(a.status, 'not-wanted');
    assert.equal(b.status, 'sent', 'the payment ran its own evaluation');
    assert.equal(h.sends.length, 1);
  } finally { r2(); h.restore(); }
}));

/* ── the record action ── */

function world({ lead, claims = [], claimsFail = false, blacklistHit = false, autoSend = { status: 'sent' }, meeting = null, meetingFail = false } = {}) {
  const writes = [], notes = [], autoCalls = [], meetings = [];
  const state = { lead: { id: '901', fullName: 'Test Client', email: 't@c.co', phone: '4165550000', residentialAddress: '1 Main St', ...lead } };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...state.lead })),
    stub(leadService, 'updateLead', async (id, fields, opts) => { writes.push({ id, fields, opts }); Object.assign(state.lead, fields); }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.b); return {}; }),
    stub(bookingService, 'readSlotClaims', async () => { if (claimsFail) throw new Error('Monday down'); return claims; }),
    stub(blacklistService, 'check', async () => ({ checked: true, hit: blacklistHit, matchedOn: blacklistHit ? 'email' : '', entries: [] })),
    stub(consultationService, 'autoSendConsultationPackage', async (id, opts) => { autoCalls.push({ id, opts }); return typeof autoSend === 'function' ? autoSend(opts) : autoSend; }),
    stub(meetingService, 'createMeeting', async (l, slot, dur) => { meetings.push({ l, slot, dur }); if (meetingFail) throw new Error('Graph 503'); return meeting || { meetingId: 'mtg-1', joinUrl: 'https://teams.example/j/1', provider: 'teams' }; }),
  ];
  return { writes, notes, autoCalls, meetings, state, done: () => restore.reverse().forEach((r) => r()) };
}
const apply = (value, { staffName = 'Melanie' } = {}) => portal.applyAction({ leadId: '901', action: 'recordConsultPayment', value, staffName, actor: { name: staffName, email: '', verified: false } });
const BK = (over = {}) => ({ date: day(3), time: '11:00', consultant: 'Shermin Teymouri Mofrad', meetingType: 'In-person', durationMin: 30, ...over });
const PAID = (over = {}) => ({ kind: 'cash', amountCents: 12000, on: TODAY_TO, package: 'send', booking: BK(), ...over });

test('apply, switch OFF: exactly the old record — no question, no booking, no package, the "record only" note', withEnv({ CONSULT_PACKAGE_AUTO_SEND: '1', CONSULT_PACKAGE_ON_RECORD: null }, async () => {
  const w = world();
  try {
    const r = await apply(PAID());
    assert.equal(r.ok, true);
    assert.equal(w.writes.length, 1); assert.deepEqual(Object.keys(w.writes[0].fields), ['consultPayment']);
    const stored = JSON.parse(w.writes[0].fields.consultPayment);
    assert.equal(stored.package, undefined, 'no choice stored');
    assert.equal(w.autoCalls.length, 0);
    assert.match(w.notes[0], /A record only — no email or automatic step runs from it/);
  } finally { w.done(); }
}));

test('apply, paid + send: the record first, then the booking on the lead, then ONE package run with everything just written', withEnv(ON, async () => {
  const w = world({ lead: { consultOption: JSON.stringify({ invoiceId: 'inv_1', durationMin: 15 }) } });
  try {
    const r = await apply(PAID());
    assert.equal(r.ok, true, r.message);
    assert.equal(r.package, 'sent');
    assert.match(r.message, /^Recorded — Cash \$120\.00 received/);
    assert.match(r.message, /consultation agreement \(for e-signature\) and the pre-consultation form have been emailed/);
    assert.match(r.message, /cancel it in Square so they are not charged twice/, 'the old booking-page invoice is flagged');
    assert.equal(w.writes.length, 2);
    const stored = JSON.parse(w.writes[0].fields.consultPayment);
    assert.equal(stored.package, 'send'); assert.equal(stored.packageNote, undefined);
    const b = w.writes[1].fields;
    assert.deepEqual({ ...b, consultOption: undefined }, { bookingStatus: 'Booked', bookedSlot: `${day(3)} 11:00`, meetingType: 'In-person', assignedConsultant: 'Shermin Teymouri Mofrad', consultationHeld: day(3), consultOption: undefined, bookedBy: 'Melanie' });
    const opt = JSON.parse(b.consultOption);
    assert.deepEqual(opt, { invoiceId: 'inv_1', durationMin: 30, feeCents: 12000, variationId: 'VPLVMBZPVKUX32MXMWED6S63', consultant: 'Shermin Teymouri Mofrad', bookedByStaff: true }, 'the length + its standard fee; the old invoice id kept');
    assert.equal(w.autoCalls.length, 1);
    assert.equal(w.autoCalls[0].opts.trigger, 'recorded');
    const ov = w.autoCalls[0].opts.overrides;
    assert.equal(JSON.parse(ov.consultPayment).package, 'send');
    assert.equal(ov.bookedSlot, `${day(3)} 11:00`); assert.equal(ov.bookingStatus, 'Booked'); assert.equal(ov.assignedConsultant, 'Shermin Teymouri Mofrad');
    assert.equal(w.meetings.length, 0, 'in person: no meeting');
    assert.equal(w.notes.length, 1);
    assert.ok(!/A record only/.test(w.notes[0]));
    assert.match(w.notes[0], /emailed to the client/);
  } finally { w.done(); }
}));

test('apply: the choice is required when it is asked; a paid "No" needs a reason; "send" needs the booking and an email — and NOTHING is written when refused', withEnv(ON, async () => {
  const refusals = [
    [{ ...PAID(), package: '' }, /Choose whether to email/],
    [{ ...PAID(), package: 'skip', booking: null }, /Say why/],
    [{ ...PAID(), booking: null }, /Enter the consultation date and time/],
  ];
  for (const [value, re] of refusals) {
    const w = world();
    try {
      await assert.rejects(apply(value), (e) => e.badRequest && re.test(e.message));
      assert.equal(w.writes.length, 0); assert.equal(w.autoCalls.length, 0); assert.equal(w.notes.length, 0);
    } finally { w.done(); }
  }
  const w = world({ lead: { email: '' } });
  try {
    await assert.rejects(apply(PAID()), (e) => e.badRequest && /no email for this client/.test(e.message));
    assert.equal(w.writes.length, 0);
  } finally { w.done(); }
}));

test('apply: a paid "No — they already have them" (reason) and a waived "No" record, keep any booking given, and send nothing', withEnv(ON, async () => {
  let w = world();
  try {
    const r = await apply({ ...PAID(), package: 'skip', packageNote: 'given in person' });
    assert.equal(w.autoCalls.length, 0);
    assert.equal(JSON.parse(w.writes[0].fields.consultPayment).packageNote, 'given in person');
    assert.equal(w.writes[1].fields.bookingStatus, 'Booked', 'the booking is still saved — the client is on the Consultations list');
    assert.match(r.message, /were NOT emailed — the client already has them \(given in person\)\. The booking reminders still go out\./);
  } finally { w.done(); }
  w = world();
  try {
    const r = await apply({ kind: 'waived', on: TODAY_TO, package: 'skip' });
    assert.equal(w.writes.length, 1, 'no booking given: only the record');
    assert.equal(w.autoCalls.length, 0);
    assert.match(r.message, /you chose not to send them/);
    assert.ok(!/reminders/.test(r.message), 'no time on the lead — no reminder promise');
  } finally { w.done(); }
}));

test('apply: a waived "Yes" sends like a paid one', withEnv(ON, async () => {
  const w = world();
  try {
    const r = await apply({ kind: 'waived', on: TODAY_TO, package: 'send', booking: BK() });
    assert.equal(r.package, 'sent'); assert.equal(w.autoCalls.length, 1);
  } finally { w.done(); }
}));

test('apply: another client already has that consultant at that time, or the check cannot be made, or the client is paying online right now → refused, NOTHING written', withEnv(ON, async () => {
  let w = world({ claims: [{ leadId: '777', slot: `${day(3)} 11:00`, consultant: 'Shermin Teymouri Mofrad', status: 'Booked' }] });
  try {
    await assert.rejects(apply(PAID()), (e) => e.badRequest && /already has a consultation at/.test(e.message));
    assert.equal(w.writes.length, 0);
  } finally { w.done(); }
  w = world({ claims: [{ leadId: '777', slot: `${day(3)} 11:00`, consultant: 'Shafoli Kapur', status: 'Booked' }, { leadId: '901', slot: `${day(3)} 11:00`, consultant: 'Shermin Teymouri Mofrad', status: 'Booked' }] });
  try { assert.equal((await apply(PAID())).ok, true, 'another consultant, or this lead itself, is no clash'); } finally { w.done(); }
  w = world({ claimsFail: true });
  try {
    await assert.rejects(apply(PAID()), (e) => e.badRequest && /Could not check/.test(e.message));
    assert.equal(w.writes.length, 0);
  } finally { w.done(); }
  w = world({ lead: { bookingStatus: 'Slot Held', bookedSlot: `${day(2)} 10:00`, slotHeldUntil: new Date(Date.now() + 3600e3).toISOString() } });
  try {
    await assert.rejects(apply(PAID()), (e) => e.badRequest && /booking online right now/.test(e.message));
    assert.equal(w.writes.length, 0);
  } finally { w.done(); }
  w = world({ lead: { bookingStatus: 'Slot Held', bookedSlot: `${day(2)} 10:00`, slotHeldUntil: new Date(Date.now() - 3600e3).toISOString() } });
  try { assert.equal((await apply(PAID())).ok, true, 'an expired hold is no obstacle'); } finally { w.done(); }
}));

test('apply, video: the Teams meeting is created for the consultant chosen and handed to the package; a re-save of the same booking reuses it; a failure sends nothing', withEnv(ON, async () => {
  let w = world();
  try {
    const r = await apply(PAID({ booking: BK({ meetingType: 'Virtual' }) }));
    assert.equal(w.meetings.length, 1);
    assert.equal(w.meetings[0].l.assignedConsultant, 'Shermin Teymouri Mofrad', 'the invite goes to the consultant just chosen');
    assert.deepEqual([w.meetings[0].slot, w.meetings[0].dur], [`${day(3)} 11:00`, 30]);
    assert.deepEqual(w.writes[2].fields, { zoomMeetingId: 'mtg-1', meetingLink: { url: 'https://teams.example/j/1', text: 'Join (Microsoft Teams)' } });
    assert.equal(w.autoCalls[0].opts.overrides.meetingLink, 'https://teams.example/j/1');
    assert.match(r.message, /Teams meeting was created — the client and Shermin Teymouri Mofrad get its invite/);
  } finally { w.done(); }
  w = world({ lead: { zoomMeetingId: 'mtg-1', meetingLink: 'https://teams.example/j/1', bookedSlot: `${day(3)} 11:00`, assignedConsultant: 'Shermin Teymouri Mofrad', bookingStatus: 'Booked' } });
  try {
    await apply(PAID({ booking: BK({ meetingType: 'Virtual' }) }));
    assert.equal(w.meetings.length, 0, 'same time, same consultant: reused');
    assert.equal(w.autoCalls[0].opts.overrides.meetingLink, 'https://teams.example/j/1');
  } finally { w.done(); }
  w = world({ lead: { zoomMeetingId: 'mtg-0', meetingLink: 'https://teams.example/j/0', bookedSlot: `${day(2)} 09:00`, meetingType: 'Virtual' } });
  try {
    const r = await apply(PAID({ booking: BK({ meetingType: 'Virtual' }) }));
    assert.equal(w.meetings.length, 1, 'a new time: a new meeting');
    assert.match(r.message, /earlier video meeting \(for .* 09:00\) still exists/);
  } finally { w.done(); }
  w = world({ meetingFail: true });
  try {
    const r = await apply(PAID({ booking: BK({ meetingType: 'Virtual' }) }));
    assert.equal(r.ok, true, 'the record stays');
    assert.equal(w.autoCalls.length, 0, 'no package without the link');
    assert.match(r.message, /video meeting could not be created \(Graph 503\) — the package was NOT emailed/);
  } finally { w.done(); }
}));

test('apply: already sent, or the consultation has happened, or a retainer client → no question, no booking written, no package; the reply says why', withEnv(ON, async () => {
  const cases = [
    [{ consultAgreementSent: '2026-10-10' }, /already went out to the client/],
    [{ outcome: 'Follow-Up' }, /an outcome is already set/],
    [{ sourceChannel: 'Direct Retainer' }, /direct retainer client has no consultation/],
    [{ retainerSent: '2026-10-01' }, /retainer is already under way/],
  ];
  for (const [over, re] of cases) {
    const w = world({ lead: over });
    try {
      const r = await apply({ kind: 'cash', amountCents: 12000, on: TODAY_TO, booking: BK() });   // a stale page may still post a booking
      assert.equal(r.ok, true);
      assert.equal(w.writes.length, 1, `only the record for ${JSON.stringify(over)}`);
      assert.equal(w.autoCalls.length, 0);
      assert.match(r.message, re);
    } finally { w.done(); }
  }
}));

test('apply: a Not Wanted person is never emailed automatically — the record and the booking stay', withEnv(ON, async () => {
  const w = world({ blacklistHit: true });
  try {
    const r = await apply(PAID());
    assert.equal(w.autoCalls.length, 0);
    assert.equal(w.writes.length, 2);
    assert.match(r.message, /on the Not Wanted list/);
  } finally { w.done(); }
}));

test('apply: removing a record, or changing "send" to "No", lets the gate retire a package that was waiting; a record that never asked is left alone', withEnv(ON, async () => {
  let w = world({ lead: { consultPayment: rec({ package: 'send' }) }, autoSend: { status: 'not-wanted', retired: true } });
  try {
    const r = await apply({ kind: 'clear' });
    assert.equal(w.autoCalls.length, 1); assert.equal(w.autoCalls[0].opts.trigger, 'recorded'); assert.equal(w.autoCalls[0].opts.overrides.consultPayment, '');
    assert.match(r.message, /package that was waiting will not be sent/);
  } finally { w.done(); }
  w = world({ lead: { consultPayment: rec({ package: 'send' }) }, autoSend: { status: 'not-wanted', retired: true } });
  try {
    const r = await apply({ kind: 'cash', amountCents: 12000, on: TODAY_TO, package: 'skip', packageNote: 'handed over' });
    assert.equal(w.autoCalls.length, 1, 'the gate decides, from a fresh read');
    assert.equal(JSON.parse(w.autoCalls[0].opts.overrides.consultPayment).package, 'skip');
    assert.match(r.message, /The package that was waiting will not be sent/);
  } finally { w.done(); }
  w = world({ lead: { consultPayment: JSON.stringify({ kind: 'cash', amountCents: 1, on: '2026-10-01' }) } });
  try {
    await apply({ kind: 'clear' });
    assert.equal(w.autoCalls.length, 0);
  } finally { w.done(); }
}));

test('apply: what the reply says for each package result', withEnv(ON, async () => {
  const cases = [
    [{ status: 'held', reason: 'blank-address' }, /waiting for the client's residential address/],
    [{ status: 'too-late' }, /time has passed/],
    [{ status: 'needs-person', reason: 'stalled' }, /needs a person first \(stalled\)/],
    [{ status: 'failed', reason: 'Documenso 500' }, /could not be emailed \(Documenso 500\)/],
    [{ status: 'already' }, /already went out/],
  ];
  for (const [res, re] of cases) {
    const w = world({ autoSend: res });
    try { assert.match((await apply(PAID())).message, re); } finally { w.done(); }
  }
}));

/* ── Review & send: a stale page never emails twice ── */

test('"Review & send" refuses a second package unless the page said AGAIN (the server decides, not the page)', async () => {
  const sends = [];
  const restore = [
    stub(leadService, 'getLead', async () => ({ id: '901', fullName: 'T', email: 't@c.co', consultAgreementSent: '2026-10-10' })),
    stub(consultationService, 'sendConsultationPackage', async () => { sends.push(1); return { ok: true, via: 'documenso', reused: true }; }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await assert.rejects(portal.applyAction({ leadId: '901', action: 'sendConsultationPackage', value: null, staffName: 'M' }), (e) => e.badRequest && /already received the consultation package on 2026-10-10\. Reload the page/.test(e.message));
    await assert.rejects(portal.applyAction({ leadId: '901', action: 'sendConsultationPackage', value: JSON.stringify({ again: 'yes' }), staffName: 'M' }), (e) => e.badRequest);
    assert.equal(sends.length, 0);
    const r = await portal.applyAction({ leadId: '901', action: 'sendConsultationPackage', value: JSON.stringify({ again: true }), staffName: 'M' });
    assert.equal(r.ok, true); assert.equal(sends.length, 1);
  } finally { restore.reverse().forEach((x) => x()); }
  const r2 = [stub(leadService, 'getLead', async () => ({ id: '901', fullName: 'T', email: 't@c.co' })), stub(consultationService, 'sendConsultationPackage', async () => ({ ok: true, via: 'documenso' })), stub(mondayApi, 'query', async () => ({}))];
  try { assert.equal((await portal.applyAction({ leadId: '901', action: 'sendConsultationPackage', value: null, staffName: 'M' })).ok, true, 'a first send needs no AGAIN'); }
  finally { r2.reverse().forEach((x) => x()); }
});

/* ── the form reminder honours "No" ── */

test('the pre-consultation form chase skips a client staff chose not to send the package to', async () => {
  const C = require('../src/data/newLeadsBoard.json').columns;
  const soon = new Date(Date.now() + 5 * 3600e3);
  const p = {}; for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(soon)) p[x.type] = x.value;
  const slot = `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  const item = (id, payment) => ({ id, name: `L${id}`, updates: [], column_values: [{ id: C.bookedSlot, text: slot }, { id: C.preConsultSubmitted, text: '' }, { id: C.consultPayment, text: payment }] });
  const mails = [], queries = [];
  const restore = [
    stub(mondayApi, 'query', async (q) => { queries.push(q); if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: [item('1', rec({ package: 'skip' })), item('2', rec({ package: 'send' })), item('3', '')] } }; return {}; }),
    stub(leadService, 'getLead', async (id) => ({ id, name: `L${id}`, email: `l${id}@x.co`, leadToken: 't' })),
    stub(microsoftMail, 'sendEmail', async (m) => { mails.push(m.to); }),
  ];
  try {
    await consultationService.sendPreConsultReminders();
    assert.deepEqual(mails.sort(), ['l2@x.co', 'l3@x.co']);
    assert.ok(queries[0].includes(`"${C.consultPayment}"`), 'the reminder read carries the record');
  } finally { restore.reverse().forEach((x) => x()); }
});

/* ── the page ── */

test('page: the record box asks for the booking and the choice; Review & send tells the server AGAIN; every script parses', () => {
  const html = require('../src/routes/adminConsultation').buildDetailHTML('901');
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
  for (const s of ['function cpPackageSection(orc, asks)', 'function cpPackageBind(box, orc, cur, kindEl, amtEl, onSend)', 'id="cp-bk-date"', 'id="cp-bk-time"', 'id="cp-bk-cons"', 'id="cp-bk-len"', 'id="cp-bk-type"',
    'name="cp-pkg" value="send"', 'name="cp-pkg" value="skip"', "'Record & email'", 'A Teams meeting is created — the client and the consultant get its invite.',
    "doAction('sendConsultationPackage', JSON.stringify({again:!!sentOn})", 'The agreement will say the client has paid ',
    "if(!touched && !cur){ var w=waived(); if(sendEl) sendEl.checked=!w&&!!orc.hasEmail;"]) assert.ok(html.includes(s), s);
  // the "looks like it includes HST" check
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi).map((x) => x).join('\n');
  const a = js.indexOf('function cpLooksTaxed('), b = js.indexOf('function cpPackageSection(');
  const taxed = new Function(`${js.slice(a, b)}; return cpLooksTaxed;`)();
  const orc = { hstPct: 13, consultants: [{ name: 'S', options: [{ durationMin: 30, feeCents: 20000 }, { durationMin: 45, feeCents: 30000 }] }] };
  assert.equal(taxed(22600, orc), true); assert.equal(taxed(33900, orc), true); assert.equal(taxed(20000, orc), false);
  assert.equal(taxed(22600, { ...orc, hstPct: 0 }), false, 'no HST for this client: nothing to warn about');
});

test('detail payload: the dialog gets the switch state, what to pre-fill (only a BOOKED time), the consultants and their lengths, the HST', withEnv(ON, async () => {
  const restore = [stub(leadService, 'getLead', async () => baseLead({ bookedSlot: `${day(3)} 11:00`, meetingType: 'Virtual', assignedConsultant: 'Shermin Teymouri Mofrad', consultOption: JSON.stringify({ durationMin: 15 }), consultPayment: '' }))];
  try {
    const lead = await leadService.getLead('901');
    const o = portal._recordPackageView(lead, cp.paidState(lead));
    assert.equal(o.enabled, true); assert.equal(o.applicable, true); assert.equal(o.alreadySent, false);
    assert.deepEqual(o.prefill, { date: day(3), time: '11:00', consultant: 'Shermin Teymouri Mofrad', meetingType: 'Virtual', durationMin: 15 });
    assert.equal(o.hstPct, 13); assert.equal(o.hasEmail, true); assert.equal(o.hasAddress, true);
    assert.deepEqual(o.consultants.map((c) => [c.name, c.options.map((x) => x.durationMin)]), [['Shafoli Kapur', [30, 45]], ['Shermin Teymouri Mofrad', [30, 15]]]);
    const held = portal._recordPackageView({ ...lead, bookingStatus: 'Abandoned' }, cp.paidState(lead));
    assert.deepEqual([held.prefill.date, held.prefill.time], ['', ''], 'a time left from an unpaid online hold is never offered as the booking');
  } finally { restore.forEach((r) => r()); }
}));
