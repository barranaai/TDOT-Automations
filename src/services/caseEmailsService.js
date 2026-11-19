'use strict';

/**
 * The case page's "Emails" tab (Stage 2a, Faran 2026-11-19) — READ-ONLY, live from Microsoft, nothing copied
 * into Monday. Switch CASE_EMAILS_TAB = off (default) | admins | on, read at call time.
 *
 * Two mailboxes, FIXED here and never taken from a request:
 *   office — CLIENT_MAIL_FROM when it is set and usable (microsoftMailService.clientMailbox), else the office inbox
 *            (EMAIL_LEADS_MAILBOX / info@tdotimm.com): the app's kept, stamped copies, the client's mail and the
 *            staff's answers from Outlook.
 *   old    — MS_FROM_EMAIL (noreply@): its INBOX only, and only messages whose FROM is one of this client's
 *            addresses (decision 6). That mailbox is also the OneDrive owner and the shared Otter login: nothing
 *            else from it is ever read or shown.
 *
 * The list (one Graph plan, each source answers for itself — a failed source is never "no emails"):
 *   Q1 office Sent Items, $filter on the stamp: TdotCaseItemId = this case (paged up to a cap), TdotLeadId = each
 *      lead of the case, TdotTo = each client address; $expand reads the stamp fields back (critique #4) — a copy
 *      found by TdotTo whose case / lead fields did not come back is left out ("not checked").
 *   Q2 office, every folder: $search "participants:a OR … OR subject:\"REF\"" (≤ 300, next links; never mixed with
 *      $filter / $orderby). Graph refusing the quoted ref → once more with the ref unquoted.
 *   Q3 office, the last 30 minutes ($filter receivedDateTime ge …, newest first, 50) — the search index lags.
 *   Q4 old inbox: one $filter per client address on the FROM address (≤ 5), 50 each.
 *   Folder ids for the labels (Inbox / Sent / Junk / Deleted / Drafts / Outbox), one at a time, kept 6 hours.
 * Everything found is put through ONE match rule (caseEmailsRules.matchMessage) — the same rule when one email
 * is opened or one attachment downloaded: the request carries only { source, id }, and the server fetches the
 * email again and matches it again for THIS case (critique #1: no signed tokens).
 *
 * Load on Outlook: at most 2 Graph calls at once per mailbox from here (Outlook allows 4 per app per mailbox and
 * the app's own sending shares them). A 429 / 503 / 504 waits for Retry-After once when it is 5 s or less;
 * otherwise that part fails and says so.
 *
 * Memory only: the list per case 90 s (the same case loaded twice at once is read once; Refresh at most every
 * 15 s), the shared-address checks 10 minutes, the folder ids 6 hours, which email id is which internet message
 * id 30 minutes (to find an email again after it was moved).
 *
 * Logs: ids and counts only — never a subject, an address, a body, a file name or Graph's error text (it can
 * repeat the query). An email opened / an attachment downloaded is logged with the staff member's email and a
 * short hash of the internet message id (decision 2).
 */

const axios = require('axios');
const crypto = require('crypto');
const mail = require('./microsoftMailService');
const emailLeads = require('./emailLeadsService');
const rules = require('./caseEmailsRules');
const { textSegments } = require('../utils/caseEmailLinks');
const { errorOf, withToken, retryAfterSeconds } = require('../utils/graphRead');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_TIMEOUT_MS = 10000;           // interactive: a staff member waits on it
const STREAM_TIMEOUT_MS = 60000;
const MAX_IN_FLIGHT = 2;                  // per mailbox, from this service
const MAX_RETRY_WAIT_S = 5;
const LIST_TTL_MS = 90 * 1000;
const REFRESH_MIN_MS = 15 * 1000;
const SHARED_TTL_MS = 10 * 60 * 1000;
const FOLDER_TTL_MS = 6 * 3600 * 1000;
const INDEX_TTL_MS = 30 * 60 * 1000;
const INDEX_MAX = 5000;
const RECENT_MS = 30 * 60 * 1000;
const CASE_PAGES = 6, CASE_PAGE_SIZE = 50;     // app copies for this case: up to 300
const OTHER_PAGES = 2;                          // per lead / per address: up to 100
const SEARCH_PAGES = 3, SEARCH_PAGE_SIZE = 100; // up to 300
const MAX_LEADS = 10;
const ATTACH_MAX_BYTES = 35 * 1024 * 1024;
const PREFER_TEXT = { Prefer: 'outlook.body-content-type="text"' };
/** Client Master columns (clientMasterService CM_EMAIL_COL / CASE_REF_COL). */
const CM_EMAIL_COL = 'text_mm0xw6bp';
const CM_REF_COL = 'text_mm142s49';
const ID_RE = /^[A-Za-z0-9_=-]{1,512}$/;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const BLOCKED_EXT = new Set(['html', 'htm', 'svg', 'js', 'vbs', 'hta', 'lnk', 'exe', 'bat', 'cmd', 'ps1', 'scr', 'msi', 'iso', 'img']);
const BLOCKED_TYPES = /^(text\/html|image\/svg\+xml|application\/(x-)?javascript|text\/javascript|application\/hta|application\/x-msdownload)\b/i;
const OPEN_SELECT = rules.SELECT + ',uniqueBody,body';

const s = (v) => String(v == null ? '' : v).trim();
const low = (v) => s(v).toLowerCase();
const enc = encodeURIComponent;

/** off (default) | admins | on — read at call time. */
function mode() {
  const v = low(process.env.CASE_EMAILS_TAB);
  return v === 'on' ? 'on' : v === 'admins' ? 'admins' : 'off';
}

/** The office mailbox (see the header). */
function officeMailbox() { return low(mail.clientMailbox() || emailLeads.mailbox()); }
/** The old no-reply mailbox, or '' (unset, unusable, or the same as the office mailbox). */
function oldMailbox() {
  const b = low(process.env.MS_FROM_EMAIL);
  return EMAIL_RE.test(b) && b !== officeMailbox() ? b : '';
}
/** The ONLY way a request names a mailbox: one of these two words. */
const MAILBOX = Object.freeze({ office: officeMailbox, old: oldMailbox });

/* ── the side effects (tests replace them) ─────────────────────────────── */
const io = {
  token: () => mail.getAccessToken(),
  dropToken: () => mail.invalidateAccessToken(),
  get: (url, headers) => axios.get(url, { headers, timeout: GRAPH_TIMEOUT_MS }),
  stream: (url, headers) => axios.get(url, { headers, timeout: STREAM_TIMEOUT_MS, responseType: 'stream' }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  log: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  readCaseRow: (itemId) => require('./caseNotesService').readCaseRow(itemId, { extraColumns: [CM_EMAIL_COL, CM_REF_COL] }),
  caseLeadSet: (itemId, caseRef, o) => require('./caseNotesService').caseLeadSet(itemId, caseRef, { ...o, withEmail: true }),
  casesByEmail: (address) => require('./clientMasterService').findCasesByEmail(address),
};

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

async function graphCall(box, call) {
  return limited(box, async () => {
    const once = () => withToken(io, call);
    try { return await once(); }
    catch (err) {
      const st = err && err.response && err.response.status;
      if (st === 429 || st === 503 || st === 504) {
        const wait = retryAfterSeconds(err, io.now());
        if (wait != null && wait <= MAX_RETRY_WAIT_S) { await io.sleep(wait * 1000); return once(); }
        err.retryAfter = wait;
      }
      throw err;
    }
  });
}
const graphGet = async (box, url, extra = {}) => (await graphCall(box, (h) => io.get(url, { ...h, ...extra }))).data;

/** A failed part, as the page shows it: status + Graph's short code + plain words. Never Graph's message. */
function failureOf(err, box, part) {
  const e = errorOf(err);
  let hint = '';
  if (e.status === 401 || e.status === 403) hint = 'The app is not allowed to read this mailbox — a Microsoft 365 admin needs to give it Mail.Read for it.';
  else if (e.status === 404) hint = 'Microsoft says there is no such mailbox.';
  else if (e.status === 429 || e.status === 503 || e.status === 504) hint = `Microsoft is busy${err && err.retryAfter ? ` — try again in ${err.retryAfter} s` : ' — try again in a minute'}.`;
  else if (!e.status) hint = 'Microsoft did not answer in time.';
  return { part, status: e.status, code: e.code, hint };
}
/** One log line for a failed part: ids and codes only. */
const logFailure = (caseRef, f) => io.warn(`[CaseEmails] ${caseRef}: ${f.part} could not be read (${f.status || 'no answer'} ${f.code})`);

/** Follow next links on Graph only, up to `maxPages`. */
async function pages(box, firstUrl, maxPages, extra) {
  const items = [];
  let url = firstUrl, n = 0;
  while (url) {
    if (!String(url).startsWith(GRAPH + '/')) throw Object.assign(new Error('An unexpected next-page link.'), { response: { status: 0 } });
    const page = await graphGet(box, url, extra);
    items.push(...((page && page.value) || []));
    n++;
    url = page && page['@odata.nextLink'];
    if (url && n >= maxPages) return { items, capped: true };
  }
  return { items, capped: false };
}

/* ── folder ids (office), one at a time, 6 hours; the old mailbox's Inbox id the same way ── */
let _folders = { box: '', at: 0, ids: null };
let _oldInbox = { box: '', at: 0, id: '' };
async function oldInboxId(box) {
  if (_oldInbox.id && _oldInbox.box === box && io.now() - _oldInbox.at < FOLDER_TTL_MS) return _oldInbox.id;
  const f = await graphGet(box, `${GRAPH}/users/${enc(box)}/mailFolders/inbox?$select=id`);
  _oldInbox = { box, at: io.now(), id: s(f && f.id) };
  return _oldInbox.id;
}
async function folderIds(box) {
  if (_folders.ids && _folders.box === box && io.now() - _folders.at < FOLDER_TTL_MS) return _folders.ids;
  const ids = {};
  for (const k of rules.FOLDER_KEYS) {
    const f = await graphGet(box, `${GRAPH}/users/${enc(box)}/mailFolders/${k}?$select=id`);
    ids[k] = s(f && f.id);
  }
  _folders = { box, at: io.now(), ids };
  return ids;
}

/* ── the case keys (Monday) ────────────────────────────────────────────── */
const _shared = new Map();   // address → { at, cases: [{id, caseRef}] }
async function sharedFor(address, itemId) {
  const hit = _shared.get(address);
  let cases;
  if (hit && io.now() - hit.at < SHARED_TTL_MS) cases = hit.cases;
  else {
    try {
      cases = ((await io.casesByEmail(address)) || []).map((c) => ({ id: s(c && c.id), caseRef: s(c && c.caseRef) }));
      _shared.set(address, { at: io.now(), cases });
    } catch (_) { return { cases: [], failed: true }; }   // never "no other case" when the look failed (critique #11)
  }
  const others = cases.filter((c) => c.id && c.id !== s(itemId)).map((c) => c.caseRef || 'another case (no case number)');
  return { cases: [...new Set(others)], failed: false };
}

/**
 * Who "this client" is for this case (decision 3), the lead ids, the shared-address checks and the banners.
 * @param {{ itemId: string, caseRef: string, row: { recordUrl?: string, texts?: object } }} c
 */
async function caseKeys({ itemId, caseRef, row }) {
  const texts = (row && row.texts) || {};
  const ref = s(texts[CM_REF_COL] || caseRef).toUpperCase();
  const banners = [];
  let set = null;
  try { set = await io.caseLeadSet(itemId, ref, { recordUrl: row && row.recordUrl }); }
  catch (_) { io.warn(`[CaseEmails] ${ref}: the consultations of the case could not be read`); }
  // different people named, or part of that check failed → the Client Master email only, and only leads linked
  // by their Client Master Item ID (critique #7 — the reading side of the 2026-OINP-059 rule)
  const narrow = !set || !!set.multipleClaimants || !!set.partial;
  const leads = set ? (narrow ? set.leads.filter((l) => l.via === 'link') : set.leads) : [];
  if (!set) banners.push('The consultations linked to this case could not be read, so only the Client Master email is used — emails from before the case may be missing.');
  else if (set.multipleClaimants) banners.push(`This case is linked to ${set.claimantCount} client records that name different people, so only the Client Master email is used to find emails.`);
  else if (set.partial) banners.push('Not every consultation linked to this case could be checked, so only the Client Master email is used — emails from before the case may be missing.');

  const office = officeMailbox(), old = oldMailbox();
  const skipAddresses = [...emailLeads.skipAddresses(), office, old].filter(Boolean);
  const got = rules.clientAddresses({
    cmEmail: texts[CM_EMAIL_COL] || '',
    leadEmails: narrow ? [] : leads.map((l) => l.email),
    skipDomains: emailLeads.skipDomains(),
    skipAddresses,
  });
  if (!got.addresses.length) {
    banners.push(got.droppedOwn
      ? 'Address matching is off: the client email on this case is an office address. Only emails with the case number or the app\'s case stamp are shown.'
      : 'No client email on file — only emails with the case number or the app\'s case stamp are shown.');
  }
  if (got.droppedOdd) banners.push('An email address on file has unusual characters, so it was not used to find emails.');
  if (got.droppedOver) banners.push(`Only the first ${rules.MAX_ADDRESSES} client email addresses are used.`);

  const shared = {};
  for (const a of got.addresses) shared[a] = await sharedFor(a, itemId);
  const ownDomains = [...new Set(['tdotimm.com', office.split('@')[1], old.split('@')[1]].filter(Boolean))];
  return {
    itemId: s(itemId), caseRef: ref,
    leadIds: [...new Set(leads.map((l) => s(l.leadId)).filter((x) => rules.ITEM_ID_RE.test(x)))].slice(0, MAX_LEADS),
    addresses: got.addresses, shared, banners,
    officeBox: office, oldBox: old, ownDomains, ownAddresses: skipAddresses.map(low),
    folders: null, q1Complete: false,
  };
}

/* ── reading the sources ───────────────────────────────────────────────── */

function mergeInto(byId, msg, src, proved, knownBy) {
  const id = s(msg && msg.id);
  if (!id) return;
  const have = byId.get(id);
  const m = have || { ...msg, _src: src, _proved: {}, _stampKnown: false };
  if (!have) byId.set(id, m);
  if (proved) Object.assign(m._proved, proved);
  if (knownBy && rules.hasStampField(msg, knownBy)) {
    m._stampKnown = true;
    // the same copy found by two looks: every field either look read back (by property id)
    const byProp = new Map((have && Array.isArray(m.singleValueExtendedProperties) ? m.singleValueExtendedProperties : []).map((p) => [String(p.id).toLowerCase(), p]));
    for (const p of msg.singleValueExtendedProperties) byProp.set(String(p && p.id).toLowerCase(), p);
    m.singleValueExtendedProperties = [...byProp.values()];
  }
}

async function readOffice(keys) {
  const box = keys.officeBox;
  const base = `${GRAPH}/users/${enc(box)}`;
  const failures = [];
  const capped = { app: false, search: false };
  let folders;
  try { folders = await folderIds(box); }
  catch (err) { failures.push(failureOf(err, box, 'folders')); return { ok: false, messages: [], failures, capped, folders: null, q1Complete: false }; }
  const byId = new Map();
  const counts = { app: 0, search: 0, recent: 0 };

  // Q1 — the app's stamped copies: this case, each lead, each address (the filter proves what it matched)
  const q1 = [
    { name: 'TdotCaseItemId', key: 'caseItemId', value: keys.itemId, max: CASE_PAGES },
    ...keys.leadIds.map((l) => ({ name: 'TdotLeadId', key: 'leadId', value: l, max: OTHER_PAGES })),
    ...keys.addresses.map((a) => ({ name: 'TdotTo', key: 'to', value: a, max: OTHER_PAGES })),
  ];
  // complete = every TdotTo look answered in full: then any app copy to a client address is in hand with its
  // stamp, and an office-sent email found only by the search is a staff answer (matchMessage, "unverified")
  let toComplete = true;
  const appCopies = () => Promise.all(q1.map(async (q) => {
    const url = (expand) => `${base}/mailFolders/sentitems/messages?$filter=${enc(rules.stampFilter(q.name, q.value))}&$top=${CASE_PAGE_SIZE}&$select=${rules.SELECT}${expand ? `&$expand=${enc(rules.stampExpand())}` : ''}`;
    let got;
    try { got = await pages(box, url(true), q.max); }
    catch (err) {
      if (!(err && err.response && err.response.status === 400)) { if (q.name === 'TdotTo') toComplete = false; failures.push(failureOf(err, box, 'app emails')); return; }
      try { got = await pages(box, url(false), q.max); }   // the expand refused: found, but the stamp is not read back
      catch (err2) { if (q.name === 'TdotTo') toComplete = false; failures.push(failureOf(err2, box, 'app emails')); return; }
    }
    if (got.capped) { capped.app = true; if (q.name === 'TdotTo') toComplete = false; }
    counts.app += got.items.length;
    for (const m of got.items) mergeInto(byId, m, 'office', { [q.key]: q.value }, q.name);
  }));

  // Q2 — the client's mail and the staff's answers: participants OR the ref in the subject (a ref that is not in
  // the usual shape is left out of the search — the addresses still are; the match rule still reads every subject)
  const searchRef = rules.REF_RE.test(keys.caseRef) ? keys.caseRef : '';
  const searched = async () => {
    let search = '';
    try { search = rules.searchValue(keys.addresses, searchRef, { quoted: true }); } catch (_) { search = ''; }
    if (!search) return;
    const url = (v) => `${base}/messages?$search=${enc(v)}&$top=${SEARCH_PAGE_SIZE}&$select=${rules.SELECT}`;
    let got = null;
    try { got = await pages(box, url(search), SEARCH_PAGES); }
    catch (err) {
      let fail = err;
      if (err && err.response && err.response.status === 400 && searchRef) {
        try { got = await pages(box, url(rules.searchValue(keys.addresses, searchRef, { quoted: false })), SEARCH_PAGES); fail = null; }
        catch (err2) { fail = err2; }
      }
      if (fail) failures.push(failureOf(fail, box, 'office mail search'));
    }
    if (got) {
      if (got.capped) capped.search = true;
      counts.search = got.items.length;
      for (const m of got.items) mergeInto(byId, m, 'office');
    }
  };

  // Q3 — the last 30 minutes (the search index can lag behind a reply that just came in)
  const newest = async () => {
    try {
      const since = new Date(io.now() - RECENT_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const page = await graphGet(box, `${base}/messages?$filter=${enc(`receivedDateTime ge ${since}`)}&$orderby=${enc('receivedDateTime desc')}&$top=50&$select=${rules.SELECT}`);
      const items = (page && page.value) || [];
      counts.recent = items.length;
      for (const m of items) mergeInto(byId, m, 'office');
    } catch (err) { failures.push(failureOf(err, box, 'the newest office mail')); }
  };

  // all three at once — the per-mailbox limit (2 in flight) paces them; the merge does not depend on the order
  await Promise.all([appCopies(), searched(), newest()]);
  return { ok: !failures.length, messages: [...byId.values()], failures, capped, folders, q1Complete: toComplete, counts };
}

async function readOld(keys) {
  const box = keys.oldBox;
  if (!box) return { ok: true, skipped: true, messages: [], failures: [], capped: false };
  const failures = [];
  let capped = false;
  const byId = new Map();
  await Promise.all(keys.addresses.map(async (a) => {
    try {
      const page = await graphGet(box, `${GRAPH}/users/${enc(box)}/mailFolders/inbox/messages?$filter=${enc(rules.fromFilter(a))}&$top=50&$select=${rules.SELECT}`);
      if (page && page['@odata.nextLink']) capped = true;
      for (const m of (page && page.value) || []) mergeInto(byId, m, 'old');
    } catch (err) { failures.push(failureOf(err, box, 'old no-reply inbox')); }
  }));
  return { ok: !failures.length, messages: [...byId.values()], failures, capped };
}

/* ── which email id is which internet message id (to find a moved email again), 30 minutes ── */
const _index = new Map();
const _attIndex = new Map();
function remember(map, key, value) {
  map.delete(key);
  map.set(key, { ...value, at: io.now() });
  if (map.size > INDEX_MAX) map.delete(map.keys().next().value);
}
function recall(map, key) {
  const v = map.get(key);
  if (!v) return null;
  if (io.now() - v.at > INDEX_TTL_MS) { map.delete(key); return null; }
  return v;
}

/* ── the list ──────────────────────────────────────────────────────────── */

const SOURCE_NAMES = { office: 'Office mailbox', old: 'old no-reply inbox' };

async function build({ itemId, caseRef, row }) {
  const t0 = io.now();
  const keys = await caseKeys({ itemId, caseRef, row });
  const [office, old] = await Promise.all([readOffice(keys), readOld(keys)]);
  keys.folders = office.folders;
  keys.q1Complete = office.q1Complete;
  const tally = { stamp: 0, ref: 0, address: 0, otherRecords: 0, unverified: 0 };
  const entries = [];
  for (const msg of [...office.messages, ...old.messages]) {
    const m = rules.matchMessage(msg, keys);
    if (m.include) { entries.push({ msg, m }); tally[m.how] = (tally[m.how] || 0) + 1; }
    else if (m.out === 'other-record') tally.otherRecords++;
    else if (m.out === 'unverified') tally.unverified++;
  }
  const kept = rules.dedupeSort(entries);
  for (const e of kept) remember(_index, `${keys.itemId}|${e.msg._src}|${s(e.msg.id)}`, { imid: s(e.msg.internetMessageId) });
  const items = kept.map((e) => rules.listItem(e.msg, e.m));
  for (const f of [...office.failures, ...old.failures]) logFailure(keys.caseRef, f);
  const secs = ((io.now() - t0) / 1000).toFixed(1);
  io.log(`[CaseEmails] ${keys.caseRef}: list office=${office.messages.length}${office.ok ? '' : ' (part failed)'} old=${old.skipped ? '-' : old.messages.length}${old.ok ? '' : ' (failed)'} shown=${items.length} (stamp ${tally.stamp}, ref ${tally.ref}, address ${tally.address}; other records ${tally.otherRecords}, not checked ${tally.unverified}) ${secs}s`);
  const source = (r, name) => ({
    name, ok: r.ok, skipped: !!r.skipped,
    failed: r.failures.map((f) => ({ part: f.part, status: f.status, code: f.code, hint: f.hint })),
  });
  return {
    caseRef: keys.caseRef,
    loadedAt: new Date(io.now()).toISOString(),
    complete: office.ok && old.ok,
    sources: {
      office: { ...source(office, SOURCE_NAMES.office), cappedApp: !!office.capped.app, cappedSearch: !!office.capped.search },
      old: { ...source(old, SOURCE_NAMES.old), capped: !!old.capped },
    },
    keys: {
      addresses: keys.addresses.map((a) => ({ address: a, sharedWith: keys.shared[a].cases, checkFailed: !!keys.shared[a].failed })),
      leadCount: keys.leadIds.length,
      banners: keys.banners,
    },
    counts: { shown: items.length, otherRecords: tally.otherRecords, unverified: tally.unverified },
    items,
    _keys: keys,
  };
}

const _lists = new Map();      // itemId → { at, value }
const _inflight = new Map();   // itemId → Promise

/**
 * The list for one case (no bodies). `refresh` reads Microsoft again — at most every 15 s per case.
 * The caller has already checked access (and checks it again on every request, cached or not).
 */
async function list({ itemId, caseRef, row, refresh = false }) {
  const id = s(itemId);
  const c = _lists.get(id);
  const age = c ? io.now() - c.at : Infinity;
  const ttl = c && c.value.complete ? LIST_TTL_MS : REFRESH_MIN_MS;   // a list with a failed part is kept 15 s only
  if (c && (age < REFRESH_MIN_MS || (!refresh && age < ttl))) return { ...c.value, cached: true };
  if (_inflight.has(id)) return _inflight.get(id);
  const p = build({ itemId: id, caseRef, row })
    .then((value) => { _lists.set(id, { at: io.now(), value }); return value; })
    .finally(() => { _inflight.delete(id); });
  _inflight.set(id, p);
  return p;
}

/** The keys for an open / a download: the list's when it is fresh, else read again. */
async function keysFor({ itemId, caseRef, row }) {
  const c = _lists.get(s(itemId));
  if (c && io.now() - c.at < LIST_TTL_MS) return c.value._keys;
  return caseKeys({ itemId, caseRef, row });
}

/**
 * What THIS viewer may see of the list (CASE_VISIBILITY=assigned, not an admin): an email matched only by an
 * address that is also on another case — or whose check failed — shows its subject and date only.
 */
function forViewer(out, viewer) {
  const limited = require('./caseAccessService').caseVisibilityPolicy() === 'assigned' && !(viewer && viewer.isAdmin);
  const { _keys, ...pub } = out;
  if (!limited) return pub;
  return { ...pub, items: pub.items.map((it) => (it.sharedRisk ? restrict(it) : it)) };
}
function restrict(it) {
  return { ...it, restricted: true, from: { name: '', address: '' }, to: [], toMore: 0, preview: '', hasAttachments: false, webLink: '' };
}
const isLimitedFor = (viewer) => require('./caseAccessService').caseVisibilityPolicy() === 'assigned' && !(viewer && viewer.isAdmin);

/* ── one email ─────────────────────────────────────────────────────────── */

/**
 * The stamp fields of one message, one documented $expand per field, one at a time (the path proven live by the
 * Stage 1 check). Only for a message the office mailbox itself sent (an app copy or a staff answer).
 */
async function readStampOne(box, id) {
  const props = [];
  for (const name of rules.STAMP_NAMES) {
    const m = await graphGet(box, `${GRAPH}/users/${enc(box)}/messages/${enc(id)}?$select=id&$expand=${enc(rules.stampExpand([name]))}`);
    for (const p of (m && m.singleValueExtendedProperties) || []) props.push(p);
  }
  return props;
}

const notFound = (why) => Object.assign(new Error('This email is not on this case.'), { notFound: true, why });

/** One message fetched for THIS case and matched again; a moved one is found again by its internet message id. */
async function resolveMessage({ itemId, caseRef, row, source, id, select = OPEN_SELECT }) {
  if (!Object.prototype.hasOwnProperty.call(MAILBOX, source) || !ID_RE.test(String(id || ''))) throw notFound('bad-request');
  const box = MAILBOX[source]();
  if (!box) throw notFound('no-mailbox');
  const keys = { ...(await keysFor({ itemId, caseRef, row })) };
  if (source === 'office') keys.folders = await folderIds(box);
  const inbox = source === 'old' ? await oldInboxId(box) : '';
  keys.q1Complete = true;   // the stamp of a message the office mailbox sent is read below, field by field
  const base = `${GRAPH}/users/${enc(box)}`;
  /** null: not a message this source may show (the old mailbox: its Inbox only — decision 6). */
  const prep = async (msg) => {
    if (source === 'old' && (!inbox || s(msg && msg.parentFolderId) !== inbox)) return null;
    const m = { ...msg, _src: source, _proved: {}, _stampKnown: false };
    if (source === 'office' && rules.participants(m).from === low(box)) {
      m.singleValueExtendedProperties = await readStampOne(box, m.id);
      m._stampKnown = true;
    }
    return m;
  };
  let msg = null, moved = false;
  try { msg = await graphGet(box, `${base}/messages/${enc(id)}?$select=${select}`, PREFER_TEXT); }
  catch (err) {
    if (!(err && err.response && err.response.status === 404)) throw err;
    const known = recall(_index, `${s(itemId)}|${source}|${id}`);
    if (!known || !known.imid) throw notFound('gone');
    const page = await graphGet(box, `${base}/messages?$filter=${enc(`internetMessageId eq '${known.imid.replace(/'/g, "''")}'`)}&$top=5&$select=${select}`, PREFER_TEXT);
    for (const cand of (page && page.value) || []) {
      if (!ID_RE.test(s(cand.id))) continue;
      const c = await prep(cand);
      if (c && rules.matchMessage(c, keys).include) { msg = c; moved = true; break; }
    }
    if (!msg) throw notFound('moved-elsewhere');
  }
  if (!moved) msg = await prep(msg);
  if (!msg) throw notFound('not-old-inbox');
  const m = rules.matchMessage(msg, keys);
  if (!m.include) throw notFound(m.out);
  return { msg, m, keys, box, moved };
}

const shortHash = (v) => crypto.createHash('sha256').update(low(v) || 'none').digest('hex').slice(0, 10);

function attachmentKind(a) {
  const t = s(a && a['@odata.type']);
  if (/itemAttachment/i.test(t)) return 'item';
  if (/referenceAttachment/i.test(t)) return 'reference';
  return 'file';
}
function safeName(name, kind) {
  let n = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (!n) n = 'attachment';
  if (kind === 'item' && !/\.eml$/i.test(n)) n += '.eml';
  return n;
}
function blockedWhy(a) {
  const name = s(a && a.name).toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (BLOCKED_EXT.has(ext) || BLOCKED_TYPES.test(s(a && a.contentType))) return 'This file type can\'t be downloaded here — open it in Outlook.';
  return '';
}
function attachmentView(a) {
  const kind = attachmentKind(a);
  const size = Number(a && a.size) || 0;
  let note = '';
  if (kind === 'reference') note = 'A link — open it in Outlook.';
  else if (blockedWhy(a)) note = blockedWhy(a);
  else if (size > ATTACH_MAX_BYTES) note = 'Too large to download here — open it in Outlook.';
  return { id: s(a.id), name: safeName(a.name, kind), size, kind, downloadable: !note && ID_RE.test(s(a.id)), note };
}

/**
 * One email for the pop-up: headers, its text (this message first, the whole thread on request), the attachment
 * list. Throws { notFound } when it is not (or no longer) on this case.
 */
async function open({ itemId, caseRef, row, source, id, viewer }) {
  const { msg, m, box } = await resolveMessage({ itemId, caseRef, row, source, id });
  // the page asks for attachments by the id it is given here (a moved email's NEW id): remember it too
  remember(_index, `${s(itemId)}|${source}|${s(msg.id)}`, { imid: s(msg.internetMessageId) });
  const item = rules.listItem(msg, m);
  if (m.sharedRisk && isLimitedFor(viewer)) return { item: restrict(item), restricted: true };
  const people = (k) => (msg[k] || []).map(rules.person).filter((p) => p.address);
  const uniq = s(msg.uniqueBody && msg.uniqueBody.content);
  const whole = s(msg.body && msg.body.content);
  let attachments = [], inline = 0;
  if (msg.hasAttachments) {
    const page = await graphGet(box, `${GRAPH}/users/${enc(box)}/messages/${enc(msg.id)}/attachments?$select=id,name,contentType,size,isInline`);
    for (const a of (page && page.value) || []) {
      if (a && a.isInline) { inline++; continue; }
      const v = attachmentView(a);
      attachments.push(v);
      remember(_attIndex, `${s(itemId)}|${source}|${s(msg.id)}|${v.id}`, { name: s(a.name), size: Number(a.size) || 0 });
    }
  }
  return {
    item: { ...item, id: s(msg.id), to: people('toRecipients').map((p) => p.address), toMore: 0 },
    from: rules.person(msg.from || msg.sender),
    toPeople: people('toRecipients'), ccPeople: people('ccRecipients'), replyToPeople: people('replyTo'),
    unique: textSegments(uniq || whole),
    whole: uniq && whole && whole !== uniq ? textSegments(whole) : null,
    attachments, inlineImages: inline,
    imidHash: shortHash(msg.internetMessageId),
  };
}

/**
 * One attachment as a stream. The email is fetched and matched again for this case first; after a move the
 * attachment is found again by its name and size (its id changes with the email's). Answers
 * { stream, name } or { refused: { status, error } }; throws { notFound }.
 */
async function attachment({ itemId, caseRef, row, source, id, att, viewer }) {
  if (!ID_RE.test(String(att || ''))) throw notFound('bad-request');
  const { msg, m, box, moved } = await resolveMessage({ itemId, caseRef, row, source, id, select: rules.SELECT });
  if (m.sharedRisk && isLimitedFor(viewer)) return { refused: { status: 403, error: 'This email may belong to another case, so its attachments are not shown here.' } };
  const page = await graphGet(box, `${GRAPH}/users/${enc(box)}/messages/${enc(msg.id)}/attachments?$select=id,name,contentType,size,isInline`);
  const list = ((page && page.value) || []).filter((a) => a && ID_RE.test(s(a.id)));
  let a = list.find((x) => s(x.id) === att);
  if (!a && moved) {
    const was = recall(_attIndex, `${s(itemId)}|${source}|${id}|${att}`);
    const same = was ? list.filter((x) => s(x.name) === was.name && (Number(x.size) || 0) === was.size) : [];
    if (same.length === 1) a = same[0];
  }
  if (!a) throw notFound('attachment-gone');
  const v = attachmentView(a);
  if (!v.downloadable) return { refused: { status: v.kind === 'reference' ? 409 : v.size > ATTACH_MAX_BYTES ? 413 : 415, error: v.note } };
  const r = await graphCall(box, (h) => io.stream(`${GRAPH}/users/${enc(box)}/messages/${enc(msg.id)}/attachments/${enc(s(a.id))}/$value`, h));
  return { stream: r.data, name: v.name, size: v.size, imidHash: shortHash(msg.internetMessageId) };
}

module.exports = {
  mode, officeMailbox, oldMailbox, MAILBOX, list, open, attachment, forViewer, caseKeys, readCaseRow: (itemId) => io.readCaseRow(itemId),
  // tests
  io, ID_RE, CM_EMAIL_COL, CM_REF_COL, BLOCKED_EXT, ATTACH_MAX_BYTES, LIST_TTL_MS, REFRESH_MIN_MS, attachmentView, safeName,
  _reset: () => { _lists.clear(); _inflight.clear(); _shared.clear(); _index.clear(); _attIndex.clear(); _flight.clear(); _folders = { box: '', at: 0, ids: null }; _oldInbox = { box: '', at: 0, id: '' }; },
};
