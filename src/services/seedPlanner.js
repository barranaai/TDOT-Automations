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

/** Stable 1-based index from a memberKey's trailing number (child-1 → 1), or null. */
function memberKeyIndex(key) {
  const m = String(key || '').match(/(\d+)$/);
  return m ? Number(m[1]) : null;
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
      // One block of rows per actual member instance. The index is the member's
      // STABLE memberKey number (child-1 → 1, child-2 → 2) — NOT array position — so
      // reordering the board, or removing a middle member, doesn't renumber everyone
      // and orphan/duplicate their rows on re-seed. Uniqueness within the role is
      // GUARANTEED: a key-derived index is used only when free; a collision or a
      // numberless key falls back to the lowest unused index — so two members can
      // never collide into a duplicate documentCode (which would throw + abort the
      // entire seed). Normally-ordered boards (child-1, child-2, …) are unchanged.
      const used = new Set();
      const preferred = membersOfRole.map((member) => {
        const k = memberKeyIndex(member && member.memberKey);
        if (k != null && !used.has(k)) { used.add(k); return k; }
        return null;
      });
      let nextFree = 1;
      membersOfRole.forEach((member, i) => {
        let memberIndex = preferred[i];
        if (memberIndex == null) { while (used.has(nextFree)) nextFree++; memberIndex = nextFree; used.add(nextFree); }
        planForMember({ schema, roleDef, member, memberIndex, isMultiple, prefix, rows, seenCodes });
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

/**
 * Coarse role "family" so a board member is judged COVERED whenever the schema
 * has any role that would seed for it — even under a differently-named role.
 * Critical: single-applicant schemas name the spouse/child roles
 * `NonAccompanyingSpouse` / `NonAccompanyingChild`, which seedPlan STILL seeds
 * (their includeWhen.caseFlag spouseIncluded/childrenIncluded is derived from
 * member presence). Matching on the family — not the literal role string —
 * avoids falsely flagging those covered members as orphaned.
 */
function roleFamily(role) {
  const r = String(role || '').toLowerCase();
  if (r.includes('child'))                        return 'child';
  if (r.includes('spouse') || r.includes('partner')) return 'spouse';
  if (r.includes('sponsor'))                      return 'sponsor';
  if (r.includes('parent'))                       return 'parent';
  if (r.includes('sibling'))                      return 'sibling';
  return r; // principalapplicant, worker, etc.
}

/**
 * Board members whose role FAMILY has no matching role in the selected schema —
 * i.e. members the schema genuinely can't seed any documents for (e.g. children
 * on the board + a Sub Type whose schema has no child role at all). PURE.
 * Returns [] when everyone is covered. Uses roleFamily so a Spouse/DependentChild
 * on the board is treated as covered by a NonAccompanyingSpouse/NonAccompanyingChild
 * schema role (which seedPlan does seed via the derived caseFlag) — no false alarm.
 * @returns {Array<{ role: string, label: string, count: number }>}
 */
function findOrphanMembers({ schema, composition }) {
  const families = new Set((schema && Array.isArray(schema.roles) ? schema.roles : []).map((r) => roleFamily(r.role)));
  const members = (composition && Array.isArray(composition.members)) ? composition.members : [];
  const byRole = new Map();
  for (const m of members) {
    if (!m || !m.role || families.has(roleFamily(m.role))) continue;
    byRole.set(m.role, (byRole.get(m.role) || 0) + 1);
  }
  return [...byRole.entries()].map(([role, count]) => ({ role, label: camelToWords(role), count }));
}

module.exports = { seedPlan, findOrphanMembers, _internal: { camelToWords, slugUpper, isRoleIncluded, isDocIncluded, roleFamily } };
