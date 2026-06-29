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
