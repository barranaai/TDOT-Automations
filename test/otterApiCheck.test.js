'use strict';
// Otter API key — the read-only check (Faran 2026-11-12): shapes only, never content, never the key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/otterApiService');

function world(env, answer) {
  const calls = [];
  const orig = { env: svc.io.env, get: svc.io.get };
  svc.io.env = () => env;
  svc.io.get = async (url, headers) => { calls.push({ url, headers }); return answer(url, headers); };
  return { calls, done() { svc.io.env = orig.env; svc.io.get = orig.get; } };
}
const KEY = 'sk-otter-SECRET-123456';

test('no key on the server: says so, calls nothing', async () => {
  const w = world({}, () => { throw new Error('must not be called'); });
  try {
    const r = await svc.check({ now: 0 });
    assert.equal(r.keyFound, false);
    assert.equal(w.calls.length, 0);
    assert.ok(r.looked.includes('OTTER_API_KEY'));
  } finally { w.done(); }
});

test('a working key: only the status and the shape come back — no title, no transcript, no key; GET on Otter\'s host only', async () => {
  const w = world({ OTTER_API_KEY: `  ${KEY}  ` }, (url) => {
    if (url.includes('/v1/conversations')) return { status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'abc', title: 'Jane Doe consultation', transcript: 'my passport number is X1', participants: [{ email: 'jane@example.com' }], duration: 1800 }], next_cursor: null }) };
    if (url.endsWith('/v1/workspace')) return { status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'TDOT', members: 4 }) };
    return { status: 404, contentType: 'text/html', body: '<html>Not Found</html>' };
  });
  try {
    const r = await svc.check({ now: 0 });
    const out = JSON.stringify(r);
    assert.equal(r.keyFound, true); assert.equal(r.keyName, 'OTTER_API_KEY'); assert.equal(r.keyLength, KEY.length); assert.equal(r.works, true);
    for (const leak of [KEY, 'Jane', 'passport', 'jane@example.com', 'TDOT"', 'abc']) assert.ok(!out.includes(leak), 'never in the answer: ' + leak);
    const conv = r.results.find((x) => x.path === '/v1/conversations');
    assert.deepEqual(conv.shape, { data: { array: 1, of: { id: 'string(3)', title: 'string(21)', transcript: 'string(24)', participants: 'array(1)', duration: 'number' } }, next_cursor: 'null' });
    assert.equal(r.results.find((x) => x.path === '/v1/speeches').status, 404);
    for (const c of w.calls) { assert.ok(c.url.startsWith('https://api.otter.ai/v1/'), c.url); assert.equal(c.headers.Authorization, `Bearer ${KEY}`, 'the trimmed key, Bearer first'); }
    assert.equal(w.calls.length, svc.PROBES.length, 'no second header style when Bearer is not refused');
  } finally { w.done(); }
});

test('a refused key: the other header style is tried once per address; the error words never repeat the key; a dropped connection is an answer, not a crash', async () => {
  const w = world({ OTTER_KEY: KEY }, (url, headers) => {
    if (url.endsWith('/v1/me')) { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; }
    if (headers['X-API-Key']) return { status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'forbidden' }) };
    return { status: 401, contentType: 'application/json', body: JSON.stringify({ message: `bad key ${KEY}` }) };
  });
  try {
    const r = await svc.check({ now: 0 });
    assert.equal(r.keyName, 'OTTER_KEY'); assert.equal(r.works, false);
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.ok(r.results.some((x) => x.auth === 'x-api-key' && x.status === 403));
    assert.ok(r.results.some((x) => x.says && x.says.includes('[key]')));
    const me = r.results.find((x) => x.path === '/v1/me');
    assert.equal(me.status, 0); assert.equal(me.says, 'ECONNRESET');
  } finally { w.done(); }
});

test('shapeOf: names and types only, bounded; the route is admin-only, never cached, GET', () => {
  assert.equal(svc.shapeOf('secret'), 'string(6)');
  assert.deepEqual(svc.shapeOf({ a: [1, 2], b: { c: { d: { e: 1 } } } }), { a: { array: 2, of: 'number' }, b: { c: { d: 'object' } } });
  const src = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(src, /app\.get\('\/admin\/otter\/api-check', async \(req, res\) => \{\s+res\.set\('Cache-Control', 'private, no-store'\);\s+if \(!resolveAdminOrReject\(req, res, 'Only an admin can check the Otter key\.'\)\) return;/);
  const s = fs.readFileSync(path.join(__dirname, '../src/services/otterApiService.js'), 'utf8');
  assert.ok(!/axios\.(post|put|patch|delete)/.test(s) && !/console\./.test(s), 'GET only, nothing logged');
});
