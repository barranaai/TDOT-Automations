'use strict';

/**
 * Optional documents (readiness item 2, cut 2, 2026-10-02) — the one place for
 * the rule "an optional document counts only once it is present".
 *
 * Where optionality comes from:
 *   - schema-seeded rows (intake id "code:<documentCode>"): the document
 *     definition in src/data/caseSchemas/*.js carries `optional: true`,
 *     recovered at read time through seedPlanner.resolveDocumentCode — no new
 *     board column, no reseed, no backfill;
 *   - template-seeded rows: the Template board's Required Type
 *     (dropdown_mm0x9v5q) reads "Optional" or "Conditional" (set by
 *     scripts/template-required-type-optional.js).
 *
 * The switch DOC_OPTIONAL ('1' / 'true', read at call time) gates EVERYTHING
 * here: OFF reproduces today's numbers and shows no tag (every schema row
 * stays Mandatory, optional rows stay in the denominator). The Template-board
 * tool (Required Type = Optional) and the switch are ONE change — run them in
 * the same window; the rollback is the switch OFF AND the tool's --undo. ON:
 *   - the readiness engine resolves schema rows to Required Type "Optional"
 *     and counts Optional/Conditional rows only when uploaded (never in
 *     Missing Required — that was already Mandatory-only);
 *   - the client pages show an "Optional" tag and count the row only once
 *     uploaded, so "X of Y" and 100% are honest.
 * Rows marked "Not Applicable" are handled by documentNotApplicable.js and
 * are out of every count regardless of this switch.
 */

function isEnabled() {
  const v = String(process.env.DOC_OPTIONAL || '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** The schema's own word: only a literal boolean `true` counts (a string never does). */
function isOptionalDoc(doc) {
  return Boolean(doc) && doc.optional === true;
}

/** A schema document code (the part after "code:") whose definition is optional. Unresolvable → false (Mandatory, as today). */
function isOptionalCode(code) {
  try {
    const r = require('./seedPlanner').resolveDocumentCode(code);
    return isOptionalDoc(r && r.doc);
  } catch (_) { return false; }
}

/** The execution row's intake id ("code:<documentCode>" for schema rows). */
function isOptionalIntake(intakeId) {
  const s = String(intakeId || '').trim();
  return s.startsWith('code:') && isOptionalCode(s.slice(5));
}

/** The Template board's Required Type text. */
function isOptionalRequiredType(text) {
  const t = String(text || '').trim();
  return t === 'Optional' || t === 'Conditional';
}

/**
 * Client-facing progress for a list of getCaseDocuments rows: "Not Applicable"
 * rows are out entirely; an optional row counts only once uploaded. Used by
 * BOTH client pages (portal + legacy /documents) so they never disagree.
 */
function clientProgress(items) {
  let total = 0, uploaded = 0, optionalOpen = 0;
  for (const it of items || []) {
    const s = String(it.status || 'Missing');
    if (s === 'Not Applicable') continue;
    const up = s !== 'Missing' && s !== '';
    if (it.optional === true && !up) { optionalOpen++; continue; }
    total++;
    if (up) uploaded++;
  }
  return { total, uploaded, optionalOpen };
}

module.exports = { isEnabled, isOptionalDoc, isOptionalCode, isOptionalIntake, isOptionalRequiredType, clientProgress };
