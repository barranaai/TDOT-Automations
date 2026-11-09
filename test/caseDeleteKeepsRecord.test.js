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
Object.assign(deletion._internal.timing, { reReadMs: [0, 0], noteRetryMs: 0 });   // no real pauses in tests

const LEAD_BOARD = '18416845157', CM_BOARD = '18401523447';
const EXEC = '18401875593', QEXEC = '18402117488', FAMILY = '18415615177';
const ROOT = '/drive/root:/Client Documents';
const CASE = '2026-VV-042';

/** A Monday router: deletes recorded, child rows by board, the CM row (with state), board pinning, notes recorded. */
function world({ cm = { id: '900', name: 'Full Client', caseRef: CASE, oneDriveFolderId: 'od-cm-1' }, cmState = 'active', rowsByBoard = {}, itemBoards = {}, failItemIds = [], failNotes = {}, states = {} } = {}) {
  const deleted = [], notes = [];
  const noteFails = { ...failNotes };   // item id → how many more notes on it fail
  const fn = async (q, vars) => {
    if (/create_update/.test(q)) {
      const id = String(vars.id);
      if (noteFails[id] > 0) { noteFails[id]--; throw new Error(`note boom ${id}`); }
      notes.push({ id, body: vars.b || vars.body }); return { create_update: { id: 'u1' } };
    }
    if (/delete_item/.test(q)) {
      if (vars && vars.id) { const id = String(vars.id); if (failItemIds.includes(id)) throw new Error(`boom ${id}`); deleted.push(id); return {}; }
      const ids = [...q.matchAll(/delete_item\(item_id:\s*(\d+)\)/g)].map((m) => m[1]);
      if (ids.some((id) => failItemIds.includes(id))) throw new Error('batch boom');
      deleted.push(...ids); return {};
    }
    if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: (rowsByBoard[String(vars.b)] || []).filter((r) => !deleted.includes(String(r.id))) } };   // a deleted row is gone
    if (/items\(ids/.test(q)) {
      const id = String(Array.isArray(vars.id) ? vars.id[0] : vars.id);
      if (/updates/.test(q)) {   // newest first, 100 a page
        const all = notes.filter((n) => n.id === id).reverse().map((n) => ({ text_body: String(n.body).replace(/<[^>]+>/g, '') }));
        const p = Number(vars.p || 1);
        return { items: [{ id, state: states[id] || 'active', updates: all.slice((p - 1) * 100, p * 100) }] };
      }
      if (/\{ id state \}/.test(q)) return { items: (Array.isArray(vars.id) ? vars.id : [vars.id]).map((x) => ({ id: String(x), state: states[String(x)] || 'active' })) };
      if (/column_values/.test(q)) {
        if (!cm || id !== String(cm.id)) return { items: [] };
        return { items: [{ id: cm.id, name: cm.name, state: deleted.includes(String(cm.id)) ? 'deleted' : cmState, board: { id: CM_BOARD }, column_values: [
          { id: 'text_mm142s49', text: cm.caseRef }, { id: 'text_mm0xw6bp', text: cm.email || '' }, { id: 'text_mm47y540', text: cm.oneDriveFolderId || '' },
        ] }] };
      }
      const b = itemBoards[id];
      return b ? { items: [{ id, board: { id: b } }] } : { items: [] };
    }
    return {};
  };
  return { fn, deleted, notes, noteFails, states };
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
    assert.match(w.f.caseDeleted, new RegExp(`^\\d{4}-\\d{2}-\\d{2} · ${CASE} · faran@tdotimm\\.com · item 900$`));
    const kept = L.store.get('500');
    assert.deepEqual([kept.retainerSigned, kept.retainerPaid, kept.conversionStatus, kept.oneDriveFolderId], ['2026-10-01', '2026-10-02', 'Retained', 'od-cm-1'], 'the record itself is untouched');
    const note = m.notes.find((n) => n.id === '500').body;
    assert.match(note, /Case 2026-VV-042 was deleted/);
    assert.match(note, /restore the case row 2026-VV-042 \(item 900\) and every checklist, questionnaire and family row of 2026-VV-042/, 'the undo names every row to restore — whatever this run did');
    assert.match(note, /rename the folder “Full Client - LEAD-500” back to “Full Client - 2026-VV-042”/, 'and the exact folder names');
    assert.match(note, /Type 900 back into the “Client Master Item ID” column, and clear “Case deleted”, on this lead\./);
    assert.match(note, /A new case instead\?/);
    assert.ok(note.indexOf('rename the folder') < note.indexOf('Type 900 back'), 'the folder is renamed back BEFORE the case is linked again');
    assert.equal(r.kept.notesFailed, undefined);
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

  // 2. the rename works, the unlink write fails → case row kept; nothing was set aside, so the folder gets its case
  //    name back (review round 3): the case and its record are exactly as linked as before
  m = world({ rowsByBoard: {} });
  L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const realUpdate = L.updateLead;
  L.updateLead = async () => { throw new Error('monday 500'); };
  D = drive([caseFolder()]);
  restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /Full Client \(500\) could not be set aside — it still reads as linked to the case/.test(f)), r.failures.join(' | '));
    assert.ok(r.failures.some((f) => f.includes(`The OneDrive folder was given its case name “Full Client - ${CASE}” back. Run the delete again`)), r.failures.join(' | '));
    assert.deepEqual(m.deleted, [], 'the case row stays (the lead still points at it)');
    assert.equal(D.root[0].name, `Full Client - ${CASE}`);
    assert.equal(r.kept.folderRenamed, 0);
    assert.equal(m.notes.filter((n) => n.id === '900').length, 1, 'the plan was noted on the case first');
  } finally { restore.forEach((x) => x()); }

  // 3. the re-run: the same plan (not noted twice), the folder renamed again, the lead unlinked, the case row goes
  L.updateLead = realUpdate;
  restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.deepEqual(p.kept.folderRename, { from: `Full Client - ${CASE}`, to: 'Full Client - LEAD-500' });
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.deepEqual(m.deleted, ['900']);
    assert.deepEqual(D.renamed.map((x) => x.newName), ['Full Client - LEAD-500', `Full Client - ${CASE}`, 'Full Client - LEAD-500']);
    assert.equal(L.store.get('500').clientMasterItemId, '');
    assert.ok(L.store.get('500').caseDeleted);
    assert.equal(m.notes.filter((n) => n.id === '900').length, 1, 'the same plan is not noted twice');
    assert.equal(m.notes.filter((n) => n.id === '500').length, 1);
  } finally { restore.forEach((x) => x()); }
});

test('Cases-page delete: when OneDrive cannot answer, NOTHING is deleted (preview and execute refuse) — a delete without the rename would leave the record unable to find its files', async () => {
  // byRef: the case-number lookup itself; byId: the re-run check of the case row's own folder (no folder carries the number)
  for (const [fail, folders] of [['byRef', [caseFolder()]], ['byId', [{ id: 'od-cm-1', name: 'Full Client - LEAD-500' }]]]) {
    const m = world({ rowsByBoard: CHILDREN });
    const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
    const D = drive(folders, { fail });
    const restore = stubs(m, L, D.stubs());
    try {
      await assert.rejects(() => deletion.previewDeletion({ caseRef: CASE }), (e) => e.badRequest && /OneDrive could not be checked/.test(e.message) && /nothing was deleted/.test(e.message), fail);
      await assert.rejects(() => deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' }), (e) => e.badRequest, fail);
      assert.deepEqual(m.deleted, [], `${fail}: no row deleted`);
      assert.equal(L.writes.length, 0);
    } finally { restore.forEach((x) => x()); }
  }
});

test('Cases-page delete: the folder is NOT renamed when the record already has a folder of its own (found by its " - LEAD-{id}" ending, not an exact name), or when two records share the case and neither owns the folder; a lead re-linked meanwhile is left alone', async () => {
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

test('review rounds 2+3: a re-run after a stop part-way still posts the WHOLE way back on every record — every row of the case, the folder the first run renamed, and every record to re-link (from the plan noted on the case)', async () => {
  const m = world({ rowsByBoard: CHILDREN });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }, { id: '501', fullName: 'Second Booking', clientMasterItemId: '900' }]);
  const realUpdate = L.updateLead;
  L.updateLead = async (id, f, o) => { if (String(id) === '501') throw new Error('monday 500'); return realUpdate(id, f, o); };
  const D = drive([caseFolder()]);
  let restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case', actor: 'faran@tdotimm.com' });
    assert.equal(r.ok, false);
    assert.equal(r.kept.folderRenamed, 1, 'a record was set aside: the folder stays renamed (no rollback)');
    assert.equal(r.kept.leadRows, 1);
    assert.deepEqual(m.deleted, ['1', '3', '4'], 'the case row stays');
    const plan = m.notes.filter((n) => n.id === '900');
    assert.equal(plan.length, 1);
    assert.match(plan[0].body, /Kept: Full Client \(500\), Second Booking \(501\)\./);
    assert.match(plan[0].body, new RegExp(`OneDrive folder “Full Client - ${CASE}” → renamed back to “Full Client - LEAD-500”`));
    assert.ok(m.notes.find((n) => n.id === '500').body.includes('on this lead and on Second Booking (501).'));
  } finally { restore.forEach((x) => x()); }

  // the re-run: 500 is no longer found by the case link, no folder carries the case number — the plan knows both
  L.updateLead = realUpdate;
  restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.equal(p.kept.folderRename, null);
    assert.deepEqual(p.kept.leadRows, ['Second Booking', 'Full Client']);
    assert.ok(p.warnings.some((w) => /An earlier run of this delete already set aside Full Client \(500\)/.test(w)), p.warnings.join(' | '));
    assert.ok(p.warnings.some((w) => /already renamed back to “Full Client - LEAD-500” \(an earlier run of this delete\)/.test(w)), p.warnings.join(' | '));
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.deepEqual(m.deleted, ['1', '3', '4', '900']);
    assert.deepEqual(r.kept, { leadRows: 1, folderRenamed: 0, leadsAlreadyUnlinked: 0, leadsSetAsideEarlier: 1, folderRenamedEarlier: 1 }, 'the result counts what the stopped run did too');
    const note = m.notes.find((n) => n.id === '501').body;
    assert.match(note, /every checklist, questionnaire and family row of 2026-VV-042/, 'the rows the FIRST run deleted are in the undo');
    assert.match(note, /rename the folder “Full Client - LEAD-500” back to “Full Client - 2026-VV-042”/, 'so is the rename the first run made');
    assert.match(note, /The case’s OneDrive folder was kept and renamed back to “Full Client - LEAD-500”/);
    assert.ok(note.includes('on this lead and on Full Client (500).'), 'the record the first run set aside is in the re-link list');
    assert.equal(m.notes.filter((n) => n.id === '500').length, 1, 'its note is there already — not posted twice');
    assert.equal(m.notes.filter((n) => n.id === '900').length, 1, 'the same plan is not noted twice');
    assert.equal(D.renamed.length, 1);
  } finally { restore.forEach((x) => x()); }
  // the window says what a stopped run already changed
  const { DELETE_UI_JS } = require('../src/routes/adminShared');
  assert.ok(DELETE_UI_JS.includes("var partTxt = (kp && kp.folderRenamed) ? ' The OneDrive folder was already renamed back to the lead’s name — running the delete again finishes the rest.' : '';"));
  assert.ok(DELETE_UI_JS.includes("var kn = kp ? kp.leadRows + kp.leadsAlreadyUnlinked + (kp.leadsSetAsideEarlier || 0) : 0;") && DELETE_UI_JS.includes("(kp.folderRenamed || kp.folderRenamedEarlier)"));
});

test('review round 3: the note with the way back is never lost — a note that cannot be added keeps the case row, and the re-run adds it (with the first run’s marker)', async () => {
  const m = world({ rowsByBoard: {}, failNotes: { 500: 2 } });   // both tries fail on the first run
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const D = drive([caseFolder()]);
  let restore = stubs(m, L, D.stubs());
  let marker;
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case', actor: 'faran@tdotimm.com' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.includes('The note with the way back could not be added on Full Client (500)') && /run the delete again/.test(f)), r.failures.join(' | '));
    assert.ok(r.failures.some((f) => /Client Master row was KEPT/.test(f)));
    assert.deepEqual(m.deleted, [], 'the case row (the only way to re-run) stays');
    assert.equal(L.store.get('500').clientMasterItemId, '', 'the record itself was set aside');
    marker = L.store.get('500').caseDeleted;
    assert.equal(m.notes.filter((n) => n.id === '500').length, 0);
  } finally { restore.forEach((x) => x()); }
  restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case', actor: 'someone.else@tdotimm.com' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(r.kept.notesPosted, 1);
    assert.deepEqual(m.deleted, ['900']);
    const note = m.notes.filter((n) => n.id === '500');
    assert.equal(note.length, 1);
    assert.ok(note[0].body.includes(`(${marker})`), 'the note carries the marker the record has');
    assert.match(note[0].body, /rename the folder “Full Client - LEAD-500” back to “Full Client - 2026-VV-042”/);
    assert.equal(L.store.get('500').caseDeleted, marker, 'the marker is not rewritten');
  } finally { restore.forEach((x) => x()); }
});

test('review round 3: the plan is noted on the case BEFORE anything changes — when it cannot be, nothing is deleted; the plan reads back exactly (names with any characters), the newest first; a record re-linked meanwhile is not counted', async () => {
  let m = world({ rowsByBoard: CHILDREN, failNotes: { 900: 2 } });
  let L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  let D = drive([caseFolder()]);
  let restore = stubs(m, L, D.stubs());
  try {
    await assert.rejects(() => deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' }),
      (e) => e.badRequest && /could not be noted on the case/.test(e.message) && /nothing was deleted/.test(e.message));
    assert.deepEqual(m.deleted, []); assert.equal(L.writes.length, 0); assert.deepEqual(D.renamed, []);
  } finally { restore.forEach((x) => x()); }

  const { readKeepPlan, planMarker } = deletion._internal;
  const odd = 'José “Joe” <Ng> & Ö/ß';
  m = world();
  m.notes.push({ id: '900', body: `old ${planMarker({ v: 1, leads: [{ id: '1', name: 'Old' }] })}` });
  m.notes.push({ id: '900', body: 'a plain note ⟦keep-plan not-base64⟧' });
  m.notes.push({ id: '900', body: `<b>new</b> ${planMarker({ v: 1, leads: [{ id: '500', name: odd }], from: 'A - 2026-VV-042', to: `${odd} - LEAD-500`, owner: '500' })}` });
  m.notes.push({ id: '900', body: 'a later note without a plan' });
  restore = [stub(mondayApi, 'query', m.fn)];
  try {
    const p = await readKeepPlan('900');
    assert.deepEqual(p, { v: 1, leads: [{ id: '500', name: odd }], from: 'A - 2026-VV-042', to: `${odd} - LEAD-500`, owner: '500' });
  } finally { restore.forEach((x) => x()); }

  // a record of the plan that was linked to ANOTHER case meanwhile is not this delete's any more
  m = world({ rowsByBoard: {} });
  L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '', caseDeleted: `2026-11-05 · ${CASE} · faran@tdotimm.com`, oneDriveFolderId: 'od-cm-1' },
             { id: '501', fullName: 'Second Booking', clientMasterItemId: '900' }]);
  m.notes.push({ id: '900', body: planMarker({ v: 1, leads: [{ id: '500', name: 'Full Client' }, { id: '501', name: 'Second Booking' }], from: `Full Client - ${CASE}`, to: 'Full Client - LEAD-500', owner: '500' }) });
  L.store.get('500').clientMasterItemId = '777';
  D = drive([{ id: 'od-cm-1', name: 'Full Client - LEAD-500' }]);
  restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.deepEqual(p.kept.leadRows, ['Second Booking']);
    assert.ok(!p.warnings.some((w) => /An earlier run/.test(w)));
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    const note = m.notes.find((n) => n.id === '501').body;
    assert.ok(note.includes('and clear “Case deleted”, on this lead.'), note);
    assert.equal(m.notes.filter((n) => n.id === '500').length, 0, 'nothing posted on a record linked elsewhere');
  } finally { restore.forEach((x) => x()); }
});

test('review round 3: a record linked to a case row that was MOVED to another Monday board (2026-ISS-009) is not a plain lead — its bin refuses, nothing deleted; a case row in the recycle bin still is', async () => {
  const m = world({ cm: null, itemBoards: { 500: LEAD_BOARD, 900: '18400000001' }, rowsByBoard: {} });
  const L = leads([{ id: '500', fullName: 'Harini S', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const D = drive([{ id: 'od-cm-1', name: 'Harini S - 2026-ISS-009' }]);
  const restore = stubs(m, L, D.stubs());
  try {
    for (const run of [() => deletion.previewDeletion({ leadId: '500' }), () => deletion.executeDeletion({ leadId: '500', confirmText: 'DELETE', expectedKind: 'lead' })]) {
      await assert.rejects(run, (e) => e.badRequest && /linked to a case row on the Monday board/.test(e.message) && /the case was moved, it is not gone/.test(e.message) && /Nothing was deleted/.test(e.message));
    }
    assert.deepEqual(m.deleted, []); assert.deepEqual(D.dropped, []);
  } finally { restore.forEach((x) => x()); }
});

test('review round 2: every kept record gets the case-level undo — the folder step and every record to re-link — not only the folder’s owner', async () => {
  const m = world({ rowsByBoard: CHILDREN });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }, { id: '501', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-l-501' }]);
  const D = drive([caseFolder(), { id: 'od-l-501', name: 'Full Client second booking' }]);
  const restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.deepEqual(D.renamed.map((x) => x.newName), ['Full Client - LEAD-500']);
    const n500 = m.notes.find((n) => n.id === '500').body, n501 = m.notes.find((n) => n.id === '501').body;
    for (const [n, other] of [[n500, 'Full Client (501)'], [n501, 'Full Client (500)']]) {
      assert.match(n, /rename the folder “Full Client - LEAD-500” back to “Full Client - 2026-VV-042”/);
      assert.ok(n.includes(`on this lead and on ${other}.`), n);
    }
    assert.match(n501, /The case’s OneDrive folder was kept and renamed back to “Full Client - LEAD-500”/);
  } finally { restore.forEach((x) => x()); }
});

test('review round 2: a client name with characters OneDrive does not allow is stripped (as every folder the app makes), never a reason to leave the record without its folder; a stored id naming a folder WITHOUT the LEAD ending does not block the rename', async () => {
  let m = world({ cm: { id: '900', name: 'Raj/Simran Patel', caseRef: CASE }, rowsByBoard: {} });
  let L = leads([{ id: '500', fullName: 'Raj/Simran Patel', clientMasterItemId: '900' }]);
  let D = drive([{ id: 'od-cm-1', name: `RajSimran Patel - ${CASE}` }]);
  let restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.deepEqual(p.kept.folderRename, { from: `RajSimran Patel - ${CASE}`, to: 'RajSimran Patel - LEAD-500' });
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true);
    assert.deepEqual(D.renamed, [{ itemId: 'od-cm-1', newName: 'RajSimran Patel - LEAD-500' }]);
  } finally { restore.forEach((x) => x()); }
  // 2026-OINP-045 shape: the stored id names "… (was 2026-OINP-045)" — the record could never find that one by name
  m = world({ rowsByBoard: {} });
  L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-was' }]);
  D = drive([caseFolder(), { id: 'od-was', name: 'Full Client (was 2026-VV-042)' }]);
  restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.deepEqual(p.kept.folderRename, { from: `Full Client - ${CASE}`, to: 'Full Client - LEAD-500' }, 'the case folder becomes the record’s — what the record could find before stays findable');
  } finally { restore.forEach((x) => x()); }
});

test('review round 2: a retained client whose case is gone has the bin on the Retained tab (the explicit "delete the record"); one with a case does not', () => {
  const ret = require('../src/routes/adminConsultation').buildRetainersHTML();
  assert.ok(ret.includes("'<td>'+((c.retained && c.clientMasterItemId && c.caseFound!==false)?'':'<button class=\"del-btn\""), 'also when the case is not on the Cases board (“Case not found”) — a moved case refuses at the server');
});

/* ── review round 4 (2026-11-05): a fresh read decides, the owner goes first, the first rename is never lost ── */

const undo = (l) => (x) => l.slice().reverse().forEach((f) => f());   // restore in reverse: later stubs sit on earlier ones

test('review round 4: an unlink write that LANDS but answers with an error is read again — the record is set aside with its note and its folder, never "rolled back" as still linked', async () => {
  const m = world({ rowsByBoard: {} });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const realUpdate = L.updateLead;
  L.updateLead = async (id, f, o) => { await realUpdate(id, f, o); throw new Error('timeout after apply'); };
  const D = drive([caseFolder()]);
  const restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(D.root[0].name, 'Full Client - LEAD-500', 'the folder stays with the record');
    assert.deepEqual(m.deleted, ['900']);
    assert.deepEqual(r.kept, { leadRows: 1, folderRenamed: 1, leadsAlreadyUnlinked: 0 });
    assert.match(m.notes.find((n) => n.id === '500').body, /rename the folder “Full Client - LEAD-500” back to “Full Client - 2026-VV-042”/);
  } finally { restore.forEach((x) => x()); }
});

test('review round 4: the folder’s OWNER is set aside first — when it cannot be, the folder gets its case name back and NOTHING else changes (the open case keeps its files); the re-run finishes', async () => {
  const m = world({ rowsByBoard: {} });
  const L = leads([{ id: '501', fullName: 'Second Booking', clientMasterItemId: '900' }, { id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);   // the owner listed second
  const realUpdate = L.updateLead;
  L.updateLead = async (id, f, o) => { if (String(id) === '500') throw new Error('monday 500'); return realUpdate(id, f, o); };
  const D = drive([caseFolder()]);
  let restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.equal(D.root[0].name, `Full Client - ${CASE}`, 'the open case finds its folder again');
    assert.ok(r.failures.some((f) => /Full Client \(500\) could not be set aside — it still reads as linked to the case/.test(f)), r.failures.join(' | '));
    assert.ok(r.failures.some((f) => f.includes(`given its case name “Full Client - ${CASE}” back. Run the delete again`)), r.failures.join(' | '));
    assert.equal(L.store.get('501').clientMasterItemId, '900', 'the other record was not touched');
    assert.ok(!L.store.get('501').caseDeleted);
    assert.deepEqual(m.deleted, []);
  } finally { restore.forEach((x) => x()); }
  L.updateLead = realUpdate;
  restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(D.root[0].name, 'Full Client - LEAD-500');
    assert.deepEqual(m.deleted, ['900']);
    assert.ok(L.store.get('501').caseDeleted && L.store.get('500').caseDeleted);
  } finally { restore.forEach((x) => x()); }
});

test('review round 4: after a stop, a folder the still-open case made carries the number again — the re-run keeps the FIRST rename (from the plan) in the note and keeps the new folder, named in a warning', async () => {
  const m = world({ rowsByBoard: {}, failNotes: { 500: 2 } });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const D = drive([caseFolder()]);
  let restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
  } finally { restore.forEach((x) => x()); }
  D.root.push({ id: 'od-new', name: `Full Client - ${CASE}` });   // the open case saved a file meanwhile
  restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.equal(p.kept.folderRename, null, 'no second rename');
    assert.ok(p.warnings.some((w) => /already renamed back to “Full Client - LEAD-500”/.test(w) && w.includes(`A folder made since then also carries the case number (“Full Client - ${CASE}”) — KEPT as it is`)), p.warnings.join(' | '));
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.deepEqual(D.root.map((f) => f.name), ['Full Client - LEAD-500', `Full Client - ${CASE}`], 'nothing renamed or deleted');
    const notes = m.notes.filter((n) => n.id === '500');
    assert.equal(notes.length, 1);
    assert.match(notes[0].body, /rename the folder “Full Client - LEAD-500” back to “Full Client - 2026-VV-042”/);
  } finally { restore.forEach((x) => x()); }
});

test('review round 4: a record still linked is never made owner of a folder made after the first run, and the plan noted on the case is not replaced', async () => {
  const m = world({ rowsByBoard: {} });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }, { id: '501', fullName: 'Second Booking', clientMasterItemId: '900' }]);
  const realUpdate = L.updateLead;
  L.updateLead = async (id, f, o) => { if (String(id) === '501') throw new Error('monday 500'); return realUpdate(id, f, o); };
  const D = drive([caseFolder()]);
  let restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.equal(D.root[0].name, 'Full Client - LEAD-500', 'the owner was set aside: its folder stays renamed');
  } finally { restore.forEach((x) => x()); }
  L.updateLead = realUpdate;
  D.root.push({ id: 'od-new', name: `Full Client - ${CASE}` });
  restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.equal(p.kept.folderRename, null);
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.deepEqual(D.renamed.map((x) => x.newName), ['Full Client - LEAD-500'], 'the new folder is never renamed');
    const plan = await deletion._internal.readKeepPlan('900');
    assert.deepEqual([plan.id, plan.from, plan.to, plan.owner, plan.later], ['od-cm-1', `Full Client - ${CASE}`, 'Full Client - LEAD-500', '500', [`Full Client - ${CASE}`]], 'the newest plan keeps the first rename and names the new folder');
    for (const id of ['501', '500']) {   // 500 was set aside before: it gets a note with this plan's way back
      const n = m.notes.filter((x) => x.id === id).pop().body;
      assert.ok(n.includes(id === '500'
        ? `<b>Files added while the delete was stopped</b> are in “Full Client - ${CASE}”: in OneDrive, move them into “Full Client - LEAD-500” and delete the empty folder — this record finds only “Full Client - LEAD-500”.`
        : `<b>Files added while the delete was stopped</b> are in “Full Client - ${CASE}”: in OneDrive, move them into the case’s folder “Full Client - LEAD-500” (kept with Full Client (500)) and delete the empty folder.`), n);
      assert.ok(n.includes(`if “Full Client - ${CASE}” (made while the delete was stopped) is still there, move its files into “Full Client - LEAD-500” and delete it.`), n);
      assert.match(n, /rename the folder “Full Client - LEAD-500” back to “Full Client - 2026-VV-042”/);
      assert.ok(n.indexOf('is still there, move its files') < n.indexOf('rename the folder'), 'merged first, then renamed back');
    }
    assert.ok(m.notes.filter((x) => x.id === '501').pop().body.includes('on this lead and on Full Client (500).'));
  } finally { restore.forEach((x) => x()); }
});

test('review round 4: a record set aside already that the column search still lists as linked (it lags a write) gets its missing note before the case row goes', async () => {
  const m = world({ rowsByBoard: {}, failNotes: { 500: 2 } });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const D = drive([caseFolder()]);
  let restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.deepEqual(m.deleted, []);
  } finally { restore.forEach((x) => x()); }
  const stale = async (key, val) => (key === 'clientMasterItemId' && String(val) === '900') ? [{ ...L.store.get('500'), clientMasterItemId: '900' }] : [];
  restore = [...stubs(m, L, D.stubs()), stub(leadService, 'findAllByColumnValue', stale)];
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(r.kept.notesPosted, 1);
    assert.equal(m.notes.filter((n) => n.id === '500').length, 1);
    assert.match(m.notes.find((n) => n.id === '500').body, /rename the folder “Full Client - LEAD-500” back/);
    assert.deepEqual(m.deleted, ['900']);
  } finally { undo(restore)(); }
});

test('review round 4: after a stopped Cases-page delete, a list bin on a record still linked is refused — the set-aside record keeps its folder; finish the delete on the Cases page', async () => {
  const m = world({ rowsByBoard: {}, itemBoards: { 501: LEAD_BOARD } });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }, { id: '501', fullName: 'Second Booking', clientMasterItemId: '900' }]);
  const realUpdate = L.updateLead;
  L.updateLead = async (id, f, o) => { if (String(id) === '501') throw new Error('monday 500'); return realUpdate(id, f, o); };
  const D = drive([caseFolder()]);
  let restore = stubs(m, L, D.stubs());
  try {
    assert.equal((await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' })).ok, false);
  } finally { restore.forEach((x) => x()); }
  L.updateLead = realUpdate;
  restore = stubs(m, L, D.stubs());
  try {
    for (const run of [() => deletion.previewDeletion({ leadId: '501' }), () => deletion.executeDeletion({ leadId: '501', confirmText: CASE, expectedKind: 'case' })]) {
      await assert.rejects(run, (e) => e.badRequest && /already set aside Full Client \(500\)/.test(e.message) && /Finish it on the Cases page/.test(e.message) && /Nothing was deleted/.test(e.message));
    }
    assert.deepEqual(m.deleted, []); assert.deepEqual(D.dropped, []);
    assert.equal(L.store.get('501').clientMasterItemId, '900');
  } finally { restore.forEach((x) => x()); }
});

test('review round 4: the Retained tab’s bin deletes a record only — a client whose case is still on the board (active or archived, e.g. "Case not found" from a stale copy) is refused; the window and the server carry the flag', async () => {
  for (const cmState of ['active', 'archived']) {
    const m = world({ cmState, itemBoards: { 500: LEAD_BOARD }, rowsByBoard: CHILDREN });
    const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900' }]);
    const D = drive([caseFolder()]);
    const restore = stubs(m, L, D.stubs());
    try {
      for (const run of [() => deletion.previewDeletion({ leadId: '500', recordOnly: true }), () => deletion.executeDeletion({ leadId: '500', confirmText: CASE, expectedKind: 'case', recordOnly: true })]) {
        await assert.rejects(run, (e) => e.badRequest && /is still on the Cases board/.test(e.message) && /Nothing was deleted/.test(e.message) && (cmState !== 'archived' || /archived in Monday/.test(e.message)), cmState);
      }
      assert.deepEqual(m.deleted, []); assert.deepEqual(D.dropped, []);
      assert.equal((await deletion.previewDeletion({ leadId: '500' })).kind, 'case', 'the other lists: the full delete, as before');
    } finally { restore.forEach((x) => x()); }
  }
  const m = world({ cmState: 'deleted', itemBoards: { 500: LEAD_BOARD } });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900' }]);
  const restore = stubs(m, L, drive([]).stubs());
  try {
    assert.equal((await deletion.previewDeletion({ leadId: '500', recordOnly: true })).kind, 'lead', 'a case in the recycle bin: the record alone');
  } finally { restore.forEach((x) => x()); }
  const { DELETE_UI_JS } = require('../src/routes/adminShared');
  assert.ok(DELETE_UI_JS.includes("(target.recordOnly ? '&recordOnly=1' : '')"));
  assert.ok(DELETE_UI_JS.includes('if (target.recordOnly) body.recordOnly = true;'));
  assert.ok(DELETE_UI_JS.includes("recordOnly: btn.getAttribute('data-del-record-only') === '1'"));
  const ret = require('../src/routes/adminConsultation').buildRetainersHTML();
  assert.ok(ret.includes(`data-del-lead="'+escHtml(c.id)+'"'+(c.adminDelete?' data-del-admin-only="1"':'')+(c.retained?' data-del-record-only="1" title="Delete this consultation record and its OneDrive folder (careful — a folder carrying a case number is kept; refused while the client’s case is still on the Cases board: delete the case there first)"':' title="Delete this client, their consultation record and their OneDrive folder (careful — if there is a case, the case and its checklist go too)"')+'>'`));
  const srv = require('fs').readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.ok(srv.includes("recordOnly: req.query.recordOnly === '1',") && srv.includes('recordOnly: recordOnly === true,'));
});

test('review round 4: a folder that carries a case number is never deleted with a plain record — KEPT and named, whether a case on the Cases board has the number (a duplicate pointing at it) or not (archived, moved, gone); the record itself goes', async () => {
  for (const [live, says] of [['900', /belongs to case 2026-ISS-009, which is on the Cases board — it is KEPT/], [null, /carries case number 2026-ISS-009 — it is KEPT .* If that case is surely gone, remove the folder by hand in OneDrive/]]) {
    const m = world({ cm: null, itemBoards: { 500: LEAD_BOARD } });
    const L = leads([{ id: '500', fullName: 'Harini S', clientMasterItemId: '', oneDriveFolderId: 'od-x' }]);
    const D = drive([{ id: 'od-x', name: 'Harini S - 2026-ISS-009' }, { id: 'od-l', name: 'Harini S - LEAD-500' }]);
    const restore = [...stubs(m, L, D.stubs()), stub(clientMaster, 'findItemByCaseRef', async () => live)];
    try {
      const p = await deletion.previewDeletion({ leadId: '500' });
      assert.equal(p.kind, 'lead');
      assert.deepEqual(p.targets.oneDriveFolders, ['Harini S - LEAD-500'], 'only the record’s own folder goes');
      assert.ok(p.warnings.some((w) => says.test(w)), p.warnings.join(' | '));
      const r = await deletion.executeDeletion({ leadId: '500', confirmText: 'DELETE', expectedKind: 'lead' });
      assert.equal(r.ok, true, JSON.stringify(r.failures));
      assert.deepEqual(D.dropped, ['od-l'], 'the case folder is kept');
      assert.deepEqual(m.deleted, ['500']);
    } finally { undo(restore)(); }
  }
});

test('review round 4: one delete per case at a time — a list bin on a record of a case being deleted from the Cases page is refused', async () => {
  const m = world({ rowsByBoard: {}, itemBoards: { 501: LEAD_BOARD } });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }, { id: '501', fullName: 'Second Booking', clientMasterItemId: '900' }]);
  const D = drive([caseFolder()]);
  let reached, release;
  const atRename = new Promise((r) => { reached = r; }), gate = new Promise((r) => { release = r; });
  const restore = [...stubs(m, L, D.stubs()), stub(oneDrive, 'renameItemById', async (a) => { reached(); await gate; const f = D.root.find((x) => x.id === a.itemId); f.name = a.newName; return { id: f.id, name: f.name }; })];
  try {
    const first = deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    await atRename;
    await assert.rejects(() => deletion.executeDeletion({ leadId: '501', confirmText: CASE, expectedKind: 'case' }), (e) => e.badRequest && /A delete of this case is already running/.test(e.message));
    release();
    const r = await first;
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.deepEqual(m.deleted, ['900']);
  } finally { undo(restore)(); }
});

/* ── review round 4, design check (2026-11-05): the folder by its id, the owner's section, notes that match ── */

const planNote = (p) => ({ id: '900', body: `🗑 plan ${deletion._internal.planMarker({ v: 1, ...p })}` });
const two = () => leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }, { id: '501', fullName: 'Second Booking', clientMasterItemId: '900' }]);

test('design check: a folder rename that LANDS but answers with an error is read back by its id — the delete goes on (the record set aside with its folder), never "could not be renamed"', async () => {
  const m = world({ rowsByBoard: {} });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const D = drive([caseFolder()]);
  const realRename = oneDrive.renameItemById;
  const restore = [...stubs(m, L, D.stubs())];
  const inner = oneDrive.renameItemById;   // the in-memory rename (it lands), then the error
  restore.push(stub(oneDrive, 'renameItemById', async (a) => { await inner(a); throw new Error('504 Gateway Timeout'); }));
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(D.root[0].name, 'Full Client - LEAD-500');
    assert.equal(L.store.get('500').clientMasterItemId, '');
    assert.deepEqual(m.deleted, ['900']);
  } finally { undo(restore)(); assert.equal(oneDrive.renameItemById, realRename); }
});

test('design check: a rename error whose result cannot be read back stops before any record changes, and says the folder may already be renamed', async () => {
  const m = world({ rowsByBoard: {} });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const D = drive([caseFolder()]);
  const restore = [...stubs(m, L, D.stubs())];
  restore.push(stub(oneDrive, 'renameItemById', async () => { throw new Error('504'); }));
  const readById = oneDrive.getDriveItemById;
  restore.push(stub(oneDrive, 'getDriveItemById', async (id) => { if (id === 'od-cm-1') throw new Error('graph down'); return readById(id); }));
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /may or may not have been renamed to “Full Client - LEAD-500”/.test(f) && /check it in OneDrive/.test(f)), r.failures.join(' | '));
    assert.equal(L.writes.length, 0, 'no record changed');
    assert.deepEqual(m.deleted, []);
  } finally { undo(restore)(); }
});

test('design check: an earlier run renamed the folder but its owner was never set aside — when the owner fails again, the folder (by its id) gets its case name back and nothing else changes', async () => {
  const m = world({ rowsByBoard: {} });
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }, { id: '501', name: 'Second Booking' }], id: 'od-cm-1', from: `Full Client - ${CASE}`, to: 'Full Client - LEAD-500', owner: '500' }));
  const L = two();
  const realUpdate = L.updateLead;
  L.updateLead = async (id, f, o) => { if (String(id) === '500') throw new Error('monday 500'); return realUpdate(id, f, o); };
  const D = drive([{ id: 'od-cm-1', name: 'Full Client - LEAD-500' }]);   // renamed by the earlier run; 500 still linked
  const restore = stubs(m, L, D.stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.ok(p.warnings.some((w) => /already renamed back to “Full Client - LEAD-500”/.test(w)));
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.equal(D.root[0].name, `Full Client - ${CASE}`, 'the open case finds its folder again');
    assert.ok(r.failures.some((f) => f.includes(`given its case name “Full Client - ${CASE}” back. Run the delete again`)), r.failures.join(' | '));
    assert.equal(L.store.get('501').clientMasterItemId, '900', 'the other record was not touched');
    assert.deepEqual(m.deleted, []);
  } finally { restore.forEach((x) => x()); }
});

test('design check: a folder ending with the owner’s lead number that is NOT the planned folder (made later — a late signature) is never taken for it; with the rename still owed, the delete refuses until the two are merged', async () => {
  const m = world({ rowsByBoard: {} });
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }], id: 'od-cm-1', from: `Full Client - ${CASE}`, to: 'Full Client - LEAD-500', owner: '500' }));
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '', caseDeleted: `2026-11-05 · ${CASE} · faran@tdotimm.com`, oneDriveFolderId: 'od-cm-1' }]);
  const D = drive([caseFolder(), { id: 'od-stray', name: 'Full Client - LEAD-500' }]);   // the rename was given back; a stray appeared
  const restore = stubs(m, L, D.stubs());
  try {
    for (const run of [() => deletion.previewDeletion({ caseRef: CASE }), () => deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' })]) {
      await assert.rejects(run, (e) => e.badRequest && e.message.includes(`move the files from “Full Client - LEAD-500” into “Full Client - ${CASE}”`) && /Nothing more was changed/.test(e.message));
    }
    assert.deepEqual(D.renamed, []); assert.deepEqual(m.deleted, []);
  } finally { restore.forEach((x) => x()); }
  // merged by hand → the re-run renames the case folder for the record
  D.root.splice(1, 1);
  const restore2 = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(D.root[0].name, 'Full Client - LEAD-500');
    assert.match(m.notes.filter((n) => n.id === '500').pop().body, /rename the folder “Full Client - LEAD-500” back to “Full Client - 2026-VV-042”/);
  } finally { restore2.forEach((x) => x()); }
});

test('design check: a record of the plan that sits in Monday’s recycle bin is no longer kept — it never blocks the delete or gets a note', async () => {
  const m = world({ rowsByBoard: {}, states: { 500: 'deleted' } });
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }, { id: '501', name: 'Second Booking' }] }));
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '', caseDeleted: `2026-11-05 · ${CASE} · x` }, { id: '501', fullName: 'Second Booking', clientMasterItemId: '900' }]);
  const restore = stubs(m, L, drive([]).stubs());
  try {
    const p = await deletion.previewDeletion({ caseRef: CASE });
    assert.deepEqual(p.kept.leadRows, ['Second Booking']);
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(m.notes.filter((n) => n.id === '500').length, 0);
    assert.deepEqual(m.deleted, ['900']);
  } finally { restore.forEach((x) => x()); }
});

test('design check: a record’s note is matched on the marker it has NOW — a note from an earlier, undone delete of the same case does not count', async () => {
  const marker = `2026-11-05 · ${CASE} · faran@tdotimm.com`;
  const m = world({ rowsByBoard: {} });
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }] }));
  m.notes.push({ id: '500', body: `🗑 <b>Case ${CASE} was deleted</b> (2026-09-01 · ${CASE} · old@tdotimm.com). An older delete, undone since.` });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '', caseDeleted: marker }]);
  const restore = stubs(m, L, drive([]).stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(r.kept.notesPosted, 1);
    assert.ok(m.notes.filter((n) => n.id === '500').pop().body.includes(`Case ${CASE} was deleted</b> (${marker})`));
  } finally { restore.forEach((x) => x()); }
});

test('design check: when a re-run notes a NEW plan (here: the rename it can now make), a record an earlier run set aside gets a fresh note with that way back', async () => {
  const m = world({ rowsByBoard: {} });
  const L = two();
  const realUpdate = L.updateLead;
  L.updateLead = async (id, f, o) => { if (String(id) === '501') throw new Error('monday 500'); return realUpdate(id, f, o); };
  const D = drive([caseFolder(), { id: 'od-dup', name: `Full Client copy - ${CASE}` }]);   // two folders: no rename yet
  let restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.match(m.notes.find((n) => n.id === '500').body, /Its OneDrive folder was kept as it is/);
  } finally { restore.forEach((x) => x()); }
  L.updateLead = realUpdate;
  D.root.splice(1, 1);   // staff merged the two folders, as the warning asked
  restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(D.root[0].name, 'Full Client - LEAD-500');
    const n500 = m.notes.filter((n) => n.id === '500');
    assert.equal(n500.length, 2);
    assert.match(n500[1].body, /rename the folder “Full Client - LEAD-500” back to “Full Client - 2026-VV-042”/);
  } finally { restore.forEach((x) => x()); }
});

test('design check: a plan record linked to this case again but missed by the (lagging) search is set aside like any linked record; one linked again while the delete runs keeps the case row', async () => {
  let m = world({ rowsByBoard: {} });
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }, { id: '501', name: 'Second Booking' }] }));
  let L = two();
  let restore = [...stubs(m, L, drive([]).stubs()), stub(leadService, 'findAllByColumnValue', async () => [{ ...L.store.get('501') }])];   // the search misses 500
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(L.store.get('500').clientMasterItemId, '', '500 set aside too');
    assert.ok(L.store.get('500').caseDeleted);
  } finally { undo(restore)(); }
  // linked again by another task right after its note was posted → the case row stays
  m = world({ rowsByBoard: {} });
  L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900' }]);
  const inner = m.fn;
  const fn = async (q, v) => { const out = await inner(q, v); if (/create_update/.test(q) && String(v.id) === '500') L.store.get('500').clientMasterItemId = '900'; return out; };
  restore = [...stubs(m, L, drive([]).stubs()), stub(mondayApi, 'query', fn)];
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /Full Client \(500\) was linked to this case again while the delete ran/.test(f)), r.failures.join(' | '));
    assert.deepEqual(m.deleted, []);
  } finally { undo(restore)(); }
});

test('design check: the plan is found below 100 newer notes (the notes are read page by page)', async () => {
  const m = world();
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }], id: 'od-1', from: 'A', to: 'B', owner: '500' }));
  for (let i = 0; i < 130; i++) m.notes.push({ id: '900', body: `note ${i}` });
  const restore = [stub(mondayApi, 'query', m.fn)];
  try {
    const p = await deletion._internal.readKeepPlan('900');
    assert.equal(p && p.owner, '500');
  } finally { restore.forEach((x) => x()); }
});

test('design check: one delete per case, the lock taken BEFORE anything is read — a list bin holding it refuses the Cases page (and the other way round)', async () => {
  const m = world({ rowsByBoard: {}, itemBoards: { 501: LEAD_BOARD } });
  const L = two();
  const D = drive([caseFolder()]);
  let reached, release;
  const atRead = new Promise((r) => { reached = r; }), gate = new Promise((r) => { release = r; });
  const restore = [...stubs(m, L, D.stubs())];
  const inner = oneDrive.getDriveItemById;
  restore.push(stub(oneDrive, 'getDriveItemById', async (id) => { reached(); await gate; return inner(id); }));
  restore.push(stub(require('../src/services/squareBookingsService'), 'cancelBookingIfActive', async () => ({ cancelled: false, reason: 'none' })));
  try {
    const bin = deletion.executeDeletion({ leadId: '501', confirmText: CASE, expectedKind: 'case' });
    await atRead;
    await assert.rejects(() => deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' }), (e) => e.badRequest && /A delete of this case is already running/.test(e.message));
    release();
    assert.equal((await bin).ok, true);
  } finally { undo(restore)(); }
});

test('design check: the bin on a record that an UNFINISHED Cases-page delete set aside is refused (its folder is still the open case’s); once that delete is finished the record and its own folder can go', async () => {
  const m = world({ rowsByBoard: {}, itemBoards: { 500: LEAD_BOARD } });
  const L = two();
  const realUpdate = L.updateLead;
  L.updateLead = async (id, f, o) => { if (String(id) === '501') throw new Error('monday 500'); return realUpdate(id, f, o); };
  const D = drive([caseFolder()]);
  let restore = stubs(m, L, D.stubs());
  restore.push(stub(clientMaster, 'findItemByCaseRef', async () => (m.deleted.includes('900') ? null : '900')));
  try {
    assert.equal((await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' })).ok, false);
    assert.equal(L.store.get('500').clientMasterItemId, '');
    for (const run of [() => deletion.previewDeletion({ leadId: '500' }), () => deletion.executeDeletion({ leadId: '500', confirmText: 'DELETE', expectedKind: 'lead' })]) {
      await assert.rejects(run, (e) => e.badRequest && /set aside by a delete of case 2026-VV-042 from the Cases page that has not finished/.test(e.message) && /Nothing was deleted/.test(e.message));
    }
    assert.deepEqual(D.dropped, []);
  } finally { undo(restore)(); }
  L.updateLead = realUpdate;
  restore = stubs(m, L, D.stubs());
  restore.push(stub(clientMaster, 'findItemByCaseRef', async () => (m.deleted.includes('900') ? null : '900')));
  try {
    assert.equal((await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' })).ok, true);
    const p = await deletion.previewDeletion({ leadId: '500' });
    assert.equal(p.kind, 'lead');
    assert.deepEqual(p.targets.oneDriveFolders, ['Full Client - LEAD-500'], 'the record’s own folder (no case number) goes with it');
  } finally { undo(restore)(); }
});

test('design check: the folder’s owner busy (another task holds it) — nothing is renamed or changed', async () => {
  const m = world({ rowsByBoard: {} });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const D = drive([caseFolder()]);
  const restore = stubs(m, L, D.stubs());
  const prev = deletion._internal.timing.ownerLockMs;
  deletion._internal.timing.ownerLockMs = 30;
  let release;
  const held = require('../src/services/leadMutex').withLeadLock('500', () => new Promise((r) => { release = r; }));
  const keepAlive = setInterval(() => {}, 1000);   // the lock's wait timer is unref'd: keep the test's event loop up
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /Full Client \(500\) is busy/.test(f) && /it was not changed/.test(f)), r.failures.join(' | '));
    assert.deepEqual(D.renamed, []); assert.equal(L.writes.length, 0); assert.deepEqual(m.deleted, []);
  } finally { clearInterval(keepAlive); release(); await held; deletion._internal.timing.ownerLockMs = prev; restore.forEach((x) => x()); }
});

/* ── review round 5 (2026-11-05): notes by fingerprint, the owner read first, unfinished deletes found by item id ── */

const marked = (extra = {}) => ({ id: '500', fullName: 'Full Client', clientMasterItemId: '', caseDeleted: `2026-11-05 · ${CASE} · faran@tdotimm.com · item 900`, oneDriveFolderId: 'od-cm-1', ...extra });

test('round 5: a note written under an older plan never counts — after a run that noted a new plan stopped, the next run re-posts the note with the current way back', async () => {
  const m = world({ rowsByBoard: {} });
  const L = two();
  const realUpdate = L.updateLead;
  L.updateLead = async (id, f, o) => { if (String(id) === '501') throw new Error('monday 500'); return realUpdate(id, f, o); };
  const D = drive([caseFolder(), { id: 'od-dup', name: `Full Client copy - ${CASE}` }]);   // two folders: no rename in run 1
  let restore = stubs(m, L, D.stubs());
  try { assert.equal((await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' })).ok, false); } finally { restore.forEach((x) => x()); }
  D.root.splice(1, 1);   // merged by hand
  restore = [...stubs(m, L, D.stubs()), stub(oneDrive, 'renameItemById', async () => { throw new Error('503'); })];
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false, 'run 2 notes the new plan (the rename), then stops on the rename');
    assert.equal(m.notes.filter((n) => n.id === '900').length, 2);
  } finally { undo(restore)(); }
  L.updateLead = realUpdate;
  restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    const n500 = m.notes.filter((n) => n.id === '500');
    assert.equal(n500.length, 2, 'the old note (no folder step) did not count');
    assert.match(n500[1].body, /rename the folder “Full Client - LEAD-500” back to “Full Client - 2026-VV-042”/);
    assert.match(n500[1].body, /⟦way [0-9a-f]{10}⟧$/);
  } finally { restore.forEach((x) => x()); }
});

test('round 5: a folder the open case makes WHILE the delete runs keeps the case row; the re-run names it in the plan and in every record’s note', async () => {
  const m = world({ rowsByBoard: {} });
  const L = two();
  const D = drive([caseFolder()]);
  const inner = m.fn;
  const fn = async (q, v) => { const out = await inner(q, v); if (/create_update/.test(q) && String(v.id) === '501' && !D.root.some((f) => f.id === 'od-new')) D.root.push({ id: 'od-new', name: `Full Client - ${CASE}` }); return out; };
  let restore = [...stubs(m, L, D.stubs()), stub(mondayApi, 'query', fn)];
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.includes(`A folder carrying the case number, “Full Client - ${CASE}”, was made while the delete ran`)), r.failures.join(' | '));
    assert.deepEqual(m.deleted, []);
  } finally { undo(restore)(); }
  restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    for (const id of ['500', '501']) assert.ok(m.notes.filter((n) => n.id === id).pop().body.includes(`<b>Files added while the delete was stopped</b> are in “Full Client - ${CASE}”`), id);
    assert.deepEqual(m.deleted, ['900']);
    assert.deepEqual(D.root.map((f) => f.name), ['Full Client - LEAD-500', `Full Client - ${CASE}`]);
  } finally { restore.forEach((x) => x()); }
});

test('round 5: the folder’s owner is read FIRST — a read that fails changes nothing, and an owner already set aside never loses its folder', async () => {
  const m = world({ rowsByBoard: {} });
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }, { id: '501', name: 'Second Booking' }], id: 'od-cm-1', from: `Full Client - ${CASE}`, to: 'Full Client - LEAD-500', owner: '500' }));
  const L = leads([marked(), { id: '501', fullName: 'Second Booking', clientMasterItemId: '900' }]);
  const realGet = L.getLead;
  let reads500 = 0;
  L.getLead = async (id) => { if (String(id) === '500' && ++reads500 === 2) throw new Error('monday 502'); return realGet(id); };   // 1st: the graph; 2nd: the owner's section
  const D = drive([{ id: 'od-cm-1', name: 'Full Client - LEAD-500' }]);
  const restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /Full Client \(500\) could not be read \(monday 502\) — it and its folder were not changed/.test(f)), r.failures.join(' | '));
    assert.equal(D.root[0].name, 'Full Client - LEAD-500', 'never given back: the record is set aside and the folder is its own');
    assert.deepEqual(D.renamed, []);
    assert.equal(L.store.get('501').clientMasterItemId, '900');
    assert.deepEqual(m.deleted, []);
  } finally { restore.forEach((x) => x()); }
});

test('round 5: the bin on a record an unfinished delete set aside is refused also when that case row was archived or moved since — found by the item id its marker carries', async () => {
  for (const [opts, says] of [
    [{ cmState: 'archived', itemBoards: { 500: LEAD_BOARD } }, /archived in Monday: restore it from the archive/],
    [{ cm: null, itemBoards: { 500: LEAD_BOARD, 900: '18400000001' } }, /on the Monday board “board 18400000001”, not the Cases board: move it back/],
  ]) {
    const m = world({ rowsByBoard: {}, ...opts });
    const L = leads([marked()]);
    const D = drive([{ id: 'od-cm-1', name: 'Full Client - LEAD-500' }]);
    const restore = [...stubs(m, L, D.stubs()), stub(clientMaster, 'findItemByCaseRef', async () => null)];   // the case-number search cannot see it
    try {
      for (const run of [() => deletion.previewDeletion({ leadId: '500', recordOnly: true }), () => deletion.executeDeletion({ leadId: '500', confirmText: 'DELETE', expectedKind: 'lead', recordOnly: true })]) {
        await assert.rejects(run, (e) => e.badRequest && /set aside by a delete of case 2026-VV-042 from the Cases page that has not finished/.test(e.message) && says.test(e.message), String(says));
      }
      assert.deepEqual(D.dropped, []); assert.deepEqual(m.deleted, []);
    } finally { undo(restore)(); }
  }
});

test('round 5: the "merge first" refusal decides on a FRESH read of the plan’s owner — a lagging search that still shows it linked does not let a second LEAD folder through', async () => {
  const m = world({ rowsByBoard: {} });
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }], id: 'od-cm-1', from: `Full Client - ${CASE}`, to: 'Full Client - LEAD-500', owner: '500' }));
  const L = leads([marked()]);
  const D = drive([caseFolder(), { id: 'od-stray', name: 'Full Client - LEAD-500' }]);
  const restore = [...stubs(m, L, D.stubs()), stub(leadService, 'findAllByColumnValue', async () => [{ ...L.store.get('500'), clientMasterItemId: '900' }])];
  try {
    await assert.rejects(() => deletion.previewDeletion({ caseRef: CASE }), (e) => e.badRequest && e.message.includes(`move the files from “Full Client - LEAD-500” into “Full Client - ${CASE}”`));
  } finally { undo(restore)(); }
});

test('round 5: the folder’s owner linked again at the very end (a signature handled meanwhile) keeps the case row AND gives the open case its folder back', async () => {
  const m = world({ rowsByBoard: {} });
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const D = drive([caseFolder()]);
  const inner = m.fn;
  const fn = async (q, v) => { const out = await inner(q, v); if (/create_update/.test(q) && String(v.id) === '500') L.store.get('500').clientMasterItemId = '900'; return out; };
  const restore = [...stubs(m, L, D.stubs()), stub(mondayApi, 'query', fn)];
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /was linked to this case again while the delete ran/.test(f)));
    assert.equal(D.root[0].name, `Full Client - ${CASE}`, 'the folder is the open case’s again');
    assert.deepEqual(m.deleted, []);
  } finally { undo(restore)(); }
});

test('round 5: a busy owner whose folder an EARLIER run renamed while it stayed linked — the open case gets its folder back (an unlocked read decides)', async () => {
  const m = world({ rowsByBoard: {} });
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }], id: 'od-cm-1', from: `Full Client - ${CASE}`, to: 'Full Client - LEAD-500', owner: '500' }));
  const L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900', oneDriveFolderId: 'od-cm-1' }]);
  const D = drive([{ id: 'od-cm-1', name: 'Full Client - LEAD-500' }]);
  const restore = stubs(m, L, D.stubs());
  const prev = deletion._internal.timing.ownerLockMs;
  deletion._internal.timing.ownerLockMs = 30;
  let release;
  const held = require('../src/services/leadMutex').withLeadLock('500', () => new Promise((r) => { release = r; }));
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /is busy/.test(f)));
    assert.equal(D.root[0].name, `Full Client - ${CASE}`);
    assert.equal(L.writes.length, 0);
  } finally { clearInterval(keepAlive); release(); await held; deletion._internal.timing.ownerLockMs = prev; restore.forEach((x) => x()); }
});

test('round 5: a plan record linked again but sitting in Monday’s recycle bin is not kept (never written to)', async () => {
  const m = world({ rowsByBoard: {}, states: { 500: 'deleted' } });
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }, { id: '501', name: 'Second Booking' }] }));
  const L = two();
  const restore = [...stubs(m, L, drive([]).stubs()), stub(leadService, 'findAllByColumnValue', async () => [{ ...L.store.get('501') }])];
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.ok(!L.writes.some((w) => w.id === '500'), 'nothing written to a record in the recycle bin');
  } finally { undo(restore)(); }
});

test('round 5: wording — a record whose case went away since the preview, and a Retained-tab refusal for an archived case without a number', async () => {
  let m = world({ cmState: 'deleted', itemBoards: { 500: LEAD_BOARD } });
  let L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900' }]);
  let restore = stubs(m, L, drive([]).stubs());
  try {
    await assert.rejects(() => deletion.executeDeletion({ leadId: '500', confirmText: CASE, expectedKind: 'case' }), (e) => e.badRequest && /its case was deleted or unlinked meanwhile/.test(e.message) && !/it now has an open case/.test(e.message));
  } finally { restore.forEach((x) => x()); }
  m = world({ cm: { id: '900', name: 'Full Client', caseRef: '' }, cmState: 'archived', itemBoards: { 500: LEAD_BOARD } });
  L = leads([{ id: '500', fullName: 'Full Client', clientMasterItemId: '900' }]);
  restore = stubs(m, L, drive([]).stubs());
  try {
    await assert.rejects(() => deletion.previewDeletion({ leadId: '500', recordOnly: true }), (e) => e.badRequest && /has no case number, so the Cases page cannot delete it — ask for help/.test(e.message) && !/restore it from the archive/.test(e.message));
  } finally { restore.forEach((x) => x()); }
});

test('round 5: a set-aside record whose note still cannot be added keeps the case row (the "aside-no-note" path)', async () => {
  const m = world({ rowsByBoard: {}, failNotes: { 500: 2 } });
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }] }));
  const L = leads([marked()]);
  const restore = stubs(m, L, drive([]).stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.includes('The note with the way back could not be added on Full Client (500)')), r.failures.join(' | '));
    assert.deepEqual(m.deleted, []);
  } finally { restore.forEach((x) => x()); }
});

test('round 5: refusals that must fail closed — the plan of a case cannot be read (list bin), the case of a set-aside record cannot be looked up (its own bin)', async () => {
  let m = world({ rowsByBoard: {}, itemBoards: { 501: LEAD_BOARD } });
  let L = two();
  const inner = m.fn;
  let restore = [...stubs(m, L, drive([caseFolder()]).stubs()), stub(mondayApi, 'query', async (q, v) => { if (/updates/.test(q)) throw new Error('monday 503'); return inner(q, v); })];
  try {
    await assert.rejects(() => deletion.previewDeletion({ leadId: '501' }), (e) => e.badRequest && /The case’s notes could not be read \(monday 503\) — nothing was deleted/.test(e.message));
  } finally { undo(restore)(); }
  m = world({ itemBoards: { 500: LEAD_BOARD } });
  L = leads([marked()]);
  const inner2 = m.fn;
  restore = [...stubs(m, L, drive([]).stubs()), stub(mondayApi, 'query', async (q, v) => { if (/column_values/.test(q) && /state board/.test(q)) throw new Error('monday 503'); return inner2(q, v); })];
  try {
    await assert.rejects(() => deletion.previewDeletion({ leadId: '500' }), (e) => e.badRequest && /Case 2026-VV-042 could not be looked up \(monday 503\) — nothing was deleted/.test(e.message));
  } finally { undo(restore)(); }
});

test('round 5: the folder’s owner linked to ANOTHER case by the time its section runs — nothing is renamed, nothing else changes', async () => {
  const m = world({ rowsByBoard: {} });
  const L = two();
  L.store.get('500').clientMasterItemId = '777';   // its fresh read says: another case
  const restore = [...stubs(m, L, drive([caseFolder()]).stubs()), stub(leadService, 'findAllByColumnValue', async () => [{ ...L.store.get('500'), clientMasterItemId: '900' }, { ...L.store.get('501') }])];
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /Full Client \(500\) is no longer linked to this case \(changed meanwhile\)/.test(f)));
    assert.ok(r.failures.some((f) => /Its folder and the other records were not changed/.test(f)));
    assert.equal(L.store.get('501').clientMasterItemId, '900');
    assert.equal(L.writes.length, 0);
  } finally { undo(restore)(); }
});

test('round 5: a run refused by the per-case lock leaves the lock with the run that holds it', async () => {
  const m = world({ rowsByBoard: {}, itemBoards: { 500: LEAD_BOARD, 501: LEAD_BOARD } });
  const L = two();
  const D = drive([caseFolder()]);
  let reached, release;
  const atRename = new Promise((r) => { reached = r; }), gate = new Promise((r) => { release = r; });
  const restore = [...stubs(m, L, D.stubs()), stub(oneDrive, 'renameItemById', async (a) => { reached(); await gate; const f = D.root.find((x) => x.id === a.itemId); f.name = a.newName; return { id: f.id, name: f.name }; })];
  try {
    const first = deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    await atRename;
    for (const leadId of ['501', '500']) {   // the second refusal proves the first did not free the lock
      await assert.rejects(() => deletion.executeDeletion({ leadId, confirmText: CASE, expectedKind: 'case' }), (e) => e.badRequest && /A delete of this case is already running/.test(e.message), leadId);
    }
    release();
    assert.equal((await first).ok, true);
  } finally { undo(restore)(); }
});

test('round 5 last check: an owner set aside when the run started keeps its folder even if its record changes while the run goes (staff clear "Case deleted")', async () => {
  const m = world({ rowsByBoard: {} });
  m.notes.push(planNote({ leads: [{ id: '500', name: 'Full Client' }, { id: '501', name: 'Second Booking' }], id: 'od-cm-1', from: `Full Client - ${CASE}`, to: 'Full Client - LEAD-500', owner: '500' }));
  const L = leads([marked(), { id: '501', fullName: 'Second Booking', clientMasterItemId: '900' }]);
  const realGet = L.getLead;
  let reads500 = 0;
  L.getLead = async (id) => { const r = await realGet(id); if (String(id) === '500' && ++reads500 === 2) return { ...r, caseDeleted: '' }; return r; };   // cleared by staff between the graph and the owner's section
  const D = drive([{ id: 'od-cm-1', name: 'Full Client - LEAD-500' }]);
  const restore = stubs(m, L, D.stubs());
  try {
    const r = await deletion.executeDeletion({ caseRef: CASE, confirmText: CASE, expectedKind: 'case' });
    assert.equal(r.ok, false);
    assert.equal(D.root[0].name, 'Full Client - LEAD-500', 'the folder stays with the record it was given to');
    assert.ok(r.failures.some((f) => /Its folder and the other records were not changed/.test(f)), r.failures.join(' | '));
    assert.deepEqual(D.renamed, []);
  } finally { restore.forEach((x) => x()); }
});
