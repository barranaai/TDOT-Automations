'use strict';

// The consultation package must issue a REAL Documenso e-sign envelope for the
// agreement when e-sign is enabled (so signing auto-stamps consultAgreementSigned),
// and fall back to the legacy review-PDF link when disabled or the send fails.
// Discovered via lead 12578691420: the package path predated Documenso and sent a
// passive review link only, so a package-sent agreement could never record a signing.

const test   = require('node:test');
const assert = require('node:assert/strict');

const consultAgreementSvc = require('../src/services/consultAgreementService');
const consultationService = require('../src/services/consultationService');
const documenso           = require('../src/services/documensoService');
const leadService         = require('../src/services/leadService');
const microsoftMail       = require('../src/services/microsoftMailService');
const retainerDocService  = require('../src/services/retainerDocService');
const pdfConvertService   = require('../src/services/pdfConvertService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

function lead(extra = {}) {
  return { id: String(extra.id || '501'), fullName: 'Pack Test', email: 'pack@example.com',
    leadToken: 'tok', bookedSlot: '2026-08-01 10:00', consultAgreementSigned: '', ...extra };
}

// ─── maybeSendConsultEsign ────────────────────────────────────────────────────

test('maybeSendConsultEsign: null when e-sign is disabled (caller keeps the review link)', async () => {
  let sent = false;
  const restore = [
    stub(documenso, 'isEnabled', () => false),
    stub(documenso, 'sendForSignature', async () => { sent = true; return { envelopeId: 'e1' }; }),
  ];
  try {
    assert.equal(await consultAgreementSvc.maybeSendConsultEsign(lead()), null);
    assert.equal(sent, false);
  } finally { restore.forEach((x) => x()); }
});

test('maybeSendConsultEsign: sends the consult-<leadId> envelope when enabled + stamps Sent immediately', async () => {
  let call = null; const writes = [];
  const restore = [
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'sendForSignature', async (opts) => { call = opts; return { envelopeId: 'env-77' }; }),
    stub(retainerDocService, 'fillMaster', () => Buffer.from('docx')),
    stub(pdfConvertService, 'docxToPdf', async () => Buffer.from('pdf')),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
  ];
  try {
    const r = await consultAgreementSvc.maybeSendConsultEsign(lead({ id: '502' }));
    assert.deepEqual(r, { envelopeId: 'env-77' });
    assert.equal(call.externalId, 'consult-502', 'externalId ties the envelope back to the lead');
    assert.equal(call.signer.email, 'pack@example.com');
    assert.ok(writes.some((f) => f.consultAgreementSent), 'Sent stamped the moment the envelope is out (survives a later package-email failure)');
  } finally { restore.forEach((x) => x()); }
});

test('maybeSendConsultEsign: a failed Sent-stamp does NOT hide the successful envelope (no fallback double-email)', async () => {
  const restore = [
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'sendForSignature', async () => ({ envelopeId: 'env-78' })),
    stub(retainerDocService, 'fillMaster', () => Buffer.from('docx')),
    stub(pdfConvertService, 'docxToPdf', async () => Buffer.from('pdf')),
    stub(leadService, 'updateLead', async () => { throw new Error('monday 500'); }),
  ];
  try {
    const r = await consultAgreementSvc.maybeSendConsultEsign(lead({ id: '505' }));
    assert.deepEqual(r, { envelopeId: 'env-78' }, 'still reports the envelope — the client HAS the signing email');
  } finally { restore.forEach((x) => x()); }
});

test('maybeSendConsultEsign: alreadySigned — never re-issues an envelope for a signed agreement', async () => {
  let sent = false;
  const restore = [
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'sendForSignature', async () => { sent = true; return { envelopeId: 'e' }; }),
  ];
  try {
    const r = await consultAgreementSvc.maybeSendConsultEsign(lead({ consultAgreementSigned: '2026-07-20' }));
    assert.deepEqual(r, { alreadySigned: true });
    assert.equal(sent, false);
  } finally { restore.forEach((x) => x()); }
});

test('maybeSendConsultEsign: null (no throw) when the Documenso send fails — caller falls back', async () => {
  const restore = [
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'sendForSignature', async () => { throw new Error('documenso 500'); }),
    stub(retainerDocService, 'fillMaster', () => Buffer.from('docx')),
    stub(pdfConvertService, 'docxToPdf', async () => Buffer.from('pdf')),
  ];
  try {
    assert.equal(await consultAgreementSvc.maybeSendConsultEsign(lead({ id: '503' })), null);
  } finally { restore.forEach((x) => x()); }
});

// ─── sendConsultationPackage wiring ───────────────────────────────────────────

function packageStubs({ esignResult, mails, writes }) {
  return [
    stub(leadService, 'getLead', async (id) => lead({ id })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
    stub(consultAgreementSvc, 'ensureConsultAgreementReady', async () => ({ lead: lead(), url: 'https://x/agreement' })),
    stub(consultAgreementSvc, 'maybeSendConsultEsign', async () => esignResult),
    stub(microsoftMail, 'sendEmail', async (m) => { mails.push(m); }),
  ];
}

test('sendConsultationPackage: e-sign enabled → envelope path, preview wording, via documenso', async () => {
  const mails = [], writes = [];
  const restore = packageStubs({ esignResult: { envelopeId: 'env-9' }, mails, writes });
  try {
    const r = await consultationService.sendConsultationPackage('501');
    assert.equal(r.via, 'documenso');
    assert.equal(mails.length, 1, 'the package email still goes out');
    assert.match(mails[0].html, /separately for e-signature/, 'step 2 points at the signature-request email');
    assert.match(mails[0].html, /Preview consultation agreement/, 'agreement button becomes a preview');
    assert.ok(!/>Review consultation agreement</.test(mails[0].html), 'legacy review CTA not shown on the e-sign path');
    assert.match(mails[0].html, /complete both steps/, '24h disclaimer still covers both steps');
    assert.ok(!writes.some((f) => f.consultAgreementSent), 'no double-stamp — the helper stamps Sent at envelope time');
  } finally { restore.forEach((x) => x()); }
});

test('sendConsultationPackage: e-sign unavailable/failed → legacy review-link wording, via review-link', async () => {
  const mails = [], writes = [];
  const restore = packageStubs({ esignResult: null, mails, writes });
  try {
    const r = await consultationService.sendConsultationPackage('501');
    assert.equal(r.via, 'review-link');
    assert.match(mails[0].html, /Review consultation agreement/, 'legacy review CTA preserved');
    assert.ok(!/separately for e-signature/.test(mails[0].html));
    assert.ok(writes.some((f) => f.consultAgreementSent), 'fallback path stamps Sent itself (helper did not run)');
  } finally { restore.forEach((x) => x()); }
});

test('sendConsultationPackage: agreement already signed → coherent no-action email, Sent NOT re-stamped', async () => {
  const mails = [], writes = [];
  const restore = packageStubs({ esignResult: { alreadySigned: true }, mails, writes });
  try {
    const r = await consultationService.sendConsultationPackage('501');
    assert.equal(r.alreadySigned, true);
    assert.match(mails[0].html, /already signed/, 'tells the client no further action is needed');
    assert.ok(!/Review and sign/.test(mails[0].html));
    // The whole email must be coherent — no leftover "both steps" framing.
    assert.match(mails[0].html, /complete the step below/, 'header asks for the one remaining step');
    assert.match(mails[0].html, /pre-consultation form at least 24 hours/, '24h disclaimer only covers the form');
    assert.ok(!/complete both steps/.test(mails[0].html), 'no contradictory both-steps warning');
    assert.ok(!writes.some((f) => f.consultAgreementSent), 'Sent not moved past Signed on a re-send');
  } finally { restore.forEach((x) => x()); }
});

// ─── standalone sendConsultAgreement keeps working through the shared helper ──

test('sendConsultAgreement: already-signed lead → no envelope, no email, reports alreadySigned', async () => {
  const mails = [];
  let wrote = false;
  const restore = [
    stub(leadService, 'getLead', async (id) => lead({ id, consultAgreementSigned: '2026-07-20' })),
    stub(leadService, 'updateLead', async () => { wrote = true; }),
    stub(retainerDocService, 'fillMaster', () => Buffer.from('docx')),
    stub(pdfConvertService, 'docxToPdf', async () => Buffer.from('pdf')),
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'sendForSignature', async () => { throw new Error('must not be called'); }),
    stub(microsoftMail, 'sendEmail', async (m) => { mails.push(m); }),
  ];
  try {
    const r = await consultAgreementSvc.sendConsultAgreement('504');
    assert.equal(r.alreadySigned, true);
    assert.equal(mails.length, 0, 'no re-send email for a signed agreement');
    assert.equal(wrote, false, 'consultAgreementSent not re-stamped');
  } finally { restore.forEach((x) => x()); }
});
