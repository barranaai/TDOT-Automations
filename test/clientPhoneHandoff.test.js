'use strict';

// The Client Master row must carry the client's phone ("Client Contact Number",
// phone_mm33zr0c) — user report 2026-07-31: cases arrived with the phone blank.
// The write is separate from the create mutation so a weird phone format can
// never fail case creation.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { phoneColValue } = require('../src/services/handoffService');

test('phoneColValue: North American formats normalize to +1 with the CA flag', () => {
  assert.deepEqual(phoneColValue('416-555-0100'),    { phone: '+14165550100', countryShortName: 'CA' });
  assert.deepEqual(phoneColValue('(416) 555 0100'),  { phone: '+14165550100', countryShortName: 'CA' });
  assert.deepEqual(phoneColValue('1 416 555 0100'),  { phone: '+14165550100', countryShortName: 'CA' });
  assert.deepEqual(phoneColValue('+1 416 555 0100'), { phone: '+14165550100', countryShortName: 'CA' });
});

test('phoneColValue: international numbers pass through with a + prefix, no wrong flag', () => {
  assert.deepEqual(phoneColValue('+91 98765 43210'), { phone: '+919876543210' });
  assert.deepEqual(phoneColValue('919876543210'),    { phone: '+919876543210' });
});

test('phoneColValue: garbage and blanks never reach the board', () => {
  assert.equal(phoneColValue(''), null);
  assert.equal(phoneColValue(null), null);
  assert.equal(phoneColValue('n/a'), null);
  assert.equal(phoneColValue('12345'), null, 'fewer than 7 digits is not a phone number');
});
