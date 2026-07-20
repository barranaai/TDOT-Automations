'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const payment     = require('../src/services/paymentService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// The consultant→userId cache is module-level (stable in prod); clear it before
// each test so one test's resolved id can't leak into another's.
test.beforeEach(() => payment._resetRetainedCaches());

// A mondayApi.query stub that records writes and answers reads. `retainedByValue`
// controls what the CM "Retained by" read returns (null = empty).
function mondayStub({ retainedByValue = null, userId = '77' } = {}) {
  const calls = [];
  const fn = async (q, vars) => {
    calls.push({ q, vars });
    if (/users\(emails/.test(q)) return { users: [{ id: userId, email: (vars.emails || [])[0] }] };
    if (/column_values\(ids: \["multiple_person_mm334yp5"\]/.test(q)) {
      return { items: [{ column_values: [{ value: retainedByValue }] }] };
    }
    return {}; // create_update / change_multiple_column_values
  };
  return { fn, calls };
}

// ─── both-gated ───────────────────────────────────────────────────────────────
test('maybeMarkRetained: does nothing unless BOTH signed and paid are set', async () => {
  const cases = [
    { retainerSigned: '', retainerPaid: '' },
    { retainerSigned: '2026-07-20', retainerPaid: '' },
    { retainerSigned: '', retainerPaid: '2026-07-20' },
  ];
  for (const fields of cases) {
    const writes = [];
    const restore = [
      stub(leadService, 'getLead', async (id) => ({ id, conversionStatus: 'Consulted', ...fields })),
      stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
      stub(mondayApi, 'query', async () => ({})),
    ];
    try {
      const r = await payment.maybeMarkRetained('1');
      assert.equal(r.retained, false, `signed=${!!fields.retainerSigned} paid=${!!fields.retainerPaid} must not retain`);
      assert.equal(writes.length, 0, 'no status write when not both-gated');
    } finally { restore.forEach((x) => x()); }
  }
});

// ─── the happy path: signed + paid ⇒ Retained + Retained-by ────────────────────
test('maybeMarkRetained: signed + paid sets conversion "Retained" and fills "Retained by"', async () => {
  const writes = [];
  const m = mondayStub({ retainedByValue: null, userId: '77' });
  const restore = [
    stub(leadService, 'getLead', async (id) => ({
      id, conversionStatus: 'Retained — Awaiting Payment',
      retainerSigned: '2026-07-19', retainerPaid: '2026-07-20',
      clientMasterItemId: '999', assignedConsultant: 'Shermin Teymouri Mofrad',
    })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
    stub(mondayApi, 'query', m.fn),
  ];
  try {
    const r = await payment.maybeMarkRetained('1');
    assert.equal(r.retained, true);
    assert.equal(r.statusChanged, true);
    assert.ok(writes.some((f) => f.conversionStatus === 'Retained'), 'conversion status → Retained');
    // "Retained by" written with the resolved Monday user id as a person.
    const peopleWrite = m.calls.find((c) => c.vars && typeof c.vars.cols === 'string' && c.vars.cols.includes('personsAndTeams'));
    assert.ok(peopleWrite, '"Retained by" people column written');
    assert.match(peopleWrite.vars.cols, /"id":77/, 'writes the resolved user id');
  } finally { restore.forEach((x) => x()); }
});

// ─── idempotent on the status write ────────────────────────────────────────────
test('maybeMarkRetained: already "Retained" does not re-write the status (idempotent)', async () => {
  const writes = [];
  const m = mondayStub({ retainedByValue: '{"personsAndTeams":[{"id":77,"kind":"person"}]}' });
  const restore = [
    stub(leadService, 'getLead', async (id) => ({
      id, conversionStatus: 'Retained',
      retainerSigned: '2026-07-19', retainerPaid: '2026-07-20', clientMasterItemId: '999',
    })),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
    stub(mondayApi, 'query', m.fn),
  ];
  try {
    const r = await payment.maybeMarkRetained('1');
    assert.equal(r.retained, true);
    assert.equal(r.statusChanged, false, 'no status change when already Retained');
    assert.ok(!writes.some((f) => f.conversionStatus), 'no conversionStatus write');
  } finally { restore.forEach((x) => x()); }
});

// ─── non-destructive: never stomp an existing "Retained by" ────────────────────
test('setRetainedBy: leaves an existing "Retained by" assignment untouched', async () => {
  const m = mondayStub({ retainedByValue: '{"personsAndTeams":[{"id":5,"kind":"person"}]}' });
  const restore = stub(mondayApi, 'query', m.fn);
  try {
    const r = await payment.setRetainedBy({ clientMasterItemId: '999', assignedConsultant: 'Shermin Teymouri Mofrad' });
    assert.equal(r.already, true);
    const peopleWrite = m.calls.find((c) => c.vars && typeof c.vars.cols === 'string' && c.vars.cols.includes('personsAndTeams'));
    assert.ok(!peopleWrite, 'no write when a "Retained by" is already present');
  } finally { restore(); }
});

// ─── graceful when the consultant maps to no Monday user ───────────────────────
test('setRetainedBy: no-ops (no throw) when the consultant resolves to no Monday user', async () => {
  const restore = stub(mondayApi, 'query', async (q) => {
    if (/users\(emails/.test(q)) return { users: [] }; // no match
    if (/column_values/.test(q)) return { items: [{ column_values: [{ value: null }] }] };
    return {};
  });
  try {
    const r = await payment.setRetainedBy({ clientMasterItemId: '999', assignedConsultant: 'Shermin Teymouri Mofrad' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-user');
  } finally { restore(); }
});

// ─── fail-closed: a transient guard-read failure must NOT overwrite an assignment ─
test('setRetainedBy: skips the write (fail-closed) when the existing-value read fails', async () => {
  let wrote = false;
  const restore = stub(mondayApi, 'query', async (q) => {
    if (/users\(emails/.test(q)) return { users: [{ id: '77', email: 'shermin@tdotimm.com' }] };
    if (/column_values\(ids: \["multiple_person_mm334yp5"\]/.test(q)) throw new Error('Monday 500 (transient)');
    if (/change_multiple_column_values/.test(q)) { wrote = true; return {}; }
    return {};
  });
  try {
    const r = await payment.setRetainedBy({ clientMasterItemId: '999', assignedConsultant: 'Shermin Teymouri Mofrad' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'read-failed');
    assert.equal(wrote, false, 'must NOT write "Retained by" when the guard read failed');
  } finally { restore(); }
});

// ─── transient user lookup failure must not poison the cache ────────────────────
test('resolveMondayUserIdByEmail: a thrown lookup is not cached (retried next time)', async () => {
  let attempts = 0;
  const restore = stub(mondayApi, 'query', async (q) => {
    if (/users\(emails/.test(q)) { attempts++; if (attempts === 1) throw new Error('rate limited'); return { users: [{ id: '88', email: 'shermin@tdotimm.com' }] }; }
    if (/column_values/.test(q)) return { items: [{ column_values: [{ value: null }] }] };
    return {};
  });
  try {
    const a = await payment.setRetainedBy({ clientMasterItemId: '9', assignedConsultant: 'Shermin Teymouri Mofrad' });
    assert.equal(a.reason, 'no-user', 'first attempt: lookup throws → no user');
    const b = await payment.setRetainedBy({ clientMasterItemId: '9', assignedConsultant: 'Shermin Teymouri Mofrad' });
    assert.equal(b.ok, true, 'second attempt: lookup retried (not poisoned) → resolves + writes');
    assert.equal(attempts, 2, 'the lookup was retried, proving the failure was not cached');
  } finally { restore(); }
});

// ─── concurrent flips collapse to a single execution (no duplicate note) ────────
test('maybeMarkRetained: concurrent calls for one lead collapse (single status write + note)', async () => {
  const writes = [], notes = [];
  let getLeadCalls = 0;
  const restore = [
    stub(leadService, 'getLead', async (id) => { getLeadCalls++; await new Promise((r) => setTimeout(r, 15)); return { id, conversionStatus: 'Retained — Awaiting Payment', retainerSigned: '2026-07-19', retainerPaid: '2026-07-20', clientMasterItemId: '' }; }),
    stub(leadService, 'updateLead', async (id, f) => { writes.push(f); }),
    stub(mondayApi, 'query', async (q, vars) => { if (/create_update/.test(q)) notes.push(vars.body); return {}; }),
  ];
  try {
    await Promise.all([payment.maybeMarkRetained('42'), payment.maybeMarkRetained('42'), payment.maybeMarkRetained('42')]);
    assert.equal(getLeadCalls, 1, 'the three concurrent calls collapsed to one execution');
    assert.equal(writes.filter((f) => f.conversionStatus === 'Retained').length, 1, 'status written once');
    assert.equal(notes.length, 1, 'exactly one "Client retained" note');
  } finally { restore.forEach((x) => x()); }
});
