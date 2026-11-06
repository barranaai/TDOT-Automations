'use strict';

/**
 * Where a document reminder's wording comes from (block 2, plan §3b).
 *
 * An optional Monday board "Reminder Templates" (env MONDAY_REMINDER_TEMPLATES_BOARD_ID)
 * holds one row per template — Reminder 1 / Reminder 2 / Final / Automatic — with a
 * Subject text column, a Body long-text column and an Active Yes/No status, all found
 * by TITLE so the board can be built by hand. The team edits wording there without a
 * deploy. Read with a 30-minute cache (caseReadinessService.loadThresholds pattern).
 *
 * Every row is checked at load AND the chosen text is checked again at send
 * (docReminderService): plain text only (tags stripped), {MissingList} present, no
 * "just reply" wording, unknown {Token}s left visible and flagged. A row that fails,
 * is switched off, is missing, or a board that cannot be read → the code default
 * from config/reminderTemplates.js for that row, and a diagnostic the Needs-attention
 * layer can read (diagnostics() — a getter, this module writes nothing to Monday).
 */

const mondayApi = require('./mondayApi');
const { TOKENS, ROW_NAMES, LEVEL_ROWS, DEFAULTS } = require('../../config/reminderTemplates');

const CACHE_TTL_MS = 30 * 60 * 1000;   // a board edit shows within half an hour
const FAIL_TTL_MS  = 5 * 60 * 1000;    // an unreadable board is retried sooner, not on every send

// the no-reply rule — built from pieces because test/clientContactAndConvert.test.js scans
// every service line for the same phrases (a board edit is the one place they could reappear)
const REPLY_WORDING = new RegExp(['(just|simply|please) reply', 'reply to (this|the) (email|message)', 'reply with (it|the file|the document)', 'reply (back )?to us'].join('|'), 'i');
const TOKEN_RE = /\{([A-Za-z]+)\}/g;
const KNOWN = new Set(TOKENS);

let _cache = null, _cacheAge = 0, _cacheTtl = CACHE_TTL_MS;

function boardId() { return String(process.env.MONDAY_REMINDER_TEMPLATES_BOARD_ID || '').trim(); }

/** Monday long-text keeps what was typed; a pasted email can carry tags and entities. Plain text out. */
function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/\r\n?/g, '\n').trim();
}

/** Does a text (tags stripped) tell the client to reply? The one check for the subject, the body and the staff's extra line. */
function tellsToReply(text) { return REPLY_WORDING.test(stripHtml(text)); }

/** The token names used in a text that are not merge tokens ({Foo} stays visible in the email). */
function unknownTokens(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(TOKEN_RE)) if (!KNOWN.has(m[1])) out.add(m[1]);
  return [...out];
}

/**
 * Check one template's text. { ok, subject, body, problems[], warnings[] } — subject and
 * body come back as plain text; problems = cannot be used; warnings = sent as is, flagged.
 */
function validate({ subject, body }) {
  const s = stripHtml(subject).replace(/\s*\n\s*/g, ' ');
  const b = stripHtml(body);
  const problems = [], warnings = [];
  if (!b) problems.push('the body is empty');
  if (b && !b.includes('{MissingList}')) problems.push('the body has no {MissingList} — the missing documents would not be listed');
  if (REPLY_WORDING.test(b) || REPLY_WORDING.test(s)) problems.push('the text tells the client to reply — the sender is a no-reply mailbox; say "email us at info@tdotimm.com" instead');
  const unknown = unknownTokens(`${s}\n${b}`);
  if (unknown.length) warnings.push(`unknown merge field${unknown.length === 1 ? '' : 's'} left as typed: ${unknown.map((t) => `{${t}}`).join(', ')}`);
  return { ok: problems.length === 0, subject: s, body: b, problems, warnings };
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const rowFor = (name) => ROW_NAMES.find((r) => norm(r) === norm(name)) || '';

/** One read of the board: { rows: { [rowName]: { subject, body, active } }, problem } */
async function readBoard(id) {
  const data = await mondayApi.query(
    `query($boardId: ID!) {
       boards(ids: [$boardId]) {
         columns { id title type }
         items_page(limit: 50) { items { name column_values { id text value } } }
       }
     }`,
    { boardId: id }
  );
  const board = data && data.boards && data.boards[0];
  if (!board) return { rows: {}, problem: `board ${id} was not found` };
  const cols = board.columns || [];
  const byTitle = (re, types) => cols.find((c) => re.test(norm(c.title)) && (!types || types.includes(c.type)));
  const subjectCol = byTitle(/^subject/, ['text']) || byTitle(/^subject/);
  const bodyCol    = byTitle(/^body/, ['long_text', 'long-text']) || byTitle(/^body/);
  const activeCol  = byTitle(/^active/, ['status', 'color']) || byTitle(/^active/);
  if (!subjectCol || !bodyCol) return { rows: {}, problem: `board ${id} has no ${!subjectCol ? 'Subject' : 'Body'} column` };
  const rows = {};
  for (const item of (board.items_page && board.items_page.items) || []) {
    const row = rowFor(item.name);
    if (!row || rows[row]) continue;   // unknown names ignored; the first of a duplicated name wins
    const cell = (c) => (item.column_values || []).find((v) => v.id === c.id) || {};
    const act = activeCol ? cell(activeCol) : null;
    // an empty status cell reads its id-5 label as text with value null (src/utils/mondayStatus.js)
    const activeText = act ? (act.value === null ? '' : String(act.text || '')) : 'Yes';
    rows[row] = { subject: String(cell(subjectCol).text || ''), body: String(cell(bodyCol).text || ''), active: /^yes$/i.test(activeText.trim()) };
  }
  return { rows, problem: '' };
}

/**
 * All four templates, resolved: { [rowName]: { name, subject, body, source, warnings } }
 * source = 'board' | 'default'. Defaults with no read when the env is unset.
 */
async function loadTemplates() {
  if (_cache && Date.now() - _cacheAge < _cacheTtl) return _cache.templates;
  const id = boardId();
  const templates = {}, diagnostics = [];
  const useDefault = (name, why) => {
    const d = validate(DEFAULTS[name]);
    templates[name] = { name, subject: d.subject, body: d.body, source: 'default', warnings: d.warnings };
    if (why) diagnostics.push({ row: name, problems: [why] });
  };
  if (!id) {
    for (const name of ROW_NAMES) useDefault(name, '');
    _cache = { templates, diagnostics }; _cacheAge = Date.now(); _cacheTtl = CACHE_TTL_MS;
    return templates;
  }
  let read;
  try { read = await readBoard(id); }
  catch (err) { read = { rows: {}, problem: `the Reminder Templates board could not be read (${err.message})` }; }
  for (const name of ROW_NAMES) {
    const row = read.rows[name];
    if (read.problem) { useDefault(name, read.problem); continue; }
    if (!row) { useDefault(name, ''); continue; }                       // no row = not written yet, not a fault
    if (!row.active) { useDefault(name, ''); continue; }                 // switched off on purpose
    const v = validate(row);
    if (!v.ok) { useDefault(name, `board template "${name}" is invalid — ${v.problems.join('; ')} — the code default is used`); continue; }
    templates[name] = { name, subject: v.subject || validate(DEFAULTS[name]).subject, body: v.body, source: 'board', warnings: v.warnings };
  }
  _cache = { templates, diagnostics }; _cacheAge = Date.now();
  _cacheTtl = read.problem ? FAIL_TTL_MS : CACHE_TTL_MS;
  return templates;
}

/** The template for a staff level (1 | 2 | 3) or the automatic email ('auto'). */
async function templateFor(level) {
  const name = LEVEL_ROWS[level];
  if (!name) throw new Error(`Unknown reminder level: ${level}`);
  return (await loadTemplates())[name];
}

/**
 * What the last load found wrong: [{ row, problems: [...] }] — empty when every row is
 * fine. Read by the Needs-attention layer (later step); never a board write. Reflects
 * the cached load (nothing is read here).
 */
function diagnostics() { return _cache ? _cache.diagnostics.map((d) => ({ row: d.row, problems: [...d.problems] })) : []; }

function _resetForTests() { _cache = null; _cacheAge = 0; _cacheTtl = CACHE_TTL_MS; }

module.exports = { loadTemplates, templateFor, validate, stripHtml, unknownTokens, tellsToReply, diagnostics, TOKENS, ROW_NAMES, LEVEL_ROWS, DEFAULTS, _resetForTests };
