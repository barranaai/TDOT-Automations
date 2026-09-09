'use strict';

// One client, ONE documents folder (Gauri 2026-09-04, point 12 — piece 1).
//
// A client's folder is created at lead stage as "{Name} - LEAD-{id}" and
// renamed to "{Name} - {Case Ref}" when the reference is assigned. Two things
// were splitting it into two folders for walk-in clients:
//   1. the RACE — the case was opened in the same request that created the
//      lead, ~2-4s before the folder id landed, so the case row never carried
//      it, the rename silently no-opped, and the next case-ref-addressed write
//      created a second folder (86 live cases);
//   2. RESURRECTION — writes still addressed "LEAD-{id}" after a successful
//      rename cannot match by reference, so they re-create the old folder.
// Fixing only one converts one kind of split into the other, so both are here,
// plus the reads that must keep working once folders really get renamed.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const mondayApi   = require('../src/services/mondayApi');
const oneDrive    = require('../src/services/oneDriveService');
const leadService = require('../src/services/leadService');
const folderRefs  = require('../src/utils/clientFolderRefs');
const handoff     = require('../src/services/handoffService');
const caseRefSvc  = require('../src/services/caseRefService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const CASE_REF_ROW = (ref) => ({ items: [{ column_values: [{ text: ref }] }] });

// ─── The shared rule: where does this client's file belong? ──────────────────

test('folder refs: the case folder comes first once a case exists; the lead folder is the fallback', async () => {
  const restore = stub(mondayApi, 'query', async () => CASE_REF_ROW('2026-CEC-PS-089'));
  try {
    const refs = await folderRefs.candidateFolderRefs({ id: '77', fullName: 'Rahul Gadamsetti', clientMasterItemId: '900' });
    assert.deepEqual(refs, [
      { clientName: 'Rahul Gadamsetti', caseRef: '2026-CEC-PS-089' },
      { clientName: 'Rahul Gadamsetti', caseRef: 'LEAD-77' },
    ]);
    assert.deepEqual(await folderRefs.writeRef({ id: '77', fullName: 'Rahul Gadamsetti', clientMasterItemId: '900' }),
      { clientName: 'Rahul Gadamsetti', caseRef: '2026-CEC-PS-089' }, 'new files go to the case folder');
  } finally { restore(); }
});

test('folder refs: no case, or an unreadable one, leaves exactly the lead folder — never a guess', async () => {
  const noCase = await folderRefs.candidateFolderRefs({ id: '77', fullName: 'A B' });
  assert.deepEqual(noCase, [{ clientName: 'A B', caseRef: 'LEAD-77' }]);
  const blank = stub(mondayApi, 'query', async () => CASE_REF_ROW(''));
  try {
    assert.deepEqual(await folderRefs.candidateFolderRefs({ id: '77', fullName: 'A B', clientMasterItemId: '900' }),
      [{ clientName: 'A B', caseRef: 'LEAD-77' }], 'a case with no reference yet is not a folder name');
  } finally { blank(); }
  const boom = stub(mondayApi, 'query', async () => { throw new Error('Monday 500'); });
  try {
    assert.deepEqual(await folderRefs.candidateFolderRefs({ id: '77', fullName: 'A B', clientMasterItemId: '900' }),
      [{ clientName: 'A B', caseRef: 'LEAD-77' }], 'an outage degrades to the lead folder, it does not throw');
  } finally { boom(); }
});

test('folder refs: a read tries the case folder, then the lead folder; a storage failure surfaces instead of serving the older copy', async () => {
  const restore = stub(mondayApi, 'query', async () => CASE_REF_ROW('2026-SP-001'));
  const lead = { id: '77', fullName: 'A B', clientMasterItemId: '900' };
  const where = { subfolder: 'Intake', filename: 'x.json' };
  const tried = [];
  const od = { readFile: async ({ caseRef }) => { tried.push(caseRef); return caseRef === 'LEAD-77' ? Buffer.from('old file') : null; } };
  try {
    const buf = await folderRefs.readFirst(od, lead, where);
    assert.equal(buf.toString(), 'old file', 'a file written before the case existed is still found');
    assert.deepEqual(tried, ['2026-SP-001', 'LEAD-77']);
    // readFile returns null for absent and THROWS otherwise: a 503 on the case
    // folder must NOT quietly hand back the stale pre-rename copy.
    const od2 = { readFile: async ({ caseRef }) => { if (caseRef === '2026-SP-001') throw new Error('Graph 503'); return Buffer.from('stale'); } };
    await assert.rejects(() => folderRefs.readFirst(od2, lead, where), /Graph 503/);
    // Nothing anywhere → null, never an exception.
    assert.equal(await folderRefs.readFirst({ readFile: async () => null }, lead, where), null);
  } finally { restore(); }
});

test('folder refs: a write goes to the folder that EXISTS — the case name only once something carries it', async () => {
  const restore = stub(mondayApi, 'query', async () => CASE_REF_ROW('2026-SP-001'));
  const lead = { id: '77', fullName: 'A B', clientMasterItemId: '900' };
  try {
    const od = (present) => ({
      getClientFolderByName: async (n) => (n === present ? { id: 'F', name: n } : null),
      findCaseFolderByRef:   async (r) => (present.endsWith(` - ${r}`) ? { id: 'F', name: present } : null),
    });
    assert.equal((await folderRefs.writeRef(lead, od('A B - 2026-SP-001'))).caseRef, '2026-SP-001', 'renamed already → the case folder');
    // The case reference is written to Monday a moment BEFORE the folder is
    // renamed. Naming the case folder in that window would create it as a
    // SECOND folder and make the rename fail — so the lead folder wins while
    // it is still the one that exists; the rename carries the file across.
    assert.equal((await folderRefs.writeRef(lead, od('A B - LEAD-77'))).caseRef, 'LEAD-77', 'not renamed yet → the lead folder');
    assert.equal((await folderRefs.writeRef(lead, od('nothing'))).caseRef, '2026-SP-001', 'neither exists → create the final name');
    const boom = { getClientFolderByName: async () => { throw new Error('Graph 503'); }, findCaseFolderByRef: async () => null };
    assert.equal((await folderRefs.writeRef(lead, boom)).caseRef, '2026-SP-001', 'cannot tell → the final name, never a new LEAD folder');

    // The client-name half of a folder name DRIFTS — staff append a client
    // number to the Monday item — but the " - {ref}" suffix never does. An
    // exact-name miss is therefore not proof of absence: taking it as one would
    // send the write to a case folder that does not exist yet and mint the
    // duplicate this whole change exists to prevent.
    const drifted = {
      getClientFolderByName: async () => null,                       // "A B - LEAD-77" no longer matches
      findCaseFolderByRef:   async (r) => (r === 'LEAD-77' ? { id: 'F', name: 'A (2720) - LEAD-77' } : null),
    };
    assert.equal((await folderRefs.writeRef(lead, drifted)).caseRef, 'LEAD-77',
      'the lead folder is found by its reference even after the client name changed');

    // A failure of the CHEAP probe must not foreclose the authoritative one.
    const flaky = {
      getClientFolderByName: async () => { throw new Error('Graph 429'); },
      findCaseFolderByRef:   async (r) => (r === 'LEAD-77' ? { id: 'F', name: 'A B - LEAD-77' } : null),
    };
    assert.equal((await folderRefs.writeRef(lead, flaky)).caseRef, 'LEAD-77',
      'the exact-name probe failing still leaves the reference lookup to answer');

    // The case folder is PROVEN absent, then the lead probe cannot answer.
    // Naming the case folder would create it beside the real one and 409 the
    // pending rename, so the lead folder — which the rename carries across — wins.
    const halfBlind = {
      getClientFolderByName: async (n) => { if (n.endsWith('LEAD-77')) throw new Error('Graph 503'); return null; },
      findCaseFolderByRef:   async (r) => { if (r === 'LEAD-77') throw new Error('Graph 503'); return null; },
    };
    assert.equal((await folderRefs.writeRef(lead, halfBlind)).caseRef, 'LEAD-77',
      'a case folder proven absent is never the fallback');
  } finally { restore(); }
});

test('folder refs: an UNREADABLE case reference is never mistaken for "this lead has no case"', async () => {
  // caseRefForLead swallows Monday errors, so "" means both "no case yet" and
  // "could not ask". Confusing them names the LEAD folder for a client whose
  // folder was renamed long ago — re-creating it as a second root folder.
  const lead = { id: '77', fullName: 'A B', clientMasterItemId: '900', oneDriveFolderId: 'DRIVE-1' };
  const down = stub(mondayApi, 'query', async () => { throw new Error('Monday 500'); });
  try {
    // The lead folder still exists → nothing has been renamed, so it is safe.
    const early = {
      getClientFolderByName: async (n) => (n === 'A B - LEAD-77' ? { id: 'F', name: n } : null),
      findCaseFolderByRef:   async () => null,
      getDriveItemById:      async () => null,
    };
    assert.equal((await folderRefs.writeRef(lead, early)).caseRef, 'LEAD-77', 'pre-rename: the lead folder is right');

    // The lead folder is gone → it was renamed for a case we cannot name, so
    // ask the folder itself what it is called now.
    const renamed = {
      getClientFolderByName: async () => null,
      findCaseFolderByRef:   async () => null,
      getDriveItemById:      async (id) => (id === 'DRIVE-1' ? { id, name: 'A B - 2026-SP-001', parentPath: '/drive/root:/Client Documents' } : null),
    };
    assert.deepEqual(await folderRefs.writeRef(lead, renamed), { clientName: 'A B', caseRef: '2026-SP-001' },
      'the folder names itself — no guess, no second folder');

    // Nothing can answer → fail loudly. Every writer is best-effort and retries;
    // a permanent duplicate root folder is the worse outcome.
    const blind = {
      getClientFolderByName: async () => null,
      findCaseFolderByRef:   async () => null,
      getDriveItemById:      async () => null,
    };
    await assert.rejects(() => folderRefs.writeRef({ ...lead, oneDriveFolderId: '' }, blind),
      /client folder unknown/, 'it refuses to guess rather than resurrecting the lead folder');

    // The folder id lives in a staff-editable Monday column, so it is not on
    // its own authority to send a signed agreement outside the root.
    const elsewhere = {
      getClientFolderByName: async () => null,
      findCaseFolderByRef:   async () => null,
      getDriveItemById:      async (id) => ({ id, name: 'A B - 2026-SP-001', parentPath: '/drive/root:/Shared/Somewhere' }),
    };
    await assert.rejects(() => folderRefs.writeRef(lead, elsewhere), /client folder unknown/,
      'a folder outside "Client Documents" is not accepted');
  } finally { down(); }
});

test('folder refs: a lead that genuinely has no case still writes to its lead folder, unprobed', async () => {
  // The fast path must survive: a brand-new lead has no Client Master row, so
  // there is nothing to ask and nothing to probe.
  let probes = 0;
  const od = { getClientFolderByName: async () => { probes++; return null; }, findCaseFolderByRef: async () => { probes++; return null; } };
  const ref = await folderRefs.writeRef({ id: '99', fullName: 'New Person' }, od);
  assert.deepEqual(ref, { clientName: 'New Person', caseRef: 'LEAD-99' });
  assert.equal(probes, 0, 'no Graph calls for a lead that cannot have a case');
});

// ─── The wait: the case row carries the folder id ────────────────────────────

test('handoff: the case waits for the client folder, and the id reaches the case row', async () => {
  const cols = [];
  let created = 0;
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Walk In', email: 'w@i.co', oneDriveFolderId: '' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(oneDrive, 'ensureLeadFolder', async () => { created++; return { id: 'DRIVE-1', url: 'https://od/f' }; }),
    stub(mondayApi, 'query', async (q, vars) => {
      if (/create_item/.test(q)) { cols.push(JSON.parse(vars.cols)); return { create_item: { id: '5001' } }; }
      if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: [] } };
      return { items: [{ id: '5001', name: 'Walk In', column_values: [] }], change_multiple_column_values: { id: '5001' }, create_update: { id: '1' } };
    }),
  ];
  try {
    await handoff.openCaseEarly({ leadId: '77' });
    assert.equal(created, 1, 'the folder is ensured before the case row is created');
    assert.ok(cols.length, 'a case row was created');
    assert.equal(cols[0]['text_mm47y540'], 'DRIVE-1', 'the case row carries the folder id — this is what lets the rename happen');
  } finally { restore.reverse().forEach((r) => r()); }
});

test('handoff: a slow or broken OneDrive never blocks opening the case', async () => {
  const prev = process.env.LEAD_FOLDER_WAIT_MS;
  process.env.LEAD_FOLDER_WAIT_MS = '30';                 // read at module load; the stub below is what matters
  const cols = [];
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Walk In', email: 'w@i.co', oneDriveFolderId: '' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(oneDrive, 'ensureLeadFolder', async () => { throw new Error('Graph 503'); }),
    stub(mondayApi, 'query', async (q, vars) => {
      if (/create_item/.test(q)) { cols.push(JSON.parse(vars.cols)); return { create_item: { id: '5002' } }; }
      if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: [] } };
      return { items: [{ id: '5002', name: 'Walk In', column_values: [] }], change_multiple_column_values: { id: '5002' }, create_update: { id: '1' } };
    }),
  ];
  try {
    const id = await handoff.openCaseEarly({ leadId: '78' });
    assert.equal(id, '5002', 'the case still opens');
    assert.equal(cols[0]['text_mm47y540'], undefined, 'no folder id — the rename fallback picks it up later');
  } finally {
    restore.reverse().forEach((r) => r());
    if (prev === undefined) delete process.env.LEAD_FOLDER_WAIT_MS; else process.env.LEAD_FOLDER_WAIT_MS = prev;
  }
});

test('handoff: a lead that already has a folder id costs no Graph call', async () => {
  let called = 0;
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Booked Lead', email: 'b@l.co', oneDriveFolderId: 'DRIVE-9', oneDriveFolderLink: 'https://od/9' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(oneDrive, 'ensureLeadFolder', async () => { called++; return { id: 'X' }; }),
    stub(mondayApi, 'query', async (q) => {
      if (/create_item/.test(q)) return { create_item: { id: '5003' } };
      if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: [] } };
      return { items: [{ id: '5003', name: 'Booked Lead', column_values: [] }], change_multiple_column_values: { id: '5003' }, create_update: { id: '1' } };
    }),
  ];
  try {
    await handoff.openCaseEarly({ leadId: '79' });
    assert.equal(called, 0, 'the public-intake path keeps its fire-and-forget speed');
  } finally { restore.reverse().forEach((r) => r()); }
});

test('handoff: a Graph call that finishes AFTER the wait still lands the id on the lead', async () => {
  const prev = process.env.LEAD_FOLDER_WAIT_MS;
  process.env.LEAD_FOLDER_WAIT_MS = '25';
  const written = [];
  let release;
  const slow = new Promise((res) => { release = res; });
  const restore = [
    stub(oneDrive, 'ensureLeadFolder', async () => { await slow; return { id: 'DRIVE-LATE', url: 'https://od/late' }; }),
    stub(leadService, 'updateLead', async (id, fields) => { written.push({ id, fields }); }),
  ];
  try {
    assert.equal(handoff.leadFolderWaitMs(), 25, 'the knob is read at call time, so it is configurable and testable');
    const folder = await handoff.ensureLeadFolderNow({ id: '77', fullName: 'Slow Graph', oneDriveFolderId: '' });
    assert.equal(folder, null, 'the case is not held up');
    assert.deepEqual(written, [], 'nothing written yet');
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(written.length, 1, 'the late folder id is still recorded — never an orphan folder nothing can find');
    assert.equal(written[0].fields.oneDriveFolderId, 'DRIVE-LATE');
  } finally {
    restore.reverse().forEach((r) => r());
    if (prev === undefined) delete process.env.LEAD_FOLDER_WAIT_MS; else process.env.LEAD_FOLDER_WAIT_MS = prev;
  }
});

test('handoff: the wait knob treats a blank Render value as unset, never as "disabled"', () => {
  const prev = process.env.LEAD_FOLDER_WAIT_MS;
  try {
    process.env.LEAD_FOLDER_WAIT_MS = '';      // a cleared Render variable
    assert.equal(handoff.leadFolderWaitMs(), 8000);
    process.env.LEAD_FOLDER_WAIT_MS = '   ';
    assert.equal(handoff.leadFolderWaitMs(), 8000);
    process.env.LEAD_FOLDER_WAIT_MS = 'soon';
    assert.equal(handoff.leadFolderWaitMs(), 8000);
    process.env.LEAD_FOLDER_WAIT_MS = '0';     // deliberately off
    assert.equal(handoff.leadFolderWaitMs(), 0);
    delete process.env.LEAD_FOLDER_WAIT_MS;
    assert.equal(handoff.leadFolderWaitMs(), 8000);
  } finally { if (prev === undefined) delete process.env.LEAD_FOLDER_WAIT_MS; else process.env.LEAD_FOLDER_WAIT_MS = prev; }
});

// ─── The safety net: find the folder from the lead, but never guess ──────────

function renameHarness({ caseFolderId = '', leads = [], drive = null }) {
  const renamed = [], written = [];
  const restore = [
    stub(mondayApi, 'query', async (q, vars) => {
      if (/create_update/.test(q)) return { create_update: { id: '1' } };
      if (/change_multiple_column_values/.test(q)) { written.push(JSON.parse(vars.cols)); return { change_multiple_column_values: { id: '1' } }; }
      return { items: [{ name: 'Walk In', column_values: [{ text: caseFolderId }] }] };
    }),
    stub(leadService, 'findAllByColumnValue', async () => leads),
    stub(oneDrive, 'getDriveItemById', async () => drive),
    stub(oneDrive, 'renameDriveItem', async (id, name) => { renamed.push({ id, name }); return { id, name }; }),
  ];
  return { renamed, written, restore: () => restore.reverse().forEach((r) => r()) };
}
const LEAD_77 = { id: '77', fullName: 'Walk In', oneDriveFolderId: 'DRIVE-1' };
const DRIVE_OK = { id: 'DRIVE-1', name: 'Walk In - LEAD-77', parentPath: '/drive/root:/Client Documents' };

test('rename fallback: with one linked lead the folder is found, renamed and the id written back to the case', async () => {
  const h = renameHarness({ caseFolderId: '', leads: [LEAD_77], drive: DRIVE_OK });
  try {
    await caseRefSvc.renameClientFolderForItem({ itemId: '5001', caseRef: '2026-SP-001' });
    assert.deepEqual(h.renamed, [{ id: 'DRIVE-1', name: 'Walk In - 2026-SP-001' }]);
    assert.ok(h.written.some((c) => c['text_mm47y540'] === 'DRIVE-1'), 'back-filled, so careful-delete and any later rename can find it');
  } finally { h.restore(); }
});

test('rename fallback: it refuses to guess — no lead, two leads, a missing folder, a renamed folder, or one outside the root', async () => {
  const cases = [
    ['no linked lead',        { leads: [], drive: DRIVE_OK }],
    ['no lead has a folder',  { leads: [{ id: '77', fullName: 'Walk In', oneDriveFolderId: '' }], drive: DRIVE_OK }],
    ['two candidate leads',   { leads: [LEAD_77, { id: '78', fullName: 'Someone Else', oneDriveFolderId: 'DRIVE-2' }], drive: DRIVE_OK }],
    ['folder is gone',        { leads: [LEAD_77], drive: null }],
    ['folder already renamed',{ leads: [LEAD_77], drive: { ...DRIVE_OK, name: 'Walk In - 2026-VV-001' } }],
    ['folder outside root',   { leads: [LEAD_77], drive: { ...DRIVE_OK, parentPath: '/drive/root:/Somewhere Else' } }],
  ];
  for (const [label, cfg] of cases) {
    const h = renameHarness({ caseFolderId: '', ...cfg });
    try {
      await caseRefSvc.renameClientFolderForItem({ itemId: '5001', caseRef: '2026-SP-001' });
      assert.deepEqual(h.renamed, [], `${label}: nothing renamed`);
      assert.deepEqual(h.written, [], `${label}: nothing written to the case`);
    } finally { h.restore(); }
  }
});

test('rename: a case that already carries its folder id does not look leads up at all', async () => {
  let lookedUp = 0;
  const h = renameHarness({ caseFolderId: 'DRIVE-5', leads: [], drive: DRIVE_OK });
  const spy = stub(leadService, 'findAllByColumnValue', async () => { lookedUp++; return []; });
  try {
    await caseRefSvc.renameClientFolderForItem({ itemId: '5001', caseRef: '2026-SP-001' });
    assert.equal(lookedUp, 0);
    assert.deepEqual(h.renamed, [{ id: 'DRIVE-5', name: 'Walk In - 2026-SP-001' }]);
  } finally { spy(); h.restore(); }
});

// ─── The converted writers really target the case folder ────────────────────

test('pre-consult submission is filed in the case folder once the case exists, not the old lead folder', async () => {
  const consultationService = require('../src/services/consultationService');
  const uploads = [];
  const restore = [
    stub(leadService, 'getLead', async (id) => ({ id, fullName: 'Walk In', clientMasterItemId: '900', serviceRequired: '' })),
    stub(leadService, 'updateLead', async () => {}),
    stub(mondayApi, 'query', async (q) => (/create_update/.test(q) ? { create_update: { id: '1' } } : CASE_REF_ROW('2026-SP-001'))),
    stub(oneDrive, 'getClientFolderByName', async (n) => (n === 'Walk In - 2026-SP-001' ? { id: 'F', name: n } : null)),
    stub(oneDrive, 'uploadFile', async (a) => { uploads.push(a); }),
    stub(oneDrive, 'uploadFileAndLink', async (a) => { uploads.push(a); return { url: 'https://od/pdf' }; }),
  ];
  try {
    await consultationService.savePreConsultData('77', { pc_address: '1 Main St' });
    assert.ok(uploads.length >= 1, 'something was filed');
    for (const u of uploads) {
      assert.equal(u.caseRef, '2026-SP-001', `${u.filename} went to the case folder`);
      assert.equal(u.clientName, 'Walk In');
    }
  } finally { restore.reverse().forEach((r) => r()); }
});

test('the stored retainer PDF is written to the case folder and read back from either folder', async () => {
  const r2 = require('../src/services/retainerService2');
  const lead = { id: '77', fullName: 'Walk In', clientMasterItemId: '900' };
  const uploads = [];
  // The durable store belongs to the v2 engine; v1 renders a generic PDF and
  // never touches OneDrive, so the folder rule under test only applies here.
  const prevEngine = process.env.RETAINER_ENGINE;
  process.env.RETAINER_ENGINE = 'v2';
  const restore = [
    stub(mondayApi, 'query', async () => CASE_REF_ROW('2026-SP-001')),
    stub(oneDrive, 'getClientFolderByName', async (n) => (n === 'Walk In - 2026-SP-001' ? { id: 'F', name: n } : null)),
    stub(oneDrive, 'ensureClientFolder', async () => {}),
    stub(oneDrive, 'uploadFile', async (a) => { uploads.push(a); }),
    stub(oneDrive, 'readFile', async ({ caseRef }) => (caseRef === 'LEAD-77' ? Buffer.from('the sent copy') : null)),
  ];
  try {
    // getRetainerDocument reads the durable copy first; a hit means readStoredRetainerPdf found it.
    const doc = await r2.getRetainerDocument(lead);
    assert.equal(doc.toString(), 'the sent copy', 'a PDF stored before the case opened is still served');
    const { writeRef } = folderRefs;
    assert.equal((await writeRef(lead)).caseRef, '2026-SP-001', 'new copies go to the case folder');
    assert.ok(uploads.every((u) => u.caseRef !== 'LEAD-77'), 'nothing is written back to the old lead folder');
  } finally {
    restore.reverse().forEach((r) => r());
    if (prevEngine === undefined) delete process.env.RETAINER_ENGINE; else process.env.RETAINER_ENGINE = prevEngine;
  }
});

// ─── Nothing addresses a renamed folder by its old name any more ─────────────

test('pins: every lead-scoped write and read goes through the shared rule (the public intake stays pre-case)', () => {
  const read = (p) => fs.readFileSync(require.resolve('../src/services/' + p), 'utf8');
  for (const [file, what] of [['documensoService.js', 'signed-agreement capture'], ['retainerService2.js', 'stored retainer PDF'], ['consultationService.js', 'pre-consult archive']]) {
    const src = read(file);
    assert.ok(/clientFolderRefs'\)\s*\.?\s*\n?\s*\.?(writeRef|readFirst)|clientFolderRefs'\)\.(writeRef|readFirst)/.test(src.replace(/\s+/g, ' ')), `${what} uses the shared rule`);
    assert.ok(!/caseRef: `LEAD-\$\{/.test(src), `${what} no longer addresses the folder by its lead name`);
  }
  assert.ok(!/caseRef: `LEAD-\$\{/.test(read('consultantPortalService.js')), 'the intake-archive read no longer pins the lead name');
  // The public intake creates the lead in the SAME request — no case can exist,
  // so it correctly keeps the lead name.
  assert.ok(/caseRef: `LEAD-\$\{leadId\}`/.test(read('intakeFormService.js')), 'public intake is pre-case and unchanged');
  // One implementation, not five — and every WRITER goes through writeRef, so
  // none of them can name the case folder before it exists.
  assert.match(read('retainerCountersignService.js'), /require\('\.\.\/utils\/clientFolderRefs'\)\.candidateFolderRefs/);
  for (const f of ['retainerCountersignService.js', 'consultAgreementService.js']) {
    assert.match(read(f), /clientFolderRefs'\)\.writeRef\(lead\)/, `${f} picks the folder that exists`);
    assert.ok(!/const \[ref\] = await/.test(read(f)), `${f} no longer takes the first candidate blind`);
  }
  // The wait sits on the create-a-new-case path, before the case row is built.
  const ho = read('handoffService.js');
  assert.ok(ho.indexOf('ensureLeadFolderNow(lead)') < ho.indexOf('const createCols'), 'the folder is confirmed before the case row is created');
});

test('folder refs: parallel reads for one lead ask Monday once', async () => {
  // The consultation detail page loads the intake and pre-consult archives side
  // by side; each used to cost its own Client Master query.
  let queries = 0;
  const restore = stub(mondayApi, 'query', async () => { queries++; return CASE_REF_ROW('2026-SP-001'); });
  try {
    const lead = { id: '77', fullName: 'A B', clientMasterItemId: '900' };
    const [a, b] = await Promise.all([folderRefs.candidateFolderRefs(lead), folderRefs.candidateFolderRefs(lead)]);
    assert.equal(queries, 1, 'one query for two concurrent callers');
    assert.deepEqual(a, b);
    assert.equal(a[0].caseRef, '2026-SP-001');
    // ...and it is an in-flight share, not a cache: a later call asks again.
    await folderRefs.candidateFolderRefs(lead);
    assert.equal(queries, 2, 'nothing is remembered between requests');
  } finally { restore(); }
});

test('rename: a Client Master row that reads back empty is reported, not dereferenced', async () => {
  // Every message on this path quotes the client's name, and the lead fallback
  // needs it too — so an unreadable row must stop here, not crash twice.
  const calls = [];
  const restore = [
    stub(mondayApi, 'query', async (q) => { calls.push(q); return { items: [] }; }),
    stub(leadService, 'findAllByColumnValue', async () => { throw new Error('must not be reached'); }),
  ];
  try {
    await caseRefSvc.renameClientFolderForItem({ itemId: '5001', caseRef: '2026-SP-001' });
    assert.ok(!calls.some((q) => /create_update|change_multiple/.test(q)), 'nothing written from an unreadable row');
  } finally { restore.reverse().forEach((r) => r()); }
});
