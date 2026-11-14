'use strict';

/**
 * The recording code of a consultation (Faran 2026-11-14): "TD-" + the last five digits of its
 * Lead Board item id. Staff type it as the Otter recording title before they stop the recording,
 * and the recording then files itself on that consultation. Display-only: nothing is stored,
 * there is no Monday column, and it is never shown to a client. PURE — the ONE place it is made.
 * Two consultations can share a code (same last five digits); the matcher never files on a code
 * alone — it also needs the booked day (otterMatch.js).
 */
function recordingCode(itemId) {
  const digits = String(itemId == null ? '' : itemId).replace(/\D/g, '');
  if (!digits) return '';
  return 'TD-' + digits.slice(-5).padStart(5, '0');
}

module.exports = { recordingCode };
