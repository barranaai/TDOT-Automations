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
  assert.match(code, /\(type === 'retainer' \|\| type === 'consult'\) && envId/, 'client envelopes get the status guard');
  assert.match(code, /skipped: `\$\{type\} envelope status \$\{status\}`/, 'a non-completed envelope is skipped, not stamped');
});

test('the portal reports the cosigner hold honestly, not "will be emailed shortly"', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.match(src, /case 'held-cosigner':/, 'retainAndSend handles the new status');
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

test('completion capture stays ALL-signers gated (DOCUMENT_COMPLETED only)', () => {
  // Documenso fires DOCUMENT_COMPLETED when every recipient has signed — the
  // existing capture path is already correct for two signers, as long as
  // nothing starts listening to per-recipient events for the retainer.
  const src = require('fs').readFileSync(require.resolve('../src/services/documensoService'), 'utf8');
  assert.match(src, /event !== 'DOCUMENT_COMPLETED'\) return/, 'capture ignores everything but full completion');
});
