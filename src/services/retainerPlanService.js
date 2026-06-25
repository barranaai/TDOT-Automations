/**
 * retainerPlanService — pure helpers that turn case signals into the retainer
 * plan the consultant confirms (MERGE-FIELD-SPEC §6/§9/§10/§11):
 *   pickAnnex          case type + sub-type → suggested scope annex (+ confidence + basis)
 *   suggestTemplate    signals → which signatory master (pa / pa-inviter / employer)
 *   applicantCount     lead.hasSpouse + childrenCount → { adults, children, total }
 *   computeFees        professional fee → HST + total (Ontario 13%)
 *   computeGovFee      annex gov-fee key + applicants → default government-fee total
 *   defaultMilestones  professional fee → 4 default rows (row 1 = non-refundable admin)
 *   validateMilestones rows must sum to the professional fee, row 1 locked
 *
 * No I/O, no Monday — deterministic and unit-tested. The consultant is the final
 * authority; these only *propose*.
 */

'use strict';

const {
  byCode, ANNEX_BY_CASE_TYPE, PNP_FAMILY, PNP_PILOTS, CEC_TYPES,
} = require('../../config/annexCatalogue');
const { HST_RATE, GOV_FEES } = require('../../config/governmentFees');

// ---- Annex selection (§6) ----

function annexResult(code, confidence, basis) {
  const annex = code ? byCode(code) : null;
  return {
    code: code || null,
    annexId: annex ? annex.id : null,
    label: annex ? annex.label : null,
    confidence,                 // 'high' | 'medium' | 'low' | 'none'
    needsVerify: confidence !== 'high',
    basis,
  };
}

/**
 * Suggest the scope annex for a case. Rules (PNP family, CEC, sub-type
 * base-vs-extension) per §6a; otherwise the §6b table. Returns null code for the
 * known coverage gaps — the consultant must then choose from the full list.
 */
function pickAnnex(caseType, subType) {
  caseType = (caseType || '').trim();
  subType  = (subType || '').trim();

  if (!caseType) return annexResult(null, 'none', 'No case type yet — consultant selects the scope annex.');
  if (CEC_TYPES.includes(caseType)) return annexResult('P2', 'high', `Case type "${caseType}" → CEC scope (P2).`);
  if (PNP_FAMILY.includes(caseType)) return annexResult('P5', 'high', `"${caseType}" is a PNP-family program → PNP scope (P5).`);
  if (PNP_PILOTS.includes(caseType)) return annexResult('P5', 'low', `"${caseType}" is a PNP pilot → likely PNP scope (P5) — confirm.`);

  const e = ANNEX_BY_CASE_TYPE[caseType];
  if (!e) return annexResult(null, 'none', `No standard annex maps to "${caseType}" — consultant must choose.`);
  if (!e.code) return annexResult(null, e.confidence, e.note || `No standard annex for "${caseType}" — consultant must choose.`);

  let code = e.code;
  let basis = e.note ? `Case type "${caseType}". ${e.note}` : `Case type "${caseType}".`;
  let confidence = e.confidence;
  if (e.extension && /extension|ext\b/i.test(subType)) {
    code = e.extension; confidence = 'medium';
    basis = `Case type "${caseType}" + sub-type "${subType}" → extension scope.`;
  } else if (e.restoration && /restoration/i.test(subType)) {
    code = e.restoration; confidence = 'medium';
    basis = `Case type "${caseType}" + sub-type "${subType}" → restoration scope.`;
  } else if (e.changeOfStatus && /change of status/i.test(subType)) {
    code = e.changeOfStatus; confidence = 'medium';
    basis = `Case type "${caseType}" + sub-type "${subType}" → in-Canada change-of-status scope.`;
  }
  return annexResult(code, confidence, basis);
}

// ---- Signatory template (§9) ----

/**
 * Suggest the master template. Explicit signals win; otherwise infer from the
 * annex (sponsorship P7/P8 → inviter; LMIA P6 → employer). Consultant confirms.
 */
function suggestTemplate({ annexCode, hasInviter, isEmployer } = {}) {
  if (isEmployer || annexCode === 'P6') return 'employer';
  if (hasInviter || annexCode === 'P7' || annexCode === 'P8') return 'pa-inviter';
  return 'pa';
}

// ---- Applicants (§11 per-applicant scaling) ----

function applicantCount({ hasSpouse = false, childrenCount = 0 } = {}) {
  const adults = 1 + (hasSpouse ? 1 : 0); // principal (+ spouse)
  const children = Math.max(0, Math.floor(Number(childrenCount) || 0));
  return { adults, children, total: adults + children };
}

// ---- Professional fee → HST + total ----

/**
 * Professional fee → HST + total. The HST rate is per-case (default 13%; the
 * consultant can change it or set 0 for HST-exempt clients).
 * @param {number} serviceFeeCents
 * @param {number} [hstRate] fraction, e.g. 0.13; defaults to HST_RATE
 */
function computeFees(serviceFeeCents, hstRate) {
  const fee = Math.max(0, Math.round(Number(serviceFeeCents) || 0));
  const rate = (hstRate == null || !Number.isFinite(Number(hstRate))) ? HST_RATE : Math.max(0, Number(hstRate));
  const hstCents = Math.round(fee * rate);
  return { serviceFeeCents: fee, hstCents, totalCents: fee + hstCents, hstRate: rate };
}

/**
 * Build the milestone payment schedule: each row gets its own HST + total, plus
 * grand totals. The government fee is separate (no HST) and handled by the caller.
 * @param {Array<{label,amountCents,trigger?,locked?}>} milestones
 * @param {number} [hstRate]
 * @returns {{ rows:Array, totals:{amountCents,hstCents,totalCents}, hstRate:number }}
 */
function computeMilestoneSchedule(milestones, hstRate) {
  const rate = (hstRate == null || !Number.isFinite(Number(hstRate))) ? HST_RATE : Math.max(0, Number(hstRate));
  let aSum = 0, hSum = 0, tSum = 0;
  const rows = (Array.isArray(milestones) ? milestones : []).map((m) => {
    const amountCents = Math.max(0, Math.round(Number(m && m.amountCents) || 0));
    const hstCents = Math.round(amountCents * rate);
    const totalCents = amountCents + hstCents;
    aSum += amountCents; hSum += hstCents; tSum += totalCents;
    return { label: (m && m.label) || '', trigger: (m && m.trigger) || '', amountCents, hstCents, totalCents };
  });
  return { rows, totals: { amountCents: aSum, hstCents: hSum, totalCents: tSum }, hstRate: rate };
}

// ---- Government fee default (§11) ----

/**
 * Default government fee for an annex's fee key, scaled by applicants.
 * @returns {{ totalDollars:number, breakdown:object, note?:string, employerPaid?:boolean }|null}
 */
function computeGovFee(govFeeKey, applicants = {}, { withRprf = true } = {}) {
  const f = GOV_FEES[govFeeKey];
  if (!f) return null;
  const { adults = 1, children = 0 } = applicants;

  if (f.flat != null) {
    return { totalDollars: f.flat, breakdown: { flat: f.flat, perPosition: !!f.perPosition }, note: f.note, employerPaid: !!f.employerPaid };
  }

  const principal = (!withRprf && f.withoutRprf && f.withoutRprf.principal != null) ? f.withoutRprf.principal : (f.principal || 0);
  const spousePer = (!withRprf && f.withoutRprf && f.withoutRprf.spouse != null) ? f.withoutRprf.spouse : (f.spouse || 0);
  const childPer  = f.child || 0;
  const spouses   = Math.max(0, adults - 1);

  let total = principal + spouses * spousePer + children * childPer;
  let capped = false;
  if (f.familyMax != null && total > f.familyMax) { total = f.familyMax; capped = true; }

  return {
    totalDollars: Math.round(total * 100) / 100,
    breakdown: { principal, spousePer, spouses, childPer, children, capped, withRprf },
    note: f.note,
  };
}

// ---- Milestones (§10) ----

const ADMIN_LABEL = 'Milestone 1 – Non-Refundable Admin Fee';

/** Pre-fill 4 milestone rows summing exactly to the professional fee; row 1 locked. */
function defaultMilestones(serviceFeeCents, n = 4) {
  const fee = Math.max(0, Math.round(Number(serviceFeeCents) || 0));
  const count = Math.max(1, Math.floor(n));
  const base = Math.floor(fee / count);
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      label: i === 0 ? ADMIN_LABEL : `Milestone ${i + 1}`,
      amountCents: base,
      trigger: '',
      locked: i === 0,
    });
  }
  rows[count - 1].amountCents += fee - base * count; // remainder on the last row → exact sum
  return rows;
}

/** Validate a milestone schedule: ≥1 row, row 1 is the admin fee, rows sum to the fee. */
function validateMilestones(rows, serviceFeeCents) {
  const fee = Math.max(0, Math.round(Number(serviceFeeCents) || 0));
  const list = Array.isArray(rows) ? rows : [];
  const sumCents = list.reduce((s, r) => s + (Math.round(Number(r && r.amountCents) || 0)), 0);
  const errors = [];

  if (!list.length) errors.push('At least one milestone is required.');
  if (list[0] && !/non-?refundable/i.test(String(list[0].label || ''))) {
    errors.push('The first milestone must be the non-refundable administrative fee.');
  }
  if (list.some((r) => !(Math.round(Number(r && r.amountCents) || 0) > 0))) {
    errors.push('Every milestone must have an amount greater than zero.');
  }
  if (sumCents !== fee) {
    errors.push(`Milestones total $${(sumCents / 100).toFixed(2)} but the professional fee is $${(fee / 100).toFixed(2)}.`);
  }
  return { ok: errors.length === 0, sumCents, feeCents: fee, diffCents: sumCents - fee, errors };
}

module.exports = {
  pickAnnex, suggestTemplate, applicantCount, computeFees, computeGovFee, computeMilestoneSchedule,
  defaultMilestones, validateMilestones, ADMIN_LABEL,
};
