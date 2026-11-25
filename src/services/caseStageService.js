'use strict';

/**
 * Change a case's Case Stage from the Client Master page (Faran's decisions 2026-11-26). Behind the
 * switch STAGE_EDIT (off | on, default off, read at call time — config/features.stageEditOn): off = the
 * page shows nothing new and both endpoints answer 404 "not switched on".
 *
 * Who: the same people as Assign / Change deadline — staff signed in WITH MONDAY (the note names them);
 * the shared admin key alone is refused, and the access check runs on the Monday identity against a FRESH
 * read of the case's seven people columns.
 *
 * The rules (pure: rule()/effectsOf(), tested as a table):
 *  - Never blank (index 5) and never a label that is not in the LIVE column settings (the cached board meta,
 *    else the column settings read here; never create_labels_if_missing).
 *  - Document Collection Started only from blank, Pre-Onboarding or Retainer Confirmed: it emails the client
 *    "Your case is ready" every time it is entered on a Paid case (mondayWebhook.js, no already-sent guard).
 *  - Submission Ready and Cancelled are allowed, with the lock warning (stageGateService locks the case).
 *  - A LOCKED case (Automation Lock = Yes) moved to a working stage (the engines' ACTIVE_STAGES) is unlocked
 *    in the SAME mutation (Automation Lock = No); moved anywhere else it stays locked.
 *  - Reason: optional (300 characters at most), REQUIRED for a backward move in the main flow, for Submission
 *    Ready / Cancelled (and any other locking label) and for a move that unlocks.
 *
 * Order of a write (the deadline model, caseDeadlineService): switch → who → validate → one at a time per
 * case → fresh read → access → the live labels → stale check (409 'changed' with the stage now; NOT refused
 * when the case already holds the wanted stage) → no-op (same stage: no write, no note) → the rules →
 * ONE mutation, retries 0 (mondayApi retries a mutation by default, and every stage write has side effects
 * in the Monday webhook) → read-back (index AND text; also on an error answer: a write that answered with an
 * error may still have landed) → the note (retries 0) → the cached rows PATCHED with the read-back → the row's
 * new stage, views and "waiting" for the page.
 *
 * The side effects themselves run in the Monday webhook (mondayWebhook.js) after Monday delivers the event:
 * this service only says, from a fresh read, what WILL happen (preview()).
 *
 * All Monday I/O goes through `io` so the tests stub every seam.
 */

const caseAccess = require('./caseAccessService');
const { statusText } = require('../utils/mondayStatus');
const { actorFromStaff } = require('../utils/staffIdentity');
const { torontoTime } = require('../utils/torontoTime');
const { clientMasterBoardId } = require('../../config/monday');
const features = require('../../config/features');

const STAGE_COL = 'color_mm0x8faa';
const LOCK_COL = 'color_mm0x3x1x';           // Automation Lock (Yes / No)
const PAY_COL = 'color_mm0x9fnn';            // Payment Status (the webhook's "Paid" gate)
const APPLIED_COL = 'color_mm0xs7kp';        // Checklist Template Applied
const STAGE_START_COL = 'date_mm0xjm1z';     // Stage Start Date
const CASE_REF_COL = 'text_mm142s49';
const EMPTY_INDEX = 5;                       // Monday's blank status

const DCS = 'Document Collection Started';
const IR = 'Internal Review';
const SUBPREP = 'Submission Preparation';
const SR = 'Submission Ready';
const CANCELLED = 'Cancelled';
const APP_SUBMITTED = 'Application Submitted';
/** The working stages = the app's engines' ACTIVE_STAGES (caseHealthEngine, slaRiskEngine, expiryRiskEngine,
 *  escalationRoutingService — the tests check this copy against each of them). */
const WORKING_STAGES = Object.freeze([DCS, IR, SUBPREP, 'Stuck']);
/** Document Collection Started may be chosen only from these (blank = ''). */
const DCS_FROM = Object.freeze(['', 'Pre-Onboarding', 'Retainer Confirmed']);
/** The main flow, for "backward": a label outside it is never backward. */
const FLOW_RANK = Object.freeze({ '': 0, 'Pre-Onboarding': 1, 'Retainer Confirmed': 1, [DCS]: 2, [IR]: 3, [SUBPREP]: 4, [SR]: 5, [APP_SUBMITTED]: 6 });

const LOGIN_URL = '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard';
const SIGN_IN = 'Sign in with Monday to change the stage.';
const OFF_TEXT = 'Changing the stage from this page is not switched on.';
const REASON_MIN = 5, REASON_MAX = 300;
const SOURCES = Object.freeze({ 'client-master': 'Client Master page', case: 'case page' });

// The staff-facing texts (one place; the tests read them).
const T = Object.freeze({
  dcsRefused: 'A case can only go to Document Collection Started from Pre-Onboarding or Retainer Confirmed — it would email the client again.',
  current: 'This is the stage now.',
  locks: 'This locks the case — reminders, readiness checks and escalations stop.',
  srTeam: 'It also emails the Submission Team and the Case Manager.',
  cancelledPortal: 'The client’s portal will show “Case cancelled”.',
  unlocks: 'This also unlocks the case — reminders and checks start again.',
  staysLocked: 'The case stays locked.',
  clock: 'Restarts the stage clock and reminder count.',
  notPaid: 'Payment is not marked Paid — when it is, onboarding will NOT start by itself.',
  held: 'Onboarding is on hold until the agreement is fully signed. Changing the stage here counts as a person acting: the app will NOT start onboarding by itself when the last signature lands.',
  heldUnknown: 'Could not check whether onboarding is on hold for signatures — if it is, the app will NOT start it by itself after this change.',
  backward: 'This is a backward move.',
  dcsEmail: 'The client is emailed “Your case is ready” now, and the document checklist is set up.',
  dcsEmailAgain: 'The client is emailed “Your case is ready” again (this case’s document checklist is already set up).',
  dcsWaitsPayment: 'Waits for payment: Payment Status is not Paid, so nothing is sent now. The intake email, document checklist and reminders start by themselves when the payment is marked Paid.',
  dcsWaitsSignatures: (missing) => `Waits for signatures (missing: ${missing}). Nothing is sent now; onboarding starts by itself when the agreement is fully signed.`,
  dcsSigUnknown: 'The signatures could not be checked just now. If they are complete — or Monday cannot check them either — the client is emailed “Your case is ready” at once.',
  leavesDcs: 'Document reminders stop (they run only at Document Collection Started).',
  leavesWorking: 'The case leaves the working stages — the daily deadline, health and escalation checks stop for it.',
  notLocking: 'This does not lock or close the case.',
  reasonNeeded: `Give a short reason for this change (at least ${REASON_MIN} characters).`,
  reasonTooLong: `Keep the reason short (${REASON_MAX} characters at most).`,
  busy: 'This case’s stage is already being changed. Wait a moment, then check it.',
  reload: 'Reload the page and try again.',
  notFound: 'This case was not found on the Client Master board (it may be archived or deleted). Nothing was changed.',
  readFailed: 'The case could not be read from Monday. Nothing was changed — please try again.',
  labelsFailed: 'The list of stages could not be read from Monday. Nothing was changed — please try again.',
  notOnBoard: 'That stage is not on the board any more. Reload the page and choose again.',
  notAssigned: 'You are not assigned to this case.',
  unknown: 'The result is unknown — check the case in Monday before trying again.',
  refused: 'Monday refused the change. Nothing was changed — please try again, or change it in Monday.',
  notKept: 'Monday did not keep the change — check the case in Monday before trying again.',
});

function mondayApi() { return require('./mondayApi'); }
const READ_COLS = () => [...caseAccess.PEOPLE_COLUMNS, CASE_REF_COL, STAGE_COL, LOCK_COL, PAY_COL, APPLIED_COL, STAGE_START_COL];

const io = {
  /** The case as Monday has it now: state, board, the seven people columns, the case number, stage, lock, payment, checklist flag, stage start. */
  readItem: async (itemId) => {
    const d = await mondayApi().query(
      'query($ids: [ID!]) { items(ids: $ids, limit: 1) { id name state board { id } column_values(ids: ' + JSON.stringify(READ_COLS()) + ') { id text value } } }',
      { ids: [String(itemId)] });
    return (d && d.items && d.items[0]) || null;
  },
  /** The board meta from the last Cases read ({ stageLabels, stageOrder }) or null. */
  cachedMeta: () => require('./dashboardService').getCasesMeta(),
  /** The Case Stage column's settings, read now (when the cached meta is missing). */
  readStageSettings: async () => {
    const d = await mondayApi().query(
      'query($b: [ID!]) { boards(ids: $b, limit: 1) { columns(ids: ["' + STAGE_COL + '"]) { id settings_str } } }',
      { b: [String(clientMasterBoardId)] });
    const col = d && d.boards && d.boards[0] && (d.boards[0].columns || []).find((c) => c && c.id === STAGE_COL);
    return col ? String(col.settings_str || '') : null;
  },
  /** Every lead linked to the case (the webhook's signature gate reads the same). */
  findLeads: (itemId) => require('./leadService').findAllByColumnValue('clientMasterItemId', String(itemId)),
  /** The case's latest notes (the held-onboarding check). */
  readUpdates: async (itemId) => {
    const d = await mondayApi().query(
      'query($ids: [ID!]) { items(ids: $ids, limit: 1) { id updates(limit: 100) { id created_at text_body body } } }',
      { ids: [String(itemId)] });
    const it = d && d.items && d.items[0];
    return it ? (it.updates || []) : null;
  },
  /** THE write: the stage (and, when unlocking, the lock) in ONE mutation — retries 0 (see the top). */
  writeStage: (itemId, cols) => mondayApi().query(
    'mutation($b: ID!, $i: ID!, $c: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }',
    { b: String(clientMasterBoardId), i: String(itemId), c: JSON.stringify(cols) }, 0),
  /** Read back the stage and the lock. */
  readCells: async (itemId) => {
    const d = await mondayApi().query(
      'query($ids: [ID!]) { items(ids: $ids, limit: 1) { id column_values(ids: ' + JSON.stringify([STAGE_COL, LOCK_COL]) + ') { id text value } } }',
      { ids: [String(itemId)] });
    const it = d && d.items && d.items[0];
    return it ? (it.column_values || []) : null;
  },
  /** The note — retries 0: a timed-out note may still have been posted, so it is never sent twice. */
  postNote: (itemId, body) => mondayApi().query(
    'mutation($i: ID!, $b: String!) { create_update(item_id: $i, body: $b) { id } }', { i: String(itemId), b: body }, 0),
  patchCache: (itemId, colId, cell) => require('./dashboardService').patchCachedColumn(itemId, colId, cell),
  /** The row as the page needs it, from the (just patched) cached rows: { caseStage, stageIdx, views, waiting } or null (cold cache). */
  rowFor: (itemId, staff) => rowFromCache(itemId, staff),
  now: () => Date.now(),
};

const s = (v) => String(v == null ? '' : v).trim();
const DIGITS = /^\d{1,20}$/;
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fail(status, error, extra) { const e = new Error(error); e.status = status; e.body = { ok: false, error, ...(extra || {}) }; return e; }
function statusIndex(raw) { return require('./clientMasterViews').statusIndex(raw); }
function terminalStages() { return require('./stageGateService').TERMINAL_STAGES; }
function earlyStages() { return require('./retainerService').EARLY_STAGES; }

/** On (STAGE_EDIT=on) — read at call time. */
function enabled() { return features.stageEditOn(); }

/**
 * Who is asking (pure). Monday sign-in → may go on; the shared key alone → 403 'key-only'; nobody → 401 + sign-in link.
 * The viewer for the access check is built from the Monday identity ONLY.
 */
function gate(staff, hasKey) {
  const actor = actorFromStaff(staff);
  if (!actor.verified) {
    if (hasKey) return { ok: false, status: 403, error: SIGN_IN, code: 'key-only' };
    return { ok: false, status: 401, error: SIGN_IN, loginUrl: LOGIN_URL };
  }
  return { ok: true, actor, viewer: caseAccess.viewerFromStaff(staff) };
}

/** The live labels: { labels: { index: label }, order: [index…] } without blank (5) or an empty label; null = unknown. */
function labelsFromMeta(meta) {
  if (!meta || !meta.stageLabels || typeof meta.stageLabels !== 'object') return null;
  const labels = {};
  for (const [k, v] of Object.entries(meta.stageLabels)) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && i !== EMPTY_INDEX && s(v)) labels[i] = s(v);
  }
  if (!Object.keys(labels).length) return null;
  const order = [];
  for (const i of Array.isArray(meta.stageOrder) ? meta.stageOrder : []) if (labels[i] != null && !order.includes(Number(i))) order.push(Number(i));
  for (const k of Object.keys(labels).map(Number).sort((a, b) => a - b)) if (!order.includes(k)) order.push(k);
  return { labels, order };
}
/** settings_str of the Case Stage column → the same shape (a deactivated label is left out). */
function labelsFromSettings(settingsStr) {
  let st;
  try { st = JSON.parse(settingsStr || ''); } catch (_) { return null; }
  if (!st || typeof st !== 'object') return null;
  const off = new Set((Array.isArray(st.deactivated_labels) ? st.deactivated_labels : []).map(Number));
  const raw = {};
  for (const [k, v] of Object.entries(st.labels || {})) if (/^\d+$/.test(k) && !off.has(Number(k))) raw[k] = v;
  const pos = st.labels_positions_v2 || {};
  const order = Object.keys(raw).map(Number).sort((a, b) => {
    const pa = Number.isFinite(Number(pos[a])) ? Number(pos[a]) : Infinity, pb = Number.isFinite(Number(pos[b])) ? Number(pos[b]) : Infinity;
    return (pa - pb) || (a - b);
  });
  return labelsFromMeta({ stageLabels: raw, stageOrder: order });
}
/** The cached meta, else the settings read now; null = refuse. */
async function liveLabels() {
  const fromCache = labelsFromMeta(io.cachedMeta());
  if (fromCache) return fromCache;
  try { return labelsFromSettings(await io.readStageSettings()); }
  catch (err) { console.warn(`[StageChange] stage settings read failed: ${err.message}`); return null; }
}

/** A status cell → { index, label } — blank (5, or no value) = { index: 5, label: '' }. */
function cellStage(cv, labels) {
  const index = statusIndex(cv ? cv.value : null);
  if (index === EMPTY_INDEX) return { index, label: '' };
  const label = (labels && labels[index] != null) ? labels[index] : s(statusText(cv));
  return { index, label };
}

/** The facts from a fresh read (pure). */
function factsOf(item, labels) {
  const cv = (id) => (item.column_values || []).find((c) => c && c.id === id) || null;
  return {
    current: cellStage(cv(STAGE_COL), labels),
    locked: s(statusText(cv(LOCK_COL))).toLowerCase() === 'yes',
    paid: s(statusText(cv(PAY_COL))) === 'Paid',
    applied: s(statusText(cv(APPLIED_COL))).toLowerCase(),
    stageStart: s((cv(STAGE_START_COL) || {}).text),
    caseRef: s((cv(CASE_REF_COL) || {}).text),
  };
}

const locksLabel = (label) => label === SR || terminalStages().has(label);
const rankOf = (label) => (Object.prototype.hasOwnProperty.call(FLOW_RANK, label) ? FLOW_RANK[label] : null);
function isBackward(fromLabel, toLabel) {
  const a = rankOf(fromLabel), b = rankOf(toLabel);
  return a != null && b != null && b < a;
}

/**
 * The rule for one target (pure): may it be chosen, why not, is a reason required, does it unlock / lock.
 * @param {{ index:number, label:string }} target
 * @param {{ current:{index,label}, locked:boolean }} facts
 */
function rule(target, facts) {
  const from = facts.current.label;
  const out = { allowed: true, why: '', backward: isBackward(from, target.label), locks: locksLabel(target.label), unlocks: false, reasonRequired: false };
  if (target.index === facts.current.index) return { ...out, allowed: false, why: T.current, backward: false };
  if (target.label === DCS && !DCS_FROM.includes(from)) return { ...out, allowed: false, why: T.dcsRefused };
  out.unlocks = !!facts.locked && WORKING_STAGES.includes(target.label);
  out.reasonRequired = out.backward || out.locks || out.unlocks;
  return out;
}

/**
 * What WILL happen (pure), in plain lines, for an allowed target.
 * facts.signatures: { state: 'complete'|'missing'|'no-lead'|'unknown', missing: string[] } (read only for DCS when needed)
 * facts.held: true | false | null (unknown) — onboarding on hold for signatures (read only when it can be)
 */
function effectsOf(target, facts, r) {
  const lines = [];
  const from = facts.current.label, to = target.label;
  if (r.backward) lines.push(T.backward);
  if (to === DCS) {
    if (!facts.paid) lines.push(T.dcsWaitsPayment);
    else if (facts.applied === 'yes') lines.push(T.dcsEmailAgain);
    else {
      const sg = facts.signatures || { state: 'unknown', missing: [] };
      if (sg.state === 'missing') lines.push(T.dcsWaitsSignatures((sg.missing || []).join(' and ') || 'signatures'));
      else if (sg.state === 'unknown') lines.push(T.dcsSigUnknown);
      else lines.push(T.dcsEmail);
    }
  }
  if (r.locks) lines.push(T.locks);
  if (to === SR) lines.push(T.srTeam);
  if (to === CANCELLED) lines.push(T.cancelledPortal);
  if (to === IR || to === SUBPREP) lines.push(T.clock);
  if (r.unlocks) lines.push(T.unlocks);
  else if (facts.locked && !r.locks) lines.push(T.staysLocked);
  if (from === DCS && to !== DCS && !r.locks) lines.push(T.leavesDcs);
  if (WORKING_STAGES.includes(from) && !WORKING_STAGES.includes(to) && !r.locks) lines.push(T.leavesWorking);
  if (to === APP_SUBMITTED) lines.push(T.notLocking);
  const early = earlyStages();
  if (!facts.paid && to !== DCS && !early.includes(to) && (early.includes(from) || from === DCS)) lines.push(T.notPaid);
  if (to !== DCS) {
    if (facts.held === true) lines.push(T.held);
    else if (facts.held === null) lines.push(T.heldUnknown);
  }
  return lines;
}

/** Can onboarding be on hold for this case (worth reading the notes)? Paid, never onboarded, still at an early stage or DCS. */
function mayBeHeld(f) {
  return f.paid && f.applied !== 'yes' && !f.stageStart && (DCS_FROM.includes(f.current.label) || f.current.label === DCS);
}

async function signaturesOf(itemId) {
  try {
    const leads = await io.findLeads(itemId);
    if (!Array.isArray(leads)) return { state: 'unknown', missing: [] };
    if (!leads.length) return { state: 'no-lead', missing: [] };
    const cg = require('./caseGateService');
    const today = new Date(io.now()).toISOString().slice(0, 10);
    const gateOf = (l) => cg.signatureGateForLead({ ...l, retainerPaid: (l && l.retainerPaid && String(l.retainerPaid).trim()) || today });
    if (leads.some((l) => gateOf(l).complete)) return { state: 'complete', missing: [] };
    return { state: 'missing', missing: gateOf(leads[0]).missing };
  } catch (err) {
    console.warn(`[StageChange] item ${itemId}: the signature check failed: ${err.message}`);
    return { state: 'unknown', missing: [] };
  }
}
async function heldOf(itemId) {
  try {
    const ups = await io.readUpdates(itemId);
    if (!Array.isArray(ups)) return null;
    const n = require('./onboardingResumeService').readNotes(ups);
    return !!(n.heldAt && !n.resumedAt && !n.finalSinceHeld);
  } catch (err) {
    console.warn(`[StageChange] item ${itemId}: the notes read failed: ${err.message}`);
    return null;
  }
}

/** The fresh read + checks both endpoints share. */
async function readCase(itemId, g) {
  let item;
  try { item = await io.readItem(itemId); }
  catch (err) { console.warn(`[StageChange] read of item ${itemId} failed: ${err.message}`); throw fail(502, T.readFailed); }
  if (!item || s(item.id) !== itemId || s(item.state) !== 'active' || !item.board || s(item.board.id) !== s(clientMasterBoardId)) throw fail(404, T.notFound);
  const valueByCol = {};
  for (const cv of item.column_values || []) valueByCol[cv.id] = cv.value;
  if (!caseAccess.viewerCanSee(caseAccess.assigneesFromColumnValues(valueByCol), g.viewer)) throw fail(403, T.notAssigned);
  const live = await liveLabels();
  if (!live) throw fail(502, T.labelsFailed);
  return { item, live, facts: factsOf(item, live.labels) };
}

function checkSwitchAndWho(staff, hasKey) {
  if (!enabled()) throw fail(404, OFF_TEXT, { code: 'off' });
  const g = gate(staff, hasKey);
  if (!g.ok) throw fail(g.status, g.error, g.loginUrl ? { loginUrl: g.loginUrl } : { code: g.code });
  return g;
}
const intOrNull = (v) => { const t = s(v); return /^\d{1,4}$/.test(t) ? Number(t) : null; };

/** The cache follows Monday's stage cell (and the lock when given); returns the row for the page. */
function patchAndRow(rowId, stageCell, lockCell, staff) {
  try {
    if (stageCell) io.patchCache(rowId, STAGE_COL, { value: stageCell.value == null ? null : stageCell.value, text: stageCell.value == null ? '' : s(stageCell.text) });
    if (lockCell) io.patchCache(rowId, LOCK_COL, { value: lockCell.value == null ? null : lockCell.value, text: lockCell.value == null ? '' : s(lockCell.text) });
  } catch (err) { console.warn(`[StageChange] item ${rowId}: cache patch failed: ${err.message}`); }
  try { return io.rowFor(rowId, staff) || null; }
  catch (err) { console.warn(`[StageChange] item ${rowId}: row rebuild failed: ${err.message}`); return null; }
}

/**
 * GET /admin/client-master/stage-options?itemId=…&expected=… — what each stage would do, from a fresh read.
 * @returns {Promise<object>} { ok, itemId, caseRef, current, locked, paid, options: [{ index, label, allowed, why, effects, reasonRequired, unlocks, locks, backward }], row? }
 */
async function preview({ staff, hasKey, itemId: rawId, expected: rawExpected }) {
  const g = checkSwitchAndWho(staff, hasKey);
  const itemId = s(rawId);
  if (!DIGITS.test(itemId)) throw fail(400, T.reload);
  const { item, live, facts } = await readCase(itemId, g);
  const allowedDcs = live.order.some((i) => live.labels[i] === DCS) && DCS_FROM.includes(facts.current.label) && facts.current.label !== DCS;
  const [signatures, held] = await Promise.all([
    allowedDcs && facts.paid && facts.applied !== 'yes' ? signaturesOf(itemId) : Promise.resolve(null),
    mayBeHeld(facts) ? heldOf(itemId) : Promise.resolve(false),
  ]);
  const f = { ...facts, signatures, held };
  const options = live.order.map((index) => {
    const target = { index, label: live.labels[index] };
    const r = rule(target, f);
    return { index, label: target.label, allowed: r.allowed, why: r.why, effects: r.allowed ? effectsOf(target, f, r) : [], reasonRequired: r.reasonRequired, unlocks: r.unlocks, locks: r.locks, backward: r.backward };
  });
  const out = { ok: true, itemId, caseRef: facts.caseRef, clientName: s(item.name), current: facts.current, locked: facts.locked, paid: facts.paid, reasonMax: REASON_MAX, reasonMin: REASON_MIN, options };
  // the page showed another stage: the cached rows follow Monday's (so the page can redraw the row)
  const expected = intOrNull(rawExpected);
  if (expected != null && expected !== facts.current.index) {
    const cv = (item.column_values || []).find((c) => c && c.id === STAGE_COL) || { value: null, text: '' };
    out.row = patchAndRow(itemId, cv, null, staff);
  }
  return out;
}

const _inFlight = new Set();   // item ids being changed right now

/**
 * POST /admin/client-master/stage { itemId, index, expected, reason } — see the order at the top.
 * @param {{ staff, hasKey, body, source }} p  source: 'client-master' | 'case' (set by the route, never the body)
 * @returns {Promise<object>} the 200 answer; a refusal throws an Error with .status and .body
 */
async function change({ staff, hasKey, body, source }) {
  // 1. switch + who
  const g = checkSwitchAndWho(staff, hasKey);
  // 2. validate
  const b = body || {};
  const itemId = s(b.itemId);
  if (!DIGITS.test(itemId)) throw fail(400, T.reload);
  const index = Number.isInteger(b.index) ? b.index : intOrNull(b.index);
  const expected = Number.isInteger(b.expected) ? b.expected : intOrNull(b.expected);
  if (index == null || index < 0 || expected == null || expected < 0) throw fail(400, T.reload);
  if (index === EMPTY_INDEX) throw fail(400, T.notOnBoard);
  if (b.reason != null && typeof b.reason !== 'string') throw fail(400, T.reload);
  const reason = (typeof b.reason === 'string' ? b.reason : '').replace(/\s+/g, ' ').trim();
  if (reason.length > REASON_MAX) throw fail(400, T.reasonTooLong);
  // 3. one at a time per case
  if (_inFlight.has(itemId)) throw fail(409, T.busy, { code: 'busy' });
  _inFlight.add(itemId);
  try {
    // 4-6. fresh read, access, the live labels
    const { item, live, facts } = await readCase(itemId, g);
    const rowId = s(item.id);
    if (live.labels[index] == null) throw fail(400, T.notOnBoard);
    const target = { index, label: live.labels[index] };
    const stageCv = (item.column_values || []).find((c) => c && c.id === STAGE_COL) || { value: null, text: '' };
    const show = (st) => st.label || 'no stage';
    // 7. stale check — not refused when the case already holds the wanted stage
    if (facts.current.index !== expected && facts.current.index !== index) {
      const row = patchAndRow(rowId, stageCv, null, staff);
      throw fail(409, `Someone changed the stage since your page loaded — it is now ${show(facts.current)}.`, { code: 'changed', current: facts.current, row });
    }
    // 8. no-op: no write, no note
    if (facts.current.index === index) {
      const row = facts.current.index !== expected ? patchAndRow(rowId, stageCv, null, staff) : null;
      return { ok: true, unchanged: true, stage: facts.current, ...(row ? { row } : {}) };
    }
    // 9. the rules
    const r = rule(target, facts);
    if (!r.allowed) throw fail(400, r.why);
    if (r.reasonRequired && reason.length < REASON_MIN) throw fail(400, T.reasonNeeded, { code: 'reason' });
    // 10. the write — ONE mutation, retries 0. An error here does not mean it did not land: step 11 looks.
    const cols = { [STAGE_COL]: { index } };
    if (r.unlocks) cols[LOCK_COL] = { label: 'No' };
    let writeErr = null;
    try { await io.writeStage(rowId, cols); }
    catch (err) { writeErr = err; console.error(`[StageChange] write on item ${itemId} failed: ${err.message}`); }
    // 11. read-back (a second try when the first fails)
    let back = null, readErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { back = await io.readCells(rowId); readErr = null; break; }
      catch (err) { readErr = err; }
    }
    if (readErr || !back) {
      console.error(`[StageChange] item ${itemId}: ${writeErr ? 'the write failed' : 'written'}, and the read-back failed: ${readErr ? readErr.message : 'no item'}`);
      throw fail(502, T.unknown);
    }
    const bStage = back.find((c) => c && c.id === STAGE_COL) || { value: null, text: '' };
    const bLock = back.find((c) => c && c.id === LOCK_COL) || { value: null, text: '' };
    const kept = cellStage(bStage, live.labels);
    const stageOk = kept.index === index && s(statusText(bStage)) === target.label;
    const lockOk = !r.unlocks || s(statusText(bLock)).toLowerCase() === 'no';
    if (!stageOk || !lockOk) {
      const row = patchAndRow(rowId, bStage, r.unlocks ? bLock : null, staff);
      const unchangedNow = kept.index === facts.current.index;
      if (writeErr && unchangedNow && definitiveRefusal(writeErr)) throw fail(502, T.refused, { current: kept, row });
      if (writeErr) throw fail(502, T.unknown, { current: kept, row });
      console.error(`[StageChange] item ${itemId}: Monday did not keep ${target.label} (read back "${kept.label}", lock "${s(statusText(bLock))}")`);
      throw fail(502, T.notKept, { current: kept, row });
    }
    if (writeErr) console.warn(`[StageChange] item ${itemId}: the write answered with an error but Monday holds the new stage — carrying on to the note`);
    // 12. the note (after the write; never retried)
    const where = SOURCES[source] || SOURCES['client-master'];
    const note = `🔀 <b>Case Stage changed</b>: ${esc(show(facts.current))} → ${esc(target.label)}.` +
      (r.unlocks ? ' The case was also <b>unlocked</b> (Automation Lock set to No) — reminders and checks start again.' : '') +
      (reason ? ` Reason: ${esc(reason)}.` : '') +
      ` Changed on the ${where} by ${esc(g.actor.name)} · ${esc(torontoTime(io.now()))} (Toronto).`;
    let noteFailed = false;
    try { await io.postNote(rowId, note); }
    catch (err) { noteFailed = true; console.error(`[StageChange] item ${itemId}${facts.caseRef ? ` (${facts.caseRef})` : ''}: the stage was changed but the note failed: ${err.message}`); }
    // 13. the cached rows follow the read-back (never invalidated) → the row for the page
    const row = patchAndRow(rowId, bStage, r.unlocks ? bLock : null, staff);
    console.log(`[StageChange] item ${itemId}${facts.caseRef ? ` (${facts.caseRef})` : ''}: ${show(facts.current)} → ${target.label}${r.unlocks ? ' (unlocked)' : ''}, by ${g.actor.name}`);
    const out = { ok: true, stage: { index, label: target.label }, from: facts.current, unlocked: r.unlocks, row };
    if (noteFailed) out.noteFailed = true;
    return out;
  } finally {
    _inFlight.delete(itemId);
  }
}

/** Monday answered and said no (a GraphQL error, or a 4xx that is not a rate limit) — as opposed to no answer. */
function definitiveRefusal(err) {
  if (!err) return false;
  const st = err.response && err.response.status;
  if (st) return st >= 400 && st < 500 && st !== 429;
  return !err.code && !err.request && !err.isAxiosError && err.name === 'Error';
}

/** The row from the cached Cases rows (after the patch): the server works out its views (and the page-only 'todo' view, and "waiting"). */
function rowFromCache(itemId, staff) {
  const ds = require('./dashboardService');
  const peek = ds.peekCachedItems();
  if (!peek || !Array.isArray(peek.items)) return null;
  const i = peek.items.findIndex((it) => it && String(it.id) === String(itemId));
  if (i < 0) return null;
  const row = ds.parseItem(peek.items[i], i);
  const todo = require('./todoListService');
  if (todo.allowed(staff, caseAccess.isAdminEmail) && row.views.includes(todo.OPEN_VIEW) && !row.views.includes(todo.PAGE_VIEW.key)) row.views.push(todo.PAGE_VIEW.key);
  let waiting = null;
  if (row.stageIdx === require('./clientMasterViews').PRE_ONBOARDING_INDEX) {
    require('./preOnboardingWaiting').mark([row], require('./leadSnapshot').peek());
    waiting = row.waiting || null;
  }
  return { caseStage: row.caseStage, stageIdx: row.stageIdx, views: row.views, waiting };
}

/** The page's per-row flag (pure): the switch is on and the viewer may assign this row. */
function markChangeable(cases) {
  if (!enabled()) return false;
  for (const c of cases || []) c.canChangeStage = !!c.canAssign;
  return true;
}

module.exports = {
  preview, change, gate, rule, effectsOf, isBackward, labelsFromMeta, labelsFromSettings, factsOf, markChangeable, enabled, definitiveRefusal,
  WORKING_STAGES, DCS_FROM, FLOW_RANK, TEXTS: T, SIGN_IN, OFF_TEXT, REASON_MIN, REASON_MAX, STAGE_COL, LOCK_COL,
  _io: io, _inFlight,
};
