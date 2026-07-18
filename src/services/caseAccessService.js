'use strict';

/**
 * Case-level access control ("a staffer sees only cases they're assigned to").
 *
 * A case is visible to a Monday-authenticated staffer when their user id (or a
 * team they belong to) appears in ANY of the Client Master people columns.
 * Admins (email allowlist) and the shared admin API key see everything.
 *
 * Matching is by STABLE Monday ids (person id / team id), never names.
 */

// Every people column on the Client Master board (people OR team assignments).
const PEOPLE_COLUMNS = [
  'multiple_person_mm0xgpt',   // Stage Owner
  'multiple_person_mm0xp0sq',  // Ops Supervisor
  'multiple_person_mm0xm710',  // Case Support Officer
  'multiple_person_mm0xhmgk',  // Case Manager
  'multiple_person_mm2nhsx1',  // Submission Team
  'multiple_person_mm334yp5',  // Retained by
  'multiple_person_mm0xrzve',  // Override Approved By
];

/** ADMIN_EMAILS="a@x.com,b@x.com" → these users (and the shared admin key) see all cases. */
function isAdminEmail(email) {
  const list = String(process.env.ADMIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return Boolean(email) && list.includes(String(email).toLowerCase());
}

/**
 * Collect the assigned person ids + team ids from a case's people-column values.
 * @param {Object<string,string>} valueByColId  colId → the column's raw `value` JSON string
 * @returns {{ personIds: string[], teamIds: string[] }}
 */
function assigneesFromColumnValues(valueByColId = {}) {
  const personIds = new Set();
  const teamIds = new Set();
  for (const colId of PEOPLE_COLUMNS) {
    const raw = valueByColId[colId];
    if (!raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    for (const pt of (parsed && parsed.personsAndTeams) || []) {
      if (pt == null || pt.id == null) continue;
      const id = String(pt.id);
      if (pt.kind === 'team') teamIds.add(id);
      else personIds.add(id); // 'person' (or unspecified) → treat as a person
    }
  }
  return { personIds: [...personIds], teamIds: [...teamIds] };
}

/**
 * Can this viewer see this case?
 * @param {{ personIds?: string[], teamIds?: string[] }} assignees  case assignees
 * @param {{ userId?: string, teamIds?: string[], isAdmin?: boolean }} viewer
 */
function viewerCanSee(assignees, viewer) {
  if (!viewer) return false;
  if (viewer.isAdmin) return true;
  const a = assignees || {};
  const persons = a.personIds || [];
  const teams = a.teamIds || [];
  if (viewer.userId != null && persons.includes(String(viewer.userId))) return true;
  const vTeams = viewer.teamIds || [];
  if (vTeams.length && teams.some((t) => vTeams.includes(String(t)))) return true;
  return false;
}

/** Build a viewer descriptor from a decoded staff JWT (req.staff), or null. */
function viewerFromStaff(staff) {
  if (!staff) return null;
  return {
    userId: staff.id != null ? String(staff.id) : null,
    teamIds: (staff.teamIds || []).map(String),
    email: staff.email || '',
    name: staff.name || '',
    isAdmin: isAdminEmail(staff.email),
  };
}

module.exports = {
  PEOPLE_COLUMNS,
  isAdminEmail,
  assigneesFromColumnValues,
  viewerCanSee,
  viewerFromStaff,
};
