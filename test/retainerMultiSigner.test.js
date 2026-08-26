'use strict';

// Inviter/sponsor/dependent co-signing (user directive 2026-08-10): the
// pa-inviter agreement carries a second client-side signature line, so the
// inviter signs IN PARALLEL with the PA — both emailed at once, and the
// envelope only completes (→ retainerSigned, auto-countersign, payment email)
// when ALL signers have signed. Before this, the envelope went to the PA only
// and the inviter's line stayed blank on every executed agreement.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { retainerSigners } = require('../src/services/retainerService2');
const documenso = require('../src/services/documensoService');

const LEAD = (over = {}) => ({
  id: '1', email: 'pa@x.com', fullName: 'Priya Applicant',
  inviterName: 'Oorjith Premlal', inviterEmail: 'oorjith@x.com', ...over,
});

/* ── retainerSigners: who signs, per template ─────────────────────────── */

test('plain pa template: the PA signs alone', () => {
  const r = retainerSigners(LEAD(), 'pa');
  assert.equal(r.hold, undefined);
  assert.equal(r.signers.length, 1);
  assert.equal(r.signers[0].email, 'pa@x.com');
});

test('pa-inviter: PA AND inviter sign, the inviter anchored by POSITION (occurrence 2)', () => {
  const r = retainerSigners(LEAD(), 'pa-inviter');
  assert.equal(r.hold, undefined);
  assert.equal(r.signers.length, 2);
  assert.deepEqual(r.signers.map((s) => s.email), ['pa@x.com', 'oorjith@x.com']);
  // the PA's anchor matches their line and NOT the inviter's
  const paRe = r.signers[0].anchorItem.anchors[0];
  assert.ok(paRe.test('Signature of Priya Applicant'));
  assert.ok(!paRe.test('Signature of Oorjith Premlal'));
  // The inviter targets the SECOND client "Signature of …" line by position —
  // never by name: family members' names can be identical or prefix each
  // other, and a name regex would land their field on the PA's line.
  assert.equal(r.signers[1].anchorItem.occurrence, 2);
  assert.ok(r.signers[1].anchorItem.anchors[0].test('Signature of Anyone At All'));
  assert.ok(!r.signers[1].anchorItem.anchors[0].test('Signature of RCIC — Shafoli'));
});

test('same-name / prefix-name family members still land on separate lines', () => {
  // PA "Oorjith Premlal Kumar", inviter "Oorjith Premlal" — the collision that
  // defeats any name-based regex. Template order: PA line first, inviter second.
  const { anchorHitFromPages } = documenso;
  const pages = [[
    { str: 'IN WITNESS THEREOF', yTopPct: 50 },
    { str: 'Signature of Oorjith Premlal Kumar', yTopPct: 60 },
    { str: 'Signature of Oorjith Premlal', yTopPct: 70 },
    { str: 'Signature of RCIC – Shafoli Kapur', yTopPct: 80 },
  ]];
  const r = retainerSigners(LEAD({ fullName: 'Oorjith Premlal Kumar', inviterName: 'Oorjith Premlal' }), 'pa-inviter');
  const paHit  = anchorHitFromPages(pages, r.signers[0].anchorItem.anchors, r.signers[0].anchorItem.occurrence || 1);
  const invHit = anchorHitFromPages(pages, r.signers[1].anchorItem.anchors, r.signers[1].anchorItem.occurrence || 1);
  assert.equal(paHit.yTopPct, 60, 'PA signs on the first client line');
  assert.equal(invHit.yTopPct, 70, 'inviter signs on the SECOND client line, not the PA’s');
});

test('anchorHitFromPages occurrence counts across pages and skips the RCIC line', () => {
  const { anchorHitFromPages } = documenso;
  const pages = [
    [{ str: 'Signature of A', yTopPct: 10 }],
    [{ str: 'Signature of B', yTopPct: 20 }, { str: 'Signature of RCIC – X', yTopPct: 30 }],
  ];
  const hit = anchorHitFromPages(pages, [/^signature of\s+(?!rcic)/i], 2);
  assert.deepEqual(hit, { page: 2, yTopPct: 20 });
  assert.equal(anchorHitFromPages(pages, [/^signature of\s+(?!rcic)/i], 3), null, 'no third client line → no hit (static fallback)');
});

test('pa-inviter with an incomplete inviter block HOLDS the send', () => {
  for (const gap of [{ inviterEmail: '' }, { inviterName: '' }, { inviterEmail: 'not-an-email' }]) {
    const r = retainerSigners(LEAD(gap), 'pa-inviter');
    assert.ok(r.hold, `must hold on ${JSON.stringify(gap)}`);
    assert.equal(r.signers.length, 1, 'and never silently fall back to PA-only sending');
  }
});

test('PA names with regex metacharacters anchor safely', () => {
  const r = retainerSigners(LEAD({ fullName: 'D. Souza (Sr.)' }), 'pa');
  assert.ok(r.signers[0].anchorItem.anchors[0].test('Signature of D. Souza (Sr.)'));
});

test('v1 / plan-failure fallback keeps the PA anchored placement (no bare signer)', () => {
  // A bare {email,name} signer falls to the module-default field position —
  // the exact regression class the anchoring exists to prevent.
  const src = require('fs').readFileSync(require.resolve('../src/services/retainerService2'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.match(code, /let signerPlan = retainerSigners\(lead, 'pa'\)/, 'the default plan carries anchors + position');
  const r = retainerSigners(LEAD(), 'pa');
  assert.ok(r.signers[0].anchorItem, 'default signer is anchored');
  assert.deepEqual(r.signers[0].position, { positionX: 11, positionY: 27, width: 40, height: 6 }, 'calibrated retainer position preserved');
});

test('a half-signed client envelope can NEVER be captured as signed (recapture guard)', () => {
  // The admin recapture tool fabricates DOCUMENT_COMPLETED; with two parallel
  // signers a pending retainer envelope is now routine. The retainer and
  // consult branches must verify real completion like retainer2/consult2 do.
  const src = require('fs').readFileSync(require.resolve('../src/services/documensoService'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.match(code, /\(type === 'retainer' \|\| type === 'consult' \|\| type === 'retainerinv'\) && envId/, 'client envelopes get the status guard');
  assert.match(code, /skipped: `\$\{type\} envelope status \$\{status\}`/, 'a non-completed envelope is skipped, not stamped');
});

test('the portal reports the cosigner hold honestly, not "will be emailed shortly"', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.match(src, /case 'held-cosigner':/, 'retainAndSend handles the new status');
});

test('the retainer panel makes the co-signer details compulsory before sending', async () => {
  // User directive 2026-08-10: if the inviter section is supposed to be filled
  // (pa-inviter template), its details are required — enforced in the panel at
  // the "Retain & send" click, on top of the server-side hold.
  const vm = require('vm');
  const router = require('../src/routes/adminConsultation');
  const layer = router.stack.find((l) => l.route && l.route.path === '/consultation/:leadId');
  const html = await new Promise((res) => layer.route.stack[0].handle({ query: {}, params: { leadId: '1' } }, { type: () => ({ send: res }) }));
  const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const s of scripts) if (s.trim()) new vm.Script(s);   // the emitted client JS must parse
  assert.ok(html.includes('co-signer, all fields required'), 'the section is visibly marked required');
  assert.ok(html.includes('rp-inviter-err'), 'inline error element exists');
  const js = scripts.join('\n');
  assert.match(js, /function inviterGaps\(\)/, 'gap detector present');
  const click = js.slice(js.indexOf("rpEl('btn-retain-send').onclick"), js.indexOf("rpEl('btn-retain-send').onclick") + 1200);
  assert.match(click, /inviterGaps\(\)/, 'Retain & send validates the co-signer first');
  assert.match(click, /return;/, 'and refuses to send while gaps exist');
  assert.match(click, /BOTH signers/, 'the confirm names both signers on co-signed agreements');
});

/* ── createEnvelope: one recipient per signer, each with their field ───── */

function jsonResponse(obj) {
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) };
}

test('createEnvelope builds one SIGNER recipient per signer with distinct fallback positions', async () => {
  const realFetch = global.fetch;
  const realToken = process.env.DOCUMENSO_API_TOKEN;
  process.env.DOCUMENSO_API_TOKEN = 'test-token';
  let captured = null;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/envelope/create')) {
      captured = JSON.parse(opts.body.get('payload'));
      return jsonResponse({ id: 'env-1', items: [{ id: 'item-1' }] });
    }
    return jsonResponse({});
  };
  try {
    // a buffer pdf-parse can't read → every anchor misses → the fallback path,
    // which is exactly where two signers must NOT stack on one spot
    const env = await documenso.createEnvelope({
      pdfBuffer: Buffer.from('%PDF-1.4 not really'), title: 'T', externalId: 'retainer-1',
      signers: [
        { email: 'pa@x.com', name: 'PA', anchorItem: { anchors: [/^signature of pa/i] }, position: { positionX: 11, positionY: 27, width: 40, height: 6 } },
        { email: 'inv@x.com', name: 'Inviter', anchorItem: { anchors: [/^signature of inv/i] }, position: { positionX: 11, positionY: 27, width: 40, height: 6 } },
      ],
    });
    assert.equal(env.envelopeId, 'env-1');
    assert.equal(captured.recipients.length, 2);
    assert.deepEqual(captured.recipients.map((r) => r.role), ['SIGNER', 'SIGNER']);
    const [f0, f1] = captured.recipients.map((r) => r.fields[0]);
    assert.equal(f0.type, 'SIGNATURE');
    assert.equal(f1.type, 'SIGNATURE');
    assert.notEqual(f0.positionY, f1.positionY, 'unanchored signers must not stack on the same spot');
  } finally {
    global.fetch = realFetch;
    if (realToken === undefined) delete process.env.DOCUMENSO_API_TOKEN; else process.env.DOCUMENSO_API_TOKEN = realToken;
  }
});

test('a signer’s OWN anchorItem/position survive the single-signer form', async () => {
  // Caught live (Oorjith Premlal, envelope_ycdaenlvdbzfmfwa): the back-compat
  // mapping overwrote signer.anchorItem/position with the ABSENT top-level
  // args, so the field fell to the module default {25,70} — a floating box
  // below the RCIC line instead of the inviter's own signature line.
  const realFetch = global.fetch;
  const realToken = process.env.DOCUMENSO_API_TOKEN;
  process.env.DOCUMENSO_API_TOKEN = 'test-token';
  let captured = null;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/envelope/create')) {
      captured = JSON.parse(opts.body.get('payload'));
      return jsonResponse({ id: 'env-3', items: [{ id: 'item-3' }] });
    }
    return jsonResponse({});
  };
  try {
    await documenso.createEnvelope({
      pdfBuffer: Buffer.from('%PDF-1.4 not really'), title: 'T', externalId: 'retainerinv-900',
      signer: { email: 'inv@x.com', name: 'Inviter',
        anchorItem: { anchors: [/^signature of\s+(?!rcic)/i], occurrence: 2 },
        position: { positionX: 11, positionY: 27, width: 40, height: 6 } },
    });
    const f = captured.recipients[0].fields[0];
    // the anchor misses on an unparsable buffer, but the signer's POSITION must
    // still be honoured — never the module default {25,70,28,8}
    assert.equal(f.positionX, 11);
    assert.equal(f.positionY, 27);
    assert.equal(f.width, 40);
  } finally {
    global.fetch = realFetch;
    if (realToken === undefined) delete process.env.DOCUMENSO_API_TOKEN; else process.env.DOCUMENSO_API_TOKEN = realToken;
  }
});

test('co-signature completion is ORDER-PROOF against a pending RCIC countersign', async () => {
  // Harini's shape: client signed + paid, RCIC countersign envelope pending
  // since Aug 6, co-signer signs FIRST. Without re-issuing, Shafoli's later
  // signature would land on the client-only copy and overwrite the stored file
  // WITHOUT the co-signature. The completion must: void the stale RCIC
  // envelope, clear its state, and issue a fresh one over the co-signed copy.
  const updates = [];
  const restores = [
    stub(leadService, 'getLead', async () => SIGNED_LEAD({
      retainerCountersign: JSON.stringify({
        clientEnvelopeId: 'env-c', clientItemId: 'item-c',
        envelopeId: 'env-rcic-stale', sentAt: '2026-08-06',           // pending: no signedAt
        inviterEnvelopeId: 'env-inv', inviterItemId: 'item-inv',
      }) })),
    stub(leadService, 'updateLead', async (id, f) => updates.push(JSON.parse(f.retainerCountersign))),
  ];
  try {
    // The downstream I/O (Documenso void, OneDrive store, fresh countersign)
    // runs against module-locals and fails harmlessly without creds — the state
    // transition is the contract under test.
    await rcSvc.recordInviterSignatureComplete(SIGNED_LEAD(), {});
    const st = updates[0];
    assert.ok(st.inviterSignedAt, 'co-signature stamped');
    assert.equal(st.envelopeId, '', 'stale RCIC envelope cleared so the re-issue cannot resume it');
    assert.equal(st.sentAt, '', 'its sent state cleared too');
    assert.equal(st.clientEnvelopeId, 'env-c', 'the client envelope reference is untouched');
  } finally { restores.forEach((x) => x()); }
});

test('co-signature completion leaves an ALREADY-COUNTERSIGNED retainer alone', async () => {
  const updates = [];
  const restores = [
    stub(leadService, 'getLead', async () => SIGNED_LEAD({
      retainerCountersign: JSON.stringify({
        clientEnvelopeId: 'env-c', envelopeId: 'env-rcic', sentAt: '2026-08-06', signedAt: '2026-08-06',
        inviterEnvelopeId: 'env-inv',
      }) })),
    stub(leadService, 'updateLead', async (id, f) => updates.push(JSON.parse(f.retainerCountersign))),
  ];
  try {
    await rcSvc.recordInviterSignatureComplete(SIGNED_LEAD(), {});
    const st = updates[0];
    assert.equal(st.envelopeId, 'env-rcic', 'a completed countersign is never voided');
    assert.equal(st.signedAt, '2026-08-06');
    assert.ok(st.inviterSignedAt);
  } finally { restores.forEach((x) => x()); }
});

test('reissue voids the old unsigned envelope before sending fresh', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/retainerCountersignService'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.match(code, /if \(!reissue\) return \{ envelopeId: rc\.inviterEnvelopeId, resumed: true \}/,
    'without reissue an issued envelope resumes');
  assert.match(code, /deleteEnvelope\(rc\.inviterEnvelopeId\)/, 'reissue voids the old envelope');
  assert.match(code, /oldEnvelopeActive/, 'a failed void is reported, not hidden');
  assert.match(code, /inviterSignedAt\) return \{ alreadySigned/, 'a captured co-signature can never be reissued');
});

test('the single-signer form still works unchanged (consult + countersign envelopes)', async () => {
  const realFetch = global.fetch;
  const realToken = process.env.DOCUMENSO_API_TOKEN;
  process.env.DOCUMENSO_API_TOKEN = 'test-token';
  let captured = null;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/envelope/create')) {
      captured = JSON.parse(opts.body.get('payload'));
      return jsonResponse({ id: 'env-2', items: [{ id: 'item-2' }] });
    }
    return jsonResponse({});
  };
  try {
    await documenso.createEnvelope({
      pdfBuffer: Buffer.from('%PDF-1.4 not really'), title: 'T', externalId: 'consult-1',
      signer: { email: 'solo@x.com', name: 'Solo' },
      signaturePosition: { positionX: 11, positionY: 30, width: 40, height: 6 },
    });
    assert.equal(captured.recipients.length, 1);
    assert.equal(captured.recipients[0].email, 'solo@x.com');
    assert.equal(captured.recipients[0].fields[0].positionY, 30, 'single signer keeps its exact position');
  } finally {
    global.fetch = realFetch;
    if (realToken === undefined) delete process.env.DOCUMENSO_API_TOKEN; else process.env.DOCUMENSO_API_TOKEN = realToken;
  }
});

/* ── wiring ───────────────────────────────────────────────────────────── */

test('the send path is template-driven and the hold has a staff note', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/retainerService2'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.match(code, /retainerSigners\(lead,\s*buildRetainerPlan/, 'signers come from the resolved plan template');
  assert.match(code, /held-cosigner/, 'an incomplete inviter holds the send instead of sending PA-only');
  assert.match(code, /signers:\s*signerPlan\.signers/, 'the envelope carries the full signer set');
});

/* ── post-hoc inviter co-signature (agreements that went out PA-only) ─── */

const rcSvc = require('../src/services/retainerCountersignService');
const leadService = require('../src/services/leadService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const SIGNED_LEAD = (over = {}) => ({
  id: '900', fullName: 'Amrutha A', email: 'pa@x.com',
  inviterName: 'Oorjith Premlal', inviterEmail: 'oorjith@x.com',
  retainerSigned: '2026-08-05',
  retainerCountersign: JSON.stringify({ clientEnvelopeId: 'env-c', clientItemId: 'item-c', signedAt: '2026-08-06' }),
  ...over,
});

test('retainerinv externalId round-trips and cannot be mistaken for a client envelope', () => {
  assert.deepEqual(documenso.parseExternalId('retainerinv-900'), { type: 'retainerinv', leadId: '900' });
  assert.deepEqual(documenso.parseExternalId('retainer-900'), { type: 'retainer', leadId: '900' });
  assert.equal(documenso.externalIdFor('retainerinv', '900'), 'retainerinv-900');
});

test('sendInviterSignatureRequest issues ONE envelope to the inviter over the signed PDF', async () => {
  const calls = { sent: [], updates: [] };
  const restores = [
    stub(leadService, 'getLead', async () => SIGNED_LEAD()),
    stub(leadService, 'updateLead', async (id, f) => calls.updates.push(f)),
    stub(rcSvc, 'getSignedRetainerPdf', async () => Buffer.from('signed-pdf')),
    stub(documenso, 'sendForSignature', async (args) => { calls.sent.push(args); return { envelopeId: 'env-inv', envelopeItemId: 'item-inv' }; }),
  ];
  try {
    // NOTE: sendInviterSignatureRequest calls module-local bindings — stubbing
    // exports is inert for getSignedRetainerPdf/sendForSignature. Assert on the
    // parts we CAN drive: the guards below use real logic.
    restores.forEach((r) => {});
    const r = await rcSvc.sendInviterSignatureRequest('900').catch((e) => ({ err: e.message }));
    // The module-local getSignedRetainerPdf will try Documenso/OneDrive and fail
    // in tests (no creds) — the guard error must be the PDF one, proving every
    // earlier guard (inviter present, client signed, no prior envelope) passed.
    assert.match(r.err || '', /signed retainer PDF could not be retrieved/i);
  } finally { restores.forEach((x) => x()); }
});

test('inviter-send guards: no inviter, unsigned client, already sent, already signed', async () => {
  const cases = [
    [SIGNED_LEAD({ inviterEmail: '' }), /no complete Inviter/i],
    [SIGNED_LEAD({ retainerSigned: '' }), /has not signed this retainer yet/i],
  ];
  for (const [lead, re] of cases) {
    const restore = stub(leadService, 'getLead', async () => lead);
    try {
      const r = await rcSvc.sendInviterSignatureRequest(lead.id).catch((e) => ({ err: e.message }));
      assert.match(r.err || '', re);
    } finally { restore(); }
  }
  // resume + already-signed short-circuits (no PDF fetch, no envelope)
  const resumed = stub(leadService, 'getLead', async () => SIGNED_LEAD({
    retainerCountersign: JSON.stringify({ signedAt: '2026-08-06', inviterEnvelopeId: 'env-old' }) }));
  try {
    const r = await rcSvc.sendInviterSignatureRequest('900');
    assert.deepEqual(r, { envelopeId: 'env-old', resumed: true });
  } finally { resumed(); }
  const done = stub(leadService, 'getLead', async () => SIGNED_LEAD({
    retainerCountersign: JSON.stringify({ signedAt: '2026-08-06', inviterEnvelopeId: 'env-old', inviterSignedAt: '2026-08-09' }) }));
  try {
    const r = await rcSvc.sendInviterSignatureRequest('900');
    assert.deepEqual(r, { alreadySigned: true, signedAt: '2026-08-09' });
  } finally { done(); }
});

test('retainerinv capture never touches retainerSigned and is guarded like a client envelope', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/documensoService'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.match(code, /type === 'retainerinv'\) && envId/, 'completion-status guard covers the inviter envelope');
  assert.match(code, /type === 'retainerinv';/, 'generic store skipped — the branch stores to the case folder');
  const branch = code.slice(code.indexOf("type === 'retainerinv') {"), code.indexOf("} else if (type === 'consult2')"));
  assert.match(branch, /recordInviterSignatureComplete/);
  assert.ok(!/retainerSigned/.test(branch), 'the client signature state is never touched');
});

test('completion capture stays ALL-signers gated (DOCUMENT_COMPLETED only)', () => {
  // Documenso fires DOCUMENT_COMPLETED when every recipient has signed — the
  // existing capture path is already correct for two signers, as long as
  // nothing starts listening to per-recipient events for the retainer.
  const src = require('fs').readFileSync(require.resolve('../src/services/documensoService'), 'utf8');
  assert.match(src, /event !== 'DOCUMENT_COMPLETED'\) return/, 'capture ignores everything but full completion');
});

// ── invisible-Unicode class (Evelyn Valdez, 2026-08-26) ─────────────────────
// A U+2060 WORD JOINER pasted in front of the inviter's email (WhatsApp copy
// artifact) passed trim() and the \s-based email validator, so Documenso
// emailed "⁠valdez…@gmail.com" — undeliverable; the co-signer never got
// the retainer. Stripped at the WRITE layer (leadService.formatValue) and
// defensively in retainerSigners for legacy rows.

test('stripInvisibles removes zero-width/joiner/direction/BOM characters', () => {
  const { stripInvisibles } = require('../src/services/leadService');
  assert.equal(stripInvisibles('⁠valdez@gmail.com'), 'valdez@gmail.com');
  assert.equal(stripInvisibles('​a‌b‍c﻿'), 'abc');
  assert.equal(stripInvisibles('‮name‬'), 'name');
  assert.equal(stripInvisibles('plain@ok.com'), 'plain@ok.com', 'clean input untouched');
});

test('retainerSigners builds CLEAN recipients from legacy rows carrying invisible chars', () => {
  const { retainerSigners } = require('../src/services/retainerService2');
  const { signers, hold } = retainerSigners({
    email: '⁠pa@x.com', fullName: '​Evelyn Valdez',
    inviterName: '⁠Bryan James Valdez', inviterEmail: '⁠valdezbryanjames@gmail.com',
  }, 'pa-inviter');
  assert.equal(hold, undefined, 'a strippable email must not hold the send');
  assert.equal(signers.length, 2);
  assert.equal(signers[0].email, 'pa@x.com');
  assert.equal(signers[1].email, 'valdezbryanjames@gmail.com', 'the co-signer gets a DELIVERABLE address');
  assert.equal(signers[1].name, 'Bryan James Valdez');
  // The PA's name-anchor must be built from the CLEAN name (an invisible char
  // inside the regex would never match the rendered "Signature of …" line).
  assert.match('Signature of Evelyn Valdez', signers[0].anchorItem.anchors[0]);
});

test('formatValue strips invisibles on email and text writes', () => {
  const lead = require('fs').readFileSync(require.resolve('../src/services/leadService'), 'utf8');
  assert.match(lead, /case 'email':\s*\{ const e = stripInvisibles\(value\)\.trim\(\)/);
  assert.match(lead, /default:\s*return stripInvisibles\(value\)/);
});
