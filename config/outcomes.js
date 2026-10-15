'use strict';

/**
 * The consultation outcome — the consultant's decision after a consultation,
 * a STATUS column on the Lead Board (color_mm448h89).
 *
 * Gauri 2026-10-08 (point 5): four outcomes only — Retain, Follow-Up (which
 * also covers "ineligible"), Newsletter, Not Wanted. "Not Wanted" puts the
 * person on the Not Wanted list (blacklistService); staff are warned when that
 * person comes back.
 *
 * The labels are the EXACT texts on the board. updateLead writes labels by text
 * with create_labels_if_missing, so a near-miss would mint a junk label — the
 * validator accepts these strings byte for byte and nothing else. The two old
 * labels (0 rows carried them on 2026-10-15) are read as their new meaning so a
 * row that still has one is never misread; they are never written again.
 */
const OUTCOME_RETAIN     = 'Retain';
const OUTCOME_FOLLOW_UP  = 'Follow-Up';
const OUTCOME_NEWSLETTER = 'Newsletter';
const OUTCOME_NOT_WANTED = 'Not Wanted';
const OUTCOME_LABELS = [OUTCOME_RETAIN, OUTCOME_FOLLOW_UP, OUTCOME_NEWSLETTER, OUTCOME_NOT_WANTED];

/** The labels the board carried before 2026-10-15 → what they mean now (read side only). */
const LEGACY_OUTCOMES = {
  'Don’t Retain — Ineligible': OUTCOME_FOLLOW_UP,
  'Don’t Retain — Not Wanted': OUTCOME_NOT_WANTED,
};

/** The outcome a cell means: one of OUTCOME_LABELS, or '' (blank or unknown text). */
function canonicalOutcome(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return '';
  if (OUTCOME_LABELS.includes(v)) return v;
  return LEGACY_OUTCOMES[v] || '';
}

const isNotWanted = (value) => canonicalOutcome(value) === OUTCOME_NOT_WANTED;

module.exports = { OUTCOME_LABELS, OUTCOME_RETAIN, OUTCOME_FOLLOW_UP, OUTCOME_NEWSLETTER, OUTCOME_NOT_WANTED, LEGACY_OUTCOMES, canonicalOutcome, isNotWanted };
