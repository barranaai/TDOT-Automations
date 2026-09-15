'use strict';

// Kept-aside answers (2026-09-16, case 2026-CEC-EE-077).
//
// A save rewrites the whole questionnaire file from the boxes on the page.
// When the page has no box for an answer the file holds — the April form
// served over August answers, a removed table row, a form edit — the answer
// used to vanish. It now moves to `setAside` in the same file. The save also
// keeps the file's era record when a page sends none (Submit sent none until
// 2026-09-16), reads before it writes (a storage failure fails the save
// instead of writing blind), and saves to one file run one at a time.

const test   = require('node:test');
const assert = require('node:assert/strict');

const svc      = require('../src/services/htmlQuestionnaireService');
const oneDrive = require('../src/services/oneDriveService');

const AUG1 = '1. Express Entry - PNP - PR Application -  Questionnaire - August 2026.html';
const APR1 = '1. Express Entry - PNP - PR Application -  Questionnaire - April 2025.html';

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

let N = 0;
function harness(initial, { uploadDelayMs = 0, uploadFailOnce = false } = {}) {
  const caseRef = `2026-SA-${String(++N).padStart(3, '0')}`;
  const filename = `questionnaire-${caseRef}-primary.json`;
  const store = {};
  if (initial !== undefined) store[filename] = typeof initial === 'string' ? initial : JSON.stringify(initial);
  const log = [];
  let failNext = uploadFailOnce;
  const restores = [
    stub(oneDrive, 'readFile', async (a) => { log.push('read'); return store[a.filename] != null ? Buffer.from(store[a.filename]) : null; }),
    stub(oneDrive, 'uploadFile', async (a) => {
      if (uploadDelayMs) await new Promise((r) => setTimeout(r, uploadDelayMs));
      if (failNext) { failNext = false; log.push('upload-failed'); throw new Error('Graph 500'); }
      log.push('upload'); store[a.filename] = a.buffer.toString('utf8');
    }),
    stub(oneDrive, 'ensureClientFolder', async () => {}),
  ];
  return {
    caseRef, store, log,
    save: (fields, formFile) => svc.saveFormData({ clientName: 'T', caseRef, itemId: '1', formKey: 'primary', fields, completionPct: 50, formFile }),
    written: () => JSON.parse(store[filename]),
    restore: () => restores.forEach((r) => r()),
  };
}

const ADDR_AUG = { section: 'Main Applicant › Section 2 — Family Information › Table', label: 'Current City & Country of Residence (Address with Postal Code) — Row 1', key: 'ma-tbl-living-r1-current-city-country-of-residence-address-with-postal-code', value: '10 Example Street' };
const NOC_AUG  = { section: 'Main Applicant › Section 5 — Personal History › Table', label: 'NOC Code (if known) — Row 1', key: 'ma-tbl-history-r1-noc-code-if-known', value: '62020' };
const NAME     = { section: 'Main Applicant › Personal Details', label: 'Given Name', key: 'ma-given-name', value: 'Dev' };
const ADDR_APR = { section: 'Main Applicant › Section 2 — Family Information › Table', label: 'Current City & Country of Residence — Row 1', key: 'ma-tbl-living-r1-current-city-country-of-residence', value: '' };

test('THE LOSS: the April form saved over August answers — answers it has no box for are kept aside', async () => {
  const h = harness({ formFile: AUG1, completionPct: 92, fields: [ADDR_AUG, NAME, NOC_AUG] });
  try {
    const incoming = [NAME, ADDR_APR];
    await h.save(incoming, APR1);
    const w = h.written();
    assert.deepEqual(w.fields, incoming, 'the page\'s answers are saved exactly as sent');
    assert.equal(w.formFile, APR1, 'the served era is recorded');
    assert.deepEqual(w.setAside.map((e) => [e.section, e.label, e.key, e.value, e.fromFormFile]), [
      [ADDR_AUG.section, ADDR_AUG.label, ADDR_AUG.key, '10 Example Street', AUG1],
      [NOC_AUG.section, NOC_AUG.label, NOC_AUG.key, '62020', AUG1],
    ]);
    for (const e of w.setAside) assert.ok(!Number.isNaN(Date.parse(e.setAsideAt)), 'timestamped');
  } finally { h.restore(); }
});

test('a box that is on the page but empty is the client\'s own edit — nothing is kept aside', async () => {
  const h = harness({ formFile: AUG1, fields: [{ section: 'S', label: 'City', key: 'a', value: 'Toronto' }] });
  try {
    await h.save([{ section: 'S', label: 'City', key: 'a', value: '' }], AUG1);
    const w = h.written();
    assert.equal(w.setAside, undefined);
    assert.equal(w.fields[0].value, '');
  } finally { h.restore(); }
});

test('intake pre-fill and the old statutory placeholder pairs are never kept aside', async () => {
  const h = harness({ formFile: AUG1, fields: [
    { section: 'Pre-filled from intake', label: 'Given Name', key: 'prefill__given-name', value: 'John', source: 'prefill' },
    { section: 'Statutory', label: '1 — Answer (Yes / No)', key: 'statutory-1-answer-yes-no', value: 'yes' },
    { section: 'Statutory', label: '1 — Answer (Yes / No)', key: 'statutory-1-answer-yes-no-2', value: 'no' },
  ] });
  try {
    await h.save([{ section: 'Personal', label: 'Given Name', key: 'ma-given-name', value: 'John' }], AUG1);
    assert.equal(h.written().setAside, undefined);
  } finally { h.restore(); }
});

test('kept-aside answers carry forward; one leaves only when it is back, word for word, in its own box', async () => {
  const T0 = '2026-09-14T03:04:55.988Z';
  const h = harness({ formFile: APR1, fields: [{ section: 'S', label: 'X', key: 'x', value: '' }], setAside: [
    { section: 'S', label: 'A', key: 'a', value: 'Alpha', setAsideAt: T0, fromFormFile: AUG1 },
    { section: 'S', label: 'B', key: 'b', value: 'Beta',  setAsideAt: T0, fromFormFile: AUG1 },
    { section: 'S', label: 'C', key: 'c', value: 'Gamma', setAsideAt: T0, fromFormFile: AUG1 },
  ] });
  try {
    await h.save([
      { section: 'S', label: 'X', key: 'x', value: '' },
      { section: 'S', label: 'A', key: 'a', value: ' Alpha ' },     // back in its box
      { section: 'S', label: 'B', key: 'b', value: 'Different' },   // box back, different answer — keep Beta
    ], AUG1);
    const w = h.written();
    assert.deepEqual(w.setAside.map((e) => [e.key, e.value, e.setAsideAt]), [['b', 'Beta', T0], ['c', 'Gamma', T0]]);
  } finally { h.restore(); }
});

test('the same answer dropped again is not duplicated; a different answer for the same box is kept too', () => {
  const T0 = '2026-09-14T00:00:00.000Z';
  const r1 = svc.computeSetAside({
    previousFields: [{ key: 'a', label: 'A', value: 'One' }],
    previousSetAside: [{ key: 'a', label: 'A', value: 'One', setAsideAt: T0 }],
    incomingFields: [], fromFormFile: AUG1, now: '2026-09-16T00:00:00.000Z',
  });
  assert.deepEqual(r1.setAside.map((e) => [e.value, e.setAsideAt]), [['One', T0]]);
  assert.equal(r1.added, 0);
  const r2 = svc.computeSetAside({
    previousFields: [{ key: 'a', label: 'A', value: 'Two' }],
    previousSetAside: [{ key: 'a', label: 'A', value: 'One', setAsideAt: T0 }],
    incomingFields: [], fromFormFile: AUG1, now: '2026-09-16T00:00:00.000Z',
  });
  assert.deepEqual(r2.setAside.map((e) => e.value), ['One', 'Two']);
  assert.equal(r2.added, 1);
});

test('era record: an absent echo keeps the file\'s record; a valid echo wins; nothing on file records nothing', async () => {
  let h = harness({ formFile: AUG1, fields: [NAME] });
  try {
    await h.save([NAME], '');
    assert.equal(h.written().formFile, AUG1, 'a page that sent no era (Submit before 2026-09-16) no longer erases it');
    await h.save([NAME], APR1);
    assert.equal(h.written().formFile, APR1, 'the validated echo wins');
  } finally { h.restore(); }
  h = harness(undefined);
  try {
    await h.save([NAME], '');
    assert.equal('formFile' in h.written(), false);
    assert.equal('setAside' in h.written(), false);
  } finally { h.restore(); }
});

test('a storage failure reading the file fails the save (transient) and writes nothing', async () => {
  const h = harness({ formFile: AUG1, fields: [NAME] });
  const r = stub(oneDrive, 'readFile', async () => { throw new Error('Graph 503'); });
  try {
    await assert.rejects(h.save([NAME], AUG1), (e) => e.transient === true);
    assert.ok(!h.log.includes('upload'), 'nothing written blind');
  } finally { r(); h.restore(); }
});

test('an unreadable file does not block the client\'s save', async () => {
  const h = harness('{ this is not json');
  try {
    await h.save([NAME], AUG1);
    const w = h.written();
    assert.deepEqual(w.fields, [NAME]);
    assert.equal(w.setAside, undefined);
  } finally { h.restore(); }
});

test('old plain-array files are read too — their dropped answers are kept aside', async () => {
  const h = harness([ADDR_AUG, NAME]);
  try {
    await h.save([NAME], APR1);
    assert.deepEqual(h.written().setAside.map((e) => e.key), [ADDR_AUG.key]);
    assert.equal(h.written().setAside[0].fromFormFile, undefined, 'no era to attribute');
  } finally { h.restore(); }
});

test('overlapping saves to one file run one after the other', async () => {
  const h = harness({ formFile: AUG1, fields: [NAME, ADDR_AUG] }, { uploadDelayMs: 25 });
  try {
    await Promise.all([h.save([NAME], AUG1), h.save([NAME, ADDR_AUG], AUG1)]);
    assert.deepEqual(h.log, ['read', 'upload', 'read', 'upload']);
    assert.deepEqual(h.written().setAside, undefined, 'the second save saw the first save\'s file (address back in its box)');
  } finally { h.restore(); }
});

test('a failed save does not block the next save to the same file', async () => {
  const h = harness({ formFile: AUG1, fields: [NAME] }, { uploadFailOnce: true });
  try {
    await assert.rejects(h.save([NAME], AUG1));
    await h.save([{ ...NAME, value: 'Dev P' }], AUG1);
    assert.equal(h.written().fields[0].value, 'Dev P');
  } finally { h.restore(); }
});

test('kept-aside answers are never served back as answers', async () => {
  const h = harness({ formFile: APR1, fields: [NAME], setAside: [{ ...ADDR_AUG, setAsideAt: '2026-09-14T00:00:00.000Z' }] });
  try {
    const fields = await svc.loadFormData({ clientName: 'T', caseRef: h.caseRef, formKey: 'primary' });
    assert.deepEqual(fields.map((f) => f.key), [NAME.key]);
  } finally { h.restore(); }
});

test('the kept-aside list is bounded — the oldest entries go first', () => {
  const previousSetAside = Array.from({ length: svc.SET_ASIDE_CAP }, (_, i) => ({ key: `k${i}`, label: 'L', value: `v${i}`, setAsideAt: '2026-09-01T00:00:00.000Z' }));
  const warn = console.warn; console.warn = () => {};
  try {
    const r = svc.computeSetAside({ previousFields: [{ key: 'new', label: 'L', value: 'fresh' }], previousSetAside, incomingFields: [] });
    assert.equal(r.setAside.length, svc.SET_ASIDE_CAP);
    assert.equal(r.setAside[0].key, 'k1', 'the oldest entry went');
    assert.equal(r.setAside[r.setAside.length - 1].key, 'new');
  } finally { console.warn = warn; }
});

// ─── Review round 1 (2026-09-16) ─────────────────────────────────────────────

test('a save waiting behind a STALLED save proceeds after a bounded wait', async () => {
  const caseRef = '2026-SA-STALL';
  const store = {};
  let uploads = 0;
  const prevWait = process.env.Q_SAVE_QUEUE_WAIT_MS;
  process.env.Q_SAVE_QUEUE_WAIT_MS = '60';
  const warn = console.warn; console.warn = () => {};
  const restores = [
    stub(oneDrive, 'readFile', async (a) => (store[a.filename] != null ? Buffer.from(store[a.filename]) : null)),
    stub(oneDrive, 'uploadFile', (a) => {
      uploads++;
      if (uploads === 1) return new Promise(() => {});           // storage never answers
      store[a.filename] = a.buffer.toString('utf8'); return Promise.resolve();
    }),
    stub(oneDrive, 'ensureClientFolder', async () => {}),
  ];
  try {
    const args = (value) => ({ clientName: 'T', caseRef, itemId: '1', formKey: 'primary', completionPct: 1, formFile: AUG1,
      fields: [{ section: 'S', label: 'Given Name', key: 'g', value }] });
    svc.saveFormData(args('first'));                                // hangs forever
    await svc.saveFormData(args('second'));
    assert.equal(JSON.parse(store[`questionnaire-${caseRef}-primary.json`]).fields[0].value, 'second');
  } finally {
    restores.forEach((r) => r()); console.warn = warn;
    if (prevWait === undefined) delete process.env.Q_SAVE_QUEUE_WAIT_MS; else process.env.Q_SAVE_QUEUE_WAIT_MS = prevWait;
  }
});

test('a table row that moved up (the client removed the row above) is not duplicated into the kept-aside list', () => {
  // Row 1's box is still on the page (now holding Pune), so Delhi's removal is
  // the client's own edit — like a cleared box; version history holds it. Goa
  // moved from row 3 to row 2: still on the page, so not kept aside.
  const sec = 'Main Applicant › Section 6 — Travel History › Table';
  const row = (n, city) => ({ section: sec, label: `City — Row ${n}`, key: `ma-tbl-travel-r${n}-city`, value: city });
  const r = svc.computeSetAside({
    previousFields: [row(1, 'Delhi'), row(2, 'Pune'), row(3, 'Goa')],
    previousSetAside: [],
    incomingFields: [row(1, 'Pune'), row(2, 'Goa')],
  });
  assert.deepEqual(r.setAside.map((e) => e.value), []);
  const moved = svc.computeSetAside({                       // a row moved within a table whose keys changed (form edit)
    previousFields: [{ section: sec, label: 'City — Row 3', key: 'old-key-r3', value: 'Goa' }],
    previousSetAside: [], incomingFields: [{ section: sec, label: 'City — Row 2', key: 'new-key-r2', value: 'Goa' }],
  });
  assert.deepEqual(moved.setAside, [], 'same section + column + value still on the page');
});

test('the same value in ANOTHER person\'s section never hides a lost answer', () => {
  const r = svc.computeSetAside({
    previousFields: [{ section: 'Dependent Spouse / Common-Law Partner › Family › Table', label: 'City — Row 1', key: 'sp-r1-city', value: 'Delhi' }],
    previousSetAside: [],
    incomingFields: [{ section: 'Main Applicant › Family › Table', label: 'City — Row 1', key: 'ma-r1-city', value: 'Delhi' }],
  });
  assert.deepEqual(r.setAside.map((e) => e.key), ['sp-r1-city']);
});

test('a kept-aside answer back on the page in its column leaves the list; carried duplicates collapse', () => {
  const T0 = '2026-09-14T00:00:00.000Z';
  const e = { section: 'S › Table', label: 'City — Row 3', key: 'r3', value: 'Goa', setAsideAt: T0 };
  const r = svc.computeSetAside({
    previousFields: [], incomingFields: [{ section: 'S › Table', label: 'City — Row 2', key: 'r2', value: 'Goa' }],
    previousSetAside: [e, { ...e }, { section: 'S', label: 'X', key: 'x', value: 'Kept', setAsideAt: T0 }, { section: 'S', label: 'X', key: 'x', value: 'Kept', setAsideAt: T0 }],
  });
  assert.deepEqual(r.setAside.map((x) => x.value), ['Kept']);
});

test('RESTORE carries kept-aside answers forward and keeps current answers the old version has no box for', () => {
  const version = { formFile: AUG1, completionPct: 92, savedAt: '2026-09-10T23:03:52.992Z', fields: [NAME, ADDR_AUG] };
  const current = { formFile: APR1, fields: [{ ...NAME, value: 'Dev Patel' }, { ...ADDR_APR, value: 'Brampton, ON' }],
    setAside: [{ ...NOC_AUG, setAsideAt: '2026-09-14T03:04:55.988Z', fromFormFile: AUG1 }] };
  const plan = svc.buildRestoreContent({ versionText: JSON.stringify(version), currentText: JSON.stringify(current), now: '2026-09-16T00:00:00.000Z' });
  const out = JSON.parse(plan.text);
  assert.equal(plan.rewritten, true);
  assert.deepEqual(out.fields, version.fields, 'the version\'s answers are restored exactly');
  assert.equal(out.formFile, AUG1, 'the version\'s era record is restored');
  assert.deepEqual(out.setAside.map((e) => [e.key, e.value]).sort(), [[ADDR_APR.key, 'Brampton, ON'], [NOC_AUG.key, '62020']].sort());
  assert.equal(plan.keptAside, 2);
});

test('RESTORE with nothing to keep writes the version byte for byte; a non-JSON version is refused', () => {
  const versionText = JSON.stringify({ formFile: AUG1, fields: [NAME] });
  const plan = svc.buildRestoreContent({ versionText, currentText: JSON.stringify({ formFile: AUG1, fields: [NAME] }) });
  assert.deepEqual([plan.rewritten, plan.text, plan.keptAside], [false, versionText, 0]);
  assert.equal(svc.buildRestoreContent({ versionText, currentText: null }).text, versionText, 'no current file');
  assert.throws(() => svc.buildRestoreContent({ versionText: 'nope', currentText: null }), (e) => e.badVersion === true);
});

test('admin endpoints: restore reads the current file first (unreadable → nothing restored); the viewer shows era + kept-aside', () => {
  const s = require('fs').readFileSync(require.resolve('../src/server'), 'utf8');
  const rIdx = s.indexOf("app.post('/admin/questionnaire/:caseRef/restore'");
  const rBlock = s.slice(rIdx, s.indexOf('\n});', rIdx));
  assert.match(rBlock, /svc\.buildRestoreContent\(/);
  const readAt = rBlock.search(/const curBuf = await oneDrive\.readFile\(\{ clientName, caseRef, subfolder: 'Questionnaire', filename \}\)/);
  assert.ok(readAt > 0, 'restore reads the current file');
  assert.ok(readAt < rBlock.indexOf('if (dryRun)'), 'the current file is read before the dry run answers');
  assert.match(rBlock, /buildRestoreContent\(\{ versionText: buf\.toString\('utf8'\), currentText \}\)/, 'and hands it to the helper');
  assert.match(rBlock, /status\(503\)[\s\S]{0,120}nothing was restored/);
  const cIdx = s.indexOf("app.get('/admin/questionnaire/:caseRef/versions/:versionId/content'");
  const cBlock = s.slice(cIdx, s.indexOf('\n});', cIdx));
  assert.match(cBlock, /formFile:/);
  assert.match(cBlock, /setAside:/);
});

test('family submit: a storage blip answers 503 "try again", not a hard failure', () => {
  const r = require('fs').readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm'), 'utf8');
  const i = r.indexOf("router.post('/:caseRef/submit-all'");
  const block = r.slice(i, r.indexOf('\n});', i));
  assert.match(block, /if \(saveErr && saveErr\.transient\) saveTransient = true;/);
  assert.match(block, /if \(saveErrors\.length && saveTransient\) \{\s*return res\.status\(503\)/);
});

test('a page that sends no era: the record follows what the saved labels prove, else the file keeps its record', async () => {
  const F6 = '6. Express Entry Profile - PNP Profile Creation - Questionnair - July 2025.html';
  const aprilAnswer = { section: 'Main Applicant › Family › Table', label: 'City & Country — Row 1', key: 'apr-city', value: 'Jaipur' };
  const cases = [
    ['old April tab submits over an August-recorded file', AUG1, [aprilAnswer], APR1],
    ['August labels over an April-recorded file', APR1, [NOC_AUG], AUG1],
    ['no marker either way keeps the record', AUG1, [NAME], AUG1],
    ['a form without editions keeps its record', F6, [aprilAnswer], F6],
  ];
  for (const [what, prevRecord, incoming, expected] of cases) {
    const h = harness({ formFile: prevRecord, fields: incoming });
    try {
      await h.save(incoming, '');
      assert.equal(h.written().formFile, expected, what);
    } finally { h.restore(); }
  }
});
