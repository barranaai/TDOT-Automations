'use strict';

/**
 * consultPaymentService — a consultation fee settled OUTSIDE the booking link.
 *
 * Gauri point 4, part 2 (Faran 2026-10-15): the Consultations page read "paid"
 * from the app's own Square payment alone (squareConsultTxnId). A client who
 * paid by cash or e-transfer, through an invoice the team sent themselves, or
 * whose fee was waived showed as not paid, and the KPI revenue missed them.
 * Staff now record that on the lead ("Record payment / Waived") in ONE text
 * column, Consultation Payment (text_mm8533r9), as JSON this module alone
 * writes and reads.
 *
 * It is a RECORD and nothing more: no email, no consultation package and no
 * booking step runs because of it (same rule as a hand-booked payment). A fee
 * paid through the booking link needs no record and cannot get one — the app's
 * payment is the truth there; a refund is done in Square.
 */

const KINDS = { cash: 'Cash', 'e-transfer': 'E-transfer', invoice: 'Invoice sent by the team', other: 'Other', waived: 'Waived' };
// The consultation package on a record (Gauri 2026-10-08, Faran 2026-10-16): 'send' =
// email the agreement + pre-consultation form; 'skip' = staff chose not to (a paid
// client who already has them, or a waived fee). '' = never asked (a record made
// before this, or with the switch off) — such a record never sends anything.
const PACKAGE_CHOICES = ['send', 'skip'];
const MEETING_TYPES = ['In-person', 'Virtual', 'Phone Call'];
const MAX_BOOK_DAYS = 365;
const MAX_CENTS = 2000000;            // $20,000 — a typo guard (a consultation fee is ~$200), not a business rule
const MAX_NOTE = 200, MAX_REF = 120;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Exactly one of the five kinds — an own key, so 'constructor' / 'toString' / '__proto__' are not kinds (review 2026-10-15). */
const isKind = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(KINDS, k);
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const bad = (error) => ({ ok: false, error });
const dollars = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

function torontoToday() { return require('../utils/torontoTime').torontoDay(new Date().toISOString()); }

/** 'YYYY-MM-DD' that names a real day (2026-02-30 is not one). */
function isRealDay(s) {
  if (!DAY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** The record on the lead, or null (blank, legacy or corrupt — never a throw). */
function parseConsultPayment(lead) {
  try {
    const o = JSON.parse(String((lead && lead.consultPayment) || ''));
    if (!o || typeof o !== 'object' || !isKind(o.kind)) return null;
    const a = Number(o.amountCents);
    return {
      kind: o.kind,
      amountCents: o.kind === 'waived' ? 0 : (Number.isInteger(a) && a > 0 ? a : 0),
      hstCents: (typeof o.hstCents === 'number' && Number.isInteger(o.hstCents) && o.hstCents >= 0) ? o.hstCents : null,   // fixed at record time; null on older records
      on: DAY_RE.test(String(o.on || '')) ? String(o.on) : '',
      reference: oneLine(o.reference).slice(0, MAX_REF),
      note: oneLine(o.note).slice(0, MAX_NOTE),
      by: oneLine(o.by).slice(0, 60),
      at: String(o.at || ''),
      verified: o.verified === true,
      package: PACKAGE_CHOICES.includes(o.package) ? o.package : '',
      packageNote: oneLine(o.packageNote).slice(0, MAX_NOTE),
    };
  } catch (_) { return null; }
}

/** Toronto now as 'YYYY-MM-DD HH:MM' (the booked-slot shape). */
function torontoNowWall() { return require('../utils/torontoTime').torontoWallClock(new Date().toISOString()); }

/**
 * The consultation booking staff type when they record the fee (the client was
 * booked by hand — the app had no time, consultant or meeting type). PURE.
 * The time must be in the future (the package is for BEFORE the consultation)
 * and the length one the chosen consultant offers.
 * @returns {{ ok: true, booking: { slot, date, time, consultant, meetingType, durationMin } } | { ok: false, error }}
 */
function validateBooking(b, { nowWall = torontoNowWall(), allowPast = false } = {}) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('Invalid consultation booking.');
  const date = String(b.date == null ? '' : b.date).trim();
  const time = String(b.time == null ? '' : b.time).trim();
  if (!isRealDay(date)) return bad('Enter the consultation date.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return bad('Enter the consultation time (HH:MM, Toronto time).');
  const slot = `${date} ${time}`;
  const past = slot <= nowWall;
  if (past && !allowPast) return bad('That consultation time has already passed, so the package cannot be emailed for it. Choose "No", or enter the new time if the client was re-booked.');
  const [y, m, d] = date.split('-').map(Number);
  const [ny, nm, nd] = String(nowWall).slice(0, 10).split('-').map(Number);
  if ((Date.UTC(y, m - 1, d) - Date.UTC(ny, nm - 1, nd)) / 86400000 > MAX_BOOK_DAYS) return bad('That consultation date looks wrong (more than a year ahead).');
  const consultant = String(b.consultant == null ? '' : b.consultant).trim();
  const reg = Object.values(require('../../config/consultantRouting').CONSULTANTS).find((c) => c.name === consultant);
  if (!reg) return bad('Choose the consultant.');
  const meetingType = String(b.meetingType == null ? '' : b.meetingType).trim();
  if (!MEETING_TYPES.includes(meetingType)) return bad('Choose how the consultation happens: in person, video or phone.');
  const durations = require('../../config/consultantRouting').consultOptionsFor(reg).map((o) => o.durationMin);
  const durationMin = typeof b.durationMin === 'number' ? b.durationMin : (/^\d+$/.test(String(b.durationMin == null ? '' : b.durationMin).trim()) ? Number(String(b.durationMin).trim()) : NaN);
  if (!durations.includes(durationMin)) return bad(`Choose the length: ${durations.join(' or ')} minutes with ${consultant}.`);
  return { ok: true, booking: { slot, date, time, consultant, meetingType, durationMin, ...(past ? { past: true } : {}) } };
}

/**
 * The page's payload → what may be written. `{ kind: 'clear' }` removes a record.
 * The date defaults to today (Toronto); a future day, an impossible day or a day
 * before 2020 is refused. A paid kind needs an amount; "waived" never has one.
 */
function validateRecord(value, { today = torontoToday(), nowWall } = {}) {
  let o = value;
  try { if (typeof value === 'string') o = JSON.parse(value); } catch (_) { return bad('Invalid payment payload.'); }
  if (!o || typeof o !== 'object') return bad('Invalid payment payload.');
  const kind = String(o.kind || '').trim();
  if (kind === 'clear') return { ok: true, normalized: { kind: 'clear' } };
  if (!isKind(kind)) return bad('Choose how the fee was settled: cash, e-transfer, invoice, other, or waived.');
  const reference = oneLine(o.reference);
  if (reference.length > MAX_REF) return bad(`Keep the reference under ${MAX_REF} characters.`);
  const note = oneLine(o.note);
  if (note.length > MAX_NOTE) return bad(`Keep the note under ${MAX_NOTE} characters.`);
  let amountCents = 0;
  if (kind !== 'waived') {
    // A number, or a string of digits (a form field) — never a boolean, an array or
    // an exponent that Number() would quietly turn into cents.
    const raw = o.amountCents;
    const a = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\d+$/.test(raw.trim())) ? Number(raw.trim()) : NaN;
    if (!Number.isInteger(a) || a <= 0 || a > MAX_CENTS) return bad('Enter the fee received, in dollars and cents (up to $20,000).');
    amountCents = a;
  }
  const on = String(o.on == null ? '' : o.on).trim() || today;
  if (!isRealDay(on)) return bad('Enter the date received as YYYY-MM-DD.');
  if (on > today) return bad('The date received cannot be in the future.');
  if (on < '2020-01-01') return bad('The date received looks wrong (before 2020).');
  // The package choice and the booking (2026-10-16). Whether a choice is REQUIRED
  // depends on the lead and the switch — applyAction decides; here only the shape.
  const pkg = String(o.package == null ? '' : o.package).trim();
  if (pkg && !PACKAGE_CHOICES.includes(pkg)) return bad('Choose whether to email the consultation agreement and form.');
  const packageNote = oneLine(o.packageNote);
  if (packageNote.length > MAX_NOTE) return bad(`Keep the reason under ${MAX_NOTE} characters.`);
  let booking = null;
  if (o.booking != null) {
    // A past time is refused only when the package is to be emailed; with "No" it is
    // kept as `past` (the record says so, the booking is left alone — review 2026-10-16).
    const b = validateBooking(o.booking, { ...(nowWall ? { nowWall } : {}), allowPast: pkg !== 'send' });
    if (!b.ok) return b;
    booking = b.booking;
  }
  return { ok: true, normalized: { kind, amountCents, on, reference, note, package: pkg, packageNote, booking } };
}

/** One line for notes and messages: "Cash $200.00 received 2026-10-15 by Melanie (name as typed) · ref 123 · note: …". */
function describe(rec) {
  if (!rec) return '';
  const who = rec.by ? ` by ${rec.by}${rec.verified ? '' : ' (name as typed)'}` : '';
  const head = rec.kind === 'waived'
    ? `Waived${rec.on ? ` on ${rec.on}` : ''}${who}`
    : `${KINDS[rec.kind] || rec.kind} ${rec.amountCents > 0 ? dollars(rec.amountCents) : '(amount not recorded)'}${rec.on ? ` received ${rec.on}` : ''}${who}`;
  return head + (rec.reference ? ` · ref ${rec.reference}` : '') + (rec.note ? ` · note: ${rec.note}` : '');
}

/**
 * How this consultation's fee stands — ONE answer for the list, the detail page
 * and the KPIs. paid: 'app' (the booking link's Square payment) | a kind recorded
 * by staff | '' (nothing yet). The app's payment outranks a record (a record is
 * kept in `record` so the page can say it is there).
 */
function paidState(lead) {
  const txn = String((lead && lead.squareConsultTxnId) || '').trim();
  let opt = null;
  try { opt = JSON.parse(String((lead && lead.consultOption) || '')); } catch (_) { /* legacy / none */ }
  const num = (v) => (opt && Number.isFinite(Number(v)) ? Number(v) : null);
  const feeCents = opt ? num(opt.feeCents) : null;
  const record = parseConsultPayment(lead);
  const blank = { paid: '', paidCents: null, on: '', by: '', verified: false, reference: '', note: '', at: '', feeCents, record };
  if (txn) return { ...blank, paid: 'app', paidCents: opt ? num(opt.paidCents) : null, verified: true };
  if (!record) return blank;
  return {
    ...blank, paid: record.kind,
    paidCents: record.kind === 'waived' ? 0 : (record.amountCents > 0 ? record.amountCents : null),
    on: record.on, by: record.by, verified: record.verified, reference: record.reference, note: record.note, at: record.at,
  };
}

module.exports = { KINDS, MAX_CENTS, MAX_NOTE, MAX_REF, PACKAGE_CHOICES, MEETING_TYPES, parseConsultPayment, validateRecord, validateBooking, describe, paidState, isRealDay, torontoToday, torontoNowWall };
