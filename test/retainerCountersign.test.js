'use strict';

// RCIC countersign of the RETAINER agreement (user request 2026-07-31), mirror
// of the consultation countersign: after the CLIENT signs (retainer-<leadId>),
// the portal offers "Sign retainer as consultant" — a SECOND envelope
// (retainer2-<leadId>) over the client-signed PDF, field ANCHORED to the
// "Signature of RCIC" label. Completion stores the fully-signed copy to the
// RENAMED case folder and emails it to the client.

const test   = require('node:test');
const assert = require('node:assert/strict');

const documenso   = require('../src/services/documensoService');
const rcSvc       = require('../src/services/retainerCountersignService');
const leadService = require('../src/services/leadService');
const oneDrive    = require('../src/services/oneDriveService');
const mail        = require('../src/services/microsoftMailService');
const mondayApi   = require('../src/services/mondayApi');
const portal      = require('../src/services/consultantPortalService');

const FAKE_PDF = Buffer.from('%PDF-1.4 fake');

function withStubs(overrides, fn) {
  const saved = [];
  for (const [obj, key, val] of overrides) { saved.push([obj, key, obj[key]]); obj[key] = val; }
  const restore = () => { for (const [obj, key, val] of saved.reverse()) obj[key] = val; };
  return Promise.resolve().then(fn).finally(restore);
}
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return Promise.resolve().then(fn).finally(restore);
}

const BASE_LEAD = {
  id: '777', fullName: 'Retainer Tester', email: 'client@x.com',
  assignedConsultant: 'Shermin Teymouri Mofrad',
  retainerSigned: '2026-07-31', clientMasterItemId: '888',
};
// Stub Monday: the case-ref read (candidateFolderRefs) + notes.
const mondayStub = async (q) => /column_values/.test(q)
  ? { items: [{ column_values: [{ text: '2026-XX-001' }] }] }
  : {};

test('parseExternalId: retainer2 is its own type — never swallowed by retainer', () => {
  assert.deepEqual(documenso.parseExternalId('retainer2-9'), { type: 'retainer2', leadId: '9' });
  assert.deepEqual(documenso.parseExternalId('retainer-9'),  { type: 'retainer',  leadId: '9' });
  assert.equal(documenso.parseExternalId('retainer3-9'), null);
});

test('parseRetainerCountersign: junk-safe', () => {
  assert.deepEqual(rcSvc.parseRetainerCountersign({ retainerCountersign: '{"envelopeId":"e"}' }), { envelopeId: 'e' });
  assert.deepEqual(rcSvc.parseRetainerCountersign({ retainerCountersign: 'junk' }), {});
  assert.deepEqual(rcSvc.parseRetainerCountersign(null), {});
});

test('startRetainerCountersign: refuses while the client has not signed', () =>
  withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'test-token' }, () =>
    withStubs([[leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerSigned: '' })]], async () => {
      await assert.rejects(() => rcSvc.startRetainerCountersign('777'), /client has not signed/i);
    })));

test('startRetainerCountersign: issues retainer2 over the CLIENT-SIGNED pdf, anchored to the RCIC line', () =>
  withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'test-token' }, () => {
    const updates = []; let envArgs = null;
    return withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD })],
      [leadService, 'updateLead', async (id, fields) => { updates.push(fields); }],
      [mondayApi, 'query', mondayStub],
      [oneDrive, 'readFile', async () => FAKE_PDF],
      [documenso, 'sendForSignature', async (a) => { envArgs = a; return { envelopeId: 'renv-1', envelopeItemId: 'ritem-1', signUrl: 'https://app.documenso.com/sign/r1' }; }],
    ], async () => {
      const r = await rcSvc.startRetainerCountersign('777');
      assert.deepEqual(r, { envelopeId: 'renv-1', signUrl: 'https://app.documenso.com/sign/r1' });
      assert.equal(envArgs.externalId, 'retainer2-777');
      assert.equal(envArgs.signer.email, 'shermin@tdotimm.com', 'signer is the routed consultant');
      assert.equal(envArgs.pdfBuffer, FAKE_PDF, 'wraps the client-signed copy, not a fresh render');
      assert.ok(envArgs.signatureAnchorItem.anchors.some((a) => a.test('Signature of RCIC')), 'field anchors to the RCIC label');
      const st = JSON.parse(updates[0].retainerCountersign);
      assert.equal(st.envelopeId, 'renv-1');
      assert.ok(st.sentAt && !st.signedAt);
    });
  }));

test('startRetainerCountersign: already out → resumed; already signed → alreadySigned; never a duplicate', () =>
  withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'test-token' }, () =>
    withStubs([
      [documenso, 'sendForSignature', async () => { throw new Error('must not be called'); }],
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerCountersign: '{"envelopeId":"e1","signUrl":"https://app.documenso.com/s/x","sentAt":"2026-07-30"}' })],
    ], async () => {
      assert.deepEqual(await rcSvc.startRetainerCountersign('777'),
        { envelopeId: 'e1', signUrl: 'https://app.documenso.com/s/x', resumed: true });
    }).then(() =>
    withStubs([
      [documenso, 'sendForSignature', async () => { throw new Error('must not be called'); }],
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerCountersign: '{"envelopeId":"e1","signedAt":"2026-07-31"}' })],
    ], async () => {
      assert.deepEqual(await rcSvc.startRetainerCountersign('777'), { alreadySigned: true });
    }))));

test('recordRetainerCountersignComplete: emails the fully-signed copy; replays are no-ops', () => {
  const emails = [];
  return withStubs([
    [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerCountersign: '{"envelopeId":"e1","itemId":"i1","sentAt":"2026-07-30"}' })],
    [leadService, 'updateLead', async () => {}],
    [mondayApi, 'query', mondayStub],
    [oneDrive, 'uploadFile', async () => {}],
    [mail, 'sendEmail', async (a) => { emails.push(a); }],
  ], async () => {
    const lead = { ...BASE_LEAD, retainerCountersign: '{"envelopeId":"e1","itemId":"i1","sentAt":"2026-07-30"}' };
    const r = await rcSvc.recordRetainerCountersignComplete(lead, { signedPdf: FAKE_PDF, stored: false });
    assert.equal(r.emailed, true);
    assert.equal(emails[0].attachments[0].filename, 'retainer-agreement-signed.pdf');
    assert.match(emails[0].subject, /fully signed .* retainer/i);
  }).then(() => withStubs([
    [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerCountersign: '{"envelopeId":"e1","itemId":"i1","signedAt":"2026-07-31"}' })],
    [leadService, 'updateLead', async () => { throw new Error('must not re-write'); }],
    [mail, 'sendEmail', async () => { throw new Error('must not re-email'); }],
  ], async () => {
    const r = await rcSvc.recordRetainerCountersignComplete({ ...BASE_LEAD }, { signedPdf: FAKE_PDF });
    assert.equal(r.alreadyRecorded, true);
  }));
});

test('captureCompleted retainer2: mismatched envelope skipped; client retainerSigned untouched', () => {
  const updates = [];
  return withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: '' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerCountersign: '{"envelopeId":"env-legit","itemId":"i1","sentAt":"2026-07-30"}' })],
      [leadService, 'updateLead', async (id, fields) => { updates.push(fields); }],
      [mail, 'sendEmail', async () => { throw new Error('must not email'); }],
      [mondayApi, 'query', mondayStub],
    ], async () => {
      const r = await documenso.captureCompleted({
        event: 'DOCUMENT_COMPLETED',
        payload: { externalId: 'retainer2-777', envelopeId: 'env-OTHER', envelopeItems: [{ id: 'ix' }] },
      });
      assert.equal(r.skipped, 'retainer2 envelope mismatch');
      assert.equal(updates.length, 0, 'nothing stamped for a mismatched envelope');
    }));
});

test('captureCompleted retainer (client): stamps retainerSigned AND records the completed envelope ids', () => {
  const updates = [];
  return withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: '' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerSigned: '', retainerCountersign: '' })],
      [leadService, 'updateLead', async (id, fields) => { updates.push(fields); }],
      [oneDrive, 'ensureClientFolder', async () => {}],
      [oneDrive, 'uploadFile', async () => {}],
      [mondayApi, 'query', mondayStub],
    ], async () => {
      await documenso.captureCompleted({
        event: 'DOCUMENT_COMPLETED',
        payload: { externalId: 'retainer-777', envelopeId: 'env-real', envelopeItems: [{ id: 'item-real' }] },
      });
      const w = updates.find((f) => f.retainerSigned);
      assert.ok(w, 'retainer signed stamped');
      const rc = JSON.parse(w.retainerCountersign);
      assert.equal(rc.clientEnvelopeId, 'env-real');
      assert.equal(rc.clientItemId, 'item-real');
    }));
});

test('portal: consultantSignRetainer action valid; detail page carries the retainer countersign UI', () => {
  assert.equal(portal.validateAction('consultantSignRetainer', null).ok, true);
  const { buildDetailHTML } = require('../src/routes/adminConsultation');
  const html = buildDetailHTML('777');
  assert.ok(html.includes('id="btn-retainer-signed-view"'), 'View signed retainer button present');
  assert.ok(html.includes('id="btn-retainer-countersign"'), 'Sign retainer as consultant button present');
  assert.ok(html.includes('retainer-agreement-signed'), 'signed-retainer endpoint wired');
  assert.ok(html.includes("'consultantSignRetainer'"), 'countersign action wired');
  assert.ok(html.includes('Retainer countersigned'), 'status row shows the countersign date');
});
