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
 *
 * Speed (Faran 2026-11-07, "the popup opening time is long"): the preview and the email
 * view read the case through caseCockpitService.getReminderFacts (the gate + email facts,
 * without the family / lead / sponsor reads the pop-up never uses); the preview's answer
 * carries the first email view; and the email view reuses what the preview prepared
 * (docReminderPrepCache). The SEND keeps the full fresh read, unchanged.
 */

const { SUBJECT_MAX, BODY_MAX, EXTRA_MAX } = require('../services/docReminderService');
const prepCache = require('../services/docReminderPrepCache');
const COOLDOWN_MS = 60 * 1000;
const _lastSendAt = new Map();   // caseRef (upper) → ms of the last real send

/** The pop-up's case read (preview + email view): the facts it needs, read in parallel. */
const readFacts = (deps) => deps.readFacts || require('../services/caseCockpitService').getReminderFacts;

const str = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').slice(0, max);

/** A refusal from the service → the status + { ok:false, reason, error } the page reads. */
function answerError(res, err, caseRef) {
  if (err && err.refused) return res.status(err.status).json({ ok: false, reason: err.reason, error: err.message });
  if (err && err.sendFailed) return res.status(502).json({ ok: false, reason: 'send-failed', error: err.message });
  console.error(`[DocReminders] ${caseRef} route failed:`, err && (err.stack || err.message));
  return res.status(500).json({ ok: false, error: 'Internal server error' });
}

/**
 * GET preview — read-only: the filled template, the list, the warnings, the record, and
 * the first email view (`email`, so the pop-up needs no second ask to show it). What it
 * prepared is kept for the email view under `prepHandle` (docReminderPrepCache).
 */
async function preview(req, res, deps) {
  const caseRef = (req.params.caseRef || '').trim();
  const ctx = await deps.resolveCaseForWrite(req, res, caseRef, { read: readFacts(deps) });
  if (!ctx) return;
  const svc = deps.service || require('../services/docReminderService');
  res.set('Cache-Control', 'no-store');
  try {
    let prepared = null;
    const p = await svc.previewStaffReminder({ overview: ctx.overview, level: req.query.level, lastDay: req.query.lastDay, actor: deps.staffActor(req),   // {StaffName} = the sign-in
      reuse: true, onPrepared: (core) => { prepared = core; } });
    const prepHandle = prepared ? prepCache.put({ who: prepCache.whoOf(ctx.viewer), caseRef, level: p.level, assignees: ctx.overview.assignees, overview: ctx.overview, core: prepared }) : '';
    res.json({ ok: true, ...p, prepHandle });
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
    // the send never uses the pop-up's kept facts (no handle is read here): its own fresh gate, list, notes and race check
    r = await svc.sendStaffReminder({
      overview: ctx.overview, level, subject, body: text, extra,
      lastDay: String(body.lastDay == null ? '' : body.lastDay).trim().slice(0, 10),
      actor: deps.staffActor(req),   // the Monday sign-in, else the shared-key placeholder — never a name from the body
    });
  } catch (err) { return answerError(res, err, caseRef); }
  finally { prepCache.dropCase(caseRef); }   // whatever happened, the next pop-up for this case starts from a fresh read
  _lastSendAt.set(key, Date.now());   // only a real send starts the cool-down
  console.log(`[DocReminders] ${caseRef}: reminder ${r.level} sent to ${r.to} by ${(ctx.viewer && ctx.viewer.email) || 'admin'}`);
  res.json({ ok: true, noted: r.noted, to: r.to, level: r.level, day: r.day, lastDay: r.lastDay || '', warnings: r.warnings || [] });
}

// ─── The pop-up's live view of the email (Faran 2026-11-07) ──────────────────
// Every pause in typing asks for the email again. Each ask reads the case like a preview
// does (the case, the checklist, the notes), so it is limited per person per case. The slot
// is checked AND taken in one step, before any wait, so asks sent all at once cannot all slip
// past an empty minute (review round 2): a full minute is refused BEFORE the case read and a
// flood never reaches Monday. A stranger is refused (401) before a slot is taken, and an ask
// the case gate refuses gives its slot back, so nobody can use up a staffer's minute.
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
/** Give back one slot taken at `at` (the ask was refused before it read anything). */
function releaseRender(key, at) {
  const list = _renders.get(key);
  if (!list) return;
  const i = list.lastIndexOf(at);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) _renders.delete(key);
}

/**
 * The email view with a handle from the preview (docReminderPrepCache) skips the case read.
 * Why that is safe — it does NOT skip the checks, it skips re-reading the same facts:
 *  - a handle exists only after THIS person (the same Monday sign-in, or the shared key)
 *    passed the full gate for THIS case and level — sign-in, assigned-or-admin, and the
 *    reminder gate (gateStaff) on a fresh Client Master read — at most 10 minutes ago;
 *  - the sign-in is still checked on every ask (a signed-out person gets the 401 above,
 *    before the handle is looked at), assignment is checked again against the assignees of
 *    that read, and the reminder gate runs again on its facts;
 *  - the email view writes nothing, notes nothing and sends nothing: it shows facts this
 *    person already saw in the preview, built around their own typing;
 *  - the handle is 128 random bits tied to who, case and level — useless to anyone else.
 * What is left: someone unassigned, or a case locked, inside those minutes still sees an
 * updated view of an email they already saw. The SEND reads everything fresh and refuses.
 */
function handleHit(body, viewer, caseRef, deps) {
  const who = prepCache.whoOf(viewer);
  const handle = String((body && body.handle) || '');
  if (!handle || !who) return null;
  const e = prepCache.take(handle, { who, caseRef, level: body.level });
  if (!e) return null;
  const caseAccess = deps.caseAccess || require('../services/caseAccessService');
  if (!viewer.isAdmin && !caseAccess.viewerCanSee(e.assignees, viewer)) { prepCache.drop(handle, who); return null; }   // the full read answers (403)
  return e;
}

/** POST render — never writes, never sends, never notes, no cool-down; a text problem is a 200 with problems. */
async function render(req, res, deps) {
  const caseRef = (req.params.caseRef || '').trim();
  res.set('Cache-Control', 'no-store');
  const bytes = Math.max(req.rawBody ? req.rawBody.length : 0, Number(req.headers && req.headers['content-length']) || 0);
  if (bytes > RENDER_MAX_BYTES) return res.status(413).json({ ok: false, reason: 'too-large', error: 'The text is too long for the email view.' });
  // a caller with no sign-in and no key hears 401 first, exactly as preview and send answer — never a 429
  // that would tell a stranger the case exists and is being worked on
  const viewer = deps.resolveViewer(req);
  if (!viewer) return res.status(401).json({ ok: false, error: 'Sign in required', loginUrl: '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard' });
  // who: the Monday sign-in; without one, the shared admin key (one slot for everyone using it)
  const actor = deps.staffActor(req);
  const key = `${actor && actor.verified && actor.email ? `staff:${String(actor.email).toLowerCase()}` : 'key'}|${caseRef.toUpperCase()}`;
  const now = Date.now();
  const wait = renderWait(key, now);
  // retryAfter: the pop-up asks once more by itself after the wait, so the line below is true
  if (wait > 0) return res.status(429).json({ ok: false, reason: 'too-many', retryAfter: wait, error: `The email view was updated too often — it updates again in ${wait}s. Nothing you typed is lost.` });
  countRender(key, now);   // taken in the same step as the check — no await between them
  const svc = deps.service || require('../services/docReminderService');
  const body = req.body || {};
  const input = () => ({ level: body.level, subject: str(body.subject, SUBJECT_MAX + 1), body: str(body.body, BODY_MAX + 1), extra: str(body.extra, EXTRA_MAX + 1),
    lastDay: String(body.lastDay == null ? '' : body.lastDay).trim().slice(0, 10),
    actor,   // the sign-off is the verified sign-in, exactly as the send signs — never a name from the body
  });
  const answer = (r, extraKeys) => res.json({ ok: true, html: r.html || '', subject: r.subject || '', warnings: r.warnings || [], problems: r.problems || [], ...(extraKeys || {}) });
  // the pop-up's kept facts (see handleHit): no case read — the reminder gate still runs on them
  const hit = handleHit(body, viewer, caseRef, deps);
  if (hit) {
    const v = input();
    const tooLong = svc.textProblem(v.subject, v.body, v.extra);
    if (tooLong) return answer({ problems: [tooLong] });
    try { return answer(await svc.renderStaffReminder({ ...v, overview: hit.overview, core: hit.core })); }
    catch (err) { prepCache.drop(body.handle, prepCache.whoOf(viewer)); return answerError(res, err, caseRef); }
  }
  const ctx = await deps.resolveCaseForWrite(req, res, caseRef, { read: readFacts(deps) });
  const mine = prepCache.whoOf(viewer);   // a handle is only ever ended by its own person
  if (!ctx) { releaseRender(key, now); if (body.handle) prepCache.drop(body.handle, mine); return; }   // refused by the gate: the slot is given back
  const v = input();
  const tooLong = svc.textProblem(v.subject, v.body, v.extra);
  if (tooLong) return answer({ problems: [tooLong] });
  try {
    let prepared = null;
    const r = await svc.renderStaffReminder({ ...v, overview: ctx.overview, reuse: true, onPrepared: (core) => { prepared = core; } });
    // a pop-up whose handle ran out gets a new one from this full read, so its next asks are quick again
    let renewed = null;
    if (body.handle) {
      prepCache.drop(body.handle, mine);
      const lv = Number(body.level);
      const h = prepared && [1, 2, 3].includes(lv) ? prepCache.put({ who: mine, caseRef, level: lv, assignees: ctx.overview.assignees, overview: ctx.overview, core: prepared }) : '';
      if (h) renewed = { prepHandle: h };
    }
    answer(r, renewed);
  } catch (err) { if (body.handle) prepCache.drop(body.handle, mine); answerError(res, err, caseRef); }
}

module.exports = { preview, send, render, COOLDOWN_MS, SUBJECT_MAX, BODY_MAX, EXTRA_MAX, RENDER_PER_MIN, RENDER_MAX_BYTES, _lastSendAt, _renders,
  _resetForTests: () => { _lastSendAt.clear(); _renders.clear(); prepCache._resetForTests(); } };
