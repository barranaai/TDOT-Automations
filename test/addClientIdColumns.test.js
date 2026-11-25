'use strict';

// scripts/add-client-id-columns.js (2026-11-25): the 3 "Client ID" text
// columns + the CM rename. Dry run by default and it then calls NOTHING;
// --apply creates (or adopts) each column and saves its id at once; a re-run
// does nothing twice. Tested on a COPY of the config with a fake Monday — the copy as it was BEFORE the
// script ran (the three Client ID ids null); the shipped file has the real ids since the run of 2026-11-25.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const script = require('../scripts/add-client-id-columns');
const REAL_CFG = path.join(__dirname, '..', 'src', 'data', 'clientsBoard.json');

const DIRS = [];
test.after(() => { for (const d of DIRS) fs.rmSync(d, { recursive: true, force: true }); });
function tmpCfg(mut, { asShipped = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cid-cols-'));
  DIRS.push(dir);
  const p = path.join(dir, 'clientsBoard.json');
  const cfg = JSON.parse(fs.readFileSync(REAL_CFG, 'utf8'));
  if (!asShipped) { cfg.columns.clientId = null; cfg.cmLinkColumns.clientId = null; cfg.leadLinkColumns.clientId = null; }   // before the run
  if (mut) mut(cfg);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

/** A fake Monday: boards → columns; records every call. */
function fakeMonday(boards, { failCreateOn = null } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    boards,
    async query(q, v) {
      calls.push({ q, v });
      if (/boards\(ids:\$b\)\{ id columns/.test(q)) return { boards: boards[v.b[0]] ? [{ id: v.b[0], columns: boards[v.b[0]].map((c) => ({ ...c })) }] : [] };
      if (/create_column/.test(q)) {
        if (failCreateOn === v.b) throw new Error('Monday 500');
        const id = `text_new${++n}`;
        boards[v.b].push({ id, title: v.t, type: 'text' });
        return { create_column: { id, title: v.t, type: 'text' } };
      }
      if (/change_column_title/.test(q)) {
        const c = boards[v.b].find((x) => x.id === v.c);
        c.title = v.t;
        return { change_column_title: { id: c.id, title: c.title } };
      }
      throw new Error(`unexpected query ${q}`);
    },
  };
}
const startBoards = () => ({
  18425020416: [{ id: 'name', title: 'Name', type: 'name' }],
  18401523447: [{ id: 'text_mm5xmeka', title: 'Client Account Id', type: 'text' }],
  18416845157: [{ id: 'text_mm5x5dab', title: 'Client Account Id', type: 'text' }],
});
const silent = () => {};

test('dry run (the default) calls nothing and writes nothing; it says all four steps', async () => {
  const p = tmpCfg();
  const before = fs.readFileSync(p, 'utf8');
  const api = fakeMonday(startBoards());
  const lines = [];
  const r = await script.run({ cfgPath: p, api, leadBoardId: '18416845157', log: (l) => lines.push(l) });
  assert.equal(r.applied, false);
  assert.equal(api.calls.length, 0);
  assert.equal(fs.readFileSync(p, 'utf8'), before);
  assert.deepEqual(r.steps.map((x) => x.kind), ['create', 'create', 'create', 'rename']);
  assert.ok(lines.some((l) => /DRY RUN/.test(l)));
  assert.ok(lines.some((l) => /Client account \(system\)/.test(l)));
});

test('the real script file is dry-run unless --apply, and only loads Monday for --apply', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'add-client-id-columns.js'), 'utf8');
  assert.match(src, /const apply = process\.argv\.includes\('--apply'\)/);
  assert.match(src, /if \(apply\) \{ require\('dotenv'\)\.config\(\); api = require\('\.\.\/src\/services\/mondayApi'\); \}/);
});

test('--apply: three text columns made and their ids saved; the CM item-id column renamed; nothing else touched', async () => {
  const p = tmpCfg();
  const boards = startBoards();
  const api = fakeMonday(boards);
  const r = await script.run({ apply: true, cfgPath: p, api, leadBoardId: '18416845157', log: silent, pause: async () => {} });
  assert.equal(r.applied, true);
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(cfg.columns.clientId, 'text_new1');
  assert.equal(cfg.cmLinkColumns.clientId, 'text_new2');
  assert.equal(cfg.leadLinkColumns.clientId, 'text_new3');
  assert.equal(cfg.cmLinkColumns.clientAccountId, 'text_mm5xmeka', 'the old column keeps its id');
  assert.equal(boards[18401523447].find((c) => c.id === 'text_mm5xmeka').title, 'Client account (system)');
  assert.equal(boards[18416845157].find((c) => c.id === 'text_mm5x5dab').title, 'Client Account Id', 'the LEAD board column is not renamed');
  const creates = api.calls.filter((c) => /create_column/.test(c.q));
  assert.equal(creates.length, 3);
  for (const c of creates) { assert.match(c.q, /column_type:text/); assert.equal(c.v.t, 'Client ID'); }
  assert.deepEqual(creates.map((c) => c.v.b), ['18425020416', '18401523447', '18416845157']);

  // a re-run does nothing twice
  const again = await script.run({ apply: true, cfgPath: p, api, leadBoardId: '18416845157', log: silent, pause: async () => {} });
  assert.deepEqual(again.done, []);
  assert.equal(api.calls.filter((c) => /create_column|change_column_title/.test(c.q)).length, 4);
});

test('a run stopped half way keeps what it made; the re-run ADOPTS a "Client ID" column already on the board', async () => {
  const p = tmpCfg();
  const boards = startBoards();
  await assert.rejects(script.run({ apply: true, cfgPath: p, api: fakeMonday(boards, { failCreateOn: '18401523447' }), leadBoardId: '18416845157', log: silent, pause: async () => {} }), /Monday 500/);
  let cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(cfg.columns.clientId, 'text_new1', 'saved straight after it was made');
  assert.equal(cfg.cmLinkColumns.clientId, null);
  // someone made the CM column by hand meanwhile (or the config write was lost)
  boards[18401523447].push({ id: 'text_hand', title: 'Client ID', type: 'text' });
  const api = fakeMonday(boards);
  await script.run({ apply: true, cfgPath: p, api, leadBoardId: '18416845157', log: silent, pause: async () => {} });
  cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(cfg.cmLinkColumns.clientId, 'text_hand');
  assert.equal(api.calls.filter((c) => /create_column/.test(c.q)).length, 1, 'only the Lead Board column was still to make');
});

test('it stops rather than guess: a configured id missing from the board, two "Client ID" columns, or one of another type', async () => {
  const p1 = tmpCfg((c) => { c.columns.clientId = 'text_gone'; });
  await assert.rejects(script.run({ apply: true, cfgPath: p1, api: fakeMonday(startBoards()), leadBoardId: '18416845157', log: silent, pause: async () => {} }), /no such column/);

  const b2 = startBoards(); b2[18425020416].push({ id: 'a', title: 'Client ID', type: 'text' }, { id: 'b', title: 'client id', type: 'text' });
  await assert.rejects(script.run({ apply: true, cfgPath: tmpCfg(), api: fakeMonday(b2), leadBoardId: '18416845157', log: silent, pause: async () => {} }), /2 columns are titled/);

  const b3 = startBoards(); b3[18425020416].push({ id: 'n', title: 'Client ID', type: 'numbers' });
  await assert.rejects(script.run({ apply: true, cfgPath: tmpCfg(), api: fakeMonday(b3), leadBoardId: '18416845157', log: silent, pause: async () => {} }), /of type numbers/);
});

test('an already-renamed CM column is left alone', async () => {
  const b = startBoards(); b[18401523447][0].title = 'Client account (system)';
  const api = fakeMonday(b);
  const r = await script.run({ apply: true, cfgPath: tmpCfg(), api, leadBoardId: '18416845157', log: silent, pause: async () => {} });
  assert.ok(!r.done.some((d) => d.startsWith('rename:')));
  assert.equal(api.calls.filter((c) => /change_column_title/.test(c.q)).length, 0);
});

test('the shipped config holds what the real run of 2026-11-25 made, and these tests did NOT change it', () => {
  const cfg = JSON.parse(fs.readFileSync(REAL_CFG, 'utf8'));
  assert.equal(cfg.columns.clientId, 'text_mm9ewm14');
  assert.equal(cfg.cmLinkColumns.clientId, 'text_mm9ep9bw');
  assert.equal(cfg.leadLinkColumns.clientId, 'text_mm9etdaj');
  assert.equal(cfg.cmLinkColumns.clientAccountId, 'text_mm5xmeka', 'the item-id column keeps its id (only its title changed)');
});

test('run again on the shipped config: every column is kept, nothing is made or renamed, the file is left as it is', async () => {
  const p = tmpCfg(null, { asShipped: true });
  const before = fs.readFileSync(p, 'utf8');
  const dry = await script.run({ cfgPath: p, api: fakeMonday(startBoards()), leadBoardId: '18416845157', log: silent });
  assert.deepEqual(dry.steps.filter((x) => x.kind !== 'rename').map((x) => x.kind), ['keep', 'keep', 'keep']);
  const boards = startBoards();
  boards[18425020416].push({ id: 'text_mm9ewm14', title: 'Client ID', type: 'text' });
  boards[18401523447].push({ id: 'text_mm9ep9bw', title: 'Client ID', type: 'text' });
  boards[18401523447][0].title = 'Client account (system)';
  boards[18416845157].push({ id: 'text_mm9etdaj', title: 'Client ID', type: 'text' });
  const api = fakeMonday(boards);
  const r = await script.run({ apply: true, cfgPath: p, api, leadBoardId: '18416845157', log: silent, pause: async () => {} });
  assert.deepEqual(r.done, []);
  assert.equal(api.calls.filter((c) => /create_column|change_column_title/.test(c.q)).length, 0);
  assert.equal(fs.readFileSync(p, 'utf8'), before);
});
