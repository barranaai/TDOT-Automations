'use strict';

/**
 * Who is acting on a payment — pure, so the rules can be tested without a server.
 *
 * Everyone signs into the admin pages with ONE shared key, so the key says
 * nothing about who is at the keyboard. A Monday sign-in (the staff cookie,
 * already verified by staffAuth.tryStaffAuth) does.
 */

/**
 * The person to record on a payment action: the Monday sign-in when present
 * (verified), else the name the page sent (labelled as typed), else a
 * placeholder that says plainly nobody was identified.
 * @param {?{name?:string,email?:string}} staff  tryStaffAuth(req) result
 * @param {?string} typedName
 */
const oneLine = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const SHARED_KEY_PLACEHOLDER = 'Unidentified (shared admin key)';

function actorFromStaff(staff, typedName) {
  if (staff && (staff.name || staff.email)) {
    return { name: oneLine(staff.name || staff.email).slice(0, 60), email: String(staff.email || ''), verified: true };
  }
  // One line: a typed newline could otherwise fake a second line in the tooltip.
  const n = typeof typedName === 'string' ? oneLine(typedName).slice(0, 60) : '';
  return { name: n || SHARED_KEY_PLACEHOLDER, email: '', verified: false };
}

/**
 * Undo is for NAMED admins only: signed in with Monday AND listed in
 * ADMIN_EMAILS. The shared admin key is deliberately not enough.
 * @param {?{name?:string,email?:string}} staff  tryStaffAuth(req) result
 * @param {(email:string)=>boolean} isAdminEmail
 * @returns {{ok:true, actor:object} | {ok:false, status:number, error:string, loginUrl?:string}}
 */
function namedAdminCheck(staff, isAdminEmail) {
  if (!staff || !staff.email) {
    return { ok: false, status: 401, loginUrl: '/q/auth/monday',
      error: 'Sign in with Monday to undo a payment — the shared admin key doesn’t say who you are.' };
  }
  if (!isAdminEmail(staff.email)) {
    return { ok: false, status: 403, error: 'Only admins can undo a payment. Use “Flag as wrong” to alert them.' };
  }
  return { ok: true, actor: { name: oneLine(staff.name || staff.email).slice(0, 60), email: String(staff.email), verified: true } };
}

module.exports = { actorFromStaff, namedAdminCheck, SHARED_KEY_PLACEHOLDER };
