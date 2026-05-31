/**
 * seedPlanner — the pure heart of schema-driven checklist seeding.
 *
 * Given a Case Structure Schema (src/data/caseSchemas/*) and a case's family
 * composition, produce the exact, deterministic list of checklist rows that
 * should exist on the Execution Board for that case.
 *
 * THIS MODULE IS PURE. No Monday calls, no OneDrive, no network, no clock.
 * That is deliberate: the riskiest correctness logic in the whole spine lives
 * here, so it must be unit-testable in isolation against fixtures. The I/O
 * wrapper (a later step) takes this plan and reconciles it against Monday
 * idempotently — but it never decides WHAT rows should exist. That decision
 * lives here and only here.
 *
 * Invariant (the thing SV-002 violated): a role marked `required: true` is
 * ALWAYS seeded, even if the client/composition never mentioned that member.
 * Client input can only ADD optional roles/docs — never remove required ones.
 */

'use strict';

/** 'PrincipalApplicant' → 'Principal Applicant', 'DependentChild' → 'Dependent Child' */
function camelToWords(role) {
  return String(role).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** Uppercase + non-alphanumeric → single dash. Used to build stable code prefixes. */
function slugUpper(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Is a role included for this composition?
 *  - required roles: always.
 *  - conditional roles (includeWhen.caseFlag): included if that case flag is set
 *    OR if an actual member of this role exists in the composition (belt &
 *    suspenders — a member the officer added shouldn't be dropped because a
 *    flag wasn't ticked).
 */
function isRoleIncluded(roleDef, composition, membersOfRole) {
  if (roleDef.required) return true;
  if (membersOfRole.length > 0) return true;
  const flag = roleDef.includeWhen && roleDef.includeWhen.caseFlag;
  if (flag && composition.caseFlags && composition.caseFlags[flag]) return true;
  return false;
}

/**
 * Should a document be included for a given member instance?
 *  - no includeWhen → always.
 *  - includeWhen.memberFlag → only if that member's flag is set.
 */
function isDocIncluded(docDef, memberFlags) {
  if (!docDef.includeWhen) return true;
  const mf = docDef.includeWhen.memberFlag;
  if (mf) return Boolean(memberFlags && memberFlags[mf]);
  // Unknown condition shape → be conservative and seed it (visible) rather than
  // silently drop a possibly-required document.
  return true;
}

/**
 * Build the planned rows for one member instance of a role.
 */
function planForMember({ schema, roleDef, member, memberIndex, isMultiple, prefix, rows, seenCodes }) {
  const roleSlug    = slugUpper(roleDef.role);
  const idxSuffix   = isMultiple ? `${memberIndex}` : '';
  const applicantType = camelToWords(roleDef.role) + (isMultiple ? ` ${memberIndex}` : '');
  const memberFlags = (member && member.flags) || {};

  for (const docDef of roleDef.documents) {
    if (!isDocIncluded(docDef, memberFlags)) continue;

    const documentCode = `${prefix}-${roleSlug}${idxSuffix}-${docDef.code}-001`;
    if (seenCodes.has(documentCode)) {
      throw new Error(
        `seedPlanner: duplicate documentCode "${documentCode}" — ` +
        `check for repeated doc.code within role "${roleDef.role}" in schema ${schema.caseType}/${schema.subType}`
      );
    }
    seenCodes.add(documentCode);

    rows.push({
      role:           roleDef.role,
      applicantType,                 // clean label for the Execution Board column
      memberIndex:    isMultiple ? memberIndex : 1,
      documentName:   docDef.name,
      category:       docDef.category || 'Other',
      documentCode,                  // deterministic, unique within the case
      guidance:       docDef.guidance || '',
    });
  }
}

/**
 * @param {object} schema       a module from src/data/caseSchemas/*
 * @param {object} composition  {
 *   caseFlags: { [flag]: boolean },
 *   members:   [{ role, flags: { [memberFlag]: boolean } }]
 * }
 * @returns {Array<PlannedRow>} deterministic, order = schema role order.
 */
function seedPlan({ schema, composition }) {
  if (!schema || !Array.isArray(schema.roles)) {
    throw new Error('seedPlan: invalid schema (missing roles[])');
  }
  const comp = composition || {};
  comp.caseFlags = comp.caseFlags || {};
  comp.members   = Array.isArray(comp.members) ? comp.members : [];

  const prefix    = `${slugUpper(schema.caseType)}-${slugUpper(schema.subType)}`;
  const rows      = [];
  const seenCodes = new Set();

  for (const roleDef of schema.roles) {
    if (!roleDef.role || !Array.isArray(roleDef.documents)) {
      throw new Error(`seedPlan: invalid role in ${schema.caseType}/${schema.subType} — needs role + documents[]`);
    }

    const membersOfRole = comp.members.filter((m) => m.role === roleDef.role);
    if (!isRoleIncluded(roleDef, comp, membersOfRole)) continue;

    const isMultiple = Boolean(roleDef.multipleAllowed);

    if (isMultiple && membersOfRole.length > 0) {
      // One block of rows per actual member instance.
      membersOfRole.forEach((member, i) => {
        planForMember({ schema, roleDef, member, memberIndex: i + 1, isMultiple, prefix, rows, seenCodes });
      });
    } else {
      // Single-member role, OR a required/multiple role with no explicit member
      // in the composition → synthesize one instance with empty flags so the
      // required documents still seed (the SV-002 invariant).
      const member = membersOfRole[0] || { role: roleDef.role, flags: {} };
      planForMember({ schema, roleDef, member, memberIndex: 1, isMultiple, prefix, rows, seenCodes });
    }
  }

  return rows;
}

module.exports = { seedPlan, _internal: { camelToWords, slugUpper, isRoleIncluded, isDocIncluded } };
