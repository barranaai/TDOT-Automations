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

// ─── One-page agreement: both e-signature fields follow the real signature lines ──
//
// The template was tightened to a single page (2026-09-13). Documenso places
// each field relative to the rendered "Signature ____" text, so the client's
// field cannot land on the RCIC's line if the layout ever reflows again.

test('the consult signature anchor finds the client line first and the RCIC line second, whatever the RCIC label', () => {
  const { anchorHitFromPages } = require('../src/services/documensoService');
  const src = require('fs').readFileSync(require.resolve('../src/services/consultAgreementService'), 'utf8');
  const m = /const CONSULT_SIGNATURE_ANCHOR = \(occurrence\) => \(\{ anchors: \[(\/.*?\/i)\], occurrence, gapPct: ([\d.]+) \}\)/.exec(src);
  assert.ok(m, 'the shared anchor is defined once');
  const anchor = eval(m[1]);   // the same regex the service uses
  // Exactly how LibreOffice (CloudConvert) and Word emit the signature block —
  // the label and the "Signature ____" run are separate items on one baseline.
  const page = [
    { str: 'E-mail: someone@example.com', yTopPct: 75.5 },
    { str: 'Client', yTopPct: 82.3 }, { str: ':   Signature ______________________________', yTopPct: 82.3 }, { str: 'September 13, 2026', yTopPct: 82.3 },
    { str: 'RCIC', yTopPct: 86.4 }, { str: '-', yTopPct: 86.4 }, { str: 'IRB', yTopPct: 86.4 }, { str: ':  Signature _________________________', yTopPct: 86.4 }, { str: '_____', yTopPct: 86.4 },
    { str: 'https://college-ic.ca/', yTopPct: 92.5 },
  ];
  assert.deepEqual(anchorHitFromPages([page], [anchor], 1), { page: 1, yTopPct: 82.3 }, 'occurrence 1 = the client line');
  assert.deepEqual(anchorHitFromPages([page], [anchor], 2), { page: 1, yTopPct: 86.4 }, 'occurrence 2 = the RCIC line');
  // A plain "RCIC" label (no -IRB) changes nothing — the label is never matched.
  const plain = page.map((it) => (it.str === 'IRB' || it.str === '-' ? { str: '', yTopPct: it.yTopPct } : it));
  assert.deepEqual(anchorHitFromPages([plain], [anchor], 2), { page: 1, yTopPct: 86.4 });
  assert.equal(Number(m[2]), 0.5, 'the field bottom sits just above the underline');
});

test('pins: both consult envelopes are anchored (client = occurrence 1, countersign = occurrence 2), fields 4% tall so they cannot overlap', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/consultAgreementService'), 'utf8');
  const client = src.indexOf("externalIdFor('consult', lead.id)");
  const counter = src.indexOf("externalIdFor('consult2', lead.id)");
  assert.ok(client > 0 && counter > client);
  const clientBlock = src.slice(client, client + 900), counterBlock = src.slice(counter, counter + 900);
  assert.match(clientBlock, /signatureAnchorItem: CONSULT_SIGNATURE_ANCHOR\(1\)/);
  assert.match(counterBlock, /signatureAnchorItem: CONSULT_SIGNATURE_ANCHOR\(2\)/);
  assert.match(clientBlock, /height: 4 \}/); assert.match(counterBlock, /height: 4 \}/);
});

test('the agreement template fits ONE page: the RCIC signature line follows the client line on page 1', () => {
  // Layout facts of the tightened template (wording untouched): no blank spacer
  // paragraph between the two signature lines, and 0.625" bottom margin.
  const xml = new PizZip(fillMaster('consult', buildConsultAgreementData({ fullName: 'A', residentialAddress: 'B', phone: 'C', email: 'd@e.f', bookedSlot: '2026-06-20' }).data)).file('word/document.xml').asText();
  const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g);
  const text = (p) => p.replace(/<[^>]+>/g, '').trim();
  const sig = paras.map(text).map((t, i) => [t, i]).filter(([t]) => /Signature _{5,}/.test(t)).map(([, i]) => i);
  assert.equal(sig.length, 2, 'two signature lines');
  assert.equal(sig[1] - sig[0], 1, 'adjacent — the spacer paragraph that pushed the RCIC line to page 2 is gone');
  assert.match(xml, /<w:pgMar[^>]*w:bottom="820"/, 'bottom margin 0.57in');
});
