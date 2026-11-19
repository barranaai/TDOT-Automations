'use strict';

/**
 * The "To-do" tab on the Client Master page — stage 1, READ-ONLY (Faran 2026-11-19).
 *
 * Each person's open cases, worked out live from the Client Master rows the page already loads:
 * the cases where they are Case Support Officer, and the cases where they are Case Manager ("with
 * me for review"). Nothing is written anywhere, no Monday column is added, no email is sent, and
 * the per-person Monday to-do boards are neither read nor changed.
 *
 * This file is the switch and the answer side only — PURE: it requires nothing, so it can never
 * reach Monday. The lists themselves are worked out on the page (src/routes/todoUi.js).
 *
 * Switch TODO_TAB = off (default) | admins | on, read at call time:
 *   off    — no tab, no top-bar link, and the data answer is exactly as it was (no `todo`, no row
 *            tagged, no managerIds);
 *   admins — the tab and its data only for a Monday sign-in whose email is in ADMIN_EMAILS;
 *   on     — the tab for everyone who can open the page, and the "To-do" link in the top bar.
 *
 * WHO "me" is: the Monday sign-in only (staffAuth.tryStaffAuth(req)). The shared team key is NOT an
 * input to anything here — with the key, resolveViewer answers "Admin" for everybody, so `viewer`
 * (its scope, its isAdmin) must never be handed to this service.
 */

/** A case is "open" for the to-do lists when it is in this Client Master view (clientMasterViews key). */
const OPEN_VIEW = 'assigning';

/**
 * The tab as the page sees it: a PAGE-ONLY view (not a Monday view — it never goes into
 * clientMasterViews, which models Monday's own views and throws on anything else). Plain data.
 * `by: 'todo'` is not a grouping the page's groupRows knows: the tab's groups come from todoUi.listFor.
 */
const PAGE_VIEW = Object.freeze({
  key: 'todo', label: 'To-do', pageOnly: true, by: 'todo', dir: 'ASC', groupOrder: 'position', sort: null,
  stageStrip: false, deadlineBox: false, todoBox: true,
  hint: "Each person's open cases from Client Master: Case Support Officer, or Case Manager (for review). Soonest deadline first. Not the Monday to-do boards.",
});

/** The tab's twelve columns, in order (the list's column ids — listSpecs casesListOpts). */
const DEFAULT_COLS = Object.freeze(['caseRef', 'clientName', 'todoWith', 'caseTypeV', 'subType', 'stageV', 'actualDeadline', 'deadlineType',
  'internalDeadline', 'officerV', 'qPct', 'docPct']);

const DIGITS = /^[0-9]+$/;

/** off (default) | admins | on — read at call time; anything else is off. */
function mode() {
  const v = String(process.env.TODO_TAB == null ? '' : process.env.TODO_TAB).trim().toLowerCase();
  return v === 'on' ? 'on' : v === 'admins' ? 'admins' : 'off';
}

/**
 * May this request have the tab and its data?
 * @param {?{id?:*, name?:string, email?:string, teamIds?:Array}} staff  tryStaffAuth(req) — the Monday sign-in, or null
 * @param {(email:string)=>boolean} isAdminEmail  caseAccessService.isAdminEmail
 * off → never. admins → only a Monday sign-in whose email is an admin's (no sign-in / the key alone → no).
 * on → yes, with or without a Monday sign-in (without one there is no "My list", only the others).
 */
function allowed(staff, isAdminEmail) {
  const m = mode();
  if (m === 'on') return true;
  if (m !== 'admins') return false;
  return !!(staff && staff.email && typeof isAdminEmail === 'function' && isAdminEmail(staff.email) === true);
}

/**
 * The signed-in person for the page: { id, name, teamIds } — or null when there is no Monday sign-in
 * or its id is not a plain Monday id (all digits).
 * name: the Monday name, one line, at most 60 characters — NEVER the email: '' when there is no name,
 * and '' when the name itself is an email address (the page then says "My list").
 */
function meOf(staff) {
  if (!staff || staff.id == null) return null;
  const id = String(staff.id);
  if (!DIGITS.test(id)) return null;
  let name = typeof staff.name === 'string' ? staff.name.replace(/\s+/g, ' ').trim().slice(0, 60).trim() : '';
  if (name.includes('@')) name = '';
  const teamIds = [];
  for (const t of Array.isArray(staff.teamIds) ? staff.teamIds : []) {
    const k = t == null ? '' : String(t);
    if (DIGITS.test(k) && !teamIds.includes(k)) teamIds.push(k);
  }
  return { id, name, teamIds };
}

/**
 * The to-do part of the page's data answer, worked out on the rows this viewer already gets
 * (after the access filter): null when the tab is not for this request — and then NO row is
 * tagged; else every open row (in the Assigning view) gets 'todo' in its `views`, once, and the
 * answer part is { me }.
 * The rows are the answer's own (parsed fresh for every request), so tagging them touches nothing shared.
 * @param {Array<{views?:string[]}>} cases
 * @param {?object} staff  tryStaffAuth(req) — never `viewer`
 * @param {(email:string)=>boolean} isAdminEmail
 * @returns {null | { me: null | { id:string, name:string, teamIds:string[] } }}
 */
function forAnswer(cases, staff, isAdminEmail) {
  const list = Array.isArray(cases) ? cases : [];
  if (!allowed(staff, isAdminEmail)) {
    // belt and braces: the rows already come without managerIds unless the caller asked the board service for them
    for (const c of list) if (c && typeof c === 'object') delete c.managerIds;
    return null;
  }
  for (const c of list) {
    if (!c || !Array.isArray(c.views)) continue;
    if (c.views.includes(OPEN_VIEW) && !c.views.includes(PAGE_VIEW.key)) c.views.push(PAGE_VIEW.key);
  }
  return { me: meOf(staff) };
}

module.exports = { mode, allowed, meOf, forAnswer, PAGE_VIEW, DEFAULT_COLS, OPEN_VIEW };
