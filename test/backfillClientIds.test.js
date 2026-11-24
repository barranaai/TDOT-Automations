'use strict';

// scripts/backfill-client-ids.js (step 6, 2026-11-25): the dry run writes NOTHING but the check
// list; the apply is refused without every guard (live minting off, columns set up, a named
// admin, the answered sheet, the automations check, the typed count); it creates records through
// findOrCreate, reserves the numbers in one block, writes the Clients ID then the copies, keeps a
// checkpoint + apply log, resumes, is safe to run again, never renumbers, and never writes after
// a read that did not come back. Every board is a fake (the no-network guard backs it).

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const XLSX   = require('xlsx');

const script  = require('../scripts/backfill-client-ids');
const planner = require('../src/services/clientIdBackfillPlan');
const accounts = require('../src/services/clientAccountService');
const { normName } = require('../src/services/handoffService');
const shipped = require('../src/data/clientsBoard.json');
const LB      = require('../src/data/newLeadsBoard.json');

const NOW = Date.parse('2026-11-25T15:00:00Z');
const LIVE = { id: 'group_live', title: 'November 2026' };
const CFG = JSON.parse(JSON.stringify(shipped));
CFG.columns.clientId = 'text_cid';
CFG.cmLinkColumns.clientId = 'text_cmcid';
CFG.leadLinkColumns.clientId = 'text_leadcid';
const C = CFG.columns, L = CFG.cmLinkColumns, CM = planner.CM_COL, LC = LB.columns;
const ADMIN = 'boss@tdotimm.com';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cid-backfill-'));

/** A small Monday: Clients, Client Master and the Lead Board, plus the counter. */
function world() {
  const w = {
    mode: 'report', counter: { last: 0 }, nextId: 9000, lock: null, lockLog: [],
    clients: new Map(), cases: new Map(), leads: new Map(),
    calls: [], writes: [], blocks: [], hide: { case: new Set(), lead: new Set(), client: new Set() },
    crashAfterSleeps: Infinity, sleeps: 0,
  };
  w.addClient = (id, name, o = {}) => w.clients.set(String(id), { name, created: o.created || '2026-08-10T12:00:00Z', email: o.email || '', phone: o.phone || '', status: o.status || 'Active', mergedInto: '', cid: o.cid || '' });
  w.addCase = (id, name, o = {}) => w.cases.set(String(id), { name, created: o.created || '2026-04-02T10:00:00Z', group: o.group || LIVE, ref: o.ref || `2026-VV-${String(id).padStart(3, '0')}`, email: o.email || '', phone: o.phone || '', account: o.account || '', copy: o.copy || '' });
  w.addLead = (id, fullName, o = {}) => w.leads.set(String(id), { fullName, created: o.created || '2026-03-01T15:00:00Z', email: o.email || '', phone: o.phone || '', cm: o.cm ? String(o.cm) : '', account: o.account || '', copy: '' });
  const cells = (map, hide) => Object.entries(map).filter(([k]) => !hide.has(k)).map(([id, text]) => ({ id, text }));
  const io = {
    env: {},
    loadBoard: () => CFG,
    leadColumns: () => ({ ...LC, boardId: LB.boardId }),
    clientIdsMode: () => w.mode,
    isAdminEmail: (e) => e === ADMIN,
    readClients: async () => [...w.clients].map(([id, r]) => ({ id, name: r.name, created_at: r.created,
      column_values: cells({ [C.primaryEmail]: r.email, [C.phone]: r.phone, [C.dateOfBirth]: '', [C.status]: r.status, [C.mergedInto]: r.mergedInto, [C.clientId]: r.cid }, w.hide.client.has(id) ? new Set([C.clientId]) : new Set()) })),
    readCases: async () => [...w.cases].map(([id, r]) => ({ id, name: r.name, created_at: r.created, group: r.group,
      column_values: cells({ [CM.caseRef]: r.ref, [CM.clientEmail]: r.email, [CM.clientPhone]: r.phone, [CM.caseStage]: '', [L.clientAccountId]: r.account, [L.clientId]: r.copy }, w.hide.case.has(id) ? new Set([L.clientAccountId]) : new Set()) })),
    readLeads: async () => [...w.leads].map(([id, r]) => ({ id, name: r.fullName, created_at: r.created,
      column_values: cells({ [LC.fullName]: r.fullName, [LC.email]: r.email, [LC.phone]: r.phone, [LC.clientMasterItemId]: r.cm, [LC.clientAccountId]: r.account, [LC.retainerSigned]: '', [CFG.leadLinkColumns.clientId]: r.copy }, w.hide.lead.has(id) ? new Set([LC.clientAccountId]) : new Set()) })),
    peekCounter: async () => ({ state: 'ok', last: w.counter.last }),
    lockCounter: async (by) => { w.lockLog.push(['lock', by]); if (w.lockFails) return { ok: false, message: 'the counter could not be read' }; const already = !!w.lock; if (!w.lock) w.lock = { by }; return { ok: true, already }; },
    unlockCounter: async () => { w.lockLog.push(['unlock']); const had = !!w.lock; w.lock = null; return { ok: true, cleared: had }; },
    allocateBlock: async (k) => { const first = w.counter.last + 1; w.counter.last += k; w.blocks.push({ first, last: w.counter.last }); w.calls.push(['block', k]); return { ok: true, first, last: w.counter.last, count: k }; },
    findOrCreate: async (p) => {
      w.calls.push(['findOrCreate', p.fullName]);
      const e = accounts.normalizeEmail(p.email);
      for (const [id, r] of w.clients) if (r.status === 'Active' && e && accounts.normalizeEmail(r.email) === e && normName(r.name) === normName(p.fullName)) return { clientId: id, created: false };
      const id = String(w.nextId++);
      w.addClient(id, p.fullName, { email: e, phone: p.phone, created: new Date(NOW).toISOString() });
      w.writes.push(['create', id, p.fullName, p.source]);
      return { clientId: id, created: true };
    },
    linkCase: async (accountId, { cmItemId, clientIdText }) => { const r = w.cases.get(String(cmItemId)); r.account = String(accountId); if (clientIdText) r.copy = clientIdText; w.writes.push(['linkCase', cmItemId, accountId, clientIdText]); },
    linkLead: async (accountId, leadId, { clientIdText }) => { const r = w.leads.get(String(leadId)); r.account = String(accountId); if (clientIdText) r.copy = clientIdText; w.writes.push(['linkLead', leadId, accountId, clientIdText]); },
    readIdCell: async (cfg, id) => { const r = w.clients.get(String(id)); if (!r) return { state: 'not-found' }; if (w.hide.client.has(String(id))) return { state: 'unreadable' }; return { state: 'ok', text: r.cid }; },
    writeIdCell: async (cfg, id, value) => { w.clients.get(String(id)).cid = value; w.writes.push(['id', id, value]); },
    writeText: async (board, item, col, value) => {
      if (col === L.clientId) w.cases.get(String(item)).copy = value;
      else w.leads.get(String(item)).copy = value;
      w.writes.push(['copy', item, value]);
    },
    sleep: async () => { if (++w.sleeps > w.crashAfterSleeps) throw new Error('simulated crash'); },
    now: () => NOW,
    fs,
    xlsx: () => XLSX,
  };
  w.io = io;
  return w;
}

const run = (w, argv) => { const lines = []; return script.run({ argv, io: w.io, log: (m) => lines.push(m) }).then((r) => ({ ...r, lines })); };

/** Answer the check list: { key: { same?, give? } } → a new answered file. */
function answer(file, answers) {
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  const ws = wb.Sheets.People;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  rows.forEach((r, i) => {
    const a = answers[r[0]];
    if (!a || i === 0) return;
    if (a.same) ws[XLSX.utils.encode_cell({ r: i, c: planner.SHEET_HEADERS.indexOf('Same person? (Y/N)') })] = { t: 's', v: a.same };
    if (a.give) ws[XLSX.utils.encode_cell({ r: i, c: planner.SHEET_HEADERS.indexOf('Give a Client ID? (Y/N)') })] = { t: 's', v: a.give };
  });
  const out = file.replace(/\.xlsx$/, '-answered.xlsx');
  fs.writeFileSync(out, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return out;
}

/** The office in miniature. */
function office() {
  const w = world();
  w.addClient(10, 'Has Id', { email: 'has@x.com', cid: 'CL-2025-00003' });
  w.addClient(11, 'Linked No Id', { email: 'lni@x.com' });
  w.addClient(12, 'Consult Only', { email: 'co@x.com' });
  w.counter.last = 3;
  w.addCase(101, 'Has Id', { email: 'has@x.com', account: '10', copy: 'CL-2025-00003' });
  w.addCase(102, 'Linked No Id', { email: 'lni@x.com', account: '11' });
  w.addCase(103, 'John Doe', { email: 'fam@x.com' });
  w.addCase(104, 'Jane Doe', { email: 'fam@x.com' });
  w.addCase(105, 'Walk In', { phone: '4165550101' });
  w.addCase(106, 'Walk In', { phone: '14165550101', ref: '2025-VV-002' });
  w.addCase(107, 'Someone', { group: { id: 'group_mm3842s', title: 'TEST' }, email: 't@x.com' });
  w.addLead(201, 'John Doe', { cm: 103, email: 'fam@x.com' });
  w.addLead(202, 'Consult Only', { email: 'co@x.com', account: '12' });
  return w;
}

test('the dry run writes NOTHING to Monday or OneDrive — only the check list (People · Summary · Left out)', async () => {
  const w = office();
  for (const k of ['allocateBlock', 'findOrCreate', 'linkCase', 'linkLead', 'writeIdCell', 'writeText']) w.io[k] = async () => { throw new Error(`${k} called in a dry run`); };
  const out = tmp();
  const r = await run(w, ['--out', out]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'dry-run');
  assert.ok(fs.existsSync(r.file));
  assert.equal(fs.readdirSync(out).length, 1, 'no checkpoint, no log');
  const wb = XLSX.read(fs.readFileSync(r.file), { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Summary', 'People', 'Left out'], 'the workbook opens on how to answer');
  assert.ok(wb.Sheets.People['!autofilter'], 'a filter on every column of People');
  const sum = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1, defval: '' });
  assert.match(sum.find((r) => r[0] === 'Made')[1], /\(Toronto\)$/, '"Made" in Toronto time');
  const people = XLSX.utils.sheet_to_json(wb.Sheets.People, { defval: '' });
  assert.deepEqual(Object.keys(people[0]), planner.SHEET_HEADERS);
  const amber = people.find((p) => p.Bucket === 'AMBER');
  assert.equal(amber.Key, 'G:103+104');
  assert.equal(amber['Same person? (Y/N)'], '');
  assert.ok(people.some((p) => p.Bucket === 'NO-CASE' && p.Key === 'A12'));
  assert.ok(people.some((p) => /CL-2025-00003 \(has it\)/.test(p['Proposed ID'])));
  const walk = people.find((p) => p.Name === 'Walk In');
  assert.equal(walk['Proposed ID'], 'CL-2025-00004', 'the 2025 case number puts the walk-in first, after the counter');
  const left = XLSX.utils.sheet_to_json(wb.Sheets['Left out'], { defval: '' });
  assert.ok(left.some((x) => /TEST group/.test(x.Why)));
  assert.ok(r.lines.some((l) => /Year counts: 2025: 2 · 2026: \d/.test(l)));
  assert.ok(r.lines.some((l) => /DRY RUN/.test(l)));
});

test('the apply is refused without every guard — and writes nothing', async () => {
  const w = office();
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  const file = dry.file;
  const base = ['--apply', '--out', out, '--decisions', file, '--admin', ADMIN, '--automations-checked'];
  w.mode = 'on';
  const on = await run(w, base);
  assert.equal(on.reason, 'live-on');
  assert.match(on.message, /on this machine/);
  w.mode = 'report';
  assert.equal((await run(w, base.filter((a) => a !== ADMIN).concat(['--admin', 'someone@x.com']))).reason, 'not-admin');
  assert.equal((await run(w, ['--apply', '--out', out, '--admin', ADMIN, '--automations-checked'])).reason, 'no-decisions');
  assert.equal((await run(w, base.filter((a) => a !== '--automations-checked'))).reason, 'automations');
  const wrong = await run(w, [...base, '--confirm', 'yes please']);
  assert.equal(wrong.reason, 'confirm');
  assert.match(wrong.message, /--confirm "GIVE 4 CLIENT IDS"/);
  const saved = CFG.columns.clientId; CFG.columns.clientId = null;
  try { assert.equal((await run(w, base)).reason, 'not-configured'); } finally { CFG.columns.clientId = saved; }
  assert.equal(w.writes.length, 0);
  assert.equal(w.blocks.length, 0);
  assert.ok(!fs.existsSync(path.join(out, 'apply-checkpoint.json')));
});

test('the apply: records through findOrCreate, one block, IDs in first-seen order, then the copies; a log and a checkpoint', async () => {
  const w = office();
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  const answered = answer(dry.file, { 'G:103+104': { same: 'N' }, A12: { give: 'Y' } });
  const r = await run(w, ['--apply', '--out', out, '--decisions', answered, '--admin', ADMIN, '--automations-checked', '--confirm', 'GIVE 5 CLIENT IDS']);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(w.blocks, [{ first: 4, last: 8 }], 'one reservation for all of them');
  assert.equal(w.clients.get('10').cid, 'CL-2025-00003', 'never renumbered');
  const ids = [...w.clients.values()].map((c) => c.cid).filter(Boolean).sort();
  assert.equal(new Set(ids).size, ids.length, 'no number twice');
  // the walk-in (2025) is first, then the 2026 people
  const walk = [...w.clients.values()].find((c) => c.name === 'Walk In');
  assert.equal(walk.cid, 'CL-2025-00004');
  assert.equal(w.cases.get('105').account, w.cases.get('106').account, 'both walk-in cases on one record');
  assert.equal(w.cases.get('105').copy, 'CL-2025-00004');
  // spouses: two people, two records, two IDs
  assert.notEqual(w.cases.get('103').account, w.cases.get('104').account);
  assert.ok(isId(w.cases.get('103').copy) && isId(w.cases.get('104').copy) && w.cases.get('103').copy !== w.cases.get('104').copy);
  assert.equal(w.leads.get('201').account, w.cases.get('103').account, 'the consultation record follows its case');
  assert.equal(w.leads.get('201').copy, w.cases.get('103').copy);
  // NO-CASE with a Y
  assert.ok(isId(w.clients.get('12').cid));
  assert.ok(isId(w.leads.get('202').copy));
  // the existing record without an ID got one, and its case copy
  assert.equal(w.cases.get('102').copy, w.clients.get('11').cid);
  // created through findOrCreate, labelled 'backfill'
  assert.ok(w.writes.filter((x) => x[0] === 'create').every((x) => x[3] === 'backfill'));
  assert.equal(w.writes.filter((x) => x[0] === 'create').length, 3);
  // TEST row untouched
  assert.equal(w.cases.get('107').account, '');
  // log + checkpoint
  const log = fs.readFileSync(path.join(out, 'apply-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.kind === 'create-record'));
  assert.ok(log.some((e) => e.kind === 'cell' && e.to === 'CL-2025-00004'));
  assert.ok(log.every((e) => e.admin === ADMIN));
  const cp = JSON.parse(fs.readFileSync(path.join(out, 'apply-checkpoint.json'), 'utf8'));
  assert.ok(cp.finishedAt);
  assert.equal(Object.keys(cp.done).length, 6);
});
const isId = (v) => /^CL-\d{4}-\d{5,}$/.test(String(v || ''));

test('safe to run again: the same command does nothing more; a fresh run finds nothing to give', async () => {
  const w = office();
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  const args = ['--apply', '--out', out, '--decisions', dry.file, '--admin', ADMIN, '--automations-checked'];
  await run(w, [...args, '--confirm', 'GIVE 4 CLIENT IDS']);
  const before = JSON.stringify([...w.clients]) + JSON.stringify([...w.cases]) + JSON.stringify([...w.leads]);
  const n = w.writes.length;
  const again = await run(w, [...args, '--confirm', 'GIVE 0 CLIENT IDS']);
  assert.equal(again.ok, true, again.message);
  assert.equal(w.writes.length, n, 'nothing written');
  const fresh = await run(w, ['--apply', '--out', tmp(), '--decisions', dry.file, '--admin', ADMIN, '--automations-checked', '--confirm', 'GIVE 0 CLIENT IDS']);
  assert.equal(fresh.ok, true, fresh.message);
  assert.equal(w.writes.length, n);
  assert.equal(w.blocks.length, 1);
  assert.equal(JSON.stringify([...w.clients]) + JSON.stringify([...w.cases]) + JSON.stringify([...w.leads]), before);
});

test('resume: a run stopped half way picks up from the checkpoint — no second block, no second record, no number twice', async () => {
  const w = office();
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  const args = ['--apply', '--out', out, '--decisions', dry.file, '--admin', ADMIN, '--automations-checked'];
  w.crashAfterSleeps = 3;
  await assert.rejects(run(w, [...args, '--confirm', 'GIVE 4 CLIENT IDS']), /simulated crash/);
  const cp = JSON.parse(fs.readFileSync(path.join(out, 'apply-checkpoint.json'), 'utf8'));
  assert.equal(cp.blocks.length, 1);
  w.crashAfterSleeps = Infinity;
  assert.equal(w.lock, null, 'the lock is cleared even when the run stops with an error');
  // "resume = run the same command again": the phrase it was started with still counts
  const r = await run(w, [...args, '--confirm', 'GIVE 4 CLIENT IDS']);
  assert.equal(r.ok, true, r.message);
  assert.equal(w.blocks.length, 1, 'the numbers reserved before the stop are used');
  const creates = w.writes.filter((x) => x[0] === 'create').map((x) => x[2]);
  assert.equal(new Set(creates).size, creates.length, 'no record made twice');
  const ids = [...w.clients.values()].map((c) => c.cid).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 5, 'the 4 new + the one kept');
  const nums = ids.map((v) => Number(v.slice(-5))).sort((a, b) => a - b);
  assert.deepEqual(nums, [3, 4, 5, 6, 7]);
});

test('resume with the old phrase is refused when MORE people would be numbered than it said', async () => {
  const w = office();
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  const args = ['--apply', '--out', out, '--decisions', dry.file, '--admin', ADMIN, '--automations-checked'];
  w.crashAfterSleeps = 3;
  await assert.rejects(run(w, [...args, '--confirm', 'GIVE 4 CLIENT IDS']), /simulated crash/);
  w.crashAfterSleeps = Infinity;
  w.addCase(120, 'Brand New', { email: 'bn@x.com' });   // two new people since the start
  w.addCase(121, 'Also New', { email: 'an@x.com' });
  const n = w.writes.length;
  const old = await run(w, [...args, '--confirm', 'GIVE 4 CLIENT IDS']);
  assert.equal(old.reason, 'confirm');
  assert.match(old.message, /--confirm "GIVE 5 CLIENT IDS"/, 'the phrase for what is left now');
  assert.equal(w.writes.length, n, 'nothing written');
});

test('the counter is LOCKED for the apply (the live server\'s switch cannot be seen from here) and unlocked at the end; a lock that cannot be set stops it before any write', async () => {
  const w = office();
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  assert.deepEqual(w.lockLog, [], 'the dry run never locks');
  const args = ['--apply', '--out', out, '--decisions', dry.file, '--admin', ADMIN, '--automations-checked', '--confirm', 'GIVE 4 CLIENT IDS'];
  w.lockFails = true;
  const no = await run(w, args);
  assert.equal(no.reason, 'lock');
  assert.equal(w.writes.length, 0); assert.equal(w.blocks.length, 0);
  w.lockFails = false; w.lockLog = [];
  let lockedDuringWrites = true;
  const keepWrite = w.io.writeIdCell;
  w.io.writeIdCell = async (...a) => { if (!w.lock) lockedDuringWrites = false; return keepWrite(...a); };
  const r = await run(w, args);
  assert.equal(r.ok, true, r.message);
  assert.ok(lockedDuringWrites, 'every ID written while the lock is in');
  assert.deepEqual(w.lockLog, [['lock', ADMIN], ['unlock']]);
  assert.equal(w.lock, null);
  // --unlock alone (after a stopped apply): named admin only
  w.lock = { by: ADMIN };
  assert.equal((await run(w, ['--unlock'])).reason, 'not-admin');
  const un = await run(w, ['--unlock', '--admin', ADMIN]);
  assert.equal(un.ok, true); assert.equal(un.cleared, true); assert.equal(w.lock, null);
  const src = fs.readFileSync(require.resolve('../scripts/backfill-client-ids'), 'utf8');
  assert.match(src, /lockCounter: \(by\) => allocator\.setBackfillLock\(\{ by \}\)/);
  assert.match(src, /unlockCounter: \(\) => allocator\.clearBackfillLock\(\)/);
});

test('an answer that is not Y or N stops the apply — never read as blank (two permanent IDs)', async () => {
  const w = office();
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  const answered = answer(dry.file, { 'G:103+104': { same: 'Yes, same' } });
  const r = await run(w, ['--apply', '--out', out, '--decisions', answered, '--admin', ADMIN, '--automations-checked', '--confirm', 'GIVE 4 CLIENT IDS']);
  assert.equal(r.reason, 'unclear-answers');
  assert.match(r.message, /G:103\+104 \(John Doe \/ Jane Doe\)|G:103\+104 \(Jane Doe \/ John Doe\)/);
  assert.equal(w.writes.length, 0); assert.equal(w.blocks.length, 0); assert.deepEqual(w.lockLog, []);
});

test('a sorted answered sheet gives the numbers the dry run proposed', async () => {
  const w = office();
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  const proposed = Object.fromEntries(dry.plan.people.filter((p) => p.gets).map((p) => [p.anchor, p.proposedId]));
  // sort People by Name, as in Excel
  const wb = XLSX.read(fs.readFileSync(dry.file), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.People, { defval: '' }).sort((a, b) => String(a.Name).localeCompare(String(b.Name)));
  wb.Sheets.People = XLSX.utils.json_to_sheet(rows, { header: planner.SHEET_HEADERS });
  const sorted = dry.file.replace(/\.xlsx$/, '-sorted.xlsx');
  fs.writeFileSync(sorted, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const r = await run(w, ['--apply', '--out', out, '--decisions', sorted, '--admin', ADMIN, '--automations-checked', '--confirm', 'GIVE 4 CLIENT IDS']);
  assert.equal(r.ok, true, r.message);
  const cp = JSON.parse(fs.readFileSync(path.join(out, 'apply-checkpoint.json'), 'utf8'));
  for (const [anchor, id] of Object.entries(proposed)) assert.equal(cp.done[anchor].clientId, id, `${anchor} got the number it was proposed`);
});

test('a record findOrCreate finds by the CLEANED name that the check list gives to another person is never used (Gauri\'s N stands)', async () => {
  const w = world();
  w.addClient(900, 'Raj Kumar', { email: 'r@x.com' });
  w.addCase(1, 'Raj Kumar', { email: 'r@x.com', account: '900' });
  w.addCase(2, 'Raj Kumar (2726)', { email: 'r@x.com' });
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  const amber = dry.plan.rows.find((r) => r.bucket === 'AMBER');
  assert.equal(amber.key, 'G:1+2');
  const answered = answer(dry.file, { 'G:1+2': { same: 'N' } });
  const r = await run(w, ['--apply', '--out', out, '--decisions', answered, '--admin', ADMIN, '--automations-checked', '--confirm', 'GIVE 2 CLIENT IDS']);
  assert.equal(r.ok, true, r.message);
  assert.equal(w.cases.get('2').account, '', 'case 2 is NOT joined to record 900');
  assert.equal(w.cases.get('2').copy, '');
  assert.ok(r.done.skipped.some((x) => /Raj Kumar: matches Raj Kumar's client record exactly, but the check list says they are different people/.test(x)));
  assert.ok(/^CL-/.test(w.clients.get('900').cid), 'record 900 still gets its own ID');
  const log = fs.readFileSync(path.join(out, 'apply-log.jsonl'), 'utf8');
  assert.match(log, /"kind":"skip-claimed"/);
});

test('an answered "same person" group that changed since the sheet was made: refused, nothing written', async () => {
  const w = office();
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  const answered = answer(dry.file, { 'G:103+104': { same: 'Y' } });
  w.addCase(108, 'June Doe', { email: 'fam@x.com' });
  const r = await run(w, ['--apply', '--out', out, '--decisions', answered, '--admin', ADMIN, '--automations-checked', '--confirm', 'GIVE 5 CLIENT IDS']);
  assert.equal(r.reason, 'changed');
  assert.ok(r.lines.some((l) => /G:103\+104/.test(l)));
  assert.equal(w.writes.length, 0);
  assert.equal(w.blocks.length, 0);
});

test('a Y joins the spouses-style group into one person with one ID', async () => {
  const w = office();
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  const answered = answer(dry.file, { 'G:103+104': { same: 'Y' } });
  const r = await run(w, ['--apply', '--out', out, '--decisions', answered, '--admin', ADMIN, '--automations-checked', '--confirm', 'GIVE 3 CLIENT IDS']);
  assert.equal(r.ok, true, r.message);
  assert.equal(w.cases.get('103').account, w.cases.get('104').account);
  assert.equal(w.cases.get('103').copy, w.cases.get('104').copy);
});

test('never written after a read that did not come back, never over a hand-typed value', async () => {
  const w = office();
  w.hide.case.add('102');        // its client-record box did not come back
  w.hide.lead.add('201');
  w.clients.get('12').cid = 'cl 77';   // typed by hand, not a Client ID
  const out = tmp();
  const dry = await run(w, ['--out', out]);
  const answered = answer(dry.file, { A12: { give: 'Y' } });
  const r = await run(w, ['--apply', '--out', out, '--decisions', answered, '--admin', ADMIN, '--automations-checked', '--confirm', 'GIVE 3 CLIENT IDS']);
  assert.equal(r.ok, true, r.message);
  assert.equal(w.cases.get('102').copy, '', 'the unread case is left alone');
  assert.ok(!w.writes.some((x) => x[0] === 'linkCase' && x[1] === '102'));
  assert.ok(!w.writes.some((x) => x[0] === 'linkLead' && x[1] === '201'));
  assert.equal(w.clients.get('12').cid, 'cl 77', 'never typed over');
});

test('the script is a dry run by default and loads nothing live in the tests', () => {
  const src = fs.readFileSync(require.resolve('../scripts/backfill-client-ids'), 'utf8');
  assert.match(src, /const apply = !!args\.apply/);
  assert.ok(/function realIo\(\)\s*\{\s*require\('dotenv'\)/.test(src), 'dotenv and the Monday client load only for a real run');
  assert.ok(!/items\(ids:\[\$id\]\)\{/.test(src.replace(/items\(ids:\[\$id\], limit:1\)/g, '')), 'items(ids:) always with a limit');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8').includes('backfill-client-ids/'), 'the check lists (names, emails, phones) are never committed');
  assert.deepEqual(script.parseArgs(['--apply', '--confirm', 'GIVE 2 CLIENT IDS', '--automations-checked']), { apply: true, confirm: 'GIVE 2 CLIENT IDS', 'automations-checked': true });
  assert.equal(script.confirmPhrase(12), 'GIVE 12 CLIENT IDS');
});
