'use strict';

/**
 * The Client ID backfill on the SERVER — the background runs behind the admin page
 * /admin/client-ids/backfill (Faran 2026-11-25: the laptop has no Microsoft keys, on
 * purpose, so the apply runs where they are). The apply itself is clientIdBackfillRun.js,
 * the very code the script runs.
 *
 * Render's disk is wiped on every deploy and restart, so EVERYTHING the run needs to go on
 * lives on OneDrive, under "TDOT System/client-id-backfill/" (never "Client Documents"):
 *   answered-<stamp>-<tag>.xlsx         each uploaded answered check list, as it came
 *   current.json                        { run, sheet, by, createdAt, updatedAt } — the run in hand
 *   checkpoint-<run>.json               the run's checkpoint (what is done, the numbers reserved
 *                                       and given, the lock it set, its status and heartbeat)
 *   apply-log-<run>-<session>-NNN.jsonl the rollback list, one JSON line per record made and per
 *                                       cell written; a new file every 200 lines and per session
 * Every checkpoint write is over the version this run last wrote (If-Match): when another copy
 * of the server (a deploy overlaps the old and the new one) took the run over, the write is
 * refused, this run stops at once and leaves the lock to the other one.
 *
 * Resume after a restart: current.json names the run and its sheet; the checkpoint says what is
 * done; the lock it set in the counter file is recognised as its own (the same `at`). Press
 * Resume: the boards are read again, the plan built again from the same answered sheet, and
 * what is done is skipped. A checkpoint still 'running' but not saved for 5 minutes = the run
 * was cut off (a restart). One run at a time in this process; the counter-file lock is the
 * guard across copies of the server.
 *
 * Never in the server log: names, emails, phones (counts and keys only). The staff-facing
 * lines (with names — the admin page shows the names staff already see in the app) stay in the
 * job for the page. A Clients record's Monday id is never shown on the page: an "A<id>" sheet
 * key is shown as "A·····" next to the person's name.
 */

const crypto = require('crypto');
const backfill = require('./clientIdBackfillRun');

const FOLDER = 'TDOT System/client-id-backfill';
const POINTER = `${FOLDER}/current.json`;
const SHEET_RE = /^answered-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{4}\.xlsx$/;
const MAX_SHEET_BYTES = 5 * 1024 * 1024;
const LOG_PART = 200;
const LINES_KEPT = 300;
const SKIPPED_SHOWN = 300;
const PAUSE_MS = 300;        // between Monday writes (the script uses 150; the server is in no hurry)
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const UNLOCK_WORD = 'UNLOCK';

const s = (v) => String(v == null ? '' : v).trim();
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');
const tag = () => crypto.randomBytes(2).toString('hex');   // two uploads (or sessions) in the same millisecond never share a file

/* ───────────────────────────── seams (tests replace these) ───────────────────────────── */
const deps = {
  /** readJsonFile, writeJsonFile, readSystemFile, writeSystemFile */
  drive: () => require('./oneDriveService'),
  /** The Monday I/O + the two lock calls. */
  io: () => {
    const allocator = require('./clientIdAllocator');
    return {
      ...backfill.mondayIo({ pauseMs: PAUSE_MS }),
      lockCounter: (by) => allocator.setBackfillLock({ by }),
      unlockCounter: () => allocator.clearBackfillLock(),
    };
  },
  xlsx: () => require('xlsx'),
  now: () => Date.now(),
  log: (...a) => console.log(...a),
  pauseMs: PAUSE_MS,
};

/* ───────────────────────────── never a Clients record id on the page ───────────────────────────── */

/** "A12345678" (a sheet key = a Clients row's Monday id) → "A·····"; every other key as it is. */
function maskKey(k) { return /^A\d+$/.test(s(k)) ? 'A·····' : s(k); }
function maskText(t) { return String(t == null ? '' : t).replace(/\bA\d{3,}\b/g, 'A·····'); }
const maskItems = (items) => (items || []).map((i) => ({ key: maskKey(i.key), name: s(i.name), why: maskText(i.why) }));

/* ───────────────────────────── the OneDrive store ───────────────────────────── */

/**
 * The checkpoint and the apply log of one run, on OneDrive. A log write that fails is healed by
 * the next one (each write is the whole file part); three failures in a row stop the run.
 */
function driveStore(drive, run, session) {
  const cpPath = `${FOLDER}/checkpoint-${run}.json`;
  let etag = '';
  let loaded = false;
  let part = 0, lines = [], partEtag = '', fails = 0;
  const partPath = () => `${FOLDER}/apply-log-${run}-${session}-${String(part).padStart(3, '0')}.jsonl`;
  return {
    where: { checkpoint: cpPath, log: `${FOLDER}/apply-log-${run}-${session}-*.jsonl` },
    async load() {
      let r;
      try { r = await drive.readJsonFile(cpPath); }
      catch (err) { throw new Error(`the checkpoint ${cpPath} cannot be read (${err.message}) — nothing was written`); }
      loaded = true;
      if (!r) { etag = ''; return null; }
      etag = r.etag || '';
      return r.data;
    },
    async prepare() {},
    async save(cp) {
      if (!loaded) throw new Error('the checkpoint was not read first');
      const w = await drive.writeJsonFile(cpPath, cp, { etag });   // a newer one: err.conflict → the run stops, the lock is left
      etag = w.etag || ((await drive.readJsonFile(cpPath)) || {}).etag || '';
    },
    async log(entry) {
      if (!part || lines.length >= LOG_PART) { part++; lines = []; partEtag = ''; }
      lines.push(JSON.stringify(entry));
      try {
        const w = await drive.writeSystemFile(partPath(), `${lines.join('\n')}\n`, { etag: partEtag, contentType: 'application/x-ndjson' });
        partEtag = w.etag || ((await drive.readSystemFile(partPath())) || {}).etag || '';
        fails = 0;
      } catch (err) {
        if (++fails >= 3) throw new Error(`the apply log could not be saved on OneDrive (${err.message})`);
      }
    },
  };
}

/* ───────────────────────────── the files ───────────────────────────── */

async function readPointer(drive) {
  const r = await drive.readJsonFile(POINTER);
  return r ? { data: r.data, etag: r.etag || '' } : null;
}
async function readCheckpoint(drive, run) {
  if (!/^[0-9TZ-]+$/.test(s(run))) return null;
  const r = await drive.readJsonFile(`${FOLDER}/checkpoint-${run}.json`);
  return r ? r.data : null;
}
const isOpen = (cp) => !!(cp && cp.status !== 'finished');
const isFresh = (cp, now) => !!(cp && cp.status === 'running' && Number.isFinite(Date.parse(cp.heartbeatAt)) && now - Date.parse(cp.heartbeatAt) < backfill.STALE_MS);

/**
 * The upload: an answered check list (.xlsx, under 5 MB) — read here, then saved as it came,
 * create-only, under TDOT System/client-id-backfill/. Nothing else is written.
 * @returns {Promise<{ sheetFile: string, sheet: object }>}  throws err.badRequest for a file that is not the check list
 */
async function saveSheet({ buffer, originalName = '' }) {
  const bad = (m) => { const e = new Error(m); e.badRequest = true; return e; };
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw bad('No file came with the upload.');
  if (buffer.length > MAX_SHEET_BYTES) throw bad(`That file is too big — the limit is ${MAX_SHEET_BYTES / 1048576} MB.`);
  if (originalName && !/\.xlsx$/i.test(s(originalName))) throw bad('Upload the answered check list as an .xlsx file.');
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw bad('That file is not an .xlsx workbook.');
  let sheet;
  try { sheet = backfill.readSheetBuffer(deps.xlsx(), buffer); }
  catch (err) { throw bad(`The answered check list cannot be read: ${err.message}`); }
  if (!sheet.order.length) throw bad('The answered check list has no rows.');
  const sheetFile = `answered-${stamp(deps.now())}-${tag()}.xlsx`;
  await deps.drive().writeSystemFile(`${FOLDER}/${sheetFile}`, buffer, { contentType: XLSX_MIME });
  return { sheetFile, sheet };
}

/** An answered sheet saved before (its file name only — never a path). */
async function loadSheet(sheetFile) {
  if (!SHEET_RE.test(s(sheetFile))) { const e = new Error('That is not an answered check list saved by this page.'); e.badRequest = true; throw e; }
  const r = await deps.drive().readSystemFile(`${FOLDER}/${sheetFile}`);
  if (!r) { const e = new Error(`The answered check list ${sheetFile} is not on OneDrive any more — upload it again.`); e.notFound = true; throw e; }
  return backfill.readSheetBuffer(deps.xlsx(), r.buffer);
}

/* ───────────────────────────── the jobs (one at a time in this process) ───────────────────────────── */

let current = null;            // the job running now
let last = null;               // the last job that ended (the page still shows it)
const previews = new Map();    // sheetFile → { phrase, newIds, unclear, changed }

function newJob(kind, by) {
  const job = {
    id: crypto.randomBytes(6).toString('hex'), kind, by: s(by), state: 'running', phase: 'starting',
    startedAt: new Date(deps.now()).toISOString(), endedAt: '', progress: null, result: null, lines: [],
  };
  job.say = (m) => { job.lines.push(maskText(m)); if (job.lines.length > LINES_KEPT) job.lines.splice(0, job.lines.length - LINES_KEPT); };
  return job;
}
function begin(job, work) {
  current = job;
  job.promise = Promise.resolve().then(work).then((r) => r, (err) => {
    job.state = 'failed';
    job.result = { ok: false, reason: 'failed', message: maskText(`The run stopped: ${(err && err.message) || err}. What was done is saved — press Resume to go on.`) };
    deps.log(`[ClientIdBackfill] ${job.kind} ${job.id} stopped with an error (${maskText(String((err && err.message) || err)).slice(0, 160)})`);
  }).finally(() => {
    job.endedAt = new Date(deps.now()).toISOString();
    if (job.state === 'running') job.state = 'done';
    if (current === job) current = null;
    last = job;
  });
  return job;
}

/** What the page sees of a job (never a Clients record id). */
function view(job) {
  if (!job) return null;
  const p = job.progress;
  return {
    id: job.id, kind: job.kind, state: job.state, phase: job.phase, by: job.by, startedAt: job.startedAt, endedAt: job.endedAt,
    progress: p ? { total: p.total, processed: p.processed, alreadyDone: p.alreadyDone, records: p.records, ids: p.ids, kept: p.kept, cases: p.cases, leads: p.leads, copies: p.copies,
      skipped: maskItems(p.skipped).slice(0, SKIPPED_SHOWN), skippedCount: (p.skipped || []).length } : null,
    result: job.result, lines: job.lines.slice(-80),
  };
}

/** The preview's numbers for the page (counts, the phrase, what is unclear). */
function previewOf(ready, sheet) {
  const { plan, counterText } = ready;
  const c = plan.counts;
  const nameOf = (k) => (sheet.names && sheet.names.get(k)) || '';
  const unclear = plan.ignored.map((g) => ({ key: maskKey(g.key), name: s(g.name || nameOf(g.key)), why: maskText(g.why) }));
  const changed = plan.changed.map((g) => ({ key: maskKey(g.key), name: s(nameOf(g.key)), why: maskText(g.why) }));
  return {
    ok: true, people: c.people, newIds: c.newIds, newAccounts: c.newAccounts, keepExisting: c.keepExisting,
    firstNumber: c.firstNumber, lastNumber: c.lastNumber, counter: counterText,
    amberQuestions: c.amberQuestions, amberAnsweredSame: c.amberAnsweredSame, noCase: c.buckets['NO-CASE'], noCaseAnsweredGive: c.noCaseAnsweredGive,
    buckets: c.buckets, yearCounts: plan.yearCounts, blocked: c.blocked,
    unclear, changed, problems: (sheet.problems || []).map(maskText),
    phrase: backfill.confirmPhrase(c.newIds),
    canGo: !unclear.length && !changed.length,
  };
}

/**
 * Upload → preview, in the background (reading the three boards takes a minute or two).
 * @returns {{ started: boolean, job: object }}
 */
function startPreview({ sheetFile, sheet, by }) {
  if (current) return { started: false, job: current };
  const job = newJob('preview', by);
  job.sheetFile = sheetFile;
  begin(job, async () => {
    const x = deps.io();
    const cfg = x.loadBoard();
    if (!cfg) { job.state = 'refused'; job.result = { ok: false, reason: 'dormant', message: 'There is no Clients board set up here.' }; return; }
    const ready = await backfill.readAndPlan(x, cfg, { decisions: sheet.decisions, order: sheet.order, proposed: sheet.proposed, apply: false, log: job.say, onPhase: (ph) => { job.phase = ph; } });
    if (!ready.ok) { job.state = 'refused'; job.result = { ok: false, reason: ready.reason, message: maskText(ready.message) }; return; }
    const pv = previewOf(ready, sheet);
    pv.sheetFile = sheetFile;
    previews.set(sheetFile, { phrase: pv.phrase, newIds: pv.newIds, unclear: pv.unclear.length, changed: pv.changed.length });
    job.result = pv;
    deps.log(`[ClientIdBackfill] preview ${job.id}: ${pv.people} people, ${pv.newIds} new IDs, ${pv.newAccounts} new records, ${pv.unclear.length} unclear, ${pv.changed.length} changed`);
  });
  return { started: true, job };
}

const refused = (status, reason, message, extra = {}) => ({ started: false, status, reason, message, ...extra });

/**
 * Give the Client IDs (or Resume), in the background. Everything that can be checked fast is
 * checked here; the run re-checks it all on a fresh read (the same number of new IDs) before
 * its first write.
 * @returns {Promise<{ started: true, job } | { started: false, status, reason, message }>}
 */
async function startApply({ sheetFile = '', resume = false, admin, automationsChecked, confirm }) {
  if (current) return refused(409, 'in-progress', `A ${current.kind === 'preview' ? 'check' : 'run'} is going right now (started by ${current.by || 'an admin'}) — wait for it to finish.`, { job: view(current) });
  if (automationsChecked !== true) return refused(400, 'automations', backfill.WORDS.page.automations);
  const typed = s(confirm);
  if (!/^GIVE [0-9]+ CLIENT IDS$/.test(typed)) return refused(400, 'confirm', 'Type the phrase exactly as it is shown (GIVE <number> CLIENT IDS) — nothing was written.');
  const x = deps.io();
  if (x.clientIdsMode() === 'on') return refused(409, 'live-on', backfill.WORDS.page.liveOn);
  if (!s(admin) || !x.isAdminEmail(s(admin))) return refused(403, 'not-admin', backfill.WORDS.page.notAdmin);
  const drive = deps.drive();
  const now = deps.now();

  let ptr, cp = null;
  try {
    ptr = await readPointer(drive);
    if (ptr && ptr.data && ptr.data.run) cp = await readCheckpoint(drive, ptr.data.run);
  } catch (err) { return refused(503, 'unavailable', `OneDrive could not be read (${err.message}) — nothing was written. Try again in a minute.`); }
  const open = isOpen(cp) ? ptr.data : null;
  if (resume) {
    if (!open) return refused(409, 'nothing-to-resume', 'There is no stopped run to resume.');
    sheetFile = s(open.sheet);
  } else if (!s(sheetFile)) return refused(400, 'no-decisions', backfill.WORDS.page.noDecisions);
  if (!SHEET_RE.test(s(sheetFile))) return refused(400, 'bad-decisions', 'That is not an answered check list saved by this page.');
  const pv = previews.get(sheetFile);
  if (!resume && pv && (pv.unclear || pv.changed)) return refused(409, pv.unclear ? 'unclear-answers' : 'changed', pv.unclear
    ? `${pv.unclear} answer(s) on this sheet are not Y or N — correct them (Y, N or blank) and upload the sheet again. Nothing was written.`
    : `${pv.changed} answered group(s) changed since the check list was made — make a new check list and answer it again. Nothing was written.`);
  const resumePhrase = cp && Number.isSafeInteger(cp.confirmedNewIds) ? backfill.confirmPhrase(cp.confirmedNewIds) : '';
  if (pv && typed !== pv.phrase && typed !== resumePhrase) return refused(400, 'confirm', backfill.WORDS.page.confirm(pv.phrase), { phrase: pv.phrase });
  if (isFresh(cp, now)) return refused(409, 'run-elsewhere', 'The run saved its progress less than 5 minutes ago — it may still be going on another copy of the server (during a deploy). Wait 5 minutes, then look again. Nothing was written.');
  let counter;
  try { counter = await x.peekCounter(); } catch (err) { counter = { state: 'unavailable', error: err.message }; }
  if (counter && counter.backfill && !backfill.lockIsOurs(open ? cp : null, counter.backfill)) {
    return refused(409, 'lock-held', `The Client ID counter is locked by another backfill (${counter.backfill.by || 'someone'}, since ${counter.backfill.at || 'a while'}). If you are sure no backfill is running anywhere, use Unlock first. Nothing was written.`);
  }

  const run = open ? s(open.run) : stamp(now);
  const job = newJob('apply', admin);
  job.sheetFile = sheetFile; job.run = run; job.resume = !!open;
  begin(job, async () => {
    // current.json: the run in hand and its sheet (a new run, or an open run going on with this sheet)
    if (!open || s(open.sheet) !== sheetFile) {
      const at = new Date(deps.now()).toISOString();
      const data = open ? { ...open, sheet: sheetFile, updatedAt: at } : { run, sheet: sheetFile, by: s(admin), createdAt: at, updatedAt: at };
      await drive.writeJsonFile(POINTER, data, { etag: ptr ? ptr.etag : '' });
    }
    const sheet = await loadSheet(sheetFile);
    const cfg = x.loadBoard();
    deps.log(`[ClientIdBackfill] apply ${job.id} started (run ${run}${open ? ', resumed' : ''})`);
    const r = await backfill.runApply({
      x, store: driveStore(drive, run, `${stamp(deps.now())}-${tag()}`), cfg, sheet, admin: s(admin), automationsChecked: true, typed,
      extra: { sheet: sheetFile, run }, via: 'page', heartbeat: true, pauseMs: deps.pauseMs,
      log: job.say, onProgress: (p) => { job.progress = p; }, onPhase: (ph) => { job.phase = ph; },
    });
    if (!r.ok) {
      job.state = 'refused';
      job.result = { ok: false, reason: r.reason, message: maskText(r.message), ...(r.phrase ? { phrase: r.phrase } : {}),
        ...(r.unclear ? { unclear: maskItems(r.unclear) } : {}), ...(r.changed ? { changed: maskItems(r.changed) } : {}) };
      deps.log(`[ClientIdBackfill] apply ${job.id} refused: ${r.reason}`);
      return;
    }
    const d = r.done;
    job.result = {
      ok: true, records: d.records, ids: d.ids, kept: d.kept, cases: d.cases, leads: d.leads, copies: d.copies,
      skipped: maskItems(d.skippedItems).slice(0, SKIPPED_SHOWN), skippedCount: d.skippedItems.length,
      unused: r.unused.length, unlocked: r.unlocked !== false, startedAt: r.startedAt, healSince: r.healSince,
    };
    deps.log(`[ClientIdBackfill] apply ${job.id} finished: ${d.records} records, ${d.ids} IDs, ${d.kept} kept, ${d.cases} cases, ${d.leads} leads, ${d.copies} copies, ${d.skippedItems.length} left for the admin`);
  });
  return { started: true, job };
}

/**
 * Take the backfill lock out of the counter file — after a run that stopped (a restart).
 * Refused while a run goes here, or while the checkpoint was saved in the last 5 minutes.
 */
async function unlock({ admin, confirm }) {
  if (current) return { ok: false, status: 409, reason: 'in-progress', message: 'A run is going right now — the lock is its own. Wait for it to finish.' };
  if (s(confirm) !== UNLOCK_WORD) return { ok: false, status: 400, reason: 'confirm', message: `Type ${UNLOCK_WORD} to take the lock out.` };
  const x = deps.io();
  if (!s(admin) || !x.isAdminEmail(s(admin))) return { ok: false, status: 403, reason: 'not-admin', message: backfill.WORDS.page.notAdmin };
  const drive = deps.drive();
  let ptr = null, cp = null, cpEtag = '';
  try {
    ptr = await readPointer(drive);
    if (ptr && ptr.data && /^[0-9TZ-]+$/.test(s(ptr.data.run))) {
      const r = await drive.readJsonFile(`${FOLDER}/checkpoint-${ptr.data.run}.json`);
      if (r) { cp = r.data; cpEtag = r.etag || ''; }
    }
  } catch (err) { return { ok: false, status: 503, reason: 'unavailable', message: `OneDrive could not be read (${err.message}) — the lock was not touched.` }; }
  if (isFresh(cp, deps.now())) return { ok: false, status: 409, reason: 'run-elsewhere', message: 'The run saved its progress less than 5 minutes ago — it may still be going on another copy of the server. Wait 5 minutes, then try again.' };
  const r = await x.unlockCounter();
  if (!r || !r.ok) return { ok: false, status: 503, reason: 'unlock', message: `The lock could not be taken out (${(r && r.message) || 'no answer'}).` };
  if (cp && cp.status === 'running') {
    // the run was cut off: say so in its checkpoint (only over the version just read)
    try { await drive.writeJsonFile(`${FOLDER}/checkpoint-${ptr.data.run}.json`, { ...cp, status: 'stopped', stoppedAt: new Date(deps.now()).toISOString(), error: 'cut off (a restart); the lock was taken out by an admin' }, { etag: cpEtag }); } catch (_) { /* the state shows it as cut off anyway */ }
  }
  deps.log(`[ClientIdBackfill] backfill lock ${r.cleared ? 'taken out' : 'was not there'} (unlock by a named admin)`);
  return { ok: true, cleared: !!r.cleared, message: r.cleared ? 'The lock is out of the counter file — the live app gives Client IDs again (when CLIENT_IDS is on).' : 'There was no lock in the counter file — nothing to do.' };
}

/** Everything the page shows. Read only. */
async function state() {
  const x = deps.io();
  const cfg = x.loadBoard();
  const now = deps.now();
  const out = {
    mode: x.clientIdsMode(), configured: backfill.configured(cfg),
    counter: null, run: null, job: view(current || last), running: !!current,
    unlockWord: UNLOCK_WORD, folder: FOLDER,
  };
  try {
    const c = await x.peekCounter();
    out.counter = { state: c.state, last: c.state === 'ok' ? c.last : null, lock: c.backfill ? { by: s(c.backfill.by), at: s(c.backfill.at) } : null, error: c.error ? maskText(c.error).slice(0, 200) : '' };
  } catch (err) { out.counter = { state: 'unavailable', error: maskText(err.message).slice(0, 200) }; }
  try {
    const ptr = await readPointer(deps.drive());
    const cp = ptr && ptr.data && ptr.data.run ? await readCheckpoint(deps.drive(), ptr.data.run) : null;
    if (ptr && ptr.data) {
      const cutOff = !!(cp && cp.status === 'running' && !isFresh(cp, now) && !(current && current.run === ptr.data.run));
      out.run = {
        run: s(ptr.data.run), sheet: s(ptr.data.sheet), by: s(ptr.data.by), createdAt: s(ptr.data.createdAt),
        checkpoint: !!cp,
        status: !cp ? 'not started' : cutOff ? 'cut off' : s(cp.status) || 'stopped',
        startedAt: cp ? s(cp.startedAt) : '', runStartedAt: cp ? s(cp.runStartedAt) : '', heartbeatAt: cp ? s(cp.heartbeatAt) : '',
        finishedAt: cp ? s(cp.finishedAt) : '', stoppedAt: cp ? s(cp.stoppedAt) : '', error: cp && cp.error ? maskText(cp.error).slice(0, 300) : '',
        runs: cp ? cp.runs || 0 : 0,
        confirmedNewIds: cp && Number.isSafeInteger(cp.confirmedNewIds) ? cp.confirmedNewIds : null,
        resumePhrase: cp && Number.isSafeInteger(cp.confirmedNewIds) ? backfill.confirmPhrase(cp.confirmedNewIds) : '',
        given: cp ? Object.keys(cp.given || {}).length : 0, done: cp ? Object.keys(cp.done || {}).length : 0,
        blocks: cp ? (cp.blocks || []).map((b) => ({ first: b.first, last: b.last })) : [],
        lockIsOurs: !!(cp && out.counter && out.counter.lock && backfill.lockIsOurs(cp, out.counter.lock)),
        summary: cp && cp.summary ? cp.summary : null,
        skipped: cp && cp.skippedItems ? maskItems(cp.skippedItems).slice(0, SKIPPED_SHOWN) : [],
        healSince: cp ? backfill.healSinceText(cp.startedAt) : null,
        canResume: !!(cp && cp.status !== 'finished' && !current && !isFresh(cp, now)),
      };
    }
  } catch (err) { out.runError = `OneDrive could not be read (${maskText(err.message).slice(0, 160)})`; }
  return out;
}

/** The cheap poll: the job only (no read at all). */
function jobState() { return { job: view(current || last), running: !!current }; }

function _resetForTests() { current = null; last = null; previews.clear(); }

module.exports = {
  saveSheet, loadSheet, startPreview, startApply, unlock, state, jobState, view, previewOf,
  driveStore, maskKey, maskText, deps, _resetForTests,
  FOLDER, POINTER, SHEET_RE, MAX_SHEET_BYTES, UNLOCK_WORD, LOG_PART,
  _current: () => current,
};
