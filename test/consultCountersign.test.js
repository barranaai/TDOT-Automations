'use strict';

// RCIC countersign of the consultation agreement (user request 2026-07-30):
// after the CLIENT signs (consult-<leadId> envelope), the portal offers
// "Sign as consultant" — a SECOND Documenso envelope (consult2-<leadId>) built
// from the client-signed PDF with the routed consultant as its only signer.
// On its completion the fully-signed copy is stored + emailed to the client,
// and the pre-sign buttons (Preview / Review & send / Resend links) hide.

const test   = require('node:test');
const assert = require('node:assert/strict');

const documenso    = require('../src/services/documensoService');
const consultAgmt  = require('../src/services/consultAgreementService');
const leadService  = require('../src/services/leadService');
const oneDrive     = require('../src/services/oneDriveService');
const mail         = require('../src/services/microsoftMailService');
const mondayApi    = require('../src/services/mondayApi');
const portal       = require('../src/services/consultantPortalService');

const FAKE_PDF = Buffer.from('%PDF-1.4 fake');

function withStubs(overrides, fn) {
  const saved = [];
  for (const [obj, key, val] of overrides) {
    saved.push([obj, key, obj[key]]);
    obj[key] = val;
  }
  const restore = () => { for (const [obj, key, val] of saved.reverse()) obj[key] = val; };
  return Promise.resolve().then(fn).finally(restore);
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return Promise.resolve().then(fn).finally(restore);
}

// ─── externalId ──────────────────────────────────────────────────────────────

test('parseExternalId: consult2 is its own type; consult/retainer still parse', () => {
  assert.deepEqual(documenso.parseExternalId('consult2-123'), { type: 'consult2', leadId: '123' });
  assert.deepEqual(documenso.parseExternalId('consult-123'),  { type: 'consult',  leadId: '123' });
  assert.deepEqual(documenso.parseExternalId('retainer-9'),   { type: 'retainer', leadId: '9' });
  assert.equal(documenso.parseExternalId('consult3-1'), null);
  assert.equal(documenso.parseExternalId('consult2-'), null);
});

// ─── countersign state ───────────────────────────────────────────────────────

test('parseCountersign: JSON round-trip, junk-safe', () => {
  assert.deepEqual(consultAgmt.parseCountersign({ consultCountersign: '{"envelopeId":"e1","sentAt":"2026-07-30"}' }),
    { envelopeId: 'e1', sentAt: '2026-07-30' });
  assert.deepEqual(consultAgmt.parseCountersign({ consultCountersign: 'not json' }), {});
  assert.deepEqual(consultAgmt.parseCountersign({}), {});
  assert.deepEqual(consultAgmt.parseCountersign(null), {});
});

// ─── getSignedConsultPdf resolution (live-failure classes, 2026-07-31) ──────

test('getSignedConsultPdf: countersigned state with a BLANK item id recovers it from the envelope', () => {
  // Intake Test 5's live failure: {signedAt, envelopeId, itemId:""} skipped the
  // Documenso branch entirely and 404ed even though the envelope was complete.
  return withStubs([
    [documenso, 'getEnvelope', async (id) => { assert.equal(id, 'env-cs'); return { envelopeItems: [{ id: 'item-recovered' }] }; }],
    [documenso, 'downloadSignedPdf', async (id) => { assert.equal(id, 'item-recovered'); return FAKE_PDF; }],
    [oneDrive, 'uploadFile', async () => {}], // heal
  ], async () => {
    const pdf = await consultAgmt.getSignedConsultPdf({
      id: '555', fullName: 'X', consultCountersign: '{"envelopeId":"env-cs","itemId":"","signedAt":"2026-07-30"}',
    });
    assert.equal(pdf, FAKE_PDF);
  });
});

test('getSignedConsultPdf: a retained client\'s copy is found in the RENAMED case folder', () => {
  // Praj's live failure: the consult copy moved with the folder rename at
  // case-open ("Praj - 2026-VV-008"), but only the LEAD-named path was tried.
  const reads = [];
  return withStubs([
    [mondayApi, 'query', async () => ({ items: [{ column_values: [{ text: '2026-VV-008' }] }] })],
    [oneDrive, 'readFile', async (args) => { reads.push(args.caseRef); return args.caseRef === '2026-VV-008' ? FAKE_PDF : null; }],
  ], async () => {
    const pdf = await consultAgmt.getSignedConsultPdf({
      id: '555', fullName: 'Praj', clientMasterItemId: '888', consultCountersign: '',
    });
    assert.equal(pdf, FAKE_PDF);
    assert.deepEqual(reads, ['2026-VV-008'], 'case folder tried FIRST');
  });
});

// ─── startConsultCountersign ─────────────────────────────────────────────────

const BASE_LEAD = {
  id: '555', fullName: 'Sign Tester', email: 'client@x.com',
  assignedConsultant: 'Shermin Teymouri Mofrad',
  consultAgreementSigned: '2026-07-30',
};

test('startConsultCountersign: refuses while the client has not signed', () =>
  withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'test-token' }, () =>
    withStubs([[leadService, 'getLead', async () => ({ ...BASE_LEAD, consultAgreementSigned: '' })]], async () => {
      await assert.rejects(() => consultAgmt.startConsultCountersign('555'), /client has not signed/i);
    })));

test('startConsultCountersign: already countersigned → alreadySigned, no envelope', () =>
  withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'test-token' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, consultCountersign: '{"envelopeId":"e1","signedAt":"2026-07-30"}' })],
      [documenso, 'sendForSignature', async () => { throw new Error('must not be called'); }],
    ], async () => {
      assert.deepEqual(await consultAgmt.startConsultCountersign('555'), { alreadySigned: true });
    })));

test('startConsultCountersign: envelope already out → resumed with the stored signUrl, no duplicate', () =>
  withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'test-token' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, consultCountersign: '{"envelopeId":"e1","signUrl":"https://app.documenso.com/sign/x","sentAt":"2026-07-29"}' })],
      [documenso, 'sendForSignature', async () => { throw new Error('must not be called'); }],
    ], async () => {
      const r = await consultAgmt.startConsultCountersign('555');
      assert.deepEqual(r, { envelopeId: 'e1', signUrl: 'https://app.documenso.com/sign/x', resumed: true });
    })));

test('startConsultCountersign: issues consult2 envelope over the CLIENT-SIGNED pdf to the routed consultant', () =>
  withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'test-token' }, () => {
    const sent = [];
    const updates = [];
    return withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD })],
      [leadService, 'updateLead', async (id, fields) => { updates.push({ id, fields }); }],
      [oneDrive, 'readFile', async (args) => { sent.push({ read: args }); return FAKE_PDF; }],
      [documenso, 'sendForSignature', async (args) => { sent.push({ env: args }); return { envelopeId: 'env-9', envelopeItemId: 'item-9', signUrl: 'https://app.documenso.com/sign/9' }; }],
    ], async () => {
      const r = await consultAgmt.startConsultCountersign('555');
      assert.deepEqual(r, { envelopeId: 'env-9', signUrl: 'https://app.documenso.com/sign/9' });
      const env = sent.find((s) => s.env).env;
      assert.equal(env.externalId, 'consult2-555');
      assert.equal(env.signer.email, 'shermin@tdotimm.com', 'signer is the routed consultant, not the client');
      assert.equal(env.pdfBuffer, FAKE_PDF, 'countersign wraps the client-signed copy, not a fresh draft');
      const persisted = JSON.parse(updates[0].fields.consultCountersign);
      assert.equal(persisted.envelopeId, 'env-9');
      assert.ok(persisted.sentAt, 'sentAt stamped');
      assert.ok(!persisted.signedAt, 'not signed yet');
    });
  }));

// ─── captureCompleted (consult2 webhook) ─────────────────────────────────────

test('captureCompleted consult2: stamps countersign signedAt; with NO honest PDF it never emails a fake "fully signed" copy', () => {
  const updates = [];
  const emails  = [];
  const notes   = [];
  return withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: '' }, () => // token empty → every Documenso download fails safely, no network
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, consultCountersign: '{"envelopeId":"env-9","itemId":"item-9","sentAt":"2026-07-29"}' })],
      [leadService, 'updateLead', async (id, fields) => { updates.push({ id, fields }); }],
      [oneDrive, 'readFile', async () => FAKE_PDF],           // stale CLIENT-ONLY copy — must NOT be mailed as fully signed
      [oneDrive, 'ensureClientFolder', async () => {}],
      [oneDrive, 'uploadFile', async () => {}],
      [mail, 'sendEmail', async (args) => { emails.push(args); }],
      [mondayApi, 'query', async (_q, vars) => { notes.push((vars && vars.b) || ''); return {}; }],
    ], async () => {
      const r = await documenso.captureCompleted({
        event: 'DOCUMENT_COMPLETED',
        payload: { externalId: 'consult2-555', envelopeItems: [{ id: 'item-9' }] },
      });
      assert.equal(r.countersignSet, true);
      assert.equal(r.consultSignedSet, false, 'the CLIENT signed-date is not consult2 state');
      const stamped = updates.find((u) => u.fields.consultCountersign);
      assert.ok(stamped, 'countersign state written');
      const cs = JSON.parse(stamped.fields.consultCountersign);
      assert.ok(cs.signedAt, 'signedAt stamped');
      assert.equal(cs.envelopeId, 'env-9', 'existing state preserved');
      assert.ok(!updates.some((u) => 'consultAgreementSigned' in u.fields), 'client signed-date untouched');
      assert.equal(emails.length, 0, 'no countersigned PDF retrievable → no email (the stale client-only copy must never be sent as "fully signed")');
      assert.ok(notes.some((b) => /did NOT go out/i.test(b)), 'staff note flags the manual forward');
    }));
});

test('recordCountersignComplete: replayed completion is a no-op (no re-stamp, no duplicate client email)', () => {
  const emails = [], updates = [];
  return withStubs([
    [leadService, 'getLead', async () => ({ ...BASE_LEAD, consultCountersign: '{"envelopeId":"env-9","itemId":"item-9","signedAt":"2026-07-30"}' })],
    [leadService, 'updateLead', async (id, fields) => { updates.push(fields); }],
    [mail, 'sendEmail', async (args) => { emails.push(args); }],
    [mondayApi, 'query', async () => ({})],
  ], async () => {
    const lead = { ...BASE_LEAD, consultCountersign: '{"envelopeId":"env-9","itemId":"item-9","sentAt":"2026-07-29"}' }; // stale snapshot — fresh read wins
    const r = await consultAgmt.recordCountersignComplete(lead, { signedPdf: FAKE_PDF, stored: true });
    assert.equal(r.alreadyRecorded, true);
    assert.equal(r.signedAt, '2026-07-30', 'original signed date kept');
    assert.equal(updates.length, 0, 'nothing re-written');
    assert.equal(emails.length, 0, 'client not re-emailed');
  });
});

test('safeSignUrl: only https on the configured Documenso host survives', () => {
  assert.equal(consultAgmt.safeSignUrl('https://app.documenso.com/sign/abc'), 'https://app.documenso.com/sign/abc');
  assert.equal(consultAgmt.safeSignUrl('http://app.documenso.com/sign/abc'), '', 'plain http dropped');
  assert.equal(consultAgmt.safeSignUrl('https://evil.example.com/phish'), '', 'foreign host dropped');
  assert.equal(consultAgmt.safeSignUrl('javascript:alert(1)'), '', 'scheme smuggling dropped');
  assert.equal(consultAgmt.safeSignUrl(''), '');
});

test('startConsultCountersign: concurrent clicks share ONE envelope (in-flight lock)', () =>
  withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'test-token' }, () => {
    let sends = 0;
    return withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD })],
      [leadService, 'updateLead', async () => {}],
      [oneDrive, 'readFile', async () => FAKE_PDF],
      [documenso, 'sendForSignature', async () => {
        sends++;
        await new Promise((r) => setTimeout(r, 20)); // hold the window open
        return { envelopeId: 'env-race', envelopeItemId: 'item-race', signUrl: 'https://app.documenso.com/sign/r' };
      }],
    ], async () => {
      const [a, b] = await Promise.all([
        consultAgmt.startConsultCountersign('555'),
        consultAgmt.startConsultCountersign('555'),
      ]);
      assert.equal(sends, 1, 'second concurrent click must not mint a second envelope');
      assert.equal(a.envelopeId, 'env-race');
      assert.equal(b.envelopeId, 'env-race', 'both callers get the one envelope');
      assert.equal(a.signUrl, b.signUrl);
      // The follower is now TAGGED (coalesced) so the auto-send caller can tell
      // it didn't cause the send — two webhook deliveries must not both
      // announce "countersign request sent" for a single envelope.
      assert.ok(a.coalesced || b.coalesced, 'the follower is marked');
      assert.ok(!(a.coalesced && b.coalesced), 'exactly one caller owns the send');
    });
  }));

test('captureCompleted consult (client) completion records the COMPLETED envelope ids for the countersign fallback', () => {
  const updates = [];
  return withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: '' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, consultAgreementSigned: '', consultCountersign: '{"clientEnvelopeId":"stale-env","clientItemId":"stale-item"}' })],
      [leadService, 'updateLead', async (id, fields) => { updates.push(fields); }],
      [oneDrive, 'ensureClientFolder', async () => {}],
      [oneDrive, 'uploadFile', async () => {}],
      [mondayApi, 'query', async () => ({})],
    ], async () => {
      await documenso.captureCompleted({
        event: 'DOCUMENT_COMPLETED',
        payload: { externalId: 'consult-555', envelopeId: 'env-real', envelopeItems: [{ id: 'item-real' }] },
      });
      const u = updates.find((f) => f.consultAgreementSigned);
      assert.ok(u, 'client signed date stamped');
      const cs = JSON.parse(u.consultCountersign);
      assert.equal(cs.clientEnvelopeId, 'env-real', 'the envelope that ACTUALLY completed replaces any stale re-send ids');
      assert.equal(cs.clientItemId, 'item-real');
    }));
});

test('captureCompleted consult2: completion naming a different envelope than the recorded countersign is skipped', () => {
  const updates = [];
  return withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: '' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, consultCountersign: '{"envelopeId":"env-legit","itemId":"item-legit","sentAt":"2026-07-29"}' })],
      [leadService, 'updateLead', async (id, fields) => { updates.push(fields); }],
      [mail, 'sendEmail', async () => { throw new Error('must not email'); }],
      [mondayApi, 'query', async () => ({})],
    ], async () => {
      const r = await documenso.captureCompleted({
        event: 'DOCUMENT_COMPLETED',
        payload: { externalId: 'consult2-555', envelopeId: 'env-OTHER', envelopeItems: [{ id: 'item-x' }] },
      });
      assert.equal(r.skipped, 'consult2 envelope mismatch');
      assert.equal(updates.length, 0, 'no state stamped for a mismatched envelope');
    }));
});

test('recordCountersignComplete: with the countersigned PDF in hand, the client gets it attached', () => {
  const emails = [];
  return withStubs([
    [leadService, 'updateLead', async () => {}],
    [mail, 'sendEmail', async (args) => { emails.push(args); }],
    [mondayApi, 'query', async () => ({})],
  ], async () => {
    const lead = { ...BASE_LEAD, consultCountersign: '{"envelopeId":"env-9","itemId":"item-9","sentAt":"2026-07-29"}' };
    const r = await consultAgmt.recordCountersignComplete(lead, { signedPdf: FAKE_PDF, stored: true });
    assert.equal(r.emailed, true);
    assert.equal(emails.length, 1);
    assert.equal(emails[0].to, 'client@x.com');
    assert.equal(emails[0].attachments[0].filename, 'consultation-agreement-signed.pdf');
    assert.equal(emails[0].attachments[0].buffer, FAKE_PDF, 'the consult2 envelope PDF itself is attached');
    assert.match(emails[0].subject, /fully signed/i);
  });
});

// ─── portal action + payload + UI ────────────────────────────────────────────

test('validateAction accepts consultantSignAgreement', () => {
  assert.equal(portal.validateAction('consultantSignAgreement', null).ok, true);
});

test('consultation detail page: countersign buttons exist and pre-sign buttons hide on client signature', () => {
  const { buildDetailHTML } = require('../src/routes/adminConsultation');
  const html = buildDetailHTML('555');
  assert.ok(html.includes('id="btn-consult-signed-view"'), 'View signed agreement button present');
  assert.ok(html.includes('id="btn-consult-countersign"'), 'Sign as consultant button present');
  for (const id of ['btn-consult-preview', 'btn-consult-send']) {
    assert.ok(html.includes(`document.getElementById('${id}').style.display=caSigned?'none':''`),
      `${id} hides once the client has signed`);
  }
  // Resend links must SURVIVE the client signature (user decision 2026-07-30):
  // it re-sends the meeting + pre-consult form links, not the agreement.
  assert.ok(!html.includes("document.getElementById('btn-resend').style.display=caSigned"),
    'btn-resend stays visible after the client signs');
  assert.ok(html.includes("'· fully signed '"), 'fully-signed status line present');
  assert.ok(html.includes('consult-agreement-signed'), 'signed-PDF endpoint wired');
});

// ─── Auto-send the consult countersign (user directive 2026-08-04) ──────────
// Mirrors the retainer: the CLIENT's signature issues the consultant's
// envelope immediately (Documenso emails them), instead of waiting for someone
// to notice a Monday note and click "Sign as consultant".

const rcDocumenso = require('../src/services/documensoService');
const rcLead      = require('../src/services/leadService');
const rcSvcC      = require('../src/services/consultAgreementService');
const rcOneDrive  = require('../src/services/oneDriveService');
const rcMonday    = require('../src/services/mondayApi');

function autoStub(overrides, fn) {
  const saved = [];
  for (const [o, k, v] of overrides) { saved.push([o, k, o[k]]); o[k] = v; }
  return Promise.resolve().then(fn).finally(() => { for (const [o, k, v] of saved.reverse()) o[k] = v; });
}
const AUTO_LEAD = { id: '901', fullName: 'Auto Consult', email: 'c@x.co', assignedConsultant: 'Shermin Teymouri Mofrad', consultAgreementSigned: '', consultCountersign: '' };
const autoMonday = async (q) => (/column_values/.test(q) ? { items: [{ column_values: [{ text: '2026-XX-009' }] }] } : {});

test('captureCompleted consult (client): AUTO-issues the consultant countersign envelope', () => {
  const started = [];
  const prevEnabled = process.env.DOCUMENSO_ENABLED; process.env.DOCUMENSO_ENABLED = 'true';
  return autoStub([
    [rcLead, 'getLead', async () => ({ ...AUTO_LEAD })],
    [rcLead, 'updateLead', async () => {}],
    [rcOneDrive, 'ensureClientFolder', async () => {}],
    [rcOneDrive, 'uploadFile', async () => {}],
    [rcMonday, 'query', autoMonday],
    [rcSvcC, 'startConsultCountersign', async (id) => { started.push(String(id)); return { envelopeId: 'env-c-new', signUrl: 'https://app.documenso.com/sign/x' }; }],
  ], async () => {
    await rcDocumenso.captureCompleted({
      event: 'DOCUMENT_COMPLETED',
      payload: { externalId: 'consult-901', envelopeId: 'env-c', envelopeItems: [{ id: 'item-c' }] },
    });
    assert.deepEqual(started, ['901'], 'the consultant envelope goes out with no staff click');
  }).finally(() => { if (prevEnabled === undefined) delete process.env.DOCUMENSO_ENABLED; else process.env.DOCUMENSO_ENABLED = prevEnabled; });
});

test('consult auto-send failure NEVER breaks the client-signature capture', () => {
  const updates = [];
  const prevEnabled = process.env.DOCUMENSO_ENABLED; process.env.DOCUMENSO_ENABLED = 'true';
  return autoStub([
    [rcLead, 'getLead', async () => ({ ...AUTO_LEAD })],
    [rcLead, 'updateLead', async (id, f) => { updates.push(f); }],
    [rcOneDrive, 'ensureClientFolder', async () => {}],
    [rcOneDrive, 'uploadFile', async () => {}],
    [rcMonday, 'query', autoMonday],
    [rcSvcC, 'startConsultCountersign', async () => { throw new Error('documenso down'); }],
  ], async () => {
    await rcDocumenso.captureCompleted({
      event: 'DOCUMENT_COMPLETED',
      payload: { externalId: 'consult-901', envelopeId: 'env-c', envelopeItems: [{ id: 'item-c' }] },
    });
    assert.ok(updates.find((f) => f.consultAgreementSigned), 'the client signature is still recorded');
  }).finally(() => { if (prevEnabled === undefined) delete process.env.DOCUMENSO_ENABLED; else process.env.DOCUMENSO_ENABLED = prevEnabled; });
});

test('REAL consult service: concurrent auto-sends create ONE envelope; follower marked coalesced', () => {
  let created = 0;
  const prevTok = process.env.DOCUMENSO_API_TOKEN; process.env.DOCUMENSO_API_TOKEN = 'tok';
  const prevEnabled = process.env.DOCUMENSO_ENABLED; process.env.DOCUMENSO_ENABLED = 'true';
  return autoStub([
    [rcLead, 'getLead', async () => ({ ...AUTO_LEAD, consultAgreementSigned: '2026-08-04' })],
    [rcLead, 'updateLead', async () => {}],
    [rcOneDrive, 'readFile', async () => Buffer.from('%PDF-1.4 fake')],
    [rcDocumenso, 'sendForSignature', async () => { created++; await new Promise((r) => setTimeout(r, 25)); return { envelopeId: 'env-c1', envelopeItemId: 'i1', signUrl: 'https://app.documenso.com/sign/t' }; }],
    [rcMonday, 'query', autoMonday],
  ], async () => {
    const [a, b] = await Promise.all([
      rcSvcC.startConsultCountersign('901'),
      rcSvcC.startConsultCountersign('901'),
    ]);
    assert.equal(created, 1, 'ONE envelope — the consultant is never emailed twice');
    assert.ok(a.coalesced || b.coalesced, 'the follower knows it did not cause the send');
    assert.ok(!(a.coalesced && b.coalesced), 'exactly one caller owns the send');
  }).finally(() => {
    if (prevTok === undefined) delete process.env.DOCUMENSO_API_TOKEN; else process.env.DOCUMENSO_API_TOKEN = prevTok;
    if (prevEnabled === undefined) delete process.env.DOCUMENSO_ENABLED; else process.env.DOCUMENSO_ENABLED = prevEnabled;
  });
});

test('consult countersign button reports sent-vs-signed state', () => {
  const { buildDetailHTML } = require('../src/routes/adminConsultation');
  const html = buildDetailHTML('901');
  assert.ok(html.includes('var CS_RC_DONE=false, CS_RC_SENT=false;'), 'state vars declared (no ReferenceError)');
  assert.ok(html.includes('csBtn.disabled=CS_RC_DONE'), 'DISABLES once countersigned instead of vanishing');
  assert.ok(html.includes('Open countersign link'), 're-open state present');
});
