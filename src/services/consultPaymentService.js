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
      on: DAY_RE.test(String(o.on || '')) ? String(o.on) : '',
      reference: oneLine(o.reference).slice(0, MAX_REF),
      note: oneLine(o.note).slice(0, MAX_NOTE),
      by: oneLine(o.by).slice(0, 60),
      at: String(o.at || ''),
      verified: o.verified === true,
    };
  } catch (_) { return null; }
}

/**
 * The page's payload → what may be written. `{ kind: 'clear' }` removes a record.
 * The date defaults to today (Toronto); a future day, an impossible day or a day
 * before 2020 is refused. A paid kind needs an amount; "waived" never has one.
 */
function validateRecord(value, { today = torontoToday() } = {}) {
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
  return { ok: true, normalized: { kind, amountCents, on, reference, note } };
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

module.exports = { KINDS, MAX_CENTS, MAX_NOTE, MAX_REF, parseConsultPayment, validateRecord, describe, paidState, isRealDay, torontoToday };
