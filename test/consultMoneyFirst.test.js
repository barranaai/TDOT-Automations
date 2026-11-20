'use strict';

// Money first (Gauri B4 + the B2 suggestion; Faran 2026-11-20) — ONE switch, CONSULT_MONEY_FIRST (unset = off).
// This file: the switch itself, and "an invoice is recorded only once it has been paid" (the server rule in
// validateRecord with the switch HANDED IN, and the record box's tick).
// The other half — "＋ Direct consultation": who may be saved "Not paid yet" — is tested with that pop-up's own
// harnesses (test/directConsultServer.test.js and test/directConsultPages.test.js).
// Switched off, the app is exactly what it was before (the required waiver reason included): proven here too.
// Every test sets or deletes the switch itself — nothing depends on the machine's environment.
// Made-up people only; every Monday / mail seam is stubbed (the no-network guard backs it).

const test   = require('node:test');
const assert = require('node:assert/strict');

const cp          = require('../src/services/consultPaymentService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const portal      = require('../src/services/consultantPortalService');
const consultSvc  = require('../src/services/consultationService');
const meeting     = require('../src/services/meetingService');
const C           = require('../src/routes/adminConsultation');
const { recordBox, scriptsOf } = require('./helpers/consultRecordBox');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
/** Run with the switch set to `value` (undefined = unset), then put the environment back. */
async function withSwitch(value, fn) {
  const before = process.env.CONSULT_MONEY_FIRST;
  if (value === undefined) delete process.env.CONSULT_MONEY_FIRST; else process.env.CONSULT_MONEY_FIRST = value;
  try { return await fn(); } finally { if (before === undefined) delete process.env.CONSULT_MONEY_FIRST; else process.env.CONSULT_MONEY_FIRST = before; }
}
delete process.env.CONSULT_PACKAGE_ON_RECORD;
delete process.env.CONSULT_MONEY_FIRST;
const TODAY = '2026-11-20';
const TICK_ERROR = 'Tick “The invoice has been paid”. An invoice that is only sent is not recorded — record it when the money is in. Nothing was saved. If you cannot see the tick, reload the page first.';

/* ── the switch ── */

test('the switch: CONSULT_MONEY_FIRST unset = off; only 1 / true / on / yes turn it on', async () => {
  await withSwitch(undefined, () => assert.equal(cp.moneyFirstEnabled(), false, 'unset'));
  for (const v of ['', ' ', '0', 'false', 'off', 'no', 'maybe', '2', 'faran@example.test', '1,2']) await withSwitch(v, () => assert.equal(cp.moneyFirstEnabled(), false, JSON.stringify(v)));
  for (const v of ['1', 'true', 'TRUE', 'on', 'On', 'yes', ' 1 ']) await withSwitch(v, () => assert.equal(cp.moneyFirstEnabled(), true, JSON.stringify(v)));
  // read at use, never cached: flipping it needs no restart of the reader
  await withSwitch('1', async () => { assert.equal(cp.moneyFirstEnabled(), true); delete process.env.CONSULT_MONEY_FIRST; assert.equal(cp.moneyFirstEnabled(), false); });
});

/* ── the server rule: validateRecord, the switch handed in ── */

test('validateRecord, switch handed in as ON: "invoice" needs invoicePaid === true — the exact words; nothing new is kept; every other kind is as before', () => {
  const on = (o) => cp.validateRecord(o, { today: TODAY, moneyFirst: true });
  assert.equal(cp.INVOICE_TICK_ERROR, TICK_ERROR);
  // these words reach a page loaded before the switch was turned on, which has no tick: they must say what to do
  assert.ok(cp.INVOICE_TICK_ERROR.endsWith(' Nothing was saved. If you cannot see the tick, reload the page first.'));
  assert.deepEqual(on({ kind: 'invoice', amountCents: 30000 }), { ok: false, error: TICK_ERROR }, 'no tick (also what a page left open from before sends)');
  for (const tick of [false, null, undefined, 'true', 'yes', 1, 'on', {}, []]) assert.deepEqual(on({ kind: 'invoice', amountCents: 30000, invoicePaid: tick }), { ok: false, error: TICK_ERROR }, 'not a real tick: ' + JSON.stringify(tick));
  assert.deepEqual(on(JSON.stringify({ kind: 'invoice', amountCents: 30000, on: TODAY, reference: 'INV-9', note: '' })), { ok: false, error: TICK_ERROR }, 'as the record box posts it');
  // with the tick: accepted — and what may be written has exactly today's fields (the tick is not stored)
  const ok = on({ kind: 'invoice', amountCents: 30000, on: '2026-11-19', reference: 'INV-9', note: 'paid by card', invoicePaid: true });
  assert.deepEqual(ok, { ok: true, normalized: { kind: 'invoice', amountCents: 30000, on: '2026-11-19', reference: 'INV-9', note: 'paid by card', package: '', packageNote: '', booking: null } });
  assert.deepEqual(on(JSON.stringify({ kind: 'invoice', amountCents: 30000, invoicePaid: true })).ok, true, 'a JSON string with the tick');
  // the other checks of an invoice record still speak first (a bad amount or date is fixed before the tick is asked)
  assert.match(on({ kind: 'invoice', amountCents: 0 }).error, /Enter the fee received/);
  assert.match(on({ kind: 'invoice', amountCents: 30000, on: '2099-01-01' }).error, /cannot be in the future/);
  // every other kind: the tick is not asked, and a stray tick changes nothing
  for (const kind of ['cash', 'e-transfer', 'square', 'other']) {
    assert.deepEqual(on({ kind, amountCents: 20000 }), cp.validateRecord({ kind, amountCents: 20000 }, { today: TODAY }), kind);
    assert.deepEqual(on({ kind, amountCents: 20000, invoicePaid: true }), cp.validateRecord({ kind, amountCents: 20000 }, { today: TODAY }), kind + ' with a stray tick');
  }
  assert.deepEqual(on({ kind: 'waived', note: 'family of a client' }), cp.validateRecord({ kind: 'waived', note: 'family of a client' }, { today: TODAY }));
  assert.equal(on({ kind: 'waived' }).error, cp.WAIVE_REASON_ERROR, 'the waiver reason is its own rule, with no switch');
  assert.deepEqual(on({ kind: 'clear' }), { ok: true, normalized: { kind: 'clear' } }, '"Remove record" is not touched');
  assert.equal(on({ kind: 'constructor', amountCents: 100, invoicePaid: true }).ok, false, 'kinds are still own keys only');
});

test('validateRecord, switch OFF (the default): an invoice with no tick is accepted as before — and the validator NEVER reads the environment itself', async () => {
  const want = { ok: true, normalized: { kind: 'invoice', amountCents: 30000, on: TODAY, reference: '', note: '', package: '', packageNote: '', booking: null } };
  assert.deepEqual(cp.validateRecord({ kind: 'invoice', amountCents: 30000 }, { today: TODAY }), want, 'no option handed in');
  assert.deepEqual(cp.validateRecord({ kind: 'invoice', amountCents: 30000 }, { today: TODAY, moneyFirst: false }), want);
  assert.deepEqual(cp.validateRecord({ kind: 'invoice', amountCents: 30000, invoicePaid: true }, { today: TODAY }), want, 'a tick sent while off is ignored, not stored');
  for (const loose of ['1', 1, 'true', {}]) assert.deepEqual(cp.validateRecord({ kind: 'invoice', amountCents: 30000 }, { today: TODAY, moneyFirst: loose }), want, 'only a real true switches it on: ' + JSON.stringify(loose));
  // pure: with the switch ON in the environment, a caller that hands nothing in still gets the old answer
  await withSwitch('1', () => assert.deepEqual(cp.validateRecord({ kind: 'invoice', amountCents: 30000 }, { today: TODAY }), want));
  // "＋ Direct consultation" hands nothing in (it has no invoice choice): its fee kinds are the same either way
  const src = require('fs').readFileSync(require.resolve('../src/services/directConsultService'), 'utf8');
  assert.ok(src.includes("validateRecord({ kind, amountCents: pay.amountCents, on: pay.on, reference: pay.reference, note: pay.note }, { nowWall })"));
  assert.deepEqual(require('../src/services/directConsultService').PAY_KINDS, ['square', 'cash', 'e-transfer', 'waived', 'none'], 'the pop-up still has no invoice choice');
});

/* ── the action: "Record payment" ── */

function world({ lead } = {}) {
  const writes = [], notes = [], monday = [], reads = [], auto = [], meetings = [];
  const state = { lead: { id: '555', fullName: 'Test Client', ...lead } };
  const restore = [
    stub(leadService, 'getLead', async (id) => { reads.push(String(id)); return { ...state.lead }; }),
    stub(leadService, 'updateLead', async (id, fields, opts) => { writes.push({ id, fields, opts }); Object.assign(state.lead, fields); }),
    stub(mondayApi, 'query', async (q, vars) => { monday.push(q); if (/create_update/.test(q)) notes.push(vars.b); return {}; }),
    stub(consultSvc, 'autoSendConsultationPackage', async (...a) => { auto.push(a); return { status: 'sent' }; }),
    stub(meeting, 'createMeeting', async (...a) => { meetings.push(a); return { joinUrl: 'x', id: 'm' }; }),
  ];
  const actor = { name: 'Staff One', email: 'one@example.test', verified: true };
  const nothing = (msg) => assert.deepEqual([writes.length, notes.length, monday.length, auto.length, meetings.length, reads.length], [0, 0, 0, 0, 0, 0], msg + ': no read, no column write, no update, no Monday call, no package, no meeting');
  return { writes, notes, monday, reads, auto, meetings, state, actor, nothing, done: () => restore.reverse().forEach((r) => r()) };
}
const record = (w, value) => portal.applyAction({ leadId: '555', action: 'recordConsultPayment', value, actor: w.actor });
const refusedForTick = (e) => e.badRequest === true && e.message === TICK_ERROR;

test('apply, switch ON: an invoice with no tick is refused before the lead is read — NOTHING is written; with the tick it is recorded exactly as an invoice always was', async () => {
  await withSwitch('1', async () => {
    const w = world();
    try {
      for (const value of [{ kind: 'invoice', amountCents: 30000 }, { kind: 'invoice', amountCents: 30000, invoicePaid: 'true' }, JSON.stringify({ kind: 'invoice', amountCents: 30000, on: TODAY, reference: 'INV-9', note: '' }),
        { kind: 'invoice', amountCents: 30000, package: 'send', booking: { date: '2027-01-12', time: '11:00', consultant: 'Shafoli Kapur', meetingType: 'Virtual', durationMin: 30 } }]) {
        await assert.rejects(record(w, value), refusedForTick, JSON.stringify(value));
      }
      w.nothing('refused');
      const r = await record(w, { kind: 'invoice', amountCents: 30000, on: '2026-11-19', reference: 'INV-9', invoicePaid: true });
      assert.match(r.message, /^Recorded — Invoice sent by the team \$300\.00 received 2026-11-19\. The consultation agreement states \$339\.00 incl\. HST\.$/);
      assert.equal(w.writes.length, 1);
      assert.deepEqual(Object.keys(w.writes[0].fields), ['consultPayment']);
      const stored = JSON.parse(w.writes[0].fields.consultPayment);
      assert.deepEqual(Object.keys(stored).sort(), ['amountCents', 'at', 'by', 'hstCents', 'kind', 'note', 'on', 'reference', 'verified'], 'exactly today\'s fields — the tick is not stored');
      assert.deepEqual({ ...stored, at: undefined }, { kind: 'invoice', amountCents: 30000, hstCents: 3900, on: '2026-11-19', reference: 'INV-9', note: '', by: 'Staff One', at: undefined, verified: true });
      assert.match(w.notes[0], /💳 Consultation fee recorded as paid — Invoice sent by the team \$300\.00 received 2026-11-19 by Staff One · ref INV-9\./);
      assert.equal(cp.paidState(w.state.lead).paid, 'invoice', 'it reads back as paid, as before');
    } finally { w.done(); }
  });
});

test('apply, switch ON: "Change record" on an OLD invoice record asks for the tick again before it saves; the old record stays as it was; cash, e-transfer, Paid in Square, other, waived and "Remove record" are not touched', async () => {
  const old = JSON.stringify({ kind: 'invoice', amountCents: 30000, hstCents: 3900, on: '2026-11-01', reference: 'INV-1', note: '', by: 'Staff Two', at: '2026-11-01T15:00:00Z', verified: true });
  await withSwitch('1', async () => {
    let w = world({ lead: { consultPayment: old } });
    try {
      await assert.rejects(record(w, { kind: 'invoice', amountCents: 30000, on: '2026-11-02', reference: 'INV-1' }), refusedForTick, 'a change of the date alone');
      w.nothing('refused');
      assert.equal(w.state.lead.consultPayment, old, 'the old record still counts as paid, untouched');
      assert.equal(cp.paidState(w.state.lead).paid, 'invoice');
      const r = await record(w, { kind: 'invoice', amountCents: 30000, on: '2026-11-02', reference: 'INV-1', invoicePaid: true });
      assert.match(r.message, /The earlier record was replaced\./);
      assert.equal(JSON.parse(w.writes[0].fields.consultPayment).hstCents, 3900, 'the same amount keeps the HST fixed when it was first recorded');
    } finally { w.done(); }
    for (const value of [{ kind: 'cash', amountCents: 20000 }, { kind: 'e-transfer', amountCents: 20000 }, { kind: 'square', amountCents: 20000 }, { kind: 'other', amountCents: 20000 }, { kind: 'waived', note: 'family of a client' }]) {
      w = world();
      try { const r = await record(w, value); assert.equal(r.ok, true, value.kind); assert.equal(w.writes.length, 1, value.kind); } finally { w.done(); }
    }
    w = world({ lead: { consultPayment: old } });
    try {
      const r = await record(w, { kind: 'clear' });
      assert.equal(r.message, 'The consultation payment record was removed.');
    } finally { w.done(); }
    // a fee paid through the booking link still outranks everything, tick or no tick
    w = world({ lead: { squareConsultTxnId: 'SQ9', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 }) } });
    try {
      await assert.rejects(record(w, { kind: 'invoice', amountCents: 30000, invoicePaid: true }), (e) => e.badRequest && /paid through the booking link/.test(e.message));
      assert.equal(w.writes.length, 0);
    } finally { w.done(); }
  });
});

test('apply, switch OFF (unset, or 0): an invoice is recorded with no tick, word for word as before', async () => {
  for (const sw of [undefined, '0', 'off']) {
    await withSwitch(sw, async () => {
      const w = world();
      try {
        const r = await record(w, { kind: 'invoice', amountCents: 30000, on: '2026-11-19', reference: 'INV-9' });
        assert.equal(r.message, 'Recorded — Invoice sent by the team $300.00 received 2026-11-19. The consultation agreement states $339.00 incl. HST.', String(sw));
        assert.deepEqual(Object.keys(JSON.parse(w.writes[0].fields.consultPayment)).sort(), ['amountCents', 'at', 'by', 'hstCents', 'kind', 'note', 'on', 'reference', 'verified']);
        assert.match(w.notes[0], /💳 Consultation fee recorded as paid — Invoice sent by the team \$300\.00 received 2026-11-19 by Staff One · ref INV-9\. A record only/);
      } finally { w.done(); }
    });
  }
});

/* ── how the record box learns the setting ── */

test('the record\'s own data says the setting: consultPayment.moneyFirst — beside onRecord, never inside it (onRecord is empty while the package switch is off)', async () => {
  const restore = [stub(leadService, 'getLead', async () => ({ id: '2', fullName: 'B', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000 }) }))];
  try {
    await withSwitch(undefined, async () => {
      const d = await portal.getConsultationDetail('2');
      assert.equal(d.consultPayment.moneyFirst, false);
      assert.deepEqual(d.consultPayment.onRecord, { enabled: false });
    });
    await withSwitch('1', async () => {
      const d = await portal.getConsultationDetail('2');
      assert.equal(d.consultPayment.moneyFirst, true);
      assert.deepEqual(d.consultPayment.onRecord, { enabled: false }, 'the package switch is its own thing');
      assert.deepEqual(Object.keys(d.consultPayment), ['paid', 'paidCents', 'on', 'by', 'verified', 'reference', 'note', 'at', 'feeCents', 'alsoRecorded', 'onRecord', 'moneyFirst'], 'one new field');
    });
  } finally { restore.forEach((r) => r()); }
});

/* ── the record box (the page's own emitted code against a small fake page) ── */

const detail = (over = {}) => ({ name: 'Test Client', consultPayment: { paid: '', feeCents: 30000, onRecord: { enabled: false }, ...over } });

test('record box, switch ON: the choice reads "Invoice — paid (…)"; choosing it shows the required tick and "Date the invoice was paid"; Record with no tick says so, keeps the box OPEN and sends nothing; with the tick the request carries invoicePaid:true', () => {
  const b = recordBox({ detail: detail({ moneyFirst: true }) }).open();
  assert.deepEqual(b.q('#cp-kind').options.map((o) => [o.value, o.text]), [['cash', 'Cash'], ['e-transfer', 'E-transfer'], ['square', 'Paid in Square (booked by the team, not the booking link)'],
    ['invoice', 'Invoice — paid (sent by the team, not the booking link)'], ['other', 'Other'], ['waived', 'Waived — no fee']], 'six choices in the same order; only the invoice words differ');
  assert.equal(b.q('#cp-inv-w').style.display, 'none', 'Cash: no tick');
  assert.equal(b.q('label[for="cp-on"]').textContent, 'Date received');
  assert.match(b.box.innerHTML, /<div id="cp-inv-w" style="display:none"><label class="cp-choice" for="cp-inv-paid"><input type="checkbox" id="cp-inv-paid"><span>The invoice has been paid — the money is in<\/span><\/label><div class="paym-hint">Only sent, not paid yet\? Do not record it\. The consultation shows “Not paid” in red until the money is in\.<\/div><\/div>/);
  b.kind('invoice');
  assert.equal(b.q('#cp-inv-w').style.display, '', 'the tick and its line show');
  assert.equal(b.q('label[for="cp-on"]').textContent, 'Date the invoice was paid');
  assert.equal(b.q('#cp-inv-paid').checked, false, 'never ticked for staff');
  b.q('#cp-ref').value = 'INV-9';
  b.go();
  assert.equal(b.err(), 'Tick “The invoice has been paid”.');
  assert.equal(b.box.focused, 'cp-inv-paid');
  assert.equal(b.dlg.closed, false, 'the box stays open');
  assert.equal(b.sent.length, 0, 'nothing is sent');
  assert.deepEqual([b.q('#cp-amt').value, b.q('#cp-ref').value, b.q('#cp-kind').value], ['300.00', 'INV-9', 'invoice'], 'what was typed is still there');
  b.q('#cp-inv-paid').checked = true;
  b.go();
  assert.equal(b.sent.length, 1);
  assert.deepEqual({ ...b.sent[0].value, on: undefined }, { kind: 'invoice', amountCents: 30000, on: undefined, reference: 'INV-9', note: '', invoicePaid: true });
  assert.equal(b.dlg.closed, true);
  // what the box sends passes the server rule
  assert.equal(cp.validateRecord(b.sent[0].value, { moneyFirst: true }).ok, true);
});

test('record box, switch ON: the tick belongs to the invoice choice only — another kind hides it, sends no invoicePaid, and a tick never carries over; an old invoice record opens unticked', () => {
  const b = recordBox({ detail: detail({ moneyFirst: true }) }).open();
  b.kind('invoice'); b.q('#cp-inv-paid').checked = true;
  b.kind('cash');
  assert.equal(b.q('#cp-inv-w').style.display, 'none');
  assert.equal(b.q('label[for="cp-on"]').textContent, 'Date received');
  assert.equal(b.q('#cp-inv-paid').checked, false, 'unticked when the kind changes');
  b.go();
  assert.equal(b.sent.length, 1);
  assert.equal('invoicePaid' in b.sent[0].value, false, 'cash carries no tick');
  const again = recordBox({ detail: detail({ moneyFirst: true }) }).open();
  again.kind('invoice'); again.q('#cp-inv-paid').checked = true; again.kind('e-transfer'); again.kind('invoice');
  assert.equal(again.q('#cp-inv-paid').checked, false, 'back on the invoice choice: the tick is asked again');
  again.go();
  assert.equal(again.err(), 'Tick “The invoice has been paid”.'); assert.equal(again.sent.length, 0);
  // waived: the reason rule is unchanged with the switch on
  const wv = recordBox({ detail: detail({ moneyFirst: true }) }).open();
  wv.kind('waived'); wv.go();
  assert.equal(wv.err(), 'Write the reason the fee is waived.'); assert.equal(wv.sent.length, 0);
  // "Change record" on an invoice record made before the switch: it opens on the invoice choice, UNTICKED
  const old = recordBox({ detail: { name: 'Test Client', consultPayment: { paid: 'invoice', paidCents: 30000, on: '2026-11-01', by: 'Staff Two', verified: true, reference: 'INV-1', note: '', feeCents: 30000, onRecord: { enabled: false }, moneyFirst: true } } }).open();
  assert.equal(old.q('#cp-kind').value, 'invoice');
  assert.equal(old.q('#cp-inv-w').style.display, '');
  assert.equal(old.q('label[for="cp-on"]').textContent, 'Date the invoice was paid');
  old.go();
  assert.equal(old.err(), 'Tick “The invoice has been paid”.'); assert.equal(old.sent.length, 0);
  // "Remove record" has no tick and asks nothing
  const rm = recordBox({ detail: { name: 'Test Client', consultPayment: { paid: 'invoice', paidCents: 30000, on: '2026-11-01', by: 'Staff Two', verified: true, feeCents: 30000, onRecord: { enabled: false }, moneyFirst: true } } }).open(true);
  assert.equal(rm.q('#cp-inv-paid'), null);
  rm.go();
  assert.deepEqual(rm.sent[0].value, { kind: 'clear' });
});

test('record box, switch OFF: word for word the box as it was — "Invoice sent by the team (not the booking link)", "Date received", no tick anywhere, and the request has no invoicePaid', () => {
  const off = recordBox({ detail: detail({ moneyFirst: false }) }).open();
  const legacy = recordBox({ detail: detail({}) }).open();   // an answer from before the field existed
  assert.equal(off.box.innerHTML, legacy.box.innerHTML, 'false and "not told" draw the same box');
  for (const loose of ['1', 1, 'true', {}]) assert.equal(recordBox({ detail: detail({ moneyFirst: loose }) }).open().box.innerHTML, off.box.innerHTML, 'only a real true switches the words: ' + JSON.stringify(loose));
  assert.deepEqual(off.q('#cp-kind').options.map((o) => o.text), ['Cash', 'E-transfer', 'Paid in Square (booked by the team, not the booking link)', 'Invoice sent by the team (not the booking link)', 'Other', 'Waived — no fee']);
  for (const gone of ['cp-inv', 'invoice has been paid', 'Invoice — paid', 'Only sent, not paid yet', 'Date the invoice was paid']) assert.ok(!off.box.innerHTML.includes(gone), 'not in the box: ' + gone);
  assert.ok(off.box.innerHTML.includes('<label for="cp-on">Date received</label><input id="cp-on" type="date"'));
  assert.equal(off.q('#cp-inv-w'), null); assert.equal(off.q('#cp-inv-paid'), null);
  off.kind('invoice');
  assert.equal(off.q('label[for="cp-on"]').textContent, 'Date received', 'the label is not touched');
  off.q('#cp-ref').value = 'INV-9';
  off.go();
  assert.equal(off.sent.length, 1, 'an invoice saves with no tick, as before');
  assert.deepEqual({ ...off.sent[0].value, on: undefined }, { kind: 'invoice', amountCents: 30000, on: undefined, reference: 'INV-9', note: '' });
  assert.equal('invoicePaid' in off.sent[0].value, false);
  // the box ON differs from the box OFF in the invoice words and the (hidden) tick block only
  const on = recordBox({ detail: detail({ moneyFirst: true }) }).open();
  const tick = on.box.innerHTML.match(/<div id="cp-inv-w"[\s\S]*?<\/div><\/div>/)[0];
  assert.equal(on.box.innerHTML.replace(tick, '').replace('Invoice — paid (sent by the team, not the booking link)', 'Invoice sent by the team (not the booking link)'), off.box.innerHTML);
});

test('the pages do not change with the switch: the same HTML is served on and off (the words are chosen in the browser from the setting); every inline script parses', async () => {
  const L = require('../src/routes/adminLeads');
  const vm = require('node:vm');
  const build = () => [C.buildQueueHTML(), C.buildRetainersHTML(), C.buildDetailHTML('12345'), L.buildLeadDetailHTML('12345')];
  const off = await withSwitch(undefined, build), on = await withSwitch('1', build);
  ['Consultations', 'Retainers', 'consultation record', 'lead page'].forEach((name, i) => {
    assert.equal(on[i], off[i], name + ': identical with the switch on and off');
    for (const src of scriptsOf(off[i])) { try { new vm.Script(src); } catch (e) { assert.fail(name + ': ' + e.message); } }
  });
  // the Retainers page and the lead page know nothing of money first
  for (const i of [1, 3]) for (const s of ['moneyFirst', 'invoice has been paid', 'pays first']) assert.ok(!off[i].includes(s), s);
  // the fee card and the list pills keep today's words for an invoice record
  assert.ok(off[2].includes("invoice:'Invoice sent by the team'") && off[0].includes("invoice:'Invoice'"));
});
