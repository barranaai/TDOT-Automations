// One-off: move Aksh Patel's Square appointment (ep7hu43pewbscn, Sept 14
// 4:00pm) from Shafoli's calendar to Shermin's — the staff member the lead
// was pinned to. Service, time, and payment stay untouched. Square notifies
// the client per the seller's notification settings (same as a manual edit).
const sq = require('../src/services/squareBookingsService');
const routing = require('../config/consultantRouting');
(async () => {
  const id = 'ep7hu43pewbscn';
  const before = await sq.retrieveBooking(id);
  if (!before) { console.log('Booking not found — may have been fixed/cancelled already.'); return; }
  const seg = before.appointment_segments[0];
  const shermin = Object.values(routing.CONSULTANTS).find((c) => /shermin/i.test(c.name));
  console.log(`BEFORE: staff=${seg.team_member_id} start=${before.start_at} status=${before.status}`);
  if (seg.team_member_id === shermin.teamMemberId) { console.log('Already on Shermin — nothing to do.'); return; }
  const r = await sq.updateBookingTeamMember(id, shermin.teamMemberId);
  console.log('update:', JSON.stringify(r));
  const after = await sq.retrieveBooking(id);
  console.log(`AFTER: staff=${after.appointment_segments[0].team_member_id} (Shermin=${shermin.teamMemberId})`);
})().catch((e) => { console.error('FAILED:', e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message); process.exit(1); });
