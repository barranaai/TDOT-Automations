'use strict';

// A family member added to a case lands in all three places (2026-10-07, after
// 2026-CEC-EE-070 arrived without a lead): the questionnaire manifest (first),
// the Family Members board row, and the document checklist (re-seeded without
// pruning, only once the case is in Document Collection or later). Staff add
// from the case page; the questionnaire's add-member route takes the same
// path. The Summary tab flags a PAID case whose Sub Type says "accompanying"
// but whose board has no spouse or child. Rules proved by the review rounds:
// never delete a row from this path; manifest before board row; adopt a
// manifest-only member instead of refusing; one add at a time per case;
// "Non Accompanying" (the board's spelling, with a space) is not accompanying.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const fam = require('../src/services/familyMemberService');

/* ───────────────────────── the pure pieces ───────────────────────── */

test('type maps agree with the composition adapter and the questionnaire', () => {
  const { _maps } = require('../src/services/compositionAdapter');
  for (const [boardLabel, role] of Object.entries(_maps.MEMBER_TYPE_TO_ROLE)) {
    if (boardLabel === 'Principal Applicant') continue;
    assert.equal(fam.ROLE_TO_BOARD[role], boardLabel, `${role} → ${boardLabel}`);
    assert.ok(fam.BOARD_TO_PORTAL[boardLabel], `${boardLabel} has a portal type`);
  }
  const { MEMBER_TYPE } = require('../config/questionnaireFormMap');
  for (const portal of Object.values(MEMBER_TYPE)) assert.ok(fam.PORTAL_TO_BOARD[portal], `${portal} maps to a board label`);
  assert.equal(fam.PORTAL_TO_BOARD['Spouse / Common-Law Partner'], 'Spouse');
});

test('nextMemberKey: the manifest\'s convention, chosen across board AND manifest; a singleton already present → null', () => {
  assert.equal(fam.nextMemberKey('Spouse'), 'spouse');
  assert.equal(fam.nextMemberKey('Dependent Child'), 'child-1');
  assert.equal(fam.nextMemberKey('Dependent Child', { boardRows: [{ boardType: 'Dependent Child', memberKey: 'child-1' }] }), 'child-2');
  assert.equal(fam.nextMemberKey('Dependent Child', { manifestMembers: [{ key: 'child-1' }, { key: 'child-2' }] }), 'child-3', 'keys the client already used on the manifest are skipped');
  assert.equal(fam.nextMemberKey('Dependent Child', { boardRows: [{ boardType: 'Dependent Child', memberKey: 'child-1' }], manifestMembers: [{ key: 'child-2' }] }), 'child-3');
  assert.equal(fam.nextMemberKey('Spouse', { boardRows: [{ boardType: 'Spouse', memberKey: 'spouse' }] }), null);
  assert.equal(fam.nextMemberKey('Spouse', { manifestMembers: [{ key: 'spouse' }] }), null);
  assert.equal(fam.nextMemberKey('Spouse', { boardRows: [{ boardType: 'Spouse', memberKey: '' }] }), null, 'a spouse row without a key still counts');
  assert.equal(fam.nextMemberKey('Parent', { boardRows: [{ boardType: 'Parent', memberKey: 'parent-1' }] }), 'parent-2');
  assert.equal(fam.nextMemberKey('Nope'), null);
});

test('adoptableMember: a manifest member of that type with no board row — the client\'s own add, or a half-finished one', () => {
  const manifest = [{ key: 'primary', type: 'Principal Applicant' }, { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Spouse' }, { key: 'child-1', type: 'Dependent Child', label: 'Aarav' }];
  assert.equal(fam.adoptableMember('Spouse', { boardRows: [], manifestMembers: manifest }).key, 'spouse');
  assert.equal(fam.adoptableMember('Spouse', { boardRows: [{ boardType: 'Spouse', memberKey: 'spouse' }], manifestMembers: manifest }), null, 'already matched by a row');
  assert.equal(fam.adoptableMember('Dependent Child', { boardRows: [], manifestMembers: manifest }).key, 'child-1');
  assert.equal(fam.adoptableMember('Parent', { boardRows: [], manifestMembers: manifest }), null);
  assert.equal(fam.adoptableMember('Spouse', { boardRows: [], manifestMembers: [] }), null);
  // a board row WITHOUT a key of that type is one of the manifest's members — it is not adopted twice
  assert.equal(fam.adoptableMember('Dependent Child', { boardRows: [{ boardType: 'Dependent Child', memberKey: '', name: 'Aarav' }], manifestMembers: [{ key: 'child-1', type: 'Dependent Child', label: 'Aarav' }] }), null, 'the unkeyed child row IS child-1');
  assert.equal(fam.adoptableMember('Dependent Child', { boardRows: [{ boardType: 'Dependent Child', memberKey: '', name: 'Aarav' }], manifestMembers: [{ key: 'child-1', type: 'Dependent Child' }, { key: 'child-2', type: 'Dependent Child' }] }).key, 'child-2');
});

test('placeholder names say who added the member; cleanName strips invisibles, bidi overrides and control characters', () => {
  assert.equal(fam.placeholderName('Spouse', 'spouse', 'staff'), 'Spouse (added by staff)');
  assert.equal(fam.placeholderName('Dependent Child', 'child-2', 'client'), 'Child 2 (added by client)');
  assert.equal(fam.cleanName('  Priya​  Singla \n'), 'Priya Singla');
  assert.equal(fam.cleanName('A‮b\u0007c⁦d'), 'Abcd');
  assert.equal(fam.cleanName('x'.repeat(200)).length, fam.NAME_MAX);
  assert.equal(fam.cleanName(null), '');
});

/* ───────────────────────── the service, over a stubbed world ───────────────────────── */

const ADAPTER = { 'Spouse': 'Spouse', 'Dependent Child': 'DependentChild', 'Parent': 'Parent' };
function harness({ boardRows = [], manifest = [{ key: 'primary', type: 'Principal Applicant' }], manifestFails = false, reseed = { created: 11, skipped: 11, failed: 0, pruned: 0 }, reseedFails = false, rowFails = false, manifestAddFails = false, caseState = { stage: 'Document Collection Started', payment: 'Paid', checklistApplied: 'Yes' }, stateFails = false, boardLags = false, now = 1_000_000 } = {}) {
  const calls = { seq: [], rows: [], manifestAdds: [], manifestCreates: [], reseeds: [], notes: [], stateReads: 0 };
  const rows = boardRows.slice();
  const real = { ...fam.io };
  fam._recentRows.clear();
  Object.assign(fam.io, {
    // boardLags: the search never shows rows written in this test (Monday's lag)
    boardRows: async () => { const seen = boardLags ? boardRows : rows; return { rows: seen.slice(), members: seen.map((r) => ({ role: ADAPTER[r.boardType] || r.boardType, name: r.name || '', memberKey: r.memberKey || '', flags: {} })) }; },
    manifest: async () => { if (manifestFails) throw new Error('OneDrive down'); return manifest; },
    addManifestMember: async (a) => { calls.seq.push('manifest'); if (manifestAddFails) throw new Error('upload failed'); calls.manifestAdds.push(a); return { key: a.key, type: a.memberType }; },
    createManifest: async (a) => { calls.seq.push('manifest-create'); calls.manifestCreates.push(a); return []; },
    createRow: async (a) => { calls.seq.push('row'); if (rowFails) throw new Error('Monday 503'); calls.rows.push(a); rows.push({ boardType: a.row.memberType, memberKey: a.row.memberKey, name: a.row.name }); return 'row-' + calls.rows.length; },
    caseState: async () => { calls.stateReads++; if (stateFails) throw new Error('Monday 503'); return caseState; },
    reseed: async (ref, composition) => { calls.seq.push('reseed'); calls.reseeds.push({ ref, composition }); if (reseedFails) throw new Error('No code schema registered'); return reseed; },
    postNote: async (itemId, body) => { calls.notes.push({ itemId, body }); },
    now: () => now,
  });
  return { calls, rows, restore: () => { Object.assign(fam.io, real); fam._recentRows.clear(); } };
}
const BASE = { caseRef: '2026-CEC-EE-070', cmItemId: '12961158283', clientName: 'Shaveenu Singla' };
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

test('staff adds a spouse: questionnaire section FIRST, then the board row (same key), then the re-seed; one note on the case', async () => {
  const h = harness();
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'Gauri Berde' } });
    assert.deepEqual(h.calls.seq, ['manifest', 'row', 'reseed'], 'manifest before the row — a manifest failure leaves nothing behind');
    assert.deepEqual(h.calls.manifestAdds, [{ clientName: BASE.clientName, caseRef: BASE.caseRef, memberType: 'Spouse / Common-Law Partner', label: undefined, key: 'spouse' }]);
    assert.deepEqual(h.calls.rows, [{ caseRef: BASE.caseRef, cmItemId: BASE.cmItemId, row: { name: 'Spouse (added by staff)', memberType: 'Spouse', memberKey: 'spouse' } }]);
    assert.equal(h.calls.reseeds.length, 1); assert.equal(h.calls.reseeds[0].ref, BASE.caseRef);
    // the re-seed is FED the composition this call holds — the new member in it, flags derived — never a fresh board search
    assert.deepEqual(h.calls.reseeds[0].composition.members.map((m) => `${m.role}:${m.memberKey}`), ['Spouse:spouse']);
    assert.equal(h.calls.reseeds[0].composition.caseFlags.spouseIncluded, true);
    assert.equal(r.manifest, 'added'); assert.deepEqual(r.reseed, { created: 11, skipped: 11, failed: 0, pruned: 0 }); assert.equal(r.key, 'spouse'); assert.equal(r.rowId, 'row-1');
    assert.equal(h.calls.stateReads, 1, 'the case state (Checklist Template Applied) is read live, once');
    assert.equal(h.calls.notes.length, 1); assert.equal(h.calls.notes[0].itemId, BASE.cmItemId);
    assert.match(h.calls.notes[0].body, /👪 <b>Family member added<\/b> — Spouse "Spouse \(added by staff\)" — by Gauri Berde \(staff\), .*\(Toronto\)\. Family Members row created; questionnaire section added on the client's existing link; checklist re-seeded \(rows only added, never removed\): 11 new document row\(s\), 11 existing left as they were\./);
  } finally { h.restore(); }
});

test('staff adds a named child next to an existing child: key child-2, the name on both the row and the manifest label', async () => {
  const h = harness({ boardRows: [{ boardType: 'Dependent Child', memberKey: 'child-1', name: 'Aarav' }], manifest: [{ key: 'primary' }, { key: 'child-1', type: 'Dependent Child' }] });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', name: ' Diya  Singla ', source: 'staff', actor: { name: 'G' } });
    assert.equal(r.key, 'child-2');
    assert.equal(h.calls.rows[0].row.name, 'Diya Singla');
    assert.equal(h.calls.manifestAdds[0].label, 'Diya Singla'); assert.equal(h.calls.manifestAdds[0].key, 'child-2');
  } finally { h.restore(); }
});

test('no manifest yet: it is CREATED from the board rows just read plus the new member (never left to a lagging board search)', async () => {
  const h = harness({ manifest: null, boardRows: [{ boardType: 'Dependent Child', memberKey: 'child-1', name: 'Aarav' }] });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
    assert.equal(r.manifest, 'created'); assert.equal(h.calls.manifestAdds.length, 0);
    assert.equal(h.calls.manifestCreates.length, 1);
    assert.deepEqual(h.calls.manifestCreates[0].boardMembers.map((m) => `${m.role}:${m.memberKey}`), ['DependentChild:child-1', 'Spouse:spouse']);
    assert.deepEqual(h.calls.seq, ['manifest-create', 'row', 'reseed']);
    assert.match(h.calls.notes[0].body, /questionnaire member list created with this member/);
  } finally { h.restore(); }
});

test('a spouse already on the BOARD is refused before any write; a spouse only on the MANIFEST (the client added it) is ADOPTED — row created with its key, no manifest write', async () => {
  const h1 = harness({ boardRows: [{ boardType: 'Spouse', memberKey: 'spouse' }] });
  try {
    await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }), (e) => e.badRequest === true && /spouse is already on this case/.test(e.message));
    assert.deepEqual(h1.calls.seq, []);
  } finally { h1.restore(); }
  const h2 = harness({ manifest: [{ key: 'primary' }, { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Spouse' }] });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
    assert.equal(r.manifest, 'adopted'); assert.equal(r.key, 'spouse');
    assert.deepEqual(h2.calls.seq, ['row', 'reseed']);
    assert.equal(h2.calls.rows[0].row.memberKey, 'spouse');
    assert.match(h2.calls.notes[0].body, /the questionnaire section the client already had is now matched by a row/);
  } finally { h2.restore(); }
  // an adopted member keeps a real name from the manifest, not a placeholder one
  const h3 = harness({ manifest: [{ key: 'primary' }, { key: 'child-1', type: 'Dependent Child', label: 'Aarav Singla' }] });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', source: 'staff' });
    assert.equal(r.rowName, 'Aarav Singla');
  } finally { h3.restore(); }
});

test('the client path takes the same route: manifest add, row, re-seed in the background; the response is a snapshot', async () => {
  const h = harness();
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', source: 'client', reseedMode: 'background' });
    assert.deepEqual(r.reseed, { pending: true }); assert.equal(r.manifest, 'added'); assert.equal(r.key, 'child-1');
    assert.deepEqual(h.calls.rows[0].row, { name: 'Child 1 (added by client)', memberType: 'Dependent Child', memberKey: 'child-1' });
    await settle();
    assert.equal(h.calls.reseeds.length, 1); assert.equal(h.calls.reseeds[0].ref, BASE.caseRef);
    assert.match(h.calls.notes[0].body, /by the client, on the questionnaire, .*questionnaire section added on the client's existing link; checklist re-seeded/);
  } finally { h.restore(); }
});

test('no checklist yet (Checklist Template Applied ≠ Yes, whatever the stage): row + section only, the note says the rows come with the checklist at Document Collection', async () => {
  for (const [stage, applied] of [['Not Started', ''], ['Retainer Confirmed', 'No'], ['Stuck', ''], ['Document Collection Started', '']]) {
    const h = harness({ caseState: { stage, payment: 'Paid', checklistApplied: applied } });
    try {
      const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
      assert.deepEqual(r.reseed, { deferred: true }, `${stage}/${applied}`); assert.equal(r.stage, stage);
      assert.deepEqual(h.calls.reseeds, [], `${stage}: no re-seed — this path never seeds a whole checklist`);
      assert.match(h.calls.notes[0].body, /no document rows yet — the checklist has not been created \(the case is at ".*"\); they come with the checklist at Document Collection/);
    } finally { h.restore(); }
  }
  // a checklist that exists is re-seeded whatever the stage says (a case moved back, "Stuck" …)
  const h = harness({ caseState: { stage: 'Retainer Confirmed', payment: 'Paid', checklistApplied: 'Yes' } });
  try { await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.equal(h.calls.reseeds.length, 1); } finally { h.restore(); }
});

test('the case state cannot be read: row + section are kept, nothing is seeded, the note and result say to press Re-seed Checklist — never a false "rows come later"', async () => {
  const h = harness({ stateFails: true });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
    assert.deepEqual(r.reseed, { unknown: true }); assert.equal(h.calls.reseeds.length, 0); assert.equal(h.calls.rows.length, 1);
    assert.match(h.calls.notes[0].body, /the checklist state could not be read — press Re-seed Checklist on the case if its checklist exists/);
    assert.doesNotMatch(h.calls.notes[0].body, /come with the checklist at Document Collection/);
  } finally { h.restore(); }
});

test('a single-applicant sub type adds 0 rows: the note and result say so, with the fix (change the sub type, then re-seed)', async () => {
  const h = harness({ reseed: { created: 0, skipped: 11, failed: 0, pruned: 0 } });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' }, caseSubType: 'CEC Single Applicant' });
    assert.match(r.hint, /The Case Sub Type "CEC Single Applicant" has no documents for a spouse — change it to the accompanying variant and press Re-seed Checklist/);
    assert.match(h.calls.notes[0].body, /has no documents for a spouse/);
  } finally { h.restore(); }
  const ok = harness({ reseed: { created: 0, skipped: 22, failed: 0, pruned: 0 } });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', caseSubType: 'CEC Accompanying Spouse & Child' });
    assert.equal(r.hint, '', 'an accompanying sub type with nothing new to add is not a sub-type problem');
  } finally { ok.restore(); }
});

test('rows this process wrote count as on the board even while Monday\'s search lags: a second "add spouse" seconds later is refused, not duplicated', async () => {
  const h = harness({ boardLags: true, now: 5_000_000 });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' });
    assert.equal(r.key, 'spouse');
    await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }), /spouse is already on this case/);
    assert.equal(h.calls.rows.length, 1);
    // a second child gets the next key, and the re-seed composition carries both
    const c2 = await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', source: 'staff' });
    const c3 = await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', source: 'staff' });
    assert.deepEqual([c2.key, c3.key], ['child-1', 'child-2']);
    assert.deepEqual(h.calls.reseeds[2].composition.members.map((m) => m.memberKey), ['spouse', 'child-1', 'child-2']);
    // the memory expires
    fam.io.now = () => 5_000_000 + fam.RECENT_ROWS_MS + 1;
    const again = await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', source: 'staff' });
    assert.equal(again.key, 'child-1', 'after the window the (still lagging) board is believed again');
  } finally { h.restore(); }
});

test('a failed re-seed, or rows that failed, never lose the row or the section: the note says to press Re-seed Checklist', async () => {
  const h = harness({ reseedFails: true });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
    assert.deepEqual(r.reseed, { error: 'No code schema registered' }); assert.equal(r.ok, true);
    assert.match(h.calls.notes[0].body, /checklist re-seed FAILED \(No code schema registered\) — press Re-seed Checklist on the case/);
  } finally { h.restore(); }
  const h2 = harness({ reseed: { created: 3, skipped: 11, failed: 2, pruned: 0 } });
  try {
    await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
    assert.match(h2.calls.notes[0].body, /3 new document row\(s\), 11 existing left as they were, 2 failed — press Re-seed Checklist/);
  } finally { h2.restore(); }
});

test('the board row fails AFTER the section was added: a "half-added" note, and the error carries the member so the client route can still answer ok', async () => {
  const h = harness({ rowFails: true });
  try {
    await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'client', reseedMode: 'background' }), (e) => e.transient === true && e.manifestAdded === true && e.member.key === 'spouse' && /Press Add family member again/.test(e.message));
    assert.equal(h.calls.manifestAdds.length, 1); assert.equal(h.calls.reseeds.length, 0);
    assert.match(h.calls.notes[0].body, /⚠ <b>Family member half-added<\/b> — Spouse .* the Family Members row could not be created \(Monday 503\)\. Press ➕ Add family member on the case page again/);
  } finally { h.restore(); }
});

test('a manifest add that fails writes nothing else; an unreadable manifest (outage) stops the add before any write', async () => {
  const h = harness({ manifestAddFails: true });
  try {
    await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }), (e) => e.transient === true);
    assert.deepEqual(h.calls.rows, []); assert.deepEqual(h.calls.reseeds, []);
  } finally { h.restore(); }
  const h2 = harness({ manifestFails: true });
  try {
    await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }), (e) => e.transient === true && /could not be read just now/.test(e.message));
    assert.deepEqual(h2.calls.seq, []);
  } finally { h2.restore(); }
});

test('adds on one case run strictly one after another: two "add spouse" clicks make ONE row (the second refused); three "add child" clicks make child-1, child-2, child-3', async () => {
  const h = harness();
  try {
    const [a, b] = await Promise.allSettled([
      fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'A' } }),
      fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'client', reseedMode: 'background' }),
    ]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected'); assert.match(b.reason.message, /spouse is already on this case/);
    assert.equal(h.calls.rows.length, 1);
    const rs = await Promise.allSettled([1, 2, 3].map(() => fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', source: 'staff' })));
    assert.deepEqual(rs.map((x) => x.status), ['fulfilled', 'fulfilled', 'fulfilled']);
    assert.deepEqual(h.calls.rows.slice(1).map((r) => r.row.memberKey), ['child-1', 'child-2', 'child-3'], 'no duplicate key even for three at once');
    assert.equal(fam._inFlight.size, 0, 'the queue drains');
    // a failing add never wedges the queue for the next one
    fam.io.manifest = async () => { throw new Error('down'); };
    await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Parent', source: 'staff' }));
    fam.io.manifest = async () => [{ key: 'primary' }];
    const after = await fam.addFamilyMember({ ...BASE, boardType: 'Parent', source: 'staff' });
    assert.equal(after.key, 'parent-1');
  } finally { h.restore(); }
});

test('unknown type / missing ids are refused', async () => {
  await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Cousin' }), (e) => e.badRequest === true);
  await assert.rejects(fam.addFamilyMember({ caseRef: '', cmItemId: '', clientName: 'x', boardType: 'Spouse' }), (e) => e.badRequest === true);
});

/* ───────────────────────── the re-seed never prunes from this path ───────────────────────── */

test('re-seed from this path can only ADD rows and is fed the composition: prune:false + composition threaded reseedByCaseRef → seedFromSchema → reconcileExecutionRows', () => {
  const svc = fs.readFileSync(require.resolve('../src/services/familyMemberService.js'), 'utf8');
  assert.match(svc, /reseedByCaseRef\(caseRef, \{ prune: false, composition \}\)/);
  const cl = fs.readFileSync(require.resolve('../src/services/checklistService.js'), 'utf8');
  assert.match(cl, /async function reseedByCaseRef\(caseRef, \{ prune = true, composition: compositionIn = null \} = \{\}\)/);
  assert.match(cl, /const composition = compositionIn \|\| await compositionAdapter\.readForCase\(ref\);/);
  assert.match(cl, /seedFromSchema\(\{ schema, caseRef: ref, clientName: item\.name, clientMasterItemId: item\.id, prune, composition \}\)/);
  assert.match(cl, /const composition = compositionIn \|\| await compositionAdapter\.readForCase\(caseRef\);/, 'seedFromSchema plans from the composition it is given');
  assert.match(cl, /reconcileExecutionRows\(\{\s*prune,/);
  assert.match(cl, /pruned: result\.pruned \|\| 0,/);
  const ex = fs.readFileSync(require.resolve('../src/services/executionSeederService.js'), 'utf8');
  assert.match(ex, /categoryLinks = \{\}, prune = true \}\)/);
  assert.match(ex, /const pruned = prune \? await pruneStaleSubTypeRows\(\{ caseRef, keepSubType: caseSubType \}\) : 0;/);
});

test('reconcileExecutionRows with prune:false never deletes a stale-sub-type row; with prune:true (the manual Re-seed button) it does', async () => {
  const seeder = require('../src/services/executionSeederService');
  const mondayApi = require('../src/services/mondayApi');
  const real = mondayApi.query;
  const stale = { id: '555', column_values: [{ id: 'text_mm17zdy7', text: 'Old Sub Type', value: null }, { id: 'text_mm15dwah', text: '2026-X-001-OLD-DOC-001', value: null }, { id: 'board_relation_mm0zhagw', text: '', value: null }, { id: 'color_mm0zwgvr', text: '', value: null }] };
  const deletes = [];
  mondayApi.query = async (q, v) => {
    if (/delete_item/.test(q)) { deletes.push(String(v.id)); return { delete_item: { id: v.id } }; }
    if (/items_page_by_column_values/.test(q)) return { items_page_by_column_values: { items: [stale] } };
    throw new Error('unexpected ' + q.slice(0, 60));
  };
  try {
    const off = await seeder.reconcileExecutionRows({ caseRef: '2026-X-001', caseSubType: 'New Sub Type', clientMasterItemId: '1', plan: [], prune: false });
    assert.deepEqual(deletes, [], 'prune:false: the other sub type\'s row stays');
    assert.equal(off.pruned, 0);
    const on = await seeder.reconcileExecutionRows({ caseRef: '2026-X-001', caseSubType: 'New Sub Type', clientMasterItemId: '1', plan: [] });
    assert.deepEqual(deletes, ['555'], 'the default (the manual button) prunes it');
    assert.equal(on.pruned, 1);
  } finally { mondayApi.query = real; }
});

test('compositionAdapter.withMember: the member is spliced in once and the case flags follow', () => {
  const { withMember, deriveCaseFlags } = require('../src/services/compositionAdapter');
  const c = withMember({ members: [{ role: 'DependentChild', name: 'Aarav', memberKey: 'child-1', flags: {} }] }, { role: 'Spouse', name: 'Priya', memberKey: 'spouse' });
  assert.deepEqual(c.members.map((m) => m.memberKey), ['child-1', 'spouse']);
  assert.deepEqual(c.caseFlags, { spouseIncluded: true, childrenIncluded: true, parentsIncluded: false, siblingsIncluded: false, supporterIncluded: false });
  assert.equal(withMember(c, { role: 'Spouse', memberKey: 'spouse' }).members.length, 2, 'never twice');
  assert.deepEqual(deriveCaseFlags([]), { spouseIncluded: false, childrenIncluded: false, parentsIncluded: false, siblingsIncluded: false, supporterIncluded: false });
});

/* ───────────────────────── the manifest side ───────────────────────── */

function qStubs({ manifest }) {
  const oneDrive = require('../src/services/oneDriveService');
  const compositionAdapter = require('../src/services/compositionAdapter');
  const real = { readFile: oneDrive.readFile, ensureClientFolder: oneDrive.ensureClientFolder, uploadFile: oneDrive.uploadFile, readForCase: compositionAdapter.readForCase };
  const uploads = [];
  oneDrive.readFile = async () => (manifest ? Buffer.from(JSON.stringify({ members: manifest })) : null);
  oneDrive.ensureClientFolder = async () => {};
  oneDrive.uploadFile = async ({ buffer }) => { uploads.push(JSON.parse(buffer.toString('utf8'))); };
  compositionAdapter.readForCase = async () => ({ caseFlags: {}, members: [] });
  return { uploads, restore: () => { Object.assign(oneDrive, { readFile: real.readFile, ensureClientFolder: real.ensureClientFolder, uploadFile: real.uploadFile }); compositionAdapter.readForCase = real.readForCase; } };
}

test('questionnaire addMember: an explicit key is used when well-formed and free; a bad or taken key is refused', async () => {
  const svc = require('../src/services/htmlQuestionnaireService');
  const q = qStubs({ manifest: [{ key: 'primary', type: 'Principal Applicant', label: 'Principal Applicant' }, { key: 'child-1', type: 'Dependent Child', label: 'Child 1' }] });
  try {
    const m = await svc.addMember({ clientName: 'K', caseRef: '2026-TEST-900', memberType: 'Dependent Child', label: 'Diya', key: 'child-2' });
    assert.equal(m.key, 'child-2'); assert.equal(m.label, 'Diya');
    assert.deepEqual(q.uploads[0].members.map((x) => x.key), ['primary', 'child-1', 'child-2']);
    await assert.rejects(svc.addMember({ clientName: 'K', caseRef: '2026-TEST-900', memberType: 'Dependent Child', key: 'child-1' }), /already used/);
    await assert.rejects(svc.addMember({ clientName: 'K', caseRef: '2026-TEST-900', memberType: 'Dependent Child', key: 'Primary' }), /Invalid member key/);
    await assert.rejects(svc.addMember({ clientName: 'K', caseRef: '2026-TEST-900', memberType: 'Dependent Child', key: 'primary' }), /Invalid member key/);
    const auto = await svc.addMember({ clientName: 'K', caseRef: '2026-TEST-900', memberType: 'Dependent Child' });
    assert.equal(auto.key, 'child-2', 'without a key the old convention still applies');
  } finally { q.restore(); }
});

test('questionnaire createManifestFromBoard: writes the list from the rows given (placeholders become clean labels); never overwrites an existing manifest', async () => {
  const svc = require('../src/services/htmlQuestionnaireService');
  const q = qStubs({ manifest: null });
  try {
    const members = await svc.createManifestFromBoard({ clientName: 'K', caseRef: '2026-TEST-902', boardMembers: [
      { role: 'Spouse', name: 'Spouse (added by staff)', memberKey: 'spouse', flags: {} },
      { role: 'DependentChild', name: 'Child 1 (from intake)', memberKey: 'child-1', flags: {} },
      { role: 'DependentChild', name: 'Child 2 (added by client)', memberKey: 'child-2', flags: {} },
      { role: 'DependentChild', name: 'Diya Singla', memberKey: 'child-3', flags: {} } ] });
    assert.deepEqual(members.map((m) => m.label), ['Primary Applicant', 'Spouse', 'Child', 'Child 2', 'Diya Singla']);
    assert.deepEqual(members.map((m) => m.key), ['primary', 'spouse', 'child-1', 'child-2', 'child-3']);
    assert.equal(q.uploads.length, 1);
  } finally { q.restore(); }
  const q2 = qStubs({ manifest: [{ key: 'primary', type: 'Principal Applicant', label: 'Principal Applicant' }, { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Priya' }] });
  try {
    const members = await svc.createManifestFromBoard({ clientName: 'K', caseRef: '2026-TEST-903', boardMembers: [] });
    assert.deepEqual(members.map((m) => m.key), ['primary', 'spouse'], 'the existing manifest is returned as is');
    assert.equal(q2.uploads.length, 0);
  } finally { q2.restore(); }
});

/* ───────────────────────── the lead bridge stays additive ───────────────────────── */

test('createFromLead: a row staff already added is skipped and the OTHER planned rows are still created (never all-or-nothing)', async () => {
  const comp = require('../src/services/familyCompositionService');
  const mondayApi = require('../src/services/mondayApi');
  const compositionAdapter = require('../src/services/compositionAdapter');
  const realQ = mondayApi.query, realR = compositionAdapter.readForCase;
  const created = [];
  mondayApi.query = async (q, v) => {
    if (/create_item/.test(q)) { created.push({ name: v.n, cols: JSON.parse(v.c) }); return { create_item: { id: String(900 + created.length) } }; }
    if (/create_update/.test(q)) return { create_update: { id: 'u' } };
    throw new Error('unexpected ' + q.slice(0, 40));
  };
  compositionAdapter.readForCase = async () => ({ caseFlags: {}, members: [{ role: 'Spouse', name: 'Spouse (added by staff)', memberKey: 'spouse', flags: {} }] });
  try {
    const n = await comp.createFromLead({ lead: { hasSpouse: 'Yes', childrenCount: '2' }, caseRef: '2026-TEST-904', cmItemId: '77001' });
    assert.equal(n, 2);
    assert.deepEqual(created.map((c) => c.name), ['Child 1 (from intake)', 'Child 2 (from intake)'], 'the spouse row is not duplicated');
    const again = await comp.createFromLead({ lead: { hasSpouse: 'Yes', childrenCount: '2' }, caseRef: '2026-TEST-904', cmItemId: '77001' });
    assert.equal(again, 0, 'the ten-minute memory stops a re-run');
  } finally { mondayApi.query = realQ; compositionAdapter.readForCase = realR; }
});

/* ───────────────────────── the routes and the page ───────────────────────── */

function handlerFor(router, path, method) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function fakeRes() { const res = { statusCode: 200, body: null }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; return res; }

test('client route POST /q/:caseRef/add-member: one service call; ok with the member; "half-added" still ok; a refusal is 409; an outage is 503', async () => {
  const router = require('../src/routes/htmlQuestionnaireForm');
  const svc = require('../src/services/htmlQuestionnaireService');
  const handler = handlerFor(router, '/:caseRef/add-member', 'post');
  const realV = svc.validateAccess, realAdd = fam.addFamilyMember;
  svc.validateAccess = async () => ({ itemId: '12961158283', clientName: 'Shaveenu Singla', caseType: 'Canadian Experience Class (EE after ITA)', caseSubType: 'CEC Accompanying Spouse & Child', formFiles: {} });
  const calls = [];
  try {
    fam.addFamilyMember = async (a) => { calls.push(a); return { ok: true, key: 'child-1', portalType: 'Dependent Child', rowName: 'Child 1 (added by client)', reseed: { pending: true } }; };
    let res = fakeRes(); await handler({ params: { caseRef: '2026-CEC-EE-070' }, body: { token: 't', memberType: 'Dependent Child' } }, res);
    assert.equal(res.statusCode, 200); assert.deepEqual(res.body, { ok: true, member: { key: 'child-1', type: 'Dependent Child', label: 'Child 1 (added by client)' } });
    assert.deepEqual(calls[0], { caseRef: '2026-CEC-EE-070', cmItemId: '12961158283', clientName: 'Shaveenu Singla', boardType: 'Dependent Child', source: 'client', reseedMode: 'background', caseSubType: 'CEC Accompanying Spouse & Child' });
    fam.addFamilyMember = async () => { const e = new Error('row failed'); e.transient = true; e.manifestAdded = true; e.member = { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Spouse (added by client)' }; throw e; };
    res = fakeRes(); await handler({ params: { caseRef: '2026-CEC-EE-070' }, body: { token: 't', memberType: 'Spouse / Common-Law Partner' } }, res);
    assert.equal(res.statusCode, 200); assert.equal(res.body.ok, true); assert.equal(res.body.member.key, 'spouse');
    fam.addFamilyMember = async () => { throw Object.assign(new Error('A spouse is already on this case.'), { badRequest: true }); };
    res = fakeRes(); await handler({ params: { caseRef: '2026-CEC-EE-070' }, body: { token: 't', memberType: 'Spouse / Common-Law Partner' } }, res);
    assert.equal(res.statusCode, 409);
    fam.addFamilyMember = async () => { throw Object.assign(new Error('could not be read'), { transient: true }); };
    res = fakeRes(); await handler({ params: { caseRef: '2026-CEC-EE-070' }, body: { token: 't', memberType: 'Spouse / Common-Law Partner' } }, res);
    assert.equal(res.statusCode, 503); assert.equal(res.body.retriable, true);
    res = fakeRes(); await handler({ params: { caseRef: '2026-CEC-EE-070' }, body: { token: 't', memberType: 'Parent' } }, res);
    assert.equal(res.statusCode, 400, 'a type the case type does not allow');
  } finally { svc.validateAccess = realV; fam.addFamilyMember = realAdd; }
});

test('cockpit route: the case-write gate, the questionnaire\'s type list, who clicked, the canonical case ref and the case state it already holds', () => {
  const SRC = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const i = SRC.indexOf("app.post('/admin/case-action/:caseRef/family/add'");
  assert.ok(i !== -1);
  const body = SRC.slice(i, SRC.indexOf('\n});', i));
  assert.match(body, /const ctx = await resolveCaseForWrite\(req, res, caseRef\);/);
  assert.match(body, /resolveMemberTypes\(ctx\.overview\.caseType, ctx\.overview\.caseSubType\)/);
  assert.match(body, /if \(!allowed\.includes\(memberType\)\)/);
  assert.match(body, /actor: staffActor\(req\)/);
  assert.match(body, /caseRef: ctx\.overview\.caseRef \|\| caseRef/);
  assert.ok(!/caseState:/.test(body), 'the service reads the case state live — the overview\'s copy is a placeholder during a Client Master outage');
  assert.match(body, /caseSubType: ctx\.overview\.caseSubType \|\| ''/);
  assert.match(body, /err\.badRequest\) return res\.status\(400\)/);
  assert.match(body, /err\.transient\) return res\.status\(503\)/);
});

test('cockpit page: the form offers the questionnaire\'s types, the message element survives the re-render, the script parses and carries no escape sequences', () => {
  const src = fs.readFileSync(require.resolve('../src/services/caseCockpitService.js'), 'utf8');
  assert.match(src, /familyAddTypes: require\('\.\.\/\.\.\/config\/questionnaireFormMap'\)\.resolveMemberTypes\(caseType, caseSubType\)/);
  const { buildCockpitHTML } = require('../src/routes/adminCase');
  const html = buildCockpitHTML('2026-X-001');
  let n = 0;
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) { n++; assert.doesNotThrow(() => new Function(m[1])); }
  assert.ok(n >= 1);
  assert.match(html, /<div id="fam-add"><\/div>\s*<div class="act-msg" id="fam-msg"><\/div>/, 'the message lives outside the re-rendered form');
  assert.ok(!/id="fam-msg" style/.test(html), 'and not inside it');
  assert.match(html, /function famAdd\(\)/);
  assert.match(html, /\/family\/add/);
  assert.match(html, /rs\.deferred \? 'Document rows come with the checklist at Document Collection/);
  assert.match(html, /rs\.failed \? ' ' \+ rs\.failed \+ ' row\(s\) failed — press Re-seed Checklist\.' : ''/);
  assert.match(html, /rs\.unknown \? 'The checklist state could not be read/);
  assert.match(html, /res\.j\.hint \? ' ' \+ res\.j\.hint : ''/);
  assert.ok(!/\\u20/.test(html), 'no escape sequences in the template-literal script');
});

/* ───────────────────────── the Summary-tab rule ───────────────────────── */

const NA = require('../src/services/needsAttentionService');
const H = 3600 * 1000, D = 24 * H;
const NOW = Date.parse('2026-10-07T15:00:00Z');
let seq = 0;
function item({ id = String(2000 + (++seq)), name = 'Client', createdAgo = 30 * D, ref = '2026-CEC-EE-070', caseType = 'Canadian Experience Class (EE after ITA)', subType = 'CEC Accompanying Spouse & Child', stage = 'Internal Review', payment = 'Paid', paidDate = '2026-09-03', group = 'group_mm6sykds', groupTitle = 'September  2026' } = {}) {
  const cv = [['text_mm142s49', ref], ['dropdown_mm0xd1qn', caseType], ['dropdown_mm0x4t91', subType], ['color_mm0x8faa', stage], ['color_mm0x9fnn', payment], ['date_mm0xgk76', paidDate], ['multiple_person_mm0xhmgk', ''], ['multiple_person_mm2nhsx1', '']].map(([cid, text]) => ({ id: cid, text, value: null }));
  return { id, name, created_at: new Date(NOW - createdAgo).toISOString(), group: { id: group, title: groupTitle }, column_values: cv, updates: [] };
}
const run = (items, family) => NA.detect({ cases: items.map(NA.parseCase), family: new Map(Object.entries(family || {})), now: NOW }).filter((e) => e.kind === 'family-missing');

test('Summary: a PAID "accompanying" case with no spouse/child on the board is listed (since = the paid day); a spouse OR a child clears it', () => {
  NA.io.now = () => NOW;
  const none = run([item()], { '2026-CEC-EE-070': new Set() });
  assert.equal(none.length, 1);
  assert.match(none[0].why, /"CEC Accompanying Spouse & Child" — the family comes along — but the Family Members board has no spouse or child/);
  assert.match(none[0].todo, /Add family member/);
  assert.match(none[0].todo, /correct the Case Sub Type and then flip Re-seed Checklist → Run/);
  assert.ok(none[0].since.startsWith('2026-09-03'), 'since the paid day');
  assert.equal(run([item()], { '2026-CEC-EE-070': new Set(['Spouse']) }).length, 0);
  assert.equal(run([item()], { '2026-CEC-EE-070': new Set(['Principal Applicant', 'Dependent Child']) }).length, 0);
  assert.equal(run([item()], { '2026-CEC-EE-070': new Set(['Principal Applicant']) }).length, 1, 'a PA row alone is not family');
});

test('Summary: exactly the board\'s accompanying labels say accompanying — "Non Accompanying" (space) and "Non-Accompanying" do not', () => {
  const { SUB_TYPE_LABELS } = require('../config/caseTypes');
  const flagged = SUB_TYPE_LABELS.filter((label) => run([item({ subType: label })], { '2026-CEC-EE-070': new Set() }).length === 1).sort();
  assert.deepEqual(flagged, ['Accompanying Spouse or Child', 'CEC Accompanying Spouse & Child', 'Extension - Accompanying Spouse/Child', 'Non Express Entry - Accompanying Spouse & Child', 'Non SDS - Accompanying Spouse or Child']);
  for (const label of ['Non Express Entry - Non Accompanying Spouse', 'Non-Accompanying Spouse', 'Nonaccompanying spouse', 'CEC Single Applicant', '']) {
    assert.equal(run([item({ subType: label })], { '2026-CEC-EE-070': new Set() }).length, 0, label);
  }
});

test('Summary: never before the case is paid, within a day of the paid day, for finished / legacy / test cases, or when the board could not be read', () => {
  NA.io.now = () => NOW;
  const empty = { '2026-CEC-EE-070': new Set() };
  assert.equal(run([item({ payment: 'Signed (Unpaid)', paidDate: '' })], empty).length, 0, 'unpaid: the retainer panel and the lead bridge have until then');
  for (const stage of ['', 'Not Started', 'Pre-Onboarding', 'Retainer Confirmed']) assert.equal(run([item({ stage })], empty).length, 0, `${stage || '(blank)'}: no checklist exists yet to be wrong`);
  assert.equal(run([item({ stage: 'Document Collection Started' })], empty).length, 1);
  assert.equal(run([item({ payment: '', paidDate: '' })], empty).length, 0);
  assert.equal(run([item({ paidDate: '2026-10-07' })], empty).length, 0, 'paid today: the set-up window');
  assert.equal(run([item({ paidDate: '' , createdAgo: H })], empty).length, 0, 'paid with no date, created an hour ago');
  assert.equal(run([item({ paidDate: '', createdAgo: 3 * H })], empty).length, 1, 'paid with no date, past the set-up window');
  assert.equal(run([item({ stage: 'Application Submitted' })], empty).length, 0);
  assert.equal(run([item({ group: 'group_mm3t4kda', groupTitle: 'Retainers before May 2026' })], empty).length, 0);
  assert.equal(run([item({ group: 'group_mm3842s', groupTitle: 'TEST' })], empty).length, 0);
  assert.equal(run([item()], { '2026-CEC-EE-070': null }).length, 0, 'unread → no claim');
  assert.equal(run([item()], {}).length, 0);
  assert.equal(run([item({ ref: '' })], {}).length, 0);
});

test('Summary snapshot: only paid accompanying live cases are read from the Family Members board; a failed read is reported as partial', async () => {
  NA._resetForTests(); NA.io.now = () => NOW;
  const reads = [];
  const real = { ...NA.io };
  Object.assign(NA.io, {
    readCases: async () => [item({ id: '3001', ref: '2026-CEC-EE-070' }), item({ id: '3002', ref: '2026-CEC-EE-071', subType: 'CEC Single Applicant' }), item({ id: '3003', ref: '2026-X-002', subType: 'Non Express Entry - Accompanying Spouse & Child' }), item({ id: '3004', ref: '2026-X-003', payment: 'Signed (Unpaid)', paidDate: '' })],
    hasChecklist: async () => true, listRootFolders: async () => [], workFoldersPresent: async () => true,
    readDeepNotes: async () => ({ notes: new Map(), failed: [] }), newestChecklistRowAt: async () => 0, postNote: async () => {},
    familyTypes: async (ref) => { reads.push(ref); if (ref === '2026-X-002') throw new Error('503'); return new Set(); },
  });
  try {
    const snap = await NA.buildSnapshot();
    assert.deepEqual(reads.sort(), ['2026-CEC-EE-070', '2026-X-002'], 'single-applicant and unpaid cases are never read');
    assert.deepEqual(snap.entries.filter((e) => e.kind === 'family-missing').map((e) => e.caseRef), ['2026-CEC-EE-070']);
    assert.ok(snap.partial.some((p) => /1 case could not be checked for family members/.test(p)));
  } finally { Object.assign(NA.io, real); }
});

test('Summary: the rule has its label, and the Family Members read uses the board config (not hard-coded ids)', () => {
  const src = fs.readFileSync(require.resolve('../src/services/needsAttentionService.js'), 'utf8');
  assert.match(src, /'family-missing':\{ order: 43, severity: 'high',\s+label: 'Accompanying family not recorded' \}/);
  assert.match(src, /require\('\.\.\/data\/familyMembersBoard\.json'\)/);
  assert.match(src, /NON_ACCOMPANYING_RE = \/\\bnon\[\\s-\]\?accompanying\\b\/i/);
});
