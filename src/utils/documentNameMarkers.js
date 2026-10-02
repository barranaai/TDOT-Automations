'use strict';

/**
 * Optional-wording classifier for document NAMES (readiness item 2, cut 2,
 * 2026-10-02). Optionality is never a field in the source PDFs — it lives in
 * the wording of the name: "(Optional)", "(if applicable)", "if any", "If
 * student …", "… if studied here". This is the ONE place that wording is
 * recognised, used by:
 *   - the snapshot test that pins which schema documents carry `optional: true`
 *     (the flags are applied by hand; the test proves they equal this
 *     classifier's text-only set minus NEVER_OPTIONAL_NAMES);
 *   - scripts/template-required-type-optional.js (the Template-board tool).
 * Guidance text is NOT classified ("whichever apply" in guidance is advice,
 * not optionality), and "A/B" alternatives are one-of lists, not optional.
 */

const MARKERS = {
  optional:         /\boptional\b/i,
  ifApplicable:     /\b(if|where|as|when) applicable\b/i,
  ifAny:            /\bif any\b/i,
  whicheverApply:   /\bwhichever (apply|applies|applicable)\b/i,
  ifAvailable:      /\bif (available|held)\b/i,
  otherIf:          /\bif\b/i,
};
const SOFT = ['optional', 'ifApplicable', 'ifAny', 'whicheverApply', 'ifAvailable', 'otherIf'];

function classify(text) {
  const t = String(text || '');
  const hits = {};
  for (const [k, re] of Object.entries(MARKERS)) hits[k] = re.test(t);
  if (hits.ifApplicable || hits.ifAny || hits.ifAvailable) hits.otherIf = false;
  hits.anySoft = SOFT.some((k) => hits[k]);
  hits.kinds = SOFT.filter((k) => hits[k]);
  return hits;
}

const normName = (s) => String(s || '').toLowerCase().replace(/[’'"]/g, '').replace(/\s*[-–—]\s*/g, '-').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();

/** Letters and digits only — the key the exception list is matched on (punctuation and spacing never change a verdict). */
const loose = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Soft-worded names that are NOT optional on reflection (decided 2026-10-02):
 * the "if" qualifies a PART of the document, not the document itself.
 */
const NEVER_OPTIONAL_NAMES = [
  // the income proof is always required; only the academic-docs part depends on being a student
  'Proof/source of Income (incl. academic docs if student)',
].map(loose);

/** The Template-board affidavit has no name-change gate (schemas gate it on nameChanged), so there it is optional. */
const AFFIDAVIT_RE = /one and same name affidavit/i;

/** Does this NAME read as optional / conditional (and is not on the exception list)? */
function isSoftNamed(name) {
  return classify(name).anySoft && !NEVER_OPTIONAL_NAMES.includes(loose(name));
}

module.exports = { MARKERS, SOFT, classify, normName, loose, NEVER_OPTIONAL_NAMES, AFFIDAVIT_RE, isSoftNamed };
