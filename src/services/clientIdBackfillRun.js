'use strict';

/**
 * The Client ID backfill APPLY — one implementation for both ways of running it
 * (2026-11-25): scripts/backfill-client-ids.js on a laptop (files in a local folder)
 * and the admin page /admin/client-ids/backfill on the server (files on OneDrive under
 * "TDOT System/client-id-backfill/", because Render's disk is wiped on every deploy).
 * Who is one person, the buckets, the year and the order are worked out in
 * clientIdBackfillPlan.js (pure); this file reads the boards and writes.
 *
 * The steps, in order (each one can refuse — nothing is written before the lock):
 *   guards()        CLIENT_IDS is not 'on' here, the Client ID columns are set up, a named
 *                   admin (ADMIN_EMAILS), an answered sheet, the automations check;
 *   readAndPlan()   read the three boards and the counter (read only), build the plan;
 *   applyPlan()     unclear answers / changed groups refused; the checkpoint read; a run
 *                   still going elsewhere refused; a backfill lock someone else holds refused;
 *                   the typed phrase checked; then the LOCK, the writes, the unlock.
 *
 * What the apply does, person by person, in the check list's order:
 *   1. the client record: the one the person has, else made through findOrCreate;
 *   2. the Client ID on the Clients row: kept when there is one (NEVER renumbered), else
 *      the next number of a block reserved in one counter write; never over a value, never
 *      after a read that did not come back;
 *   3. the copies: each case (linkCase) and each consultation record (linkLead).
 * Every step is saved in the checkpoint (resume = start again: what is done is skipped) and
 * an apply log (the rollback list: one JSON line per record made and per cell written).
 *
 * The STORE keeps the checkpoint and the log: fsStore (a local folder, the script) or the
 * OneDrive store of clientIdBackfillJobs.js (the page). Both are async; a store write that
 * finds a NEWER checkpoint than its own (err.conflict — another copy of the server took the
 * run over) stops this run at once and leaves the lock to the other one.
 *
 * Logging: `log` receives the staff-facing lines (names included — the script prints them on
 * the admin's own screen; the page keeps them for the admin page only, never the server log).
 */

const path = require('path');
const planner = require('./clientIdBackfillPlan');
const { formatClientId, isClientId } = require('../utils/clientId');
const { torontoTime } = require('../utils/torontoTime');

const PAGE = 100;
const PAUSE_MS = 150;
const STALE_MS = 5 * 60 * 1000;     // a 'running' checkpoint not saved for this long = the run stopped (a restart)
const BACKOFF_TRIES = 3;            // Monday complexity / rate errors: tries per write, then left for the resume
const BACKOFF_MAX_MS = 60 * 1000;

const s = (v) => String(v == null ? '' : v).trim();
const confirmPhrase = (n) => `GIVE ${n} CLIENT IDS`;
const isoOf = (ms) => new Date(ms).toISOString();

/* ───────────────────────────── the answered sheet ───────────────────────────── */

/** The answered check list (a Buffer) → planner.readDecisions(...). Throws when it is not the check list. */
function readSheetBuffer(XLSX, buffer) {
  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer' }); }
  catch (err) { throw new Error('the file is not an Excel workbook'); }
  const ws = wb.Sheets.People;
  if (!ws) throw new Error('the file has no "People" sheet — use the check list the dry run made');
  return planner.readDecisions(XLSX.utils.sheet_to_json(ws, { defval: '', raw: false }));
}

/* ───────────────────────────── Monday backoff ───────────────────────────── */

/** A Monday answer that says "too much, wait": complexity budget, rate limit. */
function isBudgetError(err) {
  return /complexity|budget|rate.?limit|too many requests|429/i.test(String((err && err.message) || ''));
}
/** How long Monday asks us to wait ("…reset in 23 seconds"), capped. */
function waitFor(err) {
  const m = /(\d+)\s*sec/i.exec(String((err && err.message) || ''));
  const ms = m ? (Number(m[1]) + 1) * 1000 : 20 * 1000;
  return Math.min(ms, BACKOFF_MAX_MS);
}
/** Run fn; on a budget error wait and try again, at most `tries` times in all — then throw (left for the resume). */
async function withBackoff(fn, { sleep, tries = BACKOFF_TRIES } = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (err) {
      if (!isBudgetError(err) || i >= tries) throw err;
      await sleep(waitFor(err));
    }
  }
}

/* ───────────────────────────── the real Monday I/O (never used by the tests) ───────────────────────────── */

/**
 * The boards, the counter and the record helpers, read and written for real. The script adds
 * its lock calls, fs and xlsx; the page adds the same lock calls. Every write goes through the
 * complexity backoff.
 */
function mondayIo({ pauseMs = PAUSE_MS } = {}) {
  const mondayApi = require('./mondayApi');
  const accounts  = require('./clientAccountService');
  const allocator = require('./clientIdAllocator');
  const leadBoard = require('../data/newLeadsBoard.json');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const colIds = (ids) => JSON.stringify([...new Set(ids.filter(Boolean))]);
  const backoff = (fn) => withBackoff(fn, { sleep });

  async function pageAll(boardId, fields) {
    const out = []; let cursor = null; let pages = 0;
    do {
      const c0 = cursor;
      const d = await backoff(() => (c0
        ? mondayApi.query(`query($c:String!){ next_items_page(limit:${PAGE}, cursor:$c){ cursor items{ ${fields} } } }`, { c: c0 })
        : mondayApi.query(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:${PAGE}){ cursor items{ ${fields} } } } }`, { b: [String(boardId)] })));
      const page = cursor ? d && d.next_items_page : (((d && d.boards) || [])[0] || {}).items_page;
      if (!page) throw new Error(`board ${boardId} could not be read`);
      out.push(...(page.items || []));
      cursor = page.cursor || null;
      if (++pages > 500) throw new Error(`board ${boardId}: the listing did not end`);
      await sleep(pauseMs);
    } while (cursor);
    return out;
  }
  const write = (boardId, itemId, cols) => backoff(() => mondayApi.query(
    'mutation($b:ID!,$i:ID!,$c:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c){ id } }',
    { b: String(boardId), i: String(itemId), c: JSON.stringify(cols) }));

  return {
    env: process.env,
    loadBoard: () => accounts.loadBoard(),
    leadColumns: () => ({ ...leadBoard.columns, boardId: leadBoard.boardId }),
    clientIdsMode: () => require('../../config/features').clientIdsMode(),
    isAdminEmail: (e) => require('./caseAccessService').isAdminEmail(e),
    readClients: (cfg) => { const c = cfg.columns; return pageAll(cfg.boardId, `id name created_at column_values(ids:${colIds([c.primaryEmail, c.phone, c.dateOfBirth, c.status, c.mergedInto, c.clientId])}){ id text }`); },
    readCases: (cfg) => { const l = cfg.cmLinkColumns || {}; const C = planner.CM_COL; return pageAll(cfg.clientMasterBoardId, `id name created_at group{ id title } column_values(ids:${colIds([C.caseRef, C.clientEmail, C.clientPhone, C.caseStage, l.clientAccountId, l.clientId])}){ id text }`); },
    readLeads: (cfg) => { const lc = leadBoard.columns; return pageAll(leadBoard.boardId, `id name created_at column_values(ids:${colIds([lc.fullName, lc.email, lc.phone, lc.clientMasterItemId, lc.clientAccountId, lc.retainerSigned, lc.residentialAddress, (cfg.leadLinkColumns || {}).clientId])}){ id text }`); },
    peekCounter: () => allocator.peekCounter(),
    allocateBlock: (k) => allocator.allocateBlock(k),
    findOrCreate: (p) => accounts.findOrCreate(p),
    linkCase: (accountId, o) => backoff(() => accounts.linkCase(accountId, o)),
    linkLead: (accountId, leadId, o) => backoff(() => accounts.linkLead(accountId, leadId, o)),
    /** The Clients row's Client ID box, read fresh: { state: 'ok', text } | { state: 'not-found'|'merged'|'archived'|'unreadable'|'unavailable' }. */
    async readIdCell(cfg, accountId) {
      let d;
      try {
        d = await backoff(() => mondayApi.query(`query($id:ID!){ items(ids:[$id], limit:1){ id board { id } column_values(ids:${colIds([cfg.columns.clientId, cfg.columns.status])}){ id text } } }`, { id: String(accountId) }));
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
  };
}

/* ───────────────────────────── the local-folder store (the script) ───────────────────────────── */

function fsStore(fs, outDir) {
  const cpFile = path.join(outDir, 'apply-checkpoint.json');
  const logFile = path.join(outDir, 'apply-log.jsonl');
  return {
    where: { checkpoint: cpFile, log: logFile },
    async load() {
      try { return JSON.parse(fs.readFileSync(cpFile, 'utf8')); }
      catch (err) { if (err && err.code === 'ENOENT') return null; throw new Error(`the checkpoint ${cpFile} cannot be read (${err.message}) — fix or move it before running again`); }
    },
    async prepare() { fs.mkdirSync(outDir, { recursive: true }); },
    async save(cp) {
      const tmp = `${cpFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cp, null, 1));
      fs.renameSync(tmp, cpFile);
    },
    async log(entry) { fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`); },
  };
}

/* ───────────────────────────── the words (the script names its flags; the page its boxes) ───────────────────────────── */

const WORDS = {
  script: {
    liveOn: 'CLIENT_IDS is "on" on this machine. Turn live minting off on the live server AND here (CLIENT_IDS=report or off) for the apply, then run again. (The apply also locks the counter, so the live server gives no number while it runs.)',
    notAdmin: 'Name yourself with --admin <your address>; it must be on ADMIN_EMAILS.',
    noDecisions: 'Give the answered check list with --decisions <file.xlsx>.',
    automations: 'First check that no Monday automation watches the "Client ID" columns, "Client account (system)" (text_mm5xmeka) or the Client relation (board_relation_mm5xd2bh) on Client Master, the Clients board or the Lead Board. Then add --automations-checked.',
    confirm: (want) => `To go ahead, type exactly: --confirm "${want}" — nothing was written.`,
    unlockHint: 'node scripts/backfill-client-ids.js --unlock --admin <you>',
  },
  page: {
    liveOn: 'CLIENT_IDS is "on" on the server. Set it to report (or off) on Render, wait for the restart, then start again. Nothing was written.',
    notAdmin: 'Only a named admin (signed in with Monday, on ADMIN_EMAILS) can run the backfill.',
    noDecisions: 'Upload the answered check list first.',
    automations: 'First check that no Monday automation watches the "Client ID" columns, "Client account (system)" or the Client relation — then tick the box.',
    confirm: (want) => `To go ahead, type exactly: ${want} — nothing was written.`,
    unlockHint: 'the Unlock button on this page',
  },
};

const refusal = (log, reason, message, extra = {}) => { log(`REFUSED — ${message}`); return { ok: false, mode: 'apply', reason, message, ...extra }; };

/* ───────────────────────────── step 1: the guards that need no read ───────────────────────────── */

/**
 * @returns {null | { ok: false, reason, message }}  null = go on
 */
function guards(x, cfg, { admin, decisionsGiven, automationsChecked, via = 'script', log = () => {} } = {}) {
  const W = WORDS[via] || WORDS.script;
  if (x.clientIdsMode() === 'on') return refusal(log, 'live-on', W.liveOn);
  if (!configured(cfg)) return refusal(log, 'not-configured', 'The Client ID columns are not set up yet (run scripts/add-client-id-columns.js --apply first).');
  if (!s(admin) || !x.isAdminEmail(s(admin))) return refusal(log, 'not-admin', W.notAdmin);
  if (!decisionsGiven) return refusal(log, 'no-decisions', W.noDecisions);
  if (!automationsChecked) return refusal(log, 'automations', W.automations);
  return null;
}
function configured(cfg) { return !!(cfg && s((cfg.columns || {}).clientId) && s((cfg.cmLinkColumns || {}).clientId)); }

/* ───────────────────────────── step 2: read the boards, build the plan ───────────────────────────── */

/**
 * @returns {Promise<{ ok: true, plan, counter, counterText, leadCols, now } | { ok: false, reason, message }>}
 */
async function readAndPlan(x, cfg, { decisions = null, order = [], proposed = null, placeholderNames, apply = true, log = () => {}, onPhase = () => {} } = {}) {
  onPhase('reading');
  log('Reading the Clients board, Client Master and the Lead Board…');
  let rawClients, rawCases, rawLeads;
  try {
    rawClients = await x.readClients(cfg);
    rawCases = await x.readCases(cfg);
    rawLeads = await x.readLeads(cfg);
  } catch (err) { return refusal(log, 'read-failed', `A board could not be read (${err.message}) — nothing was done.`); }
  let counter;
  try { counter = await x.peekCounter(); }
  catch (err) { counter = { state: 'unavailable', error: err.message }; }
  if (apply && counter.state !== 'ok' && counter.state !== 'missing') return refusal(log, 'counter', `The Client ID counter cannot be used (${counter.state}${counter.error ? `: ${counter.error}` : ''}) — nothing was done.`);
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
    decisions, order, proposed, placeholderNames,
  });
  const c = plan.counts;
  log(`  ${c.clientsRows} client records · ${c.caseRows} Client Master rows (${c.eligibleCases} counted) · ${c.leadRows} consultation records`);
  log(`  ${c.people} people: GREEN ${c.buckets.GREEN} · AMBER ${c.buckets.AMBER} · RED ${c.buckets.RED} · NO-CASE ${c.buckets['NO-CASE']} · EXCLUDED ${c.buckets.EXCLUDED}`);
  log(`  ${c.keepExisting} keep the Client ID they have · ${c.newIds} new (${c.newAccounts} new client records) · counter: ${counterText}`);
  log(`  Year counts: ${Object.entries(plan.yearCounts).map(([y, n]) => `${y}: ${n}`).join(' · ') || '—'}`);
  if (c.placeholderEmails || c.placeholderPhones) log(`  ${c.placeholderEmails} placeholder email(s), ${c.placeholderPhones} placeholder phone(s) treated as blank (see "Left out")`);
  return { ok: true, plan, counter, counterText, leadCols, now };
}

/* ───────────────────────────── step 3: the apply ───────────────────────────── */

/** Is the backfill lock in the counter this checkpoint's own (set by this run before a stop)? */
function lockIsOurs(cp, lock) {
  return !!(cp && cp.lock && lock && s(cp.lock.at) && s(cp.lock.at) === s(lock.at));
}

/**
 * The guards that need the plan, then the lock, the writes and the unlock.
 * @param {object} o
 * @param {object} o.x          the I/O (mondayIo + lockCounter/unlockCounter, or the tests' fakes)
 * @param {object} o.store      fsStore(...) or the OneDrive store
 * @param {object} o.cfg        src/data/clientsBoard.json
 * @param {object} o.ready      what readAndPlan answered
 * @param {string} o.admin      the named admin's address
 * @param {string} o.typed      the phrase typed
 * @param {object} [o.extra]    more fields for a NEW checkpoint (the page: the sheet's file name)
 * @param {boolean} [o.heartbeat]  refuse while another run saved its checkpoint less than STALE_MS ago (the page)
 * @param {Function} [o.onProgress]  called with a snapshot after every person
 */
async function applyPlan({ x, store, cfg, ready, admin, typed, extra = {}, via = 'script', heartbeat = false, pauseMs = PAUSE_MS,
  log = () => {}, onProgress = () => {}, onPhase = () => {} }) {
  const W = WORDS[via] || WORDS.script;
  const { plan, leadCols, counter } = ready;
  const now = ready.now;
  const c = plan.counts;
  admin = s(admin);

  // An answer that is not Y, N or blank ("Yes, same", "Y.", "same") is never read as blank:
  // a blank means two people, and two permanent IDs (ux review #3). Correct it and run again.
  if (plan.ignored.length) {
    for (const g of plan.ignored) log(`  ✗ ${g.key}: ${g.why}`);
    return refusal(log, 'unclear-answers', `${plan.ignored.length} answer(s) are not Y or N: ${plan.ignored.slice(0, 10).map((g) => `${g.key}${g.name ? ` (${g.name})` : ''}`).join(', ')}${plan.ignored.length > 10 ? '…' : ''}. Write Y, N or leave it blank, then run again — nothing was written.`,
      { unclear: plan.ignored.map((g) => ({ key: g.key, name: g.name || '', why: g.why })) });
  }
  if (plan.changed.length) {
    for (const ch of plan.changed) log(`  ✗ ${ch.key}: ${ch.why}`);
    return refusal(log, 'changed', `${plan.changed.length} answered group(s) changed since the check list was made. Make a new check list (dry run) and answer it again — nothing was written.`,
      { changed: plan.changed.map((g) => ({ key: g.key, why: g.why })) });
  }
  let prior;
  try { prior = await store.load(); }
  catch (err) { return refusal(log, 'checkpoint', err.message); }
  if (heartbeat && prior && prior.status === 'running' && Number.isFinite(Date.parse(prior.heartbeatAt)) && now - Date.parse(prior.heartbeatAt) < STALE_MS) {
    return refusal(log, 'run-elsewhere', `A run saved its progress ${Math.max(0, Math.round((now - Date.parse(prior.heartbeatAt)) / 1000))} seconds ago — it may still be going on another copy of the server (during a deploy). Wait 5 minutes, then look again — nothing was written.`);
  }
  if (counter && counter.backfill && !lockIsOurs(prior, counter.backfill)) {
    return refusal(log, 'lock-held', `The Client ID counter is locked by another backfill (${counter.backfill.by || 'someone'}, since ${counter.backfill.at || 'a while'}). If you are sure no backfill is running, take the lock out with ${W.unlockHint} — nothing was written.`);
  }
  const want = confirmPhrase(c.newIds);
  typed = s(typed);
  // Resume (review 2026-11-25): the phrase the apply was started with still counts — as long as the
  // people numbered so far plus those still to number are no more than it said.
  const newAnchors = plan.takers.filter((p) => !(prior && prior.given && prior.given[p.anchor])).length;
  const resumeOk = !!(prior && Number.isSafeInteger(prior.confirmedNewIds) && typed === confirmPhrase(prior.confirmedNewIds)
    && Object.keys(prior.given || {}).length + newAnchors <= prior.confirmedNewIds);
  if (typed !== want && !resumeOk) return refusal(log, 'confirm', W.confirm(want), { phrase: want });

  await store.prepare();
  const cp = prior || { startedAt: isoOf(now), admin, confirmedNewIds: c.newIds, blocks: [], given: {}, accountFor: {}, byAccount: {}, done: {}, ...extra };
  if (!Number.isSafeInteger(cp.confirmedNewIds)) cp.confirmedNewIds = c.newIds;
  cp.runs = (cp.runs || 0) + 1;

  // The lock: from here on no live server gives a number (whatever its CLIENT_IDS) until it is cleared.
  const lk = await x.lockCounter(admin);
  if (!lk || !lk.ok) return refusal(log, 'lock', `The Client ID counter could not be locked for the apply (${(lk && lk.message) || 'no answer'}) — nothing was written.`);
  const held = lk.lock || (counter && counter.backfill) || null;
  if (lk.already && held && !lockIsOurs(prior, held)) {
    // Someone locked it between our read and now — theirs, never taken out by us.
    return refusal(log, 'lock-held', `The Client ID counter was locked meanwhile by another backfill (${held.by || 'someone'}) — nothing was written.`);
  }
  log(lk.already ? '  The counter was locked already (a resumed apply) — kept.' : '  The counter is locked: the live app gives no Client ID until the apply ends.');
  cp.lock = held ? { by: s(held.by), at: s(held.at) } : { by: admin, at: isoOf(x.now()) };
  cp.status = 'running';
  cp.runStartedAt = isoOf(x.now());
  delete cp.error; delete cp.stoppedAt;

  let lost = false;     // a newer checkpoint was found: another copy runs it now — its lock, its run
  let result;
  try {
    result = await applyAll();
    if (!result.ok) { cp.status = 'stopped'; cp.stoppedAt = isoOf(x.now()); cp.error = result.message; await save(); }
    return result;
  } catch (err) {
    if (err && err.conflict) lost = true;
    else {
      cp.status = 'stopped'; cp.stoppedAt = isoOf(x.now()); cp.error = String((err && err.message) || err).slice(0, 300);
      try { await save(); } catch (e2) { if (e2 && e2.conflict) lost = true; }
    }
    throw err;
  } finally {
    if (!lost) {
      const un = await Promise.resolve().then(() => x.unlockCounter()).catch((err) => ({ ok: false, message: err.message }));
      if (un && un.ok) log('  The counter lock is cleared.');
      else log(`  ! The counter lock could not be cleared (${(un && un.message) || 'no answer'}) — use ${W.unlockHint}`);
      if (result) result.unlocked = !!(un && un.ok);
    } else log('  ! A newer checkpoint was found (another copy of the server runs the backfill now) — this run stopped and left the lock to it.');
  }

  async function save() { cp.heartbeatAt = isoOf(x.now()); await store.save(cp); }

  async function applyAll() {
    const entry = (o) => store.log({ at: isoOf(x.now()), admin, ...o });
    await save();
    await entry({ kind: 'start', run: cp.runs, newIds: c.newIds });
    onPhase('writing');

    // Numbers: those already reserved in the checkpoint, then one block for the rest.
    const usedNs = new Set(Object.values(cp.given));
    const pool = [];
    for (const b of cp.blocks) for (let n = b.first; n <= b.last; n++) if (!usedNs.has(n)) pool.push(n);
    const needNew = plan.takers.filter((p) => !cp.done[p.anchor] && !cp.given[p.anchor] && !(p.accountId && cp.byAccount[p.accountId])).length;
    if (needNew > pool.length) {
      const r = await x.allocateBlock(needNew - pool.length);
      if (!r || !r.ok) return refusal(log, 'block', `No numbers could be reserved (${(r && r.message) || 'the counter refused'}) — nothing was written.`);
      cp.blocks.push({ first: r.first, last: r.last });
      for (let n = r.first; n <= r.last; n++) pool.push(n);
      await save();
      await entry({ kind: 'reserve', first: r.first, last: r.last });
      log(`  Reserved numbers ${r.first}–${r.last}`);
    }
    const takeNumber = () => pool.shift();

    const done = { records: 0, ids: 0, kept: 0, cases: 0, leads: 0, copies: 0, skipped: [], skippedItems: [] };
    const skip = (p, why, key) => { done.skippedItems.push({ key: key || p.anchor, name: p.name || '', why }); done.skipped.push(`${p.name}: ${why}`); };
    const skipOther = (key, label, why) => { done.skippedItems.push({ key, name: label, why }); done.skipped.push(`${label}: ${why}`); };
    const lb = leadCols;
    const leadCopyCol = s((cfg.leadLinkColumns || {}).clientId);
    const ordered = [...plan.people].sort((a, b) => (a.gets ? a.order : Infinity) - (b.gets ? b.order : Infinity) || a.minItem - b.minItem);
    // Every client record the check list already gives to a person (or keeps out): findOrCreate
    // may find one of them by an exact match on a CLEANED name — the sheet kept those people
    // apart, so it is never used for another person (review 2026-11-25).
    const claimed = new Map();
    for (const q of plan.people) if (q.accountId) claimed.set(String(q.accountId), q.anchor);
    for (const x2 of plan.excluded) if (x2.kind !== 'case' && x2.id) claimed.set(String(x2.id), 'left-out');
    for (const m of plan.merged || []) if (m.id) claimed.set(String(m.id), 'merged');
    for (const [anchor, id] of Object.entries(cp.accountFor)) if (!claimed.has(String(id))) claimed.set(String(id), anchor);
    const nameOfAnchor = (a) => { const q = plan.people.find((pp) => pp.anchor === a); return q ? q.name : 'another client'; };

    const todo = ordered.filter((p) => !cp.done[p.anchor] && !(p.bucket === 'NO-CASE' && p.give !== 'Y'));
    const progress = { total: todo.length, processed: 0, alreadyDone: Object.keys(cp.done).length };
    const tell = () => { try { onProgress({ ...progress, records: done.records, ids: done.ids, kept: done.kept, cases: done.cases, leads: done.leads, copies: done.copies, skipped: done.skippedItems.slice() }); } catch (_) { /* the page's copy only */ } };
    tell();

    for (const p of todo) {
      progress.processed++;
      try { await person(p); } finally { tell(); }
    }

    async function person(p) {
      if (p.idBlocked) { skip(p, 'its Client ID box is unreadable or holds something else'); return; }

      // 1. the client record
      let accountId = p.accountId || cp.accountFor[p.anchor] || '';
      if (!accountId) {
        let r;
        try { r = await x.findOrCreate({ email: p.email, phone: p.phone, fullName: p.name, residentialAddress: p.residentialAddress, source: 'backfill' }); }
        catch (err) { skip(p, `no client record could be made (${err.message})`); return; }
        if (!r || !r.clientId) { skip(p, 'no client record could be made'); return; }
        const owner = claimed.get(String(r.clientId));
        if (!r.created && owner && owner !== p.anchor) {
          const whose = owner === 'left-out' ? 'a record the check list leaves out' : owner === 'merged' ? 'a Merged record' : `${nameOfAnchor(owner)}'s client record`;
          skip(p, `matches ${whose} exactly, but the check list says they are different people — left for the admin (no record, no Client ID)`);
          await entry({ kind: 'skip-claimed', person: p.anchor, item: String(r.clientId), owner });
          return;
        }
        accountId = String(r.clientId);
        claimed.set(accountId, p.anchor);
        cp.accountFor[p.anchor] = accountId; await save();
        await entry({ kind: r.created ? 'create-record' : 'found-record', person: p.anchor, board: cfg.boardId, item: accountId, name: p.name });
        if (r.created) done.records++;
        await x.sleep(pauseMs);
      }

      // 2. the Client ID on the record — never renumbered, never over a value, never after a failed read
      const cell = await x.readIdCell(cfg, accountId);
      if (cell.state !== 'ok') { skip(p, `the client record is ${cell.state} — left for the next run`); return; }
      let clientIdText = '';
      if (cell.text) {
        if (!isClientId(cell.text)) { skip(p, `its Client ID box holds "${cell.text.slice(0, 40)}" — never typed over`); return; }
        clientIdText = cell.text; done.kept++;
      } else {
        let n = cp.given[p.anchor] || cp.byAccount[accountId];
        if (!n) {
          n = takeNumber();
          if (!n) { skip(p, 'no number left in the reserved block — run again'); return; }
          cp.given[p.anchor] = n; cp.byAccount[accountId] = n; await save();
        }
        const value = formatClientId(p.year, n);
        try { await x.writeIdCell(cfg, accountId, value); }
        catch (err) { skip(p, `${value} could not be written (${err.message}) — tried again on the next run`); return; }
        await entry({ kind: 'cell', person: p.anchor, board: cfg.boardId, item: accountId, column: cfg.columns.clientId, from: '', to: value });
        const back = await x.readIdCell(cfg, accountId);
        clientIdText = back.state === 'ok' && isClientId(back.text) ? back.text : value;
        if (clientIdText !== value) await entry({ kind: 'note', person: p.anchor, item: accountId, text: `the record holds ${clientIdText}; ${value} is left unused` });
        else done.ids++;
        await x.sleep(pauseMs);
      }

      // 3. the copies — cases, then consultation records
      // (the plan gives a person only cases / consultation records whose box is blank or names
      // this person's record — directly or through a Merged one — so a different id here is a link to make)
      for (const cs of p.cases) {
        if (cs.accountId !== accountId) {
          try { await x.linkCase(accountId, { cmItemId: cs.id, clientIdText }); }
          catch (err) { skipOther(`C${cs.id}`, cs.caseRef || cs.name, `could not be linked (${err.message})`); continue; }
          await entry({ kind: 'link-case', person: p.anchor, board: cfg.clientMasterBoardId, item: cs.id, from: cs.accountId || '', to: accountId, clientId: clientIdText, caseRef: cs.caseRef });
          done.cases++;
        } else if (cs.copy !== undefined && cs.copy !== null && cs.copy !== clientIdText) {
          try {
            await x.writeText(cfg.clientMasterBoardId, cs.id, cfg.cmLinkColumns.clientId, clientIdText);
            await entry({ kind: 'cell', person: p.anchor, board: cfg.clientMasterBoardId, item: cs.id, column: cfg.cmLinkColumns.clientId, from: cs.copy, to: clientIdText });
            done.copies++;
          } catch (err) { skipOther(`C${cs.id}`, cs.caseRef || cs.name, `the Client ID copy could not be written (${err.message})`); }
        } else continue;
        await x.sleep(pauseMs);
      }
      for (const l of p.leads) {
        if (l.accountId === null) continue;    // its box did not come back: never written
        if (l.accountId !== accountId) {
          try { await x.linkLead(accountId, l.id, { clientIdText }); }
          catch (err) { skipOther(`L${l.id}`, `lead ${l.id}`, `could not be linked (${err.message})`); continue; }
          await entry({ kind: 'link-lead', person: p.anchor, board: lb.boardId, item: l.id, from: l.accountId || '', to: accountId, clientId: clientIdText });
          done.leads++;
        } else if (leadCopyCol && l.copy !== undefined && l.copy !== null && l.copy !== clientIdText) {
          try {
            await x.writeText(lb.boardId, l.id, leadCopyCol, clientIdText);
            await entry({ kind: 'cell', person: p.anchor, board: lb.boardId, item: l.id, column: leadCopyCol, from: l.copy, to: clientIdText });
            done.copies++;
          } catch (err) { skipOther(`L${l.id}`, `lead ${l.id}`, `the Client ID copy could not be written (${err.message})`); }
        } else continue;
        await x.sleep(pauseMs);
      }

      cp.done[p.anchor] = { accountId, clientId: clientIdText };
      await save();
    }

    const unused = pool.slice();
    if (unused.length) await entry({ kind: 'unused-numbers', numbers: unused });
    cp.finishedAt = isoOf(x.now());
    cp.status = 'finished';
    cp.summary = { records: done.records, ids: done.ids, kept: done.kept, cases: done.cases, leads: done.leads, copies: done.copies, skipped: done.skippedItems.length, unused: unused.length };
    cp.skippedItems = done.skippedItems.slice(0, 500);
    await save();
    await entry({ kind: 'end', records: done.records, ids: done.ids, kept: done.kept, cases: done.cases, leads: done.leads, copies: done.copies, skipped: done.skippedItems.length });
    log(`Done: ${done.records} client record(s) made · ${done.ids} Client ID(s) given · ${done.kept} kept · ${done.cases} case(s) linked · ${done.leads} consultation record(s) linked · ${done.copies} copy(ies) fixed`);
    if (unused.length) log(`  ${unused.length} reserved number(s) were not needed (left unused: ${unused.slice(0, 10).join(', ')}${unused.length > 10 ? '…' : ''}) — gaps are normal`);
    for (const sk of done.skipped) log(`  ! ${sk}`);
    log(`Apply log → ${store.where.log} (the rollback list: archive, never delete). Checkpoint → ${store.where.checkpoint}`);
    log(`Next: check /admin/client-ids/audit; then set CLIENT_IDS_HEAL_SINCE to ${cp.startedAt} (when this apply STARTED — people who came while it ran are then given theirs by the hourly check) and CLIENT_IDS=on.`);
    return { ok: true, mode: 'apply', plan, done, unused, logFile: store.where.log, checkpoint: store.where.checkpoint, startedAt: cp.startedAt, healSince: healSinceText(cp.startedAt) };
  }
}

/** CLIENT_IDS_HEAL_SINCE = when the apply STARTED: the exact ISO value, and the same moment in Toronto. */
function healSinceText(startedAt) {
  const ms = Date.parse(startedAt);
  if (!Number.isFinite(ms)) return null;
  return { iso: isoOf(ms), toronto: `${torontoTime(ms)} (Toronto)` };
}

/** All three steps — the page's background run (the script calls the steps itself, around its dry run). */
async function runApply({ x, store, cfg, sheet, admin, automationsChecked, typed, extra, via = 'page', heartbeat = true, pauseMs, placeholderNames, log = () => {}, onProgress, onPhase }) {
  if (!cfg) return refusal(log, 'dormant', 'src/data/clientsBoard.json is missing — there is no Clients board here.');
  const g = guards(x, cfg, { admin, decisionsGiven: !!(sheet && sheet.order && sheet.order.length), automationsChecked, via, log });
  if (g) return g;
  const ready = await readAndPlan(x, cfg, { decisions: sheet.decisions, order: sheet.order, proposed: sheet.proposed, placeholderNames, apply: true, log, onPhase });
  if (!ready.ok) return ready;
  return applyPlan({ x, store, cfg, ready, admin, typed, extra, via, heartbeat, pauseMs, log, onProgress, onPhase });
}

module.exports = {
  guards, readAndPlan, applyPlan, runApply, readSheetBuffer, confirmPhrase, healSinceText, lockIsOurs, configured,
  mondayIo, fsStore, withBackoff, isBudgetError, waitFor,
  WORDS, STALE_MS, PAUSE_MS, BACKOFF_TRIES,
};
