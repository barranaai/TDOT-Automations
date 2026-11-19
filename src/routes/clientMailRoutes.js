'use strict';

/**
 * Client emails from the office mailbox (Stage 1, Faran 2026-11-19) — the two verification aids. server.js
 * registers them and hands in its own helpers, so tests run the handlers with fakes.
 *
 * POST /api/test-email { to [, client: true] } — behind the /api team key, as before.
 *   Without `client`: the old diagnostic send, unchanged (from MS_FROM_EMAIL, no Reply-To, no copy, no stamp).
 *   With `client: true`: the CLIENT-email path — from CLIENT_MAIL_FROM when it is set, else from the office
 *   mailbox (the test override, this route only, so the path is proven with the switch still off), with the
 *   client emails' Reply-To and the stamp { kind: 'test' }. Answers { sendId, via, stamped }.
 *
 * GET /admin/client-mail/check[?sendId=…] — NAMED admins only (signed in with Monday AND on ADMIN_EMAILS —
 *   staffIdentity.namedAdminCheck); the shared team key alone is refused: the answer describes the office
 *   mailbox. Read-only. Every answer: private, no-store. Counts and booleans only (clientMailCheckService).
 *
 * GET /admin/client-mail/old-replies[?format=csv][&refresh=1] — NAMED admins only, the same gate. Everyone who wrote
 *   to the old no-reply inbox and is a case or a lead, with whether info@ answered after (oldRepliesService).
 *   Read-only. JSON by default; format=csv → the same rows as a download (attachment, nosniff). Private, no-store.
 *   No list can be made (Monday or the old inbox could not be read) → 503 with plain words — never a partial list.
 */

const { namedAdminCheck } = require('../utils/staffIdentity');
const mail = require('../services/microsoftMailService');   // module reference, so tests can stub sendEmail

const svcOf = (deps) => (deps && deps.service) || require('../services/clientMailCheckService');

async function testEmail(req, res) {
  try {
    const to = String((req.body && req.body.to) || '').trim();
    if (!to) return res.status(400).json({ ok: false, error: 'Provide "to" in the JSON body.' });
    const client = !!(req.body && req.body.client === true);
    const clientBox = client ? svcOf().mailboxForTest() : '';
    const stamp = new Date().toISOString();
    const sent = await mail.sendEmail({
      to,
      subject: `TDOT mail delivery test — ${stamp}`,
      html: client
        ? `<p>This is a delivery test of the TDOT app's CLIENT emails, sent via Microsoft Graph (from the office mailbox when Microsoft allows it, with a copy kept).</p><p>If you received this, client emails deliver to this address. Sent at ${stamp}.</p>`
        : `<p>This is a delivery test from the TDOT app, sent via Microsoft Graph from <b>${process.env.MS_FROM_EMAIL || '(unset)'}</b>.</p><p>If you received this, the sending mailbox delivers to this address. Sent at ${stamp}.</p>`,
      ...(client ? { replyTo: require('../utils/clientContact').CLIENT_REPLY_TO, tag: { kind: 'test' }, testClientFrom: clientBox } : {}),
    });
    if (!client) return res.json({ ok: true, to, from: process.env.MS_FROM_EMAIL || null, sentAt: stamp, note: 'Graph accepted the message. Check the inbox (and spam).' });
    const r = sent || {};
    res.json({
      ok: true, to, sentAt: stamp,
      from: r.via === 'client' ? mail.clientMailbox(clientBox) : (process.env.MS_FROM_EMAIL || null),
      sendId: r.sendId || null, via: r.via || null, stamped: !!r.stamped,
      note: r.stamped
        ? `Graph accepted the message. In a minute or so, open /admin/client-mail/check?sendId=${r.sendId} (signed in with Monday as an admin) to see the kept copy.`
        : 'Graph accepted the message, without the case stamp. Check the inbox (and spam).',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function check(req, res, deps) {
  res.set('Cache-Control', 'private, no-store');
  const r = namedAdminCheck(deps.staff(req), deps.isAdminEmail, { what: 'check the client email copies', hint: '' });
  if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.loginUrl ? { loginUrl: r.loginUrl } : {}) });
  const sendId = typeof (req.query && req.query.sendId) === 'string' ? req.query.sendId.trim().slice(0, 64) : '';
  try {
    const out = await svcOf(deps).check({ sendId });
    res.status(200).json(out);
  } catch (_) {
    res.status(500).json({ error: 'The client email check could not run.' });
  }
}

async function oldReplies(req, res, deps) {
  res.set('Cache-Control', 'private, no-store');
  const r = namedAdminCheck(deps.staff(req), deps.isAdminEmail, { what: 'see who wrote to the old no-reply address', hint: '' });
  if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.loginUrl ? { loginUrl: r.loginUrl } : {}) });
  const q = req.query || {};
  const format = typeof q.format === 'string' ? q.format.trim().toLowerCase() : '';
  if (format && format !== 'json' && format !== 'csv') return res.status(400).json({ error: 'format must be json or csv.' });
  const refresh = typeof q.refresh === 'string' && /^(1|true|yes)$/i.test(q.refresh.trim());
  const svc = (deps && deps.oldReplies) || require('../services/oldRepliesService');
  let out;
  try { out = await svc.list({ refresh }); }
  catch (err) {
    const status = err && err.publicStatus;
    return res.status(status || 500).json({ error: (status && err.publicError) || 'The old no-reply list could not be made.' });
  }
  if (format !== 'csv') return res.status(200).json(out);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${svc.csvFileName(out)}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  return res.status(200).send(svc.toCsv(out.rows));
}

module.exports = { testEmail, check, oldReplies };
