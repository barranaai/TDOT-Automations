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
function boardRowsFor(caseType, subType, members, { status = () => 'Received', caseRef = REF, caseFlags = {} } = {}) {
  return seedPlan({ schema: css.lookup(caseType, subType), composition: { caseFlags, members } }).map((p, i) => ({
    id: String(++seq), name: p.documentName, uniqueKey: `${caseRef}-${p.documentCode}`, documentCode: p.documentCode, intake: `code:${p.documentCode}`,
    subType, applicantType: p.applicantType, category: p.category, templateRel: '', status: status(p, i),
  }));
}
const planFor = (caseType, subType, members) => seedPlan({ schema: css.lookup(caseType, subType), composition: { caseFlags: {}, members } });
const KIDS = { caseFlags: { childrenIncluded: true } };   // the non-accompanying children's one shared block
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

test('the spouse is one person in both Sub Types: the non-accompanying spouse\'s rows move onto the accompanying spouse\'s (and back) — never onto the principal\'s', () => {
  const nonAcc = boardRowsFor(CEC, SINGLE, [PA, { role: 'NonAccompanyingSpouse', flags: {} }]).filter((r) => /NONACCOMPANYINGSPOUSE/.test(r.documentCode));
  assert.equal(nonAcc.length, 5);
  const r = seeder.planVariantMigration({ rows: nonAcc, plan: planFor(CEC, ACC, [PA, SPOUSE]), caseRef: REF, caseType: CEC, caseSubType: ACC });
  assert.equal(r.moves.length, 5, 'passport, permits, photo, medical, PCC');
  assert.ok(r.moves.every((m) => m.to.row.role === 'Spouse' && m.by === 'code'));
  const back = boardRowsFor(CEC, ACC, [PA, SPOUSE]).filter((x) => x.applicantType === 'Spouse');
  const singlePlan = seedPlan({ schema: css.lookup(CEC, SINGLE), composition: { caseFlags: { spouseIncluded: true }, members: [PA, SPOUSE] } });   // as compositionAdapter derives it
  const b = seeder.planVariantMigration({ rows: back, plan: singlePlan, caseRef: REF, caseType: CEC, caseSubType: SINGLE });
  assert.equal(b.moves.length, 5); assert.ok(b.moves.every((m) => m.to.row.role === 'NonAccompanyingSpouse'));
});

test('never across people or case types: the non-accompanying children\'s shared block is not any one child\'s; another Case Type\'s rows are stale but never moved; malformed and Template rows are left alone', () => {
  const nac = boardRowsFor(CEC, SINGLE, [PA], KIDS).filter((r) => /NONACCOMPANYINGCHILD/.test(r.documentCode));
  assert.ok(nac.length > 0);
  const plan = planFor(CEC, ACC, [PA, { role: 'DependentChild', flags: {}, memberKey: 'child-1' }]);
  const r = seeder.planVariantMigration({ rows: nac, plan, caseRef: REF, caseType: CEC, caseSubType: ACC });
  assert.equal(r.moves.length, 0); assert.equal(r.stale.length, nac.length); assert.ok(r.stale.every((s) => s.sameType && !s.moved));

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
  Mid: { caseType: T, subType: 'Mid', roles: [
    { role: 'PrincipalApplicant', required: true, documents: [doc('PHOTO', 'Two photos')] }] },
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
function fakeBoard(rows, { lag = false, failMoveIds = [], failRowRead = false, reasons = {} } = {}) {
  const board = rows.map((r) => ({ ...r }));
  const before = new Map(board.map((r) => [r.id, { ...r }]));
  const calls = { moves: [], creates: [], deletes: [], relations: [], reads: 0, updates: [] };
  const reasonCol = require('../src/services/documentNotApplicable').reasonColumnId();
  const created = new Set();
  const view = (r) => (lag && before.has(r.id) ? before.get(r.id) : r);
  const cv = (r, ids) => ids.map((id) => {
    const map = { [C.uniqueKey]: r.uniqueKey, [C.documentCode]: r.documentCode, [C.intakeItemId]: r.intake, [C.caseSubType]: r.subType, [C.applicantType]: r.applicantType, [C.documentCategory]: r.category, color_mm0zwgvr: r.status, board_relation_mm0zhagw: '', date_mm0zyw0m: r.uploadDate || '', [reasonCol]: reasons[r.id] || '' };
    return { id, text: map[id] == null ? '' : map[id], value: id === 'board_relation_mm0zhagw' ? (r.templateRel ? JSON.stringify({ linkedPulseIds: [{ linkedPulseId: 1 }] }) : null) : null };
  });
  const real = mondayApi.query;
  mondayApi.query = async (q, v) => {
    if (/create_update/.test(q)) { calls.updates.push(v); return { create_update: { id: '1' } }; }
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
        return { items_page_by_column_values: { items: board.map((r) => ({ id: r.id, name: view(r).name, column_values: cv(view(r), [C.uniqueKey, C.documentCode, C.intakeItemId, C.caseSubType, C.applicantType, C.documentCategory, 'board_relation_mm0zhagw', 'color_mm0zwgvr', 'date_mm0zyw0m', reasonCol]) })) } };
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
  const rows = boardRowsFor(CEC, SINGLE, [PA], { ...KIDS, status: (p) => (p.role === 'NonAccompanyingChild' && /PASSPORT/.test(p.documentCode) ? 'Received' : 'Missing') });
  const nonAcc = rows.filter((r) => /NONACCOMPANYINGCHILD/.test(r.documentCode));
  assert.ok(nonAcc.some((x) => x.status === 'Received'));
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
  const rows = boardRowsFor(CEC, SINGLE, [PA], { ...KIDS, status: () => 'Missing' });
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
  const rows = rowsOf('Old', [PA], 'Missing').filter((r) => /-PHOTO-/.test(r.documentCode));
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
    assert.ok(!(C.documentCategory in birth) && !(C.documentFolder in birth), 'UPLOADED: the category and folder link stay with the file\'s folder');
    assert.equal(birth.name, 'Birth certificate (if applicable)', 'matched by name, still the old variant\'s own wording → the new wording');
  } finally { fb.restore(); css.lookup = realLookup; css.listRegistered = realList; }
  // the same move for a row with NO upload yet: category + folder link follow the new Sub Type
  const emptyKid = { ...kid, id: String(++seq), status: 'Missing' };
  const fb3 = fakeBoard([emptyKid]);
  css.lookup = lookup; css.listRegistered = () => registered;
  try {
    const plan = seedPlan({ schema: SCHEMAS.New, composition: { caseFlags: {}, members: kids } });
    await seeder.reconcileExecutionRows({ caseRef: REF, caseType: T, caseSubType: 'New', clientMasterItemId: '1', plan, categoryLinks: { Civil: 'https://onedrive.example/civil' }, prune: false });
    const c = fb3.calls.moves[0].cols;
    assert.equal(c[C.documentCategory], 'Civil');
    assert.deepEqual(c[C.documentFolder], { url: 'https://onedrive.example/civil', text: 'Civil Folder' });
  } finally { fb3.restore(); css.lookup = realLookup; css.listRegistered = realList; }
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
  assert.match(btn, /document\(s\) of the old Sub Type need a check — they are listed in the separate "Checklist moved" note/);
  const page = fs.readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8');
  assert.match(page, /row\(s\) moved over from the old Sub Type \(uploads kept\)\./);
  assert.match(page, /document\(s\) of the old Sub Type need a check — see the Checklist moved note on the case\./);
  assert.match(page, /rs\.manual === 'subtype' && rs\.noSchema \? 'No document rows added: the Case Sub Type is blank or has no automatic checklist — set the correct Sub Type first, then press Re-seed Checklist on the case\.'/);
  const cl = fs.readFileSync(require.resolve('../src/services/checklistService.js'), 'utf8');
  assert.match(cl, /caseType:\s+schema\.caseType,/, 'every schema seed passes its Case Type — the move runs on every re-seed');
  assert.match(cl, /migrated: result\.migrated \|\| 0/);
});

test('an UPLOADED row moves only onto the same requirement: worded differently in the new Sub Type → the upload stays on its old row, a new row asks for the new version, and it is reported as changed', () => {
  const plan = seedPlan({ schema: SCHEMAS.New, composition: { caseFlags: {}, members: [PA] } });
  const photo = rowsOf('Old', [PA], 'Received').find((r) => /-PHOTO-/.test(r.documentCode));   // "Photo" → "Two photos"
  const up = seeder.planVariantMigration({ rows: [photo], plan, caseRef: REF, caseType: T, caseSubType: 'New', registered, lookup });
  assert.equal(up.moves.length, 0);
  assert.deepEqual(up.changed, [{ id: photo.id, name: 'Photo', status: 'Received', from: 'Photo', to: 'Two photos', person: 'Principal Applicant' }]);
  const empty = seeder.planVariantMigration({ rows: [{ ...photo, status: 'Missing' }], plan, caseRef: REF, caseType: T, caseSubType: 'New', registered, lookup });
  assert.equal(empty.moves.length, 1, 'no upload yet: it simply becomes the new document');
  assert.deepEqual(empty.changed, []);
  // an empty twin takes the new document; the uploaded one stays (and is reported)
  const both = seeder.planVariantMigration({ rows: [photo, { ...photo, id: String(Number(photo.id) + 1), status: 'Missing' }], plan, caseRef: REF, caseType: T, caseSubType: 'New', registered, lookup });
  assert.deepEqual(both.moves.map((m) => m.id), [String(Number(photo.id) + 1)]); assert.deepEqual(both.changed.map((c) => c.id), [photo.id]);
});

test('sameRequirement: case, spacing, punctuation and "(if applicable)" never matter; a bracket only ONE side has is a clarification; different brackets on both sides are a different requirement', () => {
  const same = seeder.sameRequirement;
  assert.equal(same('Sibling - Proof of living in Canada', 'Sibling- Proof of living in Canada (if applicable)'), true);
  assert.equal(same('Foreign Education Documents along with Educational Credential Assessment', 'Foreign Education Documents along with Educational Credential Assessment (ECA)'), true);
  assert.equal(same('Current Employment Proof', 'Current Employment Proof (reference letter, paystubs, T4, NOA ...)'), true);
  assert.equal(same('Proof of work experience (Inside Canada)', 'Proof of work experience (Inside and Outside Canada)'), false);
  assert.equal(same('Passport with all stamped pages', 'Passport with all stamped pages- Old and New'), false);
  assert.equal(same('Photo', 'Photo - Front and Back both required'), false);
  assert.equal(same('', 'Photo'), false);
});

test('the sibling CEC Case Type (Profile+ITA+Submission), Single → Accompanying: all 11 of the principal\'s rows move — the ECA by its name without the "(ECA)" bracket', () => {
  const CT2 = 'Canadian Experience Class (Profile+ITA+Submission)';
  const rows = boardRowsFor(CT2, SINGLE, [PA]);
  const { moves, changed } = seeder.planVariantMigration({ rows, plan: planFor(CT2, ACC, [PA, SPOUSE]), caseRef: REF, caseType: CT2, caseSubType: ACC });
  assert.equal(moves.length, rows.length); assert.deepEqual(changed, []);
  assert.ok(moves.some((m) => m.by === 'base' && /FOREDU/.test(m.from.documentCode) && /FOREIGNEDU/.test(m.to.row.documentCode)));
});

test('every registered pair of Sub Types of one Case Type: a move never crosses people, never lands one row twice, and an uploaded row only ever moves onto the same requirement', () => {
  const byType = new Map();
  for (const r of css.listRegistered()) { if (!byType.has(r.caseType)) byType.set(r.caseType, []); byType.get(r.caseType).push(r.subType); }
  let pairs = 0, moved = 0;
  for (const [ct, subs] of byType) {
    for (const from of subs) for (const to of subs) {
      if (from === to) continue;
      const full = (st) => css.lookup(ct, st).roles.map((ro) => ({ role: ro.role, flags: {}, memberKey: ro.multipleAllowed ? 'x-1' : '' }));
      let rows, plan;
      try { rows = boardRowsFor(ct, from, full(from), { caseFlags: { spouseIncluded: true, childrenIncluded: true, parentsIncluded: true, siblingsIncluded: true, supporterIncluded: true } }); plan = planFor(ct, to, full(to)); }
      catch (_) { continue; }
      pairs++;
      const { moves } = seeder.planVariantMigration({ rows, plan, caseRef: REF, caseType: ct, caseSubType: to });
      moved += moves.length;
      assert.equal(new Set(moves.map((m) => m.to.uniqueKey)).size, moves.length, `${ct}: ${from} → ${to} lands one row twice`);
      for (const m of moves) {
        const fromRole = rows.find((r) => r.id === m.id);
        const slot = (x) => (x === 'Non Accompanying Spouse' ? 'Spouse' : x);
        assert.equal(slot(fromRole.applicantType), slot(m.to.row.applicantType), `${ct}: ${from} → ${to}: ${m.name} crosses people`);
        assert.ok(seeder.sameRequirement(m.ownerDocName || m.name, m.to.row.documentName), `${ct}: ${from} → ${to}: uploaded "${m.name}" onto "${m.to.row.documentName}"`);
      }
    }
  }
  assert.ok(pairs > 50 && moved > 500, `swept ${pairs} pairs, ${moved} moves`);
});

test('a "Not Applicable" row moves like an empty one (never two rows for one document): the decision is KEPT for the same document of the same person, CLEARED when the new Sub Type asks it of another role or words it differently', () => {
  // SOWP spouse "Canadian Education Documents" N/A (never studied here), Sub Type changed: same code, reworded → cleared
  const sowp = boardRowsFor('SOWP', 'Inland - Non Established Relationship', [PA, SPOUSE], { status: (p) => (p.role === 'Spouse' && /-CANEDU-/.test(p.documentCode) ? 'Not Applicable' : 'Received') });
  const r = seeder.planVariantMigration({ rows: sowp, plan: planFor('SOWP', 'Inland - Established Relationship', [PA, SPOUSE]), caseRef: REF, caseType: 'SOWP', caseSubType: 'Inland - Established Relationship' });
  const na = sowp.find((x) => x.status === 'Not Applicable');
  const m = r.moves.find((x) => x.id === na.id);
  assert.ok(m && m.naClear, 'moved, its Not Applicable cleared');
  assert.deepEqual(r.naCleared.map((x) => [x.id, x.person, x.why]), [[na.id, 'Spouse', 'wording']]);
  assert.ok(!r.changed.some((c) => c.id === na.id), 'never reported as an upload');
  // through the spouse alias: the non-accompanying spouse's N/A police certificate → the accompanying spouse's is asked for
  const cec = boardRowsFor(CEC, SINGLE, [PA, { role: 'NonAccompanyingSpouse', flags: {} }], { status: (p) => (p.role === 'NonAccompanyingSpouse' && /-PCC-/.test(p.documentCode) ? 'Not Applicable' : (/-SIBLINGPROOF-/.test(p.documentCode) ? 'Not Applicable' : 'Received')) });
  const c = seeder.planVariantMigration({ rows: cec, plan: planFor(CEC, ACC, [PA, SPOUSE]), caseRef: REF, caseType: CEC, caseSubType: ACC });
  const pcc = cec.find((x) => x.status === 'Not Applicable' && /-PCC-/.test(x.documentCode));
  const sib = cec.find((x) => x.status === 'Not Applicable' && /-SIBLINGPROOF-/.test(x.documentCode));
  assert.ok(c.moves.find((x) => x.id === pcc.id).naClear, 'the accompanying spouse\'s PCC is asked for');
  assert.deepEqual(c.naCleared.map((x) => [x.id, x.why]), [[pcc.id, 'role']]);
  assert.equal(c.moves.find((x) => x.id === sib.id).naClear, false, '"Sibling - Proof …" → "… (if applicable)": the same ask of the same person — kept');
  assert.deepEqual(c.naCarried.map((x) => x.id), [sib.id]);
  assert.equal(c.moves.length, 16, 'one row per document: 11 principal + 5 spouse');
});

test('the "asked for differently" list never sends staff to a document another moved row filled — only where the new row really asks; one entry per document', () => {
  const plan = seedPlan({ schema: SCHEMAS.New, composition: { caseFlags: {}, members: [PA] } });
  const photo = rowsOf('Old', [PA], 'Received').find((r) => /-PHOTO-/.test(r.documentCode));   // "Photo" → "Two photos", holds a file
  // a twin already marked Not Applicable for the same new wording is the one that moves (kept? no: reworded → cleared → it asks) …
  const naTwin = { ...photo, id: String(Number(photo.id) + 7), status: 'Not Applicable', name: 'Photo' };
  const a = seeder.planVariantMigration({ rows: [photo, naTwin], plan, caseRef: REF, caseType: T, caseSubType: 'New', registered, lookup });
  assert.deepEqual(a.moves.map((m) => [m.id, m.naClear]), [[naTwin.id, true]]);
  assert.deepEqual(a.changed.map((x) => x.id), [photo.id], 'the cleared row asks the client, so the upload left behind is worth a look');
  // … but an upload from another Sub Type under the SAME wording fills the document: nothing to ask, nothing listed
  const mid = rowsOf('Mid', [PA], 'Received').find((r) => /-PHOTO-/.test(r.documentCode));   // "Two photos" already
  const b = seeder.planVariantMigration({ rows: [photo, mid], plan, caseRef: REF, caseType: T, caseSubType: 'New', registered, lookup });
  assert.deepEqual(b.moves.map((m) => m.id), [mid.id]);
  assert.deepEqual(b.changed, [], 'the new document holds the client\'s file — never "a new row asks"');
  // two uploads left behind for one document → one entry
  const twin = { ...photo, id: String(Number(photo.id) + 3) };
  const t2 = seeder.planVariantMigration({ rows: [photo, twin], plan, caseRef: REF, caseType: T, caseSubType: 'New', registered, lookup });
  assert.equal(t2.changed.length, 1);
});

test('an EMPTY moved row takes the new category only together with its folder link (no link at hand → category and link stay as they were)', async () => {
  const kid = rowsOf('Old', kids, 'Missing').find((r) => /DEPENDENTCHILD1-BIRTH/.test(r.documentCode));
  const fb = fakeBoard([kid]);
  const realLookup = css.lookup, realList = css.listRegistered;
  css.lookup = lookup; css.listRegistered = () => registered;
  try {
    const plan = seedPlan({ schema: SCHEMAS.New, composition: { caseFlags: {}, members: kids } });
    const r = await seeder.reconcileExecutionRows({ caseRef: REF, caseType: T, caseSubType: 'New', clientMasterItemId: '1', plan, categoryLinks: {}, prune: false });
    assert.equal(r.migrated, 1);
    const c = fb.calls.moves[0].cols;
    assert.ok(!(C.documentCategory in c) && !(C.documentFolder in c), 'OneDrive folders failed: the row keeps a category and link that agree');
  } finally { fb.restore(); css.lookup = realLookup; css.listRegistered = realList; }
});

test('the "Checklist moved" note: names each document to check, the upload ones and the Not Applicable ones, in plain words', () => {
  const { variantCheckNote } = require('../src/services/checklistService')._internal;
  const n = variantCheckNote({ caseRef: REF, subType: ACC, migrated: 15, migratedFrom: [SINGLE],
    changed: [{ from: 'Photo', to: 'Photo - Front and Back both required', person: 'Principal Applicant' }],
    naCleared: [{ to: 'Police clearance certificates (PCC)', person: 'Spouse', why: 'role', reason: require('../src/services/documentNotApplicable').reasonText('Non-accompanying, not needed', 'Gauri') }],
    naCarried: [{ to: 'Sibling- Proof of living in Canada (if applicable)', person: 'Principal Applicant' }] });
  assert.match(n, /Checklist moved to Sub Type "CEC Accompanying Spouse &amp; Child" — 3 document\(s\) to check/);
  assert.match(n, /15 row\(s\) of "CEC Single Applicant" were moved over to the new Sub Type's documents \(uploads and notes kept; the Not Applicable decisions listed below were cleared\)\. Please check:/);
  assert.match(n, /Asked for differently now<\/b> — the client's upload stays on its old row and a new row asks for the new version\. If the upload already covers it, mark the new row Not Applicable with a note saying so; otherwise the client uploads the new version: "Photo" → "Photo - Front and Back both required" \(Principal Applicant\)\./);
  assert.match(n, /Not Applicable cleared<\/b> — the new Sub Type asks for these of a person in a different capacity \(e\.g\. accompanying instead of non-accompanying\) or in different words or as required instead of optional, so they are on the checklist again\. Mark one Not Applicable again if it still does not apply: "Police clearance certificates \(PCC\)" \(Spouse\) — earlier reason: "Non-accompanying, not needed"/);
  assert.match(n, /Still Not Applicable<\/b> — the same document for the same person, so the decision was kept; check it still holds under the new Sub Type: "Sibling- Proof of living in Canada \(if applicable\)" \(Principal Applicant\)\./);
  const only = variantCheckNote({ caseRef: REF, subType: ACC, changed: [{ from: 'A', to: 'B' }] });
  assert.doesNotMatch(only, /Not Applicable cleared|Still Not Applicable|were moved over/, 'nothing moved: never says so');
});

test('clearing a Not Applicable on the move is the "Applies again" write: back to Missing (Received + Review Required when a file was ever uploaded), the reason emptied, a note on the row with the old reason', async () => {
  const na = require('../src/services/documentNotApplicable');
  const reasonCol = na.reasonColumnId();
  assert.ok(reasonCol, 'the reason column is configured');
  const rows = boardRowsFor(CEC, SINGLE, [PA, { role: 'NonAccompanyingSpouse', flags: {} }], { status: (p) => (p.role === 'NonAccompanyingSpouse' && /-(PCC|PHOTO)-/.test(p.documentCode) ? 'Not Applicable' : 'Received') });
  const pcc = rows.find((x) => /NONACCOMPANYINGSPOUSE-PCC/.test(x.documentCode));
  const photo = rows.find((x) => /NONACCOMPANYINGSPOUSE-PHOTO/.test(x.documentCode));
  const fb = fakeBoard(rows.map((r) => (r.id === photo.id ? { ...r, uploadDate: '2026-09-01' } : r)), { reasons: { [pcc.id]: na.reasonText('Non-accompanying, not needed', 'Gauri'), [photo.id]: na.reasonText('Not needed', 'Gauri') } });
  try {
    const r = await reconcile(planFor(CEC, ACC, [PA, SPOUSE]), { prune: false });
    assert.equal(r.naCleared.length, 2);
    const pc = fb.calls.moves.find((m) => m.id === pcc.id).cols;
    assert.deepEqual(pc.color_mm0zwgvr, { label: 'Missing' }); assert.equal(pc[reasonCol], ''); assert.ok(!('color_mm0z796e' in pc));
    const ph = fb.calls.moves.find((m) => m.id === photo.id).cols;
    assert.deepEqual(ph.color_mm0zwgvr, { label: 'Received' }); assert.deepEqual(ph.color_mm0z796e, { label: 'Yes' });
    const note = fb.calls.updates.find((u) => u.i === pcc.id);
    assert.match(note.b, /Not Applicable cleared by the Sub Type change<\/b> — the Case Sub Type is now "CEC Accompanying Spouse &amp; Child", which asks for this document of the Spouse in a different capacity\. It is back on the checklist as "Missing"\. The earlier reason was: "Non-accompanying, not needed"\./);
    // the other moved rows keep their status
    assert.ok(fb.calls.moves.filter((m) => ![pcc.id, photo.id].includes(m.id)).every((m) => !('color_mm0zwgvr' in m.cols)));
  } finally { fb.restore(); }
});

test('a Not Applicable decision is kept only for the very same ask: a non-accompanying child who now comes along, or an optional document now required, gets it cleared', () => {
  // CEC (Profile Recreation): the same role key "DependentChild" is the "Non-Accompanying Child" in Single, the "Dependent Child" in Accompanying
  const CT3 = 'Canadian Experience Class (Profile Recreation+ITA+Submission)';
  const child = { role: 'DependentChild', flags: {}, memberKey: 'child-1' };
  const rows = boardRowsFor(CT3, SINGLE, [PA, child], { status: (p) => (p.role === 'DependentChild' ? 'Not Applicable' : 'Received') });
  const kidRows = rows.filter((r) => r.status === 'Not Applicable');
  assert.ok(kidRows.length > 0);
  const r = seeder.planVariantMigration({ rows, plan: planFor(CT3, ACC, [PA, child]), caseRef: REF, caseType: CT3, caseSubType: ACC });
  const movedKids = r.moves.filter((m) => kidRows.some((k) => k.id === m.id));
  assert.ok(movedKids.length > 0 && movedKids.every((m) => m.naClear), 'the accompanying child is asked for them');
  assert.ok(r.naCleared.every((x) => x.why === 'role')); assert.deepEqual(r.naCarried, []);
  // Visitor Visa: "Financial Documents (optional — case-manager decision)" → the required "Financial Documents"
  const VV = 'Visitor Visa';
  const vv = boardRowsFor(VV, 'Spousal Sponsorship in Process', [PA], { status: (p) => (/-PRINCIPALAPPLICANT-FINDOCS-/.test(p.documentCode) ? 'Not Applicable' : 'Received') });
  const fin = vv.find((x) => x.status === 'Not Applicable');
  const v = seeder.planVariantMigration({ rows: vv, plan: planFor(VV, 'Spouse', [PA]), caseRef: REF, caseType: VV, caseSubType: 'Spouse' });
  const fm = v.moves.find((m) => m.id === fin.id);
  assert.ok(fm && fm.naClear, 'optional before, required now: cleared');
  // label wording that does not change the capacity keeps the decision (AAIP "Dependent Spouse" / "Spouse / Common-Law Partner")
  assert.equal(require('../src/services/executionSeederService').sameRequirement('Financial Documents', 'Financial Documents'), true);
});
