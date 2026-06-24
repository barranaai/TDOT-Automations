'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');
const { buildConsultAgreementData } = require('../src/services/consultAgreementService');
const { fillMaster } = require('../src/services/retainerDocService');

test('buildConsultAgreementData maps a lead to consult merge data', () => {
  const { data, warnings } = buildConsultAgreementData({
    fullName: 'Aarav Sharma', residentialAddress: '88 Harbour St, Toronto', phone: '4165551234',
    email: 'a@b.com', bookedSlot: '2026-06-20 14:00',
  });
  assert.equal(data.paName, 'Aarav Sharma');
  assert.equal(data.paAddress, '88 Harbour St, Toronto');
  assert.equal(data.amountPaid, '200.00');          // default $200 consult fee
  assert.equal(data.consultDurationMins, '30 minutes');
  assert.equal(data.consultationDate, 'June 20, 2026'); // from bookedSlot date portion
  assert.equal(data.paPhone, '4165551234');
  assert.equal(data.paEmail, 'a@b.com');
  assert.equal(warnings.length, 0);
});

test('buildConsultAgreementData warns on blank address / email / date', () => {
  const { warnings } = buildConsultAgreementData({ fullName: 'X' });
  assert.ok(warnings.some((w) => /address/i.test(w)));
  assert.ok(warnings.some((w) => /email/i.test(w)));
  assert.ok(warnings.some((w) => /date/i.test(w)));
});

test('consult template fills with merge values and no leftover tags', () => {
  const { data } = buildConsultAgreementData({
    fullName: 'Aarav Sharma', residentialAddress: '88 Harbour St', phone: '416', email: 'a@b.com', bookedSlot: '2026-06-20',
  });
  const xml = new PizZip(fillMaster('consult', data)).file('word/document.xml').asText();
  assert.ok(xml.includes('Aarav Sharma'));
  assert.ok(xml.includes('200.00'));
  assert.ok(xml.includes('June 20, 2026'));
  assert.ok(!/\{[a-z][a-zA-Z]+\}/.test(xml), 'no merge tag should survive');
});
