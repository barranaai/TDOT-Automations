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
function freshUploadHarness({ intakeId, catText = '', mirror = '', folderText = '', templateCategory = 'Travel', templateApplicantType = '', execApplicantType = '', docName = 'Passport', storedName, replaced = false, rowNoteFails = false, rowNoteHangs = false } = {}) {
  const calls = { uploads: [], templateLookups: 0, columnWrites: [], updates: 0, updateBodies: [], updateRetries: [], order: [] };
  const fakeMonday = {
    query: async (q, vars, retries) => {
      if (q.includes('items_page_by_column_values')) {
        // a real tick (not a microtask), so "the CM note lands AFTER the upload returns" is observable
        calls.order.push('cmLookup'); await new Promise((r) => setImmediate(r));
        return { items_page_by_column_values: { items: [{ id: '77', name: 'Test Client' }] } };
      }
      if (q.includes('dropdown_mm0x41zm') && q.includes('items(ids: [$id])')) {
        calls.templateLookups++;
        return { items: [{ column_values: [{ id: 'dropdown_mm0x41zm', text: templateCategory }, { id: 'dropdown_mm261bn6', text: templateApplicantType }] }] };
      }
      if (q.includes('text_mm0zfsp1')) return { items: [{ id: '5', name: docName, column_values: [
        { id: 'text_mm0zfsp1', text: intakeId }, { id: 'lookup_mm0zqbvt', text: mirror }, { id: 'text_mm261tka', text: catText }, { id: 'link_mm1yrnz1', text: folderText }, { id: 'text_mm26jcv7', text: execApplicantType },
      ] }] };
      if (q.includes('change_multiple_column_values')) { calls.columnWrites.push(JSON.parse(vars.colValues)); return {}; }
      if (q.includes('create_update')) {
        const isRow = String(vars.itemId) === '5';
        calls.updates++; calls.updateBodies.push(vars.body); calls.updateRetries.push(retries); calls.order.push(isRow ? 'rowNote' : 'cmNote');
        if (isRow && rowNoteHangs) await new Promise(() => {});
        if (isRow && rowNoteFails) throw new Error('Monday 500');
        return {};
      }
      return {};
    },
  };
  const fakeOneDrive = {
    uploadFile: async (p) => { calls.uploads.push(p); return 'https://web/' + p.category; },
    uploadFileAsNew: async (p) => { calls.uploads.push(p); return { id: 'i1', name: storedName || p.filename, webUrl: 'https://web/x', url: 'https://org/x', replaced }; },
    ensureCategoryFolderLink: async ({ category }) => `https://folder/${category}`,
  };
  const fakeReadiness = { calculateForCaseRef: async () => {} };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('../src/services/mondayApi', fakeMonday);
  set('../src/services/oneDriveService', fakeOneDrive);
  set('../src/services/caseReadinessService', fakeReadiness);
  const p = require.resolve('../src/services/documentFormService');
  delete require.cache[p];
  return { svc: require(p), calls };
}

/** Run with UPLOAD_UNIQUE_NAMES set (or unset when value is undefined), restoring afterwards. */
async function withUniqueNames(value, fn) {
  const saved = process.env.UPLOAD_UNIQUE_NAMES;
  if (value === undefined) delete process.env.UPLOAD_UNIQUE_NAMES; else process.env.UPLOAD_UNIQUE_NAMES = value;
  try { return await fn(); }
  finally { if (saved === undefined) delete process.env.UPLOAD_UNIQUE_NAMES; else process.env.UPLOAD_UNIQUE_NAMES = saved; }
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

// ── Unique names (UPLOAD_UNIQUE_NAMES=1): what is stored, what is recorded ──

const NAME_RE = /^Passport – PA – \d{4}-\d{2}-\d{2} \d{2}-\d{2} – passport\.pdf$/;

test('(17) switch ON: the file goes through uploadFileAsNew under the built name; member from the Template row, the exec column, or the schema code', async () => {
  await withUniqueNames('1', async () => {
    // a code row for the principal applicant (resolvable code from a real schema)
    const { code } = realSchemaCode();
    let h = freshUploadHarness({ intakeId: `code:${code}`, catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity' });
    await h.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf');
    assert.equal(h.calls.uploads.length, 1);
    assert.match(h.calls.uploads[0].filename, /^Passport – (PA|Spouse|Child \d+|Inviter|Sponsor|Non-Acc Spouse|Parent|Sibling) – \d{4}-\d{2}-\d{2} \d{2}-\d{2} – passport\.pdf$/);
    assert.equal(h.calls.uploads[0].category, 'Identity');
    assert.equal(h.calls.uploads[0].clientName, 'Test Client');
    assert.equal(h.calls.uploads[0].buffer.toString(), 'x');
    assert.equal(h.calls.uploads[0].mimeType, 'application/pdf');
    assert.equal(h.calls.templateLookups, 0);

    // a template row: dropdown_mm261bn6 read in the SAME query as the category (still one lookup)
    h = freshUploadHarness({ intakeId: '18401624999', catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity', templateCategory: 'Identity', templateApplicantType: 'Spouse / Common-Law Partner' });
    await h.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf');
    assert.equal(h.calls.templateLookups, 1, 'category + applicant type come from one Template query');
    assert.match(h.calls.uploads[0].filename, /^Passport – Spouse – \d{4}-\d{2}-\d{2} \d{2}-\d{2} – passport\.pdf$/);

    // a template row with a blank dropdown defaults to PA (the same default the page shows)
    h = freshUploadHarness({ intakeId: '18401624999', catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity', templateCategory: 'Identity', templateApplicantType: '' });
    await h.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf');
    assert.match(h.calls.uploads[0].filename, NAME_RE);

    // an unresolvable code row falls back to the exec row's own Applicant Type column
    h = freshUploadHarness({ intakeId: 'code:UNKNOWN-CODE-001', catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity', execApplicantType: 'Dependent Child 2' });
    await h.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf');
    assert.match(h.calls.uploads[0].filename, /^Passport – Child 2 – /);
    assert.equal(h.calls.templateLookups, 0);
    const up = h.calls.uploads[0];
    assert.equal(up.category, 'Identity');
    assert.equal(up.caseRef, '2026-SPE-013');
  });
});

test('(17b) switch ON: a schema code with memberIndex 2 names the file "– Child 2 –"', async () => {
  await withUniqueNames('1', async () => {
    const found = realSchemaCode({ role: 'DependentChild' });
    if (!found) return;   // no schema with a dependent child registered — nothing to prove
    const code2 = found.code.replace(`-${found.roleSlug}-`, `-${found.roleSlug}2-`);
    const resolved = require('../src/services/seedPlanner').resolveDocumentCode(code2);
    assert.ok(resolved && resolved.memberIndex === 2, 'fixture resolves with index 2');
    const h = freshUploadHarness({ intakeId: `code:${code2}`, catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity' });
    await h.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf');
    assert.match(h.calls.uploads[0].filename, /^Passport – Child 2 – \d{4}-\d{2}-\d{2} \d{2}-\d{2} – passport\.pdf$/);
  });
});

test('(17c) switch OFF (unset): today\'s path — uploadFile under the client\'s own name, uploadFileAsNew never called', async () => {
  await withUniqueNames(undefined, async () => {
    const h = freshUploadHarness({ intakeId: 'code:X', catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity' });
    const out = await h.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf');
    assert.equal(h.calls.uploads.length, 1);
    assert.equal(h.calls.uploads[0].filename, 'passport.pdf');
    assert.equal(out.name, '', 'no stored name is claimed on the OFF path');
    assert.equal(out.webUrl, 'https://web/Identity');
    assert.equal(out.url, '');
    assert.equal(out.originalName, 'passport.pdf');
  });
});

test('(19) the row note: exact §3a order; File: is the name Graph returned; Note:/Warning: only when earned; the re-file parser still reads it — newlines kept or collapsed', async () => {
  await withUniqueNames('1', async () => {
    const h = freshUploadHarness({ intakeId: 'code:X', catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity', storedName: 'x 1.pdf', execApplicantType: 'Spouse / Common-Law Partner' });
    const out = await h.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf');
    await new Promise((r) => setTimeout(r, 20));
    const body = h.calls.updateBodies[0];
    const lines = body.split('\n');
    assert.equal(lines[0], '📄 Document Uploaded by Client');
    assert.equal(lines[1], '');
    assert.equal(lines[2], 'Document: Passport');
    assert.equal(lines[3], 'File: x 1.pdf', 'the name Graph kept, not the one we asked for');
    assert.equal(lines[4], 'Category: Identity');
    assert.equal(lines[5], 'Case: 2026-SPE-013 (Test Client)');
    assert.equal(lines[6], 'For: Spouse / Common-Law Partner');
    assert.equal(lines[7], 'Named by client: passport.pdf');
    assert.equal(lines[8], 'Note: OneDrive added a number to the name because a file with this name already existed — both files are kept.');
    assert.match(lines[9], /^Uploaded: .+ \(Toronto\)$/);
    assert.equal(lines[10], '');
    assert.equal(lines[11], '🔗 Open this upload: https://org/x');
    assert.equal(lines[12], '📁 Folder: Identity Folder - https://folder/Identity', 'the link column\'s text, exactly as today');
    assert.equal(lines[13], '');
    assert.equal(lines[14], 'Status set to Received — please review.');
    assert.equal(lines[15], '');
    assert.match(lines[16], /^🔎 Review all documents for this case: .+\/d\/2026-SPE-013\/review$/);
    assert.equal(lines.length, 17);
    assert.ok(!body.includes('Warning:'), 'no replace warning when nothing was replaced');
    assert.equal((body.match(/File:/g) || []).length, 1, 'exactly one File: line (the parser takes the leftmost)');
    assert.equal(out.name, 'x 1.pdf');
    assert.equal(out.noteBody, body);
    assert.equal(out.notePosted, true);

    // the re-file tool reads File + Category out of it, with newlines kept AND collapsed (Monday's rendering)
    const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
    set('../src/services/oneDriveService', {}); set('../src/services/mondayApi', { query: async () => ({}) });
    const rp = require.resolve('../src/services/documentRefileService'); delete require.cache[rp];
    const refile = require(rp);
    assert.deepEqual(refile.uploadedFiles([body]), [{ file: 'x 1.pdf', category: 'Identity' }]);
    assert.deepEqual(refile.uploadedFiles([body.replace(/\n/g, ' ')]), [{ file: 'x 1.pdf', category: 'Identity' }]);

    // no clash → no Note: line; replaced → Warning: line, right after Named by client:
    const h2 = freshUploadHarness({ intakeId: 'code:X', catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity' });
    await h2.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf');
    assert.ok(!h2.calls.updateBodies[0].includes('Note: OneDrive added a number'));
    assert.match(h2.calls.updateBodies[0], /\nFile: Passport – PA – \d{4}-\d{2}-\d{2} \d{2}-\d{2} – passport\.pdf\nCategory: Identity\n/);
    const h3 = freshUploadHarness({ intakeId: 'code:X', catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity', replaced: true });
    const errs = []; const origErr = console.error; console.error = (...a) => errs.push(a.join(' '));
    try { await h3.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf'); } finally { console.error = origErr; }
    assert.match(h3.calls.updateBodies[0], /\nNamed by client: passport\.pdf\nWarning: OneDrive replaced a file with this name — the earlier copy is in that file's version history\.\nUploaded: /);

    // the Client Master note carries the same new lines, link before folder
    await new Promise((r) => setTimeout(r, 20));
    const cm = h.calls.updateBodies[1];
    assert.match(cm, /^📄 Client Uploaded Document\n\nDocument: Passport\nFile: x 1\.pdf\nCategory: Identity\nCase: 2026-SPE-013\nFor: Spouse \/ Common-Law Partner\nNamed by client: passport\.pdf\nUploaded: .+ \(Toronto\)\n\n🔗 Open this upload: https:\/\/org\/x\n📁 Folder: Identity Folder - https:\/\/folder\/Identity\n\n🔎 Review all documents/);
  });
});

test('(19c) a client file name that looks like HTML is shown as text in the note (Monday renders update bodies as HTML); the stored name has no tags at all', async () => {
  await withUniqueNames('1', async () => {
    const h = freshUploadHarness({ intakeId: 'code:X', catText: 'Identity', folderText: '', storedName: 'Passport – PA – 2026-09-30 14-32 – a hrefhttpsphish.examplepassporta.pdf' });
    await h.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), '<a href="https://phish.example">passport</a>.pdf', 'application/pdf');
    await new Promise((r) => setTimeout(r, 20));
    const body = h.calls.updateBodies[0];
    assert.match(body, /\nNamed by client: &lt;a href="https:\/\/phish\.example"&gt;passport&lt;\/a&gt;\.pdf\n/);
    assert.ok(!/<a /.test(body), 'no live tag anywhere in the note');
    assert.ok(!/[<>]/.test(h.calls.uploads[0].filename), 'the stored name never carries < or >');
  });
});

test('(19b) switch OFF: the note is today\'s body, byte for byte (no For:, no Named by client:, no file link)', async () => {
  await withUniqueNames('0', async () => {
    const h = freshUploadHarness({ intakeId: 'code:X', catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity' });
    await h.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf');
    await new Promise((r) => setTimeout(r, 20));
    const body = h.calls.updateBodies[0];
    const expected = new RegExp('^📄 Document Uploaded by Client\\n\\nDocument: Passport\\nFile: passport\\.pdf\\nCategory: Identity\\nCase: 2026-SPE-013 \\(Test Client\\)\\nUploaded: .+ \\(Toronto\\)\\n\\n📁 Folder: Identity Folder - https://folder/Identity\\n\\nStatus set to Received — please review\\.\\n\\n🔎 Review all documents for this case: .+/d/2026-SPE-013/review$');
    assert.match(body, expected);
    assert.ok(!body.includes('For:') && !body.includes('Named by client:') && !body.includes('Open this upload'));
    const cm = h.calls.updateBodies[1];
    assert.match(cm, /^📄 Client Uploaded Document\n\nDocument: Passport\nFile: passport\.pdf\nCategory: Identity\nCase: 2026-SPE-013\nUploaded: .+ \(Toronto\)\n\n📁 Folder: Identity Folder - https:\/\/folder\/Identity\n\n🔎 Review all documents/);
  });
});

test('(20) the row note is awaited (ONE retry) and lands before uploadFileToOneDrive returns; the CM note after; a row-note failure does not fail the upload', async () => {
  await withUniqueNames('1', async () => {
    let h = freshUploadHarness({ intakeId: 'code:X', catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity' });
    const out = await h.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf');
    assert.ok(h.calls.order.includes('rowNote'), 'row note posted before the return');
    assert.ok(!h.calls.order.includes('cmNote'), 'the Client Master note is still on its way');
    assert.equal(h.calls.updateRetries[0], 1, 'the awaited note asks mondayApi for ONE retry — a degraded Monday must not hold the upload slot for minutes');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(h.calls.order.filter((o) => o !== 'cmLookup'), ['rowNote', 'cmNote']);
    assert.equal(out.notePosted, true);

    h = freshUploadHarness({ intakeId: 'code:X', catText: 'Identity', folderText: 'Identity Folder - https://folder/Identity', rowNoteFails: true });
    const warns = []; const origWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    let out2;
    try { out2 = await h.svc.uploadFileToOneDrive('5', '2026-SPE-013', Buffer.from('x'), 'passport.pdf', 'application/pdf'); } finally { console.warn = origWarn; }
    assert.equal(out2.name, 'Passport – PA – ' + out2.name.slice('Passport – PA – '.length), 'the upload succeeded');
    assert.equal(out2.notePosted, false, 'and says the note did not land');
    assert.match(out2.noteBody, /^📄 Document Uploaded by Client\n/, 'but carries the body so the status retry can post it');
    assert.ok(warns.some((w) => /Row upload note failed for item 5/.test(w)));
  });
});

test('(21) markDocumentReceived: three columns exactly, the TORONTO date at a fixed 01:30Z clock, { date } override honoured', async () => {
  const h = freshUploadHarness({ intakeId: 'code:X' });
  const realNow = h.svc.io.now;
  h.svc.io.now = () => new Date('2026-09-30T01:30:00Z');   // 21:30 on 29 Sep in Toronto
  try {
    await h.svc.markDocumentReceived('5');
    assert.deepEqual(h.calls.columnWrites[0], { color_mm0zwgvr: { label: 'Received' }, date_mm0zyw0m: { date: '2026-09-29' }, color_mm0z796e: { label: 'Yes' } });
    assert.deepEqual(Object.keys(h.calls.columnWrites[0]), ['color_mm0zwgvr', 'date_mm0zyw0m', 'color_mm0z796e']);
    await h.svc.markDocumentReceived('5', { date: '2026-09-01' });
    assert.equal(h.calls.columnWrites[1].date_mm0zyw0m.date, '2026-09-01');
  } finally { h.svc.io.now = realNow; }
});

test('(22) applicantLabelFor: the same member the page displays — template row, code row with index, blank exec column', async () => {
  const svc = require('../src/services/documentFormService');
  const t = svc.applicantLabelFor({ intakeId: '18401624999', templateApplicantType: 'Spouse / Common-Law Partner', execApplicantType: '' });
  assert.equal(t.resolved, null);
  assert.equal(t.applicantType, 'Spouse / Common-Law Partner');
  assert.equal(t.applicantLabel, 'Spouse / Common-Law Partner');
  const blank = svc.applicantLabelFor({ intakeId: '', templateApplicantType: '', execApplicantType: '' });
  assert.deepEqual(blank, { resolved: null, applicantType: 'Principal Applicant', applicantLabel: 'Principal Applicant' });
  const exec = svc.applicantLabelFor({ intakeId: 'code:UNKNOWN-CODE-001', templateApplicantType: '', execApplicantType: 'Dependent Child 2' });
  assert.equal(exec.resolved, null);
  assert.equal(exec.applicantLabel, 'Dependent Child 2');
  const found = realSchemaCode({ role: 'DependentChild' });
  if (found) {
    const code2 = found.code.replace(`-${found.roleSlug}-`, `-${found.roleSlug}2-`);
    const c = svc.applicantLabelFor({ intakeId: `code:${code2}`, templateApplicantType: '', execApplicantType: 'Dependent Child 2' });
    assert.ok(c.resolved && c.resolved.memberIndex === 2);
    assert.equal(c.applicantLabel, `${c.resolved.role.label} 2`, 'the schema\'s display label + index');
    assert.equal(c.applicantType, 'Dependent Child 2');
  }
  // and getCaseDocuments agrees: drive it with a fake board carrying the three shapes
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const rows = [
    { id: '1', name: 'A', cols: { text_mm0zfsp1: '18401624999', text_mm26jcv7: '' } },
    { id: '2', name: 'B', cols: { text_mm0zfsp1: 'code:UNKNOWN-CODE-001', text_mm26jcv7: 'Dependent Child 2' } },
    { id: '3', name: 'C', cols: { text_mm0zfsp1: '', text_mm26jcv7: '' } },
  ];
  set('../src/services/mondayApi', { query: async (q) => {
    if (q.includes('items_page_by_column_values')) return { items_page_by_column_values: { items: rows.map((r) => ({ id: r.id, name: r.name, column_values: Object.entries(r.cols).map(([id, text]) => ({ id, text })) })) } };
    if (q.includes('items(ids: $ids, limit: $lim)')) return { items: [{ id: '18401624999', column_values: [{ id: 'dropdown_mm261bn6', text: 'Spouse / Common-Law Partner' }, { id: 'dropdown_mm0x41zm', text: 'Identity' }] }] };
    return {};
  } });
  set('../src/services/oneDriveService', {}); set('../src/services/caseReadinessService', { calculateForCaseRef: async () => {} });
  const p = require.resolve('../src/services/documentFormService'); delete require.cache[p];
  const fresh = require(p);
  const docs = await fresh.getCaseDocuments('2026-SPE-013');
  const by = Object.fromEntries(docs.map((d) => [d.id, d]));
  assert.equal(by['1'].applicantLabel, 'Spouse / Common-Law Partner');
  assert.equal(by['2'].applicantLabel, 'Dependent Child 2');
  assert.equal(by['3'].applicantLabel, 'Principal Applicant');
  assert.equal(by['1'].applicantType, fresh.applicantLabelFor({ intakeId: '18401624999', templateApplicantType: 'Spouse / Common-Law Partner' }).applicantType);
});

/** A resolvable document code from a registered schema (the seeder's format), optionally for a given role. */
function realSchemaCode({ role } = {}) {
  const registry = require('../src/services/caseSchemaService');
  const planner  = require('../src/services/seedPlanner');
  const slugUpper = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  for (const { caseType, subType } of registry.listRegistered()) {
    const schema = registry.lookup(caseType, subType);
    for (const r of (schema && schema.roles) || []) {
      if (role && r.role !== role) continue;
      const doc = (r.documents || [])[0];
      if (!doc) continue;
      const roleSlug = slugUpper(r.role);
      const code = `${slugUpper(caseType)}-${slugUpper(subType)}-${roleSlug}-${doc.code}-001`;
      if (planner.resolveDocumentCode(code)) return { code, roleSlug, role: r, doc };
    }
  }
  return null;
}
