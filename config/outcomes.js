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

/**
 * "Webinar" (Faran 2026-11-11): an outcome for a LEAD only — set from the lead page, shown in the Leads list's
 * Webinar column. It is on the same board column, but it is NOT a consultation outcome: leadService.parseItem takes
 * it off `outcome` as the lead is read (lead.webinar = 'Yes', lead.webinarAt) and canonicalOutcome() reads it as
 * blank, so a booked consultation is never "decided" by it (it stays on the Consultations page and still asks for
 * its outcome), and the Retainers & follow-ups page has no tab for it. The consultation record does not offer it.
 */
const OUTCOME_WEBINAR = 'Webinar';
/** The outcomes the lead page offers / the outcome action accepts: the four, then Webinar. */
const LEAD_OUTCOME_LABELS = [...OUTCOME_LABELS, OUTCOME_WEBINAR];
const isWebinar = (value) => String(value == null ? '' : value).trim() === OUTCOME_WEBINAR;
/** The outcome text a CONSULTATION list shows: the cell as stored, but never the lead-only Webinar. */
const consultOutcomeText = (value) => (isWebinar(value) ? '' : String(value == null ? '' : value).trim());

module.exports = { OUTCOME_WEBINAR, LEAD_OUTCOME_LABELS, isWebinar, consultOutcomeText, OUTCOME_LABELS, OUTCOME_RETAIN, OUTCOME_FOLLOW_UP, OUTCOME_NEWSLETTER, OUTCOME_NOT_WANTED, LEGACY_OUTCOMES, canonicalOutcome, isNotWanted };
