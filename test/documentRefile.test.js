'use strict';

// Re-filing client uploads that the pre-2026-09-02 bug dropped into OneDrive
// "General": each General file is mapped to its checklist row through the
// upload audit comment ("File: <name> / Category: <resolved then>") and moved
// to that row's category folder. Anything unmapped, ambiguous, uncategorised,
// colliding in the target, or backed by possibly-truncated evidence STAYS and
// is reported. Only OneDrive moves; never deletes; never Monday. Dry-run default.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

function harness({ general = [], targets = {}, rows = [], moveFails = false, caseFolder = true, truncated = false } = {}) {
  const moves = [];
  const fakeOneDrive = {
    listFiles: async ({ subfolder }) => (subfolder === 'General' ? general : (targets[subfolder] || [])).map((n) => ({ name: n, size: 1, lastModifiedDateTime: 't' })),
    moveFile:  async (p) => { if (moveFails) { const e = new Error('OneDrive move failed: 503'); e.transient = true; throw e; } moves.push(p); return { webUrl: 'https://web/' + p.toSubfolder, name: p.filename }; },
    getClientFolderByName: async () => (caseFolder ? { id: 'f' } : null),
  };
  const fakeMonday = { query: async () => ({ items_page_by_column_values: { items: rows.map((r) => ({ id: r.id, name: r.name, column_values: [{ id: 'text_mm261tka', text: r.category }, { id: 'text_mm0zfsp1', text: r.intakeId || 'code:X' }], updates: (truncated ? Array(100).fill('x') : (r.updates || [])).map((b) => ({ text_body: b })) })) } }) };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('../src/services/oneDriveService', fakeOneDrive);
  set('../src/services/mondayApi', fakeMonday);
  const p = require.resolve('../src/services/documentRefileService');
  delete require.cache[p];
  return { svc: require(p), moves };
}

const upload = (docName, file, category = 'General') => `📄 Document Uploaded by Client\n\nDocument: ${docName}\nFile: ${file}\nCategory: ${category}\nCase: 2026-SPE-013 (Client)\nUploaded: t (Toronto)\n\nStatus set to Received — please review.`;

// The note written with unique names ON (documentFormService §3a, 2026-09-30):
// the same first lines, then the new lines AFTER Case: — the parser captures
// File: up to Category: and Category: up to Case:, so nothing new may sit
// between them.
const uploadNew = (docName, file, category = 'General', { renamed = false, replaced = false } = {}) =>
  `📄 Document Uploaded by Client\n\nDocument: ${docName}\nFile: ${file}\nCategory: ${category}\nCase: 2026-SPE-013 (Client)\n` +
  `For: Spouse / Common-Law Partner\nNamed by client: ${file.split(' – ').pop()}\n` +
  (renamed  ? 'Note: OneDrive added a number to the name because a file with this name already existed — both files are kept.\n' : '') +
  (replaced ? 'Warning: OneDrive replaced a file with this name — the earlier copy is in that file\'s version history.\n' : '') +
  `Uploaded: t (Toronto)\n\n🔗 Open this upload: https://org/f1\n📁 Folder: https://folder/${category}\n\nStatus set to Received — please review.\n\n🔎 Review all documents for this case: https://x/d/2026-SPE-013/review`;
const NEW_NAME = 'Passport – Spouse – 2026-09-30 14-32 – scan passport.pdf';

test('uploadedFiles parses File + Category from upload comments (newlines kept or collapsed); normFilename mirrors uploadFile storage + case-folds', () => {
  const { svc } = harness();
  assert.deepEqual(svc.uploadedFiles([upload('Passport', 'scan passport.pdf'), 'Retainer signed', '📄 Document Uploaded by Client Document: X File: a b.pdf Category: Identity Case: Y']),
    [{ file: 'scan passport.pdf', category: 'General' }, { file: 'a b.pdf', category: 'Identity' }]);
  assert.equal(svc.normFilename('  Scan: Passport  (1).PDF '), 'scan passport (1).pdf');
  assert.equal(svc.normFilename('scan passport.pdf'), svc.normFilename('SCAN  PASSPORT.pdf'));
});

test('uploadedFiles reads the unique-names note the same way: the stored name on File:, the category, nothing swallowed from the new lines', () => {
  const { svc } = harness();
  for (const [label, body] of [
    ['newlines kept', uploadNew('Passport', NEW_NAME, 'Identity')],
    ['newlines collapsed (Monday)', uploadNew('Passport', NEW_NAME, 'Identity').replace(/\n/g, ' ')],
    ['renamed on a clash', uploadNew('Passport', NEW_NAME.replace('.pdf', ' 1.pdf'), 'Identity', { renamed: true })],
    ['replaced (warning line)', uploadNew('Passport', NEW_NAME, 'Identity', { replaced: true }).replace(/\n/g, ' ')],
  ]) {
    const out = svc.uploadedFiles([body]);
    assert.equal(out.length, 1, label);
    assert.ok(out[0].file === NEW_NAME || out[0].file === NEW_NAME.replace('.pdf', ' 1.pdf'), `${label}: File: is the stored name (${out[0].file})`);
    assert.equal(out[0].category, 'Identity', label);
    assert.ok(!out[0].file.includes('For:') && !out[0].file.includes('Named by client'), `${label}: nothing after Case: leaks into the name`);
  }
  // the link label never reads as a second File: line
  assert.equal((uploadNew('Passport', NEW_NAME).match(/File:/g) || []).length, 1);
  // and normFilename leaves the built name alone apart from case
  assert.equal(svc.normFilename(NEW_NAME), NEW_NAME.toLowerCase());
});

test('planRefile maps a General file recorded under the unique-names note exactly as under the old one', () => {
  const { svc } = harness();
  for (const collapse of [false, true]) {
    const body = (fn) => collapse ? fn.replace(/\n/g, ' ') : fn;
    const rows = [
      { id: '1', name: 'Passport', category: 'Identity',  updates: [body(uploadNew('Passport', NEW_NAME))] },
      { id: '2', name: 'Bank',     category: 'Financial', updates: [body(upload('Bank', 'statement.pdf'))] },
    ];
    const general = [{ name: NEW_NAME }, { name: 'statement.pdf' }, { name: 'stray.pdf' }];
    const plan = svc.planRefile(general, rows, {});
    assert.deepEqual(plan.moves, [
      { file: NEW_NAME, to: 'Identity', rowId: '1', docName: 'Passport' },
      { file: 'statement.pdf', to: 'Financial', rowId: '2', docName: 'Bank' },
    ], `both note shapes map (collapsed=${collapse})`);
    assert.deepEqual(plan.unmapped, ['stray.pdf']);
  }
});

test('planRefile: single consistent claimant → move; everything else stays with a reason', () => {
  const { svc } = harness();
  const rows = [
    { id: '1', name: 'Passport',  category: 'Identity',  updates: [upload('Passport', 'scan passport.pdf')] },
    { id: '2', name: 'Bank',      category: 'Financial', updates: [upload('Bank', 'statement.pdf'), upload('Bank', 'shared.pdf')] },
    { id: '3', name: 'Degree',    category: 'Academic',  updates: [upload('Degree', 'shared.pdf')] },
    { id: '4', name: 'Misc',      category: 'General',   updates: [upload('Misc', 'misc.pdf')] },
    { id: '5', name: 'Odd',       category: '../x',      updates: [upload('Odd', 'odd.pdf')] },
    { id: '6', name: 'NoCat',     category: '',          updates: [upload('NoCat', 'nocat.pdf'), upload('NoCat', 'statement.pdf')] },
    { id: '7', name: 'Photo',     category: 'Identity',  updates: [upload('Photo', 'Photo: ID.jpg')] },          // stored as "Photo ID.jpg"
    { id: '8', name: 'Photo dup', category: 'Academic',  updates: [upload('Photo dup', 'photo id.JPG')] },       // collapses onto the same stored item
    { id: '9', name: 'Letter',    category: 'Employment', updates: [upload('Letter', 'letter.pdf', 'Employment'), upload('Letter', 'letter.pdf')] }, // one upload was recorded elsewhere
    { id: '10', name: 'T4',       category: 'Financial', updates: [upload('T4', 'T4.pdf')] },
  ];
  const general = ['scan passport.pdf', 'statement.pdf', 'shared.pdf', 'misc.pdf', 'odd.pdf', 'nocat.pdf', 'stray.pdf', 'Photo ID.jpg', 'letter.pdf', 'T4.pdf'].map((name) => ({ name }));
  const plan = svc.planRefile(general, rows, { targetFiles: { Financial: ['t4.pdf'] } });
  assert.deepEqual(plan.moves, [{ file: 'scan passport.pdf', to: 'Identity', rowId: '1', docName: 'Passport' }]);
  assert.deepEqual(plan.unmapped, ['stray.pdf']);
  assert.deepEqual(plan.ambiguous.map((a) => a.file), ['shared.pdf', 'Photo ID.jpg', 'letter.pdf']);
  assert.match(plan.ambiguous[2].reason, /recorded under Employment/);
  assert.deepEqual(plan.stays.map((s) => s.file), ['statement.pdf', 'misc.pdf', 'odd.pdf', 'nocat.pdf', 'T4.pdf']);
  assert.match(plan.stays.find((s) => s.file === 'statement.pdf').reason, /row with no category \(NoCat\)/, 'an uncategorised claimant blocks the move');
  assert.match(plan.stays.find((s) => s.file === 'T4.pdf').reason, /already exists in Financial/, 'target collision (case-insensitive) stays');
  // truncated evidence → nothing moves
  const t = svc.planRefile(general, rows, { evidenceTruncated: true });
  assert.equal(t.moves.length, 0); assert.equal(t.stays.length, general.length);
});

test('refileGeneralUploads: dry-run plans without moving; write moves only planned files; transient failure stops the loop; empty General checks the case folder', async () => {
  const rows = [{ id: '1', name: 'Passport', category: 'Identity', updates: [upload('Passport', 'scan passport.pdf')] }, { id: '2', name: 'Bank', category: 'Financial', updates: [upload('Bank', 'statement.pdf')] }];
  let h = harness({ general: ['scan passport.pdf', 'statement.pdf', 'stray.pdf'], rows });
  let out = await h.svc.refileGeneralUploads({ caseRef: '2026-SPE-013', clientName: 'C' });
  assert.equal(out.dryRun, true); assert.equal(out.generalCount, 3); assert.equal(out.plan.moves.length, 2); assert.equal(h.moves.length, 0); assert.equal(out.evidenceTruncated, false);

  h = harness({ general: ['scan passport.pdf', 'statement.pdf', 'stray.pdf'], rows });
  out = await h.svc.refileGeneralUploads({ caseRef: '2026-SPE-013', clientName: 'C', dryRun: false });
  assert.equal(out.moved.length, 2); assert.equal(out.failed.length, 0); assert.equal(out.moved[0].renamed, false);
  assert.deepEqual(h.moves.map((m) => [m.fromSubfolder, m.toSubfolder, m.filename]), [['General', 'Identity', 'scan passport.pdf'], ['General', 'Financial', 'statement.pdf']]);

  h = harness({ general: ['scan passport.pdf', 'statement.pdf'], rows, moveFails: true });
  out = await h.svc.refileGeneralUploads({ caseRef: '2026-SPE-013', clientName: 'C', dryRun: false });
  assert.equal(out.failed.length, 1); assert.equal(out.failed[0].transient, true); assert.equal(out.notAttempted.length, 1, 'stops after the first transient failure');

  h = harness({ general: ['scan passport.pdf'], rows, truncated: true });
  out = await h.svc.refileGeneralUploads({ caseRef: '2026-SPE-013', clientName: 'C', dryRun: false });
  assert.equal(out.evidenceTruncated, true); assert.equal(out.moved.length, 0); assert.equal(out.plan.stays.length, 1);

  h = harness({ general: [], rows, caseFolder: false });
  out = await h.svc.refileGeneralUploads({ caseRef: '2026-SPE-013', clientName: 'C', dryRun: false });
  assert.equal(out.caseFolderFound, false); assert.equal(out.rowCount, 0, 'Monday untouched when General is empty');
});

test('pins: moveFile never deletes and keeps both on a clash; endpoint admin-only + dry-run default; driver needs --write --yes and accumulates partial results', () => {
  const od = fs.readFileSync(require.resolve('../src/services/oneDriveService.js'), 'utf8');
  const i = od.indexOf('async function moveFile(');
  const mf = od.slice(i, od.indexOf('\n}\n', i));
  assert.ok(i !== -1, 'moveFile present');
  assert.match(mf, /conflictBehavior': 'rename'/);
  assert.match(mf, /fromSubfolder === toSubfolder\) throw/);
  assert.doesNotMatch(mf, /axios\.delete/);
  assert.match(od, /readFile, listFiles, listChildren, moveFile,/);
  // listFiles is now a filter over listChildren — one paging code path, same contract
  assert.match(od, /async function listFiles\(\{ clientName, caseRef, subfolder \}\) \{\s*\n\s*const kids = await listChildren\(/);

  const server = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const j = server.indexOf("app.post('/admin/onedrive/refile-general'");
  assert.ok(j !== -1);
  const block = server.slice(j, server.indexOf('app.post(', j + 10));
  assert.match(block, /resolveAdminOrReject\(req, res, '[^']*'\)/);
  assert.match(block, /dryRun\s*=\s*\(req\.body \|\| \{\}\)\.dryRun !== false/);
  assert.doesNotMatch(block, /deleteDriveItem|mutation|change_multiple_column_values/);

  const drv = fs.readFileSync(require.resolve('../scripts/refile-general-uploads.js'), 'utf8');
  assert.match(drv, /dryRun: !WRITE/);
  assert.match(drv, /if \(WRITE && !YES\)/, 'write needs an explicit --yes');
  assert.match(drv, /acc\.moved\.push\(\.\.\.json\.moved\)/, 'moves accumulate across retry attempts');
  assert.match(drv, /err\.name === 'TimeoutError'/, 'client timeout is not retried');
  assert.match(drv, /if \(ONLY\.length\) \{ cases = ONLY;/, 'explicit --only skips discovery (no silent no-match)');
  assert.doesNotMatch(drv, /mutation/);
});
