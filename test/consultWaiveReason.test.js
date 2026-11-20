'use strict';

// A waived fee needs a typed reason (Gauri B3, first half; Faran 2026-11-20).
// Her words: "whoever is waiving off the consultation fee needs to write a reason".
//   - ONE server rule, in consultPaymentService.validateRecord (what a page SENDS): kind "waived" with a note under
//     3 characters is refused. It covers "Record payment / Waived" and "＋ Direct consultation → Free" alike.
//   - The reason is the record's own `note`: no new field, no new Monday column, nothing rewritten.
//   - A STORED waived record with no reason still reads as Waived everywhere (lists, Reporting, the agreement).
//   - Seen on the record ("Reason" on the fee card, "· reason: …" in the record line) and in the hover text of the
//     "Waived" pill on the Consultations and Retainers lists. Reporting keeps the number only.
// No switch: it is on from the deploy. Made-up people only; every Monday / mail seam is stubbed.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');

const cp          = require('../src/services/consultPaymentService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const portal      = require('../src/services/consultantPortalService');
const consultSvc  = require('../src/services/consultationService');
const meeting     = require('../src/services/meetingService');
const snap        = require('../src/services/leadSnapshot');
const C           = require('../src/routes/adminConsultation');
const { computeKpis } = require('../src/services/kpiService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const TODAY = '2026-11-20';
const REASON_ERROR = 'Write the reason the fee is waived (why the consultation is free) — nothing was saved. If you cannot see a box for the reason, reload the page first.';
// These tests are about the record alone: the package question and the money-first switch are off.
delete process.env.CONSULT_PACKAGE_ON_RECORD;
delete process.env.CONSULT_MONEY_FIRST;

/* ── the one rule ── */

test('validateRecord: waived with no reason, spaces only or 2 characters is refused with the exact words; 3 characters pass; the reason is one trimmed line; the length cap still speaks first', () => {
  const v = (o) => cp.validateRecord(o, { today: TODAY });
  assert.equal(cp.WAIVE_REASON_ERROR, REASON_ERROR);
  assert.equal(cp.MIN_REASON, 3);
  for (const note of [undefined, null, '', '   ', ' \n\t ', 'ab', ' a  ', 'a\n', ' x \n y'.slice(0, 2)]) {
    assert.deepEqual(v({ kind: 'waived', note }), { ok: false, error: REASON_ERROR }, JSON.stringify(note));
  }
  assert.deepEqual(v({ kind: 'waived' }), { ok: false, error: REASON_ERROR }, 'the exact body an old open page sends');
  assert.deepEqual(v(JSON.stringify({ kind: 'waived', amountCents: null, on: TODAY, reference: '', note: '' })), { ok: false, error: REASON_ERROR }, 'as the record box posts it (a JSON string)');
  assert.deepEqual(v({ kind: 'waived', note: 'n/a' }), { ok: true, normalized: { kind: 'waived', amountCents: 0, on: TODAY, reference: '', note: 'n/a', package: '', packageNote: '', booking: null } }, 'three characters pass (the app can ask for words, not for good ones)');
  assert.equal(v({ kind: 'waived', note: '  family of\n  an existing   client ' }).normalized.note, 'family of an existing client', 'one line, single spaces');
  assert.equal(v({ kind: 'waived', note: 'a b' }).ok, true);
  assert.equal(v({ kind: 'waived', note: 'a \n b' }).ok, true, '"a b" after trimming to one line');
  // spaces do not count towards the three
  assert.equal(v({ kind: 'waived', note: 'a      ' }).ok, false);
  // the length cap is unchanged and is checked first
  assert.equal(v({ kind: 'waived', note: 'x'.repeat(200) }).ok, true);
  assert.deepEqual(v({ kind: 'waived', note: 'x'.repeat(201) }), { ok: false, error: 'Keep the note under 200 characters.' });
  // a non-text reason is not a reason
  for (const note of [true, 0, 7, [], {}]) assert.equal(v({ kind: 'waived', note }).ok === true && v({ kind: 'waived', note }).normalized.note.length < 3, false, JSON.stringify(note));
});

test('validateRecord: every other kind keeps its optional note; "Remove record" asks no reason', () => {
  const v = (o) => cp.validateRecord(o, { today: TODAY });
  for (const kind of ['cash', 'e-transfer', 'square', 'invoice', 'other']) {
    assert.deepEqual(v({ kind, amountCents: 20000 }), { ok: true, normalized: { kind, amountCents: 20000, on: TODAY, reference: '', note: '', package: '', packageNote: '', booking: null } }, kind + ' with no note');
    assert.equal(v({ kind, amountCents: 20000, note: 'x' }).normalized.note, 'x', kind + ': a one-letter note is fine');
  }
  assert.deepEqual(v({ kind: 'clear' }), { ok: true, normalized: { kind: 'clear' } });
  assert.deepEqual(v({ kind: 'clear', note: '' }), { ok: true, normalized: { kind: 'clear' } });
  // a token amount is a paid kind, not a waiver — it cannot be told apart from a real small fee (a known gap)
  assert.equal(v({ kind: 'other', amountCents: 100 }).ok, true);
});

test('describe: a waived record\'s note is written as its reason; with none, nothing is added; paid kinds still say "note"', () => {
  assert.equal(cp.describe({ kind: 'waived', amountCents: 0, on: '2026-11-20', by: 'Staff One', verified: true, note: 'family of an existing client' }), 'Waived on 2026-11-20 by Staff One · reason: family of an existing client');
  assert.equal(cp.describe({ kind: 'waived', amountCents: 0, on: '2026-11-20', by: 'Staff One', verified: false, reference: 'R1', note: 'promised by phone' }), 'Waived on 2026-11-20 by Staff One (name as typed) · ref R1 · reason: promised by phone');
  assert.equal(cp.describe({ kind: 'waived', amountCents: 0, on: '2026-10-01', by: 'Staff One', verified: true, note: '' }), 'Waived on 2026-10-01 by Staff One', 'an older waiver: nothing added');
  assert.equal(cp.describe({ kind: 'cash', amountCents: 20000, on: '2026-11-20', by: 'Staff One', verified: true, note: 'paid at the desk' }), 'Cash $200.00 received 2026-11-20 by Staff One · note: paid at the desk');
  for (const kind of ['e-transfer', 'square', 'invoice', 'other']) assert.match(cp.describe({ kind, amountCents: 100, on: '2026-11-20', by: 'S', verified: true, note: 'n' }), / · note: n$/, kind);
});

test('reading is NOT touched: a stored waived record with no reason still reads as Waived — the rule is only on what a page sends', () => {
  const old = { consultPayment: JSON.stringify({ kind: 'waived', amountCents: 0, on: '2026-10-01', by: 'Staff One', verified: true }) };
  assert.deepEqual(cp.parseConsultPayment(old), { kind: 'waived', amountCents: 0, hstCents: null, on: '2026-10-01', reference: '', note: '', by: 'Staff One', at: '', verified: true, package: '', packageNote: '' });
  const ps = cp.paidState(old);
  assert.deepEqual([ps.paid, ps.paidCents, ps.note, ps.by], ['waived', 0, '', 'Staff One']);
  // Reporting: counts once, adds $0
  const k = computeKpis([{ bookedSlot: '2026-10-12 10:00', createdAt: '2026-10-01T10:00:00Z', ...old }], '2026-10');
  assert.deepEqual([k.consultations.waived, k.consultations.revenue, k.consultations.paidByStaff], [1, 0, 0]);
  // the agreement: the same words, never the reason
  const cas = require('../src/services/consultAgreementService');
  const amt = (lead) => cas.buildConsultAgreementData({ fullName: 'A Person', residentialAddress: '1 Test St', email: 'a@example.test', bookedSlot: '2026-11-25 10:00', ...lead }).data.amountPaid;
  assert.equal(amt(old), 'nothing (the consultation fee was waived)');
  const withWhy = { consultPayment: JSON.stringify({ kind: 'waived', amountCents: 0, on: '2026-11-20', by: 'Staff One', verified: true, note: 'SECRET-REASON' }) };
  assert.equal(amt(withWhy), 'nothing (the consultation fee was waived)');
  assert.ok(!JSON.stringify(cas.buildConsultAgreementData({ fullName: 'A Person', residentialAddress: '1 Test St', email: 'a@example.test', bookedSlot: '2026-11-25 10:00', ...withWhy }).data).includes('SECRET-REASON'), 'the reason is staff-only: never in the agreement');
  // the Client Master copy line does not carry it either
  const copy = JSON.stringify(require('../src/services/consultCopyService'));
  assert.ok(typeof copy === 'string');
  const src = require('fs').readFileSync(require.resolve('../src/services/consultCopyService'), 'utf8');
  assert.ok(!/\.note\b/.test(src), 'consultCopyService never reads the note');
  // the Paid filter value: still "waived"
  const S = require('../src/routes/listSpecs');
  const LT = require('../src/routes/listFilters').listCore(S.consultListSpec({ today: () => TODAY }));
  assert.deepEqual(LT.valuesOf('paid', { paid: 'waived', paidNote: '' }), ['waived']);
  assert.deepEqual(LT.valuesOf('paid', { paid: 'waived', paidNote: 'family' }), ['waived']);
});

/* ── the action: "Record payment / Waived" ── */

function world({ lead, signedIn = true } = {}) {
  const writes = [], notes = [], monday = [], reads = [], auto = [], meetings = [];
  const state = { lead: { id: '555', fullName: 'Test Client', ...lead } };
  const restore = [
    stub(leadService, 'getLead', async (id) => { reads.push(String(id)); return { ...state.lead }; }),
    stub(leadService, 'updateLead', async (id, fields, opts) => { writes.push({ id, fields, opts }); Object.assign(state.lead, fields); }),
    stub(mondayApi, 'query', async (q, vars) => { monday.push(q); if (/create_update/.test(q)) notes.push(vars.b); return {}; }),
    stub(consultSvc, 'autoSendConsultationPackage', async (...a) => { auto.push(a); return { status: 'sent' }; }),
    stub(meeting, 'createMeeting', async (...a) => { meetings.push(a); return { joinUrl: 'x', id: 'm' }; }),
  ];
  const actor = signedIn ? { name: 'Staff One', email: 'one@example.test', verified: true } : { name: 'Unidentified (shared admin key)', email: '', verified: false };
  const nothing = (msg) => { assert.equal(writes.length, 0, msg + ': no column write'); assert.equal(notes.length, 0, msg + ': no update'); assert.equal(monday.length, 0, msg + ': no Monday call at all'); assert.equal(auto.length, 0, msg + ': no package'); assert.equal(meetings.length, 0, msg + ': no meeting'); };
  return { writes, notes, monday, reads, auto, meetings, state, actor, nothing, done: () => restore.reverse().forEach((r) => r()) };
}
const record = (w, value, extra = {}) => portal.applyAction({ leadId: '555', action: 'recordConsultPayment', value, actor: w.actor, ...extra });
const refusedForReason = (e) => e.badRequest === true && e.message === REASON_ERROR;

test('apply: waived with NO reason is refused before the lead is even read — nothing is written, noted, booked or emailed', async () => {
  const w = world();
  try {
    for (const value of [{ kind: 'waived' }, { kind: 'waived', note: '' }, { kind: 'waived', note: '  ' }, { kind: 'waived', note: 'no' }, JSON.stringify({ kind: 'waived', amountCents: null, on: TODAY, reference: '', note: '' }),
      // with a booking and "Yes — email them" typed in: still nothing
      { kind: 'waived', package: 'send', booking: { date: '2027-01-12', time: '11:00', consultant: 'Shafoli Kapur', meetingType: 'Virtual', durationMin: 30 } }]) {
      await assert.rejects(record(w, value), refusedForReason, JSON.stringify(value));
    }
    assert.equal(w.reads.length, 0, 'the check runs before the lead is read');
    w.nothing('refused');
  } finally { w.done(); }
  // the same with the package switch on for everyone: the reason is asked first, nothing runs
  const before = process.env.CONSULT_PACKAGE_ON_RECORD, auto = process.env.CONSULT_PACKAGE_AUTO_SEND;
  process.env.CONSULT_PACKAGE_ON_RECORD = '1'; process.env.CONSULT_PACKAGE_AUTO_SEND = '1';
  const w2 = world({ lead: { email: 'client@example.test' } });
  try {
    await assert.rejects(record(w2, { kind: 'waived', package: 'send', booking: { date: '2027-01-12', time: '11:00', consultant: 'Shafoli Kapur', meetingType: 'Virtual', durationMin: 30 } }), refusedForReason);
    w2.nothing('switch on');
  } finally {
    w2.done();
    if (before === undefined) delete process.env.CONSULT_PACKAGE_ON_RECORD; else process.env.CONSULT_PACKAGE_ON_RECORD = before;
    if (auto === undefined) delete process.env.CONSULT_PACKAGE_AUTO_SEND; else process.env.CONSULT_PACKAGE_AUTO_SEND = auto;
  }
});

test('apply: waived WITH a reason stores it as the record\'s note, and the lead\'s update reads "… · reason: <text>" (escaped)', async () => {
  const w = world();
  try {
    const r = await record(w, { kind: 'waived', note: '  family of an   existing client ' });
    assert.equal(r.message, 'Recorded — the consultation fee is waived.');
    assert.equal(w.writes.length, 1);
    assert.deepEqual(Object.keys(w.writes[0].fields), ['consultPayment'], 'only the payment column — no new column');
    const stored = JSON.parse(w.writes[0].fields.consultPayment);
    assert.deepEqual({ ...stored, at: undefined, on: undefined }, { kind: 'waived', amountCents: 0, hstCents: 0, on: undefined, reference: '', note: 'family of an existing client', by: 'Staff One', at: undefined, verified: true }, 'today\'s record shape: the reason is the note');
    assert.equal(w.notes.length, 1);
    assert.match(w.notes[0], /^🧑‍💼 <b>\[Consultant portal\]<\/b> 🆓 Consultation fee waived — Waived on \d{4}-\d{2}-\d{2} by Staff One · reason: family of an existing client\. A record only/);
    // the lead page line ("Recorded: …") and the fee card read the same record
    assert.match(cp.describe(cp.paidState(w.state.lead).record), / · reason: family of an existing client$/);
    assert.equal(cp.paidState(w.state.lead).note, 'family of an existing client');
  } finally { w.done(); }
  const w2 = world({ signedIn: false });
  try {
    await record(w2, { kind: 'waived', note: 'a <b>bold</b> & "quoted" reason' }, { staffName: 'Typed Name' });
    assert.match(w2.notes[0], /by Typed Name \(name as typed\) · reason: a &lt;b&gt;bold&lt;\/b&gt; &amp; "quoted" reason\./, 'escaped in the Monday update; a typed name is still allowed and marked (no sign-in rule in this build)');
    assert.ok(!w2.notes[0].includes('<b>bold'));
    assert.equal(JSON.parse(w2.writes[0].fields.consultPayment).note, 'a <b>bold</b> & "quoted" reason', 'stored as typed');
  } finally { w2.done(); }
});

test('an OLD waived record with no reason: saving it again as Waived needs a reason; changing it to Cash does not; "Remove record" works and its update has no reason part', async () => {
  const old = { consultPayment: JSON.stringify({ kind: 'waived', amountCents: 0, on: '2026-10-01', by: 'Staff One', verified: true, at: '2026-10-01T15:00:00Z' }) };
  let w = world({ lead: old });
  try {
    await assert.rejects(record(w, { kind: 'waived', on: '2026-10-02' }), refusedForReason, 'not even to change the date');
    w.nothing('re-save without a reason');
    assert.equal(w.state.lead.consultPayment, old.consultPayment, 'the old record is as it was');
    const r = await record(w, { kind: 'waived', on: '2026-10-02', note: 'existing client' });
    assert.equal(r.ok, true);
    assert.match(w.notes[0], / · reason: existing client\. Replaces: Waived on 2026-10-01 by Staff One\. /, 'the replaced (old) record is described with no reason part');
  } finally { w.done(); }
  w = world({ lead: old });
  try {
    const r = await record(w, { kind: 'cash', amountCents: 20000, on: '2026-10-02' });
    assert.match(r.message, /^Recorded — Cash \$200\.00 received 2026-10-02\. The earlier record was replaced\./);
    assert.equal(JSON.parse(w.writes[0].fields.consultPayment).note, '');
  } finally { w.done(); }
  w = world({ lead: old });
  try {
    const r = await record(w, { kind: 'clear' });
    assert.deepEqual(r, { ok: true, message: 'The consultation payment record was removed.', consultPayment: null });
    assert.deepEqual(w.writes[0], { id: '555', fields: { consultPayment: '' }, opts: { clearKeys: ['consultPayment'] } });
    assert.match(w.notes[0], /🗑 Consultation fee record removed by Staff One — was: Waived on 2026-10-01 by Staff One\.$/);
  } finally { w.done(); }
  // a waiver WITH a reason, removed: the update keeps the reason
  w = world({ lead: { consultPayment: JSON.stringify({ kind: 'waived', amountCents: 0, on: '2026-11-20', by: 'Staff One', verified: true, note: 'entered on the wrong client' }) } });
  try {
    await record(w, { kind: 'clear' });
    assert.match(w.notes[0], /was: Waived on 2026-11-20 by Staff One · reason: entered on the wrong client\.$/);
  } finally { w.done(); }
  // a paid record changed to Waived: whatever is in the box becomes the reason
  w = world({ lead: { consultPayment: JSON.stringify({ kind: 'cash', amountCents: 20000, hstCents: 2600, on: '2026-11-19', by: 'Staff Two', verified: true, note: 'till 3' }) } });
  try {
    await assert.rejects(record(w, { kind: 'waived' }), refusedForReason);
    await record(w, { kind: 'waived', note: 'till 3' });
    assert.match(w.notes[0], /Waived on \d{4}-\d{2}-\d{2} by Staff One · reason: till 3\. Replaces: Cash \$200\.00 received 2026-11-19 by Staff Two · note: till 3\./);
  } finally { w.done(); }
});

test('order of refusals on a lead PAID THROUGH THE BOOKING LINK: waived with a reason gets the booking-link words; waived with NO reason gets the reason words first (the check runs before the lead is read) — a known behaviour', async () => {
  const w = world({ lead: { squareConsultTxnId: 'SQ9', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 }) } });
  try {
    await assert.rejects(record(w, { kind: 'waived', note: 'agreed by phone' }), (e) => e.badRequest && /paid through the booking link \(\$226\.00 incl\. HST\) — there is nothing to record here\. A refund is done in Square\./.test(e.message));
    await assert.rejects(record(w, { kind: 'waived' }), refusedForReason);
    await assert.rejects(record(w, { kind: 'clear' }), (e) => e.badRequest && /paid through the booking link/.test(e.message), 'the booking-link payment still refuses a removal');
    assert.equal(w.writes.length, 0); assert.equal(w.notes.length, 0);
  } finally { w.done(); }
});

/* ── where the reason is seen: the two lists (hover text only) and the fee card ── */

const scriptsOf = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
function pickFn(js, name) { const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let depth = 0, j = js.indexOf('{', i); for (; j < js.length; j++) { if (js[j] === '{') depth++; else if (js[j] === '}' && --depth === 0) break; } return js.slice(i, j + 1); }
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('list rows: consultRow and retainerRow carry paidNote on WAIVED rows only — never on a paid, an app-paid or an unpaid row; still no email or phone', async () => {
  snap._reset();
  const pay = (o) => JSON.stringify({ amountCents: 0, on: '2026-11-18', by: 'Staff One', verified: true, ...o });
  const rows = [
    { id: '1', name: 'A', fullName: 'A', email: 'a@example.test', phone: '416-555-0142', bookingStatus: 'Booked', bookedSlot: '2026-12-20 11:00', consultPayment: pay({ kind: 'waived', note: 'family of an existing client' }) },
    { id: '2', name: 'B', fullName: 'B', bookingStatus: 'Booked', bookedSlot: '2026-12-21 11:00', consultPayment: pay({ kind: 'waived' }) },
    { id: '3', name: 'C', fullName: 'C', bookingStatus: 'Booked', bookedSlot: '2026-12-22 11:00', consultPayment: pay({ kind: 'cash', amountCents: 20000, note: 'paid at the desk' }) },
    { id: '4', name: 'D', fullName: 'D', bookingStatus: 'Booked', bookedSlot: '2026-12-23 11:00' },
    { id: '5', name: 'E', fullName: 'E', bookingStatus: 'Booked', bookedSlot: '2026-12-24 11:00', squareConsultTxnId: 'SQ1', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 }), consultPayment: pay({ kind: 'waived', note: 'outranked by the app payment' }) },
    // the Retainers & follow-ups list (an outcome is set)
    { id: '6', name: 'F', fullName: 'F', bookingStatus: 'Booked', bookedSlot: '2026-11-02 11:00', outcome: 'Follow-Up', consultPayment: pay({ kind: 'waived', note: 'returning client' }) },
    { id: '7', name: 'G', fullName: 'G', bookingStatus: 'Booked', bookedSlot: '2026-11-03 11:00', outcome: 'Follow-Up', consultPayment: pay({ kind: 'waived' }) },
    { id: '8', name: 'H', fullName: 'H', bookingStatus: 'Booked', bookedSlot: '2026-11-04 11:00', outcome: 'Follow-Up', consultPayment: pay({ kind: 'e-transfer', amountCents: 20000, note: 'ref on file' }) },
    { id: '9', name: 'I', fullName: 'I', bookingStatus: 'Booked', bookedSlot: '2026-11-05 11:00', outcome: 'Follow-Up' },
  ];
  const dash = require('../src/services/dashboardService');
  const restore = [stub(snap.io, 'fetchLeads', async () => rows), stub(dash, 'fetchAllItems', async () => [])];
  try {
    const b = await portal.getConsultationsBoard({ now: new Date('2026-11-20T17:00:00Z'), withCompleted: true });
    const shape = (list) => list.map((r) => [r.id, r.paid, 'paidNote' in r ? r.paidNote : undefined]).sort();
    // the Consultations page's rows (consultRow): still to happen, and the completed ones
    assert.deepEqual(shape(b.consultations.concat(b.completed || [])),
      [['1', 'waived', 'family of an existing client'], ['2', 'waived', ''], ['3', 'cash', undefined], ['4', '', undefined], ['5', 'app', undefined],
        ['6', 'waived', 'returning client'], ['7', 'waived', ''], ['8', 'e-transfer', undefined], ['9', '', undefined]]);
    // the Retainers & follow-ups rows (retainerRow)
    assert.deepEqual(shape(b.retainers), [['6', 'waived', 'returning client'], ['7', 'waived', ''], ['8', 'e-transfer', undefined], ['9', '', undefined]]);
    const json = JSON.stringify(b);
    assert.ok(!json.includes('paid at the desk') && !json.includes('ref on file') && !json.includes('outranked by the app payment'), 'a paid record\'s note never rides along');
    assert.ok(!json.includes('example.test') && !json.includes('555-0142'), 'a list, not a record: no email, no phone');
  } finally { restore.forEach((r) => r()); snap._reset(); }
});

test('the "Waived" pill on both lists: the hover text ends with the reason, or "no reason recorded" for an older waiver; the reason is escaped; what the pill SHOWS, and every other pill, is as before', () => {
  for (const [page, html] of [['Consultations', C.buildQueueHTML()], ['Retainers', C.buildRetainersHTML()]]) {
    const js = scriptsOf(html)[0];
    const ctx = { escHtml };
    vm.createContext(ctx);
    vm.runInContext(js.match(/var PAID_LABELS=\{[^}]*\};/)[0] + '\n' + [pickFn(js, 'qpill'), pickFn(js, 'paidPill')].join('\n'), ctx);
    const pill = ctx.paidPill;
    assert.equal(pill({ paid: 'waived', paidCents: 0, paidBy: 'Staff One', paidOn: '2026-11-20', paidVerified: true, paidNote: 'family of an existing client' }),
      '<span class="pill grey" title="Waived · recorded by Staff One on 2026-11-20 · reason: family of an existing client">Waived</span>', page);
    assert.equal(pill({ paid: 'waived', paidCents: 0, paidBy: 'Staff One', paidOn: '2026-10-01', paidVerified: false, paidNote: '' }),
      '<span class="pill grey" title="Waived · recorded by Staff One (name as typed) on 2026-10-01 · no reason recorded">Waived</span>', page + ': an older waiver; a typed name is still marked');
    assert.equal(pill({ paid: 'waived', paidCents: 0 }), '<span class="pill grey" title="Waived · no reason recorded">Waived</span>', page + ': no name on the record');
    assert.equal(pill({ paid: 'waived', paidCents: 0, paidBy: 'S', paidVerified: true, paidNote: '<img src=x onerror=1> & "x"' }),
      '<span class="pill grey" title="Waived · recorded by S · reason: &lt;img src=x onerror=1&gt; &amp; &quot;x&quot;">Waived</span>', page + ': escaped');
    // every other pill: exactly as before — a paidNote on a row that is not waived is never shown
    assert.equal(pill({ paid: 'cash', paidCents: 20000, paidBy: 'Staff One', paidOn: '2026-11-20', paidVerified: true, paidNote: 'never shown' }), '<span class="pill green" title="Cash · recorded by Staff One on 2026-11-20">Cash $200</span>', page);
    assert.equal(pill({ paid: 'invoice', paidCents: 30000 }), '<span class="pill green" title="Invoice">Invoice $300</span>', page);
    assert.equal(pill({ paid: 'app', paidCents: 22600, paidNote: 'x' }), '<span class="pill green">Paid (app) $226</span>', page);
    assert.equal(pill({ paid: '', paidNote: 'x' }), '<span class="pill grey">—</span>', page);
    assert.ok(js.includes('function paidPill(c){'), page);
    // hover text only: no new column and no extra line in the row
    assert.equal(html.split('paidNote').length - 1, pickFn(js, 'paidPill').split('paidNote').length - 1, page + ': the reason is read in one place only, the pill');
  }
  // no change to the lists' columns or the Paid filter
  const S = require('../src/routes/listSpecs');
  assert.equal(require('fs').readFileSync(require.resolve('../src/routes/listSpecs'), 'utf8').includes('paidNote'), false, 'the list definitions do not know the reason');
  assert.ok(S.consultListSpec && S.retainerListOpts);
});

test('the "Consultation fee" card: a waived record shows "Reason" (or "Reason — not recorded" for an older one); a paid record keeps "Note", and no row when it has none', () => {
  const js = scriptsOf(C.buildDetailHTML('555')).pop();
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: {}, textContent: '', innerHTML: '' });
  const ctx = { escHtml, document: { getElementById: (id) => (['cp-body', 'cp-state', 'btn-cp-record', 'btn-cp-clear'].includes(id) ? el(id) : null) }, ICONS: { dollar: '$' }, Number, String };
  vm.createContext(ctx);
  vm.runInContext(js.match(/var CP_LABELS=\{[^}]*\};/)[0] + '\n' + ['kv', 'cpMoney', 'cpRecOn', 'hydrateConsultPayment'].map((n) => pickFn(js, n)).join('\n'), ctx);
  const card = (consultPayment) => { ctx.hydrateConsultPayment({ consultPayment }); return el('cp-body').innerHTML; };
  const row = (k, v) => '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
  let h = card({ paid: 'waived', paidCents: 0, on: '2026-11-20', by: 'Staff One', verified: true, reference: '', note: 'family of an <existing> client' });
  assert.equal(h, row('How', 'Waived') + row('Waived on', '2026-11-20') + row('Recorded by', 'Staff One') + row('Reason', 'family of an &lt;existing&gt; client'));
  assert.equal(el('cp-state').textContent, 'Waived');
  h = card({ paid: 'waived', paidCents: 0, on: '2026-10-01', by: 'Staff One', verified: false, reference: '', note: '' });
  assert.equal(h, row('How', 'Waived') + row('Waived on', '2026-10-01') + row('Recorded by', 'Staff One (name as typed)') + row('Reason', 'not recorded'), 'an older waiver: the row still shows');
  h = card({ paid: 'cash', paidCents: 20000, on: '2026-11-20', by: 'Staff One', verified: true, reference: 'till 3', note: 'paid at the desk' });
  assert.equal(h, row('How', 'Cash') + row('Fee received', '$200.00 (before HST)') + row('Received on', '2026-11-20') + row('Recorded by', 'Staff One') + row('Reference', 'till 3') + row('Note', 'paid at the desk'));
  h = card({ paid: 'cash', paidCents: 20000, on: '2026-11-20', by: 'Staff One', verified: true, reference: '', note: '' });
  assert.ok(!h.includes('Note') && !h.includes('Reason') && !h.includes('not recorded'), 'a paid record with no note: no row, as before');
  h = card({ paid: 'app', paidCents: 22600 });
  assert.ok(!h.includes('Reason') && !h.includes('not recorded'));
  h = card({ paid: '' });
  assert.ok(!h.includes('Reason') && !h.includes('not recorded'));
});

/* ── the record box ("Record the consultation payment"), run from the emitted page script against a small fake page ── */

// The box itself is the page's own emitted code, run against a small fake page (test/helpers/consultRecordBox.js).
const { recordBox } = require('./helpers/consultRecordBox');
const NEW_DETAIL = { name: 'Test Client', consultPayment: { paid: '', feeCents: 20000, onRecord: { enabled: false } } };

test('record box: "Waived — no fee" turns the one note box into "Reason the fee is waived *"; any other kind reads "Note (optional)"; the box keeps its id', () => {
  const b = recordBox({ detail: NEW_DETAIL }).open();
  assert.equal(b.q('#cp-kind').value, 'cash', 'a new record starts on Cash');
  assert.equal(b.label('cp-note-l'), 'Note (optional)');
  assert.deepEqual(b.q('#cp-kind').options.map((o) => o.text), ['Cash', 'E-transfer', 'Paid in Square (booked by the team, not the booking link)', 'Invoice sent by the team (not the booking link)', 'Other', 'Waived — no fee'], 'the six choices, as before');
  b.kind('waived');
  assert.equal(b.label('cp-note-l'), 'Reason the fee is waived *');
  assert.equal(b.q('#cp-amt-wrap').style.display, 'none', 'no amount for a waiver, as before');
  for (const k of ['cash', 'e-transfer', 'square', 'invoice', 'other']) { b.kind(k); assert.equal(b.label('cp-note-l'), 'Note (optional)', k); assert.equal(b.q('#cp-amt-wrap').style.display, '', k); }
  b.kind('waived');
  assert.equal(b.label('cp-note-l'), 'Reason the fee is waived *', 'and back');
  // one box, the same id; the old wording is gone
  assert.equal(b.box.innerHTML.split('id="cp-note"').length - 1, 1);
  assert.match(b.box.innerHTML, /<label for="cp-note" id="cp-note-l">Note <span class="paym-muted">\(optional\)<\/span><\/label><input id="cp-note" type="text" maxlength="200" autocomplete="off" value="">/);
  assert.ok(!C.buildDetailHTML('555').includes('why the fee was waived'), 'the old label is gone from the page');
});

test('record box: Record with "Waived" and no reason shows the words, keeps the box OPEN with what was typed and sends nothing; with a reason the request carries it as note', () => {
  const b = recordBox({ detail: NEW_DETAIL }).open();
  b.kind('waived');
  b.q('#cp-ref').value = 'R-77';
  for (const typed of ['', '  ', 'no', ' a ']) {
    b.q('#cp-note').value = typed;
    b.go();
    assert.equal(b.err(), 'Write the reason the fee is waived.', JSON.stringify(typed));
    assert.equal(b.box.focused, 'cp-note', 'the cursor goes to the box');
    assert.equal(b.dlg.closed, false, 'the box stays open');
    assert.equal(b.sent.length, 0, 'nothing is sent');
  }
  assert.equal(b.q('#cp-ref').value, 'R-77', 'what was typed is still there');
  b.q('#cp-note').value = '  family of an existing client ';
  b.go();
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].action, 'recordConsultPayment');
  assert.deepEqual({ ...b.sent[0].value, on: undefined }, { kind: 'waived', amountCents: null, on: undefined, reference: 'R-77', note: 'family of an existing client' });
  assert.equal(b.sent[0].by, 'Staff One');
  assert.equal(b.dlg.closed, true);
  // what the box sends passes the server rule
  assert.equal(cp.validateRecord(b.sent[0].value).ok, true);
});

test('record box: a paid kind still saves with an empty note (optional), and the amount is asked before the reason', () => {
  const b = recordBox({ detail: NEW_DETAIL }).open();
  b.go();
  assert.equal(b.sent.length, 1, 'cash with the pre-filled fee and no note');
  assert.deepEqual([b.sent[0].value.kind, b.sent[0].value.amountCents, b.sent[0].value.note], ['cash', 20000, '']);
  const b2 = recordBox({ detail: NEW_DETAIL }).open();
  b2.q('#cp-amt').value = '';
  b2.go();
  assert.equal(b2.err(), 'Enter the fee received, in dollars and cents.');
  assert.equal(b2.sent.length, 0);
});

test('record box: "Change record" on a waived record opens with its stored reason in the box; an OLD waiver with none must get one before it saves again; "Remove record" asks nothing', () => {
  const waived = (note) => ({ name: 'Test Client', consultPayment: { paid: 'waived', paidCents: 0, on: '2026-11-18', by: 'Staff Two', verified: true, reference: '', note, feeCents: 20000, onRecord: { enabled: false } } });
  const b = recordBox({ detail: waived('promised by "phone" <ok>') }).open();
  assert.equal(b.q('#cp-kind').value, 'waived');
  assert.equal(b.q('#cp-note').value, 'promised by "phone" <ok>', 'the stored reason, unescaped back into the box');
  assert.match(b.box.innerHTML, /id="cp-note" type="text" maxlength="200" autocomplete="off" value="promised by &quot;phone&quot; &lt;ok&gt;"/, 'escaped in the markup');
  assert.equal(b.label('cp-note-l'), 'Reason the fee is waived *');
  assert.equal(b.q('[data-go]').textContent, 'Save change');
  b.go();
  assert.equal(b.sent[0].value.note, 'promised by "phone" <ok>');

  const old = recordBox({ detail: waived('') }).open();
  assert.equal(old.q('#cp-note').value, '');
  old.q('#cp-on').value = '2026-11-17';
  old.go();
  assert.equal(old.err(), 'Write the reason the fee is waived.', 'an old waiver cannot be saved again as Waived without one');
  assert.equal(old.sent.length, 0);
  old.kind('cash'); old.q('#cp-amt').value = '200';
  old.go();
  assert.equal(old.sent.length, 1, 'changing it to a paid kind needs no reason');
  assert.equal(old.sent[0].value.kind, 'cash');

  const rm = recordBox({ detail: waived('') }).open(true);
  assert.equal(rm.q('#cp-note'), null, 'the remove box has no note box');
  rm.go();
  assert.deepEqual(rm.sent[0].value, { kind: 'clear' });
});

/* ── a known risk, pinned as a fact: the typed reason goes into a system update, and two jobs look for exact words there ── */

test('KNOWN RISK (not fixed in this build): a reason that contains a system phrase is read as that phrase by the outcome reminder and the Leads status', () => {
  const pcs = require('../src/services/postConsultService');
  const lss = require('../src/services/leadStatusService');
  const note = (reason) => `🧑‍💼 <b>[Consultant portal]</b> 🆓 Consultation fee waived — ${cp.describe({ kind: 'waived', amountCents: 0, on: '2026-11-20', by: 'Staff One', verified: true, note: reason })}. A record only — no email or automatic step runs from it.`;
  // a consultation that ended two hours ago, no outcome set
  const slot = (() => { const p = {}; for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() - 3 * 3600000))) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`; })();
  assert.equal(pcs.needsNudge({ bookedSlot: slot, outcome: '', updates: [note('family of an existing client')] }), true, 'an ordinary reason: the "set the outcome" reminder still goes');
  assert.equal(pcs.needsNudge({ bookedSlot: slot, outcome: '', updates: [note('Consultation held last week, second visit')] }), false, 'TODAY: the words "Consultation held" in a reason stop the reminder');
  assert.equal(lss.classify(note('family of an existing client')).kind, '', 'an ordinary reason is no marker');
  assert.equal(lss.classify(note('Booking invite emailed by mistake, client came in person')).kind, 'invite', 'TODAY: the words "Booking invite emailed" in a reason read as an invite');
});

/* ── every page still parses ── */

test('the four pages: every inline script parses after the pop-up edits; no stray template text reached the browser', () => {
  const L = require('../src/routes/adminLeads');
  const pages = [['consultations', C.buildQueueHTML()], ['retainers', C.buildRetainersHTML()], ['record', C.buildDetailHTML('12345')], ['record from retainers', C.buildDetailHTML('12345', { from: 'retainers' })]];
  const leadFn = L.buildLeadDetailHTML || L.buildLeadHTML || L.buildDetailHTML;
  assert.equal(typeof leadFn, 'function', 'the lead page builder');
  pages.push(['lead', leadFn('12345')]);
  for (const [name, html] of pages) {
    const scripts = scriptsOf(html);
    assert.ok(scripts.length >= 1, name);
    scripts.forEach((src, i) => { try { new vm.Script(src); } catch (e) { assert.fail(`${name} script #${i + 1}: ${e.message}`); } });
    assert.ok(!html.includes('${'), name + ': no unfilled template text');
  }
});
