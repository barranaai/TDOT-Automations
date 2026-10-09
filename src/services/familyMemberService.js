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
 *      (Checklist Template Applied = Yes, or document rows exist) AND was built from the case's
 *      current schema: every document key starts with the Case Type + Sub
 *      Type it was built for, so a checklist made the old Template-board way,
 *      or under an earlier Case Type or Sub Type (with rows still open), would
 *      get a second full checklist laid beside it — then nothing is seeded and
 *      the note says what staff do instead. Otherwise the rows come with the
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
const CARRY_TYPES = new Set(['Spouse', 'Dependent Child']);   // the single-member form embeds sections for these
const SHORT     = { 'Spouse': 'Spouse', 'Dependent Child': 'Child', 'Parent': 'Parent', 'Sibling': 'Sibling', 'Sponsor': 'Sponsor', 'Worker Spouse': 'Worker spouse' };
const NAME_MAX  = 80;
const RECENT_ROWS_MS = 10 * 60 * 1000;   // rows this process wrote count as on the board for this long
const TRANSIENT_MSG = 'The questionnaire member list could not be read just now — please try again in a few minutes.';
// A Case Sub Type that says the family comes along (the same test the Summary tab uses).
const { isPlaceholderName } = require('../utils/memberNames');
const SAYS_ACCOMPANYING = (sub) => /\baccompanying\b/i.test(String(sub || '')) && !/\bnon[\s-]?accompanying\b/i.test(String(sub || ''));

const badRequest = (msg) => Object.assign(new Error(msg), { badRequest: true });
const transient  = (msg) => Object.assign(new Error(msg), { transient: true });

/** PURE: the key for a new member of this board type, free on both the board and the manifest; null when a singleton is already there. */
function nextMemberKey(boardType, { boardRows = [], manifestMembers = [] } = {}) {
  const base = KEY_BASE[boardType];
  if (!base) return null;
  const taken = new Set([...boardRows.map((r) => r.memberKey), ...manifestMembers.map((m) => m.key)].map((k) => String(k || '').trim()).filter(Boolean));
  const sameType = boardRows.filter((r) => r.boardType === boardType);
  if (SINGLETON.has(boardType)) return (taken.has(base) || sameType.length > 0) ? null : base;
  // The numbers the checklist seeder gives this type's board members are theirs
  // — a row with NO key holds one too — so the new member never takes one (it
  // would inherit that member's document rows on the re-seed).
  for (const n of seedIndices(sameType.map((r) => r.memberKey))) taken.add(`${base}-${n}`);
  for (let i = 1; i < 100; i++) { const k = `${base}-${i}`; if (!taken.has(k)) return k; }
  return null;
}

/** PURE: the document-row number seedPlanner gives each member of one role, in order — the key's own number when free, else the lowest unused. */
function seedIndices(keys) {
  const used = new Set();
  const preferred = keys.map((k) => { const m = String(k || '').match(/(\d+)$/); const n = m ? Number(m[1]) : null; if (n != null && !used.has(n)) { used.add(n); return n; } return null; });
  let free = 1;
  return preferred.map((p) => { if (p != null) return p; while (used.has(free)) free++; used.add(free); return free; });
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

/**
 * PURE: the case's schema checklist rows split into the case's CURRENT variant
 * (Case Type + Sub Type) and STALE ones built for another. A row belongs to the
 * registered variant whose code prefix is the LONGEST it starts with — one Sub
 * Type's name can be the start of another's ("Visitor Record" / "Visitor
 * Record Restoration"). A row no registered variant claims is stale.
 */
function splitByVariant(schemaRows, { caseType, subType }, registered = require('./caseSchemaService').listRegistered()) {
  const { slugUpper } = require('./seedPlanner')._internal;
  const prefixOf = (ct, st) => `${slugUpper(ct)}-${slugUpper(st)}-`;
  const variants = registered.map((s) => ({ caseType: s.caseType, subType: s.subType || '', prefix: prefixOf(s.caseType, s.subType) }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const mine = prefixOf(caseType, subType);
  // a variant since retired or renamed: the row's own Sub Type column, when the
  // code starts with the case's Case Type + that Sub Type
  const ownerOf = (r) => variants.find((v) => String(r.code || '').startsWith(v.prefix))
    || (String(r.code || '').startsWith(prefixOf(caseType, r.subType)) ? { caseType, subType: r.subType || '', prefix: prefixOf(caseType, r.subType) } : null);
  const rows = (schemaRows || []).map((r) => ({ ...r, owner: ownerOf(r) }));
  const stale = rows.filter((r) => !r.owner || r.owner.prefix !== mine);
  return { stale, current: rows.length - stale.length };
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
  /** { stage, payment, checklistApplied, caseType, subType } of the case — "Yes" = a checklist exists. */
  caseState: async (cmItemId) => {
    const d = await require('./mondayApi').query(`query($ids:[ID!]){ items(ids:$ids, limit:1){ column_values(ids:["color_mm0x8faa","color_mm0x9fnn","color_mm0xs7kp","dropdown_mm0xd1qn","dropdown_mm0x4t91"]){ id text } } }`, { ids: [String(cmItemId)] });
    const item = d && d.items && d.items[0];
    if (!item) throw new Error('case not returned');
    const cv = Object.fromEntries((item.column_values || []).map((c) => [c.id, (c.text || '').trim()]));
    return { stage: cv.color_mm0x8faa || '', payment: cv.color_mm0x9fnn || '', checklistApplied: cv.color_mm0xs7kp || '', caseType: cv.dropdown_mm0xd1qn || '', subType: cv.dropdown_mm0x4t91 || '' };
  },
  /**
   * How the case's checklist was built. Schema rows carry "code:<documentCode>"
   * (the code starts with the Case Type + Sub Type it was built for); Template
   * rows carry the numeric Template item id; a row added by hand has neither
   * and is ignored.
   */
  checklistShape: async (caseRef) => {
    const d = await require('./mondayApi').query(`query($v:String!){ items_page_by_column_values(limit:500, board_id:"${process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593'}", columns:[{column_id:"text_mm0z2cck", column_values:[$v]}]){ items{ column_values(ids:["text_mm0zfsp1","text_mm17zdy7","color_mm0zwgvr"]){ id text } } } }`, { v: String(caseRef) });
    const rows = ((d && d.items_page_by_column_values && d.items_page_by_column_values.items) || []).map((r) => {
      const c = Object.fromEntries((r.column_values || []).map((x) => [x.id, String(x.text || '').trim()]));
      return { intake: c.text_mm0zfsp1 || '', subType: c.text_mm17zdy7 || '', status: c.color_mm0zwgvr || '' };
    });
    return {
      rows: rows.length,
      templateRows: rows.filter((r) => /^\d+$/.test(r.intake)).length,
      schema: rows.filter((r) => r.intake.startsWith('code:')).map((r) => ({ code: r.intake.slice(5), subType: r.subType, status: r.status })),
    };
  },
  /**
   * Before a Spouse / Dependent Child section is added: copy the answers the
   * client typed for them INSIDE the principal's single-member form into the
   * member's own file (questionnaireCarryOverService) — those boxes vanish
   * from his page the moment the list has two members.
   */
  carryOver: (args) => require('./questionnaireCarryOverService').carryEmbeddedAnswers(args),
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
  // A queue, not a gate: every add on this case runs strictly after the one
  // before it — INCLUDING that one's re-seed when it runs in the background,
  // so two re-seeds of one case never overlap.
  const prev = _inFlight.get(key) || Promise.resolve();
  const step = prev.catch(() => {}).then(() => addOne(p));            // → { result, done }
  const tail = step.then((o) => o.done, () => {}).catch(() => {});    // the queue waits for the re-seed too
  _inFlight.set(key, tail);
  tail.then(() => { if (_inFlight.get(key) === tail) _inFlight.delete(key); });
  const o = await step;
  return o.result;
}

async function addOne({ caseRef, cmItemId, clientName, boardType, name = '', source = 'staff', actor = null, reseedMode = 'await', caseSubType = '', forms = null }) {
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
  if (SINGLETON.has(boardType) && !manifest && boardRows.some((r) => r.boardType === boardType)) {
    throw badRequest(`A ${SHORT[boardType].toLowerCase()} is already on this case.`);
  }
  // No member list yet: build it NOW from the board rows held (never a later,
  // lagging board read), so every board member — named or not — has its key
  // before this member's key is chosen.
  let listCreated = false;
  if (!manifest) {
    let made;
    try { made = await io.createManifest({ clientName, caseRef, boardMembers: adapterMembers }); }
    catch (_) { throw transient(TRANSIENT_MSG); }
    manifest = (made && Array.isArray(made.members)) ? made.members : [];
    listCreated = !!(made && made.created);   // false: another writer's list — adopted / completed / refused below like any other
  }

  // The member the client already has on the questionnaire but not on the
  // board: complete it instead of refusing (the EE-070 drift, healed).
  const adopt = adoptableMember(boardType, { boardRows, manifestMembers: manifest || [] });
  // The mirror: a spouse / worker spouse / sponsor ON the board (with a key)
  // that the questionnaire list lacks — give them their section, no new row.
  // A row without a key gets the type's plain key for its section (the board
  // row is left as it is — one spouse needs no number on the checklist).
  let complete = null;
  if (!adopt && SINGLETON.has(boardType) && !manifest.some((mm) => mm.type === portalType)) {
    const r = boardRows.find((x) => x.boardType === boardType);
    if (r) {
      const boardKey = String(r.memberKey || '').trim();
      const key = /^[a-z][a-z0-9-]{0,40}$/.test(boardKey) && boardKey !== 'primary' && !manifest.some((mm) => mm.key === boardKey) ? boardKey
        : manifest.some((mm) => mm.key === KEY_BASE[boardType]) ? '' : KEY_BASE[boardType];
      if (key) complete = { ...r, memberKey: key, boardKey };
    }
  }
  if (!complete && SINGLETON.has(boardType) && boardRows.some((r) => r.boardType === boardType)) {
    throw badRequest(`A ${SHORT[boardType].toLowerCase()} is already on this case.`);
  }
  const memberKey = adopt ? adopt.key : complete ? complete.memberKey : nextMemberKey(boardType, { boardRows, manifestMembers: manifest || [] });
  if (!memberKey) throw badRequest(`A ${SHORT[boardType].toLowerCase()} is already on this case.`);
  const realName = (n) => { const c = cleanName(n); return c && !isPlaceholderName(c) ? c : ''; };
  const rowName = label || realName(adopt && adopt.label) || (complete && cleanName(complete.name)) || placeholderName(boardType, memberKey, source);
  const newMember = { role: BOARD_TO_ROLE[boardType], name: rowName, memberKey, flags: {} };
  let sectionLabel = '';   // what the questionnaire shows — never a placeholder

  // 0. the client's embedded answers for this member, copied into the member's
  //    own file BEFORE the list changes. A refusal or a read failure writes
  //    nothing; a copy that was written stays if a later step fails, and the
  //    retry replaces it (the copy is tagged until the client saves over it).
  let carry = null;
  const carrySvc = require('./questionnaireCarryOverService');
  // Only for a member NOT yet on the list ("adopted" ones are): no page shows
  // its section yet, so every page that will is loaded after the copy.
  if (!adopt && CARRY_TYPES.has(boardType) && carrySvc.isEnabled()) {
    try {
      carry = await io.carryOver({ clientName, caseRef, itemId: cmItemId, memberKey, memberType: portalType, memberName: label, forms });
    } catch (err) {
      if (err.badRequest) throw err;
      throw transient(`The client's questionnaire could not be read to copy their answers into the new section (${err.message}). Nothing was changed — try again in a minute.`);
    }
  }

  // 1. the questionnaire section (a failure here leaves no section, no row)
  let manifestState;
  try {
    if (adopt) { manifestState = 'adopted'; sectionLabel = adopt.label || ''; }
    else {
      const sectionName = label || realName(complete && complete.name) || undefined;
      const added = await io.addManifestMember({ clientName, caseRef, memberType: portalType, label: sectionName, key: memberKey });
      manifestState = complete ? 'completed' : listCreated ? 'created' : 'added';
      sectionLabel = (added && added.label) || sectionName || '';
    }
  } catch (err) {
    if (err.badRequest || /already been added|already used|Invalid member key/.test(err.message || '')) throw badRequest(err.message);
    throw transient(TRANSIENT_MSG);
  }

  // 2. the board row (the composition the checklist seeds from) — unless the
  //    member was ON the board already (a completed section)
  let rowId = '';
  if (!complete) try { rowId = await io.createRow({ caseRef, cmItemId, row: { name: rowName, memberType: boardType, memberKey } }); }
  catch (err) {
    await io.postNote(cmItemId, `⚠ <b>Family member half-added</b> — ${esc(boardType)} "${esc(rowName)}" by ${esc(who)}: the questionnaire section exists, but the Family Members row could not be created (${esc(err.message)}). Press ➕ Add family member on the case page again — it completes the row and the document rows.`).catch(() => {});
    const e = transient(`The questionnaire section was added, but the Family Members row could not be created (${err.message}). Press Add family member again in a minute — it completes the row.`);
    e.member = { key: memberKey, type: portalType, label: sectionLabel || portalType.split(' / ')[0] }; e.manifestAdded = true;
    throw e;
  }
  if (!complete) _recentRows.set(memKey, [...recentRows(memKey), { boardType, memberKey, name: rowName, at: io.now() }]);

  // 3. the checklist — only when one exists (Checklist Template Applied = Yes);
  //    fed the composition we hold, so the new member is in the plan whatever
  //    Monday's search says in the next seconds; rows are only ever added.
  const adapter = require('./compositionAdapter');
  const composition = complete
    ? { caseFlags: adapter.deriveCaseFlags(adapterMembers), members: adapterMembers.slice() }   // the member is on the board (and in this list) already
    : adapter.withMember({ members: adapterMembers }, newMember);
  let state = null;
  try { state = await io.caseState(cmItemId); } catch (err) { console.warn(`[Family] case state unreadable for ${caseRef}: ${err.message}`); }
  const result = { ok: true, key: memberKey, boardType, portalType, rowId, rowName, label: sectionLabel || (isPlaceholderName(rowName) ? '' : rowName), manifest: manifestState, stage: (state && state.stage) || '', reseed: null, hint: '', carry: carry && { copied: carry.copied, total: carry.total, bySection: carry.bySection, unmapped: carry.unmapped, skippedSharedTable: carry.skippedSharedTable, ambiguousDependent: carry.ambiguousDependent || 0, givenName: carry.givenName || '', unmatched: !!carry.unmatched, childNames: carry.childNames || [], attributedBlock: !!carry.attributedBlock, skipped: carry.skipped || '', written: !!carry.written, crossForm: carry.crossForm && carry.crossForm.written ? { copied: carry.crossForm.copied, unmapped: carry.crossForm.unmapped || [] } : null } };
  const norm = (v) => String(v || '').trim().toLowerCase();
  const finish = async () => {
    let shape = null;
    if (state) { try { shape = await io.checklistShape(caseRef); } catch (err) { console.warn(`[Family] checklist shape unreadable for ${caseRef}: ${err.message}`); } }
    if (!state) result.reseed = { unknown: true };
    // "No checklist yet" only when the flag says so AND no row a checklist build
    // made (schema "code:" or Template-id rows — never a hand-added row) exists:
    // a Monday automation used to reset the flag on cases whose rows were there.
    else if (state.checklistApplied !== 'Yes' && !(shape && (shape.schema.length + shape.templateRows) > 0)) result.reseed = { deferred: true };
    else {
      // Every schema key starts with the Case Type + Sub Type it was built for
      // (seedPlanner): rows of another variant would not match the re-seed's
      // keys. Leftover rows the client already uploaded to are harmless (the
      // Re-seed button keeps them too); OPEN ones mean a second checklist.
      const { stale, current } = shape ? splitByVariant(shape.schema, state) : { stale: [], current: 0 };
      const staleOpen = stale.filter((r) => ['', 'missing'].includes(norm(r.status)));   // as the Re-seed clean-up (selectStaleRows) reads "not uploaded"
      if (!shape) result.reseed = { unknown: true };
      else if (shape.templateRows > 0) result.reseed = { manual: 'template' };
      else if (stale.length && (current === 0 || staleOpen.length > 0)) {
        const sameType = stale.every((r) => r.owner && norm(r.owner.caseType) === norm(state.caseType));
        result.reseed = sameType
          ? { manual: 'subtype', from: [...new Set(stale.map((r) => r.owner.subType || r.subType))].join(', ') || '(another variant)', to: state.subType }
          : { manual: 'casetype', from: [...new Set(stale.map((r) => (r.owner ? r.owner.caseType : '')).filter(Boolean))].join(', ') || '(another case type)', to: state.caseType };
      } else {
        try { const r = await io.reseed(caseRef, composition); result.reseed = { created: r.created, skipped: r.skipped, failed: r.failed, pruned: r.pruned || 0 }; }
        catch (err) { result.reseed = err.code === 'NO_SCHEMA' ? { manual: 'no-schema' } : { error: err.message }; }
        // the hint only when the checklist's schema has no place for this member at all
        if (result.reseed.created === 0) {
          const css = require('./caseSchemaService');
          const covers = (s) => require('./seedPlanner').findOrphanMembers({ schema: s, composition: { members: [newMember] } }).length === 0;
          const schema = css.lookup(state.caseType, state.subType);
          if (schema && !covers(schema)) {
            const elsewhere = css.listForCaseType(state.caseType).some((s) => s !== schema && covers(s));
            result.hint = elsewhere
              ? `The Case Sub Type "${state.subType || caseSubType}" has no documents for a ${SHORT[boardType].toLowerCase()} — change it to the variant with family and press Re-seed Checklist.`
              : `This case type's checklist has no documents for a ${SHORT[boardType].toLowerCase()} — add any they need by hand.`;
          }
        }
      }
    }
    await io.postNote(cmItemId, note({ caseRef, boardType, rowName, who, manifestState, reseed: result.reseed, stage: result.stage, hint: result.hint, carry: result.carry })).catch((err) => console.warn(`[Family] note failed for ${caseRef}: ${err.message}`));
    console.log(`[Family] ${caseRef}: ${boardType} "${rowName}" (${memberKey}) added by ${source}; manifest ${manifestState}; reseed ${JSON.stringify(result.reseed)}`);
  };
  if (reseedMode === 'background') {
    const done = finish().catch((err) => console.warn(`[Family] background finish failed for ${caseRef}: ${err.message}`));
    return { result: { ...result, reseed: { pending: true } }, done };   // a snapshot: the caller never sees the job finish under it
  }
  await finish();
  return { result, done: Promise.resolve() };
}

function carrySentence(c) {
  if (!c) return '';
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const tbl = c.skippedSharedTable ? ` The children's shared history table in the client's own form (${n(c.skippedSharedTable, 'answer')}) was not copied — one table for all children; it leaves the client's page now, so check it with the client.` : '';
  const amb = c.ambiguousDependent ? ` The client's own form has a "Dependent" block whose name could not be matched to the spouse (${n(c.ambiguousDependent, 'answer')}) — not copied; it leaves the client's page now, so check it with the client.`
    : (c.attributedBlock && !c.written && c.skipped === 'has-answers') ? ' The "Dependent" block in the client\'s own form is the spouse\'s, but it was NOT copied over the answers already in the new section — it leaves the client\'s page now, so check it with the client.'
    : (c.attributedBlock && !c.written) ? ' The "Dependent" block in the client\'s own form is the spouse\'s (the name there matches) — nothing in it for this member.' : '';
  const x = c.crossForm ? ` Also pre-filled ${n(c.crossForm.copied, 'answer')} from the profile form into the member's APPLICATION-form section — the client must review them there${c.crossForm.unmapped && c.crossForm.unmapped.length ? ` (${c.crossForm.unmapped.length} profile-form answer${c.crossForm.unmapped.length === 1 ? ' has' : 's have'} no box on the application form: ${c.crossForm.unmapped.join(', ')})` : ''}.` : '';
  return carryCore(c) + tbl + amb + x;
}

function carryCore(c) {
  if (c.written) {
    const parts = Object.entries(c.bySection || {}).map(([s, k]) => `${s} ${k}`).join(', ');
    return ` Copied ${c.copied} answer${c.copied === 1 ? '' : 's'} the client had typed ${c.givenName ? `for ${c.givenName} ` : 'for this member '}inside their own form${c.attributedBlock ? ' (the "Dependent" block\'s name matches)' : ''} into the new section${parts ? ` (${parts})` : ''}` +
      `${c.unmapped && c.unmapped.length ? `; no box in the new section for: ${[...new Set(c.unmapped)].join(', ')} (kept aside)` : ''}.`;
  }
  if (c.unmatched) return ` The client's own form lists ${c.childNames && c.childNames.length ? `children named ${c.childNames.join(', ')}` : 'children'}; none matched the name given (or more than one did), so nothing was copied into this section.`;
  if (c.skipped === 'has-answers') return ' The new section already holds answers, so nothing was copied over it.';
  return '';
}

function note({ caseRef, boardType, rowName, who, manifestState, reseed, stage, hint, carry }) {
  const q = manifestState === 'added'     ? 'questionnaire section added on the client\'s existing link'
          : manifestState === 'adopted'   ? 'the questionnaire section the client already had is now matched by a row'
          : manifestState === 'completed' ? 'the member was on the Family Members board already — their questionnaire section is now added'
          : manifestState === 'created'   ? 'questionnaire member list created with this member'
          : 'questionnaire section added';
  const d = !reseed ? 'checklist not re-seeded'
          : reseed.manual === 'template' ? 'no document rows added — this case\'s checklist was built from the Template board (it uses different document keys, so an automatic re-seed would lay a second checklist beside it); check that the member\'s documents are on the checklist and add any missing ones by hand'
          : reseed.manual === 'subtype' ? `no document rows added — the checklist was built for Sub Type "${esc(reseed.from)}" and the case now says "${esc(reseed.to)}"; press Re-seed Checklist on the case (it replaces the old variant\'s empty rows and adds this member\'s)`
          : reseed.manual === 'casetype' ? `no document rows added — the checklist was built for Case Type "${esc(reseed.from)}" and the case now says "${esc(reseed.to || 'nothing')}" (an automatic re-seed would lay a second checklist beside it); the member\'s Family Members row and questionnaire section are in place, so do not add them again; if the Case Type is wrong, correct it and press Re-seed Checklist on the case (it adds this member\'s documents), otherwise ask an admin to rebuild the checklist`
          : reseed.manual === 'no-schema' ? 'no document rows added — this case type has no automatic checklist; add the member\'s documents by hand'
          : reseed.unknown ? 'the checklist state could not be read — press Re-seed Checklist on the case if its checklist exists'
          : reseed.deferred ? `no document rows yet — the checklist has not been created (the case is at "${esc(stage || 'Not Started')}"); they come with the checklist at Document Collection`
          : reseed.error ? `checklist re-seed FAILED (${esc(reseed.error)}) — press Re-seed Checklist on the case`
          : `checklist re-seeded (rows only added, never removed): ${reseed.created} new document row(s), ${reseed.skipped} existing left as they were${reseed.failed ? `, ${reseed.failed} failed — press Re-seed Checklist` : ''}`;
  return `👪 <b>Family member added</b> — ${esc(boardType)} "${esc(rowName)}" — by ${esc(who)}, ${esc(require('../utils/torontoTime').torontoTime(Date.now()))} (Toronto). ${manifestState === 'completed' ? '' : 'Family Members row created; '}${q}; ${d}.${esc(carrySentence(carry))}${hint ? ' ' + esc(hint) : ''} (${esc(caseRef)})`;
}

module.exports = { addFamilyMember, nextMemberKey, seedIndices, adoptableMember, splitByVariant, carrySentence, CARRY_TYPES, placeholderName, cleanName, PORTAL_TO_BOARD, BOARD_TO_PORTAL, ROLE_TO_BOARD, SINGLETON, NAME_MAX, RECENT_ROWS_MS, io, _inFlight, _recentRows };
