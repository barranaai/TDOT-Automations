'use strict';

/**
 * The staff cockpit's "Add family member" as a background job (2026-10-10).
 *
 * An add on a real case runs ~60-90 s (the carry-over, the questionnaire
 * section, the Family Members row, the checklist re-seed, the note). Something
 * between the browser and the app cuts a request that long: three times the
 * answer was lost while the server finished the add (EE-075, PS-100, PS-085) —
 * the page then shows an error for an add that worked, and a second press adds
 * a second child. Now the route answers at once with a job id, the add runs
 * here, and the page asks for the outcome every few seconds.
 *
 * - The add itself is unchanged: the same familyMemberService call, the same
 *   answers. Errors map exactly as the route mapped them (badRequest → 400,
 *   transient → 503, anything else → 500 "Internal server error").
 * - ONE running add per case from the cockpit: a second press while one runs
 *   gets the running job back, never a second add.
 * - A job is bound to its case; its id is unguessable; whoever asks must be
 *   allowed to see the case (the assignees captured when it started).
 * - Jobs live in this process only (single web process). A restart loses them:
 *   the page then says to reload and check the Family list — never "try again".
 * - Finished jobs are kept 30 min (a reload or a slow poll still finds them),
 *   at most MAX_JOBS; a running job is never dropped.
 */

const crypto = require('crypto');

const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 200;

const io = { now: () => Date.now() };

const _jobs = new Map();            // id → job
const _runningByCase = new Map();   // CASEREF → id

const caseKey = (ref) => String(ref || '').trim().toUpperCase();

function sweep() {
  const now = io.now();
  for (const [id, j] of _jobs) if (j.state !== 'running' && now - j.finishedAt > JOB_TTL_MS) _jobs.delete(id);
  if (_jobs.size > MAX_JOBS) {
    const done = [..._jobs.values()].filter((j) => j.state !== 'running').sort((a, b) => a.finishedAt - b.finishedAt);
    for (const j of done.slice(0, _jobs.size - MAX_JOBS)) _jobs.delete(j.id);
  }
}

/**
 * Start the add in the background — or hand back the one already running for this case.
 * @param {{ caseRef: string, assignees: object, by: string, memberType: string, run: () => Promise<object> }} p
 * @returns {{ started: boolean, job: object }}
 */
function start({ caseRef, assignees, by = '', memberType = '', run }) {
  sweep();
  const key = caseKey(caseRef);
  const runningId = _runningByCase.get(key);
  if (runningId && _jobs.has(runningId)) return { started: false, job: _jobs.get(runningId) };
  const job = {
    id: 'fam-' + crypto.randomBytes(12).toString('hex'), caseKey: key, caseRef: String(caseRef || '').trim(),
    assignees: assignees || { personIds: [], teamIds: [] }, by: String(by || ''), memberType: String(memberType || ''),
    state: 'running', startedAt: io.now(), finishedAt: 0, result: null, code: 0, error: '',
  };
  _jobs.set(job.id, job);
  _runningByCase.set(key, job.id);
  job.promise = Promise.resolve()
    .then(run)
    .then((r) => {
      Object.assign(job, { state: 'done', code: 200, result: r });
      console.log(`[Family] ${job.caseRef}: ${job.memberType} added by ${job.by}`);
    }, (err) => {
      // the route's own mapping, unchanged
      const e = err || {};
      if (e.badRequest) Object.assign(job, { state: 'failed', code: 400, error: e.message });
      else if (e.transient) Object.assign(job, { state: 'failed', code: 503, error: e.message });
      else {
        console.error(`[Family] add failed for ${job.caseRef}:`, e.message);
        Object.assign(job, { state: 'failed', code: 500, error: 'Internal server error' });
      }
    })
    .catch((err) => {   // last line of defence: a job never stays "running" forever
      console.error(`[Family] job ${job.id} for ${job.caseRef} ended badly:`, err && err.message);
      Object.assign(job, { state: 'failed', code: 500, error: 'Internal server error' });
    })
    .finally(() => {
      job.finishedAt = io.now();
      if (_runningByCase.get(key) === job.id) _runningByCase.delete(key);
    });
  return { started: true, job };
}

/** The job, when it exists AND belongs to this case. */
function get(id, caseRef) {
  sweep();
  const j = _jobs.get(String(id || ''));
  return j && j.caseKey === caseKey(caseRef) ? j : null;
}

/** What the page may see: no assignees, no promise. */
function view(j) {
  const out = { ok: true, jobId: j.id, state: j.state, startedAt: new Date(j.startedAt).toISOString(), by: j.by, memberType: j.memberType };
  if (j.state === 'done') out.result = j.result;
  if (j.state === 'failed') { out.code = j.code; out.error = j.error; }
  return out;
}

function _resetForTests() { _jobs.clear(); _runningByCase.clear(); }
async function _waitForTests() { await Promise.all([..._jobs.values()].map((j) => j.promise)); }

module.exports = { start, get, view, io, JOB_TTL_MS, MAX_JOBS, _resetForTests, _waitForTests, _jobs, _runningByCase };
