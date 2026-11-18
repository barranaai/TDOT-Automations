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

module.exports = { testEmail, check };
