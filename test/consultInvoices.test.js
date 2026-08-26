'use strict';

// Consultation payments as Square INVOICES (team request 2026-08-25): the
// payment must appear under the team's Invoices tab. Flag-gated
// (SQUARE_CONSULT_INVOICES=1); ANY invoice-path failure falls back to the
// payment link so a client can always pay. Design pins from the care-point
// analysis: SHARE_MANUALLY (no Square emails), due today, auto-numbering
// (never fork the team's manual invoice sequence), order metadata carries
// lead_id (the webhook/reconciler net) + booking_key (reuse identity).

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const axios = require('axios');
const bookingService = require('../src/services/bookingService');
const leadService    = require('../src/services/leadService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const OPTION = { durationMin: 30, feeCents: 20000, variationId: 'VARX' };
const LEAD = { id: '9001', fullName: 'Test Client', email: 't@x.com', phone: '4165551234', country: 'Canada', consultOption: '' };

function invoiceStubs({ existing = null, calls }) {
  return [
    stub(axios, 'post', async (url, body) => {
      calls.push({ m: 'post', url, body });
      if (url.includes('/v2/customers/search')) return { data: { customers: [{ id: 'CUST1' }] } };
      if (url.endsWith('/v2/orders')) return { data: { order: { id: 'ORD1' } } };
      if (url.endsWith('/v2/invoices')) return { data: { invoice: { id: 'INV1', version: 0 } } };
      if (url.includes('/publish')) return { data: { invoice: { id: 'INV1', invoice_number: '001200', public_url: 'https://squareup.com/pay-invoice/INV1' } } };
      if (url.includes('/cancel')) return { data: { invoice: { id: (existing || {}).id, status: 'CANCELED' } } };
      throw new Error('unexpected POST ' + url);
    }),
    stub(axios, 'get', async (url) => {
      calls.push({ m: 'get', url });
      if (url.includes('/v2/invoices/') && existing) return { data: { invoice: existing } };
      if (url.includes('/v2/invoices/')) { const e = new Error('404'); e.response = { status: 404 }; throw e; }
      throw new Error('unexpected GET ' + url);
    }),
    stub(leadService, 'updateLead', async (id, fields) => { calls.push({ m: 'update', id, fields }); }),
  ];
}

test('invoice checkout: customer → order (metadata + HST) → invoice (SHARE_MANUALLY, due today, auto-number) → publish', async () => {
  const calls = [];
  const restore = invoiceStubs({ calls });
  try {
    const r = await bookingService.createConsultInvoiceCheckout({
      lead: LEAD, leadId: '9001', option: OPTION, consultantName: 'Shermin Teymouri Mofrad',
      slotDate: '2026-09-20', slotTime: '10:45', taxPct: 13,
      description: 'Consultation (30 min) with TDOT Immigration — 2026-09-20 10:45',
    });
    assert.equal(r.url, 'https://squareup.com/pay-invoice/INV1');

    const order = calls.find((c) => c.url && c.url.endsWith('/v2/orders')).body.order;
    assert.equal(order.metadata.lead_id, '9001', 'webhook/reconciler net');
    assert.match(order.metadata.booking_key, /^lead-9001-2026-09-20-1045-30-20000-t13$/);
    assert.equal(order.line_items[0].base_price_money.amount, 20000, 'pre-tax fee');
    assert.deepEqual(order.taxes[0], { uid: 'hst', name: 'HST (13%)', type: 'ADDITIVE', percentage: '13', scope: 'ORDER' });

    const inv = calls.find((c) => c.url && c.url.endsWith('/v2/invoices')).body.invoice;
    assert.equal(inv.delivery_method, 'SHARE_MANUALLY', 'Square must send NO email/reminders');
    assert.equal(inv.invoice_number, undefined, 'auto-number into the team’s existing sequence');
    assert.equal(inv.payment_requests[0].request_type, 'BALANCE');
    assert.match(inv.payment_requests[0].due_date, /^\d{4}-\d{2}-\d{2}$/, 'due today (pay-now)');
    assert.equal(inv.accepted_payment_methods.card, true);
    assert.equal(inv.store_payment_method_enabled, false);

    const upd = calls.find((c) => c.m === 'update');
    assert.equal(upd.fields.squareConsultOrderId, 'ORD1', 'webhook matches by the same column as payment links');
    const stored = JSON.parse(upd.fields.consultOption);
    assert.equal(stored.invoiceId, 'INV1');
    assert.equal(stored.consultant, 'Shermin Teymouri Mofrad', 'fresh consultant, never a stale one');
    assert.equal(stored.feeCents, 20000);
  } finally { restore.forEach((r) => r()); }
});

test('HST-exempt lead → order carries NO tax line', async () => {
  const calls = [];
  const restore = invoiceStubs({ calls });
  try {
    await bookingService.createConsultInvoiceCheckout({
      lead: { ...LEAD, country: 'India' }, leadId: '9001', option: OPTION, consultantName: 'X',
      slotDate: '2026-09-20', slotTime: '10:45', taxPct: 0, description: 'Consult',
    });
    const order = calls.find((c) => c.url && c.url.endsWith('/v2/orders')).body.order;
    assert.equal(order.taxes, undefined, 'no HST line for outside-Canada');
    assert.match(order.metadata.booking_key, /-t0$/, 'key carries the effective rate');
  } finally { restore.forEach((r) => r()); }
});

test('re-submit with the SAME booking → reuses the existing unpaid invoice (no new artifact)', async () => {
  const calls = [];
  const key = 'lead-9001-2026-09-20-1045-30-20000-t13';
  const restore = invoiceStubs({
    calls,
    existing: { id: 'INVOLD', version: 3, status: 'UNPAID', public_url: 'https://squareup.com/pay-invoice/INVOLD' },
  });
  try {
    const lead = { ...LEAD, consultOption: JSON.stringify({ ...OPTION, invoiceId: 'INVOLD', invoiceBookingKey: key }) };
    const r = await bookingService.createConsultInvoiceCheckout({
      lead, leadId: '9001', option: OPTION, consultantName: 'X',
      slotDate: '2026-09-20', slotTime: '10:45', taxPct: 13, description: 'Consult',
    });
    assert.equal(r.reused, true);
    assert.equal(r.url, 'https://squareup.com/pay-invoice/INVOLD');
    assert.ok(!calls.some((c) => c.url && c.url.endsWith('/v2/orders')), 'no second order');
  } finally { restore.forEach((r) => r()); }
});

test('changed slot/duration → CANCELS the old unpaid invoice, then issues the new one', async () => {
  const calls = [];
  const restore = invoiceStubs({
    calls,
    existing: { id: 'INVOLD', version: 3, status: 'UNPAID', public_url: 'https://squareup.com/pay-invoice/INVOLD' },
  });
  try {
    const lead = { ...LEAD, consultOption: JSON.stringify({ ...OPTION, invoiceId: 'INVOLD', invoiceBookingKey: 'lead-9001-OLD-KEY' }) };
    const r = await bookingService.createConsultInvoiceCheckout({
      lead, leadId: '9001', option: OPTION, consultantName: 'X',
      slotDate: '2026-09-20', slotTime: '10:45', taxPct: 13, description: 'Consult',
    });
    const cancelIdx = calls.findIndex((c) => c.url && c.url.includes('/cancel'));
    const orderIdx  = calls.findIndex((c) => c.url && c.url.endsWith('/v2/orders'));
    assert.ok(cancelIdx !== -1 && orderIdx !== -1 && cancelIdx < orderIdx, 'old invoice retired BEFORE the new one exists');
    assert.equal(r.url, 'https://squareup.com/pay-invoice/INV1');
  } finally { restore.forEach((r) => r()); }
});

test('already-PAID invoice → throws alreadyPaid (route shows the booking-done page, never a second payable)', async () => {
  const calls = [];
  const restore = invoiceStubs({ calls, existing: { id: 'INVOLD', version: 3, status: 'PAID' } });
  try {
    const lead = { ...LEAD, consultOption: JSON.stringify({ ...OPTION, invoiceId: 'INVOLD', invoiceBookingKey: 'k' }) };
    await assert.rejects(
      bookingService.createConsultInvoiceCheckout({
        lead, leadId: '9001', option: OPTION, consultantName: 'X',
        slotDate: '2026-09-20', slotTime: '10:45', taxPct: 13, description: 'Consult',
      }),
      (e) => e.alreadyPaid === true
    );
  } finally { restore.forEach((r) => r()); }
});

test('route: flag-gated, falls back to the payment link on ANY invoice failure; flag off = payment link', () => {
  const src = fs.readFileSync(require.resolve('../src/routes/phase2'), 'utf8');
  const idx = src.indexOf('consultInvoicesEnabled()');
  assert.ok(idx > 0, 'flag checked in the route');
  const block = src.slice(idx, idx + 1200);
  assert.match(block, /createConsultInvoiceCheckout/);
  assert.match(block, /falling back to payment link/, 'invoice failure must not block a paying client');
  assert.match(block, /e\.alreadyPaid/, 'paid-race shows the done page');
  // The payment-link call survives AFTER the gated block (the fallback + flag-off path).
  assert.ok(src.indexOf('bookingService.createCheckout({', idx) > idx, 'payment link remains the fallback');
  // Flag defaults OFF.
  assert.equal(bookingService.consultInvoicesEnabled(), false, 'flag must default off until the team flips it');
});

test('webhook + reconciler both carry the order-metadata net for invoice payments', () => {
  const b = fs.readFileSync(require.resolve('../src/services/bookingService'), 'utf8');
  const wh = b.slice(b.indexOf('async function handleSquarePaymentWebhook'), b.indexOf('async function reconcileConsultOptionWithPayment'));
  assert.match(wh, /retrieveOrderLeadMeta\(orderId\)/, 'webhook last-resort routes via order metadata');
  const r = fs.readFileSync(require.resolve('../src/services/paymentReconciler'), 'utf8');
  assert.match(r, /retrieveOrderLeadMeta\(payment\.order_id\)/, 'reconciler matches invoice payments');
  assert.match(r, /_foreignOrders/, 'foreign payments cached — one lookup per process, not per sweep');
});

test('lifecycle: expired holds and careful-delete both retire outstanding invoices', () => {
  const b = fs.readFileSync(require.resolve('../src/services/bookingService'), 'utf8');
  const rel = b.slice(b.indexOf('async function releaseExpiredSlots'), b.indexOf('async function holdSlot') > 0 ? b.length : b.length);
  assert.match(b.slice(b.indexOf('async function releaseExpiredSlots')), /cancelInvoice\(opt\.invoiceId\)/, 'expired hold cancels the invoice');
  const d = fs.readFileSync(require.resolve('../src/services/deletionService'), 'utf8');
  assert.match(d, /cancelInvoice\(l\.invoiceId\)/, 'careful-delete cancels the invoice');
  assert.match(d, /invoiceId: \(\(\) =>/, 'lead projections carry the invoice id');
});

test('cancelInvoice: paid/canceled/missing are all safe no-ops', async () => {
  const sqInv = require('../src/services/squareInvoicesService');
  const restoreGet = stub(axios, 'get', async () => ({ data: { invoice: { id: 'I', version: 2, status: 'PAID' } } }));
  const posts = [];
  const restorePost = stub(axios, 'post', async (url) => { posts.push(url); return { data: {} }; });
  try {
    const r = await sqInv.cancelInvoice('I');
    assert.equal(r.status, 'PAID');
    assert.equal(posts.length, 0, 'a paid invoice is never sent a cancel');
  } finally { restoreGet(); restorePost(); }
});

// ── Pins from the 2026-08-25 adversarial review (25-agent money-path pass) ──

test('transient invoice-retrieve failure THROWS (falls back to link) — never mints while state is unknown', async () => {
  const calls = [];
  const restorePost = stub(axios, 'post', async (url) => { calls.push(url); throw new Error('should not reach Square writes'); });
  const restoreGet = stub(axios, 'get', async () => { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; throw e; });
  const restoreUpd = stub(leadService, 'updateLead', async () => {});
  try {
    const lead = { ...LEAD, consultOption: JSON.stringify({ ...OPTION, invoiceId: 'INVX', invoiceBookingKey: 'k' }) };
    await assert.rejects(bookingService.createConsultInvoiceCheckout({
      lead, leadId: '9001', option: OPTION, consultantName: 'X',
      slotDate: '2026-09-20', slotTime: '10:45', taxPct: 13, description: 'Consult',
    }));
    assert.equal(calls.length, 0, 'no order/invoice minted while the old invoice state is unknown');
  } finally { restorePost(); restoreGet(); restoreUpd(); }
});

test('reuse path RE-PERSISTS the invoice identity (the route’s option persist just wiped it)', async () => {
  const calls = [];
  const key = 'lead-9001-2026-09-20-1045-30-20000-t13';
  const restore = invoiceStubs({ calls, existing: { id: 'INVOLD', version: 3, status: 'UNPAID', public_url: 'https://sq/INVOLD' } });
  try {
    const lead = { ...LEAD, consultOption: JSON.stringify({ ...OPTION, invoiceId: 'INVOLD', invoiceBookingKey: key }) };
    await bookingService.createConsultInvoiceCheckout({
      lead, leadId: '9001', option: OPTION, consultantName: 'Shermin Teymouri Mofrad',
      slotDate: '2026-09-20', slotTime: '10:45', taxPct: 13, description: 'Consult',
    });
    const upd = calls.find((c) => c.m === 'update');
    assert.ok(upd, 'reuse persists');
    const stored = JSON.parse(upd.fields.consultOption);
    assert.equal(stored.invoiceId, 'INVOLD');
    assert.equal(stored.invoiceBookingKey, key);
  } finally { restore.forEach((r) => r()); }
});

test('supersede discovers the invoice was JUST PAID → alreadyPaid, no second payable minted', async () => {
  const calls = [];
  const restore = [
    stub(axios, 'get', async () => ({ data: { invoice: { id: 'INVOLD', version: 3, status: 'UNPAID', public_url: 'https://sq/x' } } })),
    // cancelInvoice re-retrieves internally via axios.get above (UNPAID) then cancels —
    // simulate Square answering the cancel with PAID-by-then via the retrieve inside cancelInvoice:
  ];
  // Simpler: stub the invoices service directly for this race.
  const sqInv = require('../src/services/squareInvoicesService');
  const origRetrieve = sqInv.retrieveInvoice, origCancel = sqInv.cancelInvoice;
  sqInv.retrieveInvoice = async () => ({ id: 'INVOLD', version: 3, status: 'UNPAID', public_url: 'https://sq/x' });
  sqInv.cancelInvoice = async () => ({ ok: true, status: 'PAID' });
  const restoreUpd = stub(leadService, 'updateLead', async () => {});
  try {
    const lead = { ...LEAD, consultOption: JSON.stringify({ ...OPTION, invoiceId: 'INVOLD', invoiceBookingKey: 'OLD-KEY' }) };
    await assert.rejects(bookingService.createConsultInvoiceCheckout({
      lead, leadId: '9001', option: OPTION, consultantName: 'X',
      slotDate: '2026-09-20', slotTime: '10:45', taxPct: 13, description: 'Consult',
    }), (e) => e.alreadyPaid === true);
  } finally { sqInv.retrieveInvoice = origRetrieve; sqInv.cancelInvoice = origCancel; restore.forEach((r) => r()); restoreUpd(); }
});

test('retrieveOrderLeadMeta: 404 = foreign (null); transient THROWS (never negative-cached as foreign)', async () => {
  const sqInv = require('../src/services/squareInvoicesService');
  let mode = '404';
  const restoreGet = stub(axios, 'get', async () => {
    if (mode === '404') { const e = new Error('nf'); e.response = { status: 404 }; throw e; }
    const e = new Error('boom'); e.response = { status: 503 }; throw e;
  });
  try {
    assert.equal(await sqInv.retrieveOrderLeadMeta('ORD_FOREIGN'), null);
    mode = '503';
    await assert.rejects(sqInv.retrieveOrderLeadMeta('ORD_OURS'));
  } finally { restoreGet(); }
});

test('idempotency keys survive real 11-digit lead ids WITH the tax discriminator intact', async () => {
  const calls = [];
  const restore = invoiceStubs({ calls });
  try {
    await bookingService.createConsultInvoiceCheckout({
      lead: LEAD, leadId: '12878138247', option: OPTION, consultantName: 'X',
      slotDate: '2026-09-20', slotTime: '10:45', taxPct: 13, description: 'Consult',
    });
    const ord = calls.find((c) => c.url && c.url.endsWith('/v2/orders')).body;
    assert.match(ord.idempotency_key, /-t13$/, 'the tax suffix must survive (a truncated key replays the WRONG order)');
  } finally { restore.forEach((r) => r()); }
});

test('source pins: double-pay staff note, cancel-before-abandon, fallback cleanup, env default, webhook cache', () => {
  const b = fs.readFileSync(require.resolve('../src/services/bookingService'), 'utf8');
  // confirmSlot: a DIFFERENT completed txn on a Booked lead posts a loud note.
  const cs = b.slice(b.indexOf('async function confirmSlot'));
  assert.match(cs, /Possible DOUBLE PAYMENT/, 'second payment is loud, never silently absorbed');
  assert.match(cs, /txnId !== knownTxn/);
  // releaseExpiredSlots: invoice retired BEFORE the Abandoned flip (retryability).
  const rel = b.slice(b.indexOf('async function releaseExpiredSlots'), b.indexOf('function consultInvoicesEnabled'));
  const cancelIdx = rel.indexOf('cancelInvoice(opt.invoiceId)');
  const flipIdx = rel.indexOf("bookingStatus: 'Abandoned'");
  assert.ok(cancelIdx !== -1 && flipIdx !== -1 && cancelIdx < flipIdx, 'cancel first, flip after');
  assert.match(rel, /could not be auto-cancelled/, 'cancel failure posts a staff note');
  // webhook probe negative cache
  assert.match(b, /_webhookForeignOrders/);
  // route fallback retires the known invoice, and a PAID discovery shows the done page
  const r = fs.readFileSync(require.resolve('../src/routes/phase2'), 'utf8');
  assert.match(r, /pre-fallback invoice cleanup|retired before payment-link fallback/);
  assert.match(r.slice(r.indexOf('knownInvoiceId')), /PAID/, 'paid-during-failure shows the booking, not another payable');
  // env default matches the repo convention (sandbox unless explicitly production)
  const sq = fs.readFileSync(require.resolve('../src/services/squareInvoicesService'), 'utf8');
  assert.match(sq, /SQUARE_ENVIRONMENT === 'production'\s*\n?\s*\? 'https:\/\/connect\.squareup\.com'/);
});
