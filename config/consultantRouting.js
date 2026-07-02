/**
 * Consultant routing — which RCIC a lead's consultation is assigned to, from the
 * lead's case type + CRS score. Per TDOT (Gauri, 2026-06-25):
 *   Removal / enforcement order (removalOrder = Yes) → always Shafoli (overrides all)
 *   Express Entry  → Shafoli if CRS > 470, else Shermin
 *   PNP / H&C / Refugee → always Shafoli (senior RCIC)
 *   everything else     → Shermin
 *
 * Square team-member IDs (verified live) drive which calendar's slots are shown
 * and who the booking is created with. Both perform the generic "Consultation"
 * service (SQUARE_CONSULT_SERVICE_VARIATION_ID must point at it).
 */

'use strict';

// Signatory identity that merges into the consultation + retainer agreements.
// The templates carry four tags — {consultantName}, {rcicTitle} (the descriptor
// before the credential), {rcicRole} (the defined term repeated throughout every
// clause), and {rcicNumber}. Shafoli is an RCIC-IRB; Shermin is a plain RCIC with
// a different title, so BOTH the role and the title differ per consultant — hence
// they are per-consultant fields, not shared constants. All are env-overridable so
// a credential can be corrected from Render without a code change.
const CONSULTANTS = {
  shafoli: {
    key: 'shafoli', name: 'Shafoli Kapur',
    email: (process.env.CONSULTANT_EMAIL_SHAFOLI || 'shafoli@tdotimm.com').trim(),
    teamMemberId: process.env.SQUARE_TM_SHAFOLI || 'TMyC12DauGxiI8x-',
    rcicNumber: (process.env.RCIC_NUMBER_SHAFOLI || 'R518177').trim(),
    rcicRole:   (process.env.RCIC_ROLE_SHAFOLI  || 'RCIC-IRB').trim(),
    rcicTitle:  (process.env.RCIC_TITLE_SHAFOLI || 'Regulated Canadian Immigration Consultant - Immigration and Refugee Consultant').trim(),
  },
  shermin: {
    key: 'shermin', name: 'Shermin Teymouri Mofrad',
    email: (process.env.CONSULTANT_EMAIL_SHERMIN || 'shermin@tdotimm.com').trim(),
    teamMemberId: process.env.SQUARE_TM_SHERMIN || 'TMAaDa6-290I5zyi',
    rcicNumber: (process.env.RCIC_NUMBER_SHERMIN || 'R709839').trim(),
    rcicRole:   (process.env.RCIC_ROLE_SHERMIN  || 'RCIC').trim(),
    rcicTitle:  (process.env.RCIC_TITLE_SHERMIN || 'Immigration Case Officer').trim(),
  },
};

// Intake services (serviceRequired) / case types that map to each rule bucket.
const EE_SERVICES  = ['Express Entry profile', 'Express Entry ITA and eAPR'];
const PNP_SERVICES = ['PNP or OINP'];
const HC_SERVICES  = ['Humanitarian and compassionate'];
const CRS_THRESHOLD = 470;

// Case types (Client Master vocabulary), used only when the intake service is
// absent. Express-Entry-family types are still CRS-gated; PNP/H&C/Refugee aren't.
const EE_CASE_TYPES = /express entry|canadian experience|\bcec\b|federal pr|non[- ]?express/i;
const SHAFOLI_ALWAYS_CASE_TYPES = /\bpnp\b|aaip|bcpnp|oinp|mpnp|manitoba pnp|nsnp|rcip|rnip|snip|h\s*&\s*c|humanitarian|refugee/i;

function pick(c, reason, needsVerify = false) {
  return { key: c.key, name: c.name, teamMemberId: c.teamMemberId, reason, needsVerify };
}

/**
 * @param {{ serviceRequired?, caseTypeInterest?, confirmedCaseType?, crsScore?, removalOrder? }} lead
 * @returns {{ key, name, teamMemberId, reason, needsVerify }}
 */
function routeConsultant(lead = {}) {
  const svc = String(lead.serviceRequired || '').trim();
  const caseType = String(lead.confirmedCaseType || lead.caseTypeInterest || '').trim();
  const crsRaw = String(lead.crsScore || '').replace(/[^\d.]/g, '');
  const crs = Number(crsRaw);
  const hasCrs = crsRaw !== '' && Number.isFinite(crs);

  // Highest priority: an active removal / enforcement order goes straight to the
  // senior RCIC (Shafoli), regardless of case type or CRS — it's an urgent
  // enforcement matter, so its calendar is what the booking page shows.
  if (String(lead.removalOrder || '').trim() === 'Yes') {
    return pick(CONSULTANTS.shafoli, 'Removal / enforcement order → senior RCIC');
  }

  // An urgent deadline is also an urgent matter → senior RCIC (Shafoli), over any
  // EE/CRS/case-type rule. Signalled by the consultation form's urgentDeadline=Yes
  // OR (on the main lead board, which has no urgentDeadline column) a deadlineDate
  // being set — the intake form only captures a deadlineDate when the answer is Yes.
  if (String(lead.urgentDeadline || '').trim() === 'Yes' || String(lead.deadlineDate || '').trim() !== '') {
    return pick(CONSULTANTS.shafoli, 'Urgent deadline → senior RCIC');
  }

  // Express Entry → Shafoli only if CRS > 470
  if (EE_SERVICES.includes(svc)) {
    if (hasCrs && crs > CRS_THRESHOLD) return pick(CONSULTANTS.shafoli, `Express Entry · CRS ${crs} (> ${CRS_THRESHOLD})`);
    return pick(CONSULTANTS.shermin, hasCrs ? `Express Entry · CRS ${crs} (≤ ${CRS_THRESHOLD})` : 'Express Entry · no CRS provided', !hasCrs);
  }

  // PNP / H&C / Refugee → always Shafoli
  if (PNP_SERVICES.includes(svc) || HC_SERVICES.includes(svc) || /refugee/i.test(svc)) {
    return pick(CONSULTANTS.shafoli, `${svc} → senior RCIC`);
  }

  // No clear intake service — fall back to the case type.
  if (svc === '' && caseType) {
    if (EE_CASE_TYPES.test(caseType)) { // Express Entry family → CRS-gated
      if (hasCrs && crs > CRS_THRESHOLD) return pick(CONSULTANTS.shafoli, `${caseType} (Express Entry) · CRS ${crs} (> ${CRS_THRESHOLD})`);
      return pick(CONSULTANTS.shermin, hasCrs ? `${caseType} (Express Entry) · CRS ${crs} (≤ ${CRS_THRESHOLD})` : `${caseType} (Express Entry) · no CRS`, !hasCrs);
    }
    if (SHAFOLI_ALWAYS_CASE_TYPES.test(caseType)) return pick(CONSULTANTS.shafoli, `${caseType} → senior RCIC`, true);
  }

  // Everything else → Shermin
  return pick(CONSULTANTS.shermin, svc || caseType ? `${svc || caseType} → general consultation` : 'General consultation');
}

/**
 * The consultant whose identity prints on THIS lead's agreements. The durable
 * pin is `lead.assignedConsultant` (the consultant's NAME, written at booking in
 * phase2.js); match it back to a registry record. If the pin is blank (agreement
 * generated before booking) or doesn't match any record (name drift), fall back
 * to live routing so we always resolve to a real consultant.
 * @returns {{ key, name, teamMemberId, rcicNumber, title }}
 */
function resolveConsultant(lead = {}) {
  const pinned = String((lead && lead.assignedConsultant) || '').trim();
  if (pinned) {
    const byName = Object.values(CONSULTANTS).find((c) => c.name === pinned);
    if (byName) return byName;
    console.warn(`[consultantRouting] assignedConsultant "${pinned}" matches no registry record — falling back to routing`);
  }
  const routed = routeConsultant(lead);
  return CONSULTANTS[routed.key] || CONSULTANTS.shermin;
}

/**
 * The signatory merge fields both agreements share. Single source of truth so
 * the consultation agreement and the retainer agreement always name the same
 * (correct) RCIC. A blank rcicNumber renders blank (agreed behaviour).
 * @returns {{ consultantName: string, rcicNumber: string, rcicTitle: string }}
 */
function consultantMergeFields(lead = {}) {
  const c = resolveConsultant(lead);
  return {
    consultantName: c.name || '',
    rcicNumber: c.rcicNumber || '',
    rcicRole:   c.rcicRole || '',
    rcicTitle:  c.rcicTitle || '',
  };
}

module.exports = {
  routeConsultant, resolveConsultant, consultantMergeFields,
  CONSULTANTS, EE_SERVICES, PNP_SERVICES, HC_SERVICES, CRS_THRESHOLD,
};
