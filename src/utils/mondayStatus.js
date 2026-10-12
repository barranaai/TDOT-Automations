'use strict';

/**
 * The text of a Monday STATUS cell, with an EMPTY cell read as '' (2026-10-12).
 *
 * Monday shows a status column's id-5 label on every empty cell, and the API
 * returns that label as the cell's `text` while its `value` is null. On the
 * Lead Board the columns were created with a real label at id 5, so 473 leads
 * nobody had decided on read Outcome "Follow-Up", 227 read Tier "T4" and 6 read
 * Conversion Status "Retained — Awaiting Payment" — and the post-consultation
 * "set the Outcome" reminder never fired, because every lead looked decided.
 *
 * Strict `=== null` on purpose: Monday sends an explicit null for an empty cell
 * whenever the query asks for `value`. `undefined` means the query never asked,
 * so today's text is kept — a query that forgets `value` can never blank a real
 * "Booked" or "Yes".
 *
 * @param {{ text?: string, value?: string|null }|null|undefined} cv  a column_values entry
 * @returns {string}
 */
function statusText(cv) {
  if (!cv) return '';
  return cv.value === null ? '' : String(cv.text || '');
}

module.exports = { statusText };
