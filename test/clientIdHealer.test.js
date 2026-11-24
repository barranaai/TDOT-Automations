'use strict';

// The Client ID healer + audit (step 4, 2026-11-25), resolveAccount (review #9), and the
// Client ID lines on the Summary page's "Needs attention" list.
//   - off: nothing is read; report: everything worked out and logged, nothing written;
//     on: missing IDs given (only to records made since CLIENT_IDS_HEAL_SINCE), copies fixed,
//     a case on a Merged record moved to the record it was merged into, cases with no client
//     record joined (exact) / made (no match) / listed (review) — review #4.
//   - the same person twice (exact twins, review #2), IDs typed wrong, on two records, above
//     the counter: listed, never joined, never renumbered.
// Every board seam is a fake (the no-network guard backs it).

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const healer   = require('../src/services/clientIdHealer');
const accounts = require('../src/services/clientAccountService');
const handoff  = require('../src/services/handoffService');
const NA       = require('../src/services/needsAttentionService');
const shipped  = require('../src/data/clientsBoard.json');
const LB       = require('../src/data/newLeadsBoard.json');
const { torontoYear } = require('../src/utils/torontoTime');

const H = 3600 * 1000, D = 24 * H;
const NOW = Date.parse('2026-11-25T15:00:00Z');
const SINCE = '2026-11-20T00:00:00Z';
const iso = (ms) => new Date(ms).toISOString();

async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const quiet = async (fn) => {
  const o = [console.log, console.warn, console.error]; const logs = [];
  console.log = console.warn = console.error = (...a) => logs.push(a.join(' '));
  try { return await fn(logs); } finally { [console.log, console.warn, console.error] = o; }
};

const CFG = JSON.parse(JSON.stringify(shipped));
CFG.columns.clientId = 'text_cid';
CFG.cmLinkColumns.clientId = 'text_cmcid';
CFG.leadLinkColumns.clientId = 'text_leadcid';
const C = CFG.columns;
const CM = healer.CM_COL;

/** A Clients row as Monday returns it. */
function client({ id, name = 'Jane Doe', email = '', phone = '', dob = '', status = 'Active', mergedInto = '', cid = '', created = NOW - 2 * D, hide = [] }) {
  const cells = { [C.primaryEmail]: email, [C.phone]: phone, [C.dateOfBirth]: dob, [C.status]: status, [C.mergedInto]: mergedInto, [C.clientId]: cid };
  return { id: String(id), name, created_at: iso(created), column_values: Object.entries(cells).filter(([k]) => !hide.includes(k)).map(([cid2, text]) => ({ id: cid2, text })) };
}
/** A Client Master row. */
function cmRow({ id, name = 'Jane Doe', ref = '2026-VV-001', email = '', phone = '', account = '', copy = '', created = NOW - 2 * D, group = { id: 'group_live', title: 'November 2026' }, hide = [] }) {
  const cells = { [CM.caseRef]: ref, [CM.clientEmail]: email, [CM.clientPhone]: phone, [CFG.cmLinkColumns.clientAccountId]: account, [CFG.cmLinkColumns.clientId]: copy };
  return { id: String(id), name, created_at: iso(created), group, column_values: Object.entries(cells).filter(([k]) => !hide.includes(k)).map(([k, text]) => ({ id: k, text })) };
}
function leadRow({ id, account = '', copy = '' }) {
  return { id: String(id), name: 'x', created_at: iso(NOW - 5 * D), column_values: [{ id: LB.columns.clientAccountId, text: account }, { id: CFG.leadLinkColumns.clientId, text: copy }] };
}

/**
 * The fake world: the healer's io + a recording accounts object (the real pure pieces —
 * classifyMatch, normalizers, resolveAccount, yearForLead — with every write faked).
 */
function world({ clients = [], cases = [], leads = [], counter = { state: 'ok', last: 100 }, caseLeads = {}, matches = {}, cfg = CFG, fail = {} } = {}) {
  const seen = { reads: { clients: 0, cases: 0, leads: 0, counter: 0, leadsOfCase: 0 }, writes: [], ensures: [], linkCase: [], linkLead: [], findOrCreate: [], findMatches: [] };
  let nextCid = 500, nextAcc = 9000;
  const acc = {
    ...accounts,
    async ensureClientId(id, opts = {}) {
      seen.ensures.push({ id: String(id), ...opts });
      const row = clients.find((r) => r.id === String(id));
      const cell = row && row.column_values.find((c) => c.id === C.clientId);
      if (cell && cell.text) return { ok: true, id: cell.text, minted: false };
      const newId = `CL-${opts.year || torontoYear(NOW)}-${String(++nextCid).padStart(5, '0')}`;
      if (cell) cell.text = newId;
      return { ok: true, id: newId, minted: true };
    },
    async linkCase(id, o) { seen.linkCase.push({ id: String(id), ...o }); },
    async linkLead(id, leadId, o) { seen.linkLead.push({ id: String(id), leadId: String(leadId), ...o }); },
    async findMatches(q) { seen.findMatches.push(q); return matches[q.email || q.phone] || []; },
    async findOrCreate(q) { seen.findOrCreate.push(q); const id = String(++nextAcc); clients.push(client({ id, name: q.fullName, email: q.email })); return { clientId: id, created: true, reviewCandidates: [], clientIdText: '' }; },
  };
  const saved = { ...healer.io };
  Object.assign(healer.io, {
    loadBoard: () => cfg,
    readClients: async () => { seen.reads.clients++; if (fail.clients) throw new Error('Monday 503'); return clients; },
    readCases: async () => { seen.reads.cases++; if (fail.cases) throw new Error('Monday 503'); return cases; },
    readLeads: async () => { seen.reads.leads++; return leads; },
    peekCounter: async () => { seen.reads.counter++; return counter; },
    leadsOfCase: async (id) => { seen.reads.leadsOfCase++; return caseLeads[id] || []; },
    writeText: async (b, i, col, v) => { seen.writes.push({ board: String(b), item: String(i), col, value: v }); },
    accounts: () => acc,
    now: () => NOW,
  });
  healer._resetForTests();
  return { seen, restore: () => Object.assign(healer.io, saved) };
}

/* ───────────────────────────── the switch ───────────────────────────── */

test('off: the hourly tick reads nothing, and the Needs-attention list gets no line', async () => {
  const w = world({ clients: [client({ id: 1 })] });
  try {
    await withEnv({ CLIENT_IDS: undefined }, async () => {
      assert.deepEqual(await healer.tick(), { ok: false, reason: 'off' });
      assert.deepEqual(await healer.problemsForNeedsAttention(), []);
    });
    assert.deepEqual(w.seen.reads, { clients: 0, cases: 0, leads: 0, counter: 0, leadsOfCase: 0 });
  } finally { w.restore(); }
});

test('the shipped config (column ids null): not-configured, nothing read', async () => {
  const w = world({ cfg: shipped });
  try {
    await withEnv({ CLIENT_IDS: 'on' }, async () => {
      const r = await quiet(() => healer.tick());
      assert.equal(r.reason, 'not-configured');
      const a = await healer.audit();
      assert.equal(a.reason, 'not-configured');
    });
    assert.equal(w.seen.reads.clients, 0);
  } finally { w.restore(); }
});

/* ───────────────────────────── pure pieces ───────────────────────────── */

test('idProblems: typed wrong, one number on two records (any year label), above the counter', () => {
  const rows = [
    client({ id: 1, name: 'A', cid: 'CL-2026-00042' }), client({ id: 2, name: 'B', cid: 'CL-2025-00042' }),
    client({ id: 3, name: 'C', cid: 'cl 2026 7' }), client({ id: 4, name: 'D', cid: 'CL-2026-90000' }),
    client({ id: 5, name: 'E', cid: 'CL-2026-00050', status: 'Merged' }), client({ id: 6, name: 'F', cid: '' }),
  ].map((it) => healer.parseClient(it, CFG));
  const out = healer.idProblems(rows, 100);
  assert.deepEqual(out.map((p) => `${p.reason}:${p.rows.map((r) => r.name).join('+')}`).sort(),
    ['above-counter:D', 'duplicate:A+B', 'malformed:C']);
  assert.deepEqual(healer.idProblems(rows, null).map((p) => p.reason).sort(), ['duplicate', 'malformed'], 'no counter: the range is not checked');
});

test('findTwins: the app\'s own strict rule — email+name, phone+name when one has no email; never spouses, never two dates of birth, never a Merged row', () => {
  const T = (list) => healer.findTwins(list.map((it) => healer.parseClient(it, CFG)), accounts.classifyMatch,
    { normName: handoff.normName, normalizeEmail: accounts.normalizeEmail, normalizePhone: accounts.normalizePhone })
    .map((t) => t.rows.map((r) => r.id).sort().join('+')).sort();
  assert.deepEqual(T([client({ id: 1, email: 'j@x.com' }), client({ id: 2, name: ' jane  DOE ', email: 'J@x.com' })]), ['1+2']);
  assert.deepEqual(T([client({ id: 1, email: 'j@x.com' }), client({ id: 2, name: 'John Doe', email: 'j@x.com' })]), [], 'shared family email');
  assert.deepEqual(T([client({ id: 1, phone: '4165551234' }), client({ id: 2, phone: '14165551234', email: 'j@x.com' })]), ['1+2'], 'phone + name, one without email');
  assert.deepEqual(T([client({ id: 1, phone: '4165551234', email: 'a@x.com' }), client({ id: 2, phone: '4165551234', email: 'b@x.com' })]), [], 'both have an email: the email decides');
  assert.deepEqual(T([client({ id: 1, email: 'j@x.com', dob: '1990-01-01' }), client({ id: 2, email: 'j@x.com', dob: '1960-01-01' })]), [], 'Sr / Jr');
  assert.deepEqual(T([client({ id: 1, email: 'j@x.com' }), client({ id: 2, email: 'j@x.com', status: 'Merged' })]), []);
  assert.deepEqual(T([client({ id: 1, email: 'j@x.com' }), client({ id: 2, email: 'j@x.com', phone: '4165550000' }), client({ id: 3, phone: '4165550000' })]), ['1+2+3'], 'joined through a chain');
});

test('resolveAccount: follows Merged into, by record number or Client ID; stops on a loop, a missing, Archived or unclear target', async () => {
  const rows = new Map(Object.entries({
    1: { id: '1', status: 'Active', clientIdText: 'CL-2026-00001' },
    2: { id: '2', status: 'Merged', mergedInto: '1' },
    3: { id: '3', status: 'Merged', mergedInto: ' 2 ' },
    4: { id: '4', status: 'Merged', mergedInto: '5' }, 5: { id: '5', status: 'Merged', mergedInto: '4' },
    6: { id: '6', status: 'Merged', mergedInto: '77' },
    7: { id: '7', status: 'Archived' }, 8: { id: '8', status: 'Merged', mergedInto: '7' },
    9: { id: '9', status: 'Merged', mergedInto: '' },
    10: { id: '10', status: 'Merged', mergedInto: 'CL-2026-00001' },
    11: { id: '11', status: 'Merged', mergedInto: 'CL-2026-00002' },
    12: { id: '12', status: '' },
  }));
  const byNum = { 1: [rows.get('1')], 2: [{ id: '20' }, { id: '21' }] };
  const L = { getById: (id) => rows.get(id) || null, getByClientNumber: (n) => byNum[n] || [] };
  const R = async (id) => { const r = await accounts.resolveAccount(id, L); return r.ok ? `ok:${r.accountId}${r.merged ? ':merged' : ''}` : r.reason; };
  assert.equal(await R('1'), 'ok:1');
  assert.equal(await R('3'), 'ok:1:merged');
  assert.equal(await R('4'), 'cycle');
  assert.equal(await R('6'), 'missing');
  assert.equal(await R('8'), 'archived');
  assert.equal(await R('9'), 'merged-nowhere');
  assert.equal(await R('10'), 'ok:1:merged');
  assert.equal(await R('11'), 'ambiguous');
  assert.equal(await R('12'), 'ok:12', 'a blank status is a live record (as findMatches treats it)');
  assert.equal(await R('CL-2026-00001'), 'bad-link');
  assert.equal(await R(''), 'bad-link');
  const chain = new Map(); for (let i = 0; i < 15; i++) chain.set(String(100 + i), { id: String(100 + i), status: 'Merged', mergedInto: String(101 + i) });
  assert.equal((await accounts.resolveAccount('100', { getById: (id) => chain.get(id) || null })).reason, 'too-deep');
  assert.equal((await accounts.resolveAccount('1', { getById: () => { throw new Error('503'); } })).reason, 'unavailable', 'a failed read is never "missing"');
  assert.equal((await accounts.resolveAccount('10', { getById: L.getById })).reason, 'merged-nowhere', 'no Client ID lookup given');
});

/* ───────────────────────────── report ───────────────────────────── */

function busyWorld() {
  return world({
    clients: [
      client({ id: 1, name: 'Ann Lee', email: 'ann@x.com', cid: 'CL-2026-00001' }),
      client({ id: 2, name: 'Ann Lee', email: 'ann@x.com', cid: 'CL-2026-00002' }),          // twin of 1
      client({ id: 3, name: 'Bob Roy', email: 'bob@x.com', created: NOW - 2 * D }),          // new, no ID
      client({ id: 4, name: 'Cy Old', email: 'cy@x.com', created: Date.parse('2026-09-01T00:00:00Z') }),   // before HEAL_SINCE
      client({ id: 5, name: 'Dee Loser', email: 'dee@x.com', status: 'Merged', mergedInto: '6', cid: 'CL-2026-00005' }),
      client({ id: 6, name: 'Dee Winner', email: 'dee@x.com', cid: 'CL-2026-00006' }),
      client({ id: 7, name: 'Test Client', email: 't@x.com', created: NOW - 2 * D }),        // test-looking: never given one
      client({ id: 8, name: 'Eve New', email: 'eve@x.com', created: NOW - 10 * 60 * 1000 }),    // in the grace period
    ],
    cases: [
      cmRow({ id: 101, name: 'Ann Lee', ref: '2026-VV-001', account: '1', copy: '' }),                 // copy blank → fix
      cmRow({ id: 102, name: 'Ann Lee', ref: '2026-VV-002', account: '1', copy: 'CL-2026-00099' }),    // copy wrong → fix
      cmRow({ id: 103, name: 'Dee', ref: '2026-SV-003', account: '5', copy: 'CL-2026-00005' }),        // on the Merged row → move
      cmRow({ id: 104, name: 'Gone', ref: '2026-SV-004', account: '777', copy: '' }),                 // missing record
      cmRow({ id: 105, name: 'Typed', ref: '2026-SV-005', account: '', copy: 'CL-2026-00042' }),       // ID with no record
      cmRow({ id: 106, name: 'Ok', ref: '2026-SV-006', account: '6', copy: 'CL-2026-00006' }),         // fine
      cmRow({ id: 107, name: 'Unread', ref: '2026-SV-007', account: '1', hide: [CFG.cmLinkColumns.clientId] }),
    ],
    leads: [leadRow({ id: 201, account: '1', copy: '' }), leadRow({ id: 202, account: '5', copy: '' }), leadRow({ id: 203, account: '6', copy: 'CL-2026-00006' })],
  });
}

test('report: everything worked out and logged — nothing written, nothing made, nothing given', async () => {
  const w = busyWorld();
  try {
    const out = await withEnv({ CLIENT_IDS: 'report', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(async (logs) => {
      const r = await healer.tick();
      return { r, logs };
    }));
    assert.equal(out.r.ok, true);
    assert.equal(out.r.wrote, false);
    assert.deepEqual([w.seen.writes, w.seen.ensures, w.seen.linkCase, w.seen.linkLead, w.seen.findOrCreate], [[], [], [], [], []]);
    assert.deepEqual(out.r.wouldDo.mint, ['Bob Roy'], 'only the new, real, settled record');
    assert.equal(out.r.wouldDo.copies, 2);
    assert.equal(out.r.wouldDo.moves, 1);
    assert.equal(out.r.wouldDo.leadCopies, 1);
    assert.equal(out.r.wouldDo.leadMoves, 1);
    assert.equal(out.r.cases.unreadable, 1, 'a row whose copy did not come back is left alone');
    assert.deepEqual(out.r.clients.testLookingWithoutId, ['Test Client']);
    assert.equal(out.r.clients.activeWithoutIdBeforeHealSince, 1);
    assert.ok(out.logs.some((l) => /report — nothing written/.test(l) && /would give 1 Client ID/.test(l)));
    const kinds = out.r.lines.map((l) => `${l.kind}:${l.caseRef || l.label}`).sort();
    assert.deepEqual(kinds, ['client-id-case:2026-SV-004', 'client-id-case:2026-SV-005', 'client-id-twins:CL-2026-00001 / CL-2026-00002']);
    // the lines never carry a Monday record id
    for (const l of healer.lastReport().problems) for (const k of ['why', 'todo', 'client', 'label']) assert.ok(!/\b(777|10[1-7])\b/.test(String(l[k] || '')), `${k}: ${l[k]}`);
    for (const l of out.r.lines) assert.deepEqual(Object.keys(l).sort(), ['caseRef', 'client', 'kind', 'label', 'todo', 'why'], 'the audit lines carry no record ids');
  } finally { w.restore(); }
});

/* ───────────────────────────── on ───────────────────────────── */

test('on, CLIENT_IDS_HEAL_SINCE unset: copies fixed and merged cases moved, but no ID given and no record made', async () => {
  const w = busyWorld();
  try {
    const r = await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: undefined }, () => quiet(() => healer.tick()));
    assert.equal(r.wrote, true);
    assert.deepEqual(w.seen.ensures, [], 'no ID without the heal-since date');
    assert.deepEqual(w.seen.writes.map((x) => `${x.board}:${x.item}=${x.value}`).sort(),
      [`${CFG.clientMasterBoardId}:101=CL-2026-00001`, `${CFG.clientMasterBoardId}:102=CL-2026-00001`, `${LB.boardId}:201=CL-2026-00001`].sort());
    assert.deepEqual(w.seen.linkCase, [{ id: '6', cmItemId: '103', clientIdText: 'CL-2026-00006' }], 'the case on the Merged row goes to the row it was merged into');
    assert.deepEqual(w.seen.linkLead, [{ id: '6', leadId: '202', clientIdText: 'CL-2026-00006' }]);
    assert.equal(r.clients.activeWithoutIdBeforeHealSince, 4, 'every blank row counts as the backfill\'s while the date is unset');
  } finally { w.restore(); }
});

test('on, with CLIENT_IDS_HEAL_SINCE: the new record gets its ID (year from when it was made), and its copies follow in the same run', async () => {
  const w = world({
    clients: [client({ id: 3, name: 'Bob Roy', email: 'bob@x.com', created: NOW - 2 * D })],
    cases: [cmRow({ id: 301, name: 'Bob Roy', account: '3', copy: '' })],
    leads: [leadRow({ id: 401, account: '3', copy: '' })],
  });
  try {
    const r = await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.deepEqual(w.seen.ensures.map((e) => [e.id, e.year]), [['3', 2026]]);
    assert.deepEqual(r.did.minted, ['Bob Roy CL-2026-00501']);
    assert.deepEqual(w.seen.writes.map((x) => `${x.item}=${x.value}`).sort(), ['301=CL-2026-00501', '401=CL-2026-00501']);
  } finally { w.restore(); }
});

test('on: at most MAX_MINTS IDs a run, the rest next hour', async () => {
  const clients = [];
  for (let i = 0; i < healer.MAX_MINTS + 3; i++) clients.push(client({ id: 1000 + i, name: `Person ${i}`, email: `p${i}@x.com` }));
  const w = world({ clients });
  try {
    const r = await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.equal(w.seen.ensures.length, healer.MAX_MINTS);
    assert.ok(r.partial.some((p) => /3 more client record/.test(p)));
  } finally { w.restore(); }
});

/* ───────────────────────────── cases with no client record (review #4) ───────────────────────────── */

function caseWorld() {
  return world({
    clients: [client({ id: 1, name: 'Ann Lee', email: 'ann@x.com', cid: 'CL-2026-00001' })],
    cases: [
      cmRow({ id: 501, name: 'Lead Stamped', ref: '2026-VV-011' }),                                // its lead names the record
      cmRow({ id: 502, name: 'Ann Lee', ref: '2026-VV-012', email: 'ann@x.com' }),                  // exact match, no lead
      cmRow({ id: 503, name: 'Ann Leigh', ref: '2026-VV-013', email: 'share@x.com' }),              // review match
      cmRow({ id: 504, name: 'New Person', ref: '2026-VV-014', email: 'new@x.com' }),               // nobody: made
      cmRow({ id: 505, name: 'Walk In', ref: '2026-VV-015' }),                                     // no contact anywhere
      cmRow({ id: 506, name: 'Old Row', ref: '2023-VV-016', email: 'old@x.com', created: Date.parse('2026-06-01T00:00:00Z') }),
      cmRow({ id: 507, name: 'Fresh', ref: '2026-VV-017', email: 'fresh@x.com', created: NOW - 5 * 60 * 1000 }),
      cmRow({ id: 508, name: 'Someone', ref: '', email: 'x@x.com', group: { id: 'group_mm3842s', title: 'TEST' } }),
      cmRow({ id: 509, name: 'ZZ-TEST Template', ref: '2026-VV-019', email: 'z@x.com' }),
    ],
    caseLeads: {
      501: [{ id: '601', fullName: 'Lead Stamped', email: 'ls@x.com', clientAccountId: '1', createdAt: iso(NOW - 3 * D) }],
      504: [{ id: '604', fullName: 'New Person', email: 'new@x.com', createdAt: iso(NOW - 3 * D) }],
    },
    matches: {
      'ann@x.com': [{ id: '1', name: 'Ann Lee', clientIdText: 'CL-2026-00001', confidence: 'exact', reasons: ['same email', 'same name'] }],
      'share@x.com': [{ id: '1', name: 'Ann Lee', clientIdText: 'CL-2026-00001', confidence: 'review', reasons: ['same email', 'different name — shared family email or a name change; verify identity'] }],
    },
  });
}

test('on: a case made since the backfill with no client record — exact → joined, none → made, review → listed; never a test row, an old row or one still being set up', async () => {
  const w = caseWorld();
  try {
    const r = await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.deepEqual(w.seen.linkCase.map((x) => `${x.cmItemId}→${x.id}`).sort(), ['501→1', '502→1', '504→9001'].sort());
    assert.deepEqual(w.seen.linkLead.map((x) => `${x.leadId}→${x.id}`).sort(), ['601→1', '604→9001'].sort());
    assert.deepEqual(w.seen.findOrCreate.map((q) => q.fullName), ['New Person'], 'named from the consultation record, never for a review match');
    assert.equal(w.seen.findOrCreate[0].source, 'hourly check');
    assert.ok(w.seen.linkCase.find((x) => x.cmItemId === '504').clientIdText.startsWith('CL-2026-'), 'the made record gets its ID before the case copies it');
    const lines = r.lines.filter((l) => l.kind === 'client-id-case').map((l) => l.caseRef).sort();
    assert.deepEqual(lines, ['2026-VV-013', '2026-VV-015']);
    const review = healer.lastReport().problems.find((l) => l.caseRef === '2026-VV-013');
    assert.match(review.why, /"Ann Lee" \(CL-2026-00001\)/);
    assert.match(review.todo, /Nothing is joined automatically/);
    assert.deepEqual(r.did.recordsMade.length, 1);
  } finally { w.restore(); }
});

test('report: the same cases are only looked at — no record made, none joined', async () => {
  const w = caseWorld();
  try {
    const r = await withEnv({ CLIENT_IDS: 'report', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.deepEqual([w.seen.linkCase, w.seen.linkLead, w.seen.findOrCreate, w.seen.ensures], [[], [], [], []]);
    assert.deepEqual(r.wouldDo.caseJoin.sort(), ['2026-VV-011', '2026-VV-012']);
    assert.deepEqual(r.wouldDo.caseCreate, ['2026-VV-014']);
  } finally { w.restore(); }
});

test('audit: read-only in every mode (even on), and the route is admin-only', async () => {
  const w = caseWorld();
  try {
    for (const mode of ['off', 'report', 'on']) {
      const r = await withEnv({ CLIENT_IDS: mode, CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.audit()));
      assert.equal(r.ok, true); assert.equal(r.wrote, false, mode);
    }
    assert.deepEqual([w.seen.writes, w.seen.linkCase, w.seen.findOrCreate, w.seen.ensures], [[], [], [], []]);
  } finally { w.restore(); }
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const i = src.indexOf("app.get('/admin/client-ids/audit'");
  assert.ok(i !== -1);
  assert.ok(src.slice(i, i + 400).includes('resolveAdminOrReject'));
  assert.ok(src.slice(i, i + 400).includes("require('./services/clientIdHealer').audit()"));
  const j = src.indexOf("app.post('/admin/client-ids/probe-record'");
  assert.ok(j !== -1);
  assert.ok(src.slice(j, j + 400).includes('resolveNamedAdminViewerOrReject'), 'it writes a scratch file: named admins only');
  assert.ok(src.slice(j, j + 400).includes("require('./services/clientIdAllocator').probeCounterWrites()"));
});

test('the Clients board cannot be read: the tick says so and never throws; the audit throws (the route answers 500)', async () => {
  const w = world({ fail: { clients: true } });
  try {
    const r = await withEnv({ CLIENT_IDS: 'on' }, () => quiet(() => healer.tick()));
    assert.equal(r.ok, false); assert.equal(r.reason, 'error');
    await assert.rejects(() => quiet(() => healer.audit()), /503/);
    await withEnv({ CLIENT_IDS: 'on' }, () => assert.rejects(() => quiet(() => healer.problemsForNeedsAttention())));
  } finally { w.restore(); }
});

test('the Client Master board cannot be read: the Clients checks still run, the gap is said', async () => {
  const w = world({ clients: [client({ id: 1, email: 'j@x.com' }), client({ id: 2, email: 'j@x.com' })], fail: { cases: true } });
  try {
    const r = await withEnv({ CLIENT_IDS: 'report' }, () => quiet(() => healer.tick()));
    assert.equal(r.ok, true);
    assert.ok(r.partial.some((p) => /Client Master board could not be read/.test(p)));
    assert.deepEqual(r.lines.map((l) => l.kind), ['client-id-twins']);
  } finally { w.restore(); }
});

test('the scheduler runs the check hourly at :43 through tick() (which reads nothing while off)', () => {
  const src = fs.readFileSync(require.resolve('../src/services/scheduler.js'), 'utf8');
  assert.match(src, /cron\.schedule\('43 \* \* \* \*', \(\) =>\s*withTimeout\('Client ID check', \(\) => require\('\.\/clientIdHealer'\)\.tick\(\)\)/);
});

test('reads page with items_page(limit:200) and the cursor — never items(ids:)', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const orig = mondayApi.query; const qs = [];
  let n = 0;
  mondayApi.query = async (q) => { qs.push(q); n++; return { boards: [{ items_page: { cursor: n < 3 ? `c${n}` : null, items: [{ id: String(n) }] } }] }; };
  try {
    const items = await healer.pageBoard('123', 'id');
    assert.deepEqual(items.map((x) => x.id), ['1', '2', '3']);
    assert.ok(qs.every((q) => /items_page\(limit:200/.test(q) && !/items\(ids/.test(q)));
    assert.ok(/cursor:\$c/.test(qs[1]));
  } finally { mondayApi.query = orig; }
});

/* ───────────────────────────── following Merged on the live paths ───────────────────────────── */

test('survivingAccount: off and report keep the account as given with no read; on follows a Merged record', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const orig = mondayApi.query; let reads = 0;
  accounts._setBoardForTests(CFG);
  mondayApi.query = async (q, v) => {
    reads++;
    const rows = { 5: { status: 'Merged', merged: '6' }, 6: { status: 'Active', merged: '' } };
    const r = rows[v.id];
    return { items: r ? [{ id: v.id, name: 'x', board: { id: String(CFG.boardId) }, column_values: [{ id: C.status, text: r.status }, { id: C.mergedInto, text: r.merged }, { id: C.clientId, text: v.id === '6' ? 'CL-2026-00006' : '' }] }] : [] };
  };
  try {
    await quiet(async () => {
      await withEnv({ CLIENT_IDS: undefined }, async () => assert.equal(await accounts.survivingAccount('5'), '5'));
      await withEnv({ CLIENT_IDS: 'report' }, async () => assert.equal(await accounts.survivingAccount('5'), '5'));
      assert.equal(reads, 0);
      await withEnv({ CLIENT_IDS: 'on' }, async () => {
        assert.equal(await accounts.survivingAccount('5'), '6');
        assert.equal(await accounts.survivingAccount('6'), '6');
        assert.equal(await accounts.survivingAccount('999'), '999', 'a chain that cannot be followed keeps the account as given');
        const r = await accounts.resolveClientId('5');
        assert.deepEqual([r.ok, r.accountId, r.clientIdText, r.merged], [true, '6', 'CL-2026-00006', true]);
      });
    });
    assert.ok(reads > 0);
  } finally { mondayApi.query = orig; accounts._setBoardForTests(undefined); }
});

test('the handoff and the paid consultation ask survivingAccount for an account the lead already carries', () => {
  const h = fs.readFileSync(require.resolve('../src/services/handoffService.js'), 'utf8');
  assert.match(h, /let clientId = preChosen \? await accounts\.survivingAccount\(preChosen, \{ why: 'case opened' \}\) : '';/);
  const a = fs.readFileSync(require.resolve('../src/services/clientAccountService.js'), 'utf8');
  assert.match(a, /let clientId = preChosen \? await self\.survivingAccount\(preChosen, \{ why: 'paid consultation' \}\) : '';/);
});

/* ───────────────────────────── the counter probe ───────────────────────────── */

test('probeCounterWrites: the counter is only read; the four write checks run on a scratch file', async () => {
  const allocator = require('../src/services/clientIdAllocator');
  const saved = { ...allocator.io };
  const files = new Map(); const touched = [];
  let ver = 0;
  Object.assign(allocator.io, {
    readCounter: async () => ({ data: { last: 41 }, etag: 'c1' }),
    writeCounter: async () => { throw new Error('the counter must not be written'); },
    scratchWrite: async (file, data, { etag = '' } = {}) => {
      touched.push(file);
      const cur = files.get(file);
      if (!etag && cur) { const e = new Error('exists'); e.conflict = true; throw e; }
      if (etag && (!cur || cur.etag !== etag)) { const e = new Error('changed'); e.conflict = true; throw e; }
      files.set(file, { data, etag: `v${++ver}` });
      return { created: !cur, etag: `v${ver}` };
    },
    scratchRead: async (file) => files.get(file) || null,
    now: () => NOW,
  });
  try {
    const r = await allocator.probeCounterWrites();
    assert.equal(r.ok, true, JSON.stringify(r.steps));
    assert.deepEqual(r.counter, { state: 'ok', last: 41 });
    assert.ok(touched.every((f) => /^TDOT System\/client-id-counter\.probe-.+\.json$/.test(f) && f !== allocator.COUNTER_PATH));
    assert.deepEqual(await allocator.peekCounter(), { state: 'ok', last: 41 });
  } finally { Object.assign(allocator.io, saved); }
});

/* ───────────────────────────── the Needs-attention lines ───────────────────────────── */

function naWorld(lines) {
  const saved = { ...NA.io };
  const posted = [];
  let notes = new Map();
  Object.assign(NA.io, {
    now: () => NOW,
    readCases: async () => [],
    listRootFolders: async () => [],
    leads: async () => [],
    reminderTemplateProblems: async () => [],
    readDeepNotes: async (ids) => ({ notes: new Map(ids.filter((id) => notes.has(id)).map((id) => [id, notes.get(id)])), failed: [] }),
    clientIdProblems: async () => lines,
    postNote: async (itemId, body) => { posted.push({ itemId: String(itemId), body }); notes.set(String(itemId), [{ id: 'n1', created_at: iso(NOW), text_body: body.replace(/<[^>]+>/g, '') }]); },
  });
  NA._resetForTests();
  return { posted, restore: () => { Object.assign(NA.io, saved); NA._resetForTests(); } };
}

const LINES = [
  { kind: 'client-id-twins', fingerprint: 'client-id-twins|1,2', accountItemId: '1', client: 'Ann Lee', label: 'CL-2026-00001 / CL-2026-00002', since: iso(NOW - D), why: 'w1', todo: 't1' },
  { kind: 'client-id-case', fingerprint: 'client-id-case|104|broken|missing', cmItemId: '104', caseRef: '2026-SV-004', client: 'Gone', since: iso(NOW - D), why: 'w2', todo: 't2' },
  { kind: 'not-a-kind', fingerprint: 'x', why: 'dropped' },
];

test('Needs attention: the Client ID lines are listed for admins / see-all only, never with the record\'s Monday id; Mark handled notes the record or the case', async () => {
  const w = naWorld(LINES);
  try {
    await NA.refresh({ reason: 'test' });
    const admin = NA.view({ isAdmin: true });
    assert.deepEqual(admin.entries.map((e) => e.kind).sort(), ['client-id-case', 'client-id-twins']);
    for (const e of admin.entries) assert.ok(!('noteItemId' in e), 'no record id goes to the page');
    const twin = admin.entries.find((e) => e.kind === 'client-id-twins');
    assert.equal(twin.linkLabel, 'CL-2026-00001 / CL-2026-00002');
    assert.deepEqual(twin.itemIds, []);
    const kase = admin.entries.find((e) => e.kind === 'client-id-case');
    assert.equal(kase.caseRef, '2026-SV-004'); assert.deepEqual(kase.itemIds, ['104']);
    assert.ok(admin.kinds['client-id-twins'] && admin.kinds['client-id-case'] && admin.kinds['client-id-bad']);
    assert.deepEqual(NA.view({ scope: 'own', email: 'a@x.com', userId: '1' }).entries, [], 'a viewer limited to their own cases sees none');
    await assert.rejects(() => NA.markHandled({ key: twin.key, viewer: { scope: 'own', email: 'a@x.com' }, actor: 'X' }), (e) => e.status === 404);
    assert.deepEqual(await NA.markHandled({ key: twin.key, viewer: { isAdmin: true }, actor: 'Gauri' }), { ok: true });
    assert.deepEqual(await NA.markHandled({ key: kase.key, viewer: { isAdmin: true }, actor: 'Gauri' }), { ok: true });
    assert.deepEqual(w.posted.map((p) => p.itemId), ['1', '104'], 'on the client record; on the case');
    assert.match(w.posted[0].body, /Same person twice on the Clients board/);
    // The next check reads the record's note: the twin line stays handled.
    NA._resetForTests();
    await NA.refresh({ reason: 'test 2' });
    assert.deepEqual(NA.view({ isAdmin: true }).entries.map((e) => e.kind), ['client-id-case'], 'the case note is read with the case (none here: no case rows in this fake)');
  } finally { w.restore(); }
});

test('Needs attention: a failed Client ID check is said, and the rest of the list stands', async () => {
  const w = naWorld([]);
  NA.io.clientIdProblems = async () => { throw new Error('Monday 503'); };
  try {
    const snap = await quiet(() => NA.refresh({ reason: 'test' }));
    assert.ok(snap.partial.some((p) => /Client IDs could not be checked \(Monday 503\)/.test(p)));
  } finally { w.restore(); }
});

test('Needs attention: the shipped seam asks the healer — no read at all while CLIENT_IDS is off', async () => {
  const fresh = require('../src/services/needsAttentionService');
  const src = fs.readFileSync(require.resolve('../src/services/needsAttentionService.js'), 'utf8');
  assert.match(src, /clientIdProblems: \(\) => require\('\.\/clientIdHealer'\)\.problemsForNeedsAttention\(\)/);
  await withEnv({ CLIENT_IDS: undefined }, async () => assert.deepEqual(await healer.problemsForNeedsAttention(), []));
  assert.ok(fresh.CLIENT_ID_KINDS);
});

test('the handled note for a Client ID line reads as none of the app\'s own notes', () => {
  const resume = require('../src/services/onboardingResumeService');
  for (const kind of Object.keys(NA.CLIENT_ID_KINDS)) {
    const t = NA.handledNoteBody({ key: 'NA-0123456789', kind, caseRef: '', itemIds: [] }, 'Staff');
    assert.match(t, new RegExp(NA.CLIENT_ID_KINDS[kind].label));
    const plain = t.replace(/<[^>]+>/g, '');
    for (const [name, re] of Object.entries(NA.NOTE)) if (name !== 'handled') assert.ok(!re.test(plain) && !re.test(t), `${kind}: must not read as "${name}"`);
    const r = resume.readNotes([{ created_at: iso(NOW), text_body: plain, body: t }]);
    assert.deepEqual(r.evidence, []);
    assert.equal(NA.newestPaymentNote(NA.caseNotes([{ id: 'y', created_at: iso(NOW), text_body: plain }])), null);
  }
  assert.deepEqual(NA.clientIdEntries([{ kind: 'client-id-bad' }]), [], 'a line with no fingerprint is dropped');
});

/* ───────────────────────────── 31 December (the year on the list's dates) ───────────────────────────── */

test('31 December 23:30 Toronto: a date earlier that year is shown without the year (the Toronto year, not the server\'s UTC one)', () => {
  const at = Date.parse('2027-01-01T04:30:00Z');   // 31 Dec 2026 23:30 Toronto
  const keep = NA.io.now;
  NA.io.now = () => at;
  try {
    const mk = (id) => ({ id, name: `Client ${id}`, created_at: '2026-12-10T15:00:00Z', group: { id: 'group_live', title: 'December 2026' },
      column_values: [['text_mm142s49', '2026-SV-090'], ['color_mm0x8faa', 'Document Collection Started'], ['color_mm0x9fnn', 'Paid'], ['dropdown_mm0xd1qn', 'Visitor Visa']].map(([cid, text]) => ({ id: cid, text, value: null })), updates: [] });
    const out = NA.detect({ cases: [mk('1'), mk('2')].map(NA.parseCase), checklist: new Map([['2026-SV-090', true]]), folders: null, now: at });
    const dup = out.find((e) => e.kind === 'ref-duplicate');
    assert.ok(dup, 'the duplicate number is listed');
    assert.match(dup.why, /added 10 Dec\)/);
    assert.ok(!/10 Dec 2026/.test(dup.why));
  } finally { NA.io.now = keep; }
  const src = fs.readFileSync(require.resolve('../src/services/needsAttentionService.js'), 'utf8');
  assert.ok(!/getUTCFullYear|getFullYear/.test(src), 'no server-clock year in the list');
});

test('on: a Clients row whose Client ID box did not come back is never given a number (never a write over a value not seen)', async () => {
  const w = world({ clients: [client({ id: 1, name: 'Hidden Box', email: 'h@x.com', hide: [C.clientId] })] });
  try {
    const r = await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.deepEqual(w.seen.ensures, []);
    assert.ok(r.partial.some((p) => /without their Client ID box/.test(p)));
  } finally { w.restore(); }
});

test('on: making a record for a case fails — said in the report, the rest of the run goes on', async () => {
  const w = caseWorld();
  const acc = healer.io.accounts();
  acc.findOrCreate = async () => { throw new Error('Monday 500'); };
  try {
    const r = await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.equal(r.ok, true);
    assert.ok(r.partial.some((p) => /No client record could be made for 2026-VV-014 \(Monday 500\)/.test(p)));
    assert.ok(w.seen.linkCase.some((x) => x.cmItemId === '502'), 'the other cases are still joined');
  } finally { w.restore(); }
});

/* ───────────────────────────── review fixes (2026-11-25) ───────────────────────────── */

test('on: one person on two records (twins) never gets TWO Client IDs — only the lowest item id is given one, none when a twin has one already', async () => {
  const w = world({ clients: [
    client({ id: 12, name: 'Jane Doe', email: 'j@x.com' }), client({ id: 11, name: 'Jane Doe', email: 'j@x.com' }),
    client({ id: 21, name: 'Sam Roe', email: 's@x.com', cid: 'CL-2026-00007' }), client({ id: 22, name: 'Sam Roe', email: 's@x.com' }),
  ] });
  try {
    const r = await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.equal(r.clients.twins, 2);
    assert.deepEqual(w.seen.ensures.map((e) => e.id), ['11'], 'the lower record only; 12 and 22 wait on the twins line');
    assert.equal(r.lines.filter((l) => l.kind === 'client-id-twins').length, 2);
  } finally { w.restore(); }
});

test('on: a case joined to a blocked twin is joined with what that record has — no number made for it', async () => {
  const w = world({
    clients: [client({ id: 11, name: 'Jane Doe', email: 'j@x.com' }), client({ id: 12, name: 'Jane Doe', email: 'j@x.com' })],
    cases: [cmRow({ id: 701, name: 'Jane Doe', ref: '2026-VV-071', email: 'j@x.com' })],
    matches: { 'j@x.com': [{ id: '12', name: 'Jane Doe', clientIdText: '', confidence: 'exact', reasons: ['same email', 'same name'] }] },
  });
  try {
    await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.ok(!w.seen.ensures.some((e) => e.id === '12'), 'the twin that waits is never given a number');
    assert.deepEqual(w.seen.linkCase.map((x) => [x.cmItemId, x.id, x.clientIdText]), [['701', '12', '']]);
  } finally { w.restore(); }
});

test('on: a case copy of ANOTHER record\'s ID (its own record has none) is cleared after a fresh read; never on a record that now has one or could not be read; report only counts it', async () => {
  const mk = () => world({
    clients: [client({ id: 5, name: 'Old Person', email: 'o@x.com', created: Date.parse('2026-01-05T00:00:00Z') })],   // before HEAL_SINCE: no ID given
    cases: [cmRow({ id: 801, name: 'Old Person', ref: '2026-VV-081', account: '5', copy: 'CL-2025-00044' })],
  });
  let w = mk();
  try {
    w.seen.idReads = [];
    healer.io.readIdCell = async (cfg, id) => { w.seen.idReads.push(id); return { state: 'ok', text: '' }; };
    const r = await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.deepEqual(w.seen.idReads, ['5'], 'read once more before clearing');
    assert.deepEqual(w.seen.writes, [{ board: String(CFG.clientMasterBoardId), item: '801', col: CFG.cmLinkColumns.clientId, value: '' }]);
    assert.equal(r.did.strayCleared, 1);
    assert.ok(!r.lines.some((l) => /copy-stray/.test(l.kind)));
  } finally { w.restore(); }
  for (const fresh of [{ state: 'ok', text: 'CL-2026-00090' }, { state: 'unreadable' }, { state: 'unavailable' }]) {
    w = mk();
    try {
      healer.io.readIdCell = async () => fresh;
      await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
      assert.deepEqual(w.seen.writes, [], `nothing cleared when the fresh read is ${fresh.state} ${fresh.text || ''}`);
    } finally { w.restore(); }
  }
  w = mk();
  try {
    healer.io.readIdCell = async () => { throw new Error('report mode must not read it'); };
    const r = await withEnv({ CLIENT_IDS: 'report', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.equal(r.wouldDo.strayClears, 1);
    assert.deepEqual(w.seen.writes, []);
  } finally { w.restore(); }
});

test('while the backfill holds the counter lock the healer writes NOTHING (whatever CLIENT_IDS says) and says so', async () => {
  const w = world({
    clients: [client({ id: 3, name: 'Bob Roy', email: 'bob@x.com' })],
    cases: [cmRow({ id: 301, name: 'Bob Roy', account: '3', copy: '' })],
    counter: { state: 'ok', last: 100, backfill: { by: 'boss@tdotimm.com', at: '2026-11-25T14:00:00Z' } },
  });
  try {
    const r = await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.equal(r.wrote, false);
    assert.deepEqual([w.seen.ensures, w.seen.writes, w.seen.linkCase, w.seen.findOrCreate], [[], [], [], []]);
    assert.ok(r.partial.some((p) => /backfill is running/.test(p)));
    assert.deepEqual(r.wouldDo.mint, ['Bob Roy']);
  } finally { w.restore(); }
});

test('a case with no consultation record: a decorated Client Master name is cleaned and only PROPOSES (a match is listed, never joined); placeholder emails count as blank', async () => {
  const shared = 'agent@x.com';
  const w = world({
    clients: [client({ id: 1, name: 'Amritpal Kaur', email: 'ak@x.com', cid: 'CL-2026-00001' })],
    cases: [
      cmRow({ id: 901, name: 'Amritpal Kaur (2726)', ref: '2026-VV-091', email: 'ak@x.com' }),     // exact on the CLEANED name: listed
      cmRow({ id: 902, name: 'Harjit Singh (1594)', ref: '2026-VV-092', email: 'hs@x.com' }),      // no match: made, under the clean name
      cmRow({ id: 903, name: 'Solo Person', ref: '2026-VV-093', email: 'noemail@gmail.com' }),     // a placeholder by its look: no contact
      ...['Ann A', 'Bob B', 'Cat C', 'Dan D'].map((n, i) => cmRow({ id: 910 + i, name: n, ref: `2026-VV-1${i}0`, email: shared, account: '1', copy: 'CL-2026-00001' })),
      cmRow({ id: 904, name: 'Eve E', ref: '2026-VV-094', email: shared }),                        // shared by >3 names: blank
    ],
    matches: { 'ak@x.com': [{ id: '1', name: 'Amritpal Kaur', clientIdText: 'CL-2026-00001', confidence: 'exact', reasons: ['same email', 'same name'] }] },
  });
  try {
    const r = await withEnv({ CLIENT_IDS: 'on', CLIENT_IDS_HEAL_SINCE: SINCE }, () => quiet(() => healer.tick()));
    assert.ok(!w.seen.linkCase.some((x) => x.cmItemId === '901'), 'never joined on a cleaned name');
    const line = healer.lastReport().problems.find((l) => l.caseRef === '2026-VV-091');
    assert.match(line.why, /looks like the same person: "Amritpal Kaur"/);
    assert.deepEqual(w.seen.findOrCreate.map((q) => q.fullName), ['Harjit Singh'], 'made under the readable name, never "(1594)"');
    assert.ok(!w.seen.findMatches.some((q) => q.email === shared || q.email === 'noemail@gmail.com'), 'a placeholder is never searched with');
    const noContact = r.lines.filter((l) => l.kind === 'client-id-case' && /neither the case nor its consultation record has an email or phone/.test(l.why)).map((l) => l.caseRef).sort();
    assert.deepEqual(noContact, ['2026-VV-093', '2026-VV-094']);
  } finally { w.restore(); }
});

test('Needs attention: "Mark handled" names where its note goes — the case row on Client Master, or the client\'s row on the Clients board (never "the client\'s record")', async () => {
  const w = naWorld([
    LINES[0],
    { kind: 'client-id-case', fingerprint: 'client-id-case|105|no-contact|', cmItemId: '105', caseRef: '', client: 'No Ref', label: 'Client Master', since: iso(NOW - D), why: 'w3', todo: 't3' },
    LINES[1],
  ]);
  try {
    await NA.refresh({ reason: 'test' });
    const by = Object.fromEntries(NA.view({ isAdmin: true }).entries.map((e) => [e.client, e]));
    assert.equal(by['Ann Lee'].noteOn, "the client's row on the Clients board");
    assert.equal(by['No Ref'].noteOn, 'the case row on Client Master');
    assert.equal(by.Gone.noteOn, undefined, 'a line with a case number names the case number, as before');
  } finally { w.restore(); }
  const page = fs.readFileSync(require.resolve('../src/routes/adminDashboard.js'), 'utf8');
  assert.match(page, /var on = li\.getAttribute\('data-na-note-on'\);\s*if \(on\) return on;/);
  assert.match(page, /e\.noteOn \? ' data-na-note-on="' \+ escHtml\(e\.noteOn\) \+ '"' : ''/);
});
