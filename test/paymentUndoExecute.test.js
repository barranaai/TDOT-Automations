'use strict';

// "Undo mark paid" — the executor, driven through its I/O seam.
// Every side effect goes through U.io, which each test replaces wholesale with
// a fake store, so nothing here can reach Monday, OneDrive or an inbox.

const test   = require('node:test');
const assert = require('node:assert/strict');

const U  = require('../src/services/paymentUndoService');
const ms = require('../src/services/milestonePaymentService');

const D = '2026-09-22';
const MILESTONES = JSON.stringify([
  { label: 'Milestone 1 – Admin Fee (Non-Refundable)', amountCents: 87500, trigger: 'Retainer Confirmed', locked: true },
  { label: 'Milestone 2 – Before Submission', amountCents: 150000, trigger: 'Document Collection Started' },
  { label: 'Milestone 3 – Upon ITA', amountCents: 100000, trigger: 'Internal Review' },
]);
const baseLead = (over = {}) => ({
  id: '13108401448', fullName: 'Test Client', clientMasterItemId: '13108384096',
  confirmedCaseType: 'OINP', retainerFee: '4875', retainerHstRate: '13', retainerMilestones: MILESTONES,
  milestonePayments: JSON.stringify({ 0: { status: 'paid', paidAt: D, method: 'e-transfer', reference: 'C1AdRgrQhzQG' } }),
  retainerSigned: D, retainerPaid: D, conversionStatus: 'Retained',
  retainerCountersign: JSON.stringify({ clientEnvelopeId: 'e1', clientSignedVia: 'documenso', envelopeId: 'rc1', signedAt: '' }),
  ...over,
});
const baseCase = (over = {}) => ({ itemId: '13108384096', paymentStatus: 'Already Sent', caseRef: '2026-OINP-059', caseStage: 'Pre-Onboarding', checklistApplied: '', paymentConfDate: '', archived: false, ...over });
const ACTOR = { name: 'Faran', email: 'faran@example.com', verified: true };
const REASON = 'Marked paid on the wrong client — the e-transfer belongs to someone else';

/** A fake Monday: one lead, one case, and a log of every call. */
function withFakeIo(fn, { lead = baseLead(), cm = baseCase(), ...hooks } = {}) {
  const real = { ...U.io };
  const store = { lead: { ...lead }, cm: cm && { ...cm } };
  const calls = [];
  const log = (name, ...a) => calls.push([name, ...a]);
  let t = 1000;
  Object.assign(U.io, {
    getLead: async (id) => { log('getLead', id); if (hooks.getLeadThrows) throw new Error('read failed'); return hooks.staleReads && hooks.staleReads-- > 0 ? { ...lead } : { ...store.lead }; },
    readCase: async (id) => { log('readCase', id); if (hooks.readCaseThrows) throw new Error('case read failed'); return hooks.caseAfterCommit && calls.some((c) => c[0] === 'commit') ? hooks.caseAfterCommit : (store.cm && { ...store.cm }); },
    commit: async (plan) => {
      log('commit', plan.index);
      if (hooks.commitThrows) throw hooks.commitThrows;
      if (hooks.commitIsNoop) return { conversion: plan.conversionStatus };
      const pay = ms.readPayments(store.lead).pay;
      if (plan.after) pay[plan.index] = plan.after;
      store.lead.milestonePayments = JSON.stringify(pay);
      if (plan.clearKeys.includes('retainerPaid')) store.lead.retainerPaid = '';
      if (plan.conversionStatus) store.lead.conversionStatus = plan.conversionStatus.to;
      return { conversion: plan.conversionStatus };
    },
    writeLeadFields: async (id, fields) => { log('writeLeadFields', id, fields); if (!hooks.commitIsNoop) Object.assign(store.lead, fields); },
    postNote: async (item, body) => { log('postNote', item, body); if (hooks.notesThrow) throw new Error('note failed'); },
    notify: async (uid, text, item) => { log('notify', uid, item); },
    resolveUserId: async (email) => ({ 'faran@example.com': '111', 'admin2@example.com': '222', 'shafoli@example.com': '333' })[email] || null,
    consultantFor: () => ({ name: 'Shafoli Kapur', email: 'shafoli@example.com' }),
    adminEmails: () => ['faran@example.com', 'admin2@example.com'],
    invalidateQueues: () => { log('invalidateQueues'); },
    withLeadLock: async (key, f) => { log('lock', key); if (hooks.lockDelay) t += hooks.lockDelay; return f(); },
    now: () => t,
    nowIso: () => '2026-09-23T15:04:11.000Z',
    sleep: async () => {},
  });
  return Promise.resolve(fn({ store, calls, names: () => calls.map((c) => c[0]) })).finally(() => Object.assign(U.io, real));
}

async function previewThenExecute(extra = {}) {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: extra.index ?? 0, actor: ACTOR });
  assert.equal(pv.ok, true);
  const p = pv.plan;
  const req = { leadId: '13108401448', index: extra.index ?? 0, confirmText: p.confirmText, reason: REASON, expect: p.expect, actor: ACTOR, ...extra };
  return { pv, res: await U.executeMilestonePaidReversal(req), req };
}

test('THE INCIDENT, end to end: one commit, then the record — and the lead is left unable to onboard', () => withFakeIo(async ({ store, calls, names }) => {
  const { res } = await previewThenExecute();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(names().filter((n) => n === 'commit').length, 1);
  const iCommit = names().indexOf('commit');
  const firstNote = names().indexOf('postNote');
  assert.ok(firstNote > iCommit, 'notes are posted only AFTER the commit');
  assert.equal(store.lead.retainerPaid, '');
  assert.equal(store.lead.conversionStatus, 'Retained — Awaiting Payment');
  const row = ms.readPayments(store.lead).pay[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.undone.by, 'Faran');
  const notes = calls.filter((c) => c[0] === 'postNote');
  assert.ok(notes.some((c) => c[1] === '13108401448' && /Payment record removed/.test(c[2]) && /Reason:/.test(c[2])), 'lead note, with the reason');
  assert.ok(notes.some((c) => c[1] === '13108384096'), 'case note — the one the case team is subscribed to');
  const notified = calls.filter((c) => c[0] === 'notify').map((c) => c[1]).sort();
  assert.deepEqual(notified, ['222', '333'], 'the other admin and the RCIC — never the person who did it');
  assert.ok(names().includes('invalidateQueues'));
  assert.ok(res.next.some((x) => /never been sent the e-Transfer request/.test(x)));
  // and the post-state cannot start onboarding
  const { signatureGateForLead } = require('../src/services/caseGateService');
  assert.equal(signatureGateForLead(store.lead).complete, false);
}));

test('it never calls anything that pays, onboards, emails or writes the case', () => {
  const trap = (name) => async () => { throw new Error(`FORBIDDEN: ${name} was called`); };
  const targets = [
    [require('../src/services/paymentService'), ['recordRetainerPaid', 'maybeMarkRetained', 'advanceCaseToPaid', 'setRetainedBy']],
    [ms, ['markMilestonePaid', 'patchPayment', 'sendMilestoneEtransferRequest']],
    [require('../src/services/microsoftMailService'), ['sendEmail']],
    [require('../src/services/retainerStatusReconciler'), ['writeCasePaymentStatus']],
    [require('../src/services/caseGateService'), ['moveCaseToGroup', 'moveCaseToActiveGroup']],
  ];
  const restore = [];
  for (const [mod, keys] of targets) for (const k of keys) { const orig = mod[k]; mod[k] = trap(k); restore.push(() => { mod[k] = orig; }); }
  return withFakeIo(async () => {
    const { res } = await previewThenExecute();
    assert.equal(res.ok, true, JSON.stringify(res));
  }).finally(() => restore.forEach((r) => r()));
});

test('a later milestone on an onboarded case: allowed; lead fields untouched', () => withFakeIo(async ({ store }) => {
  const { res } = await previewThenExecute({ index: 2 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(store.lead.retainerPaid, D, 'the retainer payment date is not the later milestone’s business');
  assert.equal(ms.readPayments(store.lead).pay[2].status, 'pending');
}, {
  lead: baseLead({ milestonePayments: JSON.stringify({ 0: { status: 'paid', paidAt: D }, 2: { status: 'paid', paidAt: D, reference: 'M3' } }) }),
  cm: baseCase({ paymentStatus: 'Paid', caseStage: 'Internal Review', checklistApplied: 'Yes' }),
}));

for (const [label, opts, code] of [
  ['onboarding started', { cm: baseCase({ paymentStatus: 'Paid' }) }, 'ONBOARDING_STARTED'],
  ['Square payment', { lead: baseLead({ squareRetainerTxnId: 'sq1' }) }, 'SQUARE_PAYMENT'],
]) {
  test(`refused (${label}): zero commits, zero notes`, () => withFakeIo(async ({ names }) => {
    const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
    assert.equal(pv.plan.ok, false);
    assert.equal(pv.plan.refusal.code, code);
    const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: '2026-OINP-059', reason: REASON, expect: { mode: 'milestone', entry: 'x', retainerPaid: D }, actor: ACTOR });
    assert.equal(res.ok, false);
    assert.equal(res.code, code);
    assert.ok(!names().includes('commit'));
    assert.ok(!names().includes('postNote'));
  }, opts));
}

test('refused: the case can’t be read → nothing written', () => withFakeIo(async ({ names }) => {
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: '2026-OINP-059', reason: REASON, expect: { mode: 'milestone', entry: 'x', retainerPaid: D }, actor: ACTOR });
  assert.equal(res.code, 'CASE_UNREADABLE');
  assert.ok(!names().includes('commit'));
}, { readCaseThrows: true }));

test('the preview must still match: a changed payment is refused (and so is a wrong confirmation)', () => withFakeIo(async ({ names }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  const stale = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: pv.plan.confirmText, reason: REASON, expect: { ...pv.plan.expect, entry: 'deadbeef0000' }, actor: ACTOR });
  assert.equal(stale.code, 'CHANGED_SINCE_PREVIEW');
  const wrongWord = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: 'UNDO', reason: REASON, expect: pv.plan.expect, actor: ACTOR });
  assert.equal(wrongWord.code, 'CONFIRM_MISMATCH');
  assert.ok(!names().includes('commit'));
}));

test('bad requests are refused before the lock is even taken', () => withFakeIo(async ({ names }) => {
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: 'x', reason: 'short', expect: { mode: 'milestone', entry: 'x', retainerPaid: D }, actor: ACTOR });
  assert.equal(res.status, 400);
  assert.ok(!names().includes('lock'));
}));

test('idempotent retry after a lost response: "already removed", no second write', () => withFakeIo(async ({ names }) => {
  const { res, req } = await previewThenExecute();
  assert.equal(res.ok, true);
  const again = await U.executeMilestonePaidReversal(req);
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(names().filter((n) => n === 'commit').length, 1);
}));

test('a HALF-applied reversal is converged on retry, never reported as done', () => withFakeIo(async ({ store, names }) => {
  // The row landed; the payment date did not (and the process died before converging).
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  const p = pv.plan;
  const pay = ms.readPayments(store.lead).pay; pay[0] = p.after; store.lead.milestonePayments = JSON.stringify(pay);
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: p.confirmText, reason: REASON, expect: p.expect, actor: ACTOR });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.notEqual(res.already, true, 'must not claim success over a payment date left behind');
  assert.equal(store.lead.retainerPaid, '');
  assert.ok(names().includes('commit'));
}));

test('a lock held too long (a hung signature capture): nothing changed, "busy"', () => withFakeIo(async ({ names }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: pv.plan.confirmText, reason: REASON, expect: pv.plan.expect, actor: ACTOR });
  assert.equal(res.code, 'BUSY');
  assert.ok(!names().includes('commit'));
}, { lockDelay: U.LOCK_WAIT_MS + 1 }));

test('commit fails: an honest error, no notes, nothing changed', () => withFakeIo(async ({ store, names }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: pv.plan.confirmText, reason: REASON, expect: pv.plan.expect, actor: ACTOR });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'COMMIT_FAILED');
  assert.ok(!names().includes('postNote'));
  assert.equal(store.lead.retainerPaid, D);
}, { commitThrows: new Error('monday 500') }));

test('Monday never confirms the change: UNDO_INCOMPLETE, and an alarm note so a person checks now', () => withFakeIo(async ({ calls }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: pv.plan.confirmText, reason: REASON, expect: pv.plan.expect, actor: ACTOR });
  assert.equal(res.code, 'UNDO_INCOMPLETE');
  assert.ok(calls.some((c) => c[0] === 'writeLeadFields' && c[2].retainerPaid === ''), 'it tried to converge — payment date first');
  assert.ok(calls.some((c) => c[0] === 'postNote' && /Undo incomplete/.test(c[2])));
}, { commitIsNoop: true }));

test('reads that lag behind the write are waited out — the lock is held until the change reads back', () => withFakeIo(async ({ names }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: pv.plan.confirmText, reason: REASON, expect: pv.plan.expect, actor: ACTOR });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(names().filter((n) => n === 'getLead').length >= 4, 'it re-read until the cleared date was visible');
}, { staleReads: 4 }));

test('lost a race to activation (case turned Paid during the undo): a loud error and alarm notes', () => withFakeIo(async ({ calls }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: pv.plan.confirmText, reason: REASON, expect: pv.plan.expect, actor: ACTOR });
  assert.equal(res.code, 'ONBOARDING_STARTED_DURING_UNDO');
  assert.ok(calls.some((c) => c[0] === 'postNote' && /raced with onboarding/.test(c[2])));
}, { caseAfterCommit: baseCase({ paymentStatus: 'Paid' }) }));

test('notes failing does not undo the undo — it is reported', () => withFakeIo(async ({ store }) => {
  const { res } = await previewThenExecute();
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.code === 'NOTES_FAILED'));
  assert.equal(store.lead.retainerPaid, '');
}, { notesThrow: true }));

test('two undos on one client at once: the second is refused as busy', () => withFakeIo(async () => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  const req = { leadId: '13108401448', index: 0, confirmText: pv.plan.confirmText, reason: REASON, expect: pv.plan.expect, actor: ACTOR };
  const [a, b] = await Promise.all([U.executeMilestonePaidReversal(req), U.executeMilestonePaidReversal(req)]);
  assert.equal([a, b].filter((r) => r.code === 'BUSY').length, 1);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
}));

test('FLAG (staff who can’t undo): a note on the case and the lead, admins + RCIC alerted, nothing written', () => withFakeIo(async ({ calls, names, store }) => {
  const res = await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'Kamalpreet', email: '' }, note: 'This e-transfer was from a different client' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(!names().includes('commit') && !names().includes('writeLeadFields'));
  const notes = calls.filter((c) => c[0] === 'postNote');
  assert.equal(notes.length, 2);
  assert.match(notes[0][2], /don’t countersign/, 'the RCIC is asked to hold — the countersignature is the live trigger');
  assert.deepEqual(calls.filter((c) => c[0] === 'notify').map((c) => c[1]).sort(), ['111', '222', '333'],
    'every admin and the RCIC — the flagger is not an admin, so nobody is left out');
  assert.equal(store.lead.retainerPaid, D);
}));

test('FLAG: needs a name and a short explanation', () => withFakeIo(async () => {
  assert.equal((await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: '' }, note: 'a proper explanation here' })).ok, false);
  assert.equal((await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'K' }, note: 'short' })).ok, false);
}));

// ─── The real commit, through the real leadService (only Monday is faked) ─────

test('the real commit: ONE lead mutation carrying the row, the cleared date and the status', async () => {
  const leadService = require('../src/services/leadService');
  const mondayApi = require('../src/services/mondayApi');
  const lead = baseLead();
  const writes = [];
  const origGet = leadService.getLead, origQuery = mondayApi.query;
  leadService.getLead = async () => ({ ...lead });
  mondayApi.query = async (q, v) => { if (/change_multiple_column_values/.test(q)) writes.push(JSON.parse(v.cols)); return {}; };
  try {
    const plan = U.planMilestonePaidReversal({ lead, index: 0, cm: baseCase(), actor: ACTOR, now: '2026-09-23T15:04:11.000Z' });
    await U.commitReversal(plan);
    assert.equal(writes.length, 1, 'one mutation — no crash can land between the three fields');
    const cols = writes[0];
    assert.equal(cols.date_mm44xpeh, '', 'Retainer Paid cleared with Monday’s universal empty string');
    assert.deepEqual(cols.color_mm44h7pv, { label: 'Retained — Awaiting Payment' });
    const pay = JSON.parse(cols.long_text_mm4vewhk.text);
    assert.equal(pay[0].status, 'pending');
    // …and without clearKeys the date would silently not be written at all
    writes.length = 0;
    await leadService.updateLead('1', { retainerPaid: '' });
    assert.equal(writes.length, 0, 'this is why the commit MUST pass clearKeys');
  } finally { leadService.getLead = origGet; mondayApi.query = origQuery; }
});

test('the real commit compares against FRESH state: a payment changed in the queue is refused', async () => {
  const leadService = require('../src/services/leadService');
  const mondayApi = require('../src/services/mondayApi');
  const lead = baseLead();
  const plan = U.planMilestonePaidReversal({ lead, index: 0, cm: baseCase(), actor: ACTOR });
  const origGet = leadService.getLead, origQuery = mondayApi.query;
  const writes = [];
  leadService.getLead = async () => ({ ...lead, milestonePayments: JSON.stringify({ 0: { status: 'paid', paidAt: '2026-09-24', reference: 'OTHER' } }) });
  mondayApi.query = async () => { writes.push(1); return {}; };
  try {
    await assert.rejects(U.commitReversal(plan), (e) => e.code === 'CHANGED_SINCE_PREVIEW');
    assert.equal(writes.length, 0);
  } finally { leadService.getLead = origGet; mondayApi.query = origQuery; }
});


test('a half-applied reversal where ONLY the payment date is left is still converged, never "already"', () => withFakeIo(async ({ store, names }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  const p = pv.plan;
  // the row and the status landed; the payment date — the dangerous one — did not
  const pay = ms.readPayments(store.lead).pay; pay[0] = p.after; store.lead.milestonePayments = JSON.stringify(pay);
  store.lead.conversionStatus = 'Retained — Awaiting Payment';
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: p.confirmText, reason: REASON, expect: p.expect, actor: ACTOR });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.notEqual(res.already, true, 'a payment date left behind can still start onboarding — never report it done');
  assert.equal(store.lead.retainerPaid, '');
  assert.ok(names().includes('commit'));
}));
