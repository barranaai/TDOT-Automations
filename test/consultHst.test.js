'use strict';

// HST on consultation checkouts (meeting decision 2026-08-13): the payment
// link itemizes fee + HST, every fee the client sees says so, and the webhook
// reconciliation accepts BOTH eras (pre-tax links paid flat; new links paid
// fee + HST). The consult agreement states the amount actually collected.

const test   = require('node:test');
const assert = require('node:assert/strict');

const bookingService = require('../src/services/bookingService');
const leadService    = require('../src/services/leadService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

test('consultTotalWithTax: 13% on the default fee = $226.00', () => {
  assert.equal(bookingService.CONSULT_HST_PCT, 13, 'Ontario HST default');
  assert.equal(bookingService.consultTotalWithTax(20000), 22600);
  assert.equal(bookingService.consultTotalWithTax(30000), 33900);
  assert.equal(bookingService.consultTotalWithTax(6000), 6780);
});

test('createCheckout with taxPct sends an order with an ADDITIVE HST line (not quick_pay)', async () => {
  const axios = require('axios');
  let sent = null;
  const restore = [
    stub(axios, 'post', async (url, payload) => { sent = payload; return { data: { payment_link: { url: 'https://sq/x', order_id: 'ord1' } } }; }),
    stub(leadService, 'updateLead', async () => {}),
  ];
  try {
    await bookingService.createCheckout({ leadId: '1', amount: 20000, description: 'Consult', taxPct: 13 });
    assert.ok(sent.order, 'order payload used');
    assert.ok(!sent.quick_pay, 'quick_pay replaced');
    assert.equal(sent.order.line_items[0].base_price_money.amount, 20000, 'line item is the PRE-tax fee');
    assert.deepEqual(sent.order.taxes[0], { uid: 'hst', name: 'HST (13%)', type: 'ADDITIVE', percentage: '13', scope: 'ORDER' });
    assert.equal(sent.payment_note, 'lead-1', 'webhook fallback routing note preserved');

    sent = null;
    await bookingService.createCheckout({ leadId: '2', amount: 20000, description: 'Consult' });
    assert.ok(sent.quick_pay && !sent.order, 'no taxPct → legacy quick_pay unchanged');
  } finally { restore.forEach((r) => r()); }
});

test('reconciliation accepts both eras and records the actual paid total', async () => {
  const writes = [];
  const restore = stub(leadService, 'updateLead', async (id, f) => { writes.push(f); });
  const lead = (opt) => ({ id: '9', consultOption: JSON.stringify(opt) });
  try {
    // with-tax payment on the recorded option → paidCents remembered, option kept
    await bookingService.reconcileConsultOptionWithPayment(lead({ durationMin: 30, feeCents: 20000 }), 22600);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].consultOption).paidCents, 22600);
    assert.equal(JSON.parse(writes[0].consultOption).feeCents, 20000, 'pre-tax fee stays the fee');
    // pre-tax legacy payment still matches — no correction churn
    writes.length = 0;
    await bookingService.reconcileConsultOptionWithPayment(lead({ durationMin: 30, feeCents: 20000, paidCents: 20000 }), 20000);
    assert.equal(writes.length, 0, 'already recorded — nothing rewritten');
  } finally { restore(); }
});

test('the consult agreement states the collected amount (incl. HST) when recorded', () => {
  const { buildConsultAgreementData } = require('../src/services/consultAgreementService');
  const withPaid = buildConsultAgreementData({ fullName: 'T', email: 't@x.com', residentialAddress: '1 Bay',
    consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 }) });
  assert.match(withPaid.data.amountPaid, /226\.00 \(incl\. HST\)$/);
  const legacy = buildConsultAgreementData({ fullName: 'T', email: 't@x.com', residentialAddress: '1 Bay',
    consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000 }) });
  assert.match(legacy.data.amountPaid, /200\.00$/, 'no recorded payment → the pre-tax fee (what legacy clients really paid)');
});

test('reconciler recovery passes the paid amount through to confirmSlot (paidCents recorded)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/paymentReconciler'), 'utf8');
  assert.match(src, /confirmSlot\(leadId, payment\.id, undefined,\s*\n?\s*Number\(payment\.amount_money && payment\.amount_money\.amount\)\)/,
    'recovered consult payments must record what was actually collected');
});

test('booking idempotency key is versioned by the EFFECTIVE per-lead HST rate (no cross-deploy or exemption collision)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/routes/phase2'), 'utf8');
  // The key carries the tax rate ACTUALLY applied to this lead (0 when the
  // client is outside Canada), so an exempt lead never collides with a
  // taxed link for the same slot/fee, and vice-versa.
  assert.match(src, /-t\$\{leadTaxPct\}/, 'key changes with the effective per-lead tax rate');
  assert.match(src, /const leadTaxPct = bookingService\.consultHstPctForLead\(lead\)/);
});

// ── Outside-Canada HST exemption (Melanie, 2026-08-24) ──────────────────────
test('outside-Canada leads are HST-exempt; Canada/blank keep HST (safe default)', () => {
  // Positive foreign signal → exempt (0%).
  for (const c of ['India', 'United States', 'USA', 'Pakistan', 'United Kingdom', 'nigeria']) {
    assert.equal(bookingService.consultHstPctForLead({ country: c }), 0, `${c} → HST-exempt`);
    assert.equal(bookingService.isConsultHstExemptCountry(c), true);
  }
  // Canada in any casing/alias, AND blank/unknown → HST applies (never under-charge).
  for (const c of ['Canada', 'canada', '  CANADA ', 'CA', 'can', '', null, undefined]) {
    assert.equal(bookingService.consultHstPctForLead({ country: c }), bookingService.CONSULT_HST_PCT, `${JSON.stringify(c)} → HST applies`);
  }
  assert.equal(bookingService.isConsultHstExemptCountry(''), false, 'blank is NOT exempt (safe default)');
});

test('consultTotalWithTaxForLead: fee-only outside Canada, fee+HST inside/unknown', () => {
  assert.equal(bookingService.consultTotalWithTaxForLead(20000, { country: 'India' }), 20000, 'outside → fee only');
  assert.equal(bookingService.consultTotalWithTaxForLead(20000, { country: 'Canada' }), 22600, 'inside → +13%');
  assert.equal(bookingService.consultTotalWithTaxForLead(20000, { country: '' }), 22600, 'unknown → +13% (safe)');
});

test('booking checkout passes the per-lead tax to createCheckout', () => {
  const src = require('fs').readFileSync(require.resolve('../src/routes/phase2'), 'utf8');
  assert.match(src, /taxPct: leadTaxPct/, 'checkout uses the effective per-lead tax, not the flat rate');
});
