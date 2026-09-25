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
  U._resetFlagThrottle();   // each test starts with no flag on record
  const store = { lead: { ...lead }, cm: cm && { ...cm } };
  const calls = [];
  const log = (name, ...a) => calls.push([name, ...a]);
  let t = 1000;
  Object.assign(U.io, {
    getLead: async (id) => { log('getLead', id); if (hooks.getLeadThrows) throw new Error('read failed'); return hooks.staleReads && hooks.staleReads-- > 0 ? { ...lead } : { ...store.lead }; },
    readCase: async (id) => { log('readCase', id); if (hooks.readCaseThrows) throw new Error('case read failed'); return hooks.caseAfterCommit && calls.some((c) => c[0] === 'commit') ? hooks.caseAfterCommit : (store.cm && { ...store.cm }); },
    commit: async (plan) => {
      log('commit', plan.index);
      if (hooks.commitThrows && !hooks.commitLandsThenThrows) throw hooks.commitThrows;
      if (hooks.commitIsNoop) return { conversion: plan.conversionStatus };
      const pay = ms.readPayments(store.lead).pay;
      if (plan.after) pay[plan.index] = plan.after;
      store.lead.milestonePayments = JSON.stringify(pay);
      if (plan.clearKeys.includes('retainerPaid')) store.lead.retainerPaid = '';
      if (plan.conversionStatus) store.lead.conversionStatus = plan.conversionStatus.to;
      if (hooks.commitLandsThenThrows) { hooks.commitLandsThenThrows = false; throw hooks.commitThrows; }
      return { conversion: plan.conversionStatus };
    },
    writeLeadFields: async (id, fields) => { log('writeLeadFields', id, fields); if (!hooks.commitIsNoop) Object.assign(store.lead, fields); },
    postNote: async (item, body) => { log('postNote', item, body); if (hooks.notesThrow) throw new Error('note failed'); },
    notify: async (uid, text, item) => { log('notify', uid, item); },
    resolveUserId: async (email) => ({ 'faran@example.com': '111', 'admin2@example.com': '222', 'shafoli@example.com': '333' })[email] || null,
    consultantFor: () => ({ name: 'Shafoli Kapur', email: 'shafoli@example.com' }),
    adminEmails: () => ['faran@example.com', 'admin2@example.com'],
    invalidateQueues: () => { log('invalidateQueues'); },
    withLeadLockOrSkip: async (key, waitMs, f) => { log('lock', key, waitMs); if (hooks.lockBusy) return { busy: true }; return f(); },
    isLeadItem: async (id) => { log('isLeadItem', id); if (hooks.isLeadThrows) throw new Error('board read failed'); return hooks.notALead ? false : true; },
    findClaimants: async (id) => { log('findClaimants', id); if (hooks.claimantsThrow) throw new Error('lookup failed'); return hooks.claimants || [{ id: store.lead.id, name: store.lead.fullName }]; },
    caseAssignees: async (id) => { log('caseAssignees', id); if (hooks.assigneesThrow) throw new Error('read failed'); return hooks.assignees || { personIds: [], teamIds: [] }; },
    // squareOrder: what Square says about the retainer link's order ({ paid }); default an open, unpaid link
    readSquareOrder: async (orderId) => { log('readSquareOrder', orderId); if (hooks.squareOrderThrows) throw new Error('square down'); return 'squareOrder' in hooks ? hooks.squareOrder : { paid: false }; },
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

test('a lock held too long (a hung signature capture): the undo gives up WITHOUT running — nothing read, nothing changed, "busy"', () => withFakeIo(async ({ calls, names }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  const before = calls.length;
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: pv.plan.confirmText, reason: REASON, expect: pv.plan.expect, actor: ACTOR });
  assert.equal(res.code, 'BUSY');
  assert.equal(res.status, 409);
  assert.equal(res.error, U.BUSY_MESSAGE);
  assert.match(res.error, /another change to this client’s record is in progress \(a signature, a payment or the status sync\)/i, 'names what is known — five writers hold this lock, not only a signature');
  assert.ok(!names().includes('commit'));
  const lock = calls[before];
  assert.deepEqual(lock, ['lock', '13108401448', U.LEAD_LOCK_WAIT_MS], 'the lock is taken with the give-up budget, and nothing else happens');
  assert.equal(calls.length, before + 1, 'a busy answer reads nothing — the section never started');
}, { lockBusy: true }));

test('the lock is the give-up flavour: the executor never calls the unbounded withLeadLock', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/paymentUndoService.js'), 'utf8');
  assert.match(src, /io\.withLeadLockOrSkip\(key, LEAD_LOCK_WAIT_MS, async \(\) => \{/);
  assert.doesNotMatch(src, /io\.withLeadLock\(/);
  assert.doesNotMatch(src, /queuedAt/, 'no elapsed check after the lock is already held — that never gave up');
  assert.equal(U.LEAD_LOCK_WAIT_MS, require('../src/services/leadMutex').LEAD_LOCK_WAIT_MS, 'one shared budget');
});

test('the record is dated in Toronto, with the zone — the same clock as the row tooltip and the sponsor notes', () => withFakeIo(async ({ calls }) => {
  const { res } = await previewThenExecute();
  assert.equal(res.ok, true, JSON.stringify(res));
  const leadNote = calls.find((c) => c[0] === 'postNote' && c[1] === '13108401448')[2];
  const caseNote = calls.find((c) => c[0] === 'postNote' && c[1] === '13108384096')[2];
  // io.nowIso is 2026-09-23T15:04:11Z → 11:04 am in Toronto (EDT)
  assert.match(leadNote, /Removed by Faran — 23 Sep 2026, 11:04 am \(Toronto\)\. <b>Reason:<\/b>/);
  assert.match(caseNote, /Removed by Faran — 23 Sep 2026, 11:04 am \(Toronto\)\./);
  assert.doesNotMatch(leadNote, /on 2026-09-23/, 'never the UTC calendar date');
}));

test('after 8 pm Toronto the record still names the Toronto day, and the alarm notes carry the same stamp', () => withFakeIo(async ({ calls }) => {
  U.io.nowIso = () => '2026-09-24T02:30:00.000Z';   // 10:30 pm on the 23rd in Toronto
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: pv.plan.confirmText, reason: REASON, expect: pv.plan.expect, actor: ACTOR });
  assert.equal(res.code, 'ONBOARDING_STARTED_DURING_UNDO');
  const notes = calls.filter((c) => c[0] === 'postNote').map((c) => c[2]);
  assert.ok(notes.some((n) => /Removed by Faran — 23 Sep 2026, 10:30 pm \(Toronto\)/.test(n)), 'the 23rd, not the 24th');
  assert.ok(notes.some((n) => /Undo raced with onboarding<\/b> — 23 Sep 2026, 10:30 pm \(Toronto\)\./.test(n)), 'the alarm is dated the same way');
}, { caseAfterCommit: baseCase({ paymentStatus: 'Paid' }) }));

test('an "Undo incomplete" alarm is dated in Toronto too', () => withFakeIo(async ({ calls }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: pv.plan.confirmText, reason: REASON, expect: pv.plan.expect, actor: ACTOR });
  assert.ok(calls.some((c) => c[0] === 'postNote' && /Undo incomplete<\/b> — 23 Sep 2026, 11:04 am \(Toronto\)\. Monday didn’t confirm/.test(c[2])));
}, { commitIsNoop: true }));

test('a Square payment LINK alone (order id, no txn id): Square is asked, and an OPEN link is a warning, not a refusal — the undo runs', () => withFakeIo(async ({ store, names, calls }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  assert.equal(pv.plan.ok, true, JSON.stringify(pv.plan));
  assert.deepEqual(calls.filter((c) => c[0] === 'readSquareOrder').map((c) => c[1]), ['ord-legacy-link'], 'the order is read by its id');
  const w = pv.plan.warnings.find((x) => x.code === 'SQUARE_LINK_EXISTS');
  assert.ok(w, 'the warning is there');
  assert.match(w.message, /Square shows no payment on it yet/);
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: pv.plan.confirmText, reason: REASON, expect: pv.plan.expect, actor: ACTOR });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(names().includes('commit'));
  assert.equal(store.lead.retainerPaid, '');
  assert.ok(res.warnings.some((x) => x.code === 'SQUARE_LINK_EXISTS'), 'the warning is carried onto the result');
  assert.equal(calls.filter((c) => c[0] === 'readSquareOrder').length, 2, 'execute asks Square again — fresh state, like every other read');
}, { lead: baseLead({ squareRetainerOrderId: 'ord-legacy-link' }) }));

test('a Square link the ORDER says is PAID refuses at preview AND at execute — nothing is written (Mark paid first, then the client paid the link: no txn id anywhere)', () => withFakeIo(async ({ store, names }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  assert.equal(pv.plan.ok, false);
  assert.equal(pv.plan.refusal.code, 'SQUARE_PAYMENT');
  assert.match(pv.plan.refusal.message, /Square shows the payment link for this retainer as PAID/);
  // a stale dialog that was opened while the link was still open cannot get past execute either
  const expect = { mode: 'milestone', entry: U.entryFingerprint(ms.readPayments(store.lead).pay[0]), retainerPaid: D };
  const res = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: '2026-OINP-059', reason: REASON, expect, actor: ACTOR });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'SQUARE_PAYMENT');
  assert.ok(!names().includes('commit') && !names().includes('postNote') && !names().includes('notify'));
  assert.equal(store.lead.retainerPaid, D);
}, { lead: baseLead({ squareRetainerOrderId: 'ord-legacy-link' }), squareOrder: { paid: true } }));

test('Square cannot be checked: the undo still runs, and the warning says the check did not happen; a txn id on the lead never asks Square at all', () => withFakeIo(async ({ names, calls }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  assert.equal(pv.plan.ok, true, JSON.stringify(pv.plan));
  assert.match(pv.plan.warnings.find((x) => x.code === 'SQUARE_LINK_EXISTS').message, /Square could not be checked just now/);
  await withFakeIo(async ({ names: n2 }) => {
    const p2 = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
    assert.equal(p2.plan.refusal.code, 'SQUARE_PAYMENT');
    assert.ok(!n2().includes('readSquareOrder'), 'the txn id already says it was paid');
  }, { lead: baseLead({ squareRetainerOrderId: 'ord-legacy-link', squareRetainerTxnId: 'sq1' }) });
  await withFakeIo(async ({ names: n3 }) => {
    await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 1, actor: ACTOR });
    assert.ok(!n3().includes('readSquareOrder'), 'a later milestone never carried the retainer link');
  }, { lead: baseLead({ squareRetainerOrderId: 'ord-legacy-link', milestonePayments: JSON.stringify({ 0: { status: 'paid', paidAt: D }, 1: { status: 'paid', paidAt: D } }) }) });
  await withFakeIo(async ({ names: n4 }) => {
    await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
    assert.ok(!n4().includes('readSquareOrder'), 'no link, nothing to ask');
  });
  assert.ok(names().includes('readSquareOrder') && calls.length);
}, { lead: baseLead({ squareRetainerOrderId: 'ord-legacy-link' }), squareOrderThrows: true }));

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

// ─── Review round 2 ───────────────────────────────────────────────────────────

test('only a record on the Leads board can be undone or flagged — any other Monday item is refused', () => withFakeIo(async ({ names }) => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  assert.equal(pv.ok, false);
  assert.equal(pv.code, 'NOT_A_LEAD');
  const f = await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'K' }, note: 'a proper explanation here' });
  assert.equal(f.ok, false);
  assert.equal(f.status, 404);
  assert.ok(!names().includes('postNote'));
}, { notALead: true }));

test('the board check failing is a refusal (fail closed), never a pass', () => withFakeIo(async () => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  assert.equal(pv.ok, false);
  assert.equal(pv.status, 503);
}, { isLeadThrows: true }));

test('SHARED CASE end to end: the preview warns and asks for LEAD-<id>; the case ref no longer confirms', () => withFakeIo(async () => {
  const pv = await U.previewMilestonePaidReversal({ leadId: '13108401448', index: 0, actor: ACTOR });
  assert.ok(pv.plan.warnings.some((w) => w.code === 'SHARED_CASE'));
  assert.equal(pv.plan.confirmText, 'LEAD-13108401448');
  const bad = await U.executeMilestonePaidReversal({ leadId: '13108401448', index: 0, confirmText: '2026-OINP-059', reason: REASON, expect: pv.plan.expect, actor: ACTOR });
  assert.equal(bad.code, 'CONFIRM_MISMATCH');
}, { claimants: [{ id: '13108401448', name: 'Test Client' }, { id: '13100000001', name: 'Other Person' }] }));

test('a LOST RESPONSE: the write landed but the reply never came — reported as done, with the notes and alerts', () => withFakeIo(async ({ store, names }) => {
  const { res } = await previewThenExecute();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(store.lead.retainerPaid, '');
  assert.equal(names().filter((n) => n === 'commit').length, 1, 'never written twice');
  assert.ok(names().includes('postNote') && names().includes('notify'));
}, { commitThrows: new Error('socket hang up'), commitLandsThenThrows: true }));

test('a write that really failed stays a failure — no notes, no alerts', () => withFakeIo(async ({ store, names }) => {
  const { res } = await previewThenExecute();
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
  assert.equal(store.lead.retainerPaid, D);
  assert.ok(!names().includes('postNote') && !names().includes('notify'));
}, { commitThrows: new Error('socket hang up') }));

test('RETAINER-DATE mode: honest wording — the date was removed, the row is unchanged but carries the marker', () => withFakeIo(async ({ store, calls }) => {
  const { res } = await previewThenExecute();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.message, /Removed the Retainer Paid date \(2026-09-22\)\. The milestone row was not paid and is unchanged\./);
  assert.deepEqual(res.removed, { retainerPaidDate: D });
  const row = ms.readPayments(store.lead).pay[0];
  assert.equal(row.status, 'requested');
  assert.equal(row.undone.by, 'Faran', 'the tooltip can say who removed the date');
  const leadNote = calls.find((c) => c[0] === 'postNote' && c[1] === '13108401448')[2];
  assert.ok(!/Removed record:/.test(leadNote), 'no "removed record" when no record was removed');
  const caseNote = calls.find((c) => c[0] === 'postNote' && c[1] === '13108384096')[2];
  assert.match(caseNote, /Retainer Paid date removed/);
}, { lead: baseLead({ milestonePayments: JSON.stringify({ 0: { status: 'requested', requestedAt: D, reference: 'TDOT-01448-M1' } }) }), cm: baseCase({ paymentStatus: 'Not Paid' }) }));

test('FLAG: a second flag on the same row within 10 minutes sends nothing new', () => withFakeIo(async ({ calls }) => {
  U._resetFlagThrottle();
  const a = await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'K' }, note: 'a proper explanation here' });
  assert.equal(a.ok, true);
  const before = calls.length;
  const b = await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'K' }, note: 'a proper explanation here' });
  assert.equal(b.ok, false);
  assert.equal(b.status, 429);
  assert.equal(calls.length, before, 'no read, no note, no alert');
  U._resetFlagThrottle();
}));

test('FLAG: one person is held to a few flags per window across every row and client — the sixth is refused', () => withFakeIo(async ({ calls, store }) => {
  U._resetFlagThrottle();
  const actor = { name: 'K', email: 'k@example.com', verified: true };
  // five different rows on the same lead, then a sixth on another client
  for (let i = 0; i < U.FLAG_ACTOR_MAX; i++) {
    const r = await U.flagPaymentError({ leadId: '13108401448', index: i, actor, note: 'a proper explanation here' });
    assert.equal(r.ok, true, `flag ${i + 1}: ${JSON.stringify(r)}`);
  }
  const before = calls.length;
  store.lead.id = '13100000002';
  const sixth = await U.flagPaymentError({ leadId: '13100000002', index: 0, actor, note: 'a proper explanation here' });
  assert.equal(sixth.ok, false);
  assert.equal(sixth.status, 429);
  assert.match(sixth.error, /flagged 5 payments in the last few minutes/);
  assert.equal(calls.length, before, 'no read, no note, no alert');
  // someone else is not held back by it
  const other = await U.flagPaymentError({ leadId: '13100000002', index: 0, actor: { name: 'Shafoli', email: 'shafoli@example.com', verified: true }, note: 'a proper explanation here' });
  assert.equal(other.ok, true, JSON.stringify(other));
  // the same person by a different casing of the address is the same person
  store.lead.id = '13100000003';
  const again = await U.flagPaymentError({ leadId: '13100000003', index: 0, actor: { name: 'K', email: 'K@Example.com', verified: true }, note: 'a proper explanation here' });
  assert.equal(again.status, 429);
  U._resetFlagThrottle();
}));

test('FLAG: everyone on the shared admin key shares ONE window — a new typed name (or a typed address) is not a new person; Monday sign-ins are not held back by it', () => withFakeIo(async ({ store }) => {
  U._resetFlagThrottle();
  // three flags as "A", two as "B": the sixth is refused whatever name is typed
  let n = 0;
  const flag = (actor) => { store.lead.id = String(13100000100 + n); return U.flagPaymentError({ leadId: store.lead.id, index: 0, actor, note: 'a proper explanation here' }).finally(() => n++); };
  for (const name of ['A', 'A', 'A', 'B', 'B']) assert.equal((await flag({ name })).ok, true, name);
  assert.equal((await flag({ name: 'C' })).status, 429, 'a sixth spelling opens no sixth window');
  assert.equal((await flag({ name: 'Unidentified (shared admin key)' })).status, 429, 'nor does the placeholder itself');
  assert.equal((await flag({ name: 'D', email: 'd@example.com' })).status, 429, 'an address the page typed is not a sign-in (verified is what counts)');
  assert.equal((await flag({ name: 'D', email: 'd@example.com', verified: false })).status, 429);
  // a Monday sign-in has a window of their own
  assert.equal((await flag({ name: 'Shafoli', email: 'shafoli@example.com', verified: true })).ok, true);
  // …and a sign-in with no address on file lands in the shared window rather than an unbounded one
  assert.equal((await flag({ name: 'Nameless', email: '', verified: true })).status, 429);
  U._resetFlagThrottle();
}));

test('FLAG: the per-person window slides — once the oldest flag is older than the window, one more is allowed', () => withFakeIo(async ({ store }) => {
  U._resetFlagThrottle();
  let t = 1000;
  U.io.now = () => t;
  const actor = { name: 'Kamalpreet' };   // no sign-in: the shared-key window
  for (let i = 0; i < U.FLAG_ACTOR_MAX; i++) {
    t += 1000;
    assert.equal((await U.flagPaymentError({ leadId: '13108401448', index: i, actor, note: 'a proper explanation here' })).ok, true);
  }
  store.lead.id = '13100000002';
  assert.equal((await U.flagPaymentError({ leadId: '13100000002', index: 0, actor, note: 'a proper explanation here' })).status, 429);
  t = 2000 + U.FLAG_COOLDOWN_MS;   // the first flag (at 2000) has just aged out
  const r = await U.flagPaymentError({ leadId: '13100000002', index: 0, actor, note: 'a proper explanation here' });
  assert.equal(r.ok, true, JSON.stringify(r));
  store.lead.id = '13100000003';
  assert.equal((await U.flagPaymentError({ leadId: '13100000003', index: 0, actor, note: 'a proper explanation here' })).status, 429, 'and the window is full again');
  U._resetFlagThrottle();
}));

test('FLAG: a refused flag never counts against the person, and the row throttle still comes first', () => withFakeIo(async ({ store }) => {
  U._resetFlagThrottle();
  const actor = { name: 'K', email: 'k@example.com', verified: true };
  assert.equal((await U.flagPaymentError({ leadId: '13108401448', index: 0, actor, note: 'a proper explanation here' })).ok, true);
  for (let n = 0; n < 10; n++) {
    const r = await U.flagPaymentError({ leadId: '13108401448', index: 0, actor, note: 'a proper explanation here' });
    assert.match(r.error, /flagged a few minutes ago/, 'the row answer, not the person answer');
  }
  store.lead.id = '13100000002';
  assert.equal((await U.flagPaymentError({ leadId: '13100000002', index: 0, actor, note: 'a proper explanation here' })).ok, true, 'ten refused repeats did not use up the window');
  U._resetFlagThrottle();
}));

test('FLAG: when nobody could be alerted, the message says so and tells staff to tell an admin', () => withFakeIo(async () => {
  U._resetFlagThrottle();
  U.io.resolveUserId = async () => null;
  U.io.consultantFor = () => null;
  const r = await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'K' }, note: 'a proper explanation here' });
  assert.equal(r.ok, true);
  assert.equal(r.notified, 0);
  assert.match(r.message, /nobody could be alerted automatically\. Tell an admin directly/);
  U._resetFlagThrottle();
}));

test('FLAG: the message counts who was alerted, and names the RCIC only when the RCIC was reached', () => withFakeIo(async () => {
  U._resetFlagThrottle();
  const r = await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'K' }, note: 'a proper explanation here' });
  assert.match(r.message, /3 people were alerted on Monday \(the admins and the RCIC\)/);
  U._resetFlagThrottle();
  U.io.consultantFor = () => ({ name: 'Nobody', email: 'nobody@example.com' });   // no Monday account
  const r2 = await U.flagPaymentError({ leadId: '13108401448', index: 1, actor: { name: 'K' }, note: 'a proper explanation here' });
  assert.match(r2.message, /2 people were alerted on Monday \(the admins\)/);
  U._resetFlagThrottle();
}));

test('FLAG: the RCIC is asked to hold only while a payment actually stands', () => withFakeIo(async ({ calls }) => {
  U._resetFlagThrottle();
  await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'K' }, note: 'a proper explanation here' });
  const note = calls.find((c) => c[0] === 'postNote')[2];
  assert.ok(!/don’t countersign/.test(note), 'no payment on record — nothing for the countersignature to trigger');
  U._resetFlagThrottle();
}, { lead: baseLead({ milestonePayments: JSON.stringify({ 0: { status: 'requested', requestedAt: D } }), retainerPaid: '' }) }));

test('FLAG under CASE_VISIBILITY=assigned: only people on the case may flag it; a failed check refuses', () => withFakeIo(async ({ names }) => {
  U._resetFlagThrottle();
  const viewer = { userId: '555', teamIds: [], isAdmin: false, scope: 'assigned' };
  const prev = process.env.CASE_VISIBILITY;
  process.env.CASE_VISIBILITY = 'assigned';
  try {
    const no = await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'K' }, note: 'a proper explanation here', viewer });
    assert.equal(no.status, 403);
    assert.ok(!names().includes('postNote'));
    U.io.caseAssignees = async () => ({ personIds: ['555'], teamIds: [] });
    const yes = await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'K' }, note: 'a proper explanation here', viewer });
    assert.equal(yes.ok, true);
    U._resetFlagThrottle();
    U.io.caseAssignees = async () => { throw new Error('read failed'); };
    const err = await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'K' }, note: 'a proper explanation here', viewer });
    assert.equal(err.status, 503);
    U._resetFlagThrottle();
    const admin = await U.flagPaymentError({ leadId: '13108401448', index: 0, actor: { name: 'K' }, note: 'a proper explanation here', viewer: { ...viewer, isAdmin: true, scope: 'all' } });
    assert.equal(admin.ok, true, 'admins are never scoped');
  } finally {
    if (prev === undefined) delete process.env.CASE_VISIBILITY; else process.env.CASE_VISIBILITY = prev;
    U._resetFlagThrottle();
  }
}));
