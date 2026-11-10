'use strict';

// "Waiting for" on Client Master → Assigning → Pre-Onboarding (2026-11-10). Read-only.
// The one rule is caseGateService.signatureGateForLead; preOnboardingWaiting only turns its answer
// into display codes. These tests cover: every code and the order of the steps; the lead copy's
// server-only gate facts and peek() (never a wait); what the route sends (no client data); the page.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');
const fs     = require('fs');

const W     = require('../src/services/preOnboardingWaiting');
const gate  = require('../src/services/caseGateService');
const snap  = require('../src/services/leadSnapshot');
const dash  = require('../src/services/dashboardService');
const cmv   = require('../src/services/clientMasterViews');
const U     = require('../src/routes/clientMasterUi');
const mondayApi = require('../src/services/mondayApi');
const COLS  = require('../src/data/newLeadsBoard.json').columns;
const CAPTURE  = require('./fixtures/client-master-capture.json');
const META_FIX = require('./fixtures/client-master-board-meta.json');

const PRE = cmv.PRE_ONBOARDING_INDEX;
function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const tick = () => new Promise((r) => setImmediate(r));
const rc = (o) => JSON.stringify(o);
const wf = (cm, ...leads) => W.waitingFor({ cmPayment: cm }, leads);

/* ── the pure function ── */

test('every step, in the order of the process: not sent → client signature → our countersignature → payment → ready', () => {
  // nothing sent, nothing signed: the display split of the gate's "client signature"
  assert.deepEqual(wf('', {}), { code: 'not-sent', also: ['payment'], partPaid: false });
  // sent, not signed
  assert.deepEqual(wf('', { retainerSent: '2026-10-14' }), { code: 'client-sign', also: ['payment'], partPaid: false });
  // signed online, countersign envelope issued, not countersigned, not paid
  const online = { retainerSent: '2026-10-14', retainerSigned: '2026-10-15', retainerCountersign: rc({ clientSignedVia: 'documenso', envelopeId: 'env_1' }) };
  assert.deepEqual(wf('Signed (Unpaid)', online), { code: 'countersign', also: ['payment'], partPaid: false });
  // countersigned, not paid
  const counter = { ...online, retainerCountersign: rc({ clientSignedVia: 'documenso', envelopeId: 'env_1', signedAt: '2026-10-16T10:00:00Z' }) };
  assert.deepEqual(wf('Signed (Unpaid)', counter), { code: 'payment', also: [], partPaid: false });
  // everything met, still Pre-Onboarding
  assert.deepEqual(wf('Paid', { ...counter, retainerPaid: '2026-10-17' }), { code: 'ready', also: [], partPaid: false });
  // all three unmet at once (an envelope exists before the client signed): first step shown, the rest in order
  assert.deepEqual(wf('', { retainerSent: '2026-10-14', retainerCountersign: rc({ envelopeId: 'env_1' }) }), { code: 'client-sign', also: ['countersign', 'payment'], partPaid: false });
  assert.deepEqual(wf('', { retainerCountersign: rc({ envelopeId: 'env_1' }) }).code, 'not-sent');
  assert.deepEqual(W.STEP_ORDER, ['not-sent', 'client-sign', 'countersign', 'payment']);
});

test('it is the gate\'s answer, not a second rule: for any lead the steps mirror signatureGateForLead.missing', () => {
  const dates = ['', '2026-10-01'];
  const rcs = ['', 'not json', rc({ clientEnvelopeId: 'c1' }), rc({ clientSignedVia: 'documenso' }), rc({ envelopeId: 'e1' }), rc({ envelopeId: 'e1', signedAt: 'x' })];
  let n = 0;
  for (const retainerSent of dates) for (const retainerSigned of dates) for (const retainerPaid of dates) for (const retainerCountersign of rcs) {
    const lead = { retainerSent, retainerSigned, retainerPaid, retainerCountersign };
    const g = gate.signatureGateForLead(lead);
    const back = W.stepsOf(lead, false).map((c) => ({ 'not-sent': 'client signature', 'client-sign': 'client signature', countersign: 'RCIC countersignature', payment: 'payment' }[c]));
    assert.deepEqual(back, g.missing, JSON.stringify(lead));
    assert.equal(wf('', lead).code === 'ready', g.complete);
    n++;
  }
  assert.equal(n, 48);
});

test('countersignature counts only when it can arrive: paper signing (a client envelope only) does not wait for it', () => {
  const paper = { retainerSent: '2026-10-01', retainerSigned: '2026-10-02', retainerCountersign: rc({ clientEnvelopeId: 'c1', signUrl: 'https://sign.example/x' }) };
  assert.deepEqual(wf('Signed (Unpaid)', paper), { code: 'payment', also: [], partPaid: false });
  assert.equal(wf('', { ...paper, retainerPaid: '2026-10-03' }).code, 'ready');
});

test('the board\'s "Paid" is the payment (the held-onboarding case): never "Payment"; signatures are still asked for', () => {
  assert.deepEqual(wf('Paid', { retainerSent: '2026-10-01' }), { code: 'client-sign', also: [], partPaid: false });
  assert.deepEqual(wf('Paid', { retainerSigned: '2026-10-02' }), { code: 'ready', also: [], partPaid: false });
  assert.deepEqual(wf('Paid', { retainerSigned: '2026-10-02', retainerCountersign: rc({ clientSignedVia: 'documenso' }) }), { code: 'countersign', also: [], partPaid: false });
  // any other board value is not a payment — "Not Paid", "Working on it", the automation default, an empty cell
  for (const cm of ['', 'Not Paid', 'Working on it', 'Alreaday Sent', 'Signed (Unpaid)', 'paid']) assert.equal(wf(cm, { retainerSigned: '2026-10-02' }).code, 'payment', cm);
});

test('a walk-in (direct retainer, case first) who paid before signing: the board cell is blank, the label comes from the client\'s record', () => {
  const walkIn = { directClient: 'Yes', retainerSent: '2026-11-01', retainerPaid: '2026-11-02', clientMasterItemId: '77' };
  assert.deepEqual(wf('', walkIn), { code: 'client-sign', also: [], partPaid: false });
  // paid, and no sent date: an agreement went out some other way — "client signature", never "no agreement"
  assert.deepEqual(wf('', { ...walkIn, retainerSent: '' }), { code: 'client-sign', also: [], partPaid: false });
});

test('REVIEW: "No agreement on record" is never said when there is any payment — a hand-sent / paper-signed case reads "client signature"', () => {
  // the hand-sent class: signed on paper, staff set the board to Paid, no Sent / Signed date on the record
  assert.deepEqual(wf('Paid', { clientMasterItemId: '1' }), { code: 'client-sign', also: [], partPaid: false });
  assert.deepEqual(wf('', { retainerPaid: '2026-11-02' }), { code: 'client-sign', also: [], partPaid: false });
  assert.deepEqual(wf('Paid', { retainerCountersign: rc({ envelopeId: 'e1' }) }), { code: 'client-sign', also: ['countersign'], partPaid: false });
  // no trace at all: the only time it is said — and a board value that is not Paid is not a trace
  for (const cm of ['', 'Not Paid', 'Signed (Unpaid)', 'Alreaday Sent']) assert.equal(wf(cm, {}).code, 'not-sent', cm);
});

test('REVIEW: signed + paid on the record but the board set to "Not Paid" / "Working on it" by hand is the reconciler\'s conflict — Not clear, never Ready', () => {
  const R = require('../src/services/retainerStatusReconciler');
  const lead = { clientMasterItemId: '1', retainerSigned: '2026-10-02', retainerPaid: '2026-10-03' };
  for (const cm of ['Not Paid', 'Working on it', 'not paid', 'WORKING ON IT']) {
    assert.equal(R.classifyDrift(lead, cm).action, 'conflict', cm);
    assert.deepEqual(wf(cm, lead), { code: 'unclear', also: [], partPaid: false, why: 'paid-conflict' }, cm);
  }
  // every other board value the reconciler would repair by itself (or is in step): still Ready
  for (const cm of ['', 'Signed (Unpaid)', 'Alreaday Sent', 'Paid']) {
    assert.notEqual(R.classifyDrift(lead, cm).action, 'conflict', cm);
    assert.equal(wf(cm, lead).code, 'ready', cm);
  }
  // two linked leads, one fully executed: the same conflict
  assert.equal(wf('Not Paid', {}, lead).why, 'paid-conflict');
  // not yet complete: the step from the record is unchanged
  assert.equal(wf('Not Paid', { retainerSent: 'x', retainerPaid: 'y' }).code, 'client-sign');
  // part-payment words are kept
  const part = JSON.stringify({ 0: { status: 'partial' } });
  assert.deepEqual(wf('Not Paid', { ...lead, milestonePayments: part }), { code: 'unclear', also: [], partPaid: true, why: 'paid-conflict' });
});

test('part-paid is only ever extra words: a first part-payment stamps the paid date, so the step shown is a signature — or Ready', () => {
  const part = JSON.stringify({ 0: { status: 'partial', l: [{ a: 50000, d: '2026-11-02', r: 'BANKREF-9', b: 'A Staff' }] } });
  assert.deepEqual(wf('', { retainerSent: '2026-11-01', retainerPaid: '2026-11-02', milestonePayments: part }), { code: 'client-sign', also: [], partPaid: true });
  assert.deepEqual(wf('', { retainerSigned: '2026-11-01', retainerPaid: '2026-11-02', milestonePayments: part }), { code: 'ready', also: [], partPaid: true });
  // paid in full, or nothing recorded: no part-payment words
  assert.equal(wf('', { retainerSigned: 'x', milestonePayments: JSON.stringify({ 0: { status: 'paid' } }) }).partPaid, false);
  // only milestone 2 part-paid is not "a first part-payment"
  assert.equal(wf('', { retainerSigned: 'x', milestonePayments: JSON.stringify({ 1: { status: 'partial' } }) }).partPaid, false);
  // a record that cannot be read: no claim, and the step is unchanged
  assert.deepEqual(wf('', { retainerSent: 'x', milestonePayments: '{"0":{"status":"partial"' }), { code: 'client-sign', also: ['payment'], partPaid: false });
});

test('no linked lead (a case run by hand): Not clear — never a guess, even with the board saying Paid', () => {
  assert.deepEqual(wf(''), { code: 'unclear', also: [], partPaid: false, why: 'no-lead' });
  assert.deepEqual(wf('Paid'), { code: 'unclear', also: [], partPaid: false, why: 'no-lead' });
  assert.deepEqual(W.waitingFor({}, undefined), { code: 'unclear', also: [], partPaid: false, why: 'no-lead' });
  assert.deepEqual(W.waitingFor(null, [null]), { code: 'unclear', also: [], partPaid: false, why: 'no-lead' });
});

test('two linked leads: one fully executed is enough; the same first step is that step; different first steps are Not clear — never the first lead found', () => {
  const done = { retainerSigned: 'x', retainerPaid: 'y' }, unsent = {}, sent = { retainerSent: 'x' }, unpaid = { retainerSigned: 'x' };
  assert.equal(wf('', unsent, done).code, 'ready');
  assert.equal(wf('', done, unsent).code, 'ready');
  assert.deepEqual(wf('', sent, { retainerSent: 'z', retainerCountersign: rc({ envelopeId: 'e' }) }), { code: 'client-sign', also: ['countersign', 'payment'], partPaid: false });
  assert.deepEqual(wf('', sent, unpaid), { code: 'unclear', also: [], partPaid: false, why: 'leads-disagree' });
  assert.deepEqual(wf('', unpaid, sent), { code: 'unclear', also: [], partPaid: false, why: 'leads-disagree' });
  assert.deepEqual(wf('', unsent, sent), { code: 'unclear', also: [], partPaid: false, why: 'leads-disagree' }, 'sent on one record, not on the other');
});

test('Pro Bono on the board: the gate still wants a payment that may never come — Not clear, not "Payment"; consult "waived" plays no part', () => {
  assert.deepEqual(wf('Pro Bono', { retainerSigned: 'x' }), { code: 'unclear', also: [], partPaid: false, why: 'pro-bono' });
  assert.deepEqual(wf('Pro Bono', { retainerSent: 'x' }), { code: 'unclear', also: [], partPaid: false, why: 'pro-bono' });
  assert.equal(wf('Pro Bono', { retainerSigned: 'x', retainerPaid: 'y' }).code, 'ready');
  // a waived CONSULTATION fee is not a retainer payment
  assert.equal(wf('', { retainerSigned: 'x', consultPayment: JSON.stringify({ waived: true }) }).code, 'payment');
});

test('held and case-deleted records cannot reach a case row: no link, so they are never a claimant', () => {
  const held = { id: '1', retainerSigned: '', clientMasterItemId: '', retainerCountersign: rc({ signedHeld: { date: '2026-10-15', outcome: 'Follow-Up' } }) };
  const deleted = { id: '2', clientMasterItemId: '', caseDeleted: '2026-11-05 · 2026-EE-001', retainerSigned: 'x', retainerPaid: 'y' };
  const spaced = { id: '3', clientMasterItemId: '  501 ', retainerSent: 'x' };
  const m = W.claimantsByCase([held, deleted, spaced]);
  assert.deepEqual([...m.keys()], ['501'], 'free text: trimmed, keyed as a string');
  const cases = [{ id: 501, stageIdx: PRE, paymentStatus: '' }, { id: '502', stageIdx: PRE, paymentStatus: '' }];
  W.mark(cases, { leads: [held, deleted, spaced], at: 5 });
  assert.equal(cases[0].waiting.code, 'client-sign');
  assert.deepEqual(cases[1].waiting, { code: 'unclear', also: [], partPaid: false, why: 'no-lead' });
});

/* ── the lead copy: the two extra columns stay on the server ── */

async function realFetch(items) {
  const asked = [];
  const r = stub(mondayApi, 'query', async (q) => { asked.push(q); return { boards: [{ items_page: { cursor: null, items } }] }; });
  const log = stub(console, 'log', () => {});
  try { snap._reset(); return { leads: await snap.leads(), asked }; } finally { r(); log(); }
}
const leadItem = (id, cells) => ({ id: String(id), name: 'Person ' + id, created_at: '', column_values: Object.entries(cells).map(([k, v]) => ({ id: COLS[k], text: v, value: null })) });
const SECRET_RC = rc({ clientEnvelopeId: 'envc_SECRET', clientItemId: 'it_SECRET', envelopeId: 'env_SECRET', signUrl: 'https://sign.example/SECRETLINK', clientSignedVia: 'documenso', sentAt: '2026-10-15T09:00:00Z' });
const SECRET_PAY = JSON.stringify({ 0: { status: 'partial', l: [{ a: 50000, d: '2026-11-02', r: 'BANKREF-SECRET', b: 'Staff SECRET' }] } });

test('the snapshot reads the countersign + payments columns but keeps only the gate facts, server-side: not in JSON, keys or a spread', async () => {
  try {
    const { leads, asked } = await realFetch([
      leadItem(1, { retainerSent: '2026-10-14', retainerSigned: '2026-10-15', retainerPaid: '2026-11-02', clientMasterItemId: '900', retainerCountersign: SECRET_RC, milestonePayments: SECRET_PAY, email: 'person@example.com', phone: '4165550100' }),
      leadItem(2, { retainerSent: '2026-10-14', clientMasterItemId: '901', milestonePayments: '{"0":' }),
      leadItem(3, {}),
    ]);
    assert.ok(asked[0].includes(COLS.retainerCountersign) && asked[0].includes(COLS.milestonePayments), 'read on the SAME board read — no extra read');
    assert.equal(asked.length, 1);
    assert.ok(!snap.SNAPSHOT_KEYS.includes('retainerCountersign') && !snap.SNAPSHOT_KEYS.includes('milestonePayments'), 'not list fields');
    assert.deepEqual(snap.SERVER_ONLY_KEYS, ['retainerCountersign', 'milestonePayments']);
    assert.equal(new Set(snap.FETCH_IDS).size, snap.FETCH_IDS.length);
    const l = leads[0];
    assert.equal(l.retainerCountersign, undefined);
    assert.equal(l.milestonePayments, undefined);
    assert.deepEqual({ ...l[snap.GATE] }, { clientSignedVia: 'documenso', hasEnvelope: true, signedAt: '', m1Partial: true });
    assert.ok(Object.isFrozen(l[snap.GATE]));
    for (const out of [JSON.stringify(leads), Object.keys(l).join(','), JSON.stringify({ ...l }), JSON.stringify(Object.assign({}, l))]) {
      assert.ok(!/SECRET|sign\.example|signUrl|envelope|BANKREF|example\.com|4165550100|m1Partial|hasEnvelope/i.test(out), out.slice(0, 80));
    }
    assert.equal(leads[1][snap.GATE].m1Partial, null, 'a payments record that cannot be read: no claim');
    assert.deepEqual({ ...leads[2][snap.GATE] }, { clientSignedVia: '', hasEnvelope: false, signedAt: '', m1Partial: false });
    // and the label built from the reduced facts is the one the whole record gives
    assert.deepEqual(W.waitingFor({ cmPayment: '' }, [l]), { code: 'countersign', also: [], partPaid: true });
    assert.deepEqual(W.waitingFor({ cmPayment: '' }, [l]), W.waitingFor({ cmPayment: '' }, [{ retainerSent: 'a', retainerSigned: 'b', retainerPaid: 'c', retainerCountersign: SECRET_RC, milestonePayments: SECRET_PAY }]));
    assert.equal(W.waitingFor({ cmPayment: '' }, [leads[1]]).partPaid, false);
    // without the countersign facts this lead would wrongly read "Ready" — the trap the extra column closes
    assert.equal(gate.signatureGateForLead({ ...l }).complete, true);
  } finally { snap._reset(); }
});

test('gateFactsOf: only whether, never what — odd shapes read as "no chain known"', () => {
  assert.deepEqual(snap.gateFactsOf({}), { clientSignedVia: '', hasEnvelope: false, signedAt: '', m1Partial: false });
  assert.deepEqual(snap.gateFactsOf({ retainerCountersign: '[1]', milestonePayments: '[]' }), { clientSignedVia: '', hasEnvelope: false, signedAt: '', m1Partial: null });
  assert.deepEqual(snap.gateFactsOf({ retainerCountersign: rc({ signedAt: '2026-10-16T10:00:00Z', clientSignedVia: 'paper' }) }), { clientSignedVia: '', hasEnvelope: false, signedAt: '1', m1Partial: false });
});

/** A fake board whose reads wait until released. */
function fakeBoard() {
  const b = { now: 1_000_000, reads: 0, rows: [{ id: '1' }], pending: [] };
  b.restore = [
    stub(snap.io, 'now', () => b.now),
    stub(snap.io, 'fetchLeads', () => { b.reads++; const rows = b.rows.slice(); return new Promise((res) => b.pending.push(() => res(rows))); }),
    stub(console, 'log', () => {}),
  ];
  b.release = async () => { while (b.pending.length) b.pending.shift()(); await tick(); await tick(); };
  b.done = () => { b.restore.forEach((r) => r()); snap._reset(); };
  return b;
}

test('peek never waits: no copy → null at once and ONE read starts behind it; then the copy, as it is', async () => {
  snap._reset(); const b = fakeBoard();
  try {
    const r = snap.peek();
    assert.equal(r, null, 'an answer, not a promise');
    assert.equal(b.reads, 1, 'a background read was started');
    assert.equal(snap.peek(), null);
    assert.equal(b.reads, 1, 'and only one');
    await b.release();
    const got = snap.peek();
    assert.ok(got && !(got instanceof Promise));
    assert.deepEqual(got.leads.map((l) => l.id), ['1']);
    assert.equal(got.at, 1_000_000);
    assert.equal(b.reads, 1, 'a young copy is not re-read');
    // aged past the 3 minutes: served, re-read behind
    b.now += snap.TTL_MS + 1;
    assert.ok(snap.peek());
    assert.equal(b.reads, 2);
    await b.release();
    // too old to show: null, a read behind
    b.now += snap.HARD_MAX_MS + 1;
    assert.equal(snap.peek(), null);
    assert.equal(b.reads, 3);
    await b.release();
    assert.ok(snap.peek());
  } finally { b.done(); }
});

test('peek after a lead write: the copy is still handed out at once while the re-read runs; a failed read never throws', async () => {
  snap._reset(); const b = fakeBoard();
  try {
    snap.peek(); await b.release();
    b.rows = [{ id: '1' }, { id: '2' }];
    snap.invalidate();                                   // a staff member's own write
    assert.deepEqual(snap.peek().leads.map((l) => l.id), ['1'], 'no wait');
    assert.equal(b.reads, 2);
    await b.release();
    assert.deepEqual(snap.peek().leads.map((l) => l.id), ['1', '2']);
    assert.equal(snap._state().invalidatedAt, 0);
    snap.runInBackground(() => snap.invalidate());       // a scheduler job's write
    assert.ok(snap.peek());
    assert.equal(b.reads, 3);
    await b.release();
    // a read that fails
    b.restore.push(stub(console, 'warn', () => {}));
    b.now += snap.TTL_MS + 1;
    snap.io.fetchLeads = () => Promise.reject(new Error('Monday is down'));
    assert.ok(snap.peek());
    await tick(); await tick();
    assert.ok(snap.peek(), 'the copy is still served');
  } finally { b.done(); }
});

test('peek counts as a view, so the scheduler keeps the copy warm while the page is open', async () => {
  snap._reset(); const b = fakeBoard();
  try {
    snap.peek(); await b.release();
    b.now += 4 * 60 * 1000;
    const w = snap.warm(); await b.release(); await w;
    assert.equal(b.reads, 2);
  } finally { b.done(); }
});

/* ── what the route sends ── */

const META = dash._casesIo.parseMeta({ groups: META_FIX.groups, columns: ['color_mm0x8faa', 'color_mm3tf1ys'].map((id) => ({ id, settings_str: JSON.stringify(META_FIX.columns[id].settings) })) });
function captureRows() {
  const title = Object.fromEntries(META.groups.map((g) => [g.id, g.title]));
  return CAPTURE.rows.map((r, i) => {
    const row = dash.parseItem({ id: String(i), name: '', created_at: '', group: r.groupId ? { id: r.groupId, title: title[r.groupId] || '' } : null, column_values: r.cells }, i);
    row.views = cmv.viewsOf(row);
    return row;
  });
}

test('the Payment Status cell: read as text, an EMPTY cell is "" (never the label Monday shows on empty cells)', () => {
  assert.equal(dash.COLS.paymentStatus, 'color_mm0x9fnn');
  const item = (cv) => ({ id: '1', name: 'x', column_values: cv });
  assert.equal(dash.parseItem(item([{ id: 'color_mm0x9fnn', text: 'Signed (Unpaid)', value: '{"index":3}' }])).paymentStatus, 'Signed (Unpaid)');
  assert.equal(dash.parseItem(item([{ id: 'color_mm0x9fnn', text: 'Alreaday Sent', value: null }])).paymentStatus, '', 'an empty cell');
  assert.equal(dash.parseItem(item([])).paymentStatus, '');
});

test('mark: `waiting` on Pre-Onboarding rows only; the views, groups and counts of the Monday capture do not move', () => {
  const before = captureRows();
  const after = captureRows();
  const pre = after.filter((r) => r.stageIdx === PRE);
  assert.ok(pre.length >= 34);
  // leads for three of them; the rest have none
  const leads = [
    { id: 'L1', clientMasterItemId: pre[0].id, retainerSent: 'x' },
    { id: 'L2', clientMasterItemId: pre[1].id, retainerSigned: 'x', retainerPaid: 'y' },
    { id: 'L3', clientMasterItemId: pre[2].id, retainerSigned: 'x' },
    { id: 'L4', clientMasterItemId: after.find((r) => r.stageIdx !== PRE).id, retainerSent: 'x' },
  ];
  const at = W.mark(after, { leads, at: 1_700_000_000_000 });
  assert.equal(at, 1_700_000_000_000);
  for (const r of after) {
    assert.equal('paymentStatus' in r, false, 'the board cell was read for the label only');
    if (r.stageIdx === PRE) assert.ok(W.CODES.includes(r.waiting.code)); else assert.equal('waiting' in r, false);
  }
  assert.deepEqual([pre[0].waiting.code, pre[1].waiting.code, pre[2].waiting.code, pre[3].waiting.code], ['client-sign', 'ready', 'payment', 'unclear']);
  // id-for-id: the same rows in the same views, the same headings and counts
  for (const key of cmv.VIEW_KEYS) {
    assert.deepEqual(after.filter((r) => r.views.includes(key)).map((r) => r.id), before.filter((r) => r.views.includes(key)).map((r) => r.id), key);
  }
  const V = Object.fromEntries(cmv.pageViews().map((v) => [v.key, v]));
  const g = U.groupRows(V.assigning, U.viewOrder(V.assigning, after.filter((r) => r.views.includes('assigning'))), META);
  assert.deepEqual(g.map((x) => x.title + ' ' + x.rows.length), ['Document Collection Started 22', 'Internal Review 84', 'Submission Ready 2', 'Stuck 9', 'Pre-Onboarding 34', 'ADR 5']);
  assert.deepEqual(cmv.VIEW_KEYS.map((k) => after.filter((r) => r.views.includes(k)).length), [156, 111, 112, 28]);
});

test('the payload: only code / also / partPaid / why reach the browser — no signing link, envelope id, bank reference, email or phone', async () => {
  try {
    const { leads } = await realFetch([
      leadItem(1, { retainerSent: '2026-10-14', retainerSigned: '2026-10-15', retainerPaid: '2026-11-02', clientMasterItemId: '900', retainerCountersign: SECRET_RC, milestonePayments: SECRET_PAY, email: 'person@example.com', phone: '4165550100' }),
      leadItem(2, { retainerSent: '2026-10-14', clientMasterItemId: '901' }),
    ]);
    const cases = [
      { id: '900', stageIdx: PRE, paymentStatus: '' }, { id: '901', stageIdx: PRE, paymentStatus: 'Pro Bono' },
      { id: '902', stageIdx: PRE, paymentStatus: '' }, { id: '903', stageIdx: 1, paymentStatus: 'Paid' },
    ];
    W.mark(cases, { leads, at: 1 });
    assert.deepEqual(cases, [
      { id: '900', stageIdx: PRE, waiting: { code: 'countersign', also: [], partPaid: true } },
      { id: '901', stageIdx: PRE, waiting: { code: 'unclear', also: [], partPaid: false, why: 'pro-bono' } },
      { id: '902', stageIdx: PRE, waiting: { code: 'unclear', also: [], partPaid: false, why: 'no-lead' } },
      { id: '903', stageIdx: 1 },
    ]);
    const json = JSON.stringify(cases);
    assert.ok(!/SECRET|sign\.example|signUrl|envelope|BANKREF|example\.com|4165550100|Person/i.test(json));
    for (const c of cases) if (c.waiting) for (const k of Object.keys(c.waiting)) assert.ok(['code', 'also', 'partPaid', 'why'].includes(k), k);
  } finally { snap._reset(); }
});

test('no lead copy yet: every Pre-Onboarding row says "unchecked", nothing waits, and the time is null', () => {
  const cases = [{ id: '1', stageIdx: PRE, paymentStatus: 'Paid' }, { id: '2', stageIdx: 0, paymentStatus: '' }];
  const out = W.mark(cases, null);
  assert.equal(out, null, 'a plain value — not a promise');
  assert.deepEqual(cases, [{ id: '1', stageIdx: PRE, waiting: { code: 'unchecked', also: [], partPaid: false } }, { id: '2', stageIdx: 0 }]);
  assert.equal(W.mark(undefined, null), null);
  assert.equal(W.mark([], { leads: [], at: 9 }), 9);
});

test('the route: the join is in the page\'s route only, on peek() (never an await on the Lead Board); /api/dashboard/stats is unchanged', () => {
  const src = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const fn = src.slice(src.indexOf('function markWaiting(cases) {'), src.indexOf("app.get('/admin/dashboard-stats'"));
  assert.match(fn, /preOnboardingWaiting'\)\.mark\(cases, require\('\.\/services\/leadSnapshot'\)\.peek\(\)\)/);
  assert.ok(!/await|getLeadSnapshot|\.leads\(/.test(fn));
  const i = src.indexOf("app.get('/admin/dashboard-stats'");
  const route = src.slice(i, i + 1700);
  assert.match(route, /const waitingAt = markWaiting\(stats\.cases\);/);
  assert.match(route, /res\.json\(\{ \.\.\.stats, waitingAt, viewer:/);
  const j = src.indexOf("app.get('/api/dashboard/stats'");
  assert.ok(!/markWaiting|waiting/.test(src.slice(j, src.indexOf('});', j))));
  // the service itself: no Monday call, no write
  const svc = fs.readFileSync(require.resolve('../src/services/preOnboardingWaiting'), 'utf8');
  assert.ok(!/mondayApi|mutation|async |await /.test(svc));
  assert.match(svc, /gate\.signatureGateForLead\(/);
});

/* ── the page ── */

test('the words: first line, what comes after, the part-payment words and the full sentence — in plain words', () => {
  const w = (o) => U.waitingWords(o);
  assert.deepEqual([w({ code: 'client-sign', also: ['payment'] }).lead, w({ code: 'client-sign', also: ['payment'] }).label, w({ code: 'client-sign', also: ['payment'] }).then], ['Waiting for:', 'client signature', 'then payment']);
  assert.equal(w({ code: 'client-sign', also: ['countersign', 'payment'] }).then, 'then our countersignature, payment');
  const ns = w({ code: 'not-sent', also: ['payment'] });
  assert.deepEqual([ns.lead, ns.label, ns.then], ['', 'No agreement on record', 'then client signature, payment']);
  assert.deepEqual([w({ code: 'countersign', also: [] }).label, w({ code: 'payment', also: [] }).label, w({ code: 'payment' }).then], ['our countersignature', 'payment', '']);
  assert.deepEqual([w({ code: 'ready', also: [] }).lead, w({ code: 'ready' }).label], ['', 'Ready — should have started']);
  assert.deepEqual([w({ code: 'unclear', why: 'no-lead' }).lead, w({ code: 'unclear' }).label], ['Waiting for:', 'not clear']);
  assert.deepEqual([w({ code: 'unchecked' }).lead, w({ code: 'unchecked' }).label], ['', 'Not checked yet']);
  assert.match(w({ code: 'client-sign', also: ['payment'] }).tip, /on the client’s record yet\. \(An agreement sent by hand or signed on paper shows here until it is marked signed\.\) After that: payment\.$/);
  // "no agreement on record" says what the app knows — never "has not been sent" as a fact — and carries the by-hand / paper note
  assert.match(w({ code: 'not-sent' }).tip, /^The app has no record of a retainer agreement being sent/);
  assert.match(w({ code: 'not-sent' }).tip, /sent by hand or signed on paper/);
  assert.doesNotMatch(w({ code: 'not-sent' }).tip + w({ code: 'not-sent' }).label, /has been sent|not sent yet/);
  assert.match(w({ code: 'unclear', why: 'paid-conflict' }).tip, /^The client’s record shows signed and paid, but the case’s Payment Status was set to Not Paid or Working on it by hand\./);
  assert.match(w({ code: 'ready' }).tip, /still Pre-Onboarding\. Please check why it has not started\. Nothing is changed from here\.$/);
  assert.match(w({ code: 'unclear', why: 'no-lead' }).tip, /^No client record is linked to this case/);
  assert.match(w({ code: 'unclear', why: 'leads-disagree' }).tip, /^More than one client record/);
  assert.match(w({ code: 'unclear', why: 'pro-bono' }).tip, /^Payment Status says Pro Bono/);
  const pp = w({ code: 'client-sign', also: [], partPaid: true });
  assert.equal(pp.extra, 'part-payment recorded');
  assert.match(pp.tip, /A first part-payment is recorded; the balance is still owed\.$/);
  assert.equal(w({ code: 'ready', partPaid: true }).extra, 'part-payment recorded');
  // a code the page does not know is never guessed at; a missing value too
  assert.equal(w({ code: 'something-new' }).label, 'not clear');
  assert.equal(w(null).code, 'unclear');
  for (const c of W.CODES) assert.ok(w({ code: c }).label && w({ code: c }).tip, c);
});

test('the strip\'s counts: Pre-Onboarding rows on screen only, in process order, zero counts left out', () => {
  const r = (code, extra) => ({ stageIdx: PRE, waiting: { code, also: [], partPaid: false, ...extra } });
  const rows = [r('payment'), r('client-sign'), r('client-sign', { partPaid: true }), r('not-sent'), r('ready'), r('unclear'), r('countersign'),
    { stageIdx: 1, waiting: { code: 'payment' } }, { stageIdx: PRE }, { stageIdx: 1 }];
  assert.deepEqual(U.waitingCounts(rows, PRE), { total: 7, partPaid: 1, list: [
    { code: 'not-sent', label: 'No agreement on record', n: 1 }, { code: 'client-sign', label: 'Client signature', n: 2 },
    { code: 'countersign', label: 'Our countersignature', n: 1 }, { code: 'payment', label: 'Payment', n: 1 },
    { code: 'ready', label: 'Ready — should have started', n: 1 }, { code: 'unclear', label: 'Not clear', n: 1 } ] });
  assert.deepEqual(U.waitingCounts([r('unchecked'), r('unchecked')], PRE).list, [{ code: 'unchecked', label: 'Not checked yet', n: 2 }]);
  assert.deepEqual(U.waitingCounts([], PRE), { total: 0, list: [], partPaid: 0 });
  assert.deepEqual(U.waitingCounts(null, PRE), { total: 0, list: [], partPaid: 0 });
});

function renderRoute(path) {
  const router = require('../src/routes/adminDashboard');
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  return new Promise((resolve) => layer.route.stack[0].handle({ query: {} }, { type: () => ({ send: resolve }) }));
}
/** One function out of the emitted page script (a one-liner, or up to its closing brace at column 0). */
function fnSrc(script, name) {
  const i = script.indexOf('\nfunction ' + name + '(');
  assert.ok(i >= 0, name + ' is in the page');
  const eol = script.indexOf('\n', i + 1);
  const line = script.slice(i + 1, eol);
  if (/\}\s*$/.test(line)) return line;
  return script.slice(i + 1, script.indexOf('\n}\n', i) + 2);
}
async function pageSandbox() {
  const html = await renderRoute('/');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const s of scripts) new vm.Script(s);
  const main = scripts.find((s) => s.includes('function caseRow('));
  const els = {};
  const el = () => ({ innerHTML: '', style: {}, className: '', title: '', querySelector: () => null });
  const ctx = { window: {}, document: { createElement: el, getElementById: (id) => (els[id] = els[id] || el()) }, Date, isNaN, String, Math, isFinite,
    CM_FLASH: {}, CM_DL_FLASH: {}, TDOT_DEL_SVG: '', CM_PRE_ONBOARDING: PRE, _data: null, els };
  vm.createContext(ctx);
  const names = ['caseRow', 'renderCmHead', 'escHtml', 'healthBadge', 'shortType', 'cmNoneDash', 'cmHm', 'cmDataTimeText', 'cmToday', 'cmDay', 'cmFlashText', 'cmDlFlashText'];
  vm.runInContext(main.match(/var CMW = \(function clientMasterWindows[\s\S]*?\)\(CMW\);/)[0] + '\n' + names.map((n) => fnSrc(main, n)).join('\n'), ctx);
  return { html, main, ctx, els };
}
const V2 = Object.fromEntries(cmv.pageViews().map((v) => [v.key, v]));
const baseRow = (o) => ({ id: '9', caseRef: '2026-XX-001', clientName: 'Test Person', caseType: 'Visitor Visa', caseStage: 'Pre-Onboarding', stageIdx: PRE, health: 'Green', slaRisk: 'Green', ...o });
const stageCell = (tr) => tr.innerHTML.split('</td>')[3];

test('the page: every script parses; the Stage cell of a Pre-Onboarding row on Assigning says what it waits for, in words, with what comes after visible', async () => {
  const { ctx } = await pageSandbox();
  const row = (o, v) => stageCell(ctx.caseRow(baseRow(o), v === undefined ? V2.assigning : v, '2026-11-10'));
  const a = row({ waiting: { code: 'client-sign', also: ['payment'], partPaid: false } });
  assert.ok(a.includes('Pre-Onboarding<div class="cm-wait" data-wait="client-sign" title="There is no client signature on the client’s record yet.'), a);
  assert.ok(a.includes('Waiting for: <b>client signature</b><span class="cm-wait-n">then payment</span></div>'), a);
  const pp = row({ waiting: { code: 'not-sent', also: [], partPaid: true } });
  assert.ok(pp.includes('<b>No agreement on record</b><span class="cm-wait-n">then client signature</span><span class="cm-wait-n">part-payment recorded</span>'), pp);
  assert.ok(row({ waiting: { code: 'ready', also: [], partPaid: false } }).includes('<div class="cm-wait flag" data-wait="ready"'), 'Ready is flagged');
  assert.ok(row({ waiting: { code: 'ready', also: [], partPaid: false } }).includes('<b>Ready — should have started</b></div>'));
  assert.ok(row({ waiting: { code: 'unclear', also: [], partPaid: false, why: 'no-lead' } }).includes('Waiting for: <b>not clear</b>'));
  assert.ok(row({ waiting: { code: 'unchecked', also: [], partPaid: false } }).includes('<div class="cm-wait dim" data-wait="unchecked"'));
  assert.ok(row({ waiting: { code: 'unchecked', also: [], partPaid: false } }).includes('<b>Not checked yet</b>'));
  // nothing on a row without a value (every other stage), and nothing on the other tabs or the All list
  assert.ok(!row({ caseStage: 'Internal Review', stageIdx: 1 }).includes('cm-wait'));
  for (const v of [V2.deadlines, V2.mahesh, V2.eeita, null]) assert.ok(!row({ waiting: { code: 'payment', also: [], partPaid: false } }, v).includes('cm-wait'), v ? v.key : 'All');
  // what the server sends is escaped, never trusted as HTML
  assert.ok(!row({ waiting: { code: '<img>', also: ['<b>'], partPaid: false } }).includes('<img>'));
});

test('the page: the strip sits under the "No Support Officer" line on Assigning, counts the rows on screen, wraps, and says when the client records were read', async () => {
  const { ctx, els, html } = await pageSandbox();
  const w = (code, o) => baseRow({ waiting: { code, also: [], partPaid: false, ...o } });
  const rows = [w('client-sign'), w('client-sign'), w('payment', { partPaid: true }), w('unclear'), baseRow({ caseStage: 'Stuck', stageIdx: 3 })];
  ctx._data = { dataAt: '2026-11-10T15:00:00.000Z', waitingAt: '2026-11-10T14:58:00.000Z' };
  ctx.renderCmHead(V2.assigning, rows, { sel: {} }, [{ title: 'Pre-Onboarding', rows: rows.slice(0, 4) }], 5);
  const h = els['cm-head'].innerHTML;
  assert.ok(h.indexOf('id="cm-strip"') < h.indexOf('id="cm-noofficer"') && h.indexOf('id="cm-noofficer"') < h.indexOf('id="cm-waiting"'));
  const strip = h.slice(h.indexOf('<div class="cm-strip cm-waitstrip" id="cm-waiting"'));
  assert.ok(strip.includes('<span class="cm-wait-lead">Pre-Onboarding — waiting for:</span><span class="cm-st" data-wait="client-sign">Client signature <b>2</b></span><span class="cm-st" data-wait="payment">Payment <b>1</b></span><span class="cm-st" data-wait="unclear">Not clear <b>1</b></span>'), strip);
  assert.ok(!strip.includes('data-wait="ready"') && !strip.includes('data-wait="countersign"'), 'a zero count shows no pill');
  assert.ok(strip.includes('<span class="cm-wait-at">1 with a part-payment recorded</span>'));
  assert.match(strip, /id="cm-waiting-at"[^>]*>Client records from \d\d:\d\d<\/span>/);
  // no copy yet: the strip says so, and no time
  ctx._data = { dataAt: '2026-11-10T15:00:00.000Z', waitingAt: null };
  ctx.renderCmHead(V2.assigning, [w('unchecked'), w('unchecked')], { sel: {} }, [], 2);
  assert.ok(els['cm-head'].innerHTML.includes('data-wait="unchecked">Not checked yet <b>2</b>') && !els['cm-head'].innerHTML.includes('cm-waiting-at'));
  // no Pre-Onboarding rows on screen (e.g. filtered away): no strip; never on the other tabs
  ctx.renderCmHead(V2.assigning, [baseRow({ caseStage: 'Stuck', stageIdx: 3 })], { sel: {} }, [], 1);
  assert.ok(!els['cm-head'].innerHTML.includes('cm-waiting'));
  ctx.renderCmHead(V2.deadlines, rows, { sel: {} }, [], 5);
  assert.ok(!els['cm-head'].innerHTML.includes('cm-waiting'));
  // phone width: the strip is the wrapping pill row (not the nowrap, sticky group heading), no fixed width
  assert.match(html, /\.cm-strip \{ display:flex; flex-wrap:wrap; gap:6px; \}/);
  assert.match(html, /\.cm-waitstrip \{ align-items:center; \}/);
  assert.ok(!/\.cm-wait(strip|-lead|-at)[^{]*\{[^}]*(nowrap|min-width|[^-]width:)/.test(html));
  assert.match(html, /\.cm-wait-n \{ display:block;/, 'what comes after is its own visible line (a phone has no hover)');
  assert.ok(html.includes('var CS_COLSPAN = 15;'), 'no new column');
});

test('the page: "Not checked yet" is asked for again once, quietly — the rows on screen keep their filters; the new code follows the page-script rule', async () => {
  const { main } = await pageSandbox();
  const fn = fnSrc(main, 'cmWaitLater');
  assert.match(fn, /if \(_cmWaitAsked \|\| !_data \|\| _data\.waitingAt\) return;/);
  assert.match(fn, /_cmWaitAsked = true;/);
  assert.match(fn, /fetch\('\/admin\/dashboard-stats', /);
  assert.ok(!fn.includes('fresh=1'), 'never a forced Monday read');
  assert.match(fn, /CasesTable\.setRows\(_data\.cases\);/);
  assert.ok(!/loading|innerHTML|location/.test(fn), 'no spinner, no redraw of the page');
  assert.ok(main.includes("if (VIEW !== 'summary') cmWaitLater();"));
  const src = fs.readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  const block = src.slice(src.indexOf('/* ── The view tabs (block 3)'), src.indexOf('function renderPagination(total) {'));
  assert.ok(block.includes('function cmWaitLater()') && block.includes('CMU.waitingWords(c.waiting)') && block.includes('CMU.waitingCounts(rows, CM_PRE_ONBOARDING)'));
  assert.ok(!/[`\\]|\$\{/.test(block));
  assert.ok(!/[`\\]|\$\{/.test(U.clientMasterUi.toString()), 'the helpers are safe to inject');
  const sum = await renderRoute('/summary');
  assert.ok(!sum.includes('var CMU = ('), 'the Summary page does not carry the helpers');
});
