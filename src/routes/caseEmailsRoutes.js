'use strict';

/**
 * The case page's Emails tab (Stage 2a, Faran 2026-11-19) — its three READ-ONLY routes (switch CASE_EMAILS_TAB):
 *   GET /admin/case-emails/:caseRef[?refresh=1][?probe=1]           → the list, with a status per source
 *   GET /admin/case-emails/:caseRef/message?source=…&id=…            → one email: headers, plain text, attachments
 *   GET /admin/case-emails/:caseRef/attachment?source=…&id=…&att=…   → one attachment, always as a download
 * (No other route under /admin/case-emails — nothing can collide with :caseRef, critique #19.)
 *
 * Who (Faran's decision 2): any staff member who can open the case (caseAccess.viewerCanSee, the case page's
 * rule), but ONLY signed in with Monday — the shared team key alone gets 401 with the Monday sign-in link. In
 * 'admins' mode only ADMIN_EMAILS (403 reason 'admins-only': the page then removes the tab, critique #17).
 * Every request repeats the whole check: switch → Monday sign-in → (admins) → the case lookup → the case row →
 * viewerCanSee. A row that cannot be read is a 503 — never let through.
 *
 * A request names an email ONLY as { source: 'office' | 'old', id } (id ^[A-Za-z0-9_=-]+$); the mailbox behind each
 * word is fixed on the server, and the email is fetched again and matched again for THIS case before anything is
 * answered (critique #1 — no tokens, nothing signed).
 *
 * Every answer: Cache-Control private, no-store. Logs: ids and counts only; an email opened / an attachment
 * downloaded → the staff email + a short hash of the internet message id. Never a subject, an address, a body, a
 * file name, or a raw Microsoft error (its URL holds client addresses).
 *
 * server.js registers them and hands in tryStaffAuth; the handlers live here so tests run them with fakes.
 */

const caseAccess = require('../services/caseAccessService');

const svcOf = (deps) => (deps && deps.service) || require('../services/caseEmailsService');
const lookupCase = (deps) => (deps && deps.lookupCase) || ((caseRef) => require('../services/htmlQuestionnaireService').validateAccessForStaff(caseRef, { skipFormVersioning: true }));
const isAdminOf = (deps) => (deps && deps.isAdminEmail) || caseAccess.isAdminEmail;

const REF_RE = /^[A-Za-z0-9\- ]{1,100}$/;
const ID_RE = /^[A-Za-z0-9_=-]{1,512}$/;
const SOURCES = ['office', 'old'];
const LOGIN = (caseRef) => '/q/auth/monday?returnTo=' + encodeURIComponent('/admin/case/' + caseRef);
const OFF = { ok: false, off: true, error: 'The Emails tab is not switched on.' };
const NOT_HERE = 'This email is not on this case any more (it may have been moved or deleted). Reload the list.';
const BUSY = 'Could not read the emails just now — retry in a moment.';

/**
 * The whole check, in order. Answers the refusal itself and returns null, or { viewer, staffEmail, itemId, row }.
 * `probe`: stop after the sign-in / admins check (the page asks once in 'admins' mode — no case data).
 */
async function access(req, res, caseRef, deps, { probe = false } = {}) {
  const svc = svcOf(deps);
  const mode = svc.mode();
  if (mode === 'off') { res.status(404).json(OFF); return null; }
  const staff = deps.staff(req);
  if (!staff || !staff.email) {
    res.status(401).json({ ok: false, error: 'Sign in with Monday to see emails — the shared team key doesn\'t say who you are.', loginUrl: LOGIN(caseRef) });
    return null;
  }
  const viewer = { ...caseAccess.viewerFromStaff(staff), isAdmin: !!isAdminOf(deps)(staff.email) };
  if (mode === 'admins' && !viewer.isAdmin) { res.status(403).json({ ok: false, reason: 'admins-only', error: 'The Emails tab is open to admins only for now.' }); return null; }
  if (probe) return { viewer };
  if (!REF_RE.test(caseRef)) { res.status(404).json({ ok: false, error: 'Case not found.' }); return null; }
  let found;
  try { found = await lookupCase(deps)(caseRef); }
  catch (err) {
    if (/not found/i.test(String(err && err.message))) { res.status(404).json({ ok: false, error: 'Case not found.' }); return null; }
    console.warn(`[CaseEmails] ${caseRef}: the case lookup failed`);
    res.status(503).json({ ok: false, error: 'temporarily-unavailable', message: BUSY }); return null;
  }
  const itemId = String((found && found.itemId) || '');
  if (!/^\d+$/.test(itemId)) { res.status(404).json({ ok: false, error: 'Case not found.' }); return null; }
  let row;
  try { row = await svc.readCaseRow(itemId); }
  catch (_) {
    console.warn(`[CaseEmails] ${caseRef}: the case row could not be read`);
    res.status(503).json({ ok: false, error: 'temporarily-unavailable', message: 'Case data is temporarily unavailable. Please reload in a moment.' }); return null;
  }
  if (!row) { res.status(503).json({ ok: false, error: 'temporarily-unavailable', message: 'Case data is temporarily unavailable. Please reload in a moment.' }); return null; }
  if (!viewer.isAdmin && !caseAccess.viewerCanSee(row.assignees, viewer)) { res.status(403).json({ ok: false, reason: 'not-assigned', error: 'You are not assigned to this case.' }); return null; }
  return { viewer, staffEmail: String(staff.email), itemId, row };
}

/** One query value as a plain string ('' for a missing or repeated parameter). */
const q1 = (req, k) => { const v = req.query && req.query[k]; return typeof v === 'string' ? v.trim() : ''; };

/** Which email the request names: { source, id } — or null (answered 400). */
function emailRef(req, res) {
  const source = q1(req, 'source'), id = q1(req, 'id');
  if (!SOURCES.includes(source) || !ID_RE.test(id)) { res.status(400).json({ ok: false, error: 'This email link is not valid. Reload the list.' }); return null; }
  return { source, id };
}

/** A failed read: 404 when the email is not (or no longer) on this case, else 503 — status + code in the log only. */
function readFailed(res, caseRef, what, err) {
  if (err && err.notFound) return res.status(404).json({ ok: false, error: NOT_HERE });
  const st = (err && err.response && err.response.status) || 0;
  const code = (err && err.response && err.response.data && err.response.data.error && /^[A-Za-z0-9_.-]{1,80}$/.test(String(err.response.data.error.code || '')) && err.response.data.error.code) || (st ? 'graph-error' : 'no-answer');
  console.warn(`[CaseEmails] ${caseRef}: ${what} failed (${st || 'no answer'} ${code})`);
  return res.status(503).json({ ok: false, error: 'temporarily-unavailable', message: BUSY });
}

async function list(req, res, deps) {
  res.set('Cache-Control', 'private, no-store');
  const caseRef = String((req.params && req.params.caseRef) || '').trim();
  const probe = q1(req, 'probe') === '1';
  const ctx = await access(req, res, caseRef, deps, { probe });
  if (!ctx) return;
  if (probe) return res.json({ ok: true });
  const svc = svcOf(deps);
  let out;
  try { out = await svc.list({ itemId: ctx.itemId, caseRef, row: ctx.row, refresh: q1(req, 'refresh') === '1' }); }
  catch (err) { return readFailed(res, caseRef, 'the email list', err); }
  res.json({ ok: true, ...svc.forViewer(out, ctx.viewer) });
}

async function message(req, res, deps) {
  res.set('Cache-Control', 'private, no-store');
  const caseRef = String((req.params && req.params.caseRef) || '').trim();
  const ctx = await access(req, res, caseRef, deps);
  if (!ctx) return;
  const ref = emailRef(req, res);
  if (!ref) return;
  let r;
  try { r = await svcOf(deps).open({ itemId: ctx.itemId, caseRef, row: ctx.row, source: ref.source, id: ref.id, viewer: ctx.viewer }); }
  catch (err) { return readFailed(res, caseRef, 'opening an email', err); }
  console.log(`[CaseEmails] ${caseRef}: email opened by ${ctx.staffEmail} (msg ${r.imidHash || 'restricted'})`);
  const { imidHash, ...pub } = r;
  res.json({ ok: true, ...pub });
}

async function attachment(req, res, deps) {
  res.set('Cache-Control', 'private, no-store');
  const caseRef = String((req.params && req.params.caseRef) || '').trim();
  const ctx = await access(req, res, caseRef, deps);
  if (!ctx) return;
  const ref = emailRef(req, res);
  if (!ref) return;
  const att = q1(req, 'att');
  if (!ID_RE.test(att)) return res.status(400).json({ ok: false, error: 'This attachment link is not valid. Reopen the email.' });
  let r;
  try { r = await svcOf(deps).attachment({ itemId: ctx.itemId, caseRef, row: ctx.row, source: ref.source, id: ref.id, att, viewer: ctx.viewer }); }
  catch (err) {
    if (err && err.notFound) return res.status(404).json({ ok: false, error: 'This attachment is not here any more — reopen the email.' });
    return readFailed(res, caseRef, 'an attachment download', err);
  }
  if (r.refused) return res.status(r.refused.status).json({ ok: false, error: r.refused.error });
  // always a download, never shown in the page: octet-stream, nosniff, a sandbox CSP, never kept
  res.attachment(r.name);   // RFC 5987-safe Content-Disposition (a non-Latin name never throws)
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "sandbox; default-src 'none'");
  res.set('Cache-Control', 'private, no-store');
  console.log(`[CaseEmails] ${caseRef}: attachment downloaded by ${ctx.staffEmail} (msg ${r.imidHash})`);
  const stream = r.stream;
  res.on('close', () => { if (!res.writableFinished && stream && typeof stream.destroy === 'function') stream.destroy(); });
  stream.on('error', () => { console.warn(`[CaseEmails] ${caseRef}: an attachment download broke off`); if (typeof res.destroy === 'function') res.destroy(); });
  stream.pipe(res);
}

module.exports = { list, message, attachment, access, LOGIN, REF_RE, ID_RE };
