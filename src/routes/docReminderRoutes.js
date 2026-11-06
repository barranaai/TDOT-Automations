'use strict';

/**
 * The two cockpit routes behind the three reminder buttons (block 2, step B):
 *   GET  /admin/case-action/:caseRef/reminder/preview?level=1|2|3[&lastDay=]
 *   POST /admin/case-action/:caseRef/reminder  { level, subject, body, extra, lastDay }
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

module.exports = { preview, send, COOLDOWN_MS, SUBJECT_MAX, BODY_MAX, EXTRA_MAX, _lastSendAt, _resetForTests: () => _lastSendAt.clear() };
