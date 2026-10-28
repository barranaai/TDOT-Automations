'use strict';

// Booking-invite reminders (Faran 2026-10-28): a lead emailed the booking
// invite who has not booked gets reminder 1 at 48 hours and reminder 2 at 5 days
// after the FIRST invite, with the same personal link — never twice (two app
// instances included), never to someone who booked, paid, has an Outcome, a
// retainer, a case, is archived or on the Not Wanted list, never within a day of
// a resend, never more than a day late. Everything runs against a fake board
// (io stubs) — no network.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const BR = require('../src/services/bookingRemindersService');
const bookingService = require('../src/services/bookingService');

const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-20T15:00:00Z');   // 11:00 Toronto — the first invite
const strip = (h) => String(h).replace(/<[^>]*>/g, '');
const torontoDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

/** A fake Lead Board + notes + mail. */
function world({ now = T0, lead = {}, invites = [T0], blacklist = { checked: true, hit: false } } = {}) {
  let noteSeq = 1000;
  const w = {
    now, emails: [], log: [], deleted: [],
    failSend: 0, failPost: false, blacklist,
    leads: {
      L1: {
        id: 'L1', fullName: 'Asha Rao', email: 'asha@example.com', phone: '4165550101', leadToken: 'tok-1',
        bookingInvite: 'Sent', bookingStatus: 'Not Yet', inviteSentAt: torontoDay(invites[invites.length - 1] || T0),
        country: 'Canada', insideCanada: 'Yes', ...lead,
      },
    },
    notes: { L1: invites.map((at) => ({ id: String(++noteSeq), at, text: `📧 Booking invite emailed to asha@example.com on ${torontoDay(at)}.` })) },
    archived: new Set(),
  };
  w.addNote = (leadId, text, at = w.now) => { const n = { id: String(++noteSeq), at, text: strip(text) }; (w.notes[leadId] = w.notes[leadId] || []).push(n); return n.id; };
  Object.assign(BR.io, {
    now: () => w.now,
    snapshot: async () => Object.values(w.leads).map((l) => ({ ...l, email: undefined, leadToken: undefined })),   // the list carries no emails
    rowsByEmail: async (email) => { w.searches = (w.searches || 0) + 1; if (w.failSearch) throw new Error('search failed');
      return Object.values(w.leads).filter((l) => String(l.email || '').trim().toLowerCase() === email.toLowerCase()).map((l) => ({ ...l })); },   // Monday: letter case ignored, spaces not
    getLead: async (id) => { await new Promise((r) => setImmediate(r)); return w.leads[id] ? { ...w.leads[id] } : null; },
    readNotes: async (id) => {
      await new Promise((r) => setImmediate(r));
      if (w.archived.has(id) || !w.leads[id]) return null;
      return (w.notes[id] || []).slice().reverse().map((n) => ({ ...n }));   // newest first, like Monday
    },
    postNote: async (id, body) => {
      await new Promise((r) => setImmediate(r));
      if (w.failPost) throw new Error('Monday is down');
      w.log.push(`note:${strip(body).slice(0, 40)}`);
      return w.addNote(id, body);
    },
    deleteNote: async (noteId) => { w.deleted.push(noteId); for (const k of Object.keys(w.notes)) w.notes[k] = w.notes[k].filter((n) => n.id !== noteId); },
    blacklistCheck: async () => w.blacklist,
    sendEmail: async (m) => {
      await new Promise((r) => setImmediate(r));
      if (w.failSend > 0) { w.failSend--; throw new Error('Graph said no'); }
      w.log.push(`email:${m.subject}`);
      w.emails.push(m);
    },
    log: () => {}, warn: () => {},
  });
  return w;
}

const at = (w, ms) => { w.now = ms; return BR.runOnce(); };
const claims = (w, n) => (w.notes.L1 || []).filter((x) => x.text.includes(BR.claimText(n)));

test('reminder 1 goes at 48 hours and reminder 2 at 5 days after the first invite — once each', async () => {
  const w = world();
  await at(w, T0 + 47 * HOUR); assert.equal(w.emails.length, 0, 'not before 48 hours');
  await at(w, T0 + 48 * HOUR); assert.equal(w.emails.length, 1);
  assert.match(w.emails[0].subject, /^Reminder: book your consultation/);
  await at(w, T0 + 49 * HOUR); await at(w, T0 + 100 * HOUR); assert.equal(w.emails.length, 1, 'reminder 1 only once');
  await at(w, T0 + 119 * HOUR); assert.equal(w.emails.length, 1, 'not before 5 days');
  await at(w, T0 + 120 * HOUR); assert.equal(w.emails.length, 2);
  assert.match(w.emails[1].subject, /still open/);
  for (let h = 121; h < 400; h += 7) await at(w, T0 + h * HOUR);
  assert.equal(w.emails.length, 2, 'never a third email');
  assert.equal(claims(w, 1).length, 1); assert.equal(claims(w, 2).length, 1);
});

test('the note is posted BEFORE the email (the record), and says how to stop them', async () => {
  const w = world();
  await at(w, T0 + 48 * HOUR);
  assert.deepEqual(w.log.map((x) => x.split(':')[0]), ['note', 'email']);
  const n = claims(w, 1)[0];
  assert.match(n.text, /Booking reminder 1 of 2 emailed to asha@example\.com — 48 hours after the booking invite/);
  assert.match(n.text, /Setting an Outcome on this lead stops the reminders/);
});

test('the email: same personal link as the invite, the client\'s first name escaped, the fee, an "ignore" line', async () => {
  const w = world({ lead: { fullName: 'Bo<i> Li', leadToken: 'tok a&b' } });
  await at(w, T0 + 48 * HOUR);
  const m = w.emails[0];
  assert.equal(m.to, 'asha@example.com');
  assert.ok(m.html.includes(`href="${bookingService.bookingUrl('L1', 'tok a&b')}"`), 'the booking link');
  assert.ok(m.html.includes('/book/L1?t=tok%20a%26b'));
  assert.ok(m.html.includes('Hi Bo&lt;i&gt;,'), 'name escaped');
  assert.ok(!m.html.includes('Bo<i>'));
  assert.ok(m.html.includes(bookingService.inviteFeeLine(w.leads.L1)), 'the same fee sentence as the invite');
  assert.match(m.html, /If you have already booked, or no longer need a consultation, please ignore this email\./);
  assert.match(m.html, /Choose your consultation time/);
});

test('nothing is sent once the lead booked, is paying, paid, has an Outcome, a retainer or a case', async () => {
  const stops = [
    { bookingStatus: 'Booked' },
    { bookingStatus: 'Slot Held', slotHeldUntil: new Date(T0 + 48 * HOUR + 10 * 60 * 1000).toISOString() },
    { squareConsultTxnId: 'txn_1' },
    { consultPayment: '{"kind":"cash"}' },
    { outcome: 'Follow-Up' },
    { outcome: 'Not Wanted' },
    { conversionStatus: 'Retained' },
    { retainerSent: '2026-10-21' },
    { sourceChannel: 'Direct Retainer' },
    { clientMasterItemId: '999' },
    { bookingInvite: 'Failed' },
    { bookingInvite: 'Send' },
    { email: '' },
    { leadToken: '' },
  ];
  for (const lead of stops) {
    const w = world({ lead });
    // the list may be behind: the fresh read decides
    BR.io.snapshot = async () => [{ ...w.leads.L1, email: undefined, bookingStatus: 'Not Yet', squareConsultTxnId: '', consultPayment: '', outcome: '', conversionStatus: '', retainerSent: '', sourceChannel: '', clientMasterItemId: '', bookingInvite: 'Sent' }];
    await at(w, T0 + 48 * HOUR);
    assert.equal(w.emails.length, 0, JSON.stringify(lead));
    assert.equal(claims(w, 1).length, 0, `no note either: ${JSON.stringify(lead)}`);
  }
});

test('a time hold that ran out (or an abandoned booking) does NOT stop the reminder', async () => {
  for (const lead of [{ bookingStatus: 'Slot Held', slotHeldUntil: new Date(T0).toISOString() }, { bookingStatus: 'Abandoned' }]) {
    const w = world({ lead });
    await at(w, T0 + 48 * HOUR);
    assert.equal(w.emails.length, 1, JSON.stringify(lead));
  }
});

test('archived / deleted lead, Not Wanted list, or a Not Wanted list that cannot be read → nothing sent', async () => {
  let w = world(); w.archived.add('L1');
  await at(w, T0 + 48 * HOUR); assert.equal(w.emails.length, 0);
  w = world({ blacklist: { checked: true, hit: true, entries: [{}] } });
  await at(w, T0 + 48 * HOUR); assert.equal(w.emails.length, 0); assert.equal(claims(w, 1).length, 0);
  w = world({ blacklist: { checked: false, hit: false, error: 'board down' } });
  await at(w, T0 + 48 * HOUR); assert.equal(w.emails.length, 0);
  w.blacklist = { checked: true, hit: false };
  await at(w, T0 + 49 * HOUR); assert.equal(w.emails.length, 1, 'tried again on the next run');
});

test('never more than a day late: a missed reminder 1 is skipped, reminder 2 still goes on day 5', async () => {
  const w = world();
  await at(w, T0 + 72 * HOUR);   // the app was down from 47h to 72h
  assert.equal(w.emails.length, 0);
  await at(w, T0 + 120 * HOUR);
  assert.equal(w.emails.length, 1);
  assert.match(w.emails[0].subject, /still open/);
  await at(w, T0 + 145 * HOUR);
  assert.equal(w.emails.length, 1);
});

test('switch-on with old invites: nothing goes to leads invited more than 6 days ago', async () => {
  const w = world({ invites: [T0] });
  await at(w, T0 + 6 * DAY + HOUR);
  assert.equal(w.emails.length, 0);
  const w2 = world({ invites: [T0 - 30 * DAY] });
  await at(w2, T0);
  assert.equal(w2.emails.length, 0);
});

test('a resend: no reminder within a day of it, and the reminders are NOT restarted', async () => {
  // resent at 47h → reminder 1 waits until a day after the resend (71h), still within its day
  let w = world({ invites: [T0, T0 + 47 * HOUR] });
  await at(w, T0 + 48 * HOUR); assert.equal(w.emails.length, 0);
  await at(w, T0 + 70 * HOUR); assert.equal(w.emails.length, 0);
  await at(w, T0 + 71 * HOUR); assert.equal(w.emails.length, 1);
  // resent at 60h → waiting a day would make reminder 1 more than a day late → skipped; reminder 2 on day 5
  w = world({ invites: [T0, T0 + 60 * HOUR] });
  for (const h of [61, 72, 84, 100]) await at(w, T0 + h * HOUR);
  assert.equal(w.emails.length, 0);
  await at(w, T0 + 120 * HOUR); assert.equal(w.emails.length, 1);
  // resent after both reminders → no new reminders
  w = world({ invites: [T0] });
  await at(w, T0 + 48 * HOUR); await at(w, T0 + 120 * HOUR);
  w.addNote('L1', '📧 Booking invite emailed to asha@example.com on later.', T0 + 130 * HOUR);
  w.leads.L1.inviteSentAt = torontoDay(T0 + 130 * HOUR);
  for (const h of [131, 160, 178, 250]) await at(w, T0 + h * HOUR);
  assert.equal(w.emails.length, 2);
});

test('the clock starts at the EARLIEST invite note; the "delivered but not stamped" note counts as an invite', async () => {
  const w = world({ invites: [T0 + 10 * HOUR, T0 + 30 * HOUR] });
  w.notes.L1.unshift({ id: '1', at: T0, text: '⚠️ Booking invite email WAS DELIVERED to the client, but stamping it "Sent" on this lead failed twice.' });
  w.leads.L1.inviteSentAt = torontoDay(T0 + 30 * HOUR);
  await at(w, T0 + 48 * HOUR + 30 * 60 * 1000);
  assert.equal(w.emails.length, 0, 'within a day of the 30h resend');
  await at(w, T0 + 54 * HOUR);
  assert.equal(w.emails.length, 1, 'anchored at T0 (not 10h), sent once the resend is a day old');
});

test('no invite note at all: the Booking Invite date at 09:00 Toronto starts the clock', async () => {
  const w = world({ invites: [] });
  w.leads.L1.inviteSentAt = '2026-10-20';           // 09:00 Toronto = 13:00Z
  const nine = Date.parse('2026-10-20T13:00:00Z');
  assert.equal(BR.torontoNine('2026-10-20'), nine);
  assert.equal(BR.torontoNine('2026-01-15'), Date.parse('2026-01-15T14:00:00Z'), 'winter time');
  await at(w, nine + 48 * HOUR - 60 * 1000); assert.equal(w.emails.length, 0);
  await at(w, nine + 48 * HOUR); assert.equal(w.emails.length, 1);
});

test('a failed email: a "did not go out" note, retried on the next run, at most 3 tries', async () => {
  let w = world();
  w.failSend = 1;
  await at(w, T0 + 48 * HOUR);
  assert.equal(w.emails.length, 0);
  assert.equal((w.notes.L1 || []).filter((n) => n.text.includes(BR.failText(1))).length, 1);
  await at(w, T0 + 49 * HOUR);
  assert.equal(w.emails.length, 1, 'retried');
  await at(w, T0 + 50 * HOUR);
  assert.equal(w.emails.length, 1, 'done after the retry');

  w = world();
  w.failSend = 99;
  for (let h = 48; h < 72; h++) await at(w, T0 + h * HOUR);
  assert.equal(claims(w, 1).length, BR.MAX_TRIES, 'three tries, then it stops');
});

test('the note cannot be posted → no email (never an email without its record)', async () => {
  const w = world();
  w.failPost = true;
  await at(w, T0 + 48 * HOUR);
  assert.equal(w.emails.length, 0);
  w.failPost = false;
  await at(w, T0 + 49 * HOUR);
  assert.equal(w.emails.length, 1);
});

test('two app instances at once (a deploy overlap): one email, the other note is removed', async () => {
  const w = world();
  w.now = T0 + 48 * HOUR;
  const [a, b] = await Promise.all([BR.remindPerson(['L1']), BR.remindPerson(['L1'])]);
  assert.equal(w.emails.length, 1);
  assert.deepEqual([a.result, b.result].sort(), ['lost-race', 'sent']);
  assert.equal(claims(w, 1).length, 1);
  assert.equal(w.deleted.length, 1);
  await at(w, T0 + 49 * HOUR);
  assert.equal(w.emails.length, 1);
});

test('switched off: nothing is read or sent; the preview still works and sends nothing', async () => {
  const w = world();
  w.now = T0 + 48 * HOUR;
  process.env.BOOKING_REMINDERS = 'off';
  try {
    const snap = BR.io.snapshot; let reads = 0;
    BR.io.snapshot = async () => { reads++; return snap(); };
    const r = await BR.runOnce();
    assert.match(r.skipped, /switched off/);
    assert.equal(reads, 0, 'switched off reads nothing');
    const p = await BR.runOnce({ dryRun: true });
    assert.equal(p.results[0].result, 'due');
    assert.equal(w.emails.length, 0);
    assert.equal(claims(w, 1).length, 0);
  } finally { delete process.env.BOOKING_REMINDERS; }
  const p2 = await BR.runOnce({ dryRun: true });
  assert.equal(p2.results[0].result, 'due');
  assert.equal(w.emails.length, 0, 'the preview never sends');
});

test('who is looked at: invited 1–7 Toronto days ago, Booking Invite "Sent", not booked', () => {
  const now = Date.parse('2026-10-28T16:00:00Z');
  const base = { bookingInvite: 'Sent', bookingStatus: 'Not Yet' };
  assert.equal(BR.isCandidate({ ...base, inviteSentAt: '2026-10-28' }, now), false, 'today');
  assert.equal(BR.isCandidate({ ...base, inviteSentAt: '2026-10-27' }, now), true);
  assert.equal(BR.isCandidate({ ...base, inviteSentAt: '2026-10-21' }, now), true);
  assert.equal(BR.isCandidate({ ...base, inviteSentAt: '2026-10-20' }, now), false, 'more than 7 days');
  assert.equal(BR.isCandidate({ ...base, inviteSentAt: '' }, now), false);
  assert.equal(BR.isCandidate({ ...base, inviteSentAt: '2026-10-27', bookingStatus: 'Booked' }, now), false);
  assert.equal(BR.isCandidate({ ...base, inviteSentAt: '2026-10-27', bookingInvite: '' }, now), false);
  assert.equal(BR.isCandidate({ ...base, inviteSentAt: '2026-10-27', bookedSlot: '2026-10-29 10:00' }, now), false, 'booked by hand');
  assert.equal(BR.isCandidate({ ...base, inviteSentAt: '2026-10-27', bookingStatus: 'Abandoned', bookedSlot: '2026-10-29 10:00' }, now), true, 'a hold that ran out');
});

test('the lead page line says what happened and what comes next', async () => {
  const w = world();
  w.now = T0 + 10 * HOUR;
  assert.match(await BR.describeForLead(w.leads.L1), /^1st due Oct 22/);
  await at(w, T0 + 48 * HOUR);
  w.now = T0 + 50 * HOUR;
  const line = await BR.describeForLead(w.leads.L1);
  assert.match(line, /^1st emailed Oct 22.* · 2nd due Oct 25/);
  w.leads.L1.bookingStatus = 'Booked';
  assert.match(await BR.describeForLead(w.leads.L1), /stopped — booked$/);
  assert.equal(await BR.describeForLead({ ...w.leads.L1, bookingInvite: '' }), '', 'not invited → no line');
});

test('the booking invite still uses the same layout, heading, link and fee sentence', async () => {
  const leadService = require('../src/services/leadService');
  const mail = require('../src/services/microsoftMailService');
  const mondayApi = require('../src/services/mondayApi');
  const keep = { getLead: leadService.getLead, updateLead: leadService.updateLead, gen: leadService.generateInviteMessage, send: mail.sendEmail, q: mondayApi.query };
  const sent = [];
  const lead = { id: '77', fullName: 'Asha Rao', email: 'a@example.com', leadToken: 'tk', bookingStatus: 'Not Yet', country: 'Canada', inviteMessage: 'Hello.' };
  leadService.getLead = async () => lead; leadService.updateLead = async () => ({}); leadService.generateInviteMessage = async () => 'Std.';
  mail.sendEmail = async (m) => { sent.push(m); }; mondayApi.query = async () => ({});
  try {
    await bookingService.sendBookingInvite('77', { force: true });
  } finally { Object.assign(leadService, { getLead: keep.getLead, updateLead: keep.updateLead, generateInviteMessage: keep.gen }); mail.sendEmail = keep.send; mondayApi.query = keep.q; }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Book your consultation with TDOT Immigration');
  // The invite's layout as it was before the shared helpers (byte for byte) — a change to the shared template fails here.
  const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../src/branding');
  const cc = require('../src/utils/clientContact');
  const base = String(process.env.RENDER_URL || 'https://tdot-automations.onrender.com').replace(/\/+$/, '');
  const url = `${base}/book/77?t=tk`, first = 'Asha', bodyHtml = '<p>Hello.</p>', feeLine = bookingService.inviteFeeLine(lead);
  const expected = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
        <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML}
          <h1 style="color:${BRAND.textOnDark};margin:12px 0 0;font-size:20px">Book your consultation</h1></div>
        <div style="background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
          <p>Hi ${first},</p>
          ${bodyHtml}
          <p><a href="${url}" style="display:inline-block;background:${BRAND.primary};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Choose your consultation time</a></p>
          <p>You'll see our real-time availability and can pick whatever works for you. ${feeLine}</p>
          <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">This link is personal to you — please don't share it. Questions? Please ${cc.EMAIL_US}. ${cc.NO_REPLY}</p>
        </div></div>`;
  assert.equal(sent[0].html, expected);
  assert.match(feeLine, /^The consultation fee is <b>/, 'a priced consultant');
});

test('the lead page is full width and shows the reminder line + how to stop them', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/adminLeads.js'), 'utf8');
  const detail = src.slice(src.indexOf('function buildLeadDetailHTML'));
  assert.match(detail, /\.wrap \{ max-width:none; margin:0; padding:20px 14px 90px; \}/);
  assert.ok(!/\.wrap \{ max-width:1140px/.test(src), 'the old 1140px cap is gone');
  assert.match(detail, /if\(d\.bookingReminders\) st\+=kv\('Booking reminders', d\.bookingReminders\);/);
  assert.match(detail, /emails them a reminder 48 hours and 5 days after the first invite\. Setting an Outcome stops the reminders\./);
  const sched = fs.readFileSync(path.join(__dirname, '../src/services/scheduler.js'), 'utf8');
  assert.match(sched, /cron\.schedule\('19 \* \* \* \*', \(\) =>\s*require\('\.\/bookingRemindersService'\)\.runOnce\(\)/);
  const minutes = (sched.match(/cron\.schedule\('([^']+)'/g) || []).map((x) => x.slice(15, -1)).filter((c) => c !== '19 * * * *');
  const fires = (spec, m) => { const f = spec.split(' ')[0]; if (f === '*') return true;
    return f.split(',').some((p) => { const [r, st] = p.split('/'); const [a, b] = r === '*' ? [0, 59] : r.split('-').map(Number); return m >= a && m <= (b == null ? (st ? 59 : a) : b) && (m - a) % (Number(st) || 1) === 0; }); };
  assert.ok(minutes.every((c) => !fires(c, 19)), 'no other job fires at :19');
});

// ─── One person, several lead rows (8 of 95 invited people on 2026-10-28) ────

/** A second (and third) row for the same person, each with its own invite notes. */
function addRow(w, id, { invites = [], lead = {} } = {}) {
  w.leads[id] = { ...w.leads.L1, id, leadToken: `tok-${id}`, inviteSentAt: invites.length ? torontoDay(invites[invites.length - 1]) : w.leads.L1.inviteSentAt, ...lead };
  w.notes[id] = [];
  const to = String(w.leads[id].email || '').trim().toLowerCase();
  for (const t of invites) w.addNote(id, `📧 Booking invite emailed to ${to} on ${torontoDay(t)}.`, t);
}

test('one person with two invited lead rows gets ONE pair of reminders, from the row invited last', async () => {
  const w = world({ invites: [T0] });
  addRow(w, 'L2', { invites: [T0 + 5 * HOUR], lead: { email: 'Asha@Example.com ' } });
  for (let h = 40; h < 200; h++) await at(w, T0 + h * HOUR);
  assert.equal(w.emails.length, 2, 'two emails for the person, not four');
  assert.match(w.emails[0].subject, /^Reminder:/); assert.match(w.emails[1].subject, /still open/);
  assert.ok(w.emails.every((m) => m.html.includes('/book/L2?t=tok-L2')), 'the link of the row invited last');
  assert.equal(claims(w, 1).length + claims(w, 2).length, 0, 'no notes on the other row');
  assert.equal(w.notes.L2.filter((n) => /Booking reminder [12] of 2 emailed/.test(n.text)).length, 2);
  // the clock started at the FIRST invite of the person (L1, T0) — reminder 1 went at 48h, not 53h
  const r1 = w.notes.L2.find((n) => n.text.includes(BR.claimText(1)));
  assert.equal(r1.at, T0 + 48 * HOUR);
});

test('another row of the person booked (time ahead or within 7 days) or holding a time → nothing', async () => {
  for (const lead of [
    { bookingStatus: 'Booked', bookedSlot: '2026-10-25 10:00' },
    { bookingStatus: 'Booked', bookedSlot: '2026-10-16 10:00' },     // a booking 6 days before the reminder
    { bookingStatus: 'Booked', bookedSlot: '' },                      // unreadable time: treat as booked
    { bookingStatus: 'Slot Held', slotHeldUntil: new Date(T0 + 49 * HOUR).toISOString() },
  ]) {
    const w = world({ invites: [T0] });
    addRow(w, 'L2', { invites: [], lead: { ...lead, bookingInvite: '', inviteSentAt: '' } });
    await at(w, T0 + 48 * HOUR);
    assert.equal(w.emails.length, 0, JSON.stringify(lead));
  }
});

test('an OLD booking on another row (a consultation months ago) does not stop a new inquiry\'s reminders', async () => {
  const w = world({ invites: [T0] });
  addRow(w, 'L2', { invites: [], lead: { bookingStatus: 'Booked', bookedSlot: '2026-07-01 10:00', outcome: 'Follow-Up', bookingInvite: '', inviteSentAt: '' } });
  await at(w, T0 + 48 * HOUR);
  assert.equal(w.emails.length, 1);
});

test('a row invited in this pair that moved on (Outcome, paid, retainer) stops the person', async () => {
  for (const lead of [{ outcome: 'Newsletter' }, { consultPayment: '{"kind":"waived"}' }, { retainerSent: '2026-10-21' }]) {
    const w = world({ invites: [T0] });
    addRow(w, 'L2', { invites: [T0 + HOUR], lead });
    await at(w, T0 + 48 * HOUR);
    assert.equal(w.emails.length, 0, JSON.stringify(lead));
  }
});

test('a row that cannot send (no link) hands the email to the other row', async () => {
  const w = world({ invites: [T0] });
  addRow(w, 'L2', { invites: [T0 + HOUR], lead: { leadToken: '' } });
  await at(w, T0 + 48 * HOUR);
  assert.equal(w.emails.length, 1);
  assert.ok(w.emails[0].html.includes('/book/L1?t=tok-1'));
});

test('a new invite more than 6 days after the first starts a fresh pair; a resend inside the 6 days does not', async () => {
  const w = world({ invites: [T0] });
  await at(w, T0 + 48 * HOUR); await at(w, T0 + 120 * HOUR);
  assert.equal(w.emails.length, 2);
  const T1 = T0 + 9 * DAY;
  w.addNote('L1', '📧 Booking invite emailed to asha@example.com on later.', T1);
  w.leads.L1.inviteSentAt = torontoDay(T1);
  for (let h = 1; h < 200; h++) await at(w, T1 + h * HOUR);
  assert.equal(w.emails.length, 4, 'a fresh pair for the new invite');
  const ep = BR.episodeOf([{ at: T0, text: 'Booking invite emailed' }, { at: T0 + 143 * HOUR, text: 'Booking invite emailed' }], '');
  assert.equal(ep.anchor, T0, 'a resend inside the pair keeps the first invite as the start');
});

test('one person is checked once per run, whichever row comes first; the email search failing → tried next run', async () => {
  const w = world({ invites: [T0] });
  addRow(w, 'L2', { invites: [T0 + HOUR], lead: { email: 'ASHA@example.com' } });
  addRow(w, 'L3', { invites: [T0], lead: { email: 'someone.else@example.com', leadToken: 'tok-3' } });
  w.now = T0 + 48 * HOUR;
  const r = await BR.runOnce({ dryRun: true });
  assert.equal(r.candidates, 2, 'Asha (two rows, any case) + someone else');
  const asha = r.results.find((x) => x.ids.includes('L1'));
  assert.deepEqual(asha.ids.slice().sort(), ['L1', 'L2']);
  w.failSearch = true;
  const r2 = await BR.runOnce();
  assert.ok(r2.results.every((x) => x.result === 'error'));
  assert.equal(w.emails.length, 0);
  w.failSearch = false;
  await BR.runOnce();
  assert.equal(w.emails.length, 2);
});

test('the lead page line on the other row says where the reminders go from', async () => {
  const w = world({ invites: [T0] });
  addRow(w, 'L2', { invites: [T0 + 5 * HOUR] });
  w.now = T0 + 10 * HOUR;
  assert.match(await BR.describeForLead(w.leads.L1), /1st due Oct 22.* · this person has 2 lead rows — the reminders go from lead L2$/);
  assert.match(await BR.describeForLead(w.leads.L2), /this person has 2 lead rows — counted once$/);
});

test('two app instances that pick DIFFERENT rows of one person still send one email', async () => {
  const w = world({ invites: [T0] });
  addRow(w, 'L2', { invites: [T0 + HOUR] });
  w.now = T0 + 48 * HOUR;
  // the first read of L2 sees no link yet (a write in flight), so that instance sends from L1
  const real = BR.io.getLead;
  let firstL2 = true;
  BR.io.getLead = async (id) => { const l = await real(id); if (id === 'L2' && firstL2) { firstL2 = false; return { ...l, leadToken: '' }; } return l; };
  const res = await Promise.all([BR.remindPerson(['L1', 'L2']), BR.remindPerson(['L1', 'L2'])]);
  assert.equal(w.emails.length, 1, JSON.stringify(res.map((r) => r.result)));
  assert.deepEqual(res.map((r) => r.result).sort(), ['lost-race', 'sent']);
  const left = [...w.notes.L1, ...w.notes.L2].filter((n) => n.text.includes(BR.claimText(1)));
  assert.equal(left.length, 1, 'the losing note was removed');
});

test('booked by hand (status never set to Booked): no "you haven\'t booked" email', async () => {
  for (const lead of [
    { bookedSlot: '2026-10-24 14:00' },
    { consultationHeld: '2026-10-21' },
    { meetingLink: 'https://teams.example/x' },
    { squareBookingId: 'sq_1' },
    { consultAgreementSent: '2026-10-21' },
    { preConsultSubmitted: 'Yes' },
  ]) {
    const w = world({ lead });
    await at(w, T0 + 48 * HOUR);
    assert.equal(w.emails.length, 0, JSON.stringify(lead));
  }
  // a hold that ran out leaves its time in Booked Slot — that is NOT a booking
  const w = world({ lead: { bookingStatus: 'Abandoned', bookedSlot: '2026-10-24 14:00' } });
  await at(w, T0 + 48 * HOUR);
  assert.equal(w.emails.length, 1);
  // booked by hand on ANOTHER row of the person
  const w2 = world({ invites: [T0] });
  addRow(w2, 'L2', { invites: [], lead: { bookedSlot: '2026-10-23 10:00', bookingStatus: '', bookingInvite: '', inviteSentAt: '' } });
  await at(w2, T0 + 48 * HOUR);
  assert.equal(w2.emails.length, 0);
});

test('a resend whose note was not saved still gets its quiet day (the Booking Invite date)', async () => {
  const w = world({ invites: [T0] });
  w.leads.L1.inviteSentAt = '2026-10-22';            // resent on day 2, its note lost
  await at(w, T0 + 48 * HOUR);                       // 2026-10-22 11:00 Toronto
  assert.equal(w.emails.length, 0, 'not on the day of the resend');
  await at(w, T0 + 60 * HOUR);
  assert.equal(w.emails.length, 0, 'not within a day of the end of that day');
  // quiet until 2026-10-23 23:59 Toronto = 72h+ → reminder 1 would be more than a day late → skipped; reminder 2 on day 5
  for (const h of [70, 80, 100]) await at(w, T0 + h * HOUR);
  assert.equal(w.emails.length, 0);
  await at(w, T0 + 120 * HOUR);
  assert.equal(w.emails.length, 1);
});

test('a wait that ends inside the last hourly tick is a skip, not a promise the hourly job cannot keep', () => {
  const notes = [{ id: '1', at: T0, text: 'Booking invite emailed' }, { id: '2', at: T0 + 47.5 * HOUR, text: 'Booking invite emailed' }];
  const ep = BR.episodeOf(notes, '');
  const p = BR.planFor(notes, T0 + 48 * HOUR, ep);
  assert.deepEqual(p.skipped, [1], 'quiet until 71.5h — less than an hour before the 72h limit');
  assert.equal(p.n, 2);
});

test('a lead named "Unnamed Lead" is greeted "Hi there", like the invite', () => {
  const m = BR.reminderEmail({ id: '9', fullName: '', name: 'Unnamed Lead', email: 'x@example.com', leadToken: 't' }, 1);
  assert.ok(m.html.includes('Hi there,'));
  assert.ok(!m.html.includes('Unnamed'));
});

test('the real Monday helpers: archived leads read as gone, plain text from notes, ids from saves', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const keep = mondayApi.query;
  const fresh = require('../src/services/bookingRemindersService');
  // the io functions captured before the fake world replaced them are not reachable; rebuild them from the module source
  const src = fs.readFileSync(path.join(__dirname, '../src/services/bookingRemindersService.js'), 'utf8');
  assert.match(src, /items\(ids:\$ids\)\{ id state updates\(limit:\$\{NOTES_LIMIT\}\)\{ id created_at text_body body \} \}/);
  delete require.cache[require.resolve('../src/services/bookingRemindersService')];
  const real = require('../src/services/bookingRemindersService');
  const calls = [];
  try {
    mondayApi.query = async (q, v) => {
      calls.push(q);
      if (/delete_update/.test(q)) return { delete_update: { id: v.i } };
      if (/create_update/.test(q)) return { create_update: { id: '555' } };
      if (v.ids[0] === 'gone') return { items: [] };
      if (v.ids[0] === 'arch') return { items: [{ id: 'arch', state: 'archived', updates: [] }] };
      return { items: [{ id: 'ok', state: 'active', updates: [
        { id: '2', created_at: '2026-10-21T15:00:00Z', text_body: '', body: '<p>📧 <b>Booking invite emailed</b> to a@b.c</p>' },
        { id: '1', created_at: '2026-10-20T15:00:00Z', text_body: 'Hello', body: '<p>Hello</p>' },
      ] }] };
    };
    assert.equal(await real.io.readNotes('gone'), null);
    assert.equal(await real.io.readNotes('arch'), null);
    const n = await real.io.readNotes('ok');
    assert.deepEqual(n.map((x) => [x.id, x.at, x.text]), [['2', Date.parse('2026-10-21T15:00:00Z'), '📧 Booking invite emailed to a@b.c'], ['1', Date.parse('2026-10-20T15:00:00Z'), 'Hello']]);
    assert.equal(await real.io.postNote('ok', 'x'), '555');
    await real.io.deleteNote('555');
    assert.ok(calls.some((q) => /delete_update\(id: \$i\)/.test(q)));
    mondayApi.query = async () => ({ create_update: null });
    await assert.rejects(real.io.postNote('ok', 'x'), /not saved/);
  } finally {
    mondayApi.query = keep;
    delete require.cache[require.resolve('../src/services/bookingRemindersService')];
    require.cache[require.resolve('../src/services/bookingRemindersService')] = { exports: fresh, loaded: true, id: require.resolve('../src/services/bookingRemindersService'), filename: require.resolve('../src/services/bookingRemindersService') };
  }
});

test('personRows keeps only rows whose email really matches (a loose search match is dropped), newest first, capped', async () => {
  const keep = BR.io.rowsByEmail;
  try {
    BR.io.rowsByEmail = async () => [
      { id: '5', email: 'Asha@Example.com', createdAt: '2026-10-01T00:00:00Z' },
      { id: '6', email: 'asha@example.com.au', createdAt: '2026-10-02T00:00:00Z' },
      { id: '7', email: 'asha@example.com', createdAt: '2026-10-03T00:00:00Z' },
      ...Array.from({ length: 12 }, (_, i) => ({ id: String(100 + i), email: 'asha@example.com', createdAt: '2026-09-01T00:00:00Z' })),
    ];
    const { ids } = await BR.personRows('1', 'asha@example.com');
    assert.equal(ids[0], '1');
    assert.ok(!ids.includes('6'), 'a different address is another person');
    assert.deepEqual(ids.slice(1, 3), ['7', '5'], 'newest first');
    assert.equal(ids.length, 8, 'capped');
  } finally { BR.io.rowsByEmail = keep; }
});

// ─── Review round 2 ──────────────────────────────────────────────────────────

test('archiving the row that sent reminder 1 does not make the other row send it again (the copy of the record)', async () => {
  const w = world({ invites: [T0] });
  addRow(w, 'L2', { invites: [T0 + HOUR] });
  await at(w, T0 + 48 * HOUR);
  assert.equal(w.emails.length, 1);
  assert.equal((w.notes.L1 || []).filter((n) => n.text.includes(BR.copyText(1))).length, 1, 'the copy on the other row');
  w.archived.add('L2');
  for (let h = 49; h < 119; h++) await at(w, T0 + h * HOUR);
  assert.equal(w.emails.length, 1, 'no second reminder 1');
  await at(w, T0 + 120 * HOUR);
  assert.equal(w.emails.length, 2, 'reminder 2 still goes, from the row left');
  assert.ok(w.emails[1].html.includes('/book/L1?'));
});

test('a row whose email was edited after the invite gets no reminder at the new address; the person is not reminded twice', async () => {
  const w = world({ invites: [T0] });
  addRow(w, 'L2', { invites: [T0 + HOUR] });
  await at(w, T0 + 48 * HOUR);
  assert.equal(w.emails.length, 1);
  w.leads.L2.email = 'spouse@example.com';         // it was the spouse's lead
  for (let h = 49; h < 200; h++) await at(w, T0 + h * HOUR);
  assert.equal(w.emails.filter((m) => m.to === 'spouse@example.com').length, 0, 'never to an address that got no invite');
  assert.equal(w.emails.filter((m) => m.subject.startsWith('Reminder:')).length, 1, 'reminder 1 once');
  assert.equal(w.emails.length, 2, 'reminder 2 once, to the invited address');
  assert.equal(w.emails[1].to, 'asha@example.com');
});

test('a person with more than 8 rows: the rows invited lately are never capped away (one reminder 1)', async () => {
  const w = world({ invites: [T0] });
  w.leads.L1.createdAt = '2025-01-01T00:00:00Z';                 // the oldest row
  addRow(w, 'L2', { invites: [T0 + HOUR] });
  w.leads.L2.createdAt = '2025-01-02T00:00:00Z';
  for (let i = 0; i < 9; i++) { addRow(w, `X${i}`, { invites: [], lead: { bookingInvite: '', inviteSentAt: '', createdAt: `2026-0${(i % 9) + 1}-01T00:00:00Z` } }); }
  for (let h = 47; h < 75; h++) await at(w, T0 + h * HOUR);
  assert.equal(w.emails.length, 1);
});

test('the Not Wanted list is checked for every invited row of the person (another row\'s phone)', async () => {
  const w = world({ invites: [T0] });
  addRow(w, 'L2', { invites: [T0 + HOUR], lead: { phone: '6475550199' } });
  BR.io.blacklistCheck = async (who) => ({ checked: true, hit: who.phone === '4165550101' });   // L1's phone — L2 sends
  await at(w, T0 + 48 * HOUR);
  assert.equal(w.emails.length, 0);
});

test('a preview in progress never makes the hourly run skip', async () => {
  const w = world({ invites: [T0] });
  w.now = T0 + 48 * HOUR;
  const [p, r] = await Promise.all([BR.runOnce({ dryRun: true }), BR.runOnce()]);
  assert.ok(!r.skipped, JSON.stringify(r));
  assert.ok(!p.skipped);
  assert.equal(w.emails.length, 1);
});

test('the lead page skips the reads for an invite older than 9 days', async () => {
  const w = world({ invites: [T0] });
  w.now = T0 + 12 * DAY;
  let reads = 0;
  const rn = BR.io.readNotes; BR.io.readNotes = async (id) => { reads++; return rn(id); };
  assert.equal(await BR.describeForLead(w.leads.L1), '');
  assert.equal(reads, 0);
});

test('inviteAddress reads the address from the invite note', () => {
  assert.equal(BR.inviteAddress('📧 Booking invite emailed to Asha@Example.com on 2026-10-27.'), 'asha@example.com');
  assert.equal(BR.inviteAddress('⚠️ Booking invite email WAS DELIVERED to the client, but stamping…'), '');
  assert.ok(!BR.copyText(1).includes(BR.claimText(1)) && !BR.claimText(1).includes(BR.copyText(1)), 'a copy is never read as a claim');
});
