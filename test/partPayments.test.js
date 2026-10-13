'use strict';

// Part-payments (2026-10-13, Asmita: a client e-transferred half of milestone 1).
// A milestone keeps a ledger of the payments received for it. It reads
// 'partial' — never 'paid' — until the balance reaches zero: no "paid" note,
// no paidAt, and for milestone 1 none of the retainer-paid chain (Retained,
// countersign, onboarding). The payment that settles it writes exactly what
// "Mark paid" wrote before. Undo removes one part-payment at a time.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const ms             = require('../src/services/milestonePaymentService');
const leadService    = require('../src/services/leadService');
const mondayApi      = require('../src/services/mondayApi');
const paymentService = require('../src/services/paymentService');
const mail           = require('../src/services/microsoftMailService');
const U              = require('../src/services/paymentUndoService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const MILESTONES = JSON.stringify([
  { label: 'Milestone 1 – Admin Fee (Non-Refundable)', amountCents: 100000, trigger: 'Retainer Confirmed', locked: true },
  { label: 'Milestone 2 – Before Submission', amountCents: 100000, trigger: 'Internal Review' },
]);
const LEAD = (over = {}) => ({ id: '555001', fullName: 'Sanjeev Kumar', email: 'client@example.com', confirmedCaseType: 'Study permit', retainerFee: '2000', retainerHstRate: '13', retainerMilestones: MILESTONES, milestonePayments: '{}', ...over });
const ACTOR = { name: 'Asmita', verified: false };

/** A fake Monday for one lead: the stored payments JSON, every note, every lead write; the retainer-paid chain trapped. */
function world({ pay = '{}', lead = {} } = {}) {
  let stored = pay;
  const notes = [], writes = [], mails = [];
  let retainerPaidCalls = 0;
  const restores = [
    stub(leadService, 'getLead', async () => LEAD({ milestonePayments: stored, ...lead })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); if (f.milestonePayments != null) stored = f.milestonePayments; }),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(v.b != null ? v.b : v.body); return {}; }),
    stub(paymentService, 'recordRetainerPaid', async () => { retainerPaidCalls++; return { ok: true }; }),
    stub(mail, 'sendEmail', async (m) => { mails.push(m); }),
  ];
  return { notes, writes, mails, get stored() { return stored; }, row: (i) => JSON.parse(stored)[i], get retainerPaidCalls() { return retainerPaidCalls; }, restore: () => restores.forEach((r) => r()) };
}

test('a part-payment: on file as "partial", no paidAt, no "paid" note, and milestone 1 does NOT start the retainer-paid chain', async () => {
  const w = world();
  try {
    const r = await ms.markMilestonePaid('555001', 0, { amountCents: 56500, reference: 'C1AeUbQTRwZy', actor: ACTOR });
    assert.deepEqual([r.ok, r.settled, r.amountCents, r.paidCents, r.balanceCents, r.totalCents], [true, false, 56500, 56500, 56500, 113000]);
    const e = w.row(0);
    assert.equal(e.status, 'partial');
    assert.equal(e.paidAt, undefined, 'not paid');
    assert.equal(e.marked, undefined);
    assert.deepEqual(e.l.map((x) => [x.a, x.r, x.b, x.v]), [[56500, 'C1AeUbQTRwZy', 'Asmita', false]]);
    assert.equal(e.l[0].t, undefined === e.l[0].t ? undefined : e.l[0].t);
    assert.match(e.l[0].d, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(w.retainerPaidCalls, 0, 'the retainer is NOT paid');
    assert.equal(w.notes.length, 1);
    assert.match(w.notes[0], /^💵 <b>Part-payment received<\/b> — Milestone 1 – Admin Fee \(Non-Refundable\): \$565\.00 of \$1,130\.00 \(e-transfer, ref C1AeUbQTRwZy\)\. <b>Balance \$565\.00<\/b> — the milestone is not paid until the balance is in\. Recorded by Asmita \(name as typed — not signed in with Monday\)\.$/);
    assert.ok(!/Payment received/.test(w.notes[0]));
    assert.equal(w.mails.length, 0, 'receipts are a switch, off by default');
  } finally { w.restore(); }
});

test('the balance settles it: exactly what "Mark paid" writes (status paid, paidAt, marked, reference), the ledger kept, the retainer-paid chain runs once', async () => {
  const w = world({ pay: JSON.stringify({ 0: { status: 'partial', method: 'e-transfer', reference: 'TDOT-55001-M1', requestedAt: '2026-10-13', amountCents: 113000, l: [{ a: 56500, d: '2026-10-13', r: 'C1AeUbQTRwZy', b: 'Asmita', v: false, t: '2026-10-13T16:47Z' }] } }) });
  try {
    const r = await ms.markMilestonePaid('555001', 0, { amountCents: 56500, reference: 'C1AfXYZ', actor: { name: 'Gauri Berde', email: 'g@x.com', verified: true } });
    assert.deepEqual([r.settled, r.paidCents, r.balanceCents], [true, 113000, 0]);
    const e = w.row(0);
    assert.equal(e.status, 'paid');
    assert.match(e.paidAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(e.reference, 'C1AfXYZ');
    assert.deepEqual([e.marked.by, e.marked.verified], ['Gauri Berde', true]);
    assert.equal(e.l.length, 2, 'both payments stay on the statement');
    assert.equal(w.retainerPaidCalls, 1, 'milestone 1 paid → the retainer-paid chain, once');
    assert.match(w.notes[0], /^✅ <b>Payment received<\/b> — Milestone 1 – Admin Fee \(Non-Refundable\) \(e-transfer, ref C1AfXYZ\)\. This \$565\.00 payment settles it — \$1,130\.00 received in total\. Recorded by Gauri Berde\.$/);
  } finally { w.restore(); }
});

test('without an amount, "Mark paid" records the whole balance — today\'s behaviour, byte for byte (no ledger for a plain full payment)', async () => {
  const w = world();
  try {
    const r = await ms.markMilestonePaid('555001', 1, { reference: 'BANK-1', actor: ACTOR });
    assert.deepEqual([r.settled, r.amountCents, r.paidCents], [true, 113000, 113000]);
    const e = w.row(1);
    assert.equal(e.status, 'paid');
    assert.equal(e.l, undefined, 'the ledger exists only where part-payments happened');
    assert.deepEqual(Object.keys(e).sort(), ['marked', 'method', 'paidAt', 'reference', 'status']);
    assert.match(w.notes[0], /^✅ <b>Payment received<\/b> — Milestone 2 – Before Submission \(e-transfer, ref BANK-1\)\. Recorded by Asmita/);
    assert.ok(!/settles it/.test(w.notes[0]));
    assert.equal(w.retainerPaidCalls, 0, 'milestone 2 is not the retainer');
  } finally { w.restore(); }
});

test('refused out loud: more than the balance, a zero/negative/fractional amount, a part-payment on a row already paid', async () => {
  const w = world({ pay: JSON.stringify({ 0: { status: 'partial', l: [{ a: 100000, d: '2026-10-13' }] }, 1: { status: 'paid', paidAt: '2026-10-01', reference: 'OLD' } }) });
  try {
    await assert.rejects(ms.markMilestonePaid('555001', 0, { amountCents: 13001, actor: ACTOR }), (e) => e.code === 'AMOUNT_OVER_BALANCE' && e.badRequest && /more than the \$130\.00 still owed/.test(e.message) && /Nothing was recorded/.test(e.message));
    for (const bad of [0, -5, 12.5, 'x']) await assert.rejects(ms.markMilestonePaid('555001', 0, { amountCents: bad, actor: ACTOR }), (e) => e.code === 'BAD_AMOUNT');
    await assert.rejects(ms.markMilestonePaid('555001', 1, { amountCents: 100, reference: 'NEW', actor: ACTOR }), (e) => /already recorded as paid/.test(e.message));
    assert.equal(w.writes.length, 0, 'nothing written');
    assert.equal(w.notes.length, 0);
    // exactly the balance is fine
    const r = await ms.markMilestonePaid('555001', 0, { amountCents: 13000, actor: ACTOR });
    assert.equal(r.settled, true);
  } finally { w.restore(); }
});

test('two part-payments one after another add up; a late "requested" patch never downgrades a partial row', async () => {
  const w = world();
  try {
    await ms.markMilestonePaid('555001', 0, { amountCents: 30000, actor: ACTOR });
    await ms.markMilestonePaid('555001', 0, { amountCents: 20000, reference: 'R2', actor: ACTOR });
    let e = w.row(0);
    assert.equal(e.status, 'partial');
    assert.deepEqual(e.l.map((x) => x.a), [30000, 20000]);
    await ms.patchPayment('555001', 0, { status: 'requested', reference: 'TDOT-55001-M1', requestedAt: '2026-10-14' });
    e = w.row(0);
    assert.equal(e.status, 'partial', 'money on file: the request patch cannot un-record it');
    assert.equal(e.reference, 'TDOT-55001-M1', 'the request details still land');
    assert.deepEqual(e.l.map((x) => x.a), [30000, 20000]);
  } finally { w.restore(); }
});

test('milestoneStates exposes paidCents / balanceCents / payments; older paid rows (no ledger) count as their total', () => {
  const lead = LEAD({ milestonePayments: JSON.stringify({ 0: { status: 'partial', l: [{ a: 56500, d: '2026-10-13', r: 'C1', b: 'Asmita', v: false, t: '2026-10-13T16:47Z' }] }, 1: { status: 'paid', paidAt: '2026-09-01', reference: 'X' } }) });
  const st = ms.milestoneStates(lead, '', []);
  assert.deepEqual([st[0].status, st[0].paidCents, st[0].balanceCents], ['partial', 56500, 56500]);
  assert.deepEqual(st[0].payments, [{ amountCents: 56500, paidAt: '2026-10-13', reference: 'C1', by: 'Asmita', verified: false, at: '2026-10-13T16:47Z' }]);
  assert.deepEqual([st[1].status, st[1].paidCents, st[1].balanceCents, st[1].payments], ['paid', 113000, 0, []]);
  assert.deepEqual(ms.ledgerOf({ l: [{ a: 0 }, { a: 'x' }, null, { a: 5 }] }).map((x) => x.amountCents), [5], 'junk entries ignored');
  assert.equal(ms.paidCentsOf({ status: 'requested' }, 113000), 0);
});

test('the column stays under Monday\'s cut: 3 milestones × 3 part-payments each serialise; a 7th part-payment on one milestone is refused out loud', async () => {
  // the longest an entry can be: a 24-char reference and a 24-char name (both capped when written)
  const entry = () => ({ a: 28250, d: '2026-10-13', r: 'C1AeUbQTRwZyC1AeUbQTRw', b: 'Kamalpreet K Grewal Long', v: true, t: '2026-10-13T16:47Z' });
  const pay = {};
  for (let i = 0; i < 3; i++) pay[i] = { status: 'paid', paidAt: '2026-10-13', method: 'e-transfer', reference: 'C1AeUbQTRwZy', requestedAt: '2026-10-01', amountCents: 113000, marked: { by: 'Kamalpreet K Grewal', at: '2026-10-13T16:47Z', verified: true }, l: [entry(), entry(), entry()] };
  const text = ms.serializePayments('1', pay);
  assert.ok(text.length <= ms.MAX_PAYMENTS_JSON, `${text.length} chars`);
  assert.equal(ms.LEDGER_MAX, 6);
  const six = []; for (let i = 0; i < 6; i++) six.push({ a: 1000, d: '2026-10-13' });
  const w = world({ pay: JSON.stringify({ 0: { status: 'partial', l: six } }) });
  try {
    await assert.rejects(ms.markMilestonePaid('555001', 0, { amountCents: 1000, actor: ACTOR }), (e) => e.code === 'LEDGER_FULL' && e.badRequest && /Nothing was recorded/.test(e.message));
    assert.equal(w.writes.length, 0);
    const r = await ms.markMilestonePaid('555001', 0, { amountCents: 107000, actor: ACTOR });   // the whole balance still settles it
    assert.equal(r.settled, true);
  } finally { w.restore(); }
});

test('the receipt email: off by default; when on, a part-payment receipt shows paid so far + balance + how to pay the rest, a settling one says paid in full', async () => {
  const html = ms.paymentReceiptHtml({ firstName: 'Sanjeev', label: 'Milestone 1 – Admin Fee (Non-Refundable)', amountCents: 56500, paidCents: 56500, totalCents: 113000, reference: 'C1AeUbQTRwZy', paidAt: '2026-10-13', settled: false, payReference: 'TDOT-17769-M1' });
  assert.ok(html.includes('Part-payment received — Milestone 1') && html.includes('$565.00') && html.includes('$1,130.00') && html.includes('Balance remaining: $565.00') && html.includes('TDOT-17769-M1'));
  const full = ms.paymentReceiptHtml({ firstName: 'Sanjeev', label: 'M1', amountCents: 56500, paidCents: 113000, totalCents: 113000, reference: '', paidAt: '2026-10-14', settled: true });
  assert.ok(full.includes('Payment received — M1') && full.includes('paid in full') && !full.includes('Balance remaining'));
  assert.equal(ms.paymentReceiptsEnabled(), false);
  const prev = process.env.PAYMENT_RECEIPT_EMAILS; process.env.PAYMENT_RECEIPT_EMAILS = '1';
  const w = world();
  try {
    await ms.markMilestonePaid('555001', 0, { amountCents: 56500, actor: ACTOR });
    assert.equal(w.mails.length, 1);
    assert.equal(w.mails[0].to, 'client@example.com');
    assert.equal(w.mails[0].subject, 'Your TDOT Immigration payment receipt — Milestone 1 – Admin Fee (Non-Refundable)');
    assert.match(w.notes[0], /Receipt emailed to the client\.$/);
    // a failing mail server never blocks the record
    w.mails.length = 0; w.notes.length = 0;
    const r = stub(mail, 'sendEmail', async () => { throw new Error('Graph down'); });
    try { const res = await ms.markMilestonePaid('555001', 0, { amountCents: 56500, reference: 'C2', actor: ACTOR }); assert.equal(res.settled, true); assert.ok(!/Receipt emailed/.test(w.notes[0])); } finally { r(); }
  } finally { if (prev === undefined) delete process.env.PAYMENT_RECEIPT_EMAILS; else process.env.PAYMENT_RECEIPT_EMAILS = prev; w.restore(); }
});

test('the action: the amount is validated, the messages say paid-so-far and balance, the pinned "already" line is unchanged', async () => {
  const cps = require('../src/services/consultantPortalService');
  const src = fs.readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.match(src, /markMilestonePaid\(leadId, v\.normalized\.index, \{ reference: v\.normalized\.reference, actor: by, amountCents: v\.normalized\.amountCents, settle: v\.normalized\.settle \}\)/);
  assert.match(src, /if \(r\.already\) return \{ ok: true, message: `Already recorded as paid \(\$\{r\.existingOn\}\) — nothing changed\.` \};/);
  const v = await cps.validateAction('markMilestonePaid', JSON.stringify({ index: 0, reference: 'R', amountCents: 56500 }));
  assert.deepEqual(v.normalized, { index: 0, reference: 'R', amountCents: 56500, settle: false });
  assert.equal((await cps.validateAction('markMilestonePaid', JSON.stringify({ index: 0 }))).normalized.amountCents, null, 'absent = the whole balance');
  for (const bad of [0, -1, 1.5, 'abc', 20000001]) assert.equal((await cps.validateAction('markMilestonePaid', JSON.stringify({ index: 0, amountCents: bad }))).ok, false, String(bad));
  const w = world();
  const r1 = stub(ms, 'markMilestonePaid', async () => ({ ok: true, label: 'M1', settled: false, amountCents: 56500, paidCents: 56500, balanceCents: 56500, totalCents: 113000 }));
  try {
    const a = await cps.applyAction({ leadId: '555001', action: 'markMilestonePaid', value: JSON.stringify({ index: 0, amountCents: 56500 }), staffName: 'Asmita' });
    assert.equal(a.message, 'Recorded — $565.00 toward M1 by e-transfer. Paid so far $565.00 of $1,130.00; balance $565.00. The milestone is not paid until the balance is in.');
  } finally { r1(); }
  const r2 = stub(ms, 'markMilestonePaid', async () => ({ ok: true, label: 'M1', settled: true, amountCents: 56500, paidCents: 113000, balanceCents: 0, totalCents: 113000 }));
  try {
    const a = await cps.applyAction({ leadId: '555001', action: 'markMilestonePaid', value: JSON.stringify({ index: 0, amountCents: 56500 }), staffName: 'Asmita' });
    assert.equal(a.message, 'Recorded — M1 marked paid by e-transfer (this $565.00 settles it; $1,130.00 received in total).');
  } finally { r2(); }
  const r3 = stub(ms, 'markMilestonePaid', async () => ({ ok: true, label: 'M1', settled: true, amountCents: 113000, paidCents: 113000, balanceCents: 0, totalCents: 113000 }));
  try {
    const a = await cps.applyAction({ leadId: '555001', action: 'markMilestonePaid', value: JSON.stringify({ index: 0 }), staffName: 'Asmita' });
    assert.equal(a.message, 'Recorded — M1 marked paid by e-transfer.', 'a plain full payment reads exactly as before');
  } finally { r3(); w.restore(); }
});

test('the dialog: an amount box (default = the balance), the hint, the pinned "scheduled amount" line kept, no backtick/${/backslash; both panels pass the amount', () => {
  const js = require('../src/routes/adminShared').PAYMENT_UI_JS;
  assert.ok(!/[`\\]|\$\{/.test(js), 'plain template text');
  const mark = js.slice(js.indexOf('function tdotOpenMarkPaidModal('), js.indexOf('function payList('));
  assert.ok(mark.includes("payAmount(m) + ' <span class=\"paym-muted\">scheduled amount, incl. HST</span>"), 'the pinned label line');
  assert.ok(mark.includes('<input id="paym-amt" class="paym-amt-in" type="text" inputmode="decimal" autocomplete="off" value="\' + (balance/100).toFixed(2) + \'">'));
  assert.ok(mark.includes("o.onConfirm(ref, by, cents, nothingOwed);"));
  assert.ok(mark.includes("Record the balance here and the rest on the next milestone."));
  assert.ok(mark.includes("Part-payment — ' + payDollars(balance - cents) + ' will remain on this milestone."));
  // the amount parser, run here
  const fn = new Function(js + '; return { payParseCents: payParseCents, payPaidCents: payPaidCents, payBalanceCents: payBalanceCents };')();
  assert.deepEqual(['565.00', '$565', '1,130.00', '0', '', 'abc'].map(fn.payParseCents), [56500, 56500, 113000, 0, NaN, NaN]);
  assert.equal(fn.payBalanceCents({ totalCents: 113000, paidCents: 56500, status: 'partial' }), 56500);
  assert.equal(fn.payBalanceCents({ totalCents: 113000, status: 'paid' }), 0, 'an older paid row with no paidCents');
  assert.equal(fn.payBalanceCents({ totalCents: 113000, status: 'requested' }), 113000);
  const consult = fs.readFileSync(require.resolve('../src/routes/adminConsultation'), 'utf8');
  assert.match(consult, /onConfirm: function\(ref,by,amountCents,settle\)\{\s*doAction\('markMilestonePaid', JSON\.stringify\(\{index:i, reference:ref, amountCents:amountCents, settle:settle===true\}\), null, by\);/);
  assert.match(consult, /<span class="ms-badge partial">Part-paid<\/span>/);
  const cockpit = fs.readFileSync(require.resolve('../src/routes/adminCase'), 'utf8');
  assert.match(cockpit, /onConfirm: function\(ref, by, amountCents, settle\) \{\s*msSend\(btn, \{ action: 'markMilestonePaid', value: JSON\.stringify\(\{ index: i, reference: ref, amountCents: amountCents, settle: settle === true \}\), staffName: by \}\);/);
  assert.match(cockpit, /<span class="pill amber">PART-PAID<\/span>/);
  // the request-button conditions both pages pin elsewhere are untouched
  assert.match(consult, /\(\(\(m\.status==='pending'&&\(m\.due\|\|\(m\.index===0&&signed\)\)\)\|\|m\.legacySent\)&&!\(m\.index===0&&D\.retainerPaid\)\)/);
});

test('client portal: a part-paid milestone shows what was received and the balance with how to pay it; "paid so far" counts part-payments', () => {
  const { buildPortalPage, clientStage, toClientTimeline } = require('../src/services/clientPortalService');
  const base = { clientName: 'Sanjeev Kumar', caseRef: '2026-CWP-016', caseType: 'Concurrent WP', caseSubType: null, caseStage: 'Pre-Onboarding', accessToken: 'tok',
    qReadinessPct: 0, qCompletionStatus: '', docCounts: { total: 0, received: 0, reviewed: 0, rework: 0, missing: 0 }, reworkDocs: [], totalMembers: 1, submittedMembers: 0,
    journey: clientStage('Pre-Onboarding'), timeline: toClientTimeline([]), payments: { retainerFee: '1000', etransferEmail: 'admstdot@gmail.com', milestones: [
    { index: 0, label: 'Milestone 1 – Admin Fee', totalCents: 113000, status: 'partial', reference: 'TDOT-17769-M1', due: true, paidCents: 56500, balanceCents: 56500, payments: [{ amountCents: 56500, paidAt: '2026-10-13', reference: 'C1' }] },
    { index: 1, label: 'Milestone 2 – Filing', totalCents: 113000, status: 'pending', reference: '', due: false, paidCents: 0, balanceCents: 113000, payments: [] },
  ] } };
  const html = buildPortalPage(base, { mode: 'client' });
  assert.ok(html.includes('Part-paid'));
  assert.ok(html.includes('we received <b>$565.00</b> toward this milestone. Balance remaining: <b>$565.00</b>'));
  assert.ok(html.includes('TDOT-17769-M1') && html.includes('admstdot@gmail.com'));
  assert.ok(html.includes('0 of 2 paid'), 'a part-paid milestone is not a paid one');
  assert.ok(html.includes('$565.00 of $2260.00'), 'paid so far counts the part-payment');
  const staff = buildPortalPage(base, { mode: 'staff' });
  assert.ok(staff.includes('Part-paid — $565.00 received, <b>$565.00</b> outstanding'));
  // older rows without paidCents still read as before
  const old = buildPortalPage({ ...base, payments: { ...base.payments, milestones: [{ index: 0, label: 'M1', totalCents: 113000, status: 'paid', paidAt: '2026-07-12', reference: 'CA1', due: false }] } }, { mode: 'client' });
  assert.ok(old.includes('1 of 1 paid') && old.includes('$1130.00 of $1130.00'));
});

test('timeline: each part-payment is an event, the settling one is "Paid"; the client reads "Part-payment received — … — thank you"', () => {
  const { buildTimeline } = require('../src/services/caseCockpitService');
  const { toClientTimeline } = require('../src/services/clientPortalService');
  const ev = buildTimeline({ lead: {}, milestones: [
    { index: 0, label: 'M1', status: 'paid', paidAt: '2026-10-14', reference: 'C2', requestedAt: '2026-10-01', payments: [{ amountCents: 56500, paidAt: '2026-10-13', reference: 'C1' }, { amountCents: 56500, paidAt: '2026-10-14', reference: 'C2' }] },
    { index: 1, label: 'M2', status: 'partial', requestedAt: '', payments: [{ amountCents: 10000, paidAt: '2026-10-15', reference: 'C3' }] },
  ] });
  const titles = ev.map((e) => `${e.date} ${e.title}${e.detail ? ` [${e.detail}]` : ''}`);
  assert.deepEqual(titles, ['2026-10-01 e-Transfer requested — M1 [ref TDOT]'.replace(' [ref TDOT]', ' [ref C2]'), '2026-10-13 Part-payment — M1 [$565.00 · ref C1]', '2026-10-14 Paid — M1 [ref C2]', '2026-10-15 Part-payment — M2 [$100.00 · ref C3]']);
  const client = toClientTimeline(ev, '2026-10-20').map((e) => e.title);
  assert.ok(client.includes('Part-payment received — M1 — thank you') && client.includes('Payment received — M1 — thank you') && client.includes('Part-payment received — M2 — thank you'));
});

/* ── undo ── */
const D = '2026-10-13';
const PLAN_LEAD = (pay, over = {}) => ({ id: '13108401448', fullName: 'Sanjeev Kumar', clientMasterItemId: '13108384096', confirmedCaseType: 'OINP', retainerFee: '2000', retainerHstRate: '13', retainerMilestones: MILESTONES,
  milestonePayments: JSON.stringify(pay), retainerSigned: D, retainerPaid: '', conversionStatus: 'Retained — Awaiting Payment', retainerCountersign: '{}', ...over });
const CASE = { itemId: '13108384096', paymentStatus: 'Already Sent', caseRef: '2026-CWP-016', caseStage: 'Pre-Onboarding', checklistApplied: '', paymentConfDate: '', archived: false };
const UNDO_ACTOR = { name: 'Faran', email: 'faran@example.com', verified: true };
const L1 = { a: 56500, d: '2026-10-13', r: 'C1', b: 'Asmita', v: false, t: '2026-10-13T16:47Z' };
const L2 = { a: 30000, d: '2026-10-14', r: 'C2', b: 'Asmita', v: false, t: '2026-10-14T10:00Z' };

test('undo plan, a part-paid row: removes the LAST part-payment only; the rest stay; no payment date, no Retained change; the fingerprint pins the entry', () => {
  const lead = PLAN_LEAD({ 0: { status: 'partial', method: 'e-transfer', reference: 'TDOT-01448-M1', requestedAt: '2026-10-01', amountCents: 113000, l: [L1, L2] } });
  const p = U.planMilestonePaidReversal({ lead, index: 0, cm: CASE, actor: UNDO_ACTOR, now: '2026-10-15T15:04:11.000Z' });
  assert.equal(p.ok, true, JSON.stringify(p.refusal));
  assert.equal(p.mode, 'partial-entry');
  assert.deepEqual(p.removing, { amountCents: 30000, paidAt: '2026-10-14', reference: 'C2', by: 'Asmita', verified: false, at: '2026-10-14T10:00Z' });
  assert.equal(p.after.status, 'partial');
  assert.deepEqual(p.after.l, [L1], 'the earlier part-payment stays');
  assert.equal(p.after.reference, 'TDOT-01448-M1');
  assert.deepEqual(p.clearKeys, []);
  assert.equal(p.conversionStatus, null);
  assert.deepEqual(p.willChange, ['The $300.00 part-payment of 2026-10-14 is removed; the milestone goes back to “part-paid ($565.00 of $1,130.00 on file)”']);
  assert.ok(p.info.some((x) => x.code === 'PARTS_STAY'));
  assert.equal(p.expect.mode, 'partial-entry');
  // a different last entry → a different fingerprint (a stale dialog cannot remove the wrong one)
  const other = PLAN_LEAD({ 0: { status: 'partial', l: [L1] } });
  assert.notEqual(U.entryFingerprint(JSON.parse(lead.milestonePayments)[0]), U.entryFingerprint(JSON.parse(other.milestonePayments)[0]));
  // the only part-payment: the row goes back to "requested" with its reference
  const p2 = U.planMilestonePaidReversal({ lead: other, index: 0, cm: CASE, actor: UNDO_ACTOR, now: '2026-10-15T15:04:11.000Z' });
  assert.equal(p2.ok, true);
  assert.equal(p2.after.status, 'pending', 'never requested → not requested');
  assert.equal(p2.after.l, undefined);
});

test('undo plan, a milestone settled by a part-payment: goes back to part-paid with the earlier payments, the payment date cleared, Retained corrected', () => {
  const lead = PLAN_LEAD({ 0: { status: 'paid', paidAt: '2026-10-14', method: 'e-transfer', reference: 'C2', requestedAt: '2026-10-01', amountCents: 113000, marked: { by: 'Gauri Berde', at: '2026-10-14T10:00Z', verified: true }, l: [L1, { ...L2, a: 56500 }] } }, { retainerPaid: '2026-10-14', conversionStatus: 'Retained' });
  const p = U.planMilestonePaidReversal({ lead, index: 0, cm: CASE, actor: UNDO_ACTOR, now: '2026-10-15T15:04:11.000Z' });
  assert.equal(p.ok, true, JSON.stringify(p.refusal));
  assert.equal(p.mode, 'milestone');
  assert.equal(p.after.status, 'partial');
  assert.deepEqual(p.after.l, [L1]);
  assert.equal(p.after.paidAt, undefined);
  assert.deepEqual(p.clearKeys, ['retainerPaid']);
  assert.deepEqual(p.conversionStatus, { from: 'Retained', to: 'Retained — Awaiting Payment' });
  assert.equal(p.partsBefore, 2);
  assert.deepEqual(p.willChange[0], 'Milestone goes back to “part-paid ($565.00 of $1,130.00 on file)”');
  assert.ok(!['milestone', 'retainer-date', 'partial-entry'].includes('x'));
  assert.equal(U.validateUndoRequest({ leadId: '13108401448', index: 0, confirmText: 'x', reason: 'ten characters here', expect: { mode: 'partial-entry', entry: 'abc', retainerPaid: '' }, actor: UNDO_ACTOR }), null, 'the new mode is accepted');
});

test('undo execute, a part-payment: one commit, the note says which entry, nothing that pays/onboards/emails is called', async () => {
  const trap = (name) => async () => { throw new Error(`FORBIDDEN: ${name} was called`); };
  const targets = [
    [paymentService, ['recordRetainerPaid', 'maybeMarkRetained', 'advanceCaseToPaid', 'setRetainedBy']],
    [ms, ['markMilestonePaid', 'patchPayment', 'sendMilestoneEtransferRequest']],
    [mail, ['sendEmail']],
  ];
  const restore = [];
  for (const [mod, keys] of targets) for (const k of keys) { const orig = mod[k]; mod[k] = trap(k); restore.push(() => { mod[k] = orig; }); }
  U._resetFlagThrottle();
  const lead = PLAN_LEAD({ 0: { status: 'partial', method: 'e-transfer', reference: 'TDOT-01448-M1', requestedAt: '2026-10-01', amountCents: 113000, l: [L1, L2] } });
  const store = { lead: { ...lead } };
  const calls = [];
  const real = { ...U.io };
  Object.assign(U.io, {
    getLead: async () => ({ ...store.lead }), readCase: async () => ({ ...CASE }),
    commit: async (plan) => { calls.push(['commit', plan.index]); const pay = ms.readPayments(store.lead).pay; pay[plan.index] = plan.after; store.lead.milestonePayments = JSON.stringify(pay); return { conversion: plan.conversionStatus }; },
    writeLeadFields: async (id, f) => { calls.push(['writeLeadFields', f]); Object.assign(store.lead, f); },
    postNote: async (item, body) => { calls.push(['postNote', item, body]); }, notify: async () => { calls.push(['notify']); },
    resolveUserId: async () => null, consultantFor: () => null, adminEmails: () => [], invalidateQueues: () => {},
    withLeadLockOrSkip: async (k, w, f) => f(), isLeadItem: async () => true, findClaimants: async () => [{ id: lead.id, name: lead.fullName }], caseAssignees: async () => ({ personIds: [], teamIds: [] }),
    readSquareOrder: async () => ({ paid: false }), now: () => 1000, nowIso: () => '2026-10-15T15:04:11.000Z', sleep: async () => {},
  });
  try {
    const pv = await U.previewMilestonePaidReversal({ leadId: lead.id, index: 0, actor: UNDO_ACTOR });
    assert.equal(pv.plan.mode, 'partial-entry');
    const res = await U.executeMilestonePaidReversal({ leadId: lead.id, index: 0, confirmText: pv.plan.confirmText, reason: 'The second e-transfer was from another client', expect: pv.plan.expect, actor: UNDO_ACTOR });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.message, 'Removed the $300.00 part-payment. Milestone 1 – Admin Fee (Non-Refundable) now reads “part-paid”.');
    assert.deepEqual(res.removed, { reference: 'C2', paidAt: '2026-10-14', amount: '$300.00' });
    assert.equal(calls.filter((c) => c[0] === 'commit').length, 1);
    assert.equal(calls.filter((c) => c[0] === 'writeLeadFields').length, 0, 'no payment date to clear');
    const e = ms.readPayments(store.lead).pay[0];
    assert.equal(e.status, 'partial'); assert.deepEqual(e.l, [L1]); assert.equal(e.undone.by, 'Faran');
    const leadNote = calls.find((c) => c[0] === 'postNote' && c[1] === lead.id)[2];
    assert.match(leadNote, /a part-payment of \$300\.00 recorded on 2026-10-14, ref C2 by Asmita \(name as typed\)/);
    assert.match(leadNote, /milestone set back to “part-paid”/);
    // running the same undo again: the entry is gone → "already removed", nothing more written
    const again = await U.executeMilestonePaidReversal({ leadId: lead.id, index: 0, confirmText: pv.plan.confirmText, reason: 'The second e-transfer was from another client', expect: pv.plan.expect, actor: UNDO_ACTOR });
    assert.equal(again.already, true);
    assert.equal(calls.filter((c) => c[0] === 'commit').length, 1);
  } finally { Object.assign(U.io, real); restore.forEach((r) => r()); }
});

/* ── review round (2026-10-13): what the adversarial review proved, now refused or handled ── */

test('REVIEW: an e-transfer request on a part-paid milestone is refused (PART_PAID) — the signing / fee-edit auto-request can never ask for the full amount again', async () => {
  const w = world({ pay: JSON.stringify({ 0: { status: 'partial', method: 'e-transfer', reference: 'TDOT-55001-M1', requestedAt: '2026-10-01', amountCents: 113000, l: [{ a: 56500, d: '2026-10-13', r: 'C1', b: 'Asmita' }] } }), lead: { retainerSigned: '2026-10-01' } });
  try {
    await assert.rejects(ms.sendMilestoneEtransferRequest('555001', 0), (e) => e.code === 'PART_PAID' && e.badRequest === true && /\$565\.00 of \$1,130\.00/.test(e.message) && /no request was sent/.test(e.message));
    assert.equal(w.mails.length, 0); assert.equal(w.writes.length, 0); assert.equal(w.notes.length, 0);
    // the automatic path (signing, a Retainer Fee edit): logs, says so on the lead, sends nothing
    const rs2 = require('../src/services/retainerService2');
    await rs2.maybeSendRetainerPaymentLink('555001', { warnIfSent: true });
    await rs2.maybeSendRetainerPaymentLink('555001', { notifyIfMissing: true });
    assert.equal(w.mails.length, 0, 'no email for the full amount');
    assert.equal(w.writes.length, 0, 'the row is untouched (requestedAt, amountCents kept)');
    assert.equal(w.notes.length, 2);
    for (const n of w.notes) assert.match(n, /^ℹ First-milestone e-transfer request NOT sent — A part-payment is already on file for that milestone \(\$565\.00 of \$1,130\.00\)/);
  } finally { w.restore(); }
});

test('REVIEW: the same e-transfer recorded twice is refused (DUPLICATE_PART) — same bank reference, or same amount on the same day without one; the request reference does not count; a distinct reference is accepted', async () => {
  const today = ms.todayISO();
  const w = world({ pay: JSON.stringify({ 0: { status: 'partial', method: 'e-transfer', reference: 'TDOT-55001-M1', requestedAt: '2026-10-01', amountCents: 113000, l: [{ a: 56500, d: today, r: 'C1AeUbQTRwZy', b: 'Asmita', v: false, t: '2026-10-13T16:47Z' }] } }) });
  try {
    // the same reference — even though the amount would "settle" the milestone
    await assert.rejects(ms.markMilestonePaid('555001', 0, { amountCents: 56500, reference: 'C1AeUbQTRwZy', actor: ACTOR }), (e) => e.code === 'DUPLICATE_PART' && /reference C1AeUbQTRwZy is already on file/.test(e.message) && /cannot be recorded twice/.test(e.message) && /by Asmita/.test(e.message));
    // the same amount today with no reference
    await assert.rejects(ms.markMilestonePaid('555001', 0, { amountCents: 56500, actor: ACTOR }), (e) => e.code === 'DUPLICATE_PART' && /looks like the same e-transfer/.test(e.message) && /enter that transfer's own bank reference/.test(e.message));
    // the milestone's own request reference is what the client was told to write — not distinguishing
    await assert.rejects(ms.markMilestonePaid('555001', 0, { amountCents: 56500, reference: 'TDOT-55001-M1', actor: ACTOR }), (e) => e.code === 'DUPLICATE_PART');
    assert.equal(w.writes.length, 0); assert.equal(w.notes.length, 0);
    assert.equal(w.retainerPaidCalls, 0, 'a duplicate never settles milestone 1');
    // a different amount today, no reference: a part-payment
    assert.equal((await ms.markMilestonePaid('555001', 0, { amountCents: 10000, actor: ACTOR })).settled, false);
    // the same amount again, with its own bank reference: a genuine second transfer
    assert.equal((await ms.markMilestonePaid('555001', 0, { amountCents: 10000, reference: 'C1AfQQQ', actor: ACTOR })).settled, false);
    assert.deepEqual(w.row(0).l.map((x) => x.a), [56500, 10000, 10000]);
  } finally { w.restore(); }
});

test('REVIEW: the plan amended below what is on file — an amount is refused (NOTHING_OWED); "Mark settled" closes it on the money already there: no new ledger entry, no receipt, milestone 1 starts the retainer-paid chain', async () => {
  const AMENDED = JSON.stringify([{ label: 'Milestone 1 – Admin Fee (Non-Refundable)', amountCents: 50000, trigger: 'Retainer Confirmed', locked: true }, { label: 'Milestone 2 – Before Submission', amountCents: 100000, trigger: 'Internal Review' }]);
  const w = world({ pay: JSON.stringify({ 0: { status: 'partial', method: 'e-transfer', reference: 'TDOT-55001-M1', requestedAt: '2026-10-01', amountCents: 113000, l: [{ a: 56500, d: '2026-10-13', r: 'C1', b: 'Asmita', v: false, t: '2026-10-13T16:47Z' }] } }), lead: { retainerFee: '1500', retainerMilestones: AMENDED } });
  try {
    const st = ms.milestoneStates(LEAD({ milestonePayments: w.stored, retainerFee: '1500', retainerMilestones: AMENDED }), '', []);
    assert.deepEqual([st[0].status, st[0].totalCents, st[0].paidCents, st[0].balanceCents], ['partial', 56500, 56500, 0]);
    for (const n of [1, 100, 56500]) await assert.rejects(ms.markMilestonePaid('555001', 0, { amountCents: n, actor: ACTOR }), (e) => e.code === 'NOTHING_OWED' && /\$565\.00 already on file covers its \$565\.00/.test(e.message) && /Mark settled/.test(e.message));
    await assert.rejects(ms.markMilestonePaid('555001', 0, { actor: ACTOR }), (e) => e.code === 'NOTHING_OWED', 'no amount and no explicit settle: refused too');
    assert.equal(w.writes.length, 0);
    const r = await ms.markMilestonePaid('555001', 0, { settle: true, actor: { name: 'Gauri Berde', email: 'g@x.com', verified: true } });
    assert.deepEqual([r.settled, r.amountCents, r.paidCents, r.balanceCents, r.totalCents], [true, 0, 56500, 0, 56500]);
    const e = w.row(0);
    assert.equal(e.status, 'paid');
    assert.match(e.paidAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(e.l.length, 1, 'no $0 entry');
    assert.equal(e.reference, 'TDOT-55001-M1', 'the request reference is kept when none is typed');
    assert.deepEqual([e.marked.by, e.marked.verified], ['Gauri Berde', true]);
    assert.equal(w.retainerPaidCalls, 1);
    assert.equal(w.notes.length, 1);
    assert.match(w.notes[0], /^✅ <b>Milestone settled<\/b> — Milestone 1 – Admin Fee \(Non-Refundable\): the \$565\.00 already on file covers its \$565\.00 \(the plan was amended\)\. No new payment was received\. Recorded by Gauri Berde\.$/);
    assert.equal(w.mails.length, 0);
    // the action's message for it (the dialog sends no amount)
    const cps = require('../src/services/consultantPortalService');
    assert.deepEqual((await cps.validateAction('markMilestonePaid', JSON.stringify({ index: 0, reference: '', amountCents: null, settle: true }))).normalized, { index: 0, reference: '', amountCents: null, settle: true });
    const r3 = stub(ms, 'markMilestonePaid', async () => ({ ok: true, label: 'M1', settled: true, amountCents: 0, paidCents: 56500, balanceCents: 0, totalCents: 56500 }));
    try {
      const a = await cps.applyAction({ leadId: '555001', action: 'markMilestonePaid', value: JSON.stringify({ index: 0, amountCents: null, settle: true }), staffName: 'Asmita' });
      assert.equal(a.message, 'Recorded — M1 marked settled: the $565.00 already on file covers it; no new payment was received.');
    } finally { r3(); }
  } finally { w.restore(); }
});

test('REVIEW: a row Square marked paid over part-payments — counts as paid in full, every part-payment stays visible (tooltip, timeline), and undo keeps them all', () => {
  const sq = { status: 'paid', paidAt: '2026-10-14', txnId: 'SQ1', l: [{ a: 56500, d: '2026-10-13', r: 'C1', b: 'Asmita' }] };
  assert.equal(ms.paidCentsOf(sq, 113000), 113000, 'a paid row is at least its total');
  assert.equal(ms.settlingIndexOf(sq), -1, 'no ledger entry settled it');
  const byParts = { status: 'paid', marked: { by: 'G', at: '2026-10-14T10:00Z' }, l: [{ a: 56500, t: '2026-10-13T16:47Z' }, { a: 56500, t: '2026-10-14T10:00Z' }] };
  assert.equal(ms.settlingIndexOf(byParts), 1, 'settled by parts: the entry written with the mark');
  assert.equal(ms.settlingIndexOf({ status: 'partial', l: [{ a: 56500 }] }), -1);
  assert.equal(ms.settlingIndexOf({ status: 'paid', paidAt: '2026-10-01' }), -1);
  assert.equal(ms.paidCentsOf(byParts, 135600), 113000, 'a complete ledger is the truth even after the plan is amended up');
  assert.equal(ms.paidCentsOf(byParts, 100000), 113000, 'and after it is amended down');
  const st = ms.milestoneStates(LEAD({ milestonePayments: JSON.stringify({ 0: sq, 1: byParts }) }), '', []);
  assert.deepEqual([st[0].paidCents, st[0].balanceCents, st[0].settlingIndex, st[1].settlingIndex], [113000, 0, -1, 1]);
  const { buildTimeline } = require('../src/services/caseCockpitService');
  const ev = buildTimeline({ lead: {}, milestones: [{ index: 0, label: 'M1', status: 'paid', paidAt: '2026-10-14', payments: st[0].payments, settlingIndex: -1 }] }).map((e) => `${e.date} ${e.title}`);
  assert.deepEqual(ev, ['2026-10-13 Part-payment — M1', '2026-10-14 Paid — M1']);
  const js = require('../src/routes/adminShared').PAYMENT_UI_JS;
  const fn = new Function(js + '; return { tdotPayAuditText: tdotPayAuditText };')();
  assert.match(fn.tdotPayAuditText({ status: 'paid', payments: st[0].payments, settlingIndex: -1 }), /Part-payment \$565\.00 on 2026-10-13 · ref C1 · by Asmita/);
  const tip = fn.tdotPayAuditText({ status: 'paid', payments: [{ amountCents: 56500, paidAt: 'dayA' }, { amountCents: 56500, paidAt: 'dayB' }], settlingIndex: 1 });
  assert.ok(/on dayA/.test(tip) && !/on dayB/.test(tip), 'the settling entry is the "Marked paid" line, not a part-payment');
  // undo (milestone mode) with no settling entry: the paid mark comes off, the real part-payment stays
  const lead = PLAN_LEAD({ 0: { status: 'paid', paidAt: '2026-10-14', method: 'e-transfer', reference: 'R', marked: { by: 'X', at: '2026-10-14T10:00Z', verified: true }, l: [L1] } }, { retainerPaid: '2026-10-14', conversionStatus: 'Retained' });
  const p = U.planMilestonePaidReversal({ lead, index: 0, cm: CASE, actor: UNDO_ACTOR, now: '2026-10-15T15:04:11.000Z' });
  assert.equal(p.ok, true, JSON.stringify(p.refusal));
  assert.deepEqual([p.mode, p.removing, p.after.status, p.after.l], ['milestone', null, 'partial', [L1]]);
  assert.deepEqual(p.willChange[0], 'Milestone goes back to “part-paid ($565.00 of $1,130.00 on file)”');
  assert.ok(!p.willChange.some((x) => /that settled it is removed/.test(x)));
});

test('REVIEW: "Flag as wrong" on a part-paid row says what is on file and which part-payment came last; the RCIC is not asked to hold', async () => {
  U._resetFlagThrottle();
  const lead = PLAN_LEAD({ 0: { status: 'partial', method: 'e-transfer', reference: 'TDOT-01448-M1', requestedAt: '2026-10-01', amountCents: 113000, l: [L1, L2] } });
  const calls = [];
  const real = { ...U.io };
  Object.assign(U.io, {
    getLead: async () => ({ ...lead }), readCase: async () => ({ ...CASE }),
    postNote: async (item, body) => { calls.push(['postNote', item, body]); }, notify: async () => { calls.push(['notify']); },
    resolveUserId: async () => null, consultantFor: () => null, adminEmails: () => [], invalidateQueues: () => {},
    withLeadLockOrSkip: async (k, w, f) => f(), isLeadItem: async () => true, findClaimants: async () => [{ id: lead.id, name: lead.fullName }], caseAssignees: async () => ({ personIds: [], teamIds: [] }),
    readSquareOrder: async () => ({ paid: false }), now: () => 1000, nowIso: () => '2026-10-15T15:04:11.000Z', sleep: async () => {},
  });
  try {
    const res = await U.flagPaymentError({ leadId: lead.id, index: 0, actor: { name: 'Kamalpreet', email: '' }, note: 'The second e-transfer was from another client' });
    assert.equal(res.ok, true, JSON.stringify(res));
    const note = calls.find((c) => c[0] === 'postNote')[2];
    assert.match(note, /recorded as part-paid — \$865\.00 on file \(last: \$300\.00 on 2026-10-14, ref C2 by Asmita \(name as typed\)\)/);
    assert.match(note, /use “Undo last part-payment…” on the payment row/);
    assert.ok(!/not recorded as paid/.test(note));
    assert.ok(!/countersign/.test(note), 'a part-payment cannot start onboarding');
  } finally { Object.assign(U.io, real); U._resetFlagThrottle(); }
});

test('REVIEW: the dialog — nothing owed: no amount box, "Mark settled", the server gets no amount; still plain template text', () => {
  const js = require('../src/routes/adminShared').PAYMENT_UI_JS;
  assert.ok(!/[`\\]|\$\{/.test(js), 'plain template text');
  const mark = js.slice(js.indexOf('function tdotOpenMarkPaidModal('), js.indexOf('function payList('));
  assert.ok(mark.includes("var nothingOwed = m.status === 'partial' && paidSoFar > 0 && balance === 0;"));
  assert.ok(mark.includes("(nothingOwed ? 'Mark settled for ' : 'Record payment for ')"));
  assert.ok(mark.includes("var cents = amtEl ? payParseCents(amtEl.value) : null;"));
  assert.ok(mark.includes('Nothing more is owed — the <b>'));
  assert.ok(mark.includes("if (amtEl) { amtEl.oninput = refreshHint; refreshHint(); }"));
  new Function(js);
});

test('REVIEW 2: "Mark settled" then undo — the real part-payment is kept (the settling entry is known by the mark, not the sum); readers list it; a stale "Mark settled" with a balance again is refused; no amount on a part-paid row is refused', async () => {
  const AMENDED = JSON.stringify([{ label: 'Milestone 1 – Admin Fee (Non-Refundable)', amountCents: 50000, trigger: 'Retainer Confirmed', locked: true }, { label: 'Milestone 2 – Before Submission', amountCents: 100000, trigger: 'Internal Review' }]);
  const w = world({ pay: JSON.stringify({ 0: { status: 'partial', method: 'e-transfer', reference: 'TDOT-55001-M1', requestedAt: '2026-10-01', amountCents: 113000, l: [L1] } }), lead: { retainerFee: '1500', retainerMilestones: AMENDED } });
  let settledRow;
  try {
    await ms.markMilestonePaid('555001', 0, { settle: true, actor: { name: 'Gauri Berde', email: 'g@x.com', verified: true } });
    settledRow = w.row(0);
    assert.equal(settledRow.status, 'paid'); assert.deepEqual(settledRow.l, [L1]);
    assert.equal(ms.ledgerComplete(settledRow), false, 'the ledger is not the whole story — nothing was written with the mark');
    assert.equal(ms.settlingIndexOf(settledRow), -1);
    assert.equal(ms.paidCentsOf(settledRow, 56500), 56500);
    const st = ms.milestoneStates(LEAD({ milestonePayments: w.stored, retainerFee: '1500', retainerMilestones: AMENDED }), '', []);
    assert.deepEqual([st[0].status, st[0].paidCents, st[0].balanceCents, st[0].settlingIndex], ['paid', 56500, 0, -1]);
    const { buildTimeline } = require('../src/services/caseCockpitService');
    const ev = buildTimeline({ lead: {}, milestones: [{ ...st[0], label: 'M1' }] }).map((e) => e.title);
    assert.ok(ev.includes('Part-payment — M1') && ev.includes('Paid — M1'), ev.join(' | '));
  } finally { w.restore(); }
  // undo (milestone mode): the paid mark comes off, the $565 stays, the row goes back to part-paid
  const lead = PLAN_LEAD({ 0: settledRow }, { retainerFee: '1500', retainerMilestones: AMENDED, retainerPaid: settledRow.paidAt, conversionStatus: 'Retained' });
  const p = U.planMilestonePaidReversal({ lead, index: 0, cm: CASE, actor: UNDO_ACTOR, now: '2026-10-15T15:04:11.000Z' });
  assert.equal(p.ok, true, JSON.stringify(p.refusal));
  assert.deepEqual([p.mode, p.removing, p.after.status, p.after.l], ['milestone', null, 'partial', [L1]]);
  assert.equal(p.willChange[0], 'Milestone goes back to “part-paid ($565.00 of $565.00 on file)”');
  // settled by parts: undo removes exactly the entry written with the mark, and says so
  const byParts = PLAN_LEAD({ 0: { status: 'paid', paidAt: '2026-10-14', method: 'e-transfer', reference: 'C2', requestedAt: '2026-10-01', amountCents: 113000, marked: { by: 'Gauri Berde', at: '2026-10-14T10:00Z', verified: true }, l: [L1, { ...L2, a: 56500 }] } }, { retainerPaid: '2026-10-14', conversionStatus: 'Retained' });
  const p2 = U.planMilestonePaidReversal({ lead: byParts, index: 0, cm: CASE, actor: UNDO_ACTOR, now: '2026-10-15T15:04:11.000Z' });
  assert.equal(p2.removing.reference, 'C2'); assert.deepEqual(p2.after.l, [L1]);
  assert.ok(p2.willChange.includes('The $565.00 payment of 2026-10-14 that settled it is removed from the record; the earlier part-payments stay'), p2.willChange.join(' | '));
  // a stale "Mark settled" (the plan is back at $1,130, so a balance exists) is refused; so is "no amount" on a part-paid row
  const w2 = world({ pay: JSON.stringify({ 0: { status: 'partial', method: 'e-transfer', reference: 'TDOT-55001-M1', l: [L1] } }) });
  try {
    await assert.rejects(ms.markMilestonePaid('555001', 0, { settle: true, actor: ACTOR }), (e) => e.code === 'SETTLE_STALE' && /changed since you opened this/.test(e.message));
    await assert.rejects(ms.markMilestonePaid('555001', 0, { actor: ACTOR }), (e) => e.code === 'AMOUNT_REQUIRED' && /enter the amount received/.test(e.message));
    assert.equal(w2.writes.length, 0); assert.equal(w2.retainerPaidCalls, 0);
    // a row with no part-payments keeps today's no-amount "Mark paid"
    assert.equal((await ms.markMilestonePaid('555001', 1, { reference: 'B', actor: ACTOR })).settled, true);
  } finally { w2.restore(); }
});

test('REVIEW 2: dates are the Toronto day — a payment at 8:30 pm Toronto is dated that evening; the same amount an hour apart across UTC midnight is one day, so a duplicate', async () => {
  const RealDate = Date;
  const freeze = (iso) => { const T = RealDate.parse(iso); global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } }; };
  const w = world();
  try {
    freeze('2026-10-13T23:30:00.000Z');   // 7:30 pm Toronto (EDT)
    assert.equal(ms.todayISO(), '2026-10-13');
    await ms.markMilestonePaid('555001', 0, { amountCents: 56500, actor: ACTOR });
    assert.equal(w.row(0).l[0].d, '2026-10-13');
    freeze('2026-10-14T00:30:00.000Z');   // 8:30 pm Toronto, the same evening
    assert.equal(ms.todayISO(), '2026-10-13');
    await assert.rejects(ms.markMilestonePaid('555001', 0, { amountCents: 56500, actor: ACTOR }), (e) => e.code === 'DUPLICATE_PART');
    assert.equal(w.retainerPaidCalls, 0);
  } finally { global.Date = RealDate; w.restore(); }
});

test('REVIEW 2: client portal — a part-paid milestone the plan now covers asks the client for nothing', () => {
  const src = fs.readFileSync(require.resolve('../src/services/clientPortalService'), 'utf8');
  assert.ok(src.includes('we received covers this milestone. Our team will confirm it shortly.'));
  assert.ok(src.includes('Use “Mark settled” on the payment row.'));
});
