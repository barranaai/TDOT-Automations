'use strict';

/**
 * Gauri's 19 questions, answered on a private link that needs no sign-in (Faran 2026-11-19).
 *
 *   GET /share/questions/<token>                 → src/share/questions.html (the form)
 *   GET /share/questions/<token>/answers         → { answers: { <qid>: { choice, note, at } }, savedAt }
 *   PUT /share/questions/<token>/answers/<qid>   body { choice, note } → { ok: true, at }
 *   GET /admin/share/questions/answers[?format=text]   NAMED admins only: the answers in plain words
 *
 * Rules (do not undo):
 *  - The token itself is NOT in the code or the repo: only its SHA-256 is. A wrong token falls through
 *    to the server's ordinary 404 on all three public routes (GET and PUT alike), the same as a page
 *    that does not exist, so the path reveals nothing.
 *  - Never linked from the dashboard, the nav bar or any other page. Even the form does not spell its
 *    own address: its script builds the two calls from location.pathname. test/shareQuestions.test.js
 *    checks both.
 *  - Kept out of search engines and never leaks the link to the font host (same headers as the shared
 *    checklist). The form's one inline script runs by its SHA-256 in the CSP, computed from the file
 *    when it is first read; scripts never get 'unsafe-inline'.
 *  - The link is unauthenticated, so every write is validated against the ONE question list
 *    (src/share/questionsList.js), bounded (note ≤ 4,000 characters, body ≤ 16 KB) and rate-limited
 *    (per address and overall, in memory). A refusal never repeats what was sent.
 *  - The log never carries the note text or the token: the question id and lengths only.
 *  - Storage is ONE JSON file in the app's OneDrive, written with its eTag (read → merge this one
 *    question → write If-Match; a conflict re-reads and retries). Every read and write goes through
 *    one in-process queue, one at a time. A file that is damaged or has an unknown shape is NEVER
 *    written over: the write is refused (503) and the form keeps the answer on the device.
 *  - To retire the link: change TOKEN_SHA256 (a new link) and deploy. The answers file stays.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { QUESTIONS } = require('../share/questionsList');
const { namedAdminCheck } = require('../utils/staffIdentity');

const TOKEN_SHA256 = '122b22ed0c462a7e8c60de4babb0190499e52aa461f069e9a45050f9e0e12021';
const FILE = path.join(__dirname, '..', 'share', 'questions.html');
const STORE_PATH = 'TDOT System/gauri-questions-answers.json';

const IDS = Object.freeze(QUESTIONS.map((q) => q.id));
const BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));
const OTHER = 'other';
const NOTE_MAX = 4000;
const BODY_MAX = 16 * 1024;
const HISTORY_MAX = 200;
const CACHE_MS = 15 * 1000;          // GET answers: at most one OneDrive read per 15 s
const FAIL_MS = 5 * 1000;            // after a failed read, the next few seconds answer 503 without asking again
const CONFLICT_RETRIES = 3;
const LIMITS = Object.freeze({ ipMax: 60, ipWindowMs: 10 * 60 * 1000, allMax: 600, allWindowMs: 60 * 60 * 1000 });

const SAVE_FAILED = 'Could not save right now — please try again.';
const LOAD_FAILED = 'Could not load the saved answers right now — please try again.';
const TOO_MANY = 'Too many changes at once — please wait a moment and try again.';

// Sent with every answer of the three public routes.
const API_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

// ─── The page ─────────────────────────────────────────────────────────────────

let _page = null;
/** { html, scriptHash }: the form and the base64 SHA-256 of its one inline script. No page ('') when the
 *  file is missing or does not hold exactly one plain inline script — then the route is an ordinary 404. */
function pageInfo() {
  if (_page === null) {
    let html = '';
    try { html = fs.readFileSync(FILE, 'utf8'); } catch (_) { html = ''; }
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
    const m = scripts.length === 1 ? /^<script>([\s\S]*?)<\/script>$/.exec(scripts[0]) : null;
    _page = m && !html.includes('\r')
      ? { html, scriptHash: crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') }
      : { html: '', scriptHash: '' };
  }
  return _page;
}
function page() { return pageInfo().html; }

/** The exact headers serve() sends with the form. */
function pageHeaders() {
  return {
    ...API_HEADERS,
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; "
      + `script-src 'sha256-${pageInfo().scriptHash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}

// ─── Validation (one list; a refusal never repeats the input) ──────────────────

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Line ends → \n, a tab → a space, every other control character dropped, then trimmed. */
function cleanNote(s) {
  return String(s).replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '').trim();
}

function choiceOk(q, choice) {
  return choice === '' || choice === OTHER || q.opts.some((o) => o[0] === choice);
}

/** @returns {{ok:true, qid:string, choice:string, note:string} | {ok:false, error:string}} */
function validate(req) {
  const bad = (error) => ({ ok: false, error });
  const headers = (req && req.headers) || {};
  if (!/^application\/json\s*(;|$)/i.test(String(headers['content-type'] || ''))) return bad('Send the answer as JSON.');
  const size = Buffer.isBuffer(req.rawBody) ? req.rawBody.length : Number(headers['content-length'] || 0);
  if (!(size <= BODY_MAX)) return bad('That is too long to save.');
  const body = req.body;
  if (!isPlainObject(body)) return bad('Send the answer as JSON.');
  const qid = req.params && req.params.qid;
  const q = typeof qid === 'string' ? BY_ID.get(qid) : undefined;
  if (!q) return bad('Unknown question.');
  const choice = body.choice === undefined ? '' : body.choice;
  if (typeof choice !== 'string' || !choiceOk(q, choice)) return bad('Unknown answer.');
  const rawNote = body.note === undefined ? '' : body.note;
  if (typeof rawNote !== 'string') return bad('The note must be text.');
  const note = cleanNote(rawNote);
  if (note.length > NOTE_MAX) return bad('The note is too long — keep it under 4,000 characters.');
  return { ok: true, qid: q.id, choice, note };
}

// ─── Small helpers ────────────────────────────────────────────────────────────

/** The caller's address: the LAST X-Forwarded-For entry (the proxy appends the true peer; the first is whatever the client sent). */
function clientIp(req) {
  const xff = String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || (req && req.ip) || 'unknown';
}

/** Why storage failed, for the log: a kind, an HTTP status and a Graph code — never free text. */
function reason(err) {
  if (!err) return 'error';
  if (err.corrupt) return 'damaged file';
  if (err.conflict) return 'changed meanwhile';
  const m = String(err.message || '');
  const status = (/status code (\d{3})/.exec(m) || [])[1];
  const code = (/"code":"([A-Za-z0-9_.]{1,40})"/.exec(m) || [])[1];
  return [err.transient ? 'temporary' : '', status ? `HTTP ${status}` : '', code || ''].filter(Boolean).join(' ') || 'error';
}

/** In-memory limits on writes: per address and overall. take() → 0 when allowed (and counted), else the seconds to wait. */
function makeLimiter(limits, now) {
  const byIp = new Map();
  let all = [];
  const waitFor = (hits, max, windowMs, t) => (hits.length < max ? 0 : Math.max(1, Math.ceil((hits[hits.length - max] + windowMs - t) / 1000)));
  return {
    take(ip) {
      const t = now();
      all = all.filter((x) => t - x < limits.allWindowMs);
      const mine = (byIp.get(ip) || []).filter((x) => t - x < limits.ipWindowMs);
      const wait = Math.max(waitFor(mine, limits.ipMax, limits.ipWindowMs, t), waitFor(all, limits.allMax, limits.allWindowMs, t));
      if (wait) { if (mine.length) byIp.set(ip, mine); else byIp.delete(ip); return wait; }
      mine.push(t); all.push(t); byIp.set(ip, mine);
      if (byIp.size > 2000) for (const [k, v] of byIp) if (!v.some((x) => t - x < limits.ipWindowMs)) byIp.delete(k);
      return 0;
    },
    size: () => byIp.size,
  };
}

// ─── What the answers look like going out ─────────────────────────────────────

/** One stored answer, as strings only; an option key the list no longer has reads as no choice. */
function answerOf(q, raw) {
  if (!isPlainObject(raw)) return null;
  const choice = typeof raw.choice === 'string' && choiceOk(q, raw.choice) ? raw.choice : '';
  return { choice, note: typeof raw.note === 'string' ? raw.note.slice(0, NOTE_MAX) : '', at: typeof raw.at === 'string' ? raw.at : '' };
}

/** GET answers: only the 19 known questions, and when the newest one was saved. */
function view(data) {
  const answers = {};
  let savedAt = null;
  for (const q of QUESTIONS) {
    const a = answerOf(q, data.answers[q.id]);
    if (!a) continue;
    answers[q.id] = a;
    if (a.at && (!savedAt || a.at > savedAt)) savedAt = a.at;
  }
  return { answers, savedAt };
}

function optionText(q, choice) {
  if (!choice) return '';
  if (choice === OTHER) return 'Something else (see note)';
  const o = q.opts.find((x) => x[0] === choice);
  return o ? `(${o[0]}) ${o[1]}` : '';
}

/** The admin read: every question with its title and the chosen option in plain words, plus counts. */
function report(data) {
  const v = view(data);
  const questions = QUESTIONS.map((q, i) => {
    const a = v.answers[q.id] || { choice: '', note: '', at: '' };
    return { n: i + 1, id: q.id, title: q.title, choice: a.choice, answer: optionText(q, a.choice), suggested: !!a.choice && a.choice === q.sug, note: a.note, at: a.at || null };
  });
  return {
    answered: questions.filter((x) => x.choice).length,
    total: QUESTIONS.length,
    withNote: questions.filter((x) => x.note).length,
    savedAt: v.savedAt,
    questions,
  };
}

const TORONTO = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' });
function torontoTime(iso) {
  const d = new Date(iso);
  return iso && !Number.isNaN(d.getTime()) ? `${TORONTO.format(d)} (Toronto)` : '';
}

/** The same report as a plain-text list. */
function reportText(r) {
  const lines = [`Gauri's answers: ${r.answered} of ${r.total} answered`, r.savedAt ? `Last saved: ${torontoTime(r.savedAt)}` : 'Nothing saved yet.', ''];
  for (const x of r.questions) {
    lines.push(`${x.n}. ${x.title} [${x.id}]`);
    lines.push(`   Answer: ${x.answer ? x.answer + (x.suggested ? ' (the suggestion)' : '') : '(not answered)'}`);
    if (x.note) lines.push(`   Note: ${x.note.split('\n').join('\n         ')}`);
    if (x.at && (x.choice || x.note)) lines.push(`   Saved: ${torontoTime(x.at)}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── I/O (stubbed in tests) ───────────────────────────────────────────────────

const io = {
  now: () => Date.now(),
  /** → { data, etag } | null (no file yet); throws err.corrupt for a damaged file. */
  read: () => require('./oneDriveService').readJsonFile(STORE_PATH),
  /** With etag: only over that version. Without: only when there is no file yet. A conflict throws err.conflict. */
  write: (data, etag) => require('./oneDriveService').writeJsonFile(STORE_PATH, data, { etag }),
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
};

// ─── One instance: token, store, limits, handlers ─────────────────────────────

/**
 * The real routes use the instance made at the bottom of this file. Tests make their own, with the hash of
 * a made-up token and a fake store (the real token is not in the repo, so no test can pass the real check).
 */
function create({ tokenSha256 = TOKEN_SHA256, io: ioSeam = io, limits = LIMITS } = {}) {
  const limiter = makeLimiter(limits, () => ioSeam.now());
  let cache = null;        // { at, data }: the file as last read or written
  let failed = null;       // { at, err }: the last read failure, remembered for FAIL_MS
  let pendingRead = null;  // one queued read shared by every GET waiting for it
  let queue = Promise.resolve();

  /** True only for the shared token (constant-time compare of the hashes). */
  function tokenOk(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return false;
    const got = crypto.createHash('sha256').update(token).digest();
    const want = Buffer.from(tokenSha256, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  /** A miss: the server's ordinary 404, nothing set, nothing sent. */
  const miss = (res, next) => (typeof next === 'function' ? next() : res.status(404).type('text').send('Not found'));

  /** One job at a time, in order; a failed job never blocks the next. */
  function enqueue(job) {
    const run = queue.then(job, job);
    queue = run.then(() => {}, () => {});
    return run;
  }

  /** The file as it is now. No file yet → an empty store (created by the first write). A damaged or
   *  unknown-shaped file throws err.corrupt, so nothing is ever written over it. */
  async function readFresh() {
    const rec = await ioSeam.read();
    if (!rec) return { data: { version: 1, answers: {}, history: [] }, etag: '' };
    const d = rec.data;
    if (!isPlainObject(d) || d.version !== 1 || !isPlainObject(d.answers) || (d.history !== undefined && !Array.isArray(d.history))) {
      const e = new Error('the answers file has an unexpected shape'); e.corrupt = true; throw e;
    }
    return { data: d, etag: rec.etag || '' };
  }

  const remember = (data) => { cache = { at: ioSeam.now(), data }; failed = null; };
  const cacheFresh = () => { const t = ioSeam.now(); return !!cache && t >= cache.at && t - cache.at < CACHE_MS; };

  /** The stored answers for a GET: the short cache, else ONE queued read shared by everyone waiting. */
  function cachedData() {
    if (cacheFresh()) return Promise.resolve(cache.data);
    const t = ioSeam.now();
    if (failed && t >= failed.at && t - failed.at < FAIL_MS) return Promise.reject(failed.err);
    if (!pendingRead) {
      pendingRead = enqueue(async () => {
        if (cacheFresh()) return cache.data;                 // a write just before this read refreshed it
        try { const r = await readFresh(); remember(r.data); return r.data; }
        catch (err) { failed = { at: ioSeam.now(), err }; throw err; }
      });
      const done = () => { pendingRead = null; };
      pendingRead.then(done, done);
    }
    return pendingRead;
  }

  /** A read that never uses the cache (the admin read), in the same queue. */
  function freshData() {
    return enqueue(async () => { const r = await readFresh(); remember(r.data); return r.data; });
  }

  /**
   * Save ONE question: read → merge → write with the eTag; a conflict re-reads and retries (up to
   * CONFLICT_RETRIES times). Nothing to change → no write. Any failure throws and leaves the file as it was.
   * @returns {Promise<{at:string, changed:boolean}>}
   */
  function save(qid, choice, note) {
    return enqueue(async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          const { data, etag } = await readFresh();
          const cur = isPlainObject(data.answers[qid]) ? data.answers[qid] : null;
          const at = new Date(ioSeam.now()).toISOString();
          if (cur ? (cur.choice === choice && cur.note === note && typeof cur.at === 'string') : (!choice && !note)) {
            remember(data);
            return { at: cur ? cur.at : at, changed: false };
          }
          const next = {
            ...data,
            version: 1,
            answers: { ...data.answers, [qid]: { choice, note, at } },
            history: [...(data.history || []), { qid, choice, noteLen: note.length, at }].slice(-HISTORY_MAX),
          };
          try { await ioSeam.write(next, etag); }
          catch (err) { if (err && err.conflict && attempt < CONFLICT_RETRIES) continue; throw err; }
          remember(next);
          return { at, changed: true };
        }
      } catch (err) {
        cache = null;      // the write may or may not have landed: the next GET reads the file again
        throw err;
      }
    });
  }

  // ── Handlers ──

  /** GET the form. A miss falls through to the server's ordinary 404 (next()). */
  function serve(req, res, next) {
    const html = tokenOk(req.params && req.params.token) ? page() : '';
    if (!html) return miss(res, next);
    res.set(pageHeaders()).type('html').send(html);
  }

  /** GET the stored answers. */
  async function getAnswers(req, res, next) {
    if (!tokenOk(req.params && req.params.token)) return miss(res, next);
    res.set(API_HEADERS);
    try {
      res.status(200).json(view(await cachedData()));
    } catch (err) {
      ioSeam.warn(`[ShareQuestions] answers could not be read (${reason(err)})`);
      res.status(503).json({ error: LOAD_FAILED });
    }
  }

  /** PUT one question's answer. */
  async function putAnswer(req, res, next) {
    if (!tokenOk(req.params && req.params.token)) return miss(res, next);
    res.set(API_HEADERS);
    const wait = limiter.take(clientIp(req));
    if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: TOO_MANY }); }
    const v = validate(req);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const sizes = `choice ${v.choice.length}, note ${v.note.length}`;
    try {
      const r = await save(v.qid, v.choice, v.note);
      ioSeam.log(`[ShareQuestions] ${v.qid} ${r.changed ? 'saved' : 'unchanged'} (${sizes})`);
      res.status(200).json({ ok: true, at: r.at });
    } catch (err) {
      ioSeam.warn(`[ShareQuestions] ${v.qid} NOT saved (${reason(err)}; ${sizes})`);
      res.status(503).json({ error: SAVE_FAILED });
    }
  }

  /** GET /admin/share/questions/answers — NAMED admins only (signed in with Monday AND on ADMIN_EMAILS). */
  async function adminAnswers(req, res, deps) {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Content-Type-Options': 'nosniff' });
    const r = namedAdminCheck(deps.staff(req), deps.isAdminEmail, { what: 'read the answers to the questions', hint: '' });
    if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.loginUrl ? { loginUrl: r.loginUrl } : {}) });
    const q = req.query || {};
    const format = typeof q.format === 'string' ? q.format.trim().toLowerCase() : '';
    if (format && format !== 'json' && format !== 'text') return res.status(400).json({ error: 'format must be json or text.' });
    let out;
    try { out = report(await freshData()); }
    catch (err) {
      ioSeam.warn(`[ShareQuestions] admin read failed (${reason(err)})`);
      return res.status(503).json({ error: 'The answers could not be read right now — please try again.' });
    }
    if (format === 'text') return res.status(200).type('text/plain').send(reportText(out));
    res.status(200).json(out);
  }

  return { tokenOk, serve, getAnswers, putAnswer, adminAnswers, save, limiter };
}

const live = create();

module.exports = {
  // the real routes (server.js)
  serve: live.serve, getAnswers: live.getAnswers, putAnswer: live.putAnswer, adminAnswers: live.adminAnswers, tokenOk: live.tokenOk,
  // the pieces, for tests
  create, io, page, pageInfo, pageHeaders, validate, cleanNote, view, report, reportText, makeLimiter, clientIp, reason,
  QUESTIONS, IDS, TOKEN_SHA256, FILE, STORE_PATH, API_HEADERS, LIMITS, NOTE_MAX, BODY_MAX, HISTORY_MAX, CACHE_MS, FAIL_MS, CONFLICT_RETRIES,
};
