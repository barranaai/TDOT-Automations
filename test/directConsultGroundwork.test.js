'use strict';

// Direct consultation, commit 1 — groundwork, no visible change (step 2, 2026-11-09).
// Melanie books most consultations in Square; staff will add them to the app by hand
// ("＋ Direct consultation", commit 2/3). Before that can ship:
//   - the four Booked-lead jobs read EVERY Booked lead (one paged reader; they read only
//     the first 200, and there are 123 now);
//   - a direct row gets no client reminder / form chase unless staff said it is NOT in
//     Square, and an existing-client row no post-consultation nudge — read from the ROW
//     (fail closed), never from the DIRECT_CONSULTATION switch;
//   - the marker column is not made yet: its id is EMPTY, and nothing breaks at load —
//     the consultOption marker still works, and a create that needs the column refuses (503);
//   - the Leads list hides a direct row; classifyLead puts it on Consultations;
//   - "Paid in Square" is a payment kind; RELATIONSHIPS is exported.

const test   = require('node:test');
const assert = require('node:assert/strict');

const mondayApi           = require('../src/services/mondayApi');
const leadService         = require('../src/services/leadService');
const consultationService = require('../src/services/consultationService');
const postConsult         = require('../src/services/postConsultService');
const transcripts         = require('../src/services/teamsTranscriptService');
const portal              = require('../src/services/consultantPortalService');
const snap                = require('../src/services/leadSnapshot');
const cp                  = require('../src/services/consultPaymentService');
const microsoftMail       = require('../src/services/microsoftMailService');
const dc                  = require('../src/utils/directConsult');
const boardCfg            = require('../src/data/newLeadsBoard.json');
const C = boardCfg.columns;

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function quiet() { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; return () => { console.log = l; console.warn = w; }; }
/** Toronto 'YYYY-MM-DD HH:MM', ms from now. */
function torontoIn(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
/** Run fn with the marker column id set (as it will be once the Monday column is made), then restore the shipped "". */
async function withColumn(id, fn) {
  const before = C.directConsult;
  C.directConsult = id;
  try { return await fn(); } finally { C.directConsult = before; }
}
function withSwitch(value, fn) {
  return async () => {
    const before = process.env.DIRECT_CONSULTATION;
    if (value === undefined) delete process.env.DIRECT_CONSULTATION; else process.env.DIRECT_CONSULTATION = value;
    try { await fn(); } finally { if (before === undefined) delete process.env.DIRECT_CONSULTATION; else process.env.DIRECT_CONSULTATION = before; }
  };
}

/**
 * A fake Booked population served page by page, as Monday does: the first query
 * (items_page_by_column_values) and then next_items_page with the cursor.
 */
function pagedMonday(items, { pageSize = 100, onOther } = {}) {
  const calls = [];
  const page = (from) => {
    const slice = items.slice(from, from + pageSize);
    const more = from + pageSize < items.length;
    return { cursor: more ? `cur-${from + pageSize}` : null, items: slice };
  };
  const fn = async (q, v) => {
    calls.push({ q, v });
    if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: page(0) };
    if (/next_items_page/.test(q)) return { next_items_page: page(Number(String(v.cursor).replace('cur-', ''))) };
    return onOther ? onOther(q, v) : {};
  };
  return { fn, calls };
}

/* ── the shipped config: the column is not made yet ── */

test('config: the Direct Consultation column id ships EMPTY (Faran has not OK\'d the Monday column), typed as text', () => {
  assert.equal(C.directConsult, '', 'leave it empty until the column is made');
  assert.equal(dc.columnId(), '');
  assert.equal(dc.isSetUp(), false);
  const src = require('fs').readFileSync(require.resolve('../src/services/leadService'), 'utf8');
  assert.match(src, /directConsult: 'text'/);
});

/* ── the one paged reader ── */

test('paging: pages of 100, the cursor followed to the end, updates(limit: 25) only when asked, empty column ids dropped', async () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ id: String(i + 1), name: `L${i + 1}`, column_values: [] }));
  const m = pagedMonday(items);
  const r = stub(mondayApi, 'query', m.fn);
  try {
    const got = await leadService.readBookedLeadItems({ columnIds: [C.bookedSlot, '', null, C.bookedSlot, dc.columnId()], updates: true });
    assert.equal(got.length, 250, 'rows past the old 200 are read');
    assert.deepEqual(got.map((x) => x.id), items.map((x) => x.id));
    assert.equal(m.calls.length, 3, 'one first page + two next pages');
    assert.match(m.calls[0].q, /items_page_by_column_values\(limit: 100,/);
    assert.equal(m.calls[0].v.colId, C.bookingStatus);
    assert.equal(m.calls[0].v.val, 'Booked');
    for (const c of m.calls.slice(1)) assert.match(c.q, /next_items_page\(limit: 100, cursor: \$cursor\)/);
    for (const c of m.calls) {
      assert.match(c.q, /updates\(limit: 25\) \{ body \}/, 'every page asks for the notes, capped');
      assert.match(c.q, new RegExp(`column_values\\(ids: \\["${C.bookedSlot}"\\]\\)`), 'only the asked columns, once, no empty id');
      assert.doesNotMatch(c.q, /""/, 'never an empty column id');
    }
    m.calls.length = 0;
    await leadService.readBookedLeadItems({ columnIds: [C.bookedSlot] });
    assert.doesNotMatch(m.calls[0].q, /updates/, 'no notes unless asked');
  } finally { r(); }
});

test('paging: a cap left with rows remaining is said loudly; a page that stops answering throws; no first page reads as none', async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), column_values: [] }));
  const m = pagedMonday(items, { pageSize: 10 });
  const warns = [];
  const r = [stub(mondayApi, 'query', m.fn), stub(console, 'warn', (s) => warns.push(String(s)))];
  try {
    const got = await leadService.pageItemsByColumnValue('bookingStatus', 'Booked', { pageSize: 10, maxPages: 2 });
    assert.equal(got.length, 20);
    assert.ok(warns.some((w) => /PARTIAL/.test(w)), 'never a silent truncation');
  } finally { r.reverse().forEach((x) => x()); }
  const r2 = stub(mondayApi, 'query', async (q) => (/items_page_by_column_values/.test(q) ? { items_page_by_column_values: { cursor: 'c', items: [{ id: '1' }] } } : {}));
  try { await assert.rejects(leadService.readBookedLeadItems(), /stopped answering/); } finally { r2(); }
  const r3 = stub(mondayApi, 'query', async () => ({}));
  try { assert.deepEqual(await leadService.readBookedLeadItems(), [], 'as before: no answer = no rows'); } finally { r3(); }
});

test('paging: all four Booked-lead jobs read every page — reminders, the nudge / recordings read, transcripts, the package sweep', async () => {
  const items = Array.from({ length: 230 }, (_, i) => ({ id: String(i + 1), name: `L${i + 1}`, updates: [], column_values: [{ id: C.bookedSlot, text: '2026-11-20 10:00' }] }));
  for (const read of [
    () => consultationService.getBookedLeads(),
    () => postConsult.getBookedLeadsFull(),
    () => transcripts.getTranscriptCandidates(),
  ]) {
    const m = pagedMonday(items);
    const r = stub(mondayApi, 'query', m.fn);
    try {
      const rows = await read();
      assert.equal(rows.length, 230);
      assert.equal(rows[229].id, '230');
      assert.equal(m.calls.length, 3);
    } finally { r(); }
  }
  // the sweep reads through findAllByColumnValue's all-pages mode (the same reader), parsed as full leads
  const m = pagedMonday(items.map((it) => ({ ...it, column_values: [{ id: C.bookingStatus, text: 'Booked', value: '{"index":1}' }] })));
  const r = stub(mondayApi, 'query', m.fn);
  try {
    const all = await leadService.findAllByColumnValue('bookingStatus', 'Booked', { allPages: true });
    assert.equal(all.length, 230);
    assert.equal(all[229].bookingStatus, 'Booked');
    assert.match(m.calls[0].q, /column_values \{ id text value \}/, 'every column (the sweep reads the countersign, the address …)');
  } finally { r(); }
  const src = require('fs').readFileSync(require.resolve('../src/services/consultationService'), 'utf8');
  assert.match(src, /findAllByColumnValue\('bookingStatus', 'Booked', \{ allPages: true \}\)/, 'the sweep asks for every page');
  for (const f of ['../src/services/consultationService', '../src/services/postConsultService', '../src/services/teamsTranscriptService']) {
    assert.doesNotMatch(require('fs').readFileSync(require.resolve(f), 'utf8'), /items_page_by_column_values\(limit: 200/, `${f}: no one-page Booked read left`);
  }
});

/* ── the markers (pure) ── */

test('markers: a direct row is known by the column OR consultOption.directConsult; unreadable JSON naming it counts (fail closed)', () => {
  const opt = (o) => ({ consultOption: JSON.stringify(o) });
  assert.equal(dc.isDirectConsult({}), false);
  assert.equal(dc.isDirectConsult(opt({ durationMin: 30, feeCents: 20000, consultant: 'Shafoli' })), false, 'a booking-page choice is not a marker');
  assert.equal(dc.isDirectConsult({ directConsult: 'New' }), true);
  assert.equal(dc.isDirectConsult(opt({ directConsult: { kind: 'New', inSquare: true } })), true);
  assert.equal(dc.isDirectConsult({ consultOption: '{"directConsult":{"kind":"New"' }), true, 'cut-off JSON still names it');
  assert.equal(dc.isDirectConsult({ consultOption: 'not json' }), false);
  assert.equal(dc.isDirectConsult(opt({ directConsult: null })), false);
  assert.equal(dc.kindOf({ directConsult: 'Follow-up' }), 'Follow-up');
  assert.equal(dc.kindOf(opt({ directConsult: { kind: 'Existing client' } })), 'Existing client');
  assert.equal(dc.kindOf(opt({ directConsult: { kind: 'constructor' } })), '');
});

test('markers: client reminders only when inSquare === false is read; the nudge never for an existing client or an unreadable kind', () => {
  const opt = (d) => ({ consultOption: JSON.stringify({ directConsult: d }) });
  assert.equal(dc.clientRemindersAllowed({}), true, 'an ordinary booking');
  assert.equal(dc.clientRemindersAllowed(opt({ kind: 'New', inSquare: true })), false);
  assert.equal(dc.clientRemindersAllowed(opt({ kind: 'New' })), false, 'not said → skipped');
  assert.equal(dc.clientRemindersAllowed(opt({ kind: 'New', inSquare: 'false' })), false, 'only the real false');
  assert.equal(dc.clientRemindersAllowed(opt({ kind: 'New', inSquare: false })), true, 'staff said it is not in Square: the app reminds');
  assert.equal(dc.clientRemindersAllowed({ directConsult: 'New' }), false, 'the column alone: skipped');
  assert.equal(dc.clientRemindersAllowed({ consultOption: '{"directConsult":{"inSquare":false' }), false, 'unreadable: skipped');
  assert.equal(dc.nudgeAllowed({}), true);
  assert.equal(dc.nudgeAllowed({ directConsult: 'New' }), true);
  assert.equal(dc.nudgeAllowed(opt({ kind: 'Follow-up' })), true);
  assert.equal(dc.nudgeAllowed({ directConsult: 'Existing client' }), false);
  assert.equal(dc.nudgeAllowed(opt({ kind: 'Existing client' })), false);
  assert.equal(dc.nudgeAllowed({ directConsult: 'New', ...opt({ kind: 'Existing client' }) }), false, 'either says existing → no nudge');
  assert.equal(dc.nudgeAllowed(opt({ inSquare: true })), false, 'direct with no kind: none (fail closed)');
});

/* ── the reminder, chase and nudge skips (the jobs) ── */

function reminderWorld(rows) {
  const mails = [], notes = [];
  const m = pagedMonday(rows, { onOther: async (q, v) => { if (/create_update/.test(q)) { notes.push(v.itemId || v.i); return { create_update: { id: 'u' } }; } return {}; } });
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'getLead', async (id) => ({ id, name: `L${id}`, email: `l${id}@x.co`, leadToken: 't', meetingType: 'In-person' })),
    stub(microsoftMail, 'sendEmail', async (msg) => { mails.push(msg.to); }),
  ];
  return { mails, notes, calls: m.calls, done: () => restore.reverse().forEach((x) => x()) };
}
const optCell = (o) => ({ id: C.consultOption, text: JSON.stringify(o) });

for (const sw of [undefined, '0', '1']) {
  test(`skips: the 24 h reminder, the 1 h reminder and the form chase skip a direct row in Square — switch ${sw === undefined ? 'unset' : sw} (read from the row)`, withSwitch(sw, async () => {
    const mk = (slot) => (id, extra = []) => ({ id, name: `L${id}`, updates: [], column_values: [{ id: C.bookedSlot, text: slot }, { id: C.preConsultSubmitted, text: '' }, { id: C.consultPayment, text: '' }, ...extra] });
    const cases = (mkRow) => [
      mkRow('1'),                                                                            // ordinary booking
      mkRow('2', [optCell({ durationMin: 30, feeCents: 20000, consultant: 'Shafoli' })]),    // booking-page choice — not direct
      mkRow('3', [optCell({ directConsult: { kind: 'New', inSquare: true } })]),             // in Square → skipped
      mkRow('4', [optCell({ directConsult: { kind: 'New' } })]),                             // not said → skipped
      mkRow('5', [optCell({ directConsult: { kind: 'Follow-up', inSquare: false } })]),      // NOT in Square → the app reminds
      mkRow('6', [{ id: C.consultOption, text: '{"directConsult":{"inSquare":false' }]),     // unreadable → skipped
    ];
    const q = quiet();
    try {
      for (const [run, ms] of [[consultationService.send24hReminders, 24 * 3600e3], [consultationService.send1hReminders, 3600e3], [consultationService.sendPreConsultReminders, 5 * 3600e3]]) {
        const w = reminderWorld(cases(mk(torontoIn(ms))));
        try {
          await run();
          assert.deepEqual(w.mails.sort(), ['l1@x.co', 'l2@x.co', 'l5@x.co']);
          assert.ok(w.calls[0].q.includes(`"${C.consultOption}"`), 'the reminder read carries the consultOption marker');
          assert.doesNotMatch(w.calls[0].q, /""/, 'the empty column id is never asked for');
        } finally { w.done(); }
      }
    } finally { q(); }
  }));
}

test('skips: once the column is made, the column marker alone is enough (fail closed), and the read asks for it', async () => {
  await withColumn('text_dc_test', async () => {
    const slot = torontoIn(24 * 3600e3);
    const row = (id, extra = []) => ({ id, name: `L${id}`, updates: [], column_values: [{ id: C.bookedSlot, text: slot }, { id: C.preConsultSubmitted, text: '' }, { id: C.consultPayment, text: '' }, ...extra] });
    const w = reminderWorld([row('1'), row('2', [{ id: 'text_dc_test', text: 'Existing client' }]), row('3', [{ id: 'text_dc_test', text: 'New' }, optCell({ directConsult: { kind: 'New', inSquare: false } })])]);
    const q = quiet();
    try {
      await consultationService.send24hReminders();
      assert.deepEqual(w.mails.sort(), ['l1@x.co', 'l3@x.co']);
      assert.ok(w.calls[0].q.includes('"text_dc_test"'), 'the marker column is read');
    } finally { w.done(); q(); }
  });
});

for (const sw of [undefined, '0']) {
  test(`skips: the post-consultation nudge skips an existing-client direct row — switch ${sw === undefined ? 'unset' : sw}`, withSwitch(sw, async () => {
    const slot = torontoIn(-2 * 3600e3);
    const row = (id, extra = []) => ({ id, name: `L${id}`, updates: [], column_values: [{ id: C.bookedSlot, text: slot, value: null }, { id: C.outcome, text: '', value: null }, { id: C.fullName, text: `L${id}`, value: null }, ...extra] });
    const writes = [];
    const m = pagedMonday([
      row('11'),
      row('12', [optCell({ directConsult: { kind: 'Existing client', inSquare: true } })]),
      row('13', [optCell({ directConsult: { kind: 'New', inSquare: true } })]),
      row('14', [optCell({ directConsult: { inSquare: true } })]),
    ], { onOther: async (q, v) => { if (/create_update/.test(q)) writes.push(v.i); return { create_update: { id: 'u' } }; } });
    const r = stub(mondayApi, 'query', m.fn);
    const q = quiet();
    try {
      assert.equal(await postConsult.sendPostConsultNudges(), 2);
      assert.deepEqual(writes, ['11', '13'], 'New still gets the "set the Outcome" note; existing and unreadable do not');
      assert.ok(m.calls[0].q.includes(`"${C.consultOption}"`));
    } finally { r(); q(); }
  }));
}

/* ── fails closed at use when the column is not made ── */

test('missing mapping: nothing fails at load; a create that needs the column refuses with 503 before any Monday call', async () => {
  assert.doesNotThrow(() => { for (const f of ['consultationService', 'postConsultService', 'teamsTranscriptService', 'leadService', 'leadSnapshot', 'consultantPortalService']) require(`../src/services/${f}`); });
  assert.ok(!snap.SNAPSHOT_IDS.includes(''), 'the snapshot never asks for an empty column id');
  assert.throws(() => dc.assertSetUp(), (e) => e.status === 503 && e.code === 'DIRECT_CONSULT_NOT_SET_UP' && /not set up yet/.test(e.message));
  const calls = [];
  const r = stub(mondayApi, 'query', async (q) => { calls.push(q); return { create_item: { id: '9' } }; });
  try {
    await assert.rejects(leadService.createLead({ fullName: 'ZZ TEST', email: 'z@x.co', directConsult: 'New', bookedSlot: '2026-11-20 10:00' }), (e) => e.status === 503);
    assert.equal(calls.length, 0, 'no row is made without its marker column');
  } finally { r(); }
});

/* ── createLead: the create-time keys on the direct path only ── */

async function captureCreate(formData) {
  const calls = [];
  const restore = [
    stub(mondayApi, 'query', async (q, v) => { calls.push({ q, v }); if (/create_item/.test(q)) return { create_item: { id: '999' } }; if (/items_page\(limit:1\)/.test(q)) return { boards: [{ groups: [{ items_page: { items: [] } }] }] }; return {}; }),
    stub(require('../src/services/leadTokenService'), 'ensureToken', async () => 'LEAD-x'),
    stub(require('../src/services/oneDriveService'), 'ensureLeadFolder', async () => { throw new Error('no folder in tests'); }),
  ];
  const q = quiet();
  try {
    await leadService.createLead(formData, { createRetries: 0 });
    return JSON.parse(calls.find((c) => /create_item/.test(c.q)).v.cols);
  } finally { restore.reverse().forEach((x) => x()); q(); }
}

test('createLead: a direct consultation is created BOOKED with its marker and booking; no dropdown at create; a plain lead is unchanged', async () => {
  await withColumn('text_dc_test', async () => {
    const cols = await captureCreate({ fullName: 'ZZ TEST', email: 'z@x.co', directConsult: 'Existing client', bookedSlot: '2026-11-20 10:00', consultationHeld: '2026-11-20',
      assignedConsultant: 'Shafoli Kapur', meetingType: 'In-person', bookedBy: 'Melanie', caseTypeInterest: 'Express Entry' });
    assert.equal(cols.text_dc_test, 'Existing client');
    assert.deepEqual(cols[C.bookingStatus], { label: 'Booked' });
    assert.deepEqual(cols[C.conversionStatus], { label: 'Booked' }, 'never a "New" lead, even for a moment');
    assert.equal(cols[C.bookedSlot], '2026-11-20 10:00');
    assert.deepEqual(cols[C.consultationHeld], { date: '2026-11-20' });
    assert.equal(cols[C.assignedConsultant], 'Shafoli Kapur');
    assert.equal(cols[C.meetingType], 'In-person');
    assert.equal(cols[C.bookedBy], 'Melanie');
    assert.ok(!(C.caseTypeInterest in cols), 'a dropdown can fail create_item on a missing label — written by updateLead instead');
    const plain = await captureCreate({ fullName: 'P', email: 'p@x.co', bookingStatus: 'Booked', bookedSlot: '2026-11-20 10:00', bookedBy: 'X', caseTypeInterest: 'Express Entry' });
    assert.deepEqual(plain[C.conversionStatus], { label: 'New' });
    for (const k of ['bookingStatus', 'bookedSlot', 'bookedBy']) assert.ok(!(C[k] in plain), `${k} is never written at create on the ordinary path`);
    assert.ok(!('text_dc_test' in plain));
    assert.deepEqual(plain[C.caseTypeInterest], { labels: ['Express Entry'] }, 'the ordinary path keeps its dropdown');
  });
});

/* ── the lists ── */

test('lists: classifyLead puts a direct row on Consultations; the Leads list hides any row with a marker (second guard)', async () => {
  const direct = { id: '1', bookingStatus: 'Booked', conversionStatus: 'Booked', directConsult: 'New' };
  assert.equal(portal.classifyLead(direct), 'consultation');
  assert.equal(portal.classifyLead({ ...direct, directConsult: '', consultOption: JSON.stringify({ directConsult: { kind: 'Existing client' } }) }), 'consultation');
  const leads = [
    { id: '10', fullName: 'Plain', createdAt: '2026-11-01T10:00:00Z' },
    { id: '11', fullName: 'Marked by column', directConsult: 'Follow-up', createdAt: '2026-11-02T10:00:00Z' },
    { id: '12', fullName: 'Marked in consultOption', consultOption: JSON.stringify({ directConsult: { kind: 'New', inSquare: true } }), createdAt: '2026-11-03T10:00:00Z' },
    { id: '13', fullName: 'Booking-page choice', consultOption: JSON.stringify({ durationMin: 30 }), createdAt: '2026-11-04T10:00:00Z' },
  ];
  portal.invalidateLeadsQueue();
  const r = stub(snap, 'leads', async () => leads);
  try {
    const rows = await portal.getLeadsQueue();
    assert.deepEqual(rows.map((x) => x.id).sort(), ['10', '13']);
  } finally { r(); portal.invalidateLeadsQueue(); }
  assert.ok(snap.SNAPSHOT_KEYS.includes('bookedBy') && snap.SNAPSHOT_IDS.includes(C.bookedBy), 'the lists read who booked it');
  assert.ok(snap.SNAPSHOT_KEYS.includes('consultOption'), 'and the consultOption marker');
  assert.equal(snap.SNAPSHOT_KEYS.includes('directConsult'), !!C.directConsult, 'the marker column joins the snapshot once it is made (empty id: left out)');
  assert.match(require('fs').readFileSync(require.resolve('../src/services/leadSnapshot'), 'utf8'), /\.\.\.\(COLS\.directConsult \? \['directConsult'\] : \[\]\)/);
});

/* ── "Paid in Square" and the relationship labels ── */

test('payment kind: "square" (paid in Square outside the app) is a kind; Object.prototype names are still refused', () => {
  const v = cp.validateRecord({ kind: 'square', amountCents: 20000, on: '2026-11-08' }, { today: '2026-11-09' });
  assert.deepEqual(v, { ok: true, normalized: { kind: 'square', amountCents: 20000, on: '2026-11-08', reference: '', note: '', package: '', packageNote: '', booking: null } });
  assert.equal(cp.KINDS.square, 'Paid in Square');
  const stored = { consultPayment: JSON.stringify({ kind: 'square', amountCents: 20000, on: '2026-11-08', by: 'Melanie', verified: true }) };
  assert.equal(cp.paidState(stored).paid, 'square');
  assert.equal(cp.paidState(stored).paidCents, 20000);
  assert.match(cp.describe(cp.parseConsultPayment(stored)), /^Paid in Square \$200\.00 received 2026-11-08 by Melanie$/);
  assert.equal(cp.validateRecord({ kind: 'square' }, { today: '2026-11-09' }).ok, false, 'a paid kind needs the amount');
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'Square', 'SQUARE']) {
    assert.equal(cp.validateRecord({ kind: k, amountCents: 100 }, { today: '2026-11-09' }).ok, false, `kind ${k}`);
    assert.equal(cp.paidState({ consultPayment: JSON.stringify({ kind: k, amountCents: 100, on: '2026-10-01' }) }).paid, '', `stored kind ${k}`);
  }
});

test('RELATIONSHIPS: exported, exactly the board\'s three labels (the direct consultation writes them)', () => {
  assert.deepEqual(require('../src/services/intakeFormService').RELATIONSHIPS,
    ['New inquiry', 'Existing client with active application', 'Previous client with completed or inactive application']);
});
