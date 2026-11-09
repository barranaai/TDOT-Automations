'use strict';

// Step 2, commit 4 — how the KPIs count a DIRECT CONSULTATION (one added by hand with
// "＋ Direct consultation", booked outside the app). PURE (computeKpis: leads → numbers).
//
//   - The consultation figures (booked, held, by consultant, by mode, revenue, paid /
//     waived) count every direct row, like any booking.
//   - The funnel (leads → booked → consulted) counts only a "New" one: a "Follow-up" and
//     an "Existing client" row are not new leads.
//   - "Existing" on the new / existing card: an "Existing client" row is existing before
//     the relationship-label check (which misses "Previous client…" — fixed in step 6).
//   - Months with no direct rows give exactly the numbers they gave before.
//
// The fixtures are shaped like October 2026: booking-link consultations, a hand-recorded
// fee, a walk-in direct retainer, and the kinds of rows Melanie books in Square.

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeKpis } = require('../src/services/kpiService');
const routing = require('../config/consultantRouting');
const RELATIONSHIPS = require('../src/services/intakeFormService').RELATIONSHIPS;
const C = require('../src/data/newLeadsBoard.json').columns;

const SHAFOLI = routing.CONSULTANTS.shafoli.name, SHERMIN = routing.CONSULTANTS.shermin.name, GAURI = 'Gauri Berde';
const FEE = (Number(require('../src/services/bookingService').CONSULT_FEE_CENTS) || 20000) / 100;

const PREVIOUS = 'Previous client with completed or inactive application';
const ACTIVE = 'Existing client with active application';

const rec = (kind, amountCents, on) => JSON.stringify({ kind, amountCents, on, by: 'Melanie', at: `${on}T15:00:00Z` });
// A direct row as the server writes it: the column (once it is made) AND consultOption.directConsult.
const direct = (kind, extra = {}, { column = true, inSquare = true } = {}) => ({
  ...(column ? { directConsult: kind } : {}),
  consultOption: JSON.stringify({ durationMin: 30, directConsult: { kind, inSquare, followUpOf: '', caseRef: '', by: 'Melanie' } }),
  bookingStatus: 'Booked', conversionStatus: 'Booked', bookedBy: 'Melanie', leadOwner: 'Melanie',
  ...extra,
});

// October-shaped month: what the app counted before step 2.
const OCTOBER = () => [
  // booked through the booking link, paid online, retained and paid
  { id: '1', assignedConsultant: SHAFOLI, leadOwner: 'Prajwal', bookedSlot: '2026-10-03 11:00', consultationHeld: '2026-10-03', meetingType: 'Virtual', squareConsultTxnId: 't1', relationshipWithTdot: 'New inquiry', confirmedCaseType: 'Study Permit', retainerSent: '2026-10-04', retainerSigned: '2026-10-06', retainerPaid: '2026-10-07', retainerFee: '2500', createdAt: '2026-10-01T14:00:00Z' },
  // booked through the link, held, no outcome yet
  { id: '2', assignedConsultant: SHERMIN, bookedSlot: '2026-10-09 15:00', consultationHeld: '2026-10-09', meetingType: 'In-person', squareConsultTxnId: 't2', relationshipWithTdot: 'New inquiry', createdAt: '2026-10-02T14:00:00Z' },
  // a fee recorded by staff (e-transfer), existing client by its label
  { id: '3', assignedConsultant: SHAFOLI, bookedSlot: '2026-10-14 10:00', consultationHeld: '2026-10-14', meetingType: 'Phone Call', relationshipWithTdot: ACTIVE, consultPayment: rec('e-transfer', 30000, '2026-10-13'), createdAt: '2026-10-05T14:00:00Z' },
  // a lead that never booked
  { id: '4', relationshipWithTdot: 'New inquiry', createdAt: '2026-10-20T14:00:00Z' },
  // a walk-in direct retainer (never in the booking funnel)
  { id: '5', directClient: 'Yes', sourceChannel: 'Direct Retainer', retainerSigned: '2026-10-22', retainerFee: '4000', createdAt: '2026-10-22T14:00:00Z' },
];

// What Melanie adds for October with "＋ Direct consultation".
const DIRECT_OCTOBER = () => [
  // New: a new client, Paid in Square, held
  direct('New', { id: '20', fullName: 'New Person', assignedConsultant: SHAFOLI, bookedSlot: '2026-10-15 13:00', consultationHeld: '2026-10-15', meetingType: 'In-person', relationshipWithTdot: 'New inquiry', consultPayment: rec('square', 30000, '2026-10-15'), createdAt: '2026-10-15T18:00:00Z' }),
  // Follow-up: an earlier held consultation already counted this person
  direct('Follow-up', { id: '21', fullName: 'Second Visit', assignedConsultant: SHERMIN, bookedSlot: '2026-10-16 10:00', consultationHeld: '2026-10-16', meetingType: 'Virtual', relationshipWithTdot: 'New inquiry', consultPayment: rec('cash', 20000, '2026-10-16'), createdAt: '2026-10-16T14:00:00Z' }),
  // Existing client about their current file — "Previous client…" (the label check misses it)
  direct('Existing client', { id: '22', fullName: 'Old Client', assignedConsultant: GAURI, bookedSlot: '2026-10-17 12:00', consultationHeld: '2026-10-17', meetingType: 'Phone Call', relationshipWithTdot: PREVIOUS, consultPayment: rec('waived', 0, '2026-10-17'), createdAt: '2026-10-17T14:00:00Z' }),
  // Existing client with an open case, not paid yet, not held yet (a time later in the month)
  direct('Existing client', { id: '23', fullName: 'Open File', assignedConsultant: SHAFOLI, bookedSlot: '2026-10-30 16:00', meetingType: 'In-person', relationshipWithTdot: ACTIVE, createdAt: '2026-10-18T14:00:00Z' }),
];

const funnelOf = (k) => ({ leads: k.funnel.leads, booked: k.funnel.booked, consulted: k.funnel.consulted, retained: k.funnel.retained, retainedDirect: k.funnel.retainedDirect, paid: k.funnel.paid });

test('the labels the fixtures use are the board\'s exact relationship labels', () => {
  assert.ok(RELATIONSHIPS.includes(PREVIOUS) && RELATIONSHIPS.includes(ACTIVE) && RELATIONSHIPS.includes('New inquiry'));
});

test('October with no direct rows: the numbers the app showed before step 2', () => {
  const k = computeKpis(OCTOBER(), '2026-10');
  assert.equal(k.consultations.booked, 3);
  assert.equal(k.consultations.held, 3);
  assert.equal(k.consultations.revenue, 2 * FEE + 300);
  assert.equal(k.consultations.paidByStaff, 1);
  assert.deepEqual([k.consultations.virtual, k.consultations.inPerson, k.consultations.phone], [1, 1, 1]);
  assert.deepEqual([k.consultations.newClients, k.consultations.existingClients], [2, 1]);
  assert.deepEqual(k.consultations.byConsultant, { [SHAFOLI]: 2, [SHERMIN]: 1 });
  assert.deepEqual(funnelOf(k), { leads: 4, booked: 3, consulted: 3, retained: 1, retainedDirect: 1, paid: 1 });
  assert.deepEqual(k.funnel.rates, { bookedFromLeads: 75, retainedFromBooked: 33.3, paidFromRetained: 50 });
});

test('October with the direct rows: every consultation is counted, only the New one enters the funnel', () => {
  const before = computeKpis(OCTOBER(), '2026-10');
  const k = computeKpis([...OCTOBER(), ...DIRECT_OCTOBER()], '2026-10');

  // consultation volume: all four direct rows
  assert.equal(k.consultations.booked, before.consultations.booked + 4);
  assert.equal(k.consultations.held, before.consultations.held + 3, 'the 30 Oct one is not held yet');
  assert.deepEqual(k.consultations.byConsultant, { [SHAFOLI]: 4, [SHERMIN]: 2, [GAURI]: 1 }, 'by consultant, Gauri included');
  assert.deepEqual([k.consultations.virtual, k.consultations.inPerson, k.consultations.phone], [2, 3, 2]);
  // revenue: Paid in Square $300 + cash $200 (fees before HST); the free one adds nothing
  assert.equal(k.consultations.revenue, before.consultations.revenue + 300 + 200);
  assert.equal(k.consultations.paidByStaff, before.consultations.paidByStaff + 2);
  assert.equal(k.consultations.waived, before.consultations.waived + 1);
  // new / existing: both Existing client rows are existing — the "Previous client…" one too
  assert.equal(k.consultations.existingClients, before.consultations.existingClients + 2);
  assert.equal(k.consultations.newClients, before.consultations.newClients + 2, 'New + Follow-up');

  // the funnel: only the New one
  assert.deepEqual(funnelOf(k), { ...funnelOf(before), leads: before.funnel.leads + 1, booked: before.funnel.booked + 1, consulted: before.funnel.consulted + 1 });
  assert.equal(k.totalLeads, OCTOBER().length + 4, 'totalLeads still counts every row');
});

test('adding only Follow-up and Existing client rows leaves the funnel and its rates exactly as they were', () => {
  const before = computeKpis(OCTOBER(), '2026-10');
  const extra = DIRECT_OCTOBER().filter((l) => l.directConsult !== 'New');
  const k = computeKpis([...OCTOBER(), ...extra], '2026-10');
  assert.deepEqual(k.funnel, before.funnel);
  assert.equal(k.consultations.booked, before.consultations.booked + 3);
});

test('a New direct row counts exactly like the same consultation booked any other way', () => {
  const [row] = DIRECT_OCTOBER();
  const plain = { ...row }; delete plain.directConsult; plain.consultOption = JSON.stringify({ durationMin: 30 });
  const a = computeKpis([...OCTOBER(), row], '2026-10');
  const b = computeKpis([...OCTOBER(), plain], '2026-10');
  assert.deepEqual(a, b);
});

test('the marker in consultOption alone is enough (the Monday column is not made yet: its id ships empty)', () => {
  assert.equal(C.directConsult, '', 'the column id ships empty');
  const withCol = computeKpis([...OCTOBER(), ...DIRECT_OCTOBER()], '2026-10');
  const noCol = DIRECT_OCTOBER().map((l) => { const x = { ...l }; delete x.directConsult; return x; });
  const k = computeKpis([...OCTOBER(), ...noCol], '2026-10');
  assert.deepEqual(k, withCol);
});

test('"Existing" on the new / existing card: the direct row is checked before the label', () => {
  const kPrev = computeKpis([direct('Existing client', { bookedSlot: '2026-10-05 10:00', relationshipWithTdot: PREVIOUS })], '2026-10');
  assert.deepEqual([kPrev.consultations.newClients, kPrev.consultations.existingClients], [0, 1]);
  // the same label on a row that is not a direct consultation: unchanged (the label check — step 6 fixes it)
  const kOld = computeKpis([{ bookedSlot: '2026-10-05 10:00', relationshipWithTdot: PREVIOUS }], '2026-10');
  assert.deepEqual([kOld.consultations.newClients, kOld.consultations.existingClients], [1, 0]);
  // a New direct row for an existing client's new matter: the label decides, as for any lead
  const kNewMatter = computeKpis([direct('New', { bookedSlot: '2026-10-05 10:00', relationshipWithTdot: ACTIVE })], '2026-10');
  assert.deepEqual([kNewMatter.consultations.newClients, kNewMatter.consultations.existingClients], [0, 1]);
  // a Follow-up: the label decides
  const kFu = computeKpis([direct('Follow-up', { bookedSlot: '2026-10-05 10:00', relationshipWithTdot: 'New inquiry' })], '2026-10');
  assert.deepEqual([kFu.consultations.newClients, kFu.consultations.existingClients], [1, 0]);
});

test('a direct row whose kind cannot be read counts like any lead (as before step 2)', () => {
  const odd = { bookedSlot: '2026-10-05 10:00', consultationHeld: '2026-10-05', createdAt: '2026-10-05T14:00:00Z', consultOption: JSON.stringify({ directConsult: { inSquare: true } }) };
  const broken = { ...odd, consultOption: '{"directConsult": {"kind": "Existing cl' };   // unreadable JSON
  for (const l of [odd, broken]) {
    const k = computeKpis([l], '2026-10');
    assert.deepEqual([k.funnel.leads, k.funnel.booked, k.funnel.consulted, k.consultations.booked], [1, 1, 1, 1]);
  }
});

test('the month window is by each date: a Follow-up created in October for a November time stays out of both funnels', () => {
  const fu = direct('Follow-up', { bookedSlot: '2026-11-03 10:00', consultationHeld: '2026-11-03', createdAt: '2026-10-28T14:00:00Z' });
  const oct = computeKpis([fu], '2026-10'), nov = computeKpis([fu], '2026-11');
  assert.deepEqual([oct.funnel.leads, oct.consultations.booked], [0, 0]);
  assert.deepEqual([nov.funnel.booked, nov.funnel.consulted, nov.consultations.booked, nov.consultations.held], [0, 0, 1, 1]);
  // all time: counted once as a consultation, never in the funnel
  const all = computeKpis([fu], '');
  assert.deepEqual([all.funnel.leads, all.funnel.booked, all.consultations.booked], [0, 0, 1]);
});

// ── The staff guide (guide-data.json): the entries for Direct consultation ──

test('guide: the three new steps, linked from the side paths, how-tos, glossary and the steps around them', () => {
  const fs = require('fs');
  const g = JSON.parse(fs.readFileSync(require.resolve('../src/staffGuide/guide-data.json'), 'utf8'));
  const byId = Object.fromEntries(g.steps.map((s) => [s.id, s]));
  const add = byId['consultation-direct-add'], time = byId['consultation-direct-change-time'], otter = byId['consultation-otter-summary'];
  assert.ok(add && time && otter, 'the steps');
  assert.equal(add.switch, 'DIRECT_CONSULTATION'); assert.equal(time.switch, 'DIRECT_CONSULTATION');
  assert.equal(otter.switch, '', 'the Otter tick is not behind the switch');
  assert.match(add.where, /Consultations page \(\/admin\/consultations\) → '＋ Direct consultation'/);
  assert.match(add.client_sees, /Nothing, unless you tick the package/);
  // every step id the guide points to exists (the page silently drops the others)
  const ids = (xs) => xs.flatMap((x) => x.step_ids || []);
  for (const id of [...add.related, ...time.related, ...otter.related, ...ids(g.howto), ...ids(g.branches)]) assert.ok(byId[id], `step ${id}`);
  assert.ok(g.branches.some((b) => b.id === 'branch-direct-consultation'));
  assert.ok(g.howto.some((h) => (h.step_ids || []).includes('consultation-otter-summary')));
  assert.ok(g.glossary.some((t) => t.term === 'Direct consultation'));
  assert.ok(g.statuses.some((s) => s.field === 'Direct Consultation (Lead Board column)'));
  // the steps around them say what changed
  assert.ok(byId['reporting-kpis'].watch_out.some((w) => /only a 'New' one counts/.test(w)), 'the funnel rule');
  assert.ok(byId['consultations-needs-outcome'].watch_out.some((w) => /never listed here/.test(w)));
  assert.match(byId['consult-fee-record'].options[0].label, /Paid in Square \(booked by the team, not the booking link\)/);
  for (const id of ['auto-consult-reminder-24h', 'auto-consult-reminder-1h', 'auto-preconsult-chase']) {
    assert.match(g.automatic.find((a) => a.id === id).does, /Already booked in Square\?' No/);
  }
  // the exact words on screen: each label marked exact is in the page code, word for word
  const src = ['../src/routes/directConsultUi.js', '../src/routes/adminConsultation.js', '../src/routes/updatesWidget.js']
    .map((p) => fs.readFileSync(require.resolve(p), 'utf8')).join('\n').replace(/<[^<>]*>/g, ' ').replace(/\s+/g, ' ');
  for (const s of [add, time, otter]) {
    for (const o of s.options.filter((x) => x.exact)) {
      assert.ok(src.includes(o.label), `"${o.label}" (${s.id}) is on screen`);
    }
  }
});
