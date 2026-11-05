'use strict';

// Team meeting point 8 (Faran 2026-11-05): Client Master gets a COPY of the consultation — eight columns filled
// when the case opens and kept up to date from the lead; NEW CASES ONLY (the hourly refresh touches only rows that
// already carry a copy); never on the case-opening critical path.

const test   = require('node:test');
const assert = require('node:assert/strict');

const copy      = require('../src/services/consultCopyService');
const mondayApi = require('../src/services/mondayApi');
const leadService = require('../src/services/leadService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const COLS = require('../src/data/clientMasterBoard.json').consultColumns;
const CM_BOARD = String(require('../config/monday').clientMasterBoardId);
function withEnv(vars, fn) {
  const saved = {}; for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const done = () => { for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } };
  try { const r = fn(); if (r && r.then) return r.finally(done); done(); return r; } catch (e) { done(); throw e; }
}
const env = { RENDER_URL: 'https://app.tdotimm.com/', CONSULT_COPY: null };

test('the facts: date, consultant, outcome, fee, source and the three links — from the lead, in plain words', () => withEnv(env, () => {
  const booked = { id: '101', bookingStatus: 'Booked', bookedSlot: '2026-11-03 10:00', consultationHeld: '2026-11-04', assignedConsultant: 'Shafoli Kapur', outcome: 'Follow-Up',
    squareConsultTxnId: 'SQ1', consultOption: JSON.stringify({ feeCents: 20000, paidCents: 22600 }), sourceChannel: 'Website', referredBy: 'Jane Roe',
    recordingLink: 'https://zoom.us/rec/share/abc', preConsultPdf: 'https://tdot-my.sharepoint.com/x.pdf' };
  assert.deepEqual(copy.factsFor(booked), {
    date: '2026-11-04', consultant: 'Shafoli Kapur', outcome: 'Follow-Up', fee: 'Paid online (booking link) · $226.00 incl. HST',
    source: 'Website · Referred by: Jane Roe', record: 'https://app.tdotimm.com/admin/consultation/101',
    recording: 'https://zoom.us/rec/share/abc', preConsult: 'https://tdot-my.sharepoint.com/x.pdf',
  }, 'Consultation Held wins over the booked day; no double slash after the host');
  const f = (over) => copy.factsFor({ id: '7', ...over });
  assert.equal(f({ bookingStatus: 'Booked', bookedSlot: '2026-11-03 10:00' }).date, '2026-11-03', 'no held date: the booked day');
  assert.equal(f({ bookingStatus: 'Abandoned', bookedSlot: '2026-11-03 10:00' }).date, '', 'an abandoned hold is no consultation');
  assert.equal(f({ consultationHeld: '2026-02-30' }).date, '', 'not a real day');
  assert.equal(f({ outcome: 'Don’t Retain — Ineligible' }).outcome, 'Follow-Up', 'an old label: what it means now');
  assert.equal(f({ outcome: 'Junk' }).outcome, '');
  assert.equal(f({ squareConsultTxnId: 'SQ', consultOption: JSON.stringify({ feeCents: 20000, paidCents: 20000 }) }).fee, 'Paid online (booking link) · $200.00', 'no HST: no "incl. HST"');
  assert.equal(f({ consultPayment: JSON.stringify({ kind: 'e-transfer', amountCents: 20000, hstCents: 2600, on: '2026-11-02', by: 'Melanie' }) }).fee, 'E-transfer $200.00 + HST $26.00 received 2026-11-02 · recorded by Melanie');
  assert.equal(f({ consultPayment: JSON.stringify({ kind: 'waived', on: '2026-11-02', by: 'Asmita' }) }).fee, 'Waived on 2026-11-02 · by Asmita');
  assert.equal(f({}).fee, '', 'nothing recorded: blank (never a placeholder)');
  const direct = f({ directClient: 'Yes', sourceChannel: 'Walk-in', originalChannel: 'Instagram', outcome: 'Retain' });
  assert.deepEqual([direct.outcome, direct.fee, direct.source], ['Direct retainer client — no consultation', 'n/a — direct retainer client (no consultation)', 'Walk-in · First came through: Instagram']);
  assert.equal(f({ sourceChannel: 'Direct Retainer' }).source, 'Direct retainer client', 'an old direct client (the marker was its source)');
  assert.equal(f({ recordingLink: 'javascript:alert(1)', preConsultPdf: 'not a url' }).recording, '');
  assert.equal(f({ preConsultPdf: 'ftp://x' }).preConsult, '');
}));

test('the cells: only what changed is written; the record link counts as the same when it names the same lead; a blank fact clears', () => {
  const want = { date: '2026-11-04', consultant: 'A', outcome: '', fee: 'X', source: '', record: 'https://app.tdotimm.com/admin/consultation/101', recording: '', preConsult: '' };
  const have = { date: '2026-11-04', consultant: 'B', outcome: 'Follow-Up', fee: 'X', source: '', record: 'https://tdot-automations.onrender.com/admin/consultation/101', recording: '', preConsult: '' };
  assert.deepEqual(copy.diffCells(want, have, COLS), { [COLS.consultant]: 'A', [COLS.outcome]: '' });
  assert.deepEqual(copy.diffCells(want, want, COLS), {});
  const fresh = copy.diffCells({ ...want, recording: 'https://r' }, Object.fromEntries(copy.KEYS.map((k) => [k, ''])), COLS);
  assert.deepEqual(fresh[COLS.date], { date: '2026-11-04' });
  assert.deepEqual(fresh[COLS.record], { url: 'https://app.tdotimm.com/admin/consultation/101', text: 'Open consultation record' });
  assert.deepEqual(fresh[COLS.recording], { url: 'https://r', text: 'Consultation recording' });
  assert.equal(copy.leadIdOfRecordUrl('https://x/admin/consultation/55?from=retainers'), '55');
  assert.equal(copy.leadIdOfRecordUrl('https://evil/admin/consultationX/55'), '');
  // reading the row back: links by their url, dates by their date
  const cells = copy.readCells([
    { id: COLS.record, text: 'Open consultation record - https://app/admin/consultation/9', value: JSON.stringify({ url: 'https://app/admin/consultation/9', text: 'Open consultation record' }) },
    { id: COLS.date, text: '2026-11-04', value: JSON.stringify({ date: '2026-11-04', changed_at: 'x' }) },
    { id: COLS.consultant, text: 'Shafoli', value: '"Shafoli"' },
  ], COLS);
  assert.deepEqual([cells.record, cells.date, cells.consultant, cells.fee], ['https://app/admin/consultation/9', '2026-11-04', 'Shafoli', '']);
});

test('case opened: ONE write of the filled cells onto the new case; a refused batch falls back cell by cell; a failure never throws; dormant without the columns; CONSULT_COPY=off stops it', () => withEnv(env, async () => {
  const lead = { id: '101', bookingStatus: 'Booked', bookedSlot: '2026-11-03 10:00', assignedConsultant: 'Shafoli Kapur', outcome: 'Retain' };
  let calls = [];
  let restore = stub(mondayApi, 'query', async (q, v) => { calls.push({ q, v }); return {}; });
  try {
    const r = await copy.copyOnCaseOpen('900', lead);
    assert.equal(r.written, 4);
    assert.equal(calls.length, 1, 'a new case: no read, one write');
    assert.match(calls[0].q, /change_multiple_column_values/);
    assert.equal(calls[0].v.i, '900'); assert.equal(calls[0].v.b, CM_BOARD);
    const cells = JSON.parse(calls[0].v.v);
    assert.deepEqual(Object.keys(cells).sort(), [COLS.date, COLS.consultant, COLS.outcome, COLS.record].sort(), 'only the facts there are');
    assert.ok(!/create_labels_if_missing/.test(calls[0].q));
  } finally { restore(); }
  // the batch is refused → one cell at a time; one bad cell loses no other
  calls = [];
  restore = stub(mondayApi, 'query', async (q, v) => { calls.push(v); const c = JSON.parse(v.v); if (Object.keys(c).length > 1 || c[COLS.outcome] !== undefined) throw new Error('ColumnValueException'); return {}; });
  try {
    const r = await copy.copyOnCaseOpen('900', lead);
    assert.equal(r.written, 3); assert.equal(r.failed.length, 1);
  } finally { restore(); }
  // Monday down: no throw
  restore = stub(mondayApi, 'query', async () => { throw new Error('monday down'); });
  try {
    const r = await copy.copyOnCaseOpen('900', lead);
    assert.equal(r.written, 0);
  } finally { restore(); }
  // off
  calls = [];
  restore = stub(mondayApi, 'query', async (q, v) => { calls.push(v); return {}; });
  try {
    await withEnv({ CONSULT_COPY: 'off' }, () => copy.copyOnCaseOpen('900', lead));
    const cfg = require('../src/data/clientMasterBoard.json'); const saved = cfg.consultColumns;
    delete cfg.consultColumns;
    try { assert.deepEqual(await copy.copyOnCaseOpen('900', lead), { skipped: 'off' }); } finally { cfg.consultColumns = saved; }
    assert.equal(calls.length, 0);
  } finally { restore(); }
}));

/** A tiny Client Master: rows with copy cells; items(ids) reads; change_multiple_column_values writes. */
function cmWorld(rows) {
  const writes = [];
  const fn = async (q, v) => {
    if (/change_multiple_column_values/.test(q)) { writes.push({ id: v.i, cells: JSON.parse(v.v) }); const row = rows[v.i]; if (row) Object.assign(row.cells, Object.fromEntries(Object.entries(JSON.parse(v.v)).map(([cid, val]) => [copy.KEYS.find((k) => COLS[k] === cid), val && typeof val === 'object' ? (val.url || val.date) : val]))); return {}; }
    if (/items\(ids/.test(q)) {
      const row = rows[String((v.i || [])[0])];
      if (!row) return { items: [] };
      return { items: [{ id: row.id, state: row.state || 'active', board: { id: row.board || CM_BOARD }, column_values: copy.KEYS.map((k) => (k === 'record' || k === 'recording' || k === 'preConsult')
        ? { id: COLS[k], text: row.cells[k] || '', value: row.cells[k] ? JSON.stringify({ url: row.cells[k] }) : null }
        : k === 'date' ? { id: COLS[k], text: row.cells[k] || '', value: row.cells[k] ? JSON.stringify({ date: row.cells[k] }) : null } : { id: COLS[k], text: row.cells[k] || '', value: null }) }] };
    }
    return {};
  };
  return { fn, writes };
}
const blank = () => Object.fromEntries(copy.KEYS.map((k) => [k, '']));

test('a REUSED case gets the copy only when it has none — another consultation’s copy is never overwritten', () => withEnv(env, async () => {
  const lead = { id: '102', assignedConsultant: 'Shermin', outcome: 'Retain' };
  let w = cmWorld({ 900: { id: '900', cells: { ...blank(), record: 'https://app.tdotimm.com/admin/consultation/101', consultant: 'Shafoli' } } });
  let restore = stub(mondayApi, 'query', w.fn);
  try {
    assert.deepEqual(await copy.copyOnCaseOpen('900', lead, { reused: true }), { skipped: 'other-consultation' });
    assert.equal(w.writes.length, 0);
  } finally { restore(); }
  w = cmWorld({ 900: { id: '900', cells: blank() } });
  restore = stub(mondayApi, 'query', w.fn);
  try {
    const r = await copy.copyOnCaseOpen('900', lead, { reused: true });
    assert.equal(r.written, 3);
    assert.equal(w.writes[0].cells[COLS.consultant], 'Shermin');
  } finally { restore(); }
  w = cmWorld({});
  restore = stub(mondayApi, 'query', w.fn);
  try { assert.deepEqual(await copy.copyOnCaseOpen('900', lead, { reused: true }), { skipped: 'no-row' }); } finally { restore(); }
}));

test('refresh: a later recording or fee reaches the copy (only the changed cells); a hand edit is put back; a row with no copy, a lead that moved or is gone, a row not on the board — left exactly as they are', () => withEnv(env, async () => {
  const anchored = (over = {}) => ({ ...blank(), record: 'https://app.tdotimm.com/admin/consultation/101', consultant: 'Shafoli', outcome: 'Retain', ...over });
  const lead = { id: '101', clientMasterItemId: '900', assignedConsultant: 'Shafoli', outcome: 'Retain', recordingLink: 'https://teams/rec', consultPayment: JSON.stringify({ kind: 'cash', amountCents: 20000, on: '2026-11-04', by: 'Melanie' }) };
  const w = cmWorld({ 900: { id: '900', cells: anchored({ consultant: 'Hand Edit' }) }, 901: { id: '901', cells: blank() }, 902: { id: '902', cells: anchored(), state: 'deleted' }, 903: { id: '903', cells: anchored(), board: '1' } });
  const leads = { 101: lead };
  const restore = [stub(mondayApi, 'query', w.fn), stub(leadService, 'getLead', async (id) => (leads[id] ? { ...leads[id] } : null))];
  try {
    const r = await copy.refreshCase('900');
    assert.equal(r.written, 3);
    assert.deepEqual(Object.keys(w.writes[0].cells).sort(), [COLS.consultant, COLS.fee, COLS.recording].sort(), 'only what changed');
    assert.equal(w.writes[0].cells[COLS.consultant], 'Shafoli', 'the hand edit is put back — the lead is the truth');
    assert.deepEqual(await copy.refreshCase('900'), { unchanged: true }, 'nothing to do the second time');
    assert.deepEqual(await copy.refreshCase('901'), { skipped: 'no-copy' }, 'opened before the copy existed: never filled (new cases only)');
    assert.deepEqual(await copy.refreshCase('902'), { skipped: 'no-row' }, 'in the recycle bin');
    assert.deepEqual(await copy.refreshCase('903'), { skipped: 'no-row' }, 'not on the Client Master board');
    leads[101] = { ...lead, clientMasterItemId: '' , caseDeleted: '2026-11-05 · X · Y' };
    assert.deepEqual(await copy.refreshCase('900'), { skipped: 'lead-moved' }, 'the case was deleted and the record kept / re-linked: frozen, never cleared');
    delete leads[101];
    assert.deepEqual(await copy.refreshCase('900'), { skipped: 'lead-gone' });
    assert.equal(w.writes.length, 1);
  } finally { restore.forEach((x) => x()); }
}));

test('hourly sweep: only rows that carry a copy; a differing one is re-read fresh before the write; capped; counts', () => withEnv(env, async () => {
  const anchored = (id, over = {}) => ({ id, cells: { ...blank(), record: `https://app.tdotimm.com/admin/consultation/${id}0`, consultant: 'A', ...over } });
  const rows = { 1: anchored('1'), 2: anchored('2', { consultant: 'stale' }), 3: { id: '3', cells: blank() }, 4: anchored('4', { consultant: 'stale' }), 5: anchored('5', { consultant: 'stale' }) };
  const leads = [
    { id: '10', clientMasterItemId: '1', assignedConsultant: 'A' },
    { id: '20', clientMasterItemId: '2', assignedConsultant: 'A' },
    { id: '40', clientMasterItemId: '999', assignedConsultant: 'A' },   // moved to another case
    { id: '50', clientMasterItemId: '5', assignedConsultant: 'A' },
  ];
  const w = cmWorld(rows);
  const restore = [
    stub(mondayApi, 'query', w.fn),
    stub(leadService, 'getLead', async (id) => { const l = leads.find((x) => x.id === String(id)); return l ? { ...l } : null; }),
    stub(copy.io, 'listCaseRows', async () => Object.values(rows).map((r) => ({ id: r.id, state: 'active', cells: { ...r.cells } }))),
    stub(copy.io, 'leads', async () => leads),
    stub(copy.io, 'sleep', async () => {}),
  ];
  try {
    const r = await copy.sweep({ cap: 1 });
    assert.equal(r.rows, 5); assert.equal(r.withCopy, 4, 'the row with no copy is not even looked at');
    assert.equal(r.differing, 2); assert.equal(r.written, 1); assert.equal(r.more, true, 'the cap is reported');
    assert.deepEqual(r.skipped, { 'lead-moved': 1 });
    assert.deepEqual(w.writes.map((x) => x.id), ['2']);
    const r2 = await copy.sweep({ cap: 10 });
    assert.equal(r2.written, 1);
    assert.deepEqual(w.writes.map((x) => x.id), ['2', '5']);
    assert.ok(!w.writes.some((x) => x.id === '3'), 'never fills a case that has no copy');
    await withEnv({ CONSULT_COPY: 'off' }, async () => assert.deepEqual(await copy.sweep(), { skipped: 'off' }));
  } finally { restore.forEach((x) => x()); }
}));

test('wiring: the copy is written after the race check and after Case Type, on the new case only (and a reused one), never on the "already handed off" return; hourly at :46', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../src/services/handoffService'), 'utf8');
  const fnStart = src.indexOf('async function _doHandoff(');
  const fnSrc = src.slice(fnStart, src.indexOf('\n}\n', fnStart));
  const iCopy = fnSrc.indexOf("copyOnCaseOpen(newId, lead)");
  assert.ok(iCopy > fnSrc.indexOf('Race') || iCopy > fnSrc.indexOf('already linked'), 'after the race check');
  assert.ok(iCopy > fnSrc.lastIndexOf('caseTypeSet'), 'after Case Type');
  assert.ok(fnSrc.indexOf("copyOnCaseOpen(existing.id, lead, { reused: true })") > 0);
  assert.ok(fnSrc.indexOf("already handed off") < fnSrc.indexOf('copyOnCaseOpen'), 'the already-linked return comes first');
  const sched = fs.readFileSync(require.resolve('../src/services/scheduler'), 'utf8');
  assert.ok(sched.includes("cron.schedule('46 * * * *', () =>\n    require('./consultCopyService').sweep()"));
  assert.ok(require('../src/services/leadSnapshot').SNAPSHOT_KEYS === undefined || require('../src/services/leadSnapshot').SNAPSHOT_KEYS.includes('recordingLink'));
  const snapSrc = fs.readFileSync(require.resolve('../src/services/leadSnapshot'), 'utf8');
  assert.ok(snapSrc.includes("'recordingLink', 'preConsultPdf',"));
});
