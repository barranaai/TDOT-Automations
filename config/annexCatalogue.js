/**
 * Annex A scope-document catalogue — the single source of truth for the 27 scope
 * annexes (per MERGE-FIELD-SPEC §4/§6).
 *
 *   code        P1–P8 (permanent) / T1–T19 (temporary)
 *   id          pre-rendered PDF basename (src/templates/retainer/annexes/<id>.pdf);
 *               also what scripts/prerender-annexes.js writes — declared here so the
 *               two can never drift apart.
 *   sourceFile  the master .docx, relative to the "RCIC Roles and Responsibilities" dir
 *   govFeeKey   → config/governmentFees GOV_FEES
 *
 * The case-type → annex mapping (§6) lives here as data; the *selection logic*
 * (rules + sub-type base-vs-extension) is in src/services/retainerPlanService.
 */

'use strict';

const ANNEXES = [
  // ---- Permanent (P1–P8) ----
  { code: 'P1', id: 'express-entry',                    group: 'permanent', label: 'Express Entry',                       govFeeKey: 'economic-pr',          sourceFile: 'Permanent Applications/Express Entry Application- Annex A.docx' },
  { code: 'P2', id: 'canadian-experience-class',        group: 'permanent', label: 'Canadian Experience Class',          govFeeKey: 'economic-pr',          sourceFile: 'Permanent Applications/Canadian Experience Class Application- Annex A.docx' },
  { code: 'P3', id: 'non-express-entry',                group: 'permanent', label: 'Non-Express Entry',                  govFeeKey: 'economic-pr',          sourceFile: 'Permanent Applications/Non Express Entry Application- Annex A - Copy.docx' },
  { code: 'P4', id: 'federal-pr',                       group: 'permanent', label: 'Federal PR',                         govFeeKey: 'economic-pr',          sourceFile: 'Permanent Applications/Federal PR Application- Annex A.docx' },
  { code: 'P5', id: 'provincial-nominee-program',       group: 'permanent', label: 'Provincial Nominee Program (PNP)',   govFeeKey: 'economic-pr',          sourceFile: 'Permanent Applications/Provincial Nominee Program Application- Annex A.docx' },
  { code: 'P6', id: 'lmia',                             group: 'permanent', label: 'LMIA',                               govFeeKey: 'lmia',                 sourceFile: 'Permanent Applications/LMIA- Annex A.docx' },
  { code: 'P7', id: 'parents-grandparents-sponsorship', group: 'permanent', label: 'Parents/Grandparents Sponsorship',   govFeeKey: 'pgp-sponsorship',      sourceFile: 'Permanent Applications/Parents-Grandparents Sponsorship Application- Annex A.docx' },
  { code: 'P8', id: 'spousal-common-law-sponsorship',   group: 'permanent', label: 'Spousal / Common-Law Sponsorship',   govFeeKey: 'spousal-sponsorship',  sourceFile: 'Permanent Applications/Spousal- Common Law Sponsorship Application- Annex A.docx' },
  // ---- Temporary (T1–T19) ----
  { code: 'T1',  id: 'study-permit',                          group: 'temporary', label: 'Study Permit',                       govFeeKey: 'study',               sourceFile: 'Temporary Applications/Study Permit Application- Annex A.docx' },
  { code: 'T2',  id: 'study-permit-extension',                group: 'temporary', label: 'Study Permit Extension',             govFeeKey: 'study',               sourceFile: 'Temporary Applications/Study Permit Extension Application- Annex A.docx' },
  { code: 'T3',  id: 'post-graduate-work-permit',             group: 'temporary', label: 'Post-Graduate Work Permit (PGWP)',   govFeeKey: 'open-wp',             sourceFile: 'Temporary Applications/Post Graduate Work Permit Application- Annex A.docx' },
  { code: 'T4',  id: 'post-graduate-work-permit-extension',   group: 'temporary', label: 'PGWP Extension',                     govFeeKey: 'open-wp',             sourceFile: 'Temporary Applications/Post Graduate Work Permit Extension Application- Annex A.docx' },
  { code: 'T5',  id: 'lmia-based-work-permit',                group: 'temporary', label: 'LMIA-based Work Permit',             govFeeKey: 'employer-wp',         sourceFile: 'Temporary Applications/LMIA based Work Permit Application- Annex A.docx' },
  { code: 'T6',  id: 'lmia-based-work-permit-extension',      group: 'temporary', label: 'LMIA-based WP Extension',            govFeeKey: 'employer-wp',         sourceFile: 'Temporary Applications/LMIA based Work Permit Extension Application- Annex A.docx' },
  { code: 'T7',  id: 'bridging-open-work-permit',            group: 'temporary', label: 'Bridging Open Work Permit (BOWP)',   govFeeKey: 'open-wp',             sourceFile: 'Temporary Applications/Bridging Open Work Permit (BOWP) Application- Annex A.docx' },
  { code: 'T8',  id: 'concurrent-work-permit',               group: 'temporary', label: 'Concurrent Work Permit',             govFeeKey: 'employer-wp',         sourceFile: 'Temporary Applications/Concurrent Work Permit Application- Annex A.docx' },
  { code: 'T9',  id: 'sclpc-work-permit',                    group: 'temporary', label: 'SCLPC Work Permit',                  govFeeKey: 'employer-wp',         sourceFile: 'Temporary Applications/SCLPC Work Permit Application- Annex A.docx' },
  { code: 'T10', id: 'spousal-open-work-permit',            group: 'temporary', label: 'Spousal Open Work Permit (SOWP)',    govFeeKey: 'open-wp',             sourceFile: 'Temporary Applications/Spousal Open Work Permit Application (SOWP)- Annex A.docx' },
  { code: 'T11', id: 'spousal-open-work-permit-extension',  group: 'temporary', label: 'SOWP Extension',                     govFeeKey: 'open-wp',             sourceFile: 'Temporary Applications/Spousal Open Work Permit Extension Application (SOWP)- Annex A.docx' },
  { code: 'T12', id: 'restoration-of-status',               group: 'temporary', label: 'Restoration of Status',              govFeeKey: 'restoration-visitor', sourceFile: 'Temporary Applications/Restoration of Status Application- Annex A.docx' },
  { code: 'T13', id: 'visitor-visa',                        group: 'temporary', label: 'Visitor Visa (outside Canada)',      govFeeKey: 'visitor',             sourceFile: 'Temporary Applications/Visitor Visa (Oustide canada) Application- Annex A.docx' },
  { code: 'T14', id: 'temporary-resident-visa',             group: 'temporary', label: 'Temporary Resident Visa (TRV)',      govFeeKey: 'visitor',             sourceFile: 'Temporary Applications/Temporary Resident Visa (TRV) Application- Annex A.docx' },
  { code: 'T15', id: 'visitor-record',                      group: 'temporary', label: 'Visitor Record (change of status)',  govFeeKey: 'visitor',             sourceFile: 'Temporary Applications/Visitor Record (change of status) Application- Annex A.docx' },
  { code: 'T16', id: 'parents-grandparents-supervisa',     group: 'temporary', label: 'Parents-Grandparents Super Visa',    govFeeKey: 'visitor',             sourceFile: 'Temporary Applications/Parents-Grandparents Supervisa Application- Annex A.docx' },
  { code: 'T17', id: 'permanent-resident-card',             group: 'temporary', label: 'PR Card',                            govFeeKey: 'pr-card',             sourceFile: 'Temporary Applications/Permanent Resident Card (PR) Application- Annex A.docx' },
  { code: 'T18', id: 'permanent-resident-travel-document',  group: 'temporary', label: 'PR Travel Document (PRTD)',          govFeeKey: 'prtd',                sourceFile: 'Temporary Applications/Permanent Resident Travel Document (PRTD) Application- Annex A.docx' },
  { code: 'T19', id: 'canadian-citizenship',               group: 'temporary', label: 'Canadian Citizenship',               govFeeKey: 'citizenship',         sourceFile: 'Temporary Applications/Canadian Citizenship Application- Annex A.docx' },
];

const _byCode = Object.fromEntries(ANNEXES.map((a) => [a.code, a]));
const _byId   = Object.fromEntries(ANNEXES.map((a) => [a.id, a]));

const byCode = (code) => _byCode[code] || null;
const byId   = (id)   => _byId[id] || null;
const listByGroup = (group) => ANNEXES.filter((a) => a.group === group);

// ---- §6 case-type → annex data (rules applied in retainerPlanService.pickAnnex) ----

// All provincial programs share the PNP scope (P5).
const PNP_FAMILY = ['AAIP', 'BCPNP', 'OINP', 'MPNP', 'Manitoba PNP', 'NSNP'];
const PNP_PILOTS = ['RCIP', 'RNIP', 'SNIP']; // confirm with TDOT
// All CEC variants → P2.
const CEC_TYPES = [
  'CEC',
  'Canadian Experience Class (EE after ITA)',
  'Canadian Experience Class (Profile+ITA+Submission)',
  'Canadian Experience Class (Profile Recreation+ITA+Submission)',
];

// Primary Case Type → { code, confidence, extension?/restoration?, note? }.
// confidence: 'high' (✔ direct) · 'medium' (◑ rule/sub-type) · 'low' (❔) · code:null = no annex.
const ANNEX_BY_CASE_TYPE = {
  'Federal PR':                         { code: 'P3', confidence: 'medium', note: 'P3 (Non-EE) and P4 (Federal PR) are distinct scopes — confirm which applies.' },
  'Inland Spousal Sponsorship':         { code: 'P8', confidence: 'high' },
  'Outland Spousal Sponsorship':        { code: 'P8', confidence: 'high' },
  'Parents/Grandparents Sponsorship':   { code: 'P7', confidence: 'high' },
  'Child Sponsorship':                  { code: null, confidence: 'low', note: 'No Child Sponsorship annex — choose P8/P7 or a new annex.' },
  'Addition of Spouse':                 { code: null, confidence: 'low', note: 'Sponsorship-adjacent — confirm scope.' },
  'LMIA':                               { code: 'P6', confidence: 'high' },
  'LMIA Based WP':                      { code: 'T5', confidence: 'medium', extension: 'T6', note: 'Base T5; an Extension sub-type → T6.' },
  'SCLPC WP':                           { code: 'T9', confidence: 'high' },
  'Concurrent WP':                      { code: 'T8', confidence: 'high' },
  'BOWP':                               { code: 'T7', confidence: 'high' },
  'PGWP':                               { code: 'T3', confidence: 'medium', extension: 'T4', note: 'Base T3; an Extension sub-type → T4.' },
  'SOWP':                               { code: 'T10', confidence: 'medium', extension: 'T11', note: 'Base T10; an Extension sub-type → T11.' },
  'Study Permit':                       { code: 'T1', confidence: 'high' },
  'Study Permit Extension':             { code: 'T2', confidence: 'high' },
  'TRV':                                { code: 'T14', confidence: 'high' },
  'Visitor Visa':                       { code: 'T13', confidence: 'medium', changeOfStatus: 'T15', note: 'Assumes outside Canada (T13); an in-Canada "Change of Status" sub-type → Visitor Record (T15).' },
  'Visitor Record / Extension':         { code: 'T15', confidence: 'medium', restoration: 'T12', note: 'Base T15; a Restoration sub-type → T12.' },
  'Supervisa':                          { code: 'T16', confidence: 'high' },
  'Citizenship':                        { code: 'T19', confidence: 'high' },
  'PR Card Renewal':                    { code: 'T17', confidence: 'high' },
  'PRTD':                               { code: 'T18', confidence: 'high' },
  // Known coverage gaps (no standard annex yet — consultant chooses / new annex needed)
  'LMIA Exempt WP':                     { code: null, confidence: 'none' },
  'Francophone Mobility WP':            { code: null, confidence: 'none' },
  'Co-op WP':                           { code: null, confidence: 'none' },
  'NB WP Extension':                    { code: null, confidence: 'none' },
  'Refugee WP':                         { code: null, confidence: 'none' },
};

module.exports = {
  ANNEXES, byCode, byId, listByGroup,
  ANNEX_BY_CASE_TYPE, PNP_FAMILY, PNP_PILOTS, CEC_TYPES,
};
