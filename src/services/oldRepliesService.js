'use strict';

/**
 * Old no-reply replies — ONE read-only follow-up list (Faran 2026-11-19, "start with #1").
 *
 * Until 19 Nov many client / lead emails went out from noreply@ (MS_FROM_EMAIL — also the OneDrive owner and the
 * shared Otter login), some with no Reply-To, so the answers landed in noreply@'s Inbox, which nobody reads. The
 * case page's Emails tab shows them per case; this is the one list of everyone who wrote there — cases AND leads —
 * so the team can follow up. GET /admin/client-mail/old-replies (named admins only, routes/clientMailRoutes.js).
 *
 * READ-ONLY: nothing is written to Outlook or Monday. What is read:
 *  1. The old inbox (MS_FROM_EMAIL, else noreply@tdotimm.com; never the office mailbox itself), EVERY page, newest
 *     first: from / sender / receivedDateTime / hasAttachments / internetMessageId / isDraft only — never a subject,
 *     never a body. Next links are followed on graph.microsoft.com only; 50 pages (5,000 emails) at most, and a cut
 *     list says so (summary.capped) — never silent. A failed page → NO list (503): never a partial one.
 *  2. Dropped: drafts; the same email twice (internet message id); an address that is not plain (caseEmailsRules
 *     .addressOk — also what keeps a KQL search safe); our own addresses and the services on emailLeadsService's
 *     skip lists; automatic senders (emailLeadsService.AUTOMATED_LOCAL: no-reply, notifications, postmaster…).
 *  3. Grouped by the lower-cased sender: how many, newest, oldest, how many with attachments.
 *  4. Who is it — two FULL board scans (items_page 500 + cursor until done — never a per-sender search, whose 25 / 50
 *     row caps would hide people): the Client Master board (config MONDAY_CLIENT_MASTER_BOARD_ID) and the Lead Board
 *     (config MONDAY_LEAD_BOARD_ID). ANY Monday failure → no list (503). Client Master rows in the groups that are not
 *     cases (utils/caseGroups: TEST, Leads, Cancel) are left out and only counted (summary.testOrCancelled). A lead's
 *     Client Master Item ID adds its live case to the row.
 *  5. Answered after? For each MATCHED sender only, the office mailbox (caseEmailsService.officeMailbox): its Sent
 *     Items $search "to:<address>" (10, newest first) → answeredFromInfoAfter 'yes' | 'no' | 'unknown' (the search
 *     failed — never a guess), and every folder's $search "from:<address>" (10) → wroteToInfoAfter (a count; null =
 *     unknown; 10 = "10 or more"). $search is never mixed with $filter / $orderby. Answers sent from a staff member's
 *     own mailbox cannot be seen — the notes say so.
 *  6. Rows: unanswered first ('no', then 'unknown', then 'yes'), then the newest old reply first. People who match no
 *     case or lead are COUNTED, never listed (they may be anyone). No row carries an email address.
 *
 * Load: at most 2 Graph calls at once per mailbox from here; a 429 / 503 / 504 waits for Retry-After once when it
 * is 5 s or less; a 401 is retried once with a fresh token (utils/graphRead). The answer checks stop starting after
 * 4 minutes (the rest read 'unknown', counted). The finished list is kept in memory 10 minutes (JSON then CSV is one
 * read); refresh reads again, at most once a minute. A failed read is never kept.
 *
 * Logs: counts and Graph status / short codes only — never an address, a name, a subject or Graph's error text.
 */

const axios = require('axios');
const mail = require('./microsoftMailService');
const emailLeads = require('./emailLeadsService');
const caseEmails = require('./caseEmailsService');
const { addressOk } = require('./caseEmailsRules');
const { errorOf, withToken, retryAfterSeconds } = require('../utils/graphRead');
const { isCaseGroup } = require('../utils/caseGroups');
const { statusText } = require('../utils/mondayStatus');
const { torontoWallClock, torontoDay } = require('../utils/torontoTime');
const { canonicalOutcome } = require('../../config/outcomes');
const LEAD_COLS = require('../data/newLeadsBoard.json').columns;

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_HOST = 'graph.microsoft.com';
const GRAPH_TIMEOUT_MS = 15000;
const MAX_IN_FLIGHT = 2;                 // per mailbox, from this service
const MAX_RETRY_WAIT_S = 5;
const INBOX_PAGE = 100;
const INBOX_MAX_PAGES = 50;              // 5,000 emails
const SEARCH_TOP = 10;
const MONDAY_PAGE = 500;
const MONDAY_MAX_PAGES = 200;            // 100,000 rows — a runaway guard; reaching it fails the call (never partial)
const CHECK_BUDGET_MS = 4 * 60 * 1000;
const CACHE_MS = 10 * 60 * 1000;
const REFRESH_MIN_MS = 60 * 1000;
const FALLBACK_OLD = 'noreply@tdotimm.com';
const INBOX_SELECT = 'from,sender,receivedDateTime,hasAttachments,internetMessageId,isDraft';
/** Client Master columns (clientMasterService CASE_REF_COL / CM_EMAIL_COL / CM_STAGE_COL). */
const CM = Object.freeze({ caseRef: 'text_mm142s49', email: 'text_mm0xw6bp', stage: 'color_mm0x8faa' });
/** Lead Board columns read: the email, the name, the Outcome, the Client Master link, and what the Current status reads. */
const LEAD_KEYS = Object.freeze(['fullName', 'email', 'outcome', 'clientMasterItemId', 'bookingStatus', 'bookingInvite', 'inviteSentAt',
  'slotHeldUntil', 'bookedSlot', 'consultationHeld', 'meetingLink', 'squareBookingId', 'consultAgreementSent', 'preConsultSubmitted',
  'squareConsultTxnId', 'consultPayment']);
const ANSWER_RANK = { no: 0, unknown: 1, yes: 2 };

const s = (v) => String(v == null ? '' : v).trim();
const low = (v) => s(v).toLowerCase();
const oneLine = (v) => s(v).replace(/\s+/g, ' ');
const enc = encodeURIComponent;
const domainOf = (a) => low(String(a || '').split('@')[1]);
const onDomain = (a, domains) => { const d = domainOf(a); return !!d && domains.some((x) => d === x || d.endsWith('.' + x)); };

/** A refusal the route passes on as it is: HTTP status + plain words (never Graph's or Monday's own text). */
const refusal = (status, error) => Object.assign(new Error(error), { publicStatus: status, publicError: error });

/* ── the side effects (tests replace them) ─────────────────────────────── */
const io = {
  token: () => mail.getAccessToken(),
  dropToken: () => mail.invalidateAccessToken(),
  get: (url, headers) => axios.get(url, { headers, timeout: GRAPH_TIMEOUT_MS }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  log: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  monday: (gql, vars) => require('./mondayApi').query(gql, vars),
  boards: () => { const c = require('../../config/monday'); return { cm: s(c.clientMasterBoardId), lead: s(c.leadBoardId) }; },
  /** The Leads list's "Current status" label (the notes copy when it is loaded; the lead's columns otherwise). */
  leadStatus: (lead, now) => { const L = require('./leadStatusService'); return s(L.leadStatus(lead, L.activityFor(lead.id), now).label); },
};

/* ── the mailboxes (fixed here, never from a request) ──────────────────── */

const officeMailbox = () => caseEmails.officeMailbox();
/** The old no-reply mailbox: MS_FROM_EMAIL, else noreply@tdotimm.com — '' when that is the office mailbox itself. */
function oldMailbox() {
  const b = low(process.env.MS_FROM_EMAIL);
  const box = addressOk(b) ? b : FALLBACK_OLD;
  return box !== officeMailbox() ? box : '';
}

/* ── Graph: at most 2 at once per mailbox; 401 → a fresh token once; 429 → Retry-After once if ≤ 5 s ── */
const _flight = new Map();
async function limited(box, fn) {
  let st = _flight.get(box);
  if (!st) { st = { n: 0, q: [] }; _flight.set(box, st); }
  if (st.n >= MAX_IN_FLIGHT) await new Promise((r) => st.q.push(r));   // the slot is handed over, never re-counted
  else st.n++;
  try { return await fn(); }
  finally { const next = st.q.shift(); if (next) next(); else st.n--; }
}
async function graphGet(box, url) {
  return limited(box, async () => {
    const once = async () => (await withToken(io, (h) => io.get(url, h))).data;
    try { return await once(); }
    catch (err) {
      const st = err && err.response && err.response.status;
      if (st === 429 || st === 503 || st === 504) {
        const wait = retryAfterSeconds(err, io.now());
        if (wait != null && wait <= MAX_RETRY_WAIT_S) { await io.sleep(wait * 1000); return once(); }
      }
      throw err;
    }
  });
}
/** A next link we follow: https on graph.microsoft.com, under /v1.0 — anything else is a failure. */
function isGraphLink(url) {
  try { const u = new URL(String(url)); return u.protocol === 'https:' && u.hostname === GRAPH_HOST && String(url).startsWith(GRAPH + '/'); }
  catch (_) { return false; }
}
const codeOf = (err) => { const e = errorOf(err); return `${e.status || 'no answer'} ${e.code}`; };

/* ── 1. the old inbox, every page ──────────────────────────────────────── */

function inboxUrl(box) {
  return `${GRAPH}/users/${enc(box)}/mailFolders/inbox/messages?$select=${INBOX_SELECT}&$top=${INBOX_PAGE}&$orderby=${enc('receivedDateTime desc')}`;
}

/** Every message of the old Inbox (no subjects, no bodies). THROWS on any failed page — never a partial list. */
async function readInbox(box) {
  const items = [];
  let url = inboxUrl(box), pages = 0;
  while (url) {
    if (!isGraphLink(url)) throw Object.assign(new Error('An unexpected next-page link.'), { response: { status: 0, data: { error: { code: 'unexpected-next-link' } } } });
    const page = await graphGet(box, url);
    if (!page || !Array.isArray(page.value)) throw Object.assign(new Error('An unexpected answer.'), { response: { status: 0, data: { error: { code: 'unexpected-answer' } } } });
    items.push(...page.value);
    pages++;
    url = page['@odata.nextLink'];
    if (url && pages >= INBOX_MAX_PAGES) return { items, capped: true, pages };
  }
  return { items, capped: false, pages };
}

/* ── 2. + 3. the skip rules and the grouping (PURE) ────────────────────── */

/**
 * Why a sender is not a person to follow up ('' = it is one). PURE.
 * @param {string} a  lower-cased address
 * @param {{ domains: string[], addresses: Set<string> }} ctx
 */
function skipKind(a, ctx) {
  if (!addressOk(a)) return 'invalid';
  if (ctx.addresses.has(a) || onDomain(a, ctx.domains)) return 'own';
  if (emailLeads.AUTOMATED_LOCAL.test(a.split('@')[0])) return 'automated';
  return '';
}

/** The "our own" lists, read at call time (emailLeadsService's, plus both mailboxes). Never the old mailbox's DOMAIN. */
function ownContext(office, old) {
  return {
    domains: emailLeads.skipDomains(),
    addresses: new Set([...emailLeads.skipAddresses(), office, old].map(low).filter(Boolean)),
  };
}

/**
 * Messages → one group per lower-cased sender. PURE.
 * @returns {{ groups: Map<string, {address, count, newestMs, oldestMs, withAttachments}>, counts: object }}
 */
function groupSenders(messages, ctx) {
  const groups = new Map();
  const seen = new Set();
  const skipped = { own: new Set(), automated: new Set() };
  const counts = { read: 0, drafts: 0, duplicates: 0, invalid: 0, automatedSkipped: 0, ownSkipped: 0, skippedSenders: 0 };
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    counts.read++;
    if (m.isDraft === true) { counts.drafts++; continue; }
    const imid = s(m.internetMessageId);
    if (imid) { if (seen.has(imid)) { counts.duplicates++; continue; } seen.add(imid); }
    const a = emailLeads.senderOf(m).email;
    const why = skipKind(a, ctx);
    if (why === 'invalid') { counts.invalid++; continue; }
    if (why) { skipped[why].add(a); continue; }
    let g = groups.get(a);
    if (!g) { g = { address: a, count: 0, newestMs: NaN, oldestMs: NaN, withAttachments: 0 }; groups.set(a, g); }
    g.count++;
    const at = Date.parse(s(m.receivedDateTime));
    if (Number.isFinite(at)) {
      if (!(g.newestMs >= at)) g.newestMs = at;
      if (!(g.oldestMs <= at)) g.oldestMs = at;
    }
    if (m.hasAttachments === true) g.withAttachments++;
  }
  counts.ownSkipped = skipped.own.size;
  counts.automatedSkipped = skipped.automated.size;
  counts.skippedSenders = skipped.own.size + skipped.automated.size;
  return { groups, counts };
}

/* ── 4. who is it: two full board scans (Monday) ───────────────────────── */

/** The plain addresses in a cell (several allowed, split on spaces / commas / semicolons), lower-cased. PURE. */
function cellAddresses(text) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split(/[\s,;]+/)) {
    const a = low(raw).replace(/^mailto:/, '').replace(/^[<("'[]+|[>)"'\].]+$/g, '');
    if (a && addressOk(a) && !out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * Every item of one board: items_page(limit 500) + next_items_page until the cursor is done. THROWS on any
 * failed or odd page, and past MONDAY_MAX_PAGES — never a partial board.
 */
async function scanBoard(boardId, columnIds, extraFields) {
  if (!/^\d{1,20}$/.test(s(boardId))) throw new Error('board not configured');
  const sel = `items{ id name ${extraFields} column_values(ids:${JSON.stringify(columnIds)}){ id text value } }`;
  let d = await io.monday(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:${MONDAY_PAGE}){ cursor ${sel} } } }`, { b: [s(boardId)] });
  const first = d && d.boards && d.boards[0] && d.boards[0].items_page;
  if (!first || !Array.isArray(first.items)) throw new Error('board could not be read');
  const items = [...first.items];
  let cursor = first.cursor, pages = 1;
  while (cursor) {
    if (pages >= MONDAY_MAX_PAGES) throw new Error('too many pages');
    d = await io.monday(`query($c:String!){ next_items_page(limit:${MONDAY_PAGE}, cursor:$c){ cursor ${sel} } }`, { c: String(cursor) });
    const p = d && d.next_items_page;
    if (!p || !Array.isArray(p.items)) throw new Error('board could not be read');
    items.push(...p.items);
    cursor = p.cursor;
    pages++;
  }
  return items;
}

const colOf = (it, id) => ((it && it.column_values) || []).find((c) => c && c.id === id) || null;

/** A Client Master item → { id, name, group, caseRef, stage, emails, live }. PURE. */
function cmRow(it) {
  const g = (it && it.group) || {};
  const group = { id: s(g.id), title: s(g.title) };
  return {
    id: s(it && it.id),
    name: oneLine(it && it.name),
    group,
    live: isCaseGroup(group),
    caseRef: s((colOf(it, CM.caseRef) || {}).text),
    stage: statusText(colOf(it, CM.stage)),
    emails: cellAddresses((colOf(it, CM.email) || {}).text),
  };
}

/** A Lead Board item → { id, name, createdAt, emails, outcome, cmItemId, lead } (lead = leadService.parseItem). PURE. */
function leadRow(it) {
  const lead = require('./leadService').parseItem(it) || {};
  const cv = colOf(it, LEAD_COLS.email) || {};
  let stored = '';
  try { const v = JSON.parse(cv.value || 'null'); stored = s(v && v.email); } catch (_) { stored = ''; }
  const name = oneLine(lead.fullName || (s(it && it.name) === 'Unnamed Lead' ? '' : it && it.name));
  return {
    id: s(it && it.id),
    name,
    createdAt: s(it && it.created_at),
    emails: cellAddresses(`${stored} ${s(cv.text)}`),
    outcome: canonicalOutcome(lead.outcome) || s(lead.outcome) || (lead.webinar === 'Yes' ? 'Webinar' : ''),
    cmItemId: /^\d{1,20}$/.test(s(lead.clientMasterItemId)) ? s(lead.clientMasterItemId) : '',
    lead,
  };
}

/** Both boards, in full. THROWS a 503 refusal on any Monday failure (which board only — never Monday's text). */
async function readBoards() {
  const ids = io.boards();
  const leadCols = LEAD_KEYS.map((k) => LEAD_COLS[k]);
  const read = async (what, fn) => {
    try { return await fn(); }
    catch (_) {
      io.warn(`[OldReplies] the ${what} could not be read — no list made`);
      throw refusal(503, `Monday could not be read (the ${what}), so no list was made — a partial list could look complete. Try again in a minute.`);
    }
  };
  const [cmItems, leadItems] = await Promise.all([
    read('Client Master board', () => scanBoard(ids.cm, [CM.caseRef, CM.email, CM.stage], 'group{ id title }')),
    read('Lead Board', () => scanBoard(ids.lead, leadCols, 'created_at')),
  ]);
  return { cm: cmItems.map(cmRow), leads: leadItems.map(leadRow) };
}

/* ── matching (PURE) ───────────────────────────────────────────────────── */

const push = (map, k, v) => { const xs = map.get(k); if (xs) { if (!xs.includes(v)) xs.push(v); } else map.set(k, [v]); };
const newestLeadFirst = (a, b) => s(b.createdAt).localeCompare(s(a.createdAt)) || (Number(b.id) || 0) - (Number(a.id) || 0);

/**
 * Sender groups + the two boards → the rows (no answer check yet) and the counts. PURE.
 * A row: the live cases whose Client Email holds the address, the leads whose Email is the address (newest first),
 * and the live case each of those leads links to. Nothing live and nothing on the Lead Board → counted only.
 */
function matchGroups(groups, { cm, leads }, { now, leadStatus } = {}) {
  const caseByAddr = new Map(), leadByAddr = new Map(), notCaseAddr = new Set(), caseById = new Map();
  for (const r of cm) {
    if (r.live) { caseById.set(r.id, r); for (const a of r.emails) push(caseByAddr, a, r); }
    else for (const a of r.emails) notCaseAddr.add(a);
  }
  for (const l of leads) for (const a of l.emails) push(leadByAddr, a, l);
  const rows = [];
  let unmatched = 0, testOrCancelled = 0;
  for (const g of groups.values()) {
    const direct = caseByAddr.get(g.address) || [];
    const ls = (leadByAddr.get(g.address) || []).slice().sort(newestLeadFirst);
    const cases = [...direct];
    for (const l of ls) { const c = l.cmItemId && caseById.get(l.cmItemId); if (c && !cases.includes(c)) cases.push(c); }
    if (!cases.length && !ls.length) { if (notCaseAddr.has(g.address)) testOrCancelled++; else unmatched++; continue; }
    let status = '';
    if (ls.length && typeof leadStatus === 'function') { try { status = s(leadStatus(ls[0].lead, now)); } catch (_) { status = ''; } }
    rows.push({
      kind: cases.length && ls.length ? 'case+lead' : cases.length ? 'case' : 'lead',
      name: (cases.find((c) => c.name) || {}).name || (ls.find((l) => l.name) || {}).name || '',
      caseRefs: cases.map((c) => c.caseRef || 'no case number'),
      caseStages: cases.map((c) => c.stage),
      leadIds: ls.map((l) => l.id),
      leadOutcome: ls.length ? ls[0].outcome : '',
      leadStatus: status,
      oldReplies: g.count,
      newest: Number.isFinite(g.newestMs) ? new Date(g.newestMs).toISOString() : '',
      oldest: Number.isFinite(g.oldestMs) ? new Date(g.oldestMs).toISOString() : '',
      withAttachments: g.withAttachments,
      answeredFromInfoAfter: 'unknown',
      wroteToInfoAfter: null,
      wroteToInfoAfterAtLeast: false,
      sharedAddress: direct.length > 1,
      _address: g.address, _newestMs: g.newestMs,
    });
  }
  return { rows, unmatched, testOrCancelled };
}

/* ── 5. answered after? (the office mailbox, per matched sender) ───────── */

/** The two $search reads for one row. Mutates the row; answers which parts failed (status / code only). */
async function checkRow(office, row) {
  const failed = [];
  const a = row._address;
  if (!addressOk(a) || !Number.isFinite(row._newestMs)) return failed;   // nothing safe to ask, or no date to compare: unknown
  const after = (v) => { const t = Date.parse(s(v)); return Number.isFinite(t) && t > row._newestMs; };
  const base = `${GRAPH}/users/${enc(office)}`;
  const search = (kind) => enc(`"${kind}:${a}"`);
  const sent = graphGet(office, `${base}/mailFolders/sentitems/messages?$search=${search('to')}&$top=${SEARCH_TOP}&$select=sentDateTime`)
    .then((p) => {
      if (!p || !Array.isArray(p.value)) throw Object.assign(new Error('odd'), { response: { status: 0, data: { error: { code: 'unexpected-answer' } } } });
      row.answeredFromInfoAfter = p.value.some((m) => after(m && m.sentDateTime)) ? 'yes' : 'no';
    })
    .catch((err) => { row.answeredFromInfoAfter = 'unknown'; failed.push(codeOf(err)); });
  const wrote = graphGet(office, `${base}/messages?$search=${search('from')}&$top=${SEARCH_TOP}&$select=receivedDateTime`)
    .then((p) => {
      if (!p || !Array.isArray(p.value)) throw Object.assign(new Error('odd'), { response: { status: 0, data: { error: { code: 'unexpected-answer' } } } });
      const n = p.value.filter((m) => after(m && m.receivedDateTime)).length;
      row.wroteToInfoAfter = n;
      row.wroteToInfoAfterAtLeast = n >= SEARCH_TOP;
    })
    .catch((err) => { row.wroteToInfoAfter = null; row.wroteToInfoAfterAtLeast = false; failed.push(codeOf(err)); });
  await Promise.all([sent, wrote]);
  return failed;
}

/** Every row, newest old reply first, one row at a time (its two reads together: ≤ 2 in flight); stops starting after the budget. */
async function checkAnswers(office, rows, startMs) {
  const failures = new Map();
  let notChecked = 0;
  const order = rows.slice().sort((x, y) => (y._newestMs || 0) - (x._newestMs || 0));
  for (const row of order) {
    if (io.now() - startMs > CHECK_BUDGET_MS) { notChecked++; continue; }
    for (const f of await checkRow(office, row)) failures.set(f, (failures.get(f) || 0) + 1);
  }
  return { failures, notChecked };
}

/* ── the list ──────────────────────────────────────────────────────────── */

const sortRows = (rows) => rows.sort((x, y) =>
  (ANSWER_RANK[x.answeredFromInfoAfter] - ANSWER_RANK[y.answeredFromInfoAfter]) || ((y._newestMs || 0) - (x._newestMs || 0)));
const publicRow = ({ _address, _newestMs, ...pub }) => pub;

async function build() {
  const t0 = io.now();
  const office = officeMailbox();
  const old = oldMailbox();
  if (!old) throw refusal(409, 'There is no separate old no-reply mailbox to read (MS_FROM_EMAIL is the office mailbox).');

  let inbox;
  try { inbox = await readInbox(old); }
  catch (err) {
    const e = errorOf(err);
    io.warn(`[OldReplies] the old no-reply inbox could not be read (${e.status || 'no answer'} ${e.code}) — no list made`);
    throw refusal(503, `The old no-reply inbox could not be read (${e.status || 'no answer'} ${e.code}), so no list was made.${e.status === 401 || e.status === 403 ? ' The app may not be allowed to read that mailbox.' : ' Try again in a minute.'}`);
  }

  const { groups, counts } = groupSenders(inbox.items, ownContext(office, old));
  let matched = { rows: [], unmatched: 0, testOrCancelled: 0 };
  if (groups.size) matched = matchGroups(groups, await readBoards(), { now: io.now(), leadStatus: io.leadStatus });
  const { failures, notChecked } = await checkAnswers(office, matched.rows, io.now());
  const rows = sortRows(matched.rows);

  const answers = { yes: 0, no: 0, unknown: 0 };
  for (const r of rows) answers[r.answeredFromInfoAfter]++;
  const summary = {
    sendersTotal: groups.size,
    matchedCases: rows.filter((r) => r.kind !== 'lead').length,
    matchedLeads: rows.filter((r) => r.kind !== 'case').length,
    unmatchedSenders: matched.unmatched,
    automatedSkipped: counts.skippedSenders,
    testOrCancelled: matched.testOrCancelled,
    capped: inbox.capped,
    mailbox: 'old no-reply inbox',
    readAt: new Date(io.now()).toISOString(),
    emailsRead: counts.read,
    draftsSkipped: counts.drafts,
    duplicatesSkipped: counts.duplicates,
    invalidSkipped: counts.invalid,
    answers,
    answerChecksNotStarted: notChecked,
  };
  const notes = [
    'Read-only: nothing was changed in Outlook or Monday. Only the senders and dates of the old inbox were read — never a subject or the text of an email.',
    `People who wrote to the old address but match no case and no lead are counted (${matched.unmatched}), never listed — they may be anyone.`,
    '"Answered from info@ after" looks at the office mailbox\'s Sent Items only. An answer a staff member sent from their own mailbox cannot be seen here, so "no" means "no answer from info@ after their last email to the old address", not "nobody answered".',
    '"unknown" means the check could not be made (Microsoft did not answer, or was busy) — it is never a guess. Outlook\'s search can lag a few minutes behind new mail.',
    '"Wrote to info@ after" counts up to 10 emails from them in the office mailbox after their last email to the old address (10 means 10 or more).',
    `Our own addresses, the services on the email skip lists and automatic senders (no-reply, notifications…) are left out (${counts.skippedSenders}).`,
  ];
  if (inbox.capped) notes.push(`The old inbox has more than ${INBOX_PAGE * INBOX_MAX_PAGES} emails: only the newest ${INBOX_PAGE * INBOX_MAX_PAGES} were read — older replies are not in this list.`);
  if (matched.testOrCancelled) notes.push(`${matched.testOrCancelled} ${matched.testOrCancelled === 1 ? 'person is' : 'people are'} only on Client Master rows in the TEST, Leads or Cancel groups — left out.`);
  if (rows.some((r) => r.sharedAddress)) notes.push('"Shared address": the address is on more than one case — open the email in Outlook (or the case\'s Emails tab) to see which case it was about.');
  if (notChecked) notes.push(`The answer checks stopped after ${CHECK_BUDGET_MS / 60000} minutes: ${notChecked} ${notChecked === 1 ? 'row shows' : 'rows show'} "unknown" — refresh the list to check them.`);

  const failText = [...failures.entries()].map(([k, n]) => `${k} x${n}`).join(', ');
  const secs = ((io.now() - t0) / 1000).toFixed(1);
  io.log(`[OldReplies] list: emails=${counts.read} pages=${inbox.pages}${inbox.capped ? ' (capped)' : ''} senders=${groups.size} cases=${summary.matchedCases} leads=${summary.matchedLeads} unmatched=${matched.unmatched} skipped=${counts.skippedSenders} test/cancel=${matched.testOrCancelled} answered yes=${answers.yes} no=${answers.no} unknown=${answers.unknown}${notChecked ? ` not-started=${notChecked}` : ''}${failText ? ` failed: ${failText}` : ''} ${secs}s`);
  return { ok: true, summary, rows: rows.map(publicRow), notes };
}

let _last = null;       // { at, value }
let _inflight = null;

/**
 * The list. Kept 10 minutes; `refresh` reads again (at most once a minute). Two calls at once share one read.
 * THROWS { publicStatus, publicError } when no list can be made (never a partial one).
 */
async function list({ refresh = false } = {}) {
  const age = _last ? io.now() - _last.at : Infinity;
  if (_last && (age < REFRESH_MIN_MS || (!refresh && age < CACHE_MS))) return { ..._last.value, cached: true };
  if (_inflight) return _inflight;
  _inflight = build()
    .then((value) => { _last = { at: io.now(), value }; return { ...value, cached: false }; })
    .finally(() => { _inflight = null; });
  return _inflight;
}

/* ── 7. the CSV ────────────────────────────────────────────────────────── */

const CSV_HEAD = Object.freeze(['Name', 'Kind', 'Case number(s)', 'Stage(s)', 'Lead id(s)', 'Lead outcome', 'Old replies', 'Newest', 'Oldest',
  'With attachments', 'Answered from info@ after', 'Wrote to info@ after', 'Shared address']);
const KIND_LABEL = { case: 'Case', lead: 'Lead', 'case+lead': 'Case + lead' };

/**
 * One CSV cell: a number as it is; any text on one line, always in double quotes (a quote doubled), and text a
 * spreadsheet would run as a formula (= + - @ or their full-width forms first, also after leading spaces, or a tab
 * first) starts with an apostrophe instead. PURE.
 */
function csvCell(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  let t = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');
  if (/^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/.test(t) || /^\t/.test(t)) t = `'${t}`;   // also the full-width forms
  return `"${t.replace(/"/g, '""')}"`;
}

/** The rows as CSV text (UTF-8 BOM so spreadsheets read the names right; CRLF lines). Dates in Toronto time. PURE. */
function toCsv(rows) {
  const when = (iso) => (iso ? torontoWallClock(iso) : '');
  const lines = [CSV_HEAD.map(csvCell).join(',')];
  for (const r of rows || []) {
    lines.push([
      r.name, KIND_LABEL[r.kind] || r.kind, (r.caseRefs || []).join('; '), (r.caseStages || []).join('; '), (r.leadIds || []).join('; '),
      r.leadOutcome, r.oldReplies, when(r.newest), when(r.oldest), r.withAttachments, r.answeredFromInfoAfter,
      r.wroteToInfoAfter == null ? 'unknown' : (r.wroteToInfoAfterAtLeast ? `${r.wroteToInfoAfter}+` : r.wroteToInfoAfter),
      r.sharedAddress ? 'yes' : '',
    ].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** The download's file name: the Toronto day the list was read. */
const csvFileName = (out) => `old-noreply-replies-${torontoDay((out && out.summary && out.summary.readAt) || new Date(io.now()).toISOString()) || 'list'}.csv`;

module.exports = {
  list, toCsv, csvFileName, officeMailbox, oldMailbox,
  // pure pieces + seams (tests)
  io, groupSenders, matchGroups, cellAddresses, cmRow, leadRow, skipKind, ownContext, csvCell, isGraphLink, inboxUrl,
  CSV_HEAD, LEAD_KEYS, CM, INBOX_SELECT, INBOX_MAX_PAGES, SEARCH_TOP, MONDAY_PAGE, CHECK_BUDGET_MS, CACHE_MS, REFRESH_MIN_MS, FALLBACK_OLD,
  _reset: () => { _last = null; _inflight = null; _flight.clear(); },
};
