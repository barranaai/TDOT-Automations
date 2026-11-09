'use strict';

/**
 * Is this Lead Board row a DIRECT CONSULTATION — one staff added by hand with
 * "＋ Direct consultation" on the Consultations page, because it was booked
 * outside the app (Melanie books most consultations in Square)? (step 2, 2026-11-09)
 *
 * Two markers, both written by the app only:
 *   - the "Direct Consultation" column (newLeadsBoard.json key `directConsult`):
 *     New / Follow-up / Existing client — the server works it out;
 *   - consultOption.directConsult: { kind, inSquare, followUpOf, caseRef, by }.
 *
 * What the markers switch off is read from the ROW, never from the
 * DIRECT_CONSULTATION switch: a row made while the switch was on stays quiet
 * after it is turned off.
 *
 * FAILS CLOSED: a row with either marker gets no client reminder unless
 * `inSquare === false` is read explicitly (staff said it is NOT booked in
 * Square, so nobody else reminds the client); an unreadable consultOption that
 * still names directConsult counts as marked. The column id may be empty (the
 * Monday column not made yet): nothing fails at load — the consultOption marker
 * still works, and a write that needs the column refuses (notSetUp, 503).
 * PURE except columnId(), which reads the board config.
 */

const KINDS = ['New', 'Follow-up', 'Existing client'];
const EXISTING = 'Existing client';

const s = (v) => String(v == null ? '' : v).trim();

/** The Monday column id, '' while the column is not made yet. Read at use, never cached. */
function columnId() { return s(require('../data/newLeadsBoard.json').columns.directConsult); }
function isSetUp() { return !!columnId(); }

/** The refusal for anything that must write the column while it is not set up (the endpoints answer 503). */
function notSetUpError() {
  const err = new Error('Direct consultation is not set up yet: its Lead Board column has not been made. Nothing was saved.');
  err.status = 503;
  err.code = 'DIRECT_CONSULT_NOT_SET_UP';
  return err;
}
function assertSetUp() { if (!isSetUp()) throw notSetUpError(); }

/**
 * The consultOption marker: { marked, detail }. detail is the stored object, or
 * null when the JSON cannot be read (marked then only if the text names the key).
 */
function optionMarker(lead) {
  const raw = s(lead && lead.consultOption);
  if (!raw) return { marked: false, detail: null };
  let o;
  try { o = JSON.parse(raw); } catch (_) { return { marked: /directConsult/.test(raw), detail: null }; }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Object.prototype.hasOwnProperty.call(o, 'directConsult')) return { marked: false, detail: null };
  const d = o.directConsult;
  if (d === null || d === undefined || d === false || d === '') return { marked: false, detail: null };
  return { marked: true, detail: (d && typeof d === 'object' && !Array.isArray(d)) ? d : null };
}

function isDirectConsult(lead) {
  return !!s(lead && lead.directConsult) || optionMarker(lead).marked;
}

/** 'New' | 'Follow-up' | 'Existing client' | '' (not direct, or no kind readable). */
function kindOf(lead) {
  const col = s(lead && lead.directConsult);
  if (KINDS.includes(col)) return col;
  const { detail } = optionMarker(lead);
  const k = s(detail && detail.kind);
  return KINDS.includes(k) ? k : '';
}

/**
 * The client's booking reminders (24 h, 1 h) and the pre-consultation form chase.
 * Any non-direct row: yes. A direct row: only when inSquare === false is read.
 */
function clientRemindersAllowed(lead) {
  if (!isDirectConsult(lead)) return true;
  const { detail } = optionMarker(lead);
  return !!detail && detail.inSquare === false;
}

/**
 * The internal post-consultation nudge ("set the Outcome"). Existing-client rows
 * never get it (about their current file — no outcome). A direct row whose kind
 * cannot be read gets none either (fail closed).
 */
function nudgeAllowed(lead) {
  if (!isDirectConsult(lead)) return true;
  const col = s(lead && lead.directConsult);
  const { detail } = optionMarker(lead);
  const k = s(detail && detail.kind);
  if (col === EXISTING || k === EXISTING) return false;
  return KINDS.includes(col) || KINDS.includes(k);
}

module.exports = {
  KINDS, EXISTING, columnId, isSetUp, notSetUpError, assertSetUp,
  optionMarker, isDirectConsult, kindOf, clientRemindersAllowed, nudgeAllowed,
};
