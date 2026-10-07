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
/**
 * Documents that are REQUIRED whatever their wording (Faran, 2026-10-07):
 * "Identity and Civil Documents" — most clients hold at least one of these
 * papers (marriage, divorce, children's birth certificates, name change), so
 * the app keeps chasing it everywhere; a client with none is marked
 * "Not Applicable" by staff. The 2 LMIA-extension checklists word it
 * "(…, if applicable)" — required there too, like in the other 89 entries.
 */
const NEVER_OPTIONAL_PREFIXES = ['Identity and Civil Documents'].map(loose);
/**
 * Documents that are OPTIONAL whatever their wording (Faran, 2026-10-07):
 * the sibling's proof of living in Canada — only a client with a brother or
 * sister in Canada can send it, so it is optional on every checklist, not
 * only where the name says "(if applicable)".
 */
const ALWAYS_OPTIONAL_RES = [/\bsibling\b[\s\S]*\bproof of living in canada\b/i];

/** The Template-board affidavit has no name-change gate (schemas gate it on nameChanged), so there it is optional. */
const AFFIDAVIT_RE = /one and same name affidavit/i;

function neverOptional(name) {
  const k = loose(name);
  return NEVER_OPTIONAL_NAMES.includes(k) || NEVER_OPTIONAL_PREFIXES.some((p) => k.startsWith(p));
}
function alwaysOptional(name) {
  return ALWAYS_OPTIONAL_RES.some((re) => re.test(String(name || '')));
}

/** Is this document optional by its NAME — the wording, plus the two explicit decisions above? */
function isOptionalName(name) {
  if (neverOptional(name)) return false;
  return classify(name).anySoft || alwaysOptional(name);
}
/** @deprecated name kept for callers — same as isOptionalName. */
const isSoftNamed = isOptionalName;

module.exports = { MARKERS, SOFT, classify, normName, loose, NEVER_OPTIONAL_NAMES, NEVER_OPTIONAL_PREFIXES, ALWAYS_OPTIONAL_RES, AFFIDAVIT_RE, neverOptional, alwaysOptional, isOptionalName, isSoftNamed };
