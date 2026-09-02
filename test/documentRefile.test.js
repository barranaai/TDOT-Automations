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

test('uploadedFiles parses File + Category from upload comments (newlines kept or collapsed); normFilename mirrors uploadFile storage + case-folds', () => {
  const { svc } = harness();
  assert.deepEqual(svc.uploadedFiles([upload('Passport', 'scan passport.pdf'), 'Retainer signed', '📄 Document Uploaded by Client Document: X File: a b.pdf Category: Identity Case: Y']),
    [{ file: 'scan passport.pdf', category: 'General' }, { file: 'a b.pdf', category: 'Identity' }]);
  assert.equal(svc.normFilename('  Scan: Passport  (1).PDF '), 'scan passport (1).pdf');
  assert.equal(svc.normFilename('scan passport.pdf'), svc.normFilename('SCAN  PASSPORT.pdf'));
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
  assert.match(mf, /conflictBehavior': 'rename'/);
  assert.match(mf, /fromSubfolder === toSubfolder\) throw/);
  assert.doesNotMatch(mf, /axios\.delete/);
  assert.match(od, /readFile, listFiles, moveFile,/);

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
