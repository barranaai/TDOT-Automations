'use strict';

/**
 * Carry-over of embedded family answers (2026-10-09, case 2026-CEC-EE-075).
 *
 * The single-member questionnaire (form F1) embeds a "Dependent Spouse /
 * Common-Law Partner" and a "Dependent Children" section INSIDE the principal
 * applicant's own form; a client with no separate family member on the
 * questionnaire types the spouse's details there, and they are saved in HIS
 * file (questionnaire-<ref>-primary.json) under sections such as
 * "Dependent Spouse / Common-Law Partner › Personal Details".
 *
 * The moment the member list gains a second member, the page switches to
 * multi-member mode: those embedded sections disappear from the principal's
 * page (they become the blueprint of each member's own section) and, on his
 * next save, the answers typed there are kept aside — never shown again.
 *
 * So BEFORE a Spouse / Dependent Child member is added, this service copies
 * the embedded answers into the new member's own file, exactly as the member
 * section would store them:
 *   - section: the embedded path minus its top-level header
 *       "Dependent Spouse / Common-Law Partner › Marital Status" → "Marital Status"
 *     (in multi-member mode the engine stops at the member wrapper, so the
 *     member's own sections carry no top-level header — the strings then match
 *     the member section byte for byte, which is what the restore and the
 *     table-row expansion key on);
 *   - label and key: unchanged (the original keys claim no box of any other
 *     member; the restore places the answers by section + label, and the
 *     client's first save in the new section re-keys them in place);
 *   - value: unchanged; empties included, so the order of repeated labels
 *     (table rows, child blocks) is preserved.
 *
 * WHEN it runs (scope — the safety of the whole feature rests on it): only
 * while a member is being ADDED and is not yet on the questionnaire list. No
 * page anywhere shows that member's section yet, so every page that will ever
 * show it is loaded after the copy and shows the copy. (A member already on
 * the list — "adopted" — is never carried into: a page open since then could
 * post that section over the copy.) The admin route only dry-runs.
 *
 * Rules (the ones a review must not undo):
 *   - the principal's file is NEVER written — only read;
 *   - a member file that already holds a client answer is NEVER overwritten
 *     (a pre-fill-only file counts as empty and is replaced);
 *   - a read failure throws (err.transient) — an outage must never read as
 *     "nothing to carry";
 *   - a source saved in the last RECENT_SAVE_MS from a page that still shows
 *     the embedded boxes is refused (err.badRequest) when something would be
 *     copied: the client may still be typing there;
 *   - the member file records the SAME form edition as the source, and none
 *     when the source has none (never a guess: the era resolver then judges
 *     the copy by its labels, exactly as it judges the source);
 *   - the copied answers are tagged source:'carry-over' until the client saves
 *     the member section himself (his page rebuilds every field without the
 *     tag), so a re-run or a retry replaces the service's own copy but never
 *     an answer the client typed there;
 *   - a refusal or a read failure happens BEFORE any write (all slots are
 *     planned and checked first, then written);
 *   - no Monday column, no email, no PDF (the draft PDF appears on the
 *     client's first save in the new section).
 */

const htmlQ = require('./htmlQuestionnaireService');

const SEP = ' › ';
const RECENT_SAVE_MS = 10 * 60 * 1000;

/** Which embedded top-level header feeds which member type. Matched on the header's first words (the form's own wording). */
const EMBEDDED = {
  'Spouse / Common-Law Partner': { test: (top) => /^dependent spouse\b/i.test(top), kind: 'spouse' },
  'Dependent Child':             { test: (top) => /^dependent child(ren)?\b/i.test(top), kind: 'child' },
};

/** The child block's labels in the single-member form → the labels of the member section (a clone of the spouse blueprint). */
const CHILD_LABEL_MAP = { 'Family Name': 'Family Name (Surname)', 'Eye Colour': 'Eye Color' };
/** Child-block labels with no box in a child's own section (kept — set aside on the child's first save, never lost). */
const CHILD_NO_BOX = ['Date of Birth', 'City and Country of Birth'];

function isEnabled() {
  const v = String(process.env.QUESTIONNAIRE_CARRY_OVER == null ? '' : process.env.QUESTIONNAIRE_CARRY_OVER).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

const CARRY_TAG = 'carry-over';
const isPrefill = (f) => !!f && (f.source === 'prefill' || String(f.key || '').startsWith('prefill__'));
const isCarried = (f) => !!f && f.source === CARRY_TAG;
const hasValue  = (f) => !!f && String(f.value == null ? '' : f.value).trim() !== '';
const topOf     = (section) => String(section || '').split(SEP)[0].trim();
const restOf    = (section) => { const s = String(section || ''); const i = s.indexOf(SEP); return i < 0 ? '' : s.slice(i + SEP.length); };
const ROW_RE    = /\s—\sRow\s\d+$/;
/** ONE dependent block that does not say whose it is — F6/F19 "Dependent (If Accompany…)", F3/F8 "Dependent Applicant": never copied (a guess between spouse and child), only reported. */
const AMBIGUOUS_DEPENDENT = (top) => /^dependent\s+(\(if accompany|applicant\b)/i.test(top);

/* The client engine's own slug rules (htmlQuestionnaireService client script:
   slugify / slugifyFull — the "replace(/^-+|-+$/, '')" WITHOUT the g flag is
   theirs, kept on purpose) and its dynamic-table key (collectFields pass 2).
   test/questionnaireCarryOver.test.js pins both against the engine source. */
const slugifyFull = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/, '');
const slugify     = (s) => slugifyFull(s).slice(0, 90);
function memberTableKey(section2, tableId, rowN, header) {
  const full = slugifyFull(section2 + '--tbl-' + slugify(tableId) + '--r' + rowN + '--' + header);
  if (full.length <= 90) return full;
  const tail = '-tbl-' + slugifyFull(tableId) + '-r' + rowN + '-' + slugifyFull(header);
  return slugifyFull(section2).slice(0, Math.max(0, 90 - tail.length)) + tail;
}
/**
 * PURE: the key the member section's own box has for a carried table cell.
 * The clone prefixes every table id with the member key; the section is the
 * member's ("Section 3 — Address Details (Past 10 Years)"). With that key the
 * box claims the answer by key — never by position, so rows of two tables
 * sharing column names in one section (the living / deceased family tables)
 * can never trade answers. A key that does not parse keeps the original
 * (placement then falls back to section + label, as before).
 */
function rekeyTableCell(f, memberKey) {
  const rowM = /\s\u2014\sRow\s(\d+)$/.exec(String(f.label || ''));
  const tblM = /-tbl-(.+?)-r(\d+)-/.exec(String(f.key || ''));
  if (!rowM || !tblM || rowM[1] !== tblM[2] || !/ › Table$/.test(f.section)) return f.key;
  const header = String(f.label).slice(0, rowM.index);
  const section2 = f.section.replace(/ › Table$/, '');
  return memberTableKey(section2, `${memberKey}-${tblM[1]}`, Number(rowM[1]), header);
}

/** PURE: the index a key like "child-2" names (1 for "child-1" / "spouse"). */
function memberIndexOf(memberKey) {
  const m = /-(\d+)$/.exec(String(memberKey || ''));
  return m ? Math.max(1, Number(m[1])) : 1;
}

/** PURE: which child block an embedded child field belongs to — the key's own repeat counter ("-2" for block 2; block 1 has none). */
function childBlockOf(f) {
  const m = /-(\d+)$/.exec(String(f.key || ''));
  return m ? Number(m[1]) : 1;
}

/**
 * PURE: plan the copy for ONE source slot.
 * @param {object} p
 * @param {Array}  p.sourceFields     the principal's saved fields ({section,label,key,value,source?})
 * @param {Array}  [p.sourceSetAside] the principal's kept-aside answers (a case that flipped earlier)
 * @param {string} p.memberType       'Spouse / Common-Law Partner' | 'Dependent Child'
 * @param {number} [p.memberIndex=1]  which child block (child-2 → 2)
 * @returns {{ fields, copied, total, live, bySection, unmapped, skippedSharedTable, pct }}
 *   live = embedded fields in the LAST save (a page that still shows those boxes)
 */
function planCarryOver({ sourceFields = [], sourceSetAside = [], memberType, memberIndex = 1, memberKey = '', memberName = '' } = {}) {
  const spec = EMBEDDED[memberType];
  const empty = { fields: [], copied: 0, total: 0, live: 0, bySection: {}, unmapped: [], skippedSharedTable: 0, pct: 0, givenName: '', unmatched: false, childNames: [] };
  if (!spec) return empty;
  const seen = new Set();
  const pick = [];
  let live = 0;
  // live fields first (file order) …
  for (const f of Array.isArray(sourceFields) ? sourceFields : []) {
    if (!f || isPrefill(f) || !spec.test(topOf(f.section))) continue;
    live++;
    pick.push({ section: String(f.section || ''), label: String(f.label || ''), key: String(f.key || ''), value: f.value == null ? '' : String(f.value) });
    seen.add(`${f.section}\u0000${f.label}\u0000${f.key}`);
  }
  // … then kept-aside answers (a page that flipped before this feature). A
  // table row whose TABLE was still on the page at the last save was removed
  // by the client — that row is not brought back.
  const liveSections = new Set(pick.map((f) => f.section));
  for (const f of Array.isArray(sourceSetAside) ? sourceSetAside : []) {
    if (!f || isPrefill(f) || !hasValue(f) || !spec.test(topOf(f.section))) continue;
    if (ROW_RE.test(String(f.label || '')) && liveSections.has(String(f.section || ''))) continue;
    const sig = `${f.section}\u0000${f.label}\u0000${f.key}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    pick.push({ section: String(f.section || ''), label: String(f.label || ''), key: String(f.key || ''), value: String(f.value) });
  }

  let out = [];
  const unmapped = [];
  let skippedSharedTable = 0;
  let givenName = '', unmatched = false, childNames = [];
  if (spec.kind === 'spouse') {
    out = pick.map((f) => {
      const g = { section: restOf(f.section), label: f.label, key: f.key, value: f.value };
      if (memberKey) g.key = rekeyTableCell(g, memberKey);
      return g;
    });
  } else {
    // "Dependent Children › Personal Details" holds one block per child under
    // ONE section; a field's block is its key's repeat counter (the engine's
    // makeKey adds "-2", "-3" …). The children's shared history table cannot
    // be attributed to one child.
    // Which block: by the NAME staff gave (the block whose Given Name matches,
    // first word to first word — exactly one, or nothing is copied); without a
    // name, by the member's number (child-2 → block 2).
    const firstWord = (s) => String(s || '').trim().toLowerCase().split(/\s+/)[0] || '';
    const blocks = new Map();
    const cnt0 = new Map();
    for (const f of pick) {
      const rest = restOf(f.section);
      if (!/^personal details/i.test(rest) || f.label !== 'Given Name') continue;
      let blk;
      if (f.key) blk = childBlockOf(f); else { blk = (cnt0.get(f.label) || 0) + 1; cnt0.set(f.label, blk); }
      if (hasValue(f)) blocks.set(blk, String(f.value).trim());
    }
    childNames = [...blocks.values()];
    let n = Math.max(1, Number(memberIndex) || 1);
    const want = firstWord(memberName);
    if (want && blocks.size) {
      const hits = [...blocks.entries()].filter(([, g]) => firstWord(g) === want);
      if (hits.length !== 1) unmatched = true;
      else n = hits[0][0];
    }
    givenName = blocks.get(n) || '';
    const count = new Map();
    for (const f of (unmatched ? [] : pick)) {
      const rest = restOf(f.section);
      if (/^personal history/i.test(rest)) { if (hasValue(f)) skippedSharedTable++; continue; }
      if (!/^personal details/i.test(rest)) continue;
      let blk;
      if (f.key) blk = childBlockOf(f);
      else { blk = (count.get(f.label) || 0) + 1; count.set(f.label, blk); }   // no key: file order
      if (blk !== n) continue;
      const label = CHILD_LABEL_MAP[f.label] || f.label;
      if (CHILD_NO_BOX.includes(f.label) && hasValue(f)) unmapped.push(f.label);
      out.push({ section: 'Personal Details', label, key: f.key, value: f.value });
    }
  }
  if (unmatched) {
    // the shared table is still worth reporting
    skippedSharedTable = pick.filter((f) => /^personal history/i.test(restOf(f.section)) && hasValue(f)).length;
    return { ...empty, live, skippedSharedTable, unmatched: true, childNames };
  }
  const copied = out.filter(hasValue).length;
  const bySection = {};
  for (const f of out) if (hasValue(f)) { const s = f.section.replace(/ › Table$/, '') || '(top)'; bySection[s] = (bySection[s] || 0) + 1; }
  const total = out.length;
  // A child's section holds far more boxes than its 9 embedded labels: no %
  // for a child (the page computes the real one on the client's next save).
  const pct = (spec.kind === 'spouse' && total) ? Math.round(100 * copied / total) : 0;
  return { fields: out, copied, total, live, bySection, unmapped, skippedSharedTable, pct, givenName, unmatched: false, childNames };
}

/** PURE: answered fields in a dual-form main form's unattributed dependent block (reported, never copied). */
function countAmbiguousDependent(fields) {
  return (Array.isArray(fields) ? fields : []).filter((f) => f && !isPrefill(f) && hasValue(f) && AMBIGUOUS_DEPENDENT(topOf(f.section))).length;
}

/**
 * PURE: what the member file is written with — the planned fields (tagged),
 * plus any pre-fill the target held. A pre-fill answer keeps its place when
 * the carried box for the same label is EMPTY (the empty copy would otherwise
 * claim the box and hide the pre-fill); a carried answer replaces it.
 * Anything else the target held (an earlier copy) is replaced by this plan.
 */
function mergeOverPrefill(planned, existing) {
  const prefill = (Array.isArray(existing) ? existing : []).filter((f) => isPrefill(f) && hasValue(f));
  if (!prefill.length) return planned.slice();
  const norm = (l) => String(l || '').trim().toLowerCase();
  const answered = new Set(planned.filter(hasValue).map((f) => norm(f.label)));
  const prefillKept = prefill.filter((f) => !answered.has(norm(f.label)));
  const prefillLabels = new Set(prefillKept.map((f) => norm(f.label)));
  const kept = planned.filter((f) => hasValue(f) || !prefillLabels.has(norm(f.label)));
  return [...kept, ...prefillKept];
}

// ─── I/O seam (tests stub this) ──────────────────────────────────────────────
const io = {
  /** { fields, formFile, setAside, savedAt } of a saved form file, or null when absent; throws err.transient on a storage failure. */
  readSource: (args) => htmlQ.readFormFileFull(args),
  /** { fields, completionPct } of the target file (empty when absent); throws err.transient on a storage failure. */
  readTarget: (args) => htmlQ.loadFormFileMeta(args),
  save: (args) => htmlQ.saveFormData(args),
  now: () => Date.now(),
};

/**
 * Copy the client's embedded answers into the new member's own file(s).
 * The principal's F1 is the "primary" slot, or "primary-additional" when F1
 * is the second form of a dual-form type — each slot is copied to the
 * member's matching slot. Every slot is planned and checked first; only then
 * is anything written.
 *
 * @param {object} p
 * @param {string} p.clientName
 * @param {string} p.caseRef
 * @param {string} [p.itemId]       Client Master item (saveFormData's bookkeeping)
 * @param {string} p.memberKey      'spouse' | 'child-1' | …
 * @param {string} p.memberType     'Spouse / Common-Law Partner' | 'Dependent Child'
 * @param {boolean} [p.dryRun=false]
 * @returns {Promise<object>} { copied, total, bySection, unmapped, skippedSharedTable, ambiguousDependent, written, recopied, skipped?, existing?, slots[] }
 */
async function carryEmbeddedAnswers({ clientName, caseRef, itemId, memberKey, memberType, memberName = '', dryRun = false }) {
  const none = { copied: 0, total: 0, bySection: {}, unmapped: [], skippedSharedTable: 0, ambiguousDependent: 0, givenName: '', unmatched: false, childNames: [], written: false, recopied: false, slots: [] };
  if (!EMBEDDED[memberType]) return { ...none, skipped: 'type' };
  if (!clientName || !caseRef || !memberKey) { const e = new Error('clientName, caseRef and memberKey are required.'); e.badRequest = true; throw e; }
  const memberIndex = memberIndexOf(memberKey);

  // 1. plan + check every slot (reads only; a refusal or failure writes nothing)
  const work = [];
  const result = { ...none };
  for (const slot of ['primary', 'primary-additional']) {
    const src = await io.readSource({ clientName, caseRef, formKey: slot });    // throws transient
    if (!src) continue;
    result.ambiguousDependent += countAmbiguousDependent(src.fields);
    const plan = planCarryOver({ sourceFields: src.fields, sourceSetAside: src.setAside, memberType, memberIndex, memberKey, memberName });
    const target = slot === 'primary-additional' ? `${memberKey}-additional` : memberKey;
    const info = { source: slot, target, copied: plan.copied, total: plan.total };
    result.skippedSharedTable += plan.skippedSharedTable;   // reported whether or not anything is copied
    if (plan.unmatched) { result.unmatched = true; result.childNames.push(...plan.childNames); }
    if (plan.copied === 0) { result.slots.push({ ...info, skipped: plan.unmatched ? 'unmatched' : 'nothing' }); continue; }

    // the client may still be typing on a page that shows the embedded boxes
    const savedAt = Date.parse(String(src.savedAt || ''));
    if (plan.live > 0 && Number.isFinite(savedAt) && io.now() - savedAt < RECENT_SAVE_MS) {
      const mins = Math.max(1, Math.round((io.now() - savedAt) / 60000));
      const e = new Error(`The client saved their questionnaire ${mins} minute${mins === 1 ? '' : 's'} ago and may still be typing. Try again in a few minutes.`);
      e.badRequest = true; e.code = 'RECENT_SAVE'; throw e;
    }

    const existing = await io.readTarget({ clientName, caseRef, formKey: target });   // throws transient
    const held = (existing && existing.fields) || [];
    const typed = held.filter((f) => !isPrefill(f) && !isCarried(f) && hasValue(f)).length;
    if (typed > 0) { result.slots.push({ ...info, skipped: 'has-answers', existing: typed }); continue; }
    const recopied = held.some((f) => isCarried(f) && hasValue(f));
    const fields = mergeOverPrefill(plan.fields.map((f) => ({ ...f, source: CARRY_TAG })), held);
    work.push({ ...info, plan, fields, formFile: String(src.formFile || ''), recopied });
  }

  // 2. write (or report, on a dry run)
  for (const w of work) {
    if (!dryRun) {
      await io.save({ clientName, caseRef, itemId, formKey: w.target, fields: w.fields, completionPct: w.plan.pct, formFile: w.formFile });
      console.log(`[CarryOver] ${caseRef}: copied ${w.plan.copied} embedded answer(s) (${w.plan.total} boxes) from ${w.source} into ${w.target}${w.recopied ? ' (replacing an earlier copy)' : ''}`);
    }
    result.copied += w.plan.copied;
    result.total += w.plan.total;
    for (const [s, n] of Object.entries(w.plan.bySection)) result.bySection[s] = (result.bySection[s] || 0) + n;
    result.unmapped.push(...w.plan.unmapped);
    if (w.plan.givenName && !result.givenName) result.givenName = w.plan.givenName;
    result.recopied = result.recopied || w.recopied;
    result.slots.push({ source: w.source, target: w.target, copied: w.plan.copied, total: w.plan.total, pct: w.plan.pct, formFile: w.formFile, written: !dryRun, recopied: w.recopied });
  }
  result.written = !dryRun && work.length > 0;
  if (dryRun) result.dryRun = true;
  if (!work.length) {
    const has = result.slots.find((s) => s.skipped === 'has-answers');
    result.skipped = has ? 'has-answers' : 'nothing';
    if (has) result.existing = has.existing;
  }
  return result;
}

module.exports = { planCarryOver, mergeOverPrefill, carryEmbeddedAnswers, countAmbiguousDependent, memberIndexOf, childBlockOf, memberTableKey, rekeyTableCell, slugifyFull, isEnabled, isCarried, io, EMBEDDED, CHILD_LABEL_MAP, CHILD_NO_BOX, RECENT_SAVE_MS, CARRY_TAG };
