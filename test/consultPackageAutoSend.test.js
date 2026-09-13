'use strict';

// Gauri 2026-09-04, point 08 — the consultation package goes out by itself the
// moment the consultation is paid. Faran's decisions (2026-09-13): payment is
// the trigger; only bookings from here on; a blank address HOLDS it and flags
// staff; entering the address releases it. Ships behind CONSULT_PACKAGE_AUTO_SEND.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const consultationService = require('../src/services/consultationService');
const consultAgreementSvc = require('../src/services/consultAgreementService');
const consultantPortal    = require('../src/services/consultantPortalService');
const leadService         = require('../src/services/leadService');
const mondayApi           = require('../src/services/mondayApi');
const meetingService      = require('../src/services/meetingService');
const documenso           = require('../src/services/documensoService');
const retainerDocService  = require('../src/services/retainerDocService');
const pdfConvertService   = require('../src/services/pdfConvertService');
// maybeSendConsultEsign renders the PDF through LOCAL calls, so the stubbable
// seams are the docx fill and the PDF conversion, not getConsultAgreementDocument.
const pdfStubs = () => [stub(retainerDocService, 'fillMaster', () => Buffer.from('docx')), stub(pdfConvertService, 'docxToPdf', async () => Buffer.from('%PDF'))];

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function withFlag(v, fn) {
  return async () => {
    const prev = process.env.CONSULT_PACKAGE_AUTO_SEND;
    if (v == null) delete process.env.CONSULT_PACKAGE_AUTO_SEND; else process.env.CONSULT_PACKAGE_AUTO_SEND = v;
    try { await fn(); } finally { if (prev === undefined) delete process.env.CONSULT_PACKAGE_AUTO_SEND; else process.env.CONSULT_PACKAGE_AUTO_SEND = prev; }
  };
}
// squareBookingId is set on EVERY fixture: onSlotConfirmed fires createSquareBooking
// in the background, and that guard is the first thing it checks. Without it a
// test reaches the PRODUCTION Square calendar (config/monday.js loads .env on
// import) — this happened once, on 2026-09-13.
const lead = (extra = {}) => ({ id: String(extra.id || '77'), fullName: 'Walk In', email: 'w@i.co', residentialAddress: '1 Main St', bookingStatus: 'Booked', bookedSlot: '2026-10-02 14:30', meetingType: 'Virtual', squareBookingId: 'test-never-square', ...extra });
const squareBookings = require('../src/services/squareBookingsService');

/** A harness around autoSend: counts sends, records notes and writes. */
function harness(leadObj) {
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

test('switch OFF (default): nothing is sent and the team still owns "Review & send"', withFlag(undefined, async () => {
  const h = harness(lead());
  try {
    assert.equal(consultationService.consultPackageAutoSendEnabled(), false);
    assert.deepEqual(await consultationService.autoSendConsultationPackage('77', { trigger: 'payment' }), { status: 'disabled' });
    assert.equal(h.sends.length, 0); assert.equal(h.notes.length, 0);
  } finally { h.restore(); }
}));

test('switch ON: the payment trigger sends the package ONCE — two Square deliveries and a reconciler sweep collapse', withFlag('1', async () => {
  const h = harness(lead({ id: '78' }));
  try {
    const rs = await Promise.all([
      consultationService.autoSendConsultationPackage('78', { trigger: 'payment', overrides: { meetingLink: 'https://teams/x' } }),
      consultationService.autoSendConsultationPackage('78', { trigger: 'payment' }),
      consultationService.autoSendConsultationPackage('78', { trigger: 'payment' }),
    ]);
    assert.deepEqual(rs.map((r) => r.status), ['sent', 'sent', 'sent'], 'all three callers see the one outcome');
    assert.equal(h.sends.length, 1, 'exactly one package');
    assert.deepEqual(h.sends[0].opts.overrides, { meetingLink: 'https://teams/x' }, 'the just-written join link is handed over, not re-read');
    // A LATE fourth delivery, after completion, with Monday still reading stale
    // (no Sent stamp visible): the in-process memory refuses it.
    assert.equal((await consultationService.autoSendConsultationPackage('78', { trigger: 'payment' })).status, 'already');
    assert.equal(h.sends.length, 1);
  } finally { h.restore(); }
}));

test('already sent (Sent stamp on the lead): the trigger is a no-op', withFlag('1', async () => {
  const h = harness(lead({ id: '79', consultAgreementSent: '2026-09-01' }));
  try {
    assert.equal((await consultationService.autoSendConsultationPackage('79', { trigger: 'payment' })).status, 'already');
    assert.equal(h.sends.length, 0);
  } finally { h.restore(); }
}));

test('blank address: HELD — no email, ONE staff note, a marker on the lead; a re-trigger stays quiet', withFlag('1', async () => {
  const h = harness(lead({ id: '80', residentialAddress: '' }));
  try {
    assert.deepEqual(await consultationService.autoSendConsultationPackage('80', { trigger: 'payment' }), { status: 'held', reason: 'blank-address' });
    assert.equal(h.sends.length, 0, 'nothing reached the client');
    assert.equal(h.notes.length, 1); assert.match(h.notes[0], /HELD/); assert.match(h.notes[0], /Residential address/);
    const marker = consultAgreementSvc.parseCountersign(h.lead());
    assert.equal(marker.packageHeld, 'blank-address'); assert.ok(marker.packageHeldAt);
    await consultationService.autoSendConsultationPackage('80', { trigger: 'payment' });
    assert.equal(h.notes.length, 1, 'the second delivery does not post a second note');
  } finally { h.restore(); }
}));

test('release: entering the address on a HELD lead sends the package and clears the marker', withFlag('1', async () => {
  const h = harness(lead({ id: '81', residentialAddress: '', consultCountersign: JSON.stringify({ packageHeld: 'blank-address', packageHeldAt: 'x', clientEnvelopeId: '' }) }));
  try {
    const r = await consultationService.autoSendConsultationPackage('81', { trigger: 'address', overrides: { residentialAddress: '9 New Rd' } });
    assert.equal(r.status, 'sent');
    assert.equal(h.sends.length, 1);
    assert.deepEqual(h.sends[0].opts.overrides, { residentialAddress: '9 New Rd' }, 'the address just saved is handed over');
    const after = consultAgreementSvc.parseCountersign(h.lead());
    assert.equal(after.packageHeld, undefined, 'marker cleared'); assert.equal(after.packageHeldAt, undefined);
    assert.equal(after.clientEnvelopeId, '', 'the rest of the countersign state is untouched');
  } finally { h.restore(); }
}));

test('decision 2 + 4: an address edit on a lead that was NEVER held sends nothing (pre-existing and hand-booked leads are safe)', withFlag('1', async () => {
  const h = harness(lead({ id: '82', residentialAddress: '' }));
  try {
    assert.deepEqual(await consultationService.autoSendConsultationPackage('82', { trigger: 'address', overrides: { residentialAddress: '9 New Rd' } }), { status: 'not-held' });
    assert.equal(h.sends.length, 0); assert.equal(h.notes.length, 0);
  } finally { h.restore(); }
}));

test('a send failure is loud: a staff note names the cause and points at "Review & send"; nothing is stamped', withFlag('1', async () => {
  const h = harness(lead({ id: '83' }));
  const boom = stub(consultationService, 'sendConsultationPackage', async () => { throw new Error('Documenso 503'); });
  try {
    const r = await consultationService.autoSendConsultationPackage('83', { trigger: 'payment' });
    assert.equal(r.status, 'failed'); assert.match(r.reason, /Documenso 503/);
    assert.equal(h.notes.length, 1); assert.match(h.notes[0], /NOT sent automatically/); assert.match(h.notes[0], /Documenso 503/); assert.match(h.notes[0], /Review &amp; send/);
    // Two writes: the durable "pending" marker BEFORE the slow work, then the
    // failure record (attempt count, error) with the pending marker REMOVED —
    // a failed payment send is not retried automatically, so the sweep must
    // not later mistake it for an interrupted send. No Sent stamp, no hold.
    assert.equal(h.writes.length, 2);
    assert.ok(JSON.parse(h.writes[0].consultCountersign).packagePending, 'pending laid down first');
    const cs = JSON.parse(h.writes[1].consultCountersign);
    assert.equal(cs.packageAttempts, 1); assert.match(cs.packageLastError, /Documenso 503/); assert.ok(!cs.packagePending && !cs.packageHeld);
    assert.ok(h.writes.every((w) => !('consultAgreementSent' in w)));
  } finally { boom(); h.restore(); }
}));

// ─── The hook sits on the payment transition, after the meeting exists ───────

test('onSlotConfirmed: the package fires AFTER the meeting is written, with the join link handed over', withFlag('1', async () => {
  const calls = [], writes = [];
  let current = lead({ id: '84', meetingType: 'Virtual', zoomMeetingId: '', consultationHeld: '' });
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(Object.keys(f)); current = { ...current, ...f }; }),
    stub(meetingService, 'createMeeting', async () => ({ meetingId: 'm1', joinUrl: 'https://teams/join', provider: 'teams' })),
    stub(squareBookings, 'ensureCustomer', async () => { throw new Error('test must never reach Square'); }),
    stub(consultationService, 'autoSendConsultationPackage', async (id, opts) => { calls.push({ id, opts, writesSoFar: writes.length }); return { status: 'sent' }; }),
    stub(mondayApi, 'query', async () => ({ create_update: { id: '1' } })),
  ];
  try {
    await consultationService.onSlotConfirmed('84', 'Virtual');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.trigger, 'payment');
    assert.deepEqual(calls[0].opts.overrides, { meetingType: 'Virtual', meetingLink: 'https://teams/join' });
    assert.ok(calls[0].writesSoFar >= 1 && writes[0].includes('meetingLink'), 'the meeting write happened first');
    // idempotent: a second confirmation is skipped before the hook
    await consultationService.onSlotConfirmed('84', 'Virtual');
    assert.equal(calls.length, 1);
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('onSlotConfirmed: an in-person booking fires the package too (no meeting link)', withFlag('1', async () => {
  const calls = [];
  let current = lead({ id: '85', meetingType: 'In-person', consultationHeld: '' });
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { current = { ...current, ...f }; }),
    stub(consultationService, 'autoSendConsultationPackage', async (id, opts) => { calls.push(opts); return { status: 'sent' }; }),
    stub(squareBookings, 'ensureCustomer', async () => { throw new Error('test must never reach Square'); }),
    stub(mondayApi, 'query', async () => ({ create_update: { id: '1' } })),
  ];
  try {
    await consultationService.onSlotConfirmed('85', 'In-person');
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].overrides, { meetingType: 'In-person' });
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('onSlotConfirmed: if the meeting cannot be created the team is told — never silent', withFlag('1', async () => {
  const notes = [], calls = [];
  const restore = [
    stub(leadService, 'getLead', async () => lead({ id: '86', meetingType: 'Virtual', zoomMeetingId: '', consultationHeld: '' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(meetingService, 'createMeeting', async () => { throw new Error('Teams 500'); }),
    stub(squareBookings, 'ensureCustomer', async () => { throw new Error('test must never reach Square'); }),
    stub(consultationService, 'autoSendConsultationPackage', async () => { calls.push(1); return { status: 'sent' }; }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.body); return { create_update: { id: '1' } }; }),
  ];
  try {
    await consultationService.onSlotConfirmed('86', 'Virtual');
    assert.equal(calls.length, 0, 'no package without a meeting to put in it');
    assert.equal(notes.length, 1); assert.match(notes[0], /NOT received the consultation package/); assert.match(notes[0], /Teams 500/);
  } finally { restore.reverse().forEach((r) => r()); }
}));

// ─── Never a second signing request ──────────────────────────────────────────

test('maybeSendConsultEsign: a LIVE outstanding envelope is REUSED with its signing link; a dead one is replaced', async () => {
  let minted = 0, status = 'PENDING', envErr = null;
  const restore = [
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'getEnvelope', async () => { if (envErr) throw envErr; return { status }; }),
    stub(documenso, 'recipientSignUrl', async () => 'https://app.documenso.com/sign/tok'),
    stub(documenso, 'sendForSignature', async () => { minted++; return { envelopeId: 'env-new', envelopeItemId: 'it-new' }; }),
    ...pdfStubs(),
    stub(leadService, 'updateLead', async () => {}),
  ];
  const held = lead({ consultCountersign: JSON.stringify({ clientEnvelopeId: 'env-1', clientItemId: 'it-1' }) });
  try {
    assert.deepEqual(await consultAgreementSvc.maybeSendConsultEsign(held), { envelopeId: 'env-1', reused: true, signUrl: 'https://app.documenso.com/sign/tok' }, 'PENDING → reused, with a link the client can use');
    status = 'COMPLETED';
    assert.deepEqual(await consultAgreementSvc.maybeSendConsultEsign(held), { alreadySigned: true }, 'COMPLETED (webhook not yet stamped) → already signed, never "please sign" again');
    envErr = new Error('Documenso 503'); assert.equal((await consultAgreementSvc.maybeSendConsultEsign(held)).reused, true, 'unreadable → reused (never double-send on a guess)');
    assert.equal(minted, 0);
    envErr = null; status = 'REJECTED';
    assert.equal((await consultAgreementSvc.maybeSendConsultEsign(held)).envelopeId, 'env-new', 'REJECTED → a fresh envelope');
    envErr = new Error('HTTP 404 not found');
    assert.equal((await consultAgreementSvc.maybeSendConsultEsign(held)).envelopeId, 'env-new', 'deleted → a fresh envelope');
    assert.equal(minted, 2);
  } finally { restore.reverse().forEach((r) => r()); }
});

// ─── The review-earned guards ────────────────────────────────────────────────

test('the e-sign stamp strips the hold/pending markers in the SAME write that records the envelope ids', async () => {
  const writes = [];
  const restore = [
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'sendForSignature', async () => ({ envelopeId: 'env-9', envelopeItemId: 'it-9' })),
    ...pdfStubs(),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
  ];
  try {
    await consultAgreementSvc.maybeSendConsultEsign(lead({ consultCountersign: JSON.stringify({ packageHeld: 'blank-address', packageHeldAt: 'x', packagePending: 'y', keep: 'me' }) }));
    const cs = JSON.parse(writes[0].consultCountersign);
    assert.deepEqual(cs, { keep: 'me', clientEnvelopeId: 'env-9', clientItemId: 'it-9' }, 'ids recorded, markers gone, unrelated keys kept');
  } finally { restore.reverse().forEach((r) => r()); }
});

test('release with a REAL send: the envelope ids survive and the markers are gone (no second envelope on the next click)', withFlag('1', async () => {
  // The real sendConsultationPackage → maybeSendConsultEsign chain; only I/O stubbed.
  const microsoftMail = require('../src/services/microsoftMailService');
  let current = lead({ id: '90', residentialAddress: '', consultCountersign: JSON.stringify({ packageHeld: 'blank-address', packageHeldAt: 'x' }) });
  let minted = 0;
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { current = { ...current, ...f }; }),
    stub(consultAgreementSvc, 'ensureConsultAgreementReady', async () => ({ lead: current, url: 'https://x/agreement' })),
    ...pdfStubs(),
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'getEnvelope', async () => ({ status: 'PENDING' })),
    stub(documenso, 'recipientSignUrl', async () => ''),
    stub(documenso, 'sendForSignature', async () => { minted++; return { envelopeId: 'env-A', envelopeItemId: 'it-A' }; }),
    stub(microsoftMail, 'sendEmail', async () => {}),
    stub(mondayApi, 'query', async () => ({ create_update: { id: '1' } })),
  ];
  try {
    const r = await consultationService.autoSendConsultationPackage('90', { trigger: 'address', overrides: { residentialAddress: '9 New Rd' } });
    assert.equal(r.status, 'sent');
    const cs = consultAgreementSvc.parseCountersign(current);
    assert.equal(cs.clientEnvelopeId, 'env-A', 'the envelope id recorded mid-send SURVIVES the release');
    assert.ok(!cs.packageHeld && !cs.packagePending, 'markers cleared');
    assert.equal(current.consultAgreementSent && current.consultAgreementSent.length, 10, 'Sent stamped');
    // Melanie clicks "Review & send" afterwards: same envelope, no new mint.
    const again = await consultationService.sendConsultationPackage('90');
    assert.equal(again.reused, true); assert.equal(minted, 1);
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('the address override reaches the PDF: the agreement is generated from the merged lead, not a stale re-read', async () => {
  const retainerDocService = require('../src/services/retainerDocService');
  const pdfConvertService  = require('../src/services/pdfConvertService');
  let merged = null;
  const restore = [
    stub(leadService, 'getLead', async () => lead({ id: '91', residentialAddress: '' })),     // Monday still reads blank
    stub(retainerDocService, 'fillMaster', (tpl, data) => { merged = data; return Buffer.from('docx'); }),
    stub(pdfConvertService, 'docxToPdf', async () => Buffer.from('%PDF')),
  ];
  try {
    await consultAgreementSvc.ensureConsultAgreementReady('91', { overrides: { residentialAddress: '9 New Rd\nToronto' } });
    assert.equal(merged.paAddress, '9 New Rd, Toronto', 'the address entered a moment ago is what the agreement prints');
  } finally { restore.reverse().forEach((r) => r()); }
});

test('an address trigger arriving DURING a payment run waits for it and then releases the hold it placed', withFlag('1', async () => {
  let current = lead({ id: '92', residentialAddress: '' });
  const sends = [];
  let releaseGetLead; const gate = new Promise((res) => { releaseGetLead = res; });
  let reads = 0;
  const restore = [
    stub(leadService, 'getLead', async () => { reads++; if (reads === 1) await gate; return { ...current }; }),
    stub(leadService, 'updateLead', async (id, f) => { current = { ...current, ...f }; }),
    stub(consultationService, 'sendConsultationPackage', async (id, opts) => { sends.push(opts); return { via: 'review-link' }; }),
    stub(mondayApi, 'query', async () => ({ create_update: { id: '1' } })),
  ];
  try {
    const payment = consultationService.autoSendConsultationPackage('92', { trigger: 'payment' });
    const address = consultationService.autoSendConsultationPackage('92', { trigger: 'address', overrides: { residentialAddress: '9 New Rd' } });
    releaseGetLead();
    assert.equal((await payment).status, 'held', 'the payment run placed the hold');
    assert.equal((await address).status, 'sent', 'the address trigger did not adopt "held" — it re-ran after the hold and released it');
    assert.equal(sends.length, 1);
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('the sweep releases a hold whose address arrived via Monday, hands a stale pending send to staff ONCE, and touches nothing else', withFlag('1', async () => {
  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString(), fresh = new Date().toISOString();   // well past the 10-min threshold
  const booked = [
    lead({ id: '100', consultCountersign: JSON.stringify({ packagePending: old }) }),                                  // restart cut the send short → a person decides (never re-driven)
    lead({ id: '101', consultCountersign: JSON.stringify({ packagePending: fresh }) }),                                // still in flight → leave it
    lead({ id: '102', residentialAddress: '9 Rd', consultCountersign: JSON.stringify({ packageHeld: 'blank-address' }) }), // address typed into Monday → release
    lead({ id: '103', residentialAddress: '', consultCountersign: JSON.stringify({ packageHeld: 'blank-address' }) }),     // still blank → leave it
    lead({ id: '104' }),                                                                                              // pre-existing / hand-booked, no marker → never
    lead({ id: '105', consultAgreementSent: '2026-09-01', consultCountersign: JSON.stringify({ packagePending: old }) }), // already sent → never
  ];
  const calls = [], notes = [], writes = [];
  const restore = [
    stub(leadService, 'findAllByColumnValue', async (k, v) => (k === 'bookingStatus' && v === 'Booked' ? booked : [])),
    stub(leadService, 'updateLead', async (id, f) => { writes.push({ id, f }); const L = booked.find((x) => x.id === id); Object.assign(L, f); }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push({ id: vars.itemId, body: vars.body }); return { create_update: { id: '1' } }; }),
    stub(consultationService, 'autoSendConsultationPackage', async (id, opts) => { calls.push({ id, trigger: opts.trigger }); return { status: 'sent' }; }),
  ];
  try {
    const r = await consultationService.sweepConsultPackages();
    assert.deepEqual(r, { swept: 2, released: 1, stalled: 1 });
    assert.deepEqual(calls, [{ id: '102', trigger: 'address' }], 'only the unambiguous case is auto-driven');
    assert.deepEqual(notes.map((n) => n.id), ['100']); assert.match(notes[0].body, /interrupted/); assert.match(notes[0].body, /Review &amp; send/);
    const cs100 = JSON.parse(writes.find((w) => w.id === '100').f.consultCountersign);
    assert.ok(cs100.packageStalled && !cs100.packagePending, 'stalled marker replaces the pending one');
    // The next tick: the stalled lead is not noted again, nothing else changes.
    const again = await consultationService.sweepConsultPackages();
    assert.deepEqual(again, { swept: 1, released: 1, stalled: 0 }); assert.equal(notes.length, 1);
  } finally { restore.reverse().forEach((r) => r()); }
}));

// ─── The round-2 rules: delivery is the fact; never re-drive on a guess ─────

test('review-link path: a Sent-stamp failure AFTER the email is "delivered, record failed" — accurate note, markers cleared, never "failed"', withFlag('1', async () => {
  const microsoftMail = require('../src/services/microsoftMailService');
  let current = lead({ id: '110' });
  const notes = [], mails = [];
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { if ('consultAgreementSent' in f) throw new Error('Monday 502'); current = { ...current, ...f }; }),
    stub(consultAgreementSvc, 'ensureConsultAgreementReady', async () => ({ lead: current, url: 'https://x/agreement' })),
    stub(consultAgreementSvc, 'maybeSendConsultEsign', async () => null),          // e-sign off → review link
    stub(microsoftMail, 'sendEmail', async (m) => { mails.push(m); }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.body); return { create_update: { id: '1' } }; }),
  ];
  try {
    const r = await consultationService.autoSendConsultationPackage('110', { trigger: 'payment' });
    assert.equal(r.status, 'sent'); assert.match(r.stampFailed, /Monday 502/);
    assert.equal(mails.length, 1);
    assert.equal(notes.length, 1); assert.match(notes[0], /emailed to the client/); assert.match(notes[0], /Do NOT re-send/); assert.ok(!/NOT sent/.test(notes[0]));
    assert.ok(!consultAgreementSvc.parseCountersign(current).packagePending, 'pending cleared — the sweep will not stall it');
    // and a second payment delivery right after is refused in-process even though Monday shows no Sent stamp
    assert.equal((await consultationService.autoSendConsultationPackage('110', { trigger: 'payment' })).status, 'already');
    assert.equal(mails.length, 1);
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('a hold released for a consultation that already happened is not sent — one note, marked expired', withFlag('1', async () => {
  const h = harness(lead({ id: '111', bookedSlot: '2026-08-05 10:00', residentialAddress: '', consultCountersign: JSON.stringify({ packageHeld: 'blank-address' }) }));
  try {
    assert.deepEqual(await consultationService.autoSendConsultationPackage('111', { trigger: 'address', overrides: { residentialAddress: '9 Rd' } }), { status: 'expired' });
    assert.equal(h.sends.length, 0); assert.equal(h.notes.length, 1); assert.match(h.notes[0], /already passed/);
    assert.ok(consultAgreementSvc.parseCountersign(h.lead()).packageExpired);
    await consultationService.autoSendConsultationPackage('111', { trigger: 'address', overrides: { residentialAddress: '9 Rd' } });
    assert.equal(h.notes.length, 1, 'noted once');
  } finally { h.restore(); }
}));

test('a hold whose release keeps failing is retried by the sweep at most 3 times, with a note on the first and last attempt', withFlag('1', async () => {
  const held = lead({ id: '112', residentialAddress: '9 Rd', consultCountersign: JSON.stringify({ packageHeld: 'blank-address' }) });
  const notes = [];
  let attempts = 0;
  const restore = [
    stub(leadService, 'findAllByColumnValue', async () => [held]),
    stub(leadService, 'getLead', async () => ({ ...held })),
    stub(leadService, 'updateLead', async (id, f) => { Object.assign(held, f); }),
    stub(consultationService, 'sendConsultationPackage', async () => { attempts++; throw new Error('CloudConvert: insufficient credits'); }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.body); return { create_update: { id: '1' } }; }),
  ];
  try {
    for (let i = 0; i < 5; i++) await consultationService.sweepConsultPackages();
    assert.equal(attempts, 3, 'capped');
    assert.equal(notes.length, 2, 'first failure and the final one'); assert.match(notes[1], /3 attempts/);
    assert.equal(consultAgreementSvc.parseCountersign(held).packageAttempts, 3);
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('the team\'s manual send registers in the in-flight gate: an automatic trigger during it adopts, never doubles', withFlag('1', async () => {
  const microsoftMail = require('../src/services/microsoftMailService');
  let current = lead({ id: '113' });
  let releaseMail; const gate = new Promise((res) => { releaseMail = res; });
  const mails = [];
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { current = { ...current, ...f }; }),
    stub(consultAgreementSvc, 'ensureConsultAgreementReady', async () => ({ lead: current, url: 'https://x/agreement' })),
    stub(consultAgreementSvc, 'maybeSendConsultEsign', async () => null),
    stub(microsoftMail, 'sendEmail', async (m) => { mails.push(m); await gate; }),
    stub(mondayApi, 'query', async () => ({ create_update: { id: '1' } })),
  ];
  try {
    const manual = consultationService.sendConsultationPackage('113');            // Melanie clicks
    await new Promise((r) => setImmediate(r));
    const auto = consultationService.autoSendConsultationPackage('113', { trigger: 'payment' });   // the webhook lands mid-click
    releaseMail();
    assert.equal((await manual).ok, true);
    assert.equal((await auto).status, 'already', 'adopted the manual run');
    assert.equal(mails.length, 1);
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('pins: the test guard also refuses the Claude API and the app\'s own host', () => {
  const src = fs.readFileSync(require.resolve('../test/helpers/noNetwork'), 'utf8');
  for (const host of ['anthropic\\.com', 'onrender\\.com', 'squareup\\.com', 'monday\\.com', 'documenso\\.com', 'cloudconvert\\.com', 'microsoft\\.com']) assert.ok(src.includes(host), host);
  assert.match(fs.readFileSync(require.resolve('../package.json'), 'utf8'), /NODE_OPTIONS=\\"--require \.\/test\/helpers\/noNetwork\.js\\" node --test/);
});

test('the sweep is a no-op while the switch is off', withFlag(undefined, async () => {
  const q = stub(leadService, 'findAllByColumnValue', async () => { throw new Error('must not query'); });
  try { assert.deepEqual(await consultationService.sweepConsultPackages(), { swept: 0 }); } finally { q(); }
}));

test('pins: the sweep is scheduled, offset from the payment reconciler', () => {
  const src = fs.readFileSync(require.resolve('../src/services/scheduler'), 'utf8');
  assert.match(src, /cron\.schedule\('9,24,39,54 \* \* \* \*', \(\) =>\s*require\('\.\/consultationService'\)\.sweepConsultPackages\(\)/);
});

// ─── The portal action releases the hold ─────────────────────────────────────

test('saveResidentialAddress: releases a HELD package and tells staff; a non-held lead just saves', withFlag('1', async () => {
  const auto = [];
  const held = lead({ id: '87', residentialAddress: '', consultCountersign: JSON.stringify({ packageHeld: 'blank-address' }) });
  const restore = [
    stub(leadService, 'getLead', async (id) => (id === '87' ? held : lead({ id, residentialAddress: '' }))),
    stub(leadService, 'updateLead', async () => {}),
    stub(consultAgreementSvc, 'evictCache', () => {}),
    stub(mondayApi, 'query', async () => ({ create_update: { id: '1' } })),
    stub(consultationService, 'autoSendConsultationPackage', async (id, opts) => { auto.push({ id, opts }); return { status: 'sent' }; }),
  ];
  try {
    const r1 = await consultantPortal.applyAction({ leadId: '87', action: 'saveResidentialAddress', value: '12 King St W\nToronto ON', staffName: 'Gauri' });
    assert.equal(auto.length, 1);
    assert.deepEqual(auto[0], { id: '87', opts: { trigger: 'address', overrides: { residentialAddress: '12 King St W\nToronto ON' } } });
    assert.match(r1.message, /package has been emailed/); assert.equal(r1.packageReleased, 'sent');
    const r2 = await consultantPortal.applyAction({ leadId: '88', action: 'saveResidentialAddress', value: '12 King St W', staffName: 'Gauri' });
    assert.equal(auto.length, 1, 'no hold marker → autoSend is not even asked');
    assert.equal(r2.message, 'Residential address saved.'); assert.ok(!('packageReleased' in r2), 'the return shape is unchanged when nothing was held');
  } finally { restore.reverse().forEach((r) => r()); }
}));

// ─── Pins: the seam, the switch, the untouched callers ───────────────────────

test('pins: hook placement, kill-switch convention, and the payment callers are untouched', () => {
  const svc = fs.readFileSync(require.resolve('../src/services/consultationService'), 'utf8');
  const hook = svc.indexOf('module.exports.autoSendConsultationPackage(leadId');
  const meetingWrite = svc.indexOf("meetingLink:     { url: meeting.joinUrl");
  assert.ok(meetingWrite > 0 && hook > meetingWrite, 'the package is sent after the meeting link is written');
  assert.match(svc, /CONSULT_PACKAGE_AUTO_SEND \|\| ''\)\.trim\(\)\)/, 'switch reads the env at call time');
  assert.match(svc, /\/\^\(true\|1\)\$\/i/, 'same on/off convention as DOCUMENSO_ENABLED');
  // confirmSlot and the reconciler are not the seam — they are unchanged.
  const booking = fs.readFileSync(require.resolve('../src/services/bookingService'), 'utf8');
  assert.ok(!/autoSendConsultationPackage/.test(booking), 'confirmSlot does not call the package directly');
  const recon = fs.readFileSync(require.resolve('../src/services/paymentReconciler'), 'utf8');
  assert.ok(!/autoSendConsultationPackage|sendConsultationPackage/.test(recon));
});


// ─── Round 3: a stale snapshot must never erase what a later write recorded ──

test('package email fails AFTER the signing request went out: no column write (ids kept), note says the request DID reach the client', withFlag('1', async () => {
  const microsoftMail = require('../src/services/microsoftMailService');
  let current = lead({ id: '120' });
  const notes = [], writes = [];
  let minted = 0;
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); current = { ...current, ...f }; }),
    stub(consultAgreementSvc, 'ensureConsultAgreementReady', async () => ({ lead: current, url: 'https://x/agreement' })),
    ...pdfStubs(),
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'getEnvelope', async () => ({ status: 'PENDING' })),
    stub(documenso, 'recipientSignUrl', async () => ''),
    stub(documenso, 'sendForSignature', async () => { minted++; return { envelopeId: 'env-Z', envelopeItemId: 'it-Z' }; }),
    stub(microsoftMail, 'sendEmail', async () => { throw new Error('Graph 503'); }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.body); return { create_update: { id: '1' } }; }),
  ];
  try {
    const r = await consultationService.autoSendConsultationPackage('120', { trigger: 'payment' });
    assert.equal(r.status, 'failed'); assert.equal(r.envelopeOut, true);
    const cs = consultAgreementSvc.parseCountersign(current);
    assert.equal(cs.clientEnvelopeId, 'env-Z', 'the envelope recorded by the e-sign stamp SURVIVES the failure path');
    assert.ok(!cs.packagePending && !cs.packageAttempts, 'the stamp stripped the markers and nothing rewrote them');
    assert.equal(notes.length, 1); assert.match(notes[0], /DID reach the client/); assert.match(notes[0], /reuses the same signing request/);
    // Melanie clicks: the package email goes with the SAME envelope
    require('../src/services/microsoftMailService').sendEmail = async () => {};
    const again = await consultationService.sendConsultationPackage('120');
    assert.equal(again.reused, true); assert.equal(minted, 1);
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('e-sign stamp fails: the envelope ids and an "emailed" marker are recorded, and a later trigger does not re-send', withFlag('1', async () => {
  const microsoftMail = require('../src/services/microsoftMailService');
  let current = lead({ id: '121' });
  const notes = [];
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { if ('consultAgreementSent' in f) throw new Error('Monday 502'); current = { ...current, ...f }; }),
    stub(consultAgreementSvc, 'maybeSendConsultEsign', async () => ({ envelopeId: 'env-S', envelopeItemId: 'it-S', stampFailed: 'Monday 502' })),
    stub(consultAgreementSvc, 'ensureConsultAgreementReady', async () => ({ lead: current, url: 'https://x/agreement' })),
    stub(microsoftMail, 'sendEmail', async () => {}),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.body); return { create_update: { id: '1' } }; }),
  ];
  try {
    const r = await consultationService.autoSendConsultationPackage('121', { trigger: 'payment' });
    assert.equal(r.status, 'sent'); assert.match(r.stampFailed, /Monday 502/);
    const cs = consultAgreementSvc.parseCountersign(current);
    assert.equal(cs.clientEnvelopeId, 'env-S'); assert.equal(cs.clientItemId, 'it-S'); assert.ok(cs.packageEmailedAt);
    assert.ok(!cs.packagePending, 'not left for the sweep to stall');
    assert.match(notes[0], /signing request is out/); assert.match(notes[0], /Do NOT re-send/);
    // 20 minutes later (in-process memory expired) a duplicate payment delivery arrives; Monday still shows no Sent stamp
    consultationService._resetSentMemory && consultationService._resetSentMemory();
    assert.equal((await consultationService.autoSendConsultationPackage('121', { trigger: 'payment' })).status, 'already', 'the emailed marker is the durable guard');
    // and the sweep leaves it alone
    const q = stub(leadService, 'findAllByColumnValue', async () => [current]);
    try { assert.deepEqual(await consultationService.sweepConsultPackages(), { swept: 0, released: 0, stalled: 0 }); } finally { q(); }
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('an INTERRUPTED release (pending marker left behind) is handed to staff by the sweep, never driven again', withFlag('1', async () => {
  const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  // What the column looks like after a release crashed mid-send: the pending write
  // already dropped the held marker.
  const L = lead({ id: '122', residentialAddress: '9 Rd', consultCountersign: JSON.stringify({ packagePending: stale }) });
  const calls = [], notes = [];
  const restore = [
    stub(leadService, 'findAllByColumnValue', async () => [L]),
    stub(leadService, 'updateLead', async (id, f) => { Object.assign(L, f); }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.body); return { create_update: { id: '1' } }; }),
    stub(consultationService, 'autoSendConsultationPackage', async (id, opts) => { calls.push(opts); return { status: 'sent' }; }),
  ];
  try {
    assert.deepEqual(await consultationService.sweepConsultPackages(), { swept: 1, released: 0, stalled: 1 });
    assert.equal(calls.length, 0); assert.match(notes[0], /interrupted/);
    assert.ok(consultAgreementSvc.parseCountersign(L).packageStalled);
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('the pending write ends the hold; a CLEAN release failure restores it (so the cap applies), a crash does not', withFlag('1', async () => {
  const h = harness(lead({ id: '123', residentialAddress: '9 Rd', consultCountersign: JSON.stringify({ packageHeld: 'blank-address', packageHeldAt: 'x' }) }));
  const boom = stub(consultationService, 'sendConsultationPackage', async () => { throw new Error('CloudConvert 503'); });
  try {
    await consultationService.autoSendConsultationPackage('123', { trigger: 'address' });
    const pending = JSON.parse(h.writes[0].consultCountersign);
    assert.ok(pending.packagePending && !pending.packageHeld, 'while in progress it is "pending", not "held"');
    const after = consultAgreementSvc.parseCountersign(h.lead());
    assert.equal(after.packageHeld, 'blank-address', 'restored on a clean failure → still releasable');
    assert.equal(after.packageAttempts, 1); assert.ok(!after.packagePending);
  } finally { boom(); h.restore(); }
}));

test('an expired hold is not driven by the sweep', withFlag('1', async () => {
  const L = lead({ id: '124', residentialAddress: '9 Rd', consultCountersign: JSON.stringify({ packageHeld: 'blank-address', packageExpired: 'x' }) });
  const calls = [];
  const restore = [
    stub(leadService, 'findAllByColumnValue', async () => [L]),
    stub(consultationService, 'autoSendConsultationPackage', async (id, opts) => { calls.push(opts); return { status: 'expired' }; }),
  ];
  try { await consultationService.sweepConsultPackages(); assert.equal(calls.length, 0); } finally { restore.reverse().forEach((r) => r()); }
}));


// ─── Round 3 hardening: an unrecorded envelope is still remembered ───────────

test('e-sign stamp fails on BOTH tries and the column never gets the id: the button still reuses the envelope (in-process memo), minting once', async () => {
  consultAgreementSvc._forgetUnstampedEnvelopes();
  let minted = 0, current = lead({ id: '130' });
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { if ('consultAgreementSent' in f) throw new Error('Monday 502'); current = { ...current, ...f }; }),
    ...pdfStubs(),
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'getEnvelope', async () => ({ status: 'PENDING' })),
    stub(documenso, 'recipientSignUrl', async () => 'https://app.documenso.com/sign/x'),
    stub(documenso, 'sendForSignature', async () => { minted++; return { envelopeId: 'env-M', envelopeItemId: 'it-M' }; }),
  ];
  try {
    const first = await consultAgreementSvc.maybeSendConsultEsign(current);
    assert.equal(first.envelopeId, 'env-M'); assert.match(first.stampFailed, /Monday 502/);
    assert.ok(!consultAgreementSvc.parseCountersign(current).clientEnvelopeId, 'the column really has no id');
    const second = await consultAgreementSvc.maybeSendConsultEsign(current);          // Melanie clicks "Review & send"
    assert.deepEqual(second, { envelopeId: 'env-M', reused: true, signUrl: 'https://app.documenso.com/sign/x' });
    assert.equal(minted, 1, 'never a second signing request');
  } finally { restore.reverse().forEach((r) => r()); consultAgreementSvc._forgetUnstampedEnvelopes(); }
});

test('the emailed-marker write also retries the Sent stamp, so a later Monday recovery leaves the page reading "sent"', withFlag('1', async () => {
  const microsoftMail = require('../src/services/microsoftMailService');
  let current = lead({ id: '131' });
  const writes = [];
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...current })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); current = { ...current, ...f }; }),
    stub(consultAgreementSvc, 'maybeSendConsultEsign', async () => ({ envelopeId: 'env-S', envelopeItemId: 'it-S', stampFailed: 'Monday 502' })),
    stub(consultAgreementSvc, 'ensureConsultAgreementReady', async () => ({ lead: current, url: 'https://x/agreement' })),
    stub(microsoftMail, 'sendEmail', async () => {}),
    stub(mondayApi, 'query', async () => ({ create_update: { id: '1' } })),
  ];
  try {
    await consultationService.autoSendConsultationPackage('131', { trigger: 'payment' });
    const i = writes.findIndex((x) => x.consultCountersign && JSON.parse(x.consultCountersign).packageEmailedAt);
    assert.ok(i >= 0, 'the emailed marker was written on its own');
    assert.ok(writes[i + 1] && 'consultAgreementSent' in writes[i + 1], 'then the Sent stamp is retried as a separate best-effort write');
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('stalled and expired are terminal: the held marker does not survive them', withFlag('1', async () => {
  // stalled
  const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const L = lead({ id: '132', residentialAddress: '9 Rd', consultCountersign: JSON.stringify({ packageHeld: 'blank-address', packageHeldAt: 'x', packagePending: stale }) });
  const restore = [
    stub(leadService, 'findAllByColumnValue', async () => [L]),
    stub(leadService, 'updateLead', async (id, f) => { Object.assign(L, f); }),
    stub(mondayApi, 'query', async () => ({ create_update: { id: '1' } })),
    stub(consultationService, 'autoSendConsultationPackage', async () => { throw new Error('must not be driven'); }),
  ];
  try {
    await consultationService.sweepConsultPackages();
    const cs = consultAgreementSvc.parseCountersign(L);
    assert.ok(cs.packageStalled && !cs.packageHeld && !cs.packagePending);
    await consultationService.sweepConsultPackages();   // and the next tick finds nothing to drive
  } finally { restore.reverse().forEach((r) => r()); }
  // expired
  const h = harness(lead({ id: '133', bookedSlot: '2026-08-05 10:00', residentialAddress: '9 Rd', consultCountersign: JSON.stringify({ packageHeld: 'blank-address', packageHeldAt: 'x' }) }));
  try {
    await consultationService.autoSendConsultationPackage('133', { trigger: 'address' });
    const cs = consultAgreementSvc.parseCountersign(h.lead());
    assert.ok(cs.packageExpired && !cs.packageHeld, 'the hold is retired');
  } finally { h.restore(); }
}));
