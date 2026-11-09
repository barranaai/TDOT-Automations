'use strict';

// Lead-only delete (Faran 2026-11-09, step 3 decision 6): staff on
// LEAD_DELETE_EMAILS (empty by default), signed in with Monday, may delete a
// LEAD with no case and no retainer — never a case. Not admin. Named admins
// work exactly as before. The lead is read fresh and checked again inside the
// delete itself.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const deletion    = require('../src/services/deletionService');
const mondayApi   = require('../src/services/mondayApi');
const leadService = require('../src/services/leadService');
const oneDrive    = require('../src/services/oneDriveService');
const clientMaster = require('../src/services/clientMasterService');
const leadDelete  = require('../config/leadDelete');
const { deleterCheck } = require('../src/utils/staffIdentity');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function withEnv(v, fn) { const b = process.env.LEAD_DELETE_EMAILS; if (v === undefined) delete process.env.LEAD_DELETE_EMAILS; else process.env.LEAD_DELETE_EMAILS = v; try { return fn(); } finally { if (b === undefined) delete process.env.LEAD_DELETE_EMAILS; else process.env.LEAD_DELETE_EMAILS = b; } }

const LEAD_BOARD = '18416845157';
const isAdmin = (e) => e === 'faran@tdotimm.com';
const GAURI = { name: 'Gauri Berde', email: 'Gauri@tdotimm.com' };

test('the list is empty by default: nobody may delete leads', () => {
  withEnv(undefined, () => {
    assert.deepEqual(leadDelete.allowedEmails(), []);
    assert.equal(leadDelete.canDeleteLeads(GAURI), false);
    const r = deleterCheck(GAURI, isAdmin, leadDelete.canDeleteLeads);
    assert.equal(r.ok, false); assert.equal(r.status, 403);
  });
});

test('listed + Monday sign-in → lead-only; the shared key alone → 401; a named admin → all (unchanged)', () => {
  withEnv('gauri@tdotimm.com, melanie@tdotimm.com', () => {
    const r = deleterCheck(GAURI, isAdmin, leadDelete.canDeleteLeads);
    assert.equal(r.ok, true); assert.equal(r.scope, 'lead-only'); assert.equal(r.actor.email, 'Gauri@tdotimm.com');
    const k = deleterCheck(null, isAdmin, leadDelete.canDeleteLeads);
    assert.equal(k.ok, false); assert.equal(k.status, 401);
    const a = deleterCheck({ name: 'Faran', email: 'faran@tdotimm.com' }, isAdmin, leadDelete.canDeleteLeads);
    assert.equal(a.ok, true); assert.equal(a.scope, 'all');
    const o = deleterCheck({ name: 'X', email: 'x@tdotimm.com' }, isAdmin, leadDelete.canDeleteLeads);
    assert.equal(o.ok, false); assert.equal(o.status, 403); assert.match(o.error, /Only admins can delete records/);
  });
});

/** Monday: the lead pinned to the Lead Board; delete_item recorded. */
function world(lead, { folder = null } = {}) {
  const deleted = [];
  let current = lead;
  const r = [
    stub(mondayApi, 'query', async (q, vars) => {
      if (/delete_item/.test(q)) { const ids = vars && vars.id ? [String(vars.id)] : [...q.matchAll(/delete_item\(item_id:\s*(\d+)\)/g)].map((m) => m[1]); deleted.push(...ids); return {}; }
      if (/items\(ids/.test(q)) { if (/column_values/.test(q)) return { items: [] }; return { items: [{ id: String(vars.id), board: { id: LEAD_BOARD } }] }; }
      return {};
    }),
    stub(leadService, 'getLead', async () => (typeof current === 'function' ? current() : current)),
    stub(oneDrive, 'getDriveItemById', async () => null),
    stub(oneDrive, 'getClientFolderByName', async () => folder),
    stub(oneDrive, 'deleteDriveItem', async () => true),
    stub(clientMaster, 'findItemByCaseRef', async () => null),
  ];
  const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {};
  return { deleted, set(x) { current = x; }, restore() { r.forEach((x) => x()); console.log = l; console.warn = w; } };
}
const PLAIN = { id: '500', fullName: 'Solo Lead', clientMasterItemId: '' };

test('lead-only: a lead with no case is previewed and deleted (typed DELETE)', async () => {
  const w = world(PLAIN);
  try {
    const p = await deletion.previewDeletion({ leadId: '500', leadOnly: true });
    assert.equal(p.kind, 'lead');
    const r = await deletion.executeDeletion({ leadId: '500', confirmText: 'DELETE', expectedKind: 'lead', actor: 'gauri@tdotimm.com', leadOnly: true });
    assert.equal(r.ok, true);
    assert.deepEqual(w.deleted, ['500']);
  } finally { w.restore(); }
});

const REFUSED = [
  ['a Client Master id (live or gone)', { clientMasterItemId: '900' }],
  ['a case-deleted marker', { caseDeleted: '2026-11-05 · 2026-VV-042 · faran · item 900' }],
  ['a direct retainer client', { directClient: 'Yes' }],
  ['an old direct retainer client', { sourceChannel: 'Direct Retainer' }],
  ['a walk-in whose case opened early (direct, with a case id)', { directClient: 'Yes', clientMasterItemId: '901' }],
  ['Retained', { conversionStatus: 'Retained' }],
  ['a retainer sent', { retainerSent: '2026-11-01' }],
  ['a retainer signed', { retainerSigned: '2026-11-01' }],
  ['a retainer paid', { retainerPaid: '2026-11-01' }],
];
for (const [name, extra] of REFUSED) {
  test(`lead-only refuses ${name} — preview and execute, nothing deleted`, async () => {
    const w = world({ ...PLAIN, ...extra });
    try {
      await assert.rejects(deletion.previewDeletion({ leadId: '500', leadOnly: true }), (e) => e.badRequest && e.message === deletion.LEAD_ONLY_REFUSAL);
      await assert.rejects(deletion.executeDeletion({ leadId: '500', confirmText: 'DELETE', expectedKind: 'lead', actor: 'g', leadOnly: true }), (e) => e.badRequest && e.message === deletion.LEAD_ONLY_REFUSAL);
      assert.deepEqual(w.deleted, []);
    } finally { w.restore(); }
  });
}

test('lead-only: a case number, the Retained record bin, or no leadId → refused', async () => {
  const w = world(PLAIN);
  try {
    await assert.rejects(deletion.previewDeletion({ caseRef: '2026-VV-042', leadOnly: true }), /Only admins can delete cases/);
    await assert.rejects(deletion.executeDeletion({ caseRef: '2026-VV-042', confirmText: '2026-VV-042', expectedKind: 'case', leadOnly: true }), /Only admins can delete cases/);
    await assert.rejects(deletion.previewDeletion({ leadId: '500', recordOnly: true, leadOnly: true }), (e) => e.message === deletion.LEAD_ONLY_REFUSAL);
    await assert.rejects(deletion.executeDeletion({ leadId: '500', confirmText: 'DELETE', expectedKind: 'case', leadOnly: true }), /open it again/);
    assert.deepEqual(w.deleted, []);
  } finally { w.restore(); }
});

test('lead-only: a lead that gains a case between the preview and the delete is refused inside the delete', async () => {
  const w = world(PLAIN);
  try {
    const p = await deletion.previewDeletion({ leadId: '500', leadOnly: true });
    assert.equal(p.kind, 'lead');
    w.set({ ...PLAIN, clientMasterItemId: '900' });
    await assert.rejects(deletion.executeDeletion({ leadId: '500', confirmText: 'DELETE', expectedKind: 'lead', actor: 'g', leadOnly: true }), (e) => e.message === deletion.LEAD_ONLY_REFUSAL);
    assert.deepEqual(w.deleted, []);
  } finally { w.restore(); }
});

test('lead-only: a folder carrying a case number refuses (an admin decides)', async () => {
  const w = world(PLAIN, { folder: { id: 'f1', name: 'Solo Lead - 2026-VV-042', parentPath: '/drive/root:/Client Documents' } });
  try {
    await assert.rejects(deletion.previewDeletion({ leadId: '500', leadOnly: true }), (e) => e.message === deletion.LEAD_ONLY_REFUSAL);
  } finally { w.restore(); }
});

test('the server: both delete routes use the deleter gate, refuse a case for lead-only, log the permission; the viewer says canDeleteLeads', () => {
  const SERVER = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const pv = SERVER.slice(SERVER.indexOf("app.get('/admin/delete/preview'"), SERVER.indexOf("app.post('/admin/delete/execute'"));
  assert.match(pv, /if \(leadOnly && \(caseRef \|\| req\.query\.recordOnly === '1'\)\) return res\.status\(403\)/);
  assert.match(pv, /leadOnly,\n/);
  const ex = SERVER.slice(SERVER.indexOf("app.post('/admin/delete/execute'"), SERVER.indexOf("app.post('/admin/delete/execute'") + 1400);
  assert.match(ex, /if \(leadOnly && \(String\(caseRef \|\| ''\)\.trim\(\) \|\| recordOnly === true\)\) return res\.status\(403\)/);
  assert.match(ex, /leadOnly,\n/);
  assert.match(SERVER, /canDeleteLeads: require\('\.\.\/config\/leadDelete'\)\.canDeleteLeads\(staff\),/);
  const svc = fs.readFileSync(require.resolve('../src/services/deletionService.js'), 'utf8');
  assert.match(svc, /\$\{leadOnly \? ' \(lead-only permission\)' : ''\} deleted/);
  const shared = fs.readFileSync(require.resolve('../src/routes/adminShared.js'), 'utf8');
  assert.ok(shared.includes("v.canDeleteLeads ? '.del-btn:not([data-del-lead]),.del-btn[data-del-record-only],.del-btn[data-del-admin-only]{display:none!important}'"));
});

test('lead-only staff see no bin on a Consultations/Retainers row the server would refuse (review 2026-11-09)', async () => {
  const snap = require('../src/services/leadSnapshot');
  const portal = require('../src/services/consultantPortalService');
  snap._reset();
  const L = (id, over = {}) => ({ id: String(id), name: 'Lead ' + id, fullName: 'Lead ' + id, createdAt: '2026-10-01T12:00:00Z', ...over });
  const rows = [
    L(1, { bookingStatus: 'Booked', bookedSlot: '2026-10-20 11:00' }),
    L(2, { bookingStatus: 'Booked', bookedSlot: '2026-10-21 11:00', clientMasterItemId: '77' }),
    L(3, { bookingStatus: 'Booked', outcome: 'Retain', bookedSlot: '2026-10-09 10:00' }),
    L(4, { bookingStatus: 'Booked', bookedSlot: '2026-10-09 10:00', retainerSent: '2026-10-10' }),
    L(5, { sourceChannel: 'Direct Retainer' }),
  ];
  const orig = snap.io.fetchLeads; snap.io.fetchLeads = async () => rows;
  try {
    const b = await portal.getConsultationsBoard({ now: new Date('2026-10-15T16:00:00Z') });
    const flag = (list) => Object.fromEntries(list.map((r) => [r.id, !!r.adminDelete]));
    assert.deepEqual(flag(b.consultations), { 1: false, 2: true });
    assert.deepEqual(flag(b.retainers), { 3: false, 4: true, 5: true });
  } finally { snap.io.fetchLeads = orig; snap._reset(); }
  const page = fs.readFileSync(require.resolve('../src/routes/adminConsultation.js'), 'utf8');
  assert.equal(page.split(`(c.adminDelete?' data-del-admin-only="1"':'')`).length - 1, 2, 'both bins carry the mark');
  const shared = fs.readFileSync(require.resolve('../src/routes/adminShared.js'), 'utf8');
  assert.ok(shared.includes('.del-btn[data-del-admin-only]{display:none!important}'));
});
