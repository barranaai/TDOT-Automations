'use strict';

/**
 * The subject of a CASE email (reply-thread change, Faran 2026-11-18):
 *
 *   `<subject text> — <case ref> · <exact Monday Case Stage label>`
 *   e.g. "Documents still needed — 2026-SPE-016 · Document Collection Started"
 *
 * The ref is how the email reader (emailLeadsService.subjectCaseRefs) files a
 * client's reply on the right case, so it appears exactly once, at the end.
 *
 * Rules (do not undo):
 *  - The stage is the EXACT Client Master "Case Stage" label as it stands when
 *    the email is sent (read fresh by the caller) — not the portal's friendly name.
 *  - The stage is left out when it is blank or "Stuck" (any case, trimmed).
 *  - No ref → no ref AND no stage (a stage alone means nothing to the client).
 *  - A ref already in the base (older per-email styles "(REF)", "— Case REF",
 *    "– REF", "case REF", and the Document-reminder board's "— {CaseRef}") is
 *    stripped with its separator / brackets / "Case" word before the ref is
 *    appended, so staff-edited reminder subjects never show it twice.
 *  - Lead / pre-case emails do NOT use this (no case yet): their subject is unchanged.
 */

const SEP_CHARS = '—–\\-:|·,';   // em dash, en dash, hyphen, colon, bar, middle dot, comma

function clean(v) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Trim leftover separators at either end ("Subject — " → "Subject"). */
function trimSeparators(s) {
  return s
    .replace(new RegExp(`^[\\s${SEP_CHARS}]+`), '')
    .replace(new RegExp(`[\\s${SEP_CHARS}]+$`), '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .trim();
}

/**
 * PURE. Remove every occurrence of `caseRef` (case-insensitive) from `base`,
 * together with an adjacent "Case"/"case ref" word, a separator before it, or
 * the brackets around it.
 */
function stripCaseRef(base, caseRef) {
  const text = clean(base);
  const ref = clean(caseRef);
  if (!ref) return text;
  const r = escapeRe(ref);
  // the "Case" / "case ref:" word goes with the ref only when it is part of the ref's own label —
  // after a separator, inside brackets, or at the start ("— Case REF", "(case ref: REF)");
  // in a sentence ("Your case REF needs…") only the ref goes and "case" stays
  const word = '(?<![A-Za-z])case(?:\\s+ref(?:erence)?)?(?:\\s*(?:no\\.?|number|#))?\\s*[:#]?\\s*';
  const edgeL = '(?<![A-Za-z0-9])';
  const edgeR = '(?![A-Za-z0-9])';
  const out = text
    // "(2026-X-001)", "[Case 2026-X-001]", "(case ref: 2026-X-001)"
    .replace(new RegExp(`\\s*[(\\[]\\s*(?:${word})?${edgeL}${r}${edgeR}\\s*[)\\]]`, 'gi'), '')
    // " — Case 2026-X-001", "Case 2026-X-001 — …" at the start
    .replace(new RegExp(`(?:^\\s*|\\s*[${SEP_CHARS}]\\s*)${word}${edgeL}${r}${edgeR}`, 'gi'), '')
    // " – 2026-X-001", " — 2026-X-001", "… case 2026-X-001 …" (the ref alone)
    .replace(new RegExp(`\\s*(?:[${SEP_CHARS}]\\s*)?${edgeL}${r}${edgeR}`, 'gi'), '');
  return trimSeparators(out);
}

/** True when the stage is shown in a subject (not blank, not "Stuck"). */
function stageShown(caseStage) {
  const st = clean(caseStage);
  return !!st && st.toLowerCase() !== 'stuck';
}

/**
 * PURE. The case-email subject.
 * @param {string} base       the subject text (may already contain the ref in an old style)
 * @param {string} caseRef    the Client Master case ref ('' when there is none)
 * @param {string} caseStage  the exact Case Stage label read at send time
 */
function caseSubject(base, caseRef, caseStage) {
  const ref = clean(caseRef);
  const text = ref ? stripCaseRef(base, ref) : trimSeparators(clean(base));
  if (!ref) return text;
  const st = clean(caseStage);
  return stageShown(st) ? `${text} — ${ref} · ${st}` : `${text} — ${ref}`;
}

module.exports = { caseSubject, stripCaseRef, stageShown };
