'use strict';

// Proves the core of the retainer generator: filling TDOT's REAL tagged master
// template (src/templates/retainer/pa.docx) produces a valid .docx with the
// merged values and NO leftover {tags}.

const test   = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');
const { PDFDocument } = require('pdf-lib');
const { fillMaster, appendPdf } = require('../src/services/retainerDocService');

async function makePdf(pages) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage();
  return Buffer.from(await d.save());
}

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

const INVITER_DATA = {
  ...DATA,
  inviterName:    'Inviter Holdings Ltd',
  inviterAddress: '9 King St W, Toronto, ON',
  inviterPhone:   '+1 905 555 0001',
  inviterEmail:   'inviter@example.com',
};

const EMPLOYER_DATA = {
  agreementDate:     '2026-06-24',
  empRepName:        'Jane Rep',
  empCompanyName:    'Acme Manufacturing Inc',
  empCompanyAddress: '1 Bay St, Toronto, ON M5J 2T3',
  empCompanyPhone:   '+1 416 555 0200',
  empRepPhone:       '+1 416 555 0201',
  empRepEmail:       'jane@acme.example.com',
  paymentAnnexNo:    'A-2',
  serviceFees:       '5,000.00',
  hst:               '650.00',
  total:             '5,650.00',
  govFee:            '1,000.00',
};

const LEFTOVER_TAG = /\{[a-z][a-zA-Z]+\}/; // any unfilled {camelCase} merge tag

test('pa-inviter: fills both PA and Inviter blocks, no leftover tags', () => {
  const xml = documentXml(fillMaster('pa-inviter', INVITER_DATA));
  for (const v of ['Barrana Test', '123 Main St, Toronto, ON', 'Inviter Holdings Ltd',
                   '9 King St W, Toronto, ON', '+1 905 555 0001', 'inviter@example.com']) {
    assert.ok(xml.includes(v), `pa-inviter output should contain "${v}"`);
  }
  assert.ok(!LEFTOVER_TAG.test(xml), 'no merge tag should survive');
});

test('employer (LMIA): fills rep + company blocks, no leftover tags', () => {
  const xml = documentXml(fillMaster('employer', EMPLOYER_DATA));
  for (const v of ['Jane Rep', 'Acme Manufacturing Inc', '1 Bay St, Toronto, ON M5J 2T3',
                   '+1 416 555 0200', '+1 416 555 0201', 'jane@acme.example.com', '5,650.00']) {
    assert.ok(xml.includes(v), `employer output should contain "${v}"`);
  }
  assert.ok(!LEFTOVER_TAG.test(xml), 'no merge tag should survive');
});

test('appendPdf concatenates master + annex pages', async () => {
  const out = await appendPdf(await makePdf(2), await makePdf(3));
  assert.equal((await PDFDocument.load(out)).getPageCount(), 5);
});

test('appendPdf with no annex returns the master unchanged', async () => {
  const out = await appendPdf(await makePdf(2), null);
  assert.equal((await PDFDocument.load(out)).getPageCount(), 2);
});
