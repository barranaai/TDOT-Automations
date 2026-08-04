'use strict';

/**
 * Cross-application client profile — client accounts Phase 4.
 *
 * Gathers the REUSABLE profile of a client from one of their previous
 * applications (sourceCaseRef), for staff-confirmed carry into a new one.
 *
 * Field classes (agreed at design time):
 *   IDENTITY   (name, email, phone, DOB, family roster) — carries, editable.
 *   SLOW       (address, residence country, marital)    — carries as a
 *              CANDIDATE only: prefill + explicit staff/client confirmation
 *              (the address prints on the retainer agreement).
 *   VOLATILE   (status in country, status expiry)       — NEVER carried.
 *   RATCHET    (refusal history)                        — never auto-filled;
 *              surfaced read-only in priorFacts so staff ensure disclosure.
 *   APPLICATION (case type, fees, matter answers)       — never.
 *
 * Source priority: the previous case's QUESTIONNAIRE answers (client-confirmed,
 * timestamped) → family board rows → lead columns → pre-consult → intake.
 * Latest savedAt wins among timestamped sources; alternatives are recorded so
 * a human can see conflicts. Mining SKIPS prefill-tagged entries — otherwise
 * we would re-read our own seed and launder stale data upward forever.
 */

const prefillMap = require('../../config/questionnairePrefillMap');

const STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000; // ~12 months → amber chip

// label (lowercased) → profile field, derived from the single source of truth.
const LABEL_TO_FIELD = {};
for (const [field, labels] of Object.entries(prefillMap.REUSE_LABELS)) {
  for (const l of labels) LABEL_TO_FIELD[l.toLowerCase()] = field;
}

// Sections that belong to ANOTHER PERSON on the form (sponsor, spouse,
// dependent children, inviter, employer…). A label match inside one of these
// is that person's data, not the applicant's — the live forms reuse bare
// labels like 'Residential Address' (sponsor, F10) and 'Date of Birth'
// (dependent children, F1), so section anchoring is what keeps mining honest.
const OTHER_PARTY_SECTION = /sponsor|spouse|dependent|child|inviter|employer|family member|parent|sibling|representative/i;

/**
 * PURE. Mine a saved questionnaire fields[] array for reusable profile values.
 * First occurrence per label wins (mirrors the form's own fill matching);
 * prefill-tagged entries are skipped (no circular laundering); entries whose
 * SECTION belongs to another party are skipped (no wrong-person carry).
 * @returns {{ surname?, given?, fullName?, email?, phone?, address?, residenceCountry?, maritalStatus? }}
 */
function mineQuestionnaireProfile(fields) {
  const out = {};
  for (const f of fields || []) {
    if (!f || f.source === 'prefill' || String(f.key || '').startsWith('prefill__')) continue;
    if (OTHER_PARTY_SECTION.test(String(f.section || ''))) continue;
    const field = LABEL_TO_FIELD[String(f.label || '').trim().toLowerCase()];
    if (!field || out[field] !== undefined) continue;
    const v = String(f.value == null ? '' : f.value).trim();
    if (v) out[field] = v;
  }
  if ((out.surname || out.given) && !out.fullName) {
    out.fullName = [out.given, out.surname].filter(Boolean).join(' ');
  }
  return out;
}

/**
 * PURE. Merge partial profiles in priority order with latest-wins by savedAt.
 * @param {Array<{ origin: string, savedAt?: string|null, caseRef?: string, data: object }>} sources
 *        in PRIORITY order (highest first) — used as the tiebreak when
 *        timestamps are absent.
 * @returns {{ identity: object, fieldMeta: { [field]: { origin, savedAt, stale, alternatives: [] } } }}
 */
function mergeProfileSources(sources, { now } = {}) {
  const identity = {};
  const fieldMeta = {};
  const nowMs = now ? new Date(now).getTime() : null;

  const allFields = new Set();
  for (const s of sources || []) for (const k of Object.keys(s.data || {})) allFields.add(k);

  for (const field of allFields) {
    const candidates = (sources || [])
      .filter((s) => s.data && String(s.data[field] == null ? '' : s.data[field]).trim())
      .map((s) => ({ origin: s.origin, savedAt: s.savedAt || null, caseRef: s.caseRef || '', value: String(s.data[field]).trim() }));
    if (!candidates.length) continue;

    // Latest timestamp wins; untimestamped candidates only win when no
    // timestamped one exists (then priority order — the array order — decides).
    const timestamped = candidates.filter((c) => c.savedAt);
    let winner;
    if (timestamped.length) {
      winner = timestamped.reduce((a, b) => (new Date(b.savedAt) > new Date(a.savedAt) ? b : a));
    } else {
      winner = candidates[0];
    }
    identity[field] = winner.value;
    fieldMeta[field] = {
      origin: winner.origin,
      savedAt: winner.savedAt,
      caseRef: winner.caseRef,
      stale: !!(winner.savedAt && nowMs && (nowMs - new Date(winner.savedAt).getTime()) > STALE_AFTER_MS),
      alternatives: candidates.filter((c) => c !== winner && c.value !== winner.value)
        .map((c) => ({ origin: c.origin, value: c.value, savedAt: c.savedAt })),
    };
  }
  return { identity, fieldMeta };
}

/**
 * I/O. The reusable profile of the client on sourceCaseRef. Every read is
 * best-effort — missing sources degrade to sourcesMissing, never a throw.
 */
async function gatherReusableProfile({ sourceCaseRef }) {
  const htmlQ = require('./htmlQuestionnaireService');
  const ref = String(sourceCaseRef || '').trim();
  if (!ref) return null;

  const entry = await htmlQ.lookupCase(ref);
  if (!entry) return null;

  const sourcesRead = [];
  const sourcesMissing = [];
  const grab = async (name, fn) => {
    try { const v = await fn(); if (v) { sourcesRead.push(name); return v; } }
    catch (err) { console.warn(`[Profile] ${name} read failed for ${ref}: ${err.message}`); }
    sourcesMissing.push(name);
    return null;
  };

  // Questionnaire (primary form) — client-confirmed answers, timestamped.
  const qFile = await grab('questionnaire', async () => {
    const forms = htmlQ.resolveForm(entry.caseType, entry.caseSubType);
    if (!forms) return null;
    const f = await htmlQ.loadFormFile({ clientName: entry.clientName, caseRef: ref, formKey: 'primary' });
    return f && f.fields && f.fields.length ? f : null;
  });

  // Family board rows.
  const composition = await grab('family', async () => {
    const comp = await require('./compositionAdapter').readForCase(ref);
    return comp && comp.members && comp.members.length ? comp : null;
  });

  // Lead columns.
  const lead = await grab('lead', async () =>
    require('./leadService').findByColumnValue('clientMasterItemId', String(entry.itemId)));

  // Archives.
  const intake = await grab('intake', () =>
    htmlQ.readIntakeSubfolderArchive({ clientName: entry.clientName, caseRef: ref, filename: 'intake-submission.json' }));
  const preConsult = await grab('preConsult', () =>
    htmlQ.readIntakeSubfolderArchive({ clientName: entry.clientName, caseRef: ref, filename: 'pre-consult-submission.json' }));

  // Assemble sources in priority order. Lead/archive rows map onto the same
  // profile field names REUSE_LABELS uses.
  const fromLead = lead ? {
    fullName: lead.fullName, email: lead.email, phone: lead.phone,
    address: lead.residentialAddress,
  } : {};
  const fromIntake = intake ? {
    fullName: intake.fullName, email: intake.email, phone: intake.phone,
    address: intake.residentialAddress,
  } : {};
  const fromPreConsult = preConsult ? {
    address: preConsult.pc_address, maritalStatus: preConsult.pc_marital,
  } : {};

  const merged = mergeProfileSources([
    { origin: 'questionnaire', savedAt: (qFile && qFile.savedAt) || null, caseRef: ref, data: qFile ? mineQuestionnaireProfile(qFile.fields) : {} },
    { origin: 'lead', savedAt: null, caseRef: ref, data: fromLead },
    { origin: 'preConsult', savedAt: null, caseRef: ref, data: fromPreConsult },
    { origin: 'intake', savedAt: null, caseRef: ref, data: fromIntake },
  ], { now: new Date().toISOString() });

  // Family roster (identity) — placeholder names flagged, never passed off as real.
  const family = ((composition && composition.members) || [])
    .filter((m) => m.role !== 'PrincipalApplicant')
    .map((m) => ({
      role: m.role,
      name: m.name,
      placeholder: !prefillMap.isRealName(m.name),
      dateOfBirth: m.dateOfBirth || '',
      currentStatus: m.currentStatus || '',
      countryOfResidence: m.countryOfResidence || '',
      memberKey: m.memberKey || '',
    }));

  // Prior facts — display-only (ratchet class + situational awareness).
  const priorFacts = {
    hadRefusal: !!(lead && String(lead.recentRefusal || '').trim().toLowerCase() === 'yes'),
    refusalDate: (lead && lead.refusalDate) || '',
    refusalType: (lead && lead.refusalType) || '',
    openCases: [],
  };
  try {
    const accounts = require('./clientAccountService');
    const cmAccount = lead && lead.clientAccountId ? String(lead.clientAccountId).trim() : '';
    if (cmAccount) {
      priorFacts.openCases = (await accounts.getClientCases(cmAccount))
        .filter((c) => c.caseRef && c.caseRef !== ref)
        .map((c) => ({ caseRef: c.caseRef, caseStage: c.caseStage }));
    }
  } catch (err) { console.warn(`[Profile] open-cases read failed for ${ref}: ${err.message}`); }

  return {
    identity: merged.identity,
    fieldMeta: merged.fieldMeta,
    family,
    priorFacts,
    sourcedFrom: { caseRef: ref, cmItemId: entry.itemId, clientName: entry.clientName, caseType: entry.caseType, gatheredAt: new Date().toISOString(), sourcesRead, sourcesMissing },
  };
}

module.exports = { mineQuestionnaireProfile, mergeProfileSources, gatherReusableProfile, _internal: { LABEL_TO_FIELD, STALE_AFTER_MS } };
