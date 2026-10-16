'use strict';

// Rows built for another Sub Type of the same Case Type are MOVED onto the
// Sub Type being seeded instead of a second checklist being laid beside them
// (2026-10-16, after case 2026-CEC-EE-085: "CEC Single Applicant" →
// "CEC Accompanying Spouse & Child" when a spouse joined).

const test   = require('node:test');
const assert = require('node:assert/strict');

const seeder = require('../src/services/executionSeederService');
const { seedPlan, _internal: { slugUpper } } = require('../src/services/seedPlanner');
const css = require('../src/services/caseSchemaService');
const mondayApi = require('../src/services/mondayApi');
const C = seeder._cols;

const REF = '2026-CEC-EE-085';
const CEC = 'Canadian Experience Class (EE after ITA)';
const SINGLE = 'CEC Single Applicant', ACC = 'CEC Accompanying Spouse & Child';
const PA = { role: 'PrincipalApplicant', flags: {} };
const SPOUSE = { role: 'Spouse', flags: {}, memberKey: 'spouse' };

let seq = 13184600000;
/** Board rows exactly as a seed of this variant writes them. */
function boardRowsFor(caseType, subType, members, { status = () => 'Received', caseRef = REF } = {}) {
  return seedPlan({ schema: css.lookup(caseType, subType), composition: { caseFlags: {}, members } }).map((p, i) => ({
    id: String(++seq), name: p.documentName, uniqueKey: `${caseRef}-${p.documentCode}`, documentCode: p.documentCode, intake: `code:${p.documentCode}`,
    subType, applicantType: p.applicantType, category: p.category, templateRel: '', status: status(p, i),
  }));
}
const planFor = (caseType, subType, members) => seedPlan({ schema: css.lookup(caseType, subType), composition: { caseFlags: {}, members } });
const tail = (code) => String(code).split('-').slice(-2, -1)[0];

/* ───────────────────────── the matcher (pure) ───────────────────────── */

test('EE-085: every Single Applicant row of the principal applicant moves onto the accompanying variant — 9 by document code, the 2 renamed codes by their exact name; the spouse rows stay to be created', () => {
  const rows = boardRowsFor(CEC, SINGLE, [PA], { status: (p, i) => (i === 10 ? 'Missing' : 'Received') });
  assert.equal(rows.length, 11);
  const plan = planFor(CEC, ACC, [PA, SPOUSE]);
  const { moves, stale } = seeder.planVariantMigration({ rows, plan, caseRef: REF, caseType: CEC, caseSubType: ACC });
  assert.equal(moves.length, 11);
  assert.equal(moves.filter((m) => m.by === 'code').length, 9);
  assert.deepEqual(moves.filter((m) => m.by === 'name').map((m) => `${tail(m.from.documentCode)}→${tail(m.to.row.documentCode)}`).sort(), ['CANADIANEDU→CANEDU', 'CIVILDOCS→IDCIVIL']);
  assert.ok(moves.every((m) => m.to.row.role === 'PrincipalApplicant'), 'never onto the spouse\'s rows');
  assert.ok(moves.every((m) => m.to.uniqueKey === `${REF}-${m.to.row.documentCode}`));
  assert.equal(new Set(moves.map((m) => m.to.uniqueKey)).size, 11, 'one old row per new row');
  const norm = (x) => String(x).toLowerCase().replace(/\(if applicable\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  assert.ok(moves.every((m) => norm(rows.find((r) => r.id === m.id).name) === norm(m.to.row.documentName)), 'the same document each time');
  assert.equal(stale.length, 11); assert.ok(stale.every((s) => s.moved && s.sameType));
});

test('a new row already on the board is never a target — the old row for it is left as it is (the Re-seed button\'s clean-up decides)', () => {
  const rows = boardRowsFor(CEC, SINGLE, [PA]);
  const plan = planFor(CEC, ACC, [PA]);
  const passport = plan.find((p) => tail(p.documentCode) === 'PASSPORT');
  rows.push({ id: String(++seq), name: passport.documentName, uniqueKey: `${REF}-${passport.documentCode}`, documentCode: passport.documentCode, intake: `code:${passport.documentCode}`, subType: ACC, applicantType: 'Principal Applicant', category: passport.category, templateRel: '', status: 'Missing' });
  const { moves, stale } = seeder.planVariantMigration({ rows, plan, caseRef: REF, caseType: CEC, caseSubType: ACC });
  assert.equal(moves.length, 10);
  assert.ok(!moves.some((m) => m.to.row.documentCode === passport.documentCode));
  assert.equal(stale.filter((s) => !s.moved).length, 1, 'the old passport row stays stale');
  assert.equal(stale.length, 11, 'the current variant\'s own row is never stale');
});

test('two old rows for one document: the one the client uploaded to moves (else the oldest); the other stays', () => {
  const plan = planFor(CEC, ACC, [PA]);
  const [a] = boardRowsFor(CEC, SINGLE, [PA], { status: () => 'Missing' });
  const b = { ...a, id: String(Number(a.id) + 500), status: 'Received' };
  const r1 = seeder.planVariantMigration({ rows: [a, b], plan, caseRef: REF, caseType: CEC, caseSubType: ACC });
  assert.deepEqual(r1.moves.map((m) => m.id), [b.id]);
  const c = { ...a, id: String(Number(a.id) + 900) };
  const r2 = seeder.planVariantMigration({ rows: [c, a], plan, caseRef: REF, caseType: CEC, caseSubType: ACC });
  assert.deepEqual(r2.moves.map((m) => m.id), [a.id], 'both empty: the oldest');
});

test('never across people or case types: a non-accompanying spouse\'s row is not the accompanying spouse\'s; another Case Type\'s rows are stale but never moved; malformed and Template rows are left alone', () => {
  const nonAcc = boardRowsFor(CEC, SINGLE, [PA, { role: 'NonAccompanyingSpouse', flags: {} }]).filter((r) => /NONACCOMPANYINGSPOUSE/.test(r.documentCode));
  assert.ok(nonAcc.length > 0);
  const plan = planFor(CEC, ACC, [PA, SPOUSE]);
  const r = seeder.planVariantMigration({ rows: nonAcc, plan, caseRef: REF, caseType: CEC, caseSubType: ACC });
  assert.equal(r.moves.length, 0); assert.equal(r.stale.length, nonAcc.length); assert.ok(r.stale.every((s) => s.sameType && !s.moved));

  const other = css.listRegistered().find((s) => s.caseType !== CEC && css.lookup(s.caseType, s.subType).roles.some((x) => x.role === 'PrincipalApplicant'));
  const foreign = boardRowsFor(other.caseType, other.subType, [PA]);
  const f = seeder.planVariantMigration({ rows: foreign, plan, caseRef: REF, caseType: CEC, caseSubType: ACC });
  assert.equal(f.moves.length, 0); assert.ok(f.stale.length > 0 && f.stale.every((s) => !s.sameType));

  const good = boardRowsFor(CEC, SINGLE, [PA]);
  const bad = [
    { ...good[0], uniqueKey: `2026-CEC-EE-999-${good[0].documentCode}` },   // the key names another case
    { ...good[1], intake: 'code:SOMETHING-ELSE' },                           // the intake id disagrees with the code
    { ...good[2], templateRel: 'linked' },                                   // a Template-board row
    { ...good[3], intake: '' },                                               // a row added by hand
  ];
  const b = seeder.planVariantMigration({ rows: bad, plan, caseRef: REF, caseType: CEC, caseSubType: ACC });
  assert.equal(b.moves.length, 0);
  assert.equal(b.stale.length, 2, 'Template and hand-added rows are not schema rows at all');
});

// A small registry of our own: numbered children, renamed documents, look-alike Sub Type names.
const T = 'Test Family Visa';
const doc = (code, name, category = 'Identity') => ({ code, name, category });
const SCHEMAS = {
  Old: { caseType: T, subType: 'Old', roles: [
    { role: 'PrincipalApplicant', required: true, documents: [doc('PASSPORT', 'Passport'), doc('PHOTO', 'Photo'), doc('BANKA', 'Bank statement', 'Financial'), doc('BANKB', 'Bank statement', 'Financial')] },
    { role: 'DependentChild', multipleAllowed: true, includeWhen: { caseFlag: 'childrenIncluded' }, documents: [doc('BIRTH', 'Birth certificate')] }] },
  New: { caseType: T, subType: 'New', roles: [
    { role: 'PrincipalApplicant', required: true, documents: [doc('PASSPORT', 'Passport'), doc('PHOTO', 'Two photos'), doc('BANK', 'Bank statement', 'Financial')] },
    { role: 'DependentChild', multipleAllowed: true, includeWhen: { caseFlag: 'childrenIncluded' }, documents: [doc('BIRTHCERT', 'Birth certificate (if applicable)', 'Civil')] }] },
  'New Plus': { caseType: T, subType: 'New Plus', roles: [
    { role: 'PrincipalApplicant', required: true, documents: [doc('PASSPORT', 'Passport')] }] },
};
const registered = Object.values(SCHEMAS).map((s) => ({ caseType: s.caseType, subType: s.subType }));
const lookup = (ct, st) => (ct === T ? SCHEMAS[st] || null : null);
const kids = [PA, { role: 'DependentChild', flags: {}, memberKey: 'child-1' }, { role: 'DependentChild', flags: {}, memberKey: 'child-2' }];
const rowsOf = (subType, members, status = 'Received') => seedPlan({ schema: SCHEMAS[subType], composition: { caseFlags: {}, members } }).map((p) => ({
  id: String(++seq), name: p.documentName, uniqueKey: `${REF}-${p.documentCode}`, documentCode: p.documentCode, intake: `code:${p.documentCode}`,
  subType, applicantType: p.applicantType, category: p.category, templateRel: '', status,
}));

test('each child keeps their own documents (child 2 → child 2, never child 1), matched by name when the code was renamed ("(if applicable)" ignored)', () => {
  const rows = rowsOf('Old', kids).filter((r) => /DEPENDENTCHILD2/.test(r.documentCode));
  const plan = seedPlan({ schema: SCHEMAS.New, composition: { caseFlags: {}, members: kids } });
  const { moves } = seeder.planVariantMigration({ rows, plan, caseRef: REF, caseType: T, caseSubType: 'New', registered, lookup });
  assert.equal(moves.length, 1);
  assert.match(moves[0].to.row.documentCode, /-DEPENDENTCHILD2-BIRTHCERT-001$/);
  assert.equal(moves[0].by, 'name');
});

test('a name shared by two documents is never a match (on either side) — no guessing', () => {
  const plan = seedPlan({ schema: SCHEMAS.New, composition: { caseFlags: {}, members: [PA] } });
  const rows = rowsOf('Old', [PA]).filter((r) => /-BANKA-|-BANKB-/.test(r.documentCode));
  const { moves } = seeder.planVariantMigration({ rows, plan, caseRef: REF, caseType: T, caseSubType: 'New', registered, lookup });
  assert.equal(moves.length, 0, 'two old "Bank statement" documents for one new one');
  const one = seeder.planVariantMigration({ rows: rows.slice(0, 1), plan, caseRef: REF, caseType: T, caseSubType: 'New', registered, lookup });
  assert.equal(one.moves.length, 1, 'with one old one it moves');
});

test('the longest Sub Type prefix owns a row ("New" is the start of "New Plus") — in both directions', () => {
  const plus = rowsOf('New Plus', [PA]);
  const toNew = seeder.planVariantMigration({ rows: plus, plan: seedPlan({ schema: SCHEMAS.New, composition: { caseFlags: {}, members: [PA] } }), caseRef: REF, caseType: T, caseSubType: 'New', registered, lookup });
  assert.equal(toNew.stale.length, 1, '"New Plus" rows are NOT the current "New" variant');
  assert.equal(toNew.moves.length, 1);
  const plain = rowsOf('New', [PA]);
  const toPlus = seeder.planVariantMigration({ rows: plain, plan: seedPlan({ schema: SCHEMAS['New Plus'], composition: { caseFlags: {}, members: [PA] } }), caseRef: REF, caseType: T, caseSubType: 'New Plus', registered, lookup });
  assert.equal(toPlus.stale.length, 3); assert.equal(toPlus.moves.length, 1, 'only the passport has a place in "New Plus"');
});

test('a retired / renamed Sub Type (no longer registered) is read from the row\'s own Sub Type column and moved by code', () => {
  const code = `${slugUpper(T)}-RETIRED-NAME-PRINCIPALAPPLICANT-PASSPORT-001`;
  const rows = [{ id: '1', name: 'Passport', uniqueKey: `${REF}-${code}`, documentCode: code, intake: `code:${code}`, subType: 'Retired Name', applicantType: 'Principal Applicant', category: 'Identity', templateRel: '', status: 'Received' }];
  const { moves, stale } = seeder.planVariantMigration({ rows, plan: seedPlan({ schema: SCHEMAS.New, composition: { caseFlags: {}, members: [PA] } }), caseRef: REF, caseType: T, caseSubType: 'New', registered, lookup });
  assert.equal(stale.length, 1); assert.equal(stale[0].owner.subType, 'Retired Name');
  assert.equal(moves.length, 1); assert.equal(moves[0].by, 'code');
});

/* ───────────────────────── the re-seed (I/O over a fake board) ───────────────────────── */

/**
 * A fake Execution board: serves the key read, the row read, the prune read,
 * moves (change_multiple_column_values), creates and deletes. lag:true → the
 * searches keep showing the rows as they were BEFORE this run's writes.
 */
function fakeBoard(rows, { lag = false, failMoveIds = [], failRowRead = false } = {}) {
  const board = rows.map((r) => ({ ...r }));
  const before = new Map(board.map((r) => [r.id, { ...r }]));
  const calls = { moves: [], creates: [], deletes: [], relations: [], reads: 0 };
  const created = new Set();
  const view = (r) => (lag && before.has(r.id) ? before.get(r.id) : r);
  const cv = (r, ids) => ids.map((id) => {
    const map = { [C.uniqueKey]: r.uniqueKey, [C.documentCode]: r.documentCode, [C.intakeItemId]: r.intake, [C.caseSubType]: r.subType, [C.applicantType]: r.applicantType, [C.documentCategory]: r.category, color_mm0zwgvr: r.status, board_relation_mm0zhagw: '' };
    return { id, text: map[id] == null ? '' : map[id], value: id === 'board_relation_mm0zhagw' ? (r.templateRel ? JSON.stringify({ linkedPulseIds: [{ linkedPulseId: 1 }] }) : null) : null };
  });
  const real = mondayApi.query;
  mondayApi.query = async (q, v) => {
    if (/delete_item/.test(q)) { calls.deletes.push(String(v.id)); return { delete_item: { id: v.id } }; }
    if (/create_item/.test(q)) {
      const id = String(900000 + calls.creates.length); const cols = JSON.parse(v.cols);
      calls.creates.push({ id, name: v.name, cols }); created.add(id);
      board.push({ id, name: v.name, uniqueKey: cols[C.uniqueKey], documentCode: cols[C.documentCode], intake: cols[C.intakeItemId], subType: cols[C.caseSubType], applicantType: cols[C.applicantType], category: cols[C.documentCategory], templateRel: '', status: '' });
      return { create_item: { id } };
    }
    if (/change_multiple_column_values/.test(q)) {
      if (created.has(String(v.itemId))) { calls.relations.push(v.itemId); return { change_multiple_column_values: { id: v.itemId } }; }
      if (failMoveIds.includes(String(v.itemId))) throw new Error('Monday 503');
      const cols = JSON.parse(v.cols); calls.moves.push({ id: String(v.itemId), cols });
      const r = board.find((x) => x.id === String(v.itemId));
      Object.assign(r, { uniqueKey: cols[C.uniqueKey], documentCode: cols[C.documentCode], intake: cols[C.intakeItemId], subType: cols[C.caseSubType] },
        cols[C.applicantType] ? { applicantType: cols[C.applicantType] } : {}, cols[C.documentCategory] ? { category: cols[C.documentCategory] } : {}, cols.name ? { name: cols.name } : {});
      return { change_multiple_column_values: { id: v.itemId } };
    }
    if (/items_page_by_column_values/.test(q)) {
      calls.reads++;
      if (/getExistingItems/.test(q)) return { items_page_by_column_values: { items: board.map((r) => ({ column_values: cv(view(r), [C.uniqueKey]) })) } };
      if (q.includes(C.documentCode)) {
        if (failRowRead) throw new Error('Monday 500');
        return { items_page_by_column_values: { items: board.map((r) => ({ id: r.id, name: view(r).name, column_values: cv(view(r), [C.uniqueKey, C.documentCode, C.intakeItemId, C.caseSubType, C.applicantType, C.documentCategory, 'board_relation_mm0zhagw', 'color_mm0zwgvr']) })) } };
      }
      return { items_page_by_column_values: { items: board.map((r) => ({ id: r.id, column_values: cv(view(r), [C.caseSubType, C.uniqueKey, 'board_relation_mm0zhagw', 'color_mm0zwgvr']) })) } };
    }
    throw new Error('unexpected query: ' + q.slice(0, 80));
  };
  return { board, calls, restore: () => { mondayApi.query = real; } };
}
const reconcile = (plan, extra = {}) => seeder.reconcileExecutionRows({ caseRef: REF, caseType: CEC, caseSubType: ACC, clientMasterItemId: '13171988312', plan, ...extra });

test('re-seed after the Sub Type changed (EE-085): the 11 old rows are MOVED (one write each: key, code, intake id, Sub Type), only the spouse\'s 11 are created, nothing is pruned — even while Monday\'s search still shows the old values', async () => {
  const rows = boardRowsFor(CEC, SINGLE, [PA], { status: (p, i) => (i === 10 ? 'Missing' : 'Received') });
  const fb = fakeBoard(rows, { lag: true });
  try {
    const r = await reconcile(planFor(CEC, ACC, [PA, SPOUSE]));
    assert.equal(r.migrated, 11); assert.equal(r.created, 11); assert.equal(r.skipped, 0); assert.equal(r.failed, 0); assert.equal(r.pruned, 0);
    assert.deepEqual(r.migratedFrom, [SINGLE]);
    assert.deepEqual(fb.calls.deletes, [], 'a moved row is never pruned, whatever a lagging search says');
    assert.ok(fb.calls.creates.every((c) => c.cols[C.applicantType] === 'Spouse'), 'only the spouse\'s rows are created');
    assert.equal(fb.calls.moves.length, 11);
    for (const m of fb.calls.moves) {
      const code = m.cols[C.documentCode];
      assert.ok(code.startsWith(`${slugUpper(CEC)}-${slugUpper(ACC)}-PRINCIPALAPPLICANT-`));
      assert.equal(m.cols[C.uniqueKey], `${REF}-${code}`); assert.equal(m.cols[C.intakeItemId], `code:${code}`); assert.equal(m.cols[C.caseSubType], ACC);
      assert.ok(!('color_mm0zwgvr' in m.cols), 'the status (the client\'s upload) is never written');
      assert.ok(!(C.applicantType in m.cols) && !(C.documentCategory in m.cols), 'same person and category: not rewritten');
    }
    // the one document whose name differs between the two Sub Types takes the new one (the row still had the old variant's own name)
    assert.deepEqual(fb.calls.moves.filter((m) => 'name' in m.cols).map((m) => m.cols.name), ['Sibling- Proof of living in Canada (if applicable)']);
  } finally { fb.restore(); }
  // a second re-seed, once Monday has caught up, finds everything in place
  const later = fakeBoard(fb.board);
  try {
    const again = await reconcile(planFor(CEC, ACC, [PA, SPOUSE]));
    assert.deepEqual([again.migrated, again.created, again.skipped, again.pruned], [0, 0, 22, 0]);
  } finally { later.restore(); }
});

test('a move that fails: its new row is NOT created beside the old one, the old row is not pruned, and it counts as failed (press Re-seed again)', async () => {
  const rows = boardRowsFor(CEC, SINGLE, [PA], { status: () => 'Missing' });
  const fb = fakeBoard(rows, { failMoveIds: [rows[0].id] });
  try {
    const r = await reconcile(planFor(CEC, ACC, [PA]));
    assert.equal(r.migrated, 10); assert.equal(r.failed, 1); assert.equal(r.created, 0);
    assert.deepEqual(fb.calls.deletes, [], 'the empty old row whose move failed is kept for the next run');
    fb.restore();
    const retry = fakeBoard(fb.board);
    try { const r2 = await reconcile(planFor(CEC, ACC, [PA])); assert.deepEqual([r2.migrated, r2.created, r2.failed], [1, 0, 0]); } finally { retry.restore(); }
  } finally { fb.restore(); }
});

test('the Re-seed button (prune on): rows that match are moved; an EMPTY old row with no match is removed; an uploaded one with no match stays', async () => {
  const rows = boardRowsFor(CEC, SINGLE, [PA, { role: 'NonAccompanyingSpouse', flags: {} }], { status: (p) => (p.role === 'NonAccompanyingSpouse' && /PASSPORT/.test(p.documentCode) ? 'Received' : 'Missing') });
  const nonAcc = rows.filter((r) => /NONACCOMPANYINGSPOUSE/.test(r.documentCode));
  const fb = fakeBoard(rows);
  try {
    const r = await reconcile(planFor(CEC, ACC, [PA, SPOUSE]));
    assert.equal(r.migrated, 11);
    const kept = nonAcc.filter((x) => x.status === 'Received').map((x) => x.id);
    assert.deepEqual(fb.calls.deletes.sort(), nonAcc.filter((x) => x.status !== 'Received').map((x) => x.id).sort());
    assert.ok(kept.length === 1 && !fb.calls.deletes.includes(kept[0]));
  } finally { fb.restore(); }
});

test('staleOpen "refuse" (the family add): an empty old row with no match → NOTHING is written and the leftovers are named; with every old row matched it moves and adds', async () => {
  const rows = boardRowsFor(CEC, SINGLE, [PA, { role: 'NonAccompanyingSpouse', flags: {} }], { status: () => 'Missing' });
  const fb = fakeBoard(rows);
  try {
    const r = await reconcile(planFor(CEC, ACC, [PA, SPOUSE]), { staleOpen: 'refuse', prune: false });
    assert.equal(r.refused, 'stale-open'); assert.ok(r.leftover.length > 0 && r.leftover.every((x) => x.subType === SINGLE));
    assert.deepEqual([fb.calls.moves.length, fb.calls.creates.length, fb.calls.deletes.length], [0, 0, 0]);
  } finally { fb.restore(); }
  const ok = fakeBoard(boardRowsFor(CEC, SINGLE, [PA], { status: () => 'Missing' }));
  try {
    const r = await reconcile(planFor(CEC, ACC, [PA, SPOUSE]), { staleOpen: 'refuse', prune: false });
    assert.equal(r.refused, undefined); assert.equal(r.migrated, 11); assert.equal(r.created, 11);
  } finally { ok.restore(); }
});

test('the switch: CHECKLIST_VARIANT_MIGRATE=0 → re-seeds behave exactly as before (no row read, no moves) and "refuse" refuses', async () => {
  process.env.CHECKLIST_VARIANT_MIGRATE = '0';
  const fb = fakeBoard(boardRowsFor(CEC, SINGLE, [PA], { status: () => 'Received' }));
  try {
    assert.equal(seeder.variantMigrateEnabled(), false);
    const r = await reconcile(planFor(CEC, ACC, [PA]), { prune: false });
    assert.deepEqual([r.migrated, r.created], [0, 11]);
    assert.equal(fb.calls.moves.length, 0);
    const refused = await reconcile(planFor(CEC, ACC, [PA]), { staleOpen: 'refuse' });
    assert.equal(refused.refused, 'migration-off');
  } finally { fb.restore(); delete process.env.CHECKLIST_VARIANT_MIGRATE; }
  assert.equal(seeder.variantMigrateEnabled(), true, 'on unless switched off');
  for (const v of ['off', 'false', 'NO', ' 0 ']) { process.env.CHECKLIST_VARIANT_MIGRATE = v; assert.equal(seeder.variantMigrateEnabled(), false, v); }
  delete process.env.CHECKLIST_VARIANT_MIGRATE;
});

test('the row read fails on a case that HAS a checklist → the re-seed stops before any write (never a second checklist); on a case with none it seeds', async () => {
  const fb = fakeBoard(boardRowsFor(CEC, SINGLE, [PA]), { failRowRead: true });
  try {
    await assert.rejects(reconcile(planFor(CEC, ACC, [PA])), /nothing was changed/);
    assert.deepEqual([fb.calls.moves.length, fb.calls.creates.length, fb.calls.deletes.length], [0, 0, 0]);
  } finally { fb.restore(); }
  const empty = fakeBoard([], { failRowRead: true });
  try { const r = await reconcile(planFor(CEC, ACC, [PA])); assert.equal(r.created, 11); } finally { empty.restore(); }
});

test('no Case Type given (any older caller) → no move is attempted, exactly the old reconcile', async () => {
  const fb = fakeBoard(boardRowsFor(CEC, SINGLE, [PA], { status: () => 'Received' }));
  try {
    const r = await seeder.reconcileExecutionRows({ caseRef: REF, caseSubType: ACC, clientMasterItemId: '1', plan: planFor(CEC, ACC, [PA]), prune: false });
    assert.deepEqual([r.migrated, r.created], [0, 11]); assert.equal(fb.calls.moves.length, 0);
  } finally { fb.restore(); }
});

test('a moved row takes the new variant\'s person label / category / folder link when they differ, and its new name only when it still had the old variant\'s own name', async () => {
  const rows = rowsOf('Old', [PA]).filter((r) => /-PHOTO-/.test(r.documentCode));
  const custom = { ...rows[0], id: String(++seq), name: 'Photos (taken at the office)' };
  const kid = rowsOf('Old', kids).find((r) => /DEPENDENTCHILD1-BIRTH/.test(r.documentCode));
  const fb = fakeBoard([rows[0], { ...kid, applicantType: 'Principal Applicant' }]);
  const realLookup = css.lookup, realList = css.listRegistered;
  css.lookup = lookup; css.listRegistered = () => registered;
  try {
    const plan = seedPlan({ schema: SCHEMAS.New, composition: { caseFlags: {}, members: kids } });
    const r = await seeder.reconcileExecutionRows({ caseRef: REF, caseType: T, caseSubType: 'New', clientMasterItemId: '1', plan, categoryLinks: { Civil: 'https://onedrive.example/civil' }, prune: false });
    assert.equal(r.migrated, 2);
    const photo = fb.calls.moves.find((m) => m.id === rows[0].id).cols;
    assert.equal(photo.name, 'Two photos', 'still the old variant\'s own name → renamed to the new one');
    const birth = fb.calls.moves.find((m) => m.id === kid.id).cols;
    assert.equal(birth[C.applicantType], 'Dependent Child 1', 'a wrong person label is corrected from the code');
    assert.equal(birth[C.documentCategory], 'Civil');
    assert.deepEqual(birth[C.documentFolder], { url: 'https://onedrive.example/civil', text: 'Civil Folder' });
    assert.equal(birth.name, 'Birth certificate (if applicable)', 'matched by name, still the old variant\'s own wording → the new wording');
  } finally { fb.restore(); css.lookup = realLookup; css.listRegistered = realList; }
  const fb2 = fakeBoard([custom]);
  css.lookup = lookup; css.listRegistered = () => registered;
  try {
    const plan = seedPlan({ schema: SCHEMAS.New, composition: { caseFlags: {}, members: [PA] } });
    await seeder.reconcileExecutionRows({ caseRef: REF, caseType: T, caseSubType: 'New', clientMasterItemId: '1', plan, prune: false });
    assert.ok(!('name' in fb2.calls.moves[0].cols), 'a name staff changed is kept');
  } finally { fb2.restore(); css.lookup = realLookup; css.listRegistered = realList; }
});

test('staff see it: the Re-seed note names the moved rows and the removed empty ones; the case page says how many moved', () => {
  const fs = require('fs');
  const btn = fs.readFileSync(require.resolve('../src/services/reseedButtonService.js'), 'utf8');
  assert.match(btn, /row\(s\) moved over from Sub Type/);
  assert.match(btn, /empty row\(s\) of another Sub Type removed/);
  const page = fs.readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8');
  assert.match(page, /row\(s\) moved over from the old Sub Type \(uploads kept\)\./);
  const cl = fs.readFileSync(require.resolve('../src/services/checklistService.js'), 'utf8');
  assert.match(cl, /caseType:\s+schema\.caseType,/, 'every schema seed passes its Case Type — the move runs on every re-seed');
  assert.match(cl, /migrated: result\.migrated \|\| 0/);
});
