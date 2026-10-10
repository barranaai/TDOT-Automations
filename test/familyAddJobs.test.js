'use strict';

// The cockpit's "Add family member" runs as a background job (2026-10-10):
// an add takes ~60-90 s and three answers that long were lost on the way back
// (EE-075, PS-100, PS-085) — staff saw an error for an add that worked. The
// route now answers 202 + a job id at once; the page polls for the outcome and
// shows the SAME messages; one running add per case; never retried by itself.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');

const jobs = require('../src/services/familyAddJobs');

const ASSIGNEES = { personIds: ['50811878'], teamIds: [] };
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const quiet = async (fn) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

test('a job: answers at once, runs the add, keeps the result; the view shows no assignees', async () => {
  jobs._resetForTests();
  const d = deferred();
  const r = jobs.start({ caseRef: '2026-CEC-PS-085', assignees: ASSIGNEES, by: 'Deeksha Sharma', memberType: 'Spouse / Common-Law Partner', run: () => d.p });
  assert.equal(r.started, true);
  assert.match(r.job.id, /^fam-[0-9a-f]{24}$/, 'an unguessable id');
  assert.equal(jobs.view(r.job).state, 'running');
  assert.ok(!('result' in jobs.view(r.job)) && !('assignees' in jobs.view(r.job)) && !('promise' in jobs.view(r.job)));
  d.resolve({ ok: true, key: 'spouse', reseed: { created: 10 } });
  await quiet(() => jobs._waitForTests());
  const v = jobs.view(jobs.get(r.job.id, '2026-CEC-PS-085'));
  assert.deepEqual([v.state, v.result.key, v.result.reseed.created, v.by, v.memberType], ['done', 'spouse', 10, 'Deeksha Sharma', 'Spouse / Common-Law Partner']);
  assert.ok(!('code' in v) && !('error' in v));
});

test('ONE running add per case: a second press gets the running job (any spelling of the reference); after it ends a new add may start', async () => {
  jobs._resetForTests();
  const d = deferred(); let runs = 0;
  const a = jobs.start({ caseRef: '2026-CEC-PS-085', assignees: ASSIGNEES, run: () => { runs++; return d.p; } });
  const b = jobs.start({ caseRef: '2026-cec-ps-085 ', assignees: ASSIGNEES, run: () => { runs++; return {}; } });
  assert.deepEqual([b.started, b.job.id], [false, a.job.id]);
  const other = jobs.start({ caseRef: '2026-CEC-PS-100', assignees: ASSIGNEES, run: async () => ({ ok: true }) });
  assert.equal(other.started, true, 'another case is not held up');
  d.resolve({ ok: true });
  await quiet(() => jobs._waitForTests());
  assert.equal(runs, 1, 'the second press never ran an add');
  const c = jobs.start({ caseRef: '2026-CEC-PS-085', assignees: ASSIGNEES, run: async () => ({ ok: true }) });
  assert.equal(c.started, true);
  await quiet(() => jobs._waitForTests());
});

test('errors end the job with the route’s own answers: refusal 400, try-again 503 (the half-added wording kept), anything else 500 — never "running" forever', async () => {
  jobs._resetForTests();
  const cases = [
    [() => { throw Object.assign(new Error('A spouse is already on this case.'), { badRequest: true }); }, 400, 'A spouse is already on this case.'],
    [async () => { throw Object.assign(new Error('Family member half-added: the questionnaire section exists but the row failed — press Add again.'), { transient: true, manifestAdded: true }); }, 503, 'Family member half-added: the questionnaire section exists but the row failed — press Add again.'],
    [async () => { throw new Error('Cannot read properties of undefined'); }, 500, 'Internal server error'],
    [() => { throw null; }, 500, 'Internal server error'],
  ];
  const ids = [];
  for (const [run, , ] of cases) ids.push(jobs.start({ caseRef: `2026-X-${ids.length}`, assignees: ASSIGNEES, run }).job.id);
  await quiet(() => jobs._waitForTests());
  cases.forEach(([, code, error], i) => {
    const v = jobs.view(jobs.get(ids[i], `2026-X-${i}`));
    assert.deepEqual([v.state, v.code, v.error], ['failed', code, error]);
    assert.ok(!('result' in v));
  });
  assert.equal(jobs._runningByCase.size, 0, 'every case is free again');
});

test('a job belongs to its case: another reference or an unknown id finds nothing', async () => {
  jobs._resetForTests();
  const { job } = jobs.start({ caseRef: '2026-CEC-PS-085', assignees: ASSIGNEES, run: async () => ({ ok: true }) });
  await quiet(() => jobs._waitForTests());
  assert.ok(jobs.get(job.id, '2026-cec-ps-085'));
  assert.equal(jobs.get(job.id, '2026-CEC-PS-100'), null);
  assert.equal(jobs.get('fam-0000', '2026-CEC-PS-085'), null);
  assert.equal(jobs.get('', '2026-CEC-PS-085'), null);
});

test('finished jobs are kept 30 minutes, then dropped; at most MAX_JOBS; a running job is never dropped', async () => {
  jobs._resetForTests();
  const realNow = jobs.io.now; let clock = Date.parse('2026-10-10T10:00:00Z');
  jobs.io.now = () => clock;
  try {
    const d = deferred();
    const running = jobs.start({ caseRef: 'R-1', assignees: ASSIGNEES, run: () => d.p }).job;
    const done = jobs.start({ caseRef: 'R-2', assignees: ASSIGNEES, run: async () => ({ ok: true }) }).job;
    await quiet(() => new Promise((r) => setImmediate(r)));
    clock += jobs.JOB_TTL_MS - 1000;
    assert.ok(jobs.get(done.id, 'R-2'), 'still there just under 30 min');
    clock += 2000;
    assert.equal(jobs.get(done.id, 'R-2'), null, 'gone after 30 min');
    assert.ok(jobs.get(running.id, 'R-1'), 'the running one stays');
    for (let i = 0; i < jobs.MAX_JOBS + 5; i++) { jobs.start({ caseRef: 'C-' + i, assignees: ASSIGNEES, run: async () => ({}) }); clock += 1; }
    await quiet(() => new Promise((r) => setImmediate(r)));
    jobs.get('x', 'y');   // sweeps
    assert.ok(jobs._jobs.size <= jobs.MAX_JOBS);
    assert.ok(jobs.get(running.id, 'R-1'), 'the cap never drops a running add');
    d.resolve({});
    await quiet(() => jobs._waitForTests());
  } finally { jobs.io.now = realNow; jobs._resetForTests(); }
});

// ── the status route (wiring from the source: requiring server.js starts it) ──
test('status route: signed in, the job of THIS case, the viewer may see the case — and no case read per poll', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const i = src.indexOf("app.get('/admin/case-action/:caseRef/family/add/:jobId'");
  assert.ok(i > src.indexOf("app.post('/admin/case-action/:caseRef/family/add'"));
  const body = src.slice(i, src.indexOf('\n});', i));
  assert.ok(body.indexOf('resolveViewer(req)') < body.indexOf('familyAddJobs'), 'sign-in first');
  assert.match(body, /if \(!viewer\) return res\.status\(401\)/);
  assert.match(body, /jobs\.get\(req\.params\.jobId, \(req\.params\.caseRef \|\| ''\)\.trim\(\)\)/);
  assert.match(body, /res\.set\('Cache-Control', 'no-store'\)/);
  assert.match(body, /if \(!job\) return res\.status\(404\)\.json\(\{ ok: false, reason: 'unknown-job', error: 'The server no longer knows this add \(it may have restarted\)\. Reload the page and check the Family list and the case notes before adding again\.' \}\)/);
  assert.match(body, /if \(!viewer\.isAdmin && !caseAccess\.viewerCanSee\(job\.assignees, viewer\)\) return res\.status\(403\)/);
  assert.ok(!/resolveCaseForWrite|getCaseOverview|mondayApi|oneDrive/.test(body), 'polled every few seconds: no Monday or OneDrive call');
  assert.match(body, /res\.json\(jobs\.view\(job\)\)/);
});

// ── the page, run in a sandbox: POST → poll → the same message ──
function pageSandbox({ responses, stored = '' } = {}) {
  const html = require('../src/routes/adminCase').buildCockpitHTML('2026-CEC-PS-085');
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const seg = js.slice(js.indexOf('function famAdd()'), js.indexOf('// Create case folder'));
  assert.ok(seg.length > 1000 && /function famResume/.test(seg));
  const els = { 'fam-type': { value: 'Spouse / Common-Law Partner' }, 'fam-name': { value: 'Samirul Nazrul Shaikh' }, 'fam-add-btn': { disabled: false } };
  const msgs = [], fetches = [], timers = [], store = stored ? { ['tdot_fam_job:2026-CEC-PS-085']: stored } : {};
  let loads = 0, clock = 1e12;
  const queue = responses.slice();
  const ctx = {
    CASE_REF: '2026-CEC-PS-085', JSON, encodeURIComponent,
    document: { getElementById: (id) => els[id] || null },
    window: { confirm: () => true },
    peekKey: () => '', actMsg: (id, cls, txt) => msgs.push([id, cls, txt]), loadCase: () => { loads++; },
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    setTimeout: (fn, ms) => { timers.push([fn, ms]); },
    Date: { now: () => clock },
    fetch: (url, opts) => {
      fetches.push([url, (opts && opts.method) || 'GET']);
      const next = queue.shift();
      if (!next) return Promise.reject(new Error('no scripted answer'));
      if (next === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ ok: next.status < 300, status: next.status, json: () => (next.body === undefined ? Promise.reject(new SyntaxError('Unexpected token <')) : Promise.resolve(next.body)) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(seg, ctx);
  const flush = () => new Promise((r) => setImmediate(r));
  const tick = async () => { const t = timers.shift(); if (!t) return false; t[0](); await flush(); await flush(); return true; };
  return { ctx, els, msgs, fetches, timers, store, loads: () => loads, tick, flush, advance: (ms) => { clock += ms; } };
}

test('page: 202 → "Adding…", the button stays disabled, it asks every 3 s, and the end shows the SAME message as before', async () => {
  const s = pageSandbox({ responses: [
    { status: 202, body: { ok: true, jobId: 'fam-abc', state: 'running' } },
    { status: 200, body: { ok: true, state: 'running' } },
    { status: 200, body: { ok: true, state: 'done', result: { ok: true, key: 'spouse', manifest: 'added', reseed: { created: 10 }, carry: { written: true, copied: 42, crossForm: { copied: 38 } } } } },
  ] });
  s.ctx.famAdd(); await s.flush(); await s.flush();
  assert.deepEqual(s.msgs.pop(), ['fam-msg', 'info', 'Adding… this usually takes about a minute. You can stay on this page and keep working.']);
  assert.equal(s.els['fam-add-btn'].disabled, true);
  assert.equal(s.store['tdot_fam_job:2026-CEC-PS-085'], 'fam-abc', 'remembered across a reload');
  assert.equal(s.timers[0][1], 3000);
  await s.tick();   // running
  assert.equal(s.fetches[1][0], '/admin/case-action/2026-CEC-PS-085/family/add/fam-abc');
  assert.equal(s.loads(), 0);
  await s.tick();   // done
  assert.deepEqual(s.msgs.pop(), ['fam-msg', 'ok', '✓ Added. 10 document row(s) added. Questionnaire section added. Copied 42 answer(s) the client had typed for this member in their own form into the new section. Also pre-filled 38 answer(s) into the application form section - the client must review them.']);
  assert.equal(s.loads(), 1, 'the case reloads to show the member');
  assert.equal(s.ctx.FAM_JOB, '');
  assert.ok(!('tdot_fam_job:2026-CEC-PS-085' in s.store));
  assert.equal(s.timers.length, 0, 'no more asking');
});

test('page: a failed add shows the same error as before and frees the button; a refused type never starts a job', async () => {
  const s = pageSandbox({ responses: [
    { status: 202, body: { ok: true, jobId: 'fam-abc' } },
    { status: 200, body: { ok: true, state: 'failed', code: 400, error: 'A spouse is already on this case.' } },
  ] });
  s.ctx.famAdd(); await s.flush(); await s.flush();
  await s.tick();
  assert.deepEqual(s.msgs.pop(), ['fam-msg', 'err', 'A spouse is already on this case.']);
  assert.equal(s.els['fam-add-btn'].disabled, false);
  const r = pageSandbox({ responses: [{ status: 400, body: { ok: false, error: 'Choose one of: Spouse / Common-Law Partner.' } }] });
  r.ctx.famAdd(); await r.flush(); await r.flush();
  assert.deepEqual(r.msgs.pop(), ['fam-msg', 'err', 'Choose one of: Spouse / Common-Law Partner.']);
  assert.equal(r.timers.length, 0);
  assert.equal(r.els['fam-add-btn'].disabled, false);
});

test('page: a press while ANOTHER add runs (409) is never a second add — and never told "✓ Added" for the other one: it says this add was NOT made', async () => {
  for (const state of ['done', 'failed']) {
    const s = pageSandbox({ responses: [
      { status: 409, body: { ok: false, jobId: 'fam-run', reason: 'in-progress', memberType: 'Spouse / Common-Law Partner', by: 'Deeksha Sharma', error: 'A family member is being added to this case right now (started by Deeksha Sharma) — wait for it to finish.' } },
      { status: 200, body: { ok: true, state, memberType: 'Spouse / Common-Law Partner', by: 'Deeksha Sharma', ...(state === 'done' ? { result: { ok: true, manifest: 'added', reseed: { created: 5 } } } : { code: 400, error: 'x' }) } },
    ] });
    s.ctx.famAdd(); await s.flush(); await s.flush();
    assert.equal(s.msgs.pop()[2], 'A family member is being added to this case right now (started by Deeksha Sharma) — wait for it to finish. Your add of Samirul Nazrul Shaikh was NOT made — this says when the other add ends.');
    assert.ok(!('tdot_fam_job:2026-CEC-PS-085' in s.store), 'someone else’s add is not remembered as this tab’s');
    assert.equal(s.els['fam-add-btn'].disabled, true);
    await s.tick();
    const end = s.msgs.pop();
    assert.equal(end[1], 'info');
    assert.equal(end[2], `The other add on this case (Spouse, started by Deeksha Sharma) has ${state === 'done' ? 'finished' : 'ended'}. Your add of Samirul Nazrul Shaikh was NOT made — press Add family member again if it is still needed.`);
    assert.ok(!/✓ Added/.test(end[2]));
    assert.equal(s.loads(), 1, 'the case reloads (the button comes back)');
    assert.equal(s.fetches.filter((f) => f[1] === 'POST').length, 1);
  }
});

test('page: a 409 for THIS tab\'s own add (remembered after "lost contact") is followed as its own — its real result shows, never "NOT made"', async () => {
  const s = pageSandbox({ stored: 'fam-A', responses: [
    { status: 409, body: { ok: false, jobId: 'fam-A', reason: 'in-progress', memberType: 'Dependent Child', by: 'Unidentified (shared admin key)', error: 'A family member is being added to this case right now (started by Unidentified (shared admin key)) — wait for it to finish.' } },
    { status: 200, body: { ok: true, state: 'done', memberType: 'Dependent Child', result: { ok: true, manifest: 'added', reseed: { error: 'x' } } } },
  ] });
  s.ctx.famAdd(); await s.flush(); await s.flush();
  assert.equal(s.msgs.pop()[2], 'Your earlier add on this case is still running — its result shows here when it ends.');
  assert.equal(s.ctx.FAM_FOREIGN, '');
  await s.tick();
  assert.equal(s.msgs.pop()[2], '✓ Added. Checklist re-seed failed — press Re-seed Checklist on the case. Questionnaire section added.', 'the add\'s own actionable outcome');
  assert.ok(!('tdot_fam_job:2026-CEC-PS-085' in s.store));
});

test('page: a 409 for the add this tab already follows starts nothing new; the button stays off while the request is on its way', async () => {
  const s = pageSandbox({ responses: [{ status: 202, body: { ok: true, jobId: 'fam-A' } }, { status: 409, body: { ok: false, jobId: 'fam-A', reason: 'in-progress' } }] });
  s.ctx.famAdd();
  assert.equal(s.ctx.FAM_PENDING, true);
  await s.flush(); await s.flush();
  assert.equal(s.ctx.FAM_PENDING, false);
  const timers = s.timers.length, msgs = s.msgs.length;
  s.ctx.famAdd(); await s.flush(); await s.flush();
  assert.equal(s.timers.length, timers, 'no second poll chain');
  assert.equal(s.msgs.length, msgs, 'the running message stays');
  const html = require('../src/routes/adminCase').buildCockpitHTML('2026-CEC-PS-085');
  assert.match(html, /if \(fab && \(FAM_JOB \|\| FAM_PENDING\)\) fab\.disabled = true;/);
});

test('page: following someone else\'s add, the 5-minute and lost-contact endings still say THIS add was NOT made — and this tab\'s own remembered add is kept', async () => {
  const other = { status: 409, body: { ok: false, jobId: 'fam-B', reason: 'in-progress', memberType: 'Spouse / Common-Law Partner', by: 'Deeksha Sharma', error: 'A family member is being added to this case right now (started by Deeksha Sharma) — wait for it to finish.' } };
  const slow = pageSandbox({ stored: 'fam-A', responses: [other, { status: 200, body: { ok: true, state: 'running' } }] });
  slow.ctx.famAdd(); await slow.flush(); await slow.flush();
  slow.advance(5 * 60 * 1000 + 1);
  await slow.tick();
  assert.equal(slow.msgs.pop()[2], 'The other add on this case is still running. Your add of Samirul Nazrul Shaikh was NOT made — reload later and press Add family member once the other add shows in the Family list.');
  assert.equal(slow.store['tdot_fam_job:2026-CEC-PS-085'], 'fam-A', 'this tab\'s own add is still remembered');
  const lost = pageSandbox({ responses: [other, ...Array(10).fill('network')] });
  lost.ctx.famAdd(); await lost.flush(); await lost.flush();
  for (let i = 0; i < 10; i++) await lost.tick();
  assert.equal(lost.msgs.pop()[2], 'Lost contact with the server. Your add of Samirul Nazrul Shaikh was NOT made — reload the page, check the Family list, then press Add family member if it is still needed.');
  const done = pageSandbox({ stored: 'fam-A', responses: [other, { status: 200, body: { ok: true, state: 'done', memberType: 'Spouse / Common-Law Partner', by: 'Deeksha Sharma', result: {} } }] });
  done.ctx.famAdd(); await done.flush(); await done.flush();
  await done.tick();
  assert.match(done.msgs.pop()[2], /^The other add on this case \(Spouse, started by Deeksha Sharma\) has finished\. Your add of Samirul Nazrul Shaikh was NOT made/);
  assert.equal(done.store['tdot_fam_job:2026-CEC-PS-085'], 'fam-A', 'ending someone else\'s add never erases this tab\'s own');
});

test('page: the sign-in running out while THIS tab\'s add runs keeps the add remembered and the button off — never "free to press again"', async () => {
  for (const status of [401, 403]) {
    const s = pageSandbox({ responses: [{ status: 202, body: { ok: true, jobId: 'fam-A' } }, { status, body: { ok: false, error: 'Sign in required' } }] });
    s.ctx.famAdd(); await s.flush(); await s.flush();
    await s.tick();
    const m = s.msgs.pop();
    assert.equal(m[1], 'err');
    assert.match(m[2], status === 401 ? /^Please sign in again, then reload this page — the add keeps running and its result shows after the reload\./ : /^This add can no longer be followed with your sign-in\./);
    assert.equal(s.els['fam-add-btn'].disabled, true, 'the button stays off');
    assert.equal(s.store['tdot_fam_job:2026-CEC-PS-085'], 'fam-A', 'a reload after signing in follows it');
    assert.equal(s.timers.length, 0);
  }
  // someone else's add: the sign-in message, and this tab may press again (its own add was never made)
  const f = pageSandbox({ responses: [{ status: 409, body: { ok: false, jobId: 'fam-B', reason: 'in-progress' } }, { status: 401, body: { ok: false } }] });
  f.ctx.famAdd(); await f.flush(); await f.flush();
  await f.tick();
  assert.equal(f.msgs.pop()[2], 'Please sign in again.');
  assert.equal(f.els['fam-add-btn'].disabled, false);
});

test('page: the request says it can follow a background add (a page from before the change is told to reload instead)', async () => {
  const s = pageSandbox({ responses: [{ status: 202, body: { ok: true, jobId: 'fam-abc' } }] });
  let body = null;
  const realFetch = s.ctx.fetch;
  s.ctx.fetch = (url, opts) => { if (opts && opts.method === 'POST') body = JSON.parse(opts.body); return realFetch(url, opts); };
  s.ctx.famAdd(); await s.flush(); await s.flush();
  assert.deepEqual(body, { memberType: 'Spouse / Common-Law Partner', name: 'Samirul Nazrul Shaikh', background: true });
});

test('page: the server forgot the add (restart) → "reload and check", the case reloads, nothing retried', async () => {
  const s = pageSandbox({ responses: [
    { status: 202, body: { ok: true, jobId: 'fam-abc' } },
    { status: 404, body: { ok: false, reason: 'unknown-job', error: 'The server no longer knows this add (it may have restarted). Reload the page and check the Family list and the case notes before adding again.' } },
  ] });
  s.ctx.famAdd(); await s.flush(); await s.flush();
  await s.tick();
  assert.deepEqual(s.msgs.pop(), ['fam-msg', 'err', 'The server no longer knows this add (it may have restarted). Reload the page and check the Family list and the case notes before adding again.']);
  assert.equal(s.loads(), 1);
  assert.equal(s.timers.length, 0);
  assert.equal(s.fetches.filter((f) => f[1] === 'POST').length, 1, 'never posted again');
});

test('page: hiccups (network error, a proxy page) are asked again; 10 in a row → "lost contact"; after 5 minutes → "still working" — never a retry of the add', async () => {
  const hiccups = [{ status: 202, body: { ok: true, jobId: 'fam-abc' } }, 'network', { status: 502 }, { status: 200, body: { ok: true, state: 'running' } }];
  for (let i = 0; i < 10; i++) hiccups.push('network');
  const s = pageSandbox({ responses: hiccups });
  s.ctx.famAdd(); await s.flush(); await s.flush();
  for (let i = 0; i < 13; i++) await s.tick();
  assert.deepEqual(s.msgs.pop(), ['fam-msg', 'err', 'Lost contact with the server. Reload the page and check the Family list and the case notes before adding again.']);
  assert.equal(s.timers.length, 0);
  assert.equal(s.store['tdot_fam_job:2026-CEC-PS-085'], 'fam-abc', 'the add may still be running: a reload follows it again');
  const slow = pageSandbox({ responses: [{ status: 202, body: { ok: true, jobId: 'fam-abc' } }, { status: 200, body: { ok: true, state: 'running' } }] });
  slow.ctx.famAdd(); await slow.flush(); await slow.flush();
  slow.advance(5 * 60 * 1000 + 1);
  await slow.tick();
  assert.match(slow.msgs.pop()[2], /^Still working after 5 minutes\. .*Do not add the member again until the Family list shows them\.$/);
  assert.equal(slow.store['tdot_fam_job:2026-CEC-PS-085'], 'fam-abc');
  for (const x of [s, slow]) assert.equal(x.fetches.filter((f) => f[1] === 'POST').length, 1);
});

test('page: after a reload the remembered add is followed again; render keeps the button disabled while it runs', async () => {
  const s = pageSandbox({ stored: 'fam-abc', responses: [{ status: 200, body: { ok: true, state: 'done', result: { ok: true, manifest: 'added', reseed: { created: 10 } } } }] });
  s.ctx.famResume();
  assert.deepEqual(s.msgs.pop(), ['fam-msg', 'info', 'Checking on the family member being added…']);
  await s.tick();
  assert.match(s.msgs.pop()[2], /^✓ Added\. 10 document row\(s\) added\./);
  const none = pageSandbox({ responses: [] });
  none.ctx.famResume();
  assert.equal(none.timers.length, 0, 'nothing remembered: nothing to follow');
  const html = require('../src/routes/adminCase').buildCockpitHTML('2026-CEC-PS-085');
  assert.match(html, /if \(fab\) fab\.addEventListener\('click', famAdd\);\n  if \(fab && \(FAM_JOB \|\| FAM_PENDING\)\) fab\.disabled = true;/);
  assert.match(html, /loadCase\(\);\nfamResume\(\);/);
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const seg = js.slice(js.indexOf('function famAdd()'), js.indexOf('// Create case folder'));
  assert.ok(!/[`\\]|\$\{/.test(seg), 'no backtick, ${ or backslash inside the template-literal page script');
});
