/**
 * Consultant routing — which RCIC a lead's consultation is assigned to, from the
 * lead's case type + CRS score. Per TDOT (Gauri, 2026-06-25):
 *   Express Entry  → Shafoli if CRS > 470, else Shermin
 *   PNP / H&C / Refugee → always Shafoli (senior RCIC)
 *   everything else     → Shermin
 *
 * Square team-member IDs (verified live) drive which calendar's slots are shown
 * and who the booking is created with. Both perform the generic "Consultation"
 * service (SQUARE_CONSULT_SERVICE_VARIATION_ID must point at it).
 */

'use strict';

const CONSULTANTS = {
  shafoli: { key: 'shafoli', name: 'Shafoli Kapur',            teamMemberId: process.env.SQUARE_TM_SHAFOLI || 'TMyC12DauGxiI8x-' },
  shermin: { key: 'shermin', name: 'Shermin Teymouri Mofrad', teamMemberId: process.env.SQUARE_TM_SHERMIN || 'TMAaDa6-290I5zyi' },
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
 * @param {{ serviceRequired?, caseTypeInterest?, confirmedCaseType?, crsScore? }} lead
 * @returns {{ key, name, teamMemberId, reason, needsVerify }}
 */
function routeConsultant(lead = {}) {
  const svc = String(lead.serviceRequired || '').trim();
  const caseType = String(lead.confirmedCaseType || lead.caseTypeInterest || '').trim();
  const crsRaw = String(lead.crsScore || '').replace(/[^\d.]/g, '');
  const crs = Number(crsRaw);
  const hasCrs = crsRaw !== '' && Number.isFinite(crs);

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

module.exports = { routeConsultant, CONSULTANTS, EE_SERVICES, PNP_SERVICES, HC_SERVICES, CRS_THRESHOLD };
