/**
 * Dashboard Service
 * Fetches all Client Master Board items and aggregates them
 * into stats for the Owner / Manager dashboard.
 */

const mondayApi           = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

// ─── Column IDs — Client Master Board ────────────────────────────────────────
const COLS = {
  caseRef:            'text_mm142s49',
  caseType:           'dropdown_mm0xd1qn',
  caseStage:          'color_mm0x8faa',
  slaRiskBand:        'color_mm0xszmm',
  caseHealthStatus:   'color_mm0xf5ry',
  expiryRiskFlag:     'color_mm1a7vbn',
  escalationRequired: 'color_mm0x7bje',
  qReadiness:         'numeric_mm0x9dea',
  docReadiness:       'numeric_mm0x5g9x',
  docUploaded:        'numeric_mm2njqk1',
  daysElapsed:        'numeric_mm0x58n1',
  clientBlockedStatus:'color_mm1b5gqv',
  chasingStage:       'color_mm1abve4',
  reminderCount:      'numeric_mm1a4e8r',
  caseManager:        'multiple_person_mm0xhmgk',
  opsSupervisor:      'multiple_person_mm0xp0sq',
  lastActivityDate:   'date_mm1amqyr',
  hardDeadline:       'date_mm0x5pqd',
  // ── Additional operational columns ──────────────────────────────────────────
  blockingQCount:     'numeric_mm0xbpn1',
  blockingDocCount:   'numeric_mm0xje6p',
  missingRequired:    'numeric_mm0x6qy4',
  clientDelayLevel:   'color_mm1bq05h',
  expectedReadiness:  'numeric_mm0xrbk1',
  // ── Client Master view tabs (block 3) ───────────────────────────────────────
  // Phase is NEVER written from the app; Hard / Soft / Prep Deadline are SLA
  // outputs and never the client's deadline (the tabs use Actual + Internal).
  phase:              'color_mm3tf1ys',
  deadlineType:       'color_mm6w7cdd',   // "Deadline" = Real · "Imaginary" · empty = not recorded
  actualDeadline:     'date_mm33sj6t',
  promisedDate:       'date_mm3t66pa',    // Internal Deadline (the promise on an Imaginary case)
  caseSupportOfficer: 'multiple_person_mm0xm710',
};

const caseAccess = require('./caseAccessService');
const clientMasterViews = require('./clientMasterViews');
const { statusText } = require('../utils/mondayStatus');
// Fetch our stat columns PLUS every people column (for per-user access control),
// de-duplicated (Case Manager / Ops Supervisor already appear in COLS).
const FETCH_IDS = [...new Set([...Object.values(COLS), ...caseAccess.PEOPLE_COLUMNS])];

// ─── Fetch all items with cursor-based pagination ─────────────────────────────
// The Cases board read is the slow part of the Cases page (~15 s, 100 rows a
// page, one page at a time, on EVERY view). Now: the ids are listed cheaply,
// the rows are fetched in parallel batches by id (always with a limit — the
// 25-row trap), and the RAW rows are cached for a short while and refreshed in
// the background. Only the raw rows are cached, never a viewer's filtered list
// (the access filter runs after, per viewer).
const CASES_CACHE_MS   = 60 * 1000;
const CASES_HARD_MS    = 20 * 60 * 1000;   // older than this, a load waits for a fresh read
const CASES_BATCH      = 100;
const CASES_PARALLEL   = 4;
const FRESH_MIN_AGE_MS = 30 * 1000;      // Refresh re-reads Monday only when the copy is older than this
const OVERRIDE_MAX_MS  = 20 * 60 * 1000; // a patched cell outlives an older in-flight read, never longer than this
// at = when the read LANDED (the 60 s / 20 min / 30 s age rules), startedAt = when it
// BEGAN (the page's "Monday data from": every cell is at least that new; and the
// patch-override rule), meta = group order + label positions.
let _casesCache = { at: 0, startedAt: 0, items: null, gen: 0, meta: null };
let _casesInFlight = null;     // { promise, gen }
let _casesGen = 0, _casesInvalidatedAt = 0;
const _io = { now: () => Date.now() };
// itemId|colId → { itemId, colId, value, text, at }: cells the app itself just wrote (patchCachedColumn).
const _overrides = new Map();

// ─── Board meta: group order + status label positions (for the tab headings) ──
// One small read per fresh read, after the id listing. It has its own try/catch:
// when it fails the rows still load and the view filters still work; the
// headings then fall back to label-index / listed-group order.
const META_STATUS_COLS = [COLS.caseStage, COLS.phase];
function _parseMeta(board) {
  if (!board) return null;
  const groups = (board.groups || []).map((g) => ({ id: String(g.id), title: g.title || '', position: parseFloat(g.position) }))
    .map((g) => ({ ...g, position: Number.isFinite(g.position) ? g.position : null }))
    // Monday returns position as a STRING ("32754.0"): sorted as numbers, never as text
    .sort((a, b) => (a.position == null) - (b.position == null) || (a.position - b.position) || 0);
  const status = {};
  for (const c of board.columns || []) {
    let st = {};
    try { st = JSON.parse(c.settings_str || '{}') || {}; } catch (_) { st = {}; }
    const labels = {};
    for (const [k, v] of Object.entries(st.labels || {})) if (/^\d+$/.test(k)) labels[Number(k)] = String(v);
    const pos = st.labels_positions_v2 || {};
    const idxs = new Set(Object.keys(labels).map(Number));
    for (const k of Object.keys(pos)) if (/^\d+$/.test(k)) idxs.add(Number(k));
    const at = (i) => (Number.isFinite(Number(pos[i])) ? Number(pos[i]) : Infinity);
    const order = [...idxs].sort((a, b) => (at(a) - at(b)) || (a - b));
    status[c.id] = { labels, order };
  }
  const s = status[COLS.caseStage] || { labels: {}, order: [] };
  const p = status[COLS.phase] || { labels: {}, order: [] };
  return { groups, stageOrder: s.order, phaseOrder: p.order, stageLabels: s.labels, phaseLabels: p.labels };
}
async function _fetchMeta() {
  try {
    const data = await mondayApi.query(
      `query($boardId: ID!) { boards(ids: [$boardId]) { groups { id title position } columns(ids: [${META_STATUS_COLS.map((id) => `"${id}"`).join(',')}]) { id settings_str } } }`,
      { boardId: String(clientMasterBoardId) }
    );
    const meta = _parseMeta(data?.boards?.[0]);
    if (!meta) throw new Error('no board in the answer');
    return meta;
  } catch (err) {
    console.warn(`[Dashboard] board meta read failed (headings fall back to label/listed order): ${err.message}`);
    return null;
  }
}

async function _fetchAllItemsFresh() {
  // 1. every item id (name + created_at come with it; no column values yet)
  const ids = [];
  let cursor = null, pages = 0;
  do {
    const data = await mondayApi.query(
      `query($boardId: ID!, $cursor: String) {
         boards(ids: [$boardId]) { items_page(limit: 500, cursor: $cursor) { cursor items { id } } }
       }`,
      { boardId: String(clientMasterBoardId), cursor: cursor || undefined }
    );
    const page = data?.boards?.[0]?.items_page;
    if (!page) break;
    for (const it of page.items || []) ids.push(String(it.id));
    cursor = page.cursor || null;
    if (++pages > 40) throw new Error('the Cases board listing did not end');
  } while (cursor);
  // the meta read starts AFTER the listing (so the listing stays the first call), beside the batches
  const metaP = _fetchMeta();
  // 2. the rows, in parallel batches
  const cols = FETCH_IDS.map((id) => `"${id}"`).join(',');
  const batches = [];
  for (let i = 0; i < ids.length; i += CASES_BATCH) batches.push(ids.slice(i, i + CASES_BATCH));
  const items = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = next++;
      const data = await mondayApi.query(
        `query($ids: [ID!]) { items(ids: $ids, limit: ${CASES_BATCH}) { id name created_at group { id title } column_values(ids: [${cols}]) { id text value } } }`,
        { ids: batches[b] }
      );
      const got = new Map((data?.items || []).map((it) => [String(it.id), it]));
      batches[b].forEach((id, k) => { items[b * CASES_BATCH + k] = got.get(id) || null; });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CASES_PARALLEL, batches.length) }, worker));
  const got = items.filter(Boolean);   // an item deleted between the two steps simply drops out
  const noGroup = got.filter((it) => !(it.group && it.group.id)).length;
  if (noGroup) console.warn(`[Dashboard] ${noGroup} Cases row(s) came back without a group — left out of the Assigning and EE after ITA tabs`);
  return { items: got, meta: await metaP };
}

// Cells the app wrote itself survive a read that began BEFORE the write; a read
// that began after already has them, so its override is dropped. All overrides
// end after OVERRIDE_MAX_MS.
function _applyOverrides(items, readStartedAt) {
  const now = _io.now();
  for (const [k, o] of _overrides) {
    if (now - o.at > OVERRIDE_MAX_MS || o.at < readStartedAt) { _overrides.delete(k); continue; }
    _patchItem(items, o.itemId, o.colId, o);
  }
}
function _patchItem(items, itemId, colId, { value, text }) {
  if (!items) return false;
  const i = items.findIndex((it) => it && String(it.id) === String(itemId));
  if (i < 0) return false;
  const it = items[i];
  const cvs = (it.column_values || []).filter((c) => c.id !== colId);
  cvs.push({ id: colId, value: value == null ? null : value, text: text == null ? '' : text });
  items[i] = { ...it, column_values: cvs };
  return true;
}

/**
 * After the app itself wrote one cell (e.g. Assign Case Support Officer), put the
 * READ-BACK value into the cached rows at once instead of invalidating them (an
 * invalidation would make the next page load by anyone wait for a whole board read).
 * An older read still in flight cannot bring the old value back (see _applyOverrides).
 */
function patchCachedColumn(itemId, colId, { value, text } = {}) {
  const at = _io.now();
  // a cell's value is Monday's JSON STRING (parseItem JSON.parses it); a parsed object is turned back into one
  const v = value == null ? null : (typeof value === 'string' ? value : JSON.stringify(value));
  const o = { itemId: String(itemId), colId: String(colId), value: v, text: text == null ? '' : String(text), at };
  _overrides.set(o.itemId + '|' + o.colId, o);
  return _patchItem(_casesCache.items, o.itemId, o.colId, o);
}

function _refreshCases() {
  if (_casesInFlight) return _casesInFlight.promise;
  const gen = _casesGen;
  const startedAt = _io.now();
  const promise = _fetchAllItemsFresh()
    .then(({ items, meta }) => {
      _applyOverrides(items, startedAt);
      // a failed meta read keeps the last good one (it only orders the headings)
      _casesCache = { at: _io.now(), startedAt, items, gen, meta: meta || _casesCache.meta || null };
      if (_casesInvalidatedAt <= gen) _casesInvalidatedAt = 0;
      return items;
    })
    .finally(() => { if (_casesInFlight && _casesInFlight.promise === promise) _casesInFlight = null; });
  _casesInFlight = { promise, gen };
  return promise;
}
// A read that began after the latest invalidation (an older one in flight is waited out first).
async function _freshCases() {
  while (_casesInFlight && _casesInFlight.gen < _casesGen) await _casesInFlight.promise.catch(() => {});
  return _refreshCases();
}

/** The raw Cases rows: served from the short cache, refreshed in the background once it ages;
 *  after invalidateCases() (a case deleted or created) the next read waits for data read after it. */
async function fetchAllItems({ fresh = false } = {}) {
  if (fresh) _casesGen++;
  const age = _casesCache.items ? _io.now() - _casesCache.at : Infinity;
  const outstanding = _casesInvalidatedAt > 0 && !(_casesCache.items && _casesCache.gen >= _casesInvalidatedAt);
  if (fresh || outstanding || !_casesCache.items || age > CASES_HARD_MS) return _freshCases();
  if (age > CASES_CACHE_MS) _refreshCases().catch((err) => console.warn(`[Dashboard] background refresh failed: ${err.message}`));
  return _casesCache.items;
}
/** After a write the Cases page must show at once (a case deleted or created). */
function invalidateCases() { _casesGen++; _casesInvalidatedAt = _casesGen; }

/**
 * The cached copy for the Client Master page: { items, at, meta }, all from ONE
 * read. `refresh` (the page's Refresh button) asks Monday again only when the
 * copy is older than FRESH_MIN_AGE_MS, and joins a read already in flight; if
 * that re-read fails, the copy in hand is served (its time says how old it is).
 */
async function _casesForPage({ refresh = false } = {}) {
  const age = _casesCache.items ? _io.now() - _casesCache.at : Infinity;
  const outstanding = _casesInvalidatedAt > 0 && !(_casesCache.items && _casesCache.gen >= _casesInvalidatedAt);
  // past the 20-min hard limit the normal path waits for a fresh read (and a failure shows as one)
  if (refresh && !outstanding && _casesCache.items && age > FRESH_MIN_AGE_MS && age <= CASES_HARD_MS) {
    try { await _refreshCases(); } catch (err) { console.warn(`[Dashboard] Refresh read failed, serving the copy from ${new Date(_casesCache.at).toISOString()}: ${err.message}`); }
  } else {
    await fetchAllItems();
  }
  const c = _casesCache;
  return { items: c.items || [], at: c.at, startedAt: c.startedAt, meta: c.meta };
}

/** The board meta from the last read (group order + label positions), or null. */
function getCasesMeta() { return _casesCache.meta; }

function toNum(text) {
  const n = parseFloat((text || '').replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// A date cell → plain YYYY-MM-DD ('' when blank). The text may carry a time.
function dateOnly(text) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(text || '').trim());
  return m ? m[1] : '';
}
// A numbers cell that may be blank: null when blank (NOT 0 — a blank % never flags).
function numOrNull(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  const n = parseFloat(t.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// One people cell → { personIds, teamIds } (strings). Parsed here, not through the RBAC
// column list, so the officer never depends on which columns RBAC reads.
function peopleIds(raw) {
  const personIds = [], teamIds = [];
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = null; }
  for (const pt of (parsed && parsed.personsAndTeams) || []) {
    if (pt == null || pt.id == null) continue;
    const id = String(pt.id);
    const list = pt.kind === 'team' ? teamIds : personIds;
    if (!list.includes(id)) list.push(id);
  }
  return { personIds, teamIds };
}

/** @param {number} [boardIdx]  the row's place in the board read (Monday's board order) */
function parseItem(item, boardIdx) {
  const cvOf = (id) => item.column_values?.find((c) => c.id === id);
  const col = (id) => cvOf(id)?.text?.trim() || '';

  // Assignees (stable Monday ids) from every people column → drives per-user
  // access control. Read from `value` (JSON), not `text` (names).
  const valueByColId = {};
  for (const cv of item.column_values || []) valueByColId[cv.id] = cv.value;
  const assignees = caseAccess.assigneesFromColumnValues(valueByColId);

  const qR       = toNum(col(COLS.qReadiness));
  // Document progress = what the CLIENT has uploaded ("Documents Uploaded %").
  // The "Documents Readiness %" column counts staff-Reviewed docs — a status
  // nobody sets in the current workflow — so keying the dashboard on it froze
  // every case's document metric at 0 even with all documents received, and
  // dragged overallReadiness (and the behind-schedule flag built on it) down
  // with it. Reviewed% is still read and exposed as docReviewed.
  const docR     = toNum(col(COLS.docUploaded));
  const docRev   = toNum(col(COLS.docReadiness));
  const hasR     = qR > 0 || docR > 0;
  const overall  = hasR ? Math.round((qR + docR) / 2) : 0;
  const expected = toNum(col(COLS.expectedReadiness));
  const officerIds = peopleIds(valueByColId[COLS.caseSupportOfficer]);

  return {
    id:                 item.id,
    // Authoritative creation time — the All Cases table defaults to newest
    // first. Do NOT substitute daysElapsed: that is a Monday numeric column
    // that reads 0 when its automation hasn't run, which would sort brand-new
    // and un-stamped cases to the top indistinguishably.
    createdAt:          item.created_at || '',
    clientName:         (item.name || '').trim(),
    caseRef:            col(COLS.caseRef),
    caseType:           col(COLS.caseType)  || 'Unknown',
    caseStage:          col(COLS.caseStage) || 'Unknown',
    slaRisk:            col(COLS.slaRiskBand)       || 'Green',
    health:             col(COLS.caseHealthStatus)  || 'Green',
    escalationRequired: col(COLS.escalationRequired) === 'Yes',
    expiryFlagged:      col(COLS.expiryRiskFlag)    === 'Flagged',
    clientBlocked:      col(COLS.clientBlockedStatus) === 'Yes',
    chasingStage:       col(COLS.chasingStage)  || '',
    reminderCount:      toNum(col(COLS.reminderCount)),
    qReadiness:         qR,
    docReadiness:       docR,       // client upload progress (the staff-meaningful number)
    docReviewed:        docRev,     // staff-review progress (separate pipeline)
    overallReadiness:   overall,
    expectedReadiness:  expected,
    // A case is "behind schedule" when actual is 15+ pts below expected (and expected > 0)
    behindSchedule:     expected > 0 && overall < expected - 15,
    blockingQ:          toNum(col(COLS.blockingQCount)),
    blockingDoc:        toNum(col(COLS.blockingDocCount)),
    missingRequired:    toNum(col(COLS.missingRequired)),
    delayLevel:         col(COLS.clientDelayLevel) || '',
    daysElapsed:        toNum(col(COLS.daysElapsed)),
    manager:            col(COLS.caseManager)    || 'Unassigned',
    supervisor:         col(COLS.opsSupervisor)  || '',
    lastActivity:       col(COLS.lastActivityDate),
    hardDeadline:       col(COLS.hardDeadline),
    assignees,          // { personIds, teamIds } — for per-user access filtering
    // ── Client Master view tabs (block 3; the page reads these from step 2) ──
    boardIdx:           Number.isInteger(boardIdx) ? boardIdx : null,
    groupId:            item.group?.id ? String(item.group.id) : '',
    groupTitle:         item.group?.title || '',
    stageIdx:           clientMasterViews.statusIndex(valueByColId[COLS.caseStage]),    // blank = 5 (Monday)
    phase:              statusText(cvOf(COLS.phase)).trim(),          // empty cell = '' (never the id-5 label)
    phaseIdx:           clientMasterViews.statusIndex(valueByColId[COLS.phase]),
    deadlineType:       statusText(cvOf(COLS.deadlineType)).trim(),
    actualDeadline:     dateOnly(col(COLS.actualDeadline)),
    promisedDate:       dateOnly(col(COLS.promisedDate)),
    caseTypeIds:        clientMasterViews.dropdownIds(valueByColId[COLS.caseType]),
    officer:            col(COLS.caseSupportOfficer),
    officerIds,         // { personIds, teamIds } of Case Support Officer only
    docUploadedPct:     numOrNull(col(COLS.docUploaded)),   // blank = null (docReadiness above reads it as 0)
    views:              [],   // filled just below
  };
}
function parseRow(item, boardIdx) {
  const row = parseItem(item, boardIdx);
  row.views = clientMasterViews.viewsOf(row);
  return row;
}

// ─── Aggregate all cases into dashboard stats ─────────────────────────────────
// @param {Object} [viewer]  when supplied AND not an admin, only cases this
//   viewer is assigned to (any people column) are counted/returned.
// @param {{ fresh?: boolean }} [opts]  fresh = the page's Refresh (re-read only when the copy is > 30 s old)
async function getDashboardStats(viewer, { fresh = false } = {}) {
  const read     = await _casesForPage({ refresh: !!fresh });
  const rawItems = read.items;
  let   cases    = rawItems.map((it, i) => parseRow(it, i));

  if (viewer && !viewer.isAdmin) {
    cases = cases.filter((c) => caseAccess.viewerCanSee(c.assignees, viewer));
  }

  // Summary counters
  const summary = {
    total:             cases.length,
    red:               0,
    orange:            0,
    green:             0,
    clientBlocked:     0,
    escalationOpen:    0,
    expiryFlagged:     0,
    avgReadiness:      0,
    avgQReadiness:     0,
    avgDocReadiness:   0,
    inactiveCount:     0,
    deadlineSoonCount: 0,
    unassignedCount:   0,
    casesWithBlocking: 0,
    behindScheduleCount: 0,
    totalMissingDocs:  0,
  };

  const byStage        = {};
  const byHealth       = {};
  const bySlaRisk      = {};
  const byType         = {};
  const byChasingStage = {};
  const byDelayLevel   = {};
  const readinessByStage = {}; // { stage: { count, actualSum, expectedSum } }

  // byManager tracks extra fields now
  const byManager = {};

  let readinessSum    = 0;
  let qReadinessSum   = 0;
  let docReadinessSum = 0;
  let readinessCaseCount = 0;

  for (const c of cases) {
    const h = (c.health || 'Green');

    // ── Health summary ──────────────────────────────────────────────────────
    if      (h === 'Red')    summary.red++;
    else if (h === 'Orange') summary.orange++;
    else                     summary.green++;
    if (c.clientBlocked)      summary.clientBlocked++;
    if (c.escalationRequired) summary.escalationOpen++;
    if (c.expiryFlagged)      summary.expiryFlagged++;

    // ── Readiness ───────────────────────────────────────────────────────────
    readinessSum    += c.overallReadiness;
    qReadinessSum   += c.qReadiness;
    docReadinessSum += c.docReadiness;
    if (c.qReadiness > 0 || c.docReadiness > 0) readinessCaseCount++;

    // ── Operational ────────────────────────────────────────────────────────
    if (!c.manager || c.manager === 'Unassigned') summary.unassignedCount++;
    if (c.blockingQ > 0 || c.blockingDoc > 0)    summary.casesWithBlocking++;
    if (c.behindSchedule)                         summary.behindScheduleCount++;
    summary.totalMissingDocs += c.missingRequired;

    // ── Inactive ────────────────────────────────────────────────────────────
    const lastAct = c.lastActivity ? new Date(c.lastActivity) : null;
    const daysSinceActivity = (lastAct && !isNaN(lastAct.getTime()))
      ? Math.floor((Date.now() - lastAct.getTime()) / 86400000)
      : 999;
    if (daysSinceActivity >= 14) summary.inactiveCount++;

    // ── Deadline soon ───────────────────────────────────────────────────────
    if (c.hardDeadline) {
      const dl = new Date(c.hardDeadline);
      if (!isNaN(dl.getTime())) {
        const daysUntil = Math.floor((dl.getTime() - Date.now()) / 86400000);
        if (daysUntil >= 0 && daysUntil <= 30) summary.deadlineSoonCount++;
      }
    }

    // ── Breakdowns ──────────────────────────────────────────────────────────
    const stage = c.caseStage || 'Unknown';
    byStage[stage] = (byStage[stage] || 0) + 1;

    byHealth[h] = (byHealth[h] || 0) + 1;

    const risk = c.slaRisk || 'Green';
    bySlaRisk[risk] = (bySlaRisk[risk] || 0) + 1;

    const type = c.caseType || 'Unknown';
    byType[type] = (byType[type] || 0) + 1;

    const cs = c.chasingStage || 'Pending';
    byChasingStage[cs] = (byChasingStage[cs] || 0) + 1;

    const dl = c.delayLevel || 'None';
    byDelayLevel[dl] = (byDelayLevel[dl] || 0) + 1;

    // ── Readiness vs Expected by stage ──────────────────────────────────────
    if (!readinessByStage[stage]) {
      readinessByStage[stage] = { count: 0, actualSum: 0, expectedSum: 0 };
    }
    readinessByStage[stage].count++;
    readinessByStage[stage].actualSum   += c.overallReadiness;
    readinessByStage[stage].expectedSum += c.expectedReadiness;

    // ── By manager ──────────────────────────────────────────────────────────
    const managers = c.manager.split(/,\s*/).map((m) => m.trim()).filter(Boolean);
    for (const mgr of managers) {
      if (mgr === 'Unassigned') continue;
      if (!byManager[mgr]) {
        byManager[mgr] = {
          total: 0, red: 0, orange: 0, green: 0,
          totalReadiness: 0, blockingCount: 0, behindCount: 0,
        };
      }
      byManager[mgr].total++;
      byManager[mgr][h.toLowerCase()] = (byManager[mgr][h.toLowerCase()] || 0) + 1;
      byManager[mgr].totalReadiness  += c.overallReadiness;
      if (c.blockingQ > 0 || c.blockingDoc > 0) byManager[mgr].blockingCount++;
      if (c.behindSchedule)                      byManager[mgr].behindCount++;
    }
  }

  // ── Finalise per-manager averages ──────────────────────────────────────────
  for (const mgr of Object.keys(byManager)) {
    const m = byManager[mgr];
    m.avgReadiness = m.total > 0 ? Math.round(m.totalReadiness / m.total) : 0;
    const greenPct = m.total > 0 ? m.green / m.total : 0;
    m.score = Math.round(greenPct * 60 + (m.avgReadiness / 100) * 40);
    delete m.totalReadiness;
  }

  // ── Finalise readiness by stage ────────────────────────────────────────────
  for (const s of Object.keys(readinessByStage)) {
    const r = readinessByStage[s];
    r.avgActual   = r.count > 0 ? Math.round(r.actualSum   / r.count) : 0;
    r.avgExpected = r.count > 0 ? Math.round(r.expectedSum / r.count) : 0;
    delete r.actualSum;
    delete r.expectedSum;
  }

  // ── Finalise summary averages ──────────────────────────────────────────────
  summary.avgReadiness    = cases.length > 0 ? Math.round(readinessSum    / cases.length) : 0;
  summary.avgQReadiness   = cases.length > 0 ? Math.round(qReadinessSum   / cases.length) : 0;
  summary.avgDocReadiness = cases.length > 0 ? Math.round(docReadinessSum / cases.length) : 0;

  return {
    summary,
    byStage,
    byHealth,
    bySlaRisk,
    byType,
    byManager,
    byChasingStage,
    byDelayLevel,
    readinessByStage,
    cases,
    meta:        read.meta || null,                                 // group order + label positions for the tab headings
    // when Monday was read — the read's START (every cell is at least this new), not when this answer was made
    dataAt:      read.startedAt ? new Date(read.startedAt).toISOString() : null,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  fetchAllItems, invalidateCases, patchCachedColumn, getCasesMeta,
  _casesIo: { refresh: _refreshCases, io: _io, overrides: _overrides, parseMeta: _parseMeta, FRESH_MIN_AGE_MS, OVERRIDE_MAX_MS, CASES_HARD_MS },
  getDashboardStats, parseItem: parseRow, peopleIds, COLS };
