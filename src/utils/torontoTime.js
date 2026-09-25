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

module.exports = { torontoTime };
