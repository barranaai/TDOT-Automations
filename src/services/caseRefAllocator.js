'use strict';

/**
 * Case numbers are never handed out twice (Faran, 2026-10-01 — root cause of
 * the test-folder collisions found 2026-09-30).
 *
 * The old rule was "highest number on the Cases board + 1". A deleted or
 * archived row frees its number, but what the case left behind stays: its
 * OneDrive folder ("<name> - 2026-VV-008"), its document / questionnaire /
 * family rows. The next client of that type then got the same number, and the
 * app — which finds a case's folder by the number at the end of its name —
 * filed the new client's documents into the old (test) folder.
 *
 * Now the next number is one above the highest found in ANY of:
 *   - the Cases board (as before);
 *   - every folder name under "Client Documents" — "<name> - <ref>", and the
 *     renamed "ZZ-TEST … (was <ref>)" ones — so a leftover folder holds its
 *     number for good;
 *   - numbers this process handed out (a board read can lag a write by seconds);
 *   - the high-water mark: the highest number ever handed out per prefix,
 *     saved in OneDrive outside "Client Documents" — so a number freed by a
 *     careful delete (nothing of the case left to find) is never reissued,
 *     and a restart forgets nothing;
 * and the candidate is then checked against the Documents, Questionnaire and
 * Family Members boards (and the Cases board, by search): if any row already
 * carries it, the next one is tried.
 *
 * One allocation at a time (withAllocationLock): two cases typed at the same
 * moment cannot both get the same number from this process.
 *
 * If OneDrive cannot be listed, the last successful listing of this process is
 * used; if there is none, the number is still assigned (a blank number would
 * stall onboarding) and the result says so — the caller tells staff.
 */

const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');
const familyBoard = require('../data/familyMembersBoard.json');

const CM_REF_COL   = 'text_mm142s49';
const EXEC_BOARD   = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const EXEC_REF_COL = 'text_mm0z2cck';
const Q_BOARD      = process.env.MONDAY_QUESTIONNAIRE_EXECUTION_BOARD_ID || '18402117488';
const Q_REF_COL    = 'text_mm12dgy9';
const FAMILY_BOARD = familyBoard.boardId;
const FAMILY_REF_COL = familyBoard.columns.caseReference;

const FOLDER_SCAN_TTL_MS = 60 * 1000;   // a burst of new cases shares one root listing
// The highest number ever handed out per prefix, kept in OneDrive OUTSIDE
// "Client Documents" (so no case listing ever sees it). It survives restarts
// and a careful delete: a deleted case's number stays used even though
// nothing of the case is left to find — so restoring it from the recycle
// bins can never collide with a new client.
const MARK_PATH = 'TDOT System/case-number-high-water.json';
const MAX_PROBES     = 25;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** PURE — the highest number after `prefix` ("2026-VV-") in these strings; a ref must not be glued to other letters/digits. */
function maxSeq(strings, prefix) {
  const re = new RegExp(`(?:^|[^A-Za-z0-9-])${esc(prefix)}(\\d{1,6})(?!\\d)`, 'g');
  let max = 0;
  for (const s of strings || []) {
    const str = String(s || '');
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(str))) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  }
  return max;
}

/* ───────────────────────────── I/O seam ───────────────────────────── */
const io = {
  async boardRefs() {
    const all = []; let cursor = null;
    do {
      const d = cursor
        ? await mondayApi.query(`query($c:String!){ boards(ids:["${clientMasterBoardId}"]){ items_page(limit:200, cursor:$c){ cursor items{ column_values(ids:["${CM_REF_COL}"]){ text } } } } }`, { c: cursor })
        : await mondayApi.query(`{ boards(ids:["${clientMasterBoardId}"]){ items_page(limit:200){ cursor items{ column_values(ids:["${CM_REF_COL}"]){ text } } } } }`);
      const page = d.boards[0].items_page;
      for (const it of page.items) { const t = ((it.column_values || [])[0] || {}).text; if (t && t.trim()) all.push(t.trim()); }
      cursor = page.cursor || null;
    } while (cursor);
    return all;
  },
  rootFolderNames: async () => (await require('./oneDriveService').listCaseFoldersInRoot()).map((f) => f.name),
  readMark: () => require('./oneDriveService').readJsonFile(MARK_PATH),
  writeMark: (data, etag) => require('./oneDriveService').writeJsonFile(MARK_PATH, data, { etag }),
  writeBackup: (raw, stamp) => require('./oneDriveService').writeJsonFile(MARK_PATH.replace(/\.json$/, `.corrupt-${stamp}.json`), { raw }),
  /** Boards whose rows carry a case reference: is this one taken anywhere? */
  async refInUse(ref) {
    const probe = async (board, col) => {
      const d = await mondayApi.query(
        `query($b:ID!,$v:String!){ items_page_by_column_values(limit:1, board_id:$b, columns:[{column_id:"${col}", column_values:[$v]}]){ items{ id } } }`,
        { b: String(board), v: ref });
      return ((d.items_page_by_column_values || {}).items || []).length > 0;
    };
    const hits = await Promise.all([[clientMasterBoardId, CM_REF_COL], [EXEC_BOARD, EXEC_REF_COL], [Q_BOARD, Q_REF_COL], [FAMILY_BOARD, FAMILY_REF_COL]]
      .map(([b, c]) => probe(b, c)));
    return hits.some(Boolean);
  },
  now: () => Date.now(),
};

/* ───────────────────────────── state ───────────────────────────── */
const _recent = new Set();          // numbers this process handed out (kept for the life of the process: tiny)
let _markCache = null;              // { data } — the last high-water mark read, for when OneDrive is down
let _folderScan = null;             // { at, names } — the last successful root listing
let _lockTail = Promise.resolve();

/** Run `fn` with no other allocation in progress in this process. */
function withAllocationLock(fn) {
  const run = _lockTail.then(() => fn());
  _lockTail = run.catch(() => {});
  return run;
}

/** Remember a number this process just handed out (the board read may not show it for a few seconds). */
function noteAssigned(ref) { _recent.add(String(ref)); }

/**
 * The high-water marks ({ "2026-VV-": 12, … }). One retry. When it still
 * fails: the last one read ("stale"), else {} ("unavailable"). A file that is
 * not valid JSON is "corrupt" (its eTag and text come back so it can be
 * repaired). `exists`/`etag` say what is on disk, for seeding.
 */
async function readMarks() {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await io.readMark();
      if (!r && _markCache) {
        // The file is gone (deleted or moved by hand) but this process read it
        // before: what it held is not lost — the seed writes it back.
        console.error(`[CaseRef] The case-number high-water file is missing — it will be recreated from what this process knows`);
        return { marks: _markCache.data, markCheck: 'missing', exists: false, etag: '' };
      }
      const data = r ? r.data : {};   // readJsonFile only answers JSON objects (anything else is "corrupt")
      _markCache = { data };
      return { marks: data, markCheck: 'ok', exists: !!r, etag: r ? r.etag : '' };
    } catch (err) {
      if (err.corrupt) {
        console.error(`[CaseRef] The case-number high-water file is damaged (not a JSON object) — it will be rebuilt (a copy of it is kept)`);
        // the numbers still readable in it count NOW (a rebuild must never lower a mark)
        return { marks: mergeMax(salvageMarks(err.raw), _markCache ? _markCache.data : {}), markCheck: 'corrupt', exists: true, etag: err.etag || '', raw: err.raw || '' };
      }
      lastErr = err;
    }
  }
  if (_markCache) return { marks: _markCache.data, markCheck: 'stale' };
  console.error(`[CaseRef] The case-number high-water file could not be read (${lastErr && lastErr.message})`);
  return { marks: {}, markCheck: 'unavailable' };
}

/** PURE — the marks that can still be read out of a damaged file's text ("2026-VV-": 12 pairs), so a rebuild never loses one. */
function salvageMarks(raw) {
  const out = {};
  const re = /"(\d{4}-[A-Z]+(?:-[A-Z]+)*-)"\s*:\s*"?(\d{1,6})\b/g;
  let m;
  while ((m = re.exec(String(raw || '')))) { const n = parseInt(m[2], 10); if (n > (out[m[1]] || 0)) out[m[1]] = n; }
  return out;
}
const mergeMax = (...objs) => {
  const out = {};
  for (const o of objs) for (const [k, v] of Object.entries(o || {})) { const n = Number(v); if (/^\d{4}-[A-Z]+(?:-[A-Z]+)*-$/.test(k) && Number.isFinite(n) && n > (out[k] || 0)) out[k] = Math.floor(n); }
  return out;
};

/**
 * Rebuild a damaged file: keep a copy of it, then write back every number that
 * can still be read out of it, merged (max) with what this process knows and
 * `extra` — overwriting only that damaged version (If-Match on its eTag).
 */
async function repairCorrupt(corrupt, extra = {}) {
  const data = mergeMax(salvageMarks(corrupt.raw), _markCache ? _markCache.data : {}, extra);
  await io.writeBackup(corrupt.raw, new Date(io.now()).toISOString().replace(/[:.]/g, '-'));
  data.updatedAt = new Date(io.now()).toISOString();
  await io.writeMark(data, corrupt.etag || '');
  _markCache = { data };
  console.log(`[CaseRef] The damaged case-number record was rebuilt (a copy of it is kept) — ${Object.keys(data).length - 1} prefix(es)`);
  return data;
}

/** Every "<year>-<LETTERS>-" prefix that appears with digits in these strings. */
function prefixesIn(strings) {
  const out = new Set();
  const PREF = /(?:^|[^A-Za-z0-9-])(\d{4}-[A-Z]+(?:-[A-Z]+)*-)\d{1,6}(?!\d)/g;
  for (const s of strings || []) { PREF.lastIndex = 0; let m; while ((m = PREF.exec(String(s)))) out.add(m[1]); }
  return out;
}

/**
 * Bring the file up to what exists NOW (board and folder maximums for every
 * prefix), so a number given out BEFORE the file existed is protected too —
 * and rebuild it when it is corrupt (a copy of the bad file is kept beside it).
 * Best effort: a failure here never stops an allocation.
 */
async function seedMarks(refs, names, marks) {
  if (!['ok', 'corrupt', 'missing'].includes(marks.markCheck)) return;
  const base = { ...marks.marks };
  let raised = 0;
  for (const p of prefixesIn([...refs, ...names])) {
    const v = Math.max(maxSeq(refs, p), maxSeq(names, p));
    if (v > (Number(base[p]) || 0)) { base[p] = v; raised++; }
  }
  if (!raised && marks.exists && marks.markCheck === 'ok') return;
  try {
    if (marks.markCheck === 'corrupt') {
      await repairCorrupt({ raw: marks.raw, etag: marks.etag }, base);
      return;
    }
    base.updatedAt = new Date(io.now()).toISOString();
    await io.writeMark(base, marks.exists ? marks.etag : '');
    _markCache = { data: base };
    console.log(`[CaseRef] High-water file ${marks.markCheck === 'missing' ? 'recreated' : (marks.exists ? 'brought up to date' : 'created')} (${raised} prefix(es) raised)`);
  } catch (err) {
    console.warn(`[CaseRef] Could not ${marks.markCheck === 'corrupt' ? 'rebuild' : 'seed'} the high-water file: ${err.message}`);
  }
}

/**
 * After a number is WRITTEN: raise its prefix's high-water mark (never lower
 * it). Read-modify-write with the file's eTag; a concurrent change makes it
 * re-read and try again. Best effort — the number is assigned either way, and
 * this process's memory still holds it; returns false when the mark could not
 * be saved (the caller logs it).
 */
async function recordAssigned(ref) {
  noteAssigned(ref);
  const m = /^(\d{4}-[A-Z]+(?:-[A-Z]+)*-)(\d+)$/.exec(String(ref));
  if (!m) return false;
  const [, prefix, digits] = m;
  const seq = parseInt(digits, 10);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const cur = await io.readMark();
      // No file (deleted by hand?): start from everything this process knows —
      // a re-created record must never hold less than the one it replaces.
      const data = cur ? { ...cur.data } : mergeMax(_markCache ? _markCache.data : {});
      if ((Number(data[prefix]) || 0) >= seq) { _markCache = { data: mergeMax(_markCache ? _markCache.data : {}, data) }; return true; }
      data[prefix] = seq;
      data.updatedAt = new Date(io.now()).toISOString();
      await io.writeMark(data, cur ? cur.etag : '');
      _markCache = { data: mergeMax(_markCache ? _markCache.data : {}, data) };   // never shrink what this process knows
      return true;
    } catch (err) {
      if (err.conflict) continue;   // someone else wrote it meanwhile: read again
      if (err.corrupt) {            // a damaged file: rebuild it (keeping every readable number) with this number in it
        try { await repairCorrupt({ raw: err.raw, etag: err.etag }, { [prefix]: seq }); return true; }
        catch (e2) { if (e2.conflict) continue; console.error(`[CaseRef] Could not rebuild the damaged high-water file for ${ref}: ${e2.message}`); return false; }
      }
      console.error(`[CaseRef] Could not save the high-water mark for ${ref}: ${err.message}`);
      return false;
    }
  }
  console.error(`[CaseRef] Could not save the high-water mark for ${ref}: it kept changing`);
  return false;
}

async function folderNames() {
  const fresh = _folderScan && io.now() - _folderScan.at < FOLDER_SCAN_TTL_MS;
  if (fresh) return { names: _folderScan.names, folderCheck: 'ok' };
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const names = await io.rootFolderNames();
      _folderScan = { at: io.now(), names };
      return { names, folderCheck: 'ok' };
    } catch (err) { lastErr = err; }
  }
  if (_folderScan) {
    console.warn(`[CaseRef] OneDrive could not be listed (${lastErr && lastErr.message}) — using the listing from ${Math.round((io.now() - _folderScan.at) / 60000)} min ago`);
    return { names: _folderScan.names, folderCheck: 'stale' };
  }
  console.error(`[CaseRef] OneDrive could not be listed (${lastErr && lastErr.message}) and there is no earlier listing — the number is checked against Monday only`);
  return { names: [], folderCheck: 'unavailable', folderError: lastErr ? lastErr.message : '' };
}

/**
 * The next free number for a prefix ("2026-VV-"). Call inside withAllocationLock.
 * @returns {Promise<{ ref: string, seq: number, from: { board: number, folders: number, recent: number, mark: number }, skipped: string[], folderCheck: 'ok'|'stale'|'unavailable', markCheck: 'ok'|'stale'|'unavailable', folderError?: string }>}
 */
async function allocate(prefix) {
  if (!/^\d{4}-[A-Z]+(?:-[A-Z]+)*-$/.test(prefix)) throw new Error(`allocate: bad prefix "${prefix}"`);
  const [refs, folders, marks] = await Promise.all([io.boardRefs(), folderNames(), readMarks()]);
  await seedMarks(refs, folders.names, marks);
  const from = {
    board:   maxSeq(refs, prefix),
    folders: maxSeq(folders.names, prefix),
    recent:  maxSeq([..._recent], prefix),
    mark:    Number(marks.marks[prefix]) || 0,
  };
  let seq = Math.max(from.board, from.folders, from.recent, from.mark) + 1;
  const skipped = [];
  for (let i = 0; i < MAX_PROBES; i++) {
    const ref = `${prefix}${String(seq).padStart(3, '0')}`;
    if (!(await io.refInUse(ref))) {
      return { ref, seq, from, skipped, folderCheck: folders.folderCheck, markCheck: marks.markCheck, ...(folders.folderError ? { folderError: folders.folderError } : {}) };
    }
    skipped.push(ref);
    seq++;
  }
  throw new Error(`no free case number found after ${MAX_PROBES} tries above ${prefix}${from.board} — every one is already used on a board`);
}

/**
 * Prove — on a scratch file beside the record, never the record itself — that
 * OneDrive honours the two conditions the record relies on: create-only and
 * "only over this version". Admin-triggered (POST /admin/case-refs/probe-record).
 * Leaves the small scratch file behind (nothing is ever deleted).
 * @returns {Promise<{ ok: boolean, steps: Array<{ step: string, expected: string, got: string, ok: boolean }> }>}
 */
async function probeRecordWrites() {
  const od = require('./oneDriveService');
  const path = MARK_PATH.replace(/\.json$/, `.probe-${new Date(io.now()).toISOString().replace(/[:.]/g, '-')}.json`);
  const steps = [];
  const step = async (name, expected, fn) => {
    let got;
    try { const r = await fn(); got = r === undefined ? 'ok' : r; } catch (err) { got = err.conflict ? 'conflict' : `error: ${err.message}`; }
    steps.push({ step: name, expected, got: String(typeof got === 'object' ? JSON.stringify(got) : got), ok: String(got).startsWith(expected) });
    return got;
  };
  await step('create a new file', 'created', async () => ((await od.writeJsonFile(path, { probe: 1 })).created ? 'created' : 'written-but-not-201'));
  await step('create it again (must be refused)', 'conflict', async () => { await od.writeJsonFile(path, { probe: 2 }); return 'overwritten'; });
  const cur = await od.readJsonFile(path).catch(() => null);
  await step('write over the current version', 'ok', async () => { await od.writeJsonFile(path, { probe: 3 }, { etag: cur ? cur.etag : 'missing' }); });
  await step('write over the OLD version (must be refused)', 'conflict', async () => { await od.writeJsonFile(path, { probe: 4 }, { etag: cur ? cur.etag : 'missing' }); return 'overwritten'; });
  const end = await od.readJsonFile(path).catch((e) => ({ data: { error: e.message } }));
  steps.push({ step: 'the file holds the last good write', expected: '3', got: String(end && end.data && end.data.probe), ok: !!(end && end.data && end.data.probe === 3) });
  return { ok: steps.every((x) => x.ok), file: path, steps };
}

/** Read-only report for the admin audit page: per prefix, where the next number would come from. */
async function audit() {
  const [refs, folders, marks] = await Promise.all([io.boardRefs(), folderNames(), readMarks()]);
  const prefixes = new Set([...Object.keys(marks.marks).filter((k) => /^\d{4}-[A-Z]+(?:-[A-Z]+)*-$/.test(k)), ...prefixesIn([...refs, ...folders.names])]);
  const counts = new Map();
  for (const r of refs) counts.set(r, (counts.get(r) || 0) + 1);
  const rows = [...prefixes].sort().map((p) => {
    const board = maxSeq(refs, p), fold = maxSeq(folders.names, p), mark = Number(marks.marks[p]) || 0;
    return { prefix: p, boardMax: board, folderMax: fold, highWater: mark, nextOldRule: `${p}${String(board + 1).padStart(3, '0')}`,
      nextNewRule: `${p}${String(Math.max(board, fold, mark) + 1).padStart(3, '0')}`, wouldHaveReused: Math.max(fold, mark) > board };
  });
  return {
    folderCheck: folders.folderCheck, markCheck: marks.markCheck,
    prefixes: rows,
    wouldHaveReused: rows.filter((r) => r.wouldHaveReused).map((r) => `${r.prefix}: board ${r.boardMax}, folders ${r.folderMax}, high-water ${r.highWater} → old rule ${r.nextOldRule}, now ${r.nextNewRule}`),
    duplicateRefsOnBoard: [...counts].filter(([, n]) => n > 1).map(([r, n]) => ({ ref: r, rows: n })),
  };
}

function _resetForTests() { _recent.clear(); _folderScan = null; _markCache = null; _lockTail = Promise.resolve(); }

module.exports = { allocate, withAllocationLock, noteAssigned, recordAssigned, audit, probeRecordWrites, maxSeq, salvageMarks, io, MARK_PATH, _resetForTests };
