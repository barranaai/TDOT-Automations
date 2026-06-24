'use strict';

// Proves the core of the retainer generator: filling TDOT's REAL tagged master
// template (src/templates/retainer/pa.docx) produces a valid .docx with the
// merged values and NO leftover {tags}.

const test   = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');
const { fillMaster } = require('../src/services/retainerDocService');

const DATA = {
  agreementDate:   '2026-06-24',
  paName:          'Barrana Test',
  paAddress:       '123 Main St, Toronto, ON',
  paPhone:         '+1 416 555 0100',
  paEmail:         'barrana@example.com',
  applicationType: 'Canadian Experience Class',
  scopeAnnexNo:    'A-1',
  paymentAnnexNo:  'A-2',
  serviceFees:     '2,500.00',
  hst:             '325.00',
  total:           '2,825.00',
  govFee:          '1,590.00',
};

function documentXml(buf) {
  return new PizZip(buf).file('word/document.xml').asText();
}

test('fills the real PA master template with all merge values', () => {
  const xml = documentXml(fillMaster('pa', DATA));
  for (const v of ['Barrana Test', '123 Main St, Toronto, ON', '+1 416 555 0100',
                   'barrana@example.com', 'Canadian Experience Class', '2,500.00', '325.00',
                   '2,825.00', '1,590.00']) {
    assert.ok(xml.includes(v), `output should contain "${v}"`);
  }
});

test('no merge tags survive in the output (every placeholder was filled)', () => {
  const xml = documentXml(fillMaster('pa', DATA));
  for (const tag of ['{agreementDate}', '{paName}', '{paAddress}', '{paPhone}', '{paEmail}',
                     '{applicationType}', '{scopeAnnexNo}', '{paymentAnnexNo}', '{serviceFees}',
                     '{hst}', '{total}', '{govFee}']) {
    assert.ok(!xml.includes(tag), `output must not contain leftover ${tag}`);
  }
});

test('missing fields render blank, never throw (nullGetter)', () => {
  assert.doesNotThrow(() => fillMaster('pa', { paName: 'Solo Field Only' }));
});

test('still a valid docx zip (has the core parts)', () => {
  const zip = new PizZip(fillMaster('pa', DATA));
  assert.ok(zip.file('word/document.xml'), 'word/document.xml present');
  assert.ok(zip.file('[Content_Types].xml'), 'content types present');
});
