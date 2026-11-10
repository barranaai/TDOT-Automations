'use strict';

// Change the client deadline from the case page / the Client Master page (2026-11-10).
// Every Monday call goes through a fake mondayApi.query (no network): the tests read the EXACT
// mutations the service sends, and that nothing else is written.

const test = require('node:test');
const assert = require('node:assert/strict');

const mondayApi = require('../src/services/mondayApi');
const dashboardService = require('../src/services/dashboardService');
const leadService = require('../src/services/leadService');
const DL = require('../src/services/deadlineService');
const sync = require('../src/services/deadlineCaseSync');
const svc = require('../src/services/caseDeadlineService');
const { clientMasterBoardId } = require('../config/monday');

const C = require('../src/data/clientMasterBoard.json').deadlineColumns;   // { type, actual, promised }
const LEAD_COLS = require('../src/data/newLeadsBoard.json');
const ITEM = '5550001';
const STAFF = { id: '11', name: 'Asha <Officer>', email: 'asha@example.com', teamIds: [] };
const ppl = (...ids) => JSON.stringify({ personsAndTeams: ids.map((x) => ({ id: Number(x), kind: 'person' })) });
const REAL = { type: 'Deadline', actualDeadline: '2099-03-15', promisedSubmissionDate: '2099-03-01' };
const BLANK = { type: '', actualDeadline: '', promisedSubmissionDate: '' };

/** A fake Monday: the case's three cells, the linked leads, what each call did, and switches for failures. */
function fakeMonday(o = {}) {
  const st = {
    state: 'active', board: String(clientMasterBoardId), otherPeople: {},
    dl: { ...REAL }, emptyTypeText: '', leads: [],
    writes: [], leadWrites: [], notes: [], reads: 0, readBacks: 0, calls: [], keep: true, ...o,
  };
  const cells = () => [
    // an EMPTY status cell: value null, and Monday still sends the column's id-5 label as text
    { id: C.type, text: st.dl.type || st.emptyTypeText, value: st.dl.type ? JSON.stringify({ index: st.dl.type === 'Deadline' ? 1 : 2 }) : null },
    { id: C.actual, text: st.dl.actualDeadline, value: st.dl.actualDeadline ? JSON.stringify({ date: st.dl.actualDeadline }) : null },
    { id: C.promised, text: st.dl.promisedSubmissionDate, value: st.dl.promisedSubmissionDate ? JSON.stringify({ date: st.dl.promisedSubmissionDate }) : null },
  ];
  mondayApi.query = async (gql, vars, retries) => {
    st.calls.push({ gql, vars, retries });
    if (/^\s*mutation/.test(gql) && /change_multiple_column_values/.test(gql) && vars.cols !== undefined) {   // leadService.updateLead
      if (st.leadWriteFail) throw new Error('lead timeout');
      st.leadWrites.push({ id: String(vars.itemId), cols: JSON.parse(vars.cols) });
      return { change_multiple_column_values: { id: vars.itemId } };
    }
    if (/^\s*mutation/.test(gql) && /change_multiple_column_values/.test(gql)) {
      if (st.writeFail) throw new Error('timeout');
      const lands = st.writeLandsThenFails; st.writeLandsThenFails = false;   // once: Monday applies it, the answer is lost
      st.writes.push({ gql, vars, retries, cells: JSON.parse(vars.c), leadWritesBefore: st.leadWrites.length });
      if (st.keep) {
        const c = JSON.parse(vars.c);
        st.dl = { type: c[C.type] ? c[C.type].label : '', actualDeadline: c[C.actual] ? c[C.actual].date : '', promisedSubmissionDate: c[C.promised] ? c[C.promised].date : '' };
      }
      if (lands) throw new Error('timeout after the write landed');
      return { change_multiple_column_values: { id: vars.i } };
    }
    if (/^\s*mutation/.test(gql) && /create_update/.test(gql)) {
      st.notes.push({ vars, retries });
      if (st.noteFail) throw new Error('note timeout');
      return { create_update: { id: '9' } };
    }
    if (/items\(ids: \$ids, limit: 1\) \{ id name state board/.test(gql)) {
      st.reads++;
      if (st.readFail) throw new Error('network');
      if (st.missing) return { items: [] };
      const cvs = [...cells(), { id: 'text_mm142s49', text: '2026-TEST-001', value: null }];
      for (const [k, v] of Object.entries(st.otherPeople)) cvs.push({ id: k, text: '', value: v });
      return { items: [{ id: ITEM, name: 'Client X', state: st.state, board: { id: st.board }, column_values: cvs }] };
    }
    if (/items\(ids: \$ids, limit: 1\) \{ id column_values/.test(gql)) {
      st.readBacks++;
      if (st.readBackFail) throw new Error('network');
      if (st.readBackFailTimes > 0) { st.readBackFailTimes--; throw new Error('network'); }
      return { items: [{ id: ITEM, column_values: cells() }] };
    }
    throw new Error('unexpected Monday call: ' + gql.slice(0, 90));
  };
  svc._io.findLeads = async () => { st.leadFinds = (st.leadFinds || 0) + 1; if (st.findFail) throw new Error('lead lookup failed'); return st.leads; };
  return st;
}

const realQuery = mondayApi.query, realPatch = dashboardService.patchCachedColumn, realInvalidate = dashboardService.invalidateCases;
const realFind = svc._io.findLeads, realNow = svc._io.now, realRetain = require('../src/services/retainerService2').maybeSendRetainerAgreement;
let patches = [], invalidations = 0, retainerSends = 0;
test.beforeEach(() => {
  svc._inFlight.clear();
  patches = []; invalidations = 0; retainerSends = 0;
  dashboardService.patchCachedColumn = (itemId, colId, cell) => { patches.push({ itemId, colId, cell }); return true; };
  dashboardService.invalidateCases = () => { invalidations++; };
  require('../src/services/retainerService2').maybeSendRetainerAgreement = async () => { retainerSends++; return {}; };
  delete process.env.CASE_VISIBILITY; delete process.env.ADMIN_EMAILS; delete process.env.DEADLINE_REQUIRED;
});
test.after(() => {
  mondayApi.query = realQuery; dashboardService.patchCachedColumn = realPatch; dashboardService.invalidateCases = realInvalidate;
  svc._io.findLeads = realFind; svc._io.now = realNow; require('../src/services/retainerService2').maybeSendRetainerAgreement = realRetain;
  delete process.env.CASE_VISIBILITY; delete process.env.ADMIN_EMAILS; delete process.env.DEADLINE_REQUIRED;
});

const NEW_REAL = { deadlineType: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '2099-06-10' };
const NEW_IMAG = { deadlineType: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2099-05-20' };
const body = (o = {}) => ({ itemId: ITEM, deadline: NEW_REAL, reason: 'Client sent the new permit date', expected: { ...REAL }, ...o });
const call = (o = {}) => svc.change({ staff: STAFF, hasKey: false, body: body(), source: 'client-master', ...o });
async function refused(p, status, re) {
  let body_;
  await assert.rejects(svc.change({ source: 'client-master', ...p }), (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.body.error, re); body_ = e.body; return true; });
  return body_;
}
const noWrites = (m) => { assert.equal(m.writes.length, 0, 'no case write'); assert.equal(m.leadWrites.length, 0, 'no lead write'); assert.equal(m.notes.length, 0, 'no note'); };

// ── who ──
test('nobody signed in → 401 with the sign-in link; the shared key alone → 403 key-only (the note must name a person)', async () => {
  const m = fakeMonday();
  await assert.rejects(svc.change({ staff: null, hasKey: false, body: body() }), (e) => e.status === 401 && /^\/q\/auth\/monday/.test(e.body.loginUrl));
  const b = await refused({ staff: null, hasKey: true, body: body() }, 403, /^Sign in with Monday to change the deadline, so the note can say who did it\.$/);
  assert.equal(b.code, 'key-only');
  assert.equal(m.calls.length, 0, 'no Monday call before the sign-in check');
});

test('under "assigned": a staffer not on the case → 403 and the shared key does not count; assigned on the FRESH read → allowed; canChange is the page flag', async () => {
  process.env.CASE_VISIBILITY = 'assigned';
  let m = fakeMonday({ otherPeople: { multiple_person_mm0xhmgk: ppl(99) } });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 403, /You are not assigned to this case/);
  await refused({ staff: STAFF, hasKey: true, body: body() }, 403, /You are not assigned to this case/);
  noWrites(m);
  m = fakeMonday({ otherPeople: { multiple_person_mm0xhmgk: ppl(11) } });
  assert.equal((await call()).ok, true);
  assert.equal(svc.canChange(null, {}), false, 'the shared key alone never shows the button');
  assert.equal(svc.canChange(STAFF, { personIds: ['99'], teamIds: [] }), false);
  assert.equal(svc.canChange(STAFF, { personIds: ['11'], teamIds: [] }), true);
  delete process.env.CASE_VISIBILITY;
  assert.equal(svc.canChange(STAFF, { personIds: [], teamIds: [] }), true, 'default policy: any Monday sign-in');
});

// ── validation ──
test('the reason is required: missing, too short (after trimming) or too long → 400, before any Monday call', async () => {
  const m = fakeMonday();
  for (const reason of [undefined, '', '    ', 'abcd', ' a  b ', 42]) {
    await refused({ staff: STAFF, hasKey: false, body: body({ reason }) }, 400, /^Give a short reason for the change \(at least 5 characters\)\.$/);
  }
  await refused({ staff: STAFF, hasKey: false, body: body({ reason: 'x'.repeat(301) }) }, 400, /Keep the reason short/);
  assert.equal(m.calls.length, 0);
});

test('the deadline rules are deadlineService.validate — the same messages, no second validator; a blank answer is refused even with DEADLINE_REQUIRED=0', async () => {
  const m = fakeMonday();
  const cases = [
    { deadlineType: 'Deadline', actualDeadline: '2020-01-01', promisedSubmissionDate: '' },
    { deadlineType: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2020-01-01' },
    { deadlineType: 'Deadline', actualDeadline: '', promisedSubmissionDate: '' },
    { deadlineType: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '' },
    { deadlineType: 'Imaginary', actualDeadline: '2099-01-01', promisedSubmissionDate: '2099-01-01' },
    { deadlineType: 'Deadline', actualDeadline: '2099-01-01', promisedSubmissionDate: '2099-02-01' },
    { deadlineType: 'Soon', actualDeadline: '2099-01-01', promisedSubmissionDate: '' },
  ];
  for (const d of cases) {
    const want = DL.validate(d, { required: true });
    assert.equal(want.ok, false);
    const b = await refused({ staff: STAFF, hasKey: false, body: body({ deadline: d }) }, 400);
    assert.equal(b.error, want.error);
  }
  assert.match(DL.validate(cases[0]).error, /is in the past/);
  process.env.DEADLINE_REQUIRED = '0';
  for (const d of [{}, undefined, { deadlineType: '', actualDeadline: '', promisedSubmissionDate: '' }]) {
    await refused({ staff: STAFF, hasKey: false, body: body({ deadline: d }) }, 400, /^Choose Real deadline or Imaginary and give the date\.$/);
  }
  assert.equal(m.calls.length, 0);
});

test('a bad item id or a missing "expected" → 400 Reload', async () => {
  const m = fakeMonday();
  for (const b of [body({ itemId: 'abc' }), body({ itemId: '' }), body({ expected: undefined }), body({ expected: { type: 'Deadline' } }), body({ expected: { type: 1, actualDeadline: '', promisedSubmissionDate: '' } })]) {
    await refused({ staff: STAFF, hasKey: false, body: b }, 400, /Reload the page and try again/);
  }
  assert.equal(m.calls.length, 0);
});

// ── the fresh read ──
test('archived, deleted, missing or off-board row → 404; a failed read → 502; nothing written', async () => {
  for (const o of [{ state: 'archived' }, { state: 'deleted' }, { missing: true }, { board: '999' }]) {
    const m = fakeMonday(o);
    await refused({ staff: STAFF, hasKey: false, body: body() }, 404, /not found on the Client Master board/);
    noWrites(m);
  }
  const m = fakeMonday({ readFail: true });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 502, /Nothing was changed/);
  noWrites(m);
});

test('any active Client Master row may be changed, whatever its stage (no closed / submitted rule) — the read does not even ask for the stage', async () => {
  const m = fakeMonday();
  await call();
  const read = m.calls.find((c) => /id name state board/.test(c.gql));
  assert.ok(!/color_mm0x8faa|Case Stage/.test(read.gql));
  assert.match(read.gql, /limit: 1/);
  assert.match(read.gql, / text value /, 'status cells are read with text AND value');
});

test('stale: the deadline changed since the page loaded → 409 "changed" with the value now, the cache patched, nothing written', async () => {
  const m = fakeMonday({ dl: { type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2099-04-01' }, leads: [{ id: '70' }] });
  const b = await refused({ staff: STAFF, hasKey: false, body: body() }, 409, /^Someone changed it since your page loaded — it is now Imaginary — promised /);
  assert.equal(b.code, 'changed');
  assert.deepEqual(b.current, { type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2099-04-01', text: DL.describe({ type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2099-04-01' }) });
  noWrites(m);
  assert.equal(m.leadFinds || 0, 0, 'the leads are not even looked up');
  assert.deepEqual(patches.map((p) => p.colId), [C.type, C.actual, C.promised]);
  assert.deepEqual(patches[1].cell, { value: null, text: '' });
  assert.equal(invalidations, 0);
  // the pop-up re-arms with the current value and the same request then goes through
  const r = await call({ body: body({ expected: b.current }) });
  assert.equal(r.ok, true);
});

test('an EMPTY Deadline Type cell reads as blank, never as the column\'s id-5 label (expected blank passes; the cache gets a null cell)', async () => {
  const m = fakeMonday({ dl: { ...BLANK }, emptyTypeText: 'Deadline' });
  const r = await call({ body: body({ expected: { ...BLANK } }) });
  assert.equal(r.ok, true);
  assert.match(m.notes[0].vars.b, /Not set → Real deadline/);
});

test('busy: a second change of the same case while one runs → 409 busy', async () => {
  const m = fakeMonday();
  svc._inFlight.add(ITEM);
  const b = await refused({ staff: STAFF, hasKey: false, body: body() }, 409, /already being changed/);
  assert.equal(b.code, 'busy');
  assert.equal(m.calls.length, 0);
  svc._inFlight.clear();
  await call();
  assert.equal(svc._inFlight.size, 0, 'released after the write');
});

// ── the write ──
test('a case with NO linked lead: exactly ONE mutation on exactly the three deadline cells, one note, and no word about a lead', async () => {
  const m = fakeMonday({ leads: [] });
  svc._io.now = () => Date.UTC(2026, 10, 10, 15, 0, 0);
  const r = await call();
  svc._io.now = realNow;
  assert.deepEqual(r, { ok: true, deadline: { type: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '2099-06-10', text: DL.describe({ type: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '2099-06-10' }) }, leadsUpdated: 0 });
  assert.equal(m.writes.length, 1);
  assert.equal(m.leadWrites.length, 0);
  assert.equal(m.writes[0].vars.b, String(clientMasterBoardId));
  assert.equal(m.writes[0].vars.i, ITEM);
  assert.deepEqual(Object.keys(m.writes[0].cells).sort(), [C.type, C.actual, C.promised].sort(), 'never Hard / Soft / Prep Deadline, never Phase');
  assert.deepEqual(m.writes[0].cells, { [C.type]: { label: 'Deadline' }, [C.actual]: { date: '2099-06-30' }, [C.promised]: { date: '2099-06-10' } });
  assert.ok(!/create_labels_if_missing/.test(m.writes[0].gql));
  const cm = require('../src/data/clientMasterBoard.json');
  assert.ok(!Object.keys(m.writes[0].cells).includes(cm.deadlineColumns.phase));
  assert.equal(m.notes.length, 1);
  assert.equal(m.notes[0].retries, 0, 'the note is never retried');
  assert.equal(m.notes[0].vars.i, ITEM);
  assert.ok(!/lead/i.test(m.notes[0].vars.b), 'the note says nothing about a lead');
  assert.equal(retainerSends, 0);
});

test('the note: who, old → new (type + dates), the reason (one line, HTML-escaped), which page, Toronto time', async () => {
  const m = fakeMonday();
  svc._io.now = () => Date.UTC(2026, 10, 10, 15, 0, 0);
  await call({ source: 'case', body: body({ reason: '  Date <b>fixed</b>\n after the "call" & email  ' }) });
  svc._io.now = realNow;
  const n = m.notes[0].vars.b;
  const old = DL.describe(REAL), neu = DL.describe({ type: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '2099-06-10' });
  assert.ok(n.includes(`<b>Client deadline changed</b>: ${old} → ${neu}.`), n);
  assert.ok(n.includes('Reason: Date &lt;b&gt;fixed&lt;/b&gt; after the &quot;call&quot; &amp; email.'), n);
  assert.ok(n.includes('Changed on the case page by Asha &lt;Officer&gt; · '), n);
  assert.match(n, /\(Toronto\)\.$/);
  assert.ok(!/\n/.test(n));
  const m2 = fakeMonday();
  await call({ source: 'anything-else' });
  assert.match(m2.notes[0].vars.b, /Changed on the Client Master page by /, 'an unknown source never reaches the note');
});

test('Real → Imaginary: the case\'s Actual Deadline is cleared with null, and EVERY linked lead that differs gets the answer with the actual date cleared ("")', async () => {
  const lead = (id, o = {}) => ({ id, deadlineType: 'Deadline', actualDeadline: '2099-03-15', promisedSubmissionDate: '2099-03-01', outcome: 'Retain', retainerSent: '', ...o });
  const m = fakeMonday({ leads: [lead('70'), lead('71', { deadlineType: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2099-05-20' }), lead('72', { deadlineType: '', actualDeadline: '', promisedSubmissionDate: '' })] });
  const r = await call({ body: body({ deadline: NEW_IMAG }) });
  assert.equal(r.ok, true); assert.equal(r.leadsUpdated, 2);
  assert.deepEqual(m.writes[0].cells, { [C.type]: { label: 'Imaginary' }, [C.actual]: null, [C.promised]: { date: '2099-05-20' } });
  assert.deepEqual(m.leadWrites.map((w) => w.id), ['70', '72'], 'the lead already the same is skipped');
  for (const w of m.leadWrites) {
    assert.equal(w.cols[LEAD_COLS.columns.actualDeadline], '', 'the lead clear is "" (the buildCols clear rule)');
    assert.ok(JSON.stringify(w.cols[LEAD_COLS.columns.promisedSubmissionDate]).includes('2099-05-20'));
    assert.ok(JSON.stringify(w.cols[LEAD_COLS.columns.deadlineType]).includes('Imaginary'));
  }
  assert.equal(m.writes[0].leadWritesBefore, 2, 'the leads are written BEFORE the case (the webhook copy-back then finds nothing to do)');
  assert.equal(m.notes.length, 1, 'one note, on the case');
  assert.equal(m.notes[0].vars.i, ITEM);
  assert.equal(retainerSends, 0, 'a held retainer agreement is never released from here — no client email');
  assert.deepEqual(patches.map((p) => [p.colId, p.cell.text]), [[C.type, 'Imaginary'], [C.actual, ''], [C.promised, '2099-05-20']]);
  assert.deepEqual(patches[1].cell, { value: null, text: '' });
});

test('the lead step fails (lookup or write) → 502 "Nothing was changed on the case", no case write, no note; a retry with the same page value passes', async () => {
  let m = fakeMonday({ findFail: true });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 502, /Nothing was changed on the case — please try again/);
  assert.equal(m.writes.length, 0); assert.equal(m.notes.length, 0);
  m = fakeMonday({ leads: [{ id: '70' }], leadWriteFail: true });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 502, /Nothing was changed on the case — please try again/);
  assert.equal(m.writes.length, 0); assert.equal(m.notes.length, 0);
  m.leadWriteFail = false;
  assert.equal((await call()).leadsUpdated, 1);
  assert.equal(m.writes.length, 1);
});

test('no change needed: the case already says it → no case write, no note; a linked lead that differs is still brought in step', async () => {
  const m = fakeMonday({ leads: [{ id: '70', deadlineType: '', actualDeadline: '', promisedSubmissionDate: '' }] });
  const same = { deadlineType: 'Deadline', actualDeadline: REAL.actualDeadline, promisedSubmissionDate: REAL.promisedSubmissionDate };
  const r = await call({ body: body({ deadline: same }) });
  assert.equal(r.ok, true); assert.equal(r.unchanged, true); assert.equal(r.leadsUpdated, 1);
  assert.equal(m.writes.length, 0); assert.equal(m.notes.length, 0); assert.equal(m.leadWrites.length, 1);
});

test('the case write throws → 502 "result unknown"; Monday does not keep it → 502 and the cache shows what Monday has; the read-back fails → 502; no note in any of them', async () => {
  let m = fakeMonday({ writeFail: true });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 502, /The result is unknown — check the case in Monday/);
  assert.equal(m.notes.length, 0);
  m = fakeMonday({ keep: false });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 502, /Monday did not keep the change/);
  assert.equal(m.notes.length, 0);
  assert.deepEqual(patches.map((p) => p.cell.text), ['Deadline', '2099-03-15', '2099-03-01']);
  m = fakeMonday({ readBackFail: true });
  await refused({ staff: STAFF, hasKey: false, body: body() }, 502, /The result is unknown/);
  assert.equal(m.notes.length, 0);
  assert.equal(m.readBacks, 2, 'the read-back is tried twice, no more');
  assert.equal(invalidations, 0);
});

test('a write that LANDED but answered with an error (or whose first read-back failed) is still noted: the cells are read again and the change carries on', async () => {
  let m = fakeMonday({ writeLandsThenFails: true });
  let r = await call();
  assert.equal(r.ok, true); assert.equal(r.unchanged, undefined);
  assert.equal(m.writes.length, 1, 'the write is never sent twice');
  assert.equal(m.notes.length, 1);
  assert.match(m.notes[0].vars.b, /Client deadline changed<\/b>: Real deadline .* → Real deadline .*Reason: Client sent the new permit date\. Changed on the Client Master page by Asha/);
  assert.deepEqual(patches.map((p) => p.cell.text), ['Deadline', '2099-06-30', '2099-06-10']);
  patches = [];
  m = fakeMonday({ readBackFailTimes: 1 });
  r = await call();
  assert.equal(r.ok, true); assert.equal(m.readBacks, 2); assert.equal(m.notes.length, 1); assert.equal(m.writes.length, 1);
});

test('"already there": the case holds the wanted answer while the page showed the old one (an earlier save whose answer was lost) → no 409, no second write, ONE named note with the reason; the next Save is a plain no-op', async () => {
  const m = fakeMonday({ dl: { type: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '2099-06-10' }, leads: [{ id: '70', deadlineType: 'Deadline', actualDeadline: '2099-03-15', promisedSubmissionDate: '2099-03-01' }] });
  const r = await call();   // expected = REAL (the page), deadline = NEW_REAL (what Monday already has)
  assert.equal(r.ok, true); assert.equal(r.unchanged, true); assert.equal(r.noted, true);
  assert.equal(r.deadline.actualDeadline, '2099-06-30');
  assert.equal(m.writes.length, 0);
  assert.equal(m.leadWrites.length, 1, 'a lead that differs is still brought in step');
  assert.equal(m.notes.length, 1); assert.equal(m.notes[0].retries, 0);
  const note = m.notes[0].vars.b;
  assert.match(note, /^🗓 <b>Client deadline<\/b>: Real deadline .*2099.* — already on the case when this was saved \(the page still showed Real deadline .*2099.*\)\. Reason: Client sent the new permit date\. Changed on the Client Master page by Asha &lt;Officer&gt; · /);
  assert.ok(!/Someone/.test(note));
  assert.deepEqual(patches.map((p) => p.cell.text), ['Deadline', '2099-06-30', '2099-06-10'], 'the cache follows the fresh read');
  // the page now shows the new value: pressing Save again adds nothing
  const r2 = await call({ body: body({ expected: { type: r.deadline.type, actualDeadline: r.deadline.actualDeadline, promisedSubmissionDate: r.deadline.promisedSubmissionDate } }) });
  assert.equal(r2.unchanged, true); assert.equal(r2.noted, undefined);
  assert.equal(m.notes.length, 1); assert.equal(m.writes.length, 0);
});

test('an old row with dates but NO Deadline Type: the note and the 409 say every date the row held (never "Not set"), since the write replaces all three cells', async () => {
  const old = { type: '', actualDeadline: '2099-03-01', promisedSubmissionDate: '2099-02-10' };
  let m = fakeMonday({ dl: { ...old }, emptyTypeText: 'Deadline' });
  const r = await call({ body: body({ deadline: NEW_IMAG, expected: { ...old } }) });
  assert.equal(r.ok, true);
  assert.deepEqual(m.writes[0].cells, { [C.type]: { label: 'Imaginary' }, [C.actual]: null, [C.promised]: { date: '2099-05-20' } });
  const day = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  assert.ok(m.notes[0].vars.b.includes('Client deadline changed</b>: Type not recorded — actual ' + day('2099-03-01') + ' — promised ' + day('2099-02-10') + ' → Imaginary — promised ' + day('2099-05-20') + '.'), m.notes[0].vars.b);
  // the 409 for such a row
  m = fakeMonday({ dl: { ...old } });
  const b = await refused({ staff: STAFF, hasKey: false, body: body({ expected: { ...BLANK } }) }, 409, /it is now Type not recorded — actual .* — promised /);
  assert.equal(b.current.text, DL.describeStored(old));
  assert.deepEqual([b.current.type, b.current.actualDeadline, b.current.promisedSubmissionDate], ['', '2099-03-01', '2099-02-10']);
  // an Imaginary row with a stray Actual Deadline: the note does not read "X → X"
  const stray = { type: 'Imaginary', actualDeadline: '2099-07-01', promisedSubmissionDate: '2099-05-20' };
  m = fakeMonday({ dl: { ...stray } });
  await call({ body: body({ deadline: NEW_IMAG, expected: { ...stray } }) });
  assert.equal(m.writes.length, 1);
  assert.ok(m.notes[0].vars.b.includes('(with an actual date ' + day('2099-07-01') + ') → Imaginary — promised ' + day('2099-05-20') + '.'), m.notes[0].vars.b);
});

test('a promised date already on the case, left unchanged beside a real deadline, may be in the past; a new past date, or the same date as an Imaginary deadline, is refused (deadlineService.validate keepPromised)', async () => {
  const cur = { type: 'Deadline', actualDeadline: '2099-03-15', promisedSubmissionDate: '2020-01-01' };
  let m = fakeMonday({ dl: { ...cur } });
  const r = await call({ body: body({ deadline: { deadlineType: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '2020-01-01' }, expected: { ...cur } }) });
  assert.equal(r.ok, true);
  assert.deepEqual(m.writes[0].cells, { [C.type]: { label: 'Deadline' }, [C.actual]: { date: '2099-06-30' }, [C.promised]: { date: '2020-01-01' } }, 'the Internal Deadline is kept, not wiped');
  m = fakeMonday({ dl: { ...cur } });
  await refused({ staff: STAFF, hasKey: false, body: body({ deadline: { deadlineType: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '2020-02-02' }, expected: { ...cur } }) }, 400, /promised submission date 2020-02-02 is in the past/);
  await refused({ staff: STAFF, hasKey: false, body: body({ deadline: { deadlineType: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2020-01-01' }, expected: { ...cur } }) }, 400, /in the past/);
  // a made-up "expected" cannot smuggle a past date in: the stale check refuses it
  await refused({ staff: STAFF, hasKey: false, body: body({ deadline: { deadlineType: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '2019-05-05' }, expected: { ...cur, promisedSubmissionDate: '2019-05-05' } }) }, 409, /Someone changed it/);
  noWrites(m);
  // everywhere else the validator is unchanged
  assert.equal(DL.validate({ type: 'Deadline', actualDeadline: '2099-06-30', promisedSubmissionDate: '2020-01-01' }).ok, false);
  assert.equal(DL.validate({ type: 'Deadline', actualDeadline: '2020-01-01' }, { keepPromised: '2020-01-01' }).ok, false, 'the actual date is never exempt');
});

test('the note fails → still saved, noteFailed:true, the note is not sent twice', async () => {
  const m = fakeMonday({ noteFail: true });
  const r = await call();
  assert.equal(r.ok, true); assert.equal(r.noteFailed, true);
  assert.equal(m.notes.length, 1); assert.equal(m.writes.length, 1);
});

test('the cache: patchCachedColumn three times with the READ-BACK cells, invalidateCases never', async () => {
  fakeMonday();
  await call();
  assert.deepEqual(patches.map((p) => [p.itemId, p.colId, p.cell.text]), [[ITEM, C.type, 'Deadline'], [ITEM, C.actual, '2099-06-30'], [ITEM, C.promised, '2099-06-10']]);
  assert.equal(typeof patches[0].cell.value, 'string');
  assert.equal(invalidations, 0);
  assert.ok(!/invalidateCases/.test(require('fs').readFileSync(require.resolve('../src/services/caseDeadlineService'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
});

test('the Monday webhook\'s copy-back after this write is harmless: every lead already matches → { skipped: "same" }, no lead write, no second note', async () => {
  const leadRow = { id: '70', deadlineType: 'Deadline', actualDeadline: '2099-03-15', promisedSubmissionDate: '2099-03-01' };
  const m = fakeMonday({ leads: [leadRow] });
  // the leads follow what the service writes to them
  const realUpdate = svc._io.updateLead;
  svc._io.updateLead = async (id, fields, opts) => { Object.assign(leadRow, fields); for (const k of (opts && opts.clearKeys) || []) leadRow[k] = ''; return realUpdate(id, fields, opts); };
  const keep = { ...sync.io };
  let copied = 0, noted = 0;
  try {
    await call({ body: body({ deadline: NEW_IMAG }) });
    sync.io.readCase = async () => ({ ...m.dl });
    sync.io.findLeads = async () => [leadRow];
    sync.io.updateLead = async () => { copied++; };
    sync.io.note = async () => { noted++; };
    // one event per changed cell
    for (let i = 0; i < 3; i++) assert.deepEqual(await sync.onCaseEdited(ITEM), { skipped: 'same' });
    assert.equal(copied, 0); assert.equal(noted, 0);
    // and a case with no lead
    sync.io.findLeads = async () => [];
    assert.deepEqual(await sync.onCaseEdited(ITEM), { skipped: 'no lead' });
  } finally { Object.assign(sync.io, keep); svc._io.updateLead = realUpdate; }
  assert.equal(m.notes.length, 1);
});

test('leadService is asked through the clear-key path (never hand-built lead fields)', () => {
  const { fields, clearKeys } = DL.leadFields(DL.validate(NEW_IMAG, { required: true }));
  assert.deepEqual(fields, { deadlineType: 'Imaginary', promisedSubmissionDate: '2099-05-20' });
  assert.deepEqual(clearKeys, ['actualDeadline']);
  assert.equal(typeof leadService.updateLead, 'function');
});
