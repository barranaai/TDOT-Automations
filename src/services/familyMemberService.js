'use strict';

/**
 * One family member added to a case (2026-10-07) — by staff on the case page
 * or through the questionnaire's add-member route — lands in all three places
 * that must agree, or the case is wrong in a way nobody sees:
 *   1. the questionnaire manifest — the member's own section on the client's
 *      existing link (written FIRST: a failure here leaves nothing to clean up;
 *      an absent manifest is created from the board rows plus this one);
 *   2. a Family Members board row — the composition the checklist seeds from;
 *   3. the document checklist — re-seeded WITHOUT pruning (rows are only ever
 *      added), fed the composition this call already holds (board rows + the
 *      new member — Monday's search can lag a create by seconds, so the
 *      re-seed never re-searches), and only when the case's checklist exists
 *      (Checklist Template Applied = Yes); otherwise the rows come with the
 *      normal seed at Document Collection.
 * Case 2026-CEC-EE-070 arrived without a lead, so no family rows were ever
 * created and the questionnaire + checklist covered the main applicant only.
 *
 * Keys follow the manifest's convention (spouse, child-1, child-2, parent-1 …)
 * and are chosen across BOTH the board's rows and the manifest's members. A
 * member the client already has on the manifest but not on the board is
 * ADOPTED (its row and documents are completed) rather than refused. Adds on
 * one case run strictly one after another (staff and client paths share the
 * queue), and rows this process created in the last minutes count as on the
 * board whatever a lagging search says.
 */

const PORTAL_TO_BOARD = {
  'Spouse / Common-Law Partner': 'Spouse',
  'Dependent Child':             'Dependent Child',
  'Parent':                      'Parent',
  'Sibling':                     'Sibling',
  'Sponsor':                     'Sponsor',
  'Worker Spouse':               'Worker Spouse',
};
const BOARD_TO_PORTAL = Object.fromEntries(Object.entries(PORTAL_TO_BOARD).map(([p, b]) => [b, p]));
// compositionAdapter's role names ↔ the board's Member Type labels
const ROLE_TO_BOARD = { Spouse: 'Spouse', DependentChild: 'Dependent Child', Parent: 'Parent', Sibling: 'Sibling', Sponsor: 'Sponsor', WorkerSpouse: 'Worker Spouse' };
const BOARD_TO_ROLE = Object.fromEntries(Object.entries(ROLE_TO_BOARD).map(([r, b]) => [b, r]));
const KEY_BASE  = { 'Spouse': 'spouse', 'Dependent Child': 'child', 'Parent': 'parent', 'Sibling': 'sibling', 'Sponsor': 'sponsor', 'Worker Spouse': 'worker-spouse' };
const SINGLETON = new Set(['Spouse', 'Worker Spouse', 'Sponsor']);
const SHORT     = { 'Spouse': 'Spouse', 'Dependent Child': 'Child', 'Parent': 'Parent', 'Sibling': 'Sibling', 'Sponsor': 'Sponsor', 'Worker Spouse': 'Worker spouse' };
const NAME_MAX  = 80;
const RECENT_ROWS_MS = 10 * 60 * 1000;   // rows this process wrote count as on the board for this long
const TRANSIENT_MSG = 'The questionnaire member list could not be read just now — please try again in a few minutes.';
// A Case Sub Type that says the family comes along (the same test the Summary tab uses).
const SAYS_ACCOMPANYING = (sub) => /\baccompanying\b/i.test(String(sub || '')) && !/\bnon[\s-]?accompanying\b/i.test(String(sub || ''));

const badRequest = (msg) => Object.assign(new Error(msg), { badRequest: true });
const transient  = (msg) => Object.assign(new Error(msg), { transient: true });

/** PURE: the key for a new member of this board type, free on both the board and the manifest; null when a singleton is already there. */
function nextMemberKey(boardType, { boardRows = [], manifestMembers = [] } = {}) {
  const base = KEY_BASE[boardType];
  if (!base) return null;
  const taken = new Set([...boardRows.map((r) => r.memberKey), ...manifestMembers.map((m) => m.key)].map((k) => String(k || '').trim()).filter(Boolean));
  const sameType = boardRows.filter((r) => r.boardType === boardType).length;
  if (SINGLETON.has(boardType)) return (taken.has(base) || sameType > 0) ? null : base;
  for (let i = 1; i < 100; i++) { const k = `${base}-${i}`; if (!taken.has(k)) return k; }
  return null;
}

/**
 * PURE: a manifest member of this type that has NO board row yet (the client
 * added it, or an earlier add lost its row) — to adopt. Counted, not only
 * keyed: a board row WITHOUT a key of that type is taken to be one of the
 * manifest's members, so it is never "adopted" a second time.
 */
function adoptableMember(boardType, { boardRows = [], manifestMembers = [] } = {}) {
  const portal = BOARD_TO_PORTAL[boardType];
  const onBoard = new Set(boardRows.map((r) => String(r.memberKey || '').trim()).filter(Boolean));
  const unkeyed = boardRows.filter((r) => r.boardType === boardType && !String(r.memberKey || '').trim()).length;
  const candidates = manifestMembers.filter((m) => m && m.type === portal && m.key && m.key !== 'primary' && !onBoard.has(m.key));
  return candidates[unkeyed] || null;
}

/** PURE: the row's name when none was given — a placeholder the manifest never shows as a label. */
function placeholderName(boardType, key, source) {
  const n = /-(\d+)$/.exec(key || '');
  const who = source === 'client' ? 'added by client' : 'added by staff';
  return `${SHORT[boardType] || boardType}${n ? ' ' + n[1] : ''} (${who})`;
}

/** A name as it may be stored: no invisibles or control characters, one line, bounded. */
function cleanName(v) {
  let s = String(v == null ? '' : v);
  try { s = require('./leadService').stripInvisibles(s); } catch (_) { /* keep the local strip */ }
  // eslint-disable-next-line no-control-regex
  return s.replace(/[​-‍﻿‪-‮⁦-⁩]/g, '').replace(/[\x00-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

// ─── I/O seam (tests stub this) ──────────────────────────────────────────────
const io = {
  /** { rows: [{ boardType, memberKey, name }], members: the adapter's members (for the composition) } */
  boardRows: async (caseRef) => {
    const { members } = await require('./compositionAdapter').readForCase(caseRef);
    const list = members || [];
    return { rows: list.map((m) => ({ boardType: ROLE_TO_BOARD[m.role] || m.role, memberKey: m.memberKey || '', name: m.name || '' })), members: list };
  },
  manifest: ({ clientName, caseRef }) => require('./htmlQuestionnaireService').readMembersManifest({ clientName, caseRef }),
  addManifestMember: (args) => require('./htmlQuestionnaireService').addMember(args),
  createManifest: (args) => require('./htmlQuestionnaireService').createManifestFromBoard(args),
  createRow: (args) => require('./familyCompositionService').createFamilyRow(args),
  /** { stage, payment, checklistApplied } of the case — "Yes" = a checklist exists to re-seed. */
  caseState: async (cmItemId) => {
    const d = await require('./mondayApi').query(`query($ids:[ID!]){ items(ids:$ids, limit:1){ column_values(ids:["color_mm0x8faa","color_mm0x9fnn","color_mm0xs7kp"]){ id text } } }`, { ids: [String(cmItemId)] });
    const item = d && d.items && d.items[0];
    if (!item) throw new Error('case not returned');
    const cv = Object.fromEntries((item.column_values || []).map((c) => [c.id, (c.text || '').trim()]));
    return { stage: cv.color_mm0x8faa || '', payment: cv.color_mm0x9fnn || '', checklistApplied: cv.color_mm0xs7kp || '' };
  },
  /** The re-seed, fed the composition this call holds — never a fresh board search. */
  reseed: (caseRef, composition) => require('./checklistService').reseedByCaseRef(caseRef, { prune: false, composition }),
  postNote: async (itemId, body) => {
    await require('./mondayApi').query('mutation($i: ID!, $b: String!){ create_update(item_id: $i, body: $b){ id } }', { i: String(itemId), b: body });
  },
  now: () => Date.now(),
};

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const _inFlight   = new Map();   // caseRef → the tail of the queue of adds on that case
const _recentRows = new Map();   // caseRef → [{ boardType, memberKey, name, at }] rows this process wrote

function recentRows(key) {
  const now = io.now();
  const list = (_recentRows.get(key) || []).filter((r) => now - r.at < RECENT_ROWS_MS);
  if (list.length) _recentRows.set(key, list); else _recentRows.delete(key);
  return list;
}

/**
 * @param {object} p
 * @param {string} p.caseRef
 * @param {string} p.cmItemId       Client Master item id
 * @param {string} p.clientName
 * @param {string} p.boardType      'Spouse' | 'Dependent Child' | 'Parent' | 'Sibling' | 'Sponsor' | 'Worker Spouse'
 * @param {string} [p.name]         the member's name (optional — a placeholder is used)
 * @param {'staff'|'client'} p.source
 * @param {{name:string}|null} [p.actor]   who clicked (staff)
 * @param {'await'|'background'} [p.reseedMode='await']
 * @param {string} [p.caseSubType]  for the "this sub type has no documents for a …" hint
 */
async function addFamilyMember(p) {
  const key = String(p && p.caseRef || '').trim().toUpperCase();
  if (!key) throw badRequest('caseRef and cmItemId are required.');
  // A queue, not a gate: every add on this case runs strictly after the one before it.
  const prev = _inFlight.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => addOne(p));
  _inFlight.set(key, run);
  try { return await run; } finally { if (_inFlight.get(key) === run) _inFlight.delete(key); }
}

async function addOne({ caseRef, cmItemId, clientName, boardType, name = '', source = 'staff', actor = null, reseedMode = 'await', caseSubType = '' }) {
  if (!PORTAL_TO_BOARD[BOARD_TO_PORTAL[boardType]]) throw badRequest(`Unknown member type "${boardType}".`);
  if (!caseRef || !cmItemId) throw badRequest('caseRef and cmItemId are required.');
  const portalType = BOARD_TO_PORTAL[boardType];
  const who = source === 'client' ? 'the client, on the questionnaire' : `${(actor && actor.name) || 'staff'} (staff)`;
  const label = cleanName(name);
  const memKey = String(caseRef).trim().toUpperCase();

  // What exists now — on the board (plus rows this process wrote minutes ago,
  // which a lagging search may not show yet) and in the manifest (null = none).
  const read = await io.boardRows(caseRef);
  const boardRows = read.rows.slice();
  const adapterMembers = read.members.slice();
  for (const r of recentRows(memKey)) {
    if (boardRows.some((b) => b.memberKey && b.memberKey === r.memberKey)) continue;
    boardRows.push({ boardType: r.boardType, memberKey: r.memberKey, name: r.name });
    adapterMembers.push({ role: BOARD_TO_ROLE[r.boardType], name: r.name, memberKey: r.memberKey, flags: {} });
  }
  let manifest = null;
  try { manifest = await io.manifest({ clientName, caseRef }); }
  catch (_) { throw transient(TRANSIENT_MSG); }

  // The member the client already has on the questionnaire but not on the
  // board: complete it instead of refusing (the EE-070 drift, healed).
  const adopt = adoptableMember(boardType, { boardRows, manifestMembers: manifest || [] });
  if (SINGLETON.has(boardType) && boardRows.some((r) => r.boardType === boardType)) {
    throw badRequest(`A ${SHORT[boardType].toLowerCase()} is already on this case.`);
  }
  const memberKey = adopt ? adopt.key : nextMemberKey(boardType, { boardRows, manifestMembers: manifest || [] });
  if (!memberKey) throw badRequest(`A ${SHORT[boardType].toLowerCase()} is already on this case.`);
  const rowName = label || (adopt && !/\((from intake|added by (?:staff|client))\)/i.test(adopt.label || '') && cleanName(adopt.label)) || placeholderName(boardType, memberKey, source);
  const newMember = { role: BOARD_TO_ROLE[boardType], name: rowName, memberKey, flags: {} };

  // 1. the questionnaire section FIRST (a failure here leaves nothing behind)
  let manifestState;
  try {
    if (adopt) manifestState = 'adopted';
    else if (manifest) { await io.addManifestMember({ clientName, caseRef, memberType: portalType, label: label || undefined, key: memberKey }); manifestState = 'added'; }
    else {
      // no manifest yet: build it from the rows we hold plus this member — never
      // from a later board read that may lag Monday's search
      await io.createManifest({ clientName, caseRef, boardMembers: [...adapterMembers, newMember] });
      manifestState = 'created';
    }
  } catch (err) {
    if (err.badRequest || /already been added|already used|Invalid member key/.test(err.message || '')) throw badRequest(err.message);
    throw transient(TRANSIENT_MSG);
  }

  // 2. the board row (the composition the checklist seeds from)
  let rowId;
  try { rowId = await io.createRow({ caseRef, cmItemId, row: { name: rowName, memberType: boardType, memberKey } }); }
  catch (err) {
    await io.postNote(cmItemId, `⚠ <b>Family member half-added</b> — ${esc(boardType)} "${esc(rowName)}" by ${esc(who)}: the questionnaire section exists, but the Family Members row could not be created (${esc(err.message)}). Press ➕ Add family member on the case page again — it completes the row and the document rows.`).catch(() => {});
    const e = transient(`The questionnaire section was added, but the Family Members row could not be created (${err.message}). Press Add family member again in a minute — it completes the row.`);
    e.member = { key: memberKey, type: portalType, label: rowName }; e.manifestAdded = true;
    throw e;
  }
  _recentRows.set(memKey, [...recentRows(memKey), { boardType, memberKey, name: rowName, at: io.now() }]);

  // 3. the checklist — only when one exists (Checklist Template Applied = Yes);
  //    fed the composition we hold, so the new member is in the plan whatever
  //    Monday's search says in the next seconds; rows are only ever added.
  const composition = require('./compositionAdapter').withMember({ members: adapterMembers }, newMember);
  let state = null;
  try { state = await io.caseState(cmItemId); } catch (err) { console.warn(`[Family] case state unreadable for ${caseRef}: ${err.message}`); }
  const result = { ok: true, key: memberKey, boardType, portalType, rowId, rowName, manifest: manifestState, stage: (state && state.stage) || '', reseed: null, hint: '' };
  const finish = async () => {
    if (!state) result.reseed = { unknown: true };
    else if (state.checklistApplied !== 'Yes') result.reseed = { deferred: true };
    else {
      try { const r = await io.reseed(caseRef, composition); result.reseed = { created: r.created, skipped: r.skipped, failed: r.failed, pruned: r.pruned || 0 }; }
      catch (err) { result.reseed = { error: err.message }; }
      if (result.reseed.created === 0 && caseSubType && !SAYS_ACCOMPANYING(caseSubType)) {
        result.hint = `The Case Sub Type "${caseSubType}" has no documents for a ${SHORT[boardType].toLowerCase()} — change it to the accompanying variant and press Re-seed Checklist.`;
      }
    }
    await io.postNote(cmItemId, note({ caseRef, boardType, rowName, who, manifestState, reseed: result.reseed, stage: result.stage, hint: result.hint })).catch((err) => console.warn(`[Family] note failed for ${caseRef}: ${err.message}`));
    console.log(`[Family] ${caseRef}: ${boardType} "${rowName}" (${memberKey}) added by ${source}; manifest ${manifestState}; reseed ${JSON.stringify(result.reseed)}`);
  };
  if (reseedMode === 'background') {
    finish().catch((err) => console.warn(`[Family] background finish failed for ${caseRef}: ${err.message}`));
    return { ...result, reseed: { pending: true } };   // a snapshot: the caller never sees the job finish under it
  }
  await finish();
  return result;
}

function note({ caseRef, boardType, rowName, who, manifestState, reseed, stage, hint }) {
  const q = manifestState === 'added'   ? 'questionnaire section added on the client\'s existing link'
          : manifestState === 'adopted' ? 'the questionnaire section the client already had is now matched by a row'
          : manifestState === 'created' ? 'questionnaire member list created with this member'
          : 'questionnaire section added';
  const d = !reseed ? 'checklist not re-seeded'
          : reseed.unknown ? 'the checklist state could not be read — press Re-seed Checklist on the case if its checklist exists'
          : reseed.deferred ? `no document rows yet — the checklist has not been created (the case is at "${esc(stage || 'Not Started')}"); they come with the checklist at Document Collection`
          : reseed.error ? `checklist re-seed FAILED (${esc(reseed.error)}) — press Re-seed Checklist on the case`
          : `checklist re-seeded (rows only added, never removed): ${reseed.created} new document row(s), ${reseed.skipped} existing left as they were${reseed.failed ? `, ${reseed.failed} failed — press Re-seed Checklist` : ''}`;
  return `👪 <b>Family member added</b> — ${esc(boardType)} "${esc(rowName)}" — by ${esc(who)}, ${esc(require('../utils/torontoTime').torontoTime(Date.now()))} (Toronto). Family Members row created; ${q}; ${d}.${hint ? ' ' + esc(hint) : ''} (${esc(caseRef)})`;
}

module.exports = { addFamilyMember, nextMemberKey, adoptableMember, placeholderName, cleanName, PORTAL_TO_BOARD, BOARD_TO_PORTAL, ROLE_TO_BOARD, SINGLETON, NAME_MAX, RECENT_ROWS_MS, io, _inFlight, _recentRows };
