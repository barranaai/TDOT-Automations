'use strict';

// Gauri point 4, part 2 (Faran 2026-10-15): a consultation fee settled OUTSIDE the
// booking link — cash, e-transfer, an invoice the team sent, another way, or waived —
// is recorded on the lead ("Record payment / Waived") in one text column, so the
// Consultations list and the KPIs count it. A record only: no email, no package, no
// booking step. A fee paid through the booking link cannot be overwritten here.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');

const cp          = require('../src/services/consultPaymentService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const portal      = require('../src/services/consultantPortalService');
const snap        = require('../src/services/leadSnapshot');
const { computeKpis } = require('../src/services/kpiService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const TODAY = '2026-10-15';

/* ── the column is wired everywhere a lead field must be ── */

test('wiring: the Consultation Payment column is mapped, typed as text, and part of the list snapshot', () => {
  assert.equal(require('../src/data/newLeadsBoard.json').columns.consultPayment, 'text_mm8533r9');
  assert.ok(snap.SNAPSHOT_KEYS.includes('consultPayment') && snap.SNAPSHOT_IDS.includes('text_mm8533r9'), 'the lists read it');
  const src = require('fs').readFileSync(require.resolve('../src/services/leadService'), 'utf8');
  assert.match(src, /consultPayment: 'text'/);
});

/* ── validation ── */

test('validate: the five kinds, the amount rules, the date rules, the caps; "clear" needs nothing else', () => {
  const v = (o) => cp.validateRecord(o, { today: TODAY });
  assert.deepEqual(v({ kind: 'cash', amountCents: 20000 }), { ok: true, normalized: { kind: 'cash', amountCents: 20000, on: TODAY, reference: '', note: '' } }, 'date defaults to today (Toronto)');
  assert.deepEqual(v(JSON.stringify({ kind: 'e-transfer', amountCents: 22600, on: '2026-10-14', reference: ' INT-123 ', note: ' paid  at the\n office ' })),
    { ok: true, normalized: { kind: 'e-transfer', amountCents: 22600, on: '2026-10-14', reference: 'INT-123', note: 'paid at the office' } }, 'a JSON string is accepted; spaces collapse');
  assert.deepEqual(v({ kind: 'waived', amountCents: 99999, note: 'referral' }), { ok: true, normalized: { kind: 'waived', amountCents: 0, on: TODAY, reference: '', note: 'referral' } }, 'waived never carries an amount');
  assert.deepEqual(v({ kind: 'clear' }), { ok: true, normalized: { kind: 'clear' } });
  for (const bad of [null, 'nope', '{', { kind: 'paypal', amountCents: 100 }, { kind: '' }]) assert.equal(v(bad).ok, false, JSON.stringify(bad));
  // review 2026-10-15: a kind is an OWN key of the five — Object.prototype names are not kinds
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'Cash', 'CASH']) {
    assert.equal(v({ kind: k, amountCents: 100 }).ok, false, `kind ${k}`);
    assert.equal(cp.paidState({ consultPayment: JSON.stringify({ kind: k, amountCents: 100, on: '2026-10-01' }) }).paid, '', `stored kind ${k}`);
  }
  assert.equal(v({ kind: ' cash ', amountCents: 100 }).normalized.kind, 'cash', 'the page value is trimmed, never case-folded');
  for (const a of [undefined, null, 0, -5, 1.5, 2000001, NaN, true, [200], '0x10', '1e2', '20.5', '']) {
    const r = v({ kind: 'cash', amountCents: a });
    assert.equal(r.ok, false, `amount ${JSON.stringify(a)}`); assert.match(r.error, /fee received/i);
  }
  assert.equal(v({ kind: 'cash', amountCents: ' 200 ' }).normalized.amountCents, 200, 'a digit string from a form is fine');
  assert.match(v({ kind: 'cash', amountCents: 100, on: '2026-10-16' }).error, /future/);
  assert.match(v({ kind: 'cash', amountCents: 100, on: '2026-02-30' }).error, /YYYY-MM-DD/);
  assert.match(v({ kind: 'cash', amountCents: 100, on: '15/10/2026' }).error, /YYYY-MM-DD/);
  assert.match(v({ kind: 'cash', amountCents: 100, on: '2019-12-31' }).error, /before 2020/);
  assert.match(v({ kind: 'cash', amountCents: 100, note: 'x'.repeat(201) }).error, /note under 200/);
  assert.match(v({ kind: 'cash', amountCents: 100, reference: 'x'.repeat(121) }).error, /reference under 120/);
  assert.equal(cp.validateRecord({ kind: 'cash', amountCents: 100 }).normalized.on, cp.torontoToday(), 'the default day is Toronto today');
  assert.deepEqual(portal.validateAction('recordConsultPayment', { kind: 'other', amountCents: 5000, on: '2026-01-02' }), { ok: true, normalized: { kind: 'other', amountCents: 5000, on: '2026-01-02', reference: '', note: '' } }, 'reachable as a portal action');
});

/* ── reading the record ── */

test('paidState: the booking-link payment outranks a staff record; a staff record reads back; blank, legacy and corrupt cells are "not paid"', () => {
  const rec = { kind: 'cash', amountCents: 20000, on: '2026-10-14', reference: 'r', note: 'n', by: 'Melanie', at: '2026-10-14T15:00:00Z', verified: false };
  const app = cp.paidState({ squareConsultTxnId: 'SQ1', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 }), consultPayment: JSON.stringify(rec) });
  assert.equal(app.paid, 'app'); assert.equal(app.paidCents, 22600); assert.equal(app.feeCents, 20000); assert.equal(app.verified, true);
  assert.equal(app.record.kind, 'cash', 'the outranked record is still visible');
  const staff = cp.paidState({ consultPayment: JSON.stringify(rec), consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000 }) });
  assert.deepEqual({ paid: staff.paid, paidCents: staff.paidCents, on: staff.on, by: staff.by, verified: staff.verified, reference: staff.reference, note: staff.note, feeCents: staff.feeCents },
    { paid: 'cash', paidCents: 20000, on: '2026-10-14', by: 'Melanie', verified: false, reference: 'r', note: 'n', feeCents: 20000 });
  const waived = cp.paidState({ consultPayment: JSON.stringify({ kind: 'waived', amountCents: 0, on: '2026-10-01', by: 'Gauri Berde', verified: true }) });
  assert.equal(waived.paid, 'waived'); assert.equal(waived.paidCents, 0); assert.equal(waived.verified, true);
  for (const cell of ['', undefined, 'paid', '{"kind":"paypal"}', '[]', 'null', '42']) {
    const s = cp.paidState({ consultPayment: cell });
    assert.equal(s.paid, '', `cell ${JSON.stringify(cell)}`); assert.equal(s.record, null);
  }
  // A hand-edited record with a kind but no usable amount: the fee WAS recorded as paid — the amount is just unknown (shown as such), never "not paid".
  const odd = cp.paidState({ consultPayment: '{"kind":"cash","amountCents":"x","on":"2026-10-01","by":"Melanie"}' });
  assert.equal(odd.paid, 'cash'); assert.equal(odd.paidCents, null);
  assert.equal(cp.describe(odd.record), 'Cash (amount not recorded) received 2026-10-01 by Melanie (name as typed)');
  assert.equal(cp.describe(rec), 'Cash $200.00 received 2026-10-14 by Melanie (name as typed) · ref r · note: n');
  assert.equal(cp.describe({ kind: 'waived', amountCents: 0, on: '2026-10-01', by: 'Gauri Berde', verified: true, reference: '', note: 'referral' }), 'Waived on 2026-10-01 by Gauri Berde · note: referral');
});

/* ── the action ── */

function world({ lead, signedIn = false } = {}) {
  const writes = [], notes = [];
  const state = { lead: { id: '555', fullName: 'Test Client', ...lead } };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...state.lead })),
    stub(leadService, 'updateLead', async (id, fields, opts) => { writes.push({ id, fields, opts }); Object.assign(state.lead, fields); }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.b); return {}; }),
  ];
  const actor = signedIn ? { name: 'Gauri Berde', email: 'g@tdotimm.com', verified: true } : { name: 'Unidentified (shared admin key)', email: '', verified: false };
  return { writes, notes, state, actor, done: () => restore.reverse().forEach((r) => r()) };
}

test('apply: writes ONE text column as JSON naming who recorded it, posts a note, changes nothing else; a typed name is marked as typed', async () => {
  const w = world({ lead: { consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000 }) } });
  try {
    const r = await portal.applyAction({ leadId: '555', action: 'recordConsultPayment', value: { kind: 'cash', amountCents: 20000, on: '2026-10-14', reference: 'till 3', note: '' }, staffName: 'Melanie', actor: { name: 'Melanie', email: '', verified: false } });
    assert.equal(r.ok, true);
    assert.equal(r.message, 'Recorded — Cash $200.00 received 2026-10-14. The consultation agreement states $226.00 incl. HST.');
    assert.equal(w.writes.length, 1);
    assert.deepEqual(Object.keys(w.writes[0].fields), ['consultPayment'], 'only the payment column');
    const stored = JSON.parse(w.writes[0].fields.consultPayment);
    assert.deepEqual({ ...stored, at: undefined }, { kind: 'cash', amountCents: 20000, hstCents: 2600, on: '2026-10-14', reference: 'till 3', note: '', by: 'Melanie', verified: false, at: undefined }, 'the HST is fixed at record time');
    assert.ok(!Number.isNaN(Date.parse(stored.at)), 'stamped');
    assert.equal(w.notes.length, 1);
    assert.match(w.notes[0], /💳 Consultation fee recorded as paid — Cash \$200\.00 received 2026-10-14 by Melanie \(name as typed\) · ref till 3\./);
    assert.match(w.notes[0], /A record only — no email or automatic step runs from it/);
    assert.ok(!/Replaces/.test(w.notes[0]));
    // the list and the detail read it back
    assert.equal(cp.paidState(w.state.lead).paid, 'cash');
  } finally { w.done(); }
});

test('apply: a signed-in staff member is recorded by their Monday name (verified); a second record REPLACES the first and the note says what it replaced', async () => {
  const w = world({ lead: { consultPayment: JSON.stringify({ kind: 'cash', amountCents: 20000, on: '2026-10-14', by: 'Melanie', verified: false, at: '2026-10-14T15:00:00Z' }) }, signedIn: true });
  try {
    const r = await portal.applyAction({ leadId: '555', action: 'recordConsultPayment', value: JSON.stringify({ kind: 'e-transfer', amountCents: 20000, on: '2026-10-14', reference: 'C1A2B3' }), staffName: 'Someone Else', actor: w.actor });
    assert.match(r.message, /^Recorded — E-transfer \$200\.00 received 2026-10-14\. The earlier record was replaced\. The consultation agreement states \$226\.00 incl\. HST\.$/);
    const stored = JSON.parse(w.writes[0].fields.consultPayment);
    assert.equal(stored.by, 'Gauri Berde', 'the Monday identity, never the typed name'); assert.equal(stored.verified, true);
    assert.match(w.notes[0], /by Gauri Berde · ref C1A2B3\. Replaces: Cash \$200\.00 received 2026-10-14 by Melanie \(name as typed\)\./);
    assert.ok(!/Gauri Berde \(name as typed\)/.test(w.notes[0]));
  } finally { w.done(); }
});

test('apply: waived — no amount, 🆓 note; "clear" empties the column (a real clear, not a typed empty) and notes what was there', async () => {
  const w = world({ signedIn: true });
  try {
    const r1 = await portal.applyAction({ leadId: '555', action: 'recordConsultPayment', value: { kind: 'waived', note: 'referred by an existing client' }, actor: w.actor });
    assert.equal(r1.message, 'Recorded — the consultation fee is waived.');
    assert.equal(JSON.parse(w.writes[0].fields.consultPayment).amountCents, 0);
    assert.match(w.notes[0], /^🧑‍💼 <b>\[Consultant portal\]<\/b> 🆓 Consultation fee waived — Waived on \d{4}-\d{2}-\d{2} by Gauri Berde · note: referred by an existing client\./);
    const r2 = await portal.applyAction({ leadId: '555', action: 'recordConsultPayment', value: { kind: 'clear' }, actor: w.actor });
    assert.deepEqual(r2, { ok: true, message: 'The consultation payment record was removed.', consultPayment: null });
    assert.deepEqual(w.writes[1], { id: '555', fields: { consultPayment: '' }, opts: { clearKeys: ['consultPayment'] } });
    assert.match(w.notes[1], /🗑 Consultation fee record removed by Gauri Berde — was: Waived on \d{4}-\d{2}-\d{2} by Gauri Berde · note: referred by an existing client\./);
    assert.equal(cp.paidState(w.state.lead).paid, '');
    await assert.rejects(portal.applyAction({ leadId: '555', action: 'recordConsultPayment', value: { kind: 'clear' }, actor: w.actor }), (e) => e.badRequest && /No consultation payment is recorded/.test(e.message));
    assert.equal(w.writes.length, 2, 'a refused clear writes nothing');
  } finally { w.done(); }
});

test('apply: REFUSED when the fee was paid through the booking link (every kind, clear too); REFUSED with no name; nothing is written either way', async () => {
  const w = world({ lead: { squareConsultTxnId: 'SQ9', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 }) }, signedIn: true });
  try {
    for (const value of [{ kind: 'cash', amountCents: 20000 }, { kind: 'waived' }, { kind: 'clear' }]) {
      await assert.rejects(portal.applyAction({ leadId: '555', action: 'recordConsultPayment', value, actor: w.actor }),
        (e) => e.badRequest && /paid through the booking link \(\$226\.00 incl\. HST\) — there is nothing to record here\. A refund is done in Square\./.test(e.message), JSON.stringify(value));
    }
    assert.equal(w.writes.length, 0); assert.equal(w.notes.length, 0);
  } finally { w.done(); }
  const w2 = world();
  try {
    await assert.rejects(portal.applyAction({ leadId: '555', action: 'recordConsultPayment', value: { kind: 'cash', amountCents: 100 }, staffName: '', actor: w2.actor }),
      (e) => e.badRequest && /Enter your name/.test(e.message), 'the shared key alone names nobody');
    await assert.rejects(portal.applyAction({ leadId: '555', action: 'recordConsultPayment', value: { kind: 'cash', amountCents: 0 }, staffName: 'Melanie', actor: { name: 'Melanie', verified: false } }),
      (e) => e.badRequest && /fee received/i.test(e.message), 'validation runs before any read');
    assert.equal(w2.writes.length, 0);
  } finally { w2.done(); }
});

/* ── the list, the detail, the KPIs ── */

test('list: paid reads app | kind | blank with the amount, who and when; the detail payload carries the record and the booking fee', async () => {
  snap._reset();
  const rows = [
    { id: '1', name: 'A', fullName: 'A', bookingStatus: 'Booked', bookedSlot: '2026-10-20 11:00', squareConsultTxnId: 'SQ1', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 }) },
    { id: '2', name: 'B', fullName: 'B', bookingStatus: 'Booked', bookedSlot: '2026-10-21 11:00', consultPayment: JSON.stringify({ kind: 'cash', amountCents: 20000, on: '2026-10-14', by: 'Melanie', verified: false }) },
    { id: '3', name: 'C', fullName: 'C', bookingStatus: 'Booked', bookedSlot: '2026-10-22 11:00', consultPayment: JSON.stringify({ kind: 'waived', amountCents: 0, on: '2026-10-01', by: 'Gauri Berde', verified: true }) },
    { id: '4', name: 'D', fullName: 'D', bookingStatus: 'Booked', bookedSlot: '2026-10-23 11:00' },
  ];
  const restore = [stub(snap.io, 'fetchLeads', async () => rows)];
  try {
    const b = await portal.getConsultationsBoard();
    assert.deepEqual(b.consultations.map((r) => [r.id, r.paid, r.paidCents, r.paidBy, r.paidOn, r.paidVerified]),
      [['1', 'app', 22600, '', '', true], ['2', 'cash', 20000, 'Melanie', '2026-10-14', false], ['3', 'waived', 0, 'Gauri Berde', '2026-10-01', true], ['4', '', null, '', '', false]]);
  } finally { restore.forEach((r) => r()); snap._reset(); }

  const r2 = [stub(leadService, 'getLead', async () => ({ id: '2', fullName: 'B', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000 }), consultPayment: rows[1].consultPayment }))];
  try {
    const d = await portal.getConsultationDetail('2');
    assert.deepEqual(d.consultPayment, { paid: 'cash', paidCents: 20000, on: '2026-10-14', by: 'Melanie', verified: false, reference: '', note: '', at: '', feeCents: 20000, alsoRecorded: '' });
  } finally { r2.forEach((r) => r()); }
  const r3 = [stub(leadService, 'getLead', async () => ({ id: '1', fullName: 'A', squareConsultTxnId: 'SQ1', consultOption: rows[0].consultOption, consultPayment: rows[1].consultPayment }))];
  try {
    const d = await portal.getConsultationDetail('1');
    assert.equal(d.consultPayment.paid, 'app'); assert.equal(d.consultPayment.paidCents, 22600);
    assert.equal(d.consultPayment.alsoRecorded, 'Cash $200.00 received 2026-10-14 by Melanie (name as typed)', 'an outranked staff record is still shown');
  } finally { r3.forEach((r) => r()); }
});

test('KPIs: revenue = booking-link fees + staff-recorded fees (before HST); waived counts, adds nothing; the app payment is unchanged', () => {
  const leads = [
    { bookedSlot: '2026-10-10 10:00', squareConsultTxnId: 't1', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 }), createdAt: '2026-10-01T10:00:00Z' },
    { bookedSlot: '2026-10-11 10:00', consultPayment: JSON.stringify({ kind: 'cash', amountCents: 15000, on: '2026-10-11', by: 'Melanie' }), createdAt: '2026-10-01T10:00:00Z' },
    { bookedSlot: '2026-10-12 10:00', consultPayment: JSON.stringify({ kind: 'waived', amountCents: 0, on: '2026-10-12', by: 'Gauri Berde', verified: true }), createdAt: '2026-10-01T10:00:00Z' },
    { bookedSlot: '2026-10-13 10:00', createdAt: '2026-10-01T10:00:00Z' },
    { bookedSlot: '2026-09-13 10:00', consultPayment: JSON.stringify({ kind: 'e-transfer', amountCents: 20000, on: '2026-09-13', by: 'Melanie' }), createdAt: '2026-09-01T10:00:00Z' },
  ];
  const k = computeKpis(leads, '2026-10');
  assert.equal(k.consultations.booked, 4);
  assert.equal(k.consultations.revenue, 350);          // 200 (app, fee before HST) + 150 (cash)
  assert.equal(k.consultations.paidByStaff, 1);
  assert.equal(k.consultations.waived, 1);
  const all = computeKpis(leads, '');
  assert.equal(all.consultations.revenue, 550);
  assert.equal(all.consultations.paidByStaff, 2);
  // review 2026-10-15: a hand-booked consultation with NO booked time (the "No date" list) counts in the month the fee was received — it was never counted
  const noDate = [
    { bookingStatus: 'Booked', consultPayment: JSON.stringify({ kind: 'cash', amountCents: 20000, on: '2026-10-11', by: 'Melanie' }), createdAt: '2026-09-01T10:00:00Z' },
    { bookingStatus: 'Booked', consultPayment: JSON.stringify({ kind: 'waived', amountCents: 0, on: '2026-09-02', by: 'Gauri Berde', verified: true }), createdAt: '2026-09-01T10:00:00Z' },
    { bookingStatus: 'Booked', squareConsultTxnId: 't9', createdAt: '2026-09-01T10:00:00Z' },   // app-paid with no slot: unchanged (not counted — the app's own payment always carries a slot)
  ];
  const oct = computeKpis(noDate, '2026-10'), sep = computeKpis(noDate, '2026-09'), ever = computeKpis(noDate, '');
  assert.deepEqual([oct.consultations.revenue, oct.consultations.paidByStaff, oct.consultations.waived, oct.consultations.booked], [200, 1, 0, 0]);
  assert.deepEqual([sep.consultations.revenue, sep.consultations.paidByStaff, sep.consultations.waived], [0, 0, 1]);
  assert.deepEqual([ever.consultations.revenue, ever.consultations.paidByStaff, ever.consultations.waived], [200, 1, 1]);
  // a dated consultation paid by staff in a different month counts in the CONSULTATION's month, as before
  const m = computeKpis([{ bookedSlot: '2026-10-20 10:00', consultPayment: JSON.stringify({ kind: 'cash', amountCents: 20000, on: '2026-09-30', by: 'Melanie' }), createdAt: '2026-09-01T10:00:00Z' }], '2026-10');
  assert.deepEqual([m.consultations.revenue, m.consultations.paidByStaff], [200, 1]);
});

/* ── the pages ── */

test('pages: the Paid filter has the new choices, the row pill reads the kind, the detail page has the card, the dialog and the handlers; every script parses; the inline-JS rules hold', () => {
  const { buildQueueHTML, buildDetailHTML } = require('../src/routes/adminConsultation');
  const q = buildQueueHTML(), d = buildDetailHTML('555');
  for (const html of [q, d]) for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
  for (const s of ['<option value="paid">Paid (any way)</option>', '<option value="app">Paid (app)</option>', '<option value="staff">Paid — recorded by staff</option>', '<option value="waived">Waived</option>', '<option value="none">Not paid</option>',
    'function paidPill(c){', "(c.paidVerified?'':' (name as typed)')", "if(paid==='staff' && !(r.paid && r.paid!=='app' && r.paid!=='waived')) return false;", "if(paid==='none' && r.paid) return false;",
    "' recorded by staff'", "' waived'"]) assert.ok(q.includes(s), s);
  assert.ok(!q.includes('Not paid via app'), 'the old wording is gone');
  for (const s of ['id="cp-state"', 'id="cp-body"', 'id="btn-cp-record"', 'id="btn-cp-clear"', 'function hydrateConsultPayment(d){', 'function openConsultPaymentModal(d, clear){',
    "doAction('recordConsultPayment', JSON.stringify(payload), null, by);", 'hydrateConsultPayment(d);',
    "document.getElementById('btn-cp-record').onclick=function(){ openConsultPaymentModal(LAST_DETAIL||{}, false); };",
    "document.getElementById('btn-cp-clear').onclick=function(){ openConsultPaymentModal(LAST_DETAIL||{}, true); };",
    'A refund is done in Square.', 'before HST']) assert.ok(d.includes(s), s);
  // the detail script defines the dialog AFTER the shared payment helpers it uses
  const script = d.slice(d.lastIndexOf('<script>'));
  assert.ok(script.indexOf('function payOverlay(){') < script.indexOf('function openConsultPaymentModal('), 'payOverlay is defined first');
  assert.ok(script.indexOf('function tdotPayViewer(cb){') < script.indexOf('function openConsultPaymentModal('), 'tdotPayViewer is defined first');
});
