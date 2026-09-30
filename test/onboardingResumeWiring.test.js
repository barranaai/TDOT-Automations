'use strict';

// Fix 1 wiring (2026-09-30): where the held-onboarding check is asked, and what
// each caller does with its answer. The service itself is stubbed here — its
// judgement is covered in onboardingResume.test.js.

const test   = require('node:test');
const assert = require('node:assert/strict');

const R           = require('../src/services/onboardingResumeService');
const mondayApi   = require('../src/services/mondayApi');
const leadService = require('../src/services/leadService');
const caseGate    = require('../src/services/caseGateService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

/* ── the last signature: advanceCaseToPaid on a case already "Paid" ── */

async function advanceWith({ boardStatus, resume }) {
  const paymentService = require('../src/services/paymentService');
  const calls = [], writes = [];
  const lead = { id: '700', clientMasterItemId: '9001', retainerSigned: '2026-09-29', retainerPaid: '2026-09-29' };
  const restore = [
    stub(mondayApi, 'query', async (q, v) => {
      if (/change_multiple_column_values/.test(q)) { writes.push(v.cols); return {}; }
      if (/color_mm0x9fnn/.test(q)) return { items: [{ column_values: [{ text: boardStatus }] }] };
      return {};
    }),
    stub(leadService, 'getLead', async () => ({ ...lead })),
    stub(caseGate, 'moveCaseToActiveGroup', async () => true),
    stub(R, 'resumeIfOwed', async (args) => { calls.push(args); if (resume instanceof Error) throw resume; return resume || { action: 'none', code: 'not-held' }; }),
  ];
  try {
    const r = await paymentService.advanceCaseToPaid(lead);
    await flush();   // the check runs detached (it needs no lead lock)
    return { r, calls, writes };
  } finally { restore.reverse().forEach((x) => x()); }
}

test('last signature on a case already "Paid" asks the held-onboarding check — once, as the last-signature trigger', async () => {
  const { r, calls, writes } = await advanceWith({ boardStatus: 'Paid' });
  assert.equal(r, '9001');
  assert.deepEqual(calls, [{ itemId: '9001', trigger: 'last-signature' }]);
  assert.equal(writes.length, 0, '"Paid" is still never written twice');
});

test('a failing held-onboarding check never turns into a second "Paid" write', async () => {
  const { r, writes } = await advanceWith({ boardStatus: 'Paid', resume: new Error('boom') });
  assert.equal(r, '9001');
  assert.equal(writes.length, 0);
});

test('the normal advance (board not Paid yet) writes Paid and does not ask the held check', async () => {
  const { calls, writes } = await advanceWith({ boardStatus: 'Signed (Unpaid)' });
  assert.equal(calls.length, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /"label":"Paid"/);
});

/* ── Case Type set late: caseRefService.resumeOnboardingIfStuck ── */

async function caseRefResume(held, { switchOff = false, startDate = '2026-09-29' } = {}) {
  const clockWrites = [];
  const caseRef = require('../src/services/caseRefService');
  caseRef._setRetryMsForTests(0);
  const saved = process.env.ONBOARDING_RESUME;
  if (switchOff) process.env.ONBOARDING_RESUME = 'off'; else delete process.env.ONBOARDING_RESUME;
  const verdicts = Array.isArray(held) ? [...held] : [held];
  const emailService = require('../src/services/emailService');
  const checklistService = require('../src/services/checklistService');
  const sponsor = require('../src/services/sponsorOnboardingService');
  const did = [], asked = [];
  const restore = [
    stub(mondayApi, 'query', async (q, v) => {
      if (/change_multiple_column_values/.test(q)) { did.push('clock'); clockWrites.push(JSON.parse(v.c)); return {}; }
      return { items: [{ column_values: [
        { id: 'color_mm0x8faa', text: 'Document Collection Started' }, { id: 'color_mm0xs7kp', text: 'No' }, { id: 'color_mm0x9fnn', text: 'Paid' },
        { id: 'date_mm0xjm1z', text: startDate }] }] };
    }),
    stub(R, 'resumeIfOwed', async (args) => { asked.push(args); return verdicts.length > 1 ? verdicts.shift() : verdicts[0]; }),
    stub(emailService, 'sendIntakeEmail', async () => { did.push('email'); return { sent: true }; }),
    stub(checklistService, 'onDocumentCollectionStarted', async () => { did.push('seed'); }),
    stub(sponsor, 'ensureSponsor', async () => { did.push('sponsor'); }),
  ];
  try {
    await caseRef.resumeOnboardingIfStuck({ itemId: '9001', caseRef: '2026-SV-021' });
    await flush();
    return { did, asked, clockWrites };
  } finally {
    restore.reverse().forEach((x) => x());
    if (saved === undefined) delete process.env.ONBOARDING_RESUME; else process.env.ONBOARDING_RESUME = saved;
  }
}

test('Case Type set late on a normal case: its start now sets the reminder clock when blank (it never did — and it is the trace the held service reads)', async () => {
  const { did, clockWrites } = await caseRefResume({ action: 'none', code: 'not-held' }, { startDate: '' });
  assert.deepEqual(did.sort(), ['clock', 'email', 'seed', 'sponsor']);
  assert.deepEqual(Object.keys(clockWrites[0]).sort(), ['color_mm1abve4', 'date_mm0xjm1z', 'numeric_mm1a4e8r']);
  const set = await caseRefResume({ action: 'none', code: 'not-held' }, { startDate: '2026-09-01' });
  assert.equal(set.clockWrites.length, 0, 'an existing clock is never moved');
});

test('Case Type set late on a case HELD for signatures: no intake email behind the hold (it used to send with no signature check)', async () => {
  const { did, asked } = await caseRefResume({ action: 'none', code: 'waiting', detail: 'RCIC countersignature' });
  assert.deepEqual(did, []);
  assert.deepEqual(asked, [{ itemId: '9001', trigger: 'case-ref', caseRef: '2026-SV-021' }]);
});

test('Case Type set late on a held case that is now complete: the held service started it — nothing sent twice', async () => {
  for (const held of [{ action: 'resumed' }, { action: 'report', code: 'evidence' }, { action: 'none', code: 'already-resumed' }]) {
    const { did } = await caseRefResume(held);
    assert.deepEqual(did, [], JSON.stringify(held));
  }
});

test('Case Type set late on a normal case (never held / no lead): resumes exactly as before', async () => {
  for (const held of [{ action: 'none', code: 'not-held' }, { action: 'none', code: 'no-lead' }]) {
    const { did } = await caseRefResume(held);
    assert.deepEqual(did.sort(), ['email', 'seed', 'sponsor'], JSON.stringify(held));
  }
});

test('Case Type set late, held check unreadable: retried once; a settled answer wins; still unreadable → resumes as before (this path\'s own rescue)', async () => {
  let r = await caseRefResume([{ action: 'error', code: 'error' }, { action: 'none', code: 'waiting' }]);
  assert.equal(r.asked.length, 2);
  assert.deepEqual(r.did, [], 'the retry saw a hold — nothing sent');
  r = await caseRefResume([{ action: 'error', code: 'error' }, { action: 'error', code: 'error' }]);
  assert.equal(r.asked.length, 2);
  assert.deepEqual(r.did.sort(), ['email', 'seed', 'sponsor']);
});

test('Case Type set late, the held start was chosen but could not be recorded: NEVER sent from here (the sync retries with the record)', async () => {
  const { did, asked } = await caseRefResume({ action: 'error', code: 'record-failed' });
  assert.deepEqual(did, []);
  assert.equal(asked.length, 1, 'no retry either — the service decided');
});

test('switch off: the Case Type path is exactly the old one (no held check)', async () => {
  const { did, asked } = await caseRefResume({ action: 'none', code: 'waiting' }, { switchOff: true });
  assert.equal(asked.length, 0);
  assert.deepEqual(did.sort(), ['email', 'seed', 'sponsor']);
});

/* ── Client Email corrected: emailService.onClientEmailChanged ── */

async function emailChanged(verdicts, { switchOff = false } = {}) {
  const saved = process.env.ONBOARDING_RESUME;
  if (switchOff) process.env.ONBOARDING_RESUME = 'off'; else delete process.env.ONBOARDING_RESUME;
  const emailService = require('../src/services/emailService');
  emailService._setRetryMsForTests(0);
  const mail = require('../src/services/microsoftMailService');
  const notes = [], sent = [], asked = [];
  const row = { items: [{ name: 'Mehak', column_values: [
    { id: 'color_mm0x8faa', text: 'Document Collection Started' }, { id: 'text_mm0xw6bp', text: 'mehak.new@example.com' },
    { id: 'text_mm142s49', text: '2026-SV-021' }, { id: 'color_mm0x9fnn', text: 'Paid' },
    { id: 'dropdown_mm0xd1qn', text: 'Supervisa' }, { id: 'text_mm0x6haq', text: 'TDOT-abc' }] }] };
  const restore = [
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) { notes.push(v.body); return {}; } return row; }),
    stub(mail, 'sendEmail', async (m) => { sent.push(m); }),
    stub(R, 'resumeIfOwed', async (args) => { asked.push(args); return verdicts[asked.length - 1] || { action: 'none', code: 'not-held' }; }),
  ];
  try {
    await emailService.onClientEmailChanged('9001');
    return { notes, sent, asked };
  } finally {
    restore.reverse().forEach((x) => x());
    if (saved === undefined) delete process.env.ONBOARDING_RESUME; else process.env.ONBOARDING_RESUME = saved;
  }
}

test('email corrected while HELD for signatures: nothing sent now, a note says the intake email will go to the new address', async () => {
  const { notes, sent, asked } = await emailChanged([{ action: 'none', code: 'waiting', detail: 'RCIC countersignature' }]);
  assert.equal(sent.length, 0);
  assert.deepEqual(asked, [{ itemId: '9001', trigger: 'email-change', dryRun: true }]);
  assert.match(notes[0], /Client email updated to mehak\.new@example\.com\. Onboarding is on hold \(waiting for the RCIC countersignature\)/);
});

test('email corrected on a held case that is now complete and owed: the held onboarding starts (to the new address) — no separate resend', async () => {
  const { sent, asked } = await emailChanged([{ action: 'resume' }, { action: 'resumed' }]);
  assert.equal(sent.length, 0, 'the correction path itself sends nothing');
  assert.deepEqual(asked, [{ itemId: '9001', trigger: 'email-change', dryRun: true }, { itemId: '9001', trigger: 'email-change' }]);
});

test('email corrected on an onboarded case that later picked up a hold note (Anita-type + a post-hoc countersign): still re-sent to the new address', async () => {
  const { sent, notes } = await emailChanged([{ action: 'none', code: 'waiting', detail: 'RCIC countersignature', evidence: true }]);
  assert.equal(sent.length, 1);
  assert.ok(!notes.some((n) => /Onboarding is on hold/.test(n)));
});

test('switch off: the email correction is exactly the old resend (no held check)', async () => {
  const { sent, asked } = await emailChanged([{ action: 'none', code: 'waiting' }], { switchOff: true });
  assert.equal(asked.length, 0);
  assert.equal(sent.length, 1);
});

test('email corrected on a held, owed case whose last checks could not be read: nothing sent alone — the sync starts it (to the new address)', async () => {
  const { sent } = await emailChanged([{ action: 'none', code: 'unreadable' }]);
  assert.equal(sent.length, 0);
});

test('email corrected, held check unreadable: retried once — a hold found on the retry sends nothing', async () => {
  const { sent, asked } = await emailChanged([{ action: 'error', code: 'error' }, { action: 'none', code: 'waiting', detail: 'RCIC countersignature' }]);
  assert.equal(asked.length, 2);
  assert.equal(sent.length, 0);
});

test('email corrected on a normal case: the correction resend works exactly as before', async () => {
  for (const v of [{ action: 'none', code: 'not-held' }, { action: 'report', code: 'evidence' }, { action: 'none', code: 'already-resumed' }]) {
    const { sent, notes } = await emailChanged([v]);
    assert.equal(sent.length, 1, JSON.stringify(v));
    assert.equal(sent[0].to, 'mehak.new@example.com');
    assert.ok(notes.some((n) => /Intake email resent/.test(n)));
  }
});

/* ── the 15-minute status sync ── */

test('the status sync hands its already-read leads and case rows to the held-onboarding step, and survives it failing', async () => {
  const svc = require('../src/services/retainerStatusReconciler');
  const leads = [{ id: 'L1', clientMasterItemId: '9001', retainerSigned: '2026-09-29', retainerPaid: '2026-09-29' }];
  const seen = [];
  const restore = [
    stub(leadService, 'listAllLeads', async () => leads),
    stub(mondayApi, 'query', async (q) => {
      if (/items\(ids:\$ids, limit:\$lim\)/.test(q)) {
        // answer only the columns actually asked for — as Monday does
        const all = [{ id: 'color_mm0x9fnn', text: 'Paid' }, { id: 'text_mm142s49', text: '2026-SV-021' }, { id: 'color_mm0x8faa', text: 'Document Collection Started' }, { id: 'color_mm0xs7kp', text: 'No' }];
        return { items: [{ id: '9001', state: 'active', board: { id: require('../config/monday').clientMasterBoardId },
          column_values: all.filter((c) => q.includes(`"${c.id}"`)) }] };
      }
      return {};
    }),
    stub(svc.io, 'sweepHeldOnboarding', async (args) => { seen.push(args); return { resumed: ['9001'] }; }),
  ];
  try {
    const r = await svc.sweepRetainerStatus({ dryRun: true });
    assert.deepEqual(r.onboarding, { resumed: ['9001'] });
    assert.equal(seen[0].leads, leads);
    assert.equal(seen[0].dryRun, true);
    const c = seen[0].cases.get('9001');
    assert.deepEqual([c.paymentStatus, c.stage, c.applied], ['Paid', 'Document Collection Started', 'No'], 'stage + checklist flag ride the existing bulk read');
    svc.io.sweepHeldOnboarding = async () => { throw new Error('boom'); };
    const r2 = await svc.sweepRetainerStatus({ dryRun: true });
    assert.equal(r2.onboarding.error, 'boom');
    assert.equal(r2.checked, 1, 'the rest of the sweep is unaffected');
  } finally { restore.reverse().forEach((x) => x()); }
});

/* ── the Case Stage webhook: hold note + chasing clock ── */

async function dcsWebhook({ applied = 'No', startDate = '', gateComplete = true, notesFail = 0 } = {}) {
  const router = require('../src/routes/mondayWebhook');
  const emailService = require('../src/services/emailService');
  const checklistService = require('../src/services/checklistService');
  const sponsor = require('../src/services/sponsorOnboardingService');
  const CM_BOARD = String(require('../config/monday').clientMasterBoardId);
  const writes = [], notes = [], did = [];
  let noteFails = notesFail;
  const lead = gateComplete ? { id: 'L1', retainerSigned: '2026-09-29', retainerPaid: '2026-09-29' }
    : { id: 'L1', retainerSigned: '2026-09-29', retainerPaid: '2026-09-29', retainerCountersign: JSON.stringify({ clientSignedVia: 'documenso', envelopeId: 'rc1' }) };
  const restore = [
    stub(mondayApi, 'query', async (q, v) => {
      if (/create_update/.test(q)) { if (noteFails-- > 0) throw new Error('429'); notes.push(v.body); return {}; }
      if (/change_multiple_column_values/.test(q)) { writes.push(JSON.parse(v.c)); return {}; }
      if (/date_mm0xjm1z/.test(q)) return { items: [{ column_values: [{ id: 'color_mm0xs7kp', text: applied }, { id: 'date_mm0xjm1z', text: startDate }] }] };
      if (/color_mm0x9fnn/.test(q)) return { items: [{ column_values: [{ text: 'Paid' }] }] };
      return { items: [{ column_values: [] }] };
    }),
    stub(leadService, 'findAllByColumnValue', async () => [lead]),
    stub(emailService, 'sendIntakeEmail', async () => { did.push('email'); return { sent: true }; }),
    stub(checklistService, 'onDocumentCollectionStarted', async () => { did.push('seed'); }),
    stub(sponsor, 'ensureSponsor', async () => { did.push('sponsor'); }),
  ];
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  try {
    await handle({ body: { event: { type: 'update_column_value', columnId: 'color_mm0x8faa', boardId: CM_BOARD, pulseId: 9001,
      value: { label: { text: 'Document Collection Started' } }, previousValue: { label: { text: 'Pre-Onboarding' } } } } },
      { json: () => {}, status: () => ({ json: () => {} }) });
    await new Promise((r) => setTimeout(r, 1700));   // lets the hold note's one retry run
    await flush();
    return { writes, notes, did };
  } finally { restore.reverse().forEach((x) => x()); }
}

test('a held case started by moving it to Document Collection gets its reminder clock (it never got one from the payment webhook)', async () => {
  const { writes, did } = await dcsWebhook({ applied: 'No', startDate: '' });
  assert.deepEqual(did.sort(), ['email', 'seed', 'sponsor']);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]).sort(), ['color_mm1abve4', 'date_mm0xjm1z', 'numeric_mm1a4e8r']);
  assert.equal(writes[0].color_mm1abve4, null);
  assert.equal(writes[0].numeric_mm1a4e8r, '0');
});

test('the reminder clock is never moved when it exists, and a legacy case (blank flag) is never put on the ladder', async () => {
  assert.equal((await dcsWebhook({ applied: 'No', startDate: '2026-09-01' })).writes.length, 0);
  assert.equal((await dcsWebhook({ applied: '', startDate: '' })).writes.length, 0);
});

test('the Case Stage hold note is retried once — it is the record the held-onboarding start reads', async () => {
  const { notes, did } = await dcsWebhook({ gateComplete: false, notesFail: 1 });
  assert.deepEqual(did, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Onboarding deferred:<\/b> missing RCIC countersignature/);
});

test('the admin "Resend intake email" tool leaves a note the held-onboarding start reads as "already sent"', () => {
  const src = require('fs').readFileSync(require.resolve('../src/server.js'), 'utf8');
  const route = src.slice(src.indexOf("app.post('/api/resend-intake/:itemId'"), src.indexOf('// Manual re-seed'));
  assert.match(route, /📬 <b>Intake email sent<\/b> \("Your case is ready"\) from the admin tools to \$\{to\}/);
  assert.match(route, /\.catch\(\(\) => new Promise\(\(r\) => setTimeout\(r, 1500\)\)\.then\(postTrace\)\)/, 'the trace is retried once');
  assert.match(route, /noteRecorded/, 'and the admin is told when it could not be added');
  assert.match(route, /Portal link email re-sent from the admin tools/);
  const note = '📬 <b>Intake email sent</b> ("Your case is ready") from the admin tools to m***@example.com.';
  assert.deepEqual(R.readNotes([{ created_at: '2026-09-30T10:00:00Z', body: note, text_body: note.replace(/<[^>]+>/g, '') }]).evidence, ['the intake email was already sent']);
  const portal = '📬 Portal link email re-sent from the admin tools to m***@example.com.';
  assert.deepEqual(R.readNotes([{ created_at: '2026-09-30T10:00:00Z', body: portal, text_body: portal }]).evidence, [], 'the portal-link variant is not the intake email');
});

test('the Paid webhook hold note is retried once — it is the record the held-onboarding start reads', async () => {
  const retainerService = require('../src/services/retainerService');
  const notes = [];
  let fails = 1;
  const pending = { id: 'L1', clientMasterItemId: '9007', retainerSigned: '2026-09-29', retainerPaid: '2026-09-29',
    retainerCountersign: JSON.stringify({ clientSignedVia: 'documenso', envelopeId: 'rc1' }) };
  const restore = [
    stub(mondayApi, 'query', async (q, v) => {
      if (/create_update/.test(q)) { if (fails-- > 0) throw new Error('429'); notes.push(v.b); return {}; }
      if (/column_values\(ids/.test(q)) return { items: [{ column_values: [{ id: 'color_mm0xs7kp', text: 'No' }, { id: 'color_mm0x8faa', text: 'Document Collection Started' }] }] };
      return {};
    }),
    stub(leadService, 'findAllByColumnValue', async () => [pending]),
  ];
  try {
    await retainerService.onRetainerPaid({ itemId: '9007' });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Payment marked, but onboarding is on hold<\/b> — missing: RCIC countersignature/);
  } finally { restore.reverse().forEach((x) => x()); }
});
