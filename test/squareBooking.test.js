'use strict';

// Square appointment write-back: the pure request-body + phone helpers used when
// we push the paid consult onto the seller's calendar with the client + a
// meeting-type seller note.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildCreateBookingBody, toE164 } = require('../src/services/squareBookingsService');

test('buildCreateBookingBody carries the seller note + appointment segment', () => {
  const body = buildCreateBookingBody({
    customerId: 'C1', serviceVariationId: 'SV1', serviceVariationVersion: 7, teamMemberId: 'TM1',
    startAtIso: '2026-07-06T14:45:00Z', durationMinutes: 30,
    sellerNote: 'In-person consultation — Aarav Sharma (Study permit)', locId: 'L1',
  });
  assert.equal(body.booking.location_id, 'L1');
  assert.equal(body.booking.customer_id, 'C1');
  assert.equal(body.booking.start_at, '2026-07-06T14:45:00Z');
  assert.equal(body.booking.seller_note, 'In-person consultation — Aarav Sharma (Study permit)');
  const seg = body.booking.appointment_segments[0];
  assert.equal(seg.team_member_id, 'TM1');
  assert.equal(seg.service_variation_id, 'SV1');
  assert.equal(seg.service_variation_version, 7);
  assert.equal(seg.duration_minutes, 30);
});

test('buildCreateBookingBody omits seller_note when none is given', () => {
  const body = buildCreateBookingBody({
    customerId: 'C1', serviceVariationId: 'SV1', serviceVariationVersion: 7, teamMemberId: 'TM1',
    startAtIso: '2026-07-06T14:45:00Z', locId: 'L1',
  });
  assert.equal('seller_note' in body.booking, false);
});

test('toE164 normalizes CA/US numbers and rejects junk', () => {
  assert.equal(toE164('+1 416 555 1234'), '+14165551234');
  assert.equal(toE164('4165551234'), '+14165551234');
  assert.equal(toE164('1-416-555-1234'), '+14165551234');
  assert.equal(toE164(''), null);
  assert.equal(toE164('12345'), null);
});
