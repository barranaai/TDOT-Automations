'use strict';

/**
 * Is this lead a DIRECT RETAINER client (a walk-in / direct client added through the
 * app's "Direct retainer client" form, or a lead converted with it)? (Faran 2026-11-04)
 *
 * Since 2026-11-04 the Source / Reference column holds the client's REAL source
 * (Walk-in, Instagram, Employee Referral …), and the app marks these clients in its
 * own small column "Direct Retainer Client" = "Yes" (newLeadsBoard.json key
 * `directClient`), set by the form itself — staff never type it.
 *
 * Clients created BEFORE that carry the old marker instead: Source / Reference
 * "Direct Retainer". Both mean the same, so every check goes through here.
 * PURE.
 */

const LEGACY_SOURCE = 'Direct Retainer';
const MARK = 'Yes';

function isDirectClient(lead) {
  if (!lead) return false;
  return String(lead.directClient || '').trim() === MARK
    || String(lead.sourceChannel || '').trim() === LEGACY_SOURCE;
}

/** The source to SHOW for a direct client ('' for an old one whose source was the marker itself). */
function shownSource(lead) {
  const s = String((lead && lead.sourceChannel) || '').trim();
  return s === LEGACY_SOURCE ? '' : s;
}

module.exports = { isDirectClient, shownSource, LEGACY_SOURCE, MARK };
