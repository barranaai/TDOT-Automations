'use strict';

/**
 * Client ID numbers ("CL-2026-00042") — one company-wide counter, never reset,
 * never reused (Faran 2026-11-25).
 *
 * The counter lives in OneDrive, OUTSIDE "Client Documents":
 *   TDOT System/client-id-counter.json = { last, updatedAt }
 * and `last` is the highest number ever handed out (or skipped).
 *
 * A number is taken by WRITING the counter, and only over the version that
 * was read (If-Match on its eTag). Two app instances during a deploy read the
 * same `last`; only one write wins, the other gets a conflict, reads again and
 * takes the next number. So the write IS the claim, and no number is ever
 * handed out twice. (The case-number allocator is weaker here — its
 * recordAssigned says "fine" whenever the mark is already high enough — so
 * this module shares none of its code or state, not even its lock.)
 *
 * Next number = last + 1. NOT "highest on the boards + 1" (review #6): a full
 * board scan on every new client is slow, and one hand-typed "CL-2026-90000"
 * would push the counter up for good. The boards are read only to SEED a
 * counter file that does not exist yet.
 *
 * Before a number is taken it is looked up once on the Clients board's
 * "Client ID" column (1 row): a number someone typed there by hand is
 * skipped — the counter goes past it (that number is burnt, never reused).
 *
 * A counter file that cannot be read, or is damaged, mints NOTHING: the ID
 * stays blank and the caller (or the hourly healer) tries again later. A
 * damaged file is only ever repaired upward, by repairCounter() (admin), with
 * a copy of it kept beside it. There is no fall-back to a remembered value.
 *
 * While the Client ID column ids are not in src/data/clientsBoard.json (the
 * column script has not run) every call is refused with 'not-configured'.
 *
 * This module does NOT look at the CLIENT_IDS switch: callers do (the live
 * mint only when it is 'on'; the backfill apply runs with live minting off).
 *
 * THE BACKFILL LOCK (review 2026-11-25): the CLIENT_IDS switch the backfill can see
 * is the one on the machine that runs it, not the live server's. So the apply also
 * writes `backfill: { by, at }` INTO the counter file (setBackfillLock, a
 * conflict-safe write) before its first write to Monday, and clears it at the end
 * (clearBackfillLock; `--unlock` after a crash). While it is there, allocate()
 * gives no number — on every server, whatever its switch says — and the hourly
 * healer writes nothing; the person gets the ID at the next hourly check after the
 * backfill. allocateBlock (the backfill's own reservation) keeps the lock as it is.
 */

const fs = require('fs');
const path = require('path');
const mondayApi = require('./mondayApi');
const { torontoYear } = require('../utils/torontoTime');
const { formatClientId, parseClientId, clientIdNumber } = require('../utils/clientId');

const COUNTER_PATH = 'TDOT System/client-id-counter.json';
const CFG_PATH     = path.join(__dirname, '..', 'data', 'clientsBoard.json');
const MAX_TRIES    = 5;    // conflicting writes (another instance took a number meanwhile)
const MAX_SKIPS    = 25;   // numbers found already typed on the board, in a row
const MAX_BLOCK    = 5000; // one backfill reservation
const FIRST_YEAR   = 2000; // the clash probe looks for the number under every label year from here

const s = (v) => String(v == null ? '' : v).trim();
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');

/** The board and column ids this module needs — '' for any that is not set yet. */
function readColumns() {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (_) { cfg = null; }
  if (!cfg) return { clientsBoardId: '', clientsCol: '', cmBoardId: '', cmCol: '' };
  return {
    clientsBoardId: s(cfg.boardId),
    clientsCol:     s((cfg.columns || {}).clientId),
    cmBoardId:      s(cfg.clientMasterBoardId),
    cmCol:          s((cfg.cmLinkColumns || {}).clientId),
  };
}

/** Every text value in one column of a board — items_page, 200 a page, with the cursor (never items(ids:) — the 25-row cap). */
async function columnTexts(boardId, colId) {
  const out = []; let cursor = null;
  do {
    // the same paging as caseRefAllocator.boardRefs
    const d = cursor
      ? await mondayApi.query(`query($b:[ID!],$c:String!){ boards(ids:$b){ items_page(limit:200, cursor:$c){ cursor items{ column_values(ids:["${colId}"]){ text } } } } }`, { b: [String(boardId)], c: cursor })
      : await mondayApi.query(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:200){ cursor items{ column_values(ids:["${colId}"]){ text } } } } }`, { b: [String(boardId)] });
    const page = (((d && d.boards) || [])[0] || {}).items_page;
    if (!page) throw new Error(`board ${boardId} could not be read`);
    for (const it of page.items || []) { const t = s(((it.column_values || [])[0] || {}).text); if (t) out.push(t); }
    cursor = page.cursor || null;
  } while (cursor);
  return out;
}

/* ───────────────────────────── I/O seam (tests replace these) ───────────────────────────── */
const io = {
  columns: readColumns,
  readCounter: () => require('./oneDriveService').readJsonFile(COUNTER_PATH),
  /** With an eTag: only over that version. Without: only when there is no file yet. A clash throws err.conflict. */
  writeCounter: (data, etag) => require('./oneDriveService').writeJsonFile(COUNTER_PATH, data, { etag: etag || '' }),
  writeBackup: (raw, at) => require('./oneDriveService').writeJsonFile(COUNTER_PATH.replace(/\.json$/, `.corrupt-${at}.json`), { raw }),
  /**
   * Is this number already on the Clients board, under ANY label year? One
   * items_page_by_column_values call, limit 1, every "CL-<year>-<n>" form of it.
   */
  async numberTaken(n, cols) {
    const years = [];
    for (let y = FIRST_YEAR; y <= torontoYear(io.now()) + 1; y++) years.push(formatClientId(y, n));
    const d = await mondayApi.query(
      `query($b:ID!,$v:[String]!){ items_page_by_column_values(limit:1, board_id:$b, columns:[{column_id:"${cols.clientsCol}", column_values:$v}]){ items{ id } } }`,
      { b: String(cols.clientsBoardId), v: years });
    return ((d.items_page_by_column_values || {}).items || []).length > 0;
  },
  /** Every Client ID typed on the Clients board and the Client Master mirror (raw text) — for seeding a missing file and for a block. */
  async boardValues(cols) {
    const out = await columnTexts(cols.clientsBoardId, cols.clientsCol);
    if (cols.cmBoardId && cols.cmCol) out.push(...await columnTexts(cols.cmBoardId, cols.cmCol));
    return out;
  },
  /** The probe's scratch file (never the counter): the same two write conditions. */
  scratchWrite: (file, data, opts = {}) => require('./oneDriveService').writeJsonFile(file, data, { etag: opts.etag || '' }),
  scratchRead: (file) => require('./oneDriveService').readJsonFile(file),
  now: () => Date.now(),
};

/* ───────────────────────────── one at a time in this process ───────────────────────────── */
let _lockTail = Promise.resolve();
/** Run `fn` with no other Client ID allocation of THIS module in progress (its own lock — never the case-number one). */
function withClientIdLock(fn) {
  const run = _lockTail.then(() => fn());
  _lockTail = run.catch(() => {});
  return run;
}

const refusal = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });

/** The configured columns, or null when the Clients "Client ID" column is not set up yet. */
function configured() {
  const cols = io.columns() || {};
  return cols.clientsBoardId && cols.clientsCol ? cols : null;
}

/**
 * Read the counter. { state: 'ok', last, etag } | { state: 'missing' } |
 * { state: 'corrupt', etag, raw } | { state: 'unavailable', error }.
 * `last` must be a whole number ≥ 0 — anything else is damage.
 */
async function readState() {
  let r;
  try { r = await io.readCounter(); }
  catch (err) {
    if (err && err.corrupt) return { state: 'corrupt', etag: err.etag || '', raw: String(err.raw == null ? '' : err.raw) };
    return { state: 'unavailable', error: (err && err.message) || String(err) };
  }
  if (!r) return { state: 'missing' };
  const last = r.data ? r.data.last : undefined;
  if (!Number.isSafeInteger(last) || last < 0) return { state: 'corrupt', etag: r.etag || '', raw: JSON.stringify(r.data) };
  return { state: 'ok', last, etag: r.etag || '', backfill: lockOf(r.data) };
}

/** The backfill lock in the counter's data: { by, at } or null. Anything truthy that is not an object still counts as locked. */
function lockOf(data) {
  const b = data && data.backfill;
  if (!b) return null;
  return typeof b === 'object' ? { by: s(b.by), at: s(b.at) } : { by: '', at: s(b) };
}

/** The highest counter number among these values (anything parseable as a Client ID). */
function highestNumber(values) {
  let max = 0;
  for (const v of values || []) { const n = clientIdNumber(v); if (n > max) max = n; }
  return max;
}

/**
 * The state to build on: an existing counter, or — when there is no file —
 * the board's highest number (the file is then created, create-only).
 */
async function baseState(cols) {
  const st = await readState();
  if (st.state === 'ok') return st;
  if (st.state === 'corrupt') return refusal('corrupt', 'The Client ID counter file is damaged — no number was given. An admin can repair it (a copy is kept).');
  if (st.state === 'unavailable') return refusal('unavailable', `The Client ID counter could not be read (${st.error}) — no number was given; it is tried again later.`);
  let values;
  try { values = await io.boardValues(cols); }
  catch (err) { return refusal('unavailable', `The Client ID counter file is missing and the boards could not be read to start it (${err.message}) — no number was given.`); }
  return { state: 'ok', last: highestNumber(values), etag: '', seeded: true };
}

/**
 * Take the next number. Labels it with `year` (the Toronto year the person
 * first came; now when left out).
 * @param {{ year?: number }} [opts]
 * @returns {Promise<{ ok: true, id: string, n: number, year: number, skipped: number[], seeded: boolean, tries: number }
 *                  | { ok: false, reason: 'not-configured'|'bad-year'|'corrupt'|'unavailable'|'busy'|'no-free', message: string }>}
 */
function allocate({ year } = {}) {
  return withClientIdLock(async () => {
    const cols = configured();
    if (!cols) return refusal('not-configured', 'The Client ID column is not set up yet — no number was given.');
    const y = year == null ? torontoYear(io.now()) : Number(year);
    if (!formatClientId(y, 1)) return refusal('bad-year', `"${year}" is not a year — no number was given.`);
    const skipped = [];
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      const base = await baseState(cols);
      if (base.ok === false) return base;
      if (base.backfill) return refusal('backfill', `The Client ID backfill is running (since ${base.backfill.at || 'a while'}) — no number was given now; the hourly check gives it once the backfill is done.`);
      // Skip any number already typed on the board (burn it — never reuse).
      let n = base.last + 1;
      let free = false;
      for (let i = 0; i < MAX_SKIPS; i++) {
        let taken;
        try { taken = await io.numberTaken(n, cols); }
        catch (err) { return refusal('unavailable', `The Clients board could not be checked (${err.message}) — no number was given.`); }
        if (!taken) { free = true; break; }
        if (!skipped.includes(n)) skipped.push(n);
        n++;
      }
      if (!free) return refusal('no-free', `${MAX_SKIPS} numbers in a row after ${base.last} are already typed on the Clients board — no number was given. Check the board.`);
      try {
        await io.writeCounter({ last: n, updatedAt: new Date(io.now()).toISOString() }, base.etag);
      } catch (err) {
        if (err && err.conflict) continue;   // another instance took one meanwhile: read again
        return refusal('unavailable', `The Client ID counter could not be saved (${err.message}) — no number was given.`);
      }
      if (skipped.length) console.warn(`[ClientId] Skipped ${skipped.join(', ')} — already typed on the Clients board`);
      if (base.seeded) console.log(`[ClientId] Counter file created from the boards (highest found: ${base.last})`);
      return { ok: true, id: formatClientId(y, n), n, year: y, skipped, seeded: !!base.seeded, tries };
    }
    return refusal('busy', `The Client ID counter kept changing (${MAX_TRIES} tries) — no number was given; it is tried again later.`);
  });
}

/**
 * Reserve K numbers in ONE write — for the backfill. The block is contiguous
 * and starts above every number already typed on the boards inside it (those
 * are burnt). Returns the first and last number; the caller labels each with
 * that person's own year.
 * @returns {Promise<{ ok: true, first: number, last: number, count: number, burnt: number, seeded: boolean, tries: number } | { ok: false, reason, message }>}
 */
function allocateBlock(K) {
  return withClientIdLock(async () => {
    const cols = configured();
    if (!cols) return refusal('not-configured', 'The Client ID column is not set up yet — nothing was reserved.');
    const k = Number(K);
    if (!Number.isInteger(k) || k < 1 || k > MAX_BLOCK) return refusal('bad-count', `A block is 1 to ${MAX_BLOCK} numbers ("${K}" given) — nothing was reserved.`);
    let used;
    try { used = new Set((await io.boardValues(cols)).map(clientIdNumber).filter((n) => n > 0)); }
    catch (err) { return refusal('unavailable', `The boards could not be read (${err.message}) — nothing was reserved.`); }
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      const st = await readState();
      if (st.state === 'corrupt') return refusal('corrupt', 'The Client ID counter file is damaged — nothing was reserved. An admin can repair it.');
      if (st.state === 'unavailable') return refusal('unavailable', `The Client ID counter could not be read (${st.error}) — nothing was reserved.`);
      const seeded = st.state === 'missing';
      const last = seeded ? Math.max(0, ...used) : st.last;
      let first = last + 1;
      for (let guard = 0; guard < used.size + 1; guard++) {
        let hit = 0;
        for (const u of used) if (u >= first && u <= first + k - 1 && u > hit) hit = u;
        if (!hit) break;
        first = hit + 1;
      }
      const end = first + k - 1;
      try { await io.writeCounter({ last: end, updatedAt: new Date(io.now()).toISOString(), ...(st.backfill ? { backfill: st.backfill } : {}) }, seeded ? '' : st.etag); }
      catch (err) {
        if (err && err.conflict) continue;
        return refusal('unavailable', `The Client ID counter could not be saved (${err.message}) — nothing was reserved.`);
      }
      console.log(`[ClientId] Reserved ${first}–${end} (${k})${first > last + 1 ? `, burnt ${first - last - 1} already typed on the boards` : ''}`);
      return { ok: true, first, last: end, count: k, burnt: first - last - 1, seeded, tries };
    }
    return refusal('busy', `The Client ID counter kept changing (${MAX_TRIES} tries) — nothing was reserved.`);
  });
}

/**
 * The backfill apply: put the lock in the counter file (or keep it, when it is there
 * already — a resumed apply). A missing file is created, create-only, from the boards'
 * highest number. A damaged or unreadable counter is refused — the apply then stops.
 * @returns {Promise<{ ok: true, already: boolean, last: number } | { ok: false, reason, message }>}
 */
function setBackfillLock({ by = '' } = {}) {
  return withClientIdLock(async () => {
    const cols = configured();
    if (!cols) return refusal('not-configured', 'The Client ID column is not set up yet.');
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      const st = await readState();
      if (st.state === 'corrupt') return refusal('corrupt', 'The Client ID counter file is damaged — the backfill cannot lock it.');
      if (st.state === 'unavailable') return refusal('unavailable', `The Client ID counter could not be read (${st.error}).`);
      if (st.state === 'ok' && st.backfill) return { ok: true, already: true, last: st.last, lock: st.backfill };
      let last = st.state === 'ok' ? st.last : 0;
      if (st.state === 'missing') {
        try { last = highestNumber(await io.boardValues(cols)); }
        catch (err) { return refusal('unavailable', `The boards could not be read (${err.message}).`); }
      }
      const lock = { by: s(by), at: new Date(io.now()).toISOString() };
      try { await io.writeCounter({ last, updatedAt: lock.at, backfill: lock }, st.state === 'ok' ? st.etag : ''); }
      catch (err) {
        if (err && err.conflict) continue;
        return refusal('unavailable', `The Client ID counter could not be saved (${err.message}).`);
      }
      console.log(`[ClientId] Backfill lock set by ${lock.by || 'the backfill'} — live numbers wait until it is cleared`);
      return { ok: true, already: false, last, lock };
    }
    return refusal('busy', `The Client ID counter kept changing (${MAX_TRIES} tries).`);
  });
}

/** The backfill apply's end (or `--unlock`): take the lock out of the counter file. Nothing to do = ok. */
function clearBackfillLock() {
  return withClientIdLock(async () => {
    const cols = configured();
    if (!cols) return refusal('not-configured', 'The Client ID column is not set up yet.');
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      const st = await readState();
      if (st.state === 'missing') return { ok: true, cleared: false };
      if (st.state !== 'ok') return refusal(st.state, `The Client ID counter could not be read (${st.error || st.state}) — the lock is still there; run --unlock again.`);
      if (!st.backfill) return { ok: true, cleared: false };
      try { await io.writeCounter({ last: st.last, updatedAt: new Date(io.now()).toISOString() }, st.etag); }
      catch (err) {
        if (err && err.conflict) continue;
        return refusal('unavailable', `The Client ID counter could not be saved (${err.message}) — the lock is still there; run --unlock again.`);
      }
      console.log('[ClientId] Backfill lock cleared — live numbers are given again');
      return { ok: true, cleared: true };
    }
    return refusal('busy', `The Client ID counter kept changing (${MAX_TRIES} tries) — the lock is still there; run --unlock again.`);
  });
}

/** PURE — the highest "last" number still readable in a damaged file's text. */
function salvageLast(raw) {
  let max = 0;
  const re = /"last"\s*:\s*"?(\d{1,9})\b/g;
  let m;
  while ((m = re.exec(String(raw || '')))) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  return max;
}

/**
 * Admin: rebuild a damaged counter file — UPWARD only. Keeps a copy of the bad
 * file, then writes last = the highest of what is readable in it and every
 * number on the boards, over that damaged version only (If-Match).
 * Does nothing when the file is fine or missing.
 */
function repairCounter() {
  return withClientIdLock(async () => {
    const cols = configured();
    if (!cols) return refusal('not-configured', 'The Client ID column is not set up yet.');
    const st = await readState();
    if (st.state === 'ok') return { ok: true, repaired: false, last: st.last, message: 'The counter file is fine — nothing to repair.' };
    if (st.state === 'missing') return { ok: true, repaired: false, message: 'There is no counter file yet — the first number creates it.' };
    if (st.state === 'unavailable') return refusal('unavailable', `The counter could not be read (${st.error}).`);
    let values;
    try { values = await io.boardValues(cols); }
    catch (err) { return refusal('unavailable', `The boards could not be read (${err.message}) — nothing was changed.`); }
    const fromFile = salvageLast(st.raw), fromBoards = highestNumber(values);
    const last = Math.max(fromFile, fromBoards);
    try {
      await io.writeBackup(st.raw, stamp(io.now()));
      await io.writeCounter({ last, updatedAt: new Date(io.now()).toISOString(), repairedFrom: { file: fromFile, boards: fromBoards } }, st.etag);
    } catch (err) {
      return refusal(err && err.conflict ? 'busy' : 'unavailable', `The counter was not repaired (${err.message}).`);
    }
    console.log(`[ClientId] Damaged counter file rebuilt: last ${last} (file ${fromFile}, boards ${fromBoards}); a copy is kept`);
    return { ok: true, repaired: true, last, fromFile, fromBoards };
  });
}

/**
 * READ-ONLY: the counter as it is now — { state: 'ok', last } | { state: 'missing' } |
 * { state: 'corrupt' } | { state: 'unavailable', error }. Never writes, never seeds.
 */
async function peekCounter() {
  const st = await readState();
  if (st.state === 'ok') return { state: 'ok', last: st.last, ...(st.backfill ? { backfill: st.backfill } : {}) };
  if (st.state === 'unavailable') return { state: 'unavailable', error: st.error };
  return { state: st.state };
}

/**
 * Prove on production that OneDrive honours the two write conditions the counter
 * relies on (create-only; only over the version read) — on a SCRATCH file beside
 * the counter, never the counter itself (the case-number probe's steps). The
 * counter is only read. For /admin/client-ids/probe-record.
 */
async function probeCounterWrites() {
  const counter = await peekCounter().catch((err) => ({ state: 'unavailable', error: err.message }));
  const file = COUNTER_PATH.replace(/\.json$/, `.probe-${stamp(io.now())}.json`);
  const steps = [];
  const step = async (name, expected, fn) => {
    let got;
    try { const r = await fn(); got = r === undefined ? 'ok' : r; } catch (err) { got = err && err.conflict ? 'conflict' : `error: ${err && err.message}`; }
    steps.push({ step: name, expected, got: String(got), ok: String(got).startsWith(expected) });
  };
  await step('create a new file', 'created', async () => ((await io.scratchWrite(file, { probe: 1 })).created ? 'created' : 'written-but-not-201'));
  await step('create it again (must be refused)', 'conflict', async () => { await io.scratchWrite(file, { probe: 2 }); return 'overwritten'; });
  const cur = await io.scratchRead(file).catch(() => null);
  await step('write over the current version', 'ok', async () => { await io.scratchWrite(file, { probe: 3 }, { etag: cur ? cur.etag : 'missing' }); });
  await step('write over the OLD version (must be refused)', 'conflict', async () => { await io.scratchWrite(file, { probe: 4 }, { etag: cur ? cur.etag : 'missing' }); return 'overwritten'; });
  const end = await io.scratchRead(file).catch((e) => ({ data: { error: e.message } }));
  steps.push({ step: 'the file holds the last good write', expected: '3', got: String(end && end.data && end.data.probe), ok: !!(end && end.data && end.data.probe === 3) });
  return { ok: steps.every((x) => x.ok), counter, file, steps };
}

function _resetForTests() { _lockTail = Promise.resolve(); }

module.exports = {
  allocate, allocateBlock, repairCounter, withClientIdLock, peekCounter, probeCounterWrites,
  setBackfillLock, clearBackfillLock, lockOf,
  formatClientId, parseClientId, torontoYear,
  salvageLast, highestNumber, readColumns, columnTexts,
  io, COUNTER_PATH, MAX_TRIES, MAX_SKIPS, MAX_BLOCK, _resetForTests,
};
