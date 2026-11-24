'use strict';

/**
 * The Client ID backfill — WHO is one person, and in what order they get their
 * number (step 6, 2026-11-25). PURE: no I/O. scripts/backfill-client-ids.js reads
 * the boards, hands the rows in here, and writes what comes out.
 *
 * Owner decisions (2026-11-25): every person behind a Client Master row gets ONE
 * Client ID ("CL-2026-00042"), in every group (Cancel / Did not retained and the
 * Leads group too, labelled); never the TEST group, Template / ZZ-TEST rows, or
 * the old 2024 consultations board (it is not read at all). Gauri answers a
 * check list for the unclear groups; a blank answer means DIFFERENT people (two
 * IDs can be joined later; one ID on two people mixes their files).
 *
 * How people are found (the app's own strict rule — classifyMatch 'exact': the
 * same email + the same name, or the same phone + the same name when one side has
 * no email):
 *   1. every Active Clients row is a person already; a Merged one folds into the
 *      record it was merged into (a chain is followed, with a loop guard — review #9);
 *   2. a Client Master row with no client record joins the record its consultation
 *      record names, else the record it matches exactly;
 *   3. the rest join each other by the same rule;
 *   4. weaker likenesses make an AMBER group for a Y/N answer: the same email under
 *      different names (spouses share one), the same phone with different emails or
 *      names, names that only match once "(2726)"-style bits are removed (the
 *      decorated Client Master name is only ever a PROPOSAL — review / trap iv).
 *      A group never holds two existing client records: joining those is the merge
 *      tool's job, never the backfill's.
 *
 * Buckets (one sheet row each):
 *   GREEN     one person, found by the strict rule. Gets an ID.
 *   AMBER     a "same person?" question. Y → one person, one ID; N or blank → one ID each.
 *   RED       no email and no phone at all (after the placeholder guard): its own person,
 *             flagged. Gets an ID.
 *   NO-CASE   a Clients row with no Client Master row behind it, or one that looks like a
 *             test (review #7). No ID without a Y in "Give a Client ID?".
 *   EXCLUDED  TEST group / test-looking Client Master rows, Archived Clients rows, rows
 *             whose client-record link is broken (fix the link, run again). Never an ID.
 *
 * Placeholder guard (review #8): an email or phone used by MORE than 3 different names
 * (an agent's inbox, the office phone, "noemail@…") is treated as blank for matching,
 * listed, and never written as anyone's email.
 *
 * Year (decision 5, review #15): the Toronto year the person first came — the earliest
 * of the case-number year, the consultation record's date and its Retainer Signed date;
 * only when there is none of those the Client Master row's date (the 'Retainers before
 * May 2026' rows were bulk-made, so that date is the import, not the client), then the
 * client record's. Never later than this year. Numbers run in that first-seen order.
 *
 * Nothing here ever renumbers: a person whose record already holds a Client ID keeps it.
 */

const { normName } = require('./handoffService');
const { normalizeEmail, normalizePhone, classifyMatch } = require('./clientAccountService');
const { looksTest } = require('./clientIdHealer');
const { caseStanding } = require('./clientIdDisplay');
const { isTestGroup } = require('../utils/caseGroups');
const { isClientId, clientIdNumber, formatClientId } = require('../utils/clientId');
const { torontoYear } = require('../utils/torontoTime');

const PLACEHOLDER_NAMES = 3;           // an email / phone with MORE distinct names than this is a placeholder
const MAX_MERGE_HOPS = 10;
const FIRST_YEAR = 2000;
const CASE_REF_SHAPE = /^(\d{4})-[A-Z]+(?:-[A-Z]+)*-\d{3,}$/;
// Local parts that are never a person's inbox.
const PLACEHOLDER_LOCAL = /^(?:no-?e?-?mail|none|na|n\/a|nil|null|unknown|noreply|no-?reply|donotreply|test|abc|xyz|asdf|email|mail|x+)$/i;

const BUCKETS = ['GREEN', 'AMBER', 'RED', 'NO-CASE', 'EXCLUDED'];

const s = (v) => String(v == null ? '' : v).trim();
const digits = (v) => s(v).replace(/\D/g, '');
const uniq = (a) => [...new Set(a.filter(Boolean))];
const byNum = (a, b) => Number(a) - Number(b);

/**
 * PURE — the clustering name key: lower case, without "(2726)"-style decorations,
 * passport / file-number tokens and punctuation (scripts/backfill-client-accounts.js).
 * Used ONLY to PROPOSE an AMBER group, never to join on its own.
 */
function clusterNormName(v) {
  return s(v).toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b[a-z]{0,2}\d{4,}\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** PURE — a decorated Client Master name made readable ("Amritpal Kaur (2726)" → "Amritpal Kaur"). A proposal only. */
function cleanDisplayName(v) {
  const t = s(v)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b[A-Za-z]{0,2}\d{4,}\b/g, ' ')
    .replace(/\s*[-–—|]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || s(v);
}

/** The email inside a Monday email cell's text ("Jane - jane@x.com" or "jane@x.com"), normalized; '' when none. */
function emailOf(text) {
  const m = /[^\s<>"'(),;]+@[^\s<>"'(),;]+\.[^\s<>"'(),;]+/.exec(s(text));
  return m ? normalizeEmail(m[0]) : '';
}

/** A placeholder by its look alone ("noemail@…", "0000000000"). */
function looksPlaceholderEmail(e) { return !!e && PLACEHOLDER_LOCAL.test(e.split('@')[0]); }
function looksPlaceholderPhone(p) { return !!p && /^(\d)\1+$/.test(p); }

/**
 * A time value as { ms, year } in Toronto — or null. A date-only '2026-01-01' is a
 * Toronto day already (new Date() would make it 31 Dec in Toronto): its year is its own.
 */
function timeInfo(v) {
  const t = s(v);
  if (!t) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (dateOnly) {
    const ms = Date.parse(`${t}T12:00:00Z`);
    return Number.isFinite(ms) ? { ms, year: Number(dateOnly[1]) } : null;
  }
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const year = torontoYear(ms);
  return Number.isFinite(year) ? { ms, year } : null;
}

/** The year a case number carries ("2026-CEC-EE-108" → 2026), or 0 ('2394', 'Supervisa', blank). */
function refYear(ref, nowYear) {
  const m = CASE_REF_SHAPE.exec(s(ref));
  if (!m) return 0;
  const y = Number(m[1]);
  return y >= FIRST_YEAR && y <= nowYear ? y : 0;
}

/* ───────────────────────────── parsing raw Monday items ───────────────────────────── */

/** Client Master columns the backfill reads (the handoff's own ids). */
const CM_COL = { caseRef: 'text_mm142s49', clientEmail: 'text_mm0xw6bp', clientPhone: 'phone_mm33zr0c', caseStage: 'color_mm0x8faa' };

/** The text of a column, or null when it did not come back in the read (never read as blank). */
function cellOf(item, col) {
  if (!col) return undefined;
  const c = ((item && item.column_values) || []).find((x) => x.id === col);
  return c ? s(c.text) : null;
}

/** Clients rows (raw items) → plan rows. clientIdText null = the box was not read; undefined = no column yet. */
function parseClients(items, cfg) {
  const c = cfg.columns;
  return (items || []).map((it) => ({
    id: s(it.id), name: s(it.name), createdAt: s(it.created_at),
    email: emailOf(cellOf(it, c.primaryEmail)), phone: s(cellOf(it, c.phone)), dob: s(cellOf(it, c.dateOfBirth)),
    status: s(cellOf(it, c.status)), mergedInto: s(cellOf(it, c.mergedInto)),
    clientIdText: c.clientId ? cellOf(it, c.clientId) : undefined,
  }));
}

/** Client Master rows (raw items) → plan rows. accountId null = the link box was not read. */
function parseCases(items, cfg) {
  const l = cfg.cmLinkColumns || {};
  return (items || []).map((it) => ({
    id: s(it.id), name: s(it.name), createdAt: s(it.created_at),
    group: { id: s(it.group && it.group.id), title: s(it.group && it.group.title) },
    caseRef: s(cellOf(it, CM_COL.caseRef)), caseStage: s(cellOf(it, CM_COL.caseStage)),
    email: emailOf(cellOf(it, CM_COL.clientEmail)), phone: s(cellOf(it, CM_COL.clientPhone)),
    accountId: l.clientAccountId ? cellOf(it, l.clientAccountId) : null,
    copy: l.clientId ? cellOf(it, l.clientId) : undefined,
  }));
}

/** Lead Board rows (raw items) → plan rows. */
function parseLeads(items, cfg, leadCols) {
  const lc = leadCols || {};
  const copyCol = (cfg.leadLinkColumns || {}).clientId;
  return (items || []).map((it) => ({
    id: s(it.id), name: s(it.name), createdAt: s(it.created_at),
    fullName: s(cellOf(it, lc.fullName)) || s(it.name),
    email: emailOf(cellOf(it, lc.email)), phone: s(cellOf(it, lc.phone)),
    cmItemId: digits(cellOf(it, lc.clientMasterItemId)),
    accountId: lc.clientAccountId ? cellOf(it, lc.clientAccountId) : null,
    retainerSigned: s(cellOf(it, lc.retainerSigned)),
    residentialAddress: s(cellOf(it, lc.residentialAddress)),
    copy: copyCol ? cellOf(it, copyCol) : undefined,
  }));
}

/* ───────────────────────────── following "Merged into" ───────────────────────────── */

/**
 * PURE, synchronous twin of clientAccountService.resolveAccount over rows already read:
 * the record a record number stands for today. Stops on a missing record, a loop, an
 * Archived end, a Merged record with no target, a Client ID on two records, too many steps.
 */
function resolveRow(startId, byId, byNumber) {
  const path = [];
  let id = /^\d+$/.test(s(startId)) ? s(startId) : '';
  if (!id) return { ok: false, reason: 'bad-link', path };
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    if (path.includes(id)) return { ok: false, reason: 'cycle', path: [...path, id] };
    path.push(id);
    const row = byId.get(id);
    if (!row) return { ok: false, reason: 'missing', path };
    if (row.status === 'Archived') return { ok: false, reason: 'archived', path };
    if (row.status !== 'Merged') return { ok: true, accountId: row.id, row, path, merged: path.length > 1 };
    const into = s(row.mergedInto);
    if (/^\d+$/.test(into)) { id = into; continue; }
    if (!isClientId(into)) return { ok: false, reason: 'merged-nowhere', path };
    const hits = byNumber.get(clientIdNumber(into)) || [];
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', path };
    if (!hits.length) return { ok: false, reason: 'missing', path };
    id = hits[0].id;
  }
  return { ok: false, reason: 'too-deep', path };
}

const LINK_WORDS = {
  missing: 'a client record that is not on the Clients board',
  cycle: 'a client record joined into another in a loop',
  archived: 'an Archived client record',
  'merged-nowhere': 'a client record marked Merged without saying into which',
  ambiguous: 'a client record joined into a Client ID found on two records',
  'too-deep': 'a client record joined over more than 10 times',
  'bad-link': 'something that is not a record number',
};

/* ───────────────────────────── the block of numbers ───────────────────────────── */

/**
 * PURE — where a reserved block of k numbers starts: right after `last`, moved past any
 * number already typed inside it (clientIdAllocator.allocateBlock does the same, so the
 * dry run's proposed numbers are the ones the apply gets while nothing changes).
 */
function blockStart(last, k, used) {
  let first = Number(last) + 1;
  const list = [...(used || [])].filter((n) => n > 0);
  for (let guard = 0; guard < list.length + 1; guard++) {
    let hit = 0;
    for (const u of list) if (u >= first && u <= first + k - 1 && u > hit) hit = u;
    if (!hit) break;
    first = hit + 1;
  }
  return first;
}

/* ───────────────────────────── answers ───────────────────────────── */

/** "Y", "yes", "n", "No" → 'Y' / 'N'; blank → ''; anything else → '?' (read as blank, and listed). */
function readAnswer(v) {
  const t = s(v).toLowerCase();
  if (!t) return '';
  if (t === 'y' || t === 'yes') return 'Y';
  if (t === 'n' || t === 'no') return 'N';
  return '?';
}

/* ───────────────────────────── the plan ───────────────────────────── */

/**
 * PURE. Who is one person, their bucket, year and proposed number.
 *
 * @param {{ clients: object[], cases: object[], leads: object[] }} rows  parse*() output
 * @param {object} [opts]
 * @param {number} [opts.now]          ms (default Date.now())
 * @param {number|null} [opts.counterLast]  the counter's last number (null/undefined = not read: the highest typed number is used)
 * @param {Map<string,{same:string,give:string}>|object} [opts.decisions]  answers by sheet key
 * @param {string[]} [opts.order]      sheet keys in the dry run's number order (readDecisions; people new since go last)
 * @param {Map<string,Array<number|null>>|object} [opts.proposed]  each key's proposed numbers from the answered sheet (readDecisions) — the apply's order
 * @param {number} [opts.placeholderNames]
 */
function buildPlan({ clients = [], cases = [], leads = [] } = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const nowYear = torontoYear(now);
  const limit = Number.isFinite(opts.placeholderNames) ? opts.placeholderNames : PLACEHOLDER_NAMES;
  const decisions = opts.decisions instanceof Map ? opts.decisions : new Map(Object.entries(opts.decisions || {}));
  const answer = (key) => decisions.get(key) || { same: '', give: '' };

  const excluded = [];      // { kind, id, name, caseRef, reason }
  const unreadable = [];    // { kind, id, name, caseRef, reason }
  const merged = [];        // { id, name, into, intoName }

  /* ── the Clients board ── */
  const byId = new Map(clients.map((r) => [r.id, r]));
  const byNumber = new Map();
  for (const r of clients) if (isClientId(r.clientIdText)) { const n = clientIdNumber(r.clientIdText); byNumber.set(n, [...(byNumber.get(n) || []), r]); }
  const resolve = (id) => resolveRow(digits(id), byId, byNumber);

  /* ── which Client Master rows are in ── */
  const leadsByCase = new Map();
  for (const l of leads) if (l.cmItemId) leadsByCase.set(l.cmItemId, [...(leadsByCase.get(l.cmItemId) || []), l]);

  const eligible = [];
  for (const c of cases) {
    if (c.accountId === null) { unreadable.push({ kind: 'case', id: c.id, name: c.name, caseRef: c.caseRef, reason: 'its client-record box did not come back in the read — left alone' }); continue; }
    if (isTestGroup(c.group)) { excluded.push({ kind: 'case', id: c.id, name: c.name, caseRef: c.caseRef, reason: 'in the TEST group' }); continue; }
    if (looksTest(c.name, c.email)) { excluded.push({ kind: 'case', id: c.id, name: c.name, caseRef: c.caseRef, reason: 'looks like a test or template row' }); continue; }
    eligible.push(c);
  }
  const eligibleIds = new Set(eligible.map((c) => c.id));

  /* ── placeholder emails / phones (review #8) ── */
  const scopeLeads = leads.filter((l) => eligibleIds.has(l.cmItemId) || digits(l.accountId));
  const namesBy = { e: new Map(), p: new Map() };
  const count = (kind, value, name) => {
    if (!value) return;
    const key = clusterNormName(name) || normName(name);
    if (!key) return;
    const m = namesBy[kind];
    if (!m.has(value)) m.set(value, new Set());
    m.get(value).add(key);
  };
  for (const r of clients) { count('e', normalizeEmail(r.email), r.name); count('p', normalizePhone(r.phone), r.name); }
  for (const c of eligible) { count('e', normalizeEmail(c.email), c.name); count('p', normalizePhone(c.phone), c.name); }
  for (const l of scopeLeads) { count('e', normalizeEmail(l.email), l.fullName); count('p', normalizePhone(l.phone), l.fullName); }
  const placeholders = { emails: [], phones: [] };
  const badEmail = new Set(), badPhone = new Set();
  for (const [e, names] of namesBy.e) if (names.size > limit || looksPlaceholderEmail(e)) { badEmail.add(e); placeholders.emails.push({ value: e, names: names.size }); }
  for (const [p, names] of namesBy.p) if (names.size > limit || looksPlaceholderPhone(p)) { badPhone.add(p); placeholders.phones.push({ value: p, names: names.size }); }
  const effEmail = (v) => { const e = normalizeEmail(v); return e && !badEmail.has(e) && !looksPlaceholderEmail(e) ? e : ''; };
  const effPhone = (v) => { const p = normalizePhone(v); return p && !badPhone.has(p) && !looksPlaceholderPhone(p) ? p : ''; };

  /* ── units: an Active client record, or a group of Client Master rows with none ── */
  const units = [];
  const unitOfAccount = new Map();
  const notesOf = (u) => u.notes;
  for (const r of clients) {
    if (r.status === 'Merged') continue;
    if (r.status === 'Archived') { excluded.push({ kind: 'client', id: r.id, name: r.name, reason: 'Archived on the Clients board' }); continue; }
    const u = { kind: 'account', account: r, cases: [], leads: [], notes: [], moves: [] };
    if (r.clientIdText === null) u.notes.push('Its Client ID box did not come back in the read — no number this run');
    else if (s(r.clientIdText) && !isClientId(r.clientIdText)) u.notes.push(`Its Client ID box holds "${s(r.clientIdText).slice(0, 40)}", which is not a Client ID — left as it is (never typed over)`);
    units.push(u);
    unitOfAccount.set(r.id, u);
  }
  for (const r of clients) {
    if (r.status !== 'Merged') continue;
    const res = resolve(r.id);
    if (res.ok) merged.push({ id: r.id, name: r.name, into: res.accountId, intoName: res.row.name });
    else excluded.push({ kind: 'client', id: r.id, name: r.name, reason: `Merged, but it points at ${LINK_WORDS[res.reason] || 'nothing usable'}` });
  }

  // A lead → the record it names (resolved), or null.
  const leadAccount = (l) => {
    if (!digits(l.accountId)) return null;
    const res = resolve(l.accountId);
    return res.ok ? res.accountId : null;
  };

  const loose = [];   // Client Master rows with no usable client record
  for (const c of eligible) {
    const own = digits(c.accountId);
    if (own) {
      const res = resolve(own);
      if (!res.ok) { excluded.push({ kind: 'case', id: c.id, name: c.name, caseRef: c.caseRef, reason: `linked to ${LINK_WORDS[res.reason] || 'a record that cannot be used'} — fix the link, then run again` }); continue; }
      const u = unitOfAccount.get(res.accountId);
      u.cases.push(c);
      if (res.merged) u.moves.push(c.id);
      continue;
    }
    // No record on the case: the one its consultation record names, when exactly one.
    const named = uniq((leadsByCase.get(c.id) || []).map(leadAccount));
    if (named.length === 1 && unitOfAccount.has(named[0])) {
      unitOfAccount.get(named[0]).cases.push(c);
      continue;
    }
    if (named.length > 1) loose.push({ c, note: 'Its consultation records name different client records — matched on its details instead' });
    else loose.push({ c, note: '' });
  }

  // Identity of a group of Client Master rows (the leads give the clean name — never only the decorated one).
  const identityOfCases = (list) => {
    const names = [], looseNames = [], emails = [], phones = [];
    for (const c of list) {
      const ls = leadsByCase.get(c.id) || [];
      for (const l of ls) { names.push(l.fullName); emails.push(effEmail(l.email)); phones.push(effPhone(l.phone)); }
      names.push(c.name); emails.push(effEmail(c.email)); phones.push(effPhone(c.phone));
    }
    const strict = uniq(names.map(normName));
    for (const n of names) looseNames.push(clusterNormName(n));
    return { rawNames: uniq(names.map(s)), strict, loose: uniq(looseNames), emails: uniq(emails), phones: uniq(phones) };
  };
  const identityOfAccount = (r) => ({
    rawNames: [r.name], strict: uniq([normName(r.name)]), loose: uniq([clusterNormName(r.name)]),
    emails: uniq([effEmail(r.email)]), phones: uniq([effPhone(r.phone)]), dob: r.dob,
  });

  /** The app's strict rule between two identities (classifyMatch 'exact' on some name/email/phone of each). */
  const strictMatch = (a, b) => {
    const ea = a.emails.length ? a.emails : [''], pa = a.phones.length ? a.phones : [''];
    const eb = b.emails.length ? b.emails : [''], pb = b.phones.length ? b.phones : [''];
    for (const n of a.rawNames) for (const e of ea) for (const p of pa) for (const m of b.rawNames) for (const e2 of eb) for (const p2 of pb) {
      if (classifyMatch({ email: e, phone: p, fullName: n, dob: a.dob }, { email: e2, phone: p2, name: m, dob: b.dob }).confidence === 'exact') return true;
    }
    return false;
  };

  // Index the accounts by contact for the matching below.
  const accountIdentity = new Map();
  const accByEmail = new Map(), accByPhone = new Map();
  for (const u of units) {
    const idn = identityOfAccount(u.account);
    accountIdentity.set(u.account.id, idn);
    for (const e of idn.emails) accByEmail.set(e, [...(accByEmail.get(e) || []), u]);
    for (const p of idn.phones) accByPhone.set(p, [...(accByPhone.get(p) || []), u]);
  }
  const candidatesFor = (idn) => {
    const out = new Set();
    for (const e of idn.emails) for (const u of accByEmail.get(e) || []) out.add(u);
    for (const p of idn.phones) for (const u of accByPhone.get(p) || []) out.add(u);
    return [...out].sort((a, b) => byNum(a.account.id, b.account.id));
  };

  // 2. a loose case that exactly matches a client record joins it (the lowest record number when two do).
  const stillLoose = [];
  for (const { c, note } of loose) {
    const idn = identityOfCases([c]);
    const exact = candidatesFor(idn).filter((u) => strictMatch(idn, accountIdentity.get(u.account.id)));
    if (exact.length) {
      exact[0].cases.push(c);
      if (exact.length > 1) exact[0].notes.push(`${c.caseRef || c.name}: matches ${exact.length} client records exactly — joined to the oldest (see "Same person twice" on Needs attention)`);
      if (note) exact[0].notes.push(`${c.caseRef || c.name}: ${note}`);
      continue;
    }
    stillLoose.push({ c, note, idn });
  }

  // 3. loose cases join each other by the strict rule (union-find).
  const parent = stillLoose.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const bucketKeys = new Map();
  stillLoose.forEach((x, i) => {
    for (const n of x.idn.strict) {
      for (const e of x.idn.emails) bucketKeys.set(`e|${e}|${n}`, [...(bucketKeys.get(`e|${e}|${n}`) || []), i]);
      for (const p of x.idn.phones) bucketKeys.set(`p|${p}|${n}`, [...(bucketKeys.get(`p|${p}|${n}`) || []), i]);
    }
  });
  for (const list of bucketKeys.values()) {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const i = list[a], j = list[b];
      if (find(i) === find(j)) continue;
      if (strictMatch(stillLoose[i].idn, stillLoose[j].idn)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  stillLoose.forEach((x, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(x); });
  for (const list of groups.values()) {
    const u = { kind: 'new', account: null, cases: list.map((x) => x.c), leads: [], notes: list.filter((x) => x.note).map((x) => `${x.c.caseRef || x.c.name}: ${x.note}`), moves: [] };
    units.push(u);
  }

  /* ── leads of each unit ── */
  const caseUnit = new Map();
  for (const u of units) for (const c of u.cases) caseUnit.set(c.id, u);
  // A consultation record belongs to a person only when its client-record box is blank or
  // names that person's record (directly or through a Merged one) — it is then (re)linked.
  // One that names ANOTHER record, a broken link, or did not come back is never written.
  for (const l of leads) {
    if (l.accountId === null) continue;   // its client-record box did not come back: never relinked
    const named = leadAccount(l);
    const viaCase = l.cmItemId ? caseUnit.get(l.cmItemId) : null;
    if (digits(l.accountId) && !named) {
      if (viaCase) viaCase.notes.push(`A consultation record of ${l.fullName || 'this client'} points at ${LINK_WORDS[resolve(l.accountId).reason] || 'a record that cannot be used'} — it is left as it is`);
      continue;
    }
    if (viaCase) {
      if (named && viaCase.account && named !== viaCase.account.id) {
        viaCase.notes.push(`A consultation record of ${l.fullName || 'this client'} points at another client record (${(byId.get(named) || {}).name || 'another client'}) — it is left as it is`);
        const other = unitOfAccount.get(named);
        if (other) other.leads.push(l);
        continue;
      }
      if (named && !viaCase.account) {
        // a new person whose case's lead names a record that the case did not join (two records named) — never relinked
        viaCase.notes.push(`A consultation record of ${l.fullName || 'this client'} points at a client record of its own — it is left as it is`);
        continue;
      }
      viaCase.leads.push(l);
      continue;
    }
    if (named && unitOfAccount.has(named)) unitOfAccount.get(named).leads.push(l);
  }

  /* ── first seen, and the facts of each unit ── */
  const firstSeen = (u) => {
    const strong = [], weak = [], weakest = [];
    let rYear = 0;
    for (const c of u.cases) {
      const y = refYear(c.caseRef, nowYear);
      if (y && (!rYear || y < rYear)) rYear = y;
      const t = timeInfo(c.createdAt); if (t) weak.push(t);
    }
    for (const l of u.leads) {
      const a = timeInfo(l.createdAt); if (a) strong.push({ ...a, from: 'consultation record' });
      const b = timeInfo(l.retainerSigned); if (b) strong.push({ ...b, from: 'retainer signed' });
    }
    if (u.account) { const t = timeInfo(u.account.createdAt); if (t) weakest.push(t); }
    let year = 0, from = '';
    const minStrong = strong.reduce((m, t) => (!m || t.year < m.year || (t.year === m.year && t.ms < m.ms) ? t : m), null);
    if (rYear && (!minStrong || rYear <= minStrong.year)) { year = rYear; from = 'case number'; }
    if (minStrong && (!year || minStrong.year < year)) { year = minStrong.year; from = minStrong.from; }
    if (!year && weak.length) { year = Math.min(...weak.map((t) => t.year)); from = 'Client Master row made'; }
    if (!year && weakest.length) { year = weakest[0].year; from = 'client record made'; }
    if (!year) { year = nowYear; from = 'now'; }
    if (year > nowYear) { year = nowYear; from = `${from} (capped at this year)`; }
    const inYear = [...strong, ...weak, ...weakest].filter((t) => t.year === year).map((t) => t.ms);
    return { year, from, at: inYear.length ? Math.min(...inYear) : null };
  };
  const mergeIdn = (a, b) => ({
    rawNames: uniq([...a.rawNames, ...b.rawNames]), strict: uniq([...a.strict, ...b.strict]), loose: uniq([...a.loose, ...b.loose]),
    emails: uniq([...a.emails, ...b.emails]), phones: uniq([...a.phones, ...b.phones]), dob: a.dob,
  });
  for (const u of units) {
    // A client record's own details plus those of its cases (for the likeness check and "no email or phone").
    u.idn = u.account ? mergeIdn(accountIdentity.get(u.account.id), identityOfCases(u.cases)) : identityOfCases(u.cases);
    u.anchor = u.cases.length ? `C${u.cases.map((c) => c.id).sort(byNum)[0]}` : `A${u.account.id}`;
    u.minItem = Math.min(...[...u.cases.map((c) => Number(c.id)), ...(u.account ? [Number(u.account.id)] : [])]);
    u.seen = firstSeen(u);
    u.testLooking = !!(u.account && looksTest(u.account.name, u.account.email));
  }

  /* ── 4. weaker likenesses → AMBER groups (never two existing client records in one) ── */
  const amberable = units.filter((u) => u.cases.length && !u.testLooking);
  const links = [];
  const byContact = new Map();
  for (const u of amberable) {
    for (const e of u.idn.emails) byContact.set(`e|${e}`, [...(byContact.get(`e|${e}`) || []), u]);
    for (const p of u.idn.phones) byContact.set(`p|${p}`, [...(byContact.get(`p|${p}`) || []), u]);
  }
  const seenPair = new Set();
  for (const [key, list] of byContact) {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const x = list[a], y = list[b];
      if (x === y || (x.account && y.account)) continue;
      const pair = [x.anchor, y.anchor].sort().join('|');
      const reasons = [];
      const sharedLoose = x.idn.loose.some((n) => n && y.idn.loose.includes(n));
      if (key.startsWith('e|')) reasons.push(sharedLoose ? 'the same email, and the names match once extra bits like file numbers are removed' : 'the same email under different names (spouses and family often share one)');
      else if (x.idn.emails.length && y.idn.emails.length && !x.idn.emails.some((e) => y.idn.emails.includes(e))) reasons.push('the same phone with different emails');
      else reasons.push(sharedLoose ? 'the same phone, and the names match once extra bits are removed' : 'the same phone under different names');
      links.push({ x, y, pair, reasons });
      seenPair.add(pair);
    }
  }
  links.sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
  const gParent = new Map(units.map((u) => [u, u]));
  const gFind = (u) => { while (gParent.get(u) !== u) { gParent.set(u, gParent.get(gParent.get(u))); u = gParent.get(u); } return u; };
  const gAccounts = new Map(units.map((u) => [u, u.account ? 1 : 0]));
  const gReasons = new Map(units.map((u) => [u, new Set()]));
  for (const lk of links) {
    const rx = gFind(lk.x), ry = gFind(lk.y);
    if (rx === ry) { lk.reasons.forEach((r) => gReasons.get(rx).add(r)); continue; }
    if (gAccounts.get(rx) + gAccounts.get(ry) > 1) {
      const nm = (u) => (u.account ? u.account.name : u.idn.rawNames[0]) || 'another client';
      lk.x.notes.push(`May be the same person as ${nm(lk.y)} (${lk.reasons.join('; ')}) — two client records would be joined, which the backfill never does; the admin can join them later`);
      lk.y.notes.push(`May be the same person as ${nm(lk.x)} (${lk.reasons.join('; ')}) — two client records would be joined, which the backfill never does; the admin can join them later`);
      continue;
    }
    gParent.set(ry, rx);
    gAccounts.set(rx, gAccounts.get(rx) + gAccounts.get(ry));
    const set = gReasons.get(rx);
    gReasons.get(ry).forEach((r) => set.add(r));
    lk.reasons.forEach((r) => set.add(r));
  }
  const comps = new Map();
  for (const u of units) { const r = gFind(u); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(u); }

  /* ── people (and the sheet rows) ── */
  const people = [];
  const rows = [];
  const caseKey = (list) => list.flatMap((u) => u.cases.map((c) => c.id)).sort(byNum).join('+');
  const personOf = (list, extra) => {
    const accountUnit = list.find((u) => u.account) || null;
    const cs = list.flatMap((u) => u.cases).sort((a, b) => byNum(a.id, b.id));
    const ls = list.flatMap((u) => u.leads);
    const seenL = list.map((u) => u.seen);
    const seen = seenL.reduce((m, t) => (!m || t.year < m.year || (t.year === m.year && (t.at == null ? Infinity : t.at) < (m.at == null ? Infinity : m.at)) ? t : m), null);
    const newestLead = [...ls].sort((a, b) => (timeInfo(b.createdAt) || { ms: 0 }).ms - (timeInfo(a.createdAt) || { ms: 0 }).ms)[0];
    const name = accountUnit ? accountUnit.account.name : (newestLead && newestLead.fullName) || cleanDisplayName(cs[0] && cs[0].name);
    const nameFrom = accountUnit ? 'client record' : newestLead && newestLead.fullName ? 'consultation record' : 'Client Master name, cleaned (a proposal)';
    const email = accountUnit ? effEmail(accountUnit.account.email) : (uniq([...(newestLead ? [effEmail(newestLead.email)] : []), ...ls.map((l) => effEmail(l.email)), ...cs.map((c) => effEmail(c.email))])[0] || '');
    const phone = accountUnit ? effPhone(accountUnit.account.phone) : (uniq([...(newestLead ? [effPhone(newestLead.phone)] : []), ...ls.map((l) => effPhone(l.phone)), ...cs.map((c) => effPhone(c.phone))])[0] || '');
    const anyContact = list.some((u) => u.idn.emails.length || u.idn.phones.length);
    const existing = accountUnit && isClientId(accountUnit.account.clientIdText) ? s(accountUnit.account.clientIdText) : '';
    const idBlocked = accountUnit && (accountUnit.account.clientIdText === null || (s(accountUnit.account.clientIdText) && !isClientId(accountUnit.account.clientIdText)));
    return {
      anchor: list.map((u) => u.anchor).sort()[0],
      members: list.map((u) => u.anchor).sort(),
      accountId: accountUnit ? accountUnit.account.id : '',
      existingId: existing,
      idBlocked: !!idBlocked,
      name, nameFrom, email, phone,
      residentialAddress: (newestLead && newestLead.residentialAddress) || '',
      cases: cs.map((c) => ({ id: c.id, caseRef: c.caseRef, name: c.name, group: c.group.title, standing: caseStanding({ group: c.group, caseStage: c.caseStage }).label, accountId: digits(c.accountId), copy: c.copy })),
      leads: ls.map((l) => ({ id: l.id, accountId: l.accountId === null ? null : digits(l.accountId), copy: l.copy })),
      moves: list.flatMap((u) => u.moves),
      year: seen.year, yearFrom: seen.from, firstSeenAt: seen.at,
      minItem: Math.min(...list.map((u) => u.minItem)),
      noContact: !anyContact,
      testLooking: list.some((u) => u.testLooking),
      notes: uniq(list.flatMap(notesOf).concat(cs.flatMap((c) => (!c.caseRef ? [`${c.name}: no case number (it needs one, or a look)`] : !CASE_REF_SHAPE.test(c.caseRef) ? [`${c.name}: unusual case number "${c.caseRef}"`] : [])))),
      ...extra,
    };
  };

  for (const list of comps.values()) {
    list.sort((a, b) => (a.anchor < b.anchor ? -1 : 1));
    if (list.length > 1) {
      const key = `G:${caseKey(list)}`;
      const ans = answer(key);
      const reasons = [...gReasons.get(gFind(list[0]))];
      const ps = ans.same === 'Y'
        ? [personOf(list, { bucket: 'AMBER', groupKey: key, joined: true })]
        : list.map((u) => personOf([u], { bucket: 'AMBER', groupKey: key, joined: false }));
      people.push(...ps);
      rows.push({ key, bucket: 'AMBER', people: ps, units: list, reasons, answer: ans });
      continue;
    }
    const u = list[0];
    let bucket, reason;
    if (!u.cases.length || u.testLooking) {
      bucket = 'NO-CASE';
      reason = u.testLooking ? 'This client record looks like a test (its name or email)' : u.leads.length ? 'This client record has no Client Master row — a consultation only' : 'This client record has no Client Master row behind it';
    } else if (!u.idn.emails.length && !u.idn.phones.length) {
      bucket = 'RED'; reason = 'No email and no phone — kept as its own person; it could not be matched with anyone';
    } else {
      bucket = 'GREEN'; reason = u.account ? (u.cases.length > 1 ? `One client record with ${u.cases.length} cases` : 'One client record') : u.cases.length > 1 ? `${u.cases.length} cases with the same name and email/phone` : 'One case, no other match';
    }
    const key = u.anchor;
    const ans = answer(key);
    const p = personOf([u], { bucket, reason });
    people.push(p);
    rows.push({ key, bucket, people: [p], units: [u], reasons: [reason], answer: ans });
  }

  /* ── who gets a NEW number, in what order ── */
  const rank = new Map((opts.order || []).map((k, i) => [k, i]));
  const tokenRank = new Map();
  for (const [k, i] of rank) {
    const toks = k.startsWith('G:') ? k.slice(2).split('+').map((x) => `C${x}`) : [k];
    for (const t of toks) if (!tokenRank.has(t) || tokenRank.get(t) > i) tokenRank.set(t, i);
  }
  const rankOf = (p) => {
    const toks = [...p.cases.map((c) => `C${c.id}`), ...(p.accountId ? [`A${p.accountId}`] : [])];
    let r = Infinity;
    for (const t of toks) if (tokenRank.has(t)) r = Math.min(r, tokenRank.get(t));
    return r;
  };
  // The number each person was PROPOSED on the answered sheet (ux review #1): the apply hands
  // the numbers out in that order, so a sheet sorted or filtered in Excel changes nothing.
  // A split AMBER row lists one number per person (in the same order as its people); a
  // joined one takes the lowest of them. No number on the sheet → after everyone who had one.
  const proposedMap = opts.proposed instanceof Map ? opts.proposed : new Map(Object.entries(opts.proposed || {}));
  const sheetN = new Map();
  for (const row of rows) {
    const nums = proposedMap.get(row.key);
    if (!Array.isArray(nums) || !nums.length) continue;
    const finite = nums.filter((n) => Number.isSafeInteger(n) && n > 0);
    if (!finite.length) continue;
    const lowest = Math.min(...finite);
    row.people.forEach((p, i) => {
      const own = nums.length === row.people.length ? nums[i] : null;
      sheetN.set(p, Number.isSafeInteger(own) && own > 0 ? own : lowest);
    });
  }
  const sheetNOf = (p) => (sheetN.has(p) ? sheetN.get(p) : Infinity);
  for (const row of rows) {
    for (const p of row.people) {
      p.key = row.key;
      p.give = row.answer.give || '';
      p.gets =!p.existingId && !p.idBlocked && (row.bucket !== 'NO-CASE' || row.answer.give === 'Y');
    }
  }
  const takers = people.filter((p) => p.gets).sort((a, b) =>
    (sheetNOf(a) - sheetNOf(b) || 0) || (rankOf(a) - rankOf(b) || 0) || (a.year - b.year)
    || ((a.firstSeenAt == null ? Infinity : a.firstSeenAt) - (b.firstSeenAt == null ? Infinity : b.firstSeenAt))
    || (a.minItem - b.minItem));
  const used = new Set();
  for (const r of clients) { const n = clientIdNumber(r.clientIdText); if (n) used.add(n); }
  for (const c of cases) { const n = clientIdNumber(c.copy); if (n) used.add(n); }
  const highestUsed = used.size ? Math.max(...used) : 0;
  const counterKnown = Number.isSafeInteger(opts.counterLast) && opts.counterLast >= 0;
  const last = counterKnown ? opts.counterLast : highestUsed;
  const first = takers.length ? blockStart(last, takers.length, used) : last + 1;
  takers.forEach((p, i) => { p.order = i; p.proposedN = first + i; p.proposedId = formatClientId(p.year, first + i); });
  for (const p of people) if (!p.gets) { p.proposedN = 0; p.proposedId = ''; }

  /* ── answers that no longer fit (the apply refuses on these) ── */
  const changed = [];
  const ignored = [];
  const rowKeys = new Map(rows.map((r) => [r.key, r]));
  for (const [key, a] of decisions) {
    if (a.same === '?' || a.give === '?') {
      const r = rowKeys.get(key);
      const who = r ? uniq(r.people.map((p) => p.name)).join(' / ') : '';
      ignored.push({ key, name: who, why: `the answer is not Y or N${who ? ` (${who})` : ''} — write Y, N or leave it blank` });
    }
    if (a.same === 'Y') {
      const r = rowKeys.get(key);
      if (r && r.bucket === 'AMBER') continue;
      // Already one person (a resumed apply): the very same cases, no more, no fewer.
      const want = key.startsWith('G:') ? key.slice(2) : '';
      const one = want && people.find((p) => p.cases.map((c) => c.id).sort(byNum).join('+') === want);
      if (one) continue;
      changed.push({ key, why: r ? `answered "same person", but it is no longer a question (now ${r.bucket})` : 'answered "same person", but that group changed since the check list was made' });
    }
    if (a.give === 'Y') {
      const r = rowKeys.get(key);
      if (r) continue;
      const accountId = key.startsWith('A') ? key.slice(1) : '';
      if (accountId && people.some((p) => p.accountId === accountId)) continue;
      changed.push({ key, why: 'answered "give a Client ID", but that client record is not there any more' });
    }
    if ((a.same && a.same !== 'Y' && !rowKeys.has(key)) || (a.give && a.give !== 'Y' && !rowKeys.has(key))) { /* a no / blank on a row that went: nothing to do */ }
  }

  /* ── counts ── */
  const bucketCounts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const r of rows) bucketCounts[r.bucket]++;
  bucketCounts.EXCLUDED += excluded.length;
  const yearCounts = {};
  for (const p of people) {
    const y = p.existingId ? Number(p.existingId.slice(3, 7)) : p.gets ? p.year : 0;
    if (y) yearCounts[y] = (yearCounts[y] || 0) + 1;
  }
  const counts = {
    clientsRows: clients.length, caseRows: cases.length, leadRows: leads.length,
    eligibleCases: eligible.length,
    sheetRows: rows.length, people: people.length,
    buckets: bucketCounts,
    amberQuestions: rows.filter((r) => r.bucket === 'AMBER').length,
    amberAnsweredSame: rows.filter((r) => r.bucket === 'AMBER' && r.answer.same === 'Y').length,
    noCaseAnsweredGive: rows.filter((r) => r.bucket === 'NO-CASE' && r.answer.give === 'Y').length,
    keepExisting: people.filter((p) => p.existingId).length,
    newIds: takers.length,
    newAccounts: people.filter((p) => p.gets && !p.accountId).length,
    blocked: people.filter((p) => p.idBlocked).length,
    unreadable: unreadable.length, excluded: excluded.length, merged: merged.length,
    placeholderEmails: placeholders.emails.length, placeholderPhones: placeholders.phones.length,
    firstNumber: takers.length ? first : 0, lastNumber: takers.length ? first + takers.length - 1 : 0,
    counterLast: counterKnown ? opts.counterLast : null, highestTyped: highestUsed,
  };

  return { people, takers, rows, excluded, unreadable, merged, placeholders, changed, ignored, counts, yearCounts, block: { first, count: takers.length } };
}

/* ───────────────────────────── the review sheet ───────────────────────────── */

// The two answer columns sit right after the key and bucket, beside the question itself (ux review #2).
// readDecisions reads by header name, so the column order may change; the header WORDS may not.
const SHEET_HEADERS = ['Key', 'Bucket', 'Same person? (Y/N)', 'Give a Client ID? (Y/N)', 'Why', 'Name', 'Proposed ID', 'Name from', 'Email', 'Phone', 'Cases', 'Groups', 'Year', 'Year from', 'Notes'];
const SHEET_WIDTHS = { Key: 16, Bucket: 9, 'Same person? (Y/N)': 12, 'Give a Client ID? (Y/N)': 12, Why: 60, Name: 28, 'Proposed ID': 30, 'Name from': 18, Email: 28, Phone: 14, Cases: 40, Groups: 22, Year: 6, 'Year from': 18, Notes: 60 };
const QUESTION_BUCKETS = new Set(['AMBER', 'NO-CASE']);

const caseText = (p) => p.cases.map((c) => `${c.caseRef || '(no case number)'} · ${c.standing}`).join('; ');
const groupText = (p) => uniq(p.cases.map((c) => c.group)).join('; ');

/**
 * PURE — the "People" sheet: one row per sheet key. The questions (AMBER, NO-CASE) come first,
 * then everyone else; each part in number order. Sorting or filtering it in Excel changes
 * nothing: the apply reads the numbers from the "Proposed ID" column, not the row order.
 */
function sheetRows(plan) {
  const rowOrder = [...plan.rows].sort((a, b) => {
    const qa = QUESTION_BUCKETS.has(a.bucket) ? 0 : 1, qb = QUESTION_BUCKETS.has(b.bucket) ? 0 : 1;
    if (qa !== qb) return qa - qb;
    const oa = Math.min(...a.people.map((p) => (p.gets ? p.order : Infinity)));
    const ob = Math.min(...b.people.map((p) => (p.gets ? p.order : Infinity)));
    if (oa !== ob) return oa - ob;
    return Math.min(...a.people.map((p) => p.minItem)) - Math.min(...b.people.map((p) => p.minItem));
  });
  return rowOrder.map((r) => {
    const ps = r.people;
    const idText = ps.map((p) => p.existingId ? `${p.existingId} (has it)` : p.proposedId || (r.bucket === 'NO-CASE' ? 'only with a Y' : p.idBlocked ? 'none this run' : '')).join(' / ');
    const many = ps.length > 1;
    const pick = (f) => uniq(ps.map(f)).join(' / ');
    const cell = {
      Key: r.key, Bucket: r.bucket,
      'Same person? (Y/N)': r.bucket === 'AMBER' ? (r.answer.same === 'Y' || r.answer.same === 'N' ? r.answer.same : '') : '',
      'Give a Client ID? (Y/N)': r.bucket === 'NO-CASE' ? (r.answer.give === 'Y' || r.answer.give === 'N' ? r.answer.give : '') : '',
      Why: r.bucket === 'AMBER' ? `Same person? ${r.reasons.join('; ')}. Y = one person, one Client ID. N or blank = ${r.units.length} different people.`
        : r.bucket === 'NO-CASE' ? `${r.reasons.join('; ')}. Y = give this client a Client ID. N or blank = no Client ID.` : r.reasons.join('; '),
      Name: many ? pick((p) => p.name) : ps[0].name,
      'Proposed ID': idText,
      'Name from': pick((p) => p.nameFrom),
      Email: pick((p) => p.email), Phone: pick((p) => p.phone),
      Cases: ps.map(caseText).filter(Boolean).join(' / '),
      Groups: uniq(ps.map(groupText)).join(' / '),
      Year: pick((p) => String(p.year)), 'Year from': pick((p) => p.yearFrom),
      Notes: uniq(ps.flatMap((p) => p.notes)).join(' | '),
    };
    return SHEET_HEADERS.map((h) => cell[h]);
  });
}

/** PURE — the "Summary" sheet rows ([label, value]). */
function summaryRows(plan, { madeAt = '', counter = '' } = {}) {
  const c = plan.counts;
  const out = [
    ['Client ID backfill — check list', ''],
    ['Made', madeAt],
    ['', ''],
    ['How to answer', 'The questions are at the top of the "People" sheet: the AMBER and NO-CASE rows. Only those need an answer.'],
    ['', 'AMBER rows: write Y in "Same person? (Y/N)" when the names are ONE person, N when they are different. A blank means different people.'],
    ['', 'NO-CASE rows: write Y in "Give a Client ID? (Y/N)" only for a real client. A blank means no Client ID.'],
    ['', 'Write only Y or N (or leave it blank). Any other answer stops the apply until it is corrected.'],
    ['', 'Sorting and filtering the sheet is fine. Do not change the "Key" or "Proposed ID" columns — the apply reads them back. Send the file back when done.'],
    ['', 'The numbers are proposals: a Y answer or a new client before the apply moves the later numbers along. A Client ID already given never changes.'],
    ['', ''],
    ['What the buckets mean', ''],
    ['GREEN', 'One person, found by the app\'s own rule (the same email or phone AND the same name). Gets a Client ID. Nothing to answer.'],
    ['AMBER', 'A question: these rows look alike (a shared email or phone, or names that only match once file numbers are removed). Answer Y or N.'],
    ['RED', 'No email and no phone at all, so it could not be matched with anyone. Kept as its own person and gets a Client ID. Nothing to answer.'],
    ['NO-CASE', 'A client record with no case on Client Master (a consultation only, or it looks like a test). No Client ID unless you write Y.'],
    ['EXCLUDED', 'Never given a Client ID: the TEST group, test or template rows, Archived records, and rows whose link is broken. See "Left out".'],
    ['', ''],
    ['The columns', '"Key" is the app\'s own name for the row. "Bucket" is the kind of row (above). "Name from" says where the name came from. "Placeholder emails / phones" below are shared addresses or numbers (an agent\'s inbox, the office phone) treated as blank.'],
    ['', ''],
    ['Rows on the Clients board', c.clientsRows],
    ['Rows on Client Master', c.caseRows],
    ['Client Master rows counted', c.eligibleCases],
    ['People', c.people],
    ['GREEN rows', c.buckets.GREEN],
    ['AMBER (questions)', c.buckets.AMBER],
    ['RED (no email or phone)', c.buckets.RED],
    ['NO-CASE (only with a Y)', c.buckets['NO-CASE']],
    ['EXCLUDED (never an ID)', c.buckets.EXCLUDED],
    ['Already have a Client ID (kept)', c.keepExisting],
    ['New Client IDs', c.newIds],
    ['New client records to make', c.newAccounts],
    ['First / last number', c.newIds ? `${c.firstNumber} – ${c.lastNumber}` : '—'],
    ['Counter', counter || (c.counterLast == null ? 'not read' : String(c.counterLast))],
    ['Placeholder emails / phones', `${c.placeholderEmails} / ${c.placeholderPhones}`],
    ['Rows that could not be read', c.unreadable],
    ['', ''],
    ['Year', 'People'],
  ];
  for (const y of Object.keys(plan.yearCounts).sort()) out.push([y, plan.yearCounts[y]]);
  return out;
}

/** PURE — the "Left out" sheet: excluded, unreadable, folded Merged records, placeholders. */
function leftOutRows(plan) {
  const out = [['What', 'Name', 'Case number', 'Why']];
  for (const x of plan.excluded) out.push([x.kind === 'case' ? 'Client Master row' : 'Client record', x.name, x.caseRef || '', x.reason]);
  for (const x of plan.unreadable) out.push([x.kind === 'case' ? 'Client Master row' : 'Client record', x.name, x.caseRef || '', x.reason]);
  for (const x of plan.merged) out.push(['Client record (Merged)', x.name, '', `joined into ${x.intoName || 'another record'} — counted there`]);
  for (const x of plan.placeholders.emails) out.push(['Email used as a placeholder', x.value, '', `${x.names} different names — treated as no email, never written as anyone's email`]);
  for (const x of plan.placeholders.phones) out.push(['Phone used as a placeholder', x.value, '', `${x.names} different names — treated as no phone`]);
  return out;
}

/**
 * PURE — the answers read back from the "People" sheet rows (objects by header).
 * The ORDER comes from the numbers in the "Proposed ID" column, never the row position (ux
 * review #1): a sheet sorted by Bucket or Name in Excel gives the same numbers. `proposed`
 * holds each key's numbers in the cell's own order (one per person; an ID a person already
 * has is null). Rows with no number go after, by the lowest item id in their key.
 * @returns {{ decisions: Map<string,{same,give}>, order: string[], proposed: Map<string,Array<number|null>>, names: Map<string,string>, problems: string[] }}
 */
function readDecisions(rows) {
  const decisions = new Map();
  const proposed = new Map();
  const names = new Map();
  const problems = [];
  const keys = [];
  for (const r of rows || []) {
    const key = s(r.Key);
    if (!key) continue;
    if (!/^(?:G:\d+(?:\+\d+)*|[AC]\d+)$/.test(key)) { problems.push(`"${key.slice(0, 40)}" is not a Key from the check list`); continue; }
    if (decisions.has(key)) { problems.push(`${key} is on the sheet twice`); continue; }
    const same = readAnswer(r['Same person? (Y/N)']);
    const give = readAnswer(r['Give a Client ID? (Y/N)']);
    const bucket = s(r.Bucket);
    if (same && bucket !== 'AMBER') problems.push(`${key}: "Same person?" is answered on a ${bucket || 'non-AMBER'} row — ignored`);
    if (give && bucket !== 'NO-CASE') problems.push(`${key}: "Give a Client ID?" is answered on a ${bucket || 'non-NO-CASE'} row — ignored`);
    decisions.set(key, { same: bucket === 'AMBER' ? same : '', give: bucket === 'NO-CASE' ? give : '' });
    proposed.set(key, s(r['Proposed ID']).split(' / ').map((t) => (/\(has it\)/.test(t) ? null : clientIdNumber(t) || null)));
    names.set(key, s(r.Name));
    keys.push(key);
  }
  const lowestN = (k) => { const f = proposed.get(k).filter((n) => n); return f.length ? Math.min(...f) : Infinity; };
  const lowestItem = (k) => Math.min(...(k.startsWith('G:') ? k.slice(2).split('+') : [k.slice(1)]).map(Number));
  const order = [...keys].sort((a, b) => (lowestN(a) - lowestN(b) || 0) || (lowestItem(a) - lowestItem(b)) || (a < b ? -1 : a > b ? 1 : 0));
  return { decisions, order, proposed, names, problems };
}

module.exports = {
  buildPlan, sheetRows, summaryRows, leftOutRows, readDecisions,
  parseClients, parseCases, parseLeads, cellOf, emailOf,
  clusterNormName, cleanDisplayName, resolveRow, blockStart, readAnswer, timeInfo, refYear,
  looksPlaceholderEmail, looksPlaceholderPhone,
  CM_COL, SHEET_HEADERS, SHEET_WIDTHS, BUCKETS, PLACEHOLDER_NAMES,
};
