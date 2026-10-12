'use strict';

/**
 * "12 Sep 2026, 2:03 pm" in Toronto — the wording of the Monday notes (the
 * sponsor onboarding notes, the payment-undo record and its alarm notes), so
 * one event is dated the same way wherever it is written up. The pages print
 * their own timestamps (adminShared's payWhen, en-CA with the zone shown, on
 * every payment panel and the sponsor card); a change here does not reach them.
 *
 * @param {number} ms  epoch milliseconds
 * @returns {string}   '' when the value is not a time
 */
function torontoTime(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d)) parts[p.type] = p.value;
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${String(parts.dayPeriod || '').toLowerCase()}`;
}

// An instant written WITH its zone: Monday's created_at ('2026-10-01T01:30:00Z'), a
// new Date().toISOString() stamp ('…T01:30:00.123Z'), an offset ('…T21:30:00-04:00').
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * 'YYYY-MM-DD HH:MM' in Toronto (the booked-slot shape) for an instant that
 * carries its zone (2026-10-12): a lead that arrives at 9:30 pm Toronto is
 * 01:30 the NEXT day in UTC, and pages that cut the UTC string showed it on
 * the wrong day, hours late. Anything else comes back exactly as it was — a
 * date-only '2026-09-30' is already a Toronto day (new Date() would make it
 * the evening before) and a slot '2026-09-30 22:00' is already Toronto time.
 *
 * @param {*} v
 * @returns {string}
 */
function torontoWallClock(v) {
  const s = String(v == null ? '' : v).trim();
  if (!ZONED_ISO.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

/** The Toronto calendar day of the same value: 'YYYY-MM-DD' (a date-only value unchanged, '' stays ''). */
function torontoDay(v) { return torontoWallClock(v).slice(0, 10); }

module.exports = { torontoTime, torontoWallClock, torontoDay };
