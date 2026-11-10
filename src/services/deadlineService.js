'use strict';

/**
 * The client's deadline, asked when they are retained (team meeting 2026-11-05, Gauri):
 *   Deadline type  — "Deadline" (a real one: the actual date) or "Imaginary" (none — a date
 *                    promised to the client instead).
 *   Actual deadline — the real date (type Deadline).
 *   Promised submission date — the date promised to the client (type Imaginary; optional
 *                    alongside a real deadline).
 * Asked on the staff Add-lead form (optional there), the direct-retainer form (required) and
 * at the consultation outcome Retain (required); shown and editable on the lead page and the
 * record page; carried to the case row when it opens (Deadline Type / Actual Deadline /
 * Internal Deadline — the columns the team already keeps by hand) and kept in step from then
 * on. Later blocks read it: reminder tone and cadence, the Deadlines view (half-month windows,
 * phase = month), the slide rule when documents come late.
 *
 * Switch: DEADLINE_REQUIRED — on by default; 0/off/false/no makes the question optional
 * everywhere (read at call time, so a Render change needs no restart).
 */

const TYPE_REAL = 'Deadline', TYPE_IMAGINARY = 'Imaginary';
const TYPES = Object.freeze([TYPE_REAL, TYPE_IMAGINARY]);

function required() {
  return !/^(0|off|false|no)$/i.test(String(process.env.DEADLINE_REQUIRED || '').trim());
}

/** Monday's Lead-board column keys (src/data/newLeadsBoard.json) and the case's (clientMasterBoard.json deadlineColumns). */
const LEAD_KEYS = Object.freeze(['deadlineType', 'actualDeadline', 'promisedSubmissionDate']);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const torontoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());

/** A real calendar day, YYYY-MM-DD, or ''. */
function cleanDay(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 10);
  if (!DAY.test(s)) return '';
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? s : '';
}

/**
 * Check one answer. Input may be loose (a form body); output is exact or an error.
 *   { ok:true, type, actualDeadline, promisedSubmissionDate, blank }  blank = nothing given at all
 *   { ok:false, error }
 * Rules: type Deadline needs the actual date (a promised date may ride along); type Imaginary
 * needs the promised date and no actual date; a date is never in the past; required (the switch)
 * means a blank answer is refused with `missingMessage`.
 * `keepPromised` (the change-deadline pop-up only): the promised date ALREADY stored on the case.
 * Riding along a real deadline unchanged it is not a date being set, so it is not refused for
 * being in the past (otherwise the actual date of such a case could only be changed by wiping it).
 */
function validate(input = {}, { required: req = required(), today = torontoToday(), missingMessage = 'Set the deadline: is there a real deadline, or a promised submission date?', keepPromised = '' } = {}) {
  const type = String((input && (input.deadlineType != null ? input.deadlineType : input.type)) || '').trim();
  const rawActual = input && (input.actualDeadline != null ? input.actualDeadline : input.actual);
  const rawPromised = input && (input.promisedSubmissionDate != null ? input.promisedSubmissionDate : input.promised);
  const actualGiven = String(rawActual == null ? '' : rawActual).trim() !== '';
  const promisedGiven = String(rawPromised == null ? '' : rawPromised).trim() !== '';
  const blank = !type && !actualGiven && !promisedGiven;
  const bad = (error) => ({ ok: false, error });
  if (blank) return req ? bad(missingMessage) : { ok: true, blank: true, type: '', actualDeadline: '', promisedSubmissionDate: '' };
  if (!TYPES.includes(type)) return bad('Choose the deadline type: a real deadline, or imaginary (a promised submission date).');
  const actual = actualGiven ? cleanDay(rawActual) : '';
  const promised = promisedGiven ? cleanDay(rawPromised) : '';
  if (actualGiven && !actual) return bad('The actual deadline is not a valid date (YYYY-MM-DD).');
  if (promisedGiven && !promised) return bad('The promised submission date is not a valid date (YYYY-MM-DD).');
  if (type === TYPE_REAL && !actual) return bad('A real deadline needs the actual deadline date.');
  if (type === TYPE_IMAGINARY && !promised) return bad('An imaginary deadline needs the date promised to the client.');
  if (type === TYPE_IMAGINARY && actual) return bad('An imaginary deadline has no actual date — choose "Deadline" if there is a real one.');
  if (actual && actual < today) return bad(`The actual deadline ${actual} is in the past.`);
  const promisedKept = type === TYPE_REAL && !!promised && promised === cleanDay(keepPromised);
  if (promised && promised < today && !promisedKept) return bad(`The promised submission date ${promised} is in the past.`);
  if (actual && promised && promised > actual) return bad('The promised submission date is after the actual deadline.');
  return { ok: true, blank: false, type, actualDeadline: actual, promisedSubmissionDate: promised };
}

/** The lead's current answer, exactly as stored. */
function fromLead(lead = {}) {
  return {
    type: String(lead.deadlineType || '').trim(),
    actualDeadline: cleanDay(lead.actualDeadline),
    promisedSubmissionDate: cleanDay(lead.promisedSubmissionDate),
  };
}
const isSet = (lead) => TYPES.includes(fromLead(lead).type);

/** The lead columns to write for an answer ({} = nothing; blank clears all three). */
function leadFields(answer) {
  if (!answer || !answer.ok) return { fields: {}, clearKeys: [] };
  if (answer.blank) return { fields: {}, clearKeys: [...LEAD_KEYS] };
  const fields = { deadlineType: answer.type };
  const clearKeys = [];
  if (answer.actualDeadline) fields.actualDeadline = answer.actualDeadline; else clearKeys.push('actualDeadline');
  if (answer.promisedSubmissionDate) fields.promisedSubmissionDate = answer.promisedSubmissionDate; else clearKeys.push('promisedSubmissionDate');
  return { fields, clearKeys };
}

/** The case row's cells for an answer, keyed by Client Master column id (null = clear). */
function caseCells(answer, cols = require('../data/clientMasterBoard.json').deadlineColumns || {}) {
  if (!cols.type || !cols.actual || !cols.promised) return {};
  if (!answer || !answer.ok || answer.blank) return { [cols.type]: null, [cols.actual]: null, [cols.promised]: null };
  return {
    [cols.type]: { label: answer.type },
    [cols.actual]: answer.actualDeadline ? { date: answer.actualDeadline } : null,
    [cols.promised]: answer.promisedSubmissionDate ? { date: answer.promisedSubmissionDate } : null,
  };
}

/** "Real deadline 15 Jan 2027" / "Imaginary — promised 15 Dec 2026" / "Not set". */
const day = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
function describe(answerOrLead) {
  const o = answerOrLead || {};
  const a = (o.ok !== undefined || 'type' in o) ? o : fromLead(o);   // an answer / a stored answer, or a lead
  const type = a.type || '';
  if (type === TYPE_REAL) return `Real deadline ${day(a.actualDeadline)}${a.promisedSubmissionDate ? ` — promised ${day(a.promisedSubmissionDate)}` : ''}`;
  if (type === TYPE_IMAGINARY) return `Imaginary — promised ${day(a.promisedSubmissionDate)}`;
  return 'Not set';
}
/**
 * What a case row's three cells HOLD, with nothing left out — for the change note's "old" side and
 * the "someone changed it" answer. describe() says "Not set" for a row with no type, and drops the
 * actual date of an Imaginary row; a hand-kept row can have both, and a change overwrites them.
 * The pop-up's "Now:" line (tdotDeadlineText in deadlineChangeUi.js) says the same words.
 */
function describeStored(a = {}) {
  const type = a.type || '';
  if (type === TYPE_REAL) return describe(a);
  if (type === TYPE_IMAGINARY) return describe(a) + (a.actualDeadline ? ` (with an actual date ${day(a.actualDeadline)})` : '');
  if (a.actualDeadline || a.promisedSubmissionDate) return 'Type not recorded' + (a.actualDeadline ? ` — actual ${day(a.actualDeadline)}` : '') + (a.promisedSubmissionDate ? ` — promised ${day(a.promisedSubmissionDate)}` : '');
  return 'Not set';
}
const same = (a, b) => a.type === b.type && a.actualDeadline === b.actualDeadline && a.promisedSubmissionDate === b.promisedSubmissionDate;

module.exports = { TYPE_REAL, TYPE_IMAGINARY, TYPES, LEAD_KEYS, required, validate, fromLead, isSet, leadFields, caseCells, describe, describeStored, same, cleanDay, torontoToday };
