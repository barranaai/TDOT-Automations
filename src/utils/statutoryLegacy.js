'use strict';

/**
 * Legacy statutory Yes/No pairs (Gauri 2026-09-04, point 02).
 *
 * Until 2026-09-09 the questionnaire engine collected each radio of a
 * ".stat-table" row (F12 Visitor extension, F13 TRV) as its own field with no
 * group name, so every saved file holds the constant pair
 *     "<section>-N-answer-yes-no"   = "yes"     (the Yes radio's option label)
 *     "<section>-N-answer-yes-no-2" = "no"      (the No radio's option label)
 * for every row, whatever the client clicked. Such a pair is NOT an answer —
 * it must never restore a tick on the client form, never show as "No" to
 * staff, and never print as an answer in a PDF.
 *
 * The fixed engine stores the real choice under the FIRST key (names kept),
 * and never produces the "-2" key, so a pair is unambiguous: it only exists
 * in pre-fix files.
 */

const LEGACY_SUFFIX = '-answer-yes-no';
const NOT_RECORDED_TEXT = 'Not recorded — the form did not capture this answer before 2026-09-09; ask the client to re-confirm';

const val = (f) => String(f && f.value == null ? '' : f.value).trim().toLowerCase();

/**
 * @param {Array} fields  saved [{ section, label, key, value }]
 * @param {{ keep?: boolean }} [opts]  keep=true keeps ONE placeholder per pair (the Yes
 *   key, value '' and `notRecorded: true`) so reviewers/PDFs can show "not
 *   recorded" in place; keep=false (default) removes both entries.
 * @returns {{ fields: Array, notRecorded: Array<{ section, label, key }> }}
 */
function stripLegacyStatutoryPairs(fields, opts = {}) {
  const list = Array.isArray(fields) ? fields : [];
  const byKey = new Map();
  for (const f of list) if (f && f.key && !byKey.has(f.key)) byKey.set(f.key, f);
  const drop = new Set();
  const notRecorded = [];
  for (const [key, a] of byKey) {
    if (!key.endsWith(LEGACY_SUFFIX)) continue;
    const b = byKey.get(key + '-2');
    if (!b || val(a) !== 'yes' || val(b) !== 'no') continue;
    drop.add(key); drop.add(key + '-2');
    notRecorded.push({ section: a.section || '', label: a.label || '', key });
  }
  if (!drop.size) return { fields: list, notRecorded };
  const out = [];
  for (const f of list) {
    if (!f || !f.key || !drop.has(f.key)) { out.push(f); continue; }
    if (opts.keep && f.key.endsWith(LEGACY_SUFFIX)) out.push({ ...f, value: '', notRecorded: true });
  }
  return { fields: out, notRecorded };
}

module.exports = { stripLegacyStatutoryPairs, NOT_RECORDED_TEXT, LEGACY_SUFFIX };
