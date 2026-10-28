'use strict';

// The Leads list's "Current status" (Faran 2026-10-28): where the lead is WITH
// US — the Outcome, booked, paid, booking in progress, else the latest of invite
// sent / 1st reminder / 2nd reminder / a remark / booking not finished / expired.
// The notes come from a board-wide copy (no network here: io stubs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const LS = require('../src/services/leadStatusService');
const BR = require('../src/services/bookingRemindersService');

const HOUR = 3600e3, DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-20T15:00:00Z');       // 11:00 Toronto — the first invite
const act = () => ({ invites: [], rem: { 1: { claims: [], fails: [], copies: [] }, 2: { claims: [], fails: [], copies: [] } }, remark: null });
const lead = (o = {}) => ({ id: '1', bookingInvite: 'Sent', inviteSentAt: '2026-10-20', bookingStatus: 'Not Yet', ...o });

test('what a note says: invite, reminder claim / failure / copy, a remark preset or free text, anything else', () => {
  assert.deepEqual(LS.classify('📧 Booking invite emailed to a@b.c on 2026-10-20.'), { kind: 'invite' });
  assert.deepEqual(LS.classify('⚠️ Booking invite email WAS DELIVERED to the client, but…'), { kind: 'invite' });
  assert.deepEqual(LS.classify(`⏰ ${BR.claimText(1)} to a@b.c — 48 hours after`), { kind: 'claim', n: 1 });
  assert.deepEqual(LS.classify(`⚠️ ${BR.failText(2)} — the email could not be sent`), { kind: 'fail', n: 2 });
  assert.deepEqual(LS.classify(`⏰ ${BR.copyText(1)} 123 to a@b.c`), { kind: 'copy', n: 1 });
  assert.deepEqual(LS.classify('📝 [Remark · Gauri] No answer / voicemail — tried twice'), { kind: 'remark', label: 'No answer / voicemail', by: 'Gauri', text: 'No answer / voicemail — tried twice' });
  assert.deepEqual(LS.classify('📝 [Remark] Client to revert'), { kind: 'remark', label: 'Client to revert', by: '', text: 'Client to revert' });
  assert.equal(LS.classify('📝 [Remark · Asmita] Spoke to the husband about the documents needed for the file').label, 'Remark: Spoke to the husband about the document…');
  assert.deepEqual(LS.classify('Booking invite triggered from the portal'), { kind: '' });
  assert.deepEqual(LS.classify('📧 Booking invite email FAILED to send'), { kind: '' });
});

test('the Outcome always wins; then booked (also by hand), paid / recorded / waived, a held time', () => {
  const a = act(); a.invites.push(T0); a.rem[1].claims.push(T0 + 48 * HOUR);
  const now = T0 + 3 * DAY;
  assert.deepEqual(LS.leadStatus(lead({ outcome: 'Follow-Up', outcomeChangedAt: '2026-10-22T14:00:00Z' }), a, now),
    { key: 'outcome', label: 'Outcome: Follow-Up', at: Date.parse('2026-10-22T14:00:00Z'), tone: 'amber' });
  assert.equal(LS.leadStatus(lead({ outcome: 'Don’t Retain — Not Wanted' }), a, now).label, 'Outcome: Not Wanted', 'old labels read as today\'s');
  assert.equal(LS.leadStatus(lead({ bookingStatus: 'Booked', bookedSlot: '2026-10-30 10:00' }), a, now).slot, '2026-10-30 10:00');
  for (const o of [{ bookedSlot: '2026-10-30 10:00' }, { consultationHeld: '2026-10-21' }, { meetingLink: 'https://x' }, { squareBookingId: 'b' }, { consultAgreementSent: '2026-10-21' }, { preConsultSubmitted: 'Yes' }]) {
    assert.equal(LS.leadStatus(lead(o), a, now).key, 'booked', JSON.stringify(o));
  }
  assert.equal(LS.leadStatus(lead({ bookingStatus: 'Abandoned', bookedSlot: '2026-10-30 10:00' }), a, now).key !== 'booked', true, 'a hold that ran out is not a booking');
  assert.equal(LS.leadStatus(lead({ squareConsultTxnId: 't' }), a, now).label, 'Paid — no time booked yet');
  assert.equal(LS.leadStatus(lead({ consultPayment: '{"kind":"waived"}' }), a, now).label, 'Fee waived — no time booked yet');
  assert.equal(LS.leadStatus(lead({ consultPayment: '{"kind":"cash"}' }), a, now).label, 'Fee recorded — no time booked yet');
  assert.equal(LS.leadStatus(lead({ bookingStatus: 'Slot Held', slotHeldUntil: new Date(now + HOUR).toISOString() }), a, now).label, 'Booking in progress');
});

test('otherwise the LATEST thing: invite → 1st reminder → a remark → 2nd reminder → expired → a later remark', () => {
  const a = act(); a.invites.push(T0);
  const st = (now) => LS.leadStatus(lead(), a, now);
  assert.deepEqual(st(T0 + HOUR), { key: 'invite', label: 'Invite sent', at: T0, tone: 'blue' });
  a.rem[1].claims.push(T0 + 48 * HOUR);
  assert.equal(st(T0 + 49 * HOUR).label, '1st reminder sent');
  assert.equal(st(T0 + 49 * HOUR).at, T0 + 48 * HOUR);
  a.remark = { label: 'No answer / voicemail', by: 'Gauri', at: T0 + 70 * HOUR, text: 'No answer / voicemail — tried twice' };
  assert.equal(st(T0 + 71 * HOUR).label, 'No answer / voicemail');
  assert.equal(st(T0 + 71 * HOUR).detail, 'No answer / voicemail — tried twice', 'the full text for the hover');
  assert.equal(st(T0 + 71 * HOUR).by, 'Gauri');
  a.rem[2].claims.push(T0 + 120 * HOUR);
  assert.equal(st(T0 + 121 * HOUR).label, '2nd reminder sent');
  assert.equal(st(T0 + 7 * DAY - HOUR).label, '2nd reminder sent');
  assert.deepEqual(st(T0 + 7 * DAY), { key: 'expired', label: 'Expired', at: T0 + 7 * DAY, tone: 'red' });
  a.remark = { label: 'Client to revert', by: '', at: T0 + 9 * DAY };
  assert.equal(st(T0 + 10 * DAY).label, 'Client to revert');
});

test('a reminder that failed is not "sent"; a copy on this row (sent from the person\'s other row) is', () => {
  const a = act(); a.invites.push(T0);
  a.rem[1].claims.push(T0 + 48 * HOUR); a.rem[1].fails.push(T0 + 48 * HOUR + 1000);
  assert.equal(LS.leadStatus(lead(), a, T0 + 50 * HOUR).label, 'Invite sent');
  const b = act(); b.invites.push(T0); b.rem[1].copies.push(T0 + 48 * HOUR);
  assert.equal(LS.leadStatus(lead(), b, T0 + 50 * HOUR).label, '1st reminder sent');
});

test('a fresh invite after the old pair: old reminders do not count, the 7 days start again', () => {
  const a = act(); a.invites.push(T0 - 20 * DAY, T0); a.rem[2].claims.push(T0 - 15 * DAY);
  assert.equal(LS.leadStatus(lead(), a, T0 + 2 * HOUR).label, 'Invite sent');
  assert.equal(LS.leadStatus(lead(), a, T0 + 6 * DAY).label, 'Invite sent', 'not expired: 7 days from the NEW invite');
  // the new pair's reminder 1 failed: the OLD pair's sent reminder 1 must not make it look sent
  const c = act(); c.invites.push(T0 - 20 * DAY, T0); c.rem[1].claims.push(T0 - 18 * DAY, T0 + 48 * HOUR); c.rem[1].fails.push(T0 + 48 * HOUR + 1000);
  assert.equal(LS.leadStatus(lead(), c, T0 + 50 * HOUR).label, 'Invite sent');
  // a resend INSIDE the pair keeps the first invite's clock
  const b = act(); b.invites.push(T0, T0 + 3 * DAY);
  assert.equal(LS.leadStatus(lead(), b, T0 + 7 * DAY).label, 'Expired');
});

test('no notes copy yet (or nothing in it): the lead\'s own columns', () => {
  assert.deepEqual(LS.leadStatus(lead({ inviteSentAt: '2026-10-20' }), null, T0 + DAY),
    { key: 'invite', label: 'Invite sent', at: Date.parse('2026-10-20T13:00:00Z'), tone: 'blue' }, '09:00 Toronto on the invite day');
  assert.equal(LS.leadStatus(lead({ inviteSentAt: '2026-10-01' }), null, T0).label, 'Expired');
  assert.equal(LS.leadStatus(lead({ bookingInvite: 'Failed', inviteSentAt: '' }), null, T0).label, 'Invite failed');
  assert.equal(LS.leadStatus(lead({ bookingInvite: 'Send', inviteSentAt: '' }), null, T0).label, 'Invite sending');
  assert.deepEqual(LS.leadStatus(lead({ bookingInvite: '', inviteSentAt: '' }), null, T0), { key: 'new', label: 'New', at: null, tone: 'grey' });
  assert.equal(LS.leadStatus(lead({ bookingStatus: 'Abandoned', slotHeldUntil: '2026-10-21T15:00:00Z' }), null, T0 + 2 * DAY).label, 'Booking not finished');
  const r = act(); r.remark = { label: 'Fees quoted', by: 'Kamal', at: T0 };
  assert.equal(LS.leadStatus(lead({ bookingInvite: '', inviteSentAt: '' }), r, T0 + DAY).label, 'Fees quoted', 'a remark on a lead never invited');
});

test('the notes copy: back to the horizon at first, then only the new notes; a failed read keeps the copy; the app\'s own writes show at once', async () => {
  LS._reset();
  const now = T0 + 10 * DAY;
  let notes = [];
  for (let i = 0; i < 250; i++) notes.push({ id: String(1000 - i), item_id: String(1 + (i % 7)), created_at: new Date(now - i * HOUR).toISOString(), text_body: i === 5 ? '📝 [Remark · Diksha] Fees quoted' : (i === 3 ? '📧 Booking invite emailed to x@y.z on d.' : 'other') });
  notes.push({ id: '1', item_id: '9', created_at: new Date(now - 60 * DAY).toISOString(), text_body: '📝 [Remark] Client to revert' });
  const pages = [];
  LS.io.now = () => now;
  LS.io.fetchPage = async (p) => { pages.push(p); return notes.slice((p - 1) * 100, p * 100); };
  const r = await LS.refresh();
  assert.ok(r.ok && r.full);
  assert.equal(LS.activityFor('6').remark.label, 'Fees quoted');
  assert.equal(LS.activityFor('4').invites.length, 1);
  assert.equal(LS.activityFor('9'), null, 'older than the horizon is left out');
  // the next read: only until a note already seen
  notes = [{ id: '1001', item_id: '2', created_at: new Date(now + 1000).toISOString(), text_body: '📝 [Remark] Client to revert' }, ...notes];
  pages.length = 0;
  const r2 = await LS.refresh();
  assert.equal(r2.full, false); assert.deepEqual(pages, [1]);
  assert.equal(LS.activityFor('2').remark.label, 'Client to revert');
  // a read that fails: the copy stays
  LS.io.fetchPage = async () => { throw new Error('Monday down'); };
  LS.io.warn = () => {};
  const r3 = await LS.refresh();
  assert.equal(r3.ok, false);
  assert.equal(LS.activityFor('2').remark.label, 'Client to revert');
  // the app's own writes
  LS.record('77', `${BR.claimText(1)} to a@b.c`, now);
  LS.record('77', '📝 [Remark · Kamal] Documents requested', now + 1);
  assert.equal(LS.activityFor('77').rem[1].claims.length, 1);
  assert.equal(LS.activityFor('77').remark.label, 'Documents requested');
  LS._reset();
});

test('wiring: the list rows carry the status; the page shows it; remarks, invites and reminders update it at once; the copy is refreshed every 10 minutes', async () => {
  const snap = require('../src/services/leadSnapshot');
  const portal = require('../src/services/consultantPortalService');
  assert.ok(!snap.SNAPSHOT_KEYS.includes('currentStatus'), 'the immigration status is no longer read for the list');
  snap._reset(); portal.invalidateLeadsQueue();
  const keep = snap.io.fetchLeads;
  snap.io.fetchLeads = async () => [{ id: '1', fullName: 'A', bookingInvite: '', createdAt: '2026-10-10T12:00:00Z' }, { id: '2', fullName: 'B', outcome: 'Newsletter', createdAt: '2026-10-11T12:00:00Z' }];
  try {
    const rows = await portal.getLeadsQueue();
    assert.deepEqual(rows.map((r) => [r.id, r.status.label]), [['2', 'Outcome: Newsletter'], ['1', 'New']]);
  } finally { snap.io.fetchLeads = keep; snap._reset(); portal.invalidateLeadsQueue(); }
  const page = require('../src/routes/adminLeads').buildLeadsQueueHTML();
  assert.ok(page.includes(">Current status</th>") && page.includes("'<td>'+statusCell(c.status)+'</td>'"));
  assert.ok(page.includes(`var tip=st.detail?' title="'+escHtml(st.detail)+'"':'';`), 'the remark\'s full text on hover, escaped');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('src/services/consultantPortalService.js'), /require\('\.\/leadStatusService'\)\.record\(leadId, `📝 \[Remark/);
  assert.match(read('src/services/bookingService.js'), /require\('\.\/leadStatusService'\)\.record\(leadId, 'Booking invite emailed'\)/);
  assert.match(read('src/services/bookingRemindersService.js'), /io\.record\(leadId, claimText\(r\.n\)\);/);
  assert.match(read('src/services/scheduler.js'), /cron\.schedule\('4-59\/10 \* \* \* \*', \(\) => leadStatus\.refresh\(\)\);/);
});
