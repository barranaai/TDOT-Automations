'use strict';

/**
 * Change a case's client deadline from the case page or the Client Master page
 * (Faran's decision 2026-11-10).
 *
 * What is written: the case row's THREE deadline cells (Deadline Type / Actual
 * Deadline / Internal Deadline = the promised date) and the same answer on EVERY
 * lead linked to the case — never Hard/Soft/Prep Deadline (SLA outputs) and never
 * Phase. One note on the case says who, old → new and the reason. Nothing is sent
 * to the client: this path never releases a held retainer agreement.
 *
 * Who: staff signed in WITH MONDAY (the note names them); the shared admin key
 * alone is refused and never counts for the access check, which runs on the
 * Monday identity against a FRESH read of the seven people columns (as Assign).
 * Which cases: every active row on the Client Master board, whatever its stage
 * or group — the rule the lead page's own "Save deadline" has (never locked).
 *
 * Order of a write: who → validate (deadlineService.validate — the one validator;
 * a deadline is required here, this pop-up never clears) → one at a time per case
 * → fresh read → access → stale check (409 with the value now; NOT a refusal
 * when the case already holds the wanted answer — see "already there") → the linked
 * leads FIRST (so the Monday webhook's "board edit copies back to the lead"
 * branch finds every lead already the same: no second write, no second note, no
 * loop — do not reorder) → no-op → ONE mutation on the three cells → read-back →
 * the note (never retried) → the cached Client Master rows PATCHED with the
 * read-back (never invalidated).
 *
 * Review-earned rules (2026-11-10) — do not undo:
 *  - The note's "old" side and the 409 text are DL.describeStored (every date the row
 *    held), never DL.describe: an old row with no Deadline Type still has hand-kept dates
 *    and this write replaces all three cells.
 *  - A write that answers with an error may still have landed. The cells are read again
 *    (twice at most); when they hold the wanted answer the change is treated as made and
 *    the note is posted. And when a later Save finds the case ALREADY holding the wanted
 *    answer while the page showed something else ("already there" — the usual cause is
 *    that earlier save), it is not blamed on someone else: one note records who and why.
 *  - A promised date already stored and left unchanged beside a real deadline is not
 *    refused for being in the past (validate's keepPromised); a date being SET still is.
 *
 * All Monday I/O goes through `io` so the tests stub every seam.
 */

const caseAccess = require('./caseAccessService');
const DL = require('./deadlineService');
const { statusText } = require('../utils/mondayStatus');
const { actorFromStaff } = require('../utils/staffIdentity');
const { torontoTime } = require('../utils/torontoTime');
const { clientMasterBoardId } = require('../../config/monday');

const CASE_REF_COL = 'text_mm142s49';
const LOGIN_URL = '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard';
const NO_KEY_ONLY = 'Sign in with Monday to change the deadline, so the note can say who did it.';
const REASON_MIN = 5, REASON_MAX = 300;
const SOURCES = Object.freeze({ case: 'case page', 'client-master': 'Client Master page' });

function mondayApi() { return require('./mondayApi'); }
const cols = () => require('../data/clientMasterBoard.json').deadlineColumns || {};
const colIds = () => { const c = cols(); return [c.type, c.actual, c.promised]; };

const io = {
  /** The case as Monday has it now: state, board, the seven people columns, the case number and the three deadline cells. */
  readItem: async (itemId) => {
    const d = await mondayApi().query(
      'query($ids: [ID!]) { items(ids: $ids, limit: 1) { id name state board { id } column_values(ids: ' + JSON.stringify([...caseAccess.PEOPLE_COLUMNS, CASE_REF_COL, ...colIds()]) + ') { id text value } } }',
      { ids: [String(itemId)] });
    return (d && d.items && d.items[0]) || null;
  },
  /** Every lead linked to the case (a consultation lead and a direct-retainer row can share one). */
  findLeads: (itemId) => require('./deadlineCaseSync').io.findLeads(itemId),
  updateLead: (id, fields, opts) => require('./leadService').updateLead(String(id), fields, opts),
  /** THE write: the three deadline cells, in one mutation. */
  writeCells: (itemId, cells) => mondayApi().query(
    'mutation($b: ID!, $i: ID!, $c: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }',
    { b: String(clientMasterBoardId), i: String(itemId), c: JSON.stringify(cells) }),
  /** Read back the three cells just written. */
  readCells: async (itemId) => {
    const d = await mondayApi().query(
      'query($ids: [ID!]) { items(ids: $ids, limit: 1) { id column_values(ids: ' + JSON.stringify(colIds()) + ') { id text value } } }',
      { ids: [String(itemId)] });
    const it = d && d.items && d.items[0];
    return it ? (it.column_values || []) : null;
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

/** The three cells → the stored answer + the cells for the cache (an empty cell is { value:null, text:'' }, never the id-5 label). */
function readDeadline(columnValues) {
  const c = cols();
  const cv = (id) => (columnValues || []).find((x) => x && x.id === id) || null;
  const cell = (id) => { const x = cv(id); return !x || x.value == null ? { value: null, text: '' } : { value: x.value, text: s(x.text) }; };
  const cells = { [c.type]: cell(c.type), [c.actual]: cell(c.actual), [c.promised]: cell(c.promised) };
  const typeCv = cv(c.type);
  return {
    answer: {
      type: s(statusText(typeCv)),
      actualDeadline: DL.cleanDay(s((cv(c.actual) || {}).text)),
      promisedSubmissionDate: DL.cleanDay(s((cv(c.promised) || {}).text)),
    },
    cells,
  };
}
const view = (a) => ({ type: a.type, actualDeadline: a.actualDeadline, promisedSubmissionDate: a.promisedSubmissionDate, text: DL.describeStored(a) });

/**
 * Who is asking (pure). Monday sign-in → may go on; the shared key alone → 403; nobody → 401.
 * The viewer for the access check is built from the Monday identity ONLY.
 */
function gate(staff, hasKey) {
  const actor = actorFromStaff(staff);
  if (!actor.verified) {
    if (hasKey) return { ok: false, status: 403, error: NO_KEY_ONLY, code: 'key-only' };
    return { ok: false, status: 401, error: 'Sign in with Monday to change the deadline.', loginUrl: LOGIN_URL };
  }
  return { ok: true, actor, viewer: caseAccess.viewerFromStaff(staff) };
}

/** The pages' button flag (pure): a Monday sign-in who may see the case (the route re-checks on a fresh read). */
function canChange(staff, assignees) {
  const g = gate(staff, false);
  return !!g.ok && caseAccess.viewerCanSee(assignees, g.viewer);
}

const _inFlight = new Set();   // item ids being changed right now

/**
 * POST /admin/client-master/deadline and POST /admin/case-deadline — see the order at the top.
 * @param {{ staff, hasKey, body, source }} p  source: 'case' | 'client-master' (set by the route, never the body)
 * @returns {Promise<object>} the 200 answer; a refusal throws an Error with .status and .body
 */
async function change({ staff, hasKey, body, source }) {
  // 1. who
  const g = gate(staff, hasKey);
  if (!g.ok) throw fail(g.status, g.error, g.loginUrl ? { loginUrl: g.loginUrl } : { code: g.code });
  const b = body || {};
  // 2. validate
  const itemId = s(b.itemId);
  if (!DIGITS.test(itemId)) throw fail(400, 'Reload the page and try again.');
  const ex = b.expected;
  if (!ex || typeof ex !== 'object' || !['type', 'actualDeadline', 'promisedSubmissionDate'].every((k) => typeof ex[k] === 'string')) {
    throw fail(400, 'Reload the page and try again.');
  }
  const expected = { type: s(ex.type), actualDeadline: DL.cleanDay(ex.actualDeadline), promisedSubmissionDate: DL.cleanDay(ex.promisedSubmissionDate) };
  const reason = (typeof b.reason === 'string' ? b.reason : '').replace(/\s+/g, ' ').trim();
  if (reason.length < REASON_MIN) throw fail(400, `Give a short reason for the change (at least ${REASON_MIN} characters).`);
  if (reason.length > REASON_MAX) throw fail(400, `Keep the reason short (${REASON_MAX} characters at most).`);
  // required:true on purpose — the DEADLINE_REQUIRED switch must never let a blank answer through here
  const answer = DL.validate(b.deadline && typeof b.deadline === 'object' ? b.deadline : {}, { required: true, missingMessage: 'Choose Real deadline or Imaginary and give the date.', keepPromised: expected.promisedSubmissionDate });
  if (!answer.ok) throw fail(400, answer.error);
  const want = { type: answer.type, actualDeadline: answer.actualDeadline, promisedSubmissionDate: answer.promisedSubmissionDate };
  const cells = DL.caseCells(answer);
  if (Object.keys(cells).length !== 3) throw fail(500, 'The deadline columns are not set up. Nothing was changed.');
  // 3. one at a time per case
  if (_inFlight.has(itemId)) throw fail(409, 'This case’s deadline is already being changed. Wait a moment, then check it.', { code: 'busy' });
  _inFlight.add(itemId);
  try {
    // 4. fresh read
    let item;
    try { item = await io.readItem(itemId); }
    catch (err) { console.warn(`[DeadlineChange] read of item ${itemId} failed: ${err.message}`); throw fail(502, 'The case could not be read from Monday. Nothing was changed — please try again.'); }
    if (!item || s(item.id) !== itemId || s(item.state) !== 'active' || !item.board || s(item.board.id) !== s(clientMasterBoardId)) {
      throw fail(404, 'This case was not found on the Client Master board (it may be archived or deleted). Nothing was changed.');
    }
    const rowId = s(item.id);
    const valueByCol = {};
    for (const cv of item.column_values || []) valueByCol[cv.id] = cv.value;
    const ref = s(((item.column_values || []).find((c) => c.id === CASE_REF_COL) || {}).text);
    // 5. access, on the Monday identity and the fresh assignees
    if (!caseAccess.viewerCanSee(caseAccess.assigneesFromColumnValues(valueByCol), g.viewer)) {
      throw fail(403, 'You are not assigned to this case.');
    }
    // 6. stale check
    const fresh = readDeadline(item.column_values);
    const now = fresh.answer;
    const patch = (cellsById) => { for (const id of colIds()) io.patchCache(rowId, id, cellsById[id]); };
    let alreadyThere = false;
    if (!DL.same(now, expected)) {
      patch(fresh.cells);
      // the case already holds exactly what is being saved: nothing to refuse (see the top)
      if (!DL.same(now, want)) throw fail(409, `Someone changed it since your page loaded — it is now ${DL.describeStored(now)}.`, { code: 'changed', current: view(now) });
      alreadyThere = true;
    }
    const actorName = g.actor.name;
    const where = SOURCES[source] || SOURCES['client-master'];
    const stamp = () => `Reason: ${esc(reason)}. Changed on the ${where} by ${esc(actorName)} · ${esc(torontoTime(io.now()))} (Toronto).`;
    // 7. the linked leads FIRST (see the top: the webhook copy-back then finds nothing to do)
    let leadsUpdated = 0;
    try {
      const leads = ((await io.findLeads(rowId)) || []).filter((l) => l && l.id != null);
      const { fields, clearKeys } = DL.leadFields(answer);
      for (const lead of leads) {
        if (DL.same(DL.fromLead(lead), answer)) continue;
        await io.updateLead(lead.id, fields, { clearKeys });
        leadsUpdated++;
      }
    } catch (err) {
      console.error(`[DeadlineChange] item ${itemId}${ref ? ` (${ref})` : ''}: the lead record could not be updated: ${err.message}`);
      throw fail(502, 'The client’s lead record could not be updated. Nothing was changed on the case — please try again.');
    }
    // 8. no-op: the case already says this (a lead that differed was brought in step above)
    if (DL.same(now, want)) {
      const out = { ok: true, unchanged: true, deadline: view(now), leadsUpdated };
      if (alreadyThere) {
        // the page showed something else: most likely this person's own earlier save, whose answer
        // was lost before its note. One note, so the change has a name and a reason.
        const note = `🗓 <b>Client deadline</b>: ${esc(DL.describeStored(now))} — already on the case when this was saved (the page still showed ${esc(DL.describeStored(expected))}). ${stamp()}`;
        try { await io.postNote(rowId, note); out.noted = true; }
        catch (err) { out.noteFailed = true; console.error(`[DeadlineChange] item ${itemId}${ref ? ` (${ref})` : ''}: the "already there" note failed: ${err.message}`); }
        console.log(`[DeadlineChange] item ${itemId}${ref ? ` (${ref})` : ''}: already ${DL.describeStored(now)} (page showed ${DL.describeStored(expected)}), noted for ${actorName}`);
      }
      return out;
    }
    // 9. the write — exactly the three cells. An error here does not mean it did not land: step 10 looks.
    let writeErr = null;
    try { await io.writeCells(rowId, cells); }
    catch (err) { writeErr = err; console.error(`[DeadlineChange] write on item ${itemId} failed: ${err.message}`); }
    // 10. read-back (a second try when the first fails)
    let back, readErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { back = await io.readCells(rowId); readErr = null; break; }
      catch (err) { readErr = err; }
    }
    if (readErr) {
      console.error(`[DeadlineChange] item ${itemId}: ${writeErr ? 'the write failed' : 'written'}, and the read-back failed: ${readErr.message}`);
      throw fail(502, 'The result is unknown — check the case in Monday before trying again.');
    }
    const kept = back ? readDeadline(back) : null;
    if (writeErr && (!kept || !DL.same(kept.answer, want))) {
      // not there (yet): a timed-out write can still land, so this is never called "not changed"
      throw fail(502, 'The result is unknown — check the case in Monday before trying again.');
    }
    if (writeErr) console.warn(`[DeadlineChange] item ${itemId}: the write answered with an error but Monday holds the new deadline — carrying on to the note`);
    if (!kept || !DL.same(kept.answer, want)) {
      console.error(`[DeadlineChange] item ${itemId}: Monday did not keep ${DL.describe(want)} (read back ${kept ? DL.describe(kept.answer) : 'nothing'})`);
      if (kept) patch(kept.cells);
      throw fail(502, 'Monday did not keep the change — check the case in Monday before trying again.');
    }
    // 11. the note (after the write; never retried)
    const note = `🗓 <b>Client deadline changed</b>: ${esc(DL.describeStored(now))} → ${esc(DL.describe(want))}. ${stamp()}`;
    let noteFailed = false;
    try { await io.postNote(rowId, note); }
    catch (err) { noteFailed = true; console.error(`[DeadlineChange] item ${itemId}${ref ? ` (${ref})` : ''}: the deadline was changed but the note failed: ${err.message}`); }
    // 12. the cached rows follow the read-back (never invalidated)
    patch(kept.cells);
    console.log(`[DeadlineChange] item ${itemId}${ref ? ` (${ref})` : ''}: ${DL.describeStored(now)} → ${DL.describe(want)}, by ${actorName} (${leadsUpdated} lead record(s) updated)`);
    const out = { ok: true, deadline: view(want), leadsUpdated };
    if (noteFailed) out.noteFailed = true;
    return out;
  } finally {
    _inFlight.delete(itemId);
  }
}

module.exports = { change, gate, canChange, readDeadline, NO_KEY_ONLY, REASON_MIN, REASON_MAX, _io: io, _inFlight };
