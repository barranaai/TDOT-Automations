'use strict';

/**
 * One-off backfill: the four staff working folders (1-Coordinator-Working,
 * 2-Case-Manager-Draft, 3-AW-Analyst-Final-RCIC, 4-Submitted-IRCC) for EVERY
 * existing case folder (Faran, 2026-10-01: "make the same four folders for all
 * the cases folders"). New case folders already get them (oneDriveService,
 * WORK_FOLDERS_SINCE); this covers the ones that existed before.
 *
 * Which cases (Faran's choice): every Client Master row that is active and has
 * a case reference — cancelled and not-retained cases included — except the
 * TEST group. Lead folders without a case are never matched (their names end
 * "LEAD-<id>", not a case reference).
 *
 * Which folder: the one the app itself reads and writes for the case — the
 * root folder whose name ends " - <case ref>", and when a case has two, the
 * same choice the app makes (oneDriveService.pickCaseFolder: the one holding
 * the documents). A case with no folder is reported and skipped: this job
 * never creates a case folder, only the four inside an existing one.
 *
 * Safety: preview first (dry run lists what is missing, creates nothing); the
 * real run needs the confirmation text; only the four exact names are ever
 * created, only where missing (the folder's own listing decides); nothing is
 * renamed, moved or deleted; one job at a time; paced, with a pause-and-retry
 * when Graph throttles; can be aborted between folders; safe to run again.
 */

const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const CONFIRM_TEXT   = 'ADD-WORK-FOLDERS';
const TEST_GROUP_ID  = 'group_mm3842s';     // the Cases board's TEST group
const CASE_REF_COL   = 'text_mm142s49';
const FOLDER_ID_COL  = 'text_mm47y540';   // the folder the case's Monday row links
const PACE_MS        = 250;                 // between folders — a few Graph calls each, well under throttling
const MAX_RETRIES    = 2;                   // per folder, after a throttle / transient failure
const DEFAULT_WAIT_S = 10;                  // when Graph gives no Retry-After
const STOP_AFTER_FAILS_IN_A_ROW = 5;        // then it is not one folder, it is OneDrive — stop and report
const ATTEMPT_DEADLINE_MS = 120000;         // one folder, one try: never wait longer (a hung login call would freeze the job)

const PREVIEW_VALID_MS = 6 * 3600 * 1000;   // a real run acts on what a preview from the last 6 hours saw — no older

/**
 * Left out on purpose (Faran, 2026-09-30, after the production preview): a
 * real client's case reference that is ALSO carried by a leftover TEST folder,
 * so the app resolves the case to the test folder. Four more sub-folders there
 * would only make that wrong choice harder to undo. Take a reference out of
 * this list once its folder is sorted, and run the job again.
 */
const LEAVE_OUT = new Map([
  // 2026-CEC-PR-002, 2026-VV-008 and 2026-SP-015 were repaired on 2026-10-01 (caseFolderMergeService: the test
  // folders were renamed off the reference, the clients' files copied into their real folders) and are back in.
  ['2026-SP-004',     'test folders "TEST CLIENT - E2E 1780224413906" / "ZZ Folder E2E" — the client has no real folder'],
]);
const LEFT_OUT_REASON = 'left out: the app resolves it to a leftover test folder (sort that first)';

const CASE_WORK_FOLDERS_ORDER = ['1-Coordinator-Working', '2-Case-Manager-Draft', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC'];   // report order; test pins it to oneDriveService.CASE_WORK_FOLDERS

const s = (v) => String(v == null ? '' : v).trim();
const normRef = (r) => s(r).replace(/\s+/g, ' ');

/**
 * PURE — match every case to the folder the app uses for it.
 *
 * @param {{ cases: Array<{id,name,state,groupId,groupTitle,caseRef}>, rootFolders: Array<{id,name,childCount}>, pick: Function }} p
 *   pick = oneDriveService.pickCaseFolder (the app's own choice between two folders of one case)
 * @returns {{ targets: Array<{folderId, folderName, refs: string[], cases: string[], split: boolean, splitNames: string[]}>,
 *             skipped: Array<{caseRef, name, reason}>, counts: object }}
 */
function planBackfill({ cases, rootFolders, pick }) {
  const skipped = [];
  const byFolder = new Map();   // folderId → target (two rows sharing one reference share one folder)
  // The folder the Cases board links for a reference — only when its rows agree
  // on ONE folder (the live app's rule, caseFolderLinkService.linkedFolderIds).
  const linksByRef = new Map();
  for (const c of cases || []) {
    const ref = normRef(c.caseRef);
    if (!ref || !c.folderId) continue;
    if (!linksByRef.has(ref)) linksByRef.set(ref, new Set());
    linksByRef.get(ref).add(c.folderId);
  }
  let considered = 0;
  for (const c of cases || []) {
    const ref = normRef(c.caseRef);
    if (c.state && c.state !== 'active') { skipped.push({ caseRef: ref, name: c.name, reason: 'not active' }); continue; }
    if (c.groupId === TEST_GROUP_ID) { skipped.push({ caseRef: ref, name: c.name, reason: 'TEST group' }); continue; }
    if (!ref) { skipped.push({ caseRef: '', name: c.name, reason: 'no case reference' }); continue; }
    if (LEAVE_OUT.has(ref)) { skipped.push({ caseRef: ref, name: c.name, reason: LEFT_OUT_REASON, detail: LEAVE_OUT.get(ref) }); continue; }
    considered++;
    const suffix = ` - ${ref}`;
    const hits = (rootFolders || []).filter((f) => f.name.endsWith(suffix));
    if (!hits.length) { skipped.push({ caseRef: ref, name: c.name, reason: 'no case folder in OneDrive' }); continue; }
    // Two folders: the one the Cases board links wins, as in the live app (oneDriveService.chooseCaseFolderWithReason).
    const links = linksByRef.get(ref);
    const linkId = links && links.size === 1 ? [...links][0] : '';
    const linked = hits.length > 1 && linkId ? hits.find((h) => h.id === linkId) : null;
    const chosen = hits.length === 1 ? hits[0] : (linked || pick(hits, ref));
    let t = byFolder.get(chosen.id);
    if (!t) {
      t = { folderId: chosen.id, folderName: chosen.name, refs: [], cases: [], split: hits.length > 1, splitNames: hits.length > 1 ? hits.map((h) => h.name) : [] };
      byFolder.set(chosen.id, t);
    }
    if (!t.refs.includes(ref)) t.refs.push(ref);
    t.cases.push(c.name);
  }
  const targets = [...byFolder.values()].sort((a, b) => a.folderName.localeCompare(b.folderName));
  const reasons = {};
  for (const k of skipped) reasons[k.reason] = (reasons[k.reason] || 0) + 1;
  return {
    targets, skipped,
    counts: { caseRows: (cases || []).length, considered, folders: targets.length, splitCases: targets.filter((t) => t.split).length, skipped: reasons },
  };
}

/* ───────────────────────────── I/O ───────────────────────────── */

const io = {
  async listCases() {
    const ITEMS = `cursor items{ id name state group{ id title } column_values(ids:["${CASE_REF_COL}","${FOLDER_ID_COL}"]){ id text } }`;
    const all = []; let cursor = null;
    do {
      const d = cursor
        ? await mondayApi.query(`query($c:String!){ boards(ids:["${clientMasterBoardId}"]){ items_page(limit:200, cursor:$c){ ${ITEMS} } } }`, { c: cursor })
        : await mondayApi.query(`{ boards(ids:["${clientMasterBoardId}"]){ items_page(limit:200){ ${ITEMS} } } }`);
      const page = d && d.boards && d.boards[0] && d.boards[0].items_page;
      if (!page) throw new Error('Cases board listing came back empty');
      for (const it of page.items || []) {
        all.push({ id: String(it.id), name: it.name || '', state: it.state || 'active', groupId: (it.group && it.group.id) || '', groupTitle: (it.group && it.group.title) || '',
          caseRef: ((it.column_values || []).find((c) => c.id === CASE_REF_COL) || {}).text || '',
          folderId: (((it.column_values || []).find((c) => c.id === FOLDER_ID_COL) || {}).text || '').trim() });
      }
      cursor = page.cursor;
    } while (cursor);
    return all;
  },
  listRootFolders: () => require('./oneDriveService').listCaseFoldersInRoot(),
  pick:            (hits, ref) => require('./oneDriveService').pickCaseFolder(hits, ref),
  ensure:          (p) => require('./oneDriveService').ensureCaseWorkFolders(p),
  sleep:           (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); }),
  deadlineMs:      ATTEMPT_DEADLINE_MS,
  now:             () => new Date(),
};

/* ───────────────────────────── the job ───────────────────────────── */

let _job = null;
let _seq = 0;
/**
 * The last COMPLETE preview: which folders it checked, and when. A real run
 * only touches folders on this list — it does what the preview showed, and a
 * folder that appeared since (a new split, a new test folder) is reported, not
 * touched. Lost on a restart, like the report: preview again after a deploy.
 */
let _lastPreview = null;

function summary(job, { full = false } = {}) {
  if (!job) return null;
  const rows = full ? job.rows : job.rows.filter((r) => r.error || r.tries || r.notInPreview || (r.created && r.created.length) || (r.wouldCreate && r.wouldCreate.length) || r.split);
  return {
    id: job.id, mode: job.dryRun ? 'preview (nothing created)' : 'REAL RUN', state: job.state, by: job.by,
    startedAt: job.startedAt, finishedAt: job.finishedAt || null,
    progress: { done: job.rows.length, of: job.plan ? job.plan.targets.length : null },
    counts: job.plan ? job.plan.counts : null,
    totals: job.totals, error: job.error || null,
    boundToPreview: job.preview ? job.preview.id : undefined,
    leftOut: job.plan ? job.plan.skipped.filter((k) => k.reason === LEFT_OUT_REASON) : undefined,
    rows, skipped: full ? (job.plan ? job.plan.skipped : []) : undefined,
  };
}

function statusOf({ full = false } = {}) {
  const st = summary(_job, { full });
  if (st) st.previewOnRecord = _lastPreview ? { id: _lastPreview.id, at: new Date(_lastPreview.at).toISOString(), folders: _lastPreview.folders, checked: _lastPreview.checked.size } : null;
  return st;
}

/**
 * Start a job. Returns at once; the job runs in the background (a Render
 * request would time out long before 600 folders are done). One at a time.
 *
 * @param {{ dryRun?: boolean, confirm?: string, by?: string }} p
 * @returns {{ started: boolean, reason?: string, job?: object }}
 */
function startBackfill({ dryRun = true, confirm = '', by = '' } = {}) {
  if (_job && _job.state === 'running') return { started: false, reason: 'A backfill is already running — check its status, or abort it first.', job: summary(_job) };
  if (!dryRun && confirm !== CONFIRM_TEXT) return { started: false, reason: `A real run needs the confirmation text "${CONFIRM_TEXT}".` };
  if (!dryRun && !_lastPreview) return { started: false, reason: 'Run a preview first — a real run only does what a complete preview has shown.' };
  if (!dryRun && io.now().getTime() - _lastPreview.at > PREVIEW_VALID_MS) {
    return { started: false, reason: `The last preview (${_lastPreview.id}) is more than ${PREVIEW_VALID_MS / 3600000} hours old — run a fresh preview first.` };
  }
  _job = {
    id: `wf-${++_seq}-${io.now().toISOString()}`, dryRun: !!dryRun, by: s(by) || 'admin', state: 'running',
    startedAt: io.now().toISOString(), finishedAt: null, abort: false, plan: null, rows: [], error: null,
    wake: null, woken: null,
    checked: new Set(),                                    // preview: the folders it checked without an error
    preview: dryRun ? null : _lastPreview,                 // real run: the preview it is bound to
    totals: { folders: 0, alreadyComplete: 0, foldersToAdd: 0, created: 0, failedFolders: 0, notInPreview: 0 },
  };
  const job = _job;
  job.woken = new Promise((r) => { job.wake = r; });   // abort resolves it: no wait (a retry pause, a slow folder) outlasts an abort
  console.log(`[WorkFolders] ${job.dryRun ? 'Preview' : 'REAL RUN'} started by ${job.by} (${job.id})`);
  run(job).catch((err) => {   // run() handles its own errors; this is the last line of defence
    job.state = 'failed'; job.error = err.message; job.finishedAt = io.now().toISOString();
    console.error(`[WorkFolders] job ${job.id} crashed: ${err.message}`);
  });
  return { started: true, job: summary(job) };
}

/** Ask the running job to stop after the folder it is on. */
function abortBackfill() {
  if (!_job || _job.state !== 'running') return { aborted: false, reason: 'Nothing is running.' };
  _job.abort = true;
  _job.wake();
  return { aborted: true, job: summary(_job) };
}

/** Seconds Graph asked us to wait (Retry-After), else a sensible pause. */
function retryAfterSeconds(err) {
  const e = (err && err.cause) || err;
  const h = e && e.response && e.response.headers;
  const v = h && (h['retry-after'] || h['Retry-After']);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 120) : DEFAULT_WAIT_S;
}
/** Throttling, a server hiccup or a dropped connection is worth another try; a refusal (403, 404 …) is not. */
function isRetryable(err) {
  const e = (err && err.cause) || err;
  const st = e && e.response && e.response.status;
  if (st) return st === 408 || st === 429 || st >= 500;
  return !!((err && err.transient) || (e && e.transient) || (e && e.code));   // no answer at all: timeout / network / token
}

/**
 * The attempt — or a retryable failure once `ms` pass without an answer, or
 * the moment the job is aborted. A late answer is harmless: same folder, same
 * four names, and a second create of one is refused (409).
 */
function withinDeadline(promise, ms, job) {
  let t;
  const late = new Promise((_, reject) => {
    t = setTimeout(() => { const e = new Error(`no answer from OneDrive within ${Math.round(ms / 1000)}s`); e.transient = true; e.unanswered = true; reject(e); }, ms);
    if (t && t.unref) t.unref();
  });
  const stop = job.woken.then(() => { const e = new Error('aborted'); e.aborted = true; throw e; });
  return Promise.race([promise, late, stop]).finally(() => clearTimeout(t));
}
/** A pause the abort cuts short. */
const pause = (ms, job) => Promise.race([io.sleep(ms), job.woken]);

async function run(job) {
  try {
    const [cases, rootFolders] = await Promise.all([io.listCases(), io.listRootFolders()]);
    job.plan = planBackfill({ cases, rootFolders, pick: io.pick });
    job.totals.folders = job.plan.targets.length;
    console.log(`[WorkFolders] ${job.id}: ${job.plan.counts.considered} case(s) considered → ${job.plan.targets.length} folder(s); skipped ${JSON.stringify(job.plan.counts.skipped)}`);

    let failsInARow = 0;
    for (const t of job.plan.targets) {
      if (job.abort) { job.state = 'aborted'; break; }
      if (failsInARow >= STOP_AFTER_FAILS_IN_A_ROW) {
        job.state = 'stopped';
        job.error = `Stopped after ${failsInARow} folders in a row failed — OneDrive itself looks unavailable. Nothing more was attempted; run again later.`;
        break;
      }
      const row = { refs: t.refs, folder: t.folderName, split: t.split || undefined, splitNames: t.split ? t.splitNames : undefined };
      if (!job.dryRun && !job.preview.checked.has(t.folderId)) {
        row.notInPreview = true;                             // appeared (or changed) since the preview: never touched unseen
        job.totals.notInPreview++;
        job.rows.push(row);
        continue;
      }
      // What THIS run added here, across every try: a try that failed half-way
      // still made some (err.created), and a create that timed out may have
      // landed anyway — missing when we tried, there when we looked again.
      const made = new Set(), triedAndMissed = new Set();
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await withinDeadline(io.ensure({ folderId: t.folderId, label: t.refs.join(', '), dryRun: job.dryRun }), io.deadlineMs, job);
          if (job.dryRun) {
            job.checked.add(t.folderId);
            row.wouldCreate = r.wouldCreate || [];
            if (row.wouldCreate.length) job.totals.foldersToAdd += row.wouldCreate.length; else job.totals.alreadyComplete++;
          } else {
            for (const n of (r.created || [])) made.add(n);
            for (const n of (r.present || [])) if (triedAndMissed.has(n)) made.add(n);
            if (!made.size) job.totals.alreadyComplete++;
          }
          if (attempt) row.tries = attempt + 1;
          failsInARow = 0;
          break;
        } catch (err) {
          if (err.aborted) { row.error = 'aborted while this folder was being done — run again to finish it'; break; }
          for (const n of (err.created || [])) made.add(n);
          for (const n of (err.missing || [])) triedAndMissed.add(n);
          // A try that never answered may still have made some — we cannot know which; say so.
          if (err.unanswered) row.unansweredTry = true;
          if (isRetryable(err) && attempt < MAX_RETRIES && !job.abort) {
            const wait = retryAfterSeconds(err);
            console.warn(`[WorkFolders] ${t.refs.join(', ')}: ${err.message} — waiting ${wait}s and trying again`);
            await pause(wait * 1000, job);
            if (job.abort) { row.error = 'aborted while this folder was being done — run again to finish it'; break; }
            continue;
          }
          row.error = err.message;
          row.tries = attempt + 1;
          if (Array.isArray(err.missing)) row.missing = err.missing;
          job.totals.failedFolders++;
          failsInARow++;
          console.error(`[WorkFolders] ${t.refs.join(', ')} ("${t.folderName}"): ${err.message}`);
          break;
        }
      }
      if (!job.dryRun) {
        row.created = CASE_WORK_FOLDERS_ORDER.filter((n) => made.has(n));
        job.totals.created += row.created.length;
      }
      job.rows.push(row);
      await pause(PACE_MS, job);
    }
    if (job.state === 'running') job.state = job.abort ? 'aborted' : 'done';   // an abort on the LAST folder is still an abort
    if (job.dryRun && job.state === 'done') {                // only a COMPLETE preview can license a real run
      _lastPreview = { id: job.id, at: io.now().getTime(), checked: job.checked, folders: job.plan.targets.length };
    }
  } catch (err) {
    job.state = 'failed';
    job.error = err.message;
    console.error(`[WorkFolders] job ${job.id} failed before it could finish: ${err.message}`);
  } finally {
    job.finishedAt = io.now().toISOString();
    const t = job.totals;
    console.log(`[WorkFolders] ${job.dryRun ? 'Preview' : 'REAL RUN'} ${job.state}: ${job.rows.length}/${t.folders} folder(s); ` +
      (job.dryRun ? `${t.foldersToAdd} working folder(s) would be added` : `${t.created} working folder(s) created`) +
      `; ${t.alreadyComplete} already complete; ${t.failedFolders} failed`);
  }
}

function _resetForTests() { _job = null; _lastPreview = null; }
/** Tests of everything AFTER the preview gate: pretend a complete preview checked these folders (or '*': every folder). */
function _previewOnRecordForTests(ids = '*') {
  const all = { has: () => true, size: Infinity };
  _lastPreview = { id: 'test-preview', at: io.now().getTime(), checked: ids === '*' ? all : new Set(ids), folders: 0 };
}
async function _waitForTests() { while (_job && _job.state === 'running') await new Promise((r) => setImmediate(r)); return summary(_job, { full: true }); }

module.exports = {
  planBackfill, startBackfill, abortBackfill, statusOf,   // planBackfill is pure
  io, CONFIRM_TEXT, TEST_GROUP_ID, LEAVE_OUT, PREVIEW_VALID_MS,
  _resetForTests, _waitForTests, _previewOnRecordForTests,
};
