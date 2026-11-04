'use strict';

/**
 * "Source / Reference" — how a lead reached us, or who sent them (team meeting,
 * Faran 2026-11-04). ONE list for the Add-lead pop-up, the lead page's Edit
 * basics box and the server checks, so the spelling can never drift.
 *
 * Every value here MUST already be a label on the Leads board dropdown
 * "Source / Reference" (dropdown_mm44g4xg). Add lead creates the row with
 * create_item, which cannot add labels — an unknown label fails the whole
 * create. The 9 newer labels were added on Monday on 2026-11-04 (through the
 * test lead, which was put back). To add a choice: add the label on Monday
 * FIRST, then here. "Direct Retainer" is never a staff choice (the direct-client
 * form sets it).
 */

const LEAD_SOURCES = Object.freeze([
  'Phone', 'WhatsApp', 'Email', 'Instagram', 'Facebook', 'TikTok', 'LinkedIn', 'Website',
  'Client Referral', 'Employee Referral', 'Existing Client',
  'Nasir Khan', 'Aman Galhotra', 'Shafoli Friend',
  'Other',
]);

/** Picking this asks "Which employee?" (a name from REFERRAL_EMPLOYEES). */
const EMPLOYEE_REFERRAL = 'Employee Referral';
/** Picking one of these asks "Which client?" (searched on the old Consultations board, or typed). */
const CLIENT_REFERRAL_SOURCES = Object.freeze(['Existing Client', 'Client Referral']);

/**
 * The employees a lead can be referred by — the team's Monday accounts as
 * confirmed by Faran on 2026-11-04, spelled as on Monday. A SEPARATE list on
 * purpose: config/portalStaff.js (Added by, lead owner) is a different roster
 * that other features depend on.
 */
const REFERRAL_EMPLOYEES = Object.freeze([
  'Ali Ashrafi', 'Anna Liza Mayo', 'Asmita Acharya', 'Deeksha Sharma', 'Diana', 'Farahnaz Orang',
  'Gauri Berde', 'Kamalpreet K Grewal', 'Melanie Santiago', 'Monica Paola', 'Prajawal Gurung',
  'Shafoli Kapur', 'Shermin Teymouri Mofrad', 'Soniya',
]);

/** The longest referrer name kept (a client name typed by hand). */
const REFERRED_BY_MAX = 120;

/** 'employee' | 'client' | '' — which second question a source asks. */
function referralKind(source) {
  const s = String(source == null ? '' : source).trim();
  if (s === EMPLOYEE_REFERRAL) return 'employee';
  if (CLIENT_REFERRAL_SOURCES.includes(s)) return 'client';
  return '';
}

/**
 * Check the second answer for a referral source.
 * @returns {{ ok: true, referredBy: string } | { ok: false, error: string }}
 *   referredBy is '' for a source that asks no second question.
 */
function checkReferral(source, referredBy) {
  const kind = referralKind(source);
  const v = String(referredBy == null ? '' : referredBy).replace(/\s+/g, ' ').trim();
  if (kind === 'employee') {
    if (!v) return { ok: false, error: 'Choose which employee referred them.' };
    if (!REFERRAL_EMPLOYEES.includes(v)) return { ok: false, error: 'Choose the employee from the list.' };
    return { ok: true, referredBy: v };
  }
  if (kind === 'client') {
    if (!v) return { ok: false, error: 'Choose the client from the list, or type their name.' };
    if (v.length > REFERRED_BY_MAX) return { ok: false, error: `The client's name is too long (max ${REFERRED_BY_MAX} characters).` };
    return { ok: true, referredBy: v };
  }
  return { ok: true, referredBy: '' };
}

module.exports = {
  LEAD_SOURCES, EMPLOYEE_REFERRAL, CLIENT_REFERRAL_SOURCES, REFERRAL_EMPLOYEES, REFERRED_BY_MAX,
  referralKind, checkReferral,
};
