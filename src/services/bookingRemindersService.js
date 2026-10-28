'use strict';

/**
 * Booking-invite reminders (Faran 2026-10-28): a person who was emailed the
 * booking invite and has not booked gets two reminder emails —
 *   reminder 1: 48 hours after the FIRST booking invite email,
 *   reminder 2: 5 days (120 hours) after it.
 * Both carry a personal booking link, like the invite.
 *
 * ONE PERSON, NOT ONE ROW: a person often has two or three lead rows (the form
 * sent twice — 8 of 95 invited people on 2026-10-28), each invited. Their rows
 * (same email) are read together: the reminders count once for the person, any
 * row that booked or moved on stops them all, and the email goes from the row
 * invited last (its link is the one the client got most recently).
 *
 * THE RECORD IS THE LEADS' NOTES (the same proof-by-notes the held-onboarding
 * resume uses — no new column, nothing staff can't see):
 *   - the invite: "Booking invite emailed" (bookingService.sendBookingInvite) —
 *     the EARLIEST one starts the clock; the latest one is when the client last
 *     got an invite. An invite more than 6 days after the clock started (when
 *     both reminders are over) starts a fresh pair — a resend inside those 6
 *     days does not;
 *   - a reminder: "Booking reminder N of 2 emailed", posted BEFORE the email
 *     goes out (the claim), and "Booking reminder N of 2 did not go out" when
 *     the send then fails. A reminder is done when it has more claims than
 *     failures; it is retried (next run) after a failure, at most 3 tries.
 * Two app instances (a deploy overlap) cannot both send one: each posts its
 * claim, reads the notes back, and only the earliest open claim sends; the
 * other deletes its own note.
 *
 * WHEN A REMINDER IS NOT SENT (checked fresh on every run, just before sending):
 *   booked (any of the person's rows, a time in the last 7 days or ahead), a
 *   time held while they pay, paid (online or recorded / waived), any Outcome
 *   set, a retainer under way or a case opened, retained, the Booking Invite
 *   column no longer "Sent", no email, no booking link, archived / deleted, on
 *   the Not Wanted list (or the list could not be checked — tried next run).
 *   Staff stop the reminders for a lead by setting its Outcome.
 * Never within 24 hours of a booking invite email (a resend), and never more
 * than 24 hours late: a reminder the app could not send in time (an outage, or
 * an invite older than the switch-on) is skipped, never sent days late.
 *
 * Switch: BOOKING_REMINDERS — ON unless set to 0/off/false/no (kill switch).
 * Runs hourly (scheduler); admin: GET /admin/booking-reminders/preview
 * (read-only: who is due and why), POST /admin/booking-reminders/run.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const REMINDERS = [
  { n: 1, afterMs: 48 * HOUR, label: '48 hours' },
  { n: 2, afterMs: 5 * DAY,   label: '5 days' },
];
const LATE_LIMIT_MS         = DAY;    // more than a day late → skipped
const QUIET_AFTER_INVITE_MS = DAY;    // never within a day of an invite email
// After this, no reminder of the current pair can still be due — an invite
// later than this starts a fresh pair.
const EPISODE_MS            = REMINDERS[REMINDERS.length - 1].afterMs + LATE_LIMIT_MS;
const MAX_TRIES             = 3;
const RUN_EVERY_MS          = HOUR;   // the scheduler's tick — a wait that ends inside the last tick is a skip, never a promise
const NOTES_LIMIT           = 100;
const MAX_PERSON_ROWS       = 8;      // one person's lead rows read together (newest first)
const BOOKED_RECENT_MS      = 7 * DAY; // a booking on another row this recent (or ahead) stops the reminders
// The lead list (snapshot) only narrows who is read; every decision is made on
// a fresh read. Latest invite date (Toronto) between 7 days and 1 day ago.
const CANDIDATE_MAX_AGE_DAYS = 7;

// The invite's own notes: sent, or sent but the "Sent" stamp failed (the email DID
// go out — it counts toward the clock and the quiet day of a later invite).
const INVITE_RE = /Booking invite emailed|Booking invite email WAS DELIVERED/i;
const claimText = (n) => `Booking reminder ${n} of 2 emailed`;
const failText  = (n) => `Booking reminder ${n} of 2 did not go out`;
// After a send, a copy of the record on the person's other rows invited in the
// pair — so archiving the sending row, or editing its email, never loses the
// record (counts as sent; never a claim in the race, never a try).
const copyText  = (n) => `Booking reminder ${n} of 2 was emailed from lead`;
/** The address an invite note says it went to ('' when the note does not say). */
const inviteAddress = (text) => { const m = /Booking invite emailed to (\S+@\S+?)\s+on\s/i.exec(String(text || '')); return m ? m[1].trim().toLowerCase() : ''; };
const DIRECT_SOURCE = 'Direct Retainer';

const s = (v) => String(v == null ? '' : v).trim();
const normEmail = (v) => s(v).toLowerCase();
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enabled = () => !/^(0|off|false|no|disabled?)$/i.test(s(process.env.BOOKING_REMINDERS));
const idNum = (x) => Number(x && x.id) || 0;

/** The side effects behind one seam (tests replace them). */
const io = {
  now: () => Date.now(),
  snapshot: async () => (await require('./leadSnapshot').getLeadSnapshot()).leads,
  getLead: (id) => require('./leadService').getLead(id),
  /** Leads whose Email column matches (Monday search; throws on failure). */
  rowsByEmail: (email) => require('./leadService').findAllByColumnValue('email', email),
  /** The lead's notes, newest 100; null when the lead is archived, deleted or gone. */
  async readNotes(leadId) {
    const d = await require('./mondayApi').query(
      `query($ids:[ID!]){ items(ids:$ids){ id state updates(limit:${NOTES_LIMIT}){ id created_at text_body body } } }`,
      { ids: [String(leadId)] });
    const item = d && d.items && d.items[0];
    if (!item || (item.state && item.state !== 'active')) return null;
    return (item.updates || []).map((u) => ({ id: s(u.id), at: Date.parse(s(u.created_at)), text: s(u.text_body) || s(u.body).replace(/<[^>]*>/g, '') }));
  },
  async postNote(leadId, body) {
    const d = await require('./mondayApi').query(
      'mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }', { i: String(leadId), b: body });
    const id = d && d.create_update && d.create_update.id;
    if (!id) throw new Error('the note was not saved');
    return s(id);
  },
  deleteNote: (id) => require('./mondayApi').query('mutation($i: ID!){ delete_update(id: $i){ id } }', { i: String(id) }),
  blacklistCheck: (who) => require('./blacklistService').check(who),
  sendEmail: (msg) => require('./microsoftMailService').sendEmail(msg),
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

// ─── Pure rules ──────────────────────────────────────────────────────────────

/** Toronto calendar day (YYYY-MM-DD) of an instant. */
function torontoDay(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}

/** "YYYY-MM-DD HH:MM" Toronto wall time → UTC ms (NaN when unreadable). */
function torontoWallToUtc(wall) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s(wall));
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] == null ? 9 : +m[4], m[5] == null ? 0 : +m[5]);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(guess));
  const p = {}; for (const x of parts) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return guess - (asUtc - guess);
}
/** 09:00 Toronto on a YYYY-MM-DD day (the stand-in when no invite note exists). */
const torontoNine = (day) => torontoWallToUtc(s(day).slice(0, 10));

/**
 * Why this row has moved on (booked, paying, paid, an Outcome, a retainer, a
 * case) — any of these on one of the person's rows stops the reminders for the
 * person. '' = none.
 */
function progressReason(lead, now) {
  if (!lead) return '';
  const status = s(lead.bookingStatus);
  if (status === 'Booked') return 'booked';
  if (status === 'Slot Held' && Date.parse(s(lead.slotHeldUntil)) > now) return 'holding a time while paying';
  // Booked by hand (by phone, cash) is often never set to "Booked" — the signs a
  // booking leaves. A hold that ran out leaves its time in Booked Slot: not a booking.
  if (s(lead.bookedSlot) && status !== 'Slot Held' && status !== 'Abandoned') return 'a consultation time is in Booked Slot';
  if (s(lead.consultationHeld)) return 'the consultation was held';
  if (s(lead.meetingLink) || s(lead.squareBookingId)) return 'a consultation meeting exists';
  if (s(lead.consultAgreementSent)) return 'the consultation agreement was sent';
  if (s(lead.preConsultSubmitted) === 'Yes') return 'the pre-consultation form is submitted';
  if (s(lead.squareConsultTxnId)) return 'paid online';
  if (s(lead.consultPayment)) return 'the consultation fee is recorded or waived';
  if (s(lead.outcome)) return `the Outcome is set (${s(lead.outcome)})`;
  if (s(lead.conversionStatus) === 'Retained') return 'retained';
  if (s(lead.sourceChannel) === DIRECT_SOURCE || s(lead.retainerSent) || s(lead.retainerSigned) || s(lead.retainerPaid)) return 'a retainer is under way';
  if (s(lead.clientMasterItemId)) return 'a case is open';
  return '';
}

/** Why this row cannot get a reminder at all ('' = nothing stops it). */
function stopReason(lead, now) {
  if (!lead) return 'the lead was not found';
  if (s(lead.bookingInvite) !== 'Sent') return 'the Booking Invite column is not "Sent"';
  if (!s(lead.email)) return 'no email address';
  const p = progressReason(lead, now);
  if (p) return p;
  if (!s(lead.leadToken)) return 'the lead has no booking link';
  return '';
}

/**
 * The current pair's clock, from the person's notes (all rows together):
 * `anchor` = the first invite of the current pair, `lastInvite` = the latest
 * invite. No invite note anywhere → the Booking Invite date at 09:00 Toronto.
 */
function episodeOf(notes, fallbackDay) {
  const invites = (notes || []).filter((x) => x && Number.isFinite(x.at) && INVITE_RE.test(x.text)).map((x) => x.at).sort((a, b) => a - b);
  if (!invites.length) {
    const t = torontoNine(fallbackDay);
    return Number.isFinite(t) ? { anchor: t, lastInvite: t, fromColumn: true } : null;
  }
  let anchor = invites[0];
  for (const t of invites) if (t - anchor > EPISODE_MS) anchor = t;   // a later invite after the pair is over: a fresh pair
  let lastInvite = invites[invites.length - 1];
  // The Booking Invite date is LATER than the newest invite note: a resend whose
  // note was not saved (best-effort). Its hour is unknown — quiet as if it went
  // out at the end of that day.
  const day = s(fallbackDay).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day > torontoDay(lastInvite)) {
    const late = torontoWallToUtc(`${day} 23:59`);
    if (Number.isFinite(late)) lastInvite = Math.max(lastInvite, late);
  }
  return { anchor, lastInvite, fromColumn: false };
}

/**
 * Where the reminders stand. Pure. `notes` = every note of the person's rows.
 * @returns {{ state: 'due'|'waiting'|'finished'|'no-invite', n?, dueAt?, label?, anchor?, sent: Array<{n, at}>, skipped: number[], gaveUp: number[], why?: string }}
 */
function planFor(notes, now, ep) {
  if (!ep) return { state: 'no-invite', sent: [], skipped: [], gaveUp: [] };
  const { anchor, lastInvite } = ep;
  const list = (notes || []).filter((x) => x && Number.isFinite(x.at) && x.at >= anchor);   // this pair's notes only
  const out = { anchor, sent: [], skipped: [], gaveUp: [] };
  for (const r of REMINDERS) {
    const claims = list.filter((x) => x.text.includes(claimText(r.n)));
    const fails = list.filter((x) => x.text.includes(failText(r.n)));
    const copies = list.filter((x) => x.text.includes(copyText(r.n)));
    if (claims.length > fails.length || copies.length) { out.sent.push({ n: r.n, at: Math.max(...claims.map((c) => c.at), ...copies.map((c) => c.at)) }); continue; }
    if (claims.length >= MAX_TRIES) { out.gaveUp.push(r.n); continue; }
    const dueAt = anchor + r.afterMs;
    if (now < dueAt) return { ...out, state: 'waiting', n: r.n, dueAt, label: r.label };
    if (now >= dueAt + LATE_LIMIT_MS) { out.skipped.push(r.n); continue; }
    const quietUntil = lastInvite + QUIET_AFTER_INVITE_MS;
    if (now < quietUntil) {
      if (quietUntil + RUN_EVERY_MS > dueAt + LATE_LIMIT_MS) { out.skipped.push(r.n); continue; }   // the wait would make it more than a day late
      return { ...out, state: 'waiting', n: r.n, dueAt: quietUntil, label: r.label, why: 'a booking invite was emailed less than a day ago' };
    }
    return { ...out, state: 'due', n: r.n, dueAt, label: r.label };
  }
  return { ...out, state: 'finished' };
}

/** A candidate from the lead list: invited 1–7 Toronto days ago and not obviously done. */
function isCandidate(l, now) {
  if (s(l.bookingInvite) !== 'Sent') return false;
  const day = s(l.inviteSentAt).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const today = torontoDay(now), oldest = torontoDay(now - CANDIDATE_MAX_AGE_DAYS * DAY);
  if (!(day < today && day >= oldest)) return false;
  return !progressReason(l, now);
}

/** Open claims for reminder n in this pair (after its latest failure), earliest first. */
function openClaims(notes, n, anchor) {
  const mine = (notes || []).filter((x) => Number.isFinite(x.at) && x.at >= anchor);
  const lastFail = Math.max(0, ...mine.filter((x) => x.text.includes(failText(n))).map(idNum));
  return mine.filter((x) => x.text.includes(claimText(n)) && idNum(x) > lastFail).sort((a, b) => idNum(a) - idNum(b));
}

// ─── The email ───────────────────────────────────────────────────────────────

function reminderEmail(lead, n) {
  const bs = require('./bookingService');
  const first = escHtml(String(lead.fullName || 'there').split(' ')[0]);   // as the invite (an "Unnamed Lead" reads "there")
  const url = bs.bookingUrl(lead.id, s(lead.leadToken));
  const ignore = 'If you have already booked, or no longer need a consultation, please ignore this email.';
  const copy = n === 1
    ? { subject: 'Reminder: book your consultation with TDOT Immigration', heading: 'Book your consultation',
      body: `<p>This is a quick reminder that your personal link to book a consultation with TDOT Immigration is ready whenever you are.</p><p>${ignore}</p>` }
    : { subject: 'Your TDOT Immigration consultation link is still open', heading: 'Your booking link is still open',
      body: `<p>We noticed you haven't booked your consultation yet. Your personal booking link still works, and you can choose a time below.</p><p>${ignore}</p>` };
  return {
    to: s(lead.email),
    subject: copy.subject,
    html: bs.bookingEmailHtml({ heading: copy.heading, first, bodyHtml: copy.body, url, feeLine: bs.inviteFeeLine(lead) }),
  };
}

// ─── One person ──────────────────────────────────────────────────────────────

/**
 * Read one person's lead rows fresh and decide. Throws when a read fails.
 * @param {string[]} ids  the person's lead rows (same email), any order
 * @returns {{ rows, merged, ep, plan, driver, stop: string }}
 */
async function assessPerson(ids, now, preloaded = new Map()) {
  // Every row at once (the lead page waits on this): a lead the email search just
  // returned is as fresh as a getLead, so it is not read twice.
  const read = await Promise.all([...new Set(ids.map(String))].map(async (id) => {
    const [lead, notes] = await Promise.all([preloaded.get(id) || io.getLead(id), io.readNotes(id)]);
    return lead && notes ? { id, lead, notes } : null;   // archived / deleted: not part of the person any more
  }));
  const rows = read.filter(Boolean);
  if (!rows.length) return { rows, merged: [], ep: null, plan: planFor([], now, null), driver: null, stop: 'the lead is archived or deleted' };
  const merged = rows.flatMap((r) => r.notes);
  const other = (r) => (rows.length > 1 ? ` (lead ${r.id})` : '');
  const fallbackDay = rows.map((r) => (s(r.lead.bookingInvite) === 'Sent' ? s(r.lead.inviteSentAt).slice(0, 10) : '')).filter(Boolean).sort().pop() || '';
  const ep = episodeOf(merged, fallbackDay);
  const plan = planFor(merged, now, ep);
  const result = (stop, driver = null, pair = []) => ({ rows, merged, ep, plan, driver, stop, pair });

  // Any row booked lately (or ahead) or holding a time: the person is booking.
  for (const r of rows) {
    const st = s(r.lead.bookingStatus);
    if (st === 'Booked') {
      const slot = torontoWallToUtc(r.lead.bookedSlot);
      if (!Number.isFinite(slot) || slot >= now - BOOKED_RECENT_MS || rows.length === 1) return result(`booked${other(r)}`);
    }
    if (st === 'Slot Held' && Date.parse(s(r.lead.slotHeldUntil)) > now) return result(`holding a time while paying${other(r)}`);
    if (st !== 'Booked' && st !== 'Slot Held' && st !== 'Abandoned' && s(r.lead.bookedSlot)) {   // booked by hand on another row
      const slot = torontoWallToUtc(r.lead.bookedSlot);
      if (!Number.isFinite(slot) || slot >= now - BOOKED_RECENT_MS || rows.length === 1) return result(`a consultation time is in Booked Slot${other(r)}`);
    }
  }
  if (!ep) return result('no booking invite email on record');
  // The rows invited in this pair: any that moved on stops the person.
  const inPair = rows.filter((r) => (ep.fromColumn
    ? s(r.lead.inviteSentAt).slice(0, 10) === fallbackDay
    : r.notes.some((x) => INVITE_RE.test(x.text) && Number.isFinite(x.at) && x.at >= ep.anchor)));
  for (const r of inPair) { const p = progressReason(r.lead, now); if (p) return result(`${p}${other(r)}`); }
  // The email goes from the row invited last that can send one — and only to an
  // address this pair's invite actually went to (an email edited after the invite
  // — the spouse's lead, a typo fixed — is not the person who was invited).
  const pairInvites = (r) => r.notes.filter((x) => INVITE_RE.test(x.text) && Number.isFinite(x.at) && x.at >= ep.anchor);
  const invitedTo = new Set(inPair.flatMap((r) => pairInvites(r).map((x) => inviteAddress(x.text)).filter(Boolean)));
  const addressOk = (r) => ep.fromColumn || invitedTo.has(normEmail(r.lead.email)) || pairInvites(r).some((x) => !inviteAddress(x.text));
  const lastInviteAt = (r) => Math.max(0, ...r.notes.filter((x) => INVITE_RE.test(x.text) && Number.isFinite(x.at)).map((x) => x.at));
  const ok = inPair.filter((r) => !stopReason(r.lead, now) && addressOk(r))
    .sort((a, b) => (lastInviteAt(b) - lastInviteAt(a)) || (Number(b.id) - Number(a.id)));
  if (!ok.length) {
    const latest = inPair.slice().sort((a, b) => lastInviteAt(b) - lastInviteAt(a))[0] || rows[0];
    return result(stopReason(latest.lead, now) || (addressOk(latest) ? 'no lead row can send a reminder' : 'the email address changed after the booking invite'));
  }
  return result('', ok[0], inPair);
}

/**
 * One person: decide, and send at most one reminder.
 * @param {string[]} ids  the person's lead rows (same email)
 * @returns {Promise<{ leadId, ids, result: 'sent'|'due'|'waiting'|'stopped'|'finished'|'failed'|'lost-race'|'error', n?, why? }>}
 */
async function remindPerson(ids, { dryRun = false, preloaded } = {}) {
  const now = io.now();
  let a;
  try { a = await assessPerson(ids, now, preloaded); }
  catch (err) { return { leadId: String(ids[0]), ids, result: 'error', why: `could not read the lead: ${err.message}` }; }
  const lead = a.driver ? a.driver.lead : (a.rows[0] && a.rows[0].lead);
  const base = { leadId: a.driver ? a.driver.id : String(ids[0]), ids, name: s(lead && (lead.fullName || lead.name)), sent: a.plan.sent, skipped: a.plan.skipped };
  if (a.stop) return { ...base, result: 'stopped', why: a.stop };
  const plan = a.plan;
  if (plan.state !== 'due') return { ...base, result: plan.state === 'waiting' ? 'waiting' : 'finished', n: plan.n, dueAt: plan.dueAt, why: plan.why };

  // The Not Wanted list, by every email / phone the person's invited rows carry.
  const who = new Map();
  for (const r of [a.driver, ...a.pair]) who.set(`${normEmail(r.lead.email)}|${s(r.lead.phone)}`, { email: r.lead.email, phone: r.lead.phone });
  for (const w of who.values()) {
    const bl = await Promise.resolve(io.blacklistCheck(w)).catch((e) => ({ error: e.message }));
    if (bl && bl.hit) return { ...base, result: 'stopped', why: 'on the Not Wanted list' };
    if (bl && bl.error) return { ...base, result: 'error', why: `the Not Wanted list could not be checked (${bl.error})` };
  }
  if (dryRun) return { ...base, result: 'due', n: plan.n, dueAt: plan.dueAt };

  const r = REMINDERS.find((x) => x.n === plan.n);
  const leadId = a.driver.id;
  let msg;
  try { msg = reminderEmail(lead, r.n); } catch (err) { return { ...base, result: 'error', why: `the email could not be built: ${err.message}` }; }

  // 1. The claim — the record that this reminder is going out (before the email).
  let mine;
  try {
    mine = await io.postNote(leadId, `⏰ <b>${claimText(r.n)}</b> to ${escHtml(lead.email)} — ${r.label} after the booking invite; they have not booked yet. `
      + 'Setting an Outcome on this lead stops the reminders.');
  } catch (err) { return { ...base, result: 'error', why: `the reminder note could not be posted (${err.message}) — nothing was sent` }; }

  // 2. Only the earliest open claim sends (a second app instance may have claimed too,
  //    on this row or on another of the person's rows).
  try {
    const after = [];
    for (const row of a.rows) { const n = await io.readNotes(row.id); if (n) after.push(...n); }
    const open = openClaims(after, r.n, a.ep.anchor);
    if (open.length && open[0].id !== mine && open.some((x) => x.id === mine)) {
      await Promise.resolve(io.deleteNote(mine)).catch(() => {});
      return { ...base, result: 'lost-race', n: r.n };
    }
  } catch (_) { /* cannot re-read: our claim stands, send */ }

  // 3. The email.
  try {
    await io.sendEmail(msg);
  } catch (err) {
    await Promise.resolve(io.postNote(leadId, `⚠️ <b>${failText(r.n)}</b> — the email could not be sent: ${escHtml(String(err.message || err).slice(0, 200))}. The app tries again within the hour (up to ${MAX_TRIES} tries).`))
      .catch((e) => io.warn(`[BookingReminders] failure note also failed for ${leadId}: ${e.message}`));
    return { ...base, result: 'failed', n: r.n, why: err.message };
  }
  // 4. The copy of the record on the person's other invited rows (best-effort).
  for (const row of a.pair) {
    if (row.id === leadId) continue;
    await Promise.resolve(io.postNote(row.id, `⏰ ${copyText(r.n)} ${escHtml(leadId)} to ${escHtml(lead.email)} (the same person) — no reminder goes from this lead.`))
      .catch((e) => io.warn(`[BookingReminders] copy note failed on lead ${row.id}: ${e.message}`));
  }
  io.log(`[BookingReminders] reminder ${r.n} emailed for lead ${leadId}`);
  return { ...base, result: 'sent', n: r.n };
}

/**
 * One person's lead rows: this lead plus every lead with the same email (a
 * Monday search — the shared list snapshot deliberately carries no client
 * emails), newest first, capped. Throws when the search fails.
 */
async function personRows(leadId, email, now = io.now()) {
  const leads = new Map();
  const ids = [String(leadId)];
  const e = s(email);
  if (e) {
    // Monday's Email search ignores letter case (checked on the live board 2026-10-28), not spaces.
    for (const l of (await io.rowsByEmail(e)) || []) if (l && normEmail(l.email) === normEmail(e)) leads.set(String(l.id), l);
    // Rows invited lately first (never capped away — two of them may hold this
    // pair's record), then the newest.
    const oldest = torontoDay(now - (CANDIDATE_MAX_AGE_DAYS + 2) * DAY);
    const recent = (l) => (s(l.bookingInvite) === 'Sent' && s(l.inviteSentAt).slice(0, 10) >= oldest ? 1 : 0);
    const order = [...leads.values()].sort((x, y) => (recent(y) - recent(x))
      || (Date.parse(s(y.createdAt)) || 0) - (Date.parse(s(x.createdAt)) || 0) || (Number(y.id) - Number(x.id)));
    ids.push(...order.map((l) => String(l.id)));
  }
  return { ids: [...new Set(ids)].slice(0, MAX_PERSON_ROWS), leads };
}

let _running = false, _previewing = false;   // a preview never holds up the hourly run

/**
 * Every invited person, one at a time. Never throws.
 * @returns {Promise<{ ok: boolean, skipped?: string, candidates?: number, results?: object[] }>}
 */
async function runOnce({ dryRun = false } = {}) {
  if (!enabled() && !dryRun) return { ok: true, skipped: 'switched off (BOOKING_REMINDERS)' };
  if (dryRun ? _previewing : _running) return { ok: true, skipped: `a ${dryRun ? 'preview' : 'run'} is already in progress` };
  if (dryRun) _previewing = true; else _running = true;
  try {
    const now = io.now();
    let leads;
    try { leads = await io.snapshot(); }
    catch (err) { io.warn(`[BookingReminders] the Lead Board could not be read: ${err.message}`); return { ok: false, error: err.message }; }
    const candidates = (leads || []).filter((l) => isCandidate(l, now)).map((l) => String(l.id));
    const done = new Set(), results = [];
    let people = 0;
    for (const id of candidates) {
      if (done.has(id)) continue;      // already read as another row of a person checked this run
      people++;
      let ids = [id], preloaded = new Map();
      try {
        const lead = await io.getLead(id);
        const p = await personRows(id, lead && lead.email, now);
        ids = p.ids; preloaded = p.leads;
        if (lead) preloaded.set(id, lead);
      } catch (err) {
        results.push({ leadId: id, ids, result: 'error', why: `could not look up the person's other leads: ${err.message}` });
        done.add(id);
        continue;
      }
      ids.forEach((x) => done.add(x));
      results.push(await remindPerson(ids, { dryRun, preloaded }).catch((err) => ({ leadId: id, ids, result: 'error', why: err.message })));
    }
    const sent = results.filter((x) => x.result === 'sent').length;
    const failed = results.filter((x) => x.result === 'failed' || x.result === 'error').length;
    if (sent || failed) io.log(`[BookingReminders] ${dryRun ? 'preview' : 'run'}: ${people} person(s) checked, ${sent} reminder(s) sent, ${failed} problem(s)`);
    return { ok: true, enabled: enabled(), candidates: people, results };
  } finally { if (dryRun) _previewing = false; else _running = false; }
}

/**
 * For the lead page: where this person's reminders stand (one line). Never throws.
 */
async function describeForLead(lead) {
  try {
    if (!lead || s(lead.bookingInvite) !== 'Sent') return '';
    const now = io.now();
    // Nothing can still be due past this — and the page should not pay for the reads.
    if (!(s(lead.inviteSentAt).slice(0, 10) >= torontoDay(now - (CANDIDATE_MAX_AGE_DAYS + 2) * DAY))) return '';
    const p = await personRows(lead.id, lead.email, now).catch(() => ({ ids: [String(lead.id)], leads: new Map() }));
    p.leads.set(String(lead.id), lead);
    const a = await assessPerson(p.ids, now, p.leads);
    const plan = a.plan;
    if (plan.state === 'no-invite') return '';
    const when = (ms) => new Date(ms).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const nth = (n) => (n === 1 ? '1st' : '2nd');
    const parts = plan.sent.map((x) => `${nth(x.n)} emailed ${when(x.at)}`);
    if (plan.skipped.length) parts.push(`${plan.skipped.map(nth).join(' and ')} not sent (too late)`);
    if (plan.gaveUp.length) parts.push(`${plan.gaveUp.map(nth).join(' and ')} failed ${MAX_TRIES} times`);
    if (a.stop) { if (plan.state === 'due' || plan.state === 'waiting') parts.push(`stopped — ${a.stop}`); }
    else if (!enabled()) parts.push('switched off');
    else if (plan.state === 'waiting') parts.push(`${nth(plan.n)} due ${when(plan.dueAt)}`);
    else if (plan.state === 'due') parts.push(`${nth(plan.n)} going out within the hour`);
    if (a.rows.length > 1 && parts.length) parts.push(a.driver && a.driver.id !== String(lead.id)
      ? `this person has ${a.rows.length} lead rows — the reminders go from lead ${a.driver.id}`
      : `this person has ${a.rows.length} lead rows — counted once`);
    return parts.join(' · ');
  } catch (_) { return ''; }
}

module.exports = {
  runOnce, remindPerson, describeForLead, enabled,
  // pure rules, exported for tests
  planFor, episodeOf, stopReason, progressReason, isCandidate, personRows, reminderEmail, openClaims, torontoNine, torontoWallToUtc,
  REMINDERS, LATE_LIMIT_MS, QUIET_AFTER_INVITE_MS, EPISODE_MS, MAX_TRIES, claimText, failText, copyText, inviteAddress,
  io,
};
