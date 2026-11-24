/**
 * One-off — the Client ID backfill (step 6, 2026-11-25; owner decision 2):
 * every past client gets ONE readable Client ID ("CL-2026-00042"), through a
 * check list that Gauri answers first. Who is one person, the buckets, the year
 * and the order are worked out in src/services/clientIdBackfillPlan.js (pure);
 * this file only reads the boards and writes.
 *
 *   node scripts/backfill-client-ids.js
 *       DRY RUN (the default). Reads the Clients board, Client Master and the Lead
 *       Board (100 a page, a pause between pages) and the counter file (read only).
 *       Writes NOTHING to Monday or OneDrive — only the check list:
 *       backfill-client-ids/client-ids-check-list-<stamp>.xlsx (People · Summary · Left out).
 *       The sheet holds names, emails and phones: an internal staff file — keep it off
 *       shared drives and delete it after the apply. The folder is git-ignored.
 *
 *   node scripts/backfill-client-ids.js --apply --decisions <answered.xlsx> \
 *        --admin <your ADMIN_EMAILS address> --automations-checked --confirm "GIVE <N> CLIENT IDS"
 *       APPLY. Refused unless: CLIENT_IDS is not 'on' (live minting off for the apply),
 *       the Client ID columns are set up, the admin is on ADMIN_EMAILS, the answered
 *       sheet reads cleanly, no "same person" group changed since the sheet was made,
 *       and the typed phrase names the number of new IDs (a wrong phrase prints the
 *       right one and stops before any write). --automations-checked says you looked:
 *       no Monday automation watches the "Client ID" columns, "Client account (system)"
 *       (text_mm5xmeka) or the Client relation (board_relation_mm5xd2bh) — review #16.
 *       Run it in a quiet window.
 *
 * What the apply does, person by person, in the check list's order:
 *   1. the client record: the one the person has, else made through findOrCreate —
 *      which looks for an exact match once more right before making the row (review #3);
 *   2. the Client ID on the Clients row: kept when there is one (NEVER renumbered),
 *      else the next number of a block reserved in one counter write (allocateBlock);
 *      the cell is read first and never written over a value, nor after a read that
 *      did not come back;
 *   3. the copies: each case (linkCase — its record id, the Client ID copy and the
 *      relation) and each consultation record (linkLead). A box that did not come
 *      back in the read is never written; a consultation record that points at
 *      ANOTHER client record is left alone.
 * Every step is saved in a checkpoint (resume = run the same command again) and an
 * apply log (one JSON line per record made and per cell written — the rollback list:
 * archive, never delete). Safe to run again: what is done is skipped.
 *
 * Options: --out <dir> (default ./backfill-client-ids), --placeholder-names <n> (default 3).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const planner = require('../src/services/clientIdBackfillPlan');
const { formatClientId, isClientId, clientIdNumber } = require('../src/utils/clientId');

const OUT_DEFAULT = path.join(__dirname, '..', 'backfill-client-ids');
const PAGE = 100;

const s = (v) => String(v == null ? '' : v).trim();
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');

/** --flag value / --flag → { flag: value|true } */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; } else out[k] = true;
  }
  return out;
}

const confirmPhrase = (n) => `GIVE ${n} CLIENT IDS`;

/* ───────────────────────────── the real I/O (never used by the tests) ───────────────────────────── */

function realIo() {
  require('dotenv').config();
  const mondayApi = require('../src/services/mondayApi');
  const accounts  = require('../src/services/clientAccountService');
  const allocator = require('../src/services/clientIdAllocator');
  const leadBoard = require('../src/data/newLeadsBoard.json');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const colIds = (ids) => JSON.stringify([...new Set(ids.filter(Boolean))]);

  async function pageAll(boardId, fields) {
    const out = []; let cursor = null; let pages = 0;
    do {
      const d = cursor
        ? await mondayApi.query(`query($c:String!){ next_items_page(limit:${PAGE}, cursor:$c){ cursor items{ ${fields} } } }`, { c: cursor })
        : await mondayApi.query(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:${PAGE}){ cursor items{ ${fields} } } } }`, { b: [String(boardId)] });
      const page = cursor ? d && d.next_items_page : (((d && d.boards) || [])[0] || {}).items_page;
      if (!page) throw new Error(`board ${boardId} could not be read`);
      out.push(...(page.items || []));
      cursor = page.cursor || null;
      if (++pages > 500) throw new Error(`board ${boardId}: the listing did not end`);
      await sleep(150);
    } while (cursor);
    return out;
  }
  const write = async (boardId, itemId, cols) => {
    await mondayApi.query(
      'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
      { b: String(boardId), i: String(itemId), c: JSON.stringify(cols) });
  };

  return {
    env: process.env,
    loadBoard: () => accounts.loadBoard(),
    leadColumns: () => ({ ...leadBoard.columns, boardId: leadBoard.boardId }),
    clientIdsMode: () => require('../config/features').clientIdsMode(),
    isAdminEmail: (e) => require('../src/services/caseAccessService').isAdminEmail(e),
    readClients: (cfg) => { const c = cfg.columns; return pageAll(cfg.boardId, `id name created_at column_values(ids:${colIds([c.primaryEmail, c.phone, c.dateOfBirth, c.status, c.mergedInto, c.clientId])}){ id text }`); },
    readCases: (cfg) => { const l = cfg.cmLinkColumns || {}; const C = planner.CM_COL; return pageAll(cfg.clientMasterBoardId, `id name created_at group{ id title } column_values(ids:${colIds([C.caseRef, C.clientEmail, C.clientPhone, C.caseStage, l.clientAccountId, l.clientId])}){ id text }`); },
    readLeads: (cfg) => { const lc = leadBoard.columns; return pageAll(leadBoard.boardId, `id name created_at column_values(ids:${colIds([lc.fullName, lc.email, lc.phone, lc.clientMasterItemId, lc.clientAccountId, lc.retainerSigned, lc.residentialAddress, (cfg.leadLinkColumns || {}).clientId])}){ id text }`); },
    peekCounter: () => allocator.peekCounter(),
    allocateBlock: (k) => allocator.allocateBlock(k),
    findOrCreate: (p) => accounts.findOrCreate(p),
    linkCase: (accountId, o) => accounts.linkCase(accountId, o),
    linkLead: (accountId, leadId, o) => accounts.linkLead(accountId, leadId, o),
    /** The Clients row's Client ID box, read fresh: { state: 'ok', text } | { state: 'not-found'|'merged'|'archived'|'unreadable'|'unavailable' }. */
    async readIdCell(cfg, accountId) {
      let d;
      try {
        d = await mondayApi.query(`query($id:ID!){ items(ids:[$id], limit:1){ id board { id } column_values(ids:${colIds([cfg.columns.clientId, cfg.columns.status])}){ id text } } }`, { id: String(accountId) });
      } catch (err) { return { state: 'unavailable', message: err.message }; }
      const it = d && d.items && d.items[0];
      if (!it || !it.board || String(it.board.id) !== String(cfg.boardId)) return { state: 'not-found' };
      const st = s((it.column_values.find((c) => c.id === cfg.columns.status) || {}).text);
      if (st === 'Merged') return { state: 'merged' };
      if (st === 'Archived') return { state: 'archived' };
      const cell = it.column_values.find((c) => c.id === cfg.columns.clientId);
      return cell ? { state: 'ok', text: s(cell.text) } : { state: 'unreadable' };
    },
    writeIdCell: (cfg, accountId, value) => write(cfg.boardId, accountId, { [cfg.columns.clientId]: String(value) }),
    writeText: (boardId, itemId, col, value) => write(boardId, itemId, { [col]: String(value) }),
    sleep,
    now: () => Date.now(),
    fs,
    xlsx: () => require('xlsx'),
  };
}

/* ───────────────────────────── files ───────────────────────────── */

function writeWorkbook(io, file, plan, { madeAt, counter }) {
  const XLSX = io.xlsx();
  const sheet = (rows, widths) => {
    const ws = {};
    rows.forEach((r, ri) => r.forEach((v, ci) => { ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = typeof v === 'number' ? { t: 'n', v } : { t: 's', v: String(v == null ? '' : v).slice(0, 32000) }; }));
    const cols = Math.max(1, ...rows.map((r) => r.length));
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: cols - 1 } });
    if (widths) ws['!cols'] = widths.map((wch) => ({ wch }));
    return ws;
  };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet([planner.SHEET_HEADERS, ...planner.sheetRows(plan)], [16, 9, 30, 28, 18, 28, 14, 40, 22, 6, 18, 60, 12, 12, 60]), 'People');
  XLSX.utils.book_append_sheet(wb, sheet(planner.summaryRows(plan, { madeAt, counter }), [32, 100]), 'Summary');
  XLSX.utils.book_append_sheet(wb, sheet(planner.leftOutRows(plan), [26, 30, 18, 80]), 'Left out');
  io.fs.mkdirSync(path.dirname(file), { recursive: true });
  io.fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

function readWorkbook(io, file) {
  const XLSX = io.xlsx();
  const wb = XLSX.read(io.fs.readFileSync(file), { type: 'buffer' });
  const ws = wb.Sheets.People;
  if (!ws) throw new Error('the file has no "People" sheet — use the check list the dry run made');
  return planner.readDecisions(XLSX.utils.sheet_to_json(ws, { defval: '', raw: false }));
}

function loadCheckpoint(io, file) {
  try { return JSON.parse(io.fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err && err.code === 'ENOENT') return null; throw new Error(`the checkpoint ${file} cannot be read (${err.message}) — fix or move it before running again`); }
}
function saveCheckpoint(io, file, cp) {
  const tmp = `${file}.tmp`;
  io.fs.writeFileSync(tmp, JSON.stringify(cp, null, 1));
  io.fs.renameSync(tmp, file);
}

/* ───────────────────────────── the run ───────────────────────────── */

/**
 * @param {{ argv?: string[], io?: object, log?: Function }} opts
 * @returns {Promise<{ ok: boolean, mode: 'dry-run'|'apply', reason?: string, message?: string, plan?: object, file?: string, done?: object }>}
 */
async function run({ argv = process.argv.slice(2), io = null, log = console.log } = {}) {
  const args = parseArgs(argv);
  const apply = !!args.apply;
  const x = io || realIo();
  const outDir = s(args.out) && args.out !== true ? path.resolve(String(args.out)) : OUT_DEFAULT;
  const refuse = (reason, message) => { log(`REFUSED — ${message}`); return { ok: false, mode: apply ? 'apply' : 'dry-run', reason, message }; };

  const cfg = x.loadBoard();
  if (!cfg) return refuse('dormant', 'src/data/clientsBoard.json is missing — there is no Clients board here.');
  const configured = !!(s((cfg.columns || {}).clientId) && s((cfg.cmLinkColumns || {}).clientId));
  const placeholderNames = Number.isFinite(Number(args['placeholder-names'])) && args['placeholder-names'] !== true ? Number(args['placeholder-names']) : undefined;

  let decisions = null, order = [], sheetProblems = [];
  if (apply) {
    log('Mode: APPLY (writes to Monday)');
    if (x.clientIdsMode() === 'on') return refuse('live-on', 'CLIENT_IDS is "on". Turn live minting off (CLIENT_IDS=report or off) for the apply, then run again.');
    if (!configured) return refuse('not-configured', 'The Client ID columns are not set up yet (run scripts/add-client-id-columns.js --apply first).');
    const admin = s(args.admin === true ? '' : args.admin);
    if (!admin || !x.isAdminEmail(admin)) return refuse('not-admin', 'Name yourself with --admin <your address>; it must be on ADMIN_EMAILS.');
    if (!s(args.decisions === true ? '' : args.decisions)) return refuse('no-decisions', 'Give the answered check list with --decisions <file.xlsx>.');
    if (!args['automations-checked']) return refuse('automations', 'First check that no Monday automation watches the "Client ID" columns, "Client account (system)" (text_mm5xmeka) or the Client relation (board_relation_mm5xd2bh) on Client Master, the Clients board or the Lead Board. Then add --automations-checked.');
    try { ({ decisions, order, problems: sheetProblems } = readWorkbook(x, path.resolve(String(args.decisions)))); }
    catch (err) { return refuse('bad-decisions', `The answered check list cannot be read: ${err.message}`); }
    if (!order.length) return refuse('bad-decisions', 'The answered check list has no rows.');
    for (const p of sheetProblems) log(`  ! ${p}`);
  } else {
    log('Mode: DRY RUN (reads only — nothing is written to Monday or OneDrive; the check list is saved locally)');
    if (!configured) log('  ! The Client ID columns are not set up yet: every person counts as without an ID, and copies are not read.');
  }

  // ── read everything ──
  log('Reading the Clients board, Client Master and the Lead Board…');
  let rawClients, rawCases, rawLeads;
  try {
    rawClients = await x.readClients(cfg);
    rawCases = await x.readCases(cfg);
    rawLeads = await x.readLeads(cfg);
  } catch (err) { return refuse('read-failed', `A board could not be read (${err.message}) — nothing was done.`); }
  let counter;
  try { counter = await x.peekCounter(); }
  catch (err) { counter = { state: 'unavailable', error: err.message }; }
  if (apply && counter.state !== 'ok' && counter.state !== 'missing') return refuse('counter', `The Client ID counter cannot be used (${counter.state}${counter.error ? `: ${counter.error}` : ''}) — nothing was done.`);
  const counterText = counter.state === 'ok' ? String(counter.last) : counter.state === 'missing' ? 'no counter file yet (it starts from the highest number typed)' : `could not be read (${counter.state}) — the numbers are a guess`;

  const leadCols = x.leadColumns();
  const rows = {
    clients: planner.parseClients(rawClients, cfg),
    cases: planner.parseCases(rawCases, cfg),
    leads: planner.parseLeads(rawLeads, cfg, leadCols),
  };
  const now = x.now();
  const plan = planner.buildPlan(rows, {
    now, counterLast: counter.state === 'ok' ? counter.last : null,
    decisions, order, placeholderNames,
  });
  const c = plan.counts;
  log(`  ${c.clientsRows} client records · ${c.caseRows} Client Master rows (${c.eligibleCases} counted) · ${c.leadRows} consultation records`);
  log(`  ${c.people} people: GREEN ${c.buckets.GREEN} · AMBER ${c.buckets.AMBER} · RED ${c.buckets.RED} · NO-CASE ${c.buckets['NO-CASE']} · EXCLUDED ${c.buckets.EXCLUDED}`);
  log(`  ${c.keepExisting} keep the Client ID they have · ${c.newIds} new (${c.newAccounts} new client records) · counter: ${counterText}`);
  log(`  Year counts: ${Object.entries(plan.yearCounts).map(([y, n]) => `${y}: ${n}`).join(' · ') || '—'}`);
  if (c.placeholderEmails || c.placeholderPhones) log(`  ${c.placeholderEmails} placeholder email(s), ${c.placeholderPhones} placeholder phone(s) treated as blank (see "Left out")`);

  if (!apply) {
    const file = path.join(outDir, `client-ids-check-list-${stamp(now)}.xlsx`);
    writeWorkbook(x, file, plan, { madeAt: new Date(now).toISOString(), counter: counterText });
    log(`Check list → ${file}`);
    log(`(Dry run. Gauri answers the ${c.amberQuestions} AMBER and ${c.buckets['NO-CASE']} NO-CASE rows; then run --apply with the answered file.)`);
    return { ok: true, mode: 'dry-run', plan, file };
  }

  // ── apply: the guards that need the plan ──
  for (const g of plan.ignored) log(`  ! ${g.key}: ${g.why}`);
  if (plan.changed.length) {
    for (const ch of plan.changed) log(`  ✗ ${ch.key}: ${ch.why}`);
    return refuse('changed', `${plan.changed.length} answered group(s) changed since the check list was made. Make a new check list (dry run) and answer it again — nothing was written.`);
  }
  const want = confirmPhrase(c.newIds);
  if (s(args.confirm === true ? '' : args.confirm) !== want) return refuse('confirm', `To go ahead, type exactly: --confirm "${want}" — nothing was written.`);

  x.fs.mkdirSync(outDir, { recursive: true });
  const cpFile = path.join(outDir, 'apply-checkpoint.json');
  const logFile = path.join(outDir, 'apply-log.jsonl');
  const cp = loadCheckpoint(x, cpFile) || { startedAt: new Date(now).toISOString(), admin: s(args.admin), blocks: [], given: {}, accountFor: {}, byAccount: {}, done: {} };
  cp.runs = (cp.runs || 0) + 1;
  const entry = (o) => x.fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date(x.now()).toISOString(), admin: s(args.admin), ...o })}\n`);
  const save = () => saveCheckpoint(x, cpFile, cp);
  entry({ kind: 'start', run: cp.runs, newIds: c.newIds });

  // Numbers: those already reserved in the checkpoint, then one block for the rest.
  const usedNs = new Set(Object.values(cp.given));
  const pool = [];
  for (const b of cp.blocks) for (let n = b.first; n <= b.last; n++) if (!usedNs.has(n)) pool.push(n);
  const needNew = plan.takers.filter((p) => !cp.done[p.anchor] && !cp.given[p.anchor] && !(p.accountId && cp.byAccount[p.accountId])).length;
  if (needNew > pool.length) {
    const r = await x.allocateBlock(needNew - pool.length);
    if (!r || !r.ok) return refuse('block', `No numbers could be reserved (${(r && r.message) || 'the counter refused'}) — nothing was written.`);
    cp.blocks.push({ first: r.first, last: r.last });
    for (let n = r.first; n <= r.last; n++) pool.push(n);
    save();
    entry({ kind: 'reserve', first: r.first, last: r.last });
    log(`  Reserved numbers ${r.first}–${r.last}`);
  }
  const takeNumber = () => pool.shift();

  const done = { records: 0, ids: 0, kept: 0, cases: 0, leads: 0, copies: 0, skipped: [] };
  const lb = leadCols;
  const leadCopyCol = s((cfg.leadLinkColumns || {}).clientId);
  const ordered = [...plan.people].sort((a, b) => (a.gets ? a.order : Infinity) - (b.gets ? b.order : Infinity) || a.minItem - b.minItem);

  for (const p of ordered) {
    if (cp.done[p.anchor]) continue;
    if (p.bucket === 'NO-CASE' && p.give !== 'Y') continue;   // NO-CASE without a Y: nothing at all
    if (p.idBlocked) { done.skipped.push(`${p.name}: its Client ID box is unreadable or holds something else`); continue; }

    // 1. the client record
    let accountId = p.accountId || cp.accountFor[p.anchor] || '';
    if (!accountId) {
      let r;
      try { r = await x.findOrCreate({ email: p.email, phone: p.phone, fullName: p.name, residentialAddress: p.residentialAddress, source: 'backfill' }); }
      catch (err) { done.skipped.push(`${p.name}: no client record could be made (${err.message})`); continue; }
      if (!r || !r.clientId) { done.skipped.push(`${p.name}: no client record could be made`); continue; }
      accountId = String(r.clientId);
      cp.accountFor[p.anchor] = accountId; save();
      entry({ kind: r.created ? 'create-record' : 'found-record', person: p.anchor, board: cfg.boardId, item: accountId, name: p.name });
      if (r.created) done.records++;
      await x.sleep(150);
    }

    // 2. the Client ID on the record — never renumbered, never over a value, never after a failed read
    const cell = await x.readIdCell(cfg, accountId);
    if (cell.state !== 'ok') { done.skipped.push(`${p.name}: the client record is ${cell.state} — left for the next run`); continue; }
    let clientIdText = '';
    if (cell.text) {
      if (!isClientId(cell.text)) { done.skipped.push(`${p.name}: its Client ID box holds "${cell.text.slice(0, 40)}" — never typed over`); continue; }
      clientIdText = cell.text; done.kept++;
    } else {
      let n = cp.given[p.anchor] || cp.byAccount[accountId];
      if (!n) {
        n = takeNumber();
        if (!n) { done.skipped.push(`${p.name}: no number left in the reserved block — run again`); continue; }
        cp.given[p.anchor] = n; cp.byAccount[accountId] = n; save();
      }
      const value = formatClientId(p.year, n);
      try { await x.writeIdCell(cfg, accountId, value); }
      catch (err) { done.skipped.push(`${p.name}: ${value} could not be written (${err.message}) — tried again on the next run`); continue; }
      entry({ kind: 'cell', person: p.anchor, board: cfg.boardId, item: accountId, column: cfg.columns.clientId, from: '', to: value });
      const back = await x.readIdCell(cfg, accountId);
      clientIdText = back.state === 'ok' && isClientId(back.text) ? back.text : value;
      if (clientIdText !== value) entry({ kind: 'note', person: p.anchor, item: accountId, text: `the record holds ${clientIdText}; ${value} is left unused` });
      else done.ids++;
      await x.sleep(150);
    }

    // 3. the copies — cases, then consultation records
    // (the plan gives a person only cases / consultation records whose box is blank or names
    // this person's record — directly or through a Merged one — so a different id here is a link to make)
    for (const cs of p.cases) {
      if (cs.accountId !== accountId) {
        try { await x.linkCase(accountId, { cmItemId: cs.id, clientIdText }); }
        catch (err) { done.skipped.push(`${cs.caseRef || cs.name}: could not be linked (${err.message})`); continue; }
        entry({ kind: 'link-case', person: p.anchor, board: cfg.clientMasterBoardId, item: cs.id, from: cs.accountId || '', to: accountId, clientId: clientIdText, caseRef: cs.caseRef });
        done.cases++;
      } else if (cs.copy !== undefined && cs.copy !== null && cs.copy !== clientIdText) {
        try {
          await x.writeText(cfg.clientMasterBoardId, cs.id, cfg.cmLinkColumns.clientId, clientIdText);
          entry({ kind: 'cell', person: p.anchor, board: cfg.clientMasterBoardId, item: cs.id, column: cfg.cmLinkColumns.clientId, from: cs.copy, to: clientIdText });
          done.copies++;
        } catch (err) { done.skipped.push(`${cs.caseRef || cs.name}: the Client ID copy could not be written (${err.message})`); }
      } else continue;
      await x.sleep(150);
    }
    for (const l of p.leads) {
      if (l.accountId === null) continue;    // its box did not come back: never written
      if (l.accountId !== accountId) {
        try { await x.linkLead(accountId, l.id, { clientIdText }); }
        catch (err) { done.skipped.push(`lead ${l.id}: could not be linked (${err.message})`); continue; }
        entry({ kind: 'link-lead', person: p.anchor, board: lb.boardId, item: l.id, from: l.accountId || '', to: accountId, clientId: clientIdText });
        done.leads++;
      } else if (leadCopyCol && l.copy !== undefined && l.copy !== null && l.copy !== clientIdText) {
        try {
          await x.writeText(lb.boardId, l.id, leadCopyCol, clientIdText);
          entry({ kind: 'cell', person: p.anchor, board: lb.boardId, item: l.id, column: leadCopyCol, from: l.copy, to: clientIdText });
          done.copies++;
        } catch (err) { done.skipped.push(`lead ${l.id}: the Client ID copy could not be written (${err.message})`); }
      } else continue;
      await x.sleep(150);
    }

    cp.done[p.anchor] = { accountId, clientId: clientIdText };
    save();
  }

  const unused = pool.slice();
  if (unused.length) entry({ kind: 'unused-numbers', numbers: unused });
  cp.finishedAt = new Date(x.now()).toISOString();
  save();
  entry({ kind: 'end', ...done, skipped: done.skipped.length });
  log(`Done: ${done.records} client record(s) made · ${done.ids} Client ID(s) given · ${done.kept} kept · ${done.cases} case(s) linked · ${done.leads} consultation record(s) linked · ${done.copies} copy(ies) fixed`);
  if (unused.length) log(`  ${unused.length} reserved number(s) were not needed (left unused: ${unused.slice(0, 10).join(', ')}${unused.length > 10 ? '…' : ''}) — gaps are normal`);
  for (const sk of done.skipped) log(`  ! ${sk}`);
  log(`Apply log → ${logFile} (the rollback list: archive, never delete). Checkpoint → ${cpFile}`);
  log('Next: check /admin/client-ids/audit; then set CLIENT_IDS_HEAL_SINCE to now and CLIENT_IDS=on.');
  return { ok: true, mode: 'apply', plan, done, unused, logFile, checkpoint: cpFile };
}

module.exports = { run, parseArgs, confirmPhrase, writeWorkbook, readWorkbook, OUT_DEFAULT };
if (require.main === module) {
  run().then((r) => { if (!r.ok) process.exitCode = 1; }).catch((err) => { console.error('Fatal:', err && err.message); process.exit(1); });
}
