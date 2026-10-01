'use strict';

// Repair for a case whose reference sits on a leftover TEST folder and the
// client's real folder (2026-09-30: Aquib 2026-CEC-PR-002, Ameena 2026-VV-008,
// Yatin 2026-SP-015). Order of the real run: the test folder is RENAMED off the
// reference first (so the live app lands on the real folder from then on),
// then every file moves by id, then the result is checked; the client's
// checklist rows are re-pointed and a note is posted. Preview by default; the
// real run needs the confirmation text; nothing is ever deleted.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const svc = () => { const p = require.resolve('../src/services/caseFolderMergeService'); delete require.cache[p]; return require(p); };
const NOW = Date.parse('2026-09-30T23:40:00Z');
const file = (id, name, extra = {}) => ({ id, name, size: 100, isFolder: false, createdAt: '2026-09-17T10:00:00Z', modifiedAt: '2026-09-17T10:00:00Z', createdBy: 'SharePoint App', modifiedBy: 'SharePoint App', ...extra });

/** Praj's test folder as it really is, and Ameena's real folder with one same-named (older) file. */
function trees() {
  const from = { folder: { id: 'PRAJ', name: 'Praj - 2026-VV-008', webUrl: 'https://w/praj' }, rootFiles: [], folders: [
    { id: 'p-cons', name: 'Consultation', files: [file('c1', 'consultation-agreement-SIGNED.pdf')], nested: [] },
    { id: 'p-fin',  name: 'Financial',    files: [file('f1', 'Notice of assessment 2024.pdf'), file('f2', 'Balance Certificate visit.pdf')], nested: [] },
    { id: 'p-int',  name: 'Intake',       files: [file('i1', 'intake-submission.json'), file('i2', 'pre-consult-submission.json')], nested: [] },
    { id: 'p-q',    name: 'Questionnaire', files: [file('q1', 'questionnaire-2026-VV-008-primary.json')], nested: [] },
    { id: 'p-ret',  name: 'Retainer',     files: [file('r1', 'retainer-agreement-SIGNED.pdf', { modifiedAt: '2026-09-15T18:59:00Z' })], nested: [] },
    { id: 'p-other', name: 'Other',       files: [], nested: [] },
  ] };
  const to = { folder: { id: 'AMEENA', name: 'Ameena Begum - 2026-VV-008', webUrl: 'https://w/ameena' }, rootFiles: [], folders: [
    { id: 'a-ret', name: 'Retainer', files: [file('ar1', 'retainer-agreement-SIGNED.pdf', { modifiedAt: '2026-09-12T12:36:00Z' })], nested: [] },
  ] };
  return { from, to };
}
const KEEP = ['Consultation/consultation-agreement-SIGNED.pdf', 'Intake/intake-submission.json', 'Intake/pre-consult-submission.json'];
const NEW = 'ZZ-TEST Praj (was 2026-VV-008)';
const ARGS = { from: 'Praj - 2026-VV-008', to: 'Ameena Begum - 2026-VV-008', keep: KEEP, renameFromTo: NEW };
const REAL = { ...ARGS, dryRun: false, confirm: 'MOVE-CASE-FILES', by: 'faran@x' };

function harness(opts = {}) {
  const s = svc();
  const t = trees();
  const from = opts.from || t.from, to = opts.to || t.to;
  const seen = { moves: [], movedOk: [], renames: [], subfolders: [], notes: [], forgets: [], treeCalls: [], rowLinks: [], catLinks: [], holds: [], releases: [] };
  let renamedName = null;
  s.io.now = () => new Date(NOW);
  s.io.sleep = async () => {};
  s.io.tree = async (name) => {
    seen.treeCalls.push(name);
    const gone = (d) => ({ ...d, files: d.files.filter((f) => !seen.movedOk.includes(f.id)) });
    if (name === from.folder.name && !renamedName) return seen.movedOk.length ? (opts.afterTree ? opts.afterTree(seen) : { ...from, folders: from.folders.filter((d) => !seen.movedOk.includes(d.id)).map(gone) }) : from;
    if (renamedName && name === renamedName) return opts.afterTree ? opts.afterTree(seen) : { ...from, folder: { ...from.folder, name: renamedName }, folders: from.folders.filter((d) => !seen.movedOk.includes(d.id)).map(gone) };
    if (name === to.folder.name) return to;
    return null;
  };
  const nameOf = new Map([...from.folders.map((d) => [d.id, d.name]), ...from.rootFiles.map((f) => [f.id, f.name]), ...from.folders.flatMap((d) => d.files.map((f) => [f.id, f.name]))]);
  s.io.move = async (p) => { seen.moves.push(p); const f = opts.moveFails && opts.moveFails(p, seen); if (f) throw new Error(f); seen.movedOk.push(p.itemId); const custom = opts.storedAs && opts.storedAs(p); return { id: p.itemId, name: custom || nameOf.get(p.itemId) || p.itemId, webUrl: 'https://w/' + p.itemId }; };
  s.io.rename = async (p) => { seen.renames.push(p); if (opts.renameFails && opts.renameFails(p)) throw new Error(opts.renameFails(p)); if (p.itemId === from.folder.id) renamedName = p.newName; return { id: p.itemId, name: p.newName }; };
  s.io.subfolder = async (p) => { seen.subfolders.push(p); return { id: 'new-' + p.name, name: p.name, created: true }; };
  s.io.forget = (ref) => { seen.forgets.push(ref); };
  s.io.hold = (ref) => { seen.holds.push([ref, seen.renames.length, seen.moves.length]); };
  s.io.release = (ref) => { seen.releases.push([ref, seen.moves.length, seen.treeCalls.length]); };
  s.io.foldersByRef = async () => (opts.foldersByRef ? opts.foldersByRef() : [{ id: to.folder.id, name: to.folder.name, childCount: 5 }]);
  s.io.orgLink = async (id) => 'https://org/' + id;
  s.io.caseItems = opts.caseItems || (async () => [{ id: '13027739210', name: 'Ameena Begum', folderId: 'AMEENA' }]);
  s.io.docRows = opts.docRows || (async () => [{ id: 'd1', name: 'Passport', category: 'Identity' }, { id: 'd2', name: 'NOA', category: 'Financial' }, { id: 'd3', name: 'NOA 2', category: 'Financial' }, { id: 'd4', name: 'blank', category: '' }]);
  s.io.categoryLink = async (p) => { seen.catLinks.push(p); return `https://link/${p.category}`; };
  s.io.setRowFolderLink = async (id, url, text) => { seen.rowLinks.push([id, url, text]); };
  s.io.note = async (id, body) => { seen.notes.push([id, body]); };
  return { s, seen, t };
}
const quiet = (fn) => async () => { const o = [console.log, console.warn, console.error]; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { [console.log, console.warn, console.error] = o; } };

test('preview: every file with where it goes, the kept files, clashes (who is newer), new sub-folders, the Monday rows — and NOTHING changes', async () => {
  const { s, seen } = harness();
  const r = await s.mergeCaseFolders(ARGS);
  assert.equal(r.mode, 'preview (nothing changed)');
  assert.equal(r.caseRef, '2026-VV-008');
  assert.equal(r.outcome, 'ready');
  assert.deepEqual(r.moves.map((m) => m.path).sort(), ['Financial/Balance Certificate visit.pdf', 'Financial/Notice of assessment 2024.pdf', 'Questionnaire/questionnaire-2026-VV-008-primary.json', 'Retainer/retainer-agreement-SIGNED.pdf']);
  assert.deepEqual(r.stays.sort(), KEEP.slice().sort());
  assert.match(r.moves.find((m) => m.path.startsWith('Retainer/')).note, /this one is newer and keeps the name; the older is set aside/);
  assert.equal(r.moves.find((m) => m.path.startsWith('Financial/')).note, 'moves with its whole sub-folder');
  assert.deepEqual(r.folderMoves, ['Questionnaire/ (1 file) — the whole sub-folder, in one step', 'Financial/ (2 files) — the whole sub-folder, in one step', 'Other/ (0 files) — the whole sub-folder, in one step'], 'Questionnaire first; Consultation and Intake hold kept files so they stay; Retainer exists in the real folder so its file goes alone');
  assert.deepEqual(r.emptySubfoldersLeft, []);
  assert.deepEqual(r.counts, { toMove: 4, toStay: 3, clashes: 1 });
  assert.deepEqual(r.caseRows, ['13027739210 Ameena Begum']);
  assert.deepEqual(r.blockers, []);
  assert.equal(seen.moves.length + seen.renames.length + seen.subfolders.length + seen.notes.length + seen.forgets.length + seen.rowLinks.length, 0);
});

test('the real run needs the exact confirmation text; anything else changes nothing', async () => {
  for (const confirm of [undefined, '', 'yes', 'move-case-files', 'MOVE-CASE-FILES ']) {
    const { s, seen } = harness();
    await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, dryRun: false, confirm }), /MOVE-CASE-FILES/);
    assert.equal(seen.moves.length + seen.renames.length, 0);
  }
});

test('real run, in order: RENAME the test folder off the reference FIRST, forget the cache, then move by id into same-named sub-folders (created once), kept files stay, newer clash keeps the name and the older is set aside, then re-list + reference check, rows re-pointed, note posted', quiet(async () => {
  const { s, seen } = harness();
  const order = [];
  const wrap = (k) => { const f = s.io[k]; s.io[k] = async (...a) => { order.push(k); return f(...a); }; };
  ['hold', 'rename', 'move', 'forget', 'release', 'foldersByRef', 'note', 'setRowFolderLink', 'categoryLink'].forEach(wrap);
  const r = await s.mergeCaseFolders(REAL);
  assert.equal(r.mode, 'REAL RUN');
  assert.deepEqual(order.slice(0, 3), ['hold', 'rename', 'forget'], 'on hold, THEN the rename is the first change, then the cache is forgotten');
  assert.ok(order.indexOf('release') > order.lastIndexOf('move'), 'the hold lasts until the last move');
  assert.ok(order.indexOf('release') < order.indexOf('foldersByRef') && order.indexOf('release') < order.indexOf('categoryLink'), 'released before the app is asked to resolve again');
  assert.ok(order.indexOf('note') > order.lastIndexOf('move'));
  assert.deepEqual(seen.holds, [['2026-VV-008', 0, 0]]); assert.deepEqual(seen.releases.map((x) => x[0]), ['2026-VV-008']);
  assert.deepEqual(seen.renames[0], { itemId: 'PRAJ', newName: NEW });
  assert.deepEqual(r.renamed, { from: 'Praj - 2026-VV-008', to: NEW });
  assert.deepEqual(seen.forgets, ['2026-VV-008']);
  assert.equal(r.moved.length, 4); assert.equal(r.failed.length, 0);
  // whole sub-folders first (Questionnaire before Financial), then the lone Retainer file into the existing sub-folder
  assert.deepEqual(seen.moves.map((m) => [m.itemId, m.toFolderId]), [['p-q', 'AMEENA'], ['p-fin', 'AMEENA'], ['p-other', 'AMEENA'], ['r1', 'a-ret']]);
  assert.ok(!seen.moves.some((m) => ['c1', 'i1', 'i2', 'p-cons', 'p-int'].includes(m.itemId)), 'the test run\'s own files and their folders stay');
  assert.deepEqual(seen.subfolders, [], 'no sub-folder had to be created: they moved whole');
  assert.deepEqual(r.moved.filter((m) => m.withFolder).map((m) => m.path).sort(), ['Financial/Balance Certificate visit.pdf', 'Financial/Notice of assessment 2024.pdf', 'Questionnaire/questionnaire-2026-VV-008-primary.json']);
  // the older same-named retainer in the real folder was set aside BEFORE the newer one moved in
  const aside = seen.renames.find((x) => x.itemId === 'ar1');
  assert.equal(aside.newName, 'retainer-agreement-SIGNED (before merge 2026-09-30).pdf');
  assert.ok(seen.renames.indexOf(aside) < seen.moves.findIndex((m) => m.itemId === 'r1'));
  assert.deepEqual(r.setAside, [{ path: 'Retainer/retainer-agreement-SIGNED.pdf', storedAs: 'retainer-agreement-SIGNED (before merge 2026-09-30).pdf' }]);
  // checks
  assert.deepEqual(r.leftBehind, [], 'only the kept files remain in the renamed folder');
  assert.deepEqual(r.foldersCarryingRef, ['Ameena Begum - 2026-VV-008']);
  // rows: one link per category, every row with a category re-pointed
  assert.deepEqual(seen.catLinks.map((p) => [p.clientName, p.caseRef, p.category]), [['Ameena Begum', '2026-VV-008', 'Identity'], ['Ameena Begum', '2026-VV-008', 'Financial']]);
  assert.deepEqual(seen.rowLinks, [['d1', 'https://link/Identity', 'Identity Folder'], ['d2', 'https://link/Financial', 'Financial Folder'], ['d3', 'https://link/Financial', 'Financial Folder']]);
  assert.deepEqual(r.rowLinks, { repointed: 3, failed: 0 });
  // the note
  assert.equal(seen.notes.length, 1);
  assert.equal(seen.notes[0][0], '13027739210');
  assert.match(seen.notes[0][1], /4 files, by faran@x/);
  assert.match(seen.notes[0][1], /ZZ-TEST Praj \(was 2026-VV-008\)/);
  assert.match(seen.notes[0][1], /only the test run's own files \(3\)/);
  assert.match(seen.notes[0][1], /Set aside .*before merge 2026-09-30/);
  assert.match(seen.notes[0][1], /https:\/\/org\/AMEENA/, 'a staff-openable link');
  assert.match(r.outcome, /^done: 4 file\(s\) moved/);
}));

test('a move that keeps failing: retried, then reported; the test folder is ALREADY off the reference so the app sees the real folder; the hold is released anyway; the note says what is still in the renamed folder; the outcome says exactly how to finish (finish flag + the same keep list)', quiet(async () => {
  const { s, seen } = harness({ moveFails: (p) => (p.itemId === 'p-fin' ? 'HTTP 503' : null) });
  const r = await s.mergeCaseFolders(REAL);
  assert.equal(seen.moves.filter((m) => m.itemId === 'p-fin').length, 3, 'two retries');
  assert.equal(r.moved.length, 2);
  assert.deepEqual(r.failed.map((f) => f.path).sort(), ['Financial/Balance Certificate visit.pdf', 'Financial/Notice of assessment 2024.pdf']);
  assert.match(r.failed[0].error, /with its sub-folder: HTTP 503/);
  assert.deepEqual(r.renamed, { from: 'Praj - 2026-VV-008', to: NEW });
  assert.deepEqual(seen.releases.length, 1);
  assert.deepEqual(r.leftBehind.sort(), ['Financial/Balance Certificate visit.pdf', 'Financial/Notice of assessment 2024.pdf']);
  assert.match(seen.notes[0][1], /could NOT be moved and are still in "ZZ-TEST Praj \(was 2026-VV-008\)": .*\(kept there on purpose: Consultation\/consultation-agreement-SIGNED.pdf; Intake/);
  assert.match(r.outcome, /done WITH PROBLEMS.*finish: true, from = "ZZ-TEST Praj \(was 2026-VV-008\)" and the SAME keep list \["Consultation\/consultation-agreement-SIGNED.pdf"/);
}));

test('finishing an earlier run needs finish: true with from = the renamed name and the keep list; no rename happens; the leftover files move; the result is clean', quiet(async () => {
  const t = trees();
  const from = { ...t.from, folder: { ...t.from.folder, name: NEW }, folders: [t.from.folders[0], t.from.folders[1], t.from.folders[2]] };   // the kept files + Financial left
  const { s, seen } = harness({ from });
  await assert.rejects(() => s.mergeCaseFolders({ ...REAL, from: NEW }), /is the renamed name — to finish an earlier run send finish: true/);
  await assert.rejects(() => s.mergeCaseFolders({ ...REAL, finish: true }), /finish: from must be the renamed name/);
  await assert.rejects(() => s.mergeCaseFolders({ ...REAL, finish: true, from: 'Bo Chen - 2026-VV-009', renameFromTo: 'Bo Chen - 2026-VV-009' }), /must not end with " - <anything>"/);
  assert.equal(seen.renames.length + seen.moves.length, 0);
  const r = await s.mergeCaseFolders({ ...REAL, from: NEW, finish: true });
  assert.equal(r.alreadyRenamed, true);
  assert.equal(seen.renames.filter((x) => x.itemId === 'PRAJ').length, 0);
  assert.equal(r.moved.length, 2);
  assert.deepEqual(seen.holds.length, 1); assert.deepEqual(seen.releases.length, 1);
  assert.deepEqual(seen.forgets, ['2026-VV-008']);
  assert.deepEqual(r.leftBehind, []);
  assert.match(r.outcome, /^done: 2 file\(s\) moved/);
}));

test('the rename failing: NOTHING moves, nothing is noted, the outcome says nothing changed', quiet(async () => {
  const { s, seen } = harness({ renameFails: (p) => (p.itemId === 'PRAJ' ? 'nameAlreadyExists' : null) });
  const r = await s.mergeCaseFolders(REAL);
  assert.equal(seen.moves.length, 0);
  assert.equal(seen.notes.length, 0);
  assert.equal(r.renamed, null);
  assert.deepEqual(seen.releases.length, 1, 'the hold never outlives the run');
  assert.match(r.outcome, /REFUSED before any file moved.*nameAlreadyExists.*Nothing changed/);
}));

test('a rename OneDrive silently altered (name comes back different) counts as failed: nothing moves', quiet(async () => {
  const { s, seen } = harness();
  s.io.rename = async (p) => { seen.renames.push(p); return { id: p.itemId, name: p.newName + ' - 2026-VV-008' }; };
  const r = await s.mergeCaseFolders(REAL);
  assert.equal(seen.moves.length, 0);
  assert.match(r.outcome, /REFUSED before any file moved/);
}));

test('blockers refuse the real run (and the preview names them): a file changed in the last 15 min, a folder nested in a sub-folder, Monday linking a different folder, no case row', async () => {
  const t1 = trees(); t1.from.folders[1].files[0].modifiedAt = '2026-09-30T23:31:00Z';
  const h1 = harness({ from: t1.from });
  const p1 = await h1.s.mergeCaseFolders(ARGS);
  assert.match(p1.blockers[0], /changed 9 min ago — someone is working on this case/);
  assert.match(p1.outcome, /REFUSED/);
  await assert.rejects(() => h1.s.mergeCaseFolders(REAL), /refused: .*changed 9 min ago/);
  assert.equal(h1.seen.renames.length, 0);

  const t2 = trees(); t2.from.folders[3].nested = [{ id: 'n1', name: 'old versions' }];
  const h2 = harness({ from: t2.from });
  assert.match((await h2.s.mergeCaseFolders(ARGS)).blockers[0], /"Questionnaire\/old versions" is a folder inside a sub-folder/);

  const h3 = harness({ caseItems: async () => [{ id: '1', name: 'Ameena Begum', folderId: 'SOMEWHERE-ELSE' }] });
  assert.match((await h3.s.mergeCaseFolders(ARGS)).blockers[0], /Monday links a different folder for 2026-VV-008 \(id SOMEWHERE-ELSE\)/);

  const h4 = harness({ caseItems: async () => [] });
  assert.match((await h4.s.mergeCaseFolders(ARGS)).blockers[0], /no Cases-board row carries 2026-VV-008/);
});

test('Monday unreadable → refused BEFORE anything changes (a real run too)', async () => {
  const { s, seen } = harness({ caseItems: async () => { throw new Error('Monday 503'); } });
  await assert.rejects(() => s.mergeCaseFolders(REAL), /Monday could not be read \(Monday 503\) — nothing was changed/);
  assert.equal(seen.renames.length + seen.moves.length, 0);
});

test('after the run, a folder that re-appeared under the old reference (a write in flight) is reported loudly, never "done"', quiet(async () => {
  const { s } = harness({ foldersByRef: () => [{ id: 'AMEENA', name: 'Ameena Begum - 2026-VV-008' }, { id: 'GHOST', name: 'Praj - 2026-VV-008' }] });
  const r = await s.mergeCaseFolders(REAL);
  assert.deepEqual(r.foldersCarryingRef, ['Ameena Begum - 2026-VV-008', 'Praj - 2026-VV-008']);
  assert.match(r.outcome, /done WITH PROBLEMS.*reference is NOT on exactly the real folder/);
}));

test('an item left in the renamed folder that is not a kept file (arrived during the run) is reported', quiet(async () => {
  const { s } = harness({ afterTree: () => { const t = trees().from; return { ...t, folder: { ...t.folder, name: NEW }, folders: [t.folders[0], t.folders[2], { id: 'x', name: 'Identity', files: [file('late', 'late-upload.pdf')], nested: [] }] }; } });
  const r = await s.mergeCaseFolders(REAL);
  assert.deepEqual(r.leftBehind, ['Identity/late-upload.pdf']);
  assert.match(r.outcome, /unexpected item\(s\) left in "ZZ-TEST Praj \(was 2026-VV-008\)": Identity\/late-upload.pdf/);
}));

test('row re-pointing and the note are best effort: their failures are in the report, the moves are not undone and the report still comes back', quiet(async () => {
  const { s } = harness({ docRows: async () => { throw new Error('Monday down'); } });
  s.io.note = async () => { throw new Error('no note'); };
  const r = await s.mergeCaseFolders(REAL);
  assert.equal(r.moved.length, 4);
  assert.equal(r.rowLinks.error, 'Monday down');
  assert.equal(r.noteError, 'no note');
  assert.deepEqual(r.noted, []);
}));

test('an OLDER clashing file moving in gets the suffix (the newer one in the real folder keeps the name; nothing set aside)', quiet(async () => {
  const t = trees(); t.from.folders[4].files[0].modifiedAt = '2026-09-10T00:00:00Z';
  const { s, seen } = harness({ from: t.from, storedAs: (p) => (p.itemId === 'r1' ? 'retainer-agreement-SIGNED 1.pdf' : null) });
  const p = await s.mergeCaseFolders(ARGS);
  assert.match(p.moves.find((m) => m.path.startsWith('Retainer/')).note, /is NEWER — it keeps the name; this one is stored with a suffix/);
  const r = await s.mergeCaseFolders(REAL);
  assert.equal(seen.renames.filter((x) => x.itemId === 'ar1').length, 0);
  assert.deepEqual(r.setAside, []);
  assert.equal(r.moved.find((m) => m.path.startsWith('Retainer/')).storedAs, 'retainer-agreement-SIGNED 1.pdf');
  assert.match(seen.notes[0][1], /Retainer\/retainer-agreement-SIGNED.pdf \(now "retainer-agreement-SIGNED 1.pdf"\)/);
}));

test('guards: both folders must carry the SAME reference (or from = the renamed name); the new name must NOT; no illegal characters; keep must be a list of real paths; same folder refused by name AND by id', async () => {
  const { s } = harness();
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, from: 'Praj - 2026-VV-009' }), /from must end with the SAME case reference/);
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, to: 'Praj - 2026-VV-008' }), /same folder/);
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, to: 'praj - 2026-vv-008' }), /same folder/);
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, renameFromTo: 'Praj old - 2026-VV-008' }), /must not end with " - <anything>"/);
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, renameFromTo: 'Praj old - 2026-VV-009' }), /must not end with " - <anything>"/);
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, renameFromTo: 'ZZ Praj - 2026-VV-008?' }), /characters OneDrive does not allow/);
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, renameFromTo: '' }), /renameFromTo is required/);
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, renameFromTo: 'ZZ/TEST' }), /characters OneDrive does not allow/);
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, keep: 'Intake/x' }), /keep must be a list/);
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, keep: ['Intake/intake-submission.json', ''] }), /keep must be a list/);
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, keep: ['Intake/missing.json'] }), /not in "Praj - 2026-VV-008": Intake\/missing.json/);
  await assert.rejects(() => s.mergeCaseFolders({ ...ARGS, from: 'Nobody - 2026-VV-008' }), /no folder named "Nobody - 2026-VV-008"/);
  for (const a of [{ ...ARGS, from: '' }, { ...ARGS, to: '' }]) await assert.rejects(() => s.mergeCaseFolders(a), /required/);
  const t = trees(); t.to.folder.id = 'PRAJ';
  const h = harness({ to: t.to });
  await assert.rejects(() => h.s.mergeCaseFolders(ARGS), /same folder/);
});

test('the refusals are "bad request" errors (the route answers 400); the route is admin-only, preview by default, and passes keep through untouched', async () => {
  const { s } = harness();
  await s.mergeCaseFolders({ ...ARGS, to: 'X - 2026-VV-009' }).catch((e) => assert.equal(e.badRequest, true));
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const i = src.indexOf("app.post('/admin/onedrive/merge-case-folders'");
  assert.ok(i !== -1);
  const body = src.slice(i, i + 1200);
  assert.ok(body.includes('resolveAdminOrReject'));
  assert.ok(body.includes('dryRun: b.dryRun !== false'));
  assert.ok(body.includes("confirm: String(b.confirm || '')"));
  assert.ok(body.includes('keep: b.keep === undefined ? [] : b.keep'));
  assert.ok(body.includes('finish: b.finish === true'));
  assert.ok(body.includes('status(400)'));
});

test('the service never deletes: no delete call in it or in the by-id helpers; a move keeps both on a clash; a rename never replaces', () => {
  const merge = fs.readFileSync(require.resolve('../src/services/caseFolderMergeService'), 'utf8');
  assert.doesNotMatch(merge.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /delete|remove|trash/i);
  const od = fs.readFileSync(require.resolve('../src/services/oneDriveService'), 'utf8');
  for (const fn of ['moveItemById', 'renameItemById', 'ensureSubfolderById', 'orgLinkById']) {
    const i = od.indexOf(`async function ${fn}`); const j = od.indexOf('\nasync function ', i + 10);
    assert.doesNotMatch(od.slice(i, j === -1 ? undefined : j), /axios\.delete|axios\.put/, fn);
  }
  assert.match(od.slice(od.indexOf('async function moveItemById'), od.indexOf('async function renameItemById')), /conflictBehavior': 'rename'/);
  assert.match(od.slice(od.indexOf('async function renameItemById'), od.indexOf('async function ensureSubfolderById')), /conflictBehavior': 'fail'/);
});

test('renameItemById refuses a name the sanitiser would change, instead of storing something else; forgetCaseFolder drops exactly that case', async () => {
  const p = require.resolve('../src/services/oneDriveService');
  const set = (rel, exports) => { const q = require.resolve(rel); require.cache[q] = { id: q, filename: q, loaded: true, exports }; };
  set('axios', { get: async () => { throw new Error('no network'); }, patch: async () => { throw new Error('no network'); } });
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'tok', invalidateAccessToken: () => {} });
  delete require.cache[p];
  const od = require(p);
  await assert.rejects(() => od.renameItemById({ itemId: 'X', newName: 'ZZ Praj - 2026-VV-008?' }), (e) => { assert.equal(e.badRequest, true); return /does not allow/.test(e.message); });
  od._clearCaseFolderCache();
  od._seedCaseFolderCacheForTests('2026-VV-008', { name: 'Praj - 2026-VV-008', id: 'PRAJ', at: Date.now() });
  od._seedCaseFolderCacheForTests('2026-VV-009', { name: 'Bo - 2026-VV-009', id: 'BO', at: Date.now() });
  od.forgetCaseFolder('2026-VV-008');
  assert.equal(od._caseFolderCacheHasForTests('2026-VV-008'), false);
  assert.equal(od._caseFolderCacheHasForTests('2026-VV-009'), true);
});

test('listRootFolderTree reports a folder nested inside a sub-folder instead of hiding it', async () => {
  const p = require.resolve('../src/services/oneDriveService');
  const set = (rel, exports) => { const q = require.resolve(rel); require.cache[q] = { id: q, filename: q, loaded: true, exports }; };
  set('axios', { get: async (url) => {
    const u = decodeURIComponent(url);
    if (/root:\/Client Documents\/A - 1:\?/.test(u)) return { data: { id: 'A', name: 'A - 1' } };
    if (/\/items\/A\/children/.test(u)) return { data: { value: [{ id: 'S', name: 'Questionnaire', folder: {} }] } };
    if (/\/items\/S\/children/.test(u)) return { data: { value: [{ id: 'f', name: 'q.json', file: {} }, { id: 'n', name: 'old versions', folder: {} }] } };
    throw new Error('unexpected ' + u);
  } });
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'tok', invalidateAccessToken: () => {} });
  delete require.cache[p];
  const t = await require(p).listRootFolderTree('A - 1');
  assert.deepEqual(t.folders[0].files.map((f) => f.name), ['q.json']);
  assert.deepEqual(t.folders[0].nested, [{ id: 'n', name: 'old versions' }]);
});

test('a file (or sub-folder) stored under a name the plan did not predict means something appeared in the real folder during the run: reported as a PROBLEM, never "done"', quiet(async () => {
  const { s } = harness({ storedAs: (p) => (p.itemId === 'p-q' ? 'Questionnaire 1' : null) });
  const r = await s.mergeCaseFolders(REAL);
  assert.match(r.outcome, /done WITH PROBLEMS.*sub-folder "Questionnaire" was stored as "Questionnaire 1"/);
  assert.deepEqual(r.unexpectedNames.length, 1);
}));

test('a sub-folder that holds a kept file, or exists in the real folder, or has a nested folder, is NOT moved whole — its other files go one by one', async () => {
  const { planMerge } = svc();
  const t = trees();
  t.from.folders[1].nested = [{ id: 'n', name: 'x' }];     // Financial: nested → not whole
  const plan = planMerge({ from: t.from, to: t.to, keep: KEEP, now: NOW });
  assert.deepEqual(plan.folderMoves.map((d) => d.name), ['Questionnaire', 'Other']);
  assert.ok(plan.moves.filter((m) => m.subfolder === 'Financial').every((m) => !m.viaFolder && m.destSubfolderMissing));
  assert.ok(plan.moves.filter((m) => m.subfolder === 'Retainer').every((m) => !m.viaFolder && !m.destSubfolderMissing), 'Retainer exists in the real folder');
  assert.ok(!plan.folderMoves.some((d) => d.name === 'Consultation' || d.name === 'Intake'), 'kept files pin their folder');
});

test('the renamed folder cannot be found afterwards: reported, never a clean "done"', quiet(async () => {
  const { s } = harness({ afterTree: () => null });
  const r = await s.mergeCaseFolders(REAL);
  assert.match(r.leftBehind[0], /could not find "ZZ-TEST Praj \(was 2026-VV-008\)" to re-list/);
  assert.match(r.outcome, /done WITH PROBLEMS/);
}));

test('while a case is on hold, every folder resolution in the app answers a transient "try again" instead of a wrong folder; released, it works again', async () => {
  const p = require.resolve('../src/services/oneDriveService');
  const set = (rel, exports) => { const q = require.resolve(rel); require.cache[q] = { id: q, filename: q, loaded: true, exports }; };
  set('axios', { get: async () => ({ data: { value: [{ id: 'A', name: 'Ameena Begum - 2026-VV-008', folder: { childCount: 3 } }] } }), post: async () => { throw new Error('no'); } });
  set('../src/services/microsoftMailService', { getAccessToken: async () => 'tok', invalidateAccessToken: () => {} });
  delete require.cache[p];
  const od = require(p);
  od._clearCaseFolderCache();
  od.holdCaseFolder('2026-VV-008');
  for (const fn of [
    () => od.resolveCaseFolderName({ clientName: 'Ameena Begum', caseRef: '2026-VV-008' }),
    () => od.findCaseFolderByRef('2026-VV-008'),
    () => od.findCaseFoldersByRef('2026-VV-008'),
    () => od.listFiles({ clientName: 'Ameena Begum', caseRef: '2026-VV-008', subfolder: 'Identity' }),
  ]) {
    await assert.rejects(fn, (e) => e.transient === true && e.held === true && /try again in a minute/.test(e.message));
  }
  assert.equal((await od.findCaseFoldersByRef('2026-VV-009')).length, 0, 'other cases are not held');
  od.releaseCaseFolder('2026-VV-008');
  assert.equal(await od.resolveCaseFolderName({ clientName: 'Ameena Begum', caseRef: '2026-VV-008' }), 'Ameena Begum - 2026-VV-008');
});
