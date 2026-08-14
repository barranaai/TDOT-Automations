'use strict';

// Client-picks-duration consultation pricing: per-consultant Square services
// ("(TDOT Automation)" catalog items, created 2026-07-30), duration picker on
// the booking page, fee follows the choice, and every downstream reader (Square
// write-back, consult agreement, KPI revenue) honors the stored choice.

const test   = require('node:test');
const assert = require('node:assert/strict');

const routing             = require('../config/consultantRouting');
const phase2              = require('../src/routes/phase2');
const consultationService = require('../src/services/consultationService');
const consultAgreementSvc = require('../src/services/consultAgreementService');
const kpi                 = require('../src/services/kpiService');

// ─── the per-consultant option registry ──────────────────────────────────────

test('consultOptionsFor: Shafoli 30/$200 + 45/$300, Shermin 30/$120 + 15/$60, all mapped to TDOT Automation variations', () => {
  const sh = routing.consultOptionsFor('shafoli');
  assert.deepEqual(sh.map((o) => [o.durationMin, o.feeCents]), [[30, 20000], [45, 30000]]);
  assert.equal(sh.find((o) => o.default).durationMin, 30);
  assert.ok(sh.every((o) => /^[A-Z0-9]{24,}$/i.test(o.variationId)), 'real Square variation ids');

  const se = routing.consultOptionsFor('shermin');
  assert.deepEqual(se.map((o) => [o.durationMin, o.feeCents]), [[30, 12000], [15, 6000]]);
  assert.equal(se.find((o) => o.default).durationMin, 30);

  // ids are distinct across all four options
  const ids = [...sh, ...se].map((o) => o.variationId);
  assert.equal(new Set(ids).size, 4);
});

test('consultOptionsFor: unknown consultant falls back to a single legacy env option', () => {
  const fb = routing.consultOptionsFor('nobody');
  assert.equal(fb.length, 1);
  assert.equal(fb[0].default, true);
  assert.ok(Number.isFinite(fb[0].feeCents));
});

// ─── the booking page ────────────────────────────────────────────────────────

function fakeSlot(date, time) { return { date, time, startAt: `${date}T${time}:00Z`, durationMinutes: 30 }; }

test('booking page: duration picker with prices + per-duration slot lists + valid script', () => {
  const sets = [
    { durationMin: 30, feeCents: 20000, default: true, slots: [fakeSlot('2026-08-10', '10:00')] },
    { durationMin: 45, feeCents: 30000, slots: [fakeSlot('2026-08-11', '14:00')] },
  ];
  const html = phase2.buildBookingPageHtml({ id: '1', tier: 'T2' }, { sets }, 'tok', { name: 'Shafoli Kapur' });
  assert.match(html, /name="durationChoice" value="30" checked/, '30-min pre-selected (default)');
  assert.match(html, /name="durationChoice" value="45"/);
  assert.match(html, /\$200\.00.*CAD/, 'shows the 30-min price');
  assert.match(html, /\$300\.00.*CAD/, 'shows the 45-min price');
  assert.match(html, /data-dur="30" style="display:block"/, 'default duration list visible');
  assert.match(html, /data-dur="45" style="display:none"/, 'other duration list hidden');
  assert.match(html, /name="durationMin" id="durationMin"/, 'hidden field posts the choice');
  // iOS dark-mode regression (live-found): slot buttons MUST carry an explicit
  // text color + no native appearance, and the page declares itself light-only —
  // otherwise iPhone dark mode paints ButtonText white on the white buttons.
  assert.match(html, /\.slot\{[^}]*color:#1F2937/s, 'slot buttons have an explicit text color');
  assert.match(html, /appearance:none/, 'native button appearance neutralized');
  assert.match(html, /name="color-scheme" content="light only"/, 'page pinned to light scheme');
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]); // throws on syntax error
});

test('booking page: legacy plain-slots call still renders with NO duration section', () => {
  const html = phase2.buildBookingPageHtml({ id: '1' }, [fakeSlot('2026-08-10', '10:00')], 'tok', { name: 'X' });
  assert.ok(!/Consultation length\?/.test(html), 'no duration picker section');
  assert.ok(!/input type="radio" name="durationChoice"/.test(html), 'no duration radios rendered');
  assert.match(html, /10:00/, 'slots render');
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
});

// ─── the stored choice parser + downstream readers ───────────────────────────

test('parseConsultOption: valid JSON parses; garbage/absent → null', () => {
  const p = consultationService.parseConsultOption;
  assert.deepEqual(p({ consultOption: '{"durationMin":45,"feeCents":30000,"variationId":"V1"}' }),
    { durationMin: 45, feeCents: 30000, variationId: 'V1' });
  assert.equal(p({ consultOption: 'not json' }), null);
  assert.equal(p({ consultOption: '' }), null);
  assert.equal(p({}), null);
  assert.equal(p({ consultOption: '{"noDuration":true}' }), null);
});

test('consult agreement states the CHOSEN fee + duration (env fallback for legacy leads)', () => {
  const chosen = consultAgreementSvc.buildConsultAgreementData({
    fullName: 'C', email: 'c@x.co', bookedSlot: '2026-08-10 10:00',
    consultOption: '{"durationMin":45,"feeCents":30000,"variationId":"V"}',
  });
  assert.equal(chosen.data.amountPaid, '300.00', 'the $300 45-min choice is what the agreement states');
  assert.equal(chosen.data.consultDurationMins, '45 minutes');

  const legacy = consultAgreementSvc.buildConsultAgreementData({ fullName: 'C', email: 'c@x.co', bookedSlot: '2026-08-10 10:00' });
  assert.match(legacy.data.consultDurationMins, /minutes/, 'legacy leads keep the env default');
});

// ─── the MONEY invariant: the PAID amount is the source of truth ─────────────
// A client can pay a STALE payment link (submit 45-min → back → submit 30-min →
// pay the still-open 45-min tab). The webhook reconciles the recorded option to
// what was actually charged before the booking confirms.

const bookingService = require('../src/services/bookingService');
const leadService    = require('../src/services/leadService');
const mondayApi      = require('../src/services/mondayApi');
function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// A lead that routes to Shafoli (no EE/CRS signals → but routing default is Shermin;
// use serviceRequired that routes to Shafoli? Simplest: PNP → Shafoli).
const shafoliLead = (extra = {}) => ({ id: '700', fullName: 'Pay Test', serviceRequired: 'PNP or OINP', ...extra });

test('paid amount ≠ stored option → the recorded option is CORRECTED to the option actually paid', async () => {
  const writes = [];
  const restore = [
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    // stored says 30-min/$200, but the client paid the stale $300 (45-min) link
    await bookingService.reconcileConsultOptionWithPayment(
      shafoliLead({ consultOption: '{"durationMin":30,"feeCents":20000,"variationId":"TMJIRVYQUD76E7A3YGXSEOQ5"}' }), 30000);
    const w = writes.find((f) => f.consultOption);
    assert.ok(w, 'the option was corrected');
    const o = JSON.parse(w.consultOption);
    assert.equal(o.durationMin, 45, 'corrected to the 45-min option the client paid for');
    assert.equal(o.feeCents, 30000);
    assert.equal(o.variationId, 'Z2XFERF43EO567YZGX4Y5WDL', 'the 45-min Square variation gets booked');
  } finally { restore.forEach((x) => x()); }
});

test('paid amount = stored option → ONE write recording paidCents, then settled', async () => {
  // Since the HST change (2026-08-14) the reconcile remembers the actual total
  // collected — the consult agreement's "has paid" figure comes from it. The
  // option itself is untouched, and a re-delivered webhook writes nothing.
  const writes = [];
  const restore = [
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await bookingService.reconcileConsultOptionWithPayment(
      shafoliLead({ consultOption: '{"durationMin":30,"feeCents":20000,"variationId":"V"}' }), 20000);
    assert.equal(writes.length, 1, 'paidCents recorded once');
    const o = JSON.parse(writes[0].consultOption);
    assert.equal(o.paidCents, 20000);
    assert.equal(o.durationMin, 30); assert.equal(o.feeCents, 20000); assert.equal(o.variationId, 'V');
    await bookingService.reconcileConsultOptionWithPayment(
      shafoliLead({ consultOption: writes[0].consultOption }), 20000);
    assert.equal(writes.length, 1, 'webhook replay writes nothing');
  } finally { restore.forEach((x) => x()); }
});

test('paid amount matches NO option → stored kept, loud staff note posted', async () => {
  let wroteOption = false; const notes = [];
  const restore = [
    stub(leadService, 'updateLead', async (id, f) => { if (f.consultOption) wroteOption = true; }),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(v.b); return {}; }),
  ];
  try {
    await bookingService.reconcileConsultOptionWithPayment(
      shafoliLead({ consultOption: '{"durationMin":30,"feeCents":20000,"variationId":"V"}' }), 5000);
    assert.equal(wroteOption, false, 'an unmatchable amount never silently rewrites the option');
    assert.ok(notes.some((n) => /needs a look/.test(n)), 'staff are flagged to verify with the client');
  } finally { restore.forEach((x) => x()); }
});

test('KPI revenue: per-lead chosen fee wins; legacy leads keep the flat fee', () => {
  const leads = [
    { createdAt: '2026-08-01', bookedSlot: '2026-08-02 10:00', squareConsultTxnId: 't1',
      consultOption: '{"durationMin":30,"feeCents":12000,"variationId":"V"}' },       // Shermin $120
    { createdAt: '2026-08-01', bookedSlot: '2026-08-03 10:00', squareConsultTxnId: 't2',
      consultOption: '{"durationMin":45,"feeCents":30000,"variationId":"V"}' },       // Shafoli $300
    { createdAt: '2026-08-01', bookedSlot: '2026-08-04 10:00', squareConsultTxnId: 't3' }, // legacy flat
  ];
  const K = kpi.computeKpis(leads, '2026-08');
  const flat = kpi.computeKpis([leads[2]], '2026-08').consultations.revenue;
  assert.equal(K.consultations.revenue, 120 + 300 + flat);
});
