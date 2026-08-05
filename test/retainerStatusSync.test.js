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
  assert.equal(R.classifyDrift(PAID, 'Not Paid').to, 'Paid');
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
  assert.match(v.reason, /no longer exists/);
});

test('every verdict carries a human-readable reason', () => {
  for (const [lead, have] of [[PAID, 'Signed (Unpaid)'], [SIGNED, ''], [SIGNED, 'Paid'], [PAID, null],
                              [LEAD({ retainerSigned: 'x', clientMasterItemId: '' }), '']]) {
    assert.ok(R.classifyDrift(lead, have).reason.length > 10);
  }
});

/* ── the retry hole the fix closes ────────────────────────────────────── */

test('recordRetainerPaid re-runs the case reconcile when the lead is already paid', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/paymentService'), 'utf8');
  const branch = src.slice(src.indexOf('if (lead.retainerPaid) {'), src.indexOf('// 1. Lead Board'));
  assert.match(branch, /retainerStatusReconciler/,
    'the already-paid short-circuit must retry the Client Master write, not just the lead funnel');
  assert.match(branch, /maybeMarkRetained/, 'and must keep the existing Retained self-heal');
});

test('the Client Master webhook carries a manual "Paid" back to the lead', () => {
  const src = require('fs').readFileSync(require.resolve('../src/routes/mondayWebhook'), 'utf8');
  const i = src.indexOf("value?.label?.text === 'Paid'");
  assert.ok(i > 0);
  const branch = src.slice(i, i + 900);
  assert.match(branch, /reconcileCase/, 'staff marking the board Paid must reach the lead');
  assert.match(branch, /onRetainerPaid/, 'and must still fire the existing onboarding trigger');
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

test('the sweep is scheduled', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/scheduler'), 'utf8');
  assert.match(src, /sweepRetainerStatus/);
});
