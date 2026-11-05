'use strict';

// The Leads list tabs by stage (Faran 2026-11-05: "keep two reminders, booking in progress under invite sent,
// open on New"): New · Invite sent · 1st reminder · 2nd reminder · Expired · All.
// leadStatusService.leadPhase reads the SAME invite facts as the Current status; the tab is the latest invite
// step, exactly as the status picks it, minus remarks and Outcomes. Checked case by case and on generated leads.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const LS = require('../src/services/leadStatusService');
const { listCore } = require('../src/routes/listFilters');

const DAY = 24 * 3600 * 1000, HOUR = 3600 * 1000;
const T0 = Date.parse('2026-10-20T14:00:00Z');   // the first invite
const lead = (o) => Object.assign({ id: '1', bookingStatus: 'Not Yet', bookingInvite: '', inviteSentAt: '' }, o || {});
const act = (o) => Object.assign({ invites: [], rem: { 1: { claims: [], fails: [], copies: [] }, 2: { claims: [], fails: [], copies: [] } }, remark: null }, o || {});
const invited = (o) => lead(Object.assign({ bookingInvite: 'Sent', inviteSentAt: '2026-10-20' }, o || {}));
const rem = (r1, r2) => ({ 1: { claims: r1 ? [r1] : [], fails: [], copies: [] }, 2: { claims: r2 ? [r2] : [], fails: [], copies: [] } });

test('New: never invited — also when the invite failed or is still sending', () => {
  assert.equal(LS.leadPhase(lead(), act(), T0), 'new');
  assert.equal(LS.leadPhase(lead({ bookingInvite: 'Failed' }), act(), T0), 'new');
  assert.equal(LS.leadPhase(lead({ bookingInvite: 'Send' }), act(), T0), 'new');
  assert.equal(LS.leadPhase(lead(), null, T0), 'new', 'the notes copy not read yet');
});

test('Invite sent → 1st reminder → 2nd reminder → Expired (7 days after the first invite)', () => {
  const a = act({ invites: [T0] });
  assert.equal(LS.leadPhase(invited(), a, T0 + HOUR), 'invite');
  assert.equal(LS.leadPhase(invited(), act({ invites: [T0], rem: rem(T0 + 2 * DAY) }), T0 + 3 * DAY), 'reminder1');
  assert.equal(LS.leadPhase(invited(), act({ invites: [T0], rem: rem(T0 + 2 * DAY, T0 + 5 * DAY) }), T0 + 6 * DAY), 'reminder2');
  assert.equal(LS.leadPhase(invited(), act({ invites: [T0], rem: rem(T0 + 2 * DAY, T0 + 5 * DAY) }), T0 + 7 * DAY + HOUR), 'expired');
  assert.equal(LS.leadPhase(invited(), a, T0 + 8 * DAY), 'expired', 'expired even with no reminder on file');
  // a failed reminder does not count
  assert.equal(LS.leadPhase(invited(), act({ invites: [T0], rem: { 1: { claims: [T0 + 2 * DAY], fails: [T0 + 2 * DAY + 1], copies: [] }, 2: { claims: [], fails: [], copies: [] } } }), T0 + 3 * DAY), 'invite');
  // a copy note (sent from the person's other row) counts
  assert.equal(LS.leadPhase(invited(), act({ invites: [T0], rem: { 1: { claims: [], fails: [], copies: [T0 + 2 * DAY] }, 2: { claims: [], fails: [], copies: [] } } }), T0 + 3 * DAY), 'reminder1');
  // the old invite pair's reminders do not count after a fresh invite (a resend 7+ days later)
  const T1 = T0 + 8 * DAY;
  assert.equal(LS.leadPhase(invited({ inviteSentAt: '2026-10-28' }), act({ invites: [T0, T1], rem: rem(T0 + 2 * DAY, T0 + 5 * DAY) }), T1 + HOUR), 'invite');
});

test('Faran 2026-11-05: booking in progress sits under Invite sent — so do a booking not finished, paid / fee recorded with no time, and booked by hand', () => {
  const a = act({ invites: [T0], rem: rem(T0 + 2 * DAY) });
  assert.equal(LS.leadPhase(invited({ bookingStatus: 'Slot Held', slotHeldUntil: new Date(T0 + 3 * DAY + HOUR).toISOString() }), a, T0 + 3 * DAY), 'invite', 'a live hold');
  assert.equal(LS.leadPhase(invited({ bookingStatus: 'Slot Held', slotHeldUntil: new Date(T0 + 20 * DAY).toISOString() }), act({ invites: [T0] }), T0 + 10 * DAY), 'invite', 'a live hold is never Expired');
  assert.equal(LS.leadPhase(invited({ bookingStatus: 'Abandoned', slotHeldUntil: new Date(T0 + 3 * DAY).toISOString() }), a, T0 + 4 * DAY), 'invite', 'booking not finished after the 1st reminder');
  assert.equal(LS.leadPhase(lead({ bookingStatus: 'Abandoned', slotHeldUntil: new Date(T0).toISOString() }), act(), T0 + DAY), 'invite', 'booking not finished is never New');
  assert.equal(LS.leadPhase(invited({ squareConsultTxnId: 'sq_1' }), act({ invites: [T0] }), T0 + 10 * DAY), 'invite', 'paid, no time yet — never Expired');
  assert.equal(LS.leadPhase(lead({ consultPayment: JSON.stringify({ kind: 'waived' }) }), act(), T0), 'invite', 'fee waived, no time yet');
  assert.equal(LS.leadPhase(lead({ bookedSlot: '2026-11-10 10:00' }), act(), T0), 'invite', 'booked by hand');
  // a reminder AFTER the unfinished booking moves it on, as the Current status does
  assert.equal(LS.leadPhase(invited({ bookingStatus: 'Abandoned', slotHeldUntil: new Date(T0 + DAY).toISOString() }), act({ invites: [T0], rem: rem(T0 + 2 * DAY) }), T0 + 3 * DAY), 'reminder1');
});

test('two steps at the same moment: the tab breaks the tie exactly as the Current status does', () => {
  const tie = T0 + 2 * DAY;
  const l = invited({ bookingStatus: 'Abandoned', slotHeldUntil: new Date(tie).toISOString() });
  const a = act({ invites: [T0], rem: rem(tie) });
  assert.equal(LS.leadStatus(l, a, T0 + 3 * DAY).key, 'abandoned');
  assert.equal(LS.leadPhase(l, a, T0 + 3 * DAY), 'invite');
});

test('review: "Sent" with no date and no invite note (an invite from before the date stamp, or set by hand) is never New — Invite sent, then Expired once the lead is 7 days old; the Current status agrees', () => {
  const old = invited({ inviteSentAt: '', createdAt: '2026-06-20T15:00:00Z' });
  assert.equal(LS.leadPhase(old, null, T0), 'expired');
  assert.equal(LS.leadStatus(old, null, T0).key, 'expired');
  assert.equal(LS.leadPhase(old, act(), T0), 'expired', 'the notes copy has nothing for it');
  const young = invited({ inviteSentAt: '', createdAt: new Date(T0 - 2 * DAY).toISOString() });
  assert.equal(LS.leadPhase(young, null, T0), 'invite');
  assert.equal(LS.leadStatus(young, null, T0).key, 'invite');
  assert.equal(LS.leadStatus(young, null, T0).at, 0, 'no date shown for an invite whose time is unknown');
  assert.equal(LS.leadPhase(invited({ inviteSentAt: '' }), null, T0), 'expired', 'no creation time either: an old row');
  assert.equal(LS.leadPhase(lead({ bookingInvite: 'Failed', inviteSentAt: '' }), null, T0), 'new', 'a failed invite is still New');
});

test('a remark or an Outcome never moves a lead between tabs', () => {
  const a = act({ invites: [T0], rem: rem(T0 + 2 * DAY), remark: { label: 'No answer / voicemail', at: T0 + 2 * DAY + HOUR, by: 'Gauri' } });
  assert.equal(LS.leadStatus(invited(), a, T0 + 3 * DAY).key, 'remark', 'the status shows the remark');
  assert.equal(LS.leadPhase(invited(), a, T0 + 3 * DAY), 'reminder1', 'the tab stays 1st reminder');
  assert.equal(LS.leadPhase(invited({ outcome: 'Not Wanted' }), act({ invites: [T0] }), T0 + DAY), 'invite');
  assert.equal(LS.leadPhase(lead({ outcome: 'Newsletter' }), act(), T0), 'new');
});

test('on generated leads the tab ALWAYS matches the Current status rule (without remarks and Outcomes) — every lead in exactly one tab', () => {
  let x = 42; const r = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const pick = (l) => l[Math.floor(r() * l.length)];
  const MAP = { new: 'new', 'invite-failed': 'new', 'invite-sending': 'new', invite: 'invite', abandoned: 'invite', holding: 'invite', paid: 'invite', booked: 'invite',
    reminder1: 'reminder1', reminder2: 'reminder2', expired: 'expired' };
  const seen = {};
  for (let i = 0; i < 4000; i++) {
    const now = T0 + Math.floor(r() * 14 * DAY);
    const inv = r() < 0.75;
    const invTimes = inv && r() < 0.85 ? [T0 + Math.floor(r() * 2 * DAY)].concat(r() < 0.15 ? [T0 + 8 * DAY] : []) : [];
    const rr = () => (r() < 0.4 ? [T0 + Math.floor(r() * 9 * DAY)] : []);
    const l = lead({
      bookingInvite: inv ? 'Sent' : pick(['', 'Failed', 'Send']), inviteSentAt: inv ? pick(['2026-10-20', '2026-10-21', '']) : '',
      bookingStatus: pick(['Not Yet', 'Not Yet', 'Not Yet', 'Slot Held', 'Abandoned']), slotHeldUntil: new Date(T0 + Math.floor(r() * 12 * DAY)).toISOString(),
      squareConsultTxnId: r() < 0.05 ? 'sq' : '', consultPayment: r() < 0.04 ? '{"kind":"cash"}' : '', bookedSlot: r() < 0.04 ? '2026-11-01 10:00' : '',
      outcome: r() < 0.15 ? pick(['Follow-Up', 'Newsletter', 'Not Wanted']) : '', outcomeChangedAt: new Date(T0).toISOString(),
    });
    const a = r() < 0.9 ? act({ invites: invTimes, rem: { 1: { claims: rr(), fails: r() < 0.2 ? rr() : [], copies: r() < 0.1 ? rr() : [] }, 2: { claims: rr(), fails: [], copies: [] } },
      remark: r() < 0.3 ? { label: 'Called', at: T0 + Math.floor(r() * 10 * DAY), by: 'X' } : null }) : null;
    const phase = LS.leadPhase(l, a, now);
    const bare = Object.assign({}, l, { outcome: '' });
    const status = LS.leadStatus(bare, a ? Object.assign({}, a, { remark: null }) : a, now);
    assert.ok(LS.PHASES.includes(phase), phase);
    assert.equal(phase, MAP[status.key], JSON.stringify({ i, status: status.key, phase }));
    seen[phase] = (seen[phase] || 0) + 1;
  }
  assert.deepEqual(Object.keys(seen).sort(), ['expired', 'invite', 'new', 'reminder1', 'reminder2'], 'every tab was reached');
});

test('the list: tabs New · Invite sent · 1st reminder · 2nd reminder · Expired · All; one at a time; a new browser tab opens on New; the choice (All too) is kept for the tab', () => {
  const { leadsTableCore, leadsTableOpts, leadsTableScript } = require('../src/routes/leadsTableFilters');
  const LT = leadsTableCore();
  const rows = ['new', 'new', 'invite', 'reminder1', 'reminder2', 'expired', 'expired'].map((phase, i) => ({ id: String(i), name: 'P' + i, phase }));
  const st = LT.emptyState();
  st.sel.phase = ['expired'];
  assert.deepEqual(LT.filterRows(rows, st).map((x) => x.id), ['5', '6']);
  assert.deepEqual(LT.facetCounts(rows, LT.emptyState(), 'phase').map((o) => [o.label, o.count]),
    [['New', 2], ['Invite sent', 1], ['1st reminder', 1], ['2nd reminder', 1], ['Expired', 2]]);
  assert.deepEqual(LT.chips(st), [], 'the tab is not a chip — the tab itself shows it');
  assert.deepEqual(LT.clearAll(st).sel, { phase: ['expired'] }, 'Clear filters keeps the tab');
  assert.equal(LT.normalizeState({ sel: { phase: ['gone'] } }).sel.phase, undefined, 'an unknown saved tab is dropped');
  const q = leadsTableOpts().quick;
  assert.deepEqual([q.facet, q.box, q.tabs, q.allLast, q.default, q.storeKey], ['phase', 'q-phase', true, true, 'new', 'tdot_list_leads_tab']);
  assert.deepEqual(q.values, ['new', 'invite', 'reminder1', 'reminder2', 'expired']);
  assert.ok(q.storeKey.indexOf('tdot_list_') === 0, 'Sign Out forgets it');
  new vm.Script(leadsTableScript());
  const html = require('../src/routes/adminLeads').buildLeadsQueueHTML();
  assert.ok(html.includes('<div class="lt-tabs" id="q-phase" role="tablist" aria-label="Leads by stage"></div>'));
  assert.ok(html.indexOf('id="q-phase"') < html.indexOf('id="qbody"'), 'the tabs sit above the table');
  assert.ok(html.includes("msg=(h.without('phase')===ALLROWS.length)?('No leads in “'+tl+'” right now.'):('No leads in “'+tl+'” match your filters.');"), 'an empty tab says which tab, and whether the filters hide them');
  const svc = require('fs').readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.ok(svc.includes("phase:         require('./leadStatusService').leadPhase(l, require('./leadStatusService').activityFor(l.id), Date.now()),"), 'every Leads row carries its stage');
});
