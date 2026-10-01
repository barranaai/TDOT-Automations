'use strict';

/**
 * Held-onboarding resume — start onboarding ONCE for a case that was held for
 * signatures while its Payment Status already read "Paid".
 *
 * WHY THIS EXISTS (2026-CEC-PS-101, stuck 3 days; 2026-SV-021 the next one)
 * ------------------------------------------------------------------------
 * Staff record e-transfers by setting Payment Status = "Paid" by hand, and
 * sometimes do it before the agreement is fully executed. The Paid webhook
 * (retainerService.onRetainerPaid) and the Case Stage webhook (the Paid
 * webhook itself moves the stage to Document Collection Started on a hold —
 * since 2026-10-02; a board automation did before) both correctly HOLD
 * onboarding and post a note saying it "starts
 * automatically" once the agreement is fully signed. But the last signature
 * lands in paymentService.advanceCaseToPaid, which finds the case already
 * "Paid" and — to never write "Paid" twice — does nothing more. No webhook
 * fires again (nothing changed on the board), and the status sync sees the
 * case agreeing with its lead. The promise in the note was never kept.
 *
 * WHAT COUNTS AS "HELD AND NEVER STARTED"
 * ---------------------------------------
 * The proof is the notes the app already posts, read back from the case:
 *   - HELD: one of the two signature-hold notes (posted only when the case is
 *     Paid and the signature gate is incomplete).
 *   - never started: no "Onboarding started automatically" note (this service's
 *     own record — at most one automatic start per case, ever), and no sign that
 *     onboarding ran some other way (the checklist box, checklist rows, the notes
 *     only checklist seeding or the intake email leave). Any such sign → a staff
 *     note instead of an email, because the intake email cannot be recalled and a
 *     second "Your case is ready" is worse than a start staff are told about.
 * The late starters that used to skip the signature check (Case Type set late,
 * Sub Type set late, Client Email corrected) now ask this service first, so a
 * held case cannot be half-onboarded behind the hold's back.
 *
 * WHAT IT DOES — never touches Payment Status, the payment date or the stage:
 *   1. posts the "Onboarding started automatically" note FIRST (the record);
 *   2. restarts the chasing clock exactly like the payment webhook does;
 *   3. sends the intake email, the sponsor's email and seeds the checklist — the
 *      same calls, in the same order, as onRetainerPaid's deferred-onboarding
 *      branch.
 *
 * Entry points: the already-Paid branch of advanceCaseToPaid (the last
 * signature), the 15-minute status sync (backstop), and the three late starters.
 * Switch: ONBOARDING_RESUME — ON unless set to 0/false/no/off (kill switch).
 * OFF keeps every check and posts a "needs a manual start" note instead.
 */

const mondayApi = require('./mondayApi');
const { clientMasterBoardId, executionBoardId } = require('../../config/monday');

const COLS = {
  paymentStatus: 'color_mm0x9fnn',
  stage:         'color_mm0x8faa',
  applied:       'color_mm0xs7kp',   // "Checklist Template Applied"
  caseRef:       'text_mm142s49',
  clientEmail:   'text_mm0xw6bp',
  stageStart:    'date_mm0xjm1z',
  chasingStage:  'color_mm1abve4',
  reminderCount: 'numeric_mm1a4e8r',
};
const EXEC_CASE_REF_COL = 'text_mm0z2cck';
const DCS = 'Document Collection Started';
// Stages a held case can sit in before onboarding: the fix is to (re)enter
// Document Collection. Any OTHER stage means staff already moved the case on.
const EARLY_STAGES = ['', 'Pre-Onboarding', 'Retainer Confirmed'];
const UNCONFIRMED_AFTER_MS = 30 * 60 * 1000;
const AUTOMATION_USER_ID = '-4';   // Monday board automations in the activity log
const UPDATES_LIMIT = 100;

// The two signature-hold notes (retainerService.onRetainerPaid and the Case
// Stage webhook). NOT the "not Paid" note ("Onboarding deferred:</b> this case
// was moved…") and not the lead-side notes — those are not holds on a Paid case.
const HELD_PATTERNS = [/Payment marked, but onboarding is on hold/i, /Onboarding deferred:\s*missing\b/i];
const RESUMED_TEXT  = 'Onboarding started automatically';
// After the start: the intake email's outcome, one note either way.
const SENT_TEXT     = 'Intake email sent';                        // also posted by the admin resend tool
const FAILED_TEXT   = 'The client\'s intake email did not go out';
// Staff notes: ACTION = something to do before it can start; FINAL = it looks
// like onboarding already ran another way, so it is never started again
// automatically (until a NEWER hold); UNCONFIRMED = started but no outcome.
const ACTION_HEAD      = 'onboarding did not start automatically';
const FINAL_HEAD       = 'Held onboarding not restarted automatically';
const UNCONFIRMED_HEAD = 'automatic onboarding may not have finished';
const FINAL_CODES      = ['evidence', 'changed', 'moved-on'];
// Each staff note carries its code in a hidden marker, so "already told" is per
// kind: a "fix this first" note never silences a later "it already ran" note.
const REPORT_MARKER    = 'tdot-onb-report:';
const markerOf = (code) => `<span style="display:none">${REPORT_MARKER}${code};</span>`;
const MARKER_RE = new RegExp(`${REPORT_MARKER}([a-z-]+);`, 'g');

// Signs that onboarding already ran some other way. Each is left ONLY by
// checklist seeding (which runs alongside the intake email) or by the intake
// email itself.
const EVIDENCE_NOTES = [
  [/questionnaire fields? were pre-filled/i,          'the questionnaire was pre-filled'],
  [/Document checklist created\b/i,                   'a document checklist was created'],
  [/Document checklist auto-seed FAILED/i,            'checklist setup already ran'],
  [/Checklist re-seed complete/i,                     'the checklist was re-seeded'],
  [/Re-seed failed/i,                                 'a checklist re-seed was tried'],
  [/Family members not covered/i,                     'checklist setup already ran'],
  [/checklist-blocked-(no|wrong)-subtype/i,           'checklist setup already ran'],
  [/Intake email resent\b/i,                          'the intake email was re-sent when the client email was corrected'],
  [/Intake email sent\b/i,                            'the intake email was already sent'],
];

const s = (v) => String(v == null ? '' : v).trim();
const today = () => new Date().toISOString().slice(0, 10);

function isEnabled() {
  return !/^(0|false|no|off)$/i.test(s(process.env.ONBOARDING_RESUME));
}

/** Both renderings of a Monday update, so a hidden marker or a tag-split phrase still matches. */
function noteText(u) {
  return `${s(u && u.text_body)}\n${s(u && u.body)}`;
}
const tms = (iso) => { const t = Date.parse(s(iso)); return Number.isFinite(t) ? t : 0; };

/**
 * PURE — read the case's notes. `updates` as Monday returns them (any order).
 * @returns {{ heldAt, resumedAt, confirmed, reportedSinceHeld: Set<string>, finalSinceHeld, unconfirmedReported, evidence: string[] }}
 *   times in ms (0 = none); `confirmed` = the intake email's outcome was noted after the newest start;
 *   `reportedSinceHeld` = the report codes already posted since the newest hold.
 */
function readNotes(updates = []) {
  let heldAt = 0, resumedAt = 0;
  for (const u of updates) {
    const t = noteText(u), at = tms(u.created_at) || 1;
    if (HELD_PATTERNS.some((re) => re.test(t))) heldAt = Math.max(heldAt, at);
    if (t.includes(RESUMED_TEXT)) resumedAt = Math.max(resumedAt, at);
  }
  let confirmed = false, finalSinceHeld = false, unconfirmedReported = false;
  const reportedSinceHeld = new Set();
  const evidence = [];
  for (const u of updates) {
    const t = noteText(u), at = tms(u.created_at) || 1;
    if (resumedAt && at >= resumedAt && (t.includes(SENT_TEXT) || t.includes(FAILED_TEXT))) confirmed = true;
    const codes = [...t.matchAll(MARKER_RE)].map((m) => m[1]);
    if (at >= heldAt) {
      for (const c of codes) reportedSinceHeld.add(c);
      if (t.includes(FINAL_HEAD) || codes.some((c) => FINAL_CODES.includes(c))) finalSinceHeld = true;
    }
    if (resumedAt && at >= resumedAt && (t.includes(UNCONFIRMED_HEAD) || codes.includes('unconfirmed'))) unconfirmedReported = true;
    for (const [re, label] of EVIDENCE_NOTES) if (re.test(t) && !evidence.includes(label)) evidence.push(label);
  }
  return { heldAt, resumedAt, confirmed, reportedSinceHeld, finalSinceHeld, unconfirmedReported, evidence };
}

/**
 * PURE — the whole judgement. Fields not read yet are `undefined`; the result
 * then asks for the next one ({ action: 'need', what }) so the caller reads only
 * what the decision actually needs, cheapest first.
 *
 * @param {object} input
 *   cm          { paymentStatus, stage, applied, caseRef, clientEmail } | null (gone)
 *   updates     Monday updates of the case
 *   claimants   leads whose clientMasterItemId is this case
 *   rows        number of checklist rows for the case ref (0 or 1 is enough)
 *   changes     Payment Status / Case Stage changes after the hold: [{ column, userId, at }]
 *   now         ms (defaults to the clock)
 * @returns {{ action: 'need'|'none'|'report'|'resume', what?, code?, detail?, quiet?, evidence? }}
 */
function decide(input) {
  const { cm, updates, claimants, rows, changes } = input;
  const now = input.now || Date.now();
  if (!cm) return { action: 'none', code: 'no-case' };
  if (s(cm.paymentStatus) !== 'Paid') return { action: 'none', code: 'not-paid' };

  if (updates === undefined) return { action: 'need', what: 'updates' };
  const notes = readNotes(updates);
  if (!notes.heldAt) return { action: 'none', code: 'not-held' };
  if (notes.resumedAt) {
    // Started once already — never again. If the intake email's outcome never
    // got noted (a restart or an outage between the record and the send), say
    // so once rather than leave a "started" note that nothing followed.
    if (notes.confirmed) return { action: 'none', code: 'already-resumed' };
    // Not settled yet: never memoised, so the 30-minute check below is not missed.
    if (now - notes.resumedAt < UNCONFIRMED_AFTER_MS) return { action: 'none', code: 'resume-pending' };
    return { action: 'report', code: 'unconfirmed', detail: new Date(notes.resumedAt).toISOString(), quiet: notes.unconfirmedReported };
  }
  if (notes.finalSinceHeld) return { action: 'none', code: 'reported' };

  if (claimants === undefined) return { action: 'need', what: 'claimants' };
  if (!claimants.length) return { action: 'none', code: 'no-lead' };
  const gate = require('./caseGateService');
  const day = today();
  // The board's "Paid" IS the payment record here, so only signatures are
  // checked — on ALL claiming leads (one fully executed claimant is enough),
  // exactly like the Paid and Case Stage webhooks.
  const gates = claimants.map((l) => gate.signatureGateForLead({ ...l, retainerPaid: s(l && l.retainerPaid) || day }));
  if (!gates.some((g) => g.complete)) {
    return { action: 'none', code: 'waiting', detail: gates[0].missing.join(' and '),
      evidence: s(cm.applied).toLowerCase() === 'yes' || !!s(cm.stageStart) || notes.evidence.length > 0 };
  }

  // A FINAL note is posted once (finalSinceHeld returns 'reported' above on
  // every later pass); a "fix this first" note once per kind.
  const report = (code, detail) => ({ action: 'report', code, detail, quiet: !FINAL_CODES.includes(code) && notes.reportedSinceHeld.has(code) });
  if (s(cm.applied).toLowerCase() === 'yes') return report('evidence', 'the document checklist is marked as applied');
  // Stage Start Date is written only by the app, and only when onboarding goes
  // ahead (the payment webhook, the Case Stage webhook's start, the case-type
  // resume, this service) or the case moves on — never on a hold. Set = it ran.
  if (s(cm.stageStart)) return report('evidence', `onboarding already ran (Stage Start Date ${s(cm.stageStart)})`);
  if (notes.evidence.length) return report('evidence', notes.evidence.join(', '));
  if (s(cm.stage) !== DCS) return report(EARLY_STAGES.includes(s(cm.stage)) ? 'stage' : 'moved-on', s(cm.stage) || 'blank');
  if (!s(cm.caseRef)) return report('no-case-ref');
  if (!s(cm.clientEmail)) return report('no-email');

  if (rows === undefined) return { action: 'need', what: 'rows' };
  if (rows === null) return { action: 'none', code: 'unreadable', detail: 'checklist rows could not be read' };
  if (rows > 0) return report('evidence', 'document checklist rows exist');

  // A Payment Status or Case Stage change after the newest hold means someone
  // acted — possibly starting onboarding by hand, or a start that went ahead
  // while a signature check could not be read (those proceed and post no new
  // hold). Without a trace we can't tell whether the intake email already went,
  // so a person decides. A change made WHILE held always leaves a newer hold
  // note (the Paid flip and the move back to Document Collection are both held
  // again), and a board automation's own stage moves (user -4; the "Paid →
  // Document Collection" one wrote them until 2026-10-02, when the app took
  // that over — kept for the history already on the boards) say nothing new.
  if (changes === undefined) return { action: 'need', what: 'changes', since: notes.heldAt };
  if (changes === null) return { action: 'none', code: 'unreadable', detail: 'the change history could not be read' };
  // Monday reports a note's created_at to the SECOND, the change history to the
  // millisecond: a change inside the hold note's own second is the hold's own
  // setup (retainerService writes stage + flags right before posting the note)
  // — nobody changes a stage by hand within the second the app posts its note.
  const acted = changes.filter((c) => c.at >= notes.heldAt + 1000
    && (c.column === COLS.paymentStatus || (c.column === COLS.stage && s(c.userId) !== AUTOMATION_USER_ID)));
  if (acted.length) return report('changed');
  return { action: 'resume' };
}

const esc = (v) => s(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACTION_PREFIX = `⚠️ <b>Fully signed and paid, but ${ACTION_HEAD}</b> — `;
const FINAL_PREFIX  = `ℹ️ <b>${FINAL_HEAD}</b> — `;
const FINAL_TAIL = ' Nothing was sent to the client. If the client never received "Your case is ready", use <b>Resend portal access</b> on the client page; ' +
  'if the document checklist is missing, flip <b>Re-seed Checklist → Run</b>. Please don\'t move the Case Stage back to restart it.';
const MANUAL_START = 'To start it, set the Case Stage to <b>Pre-Onboarding</b> and then back to <b>Document Collection Started</b> — ' +
  'the intake email, document checklist and questionnaire then start by themselves. Please don\'t switch the Payment Status off and on (that changes the payment date).';

function reportNote(code, detail) {
  return _reportText(code, detail) + markerOf(code);
}
function _reportText(code, detail) {
  switch (code) {
    case 'evidence':
      return FINAL_PREFIX + `this case already shows signs that onboarding ran (${esc(detail)}).` + FINAL_TAIL;
    case 'changed':
      return FINAL_PREFIX + 'the Payment Status or Case Stage was changed after onboarding was put on hold, so it may already have been started by hand.' + FINAL_TAIL;
    case 'moved-on':
      return FINAL_PREFIX + `the case has already moved on to "${esc(detail)}".` + FINAL_TAIL;
    case 'stage':
      return ACTION_PREFIX + `the Case Stage is "${esc(detail)}". To start it, set the Case Stage to <b>Document Collection Started</b> — the intake email, document checklist and questionnaire then start by themselves.`;
    case 'no-case-ref':
      return ACTION_PREFIX + 'the case has no Case Reference yet. Set the <b>Primary Case Type</b> — onboarding then starts by itself.';
    case 'no-email':
      return ACTION_PREFIX + 'there is no Client Email on this case. Add the client\'s email — onboarding then starts by itself.';
    case 'manual-start':
      return ACTION_PREFIX + 'automatic starting is switched off. ' + MANUAL_START;
    case 'unconfirmed':
      return `⚠️ <b>Please check: ${UNCONFIRMED_HEAD}</b> — it was started automatically, but there is no record that the intake email went out ` +
        '(a server restart or a Monday outage at that moment can do this). It is not re-sent automatically, so the client is never emailed twice. ' +
        'If the client never received "Your case is ready", use <b>Resend portal access</b> on the client page; if the document checklist is missing, flip <b>Re-seed Checklist → Run</b>.';
    default:
      return ACTION_PREFIX + esc(detail || code);
  }
}

const RESUMED_NOTE = `▶️ <b>${RESUMED_TEXT}.</b> The retainer is now fully signed and the payment is recorded, so the client's intake email, ` +
  'document checklist and questionnaire are going out now. It was on hold because the Payment Status was set to Paid before the agreement was fully signed. ' +
  'There is no need to change the Payment Status or the Case Stage.';
const emailSentNote = (to) => `✉️ <b>${SENT_TEXT}</b> ("Your case is ready") to ${esc(to)}.`;
const emailFailedNote = (reason) => `⚠️ <b>${FAILED_TEXT}</b> (${esc(reason || 'unknown reason')}). ` +
  'The document checklist and questionnaire are being set up as normal. Please use <b>Resend portal access</b> on the client page to send the client their link.';

/* ───────────────────────────── I/O ───────────────────────────── */

const io = {
  async readCase(itemId) {
    const d = await mondayApi.query(
      `query($ids:[ID!]){ items(ids:$ids){ id state board{id} column_values(ids:${JSON.stringify(Object.values(COLS))}){ id text } } }`,
      { ids: [String(itemId)] });
    const item = d && d.items && d.items[0];
    if (!item || (item.state && item.state !== 'active')) return null;
    if (item.board && String(item.board.id) !== String(clientMasterBoardId)) return null;
    const cv = {};
    for (const c of item.column_values || []) cv[c.id] = s(c.text);
    return { paymentStatus: cv[COLS.paymentStatus] || '', stage: cv[COLS.stage] || '', applied: cv[COLS.applied] || '',
      caseRef: (cv[COLS.caseRef] || '').replace(/\s+/g, ' '), clientEmail: cv[COLS.clientEmail] || '', stageStart: cv[COLS.stageStart] || '' };
  },
  async readUpdates(itemId) {
    const d = await mondayApi.query(
      `query($ids:[ID!]){ items(ids:$ids){ updates(limit:${UPDATES_LIMIT}){ id created_at text_body body } } }`,
      { ids: [String(itemId)] });
    return (d && d.items && d.items[0] && d.items[0].updates) || [];
  },
  findClaimants: (itemId) => require('./leadService').findAllByColumnValue('clientMasterItemId', String(itemId)),
  async countRows(caseRef) {
    const d = await mondayApi.query(
      `query($b: ID!, $v: String!){ items_page_by_column_values(limit: 1, board_id: $b, columns: [{ column_id: "${EXEC_CASE_REF_COL}", column_values: [$v] }]){ items { id } } }`,
      { b: String(executionBoardId), v: caseRef });
    return ((d && d.items_page_by_column_values && d.items_page_by_column_values.items) || []).length;
  },
  async readChanges(itemId, sinceMs) {
    const d = await mondayApi.query(
      `query($b:[ID!], $i:[ID!], $f: ISO8601DateTime){ boards(ids:$b){ activity_logs(item_ids:$i, column_ids:["${COLS.paymentStatus}","${COLS.stage}"], from:$f, limit:100){ data created_at user_id } } }`,
      { b: [String(clientMasterBoardId)], i: [String(itemId)], f: new Date(sinceMs).toISOString() });
    const logs = (d && d.boards && d.boards[0] && d.boards[0].activity_logs) || [];
    return logs.map((l) => {
      let data = {};
      try { data = JSON.parse(l.data || '{}'); } catch (_) { /* unreadable entry: column unknown */ }
      // activity-log created_at counts 100-nanosecond units
      return { column: s(data.column_id), userId: s(l.user_id), at: Math.floor(Number(l.created_at) / 10000) };
    });
  },
  async postNote(itemId, body) {
    const d = await mondayApi.query(`mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }`, { i: String(itemId), b: body });
    return d && d.create_update && d.create_update.id;
  },
  writeCols: (itemId, cols) => mondayApi.query(
    `mutation($b: ID!, $i: ID!, $c: JSON!){ change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c){ id } }`,
    { b: String(clientMasterBoardId), i: String(itemId), c: JSON.stringify(cols) }),
  sendIntakeEmail: (itemId) => require('./emailService').sendIntakeEmail(itemId),
  ensureSponsor: (args) => require('./sponsorOnboardingService').ensureSponsor(args),
  seedChecklist: (itemId) => require('./checklistService').onDocumentCollectionStarted({ itemId, boardId: clientMasterBoardId }),
};

const READERS = {
  updates:   (id) => io.readUpdates(id),
  claimants: (id) => io.findClaimants(id),
  rows:      (id, input) => io.countRows(input.cm.caseRef).catch((err) => { console.warn(`[OnboardingResume] ${id}: checklist rows unreadable (${err.message})`); return null; }),
  changes:   (id, input, v) => io.readChanges(id, v.since).catch((err) => { console.warn(`[OnboardingResume] ${id}: change history unreadable (${err.message})`); return null; }),
};

/** Read what the decision needs and decide. Reads only — never writes. */
async function evaluate(itemId, { trigger, caseRef } = {}) {
  const input = { now: Date.now() };
  input.cm = await io.readCase(itemId);
  // A caller that just assigned the case reference knows it before Monday's read does.
  if (input.cm && !input.cm.caseRef && caseRef) input.cm.caseRef = s(caseRef);
  for (let i = 0; i < 6; i++) {
    const v = decide(input);
    if (v.action !== 'need') return { verdict: v, input };
    input[v.what] = await READERS[v.what](itemId, input, v);
  }
  throw new Error('decide did not settle');
}

const _inFlight = new Map();   // itemId → promise (one start per case per process)

/**
 * Start onboarding for a held case if — and only if — it is owed one.
 * Never throws. Returns the verdict: { action, code?, detail? } where action is
 * 'none' | 'report' | 'resumed' | 'resume' (dry run) | 'error'.
 *
 * @param {object} p
 * @param {string} p.itemId    Client Master item
 * @param {string} p.trigger   'last-signature' | 'sweep' | 'case-ref' | 'sub-type' | 'email-change'
 * @param {boolean} [p.dryRun] decide only: no notes, no writes, no emails
 * @param {string} [p.caseRef] a case reference the caller already knows
 */
async function resumeIfOwed({ itemId, trigger = 'sweep', dryRun = false, caseRef = '' } = {}) {
  const id = s(itemId);
  if (!id) return { action: 'none', code: 'no-item' };
  const run = () => _resume(id, { trigger, dryRun, caseRef }).catch((err) => {
    console.warn(`[OnboardingResume] ${id} (${trigger}): ${err.message}`);
    return { action: 'error', code: 'error', detail: err.message };
  });
  if (dryRun) return run();
  if (_inFlight.has(id)) return _inFlight.get(id);
  const p = run();
  _inFlight.set(id, p);
  try { return await p; } finally { _inFlight.delete(id); }
}

async function _resume(id, { trigger, dryRun, caseRef }) {
  const { verdict: v, input } = await evaluate(id, { trigger, caseRef });
  if (v.action === 'none') {
    if (v.code === 'waiting' || v.code === 'unreadable') console.log(`[OnboardingResume] ${id} (${trigger}): ${v.code}${v.detail ? ` — ${v.detail}` : ''}`);
    return v;
  }
  if (v.action === 'report') return report(id, v, { trigger, dryRun });
  // action === 'resume'
  if (dryRun) return v;
  if (!isEnabled()) return report(id, { action: 'report', code: 'manual-start', quiet: readNotes(input.updates).reportedSinceHeld.has('manual-start') }, { trigger, dryRun });

  // Last look right before the point of no return: the reads above can be a few
  // seconds old, and a payment recorded in error is un-marked by hand first.
  const now = await io.readCase(id);
  if (!now || now.paymentStatus !== 'Paid' || now.stage !== DCS || s(now.applied).toLowerCase() === 'yes' || s(now.stageStart)) {
    console.log(`[OnboardingResume] ${id} (${trigger}): case changed just before starting — not started`);
    return { action: 'none', code: 'changed-before-start' };
  }

  // The record FIRST. If it can't be written, nothing is sent (the sync tries
  // again). A write that errored can still have landed (the API client retries),
  // so a failure is checked against the case before giving up.
  try {
    await io.postNote(id, RESUMED_NOTE);
  } catch (err) {
    const landed = await io.readUpdates(id).then((u) => readNotes(u).resumedAt > 0).catch(() => false);
    if (!landed) {
      console.warn(`[OnboardingResume] ${id} (${trigger}): could not record the start (${err.message}) — nothing sent; retried by the status sync`);
      return { action: 'error', code: 'record-failed', detail: err.message };
    }
  }

  // Same chasing restart as the payment webhook (retainerService.onRetainerPaid):
  // the reminder ladder starts today, not from when the case was held.
  const cols = { [COLS.stageStart]: { date: today() }, [COLS.chasingStage]: null, [COLS.reminderCount]: '0' };
  // A later Sub Type arrival resumes seeding only from the explicit "No".
  if (!s(now.applied)) cols[COLS.applied] = { label: 'No' };
  try { await io.writeCols(id, cols); }
  catch (err) { console.warn(`[OnboardingResume] ${id}: chasing clock not restarted (${err.message})`); }

  console.log(`[OnboardingResume] ${now.caseRef || id} (${trigger}): held onboarding starting now`);
  // Same calls, same order as onRetainerPaid's deferred-onboarding branch —
  // fire-and-forget; the checklist setup can take minutes.
  // The send's outcome and the outcome NOTE are separate failures: a note that
  // can't be posted after a good send must never read "did not go out" (staff
  // would email the client again) — it is left to the 30-minute check.
  Promise.resolve()
    .then(() => io.sendIntakeEmail(id))
    .then(
      (r) => io.postNote(id, r && r.sent ? emailSentNote(require('./emailService').maskAddr(r.to)) : emailFailedNote(r && r.reason))
        .catch((err) => console.warn(`[OnboardingResume] ${id}: intake email outcome note failed (${err.message})`)),
      (err) => {
        console.error(`[OnboardingResume] ${id}: intake email failed: ${err.message}`);
        return io.postNote(id, emailFailedNote(err.message)).catch(() => {});
      });
  Promise.resolve()
    .then(() => io.ensureSponsor({ itemId: id, mode: 'onboard', trigger: 'signature-resume' }))
    .catch((err) => console.error(`[OnboardingResume] ${id}: sponsor onboarding failed: ${err.message}`));
  Promise.resolve()
    .then(() => io.seedChecklist(id))
    .then(() => console.log(`[OnboardingResume] ${id}: checklist setup complete`))
    .catch((err) => console.error(`[OnboardingResume] ${id}: checklist setup failed: ${err.message}`));
  return { action: 'resumed', trigger };
}

async function report(id, v, { trigger, dryRun }) {
  console.warn(`[OnboardingResume] ${id} (${trigger}): not started automatically — ${v.code}${v.detail ? ` (${v.detail})` : ''}`);
  if (!dryRun && !v.quiet) {
    await io.postNote(id, reportNote(v.code, v.detail))
      .catch((err) => console.warn(`[OnboardingResume] ${id}: staff note failed (${err.message})`));
  }
  return v;
}

/* ─────────────────────── the 15-minute backstop ─────────────────────── */

const MEMO_TTL_MS = 6 * 60 * 60 * 1000;
const _memo = new Map();   // itemId → { fp, until }
const MEMO_CODES = new Set(['not-held', 'already-resumed', 'reported', 'no-lead', 'waiting', 'evidence', 'changed', 'moved-on', 'unconfirmed']);

/**
 * PURE — the cases worth a look, from data the status sync already holds:
 * Paid, in Document Collection Started, checklist not applied, and at least one
 * claiming lead with the agreement fully executed. Normally empty.
 *
 * @param {object[]} leads  every lead (parsed)
 * @param {Map<string, {paymentStatus, stage, applied}>} cases  Client Master rows by item id
 */
function sweepCandidates(leads, cases) {
  const gate = require('./caseGateService');
  const day = today();
  const byCase = new Map();
  for (const l of leads || []) {
    const cm = s(l && l.clientMasterItemId);
    if (!cm) continue;
    if (!byCase.has(cm)) byCase.set(cm, []);
    byCase.get(cm).push(l);
  }
  const out = [];
  for (const [itemId, claimants] of byCase) {
    const c = cases && cases.get(itemId);
    if (!c || c.paymentStatus !== 'Paid' || s(c.applied).toLowerCase() === 'yes') continue;
    if (c.stage !== DCS && !EARLY_STAGES.includes(s(c.stage))) continue;   // moved on: staff own it
    const passing = claimants.filter((l) => gate.signatureGateForLead({ ...l, retainerPaid: s(l.retainerPaid) || day }).complete);
    if (!passing.length) continue;
    const fp = [c.paymentStatus, c.stage, c.applied, ...passing.map((l) => s(l.id)).sort()].join('|');
    out.push({ itemId, fp });
  }
  return out;
}

/**
 * Status-sync step: start any held onboarding the last-signature trigger missed
 * (a restart, a busy client record, a lost webhook). Sequential and memoised —
 * a case that was looked at and needs nothing is not re-read for 6 hours unless
 * its payment, stage, checklist flag or executed leads change.
 */
async function sweepHeldOnboarding({ leads, cases, dryRun = false } = {}) {
  const out = { resumed: [], wouldResume: [], reported: [], waiting: [] };
  const nowMs = Date.now();
  for (const { itemId, fp } of sweepCandidates(leads, cases)) {
    const m = _memo.get(itemId);
    if (!dryRun && m && m.fp === fp && m.until > nowMs) continue;
    const r = await resumeIfOwed({ itemId, trigger: 'sweep', dryRun });
    if (r.action === 'resumed') out.resumed.push(itemId);
    else if (r.action === 'resume') out.wouldResume.push(itemId);
    else if (r.action === 'report') out.reported.push({ itemId, code: r.code, detail: r.detail || '' });
    else if (r.code === 'waiting') out.waiting.push(itemId);
    // Only SETTLED verdicts are memoised: never an abort, an unreadable read or
    // an error (retried next pass), nor a report staff fix by editing a field
    // the key doesn't see (case reference, client email, stage-to-DCS).
    if (!dryRun && MEMO_CODES.has(r.code)) _memo.set(itemId, { fp, until: nowMs + MEMO_TTL_MS });
  }
  if (out.resumed.length) console.log(`[OnboardingResume] status sync started held onboarding for ${out.resumed.length} case(s)`);
  return out;
}

function _resetForTests() { _inFlight.clear(); _memo.clear(); }

module.exports = {
  resumeIfOwed, sweepHeldOnboarding, isEnabled,
  decide, readNotes, sweepCandidates, reportNote,          // pure
  io, _resetForTests,
  RESUMED_TEXT, SENT_TEXT, HELD_PATTERNS, RESUMED_NOTE, EARLY_STAGES, FINAL_CODES,
};
