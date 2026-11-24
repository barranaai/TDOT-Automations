'use strict';

/**
 * Who works on a case — set from the Client Master page (block 3, step 3) and from the
 * case page's "Team on this case" box (Faran 2026-11-24).
 *
 * Faran's decisions:
 *  - Four people columns may be written, and only these (ROLES): Case Support Officer,
 *    Case Manager, Submission Team, Ops Supervisor. Never Retained by, Dup. of Retained by,
 *    Stage Owner or Override Approved By — the body cannot name a column, only a role key.
 *  - ADD alongside: the persons AND teams already in the cell stay, the new person is
 *    appended. Adding someone already there writes nothing ("No change needed").
 *    (The Client Master page's Assign… used to REPLACE the Case Support Officer; it adds now too.)
 *  - REMOVE one person (the case page's ✕): just that person; the teams and the others stay.
 *    A team entry is never removed here.
 *  - Each write leaves a note on the case naming who did it (Monday then tells an added
 *    person they were assigned — its own bell / email, from the app's Monday account).
 *  - The case page highlights the role(s) that fit the case's stage (stageRoles, pure):
 *    the others are listed below and can still be set.
 *
 * Round 2 (Faran 2026-11-24, "simple, efficient, intelligent"):
 *  - A change made while the cell changed in Monday is NOT refused (no 409 "changed"): the new cell is
 *    always built from the FRESH read, so the result is the same; the answer says changedMeanwhile.
 *  - The picker and the one-tap suggestion come from the CACHED Cases rows only (never a Monday read):
 *    per role, who holds it on open cases (the To-do tab's own "open" rule) with a count; a person who
 *    holds MORE than half of the role's filled cells on open cases is suggested on an empty role that fits
 *    the stage (and on an empty Ops Supervisor). A cold cache = the plain list, no suggestion.
 *  - Undo (30 s on the page) = a remove of the person YOU just added on this case — checked here too.
 *  - Handover: an ADD of a Case Support Officer may take named persons off the same cell in the SAME
 *    write (alsoRemove) — one write, one note ("added X, removed Y").
 *
 * Who may write: staff signed in WITH MONDAY (so the note can name them). The shared admin
 * key alone is refused, and the key never counts for the write's access check: that uses
 * the Monday identity only (ADMIN_EMAILS for admin), on a FRESH read of the case's seven
 * people columns. Under the default policy "all" any signed-in staffer passes. A person
 * who takes THEMSELVES off a case may lose access to it (policy "assigned"): the answer
 * says so (canAssign false, lostAccess, message).
 *
 * Order of a write (plan-v2 §5.4): who → validate → (the case page: the case found from its
 * number, never from an item id the page sends) → one at a time per case → the staff list
 * for an add (the cached one; re-read only when the person is not on it) → fresh read →
 * access → stale check → no-op → the write → read-back (must equal the intended cell
 * exactly) → the note (never retried) → the cached Cases rows PATCHED (never invalidated:
 * that would make the next page load by anyone wait for a whole board read).
 *
 * All Monday I/O goes through `io` so the tests stub every seam.
 */

const caseAccess = require('./caseAccessService');
const { actorFromStaff } = require('../utils/staffIdentity');
const { torontoTime } = require('../utils/torontoTime');
const { clientMasterBoardId } = require('../../config/monday');

/** The ONLY columns this service ever writes: role key → { col, label }. Ordered as the case page lists them. */
const ROLES = Object.freeze({
  officer:    Object.freeze({ col: 'multiple_person_mm0xm710', label: 'Case Support Officer' }),
  manager:    Object.freeze({ col: 'multiple_person_mm0xhmgk', label: 'Case Manager' }),
  submission: Object.freeze({ col: 'multiple_person_mm2nhsx1', label: 'Submission Team' }),
  ops:        Object.freeze({ col: 'multiple_person_mm0xp0sq', label: 'Ops Supervisor' }),
});
const ROLE_KEYS = Object.freeze(Object.keys(ROLES));
const OFFICER_COL = ROLES.officer.col;
const CASE_REF_COL = 'text_mm142s49';
const USERS_TTL_MS = 60 * 60 * 1000;   // the staff list is read at most once an hour (a write reads it again only when the person is not on it)
const USERS_PAGE = 200, USERS_MAX_PAGES = 10;
const LOGIN_URL = '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard';
const NO_KEY_ONLY = 'Sign in with Monday to assign, so the note can say who did it.';
const REF_RE = /^[A-Za-z0-9\- ]{1,100}$/;   // the case page's own rule for a case number
const SOURCES = { 'client-master': 'the Client Master page', case: 'the case page' };
const LOST_ACCESS = 'You took yourself off this case. You can no longer change who is on it, and you may not be able to open it after a reload.';
const UNDO_MS = 60 * 1000;      // the page offers Undo for 30 s; the server allows a little longer (a slow answer)
const ALSO_REMOVE_MAX = 20;

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
  /** The case page: the Client Master item of a case number (the board's own lookup) → { itemId } or null. */
  lookupCase: (caseRef) => require('./htmlQuestionnaireService').lookupCase(caseRef),
  /** The case as Monday has it now: state, board, the seven people columns and the case number. */
  readItem: async (itemId) => {
    const d = await mondayApi().query(
      'query($ids: [ID!]) { items(ids: $ids, limit: 1) { id name state board { id } column_values(ids: ' + JSON.stringify([...caseAccess.PEOPLE_COLUMNS, CASE_REF_COL]) + ') { id text value } } }',
      { ids: [String(itemId)] });
    return (d && d.items && d.items[0]) || null;
  },
  /** THE write: one key — the role's column — set to the whole intended cell (persons, then teams). */
  writeCell: (itemId, colId, list) => mondayApi().query(
    'mutation($b: ID!, $i: ID!, $c: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }',
    { b: String(clientMasterBoardId), i: String(itemId), c: JSON.stringify({ [colId]: { personsAndTeams: list } }) }),
  /** Read back the one column just written. */
  readCell: async (itemId, colId) => {
    const d = await mondayApi().query(
      'query($ids: [ID!]) { items(ids: $ids, limit: 1) { id column_values(ids: ["' + colId + '"]) { id text value } } }',
      { ids: [String(itemId)] });
    const it = d && d.items && d.items[0];
    const cv = it && (it.column_values || []).find((c) => c.id === colId);
    return it ? { value: cv ? cv.value : null, text: cv ? cv.text : '' } : null;
  },
  /** The note — retries 0: a timed-out note may still have been posted, so it is never sent twice. */
  postNote: (itemId, body) => mondayApi().query(
    'mutation($i: ID!, $b: String!) { create_update(item_id: $i, body: $b) { id } }', { i: String(itemId), b: body }, 0),
  patchCache: (itemId, colId, cell) => require('./dashboardService').patchCachedColumn(itemId, colId, cell),
  /** The cached Cases rows ({ items, version }) or null — never a Monday read (dashboardService.peekCachedItems). */
  peekCache: () => require('./dashboardService').peekCachedItems(),
  now: () => Date.now(),
};

const s = (v) => String(v == null ? '' : v).trim();
const DIGITS = /^\d{1,20}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fail(status, error, extra) { const e = new Error(error); e.status = status; e.body = { ok: false, error, ...(extra || {}) }; return e; }

/** One people cell (Monday's JSON string) → { personIds, teamIds } — the SAME parser as the Cases rows' officerIds. */
function peopleOf(raw) { return require('./dashboardService').peopleIds(raw); }
const sameSet = (a, b) => { const A = new Set((a || []).map(String)), B = new Set((b || []).map(String)); return A.size === B.size && [...A].every((x) => B.has(x)); };

/**
 * The entries of a people cell in the cell's own order, each with a name (pure).
 * A PERSON is named by their id — the person just added (extra), else the staff list — never by
 * position in Monday's text: nothing says Monday writes its text in the value's order, and the ✕,
 * its confirm and the note must name the person whose id is removed (review 2026-11-24).
 * Monday's text is used only for the entries the ids cannot name (teams; people not on the staff
 * list): the text with the known names taken out, in order, when exactly one part is left for each
 * such entry. Otherwise "team <id>" / "user <id>".
 * A PERSON named from the text while more than one entry is unknown is only a guess by position
 * (`guess: true`): the page draws no ✕ for it, so a confirm never names the wrong person (round 2, A1).
 * @param {{ value?: string|null, text?: string }} cell
 * @param {?Map} names     id → name (the staff list), optional
 * @param {?object} extra  { [id]: name } for a person just added / removed, optional
 * @returns {{ id: string, kind: 'person'|'team', name: string }[]}
 */
function entriesOf(cell, names, extra) {
  let parsed = null;
  try { parsed = cell && cell.value ? JSON.parse(cell.value) : null; } catch (_) { parsed = null; }
  const list = [], seen = new Set();
  for (const pt of (parsed && parsed.personsAndTeams) || []) {
    if (pt == null || pt.id == null) continue;
    const kind = pt.kind === 'team' ? 'team' : 'person';
    const id = String(pt.id);
    if (seen.has(kind + '|' + id)) continue;
    seen.add(kind + '|' + id);
    list.push({ id, kind });
  }
  const known = list.map((e) => (e.kind === 'person' ? s((extra && own(extra, e.id) && extra[e.id]) || (names && names.get && names.get(e.id))) : ''));
  // the text's parts left once every known name is taken out (null: the text does not line up — a known name is missing from it)
  let left = s(cell && cell.text) ? s(cell.text).split(/\s*,\s*/).filter(Boolean) : [];
  for (const k of known) {
    if (!k || !left) continue;
    const at = left.indexOf(k);
    if (at < 0) left = null; else left.splice(at, 1);
  }
  const unknown = known.filter((k) => !k).length;
  const fromText = !!left && left.length === unknown;
  let j = 0;
  return list.map((e, i) => {
    if (known[i]) return { ...e, name: known[i] };
    const t = fromText ? left[j++] : '';
    if (t && e.kind === 'person' && unknown > 1) return { ...e, name: t, guess: true };
    return { ...e, name: t || (e.kind === 'team' ? `team ${e.id}` : `user ${e.id}`) };
  });
}
/** A cell as the pages get it: { names, personIds, teamIds } (+ entries for the case page). */
function cellView(cell, names, extra, withEntries) {
  const ids = peopleOf(cell && cell.value);
  const entries = entriesOf(cell, names, extra);
  const out = { names: entries.map((e) => e.name), personIds: ids.personIds, teamIds: ids.teamIds };
  return withEntries ? { ...out, entries } : out;
}

// ─── The stage map (Faran 2026-11-24) ─────────────────────────────────────────
// The role(s) that fit the case's stage are listed FIRST and highlighted; the other roles are
// listed below and can still be set. Ops Supervisor (set once) is never highlighted and comes last.
const STAGE_FIT = [
  { re: /^(pre-?onboarding|document collection started)$/, roles: ['officer'], hint: 'At this stage: Case Support Officer (can be set early).' },
  // Submission Preparation (where stageGateService moves a finished Internal Review): the same two roles (Faran 2026-11-24, A4)
  { re: /^(internal review|submission preparation)$/, roles: ['officer', 'manager'], hint: 'At this stage: the Case Support Officer prepares the file, then the Case Manager reviews it.' },
  { re: /^submission ready$/, roles: ['submission'], hint: 'At this stage: Submission Team.' },
  { re: /^(stuck|adr)(\s*\/\s*(stuck|adr))?$/, roles: ['officer'], hint: 'At this stage: Case Support Officer.' },
];
/**
 * PURE: the roles for a Case Stage label.
 * @param {string} stage  the Case Stage label as on the board
 * @returns {{ highlight: string[], order: string[], hint: string }}  order = every role, the highlighted ones first, Ops Supervisor last
 */
function stageRoles(stage) {
  const k = s(stage).toLowerCase().replace(/\s+/g, ' ');
  const fit = STAGE_FIT.find((f) => f.re.test(k));
  const highlight = fit ? fit.roles.slice() : [];
  const rest = ROLE_KEYS.filter((r) => r !== 'ops' && !highlight.includes(r));
  return { highlight, order: [...highlight, ...rest, 'ops'], hint: fit ? fit.hint : '' };
}

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
function _resetUsers() { _users = null; _pageWarm = null; }
/**
 * The case page load: make sure the staff list is at hand so the box names each person by id (entriesOf),
 * for a Monday sign-in only (the people who get the ✕). At most one read at a time, never longer than
 * `timeoutMs` for the page, and a failure only leaves the names to Monday's text. Never throws.
 */
let _pageWarm = null;
async function warmUsersForPage(staff, { timeoutMs = 3000 } = {}) {
  if (warmUsers() || !gate(staff, false).ok) return;
  if (!_pageWarm) {
    _pageWarm = assignableUsers().catch((err) => { console.warn(`[Assign] staff list read for the case page failed: ${err.message}`); })
      .then(() => { _pageWarm = null; });
  }
  let timer;
  await Promise.race([_pageWarm, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
  clearTimeout(timer);
}
const warmUsers = () => (_users && io.now() - _users.at < USERS_TTL_MS ? _users : null);

// ─── Who usually holds each role (the cached Cases rows only — never a Monday read) ───
/**
 * PURE: per role, over the OPEN rows only, how many cells hold someone (`filled`: a person or a team) and how
 * many cells each person is in (`counts`).
 * @param {{ open: boolean, cells: { [role]: { personIds: string[], teamIds: string[] } } }[]} rows
 * @returns {{ [role]: { filled: number, counts: { [personId]: number } } }}
 */
function roleStatsOf(rows) {
  const out = {};
  for (const role of ROLE_KEYS) out[role] = { filled: 0, counts: Object.create(null) };
  for (const r of rows || []) {
    if (!r || !r.open) continue;
    for (const role of ROLE_KEYS) {
      const c = (r.cells && r.cells[role]) || { personIds: [], teamIds: [] };
      if (!c.personIds.length && !c.teamIds.length) continue;
      out[role].filled++;
      for (const p of new Set(c.personIds.map(String))) out[role].counts[p] = (out[role].counts[p] || 0) + 1;
    }
  }
  return out;
}
/** One cached Cases row → { open, cells } ("open" = the To-do tab's own rule: the row is in the Assigning view). */
function rowFacts(item) {
  const dash = require('./dashboardService');
  const valueByCol = {};
  for (const cv of (item && item.column_values) || []) valueByCol[cv.id] = cv.value;
  const cells = {};
  for (const role of ROLE_KEYS) cells[role] = peopleOf(valueByCol[ROLES[role].col]);
  let open = false;
  try { open = (dash.parseItem(item).views || []).includes(require('./todoListService').OPEN_VIEW); } catch (_) { open = false; }
  return { open, cells };
}
let _stats = null;   // { version, items, stats }: worked out once per version of the cached rows
/** The role stats from the cached rows, or null while there is no fresh-enough copy (a cold cache: no counts, no suggestion). */
function roleStats() {
  let peek = null;
  try { peek = io.peekCache(); } catch (err) { console.warn(`[Assign] cached rows unreadable: ${err.message}`); peek = null; }
  if (!peek || !Array.isArray(peek.items)) return null;
  if (_stats && _stats.items === peek.items && _stats.version === peek.version) return _stats.stats;
  const stats = roleStatsOf(peek.items.map(rowFacts));
  _stats = { version: peek.version, items: peek.items, stats };
  return stats;
}
/**
 * PURE: the picker's "Usually <role>" people — on the staff list, holding the role on open cases — fewest open first
 * (then A → Z), each with the count.
 * @returns {{ id: string, name: string, open: number }[]}
 */
function usualFor(role, stats, list) {
  const st = stats && stats[role];
  if (!st) return [];
  const byId = new Map((list || []).map((u) => [String(u.id), u]));
  return Object.keys(st.counts).filter((id) => byId.has(id))
    .map((id) => ({ id, name: byId.get(id).name, open: st.counts[id] }))
    .sort((a, b) => (a.open - b.open) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}
/**
 * PURE: the one person to suggest for a role — someone on the staff list who holds MORE than half of the role's
 * filled cells on open cases. Nobody that clear → null.
 * @returns {?{ id: string, name: string, open: number }}
 */
function suggestFor(role, stats, list) {
  const st = stats && stats[role];
  if (!st || !st.filled) return null;
  const top = usualFor(role, stats, list).filter((u) => u.open * 2 > st.filled);
  return top.length === 1 ? top[0] : null;
}
/** The picker hints for the staff-list route (Client Master page): { [role]: [{ id, open }] }, or null on a cold cache. */
function pickerHints(list) {
  const stats = roleStats();
  if (!stats) return null;
  const out = {};
  for (const role of ROLE_KEYS) out[role] = usualFor(role, stats, list).map((u) => ({ id: u.id, open: u.open }));
  return out;
}
function _resetStats() { _stats = null; }

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

/**
 * The case page's "Team on this case" box (pure): the four roles in the stage's order, each cell's
 * entries, the stage's highlight, and whether THIS viewer may change them (a Monday sign-in who may
 * see the case — the route re-checks on a fresh read).
 * @param {{ cells: ?object, stage: string, staff: ?object, assignees: object, cmUnavailable?: boolean }} p
 *   cells: { [colId]: { text, value } } from the case read (null when the row could not be read)
 */
function describeForCase({ cells, stage, staff, assignees, cmUnavailable }) {
  const available = !cmUnavailable && !!cells;
  const g = gate(staff, false);
  const canAssign = available && !!g.ok && caseAccess.viewerCanSee(assignees, g.viewer);
  const sr = stageRoles(stage);
  const users = warmUsers();   // the cached staff list only — never a Monday read for the page
  const names = (users || {}).names || null;
  // the picker's counts and the one-tap suggestion: the cached Cases rows only, and only for someone who may change the case
  const stats = canAssign && users ? roleStats() : null;
  const roles = sr.order.map((role) => {
    const cell = (available && cells[ROLES[role].col]) || { value: null, text: '' };
    const highlight = sr.highlight.includes(role);
    const view = cellView(cell, names, null, true);
    const out = { role, label: ROLES[role].label, highlight, ...view };
    if (stats) {
      out.usual = usualFor(role, stats, users.list).map((u) => ({ id: u.id, open: u.open }));
      // the suggestion: an EMPTY role that fits the stage, or an empty Ops Supervisor
      const sug = !view.entries.length && (highlight || role === 'ops') ? suggestFor(role, stats, users.list) : null;
      if (sug) out.suggest = { id: sug.id, name: sug.name };
    }
    return out;
  });
  return {
    available, stage: s(stage), hint: sr.hint, canAssign,
    signedIn: !!g.ok,   // false: the page says "Sign in with Monday to change who is on this case"
    me: g.ok && g.viewer && g.viewer.userId ? String(g.viewer.userId) : '',
    roles,
    // the staff list sent with the page (round 2, B2): the Add pop-up opens ready, with no wait
    ...(canAssign && users ? { staff: users.list.map((u) => ({ id: u.id, name: u.name })) } : {}),
  };
}

const _inFlight = new Set();   // item ids being assigned right now (any role)

/** Validate the request's own fields (pure): role (whitelist), op, person, the cell the page showed. */
function parseInput(b) {
  const role = b.role == null || b.role === '' ? 'officer' : s(b.role);
  if (!own(ROLES, role)) throw fail(400, 'This role cannot be set here. Reload the page and try again.');
  const op = b.op == null || b.op === '' ? 'add' : s(b.op);
  if (op !== 'add' && op !== 'remove') throw fail(400, 'Reload the page and try again.');
  const userId = s(b.userId);
  if (!DIGITS.test(userId)) throw fail(400, 'Choose a person and try again.');
  const ex = b.expected;
  if (!ex || typeof ex !== 'object' || !Array.isArray(ex.personIds) || !Array.isArray(ex.teamIds) ||
      ![...ex.personIds, ...ex.teamIds].every((v) => DIGITS.test(s(v)))) {
    throw fail(400, 'Reload the page and try again.');
  }
  // the handover box (round 2, C2): an ADD of a Case Support Officer may take named persons off the same cell, in the same write
  let alsoRemove = [];
  if (b.alsoRemove != null) {
    if (!Array.isArray(b.alsoRemove) || b.alsoRemove.length > ALSO_REMOVE_MAX || !b.alsoRemove.every((v) => DIGITS.test(s(v)))) throw fail(400, 'Reload the page and try again.');
    alsoRemove = [...new Set(b.alsoRemove.map(s))].filter((v) => v !== userId);
    if (alsoRemove.length && (role !== 'officer' || op !== 'add')) throw fail(400, 'Reload the page and try again.');
  }
  // Undo (round 2, C1): a remove of the person this staffer just added on this case — checked in run()
  const undo = b.undo === true;
  if (undo && op !== 'remove') throw fail(400, 'Reload the page and try again.');
  return { role, op, userId, expected: { personIds: ex.personIds.map(s), teamIds: ex.teamIds.map(s) }, alsoRemove, undo };
}

// Undo: the adds just made, by whom — itemId|role|userId → { by, at } (kept UNDO_MS; one Undo each)
const _recentAdds = new Map();
const undoKey = (itemId, role, userId) => `${itemId}|${role}|${userId}`;
const whoKey = (g) => s((g.viewer && g.viewer.userId) || g.actor.email || g.actor.name);
function _pruneAdds(now) { for (const [k, v] of _recentAdds) if (now - v.at > UNDO_MS) _recentAdds.delete(k); }

/**
 * POST /admin/client-master/assign — the Client Master page (role defaults to the Case Support
 * Officer, op to add). The item id comes from the page's row and is checked against Monday.
 * @param {{ staff, hasKey, body }} p
 * @returns {Promise<object>} the 200 answer; a refusal throws an Error with .status and .body
 */
async function assign({ staff, hasKey, body }) {
  // 1. who
  const g = gate(staff, hasKey);
  if (!g.ok) throw fail(g.status, g.error, g.loginUrl ? { loginUrl: g.loginUrl } : { code: g.code });
  const b = body || {};
  // 2. validate (the item id is checked against Monday below; the page's row is never trusted for anything else)
  const itemId = s(b.itemId);
  if (!DIGITS.test(itemId) || !DIGITS.test(s(b.userId))) throw fail(400, 'Choose a person and try again.');
  // this page only ADDS a Case Support Officer (its Assign…): another role or a remove is the case page's, with its ✕ and confirm
  if (b.role != null && b.role !== '' && s(b.role) !== 'officer') throw fail(400, 'This role cannot be set here. Reload the page and try again.');
  if (b.op != null && b.op !== '' && s(b.op) !== 'add') throw fail(400, 'Reload the page and try again.');
  const input = parseInput({ ...b, role: 'officer', op: 'add', undo: false });
  return run({ g, itemId, input, source: 'client-master' });
}

/**
 * POST /admin/case-action/:caseRef/assign — the case page. The case is found from its number
 * (the URL), never from an item id in the body; the fresh read must carry that same number.
 * @param {{ staff, hasKey, caseRef, body }} p
 */
async function assignOnCase({ staff, hasKey, caseRef, body }) {
  const g = gate(staff, hasKey);
  if (!g.ok) throw fail(g.status, g.error, g.loginUrl ? { loginUrl: g.loginUrl } : { code: g.code });
  const ref = s(caseRef);
  if (!REF_RE.test(ref)) throw fail(404, 'Case not found.');
  const input = parseInput(body || {});
  let found;
  try { found = await io.lookupCase(ref); }
  catch (err) { console.warn(`[Assign] lookup of ${ref} failed: ${err.message}`); throw fail(502, 'The case could not be read from Monday. Nothing was changed — please try again.'); }
  const itemId = s(found && found.itemId);
  if (!DIGITS.test(itemId)) throw fail(404, 'This case was not found on the Client Master board (it may be archived or deleted). Nothing was changed.');
  return run({ g, itemId, input, source: 'case', caseRef: ref });
}

async function run({ g, itemId, input, source, caseRef }) {
  const { role, op, userId, alsoRemove, undo } = input, ex = input.expected;
  const { col, label } = ROLES[role];
  const forCase = source === 'case';
  // 2c. Undo: only the person THIS staffer added on this case in the last minute (the page offers it for 30 s), once
  if (undo) {
    _pruneAdds(io.now());
    const ra = _recentAdds.get(undoKey(itemId, role, userId));
    if (!forCase || !ra || ra.by !== whoKey(g)) throw fail(409, 'Undo is no longer possible here — use ✕ beside the name to take them off.', { code: 'undo-expired' });
  }
  // 3. one at a time per case (before any Monday call: a busy request costs nothing)
  if (_inFlight.has(itemId)) throw fail(409, 'This case is already being assigned. Wait a moment, then check it.', { code: 'busy' });
  _inFlight.add(itemId);
  try {
    // 2b. an ADD: the person must be on the staff list — the hour-long cached list when it has them
    // (plan §5.4 step 2), else ONE fresh read (someone just added to Monday can still be assigned).
    // A REMOVE does not need the list: the person only has to be in the cell (they may have left Monday since).
    let users = warmUsers();
    let person = null;
    if (op === 'add') {
      if (!users || !users.list.some((u) => u.id === userId)) {
        try { users = await assignableUsers({ fresh: true }); }
        catch (err) { console.warn(`[Assign] staff list read failed: ${err.message}`); throw fail(502, 'The staff list could not be read from Monday. Nothing was changed — please try again.'); }
      }
      person = users.list.find((u) => u.id === userId);
      if (!person) throw fail(400, 'Not a staff member who can be assigned. Nothing was changed.');
    } else if (!users) {
      // a REMOVE: the staff list only NAMES the person in the note (by id); it is never required —
      // a failed read leaves the names to Monday's text, and the remove goes on
      try { users = await assignableUsers(); }
      catch (err) { console.warn(`[Assign] staff list read failed (names only): ${err.message}`); users = null; }
    }
    const names = users ? users.names : null;
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
    const cell = (item.column_values || []).find((c) => c.id === col) || { value: null, text: '' };
    const ref = s(((item.column_values || []).find((c) => c.id === CASE_REF_COL) || {}).text);
    // the case page: the row must be the case the URL names (a lookup that drifted is never written)
    if (forCase && ref.toLowerCase() !== s(caseRef).toLowerCase()) {
      throw fail(404, 'This case was not found on the Client Master board (it may be archived or deleted). Nothing was changed.');
    }
    // 5. access, on the Monday identity and the fresh assignees
    if (!caseAccess.viewerCanSee(caseAccess.assigneesFromColumnValues(valueByCol), g.viewer)) {
      throw fail(403, 'You are not assigned to this case.');
    }
    // 6. changed since the page loaded? NOT refused (round 2, B7): the new cell is built from this fresh read below,
    // so the result is what the staffer asked for either way; the answer says so and carries the cell as it is now.
    const now = peopleOf(cell.value);
    const nowView = cellView(cell, names, null, forCase);
    const changedMeanwhile = !sameSet(now.personIds, ex.personIds) || !sameSet(now.teamIds, ex.teamIds);
    const answer = (o) => {
      const flags = { ...(changedMeanwhile ? { changedMeanwhile: true } : {}), ...o.flags };
      return role === 'officer' && !forCase ? { ok: true, ...flags, officer: o.view, canAssign: o.canAssign } : { ok: true, ...flags, role, cell: o.view, canAssign: o.canAssign };
    };
    // the handover: who of the persons to take off is in the cell now (someone already gone is simply not there)
    const isTeamOnly = (id) => !now.personIds.includes(id) && now.teamIds.includes(id);
    if (op === 'remove' && isTeamOnly(userId)) throw fail(400, 'A team cannot be removed here — change it in Monday. Nothing was changed.');
    if (alsoRemove.some(isTeamOnly)) throw fail(400, 'A team cannot be removed here — change it in Monday. Nothing was changed.');
    const removeIds = op === 'remove' ? (now.personIds.includes(userId) ? [userId] : []) : alsoRemove.filter((id) => now.personIds.includes(id));
    const adding = op === 'add' && !now.personIds.includes(userId);
    // 7. no-op: nothing to add and nothing to take off (an add of someone already there; a remove of someone not there)
    if (!adding && !removeIds.length) {
      if (changedMeanwhile) io.patchCache(rowId, col, { value: cell.value, text: cell.text });   // the cached rows follow what Monday has
      if (undo) _recentAdds.delete(undoKey(itemId, role, userId));
      return answer({ flags: { unchanged: true }, view: nowView, canAssign: true });
    }
    const named = entriesOf(cell, names);
    const nameOfId = (id) => (named.find((e) => e.kind === 'person' && e.id === id) || {}).name || `user ${id}`;
    const removed = removeIds.map((id) => ({ id, name: nameOfId(id) }));
    // 8. the write: the whole cell — the persons and teams there now (minus the persons taken off), the new person last on an add
    const kept = now.personIds.filter((p) => !removeIds.includes(p));
    const persons = adding ? [...kept, userId] : kept;   // the persons the cell must hold afterwards
    const list = [...kept.map((p) => ({ id: Number(p), kind: 'person' })),
      ...now.teamIds.map((t) => ({ id: Number(t), kind: 'team' })),
      ...(adding ? [{ id: Number(userId), kind: 'person' }] : [])];
    try { await io.writeCell(rowId, col, list); }
    catch (err) {
      console.error(`[Assign] write on item ${itemId} failed: ${err.message}`);
      throw fail(502, 'The result is unknown — check the case in Monday before trying again.');
    }
    if (undo) _recentAdds.delete(undoKey(itemId, role, userId));   // one Undo, whatever the read-back says
    // 9. read-back: exactly the intended persons and teams
    let back;
    try { back = await io.readCell(rowId, col); }
    catch (err) {
      console.error(`[Assign] item ${itemId}: written, but the read-back failed: ${err.message}`);
      throw fail(502, 'The result is unknown — check the case in Monday before trying again. Nothing else was touched.');
    }
    const got = back ? peopleOf(back.value) : null;
    if (!got || !sameSet(got.personIds, persons) || !sameSet(got.teamIds, now.teamIds)) {
      console.error(`[Assign] item ${itemId}: Monday did not keep ${label} ${adding ? '+' + userId : ''}${removeIds.length ? ' −' + removeIds.join(',') : ''} (read back ${got ? JSON.stringify(got) : 'nothing'})`);
      throw fail(502, 'Monday did not keep the change — check the case in Monday before trying again. Nothing else was touched.');
    }
    const view = cellView(back, names, person ? { [person.id]: person.name } : null, forCase);
    // 10. the note (after the write; never retried): "added X", "removed Y", or "added X, removed Y" (the handover)
    const actorName = g.actor.name;
    const parts = [...(adding ? [`added ${esc(person.name)}`] : []), ...(removed.length ? [`removed ${esc(removed.map((r) => r.name).join(', '))}`] : [])];
    const note = `👤 <b>${esc(label)}: ${parts.join(', ')}</b> (now: ${esc(view.names.length ? view.names.join(', ') : 'nobody')})${undo ? ' — Undo of the add a moment ago' : ''}. ` +
      `On ${SOURCES[source]} by ${esc(actorName)} · ${esc(torontoTime(io.now()))} (Toronto).`;
    let noteFailed = false;
    try { await io.postNote(rowId, note); }
    catch (err) { noteFailed = true; console.error(`[Assign] item ${itemId}${ref ? ` (${ref})` : ''}: the ${label} was changed but the note failed: ${err.message}`); }
    // 11. the cached rows follow the read-back (never invalidated)
    io.patchCache(rowId, col, { value: back.value, text: back.text });
    if (adding && forCase) { _pruneAdds(io.now()); _recentAdds.set(undoKey(itemId, role, userId), { by: whoKey(g), at: io.now() }); }
    console.log(`[Assign] item ${itemId}${ref ? ` (${ref})` : ''}: ${label}${adding ? ` + ${person.name}` : ''}${removed.length ? ` − ${removed.map((r) => r.name).join(', ')}` : ''}${undo ? ' (undo)' : ''} (now ${view.names.join(', ') || 'nobody'}), by ${actorName} on ${source}`);
    // may this person still change the case? (taking yourself off a case can end your access under "assigned")
    const canAssign = caseAccess.viewerCanSee(caseAccess.assigneesFromColumnValues({ ...valueByCol, [col]: back.value }), g.viewer);
    const flags = { ...(noteFailed ? { noteFailed: true } : {}), ...(canAssign ? {} : { lostAccess: true, message: LOST_ACCESS }),
      ...(op === 'add' && removed.length ? { removed } : {}), ...(op === 'add' && !adding ? { alreadyOn: true } : {}) };
    return answer({ flags, view, canAssign });
  } finally {
    _inFlight.delete(itemId);
  }
}

module.exports = {
  assign, assignOnCase, assignableUsers, warmUsersForPage, gate, markAssignable, peopleOf, stageRoles, describeForCase, entriesOf,
  roleStatsOf, roleStats, usualFor, suggestFor, pickerHints,
  ROLES, ROLE_KEYS, OFFICER_COL, NO_KEY_ONLY, LOST_ACCESS, UNDO_MS,
  _io: io, _resetUsers, _resetStats, _inFlight, _recentAdds,
};
