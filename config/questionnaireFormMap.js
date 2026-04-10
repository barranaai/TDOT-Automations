/**
 * Questionnaire Form Map
 *
 * Maps canonical Case Type + Case Sub-Type values (from config/caseTypes.js)
 * to the HTML questionnaire files in the "Questionnair Documents/" folder.
 *
 * Rules:
 *  - Always match by full filename string (no number prefix logic).
 *  - Sub-type overrides are checked first; case-type fallback is used if no sub-type match.
 *  - resolveForm() returns null when no form is available (placeholder page is shown).
 *  - Files 15 and 16 are not yet created — affected case types are left unmapped for now.
 */

'use strict';

const path = require('path');

const FORMS_DIR = path.join(__dirname, '..', 'Questionnair Documents');

// ─── Filename constants ───────────────────────────────────────────────────────
// Use exact filenames as they exist on disk (case-sensitive).

const F1  = '1. Express Entry - PNP - PR Application -  Questionnaire - April 2025.html';
const F2  = '2. Work Permit Application Inside Canada (PGWP -SOWP- BOWP -LMIA - EXTENSION  - Questionnair - April 2025.html';
const F3  = '3. Work Permit Outside Canada (SOWP - LMIA )- Questionnaires - April 2025.html';
const F4  = '4. Citizenship - Questionnaires - April 2025.html';
const F5  = '5. Study Permit Extension - Questionnaires - April 2025.html';
const F6  = '6. Express Entry Profile - PNP Profile Creation - Questionnair - July 2025.html';
const F7  = '7. Study Permit - Inside and Outside  - Questionnaires - April 2025.html';
const F8  = '8. VisItor Visa - Outside  - Questionnaires - April 2025.html';
const F9  = '9. Lost PR Card - PR Card Renewal - PR TD   - Questionnair - April 2025.html';
const F10 = '10. Spousal Sponsorship Quetsionaires - Inside and Outside - April 2025.html';
const F11 = '11. Super Visa - Outside  - Questionnaires - April 2025.html';
const F12 = '12. Visitor Visa Extension - Questionnair - April 2025.html';
const F13 = '13. TRV - Questionnair - April 2025.html';
const F14 = 'Indian Passport Surrender Application.html';
const F17 = 'USA Visa  -  Questionnaire - April 2025.html';

// ─── Primary mapping: canonical case type → form file(s) ─────────────────────
// { primary: filename, additional?: filename }
// "additional" is only set for case types that require two forms shown side-by-side.

// ─── Member type constants ───────────────────────────────────────────────────
// Used in memberTypes arrays to define which additional members a client can add.

const SPOUSE    = 'Spouse / Common-Law Partner';
const CHILD     = 'Dependent Child';
const SPONSOR   = 'Sponsor';
const WORKER_SP = 'Worker Spouse';
const PARENT    = 'Parent';
const SIBLING   = 'Sibling';

const FORM_MAP = {

  // ── PNP / Express Entry ─────────────────────────────────────────────────────
  // Two-form cases: Profile Creation form first, then full PR Application form
  'AAIP':                                                          { primary: F6, additional: F1, memberTypes: [SPOUSE, CHILD] },
  'OINP':                                                          { primary: F6, additional: F1, memberTypes: [SPOUSE, CHILD] },
  'NSNP':                                                          { primary: F6, additional: F1, memberTypes: [SPOUSE, CHILD] },
  'BCPNP':                                                         { primary: F6, additional: F1, memberTypes: [SPOUSE, CHILD] },
  'RCIP':                                                          { primary: F6, additional: F1, memberTypes: [SPOUSE, CHILD] },
  'Manitoba PNP':                                                  { primary: F6, additional: F1, memberTypes: [SPOUSE, CHILD] },
  'RNIP':                                                          { primary: F6, additional: F1, memberTypes: [SPOUSE, CHILD] },
  'SNIP':                                                          { primary: F6, additional: F1, memberTypes: [SPOUSE, CHILD] },
  'Canadian Experience Class (EE after ITA)':                      { primary: F1, memberTypes: [SPOUSE, CHILD] },
  'Canadian Experience Class (Profile Recreation+ITA+Submission)': { primary: F6, additional: F1, memberTypes: [SPOUSE, CHILD] },
  'Canadian Experience Class (Profile+ITA+Submission)':            { primary: F6, additional: F1, memberTypes: [SPOUSE, CHILD] },
  'Federal PR':                                                    { primary: F6, additional: F1, memberTypes: [SPOUSE, CHILD] },
  // File 16 (Addition of Spouse secondary form) not yet created — single form for now
  'Addition of Spouse':                                            { primary: F1, memberTypes: [SPOUSE] },

  // ── Spousal / Family ────────────────────────────────────────────────────────
  // Spousal Sponsorship F10 already covers both members in one form — no memberTypes needed
  'Inland Spousal Sponsorship':                                    { primary: F10 },
  'Outland Spousal Sponsorship':                                   { primary: F10 },
  // File 15 (Parents/Grandparents/Children sponsorship) not yet created — unmapped

  // ── Work Permits ─────────────────────────────────────────────────────────────
  'BOWP':                { primary: F2, memberTypes: [SPOUSE, CHILD] },
  'Co-op WP':            { primary: F2, memberTypes: [SPOUSE, CHILD] },
  'Concurrent WP':       { primary: F2, memberTypes: [SPOUSE] },
  'LMIA Exempt WP':      { primary: F2, memberTypes: [SPOUSE, CHILD] },
  'PGWP':                { primary: F2, memberTypes: [SPOUSE, CHILD] },
  'Refugee WP':          { primary: F2 },
  'SCLPC WP':            { primary: F2, memberTypes: [CHILD] },
  'NB WP Extension':     { primary: F2, memberTypes: [WORKER_SP] },
  'Francophone Mobility WP': { primary: F2, memberTypes: [WORKER_SP] },
  // LMIA Based WP and SOWP have sub-type overrides (see FORM_SUBTYPE_MAP below).
  // These entries are the fallback when sub-type is absent or unrecognised.
  'LMIA Based WP':       { primary: F2, memberTypes: [SPOUSE, CHILD] },
  'SOWP':                { primary: F2, memberTypes: [WORKER_SP, CHILD] },

  // ── Visitor / Super Visa / TRV ───────────────────────────────────────────────
  'Supervisa':           { primary: F11, memberTypes: [SPOUSE] },
  'TRV':                 { primary: F13 },
  'Visitor Record / Extension': { primary: F12, memberTypes: [SPOUSE, CHILD] },
  // Visitor Visa has sub-type overrides with different memberTypes per sub-type.
  'Visitor Visa':        { primary: F8, memberTypes: [SPOUSE, CHILD] },

  // ── PR / Citizenship ─────────────────────────────────────────────────────────
  'PR Card Renewal':     { primary: F9, memberTypes: [SPOUSE, CHILD] },
  'PRTD':                { primary: F9, memberTypes: [SPOUSE, CHILD] },
  'Citizenship':         { primary: F4, memberTypes: [SPOUSE, CHILD] },

  // ── Study ─────────────────────────────────────────────────────────────────────
  'Study Permit':           { primary: F7, memberTypes: [SPOUSE, CHILD] },
  'Study Permit Extension': { primary: F5, memberTypes: [SPOUSE, CHILD] },

  // ── Other ─────────────────────────────────────────────────────────────────────
  'USA Visa':              { primary: F17 },
  'OCI / Passport Surrender': { primary: F14 },
};

// ─── Sub-type overrides ───────────────────────────────────────────────────────
// Checked before FORM_MAP when both caseType and caseSubType are set.
// Structure: { [caseType]: { [subType]: { primary, additional? } } }

const FORM_SUBTYPE_MAP = {
  'LMIA Based WP': {
    'Inside Canada':             { primary: F2, memberTypes: [SPOUSE, CHILD] },
    'Extension (Inside Canada)': { primary: F2, memberTypes: [SPOUSE, CHILD] },
    'Outside Canada':            { primary: F3, memberTypes: [SPOUSE, CHILD] },
  },
  'SOWP': {
    'Inland - Established Relationship':     { primary: F2, memberTypes: [WORKER_SP] },
    'Inland - Non Established Relationship': { primary: F2, memberTypes: [WORKER_SP] },
    'Extension (Spouse or Child)':           { primary: F2, memberTypes: [WORKER_SP, CHILD] },
    'Outland (Spouse or Child)':             { primary: F3, memberTypes: [WORKER_SP, CHILD] },
  },
  'Visitor Visa': {
    'Both Parents':                              { primary: F8, memberTypes: [PARENT] },
    'Single Parent':                             { primary: F8, memberTypes: [PARENT] },
    'Parents & Siblings':                        { primary: F8, memberTypes: [PARENT, SIBLING] },
    '1-2 Members':                               { primary: F8, memberTypes: [SPOUSE] },
    '1-3 Members':                               { primary: F8, memberTypes: [SPOUSE, CHILD] },
    'Spouse':                                    { primary: F8, memberTypes: [SPOUSE] },
    'Spousal Sponsorship in Process':            { primary: F8, memberTypes: [SPOUSE] },
    // Change of Status has no accompanying members — single applicant
    'Change of Status (Student/Worker to Visitor)': { primary: F12 },
  },
};

// ─── Public resolver ──────────────────────────────────────────────────────────

/**
 * Resolve which form file(s) to serve for a given case.
 *
 * @param {string}      caseType - Canonical case type (from config/caseTypes.js)
 * @param {string|null} subType  - Case sub-type value (may be null or empty string)
 * @returns {{ primary: string, additional: string|null, memberTypes: string[]|null } | null}
 *   Returns null when no HTML form is available for this case type.
 *   The caller should show a placeholder page in that case.
 */
function resolveForm(caseType, subType) {
  const type = (caseType || '').trim();
  const sub  = (subType  || '').trim() || null;

  // 1. Sub-type override — most specific, checked first
  if (sub && FORM_SUBTYPE_MAP[type]?.[sub]) {
    const entry = FORM_SUBTYPE_MAP[type][sub];
    return {
      primary:     entry.primary,
      additional:  entry.additional || null,
      memberTypes: entry.memberTypes || null,
    };
  }

  // 2. Case-type fallback
  const entry = FORM_MAP[type];
  if (entry) {
    return {
      primary:     entry.primary,
      additional:  entry.additional || null,
      memberTypes: entry.memberTypes || null,
    };
  }

  // 3. No form available — placeholder page
  return null;
}

/**
 * Resolve which additional member types are allowed for a given case.
 *
 * @param {string}      caseType - Canonical case type
 * @param {string|null} subType  - Case sub-type (optional)
 * @returns {string[]}  Array of allowed member type labels, or empty array if single-member only.
 */
function resolveMemberTypes(caseType, subType) {
  const form = resolveForm(caseType, subType);
  return form?.memberTypes || [];
}

module.exports = { FORMS_DIR, resolveForm, resolveMemberTypes, MEMBER_TYPE: { SPOUSE, CHILD, SPONSOR, WORKER_SP, PARENT, SIBLING } };
