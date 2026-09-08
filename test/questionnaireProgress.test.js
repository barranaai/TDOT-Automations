'use strict';

// Questionnaire completion indicator (Gauri, 2026-09-04 meeting, point 01).
//
// Until 2026-09-08 the Client Master "Q Readiness" % and "Q Completion
// Status" were written only when the client clicked Submit, so every
// in-progress questionnaire read 0% / Not Started on the portal, the cockpit
// and the board; and a single-applicant submission below 100% stayed
// "Working on it" forever. These tests pin the new contract:
//   • every client save syncs progress to Monday (coalesced autosave,
//     debounced manual save), never downgrading a Done row, and never
//     writing over a submission that landed while the sync was in flight;
//   • ONE case-level formula (every member's saved file) feeds the board,
//     the portal, the cockpit and the reconcile; the page's own % is only the
//     fallback (a dual-form case renders each form on its own page);
//   • "Submitted" is decided by submission, not 100%; a single-member
//     submission is Done — but only when the manifest could be read;
//   • the stage gates additionally require a submitted questionnaire;
//   • the client engine counts only APPLICABLE fields (class-hidden
//     conditionals, mm-hidden sub-sections and non-applicable "(If
//     Accompanying)" sections are excluded) — exercised in a small fake DOM.
//
// Monday + OneDrive are stubbed by patching the shared module objects.

process.env.Q_PROGRESS_MANUAL_DEBOUNCE_MS = '0';   // manual saves write at once in tests

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');

const mondayApi = require('../src/services/mondayApi');
const oneDrive  = require('../src/services/oneDriveService');
const svc       = require('../src/services/htmlQuestionnaireService');
const portal    = require('../src/services/clientPortalService');
const { _internal: readiness } = require('../src/services/caseReadinessService');
const reconcile = require('../scripts/reconcile-q-progress');

const Q_READY  = 'numeric_mm0x9dea';
const Q_STATUS = 'color_mm0x9s08';

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

/** Monday stub: answers the status read with `status`, records every mutation. */
function mondayStub({ status = '', onRead } = {}) {
  const writes = [];
  const restore = stub(mondayApi, 'query', async (q, vars) => {
    if (/^\s*mutation/.test(q)) { writes.push({ q, vars }); return { change_multiple_column_values: { id: '1' }, create_update: { id: '2' } }; }
    if (onRead) await onRead();
    return { items: [{ column_values: [{ id: Q_STATUS, text: status }] }] };
  });
  return { writes, restore };
}
const colsOf = (w) => JSON.parse(w.vars.cols || w.vars.colValues);   // readiness names the variable colValues
const colWrite = (m) => m.writes.find((w) => /change_multiple_column_values/.test(w.q));

/** OneDrive stub serving a manifest + per-form JSON files by filename. */
function oneDriveFiles(files) {
  const store = { ...files };
  const r1 = stub(oneDrive, 'readFile', async ({ filename }) => store[filename] ? Buffer.from(store[filename]) : null);
  const r2 = stub(oneDrive, 'uploadFile', async ({ filename, buffer }) => { store[filename] = buffer.toString('utf8'); });
  const r3 = stub(oneDrive, 'ensureClientFolder', async () => {});
  return () => { r1(); r2(); r3(); };
}
const manifest = (members) => JSON.stringify({ members });
const formJson = (pct, fields) => JSON.stringify({ completionPct: pct, fields: fields || [{ section: 'Profile', label: 'Family Name', key: 'k', value: 'Kaur' }] });
const noResolve = () => stub(svc, 'resolveCasePct', async ({ fallbackPct }) => ({ pct: Math.round(fallbackPct), submitted: null, derived: false }));

// ─── deriveQuestionnaireProgress: what the portal + cockpit show ─────────────

test('derive: prefill-only seed is Not Started (the client has not started)', () => {
  const r = svc.deriveQuestionnaireProgress({ members: [{ key: 'primary', hasData: false, completionPct: 0, submittedAt: '' }], mondayPct: 0 });
  assert.deepEqual([r.pct, r.label, r.submitted], [0, 'Not Started', false]);
});

test('derive: saved answers → In Progress with the stored % even when Monday still says 0', () => {
  const r = svc.deriveQuestionnaireProgress({ members: [{ key: 'primary', hasData: true, completionPct: 64, submittedAt: '' }], mondayPct: 0 });
  assert.deepEqual([r.pct, r.label, r.submitted], [64, 'In Progress', false]);
});

test('derive: every member submitted at 89% is Submitted — submission decides, not 100%', () => {
  const r = svc.deriveQuestionnaireProgress({ members: [{ key: 'primary', hasData: true, completionPct: 89, submittedAt: '2026-09-01T00:30:00Z' }], mondayPct: 89 });
  assert.deepEqual([r.pct, r.label, r.submitted], [89, 'Submitted', true]);
});

test('derive: multi-member averages the members; one unsubmitted member keeps it In Progress', () => {
  const r = svc.deriveQuestionnaireProgress({ members: [
    { key: 'primary', hasData: true, completionPct: 100, submittedAt: '2026-09-01' },
    { key: 'spouse',  hasData: true, completionPct: 40,  submittedAt: '' },
  ], mondayPct: 100 });
  assert.deepEqual([r.pct, r.label, r.submitted], [70, 'In Progress', false]);
});

test('derive: answers only in the ADDITIONAL form still count as started (dual-form case)', () => {
  const r = svc.deriveQuestionnaireProgress({ members: [{ key: 'primary', hasData: false, hasAdditionalData: true, completionPct: 10, submittedAt: '' }], mondayPct: 0 });
  assert.deepEqual([r.pct, r.label], [10, 'In Progress']);
});

test('derive: files unreadable (no data) → falls back to the Monday number', () => {
  const r = svc.deriveQuestionnaireProgress({ members: [{ key: 'primary', hasData: false, completionPct: 0, submittedAt: '' }], mondayPct: 55 });
  assert.deepEqual([r.pct, r.label], [55, 'In Progress']);
  assert.equal(svc.deriveQuestionnaireProgress({ members: [], mondayPct: 0 }).label, 'Not Started');
});

// ─── getMemberStatuses: prefill is not "started"; completion % travels ───────

test('getMemberStatuses: a DCS pre-fill seed is not client data; the stored % is returned', async () => {
  const restore = oneDriveFiles({
    'questionnaire-2026-SP-001-primary.json': formJson(0, [{ section: 'Pre-filled from intake', label: 'Email', key: 'prefill__email', value: 'a@b.c', source: 'prefill' }]),
    'questionnaire-2026-SP-002-primary.json': formJson(42, [
      { section: 'Pre-filled from intake', label: 'Email', key: 'prefill__email', value: 'a@b.c', source: 'prefill' },
      { section: 'Profile', label: 'Family Name', key: 'profile-family-name', value: 'Kaur' },
    ]),
  });
  try {
    const seeded = await svc.getMemberStatuses({ clientName: 'X', caseRef: '2026-SP-001', members: [{ key: 'primary', label: 'Primary Applicant' }], formFiles: { primary: 'f.html' } });
    assert.equal(seeded[0].hasData, false);
    assert.equal(seeded[0].status, 'Not Started');
    const started = await svc.getMemberStatuses({ clientName: 'X', caseRef: '2026-SP-002', members: [{ key: 'primary', label: 'Primary Applicant' }], formFiles: { primary: 'f.html' } });
    assert.equal(started[0].hasData, true);
    assert.equal(started[0].status, 'In Progress');
    assert.equal(started[0].completionPct, 42);
  } finally { restore(); }
});

test('getMemberStatuses: a dual-form member averages both files only once the additional form is started', async () => {
  const restore = oneDriveFiles({
    'questionnaire-2026-OINP-900-primary.json': formJson(90),
    'questionnaire-2026-OINP-903-primary.json': formJson(90),
    'questionnaire-2026-OINP-903-primary-additional.json': formJson(20),
  });
  try {
    const unopened = await svc.getMemberStatuses({ clientName: 'X', caseRef: '2026-OINP-900', members: [{ key: 'primary', label: 'Primary Applicant' }], formFiles: { primary: 'F6.html', additional: 'F1.html' } });
    assert.equal(unopened[0].completionPct, 90, 'an additional form with no answers is not applicable yet — never halves the number');
    assert.equal(unopened[0].hasAdditionalData, false);
    const started = await svc.getMemberStatuses({ clientName: 'X', caseRef: '2026-OINP-903', members: [{ key: 'primary', label: 'Primary Applicant' }], formFiles: { primary: 'F6.html', additional: 'F1.html' } });
    assert.equal(started[0].completionPct, 55);
    assert.equal(started[0].hasAdditionalData, true);
  } finally { restore(); }
});

test('getMemberStatuses: a transient storage failure throws (never reads as "no answers")', async () => {
  const restore = stub(oneDrive, 'readFile', async () => { throw new Error('Graph 429'); });
  try {
    await assert.rejects(() => svc.getMemberStatuses({ clientName: 'X', caseRef: '2026-SP-003', members: [{ key: 'primary' }], formFiles: {} }), /Graph 429/);
  } finally { restore(); }
});

// ─── resolveCasePct: ONE formula for the board ───────────────────────────────

test('resolveCasePct: dual-form case — the board gets the case-level %, not the page that saved last', async () => {
  const restore = oneDriveFiles({
    'questionnaire-members-2026-OINP-901.json': manifest([{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }]),
    'questionnaire-2026-OINP-901-primary.json': formJson(90),
    'questionnaire-2026-OINP-901-primary-additional.json': formJson(20),
  });
  try {
    const r = await svc.resolveCasePct({ clientName: 'X', caseRef: '2026-OINP-901', formFiles: { primary: 'F6.html', additional: 'F1.html' }, fallbackPct: 20 });
    assert.deepEqual([r.pct, r.derived, r.submitted], [55, true, false]);
  } finally { restore(); }
});

test('resolveCasePct: files unreadable → the page\'s own % is the fallback', async () => {
  const restore = stub(oneDrive, 'readFile', async () => { throw new Error('Graph 503'); });
  try {
    const r = await svc.resolveCasePct({ clientName: 'X', caseRef: '2026-SP-004', formFiles: { primary: 'f.html' }, fallbackPct: 37.4 });
    assert.deepEqual([r.pct, r.derived], [37, false]);
  } finally { restore(); }
});

// ─── syncProgressToMonday: every save reaches the board ──────────────────────

test('progress sync: a manual save writes the derived % + "Working on it"', async () => {
  svc._resetProgressSync();
  const m = mondayStub({ status: '' });
  const rr = stub(svc, 'resolveCasePct', async () => ({ pct: 55, submitted: false, derived: true }));
  try {
    await svc.syncProgressToMonday({ itemId: '101', caseRef: '2026-SP-010', clientName: 'X', formFiles: {}, pct: 20, immediate: true });
    assert.equal(m.writes.length, 1);
    assert.deepEqual(colsOf(m.writes[0]), { [Q_READY]: 55, [Q_STATUS]: { label: 'Working on it' } });
  } finally { rr(); m.restore(); }
});

test('progress sync: a Done row keeps Done — only the % follows the answers', async () => {
  svc._resetProgressSync();
  const m = mondayStub({ status: 'Done' });
  const rr = noResolve();
  try {
    await svc.syncProgressToMonday({ itemId: '102', caseRef: '2026-SP-011', pct: 91, immediate: true });
    assert.deepEqual(colsOf(m.writes[0]), { [Q_READY]: 91 });
  } finally { rr(); m.restore(); }
});

test('progress sync: autosaves are coalesced — one window, latest state wins; a manual save flushes it', async () => {
  svc._resetProgressSync();
  const calls = [];
  const restore = stub(svc, 'writeProgressToMonday', async (p) => { calls.push(p.pct); });
  try {
    await svc.syncProgressToMonday({ itemId: '103', caseRef: '2026-SP-012', pct: 10 });   // opens the window
    await svc.syncProgressToMonday({ itemId: '103', caseRef: '2026-SP-012', pct: 20 });   // refreshes it
    assert.deepEqual(calls, [], 'nothing written inside the window');
    await svc.syncProgressToMonday({ itemId: '103', caseRef: '2026-SP-012', pct: 25, immediate: true });
    assert.deepEqual(calls, [25], 'the manual save flushed once with the latest %');
    await svc.syncProgressToMonday({ itemId: '103', caseRef: '2026-SP-012', pct: 30 });
    assert.deepEqual(calls, [25], 'the flushed window is gone; a new autosave opens a fresh one');
    assert.equal(svc.cancelProgressSync('103'), true);
  } finally { restore(); svc._resetProgressSync(); }
});

test('progress sync: never throws and never blocks the save (Monday failure is logged only)', async () => {
  svc._resetProgressSync();
  const rr = noResolve();
  const restore = stub(mondayApi, 'query', async () => { throw new Error('monday down'); });
  const warn = console.warn; let warned = '';
  console.warn = (s) => { warned += s; };
  try {
    await svc.syncProgressToMonday({ itemId: '104', caseRef: '2026-SP-013', pct: 50, immediate: true });
    assert.match(warned, /progress sync failed/);
    await svc.syncProgressToMonday({ itemId: '', caseRef: '2026-SP-013', pct: 50, immediate: true });   // no item → no-op
  } finally { restore(); rr(); console.warn = warn; }
});

test('progress sync: a submission that lands mid-flight wins — the stale write is skipped', async () => {
  svc._resetProgressSync();
  const rr = noResolve();
  // The status READ returns only after a submission was recorded for the item.
  const m = mondayStub({ status: '', onRead: async () => svc.noteSubmission('105') });
  try {
    await svc.syncProgressToMonday({ itemId: '105', caseRef: '2026-SP-014', pct: 70, immediate: true });
    assert.equal(m.writes.length, 0, 'no mutation after the submission stamp changed');
  } finally { rr(); m.restore(); svc._resetProgressSync(); }
});

test('progress sync: flush writes every pending window (shutdown)', async () => {
  svc._resetProgressSync();
  const calls = [];
  const restore = stub(svc, 'writeProgressToMonday', async (p) => { calls.push(p.itemId + ':' + p.pct); });
  try {
    await svc.syncProgressToMonday({ itemId: '106', caseRef: 'A', pct: 10 });
    await svc.syncProgressToMonday({ itemId: '107', caseRef: 'B', pct: 20 });
    assert.equal(await svc.flushProgressSync(), 2);
    assert.deepEqual(calls.sort(), ['106:10', '107:20']);
    assert.equal(await svc.flushProgressSync(), 0);
  } finally { restore(); svc._resetProgressSync(); }
});

// ─── markSubmitted: a single-member submission is Done ───────────────────────

test('markSubmitted: single applicant submitting at 89% → Q Completion Status = Done', async () => {
  svc._resetProgressSync();
  const m = mondayStub();
  const restore = oneDriveFiles({ 'questionnaire-members-2026-VRE-999.json': manifest([{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }]) });
  try {
    await svc.markSubmitted({ itemId: '201', caseRef: '2026-VRE-999', caseType: 'Visitor Record / Extension', formKey: 'primary', formLabel: 'Visitor Visa Extension', completionPct: 89, clientName: 'Test', formFiles: { primary: 'F12.html' } });
    assert.deepEqual(colsOf(colWrite(m)), { [Q_READY]: 89, [Q_STATUS]: { label: 'Done' } });
  } finally { restore(); m.restore(); }
});

test('markSubmitted: the board % is the case-level formula (both forms of a dual-form case)', async () => {
  svc._resetProgressSync();
  const m = mondayStub();
  const restore = oneDriveFiles({
    'questionnaire-members-2026-OINP-902.json': manifest([{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }]),
    'questionnaire-2026-OINP-902-primary.json': formJson(90),
    'questionnaire-2026-OINP-902-primary-additional.json': formJson(20),
  });
  try {
    await svc.markSubmitted({ itemId: '204', caseRef: '2026-OINP-902', caseType: 'OINP', formKey: 'primary', formLabel: 'F6', completionPct: 90, clientName: 'Test', formFiles: { primary: 'F6.html', additional: 'F1.html' } });
    assert.deepEqual(colsOf(colWrite(m)), { [Q_READY]: 55, [Q_STATUS]: { label: 'Done' } });
  } finally { restore(); m.restore(); }
});

test('markSubmitted: multi-member with one member still open stays "Working on it" and fires no stage gate', async () => {
  svc._resetProgressSync();
  const stageGate = require('../src/services/stageGateService');
  let gateFired = 0;
  const rg = stub(stageGate, 'onThresholdMet', async () => { gateFired++; });
  // Monday: status read + a stage read that WOULD pass the % gate.
  const writes = [];
  const rm = stub(mondayApi, 'query', async (q, vars) => {
    if (/^\s*mutation/.test(q)) { writes.push({ q, vars }); return {}; }
    return { items: [{ column_values: [
      { id: Q_STATUS, text: '' }, { id: 'color_mm0x8faa', text: 'Document Collection Started' },
      { id: 'numeric_mm0x5g9x', text: '100' }, { id: 'numeric_mm0xje6p', text: '0' }, { id: 'color_mm0x3x1x', text: 'No' },
    ] }] };
  });
  const restore = oneDriveFiles({
    'questionnaire-members-2026-SPE-999.json': manifest([
      { key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' },
      { key: 'spouse',  type: 'Spouse / Common-Law Partner', label: 'Spouse' },
    ]),
    'questionnaire-2026-SPE-999-primary.json': formJson(95),
    'questionnaire-2026-SPE-999-spouse.json': formJson(100),
  });
  try {
    await svc.markSubmitted({ itemId: '202', caseRef: '2026-SPE-999', caseType: 'Spousal Sponsorship', formKey: 'primary', formLabel: 'Spousal', completionPct: 95, clientName: 'Test', formFiles: { primary: 'F10.html' } });
    const w = writes.find((x) => /change_multiple_column_values/.test(x.q));
    assert.deepEqual(colsOf(w), { [Q_READY]: 98, [Q_STATUS]: { label: 'Working on it' } });
    await new Promise((r) => setTimeout(r, 20));   // the gate check is fire-and-forget
    assert.equal(gateFired, 0, 'a partial submission never advances the case');
  } finally { restore(); rm(); rg(); }
});

test('markSubmitted: a transient manifest failure is surfaced (503 → client retries), never acknowledged as submitted', async () => {
  svc._resetProgressSync();
  const m = mondayStub();
  const restore = stub(oneDrive, 'readFile', async () => { throw new Error('Graph 503'); });
  try {
    await assert.rejects(
      () => svc.markSubmitted({ itemId: '205', caseRef: '2026-SP-905', caseType: 'Study Permit', formKey: 'primary', formLabel: 'SP', completionPct: 90, clientName: 'Test', formFiles: { primary: 'F7.html' } }),
      (err) => err.transient === true,
    );
    assert.equal(m.writes.length, 0, 'nothing written to the board, no "Submitted" audit comment');
  } finally { restore(); m.restore(); }
});

test('markSubmitted: a pending pre-submit autosave is cancelled, so it cannot land after the final write', async () => {
  svc._resetProgressSync();
  const calls = [];
  const rw = stub(svc, 'writeProgressToMonday', async (p) => { calls.push(p.pct); });
  const m  = mondayStub();
  const restore = oneDriveFiles({ 'questionnaire-members-2026-SP-020.json': manifest([{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }]) });
  try {
    await svc.syncProgressToMonday({ itemId: '203', caseRef: '2026-SP-020', pct: 70 });   // autosave window open (70%)
    await svc.markSubmitted({ itemId: '203', caseRef: '2026-SP-020', caseType: 'Study Permit', formKey: 'primary', formLabel: 'SP', completionPct: 88, clientName: 'Test', formFiles: { primary: 'F7.html' } });
    assert.equal(svc.cancelProgressSync('203'), false, 'submit already dropped the pending window');
    assert.deepEqual(calls, [], 'the stale 70% never reaches the board');
    assert.deepEqual(colsOf(colWrite(m)), { [Q_READY]: 88, [Q_STATUS]: { label: 'Done' } });
  } finally { restore(); m.restore(); rw(); svc._resetProgressSync(); }
});

// ─── Stage gates: a high in-progress % never advances a case ────────────────

test('readiness gate: threshold needs a SUBMITTED questionnaire, not just a high %', async () => {
  const m = mondayStub();
  try {
    const docs = { readinessPct: 100, uploadedPct: 100, blockingCount: 0, missingRequired: 0 };
    // Never submitted, above threshold → not ready, and the board says so.
    const draft = await readiness.writeToCaseMaster('301', { blockingCount: 0 }, docs, 80, 100, false, '');
    assert.equal(draft.thresholdMet, false);
    assert.equal(draft.fullyComplete, false);
    assert.deepEqual(colsOf(m.writes[0])['color_mm0xh2fh'], { label: 'Working on it' });
    assert.deepEqual(colsOf(m.writes[0])['color_mm0xvxq2'], { label: 'No' });
    // The one transition left alone: the row ALREADY reads Ready = Done and only
    // the submission mark lags (a pre-reconcile submitted row) → no downgrade.
    const lagging = await readiness.writeToCaseMaster('301', { blockingCount: 0 }, docs, 80, 100, false, 'Done');
    assert.equal(lagging.thresholdMet, false);
    assert.equal(colsOf(m.writes[1])['color_mm0xh2fh'], undefined);
    assert.equal(colsOf(m.writes[1])['color_mm0xvxq2'], undefined);
    const submitted = await readiness.writeToCaseMaster('301', { blockingCount: 0 }, docs, 80, 100, true, 'Working on it');
    assert.equal(submitted.thresholdMet, true);
    assert.equal(submitted.fullyComplete, true);
    assert.deepEqual(colsOf(m.writes[2])['color_mm0xh2fh'], { label: 'Done' });
    // A genuine % shortfall writes Working/No, whatever the row read before.
    const low = await readiness.writeToCaseMaster('301', { blockingCount: 0 }, { ...docs, readinessPct: 40 }, 80, 100, false, 'Done');
    assert.equal(low.thresholdMet, false);
    assert.deepEqual(colsOf(m.writes[3])['color_mm0xh2fh'], { label: 'Working on it' });
  } finally { m.restore(); }
});

// ─── Portal card: what staff and the client see ──────────────────────────────

function snap(extra) {
  return Object.assign({
    clientName: 'Loveleen Kaur', caseRef: '2026-OINP-041', caseType: 'OINP', caseSubType: null,
    caseStage: 'Internal Review', accessToken: 'tok',
    qReadinessPct: 0, qSubmitted: false, qLabel: 'Not Started', qUnavailable: false,
    docCounts: { total: 3, received: 0, reviewed: 0, rework: 0, missing: 3 }, docItems: [],
    totalMembers: 1, submittedMembers: 0,
    journey: portal.clientStage('Internal Review'), timeline: [], payments: null,
  }, extra || {});
}

test('portal: in-progress answers show the real % and "In Progress" (no more 0% / Not Started)', () => {
  const html = portal.buildPortalPage(snap({ qReadinessPct: 64, qLabel: 'In Progress' }), { mode: 'staff' });
  assert.ok(html.includes('Questionnaire is 64% complete'));
  assert.ok(html.includes('>In Progress<'));
  assert.ok(!html.includes('>Not Started<'));
});

test('portal: started but rounding to 0% — label, badge colour and button agree ("In Progress", Continue Filling)', () => {
  const html = portal.buildPortalPage(snap({ qReadinessPct: 0, qLabel: 'In Progress' }), { mode: 'client' });
  assert.ok(html.includes('badge-prog">In Progress<'));
  assert.ok(html.includes('Continue Filling'));
  assert.ok(!html.includes('Start Questionnaire'));
});

test('portal: submitted at 89% reads "Submitted" — and no "still has fields to finish" line', () => {
  const html = portal.buildPortalPage(snap({ qReadinessPct: 89, qSubmitted: true, qLabel: 'Submitted', submittedMembers: 1 }), { mode: 'staff' });
  assert.ok(html.includes('>Submitted<'));
  assert.ok(!html.includes('still has fields to finish'));
});

test('portal: 100% filled but never submitted tells the client to click Submit — unless the files could not be read', () => {
  const html = portal.buildPortalPage(snap({ qReadinessPct: 100, qSubmitted: false, qLabel: 'In Progress' }), { mode: 'client' });
  assert.ok(html.includes('please open it and click Submit'));
  const blip = portal.buildPortalPage(snap({ qReadinessPct: 100, qSubmitted: false, qLabel: 'In Progress', qUnavailable: true }), { mode: 'client' });
  assert.ok(!blip.includes('click Submit'), 'a storage blip never nudges a client to re-submit');
});

function portalStubs({ status = '', mondayPct = '', memberStatuses }) {
  const docSvc  = require('../src/services/documentFormService');
  const cockpit = require('../src/services/caseCockpitService');
  return [
    stub(mondayApi, 'query', async () => ({ items: [{ column_values: [
      { id: 'color_mm0x8faa', text: 'Internal Review' }, { id: Q_READY, text: mondayPct }, { id: Q_STATUS, text: status },
    ] }] })),
    stub(docSvc, 'getCaseSummary', async () => ({ items: [] })),
    stub(cockpit, 'getLeadExtras', async () => ({ lead: null, payments: null })),
    stub(svc, 'loadMembers', async () => [{ key: 'primary', label: 'Primary Applicant', submittedAt: '' }]),
    stub(svc, 'getMemberStatuses', memberStatuses),
  ];
}
const vc = { itemId: '1', clientName: 'Loveleen Kaur', caseType: 'OINP', caseSubType: null, accessToken: 'tok', formFiles: { primary: 'f.html' } };

test('portal snapshot: reads the saved answers; a blank Monday number no longer means 0%', async () => {
  const restore = portalStubs({ memberStatuses: async ({ members }) => members.map((m) => ({ ...m, status: 'In Progress', hasData: true, completionPct: 64 })) });
  try {
    const s = await portal.getPortalSnapshot({ caseRef: '2026-OINP-041', validatedCase: vc });
    assert.deepEqual([s.qReadinessPct, s.qLabel, s.qSubmitted, s.qUnavailable], [64, 'In Progress', false, false]);
  } finally { restore.reverse().forEach((r) => r()); }
});

test('portal snapshot: storage failure → Monday number, flagged unavailable (never a fabricated 0)', async () => {
  const restore = portalStubs({ mondayPct: '55', memberStatuses: async () => { throw new Error('Graph 503'); } });
  try {
    const s = await portal.getPortalSnapshot({ caseRef: '2026-OINP-041', validatedCase: vc });
    assert.deepEqual([s.qReadinessPct, s.qUnavailable], [55, true]);
  } finally { restore.reverse().forEach((r) => r()); }
});

test('portal snapshot: the board saying Done counts as submitted even when the manifest carries no stamp', async () => {
  const restore = portalStubs({ status: 'Done', mondayPct: '100', memberStatuses: async ({ members }) => members.map((m) => ({ ...m, status: 'In Progress', hasData: true, completionPct: 100 })) });
  try {
    const s = await portal.getPortalSnapshot({ caseRef: '2026-OINP-041', validatedCase: vc });
    assert.deepEqual([s.qSubmitted, s.qLabel], [true, 'Submitted']);
    const html = portal.buildPortalPage(s, { mode: 'client' });
    assert.ok(!html.includes('click Submit'));
  } finally { restore.reverse().forEach((r) => r()); }
});

// ─── Cockpit: same derivation as the portal ──────────────────────────────────

test('cockpit: qReadinessPct comes from the saved answers, Monday only as the fallback', async () => {
  const cockpit = require('../src/services/caseCockpitService');
  const docSvc  = require('../src/services/documentFormService');
  const composition = require('../src/services/compositionAdapter');
  const restore = [
    stub(svc, 'validateAccessForStaff', async () => ({ itemId: '9', clientName: 'X', caseType: 'OINP', caseSubType: null, accessToken: 't', formFiles: { primary: 'f.html' } })),
    stub(mondayApi, 'query', async () => ({ items: [{ column_values: [{ id: Q_READY, text: '' }, { id: 'color_mm0x8faa', text: 'Internal Review' }] }] })),
    stub(docSvc, 'getCaseSummary', async () => ({ items: [] })),
    stub(composition, 'readForCase', async () => ({ members: [] })),
    stub(svc, 'loadMembers', async () => [{ key: 'primary', label: 'Primary Applicant', submittedAt: '' }]),
    stub(svc, 'getMemberStatuses', async ({ members }) => members.map((m) => ({ ...m, status: 'In Progress', hasData: true, completionPct: 64 }))),
    stub(cockpit, 'getLeadExtras', async () => ({ lead: null, payments: null })),
  ];
  try {
    const o = await cockpit.getCaseOverview('2026-OINP-041');
    assert.equal(o.qReadinessPct, 64);
    restore.push(stub(svc, 'getMemberStatuses', async () => { throw new Error('Graph 503'); }));
    restore.push(stub(mondayApi, 'query', async () => ({ items: [{ column_values: [{ id: Q_READY, text: '55' }, { id: 'color_mm0x8faa', text: 'Internal Review' }] }] })));
    const o2 = await cockpit.getCaseOverview('2026-OINP-041');
    assert.equal(o2.qReadinessPct, 55);
  } finally { restore.reverse().forEach((r) => r()); }
});

// ─── Reconcile: the decision table (pure) ────────────────────────────────────

test('reconcile decide(): the plan-F rules, including partial multi-member and the % -only case', () => {
  const p = (over) => ({ members: [{ key: 'primary', label: 'Primary Applicant', hasData: true, completionPct: 64, submittedAt: '' }], pct: 64, label: 'In Progress', submitted: false, ...over });
  const S = reconcile.Q_STATUS_COL, R = reconcile.Q_READY_COL;
  assert.equal(reconcile.decide({ status: 'Done', pct: '89' }, p({ submitted: true })).action, 'skip');
  assert.deepEqual(reconcile.decide({ status: 'Working on it', pct: '89' }, p({ submitted: true })).cols, { [S]: { label: 'Done' } });
  assert.deepEqual(reconcile.decide({ status: '', pct: '' }, p({ submitted: true })).cols, { [S]: { label: 'Done' }, [R]: 64 });
  assert.deepEqual(reconcile.decide({ status: '', pct: '' }, p()).cols, { [S]: { label: 'Working on it' }, [R]: 64 });
  assert.deepEqual(reconcile.decide({ status: 'Working on it', pct: '' }, p()).cols, { [R]: 64 });
  assert.equal(reconcile.decide({ status: 'Working on it', pct: '60' }, p()).action, 'skip');
  assert.equal(reconcile.decide({ status: '', pct: '' }, p({ members: [{ hasData: false, completionPct: 0 }] })).why, 'no client answers saved');
  assert.equal(reconcile.decide({ status: '', pct: '' }, p({ members: [{ hasData: false, hasAdditionalData: true, completionPct: 10 }], pct: 10 })).action, 'working');
  assert.equal(reconcile.decide({ status: '', pct: '' }, { error: 'HTTP 503' }).action, 'skip');
  assert.equal(reconcile.decide({ status: '', pct: '' }, { members: 'nope' }).action, 'skip', 'an unexpected response shape is never acted on');
  assert.equal(reconcile.refOk('2026_SP_015'), true);
  assert.equal(reconcile.refOk('20 26'), false);
  assert.match(reconcile.auditBody({ caseRef: 'X', status: 'Working on it' }, { action: 'done', cols: {} }, p({ submitted: true }), '2026-09-08'), /single-applicant/);
  assert.doesNotMatch(reconcile.auditBody({ caseRef: 'X', status: '' }, { action: 'done', cols: {} }, p({ submitted: true, members: [{}, {}] }), '2026-09-08'), /single-applicant/);
});

// ─── The client engine in a fake DOM: only APPLICABLE fields count ───────────

function fakeDom() {
  class El {
    constructor(tag, opts = {}) {
      this.tag = tag; this.classes = new Set(opts.cls || []); this.attrs = opts.attrs || {};
      this.style = { display: opts.display || '' }; this.children = []; this.parentElement = null;
      this.text = opts.text || ''; this.value = opts.value == null ? '' : opts.value; this.checked = !!opts.checked;
      this.classList = { contains: (c) => this.classes.has(c) };
    }
    add(child) { child.parentElement = this; this.children.push(child); return child; }
    getAttribute(n) { return n === 'type' ? (this.attrs.type || null) : (this.attrs[n] == null ? null : this.attrs[n]); }
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
    _matches(sel) { sel = sel.trim(); return sel.startsWith('.') ? this.classes.has(sel.slice(1)) : this.tag === sel; }
    _all(out) { for (const c of this.children) { out.push(c); c._all(out); } return out; }
    querySelectorAll(sel) { const parts = sel.split(','); return this._all([]).filter((e) => parts.some((p) => e._matches(p))); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { const parts = sel.split(','); let n = this; while (n) { if (parts.some((p) => n._matches(p))) return n; n = n.parentElement; } return null; }
    contains(el) { let n = el; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
  }
  const body = new El('body');
  const document = { body, querySelectorAll: (s) => body.querySelectorAll(s), querySelector: (s) => body.querySelector(s) };
  // Stylesheet the forms ship: class-hidden wrappers open with .open / .visible; collapsed accordion bodies are display:none.
  const css = (n) => {
    if (n.style.display) return n.style.display;
    const hiddenUnlessOpen = ['conditional-block', 'refusal-block', 'top-accordion-body', 'sub-accordion-body'];
    if (hiddenUnlessOpen.some((c) => n.classes.has(c)) && !n.classes.has('open')) return 'none';
    if (n.classes.has('conditional') && !n.classes.has('visible')) return 'none';
    return 'block';
  };
  const window = { getComputedStyle: (n) => ({ display: css(n) }) };
  return { El, body, document, window };
}

function engineHelpers(dom) {
  const src = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');
  const start = src.indexOf('  var CONDITIONAL_CLASSES');
  const fnStart = src.indexOf('function isExcludedFromProgress', start);
  const end = src.indexOf('\n  }\n', src.indexOf('return false;', fnStart)) + 4;
  assert.ok(start > 0 && fnStart > start && end > fnStart, 'engine helpers located in the template literal');
  const raw = src.slice(start, end);
  assert.ok(!raw.includes('`') && !raw.includes('${'), 'the slice is plain template text');
  // Evaluate with REAL template-literal semantics — exactly what the browser receives —
  // so a lone backslash that would corrupt the emitted regex breaks this harness too.
  const code = new Function('return `' + raw + '`')();
  return vm.runInNewContext(code + '\n;({ hasRealValue, isHiddenConditional, findOptionalSections, isExcludedFromProgress })', { document: dom.document, window: dom.window });
}

test('engine: class-hidden conditional blocks (F12/F13 style) are excluded; opened ones count', () => {
  const dom = fakeDom(); const { El, body } = dom; const h = engineHelpers(dom);
  const hiddenBlock = body.add(new El('div', { cls: ['conditional-block'] }));
  const hiddenInput = hiddenBlock.add(new El('input'));
  const openBlock = body.add(new El('div', { cls: ['conditional-block', 'open'] }));
  const openInput = openBlock.add(new El('input'));
  const refusal = body.add(new El('div', { cls: ['refusal-block'] }));
  const refusalInput = refusal.add(new El('input'));
  assert.equal(h.isExcludedFromProgress(hiddenInput, []), true);
  assert.equal(h.isExcludedFromProgress(openInput, []), false);
  assert.equal(h.isExcludedFromProgress(refusalInput, []), true, '.refusal-block joins the conditional wrappers');
});

test('engine: inline-hidden .conditional (F19 style) excluded; .visible counts; collapsed accordions never change the count', () => {
  const dom = fakeDom(); const { El, body } = dom; const h = engineHelpers(dom);
  const inl = body.add(new El('div', { cls: ['conditional'], display: 'none' }));
  const inlInput = inl.add(new El('input'));
  const vis = body.add(new El('div', { cls: ['conditional', 'visible'] }));
  const visInput = vis.add(new El('input'));
  const acc = body.add(new El('div', { cls: ['top-accordion'] }));
  acc.add(new El('div', { cls: ['top-accordion-header'], text: 'Main Applicant' }));
  const accBody = acc.add(new El('div', { cls: ['top-accordion-body'] }));   // collapsed: computed display none
  const inCollapsed = accBody.add(new El('div', { cls: ['form-group'] })).add(new El('input'));
  const mm = body.add(new El('div', { attrs: { 'data-mm-hidden': 'true' } }));
  const mmInput = mm.add(new El('input'));
  assert.equal(h.isExcludedFromProgress(inlInput, h.findOptionalSections()), true);
  assert.equal(h.isExcludedFromProgress(visInput, h.findOptionalSections()), false);
  assert.equal(h.isExcludedFromProgress(inCollapsed, h.findOptionalSections()), false, 'folding a section is not "not applicable"');
  assert.equal(h.isExcludedFromProgress(mmInput, []), true);
});

function accompanyingForm(dom, { label, answer, filled }) {
  const { El, body } = dom;
  const main = body.add(new El('div', { cls: ['top-accordion'] }));
  main.add(new El('div', { cls: ['top-accordion-header'], text: 'Main Applicant' }));
  const grp = main.add(new El('div', { cls: ['top-accordion-body', 'open'] })).add(new El('div', { cls: ['form-group'] }));
  grp.add(new El('label', { text: label }));
  grp.add(new El('select', { value: answer }));
  const dep = body.add(new El('div', { cls: ['top-accordion'] }));
  dep.add(new El('div', { cls: ['top-accordion-header'], text: 'Dependent (If Accompanying)' }));
  const depInput = dep.add(new El('div', { cls: ['top-accordion-body'] })).add(new El('div', { cls: ['form-group'] })).add(new El('input', { value: filled ? 'Aman' : '' }));
  return depInput;
}

test('engine: "(If Accompanying)" section counts only when it applies — a filled field, or Yes to either label wording', () => {
  for (const label of ['Accompanying the application? (If yes, please provide details in dependent section)',      // F19:246
                       'Accompany to the Application? (If yes, please provide details in dependent section)']) {   // F6:239
    let dom = fakeDom(); let h = engineHelpers(dom);
    let depInput = accompanyingForm(dom, { label, answer: '', filled: false });
    assert.equal(h.isExcludedFromProgress(depInput, h.findOptionalSections()), true, 'unanswered + empty → not applicable');
    dom = fakeDom(); h = engineHelpers(dom);
    depInput = accompanyingForm(dom, { label, answer: 'No', filled: false });
    assert.equal(h.isExcludedFromProgress(depInput, h.findOptionalSections()), true, 'No + empty → not applicable');
    dom = fakeDom(); h = engineHelpers(dom);
    depInput = accompanyingForm(dom, { label, answer: 'Yes', filled: false });
    assert.equal(h.isExcludedFromProgress(depInput, h.findOptionalSections()), false, `Yes → applicable (${label.slice(0, 24)})`);
    dom = fakeDom(); h = engineHelpers(dom);
    depInput = accompanyingForm(dom, { label, answer: '', filled: true });
    assert.equal(h.isExcludedFromProgress(depInput, h.findOptionalSections()), false, 'anything typed → applicable');
  }
});

test('engine: hasRealValue ignores select placeholders and unchecked radios', () => {
  const dom = fakeDom(); const { El } = dom; const h = engineHelpers(dom);
  assert.equal(h.hasRealValue(new El('select', { value: '-- Select --' })), false);
  assert.equal(h.hasRealValue(new El('select', { value: 'Yes' })), true);
  assert.equal(h.hasRealValue(new El('input', { attrs: { type: 'radio' }, value: 'yes', checked: false })), false);
  assert.equal(h.hasRealValue(new El('input', { attrs: { type: 'radio' }, value: 'yes', checked: true })), true);
});

// ─── Ordering: sync and submit writes of one case never interleave ──────────

test('write lock: a submit that arrives while a sync is mid-flight lands LAST, so Done is what stays', async () => {
  svc._resetProgressSync();
  const order = [];
  const writes = [];
  let releaseSync;
  const syncDerive = new Promise((r) => { releaseSync = r; });
  // The sync's derivation stalls (slow OneDrive) until we release it.
  const rr = stub(svc, 'resolveCasePct', async ({ fallbackPct }) => { if (fallbackPct === 70) await syncDerive; return { pct: Math.round(fallbackPct), submitted: null, derived: false }; });
  const rm = stub(mondayApi, 'query', async (q, vars) => {
    if (/^\s*mutation/.test(q)) { if (vars.cols) { writes.push(JSON.parse(vars.cols)); order.push('write'); } return {}; }
    return { items: [{ column_values: [{ id: Q_STATUS, text: '' }] }] };
  });
  const restore = oneDriveFiles({ 'questionnaire-members-2026-SP-030.json': manifest([{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }]) });
  try {
    const sync = svc.syncProgressToMonday({ itemId: '301', caseRef: '2026-SP-030', pct: 70, immediate: true });   // holds the lock, stalled in derive
    const submit = svc.markSubmitted({ itemId: '301', caseRef: '2026-SP-030', caseType: 'Study Permit', formKey: 'primary', formLabel: 'SP', completionPct: 88, clientName: 'Test', formFiles: { primary: 'F7.html' } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(writes.length, 0, 'the submit is queued behind the in-flight sync, not racing it');
    releaseSync();
    await Promise.all([sync, submit]);
    // The stalled sync notices the submission recorded meanwhile and steps
    // aside; the submission's write is the only one — and the last.
    assert.deepEqual(writes, [{ [Q_READY]: 88, [Q_STATUS]: { label: 'Done' } }]);
    assert.equal(order.length, 1);
  } finally { restore(); rm(); rr(); svc._resetProgressSync(); }
});

test('write lock: a sync queued behind a submit sees the fresh Done and only updates the %', async () => {
  svc._resetProgressSync();
  const writes = [];
  let status = '';
  const rr = noResolve();
  const rm = stub(mondayApi, 'query', async (q, vars) => {
    if (/^\s*mutation/.test(q)) { if (vars.cols) { const c = JSON.parse(vars.cols); if (c[Q_STATUS]) status = c[Q_STATUS].label; writes.push(c); } return {}; }
    return { items: [{ column_values: [{ id: Q_STATUS, text: status }] }] };
  });
  const restore = oneDriveFiles({ 'questionnaire-members-2026-SP-031.json': manifest([{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }]) });
  try {
    // Whatever the interleaving, the submission's Done is the state that
    // stays: a sync racing it either steps aside or is ordered before it.
    const submit = svc.markSubmitted({ itemId: '302', caseRef: '2026-SP-031', caseType: 'Study Permit', formKey: 'primary', formLabel: 'SP', completionPct: 88, clientName: 'Test', formFiles: { primary: 'F7.html' } });
    const sync = svc.syncProgressToMonday({ itemId: '302', caseRef: '2026-SP-031', pct: 70, immediate: true });
    await Promise.all([submit, sync]);
    assert.deepEqual(writes[writes.length - 1], { [Q_READY]: 88, [Q_STATUS]: { label: 'Done' } }, 'Done is the last write');
    assert.equal(status, 'Done');
    // A LATER save (stamp captured after the submission) sees the fresh Done: % only.
    await svc.syncProgressToMonday({ itemId: '302', caseRef: '2026-SP-031', pct: 91, immediate: true });
    assert.deepEqual(writes[writes.length - 1], { [Q_READY]: 91 });
    assert.equal(status, 'Done');
  } finally { restore(); rm(); rr(); svc._resetProgressSync(); }
});

test('portal snapshot: board Done does not override a manifest that shows a later-added member still open', async () => {
  const restore = portalStubs({ status: 'Done', mondayPct: '100', memberStatuses: async () => [
    { key: 'primary', label: 'Primary Applicant', submittedAt: '2026-08-01', status: 'Submitted', hasData: true, completionPct: 100 },
    { key: 'child-1', label: 'Child 1', submittedAt: '', status: 'Not Started', hasData: false, completionPct: 0 },
  ] });
  try {
    const s = await portal.getPortalSnapshot({ caseRef: '2026-OINP-041', validatedCase: vc });
    assert.deepEqual([s.qSubmitted, s.qLabel], [false, 'In Progress']);
  } finally { restore.reverse().forEach((r) => r()); }
});

test('reconcile decide(): a legacy-format file (answers but no stored %) is left alone rather than stamped 0%', () => {
  const p = { members: [{ label: 'Primary Applicant', hasData: true, completionPct: 0, submittedAt: '' }], pct: 0, label: 'In Progress', submitted: false };
  const d = reconcile.decide({ status: '', pct: '' }, p);
  assert.equal(d.action, 'skip');
  assert.match(d.why, /legacy file format/);
});

// ─── The routes wire the sync (pinned by reading the route source) ───────────

test('pins: POST /q/:caseRef/save syncs progress fire-and-forget with the case context; submit paths pass formFiles', () => {
  const src = fs.readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm.js'), 'utf8');
  const save = src.slice(src.indexOf("router.post('/:caseRef/save'"), src.indexOf("router.post('/:caseRef/submit'"));
  assert.match(save, /svc\.syncProgressToMonday\(\{/);
  assert.match(save, /itemId, caseRef, clientName, formFiles,/);
  assert.match(save, /immediate: manual === true && manualSync !== false/);
  assert.ok(!/await svc\.syncProgressToMonday/.test(save), 'never awaited — a Monday hiccup cannot fail the save');
  assert.match(src, /svc\.markSubmitted\(\{[^}]*formFiles \}\)/);
  assert.match(src, /clientName, formFiles,\n\s+memberSubmissions,/);
});

test('pins: the client engine counts only applicable fields and sends the page % on every save', () => {
  const src = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');
  for (const needle of ['function isExcludedFromProgress', 'function findOptionalSections', "'refusal-block'", 'aggregatePct: aggPct', 'aggregatePct:    p.pct']) {
    assert.ok(src.includes(needle), `engine carries ${needle}`);
  }
  // The three counters share ONE exclusion rule — no private copies left behind.
  assert.equal((src.match(/isExcludedFromProgress\(f\.el, optionalSections\)/g) || []).length, 3);
});
