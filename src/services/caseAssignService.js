'use strict';

/**
 * Assign the Case Support Officer from the Client Master page (block 3, step 3).
 *
 * Faran's decisions: the button writes ONE Monday column — Case Support Officer
 * (multiple_person_mm0xm710) — and nothing else. It REPLACES the value (teams
 * and extra people in the old value go too) and leaves a note on the case that
 * says who did it and what it was before. Monday itself then tells the new
 * person they were assigned (its own "assigned you" bell / email), shown as
 * coming from the app's Monday account — accepted by Faran.
 *
 * Who may assign: staff signed in WITH MONDAY (so the note can name them). The
 * shared admin key alone is refused, and the key never counts for the write's
 * access check: that uses the Monday identity only (ADMIN_EMAILS for admin), on
 * a FRESH read of the case's seven people columns. Under the default policy
 * "all" any signed-in staffer passes.
 *
 * Order of a write (plan-v2 §5.4): who → validate → one at a time per case →
 * the staff list (the cached one; re-read only when the person is not on it) →
 * fresh read → access → stale check → no-op → the write → read-back → the note
 * (never retried) → the cached Cases rows PATCHED (never invalidated: that
 * would make the next page load by anyone wait for a whole board read).
 *
 * All Monday I/O goes through `io` so the tests stub every seam.
 */

const caseAccess = require('./caseAccessService');
const { actorFromStaff } = require('../utils/staffIdentity');
const { torontoTime } = require('../utils/torontoTime');
const { clientMasterBoardId } = require('../../config/monday');

const OFFICER_COL = 'multiple_person_mm0xm710';
const CASE_REF_COL = 'text_mm142s49';
const USERS_TTL_MS = 60 * 60 * 1000;   // the staff list is read at most once an hour (a write reads it again only when the person is not on it)
const USERS_PAGE = 200, USERS_MAX_PAGES = 10;
const LOGIN_URL = '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard';
const NO_KEY_ONLY = 'Sign in with Monday to assign, so the note can say who did it.';

function mondayApi() { return require('./mondayApi'); }

const io = {
  /** Every non-guest Monday user (paged, 200 a page — never silently cut at the first page) and the token's own account (me.id — "Barrana AI"). */
  listUsers: async () => {
    const users = [];
    let meId = '';
    for (let page = 1; page <= USERS_MAX_PAGES; page++) {
      const d = await mondayApi().query(
        (page === 1 ? 'query($p: Int) { me { id } ' : 'query($p: Int) { ') + 'users(kind: non_guests, limit: ' + USERS_PAGE + ', page: $p) { id name enabled is_pending is_view_only } }', { p: page });
      if (page === 1) meId = d && d.me && d.me.id != null ? String(d.me.id) : '';
      const got = (d && d.users) || [];
      users.push(...got);
      if (got.length < USERS_PAGE) return { meId, users };
    }
    throw new Error(`the Monday user list did not end after ${USERS_MAX_PAGES} pages`);
  },
  /** The case as Monday has it now: state, board, the seven people columns and the case number. */
  readItem: async (itemId) => {
    const d = await mondayApi().query(
      'query($ids: [ID!]) { items(ids: $ids, limit: 1) { id name state board { id } column_values(ids: ' + JSON.stringify([...caseAccess.PEOPLE_COLUMNS, CASE_REF_COL]) + ') { id text value } } }',
      { ids: [String(itemId)] });
    return (d && d.items && d.items[0]) || null;
  },
  /** THE write: one key, the Case Support Officer, replaced by one person. */
  writeOfficer: (itemId, userId) => mondayApi().query(
    'mutation($b: ID!, $i: ID!, $c: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }',
    { b: String(clientMasterBoardId), i: String(itemId), c: JSON.stringify({ [OFFICER_COL]: { personsAndTeams: [{ id: Number(userId), kind: 'person' }] } }) }),
  /** Read back the one column just written. */
  readOfficer: async (itemId) => {
    const d = await mondayApi().query(
      'query($ids: [ID!]) { items(ids: $ids, limit: 1) { id column_values(ids: ["' + OFFICER_COL + '"]) { id text value } } }',
      { ids: [String(itemId)] });
    const it = d && d.items && d.items[0];
    const cv = it && (it.column_values || []).find((c) => c.id === OFFICER_COL);
    return it ? { value: cv ? cv.value : null, text: cv ? cv.text : '' } : null;
  },
  /** The note — retries 0: a timed-out note may still have been posted, so it is never sent twice. */
  postNote: (itemId, body) => mondayApi().query(
    'mutation($i: ID!, $b: String!) { create_update(item_id: $i, body: $b) { id } }', { i: String(itemId), b: body }, 0),
  patchCache: (itemId, colId, cell) => require('./dashboardService').patchCachedColumn(itemId, colId, cell),
  now: () => Date.now(),
};

const s = (v) => String(v == null ? '' : v).trim();
const DIGITS = /^\d{1,20}$/;
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fail(status, error, extra) { const e = new Error(error); e.status = status; e.body = { ok: false, error, ...(extra || {}) }; return e; }

/** One people cell (Monday's JSON string) → { personIds, teamIds } — the SAME parser as the Cases rows' officerIds. */
function peopleOf(raw) { return require('./dashboardService').peopleIds(raw); }
const sameSet = (a, b) => { const A = new Set((a || []).map(String)), B = new Set((b || []).map(String)); return A.size === B.size && [...A].every((x) => B.has(x)); };

// ─── The staff list (cached one hour) ────────────────────────────────────────
let _users = null;   // { at, list: [{id,name}], names: Map(id → name, every user read) }
async function assignableUsers({ fresh = false } = {}) {
  if (!fresh && _users && io.now() - _users.at < USERS_TTL_MS) return _users;
  const { meId, users } = await io.listUsers();
  const names = new Map();
  const list = [];
  for (const u of users || []) {
    if (!u || u.id == null) continue;
    const id = String(u.id), name = s(u.name);
    names.set(id, name);
    // enabled, not pending, not view-only, and never the app's own Monday account (the token's "me")
    if (u.enabled === false || u.is_pending === true || u.is_view_only === true || !name || (meId && id === meId)) continue;
    list.push({ id, name });
  }
  list.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  _users = { at: io.now(), list, names };
  return _users;
}
function _resetUsers() { _users = null; }

/** The names of a people cell: Monday's own text when it lines up with the ids, else the names we know. */
function namesOf(cell, ids, names) {
  const n = ids.personIds.length + ids.teamIds.length;
  const parts = s(cell && cell.text) ? s(cell.text).split(/\s*,\s*/).filter(Boolean) : [];
  if (parts.length === n) return parts;
  return [...ids.personIds.map((id) => (names && names.get(id)) || `user ${id}`), ...ids.teamIds.map((id) => `team ${id}`)];
}

/**
 * Who is asking (pure). Monday sign-in → may go on; the shared key alone → 403;
 * nobody → 401. The viewer for the access check is built from the Monday
 * identity ONLY (the key never counts for the write).
 * @param {?object} staff   tryStaffAuth(req)
 * @param {boolean} hasKey  the request carries the shared admin key
 */
function gate(staff, hasKey) {
  const actor = actorFromStaff(staff);
  if (!actor.verified) {
    if (hasKey) return { ok: false, status: 403, error: NO_KEY_ONLY, code: 'key-only' };
    return { ok: false, status: 401, error: 'Sign in with Monday to assign.', loginUrl: LOGIN_URL };
  }
  return { ok: true, actor, viewer: caseAccess.viewerFromStaff(staff) };
}

/**
 * The page's button flags (pure): `canAssign` for the viewer (a Monday sign-in) and on each row
 * where the write would be allowed (the access check on the Monday identity, never the key).
 */
function markAssignable(cases, staff) {
  const g = gate(staff, false);
  const canAssign = !!g.ok;
  for (const c of cases || []) c.canAssign = canAssign && caseAccess.viewerCanSee(c.assignees, g.viewer);
  return canAssign;
}

const _inFlight = new Set();   // item ids being assigned right now

/**
 * POST /admin/client-master/assign — see the order at the top.
 * @param {{ staff, hasKey, body }} p
 * @returns {Promise<object>} the 200 answer; a refusal throws an Error with .status and .body
 */
async function assign({ staff, hasKey, body }) {
  // 1. who
  const g = gate(staff, hasKey);
  if (!g.ok) throw fail(g.status, g.error, g.loginUrl ? { loginUrl: g.loginUrl } : { code: g.code });
  const b = body || {};
  // 2. validate (the item id is checked against Monday below; the page's row is never trusted for anything else)
  const itemId = s(b.itemId), userId = s(b.userId);
  if (!DIGITS.test(itemId) || !DIGITS.test(userId)) throw fail(400, 'Choose a person and try again.');
  const ex = b.expected;
  if (!ex || typeof ex !== 'object' || !Array.isArray(ex.personIds) || !Array.isArray(ex.teamIds) ||
      ![...ex.personIds, ...ex.teamIds].every((v) => DIGITS.test(s(v)))) {
    throw fail(400, 'Reload the page and try again.');
  }
  // 3. one at a time per case (before any Monday call: a busy request costs nothing)
  if (_inFlight.has(itemId)) throw fail(409, 'This case is already being assigned. Wait a moment, then check it.', { code: 'busy' });
  _inFlight.add(itemId);
  try {
    // 2b. the person must be on the staff list: the hour-long cached list when it has them
    // (plan §5.4 step 2), else ONE fresh read — someone just added to Monday can still be assigned
    let users = _users && io.now() - _users.at < USERS_TTL_MS ? _users : null;
    if (!users || !users.list.some((u) => u.id === userId)) {
      try { users = await assignableUsers({ fresh: true }); }
      catch (err) { console.warn(`[Assign] staff list read failed: ${err.message}`); throw fail(502, 'The staff list could not be read from Monday. Nothing was changed — please try again.'); }
    }
    const person = users.list.find((u) => u.id === userId);
    if (!person) throw fail(400, 'Not a staff member who can be assigned. Nothing was changed.');
    // 4. fresh read
    let item;
    try { item = await io.readItem(itemId); }
    catch (err) { console.warn(`[Assign] read of item ${itemId} failed: ${err.message}`); throw fail(502, 'The case could not be read from Monday. Nothing was changed — please try again.'); }
    if (!item || s(item.id) !== itemId || s(item.state) !== 'active' || !item.board || s(item.board.id) !== s(clientMasterBoardId)) {
      throw fail(404, 'This case was not found on the Client Master board (it may be archived or deleted). Nothing was changed.');
    }
    const rowId = s(item.id);   // every write below names the row Monday just gave back
    const valueByCol = {};
    for (const cv of item.column_values || []) valueByCol[cv.id] = cv.value;
    const officerCell = (item.column_values || []).find((c) => c.id === OFFICER_COL) || { value: null, text: '' };
    const ref = s(((item.column_values || []).find((c) => c.id === CASE_REF_COL) || {}).text);
    // 5. access, on the Monday identity and the fresh assignees
    if (!caseAccess.viewerCanSee(caseAccess.assigneesFromColumnValues(valueByCol), g.viewer)) {
      throw fail(403, 'You are not assigned to this case.');
    }
    // 6. stale check
    const now = peopleOf(officerCell.value);
    const nowNames = namesOf(officerCell, now, users.names);
    if (!sameSet(now.personIds, ex.personIds) || !sameSet(now.teamIds, ex.teamIds)) {
      io.patchCache(rowId, OFFICER_COL, { value: officerCell.value, text: officerCell.text });
      throw fail(409, `This changed since your page loaded — it is now ${nowNames.length ? nowNames.join(', ') : 'nobody'}.`,
        { code: 'changed', current: { names: nowNames, personIds: now.personIds, teamIds: now.teamIds } });
    }
    // 7. no-op
    if (!now.teamIds.length && now.personIds.length === 1 && now.personIds[0] === userId) {
      return { ok: true, unchanged: true, officer: { names: nowNames, personIds: now.personIds, teamIds: [] }, canAssign: true };
    }
    // 8. the write
    try { await io.writeOfficer(rowId, person.id); }
    catch (err) {
      console.error(`[Assign] write on item ${itemId} failed: ${err.message}`);
      throw fail(502, 'The result is unknown — check the case in Monday before trying again.');
    }
    // 9. read-back
    let back;
    try { back = await io.readOfficer(rowId); }
    catch (err) {
      console.error(`[Assign] item ${itemId}: written, but the read-back failed: ${err.message}`);
      throw fail(502, 'The result is unknown — check the case in Monday before trying again. Nothing else was touched.');
    }
    const got = back ? peopleOf(back.value) : null;
    if (!got || got.teamIds.length || got.personIds.length !== 1 || got.personIds[0] !== userId) {
      console.error(`[Assign] item ${itemId}: Monday did not keep Case Support Officer = ${userId} (read back ${got ? JSON.stringify(got) : 'nothing'})`);
      throw fail(502, 'Monday did not keep the change — check the case in Monday before trying again. Nothing else was touched.');
    }
    // 10. the note (after the write; never retried)
    const actorName = g.actor.name;
    const note = `👤 <b>Case Support Officer set</b>: ${esc(nowNames.length ? nowNames.join(', ') : 'nobody')} → ${esc(person.name)}. ` +
      `Assigned on the Client Master page by ${esc(actorName)} · ${esc(torontoTime(io.now()))} (Toronto).`;
    let noteFailed = false;
    try { await io.postNote(rowId, note); }
    catch (err) { noteFailed = true; console.error(`[Assign] item ${itemId}${ref ? ` (${ref})` : ''}: the officer was set but the note failed: ${err.message}`); }
    // 11. the cached rows follow the read-back (never invalidated)
    io.patchCache(rowId, OFFICER_COL, { value: back.value, text: back.text });
    console.log(`[Assign] item ${itemId}${ref ? ` (${ref})` : ''}: Case Support Officer ${nowNames.join(', ') || 'nobody'} → ${person.name}, by ${actorName}`);
    const officer = { names: [s(back.text) || person.name], personIds: [userId], teamIds: [] };
    const canAssign = caseAccess.viewerCanSee(caseAccess.assigneesFromColumnValues({ ...valueByCol, [OFFICER_COL]: back.value }), g.viewer);
    return noteFailed ? { ok: true, noteFailed: true, officer, canAssign } : { ok: true, officer, canAssign };
  } finally {
    _inFlight.delete(itemId);
  }
}

module.exports = {
  assign, assignableUsers, gate, markAssignable, peopleOf,
  OFFICER_COL, NO_KEY_ONLY,
  _io: io, _resetUsers, _inFlight,
};
