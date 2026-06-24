/**
 * Money parsing/formatting — one source of truth so the retainer flow and the
 * retainer-plan bridge never diverge on how a fee is parsed or rendered.
 * Formatters are locale-independent (deterministic in tests).
 */

'use strict';

/** Parse a Monday "Retainer Fee (CAD)" value (dollars, may have $/commas) into cents, or null. */
function feeToCents(value) {
  const n = parseFloat(String(value == null ? '' : value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents > 0 ? cents : null; // a positive sub-cent fee rounds to 0 — reject, don't emit a $0 agreement
}

function group(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Integer cents → grouped dollar string, e.g. 250000 → "2,500.00". */
function centsToMoney(cents) {
  const n = Math.round(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${group(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, '0')}`;
}

/** Dollar number → grouped dollar string, e.g. 1590 → "1,590.00", 401.25 → "401.25". */
function dollarsToMoney(dollars) {
  return centsToMoney(Math.round((Number(dollars) || 0) * 100));
}

module.exports = { feeToCents, centsToMoney, dollarsToMoney };
