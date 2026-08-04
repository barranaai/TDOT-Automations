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

const CFG_PATH = path.join(__dirname, '..', 'data', 'clientsBoard.json');

let _cfg;
/** The generated board config — null when the board doesn't exist (feature dormant). */
function loadBoard() {
  if (_cfg !== undefined) return _cfg;
  try { _cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch (_) { _cfg = null; }
  return _cfg;
}

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
  const data = await mondayApi.query(
    `query($b:ID!,$v:String!){ items_page_by_column_values(limit:25, board_id:$b, columns:[{column_id:"${colId}", column_values:[$v]}]){ items{ id name column_values(ids:${JSON.stringify([cfg.columns.primaryEmail, cfg.columns.phone, cfg.columns.dateOfBirth, cfg.columns.status])}){ id text } } } }`,
    { b: String(cfg.boardId), v: String(value) }
  );
  return (data?.items_page_by_column_values?.items || []).map((it) => ({
    id: String(it.id),
    name: it.name,
    email: colText(it, cfg.columns.primaryEmail),
    phone: colText(it, cfg.columns.phone),
    dob: colText(it, cfg.columns.dateOfBirth),
    status: colText(it, cfg.columns.status),
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
    // Monday stores phone columns as +<digits>; query both stored forms.
    for (const v of [`+${p}`, `+1${p}`]) {
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
  const key = `${normalizeEmail(email)}|${normName(fullName)}`;
  if (_inFlight.has(key)) return _inFlight.get(key);

  const work = (async () => {
    const matches = await findMatches({ email, phone, fullName, dob });
    const exact = matches.find((m) => m.confidence === 'exact');
    if (exact) return { clientId: exact.id, created: false, matchBasis: exact.reasons, reviewCandidates: [] };

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
        return { clientId: canonical.id, created: false, matchBasis: ['race-reconciled'], reviewCandidates: [] };
      }
    } catch (_) { /* reconcile is best-effort */ }

    return { clientId, created: true, matchBasis: [], reviewCandidates: matches.filter((m) => m.confidence === 'review') };
  })();

  _inFlight.set(key, work);
  try { return await work; } finally { _inFlight.delete(key); }
}

/** Stamp the account id on a Client Master case + append the navigation relation (best-effort). */
async function linkCase(clientId, { cmItemId }) {
  const cfg = loadBoard();
  if (!cfg || !clientId || !cmItemId) return;
  const link = cfg.cmLinkColumns || {};
  const { clientMasterBoardId } = require('../../config/monday');
  if (link.clientAccountId) {
    await mondayApi.query(
      'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
      { b: String(clientMasterBoardId), i: String(cmItemId), c: JSON.stringify({ [link.clientAccountId]: String(clientId) }) }
    );
  }
  if (link.clientRelation) {
    try {
      await mondayApi.query(
        'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
        { b: String(clientMasterBoardId), i: String(cmItemId), c: JSON.stringify({ [link.clientRelation]: { item_ids: [Number(clientId)] } }) }
      );
    } catch (err) { console.warn(`[ClientAccount] navigation relation write failed for case ${cmItemId}: ${err.message}`); }
  }
  // Reverse navigation: add this case to the account's Cases relation (append-safe).
  if (cfg.columns.cases) {
    try {
      const existing = await mondayApi.query(
        `query($id:ID!){ items(ids:[$id]){ column_values(ids:["${cfg.columns.cases}"]){ value } } }`,
        { id: String(clientId) }
      );
      const raw = existing?.items?.[0]?.column_values?.[0]?.value;
      const ids = new Set();
      try { for (const x of (JSON.parse(raw || '{}').linkedPulseIds || [])) ids.add(Number(x.linkedPulseId)); } catch (_) { /* fresh */ }
      ids.add(Number(cmItemId));
      await mondayApi.query(
        'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
        { b: String(cfg.boardId), i: String(clientId), c: JSON.stringify({ [cfg.columns.cases]: { item_ids: [...ids] } }) }
      );
    } catch (err) { console.warn(`[ClientAccount] Cases relation append failed for client ${clientId}: ${err.message}`); }
  }
}

/** Stamp the account id on a lead (best-effort; leadService validates the column). */
async function linkLead(clientId, leadId) {
  if (!loadBoard() || !clientId || !leadId) return;
  const leadService = require('./leadService');
  try { await leadService.updateLead(String(leadId), { clientAccountId: String(clientId) }); }
  catch (err) { console.warn(`[ClientAccount] lead stamp failed for ${leadId}: ${err.message}`); }
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
};
