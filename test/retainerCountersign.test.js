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

test('recipientSignUrl: builds the signing link from the envelope recipient token; silent on failure', () => {
  // getEnvelope is a module-internal call — stub the HTTP layer, not the export.
  const jsonResponse = (body) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => body });
  return withEnv({ DOCUMENSO_API_TOKEN: 'test-token' }, () =>
    withStubs([[global, 'fetch', async () => jsonResponse({ recipients: [{ token: 'tok123' }] })]], async () => {
      assert.equal(await documenso.recipientSignUrl('env-1'), 'https://app.documenso.com/sign/tok123');
    }).then(() => withStubs([[global, 'fetch', async () => jsonResponse({ recipients: [{ signingUrl: 'https://app.documenso.com/sign/direct' }] })]], async () => {
      assert.equal(await documenso.recipientSignUrl('env-1'), 'https://app.documenso.com/sign/direct');
    })).then(() => withStubs([[global, 'fetch', async () => { throw new Error('down'); }]], async () => {
      assert.equal(await documenso.recipientSignUrl('env-1'), '', 'the emailed link still reaches the signer');
    })));
});

test('countersign tab never dead-ends: without a signUrl the page opens the Documenso dashboard', () => {
  const { buildDetailHTML } = require('../src/routes/adminConsultation');
  const html = buildDetailHTML('777');
  assert.ok(html.includes("w.location='https://app.documenso.com/documents'"),
    'no-signUrl path lands the pre-opened tab on the dashboard instead of closing it');
});

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

  // Button-row semantics (user directive 2026-07-31):
  assert.ok(html.indexOf('id="btn-retainer-countersign"') < html.indexOf('id="btn-retainer-signed-view"'),
    'View signed retainer is LAST in the row');
  assert.ok(html.includes('rcBtn.disabled = RP_RC_DONE'),
    'countersign button DISABLES (not hides) once the consultant has signed');
  assert.ok(html.includes('.btn:disabled { opacity:.45; cursor:not-allowed; }'),
    'disabled buttons are visibly disabled');
  assert.ok(html.includes("if(!on && typeof applyRetainerLock==='function') applyRetainerLock();"),
    'gated disabled states survive the disableActions round-trip');
});

// ─── Auto-send the countersign envelope (user directive 2026-08-04) ──────────
// Previously the countersign waited for a human to notice a Monday note and
// click "Sign retainer as consultant" — a signed retainer could sit for days
// with nobody aware it was their turn. Now the client's signature issues the
// consultant's envelope automatically (Documenso emails them the signing link);
// the button stays as a manual fallback / re-open.

test('captureCompleted retainer (client): AUTO-issues the consultant countersign envelope', () => {
  const started = [];
  return withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: '' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerSigned: '', retainerCountersign: '' })],
      [leadService, 'updateLead', async () => {}],
      [oneDrive, 'ensureClientFolder', async () => {}],
      [oneDrive, 'uploadFile', async () => {}],
      [mondayApi, 'query', mondayStub],
      [rcSvc, 'startRetainerCountersign', async (leadId) => { started.push(String(leadId)); return { envelopeId: 'env-cs-new', signUrl: 'https://app.documenso.com/sign/abc' }; }],
    ], async () => {
      await documenso.captureCompleted({
        event: 'DOCUMENT_COMPLETED',
        payload: { externalId: 'retainer-777', envelopeId: 'env-real', envelopeItems: [{ id: 'item-real' }] },
      });
      assert.deepEqual(started, ['777'], 'the consultant envelope is issued without any staff click');
    }));
});

test('auto-send NEVER breaks the client-signature capture when it fails', () => {
  const updates = [];
  return withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: '' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerSigned: '', retainerCountersign: '' })],
      [leadService, 'updateLead', async (id, fields) => { updates.push(fields); }],
      [oneDrive, 'ensureClientFolder', async () => {}],
      [oneDrive, 'uploadFile', async () => {}],
      [mondayApi, 'query', mondayStub],
      [rcSvc, 'startRetainerCountersign', async () => { throw new Error('documenso down'); }],
    ], async () => {
      // Must NOT throw — the client's signature is still fully recorded.
      await documenso.captureCompleted({
        event: 'DOCUMENT_COMPLETED',
        payload: { externalId: 'retainer-777', envelopeId: 'env-real', envelopeItems: [{ id: 'item-real' }] },
      });
      assert.ok(updates.find((f) => f.retainerSigned), 'retainerSigned still stamped despite the auto-send failure');
    }));
});

test('a replayed client completion does NOT mint a second countersign envelope', () => {
  // Idempotency contract: startRetainerCountersign resumes an existing envelope
  // (resumed:true) and no-ops once countersigned (alreadySigned:true), so the
  // auto-send is safe against webhook replays and a racing staff click.
  const calls = [], notes = [];
  return withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: '' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerSigned: '2026-08-04',
        retainerCountersign: JSON.stringify({ envelopeId: 'env-cs-existing', sentAt: '2026-08-04' }) })],
      [leadService, 'updateLead', async () => {}],
      [oneDrive, 'ensureClientFolder', async () => {}],
      [oneDrive, 'uploadFile', async () => {}],
      [mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) { notes.push(String(vars.b || '')); return {}; } return mondayStub(q); }],
      [rcSvc, 'startRetainerCountersign', async () => { calls.push(1); return { envelopeId: 'env-cs-existing', resumed: true }; }],
    ], async () => {
      await documenso.captureCompleted({
        event: 'DOCUMENT_COMPLETED',
        payload: { externalId: 'retainer-777', envelopeId: 'env-real', envelopeItems: [{ id: 'item-real' }] },
      });
      assert.equal(calls.length, 1, 'called once');
      assert.equal(notes.filter((b) => /Countersign request sent/.test(b)).length, 0,
        'a RESUMED envelope posts no "sent" note — nothing new went out');
    }));
});

test('the countersign button reflects sent-vs-signed state', () => {
  const { buildDetailHTML } = require('../src/routes/adminConsultation');
  const html = buildDetailHTML('777');
  assert.ok(html.includes('RP_RC_SENT'), 'tracks the awaiting-consultant state');
  assert.ok(html.includes('Open countersign link'), 'button re-opens the signing page once sent');
  assert.ok(html.includes('rcBtn.disabled = RP_RC_DONE'), 'still DISABLES once countersigned');
  assert.ok(html.includes('class="btn-label"'), 'label span exists so the text can change');
});

// The four tests above stub startRetainerCountersign, so they prove the WIRING
// but not the service behind it. These drive the REAL service.

test('REAL service: concurrent auto-sends create ONE envelope, and the follower is marked coalesced', () => {
  let created = 0;
  return withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'tok' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerSigned: '2026-08-04', retainerCountersign: '' })],
      [leadService, 'updateLead', async () => {}],
      [oneDrive, 'readFile', async () => FAKE_PDF],
      [documenso, 'sendForSignature', async () => { created++; await new Promise((r) => setTimeout(r, 30)); return { envelopeId: 'env-1', envelopeItemId: 'item-1', signUrl: 'https://app.documenso.com/sign/t' }; }],
      [mondayApi, 'query', mondayStub],
    ], async () => {
      const [a, b] = await Promise.all([
        rcSvc.startRetainerCountersign('777'),
        rcSvc.startRetainerCountersign('777'),
      ]);
      assert.equal(created, 1, 'ONE envelope — the consultant is never emailed twice');
      assert.equal(a.envelopeId, 'env-1');
      assert.equal(b.envelopeId, 'env-1');
      assert.ok(a.coalesced || b.coalesced, 'the follower knows it did not cause the send (no duplicate note)');
      assert.ok(!(a.coalesced && b.coalesced), 'exactly one caller owns the send');
    }));
});

test('REAL service: a persist failure is REPORTED so staff are not told to re-click (which would double-email)', () => {
  return withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'tok' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerSigned: '2026-08-04', retainerCountersign: '' })],
      [leadService, 'updateLead', async () => { throw new Error('monday 500'); }],
      [oneDrive, 'readFile', async () => FAKE_PDF],
      [documenso, 'sendForSignature', async () => ({ envelopeId: 'env-orphan', envelopeItemId: 'i', signUrl: 'https://app.documenso.com/sign/t' })],
      [mondayApi, 'query', mondayStub],
    ], async () => {
      const r = await rcSvc.startRetainerCountersign('778');
      assert.equal(r.envelopeId, 'env-orphan');
      assert.equal(r.persistFailed, true,
        'the caller must be able to warn that the envelope went out but was not recorded');
    }));
});

test('REAL service: an already-countersigned lead issues NOTHING', () => {
  let created = 0;
  return withEnv({ DOCUMENSO_ENABLED: 'true', DOCUMENSO_API_TOKEN: 'tok' }, () =>
    withStubs([
      [leadService, 'getLead', async () => ({ ...BASE_LEAD, retainerSigned: '2026-08-04',
        retainerCountersign: JSON.stringify({ envelopeId: 'env-x', sentAt: '2026-08-04', signedAt: '2026-08-04' }) })],
      [documenso, 'sendForSignature', async () => { created++; return {}; }],
      [mondayApi, 'query', mondayStub],
    ], async () => {
      const r = await rcSvc.startRetainerCountersign('779');
      assert.equal(r.alreadySigned, true);
      assert.equal(created, 0, 'no envelope for a retainer that is already fully signed');
    }));
});
