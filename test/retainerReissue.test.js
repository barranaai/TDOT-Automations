'use strict';

// Void-&-reissue (meeting 2026-08-13): the recovery for a typo'd signer email,
// a renegotiated fee, or any post-send modification. Contract: only an
// UN-SIGNED sent agreement can be reissued; a COMPLETED envelope (client
// signed, webhook missed) is never voided; the lead returns to the un-sent
// state and the normal send engine runs with the CURRENT plan.

const test   = require('node:test');
const assert = require('node:assert/strict');

const retainer2   = require('../src/services/retainerService2');
const documenso   = require('../src/services/documensoService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const sentLead = (extra = {}) => ({
  id: '900', fullName: 'Reissue Test', email: 'x@x.com', outcome: 'Retain',
  retainerFee: '3000', retainerSent: '2026-08-14', retainerSigned: '', conversionStatus: 'Qualified',
  retainerCountersign: JSON.stringify({ clientEnvelopeId: 'env-old', clientItemId: 'item-old', envelopeId: 'rc-env', sentAt: '2026-08-10', inviterSignedAt: '2026-08-01' }),
  ...extra,
});

function baseStubs({ lead, writes, notes, envelopeStatus = 'PENDING', deleted, sends }) {
  return [
    stub(leadService, 'getLead', async () => lead),
    stub(leadService, 'updateLead', async (id, f, o) => { writes.push({ f, o }); }),
    stub(mondayApi, "query", async (q, v) => { if (v && (v.b || v.body)) notes.push(v.b || v.body); return {}; }),
    stub(documenso, 'isEnabled', () => true),
    stub(documenso, 'getEnvelope', async () => ({ status: envelopeStatus })),
    stub(documenso, 'deleteEnvelope', async (id) => { deleted.push(id); }),
    // the re-send: stub the whole engine entry so the test pins the seam
    stub(retainer2, 'maybeSendRetainerAgreement', async (id, opts) => { sends.push(opts); return { status: 'sent', via: 'documenso', envelopeId: 'env-new' }; }),
  ];
}

test('happy path: voids the old envelope, clears the sent state, re-sends with assumeUnsent', async () => {
  const writes = [], notes = [], deleted = [], sends = [];
  const restore = baseStubs({ lead: sentLead(), writes, notes, deleted, sends });
  try {
    const r = await retainer2.voidAndReissueRetainer('900');
    assert.equal(r.status, 'sent');
    assert.equal(r.reissued, true);
    assert.equal(r.oldEnvelopeActive, false);
    assert.deepEqual(deleted, ['env-old', 'rc-env'], 'old client envelope AND the pending RCIC countersign envelope voided');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].f.retainerSent, '', 'sent stamp cleared');
    assert.deepEqual(writes[0].o, { clearKeys: ['retainerSent'] });
    const rc = JSON.parse(writes[0].f.retainerCountersign);
    assert.equal(rc.clientEnvelopeId, undefined, 'stale envelope ref dropped');
    assert.equal(rc.envelopeId, undefined, 'stale RCIC countersign state dropped — the NEW signing must not resume against the voided document');
    assert.equal(rc.sentAt, undefined);
    assert.equal(rc.inviterSignedAt, '2026-08-01', 'inviter post-hoc history preserved');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].assumeUnsent, true, 'a stale Monday read of the just-cleared stamp must not bounce the send');
    assert.ok(notes.some((n) => /voided for re-issue/i.test(n)), 'loud audit note');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('SAFETY: a COMPLETED old envelope is never voided (client signed, webhook missed)', async () => {
  const writes = [], notes = [], deleted = [], sends = [];
  const restore = baseStubs({ lead: sentLead(), writes, notes, deleted, sends, envelopeStatus: 'COMPLETED' });
  try {
    const r = await retainer2.voidAndReissueRetainer('900');
    assert.equal(r.status, 'already-signed');
    assert.equal(deleted.length, 0, 'the signed envelope is untouched');
    assert.equal(writes.length, 0, 'no state change');
    assert.equal(sends.length, 0, 'no re-send');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('refuses signed / retained / never-sent leads', async () => {
  for (const lead of [
    sentLead({ retainerSigned: '2026-08-14' }),
    sentLead({ conversionStatus: 'Retained' }),
  ]) {
    const writes = [], notes = [], deleted = [], sends = [];
    const restore = baseStubs({ lead, writes, notes, deleted, sends });
    try {
      assert.equal((await retainer2.voidAndReissueRetainer('900')).status, 'already-signed');
      assert.equal(deleted.length + writes.length + sends.length, 0);
    } finally { restore.reverse().forEach((x) => x()); }
  }
  const writes = [], notes = [], deleted = [], sends = [];
  const restore = baseStubs({ lead: sentLead({ retainerSent: '' }), writes, notes, deleted, sends });
  try {
    assert.equal((await retainer2.voidAndReissueRetainer('900')).status, 'not-sent');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('a failed void still reissues, flagged loudly (old links may stay live)', async () => {
  const writes = [], notes = [], deleted = [], sends = [];
  const restore = [
    ...baseStubs({ lead: sentLead(), writes, notes, deleted, sends }),
    stub(documenso, 'deleteEnvelope', async () => { throw new Error('409 locked'); }),
  ];
  try {
    const r = await retainer2.voidAndReissueRetainer('900');
    assert.equal(r.status, 'sent');
    assert.equal(r.oldEnvelopeActive, true);
    assert.ok(notes.some((n) => /could <b>NOT<\/b> be cancelled/i.test(n)), 'note warns the old links may work');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('assumeUnsent: the engine skips only the sent-stamp guard, never the signed guard', async () => {
  const restore = [
    stub(leadService, 'getLead', async () => sentLead({ retainerSigned: '2026-08-14' })),
  ];
  try {
    const r = await retainer2.maybeSendRetainerAgreement('900', { assumeUnsent: true });
    assert.equal(r.status, 'already', 'signed stays signed — assumeUnsent cannot force a send past it');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('the portal action is whitelisted and the UI button exists, gated on sent-not-signed', () => {
  const { validateAction } = require('../src/services/consultantPortalService');
  assert.deepEqual(validateAction('reissueRetainer', null), { ok: true, normalized: null });
  const r = require('fs').readFileSync(require.resolve('../src/routes/adminConsultation'), 'utf8');
  assert.match(r, /id="rp-reissue"/);
  assert.match(r, /RP_SENT && !RP_RETAINED\) \? 'inline-flex' : 'none'/, 'visible only for sent-but-unsigned');
  assert.match(r, /doAction\('reissueRetainer'/, 'wired to the action');
});

// ─── review-hardening (adversarial findings 2026-08-15) ──────────────────────

test('FAIL CLOSED: unreadable envelope status → the old envelope is NOT deleted', async () => {
  const writes = [], notes = [], deleted = [], sends = [];
  const restore = [
    ...baseStubs({ lead: sentLead(), writes, notes, deleted, sends }),
    stub(documenso, 'getEnvelope', async () => { throw new Error('503'); }),
  ];
  try {
    const r = await retainer2.voidAndReissueRetainer('900');
    assert.equal(r.status, 'sent', 'reissue still proceeds');
    assert.ok(!deleted.includes('env-old'), 'never delete what might be a signed CLIENT document');
    assert.equal(r.oldEnvelopeActive, true);
    assert.ok(notes.some((n) => /could <b>NOT<\/b> be cancelled/i.test(n)));
  } finally { restore.reverse().forEach((x) => x()); }
});

test('delete fails and the re-check says COMPLETED → refuse (the client just signed)', async () => {
  const writes = [], notes = [], deleted = [], sends = [];
  let reads = 0;
  const restore = [
    ...baseStubs({ lead: sentLead(), writes, notes, deleted, sends }),
    stub(documenso, 'getEnvelope', async () => ({ status: ++reads === 1 ? 'PENDING' : 'COMPLETED' })),
    stub(documenso, 'deleteEnvelope', async () => { throw new Error('409 already completed'); }),
  ];
  try {
    const r = await retainer2.voidAndReissueRetainer('900');
    assert.equal(r.status, 'already-signed');
    assert.equal(writes.length, 0, 'no state touched');
    assert.equal(sends.length, 0, 'nothing re-sent past the signature');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('signature landing between entry and the state write aborts the reissue (fresh re-read)', async () => {
  const writes = [], notes = [], deleted = [], sends = [];
  let getLeadCalls = 0;
  const restore = [
    ...baseStubs({ lead: sentLead(), writes, notes, deleted, sends }),
    stub(leadService, 'getLead', async () => (++getLeadCalls === 1 ? sentLead() : sentLead({ retainerSigned: '2026-08-15' }))),
  ];
  try {
    const r = await retainer2.voidAndReissueRetainer('900');
    assert.equal(r.status, 'already-signed');
    assert.equal(writes.length, 0, 'the stale snapshot is never written over the signed state');
    assert.equal(sends.length, 0);
  } finally { restore.reverse().forEach((x) => x()); }
});

test('send-engine throw is contained: staff get a failed status, plus a corrective note', async () => {
  const writes = [], notes = [], deleted = [], sends = [];
  const restore = [
    ...baseStubs({ lead: sentLead(), writes, notes, deleted, sends }),
    stub(retainer2, 'maybeSendRetainerAgreement', async () => { throw new Error('cloudconvert down'); }),
  ];
  try {
    const r = await retainer2.voidAndReissueRetainer('900');
    assert.equal(r.status, 'failed');
    assert.equal(r.reissued, true);
    assert.match(r.reason, /cloudconvert/);
    assert.ok(notes.some((n) => /not<\/b> sent/i.test(n)), 'corrective note names the failure');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('assumeUnsent bounces when a concurrent send re-recorded an envelope (stamp + id present)', async () => {
  const restore = [stub(leadService, 'getLead', async () => sentLead())];  // sent + clientEnvelopeId
  try {
    const r = await retainer2.maybeSendRetainerAgreement('900', { assumeUnsent: true });
    assert.equal(r.status, 'already', 'a second envelope must never be minted');
  } finally { restore.reverse().forEach((x) => x()); }
});

test('capture and reissue share the per-lead mutex (source contract)', () => {
  const fs = require('fs');
  const r2 = fs.readFileSync(require.resolve('../src/services/retainerService2'), 'utf8');
  const doc = fs.readFileSync(require.resolve('../src/services/documensoService'), 'utf8');
  assert.match(r2, /leadMutex'\)\.withLeadLock\(key, \(\) => _doVoidAndReissue/);
  assert.match(doc, /leadMutex'\)\.withLeadLock\(leadId, async \(\) =>/);
});

test('clearKeys emits Monday\'s universal empty-string clear for DATE columns', async () => {
  const writes = [];
  const restore = stub(mondayApi, 'query', async (q, v) => {
    if (v && v.cols) writes.push(JSON.parse(v.cols));
    if (v && v.columnValues) writes.push(JSON.parse(v.columnValues));
    return { change_multiple_column_values: { id: '1' } };
  });
  try {
    await leadService.updateLead('900', { retainerSent: '' }, { clearKeys: ['retainerSent'] });
    assert.equal(writes.length, 1, 'one Monday write');
    const cols = writes[0];
    const vals = Object.values(cols);
    assert.deepEqual(vals, [''], `date clear must be "" not a typed empty — got ${JSON.stringify(cols)}`);
  } finally { restore(); }
});
