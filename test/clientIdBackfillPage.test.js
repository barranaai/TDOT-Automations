'use strict';

// The Client ID backfill on the server (2026-11-25): the admin page /admin/client-ids/backfill,
// its background runs (clientIdBackfillJobs) and the shared apply (clientIdBackfillRun) with
// everything kept on OneDrive. Every board, the counter and OneDrive are fakes (the no-network
// guard backs it): upload → preview counts; the refusals; the background run's progress; a run
// cut off by a restart and resumed from the OneDrive checkpoint; the unlock; a newer checkpoint
// stops the run and leaves the lock; the Monday backoff; no names in the server log.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const XLSX   = require('xlsx');

const script   = require('../scripts/backfill-client-ids');
const planner  = require('../src/services/clientIdBackfillPlan');
const backfill = require('../src/services/clientIdBackfillRun');
const jobs     = require('../src/services/clientIdBackfillJobs');
const pageMod  = require('../src/routes/clientIdBackfillPage');
const accounts = require('../src/services/clientAccountService');
const { normName } = require('../src/services/handoffService');
const shipped  = require('../src/data/clientsBoard.json');
const LB       = require('../src/data/newLeadsBoard.json');

const NOW = Date.parse('2026-11-25T15:00:00Z');
const LIVE = { id: 'group_live', title: 'November 2026' };
const CFG = JSON.parse(JSON.stringify(shipped));
CFG.columns.clientId = 'text_cid';
CFG.cmLinkColumns.clientId = 'text_cmcid';
CFG.leadLinkColumns.clientId = 'text_leadcid';
const C = CFG.columns, L = CFG.cmLinkColumns, CM = planner.CM_COL, LC = LB.columns;
const ADMIN = 'boss@tdotimm.com';
const NAMES = ['Has Id', 'Linked No Id', 'Consult Only', 'John Doe', 'Jane Doe', 'Walk In'];
const isId = (v) => /^CL-\d{4}-\d{5,}$/.test(String(v || ''));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cid-bfpage-'));

/* ───────── a small Monday + the counter (with its lock) ───────── */
function world() {
  const w = {
    mode: 'report', counter: { last: 0 }, nextId: 9000, lock: null, clock: NOW,
    clients: new Map(), cases: new Map(), leads: new Map(),
    writes: [], blocks: [], sleeps: 0, hangAfter: Infinity, crashAfter: Infinity, serverLog: [],
  };
  w.addClient = (id, name, o = {}) => w.clients.set(String(id), { name, created: o.created || '2026-08-10T12:00:00Z', email: o.email || '', phone: o.phone || '', status: o.status || 'Active', mergedInto: '', cid: o.cid || '' });
  w.addCase = (id, name, o = {}) => w.cases.set(String(id), { name, created: o.created || '2026-04-02T10:00:00Z', group: o.group || LIVE, ref: o.ref || `2026-VV-${String(id).padStart(3, '0')}`, email: o.email || '', phone: o.phone || '', account: o.account || '', copy: o.copy || '' });
  w.addLead = (id, fullName, o = {}) => w.leads.set(String(id), { fullName, created: o.created || '2026-03-01T15:00:00Z', email: o.email || '', phone: o.phone || '', cm: o.cm ? String(o.cm) : '', account: o.account || '', copy: '' });
  const cells = (map) => Object.entries(map).map(([id, text]) => ({ id, text }));
  w.io = {
    loadBoard: () => CFG,
    leadColumns: () => ({ ...LC, boardId: LB.boardId }),
    clientIdsMode: () => w.mode,
    isAdminEmail: (e) => e === ADMIN,
    readClients: async () => [...w.clients].map(([id, r]) => ({ id, name: r.name, created_at: r.created,
      column_values: cells({ [C.primaryEmail]: r.email, [C.phone]: r.phone, [C.dateOfBirth]: '', [C.status]: r.status, [C.mergedInto]: r.mergedInto, [C.clientId]: r.cid }) })),
    readCases: async () => [...w.cases].map(([id, r]) => ({ id, name: r.name, created_at: r.created, group: r.group,
      column_values: cells({ [CM.caseRef]: r.ref, [CM.clientEmail]: r.email, [CM.clientPhone]: r.phone, [CM.caseStage]: '', [L.clientAccountId]: r.account, [L.clientId]: r.copy }) })),
    readLeads: async () => [...w.leads].map(([id, r]) => ({ id, name: r.fullName, created_at: r.created,
      column_values: cells({ [LC.fullName]: r.fullName, [LC.email]: r.email, [LC.phone]: r.phone, [LC.clientMasterItemId]: r.cm, [LC.clientAccountId]: r.account, [LC.retainerSigned]: '', [CFG.leadLinkColumns.clientId]: r.copy }) })),
    peekCounter: async () => ({ state: 'ok', last: w.counter.last, ...(w.lock ? { backfill: w.lock } : {}) }),
    lockCounter: async (by) => { if (w.lock) return { ok: true, already: true, last: w.counter.last, lock: w.lock }; w.lock = { by, at: new Date(w.clock).toISOString() }; return { ok: true, already: false, last: w.counter.last, lock: w.lock }; },
    unlockCounter: async () => { const had = !!w.lock; w.lock = null; return { ok: true, cleared: had }; },
    allocateBlock: async (k) => { const first = w.counter.last + 1; w.counter.last += k; w.blocks.push({ first, last: w.counter.last }); return { ok: true, first, last: w.counter.last, count: k }; },
    findOrCreate: async (p) => {
      const e = accounts.normalizeEmail(p.email);
      for (const [id, r] of w.clients) if (r.status === 'Active' && e && accounts.normalizeEmail(r.email) === e && normName(r.name) === normName(p.fullName)) return { clientId: id, created: false };
      const id = String(w.nextId++);
      w.addClient(id, p.fullName, { email: e, phone: p.phone, created: new Date(NOW).toISOString() });
      w.writes.push(['create', id, p.fullName, p.source]);
      return { clientId: id, created: true };
    },
    linkCase: async (accountId, { cmItemId, clientIdText }) => { const r = w.cases.get(String(cmItemId)); r.account = String(accountId); if (clientIdText) r.copy = clientIdText; w.writes.push(['linkCase', cmItemId]); },
    linkLead: async (accountId, leadId, { clientIdText }) => { const r = w.leads.get(String(leadId)); r.account = String(accountId); if (clientIdText) r.copy = clientIdText; w.writes.push(['linkLead', leadId]); },
    readIdCell: async (cfg, id) => { const r = w.clients.get(String(id)); if (!r) return { state: 'not-found' }; return { state: 'ok', text: r.cid }; },
    writeIdCell: async (cfg, id, value) => { w.clients.get(String(id)).cid = value; w.writes.push(['id', id, value]); },
    writeText: async (board, item, col, value) => { if (col === L.clientId) w.cases.get(String(item)).copy = value; else w.leads.get(String(item)).copy = value; w.writes.push(['copy', item, value]); },
    sleep: async () => {
      w.sleeps++;
      if (w.sleeps > w.hangAfter) return new Promise(() => {});      // the process "dies": nothing after this ever runs
      if (w.sleeps > w.crashAfter) throw new Error('simulated crash');
      if (w.onSleep) await w.onSleep(w.sleeps);
    },
    now: () => w.clock,
    fs, xlsx: () => XLSX,
  };
  return w;
}

/* ───────── OneDrive: files with eTags, the two write conditions ───────── */
function fakeDrive() {
  let v = 0;
  const d = {
    files: new Map(),
    put(p, body, etag) {
      const f = d.files.get(p);
      if (etag ? (!f || f.etag !== etag) : !!f) { const e = new Error(`${p} changed meanwhile`); e.conflict = true; throw e; }
      const ne = `"v${++v}"`;
      d.files.set(p, { body, etag: ne });
      return { etag: ne, created: !f };
    },
    async readJsonFile(p) { const f = d.files.get(p); return f ? { data: JSON.parse(f.body.toString('utf8')), etag: f.etag } : null; },
    async writeJsonFile(p, data, { etag = '' } = {}) { return d.put(p, Buffer.from(JSON.stringify(data)), etag); },
    async readSystemFile(p) { const f = d.files.get(p); return f ? { buffer: f.body, etag: f.etag } : null; },
    async writeSystemFile(p, content, { etag = '' } = {}) { return d.put(p, Buffer.isBuffer(content) ? content : Buffer.from(String(content)), etag); },
    json: (p) => JSON.parse(d.files.get(p).body.toString('utf8')),
  };
  return d;
}

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
  w.addLead(201, 'John Doe', { cm: 103, email: 'fam@x.com' });
  w.addLead(202, 'Consult Only', { email: 'co@x.com', account: '12' });
  return w;
}

/** The dry run's check list, answered: { key: { same?, give? } } → the .xlsx bytes. */
async function answeredSheet(w, answers = {}) {
  const out = tmp();
  const dry = await script.run({ argv: ['--out', out], io: w.io, log: () => {} });
  const wb = XLSX.read(fs.readFileSync(dry.file), { type: 'buffer' });
  const ws = wb.Sheets.People;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  rows.forEach((r, i) => {
    const a = answers[r[0]];
    if (!a || i === 0) return;
    if (a.same) ws[XLSX.utils.encode_cell({ r: i, c: planner.SHEET_HEADERS.indexOf('Same person? (Y/N)') })] = { t: 's', v: a.same };
    if (a.give) ws[XLSX.utils.encode_cell({ r: i, c: planner.SHEET_HEADERS.indexOf('Give a Client ID? (Y/N)') })] = { t: 's', v: a.give };
  });
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Wire the jobs to this world and this drive. */
function wire(w, drive) {
  jobs._resetForTests();
  jobs.deps.io = () => w.io;
  jobs.deps.drive = () => drive;
  jobs.deps.now = () => w.clock;
  jobs.deps.log = (...a) => w.serverLog.push(a.join(' '));
  jobs.deps.pauseMs = 0;
}
const settle = async () => { const j = jobs._current(); if (j) await j.promise; };

/* ───────── fake req / res for the route handlers ───────── */
function res() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.type = (t) => { r.ctype = t; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}
const routeDeps = {
  namedAdminCheck: (req) => (req.named ? { ok: true, actor: { name: 'Boss', email: ADMIN } } : { ok: false, status: req.signedIn ? 403 : 401, error: req.signedIn ? 'Only admins can run the Client ID backfill.' : 'Sign in with Monday to run the Client ID backfill.', ...(req.signedIn ? {} : { loginUrl: '/q/auth/monday' }) }),
  namedAdmin: (req, rs) => { if (req.named) return { name: 'Boss', email: ADMIN }; rs.status(req.signedIn ? 403 : 401).json({ error: 'Only admins can run the Client ID backfill.' }); return null; },
  resolveAdmin: (req, rs) => { if (req.named || req.admin) return { isAdmin: true }; rs.status(403).json({ error: 'admin-only' }); return null; },
};
const named = (body = {}, extra = {}) => ({ named: true, body, ...extra });

async function uploadAndCheck(w, drive, buffer) {
  const gateRes = res();
  let passed = false;
  pageMod.uploadGate(named(), gateRes, () => { passed = true; }, routeDeps);
  assert.ok(passed, 'a named admin passes the upload gate');
  const req = named({}, { file: { buffer, originalname: 'answered.xlsx' }, backfillActor: { name: 'Boss', email: ADMIN } });
  const r = res();
  await pageMod.upload(req, r, routeDeps);
  assert.equal(r.statusCode, 202, JSON.stringify(r.body));
  await settle();
  const st = jobs.jobState();
  return { sheetFile: r.body.sheetFile, job: st.job };
}

/* ═════════════════════════════ the tests ═════════════════════════════ */

test('upload → the sheet is saved on OneDrive (TDOT System) and the preview shows the counts and the exact phrase; nothing is written to Monday', async () => {
  const w = office(); const drive = fakeDrive(); wire(w, drive);
  const buf = await answeredSheet(w, { 'G:103+104': { same: 'N' }, A12: { give: 'Y' } });
  const { sheetFile, job } = await uploadAndCheck(w, drive, buf);
  assert.match(sheetFile, jobs.SHEET_RE);
  assert.ok(drive.files.has(`TDOT System/client-id-backfill/${sheetFile}`), 'the answered sheet is kept on OneDrive');
  assert.equal(drive.files.size, 1, 'nothing else is written at this step');
  assert.equal(w.writes.length, 0); assert.equal(w.blocks.length, 0); assert.equal(w.lock, null);
  assert.equal(job.kind, 'preview'); assert.equal(job.state, 'done');
  const pv = job.result;
  assert.equal(pv.newIds, 5);
  assert.equal(pv.newAccounts, 3);
  assert.equal(pv.firstNumber, 4); assert.equal(pv.lastNumber, 8);
  assert.equal(pv.phrase, 'GIVE 5 CLIENT IDS');
  assert.equal(pv.canGo, true);
  assert.deepEqual(pv.unclear, []); assert.deepEqual(pv.changed, []);
  assert.equal(pv.sheetFile, sheetFile);
});

test('the refusals: not a named admin, no tick, wrong phrase, CLIENT_IDS on, unclear answers, changed groups — nothing written', async () => {
  const w = office(); const drive = fakeDrive(); wire(w, drive);
  // not a named admin: the page, the upload gate, start and unlock
  const p = res(); pageMod.page({}, p, routeDeps);
  assert.equal(p.statusCode, 401); assert.match(p.body, /named admins only/); assert.match(p.body, /returnTo=%2Fadmin%2Fclient-ids%2Fbackfill/);
  const p2 = res(); pageMod.page({ signedIn: true }, p2, routeDeps); assert.equal(p2.statusCode, 403);
  const g = res(); let passed = false; pageMod.uploadGate({}, g, () => { passed = true; }, routeDeps); assert.equal(passed, false); assert.equal(g.statusCode, 401);
  const s1 = res(); await pageMod.start({ body: {} }, s1, routeDeps); assert.equal(s1.statusCode, 401);
  const u1 = res(); await pageMod.unlock({ body: { confirm: 'UNLOCK' } }, u1, routeDeps); assert.equal(u1.statusCode, 401);
  assert.equal((await jobs.startApply({ sheetFile: 'answered-2026-11-25T15-00-00-000Z-0a0b.xlsx', admin: 'someone@x.com', automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' })).reason, 'not-admin');
  // a named admin, but every guard
  const { sheetFile } = await uploadAndCheck(w, drive, await answeredSheet(w, { 'G:103+104': { same: 'N' }, A12: { give: 'Y' } }));
  const go = async (body) => { const r = res(); await pageMod.start(named(body), r, routeDeps); return r; };
  const noTick = await go({ sheetFile, confirm: 'GIVE 5 CLIENT IDS' });
  assert.equal(noTick.statusCode, 400); assert.equal(noTick.body.reason, 'automations');
  const wrong = await go({ sheetFile, automationsChecked: true, confirm: 'GIVE 4 CLIENT IDS' });
  assert.equal(wrong.body.reason, 'confirm'); assert.equal(wrong.body.phrase, 'GIVE 5 CLIENT IDS');
  assert.equal((await go({ sheetFile, automationsChecked: true, confirm: 'yes please' })).body.reason, 'confirm');
  w.mode = 'on';
  const on = await go({ sheetFile, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' });
  assert.equal(on.statusCode, 409); assert.equal(on.body.reason, 'live-on'); assert.match(on.body.error, /on the server/);
  w.mode = 'report';
  // unclear answers: listed on the preview, refused
  const un = await uploadAndCheck(w, drive, await answeredSheet(w, { 'G:103+104': { same: 'Yes, same' } }));
  assert.equal(un.job.result.canGo, false);
  assert.equal(un.job.result.unclear.length, 1);
  assert.equal(un.job.result.unclear[0].key, 'G:103+104');
  assert.match(un.job.result.unclear[0].name, /John Doe|Jane Doe/);
  assert.equal((await go({ sheetFile: un.sheetFile, automationsChecked: true, confirm: un.job.result.phrase })).body.reason, 'unclear-answers');
  // changed groups: listed on the preview, refused
  const yes = await answeredSheet(w, { 'G:103+104': { same: 'Y' } });
  w.addCase(108, 'June Doe', { email: 'fam@x.com' });
  const ch = await uploadAndCheck(w, drive, yes);
  assert.equal(ch.job.result.changed.length, 1);
  assert.equal(ch.job.result.changed[0].key, 'G:103+104');
  assert.equal((await go({ sheetFile: ch.sheetFile, automationsChecked: true, confirm: ch.job.result.phrase })).body.reason, 'changed');
  assert.equal(w.writes.length, 0); assert.equal(w.blocks.length, 0); assert.equal(w.lock, null);
  assert.ok(![...drive.files.keys()].some((k) => /checkpoint|current\.json|apply-log/.test(k)), 'no checkpoint, no log');
});

test('the run re-checks on its fresh read: a changed number of new IDs, unclear answers and changed groups are refused in the background too, before any write', async () => {
  const w = office(); const drive = fakeDrive(); wire(w, drive);
  const buf = await answeredSheet(w, { 'G:103+104': { same: 'N' }, A12: { give: 'Y' } });
  const { sheetFile } = await uploadAndCheck(w, drive, buf);
  w.addCase(130, 'Late Comer', { email: 'late@x.com' });     // one more person since the check
  const r = await jobs.startApply({ sheetFile, admin: ADMIN, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' });
  assert.equal(r.started, true);
  await settle();
  const j = jobs.jobState().job;
  assert.equal(j.state, 'refused'); assert.equal(j.result.reason, 'confirm');
  assert.match(j.result.message, /GIVE 6 CLIENT IDS/);
  assert.equal(w.writes.length, 0); assert.equal(w.lock, null);
  // after a restart the preview is gone: an unclear sheet is caught by the run itself
  jobs._resetForTests();
  const bad = await answeredSheet(w, { 'G:103+104': { same: 'maybe' } });
  const saved = await jobs.saveSheet({ buffer: bad, originalName: 'a.xlsx' });
  assert.equal((await jobs.startApply({ sheetFile: saved.sheetFile, admin: ADMIN, automationsChecked: true, confirm: 'GIVE 6 CLIENT IDS' })).started, true);
  await settle();
  const j2 = jobs.jobState().job;
  assert.equal(j2.state, 'refused'); assert.equal(j2.result.reason, 'unclear-answers');
  assert.equal(j2.result.unclear[0].key, 'G:103+104');
  assert.equal(w.writes.length, 0); assert.equal(w.lock, null);
});

test('the background run: 202, progress while it goes, the IDs and copies written, the checkpoint + apply log on OneDrive, the lock cleared, the CLIENT_IDS_HEAL_SINCE reminder', async () => {
  const w = office(); const drive = fakeDrive(); wire(w, drive);
  const { sheetFile } = await uploadAndCheck(w, drive, await answeredSheet(w, { 'G:103+104': { same: 'N' }, A12: { give: 'Y' } }));
  let lockedMidRun = null, seen = null;
  w.onSleep = async (n) => { if (n === 3) { lockedMidRun = !!w.lock; seen = jobs.jobState(); } };
  const r = res();
  await pageMod.start(named({ sheetFile, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' }), r, routeDeps);
  assert.equal(r.statusCode, 202, JSON.stringify(r.body));
  // one run at a time: a second start, an upload and an unlock are refused while it goes
  const again = res(); await pageMod.start(named({ sheetFile, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' }), again, routeDeps);
  assert.equal(again.statusCode, 409); assert.equal(again.body.reason, 'in-progress');
  const g = res(); let passed = false; pageMod.uploadGate(named(), g, () => { passed = true; }, routeDeps);
  assert.equal(passed, false); assert.equal(g.statusCode, 409);
  assert.equal((await jobs.unlock({ admin: ADMIN, confirm: 'UNLOCK' })).reason, 'in-progress');
  await settle();
  assert.equal(lockedMidRun, true, 'the counter is locked while it writes');
  assert.equal(seen.running, true);
  assert.equal(seen.job.kind, 'apply'); assert.equal(seen.job.phase, 'writing');
  assert.equal(seen.job.progress.total, 6, 'six people to go through (the one with an ID too: its copies)');
  const j = jobs.jobState().job;
  assert.equal(j.state, 'done', JSON.stringify(j.result));
  assert.equal(j.progress.processed, j.progress.total);
  assert.equal(j.result.ids, 5); assert.equal(j.result.records, 3); assert.equal(j.result.kept, 1);
  assert.equal(j.result.healSince.iso, new Date(NOW).toISOString());
  assert.match(j.result.healSince.toronto, /25 Nov 2026, 10:00 am \(Toronto\)/);
  assert.equal(w.lock, null, 'the lock is cleared at the end');
  assert.deepEqual(w.blocks, [{ first: 4, last: 8 }]);
  const ids = [...w.clients.values()].map((c) => c.cid).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(isId(w.cases.get('103').copy) && isId(w.leads.get('202').copy));
  // OneDrive: current.json → the run; its checkpoint finished; the rollback list
  const ptr = drive.json(jobs.POINTER);
  assert.equal(ptr.sheet, sheetFile);
  const cp = drive.json(`${jobs.FOLDER}/checkpoint-${ptr.run}.json`);
  assert.equal(cp.status, 'finished'); assert.equal(cp.sheet, sheetFile); assert.equal(cp.confirmedNewIds, 5);
  const logs = [...drive.files.keys()].filter((k) => k.startsWith(`${jobs.FOLDER}/apply-log-${ptr.run}-`));
  assert.equal(logs.length, 1);
  const entries = drive.files.get(logs[0]).body.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.kind === 'create-record') && entries.some((e) => e.kind === 'cell' && e.to === 'CL-2025-00004'));
  assert.ok(entries.every((e) => e.admin === ADMIN));
  // the state the page shows: finished, the summary, the reminder — and never a Clients record id
  const st = await jobs.state();
  assert.equal(st.run.status, 'finished'); assert.equal(st.run.done, 6); assert.equal(st.run.summary.ids, 5);
  assert.equal(st.run.healSince.iso, new Date(NOW).toISOString());
  assert.equal(st.counter.lock, null);
  const shown = JSON.stringify(st);
  for (const id of [...w.clients.keys()]) assert.ok(!shown.includes(`"${id}"`) && !shown.includes(`A${id}`), `record ${id} is not on the page`);
  // the server log: counts and keys only — no names, no emails
  assert.ok(w.serverLog.length >= 2);
  for (const line of w.serverLog) for (const n of [...NAMES, '@x.com']) assert.ok(!line.includes(n), `server log line names "${n}": ${line}`);
});

test('a run cut off by a restart resumes from the OneDrive checkpoint: the lock is recognised as its own, the same block is used, no number twice', async () => {
  const w = office(); const drive = fakeDrive(); wire(w, drive);
  const { sheetFile } = await uploadAndCheck(w, drive, await answeredSheet(w, { 'G:103+104': { same: 'N' }, A12: { give: 'Y' } }));
  w.hangAfter = w.sleeps + 3;
  assert.equal((await jobs.startApply({ sheetFile, admin: ADMIN, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' })).started, true);
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.ok(jobs._current(), 'still "running" when the server dies');
  // ── the restart: the process memory is gone; OneDrive and Monday are what is left ──
  jobs._resetForTests();
  w.hangAfter = Infinity;
  assert.ok(w.lock, 'the lock stays in the counter file');
  const ptr = drive.json(jobs.POINTER);
  const cp0 = drive.json(`${jobs.FOLDER}/checkpoint-${ptr.run}.json`);
  assert.equal(cp0.status, 'running'); assert.equal(cp0.blocks.length, 1);
  // within 5 minutes of its last save it might still be going on another copy: refused
  w.clock += 60 * 1000;
  assert.equal((await jobs.startApply({ resume: true, admin: ADMIN, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' })).reason, 'run-elsewhere');
  assert.equal((await jobs.unlock({ admin: ADMIN, confirm: 'UNLOCK' })).reason, 'run-elsewhere');
  w.clock += 10 * 60 * 1000;
  const st = await jobs.state();
  assert.equal(st.run.status, 'cut off'); assert.equal(st.run.canResume, true); assert.equal(st.run.lockIsOurs, true);
  assert.equal(st.run.resumePhrase, 'GIVE 5 CLIENT IDS');
  // Resume: the same answered sheet from OneDrive (no upload), the phrase it was started with
  const r = res();
  await pageMod.start(named({ resume: true, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' }), r, routeDeps);
  assert.equal(r.statusCode, 202, JSON.stringify(r.body)); assert.equal(r.body.resume, true);
  await settle();
  const j = jobs.jobState().job;
  assert.equal(j.state, 'done', JSON.stringify(j.result));
  assert.ok(j.progress.alreadyDone >= 1 || j.result.kept >= 1);
  assert.equal(w.blocks.length, 1, 'the numbers reserved before the restart are used');
  const creates = w.writes.filter((x) => x[0] === 'create').map((x) => x[2]);
  assert.equal(new Set(creates).size, creates.length, 'no record made twice');
  const ids = [...w.clients.values()].map((c) => c.cid).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.map((v) => Number(v.slice(-5))).sort((a, b) => a - b), [3, 4, 5, 6, 7, 8]);
  assert.equal(w.lock, null);
  const cp = drive.json(`${jobs.FOLDER}/checkpoint-${ptr.run}.json`);
  assert.equal(cp.status, 'finished'); assert.equal(cp.runs, 2);
  assert.equal(drive.json(jobs.POINTER).run, ptr.run, 'the same run, not a new one');
  // two sessions, two log files: the rollback list of both
  assert.equal([...drive.files.keys()].filter((k) => k.includes(`apply-log-${ptr.run}-`)).length, 2);
});

test('a run that stops with an error saves "stopped", clears the lock, and Resume goes on', async () => {
  const w = office(); const drive = fakeDrive(); wire(w, drive);
  const { sheetFile } = await uploadAndCheck(w, drive, await answeredSheet(w, { 'G:103+104': { same: 'N' }, A12: { give: 'Y' } }));
  w.crashAfter = w.sleeps + 2;
  await jobs.startApply({ sheetFile, admin: ADMIN, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' });
  await settle();
  const j = jobs.jobState().job;
  assert.equal(j.state, 'failed'); assert.match(j.result.message, /simulated crash/); assert.match(j.result.message, /Resume/);
  assert.equal(w.lock, null);
  const st = await jobs.state();
  assert.equal(st.run.status, 'stopped'); assert.equal(st.run.canResume, true); assert.match(st.run.error, /simulated crash/);
  w.crashAfter = Infinity;
  assert.equal((await jobs.startApply({ resume: true, admin: ADMIN, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' })).started, true);
  await settle();
  assert.equal(jobs.jobState().job.state, 'done', JSON.stringify(jobs.jobState().job.result));
  assert.equal(w.blocks.length, 1);
  assert.equal((await jobs.state()).run.status, 'finished');
});

test('a backfill lock held by someone else is refused (never taken over); Unlock takes it out (named admin, typed word)', async () => {
  const w = office(); const drive = fakeDrive(); wire(w, drive);
  const { sheetFile } = await uploadAndCheck(w, drive, await answeredSheet(w, { 'G:103+104': { same: 'N' }, A12: { give: 'Y' } }));
  w.lock = { by: 'other@tdotimm.com', at: '2026-11-25T09:00:00.000Z' };
  const r = await jobs.startApply({ sheetFile, admin: ADMIN, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' });
  assert.equal(r.started, false); assert.equal(r.reason, 'lock-held'); assert.match(r.message, /other@tdotimm\.com/);
  // the core refuses it too (a lock set between the page's look and the run's)
  const ready = await backfill.readAndPlan(w.io, CFG, { ...(await jobs.loadSheet(sheetFile)), apply: true });
  const store = jobs.driveStore(drive, 'x1', 's1');
  const core = await backfill.applyPlan({ x: w.io, store, cfg: CFG, ready, admin: ADMIN, typed: 'GIVE 5 CLIENT IDS', via: 'page' });
  assert.equal(core.reason, 'lock-held');
  assert.deepEqual(w.lock, { by: 'other@tdotimm.com', at: '2026-11-25T09:00:00.000Z' }, 'never cleared by the refused run');
  assert.equal(w.writes.length, 0);
  // Unlock: the typed word, then the lock is out
  assert.equal((await jobs.unlock({ admin: ADMIN, confirm: 'unlock please' })).reason, 'confirm');
  assert.equal((await jobs.unlock({ admin: 'someone@x.com', confirm: 'UNLOCK' })).reason, 'not-admin');
  const u = res(); await pageMod.unlock(named({ confirm: 'UNLOCK' }), u, routeDeps);
  assert.equal(u.statusCode, 200); assert.equal(u.body.cleared, true);
  assert.equal(w.lock, null);
  assert.equal((await jobs.startApply({ sheetFile, admin: ADMIN, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' })).started, true);
  await settle();
  assert.equal(jobs.jobState().job.state, 'done');
});

test('a NEWER checkpoint on OneDrive (another copy of the server took the run over) stops this run at once — and the lock is left to the other one', async () => {
  const w = office(); const drive = fakeDrive(); wire(w, drive);
  const { sheetFile } = await uploadAndCheck(w, drive, await answeredSheet(w, { 'G:103+104': { same: 'N' }, A12: { give: 'Y' } }));
  w.onSleep = async (n) => {
    if (w.bumped) return;
    const k = [...drive.files.keys()].find((x) => /checkpoint-/.test(x));
    if (k) { w.bumped = true; drive.put(k, drive.files.get(k).body, drive.files.get(k).etag); }   // the other copy saved
  };
  await jobs.startApply({ sheetFile, admin: ADMIN, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' });
  await settle();
  const j = jobs.jobState().job;
  assert.equal(j.state, 'failed'); assert.match(j.result.message, /changed meanwhile/);
  assert.ok(w.lock, 'the lock is NOT taken out: it is the other run\'s now');
  assert.ok(j.lines.some((l) => /another copy of the server/.test(l)));
});

test('the Monday backoff: a complexity / rate answer is waited out and tried again, at most 3 times; anything else is not retried', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let n = 0;
  const ok = await backfill.withBackoff(async () => { if (++n < 3) throw new Error('Complexity budget exhausted, budget will reset in 12 seconds'); return 'done'; }, { sleep });
  assert.equal(ok, 'done'); assert.deepEqual(waits, [13000, 13000]);
  n = 0;
  await assert.rejects(backfill.withBackoff(async () => { n++; throw new Error('Rate limit exceeded'); }, { sleep }), /Rate limit/);
  assert.equal(n, 3, 'never retried endlessly');
  n = 0;
  await assert.rejects(backfill.withBackoff(async () => { n++; throw new Error('Column not found'); }, { sleep }), /Column not found/);
  assert.equal(n, 1);
  assert.equal(backfill.waitFor(new Error('reset in 500 seconds')), 60000, 'capped');
  // a write that still fails is left for the resume: listed, never a crash
  const w = office(); const drive = fakeDrive(); wire(w, drive);
  const { sheetFile } = await uploadAndCheck(w, drive, await answeredSheet(w, { 'G:103+104': { same: 'N' }, A12: { give: 'Y' } }));
  const keep = w.io.writeText;
  w.io.writeText = async () => { throw new Error('Complexity budget exhausted'); };
  await jobs.startApply({ sheetFile, admin: ADMIN, automationsChecked: true, confirm: 'GIVE 5 CLIENT IDS' });
  await settle();
  w.io.writeText = keep;
  const j = jobs.jobState().job;
  assert.equal(j.state, 'done');
  assert.ok(j.result.skippedCount >= 1);
  assert.ok(j.result.skipped.some((x) => /copy could not be written/.test(x.why)));
  assert.equal(w.lock, null);
});

test('the OneDrive store: the log rolls to a new file every 200 lines; a failed log write is healed by the next one; three in a row stop the run', async () => {
  const drive = fakeDrive();
  const store = jobs.driveStore(drive, 'R1', 'S1');
  assert.equal(await store.load(), null);
  for (let i = 0; i < 450; i++) await store.log({ i });
  const parts = [...drive.files.keys()].filter((k) => k.includes('apply-log-R1-S1-')).sort();
  assert.deepEqual(parts.map((p) => p.slice(-9)), ['001.jsonl', '002.jsonl', '003.jsonl']);
  assert.equal(drive.files.get(parts[0]).body.toString().trim().split('\n').length, 200);
  assert.equal(drive.files.get(parts[2]).body.toString().trim().split('\n').length, 50);
  const keep = drive.writeSystemFile;
  let fail = 1;
  drive.writeSystemFile = async (...a) => { if (fail-- > 0) throw new Error('OneDrive busy'); return keep(...a); };
  await store.log({ i: 'a' }); await store.log({ i: 'b' });
  const last = drive.files.get(parts[2]).body.toString().trim().split('\n');
  assert.deepEqual(last.slice(-2).map((l) => JSON.parse(l).i), ['a', 'b'], 'the failed line is in the next write');
  fail = 3;
  await store.log({ i: 'c' }); await store.log({ i: 'd' });
  await assert.rejects(store.log({ i: 'e' }), /apply log could not be saved/);
  // the checkpoint: create-only first, then only over the version this store wrote
  await store.save({ a: 1 });
  await store.save({ a: 2 });
  assert.deepEqual(drive.json(`${jobs.FOLDER}/checkpoint-R1.json`), { a: 2 });
  const other = jobs.driveStore(drive, 'R1', 'S2');
  await other.load(); await other.save({ a: 3 });
  await assert.rejects(store.save({ a: 4 }), (e) => e.conflict === true);
});

test('the upload takes only the answered check list: an .xlsx with a People sheet, under 5 MB', async () => {
  const w = office(); const drive = fakeDrive(); wire(w, drive);
  const bad = async (buffer, name, re) => { await assert.rejects(jobs.saveSheet({ buffer, originalName: name }), (e) => e.badRequest && re.test(e.message)); };
  await bad(Buffer.from('hello'), 'a.xlsx', /not an \.xlsx/);
  await bad(Buffer.from('PK....'), 'a.csv', /\.xlsx file/);
  await bad(Buffer.alloc(jobs.MAX_SHEET_BYTES + 1, 0x50), 'a.xlsx', /too big/);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Other');
  await bad(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'a.xlsx', /no "People" sheet/);
  assert.equal(drive.files.size, 0);
  const r = res(); await pageMod.upload(named({}, { backfillActor: { name: 'Boss' } }), r, routeDeps);
  assert.equal(r.statusCode, 400);
  await assert.rejects(jobs.loadSheet('../../Client Documents/x.xlsx'), (e) => e.badRequest);
  await assert.rejects(jobs.loadSheet('answered-2026-01-01T00-00-00-000Z-0a0b.xlsx'), (e) => e.notFound);
});

test('the page: a named admin gets it; its script parses; no client data in the markup; the A-keys are masked', () => {
  const r = res(); pageMod.page(named(), r, routeDeps);
  assert.equal(r.statusCode, 200); assert.equal(r.ctype, 'html');
  const html = r.body;
  assert.match(html, /I checked that no Monday automation watches the Client ID columns, Client account \(system\) or the Client relation/);
  assert.match(html, /\/admin\/client-ids\/backfill\/upload/);
  const vm = require('node:vm');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  for (const m of scripts) new vm.Script(m[1]);
  assert.ok(!pageMod.PAGE_JS.includes('\\') && !pageMod.PAGE_JS.includes('`') && !pageMod.PAGE_JS.includes('${'), 'the inline-JS rules');
  assert.equal(jobs.maskKey('A12345678'), 'A·····');
  assert.equal(jobs.maskKey('G:103+104'), 'G:103+104');
  assert.equal(jobs.maskText('A12345678: the client record is merged'), 'A·····: the client record is merged');
});

test('one implementation: the script calls the shared service; its Monday reads keep the 25-row trap closed; the routes are registered behind the named-admin gate', () => {
  const svc = fs.readFileSync(require.resolve('../src/services/clientIdBackfillRun'), 'utf8');
  assert.ok(svc.includes('items(ids:[$id], limit:1)'));
  assert.ok(!/items\(ids:\[\$id\]\)\{/.test(svc));
  const scr = fs.readFileSync(require.resolve('../scripts/backfill-client-ids'), 'utf8');
  assert.match(scr, /backfill\.applyPlan\(/);
  assert.match(scr, /backfill\.readAndPlan\(/);
  assert.ok(!/async function applyAll/.test(scr), 'no second copy of the apply in the script');
  const srv = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  for (const r of ["app.get('/admin/client-ids/backfill'", "app.post('/admin/client-ids/backfill/upload'", "app.post('/admin/client-ids/backfill/start'", "app.post('/admin/client-ids/backfill/unlock'"]) assert.ok(srv.includes(r), r);
  assert.match(srv, /namedAdmin: \(req, res, what\) => resolveNamedAdminViewerOrReject\(req, res, what\)/);
  const nav = require('../src/routes/adminShared').buildNavHeader('leads');
  assert.ok(!nav.includes('client-ids'), 'not in the staff navigation');
  const eng = fs.readFileSync(require.resolve('../src/routes/adminEngines'), 'utf8');
  assert.match(eng, /id="cid-backfill-card" style="display:none"/);
  assert.match(eng, /if \(v && v\.canUndo\) \{ var cb = document\.getElementById\('cid-backfill-card'\); if \(cb\) cb\.style\.display = ''; \}/);
});

test('readSystemFile / writeSystemFile: only under "TDOT System/"; the two write conditions; 409/412 = conflict; bytes come back as they went', async () => {
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const store = new Map(); const puts = [];
  set('axios', {
    get: async (url, cfg) => {
      const u = decodeURIComponent(url);
      const m = /root:\/(.+):\?\$select=id,eTag$/.exec(u);
      if (m) { if (!store.has(m[1])) { const e = new Error('nf'); e.response = { status: 404 }; throw e; } return { data: { id: encodeURIComponent(m[1]), eTag: store.get(m[1]).etag } }; }
      const c = /\/items\/(.+)\/content$/.exec(u);
      if (c) { assert.equal(cfg.responseType, 'arraybuffer'); return { data: store.get(decodeURIComponent(c[1])).body }; }
      throw new Error('unexpected GET ' + u);
    },
    put: async (url, body, cfg) => {
      const u = decodeURIComponent(url);
      const m = /root:\/(.+):\/content(\?@microsoft\.graph\.conflictBehavior=fail)?$/.exec(u);
      puts.push({ path: m[1], createOnly: !!m[2], ifMatch: cfg.headers['If-Match'], type: cfg.headers['Content-Type'] });
      const f = store.get(m[1]);
      if (cfg.headers['If-Match'] ? (!f || f.etag !== cfg.headers['If-Match']) : !!f) { const e = new Error('x'); e.response = { status: cfg.headers['If-Match'] ? 412 : 409 }; throw e; }
      const etag = `"e${puts.length}"`; store.set(m[1], { body: Buffer.from(body), etag });
      return { status: f ? 200 : 201, data: { eTag: etag } };
    },
  });
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'tok', invalidateAccessToken: () => {} });
  const p = require.resolve('../src/services/oneDriveService');
  delete require.cache[p];
  const od = require(p);
  try {
    await assert.rejects(od.writeSystemFile('Client Documents/x.xlsx', Buffer.from('a')), /TDOT System/);
    await assert.rejects(od.writeSystemFile('TDOT System/../Client Documents/x', Buffer.from('a')), /TDOT System/);
    await assert.rejects(od.readSystemFile('Client Documents/x.xlsx'), /TDOT System/);
    const P = 'TDOT System/client-id-backfill/answered-x.xlsx';
    const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255]);
    assert.deepEqual(await od.writeSystemFile(P, bytes, { contentType: 'application/x' }), { etag: '"e1"', created: true });
    assert.equal(puts[0].createOnly, true); assert.equal(puts[0].type, 'application/x');
    await assert.rejects(od.writeSystemFile(P, bytes), (e) => e.conflict === true);
    const got = await od.readSystemFile(P);
    assert.deepEqual([...got.buffer], [...bytes]); assert.equal(got.etag, '"e1"');
    assert.deepEqual(await od.writeSystemFile(P, 'text', { etag: '"e1"' }), { etag: '"e3"', created: false });
    await assert.rejects(od.writeSystemFile(P, 'text', { etag: '"e1"' }), (e) => e.conflict === true);
    assert.equal(await od.readSystemFile('TDOT System/none.json'), null);
  } finally {
    for (const rel of ['axios', '../src/services/microsoftMailService', '../src/services/oneDriveService']) delete require.cache[require.resolve(rel)];
  }
});
