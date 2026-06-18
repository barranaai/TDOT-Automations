/**
 * Canonical option lists shared across the client-facing forms.
 *
 * These lists are the single source of truth so the intake form and the
 * pre-consultation form never drift. Adding a value here changes both forms
 * at once (and the validation whitelist that gates Monday writes).
 */

'use strict';

// Current immigration status — merged list agreed with TDOT (2026-06-17).
// Replaces the intake's older list and the pre-consult doc's richer states:
// "Maintained Status" / "Out of Status" fold in the intake's old separate
// "are you on maintained/implied status?" yes/no question; "Not in Canada"
// replaces the old "Outside Canada"; "No valid status" → "Out of Status".
const CURRENT_STATUS = [
  'Visitor',
  'Student',
  'Worker',
  'Permanent Resident',
  'Citizen',
  'Maintained Status',
  'Out of Status',
  'Not in Canada',
  'Other',
];

// The statuses that represent a valid temporary permit with a future expiry
// date worth collecting. Maintained/Out-of-status/PR/Citizen/Not-in-Canada
// have no forward expiry to ask for.
const STATUS_WITH_EXPIRY = ['Visitor', 'Student', 'Worker'];

module.exports = { CURRENT_STATUS, STATUS_WITH_EXPIRY };
