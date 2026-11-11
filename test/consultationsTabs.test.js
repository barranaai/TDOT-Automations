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
    assert.ok(calls[0].q.includes(`"${C.consultAgreementSent}"`) && calls[0].q.includes(`"${C.squareConsultTxnId}"`), 'the list columns');
    // 2026-11-04: the email column is read ONLY to know whether there is one — the copy keeps yes/no, never the address.
    assert.ok(leads.every((l) => !('email' in l) && l.hasEmail === false), 'no address kept; these rows have no email');
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
    L(1, { bookingStatus: 'Booked', bookedSlot: '2026-10-20 11:00', assignedConsultant: 'Shafoli Kapur', meetingType: 'In-person', consultAgreementSent: '2026-10-14', consultAgreementSigned: '2026-10-15', preConsultSubmitted: 'Yes', squareConsultTxnId: 'SQ1', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 }), confirmedCaseType: 'Study permit', email: 'x@y.co', phone: '416-555-0142' }),
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
    assert.ok(!JSON.stringify(b).includes('x@y.co') && !JSON.stringify(b).includes('555-0142'), 'a list, not a record');   // (not just '416': the clock's own digits made that fail for 17 minutes on 2026-11-11)
    assert.deepEqual(b.retainers.map((r) => [r.id, r.stage, r.kind]), [['6', 'Paid', 'direct'], ['4', 'Sent', 'direct'], ['5', 'Retain', 'booked']], 'by stage, then oldest first; the retained client is gone');
    assert.equal(b.retainers[1].caseOpen, true);
    assert.ok(Number.isFinite(b.at) && Number.isFinite(b.ageMs));
    // the Leads queue sees only 8 (its own 20 s memo dropped first)
    portal.invalidateLeadsQueue();
    assert.deepEqual((await portal.getLeadsQueue()).map((r) => r.id), ['8']);
  } finally { restore.forEach((r) => r()); snap._reset(); }
});

test('point 8 (2026-11-05): the Retained tab — retained clients come only when asked (?retained=1), kept apart, newest first, with their case number; every lead is on exactly one list; no email or phone', async () => {
  snap._reset();
  const dash = require('../src/services/dashboardService');
  const rows = [
    L(11, { sourceChannel: 'Direct Retainer', conversionStatus: 'Retained', retainerSigned: '2026-09-01', retainerPaid: '2026-09-03', clientMasterItemId: '701', followUpDate: '2026-08-01', outcome: 'Retain', email: 'ret@x.co', phone: '9055550000' }),
    L(12, { bookingStatus: 'Booked', bookedSlot: '2026-08-01 10:00', outcome: 'Follow-Up', conversionStatus: 'Retained', retainerSigned: '2026-10-02', retainerPaid: '2026-10-01', clientMasterItemId: '702', createdAt: '2026-07-01T00:00:00Z' }),
    L(13, { sourceChannel: 'Direct Retainer', conversionStatus: 'Retained', retainerSigned: '2026-10-02', clientMasterItemId: '799', createdAt: '2026-09-01T00:00:00Z' }),   // its case row is gone from the board
    L(14, { sourceChannel: 'Direct Retainer', conversionStatus: 'Retained' }),   // retained by hand, no dates, no case
    L(15, { sourceChannel: 'Direct Retainer', retainerSent: '2026-10-05' }),     // still being worked
    L(16, { bookingStatus: 'Booked', bookedSlot: '2026-12-01 10:00' }),          // a consultation
    L(17),                                                                         // a lead
  ];
  const cm = [{ id: '701', name: 'A', column_values: [{ id: 'text_mm142s49', text: '2026-SP-001' }] }, { id: '702', name: 'B', column_values: [{ id: 'text_mm142s49', text: '2026-VV-002' }] }];
  const restore = [stub(snap.io, 'fetchLeads', async () => rows), stub(dash, 'fetchAllItems', async () => cm)];
  try {
    const now = new Date('2026-11-05T16:00:00Z');
    const plain = await portal.getConsultationsBoard({ now });
    assert.equal(plain.retained, undefined, 'not asked: no retained rows (the Consultations page, and a Retainers page from before the tab)');
    assert.ok(!plain.retainers.some((r) => r.retained), 'never mixed into the working rows');
    const b = await portal.getConsultationsBoard({ now, withRetained: true });
    assert.deepEqual(b.retained.map((r) => [r.id, r.outcomeGroup, r.retainedOn, r.stage]), [['13', 'Retained', '2026-10-02', 'Signed'], ['12', 'Retained', '2026-10-02', 'Paid'], ['11', 'Retained', '2026-09-03', 'Paid'], ['14', 'Retained', '', '']],
      'newest first (the later of signed / paid; a tie: the newer lead); stage from the dates only');
    assert.ok(b.retained.every((r) => r.retained === true && r.followUpDate === ''), 'flagged; an old follow-up date never shows as due');
    assert.deepEqual(b.retained.map((r) => [r.id, r.caseRef, r.caseFound]), [['13', '', false], ['12', '2026-VV-002', true], ['11', '2026-SP-001', true], ['14', '', null]], 'the case number from the Cases copy; a case row not on the board = not found; no case = unknown');
    assert.equal(b.casesKnown, true);
    assert.ok(!JSON.stringify(b).includes('ret@x.co') && !JSON.stringify(b).includes('9055550000'), 'a list, not a record');
    portal.invalidateLeadsQueue();
    const lists = [(await portal.getLeadsQueue()).map((r) => r.id), b.consultations.map((r) => r.id), b.retainers.map((r) => r.id), b.retained.map((r) => r.id)];
    const all = lists.flat().sort();
    assert.deepEqual(all, rows.map((r) => String(r.id)).sort(), 'every lead on exactly one list');
    // the Cases copy is slow: the rows go without case numbers, never an error, never a long wait
    let release; const slow = new Promise((res) => { release = res; });
    const restore2 = stub(dash, 'fetchAllItems', () => slow);
    try {
      const t0 = Date.now();
      const r2 = [{ clientMasterItemId: '701' }];
      assert.equal(await portal.addCaseRefs(r2, 50), false);
      assert.ok(Date.now() - t0 < 1000);
      assert.deepEqual([r2[0].caseRef, r2[0].caseFound], ['', null]);
    } finally { restore2(); release([]); }
    const restore3 = stub(dash, 'fetchAllItems', async () => { throw new Error('Monday down'); });
    try { const r3 = [{ clientMasterItemId: '701' }]; assert.equal(await portal.addCaseRefs(r3, 50), false); assert.equal(r3[0].caseFound, null); } finally { restore3(); }
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
  const a = js.indexOf('function dParts('), b = js.indexOf('/* A consultation added by hand with');
  const head = js.slice(a, b);
  return new Function('todayStr', 'escHtml', `${head}; return { dParts, dAdd, dDow, dMonthAdd, dLabel, dateCell, timeCell };`);
}

test('page (2026-11-11): the Date and Time cells — calendar maths on Toronto days, no local Date; Today / Tomorrow are marked; the range buttons are gone', () => {
  const f = pageFns()(() => '2026-10-15', (s) => String(s));
  assert.equal(f.dAdd('2026-12-31', 1), '2027-01-01');
  assert.equal(f.dMonthAdd('2026-01-31', 1), '2026-02-01');
  assert.equal(f.dDow('2026-10-12'), 1);
  assert.equal(f.dateCell({ bookedSlot: '2026-10-15 09:00' }), '<span class="time">Thu, Oct 15</span> <span class="pill blue">Today</span>');
  assert.equal(f.dateCell({ bookedSlot: '2026-10-16 09:00' }), '<span class="time">Fri, Oct 16</span> <span class="pill blue">Tomorrow</span>');
  assert.equal(f.dateCell({ bookedSlot: '2027-01-04 09:00' }), '<span class="time">Mon, Jan 4, 2027</span>');
  assert.equal(f.dateCell({ bookedSlot: '' }), '<span class="pill grey">no date</span>');
  assert.equal(f.timeCell({ bookedSlot: '2026-10-15 09:00' }), '<span class="time">09:00</span>');
  assert.equal(f.timeCell({ bookedSlot: '' }), '<span class="muted">—</span>');
  const q = require('../src/routes/adminConsultation').buildQueueHTML();
  for (const gone of ['data-range=', 'data-nav=', 'id="range"', 'id="range-label"', 'function setRange(', 'function shiftRange(', 'function inRange(', 'RANGE', 'ANCHOR', 'consultCountable', "ssSet('tdot_list_consult_range'"])
    assert.ok(!q.includes(gone), 'gone: ' + gone);
});

test('pages (2026-11-05): Consultations shows consultations only; Retainers & follow-ups is its own page with the direct-retainer pop-up; every script parses; the old tabs and the old mixed section are gone', () => {
  const ac = require('../src/routes/adminConsultation');
  const q = ac.buildQueueHTML(), r = ac.buildRetainersHTML();
  for (const html of [q, r]) for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
  for (const s of [
    'id="cq-tabs"', 'id="cq-month"', 'id="cq-table"', '<th>Date</th><th>Time</th><th>Client</th><th>Service</th><th>Consultant</th><th>Mode</th><th>Agreement</th><th>Pre-consult</th><th>Paid</th><th>Outcome</th><th>Now</th>',
    'id="cq-headrow"', 'id="cq-search"', 'id="cq-chips"', 'id="cq-count"', "api: 'ConsultTable'",
    "consultant: { label: 'Consultant', get: function (r) { return s(r.consultant); }, none: 'Unassigned' },",
    "fetch('/api/consultations-board?completed=1'+(force?'&fresh=1':'')", 'id="cq-tabs"', '<a href="/admin/retainers">Retainers &amp; follow-ups</a>', 'id="snap-age"']) assert.ok(q.includes(s), 'consultations: ' + s);
  for (const gone of ['data-tab=', 'role="tablist" aria-label="Views"', 'id="tn-consult"', 'id="tn-ret"', 'id="rq-headrow"', "api: 'RetainerTable'", 'id="btn-direct-client"', 'id="dc-overlay"', 'function setTab(', 'loadKpis', 'KPIS_LOADED', "lsGet('tdot_consult_tab')", 'function lsGet(', 'loadDirectRetainers'])
    assert.ok(!q.includes(gone), 'consultations, gone: ' + gone);
  for (const page of [q, r]) assert.ok(page.includes("['tdot_consult_tab','tdot_consult_range','tdot_ret_outcomes'].forEach(function(k){ localStorage.removeItem(k); })"), 'the old one-page keys are tidied away');
  for (const s of ['id="rq-headrow"', 'id="rq-search"', 'id="rq-chips"', 'id="r-count"', 'id="r-quick"', "api: 'RetainerTable'", 'id="btn-direct-client"', '<div id="dc-overlay" class="tdlg-ov" hidden>',
    "fetch('/api/consultations-board?retained=1'+(force?'&fresh=1':'')", 'id="snap-age"', 'RetainerTable.setRows(RETAINERS); showAge(d);', "RETAINERS=(d.retainers||[]).concat(d.retained||[]);"]) assert.ok(r.includes(s), 'retainers: ' + s);
  for (const gone of ['data-tab=', 'id="cq-headrow"', "api: 'ConsultTable'", 'id="range"', 'id="needs-outcome"', 'function setTab(', 'loadKpis', "lsGet('tdot_consult_tab')"])
    assert.ok(!r.includes(gone), 'retainers, gone: ' + gone);
  assert.ok(q.includes("function dParts(d){") && r.includes("function dParts(d){"), 'both pages read calendar days the TZ-safe way');
  const src = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(src, /app\.get\('\/api\/consultations-board', async \(req, res\) => \{\s*try \{\s*(\/\/[^\n]*\n\s*)?res\.json\(await consultantPortalService\.getConsultationsBoard\(\{ fresh: String\(req\.query\.fresh \|\| ''\) === '1', withRetained: String\(req\.query\.retained \|\| ''\) === '1',\s*(\/\/[^\n]*\n\s*)?withCompleted: String\(req\.query\.completed \|\| ''\) === '1' \}\)\);/);
});

test('routes (2026-11-05): /admin/retainers serves the Retainers page; the old one-page links are redirected — ?tab=retainers / ?outcome= / ?convertLead= / ?newAppFrom= to the Retainers page, ?tab=reporting to the Summary page', () => {
  const router = require('../src/routes/adminConsultation');
  const route = (path) => router.stack.find((l) => l.route && l.route.path === path);
  assert.ok(route('/retainers') && route('/consultations'));
  const run = (path, query) => {
    const out = {};
    const res = { redirect: (code, to) => { out.redirect = [code, to]; }, type: () => ({ send: (html) => { out.html = html; } }) };
    route(path).route.stack[0].handle({ query }, res);
    return out;
  };
  assert.ok(run('/retainers', {}).html.includes('id="rq-headrow"'));
  assert.ok(run('/consultations', {}).html.includes('id="cq-headrow"') && !run('/consultations', {}).redirect);
  assert.ok(run('/consultations', { tab: 'consultations' }).html, 'the old consultations tab link just opens the page');
  assert.deepEqual(run('/consultations', { tab: 'retainers' }).redirect, [302, '/admin/retainers']);
  assert.deepEqual(run('/consultations', { tab: 'retainers', outcome: 'Follow-Up,Newsletter' }).redirect, [302, '/admin/retainers?outcome=Follow-Up%2CNewsletter']);
  assert.deepEqual(run('/consultations', { outcome: 'Follow-Up' }).redirect, [302, '/admin/retainers?outcome=Follow-Up'], 'an ?outcome= link opened Retainers before, and still does');
  assert.deepEqual(run('/consultations', { outcome: '' }).redirect, [302, '/admin/retainers?outcome='], 'an empty ?outcome= still opens Retainers (on All)');
  assert.deepEqual(run('/consultations', { convertLead: '12641191022' }).redirect, [302, '/admin/retainers?convertLead=12641191022'], 'the lead page\'s old Convert link');
  assert.deepEqual(run('/consultations', { newAppFrom: '2026-OSS-005' }).redirect, [302, '/admin/retainers?newAppFrom=2026-OSS-005'], 'the case page\'s old New application link');
  assert.deepEqual(run('/consultations', { tab: ['retainers', 'x'] }).redirect, [302, '/admin/retainers'], 'a repeated parameter: the first one counts');
  assert.deepEqual(run('/consultations', { tab: 'reporting' }).redirect, [302, '/admin/dashboard/summary#reporting']);
  // the pages that link in point at the new page already
  assert.ok(require('../src/routes/adminLeads').buildLeadDetailHTML('7').includes("href='/admin/retainers?convertLead='"));
  assert.ok(require('../src/routes/adminCase').buildCockpitHTML('2026-TEST-001').includes("href=\"/admin/retainers?newAppFrom="));
  // the consultation record goes back to the list the client is on (review 2026-11-05)
  const detail = require('../src/routes/adminConsultation').buildDetailHTML;
  const plain = detail('555'), fromRet = detail('555', { from: 'retainers' });
  assert.ok(plain.includes('<a href="/admin/consultations" class="back-lnk" id="back-lnk">') && plain.includes('<span id="back-lnk-txt">All consultations</span>'));
  assert.ok(fromRet.includes('<a href="/admin/retainers" class="back-lnk" id="back-lnk">') && fromRet.includes('<span id="back-lnk-txt">Retainers &amp; follow-ups</span>'));
  assert.ok(fromRet.includes('<a href="/admin/retainers" class="nav-lnk active"') && plain.includes('<a href="/admin/consultations" class="nav-lnk active"'), 'the top bar follows');
  assert.ok(plain.includes("var list=String(d.onList||''), href='', label='', nav='';") && plain.includes('  pointBackAtList(d);'), 'opened any other way: the SERVER says which list the client is on');
  const svc = fs.readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.ok(svc.includes("    onList:         listFor(lead),"), 'the record payload carries it');
  // point 7 (tabs): opened from elsewhere, the way back opens the client's own outcome tab — the rows' rule (retainerTab)
  assert.ok(svc.includes("    onListTab:      retainerTab(lead),") && svc.includes('    outcomeGroup: retainerTab(l),'), 'one rule for the row and the way back');
  assert.ok(plain.includes("if(list==='retainers'){ href='/admin/retainers?outcome='+encodeURIComponent(d.onListTab||'All');"), 'the client\'s tab');
  assert.ok(plain.indexOf("if(!bl||/[?&]from=(retainers|consultations)(&|$)/.test(window.location.search)) return;") < plain.indexOf("href='/admin/retainers?outcome='"), 'from the Retainers page: the plain link — the tab the person was on');
  const { retainerTab } = require('../src/services/consultantPortalService');
  const { canonicalOutcome } = require('../config/outcomes');
  assert.deepEqual([{ outcome: ' Follow-Up ' }, { outcome: 'Newsletter' }, { outcome: 'Not Wanted' }, { outcome: 'Retain' }, { outcome: '' }, {}, { outcome: 'Junk' }].map(retainerTab),
    ['Follow-Up', 'Newsletter', 'Not Wanted', 'Retain', 'Retain', 'Retain', 'Retain'], 'the outcome, or Retain when there is none');
  for (const old of Object.keys(require('../config/outcomes').LEGACY_OUTCOMES || {})) assert.equal(retainerTab({ outcome: old }), canonicalOutcome(old) || 'Retain', 'an old label: the tab of the outcome it now means');
  // the back link, run in a page-like context: Retainers + the client's tab; from=retainers leaves the plain link
  const pbSrc = plain.slice(plain.indexOf('function pointBackAtList(d){'), plain.indexOf('function render(d){'));
  const pb = (search, d) => {
    const bl = { href: '/admin/consultations' }, txt = { textContent: '' };
    new Function('window', 'document', pbSrc + '; pointBackAtList(' + JSON.stringify(d) + ');')({ location: { search } }, { getElementById: (id) => (id === 'back-lnk' ? bl : id === 'back-lnk-txt' ? txt : null), querySelectorAll: () => [] });
    return [bl.href, txt.textContent];
  };
  assert.deepEqual(pb('', { onList: 'retainers', onListTab: 'Not Wanted' }), ['/admin/retainers?outcome=Not%20Wanted', 'Retainers & follow-ups']);
  assert.deepEqual(pb('', { onList: 'retainers' }), ['/admin/retainers?outcome=All', 'Retainers & follow-ups'], 'an older payload with no tab: All, where everyone is');
  assert.deepEqual(pb('?from=retainers', { onList: 'retainers', onListTab: 'Follow-Up' }), ['/admin/consultations', ''], 'from the Retainers page: untouched here (the page drew the plain /admin/retainers link)');
  // the one rule the lists use (classifyLead + consultationDone), for every kind of client
  const { listFor } = require('../src/services/consultantPortalService');
  const now = new Date('2026-11-05T15:00:00Z');   // 10:00 Toronto
  assert.equal(listFor({ directClient: 'Yes', sourceChannel: 'Walk-in', conversionStatus: 'Qualified' }, now), 'retainers', 'a direct client with nothing sent yet');
  assert.equal(listFor({ retainerSent: '2026-11-01', bookingStatus: 'Booked' }, now), 'retainers');
  assert.equal(listFor({ outcome: 'Retain', bookingStatus: 'Booked', bookedSlot: '2026-11-20 10:00' }, now), 'retainers');
  assert.equal(listFor({ conversionStatus: 'Retained', retainerSigned: '2026-10-01', retainerPaid: '2026-10-02', clientMasterItemId: '9001' }, now), 'cases', 'retained with a case: the case');
  assert.equal(listFor({ conversionStatus: 'Retained', retainerSigned: '2026-10-01', retainerPaid: '2026-10-02' }, now), 'retainers', 'retained with no case linked (its case deleted, the record kept): the Retained tab (point 8)');
  assert.equal(require('../src/services/consultantPortalService').retainerTab({ conversionStatus: 'Retained', outcome: 'Follow-Up' }), 'Retained', 'retained: the Retained tab, whatever the outcome');
  assert.equal(listFor({ bookingStatus: 'Booked', bookedSlot: '2026-11-20 10:00' }, now), 'consultations', 'booked for a later day');
  assert.equal(listFor({ bookingStatus: 'Booked', bookedSlot: '2026-11-03 10:00', outcome: 'Follow-Up' }, now), 'retainers', 'a consultation that happened, Follow-Up set');
  assert.equal(listFor({ bookingStatus: 'Booked', bookedSlot: '2026-11-03 10:00' }, now), 'consultations', 'happened, no outcome yet (Needs outcome)');
  assert.equal(listFor({ bookingStatus: 'Not Yet', bookingInvite: 'Sent' }, now), 'leads', 'not booked: the lead page');
  // the day-of flow: consultation today, outcome set today → on Retainers at once (the board's rule) — the record read carries the time too
  assert.equal(listFor({ bookingStatus: 'Booked', bookedSlot: '2026-11-05 09:00', outcome: 'Follow-Up', outcomeChangedAt: '2026-11-05T14:30:00Z' }, now), 'retainers');
  assert.equal(listFor({ bookingStatus: 'Booked', bookedSlot: '2026-11-05 09:00', outcome: 'Follow-Up', outcomeChangedAt: '2026-11-04T14:30:00Z' }, now), 'consultations', 'an outcome left from an earlier day: still today\'s list');
  const { parseItem } = require('../src/services/leadService');
  const OC = require('../src/data/newLeadsBoard.json').columns.outcome;
  assert.equal(parseItem({ id: '1', name: 'X', column_values: [{ id: OC, text: 'Follow-Up', value: JSON.stringify({ index: 2, changed_at: '2026-11-05T14:30:00.000Z' }) }] }).outcomeChangedAt, '2026-11-05T14:30:00.000Z', 'every lead read carries when the Outcome was set');
  assert.equal(parseItem({ id: '1', name: 'X', column_values: [{ id: OC, text: '', value: null }] }).outcomeChangedAt, '');
  assert.equal(parseItem({ id: '1', name: 'X', column_values: [{ id: OC, text: 'Retain', value: '{not json' }] }).outcomeChangedAt, '', 'an unreadable value: unknown');
  const svcSrc = fs.readFileSync(require.resolve('../src/services/leadSnapshot'), 'utf8');
  assert.ok(!svcSrc.includes('JSON.parse(oc.value).changed_at'), 'one place: parseItem');
  const retPage = require('../src/routes/adminConsultation').buildRetainersHTML();
  assert.ok(retPage.includes("bindRowClicks(tb,'?from=retainers');") && retPage.includes("+encodeURIComponent(res.j.leadId)+'?from=retainers'; };"), 'the Retainers rows and the new-client pop-up say where they came from');
  assert.ok(!require('../src/routes/adminConsultation').buildQueueHTML().includes("'?from=retainers'"), 'the Consultations rows do not');
  const dr = route('/consultation/:leadId'); const outs = {};
  dr.route.stack[0].handle({ params: { leadId: '555' }, query: { from: 'retainers' } }, { type: () => ({ send: (h) => { outs.ret = h; } }) });
  dr.route.stack[0].handle({ params: { leadId: '555' }, query: { from: 'junk' } }, { type: () => ({ send: (h) => { outs.junk = h; } }) });
  assert.ok(outs.ret.includes('<span id="back-lnk-txt">Retainers &amp; follow-ups</span>') && outs.junk.includes('<span id="back-lnk-txt">All consultations</span>'));
  // the top bar has the new page
  const nav = require('../src/routes/adminShared').buildNavHeader('retainers');
  assert.ok(nav.includes('<a href="/admin/retainers" class="nav-lnk active" title="Retainers &amp; follow-ups" aria-current="page">'));
  assert.ok(nav.indexOf('/admin/consultations') < nav.indexOf('/admin/retainers') && nav.indexOf('/admin/retainers') < nav.indexOf('/admin/dashboard"'), 'Leads · Consultations · Retainers · Cases · Summary · Guide');
});

/* ── Cases: batched parallel fetch with a short raw cache ── */

test('cases board: ids listed cheaply, rows fetched in parallel batches of 100 WITH a limit (the 25-row trap), cached briefly; only raw rows are cached', async () => {
  const dash = require('../src/services/dashboardService');
  const mondayApi = require('../src/services/mondayApi');
  const calls = [];
  const restore = [stub(mondayApi, 'query', async (q, v) => {
    calls.push({ q, v });
    if (/items_page\(limit: 500/.test(q)) return { boards: [{ items_page: { cursor: null, items: Array.from({ length: 230 }, (_, i) => ({ id: String(i + 1) })) } }] };
    if (/\{ groups \{ id title position \}/.test(q)) return { boards: [{ groups: [], columns: [] }] };   // the board meta (block 3)
    assert.match(q, /items\(ids: \$ids, limit: 100\)/);
    return { items: v.ids.map((id) => ({ id, name: `C${id}`, created_at: '', column_values: [] })) };
  })];
  try {
    dash.invalidateCases();
    const items = await dash.fetchAllItems({ fresh: true });
    assert.equal(items.length, 230);
    assert.match(calls[0].q, /items_page\(limit: 500/, 'the id listing is still the first call');
    // calls picked by what they are (the meta read runs beside the batches), not by position
    const batchCalls = calls.filter((c) => /items\(ids: \$ids, limit: 100\)/.test(c.q));
    assert.deepEqual(batchCalls.map((c) => c.v.ids.length), [100, 100, 30]);
    assert.equal(calls.filter((c) => /\{ groups \{ id title position \}/.test(c.q)).length, 1, 'one meta read per fresh read');
    assert.equal(calls.length, 1 + 3 + 1);
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
    if (/\{ groups \{ id title position \}/.test(q)) return Promise.resolve({ boards: [{ groups: [], columns: [] }] });   // the board meta (block 3)
    assert.match(q, /items\(ids: \$ids, limit: 100\)/);
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
  const ret = require('../src/routes/adminConsultation').buildRetainersHTML();   // the follow-up filter and the outcome tabs are on the Retainers page (2026-11-05)
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  // 2026-11-12: the folds are tabs now — no fold look left on the page
  assert.ok(!css.includes('.fold') && !html.includes('id="needs-outcome"') && !html.includes('id="nodate"') && !html.includes('id="done-groups"'));
  assert.ok(ret.includes("followUp: { label: 'Follow-up'") && ret.includes("due: 'Due (today or earlier)'") && ret.includes("{ id: 'outcome', label: 'Outcome', title: 'The outcome tabs are above the table; here: the follow-up date', menu: 'facet', facets: ['followUp'] }"),
    'the follow-up filter is on Retainers (its Outcome column), where a follow-up sits once its consultation day has passed');
  assert.ok(!html.includes('id="f-followup"') && !html.includes("facets: ['followUp']"), 'and not on Consultations (it would find almost nothing there)');
  for (const page of [html, ret]) assert.ok(page.includes("if(c.followUpDate) h+=' '+qpill(c.followUpDate<=todayStr()?'amber':'grey','follow-up '+c.followUpDate);"), 'the outcome cell is the same on both pages');
  assert.ok(html.includes('var oc=outcomeCell(c);') && ret.includes("'<td>'+outcomeCell(c)+'</td>'"), 'the Consultations row and the Retainers row show the outcome the same way');
  assert.ok(ret.includes("var d = s(r.followUpDate); return !d ? 'none' : d <= ctx.today() ? 'due' : 'later';"), 'due = today or earlier, Toronto today');
  assert.ok(ret.includes('today: todayStr'), 'the page hands its Toronto today to the list');
  for (const page of [html, ret]) assert.ok(page.includes("if(!r.ok){ return r.json().catch(function(){ return {}; }).then(function(j){ throw new Error(j.error||('HTTP '+r.status)); }); }"));
  for (const page of [html, ret]) for (const m of page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
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
  const html = require('../src/routes/adminConsultation').buildRetainersHTML();   // the Retainers page (2026-11-05)
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
  const outs = js.match(/var RET_TABS=(\[[^\]]*\])/)[1], apart = js.match(/var RET_APART=(\[[^\]]*\])/)[1];
  const a = js.indexOf('function cleanOutcomes('), b = js.indexOf('function renderRetainerList(');
  const loc = { search: '' };
  const fns = new Function('window', 'history', `var RET_TABS=${outs}, RET_APART=${apart}; ${js.slice(a, b)}; return { cleanOutcomes, retInitial, retOnChange, retCase: typeof retCase === 'function' ? retCase : null, RET_TABS, RET_APART };`)({ location: loc }, { replaceState() {} });
  // the outcome group of a row is the list spec's (listSpecs.js) — the "quick" facet behind the tabs
  const LT = require('../src/routes/listFilters').listCore(require('../src/routes/listSpecs').retainerListSpec({ outcomes: fns.RET_TABS, apart: fns.RET_APART, today: () => '' }));
  fns.LT = LT;
  fns.retGroup = (r) => LT.valuesOf('outcome', r)[0];
  fns.loc = loc;
  return fns;
}

test('page: the Retainers outcome tabs (like the Leads page, 2026-11-05 point 7) — one per outcome plus All last, counts from the other filters; opens on Retain; the tab is kept until the browser tab closes; a link opens a tab; an Outcome column; a follow-up filter', () => {
  const html = require('../src/routes/adminConsultation').buildRetainersHTML();   // its own page since 2026-11-05
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
  const f = quickFns();
  assert.deepEqual(f.RET_TABS, [...require('../config/outcomes').OUTCOME_LABELS, 'Retained'], 'the tabs are the four outcomes, from config, then Retained (point 8)');
  assert.deepEqual(f.RET_APART, ['Retained'], 'Retained is kept apart from All');
  assert.equal(f.RET_TABS[0], 'Retain', 'Retain is the first tab — the one a new browser tab opens on');
  assert.ok(!require('../config/outcomes').OUTCOME_LABELS.includes('Retained'), 'Retained is a tab, never an outcome (the outcome write-validator)');
  assert.deepEqual(f.cleanOutcomes(['Follow-Up', 'Newsletter', 'Follow-Up', 'junk', '', ' Not Wanted ']), ['Follow-Up', 'Newsletter', 'Not Wanted'], 'only real outcomes, once each');
  assert.deepEqual(f.cleanOutcomes(''.split(',')), []);
  assert.equal(f.retGroup({ outcomeGroup: 'Newsletter' }), 'Newsletter');
  assert.equal(f.retGroup({}), 'Retain', 'a row without a group counts under Retain');
  // 2026-11-05: the tabs are the shared list engine's "quick" facet in tabs mode (listFilters.js renderQuick: one per
  // outcome then All, role=tab, counts from the other filters) — the same engine and look as the Leads page tabs.
  for (const s of ['<div class="lt-tabs" id="r-quick" role="tablist" aria-label="Retainers &amp; follow-ups by outcome"></div>', '<div class="q-head r-tools">',
    '<th>Consultant</th><th>Outcome</th><th>Consult fee</th><th>Retainer fee</th>',
    "((c.kind==='direct' && !c.paid)?'<span class=\"pill grey\" title=\"Direct retainer client — no consultation\">n/a</span>':paidPill(c))",
    "u.searchParams.set('outcome',l.length?l[0]:'All');", "retOnChange(RetainerTable.state());", "function retInitial(st){ var p=new URLSearchParams(window.location.search).get('outcome'); if(p===null) return false;",
    "quick: { facet: 'outcome', box: 'r-quick', tabs: true, allLast: true, all: 'All', storeKey: 'tdot_list_retainers_tab', default: (ctx.outcomes || [])[0],",
    "initial: retInitial, onChange: retOnChange", "{ outcomes: RET_TABS, apart: RET_APART, today: todayStr, hints: RET_HINTS, initial: retInitial, onChange: retOnChange }",
    "role=\"tab\" class=\"lt-tab'", "key: 'tdot_list_retainers'",
    '.pill.red {', 'colspan="12"']) assert.ok(html.includes(s), s);
  for (const gone of ['class="quick"', '.quick button', 'aria-label="Show by outcome"', "label: 'Show'", "lsSet('tdot_ret_outcomes'", 'function setRout(', 'function paidMatch(', "['rf-search',", "u.searchParams.set('tab'", 'function setTab(']) assert.ok(!html.includes(gone), 'gone: ' + gone);
  assert.ok(html.indexOf('initial: retInitial') < html.indexOf('<script>load();'), 'the link\'s choice is read before the first render');
  // a link opens a tab (true = a link chose it, so the engine does not put the kept tab over it); a bare ?outcome= opens All
  const st = { sel: {} }; f.loc.search = '?outcome=Follow-Up,junk'; assert.equal(f.retInitial(st), true); assert.deepEqual(st.sel.outcome, ['Follow-Up']);
  const st1 = { sel: {} }; f.loc.search = '?outcome=Newsletter,Follow-Up'; assert.equal(f.retInitial(st1), true); assert.deepEqual(st1.sel.outcome, ['Newsletter'], 'an old link naming several opens the first');
  const st2 = { sel: { outcome: ['Retain'] } }; f.loc.search = '?outcome='; assert.equal(f.retInitial(st2), true); assert.equal(st2.sel.outcome, undefined, 'a bare ?outcome= opens All');
  const st3 = { sel: { outcome: ['Retain'] } }; f.loc.search = ''; assert.equal(f.retInitial(st3), false); assert.deepEqual(st3.sel.outcome, ['Retain'], 'no link: the kept tab is used');
  const st4 = { sel: { outcome: ['Retain'] } }; f.loc.search = '?outcome=Follow%20Up'; assert.equal(f.retInitial(st4), false, 'a link naming no outcome we know is not a link: the kept tab is used'); assert.deepEqual(st4.sel.outcome, ['Retain']);
  const st5 = { sel: { outcome: ['Retain'] } }; f.loc.search = '?outcome=All'; assert.equal(f.retInitial(st5), true); assert.equal(st5.sel.outcome, undefined, '?outcome=All opens All');
  // the address always names the tab shown, All too — so the address and the tab never disagree
  assert.ok(html.indexOf('retOnChange(RetainerTable.state());') > html.indexOf("api: 'RetainerTable'"), 'named once the list is set up');
});

test('page: one consultation-fee rule for both tabs (the Paid / Consult fee header filters)', () => {
  // 2026-11-05: each row has ONE fee value; "Paid (any way)" = app + staff ticked together (test/listSpecs.test.js).
  const { listCore } = require('../src/routes/listFilters'), S = require('../src/routes/listSpecs');
  const C = listCore(S.consultListSpec({})), R = listCore(S.retainerListSpec({ outcomes: [], today: () => '' }));
  const row = (paid) => ({ paid, kind: 'booked' });
  assert.deepEqual(['app', 'cash', 'e-transfer', 'waived', ''].map((p) => C.valuesOf('paid', row(p))[0]), ['app', 'staff', 'staff', 'waived', 'none']);
  assert.deepEqual(['app', 'cash', 'e-transfer', 'waived', ''].map((p) => R.valuesOf('paid', row(p))[0]), ['app', 'staff', 'staff', 'waived', 'none'], 'the same on Retainers');
});

test('page: it is "Retainers & follow-ups" — a Follow-Up client is someone the team calls back, never shown as retained (Faran 2026-10-16); its own page since 2026-11-05', () => {
  const html = require('../src/routes/adminConsultation').buildRetainersHTML();
  assert.ok(html.includes('<span class="nav-txt">Retainers</span>') && html.includes('title="Retainers &amp; follow-ups"'), 'the top bar');
  assert.ok(html.includes('<h1 class="page-h" style="margin:0">Retainers &amp; follow-ups <span id="r-count"'));
  assert.ok(html.includes('<b>Follow-Up</b>: call the client back (not retained)'));
  assert.ok(html.includes("'Follow-Up':'The team calls the client back — not retained'"));
  assert.ok(!html.includes('No clients at the retainer stage') && !html.includes('No retainer clients match'));
});

// Every consultation stays on the Consultations page (Faran 2026-11-11): the completed ones in month groups.
test('completedConsultation: an outcome (at once), a retainer under way or a retained client = completed, with where the client is now; never a direct retainer client or an unbooked lead', () => {
  const cc = (l) => portal.completedConsultation(l, '2026-11-11');
  const B = { bookingStatus: 'Booked', bookedSlot: '2026-11-05 10:00' };
  assert.equal(cc({ ...B }), null, 'no outcome yet: still to be decided');
  assert.equal(cc({ bookingStatus: 'Not Yet', outcome: 'Follow-Up' }), null, 'never booked: not a consultation');
  assert.equal(cc({ sourceChannel: 'Direct Retainer', conversionStatus: 'Retained', retainerPaid: '2026-11-01' }), null, 'a direct retainer client had no consultation');
  assert.deepEqual(cc({ ...B, outcome: 'Follow-Up' }), { now: 'Following up', tone: 'amber' });
  assert.deepEqual(cc({ ...B, outcome: 'Newsletter' }), { now: 'Newsletter list', tone: 'grey' });
  assert.deepEqual(cc({ ...B, outcome: 'Not Wanted' }), { now: 'Closed', tone: 'grey' });
  assert.deepEqual(cc({ ...B, outcome: 'Retain' }), { now: 'Retainer to send', tone: 'amber' });
  assert.deepEqual(cc({ ...B, bookedSlot: '2026-11-20 10:00', outcome: 'Retain' }), { now: 'Retainer to send', tone: 'amber' }, 'Retain before the day: completed at once');
  assert.deepEqual(cc({ ...B, bookedSlot: '2026-11-11 10:00', outcome: 'Follow-Up', outcomeChangedAt: '2026-11-11T16:00:00Z' }), { now: 'Following up', tone: 'amber' }, 'today, the outcome set today: at once');
  // review 2026-11-11: a client who books AGAIN keeps the new meeting on the upcoming list — the old outcome is still on the row
  assert.equal(cc({ ...B, bookedSlot: '2026-11-11 14:00', outcome: 'Follow-Up', outcomeChangedAt: '2026-10-02T16:00:00Z' }), null, 'today, the outcome from an earlier consultation');
  assert.equal(cc({ ...B, bookedSlot: '2026-11-20 10:00', outcome: 'Not Wanted', outcomeChangedAt: '2026-10-02T16:00:00Z' }), null, 'a later day: upcoming until then (as on the Retainers page)');
  // review 2026-11-11: a held or abandoned booking attempt is not a consultation (its slot text stays behind)
  assert.equal(cc({ bookingStatus: 'Abandoned', bookedSlot: '2026-11-05 10:00', outcome: 'Not Wanted' }), null);
  assert.equal(cc({ bookingStatus: 'Slot Held', bookedSlot: '2026-11-05 10:00', conversionStatus: 'Retained' }), null);
  assert.deepEqual(cc({ bookingStatus: 'Abandoned', bookedSlot: '2026-11-05 10:00', consultationHeld: '2026-11-05', outcome: 'Not Wanted' }), { now: 'Closed', tone: 'grey' }, '…unless it was held');
  // review 2026-11-11: a lead converted to a direct retainer client AFTER its consultation keeps the consultation
  assert.deepEqual(cc({ ...B, consultationHeld: '2026-11-05', directClient: 'Yes' }), { now: 'Retainer to send', tone: 'amber' });
  assert.deepEqual(cc({ ...B, directClient: 'Yes', conversionStatus: 'Retained' }), { now: 'Retained', tone: 'green' });
  assert.deepEqual(cc({ ...B, outcome: 'Retain', retainerSent: '2026-11-06' }), { now: 'Retainer sent', tone: 'blue' });
  assert.deepEqual(cc({ ...B, retainerSent: '2026-11-06', retainerSigned: '2026-11-07' }), { now: 'Retainer signed', tone: 'blue' }, 'a retainer under way with the outcome left blank');
  assert.deepEqual(cc({ ...B, outcome: 'Retain', retainerSigned: '2026-11-07', retainerPaid: '2026-11-08' }), { now: 'Retainer paid', tone: 'blue' });
  assert.deepEqual(cc({ ...B, outcome: 'Retain', conversionStatus: 'Retained', clientMasterItemId: '9' }), { now: 'Retained', tone: 'green' });
  assert.deepEqual(cc({ bookingStatus: 'Booked', outcome: 'Follow-Up' }), { now: 'Following up', tone: 'amber' }, 'booked by hand with no time');
  assert.deepEqual(cc({ bookingStatus: '', bookedSlot: '2026-10-01 09:00', conversionStatus: 'Retained' }), { now: 'Retained', tone: 'green' }, 'a consultation time is enough');
});

test('getConsultationsBoard withCompleted: each consultation is in exactly one of upcoming / completed; latest first; the case number where there is a case; no email or phone; the other pages are as before', async () => {
  snap._reset();
  const rows = [
    L(1, { bookingStatus: 'Booked', bookedSlot: '2026-10-20 11:00' }),                                          // upcoming
    L(2, { bookingStatus: 'Booked', bookedSlot: '2026-10-14 15:00', outcome: 'Follow-Up' }),                    // yesterday, an outcome
    L(3, { bookingStatus: 'Booked', bookedSlot: '2026-10-09 10:00', outcome: 'Retain', retainerSent: '2026-10-10' }),
    L(4, { bookingStatus: 'Booked', bookedSlot: '2026-09-02 10:00', outcome: 'Retain', conversionStatus: 'Retained', clientMasterItemId: '77' }),
    L(5, { sourceChannel: 'Direct Retainer', conversionStatus: 'Retained', clientMasterItemId: '78' }),          // no consultation
    L(6, { bookingStatus: 'Booked', outcome: 'Not Wanted' }),                                                    // no time
    L(7),                                                                                                        // a lead
  ];
  const dash = require('../src/services/dashboardService');
  const restore = [stub(snap.io, 'fetchLeads', async () => rows), stub(dash, 'fetchAllItems', async () => [{ id: '77', column_values: [{ id: 'text_mm142s49', text: '2026-EE-004' }] }])];
  try {
    const now = new Date('2026-10-15T16:00:00Z');
    const b = await portal.getConsultationsBoard({ now, withCompleted: true });
    assert.deepEqual(b.consultations.map((r) => r.id), ['1']);
    for (const l of rows) assert.ok(b.consultations.filter((r) => r.id === l.id).length + b.completed.filter((r) => r.id === l.id).length <= 1, 'never in both');
    assert.deepEqual(b.completed.map((r) => [r.id, r.now]), [['2', 'Following up'], ['3', 'Retainer sent'], ['4', 'Retained'], ['6', 'Closed']], 'the latest consultation first, no time last');
    assert.ok(b.completed.every((r) => r.done === true && !('clientMasterItemId' in r)));
    assert.equal(b.completed[2].caseRef, '2026-EE-004');
    assert.ok(!('caseRef' in b.completed[0]), 'a case number only where there is a case');
    assert.ok(!JSON.stringify(b).includes('x@y.co') && !JSON.stringify(b).includes('555-0142'), 'a list, not a record');
    // without the flag: exactly as before — the early Follow-Up is still upcoming, nothing completed is sent
    const plain = await portal.getConsultationsBoard({ now });
    assert.equal(plain.completed, undefined);
    assert.deepEqual(plain.consultations.map((r) => r.id), ['1']);
    assert.deepEqual(plain.retainers.map((r) => r.id).sort(), ['2', '3', '6']);
  } finally { restore.forEach((r) => r()); snap._reset(); }
});

// Faran 2026-11-12: four fixed tabs (Booked · Needs outcome · Completed · No date) over one table, with a month chooser on Completed.
test('page: four tabs over one table — each consultation under exactly one tab; the Date filter narrows Booked only; Now has its own column and filter', () => {
  const { listCore } = require('../src/routes/listFilters'), S = require('../src/routes/listSpecs');
  const q = require('../src/routes/adminConsultation').buildQueueHTML();
  for (const s of ["bindRowClicks(tb, (tab==='done'||tab==='all')?'?from=consultations':'')", "!(st&&st.sort&&st.sort.key)", 'id="cq-tabs"', 'id="cq-month"', 'function renderMonthBar(', "MONTH_KEY={ done:'tdot_list_consult_month', all:'tdot_list_consult_month_all' }", "ALLROWS=(d.consultations||[]).concat(d.completed||[]);", '<th>Now</th>',
    '#cq-table:not(.tab-done):not(.tab-all) th:nth-child(11), #cq-table:not(.tab-done):not(.tab-all) td.c-now { display:none; }', '#cq-table.tab-done th:nth-child(12), #cq-table.tab-done td.c-del { display:none; }']) assert.ok(q.includes(s), s);
  for (const gone of ['function renderDone(', 'id="done-groups"', 'show / hide', 'function consultBucket(']) assert.ok(!q.includes(gone), 'gone: ' + gone);
  const spec = S.consultListSpec({ today: () => '2026-11-11' }), LT = listCore(spec), o = S.consultListOpts({});
  const rows = [
    { id: 'a', bookedSlot: '2026-11-11 10:00' }, { id: 'c', bookedSlot: '2026-11-13 10:00' },
    { id: 'n', bookedSlot: '2026-11-03 10:00' }, { id: 'x', bookedSlot: '2026-11-03 10:00', direct: 'Existing client' },
    { id: 'b', bookedSlot: '2026-09-02 10:00', outcome: 'Retain', done: true, now: 'Retained' }, { id: 'd', bookedSlot: '', done: true, now: 'Closed' },
    { id: 'z', bookedSlot: '' },
  ];
  assert.deepEqual(rows.map((r) => LT.valuesOf('tab', r)[0]), ['booked', 'booked', 'needs', 'booked', 'done', 'done', 'nodate']);
  const on = (tab, from) => { const st = LT.emptyState(); st.sel.tab = [tab]; if (from) st.from = st.to = from; return st; };
  assert.deepEqual(LT.filterRows(rows, on('booked', '2026-11-11')).map((r) => r.id), ['a']);
  assert.deepEqual(LT.filterRows(rows, on('booked')).map((r) => r.id), ['a', 'c', 'x']);
  for (const tab of ['needs', 'done', 'nodate']) assert.deepEqual(LT.filterRows(rows, on(tab, '2026-11-11')).map((r) => r.id), LT.filterRows(rows, on(tab)).map((r) => r.id), tab + ': the Date filter changes nothing');
  assert.deepEqual(LT.filterRows(rows, on('done', '2026-11-11')).map((r) => r.id), ['b', 'd']);
  assert.deepEqual(LT.facetCounts(rows, on('booked', '2026-11-11'), 'tab').map((x) => [x.label, x.count]), [['Booked', 1], ['Needs outcome', 1], ['Completed', 2], ['No date', 1]]);
  assert.deepEqual(LT.chips(on('done')), [], 'the tab is not a chip');
  assert.deepEqual(LT.clearAll(on('done')).sel, { tab: ['done'] }, 'Clear filters keeps the tab');
  const st = on('done'); st.sel.now = ['Retained'];
  assert.deepEqual(LT.filterRows(rows, st).map((r) => r.id), ['b']);
  assert.deepEqual([o.quick.facet, o.quick.box, o.quick.tabs, o.quick.allLast, o.quick.all, o.quick.default, o.quick.values.join()], ['tab', 'cq-tabs', true, true, 'All', 'booked', 'booked,needs,done,nodate']);
  // All (no tab chosen) = the four tabs together: its count is always the four counts added up — the Date filter still narrows the booked ones
  const all = LT.emptyState(); all.from = all.to = '2026-11-11';
  assert.deepEqual(LT.filterRows(rows, all).map((r) => r.id), ['a', 'n', 'b', 'd', 'z']);
  assert.equal(LT.filterRows(rows, all).length, LT.facetCounts(rows, all, 'tab').reduce((n, x) => n + x.count, 0));
  assert.equal(LT.filterRows(rows, LT.emptyState()).length, rows.length, 'no date chosen: every consultation');
  assert.ok(o.quick.storeKey.indexOf('tdot_list_') === 0, 'Sign Out forgets the kept tab');
  assert.deepEqual(o.cols.slice(-3).map((c) => [c.id, (c.facets || []).join()]), [['outcome', 'outcome'], ['now', 'now'], ['del', '']]);
});

test('listTableUi, Consultations tabs: a new browser tab opens on Booked; All is the last tab and is kept when chosen; an unknown kept tab falls back to Booked', () => {
  const { listTableUi, listCore } = require('../src/routes/listFilters'), S = require('../src/routes/listSpecs');
  const el = () => ({ innerHTML: '', setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, contains() { return false; } }, appendChild() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, contains() { return false; }, style: {} });
  const open = (store) => {
    const seen = [], box = el();
    const win = { document: { getElementById: (id) => (id === 'cq-tabs' ? box : null), createElement: el, body: el(), addEventListener() {}, activeElement: null, documentElement: el() },
      sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }, addEventListener() {}, location: { search: '' },
      renderConsultList: (rows, why, st) => { seen.push(((st.sel.tab || ['(all)'])).join()); return null; } };
    const o = Object.assign({}, S.consultListOpts({}), { serverSearch: null });
    const api = listTableUi(listCore(S.consultListSpec({})), o, win) || win[o.api];
    api.setRows([]);
    return { seen, api, box, store };
  };
  const r = open({});
  assert.deepEqual(r.seen, ['booked']);
  const labels = (r.box.innerHTML.match(/data-quick="[^"]*"/g) || []);
  assert.deepEqual(labels, ['data-quick="booked"', 'data-quick="needs"', 'data-quick="done"', 'data-quick="nodate"', 'data-quick=""'], 'four tabs, then All');
  assert.ok(r.api.core && typeof r.api.core.valuesOf === 'function', 'the page can ask which tab a row is under');
  assert.deepEqual(open({ tdot_list_consult_tab4: 'done' }).seen, ['done']);
  assert.deepEqual(open({ tdot_list_consult_tab4: '' }).seen, ['(all)'], 'All was chosen: kept');
  assert.deepEqual(open({ tdot_list_consult_tab4: 'gone' }).seen, ['booked']);
});

// 2026-11-12: the row markup, run for real — a doubled quote once broke the delete button's lead id without any test noticing.
test('page row: 12 cells; the delete button carries the lead id; a completed row has the Now cell and no delete button', () => {
  const html = require('../src/routes/adminConsultation').buildQueueHTML();
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
  const pick = (name) => { const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let depth = 0, j = js.indexOf('{', i); for (; j < js.length; j++) { if (js[j] === '{') depth++; else if (js[j] === '}' && --depth === 0) break; } return js.slice(i, j + 1); };
  const ctx = { escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), todayStr: () => '2026-11-12', TDOT_DEL_SVG: '<svg/>', Intl };
  vm.createContext(ctx);
  vm.runInContext(['qpill', 'paidPill', 'outcomeCell', 'dParts', 'dAdd', 'dLabel', 'dateCell', 'timeCell', 'directPill', 'nowCell', 'rowHtml'].map(pick).join('\n'), ctx);
  const up = ctx.rowHtml({ id: '77', name: 'A "B"', bookedSlot: '2026-11-12 10:00', adminDelete: true });
  assert.equal((up.match(/<td/g) || []).length, 12);
  assert.match(up, /<td class="c-now"><\/td><td class="c-del"><button class="del-btn" type="button" data-del-lead="77" data-del-admin-only="1" title="/);
  const done = ctx.rowHtml({ id: '78', name: 'C', bookedSlot: '2026-10-02 10:00', outcome: 'Retain', done: true, now: 'Retained', nowTone: 'green', caseRef: '2026-EE-004' });
  assert.equal((done.match(/<td/g) || []).length, 12);
  assert.match(done, /<td class="c-now"><span class="pill green">Retained<\/span> <a class="case-lnk" href="\/admin\/case\/2026-EE-004"/);
  assert.match(done, /<td class="c-del"><\/td><\/tr>$/);
  assert.ok(!done.includes('data-del-lead'));
});

// review 2026-11-12: Date belongs to Booked / All and Now to Completed / All — off those tabs they are not on view, so they must not act unseen.
test('page: leaving Completed takes a Now choice off; "Clear filters" on a tab where the Date chip is hidden does not take the Date off', () => {
  const html = require('../src/routes/adminConsultation').buildQueueHTML();
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
  const pick = (name) => { const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let depth = 0, j = js.indexOf('{', i); for (; j < js.length; j++) { if (js[j] === '{') depth++; else if (js[j] === '}' && --depth === 0) break; } return js.slice(i, j + 1); };
  const applied = [];
  const ctx = { window: { ConsultTable: { apply: (w) => applied.push(w) } }, TAB_TEXT: { booked: 1, needs: 1, done: 1, nodate: 1, all: 1 } };
  ctx.ConsultTable = ctx.window.ConsultTable;   // in a page, window's properties are globals
  vm.createContext(ctx);
  vm.runInContext('var KEPT_DATE=null;\n' + pick('consultTab') + '\n' + pick('consultOnChange'), ctx);
  const st = { from: '2026-11-12', to: '2026-11-12', sel: { tab: ['booked'] } };
  ctx.consultOnChange(st); assert.deepEqual(applied, []);
  st.sel.tab = ['done']; st.sel.now = ['Retained']; ctx.consultOnChange(st);
  assert.deepEqual([st.sel.now, applied.length], [['Retained'], 0], 'Now stays on Completed');
  st.from = ''; st.to = ''; ctx.consultOnChange(st);            // "Clear filters" pressed on Completed
  assert.deepEqual([st.from, st.to, applied], ['2026-11-12', '2026-11-12', ['data']], 'the hidden Date filter is put back');
  st.sel.tab = ['needs']; ctx.consultOnChange(st);
  assert.equal(st.sel.now, undefined, 'Now is taken off when leaving for a tab without the column');
  delete st.sel.tab; st.sel.now = ['Closed']; st.from = ''; st.to = ''; ctx.consultOnChange(st);   // All: both are on view
  assert.deepEqual([st.sel.now, st.from], [['Closed'], ''], 'on All the Date can be taken off and Now chosen');
  assert.ok(html.includes("listCore((") && html.includes("{ onChange: consultOnChange }"));
});

// Faran 2026-11-12: the month chooser on Completed (one month, opening on the current one) and on All ("All months" first).
test('page month chooser: Completed opens on the current month (else the newest); All opens on every month; each tab keeps its own choice; a month that has gone falls back', () => {
  const html = require('../src/routes/adminConsultation').buildQueueHTML();
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
  const pick = (name) => { const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let depth = 0, j = js.indexOf('{', i); for (; j < js.length; j++) { if (js[j] === '{') depth++; else if (js[j] === '}' && --depth === 0) break; } return js.slice(i, j + 1); };
  const store = {}, applied = [];
  const ctx = { todayStr: () => '2026-11-12', ssGet: (k) => store[k] || '', ssSet: (k, v) => { store[k] = v; }, window: {}, ConsultTable: { apply: (w) => applied.push(w) },
    ALLROWS: [{ id: 'a', bookedSlot: '2026-11-12 10:00' }, { id: 'b', bookedSlot: '2026-12-02 10:00' }, { id: 'c', bookedSlot: '2026-09-02 10:00', done: true }, { id: 'd', bookedSlot: '2026-07-01 10:00', done: true }, { id: 'e', bookedSlot: '', done: true }, { id: 'f', bookedSlot: '' }] };
  ctx.window.ConsultTable = ctx.ConsultTable;
  vm.createContext(ctx);
  vm.runInContext("var MONTH_PICK={ done:'', all:'' }, MONTH_KEY={ done:'tdot_list_consult_month', all:'tdot_list_consult_month_all' };\n" + ['dParts', 'monthOf', 'tabMonths', 'pickMonth', 'setMonth'].map(pick).join('\n'), ctx);
  const run = (code) => vm.runInContext(code, ctx);
  assert.equal(run("tabMonths('done').join()"), '2026-09,2026-07,none');
  assert.equal(run("tabMonths('all').join()"), '2026-12,2026-11,2026-09,2026-07,none');
  assert.equal(run("pickMonth('done', tabMonths('done'))"), '2026-09', 'no completed consultation this month: the newest month that has one');
  assert.equal(run("pickMonth('all', tabMonths('all'))"), 'all');
  run("setMonth('all','2026-09')");
  assert.deepEqual([run("pickMonth('all', tabMonths('all'))"), run("pickMonth('done', tabMonths('done'))"), store.tdot_list_consult_month_all, applied.length], ['2026-09', '2026-09', '2026-09', 1]);
  run("setMonth('done','2026-07'); setMonth('all','all')");
  assert.deepEqual([run("pickMonth('done', tabMonths('done'))"), run("pickMonth('all', tabMonths('all'))")], ['2026-07', 'all'], 'each tab keeps its own');
  run("MONTH_PICK.done='2025-01'; MONTH_PICK.all='2025-01'");
  assert.deepEqual([run("pickMonth('done', tabMonths('done'))"), run("pickMonth('all', tabMonths('all'))")], ['2026-09', 'all'], 'a month with nothing in it any more');
  run("setMonth('booked','2026-07')"); assert.equal(applied.length, 3, 'only the two tabs have a month');
  assert.ok(html.includes("<option value=\"all\"'+(month==='all'?' selected':'')+'>All months ('+total+')</option>"));
});
