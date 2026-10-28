'use strict';

/**
 * The Leads list's "Current status" (Faran 2026-10-28): where the lead is WITH
 * US — not their immigration status. One line per lead, the latest thing that
 * happened:
 *   an Outcome (Retain / Follow-Up / Newsletter / Not Wanted)  — always wins;
 *   Booked (also booked by hand), Paid / fee waived — not booked yet,
 *   Booking in progress (a time held while they pay);
 *   otherwise the LATEST of: Invite sent · 1st reminder sent · 2nd reminder sent ·
 *   a remark from "Outcome & remarks" (its preset, e.g. "No answer / voicemail") ·
 *   Booking not finished (a held time ran out) · Expired (no booking 7 days
 *   after the first invite — both reminders are over by then);
 *   Invite failed / Invite sending; New (nothing yet).
 *
 * The invite, the reminders and the remarks live in the lead's NOTES. Reading
 * every lead's notes per page load is far too slow, so this keeps a copy of the
 * Lead Board's recent notes (one board-wide read, newest first — 1,000 notes
 * ≈ 8 days ≈ 13 s on 2026-10-28): a first read back HORIZON_DAYS at boot, then
 * every 10 minutes only the new ones, and a full re-read every 6 hours. The app's
 * own invite / reminder / remark writes are added at once (record()). Until the
 * first read finishes, the list shows what the lead's columns alone say.
 * Read-only on Monday.
 */

const { canonicalOutcome } = require('../../config/outcomes');

const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const HORIZON_DAYS   = 45;
const PAGE           = 100;
const MAX_PAGES_FULL = 70;
const MAX_PAGES_STEP = 15;
const FULL_EVERY_MS  = 6 * HOUR;
const EXPIRE_AFTER_MS = 7 * DAY;     // no booking 7 days after the first invite (reminders at 2 and 5 days)

const s = (v) => String(v == null ? '' : v).trim();
const INVITE_RE = /Booking invite emailed|Booking invite email WAS DELIVERED/i;
const REMARK_RE = /^\s*📝\s*\[Remark(?:\s*·\s*([^\]]*))?\]\s*([\s\S]*)$/;

/** The side effects behind one seam (tests replace them). */
const io = {
  now: () => Date.now(),
  async fetchPage(page) {
    const { leadBoardId } = require('../../config/monday');
    const d = await require('./mondayApi').query(
      `query($b:[ID!]){ boards(ids:$b){ updates(limit:${PAGE}, page:${page}){ id item_id created_at text_body } } }`,
      { b: [String(leadBoardId)] });
    return (d && d.boards && d.boards[0] && d.boards[0].updates) || [];
  },
  warn: (m) => console.warn(m),
  log: (m) => console.log(m),
};

// ─── The notes copy ──────────────────────────────────────────────────────────

let _byItem = new Map();   // itemId → { invites: [ms], rem: {1:{claims,fails,copies}, 2:{…}}, remark: {label, by, at} }
let _seen = new Set();     // note ids already applied
let _at = 0, _fullAt = 0, _inFlight = null;

function entry(map, itemId) {
  const k = String(itemId);
  if (!map.has(k)) map.set(k, { invites: [], rem: { 1: { claims: [], fails: [], copies: [] }, 2: { claims: [], fails: [], copies: [] } }, remark: null });
  return map.get(k);
}

/** What one note says, for the status ('' kinds are ignored). */
function classify(text) {
  const t = s(text);
  if (INVITE_RE.test(t)) return { kind: 'invite' };
  const BR = require('./bookingRemindersService');
  for (const n of [1, 2]) {
    if (t.includes(BR.failText(n))) return { kind: 'fail', n };
    if (t.includes(BR.copyText(n))) return { kind: 'copy', n };
    if (t.includes(BR.claimText(n))) return { kind: 'claim', n };
  }
  const m = REMARK_RE.exec(t);
  if (m) {
    const rest = s(m[2]);
    const { REMARK_PRESETS } = require('../../config/leadRemarks');
    const preset = REMARK_PRESETS.find((p) => rest === p.label || rest.startsWith(`${p.label} — `));
    const label = preset ? preset.label : (rest ? `Remark: ${rest.length > 40 ? `${rest.slice(0, 39)}…` : rest}` : 'Remark');
    return { kind: 'remark', label, by: s(m[1]), text: rest.slice(0, 300) };
  }
  return { kind: '' };
}

function apply(map, itemId, at, c) {
  if (!c.kind || !Number.isFinite(at)) return;
  const e = entry(map, itemId);
  if (c.kind === 'invite') e.invites.push(at);
  else if (c.kind === 'remark') { if (!e.remark || at >= e.remark.at) e.remark = { label: c.label, by: c.by, at, text: c.text || '' }; }
  else e.rem[c.n][{ claim: 'claims', fail: 'fails', copy: 'copies' }[c.kind]].push(at);
}

/**
 * Read the board's notes newest first. full: back to the horizon; otherwise
 * until a note already seen. Never throws (the list keeps the last copy).
 */
function refresh({ full = false } = {}) {
  if (_inFlight) return _inFlight;
  const now = io.now();
  const doFull = full || !_at || now - _fullAt > FULL_EVERY_MS;
  _inFlight = (async () => {
    const horizon = now - HORIZON_DAYS * DAY;
    const map = doFull ? new Map() : _byItem;
    const seen = doFull ? new Set() : _seen;
    let pages = 0, overlap = false, reachedEnd = false;
    const cap = doFull ? MAX_PAGES_FULL : MAX_PAGES_STEP;
    for (let page = 1; page <= cap; page++) {
      const ups = await io.fetchPage(page);
      pages++;
      if (!ups.length) { reachedEnd = true; break; }
      let old = false;
      for (const u of ups) {
        const id = s(u.id);
        if (!doFull && _seen.has(id)) { overlap = true; continue; }
        if (seen.has(id)) continue;                 // a page that shifted while reading
        const at = Date.parse(s(u.created_at));
        if (at < horizon) { old = true; continue; }
        seen.add(id);
        apply(map, u.item_id, at, classify(u.text_body));
      }
      if (overlap || old) break;
    }
    if (!doFull && !overlap && !reachedEnd) {
      // More new notes than one step reads — start over from a full read next time.
      _fullAt = 0;
    }
    if (doFull) { _byItem = map; _seen = seen; _fullAt = now; }
    _at = now;
    return { ok: true, full: doFull, pages, leads: _byItem.size };
  })().catch((err) => { io.warn(`[LeadStatus] the notes could not be read: ${err.message}`); return { ok: false, error: err.message }; })
    .finally(() => { _inFlight = null; });
  return _inFlight;
}

/** The app's own writes, added at once (the next read brings the real note too). */
function record(itemId, text, at = io.now()) {
  try { apply(_byItem, itemId, at, classify(text)); } catch (_) { /* never in the way of the write */ }
}

/** What the notes copy holds for one lead (null = nothing / not read yet). */
const activityFor = (itemId) => _byItem.get(String(itemId)) || null;
const ready = () => _at > 0;

// ─── The status ──────────────────────────────────────────────────────────────

/** Was the lead booked by hand (status never set to "Booked")? The signs a booking leaves. */
function bookedByHand(l) {
  const st = s(l.bookingStatus);
  return !!((s(l.bookedSlot) && st !== 'Slot Held' && st !== 'Abandoned') || s(l.consultationHeld) || s(l.meetingLink)
    || s(l.squareBookingId) || s(l.consultAgreementSent) || s(l.preConsultSubmitted) === 'Yes');
}

/**
 * The lead's current status. Pure.
 * @returns {{ key: string, label: string, at: number|null, tone: 'green'|'blue'|'amber'|'red'|'grey', by?: string }}
 */
function leadStatus(l, act, now) {
  const oc = canonicalOutcome(l.outcome) || s(l.outcome);
  if (oc) {
    const at = Date.parse(s(l.outcomeChangedAt));
    return { key: 'outcome', label: `Outcome: ${oc}`, at: Number.isFinite(at) ? at : null,
      tone: { Retain: 'green', 'Follow-Up': 'amber', Newsletter: 'grey', 'Not Wanted': 'red' }[oc] || 'grey' };
  }
  const st = s(l.bookingStatus);
  if (st === 'Booked' || bookedByHand(l)) return { key: 'booked', label: 'Booked', at: null, tone: 'green', slot: s(l.bookedSlot) };
  if (s(l.squareConsultTxnId)) return { key: 'paid', label: 'Paid — no time booked yet', at: null, tone: 'green' };
  if (s(l.consultPayment)) {
    let waived = false; try { waived = JSON.parse(s(l.consultPayment)).kind === 'waived'; } catch (_) { /* recorded */ }
    return { key: 'paid', label: waived ? 'Fee waived — no time booked yet' : 'Fee recorded — no time booked yet', at: null, tone: 'green' };
  }
  if (st === 'Slot Held' && Date.parse(s(l.slotHeldUntil)) > now) return { key: 'holding', label: 'Booking in progress', at: null, tone: 'blue' };

  // The latest of the dated events.
  const events = [];
  const invited = s(l.bookingInvite) === 'Sent';
  const BR = require('./bookingRemindersService');
  const invites = act ? act.invites.slice().sort((a, b) => a - b) : [];
  let ep = null;
  if (invited || invites.length) {
    ep = BR.episodeOf(invites.map((at) => ({ at, text: 'Booking invite emailed' })), invited ? s(l.inviteSentAt).slice(0, 10) : '');
  }
  const lastInvite = ep ? ep.lastInvite : NaN;   // a resend whose note was lost counts by its Booking Invite date
  if (Number.isFinite(lastInvite) && (invited || invites.length)) events.push({ key: 'invite', label: 'Invite sent', at: lastInvite, tone: 'blue' });
  if (act && ep) {
    for (const n of [1, 2]) {
      const r = act.rem[n];
      const inPair = (xs) => xs.filter((t) => t >= ep.anchor);
      const claims = inPair(r.claims), fails = inPair(r.fails), copies = inPair(r.copies);
      if (claims.length > fails.length || copies.length) {
        events.push({ key: `reminder${n}`, label: n === 1 ? '1st reminder sent' : '2nd reminder sent', at: Math.max(...claims, ...copies), tone: 'amber' });
      }
    }
  }
  if (act && act.remark) events.push({ key: 'remark', label: act.remark.label, at: act.remark.at, tone: 'grey', by: act.remark.by, detail: act.remark.text || '' });
  if (st === 'Abandoned') {
    const at = Date.parse(s(l.slotHeldUntil));
    events.push({ key: 'abandoned', label: 'Booking not finished', at: Number.isFinite(at) ? at : 0, tone: 'amber' });
  }
  if (ep && invited && now >= ep.anchor + EXPIRE_AFTER_MS) events.push({ key: 'expired', label: 'Expired', at: ep.anchor + EXPIRE_AFTER_MS, tone: 'red' });
  if (events.length) return events.reduce((a, b) => (b.at >= a.at ? b : a));
  if (s(l.bookingInvite) === 'Failed') return { key: 'invite-failed', label: 'Invite failed', at: null, tone: 'red' };
  if (s(l.bookingInvite) === 'Send') return { key: 'invite-sending', label: 'Invite sending', at: null, tone: 'blue' };
  return { key: 'new', label: 'New', at: null, tone: 'grey' };
}

module.exports = {
  refresh, record, activityFor, ready, leadStatus, bookedByHand, classify,
  EXPIRE_AFTER_MS, HORIZON_DAYS,
  io,
  _reset: () => { _byItem = new Map(); _seen = new Set(); _at = 0; _fullAt = 0; _inFlight = null; },
};
