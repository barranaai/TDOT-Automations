'use strict';

/**
 * The readable Client ID of a PERSON (Faran 2026-11-25): "CL-2026-00042".
 *
 *   CL     client (never TD- = the Otter recording code, TDOT- = the payment
 *          reference, LEAD- / CASE- = folder and delete markers);
 *   2026   the Toronto year the person first came to TDOT — a label only, it
 *          never changes and it does not identify anyone;
 *   00042  ONE company-wide counter (clientIdAllocator.js): never reset, never
 *          reused, 6 digits after 99999. The number alone is the person.
 *
 * The letters come FIRST on purpose: "2026-CL-00042" (year first, then
 * letters) is the shape of a CASE NUMBER, and the info@ filer, the mail
 * stamps, the delete-folder guard and the case-number allocator would all
 * read it as one (test/clientIdRefGuard.test.js).
 *
 * PURE — no I/O.
 */

/** The canonical stored form, whole value: CL-<4-digit year>-<5 or more digits>. */
const CLIENT_ID_RE = /^CL-(\d{4})-(\d{5,})$/;

// What staff may TYPE (parseClientId): "CL", then an optional 4-digit year,
// then the number — separated by nothing, spaces, dashes or dots. Nothing else.
const SEP = '[\\s\\-\\u2010-\\u2015_.#:]';
const TYPED_WITH_YEAR = new RegExp(`^CL${SEP}*(\\d{4})${SEP}+(\\d{1,7})$`, 'i');
const TYPED_NUMBER    = new RegExp(`^CL${SEP}*(\\d{1,7})$`, 'i');

const MAX_N = 9999999;   // 7 digits: far beyond any real count, and still not a phone number

const okYear = (y) => Number.isInteger(y) && y >= 1000 && y <= 9999;
const okN = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_N;

/**
 * "CL-2026-00042". '' when the year or the number is not usable (never throws).
 * @param {number|string} year  the 4-digit label year
 * @param {number|string} n     the counter number, 1 or more
 */
function formatClientId(year, n) {
  const y = Number(year), k = Number(n);
  if (!okYear(y) || !okN(k)) return '';
  return `CL-${y}-${String(k).padStart(5, '0')}`;
}

/** Is this exactly a stored Client ID ("CL-2026-00042")? Lower case, spaces or a short number are NOT (the audit lists them). */
function isClientId(v) {
  const m = CLIENT_ID_RE.exec(String(v == null ? '' : v));
  return !!m && okN(Number(m[2]));
}

/**
 * What staff typed, read as a Client ID — strict (review #14):
 *   "CL-2026-00042", "cl 2026 42", "CL-2026-42"  → { n: 42, year: 2026 }
 *   "CL42", "CL 42", "cl-00042"                  → { n: 42, year: null }
 * A lone digit group after CL is ALWAYS the number ("CL 2026" is number 2026).
 * Refused (null): a 2-digit year ("cl-26-42"), three digit groups, other
 * letters ("TD-12345", "CLIENT 42"), a number of 0 or of more than 7 digits.
 * @returns {null | { n: number, year: number|null }}
 */
function parseClientId(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s || s.length > 40) return null;
  let m = TYPED_WITH_YEAR.exec(s);
  if (m) {
    const year = Number(m[1]), n = Number(m[2]);
    return okYear(year) && okN(n) ? { n, year } : null;
  }
  m = TYPED_NUMBER.exec(s);
  if (m) {
    const n = Number(m[1]);
    return okN(n) ? { n, year: null } : null;
  }
  return null;
}

/** The counter number of a STORED value, or 0 when it is not a Client ID in any readable form. */
function clientIdNumber(v) {
  const p = parseClientId(v);
  return p ? p.n : 0;
}

module.exports = { formatClientId, parseClientId, isClientId, clientIdNumber, CLIENT_ID_RE, MAX_N };
