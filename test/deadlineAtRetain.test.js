'use strict';

// The client's deadline at retain (team meeting 2026-11-05, Gauri/Faran/Mahesh — block 1):
//   Deadline type (Deadline = real, Imaginary = a promised date), the actual deadline, the promised
//   submission date. Optional on the staff Add-lead form; required on the direct-retainer form and at
//   "Retain & send"; shown and editable on the lead page and the record page (saveDeadline); carried
//   onto the case row when the case opens and on every edit; a board edit is copied back to the lead;
//   Needs attention lists a new case without one. DEADLINE_REQUIRED=0 makes the question optional.

const test   = require('node:test');
const assert = require('node:assert/strict');

const DL          = require('../src/services/deadlineService');
const sync        = require('../src/services/deadlineCaseSync');
const portal      = require('../src/services/consultantPortalService');
const leadService = require('../src/services/leadService');
const mondayApi   = require('../src/services/mondayApi');
const retainer    = require('../src/services/retainerService2');
const registry    = require('../src/services/caseTypeRegistryService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const withEnv = (vars, fn) => async () => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
};
const TODAY = '2026-11-06';
const CM_COLS = require('../src/data/clientMasterBoard.json').deadlineColumns;

/* ── the rules ── */

test('validate: real needs its date; imaginary needs the promised date and no actual; never a past date; promised never after actual; blank refused only when required', () => {
  const v = (i, o) => DL.validate(i, { today: TODAY, ...o });
  assert.deepEqual(v({ deadlineType: 'Deadline', actualDeadline: '2027-01-15' }), { ok: true, blank: false, type: 'Deadline', actualDeadline: '2027-01-15', promisedSubmissionDate: '' });
  assert.deepEqual(v({ deadlineType: 'Deadline', actualDeadline: '2027-01-15', promisedSubmissionDate: '2026-12-15' }).promisedSubmissionDate, '2026-12-15', 'a real deadline may carry a promised date (decision 5)');
  assert.deepEqual(v({ deadlineType: 'Imaginary', promisedSubmissionDate: '2026-12-15' }), { ok: true, blank: false, type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2026-12-15' });
  assert.match(v({ deadlineType: 'Deadline' }).error, /needs the actual deadline date/);
  assert.match(v({ deadlineType: 'Imaginary' }).error, /needs the date promised/);
  assert.match(v({ deadlineType: 'Imaginary', promisedSubmissionDate: '2026-12-15', actualDeadline: '2027-01-01' }).error, /has no actual date/);
  assert.match(v({ deadlineType: 'Deadline', actualDeadline: '2026-11-05' }).error, /in the past/);
  assert.match(v({ deadlineType: 'Deadline', actualDeadline: TODAY }).ok ? '' : 'x', /^$/, 'today is allowed');
  assert.match(v({ deadlineType: 'Deadline', actualDeadline: '2027-01-15', promisedSubmissionDate: '2027-02-01' }).error, /after the actual deadline/);
  assert.match(v({ deadlineType: 'Deadline', actualDeadline: '2027-02-30' }).error, /not a valid date/);
  assert.match(v({ deadlineType: 'Soon', actualDeadline: '2027-01-15' }).error, /Choose the deadline type/);
  assert.match(v({ actualDeadline: '2027-01-15' }).error, /Choose the deadline type/);
  assert.match(v({}, { required: true }).error, /Set the deadline/);
  assert.deepEqual(v({}, { required: false }), { ok: true, blank: true, type: '', actualDeadline: '', promisedSubmissionDate: '' });
  // the switch: on by default, off on 0/off/false/no
  delete process.env.DEADLINE_REQUIRED; assert.equal(DL.required(), true);
  for (const off of ['0', 'off', 'false', 'no']) { process.env.DEADLINE_REQUIRED = off; assert.equal(DL.required(), false, off); }
  process.env.DEADLINE_REQUIRED = '1'; assert.equal(DL.required(), true);
  delete process.env.DEADLINE_REQUIRED;
  // wording and the case cells
  assert.equal(DL.describe({ ok: true, type: 'Deadline', actualDeadline: '2027-01-15', promisedSubmissionDate: '' }), 'Real deadline Jan 15, 2027');
  assert.equal(DL.describe({ ok: true, type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2026-12-15' }), 'Imaginary — promised Dec 15, 2026');
  assert.equal(DL.describe({}), 'Not set');
  assert.deepEqual(DL.caseCells(v({ deadlineType: 'Imaginary', promisedSubmissionDate: '2026-12-15' })), { [CM_COLS.type]: { label: 'Imaginary' }, [CM_COLS.actual]: null, [CM_COLS.promised]: { date: '2026-12-15' } });
  assert.deepEqual(DL.caseCells({ ok: true, blank: true }), { [CM_COLS.type]: null, [CM_COLS.actual]: null, [CM_COLS.promised]: null });
  assert.deepEqual(DL.leadFields(v({ deadlineType: 'Deadline', actualDeadline: '2027-01-15' })), { fields: { deadlineType: 'Deadline', actualDeadline: '2027-01-15' }, clearKeys: ['promisedSubmissionDate'] });
  assert.deepEqual(CM_COLS, { type: 'color_mm6w7cdd', actual: 'date_mm33sj6t', promised: 'date_mm3t66pa', phase: 'color_mm3tf1ys' }, 'the team\'s own case columns are reused (decision 1)');
  const leadCols = require('../src/data/newLeadsBoard.json').columns;
  assert.deepEqual(DL.LEAD_KEYS.filter((k) => k in leadCols).length, 3, 'the three lead columns are in the column map');
});

/* ── the Add-lead form: optional there ── */

const VALID = { fullName: 'Phone Caller', email: 'caller@x.com', phone: '4165550001', sourceChannel: 'Phone', residentialAddress: '12 King St W, Toronto', inCanada: 'Yes', addedBy: 'Melanie' };
function leadWorld() {
  const calls = { created: [], updates: [], notes: [] };
  const restore = [
    stub(portal, 'findClientMatches', async () => ({ clients: [], cases: [], leads: [] })),
    stub(leadService, 'createLead', async (f) => { calls.created.push(f); return { id: '9300', ...f }; }),
    stub(leadService, 'updateLead', async (id, f, o) => { calls.updates.push({ id, f, o }); }),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) calls.notes.push(v.b); return {}; }),
  ];
  return { calls, done: () => restore.reverse().forEach((r) => r()) };
}

test('Add lead: the deadline may be left for later (the note says so); a given answer is checked and lands at creation (dates) and in the follow-up (the type)', async () => {
  const w = leadWorld();
  try {
    await portal.createStaffLead(VALID);
    assert.equal(w.calls.created[0].actualDeadline, undefined); assert.equal(w.calls.created[0].deadlineType, undefined);
    assert.ok(w.calls.notes.some((b) => /Still to add on this page: .*the deadline — real or imaginary, and the date \(asked again when the client is retained\)/.test(b)), w.calls.notes.join(' | '));
    await assert.rejects(portal.createStaffLead({ ...VALID, deadlineType: 'Deadline' }), (e) => e.badRequest && /needs the actual deadline date/.test(e.message));
    await assert.rejects(portal.createStaffLead({ ...VALID, deadlineType: 'Imaginary', promisedSubmissionDate: '2020-01-01' }), (e) => e.badRequest && /in the past/.test(e.message));
    w.calls.created.length = 0; w.calls.updates.length = 0; w.calls.notes.length = 0;
    await portal.createStaffLead({ ...VALID, deadlineType: 'Imaginary', promisedSubmissionDate: '2099-12-15' });
    assert.equal(w.calls.created[0].promisedSubmissionDate, '2099-12-15', 'the date at creation');
    assert.ok(w.calls.updates.some((u) => u.id === '9300' && u.f.deadlineType === 'Imaginary'), 'the type (a label) in the follow-up write');
    assert.ok(!w.calls.notes.some((b) => /the deadline — real or imaginary/.test(b)), 'nothing missing');
  } finally { w.done(); }
});

/* ── the direct-retainer form: required ── */

const { CASE_TYPE_LABELS, SUB_TYPES_BY_CASE } = require('../config/caseTypes');
const CASE_TYPE = CASE_TYPE_LABELS.find((ct) => !(SUB_TYPES_BY_CASE[ct] || []).length), CONSULTANT = 'Shafoli Kapur';   // a case type without sub-type variants
function directWorld() {
  const calls = { created: null, updates: [], notes: [], cm: [] };
  const restore = [
    stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(leadService, 'createLead', async (f) => { calls.created = f; return { id: '900', ...f }; }),
    stub(leadService, 'updateLead', async (id, f, o) => { calls.updates.push({ id, f, o }); }),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) calls.notes.push(v.b || v.body); if (/create_item/.test(q)) { calls.cm.push(JSON.parse(v.cols)); return { create_item: { id: 'CM-1' } }; } return {}; }),
    stub(require('../src/services/handoffService'), 'openCaseEarly', async () => 'CM-1'),
  ];
  return { calls, done: () => restore.reverse().forEach((r) => r()) };
}
const DIRECT = { sourceChannel: 'Phone', notes: 'Needs a study permit — quoted $2,500.', fullName: 'Walkin Client', email: 'walkin@example.com', phone: '+14165550100', residentialAddress: '1 Main St', caseType: CASE_TYPE, consultant: CONSULTANT };

test('Direct retainer: refused without the deadline (before anything is created); with it, the dates go on at creation, the type in the wiring, the note says it', async () => {
  const w = directWorld();
  try {
    await assert.rejects(portal.createDirectClient(DIRECT), (e) => e.badRequest && /Set the deadline: a real deadline with its date, or imaginary with the submission date promised to the client/.test(e.message));
    assert.equal(w.calls.created, null, 'nothing created');
    const r = await portal.createDirectClient({ ...DIRECT, deadlineType: 'Deadline', actualDeadline: '2099-01-15', promisedSubmissionDate: '2098-12-15' });
    assert.equal(r.ok, true);
    assert.equal(w.calls.created.actualDeadline, '2099-01-15'); assert.equal(w.calls.created.promisedSubmissionDate, '2098-12-15');
    const wired = w.calls.updates.find((u) => u.id === '900' && u.f.sourceChannel);
    assert.equal(wired.f.deadlineType, 'Deadline', 'the label travels in the wiring write (create_item mints no labels)');
    assert.ok(w.calls.notes.some((b) => /Deadline: Real deadline Jan 15, 2099 — promised Dec 15, 2098/.test(b)), w.calls.notes.join(' | '));
  } finally { w.done(); }
});

test('Direct retainer: with DEADLINE_REQUIRED=0 the question is optional (the switch), and the options endpoint tells the pages', withEnv({ DEADLINE_REQUIRED: '0' }, async () => {
  const w = directWorld();
  try {
    const r = await portal.createDirectClient(DIRECT);
    assert.equal(r.ok, true);
    assert.equal(w.calls.created.deadlineType, undefined);
    const o = await portal.getDirectClientOptions();
    assert.equal(o.deadlineRequired, false); assert.deepEqual(o.deadlineTypes, ['Deadline', 'Imaginary']);
  } finally { w.done(); }
  delete process.env.DEADLINE_REQUIRED;
  const o = await (async () => { const r = stub(registry, 'getCaseTypes', async () => { throw new Error('x'); }); try { return await portal.getDirectClientOptions(); } finally { r(); } })();
  assert.equal(o.deadlineRequired, true);
}));

/* ── the lead page / the record page: saveDeadline, and Retain & send ── */

function actionWorld(lead) {
  const calls = { updates: [], notes: [], cm: [] };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...lead })),
    stub(leadService, 'updateLead', async (id, f, o) => { calls.updates.push({ id, f, o }); }),
    stub(mondayApi, 'query', async (q, v) => {
      if (/create_update/.test(q)) calls.notes.push(v.b || v.body);
      if (/change_multiple_column_values/.test(q)) calls.cm.push({ item: v.i || v.itemId, cols: JSON.parse(v.c || v.cols) });
      return {};
    }),
    stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
  ];
  return { calls, done: () => restore.reverse().forEach((r) => r()) };
}

test('saveDeadline: writes the lead (clearing the other date), the linked case row, and a note with who and the change; a blank clears all three; "No change." when the same', async () => {
  const lead = { id: '1', fullName: 'A', outcome: 'Retain', clientMasterItemId: '7001', deadlineType: 'Imaginary', promisedSubmissionDate: '2099-12-15' };
  const w = actionWorld(lead);
  try {
    let r = await portal.applyAction({ leadId: '1', action: 'saveDeadline', value: JSON.stringify({ deadlineType: 'Deadline', actualDeadline: '2099-01-15' }), actor: { verified: true, name: 'Asmita Acharya' } });
    assert.match(r.message, /Saved — Real deadline Jan 15, 2099\. The case row is updated too\./);
    assert.deepEqual(w.calls.updates[0], { id: '1', f: { deadlineType: 'Deadline', actualDeadline: '2099-01-15' }, o: { clearKeys: ['promisedSubmissionDate'] } });
    assert.deepEqual(w.calls.cm[0], { item: '7001', cols: { [CM_COLS.type]: { label: 'Deadline' }, [CM_COLS.actual]: { date: '2099-01-15' }, [CM_COLS.promised]: null } });
    assert.ok(w.calls.notes.some((n) => /Deadline: Real deadline Jan 15, 2099 \(was Imaginary — promised Dec 15, 2099\) — set by Asmita Acharya\./.test(n)), w.calls.notes.join(' | '));
    r = await portal.applyAction({ leadId: '1', action: 'saveDeadline', value: JSON.stringify({ deadlineType: 'Imaginary', promisedSubmissionDate: '2099-12-15' }) });
    assert.equal(r.message, 'No change.');
    await assert.rejects(portal.applyAction({ leadId: '1', action: 'saveDeadline', value: JSON.stringify({ deadlineType: 'Deadline' }) }), (e) => e.badRequest && /needs the actual deadline date/.test(e.message));
    w.calls.updates.length = 0; w.calls.cm.length = 0;
    r = await portal.applyAction({ leadId: '1', action: 'saveDeadline', value: JSON.stringify({}) });
    assert.match(r.message, /Saved — Not set/);
    assert.deepEqual(w.calls.updates[0], { id: '1', f: {}, o: { clearKeys: ['deadlineType', 'actualDeadline', 'promisedSubmissionDate'] } });
    assert.deepEqual(w.calls.cm[0].cols, { [CM_COLS.type]: null, [CM_COLS.actual]: null, [CM_COLS.promised]: null });
  } finally { w.done(); }
  // a case write that fails is said, never silent
  const w2 = actionWorld({ ...lead, deadlineType: '' });
  const inner = mondayApi.query;
  const bad = stub(mondayApi, 'query', async (q, v) => { if (/change_multiple_column_values/.test(q)) throw new Error('monday 500'); return inner(q, v); });
  try {
    const r = await portal.applyAction({ leadId: '1', action: 'saveDeadline', value: JSON.stringify({ deadlineType: 'Deadline', actualDeadline: '2099-01-15' }) });
    assert.match(r.message, /⚠ The case row could not be updated — set it on the case in Monday\./);
    assert.ok(w2.calls.notes.some((n) => /case row could not be updated/.test(n)));
  } finally { bad(); w2.done(); }
  // a record without a case: the lead only
  const w3 = actionWorld({ ...lead, clientMasterItemId: '', deadlineType: '' });
  try {
    const r = await portal.applyAction({ leadId: '1', action: 'saveDeadline', value: JSON.stringify({ deadlineType: 'Deadline', actualDeadline: '2099-01-15' }) });
    assert.equal(r.message, 'Saved — Real deadline Jan 15, 2099.');
    assert.equal(w3.calls.cm.length, 0);
  } finally { w3.done(); }
});

test('Retain & send: refused until the deadline is set — before the Outcome changes or anything is sent; allowed once set; and with the switch off', async () => {
  const lead = { id: '1', fullName: 'A', email: 'a@b.co', residentialAddress: '1 Main St', retainerFee: '2000', outcome: '', confirmedCaseType: CASE_TYPE };
  const sends = [];
  const w = actionWorld(lead);
  const r1 = stub(retainer, 'maybeSendRetainerAgreement', async () => { sends.push(1); return { status: 'sent' }; });
  const r2 = stub(portal, 'notifyOutcomeChange', async () => {});
  try {
    await assert.rejects(portal.applyAction({ leadId: '1', action: 'retainAndSend', value: '' }), (e) => e.badRequest && /Set the deadline first \(the Deadline box above\)/.test(e.message));
    assert.deepEqual(w.calls.updates, [], 'the Outcome was NOT set'); assert.deepEqual(sends, [], 'nothing sent');
  } finally { r2(); r1(); w.done(); }
  const w2 = actionWorld({ ...lead, deadlineType: 'Imaginary', promisedSubmissionDate: '2099-12-15' });
  const s1 = stub(retainer, 'maybeSendRetainerAgreement', async () => { sends.push(1); return { status: 'sent' }; });
  const s2 = stub(portal, 'notifyOutcomeChange', async () => {});
  try {
    const r = await portal.applyAction({ leadId: '1', action: 'retainAndSend', value: '' });
    assert.equal(r.ok, true); assert.equal(sends.length, 1);
    assert.ok(w2.calls.updates.some((u) => u.f.outcome === 'Retain'));
  } finally { s2(); s1(); w2.done(); }
  await withEnv({ DEADLINE_REQUIRED: 'off' }, async () => {
    const w3 = actionWorld(lead);
    const t1 = stub(retainer, 'maybeSendRetainerAgreement', async () => ({ status: 'sent' }));
    const t2 = stub(portal, 'notifyOutcomeChange', async () => {});
    try { assert.equal((await portal.applyAction({ leadId: '1', action: 'retainAndSend', value: '' })).ok, true); } finally { t2(); t1(); w3.done(); }
  })();
});

test('the lead page and the record page carry the answer, its wording and whether it is required', async () => {
  const lead = { id: '1', name: 'A', fullName: 'A', deadlineType: 'Deadline', actualDeadline: '2099-01-15', clientMasterItemId: '' };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...lead })),
    stub(mondayApi, 'query', async () => ({ items: [{ column_values: [], updates: [] }] })),
    stub(registry, 'getCaseTypes', async () => { throw new Error('x'); }),
  ];
  try {
    const d = await portal.getConsultationDetail('1');
    assert.deepEqual(d.deadline, { type: 'Deadline', actualDeadline: '2099-01-15', promisedSubmissionDate: '', text: 'Real deadline Jan 15, 2099', set: true, required: true });
  } finally { restore.reverse().forEach((r) => r()); }
  // the pages: the box, its script, and what the lists show
  const fs = require('fs'), vm = require('vm');
  const L = require('../src/routes/adminLeads'), C = require('../src/routes/adminConsultation');
  for (const [name, html, prefix] of [['add-lead', L.buildLeadsQueueHTML(), 'al'], ['lead page', L.buildLeadDetailHTML('1'), 'lead'], ['direct form', C.buildRetainersHTML(), 'dc'], ['record page', C.buildDetailHTML('1'), 'cd']]) {
    assert.ok(html.includes(`name="${prefix}-dltype" value="Deadline"`) && html.includes(`name="${prefix}-dltype" value="Imaginary"`), name);
    assert.ok(html.includes(`id="${prefix}-dl-actual"`) && html.includes(`id="${prefix}-dl-promised"`), name);
    assert.equal((html.match(/window\.tdotDeadlineBox = function/g) || []).length, 1, `${name}: the box script once`);
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
  }
  assert.ok(L.buildLeadsQueueHTML().includes('Deadline (if known)'), 'optional wording on the Add-lead form');
  assert.ok(C.buildRetainersHTML().includes('Deadline *') && C.buildRetainersHTML().includes("var dlErr=DC_DL.check(!DC_OPTS || DC_OPTS.deadlineRequired!==false)"), 'required on the direct-retainer form');
  assert.ok(C.buildDetailHTML('1').includes("st+=kv('Deadline'") || C.buildDetailHTML('1').includes("kv('Deadline',(d.deadline&&d.deadline.text)||'Not set')"));
  assert.ok(L.buildLeadDetailHTML('1').includes("st+=kv('Deadline', (d.deadline&&d.deadline.text)||'Not set');"));
  const rec = C.buildDetailHTML('1');
  assert.ok(rec.includes("if(CD_DIRTY){ setMsg('Click \"Save deadline\" first — the deadline in the box is not saved yet.','err'); CD_DL.focus(); return; }") && rec.includes('if(!(dlInfo && dlInfo.set)){'), 'Retain & send checks the SAVED answer (the detail payload), and names an unsaved box');
  assert.ok(rec.includes('if(!(dlInfo && dlInfo.required===false)){') && !rec.includes('RP_CT_OPTS.deadlineRequired'), 'the switch is read from the detail, not the options fetch');
  assert.ok(!/CD_DIRTY=false;\s*doAction\('saveDeadline'/.test(rec) && rec.includes("if(action==='saveDeadline'){ CD_DIRTY=false; cdMsg(res.j.message||'Done.','ok'); }"), 'the box keeps the typed answer until the server has saved it; feedback in the box');
  assert.ok(rec.includes("if(action==='saveDeadline') cdMsg(netErr(e),'err')"), 'a refused save is said in the box');
  assert.ok(C.buildRetainersHTML().includes('#dc-modal .dlx .al-yn input { width:auto; padding:0; border:0;') && C.buildRetainersHTML().includes('if(d.deadline && d.deadline.set && DC_DL.blank()) DC_DL.set(d.deadline);'), 'the modal: radios not stretched; converting a lead shows its deadline');
  const src = fs.readFileSync(require.resolve('../src/routes/deadlineBox.js'), 'utf8');
  assert.ok(!/`|\$\{/.test(require('../src/routes/deadlineBox').DEADLINE_BOX_JS), 'plain template text: no backtick, no dollar-brace');
  void src;
});

/* ── the case row: at open, on a reused case, and from the board ── */

test('case open: the lead\'s deadline goes into the create write; a reused case gets it only when its own is blank', async () => {
  const handoff = require('../src/services/handoffService');
  const calls = { create: [], writes: [] };
  const lead = { id: '55', fullName: 'Walkin Client', email: 'w@x.co', confirmedCaseType: CASE_TYPE, deadlineType: 'Imaginary', promisedSubmissionDate: '2099-12-15', retainerSigned: '', conversionStatus: 'Qualified' };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...lead })),
    stub(leadService, 'updateLead', async () => {}),
    stub(leadService, 'findByColumnValue', async () => null),
    stub(mondayApi, 'query', async (q, v) => {
      if (/create_item/.test(q) && /item_name/.test(q)) { calls.create.push(JSON.parse(v.cols)); return { create_item: { id: 'CM-9' } }; }
      if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: [] } };
      if (/change_multiple_column_values/.test(q)) { calls.writes.push({ item: v.itemId || v.i, cols: JSON.parse(v.cols || v.c) }); return {}; }
      if (/column_values\(ids/.test(q)) return { items: [{ column_values: [] }] };
      return { items: [] };
    }),
    stub(registry, 'getCaseTypes', async () => { throw new Error('x'); }),
    stub(require('../src/services/consultCopyService'), 'copyOnCaseOpen', async () => {}),
    stub(handoff, 'ensureLeadFolderNow', async () => null),
  ];
  try {
    const id = await handoff.openCaseEarly({ leadId: '55' });
    assert.equal(id, 'CM-9');
    const cols = calls.create[0];
    assert.deepEqual([cols[CM_COLS.type], cols[CM_COLS.promised], cols[CM_COLS.actual]], [{ label: 'Imaginary' }, { date: '2099-12-15' }, null], 'in the same write that creates the row');
  } finally { restore.reverse().forEach((r) => r()); }
  // a reused case: carried only when blank there
  for (const [onCase, expectWrite] of [['', true], ['Deadline', false]]) {
    const w = { writes: [] };
    const restore2 = [
      stub(sync.io, 'readCase', async () => ({ type: onCase, actualDeadline: onCase ? '2099-03-01' : '', promisedSubmissionDate: '' })),
      stub(sync.io, 'writeCase', async (id, cells) => { w.writes.push({ id, cells }); }),
    ];
    try {
      await handoff._internal.carryDeadlineToReusedCase('CM-5', lead);
      assert.equal(w.writes.length, expectWrite ? 1 : 0, `on case: "${onCase}"`);
    } finally { restore2.reverse().forEach((r) => r()); }
  }
});

test('a board edit of the deadline columns is copied back to the linked lead with a note; the same value, no lead, or a read error changes nothing', async () => {
  const calls = { updates: [], notes: [] };
  const lead = { id: '1', deadlineType: 'Imaginary', promisedSubmissionDate: '2099-12-15', clientMasterItemId: '7001' };
  const restore = [
    stub(sync.io, 'readCase', async () => ({ type: 'Deadline', actualDeadline: '2099-01-15', promisedSubmissionDate: '' })),
    stub(sync.io, 'findLeads', async () => [{ ...lead }]),
    stub(sync.io, 'updateLead', async (id, f, o) => { calls.updates.push({ id, f, o }); }),
    stub(sync.io, 'note', async (id, b) => { calls.notes.push(b); }),
  ];
  try {
    const r = await sync.onCaseEdited('7001');
    assert.deepEqual(r, { ok: true, leadId: '1', leadIds: ['1'] });
    assert.deepEqual(calls.updates[0], { id: '1', f: { deadlineType: 'Deadline', actualDeadline: '2099-01-15' }, o: { clearKeys: ['promisedSubmissionDate'] } });
    assert.match(calls.notes[0], /Deadline changed on the case row in Monday: Real deadline Jan 15, 2099 \(was Imaginary — promised Dec 15, 2099\)\.$/);
    assert.ok(sync.isDeadlineColumn('color_mm6w7cdd') && sync.isDeadlineColumn('date_mm3t66pa') && !sync.isDeadlineColumn('text_mm0xw6bp'));
  } finally { restore.reverse().forEach((r) => r()); }
  const quiet = [stub(sync.io, 'readCase', async () => ({ type: 'Imaginary', actualDeadline: '', promisedSubmissionDate: '2099-12-15' })), stub(sync.io, 'findLeads', async () => [{ ...lead }]), stub(sync.io, 'updateLead', async () => { throw new Error('must not write'); })];
  try { assert.deepEqual(await sync.onCaseEdited('7001'), { skipped: 'same' }); } finally { quiet.reverse().forEach((r) => r()); }
  const none = [stub(sync.io, 'readCase', async () => ({ type: 'Deadline', actualDeadline: '2099-01-15', promisedSubmissionDate: '' })), stub(sync.io, 'findLeads', async () => [])];
  try { assert.deepEqual(await sync.onCaseEdited('7001'), { skipped: 'no lead' }); } finally { none.reverse().forEach((r) => r()); }
  const err = [stub(sync.io, 'readCase', async () => { throw new Error('monday 503'); })];
  try { assert.deepEqual(await sync.onCaseEdited('7001'), { error: 'monday 503' }); } finally { err.reverse().forEach((r) => r()); }
  // an incomplete hand edit is copied as it is, and the note says what is missing
  const partial = [stub(sync.io, 'readCase', async () => ({ type: 'Deadline', actualDeadline: '', promisedSubmissionDate: '' })), stub(sync.io, 'findLeads', async () => [{ ...lead }]), stub(sync.io, 'updateLead', async () => {}), stub(sync.io, 'note', async (id, b) => { calls.notes.push(b); })];
  try { await sync.onCaseEdited('7001'); assert.match(calls.notes.pop(), /⚠ A real deadline needs the actual deadline date\./); } finally { partial.reverse().forEach((r) => r()); }
  // two leads on one case (a consultation lead and a later direct-retainer row): both are brought in step
  const two = [stub(sync.io, 'readCase', async () => ({ type: 'Deadline', actualDeadline: '2099-01-15', promisedSubmissionDate: '' })),
    stub(sync.io, 'findLeads', async () => [{ ...lead }, { id: '2', deadlineType: 'Deadline', actualDeadline: '2099-01-15', clientMasterItemId: '7001' }, { id: '3', clientMasterItemId: '7001' }]),
    stub(sync.io, 'updateLead', async (id, f, o) => { calls.updates.push({ id, f, o }); }), stub(sync.io, 'note', async (id, b) => { calls.notes.push(b); })];
  calls.updates.length = 0;
  try {
    assert.deepEqual(await sync.onCaseEdited('7001'), { ok: true, leadId: '1', leadIds: ['1', '3'] });
    assert.deepEqual(calls.updates.map((u) => u.id), ['1', '3'], 'the lead that already agrees is left alone');
  } finally { two.reverse().forEach((r) => r()); }
  // the Client Master webhook reaches the copy for a deadline column only — driven through the router itself
  const router = require('../src/routes/mondayWebhook');
  const { clientMasterBoardId } = require('../config/monday');
  const seen = [];
  const wh = [stub(sync, 'onCaseEdited', async (id) => { seen.push(String(id)); return { ok: true }; }), stub(mondayApi, 'query', async () => ({}))];
  try {
    const drive = (columnId) => new Promise((resolve) => {
      const req = { method: 'POST', url: '/', body: { event: { type: 'update_column_value', boardId: clientMasterBoardId, pulseId: 7001, columnId, value: {} } } };
      const res = { json() { setTimeout(resolve, 30); return this; }, status() { return this; } };
      router.handle(req, res, () => resolve());
    });
    await drive(CM_COLS.actual);
    await drive('text_mm0xw6bp');
    assert.deepEqual(seen, ['7001'], 'reached once for a deadline column, not for another column');
  } finally { wh.reverse().forEach((r) => r()); }
});

test('the case page pill and Needs attention: a new case without a deadline is listed (medium); older or closed cases and legacy groups are not', async () => {
  const NA = require('../src/services/needsAttentionService');
  const NOW = Date.parse('2026-12-01T15:00:00Z'), D = 86400000;
  const item = (over = {}) => {
    const o = { id: '1', ref: '2026-SV-050', stage: 'Document Collection Started', payment: 'Paid', createdAgo: 3 * D, type: '', group: 'group_x', title: 'December 2026', ...over };
    return { id: o.id, name: 'Client', created_at: new Date(NOW - o.createdAgo).toISOString(), group: { id: o.group, title: o.title }, updates: [],
      column_values: [['text_mm142s49', o.ref], ['color_mm0x8faa', o.stage], ['color_mm0x9fnn', o.payment], ['color_mm6w7cdd', o.type]].map(([id, text]) => ({ id, text, value: null })) };
  };
  NA.io.now = () => NOW; NA._resetForTests();
  const run = (items) => NA.detect({ cases: items.map(NA.parseCase), checklist: new Map(items.map((i) => ['2026-SV-050', true])), now: NOW }).filter((e) => e.kind === 'no-deadline');
  assert.equal(run([item()]).length, 1);
  assert.equal(run([item()])[0].why, 'No deadline is set for this client — neither a real deadline nor an imaginary one with a promised submission date.');
  assert.equal(NA.KINDS['no-deadline'].severity, 'medium');
  assert.equal(run([item({ type: 'Imaginary' })]).length, 0, 'set');
  assert.equal(run([item({ createdAgo: 60 * D })]).length, 0, 'opened before the question was asked');
  assert.equal(run([item({ stage: 'Application Submitted' })]).length, 0, 'closed');
  assert.equal(run([item({ group: 'group_mm3t4kda', title: 'Retainers before May 2026' })]).length, 0, 'legacy');
  // the case page
  const cockpit = require('../src/services/caseCockpitService');
  const restore = [stub(mondayApi, 'query', async () => ({ items: [{ column_values: [{ id: 'color_mm0x8faa', text: 'Document Collection Started' }, { id: 'color_mm6w7cdd', text: 'Imaginary' }, { id: 'date_mm3t66pa', text: '2026-12-15' }] }] }))];
  try {
    const d = await cockpit.readClientMaster('CM-1');
    assert.equal(d.clientDeadline, 'Imaginary — promised Dec 15, 2026');
  } finally { restore.forEach((r) => r()); }
  const page = require('fs').readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8');
  assert.ok(page.includes(`<span class="pk">Client deadline</span> ' + escHtml(d.clientDeadline)`) && page.includes('<span class="pk">SLA deadline</span>'));
});


/* ── review 2026-11-06: the dates reach the board; stale dates go; Retain is gated everywhere; the held send is released ── */

test('createLead itself writes the two date columns into create_item (the whitelist used to drop them)', async () => {
  const COLS = require('../src/data/newLeadsBoard.json').columns;
  const writes = [];
  const restore = [
    stub(mondayApi, 'query', async (q, v) => {
      if (/create_item/.test(q)) { writes.push(JSON.parse(v.cols)); return { create_item: { id: '9301' } }; }
      if (/change_multiple_column_values/.test(q)) return { change_multiple_column_values: { id: v.itemId } };
      return { boards: [{ groups: [{ items_page: { items: [] } }] }] };
    }),
    stub(require('../src/services/leadTokenService'), 'ensureToken', async () => 'tok'),
    stub(require('../src/services/oneDriveService'), 'ensureLeadFolder', () => new Promise(() => {})),
  ];
  try {
    await leadService.createLead({ fullName: 'A', email: 'a@x.com', sourceChannel: 'Phone', actualDeadline: '2099-01-15', promisedSubmissionDate: '2098-12-15' });
    assert.deepEqual(writes[0][COLS.actualDeadline], { date: '2099-01-15' });
    assert.deepEqual(writes[0][COLS.promisedSubmissionDate], { date: '2098-12-15' });
    writes.length = 0;
    await leadService.createLead({ fullName: 'B', email: 'b@x.com', sourceChannel: 'Phone' });
    assert.ok(!(COLS.actualDeadline in writes[0]) && !(COLS.promisedSubmissionDate in writes[0]), 'nothing written when there is no answer');
  } finally { restore.reverse().forEach((r) => r()); }
});

test('Direct retainer on an EXISTING lead: the dates the new answer lacks are cleared on the lead, so the case opens with the new answer; a blank answer (switch off) keeps what the lead holds', async () => {
  const handoff = require('../src/services/handoffService');
  const existing = { id: '777', fullName: 'Walkin Client', email: 'walkin@example.com', phone: '4165550100', sourceChannel: 'Website', deadlineType: 'Deadline', actualDeadline: '2099-01-15', promisedSubmissionDate: '2098-12-15' };
  const calls = { updates: [] };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...existing })),
    stub(leadService, 'updateLead', async (id, f, o) => { calls.updates.push({ id, f, o }); }),
    stub(mondayApi, 'query', async () => ({})),
    stub(registry, 'getCaseTypes', async () => { throw new Error('no monday in tests'); }),
    stub(handoff, 'openCaseEarly', async () => 'CM-1'),
  ];
  const stored = (link) => { const m = { ...existing, ...link.f }; for (const k of ((link.o && link.o.clearKeys) || [])) m[k] = ''; return m; };
  try {
    let r = await portal.createDirectClient({ ...DIRECT, linkLeadId: '777', deadlineType: 'Imaginary', promisedSubmissionDate: '2099-06-01' });
    assert.equal(r.linked, true);
    let link = calls.updates.find((u) => u.id === '777');
    assert.deepEqual(link.o.clearKeys, ['actualDeadline'], 'the old actual date goes');
    assert.deepEqual(handoff._internal.deadlineCellsOf(stored(link))[CM_COLS.type], { label: 'Imaginary' }, 'the case opens with the Imaginary answer');
    calls.updates.length = 0;
    r = await portal.createDirectClient({ ...DIRECT, linkLeadId: '777', deadlineType: 'Deadline', actualDeadline: '2099-03-01' });
    link = calls.updates.find((u) => u.id === '777');
    assert.deepEqual(link.o.clearKeys, ['promisedSubmissionDate'], 'a real deadline without a promised date drops the old promised date');
    assert.equal(stored(link).promisedSubmissionDate, '');
    calls.updates.length = 0;
    await withEnv({ DEADLINE_REQUIRED: '0' }, async () => {
      await portal.createDirectClient({ ...DIRECT, linkLeadId: '777' });
      link = calls.updates.find((u) => u.id === '777');
      assert.deepEqual(link.o.clearKeys, [], 'blank keeps the lead\'s own answer');
      assert.equal(stored(link).actualDeadline, '2099-01-15');
    })();
  } finally { restore.reverse().forEach((r) => r()); }
});

test('the outcome action: Retain is refused without the deadline (nothing written), allowed with it, and with the switch off', async () => {
  const base = { id: '1', fullName: 'A', email: 'a@b.co', retainerFee: '2000', outcome: '', confirmedCaseType: CASE_TYPE };
  const stubNotify = () => stub(portal, 'notifyOutcomeChange', async () => {});
  let w = actionWorld(base), n = stubNotify();
  try {
    await assert.rejects(portal.applyAction({ leadId: '1', action: 'outcome', value: 'Retain' }), (e) => e.badRequest && /Set the deadline first \(the Deadline box\)/.test(e.message));
    assert.equal(w.calls.updates.length, 0, 'the Outcome is not written');
    assert.equal((await portal.applyAction({ leadId: '1', action: 'outcome', value: 'Follow-Up' })).ok, true, 'other outcomes need no deadline');
  } finally { n(); w.done(); }
  w = actionWorld({ ...base, deadlineType: 'Imaginary', promisedSubmissionDate: '2099-12-15' }); n = stubNotify();
  try {
    assert.equal((await portal.applyAction({ leadId: '1', action: 'outcome', value: 'Retain' })).ok, true);
    assert.ok(w.calls.updates.some((u) => u.f.outcome === 'Retain'));
  } finally { n(); w.done(); }
  await withEnv({ DEADLINE_REQUIRED: '0' }, async () => {
    const w3 = actionWorld(base), n3 = stubNotify();
    try { assert.equal((await portal.applyAction({ leadId: '1', action: 'outcome', value: 'Retain' })).ok, true); } finally { n3(); w3.done(); }
  })();
});

test('the agreement send itself (Outcome=Retain typed on the board): held with a note until the deadline is set; a void-and-reissue is exempt; the switch off is exempt', async () => {
  const notes = [];
  const lead = { id: '1', fullName: 'A', email: '', outcome: 'Retain', retainerFee: '3000', retainerSent: '', retainerSigned: '', conversionStatus: 'Qualified' };
  const restore = [
    stub(leadService, 'getLead', async () => ({ ...lead })),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push(v.b || v.body); return {}; }),
  ];
  try {
    assert.deepEqual(await retainer.maybeSendRetainerAgreement('1', { notifyIfMissing: true }), { status: 'no-deadline' });
    assert.match(notes.pop(), /⚠ Outcome is set to "Retain", but the deadline is not set\. The retainer agreement has NOT been emailed yet/);
    assert.deepEqual(await retainer.maybeSendRetainerAgreement('1'), { status: 'no-deadline' });
    assert.equal(notes.length, 0, 'no note unless asked (a fee retype must not spam notes)');
    // a reissue corrects the agreement of a client already retained — it passes the gate and stops at the next check (no email here)
    assert.deepEqual(await retainer.maybeSendRetainerAgreement('1', { notifyIfMissing: true, assumeUnsent: true }), { status: 'no-email' });
    await withEnv({ DEADLINE_REQUIRED: '0' }, async () => {
      assert.deepEqual(await retainer.maybeSendRetainerAgreement('1'), { status: 'no-email' });
    })();
  } finally { restore.reverse().forEach((r) => r()); }
});

test('Save deadline on a lead already set to Retain with no agreement out releases the held send (once, guarded); not when the agreement is out, not when the outcome is not Retain, not on a blank', async () => {
  const sends = [];
  const r1 = stub(retainer, 'maybeSendRetainerAgreement', async (id, o) => { sends.push({ id, o }); return { status: 'sent' }; });
  const value = JSON.stringify({ deadlineType: 'Deadline', actualDeadline: '2099-01-15' });
  let w = actionWorld({ id: '1', fullName: 'A', outcome: 'Retain', retainerFee: '3000', retainerSent: '' });
  try {
    const r = await portal.applyAction({ leadId: '1', action: 'saveDeadline', value });
    assert.deepEqual(sends, [{ id: '1', o: { notifyIfMissing: true } }]);
    assert.match(r.message, /The retainer agreement is being emailed to the client\./);
  } finally { w.done(); }
  sends.length = 0;
  w = actionWorld({ id: '1', fullName: 'A', outcome: 'Retain', retainerFee: '3000', retainerSent: '2026-11-01' });
  try { await portal.applyAction({ leadId: '1', action: 'saveDeadline', value }); assert.equal(sends.length, 0, 'already out'); } finally { w.done(); }
  w = actionWorld({ id: '1', fullName: 'A', outcome: 'Follow-Up', retainerFee: '3000' });
  try { await portal.applyAction({ leadId: '1', action: 'saveDeadline', value }); assert.equal(sends.length, 0, 'not Retain'); } finally { w.done(); }
  w = actionWorld({ id: '1', fullName: 'A', outcome: 'Retain', retainerFee: '3000', deadlineType: 'Deadline', actualDeadline: '2099-01-15' });
  try { await portal.applyAction({ leadId: '1', action: 'saveDeadline', value: JSON.stringify({}) }); assert.equal(sends.length, 0, 'a blank never sends'); } finally { w.done(); }
  r1();
});

test('Needs attention: the cut-off is the Toronto day (a case opened the evening of Nov 6 Toronto is not listed; Nov 7 is)', () => {
  const NA = require('../src/services/needsAttentionService');
  const NOW = Date.parse('2026-12-01T15:00:00Z');
  const item = (id, createdAt) => ({ id, name: 'Client', created_at: createdAt, group: { id: 'group_x', title: 'December 2026' }, updates: [],
    column_values: [['text_mm142s49', `2026-SV-0${id}`], ['color_mm0x8faa', 'Document Collection Started'], ['color_mm0x9fnn', 'Paid'], ['color_mm6w7cdd', '']].map(([cid, text]) => ({ id: cid, text, value: null })) });
  NA.io.now = () => NOW; NA._resetForTests();
  const items = [item('61', '2026-11-07T03:00:00Z'), item('62', '2026-11-07T06:00:00Z')];
  const out = NA.detect({ cases: items.map(NA.parseCase), checklist: new Map(items.map((i) => [`2026-SV-0${i.id}`, true])), now: NOW }).filter((e) => e.kind === 'no-deadline');
  assert.deepEqual(out.map((e) => e.caseRef), ['2026-SV-062']);
});
