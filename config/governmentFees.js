/**
 * IRCC / ESDC government-fee reference (MERGE-FIELD-SPEC §11). All amounts CAD.
 *
 * Source: official IRCC fee list (page last modified 2026-04-30; PR fees rose
 * 2026-04-30, citizenship 2026-03-31). These PRE-FILL the retainer's government-fee
 * line as a DEFAULT the consultant overrides per case — fees change, re-verify
 * periodically. Charged per applicant unless noted. LMIA is an ESDC fee (employer-
 * paid per position), structurally different from IRCC fees.
 *
 * Each entry (dollars):
 *   principal/spouse/child  per-applicant amounts (omit a tier = $0)
 *   withoutRprf             alternate amounts when RPRF ($600) is deferred
 *   flat / perPosition      a single fee not scaled by applicants (LMIA)
 *   familyMax               cap on the summed total (visitor family max)
 */

'use strict';

const HST_RATE = 0.13; // Ontario — applied to the professional service fee

const GOV_FEES = {
  'economic-pr': {
    label: 'Economic PR (Express Entry / CEC / Non-EE / Federal PR / PNP)',
    principal: 1590, spouse: 1590, child: 270,
    withoutRprf: { principal: 990, spouse: 990 },
    note: 'Includes RPRF $600. "Without RPRF" = $990 now + $600 later. Child $270.',
  },
  'lmia': {
    label: 'LMIA (ESDC)', flat: 1000, perPosition: true, employerPaid: true,
    note: 'ESDC $1,000 per position, employer-paid — NOT an IRCC processing fee.',
  },
  'pgp-sponsorship': {
    label: 'Parents/Grandparents Sponsorship',
    principal: 1260, spouse: 1260, child: 180,
    withoutRprf: { principal: 660 },
    note: 'Sponsorship+processing+RPRF $1,260 ($660 without RPRF). Child $180.',
  },
  'spousal-sponsorship': {
    label: 'Spousal / Common-Law Sponsorship',
    principal: 1260, spouse: 1260, child: 180,
    withoutRprf: { principal: 660 },
    note: 'Includes RPRF ($660 without). Dependent child $180.',
  },
  'study':            { label: 'Study Permit', principal: 150, spouse: 150, child: 150 },
  'open-wp':          { label: 'Open Work Permit (PGWP / BOWP / SOWP)', principal: 255, spouse: 255, child: 255, note: 'WP $155 + open-work-permit-holder $100.' },
  'employer-wp':      { label: 'Employer-specific Work Permit', principal: 155, spouse: 155, child: 155, note: 'WP $155 per person (+$100 open-WP-holder fee only if it is an open permit).' },
  'restoration-visitor': { label: 'Restoration of Status (visitor)', principal: 246.25, note: 'Visitor $246.25 · Worker $401.25 · Student $396.25 — pick per case.' },
  'visitor':          { label: 'Visitor Visa / TRV / Super Visa', principal: 100, spouse: 100, child: 100, familyMax: 500 },
  'pr-card':          { label: 'PR Card', principal: 50 },
  'prtd':             { label: 'PR Travel Document (PRTD)', principal: 50 },
  'citizenship':      { label: 'Canadian Citizenship', principal: 653, child: 100, note: 'Adult (18+) grant $653 incl. RoC $123; minor $100.' },
  'biometrics':       { label: 'Biometrics', principal: 85, spouse: 85, child: 85, familyMax: 170, note: '$85 per person, $170 family max (2+).' },
};

module.exports = { HST_RATE, GOV_FEES };
