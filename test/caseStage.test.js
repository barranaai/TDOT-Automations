'use strict';

// Change the Case Stage from the Client Master page (2026-11-26, switch STAGE_EDIT). Every Monday seam is a fake
// (svc._io), so the tests see the EXACT write, read-back, note and cache patch — and that nothing else happens.
// The real io functions are checked against a fake mondayApi.query (retries 0 on the write and the note, explicit limits).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const mondayApi = require('../src/services/mondayApi');
const dashboardService = require('../src/services/dashboardService');
const svc = require('../src/services/caseStageService');
const features = require('../config/features');
const { clientMasterBoardId } = require('../config/monday');

const T = svc.TEXTS;
const ITEM = '5550001';
const STAFF = { id: '11', name: 'Asha <Officer>', email: 'asha@example.com', teamIds: [] };
const SETTINGS = require('./fixtures/client-master-board-meta.json').columns.color_mm0x8faa.settings;
const META = dashboardService._casesIo.parseMeta({ groups: [], columns: [{ id: 'color_mm0x8faa', settings_str: JSON.stringify(SETTINGS) }] });
const IDX = {};
for (const [k, v] of Object.entries(SETTINGS.labels)) IDX[v] = Number(k);
const LABELS = Object.keys(IDX);
const LOCK = 'color_mm0x3x1x', STAGE = 'color_mm0x8faa';
const ppl = (...ids) => JSON.stringify({ personsAndTeams: ids.map((x) => ({ id: Number(x), kind: 'person' })) });

/** A fake Monday behind svc._io: the case's cells, the leads, the notes, and switches for each failure. */
function fake(o = {}) {
  const st = {
    stage: 'Pre-Onboarding', lock: '', pay: 'Paid', applied: 'No', stageStart: '', people: {}, state: 'active', board: String(clientMasterBoardId),
    meta: META, settings: JSON.stringify(SETTINGS), leads: [], updates: [], keep: true,
    reads: 0, writes: [], readBacks: 0, notes: [], patches: [], leadFinds: 0, updateReads: 0, settingsReads: 0, rows: [], ...o,
  };
  const status = (label, index) => (label ? { value: JSON.stringify({ index }), text: label } : { value: null, text: '' });
  const stageCell = () => ({ id: STAGE, ...(st.stageCellOverride || status(st.stage, IDX[st.stage])) });
  const lockCell = () => ({ id: LOCK, ...status(st.lock, st.lock === 'Yes' ? 1 : 2) });
  const io = svc._io;
  io.readItem = async (id) => {
    st.reads++;
    if (st.readFail) throw new Error('network');
    if (st.missing) return null;
    const cvs = [stageCell(), lockCell(),
      { id: 'color_mm0x9fnn', ...status(st.pay, 1) },
      ...(st.appliedMissing ? [] : [{ id: 'color_mm0xs7kp', ...status(st.applied, st.applied === 'Yes' ? 1 : st.applied === 'No' ? 2 : 3) }]),
      { id: 'date_mm0xjm1z', text: st.stageStart, value: st.stageStart ? JSON.stringify({ date: st.stageStart }) : null },
      { id: 'text_mm142s49', text: '2026-TEST-001', value: null }];
    for (const [k, v] of Object.entries(st.people)) cvs.push({ id: k, text: '', value: v });
    return { id: String(id), name: 'Client X', state: st.state, board: { id: st.board }, column_values: cvs };
  };
  io.cachedMeta = () => st.meta;
  io.readStageSettings = async () => { st.settingsReads++; if (st.settingsFail) throw new Error('boom'); return st.settings; };
  io.findLeads = async () => { st.leadFinds++; if (st.findFail) throw new Error('lead lookup failed'); return st.leads; };
  io.readUpdates = async () => { st.updateReads++; if (st.updatesFail) throw new Error('updates failed'); return st.updates; };
  io.writeStage = async (id, cols) => {
    st.writes.push({ id, cols });
    if (st.writeFail) throw st.writeFail === true ? Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }) : st.writeFail;
    if (st.keep) {
      const idx = cols[STAGE].index;
      st.stage = Object.keys(IDX).find((l) => IDX[l] === idx) || '';
      if (cols[LOCK]) st.lock = cols[LOCK].label;
    }
    if (st.landsThenFails) throw Object.assign(new Error('timeout after it landed'), { code: 'ECONNABORTED' });
    return { change_multiple_column_values: { id } };
  };
  io.readCells = async () => {
    st.readBacks++;
    if (st.readBackFail) throw new Error('network');
    return [stageCell(), lockCell()];
  };
  io.postNote = async (id, body) => { st.notes.push({ id, body }); if (st.noteFail) throw new Error('note timeout'); return { create_update: { id: '9' } }; };
  io.patchCache = (itemId, colId, cell) => { st.patches.push({ itemId, colId, cell }); return true; };
  io.rowFor = (itemId, staff) => { st.rows.push({ itemId, staff }); return st.noRow ? null : { caseStage: st.stage || 'Unknown', stageIdx: st.stage ? IDX[st.stage] : 5, views: ['all'], waiting: null }; };
  io.now = () => Date.UTC(2026, 10, 26, 15, 4);
  return st;
}

const REAL_IO = { ...svc._io };
const realQuery = mondayApi.query;
test.beforeEach(() => {
  svc._inFlight.clear();
  process.env.STAGE_EDIT = 'on';
  delete process.env.CASE_VISIBILITY; delete process.env.ADMIN_EMAILS; delete process.env.TODO_TAB;
});
test.after(() => {
  Object.assign(svc._io, REAL_IO);
  mondayApi.query = realQuery;
  delete process.env.STAGE_EDIT; delete process.env.CASE_VISIBILITY; delete process.env.ADMIN_EMAILS; delete process.env.TODO_TAB;
});

const body = (o = {}) => ({ itemId: ITEM, index: IDX['Document Collection Started'], expected: IDX['Pre-Onboarding'], reason: '', ...o });
const call = (o = {}) => svc.change({ staff: STAFF, hasKey: false, source: 'client-master', ...o, body: body(o.body) });
async function refused(p, status, re) {
  let b;
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.body.error, re instanceof RegExp ? re : new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); b = e.body; return true; });
  return b;
}
const nothingWritten = (m) => { assert.equal(m.writes.length, 0, 'no write'); assert.equal(m.notes.length, 0, 'no note'); };
const facts = (current, o = {}) => ({ current: { index: current ? IDX[current] : 5, label: current }, locked: false, paid: true, onboarded: false, stageStart: '', signatures: { state: 'complete', missing: [] }, held: false, ...o });
const tgt = (label) => ({ index: IDX[label], label });

// ── the switch ──
test('the switch: STAGE_EDIT is on only for "on" (any case, spaces), read at call time; everything else is off', () => {
  for (const [v, on] of [[undefined, false], ['', false], ['off', false], ['yes', false], ['1', false], ['true', false], ['on', true], [' ON ', true]]) {
    if (v === undefined) delete process.env.STAGE_EDIT; else process.env.STAGE_EDIT = v;
    assert.equal(features.stageEditOn(), on, String(v));
    assert.equal(svc.enabled(), on, String(v));
  }
});

test('switch off: both endpoints answer 404 "not switched on" before anything else — no Monday read, whoever asks', async () => {
  const m = fake();
  for (const v of [undefined, 'off', 'yes']) {
    if (v === undefined) delete process.env.STAGE_EDIT; else process.env.STAGE_EDIT = v;
    for (const who of [{ staff: STAFF, hasKey: false }, { staff: null, hasKey: true }, { staff: null, hasKey: false }]) {
      const b1 = await refused(svc.change({ ...who, body: body(), source: 'client-master' }), 404, svc.OFF_TEXT);
      assert.equal(b1.code, 'off');
      const b2 = await refused(svc.preview({ ...who, itemId: ITEM }), 404, svc.OFF_TEXT);
      assert.equal(b2.code, 'off');
    }
  }
  assert.equal(m.reads, 0); nothingWritten(m);
  assert.equal(svc.OFF_TEXT, 'Changing the stage from this page is not switched on.');
});

test('markChangeable: off = the rows get no key at all; on = canChangeStage follows canAssign row by row', () => {
  delete process.env.STAGE_EDIT;
  const rows = [{ canAssign: true }, { canAssign: false }, {}];
  assert.equal(svc.markChangeable(rows), false);
  assert.ok(rows.every((r) => !('canChangeStage' in r)));
  process.env.STAGE_EDIT = 'on';
  assert.equal(svc.markChangeable(rows), true);
  assert.deepEqual(rows.map((r) => r.canChangeStage), [true, false, false]);
});

// ── who ──
test('who: no sign-in → 401 with the sign-in link; the shared key alone → 403 key-only; the texts are the stage\'s own', async () => {
  const m = fake();
  const a = await refused(svc.change({ staff: null, hasKey: false, body: body(), source: 'client-master' }), 401, 'Sign in with Monday to change the stage.');
  assert.equal(a.loginUrl, '/q/auth/monday?returnTo=%2Fadmin%2Fdashboard');
  const b = await refused(svc.change({ staff: null, hasKey: true, body: body(), source: 'client-master' }), 403, 'Sign in with Monday to change the stage.');
  assert.equal(b.code, 'key-only');
  const c = await refused(svc.preview({ staff: null, hasKey: true, itemId: ITEM }), 403);
  assert.equal(c.code, 'key-only');
  await refused(svc.preview({ staff: null, hasKey: false, itemId: ITEM }), 401);
  assert.equal(m.reads, 0); nothingWritten(m);
  assert.equal(svc.gate(STAFF, true).ok, true, 'a Monday sign-in with the key on the page is the person');
});

test('who: under CASE_VISIBILITY=assigned the access check runs on the FRESH people columns — not on the case = 403, nothing written', async () => {
  process.env.CASE_VISIBILITY = 'assigned';
  const m = fake({ people: { multiple_person_mm0xm710: ppl(99) } });
  await refused(call(), 403, T.notAssigned);
  await refused(svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM }), 403, T.notAssigned);
  nothingWritten(m);
  m.people = { multiple_person_mm0xhmgk: ppl(11) };
  const r = await call();
  assert.equal(r.ok, true);
});

test('the case must be an active row of the Client Master board; a read failure says nothing was changed', async () => {
  for (const o of [{ missing: true }, { state: 'archived' }, { board: '123' }]) {
    const m = fake(o);
    await refused(call(), 404, T.notFound);
    nothingWritten(m);
  }
  const m = fake({ readFail: true });
  await refused(call(), 502, T.readFailed);
  nothingWritten(m);
});

// ── the rules (pure) ──
test('rules table: every live label from every live label (and blank) — allowed, why, backward, locks, unlocks and reason required', () => {
  const froms = ['', ...LABELS];
  const flow = { '': 0, 'Pre-Onboarding': 1, 'Retainer Confirmed': 1, 'Document Collection Started': 2, 'Internal Review': 3, 'Submission Preparation': 4, 'Submission Ready': 5, 'Application Submitted': 6 };
  const working = ['Document Collection Started', 'Internal Review', 'Submission Preparation', 'Stuck'];
  for (const locked of [false, true]) {
    for (const from of froms) {
      for (const to of LABELS) {
        const r = svc.rule(tgt(to), facts(from, { locked }));
        const same = to === from;
        const dcsOk = to !== 'Document Collection Started' || ['', 'Pre-Onboarding', 'Retainer Confirmed'].includes(from);
        const name = `${from || '(blank)'} → ${to}${locked ? ' (locked)' : ''}`;
        assert.equal(r.allowed, !same && dcsOk, name);
        if (same) { assert.equal(r.why, T.current, name); continue; }
        if (!dcsOk) { assert.equal(r.why, T.dcsRefused, name); continue; }
        const backward = from in flow && to in flow && flow[to] < flow[from];
        assert.equal(r.backward, backward, name + ' backward');
        assert.equal(r.locks, to === 'Submission Ready' || to === 'Cancelled', name + ' locks');
        assert.equal(r.unlocks, locked && working.includes(to), name + ' unlocks');
        assert.equal(r.reasonRequired, backward || r.locks || r.unlocks, name + ' reason');
      }
    }
  }
  // a few spelled out
  assert.equal(svc.rule(tgt('Internal Review'), facts('Submission Preparation')).backward, true);
  assert.equal(svc.rule(tgt('Pre-Onboarding'), facts('Retainer Confirmed')).backward, false, 'the two early stages are level');
  assert.equal(svc.rule(tgt('Internal Review'), facts('Stuck')).backward, false, 'Stuck is outside the flow');
  assert.equal(svc.rule(tgt('Internal Review'), facts('Cancelled')).backward, false, 'Cancelled is outside the flow');
  assert.equal(svc.rule(tgt('Submission Ready'), facts('Application Submitted')).backward, true);
  assert.equal(svc.rule(tgt('Document Collection Started'), facts('Internal Review')).why,
    'A case can only go to Document Collection Started from Pre-Onboarding or Retainer Confirmed — it would email the client again.');
});

test('rules table: Document Collection Started only for a NEW case — refused when already onboarded (Checklist Template Applied = Yes) or when that flag could not be read; every other target is untouched by the flag', () => {
  const froms = ['', ...LABELS];
  const DCS = 'Document Collection Started';
  for (const locked of [false, true]) {
    for (const from of froms) {
      for (const onboarded of [false, true, null, undefined]) {
        for (const to of LABELS) {
          const name = `${from || '(blank)'} → ${to}${locked ? ' (locked)' : ''} onboarded=${onboarded}`;
          const r = svc.rule(tgt(to), facts(from, { locked, onboarded }));
          const base = svc.rule(tgt(to), facts(from, { locked, onboarded: false }));
          if (to !== DCS || to === from) { assert.deepEqual(r, base, name + ' (the flag changes nothing)'); continue; }
          if (!['', 'Pre-Onboarding', 'Retainer Confirmed'].includes(from)) { assert.deepEqual([r.allowed, r.why], [false, T.dcsRefused], name); continue; }
          if (onboarded === false) { assert.equal(r.allowed, true, name); continue; }
          assert.equal(r.allowed, false, name);
          assert.equal(r.why, onboarded === true ? T.dcsOnboarded : T.dcsOnboardedUnknown, name);
        }
      }
    }
  }
  assert.equal(T.dcsOnboarded, 'This case was already onboarded — moving it to Document Collection Started would email the client again.');
  assert.equal(T.dcsOnboardedUnknown, 'Could not check whether this case was already onboarded — nothing was changed. Try again, or change it in Monday.');
});

test('onboardedOf: Yes = onboarded; No or blank = new (the webhook\'s own reading); the cell missing or another label = cannot tell (null)', () => {
  assert.equal(svc.onboardedOf({ id: 'color_mm0xs7kp', value: '{"index":1}', text: 'Yes' }), true);
  assert.equal(svc.onboardedOf({ id: 'color_mm0xs7kp', value: '{"index":1}', text: ' yes ' }), true);
  assert.equal(svc.onboardedOf({ id: 'color_mm0xs7kp', value: '{"index":2}', text: 'No' }), false);
  assert.equal(svc.onboardedOf({ id: 'color_mm0xs7kp', value: null, text: '' }), false, 'blank = never onboarded');
  assert.equal(svc.onboardedOf({ id: 'color_mm0xs7kp', value: null, text: 'Yes' }), false, 'a stale text on a blank cell is blank');
  assert.equal(svc.onboardedOf(null), null, 'not in the read');
  assert.equal(svc.onboardedOf(undefined), null);
  assert.equal(svc.onboardedOf({ id: 'color_mm0xs7kp', value: '{"index":3}', text: 'Maybe' }), null);
  assert.equal(svc.onboardedOf({ id: 'color_mm0xs7kp', value: '{"index":3}', text: '' }), null, 'a label with no text');
});

test('the working stages are the engines\' own ACTIVE_STAGES (one copy each in four engines)', () => {
  for (const f of ['caseHealthEngine', 'slaRiskEngine', 'expiryRiskEngine', 'escalationRoutingService']) {
    const src = fs.readFileSync(path.join(__dirname, '../src/services', f + '.js'), 'utf8');
    const m = /const ACTIVE_STAGES = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    assert.ok(m, f);
    const list = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.deepEqual(list, [...svc.WORKING_STAGES], f);
  }
  // and the locking labels are Submission Ready + the webhook's TERMINAL_STAGES (unchanged)
  assert.deepEqual([...require('../src/services/stageGateService').TERMINAL_STAGES], ['Submitted', 'Approved', 'Refused', 'Closed', 'Withdrawn', 'Cancelled', 'Archived']);
});

test('effects: Document Collection Started says, from the facts, whether the client is emailed now, again, or it waits', () => {
  const dcs = tgt('Document Collection Started');
  const fx = (o) => svc.effectsOf(dcs, facts('Pre-Onboarding', o), svc.rule(dcs, facts('Pre-Onboarding', o)));
  assert.deepEqual(fx({}), [T.dcsEmail]);
  assert.deepEqual(fx({ paid: false }), [T.dcsWaitsPayment]);
  // an onboarded case can no longer reach DCS (rule()), so the "emailed again" / "already set up, not Paid" lines are gone
  assert.ok(!('dcsEmailAgain' in T) && !('dcsNotPaidApplied' in T));
  assert.ok(!Object.values(T).some((t) => typeof t === 'string' && /again \(this case|already set up, so the app counts/.test(t)));
  assert.deepEqual(fx({ signatures: { state: 'missing', missing: ['client signature', 'payment'] } }),
    ['Waits for signatures (missing: client signature and payment). Nothing is sent now; onboarding starts by itself when the agreement is fully signed.']);
  assert.deepEqual(fx({ signatures: { state: 'no-lead', missing: [] } }), [T.dcsEmail], 'no linked lead = the webhook passes');
  assert.deepEqual(fx({ signatures: { state: 'unknown', missing: [] } }), [T.dcsSigUnknown]);
  assert.deepEqual(fx({ held: true }), [T.dcsEmail], 'the held line is not for DCS (the webhook holds it again, and the auto start still works)');
  assert.equal(T.dcsEmail, 'The client is emailed “Your case is ready” now, and the document checklist is set up.');
});

test('effects: lock, unlock, stays locked, the clock, payment, held onboarding, backward, leaving the working stages', () => {
  const fx = (from, to, o) => { const f = facts(from, o); return svc.effectsOf(tgt(to), f, svc.rule(tgt(to), f)); };
  assert.deepEqual(fx('Submission Preparation', 'Submission Ready'), [T.locks, T.srTeam]);
  assert.equal(T.locks, 'This locks the case — reminders, readiness checks and escalations stop.');
  assert.equal(T.srTeam, 'It also emails the Submission Team and the Case Manager.');
  assert.deepEqual(fx('Internal Review', 'Cancelled'), [T.locks, T.cancelledPortal]);
  assert.deepEqual(fx('Document Collection Started', 'Internal Review'), [T.clock, T.leavesDcs]);
  assert.equal(T.clock, 'Restarts the stage clock and reminder count.');
  assert.deepEqual(fx('Cancelled', 'Internal Review', { locked: true }), [T.clock, T.unlocks]);
  assert.equal(T.unlocks, 'This also unlocks the case — reminders and checks start again.');
  assert.deepEqual(fx('Cancelled', 'Application Submitted', { locked: true }), [T.staysLocked], 'locked: "stays locked" alone, never next to "does not lock"');
  assert.deepEqual(fx('Submission Ready', 'Application Submitted', { locked: true }), [T.staysLocked], 'the usual move after filing');
  assert.deepEqual(fx('Submission Ready', 'Application Submitted', { locked: false }), [T.notLocking]);
  assert.equal(T.staysLocked, 'The case stays locked.');
  assert.deepEqual(fx('Submission Ready', 'Submission Preparation', { locked: true }), [T.backward, T.clock, T.unlocks]);
  assert.deepEqual(fx('Submission Ready', 'Cancelled', { locked: true }), [T.locks, T.cancelledPortal], 'a locking move: no "stays locked" line');
  // payment: past the early stages before Paid
  assert.deepEqual(fx('Pre-Onboarding', 'Internal Review', { paid: false }), [T.clock, T.notPaid]);
  assert.deepEqual(fx('', 'Stuck', { paid: false }), [T.notPaid]);
  assert.deepEqual(fx('Document Collection Started', 'Stuck', { paid: false }), [T.leavesDcs, T.notPaid], 'a deferred DCS case moved on loses the start-on-payment too');
  assert.deepEqual(fx('Pre-Onboarding', 'Retainer Confirmed', { paid: false }), [], 'between early stages: nothing');
  assert.deepEqual(fx('Internal Review', 'Stuck', { paid: false }), [], 'already past the early stages: nothing new');
  assert.equal(T.notPaid, 'Payment is not marked Paid — when it is, onboarding will NOT start by itself.');
  // held onboarding (an app write counts as a person acting)
  assert.deepEqual(fx('Pre-Onboarding', 'Retainer Confirmed', { held: true }), [T.held]);
  assert.deepEqual(fx('Pre-Onboarding', 'Retainer Confirmed', { held: null }), [T.heldUnknown]);
  assert.match(T.held, /counts as a person acting: the app will NOT start onboarding by itself when the last signature lands/);
  // leaving
  assert.deepEqual(fx('Document Collection Started', 'Pre-Onboarding'), [T.backward, T.leavesDcs, T.leavesWorking]);
  assert.deepEqual(fx('Internal Review', 'Application Submitted'), [T.leavesWorking, T.notLocking]);
});

test('warning lines are marked by the server (a parallel warn[] per option): outward emails, the portal, lock/unlock, payment, held, backward, waits — never the plain lines', async () => {
  for (const t of [T.dcsEmail, T.dcsSigUnknown, T.dcsWaitsPayment, T.dcsWaitsSignatures('client signature'),
    T.locks, T.srTeam, T.cancelledPortal, T.unlocks, T.notPaid, T.held, T.heldUnknown, T.backward]) assert.equal(svc.isWarnLine(t), true, t);
  for (const t of [T.notLocking, T.staysLocked, T.clock, T.leavesDcs, T.leavesWorking]) assert.equal(svc.isWarnLine(t), false, t);
  const m = fake({ stage: 'Submission Preparation' });
  const r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  for (const o of r.options) {
    assert.ok(Array.isArray(o.warn) && o.warn.length === o.effects.length, o.label);
    assert.deepEqual(o.warn, o.effects.map(svc.isWarnLine), o.label);
  }
  const sr = r.options.find((o) => o.label === 'Submission Ready');
  assert.deepEqual(sr.effects, [T.locks, T.srTeam]);
  assert.deepEqual(sr.warn, [true, true], 'the staff email is a warning line, not plain text');
  nothingWritten(m);
});

// ── labels ──
test('labels: from the cached meta (board order, never blank 5); meta null → the column settings read here (a deactivated label left out); both missing → refused', async () => {
  const live = svc.labelsFromMeta(META);
  assert.ok(!(5 in live.labels));
  assert.equal(live.order[0], IDX['Retainer Confirmed'], 'board order: Retainer Confirmed first');
  assert.ok(!live.order.includes(5));
  assert.equal(svc.labelsFromMeta(null), null);
  assert.equal(svc.labelsFromMeta({ stageLabels: {}, stageOrder: [] }), null);
  assert.equal(svc.labelsFromMeta({ stageLabels: { 5: 'Ghost' }, stageOrder: [5] }), null, 'index 5 is never a label to offer');
  const s2 = svc.labelsFromSettings(JSON.stringify({ ...SETTINGS, deactivated_labels: [IDX['Ads posted']] }));
  assert.ok(!(IDX['Ads posted'] in s2.labels));
  assert.deepEqual(s2.order.filter((i) => i !== IDX['Ads posted']), s2.order);
  assert.deepEqual(svc.labelsFromSettings(JSON.stringify(SETTINGS)).order, live.order, 'the same order as the cached meta');
  assert.equal(svc.labelsFromSettings('not json'), null);

  const m = fake({ meta: null });
  const r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  assert.equal(m.settingsReads, 1);
  assert.deepEqual(r.options.map((o) => o.index), live.order);
  const m2 = fake({ meta: null, settingsFail: true });
  await refused(call(), 502, T.labelsFailed);
  nothingWritten(m2);
  const m3 = fake({ meta: null, settings: '{}' });
  await refused(svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM }), 502, T.labelsFailed);
  assert.equal(m3.writes.length, 0);
});

test('labels: blank (5) and an index not on the board are refused before any read; nothing written', async () => {
  const m = fake();
  await refused(call({ body: { index: 5 } }), 400, T.notOnBoard);
  assert.equal(m.reads, 0);
  await refused(call({ body: { index: 42 } }), 400, T.notOnBoard);
  nothingWritten(m);
  for (const bad of [{ index: 'x' }, { index: -1 }, { index: null }, { expected: 'x' }, { expected: undefined }, { itemId: 'abc' }, { reason: 7 }]) {
    await refused(call({ body: bad }), 400);
  }
  nothingWritten(m);
});

// ── preview ──
test('preview: every live label in board order (never blank), the current one disabled, DCS refused from later stages, effects only for the allowed', async () => {
  const m = fake({ stage: 'Internal Review' });
  const r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  assert.equal(r.ok, true);
  assert.deepEqual(r.current, { index: IDX['Internal Review'], label: 'Internal Review' });
  assert.equal(r.caseRef, '2026-TEST-001');
  assert.deepEqual(r.options.map((o) => o.index), svc.labelsFromMeta(META).order);
  assert.ok(!r.options.some((o) => o.index === 5));
  const by = (l) => r.options.find((o) => o.label === l);
  assert.deepEqual([by('Internal Review').allowed, by('Internal Review').why], [false, T.current]);
  assert.deepEqual([by('Document Collection Started').allowed, by('Document Collection Started').why, by('Document Collection Started').effects], [false, T.dcsRefused, []]);
  assert.deepEqual(by('Submission Preparation').effects, [T.clock]);
  assert.equal(by('Submission Ready').reasonRequired, true);
  assert.equal(by('Submission Preparation').reasonRequired, false);
  assert.equal(m.leadFinds, 0, 'no signature read when DCS cannot be chosen');
  assert.equal(m.updateReads, 0, 'no notes read for a case past the early stages');
  nothingWritten(m);
  assert.equal(m.patches.length, 0);
  assert.ok(!('row' in r));
});

test('preview: DCS from Pre-Onboarding reads the signature gate on the linked leads (paid, never onboarded) — the webhook\'s own rule', async () => {
  const signed = { retainerSigned: '2026-11-01', retainerPaid: '2026-11-02', retainerCountersign: '' };
  const m = fake({ leads: [{ retainerSigned: '' }, signed] });
  let r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  const dcs = () => r.options.find((o) => o.label === 'Document Collection Started');
  assert.equal(m.leadFinds, 1);
  assert.deepEqual(dcs().effects, [T.dcsEmail], 'one fully signed claimant is enough');
  m.leads = [{ retainerSigned: '' }];
  r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  assert.deepEqual(dcs().effects, ['Waits for signatures (missing: client signature). Nothing is sent now; onboarding starts by itself when the agreement is fully signed.']);
  m.findFail = true;
  r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  assert.deepEqual(dcs().effects, [T.dcsSigUnknown]);
  // not paid: no lead read (the webhook decides without it)
  const before = m.leadFinds;
  m.findFail = false; m.pay = 'Pending';
  r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  assert.deepEqual(dcs().effects, [T.dcsWaitsPayment]);
  // blank Checklist Template Applied = a new case (the webhook's reading): allowed
  m.applied = '';
  r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  assert.deepEqual([dcs().allowed, dcs().effects], [true, [T.dcsWaitsPayment]]);
  assert.equal(m.leadFinds, before);
  nothingWritten(m);
});

test('preview: an already-onboarded case (Checklist Template Applied = Yes) at Pre-Onboarding — DCS disabled with the reason, paid or not; a flag that cannot be read disables it too; no signature read', async () => {
  const m = fake({ stage: 'Pre-Onboarding', applied: 'Yes', leads: [{ retainerSigned: '' }] });
  const dcs = (r) => r.options.find((o) => o.label === 'Document Collection Started');
  for (const pay of ['Paid', 'Pending', '']) {
    m.pay = pay;
    const r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
    assert.deepEqual([dcs(r).allowed, dcs(r).why, dcs(r).effects, dcs(r).warn], [false, T.dcsOnboarded, [], []], pay);
    assert.equal(r.options.find((o) => o.label === 'Retainer Confirmed').allowed, true, 'the other stages stay open');
  }
  m.pay = 'Paid';
  for (const o of [{ appliedMissing: true }, { appliedMissing: false, applied: 'Maybe' }]) {
    Object.assign(m, o);
    const r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
    assert.deepEqual([dcs(r).allowed, dcs(r).why, dcs(r).effects], [false, T.dcsOnboardedUnknown, []], JSON.stringify(o));
  }
  assert.equal(m.leadFinds, 0, 'no signature read when DCS cannot be chosen');
  nothingWritten(m);
});

test('preview: a held onboarding case (Paid, a hold note, not resumed) warns on every stage except DCS; an unreadable history says it could not check', async () => {
  const m = fake({ stage: 'Pre-Onboarding', updates: [{ id: '1', created_at: '2026-11-20T10:00:00Z', text_body: 'Onboarding deferred: missing client signature.', body: '⛔ <b>Onboarding deferred:</b> missing client signature.' }], leads: [{ retainerSigned: '' }] });
  let r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  assert.equal(m.updateReads, 1);
  assert.ok(r.options.find((o) => o.label === 'Retainer Confirmed').effects.includes(T.held));
  assert.ok(!r.options.find((o) => o.label === 'Document Collection Started').effects.includes(T.held));
  m.updates = [];
  r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  assert.ok(!r.options.find((o) => o.label === 'Retainer Confirmed').effects.some((t) => t === T.held || t === T.heldUnknown));
  m.updatesFail = true;
  r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  assert.ok(r.options.find((o) => o.label === 'Retainer Confirmed').effects.includes(T.heldUnknown));
  // not paid, or already started (stage start date): no notes read
  const n = m.updateReads;
  m.updatesFail = false; m.pay = ''; await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  m.pay = 'Paid'; m.stageStart = '2026-11-10'; await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM });
  assert.equal(m.updateReads, n);
});

test('preview: the page showed another stage → the cached row follows Monday\'s and the answer carries the rebuilt row', async () => {
  const m = fake({ stage: 'Internal Review' });
  const r = await svc.preview({ staff: STAFF, hasKey: false, itemId: ITEM, expected: String(IDX['Pre-Onboarding']) });
  assert.deepEqual(m.patches.map((p) => p.colId), [STAGE]);
  assert.equal(m.patches[0].cell.text, 'Internal Review');
  assert.equal(JSON.parse(m.patches[0].cell.value).index, IDX['Internal Review']);
  assert.equal(r.row.caseStage, 'Internal Review');
  nothingWritten(m);
});

// ── the write ──
test('Pre-Onboarding → DCS: ONE mutation with exactly the stage index, read back (index and text), one note naming who, the cache patched, the row returned', async () => {
  const m = fake();
  const r = await call();
  assert.deepEqual(m.writes, [{ id: ITEM, cols: { [STAGE]: { index: IDX['Document Collection Started'] } } }]);
  assert.equal(m.readBacks, 1);
  assert.equal(m.notes.length, 1);
  const n = m.notes[0].body;
  assert.match(n, /^🔀 <b>Case Stage changed<\/b>: Pre-Onboarding → Document Collection Started\. Changed on the Client Master page by Asha &lt;Officer&gt; · 26 Nov 2026, 10:04 am \(Toronto\)\.$/);
  assert.deepEqual(m.patches.map((p) => p.colId), [STAGE]);
  assert.equal(JSON.parse(m.patches[0].cell.value).index, IDX['Document Collection Started']);
  assert.deepEqual(r, { ok: true, stage: { index: 0, label: 'Document Collection Started' }, from: { index: 12, label: 'Pre-Onboarding' }, unlocked: false,
    row: { caseStage: 'Document Collection Started', stageIdx: 0, views: ['all'], waiting: null } });
  assert.equal(m.rows[0].staff, STAFF, 'the row is rebuilt for this viewer (the page-only To-do view)');
});

test('from blank: the note says "no stage"; an optional reason is in the note, escaped', async () => {
  const m = fake({ stage: '' });
  await call({ body: { expected: 5, reason: 'Retainer <signed> today' } });
  assert.match(m.notes[0].body, /: no stage → Document Collection Started\. Reason: Retainer &lt;signed&gt; today\. Changed on/);
});

test('UNLOCK: a locked Cancelled case → Internal Review needs a reason, then stage + Automation Lock = No in the SAME mutation; the note and the answer say unlocked', async () => {
  const m = fake({ stage: 'Cancelled', lock: 'Yes' });
  const b = await refused(call({ body: { index: IDX['Internal Review'], expected: IDX.Cancelled } }), 400, T.reasonNeeded);
  assert.equal(b.code, 'reason');
  nothingWritten(m);
  const r = await call({ body: { index: IDX['Internal Review'], expected: IDX.Cancelled, reason: 'Cancelled by mistake' } });
  assert.deepEqual(m.writes, [{ id: ITEM, cols: { [STAGE]: { index: IDX['Internal Review'] }, [LOCK]: { label: 'No' } } }]);
  assert.equal(r.unlocked, true);
  assert.match(m.notes[0].body, /Cancelled → Internal Review\. The case was also <b>unlocked<\/b> \(Automation Lock set to No\) — reminders and checks start again\. Reason: Cancelled by mistake\./);
  assert.deepEqual(m.patches.map((p) => p.colId).sort(), [LOCK, STAGE].sort());
  assert.equal(m.patches.find((p) => p.colId === LOCK).cell.text, 'No');
});

test('a locked case moved to a non-working stage keeps its lock: no lock column in the write', async () => {
  const m = fake({ stage: 'Cancelled', lock: 'Yes' });
  const r = await call({ body: { index: IDX['Application Submitted'], expected: IDX.Cancelled } });
  assert.deepEqual(m.writes[0].cols, { [STAGE]: { index: IDX['Application Submitted'] } });
  assert.equal(r.unlocked, false);
  assert.ok(!/unlocked/.test(m.notes[0].body));
});

test('Submission Ready / Cancelled / a backward move need a reason (the server checks, not only the page); a forward move does not', async () => {
  for (const [from, to] of [['Submission Preparation', 'Submission Ready'], ['Internal Review', 'Cancelled'], ['Submission Preparation', 'Internal Review']]) {
    const m = fake({ stage: from });
    await refused(call({ body: { index: IDX[to], expected: IDX[from] } }), 400, T.reasonNeeded);
    await refused(call({ body: { index: IDX[to], expected: IDX[from], reason: 'abc' } }), 400, T.reasonNeeded);
    nothingWritten(m);
    await call({ body: { index: IDX[to], expected: IDX[from], reason: 'Checked with Gauri' } });
    assert.equal(m.writes.length, 1, to);
  }
  const m = fake({ stage: 'Document Collection Started' });
  await call({ body: { index: IDX['Internal Review'], expected: IDX['Document Collection Started'] } });
  assert.equal(m.writes.length, 1);
  await refused(call({ body: { index: IDX['Submission Preparation'], expected: IDX['Internal Review'], reason: 'x'.repeat(301) } }), 400, T.reasonTooLong);
});

test('DCS from a later stage is refused with the plain words; nothing written', async () => {
  const m = fake({ stage: 'Internal Review' });
  await refused(call({ body: { expected: IDX['Internal Review'], reason: 'please' } }), 400, T.dcsRefused);
  nothingWritten(m);
});

test('POST (the page bypassed): Internal Review → Pre-Onboarding → DCS on an onboarded case is refused by the server on the FRESH flag; nothing written, no note, no lead read', async () => {
  // the case was sent back to Pre-Onboarding earlier; the checklist is applied (it was onboarded)
  for (const pay of ['Paid', 'Pending']) {
    const m = fake({ stage: 'Pre-Onboarding', applied: 'Yes', pay });
    await refused(call({ body: { reason: 'Restart onboarding' } }), 400, T.dcsOnboarded);
    nothingWritten(m);
    assert.equal(m.leadFinds, 0);
    assert.equal(m.patches.length, 0);
  }
  // from blank and Retainer Confirmed too
  for (const stage of ['', 'Retainer Confirmed']) {
    const m = fake({ stage, applied: 'Yes' });
    await refused(call({ body: { expected: stage ? IDX[stage] : 5 } }), 400, T.dcsOnboarded);
    nothingWritten(m);
  }
  // the flag cannot be read (the cell missing from the read, or a label that is neither Yes nor No): refused too
  for (const o of [{ appliedMissing: true }, { applied: 'Maybe' }]) {
    const m = fake(o);
    await refused(call(), 400, T.dcsOnboardedUnknown);
    nothingWritten(m);
  }
  // the page showed Pre-Onboarding but the flag went to Yes since (fresh read wins): refused
  const m = fake({ applied: 'No' });
  const realRead = svc._io.readItem;
  svc._io.readItem = async (id) => { m.applied = 'Yes'; return realRead(id); };
  try { await refused(call(), 400, T.dcsOnboarded); } finally { svc._io.readItem = realRead; }
  nothingWritten(m);
  // a new case (No, or blank) still goes
  for (const applied of ['No', '']) {
    const ok = fake({ applied });
    const r = await call();
    assert.equal(r.ok, true, applied || '(blank)');
    assert.equal(ok.writes.length, 1);
  }
});

test('stale: the stage changed since the page loaded → 409 changed with the stage now (and the row), the cache follows, nothing written', async () => {
  const m = fake({ stage: 'Internal Review' });
  const b = await refused(call({ body: { index: IDX['Submission Preparation'], expected: IDX['Document Collection Started'] } }), 409,
    'Someone changed the stage since your page loaded — it is now Internal Review.');
  assert.equal(b.code, 'changed');
  assert.deepEqual(b.current, { index: IDX['Internal Review'], label: 'Internal Review' });
  assert.equal(b.row.caseStage, 'Internal Review');
  assert.deepEqual(m.patches.map((p) => p.colId), [STAGE]);
  nothingWritten(m);
});

test('unchanged: the case already holds the wanted stage → no write, no note (whether or not the page knew)', async () => {
  const m = fake({ stage: 'Internal Review' });
  let r = await call({ body: { index: IDX['Internal Review'], expected: IDX['Internal Review'] } });
  assert.deepEqual(r, { ok: true, unchanged: true, stage: { index: IDX['Internal Review'], label: 'Internal Review' } });
  r = await call({ body: { index: IDX['Internal Review'], expected: IDX['Document Collection Started'] } });
  assert.equal(r.unchanged, true);
  assert.equal(r.row.caseStage, 'Internal Review', 'the page learns the stage it did not show');
  nothingWritten(m);
});

test('one write at a time per case: a second change while the first is in flight → 409 busy; the slot is freed after', async () => {
  const m = fake();
  svc._inFlight.add(ITEM);
  const b = await refused(call(), 409, T.busy);
  assert.equal(b.code, 'busy');
  nothingWritten(m);
  svc._inFlight.clear();
  let release;
  m.writesHeld = new Promise((res) => { release = res; });
  const realWrite = svc._io.writeStage;
  svc._io.writeStage = async (id, cols) => { await m.writesHeld; return realWrite(id, cols); };
  const first = call();
  await new Promise((r) => setImmediate(r));
  await refused(call(), 409, T.busy);
  release();
  await first;
  assert.equal(m.writes.length, 1);
  assert.equal(svc._inFlight.size, 0);
  const again = await call();   // the page still says Pre-Onboarding, but the case already holds DCS: no second write
  assert.equal(again.unchanged, true);
  assert.equal(m.writes.length, 1);
});

test('the write answered with an error but Monday holds the new stage → treated as made (note, patch)', async () => {
  const m = fake({ landsThenFails: true });
  const r = await call();
  assert.equal(r.ok, true);
  assert.equal(m.notes.length, 1);
  assert.equal(m.readBacks, 1);
});

test('the write failed and Monday still holds the old stage: a refusal Monday answered = "not changed"; no answer = "result unknown"; never a note', async () => {
  let m = fake({ writeFail: new Error('ColumnValueException: invalid label') });
  let b = await refused(call(), 502, T.refused);
  assert.deepEqual(b.current, { index: IDX['Pre-Onboarding'], label: 'Pre-Onboarding' });
  assert.equal(m.notes.length, 0);
  m = fake({ writeFail: Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } }) });
  await refused(call(), 502, T.refused);
  m = fake({ writeFail: true });                                     // a timeout (no answer)
  await refused(call(), 502, T.unknown);
  m = fake({ writeFail: Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }) });
  await refused(call(), 502, T.unknown);
  assert.equal(m.notes.length, 0);
  assert.equal(svc.definitiveRefusal(Object.assign(new Error('x'), { response: { status: 429 } })), false);
});

test('the read-back fails twice → "result unknown", no note; Monday holds another index → "did not keep", no note, the cache follows the read-back', async () => {
  let m = fake({ readBackFail: true });
  await refused(call(), 502, T.unknown);
  assert.equal(m.readBacks, 2);
  assert.equal(m.notes.length, 0);
  m = fake({ keep: false });
  await refused(call(), 502, T.notKept);
  assert.equal(m.notes.length, 0);
  assert.equal(m.patches[0].cell.text, 'Pre-Onboarding');
});

test('the wanted index read back but with another text (the label renamed in Monday since the board meta was read): the write WAS made — the note names Monday\'s label, the answer says so', async () => {
  const m = fake();
  const realWrite = svc._io.writeStage;
  svc._io.writeStage = async (id, cols) => { await realWrite(id, cols); m.stageCellOverride = { value: JSON.stringify({ index: 0 }), text: 'Docs Started' }; };
  try {
    const r = await call();
    assert.equal(r.ok, true);
    assert.deepEqual(r.stage, { index: 0, label: 'Docs Started' });
    assert.equal(r.renamed, true);
    assert.equal(r.warning, T.renamed('Docs Started', 'Document Collection Started'));
    assert.match(r.warning, /^Monday now calls this stage “Docs Started” \(this page had “Document Collection Started”\)/);
    assert.equal(m.notes.length, 1, 'the only record of who did it is posted');
    assert.match(m.notes[0].body, /: Pre-Onboarding → Docs Started\. Changed on the Client Master page by Asha/);
    assert.equal(m.patches[0].cell.text, 'Docs Started', 'the cache follows the read-back');
    // a retry finds the case already there: unchanged, nothing written again
    const again = await call();
    assert.equal(again.unchanged, true);
    assert.equal(m.writes.length, 1);
  } finally { svc._io.writeStage = realWrite; }
});

test('unlock asked, the stage landed but the lock does not read No: the write WAS made — note (saying the lock is not confirmed), ok with lockUnconfirmed, unlocked false', async () => {
  const m = fake({ stage: 'Cancelled', lock: 'Yes' });
  svc._io.writeStage = async (id, cols) => { m.writes.push({ id, cols }); m.stage = 'Internal Review'; };
  const r = await call({ body: { index: IDX['Internal Review'], expected: IDX.Cancelled, reason: 'Cancelled by mistake' } });
  assert.equal(r.ok, true);
  assert.equal(r.unlocked, false);
  assert.equal(r.lockUnconfirmed, true);
  assert.equal(r.warning, T.lockUnconfirmed('Yes'));
  assert.match(r.warning, /^Monday still shows the Automation Lock as “Yes”, not No — check it in Monday/);
  assert.equal(m.notes.length, 1);
  const n = m.notes[0].body;
  assert.match(n, /Cancelled → Internal Review\. The app also asked Monday to unlock the case \(Automation Lock = No\), but Monday still shows it as “Yes” — check it\. Reason: Cancelled by mistake\./);
  assert.ok(!/<b>unlocked<\/b>/.test(n), 'never claims an unlock Monday does not show');
  assert.equal(m.patches.find((p) => p.colId === LOCK).cell.text, 'Yes', 'the cache follows the lock Monday shows');
});

test('the note failed: the stage stays changed, the answer says noteFailed, the cache is still patched', async () => {
  const m = fake({ noteFail: true });
  const r = await call();
  assert.equal(r.ok, true);
  assert.equal(r.noteFailed, true);
  assert.equal(m.writes.length, 1);
  assert.deepEqual(m.patches.map((p) => p.colId), [STAGE]);
});

test('a cold server copy: the answer still says the stage, row null (the page applies the stage alone)', async () => {
  const m = fake({ noRow: true });
  const r = await call();
  assert.equal(r.row, null);
  assert.deepEqual(r.stage, { index: 0, label: 'Document Collection Started' });
  assert.equal(m.writes.length, 1);
});

test('rowFor on a server copy older than 20 minutes (a quiet stretch): the row is still rebuilt with its new views, so it leaves the tab it left', async () => {
  Object.assign(svc._io, REAL_IO);
  const cio = dashboardService._casesIo;
  const realNow = cio.io.now, realQ = mondayApi.query;
  let clock = 3e12;
  cio.io.now = () => clock;
  const raw = (idx) => ({ id: ITEM, name: 'Client X', created_at: '2026-11-01T00:00:00Z', group: { id: 'group_mm8qqjyz', title: 'November 2026' },
    column_values: [{ id: STAGE, text: 'Internal Review', value: JSON.stringify({ index: idx }) }, { id: 'text_mm142s49', text: '2026-T-1', value: null }] });
  try {
    mondayApi.query = async (gql) => {
      if (/items_page/.test(gql)) return { boards: [{ items_page: { cursor: null, items: [{ id: ITEM }] } }] };
      if (/items\(ids: \$ids, limit: 100\)/.test(gql)) return { items: [raw(IDX['Internal Review'])] };
      if (/groups \{ id title position \}/.test(gql)) return { boards: [{ groups: [], columns: [] }] };
      throw new Error('unexpected ' + gql.slice(0, 60));
    };
    await cio.refresh();
    mondayApi.query = async () => { throw new Error('rowFor never reads Monday'); };
    assert.ok(svc._io.rowFor(ITEM, STAFF).views.includes('assigning'), 'Internal Review: on Assigning');
    clock += cio.CASES_HARD_MS + 5 * 60 * 1000;   // 25 minutes later, nobody loaded the page
    assert.equal(dashboardService.peekCachedItems(), null, 'the plain peek still refuses an old copy');
    dashboardService.patchCachedColumn(ITEM, STAGE, { value: JSON.stringify({ index: IDX['Application Submitted'] }), text: 'Application Submitted' });
    const r = svc._io.rowFor(ITEM, STAFF);
    assert.ok(r, 'not null on an old copy');
    assert.equal(r.stageIdx, IDX['Application Submitted']);
    assert.ok(!r.views.includes('assigning'), 'Application Submitted: off Assigning');
  } finally { cio.io.now = realNow; cio.overrides.clear(); mondayApi.query = realQ; }
});

// ── the real io (a fake mondayApi.query) ──
test('io: the write and the note go with retries 0; the write never creates a label; every items(ids:) read has an explicit limit', async () => {
  Object.assign(svc._io, REAL_IO);
  const calls = [];
  mondayApi.query = async (gql, vars, retries) => { calls.push({ gql, vars, retries }); return { items: [{ id: ITEM, column_values: [], updates: [] }], boards: [{ columns: [{ id: STAGE, settings_str: '{}' }] }] }; };
  await svc._io.writeStage(ITEM, { [STAGE]: { index: 1 }, [LOCK]: { label: 'No' } });
  await svc._io.postNote(ITEM, 'x');
  await svc._io.readItem(ITEM); await svc._io.readCells(ITEM); await svc._io.readUpdates(ITEM); await svc._io.readStageSettings();
  const [w, n, ...reads] = calls;
  assert.equal(w.retries, 0); assert.equal(n.retries, 0);
  assert.match(w.gql, /change_multiple_column_values\(board_id: \$b, item_id: \$i, column_values: \$c\)/);
  assert.ok(!/create_labels_if_missing/.test(w.gql));
  assert.deepEqual(JSON.parse(w.vars.c), { [STAGE]: { index: 1 }, [LOCK]: { label: 'No' } });
  assert.equal(w.vars.b, String(clientMasterBoardId));
  for (const r of reads) assert.match(r.gql, /(items\(ids: \$ids, limit: 1\)|boards\(ids: \$b, limit: 1\))/);
  assert.ok(!fs.readFileSync(require.resolve('../src/services/caseStageService'), 'utf8').includes('create_labels_if_missing:'), 'never sent');
  assert.ok(!/invalidateCases/.test(fs.readFileSync(require.resolve('../src/services/caseStageService'), 'utf8')), 'the cache is patched, never invalidated');
  mondayApi.query = realQuery;
});

test('io.rowFor: the row rebuilt from the cached rows — views from the server\'s rules, the page-only To-do view for a viewer who has it, "waiting" on Pre-Onboarding only', () => {
  Object.assign(svc._io, REAL_IO);
  const realPeek = dashboardService.peekCachedItems;
  const raw = (idx) => ({ id: ITEM, name: 'Client X', created_at: '2026-11-01T00:00:00Z', group: { id: 'group_mm8qqjyz', title: 'November 2026' },
    column_values: [{ id: STAGE, text: 'x', value: JSON.stringify({ index: idx }) }, { id: 'text_mm142s49', text: '2026-T-1', value: null }] });
  try {
    dashboardService.peekCachedItems = () => ({ items: [raw(IDX['Internal Review'])], at: Date.now(), version: 1 });
    const expected = dashboardService.parseItem(raw(IDX['Internal Review']), 0).views;
    let r = svc._io.rowFor(ITEM, STAFF);
    assert.equal(r.stageIdx, IDX['Internal Review']);
    assert.deepEqual(r.views, expected);
    assert.equal(r.waiting, null);
    process.env.TODO_TAB = 'on';
    r = svc._io.rowFor(ITEM, STAFF);
    assert.deepEqual(r.views, expected.includes('assigning') ? [...expected, 'todo'] : expected);
    assert.ok(expected.includes('assigning'), 'an open stage in a normal group is on Assigning');
    delete process.env.TODO_TAB;
    dashboardService.peekCachedItems = () => ({ items: [raw(IDX['Pre-Onboarding'])], at: Date.now(), version: 1 });
    r = svc._io.rowFor(ITEM, STAFF);
    assert.ok(r.waiting && typeof r.waiting.code === 'string', 'a Pre-Onboarding row gets its "waiting" (here: not checked yet)');
    let asked = null;
    dashboardService.peekCachedItems = (o) => { asked = o; return null; };
    assert.equal(svc._io.rowFor(ITEM, STAFF), null, 'nothing cached at all: null');
    assert.deepEqual(asked, { anyAge: true }, 'the row is rebuilt whatever the copy\'s age');
    dashboardService.peekCachedItems = () => ({ items: [], at: Date.now(), version: 1 });
    assert.equal(svc._io.rowFor(ITEM, STAFF), null);
  } finally {
    dashboardService.peekCachedItems = realPeek;
    delete process.env.TODO_TAB;
  }
});
