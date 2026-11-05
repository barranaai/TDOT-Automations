'use strict';

// Team meeting point 8 (Faran 2026-11-05): "the consultation record is kept forever".
// Deleting a case from the Cases page keeps the consultation record (the lead row) — unlinked from the case and
// marked "Case deleted" — and deletes nothing from OneDrive: the case folder is renamed back to the lead's
// "{name} - LEAD-{id}" so the record still finds its files. While "Case deleted" is set, nothing opens a new case
// for the lead by itself (a signed date, Mark retainer signed, the payment request, the status sync).
// The bins on the lists (a LEAD with a case) still delete everything — that is the explicit "delete the record".

const test   = require('node:test');
const assert = require('node:assert/strict');

const deletion     = require('../src/services/deletionService');
const mondayApi    = require('../src/services/mondayApi');
const leadService  = require('../src/services/leadService');
const oneDrive     = require('../src/services/oneDriveService');
const clientMaster = require('../src/services/clientMasterService');
const allocator    = require('../src/services/caseRefAllocator');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
allocator.recordAssigned = async () => true;   // OneDrive in production; an in-memory yes here

const LEAD_BOARD = '18416845157', CM_BOARD = '18401523447';
const EXEC = '18401875593', QEXEC = '18402117488', FAMILY = '18415615177';
const ROOT = '/drive/root:/Client Documents';
const CASE = '2026-VV-042';

/** A Monday router: deletes recorded, child rows by board, the CM row (with state), board pinning, notes recorded. */
function world({ cm = { id: '900', name: 'Full Client', caseRef: CASE, oneDriveFolderId: 'od-cm-1' }, cmState = 'active', rowsByBoard = {}, itemBoards = {}, failItemIds = [] } = {}) {
  const deleted = [], notes = [];
  const fn = async (q, vars) => {
    if (/create_update/.test(q)) { notes.push({ id: String(vars.id), body: vars.b || vars.body }); return { create_update: { id: 'u1' } }; }
    if (/delete_item/.test(q)) {
      if (vars && vars.id) { const id = String(vars.id); if (failItemIds.includes(id)) throw new Error(`boom ${id}`); deleted.push(id); return {}; }
      const ids = [...q.matchAll(/delete_item\(item_id:\s*(\d+)\)/g)].map((m) => m[1]);
      if (ids.some((id) => failItemIds.includes(id))) throw new Error('batch boom');
      deleted.push(...ids); return {};
    }
    if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: rowsByBoard[String(vars.b)] || [] } };
    if (/items\(ids/.test(q)) {
      const id = String(vars.id);
      if (/column_values/.test(q)) {
        if (!cm || id !== String(cm.id)) return { items: [] };
        return { items: [{ id: cm.id, name: cm.name, state: cmState, board: { id: CM_BOARD }, column_values: [
          { id: 'text_mm142s49', text: cm.caseRef }, { id: 'text_mm0xw6bp', text: cm.email || '' }, { id: 'text_mm47y540', text: cm.oneDriveFolderId || '' },
        ] }] };
      }
      const b = itemBoards[id];
      return b ? { items: [{ id, board: { id: b } }] } : { items: [] };
    }
    return {};
  };
  return { fn, deleted, notes };
}

/** A lead store: getLead / updateLead / findAllByColumnValue over one or more leads. */
function leads(rows) {
  const store = new Map(rows.map((l) => [String(l.id), { ...l }]));
  const writes = [];
  return {
    store, writes,
    getLead: async (id) => (store.has(String(id)) ? { ...store.get(String(id)) } : null),
    updateLead: async (id, f, o) => { writes.push({ id: String(id), f, o }); const cur = store.get(String(id)) || {}; Object.assign(cur, f); (o && o.clearKeys || []).forEach((k) => { cur[k] = ''; }); store.set(String(id), cur); },
    findAll: async (key, val) => [...store.values()].filter((l) => String(l[key] || '') === String(val)).map((l) => ({ ...l })),
  };
}

const CHILDREN = { [EXEC]: [{ id: '1', name: 'Passport' }], [QEXEC]: [{ id: '3', name: 'Q1' }], [FAMILY]: [{ id: '4', name: 'Spouse' }] };

function stubs(m, L, extra = []) {
  return [
    stub(mondayApi, 'query', m.fn),
    stub(leadService, 'findAllByColumnValue', L.findAll),
    stub(leadService, 'getLead', L.getLead),
    stub(leadService, 'updateLead', L.updateLead),
    stub(clientMaster, 'findItemByCaseRef', async () => '900'),
    ...extra,
  ];
}


/** An in-memory OneDrive root ("Client Documents"): the lookups the delete uses, and the rename. */
function drive(folders, { fail = '' } = {}) {
  const root = folders.map((f) => ({ ...f }));
  const renamed = [], dropped = [];
  const boom = (what) => { if (fail === what || fail === 'all') throw new Error('graph 503'); };
  return {
    root, renamed, dropped,
    stubs: () => [
      stub(oneDrive, 'findCaseFoldersByRef', async (ref) => { boom('byRef'); return root.filter((f) => f.name.endsWith(` - ${ref}`)).map((f) => ({ id: f.id, name: f.name })); }),
      stub(oneDrive, 'getDriveItemById', async (id) => { boom('byId'); const f = root.find((x) => x.id === id); return f ? { id: f.id, name: f.name, parentPath: f.parentPath || ROOT } : null; }),
      stub(oneDrive, 'getClientFolderByName', async (n) => { boom('byName'); const f = root.find((x) => x.name === n); return f ? { id: f.id, name: f.name } : null; }),
      stub(oneDrive, 'renameItemById', async (a) => { boom('rename'); const f = root.find((x) => x.id === a.itemId); if (!f) throw new Error('itemNotFound'); renamed.push(a); f.name = a.newName; return { id: f.id, name: f.name }; }),
      stub(oneDrive, 'deleteDriveItem', async (id) => { dropped.push(id); return true; }),
    ],
  };
}
const caseFolder = () => ({ id: 'od-cm-1', name: `Full Client - ${CASE}` });

test('Cases-page delete: the case rows go, the consultation record is KEPT (unlinked, marked, a note with the exact undo steps), the folder is renamed back, nothing deleted from OneDrive, no Square touched', async () => {
  const m = world({ rowsByBoard: CHILDREN });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1', squareBookingId: 'SQ-1', consultOption: JSON.stringify({ invoiceId: 'INV-1' }), retainerSigned: '2026-10-01', retainerPaid: '2026-10-02', conversionStatus: 'Retained' }]);
  const D = drive([caseFolder(), { id: 'od-other', name: 'Someone Else - LEAD-777' }]);
  const restore = stubs(m, L, [
    ...D.stubs(),
    stub(require('../src/services/squareBookingsService'), 'cancelBookingIfActive', async () => { throw new Error('must not be called'); }),
    stub(require('../src/services/squareInvoicesService'), 'cancelInvoice', async () => { throw new Error('must not be called'); }),
  ]);
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.equal(p.kind, 'case'); assert.equal(p.keepsLeads, true);
    assert.deepEqual(p.targets.leadRows, [], 'no lead row is deleted');
    assert.deepEqual(p.targets.oneDriveFolders, [], 'no folder is deleted');
    assert.deepEqual(p.targets.squareAppointments, [], 'no Square booking is cancelled');
    assert.deepEqual(p.kept, { leadRows: ['Full Client'], folderRename: { from: `Full Client - ${CASE}`, to: 'Full Client - LEAD-500' } });
    assert.ok(p.warnings.some((w) => /consultation record \(Full Client\) is KEPT/.test(w) && /Case deleted/.test(w)));
    assert.ok(p.warnings.some((w) => /renamed back to “Full Client - LEAD-500”/.test(w) && /Nothing is deleted from OneDrive/.test(w)));
    assert.ok(!p.warnings.some((w) => /Square consultation appointment \(if any\) IS cancelled/.test(w)));
    assert.ok(!p.warnings.some((w) => /still out for signature/.test(w)), 'signed already: no agreement out');

    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case', actor: 'faran@tdotimm.com' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.deepEqual(m.deleted, ['1', '3', '4', '900'], 'children, then the case row — never the lead');
    assert.deepEqual(r.deleted, { checklistRows: 1, questionnaireRows: 1, familyMemberRows: 1, clientMasterRow: 1, leadRows: 0, oneDriveFolders: 0, squareAppointmentsCancelled: 0 });
    assert.deepEqual(r.kept, { leadRows: 1, folderRenamed: 1, leadsAlreadyUnlinked: 0 });
    assert.deepEqual(D.dropped, [], 'nothing deleted from OneDrive');
    assert.deepEqual(D.renamed, [{ itemId: 'od-cm-1', newName: 'Full Client - LEAD-500' }]);
    const w = L.writes.find((x) => x.id === '500');
    assert.deepEqual(w.o, { clearKeys: ['clientMasterItemId'] });
    assert.equal(w.f.clientMasterItemId, '');
    assert.match(w.f.caseDeleted, new RegExp(`^\\d{4}-\\d{2}-\\d{2} · ${CASE} · faran@tdotimm\\.com$`));
    const kept = L.store.get('500');
    assert.deepEqual([kept.retainerSigned, kept.retainerPaid, kept.conversionStatus, kept.oneDriveFolderId], ['2026-10-01', '2026-10-02', 'Retained', 'od-cm-1'], 'the record itself is untouched');
    const note = m.notes.find((n) => n.id === '500').body;
    assert.match(note, /Case 2026-VV-042 was deleted/);
    assert.match(note, /restore the case row 2026-VV-042 \(item 900\) and its 1 checklist, 1 questionnaire, 1 family rows/, 'the undo names every row to restore');
    assert.match(note, /rename the folder “Full Client - LEAD-500” back to “Full Client - 2026-VV-042”/, 'and the exact folder names');
    assert.match(note, /Type 900 back into this lead’s “Client Master Item ID” column and clear “Case deleted”/);
    assert.match(note, /A new case instead\?/);
    assert.ok(note.indexOf('rename the folder') < note.indexOf('Type 900 back'), 'the folder is renamed back BEFORE the case is linked again');
  } finally { restore.forEach((x) => x()); }
});

test('Cases-page delete, order for a safe re-run: a failed rename stops before any lead changes; a failed unlink keeps the case row; the re-run finishes without losing anything', async () => {
  // 1. the rename fails → nothing unlinked, case row kept
  let m = world({ rowsByBoard: {} });
  let L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  let D = drive([caseFolder()], { fail: 'rename' });
  let restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /could not be renamed back/.test(f)));
    assert.ok(r.failures.some((f) => /Client Master row was KEPT/.test(f)));
    assert.deepEqual(m.deleted, [], 'the case row stays');
    assert.equal(L.writes.length, 0, 'no lead changed');
  } finally { restore.forEach((x) => x()); }

  // 2. the rename works, the unlink write fails → case row kept
  m = world({ rowsByBoard: {} });
  L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const realUpdate = L.updateLead;
  L.updateLead = async () => { throw new Error('monday 500'); };
  D = drive([caseFolder()]);
  restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /could not be unlinked/.test(f)));
    assert.deepEqual(m.deleted, [], 'the case row stays (the lead still points at it)');
    assert.equal(D.root[0].name, 'Full Client - LEAD-500');
  } finally { restore.forEach((x) => x()); }

  // 3. the re-run: no folder carries the case number now (nothing to rename), the lead is unlinked, the case row goes
  L.updateLead = realUpdate;
  restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.equal(p.kept.folderRename, null);
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.deepEqual(m.deleted, ['900']);
    assert.equal(D.renamed.length, 1, 'never a second rename');
    assert.equal(L.store.get('500').clientMasterItemId, '');
    assert.ok(L.store.get('500').caseDeleted);
  } finally { restore.forEach((x) => x()); }
});

test('Cases-page delete: when OneDrive cannot answer, NOTHING is deleted (preview and execute refuse) — a delete without the rename would leave the record unable to find its files', async () => {
  for (const fail of ['byRef', 'byId']) {
    const m = world({ rowsByBoard: CHILDREN });
    const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-own' }]);
    const D = drive([caseFolder(), { id: 'od-own', name: 'Full Client - LEAD-500x' }], { fail });
    const restore = stubs(m, L, D.stubs());
    try {
      await assert.rejects(() => deletion.previewDeletion({ caseRef: CASE }), (e) => e.badRequest && /OneDrive could not be checked/.test(e.message) && /nothing was deleted/.test(e.message), fail);
      await assert.rejects(() => deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' }), (e) => e.badRequest, fail);
      assert.deepEqual(m.deleted, [], `${fail}: no row deleted`);
      assert.equal(L.writes.length, 0);
    } finally { restore.forEach((x) => x()); }
  }
});

test('Cases-page delete: the folder is NOT renamed when the record already has a folder of its own (found by its " - LEAD-{id}" ending, not an exact name, or by its stored id), or when two records share the case and neither owns the folder; a lead re-linked meanwhile is left alone', async () => {
  // own LEAD folder under a drifted name ("Jon" vs "John") → kept as it is, no second LEAD-500 folder
  let m = world({ cm: { id: '900', name: 'John Smith', caseRef: CASE }, rowsByBoard: {} });
  let L = leads([{ id: '500', fullName: 'John Smith', clientMasterItemId: '900', oneDriveFolderId: '' }]);
  let D = drive([{ id: 'od-cm-1', name: `John Smith - ${CASE}` }, { id: 'od-lead', name: 'Jon Smith - LEAD-500' }]);
  let restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.equal(p.kept.folderRename, null);
    assert.ok(p.warnings.some((w) => /already has its own folder "Jon Smith - LEAD-500"/.test(w)), p.warnings.join(' | '));
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true);
    assert.deepEqual(D.renamed, [], 'never two folders ending " - LEAD-500"');
  } finally { restore.forEach((x) => x()); }

  // the record's stored folder id names another root folder → kept as it is
  m = world({ rowsByBoard: {} });
  L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-own' }]);
  D = drive([caseFolder(), { id: 'od-own', name: 'Full Client intake' }]);
  restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.equal(p.kept.folderRename, null);
    assert.ok(p.warnings.some((w) => /already has its own folder "Full Client intake"/.test(w)));
  } finally { restore.forEach((x) => x()); }

  // two records, neither holds the folder id → kept as it is; then one is re-linked meanwhile → left alone
  m = world({ rowsByBoard: {} });
  L = leads([{ id: '500', fullName: 'A', clientMasterItemId: '900' }, { id: '501', fullName: 'A', clientMasterItemId: '900' }]);
  D = drive([caseFolder()]);
  restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.equal(p.kept.folderRename, null);
    assert.deepEqual(p.kept.leadRows, ['A', 'A']);
    assert.ok(p.warnings.some((w) => /not clear which consultation record owns it/.test(w)));
    L.store.get('501').clientMasterItemId = '777';
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.deepEqual(r.kept, { leadRows: 1, folderRenamed: 1, leadsAlreadyUnlinked: 0 }, 'only 500 was still linked when the graph was rebuilt — the sole record now owns the case folder');
    assert.deepEqual(D.renamed.map((x) => x.newName), ['A - LEAD-500']);
    assert.equal(L.store.get('501').clientMasterItemId, '777');
    assert.ok(!L.store.get('501').caseDeleted);
  } finally { restore.forEach((x) => x()); }
});

test('Cases-page delete is refused (nothing deleted) when the "Case deleted" column is not set up, or when too many records are linked to be sure; a retainer agreement still out is named in the preview', async () => {
  const cols = require('../src/data/newLeadsBoard.json').columns;
  const saved = cols.caseDeleted;
  const m = world({ rowsByBoard: CHILDREN });
  let L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900' }]);
  let restore = stubs(m, L, drive([]).stubs());
  try {
    delete cols.caseDeleted;
    await assert.rejects(() => deletion.previewDeletion({ caseRef: CASE }), (e) => e.badRequest && /no "Case deleted" column/.test(e.message));
    await assert.rejects(() => deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' }), (e) => e.badRequest);
    assert.deepEqual(m.deleted, []);
  } finally { cols.caseDeleted = saved; restore.forEach((x) => x()); }
  L = leads(Array.from({ length: 50 }, (_, i) => ({ id: String(600 + i), fullName: 'X', clientMasterItemId: '900' })));
  restore = stubs(m, L, drive([]).stubs());
  try {
    await assert.rejects(() => deletion.previewDeletion({ caseRef: CASE }), (e) => e.badRequest && /too many to be sure/.test(e.message));
  } finally { restore.forEach((x) => x()); }
  L = leads([{ id: '500', fullName: 'Walk In', clientMasterItemId: '900', retainerSent: '2026-11-01', directClient: 'Yes' }]);
  restore = stubs(m, L, drive([]).stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.ok(p.warnings.some((w) => /retainer agreement sent to Walk In is still out for signature/.test(w) && /no case opens/.test(w)));
    assert.ok(p.warnings.some((w) => /No OneDrive folder carries this case number/.test(w)));
  } finally { restore.forEach((x) => x()); }
});

test('a case with no consultation record: the case rows go, nothing is deleted from OneDrive', async () => {
  const m = world({ rowsByBoard: CHILDREN });
  const L = leads([]);
  const D = drive([caseFolder()]);
  const restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.ok(p.warnings.some((w) => /No consultation record/.test(w)));
    assert.deepEqual(p.targets.oneDriveFolders, []);
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true);
    assert.deepEqual(m.deleted, ['1', '3', '4', '900']);
    assert.deepEqual(D.dropped, []); assert.deepEqual(D.renamed, []);
  } finally { restore.forEach((x) => x()); }
});

test('the bin on a list (a LEAD with a case) still deletes everything — the case, the consultation record, the folders, Square — and says so', async () => {
  const m = world({ rowsByBoard: CHILDREN, itemBoards: { 500: LEAD_BOARD } });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900' }]);
  const D = drive([caseFolder(), { id: 'od-lead-x', name: 'Full Client - LEAD-500' }]);
  const restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ leadId: '500' });
    assert.equal(p.keepsLeads, false); assert.equal(p.kept, null);
    assert.deepEqual(p.targets.leadRows, ['Full Client']);
    const r = await deletion.executeDeletion({ leadId: '500', confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.deepEqual(m.deleted, ['1', '3', '4', '900', '500'], 'children, case row, then the lead');
    assert.deepEqual(D.dropped.sort(), ['od-cm-1', 'od-lead-x'], 'its folders go (the case folder by the stored id, and the lead folder)');
    assert.equal(r.kept, null);
  } finally { restore.forEach((x) => x()); }
});

test('a lead still pointing at a case in Monday’s recycle bin is a plain lead (its bin deletes the lead only)', async () => {
  const m = world({ cmState: 'deleted', itemBoards: { 500: LEAD_BOARD } });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900' }]);
  const restore = stubs(m, L, drive([]).stubs());
  try {
    const p = await deletion.previewDeletion({ leadId: '500' });
    assert.equal(p.kind, 'lead');
    assert.equal(p.confirmText, 'DELETE');
  } finally { restore.forEach((x) => x()); }
});

/* ── nothing opens a new case for a kept record by itself ── */

test('a kept record: a signed date never opens a case or asks for payment; Mark retainer signed refuses; the status sync does not flag it; the lists and the record say "Case deleted"', async () => {
  const marker = `2026-11-05 · ${CASE} · faran@tdotimm.com`;
  // the signed-date chain
  const retainer2 = require('../src/services/retainerService2');
  const handoff = require('../src/services/handoffService');
  const ms = require('../src/services/milestonePaymentService');
  const calls = { handoff: 0, link: 0, notes: [] , writes: 0 };
  const lead = { id: '500', outcome: 'Retain', retainerSigned: '2026-11-06', caseDeleted: marker, clientMasterItemId: '', email: 'a@b.co', retainerFee: '2000' };
  let restore = [
    stub(leadService, 'getLead', async () => ({ ...lead })),
    stub(leadService, 'updateLead', async () => { calls.writes++; }),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) calls.notes.push(v.body || v.b); return {}; }),
    stub(handoff, 'onRetainerSigned', async () => { calls.handoff++; }),
    stub(ms, 'sendMilestoneEtransferRequest', async () => { calls.link++; return { sent: true }; }),
  ];
  try {
    const r = await retainer2.onRetainerSigned('500');
    assert.deepEqual(r, { status: 'case-deleted' });
    assert.deepEqual([calls.handoff, calls.link, calls.writes], [0, 0, 0], 'no case, no payment request, nothing written');
    assert.ok(calls.notes.some((n) => /this client’s case was deleted/.test(n) && /clear “Case deleted”/.test(n)));
    await retainer2.maybeSendRetainerPaymentLink('500', { notifyIfMissing: true });
    assert.equal(calls.link, 0, 'the payment request (also from a fee edit) waits too');
  } finally { restore.forEach((x) => x()); }
  // Mark retainer signed
  const portal = require('../src/services/consultantPortalService');
  let wrote = false;
  restore = [
    stub(leadService, 'getLead', async () => ({ ...lead, retainerSigned: '', conversionStatus: 'Consulted' })),
    stub(leadService, 'updateLead', async () => { wrote = true; }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    await assert.rejects(() => portal.applyAction({ leadId: '500', action: 'retainerSigned', value: '2026-11-06' }), (e) => e.badRequest && /case was deleted/.test(e.message) && /clear “Case deleted”/.test(e.message));
    assert.equal(wrote, false);
  } finally { restore.forEach((x) => x()); }
  // once a case is linked again (staff restored it, or created a new one on purpose), the marker no longer matters
  restore = [
    stub(leadService, 'getLead', async () => ({ ...lead, clientMasterItemId: '901' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async () => ({})),
    stub(handoff, 'onRetainerSigned', async () => { calls.handoff++; }),
    stub(ms, 'sendMilestoneEtransferRequest', async () => ({ sent: true })),
    stub(require('../src/services/paymentService'), 'maybeMarkRetained', async () => ({})),
  ];
  try {
    const before = calls.handoff;
    await retainer2.onRetainerSigned('500');
    assert.equal(calls.handoff, before + 1);
  } finally { restore.forEach((x) => x()); }
  // the status sync
  const R = require('../src/services/retainerStatusReconciler');
  assert.equal(R.classifyDrift({ retainerSigned: '2026-10-01', retainerPaid: '2026-10-02', caseDeleted: marker, clientMasterItemId: '' }, null).action, 'none');
  assert.equal(R.classifyDrift({ retainerSigned: '2026-10-01', retainerPaid: '2026-10-02', clientMasterItemId: '' }, null).action, 'no-case', 'without the marker: still a broken handoff for a human');
  // the record and the list
  const { listFor } = portal;
  assert.equal(listFor({ conversionStatus: 'Retained', caseDeleted: marker, clientMasterItemId: '' }), 'retainers', 'a kept retained record: the Retained tab');
  const svc = require('fs').readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.ok(svc.includes("caseDeleted:    String(lead.clientMasterItemId || '').trim() ? '' : String(lead.caseDeleted || '').trim(),"));
  assert.ok(svc.includes("caseDeleted: s(l.clientMasterItemId) ? '' : s(l.caseDeleted),"));
  const page = require('../src/routes/adminConsultation').buildDetailHTML('500');
  assert.ok(page.includes("{ k:(d.caseDeleted?'Case deleted':'Case'), done:!!d.clientMasterItemId }") && page.includes("(d.caseDeleted?kv('Case deleted',"));
  assert.ok(require('../src/services/leadSnapshot').SNAPSHOT_KEYS ? require('../src/services/leadSnapshot').SNAPSHOT_KEYS.includes('caseDeleted') : true);
});

test('the window and the bins say what a delete keeps', () => {
  const { DELETE_UI_JS } = require('../src/routes/adminShared');
  assert.ok(DELETE_UI_JS.includes("p.keepsLeads ? 'Delete case ' + delEsc(p.caseRef) + '?' : 'Delete case ' + delEsc(p.caseRef) + ' and the consultation record?'"));
  assert.ok(DELETE_UI_JS.includes("'<div>Kept:</div><ul>'"));
  assert.ok(DELETE_UI_JS.includes('Recoverable from the Monday recycle bin.'));
  new (require('vm').Script)(DELETE_UI_JS);
  const dash = require('fs').readFileSync(require.resolve('../src/routes/adminDashboard'), 'utf8');
  assert.ok(dash.includes('title="Delete this case (careful — removes its Monday rows; the consultation record and the OneDrive folder are kept)"'));
  const ret = require('../src/routes/adminConsultation').buildRetainersHTML();
  assert.ok(ret.includes('Delete this client, their consultation record and their OneDrive folder (careful — if there is a case, the case and its checklist go too)'), 'the folder always goes with the record (review 2026-11-05)');
});

test('review 2026-11-05: a late e-signature on a kept record says no case opens (email and note) and does not ask the consultant to countersign', async () => {
  const documenso = require('../src/services/documensoService');
  const microsoftMail = require('../src/services/microsoftMailService');
  const rc = require('../src/services/retainerCountersignService');
  const mails = [], notes = [];
  let countersigns = 0;
  const prev = process.env.STAFF_SIGNATURE_NOTIFY_EMAILS;
  process.env.STAFF_SIGNATURE_NOTIFY_EMAILS = 'kamal@tdotimm.com';
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Walk In', retainerSigned: '', caseDeleted: `2026-11-05 · ${CASE} · faran@tdotimm.com`, clientMasterItemId: '' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) notes.push((v && (v.b || v.body)) || ''); return {}; }),
    stub(microsoftMail, 'sendEmail', async (m) => { mails.push(m); }),
    stub(rc, 'startRetainerCountersign', async () => { countersigns++; return { envelopeId: 'E1' }; }),
  ];
  try {
    const r = await documenso.captureCompleted({ event: 'DOCUMENT_COMPLETED', payload: { id: 91, externalId: 'retainer-500', status: 'COMPLETED', items: [] } });
    assert.equal(r.caseDeleted, true);
    assert.equal(countersigns, 0, 'no countersign request for a case that no longer exists');
    assert.equal(mails.length, 1);
    assert.match(mails[0].html, /case was deleted/); assert.ok(!/The case opens automatically/.test(mails[0].html));
    const note = notes.join(' | ');
    assert.match(note, /no case opens by itself/); assert.match(note, /consultant was not asked to countersign/);
    assert.ok(!/The case will open automatically/.test(note));
  } finally {
    restore.forEach((x) => x());
    if (prev === undefined) delete process.env.STAFF_SIGNATURE_NOTIFY_EMAILS; else process.env.STAFF_SIGNATURE_NOTIFY_EMAILS = prev;
  }
});

test('review 2026-11-05: a retained record with no case never says "the case is open" — the record button and the server say what is true', async () => {
  const page = require('../src/routes/adminConsultation').buildDetailHTML('500');
  assert.ok(page.includes("RP_SIGNED_WHY = d.caseDeleted ? 'Retainer already signed — this client’s case was deleted (see “Case deleted”); no case opens by itself'"));
  assert.ok(page.includes("signedBtn.title = RP_SIGNED ? RP_SIGNED_WHY : '';"));
  assert.ok(!page.includes("signedBtn.title = RP_SIGNED ? 'Retainer already signed — the case is open' : '';"));
  const portal = require('../src/services/consultantPortalService');
  const restore = [
    stub(leadService, 'getLead', async () => ({ id: '500', outcome: 'Retain', retainerSigned: '2026-10-01', retainerPaid: '2026-10-02', conversionStatus: 'Retained', clientMasterItemId: '', caseDeleted: '' })),
    stub(leadService, 'updateLead', async () => { throw new Error('must not write'); }),
    stub(mondayApi, 'query', async () => ({})),
  ];
  try {
    const r = await portal.applyAction({ leadId: '500', action: 'retainerSigned', value: '' });
    assert.ok(!/the case is open/.test(r.message), r.message);
    assert.match(r.message, /No case is linked/); assert.match(r.message, /clear the Retainer Signed date and type it again/);
  } finally { restore.forEach((x) => x()); }
});
