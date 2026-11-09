'use strict';

/**
 * Lead-only delete (Faran 2026-11-09, step 3 decision 6): the staff listed here may
 * delete a LEAD that has no case (and no retainer) — nothing else. It is NOT admin:
 * cases stay with the named admins (ADMIN_EMAILS).
 *
 * WHO: LEAD_DELETE_EMAILS on Render (comma-separated Monday emails). EMPTY by
 * default = nobody. Only with a Monday sign-in — the shared team key never counts.
 */

function allowedEmails() {
  return String(process.env.LEAD_DELETE_EMAILS || '').split(',')
    .map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
}

/** May this signed-in staff member (the Monday sign-in cookie's payload) delete leads? */
function canDeleteLeads(staff) {
  const email = String((staff && staff.email) || '').trim().toLowerCase();
  return !!email && allowedEmails().includes(email);
}

module.exports = { allowedEmails, canDeleteLeads };
