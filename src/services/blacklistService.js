'use strict';

/**
 * blacklistService — the "Not Wanted list" (Gauri 2026-10-08, point 5; Faran's
 * decisions 2026-10-15: a separate board, warn when the email OR the phone
 * matches, warn only — nothing is ever blocked, the client never sees it — and
 * only named admins remove someone).
 *
 * One row = one PERSON (the board in src/data/blacklistBoard.json; a missing
 * file = the feature is dormant and every check answers "not checked"). A row
 * is added when a consultant sets the outcome "Not Wanted" — from the portal
 * (with their reason), from a hand edit in Monday (the Lead Board webhook, which
 * re-reads the lead first), or by the 15-minute sweep as a backstop. A removal
 * never deletes: the row is kept as Removed with who/when/why.
 *
 * Reads: the whole board in one call (it is small), cached for TTL_MS and
 * dropped after every write. A failed read NEVER blocks anything — check()
 * says "not checked" and the page tells staff so.
 *
 * Matching: email lowercased; phone digits only, a leading 1 dropped from an
 * 11-digit number, and at least 10 digits (the 8–9 digit junk never matches).
 */

const fs   = require('fs');
const path = require('path');
const mondayApi = require('./mondayApi');
const { normalizeEmail, normalizePhone } = require('./clientAccountService');
const { isNotWanted, OUTCOME_NOT_WANTED } = require('../../config/outcomes');

const CFG_PATH = path.join(__dirname, '..', 'data', 'blacklistBoard.json');
const TTL_MS = 3 * 60 * 1000;
const PAGE = 500;
const MAX_PAGES = 20;
const SWEEP_MAX = 20;        // additions per sweep run — a backstop, not a bulk tool
const MAX_REASON = 300;

let _cfg;                    // undefined = not loaded; null = dormant
let _cache = null;           // { entries, at, gen }
let _inFlight = null;        // { promise, gen }
let _gen = 0;                // bumped by every write — a read that began before a write never repopulates the cache (review 2026-10-15)
const _adding = new Map();   // lead id → the add in progress (the portal's own write echoes back through the webhook)

function loadBoard() {
  if (_cfg !== undefined) return _cfg;
  try { _cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); if (!_cfg || !_cfg.boardId || !_cfg.columns) _cfg = null; }
  catch (_) { _cfg = null; }
  return _cfg;
}
const enabled = () => !!loadBoard();

/** A phone the list matches on: normalised AND at least 10 digits. '' otherwise. */
function matchablePhone(raw) {
  const p = normalizePhone(raw);
  return p.length >= 10 ? p : '';
}
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const uniq = (a) => [...new Set(a)];
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const today = () => require('../utils/torontoTime').torontoDay(new Date().toISOString());

/** The side effects behind one seam (tests replace these). */
const io = {
  async fetchEntries(cfg) {
    const C = cfg.columns;
    const ids = Object.values(C).map((id) => `"${id}"`).join(', ');
    const out = [];
    let cursor = null, pages = 0;
    do {
      const data = await mondayApi.query(
        `query($boardId: ID!, $cursor: String) {
           boards(ids: [$boardId]) { items_page(limit: ${PAGE}, cursor: $cursor) { cursor items { id name column_values(ids: [${ids}]) { id text value } } } }
         }`,
        { boardId: String(cfg.boardId), cursor }
      );
      const page = data?.boards?.[0]?.items_page;
      if (!page) throw new Error('the Not Wanted list could not be read');
      for (const it of page.items || []) out.push(parseItem(cfg, it));
      cursor = page.cursor || null;
      if (++pages > MAX_PAGES) throw new Error('the Not Wanted list did not end');
    } while (cursor);
    return out;
  },
  now: () => Date.now(),
};

function parseItem(cfg, it) {
  const C = cfg.columns;
  const cv = {};
  for (const c of it.column_values || []) cv[c.id] = c;
  const text = (key) => (cv[C[key]] && cv[C[key]].text) || '';
  const status = cv[C.status] ? require('../utils/mondayStatus').statusText(cv[C.status]) : '';
  return {
    id: String(it.id), name: it.name || '',
    emails: uniq(splitList(text('emails')).map(normalizeEmail).filter(Boolean)),
    phones: uniq(splitList(text('phones')).map(matchablePhone).filter(Boolean)),
    reason: text('reason'), status: status || 'Active',
    leadIds: uniq(splitList(text('leadIds')).map((x) => x.replace(/\D/g, '')).filter(Boolean)),
    addedBy: text('addedBy'), addedOn: text('addedOn'), source: text('source'),
    removedBy: text('removedBy'), removedOn: text('removedOn'), removalReason: text('removalReason'),
  };
}

/** The entries (cached). Throws only when there is no copy at all and the read fails. */
function _read(cfg) {
  if (_inFlight && _inFlight.gen === _gen) return _inFlight.promise;
  const gen = _gen;
  const promise = io.fetchEntries(cfg)
    .then((list) => { if (gen === _gen) _cache = { entries: list, at: io.now(), gen }; return list; })
    .finally(() => { if (_inFlight && _inFlight.promise === promise) _inFlight = null; });
  _inFlight = { promise, gen };
  return promise;
}

async function entries({ fresh = false } = {}) {
  const cfg = loadBoard();
  if (!cfg) return [];
  const age = _cache ? io.now() - _cache.at : Infinity;
  if (!fresh && _cache && _cache.gen === _gen && age < TTL_MS) return _cache.entries;
  // A read that began before the latest write (or before a fresh request) never answers it.
  if (fresh) _gen++;
  try { return await _read(cfg); }
  catch (err) {
    if (_cache && !fresh) { console.warn(`[Blacklist] read failed, serving the copy from ${Math.round(age / 1000)} s ago: ${err.message}`); return _cache.entries; }
    throw err;
  }
}
function invalidate() { _gen++; _cache = null; }

/**
 * Is this person on the list? NEVER throws, never blocks.
 * @returns {{checked:boolean, hit:boolean, matchedOn:''|'email'|'phone'|'both', entries:object[], dormant?:true, error?:string}}
 */
async function check({ email, phone } = {}) {
  const none = { checked: false, hit: false, matchedOn: '', entries: [] };
  if (!enabled()) return { ...none, dormant: true };
  const e = normalizeEmail(email), p = matchablePhone(phone);
  if (!e && !p) return { ...none, checked: true };
  let list;
  try { list = await entries(); }
  catch (err) { return { ...none, error: err.message }; }
  const hits = [];
  for (const en of list) {
    if (en.status !== 'Active') continue;
    const byEmail = !!(e && en.emails.includes(e)), byPhone = !!(p && en.phones.includes(p));
    if (!byEmail && !byPhone) continue;
    hits.push({ id: en.id, name: en.name, reason: en.reason, addedBy: en.addedBy, addedOn: en.addedOn, leadIds: en.leadIds, source: en.source,
      matchedOn: byEmail && byPhone ? 'both' : byEmail ? 'email' : 'phone' });
  }
  const anyEmail = hits.some((h) => h.matchedOn !== 'phone'), anyPhone = hits.some((h) => h.matchedOn !== 'email');
  return { checked: true, hit: hits.length > 0, matchedOn: hits.length ? (anyEmail && anyPhone ? 'both' : anyEmail ? 'email' : 'phone') : '', entries: hits };
}

/** One line for notes and banners. */
function describe(result) {
  if (!result || !result.hit) return '';
  const how = { both: 'email and phone', email: 'email', phone: 'phone' }[result.matchedOn] || result.matchedOn;
  const who = result.entries.map((h) => `${h.name || 'a person'}${h.reason ? ` — ${h.reason}` : ''}${h.addedBy ? ` (added by ${h.addedBy}${h.addedOn ? ` on ${h.addedOn}` : ''})` : ''}`).join('; ');
  return `On the Not Wanted list — matched by ${how}: ${who}.`;
}

/** The HTML note posted on a lead this person came back on (best-effort; never throws). */
async function noteOnLead(leadId, result, context) {
  if (!result || !result.hit) return false;
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  try {
    await mondayApi.query('mutation($id: ID!, $b: String!) { create_update(item_id: $id, body: $b) { id } }',
      { id: String(leadId), b: `⛔ <b>${esc(describe(result))}</b>${context ? ` ${esc(context)}` : ''} This is a warning only — nothing was blocked and the client was not told.` });
    return true;
  } catch (err) { console.warn(`[Blacklist] note failed on lead ${leadId}: ${err.message}`); return false; }
}

function _colsFor(cfg, entry) {
  const C = cfg.columns, cols = {};
  cols[C.emails] = entry.emails.join(', ');
  cols[C.phones] = entry.phones.join(', ');
  if (entry.reason != null) cols[C.reason] = { text: String(entry.reason).slice(0, 2000) };
  cols[C.status] = { label: entry.status };
  cols[C.leadIds] = entry.leadIds.join(', ');
  if (entry.addedBy != null) cols[C.addedBy] = String(entry.addedBy).slice(0, 120);
  if (entry.addedOn) cols[C.addedOn] = { date: entry.addedOn };
  if (entry.source != null) cols[C.source] = String(entry.source);
  return cols;
}

/**
 * Add the person on `lead` (outcome Not Wanted). One add per lead at a time:
 * the portal's own outcome write echoes back through the Lead Board webhook,
 * and the two must never make two rows or drop the consultant's reason.
 *   • An ACTIVE row that already carries this lead id, email or phone is the
 *     person's row: missing identifiers / the lead id are added, and an empty
 *     reason, or a row made by the webhook/sweep, is completed by a portal add.
 *   • A Removed row that names this lead is an admin's decision: an AUTOMATED
 *     add (webhook 'monday', 'sweep') leaves it alone; only a consultant's fresh
 *     portal decision lists the person again (a new row — the Removed one stays).
 * Throws on a write failure (callers decide; the sweep retries).
 * @returns {{ok:boolean, result:'created'|'merged'|'updated'|'exists'|'removed-by-admin', entryId:string}}
 */
function addFromLead(args = {}) {
  const key = args && args.lead && args.lead.id ? String(args.lead.id).replace(/\D/g, '') : '';
  if (!key) return _addFromLead(args);
  const prev = _adding.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => _addFromLead(args));
  _adding.set(key, run);
  run.catch(() => {}).finally(() => { if (_adding.get(key) === run) _adding.delete(key); });
  return run;
}

async function _addFromLead({ lead, reason = '', actor = null, source = 'portal' } = {}) {
  const cfg = loadBoard();
  if (!cfg) { const e = new Error('The Not Wanted list is not set up.'); e.dormant = true; throw e; }
  if (!lead || !lead.id) throw new Error('No lead.');
  const e = normalizeEmail(lead.email), p = matchablePhone(lead.phone);
  if (!e && !p) { const err = new Error('This lead has no usable email or phone, so nobody could be recognised by it — not added to the list.'); err.badRequest = true; throw err; }
  const leadId = String(lead.id).replace(/\D/g, '');
  const name = oneLine(lead.fullName || lead.name || '').slice(0, 250) || `Lead ${leadId}`;
  const automated = source !== 'portal';
  const by = oneLine(actor && actor.name ? actor.name : '').slice(0, 60) || (source === 'monday' ? 'set in Monday' : source);
  const why = oneLine(reason).slice(0, MAX_REASON);

  const list = await entries({ fresh: true });
  const activeRows = list.filter((en) => en.status === 'Active');
  const active = activeRows.find((en) => en.leadIds.includes(leadId))
    || activeRows.find((en) => (e && en.emails.includes(e)) || (p && en.phones.includes(p)));
  if (!active && automated) {
    const removed = list.find((en) => en.status !== 'Active' && en.leadIds.includes(leadId));
    if (removed) return { ok: true, result: 'removed-by-admin', entryId: removed.id };
  }
  if (active) {
    const C = cfg.columns, cols = {};
    const emails = uniq([...active.emails, ...(e ? [e] : [])]), phones = uniq([...active.phones, ...(p ? [p] : [])]), leadIds = uniq([...active.leadIds, leadId]);
    const grew = emails.length !== active.emails.length || phones.length !== active.phones.length || leadIds.length !== active.leadIds.length;
    if (grew) { cols[C.emails] = emails.join(', '); cols[C.phones] = phones.join(', '); cols[C.leadIds] = leadIds.join(', '); }
    // A consultant's portal add completes a row the webhook or the sweep made first.
    const madeByAutomation = ['monday', 'sweep'].includes(String(active.source || '').trim());
    let completed = false;
    if (why && !String(active.reason || '').trim()) { cols[C.reason] = { text: why }; completed = true; }
    if (!automated && madeByAutomation) { cols[C.addedBy] = by; cols[C.source] = source; completed = true; }
    if (!Object.keys(cols).length) return { ok: true, result: 'exists', entryId: active.id };
    await mondayApi.query('mutation($b: ID!, $i: ID!, $c: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }',
      { b: String(cfg.boardId), i: String(active.id), c: JSON.stringify(cols) });
    invalidate();
    return { ok: true, result: grew ? 'merged' : (completed ? 'updated' : 'exists'), entryId: active.id };
  }
  const entry = { emails: e ? [e] : [], phones: p ? [p] : [], reason: why, status: 'Active', leadIds: [leadId], addedBy: by, addedOn: today(), source };
  const data = await mondayApi.query('mutation($b: ID!, $n: String!, $c: JSON!) { create_item(board_id: $b, item_name: $n, column_values: $c) { id } }',
    { b: String(cfg.boardId), n: name, c: JSON.stringify(_colsFor(cfg, entry)) });
  invalidate();
  return { ok: true, result: 'created', entryId: String(data.create_item.id) };
}

/**
 * The webhook / sweep path: re-read the lead FRESH and add only if its outcome
 * really is Not Wanted (the webhook is unauthenticated; the snapshot is a copy).
 */
async function addFromLeadId(leadId, { source = 'monday', actor = null, reason = '' } = {}) {
  const lead = await require('./leadService').getLead(String(leadId));
  if (!lead) return { ok: false, result: 'no-lead' };
  if (!isNotWanted(lead.outcome)) return { ok: false, result: 'not-not-wanted', outcome: lead.outcome || '' };
  return addFromLead({ lead, reason, actor, source });
}

/** Named admins only (the route checks). The row is kept as Removed. */
async function remove({ entryId, reason = '', actor = null } = {}) {
  const cfg = loadBoard();
  if (!cfg) { const e = new Error('The Not Wanted list is not set up.'); e.dormant = true; throw e; }
  const id = String(entryId || '').replace(/\D/g, '');
  if (!id) { const e = new Error('Which entry?'); e.badRequest = true; throw e; }
  const why = oneLine(reason);
  if (why.length < 3) { const e = new Error('Give the reason for removing this person from the list (it is recorded).'); e.badRequest = true; throw e; }
  if (!actor || !actor.verified || !actor.name) { const e = new Error('A named admin is required.'); e.badRequest = true; throw e; }
  const en = (await entries({ fresh: true })).find((x) => x.id === id);
  if (!en) { const e = new Error('That entry is not on the list.'); e.notFound = true; throw e; }
  if (en.status !== 'Active') { const e = new Error('That entry was already removed.'); e.badRequest = true; throw e; }
  const C = cfg.columns;
  const cols = { [C.status]: { label: 'Removed' }, [C.removedBy]: String(actor.name).slice(0, 120), [C.removedOn]: { date: today() }, [C.removalReason]: { text: why.slice(0, 2000) } };
  await mondayApi.query('mutation($b: ID!, $i: ID!, $c: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }',
    { b: String(cfg.boardId), i: id, c: JSON.stringify(cols) });
  invalidate();
  // The lead(s) this person was Not Wanted on get a note — the warning on them is gone (best-effort).
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  for (const leadId of en.leadIds.slice(0, 10)) {
    try {
      await mondayApi.query('mutation($id: ID!, $b: String!) { create_update(item_id: $id, body: $b) { id } }',
        { id: leadId, b: `✅ <b>Removed from the Not Wanted list</b> by ${esc(actor.name)} — reason: ${esc(why)}. Staff are no longer warned about this person. (The outcome on this lead was not changed.)` });
    } catch (err) { console.warn(`[Blacklist] removal note failed on lead ${leadId}: ${err.message}`); }
  }
  return { ok: true, entryId: id, name: en.name, leadIds: en.leadIds };
}

/**
 * Backstop (every 15 min): every lead whose outcome is Not Wanted and which no
 * row names (Active, or Removed — an admin's removal stands) is added.
 * Discovery reads the shared snapshot; each decision re-reads the lead fresh.
 */
async function sweep() {
  if (!enabled()) return { skipped: 'dormant' };
  const snap = await require('./leadSnapshot').leads();
  const candidates = snap.filter((l) => isNotWanted(l.outcome));
  if (!candidates.length) return { candidates: 0, added: 0 };
  const list = await entries({ fresh: true });
  const covered = (lead) => list.some((en) => en.leadIds.includes(String(lead.id)));
  let added = 0, failed = 0, looked = 0;
  for (const c of candidates) {
    if (covered(c)) continue;
    if (++looked > SWEEP_MAX) break;
    try {
      const r = await addFromLeadId(c.id, { source: 'sweep' });
      if (r.ok && (r.result === 'created' || r.result === 'merged')) added++;
    } catch (err) { failed++; console.warn(`[Blacklist] sweep: lead ${c.id} not added: ${err.message}`); }
  }
  if (added || failed) console.log(`[Blacklist] sweep: ${candidates.length} Not Wanted lead(s), ${added} added, ${failed} failed`);
  return { candidates: candidates.length, added, failed };
}

/** For tests only. */
function _reset() { _cfg = undefined; _cache = null; _inFlight = null; _gen = 0; _adding.clear(); }
function _setConfig(cfg) { _cfg = cfg === undefined ? undefined : cfg; _cache = null; }

module.exports = { enabled, loadBoard, check, describe, noteOnLead, addFromLead, addFromLeadId, remove, sweep, entries, invalidate, matchablePhone, io, OUTCOME_NOT_WANTED, MAX_REASON, _reset, _setConfig };
