'use strict';

/**
 * Client accounts — the person registry over the Clients board.
 *
 * One row = one PERSON; a person can have many applications (Client Master
 * cases). This service owns identity matching and the find-or-create seam.
 *
 * Ground rules (agreed at design time — see plan "Client Accounts"):
 *   - The ONLY auto-link basis is email + normalized-name equality with
 *     compatible DOBs. Everything weaker (shared family email, phone-only,
 *     conflicting DOBs) surfaces as a CANDIDATE for staff, never a link.
 *   - Never auto-merge. Ambiguity fails toward creating a new account — a
 *     wrong extra account is mergeable later; a wrong merge corrupts two
 *     people's files.
 *   - Spouses sharing one email = two accounts with the same email. Allowed.
 *   - Feature dormancy: if src/data/clientsBoard.json doesn't exist (board
 *     not created in this environment), every function no-ops safely.
 */

const fs   = require('fs');
const path = require('path');
const mondayApi = require('./mondayApi');
const { normName } = require('./handoffService');
const { isClientId } = require('../utils/clientId');

const CFG_PATH = path.join(__dirname, '..', 'data', 'clientsBoard.json');

let _cfg;
/** The generated board config — null when the board doesn't exist (feature dormant). */
function loadBoard() {
  if (_cfg !== undefined) return _cfg;
  try { _cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch (_) { _cfg = null; }
  return _cfg;
}
/** Tests only: use this board config (undefined = read the file again). */
function _setBoardForTests(cfg) { _cfg = cfg; }

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Lowercased, trimmed email — the stored + queried form. '' when unusable. */
function normalizeEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

/** Digits-only phone, minus a leading 1 on NA 11-digit forms. '' when too short to match on. */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 7) return '';
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/**
 * PURE. Classify one existing account row against the person being looked up.
 * @param {{ email, phone, fullName, dob }} input   normalized-ready raw values
 * @param {{ email, phone, name, dob }}     candidate an existing account row
 * @returns {{ confidence: 'exact'|'review'|'none', reasons: string[] }}
 *   exact  → same person, safe to auto-link
 *   review → plausibly related (shared email / phone / DOB conflict) — staff decides
 *   none   → unrelated
 */
function classifyMatch(input, candidate) {
  const emailMatch = !!(normalizeEmail(input.email) && normalizeEmail(input.email) === normalizeEmail(candidate.email));
  const phoneMatch = !!(normalizePhone(input.phone) && normalizePhone(input.phone) === normalizePhone(candidate.phone));
  const nameMatch  = !!(normName(input.fullName) && normName(input.fullName) === normName(candidate.name));
  const bothDobs   = !!(input.dob && candidate.dob);
  const dobConflict = bothDobs && String(input.dob).slice(0, 10) !== String(candidate.dob).slice(0, 10);

  if (!emailMatch && !phoneMatch) return { confidence: 'none', reasons: [] };

  const reasons = [];
  if (emailMatch) reasons.push('same email');
  if (phoneMatch) reasons.push('same phone');
  if (nameMatch) reasons.push('same name');

  if (emailMatch && nameMatch && !dobConflict) return { confidence: 'exact', reasons };
  // A client with NO email (a phone-only walk-in, 2026-11-04): the same phone AND the
  // same name is the same person — else every case of theirs minted a new account.
  // Only when one side has no email: when BOTH have one, the email decides.
  // Symmetric: an account made for a phone-only client (no email on it) is the same person
  // when they come back WITH an email — same phone + same name.
  if ((!normalizeEmail(input.email) || !normalizeEmail(candidate.email)) && phoneMatch && nameMatch && !dobConflict) return { confidence: 'exact', reasons };
  if (dobConflict) reasons.push('DIFFERENT date of birth — likely two people (Sr/Jr)');
  if (emailMatch && !nameMatch) reasons.push('different name — shared family email or a name change; verify identity');
  if (!emailMatch && phoneMatch) reasons.push('phone-only match — weak signal');
  return { confidence: 'review', reasons };
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

function colText(item, colId) {
  return ((item.column_values || []).find((c) => c.id === colId) || {}).text || '';
}

async function queryByColumn(cfg, colId, value) {
  // The readable Client ID ("CL-2026-00042") is read too once its column exists.
  const idCol = (cfg.columns || {}).clientId || '';
  const cols = [cfg.columns.primaryEmail, cfg.columns.phone, cfg.columns.dateOfBirth, cfg.columns.status, ...(idCol ? [idCol] : [])];
  const data = await mondayApi.query(
    `query($b:ID!,$v:String!){ items_page_by_column_values(limit:25, board_id:$b, columns:[{column_id:"${colId}", column_values:[$v]}]){ items{ id name column_values(ids:${JSON.stringify(cols)}){ id text } } } }`,
    { b: String(cfg.boardId), v: String(value) }
  );
  return (data?.items_page_by_column_values?.items || []).map((it) => ({
    id: String(it.id),
    name: it.name,
    email: colText(it, cfg.columns.primaryEmail),
    phone: colText(it, cfg.columns.phone),
    dob: colText(it, cfg.columns.dateOfBirth),
    status: colText(it, cfg.columns.status),
    clientIdText: idCol ? String(colText(it, idCol)).trim() : '',
  }));
}

/**
 * All account rows matching this email and/or phone, classified. Excludes
 * Merged/Archived rows from matching (they are history, not identities).
 * @returns {Promise<Array<{ id, name, email, phone, dob, confidence, reasons }>>}
 */
async function findMatches({ email, phone, fullName, dob } = {}) {
  const cfg = loadBoard();
  if (!cfg) return [];
  const seen = new Map();
  const e = normalizeEmail(email);
  const p = normalizePhone(phone);
  if (e) for (const row of await queryByColumn(cfg, cfg.columns.primaryEmail, e)) seen.set(row.id, row);
  if (p) {
    // Monday phone columns store DIGITS ONLY (the '+' we write is stripped on
    // write — live-probed), so query the digit forms: bare and NA 1-prefixed.
    for (const v of [...new Set([p, `1${p}`])]) {
      for (const row of await queryByColumn(cfg, cfg.columns.phone, v)) if (!seen.has(row.id)) seen.set(row.id, row);
    }
  }
  return [...seen.values()]
    .filter((r) => r.status !== 'Merged' && r.status !== 'Archived')
    .map((r) => ({ ...r, ...classifyMatch({ email, phone, fullName, dob }, r) }))
    .filter((r) => r.confidence !== 'none');
}

/** I/O. Create one account row. Returns the new item id. */
async function createAccount(cfg, { fullName, email, phone, residentialAddress, dob, source }) {
  const cols = {};
  const e = normalizeEmail(email);
  if (e) cols[cfg.columns.primaryEmail] = { email: e, text: e };
  const p = normalizePhone(phone);
  if (p) cols[cfg.columns.phone] = { phone: `+${p.length === 10 ? `1${p}` : p}`, countryShortName: p.length === 10 ? 'CA' : '' };
  if (residentialAddress) cols[cfg.columns.residentialAddress] = String(residentialAddress).slice(0, 2000);
  if (dob) cols[cfg.columns.dateOfBirth] = { date: String(dob).slice(0, 10) };
  cols[cfg.columns.status] = { label: 'Active' };
  cols[cfg.columns.source] = String(source || 'manual');

  const data = await mondayApi.query(
    'mutation($b:ID!,$n:String!,$c:JSON!){ create_item(board_id:$b, item_name:$n, column_values:$c, create_labels_if_missing:true){ id } }',
    { b: String(cfg.boardId), n: String(fullName || 'Unnamed client').slice(0, 250), c: JSON.stringify(cols) }
  );
  return String(data.create_item.id);
}

// One in-flight find-or-create per person key — a double-submit must not mint
// two accounts (same idea as the handoff race guard).
const _inFlight = new Map();

/**
 * Find the account for this person, or create one. Auto-links ONLY on an
 * 'exact' classification; anything weaker creates a NEW account (never merge)
 * and reports the review candidates so callers can surface them.
 * @returns {Promise<{ clientId, created, matchBasis, reviewCandidates }|null>} null = feature dormant
 */
async function findOrCreate({ email, phone, fullName, residentialAddress, dob, source } = {}) {
  const cfg = loadBoard();
  if (!cfg) return null;
  const key = `${normalizeEmail(email) || `phone:${normalizePhone(phone)}`}|${normName(fullName)}`;
  if (_inFlight.has(key)) return _inFlight.get(key);

  const work = (async () => {
    const matches = await findMatches({ email, phone, fullName, dob });
    const exact = matches.find((m) => m.confidence === 'exact');
    if (exact) return { clientId: exact.id, created: false, matchBasis: exact.reasons, reviewCandidates: [], clientIdText: exact.clientIdText || '' };

    const clientId = await createAccount(cfg, { fullName, email, phone, residentialAddress, dob, source });

    // Post-create reconcile: a concurrent create in another process may have won.
    // Keep the LOWEST item id as canonical; mark ours Merged.
    try {
      const again = await findMatches({ email, phone, fullName, dob });
      const exactRows = again.filter((m) => m.confidence === 'exact' || m.id === clientId);
      const canonical = exactRows
        .filter((m) => normName(m.name) === normName(fullName))
        .sort((a, b) => Number(a.id) - Number(b.id))[0];
      if (canonical && canonical.id !== clientId) {
        await mondayApi.query(
          'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
          { b: String(cfg.boardId), i: clientId, c: JSON.stringify({ [cfg.columns.status]: { label: 'Merged' }, [cfg.columns.mergedInto]: String(canonical.id) }) }
        );
        return { clientId: canonical.id, created: false, matchBasis: ['race-reconciled'], reviewCandidates: [], clientIdText: canonical.clientIdText || '' };
      }
    } catch (_) { /* reconcile is best-effort */ }

    // The Client ID is NOT minted here: the caller asks ensureClientId() for the row
    // that came out of this — after the reconcile, so a row marked Merged above never
    // takes a number.
    return { clientId, created: true, matchBasis: [], reviewCandidates: matches.filter((m) => m.confidence === 'review'), clientIdText: '' };
  })();

  _inFlight.set(key, work);
  try { return await work; } finally { _inFlight.delete(key); }
}

/**
 * I/O. Append one item to a board_relation column on an account row without
 * dropping the existing links (Monday replaces the whole set on write, so we
 * read-merge-write). Best-effort — navigation relations never block flows.
 * The read uses the typed fragment (a link cell's text/value come back null —
 * reading those made every append REPLACE the account's earlier case/lead,
 * 2026-08…10); a cell that cannot be read is never written.
 */
async function appendAccountRelation(cfg, clientId, relColId, itemId, label) {
  if (!relColId) return;
  const { RELATION_FIELDS, linkedIds } = require('./mondayColumnRead');
  try {
    const existing = await mondayApi.query(
      `query($id:ID!){ items(ids:[$id], limit:1){ id column_values(ids:["${relColId}"]){ id ${RELATION_FIELDS} } } }`,
      { id: String(clientId) }
    );
    const have = linkedIds(existing?.items?.[0]?.column_values?.[0]);
    if (have === null) {
      console.warn(`[ClientAccount] ${label} links of client ${clientId} could not be read — not written (a write would replace links it cannot see)`);
      return;
    }
    if (have.includes(String(itemId))) return;   // already linked
    await mondayApi.query(
      'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
      { b: String(cfg.boardId), i: String(clientId), c: JSON.stringify({ [relColId]: { item_ids: [...have, String(itemId)].map(Number) } }) }
    );
  } catch (err) { console.warn(`[ClientAccount] ${label} relation append failed for client ${clientId}: ${err.message}`); }
}

/**
 * Stamp the account id on a Client Master case + append the navigation relation (best-effort).
 * clientIdText: the person's readable Client ID ("CL-2026-00042") — copied into the case's
 * "Client ID" column (a plain mirror) when given and the column exists. Every write here has
 * its OWN try/catch (review #1): one failing never stops the next, nor linkLead after it.
 */
async function linkCase(clientId, { cmItemId, clientIdText = '' } = {}) {
  const cfg = loadBoard();
  if (!cfg || !clientId || !cmItemId) return;
  const link = cfg.cmLinkColumns || {};
  const { clientMasterBoardId } = require('../../config/monday');
  if (link.clientAccountId) {
    try {
      await mondayApi.query(
        'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
        { b: String(clientMasterBoardId), i: String(cmItemId), c: JSON.stringify({ [link.clientAccountId]: String(clientId) }) }
      );
    } catch (err) { console.warn(`[ClientAccount] account id write failed for case ${cmItemId}: ${err.message}`); }
  }
  if (link.clientId && isClientId(clientIdText)) {
    try {
      await mondayApi.query(
        'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
        { b: String(clientMasterBoardId), i: String(cmItemId), c: JSON.stringify({ [link.clientId]: String(clientIdText) }) }
      );
    } catch (err) { console.warn(`[ClientAccount] Client ID copy failed for case ${cmItemId}: ${err.message}`); }
  }
  if (link.clientRelation) {
    try {
      await mondayApi.query(
        'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
        { b: String(clientMasterBoardId), i: String(cmItemId), c: JSON.stringify({ [link.clientRelation]: { item_ids: [Number(clientId)] } }) }
      );
    } catch (err) { console.warn(`[ClientAccount] navigation relation write failed for case ${cmItemId}: ${err.message}`); }
  }
  // Reverse navigation: add this case to the account's Cases relation.
  await appendAccountRelation(cfg, clientId, cfg.columns.cases, cmItemId, 'Cases');
}

/**
 * Stamp the account id on a lead AND add the lead to the account's Leads
 * relation — each client row references every enquiry/consultation/direct
 * entry of theirs, not just their cases (user directive 2026-08-04).
 * Best-effort; leadService validates the column.
 */
async function linkLead(clientId, leadId, { clientIdText = '' } = {}) {
  const cfg = loadBoard();
  if (!cfg || !clientId || !leadId) return;
  const leadService = require('./leadService');
  try { await leadService.updateLead(String(leadId), { clientAccountId: String(clientId) }); }
  catch (err) { console.warn(`[ClientAccount] lead stamp failed for ${leadId}: ${err.message}`); }
  // The lead's "Client ID" column (a plain mirror) — its own write, its own catch.
  const leadCol = (cfg.leadLinkColumns || {}).clientId;
  if (leadCol && isClientId(clientIdText)) {
    try {
      const { boardId: leadBoardId } = require('../data/newLeadsBoard.json');
      await mondayApi.query(
        'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
        { b: String(leadBoardId), i: String(leadId), c: JSON.stringify({ [leadCol]: String(clientIdText) }) }
      );
    } catch (err) { console.warn(`[ClientAccount] Client ID copy failed for lead ${leadId}: ${err.message}`); }
  }
  await appendAccountRelation(cfg, clientId, cfg.columns.leads, leadId, 'Leads');
}

// ─── The readable Client ID ("CL-2026-00042") of an account ─────────────────────

const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(0, 20);

/**
 * The Toronto year this person first came, as far as this lead shows: the year the
 * lead was made, or now — whichever is earlier (decision 5). A label only.
 */
function yearForLead(lead, now = Date.now()) {
  const { torontoYear } = require('../utils/torontoTime');
  const nowYear = torontoYear(now);
  const made = torontoYear(lead && lead.createdAt ? lead.createdAt : NaN);
  return Number.isFinite(made) && made < nowYear ? made : nowYear;
}

const _idInFlight = new Map();   // account id → Promise (one ensure per account at a time in this process)

/**
 * The account's Client ID: the one on its Clients row, or — when that is blank and
 * CLIENT_IDS is 'on' — a new number, written to the row. Never throws.
 *
 *   off     → nothing is read or written: { ok: false, reason: 'off' }
 *   report  → the row is read and the log says what WOULD happen; nothing is written
 *   on      → { ok: true, id, minted } — the ID now on the row
 *
 * Refused (nothing minted): a row that is not on the Clients board, a Merged or
 * Archived row (never a number for a Merged row — a merge's loser keeps none), a
 * cell that could not be read (a write would cover a value it cannot see), or a
 * cell already holding something that is not a Client ID (the audit lists it; it is
 * never typed over). A number taken whose write then fails is burnt, never reused.
 *
 * @param {string} accountId  the Clients row's Monday item id
 * @param {{ knownId?: string, year?: number, why?: string }} [opts]
 *   knownId: a Client ID just read with the row (findOrCreate) — used without a read
 */
async function ensureClientId(accountId, { knownId = '', year, why = '' } = {}) {
  const { clientIdsMode } = require('../../config/features');
  const mode = clientIdsMode();
  if (mode === 'off') return { ok: false, reason: 'off' };
  try {
    const cfg = loadBoard();
    if (!cfg) return { ok: false, reason: 'dormant' };
    const col = (cfg.columns || {}).clientId;
    if (!col) return { ok: false, reason: 'not-configured' };
    const id = digitsOf(accountId);
    if (!id) return { ok: false, reason: 'no-account' };
    const known = String(knownId || '').trim();
    if (isClientId(known)) return mode === 'on' ? { ok: true, id: known, minted: false } : { ok: false, reason: 'report', existing: known };
    if (_idInFlight.has(id)) return await _idInFlight.get(id);
    const work = _ensureClientId(cfg, col, id, { mode, year, why });
    _idInFlight.set(id, work);
    try { return await work; } finally { _idInFlight.delete(id); }
  } catch (err) {
    console.warn(`[ClientId] account ${accountId}: ${err.message}`);
    return { ok: false, reason: 'error', message: err.message };
  }
}

/** One read of the account row's Client ID cell. { state: 'ok', text } | { state: 'not-found'|'merged'|'archived'|'unreadable'|'unavailable', … } */
async function readClientIdCell(cfg, col, id) {
  let data;
  try {
    data = await mondayApi.query(
      `query($id:ID!){ items(ids:[$id], limit:1){ id board { id } column_values(ids:${JSON.stringify([col, cfg.columns.status, cfg.columns.mergedInto])}){ id text } } }`,
      { id: String(id) });
  } catch (err) { return { state: 'unavailable', message: err.message }; }
  const it = data && data.items && data.items[0];
  if (!it || !it.board || String(it.board.id) !== String(cfg.boardId)) return { state: 'not-found' };
  const status = String(colText(it, cfg.columns.status)).trim();
  if (status === 'Merged') return { state: 'merged', mergedInto: String(colText(it, cfg.columns.mergedInto)).trim() };
  if (status === 'Archived') return { state: 'archived' };
  const cell = (it.column_values || []).find((c) => c.id === col);
  if (!cell) return { state: 'unreadable' };   // the column did not come back: never treat as blank
  return { state: 'ok', text: String(cell.text == null ? '' : cell.text).trim() };
}

async function writeClientIdCell(cfg, col, id, value) {
  await mondayApi.query(
    'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
    { b: String(cfg.boardId), i: String(id), c: JSON.stringify({ [col]: String(value) }) });
}

async function _ensureClientId(cfg, col, id, { mode, year, why }) {
  const tag = `[ClientId] account ${id}${why ? ` (${why})` : ''}`;
  const cell = await readClientIdCell(cfg, col, id);
  if (cell.state !== 'ok') {
    if (cell.state !== 'merged') console.warn(`${tag}: no Client ID — the row is ${cell.state}${cell.message ? ` (${cell.message})` : ''}`);
    return { ok: false, reason: cell.state, ...(cell.mergedInto ? { mergedInto: cell.mergedInto } : {}) };
  }
  if (cell.text) {
    if (!isClientId(cell.text)) {
      console.warn(`${tag}: the Client ID cell holds "${cell.text.slice(0, 40)}", which is not a Client ID — left as it is`);
      return { ok: false, reason: 'malformed', value: cell.text };
    }
    return mode === 'on' ? { ok: true, id: cell.text, minted: false } : { ok: false, reason: 'report', existing: cell.text };
  }
  if (mode !== 'on') {
    console.log(`${tag}: would get a new Client ID (CLIENT_IDS=report — nothing written)`);
    return { ok: false, reason: 'report', wouldMint: true };
  }
  const allocator = require('./clientIdAllocator');
  const a = await allocator.allocate(year == null ? {} : { year });
  if (!a || !a.ok) {
    console.warn(`${tag}: no Client ID given — ${(a && a.message) || 'the counter refused'}`);
    return { ok: false, reason: (a && a.reason) || 'refused', message: a && a.message };
  }
  // Looked at once more right before writing: another instance may have given this
  // person a number meanwhile — theirs stands, ours is burnt (never reused).
  const again = await readClientIdCell(cfg, col, id);
  if (again.state === 'ok' && isClientId(again.text)) {
    console.warn(`${tag}: got ${again.text} from another instance meanwhile — ${a.id} is left unused`);
    return { ok: true, id: again.text, minted: false, burnt: a.id };
  }
  if (again.state !== 'ok' || again.text) {
    console.warn(`${tag}: the row changed (${again.state}${again.text ? ` "${again.text.slice(0, 40)}"` : ''}) — ${a.id} is left unused`);
    return { ok: false, reason: again.state === 'ok' ? 'malformed' : again.state, burnt: a.id };
  }
  try { await writeClientIdCell(cfg, col, id, a.id); }
  catch (err) {
    console.warn(`${tag}: ${a.id} could not be written (${err.message}) — that number is left unused; tried again later`);
    return { ok: false, reason: 'write-failed', burnt: a.id, message: err.message };
  }
  // Read back: the cell is the truth. Two instances writing at once both end up
  // with what the row finally holds (the copies are then the same).
  const after = await readClientIdCell(cfg, col, id);
  if (after.state === 'ok' && isClientId(after.text) && after.text !== a.id) {
    console.warn(`${tag}: the row holds ${after.text} (another instance wrote last) — ${a.id} is left unused`);
    return { ok: true, id: after.text, minted: false, burnt: a.id };
  }
  console.log(`${tag}: Client ID ${a.id} given`);
  return { ok: true, id: a.id, minted: true };
}

// ─── Following "Merged into" (review #9) ─────────────────────────────────────────

const MAX_MERGE_HOPS = 10;

/**
 * The record a client record stands for today: itself, or — Merged — the record it was
 * merged into, and so on down the chain. The "Merged into" box is free text: a record
 * number (Monday item id) or a Client ID ("CL-2026-00042"). Stops, and says why, on:
 *   missing         a record not on the Clients board
 *   cycle           a chain that comes back on itself
 *   archived        it ends on an Archived record
 *   merged-nowhere  a Merged record whose box is blank or unreadable
 *   ambiguous       a Client ID found on two records
 *   too-deep        more than 10 steps
 *   bad-link        the start is not a record number
 *   unavailable     a read failed (never taken as "missing")
 *
 * @param {string} startId  a record number
 * @param {{ getById: (id) => row|null|Promise, getByClientNumber?: (n) => row[]|Promise }} lookup
 *   row = { id, status, mergedInto, clientIdText, … }; getById may throw (→ unavailable)
 * @returns {Promise<{ ok: true, accountId, row, path: string[], merged: boolean }
 *                  | { ok: false, reason, path: string[] }>}
 */
async function resolveAccount(startId, lookup) {
  const path = [];
  let id = /^\s*\d+\s*$/.test(String(startId == null ? '' : startId)) ? String(startId).trim() : '';
  if (!id) return { ok: false, reason: 'bad-link', path };
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    if (path.includes(id)) return { ok: false, reason: 'cycle', path: [...path, id] };
    path.push(id);
    let row;
    try { row = await lookup.getById(id); }
    catch (err) { return { ok: false, reason: 'unavailable', message: err.message, path }; }
    if (!row) return { ok: false, reason: 'missing', path };
    const status = String(row.status || '').trim();
    if (status === 'Archived') return { ok: false, reason: 'archived', path };
    if (status !== 'Merged') return { ok: true, accountId: String(row.id), row, path, merged: path.length > 1 };
    const into = String(row.mergedInto || '').trim();
    if (/^\d+$/.test(into)) { id = into; continue; }
    const { parseClientId } = require('../utils/clientId');
    const p = isClientId(into) ? parseClientId(into) : null;
    if (!p || !lookup.getByClientNumber) return { ok: false, reason: 'merged-nowhere', path };
    let hits;
    try { hits = (await lookup.getByClientNumber(p.n)) || []; }
    catch (err) { return { ok: false, reason: 'unavailable', message: err.message, path }; }
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', path };
    if (!hits.length) return { ok: false, reason: 'missing', path };
    id = String(hits[0].id);
  }
  return { ok: false, reason: 'too-deep', path };
}

/** One Clients row read for resolveAccount: { id, status, mergedInto, clientIdText } or null (not on the board). */
async function readAccountRow(cfg, id) {
  const idCol = (cfg.columns || {}).clientId || '';
  const cols = [cfg.columns.status, cfg.columns.mergedInto, ...(idCol ? [idCol] : [])];
  const data = await mondayApi.query(
    `query($id:ID!){ items(ids:[$id], limit:1){ id name board { id } column_values(ids:${JSON.stringify(cols)}){ id text } } }`,
    { id: String(id) });
  const it = data && data.items && data.items[0];
  if (!it || !it.board || String(it.board.id) !== String(cfg.boardId)) return null;
  return { id: String(it.id), name: it.name, status: String(colText(it, cfg.columns.status)).trim(),
    mergedInto: String(colText(it, cfg.columns.mergedInto)).trim(), clientIdText: idCol ? String(colText(it, idCol)).trim() : '' };
}

/**
 * resolveAccount over Monday reads (one row at a time): the record and the readable
 * Client ID a record number stands for today. Never throws.
 * @returns {Promise<{ ok: true, accountId, clientIdText, merged, path } | { ok: false, reason, path }>}
 */
async function resolveClientId(accountId) {
  const cfg = loadBoard();
  if (!cfg) return { ok: false, reason: 'dormant', path: [] };
  try {
    const idCol = (cfg.columns || {}).clientId || '';
    const r = await resolveAccount(accountId, {
      getById: (id) => readAccountRow(cfg, id),
      getByClientNumber: idCol ? async (n) => {
        const { formatClientId } = require('../utils/clientId');
        const { torontoYear } = require('../utils/torontoTime');
        const forms = [];
        for (let y = 2000; y <= torontoYear(Date.now()) + 1; y++) forms.push(formatClientId(y, n));
        const d = await mondayApi.query(
          `query($b:ID!,$v:[String]!){ items_page_by_column_values(limit:2, board_id:$b, columns:[{column_id:"${idCol}", column_values:$v}]){ items{ id } } }`,
          { b: String(cfg.boardId), v: forms });
        return ((d && d.items_page_by_column_values && d.items_page_by_column_values.items) || []).map((x) => ({ id: String(x.id) }));
      } : null,
    });
    if (!r.ok) return r;
    return { ok: true, accountId: r.accountId, clientIdText: isClientId(r.row.clientIdText) ? r.row.clientIdText : '', merged: r.merged, path: r.path };
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: err.message, path: [] };
  }
}

/**
 * The record to use for an account a lead already carries (staff chose it, or a paid
 * consultation made it): with CLIENT_IDS 'on', a Merged one is followed to the record
 * it was merged into. Anything else — off, report, a chain that cannot be followed —
 * keeps the account as given (the case is linked as before; the ID step then refuses
 * a Merged/Archived row). Never throws.
 */
async function survivingAccount(accountId, { why = '' } = {}) {
  const given = String(accountId || '').trim();
  if (!given || !require('../../config/features').clientIdsOn()) return given;
  const r = await module.exports.resolveClientId(given);
  if (r.ok && r.accountId !== given) {
    console.log(`[ClientId] account ${given} was merged into ${r.accountId} — that one is used${why ? ` (${why})` : ''}`);
    return r.accountId;
  }
  if (!r.ok && r.reason !== 'unavailable' && r.reason !== 'dormant') console.warn(`[ClientId] account ${given}: ${r.reason} — kept as it is${why ? ` (${why})` : ''}`);
  return given;
}

// ─── A paid consultation gives the person their account + Client ID (decision 6) ──

const _paidInFlight = new Map();   // lead id → Promise

/**
 * A consultation was PAID — online (Square link or invoice), recorded by staff
 * (cash / e-transfer / invoice / Square outside the app), Waived / Free, or a direct
 * consultation with its fee. Make sure the person has their Clients account and its
 * Client ID, and the lead points at both — so the case, when it opens, lands on the
 * same person (stampClientAccount reuses lead.clientAccountId).
 *
 * Only with CLIENT_IDS 'on' (and client accounts on). 'report': read-only — the log
 * says what would happen. 'off': nothing at all.
 * The same strict matching as the handoff: an exact match is linked; a weaker one
 * (shared email, phone only) is NOT — a new account is made and the possible match
 * is left for staff (a note on the lead). Safe to run again (webhook retry, a record
 * edited): the lead's account and its ID are reused, never a second number.
 * Never throws.
 *
 * @param {string} leadId
 * @param {{ lead?: object, via?: string }} [opts] lead: the lead as the caller has it (saves a read)
 */
async function onConsultationPaid(leadId, { lead = null, via = '' } = {}) {
  const features = require('../../config/features');
  const mode = features.clientIdsMode();
  if (mode === 'off') return { ok: false, reason: 'off' };
  if (!features.clientAccountsEnabled) return { ok: false, reason: 'accounts-off' };
  if (!loadBoard()) return { ok: false, reason: 'dormant' };
  const key = digitsOf(leadId);
  if (!key) return { ok: false, reason: 'no-lead' };
  if (_paidInFlight.has(key)) return _paidInFlight.get(key);
  const work = (async () => {
    try { return await _onConsultationPaid(key, { lead, via, mode }); }
    catch (err) {
      console.warn(`[ClientId] paid consultation, lead ${key}: ${err.message}`);
      return { ok: false, reason: 'error', message: err.message };
    }
  })();
  _paidInFlight.set(key, work);
  try { return await work; } finally { _paidInFlight.delete(key); }
}

async function _onConsultationPaid(leadId, { lead, via, mode }) {
  const self = module.exports;   // through the exports, so each step can be replaced in a test
  const tag = `[ClientId] paid consultation${via ? ` (${via})` : ''}, lead ${leadId}`;
  let l = lead;
  if (!l || !l.id) l = { ...(await require('./leadService').getLead(leadId)), ...(lead || {}) };
  if (!l || (!l.id && !l.fullName)) return { ok: false, reason: 'no-lead' };
  const preChosen = digitsOf(l.clientAccountId);
  const year = yearForLead(l);

  if (!preChosen && !normalizeEmail(l.email) && !normalizePhone(l.phone)) {
    // Nothing to match on: an account made now could never be found again — the case opening makes it.
    console.log(`${tag}: no email or phone — no account made now`);
    return { ok: false, reason: 'no-contact' };
  }

  if (mode !== 'on') {
    if (preChosen) {
      const r = await self.ensureClientId(preChosen, { year, why: 'paid consultation' });
      console.log(`${tag}: would keep the lead's account (Client ID ${r.existing || (r.wouldMint ? 'would be given' : r.reason)}) — CLIENT_IDS=report, nothing written`);
      return { ok: false, reason: 'report', clientId: preChosen };
    }
    const m = await self.findMatches({ email: l.email, phone: l.phone, fullName: l.fullName });
    const exact = m.find((x) => x.confidence === 'exact');
    const review = m.filter((x) => x.confidence === 'review').length;
    console.log(`${tag}: would ${exact ? `link the account with ${exact.clientIdText || 'no Client ID yet'}` : `make a new account${review ? ` (${review} possible match${review > 1 ? 'es' : ''} left for staff)` : ''}`} — CLIENT_IDS=report, nothing written`);
    return { ok: false, reason: 'report', ...(exact ? { clientId: exact.id } : {}) };
  }

  let clientId = preChosen ? await self.survivingAccount(preChosen, { why: 'paid consultation' }) : '';
  let created = false, knownId = '', review = [];
  if (!clientId) {
    const r = await self.findOrCreate({
      email: l.email, phone: l.phone, fullName: l.fullName || l.name,
      residentialAddress: l.residentialAddress, source: 'consultation',
    });
    if (!r) return { ok: false, reason: 'dormant' };
    clientId = r.clientId; created = !!r.created; knownId = r.clientIdText || ''; review = r.reviewCandidates || [];
    if (created) console.log(`${tag}: client account ${clientId} made for "${l.fullName || l.name || ''}"`);
  }
  const idr = await self.ensureClientId(clientId, { knownId, year, why: 'paid consultation' });
  const clientIdText = idr && idr.ok ? idr.id : '';
  // Always (also for an account staff chose): it stamps the lead, copies the ID to it
  // and adds the lead to the account's Leads — all idempotent.
  await self.linkLead(clientId, leadId, { clientIdText });
  if (created && review.length) await noteReviewCandidates(leadId, review).catch(() => {});
  return { ok: true, clientId, created, clientIdText, minted: !!(idr && idr.minted), reason: idr && !idr.ok ? idr.reason : '' };
}

/** A note on the lead: an existing client looks like this person, but was not linked (staff decide). Names and Client IDs only. */
async function noteReviewCandidates(leadId, review) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const who = review.slice(0, 5).map((r) => `${esc(r.name || 'a client')}${isClientId(r.clientIdText) ? ` (${esc(r.clientIdText)})` : ''} — ${esc((r.reasons || []).join(', '))}`).join('; ');
  await mondayApi.query('mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }', {
    i: String(leadId),
    b: `👥 <b>Possibly the same person as an existing client</b>: ${who}. They were NOT linked — this person was given their own client record. If it is the same person, tell the admin so the two can be joined.`,
  });
}

/**
 * Fire-and-forget form of onConsultationPaid for the payment paths: the payment's
 * own steps never wait for it and never see it fail. Returns the promise (tests).
 */
function queueConsultationPaid(leadId, opts = {}) {
  let p;
  try { p = module.exports.onConsultationPaid(leadId, opts); }
  catch (err) { p = Promise.resolve({ ok: false, reason: 'error', message: err.message }); }
  return Promise.resolve(p).catch((err) => ({ ok: false, reason: 'error', message: err && err.message }));
}

/** One account row with its profile fields. null when dormant or missing. */
async function getClient(clientId) {
  const cfg = loadBoard();
  if (!cfg) return null;
  const data = await mondayApi.query(
    `query($id:ID!){ items(ids:[$id]){ id name board { id } column_values{ id text } } }`,
    { id: String(clientId) }
  );
  const it = data?.items?.[0];
  if (!it || !it.board || String(it.board.id) !== String(cfg.boardId)) return null;
  const g = (colId) => colText(it, colId);
  return {
    id: String(it.id),
    name: it.name,
    email: g(cfg.columns.primaryEmail),
    phone: g(cfg.columns.phone),
    residentialAddress: g(cfg.columns.residentialAddress),
    dob: g(cfg.columns.dateOfBirth),
    status: g(cfg.columns.status),
    squareCustomerId: g(cfg.columns.squareCustomerId),
  };
}

/** Every Client Master case stamped with this account id. */
async function getClientCases(clientId) {
  const cfg = loadBoard();
  if (!cfg || !(cfg.cmLinkColumns || {}).clientAccountId) return [];
  const { clientMasterBoardId } = require('../../config/monday');
  const data = await mondayApi.query(
    `query($b:ID!,$v:String!){ items_page_by_column_values(limit:100, board_id:$b, columns:[{column_id:"${cfg.cmLinkColumns.clientAccountId}", column_values:[$v]}]){ items{ id name column_values(ids:["text_mm142s49","dropdown_mm0xd1qn","color_mm0x8faa","color_mm0x9fnn"]){ id text } } } }`,
    { b: String(clientMasterBoardId), v: String(clientId) }
  );
  return (data?.items_page_by_column_values?.items || []).map((it) => ({
    cmItemId: String(it.id),
    name: it.name,
    caseRef: colText(it, 'text_mm142s49'),
    caseType: colText(it, 'dropdown_mm0xd1qn'),
    caseStage: colText(it, 'color_mm0x8faa'),
    paymentStatus: colText(it, 'color_mm0x9fnn'),
  }));
}

module.exports = {
  loadBoard, normalizeEmail, normalizePhone, classifyMatch,
  findMatches, findOrCreate, linkCase, linkLead, getClient, getClientCases,
  ensureClientId, yearForLead, onConsultationPaid, queueConsultationPaid,
  resolveAccount, resolveClientId, survivingAccount, MAX_MERGE_HOPS,
  _setBoardForTests,
};
