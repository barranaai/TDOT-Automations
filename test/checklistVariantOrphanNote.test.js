'use strict';

// A re-seed after a Sub Type change that only MOVES rows (creates none) must
// still warn staff when a family member on the board has no documents in the
// new Sub Type (review of 9a4fa3c: the warning was gated on created > 0).

const test   = require('node:test');
const assert = require('node:assert/strict');

// OneDrive folders + questionnaire pre-fill stubbed BEFORE checklistService loads (it destructures them)
const oneDrive = require('../src/services/oneDriveService');
oneDrive.createClientFolders = async () => ({});
require('../src/services/htmlQuestionnaireService').seedQuestionnairePrefill = async () => {};

const mondayApi = require('../src/services/mondayApi');
const seeder = require('../src/services/executionSeederService');
const { seedPlan } = require('../src/services/seedPlanner');
const css = require('../src/services/caseSchemaService');
const { clientMasterBoardId } = require('../config/monday');
const checklist = require('../src/services/checklistService');
const C = seeder._cols;

const REF = '2026-VV-099', CM_ID = '555';
let seq = 1000;
const rowsFor = (caseType, subType, members) => seedPlan({ schema: css.lookup(caseType, subType), composition: { caseFlags: {}, members } }).map((p) => ({
  id: String(++seq), name: p.documentName, uniqueKey: `${REF}-${p.documentCode}`, documentCode: p.documentCode, intake: `code:${p.documentCode}`,
  subType, applicantType: p.applicantType, category: p.category, templateRel: '', status: 'Missing',
}));

function fakeMonday(rows, cm) {
  const board = rows.map((r) => ({ ...r }));
  const calls = { notes: [], moves: 0, creates: 0, deletes: 0 };
  const created = new Set();
  // As Monday answers: a link cell's text and value are null; its ids come
  // only when the query asks through the typed fragment.
  const cv = (r, ids, q = '') => ids.map((id) => {
    if (id === 'board_relation_mm0zhagw') return { id, text: null, value: null, ...(/on BoardRelationValue/.test(q) ? { linked_item_ids: r.templateRel ? ['1'] : [] } : {}) };
    const map = { [C.uniqueKey]: r.uniqueKey, [C.documentCode]: r.documentCode, [C.intakeItemId]: r.intake, [C.caseSubType]: r.subType, [C.applicantType]: r.applicantType, [C.documentCategory]: r.category, color_mm0zwgvr: r.status };
    return { id, text: map[id] == null ? '' : map[id], value: null };
  });
  const real = mondayApi.query;
  mondayApi.query = async (q, v = {}) => {
    if (/create_update/.test(q)) { calls.notes.push(v.body); return { create_update: { id: '1' } }; }
    if (/delete_item/.test(q)) { calls.deletes++; const i = board.findIndex((r) => r.id === String(v.id)); if (i >= 0) board.splice(i, 1); return { delete_item: { id: v.id } }; }
    if (/create_item/.test(q)) {
      const id = String(900000 + calls.creates++); const cols = JSON.parse(v.cols); created.add(id);
      board.push({ id, name: v.name, uniqueKey: cols[C.uniqueKey], documentCode: cols[C.documentCode], intake: cols[C.intakeItemId], subType: cols[C.caseSubType], applicantType: cols[C.applicantType], category: cols[C.documentCategory], templateRel: '', status: '' });
      return { create_item: { id } };
    }
    if (/change_multiple_column_values/.test(q)) {
      const id = String(v.itemId || v.i || '');
      if (id === CM_ID || created.has(id) || !board.some((x) => x.id === id)) return { change_multiple_column_values: { id: id || CM_ID } };
      const cols = JSON.parse(v.cols); calls.moves++;
      Object.assign(board.find((x) => x.id === id), { uniqueKey: cols[C.uniqueKey], documentCode: cols[C.documentCode], intake: cols[C.intakeItemId], subType: cols[C.caseSubType] });
      return { change_multiple_column_values: { id } };
    }
    if (/items_page_by_column_values/.test(q)) {
      if (String(v.boardId) === String(clientMasterBoardId)) return { items_page_by_column_values: { items: [{ id: CM_ID, name: 'Test Client', column_values: [{ id: 'dropdown_mm0xd1qn', text: cm.caseType }, { id: 'dropdown_mm0x4t91', text: cm.subType }] }] } };
      if (/getExistingItems/.test(q)) return { items_page_by_column_values: { items: board.map((r) => ({ column_values: cv(r, [C.uniqueKey]) })) } };
      if (q.includes(C.documentCode)) return { items_page_by_column_values: { items: board.map((r) => ({ id: r.id, name: r.name, column_values: cv(r, [C.uniqueKey, C.documentCode, C.intakeItemId, C.caseSubType, C.applicantType, C.documentCategory, 'board_relation_mm0zhagw', 'color_mm0zwgvr'], q) })) } };
      return { items_page_by_column_values: { items: board.map((r) => ({ id: r.id, column_values: cv(r, [C.caseSubType, C.uniqueKey, C.intakeItemId, 'board_relation_mm0zhagw', 'color_mm0zwgvr'], q) })) } };
    }
    if (/items\s*\(ids/.test(q)) return { items: [{ id: CM_ID, column_values: [] }] };
    throw new Error('unexpected query: ' + q.slice(0, 100));
  };
  return { board, calls, restore: () => { mondayApi.query = real; } };
}

const PA = { role: 'PrincipalApplicant', flags: {} };
const SP = { role: 'Spouse', flags: {}, memberKey: 'spouse' };
const CH = { role: 'DependentChild', flags: {}, memberKey: 'child-1' };
const INV = { role: 'Sponsor', flags: {}, memberKey: 'sponsor' };

test('a Sub Type change that drops a family member\'s role and only MOVES rows still posts "Family members not covered" — once', async () => {
  const VV = 'Visitor Visa';
  assert.ok(css.lookup(VV, '1-3 Members') && css.lookup(VV, '1-2 Members'), 'the Visitor Visa variants this test uses');
  const members = [PA, SP, CH, INV];
  const fm = fakeMonday(rowsFor(VV, '1-3 Members', members), { caseType: VV, subType: '1-2 Members' });
  try {
    const r = await checklist.reseedByCaseRef(REF, { composition: { caseFlags: {}, members } });
    assert.equal(r.created, 0, 'every document of the smaller variant was already there under the old one');
    assert.ok(r.migrated > 0);
    assert.equal(fm.calls.notes.filter((b) => /Family members not covered by this checklist/.test(b)).length, 1, 'the dropped child is named to staff');
    // the next re-seed does nothing → no second note
    const again = await checklist.reseedByCaseRef(REF, { composition: { caseFlags: {}, members } });
    assert.deepEqual([again.created, again.migrated], [0, 0]);
    assert.equal(fm.calls.notes.filter((b) => /Family members not covered by this checklist/.test(b)).length, 1);
  } finally { fm.restore(); }
});

test('every seeding path tells staff what the move left to check: the "Checklist moved" note comes from the seed itself (once — the next run has nothing to list)', async () => {
  const PG = 'PGWP';
  const rows = rowsFor(PG, 'Single Applicant', [PA]).map((r) => (/-PASSPORT-/.test(r.documentCode) ? { ...r, status: 'Reviewed' } : /-PHOTO-|-IDCIVIL|-PERMITS-/.test(r.documentCode) ? { ...r, status: 'Not Applicable' } : r));
  const fm = fakeMonday(rows, { caseType: PG, subType: 'Extension - Single Applicant' });
  try {
    const r = await checklist.reseedByCaseRef(REF, { composition: { caseFlags: {}, members: [PA] } });
    assert.ok(r.changed.length >= 1, 'the reviewed passport is asked for differently ("- Old and New")');
    const notes = fm.calls.notes.filter((b) => /Checklist moved to Sub Type/.test(b));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /"Passport with all stamped pages" → "Passport with all stamped pages- Old and New"/);
    if (r.naCleared.length) assert.match(notes[0], /Not Applicable cleared/);
    if (r.naCarried.length) assert.match(notes[0], /Still Not Applicable/);
    assert.ok(r.naCleared.length + r.naCarried.length > 0, 'the Not Applicable rows moved too (one row per document)');
    await checklist.reseedByCaseRef(REF, { composition: { caseFlags: {}, members: [PA] } });
    assert.equal(fm.calls.notes.filter((b) => /Checklist moved to Sub Type/.test(b)).length, 1, 'not again');
  } finally { fm.restore(); }
});
