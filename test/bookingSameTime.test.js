'use strict';

// Booking safety before the consultation package is switched on (2026-10-14 re-check;
// Faran: "fix items 1 to 5 carefully"). The live trigger: two clients held Fri 16 Oct
// 15:00 with Shermin — the first hold sat beyond the first 200 Lead Board rows the old
// check read.
//   1. Taken times are read from the WHOLE board, per consultant; the hold step
//      re-checks strictly and refuses rather than guesses.
//   2. A payment on a booking set to "Booked" by hand is recorded and staff are told.
//   3. The package never goes out once the consultation time has begun; a client who
//      paid after the hold expired is held for a person.
//   4. One confirmation per lead at a time; a pending send elsewhere is "already".
//   5. Toronto dates on the agreement; the paid option is handed over; the labels.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const bookingService      = require('../src/services/bookingService');
const consultationService = require('../src/services/consultationService');
const consultAgreementSvc = require('../src/services/consultAgreementService');
const leadService         = require('../src/services/leadService');
const mondayApi           = require('../src/services/mondayApi');
const meetingService      = require('../src/services/meetingService');
const squareBookings      = require('../src/services/squareBookingsService');
const C = require('../src/data/newLeadsBoard.json').columns;

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function withFlag(v, fn) {
  return async () => {
    const prev = process.env.CONSULT_PACKAGE_AUTO_SEND;
    if (v == null) delete process.env.CONSULT_PACKAGE_AUTO_SEND; else process.env.CONSULT_PACKAGE_AUTO_SEND = v;
    try { await fn(); } finally { if (prev === undefined) delete process.env.CONSULT_PACKAGE_AUTO_SEND; else process.env.CONSULT_PACKAGE_AUTO_SEND = prev; }
  };
}
const SHERMIN = 'Shermin Teymouri Mofrad', SHAFOLI = 'Shafoli Kapur';
const FUTURE = new Date(Date.now() + 3 * 24 * 3600e3).toISOString();
const PAST = new Date(Date.now() - 3600e3).toISOString();
/** A Lead Board row as the claims read returns it. */
const row = (id, { status = 'Booked', slot = '2026-10-16 15:00', held = '', consultant = SHERMIN, name = `Client ${id}` } = {}) => ({
  id, name, column_values: [
    { id: C.bookingStatus, text: status }, { id: C.bookedSlot, text: slot }, { id: C.slotHeldUntil, text: held }, { id: C.assignedConsultant, text: consultant },
  ],
});
/** mondayApi.query fake: the board in pages (cursor), notes recorded. */
function board(pages, { notes = [], fail = false } = {}) {
  let reads = 0;
  return {
    notes, get reads() { return reads; },
    query: async (q, v) => {
      if (/create_update/.test(q)) { notes.push({ item: String(v.i || v.id || v.itemId), body: v.b || v.body }); return { create_update: { id: '1' } }; }
      if (/items_page\(limit: 500/.test(q)) {
        reads++;
        if (fail) throw new Error('Monday 503');
        const i = v.cursor ? Number(v.cursor) : 0;
        return { boards: [{ items_page: { cursor: i + 1 < pages.length ? String(i + 1) : null, items: pages[i] } }] };
      }
      return {};
    },
  };
}

/* ── item 1: the whole board, per consultant, strict at the hold ── */

test('1. the taken-times read pages through the WHOLE board (the old read stopped at row 200) and keeps only live claims, with their consultant', async () => {
  const pages = [
    Array.from({ length: 500 }, (_, i) => row(String(1000 + i), { status: '', slot: '' })),             // 500 rows with nothing booked
    [row('13279937278', { status: 'Booked' }), row('13278682219', { status: 'Slot Held', held: FUTURE }),
     row('13189382714', { status: 'Slot Held', held: PAST }), row('9', { status: 'Abandoned' }), row('8', { status: 'Booked', slot: '' })],
  ];
  const b = board(pages);
  const r = stub(mondayApi, 'query', b.query);
  try {
    const claims = await bookingService.readSlotClaims({ strict: true });
    assert.equal(b.reads, 2, 'both pages read');
    assert.deepEqual(claims.map((c) => [c.leadId, c.status, c.consultant]), [['13279937278', 'Booked', SHERMIN], ['13278682219', 'Slot Held', SHERMIN]],
      'an expired hold, an Abandoned row and a booking with no time are not claims');
  } finally { r(); }
});

test('1. a failed read: strict THROWS (the hold step never guesses); the page view logs and carries on', async () => {
  const b = board([], { fail: true });
  const r = stub(mondayApi, 'query', b.query);
  try {
    await assert.rejects(bookingService.readSlotClaims({ strict: true }), /Monday 503/);
    assert.deepEqual(await bookingService.readSlotClaims(), []);
  } finally { r(); }
});

test('1. per consultant: another consultant\'s claim at the same minute does not take this one\'s time; a claim with no consultant blocks everyone; the client\'s own hold stays theirs', () => {
  const claims = [
    { leadId: 'a', slot: '2026-10-16 15:00', consultant: SHERMIN, status: 'Booked' },
    { leadId: 'b', slot: '2026-10-20 11:00', consultant: '', status: 'Booked' },
    { leadId: 'me', slot: '2026-10-22 16:00', consultant: SHAFOLI, status: 'Slot Held' },
  ];
  assert.deepEqual(bookingService.claimsOnSlot(claims, '2026-10-16 15:00', { consultant: SHERMIN }).map((c) => c.leadId), ['a']);
  assert.deepEqual(bookingService.claimsOnSlot(claims, '2026-10-16 15:00', { consultant: SHAFOLI }), []);
  assert.deepEqual(bookingService.claimsOnSlot(claims, '2026-10-20 11:00', { consultant: SHAFOLI }).map((c) => c.leadId), ['b']);
  assert.deepEqual(bookingService.claimsOnSlot(claims, '2026-10-22 16:00', { consultant: SHAFOLI, excludeLeadId: 'me' }), []);
  assert.deepEqual([...bookingService.takenSlotKeys(claims, { consultant: SHAFOLI, excludeLeadId: 'me' })], ['2026-10-20 11:00']);
  assert.deepEqual([...bookingService.takenSlotKeys(claims)].sort(), ['2026-10-16 15:00', '2026-10-20 11:00', '2026-10-22 16:00'], 'the one-template fallback: any claim blocks');
});

test('1. the booking page hides a time another client of the SAME consultant holds — also when that hold sits beyond row 200 — and shows the other consultant\'s', async () => {
  const shermin = require('../config/consultantRouting').CONSULTANTS.shermin.teamMemberId;
  const shafoli = require('../config/consultantRouting').CONSULTANTS.shafoli.teamMemberId;
  const pages = [Array.from({ length: 500 }, (_, i) => row(String(2000 + i), { status: '', slot: '' })), [row('13279937278', { status: 'Slot Held', held: FUTURE })]];
  const b = board(pages);
  const offer = (team) => [{ date: '2026-10-16', time: '15:00', startAt: '2026-10-16T19:00:00Z', teamMemberId: team, durationMinutes: 30 }, { date: '2026-10-16', time: '15:30', startAt: '2026-10-16T19:30:00Z', teamMemberId: team, durationMinutes: 30 }];
  let team = shermin;
  const restore = [stub(mondayApi, 'query', b.query), stub(squareBookings, 'searchAvailability', async () => offer(team)), stub(squareBookings, 'listBookings', async () => []),
    stub(Date, 'now', () => Date.parse('2026-10-13T20:00:00Z'))];
  try {
    const out = await bookingService.getSquareAvailableSlots(1, shermin, 'VAR');
    assert.deepEqual(out.map((s) => `${s.date} ${s.time}`), ['2026-10-16 15:30'], 'the held 15:00 is hidden from another Shermin client');
    team = shafoli;
    const out2 = await bookingService.getSquareAvailableSlots(1, shafoli, 'VAR2');
    assert.deepEqual(out2.map((s) => `${s.date} ${s.time}`), ['2026-10-16 15:00', '2026-10-16 15:30'], 'Shafoli\'s 15:00 is a different time');
    team = shermin;
    const own = await bookingService.getSquareAvailableSlots(1, shermin, 'VAR3', { excludeLeadId: '13279937278' });
    assert.equal(own.length, 2, 'the client who holds it still sees it');
  } finally { restore.forEach((x) => x()); }
});

test('1. the hold step: refuses a taken time (no write), refuses when the board cannot be read (no write), holds a free time; two clicks on one time together → exactly one hold', async () => {
  const writes = [];
  let claims = [[row('13279937278', { status: 'Booked' })]];
  let fail = false;
  const restore = [
    stub(mondayApi, 'query', async (q, v) => board(claims, { fail }).query(q, v)),
    stub(leadService, 'updateLead', async (id, f) => { writes.push({ id, f }); await new Promise((r) => setTimeout(r, 5)); }),
  ];
  try {
    const taken = await bookingService.holdSlotIfFree('13278682219', '2026-10-16', '15:00', SHERMIN);
    assert.deepEqual([taken.ok, taken.reason, taken.claim.leadId], [false, 'taken', '13279937278']);
    fail = true;
    assert.deepEqual(await bookingService.holdSlotIfFree('13278682219', '2026-10-16', '16:00', SHERMIN), { ok: false, reason: 'unverified' });
    assert.equal(writes.length, 0, 'nothing written for a refused hold');
    fail = false;
    assert.deepEqual(await bookingService.holdSlotIfFree('13278682219', '2026-10-16', '15:00', SHAFOLI), { ok: true }, 'Shafoli\'s 15:00 is free');
    assert.equal(writes[0].f.bookingStatus, 'Slot Held');
    // two clients, the same Shermin time, at the same moment; the board read still shows neither (Monday lag)
    claims = [[]];
    const [x, y] = await Promise.all([
      bookingService.holdSlotIfFree('111', '2026-10-23', '15:00', SHERMIN),
      bookingService.holdSlotIfFree('222', '2026-10-23', '15:00', SHERMIN),
    ]);
    assert.deepEqual([x.ok, y.ok].sort(), [false, true], 'exactly one of them holds it');
    assert.equal((x.ok ? y : x).reason, 'taken');
    // the client who holds it can pick it again
    assert.equal((await bookingService.holdSlotIfFree(x.ok ? '111' : '222', '2026-10-23', '15:00', SHERMIN)).ok, true);
  } finally { restore.forEach((r) => r()); }
});

test('1. the booking page holds through the strict check, before any payment link; a refused time gets a "pick another time" page, never a charge', () => {
  const route = fs.readFileSync(require.resolve('../src/routes/phase2'), 'utf8');
  const post = route.slice(route.indexOf("router.post('/book/:leadId'"));
  const hold = post.indexOf('bookingService.holdSlotIfFree(leadId, slotDate, slotTime, consultant && consultant.name)');
  assert.ok(hold > 0 && hold < post.indexOf('createCheckout') && hold < post.indexOf('createConsultInvoiceCheckout'), 'checked and held before any payment artifact');
  assert.ok(!/bookingService\.holdSlot\(leadId/.test(post), 'no unchecked hold left');
  assert.match(post, /status\(held\.reason === 'taken' \? 409 : 503\)/);
  assert.match(route, /another client has just chosen that time/);
  assert.match(route, /Nothing has been charged\./);
});

/* ── items 1–4 in confirmSlot ── */

function confirmWorld({ lead, boardRows = [], lag = false } = {}) {
  let current = { ...lead };
  const writes = [], slotCalls = [];
  const b = board([boardRows]);
  const restore = [
    stub(leadService, 'getLead', async () => (lag ? { ...lead } : { ...current })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push({ id, f }); current = { ...current, ...f }; await new Promise((r) => setTimeout(r, 5)); }),
    stub(mondayApi, 'query', b.query),
    stub(consultationService, 'onSlotConfirmed', async (id, mt, extra) => { slotCalls.push({ id, mt, extra }); }),
  ];
  return { writes, slotCalls, notes: b.notes, current: () => current, restore: () => restore.forEach((r) => r()) };
}
const LEAD = (over = {}) => ({ id: '13278682219', fullName: 'Shoaib Test', bookingStatus: 'Slot Held', bookedSlot: '2026-10-16 15:00', assignedConsultant: SHERMIN, squareConsultTxnId: '', consultOption: '', ...over });

test('2. a payment on a booking set to "Booked" BY HAND is recorded and staff are told; the automatic steps do not run; a replay stays quiet', async () => {
  const w = confirmWorld({ lead: LEAD({ id: '13279937278', fullName: 'Mitesh Test', bookingStatus: 'Booked' }) });
  try {
    await bookingService.confirmSlot('13279937278', 'SQ-PAY-1', undefined, 12000);
    assert.deepEqual(w.writes.map((x) => x.f).filter((f) => 'squareConsultTxnId' in f), [{ squareConsultTxnId: 'SQ-PAY-1' }]);
    assert.equal(w.slotCalls.length, 0, 'no meeting / Square appointment / package for a hand booking');
    assert.equal(w.notes.length, 1);
    assert.match(w.notes[0].body, /^💳 <b>Consultation payment received on a booking set to "Booked" by hand<\/b> for \$120\.00 — Square payment <code>SQ-PAY-1<\/code>\./);
    assert.match(w.notes[0].body, /no meeting link, no Square appointment and no consultation package were created/);
    assert.match(w.notes[0].body, /\(2026-10-16 15:00\)/);
    await bookingService.confirmSlot('13279937278', 'SQ-PAY-1', undefined, 12000);
    assert.equal(w.notes.length, 1, 'the same payment again: nothing new');
    await bookingService.confirmSlot('13279937278', 'SQ-PAY-2', undefined, 12000);
    assert.match(w.notes[1].body, /Possible DOUBLE PAYMENT/, 'a second, different payment is still loud');
  } finally { w.restore(); }
});

test('1. a paid booking that lands on a time another client is already booked for: a note on BOTH leads, and the package is held for a person', async () => {
  const w = confirmWorld({ lead: LEAD(), boardRows: [row('13279937278', { status: 'Booked', name: 'Mitesh Test' }), row('55', { status: 'Booked', consultant: SHAFOLI })] });
  try {
    await bookingService.confirmSlot('13278682219', 'SQ-9', undefined, 12000);
    assert.equal(w.current().bookingStatus, 'Booked', 'the payment is still recorded');
    const clash = w.notes.filter((n) => /Two clients are booked for the same time/.test(n.body));
    assert.deepEqual(clash.map((n) => n.item).sort(), ['13278682219', '13279937278'], 'both clients\' leads, not Shafoli\'s client');
    assert.match(clash.find((n) => n.item === '13278682219').body, /2026-10-16 15:00 with Shermin Teymouri Mofrad: this client has just paid, and Mitesh Test \(lead 13279937278\) is already booked/);
    assert.deepEqual(w.slotCalls[0].extra.slotClash, ['13279937278']);
  } finally { w.restore(); }
});

test('3. a client who paid AFTER the hold expired: a note to confirm the time; the package is held for a person', async () => {
  // (each confirm test uses its own lead: a lead confirmed minutes ago is remembered in-process)
  const w = confirmWorld({ lead: LEAD({ id: '401', bookingStatus: 'Abandoned' }) });
  try {
    await bookingService.confirmSlot('401', 'SQ-10', undefined, 12000);
    assert.ok(w.notes.some((n) => /^💳 <b>Paid after the slot hold had expired<\/b> — the time \(2026-10-16 15:00\) was released/.test(n.body)));
    assert.equal(w.slotCalls[0].extra.wasAbandoned, true);
  } finally { w.restore(); }
});

test('4. two deliveries of one payment at the same moment, with Monday still showing "Slot Held": ONE booking, one meeting; the paid option is handed over', async () => {
  const opt = JSON.stringify({ durationMin: 45, feeCents: 30000, variationId: 'V45', consultant: SHAFOLI });
  const w = confirmWorld({ lead: LEAD({ id: '402', assignedConsultant: SHAFOLI, consultOption: opt }), lag: true });
  try {
    await Promise.all([
      bookingService.confirmSlot('402', 'SQ-11', undefined, 33900),
      bookingService.confirmSlot('402', 'SQ-11', undefined, 33900),
    ]);
    assert.equal(w.slotCalls.length, 1, 'the second delivery waited and saw the first');
    assert.equal(w.writes.filter((x) => x.f.bookingStatus === 'Booked').length, 1);
    assert.equal(JSON.parse(w.slotCalls[0].extra.consultOption).paidCents, 33900, 'the reconciled option travels with the call');
    // a reconciler run 2 minutes later with Monday still lagging: a replay, not a booking
    await bookingService.confirmSlot('402', 'SQ-11', undefined, 33900);
    assert.equal(w.slotCalls.length, 1);
    // …and a DIFFERENT payment for it in that window is the double-payment note, not a second booking
    await bookingService.confirmSlot('402', 'SQ-12', undefined, 33900);
    assert.equal(w.slotCalls.length, 1);
    assert.ok(w.notes.some((n) => /Possible DOUBLE PAYMENT/.test(n.body) && /SQ-12/.test(n.body)));
  } finally { w.restore(); }
});

/* ── items 3–5 in the package ── */

const TOMORROW = `${new Date(Date.now() + 24 * 3600e3).toISOString().slice(0, 10)} 14:30`;
const pkgLead = (extra = {}) => ({ id: '77', fullName: 'Walk In', email: 'w@i.co', residentialAddress: '1 Main St', bookingStatus: 'Booked', bookedSlot: TOMORROW, meetingType: 'In-person', squareBookingId: 'test-never-square', ...extra });
function pkg(leadObj) {
  const sends = [], notes = [], writes = [];
  let current = { ...leadObj };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); current = { ...current, ...f }; }),
    stub(consultationService, 'sendConsultationPackage', async (id, opts) => { sends.push({ id, opts }); return { ok: true }; }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.body); return { create_update: { id: '1' } }; }),
  ];
  return { sends, notes, writes, lead: () => current, restore: () => restore.reverse().forEach((r) => r()) };
}

test('3. the package never goes out once the consultation time has begun (was: up to a day after) — an hour before it still does', withFlag('1', async () => {
  const started = new Date(Date.now() - 60e3);
  const tz = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).replace(',', '');
  let h = pkg(pkgLead({ id: '301', bookedSlot: tz(started) }));
  try {
    assert.deepEqual(await consultationService.autoSendConsultationPackage('301', { trigger: 'payment' }), { status: 'expired' });
    assert.equal(h.sends.length, 0);
    assert.match(h.notes[0], /the booked consultation time has already passed or begun/);
  } finally { h.restore(); }
  h = pkg(pkgLead({ id: '302', bookedSlot: tz(new Date(Date.now() + 3600e3)) }));
  try {
    assert.equal((await consultationService.autoSendConsultationPackage('302', { trigger: 'payment' })).status, 'sent');
  } finally { h.restore(); }
}));

test('3 + 1. held for a person (late payment / same time): no email, one note, and NOTHING releases it but "Review & send" — not an address, not the sweep', withFlag('1', async () => {
  for (const [id, hold, re] of [['303', 'late-payment', /paid after their slot hold had expired/], ['304', 'slot-clash', /another client is booked for the same time/]]) {
    const h = pkg(pkgLead({ id }));
    try {
      assert.deepEqual(await consultationService.autoSendConsultationPackage(id, { trigger: 'payment', hold }), { status: 'held', reason: hold });
      assert.equal(h.sends.length, 0); assert.equal(h.notes.length, 1); assert.match(h.notes[0], re);
      assert.equal(consultAgreementSvc.parseCountersign(h.lead()).packageHeld, hold);
      assert.deepEqual(await consultationService.autoSendConsultationPackage(id, { trigger: 'address', overrides: { residentialAddress: '9 Rd' } }), { status: 'not-held' });
      assert.equal(h.sends.length, 0, 'an address never releases it');
    } finally { h.restore(); }
  }
  // the sweep leaves both alone (the address is present on both)
  const leads = [pkgLead({ id: '305', consultCountersign: JSON.stringify({ packageHeld: 'late-payment' }) }), pkgLead({ id: '306', consultCountersign: JSON.stringify({ packageHeld: 'slot-clash' }) })];
  const calls = [];
  const restore = [stub(leadService, 'findAllByColumnValue', async () => leads), stub(consultationService, 'autoSendConsultationPackage', async (id) => { calls.push(id); return { status: 'sent' }; })];
  try { await consultationService.sweepConsultPackages(); assert.deepEqual(calls, []); } finally { restore.forEach((r) => r()); }
}));

test('4. a pending marker already on the lead (another app instance is sending): "already", nothing sent', withFlag('1', async () => {
  const h = pkg(pkgLead({ id: '307', consultCountersign: JSON.stringify({ packagePending: new Date().toISOString() }) }));
  try {
    assert.deepEqual(await consultationService.autoSendConsultationPackage('307', { trigger: 'payment' }), { status: 'already', reason: 'in-progress' });
    assert.equal(h.sends.length, 0); assert.equal(h.writes.length, 0);
  } finally { h.restore(); }
}));

test('5. onSlotConfirmed: the paid option sets the meeting length and travels to the package; a clash or a late payment asks for a hold', withFlag('1', async () => {
  const calls = [], meetings = [];
  let current = { ...pkgLead({ id: '308', meetingType: 'Virtual', zoomMeetingId: '', consultationHeld: '', consultOption: '' }) };
  const opt = JSON.stringify({ durationMin: 45, feeCents: 30000, variationId: 'V45', paidCents: 33900 });
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { current = { ...current, ...f }; }),
    stub(meetingService, 'createMeeting', async (l, slot, dur) => { meetings.push(dur); return { meetingId: 'm', joinUrl: 'https://teams/j', provider: 'teams' }; }),
    stub(squareBookings, 'ensureCustomer', async () => { throw new Error('test must never reach Square'); }),
    stub(consultationService, 'autoSendConsultationPackage', async (id, opts) => { calls.push(opts); return { status: 'held' }; }),
    stub(mondayApi, 'query', async () => ({ create_update: { id: '1' } })),
  ];
  try {
    await consultationService.onSlotConfirmed('308', 'Virtual', { consultOption: opt, slotClash: ['13279937278'] });
    assert.deepEqual(meetings, [45], 'the meeting is as long as what was paid for');
    assert.equal(calls[0].overrides.consultOption, opt);
    assert.equal(calls[0].hold, 'slot-clash');
    current = { ...pkgLead({ id: '309', meetingType: 'In-person', consultationHeld: '' }) };
    await consultationService.onSlotConfirmed('309', 'In-person', { wasAbandoned: true });
    assert.equal(calls[1].hold, 'late-payment');
    current = { ...pkgLead({ id: '310', meetingType: 'In-person', consultationHeld: '' }) };
    await consultationService.onSlotConfirmed('310', 'In-person');
    assert.equal(calls[2].hold, '', 'an ordinary booking is not held');
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('5. the agreement date and the Sent stamp are the Toronto day: a payment at 8:30 pm Toronto is dated that evening, not tomorrow', () => {
  const RealDate = Date;
  const T = RealDate.parse('2026-10-15T00:30:00Z');   // 8:30 pm Toronto on the 14th
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } };
  try {
    const d = consultAgreementSvc.buildConsultAgreementData({ id: '1', fullName: 'A B', residentialAddress: '1 Main St', email: 'a@b.co' });
    assert.equal(d.data ? d.data.agreementDate : d.agreementDate, 'October 14, 2026');
  } finally { global.Date = RealDate; }
  const svc = fs.readFileSync(require.resolve('../src/services/consultationService'), 'utf8');
  assert.ok(!/consultAgreementSent: new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/.test(svc), 'no UTC-day Sent stamp left');
  assert.equal((svc.match(/consultAgreementSent: torontoDay\(new Date\(\)\.toISOString\(\)\)/g) || []).length, 2);
});

test('5. the consultation page says WHY a package is held, and an expired one reads as expired', () => {
  const js = require('../src/routes/adminConsultation').buildDetailHTML('123');
  assert.match(js, /ca\.expired\?'· not sent automatically — the consultation time had already passed or begun; "Review & send" if still needed'/);
  assert.match(js, /\(ca\.held==='slot-clash'\)\?'· HELD — another client is booked for the same time; sort out the time, then "Review & send"'/);
  assert.match(js, /\(ca\.held==='late-payment'\)\?'· HELD — the client paid after the slot hold expired; confirm the time with the client, then "Review & send"'/);
  assert.ok(!/ca\.held&&ca\.expired/.test(js), 'the label that could never show is gone');
  const vm = require('vm'); for (const m of js.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
});
