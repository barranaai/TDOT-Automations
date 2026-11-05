'use strict';

// Consultation prices from Square (Faran 2026-11-05): the price the booking page shows and the
// payment link / invoice charges is what the option's "(TDOT Automation)" Square service says,
// read live; the figures in config/consultantRouting.js are the record of today's rates and the
// fallback (Square not read yet, down, or giving something unusable). Nothing here touches the
// network: Square is an in-memory catalogue.

const test   = require('node:test');
const assert = require('node:assert/strict');
const axios  = require('axios');

const prices  = require('../src/services/consultPriceService');
const routing = require('../config/consultantRouting');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const SH30 = 'TMJIRVYQUD76E7A3YGXSEOQ5', SH45 = 'Z2XFERF43EO567YZGX4Y5WDL', SE30 = 'VPLVMBZPVKUX32MXMWED6S63', SE15 = '5463HO7BTOQ3H7XVRDXWSGQ3';
const variation = (id, amount, { currency = 'CAD', minutes = 30, deleted = false, name = 'Consultation' } = {}) => ({
  type: 'ITEM_VARIATION', id, is_deleted: deleted, version: 7,
  item_variation_data: { name, price_money: amount == null ? undefined : { amount, currency }, service_duration: minutes * 60000, available_for_booking: true },
});
const SQUARE_NOW = { [SH30]: 30000, [SH45]: 45000, [SE30]: 12000, [SE15]: 6000 };

/** An in-memory Square catalogue: answers batch-retrieve from `objects`; records calls; can fail. */
function square({ objects = null, fail = null, delayMs = 0 } = {}) {
  const calls = [];
  const objs = objects || [variation(SH30, 30000), variation(SH45, 45000, { minutes: 45 }), variation(SE30, 12000), variation(SE15, 6000, { minutes: 15 })];
  const restore = stub(axios, 'post', async (url, body, opts) => {
    calls.push({ url, body, opts });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail) { const e = new Error(fail); if (/^HTTP/.test(fail)) e.response = { status: Number(fail.slice(5)) }; throw e; }
    return { data: { objects: objs.filter((o) => body.object_ids.includes(o.id)) } };
  });
  return { calls, restore, objs };
}

const withEnv = (vars, fn) => async () => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  prices._internal._reset();
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    prices._internal._reset();
  }
};
const ON = { SQUARE_ACCESS_TOKEN: 'sq0atp-test', CONSULT_PRICES_FROM_SQUARE: 'on', SQUARE_ENVIRONMENT: 'production' };

test('the app\'s own list carries today\'s rates (Shafoli $300 / $450, Shermin $120 / $60) and is what is used until Square has answered', withEnv(ON, async () => {
  const sh = routing.consultOptionsFor('shafoli'), se = routing.consultOptionsFor('shermin');
  assert.deepEqual(sh.map((o) => [o.durationMin, o.feeCents, o.feeSource]), [[30, 30000, 'code'], [45, 45000, 'code']]);
  assert.deepEqual(se.map((o) => [o.durationMin, o.feeCents, o.feeSource]), [[30, 12000, 'code'], [15, 6000, 'code']]);
  assert.equal(sh.find((o) => o.default).durationMin, 30);
  assert.deepEqual(sh[0].knownFeeCents.sort(), [20000, 30000], 'today\'s rate and the former one');
  assert.deepEqual(sh[1].knownFeeCents.sort(), [30000, 45000]);
  assert.equal(prices.summary(), 'code 0/4 (never read)');
}));

test('one read from Square prices every option; the registry itself is never changed; the health line and the status say so', withEnv(ON, async () => {
  const sq = square();
  try {
    const r = await prices.refresh({ reason: 'test' });
    assert.equal(r.ok, true); assert.equal(r.read, 4); assert.deepEqual(r.rejected, []);
    assert.equal(sq.calls.length, 1);
    assert.match(sq.calls[0].url, /^https:\/\/connect\.squareup\.com\/v2\/catalog\/batch-retrieve$/);
    assert.deepEqual(sq.calls[0].body.object_ids.sort(), [SH30, SH45, SE30, SE15].sort());
    assert.equal(sq.calls[0].opts.headers.Authorization, 'Bearer sq0atp-test');
    assert.equal(sq.calls[0].opts.timeout, 10000);
    assert.equal(sq.calls[0].body.include_deleted_objects, true, 'a service deleted in Square is seen as deleted, not missing');
    const sh = routing.consultOptionsFor('shafoli');
    assert.deepEqual(sh.map((o) => [o.durationMin, o.feeCents, o.feeSource, o.listFeeCents]), [[30, 30000, 'square', 30000], [45, 45000, 'square', 45000]]);
    assert.equal(routing.CONSULTANTS.shafoli.consultOptions[0].feeCents, 30000, 'the registry is untouched');
    assert.ok(!('feeSource' in routing.CONSULTANTS.shafoli.consultOptions[0]));
    assert.match(prices.summary(), /^square 4\/4 \(0 min ago\)$/);
    const st = prices.status();
    assert.equal(st.allFromSquare, true);
    assert.deepEqual(st.options.find((o) => o.variationId === SH30), { consultant: 'Shafoli Kapur', durationMin: 30, variationId: SH30, codeCents: 30000, squareCents: 30000, squareDurationMin: 30, inUseCents: 30000, source: 'square', readAt: st.options[0].readAt, rejected: '' });
  } finally { sq.restore(); }
}));

test('a price changed in Square is what the booking page shows and the checkout charges; the earlier price still maps a late payment to its option', withEnv(ON, async () => {
  let sq = square();
  try { await prices.refresh(); } finally { sq.restore(); }
  sq = square({ objects: [variation(SH30, 35000), variation(SH45, 45000, { minutes: 45 }), variation(SE30, 12000), variation(SE15, 6000, { minutes: 15 })] });
  try {
    const r = await prices.refresh();
    assert.deepEqual(r.changed, ['Shafoli Kapur 30 min: $300.00 → $350.00']);
    const sh = routing.consultOptionsFor('shafoli');
    assert.equal(sh[0].feeCents, 35000);
    assert.deepEqual(sh[0].knownFeeCents.sort(), [20000, 30000, 35000], 'the listed, the former and the earlier price are still known');
    // the webhook: a payment made at the former 30-min rate names the 30-min option and records the fee PAID
    const bookingService = require('../src/services/bookingService');
    const leadService = require('../src/services/leadService');
    const writes = [], notes = [];
    const restore = [stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }), stub(require('../src/services/mondayApi'), 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(v.b || v.body); return {}; })];
    try {
      await bookingService.reconcileConsultOptionWithPayment({ id: '700', fullName: 'Pay Test', serviceRequired: 'PNP or OINP' }, 22600);   // $200 + HST, no stored option
      const o = JSON.parse(writes.find((f) => f.consultOption).consultOption);
      assert.deepEqual([o.durationMin, o.variationId, o.feeCents, o.paidCents], [30, SH30, 20000, 22600], 'the fee recorded is the fee paid, not today\'s price');
      // an amount that could be two options (the old 45-min rate = today's 30-min rate) is never guessed
      writes.length = 0;
      await bookingService.reconcileConsultOptionWithPayment({ id: '701', fullName: 'Pay Test', serviceRequired: 'PNP or OINP', consultOption: JSON.stringify({ durationMin: 45, feeCents: 30000, variationId: SH45 }) }, 33900);
      assert.ok(!writes.some((f) => f.consultOption && JSON.parse(f.consultOption).durationMin !== 45), 'the stored 45-min choice stays');
      assert.equal(notes.length, 0, 'the stored option matches: no question for staff');
      writes.length = 0;
      await bookingService.reconcileConsultOptionWithPayment({ id: '702', fullName: 'Pay Test', serviceRequired: 'PNP or OINP', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, variationId: SH30 }) }, 33900);
      assert.ok(!writes.some((f) => f.consultOption && JSON.parse(f.consultOption).durationMin !== 30), 'a stored 30-min choice is not silently rewritten');
      assert.ok(notes.some((n) => /could be 30 minutes \(\$300\.00 \+ HST\) or 45 minutes \(\$300\.00 \+ HST\)/.test(n)), notes.join(' | '));
      assert.equal(JSON.parse(writes.find((f) => f.consultOption).consultOption).paidCents, 33900, 'the amount collected is still recorded');
    } finally { restore.forEach((x) => x()); }
  } finally { sq.restore(); }
}));

test('Square cannot be read: the last reading stays (or the app\'s own list); nothing throws; the error is in the status', withEnv(ON, async () => {
  let sq = square({ fail: 'HTTP 503' });
  try {
    const r = await prices.refresh({ reason: 'test' });
    assert.equal(r.ok, false); assert.match(r.error, /HTTP 503/);
    assert.equal(routing.consultOptionsFor('shafoli')[0].feeSource, 'code');
    assert.match(prices.summary(), /^code 0\/4 \(never read; last error: HTTP 503/);
  } finally { sq.restore(); }
  sq = square();
  try {
    assert.equal((await prices.refresh()).skipped, true, 'within a minute of a failure no new read is started (the pages are not held again)');
    assert.deepEqual(await prices.ensureFresh({ maxAgeMs: 0, waitMs: 50 }), { fresh: false, ageMs: null, skipped: 'cooling down after a failed read' });
    assert.equal(sq.calls.length, 0);
    assert.equal((await prices.refresh({ force: true })).ok, true, 'the scheduled read goes ahead');
  } finally { sq.restore(); }
  sq = square({ fail: 'ETIMEDOUT' });
  try {
    await prices.refresh({ force: true });
    assert.equal(routing.consultOptionsFor('shafoli')[0].feeSource, 'square', 'the last good reading is kept');
    assert.equal(prices.status().lastError, 'error: ETIMEDOUT');
    assert.equal(prices.status().lastOkAt !== null, true);
  } finally { sq.restore(); }
}));

test('unusable Square figures are refused and the app\'s own price used: deleted service, no price, 0, non-CAD, a typo far outside the sanity band; a missing service keeps the last reading', withEnv(ON, async () => {
  const sq = square({ objects: [
    variation(SH30, 30000, { deleted: true }),
    variation(SH45, null, { minutes: 45 }),
    variation(SE30, 12000, { currency: 'USD' }),
    variation(SE15, 600, { minutes: 15 }),   // $6.00 for a $60 service — one zero short
  ] });
  try {
    const r = await prices.refresh();
    assert.equal(r.ok, true); assert.equal(r.read, 0);
    assert.equal(r.rejected.length, 4, r.rejected.join(' | '));
    assert.ok(r.rejected.some((x) => /Shafoli Kapur 30 min: the service is deleted in Square/.test(x)));
    assert.ok(r.rejected.some((x) => /Shafoli Kapur 45 min: no price on the service in Square/.test(x)));
    assert.ok(r.rejected.some((x) => /Shermin Teymouri Mofrad 30 min: a price in USD, not CAD/.test(x)));
    assert.ok(r.rejected.some((x) => /Shermin Teymouri Mofrad 15 min: a price of \$6\.00 in Square, too far from the \$60\.00 in the app's own list \(a typo\?\)/.test(x)));
    for (const [k, i] of [['shafoli', 0], ['shafoli', 1], ['shermin', 0], ['shermin', 1]]) assert.equal(routing.consultOptionsFor(k)[i].feeSource, 'code', `${k}#${i}`);
    const st = prices.status();
    assert.equal(st.options.find((o) => o.variationId === SE15).rejected.includes('a typo?'), true);
    assert.equal(st.options.find((o) => o.variationId === SE15).squareCents, 600, 'the refused figure is shown');
    assert.equal(st.allFromSquare, false);
  } finally { sq.restore(); }
  // the sanity band itself: a zero too many or too few ($3,000 / $30 for $300) is refused; a real change is not
  const rv = prices._internal.readVariation;
  for (const [list, bad] of [[30000, 300000], [30000, 3000], [45000, 450000], [45000, 4500], [12000, 120000], [12000, 1200], [6000, 60000], [6000, 600]]) assert.match(rv(variation('x', bad), list).reject, /too far/, `${bad} for ${list}`);
  assert.match(rv(variation('x', 7500), 30000).reject, /too far/, 'a quarter exactly is refused');
  assert.match(rv(variation('x', 120000), 30000).reject, /too far/, 'four times exactly is refused');
  assert.equal(rv(variation('x', 7501), 30000).feeCents, 7501);
  assert.equal(rv(variation('x', 119999), 30000).feeCents, 119999);
  assert.equal(rv(variation('x', 20000), 30000).feeCents, 20000, 'the last real change ($200 → $300) would have passed either way');
  assert.match(rv(variation('x', 10.5), 30000).reject, /unusable price/);
  // a figure refused AFTER a good reading: the list price is used (what the warning says), the refusal shown
  let ok = square(); try { await prices.refresh({ force: true }); } finally { ok.restore(); }
  ok = square({ objects: [variation(SH30, 300000), variation(SH45, 45000, { minutes: 45 }), variation(SE30, 12000), variation(SE15, 6000, { minutes: 15 })] });
  try {
    await prices.refresh({ force: true });
    const o = routing.consultOptionsFor('shafoli')[0];
    assert.deepEqual([o.feeCents, o.feeSource], [30000, 'code'], 'a $3,000 typo after a good $300 reading: the list price, not the stale reading');
    const st = prices.status().options.find((x) => x.variationId === SH30);
    assert.deepEqual([st.source, st.inUseCents, st.squareCents], ['code', 30000, 300000]);
    assert.match(st.rejected, /too far/);
  } finally { ok.restore(); }
  // a service missing from the answer keeps the last reading
  ok = square(); try { await prices.refresh({ force: true }); } finally { ok.restore(); }
  ok = square({ objects: [variation(SH45, 45000, { minutes: 45 }), variation(SE30, 12000), variation(SE15, 6000, { minutes: 15 })] });
  try {
    const r = await prices.refresh({ force: true });
    assert.deepEqual(r.missing, ['Shafoli Kapur 30 min']);
    assert.equal(routing.consultOptionsFor('shafoli')[0].feeSource, 'square');
  } finally { ok.restore(); }
}));

test('ensureFresh: a reading within 15 minutes is enough; a stale one is refreshed; a slow Square is waited for at most the bound and the page goes on with what it has', withEnv(ON, async () => {
  let sq = square();
  try {
    const first = await prices.ensureFresh({ waitMs: 50 });
    assert.equal(first.fresh, true); assert.ok(first.ageMs < 1000);
    assert.equal(sq.calls.length, 1);
    const again = await prices.ensureFresh({ waitMs: 50 });
    assert.equal(again.fresh, true); assert.equal(sq.calls.length, 1, 'no second read within the fresh window');
    const stale = await prices.ensureFresh({ maxAgeMs: 0, waitMs: 50 });
    assert.equal(stale.fresh, true); assert.equal(sq.calls.length, 2, 'a stale reading is refreshed');
  } finally { sq.restore(); }
  sq = square({ delayMs: 120 });
  try {
    const t0 = Date.now();
    const r = await prices.ensureFresh({ maxAgeMs: 0, waitMs: 30 });
    assert.ok(Date.now() - t0 < 110, 'did not wait for the slow read');
    assert.equal(r.fresh, false);
    assert.equal(routing.consultOptionsFor('shafoli')[0].feeSource, 'square', 'the earlier reading is still what is used');
    await new Promise((res) => setTimeout(res, 150));   // the read finishes in the background
    assert.equal(sq.calls.length, 1);
  } finally { sq.restore(); }
  sq = square({ fail: 'HTTP 500' });
  try {
    const r = await prices.ensureFresh({ maxAgeMs: 0, waitMs: 50 });
    assert.equal(r.fresh, false, 'never throws');
    const again = await prices.ensureFresh({ maxAgeMs: 0, waitMs: 50 });
    assert.equal(again.skipped, 'cooling down after a failed read');
    assert.equal(sq.calls.length, 1, 'a Square outage does not make every page wait the bound again');
  } finally { sq.restore(); }
}));

test('two refreshes at once share one read; the switch and a missing token mean the app\'s own prices only (no network)', withEnv(ON, async () => {
  const sq = square({ delayMs: 20 });
  try {
    const [a, b] = await Promise.all([prices.refresh(), prices.refresh()]);
    assert.equal(sq.calls.length, 1); assert.equal(a, b);
  } finally { sq.restore(); }
  process.env.CONSULT_PRICES_FROM_SQUARE = 'off';
  const off = square();
  try {
    assert.deepEqual(await prices.refresh(), { ok: false, skipped: true, reason: 'off' });
    assert.equal((await prices.ensureFresh()).off, true);
    assert.equal(off.calls.length, 0);
    assert.equal(routing.consultOptionsFor('shafoli')[0].feeSource, 'code', 'a reading made before the switch is not used while it is off');
    assert.equal(prices.summary(), 'off (CONSULT_PRICES_FROM_SQUARE=off)');
  } finally { off.restore(); }
  delete process.env.CONSULT_PRICES_FROM_SQUARE; delete process.env.SQUARE_ACCESS_TOKEN;
  assert.equal(prices.summary(), 'off (no Square token)');
  // a test process (node --test sets NODE_TEST_CONTEXT) never reads Square unless the test says 'on'
  process.env.SQUARE_ACCESS_TOKEN = 'sq0atp-test';
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this file runs under node --test');
  assert.equal(prices.enabled(), false);
  assert.equal(prices.summary(), 'off (no Square token)');
  assert.deepEqual(await prices.ensureFresh(), { fresh: false, ageMs: null, off: true });
}));

test('wiring: the booking page, the checkout, the invite, the reminders, a staff-recorded booking and the lead page read a fresh price first; boot + every 15 min; the health check and the admin page show it', () => {
  const fs = require('fs');
  const src = (p) => fs.readFileSync(require.resolve(p), 'utf8');
  const p2 = src('../src/routes/phase2.js');
  assert.ok(p2.includes("await require('../services/consultPriceService').ensureFresh({ reason: 'booking page' });"));
  assert.ok(p2.includes("await require('../services/consultPriceService').ensureFresh({ reason: 'checkout' });\n    const options = routing.consultOptionsFor(consultant);"));
  assert.ok(p2.indexOf("ensureFresh({ reason: 'checkout' })") < p2.indexOf("bookingService.holdSlotIfFree(leadId, slotDate, slotTime"), 'the price is settled before a slot is held');
  assert.ok(p2.includes("if (Number.isInteger(quotedFee) && quotedFee !== Number(option.feeCents) && bookingService.CONSULT_FEE_CENTS !== 0) {"));
  assert.ok(p2.includes("consultPrices: require('../services/consultPriceService').summary(),"));
  const bs = src('../src/services/bookingService.js');
  assert.ok(bs.includes("await require('./consultPriceService').ensureFresh({ reason: 'booking invite' });"));
  assert.ok(bs.includes(".map((o) => ({ option: o, feeCents: (o.knownFeeCents || [o.feeCents]).find(matchesFee) }))"), 'a payment names its option by every price it may carry, and the fee PAID is the one recorded');
  assert.ok(bs.includes('if (candidates.length === 1) {') && bs.includes('} else if (candidates.length > 1) {'), 'an amount naming two options is left to staff');
  assert.ok(src('../src/services/bookingRemindersService.js').includes("if (!dryRun) await require('./consultPriceService').ensureFresh({ reason: 'booking reminders' });"));
  const cp = src('../src/services/consultantPortalService.js');
  assert.ok(cp.includes("await require('./consultPriceService').ensureFresh({ reason: 'recorded booking' });"));
  assert.ok(cp.includes("await require('./consultPriceService').ensureFresh({ reason: 'lead page' });"));
  const sch = src('../src/services/scheduler.js');
  assert.ok(sch.includes("consultPrices.refresh({ reason: 'boot' }).catch(() => {});"));
  assert.ok(sch.includes("cron.schedule('*/15 * * * *', () => consultPrices.refresh({ reason: 'scheduled', force: true }).catch(() => {}));"), 'the scheduled read ignores the failed-read cool-down');
  const srv = src('../src/server.js');
  assert.ok(srv.includes("app.get('/admin/consult-prices', async (req, res) => {\n  if (!resolveAdminOrReject(req, res, 'Only an admin can see the consultation prices.')) return;"));
  assert.ok(srv.includes("if (req.query.refresh === '1') await prices.refresh({ reason: 'admin' });\n  res.json(prices.status());"));
});

test('the booking page shows and the checkout charges Square\'s price (end to end over the in-memory Square)', withEnv(ON, async () => {
  const sq = square({ objects: [variation(SH30, 32500), variation(SH45, 45000, { minutes: 45 }), variation(SE30, 12000), variation(SE15, 6000, { minutes: 15 })] });
  const phase2 = require('../src/routes/phase2');
  const bookingService = require('../src/services/bookingService');
  const leadService = require('../src/services/leadService');
  const lead = { id: '700', fullName: 'Pay Test', serviceRequired: 'PNP or OINP', country: 'Canada', bookingStatus: '' };
  const writes = [];
  let checkout = null;
  const restore = [
    stub(require('../src/services/leadTokenService'), 'validateToken', async () => true),
    stub(leadService, 'getLead', async () => ({ ...lead })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
    stub(bookingService, 'squareCalendarEnabled', () => true),
    stub(bookingService, 'getSquareAvailableSlots', async (weeks, tm, variationId) => [{ date: '2026-12-01', time: '10:00', startAt: '2026-12-01T15:00:00Z', durationMinutes: variationId === SH45 ? 45 : 30 }]),
    stub(bookingService, 'holdSlotIfFree', async () => ({ ok: true })),
    stub(bookingService, 'consultInvoicesEnabled', () => false),
    stub(bookingService, 'createCheckout', async (args) => { checkout = args; return { url: 'https://sq/pay', orderId: 'o1' }; }),
  ];
  try {
    const page = await new Promise((resolve, reject) => {
      const res = { type() { return this; }, status() { return this; }, send: (html) => resolve(html) };
      phase2.handle({ method: 'GET', url: '/book/700?t=tok', params: { leadId: '700' }, query: { t: 'tok' }, headers: {}, body: {} }, res, reject);
    });
    assert.match(page, /\$325\.00 \+ HST = \$367\.25 CAD/, 'the page shows Square\'s $325 for 30 minutes, with HST');
    assert.match(page, /\$450\.00 \+ HST = \$508\.50 CAD/, 'and $450 for 45 minutes');
    assert.equal(sq.calls.length, 1);
    await new Promise((resolve, reject) => {
      const res = { type() { return this; }, status() { return this; }, send: resolve, redirect: resolve };
      phase2.handle({ method: 'POST', url: '/book/700?t=tok', params: { leadId: '700' }, query: { t: 'tok' }, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: { slotDate: '2026-12-01', slotTime: '10:00', durationMin: '30', meetingType: 'Virtual', quotedFeeCents: '32500' } }, res, reject);
    });
    assert.ok(checkout, 'a checkout was created');
    assert.equal(checkout.amount, 32500, 'charged at Square\'s price');
    assert.equal(checkout.taxPct, 13);
    const stored = JSON.parse(writes.find((f) => f.consultOption).consultOption);
    assert.deepEqual([stored.durationMin, stored.feeCents, stored.variationId], [30, 32500, SH30], 'the booking keeps the price it was charged');
    assert.match(page, /name="durationChoice" value="30" data-fee="32500" checked/, 'the page posts the price it showed with the choice');
    assert.match(page, /name="quotedFeeCents" id="quotedFeeCents"/);
    // the price changes in Square after the page was shown: the click charges nothing and sends the client back
    sq.restore();
    const sq2 = square({ objects: [variation(SH30, 34000), variation(SH45, 45000, { minutes: 45 }), variation(SE30, 12000), variation(SE15, 6000, { minutes: 15 })] });
    let held = 0;
    restore.push(stub(bookingService, 'holdSlotIfFree', async () => { held++; return { ok: true }; }));
    try {
      await prices.refresh({ force: true });   // the scheduled read landed
      checkout = null; writes.length = 0;
      const out = await new Promise((resolve, reject) => {
        const res = { type() { return this; }, status(c) { res.code = c; return this; }, send: (h) => resolve({ code: res.code, html: h }), redirect: (u) => resolve({ redirect: u }) };
        phase2.handle({ method: 'POST', url: '/book/700?t=tok', params: { leadId: '700' }, query: { t: 'tok' }, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: { slotDate: '2026-12-01', slotTime: '10:00', durationMin: '30', meetingType: 'Virtual', quotedFeeCents: '32500' } }, res, reject);
      });
      assert.equal(out.code, 409);
      assert.match(out.html, /Please review the consultation fee/); assert.match(out.html, /Nothing has been charged/);
      assert.equal(checkout, null, 'nothing charged'); assert.equal(held, 0, 'nothing held');
      assert.ok(!writes.some((f) => f.consultOption), 'nothing stored');
    } finally { sq2.restore(); }
  } finally { restore.forEach((x) => x()); }
}));
