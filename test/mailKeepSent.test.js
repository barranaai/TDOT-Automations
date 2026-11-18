'use strict';

// Stage 1 (Faran 2026-11-19): client emails go FROM the office mailbox (CLIENT_MAIL_FROM, info@), Microsoft
// keeps the copy in its Sent Items, and each copy carries the case stamp (utils/mailTag.js). Behind a switch,
// OFF by default — then every request is byte-for-byte today's. Staff alerts never change. A client email is
// never lost or doubled: a 4xx was not accepted (one resend is safe), anything else is never resent.
// axios is stubbed — no network.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');

const mail   = require('../src/services/microsoftMailService');
const tagLib = require('../src/utils/mailTag');
const { buildTagProps, propId, NS, NAMES, PS_INTERNET_HEADERS } = tagLib;

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOREPLY = 'noreply@tdotimm.com', OFFICE = 'info@tdotimm.com';
const URL_OF = (box) => `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(box)}/sendMail`;
const CONFIG = { headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, timeout: 30000 };

// ─── the stamp (pure) ────────────────────────────────────────────────────────

test('mailTag: our own fixed GUID namespace — never PS_INTERNET_HEADERS (those become x- headers on the wire)', () => {
  assert.match(NS, /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/);
  assert.equal(NS, '{ea1cfd10-69d2-41c0-a9fc-1fc4288e039e}', 'fixed forever — a new GUID would orphan every copy already stamped');
  assert.notEqual(NS.toLowerCase(), PS_INTERNET_HEADERS.toLowerCase());
  const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code('src/utils/mailTag.js').replace(/const PS_INTERNET_HEADERS = '[^']+';/, ''), /00020386/i, 'the x-header namespace is named only to be refused');
  assert.doesNotMatch(read('src/services/microsoftMailService.js'), /00020386/i);
  assert.equal(propId('TdotCaseItemId'), 'String {ea1cfd10-69d2-41c0-a9fc-1fc4288e039e} Name TdotCaseItemId');
  assert.deepEqual(NAMES, ['TdotCaseItemId', 'TdotCaseRef', 'TdotLeadId', 'TdotTo', 'TdotKind', 'TdotSendId']);
});

test('mailTag: every field, normalised; ids are "String {GUID} Name <fixed name>" — a value never goes into a name', () => {
  const { props, sendId } = buildTagProps({ caseItemId: 1234567890, caseRef: ' 2026-cec-ee-110 ', leadId: '9988', kind: 'doc-reminder' }, ['  Ana.Silva@Example.COM ', 'second@x.co']);
  assert.match(sendId, UUID);
  assert.deepEqual(props, [
    { id: propId('TdotCaseItemId'), value: '1234567890' },
    { id: propId('TdotCaseRef'), value: '2026-CEC-EE-110' },
    { id: propId('TdotLeadId'), value: '9988' },
    { id: propId('TdotTo'), value: 'ana.silva@example.com' },
    { id: propId('TdotKind'), value: 'doc-reminder' },
    { id: propId('TdotSendId'), value: sendId },
  ]);
  for (const p of props) assert.match(p.id, /^String \{ea1cfd10-69d2-41c0-a9fc-1fc4288e039e\} Name (TdotCaseItemId|TdotCaseRef|TdotLeadId|TdotTo|TdotKind|TdotSendId)$/);
  assert.notEqual(buildTagProps({ kind: 'x' }, 'a@b.co').sendId, sendId, 'a new id per send');
  // Graph recipient objects work too
  assert.equal(buildTagProps({}, [{ emailAddress: { address: 'B@C.ca' } }]).props.find((p) => p.id === propId('TdotTo')).value, 'b@c.ca');
});

test('mailTag: an invalid value is DROPPED, never thrown — only TdotSendId is always there', () => {
  const only = (tag, to) => buildTagProps(tag, to).props.map((p) => p.id.split(' Name ')[1]);
  assert.deepEqual(only({ caseItemId: 'abc', caseRef: 'SPE-016', leadId: '-5', kind: 'Doc Reminder' }, 'not-an-address'), ['TdotSendId']);
  assert.deepEqual(only({ caseItemId: '1'.repeat(21), leadId: '1.5', kind: 'k'.repeat(41) }, `${'a'.repeat(115)}@x.com`), ['TdotSendId'], '21 digits, a decimal, 41 chars, an address over 120');
  assert.deepEqual(only({ caseRef: '2026-SPE-016 ; drop', kind: 'doc_reminder' }, 'a b@c.d'), ['TdotSendId']);
  assert.deepEqual(only({ caseRef: '2026-SPE-01' }, ''), ['TdotSendId'], 'a ref needs 3+ digits');
  assert.deepEqual(only({ caseItemId: '1'.repeat(20), kind: 'k'.repeat(40) }, `${'a'.repeat(113)}@x.com`), ['TdotCaseItemId', 'TdotTo', 'TdotKind', 'TdotSendId'], 'the limits themselves pass');
  for (const [tag, to] of [[null, null], [undefined, undefined], ['a string', 5], [{ caseItemId: {}, caseRef: [], kind: null }, [null, '', { emailAddress: null }]], [{ caseRef: { toString() { throw new Error('boom'); } } }, 'a@b.co']]) {
    let r;
    assert.doesNotThrow(() => { r = buildTagProps(tag, to); });
    assert.ok(r.props.some((p) => p.id === propId('TdotSendId')));
  }
});

// ─── the send ────────────────────────────────────────────────────────────────

/**
 * axios.post stubbed: the token answers 'tok'; each sendMail takes the next answer —
 * 'ok' (202) or { status, code } (a Graph error) or { timeout: true } / { network: true }.
 */
async function withMail({ env = {}, answers = [], now = Date.parse('2026-11-20T15:00:00Z') } = {}, fn) {
  const keys = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_FROM_EMAIL', 'CLIENT_MAIL_FROM'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const all = { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MS_FROM_EMAIL: NOREPLY, CLIENT_MAIL_FROM: undefined, ...env };
  for (const k of keys) { if (all[k] === undefined) delete process.env[k]; else process.env[k] = all[k]; }
  const keep = { post: axios.post, warn: console.warn, now: mail.io.now };
  const h = { calls: [], warns: [], now, queue: typeof answers === 'function' ? [] : answers.slice() };
  mail.io.now = () => h.now;
  console.warn = (...a) => h.warns.push(a.join(' '));
  axios.post = async (url, body, config) => {
    if (/oauth2\/v2\.0\/token/.test(url)) return { data: { access_token: 'tok', expires_in: 3600 } };
    h.calls.push({ url, body: JSON.parse(JSON.stringify(body)), raw: JSON.stringify(body), config });
    const a = typeof answers === 'function' ? answers(url) : h.queue.length ? h.queue.shift() : 'ok';
    if (a === 'ok') return { status: 202, data: '' };
    if (a.timeout) { const e = new Error('timeout of 30000ms exceeded'); e.code = 'ECONNABORTED'; throw e; }
    if (a.network) { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; }
    const e = new Error(`Request failed with status code ${a.status}`);
    e.response = { status: a.status, data: { error: { code: a.code || 'X', message: a.message || 'refused' } } };
    throw e;
  };
  mail.invalidateAccessToken(); mail._reset();
  try { return await fn(h); }
  finally {
    axios.post = keep.post; console.warn = keep.warn; mail.io.now = keep.now;
    mail.invalidateAccessToken(); mail._reset();
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const MSG = { to: 'ana@example.com', subject: 'Docs — 2026-SPE-016 · Internal Review', html: '<p>hi</p>', replyTo: OFFICE };
const TAG = { caseRef: '2026-SPE-016', caseItemId: '555', kind: 'doc-reminder' };
/** Today's message, exactly as the code built it before Stage 1. */
const todayMessage = (m = MSG) => ({
  subject: m.subject,
  body: { contentType: 'HTML', content: m.html },
  toRecipients: [{ emailAddress: { address: m.to } }],
  ...(m.replyTo ? { replyTo: [{ emailAddress: { address: m.replyTo } }] } : {}),
});
const todayRaw = (m = MSG) => JSON.stringify({ message: todayMessage(m), saveToSentItems: false });

test('switch OFF (unset or blank): tagged AND untagged sends are byte-for-byte today\'s request — from noreply@, saveToSentItems:false, no stamp', async () => {
  for (const CLIENT_MAIL_FROM of [undefined, '', '   ']) {
    await withMail({ env: { CLIENT_MAIL_FROM } }, async (h) => {
      const untagged = await mail.sendEmail(MSG);
      const tagged = await mail.sendEmail({ ...MSG, tag: TAG });
      const noReplyTo = await mail.sendEmail({ to: 'x@y.co', subject: 'Alert', html: '<b>x</b>' });
      assert.equal(h.calls.length, 3, 'one request each');
      for (const c of h.calls.slice(0, 2)) {
        assert.equal(c.url, URL_OF(NOREPLY));
        assert.equal(c.raw, todayRaw(), 'byte-for-byte');
        assert.deepEqual(c.config, CONFIG);
      }
      assert.equal(h.calls[2].raw, todayRaw({ to: 'x@y.co', subject: 'Alert', html: '<b>x</b>' }), 'no Reply-To when none is passed');
      for (const r of [untagged, tagged, noReplyTo]) assert.deepEqual(r, { sendId: null, via: 'default', stamped: false });
      assert.deepEqual(h.warns, []);
    });
  }
});

test('switch OFF: attachments go exactly as before too', async () => {
  await withMail({}, async (h) => {
    const attachments = [{ filename: 'a.pdf', buffer: Buffer.from('PDF'), mimeType: 'application/pdf' }, { filename: 'empty.pdf', buffer: Buffer.alloc(0) }];
    await mail.sendEmail({ ...MSG, attachments, tag: TAG });
    assert.equal(h.calls[0].raw, JSON.stringify({ message: { ...todayMessage(), attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.pdf', contentType: 'application/pdf', contentBytes: Buffer.from('PDF').toString('base64') }] }, saveToSentItems: false }));
  });
});

test('switch ON + tag: from the office mailbox, NO saveToSentItems key (Microsoft keeps the copy), the stamp on the message, Reply-To as passed; the sendId comes back', async () => {
  await withMail({ env: { CLIENT_MAIL_FROM: ' Info@TdotImm.com ' } }, async (h) => {
    const r = await mail.sendEmail({ ...MSG, tag: TAG });
    assert.equal(h.calls.length, 1);
    const c = h.calls[0];
    assert.equal(c.url, URL_OF(OFFICE));
    assert.deepEqual(Object.keys(c.body), ['message'], 'no saveToSentItems key at all');
    assert.deepEqual(c.config, CONFIG);
    const { singleValueExtendedProperties: props, ...rest } = c.body.message;
    assert.deepEqual(rest, todayMessage(), 'the message itself is unchanged — Reply-To stays as the caller passed it');
    assert.deepEqual(props.map((p) => p.id.split(' Name ')[1]), ['TdotCaseItemId', 'TdotCaseRef', 'TdotTo', 'TdotKind', 'TdotSendId']);
    for (const p of props) assert.ok(p.id.startsWith(`String ${NS} Name `));
    assert.deepEqual(props.slice(0, 4).map((p) => p.value), ['555', '2026-SPE-016', 'ana@example.com', 'doc-reminder']);
    assert.match(r.sendId, UUID);
    assert.equal(props[4].value, r.sendId);
    assert.deepEqual({ via: r.via, stamped: r.stamped }, { via: 'client', stamped: true });
    assert.doesNotMatch(c.raw, /00020386/i);
  });
});

test('switch ON: an UNTAGGED send (a staff alert) is unchanged — noreply@, saveToSentItems:false, no stamp, no copy', async () => {
  await withMail({ env: { CLIENT_MAIL_FROM: OFFICE } }, async (h) => {
    const r = await mail.sendEmail(MSG);
    assert.equal(h.calls[0].url, URL_OF(NOREPLY));
    assert.equal(h.calls[0].raw, todayRaw());
    assert.deepEqual(r, { sendId: null, via: 'default', stamped: false });
    for (const tag of [null, 'x', 0, false]) await mail.sendEmail({ ...MSG, tag });   // not an object → not a client send
    assert.ok(h.calls.every((c) => c.url === URL_OF(NOREPLY) && c.raw === todayRaw()));
  });
});

test('a CLIENT_MAIL_FROM that is not on tdotimm.com, or IS the usual noreply@ (also the OneDrive / Otter account), is ignored with one warning — sent the usual way', async () => {
  for (const bad of ['office@gmail.com', 'info@tdotimm.com.evil.io', 'info@sub.tdotimm.com', 'not an address', NOREPLY, 'NoReply@tdotimm.com']) {
    await withMail({ env: { CLIENT_MAIL_FROM: bad } }, async (h) => {
      await mail.sendEmail({ ...MSG, tag: TAG });
      await mail.sendEmail({ ...MSG, tag: TAG });
      assert.ok(h.calls.every((c) => c.url === URL_OF(NOREPLY) && c.raw === todayRaw()), bad);
      assert.equal(h.warns.length, 1, `${bad}: one warning`);
      assert.match(h.warns[0], /CLIENT_MAIL_FROM must be an address on tdotimm\.com other than the usual sending address — ignored/);
      assert.ok(!h.warns[0].includes(bad), 'the warning does not repeat the value');
    });
  }
});

test('400 or 422 with the stamp attached → ONE resend to the same mailbox without it (still kept); stamping then stops until restart, logged once', async () => {
  for (const status of [400, 422]) {
    await withMail({ env: { CLIENT_MAIL_FROM: OFFICE }, answers: [{ status, code: 'ErrorInvalidProperty' }] }, async (h) => {
      const r = await mail.sendEmail({ ...MSG, tag: TAG });
      assert.equal(h.calls.length, 2);
      assert.ok(h.calls[0].body.message.singleValueExtendedProperties);
      assert.equal(h.calls[1].url, URL_OF(OFFICE));
      assert.equal(h.calls[1].raw, JSON.stringify({ message: todayMessage() }), 'the same email, no stamp, no saveToSentItems key');
      assert.deepEqual(r, { sendId: null, via: 'client', stamped: false });
      assert.equal(mail._state().stampRefused, true);
      assert.deepEqual(h.warns, ['[Mail] Microsoft refused the case stamp — sent without it']);
      // the next client email goes unstamped straight away — one request, no second log
      await mail.sendEmail({ ...MSG, tag: TAG });
      assert.equal(h.calls.length, 3);
      assert.equal(h.calls[2].raw, JSON.stringify({ message: todayMessage() }));
      assert.equal(h.warns.length, 1);
    });
  }
});

test('400 with the stamp, and the stamp-free resend ALSO 400 → the error goes up in today\'s shape; the stamp is not blamed; two requests only', async () => {
  await withMail({ env: { CLIENT_MAIL_FROM: OFFICE }, answers: [{ status: 400, code: 'A' }, { status: 400, code: 'B', message: 'attachment too large' }] }, async (h) => {
    await assert.rejects(() => mail.sendEmail({ ...MSG, tag: TAG }), (err) => err.message === `sendMail failed (400): ${JSON.stringify({ error: { code: 'B', message: 'attachment too large' } })}`);
    assert.equal(h.calls.length, 2);
    assert.equal(mail._state().stampRefused, false);
  });
  // an unstamped send (stamping already off) that gets a 400 is not resent
  await withMail({ env: { CLIENT_MAIL_FROM: OFFICE }, answers: [{ status: 400 }] }, async (h) => {
    await mail.sendEmail({ ...MSG, tag: TAG });   // 400 → resend ok → stamping off
    h.queue.push({ status: 400 });
    await assert.rejects(() => mail.sendEmail({ ...MSG, tag: TAG }), /sendMail failed \(400\)/);
    assert.equal(h.calls.length, 3);
  });
});

test('403 or 404 from the office mailbox → ONE resend the usual way (noreply@, saveToSentItems:false, no stamp, same Reply-To); 60 minutes straight the usual way; logged once an hour', async () => {
  for (const status of [403, 404]) {
    await withMail({ env: { CLIENT_MAIL_FROM: OFFICE }, answers: [{ status, code: 'ErrorAccessDenied' }] }, async (h) => {
      const r = await mail.sendEmail({ ...MSG, tag: TAG });
      assert.equal(h.calls.length, 2);
      assert.equal(h.calls[0].url, URL_OF(OFFICE));
      assert.equal(h.calls[1].url, URL_OF(NOREPLY));
      assert.equal(h.calls[1].raw, todayRaw(), 'exactly today\'s request, Reply-To info@ kept');
      assert.deepEqual(r, { sendId: null, via: 'fallback', stamped: false });
      assert.deepEqual(h.warns, [`[Mail] Microsoft refused sending as ${OFFICE} — sent from the usual address`]);
      // within the hour: straight the usual way, one request each
      h.now += 59 * 60 * 1000;
      assert.deepEqual(await mail.sendEmail({ ...MSG, tag: TAG }), { sendId: null, via: 'fallback', stamped: false });
      assert.equal(h.calls.length, 3); assert.equal(h.calls[2].url, URL_OF(NOREPLY)); assert.equal(h.calls[2].raw, todayRaw());
      // after the hour: tried again; refused again → one more log (an hour after the first)
      h.now += 2 * 60 * 1000;
      h.queue.push({ status });
      await mail.sendEmail({ ...MSG, tag: TAG });
      assert.deepEqual(h.calls.slice(3).map((c) => c.url), [URL_OF(OFFICE), URL_OF(NOREPLY)]);
      assert.equal(h.warns.length, 2);
      // after the hour, accepted → from the office mailbox, stamped
      h.now += 61 * 60 * 1000;
      const ok = await mail.sendEmail({ ...MSG, tag: TAG });
      assert.equal(h.calls.at(-1).url, URL_OF(OFFICE));
      assert.equal(ok.via, 'client'); assert.equal(ok.stamped, true);
    });
  }
});

test('two refusals in the same moment log once; a failing fallback goes up in today\'s shape', async () => {
  await withMail({ env: { CLIENT_MAIL_FROM: OFFICE }, answers: (url) => (url === URL_OF(OFFICE) ? { status: 403 } : 'ok') }, async (h) => {
    const rs = await Promise.all([mail.sendEmail({ ...MSG, tag: TAG }), mail.sendEmail({ ...MSG, tag: TAG })]);
    assert.deepEqual(rs.map((r) => r.via), ['fallback', 'fallback']);
    assert.equal(h.calls.filter((c) => c.url === URL_OF(NOREPLY)).length, 2, 'each email once the usual way');
    assert.equal(h.warns.length, 1);
  });
  await withMail({ env: { CLIENT_MAIL_FROM: OFFICE }, answers: [{ status: 403 }, { status: 503, code: 'ServiceUnavailable' }] }, async (h) => {
    await assert.rejects(() => mail.sendEmail({ ...MSG, tag: TAG }), /^Error: sendMail failed \(503\): /);
    assert.equal(h.calls.length, 2, 'the usual-way resend is not retried');
    // the refusal is still logged once, although its resend failed — the next hour is not silent
    assert.deepEqual(h.warns, [`[Mail] Microsoft refused sending as ${OFFICE} — the resend from the usual address failed too`]);
    assert.ok(mail._state().sendAsRefusedAt > 0);
    // within the hour: straight the usual way (one request, no copy) — and no second warning
    h.now += 30 * 60 * 1000;
    assert.deepEqual(await mail.sendEmail({ ...MSG, tag: TAG }), { sendId: null, via: 'fallback', stamped: false });
    assert.equal(h.calls.length, 3); assert.equal(h.calls[2].url, URL_OF(NOREPLY)); assert.equal(h.calls[2].raw, todayRaw());
    assert.equal(h.warns.length, 1, 'still one warning within the hour');
  });
});

test('400 with the stamp → stamp-free resend refused 403 → the usual way: three requests at most, never a double send', async () => {
  await withMail({ env: { CLIENT_MAIL_FROM: OFFICE }, answers: [{ status: 400 }, { status: 403 }] }, async (h) => {
    const r = await mail.sendEmail({ ...MSG, tag: TAG });
    assert.deepEqual(h.calls.map((c) => c.url), [URL_OF(OFFICE), URL_OF(OFFICE), URL_OF(NOREPLY)]);
    assert.equal(h.calls[2].raw, todayRaw());
    assert.equal(r.via, 'fallback');
  });
});

test('429, 5xx, a timeout or a network error → NO resend (Microsoft may have taken it); the error is today\'s', async () => {
  const cases = [[{ status: 429, code: 'TooManyRequests' }, /^sendMail failed \(429\): \{"error"/], [{ status: 500 }, /^sendMail failed \(500\)/], [{ status: 503 }, /^sendMail failed \(503\)/],
    [{ timeout: true }, /^sendMail failed \(undefined\): timeout of 30000ms exceeded$/], [{ network: true }, /^sendMail failed \(undefined\): socket hang up$/]];
  for (const [answer, re] of cases) {
    for (const env of [{ CLIENT_MAIL_FROM: OFFICE }, {}]) {
      await withMail({ env, answers: [answer] }, async (h) => {
        await assert.rejects(() => mail.sendEmail({ ...MSG, tag: TAG }), (err) => re.test(err.message));
        assert.equal(h.calls.length, 1, JSON.stringify(answer));
        assert.deepEqual(mail._state(), { stampRefused: false, sendAsRefusedAt: 0, sendAsBox: '', sendAsLoggedAt: 0, badSettingWarned: null });
      });
    }
  }
});

test('401 → as today: no resend, today\'s error (the token is fetched again by its own expiry rule) — never the send-as fallback', async () => {
  for (const env of [{}, { CLIENT_MAIL_FROM: OFFICE }]) {
    await withMail({ env, answers: [{ status: 401, code: 'InvalidAuthenticationToken' }] }, async (h) => {
      await assert.rejects(() => mail.sendEmail({ ...MSG, tag: TAG }), /^Error: sendMail failed \(401\): /);
      assert.equal(h.calls.length, 1);
      assert.equal(mail._state().sendAsRefusedAt, 0);
    });
  }
  // today's code: no retry on 401 inside sendEmail
  assert.doesNotMatch(read('src/services/microsoftMailService.js').slice(read('src/services/microsoftMailService.js').indexOf('async function sendEmail')), /invalidateAccessToken\(\)/);
});

test('the test override (POST /api/test-email "client": true only): tries the office mailbox with the switch OFF, ignores both memories, needs a tag', async () => {
  await withMail({}, async (h) => {
    const r = await mail.sendEmail({ ...MSG, tag: { kind: 'test' }, testClientFrom: OFFICE });
    assert.equal(h.calls[0].url, URL_OF(OFFICE));
    assert.equal(r.via, 'client'); assert.equal(r.stamped, true);
    assert.deepEqual(h.calls[0].body.message.singleValueExtendedProperties.map((p) => p.id.split(' Name ')[1]), ['TdotTo', 'TdotKind', 'TdotSendId']);
    // no tag → the override does nothing
    await mail.sendEmail({ ...MSG, testClientFrom: OFFICE });
    assert.equal(h.calls[1].url, URL_OF(NOREPLY)); assert.equal(h.calls[1].raw, todayRaw());
    // the switch-off client sends are still the usual way
    await mail.sendEmail({ ...MSG, tag: TAG });
    assert.equal(h.calls[2].url, URL_OF(NOREPLY));
    // a refusal is remembered for normal sends, but a re-test tries again (no restart needed)
    h.queue.push({ status: 400 }, 'ok', { status: 403 });
    await mail.sendEmail({ ...MSG, tag: { kind: 'test' }, testClientFrom: OFFICE });   // 400 → stamp-free resend
    await mail.sendEmail({ ...MSG, tag: { kind: 'test' }, testClientFrom: OFFICE });   // 403 → usual way
    assert.equal(mail._state().stampRefused, true);
    const n = h.calls.length;
    const again = await mail.sendEmail({ ...MSG, tag: { kind: 'test' }, testClientFrom: OFFICE });
    assert.equal(h.calls[n].url, URL_OF(OFFICE)); assert.ok(h.calls[n].body.message.singleValueExtendedProperties);
    assert.equal(again.stamped, true);
    // the override cannot point at noreply@ or outside tdotimm.com
    for (const bad of [NOREPLY, 'x@gmail.com']) { const m = h.calls.length; await mail.sendEmail({ ...MSG, tag: { kind: 'test' }, testClientFrom: bad }); assert.equal(h.calls[m].url, URL_OF(NOREPLY)); }
  });
  // only the test route uses it
  const users = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js') && /testClientFrom/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(ROOT, p).split(path.sep).join('/')); } })(path.join(ROOT, 'src'));
  assert.deepEqual(users.sort(), ['src/routes/clientMailRoutes.js', 'src/services/microsoftMailService.js']);
});

test('the return value is new and optional — no caller depends on it (backward compatible)', () => {
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!f.endsWith('.js') || /microsoftMailService\.js$|clientMailRoutes\.js$/.test(p)) continue;
      assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /=\s*await\s+[\w.()'/\s]*sendEmail\(/, p);
    }
  })(path.join(ROOT, 'src'));
});

test('the header keeps the rules; the mail service never names the office address (the switch names it)', () => {
  const src = read('src/services/microsoftMailService.js');
  for (const rule of [/Unset \/ blank → today's request for EVERY email/, /NO saveToSentItems/, /400 \/ 422 with the stamp attached/, /403 \/ 404 from the office mailbox/, /429, 5xx, a timeout or a network error → NO resend/, /no copies are ever kept there/]) assert.match(src, rule);
  assert.doesNotMatch(src, /info@tdotimm\.com/);
});

// ─── POST /api/test-email (the one live test after deploy) ───────────────────

const routes = require('../src/routes/clientMailRoutes');
const checkSvc = require('../src/services/clientMailCheckService');

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  return r;
}

test('test-email WITHOUT "client": the old diagnostic send, unchanged — the same three fields, today\'s request (even with the switch on), today\'s answer', async () => {
  for (const env of [{}, { CLIENT_MAIL_FROM: OFFICE }]) {
    await withMail({ env }, async (h) => {
      const keep = mail.sendEmail; const args = [];
      mail.sendEmail = async (m) => { args.push(m); return keep(m); };
      try {
        for (const body of [{ to: 'tester@example.org' }, { to: 'tester@example.org', client: 'true' }, { to: 'tester@example.org', client: 1 }]) {
          const res = fakeRes();
          await routes.testEmail({ body }, res);
          assert.deepEqual(Object.keys(args.at(-1)), ['to', 'subject', 'html'], 'only "client": true (the boolean) switches the path');
          assert.equal(h.calls.at(-1).url, URL_OF(NOREPLY));
          assert.deepEqual(Object.keys(h.calls.at(-1).body), ['message', 'saveToSentItems']);
          assert.deepEqual(Object.keys(h.calls.at(-1).body.message), ['subject', 'body', 'toRecipients']);
          assert.match(h.calls.at(-1).body.message.body.content, /sent via Microsoft Graph from <b>noreply@tdotimm\.com<\/b>/);
          assert.deepEqual(Object.keys(res.body), ['ok', 'to', 'from', 'sentAt', 'note']);
          assert.equal(res.body.from, NOREPLY);
        }
      } finally { mail.sendEmail = keep; }
    });
  }
  const res = fakeRes(); await routes.testEmail({ body: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('test-email WITH "client": true — the client path from the office mailbox even with the switch off, stamped { kind: "test" }, Reply-To info@; answers { sendId, via, stamped }', async () => {
  await withMail({}, async (h) => {
    const keep = mail.sendEmail; const args = [];
    mail.sendEmail = async (m) => { args.push(m); return keep(m); };
    try {
      const res = fakeRes();
      await routes.testEmail({ body: { to: 'tester@example.org', client: true } }, res);
      assert.deepEqual(args[0].tag, { kind: 'test' });
      assert.equal(args[0].testClientFrom, OFFICE, 'switch off → the office mailbox (this route only)');
      assert.equal(args[0].replyTo, OFFICE);
      const c = h.calls[0];
      assert.equal(c.url, URL_OF(OFFICE));
      assert.deepEqual(Object.keys(c.body), ['message']);
      assert.deepEqual(c.body.message.singleValueExtendedProperties.map((p) => [p.id.split(' Name ')[1], p.id.split(' Name ')[1] === 'TdotSendId' ? 'id' : p.value]), [['TdotTo', 'tester@example.org'], ['TdotKind', 'test'], ['TdotSendId', 'id']]);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.via, 'client'); assert.equal(res.body.stamped, true); assert.match(res.body.sendId, UUID);
      assert.equal(res.body.from, OFFICE);
      assert.ok(res.body.note.includes(`/admin/client-mail/check?sendId=${res.body.sendId}`));
      // refused send-as → the usual way, and the answer says so
      h.queue.push({ status: 403 });
      const res2 = fakeRes();
      await routes.testEmail({ body: { to: 'tester@example.org', client: true } }, res2);
      assert.deepEqual([res2.body.via, res2.body.stamped, res2.body.sendId, res2.body.from], ['fallback', false, null, NOREPLY]);
    } finally { mail.sendEmail = keep; }
  });
  // switch ON → its mailbox
  await withMail({ env: { CLIENT_MAIL_FROM: 'clients@tdotimm.com' } }, async (h) => {
    const res = fakeRes();
    await routes.testEmail({ body: { to: 'tester@example.org', client: true } }, res);
    assert.equal(h.calls[0].url, URL_OF('clients@tdotimm.com'));
    assert.equal(res.body.from, 'clients@tdotimm.com');
  });
  // a send failure is a 500 with the error, as before
  await withMail({ answers: [{ status: 500 }] }, async () => {
    const res = fakeRes();
    await routes.testEmail({ body: { to: 'tester@example.org' } }, res);
    assert.equal(res.statusCode, 500); assert.match(res.body.error, /^sendMail failed \(500\)/);
  });
});

test('test-email wiring: still behind the /api team key; the handler is the routes module', () => {
  const server = read('src/server.js');
  assert.match(server, /app\.use\('\/api', requireApiKey\);/);
  assert.ok(server.includes("app.post('/api/test-email', express.json(), (req, res) => require('./routes/clientMailRoutes').testEmail(req, res));"));
});

// ─── GET /admin/client-mail/check (named admins, read-only, counts only) ─────

const ADMIN = { email: 'boss@tdotimm.com', name: 'Boss' };
const STAFF = { email: 'staff@tdotimm.com', name: 'Staff' };
const isAdminEmail = (e) => e === ADMIN.email;

test('check route: a NAMED admin only — no Monday sign-in (the shared key alone) → 401 with the sign-in link; staff → 403; every answer private, no-store', async () => {
  let calls = 0;
  const service = { check: async (o) => { calls++; return { ok: true, got: o }; } };
  let res = fakeRes();
  await routes.check({ query: {} }, res, { staff: () => null, isAdminEmail, service });
  assert.equal(res.statusCode, 401); assert.equal(res.body.loginUrl, '/q/auth/monday');
  assert.match(res.body.error, /Sign in with Monday to check the client email copies — the shared admin key doesn’t say who you are/);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  res = fakeRes();
  await routes.check({ query: {} }, res, { staff: () => STAFF, isAdminEmail, service });
  assert.equal(res.statusCode, 403); assert.equal(res.body.error, 'Only admins can check the client email copies.');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(calls, 0, 'nothing is read for a refused viewer');
  res = fakeRes();
  await routes.check({ query: { sendId: '  abc  ' } }, res, { staff: () => ADMIN, isAdminEmail, service });
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.got, { sendId: 'abc' });
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  res = fakeRes();
  await routes.check({ query: { sendId: ['a', 'b'] } }, res, { staff: () => ADMIN, isAdminEmail, service });
  assert.deepEqual(res.body.got, { sendId: '' }, 'a repeated parameter is ignored');
  res = fakeRes();
  await routes.check({ query: {} }, res, { staff: () => ADMIN, isAdminEmail, service: { check: async () => { throw new Error('boom ana@example.com'); } } });
  assert.equal(res.statusCode, 500); assert.deepEqual(res.body, { error: 'The client email check could not run.' });
  // wiring: outside /api (the team key is not the gate), the Monday sign-in and the admin list handed in
  const server = read('src/server.js');
  assert.ok(server.includes("app.get('/admin/client-mail/check', (req, res) => require('./routes/clientMailRoutes').check(req, res, { staff: tryStaffAuth, isAdminEmail: caseAccess.isAdminEmail }));"));
});

/** The check service against a fake Graph. */
async function withGraph({ env = {}, get }, fn) {
  const keys = ['MS_FROM_EMAIL', 'CLIENT_MAIL_FROM'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const all = { MS_FROM_EMAIL: NOREPLY, CLIENT_MAIL_FROM: undefined, ...env };
  for (const k of keys) { if (all[k] === undefined) delete process.env[k]; else process.env[k] = all[k]; }
  const keepIo = { ...checkSvc.io };
  const h = { gets: [], drops: 0, logs: [] };
  const con = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => h.logs.push(a.join(' '));
  Object.assign(checkSvc.io, {
    token: async () => 'tok',
    dropToken: () => { h.drops++; },
    get: async (url, headers) => { h.gets.push({ url, headers }); return { data: await get(decodeURIComponent(url), h) }; },
  });
  mail._reset();
  try { return await fn(h); }
  finally {
    Object.assign(checkSvc.io, keepIo); Object.assign(console, con); mail._reset();
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const graphFail = (status, code) => { const e = new Error(`Request failed with status code ${status}`); e.response = { status, data: { error: { code, message: 'Mailbox ana.silva@example.com in query to:ana.silva@example.com not allowed' } } }; return e; };
const SEND_ID = '0b5a7a2e-1c1f-4b7e-9a51-3f6f1f0a2b9c';

test('check: switch on, Sent Items readable, the test copy found by its TdotSendId with the stamp fields that came back — counts and names only, no address anywhere', async () => {
  const back = new Set(['TdotTo', 'TdotKind', 'TdotSendId']);
  await withGraph({ env: { CLIENT_MAIL_FROM: OFFICE }, get: async (url) => {
    if (/\/mailFolders\/sentitems\?\$select=totalItemCount$/.test(url)) return { totalItemCount: 42 };
    if (/\/mailFolders\/sentitems\/messages\?\$filter=/.test(url)) return { value: [{ id: 'AAMkAD-x_1=' }] };
    const m = url.match(/\/messages\/AAMkAD-x_1=\?\$select=id&\$expand=singleValueExtendedProperties\(\$filter=id eq 'String \{ea1cfd10-69d2-41c0-a9fc-1fc4288e039e\} Name (\w+)'\)$/);
    if (m) return { id: 'AAMkAD-x_1=', ...(back.has(m[1]) ? { singleValueExtendedProperties: [{ id: `String {EA1CFD10-69D2-41C0-A9FC-1FC4288E039E} Name ${m[1]}`, value: 'v' }] } : {}) };
    throw new Error('unexpected ' + url);
  } }, async (h) => {
    const out = await checkSvc.check({ sendId: SEND_ID });
    assert.deepEqual(out, {
      ok: true, switchOn: true, settingIgnored: false, mailboxRead: 'CLIENT_MAIL_FROM', mailboxDomain: 'tdotimm.com',
      stampRefusedSinceRestart: false, sendAsRefusedInLastHour: false,
      sentItems: { readable: true, totalItemCount: 42 },
      copy: { via: 'unknown here — the test send answered it', found: 1, propertiesBack: ['TdotTo', 'TdotKind', 'TdotSendId'] },
    });
    const filter = h.gets.map((g) => decodeURIComponent(g.url)).find((u) => u.includes('$filter='));
    assert.ok(filter.startsWith('https://graph.microsoft.com/v1.0/users/info@tdotimm.com/mailFolders/sentitems/messages?$filter='));
    assert.ok(filter.includes(`singleValueExtendedProperties/Any(ep: ep/id eq 'String {ea1cfd10-69d2-41c0-a9fc-1fc4288e039e} Name TdotSendId' and ep/value eq '${SEND_ID}')&$select=id&$top=2`));
    assert.equal(h.gets.length, 2 + NAMES.length, 'one read per property name, one at a time');
    assert.ok(h.gets.every((g) => g.headers.Authorization === 'Bearer tok'));
    assert.doesNotMatch(JSON.stringify(out), /@/, 'no address in the answer (the domain line has no @)');
    assert.ok(h.logs.every((l) => !l.includes('@')));
  });
});

test('check: switch off → reads the office mailbox the test send uses; a 401 is retried once with a fresh token; Graph errors are status + code only — never Graph\'s message (it can repeat an address)', async () => {
  let n = 0;
  await withGraph({ get: async (url) => {
    if (url.includes('/mailFolders/sentitems?')) { if (++n === 1) throw graphFail(401, 'InvalidAuthenticationToken'); return { totalItemCount: 7 }; }
    throw graphFail(403, 'ErrorAccessDenied');
  } }, async (h) => {
    const out = await checkSvc.check({ sendId: SEND_ID });
    assert.equal(h.drops, 1); assert.equal(n, 2);
    assert.ok(h.gets[0].url.includes('/users/info%40tdotimm.com/'));
    assert.equal(out.switchOn, false); assert.equal(out.mailboxRead, 'the test default (switch off)');
    assert.deepEqual(out.sentItems, { readable: true, totalItemCount: 7 });
    assert.deepEqual(out.copy, { via: 'unknown here — the test send answered it', error: { status: 403, code: 'ErrorAccessDenied' } });
    assert.equal(out.ok, false);
    assert.doesNotMatch(JSON.stringify(out), /@|ana\.silva|not allowed/);
    assert.ok(h.logs.every((l) => !l.includes('@')));
  });
  await withGraph({ env: { CLIENT_MAIL_FROM: 'office@gmail.com' }, get: async () => { const e = new Error('getaddrinfo ENOTFOUND'); throw e; } }, async () => {
    const out = await checkSvc.check();
    assert.equal(out.settingIgnored, true); assert.equal(out.switchOn, false);
    assert.deepEqual(out.sentItems, { readable: false, status: 0, code: 'no-answer' });
    assert.equal(out.copy, undefined, 'no sendId → no copy look');
    assert.doesNotMatch(JSON.stringify(out), /@|gmail/);
  });
});

test('check: no copy found → found 0, not ok; a malformed sendId is refused before any Graph read', async () => {
  await withGraph({ env: { CLIENT_MAIL_FROM: OFFICE }, get: async (url) => (url.includes('sentitems?') ? { totalItemCount: 3 } : { value: [] }) }, async (h) => {
    let out = await checkSvc.check({ sendId: SEND_ID });
    assert.deepEqual(out.copy, { via: 'unknown here — the test send answered it', found: 0 });
    assert.equal(out.ok, false);
    const before = h.gets.length;
    out = await checkSvc.check({ sendId: "x' or 1 eq 1" });
    assert.deepEqual(out.copy, { via: 'unknown here — the test send answered it', error: { status: 0, code: 'bad-send-id' } });
    assert.equal(h.gets.length, before + 1, 'only the Sent Items count');
  });
});

test('check: reports the two memories (stamp refused since restart, send-as refused in the last hour)', async () => {
  await withMail({ env: { CLIENT_MAIL_FROM: OFFICE }, answers: [{ status: 400 }, 'ok', { status: 403 }] }, async (h) => {
    await mail.sendEmail({ ...MSG, tag: TAG });   // 400 → stamp-free resend → stamping off
    await mail.sendEmail({ ...MSG, tag: TAG });   // 403 → the usual way, remembered
    const keepIo = { ...checkSvc.io };
    Object.assign(checkSvc.io, { token: async () => 'tok', dropToken: () => {}, get: async () => ({ data: { totalItemCount: 1 } }) });
    try {
      let out = await checkSvc.check();
      assert.deepEqual([out.stampRefusedSinceRestart, out.sendAsRefusedInLastHour], [true, true]);
      h.now += 61 * 60 * 1000;
      out = await checkSvc.check();
      assert.deepEqual([out.stampRefusedSinceRestart, out.sendAsRefusedInLastHour], [true, false]);
    } finally { Object.assign(checkSvc.io, keepIo); }
  });
});
