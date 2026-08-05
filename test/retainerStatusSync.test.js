'use strict';

// Retainer/payment status consistency between the Lead Board and Client Master.
//
// The bug class these pin down: the lead is stamped paid/signed FIRST and the
// Client Master write happens second and best-effort. When the second write
// failed, the "already done" marker on the lead made every retry path — the
// Square webhook redelivery, the 5-minute payment reconciler, a staff re-click
// of "Mark paid" — skip the repair, so the case sat unpaid and un-onboarded
// forever with nothing reporting it.

const test   = require('node:test');
const assert = require('node:assert/strict');

const R = require('../src/services/retainerStatusReconciler');

/* ── deriveCmPaymentStatus ─────────────────────────────────────────────── */

test('derive: signed + paid ⇒ Paid', () => {
  assert.equal(R.deriveCmPaymentStatus({ retainerSigned: '2026-08-01', retainerPaid: '2026-08-02' }), 'Paid');
});

test('derive: signed, not paid ⇒ Signed (Unpaid)', () => {
  assert.equal(R.deriveCmPaymentStatus({ retainerSigned: '2026-08-01' }), 'Signed (Unpaid)');
});

test('derive: nothing signed ⇒ null (no claim to make)', () => {
  assert.equal(R.deriveCmPaymentStatus({}), null);
  assert.equal(R.deriveCmPaymentStatus({ retainerSent: '2026-08-01' }), null);
  assert.equal(R.deriveCmPaymentStatus(null), null);
});

test('derive: PAID BEFORE SIGNED stays null — onboarding must not start on an unsigned retainer', () => {
  // A walk-in who pays at the desk before signing has genuinely paid, but "Paid"
  // on the case is the onboarding trigger. paymentService defers it on purpose;
  // the reconciler must not undo that deferral behind its back.
  assert.equal(R.deriveCmPaymentStatus({ retainerPaid: '2026-08-02' }), null);
});

test('derive: whitespace-only dates are not evidence', () => {
  assert.equal(R.deriveCmPaymentStatus({ retainerSigned: '   ', retainerPaid: '  ' }), null);
});

/* ── classifyDrift ────────────────────────────────────────────────────── */

const LEAD = (over = {}) => ({ id: '1', clientMasterItemId: '999', ...over });
const SIGNED = LEAD({ retainerSigned: '2026-08-01' });
const PAID   = LEAD({ retainerSigned: '2026-08-01', retainerPaid: '2026-08-02' });

test('THE BUG: lead paid, case still "Signed (Unpaid)" ⇒ upgrade the case to Paid', () => {
  const v = R.classifyDrift(PAID, 'Signed (Unpaid)');
  assert.equal(v.action, 'upgrade-cm');
  assert.equal(v.to, 'Paid');
});

test('lead paid, case still carrying the board automation stamp ⇒ upgrade to Paid', () => {
  assert.equal(R.classifyDrift(PAID, 'Alreaday Sent').to, 'Paid');
  assert.equal(R.classifyDrift(PAID, '').to, 'Paid');
  // "Not Paid" is deliberately NOT in this list — see the conflict test below.
});

test('already in sync ⇒ no write', () => {
  assert.equal(R.classifyDrift(PAID, 'Paid').action, 'none');
  assert.equal(R.classifyDrift(SIGNED, 'Signed (Unpaid)').action, 'none');
});

test('"Paid" is matched case-insensitively so a re-cased label is not re-written', () => {
  assert.equal(R.classifyDrift(PAID, 'paid').action, 'none');
});

test('signed lead ⇒ fills a blank or automation-stamped cell with Signed (Unpaid)', () => {
  assert.equal(R.classifyDrift(SIGNED, '').to, 'Signed (Unpaid)');
  assert.equal(R.classifyDrift(SIGNED, 'Alreaday Sent').to, 'Signed (Unpaid)');
});

test('a STAFF-chosen unpaid label is never overwritten — it says the same thing', () => {
  // "Not Paid" and "Working on it" are human choices. Both mean unpaid, exactly
  // like "Signed (Unpaid)", so churning them adds noise and erases intent.
  assert.equal(R.classifyDrift(SIGNED, 'Not Paid').action, 'none');
  assert.equal(R.classifyDrift(SIGNED, 'Working on it').action, 'none');
});

test('NEVER downgrades a paid case — the lead is corrected instead', () => {
  // Staff marking the board Paid is how the firm records an e-transfer. That
  // evidence outranks a blank date column, and must never be erased.
  const v = R.classifyDrift(SIGNED, 'Paid');
  assert.equal(v.action, 'backstamp-lead');
  for (const have of ['Paid', 'paid']) {
    assert.notEqual(R.classifyDrift(LEAD({}), have).action, 'upgrade-cm');
  }
});

test('unsigned + unpaid lead ⇒ hands off entirely, whatever the board says', () => {
  for (const have of ['', 'Alreaday Sent', 'Not Paid', 'Signed (Unpaid)']) {
    assert.equal(R.classifyDrift(LEAD({}), have).action, 'none', `must not touch "${have}"`);
  }
});

test('signed lead with no case row ⇒ flagged for a human, never auto-created', () => {
  const v = R.classifyDrift(LEAD({ retainerSigned: '2026-08-01', clientMasterItemId: '' }), '');
  assert.equal(v.action, 'no-case');
});

test('lead pointing at a deleted case row ⇒ flagged, not silently repaired', () => {
  // Live on the board today: two leads marked Retained + paid whose Client
  // Master rows were deleted. Nothing detected it before this sweep existed.
  const v = R.classifyDrift(PAID, null);
  assert.equal(v.action, 'dangling');
  assert.match(v.reason, /not a live case row/);
});

test('every verdict carries a human-readable reason', () => {
  for (const [lead, have] of [[PAID, 'Signed (Unpaid)'], [SIGNED, ''], [SIGNED, 'Paid'], [PAID, null],
                              [LEAD({ retainerSigned: 'x', clientMasterItemId: '' }), '']]) {
    assert.ok(R.classifyDrift(lead, have).reason.length > 10);
  }
});

/* ── a human's "Not Paid" must win ─────────────────────────────────────── */

test('a case corrected back to "Not Paid" is NEVER rewritten to Paid', () => {
  // The trap: staff mark Paid by mistake, the lead gets stamped, staff correct
  // the board — and a naive reconciler treats the now-stale lead date as truth
  // and puts "Paid" back every 15 minutes, restarting onboarding and resuming
  // chasing emails against a client who has not paid. Nothing clears
  // lead.retainerPaid, so the fight would never end.
  const v = R.classifyDrift(PAID, 'Not Paid');
  assert.equal(v.action, 'conflict');
  assert.notEqual(v.action, 'upgrade-cm');
  assert.match(v.reason, /clear the lead/i, 'the report must say how to resolve it');
  assert.equal(R.classifyDrift(PAID, 'Working on it').action, 'conflict');
});

test('but a system-authored label is still upgraded to Paid — the original bug stays fixed', () => {
  for (const have of ['', 'Signed (Unpaid)', 'Alreaday Sent']) {
    assert.equal(R.classifyDrift(PAID, have).action, 'upgrade-cm', `"${have}" is not a human's word`);
  }
});

test('conflict is a human verdict, not one the sweep repairs', () => {
  assert.ok(R.NEEDS_HUMAN.includes('conflict'));
  assert.ok(!R.REPAIRABLE.includes('conflict'));
});

/* ── applyVerdict: the paths that write to a live board ────────────────── */

function withFakeIo(fn) {
  const real = { ...R.io };
  const calls = [];
  for (const k of Object.keys(R.io)) R.io[k] = async (...a) => { calls.push([k, ...a]); };
  return Promise.resolve(fn(calls)).finally(() => Object.assign(R.io, real));
}
const names = (calls) => calls.map((c) => c[0]);

test('upgrading a case to Paid must NOT also call onRetainerPaid directly', () => {
  // Monday fires change_column_value for API writes, so writing "Paid" already
  // reaches Phase 1 through the webhook. Calling onRetainerPaid here as well
  // runs it twice, and it is not idempotent across that pair: the second run
  // still sees checklistTemplateApplied "No" with the stage already advanced,
  // takes the deferred-resume branch, and sends the client a SECOND intake
  // email — sendIntakeEmail has no already-sent guard.
  return withFakeIo(async (calls) => {
    const r = await R.applyVerdict(PAID, { action: 'upgrade-cm', to: 'Paid', reason: 'x' }, { caseRef: 'C-1' });
    assert.equal(r.changed, true);
    assert.ok(names(calls).includes('writeCasePaymentStatus'), 'it must write the label');
    assert.ok(!names(calls).some((n) => /onRetainerPaid/i.test(n)), 'and must not fire onboarding itself');
    assert.ok(names(calls).includes('maybeMarkRetained'), 'it should still heal a missed Retained flip');
  });
});

test('backstamping writes the payment date to the lead, with a note', () => {
  return withFakeIo(async (calls) => {
    const r = await R.applyVerdict(SIGNED, { action: 'backstamp-lead', reason: 'x' },
      { caseRef: 'C-2', paymentDate: '2026-07-30' });
    assert.equal(r.changed, true);
    const upd = calls.find((c) => c[0] === 'updateLead');
    assert.deepEqual(upd[2], { retainerPaid: '2026-07-30' }, 'the board\'s own confirmation date, not today');
    assert.ok(names(calls).includes('postLeadNote'), 'staff must be able to see why the date appeared');
  });
});

test('dryRun writes absolutely nothing, for every repairable verdict', () => {
  return withFakeIo(async (calls) => {
    for (const v of [{ action: 'upgrade-cm', to: 'Paid', reason: 'x' }, { action: 'backstamp-lead', reason: 'x' }]) {
      const r = await R.applyVerdict(PAID, v, { caseRef: 'C-3' }, { dryRun: true });
      assert.equal(r.changed, false);
    }
    assert.deepEqual(calls, [], 'report mode must never touch the board');
  });
});

test('verdicts only a human can settle never write either', () => {
  return withFakeIo(async (calls) => {
    for (const action of R.NEEDS_HUMAN) {
      const r = await R.applyVerdict(PAID, { action, reason: 'x' }, null);
      assert.equal(r.changed, false, `${action} must not write`);
    }
    assert.deepEqual(calls, []);
  });
});

test('a date column carrying a time is trimmed, never written raw', () => {
  // A date column with time enabled returns "YYYY-MM-DD HH:MM" as text; the
  // lead's date column rejects that, and the failure would repeat forever.
  assert.equal(R.asDateOnly('2026-07-30 14:05'), '2026-07-30');
  assert.equal(R.asDateOnly('2026-07-30'), '2026-07-30');
  assert.equal(R.asDateOnly('rubbish'), '');
  assert.equal(R.asDateOnly(null), '');
});

/* ── reconcileCase: resolving a case back to its lead ─────────────────── */

const leadService = require('../src/services/leadService');

async function withLeads(rows, fn) {
  const real = leadService.findAllByColumnValue;
  leadService.findAllByColumnValue = async () => rows;
  try { return await fn(); } finally { leadService.findAllByColumnValue = real; }
}

test('REFUSES to back-stamp when two leads claim the same case', () => {
  // Stamping a payment onto the wrong applicant is worse than leaving the drift
  // visible. This is the only rail preventing it.
  return withFakeIo((calls) => withLeads(
    [{ id: '1', retainerSigned: '2026-08-01', clientMasterItemId: '9' },
     { id: '2', retainerSigned: '2026-08-01', clientMasterItemId: '9' }],
    async () => {
      const r = await R.reconcileCase('9');
      assert.equal(r.action, 'ambiguous');
      assert.equal(r.changed, false);
      assert.deepEqual(calls, [], 'nothing may be written under ambiguity');
    }));
});

test('a legacy case with no lead behind it is left alone', () => {
  return withFakeIo((calls) => withLeads([], async () => {
    const r = await R.reconcileCase('9');
    assert.equal(r.action, 'none');
    assert.deepEqual(calls, [], 'it must not invent a lead');
  }));
});

test('an empty case id is a no-op', async () => {
  assert.equal((await R.reconcileCase('')).action, 'none');
});

/* ── wiring ───────────────────────────────────────────────────────────── */

test('recordRetainerPaid re-runs the case reconcile when the lead is already paid', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/paymentService'), 'utf8');
  const branch = src.slice(src.indexOf('if (lead.retainerPaid) {'), src.indexOf('// 1. Lead Board'));
  const code = branch.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');   // ignore comments
  assert.match(code, /reconcileLead/, 'the already-paid short-circuit must retry the Client Master write');
  assert.match(code, /maybeMarkRetained/, 'and must keep the existing Retained self-heal');
});

test('the Client Master webhook carries a manual "Paid" back to the lead', () => {
  const src = require('fs').readFileSync(require.resolve('../src/routes/mondayWebhook'), 'utf8');
  const i = src.indexOf("value?.label?.text === 'Paid'");
  assert.ok(i > 0);
  const branch = src.slice(i, src.indexOf('}', src.indexOf('reconcileCase', i)));
  const code = branch.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.match(code, /reconcileCase\(pulseId\)/, 'staff marking the board Paid must reach the lead');
  assert.match(code, /onRetainerPaid/, 'and must still fire the existing onboarding trigger');
});

test('every Client Master column the reconciler queries is actually defined', () => {
  // Caught live: findStalledCases referenced CM.caseStage, which was missing
  // from the column map. `undefined` went into the GraphQL ids array, the stage
  // never matched, and the scan reported zero stalled cases while 19 real ones
  // sat there — a silent all-clear, the worst possible failure for an audit.
  const src = require('fs').readFileSync(require.resolve('../src/services/retainerStatusReconciler'), 'utf8');
  const map = src.slice(src.indexOf('const CM = {'), src.indexOf('};', src.indexOf('const CM = {')));
  const defined = new Set([...map.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => m[1]));
  const used = new Set([...src.matchAll(/\bCM\.(\w+)\b/g)].map((m) => m[1]));
  for (const key of used) {
    assert.ok(defined.has(key), `CM.${key} is used but not defined in the column map`);
  }
  for (const key of defined) {
    assert.match(map.match(new RegExp(`${key}:\\s*'([^']+)'`))[1], /^[a-z_]+_?\w*$/,
      `CM.${key} must be a Monday column id`);
  }
});

test('the sweep is scheduled, and the board-wide scan is NOT on the 15-minute job', () => {
  const src  = require('fs').readFileSync(require.resolve('../src/services/scheduler'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');   // a commented-out cron is not a cron
  assert.match(code, /cron\.schedule\('7,22,37,52 \* \* \* \*',[\s\S]{0,120}sweepRetainerStatus/,
    'the repair sweep runs every 15 minutes');
  assert.match(code, /cron\.schedule\('12 \* \* \* \*',[\s\S]{0,160}findStalledCases/,
    'the full-board report runs hourly, not on the repair job');
  // The repair sweep must not drag a full pass of the case board with it.
  const sweepCall = /sweepRetainerStatus\(([^)]*)\)/.exec(code);
  assert.ok(!/includeStalled\s*:\s*true/.test(sweepCall[1]), 'the 15-minute job stays cheap');
});

test('a slow sweep is skipped rather than stacked on top of itself', async () => {
  // Two overlapping sweeps would double-write the same repairs.
  const svc = require('../src/services/retainerStatusReconciler');
  const leadService = require('../src/services/leadService');
  const real = leadService.listAllLeads;
  let concurrent = 0, sawOverlap = false;
  leadService.listAllLeads = async () => {
    concurrent++;
    if (concurrent > 1) sawOverlap = true;
    await new Promise((r) => setTimeout(r, 20));
    concurrent--;
    return [];
  };
  try {
    const [a, b] = await Promise.all([svc.sweepRetainerStatus({ dryRun: true }), svc.sweepRetainerStatus({ dryRun: true })]);
    assert.ok(a.skipped || b.skipped, 'the second concurrent sweep must bow out');
    assert.equal(sawOverlap, false, 'and must never run alongside the first');
  } finally {
    leadService.listAllLeads = real;
  }
});
