/**
 * retainerPlanBuilder — the PURE bridge from a Monday lead (+ consultant
 * overrides) to the proposed retainer plan: which template, which scope annex,
 * the fees, the government-fee default, the milestone schedule, and the merge
 * `data` object that retainerDocService.generate consumes.
 *
 * No I/O. Call with no overrides to get the system's *suggestion* (what the
 * portal pre-fills); call again with the consultant's confirmed/edited values to
 * get the final plan. `ready` says whether generation may proceed; `warnings`
 * drives the portal's "please verify / fill this" UX.
 *
 * Field sourcing is grounded in the real lead schema (verified, not guessed):
 *   paName    = lead.fullName || lead.name        paEmail = lead.email
 *   paPhone   = lead.phone                         paAddress = lead.residentialAddress (V2-only, may be '')
 *   caseType  = override || lead.confirmedCaseType || lead.caseTypeInterest
 *   subType   = override only (NO lead column — only Client Master / consultant)
 *   fee       = feeToCents(lead.retainerFee)  [DOLLAR STRING → cents]
 *   hasSpouse = lead.hasSpouse === 'Yes'      [status text, not a boolean]
 *   inviter / employer fields = consultant-entered (not captured anywhere upstream)
 */

'use strict';

const { feeToCents, centsToMoney, dollarsToMoney } = require('../utils/money');
const { byCode } = require('../../config/annexCatalogue');
const {
  pickAnnex, suggestTemplate, applicantCount, computeFees, computeGovFee,
  defaultMilestones, validateMilestones,
} = require('./retainerPlanService');

function todayISO() { return new Date().toISOString().split('T')[0]; }

function formatAgreementDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

// Fields a given master template requires from the consultant (not on the lead).
const TEMPLATE_NEEDS = {
  'pa-inviter': ['inviterName', 'inviterAddress', 'inviterPhone', 'inviterEmail'],
  'employer':   ['empRepName', 'empCompanyName', 'empCompanyAddress', 'empCompanyPhone', 'empRepPhone', 'empRepEmail'],
};

/**
 * @param {object} lead       from leadService.getLead
 * @param {object} overrides  consultant-confirmed: { caseType, subType, annexCode,
 *   template, hasInviter, isEmployer, feeCents, govFeeDollars, withRprf,
 *   milestones, paymentAnnexNo, applicationType, agreementDate, inviter*, emp* }
 * @returns {object} the proposed plan (see fields below)
 */
function buildRetainerPlan(lead = {}, overrides = {}) {
  const o = overrides || {};
  const warnings = [];

  // --- case type / sub type ---
  const caseType = String(o.caseType || lead.confirmedCaseType || lead.caseTypeInterest || '').trim();
  const subType  = String(o.subType || '').trim(); // no lead column — consultant / Client Master sourced
  if (!o.caseType && !lead.confirmedCaseType && lead.caseTypeInterest) {
    warnings.push('Case type is the client-stated interest (not staff-confirmed) — verify before generating.');
  }

  // --- scope annex (suggested; consultant may override the code) ---
  const suggestion = pickAnnex(caseType, subType);
  const annexCode  = o.annexCode || suggestion.code;
  const annex      = annexCode ? byCode(annexCode) : null;
  if (!annexCode) warnings.push(suggestion.basis || 'No scope annex selected — choose one.');
  else if (!o.annexCode && suggestion.needsVerify) warnings.push(`Verify scope annex (${suggestion.confidence}): ${suggestion.basis}`);
  if (annexCode && !annex) warnings.push(`Annex code "${annexCode}" is not in the catalogue.`);

  // --- signatory template ---
  const template = o.template || suggestTemplate({ annexCode, hasInviter: o.hasInviter, isEmployer: o.isEmployer });

  // --- fee → service / HST / total ---
  const feeCents = (o.feeCents != null) ? o.feeCents : feeToCents(lead.retainerFee);
  const fees = (feeCents != null) ? computeFees(feeCents) : null;
  if (feeCents == null) warnings.push('Retainer fee is not set — the agreement states the fee, so it cannot be generated yet.');

  // --- applicants + government fee (a default the consultant overrides) ---
  const applicants = applicantCount({ hasSpouse: lead.hasSpouse === 'Yes', childrenCount: lead.childrenCount });
  const withRprf = (o.withRprf !== undefined) ? !!o.withRprf : true;
  const govFeeCalc = annex ? computeGovFee(annex.govFeeKey, applicants, { withRprf }) : null;
  const govFeeDollars = (o.govFeeDollars != null) ? Number(o.govFeeDollars)
    : (govFeeCalc ? govFeeCalc.totalDollars : null);
  if (annex && !govFeeCalc) warnings.push('No default government fee for this annex — enter it manually.');

  // --- milestones ---
  const milestones = Array.isArray(o.milestones) ? o.milestones
    : (feeCents != null ? defaultMilestones(feeCents) : []);
  const milestoneCheck = (feeCents != null)
    ? validateMilestones(milestones, feeCents)
    : { ok: false, sumCents: 0, feeCents: 0, diffCents: 0, errors: ['Set the retainer fee before building milestones.'] };
  if (!milestoneCheck.ok) milestoneCheck.errors.forEach((e) => warnings.push(`Milestones: ${e}`));

  // --- merge data for the .docx ---
  const applicationType = String(o.applicationType || (annex ? annex.label : caseType) || '');
  const paName    = lead.fullName || lead.name || '';
  const paAddress = lead.residentialAddress || '';
  if (!paAddress) warnings.push('Client residential address is blank — add it before generating.');
  if (!lead.email) warnings.push('Client email is blank — the agreement cannot be emailed.');

  const mergeData = {
    agreementDate:  formatAgreementDate(o.agreementDate || todayISO()),
    paName,
    paAddress,
    paPhone:  lead.phone || '',
    paEmail:  lead.email || '',
    applicationType,
    scopeAnnexNo:   annexCode || '',
    paymentAnnexNo: o.paymentAnnexNo || '',
    serviceFees: fees ? centsToMoney(fees.serviceFeeCents) : '',
    hst:         fees ? centsToMoney(fees.hstCents) : '',
    total:       fees ? centsToMoney(fees.totalCents) : '',
    govFee:      (govFeeDollars != null) ? dollarsToMoney(govFeeDollars) : '',
    // inviter block (pa-inviter) — consultant-entered
    inviterName:    o.inviterName || '',
    inviterAddress: o.inviterAddress || '',
    inviterPhone:   o.inviterPhone || '',
    inviterEmail:   o.inviterEmail || '',
    // employer block (employer) — consultant-entered
    empRepName:        o.empRepName || '',
    empCompanyName:    o.empCompanyName || '',
    empCompanyAddress: o.empCompanyAddress || '',
    empCompanyPhone:   o.empCompanyPhone || '',
    empRepPhone:       o.empRepPhone || '',
    empRepEmail:       o.empRepEmail || '',
  };

  // template-specific fields the consultant still owes
  const missingForTemplate = (TEMPLATE_NEEDS[template] || []).filter((k) => !String(mergeData[k] || '').trim());
  if (missingForTemplate.length) {
    warnings.push(`The "${template}" template needs: ${missingForTemplate.join(', ')} — enter in the portal.`);
  }

  const ready = !!(template && annexCode && annex && feeCents != null && milestoneCheck.ok && missingForTemplate.length === 0);

  return {
    ready,
    template,
    annex: {
      code: annexCode || null,
      id: annex ? annex.id : null,
      label: annex ? annex.label : null,
      group: annex ? annex.group : null,
      confidence: o.annexCode ? 'confirmed' : suggestion.confidence,
      needsVerify: o.annexCode ? false : suggestion.needsVerify,
      basis: suggestion.basis,
    },
    caseType,
    subType,
    applicants,
    fees: fees ? { ...fees, feeCents } : null,
    govFee: {
      dollars: govFeeDollars,
      withRprf,
      employerPaid: govFeeCalc ? !!govFeeCalc.employerPaid : false,
      detail: govFeeCalc || null,
    },
    milestones,
    milestoneCheck,
    mergeData,
    missingForTemplate,
    warnings,
  };
}

/**
 * Reconstruct the consultant's saved plan overrides from a lead's persisted
 * retainer columns (the inverse of what the portal save writes). Pure.
 */
function overridesFromLead(lead = {}) {
  let milestones;
  if (lead.retainerMilestones) {
    try { const a = JSON.parse(lead.retainerMilestones); if (Array.isArray(a)) milestones = a; } catch (_) { /* garbage → default */ }
  }
  const o = {
    subType:       lead.selectedSubType || '',
    annexCode:     lead.selectedScopeAnnex || undefined,
    template:      lead.selectedTemplate || undefined,
    govFeeDollars: lead.govFee ? Number(lead.govFee) : undefined,
    withRprf:      lead.retainerWithRprf ? (lead.retainerWithRprf !== 'No') : undefined,
    milestones,
  };
  for (const k of ['inviterName', 'inviterAddress', 'inviterPhone', 'inviterEmail',
                   'empRepName', 'empCompanyName', 'empCompanyAddress', 'empCompanyPhone', 'empRepPhone', 'empRepEmail']) {
    if (lead[k]) o[k] = lead[k];
  }
  return o;
}

module.exports = { buildRetainerPlan, overridesFromLead, TEMPLATE_NEEDS, formatAgreementDate };
