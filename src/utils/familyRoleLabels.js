'use strict';

/**
 * What a family member's role is CALLED on a case (2026-10-25).
 *
 * The data never changes: a second Super Visa parent is a Family Members
 * "Spouse" row, a questionnaire member of type "Spouse / Common-Law Partner",
 * the checklist schema's Spouse role — because they ARE the principal
 * applicant's spouse. On a Super Visa the applicants are the parents: the
 * principal applicant is the first parent, their spouse the second parent, and
 * the child in Canada is the sponsor. Staff read "Spouse" as the daughter's
 * husband and chose "Parent" instead (which has no Super Visa documents), so on
 * all 21 Super Visa cases the second parent was missing (2026-SV-021, SV-017,
 * SV-004). Every page now says "Second parent" / "First parent" on a Super Visa.
 *
 * Any vocabulary goes in: a board type ("Spouse"), a questionnaire type
 * ("Spouse / Common-Law Partner"), a schema role or label ("Dependent Spouse
 * (Parent)"), a checklist Applicant Type ("Principal Applicant"). '' means "no
 * special name — show it as you do today".
 */
const isSuperVisa = (caseType) => /^super\s*visa$/i.test(String(caseType || '').trim());

const SECOND = 'Second parent';
const FIRST  = 'First parent (principal applicant)';
/** "parent", or "grandparent" on the Grandparents sub type. */
const who = (subType) => (/grandparent/i.test(String(subType || '')) ? 'grandparent' : 'parent');

/** The special name of a role on this case type (+ sub type), or ''. */
function roleLabel(caseType, role, subType) {
  if (!isSuperVisa(caseType)) return '';
  const n = String(role || '').toLowerCase().trim();
  if (!n) return '';
  if (/non[\s-]?accompanying|worker/.test(n)) return '';
  const w = who(subType);
  if (/^(dependent\s+)?spouse\b/.test(n)) return `Second ${w}`;
  if (/^principal\s*applicant\b/.test(n)) return `First ${w} (principal applicant)`;
  return '';
}

/** The name to show: the special one on a Super Visa, else what the page shows today. */
const roleLabelOr = (caseType, role, fallback, subType) => roleLabel(caseType, role, subType) || fallback;

/**
 * Questionnaire members as a page should show them on a Super Visa: a badge
 * ("Second parent") beside the member's name, and the default labels
 * ("Principal Applicant", "Spouse", "Spouse 2") replaced — a real name stays.
 */
function decorateMembers(caseType, members, subType) {
  if (!isSuperVisa(caseType) || !Array.isArray(members)) return members;
  return members.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const special = roleLabel(caseType, m.type, subType);
    if (!special) return m;
    const label = String(m.label || '').trim();
    // the app's own default labels ("Primary Applicant" is what every manifest writes for the principal)
    const isDefault = /^(principal applicant|primary applicant|spouse)(\s+\d+)?$/i.test(label) || !label;
    return { ...m, badge: /^second /i.test(special) ? special : '', label: isDefault ? special : label };
  });
}

/**
 * The member type one of the Super Visa names above stands for — for pages
 * that order and icon their member groups by type — or '' for any other name.
 * EXACT names only: the Visitor Visa (Parents & Siblings) schema has its own
 * "Second Parent" label, which must keep the place it always had.
 */
const SV_NAME_TYPES = new Map([
  [roleLabel('Supervisa', 'PrincipalApplicant'),                 'Principal Applicant'],
  [roleLabel('Supervisa', 'PrincipalApplicant', 'Grandparents'), 'Principal Applicant'],
  [roleLabel('Supervisa', 'Spouse'),                             'Spouse / Common-Law Partner'],
  [roleLabel('Supervisa', 'Spouse', 'Grandparents'),             'Spouse / Common-Law Partner'],
]);
function memberTypeOfLabel(label) {
  return SV_NAME_TYPES.get(String(label || '').trim()) || '';
}

module.exports = { isSuperVisa, roleLabel, roleLabelOr, decorateMembers, memberTypeOfLabel, who, SECOND, FIRST };
