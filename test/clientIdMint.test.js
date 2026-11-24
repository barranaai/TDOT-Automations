'use strict';

// Client ID minting (step 3, 2026-11-25).
//   (a) clientAccountService.ensureClientId(account): the ID on the Clients row, or — blank
//       and CLIENT_IDS=on — a new number written there. report = read + log only; off =
//       nothing at all. Never for a Merged / Archived row, an unreadable cell, a typed value.
//   (b) stampClientAccount: on BOTH paths (staff-chosen account, findOrCreate), after the
//       race reconcile, before linkCase; linkCase / linkLead copy the ID, each write in its
//       own try/catch (review #1).
//   (c) a PAID consultation (online, invoice, recorded, waived, direct) gives the person their
//       account + ID; strict matching — a weaker match is left for staff, never linked;
//       a re-run (webhook retry) reuses everything — the same ID, never a second number.
// Every Monday / OneDrive seam is a fake (the no-network guard backs it).

const test   = require('node:test');
const assert = require('node:assert/strict');

const svc         = require('../src/services/clientAccountService');
const handoff     = require('../src/services/handoffService');
const mondayApi   = require('../src/services/mondayApi');
const leadService = require('../src/services/leadService');
const allocator   = require('../src/services/clientIdAllocator');
const shipped     = require('../src/data/clientsBoard.json');
const LEAD_BOARD  = String(require('../src/data/newLeadsBoard.json').boardId);
const { torontoYear } = require('../src/utils/torontoTime');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const quietly = (fn) => async () => {
  const o = [console.log, console.warn];
  const logs = [];
  console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' '));
  try { return await fn(logs); } finally { [console.log, console.warn] = o; }
};

// The board config with the Client ID columns made (the shipped file has them null).
const CFG = JSON.parse(JSON.stringify(shipped));
CFG.columns.clientId = 'text_cid';
CFG.cmLinkColumns.clientId = 'text_cmcid';
CFG.leadLinkColumns.clientId = 'text_leadcid';
const COL = CFG.columns;
const CM_BOARD = String(CFG.clientMasterBoardId);

/**
 * The fake world: a Clients board (rows by id), the Lead Board (leads by id), the Client
 * Master mirror writes, notes, and the REAL allocator over an in-memory counter file with
 * eTags. `failOn(name)` makes one kind of call throw.
 */
function world({ rows = [], leads = [], last = 41, cfg = CFG, fail = {}, onBeforeWrite = null } = {}) {
  const board = new Map(rows.map((r) => [String(r.id), { status: 'Active', email: '', phone: '', dob: '', clientId: '', mergedInto: '', ...r, id: String(r.id) }]));
  const leadMap = new Map(leads.map((l) => [String(l.id), { ...l, id: String(l.id) }]));
  const seen = { calls: [], creates: 0, clientsWrites: [], cmWrites: [], leadMirror: [], leadStamps: [], notes: [], counterWrites: 0, idReads: 0 };
  let nextId = 900;
  let counter = { last, etag: 'e1' }, ver = 1;

  const cell = (row, col) => ({
    [COL.primaryEmail]: row.email, [COL.phone]: row.phone, [COL.dateOfBirth]: row.dob, [COL.status]: row.status,
    [COL.mergedInto]: row.mergedInto, ...(cfg.columns.clientId ? { [cfg.columns.clientId]: row.clientId } : {}),
  }[col]);
  const wire = (row, ids) => ({ id: row.id, name: row.name, board: { id: String(cfg.boardId) },
    column_values: ids.filter((c) => !(row.hide || []).includes(c)).map((c) => ({ id: c, text: cell(row, c) == null ? '' : cell(row, c) })) });

  const query = async (q, v = {}) => {
    seen.calls.push(q);
    if (/items_page_by_column_values/.test(q)) {
      if (fail.find) throw new Error('Monday 503');
      const col = /column_id:"([^"]+)"/.exec(q)[1];
      const ids = JSON.parse(/column_values\(ids:(\[[^\]]*\])\)/.exec(q)[1]);
      const want = String(v.v).toLowerCase();
      const hit = [...board.values()].filter((r) => {
        const t = String(cell(r, col) || '').toLowerCase().replace(/^\+/, '');
        return t && (t === want || t.replace(/\D/g, '') === want);
      });
      return { items_page_by_column_values: { items: hit.map((r) => wire(r, ids)) } };
    }
    if (/create_item/.test(q)) {
      const id = String(nextId++); seen.creates++;
      const c = JSON.parse(v.c);
      board.set(id, { id, name: v.n, status: 'Active', email: (c[COL.primaryEmail] || {}).email || '', phone: ((c[COL.phone] || {}).phone || '').replace(/^\+1?/, ''), dob: '', clientId: '', mergedInto: '' });
      return { create_item: { id } };
    }
    if (/items\(ids:\[\$id\], limit:1\)\{ id board \{ id \}/.test(q)) {
      seen.idReads++;
      if (fail.read) throw new Error('Monday 503');
      const row = board.get(String(v.id));
      const ids = JSON.parse(/column_values\(ids:(\[[^\]]*\])\)/.exec(q)[1]);
      return { items: row ? [wire(row, ids)] : [] };
    }
    if (/items\(ids:\[\$id\], limit:1\)/.test(q)) {   // appendAccountRelation's read
      return { items: [{ id: String(v.id), column_values: [{ id: 'rel', linked_item_ids: [] }] }] };
    }
    if (/change_multiple_column_values/.test(q)) {
      const c = JSON.parse(v.c);
      if (String(v.b) === String(cfg.boardId)) {
        if (cfg.columns.clientId && cfg.columns.clientId in c) {
          if (fail.idWrite) throw new Error('Monday 503 on write');
          if (onBeforeWrite) { const f = onBeforeWrite; onBeforeWrite = null; await f(board); }
          seen.clientsWrites.push({ id: String(v.i), value: c[cfg.columns.clientId] });
        }
        const row = board.get(String(v.i));
        if (row) {
          if (cfg.columns.clientId && cfg.columns.clientId in c) row.clientId = c[cfg.columns.clientId];
          if (c[COL.status]) row.status = c[COL.status].label;
          if (COL.mergedInto in c) row.mergedInto = c[COL.mergedInto];
        }
        return {};
      }
      if (String(v.b) === CM_BOARD) {
        if (fail.cmAccount && cfg.cmLinkColumns.clientAccountId in c) throw new Error('CM write failed');
        if (fail.cmMirror && cfg.cmLinkColumns.clientId in c) throw new Error('CM mirror failed');
        seen.cmWrites.push({ id: String(v.i), cols: c });
        return {};
      }
      if (String(v.b) === LEAD_BOARD) {
        if (fail.leadMirror) throw new Error('lead mirror failed');
        seen.leadMirror.push({ id: String(v.i), cols: c });
        const l = leadMap.get(String(v.i)); if (l && cfg.leadLinkColumns.clientId in c) l.clientIdMirror = c[cfg.leadLinkColumns.clientId];
        return {};
      }
      return {};
    }
    if (/create_update/.test(q)) { seen.notes.push({ id: String(v.i || v.id), body: v.b }); return { create_update: { id: 'u' } }; }
    return {};
  };

  // the real allocator over a fake counter file
  allocator._resetForTests();
  const io = allocator.io;
  const saved = { ...io };
  io.columns = () => ({ clientsBoardId: String(cfg.boardId), clientsCol: cfg.columns.clientId || '', cmBoardId: CM_BOARD, cmCol: cfg.cmLinkColumns.clientId || '' });
  io.readCounter = async () => (fail.counter ? Promise.reject(new Error('OneDrive down')) : { data: { last: counter.last }, etag: counter.etag });
  io.writeCounter = async (data, etag) => {
    if (etag !== counter.etag) { const e = new Error('changed'); e.conflict = true; throw e; }
    ver++; counter = { last: data.last, etag: `e${ver}` }; seen.counterWrites++;
    return { etag: counter.etag };
  };
  io.numberTaken = async (n) => [...board.values()].some((r) => String(r.clientId).endsWith(`-${String(n).padStart(5, '0')}`));
  io.boardValues = async () => [...board.values()].map((r) => r.clientId).filter(Boolean);

  svc._setBoardForTests(cfg);
  const restore = [
    stub(mondayApi, 'query', query),
    stub(leadService, 'updateLead', async (id, f) => {
      if (fail.leadStamp) throw new Error('lead stamp failed');
      seen.leadStamps.push({ id: String(id), f });
      const l = leadMap.get(String(id)); if (l) Object.assign(l, f);
    }),
    stub(leadService, 'getLead', async (id) => (leadMap.has(String(id)) ? { ...leadMap.get(String(id)) } : null)),
  ];
  return {
    board, leadMap, seen, counter: () => counter.last,
    done: () => { restore.reverse().forEach((r) => r()); Object.assign(io, saved); allocator._resetForTests(); svc._setBoardForTests(undefined); },
  };
}
const ON = { CLIENT_IDS: 'on' }, REPORT = { CLIENT_IDS: 'report' }, OFF = { CLIENT_IDS: undefined };

/* ───────────────────────── (a) ensureClientId ───────────────────────── */

test('ensureClientId, switch OFF (unset, "off", "yes", anything else): nothing is read or written — not even a Monday call', quietly(async () => {
  for (const v of [undefined, 'off', 'yes', 'ON please']) {
    const w = world({ rows: [{ id: '7', name: 'Jane Doe' }] });
    try {
      const r = await withEnv({ CLIENT_IDS: v }, () => svc.ensureClientId('7'));
      assert.deepEqual(r, { ok: false, reason: 'off' }, String(v));
      assert.equal(w.seen.calls.length, 0);
      assert.equal(w.seen.counterWrites, 0);
    } finally { w.done(); }
  }
}));

test('ensureClientId, the Client ID column not made yet (the shipped config): refused with no Monday call, even when on', quietly(async () => {
  const cfg = JSON.parse(JSON.stringify(shipped));
  const w = world({ rows: [{ id: '7', name: 'Jane Doe' }], cfg });
  try {
    assert.equal(shipped.columns.clientId, null, 'the shipped config is inert');
    const r = await withEnv(ON, () => svc.ensureClientId('7'));
    assert.equal(r.reason, 'not-configured');
    assert.equal(w.seen.calls.length, 0);
  } finally { w.done(); }
}));

test('ensureClientId, ON: a blank row gets the next number (last + 1) with the year asked for, written to the Clients row; read back', quietly(async () => {
  const w = world({ rows: [{ id: '7', name: 'Jane Doe' }], last: 41 });
  try {
    const r = await withEnv(ON, () => svc.ensureClientId('7', { year: 2026 }));
    assert.deepEqual(r, { ok: true, id: 'CL-2026-00042', minted: true });
    assert.equal(w.board.get('7').clientId, 'CL-2026-00042');
    assert.deepEqual(w.seen.clientsWrites, [{ id: '7', value: 'CL-2026-00042' }]);
    assert.equal(w.counter(), 42);
    // again: the same ID, no second number
    const again = await withEnv(ON, () => svc.ensureClientId('7', { year: 2026 }));
    assert.deepEqual(again, { ok: true, id: 'CL-2026-00042', minted: false });
    assert.equal(w.counter(), 42, 'no number taken the second time');
    assert.equal(w.seen.clientsWrites.length, 1);
  } finally { w.done(); }
}));

test('ensureClientId, ON: an ID the caller already read (findOrCreate) is used without a read', quietly(async () => {
  const w = world({ rows: [{ id: '7', name: 'Jane Doe', clientId: 'CL-2025-00003' }] });
  try {
    const r = await withEnv(ON, () => svc.ensureClientId('7', { knownId: 'CL-2025-00003' }));
    assert.deepEqual(r, { ok: true, id: 'CL-2025-00003', minted: false });
    assert.equal(w.seen.calls.length, 0);
  } finally { w.done(); }
}));

test('ensureClientId: never for a Merged or Archived row, a row not on the Clients board, an unreadable cell, or a cell holding something else — nothing minted, nothing typed over', quietly(async () => {
  const w = world({ rows: [
    { id: '1', name: 'Loser', status: 'Merged', mergedInto: '2' },
    { id: '3', name: 'Old', status: 'Archived' },
    { id: '4', name: 'Hidden', hide: ['text_cid'] },
    { id: '5', name: 'Typed', clientId: 'cl 42 see notes' },
  ] });
  try {
    await withEnv(ON, async () => {
      assert.deepEqual(await svc.ensureClientId('1'), { ok: false, reason: 'merged', mergedInto: '2' });
      assert.equal((await svc.ensureClientId('3')).reason, 'archived');
      assert.equal((await svc.ensureClientId('99')).reason, 'not-found');
      assert.equal((await svc.ensureClientId('4')).reason, 'unreadable', 'a cell that did not come back is never "blank"');
      const typed = await svc.ensureClientId('5');
      assert.equal(typed.reason, 'malformed');
      assert.equal(typed.value, 'cl 42 see notes');
      assert.equal((await svc.ensureClientId('')).reason, 'no-account');
    });
    assert.equal(w.counter(), 41, 'no number taken');
    assert.equal(w.seen.clientsWrites.length, 0);
    assert.equal(w.board.get('5').clientId, 'cl 42 see notes', 'left as it is');
  } finally { w.done(); }
}));

test('ensureClientId: a failed read, or a counter that cannot be read, mints nothing; a failed WRITE burns the number (never reused) and says so', quietly(async () => {
  let w = world({ rows: [{ id: '7', name: 'Jane' }], fail: { read: true } });
  try {
    assert.equal((await withEnv(ON, () => svc.ensureClientId('7'))).reason, 'unavailable');
    assert.equal(w.counter(), 41);
  } finally { w.done(); }
  w = world({ rows: [{ id: '7', name: 'Jane' }], fail: { counter: true } });
  try {
    const r = await withEnv(ON, () => svc.ensureClientId('7'));
    assert.equal(r.ok, false); assert.equal(r.reason, 'unavailable');
    assert.equal(w.seen.clientsWrites.length, 0);
  } finally { w.done(); }
  w = world({ rows: [{ id: '7', name: 'Jane' }], fail: { idWrite: true } });
  try {
    const r = await withEnv(ON, () => svc.ensureClientId('7', { year: 2026 }));
    assert.deepEqual([r.ok, r.reason, r.burnt], [false, 'write-failed', 'CL-2026-00042']);
    assert.equal(w.counter(), 42, 'the number is used up');
  } finally { w.done(); }
}));

test('ensureClientId: another instance gave the person a number between our read and our write → theirs stands, ours is burnt; the copies use theirs', quietly(async () => {
  // the cell fills while we take a number: the re-read just before writing sees it
  const w = world({ rows: [{ id: '7', name: 'Jane' }], last: 41 });
  const realAllocate = allocator.allocate;
  const r0 = stub(allocator, 'allocate', async (o) => { const a = await realAllocate(o); w.board.get('7').clientId = 'CL-2026-00040'; return a; });
  try {
    const r = await withEnv(ON, () => svc.ensureClientId('7', { year: 2026 }));
    assert.deepEqual(r, { ok: true, id: 'CL-2026-00040', minted: false, burnt: 'CL-2026-00042' });
    assert.equal(w.seen.clientsWrites.length, 0, 'never typed over theirs');
  } finally { r0(); w.done(); }
  // they write in the same instant as us (after our re-read): the read-back is the truth
  const w2 = world({ rows: [{ id: '7', name: 'Jane' }], last: 41, onBeforeWrite: null });
  const r1 = stub(mondayApi, 'query', ((orig) => async (q, v) => {
    const out = await orig(q, v);
    if (/change_multiple_column_values/.test(q) && String(v.b) === String(CFG.boardId) && 'text_cid' in JSON.parse(v.c)) w2.board.get('7').clientId = 'CL-2026-00050';
    return out;
  })(mondayApi.query));
  try {
    const r = await withEnv(ON, () => svc.ensureClientId('7', { year: 2026 }));
    assert.deepEqual(r, { ok: true, id: 'CL-2026-00050', minted: false, burnt: 'CL-2026-00042' });
  } finally { r1(); w2.done(); }
}));

test('ensureClientId: two calls for one account at once → ONE number', quietly(async () => {
  const w = world({ rows: [{ id: '7', name: 'Jane' }], last: 41 });
  try {
    const [a, b] = await withEnv(ON, () => Promise.all([svc.ensureClientId('7', { year: 2026 }), svc.ensureClientId('7', { year: 2026 })]));
    assert.equal(a.id, 'CL-2026-00042'); assert.equal(b.id, 'CL-2026-00042');
    assert.equal(w.counter(), 42);
    assert.equal(w.seen.clientsWrites.length, 1);
  } finally { w.done(); }
}));

test('ensureClientId, REPORT: the row is read and the log says what would happen — no number, no write', quietly(async (logs) => {
  const w = world({ rows: [{ id: '7', name: 'Jane' }, { id: '8', name: 'Has', clientId: 'CL-2026-00005' }] });
  try {
    const r = await withEnv(REPORT, () => svc.ensureClientId('7', { why: 'case opened' }));
    assert.deepEqual(r, { ok: false, reason: 'report', wouldMint: true });
    assert.ok(logs.some((l) => /account 7 \(case opened\): would get a new Client ID \(CLIENT_IDS=report — nothing written\)/.test(l)));
    assert.deepEqual(await withEnv(REPORT, () => svc.ensureClientId('8')), { ok: false, reason: 'report', existing: 'CL-2026-00005' });
    assert.equal(w.counter(), 41);
    assert.equal(w.seen.clientsWrites.length, 0);
    assert.equal(w.seen.counterWrites, 0);
  } finally { w.done(); }
}));

test('findMatches reads the Client ID column once it exists (and not while it is not made)', quietly(async () => {
  const w = world({ rows: [{ id: '7', name: 'Jane Doe', email: 'jane@x.com', clientId: 'CL-2026-00007' }] });
  try {
    const m = await svc.findMatches({ email: 'jane@x.com', fullName: 'Jane Doe' });
    assert.equal(m[0].clientIdText, 'CL-2026-00007');
    assert.ok(w.seen.calls.every((q) => !/items_page_by_column_values/.test(q) || /"text_cid"/.test(q)));
  } finally { w.done(); }
  const cfg = JSON.parse(JSON.stringify(shipped));
  const w2 = world({ rows: [{ id: '7', name: 'Jane Doe', email: 'jane@x.com' }], cfg });
  try {
    const m = await svc.findMatches({ email: 'jane@x.com', fullName: 'Jane Doe' });
    assert.equal(m[0].clientIdText, '');
    assert.ok(w2.seen.calls.every((q) => !/null/.test(q)), 'no null column id in the query');
  } finally { w2.done(); }
}));

test('yearForLead: the Toronto year the lead was made, or now — whichever is earlier; 31 Dec 23:30 Toronto is that year', () => {
  const now = Date.parse('2027-03-01T12:00:00Z');
  assert.equal(svc.yearForLead({ createdAt: '2027-01-01T04:30:00Z' }, now), 2026, '31 Dec 23:30 Toronto');
  assert.equal(svc.yearForLead({ createdAt: '2027-01-01T05:30:00Z' }, now), 2027);
  assert.equal(svc.yearForLead({ createdAt: '2025-06-01T12:00:00Z' }, now), 2025);
  assert.equal(svc.yearForLead({}, now), 2027);
  assert.equal(svc.yearForLead({ createdAt: 'nonsense' }, now), 2027);
  assert.equal(svc.yearForLead({ createdAt: '2031-01-01T12:00:00Z' }, now), 2027, 'a future date is never the year');
});

/* ───────────────────────── (b) the handoff ───────────────────────── */

const LEAD = (over = {}) => ({ id: '500', fullName: 'Jane Doe', email: 'jane@x.com', phone: '4165550100', createdAt: '2026-05-01T12:00:00Z', ...over });

test('handoff, ON, a new person: findOrCreate → the ID minted for the account → the case and the lead get the account AND the ID copy', quietly(async () => {
  const w = world({ leads: [LEAD()] });
  try {
    await withEnv(ON, () => handoff.stampClientAccount(LEAD(), '700'));
    const acct = [...w.board.values()][0];
    assert.equal(acct.clientId, 'CL-2026-00042');
    const cm = Object.assign({}, ...w.seen.cmWrites.filter((x) => x.id === '700').map((x) => x.cols));
    assert.equal(cm[CFG.cmLinkColumns.clientAccountId], acct.id);
    assert.equal(cm[CFG.cmLinkColumns.clientId], 'CL-2026-00042');
    assert.deepEqual(w.seen.leadStamps.map((s) => s.f), [{ clientAccountId: acct.id }]);
    assert.deepEqual(w.seen.leadMirror, [{ id: '500', cols: { text_leadcid: 'CL-2026-00042' } }]);
  } finally { w.done(); }
}));

test('handoff, ON, the account staff chose (or a paid consultation made) is used — and gets its ID there too (review #1)', quietly(async () => {
  const w = world({ rows: [{ id: '77', name: 'Jane Doe', email: 'jane@x.com' }] });
  const r = stub(svc, 'findOrCreate', async () => { throw new Error('must not run — the account is chosen'); });
  try {
    await withEnv(ON, () => handoff.stampClientAccount(LEAD({ clientAccountId: '77' }), '700'));
    assert.equal(w.board.get('77').clientId, 'CL-2026-00042');
    assert.ok(w.seen.cmWrites.some((x) => x.cols[CFG.cmLinkColumns.clientId] === 'CL-2026-00042'));
    assert.ok(w.seen.leadMirror.some((x) => x.cols.text_leadcid === 'CL-2026-00042'));
  } finally { r(); w.done(); }
}));

test('handoff, ON, an exact match that already has an ID: reused as it is — no new number, the copies carry it', quietly(async () => {
  const w = world({ rows: [{ id: '77', name: 'Jane Doe', email: 'jane@x.com', clientId: 'CL-2025-00003' }] });
  try {
    await withEnv(ON, () => handoff.stampClientAccount(LEAD(), '700'));
    assert.equal(w.seen.creates, 0);
    assert.equal(w.counter(), 41);
    assert.equal(w.seen.idReads, 0, 'the ID came with the match — no extra read');
    assert.ok(w.seen.cmWrites.some((x) => x.cols[CFG.cmLinkColumns.clientId] === 'CL-2025-00003'));
  } finally { w.done(); }
}));

test('handoff, ON, race twins: our new row loses the reconcile (Merged) — the number goes to the surviving lower row only', quietly(async () => {
  // the other instance's row (41) is not searchable before our create, and is after it
  const w = world({ rows: [] });
  let hiddenTwin = true;
  const r = stub(mondayApi, 'query', ((orig) => async (q, v) => {
    if (/create_item/.test(q)) { const out = await orig(q, v); hiddenTwin = false; return out; }
    if (/items_page_by_column_values/.test(q) && !hiddenTwin && !w.board.has('41')) w.board.set('41', { id: '41', name: 'Jane Doe', email: 'jane@x.com', phone: '', dob: '', status: 'Active', clientId: '', mergedInto: '' });
    return orig(q, v);
  })(mondayApi.query));
  try {
    await withEnv(ON, () => handoff.stampClientAccount(LEAD({ phone: '' }), '700'));
    assert.equal(w.board.get('900').status, 'Merged', 'our row is the loser');
    assert.equal(w.board.get('900').clientId, '', 'a Merged row never takes a number');
    assert.equal(w.board.get('41').clientId, 'CL-2026-00042');
    assert.ok(w.seen.cmWrites.some((x) => x.cols[CFG.cmLinkColumns.clientAccountId] === '41'));
    assert.equal(w.counter(), 42, 'one number');
  } finally { r(); w.done(); }
}));

test('handoff, switch OFF: exactly the old bookkeeping — no ID read, no number, no ID copy', quietly(async () => {
  const w = world({ rows: [{ id: '77', name: 'Jane Doe', email: 'jane@x.com' }] });
  try {
    await withEnv(OFF, () => handoff.stampClientAccount(LEAD(), '700'));
    assert.equal(w.seen.idReads, 0);
    assert.equal(w.counter(), 41);
    assert.ok(w.seen.cmWrites.every((x) => !(CFG.cmLinkColumns.clientId in x.cols)));
    assert.equal(w.seen.leadMirror.length, 0);
    assert.ok(w.seen.cmWrites.some((x) => x.cols[CFG.cmLinkColumns.clientAccountId] === '77'), 'the account link still happens');
  } finally { w.done(); }
}));

test('handoff, REPORT: logged only — no number, no ID copy written', quietly(async (logs) => {
  const w = world({ rows: [{ id: '77', name: 'Jane Doe', email: 'jane@x.com' }] });
  try {
    await withEnv(REPORT, () => handoff.stampClientAccount(LEAD(), '700'));
    assert.equal(w.counter(), 41);
    assert.equal(w.seen.clientsWrites.length, 0);
    assert.equal(w.seen.leadMirror.length, 0);
    assert.ok(w.seen.cmWrites.every((x) => !(CFG.cmLinkColumns.clientId in x.cols)));
    assert.ok(logs.some((l) => /would get a new Client ID/.test(l)));
  } finally { w.done(); }
}));

test('handoff: the ID step failing (or throwing) never stops the case link or the lead link', quietly(async () => {
  const w = world({ rows: [{ id: '77', name: 'Jane Doe', email: 'jane@x.com' }] });
  const r = stub(svc, 'ensureClientId', async () => { throw new Error('boom'); });
  try {
    await withEnv(ON, () => handoff.stampClientAccount(LEAD(), '700'));
    assert.ok(w.seen.cmWrites.some((x) => x.cols[CFG.cmLinkColumns.clientAccountId] === '77'));
    assert.deepEqual(w.seen.leadStamps.map((s) => s.f.clientAccountId), ['77']);
  } finally { r(); w.done(); }
}));

test('linkCase: each write has its own try/catch — a failed account-id write no longer stops the ID copy, the relation, or linkLead (review #1)', quietly(async () => {
  const w = world({ rows: [{ id: '77', name: 'Jane Doe', email: 'jane@x.com', clientId: 'CL-2026-00009' }], fail: { cmAccount: true } });
  try {
    await withEnv(ON, () => handoff.stampClientAccount(LEAD(), '700'));
    assert.ok(w.seen.cmWrites.some((x) => x.cols[CFG.cmLinkColumns.clientId] === 'CL-2026-00009'), 'the ID copy is written');
    assert.ok(w.seen.cmWrites.some((x) => CFG.cmLinkColumns.clientRelation in x.cols), 'the relation is written');
    assert.deepEqual(w.seen.leadStamps.map((s) => s.f.clientAccountId), ['77'], 'linkLead still ran');
  } finally { w.done(); }
  const w2 = world({ rows: [{ id: '77', name: 'Jane Doe', email: 'jane@x.com', clientId: 'CL-2026-00009' }], fail: { cmMirror: true, leadMirror: true } });
  try {
    await withEnv(ON, () => handoff.stampClientAccount(LEAD(), '700'));
    assert.ok(w2.seen.cmWrites.some((x) => x.cols[CFG.cmLinkColumns.clientAccountId] === '77'));
    assert.deepEqual(w2.seen.leadStamps.map((s) => s.f.clientAccountId), ['77']);
  } finally { w2.done(); }
}));

test('linkCase / linkLead: a value that is not a Client ID, or no mirror column, writes no copy', quietly(async () => {
  const w = world({ rows: [{ id: '77', name: 'Jane' }] });
  try {
    await svc.linkCase('77', { cmItemId: '700', clientIdText: '2026-VV-00042' });
    await svc.linkLead('77', '500', { clientIdText: 'nope' });
    assert.ok(w.seen.cmWrites.every((x) => !(CFG.cmLinkColumns.clientId in x.cols)));
    assert.equal(w.seen.leadMirror.length, 0);
  } finally { w.done(); }
}));

/* ───────────────────────── (c) a paid consultation ───────────────────────── */

test('paid consultation, ON, a new person: an account (source "consultation") + the ID; the lead points at both; the case later reuses it — the same ID', quietly(async () => {
  const w = world({ leads: [LEAD()] });
  try {
    const r = await withEnv(ON, () => svc.onConsultationPaid('500', { via: 'paid online' }));
    assert.equal(r.ok, true); assert.equal(r.created, true); assert.equal(r.clientIdText, 'CL-2026-00042'); assert.equal(r.minted, true);
    assert.equal(w.board.get(r.clientId).clientId, 'CL-2026-00042');
    assert.equal(w.leadMap.get('500').clientAccountId, r.clientId);
    assert.equal(w.leadMap.get('500').clientIdMirror, 'CL-2026-00042');
    // the retainer is signed later: the handoff reuses lead.clientAccountId
    const fo = stub(svc, 'findOrCreate', async () => { throw new Error('must not run — the lead already has its account'); });
    try { await withEnv(ON, () => handoff.stampClientAccount(w.leadMap.get('500'), '700')); } finally { fo(); }
    assert.ok(w.seen.cmWrites.some((x) => x.cols[CFG.cmLinkColumns.clientId] === 'CL-2026-00042'));
    assert.equal(w.counter(), 42, 'still one number');
  } finally { w.done(); }
}));

test('paid consultation: a webhook retry / the reconciler / a record edited → the SAME ID, no second account, no second number — also when the lead stamp failed the first time', quietly(async () => {
  const w = world({ leads: [LEAD()], fail: { leadStamp: true } });
  try {
    const a = await withEnv(ON, () => svc.onConsultationPaid('500'));
    assert.equal(w.leadMap.get('500').clientAccountId, undefined, 'the lead stamp failed');
    const b = await withEnv(ON, () => svc.onConsultationPaid('500'));   // retry: found again by the exact match
    assert.equal(b.clientId, a.clientId);
    assert.equal(b.clientIdText, a.clientIdText);
    assert.equal(w.seen.creates, 1);
    assert.equal(w.counter(), 42);
  } finally { w.done(); }
  const w2 = world({ leads: [LEAD()] });
  try {
    const runs = await withEnv(ON, () => Promise.all([svc.onConsultationPaid('500'), svc.onConsultationPaid('500'), svc.onConsultationPaid('500')]));
    assert.equal(new Set(runs.map((r) => r.clientIdText)).size, 1, 'deliveries at the same moment: one result');
    const again = await withEnv(ON, () => svc.onConsultationPaid('500'));
    assert.equal(again.clientIdText, runs[0].clientIdText);
    assert.equal(again.created, false);
    assert.equal(w2.seen.creates, 1);
    assert.equal(w2.counter(), 42);
  } finally { w2.done(); }
}));

test('paid consultation: an exact match (same email + name) is linked — its ID kept; a returning client never gets a second number', quietly(async () => {
  const w = world({ rows: [{ id: '77', name: 'Jane Doe', email: 'jane@x.com', clientId: 'CL-2024-00001' }], leads: [LEAD()] });
  try {
    const r = await withEnv(ON, () => svc.onConsultationPaid('500'));
    assert.deepEqual([r.clientId, r.created, r.clientIdText, r.minted], ['77', false, 'CL-2024-00001', false]);
    assert.equal(w.seen.creates, 0);
    assert.equal(w.counter(), 41);
  } finally { w.done(); }
}));

test('paid consultation: a weaker match (shared family email, different name) is NOT linked — a new account and ID, and a note for staff (names + Client IDs, never an item id)', quietly(async () => {
  const w = world({ rows: [{ id: '77', name: 'John Doe', email: 'jane@x.com', clientId: 'CL-2025-00003' }], leads: [LEAD()] });
  try {
    const r = await withEnv(ON, () => svc.onConsultationPaid('500'));
    assert.equal(r.created, true);
    assert.notEqual(r.clientId, '77');
    assert.equal(r.clientIdText, 'CL-2026-00042');
    assert.equal(w.board.get('77').clientId, 'CL-2025-00003', 'the other person is untouched');
    assert.equal(w.seen.notes.length, 1);
    assert.match(w.seen.notes[0].body, /Possibly the same person as an existing client<\/b>: John Doe \(CL-2025-00003\) — same email, different name/);
    assert.match(w.seen.notes[0].body, /NOT linked/);
    assert.ok(!/\b77\b/.test(w.seen.notes[0].body), 'no Monday item id in the note');
    // a re-run: no second note (the account exists now)
    await withEnv(ON, () => svc.onConsultationPaid('500'));
    assert.equal(w.seen.notes.length, 1);
  } finally { w.done(); }
}));

test('paid consultation: the account staff chose for the lead is kept (no matching), and gets its ID', quietly(async () => {
  const w = world({ rows: [{ id: '77', name: 'Jane Doe', email: 'other@x.com' }], leads: [LEAD({ clientAccountId: '77' })] });
  const r0 = stub(svc, 'findOrCreate', async () => { throw new Error('must not run'); });
  try {
    const r = await withEnv(ON, () => svc.onConsultationPaid('500'));
    assert.deepEqual([r.clientId, r.clientIdText], ['77', 'CL-2026-00042']);
  } finally { r0(); w.done(); }
}));

test('paid consultation: switch OFF → nothing at all (not even the lead read); accounts switched off → nothing', quietly(async () => {
  const w = world({ leads: [LEAD()] });
  const gl = stub(leadService, 'getLead', async () => { throw new Error('must not read'); });
  try {
    assert.deepEqual(await withEnv(OFF, () => svc.onConsultationPaid('500')), { ok: false, reason: 'off' });
    assert.deepEqual(await withEnv({ CLIENT_IDS: 'off' }, () => svc.queueConsultationPaid('500')), { ok: false, reason: 'off' });
    assert.equal(w.seen.calls.length, 0);
    const features = require('../config/features');
    const r1 = stub(features, 'clientAccountsEnabled', false);
    try { assert.equal((await withEnv(ON, () => svc.onConsultationPaid('500'))).reason, 'accounts-off'); } finally { r1(); }
    assert.equal(w.seen.calls.length, 0);
  } finally { gl(); w.done(); }
}));

test('paid consultation, REPORT: read-only — says what it would do; no account, no number, no lead write', quietly(async (logs) => {
  const w = world({ rows: [{ id: '77', name: 'Jane Doe', email: 'jane@x.com', clientId: 'CL-2025-00003' }], leads: [LEAD(), LEAD({ id: '501', fullName: 'New Person', email: 'new@x.com', phone: '' }), LEAD({ id: '502', clientAccountId: '77' })] });
  try {
    await withEnv(REPORT, async () => {
      assert.equal((await svc.onConsultationPaid('500', { via: 'paid online' })).reason, 'report');
      assert.equal((await svc.onConsultationPaid('501')).reason, 'report');
      assert.equal((await svc.onConsultationPaid('502')).reason, 'report');
    });
    assert.ok(logs.some((l) => /lead 500: would link the account with CL-2025-00003/.test(l)));
    assert.ok(logs.some((l) => /lead 501: would make a new account/.test(l)));
    assert.ok(logs.some((l) => /lead 502: would keep the lead's account \(Client ID CL-2025-00003\)/.test(l)));
    assert.equal(w.seen.creates, 0);
    assert.equal(w.seen.leadStamps.length, 0);
    assert.equal(w.seen.clientsWrites.length, 0);
    assert.equal(w.counter(), 41);
  } finally { w.done(); }
}));

test('paid consultation: no email and no phone → no account made now (it could never be found again); the case opening makes it', quietly(async () => {
  const w = world({ leads: [LEAD({ email: '', phone: '' })] });
  try {
    assert.equal((await withEnv(ON, () => svc.onConsultationPaid('500'))).reason, 'no-contact');
    assert.equal(w.seen.creates, 0);
  } finally { w.done(); }
}));

test('paid consultation: a phone-only client is matched by phone + name (Monday stores digits only)', quietly(async () => {
  const w = world({ rows: [{ id: '77', name: 'Jane Doe', phone: '4165550100', clientId: 'CL-2025-00003' }], leads: [LEAD({ email: '' })] });
  try {
    const r = await withEnv(ON, () => svc.onConsultationPaid('500'));
    assert.deepEqual([r.clientId, r.clientIdText, r.created], ['77', 'CL-2025-00003', false]);
  } finally { w.done(); }
}));

test('paid consultation: the lead as the caller has it is used (a just-made row may not read back); the year is the lead\'s', quietly(async () => {
  const w = world({ leads: [] });
  try {
    const r = await withEnv(ON, () => svc.onConsultationPaid('600', { lead: { id: '600', fullName: 'Asha Example', email: 'asha@example.com', createdAt: '2025-12-01T12:00:00Z' } }));
    assert.equal(r.ok, true);
    assert.equal(r.clientIdText, 'CL-2025-00042', 'labelled with the year the lead was made');
  } finally { w.done(); }
}));

test('queueConsultationPaid never rejects and never throws, whatever happens inside', quietly(async () => {
  const r0 = stub(svc, 'onConsultationPaid', async () => { throw new Error('boom'); });
  try {
    const r = await svc.queueConsultationPaid('500');
    assert.deepEqual([r.ok, r.reason], [false, 'error']);
  } finally { r0(); }
  const r1 = stub(svc, 'onConsultationPaid', () => { throw new Error('sync boom'); });
  try { assert.equal((await svc.queueConsultationPaid('500')).reason, 'error'); } finally { r1(); }
}));

/* ───────── (c) every place a consultation becomes paid calls it ───────── */

test('Square paid (link / invoice / free by config, all through confirmSlot): the account step is started — first payment, a payment on a hand booking, and the same payment again; never for a different (double) payment', quietly(async () => {
  const bookingService = require('../src/services/bookingService');
  const consultationService = require('../src/services/consultationService');
  const calls = [];
  const leads = new Map([
    ['801', { id: '801', fullName: 'A', bookingStatus: 'Slot Held', squareConsultTxnId: '', consultOption: '' }],
    ['802', { id: '802', fullName: 'B', bookingStatus: 'Booked', squareConsultTxnId: '', consultOption: '' }],
  ]);
  const restore = [
    stub(svc, 'queueConsultationPaid', (id, o) => { calls.push({ id: String(id), via: o.via, lead: !!o.lead }); return Promise.resolve({}); }),
    stub(leadService, 'getLead', async (id) => ({ ...leads.get(String(id)) })),
    stub(leadService, 'updateLead', async (id, f) => { Object.assign(leads.get(String(id)), f); }),
    stub(mondayApi, 'query', async (q) => (/items_page/.test(q) ? { boards: [{ items_page: { cursor: null, items: [] } }] } : {})),
    stub(consultationService, 'onSlotConfirmed', async () => {}),
  ];
  try {
    await bookingService.confirmSlot('801', 'SQ-1', undefined, 0);
    assert.deepEqual(calls, [{ id: '801', via: 'paid online', lead: true }]);
    await bookingService.confirmSlot('802', 'SQ-2', undefined, 0);             // set Booked by hand, then paid
    assert.deepEqual(calls.map((c) => c.id), ['801', '802']);
    await bookingService.confirmSlot('801', 'SQ-1', undefined, 0);             // the webhook again
    assert.deepEqual(calls.map((c) => c.id), ['801', '802', '801'], 'a retry runs it again (it reuses everything)');
    await bookingService.confirmSlot('801', 'SQ-OTHER', undefined, 0);         // a second, different payment
    assert.equal(calls.length, 3, 'a possible double payment starts nothing');
  } finally { restore.reverse().forEach((r) => r()); }
}));

test('the free-by-config booking (SQUARE_CONSULT_FEE_CENTS=0) goes through confirmSlot — so it is covered by the same call', () => {
  const route = require('fs').readFileSync(require.resolve('../src/routes/phase2.js'), 'utf8');
  assert.match(route, /bookingService\.confirmSlot\(leadId, 'free-config', meetingType\)/);
  const src = require('fs').readFileSync(require.resolve('../src/services/bookingService.js'), 'utf8');
  for (const to of [/confirmSlot\(consultLead\.id/, /confirmSlot\(ref\[2\]/, /confirmSlot\(metaLeadId/]) assert.match(src, to, 'link, note and invoice routes all confirm');
});

test('staff "Record payment" and "Waived": the account step is started after the record is saved — and a failure there never fails the record', quietly(async () => {
  const portal = require('../src/services/consultantPortalService');
  for (const [value, via] of [[{ kind: 'cash', amountCents: 20000, on: '2026-10-14' }, 'payment recorded'], [{ kind: 'waived', note: 'returning client' }, 'fee waived']]) {
    const calls = [];
    const state = { id: '555', fullName: 'Test Client', email: 't@x.com' };
    const restore = [
      stub(svc, 'queueConsultationPaid', (id, o) => { calls.push({ id: String(id), via: o.via, saved: !!state.consultPayment }); throw new Error('must not reach staff'); }),
      stub(leadService, 'getLead', async () => ({ ...state })),
      stub(leadService, 'updateLead', async (id, f) => { Object.assign(state, f); }),
      stub(mondayApi, 'query', async () => ({})),
    ];
    try {
      const r = await portal.applyAction({ leadId: '555', action: 'recordConsultPayment', value, staffName: 'Melanie', actor: { name: 'Melanie', verified: false } });
      assert.equal(r.ok, true, via);
      assert.deepEqual(calls, [{ id: '555', via, saved: true }]);
    } finally { restore.reverse().forEach((x) => x()); }
  }
  // removing a record starts nothing (an ID is never taken back)
  const calls = [];
  const state = { id: '556', fullName: 'T', consultPayment: JSON.stringify({ kind: 'cash', amountCents: 100, on: '2026-10-01', by: 'M' }) };
  const restore = [
    stub(svc, 'queueConsultationPaid', (id) => { calls.push(id); return Promise.resolve({}); }),
    stub(leadService, 'getLead', async () => ({ ...state })),
    stub(leadService, 'updateLead', async (id, f) => { Object.assign(state, f); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await portal.applyAction({ leadId: '556', action: 'recordConsultPayment', value: { kind: 'clear' }, staffName: 'M', actor: { name: 'M', verified: false } });
    assert.equal(calls.length, 0);
  } finally { restore.reverse().forEach((x) => x()); }
}));

test('the direct consultation and the Record payment paths both call it right after the fee record is written (source check)', () => {
  const fs = require('fs');
  const dc = fs.readFileSync(require.resolve('../src/services/directConsultService.js'), 'utf8');
  const i = dc.indexOf("await leadService.updateLead(leadId, { consultPayment: JSON.stringify(rec) });");
  const j = dc.indexOf('queueConsultationPaid(leadId', i);
  assert.ok(i > 0 && j > i && j - i < 1200, 'direct consultation: after its fee record, inside the same step');
  assert.match(dc.slice(j, j + 600), /clientAccountId: n\.clientAccountId/, 'an account staff chose in the pop-up is passed on');
  const cp = fs.readFileSync(require.resolve('../src/services/consultantPortalService.js'), 'utf8');
  const k = cp.indexOf("await leadService.updateLead(leadId, { consultPayment: JSON.stringify(rec) });");
  assert.ok(k > 0 && cp.indexOf('queueConsultationPaid(leadId', k) - k < 600);
});
