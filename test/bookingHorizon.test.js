'use strict';

// Clients can book a consultation up to 12 weeks ahead (owner, 2026-09-28:
// "at least the next 12 weeks"). Square caps one availability search at 32
// days and one bookings list at 31, so the span is walked in 28-day chunks
// (never a tail under Square's 24h minimum), merged, de-duplicated and
// checked as one calendar. The static fallback spans the same weeks, and the
// page groups the long list under month headings.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const bookingService = require('../src/services/bookingService');
const squareBookings = require('../src/services/squareBookingsService');
const mondayApi      = require('../src/services/mondayApi');
const phase2         = require('../src/routes/phase2');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'BOOKING_WEEKS_AHEAD');
  const orig = process.env.BOOKING_WEEKS_AHEAD;
  if (value === undefined) delete process.env.BOOKING_WEEKS_AHEAD; else process.env.BOOKING_WEEKS_AHEAD = value;
  try { return fn(); } finally { if (had) process.env.BOOKING_WEEKS_AHEAD = orig; else delete process.env.BOOKING_WEEKS_AHEAD; }
}

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

// ─── the env knob ────────────────────────────────────────────────────────────

test('bookingWeeksAhead: unset → 12; a number is honoured; garbage → 12; out of range clamps to 1..26', () => {
  assert.equal(withEnv(undefined, () => bookingService.bookingWeeksAhead()), 12);
  assert.equal(withEnv('8', () => bookingService.bookingWeeksAhead()), 8);
  assert.equal(withEnv('abc', () => bookingService.bookingWeeksAhead()), 12);
  assert.equal(withEnv('', () => bookingService.bookingWeeksAhead()), 12);
  // Pinned: an out-of-range NUMBER is clamped, not replaced — "0" means the
  // shortest span we allow, "99" the longest.
  assert.equal(withEnv('0', () => bookingService.bookingWeeksAhead()), 1);
  assert.equal(withEnv('-3', () => bookingService.bookingWeeksAhead()), 1);
  assert.equal(withEnv('99', () => bookingService.bookingWeeksAhead()), 26);
  assert.equal(withEnv('26', () => bookingService.bookingWeeksAhead()), 26);
});

// ─── the window chunker ──────────────────────────────────────────────────────

test('availabilityWindows: 12 weeks → 3 contiguous chunks of ≤28 days ending exactly at the end', () => {
  const now = Date.parse('2026-09-28T14:00:00Z');
  const start = now + 25 * HOUR, end = now + 12 * 7 * DAY;
  const w = bookingService.availabilityWindows(start, end);
  assert.equal(w.length, 3);
  assert.equal(w[0][0], new Date(start).toISOString(), 'first chunk starts at the search start');
  assert.equal(w[w.length - 1][1], new Date(end).toISOString(), 'last chunk ends exactly at the search end');
  for (let i = 1; i < w.length; i++) assert.equal(w[i][0], w[i - 1][1], `chunk ${i} starts where chunk ${i - 1} ends`);
  for (const [s, e] of w) {
    const days = (Date.parse(e) - Date.parse(s)) / DAY;
    assert.ok(days > 0 && days <= 28, `chunk spans ${days} days`);
  }
  assert.equal((Date.parse(w[0][1]) - Date.parse(w[0][0])) / DAY, 28, 'full chunks are exactly 28 days');
  assert.equal((Date.parse(w[1][1]) - Date.parse(w[1][0])) / DAY, 28);
});

test('availabilityWindows: 1 week → a single chunk; a 28-day span → one chunk; 29 days → two', () => {
  const now = Date.parse('2026-09-28T14:00:00Z');
  const one = bookingService.availabilityWindows(now + 25 * HOUR, now + 7 * DAY);
  assert.equal(one.length, 1);
  assert.equal(one[0][0], new Date(now + 25 * HOUR).toISOString());
  assert.equal(one[0][1], new Date(now + 7 * DAY).toISOString());
  assert.equal(bookingService.availabilityWindows(now, now + 28 * DAY).length, 1);
  assert.equal(bookingService.availabilityWindows(now, now + 29 * DAY).length, 2);
  assert.deepEqual(bookingService.availabilityWindows(now, now), [], 'an empty span has no chunks');
  // Every legal span (1..26 weeks) keeps every chunk inside Square's limits:
  // never over 31 days, never under the 24h minimum a search must span (31-day
  // steps left BOOKING_WEEKS_AHEAD=18 with a 23-hour tail).
  for (let weeks = 1; weeks <= 26; weeks++) {
    for (const [s, e] of bookingService.availabilityWindows(now + 25 * HOUR, now + weeks * 7 * DAY)) {
      const hours = (Date.parse(e) - Date.parse(s)) / HOUR;
      assert.ok(hours <= 31 * 24, `${weeks} weeks: a chunk of ${hours}h is over Square's 31-day cap`);
      assert.ok(hours >= 24, `${weeks} weeks: a chunk of ${hours}h is under Square's 24h minimum`);
    }
  }
});

// ─── the live search over chunks ─────────────────────────────────────────────

const slot = (date, time, team = 'TM-1') => ({ date, time, startAt: `${date}T${time}:00Z`, teamMemberId: team, durationMinutes: 30, pool: 'consult' });

// Each test uses its own fixed "now" so the per-window bookings cache never
// carries over between them.
function liveSetup(nowIso, { search, list } = {}) {
  const now = Date.parse(nowIso);
  const searches = [], lists = [];
  const restore = [
    stub(Date, 'now', () => now),
    stub(mondayApi, 'query', async () => ({})),                     // no holds/bookings of our own
    stub(squareBookings, 'searchAvailability', async (args) => { searches.push(args); return search ? search(args, searches.length - 1) : []; }),
    stub(squareBookings, 'listBookings', async (args) => { lists.push(args); return list ? list(args, lists.length - 1) : []; }),
  ];
  return { now, searches, lists, restore: () => restore.forEach((x) => x()) };
}

test('getSquareAvailableSlots: searches every chunk with the chunk windows, merges in order, de-dupes the boundary slot', async () => {
  const chunkSlots = [
    [slot('2026-10-05', '10:00'), slot('2026-10-29', '15:00')],
    [slot('2026-10-29', '15:00'), slot('2026-11-16', '11:00')],   // 10-29 15:00 offered by both sides of a boundary
    [slot('2026-12-07', '09:30')],
  ];
  const env = liveSetup('2026-09-28T14:00:00Z', { search: (_a, i) => chunkSlots[i] });
  try {
    const out = await bookingService.getSquareAvailableSlots(12, 'TM-1', 'VAR-30');
    assert.equal(env.searches.length, 3, 'one search per 28-day chunk');
    const expected = bookingService.availabilityWindows(env.now + 25 * HOUR, env.now + 12 * 7 * DAY);
    assert.deepEqual(env.searches.map((a) => [a.startAtIso, a.endAtIso]), expected, 'the chunk windows are what was searched');
    assert.ok(env.searches.every((a) => a.teamMemberId === 'TM-1' && a.serviceVariationId === 'VAR-30' && a.pool === 'consult'), 'request shape unchanged');
    assert.deepEqual(out.map((s) => `${s.date} ${s.time}`),
      ['2026-10-05 10:00', '2026-10-29 15:00', '2026-11-16 11:00', '2026-12-07 09:30']);
  } finally { env.restore(); }
});

test('getSquareAvailableSlots: lists bookings once per chunk with the same windows; the merged list drives the buffer filter', async () => {
  const env = liveSetup('2026-09-29T09:00:00Z', {
    search: () => [slot('2026-10-06', '10:00'), slot('2026-11-20', '14:00'), slot('2026-12-10', '11:00')],
    // a staff-created booking in the THIRD chunk collides with the 12-10 slot
    list: (a, i) => (i === 2 ? [{ status: 'ACCEPTED', start_at: '2026-12-10T11:00:00Z', transition_time_minutes: 10, appointment_segments: [{ team_member_id: 'TM-1', duration_minutes: 30 }] }] : []),
  });
  try {
    const out = await bookingService.getSquareAvailableSlots(12, 'TM-1', 'VAR-30');
    assert.equal(env.lists.length, 3, 'one bookings list per chunk');
    assert.deepEqual(env.lists.map((a) => [a.startAtIso, a.endAtIso]), env.searches.map((a) => [a.startAtIso, a.endAtIso]), 'same windows as the search');
    assert.ok(!out.some((s) => s.date === '2026-12-10'), 'a booking found in a later chunk still drops its slot');
    // identical slots offered by all 3 chunks collapse to 3; the collided one is dropped → 2
    assert.deepEqual(out.map((s) => `${s.date} ${s.time}`), ['2026-10-06 10:00', '2026-11-20 14:00']);

    // A second duration in the same page view (same windows) reuses the cached lists.
    await bookingService.getSquareAvailableSlots(12, 'TM-1', 'VAR-45');
    assert.equal(env.searches.length, 6, 'availability is searched per duration');
    assert.equal(env.lists.length, 3, 'the bookings list is shared across durations via the per-chunk cache');
  } finally { env.restore(); }
});

test('getSquareAvailableSlots: one failed chunk fails the whole live search (no partial calendar) and no further chunk is started', async () => {
  const env = liveSetup('2026-09-30T09:00:00Z', {
    search: (_a, i) => { if (i === 1) throw new Error('Square 500 on chunk 2'); return [slot('2026-10-06', '10:00')]; },
  });
  try {
    await assert.rejects(() => bookingService.getSquareAvailableSlots(12, 'TM-1', 'VAR-30'), /chunk 2/);
  } finally { env.restore(); }
  // 26 weeks is 7 chunks; the first 3 go out together, and once one of them
  // has failed the other 4 are never sent (their result would be thrown away
  // anyway — during an outage they would only add to Square's load).
  const outage = liveSetup('2026-09-30T10:00:00Z', {
    search: (_a, i) => { if (i === 0) throw new Error('Square 503 on chunk 1'); return []; },
  });
  try {
    await assert.rejects(() => bookingService.getSquareAvailableSlots(26, 'TM-1', 'VAR-30'), /chunk 1/);
    assert.equal(outage.searches.length, 3, 'nothing launched after the failure');
  } finally { outage.restore(); }
});

test('getSquareAvailableSlots: same-minute availabilities of different staff both survive the merge and are filtered on their own', async () => {
  const env = liveSetup('2026-09-30T11:00:00Z', {
    search: () => [slot('2026-10-06', '10:00', 'TM-A'), slot('2026-10-06', '10:00', 'TM-B'), slot('2026-10-06', '10:00', 'TM-A')],
    // staff A is booked at that minute; staff B is free
    list: (_a, i) => (i === 0 ? [{ status: 'ACCEPTED', start_at: '2026-10-06T10:00:00Z', appointment_segments: [{ team_member_id: 'TM-A', duration_minutes: 30 }] }] : []),
  });
  try {
    const out = await bookingService.getSquareAvailableSlots(12, undefined, 'VAR-30');
    assert.deepEqual(out.map((s) => `${s.date} ${s.time} ${s.teamMemberId}`), ['2026-10-06 10:00 TM-B'], "A's booking drops A's offer only; B's identical minute stays");
  } finally { env.restore(); }
});

test('getSquareAvailableSlots: a listBookings failure keeps the page up (re-check skipped) and is not cached', async () => {
  let fails = 1;
  const env = liveSetup('2026-10-01T09:00:00Z', {
    search: () => [slot('2026-10-08', '10:00')],
    list: () => { if (fails-- > 0) throw new Error('bookings list down'); return []; },
  });
  try {
    const out = await bookingService.getSquareAvailableSlots(12, 'TM-1', 'VAR-30');
    assert.equal(out.length, 1, 'Square availability trusted when the re-check cannot run');
    await bookingService.getSquareAvailableSlots(12, 'TM-1', 'VAR-30');
    assert.equal(env.lists.length, 6, 'the whole list was refetched on the next view (one snapshot), not served from the cache');
  } finally { env.restore(); }
});

test('getSquareAvailableSlots: after a failed list, a later view (clock moved on) gets one coherent snapshot — no seam between chunks', async () => {
  // View A caches nothing usable (chunk 2 fails). View B, 25s later, must not
  // pair A's cached chunk 1 (ending at T) with its own fresh chunk 2 (starting
  // at T+25s): a booking at that boundary minute would sit in neither list.
  let now = Date.parse('2026-10-01T12:00:00Z');
  const lists = [];
  let fail = 1;
  const restore = [
    stub(Date, 'now', () => now),
    stub(mondayApi, 'query', async () => ({})),
    stub(squareBookings, 'searchAvailability', async () => []),
    stub(squareBookings, 'listBookings', async (a) => { lists.push([a.startAtIso, a.endAtIso]); if (lists.length === 2 && fail-- > 0) throw new Error('down'); return []; }),
  ];
  try {
    await bookingService.getSquareAvailableSlots(12, 'TM-1', 'VAR-30');
    now += 25 * 1000;
    await bookingService.getSquareAvailableSlots(12, 'TM-1', 'VAR-30');
    const viewB = lists.slice(3).sort();
    assert.equal(viewB.length, 3, 'view B lists every chunk itself');
    assert.equal(viewB[0][0], new Date(now + 25 * HOUR).toISOString(), "view B's list starts on view B's clock");
    for (let i = 1; i < viewB.length; i++) assert.equal(viewB[i][0], viewB[i - 1][1], `no gap between list chunks ${i - 1} and ${i}`);
    // and a third view inside the 30s window is served from that snapshot
    await bookingService.getSquareAvailableSlots(12, 'TM-1', 'VAR-45');
    assert.equal(lists.length, 6, 'the coherent snapshot is what the cache now holds');
  } finally { restore.forEach((x) => x()); }
});

test('getSquareAvailableSlots: 1 week → a single chunk (search + list), window starts 25h out', async () => {
  const env = liveSetup('2026-10-02T09:00:00Z', { search: () => [slot('2026-10-05', '10:00')] });
  try {
    await bookingService.getSquareAvailableSlots(1, 'TM-1', 'VAR-30');
    assert.equal(env.searches.length, 1);
    assert.equal(env.lists.length, 1);
    assert.equal(env.searches[0].startAtIso, new Date(env.now + 25 * HOUR).toISOString());
    assert.equal(env.searches[0].endAtIso, new Date(env.now + 7 * DAY).toISOString());
  } finally { env.restore(); }
});

// ─── the static fallback ─────────────────────────────────────────────────────

test('getStaticAvailableSlots: defaults to the configured span — every Mon/Tue/Thu of the next 12 weeks', async () => {
  const restore = stub(mondayApi, 'query', async () => ({}));
  try {
    const slots = await withEnv(undefined, () => bookingService.getStaticAvailableSlots('T2'));
    const dates = [...new Set(slots.map((s) => s.date))].sort();
    const expected = [];
    const today = new Date();
    const end = new Date(); end.setDate(end.getDate() + 12 * 7);
    for (let d = new Date(today); d <= end; d.setDate(d.getDate() + 1)) {
      if (d <= today) continue;
      if ([1, 2, 4].includes(d.getDay())) expected.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    assert.deepEqual(dates, expected);
    assert.ok(expected.length >= 35, `12 weeks of template days (${expected.length})`);
    const last = new Date(`${dates[dates.length - 1]}T12:00:00`);
    assert.ok((last - today) / DAY > 11 * 7, 'the last offered day is in the 12th week');
  } finally { restore(); }
});

// ─── the route wiring (source pins) ──────────────────────────────────────────

test('/book route: both the live and the static path use bookingWeeksAhead() — no hard-coded 4', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'phase2.js'), 'utf8');
  const route = src.slice(src.indexOf("router.get('/book/:leadId'"), src.indexOf("router.post('/book/:leadId'"));
  assert.match(route, /const weeks = bookingService\.bookingWeeksAhead\(\);/);
  assert.match(route, /getSquareAvailableSlots\(weeks, consultant\.teamMemberId, o\.variationId\)/);
  assert.match(route, /getStaticAvailableSlots\(lead\.tier \|\| 'T2', weeks\)/);
  assert.match(route, /buildBookingPageHtml\(lead, \{ sets, weeksAhead: weeks \}/, 'the page is told the span it should quote');
  assert.ok(!/AvailableSlots\([^)]*\b4\b/.test(route), 'no hard-coded 4-week horizon left in the route');
});

// ─── the page ────────────────────────────────────────────────────────────────

test('booking page: day blocks are grouped under month headings, in order, per duration; script still parses', () => {
  const sets = [
    { durationMin: 30, feeCents: 20000, default: true, slots: [slot('2026-10-05', '10:00'), slot('2026-10-27', '11:00'), slot('2026-11-03', '10:00'), slot('2026-12-15', '13:00')] },
    { durationMin: 45, feeCents: 30000, slots: [slot('2026-11-10', '14:00'), slot('2026-12-01', '14:00')] },
  ];
  const html = phase2.buildBookingPageHtml({ id: '1', tier: 'T2' }, { sets, weeksAhead: 12 }, 'tok', { name: 'Shafoli Kapur' });
  const months = [...html.matchAll(/<div class="month-label">([^<]+)<\/div>/g)].map((m) => m[1]);
  assert.deepEqual(months, ['October 2026', 'November 2026', 'December 2026', 'November 2026', 'December 2026']);
  // the day blocks sit INSIDE their month
  const oct = html.slice(html.indexOf('October 2026'), html.indexOf('November 2026'));
  assert.match(oct, /Monday, Oct 5/); assert.match(oct, /Tuesday, Oct 27/);
  assert.ok(!/Nov/.test(oct), 'no November day under the October heading');
  assert.match(html, /\.month-label\{[^}]*position:sticky/, 'month heading is sticky for the long phone scroll');
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]); // throws on syntax error
});

test('booking page: the empty state says the configured span', () => {
  const sets = [{ durationMin: 30, feeCents: 20000, default: true, slots: [] }, { durationMin: 45, feeCents: 30000, slots: [] }];
  const html = phase2.buildBookingPageHtml({ id: '1' }, { sets, weeksAhead: 12 }, 'tok', { name: 'X' });
  assert.equal((html.match(/No open times in the next 12 weeks — we will reach out to schedule\./g) || []).length, 2, 'one empty state per duration list');
  const eight = phase2.buildBookingPageHtml({ id: '1' }, { sets: [sets[0]], weeksAhead: 8 }, 'tok', { name: 'X' });
  assert.match(eight, /No open times in the next 8 weeks/);
  // legacy plain-array callers fall back to the env span
  const legacy = withEnv('10', () => phase2.buildBookingPageHtml({ id: '1' }, [], 'tok', { name: 'X' }));
  assert.match(legacy, /No open times in the next 10 weeks/);
  assert.ok(!/next few weeks/.test(legacy), 'the vague copy is gone');
});

test('the Square client never hangs the booking page: every call carries a timeout', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/squareBookingsService.js'), 'utf8');
  assert.match(src, /const SQUARE_TIMEOUT_MS = 20000;/);
  for (const verb of ['post', 'get', 'put']) {
    assert.match(src, new RegExp('axios\\.' + verb + '\\([^\\n]*timeout: SQUARE_TIMEOUT_MS'), verb + ' carries the timeout');
  }
});
