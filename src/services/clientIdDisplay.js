'use strict';

/**
 * Where the Client ID SHOWS (build step 5, 2026-11-25) — the small shared pieces
 * the pages, the client portal, the client emails and the Leads search use.
 *
 * Rules (do not undo):
 *  - Only a STORED Client ID ("CL-2026-00042", utils/clientId.isClientId) is ever
 *    shown. Anything else in a box (a typo, a Monday item id, text) shows nothing —
 *    a blank ID renders as nothing at all, never "CL-" or "undefined".
 *  - The readable ID is fine to show. The Client Account (Monday item) id, the
 *    Case Access Token and the OneDrive Folder Id never are.
 *  - Never in an email SUBJECT (the subject carries "— ref · stage", which the app
 *    reads back), never in a folder name, an Otter code, Square or a payment ref.
 *  - Family members and sponsors have no own ID: a sponsor's email never carries
 *    the client's number (it is not theirs).
 *  - The column ids come from src/data/clientsBoard.json (the column script fills
 *    them). While a column id is missing nothing is read and nothing shows.
 */

const { isClientId, parseClientId } = require('../utils/clientId');

const s = (v) => String(v == null ? '' : v).trim();

// The board config, read once (the file itself — this module loads nothing else: it is required by the mail sender).
const CFG_PATH = require('path').join(__dirname, '../data/clientsBoard.json');
let _cfg;   // undefined = not read yet
function loadConfig() {
  if (_cfg !== undefined) return _cfg;
  try { _cfg = JSON.parse(require('fs').readFileSync(CFG_PATH, 'utf8')); } catch (_) { _cfg = null; }
  return _cfg;
}
/** Tests only: use this board config (undefined = read the file again). */
function _setConfigForTests(cfg) { _cfg = cfg; }

/** The three "Client ID" column ids ('' = not made yet): Clients (source of truth), Client Master and Lead Board (copies). */
function columns() {
  const c = loadConfig() || {};
  return {
    clients: s((c.columns || {}).clientId),
    cm:      s((c.cmLinkColumns || {}).clientId),
    lead:    s((c.leadLinkColumns || {}).clientId),
  };
}

/** The ID as it may be shown: the stored form only, else ''. */
function shownId(v) {
  const t = s(v);
  return isClientId(t) ? t : '';
}

function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "Your client number: CL-2026-00042" — '' when there is no ID. */
function clientNumberLine(id) {
  const v = shownId(id);
  return v ? `Your client number: ${v}` : '';
}

// ─── Client emails ────────────────────────────────────────────────────────────

/** The one short line a client email carries, as HTML ('' when there is no ID). Escaped. */
function mailLineHtml(id) {
  const line = clientNumberLine(id);
  if (!line) return '';
  return `<div data-tdot-client-id="1" style="margin:14px auto 0;max-width:600px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6B7280;">${escHtml(line)}</div>`;
}

/**
 * The email body with the client-number line, once, at the end of the body (just
 * before </body> when there is one). No ID, or a body that already has the line →
 * the body exactly as given.
 */
function addMailLine(html, id) {
  const body = String(html == null ? '' : html);
  const line = mailLineHtml(id);
  if (!line || body.includes('data-tdot-client-id="1"')) return body;
  const at = body.toLowerCase().lastIndexOf('</body>');
  return at >= 0 ? body.slice(0, at) + line + body.slice(at) : body + line;
}

/** The kinds of client email that never carry the line: not to the client themself, or a test. */
const NO_LINE_KINDS = new Set(['sponsor', 'test']);

const MAIL_CACHE_MS = 10 * 60 * 1000;
const MAIL_READ_MS  = 4000;
const _mailCache = new Map();   // 'cm:<id>' | 'lead:<id>' → { at, id }

const io = {
  query: (gql, vars) => require('./mondayApi').query(gql, vars),
  now: () => Date.now(),
  readMs: () => MAIL_READ_MS,
};

const itemIdOf = (v) => { const t = s(v); return /^\d{1,20}$/.test(t) ? t : ''; };

async function readCopy(colId, itemId) {
  const data = await io.query(
    `query($i:[ID!]){ items(ids:$i, limit:1){ id column_values(ids:["${colId}"]){ id text } } }`,
    { i: [itemId] });
  const it = (data && data.items && data.items[0]) || null;
  const cv = it && (it.column_values || []).find((c) => c && c.id === colId);
  return shownId(cv && cv.text);
}

const SLOW = Symbol('slow');
function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((resolve) => { t = setTimeout(() => resolve(SLOW), ms); })])
    .finally(() => clearTimeout(t));
}

/**
 * The Client ID for a CLIENT email's tag ({ caseItemId?, leadId?, kind, clientId? }): the
 * Client Master copy of the case first, else the Lead Board copy of the lead. Best-effort:
 * a read that fails or is slow gives '' (the email goes without the line, never late).
 * Nothing is read while the copy column is not made. Cached a few minutes per record.
 */
async function idForMail(tag) {
  const t = tag && typeof tag === 'object' ? tag : null;
  if (!t || NO_LINE_KINDS.has(s(t.kind))) return '';
  const given = shownId(t.clientId);
  if (given) return given;
  const cols = columns();
  const tries = [];
  const caseItem = itemIdOf(t.caseItemId), lead = itemIdOf(t.leadId);
  if (cols.cm && caseItem) tries.push(['cm', cols.cm, caseItem]);
  if (cols.lead && lead) tries.push(['lead', cols.lead, lead]);
  for (const [k, col, item] of tries) {
    const key = `${k}:${item}`;
    const hit = _mailCache.get(key);
    let id;
    if (hit && io.now() - hit.at < MAIL_CACHE_MS) id = hit.id;
    else {
      try {
        id = await withTimeout(readCopy(col, item), io.readMs());
        if (id === SLOW) id = '';   // too slow: this email goes without the line; nothing is kept, the next one asks again
        else {
          _mailCache.set(key, { at: io.now(), id });
          if (_mailCache.size > 2000) _mailCache.delete(_mailCache.keys().next().value);
        }
      } catch (_) { id = ''; }
    }
    if (id) return id;
  }
  return '';
}

/** The body a client email goes with: the line added when the person has an ID. Never throws. */
async function mailBody(html, tag) {
  try { return addMailLine(html, await idForMail(tag)); } catch (_) { return String(html == null ? '' : html); }
}

// ─── Other cases of this client ───────────────────────────────────────────────

/**
 * Where a Client Master row stands, for the "Other cases of this client" lists (review #10):
 * a row in the Cancel / Did not retain group is "Cancelled", one in the Leads group "Lead only",
 * the TEST group "Test" — none of them an open case. A live row whose stage is a closing
 * one is "Closed". Everything else is open.
 * @returns {{ kind: 'open'|'closed'|'cancelled'|'lead'|'test', label: string }}
 */
const CLOSED_STAGES = ['Approved', 'Refused', 'Closed', 'Withdrawn', 'Cancelled', 'Archived', 'Task Done'];
function caseStanding({ group, caseStage } = {}) {
  const cg = require('../utils/caseGroups');
  const g = group || {};
  if (cg.isTestGroup(g)) return { kind: 'test', label: 'Test' };
  if (cg.isLeadsGroup(g)) return { kind: 'lead', label: 'Lead only' };
  if (!cg.isCaseGroup(g)) return { kind: 'cancelled', label: 'Cancelled' };
  const st = s(caseStage);
  if (CLOSED_STAGES.some((x) => x.toLowerCase() === st.toLowerCase())) return { kind: 'closed', label: `Closed (${st})` };
  return { kind: 'open', label: st || 'Open' };
}

// ─── Search ───────────────────────────────────────────────────────────────────

/** The search fields of one record's ID: { clientN, clientYear } (0 / 0 when it has none). */
function searchFields(id) {
  const v = shownId(id);
  if (!v) return { clientN: 0, clientYear: 0 };
  const p = parseClientId(v);
  return { clientN: p ? p.n : 0, clientYear: p && p.year ? p.year : 0 };
}

/**
 * The typed search text read as a Client ID ("CL 42", "CL-2026-00042"), or null. The year,
 * when typed, must match too; the number alone is the person. Bare digits are never an ID
 * (they stay a phone search) — staff type "CL 42".
 */
function searchQuery(q) {
  return parseClientId(q);
}

/** Does one index entry ({ clientN, clientYear }) match a parsed query? */
function entryMatches(entry, parsed) {
  if (!entry || !parsed || !entry.clientN) return false;
  if (entry.clientN !== parsed.n) return false;
  return !parsed.year || entry.clientYear === parsed.year;
}

function _resetForTests() { _mailCache.clear(); _cfg = undefined; }

module.exports = {
  columns, shownId, escHtml, clientNumberLine, mailLineHtml, addMailLine, idForMail, mailBody,
  caseStanding, CLOSED_STAGES, searchFields, searchQuery, entryMatches,
  NO_LINE_KINDS, MAIL_CACHE_MS, MAIL_READ_MS, io, _resetForTests, _setConfigForTests,
};
