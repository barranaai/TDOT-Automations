'use strict';

/**
 * The two cockpit routes behind the three reminder buttons (block 2, step B):
 *   GET  /admin/case-action/:caseRef/reminder/preview?level=1|2|3[&lastDay=]
 *   POST /admin/case-action/:caseRef/reminder  { level, subject, body, extra, lastDay }
 *   POST /admin/case-action/:caseRef/reminder/render  { the same } → the finished email for the
 *        pop-up (Faran 2026-11-07): read-only, links switched off, 30 a minute per person per case
 *
 * server.js registers them and hands in its own gate helpers (resolveCaseForWrite:
 * sign-in + assigned-or-admin, a fresh case overview; staffActor: the Monday
 * identity, never a typed name) — the handlers live here so they can be run in
 * tests with fakes. The service (docReminderService) decides everything else:
 * the live-case / lock / email / access-code gate, the fresh missing list, the
 * record (claim note before the email, failure note after), the race.
 *
 * One send per case per minute from here (the sponsor route's cool-down), so a
 * double-click cannot email twice. The failure wording staff see is neutral —
 * never "spam", never "credits" (Faran 2026-11-02).
 */

const COOLDOWN_MS = 60 * 1000;
const SUBJECT_MAX = 200, BODY_MAX = 6000, EXTRA_MAX = 1000;
const _lastSendAt = new Map();   // caseRef (upper) → ms of the last real send

const str = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').slice(0, max);

/** A refusal from the service → the status + { ok:false, reason, error } the page reads. */
function answerError(res, err, caseRef) {
  if (err && err.refused) return res.status(err.status).json({ ok: false, reason: err.reason, error: err.message });
  if (err && err.sendFailed) return res.status(502).json({ ok: false, reason: 'send-failed', error: err.message });
  console.error(`[DocReminders] ${caseRef} route failed:`, err && (err.stack || err.message));
  return res.status(500).json({ ok: false, error: 'Internal server error' });
}

/** GET preview — read-only: the filled template, the list, the warnings, the record. */
async function preview(req, res, deps) {
  const caseRef = (req.params.caseRef || '').trim();
  const ctx = await deps.resolveCaseForWrite(req, res, caseRef);
  if (!ctx) return;
  const svc = deps.service || require('../services/docReminderService');
  res.set('Cache-Control', 'no-store');
  try {
    const p = await svc.previewStaffReminder({ overview: ctx.overview, level: req.query.level, lastDay: req.query.lastDay, actor: deps.staffActor(req) });   // {StaffName} = the sign-in
    res.json({ ok: true, ...p });
  } catch (err) { answerError(res, err, caseRef); }
}

/** POST send — the gate again, the cool-down, then the service's claim → race → email → note. */
async function send(req, res, deps) {
  const caseRef = (req.params.caseRef || '').trim();
  const ctx = await deps.resolveCaseForWrite(req, res, caseRef);
  if (!ctx) return;
  const svc = deps.service || require('../services/docReminderService');
  const body = req.body || {};
  let level;
  try { level = svc.parseLevel(body.level); } catch (err) { return answerError(res, err, caseRef); }
  const subject = str(body.subject, SUBJECT_MAX + 1), text = str(body.body, BODY_MAX + 1), extra = str(body.extra, EXTRA_MAX + 1);
  if (subject.length > SUBJECT_MAX) return res.status(400).json({ ok: false, error: `The subject is too long (max ${SUBJECT_MAX} characters).` });
  if (text.length > BODY_MAX) return res.status(400).json({ ok: false, error: `The text is too long (max ${BODY_MAX} characters).` });
  if (extra.length > EXTRA_MAX) return res.status(400).json({ ok: false, error: `The extra line is too long (max ${EXTRA_MAX} characters).` });
  // Monday's case-reference match is not case-sensitive: one slot per case.
  const key = caseRef.toUpperCase();
  const wait = COOLDOWN_MS - (Date.now() - (_lastSendAt.get(key) || 0));
  if (wait > 0) return res.status(429).json({ ok: false, reason: 'cooldown', error: `A reminder was sent for this case less than a minute ago — try again in ${Math.ceil(wait / 1000)}s.` });
  let r;
  try {
    r = await svc.sendStaffReminder({
      overview: ctx.overview, level, subject, body: text, extra,
      lastDay: String(body.lastDay == null ? '' : body.lastDay).trim().slice(0, 10),
      actor: deps.staffActor(req),   // the Monday sign-in, else the shared-key placeholder — never a name from the body
    });
  } catch (err) { return answerError(res, err, caseRef); }
  _lastSendAt.set(key, Date.now());   // only a real send starts the cool-down
  console.log(`[DocReminders] ${caseRef}: reminder ${r.level} sent to ${r.to} by ${(ctx.viewer && ctx.viewer.email) || 'admin'}`);
  res.json({ ok: true, noted: r.noted, to: r.to, level: r.level, day: r.day, lastDay: r.lastDay || '', warnings: r.warnings || [] });
}

// ─── The pop-up's live view of the email (Faran 2026-11-07) ──────────────────
// Every pause in typing asks for the email again. Each ask reads the case like a preview
// does (the case, the checklist, the notes), so it is limited per person per case. A full
// minute is refused BEFORE the case read (a flood never reaches Monday); an ask is counted
// only once the sign-in let it through, so a stranger can never use up a staffer's minute.
// In memory: a restart forgets it.
const RENDER_PER_MIN = 30, RENDER_WINDOW_MS = 60 * 1000;
// The size cap is checked HERE: the app-wide JSON parser (2 MB) reads the body before any
// route-level parser could, so a limit on the route alone would never apply (review 2026-11-07).
const RENDER_MAX_BYTES = 64 * 1024;
const _renders = new Map();   // "who|CASE" → ms of the asks in the last minute

const recentRenders = (key, now) => (_renders.get(key) || []).filter((t) => now - t < RENDER_WINDOW_MS);
/** 0 when this person's minute for this case still has room, else the seconds to wait. */
function renderWait(key, now) {
  const recent = recentRenders(key, now);
  return recent.length >= RENDER_PER_MIN ? Math.max(1, Math.ceil((RENDER_WINDOW_MS - (now - recent[0])) / 1000)) : 0;
}
function countRender(key, now) {
  _renders.set(key, [...recentRenders(key, now), now]);
  if (_renders.size > 2000) for (const [k, v] of _renders) if (!v.length || now - v[v.length - 1] >= RENDER_WINDOW_MS) _renders.delete(k);
}

/** POST render — never writes, never sends, never notes, no cool-down; a text problem is a 200 with problems. */
async function render(req, res, deps) {
  const caseRef = (req.params.caseRef || '').trim();
  res.set('Cache-Control', 'no-store');
  const bytes = Math.max(req.rawBody ? req.rawBody.length : 0, Number(req.headers && req.headers['content-length']) || 0);
  if (bytes > RENDER_MAX_BYTES) return res.status(413).json({ ok: false, reason: 'too-large', error: 'The text is too long for the email view.' });
  // a caller with no sign-in and no key hears 401 first, exactly as preview and send answer — never a 429
  // that would tell a stranger the case exists and is being worked on
  if (!deps.resolveViewer(req)) return res.status(401).json({ ok: false, error: 'Sign in required', loginUrl: '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard' });
  // who: the Monday sign-in; without one, the shared admin key (one slot for everyone using it)
  const actor = deps.staffActor(req);
  const key = `${actor && actor.verified && actor.email ? `staff:${String(actor.email).toLowerCase()}` : 'key'}|${caseRef.toUpperCase()}`;
  const wait = renderWait(key, Date.now());
  // retryAfter: the pop-up asks once more by itself after the wait, so the line below is true
  if (wait > 0) return res.status(429).json({ ok: false, reason: 'too-many', retryAfter: wait, error: `The email view was updated too often — it updates again in ${wait}s. Nothing you typed is lost.` });
  const ctx = await deps.resolveCaseForWrite(req, res, caseRef);
  if (!ctx) return;
  countRender(key, Date.now());
  const svc = deps.service || require('../services/docReminderService');
  const body = req.body || {};
  const problem = (message) => res.json({ ok: true, html: '', subject: '', warnings: [], problems: [message] });
  const subject = str(body.subject, SUBJECT_MAX + 1), text = str(body.body, BODY_MAX + 1), extra = str(body.extra, EXTRA_MAX + 1);
  if (subject.length > SUBJECT_MAX) return problem(`The subject is too long (max ${SUBJECT_MAX} characters).`);
  if (text.length > BODY_MAX) return problem(`The text is too long (max ${BODY_MAX} characters).`);
  if (extra.length > EXTRA_MAX) return problem(`The extra line is too long (max ${EXTRA_MAX} characters).`);
  try {
    const r = await svc.renderStaffReminder({
      overview: ctx.overview, level: body.level, subject, body: text, extra,
      lastDay: String(body.lastDay == null ? '' : body.lastDay).trim().slice(0, 10),
      actor,   // the sign-off is the verified sign-in, exactly as the send signs — never a name from the body
    });
    res.json({ ok: true, html: r.html || '', subject: r.subject || '', warnings: r.warnings || [], problems: r.problems || [] });
  } catch (err) { answerError(res, err, caseRef); }
}

module.exports = { preview, send, render, COOLDOWN_MS, SUBJECT_MAX, BODY_MAX, EXTRA_MAX, RENDER_PER_MIN, RENDER_MAX_BYTES, _lastSendAt, _renders,
  _resetForTests: () => { _lastSendAt.clear(); _renders.clear(); } };
