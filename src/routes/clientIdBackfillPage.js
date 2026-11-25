'use strict';

/**
 * /admin/client-ids/backfill — the Client ID backfill, run on the server (Faran 2026-11-25).
 * NAMED admins only (signed in with Monday AND on ADMIN_EMAILS) for the page and every
 * write; the two read-only answers (state, job) take the normal admin gate. Not in the staff
 * navigation; one link on the Engines page shows for named admins only.
 *
 *   GET  /admin/client-ids/backfill          the page (a named admin's Monday sign-in, else a short "who may" page)
 *   GET  /admin/client-ids/backfill/state    switch, counter, lock, the run in hand (OneDrive), the job
 *   GET  /admin/client-ids/backfill/job      the job only (cheap — polled every few seconds)
 *   POST /admin/client-ids/backfill/upload   the answered .xlsx → saved on OneDrive → 202, the check runs
 *   POST /admin/client-ids/backfill/start    { sheetFile | resume:true, automationsChecked, confirm } → 202, the run
 *   POST /admin/client-ids/backfill/unlock   { confirm: "UNLOCK" } — after a run that was cut off
 *
 * server.js registers the routes and hands in its gates (deps); the handlers live here so the
 * tests run them with fakes. The work is clientIdBackfillJobs.js.
 *
 * INLINE-SCRIPT RULE (test/inlineScripts.test.js): the page JS sits in a Node template literal —
 * no backslash, no backtick and no dollar-brace in it; strings are joined with +.
 */

const { SHARED_CSS_VARS, NAV_CSS, buildNavHeader, SHARED_AUTH_JS } = require('./adminShared');

const PAGE_WHAT = 'run the Client ID backfill';
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jobs = (deps) => deps.jobs || require('../services/clientIdBackfillJobs');

/* ───────────────────────────── handlers ───────────────────────────── */

/** The page: a named admin's Monday sign-in (the browser sends the cookie), else a short page saying who may. */
function page(req, res, deps) {
  res.set('Cache-Control', 'no-store');
  const r = deps.namedAdminCheck(req, PAGE_WHAT);
  if (!r.ok) return res.status(r.status).type('html').send(buildDeniedHTML(r.error, r.loginUrl ? `${r.loginUrl}?returnTo=${encodeURIComponent('/admin/client-ids/backfill')}` : ''));
  res.type('html').send(buildBackfillHTML());
}

async function state(req, res, deps) {
  if (!deps.resolveAdmin(req, res, 'Only an admin can see this.')) return;
  res.set('Cache-Control', 'no-store');
  try { res.json(await jobs(deps).state()); }
  catch (err) {
    console.error('[ClientIdBackfill] state failed:', String(err && err.message).slice(0, 160));
    res.status(500).json({ error: 'The state could not be read just now.' });
  }
}

function job(req, res, deps) {
  if (!deps.resolveAdmin(req, res, 'Only an admin can see this.')) return;
  res.set('Cache-Control', 'no-store');
  res.json(jobs(deps).jobState());
}

/** The gate for the upload — BEFORE multer, so a refused upload is never buffered. */
function uploadGate(req, res, next, deps) {
  const actor = deps.namedAdmin(req, res, PAGE_WHAT);
  if (!actor) return;
  if (jobs(deps)._current()) return res.status(409).json({ ok: false, reason: 'in-progress', error: 'A check or a run is going right now — wait for it to finish.' });
  req.backfillActor = actor;
  next();
}

async function upload(req, res, deps) {
  const J = jobs(deps);
  const f = req.file;
  if (!f) return res.status(400).json({ ok: false, error: 'Choose the answered check list (.xlsx) first.' });
  let saved;
  try { saved = await J.saveSheet({ buffer: f.buffer, originalName: f.originalname }); }
  catch (err) {
    if (err.badRequest) return res.status(400).json({ ok: false, error: err.message });
    console.error('[ClientIdBackfill] the sheet could not be saved:', String(err && err.message).slice(0, 160));
    return res.status(503).json({ ok: false, error: 'The sheet could not be saved on OneDrive just now — try again in a minute.' });
  }
  const r = J.startPreview({ sheetFile: saved.sheetFile, sheet: saved.sheet, by: req.backfillActor.name });
  if (!r.started) return res.status(409).json({ ok: false, reason: 'in-progress', error: 'A check or a run is going right now — wait for it to finish.' });
  res.status(202).json({ ok: true, jobId: r.job.id, sheetFile: saved.sheetFile, state: 'running' });
}

async function start(req, res, deps) {
  const actor = deps.namedAdmin(req, res, PAGE_WHAT);
  if (!actor) return;
  const b = req.body || {};
  let r;
  try {
    r = await jobs(deps).startApply({ sheetFile: String(b.sheetFile || ''), resume: b.resume === true, admin: actor.email, automationsChecked: b.automationsChecked === true, confirm: String(b.confirm || '') });
  } catch (err) {
    console.error('[ClientIdBackfill] start failed:', String(err && err.message).slice(0, 160));
    return res.status(500).json({ ok: false, error: 'The run could not be started just now.' });
  }
  if (!r.started) return res.status(r.status || 409).json({ ok: false, reason: r.reason, error: r.message, ...(r.phrase ? { phrase: r.phrase } : {}) });
  res.status(202).json({ ok: true, jobId: r.job.id, state: 'running', resume: !!r.job.resume });
}

async function unlock(req, res, deps) {
  const actor = deps.namedAdmin(req, res, PAGE_WHAT);
  if (!actor) return;
  try {
    const r = await jobs(deps).unlock({ admin: actor.email, confirm: String((req.body || {}).confirm || '') });
    if (!r.ok) return res.status(r.status || 409).json({ ok: false, reason: r.reason, error: r.message });
    res.json(r);
  } catch (err) {
    console.error('[ClientIdBackfill] unlock failed:', String(err && err.message).slice(0, 160));
    res.status(500).json({ ok: false, error: 'The lock could not be taken out just now.' });
  }
}

/* ───────────────────────────── pages ───────────────────────────── */

function buildDeniedHTML(message, signInUrl) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>TDOT — Client ID backfill</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#f0f4f8;color:#1a202c;margin:0;padding:60px 16px}
.box{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px}
h1{font-size:18px;margin:0 0 10px}p{margin:0 0 14px;line-height:1.5}a{color:#2563eb;font-weight:600}</style></head>
<body><div class="box"><h1>Client ID backfill</h1><p>${esc(message)}</p>
<p>This page is for named admins only: signed in with Monday, with an address on the admin list.</p>
${signInUrl ? `<p><a href="${esc(signInUrl)}">Sign in with Monday</a></p>` : ''}<p><a href="/admin/engines">Back to Engines</a></p></div></body></html>`;
}

function buildBackfillHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TDOT — Client ID backfill</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    ${SHARED_CSS_VARS}
    ${NAV_CSS}
    .wrap { padding: 24px var(--page-gutter) 72px; display: grid; gap: 16px; }
    h1 { font-size: 20px; font-weight: 800; color: var(--navy); }
    .lead { color: var(--muted); max-width: var(--read-max); }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--r); padding: 18px 20px; box-shadow: var(--shadow-sm); }
    .card h2 { font-size: 15px; font-weight: 700; margin-bottom: 10px; color: var(--navy); }
    .card p { margin-bottom: 8px; max-width: var(--read-max); }
    .facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
    .facts dt { color: var(--muted); font-weight: 600; }
    .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .num { font-weight: 800; font-size: 18px; }
    .grid4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 8px 0 12px; }
    .stat { background: var(--head-bg); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 10px 12px; }
    .stat .lbl { color: var(--muted); font-size: 12px; font-weight: 600; }
    button.btn { background: var(--navy); color: #fff; border: 0; border-radius: var(--r-sm); padding: 9px 16px; font-weight: 700; font-size: 14px; cursor: pointer; }
    button.btn:disabled { background: var(--light); cursor: not-allowed; }
    button.btn.warn { background: var(--st-red-solid); }
    input[type=text] { border: 1px solid var(--border); border-radius: var(--r-sm); padding: 8px 10px; font-size: 14px; min-width: 260px; font-family: inherit; }
    label.tick { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0; max-width: var(--read-max); }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
    .msg { margin-top: 8px; font-weight: 600; }
    .msg.bad { color: var(--st-red-fg); } .msg.good { color: var(--st-green-fg); }
    .phrase { font-family: ui-monospace, Menlo, monospace; background: var(--st-blue-bg); color: var(--st-blue-fg); padding: 2px 8px; border-radius: 6px; font-weight: 700; }
    table.list { border-collapse: collapse; width: 100%; margin-top: 6px; }
    table.list th { background: var(--th-bg); color: var(--th-fg); text-align: left; padding: 6px 8px; font-size: 12px; border-bottom: 1px solid var(--th-line); }
    table.list td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .bar { height: 12px; background: var(--st-grey-bg); border-radius: 999px; overflow: hidden; margin: 8px 0; }
    .bar > div { height: 100%; background: var(--st-green-solid); width: 0; }
    .hide { display: none; }
    pre.lines { background: #0f172a; color: #e2e8f0; padding: 10px 12px; border-radius: var(--r-sm); max-height: 260px; overflow: auto; font-size: 12px; white-space: pre-wrap; }
    @media (max-width: 600px) { input[type=text] { min-width: 0; width: 100%; } .facts { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
${buildNavHeader('client-ids')}
<main class="wrap">
  <div>
    <h1>Client IDs — give every past client their number</h1>
    <p class="lead">This runs the backfill on the server, from Gauri's answered check list. It can take a few hours for all clients; you can close this page while it runs and come back. Only named admins can use it.</p>
  </div>

  <section class="card" id="where">
    <h2>Where things stand</h2>
    <dl class="facts">
      <dt>Switch (CLIENT_IDS)</dt><dd id="st-switch">…</dd>
      <dt>Counter</dt><dd id="st-counter">…</dd>
      <dt>Backfill lock</dt><dd id="st-lock">…</dd>
      <dt>Run</dt><dd id="st-run">…</dd>
    </dl>
    <div class="row"><button class="btn" id="btn-refresh" type="button">Look again</button></div>
  </section>

  <section class="card" id="up-card">
    <h2>1. Upload the answered check list</h2>
    <p>Choose the .xlsx Gauri answered. The server reads the boards again and shows what would happen. Nothing is written to Monday at this step — the sheet is only saved in OneDrive (TDOT System).</p>
    <div class="row"><input type="file" id="up-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
      <button class="btn" id="btn-upload" type="button">Upload and check</button></div>
    <div class="msg" id="up-msg"></div>
  </section>

  <section class="card hide" id="pv-card">
    <h2>What would happen</h2>
    <div class="grid4" id="pv-stats"></div>
    <div id="pv-notes"></div>
  </section>

  <section class="card hide" id="go-card">
    <h2 id="go-title">2. Give the Client IDs</h2>
    <p id="go-text"></p>
    <label class="tick"><input type="checkbox" id="go-tick" /> <span>I checked that no Monday automation watches the Client ID columns, Client account (system) or the Client relation.</span></label>
    <p>Type <span class="phrase" id="go-phrase"></span> to go ahead.</p>
    <div class="row"><input type="text" id="go-typed" autocomplete="off" spellcheck="false" />
      <button class="btn" id="btn-go" type="button" disabled>Give the Client IDs</button></div>
    <div class="msg" id="go-msg"></div>
  </section>

  <section class="card hide" id="job-card">
    <h2 id="job-title">Progress</h2>
    <div id="job-body"></div>
    <div class="bar hide" id="job-bar"><div id="job-fill"></div></div>
    <div id="job-skipped"></div>
    <details><summary>Details</summary><pre class="lines" id="job-lines"></pre></details>
  </section>

  <section class="card hide" id="done-card">
    <h2>When it is done</h2>
    <div id="done-body"></div>
  </section>

  <section class="card hide" id="unlock-card">
    <h2>Unlock the counter</h2>
    <p>The counter is still locked by a backfill that is not running here. While it is locked, the app gives no new Client ID. Take the lock out only if no backfill is running anywhere. (Resume puts it back while it runs.)</p>
    <p>Type <span class="phrase" id="un-word">UNLOCK</span> to take it out.</p>
    <div class="row"><input type="text" id="un-typed" autocomplete="off" spellcheck="false" />
      <button class="btn warn" id="btn-unlock" type="button" disabled>Unlock</button></div>
    <div class="msg" id="un-msg"></div>
  </section>
</main>
<script>
${SHARED_AUTH_JS}
${PAGE_JS}
</script>
</body>
</html>`;
}

/* The page's own script (browser code, as text). No backslash, no backtick, no dollar-brace. */
const PAGE_JS = `
var BF = { st: null, job: null, sheetFile: '', phrase: '', mode: 'start', timer: null };
function el(id) { return document.getElementById(id); }
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function hdrs(json) { var h = {}; var k = peekKey(); if (k) h['X-Api-Key'] = k; if (json) h['Content-Type'] = 'application/json'; return h; }
function api(method, url, body) {
  var isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  var opts = { method: method, headers: hdrs(!!body && !isForm), credentials: 'same-origin' };
  if (body) opts.body = isForm ? body : JSON.stringify(body);
  return fetch(url, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, ok: r.ok, d: d || {} }; });
  });
}
function when(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' (Toronto)'; }
  catch (e) { return String(iso); }
}
function pill(tone, text) { return '<span class="pill ' + tone + '">' + esc(text) + '</span>'; }
function setMsg(id, text, good) { var m = el(id); m.textContent = text || ''; m.className = 'msg' + (text ? (good ? ' good' : ' bad') : ''); }
function stat(lbl, v) { return '<div class="stat"><div class="lbl">' + esc(lbl) + '</div><div class="num">' + esc(v) + '</div></div>'; }
function listTable(rows, heads) {
  if (!rows || !rows.length) return '';
  var h = '<table class="list"><tr>' + heads.map(function (x) { return '<th>' + esc(x[0]) + '</th>'; }).join('') + '</tr>';
  rows.forEach(function (r) { h += '<tr>' + heads.map(function (x) { return '<td>' + esc(r[x[1]]) + '</td>'; }).join('') + '</tr>'; });
  return h + '</table>';
}

function loadState() {
  return api('GET', '/admin/client-ids/backfill/state').then(function (r) {
    if (!r.ok) { el('st-run').textContent = r.d.message || r.d.error || 'The state could not be read.'; return; }
    BF.st = r.d; renderState(r.d); renderJob(r.d.job);
    if (r.d.running) poll();
  });
}

function renderState(st) {
  var sw = st.mode === 'on' ? pill('red', 'on') + ' — set it to report (or off) on Render before the backfill' : pill(st.mode === 'report' ? 'blue' : 'grey', st.mode) + ' — fine for the backfill';
  if (!st.configured) sw += ' · the Client ID columns are not set up';
  el('st-switch').innerHTML = sw;
  var c = st.counter || {};
  el('st-counter').textContent = c.state === 'ok' ? 'Last number given: ' + c.last : c.state === 'missing' ? 'No counter file yet — the backfill makes it' : 'Could not be read (' + (c.state || '?') + ')';
  el('st-lock').innerHTML = c.lock ? pill('amber', 'Locked') + ' by ' + esc(c.lock.by || 'a backfill') + ' since ' + esc(when(c.lock.at)) + (st.run && st.run.lockIsOurs ? ' (this page' + "'" + 's run)' : '') : pill('green', 'Not locked');
  var run = st.run;
  if (st.runError) el('st-run').textContent = st.runError;
  else if (!run) el('st-run').textContent = 'No run yet.';
  else {
    var tone = run.status === 'finished' ? 'green' : run.status === 'running' ? 'blue' : run.status === 'not started' ? 'grey' : 'amber';
    var t = pill(tone, run.status) + ' · sheet ' + esc(run.sheet);
    if (run.startedAt) t += ' · started ' + esc(when(run.startedAt));
    if (run.done || run.given) t += ' · ' + esc(run.done) + ' people done, ' + esc(run.given) + ' numbers given';
    if (run.blocks && run.blocks.length) t += ' · numbers reserved ' + run.blocks.map(function (b) { return b.first + '–' + b.last; }).join(', ');
    if (run.error) t += '<br>' + esc(run.error);
    el('st-run').innerHTML = t;
  }
  // a sheet just checked here keeps its own button (it goes on with the stopped run's numbers too)
  if (run && run.canResume && !st.running && !(BF.mode === 'start' && BF.phrase)) showGo('resume', run.resumePhrase);
  else if (BF.mode === 'resume' && !(run && run.canResume && !st.running)) el('go-card').classList.add('hide');
  el('unlock-card').classList.toggle('hide', !(c.lock && !st.running));
  el('un-word').textContent = st.unlockWord || 'UNLOCK';
  renderDone(run && run.status === 'finished' ? { summary: run.summary, healSince: run.healSince, skipped: run.skipped } : null);
}

function showGo(mode, phrase) {
  BF.mode = mode; BF.phrase = phrase;
  el('go-card').classList.remove('hide');
  el('go-title').textContent = mode === 'resume' ? 'Resume the stopped run' : '2. Give the Client IDs';
  el('go-text').textContent = mode === 'resume'
    ? 'The last run stopped before the end. Resume reads the boards again and goes on with the same answered sheet (saved in OneDrive); what is done is skipped, nobody gets a second number.'
    : 'The server reads the boards once more and stops if the number of new IDs changed. Then it runs in the background: you can leave this page.';
  el('go-phrase').textContent = phrase;
  el('btn-go').textContent = mode === 'resume' ? 'Resume' : 'Give the Client IDs';
  checkGo();
}
function checkGo() { el('btn-go').disabled = !(el('go-tick').checked && el('go-typed').value.trim() === BF.phrase && BF.phrase); }

function renderPreview(pv) {
  el('pv-card').classList.remove('hide');
  el('pv-stats').innerHTML = stat('People', pv.people) + stat('New Client IDs', pv.newIds) + stat('New client records', pv.newAccounts)
    + stat('Keep the ID they have', pv.keepExisting) + stat('First / last number', pv.newIds ? pv.firstNumber + ' – ' + pv.lastNumber : '—')
    + stat('Same person? answered Y', pv.amberAnsweredSame + ' of ' + pv.amberQuestions) + stat('No case: give an ID (Y)', pv.noCaseAnsweredGive + ' of ' + pv.noCase);
  var n = '<p>Counter now: ' + esc(pv.counter) + '.</p>';
  if (pv.unclear && pv.unclear.length) n += '<p class="msg bad">' + pv.unclear.length + ' answer(s) are not Y, N or blank. Correct them in the sheet and upload it again:</p>' + listTable(pv.unclear, [['Key', 'key'], ['Name', 'name'], ['What is wrong', 'why']]);
  if (pv.changed && pv.changed.length) n += '<p class="msg bad">' + pv.changed.length + ' answered group(s) changed since the check list was made. Make a new check list and answer it again:</p>' + listTable(pv.changed, [['Key', 'key'], ['Name', 'name'], ['What changed', 'why']]);
  if (pv.problems && pv.problems.length) n += '<p>Notes about the sheet:</p><ul>' + pv.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>';
  el('pv-notes').innerHTML = n;
  if (pv.canGo) showGo('start', pv.phrase);
  else el('go-card').classList.add('hide');
}

function renderJob(job) {
  BF.job = job;
  if (!job) return;
  var card = el('job-card');
  card.classList.remove('hide');
  el('job-lines').textContent = (job.lines || []).join(String.fromCharCode(10));
  if (job.kind === 'preview') {
    el('job-title').textContent = 'Checking the answered sheet';
    el('job-bar').classList.add('hide');
    el('job-skipped').innerHTML = '';
    if (job.state === 'running') el('job-body').innerHTML = '<p>Reading the Clients board, Client Master and the Lead Board… this takes a minute or two.</p>';
    else if (job.result && job.result.ok) { el('job-body').innerHTML = '<p>' + pill('green', 'checked') + ' ' + esc(when(job.endedAt)) + '</p>'; BF.sheetFile = job.result.sheetFile || BF.sheetFile; renderPreview(job.result); }
    else el('job-body').innerHTML = '<p class="msg bad">' + esc((job.result && job.result.message) || 'The check did not finish.') + '</p>';
    return;
  }
  el('job-title').textContent = 'Giving the Client IDs';
  var p = job.progress, r = job.result, h = '';
  if (job.state === 'running') h += '<p>' + pill('blue', job.phase === 'reading' ? 'reading the boards' : 'writing') + ' started ' + esc(when(job.startedAt)) + ' by ' + esc(job.by) + '</p>';
  else if (r && r.ok) h += '<p>' + pill('green', 'finished') + ' ' + esc(when(job.endedAt)) + '</p>';
  else h += '<p class="msg bad">' + esc((r && r.message) || 'The run did not finish.') + '</p>';
  if (r && !r.ok && r.unclear) h += listTable(r.unclear, [['Key', 'key'], ['Name', 'name'], ['What is wrong', 'why']]);
  if (r && !r.ok && r.changed) h += listTable(r.changed, [['Key', 'key'], ['Name', 'name'], ['What changed', 'why']]);
  if (p) {
    h += '<div class="grid4">' + stat('People done', p.processed + ' / ' + p.total) + stat('Client records made', p.records) + stat('Client IDs written', p.ids)
      + stat('Kept (had one)', p.kept) + stat('Cases linked', p.cases) + stat('Consultation records linked', p.leads) + stat('Copies written', p.copies) + stat('Left for the admin', p.skippedCount) + '</div>';
    if (p.alreadyDone) h += '<p>' + esc(p.alreadyDone) + ' people were done by an earlier run (skipped).</p>';
    el('job-bar').classList.remove('hide');
    el('job-fill').style.width = (p.total ? Math.round(100 * p.processed / p.total) : 100) + '%';
  } else el('job-bar').classList.add('hide');
  el('job-body').innerHTML = h;
  el('job-skipped').innerHTML = p && p.skipped && p.skipped.length ? '<p>Left for the admin (look at these by hand):</p>' + listTable(p.skipped, [['Key', 'key'], ['Name', 'name'], ['Why', 'why']]) : '';
  if (r && r.ok) renderDone({ summary: r, healSince: r.healSince, skipped: r.skipped });
}

function renderDone(d) {
  var card = el('done-card');
  if (!d || !d.summary) { card.classList.add('hide'); return; }
  card.classList.remove('hide');
  var s = d.summary, h = '<div class="grid4">' + stat('Client records made', s.records) + stat('Client IDs given', s.ids) + stat('Kept', s.kept)
    + stat('Cases linked', s.cases) + stat('Consultation records linked', s.leads) + stat('Copies written', s.copies) + stat('Left for the admin', typeof s.skipped === 'number' ? s.skipped : s.skippedCount) + '</div>';
  if (s.unused) h += '<p>' + esc(s.unused) + ' reserved number(s) were not needed — gaps in the numbers are normal.</p>';
  h += '<p><b>Next, on Render:</b></p><ol>';
  h += '<li>Look at the Client ID check: <a href="/admin/client-ids/audit" target="_blank" rel="noopener">/admin/client-ids/audit</a>.</li>';
  if (d.healSince) h += '<li>Set <b>CLIENT_IDS_HEAL_SINCE</b> to <span class="phrase">' + esc(d.healSince.iso) + '</span> — that is ' + esc(d.healSince.toronto) + ', when the backfill STARTED. People who came while it ran then get theirs from the hourly check.</li>';
  h += '<li>Then set <b>CLIENT_IDS</b> to <span class="phrase">on</span>.</li></ol>';
  el('done-body').innerHTML = h;
}

function poll() {
  if (BF.timer) clearTimeout(BF.timer);
  BF.timer = setTimeout(function () {
    api('GET', '/admin/client-ids/backfill/job').then(function (r) {
      if (!r.ok) { BF.timer = null; poll(); return; }
      renderJob(r.d.job);
      if (r.d.running) poll(); else { BF.timer = null; loadState(); }
    }, function () { poll(); });
  }, 3000);
}

function doUpload() {
  var f = el('up-file').files && el('up-file').files[0];
  if (!f) { setMsg('up-msg', 'Choose the answered check list (.xlsx) first.'); return; }
  var fd = new FormData(); fd.append('sheet', f);
  el('btn-upload').disabled = true; setMsg('up-msg', 'Uploading…', true);
  el('go-card').classList.add('hide'); el('pv-card').classList.add('hide');
  api('POST', '/admin/client-ids/backfill/upload', fd).then(function (r) {
    el('btn-upload').disabled = false;
    if (r.status !== 202) { setMsg('up-msg', r.d.error || r.d.message || 'The upload did not work.'); return; }
    BF.sheetFile = r.d.sheetFile; setMsg('up-msg', 'Saved in OneDrive as ' + r.d.sheetFile + '. Checking…', true);
    poll();
  }, function () { el('btn-upload').disabled = false; setMsg('up-msg', 'The upload did not reach the server.'); });
}

function doGo() {
  var body = { automationsChecked: el('go-tick').checked, confirm: el('go-typed').value.trim() };
  if (BF.mode === 'resume') body.resume = true; else body.sheetFile = BF.sheetFile;
  el('btn-go').disabled = true; setMsg('go-msg', 'Starting…', true);
  api('POST', '/admin/client-ids/backfill/start', body).then(function (r) {
    if (r.status !== 202) { setMsg('go-msg', r.d.error || r.d.message || 'The run did not start.'); checkGo(); return; }
    setMsg('go-msg', 'Started. You can leave this page; come back to see the progress.', true);
    el('go-card').classList.add('hide');
    poll();
  }, function () { setMsg('go-msg', 'The request did not reach the server.'); checkGo(); });
}

function doUnlock() {
  el('btn-unlock').disabled = true;
  api('POST', '/admin/client-ids/backfill/unlock', { confirm: el('un-typed').value.trim() }).then(function (r) {
    setMsg('un-msg', r.d.message || r.d.error || (r.ok ? 'Done.' : 'It did not work.'), r.ok);
    el('un-typed').value = '';
    loadState();
  }, function () { setMsg('un-msg', 'The request did not reach the server.'); });
}

el('btn-refresh').addEventListener('click', loadState);
el('btn-upload').addEventListener('click', doUpload);
el('go-tick').addEventListener('change', checkGo);
el('go-typed').addEventListener('input', checkGo);
el('btn-go').addEventListener('click', doGo);
el('un-typed').addEventListener('input', function () { el('btn-unlock').disabled = el('un-typed').value.trim() !== el('un-word').textContent; });
el('btn-unlock').addEventListener('click', doUnlock);
startClock();
if (peekKey()) checkApiStatus();
loadState();
`;

module.exports = { page, state, job, uploadGate, upload, start, unlock, buildBackfillHTML, buildDeniedHTML, PAGE_JS, PAGE_WHAT };
