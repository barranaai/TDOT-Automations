'use strict';

/**
 * Cross-form pre-fill (2026-10-09, case 2026-CEC-PS-100).
 *
 * Express Entry cases use TWO forms: the profile form (F6 "Express Entry
 * Profile – PNP Profile Creation", F19 likewise) and the full application form
 * (F1 "Express Entry – PNP – PR Application"). When a spouse is added, the
 * carry-over copies what the client typed for the spouse in the profile form
 * into the spouse's own profile-form section. The spouse's APPLICATION-form
 * section would start empty, although the profile form already holds the
 * name, education and job history.
 *
 * This module PRE-FILLS the spouse's application-form section from those
 * profile-form answers, the way the intake pre-fill does: every pre-filled
 * answer is tagged source "prefill", so it shows in its box for the client to
 * review and becomes an answer only when the client saves; it is never counted
 * as the client's own answer before that.
 *
 * The mapping is by hand, question by question (see MAP_BOXES / MAP_TABLES),
 * against the real forms — test/questionnaireCrossFormPrefill.test.js checks
 * every target question exists on the application form exactly as written.
 * Anything with no question on the application form is reported, not guessed.
 *
 * Rules:
 *   - written ONLY when the member's application-form file does not exist yet
 *     (never over anything — not even an intake pre-fill);
 *   - the file records the application-form edition the case is SERVED, and
 *     the mapping is for the CURRENT edition only: a case served an older
 *     edition (its questions differ) gets nothing pre-filled, and says so;
 *   - no Monday column, no email, no PDF.
 */

const htmlQ = require('./htmlQuestionnaireService');
const { memberTableKey } = require('./questionnaireCarryOverService');

const SEP = ' › ';
const hasValue = (f) => !!f && String(f.value == null ? '' : f.value).trim() !== '';
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The form pair this pre-fill is for: the profile form as the first form, the application form as the second. */
function isProfileToApplication(forms) {
  return !!(forms && /express entry profile/i.test(String(forms.primary || '')) && /^1\. express entry/i.test(String(forms.additional || '')));
}

/* Profile-form question (section, label) → application-form (section, label). The sections are the
   member section's own (no top header), exactly as the application form stores them. */
const MAP_BOXES = [
  [['Section 1 — Profile Details', 'Family Name (Surname)'],                                      ['Personal Details', 'Family Name (Surname)']],
  [['Section 1 — Profile Details', 'Given Name'],                                                 ['Personal Details', 'Given Name']],
  [['Section 1 — Profile Details', 'Have you ever used any other name? (If yes, please provide details)'], ['Personal Details', 'Have you ever used any other name?']],
  [['Section 1 — Profile Details', 'Family Name:'],                                               ['Personal Details', 'Previous Family Name']],
  [['Section 1 — Profile Details', 'Given Name:'],                                                ['Personal Details', 'Previous Given Name']],
  [['Section 1 — Profile Details', 'Current Residence Country'],                                  ['Personal Details', 'Current Residence Country']],
  [['Section 1 — Profile Details', 'Native Language'],                                            ['Personal Details', 'Native Language']],
  [['Section 1 — Profile Details', 'Email Address'],                                              ['Personal Details', 'Email Address']],
  [['Section 1 — Profile Details', 'Mobile Number'],                                              ['Personal Details', 'Phone Number']],
  [['Section 2 — Employment History', 'Have you declared your international experience in any of your previous IRCC applications (e.g., Study Permit, Work Permit, Visitor Visa, PNP, etc.)? – YES or NO. If NO, please provide an explanation.'],
                                                                                                  ['Section 5 — Personal History', 'Have you declared your international experience in any of your previous IRCC applications (e.g., Study Permit, Work Permit, Visitor Visa, PNP, etc.)? If NO, please provide an explanation.']],
  [['Section 2 — Employment History', 'Explanation'],                                             ['Section 5 — Personal History', 'Explanation']],
];

/* Two profile-form answers that become ONE application-form answer ("Yes — Ontario"). */
const MAP_SIBLINGS = { from: [['Section 1 — Profile Details', 'Do you have siblings in Canada as a Permanent Resident?'], ['Section 1 — Profile Details', 'If yes, in which province he/she resides']], to: ['Personal Details', 'Siblings in Canada who are Permanent Residents?'] };

/* The spouse's "Marital Status" on the application form asks about the PRINCIPAL — from the principal's own profile-form answers. */
const MAP_MARITAL = [
  ['Current Marital Status',     ['Marital Status', 'Current Marital Status']],
  ['Date of Marriage / Common Law', ['Marital Status', 'Date of Marriage']],
  ['Family Name (Surname)',      ['Marital Status', "Spouse's Family Name"]],
  ['Given Name',                 ['Marital Status', "Spouse's Given Name"]],
];

/* Profile-form table → application-form table: column by column. A target column may be built from several source columns. */
const MAP_TABLES = [
  { from: 'dep-education', fromSection: 'Section 2 — Education › Table', to: 'sp-education', toSection: 'Section 4 — Education and Employment', columns: [
    ['Start Date (DD/MM/YYYY)', 'Start Date'],
    ['End Date (DD/MM/YYYY)', 'End Date'],
    ['Course / Program Name', 'Course / Program'],
    ['Education Institute', 'Institute'],
    // the application form asks the city WITH the address; the profile form asked the address and "City, Country" apart.
    // The address wins; else the city is the part before the last comma. A lone word ("Canada"? "Colombo"?) is not
    // guessed either way — it is reported instead (first entry to fill a target column wins).
    ['Campus Address with Postal Code', 'City (Address with Postal Code)'],
    [['City, Country'], 'City (Address with Postal Code)', (v) => { const s = String(v[0] || '').trim(); const i = s.lastIndexOf(','); return i >= 0 ? s.slice(0, i).trim() : ''; }],
    [['City, Country'], 'Country', (v) => { const s = String(v[0] || '').trim(); const i = s.lastIndexOf(','); return i >= 0 ? s.slice(i + 1).trim() : ''; }],
  ] },
  { from: 'dep-employment', fromSection: 'Section 2 — Employment History › Table', to: 'sp-history', toSection: 'Section 5 — Personal History', columns: [
    ['Start Date (DD/MM/YYYY)', 'Start Date'],
    ['End Date (DD/MM/YYYY)', 'End Date'],
    ['Job Title', 'Job Title / Education'],
    ['NOC Code (if known)', 'NOC Code (if known)'],
    ['Company Name', 'Company / School'],
    [['City', 'Country'], 'City & Country (Address with Postal Code)', (v) => v.map((x) => String(x || '').trim()).filter(Boolean).join(', ')],
  ] },
];
/* Profile-form questions with NO question on the application form (reported when answered). */
const NO_TARGET = ['Status in Current Country (Visitor, Student, Worker, Citizen)', 'Residential Address Postal Code', 'Do you have valid language test results?',
  'Did you complete at least 50% of the study or training program’s courses through in-person learning? – If Yes, please provide the duration of Online program.'];

const boxKey = (section, label) => `prefill__xform-${slug(section)}-${slug(label)}`.slice(0, 90);
const ROW_RE = /\s—\sRow\s(\d+)$/;

/**
 * PURE: the application-form fields to pre-fill for a member.
 * @param {object} p
 * @param {Array}  p.memberFields     the member's profile-form fields (sections without the top header, as the carry-over wrote them)
 * @param {Array}  [p.principalFields] the principal's own profile-form fields (for the spouse's "Marital Status")
 * @param {string} p.memberKey
 * @returns {{ fields: Array, copied: number, bySection: Object, unmapped: string[] }}
 */
function planCrossFormPrefill({ memberFields = [], principalFields = [], memberKey = 'spouse' } = {}) {
  const out = [];
  const unmapped = [];
  const mem = (Array.isArray(memberFields) ? memberFields : []).filter((f) => f && typeof f === 'object');
  // the member's fields come without a top header (the carry-over's form); a top header, if present, is dropped
  const strip = (s) => String(s || '').replace(/^(?:dependent|main applicant)[^›]*›\s/i, '');
  const push = (section, label, value, key) => { if (String(value == null ? '' : value).trim() === '') return; out.push({ section, label, key: key || boxKey(section, label), value: String(value).trim(), source: 'prefill' }); };

  // boxes
  const used = new Set();
  for (const [[fromSec, fromLabel], [toSec, toLabel]] of MAP_BOXES) {
    const f = mem.find((x) => strip(x.section) === fromSec && String(x.label || '').trim() === fromLabel);
    if (!f) continue;
    used.add(f);
    push(toSec, toLabel, f.value);
  }
  // siblings in Canada: the yes/no and the province become one answer. The province box only shows for "yes" on the
  // profile form, but the engine saves it hidden too — so a province next to a "no" is a stale leftover, not an answer.
  {
    const [sel, prov] = MAP_SIBLINGS.from.map(([sec, lab]) => mem.find((x) => strip(x.section) === sec && String(x.label || '').trim() === lab));
    if (sel && hasValue(sel)) {
      used.add(sel); if (prov) used.add(prov);
      const yn = String(sel.value).trim(); const cap = yn.charAt(0).toUpperCase() + yn.slice(1);
      push(MAP_SIBLINGS.to[0], MAP_SIBLINGS.to[1], /^yes/i.test(yn) && prov && hasValue(prov) ? `${cap} — ${String(prov.value).trim()}` : cap);
    }
  }
  // marital status, from the principal's own answers
  const own = (Array.isArray(principalFields) ? principalFields : []).filter((x) => x && !/^dependent/i.test(String(x.section || '').split(SEP)[0]) && hasValue(x));
  for (const [fromLabel, [toSec, toLabel]] of MAP_MARITAL) {
    const f = own.find((x) => String(x.label || '').trim() === fromLabel);
    if (f) push(toSec, toLabel, f.value);
  }
  // tables, row by row
  for (const t of MAP_TABLES) {
    const cells = mem.filter((x) => strip(x.section) === t.fromSection && ROW_RE.test(String(x.label || '')) && new RegExp(`-tbl-(?:[a-z0-9]+-)?${t.from}-r\\d+-`).test(String(x.key || '')));
    const rows = new Map();
    for (const c of cells) { const n = Number(ROW_RE.exec(c.label)[1]); const header = String(c.label).replace(ROW_RE, ''); if (!rows.has(n)) rows.set(n, new Map()); rows.get(n).set(header, c); used.add(c); }
    for (const [n, cols] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      const filled = new Set();   // target columns already written for this row (first entry wins)
      const placed = new Set();   // source cells that landed somewhere
      for (const [from, toHeader, fn] of t.columns) {
        if (filled.has(toHeader)) continue;
        const srcs = (Array.isArray(from) ? from : [from]).map((h) => cols.get(h)).filter((c) => c && hasValue(c));
        if (!srcs.length) continue;
        const vals = (Array.isArray(from) ? from : [from]).map((h) => { const c = cols.get(h); return c ? c.value : ''; });
        const value = fn ? fn(vals) : vals[0];
        if (String(value == null ? '' : value).trim() === '') continue;
        push(`${t.toSection}${SEP}Table`, `${toHeader} — Row ${n}`, value, memberTableKey(t.toSection, `${memberKey}-${t.to}`, n, toHeader));
        filled.add(toHeader); srcs.forEach((c) => placed.add(c));
      }
      // a typed cell that landed nowhere (a lone word in "City, Country") is reported, not guessed
      for (const [header, c] of cols) { if (hasValue(c) && !placed.has(c)) { const label = `${t.from.replace(/^dep-/, '')} table: ${header}`; if (!unmapped.includes(label)) unmapped.push(label); } }
    }
  }
  // answered but nowhere to go (a table cell is named with its table, so "Start Date" of the vacation table is not read as the job dates)
  for (const f of mem) {
    if (used.has(f) || !hasValue(f)) continue;
    let label = String(f.label || '').replace(ROW_RE, '').trim();
    const tm = /-tbl-(?:[a-z0-9]+-)?([a-z0-9-]+?)-r\d+-/.exec(String(f.key || ''));
    if (tm && ROW_RE.test(String(f.label || ''))) label = `${tm[1].replace(/^dep-/, '')} table: ${label}`;
    if (!unmapped.includes(label)) unmapped.push(label);
  }
  const bySection = {};
  for (const f of out) { const s = f.section.replace(/ › Table$/, ''); bySection[s] = (bySection[s] || 0) + 1; }
  return { fields: out, copied: out.length, bySection, unmapped };
}

// ─── I/O seam (tests stub this) ──────────────────────────────────────────────
const io = {
  readTarget: (args) => htmlQ.loadFormFileMeta(args),
  servedForms: (args) => htmlQ.versionFormFilesForCase(args),
  save: (args) => htmlQ.saveFormData(args),
};

/**
 * Plan (and, unless dryRun, write) the member's application-form pre-fill.
 * Reads first and throws err.transient on a storage failure; writes nothing
 * when the member's application-form file already exists.
 * @returns {Promise<object>} { target, copied, bySection, unmapped, formFile, written, skipped? }
 */
async function crossFormPrefill({ clientName, caseRef, itemId, memberKey, memberFields, principalFields, forms, dryRun = false }) {
  const target = `${memberKey}-additional`;
  const base = { target, copied: 0, bySection: {}, unmapped: [], formFile: '', written: false };
  if (!isProfileToApplication(forms)) return { ...base, skipped: 'not-this-form-pair' };
  const existing = await io.readTarget({ clientName, caseRef, formKey: target });      // throws transient
  if (existing && existing.fields && existing.fields.length) return { ...base, skipped: 'has-file', existing: existing.fields.length };
  // the edition this case is SERVED — the mapping names the current edition's questions; an older edition gets nothing
  const served = await io.servedForms({ clientName, caseRef, formFiles: forms });   // throws transient
  const formFile = String((served && served.additional) || forms.additional || '');
  if (formFile !== String(forms.additional)) return { ...base, formFile, skipped: 'legacy-edition' };
  const plan = planCrossFormPrefill({ memberFields, principalFields, memberKey });
  if (plan.copied === 0) return { ...base, unmapped: plan.unmapped, skipped: 'nothing' };
  const result = { ...base, copied: plan.copied, bySection: plan.bySection, unmapped: plan.unmapped, formFile };
  if (dryRun) return { ...result, dryRun: true };
  await io.save({ clientName, caseRef, itemId, formKey: target, fields: plan.fields, completionPct: 0, formFile });
  console.log(`[CrossFormPrefill] ${caseRef}: pre-filled ${plan.copied} answer(s) from the profile form into ${target} (${plan.unmapped.length} with no box there)`);
  return { ...result, written: true };
}

module.exports = { planCrossFormPrefill, crossFormPrefill, isProfileToApplication, io, MAP_BOXES, MAP_SIBLINGS, MAP_MARITAL, MAP_TABLES, NO_TARGET };
