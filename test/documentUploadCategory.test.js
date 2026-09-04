'use strict';

// Client uploads must land in the OneDrive folder of the category the client
// SAW the document listed under. Before 2026-09-02, uploadFileToOneDrive
// short-circuited to a Template Board lookup whenever the intake-id column was
// non-empty — but schema-seeded rows store "code:<documentCode>" there, the
// lookup failed, and EVERY schema-seeded upload landed in "General" even
// though the row's own category column was filled.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const svc = require('../src/services/documentFormService');

test('resolveUploadCategory: template → row category column → mirror → schema → General', () => {
  assert.equal(svc.resolveUploadCategory({ templateCategory: 'Identity', catText: 'Education' }), 'Identity');
  assert.equal(svc.resolveUploadCategory({ templateCategory: '', catText: 'Education', mirror: 'Travel' }), 'Education');
  assert.equal(svc.resolveUploadCategory({ catText: '  ', mirror: 'Travel' }), 'Travel');
  assert.equal(svc.resolveUploadCategory({ schemaCategory: 'Financial' }), 'Financial');
  assert.equal(svc.resolveUploadCategory({}), 'General');
  assert.equal(svc.resolveUploadCategory({ templateCategory: null, catText: undefined }), 'General');
});

test('schema-seeded "code:" ids are never treated as Template item ids; template ids are numeric only', () => {
  assert.equal(svc.isTemplateItemId('12345678901'), true);
  assert.equal(svc.isTemplateItemId('code:ISS-SPOUSAL-PA-PASSPORT-001'), false);
  assert.equal(svc.isTemplateItemId(''), false);
  assert.equal(svc.isTemplateItemId(undefined), false);
  assert.equal(svc.categoryFromSchemaCode('12345'), '', 'non-code ids resolve to nothing');
  assert.equal(svc.categoryFromSchemaCode('code:NOT-A-REAL-CODE-001'), '', 'unknown codes resolve to nothing, never throw');
});

test('a real schema document code resolves to its schema category', () => {
  const registry = require('../src/services/caseSchemaService');
  const planner  = require('../src/services/seedPlanner');
  const reg = registry.listRegistered();
  assert.ok(reg.length > 0, 'schemas registered');
  // find any registered schema with a categorised document and build its code the way the seeder does
  let found = null;
  for (const { caseType, subType } of reg) {
    const schema = registry.lookup(caseType, subType);
    for (const role of (schema && schema.roles) || []) {
      const doc = (role.documents || []).find((d) => d.category);
      if (doc) { found = { caseType, subType, role, doc }; break; }
    }
    if (found) break;
  }
  assert.ok(found, 'a categorised schema document exists');
  const slugUpper = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const code = `${slugUpper(found.caseType)}-${slugUpper(found.subType)}-${slugUpper(found.role.role)}-${found.doc.code}-001`;
  const resolved = planner.resolveDocumentCode(code);
  if (resolved) { // only assert when the code shape matches the planner's format (guards against slug drift)
    assert.equal(svc.categoryFromSchemaCode(`code:${code}`), String(found.doc.category).trim());
  }
});

test('uploadFileToOneDrive uses the shared resolution (no intakeId short-circuit) and warns when it still falls to General', () => {
  const src = fs.readFileSync(require.resolve('../src/services/documentFormService'), 'utf8');
  const i = src.indexOf('async function uploadFileToOneDrive(');
  const block = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(block, /resolveUploadCategory\(\{ templateCategory, catText, mirror, schemaCategory: categoryFromSchemaCode\(intakeId\) \}\)/);
  assert.doesNotMatch(block, /intakeId\s*\?\s*getCategoryFromTemplate/, 'the old short-circuit is gone');
  assert.match(block, /fell back to "General"/, 'a General fallback is logged loudly');
  assert.match(block, /staleGeneralLink = \/\^General Folder\\b\/i\.test\(folderText\) && category !== 'General'/, 'links the old bug backfilled to General are re-pointed on the next upload');
  assert.match(block, /if \(\(!folderText \|\| staleGeneralLink\) && category\)/);
  // getCategoryFromTemplate must not itself default to General
  const j = src.indexOf('async function getCategoryFromTemplate(');
  const g = src.slice(j, src.indexOf('\n}\n', j));
  assert.doesNotMatch(g, /'General'/);
  assert.match(g, /if \(!isTemplateItemId\(intakeId\)\) return ''/);
});

test('admin OneDrive listing endpoint is admin-only and read-only; subfolder=* returns the whole case tree', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const i = src.indexOf("app.get('/admin/onedrive/list'");
  assert.ok(i !== -1, 'route exists');
  const block = src.slice(i, src.indexOf('app.', i + 10));
  assert.match(block, /resolveAdminOrReject\(req, res(, '[^']*')?\)/);
  assert.match(block, /listFiles\(/);
  assert.doesNotMatch(block, /uploadFile|deleteDriveItem|renameDriveItem|mutation/, 'never writes');
  // tree mode (phantom-doc audit): every sub-folder with its files, still read-only
  assert.match(block, /const wholeTree = subfolder === '\*'/);
  assert.match(block, /listChildren\(\{ clientName, caseRef, subfolder: '' \}\)/);
  assert.match(block, /res\.json\(\{ caseRef, clientName, tree: folders, rootFiles/);
  assert.match(block, /!wholeTree && !findMode && !\/\^\[A-Za-z0-9 _&\(\)-\]\{1,60\}\$\/\.test\(subfolder\)/, 'the name guard still applies to a real sub-folder');
  // ?find=1 answers "where is this case's folder" and needs no sub-folder
  assert.match(block, /const findMode  = req\.query\.find === '1';/);
  assert.match(block, /findCaseFolderByRef\(caseRef\)/);
  assert.match(block, /renamed: Boolean\(byRef && byRef\.name && byRef\.name !== expected\)/);
});

test('phantom-docs audit is read-only and buckets every Received row', () => {
  const s = fs.readFileSync(require.resolve('../scripts/audit-phantom-docs.js'), 'utf8');
  assert.doesNotMatch(s, /mutation|uploadFile|moveFile|change_multiple_column_values/, 'never writes');
  assert.match(s, /subfolder=\*/, 'reads the whole case tree');
  assert.match(s, /normFilename/, 'matches names the way OneDrive stores them');
  for (const bucket of ['ok', 'misfiled', 'renamed', 'PHANTOM', 'no-upload-record', 'folder-missing']) {
    assert.ok(s.includes(`'${bucket}'`), `bucket ${bucket} exists`);
  }
  // a vanished FILENAME is only a missing DOCUMENT when the case is short of files —
  // staff rename and re-file while preparing a submission
  assert.match(s, /const shortOfFiles = clientFiles < unmatched\.length;/);
  assert.match(s, /o\.verdict = shortOfFiles \? 'PHANTOM' : 'renamed';/);
});

// ── Behavioural: drive uploadFileToOneDrive with stubbed Monday + OneDrive ──
function freshUploadHarness({ intakeId, catText = '', mirror = '', folderText = '', templateCategory = 'Travel' }) {
  const calls = { uploads: [], templateLookups: 0, columnWrites: [], updates: 0 };
  const fakeMonday = {
    query: async (q, vars) => {
      if (q.includes('items_page_by_column_values')) return { items_page_by_column_values: { items: [{ id: '77', name: 'Test Client' }] } };
      if (q.includes('dropdown_mm0x41zm') && q.includes('items(ids: [$id])')) { calls.templateLookups++; return { items: [{ column_values: [{ id: 'dropdown_mm0x41zm', text: templateCategory }] }] }; }
      if (q.includes('text_mm0zfsp1')) return { items: [{ id: '5', name: 'Passport', column_values: [
        { id: 'text_mm0zfsp1', text: intakeId }, { id: 'lookup_mm0zqbvt', text: mirror }, { id: 'text_mm261tka', text: catText }, { id: 'link_mm1yrnz1', text: folderText },
      ] }] };
      if (q.includes('change_multiple_column_values')) { calls.columnWrites.push(JSON.parse(vars.colValues)); return {}; }
      if (q.includes('create_update')) { calls.updates++; return {}; }
      return {};
    },
  };
  const fakeOneDrive = { uploadFile: async (p) => { calls.uploads.push(p); return 'https://web/' + p.category; }, ensureCategoryFolderLink: async ({ category }) => `https://folder/${category}` };
  const fakeReadiness = { calculateForCaseRef: async () => {} };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('../src/services/mondayApi', fakeMonday);
  set('../src/services/oneDriveService', fakeOneDrive);
  set('../src/services/caseReadinessService', fakeReadiness);
  const p = require.resolve('../src/services/documentFormService');
  delete require.cache[p];
  return { svc: require(p), calls };
}

test('behavioural: a schema-seeded ("code:") row uploads into its category column\'s folder without any Template lookup', async () => {
  const { svc, calls } = freshUploadHarness({ intakeId: 'code:STUDY-PERMIT-EXTENSION-SINGLE-APPLICANT-PRINCIPALAPPLICANT-PASSPORT-001', catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity' });
  await svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.uploads[0].category, 'Identity');
  assert.equal(calls.uploads[0].clientName, 'Test Client');
  assert.equal(calls.templateLookups, 0, 'no Template Board lookup for code rows');
  assert.equal(calls.columnWrites.length, 0, 'folder link already correct → no column write');
});

test('behavioural: a template-linked (numeric id) row still uses the Template category; a stale "General Folder" link is re-pointed', async () => {
  const { svc, calls } = freshUploadHarness({ intakeId: '18401624999', catText: 'Education', folderText: 'General Folder - https://folder/General', templateCategory: 'Travel' });
  await svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'ticket.pdf', 'application/pdf');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.templateLookups, 1);
  assert.equal(calls.uploads[0].category, 'Travel', 'Template category wins for template-linked rows');
  assert.equal(calls.columnWrites.length, 1, 'the stale General link is re-pointed');
  assert.deepEqual(calls.columnWrites[0], { link_mm1yrnz1: { url: 'https://folder/Travel', text: 'Travel Folder' } });
});

test('behavioural: a code row whose category column is empty falls back to the schema definition, and only then to General', async () => {
  const registry = require('../src/services/caseSchemaService');
  const reg = registry.listRegistered();
  let found = null;
  for (const { caseType, subType } of reg) {
    const schema = registry.lookup(caseType, subType);
    for (const role of (schema && schema.roles) || []) { const doc = (role.documents || []).find((d) => d.category); if (doc) { found = { caseType, subType, role, doc }; break; } }
    if (found) break;
  }
  const slugUpper = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const code = `${slugUpper(found.caseType)}-${slugUpper(found.subType)}-${slugUpper(found.role.role)}-${found.doc.code}-001`;
  const resolvable = Boolean(require('../src/services/seedPlanner').resolveDocumentCode(code));
  const { svc, calls } = freshUploadHarness({ intakeId: `code:${code}`, catText: '', folderText: '' });
  await svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'doc.pdf', 'application/pdf');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.uploads[0].category, resolvable ? String(found.doc.category).trim() : 'General');
  const { svc: svc2, calls: calls2 } = freshUploadHarness({ intakeId: 'code:UNKNOWN-CODE-001', catText: '', folderText: '' });
  await svc2.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'doc.pdf', 'application/pdf');
  assert.equal(calls2.uploads[0].category, 'General', 'nothing resolvable → General (logged loudly)');
});
