'use strict';

// Gauri point 4, part 1 (2026-10-15): one shared Lead Board snapshot behind every
// list (speed), and the Consultations page split into Leads | Consultations |
// Retainers | Reporting with a Today / week / month control. Faran's decisions:
// past consultations with no outcome stay on Consultations ("Needs outcome");
// hand-booked rows with no date sit in a "No date" list; a booked client moves
// to Retainers once a retainer is sent; retained clients drop off both.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');

const snap   = require('../src/services/leadSnapshot');
const portal = require('../src/services/consultantPortalService');
const booking = require('../src/services/bookingService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const L = (id, over = {}) => ({ id: String(id), name: `Lead ${id}`, fullName: `Lead ${id}`, createdAt: '2026-10-01T12:00:00Z', ...over });

/* ── the snapshot ── */

test('snapshot: one read shared by every caller; served as is while fresh; refreshed in the background once it ages; a failed background refresh keeps the copy', async () => {
  snap._reset();
  let now = 1_000_000, reads = 0, fail = false;
  const restore = [stub(snap.io, 'now', () => now), stub(snap.io, 'fetchLeads', async () => { reads++; if (fail) throw new Error('Monday 503'); await new Promise((r) => setTimeout(r, 5)); return [L(1), L(2)]; })];
  try {
    const [a, b, c] = await Promise.all([snap.leads(), snap.leads(), portal.getLeadsQueue()]);
    assert.equal(reads, 1, 'three callers, one read');
    assert.equal(a.length, 2); assert.equal(b, a);
    now += snap.TTL_MS - 1000;
    await snap.leads();
    assert.equal(reads, 1, 'still fresh: no read');
    now += 5000;                                             // past the TTL
    fail = true;
    const s1 = await snap.getLeadSnapshot();
    assert.equal(s1.leads.length, 2, 'the copy is served at once…');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(reads, 2, '…and a refresh ran in the background');
    fail = false;
    const s2 = await snap.getLeadSnapshot();
    assert.ok(!s2.stale && s2.leads.length === 2, 'the old copy survived the failed refresh');
  } finally { restore.forEach((r) => r()); snap._reset(); }
});

test('snapshot: invalidate() makes the next read wait for fresh data (a deleted lead must not linger); fresh:true always reads; a failed FORCED read throws, a failed plain read serves the copy', async () => {
  snap._reset();
  let reads = 0, rows = [L(1)], fail = false, now = 5_000_000;
  const restore = [stub(snap.io, 'now', () => now), stub(snap.io, 'fetchLeads', async () => { reads++; if (fail) throw new Error('Monday 503'); return rows.slice(); })];
  try {
    assert.equal((await snap.leads()).length, 1);
    rows = [L(1), L(9)];
    assert.equal((await snap.leads()).length, 1, 'cached');
    snap.invalidate();
    assert.equal((await snap.leads()).length, 2, 'after invalidate: fresh');
    rows = [L(1)];
    assert.equal((await snap.leads({ fresh: true })).length, 1);
    assert.equal(reads, 3);
    fail = true;
    now += snap.HARD_MAX_MS + 1;                              // too old to show without a read — and the read fails
    const s = await snap.getLeadSnapshot();
    assert.deepEqual([s.stale, s.leads.length], [true, 1], 'a failed plain read: the copy, flagged stale');
    snap.invalidate();
    const s2 = await snap.getLeadSnapshot();
    assert.deepEqual([s2.stale, s2.leads.length], [true, 1], 'invalidated + failed: still the copy, flagged stale (the page says Monday could not be read)');
    await assert.rejects(snap.leads({ fresh: true }), /Monday 503/, 'only a caller that insists on fresh data gets the error');
  } finally { restore.forEach((r) => r()); snap._reset(); }
});

test('snapshot: reads only the columns the lists use, 500 a page, every page, parsed like getLead', async () => {
  snap._reset();
  const mondayApi = require('../src/services/mondayApi');
  const C = require('../src/data/newLeadsBoard.json').columns;
  const calls = [];
  const restore = [stub(mondayApi, 'query', async (q, v) => {
    calls.push({ q, v });
    const page = v.cursor ? 1 : 0;
    const oc = page === 0 ? [{ id: C.outcome, text: 'Follow-Up', value: '{"index":9,"changed_at":"2026-10-16T03:30:00.123Z"}' }] : [{ id: C.outcome, text: '', value: '{not json' }];
    return { boards: [{ items_page: { cursor: page === 0 ? 'c1' : null, items: [{ id: String(100 + page), name: `N${page}`, created_at: '2026-10-01T00:00:00Z', column_values: [{ id: C.bookingStatus, text: 'Booked', value: '{"index":3}' }, { id: C.bookedSlot, text: '2026-10-20 11:00', value: null }, ...oc] }] } }] };
  })];
  try {
    const leads = await snap.leads();
    assert.equal(calls.length, 2, 'two pages');
    assert.match(calls[0].q, /items_page\(limit: 500, cursor: \$cursor\)/);
    assert.ok(calls[0].q.includes(`"${C.consultAgreementSent}"`) && calls[0].q.includes(`"${C.squareConsultTxnId}"`) && !calls[0].q.includes(`"${C.email}"`), 'the list columns, not the client\'s email');
    assert.equal(calls[1].v.cursor, 'c1');
    assert.deepEqual(leads.map((l) => [l.id, l.fullName, l.bookingStatus, l.bookedSlot]), [['100', 'N0', 'Booked', '2026-10-20 11:00'], ['101', 'N1', 'Booked', '2026-10-20 11:00']]);
    assert.deepEqual(leads.map((l) => [l.outcome, l.outcomeChangedAt]), [['Follow-Up', '2026-10-16T03:30:00.123Z'], ['', '']], 'when the Outcome was last set (Monday\'s changed_at); an unreadable value is unknown, never a throw');
    assert.ok(snap.SNAPSHOT_KEYS.every((k) => C[k]), 'every snapshot key is a real column');
  } finally { restore.forEach((r) => r()); snap._reset(); }
});

/* ── the classifier: one row, one tab ── */

test('classifyLead: every Lead Board row lands on exactly one of Leads / Consultations / Retainers — or is gone (retained)', () => {
  const c = portal.classifyLead;
  assert.equal(c(L(1)), 'lead');
  assert.equal(c(L(1, { bookingStatus: 'Slot Held' })), 'lead');
  assert.equal(c(L(1, { bookingStatus: 'Abandoned', bookedSlot: '2026-10-16 15:00' })), 'lead');
  assert.equal(c(L(1, { bookingStatus: 'Booked', bookedSlot: '2026-10-16 15:00' })), 'consultation');
  assert.equal(c(L(1, { bookingStatus: 'Booked' })), 'consultation', 'hand-booked, no date: still a consultation (the No date list)');
  assert.equal(c(L(1, { bookingStatus: 'Booked', outcome: 'Follow-Up' })), 'consultation');
  assert.equal(c(L(1, { bookingStatus: 'Booked', outcome: 'Retain' })), 'retainer', 'the consultant chose Retain: the retainer team\'s turn');
  assert.equal(c(L(1, { bookingStatus: 'Booked', retainerSent: '2026-10-10' })), 'retainer');
  assert.equal(c(L(1, { retainerSent: '2026-10-10' })), 'retainer', 'a retainer sent by hand to an unbooked lead');
  assert.equal(c(L(1, { sourceChannel: 'Direct Retainer' })), 'retainer');
  assert.equal(c(L(1, { sourceChannel: 'Direct Retainer', clientMasterItemId: '555' })), 'retainer', 'a direct client has a case from day one — still at the retainer stage');
  assert.equal(c(L(1, { bookingStatus: 'Booked', retainerPaid: '2026-10-12', conversionStatus: 'Retained' })), 'gone');
  assert.equal(c(L(1, { conversionStatus: 'Retained — Awaiting Payment', retainerSigned: '2026-10-12' })), 'retainer', 'only the exact Retained label is gone');
  // a partition: no row in two places
  const kinds = ['lead', 'consultation', 'retainer', 'gone'];
  for (const l of [L(1), L(2, { bookingStatus: 'Booked', outcome: 'Retain', retainerSent: '2026-10-10' }), L(3, { sourceChannel: 'Direct Retainer', conversionStatus: 'Retained' })]) assert.ok(kinds.includes(c(l)));
  // the Leads queue uses the same rule
  const src = fs.readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.match(src, /leads\.filter\(\(l\) => classifyLead\(l\) === 'lead'\)/);
});

test('getConsultationsBoard: the two tabs from one snapshot — consultation rows earliest first with the wanted columns, retainer rows by stage; no email or phone', async () => {
  snap._reset();
  const rows = [
    L(1, { bookingStatus: 'Booked', bookedSlot: '2026-10-20 11:00', assignedConsultant: 'Shafoli Kapur', meetingType: 'In-person', consultAgreementSent: '2026-10-14', consultAgreementSigned: '2026-10-15', preConsultSubmitted: 'Yes', squareConsultTxnId: 'SQ1', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 }), confirmedCaseType: 'Study permit', email: 'x@y.co', phone: '416' }),
    L(2, { bookingStatus: 'Booked', bookedSlot: '2026-10-16 15:00', serviceRequired: 'Visitor visa', outcome: 'Follow-Up' }),
    L(3, { bookingStatus: 'Booked' }),
    L(4, { sourceChannel: 'Direct Retainer', retainerFee: '2000', retainerSent: '2026-10-01', clientMasterItemId: '9', confirmedCaseType: 'OINP', createdAt: '2026-10-01T00:00:00Z' }),
    L(5, { bookingStatus: 'Booked', outcome: 'Retain', bookedSlot: '2026-10-09 10:00', createdAt: '2026-09-20T00:00:00Z' }),
    L(6, { sourceChannel: 'Direct Retainer', retainerSent: '2026-10-05', retainerSigned: '2026-10-06', retainerPaid: '2026-10-07', createdAt: '2026-10-05T00:00:00Z' }),
    L(7, { sourceChannel: 'Direct Retainer', conversionStatus: 'Retained' }),
    L(8),
  ];
  const restore = [stub(snap.io, 'fetchLeads', async () => rows)];
  try {
    const b = await portal.getConsultationsBoard({ now: new Date('2026-10-15T16:00:00Z') });   // noon in Toronto, the day before row 2's time
    assert.deepEqual(b.consultations.map((r) => r.id), ['2', '1', '3'], 'earliest first, no date last');
    const r1 = b.consultations[1];
    assert.deepEqual(r1, { id: '1', name: 'Lead 1', service: 'Study permit', consultant: 'Shafoli Kapur', bookedSlot: '2026-10-20 11:00', meetingType: 'In-person', preConsultSubmitted: true, agreementSent: '2026-10-14', agreementSigned: '2026-10-15', paid: 'app', paidCents: 22600, paidBy: '', paidOn: '', paidVerified: true, outcome: '', followUpDate: '', consultationHeld: '', hasMeeting: false, tier: '', createdAt: '2026-10-01T12:00:00Z' });
    assert.ok(!JSON.stringify(b).includes('x@y.co') && !JSON.stringify(b).includes('416'), 'a list, not a record');
    assert.deepEqual(b.retainers.map((r) => [r.id, r.stage, r.kind]), [['6', 'Paid', 'direct'], ['4', 'Sent', 'direct'], ['5', 'Retain', 'booked']], 'by stage, then oldest first; the retained client is gone');
    assert.equal(b.retainers[1].caseOpen, true);
    assert.ok(Number.isFinite(b.at) && Number.isFinite(b.ageMs));
    // the Leads queue sees only 8 (its own 20 s memo dropped first)
    portal.invalidateLeadsQueue();
    assert.deepEqual((await portal.getLeadsQueue()).map((r) => r.id), ['8']);
  } finally { restore.forEach((r) => r()); snap._reset(); }
});

/* ── the booking page reads the snapshot; the hold step reads Monday ── */

test('booking page: taken times come from the snapshot plus this process\'s recent holds — no board read per view; the hold step still reads Monday strictly', async () => {
  snap._reset();
  const mondayApi = require('../src/services/mondayApi');
  const C = require('../src/data/newLeadsBoard.json').columns;
  const leadService = require('../src/services/leadService');
  let boardReads = 0;
  const restore = [
    stub(snap.io, 'fetchLeads', async () => [L(1, { bookingStatus: 'Booked', bookedSlot: '2026-10-16 15:00', assignedConsultant: 'Shermin Teymouri Mofrad' })]),
    stub(mondayApi, 'query', async (q, v) => { if (/items_page\(limit: 500/.test(q)) { boardReads++; return { boards: [{ items_page: { cursor: null, items: [{ id: '1', name: 'A', column_values: [{ id: C.bookingStatus, text: 'Booked' }, { id: C.bookedSlot, text: '2026-10-16 15:00' }, { id: C.slotHeldUntil, text: '' }, { id: C.assignedConsultant, text: 'Shermin Teymouri Mofrad' }] }] } }] }; } return {}; }),
    stub(leadService, 'updateLead', async () => {}),
  ];
  try {
    const view = await booking.readSlotClaims();
    assert.deepEqual(view.map((c) => [c.leadId, c.slot, c.status]), [['1', '2026-10-16 15:00', 'Booked']]);
    assert.equal(boardReads, 0, 'the page view read the snapshot');
    const held = await booking.holdSlotIfFree('77', '2026-10-23', '15:00', 'Shermin Teymouri Mofrad');
    assert.equal(held.ok, true);
    assert.equal(boardReads, 1, 'the hold read Monday');
    const view2 = await booking.readSlotClaims();
    assert.ok(view2.some((c) => c.leadId === '77' && c.slot === '2026-10-23 15:00' && c.status === 'Slot Held'), 'the hold just made shows on the next page view even before the snapshot refreshes');
  } finally { restore.forEach((r) => r()); snap._reset(); }
});

/* ── the page ── */

function pageFns() {
  const html = require('../src/routes/adminConsultation').buildQueueHTML();
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
  const a = js.indexOf('function dParts('), b = js.indexOf('function timeCell(');
  const head = js.slice(a, b);
  return new Function('todayStr', 'RANGE', 'ANCHOR', `${head}; return { dParts, dAdd, dDow, dMonthAdd, dLabel, rangeBounds, rangeLabel, inRange };`);
}

test('page: Today / week (Mon–Sun) / month ranges are calendar maths on Toronto days — no local Date; the labels read right', () => {
  const mk = pageFns();
  const today = () => '2026-10-15';   // a Thursday
  let f = mk(today, 'today', '2026-10-15');
  assert.deepEqual(f.rangeBounds(), ['2026-10-15', '2026-10-15']);
  assert.equal(f.rangeLabel(), 'Today — Thu, Oct 15, 2026');
  assert.ok(f.inRange('2026-10-15 09:00') && !f.inRange('2026-10-16 09:00') && !f.inRange(''));
  f = mk(today, 'today', '2026-10-16'); assert.equal(f.rangeLabel(), 'Tomorrow — Fri, Oct 16, 2026');
  f = mk(today, 'week', '2026-10-15');
  assert.deepEqual(f.rangeBounds(), ['2026-10-12', '2026-10-18'], 'Monday to Sunday');
  assert.ok(f.inRange('2026-10-18 23:00') && !f.inRange('2026-10-19 00:00'));
  f = mk(today, 'week', '2026-10-18'); assert.deepEqual(f.rangeBounds(), ['2026-10-12', '2026-10-18'], 'a Sunday belongs to the week before');
  f = mk(today, 'month', '2026-10-15');
  assert.deepEqual(f.rangeBounds(), ['2026-10-01', '2026-10-31']);
  assert.equal(f.rangeLabel(), 'October 2026');
  f = mk(today, 'month', '2026-02-10'); assert.deepEqual(f.rangeBounds(), ['2026-02-01', '2026-02-28']);
  f = mk(today, 'all', '2026-10-15'); assert.ok(f.inRange('1999-01-01 00:00') && !f.inRange('no date'));
  assert.equal(f.dAdd('2026-12-31', 1), '2027-01-01');
  assert.equal(f.dMonthAdd('2026-01-31', 1), '2026-02-01');
  assert.equal(f.dDow('2026-10-12'), 1);
});

test('page: the tabs, the lists, the columns and the controls are emitted; the script parses; the old mixed section is gone', () => {
  const html = require('../src/routes/adminConsultation').buildQueueHTML();
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
  for (const s of ['<a class="tab" href="/admin/leads" role="tab">Leads</a>', 'data-tab="consultations"', 'data-tab="retainers"', 'data-tab="reporting"',
    'data-range="today"', 'data-range="week"', 'data-range="month"', 'data-range="all"', 'data-nav="-1"', 'data-nav="1"',
    'id="needs-outcome"', 'id="nodate"', '<th>Time</th><th>Client</th><th>Service</th><th>Consultant</th><th>Mode</th><th>Agreement</th><th>Pre-consult</th><th>Paid</th><th>Outcome</th>',
    '<option value="__none">Unassigned</option>', 'id="f-mode"', 'id="f-paid"', 'id="f-agree"', 'id="rf-stage"', 'id="rf-kind"',
    "fetch('/api/consultations-board'+(force?'?fresh=1':'')", "if(t==='reporting' && !KPIS_LOADED){ KPIS_LOADED=true; loadKpis(); }", 'id="btn-direct-client"']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('loadDirectRetainers') && !html.includes('Direct retainer clients <span id="direct-count"'), 'the old mixed direct section is gone');
  assert.ok(!html.includes('load(); loadKpis();'), 'the KPIs load only when the Reporting tab opens');
  const src = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(src, /app\.get\('\/api\/consultations-board', async \(req, res\) => \{\s*try \{\s*res\.json\(await consultantPortalService\.getConsultationsBoard\(\{ fresh: String\(req\.query\.fresh \|\| ''\) === '1' \}\)\);/);
});

/* ── Cases: batched parallel fetch with a short raw cache ── */

test('cases board: ids listed cheaply, rows fetched in parallel batches of 100 WITH a limit (the 25-row trap), cached briefly; only raw rows are cached', async () => {
  const dash = require('../src/services/dashboardService');
  const mondayApi = require('../src/services/mondayApi');
  const calls = [];
  const restore = [stub(mondayApi, 'query', async (q, v) => {
    calls.push({ q, v });
    if (/items_page\(limit: 500/.test(q)) return { boards: [{ items_page: { cursor: null, items: Array.from({ length: 230 }, (_, i) => ({ id: String(i + 1) })) } }] };
    assert.match(q, /items\(ids: \$ids, limit: 100\)/);
    return { items: v.ids.map((id) => ({ id, name: `C${id}`, created_at: '', column_values: [] })) };
  })];
  try {
    dash.invalidateCases();
    const items = await dash.fetchAllItems({ fresh: true });
    assert.equal(items.length, 230);
    assert.deepEqual(calls.slice(1).map((c) => c.v.ids.length), [100, 100, 30]);
    assert.equal(items[0].id, '1'); assert.equal(items[229].id, '230');
    const n = calls.length;
    await dash.fetchAllItems();
    assert.equal(calls.length, n, 'served from the cache');
    dash.invalidateCases();
    await dash.fetchAllItems();
    assert.ok(calls.length > n, 'invalidated: read again');
  } finally { restore.forEach((r) => r()); dash.invalidateCases(); }
});

/* ── review of f09e491 ── */

test('REVIEW: an invalidation during an in-flight read is never lost — the reload after a delete waits for a read that began AFTER the delete (even when a background refresh was running)', async () => {
  snap._reset();
  let now = 9_000_000, rows = [L(1), L(2)], reads = 0;
  const pending = [];                                  // deferred reads: resolved by the test
  const restore = [stub(snap.io, 'now', () => now), stub(snap.io, 'fetchLeads', () => { reads++; const snapshotRows = rows.slice(); return new Promise((res) => pending.push(() => res(snapshotRows))); })];
  try {
    const first = snap.leads(); pending.shift()(); assert.equal((await first).length, 2);
    now += snap.TTL_MS + 1000;                         // the copy ages: the next view starts a background refresh of the OLD rows
    const view = await snap.getLeadSnapshot();
    assert.equal(view.leads.length, 2); assert.equal(reads, 2, 'background read #2 in flight (pre-delete rows captured)');
    rows = [L(1)];                                     // the delete lands
    snap.invalidate();
    const reload = snap.getLeadSnapshot({ fresh: true });
    pending.shift()();                                 // read #2 completes with the pre-delete rows
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(reads, 3, 'the reload started a third read after the delete');
    pending.shift()();
    const got = await reload;
    assert.deepEqual(got.leads.map((l) => l.id), ['1'], 'the deleted lead is gone on the reload');
    assert.deepEqual((await snap.leads()).map((l) => l.id), ['1'], 'and on the next plain read');
    assert.equal(reads, 3);
    // the scheduler's warm() in flight + a staff create: same rule
    const warm = snap.warm();
    rows = [L(1), L(5)]; snap.invalidate();
    const after = snap.leads();
    pending.shift()();                                 // the warm read completes (pre-create rows)
    await new Promise((r) => setTimeout(r, 5)); pending.shift()();
    await warm;
    assert.deepEqual((await after).map((l) => l.id), ['1', '5'], 'the created lead is on the list that loads right after');
  } finally { restore.forEach((r) => r()); snap._reset(); }
});

test('REVIEW: every lead write marks the snapshot (updateLead / createLead), a new direct client marks it, the Cases copy is marked on a case created or deleted', async () => {
  const leadService = require('../src/services/leadService');
  const mondayApi = require('../src/services/mondayApi');
  snap._reset();
  const restore = [stub(mondayApi, 'query', async () => ({ change_multiple_column_values: { id: '1' } })), stub(snap.io, 'fetchLeads', async () => [L(1)])];
  try {
    await snap.leads();
    const before = snap._state();
    await leadService.updateLead('1', { outcome: 'Retain' });
    assert.ok(snap._state().invalidatedAt > before.invalidatedAt, 'updateLead marked the snapshot');
    await leadService.updateLead('1', {});
    assert.equal(snap._state().invalidatedAt, snap._state().invalidatedAt, 'a no-op write is fine');
  } finally { restore.forEach((r) => r()); snap._reset(); }
  const ls = fs.readFileSync(require.resolve('../src/services/leadService'), 'utf8');
  assert.ok((ls.match(/_snapshotChanged\(\);/g) || []).length >= 2, 'updateLead and createLead both mark it');
  const cps = fs.readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.match(cps, /const leadId = created\.id;\n  invalidateDirectRetainerQueue\(\);/);
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(server, /consultantPortalService\.invalidateLeadsQueue\(\);[^\n]*\n\s*dashboardService\.invalidateCases\(\);/);
  const ho = fs.readFileSync(require.resolve('../src/services/handoffService'), 'utf8');
  assert.match(ho, /create_item returned no id for lead \$\{leadId\}`\);\n  try \{ require\('\.\/dashboardService'\)\.invalidateCases\(\); \}/);
});

test('REVIEW: the Cases copy — a delete during an in-flight refresh is not lost either', async () => {
  const dash = require('../src/services/dashboardService');
  const mondayApi = require('../src/services/mondayApi');
  let ids = ['1', '2'];
  const pending = [];
  const restore = [stub(mondayApi, 'query', (q, v) => {
    if (/items_page\(limit: 500/.test(q)) { const snapshotIds = ids.slice(); return new Promise((res) => pending.push(() => res({ boards: [{ items_page: { cursor: null, items: snapshotIds.map((id) => ({ id })) } }] }))); }
    return Promise.resolve({ items: v.ids.map((id) => ({ id, name: 'C' + id, created_at: '', column_values: [] })) });
  })];
  try {
    dash.invalidateCases();
    const first = dash.fetchAllItems(); pending.shift()(); assert.equal((await first).length, 2);
    const bg = dash.fetchAllItems({ fresh: true });  // a read in flight (old ids captured)
    ids = ['1']; dash.invalidateCases();              // the case is deleted meanwhile
    const reload = dash.fetchAllItems();
    pending.shift()(); await new Promise((r) => setTimeout(r, 5)); pending.shift()();
    await bg;
    assert.deepEqual((await reload).map((c) => c.id), ['1'], 'the reload after the delete does not list the deleted case');
  } finally { restore.forEach((r) => r()); dash.invalidateCases(); }
});

test('REVIEW: the page — the warning header keeps its colour; a due follow-up is a cue on the row and a filter; a failed read is said, not shown as an empty list', () => {
  const html = require('../src/routes/adminConsultation').buildQueueHTML();
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(css.indexOf('.fold .attn-h {') < css.indexOf('.fold.attn .attn-h {'), 'the amber rule comes later AND is more specific');
  assert.ok(css.includes('.fold.attn .attn-h { background:#fffbeb; color:#92400e; }'));
  assert.ok(html.includes('<select id="rf-followup">') && html.includes('<option value="due">Due (today or earlier)</option>'), 'the follow-up filter is on Retainers, where a follow-up sits once its consultation day has passed');
  assert.ok(!html.includes('id="f-followup"'), 'and no longer on Consultations (it would find almost nothing there)');
  assert.ok(html.includes("if(c.followUpDate) h+=' '+qpill(c.followUpDate<=todayStr()?'amber':'grey','follow-up '+c.followUpDate);"));
  assert.ok(html.includes('var oc=outcomeCell(c);'), 'the Consultations row and the Retainers row show the outcome the same way');
  assert.ok(html.includes("if(fu==='due' && !(r.followUpDate && r.followUpDate<=t)) return false;"));
  assert.ok(html.includes("if(!r.ok){ return r.json().catch(function(){ return {}; }).then(function(j){ throw new Error(j.error||('HTTP '+r.status)); }); }"));
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
});

/* ── Retainers quick filters (Faran 2026-10-16, in place of grouping by outcome) ── */

test('consultationDone: a booked consultation moves to Retainers as soon as its outcome is set — an upcoming one stays; today, an outcome left from an earlier consultation keeps the client on the day\'s list', () => {
  const done = portal.consultationDone, today = '2026-10-16';
  const B = (over) => ({ bookingStatus: 'Booked', ...over });
  const setToday = '2026-10-16T15:05:00.000Z', setEarlier = '2026-09-20T15:00:00.000Z';
  assert.equal(done(B({ bookedSlot: '2026-10-15 10:00' }), today), false, 'no outcome: stays (the Needs outcome list)');
  assert.equal(done(B({ bookedSlot: '2026-10-15 10:00', outcome: 'Follow-Up', outcomeChangedAt: setEarlier }), today), true, 'an earlier day: moves');
  assert.equal(done(B({ bookedSlot: '2026-10-16 09:00', outcome: 'Newsletter', outcomeChangedAt: setToday }), today), true, 'today, the outcome set today: moves at once (Faran 2026-10-16)');
  assert.equal(done(B({ bookedSlot: '2026-10-16 15:00', outcome: 'Follow-Up', outcomeChangedAt: setToday }), today), true, 'set today before the meeting time: moves too — staff chose it today');
  assert.equal(done(B({ bookedSlot: '2026-10-16 15:00', outcome: 'Follow-Up', outcomeChangedAt: setEarlier }), today), false, 'a re-booked client whose outcome is from an earlier consultation stays on today\'s list (review 2026-10-16)');
  assert.equal(done(B({ bookedSlot: '2026-10-16 15:00', outcome: 'Follow-Up' }), today), false, 'today, not known when it was set: stays');
  assert.equal(done(B({ bookedSlot: '2026-10-16 15:00', outcome: 'Follow-Up', outcomeChangedAt: '2026-10-17T02:30:00Z' }), today), true, '10:30 pm Toronto is still today (UTC says tomorrow)');
  assert.equal(done(B({ bookedSlot: '2026-10-16 15:00', outcome: 'Follow-Up', outcomeChangedAt: '2026-10-16T02:30:00Z' }), today), false, '10:30 pm Toronto the day BEFORE (UTC says today)');
  assert.equal(done(B({ bookedSlot: '2026-10-20 09:00', outcome: 'Follow-Up', outcomeChangedAt: setToday }), today), false, 'an upcoming consultation stays whatever its outcome');
  assert.equal(done(B({ bookedSlot: '2026-10-16', outcome: 'Not Wanted', outcomeChangedAt: setToday }), today), true, 'today with no time, set today: moves');
  assert.equal(done(B({ bookedSlot: '', outcome: 'Not Wanted' }), today), true, 'no date at all: the outcome says it happened');
  assert.equal(done(B({ bookedSlot: '2026-10-15 10:00', outcome: 'Don’t Retain — Ineligible' }), today), true, 'an old label reads as its new meaning');
  assert.equal(done(B({ bookedSlot: '2026-10-15 10:00', outcome: 'Something else' }), today), false, 'text that is not an outcome moves nothing');
});

test('getConsultationsBoard: Follow-Up / Newsletter / Not Wanted consultations sit on Retainers once the outcome is set with their outcome group and their consultation fee; today\'s and upcoming ones stay; every Retainers row has a group', async () => {
  snap._reset();
  const rows = [
    L(1, { bookingStatus: 'Booked', bookedSlot: '2026-10-14 10:00', outcome: 'Follow-Up', followUpDate: '2026-10-20', assignedConsultant: 'Shermin Teymouri Mofrad',
      consultPayment: JSON.stringify({ kind: 'cash', amountCents: 20000, on: '2026-10-14', by: 'Melanie', verified: false }) }),
    L(2, { bookingStatus: 'Booked', bookedSlot: '2026-10-20 10:00', outcome: 'Follow-Up' }),
    L(3, { bookingStatus: 'Booked', outcome: 'Newsletter' }),
    L(4, { bookingStatus: 'Booked', bookedSlot: '2026-10-10 10:00', outcome: 'Not Wanted' }),
    L(5, { sourceChannel: 'Direct Retainer', createdAt: '2026-10-02T00:00:00Z', consultPayment: JSON.stringify({ kind: 'cash', amountCents: 100, on: '2026-10-02' }) }),
    L(6, { bookingStatus: 'Booked', bookedSlot: '2026-10-09 10:00', outcome: 'Retain', retainerSent: '2026-10-11', squareConsultTxnId: 'SQ6', consultOption: JSON.stringify({ feeCents: 20000, paidCents: 22600 }) }),
    L(7, { bookingStatus: 'Booked', bookedSlot: '2026-10-14 15:00' }),
    L(8, { bookingStatus: 'Booked', bookedSlot: '2026-10-08 10:00', outcome: 'Follow-Up', retainerFee: '2500' }),
    L(9, { bookingStatus: 'Booked', bookedSlot: '2026-10-15 09:00', outcome: 'Follow-Up', outcomeChangedAt: '2026-09-30T14:00:00Z' }),
    L(10, { bookingStatus: 'Booked', bookedSlot: '2026-10-15 10:00', outcome: 'Newsletter', outcomeChangedAt: '2026-10-15T14:45:00Z' }),
  ];
  const restore = [stub(snap.io, 'fetchLeads', async () => rows)];
  try {
    const b = await portal.getConsultationsBoard({ now: new Date('2026-10-15T16:00:00Z') });   // noon in Toronto
    assert.deepEqual(b.consultations.map((r) => r.id), ['7', '9', '2'], 'no outcome yet, today with an outcome from an earlier consultation, or upcoming');
    assert.deepEqual(b.retainers.map((r) => [r.id, r.stage, r.outcomeGroup]),
      [['6', 'Sent', 'Retain'], ['8', 'Fee set', 'Follow-Up'], ['5', 'New', 'Retain'], ['4', '', 'Not Wanted'], ['1', '', 'Follow-Up'], ['10', '', 'Newsletter'], ['3', '', 'Newsletter']],
      'by stage; no retainer under way last, oldest consultation first (no date last)');
    const r1 = b.retainers.find((r) => r.id === '1');
    assert.equal(r1.outcome, 'Follow-Up'); assert.equal(r1.followUpDate, '2026-10-20'); assert.equal(r1.kind, 'booked'); assert.equal(r1.consultant, 'Shermin Teymouri Mofrad');
    assert.deepEqual([r1.paid, r1.paidCents, r1.paidBy, r1.paidOn, r1.paidVerified], ['cash', 20000, 'Melanie', '2026-10-14', false], 'the consultation fee travels with the row');
    const r6 = b.retainers.find((r) => r.id === '6');
    assert.deepEqual([r6.paid, r6.paidCents], ['app', 22600]);
    const r5 = b.retainers.find((r) => r.id === '5');
    assert.deepEqual([r5.paid, r5.paidCents], ['cash', 100], 'a fee staff recorded for a direct client still shows (the page says n/a only when there is none)');
    const r4 = b.retainers.find((r) => r.id === '4');
    assert.deepEqual([r4.paid, r4.paidCents], ['', null], 'nothing recorded yet');
    const ids = [...b.consultations, ...b.retainers].map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'one row, one tab');
    assert.equal(ids.length, 10, 'and every row on one');
  } finally { restore.forEach((r) => r()); snap._reset(); }
});

function quickFns() {
  const html = require('../src/routes/adminConsultation').buildQueueHTML();
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
  const outs = js.match(/var RET_OUTCOMES=(\[[^\]]*\])/)[1];
  const a = js.indexOf('function retGroup('), b = js.indexOf('function setRout(');
  return new Function(`var RET_OUTCOMES=${outs}; ${js.slice(a, b)}; return { retGroup, cleanOutcomes, RET_OUTCOMES };`)();
}

test('page: the Retainers quick filters — one button per outcome plus All, counts from the other filters, none on = all; the address and the viewer remember the choice; an Outcome column; a follow-up filter', () => {
  const html = require('../src/routes/adminConsultation').buildQueueHTML();
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
  const f = quickFns();
  assert.deepEqual(f.RET_OUTCOMES, require('../config/outcomes').OUTCOME_LABELS, 'the buttons are the four outcomes, from config');
  assert.deepEqual(f.cleanOutcomes(['Follow-Up', 'Newsletter', 'Follow-Up', 'junk', '', ' Not Wanted ']), ['Follow-Up', 'Newsletter', 'Not Wanted'], 'only real outcomes, once each');
  assert.deepEqual(f.cleanOutcomes(''.split(',')), []);
  assert.equal(f.retGroup({ outcomeGroup: 'Newsletter' }), 'Newsletter');
  assert.equal(f.retGroup({}), 'Retain', 'a row without a group counts under Retain');
  for (const s of ['<div class="quick" id="r-quick" role="group" aria-label="Show by outcome"></div>',
    '<th>Consultant</th><th>Outcome</th><th>Consult fee</th><th>Retainer fee</th>', '<select id="rf-followup">', '<select id="rf-paid"',
    "['rf-search','rf-consultant','rf-stage','rf-kind','rf-followup','rf-paid'].forEach(",
    "if(paid && ((r.kind==='direct' && !r.paid) || !paidMatch(r,paid))) return false;", "if(!paidMatch(r,paid)) return false;",
    "((c.kind==='direct' && !c.paid)?'<span class=\"pill grey\" title=\"Direct retainer client — no consultation\">n/a</span>':paidPill(c))",
    "setTab(qs.get('tab')||(qs.get('outcome')!==null?'retainers':'')||lsGet('tdot_consult_tab')||'consultations', false);",
    "u.searchParams.set('tab','retainers');",
    "btn('','All',base.length,!ROUT.length)", 'aria-pressed="', "var rows=ROUT.length?base.filter(function(r){ return ROUT.indexOf(retGroup(r))>=0; }):base;",
    "u.searchParams.set('outcome',ROUT.join(','))", "lsSet('tdot_ret_outcomes',ROUT.join(','))",
    "var p=new URLSearchParams(window.location.search).get('outcome'); setRout(String(p!==null?p:lsGet('tdot_ret_outcomes')).split(','), false, p!==null);",
    "if(!keep) lsSet('tdot_ret_outcomes',ROUT.join(','));",
    '.pill.red {', 'colspan="12"']) assert.ok(html.includes(s), s);
  assert.ok(html.indexOf("setRout(String(p!==null") < html.indexOf('\nload();'), 'the choice is restored before the first render');
});

test('page: one consultation-fee rule for both tabs (paidMatch)', () => {
  const html = require('../src/routes/adminConsultation').buildQueueHTML();
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
  const a = js.indexOf('function paidMatch('), b = js.indexOf('function passesCommon(');
  const paidMatch = new Function(`${js.slice(a, b)}; return paidMatch;`)();
  const R = (paid) => ({ paid });
  assert.deepEqual(['app', 'cash', 'waived', ''].map((p) => paidMatch(R(p), 'paid')), [true, true, false, false]);
  assert.deepEqual(['app', 'cash', 'waived', ''].map((p) => paidMatch(R(p), 'staff')), [false, true, false, false]);
  assert.deepEqual(['app', 'cash', 'waived', ''].map((p) => paidMatch(R(p), 'none')), [false, false, false, true]);
  assert.deepEqual(['app', 'cash', 'waived', ''].map((p) => paidMatch(R(p), 'waived')), [false, false, true, false]);
  assert.deepEqual(['app', 'cash', 'waived', ''].map((p) => paidMatch(R(p), '')), [true, true, true, true]);
});
