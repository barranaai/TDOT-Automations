'use strict';

// Careful cascading delete (admin-only): preview enumerates before anything is
// touched, execute re-enumerates + requires the typed confirmation + the
// previewed kind, children go before parents, parents are KEPT when any child
// fails (re-runnable), targets are board-pinned, stored folder ids are
// root-scoped, and concurrent runs on one target are refused.

const test   = require('node:test');
const assert = require('node:assert/strict');

const deletion    = require('../src/services/deletionService');
const mondayApi   = require('../src/services/mondayApi');
const leadService = require('../src/services/leadService');
const oneDrive    = require('../src/services/oneDriveService');
const clientMaster = require('../src/services/clientMasterService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const LEAD_BOARD = '18416845157', CM_BOARD = '18401523447';
const EXEC = '18401875593', QEXEC = '18402117488', FAMILY = '18415615177';
const ROOT = '/drive/root:/Client Documents';

// A mondayApi router. items(ids) queries are answered from `itemBoards`
// (id → board id) and, when the query wants column_values, from `cm`.
// delete_item handles BOTH the aliased-batch form (ids inline in the query)
// and the per-item fallback form (vars.id).
function mondayStub({ cm, rowsByBoard = {}, itemBoards = {}, failBatchContaining = [], failItemIds = [] } = {}) {
  const deleted = [];
  const fn = async (q, vars) => {
    if (/delete_item/.test(q)) {
      if (vars && vars.id) {
        const id = String(vars.id);
        if (failItemIds.includes(id)) throw new Error(`boom ${id}`);
        deleted.push(id);
        return { delete_item: { id } };
      }
      const ids = [...q.matchAll(/delete_item\(item_id:\s*(\d+)\)/g)].map((m) => m[1]);
      if (ids.some((id) => failBatchContaining.includes(id))) throw new Error('batch boom');
      deleted.push(...ids);
      return {};
    }
    if (/items_page_by_column_values/.test(q)) {
      return { items_page_by_column_values: { items: rowsByBoard[String(vars.b)] || [] } };
    }
    if (/items\(ids/.test(q)) {
      const id = String(vars.id);
      if (/column_values/.test(q)) {
        if (!cm || id !== String(cm.id)) return { items: [] };
        return { items: [{ id: cm.id, name: cm.name, board: { id: cm.boardId || CM_BOARD }, column_values: [
          { id: 'text_mm142s49', text: cm.caseRef },
          { id: 'text_mm0xw6bp', text: cm.email || '' },
          { id: 'text_mm47y540', text: cm.oneDriveFolderId || '' },
        ] }] };
      }
      const b = itemBoards[id];
      return b ? { items: [{ id, board: { id: b } }] } : { items: [] };
    }
    return {};
  };
  return { fn, deleted };
}

test('preview (case-less lead): lead row + root-scoped lead folder, confirm word is DELETE', async () => {
  const m = mondayStub({ itemBoards: { 500: LEAD_BOARD } });
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'getLead', async () => ({ id: '500', fullName: 'Solo Lead', email: 's@x.co', clientMasterItemId: '', oneDriveFolderId: 'od-lead-1' })),
    stub(oneDrive, 'getDriveItemById', async () => ({ id: 'od-lead-1', name: 'Solo Lead - LEAD-500', parentPath: ROOT })),
    stub(oneDrive, 'getClientFolderByName', async () => null),
  ];
  try {
    const p = await deletion.previewDeletion({ leadId: '500' });
    assert.equal(p.kind, 'lead');
    assert.equal(p.confirmText, 'DELETE');
    assert.equal(p.targets.clientMasterRow, 0);
    assert.deepEqual(p.targets.leadRows, ['Solo Lead']);
    assert.deepEqual(p.targets.oneDriveFolders, ['Solo Lead - LEAD-500'], 'the REAL folder name is shown, never an opaque id');
    assert.ok(p.warnings.some((w) => /Documenso/.test(w)), 'says envelopes are not deleted');
  } finally { restore.forEach((x) => x()); }
});

test('preview ESCALATES: a lead with a Client Master case previews the FULL case cascade', async () => {
  const m = mondayStub({
    cm: { id: '900', name: 'Cased Client', caseRef: '2026-VV-042', email: 'c@x.co', oneDriveFolderId: 'od-cm-1' },
    itemBoards: { 500: LEAD_BOARD },
    rowsByBoard: {
      [EXEC]:   [{ id: '1', name: 'Passport' }, { id: '2', name: 'Photo' }],
      [QEXEC]:  [{ id: '3', name: 'Q1' }],
      [FAMILY]: [{ id: '4', name: 'Spouse' }],
    },
  });
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'getLead', async () => ({ id: '500', fullName: 'Cased Client', clientMasterItemId: '900' })),
    stub(leadService, 'findAllByColumnValue', async () => ([{ id: '500', fullName: 'Cased Client', oneDriveFolderId: '' }])),
    stub(oneDrive, 'getDriveItemById', async () => ({ id: 'od-cm-1', name: 'Cased Client - 2026-VV-042', parentPath: ROOT })),
    stub(oneDrive, 'getClientFolderByName', async () => null),
  ];
  try {
    const p = await deletion.previewDeletion({ leadId: '500' });
    assert.equal(p.kind, 'case', 'lead delete must escalate — never orphan a case');
    assert.equal(p.confirmText, '2026-VV-042', 'cases confirm by typing the case ref');
    assert.equal(p.targets.clientMasterRow, 1);
    assert.equal(p.targets.checklistRows, 2);
    assert.equal(p.targets.questionnaireRows, 1);
    assert.equal(p.targets.familyMemberRows, 1);
    assert.deepEqual(p.targets.leadRows, ['Cased Client']);
  } finally { restore.forEach((x) => x()); }
});

// Review finding: a fresh CM has a BLANK ref (webhook latency / rejected case
// type) — the confirmation must pin to the item, never degrade to 'DELETE'.
test('blank-caseRef case: confirmation pins to CASE-{cmItemId}, and DELETE is rejected', async () => {
  const m = mondayStub({
    cm: { id: '900', name: 'Fresh Case', caseRef: '', oneDriveFolderId: '' },
    itemBoards: { 500: LEAD_BOARD },
  });
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'getLead', async () => ({ id: '500', fullName: 'Fresh Case', clientMasterItemId: '900' })),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(oneDrive, 'getClientFolderByName', async () => null),
  ];
  try {
    const p = await deletion.previewDeletion({ leadId: '500' });
    assert.equal(p.kind, 'case');
    assert.equal(p.confirmText, 'CASE-900');
    await assert.rejects(
      () => deletion.executeDeletion({ leadId: '500', confirmText: 'DELETE' }),
      (e) => e.badRequest === true && /does not match/.test(e.message),
      'the generic word DELETE must never authorise a case cascade');
    assert.equal(m.deleted.length, 0);
  } finally { restore.forEach((x) => x()); }
});

// Review finding: the lead→case escalation RACE — preview said lead, the
// client signed meanwhile, execute rebuilds a case graph. The echoed kind
// must refuse the execute instead of silently widening the scope.
test('kind echo: execute refuses when the record escalated after the preview', async () => {
  const m = mondayStub({
    cm: { id: '900', name: 'Raced Client', caseRef: '', oneDriveFolderId: '' },
    itemBoards: { 500: LEAD_BOARD },
  });
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'getLead', async () => ({ id: '500', fullName: 'Raced Client', clientMasterItemId: '900' })),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(oneDrive, 'getClientFolderByName', async () => null),
  ];
  try {
    await assert.rejects(
      () => deletion.executeDeletion({ leadId: '500', confirmText: 'DELETE', expectedKind: 'lead' }),
      (e) => e.badRequest === true && /changed since the preview/.test(e.message));
    assert.equal(m.deleted.length, 0, 'nothing deleted on a kind mismatch');
  } finally { restore.forEach((x) => x()); }
});

// Review finding: items(ids) is account-global — a pasted id from ANY Monday
// board must not be deletable as a "lead".
test('board pinning: an item that is not on the Lead Board is refused', async () => {
  const m = mondayStub({ itemBoards: { 777: CM_BOARD } });
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'getLead', async () => ({ id: '777', fullName: 'Actually A Case Row' })),
  ];
  try {
    await assert.rejects(
      () => deletion.previewDeletion({ leadId: '777' }),
      (e) => e.badRequest === true && /not on the Lead Board/.test(e.message));
    assert.equal(m.deleted.length, 0);
  } finally { restore.forEach((x) => x()); }
});

// Review finding: a stored folder id is staff-editable — a wrong-but-valid id
// (another client's folder, or the root itself) must be refused.
test('stored folder id outside Client Documents root is refused with a warning', async () => {
  const m = mondayStub({ itemBoards: { 500: LEAD_BOARD } });
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'getLead', async () => ({ id: '500', fullName: 'Lead X', clientMasterItemId: '', oneDriveFolderId: 'od-root!' })),
    stub(oneDrive, 'getDriveItemById', async () => ({ id: 'od-root!', name: 'Client Documents', parentPath: '/drive/root:' })),
    stub(oneDrive, 'getClientFolderByName', async () => null),
  ];
  try {
    const p = await deletion.previewDeletion({ leadId: '500' });
    assert.deepEqual(p.targets.oneDriveFolders, [], 'the out-of-root item is NOT a delete target');
    assert.ok(p.warnings.some((w) => /refusing to touch it/.test(w)));
  } finally { restore.forEach((x) => x()); }
});

test('execute: wrong confirmation text → badRequest, NOTHING deleted', async () => {
  const m = mondayStub({
    cm: { id: '900', name: 'C', caseRef: '2026-VV-042' },
    rowsByBoard: { [EXEC]: [{ id: '1', name: 'X' }] },
  });
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(clientMaster, 'findItemByCaseRef', async () => '900'),
    stub(oneDrive, 'getClientFolderByName', async () => null),
    stub(oneDrive, 'deleteDriveItem', async () => { throw new Error('must not be called'); }),
  ];
  try {
    await assert.rejects(
      () => deletion.executeDeletion({ caseRef: '2026-VV-042', confirmText: 'delete' }),
      (e) => e.badRequest === true && /does not match/.test(e.message));
    assert.equal(m.deleted.length, 0, 'no Monday row was touched');
  } finally { restore.forEach((x) => x()); }
});

test('execute (case): children before parents, folders removed, honest summary', async () => {
  const m = mondayStub({
    cm: { id: '900', name: 'Full Client', caseRef: '2026-VV-042', oneDriveFolderId: 'od-cm-1' },
    rowsByBoard: {
      [EXEC]:   [{ id: '1', name: 'Passport' }],
      [QEXEC]:  [{ id: '3', name: 'Q1' }],
      [FAMILY]: [{ id: '4', name: 'Spouse' }],
    },
  });
  const droppedFolders = [];
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'findAllByColumnValue', async () => ([{ id: '500', fullName: 'Full Client' }])),
    stub(clientMaster, 'findItemByCaseRef', async () => '900'),
    stub(oneDrive, 'getDriveItemById', async () => ({ id: 'od-cm-1', name: 'Full Client - 2026-VV-042', parentPath: ROOT })),
    stub(oneDrive, 'getClientFolderByName', async (name) => (name === 'Full Client - LEAD-500' ? { id: 'od-lead-x', name } : null)),
    stub(oneDrive, 'deleteDriveItem', async (id) => { droppedFolders.push(id); return true; }),
  ];
  try {
    const r = await deletion.executeDeletion({ caseRef: '2026-VV-042', confirmText: '2026-VV-042', expectedKind: 'case' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.deleted, {
      checklistRows: 1, questionnaireRows: 1, familyMemberRows: 1,
      clientMasterRow: 1, leadRows: 1, oneDriveFolders: 2,
    });
    assert.deepEqual(m.deleted, ['1', '3', '4', '900', '500'], 'children first, CM before lead');
    assert.deepEqual(droppedFolders.sort(), ['od-cm-1', 'od-lead-x'], 'stored-id folder AND orphaned LEAD folder both removed');
  } finally { restore.forEach((x) => x()); }
});

// Review finding: deleting the CM row after child failures strands orphans the
// tool can never target again. Parents must be KEPT so a re-run works.
test('execute: a child-row failure KEEPS the CM row, leads and folders (re-runnable)', async () => {
  const m = mondayStub({
    cm: { id: '900', name: 'C', caseRef: '2026-VV-042' },
    rowsByBoard: { [EXEC]: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] },
    failBatchContaining: ['1'],  // the batch fails → per-item fallback
    failItemIds: ['1'],          // …and row 1 fails there too
  });
  let folderDeleted = false;
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'findAllByColumnValue', async () => ([{ id: '500', fullName: 'C' }])),
    stub(clientMaster, 'findItemByCaseRef', async () => '900'),
    stub(oneDrive, 'getClientFolderByName', async () => null),
    stub(oneDrive, 'deleteDriveItem', async () => { folderDeleted = true; return true; }),
  ];
  try {
    const r = await deletion.executeDeletion({ caseRef: '2026-VV-042', confirmText: '2026-VV-042' });
    assert.equal(r.ok, false, 'partial failure must not report clean success');
    assert.equal(r.deleted.checklistRows, 1, 'the second row still went');
    assert.equal(r.deleted.clientMasterRow, 0, 'CM row KEPT — a re-run by caseRef stays possible');
    assert.equal(r.deleted.leadRows, 0, 'lead rows kept too');
    assert.equal(folderDeleted, false, 'folders kept too');
    assert.ok(r.failures.some((f) => /boom 1/.test(f)));
    assert.ok(r.failures.some((f) => /KEPT/.test(f)), 'summary explains the parents were kept');
    assert.ok(!m.deleted.includes('900') && !m.deleted.includes('500'));
  } finally { restore.forEach((x) => x()); }
});

test('concurrency: a second execute on the same target while one runs → refused', async () => {
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  const m = mondayStub({
    cm: { id: '900', name: 'C', caseRef: '2026-VV-042' },
    rowsByBoard: {},
  });
  const slowFn = async (q, vars) => { await gate; return m.fn(q, vars); };
  const restore = [
    stub(mondayApi, 'query', slowFn),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(clientMaster, 'findItemByCaseRef', async () => '900'),
    stub(oneDrive, 'getClientFolderByName', async () => null),
    stub(oneDrive, 'deleteDriveItem', async () => true),
  ];
  try {
    const first = deletion.executeDeletion({ caseRef: '2026-VV-042', confirmText: '2026-VV-042' });
    await new Promise((r) => setTimeout(r, 20)); // let the first take the lock
    await assert.rejects(
      () => deletion.executeDeletion({ caseRef: '2026-VV-042', confirmText: '2026-VV-042' }),
      (e) => e.badRequest === true && /already running/.test(e.message));
    releaseFirst();
    await first;
  } finally { restore.forEach((x) => x()); }
});

test('preview by caseRef: unknown reference → badRequest', async () => {
  const restore = [stub(clientMaster, 'findItemByCaseRef', async () => null)];
  try {
    await assert.rejects(
      () => deletion.previewDeletion({ caseRef: '2026-XX-999' }),
      (e) => e.badRequest === true && /No case found/.test(e.message));
  } finally { restore.forEach((x) => x()); }
});

test('folder lookup failure degrades to a warning — the Monday delete still previews', async () => {
  const m = mondayStub({
    cm: { id: '900', name: 'C', caseRef: '2026-VV-042' },
    rowsByBoard: {},
  });
  const restore = [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'findAllByColumnValue', async () => []),
    stub(clientMaster, 'findItemByCaseRef', async () => '900'),
    stub(oneDrive, 'getClientFolderByName', async () => { throw new Error('graph down'); }),
  ];
  try {
    const p = await deletion.previewDeletion({ caseRef: '2026-VV-042' });
    assert.equal(p.targets.clientMasterRow, 1);
    assert.ok(p.warnings.some((w) => /manual removal/.test(w)), 'warns that the folder needs manual cleanup');
  } finally { restore.forEach((x) => x()); }
});
