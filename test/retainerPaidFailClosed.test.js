'use strict';

// onRetainerPaid's state read decides "harmless date refresh" vs "FULL RESET
// + re-fired onboarding". It used to fail OPEN into the reset: on 2026-08-05 a
// rate-limit burst made three healthy, fully-seeded cases (2026-SV-004/007/009)
// read as first-time payments — Applied flags wiped, intake re-emailed to
// clients mid-case. These pin the new fail-CLOSED behavior.

const test   = require('node:test');
const assert = require('node:assert/strict');

const retainerService = require('../src/services/retainerService');
const mondayApi       = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

function harness({ readFailures = 0, applied = 'No', stage = '' }) {
  let readAttempts = 0;
  const writes = [];
  const notes = [];
  const fn = async (q, vars) => {
    if (/create_update/.test(q)) { notes.push(vars.b); return { create_update: { id: '1' } }; }
    if (/column_values\(ids:/.test(q) && /items\(ids/.test(q)) {
      readAttempts++;
      if (readAttempts <= readFailures) throw new Error('rate limited');
      return { items: [{ column_values: [
        { id: 'color_mm0xs7kp', text: applied }, { id: 'color_mm0x8faa', text: stage },
      ] }] };
    }
    if (/change_multiple_column_values/.test(q)) { writes.push(JSON.parse(vars.cols || vars.colValues || '{}')); return {}; }
    return {};
  };
  return { fn, writes, notes, attempts: () => readAttempts };
}

test('a transient read failure is retried and the true state wins', async () => {
  const h = harness({ readFailures: 1, applied: 'Yes', stage: 'Document Collection Started' });
  const restore = stub(mondayApi, 'query', h.fn);
  try {
    await retainerService.onRetainerPaid({ itemId: '77' });
    assert.equal(h.attempts(), 2, 'one retry');
    // re-payment branch: NO flag reset in any write
    for (const w of h.writes) {
      assert.equal(w.color_mm0xs7kp, undefined, 'checklistApplied never reset');
      assert.equal(w.color_mm0x3tpw, undefined, 'questionnaireApplied never reset');
    }
  } finally { restore(); }
});

test('THE BUG: persistent read failure must NOT reset a healthy case', async () => {
  const h = harness({ readFailures: 99 });
  const restore = stub(mondayApi, 'query', h.fn);
  try {
    await retainerService.onRetainerPaid({ itemId: '78' });
    for (const w of h.writes) {
      assert.equal(w.color_mm0xs7kp, undefined, 'no blind flag wipe');
      assert.equal(w.color_mm0x8faa, undefined, 'no blind stage write');
    }
    assert.ok(h.notes.some((n) => /nothing was reset/i.test(n)), 'staff told exactly what to check');
  } finally { restore(); }
});

test('a genuine first-time payment still gets the full setup', async () => {
  const h = harness({ applied: 'No', stage: '' });
  const restore = stub(mondayApi, 'query', h.fn);
  try {
    await retainerService.onRetainerPaid({ itemId: '79' });
    const full = h.writes.find((w) => w.color_mm0xs7kp);
    assert.ok(full, 'first-time reset still happens when the state is READABLE');
    assert.deepEqual(full.color_mm0x8faa, { label: 'Document Collection Started' });
  } finally { restore(); }
});
