'use strict';

// The "Ready" mark (Gauri A1, 2026-11-19: "Both are required"; Faran 2026-11-20): one word per booked consultation —
// is the consultation agreement signed and the pre-consultation form in? Display only. The pure rule (utils/consultReady.js).

const test   = require('node:test');
const assert = require('node:assert/strict');

const { consultReady, WORDS } = require('../src/utils/consultReady');

const fee = (over = {}) => JSON.stringify({ kind: 'cash', amountCents: 20000, on: '2026-11-18', by: 'Staff One', verified: true, ...over });
const direct = (kind, over = {}) => ({ directConsult: kind, consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, directConsult: { kind, inSquare: true, by: 'Staff Two', ...over } }) });

test('consultReady: the agreement and the form — ready, form, agreement, both', () => {
  assert.deepEqual(WORDS, ['ready', 'form', 'agreement', 'both', 'notsent', 'notasked']);
  assert.equal(consultReady({ consultAgreementSent: '2026-11-10', consultAgreementSigned: '2026-11-11', preConsultSubmitted: 'Yes' }), 'ready', 'signed + form');
  assert.equal(consultReady({ consultAgreementSent: '2026-11-10' }), 'both', 'sent only');
  assert.equal(consultReady({ consultAgreementSent: '2026-11-10', preConsultSubmitted: 'Yes' }), 'agreement', 'sent + form');
  assert.equal(consultReady({ consultAgreementSent: '2026-11-10', consultAgreementSigned: '2026-11-11' }), 'form', 'signed, no form');
  assert.equal(consultReady({ consultAgreementSigned: '2026-11-11' }), 'form', 'signed with a blank Sent date is still signed — never "not sent"');
  assert.equal(consultReady({ consultAgreementSigned: '2026-11-11', preConsultSubmitted: 'Yes' }), 'ready', 'the same, with the form in');
  // the form status is the board's "Yes" and nothing else
  for (const v of ['No', '', null, undefined, 'yes', 'Pending', true]) assert.equal(consultReady({ consultAgreementSigned: '2026-11-11', preConsultSubmitted: v }), 'form', JSON.stringify(v));
  assert.equal(consultReady({ consultAgreementSigned: '2026-11-11', preConsultSubmitted: ' Yes ' }), 'ready');
  // blanks are blanks
  assert.equal(consultReady({ consultAgreementSent: '  ', consultAgreementSigned: ' ' }), 'notsent');
});

test('consultReady: never sent — "notasked" only where staff chose not to send, else "notsent"', () => {
  assert.equal(consultReady({}), 'notsent', 'booked by hand in Monday, nothing else known');
  assert.equal(consultReady({ squareConsultTxnId: 'SQ1', consultOption: JSON.stringify({ durationMin: 30, feeCents: 20000, paidCents: 22600 }) }), 'notsent', 'paid by link, nothing sent (a held or failed package)');
  assert.equal(consultReady({ preConsultSubmitted: 'Yes' }), 'notsent', 'the form is in (the form reminder reached them) but the agreement was never sent');
  // a fee record
  assert.equal(consultReady({ consultPayment: fee({ package: 'skip', packageNote: 'has them already' }) }), 'notasked', 'staff recorded the fee and chose "No"');
  assert.equal(consultReady({ consultPayment: JSON.stringify({ kind: 'waived', on: '2026-11-18', by: 'Staff One', package: 'skip' }) }), 'notasked', 'waived, "No"');
  assert.equal(consultReady({ consultPayment: fee({ package: 'skip' }), squareConsultTxnId: 'SQ9' }), 'notsent', 'the same "No" record, then the client paid online: the app owes the package again');
  assert.equal(consultReady({ consultPayment: fee({ package: 'send' }) }), 'notsent', 'staff chose "Yes" and it has not gone out (held, failed)');
  assert.equal(consultReady({ consultPayment: fee() }), 'notsent', 'an old fee record with no choice');
  assert.equal(consultReady({ consultPayment: fee({ package: 'skip' }), consultAgreementSent: '2026-11-19' }), 'both', 'a "No" record followed by a later send');
  assert.equal(consultReady({ consultPayment: fee({ package: 'skip' }), consultAgreementSent: '2026-11-19', consultAgreementSigned: '2026-11-19', preConsultSubmitted: 'Yes' }), 'ready');
  // a direct consultation (＋ Direct consultation): the pop-up's own tick decides
  for (const kind of ['New', 'Follow-up', 'Existing client']) {
    assert.equal(consultReady(direct(kind)), 'notasked', kind + ': the box was left unticked');
    assert.equal(consultReady(direct(kind, { package: false })), 'notasked', kind + ': package false');
    assert.equal(consultReady({ ...direct(kind), squareConsultTxnId: 'SQ2' }), 'notasked', kind + ': a direct row without the tick stays not asked');
  }
  assert.equal(consultReady({ ...direct('New', { package: true }), consultPayment: fee({ kind: 'square', package: 'send' }) }), 'notsent', 'direct with the tick, nothing sent yet');
  assert.equal(consultReady({ ...direct('New', { package: true }), consultPayment: fee({ kind: 'square', package: 'send' }), consultAgreementSent: '2026-11-19' }), 'both', 'direct with the tick, sent');
  assert.equal(consultReady({ ...direct('New'), consultPayment: fee({ kind: 'square', package: 'skip' }) }), 'notasked', 'direct with a fee and no tick');
  assert.equal(consultReady({ directConsult: 'New' }), 'notasked', 'only the column marker (no detail readable): not asked');
  // The box was ticked, the fee record says "send", and the booking save failed after it: the tick itself never reached
  // the row (the marker is written with the booking). Staff did ask for the package, so the row is "not sent", not "not asked".
  assert.equal(consultReady({ directConsult: 'New', consultOption: '', consultPayment: fee({ kind: 'square', package: 'send' }) }), 'notsent', 'direct, the tick lost with the failed booking save');
  assert.equal(consultReady({ ...direct('New'), consultPayment: fee({ package: 'send' }) }), 'notsent', 'the same with a marker that carries no tick');
  assert.equal(consultReady({ directConsult: 'New', consultOption: '', consultPayment: fee({ package: 'send' }), consultAgreementSent: '2026-11-19' }), 'both', 'and once it is sent, the usual words');
  assert.equal(consultReady({ directConsult: 'New', consultOption: '', consultPayment: fee({ package: 'skip' }) }), 'notasked', 'the same row with a "No" record stays not asked');
  assert.equal(consultReady({ directConsult: 'New', consultOption: '', consultPayment: fee() }), 'notasked', 'and with a record that carries no choice');
  assert.equal(consultReady({ directConsult: 'New', consultOption: '' }), 'notasked', 'and with no record at all');
  assert.equal(consultReady({ directConsult: 'New', consultOption: '', consultPayment: '{"kind":"cash","package":"SEND"}' }), 'notasked', 'a choice that cannot be read is not a tick');
  assert.equal(consultReady({ consultOption: JSON.stringify({ directConsult: { kind: 'Follow-up', inSquare: false } }) }), 'notasked', 'only the consultOption marker');
  // signed or sent always wins over "not asked"
  assert.equal(consultReady({ ...direct('Existing client'), consultAgreementSigned: '2026-11-11', preConsultSubmitted: 'Yes' }), 'ready');
});

test('consultReady: text that cannot be read never throws, and is never taken as a staff choice', () => {
  const junk = ['{', 'not json', '[]', 'null', '42', '"skip"', '{"kind":"constructor","package":"skip"}', '{"kind":"__proto__","package":"skip"}', '{"package":"skip"}', '{"kind":"cash","package":"SKIP"}', '{"kind":"cash","package":["skip"]}'];
  for (const j of junk) {
    assert.equal(consultReady({ consultPayment: j }), 'notsent', 'consultPayment ' + j);
    assert.equal(consultReady({ consultOption: j }), 'notsent', 'consultOption ' + j);
    assert.equal(consultReady({ consultPayment: j, consultOption: j, consultAgreementSent: '2026-11-10' }), 'both');
  }
  // an unreadable consultOption that still names the direct marker counts as a direct row (the app's own fail-closed rule): not asked
  assert.equal(consultReady({ consultOption: '{"directConsult": {"kind":' }), 'notasked');
  for (const lead of [null, undefined, 0, '', 'text', [], { consultPayment: {} }, { consultPayment: 7, consultOption: [] }, { consultAgreementSent: Object.create(null), consultAgreementSigned: {}, preConsultSubmitted: [] }]) {
    let w; assert.doesNotThrow(() => { w = consultReady(lead); }, JSON.stringify(lead));
    assert.ok(WORDS.includes(w), String(w));
  }
  // every answer is one of the six words; the lead is never changed
  const lead = Object.freeze({ consultPayment: fee({ package: 'skip' }), consultOption: '{}', consultAgreementSent: '', preConsultSubmitted: 'Yes' });
  assert.equal(consultReady(lead), 'notasked');
});

test('consultReady: reads only what the list copy holds, makes no Monday call, and is not used for any decision that writes', () => {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(require.resolve('../src/utils/consultReady'), 'utf8');
  const fields = [...new Set([...src.matchAll(/\bl\.(\w+)/g)].map((m) => m[1]).concat([...src.matchAll(/lead && lead\.(\w+)/g)].map((m) => m[1])))].sort();
  assert.deepEqual(fields, ['consultAgreementSent', 'consultAgreementSigned', 'preConsultSubmitted', 'squareConsultTxnId']);
  const { SNAPSHOT_KEYS } = require('../src/services/leadSnapshot');
  for (const k of [...fields, 'consultPayment', 'consultOption']) assert.ok(SNAPSHOT_KEYS.includes(k), 'in the list copy: ' + k);
  assert.ok(!SNAPSHOT_KEYS.includes('consultCountersign'), 'the package hold / failed markers stay out of the list copy');
  for (const banned of ['mondayApi', 'leadService', 'updateLead', 'consultCountersign', 'process.env', 'fetch(', 'axios']) assert.ok(!src.includes(banned), 'not in the rule: ' + banned);
  // one caller in the app: the Consultations row builder (display only)
  const users = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (/\.js$/.test(f.name) && /consultReady/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(path.join(__dirname, '..', 'src'), p)); } };
  walk(path.join(__dirname, '..', 'src'));
  assert.deepEqual(users.sort(), ['routes/adminConsultation.js', 'routes/listSpecs.js', 'services/consultantPortalService.js', 'utils/consultReady.js']);
  const portal = fs.readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.equal((portal.match(/consultReady/g) || []).length, 2, 'used once, in consultRow');
  assert.ok(portal.includes("ready: require('../utils/consultReady').consultReady(l),"));
});
