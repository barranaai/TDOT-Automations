'use strict';

// Deleting a consultation must also free its slot on the real Square calendar
// (user directive 2026-08-05). The booking id lives ONLY on the lead row, so
// the cancel must happen before the row goes — and a cancel failure must keep
// the row so the id survives for a re-run.

const test   = require('node:test');
const assert = require('node:assert/strict');

const sq          = require('../src/services/squareBookingsService');
const deletion    = require('../src/services/deletionService');
const mondayApi   = require('../src/services/mondayApi');
const leadService = require('../src/services/leadService');
const oneDrive    = require('../src/services/oneDriveService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const NOW    = Date.parse('2026-08-05T12:00:00Z');
const FUTURE = '2026-08-20T15:00:00Z';
const PAST   = '2026-07-01T15:00:00Z';

/* ── classifyBookingForCancel: what still occupies the calendar ─────────── */

test('a live future booking is cancelled — ACCEPTED and PENDING alike', () => {
  assert.equal(sq.classifyBookingForCancel({ status: 'ACCEPTED', start_at: FUTURE }, NOW).act, 'cancel');
  assert.equal(sq.classifyBookingForCancel({ status: 'PENDING',  start_at: FUTURE }, NOW).act, 'cancel');
});

test('terminal bookings are left alone — nothing left to free', () => {
  for (const status of ['CANCELLED_BY_BUYER', 'CANCELLED_BY_SELLER', 'DECLINED', 'NO_SHOW']) {
    const v = sq.classifyBookingForCancel({ status, start_at: FUTURE }, NOW);
    assert.equal(v.act, 'skip', `${status} is terminal`);
  }
});

test('a booking whose time has passed is left alone — the slot was consumed', () => {
  assert.equal(sq.classifyBookingForCancel({ status: 'ACCEPTED', start_at: PAST }, NOW).act, 'skip');
});

test('an UNKNOWN future status errs toward cancelling, not silently skipping', () => {
  // Skipping an unrecognized status would leave the slot occupied — the exact
  // hole this feature closes. Worst case Square refuses and the failure shows.
  assert.equal(sq.classifyBookingForCancel({ status: 'SOME_NEW_STATUS', start_at: FUTURE }, NOW).act, 'cancel');
  assert.equal(sq.classifyBookingForCancel({ start_at: FUTURE }, NOW).act, 'cancel');
  assert.equal(sq.classifyBookingForCancel({ status: 'ACCEPTED' }, NOW).act, 'cancel', 'no start_at ⇒ cannot prove it is past');
});

/* ── the deletion cascade ──────────────────────────────────────────────── */

// Minimal Monday stub for a plain-lead graph: board pin + no CM link.
const LEAD_BOARD = require('../config/monday').leadBoardId;
function leadDeleteStubs({ bookingId = 'BKG-1', failCancel = false, cancelResult } = {}) {
  const calls = { cancelled: [], deletedRows: [] };
  const restores = [
    stub(mondayApi, 'query', async (q, vars) => {
      if (/delete_item/.test(q)) {
        const ids = vars && vars.id ? [String(vars.id)] : [...q.matchAll(/delete_item\(item_id:\s*(\d+)\)/g)].map((m) => m[1]);
        calls.deletedRows.push(...ids);
        return vars && vars.id ? { delete_item: { id: vars.id } } : {};
      }
      if (/items\(ids/.test(q)) return { items: [{ id: String(vars.id), board: { id: LEAD_BOARD } }] };
      return {};
    }),
    stub(leadService, 'getLead', async (id) => ({
      id: String(id), fullName: 'Booked Client', email: 'x@y.z',
      clientMasterItemId: '', oneDriveFolderId: '', squareBookingId: bookingId, bookedSlot: '2026-08-20 11:00',
    })),
    stub(oneDrive, 'getDriveItemById', async () => null),
    // resolveFolders falls back to a by-name lookup — leave it unstubbed and
    // every test run makes a REAL Graph token request + folder search.
    stub(oneDrive, 'getClientFolderByName', async () => null),
    stub(oneDrive, 'deleteDriveItem', async () => {}),
    stub(sq, 'cancelBookingIfActive', async (id) => {
      if (failCancel) throw new Error('square is down');
      calls.cancelled.push(id);
      return cancelResult || { cancelled: true, reason: 'cancelled' };
    }),
  ];
  return { calls, restore: () => restores.forEach((r) => r()) };
}

test('deleting a booked consultation cancels its Square appointment, then the row', async () => {
  const { calls, restore } = leadDeleteStubs({});
  try {
    const out = await deletion.executeDeletion({ leadId: '701', confirmText: 'DELETE', expectedKind: 'lead' });
    assert.equal(out.ok, true);
    assert.deepEqual(calls.cancelled, ['BKG-1']);
    assert.equal(out.deleted.squareAppointmentsCancelled, 1);
    assert.ok(calls.deletedRows.includes('701'), 'the lead row still goes');
  } finally { restore(); }
});

test('a cancel FAILURE keeps the lead row — the booking id must survive for the re-run', async () => {
  const { calls, restore } = leadDeleteStubs({ failCancel: true });
  try {
    const out = await deletion.executeDeletion({ leadId: '702', confirmText: 'DELETE', expectedKind: 'lead' });
    assert.equal(out.ok, false);
    assert.ok(out.failures.some((f) => /square appointment/i.test(f)), 'the failure names the appointment');
    assert.deepEqual(calls.deletedRows, [], 'NO row may be deleted — the id lives on the lead');
  } finally { restore(); }
});

test('an already-cancelled / past booking is a no-op and the delete proceeds', async () => {
  const { calls, restore } = leadDeleteStubs({ cancelResult: { cancelled: false, reason: 'already cancelled by seller' } });
  try {
    const out = await deletion.executeDeletion({ leadId: '703', confirmText: 'DELETE', expectedKind: 'lead' });
    assert.equal(out.ok, true);
    assert.equal(out.deleted.squareAppointmentsCancelled, 0, 'nothing was freed, honestly reported');
    assert.ok(calls.deletedRows.includes('703'), 'the delete still completes');
  } finally { restore(); }
});

test('a lead with no Square booking never touches Square', async () => {
  const { calls, restore } = leadDeleteStubs({ bookingId: '' });
  try {
    const out = await deletion.executeDeletion({ leadId: '704', confirmText: 'DELETE', expectedKind: 'lead' });
    assert.equal(out.ok, true);
    assert.deepEqual(calls.cancelled, []);
  } finally { restore(); }
});

test('the preview names the appointment so the admin sees it BEFORE confirming', async () => {
  const { restore } = leadDeleteStubs({});
  try {
    const p = await deletion.previewDeletion({ leadId: '705' });
    assert.deepEqual(p.targets.squareAppointments, ['Booked Client — 2026-08-20 11:00']);
    assert.ok(p.warnings.some((w) => /square consultation appointment is cancelled/i.test(w)));
  } finally { restore(); }
});

test('the delete modal renders the Square appointment line', () => {
  // The modal lists exactly what will be removed; a slot cancellation is an
  // outward-facing effect and must be visible before the admin types DELETE.
  const src = require('fs').readFileSync(require.resolve('../src/routes/adminShared'), 'utf8');
  assert.match(src, /squareAppointments/, 'modal reads the new preview field');
  assert.match(src, /Square appointment \(will be cancelled\)/, 'the preview promises, it does not claim');
  assert.match(src, /squareAppointmentsCancelled/, 'the RESULT reports what actually happened');
  assert.match(src, /NOT cancelled/, 'including the honest nothing-was-freed case');
});

test('a Square failure surfaces Square’s own error detail, not the axios generic', () => {
  // "Request failed with status code 400" cannot tell an expired token from a
  // version race — and which one it is decides whether a retry can ever work.
  assert.equal(
    sq.squareErrorText({ message: 'Request failed with status code 400',
      response: { data: { errors: [{ code: 'VERSION_MISMATCH', detail: 'The booking was changed.' }] } } }),
    'VERSION_MISMATCH: The booking was changed.');
  assert.equal(sq.squareErrorText({ message: 'socket hang up' }), 'socket hang up');
  const src = require('fs').readFileSync(require.resolve('../src/services/deletionService'), 'utf8');
  assert.match(src, /squareErrorText/, 'deletion failures carry the Square detail');
});
