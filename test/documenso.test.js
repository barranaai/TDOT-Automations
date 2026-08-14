'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const documenso = require('../src/services/documensoService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

// ─── externalId round-trip ────────────────────────────────────────────────────
test('externalId: builds and parses retainer/consult ids; rejects anything else', () => {
  assert.equal(documenso.externalIdFor('retainer', '123'), 'retainer-123');
  assert.deepEqual(documenso.parseExternalId('retainer-123'), { type: 'retainer', leadId: '123' });
  assert.deepEqual(documenso.parseExternalId('consult-99'), { type: 'consult', leadId: '99' });
  assert.equal(documenso.parseExternalId('random-1'), null);
  assert.equal(documenso.parseExternalId('retainer-abc'), null);
  assert.equal(documenso.parseExternalId(''), null);
  assert.equal(documenso.parseExternalId(null), null);
});

// ─── webhook verification (security-critical: fail-closed) ────────────────────
test('verifyWebhook: accepts the exact secret, rejects wrong/missing, and FAILS CLOSED when no secret configured', () => {
  withEnv({ DOCUMENSO_WEBHOOK_SECRET: 'sh-abc123' }, () => {
    assert.equal(documenso.verifyWebhook({ 'x-documenso-secret': 'sh-abc123' }), true);
    assert.equal(documenso.verifyWebhook({ 'X-Documenso-Secret': 'sh-abc123' }), true, 'header case-insensitive');
    assert.equal(documenso.verifyWebhook({ 'x-documenso-secret': 'wrong' }), false);
    assert.equal(documenso.verifyWebhook({ 'x-documenso-secret': 'sh-abc123x' }), false, 'length mismatch rejected');
    assert.equal(documenso.verifyWebhook({}), false, 'missing header rejected');
  });
  withEnv({ DOCUMENSO_WEBHOOK_SECRET: undefined }, () => {
    assert.equal(documenso.verifyWebhook({ 'x-documenso-secret': 'anything' }), false,
      'no secret configured → reject (an endpoint that opens cases must never be open)');
  });
});

// ─── enablement gating ────────────────────────────────────────────────────────
test('isEnabled: requires BOTH the flag AND a token', () => {
  withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'api_x' }, () => assert.equal(documenso.isEnabled(), true));
  withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: undefined }, () => assert.equal(documenso.isEnabled(), false));
  withEnv({ DOCUMENSO_ENABLED: 'false', DOCUMENSO_API_TOKEN: 'api_x' }, () => assert.equal(documenso.isEnabled(), false));
  withEnv({ DOCUMENSO_ENABLED: undefined, DOCUMENSO_API_TOKEN: 'api_x' }, () => assert.equal(documenso.isEnabled(), false));
});

// ─── capture: routing + state write (no network: externalId inline, no items) ─
test('signature anchor matches both templates (retainer + consult, incl. "Client :  Signature" spacing)', () => {
  // Mirrors SIG_ANCHOR — the signature block isn't the last PDF page (retainer
  // annexes follow it), so page detection keys on this text.
  const RE = /in witness thereof|signature of\b|client\s*:?\s*signature/i;
  assert.ok(RE.test('IN WITNESS THEREOF this Agreement has been duly executed'));
  assert.ok(RE.test('Signature of M Ikram Rana'), 'retainer client sig block');
  assert.ok(RE.test('Email: x@y.com     Client :   Signature ______________'), 'consult, tolerating the space-before-colon the extractor emits');
  assert.ok(!RE.test('ANNEX B — Fee Structure and Payment Schedule'), 'annex pages do not match');
});

test('captureCompleted: retainer completion sets Retainer Signed (which opens the case) + posts a note', async () => {
  const leadService = require('../src/services/leadService');
  const mondayApi   = require('../src/services/mondayApi');
  const writes = [], notes = [];
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Test Client', retainerSigned: '' })),
    stub(leadService, 'updateLead', async (id, fields) => { writes.push({ id, fields }); }),
    stub(mondayApi, 'query', async (q, vars) => { if (vars && vars.b) notes.push(vars.b); return {}; }),
  ];
  try {
    const r = await documenso.captureCompleted({
      event: 'DOCUMENT_COMPLETED',
      payload: { id: 55, externalId: 'retainer-777', status: 'COMPLETED', items: [] }, // no items → no download
    });
    assert.equal(r.type, 'retainer');
    assert.equal(r.leadId, '777');
    assert.ok(writes.some((w) => w.fields.retainerSigned), 'Retainer Signed date set → existing automation opens the case');
    assert.ok(notes.some((n) => /signed via Documenso/i.test(n)), 'audit note posted');
  } finally { restore.forEach((r) => r()); }
});

test('captureCompleted: consultation completion posts a note but does NOT set retainer signed', async () => {
  const leadService = require('../src/services/leadService');
  const mondayApi   = require('../src/services/mondayApi');
  const writes = [];
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'C', retainerSigned: '' })),
    stub(leadService, 'updateLead', async (id, fields) => { writes.push(fields); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await documenso.captureCompleted({ event: 'DOCUMENT_COMPLETED', payload: { externalId: 'consult-777', items: [] } });
    assert.equal(r.type, 'consult');
    assert.ok(!writes.some((f) => f.retainerSigned), 'consultation signing must not open a case');
    assert.ok(writes.some((f) => f.consultAgreementSigned), 'consult signed date IS stamped (its own column, no case opened)');
  } finally { restore.forEach((r) => r()); }
});

test('captureCompleted: ignores non-completed events and rejects an unresolved externalId', async () => {
  assert.deepEqual(await documenso.captureCompleted({ event: 'DOCUMENT_OPENED', payload: {} }), { skipped: 'DOCUMENT_OPENED' });
  const leadService = require('../src/services/leadService');
  const restore = stub(leadService, 'getLead', async () => { throw new Error('should not be called'); });
  try {
    await assert.rejects(
      documenso.captureCompleted({ event: 'DOCUMENT_COMPLETED', payload: { externalId: 'garbage', items: [] } }),
      /unresolved externalId/i
    );
  } finally { restore(); }
});

// ─── staff signature notification (team feedback 2026-08-13) ─────────────────

test('retainer completion emails the STAFF_SIGNATURE_NOTIFY_EMAILS list (best-effort)', async () => {
  const leadService   = require('../src/services/leadService');
  const mondayApi     = require('../src/services/mondayApi');
  const microsoftMail = require('../src/services/microsoftMailService');
  const mails = [];
  const prevEnv = process.env.STAFF_SIGNATURE_NOTIFY_EMAILS;
  process.env.STAFF_SIGNATURE_NOTIFY_EMAILS = 'kamal@tdotimm.com, ops@tdotimm.com';
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Sig Client', retainerSigned: '',
      confirmedCaseType: 'LMIA', assignedConsultant: 'Shafoli Kapur', retainerFee: '3000' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
    stub(microsoftMail, 'sendEmail', async (m) => { mails.push(m); }),
  ];
  try {
    await documenso.captureCompleted({
      event: 'DOCUMENT_COMPLETED',
      payload: { id: 56, externalId: 'retainer-778', status: 'COMPLETED', items: [] },
    });
    assert.equal(mails.length, 1, 'one notification email');
    assert.deepEqual(mails[0].to, ['kamal@tdotimm.com', 'ops@tdotimm.com']);
    assert.match(mails[0].subject, /Retainer signed — Sig Client \(LMIA\)/);
    assert.match(mails[0].html, /admin\/consultation\/778/, 'links to the consultation record');
  } finally {
    restore.forEach((r) => r());
    if (prevEnv === undefined) delete process.env.STAFF_SIGNATURE_NOTIFY_EMAILS;
    else process.env.STAFF_SIGNATURE_NOTIFY_EMAILS = prevEnv;
  }
});

test('signature notification: unset env = off; a mail failure never breaks the capture', async () => {
  const leadService   = require('../src/services/leadService');
  const mondayApi     = require('../src/services/mondayApi');
  const microsoftMail = require('../src/services/microsoftMailService');
  const prevEnv = process.env.STAFF_SIGNATURE_NOTIFY_EMAILS;
  let sends = 0;
  const base = [
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Sig Client', retainerSigned: '' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    delete process.env.STAFF_SIGNATURE_NOTIFY_EMAILS;
    let r1;
    {
      const restore = stub(microsoftMail, 'sendEmail', async () => { sends++; });
      try { r1 = await documenso.captureCompleted({ event: 'DOCUMENT_COMPLETED', payload: { id: 57, externalId: 'retainer-779', status: 'COMPLETED', items: [] } }); }
      finally { restore(); }
    }
    assert.equal(r1.type, 'retainer'); assert.equal(sends, 0, 'no env → no email');

    process.env.STAFF_SIGNATURE_NOTIFY_EMAILS = 'kamal@tdotimm.com';
    let r2;
    {
      const restore = stub(microsoftMail, 'sendEmail', async () => { throw new Error('graph 503'); });
      try { r2 = await documenso.captureCompleted({ event: 'DOCUMENT_COMPLETED', payload: { id: 58, externalId: 'retainer-780', status: 'COMPLETED', items: [] } }); }
      finally { restore(); }
    }
    assert.equal(r2.type, 'retainer', 'capture succeeds even when the notification email fails');
  } finally {
    base.forEach((r) => r());
    if (prevEnv === undefined) delete process.env.STAFF_SIGNATURE_NOTIFY_EMAILS;
    else process.env.STAFF_SIGNATURE_NOTIFY_EMAILS = prevEnv;
  }
});

test('REPLAY GUARD: an already-signed lead never re-triggers the staff notification', async () => {
  const leadService   = require('../src/services/leadService');
  const mondayApi     = require('../src/services/mondayApi');
  const microsoftMail = require('../src/services/microsoftMailService');
  const prevEnv = process.env.STAFF_SIGNATURE_NOTIFY_EMAILS;
  process.env.STAFF_SIGNATURE_NOTIFY_EMAILS = 'kamal@tdotimm.com';
  let mails = 0, stateWrites = 0;
  const restore = [
    // retainerSigned already set = a webhook redelivery or admin recapture
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Replayed Client', retainerSigned: '2026-08-01' })),
    stub(leadService, 'updateLead', async () => { stateWrites++; }),
    stub(mondayApi, 'query', async () => ({})),
    stub(microsoftMail, 'sendEmail', async () => { mails++; }),
  ];
  try {
    const r = await documenso.captureCompleted({
      event: 'DOCUMENT_COMPLETED',
      payload: { id: 59, externalId: 'retainer-781', status: 'COMPLETED', items: [] },
    });
    assert.equal(r.type, 'retainer');
    assert.equal(mails, 0, 'the email fires ONLY on the delivery that flips the signed state');
    assert.equal(stateWrites, 0, 'replay semantics identical to the state write');
  } finally {
    restore.forEach((r) => r());
    if (prevEnv === undefined) delete process.env.STAFF_SIGNATURE_NOTIFY_EMAILS;
    else process.env.STAFF_SIGNATURE_NOTIFY_EMAILS = prevEnv;
  }
});
