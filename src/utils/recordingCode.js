'use strict';

/**
 * The recording code of a consultation (Faran 2026-11-14): "TD-" + the last five digits of its
 * Lead Board item id. Staff type it as the Otter recording title before they stop the recording,
 * and the recording then files itself on that consultation. Since 2026-11-26 the client's Client
 * ID is what staff type when the client has one (otterTitleOf); this code stays as the backup.
 * Display-only: nothing is stored, there is no Monday column, and it is never shown to a client. PURE — the ONE place it is made.
 * Two consultations can share a code (same last five digits); the matcher never files on a code
 * alone — it also needs the booked day (otterMatch.js).
 */
function recordingCode(itemId) {
  const digits = String(itemId == null ? '' : itemId).replace(/\D/g, '');
  if (!digits) return '';
  return 'TD-' + digits.slice(-5).padStart(5, '0');
}

/**
 * What staff type as the Otter recording title for a consultation (Faran 2026-11-26): the person's
 * Client ID ("CL-2026-00042") when they have one, else the recording code above — the backup for
 * the clients who have no Client ID (past clients get one only when they come back). '' when there
 * is neither. Only a STORED Client ID is used (utils/clientId.isClientId); anything else in the box
 * falls back to the code. PURE.
 */
function otterTitleOf(itemId, clientId) {
  const cid = String(clientId == null ? '' : clientId).trim();
  if (require('./clientId').isClientId(cid)) return cid;
  return recordingCode(itemId);
}

module.exports = { recordingCode, otterTitleOf };
