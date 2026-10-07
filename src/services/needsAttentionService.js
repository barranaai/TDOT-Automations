'use strict';

/**
 * "Needs attention" — the list at the top of the Summary page: every case a
 * person has to act on because a step was missed (2026-10-01, after the scan of
 * 106 paused cases found 62 stuck on a missed step nobody saw).
 *
 * What it finds, per case on the Cases board (TEST rows left out):
 *   - a case number on two cases, or no case number;
 *   - a leftover test folder carrying the case's number, or two folders for one case;
 *   - a staff note saying the payment came in while Payment Status is not "Paid";
 *   - paid, but no document checklist (Sub Type needed, set-up failed, onboarding
 *     on hold, or simply never started);
 *   - the app's own warning notes that nothing has answered yet (intake email
 *     not confirmed, sponsor email not sent, payment flagged, nobody assigned…).
 *
 * Every rule checks that the problem STILL holds (the board, the document
 * checklist, OneDrive, or a later note that settles it) — an old warning on a
 * case that was fixed never shows.
 *
 * READ-ONLY on every board and folder, with one exception: "Mark handled" posts
 * a note on the case. That note is the record — the next check reads it and
 * leaves the item off the list until the problem itself changes (a new warning,
 * a new duplicate row, a new folder gives a new item).
 *
 * The list is worked out at 07:00 Toronto every day (scheduler) and on "Check
 * now"; it is kept in memory, and a restart works it out again on the next view.
 */

const crypto = require('crypto');
const mondayApi = require('./mondayApi');
const { clientMasterBoardId, executionBoardId } = require('../../config/monday');
const caseAccess = require('./caseAccessService');
const { torontoTime } = require('../utils/torontoTime');

// ─── Columns (Cases board) ───────────────────────────────────────────────────
const COL = {
  ref:            'text_mm142s49',
  caseType:       'dropdown_mm0xd1qn',
  subType:        'dropdown_mm0x4t91',
  stage:          'color_mm0x8faa',
  payment:        'color_mm0x9fnn',
  paidDate:       'date_mm0xgk76',
  manager:        'multiple_person_mm0xhmgk',
  submissionTeam: 'multiple_person_mm2nhsx1',
};
const FETCH_COLS = [...new Set([...Object.values(COL), ...caseAccess.PEOPLE_COLUMNS])];
const EXEC_REF_COL = 'text_mm0z2cck';            // Documents board: the case reference
// Board groups that are not live cases. By id, with the title as a fallback
// should a group be re-made.
const TEST_GROUP_ID = 'group_mm3842s';
const NOT_CASE_GROUPS = [
  { id: TEST_GROUP_ID,      title: /^test$/i },                          // TEST
  { id: 'group_mm2tz8e1',   title: /^leads$/i },                         // Leads (enquiries kept here by staff)
  { id: 'group_mm3b9tap',   title: /cancel|did not retain/i },           // Cancel / Did not retained
];
// Clients retained before the app ran (staff-managed): only the case-number and
// folder checks apply — the app never set them up, so "no checklist", "no case
// number" or "payment not marked" says nothing about them.
const LEGACY_GROUPS = [{ id: 'group_mm3t4kda', title: /before may 2026/i }];   // Retainers before May 2026
const inGroups = (c, list) => list.some((g) => c.groupId === g.id || g.title.test(c.groupTitle || ''));
// A Case Sub Type that says the family comes along ("CEC Accompanying Spouse &
// Child") — not "Non-Accompanying Spouse". The checklist and questionnaire are
// built per family member, so such a case with no spouse/child on the Family
// Members board covers the main applicant only (2026-10-07, 2026-CEC-EE-070).
const ACCOMPANYING_RE = /\baccompanying\b/i, NON_ACCOMPANYING_RE = /\bnon[\s-]?accompanying\b/i;   // "Non Accompanying Spouse" (space) on the board
const saysAccompanying = (subType) => ACCOMPANYING_RE.test(String(subType || '')) && !NON_ACCOMPANYING_RE.test(String(subType || ''));
const ACCOMPANYING_TYPES = ['Spouse', 'Dependent Child'];
// A checklist row's / questionnaire member's type, normalised the way the
// client's document list matches them (documentFormService.normApplicantType):
// "Spouse / Common-Law Partner" → spouse, "Dependent Child 2" → dependent child.
// Exact — "Non Accompanying Spouse", "Worker Spouse" and "Sponsor" are not the
// accompanying family.
const normMemberType = (t) => String(t || '').toLowerCase().replace(/\s*\/.*$/, '').replace(/\s+\d+$/, '').trim();
const isAccompanyingType = (t) => ['spouse', 'common-law partner', 'dependent child'].includes(normMemberType(t));
const NOTES_LIMIT = 50;                          // notes read per case (newest first)
const DEEP_NOTES_LIMIT = 200;                    // for a case whose window may hide a "handled" note

const DCS = 'Document Collection Started';
// Before onboarding: a paid case here should get its checklist at DCS.
const BEFORE_DOCS = ['', 'Not Started', 'Pre-Onboarding', 'Retainer Confirmed', DCS];
// Finished cases: nothing on them is "stuck" any more (folder and number problems still count).
const CLOSED_STAGES = ['Application Submitted', 'Submitted', 'Approved', 'Refused', 'Closed',
  'Withdrawn', 'Cancelled', 'Archived', 'Task Done'];

const GRACE_NEW_CASE_MS = 30 * 60 * 1000;        // a brand-new case is still being set up
const GRACE_NO_TYPE_MS = 2 * 24 * 3600 * 1000;   // a case without a type yet, before it counts
const GRACE_SETUP_MS = 2 * 3600 * 1000;          // paid just now: the checklist is being built
const GRACE_PAID_DAY_MS = 24 * 3600 * 1000;      // the payment date column holds a DAY (read as its midday), not a time
const GRACE_RETRY_MS = 10 * 60 * 1000;           // the sponsor send retries by itself in ~90 s
const SAME_RUN_MS = 5 * 60 * 1000;               // notes this close after a warning are from the same checklist run

// ─── The groups, in the order the page shows them ────────────────────────────
// severity: high = a client is (or will be) affected; medium = a step is waiting
// on staff; low = worth a look.
const KINDS = {
  'ref-duplicate': { order: 10, severity: 'high',   label: 'Case number on two cases' },
  'ref-missing':   { order: 11, severity: 'high',   label: 'No case number' },
  'folder-test':   { order: 20, severity: 'high',   label: 'A leftover test folder has this case number' },
  'payment-noted': { order: 30, severity: 'high',   label: 'Payment noted, but not marked Paid' },
  'subtype':       { order: 40, severity: 'high',   label: 'Case Sub Type needed for the checklist' },
  'no-checklist':  { order: 41, severity: 'high',   label: 'Paid, but no document checklist' },
  'not-started':   { order: 42, severity: 'high',   label: 'Signed and paid, but onboarding did not start' },
  'family-missing':{ order: 43, severity: 'high',   label: 'Accompanying family not recorded' },
  'on-hold':       { order: 50, severity: 'medium', label: 'Paid, onboarding waiting for signatures' },
  'intake-email':  { order: 60, severity: 'medium', label: '"Your case is ready" email not confirmed' },
  'sponsor-email': { order: 61, severity: 'medium', label: 'Sponsor email not sent' },
  'payment-flag':  { order: 62, severity: 'medium', label: 'Payment flagged for an admin' },
  'assign':        { order: 63, severity: 'medium', label: 'Ready for the next step, nobody assigned' },
  'folder-split':  { order: 70, severity: 'medium', label: 'Two folders for one case' },
  'other-warning': { order: 80, severity: 'low',    label: 'Other app warnings' },
};

// ─── The notes it reads (Monday text_body: tags stripped) ────────────────────
// Matched on the stable bold heads the services write, never on whole sentences.
const NOTE = {
  importedHistory:  /Conversation history imported from the lead record/i,
  handled:          /Marked as handled\b[\s\S]*?\b(NA-[0-9a-f]{10})\b/i,
  // the document checklist and onboarding
  seedFailed:       /Document checklist auto-seed FAILED/i,
  subtypeMissing:   /Document checklist NOT created yet\s*\W+\s*Case Sub Type required/i,
  subtypeWrong:     /Document checklist NOT created\s*\W+\s*the Case Sub Type doesn.t match/i,
  reseedFailed:     /Re-seed failed:/i,
  checklistOk:      /Document checklist created\b|Checklist re-seed complete/i,
  stateUnreadable:  /Payment recorded, but the case state could not be read/i,
  hold:             /Payment marked, but onboarding is on hold|Onboarding deferred:\s*missing\b/i,
  paymentUnverified:/Onboarding NOT started:\s*the payment status could not be verified/i,
  paidPastDocs:     /Payment marked while the case is at/i,          // retainerService stage guard (2026-10-02)
  started:          /Onboarding started automatically/i,
  actionReport:     /Fully signed and paid, but onboarding did not start automatically/i,
  finalReport:      /Held onboarding not restarted automatically/i,
  // the client's intake email
  unconfirmed:      /automatic onboarding may not have finished/i,
  intakeFailed:     /The client.s intake email did not go out/i,
  intakeSent:       /Intake email sent\b|Intake email resent\b|Portal access email re-sent|Portal link email re-sent/i,
  // sponsor
  sponsorNotSent:   /Sponsor portal email (?:not sent automatically|could not be sent)/i,
  sponsorSent:      /Sponsor portal email (?:sent|re-sent) (?:by|automatically)\b/i,
  // payment corrections
  paymentFlagged:   /Payment flagged as recorded in error/i,
  undoAlarm:        /Undo raced with onboarding|Undo incomplete/i,
  paymentRemoved:   /Payment record removed|Retainer Paid date removed/i,
  // stage gates
  readyInternal:    /Case Ready for Internal Review/i,
  readySubmission:  /Case Ready for Submission Preparation/i,
  // other warnings
  familyNotCovered: /Family members not covered by this checklist/i,
  workFoldersFailed:/Could not create the working folders?\b/i,
  renameFailed:     /Could not rename this client.s OneDrive intake folder/i,
  filesMoved:       /Files (?:moved|copied) into this client.s own folder/i,
  filesNotCopied:   /file\(s\) could NOT be (?:moved|copied)/i,
  recordUnreachable:/could not be (?:saved to|checked against) the record of numbers already used/i,
  assignedUnchecked:/was assigned while OneDrive could not be checked/i,
};
// A STAFF note saying the client paid ("Payment Received @Kamalpreet…").
const PAID_NOTE = /payment (?:has been |was |is )?received|received (?:the )?payment|paid in full|e-?transfer received|payment (?:is )?done|has paid|payment confirmed|client paid/i;
const NEGATED_BEFORE = /\b(?:no|not|never|awaiting|waiting|pending|yet|without)\b/i;
// A note a person typed (the app's notes all open with a symbol; the cockpit
// prefixes "[Name]").
const STAFF_NOTE_START = /^[\s"'(\[]*[A-Za-z0-9@]/;

const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => s(v).toLowerCase().replace(/\s+/g, ' ');
const tms = (iso) => { const t = Date.parse(s(iso)); return Number.isFinite(t) ? t : 0; };
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
const oneLine = (t, max = 140) => { const x = s(t).replace(/\s+/g, ' '); return x.length > max ? `${x.slice(0, max - 1).trimEnd()}…` : x; };
// "12 Sep" (with the year when it is not this year).
const dateWord = (ms) => {
  if (!ms) return '';
  const full = torontoTime(ms).replace(/,.*$/, '');                 // "12 Sep 2026"
  return full.endsWith(` ${new Date(io.now()).getUTCFullYear()}`) ? full.replace(/ \d{4}$/, '') : full;
};
const keyOf = (fingerprint) => `NA-${crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 10)}`;
const isClosed = (c) => CLOSED_STAGES.includes(c.stage);
const isTestCase = (c) => inGroups(c, NOT_CASE_GROUPS) || /\btest client\b|\be2e\b/i.test(c.name);
const isLegacy = (c) => inGroups(c, LEGACY_GROUPS);
const isPaid = (c) => c.payment === 'Paid';

/** The case's notes, newest first: [{ id, at, text }] (the imported lead history left out). */
function caseNotes(updates) {
  return (updates || [])
    .map((u) => ({ id: s(u.id), at: tms(u.created_at), text: s(u.text_body) }))
    .filter((n) => n.text && !NOTE.importedHistory.test(n.text))
    .sort((a, b) => b.at - a.at);
}
/** The newest note matching `re`, or null. */
const newest = (notes, re) => notes.find((n) => re.test(n.text)) || null;
/** Is there a note matching `re` posted after `ms`? */
const after = (notes, re, ms) => notes.some((n) => n.at > ms && re.test(n.text));

/** The newest staff note saying the payment came in, or null. */
function newestPaymentNote(notes) {
  for (const n of notes) {
    if (!STAFF_NOTE_START.test(n.text)) continue;
    const m = PAID_NOTE.exec(n.text);
    if (!m) continue;
    if (NEGATED_BEFORE.test(n.text.slice(Math.max(0, m.index - 25), m.index))) continue;   // "no payment received yet"
    return n;
  }
  return null;
}

/** "client signature and RCIC countersignature" from a hold note. */
function heldFor(text) {
  const m = /missing:?\s+(.+?)\.(?:\s|$)/i.exec(s(text));
  return m ? m[1].trim() : '';
}

function todoForHold(missing) {
  const m = s(missing).toLowerCase();
  const steps = [];
  if (/client signature/.test(m)) steps.push('remind the client to sign the retainer agreement');
  if (/countersign/.test(m)) steps.push('the consultant countersigns it (Consultations page → open the client → Sign retainer as consultant)');
  if (!steps.length) return 'Onboarding starts by itself once the agreement is fully signed and paid. If it already is, tell an admin.';
  const joined = steps.join(', and ');
  return `${joined[0].toUpperCase()}${joined.slice(1)}. Onboarding then starts by itself.`;
}

function todoForActionReport(text) {
  const t = s(text);
  if (/the Case Stage is/i.test(t)) return 'Set the Case Stage to Document Collection Started — the intake email, checklist and questionnaire then start by themselves.';
  if (/no Case Reference/i.test(t)) return 'Set the Primary Case Type — the case number is given and onboarding then starts by itself.';
  if (/no Client Email/i.test(t)) return "Add the client's email on the case — onboarding then starts by itself.";
  if (/switched off/i.test(t)) return 'Set the Case Stage to Pre-Onboarding and then back to Document Collection Started. Please don\'t switch the Payment Status off and on.';
  return 'Read the app\'s note on the case in Monday, or tell an admin.';
}

/**
 * PURE — every problem on the board, before "handled" notes are applied.
 *
 * @param {object}   p
 * @param {object[]} p.cases         parsed Cases rows (see parseCase)
 * @param {Map<string, boolean|null>} p.checklist  case ref → has rows on the Documents board (null = could not check)
 * @param {object[]|null} p.folders  every folder under "Client Documents" ({ id, name, childCount, createdAt }); null = not checked
 * @param {Map<string, boolean|null>} [p.workFolders]  case ref → the four working folders are there (null = could not check)
 * @param {Map<string, number|null>} [p.checklistNewest]  case ref → when its newest checklist row was made (asked only
 *   for a re-seed failure on a case that has rows)
 * @param {number}   p.now
 * @returns {object[]} entries { key, kind, itemIds, caseRef, client, stage, payment, manager, rows, since, why, todo }
 *   rows = [{ id, name, manager, assignees }] — who may see the item is decided per row (see view)
 */
/** A live case whose sub type says the family comes along — the board must show a spouse or child. */
// Before Document Collection the checklist and questionnaire do not exist yet
// (the lead bridge and the retainer panel still have their turn).
const BEFORE_CHECKLIST = ['', 'Not Started', 'Pre-Onboarding', 'Retainer Confirmed'];
function needsFamilyCheck(c) {
  return !!c.ref && !isTestCase(c) && !isClosed(c) && !isLegacy(c) && isPaid(c) && !BEFORE_CHECKLIST.includes(c.stage) && saysAccompanying(c.subType);
}

function detect({ cases, checklist = new Map(), folders = null, workFolders = new Map(), checklistNewest = new Map(), family = new Map(), checklistFamily = new Map(), manifestFamily = new Map(), now }) {
  const out = [];
  const live = cases.filter((c) => !isTestCase(c));
  const add = (kind, rowsIn, fingerprint, { since = 0, why, todo }) => {
    const list = [].concat(rowsIn);
    out.push({
      key: keyOf(`${kind}|${fingerprint}`), kind,
      itemIds: list.map((r) => r.id),
      caseRef: list[0].ref, client: list.map((r) => r.name).filter(Boolean).join(' / '),
      stage: list[0].stage, payment: list[0].payment,
      manager: [...new Set(list.map((r) => r.manager).filter(Boolean))].join(', '),
      rows: list.map((r) => ({ id: r.id, name: r.name, manager: r.manager, stage: r.stage, payment: r.payment, created: r.created, assignees: r.assignees })),
      since: iso(since), why, todo,
    });
  };

  // ── 1. Case numbers ──────────────────────────────────────────────────────
  const byRef = new Map();
  for (const c of live) if (c.ref) { const k = c.ref.toUpperCase(); if (!byRef.has(k)) byRef.set(k, []); byRef.get(k).push(c); }
  for (const rows of byRef.values()) {
    if (rows.length < 2) continue;
    const sorted = rows.slice().sort((a, b) => a.created - b.created);
    add('ref-duplicate', sorted, `${sorted[0].ref}|${sorted.map((r) => r.id).sort().join(',')}`, {
      since: sorted[sorted.length - 1].created,
      why: `Case number ${sorted[0].ref} is on ${rows.length} cases: ${sorted.map((r) => `"${r.name}" (added ${dateWord(r.created)})`).join(', ')}. The portal and the case folder can mix them up.`,
      todo: 'Tell an admin — the admin gives one of them a new case number.',
    });
  }
  for (const c of live) {
    if (c.ref || isClosed(c) || isLegacy(c)) continue;
    const age = now - c.created;
    if (c.caseType ? age < GRACE_NEW_CASE_MS : age < GRACE_NO_TYPE_MS) continue;
    add('ref-missing', c, c.id, c.caseType ? {
      since: c.created,
      why: `The Primary Case Type is "${c.caseType}", but no case number was given.`,
      todo: 'Clear the Primary Case Type and select it again — the number is then given automatically. If it stays blank, tell an admin.',
    } : {
      since: c.created,
      why: 'No Primary Case Type is set, so the case has no case number (and no portal or folder yet).',
      todo: 'Set the Primary Case Type on the Cases board — the case number is then created automatically.',
    });
  }

  // ── 1b. Accompanying family not on the board ─────────────────────────────
  for (const c of live) {
    // Only once the family matters: a paid case (the checklist and questionnaire
    // are built at Document Collection); the lead bridge and the retainer
    // panel have until then. Grace from the paid day, like "no checklist".
    if (!needsFamilyCheck(c) || !isPaid(c)) continue;
    if (c.paidDate ? now - c.paidDate < GRACE_PAID_DAY_MS : now - c.created < GRACE_SETUP_MS) continue;
    const types = family.get(c.ref);
    if (!(types instanceof Set)) continue;                         // not read (an outage) — no claim
    if (ACCOMPANYING_TYPES.some((t) => types.has(t))) continue;
    // the checklist (an old Template-board checklist lists spouse/child rows
    // whatever the board says); unread → no claim
    const clTypes = checklistFamily.get(c.ref);
    if (!(clTypes instanceof Set)) continue;
    const mTypes = manifestFamily.get(c.ref);                      // the questionnaire's member types; not a Set = unread
    const qHasFamily = mTypes instanceof Set && [...mTypes].some(isAccompanyingType);
    if ([...clTypes].some(isAccompanyingType)) {
      // …then it is the questionnaire list that decides: with no spouse/child
      // section there, the client's page shows neither their questions nor
      // their document rows (the document list follows the questionnaire list)
      if (!(mTypes instanceof Set)) continue;                    // unread → no claim
      if (qHasFamily) continue;
      // its own key: a "handled" note on the other wording never hides this one
      add('family-missing', c, `${c.id}|${norm(c.subType)}|unseen`, {
        since: c.paidDate || c.created,
        why: `The Case Sub Type is "${c.subType}" and the document checklist lists spouse/child documents, but neither the Family Members board nor the questionnaire has a spouse or child — so the client sees neither the family's questions nor their documents.`,
        todo: 'On the case page, use "➕ Add family member" (Family card) for each accompanying spouse or child — it adds the questionnaire section; the documents already on the checklist then show to the client (the checklist is left as it is). If the client is in fact applying alone, correct the Case Sub Type.',
      });
      continue;
    }
    add('family-missing', c, `${c.id}|${norm(c.subType)}`, {
      since: c.paidDate || c.created,
      why: qHasFamily
        ? `The Case Sub Type is "${c.subType}" and the questionnaire has a spouse/child section, but the Family Members board and the document checklist have no spouse or child — so the client answers the family's questions but sees none of their documents.`
        : `The Case Sub Type is "${c.subType}" — the family comes along — but the Family Members board has no spouse or child for this case, so ${mTypes instanceof Set ? 'the questionnaire and the document checklist cover' : 'the document checklist covers'} the main applicant only.`,
      todo: qHasFamily
        ? 'On the case page, use "➕ Add family member" (Family card) for each spouse or child the questionnaire already has — it matches their section and adds their document rows. If the client is in fact applying alone, correct the Case Sub Type and then flip Re-seed Checklist → Run so the document list matches it.'
        : 'On the case page, use "➕ Add family member" (Family card) for each accompanying spouse or child — it adds the questionnaire section and the document rows. If the client is in fact applying alone, correct the Case Sub Type and then flip Re-seed Checklist → Run so the document list matches it.',
    });
  }

  // ── 2. Folders ───────────────────────────────────────────────────────────
  if (folders) {
    const refRows = new Map();
    for (const c of live) if (c.ref && !refRows.has(c.ref)) refRows.set(c.ref, live.filter((x) => x.ref === c.ref));
    const foldersOf = new Map();
    for (const f of folders) {
      const m = / - ([^ ]+)$/.exec(s(f.name));
      if (!m || !refRows.has(m[1])) continue;
      if (!foldersOf.has(m[1])) foldersOf.set(m[1], []);
      foldersOf.get(m[1]).push(f);
    }
    for (const [ref, list] of foldersOf) {
      const rows = refRows.get(ref);
      const looksTest = (f) => /\btest\b|\be2e\b|^zz/i.test(s(f.name).slice(0, -(ref.length + 3)));
      const tests = list.filter(looksTest);
      const describe = (f) => `"${f.name}" (${Number(f.childCount) || 0} item${Number(f.childCount) === 1 ? '' : 's'})`;
      if (tests.length) {
        add('folder-test', rows, `${ref}|${tests.map((f) => f.id).sort().join(',')}`, {
          since: Math.max(...tests.map((f) => tms(f.createdAt))),
          why: `${tests.length === 1 ? 'The OneDrive folder' : 'The OneDrive folders'} ${tests.map(describe).join(' and ')} ${tests.length === 1 ? 'looks' : 'look'} like a leftover test folder but ${tests.length === 1 ? 'ends' : 'end'} with this case's number, so the client's files could be saved there.`,
          todo: 'Tell an admin — the admin renames the test folder. The app then makes the client\'s own folder when it is needed.',
        });
      } else if (list.length > 1 && rows.some((r) => !isClosed(r))) {
        add('folder-split', rows, `${ref}|${list.map((f) => f.id).sort().join(',')}`, {
          since: Math.max(...list.map((f) => tms(f.createdAt))),
          why: `${list.length} OneDrive folders end with ${ref}: ${list.map(describe).join(', ')}. The client's files can end up split between them.`,
          todo: 'Ask an admin to merge them into one folder.',
        });
      }
    }
  }

  // ── 3–6. Per case: payment, checklist, onboarding, the app's warnings ────
  for (const c of live) {
    if (isClosed(c)) {
      // A flagged payment still matters on a finished case.
      paymentFlag(c);
      continue;
    }
    const notes = c.notes;
    const rows = c.ref ? checklist.get(c.ref) : undefined;   // true / false / null (unknown) / undefined (not asked)

    // 3. A staff note says the client paid, but Payment Status says otherwise.
    if (!isLegacy(c) && BEFORE_DOCS.includes(c.stage) && !isPaid(c) && c.payment !== 'Pro Bono') {
      const n = newestPaymentNote(notes);
      if (n) {
        add('payment-noted', c, `${c.id}|${n.id}`, {
          since: n.at,
          why: `A note on ${dateWord(n.at)} says "${oneLine(n.text, 90)}", but Payment Status is "${c.payment || 'blank'}".`,
          todo: 'If the client has paid, set Payment Status to Paid — the document checklist and the client\'s "Your case is ready" email then start by themselves. If not, mark this handled.',
        });
      }
    }

    // 4. The document checklist (one item per case at most).
    if (rows === false) checklistProblem(c, notes);

    // 5. The client's intake email.
    const unconf = newest(notes, NOTE.unconfirmed);
    if (unconf && !after(notes, NOTE.intakeSent, unconf.at) && !after(notes, NOTE.intakeFailed, unconf.at)) {
      add('intake-email', c, `${c.id}|${unconf.id}`, {
        since: unconf.at,
        why: `Onboarding was started automatically on ${dateWord(unconf.at)}, but there is no record that the "Your case is ready" email went out.`,
        todo: 'If the client never received it, use Resend portal access on the case page. If the document checklist is missing, flip Re-seed Checklist → Run.',
      });
    }
    const failed = newest(notes, NOTE.intakeFailed);
    if (failed && !after(notes, NOTE.intakeSent, failed.at)) {
      add('intake-email', c, `${c.id}|${failed.id}`, {
        since: failed.at,
        why: `The client's "Your case is ready" email did not go out on ${dateWord(failed.at)}.`,
        todo: 'Use Resend portal access on the case page to send the client their link.',
      });
    }

    // 6. Sponsor email.
    const sp = newest(notes, NOTE.sponsorNotSent);
    if (sp && now - sp.at >= GRACE_RETRY_MS && !after(notes, NOTE.sponsorSent, sp.at)) {
      add('sponsor-email', c, `${c.id}|${sp.id}`, {
        since: sp.at,
        why: `The sponsor's portal email was not sent on ${dateWord(sp.at)}: "${oneLine(sp.text.replace(/^\W+/, ''), 110)}"`,
        todo: 'Open the case page → Sponsor / inviter card → add the sponsor\'s email if it is missing, then press Send sponsor link.',
      });
    }

    paymentFlag(c);

    // 7. Stage gates waiting for someone to be assigned.
    const ri = newest(notes, NOTE.readyInternal);
    if (ri && !c.managerSet) {
      add('assign', c, `${c.id}|internal|${ri.id}`, {
        since: ri.at,
        why: `Ready for internal review since ${dateWord(ri.at)}, but no Case Manager is assigned.`,
        todo: 'The Ops Supervisor assigns a Case Manager on the Cases board.',
      });
    }
    const rs = newest(notes, NOTE.readySubmission);
    if (rs && !c.submissionSet) {
      add('assign', c, `${c.id}|submission|${rs.id}`, {
        since: rs.at,
        why: `Ready for submission preparation since ${dateWord(rs.at)}, but no Submission Team is assigned.`,
        todo: 'The Ops Supervisor assigns the Submission Team on the Cases board.',
      });
    }

    // 8. Other app warnings nothing has answered.
    // Settled only by a LATER checklist run under a DIFFERENT Sub Type: the same
    // run's own success note follows this warning within seconds, and a re-run
    // under the same Sub Type adds nothing (so it posts no new warning either).
    const fam = newest(notes, NOTE.familyNotCovered);
    const famSubRaw = fam ? (/current Case Sub Type\s*"([^"]*)"/i.exec(fam.text) || [])[1] : undefined;
    const famSub = famSubRaw === '(none)' ? '' : famSubRaw;          // a case type with no Sub Types
    const famSettled = fam && famSub !== undefined && norm(c.subType) !== norm(famSub)
      && after(notes, NOTE.checklistOk, fam.at + SAME_RUN_MS);
    if (fam && !famSettled) {
      other(c, fam, 'Some family members on the Family Members board have no documents on this case\'s checklist (the Case Sub Type has no role for them).',
        'If they are accompanying this application, change the Case Sub Type to the accompanying variant and flip Re-seed Checklist → Run.');
    }
    const rf = newest(notes, NOTE.reseedFailed);
    const builtSince = rf && (checklistNewest.get(c.ref) || 0) > rf.at;   // the normal DCS build posts no note
    if (rf && rows !== false && !builtSince && !after(notes, NOTE.checklistOk, rf.at)) {
      other(c, rf, `A checklist re-seed failed on ${dateWord(rf.at)}: "${oneLine(rf.text.replace(/^\W+/, ''), 110)}"`,
        'Fix what the note names, then flip Re-seed Checklist → Run again. If it keeps failing, tell an admin.');
    }
    const wf = newest(notes, NOTE.workFoldersFailed);
    if (wf && c.ref && workFolders.get(c.ref) !== true) {
      other(c, wf, `The four staff working folders could not be made in this client's OneDrive folder (${dateWord(wf.at)}).`,
        'Add them by hand (1-Coordinator-Working, 2-Case-Manager-Draft, 3-AW-Analyst-Final-RCIC, 4-Submitted-IRCC), or tell an admin.');
    }
    const rn = newest(notes, NOTE.renameFailed);
    if (rn && !after(notes, NOTE.filesMoved, rn.at)) {
      other(c, rn, `The client's OneDrive intake folder could not be renamed to its case number (${dateWord(rn.at)}), so early documents may sit in a folder named "… - LEAD-…".`,
        'Move those documents into the case folder by hand, or tell an admin.');
    }
    const lastMerge = newest(notes, NOTE.filesMoved);           // a later clean "finish" run settles it
    const nc = lastMerge && NOTE.filesNotCopied.test(lastMerge.text) ? lastMerge : null;
    if (nc) {
      other(c, nc, `Some files could not be moved into this client's own folder (${dateWord(nc.at)}); they are still only in the old folder.`,
        'Tell an admin — the note on the case lists the files.');
    }
    const ru = newest(notes, NOTE.recordUnreachable);
    if (ru) {
      other(c, ru, `When this case got its number (${dateWord(ru.at)}), the record of numbers already used could not be saved.`,
        'Tell an admin, so they can check the record of case numbers.');
    }
    const au = newest(notes, NOTE.assignedUnchecked);
    if (au && !folders) {
      other(c, au, `The case number was given while OneDrive could not be checked (${dateWord(au.at)}).`,
        'Tell an admin, so they can check no other client\'s folder ends with this number.');
    }
  }

  return out;

  function paymentFlag(c) {
    const pf = newest(c.notes, NOTE.paymentFlagged);
    if (pf && !after(c.notes, NOTE.paymentRemoved, pf.at)) {
      add('payment-flag', c, `${c.id}|${pf.id}`, {
        since: pf.at,
        why: `A payment on this case was flagged as recorded in error on ${dateWord(pf.at)}.`,
        todo: 'An admin checks the payment and uses Undo on the payment row if it is wrong.',
      });
    }
    const ua = newest(c.notes, NOTE.undoAlarm);
    if (ua && !after(c.notes, NOTE.paymentRemoved, ua.at)) {
      add('payment-flag', c, `${c.id}|${ua.id}`, {
        since: ua.at,
        why: `A payment undo did not finish cleanly on ${dateWord(ua.at)}: "${oneLine(ua.text.replace(/^\W+/, ''), 110)}"`,
        todo: 'An admin checks the client\'s Retainer Paid date and payment row now.',
      });
    }
  }

  function other(c, n, why, todo) {
    add('other-warning', c, `${c.id}|${n.id}`, { since: n.at, why, todo });
  }

  /** The case has no document checklist: say why, once. */
  function checklistProblem(c, notes) {
    const family = [NOTE.hold, NOTE.started, NOTE.finalReport, NOTE.actionReport, NOTE.subtypeMissing, NOTE.subtypeWrong,
      NOTE.seedFailed, NOTE.reseedFailed, NOTE.stateUnreadable, NOTE.paymentUnverified, NOTE.checklistOk, NOTE.paidPastDocs];
    let latest = notes.find((n) => family.some((re) => re.test(n.text))) || null;
    // A re-seed that failed for want of a usable Sub Type ("No code schema
    // registered"): the Sub Type note still says what to do (and keeps its key).
    // Any other failure is a new problem with its own item.
    if (latest && NOTE.reseedFailed.test(latest.text) && /No code schema registered/i.test(latest.text)) {
      const sub = notes.find((n) => n.at <= latest.at && (NOTE.subtypeMissing.test(n.text) || NOTE.subtypeWrong.test(n.text)));
      if (sub && !after(notes, NOTE.checklistOk, sub.at)) latest = sub;
    }
    const t = latest ? latest.text : '';
    const fp = (tag) => `${c.id}|${tag}|${latest ? latest.id : ''}`;

    if (latest && NOTE.paidPastDocs.test(t)) {
      // Marked Paid after staff moved the case past Document Collection: the
      // app never onboarded it (by design — it is staff's), and it has no checklist.
      if (!isPaid(c)) return;
      add('no-checklist', c, fp('paid-past-docs'), {
        since: latest.at,
        why: `Marked Paid on ${dateWord(latest.at)} while the case was already at "${c.stage}" — the app did not start onboarding, and the case has no document checklist.`,
        todo: 'If the agreement is fully signed and the client still has documents to send, flip Re-seed Checklist → Run, and use Resend portal access on the case page if they never got "Your case is ready". Otherwise mark this handled.',
      });
      return;
    }
    if (latest && NOTE.hold.test(t)) {
      if (!isPaid(c)) return;                                  // no longer paid: nothing waits on signatures
      const missing = heldFor(t) || 'the signatures';
      add('on-hold', c, fp('hold'), BEFORE_DOCS.includes(c.stage) ? {
        since: latest.at,
        why: `Marked Paid, but onboarding has been on hold since ${dateWord(latest.at)}, waiting for: ${missing}.`,
        todo: todoForHold(missing),
      } : {
        // Staff moved the case on by hand; the app never restarts onboarding from here.
        since: latest.at,
        why: `Onboarding was put on hold on ${dateWord(latest.at)} (waiting for: ${missing}), and the case has since moved on to "${c.stage}" without it — there is no document checklist.`,
        todo: 'If the agreement is fully signed now and the client still has documents to send, flip Re-seed Checklist → Run, and use Resend portal access on the case page if they never got "Your case is ready". Otherwise mark this handled.',
      });
      return;
    }
    if (latest && (NOTE.subtypeMissing.test(t) || NOTE.subtypeWrong.test(t))) {
      // Worded from the case as it is NOW: staff may have set the Sub Type since
      // (it builds by itself only at Document Collection Started).
      const quoted = NOTE.subtypeWrong.test(t) ? s((/[“"]([^”"]+)[”"] is not a Sub Type of|selected \([“"]([^”"]+)[”"]\)/.exec(t) || []).slice(1).find(Boolean)) : '';
      const fixedSince = c.subType && (NOTE.subtypeMissing.test(t) || (quoted && norm(quoted) !== norm(c.subType)));
      add('subtype', c, fp('subtype'), fixedSince ? {
        since: latest.at,
        why: `The Case Sub Type is now "${c.subType}", but the document checklist has not been built.`,
        todo: 'Flip Re-seed Checklist → Run on this case. If it fails, tell an admin.',
      } : {
        since: latest.at,
        why: !c.subType
          ? `The Case Sub Type is blank, and ${c.caseType || 'this case type'} has more than one checklist, so the document checklist was not made.`
          : `The Case Sub Type "${c.subType}" does not fit ${c.caseType || 'this case type'}, so the document checklist was not made.`,
        todo: 'Set the correct Case Sub Type on this case. At Document Collection Started the checklist then builds by itself; otherwise flip Re-seed Checklist → Run.',
      });
      return;
    }
    if (latest && (NOTE.seedFailed.test(t) || NOTE.reseedFailed.test(t))) {
      add('no-checklist', c, fp('seed'), {
        since: latest.at,
        why: `Making the document checklist failed on ${dateWord(latest.at)}.`,
        todo: 'Flip Re-seed Checklist → Run on this case. If it fails again, tell an admin.',
      });
      return;
    }
    if (latest && NOTE.actionReport.test(t)) {
      add('not-started', c, fp('action'), {
        since: latest.at,
        why: `The app could not start onboarding on ${dateWord(latest.at)}: "${oneLine(t.replace(/^[\s\S]*?automatically\W*/i, ''), 110)}"`,
        todo: todoForActionReport(t),
      });
      return;
    }
    if (latest && NOTE.started.test(t) && now - latest.at < GRACE_SETUP_MS) return;   // being built right now
    const recentlyPaid = (c.paidDate && now - c.paidDate < GRACE_PAID_DAY_MS) || now - c.created < GRACE_SETUP_MS;
    const explained = latest && (NOTE.finalReport.test(t) || NOTE.stateUnreadable.test(t) || NOTE.paymentUnverified.test(t) || NOTE.started.test(t));
    if (isPaid(c) && BEFORE_DOCS.includes(c.stage) && !recentlyPaid && !isLegacy(c)) {
      add('no-checklist', c, fp('paid'), {
        since: c.paidDate || c.created,
        why: `Payment Status is Paid and the stage is ${c.stage ? `"${c.stage}"` : 'blank'}, but the case has no document checklist${explained ? ` (the app noted on ${dateWord(latest.at)}: "${oneLine(t.replace(/^\W+/, ''), 90)}")` : ''}.`,
        todo: c.stage === DCS
          ? 'Flip Re-seed Checklist → Run to build the checklist, and check the client received "Your case is ready" (Resend portal access on the case page).'
          : 'Set the Case Stage to Document Collection Started — the intake email, checklist and questionnaire then start by themselves.',
      });
      return;
    }
    if (explained && NOTE.finalReport.test(t)) {
      add('no-checklist', c, fp('final'), {
        since: latest.at,
        why: `The app did not restart onboarding on ${dateWord(latest.at)} and the case has no document checklist: "${oneLine(t.replace(/^[\s\S]*?automatically\W*/i, ''), 110)}"`,
        todo: 'If the client needs to upload documents, flip Re-seed Checklist → Run, and use Resend portal access on the case page if they never got "Your case is ready".',
      });
    }
  }
}

/** Which refs need a Documents-board check (the rest are never asked). */
function refsNeedingChecklist(cases) {
  const family = [NOTE.hold, NOTE.finalReport, NOTE.actionReport, NOTE.subtypeMissing, NOTE.subtypeWrong,
    NOTE.seedFailed, NOTE.reseedFailed, NOTE.stateUnreadable, NOTE.paymentUnverified, NOTE.started, NOTE.paidPastDocs];
  const refs = new Set();
  for (const c of cases) {
    if (!c.ref || isTestCase(c) || isClosed(c)) continue;
    if ((isPaid(c) && BEFORE_DOCS.includes(c.stage) && !isLegacy(c)) || c.notes.some((n) => family.some((re) => re.test(n.text)))) refs.add(c.ref);
  }
  return [...refs];
}

/** Which refs need their working folders checked (a "could not create" note), with the one folder each. */
function refsNeedingWorkFolders(cases, folders) {
  if (!folders) return [];
  const out = [];
  for (const c of cases) {
    if (!c.ref || isTestCase(c) || isClosed(c) || !c.notes.some((n) => NOTE.workFoldersFailed.test(n.text))) continue;
    const hits = folders.filter((f) => s(f.name).endsWith(` - ${c.ref}`));
    if (hits.length === 1 && !out.some((x) => x.ref === c.ref)) out.push({ ref: c.ref, folderId: hits[0].id });
  }
  return out;
}

/** "handled" notes on a case → the item keys they cover. */
function handledKeys(notes) {
  const keys = new Set();
  for (const n of notes) { const m = NOTE.handled.exec(n.text); if (m) keys.add(m[1]); }
  return keys;
}

/** One Cases-board item from Monday → the fields the rules read. */
function parseCase(item) {
  const cv = {}, raw = {};
  for (const c of item.column_values || []) { cv[c.id] = s(c.text); raw[c.id] = c.value; }
  const paid = cv[COL.paidDate] ? tms(`${cv[COL.paidDate].slice(0, 10)}T12:00:00Z`) : 0;
  return {
    id: s(item.id), name: s(item.name), groupId: s(item.group && item.group.id), groupTitle: s(item.group && item.group.title),
    created: tms(item.created_at),
    ref: cv[COL.ref], caseType: cv[COL.caseType], subType: cv[COL.subType],
    stage: cv[COL.stage], payment: cv[COL.payment], paidDate: paid,
    manager: cv[COL.manager], managerSet: !!cv[COL.manager], submissionSet: !!cv[COL.submissionTeam],
    assignees: caseAccess.assigneesFromColumnValues(raw),
    notes: caseNotes(item.updates),
    notesFull: (item.updates || []).length >= NOTES_LIMIT,     // the window may hide older notes
  };
}

// ─── I/O (one seam, so tests never reach Monday or OneDrive) ─────────────────
const io = {
  now: () => Date.now(),
  async readCases() {
    const ITEMS = `cursor items{ id name created_at group{ id title } column_values(ids:${JSON.stringify(FETCH_COLS)}){ id text value } updates(limit:${NOTES_LIMIT}){ id created_at text_body } }`;
    const all = []; let cursor = null; let pages = 0;
    do {
      const d = cursor
        ? await mondayApi.query(`query($c:String!){ boards(ids:["${clientMasterBoardId}"]){ items_page(limit:25, cursor:$c){ ${ITEMS} } } }`, { c: cursor })
        : await mondayApi.query(`{ boards(ids:["${clientMasterBoardId}"]){ items_page(limit:25){ ${ITEMS} } } }`);
      const page = d && d.boards && d.boards[0] && d.boards[0].items_page;
      if (!page) throw new Error('the Cases board could not be read');
      all.push(...(page.items || []));
      cursor = page.cursor || null;
      if (++pages > 200) throw new Error('the Cases board listing did not end');
    } while (cursor);
    return all;
  },
  /** Up to DEEP_NOTES_LIMIT notes per case, 10 cases a query; a failed batch costs only its own cases. */
  async readDeepNotes(itemIds) {
    const notes = new Map(), failed = [];
    for (let i = 0; i < itemIds.length; i += 10) {
      const ids = itemIds.slice(i, i + 10);
      try {
        const d = await mondayApi.query(`query($ids:[ID!]){ items(ids:$ids, limit:${ids.length}){ id updates(limit:${DEEP_NOTES_LIMIT}){ id created_at text_body } } }`, { ids });
        for (const it of (d && d.items) || []) notes.set(s(it.id), it.updates || []);
      } catch (_) { failed.push(...ids); }
    }
    return { notes, failed };
  },
  /** When the case's newest checklist row was made (ms), or 0 when it has none. */
  async newestChecklistRowAt(ref) {
    const d = await mondayApi.query(
      'query($b:ID!,$v:String!){ items_page_by_column_values(limit:500, board_id:$b, columns:[{column_id:"' + EXEC_REF_COL + '", column_values:[$v]}]){ items{ created_at } } }',
      { b: String(executionBoardId), v: ref });
    const rows = (d && d.items_page_by_column_values && d.items_page_by_column_values.items) || [];
    return rows.reduce((m, r) => Math.max(m, tms(r.created_at)), 0);
  },
  /** The Member Types on the Family Members board for a case (a Set; empty when none). */
  async familyTypes(ref) {
    const fm = require('../data/familyMembersBoard.json');
    const d = await mondayApi.query(
      'query($b:ID!,$v:String!){ items_page_by_column_values(limit:100, board_id:$b, columns:[{column_id:"' + fm.columns.caseReference + '", column_values:[$v]}]){ items{ column_values(ids:["' + fm.columns.memberType + '"]){ text } } } }',
      { b: String(fm.boardId), v: ref });
    const rows = (d && d.items_page_by_column_values && d.items_page_by_column_values.items) || [];
    return new Set(rows.map((r) => s(r.column_values && r.column_values[0] && r.column_values[0].text)).filter(Boolean));
  },
  /**
   * The member types on the case's questionnaire list (a Set; EMPTY when the
   * case has no list yet — the questionnaire then shows the board's members,
   * and this is only asked for a case whose board has no spouse/child). READ
   * only: never seeds or saves a list. A failed read throws.
   */
  async manifestMemberTypes(ref, clientName) {
    const members = await require('./htmlQuestionnaireService').readMembersManifest({ clientName, caseRef: ref });
    return new Set((members || []).filter((m) => m && m.key !== 'primary').map((m) => s(m.type)).filter(Boolean));
  },
  /** The member types on the case's document checklist (Applicant Type of each row) — a Set; empty when it has none. */
  async checklistMemberTypes(ref) {
    const d = await mondayApi.query(
      'query($b:ID!,$v:String!){ items_page_by_column_values(limit:500, board_id:$b, columns:[{column_id:"' + EXEC_REF_COL + '", column_values:[$v]}]){ items{ column_values(ids:["text_mm26jcv7"]){ text } } } }',
      { b: String(executionBoardId), v: ref });
    const rows = (d && d.items_page_by_column_values && d.items_page_by_column_values.items) || [];
    return new Set(rows.map((r) => s(r.column_values && r.column_values[0] && r.column_values[0].text)).filter(Boolean));
  },
  async hasChecklist(ref) {
    const d = await mondayApi.query(
      'query($b:ID!,$v:String!){ items_page_by_column_values(limit:1, board_id:$b, columns:[{column_id:"' + EXEC_REF_COL + '", column_values:[$v]}]){ items{ id } } }',
      { b: String(executionBoardId), v: ref });
    return ((d && d.items_page_by_column_values && d.items_page_by_column_values.items) || []).length > 0;
  },
  listRootFolders: () => require('./oneDriveService').listCaseFoldersInRoot(),
  async workFoldersPresent(folderId) {
    const r = await require('./oneDriveService').ensureCaseWorkFolders({ folderId, dryRun: true });   // list only
    return !(r.wouldCreate || []).length;
  },
  async postNote(itemId, body) {
    await mondayApi.query('mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }', { i: String(itemId), b: body });
  },
};

/** Run fn over items, `n` at a time; each result or the error is kept per item. */
async function eachLimited(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { ok: true, value: await fn(items[i]) }; } catch (err) { results[i] = { ok: false, error: err }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

/** Work the whole list out (no caching here). */
async function buildSnapshot() {
  const startedAt = io.now();
  const partial = [];
  const cases = (await io.readCases()).map(parseCase);

  // A live case with more notes than the first read holds: read further back,
  // so an older warning (or "handled" note) still counts.
  const deepDone = new Set();
  const deepFailed = new Set();
  const needDeep = cases.filter((c) => c.notesFull && !isTestCase(c) && !isClosed(c)).map((c) => c.id);
  if (needDeep.length) {
    const { notes: more, failed } = await io.readDeepNotes(needDeep);
    for (const c of cases) if (more.has(c.id)) { c.notes = caseNotes(more.get(c.id)); deepDone.add(c.id); }
    for (const id of failed) deepFailed.add(id);
  }

  let folders = null;
  try { folders = await io.listRootFolders(); }
  catch (err) { partial.push(`OneDrive folders could not be checked (${oneLine(err.message, 120)}).`); }

  const checklist = new Map();
  const refs = refsNeedingChecklist(cases);
  const answers = await eachLimited(refs, 4, (ref) => io.hasChecklist(ref));
  let unknown = 0;
  refs.forEach((ref, i) => { checklist.set(ref, answers[i].ok ? answers[i].value : null); if (!answers[i].ok) unknown++; });
  if (unknown) partial.push(`${unknown} case${unknown === 1 ? '' : 's'} could not be checked for a document checklist.`);

  const workFolders = new Map();
  const wfTargets = refsNeedingWorkFolders(cases, folders);
  const wfAnswers = await eachLimited(wfTargets, 3, (t) => io.workFoldersPresent(t.folderId));
  wfTargets.forEach((t, i) => workFolders.set(t.ref, wfAnswers[i].ok ? wfAnswers[i].value : null));

  // Accompanying-family sub types: who is on the Family Members board?
  const family = new Map();
  const famRefs = [...new Set(cases.filter((c) => needsFamilyCheck(c)).map((c) => c.ref))];
  const famAnswers = await eachLimited(famRefs, 4, (ref) => io.familyTypes(ref));
  let famUnknown = 0;
  famRefs.forEach((ref, i) => { family.set(ref, famAnswers[i].ok ? famAnswers[i].value : null); if (!famAnswers[i].ok) famUnknown++; });
  // …and for those with no spouse/child on the board, does the CHECKLIST have
  // them anyway? (A checklist built the old Template-board way lists every
  // member type whatever the board says — those cases are not missing family.)
  const checklistFamily = new Map();
  const noFamRefs = famRefs.filter((ref) => family.get(ref) instanceof Set && !ACCOMPANYING_TYPES.some((t) => family.get(ref).has(t)));
  const clAnswers = await eachLimited(noFamRefs, 4, (ref) => io.checklistMemberTypes(ref));
  noFamRefs.forEach((ref, i) => { checklistFamily.set(ref, clAnswers[i].ok ? clAnswers[i].value : null); if (!clAnswers[i].ok) famUnknown++; });
  // …and does the questionnaire? (it decides the wording, and whether a
  // checklist that lists the family is seen by the client at all)
  const manifestFamily = new Map();
  const mfRefs = noFamRefs.filter((ref) => checklistFamily.get(ref) instanceof Set);
  const nameOf = (ref) => { const c = cases.find((x) => x.ref === ref && !isTestCase(x)); return c ? c.name : ''; };
  const mfAnswers = await eachLimited(mfRefs, 3, (ref) => io.manifestMemberTypes(ref, nameOf(ref)));
  mfRefs.forEach((ref, i) => { manifestFamily.set(ref, mfAnswers[i].ok ? mfAnswers[i].value : null); if (!mfAnswers[i].ok) famUnknown++; });
  if (famUnknown) partial.push(`${famUnknown} case${famUnknown === 1 ? '' : 's'} could not be checked for family members.`);

  // A re-seed failure on a case that has a checklist: was the checklist built after it?
  const checklistNewest = new Map();
  const rfRefs = [...new Set(cases.filter((c) => c.ref && !isTestCase(c) && !isClosed(c) && checklist.get(c.ref) === true && (() => {
    const rf = newest(c.notes, NOTE.reseedFailed);
    return rf && !after(c.notes, NOTE.checklistOk, rf.at);
  })()).map((c) => c.ref))];
  const rfAnswers = await eachLimited(rfRefs, 3, (ref) => io.newestChecklistRowAt(ref));
  rfRefs.forEach((ref, i) => checklistNewest.set(ref, rfAnswers[i].ok ? rfAnswers[i].value : null));

  const entries = detect({ cases, checklist, folders, workFolders, checklistNewest, family, checklistFamily, manifestFamily, now: io.now() });

  // "Handled" notes: from the notes read, plus a deeper read for an item on a
  // case whose notes were not read far back yet (an older handled note must count).
  const handled = new Set();
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const c of cases) for (const k of handledKeys(c.notes)) handled.add(k);
  const deep = [...new Set(entries.filter((e) => !handled.has(e.key)).flatMap((e) => e.itemIds))]
    .filter((id) => byId.get(id) && byId.get(id).notesFull && !deepDone.has(id));
  if (deep.length) {
    const { notes: more, failed } = await io.readDeepNotes(deep);
    for (const [id, ups] of more) { deepFailed.delete(id); for (const k of handledKeys(caseNotes(ups))) handled.add(k); }
    for (const id of failed) deepFailed.add(id);
  }
  const nf = deepFailed.size;
  if (nf) partial.push(`Older notes on ${nf} case${nf === 1 ? '' : 's'} could not be read, so an older warning may be missing, or an item marked handled long ago may show again.`);

  const finishedAt = io.now();
  return {
    startedAt: iso(startedAt), checkedAt: iso(finishedAt), tookMs: finishedAt - startedAt,
    casesChecked: cases.filter((c) => !isTestCase(c)).length,
    entries: entries.filter((e) => !handled.has(e.key)),
    handledCount: entries.filter((e) => handled.has(e.key)).length,
    partial,
  };
}

// ─── The snapshot ────────────────────────────────────────────────────────────
let _snap = null;                 // the last good list
let _running = null;              // the check in progress (one at a time)
let _lastStart = 0;
let _lastError = null;            // { at, message } of the last failed check
const _handledHere = new Map();   // key → ms marked by this process (until a newer check has read the note)
const _marking = new Set();       // keys being marked right now
const REFRESH_GAP_MS = 2 * 60 * 1000;            // between checks
const RETRY_GAP_MS = 20 * 1000;                  // after a check that FAILED
/** How long until another check may start (0 = now). */
function waitMs() {
  if (!_lastStart) return 0;
  return Math.max(0, (_lastError ? RETRY_GAP_MS : REFRESH_GAP_MS) - (io.now() - _lastStart));
}

/** Start a check (or join the one running). Resolves to the new snapshot; rejects if it failed. */
function refresh({ reason = '' } = {}) {
  if (_running) return _running;
  _lastStart = io.now();
  const started = _lastStart;
  _running = (async () => {
    try {
      const snap = await buildSnapshot();
      _snap = snap;
      _lastError = null;
      for (const [k, at] of _handledHere) if (at < started) _handledHere.delete(k);   // the new check read that note
      console.log(`[NeedsAttention] ${reason || 'check'}: ${snap.entries.length} item(s) across ${snap.casesChecked} case(s) in ${Math.round(snap.tookMs / 1000)}s${snap.partial.length ? ` — ${snap.partial.join(' ')}` : ''}`);
      return snap;
    } catch (err) {
      _lastError = { at: iso(io.now()), message: oneLine(err.message, 200) };
      console.error(`[NeedsAttention] ${reason || 'check'} failed:`, err.message);
      throw err;
    } finally {
      _running = null;
    }
  })();
  return _running;
}

/** Start a check in the background, never throwing. */
function kick(reason) { refresh({ reason }).catch(() => {}); }

/** The rows of an item this viewer may see (the Cases page's rule, per case row). */
function visibleRows(entry, viewer) {
  if (!viewer) return [];
  if (viewer.isAdmin || viewer.scope === 'all') return entry.rows;
  return entry.rows.filter((r) => caseAccess.viewerCanSee(r.assignees, viewer));
}

/**
 * The item as this viewer may see it, or null. An item spanning several cases
 * (one number on two cases, a folder) shown to someone who may see only some of
 * them names only those — never the other client.
 */
function shapeFor(entry, viewer) {
  const rows = visibleRows(entry, viewer);
  if (!rows.length) return null;
  const { rows: _all, ...out } = entry;
  if (rows.length === entry.rows.length) return out;
  return {
    ...out,
    itemIds: rows.map((r) => r.id),
    client: rows.map((r) => r.name).filter(Boolean).join(' / '),
    manager: [...new Set(rows.map((r) => r.manager).filter(Boolean))].join(', '),
    stage: rows[0].stage, payment: rows[0].payment,
    since: entry.kind === 'ref-duplicate' ? iso(Math.max(...rows.map((r) => r.created || 0))) : entry.since,
    why: entry.kind === 'ref-duplicate'
      ? `Case number ${entry.caseRef} is also on another case that is not assigned to you. The portal and the case folder can mix them up.`
      : `This case's OneDrive folder needs an admin's attention (it involves another case that is not assigned to you).`,
  };
}

/**
 * What the page shows this viewer. With `ensure`, a first view after a restart
 * starts the check (the page then polls).
 */
function view(viewer, { ensure = false } = {}) {
  if (ensure && !_snap && !_running && !waitMs()) kick('first view');
  const entries = _snap
    ? _snap.entries.filter((e) => !_handledHere.has(e.key)).map((e) => shapeFor(e, viewer)).filter(Boolean)
    : [];
  return {
    running: !!_running,
    checkedAt: _snap ? _snap.checkedAt : '',
    casesChecked: _snap ? _snap.casesChecked : 0,
    partial: _snap ? _snap.partial : [],
    error: _lastError,
    kinds: KINDS,
    entries,
  };
}

/**
 * "Check now". One check at a time; not again within two minutes of the last
 * one (20 seconds when the last one failed).
 */
function requestRefresh() {
  if (_running) return { started: false, running: true };
  const wait = waitMs();
  if (wait > 0) return { started: false, running: false, retryInSec: Math.ceil(wait / 1000), lastFailed: !!_lastError };
  kick('check now');
  return { started: true, running: true };
}

const escHtml = (t) => s(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The note "Mark handled" leaves on the case. Deliberately plain: it must never
 * read as one of the app's own notes (onboarding, checklist, payment, intake email)
 * — test/needsAttention.test.js checks it against every note scanner.
 */
function handledNoteBody(entry, actor) {
  const label = (KINDS[entry.kind] || {}).label || entry.kind;
  return `✔ <b>Marked as handled</b> on the Summary page by ${escHtml(actor)} — ${escHtml(torontoTime(io.now()))} (Toronto). `
    + `Item: ${escHtml(label)}${entry.caseRef ? ` (${escHtml(entry.caseRef)})` : ''}. `
    + `It stays off the "Needs attention" list unless the problem comes back. Ref ${entry.key}`;
}

/**
 * Mark an item handled: a note on the case (the lasting record), and off the
 * list straight away.
 * @returns {Promise<{ ok: true, already?: boolean }>}
 * @throws err.status 404 (not on the list / not visible), 409 (being marked), 503 (no list yet)
 */
async function markHandled({ key, viewer, actor }) {
  const fail = (status, message) => { const e = new Error(message); e.status = status; return e; };
  if (!_snap) {
    // A restart cleared the list: start working it out again (the page polls).
    if (!_running && !waitMs()) kick('mark handled after a restart');
    throw fail(503, 'The list is being worked out again after a server restart. It shows in about a minute and a half; then try again.');
  }
  const k = s(key);
  const entry = _snap.entries.find((e) => e.key === k);
  const rows = entry ? visibleRows(entry, viewer) : [];
  if (!rows.length) throw fail(404, 'This item is no longer on the list. Press Check now to see the current list.');
  if (_handledHere.has(k)) return { ok: true, already: true };
  if (_marking.has(k)) throw fail(409, 'Someone is marking this item right now.');
  _marking.add(k);
  try {
    // On a case this viewer may see (the note names only that case's item).
    await io.postNote(rows[0].id, handledNoteBody(entry, s(actor) || 'staff'));
    _handledHere.set(k, io.now());
    return { ok: true };
  } finally {
    _marking.delete(k);
  }
}

/** Is it this hour in Toronto now? (the daily check runs from an hourly tick — see scheduler.js) */
function isTorontoHour(hour, ms = io.now()) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
  return h === hour;
}

function _resetForTests() {
  _snap = null; _running = null; _lastStart = 0; _lastError = null; _handledHere.clear(); _marking.clear();
}

module.exports = {
  refresh, view, requestRefresh, markHandled, isTorontoHour,
  detect, parseCase, caseNotes, newestPaymentNote, heldFor, handledKeys, handledNoteBody,   // pure
  refsNeedingChecklist, refsNeedingWorkFolders, buildSnapshot,
  io, KINDS, NOTE, COL, CLOSED_STAGES, BEFORE_DOCS, _resetForTests,
};
