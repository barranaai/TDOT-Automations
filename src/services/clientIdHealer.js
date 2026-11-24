'use strict';

/**
 * The Client ID healer and audit (step 4, 2026-11-25).
 *
 * One pass over the Clients board (the source of truth), the Client Master copy
 * and the Lead Board copy of the readable Client ID ("CL-2026-00042"):
 *
 *   1. Every Clients row: a Client ID box that is not a Client ID, one number on
 *      two rows, a number above the counter (typed by hand) — listed for staff.
 *      Nothing is renumbered, ever.
 *   2. The same person twice: two ACTIVE rows that the app's own strict rule calls
 *      one person (same email + same name, or same phone + same name when one has
 *      no email — classifyMatch 'exact'; review #2). Listed; never joined.
 *   3. Active rows with no Client ID, made since CLIENT_IDS_HEAL_SINCE: given one.
 *   4. Client Master copies: blank or wrong copies fixed; a case pointing at a
 *      Merged row is moved to the row it was merged into (resolveAccount, review
 *      #9); a link that is missing, Archived or goes round in a loop is listed.
 *   5. Client Master rows with NO client record, made since CLIENT_IDS_HEAL_SINCE
 *      (a stamp that failed, a row typed into Monday — review #4): an exact match
 *      is joined; no match at all makes the record and its ID; a weaker match
 *      ("review") is listed for staff, never joined.
 *   6. Lead Board copies: as for Client Master (only once that column exists).
 *
 * The switch (CLIENT_IDS): off → nothing at all (the hourly tick reads nothing);
 * report → everything is worked out and logged, nothing is written; on → the
 * healer writes. audit() works it all out and writes nothing, in every mode.
 *
 * CLIENT_IDS_HEAL_SINCE (a date/time): rows made BEFORE it are the backfill's
 * work (the Y/N check list, owner decision 2) — the healer never gives them an
 * ID or makes them a record. Unset → it gives none and makes none at all; it
 * still fixes copies and lists problems. Set it to when the backfill finished.
 *
 * Reads: items_page, 200 a page, with the cursor (never items(ids:) without a
 * limit — the 25-row cap). A column that does not come back in a read is never
 * treated as blank: that row is left alone (never overwrite on a null read).
 * Writes per run are capped; the rest waits for the next hour.
 *
 * The lines for the Summary page's "Needs attention" list come out of here
 * (problems); they name people and Client IDs, never a Monday item id.
 */

const mondayApi = require('./mondayApi');
const features = require('../../config/features');
const { isClientId, clientIdNumber } = require('../utils/clientId');
const { torontoYear } = require('../utils/torontoTime');
const { isTestGroup } = require('../utils/caseGroups');

// Client Master columns (the same ids as handoffService's CM map).
const CM_COL = { caseRef: 'text_mm142s49', clientEmail: 'text_mm0xw6bp', clientPhone: 'phone_mm33zr0c' };

const PAGE = 200;
const MAX_PAGES = 100;
const GRACE_MS = 30 * 60 * 1000;          // a row this new is still being set up by the live flow
const MAX_MINTS = 25;                     // per run
const MAX_CASE_JOINS = 10;                // client records made / joined for cases, per run
const MAX_COPY_WRITES = 50;               // copy fixes + moves to a merged-into record, per run
const REPORT_FRESH_MS = 2 * 3600 * 1000;  // the Needs-attention list re-uses a report this young
const TEST_RE = /\btest\b|\bzz-?test|\be2e\b|\btemplate\b|\bdummy\b/i;

const s = (v) => String(v == null ? '' : v).trim();
const digits = (v) => s(v).replace(/\D/g, '');
const tms = (v) => { const t = Date.parse(s(v)); return Number.isFinite(t) ? t : 0; };
const quote = (v, max = 40) => { const t = s(v).replace(/\s+/g, ' '); return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`; };
const nameOr = (v) => s(v) || 'a client';

/** A row that looks like the office's own test record (by name or email). PURE. */
function looksTest(name, email) {
  const e = s(email).toLowerCase();
  return TEST_RE.test(s(name)) || /@tdotimm\.com$/.test(e) || (e.includes('@') && TEST_RE.test(e.split('@')[0]));
}

/** CLIENT_IDS_HEAL_SINCE as ms, or 0 when unset / not a date (then the healer gives no ID and makes no record). */
function healSince() {
  const t = Date.parse(s(process.env.CLIENT_IDS_HEAL_SINCE));
  return Number.isFinite(t) ? t : 0;
}

/* ───────────────────────────── reading the boards ───────────────────────────── */

/** Every item of a board (raw), 200 a page with the cursor. `fields` = what to read per item. */
async function pageBoard(boardId, fields) {
  const out = []; let cursor = null; let pages = 0;
  do {
    const d = cursor
      ? await mondayApi.query(`query($b:[ID!],$c:String!){ boards(ids:$b){ items_page(limit:${PAGE}, cursor:$c){ cursor items{ ${fields} } } } }`, { b: [String(boardId)], c: cursor })
      : await mondayApi.query(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:${PAGE}){ cursor items{ ${fields} } } } }`, { b: [String(boardId)] });
    const page = (((d && d.boards) || [])[0] || {}).items_page;
    if (!page) throw new Error(`board ${boardId} could not be read`);
    out.push(...(page.items || []));
    cursor = page.cursor || null;
    if (++pages > MAX_PAGES) throw new Error(`board ${boardId}: the listing did not end`);
  } while (cursor);
  return out;
}

const colIds = (ids) => JSON.stringify([...new Set(ids.filter(Boolean))]);

/** The text of a column, or null when the column did not come back (never read as blank). */
function cellOf(item, col) {
  const c = ((item && item.column_values) || []).find((x) => x.id === col);
  return c ? s(c.text) : null;
}

/* ───────────────────────────── I/O seam (tests replace these) ───────────────────────────── */
const io = {
  loadBoard: () => require('./clientAccountService').loadBoard(),
  async readClients(cfg) {
    const c = cfg.columns;
    return pageBoard(cfg.boardId, `id name created_at column_values(ids:${colIds([c.primaryEmail, c.phone, c.dateOfBirth, c.status, c.mergedInto, c.clientId])}){ id text }`);
  },
  async readCases(cfg) {
    const l = cfg.cmLinkColumns || {};
    return pageBoard(cfg.clientMasterBoardId, `id name created_at group{ id title } column_values(ids:${colIds([CM_COL.caseRef, CM_COL.clientEmail, CM_COL.clientPhone, l.clientAccountId, l.clientId])}){ id text }`);
  },
  async readLeads(cfg) {
    const lb = require('../data/newLeadsBoard.json');
    return pageBoard(lb.boardId, `id name created_at column_values(ids:${colIds([lb.columns.clientAccountId, (cfg.leadLinkColumns || {}).clientId])}){ id text }`);
  },
  peekCounter: () => require('./clientIdAllocator').peekCounter(),
  /** The leads of one case, read fresh (the shared lead list drops emails). */
  leadsOfCase: (cmItemId) => require('./leadService').findAllByColumnValue('clientMasterItemId', String(cmItemId), { limit: 10 }),
  async writeText(boardId, itemId, col, value) {
    await mondayApi.query(
      'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
      { b: String(boardId), i: String(itemId), c: JSON.stringify({ [col]: String(value) }) });
  },
  accounts: () => require('./clientAccountService'),
  now: () => Date.now(),
};

/* ───────────────────────────── PURE pieces ───────────────────────────── */

/** A Clients row read from the board. null fields = that column did not come back. */
function parseClient(item, cfg) {
  const c = cfg.columns;
  return {
    id: s(item.id), name: s(item.name), createdAt: s(item.created_at),
    email: cellOf(item, c.primaryEmail) || '', phone: cellOf(item, c.phone) || '', dob: cellOf(item, c.dateOfBirth) || '',
    status: cellOf(item, c.status) || '', mergedInto: cellOf(item, c.mergedInto) || '',
    clientIdText: cellOf(item, c.clientId),   // null = not read
  };
}
const isActive = (row) => row.status !== 'Merged' && row.status !== 'Archived';

/**
 * Every problem with the Client IDs typed on the Clients rows. PURE.
 * @param {object[]} rows   parsed Clients rows (every status)
 * @param {number|null} counterLast  the counter's last number (null = not read)
 */
function idProblems(rows, counterLast) {
  const out = [];
  const byNumber = new Map();
  for (const r of rows) {
    const t = r.clientIdText;
    if (!t) continue;
    if (!isClientId(t)) { out.push({ reason: 'malformed', rows: [r], value: t }); continue; }
    const n = clientIdNumber(t);
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(r);
    if (counterLast != null && n > counterLast) out.push({ reason: 'above-counter', rows: [r], value: t, last: counterLast });
  }
  for (const [n, list] of byNumber) if (list.length > 1) out.push({ reason: 'duplicate', rows: list, n, value: list.map((r) => r.clientIdText).join(' / ') });
  return out;
}

/**
 * Groups of ACTIVE rows that the app's own strict rule calls the same person
 * (classifyMatch 'exact': same email + name, or same phone + name when one of the
 * two has no email; never with two different dates of birth). PURE.
 * @returns {Array<{ rows: object[], reasons: string[] }>}
 */
function findTwins(rows, classifyMatch, { normName, normalizeEmail, normalizePhone }) {
  const active = rows.filter(isActive);
  const buckets = new Map();
  const put = (k, r) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(r); };
  for (const r of active) {
    const n = normName(r.name); if (!n) continue;
    const e = normalizeEmail(r.email), p = normalizePhone(r.phone);
    if (e) put(`e|${e}|${n}`, r);
    if (p) put(`p|${p}|${n}`, r);
  }
  const parent = new Map(active.map((r) => [r.id, r.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const why = new Map();
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const m = classifyMatch({ email: a.email, phone: a.phone, fullName: a.name, dob: a.dob }, b);
      if (m.confidence !== 'exact') continue;
      const ra = find(a.id), rb = find(b.id);
      if (ra !== rb) parent.set(rb, ra);
      const k = `${a.id}|${b.id}`;
      why.set(k, m.reasons);
    }
  }
  const groups = new Map();
  for (const r of active) { const root = find(r.id); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(r); }
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const ids = new Set(list.map((r) => r.id));
    const reasons = new Set();
    for (const [k, rs] of why) { const [a, b] = k.split('|'); if (ids.has(a) && ids.has(b)) rs.forEach((x) => reasons.add(x)); }
    out.push({ rows: list.sort((a, b) => tms(a.createdAt) - tms(b.createdAt) || Number(a.id) - Number(b.id)), reasons: [...reasons] });
  }
  return out;
}

/** The ID of a row as it may be copied: a valid Client ID, or ''. */
const idOf = (row) => (row && isClientId(row.clientIdText) ? row.clientIdText : '');

const RESOLVE_WORDS = {
  missing: 'that is not on the Clients board',
  cycle: 'that was joined into another record in a loop',
  archived: 'that is Archived',
  'merged-nowhere': 'that is marked Merged without saying into which record',
  ambiguous: 'that was joined into a Client ID found on two records',
  'too-deep': 'that was joined into another record more than 10 times over',
  'bad-link': 'that cannot be read (the box does not hold a record number)',
};

/* ───────────────────────────── the Needs-attention lines ───────────────────────────── */

function twinLine(t) {
  const names = [...new Set(t.rows.map((r) => r.name))];
  const ids = t.rows.map((r) => idOf(r) || 'no Client ID yet');
  return {
    kind: 'client-id-twins',
    fingerprint: `client-id-twins|${t.rows.map((r) => r.id).sort().join(',')}`,
    accountItemId: t.rows[0].id,
    client: names.join(' / '), label: t.rows.map((r) => idOf(r)).filter(Boolean).join(' / ') || 'Clients board',
    since: t.rows[t.rows.length - 1].createdAt,
    why: `${quote(names[0])} has ${t.rows.length} client records (${ids.join(', ')}) with ${t.reasons.filter((x) => /^same /.test(x)).map((x) => x.replace(/^same /, 'the same ')).join(' and ') || 'the same details'}. One person should have one record and one Client ID.`,
    todo: 'Check that it is one person. If it is, tell the admin so the records can be joined (the lower number stays). Nothing is joined automatically. If they are two different people, press Mark handled.',
  };
}

function idProblemLine(p) {
  const r = p.rows[0];
  if (p.reason === 'malformed') {
    return {
      kind: 'client-id-bad', fingerprint: `client-id-bad|malformed|${r.id}|${p.value}`, accountItemId: r.id,
      client: nameOr(r.name), label: 'Clients board', since: r.createdAt,
      why: `The Client ID box of ${quote(r.name)} on the Clients board holds ${quote(p.value)}, which is not a Client ID (they look like CL-2026-00042).`,
      todo: 'Correct the box on the Clients board, or clear it so the app gives a proper one. The app never types over it. The line leaves the list at the next check after the fix.',
    };
  }
  if (p.reason === 'duplicate') {
    return {
      kind: 'client-id-bad', fingerprint: `client-id-bad|duplicate|${p.n}|${p.rows.map((x) => x.id).sort().join(',')}`, accountItemId: p.rows[0].id,
      client: [...new Set(p.rows.map((x) => nameOr(x.name)))].join(' / '), label: p.value, since: p.rows.map((x) => x.createdAt).sort().pop(),
      why: `The same Client ID number is on ${p.rows.length} client records: ${p.rows.map((x) => `${quote(x.name)} (${x.clientIdText})`).join(', ')}. One number must belong to one person.`,
      todo: 'If it is one person, tell the admin so the records can be joined. If they are different people, tell the admin: the record that got the number later needs a new one. Nothing is renumbered automatically.',
    };
  }
  return {
    kind: 'client-id-bad', fingerprint: `client-id-bad|above-counter|${r.id}|${p.value}`, accountItemId: r.id,
    client: nameOr(r.name), label: p.value, since: r.createdAt,
    why: `${quote(r.name)} has ${p.value}, a number the app has not given yet (the highest it has given is ${p.last}). It was probably typed by hand.`,
    todo: 'Check where the number came from. If it was a typing mistake, correct it on the Clients board. The app skips that number when the counter gets there.',
  };
}

function caseLine(c, reason, extra = {}) {
  const ref = s(c.caseRef);
  const base = {
    kind: 'client-id-case', fingerprint: `client-id-case|${c.id}|${reason}|${extra.detail || ''}`,
    client: nameOr(c.name), caseRef: ref, cmItemId: c.id, label: ref ? '' : 'Client Master', since: c.createdAt,
  };
  const words = {
    review: {
      why: `This case is not joined to a client record, and an existing client looks like the same person: ${extra.who || 'see the Clients board'}. They were not joined.`,
      todo: 'If it is the same person, tell the admin so the case can be joined to that client record. If not, tell the admin to give this client a record of their own. Nothing is joined automatically.',
    },
    'no-contact': {
      why: 'This case is not joined to a client record, and neither the case nor its consultation record has an email or phone to find one with.',
      todo: 'Add the client\'s email or phone on the case. The client record is then made or found at the next hourly check.',
    },
    broken: {
      why: `This case is joined to a client record ${RESOLVE_WORDS[extra.detail] || 'that cannot be used'}.`,
      todo: 'Tell the admin: the case needs to point at the right client record on the Clients board.',
    },
    'copy-no-account': {
      why: `This case shows Client ID ${extra.value} but is not joined to any client record.`,
      todo: 'Tell the admin. The Client ID may have been typed on the case by hand; it comes from the client record, never the other way round.',
    },
    'copy-stray': {
      why: `This case shows Client ID ${extra.value}, but its client record has ${extra.has ? `${extra.has}` : 'no Client ID'}.`,
      todo: 'Tell the admin. The case copy is put right by itself once the client record has its Client ID.',
    },
  }[reason];
  return { ...base, ...words };
}

/* ───────────────────────────── the run ───────────────────────────── */

let _last = null;        // { at, mode, wrote, problems, summary }
let _running = null;

/**
 * One pass. `write`: actually write (only with CLIENT_IDS=on and not an audit).
 * Never throws for a board problem after the Clients board was read: what could
 * not be checked is said in `partial`.
 */
async function pass({ audit = false } = {}) {
  const mode = features.clientIdsMode();
  const write = mode === 'on' && !audit;
  const say = (msg) => console.log(`[ClientIdHealer] ${write ? '' : (audit ? '(audit) ' : '(report — nothing written) ')}${msg}`);
  const cfg = io.loadBoard();
  if (!cfg) return { ok: false, reason: 'dormant', message: 'There is no Clients board in this environment.' };
  if (!s((cfg.columns || {}).clientId)) return { ok: false, reason: 'not-configured', message: 'The Client ID column is not set up yet (the column script has not run) — nothing was checked.' };
  const acc = io.accounts();
  const { normName } = require('./handoffService');
  const now = io.now();
  const since = healSince();
  const inWindow = (createdAt) => !!since && tms(createdAt) >= since && tms(createdAt) <= now - GRACE_MS;
  const partial = [];
  const problems = [];
  const done = { minted: [], mintFailed: [], copiesFixed: 0, moved: 0, casesJoined: [], recordsMade: [], leadCopiesFixed: 0, leadsMoved: 0 };
  const would = { mint: [], copies: 0, moves: 0, caseJoin: [], caseCreate: [], leadCopies: 0, leadMoves: 0 };
  let copyWrites = 0;

  // ── 1. the Clients board (the truth) ──
  const rows = (await io.readClients(cfg)).map((it) => parseClient(it, cfg));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byNumber = new Map();
  for (const r of rows) if (isClientId(r.clientIdText)) { const n = clientIdNumber(r.clientIdText); byNumber.set(n, [...(byNumber.get(n) || []), r]); }
  const lookup = {
    getById: (id) => byId.get(s(id)) || null,
    getByClientNumber: (n) => byNumber.get(n) || [],
  };
  const resolve = (id) => acc.resolveAccount(id, lookup);
  const unreadIds = rows.filter((r) => r.clientIdText == null).length;
  if (unreadIds) partial.push(`${unreadIds} Clients row(s) came back without their Client ID box — left alone.`);

  let counter = null;
  try { counter = await io.peekCounter(); }
  catch (err) { counter = { state: 'unavailable', error: err.message }; }
  const counterLast = counter && counter.state === 'ok' ? counter.last : null;
  if (counterLast == null) partial.push(`The Client ID counter could not be read (${(counter && (counter.state === 'missing' ? 'there is no counter file yet' : counter.error || counter.state)) || 'no answer'}), so numbers above it were not checked.`);

  for (const p of idProblems(rows, counterLast)) problems.push(idProblemLine(p));
  const twins = findTwins(rows, acc.classifyMatch, { normName, normalizeEmail: acc.normalizeEmail, normalizePhone: acc.normalizePhone });
  for (const t of twins) problems.push(twinLine(t));

  // ── 2. Active rows with no Client ID ──
  const blank = rows.filter((r) => isActive(r) && r.clientIdText === '');
  const toMint = blank.filter((r) => inWindow(r.createdAt) && !looksTest(r.name, r.email));
  const leftOld = blank.filter((r) => !inWindow(r.createdAt) && !(since && tms(r.createdAt) > now - GRACE_MS)).length;
  const leftTest = blank.filter((r) => inWindow(r.createdAt) && looksTest(r.name, r.email)).map((r) => r.name);
  for (const r of toMint.slice(0, MAX_MINTS)) {
    const year = Math.min(torontoYear(r.createdAt) || torontoYear(now), torontoYear(now));
    if (!write) { would.mint.push(r.name); continue; }
    const res = await acc.ensureClientId(r.id, { year, why: 'hourly check' });
    if (res && res.ok) { r.clientIdText = res.id; byNumber.set(clientIdNumber(res.id), [...(byNumber.get(clientIdNumber(res.id)) || []), r]); done.minted.push(`${r.name} ${res.id}`); }
    else done.mintFailed.push(`${r.name}: ${(res && res.reason) || 'refused'}`);
  }
  if (toMint.length > MAX_MINTS) partial.push(`${toMint.length - MAX_MINTS} more client record(s) without a Client ID wait for the next hourly check.`);

  // Join a case to its (resolved) record with the ID — shared by steps 3 and 4.
  const joinCase = async (cmItemId, accountId, leadId, why, year) => {
    const idr = await acc.ensureClientId(accountId, { why, ...(year ? { year } : {}) });
    const clientIdText = idr && idr.ok ? idr.id : '';
    const row = byId.get(s(accountId));
    if (row && clientIdText) row.clientIdText = clientIdText;
    await acc.linkCase(accountId, { cmItemId, clientIdText });
    if (leadId) await acc.linkLead(accountId, leadId, { clientIdText });
    return clientIdText;
  };

  // ── 3. Client Master copies, and cases with no client record ──
  const cases = { read: 0, linked: 0, unreadable: 0, noAccount: 0, noAccountOld: 0, copiesWrong: 0, toMove: 0, broken: 0 };
  let cmItems = null;
  try { cmItems = await io.readCases(cfg); }
  catch (err) { partial.push(`The Client Master board could not be read (${err.message}) — case copies were not checked.`); }
  const link = cfg.cmLinkColumns || {};
  const noAccount = [];
  for (const it of cmItems || []) {
    cases.read++;
    const c = {
      id: s(it.id), name: s(it.name), createdAt: s(it.created_at), group: it.group || {},
      caseRef: cellOf(it, CM_COL.caseRef) || '', email: cellOf(it, CM_COL.clientEmail) || '', phone: cellOf(it, CM_COL.clientPhone) || '',
      account: link.clientAccountId ? cellOf(it, link.clientAccountId) : null,
      copy: link.clientId ? cellOf(it, link.clientId) : null,
    };
    if (c.account == null || (link.clientId && c.copy == null)) { cases.unreadable++; continue; }
    if (!c.account) {
      if (c.copy) { problems.push(caseLine(c, 'copy-no-account', { value: c.copy, detail: c.copy })); continue; }
      cases.noAccount++;
      if (isTestGroup(c.group) || looksTest(c.name, c.email)) continue;
      if (!inWindow(c.createdAt)) { cases.noAccountOld++; continue; }
      noAccount.push(c);
      continue;
    }
    cases.linked++;
    const r = await resolve(c.account);
    if (!r.ok) { cases.broken++; problems.push(caseLine(c, 'broken', { detail: r.reason })); continue; }
    const want = idOf(r.row);
    if (r.accountId !== digits(c.account)) {
      cases.toMove++;
      if (!write) { would.moves++; continue; }
      if (copyWrites >= MAX_COPY_WRITES) continue;
      copyWrites++;
      await acc.linkCase(r.accountId, { cmItemId: c.id, clientIdText: want });
      done.moved++;
      continue;
    }
    if (!link.clientId) continue;
    if (!want) {
      if (c.copy) problems.push(caseLine(c, 'copy-stray', { value: c.copy, detail: c.copy, has: r.row.clientIdText ? `${quote(r.row.clientIdText)} in its Client ID box (not a Client ID)` : '' }));
      continue;
    }
    if (c.copy === want) continue;
    cases.copiesWrong++;
    if (!write) { would.copies++; continue; }
    if (copyWrites >= MAX_COPY_WRITES) continue;
    copyWrites++;
    try { await io.writeText(cfg.clientMasterBoardId, c.id, link.clientId, want); done.copiesFixed++; }
    catch (err) { console.warn(`[ClientIdHealer] case copy not written for ${c.caseRef || c.name}: ${err.message}`); }
  }
  if (copyWrites >= MAX_COPY_WRITES) partial.push('More case copies wait for the next hourly check.');

  // ── 4. cases made since the backfill with no client record (review #4) ──
  let joins = 0;
  for (const c of noAccount) {
    if (joins >= MAX_CASE_JOINS) { partial.push(`${noAccount.length - joins} more case(s) without a client record wait for the next hourly check.`); break; }
    joins++;
    let leads = [];
    try { leads = (await io.leadsOfCase(c.id)) || []; }
    catch (err) { partial.push(`The consultation record of ${c.caseRef || c.name} could not be read (${err.message}) — tried again next hour.`); continue; }
    const lead = leads.find((l) => digits(l.clientAccountId)) || leads.sort((a, b) => tms(b.createdAt) - tms(a.createdAt))[0] || null;
    const year = lead ? acc.yearForLead(lead, now) : Math.min(torontoYear(c.createdAt) || torontoYear(now), torontoYear(now));
    const person = lead
      ? { fullName: s(lead.fullName || lead.name), email: s(lead.email), phone: s(lead.phone), residentialAddress: lead.residentialAddress }
      : { fullName: c.name, email: c.email, phone: c.phone };
    if (lead && digits(lead.clientAccountId)) {
      // The consultation record already names the person's record (a stamp that failed on the case).
      const r = await resolve(lead.clientAccountId);
      if (!r.ok) { problems.push(caseLine(c, 'broken', { detail: r.reason })); continue; }
      if (!write) { would.caseJoin.push(c.caseRef || c.name); continue; }
      const id = await joinCase(c.id, r.accountId, lead.id, 'hourly check — case had no client record', year);
      done.casesJoined.push(`${c.caseRef || c.name}${id ? ` ${id}` : ''}`);
      continue;
    }
    if (!acc.normalizeEmail(person.email) && !acc.normalizePhone(person.phone)) { problems.push(caseLine(c, 'no-contact')); continue; }
    let matches;
    try { matches = await acc.findMatches({ email: person.email, phone: person.phone, fullName: person.fullName }); }
    catch (err) { partial.push(`The Clients board could not be searched for ${c.caseRef || c.name} (${err.message}) — tried again next hour.`); continue; }
    const exact = matches.find((m) => m.confidence === 'exact');
    if (exact) {
      if (!write) { would.caseJoin.push(c.caseRef || c.name); continue; }
      const id = await joinCase(c.id, exact.id, lead && lead.id, 'hourly check — case had no client record', year);
      done.casesJoined.push(`${c.caseRef || c.name}${id ? ` ${id}` : ''}`);
      continue;
    }
    const review = matches.filter((m) => m.confidence === 'review');
    if (review.length) {
      const who = review.slice(0, 3).map((m) => `${quote(m.name)}${isClientId(m.clientIdText) ? ` (${m.clientIdText})` : ''} — ${(m.reasons || []).join(', ')}`).join('; ');
      problems.push(caseLine(c, 'review', { who, detail: review.map((m) => m.id).sort().join(',') }));
      continue;
    }
    if (!write) { would.caseCreate.push(c.caseRef || c.name); continue; }
    let made;
    try { made = await acc.findOrCreate({ ...person, source: 'hourly check' }); }   // it looks once more right before making the row
    catch (err) { partial.push(`No client record could be made for ${c.caseRef || c.name} (${err.message}) — tried again next hour.`); continue; }
    if (!made) continue;
    const id = await joinCase(c.id, made.clientId, lead && lead.id, 'hourly check — case had no client record', year);
    (made.created ? done.recordsMade : done.casesJoined).push(`${c.caseRef || c.name}${id ? ` ${id}` : ''}`);
  }

  // ── 5. Lead Board copies (only once its Client ID column exists) ──
  const leadCol = s((cfg.leadLinkColumns || {}).clientId);
  const leadsSum = { read: 0, linked: 0, unreadable: 0, copiesWrong: 0, toMove: 0, broken: 0, copyNoAccount: 0 };
  if (leadCol) {
    const lb = require('../data/newLeadsBoard.json');
    let items = null;
    try { items = await io.readLeads(cfg); }
    catch (err) { partial.push(`The Lead Board could not be read (${err.message}) — lead copies were not checked.`); }
    for (const it of items || []) {
      leadsSum.read++;
      const account = cellOf(it, lb.columns.clientAccountId), copy = cellOf(it, leadCol);
      if (account == null || copy == null) { leadsSum.unreadable++; continue; }
      if (!account) { if (copy) leadsSum.copyNoAccount++; continue; }
      leadsSum.linked++;
      const r = await resolve(account);
      if (!r.ok) { leadsSum.broken++; continue; }
      const want = idOf(r.row);
      if (r.accountId !== digits(account)) {
        leadsSum.toMove++;
        if (!write) { would.leadMoves++; continue; }
        if (copyWrites >= MAX_COPY_WRITES) continue;
        copyWrites++;
        await acc.linkLead(r.accountId, s(it.id), { clientIdText: want });
        done.leadsMoved++;
        continue;
      }
      if (!want || copy === want) continue;
      leadsSum.copiesWrong++;
      if (!write) { would.leadCopies++; continue; }
      if (copyWrites >= MAX_COPY_WRITES) continue;
      copyWrites++;
      try { await io.writeText(lb.boardId, s(it.id), leadCol, want); done.leadCopiesFixed++; }
      catch (err) { console.warn(`[ClientIdHealer] lead copy not written for lead ${s(it.id)}: ${err.message}`); }
    }
  }

  const highest = rows.reduce((m, r) => Math.max(m, isClientId(r.clientIdText) ? clientIdNumber(r.clientIdText) : 0), 0);
  const summary = {
    mode, wrote: write, checkedAt: new Date(now).toISOString(),
    healSince: since ? new Date(since).toISOString() : '',
    counter: counter && counter.state === 'ok' ? { state: 'ok', last: counter.last } : { state: (counter && counter.state) || 'unavailable' },
    clients: {
      rows: rows.length, active: rows.filter(isActive).length, withId: rows.filter((r) => isClientId(r.clientIdText)).length,
      merged: rows.filter((r) => r.status === 'Merged').length, archived: rows.filter((r) => r.status === 'Archived').length,
      highestNumber: highest, activeWithoutId: blank.length, activeWithoutIdBeforeHealSince: leftOld, testLookingWithoutId: leftTest,
      twins: twins.length,
    },
    cases, leads: leadCol ? leadsSum : 'the Lead Board Client ID column is not set up yet',
    did: write ? done : undefined,
    wouldDo: write ? undefined : would,
    problems: problems.length,
    partial,
  };
  if (write) {
    const bits = [
      done.minted.length && `gave ${done.minted.length} Client ID(s): ${done.minted.slice(0, 20).join(', ')}`,
      done.mintFailed.length && `${done.mintFailed.length} not given: ${done.mintFailed.slice(0, 10).join('; ')}`,
      done.copiesFixed && `${done.copiesFixed} case copy(ies) fixed`, done.moved && `${done.moved} case(s) moved to the record they were merged into`,
      done.casesJoined.length && `${done.casesJoined.length} case(s) joined: ${done.casesJoined.slice(0, 10).join(', ')}`,
      done.recordsMade.length && `${done.recordsMade.length} client record(s) made for cases: ${done.recordsMade.slice(0, 10).join(', ')}`,
      done.leadCopiesFixed && `${done.leadCopiesFixed} lead copy(ies) fixed`, done.leadsMoved && `${done.leadsMoved} lead(s) moved to the record they were merged into`,
    ].filter(Boolean);
    say(`${bits.join('; ') || 'nothing to fix'} — ${problems.length} line(s) for staff${partial.length ? ` — ${partial.join(' ')}` : ''}`);
  } else {
    const bits = [
      would.mint.length && `would give ${would.mint.length} Client ID(s): ${would.mint.slice(0, 20).join(', ')}`,
      would.copies && `would fix ${would.copies} case copy(ies)`, would.moves && `would move ${would.moves} case(s) to the record they were merged into`,
      would.caseJoin.length && `would join ${would.caseJoin.length} case(s) to their client record: ${would.caseJoin.slice(0, 10).join(', ')}`,
      would.caseCreate.length && `would make ${would.caseCreate.length} client record(s) for cases: ${would.caseCreate.slice(0, 10).join(', ')}`,
      would.leadCopies && `would fix ${would.leadCopies} lead copy(ies)`, would.leadMoves && `would move ${would.leadMoves} lead(s)`,
    ].filter(Boolean);
    say(`${bits.join('; ') || 'nothing to fix'} — ${problems.length} line(s) for staff${partial.length ? ` — ${partial.join(' ')}` : ''}`);
  }
  _last = { at: now, mode, wrote: write, problems, summary };
  return { ok: true, ...summary, lines: problems.map(({ kind, client, caseRef, label, why, todo }) => ({ kind, client, caseRef: caseRef || '', label: label || '', why, todo })) };
}

/**
 * The hourly tick. Off → nothing is read. One run at a time (a tick that finds one
 * running says so and returns). Never throws.
 */
async function tick() {
  if (features.clientIdsMode() === 'off') return { ok: false, reason: 'off' };
  if (_running) return { ok: false, reason: 'already-running' };
  _running = (async () => {
    try { return await pass(); }
    catch (err) { console.error('[ClientIdHealer] run failed:', err.message); return { ok: false, reason: 'error', message: err.message }; }
  })();
  try { return await _running; } finally { _running = null; }
}

/** READ-ONLY, every mode: what the healer finds and would do. For /admin/client-ids/audit. Throws if the Clients board cannot be read. */
function audit() { return pass({ audit: true }); }

/**
 * The lines for the Needs-attention list: the latest report when it is young
 * enough, else a read-only pass now. [] while CLIENT_IDS is off.
 */
async function problemsForNeedsAttention() {
  if (features.clientIdsMode() === 'off') return [];
  if (_last && io.now() - _last.at < REPORT_FRESH_MS) return _last.problems;
  const r = await audit();
  return r.ok && _last ? _last.problems : [];
}

function lastReport() { return _last; }
function _resetForTests() { _last = null; _running = null; }

module.exports = {
  tick, audit, problemsForNeedsAttention, lastReport,
  idProblems, findTwins, parseClient, looksTest, healSince, cellOf, pageBoard,   // pure / helpers
  io, CM_COL, MAX_MINTS, MAX_CASE_JOINS, MAX_COPY_WRITES, GRACE_MS, _resetForTests,
};
