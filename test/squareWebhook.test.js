'use strict';

// Square webhook signature verification must be fail-CLOSED (an unset secret no
// longer accepts everything) and use a constant-time compare.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { verifySquareSignature } = require('../src/services/bookingService');

const URL  = 'https://example.com/webhook/square';
const BODY = '{"type":"payment.created","data":{}}';
const sign = (secret) => crypto.createHmac('sha256', secret).update(URL + BODY).digest('base64');

test('accepts a correctly-signed payload', () => {
  const prev = process.env.SQUARE_WEBHOOK_SECRET;
  process.env.SQUARE_WEBHOOK_SECRET = 'test-secret';
  try {
    assert.equal(verifySquareSignature(BODY, sign('test-secret'), URL), true);
  } finally { process.env.SQUARE_WEBHOOK_SECRET = prev; }
});

test('rejects a wrong / forged signature', () => {
  const prev = process.env.SQUARE_WEBHOOK_SECRET;
  process.env.SQUARE_WEBHOOK_SECRET = 'test-secret';
  try {
    assert.equal(verifySquareSignature(BODY, sign('other-secret'), URL), false);
    assert.equal(verifySquareSignature(BODY, 'not-even-base64', URL), false);
    assert.equal(verifySquareSignature(BODY, '', URL), false);
    assert.equal(verifySquareSignature(BODY, undefined, URL), false);
  } finally { process.env.SQUARE_WEBHOOK_SECRET = prev; }
});

test('fails CLOSED when the secret is unset (no longer accepts everything)', () => {
  const prev = process.env.SQUARE_WEBHOOK_SECRET;
  delete process.env.SQUARE_WEBHOOK_SECRET;
  try {
    assert.equal(verifySquareSignature(BODY, sign('anything'), URL), false);
  } finally { if (prev !== undefined) process.env.SQUARE_WEBHOOK_SECRET = prev; }
});

// ─── Domain cutover safety (app.tdotimm.com, 2026-08-04) ────────────────────
// Square signs with the SUBSCRIPTION's URL, which moves independently of
// RENDER_URL. Pointing RENDER_URL at the custom domain must NOT silently
// reject every payment webhook still arriving on the .onrender.com URL.

const { squareNotificationUrls } = require('../src/services/bookingService');

test('squareNotificationUrls: always includes the permanent .onrender.com origin', () => {
  const urls = squareNotificationUrls({});
  assert.deepEqual(urls, ['https://tdot-automations.onrender.com/webhook/square']);
});

test('squareNotificationUrls: after the RENDER_URL flip BOTH origins are accepted', () => {
  const urls = squareNotificationUrls({ RENDER_URL: 'https://app.tdotimm.com' });
  assert.deepEqual(urls, [
    'https://app.tdotimm.com/webhook/square',
    'https://tdot-automations.onrender.com/webhook/square',
  ]);
});

test('squareNotificationUrls: trailing slashes normalized, duplicates collapsed, override honoured', () => {
  assert.deepEqual(
    squareNotificationUrls({ RENDER_URL: 'https://tdot-automations.onrender.com/' }),
    ['https://tdot-automations.onrender.com/webhook/square'],
    'a trailing slash must not mint a second, subtly-different URL');
  const withOverride = squareNotificationUrls({ SQUARE_NOTIFICATION_URL: 'https://custom.example.com', RENDER_URL: 'https://app.tdotimm.com' });
  assert.equal(withOverride[0], 'https://custom.example.com/webhook/square', 'explicit override is tried first');
  assert.equal(withOverride.length, 3);
});

test('a webhook signed with the OLD onrender URL still verifies after RENDER_URL moves', () => {
  const prev = process.env.SQUARE_WEBHOOK_SECRET;
  process.env.SQUARE_WEBHOOK_SECRET = 'test-secret';
  try {
    const oldUrl = 'https://tdot-automations.onrender.com/webhook/square';
    const sigFromSquare = crypto.createHmac('sha256', 'test-secret').update(oldUrl + BODY).digest('base64');
    // RENDER_URL has been flipped to the custom domain:
    const urls = squareNotificationUrls({ RENDER_URL: 'https://app.tdotimm.com' });
    assert.ok(urls.some((u) => verifySquareSignature(BODY, sigFromSquare, u)),
      'the payment webhook is accepted — no silent payment blackout during the cutover');
    // and a forged signature is still rejected across every candidate
    const forged = crypto.createHmac('sha256', 'wrong-secret').update(oldUrl + BODY).digest('base64');
    assert.ok(!urls.some((u) => verifySquareSignature(BODY, forged, u)), 'authentication is not widened');
  } finally { process.env.SQUARE_WEBHOOK_SECRET = prev; }
});
