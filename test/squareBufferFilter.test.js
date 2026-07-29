'use strict';

// Belt-and-braces buffer enforcement on the booking page. A live probe
// (2026-07-29) caught Square's availability search offering slots that overlap
// staff-created ACCEPTED appointments — e.g. a slot at the exact start of an
// existing booking. dropBufferConflicts re-checks every offered slot against
// the real booking list: an existing booking occupies
// [start, start + duration + transition), a new 30-min slot needs its own
// [start, start + 30 + 10) clear.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { dropBufferConflicts } = require('../src/services/bookingService');

const TEAM = 'TM-shafoli';
const slot = (startAt, teamMemberId = TEAM, durationMinutes = 30) => ({ startAt, teamMemberId, durationMinutes, date: startAt.slice(0, 10), time: startAt.slice(11, 16) });
const booking = (start_at, { dur = 30, trans = 10, team = TEAM, status = 'ACCEPTED' } = {}) => ({
  status, start_at, transition_time_minutes: trans,
  appointment_segments: [{ team_member_id: team, duration_minutes: dur }],
});

test('drops a slot at the exact start of an existing booking (the live-found case)', () => {
  const r = dropBufferConflicts(
    [slot('2026-07-30T15:00:00Z')],
    [booking('2026-07-30T15:00:00Z')]);
  assert.equal(r.slots.length, 0);
  assert.equal(r.dropped, 1);
});

test('drops a slot inside the buffer AFTER a booking; keeps the first clear one', () => {
  // booking 10:00–10:30 + 10 min transition → occupied to 10:40
  const bookings = [booking('2026-07-30T10:00:00Z')];
  const inBuffer = dropBufferConflicts([slot('2026-07-30T10:35:00Z')], bookings);
  assert.equal(inBuffer.dropped, 1, '10:35 is inside the 10:30–10:40 buffer');
  const clear = dropBufferConflicts([slot('2026-07-30T10:40:00Z')], bookings);
  assert.equal(clear.dropped, 0, '10:40 starts exactly when the buffer ends');
});

test('drops a slot whose OWN duration+buffer would run into a later booking', () => {
  // slot 09:25 + 30 + 10 → 10:05, collides with a 10:00 booking; 09:20 fits exactly
  const bookings = [booking('2026-07-30T10:00:00Z')];
  assert.equal(dropBufferConflicts([slot('2026-07-30T09:25:00Z')], bookings).dropped, 1);
  assert.equal(dropBufferConflicts([slot('2026-07-30T09:20:00Z')], bookings).dropped, 0);
});

test('a different team member\'s booking does not block the slot', () => {
  const r = dropBufferConflicts(
    [slot('2026-07-30T15:00:00Z', 'TM-shafoli')],
    [booking('2026-07-30T15:00:00Z', { team: 'TM-shermin' })]);
  assert.equal(r.dropped, 0);
});

test('cancelled / declined / no-show bookings do not block', () => {
  for (const status of ['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'DECLINED', 'NO_SHOW']) {
    const r = dropBufferConflicts(
      [slot('2026-07-30T15:00:00Z')],
      [booking('2026-07-30T15:00:00Z', { status })]);
    assert.equal(r.dropped, 0, `${status} must not block`);
  }
});

test('uses each booking\'s own transition time (0-buffer service blocks less)', () => {
  // booking 10:00–10:30 with transition 0 → occupied to 10:30 only
  const bookings = [booking('2026-07-30T10:00:00Z', { trans: 0 })];
  assert.equal(dropBufferConflicts([slot('2026-07-30T10:30:00Z')], bookings).dropped, 0, '10:30 fine when the booking has no buffer');
  assert.equal(dropBufferConflicts([slot('2026-07-30T10:25:00Z')], bookings).dropped, 1);
});

test('no bookings → all slots pass through untouched', () => {
  const slots = [slot('2026-07-30T15:00:00Z'), slot('2026-07-30T16:00:00Z')];
  const r = dropBufferConflicts(slots, []);
  assert.deepEqual(r.slots, slots);
  assert.equal(r.dropped, 0);
});

test('the real July-30 calendar: only genuinely clear slots survive', () => {
  // Reconstruction of the live day that exposed the bug (all times UTC, team Shafoli)
  const bookings = [
    booking('2026-07-30T15:00:00Z'),                 // 15:00–15:30 +10
    booking('2026-07-30T15:40:00Z', { dur: 15 }),    // 15:40–15:55 +10
    booking('2026-07-30T19:15:00Z', { trans: 0 }),   // 19:15–19:45 +0
    booking('2026-07-30T20:00:00Z'),                 // 20:00–20:30 +10
  ];
  // What Square wrongly offered live: 15:00, 19:30, 20:00 — all must be dropped
  const offered = [slot('2026-07-30T15:00:00Z'), slot('2026-07-30T19:30:00Z'), slot('2026-07-30T20:00:00Z')];
  const r = dropBufferConflicts(offered, bookings);
  assert.equal(r.slots.length, 0, 'every wrongly-offered slot is filtered');
  assert.equal(r.dropped, 3);
  // ...while a genuinely clear time on the same day survives
  const ok = dropBufferConflicts([slot('2026-07-30T16:05:00Z')], bookings);
  assert.equal(ok.dropped, 0, '16:05 (after 15:55+10) is genuinely free and stays');
});
