'use strict';

// 2026-10-02: the app owns everything the Monday "Paid → Document Collection"
// board automation did, so that automation can be switched off:
//  (1) a case HELD for signatures still gets its setup (stage, flags, payment
//      date) — never the Stage Start Date — written BEFORE the hold note;
//  (2) a first payment on a case already PAST Document Collection (staff moved
//      it on) is never pulled back: payment date + a staff note only.

const test   = require('node:test');
const assert = require('node:assert/strict');

const retainerService = require('../src/services/retainerService');
const mondayApi       = require('../src/services/mondayApi');
const leadService     = require('../src/services/leadService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

function harness({ applied = '', stage = '', leads = null }) {
  const writes = [], notes = [], order = [];
  const fn = async (q, vars) => {
    if (/create_update/.test(q)) { notes.push(vars.b); order.push('note'); return { create_update: { id: '1' } }; }
    if (/column_values\(ids:/.test(q) && /items\(ids/.test(q)) {
      return { items: [{ column_values: [{ id: 'color_mm0xs7kp', text: applied }, { id: 'color_mm0x8faa', text: stage }, { id: 'color_mm0x9fnn', text: 'Paid' }] }] };
    }
    if (/change_multiple_column_values/.test(q)) { writes.push(JSON.parse(vars.colValues)); order.push('write'); return {}; }
    if (/move_item_to_group/.test(q)) { order.push('group'); return {}; }
    return {};
  };
  const restore = [stub(mondayApi, 'query', fn)];
  if (leads) restore.push(stub(leadService, 'findAllByColumnValue', async () => leads));
  return { writes, notes, order, done: () => restore.reverse().forEach((r) => r()) };
}
const UNSIGNED = [{ id: 'L1', clientMasterItemId: '1', retainerSigned: '', retainerPaid: '2026-10-02', retainerCountersign: '' }];

for (const stage of ['Internal Review', 'Submission Preparation', 'Submission Ready', 'Profile Created', 'Stuck', 'Application Submitted']) {
  test(`past Document Collection ("${stage}"), checklist flag blank: payment date only, no pull-back, no email`, async () => {
    const h = harness({ applied: '', stage });
    try {
      await retainerService.onRetainerPaid({ itemId: '501' });
      assert.equal(h.writes.length, 1);
      assert.deepEqual(Object.keys(h.writes[0]), ['date_mm0xgk76'], 'only the payment date');
      assert.equal(h.notes.length, 1);
      assert.match(h.notes[0], new RegExp(`Payment marked while the case is at "${stage}"`));
      assert.match(h.notes[0], /Re-seed Checklist → Run/);
      assert.match(h.notes[0], /Resend portal access/);
    } finally { h.done(); }
  });
}

test('past Document Collection with the flag "No" (the old automation had cleared it): still not pulled back', async () => {
  const h = harness({ applied: 'No', stage: 'Internal Review' });
  try {
    await retainerService.onRetainerPaid({ itemId: '502' });
    assert.deepEqual(Object.keys(h.writes[0]), ['date_mm0xgk76']);
    assert.equal(h.writes.length, 1);
  } finally { h.done(); }
});

test('re-payment on an onboarded case past Document Collection: payment date only, and NO stage-guard note', async () => {
  const h = harness({ applied: 'Yes', stage: 'Internal Review' });
  try {
    await retainerService.onRetainerPaid({ itemId: '503' });
    assert.deepEqual(Object.keys(h.writes[0]), ['date_mm0xgk76']);
    assert.equal(h.notes.length, 0, 'a normal re-payment is quiet');
  } finally { h.done(); }
});

for (const stage of ['', 'Pre-Onboarding', 'Retainer Confirmed', 'Not Started']) {
  test(`early stage "${stage || 'blank'}", no linked lead: the full first-payment setup as before`, async () => {
    const h = harness({ applied: '', stage });
    const restore = stub(leadService, 'findAllByColumnValue', async () => []);
    try {
      await retainerService.onRetainerPaid({ itemId: '504' });
      const full = h.writes.find((w) => w.color_mm0xs7kp);
      assert.ok(full, 'first-time setup written');
      assert.deepEqual(full.color_mm0x8faa, { label: 'Document Collection Started' });
      assert.ok(full.date_mm0xjm1z, 'Stage Start Date set on a real start');
      assert.equal(h.notes.length, 0);
    } finally { restore(); h.done(); }
  });
}

test('HELD (Paid before the client signed) at Pre-Onboarding: setup written BEFORE the hold note, without the Stage Start Date', async () => {
  const h = harness({ applied: '', stage: 'Pre-Onboarding', leads: UNSIGNED });
  try {
    await retainerService.onRetainerPaid({ itemId: '505' });
    assert.equal(h.writes.length, 1);
    const w = h.writes[0];
    assert.deepEqual(w.color_mm0x8faa, { label: 'Document Collection Started' });
    assert.deepEqual(w.color_mm0xs7kp, { label: 'No' });
    assert.deepEqual(w.color_mm0x3tpw, { label: 'No' });
    assert.deepEqual(w.color_mm0x3x1x, { label: 'No' });
    assert.ok(w.date_mm0xgk76);
    assert.equal(w.date_mm0xjm1z, undefined, 'the "onboarding ran" marker stays blank on a hold');
    assert.equal(w.color_mm1abve4, undefined, 'no chasing restart on a hold');
    assert.deepEqual(h.order, ['write', 'note'], 'the write lands before the hold note the resume service reads');
    assert.match(h.notes[0], /onboarding is on hold/);
  } finally { h.done(); }
});

test('HELD on a case already at Document Collection Started: flags + payment date, the stage is not re-written', async () => {
  const h = harness({ applied: '', stage: 'Document Collection Started', leads: UNSIGNED });
  try {
    await retainerService.onRetainerPaid({ itemId: '506' });
    const w = h.writes[0];
    assert.equal(w.color_mm0x8faa, undefined, 'no same-label stage write (it would fire the stage webhook)');
    assert.deepEqual(w.color_mm0xs7kp, { label: 'No' });
    assert.equal(w.date_mm0xjm1z, undefined);
  } finally { h.done(); }
});

test('HELD setup write fails: the hold note still goes (it is the record the resume reads)', async () => {
  const h = harness({ applied: '', stage: 'Pre-Onboarding', leads: UNSIGNED });
  const real = mondayApi.query;
  mondayApi.query = async (q, v) => { if (/change_multiple_column_values/.test(q)) throw new Error('503'); return real(q, v); };
  try {
    await retainerService.onRetainerPaid({ itemId: '507' });
    assert.equal(h.writes.length, 0);
    assert.ok(h.notes.some((n) => /onboarding is on hold/.test(n)));
  } finally { mondayApi.query = real; h.done(); }
});

test('HELD on a case past Document Collection: the stage guard wins — no hold, no pull-back', async () => {
  const h = harness({ applied: '', stage: 'Internal Review', leads: UNSIGNED });
  try {
    await retainerService.onRetainerPaid({ itemId: '508' });
    assert.deepEqual(Object.keys(h.writes[0]), ['date_mm0xgk76']);
    assert.ok(!h.notes.some((n) => /on hold/.test(n)));
    assert.ok(h.notes.some((n) => /Payment marked while the case is at "Internal Review"/.test(n)));
  } finally { h.done(); }
});

test('state unreadable: still the fail-closed date refresh (the guard needs a real read)', async () => {
  const notes = [], writes = [];
  const restore = stub(mondayApi, 'query', async (q, vars) => {
    if (/create_update/.test(q)) { notes.push(vars.b); return {}; }
    if (/column_values\(ids:/.test(q)) throw new Error('rate limited');
    if (/change_multiple_column_values/.test(q)) { writes.push(JSON.parse(vars.colValues)); return {}; }
    return {};
  });
  try {
    await retainerService.onRetainerPaid({ itemId: '509' });
    assert.deepEqual(Object.keys(writes[0]), ['date_mm0xgk76']);
    assert.ok(notes.some((n) => /nothing was reset/i.test(n)));
    assert.ok(!notes.some((n) => /Payment marked while the case is at/.test(n)), 'no stage-guard note on a blind read');
  } finally { restore(); }
});

test('the early-stage list matches the held-onboarding service (one definition of "before onboarding")', () => {
  const R = require('../src/services/onboardingResumeService');
  for (const s of R.EARLY_STAGES) assert.ok(retainerService.EARLY_STAGES.includes(s), s || 'blank');
});

// ── Review round (2026-10-02) ───────────────────────────────────────────────

test('HELD setup write: fails once → retried after a beat, lands before the note; fails twice → the hold note says what to do', async () => {
  const h = harness({ applied: '', stage: 'Pre-Onboarding', leads: UNSIGNED });
  const real = mondayApi.query; let fails = 1;
  mondayApi.query = async (q, v) => { if (/change_multiple_column_values/.test(q) && fails-- > 0) throw new Error('503'); return real(q, v); };
  try {
    await retainerService.onRetainerPaid({ itemId: '601' });
    assert.equal(h.writes.length, 1, 'the retry landed');
    assert.deepEqual(h.order, ['write', 'note']);
    assert.ok(!/could not be written/.test(h.notes[0]));
  } finally { mondayApi.query = real; h.done(); }
  const h2 = harness({ applied: '', stage: 'Pre-Onboarding', leads: UNSIGNED });
  const real2 = mondayApi.query;   // the second harness's own stub
  mondayApi.query = async (q, v) => { if (/change_multiple_column_values/.test(q)) throw new Error('503'); return real2(q, v); };
  try {
    await retainerService.onRetainerPaid({ itemId: '602' });
    assert.equal(h2.writes.length, 0);
    assert.match(h2.notes[0], /onboarding is on hold/);
    assert.match(h2.notes[0], /could not be written just now.*Checklist Template Applied.*Document Collection Started/);
  } finally { mondayApi.query = real2; h2.done(); }
});

test('stage guard: the pending→active group move still happens when the agreement is complete (lead-less passes), not when unsigned', async () => {
  const a = harness({ applied: '', stage: 'Internal Review' });
  const restoreA = stub(leadService, 'findAllByColumnValue', async () => []);
  try { await retainerService.onRetainerPaid({ itemId: '603' }); assert.ok(a.order.includes('group'), 'moved to the active group'); }
  finally { restoreA(); a.done(); }
  const b = harness({ applied: '', stage: 'Internal Review', leads: UNSIGNED });
  try { await retainerService.onRetainerPaid({ itemId: '604' }); assert.ok(!b.order.includes('group'), 'an unsigned case stays in the pending group'); }
  finally { b.done(); }
});

test('state unreadable: the note names the right recovery step, and ONE guarded retry is scheduled', async () => {
  retainerService._unreadableRetry.clear();
  const notes = [];
  const restore = stub(mondayApi, 'query', async (q, vars) => {
    if (/create_update/.test(q)) { notes.push(vars.b); return {}; }
    if (/column_values\(ids:/.test(q)) throw new Error('rate limited');
    return {};
  });
  try {
    await retainerService.onRetainerPaid({ itemId: '605' });
    assert.match(notes[0], /tries once more in a few minutes/);
    assert.match(notes[0], /set the Case Stage to <b>Document Collection Started<\/b>/);
    assert.ok(!/Re-seed/.test(notes[0]), 'Re-seed is not the recovery step (it does not gate on payment/signatures)');
    assert.ok(retainerService._unreadableRetry.has('605'), 'a retry is pending');
    await retainerService.onRetainerPaid({ itemId: '605' });
    assert.equal(retainerService._unreadableRetry.size, 1, 'never two retries for one case');
  } finally { restore(); retainerService._unreadableRetry.clear(); }
});

test('the unreadable-state retry: proceeds only for a first payment at an early stage; date-only at DCS or later, or when still unreadable', async () => {
  // early stage, first payment → full setup
  const a = harness({ applied: '', stage: 'Pre-Onboarding' });
  const ra = stub(leadService, 'findAllByColumnValue', async () => []);
  try { await retainerService.onRetainerPaid({ itemId: '606', _retryOfUnreadable: true }); assert.ok(a.writes.find((w) => w.color_mm0x8faa), 'full first-time setup on the retry'); }
  finally { ra(); a.done(); }
  // already at DCS → date + the explicit "No" (the stage webhook's reminder-clock rule keys on it), no start
  const b = harness({ applied: '', stage: 'Document Collection Started' });
  try { await retainerService.onRetainerPaid({ itemId: '607', _retryOfUnreadable: true }); assert.deepEqual(Object.keys(b.writes[0]).sort(), ['color_mm0xs7kp', 'date_mm0xgk76']); assert.equal(b.writes[0].date_mm0xjm1z, undefined); assert.equal(b.notes.length, 0); }
  finally { b.done(); }
  // past DCS → the stage guard: date only + the 💵 note (the Summary list sees it)
  const c = harness({ applied: '', stage: 'Internal Review' });
  try { await retainerService.onRetainerPaid({ itemId: '608', _retryOfUnreadable: true }); assert.deepEqual(Object.keys(c.writes[0]), ['date_mm0xgk76']); assert.match(c.notes[0], /Payment marked while the case is at "Internal Review"/); }
  finally { c.done(); }
  // reverted to Not Paid in the meantime → nothing at all
  const d = harness({ applied: '', stage: 'Pre-Onboarding' });
  const realD = mondayApi.query;
  mondayApi.query = async (q, v) => { if (/column_values\(ids:/.test(q)) return { items: [{ column_values: [{ id: 'color_mm0xs7kp', text: '' }, { id: 'color_mm0x8faa', text: 'Pre-Onboarding' }, { id: 'color_mm0x9fnn', text: 'Not Paid' }] }] }; return realD(q, v); };
  try { await retainerService.onRetainerPaid({ itemId: '610', _retryOfUnreadable: true }); assert.equal(d.writes.length, 0); assert.equal(d.notes.length, 0); assert.ok(!d.order.includes('group')); }
  finally { mondayApi.query = realD; d.done(); }
  // still unreadable → date only, no second retry
  retainerService._unreadableRetry.clear();
  const writes = [];
  const restore = stub(mondayApi, 'query', async (q, vars) => { if (/column_values\(ids:/.test(q)) throw new Error('down'); if (/change_multiple_column_values/.test(q)) writes.push(JSON.parse(vars.colValues)); return {}; });
  try { await retainerService.onRetainerPaid({ itemId: '609', _retryOfUnreadable: true }); assert.deepEqual(Object.keys(writes[0]), ['date_mm0xgk76']); assert.equal(retainerService._unreadableRetry.size, 0); }
  finally { restore(); }
});

test('the Summary list shows a case marked Paid past Document Collection that has no checklist', () => {
  const NA = require('../src/services/needsAttentionService');
  const now = Date.now();
  const item = (updates) => ({ id: '7', name: 'Client', created_at: new Date(now - 30 * 86400e3).toISOString(), group: { id: 'group_mm6sykds', title: 'September  2026' },
    column_values: [['text_mm142s49', '2026-SV-900'], ['color_mm0x8faa', 'Internal Review'], ['color_mm0x9fnn', 'Paid'], ['dropdown_mm0xd1qn', 'Super Visa']].map(([id, text]) => ({ id, text, value: null })), updates });
  const note = { id: 'n1', created_at: new Date(now - 2 * 86400e3).toISOString(), text_body: '💵 Payment marked while the case is at "Internal Review". The case stays at this stage — nothing was reset and no email was sent. If this client never had…' };
  assert.deepEqual(NA.refsNeedingChecklist([NA.parseCase(item([note]))]), ['2026-SV-900'], 'the Documents board is asked');
  const out = NA.detect({ cases: [NA.parseCase(item([note]))], checklist: new Map([['2026-SV-900', false]]), now });
  assert.deepEqual(out.map((e) => e.kind), ['no-checklist']);
  assert.match(out[0].why, /Marked Paid on .* while the case was already at "Internal Review"/);
  assert.match(out[0].todo, /Re-seed Checklist → Run/);
  assert.deepEqual(NA.detect({ cases: [NA.parseCase(item([note]))], checklist: new Map([['2026-SV-900', true]]), now }), [], 'a checklist settles it');
});

test('the staff guide documents the exceptions', () => {
  const g = require('fs').readFileSync(require.resolve('../docs/Case-Manager-Guide.html'), 'utf8');
  assert.match(g, /already past Document Collection<\/strong>.*only records the payment date/);
  assert.match(g, /unless the case is already past Document Collection/);
});

test('the main first-payment write: fails once → retried and onboarding goes ahead; fails twice → a loud note, nothing started', async () => {
  const a = harness({ applied: '', stage: 'Pre-Onboarding' });
  const ra = stub(leadService, 'findAllByColumnValue', async () => []);
  const realA = mondayApi.query; let fails = 1;
  mondayApi.query = async (q, v) => { if (/change_multiple_column_values/.test(q) && fails-- > 0) throw new Error('503'); return realA(q, v); };
  try { await retainerService.onRetainerPaid({ itemId: '611' }); assert.ok(a.writes.find((w) => w.color_mm0x8faa), 'the retry landed the setup'); assert.equal(a.notes.length, 0); }
  finally { mondayApi.query = realA; ra(); a.done(); }
  const emailService = require('../src/services/emailService');
  const sent = [];
  const b = harness({ applied: '', stage: 'Document Collection Started' });   // pre-staged: a start would email directly
  const rb = [stub(leadService, 'findAllByColumnValue', async () => []), stub(emailService, 'sendIntakeEmail', async (id) => { sent.push(id); return { sent: true }; })];
  const realB = mondayApi.query;
  mondayApi.query = async (q, v) => { if (/change_multiple_column_values/.test(q)) throw new Error('503'); return realB(q, v); };
  try {
    await retainerService.onRetainerPaid({ itemId: '612' });
    assert.equal(b.writes.length, 0);
    assert.deepEqual(sent, [], 'a start whose record never landed must not email');
    assert.match(b.notes[0], /case setup could not be written/);
    assert.match(b.notes[0], /Document Collection Started/);
  } finally { mondayApi.query = realB; rb.reverse().forEach((r) => r()); b.done(); }
});
