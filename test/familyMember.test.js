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
const ACC = 'CEC Accompanying Spouse & Child', CEC_EE = 'Canadian Experience Class (EE after ITA)';
// schema checklist rows as the seeder writes them: the code starts with the Case Type + Sub Type it was built for
const { slugUpper } = require('../src/services/seedPlanner')._internal;
const codes = (caseType, subType, n, status = '') => Array.from({ length: n }, (_, i) => ({ code: `${slugUpper(caseType)}-${slugUpper(subType)}-PRINCIPAL-APPLICANT-DOC${i}-001`, subType, status }));
const shapeOf = (schema, templateRows = 0) => ({ rows: schema.length + templateRows, templateRows, schema });
function harness({ boardRows = [], manifest = [{ key: 'primary', type: 'Principal Applicant' }], manifestFails = false, reseed = { created: 11, skipped: 11, failed: 0, pruned: 0 }, reseedFails = false, reseedError = null, rowFails = false, manifestAddFails = false, caseState = { stage: 'Document Collection Started', payment: 'Paid', checklistApplied: 'Yes', caseType: CEC_EE, subType: ACC }, stateFails = false, boardLags = false, now = 1_000_000, shape = shapeOf(codes(CEC_EE, ACC, 11)), shapeFails = false, createManifestReturns = null, reseedDelayMs = 0, carry = { copied: 0, total: 0, bySection: {}, unmapped: [], skippedSharedTable: 0, pct: 0, source: '', target: '', written: false, skipped: 'nothing' }, carryFails = false, carryRefuses = false } = {}) {
  const calls = { seq: [], rows: [], manifestAdds: [], manifestCreates: [], reseeds: [], notes: [], carries: [], stateReads: 0, maxConcurrentReseeds: 0 };
  let liveReseeds = 0;
  let list = manifest ? manifest.map((x) => ({ ...x })) : null;   // the questionnaire member list, as the real one: adds are remembered
  const rows = boardRows.slice();
  const real = { ...fam.io };
  fam._recentRows.clear();
  Object.assign(fam.io, {
    // the carry-over of embedded answers (its own tests: questionnaireCarryOver.test.js)
    carryOver: async (a) => {
      calls.seq.push('carry'); calls.carries.push(a);
      if (carryFails) { const e = new Error('Graph 503'); e.transient = true; throw e; }
      if (carryRefuses) { const e = new Error('The client saved their questionnaire 3 minutes ago and may still be typing. Try again in a few minutes.'); e.badRequest = true; e.code = 'RECENT_SAVE'; throw e; }
      return carry;
    },
    // boardLags: the search never shows rows written in this test (Monday's lag)
    boardRows: async () => { const seen = boardLags ? boardRows : rows; return { rows: seen.slice(), members: seen.map((r) => ({ role: ADAPTER[r.boardType] || r.boardType, name: r.name || '', memberKey: r.memberKey || '', flags: {} })) }; },
    manifest: async () => { if (manifestFails) throw new Error('OneDrive down'); return list ? list.map((x) => ({ ...x })) : null; },
    addManifestMember: async (a) => {
      calls.seq.push('manifest'); if (manifestAddFails) throw new Error('upload failed'); calls.manifestAdds.push(a);
      const added = { key: a.key, type: a.memberType, label: a.label || (a.memberType === 'Dependent Child' ? 'Child' : a.memberType.split(' / ')[0]) };
      list = [...(list || [{ key: 'primary', type: 'Principal Applicant' }]), added];
      return added;
    },
    // as the real one: built by the real pure builder from the rows given; createManifestReturns = a list another writer made first
    createManifest: async (a) => {
      calls.seq.push('manifest-create'); calls.manifestCreates.push(a);
      if (createManifestReturns) { list = createManifestReturns.map((x) => ({ ...x })); return { members: createManifestReturns.map((x) => ({ ...x })), created: false }; }
      const built = require('../src/services/htmlQuestionnaireService').buildManifestFromBoard(a.boardMembers) || [{ key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }];
      list = built.map((x) => ({ ...x }));
      return { members: built.map((x) => ({ ...x })), created: true };
    },
    checklistShape: async () => { if (shapeFails) throw new Error('Monday 503'); return shape; },
    createRow: async (a) => { calls.seq.push('row'); if (rowFails) throw new Error('Monday 503'); calls.rows.push(a); rows.push({ boardType: a.row.memberType, memberKey: a.row.memberKey, name: a.row.name }); return 'row-' + calls.rows.length; },
    caseState: async () => { calls.stateReads++; if (stateFails) throw new Error('Monday 503'); return caseState; },
    reseed: async (ref, composition) => {
      calls.seq.push('reseed'); calls.reseeds.push({ ref, composition });
      liveReseeds++; calls.maxConcurrentReseeds = Math.max(calls.maxConcurrentReseeds, liveReseeds);
      try {
        if (reseedDelayMs) await new Promise((r) => setTimeout(r, reseedDelayMs));
        if (reseedError) throw reseedError;
        if (reseedFails) throw new Error('No code schema registered');
        return reseed;
      } finally { liveReseeds--; }
    },
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
    assert.deepEqual(h.calls.seq, ['carry', 'manifest', 'row', 'reseed'], 'the copy of embedded answers, then the manifest before the row — a manifest failure leaves nothing behind');
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

test('no manifest yet: it is CREATED from the board rows just read (never left to a lagging board search), THEN the member is added with its key', async () => {
  const h = harness({ manifest: null, boardRows: [{ boardType: 'Dependent Child', memberKey: 'child-1', name: 'Aarav' }] });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
    assert.equal(r.manifest, 'created');
    assert.equal(h.calls.manifestCreates.length, 1);
    assert.deepEqual(h.calls.manifestCreates[0].boardMembers.map((m) => `${m.role}:${m.memberKey}`), ['DependentChild:child-1'], 'the board as held — the new member is added next, with the key chosen against this list');
    assert.deepEqual(h.calls.manifestAdds.map((a) => a.key), ['spouse']);
    assert.deepEqual(h.calls.seq, ['manifest-create', 'carry', 'manifest', 'row', 'reseed'], 'the list (primary only) exists before the copy; the copy before the member joins it');
    assert.match(h.calls.notes[0].body, /questionnaire member list created with this member/);
  } finally { h.restore(); }
});

test('no manifest yet and a board child WITHOUT a key: the list gives that child its key first, so the new child never takes the same one', async () => {
  const h = harness({ manifest: null, boardRows: [{ boardType: 'Dependent Child', memberKey: '', name: 'Aarav Singla' }] });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', name: 'Diya Singla', source: 'staff' });
    const created = h.calls.manifestCreates[0];
    assert.equal(created.boardMembers.length, 1);
    assert.equal(r.manifest, 'created');
    assert.equal(r.key, 'child-2', 'child-1 went to the board child the list was built from');
    assert.deepEqual(h.calls.manifestAdds.map((a) => [a.key, a.label]), [['child-2', 'Diya Singla']]);
    assert.equal(h.calls.rows[0].row.memberKey, 'child-2');
  } finally { h.restore(); }
});

test('a spouse already on the BOARD is refused before any write; a spouse only on the MANIFEST (the client added it) is ADOPTED — row created with its key, no manifest write', async () => {
  const h1 = harness({ boardRows: [{ boardType: 'Spouse', memberKey: 'spouse' }], manifest: [{ key: 'primary' }, { key: 'spouse', type: 'Spouse / Common-Law Partner' }] });
  try {
    await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }), (e) => e.badRequest === true && /spouse is already on this case/.test(e.message));
    assert.deepEqual(h1.calls.seq, []);
  } finally { h1.restore(); }
  const h2 = harness({ manifest: [{ key: 'primary' }, { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Spouse' }] });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
    assert.equal(r.manifest, 'adopted'); assert.equal(r.key, 'spouse');
    assert.deepEqual(h2.calls.seq, ['row', 'reseed'], 'adopted: the member is already on the list — never carried into (a page may show its section)');
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
    const h = harness({ caseState: { stage, payment: 'Paid', checklistApplied: applied }, shape: shapeOf([]) });   // no document rows either
    try {
      const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
      assert.deepEqual(r.reseed, { deferred: true }, `${stage}/${applied}`); assert.equal(r.stage, stage);
      assert.deepEqual(h.calls.reseeds, [], `${stage}: no re-seed — this path never seeds a whole checklist`);
      assert.match(h.calls.notes[0].body, /no document rows yet — the checklist has not been created \(the case is at ".*"\); they come with the checklist at Document Collection/);
    } finally { h.restore(); }
  }
  // a checklist that exists is re-seeded whatever the stage says (a case moved back, "Stuck" …)
  const h = harness({ caseState: { stage: 'Retainer Confirmed', payment: 'Paid', checklistApplied: 'Yes', caseType: CEC_EE, subType: ACC } });
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

test('the "change the Sub Type" hint appears only when the case\'s schema has no place for the member (decided from the live sub type and the schema)', async () => {
  const single = { stage: 'Internal Review', payment: 'Paid', checklistApplied: 'Yes', caseType: 'PGWP', subType: 'Single Applicant' };
  const h = harness({ reseed: { created: 0, skipped: 6, failed: 0, pruned: 0 }, caseState: single, shape: shapeOf(codes('PGWP', 'Single Applicant', 6)) });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' }, caseSubType: 'Single Applicant' });
    assert.match(r.hint, /The Case Sub Type "Single Applicant" has no documents for a spouse — change it to the variant with family and press Re-seed Checklist/);
    assert.match(h.calls.notes[0].body, /has no documents for a spouse/);
  } finally { h.restore(); }
  // a CEC single-applicant schema DOES have a place for a spouse (non-accompanying): no hint
  const cec = harness({ reseed: { created: 0, skipped: 11, failed: 0, pruned: 0 }, caseState: { ...single, caseType: CEC_EE, subType: 'CEC Single Applicant' }, shape: shapeOf(codes(CEC_EE, 'CEC Single Applicant', 11)) });
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.equal(r.hint, ''); } finally { cec.restore(); }
  const ok = harness({ reseed: { created: 0, skipped: 22, failed: 0, pruned: 0 } });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' });
    assert.equal(r.hint, '', 'an accompanying schema has a spouse role: 0 new rows means they were already there, not a sub-type problem');
  } finally { ok.restore(); }
});

test('NO re-seed on a checklist built the old Template way, or under an earlier Sub Type (it would lay a second checklist beside it) — the note says what to do instead', async () => {
  const t = harness({ shape: shapeOf([], 37) });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
    assert.deepEqual(r.reseed, { manual: 'template' }); assert.equal(t.calls.reseeds.length, 0);
    assert.equal(t.calls.rows.length, 1, 'the board row and the questionnaire section are still added');
    assert.match(t.calls.notes[0].body, /no document rows added — this case's checklist was built from the Template board/);
  } finally { t.restore(); }
  const mixed = harness({ shape: shapeOf(codes(CEC_EE, ACC, 11), 9) });
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.deepEqual(r.reseed, { manual: 'template' }); assert.equal(mixed.calls.reseeds.length, 0); } finally { mixed.restore(); }
  const st = harness({ shape: shapeOf(codes(CEC_EE, 'CEC Single Applicant', 11)) });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' });
    assert.deepEqual(r.reseed, { manual: 'subtype', from: 'CEC Single Applicant', to: ACC }); assert.equal(st.calls.reseeds.length, 0);
    assert.match(st.calls.notes[0].body, /the checklist was built for Sub Type "CEC Single Applicant" and the case now says "CEC Accompanying Spouse &amp; Child"; press Re-seed Checklist on the case/);
  } finally { st.restore(); }
  const caseDiff = harness({ caseState: { stage: 'Document Collection Started', payment: 'Paid', checklistApplied: 'Yes', caseType: ' canadian experience class (ee after ita) ', subType: ' cec accompanying spouse & child ' } });
  try { await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.equal(caseDiff.calls.reseeds.length, 1, 'spacing / letter case never count as a different variant'); } finally { caseDiff.restore(); }
  const ns = harness({ reseedError: Object.assign(new Error('No code schema registered'), { code: 'NO_SCHEMA' }) });
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.deepEqual(r.reseed, { manual: 'no-schema' }); assert.match(ns.calls.notes[0].body, /this case type has no automatic checklist/); } finally { ns.restore(); }
  const sf = harness({ shapeFails: true });
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.deepEqual(r.reseed, { unknown: true }); assert.equal(sf.calls.reseeds.length, 0); } finally { sf.restore(); }
});

test('leftover rows of an earlier variant: all uploaded / reviewed → the re-seed runs (the Re-seed button keeps them too); any still OPEN → no re-seed, staff press Re-seed', async () => {
  const done = harness({ shape: shapeOf([...codes(CEC_EE, ACC, 11), ...codes(CEC_EE, 'CEC Single Applicant', 3, 'Received'), ...codes(CEC_EE, 'CEC Single Applicant', 1, 'Reviewed'), ...codes(CEC_EE, 'CEC Single Applicant', 1, 'Not Applicable')]) });
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.equal(done.calls.reseeds.length, 1); assert.equal(r.reseed.created, 11); } finally { done.restore(); }
  for (const status of ['', 'Missing']) {
    const open = harness({ shape: shapeOf([...codes(CEC_EE, ACC, 11), ...codes(CEC_EE, 'CEC Single Applicant', 2, 'Received'), ...codes(CEC_EE, 'CEC Single Applicant', 1, status)]) });
    try {
      const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' });
      assert.deepEqual(r.reseed, { manual: 'subtype', from: 'CEC Single Applicant', to: ACC }, `stale row "${status || '(blank)'}"`);
      assert.equal(open.calls.reseeds.length, 0);
    } finally { open.restore(); }
  }
});

test('a checklist built for another CASE TYPE is never re-seeded (the re-seed would lay a second checklist) — the note names both case types', async () => {
  const pgwp = { stage: 'Internal Review', payment: 'Paid', checklistApplied: 'Yes', caseType: 'PGWP', subType: 'Single Applicant' };
  const h = harness({ caseState: pgwp, shape: shapeOf(codes(CEC_EE, ACC, 11)) });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' });
    assert.deepEqual(r.reseed, { manual: 'casetype', from: CEC_EE, to: 'PGWP' }); assert.equal(h.calls.reseeds.length, 0);
    assert.match(h.calls.notes[0].body, /the checklist was built for Case Type "Canadian Experience Class \(EE after ITA\)" and the case now says "PGWP"/);
    assert.match(h.calls.notes[0].body, /row and questionnaire section are in place, so do not add them again; if the Case Type is wrong, correct it and press Re-seed Checklist on the case \(it adds this member's documents\), otherwise ask an admin to rebuild the checklist/);
    assert.doesNotMatch(h.calls.notes[0].body, /add the member again/);
  } finally { h.restore(); }
  const blank = harness({ caseState: { ...pgwp, caseType: '', subType: '' }, shape: shapeOf(codes('NB WP Extension', '', 6)) });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' });
    assert.equal(r.reseed.manual, 'casetype'); assert.equal(blank.calls.reseeds.length, 0);
    assert.match(blank.calls.notes[0].body, /and the case now says "nothing"/);
  } finally { blank.restore(); }
  const src = fs.readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8');
  assert.match(src, /rs\.manual === 'casetype' \? 'No document rows added: the checklist was built for another Case Type — see the note on the case \(do not add the member again\)\.'/);
});

test('splitByVariant: a row belongs to the LONGEST registered variant prefix ("Visitor Record" is the start of "Visitor Record + Restoration"); a row no variant claims is stale', () => {
  const VR = 'Visitor Record / Extension';
  const rows = [...codes(VR, 'Visitor Record + Restoration', 3), ...codes(VR, 'Visitor Record', 2)];
  const asRestoration = fam.splitByVariant(rows, { caseType: VR, subType: 'Visitor Record + Restoration' });
  assert.equal(asRestoration.current, 3); assert.equal(asRestoration.stale.length, 2);
  const asRecord = fam.splitByVariant(rows, { caseType: VR, subType: 'Visitor Record' });
  assert.equal(asRecord.current, 2, 'the Restoration rows are NOT counted as the plain Visitor Record variant');
  assert.deepEqual([...new Set(asRecord.stale.map((r) => r.owner.subType))], ['Visitor Record + Restoration']);
  const orphan = fam.splitByVariant([{ code: 'NO-SUCH-TYPE-X-PRINCIPAL-APPLICANT-A-001', subType: 'X', status: '' }], { caseType: CEC_EE, subType: ACC });
  assert.equal(orphan.current, 0); assert.equal(orphan.stale.length, 1); assert.equal(orphan.stale[0].owner, null);
  // the real registry has that very pair
  const reg = require('../src/services/caseSchemaService').listRegistered();
  assert.ok(reg.some((s) => s.caseType === VR && s.subType === 'Visitor Record') && reg.some((s) => s.caseType === VR && s.subType === 'Visitor Record + Restoration'));
});

test('a board child WITHOUT a key keeps its document rows: the new child never takes the number the seeder gives it (checked against the real seed plan)', () => {
  const css = require('../src/services/caseSchemaService'); const sp = require('../src/services/seedPlanner');
  const schema = css.lookup('AAIP', 'Express Entry Stream');
  const aarav = { role: 'DependentChild', name: 'Aarav', memberKey: '', flags: { nameChanged: true } };
  const affidavits = (members) => sp.seedPlan({ schema, composition: { members } }).filter((r) => /NAMEAFFIDAVIT/.test(r.documentCode)).map((r) => r.documentCode);
  const before = affidavits([aarav]);
  assert.equal(before.length, 1);
  const key = fam.nextMemberKey('Dependent Child', { boardRows: [{ boardType: 'Dependent Child', memberKey: '', name: 'Aarav' }], manifestMembers: [{ key: 'primary' }] });
  assert.equal(key, 'child-2');
  assert.deepEqual(affidavits([aarav, { role: 'DependentChild', name: 'Kabir', memberKey: key, flags: {} }]), before, 'Aarav\'s flagged document keeps its number');
  assert.notDeepEqual(affidavits([aarav, { role: 'DependentChild', name: 'Kabir', memberKey: 'child-1', flags: {} }]), before, 'the old pick (child-1) would have moved it — the defect this guards');
  // the seeder's own rule, mirrored: a key's number when free, else the lowest unused
  assert.deepEqual(fam.seedIndices(['child-3', '', 'child-1', 'child-1', 'kid']), [3, 2, 1, 4, 5]);
  assert.equal(fam.nextMemberKey('Dependent Child', { boardRows: [{ boardType: 'Dependent Child', memberKey: 'child-3' }, { boardType: 'Dependent Child', memberKey: '' }] }), 'child-2', 'keyless takes 1; 3 is keyed; 2 is free');
});

test('a spouse on the board WITHOUT a key whom the questionnaire lacks gets their section (plain key), no second row, one spouse in the re-seed; refused when the list has a spouse already', async () => {
  const h = harness({ boardRows: [{ boardType: 'Spouse', memberKey: '', name: 'Priya Singla' }], manifest: [{ key: 'primary', type: 'Principal Applicant' }, { key: 'child-1', type: 'Dependent Child' }] });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
    assert.equal(r.manifest, 'completed'); assert.equal(r.key, 'spouse'); assert.equal(h.calls.rows.length, 0);
    assert.deepEqual(h.calls.manifestAdds.map((a) => [a.key, a.label]), [['spouse', 'Priya Singla']]);
    assert.equal(h.calls.reseeds[0].composition.members.filter((m) => m.role === 'Spouse').length, 1, 'never two spouses in the plan');
  } finally { h.restore(); }
  const other = harness({ boardRows: [{ boardType: 'Spouse', memberKey: '', name: 'Priya' }], manifest: [{ key: 'primary' }, { key: 'spouse-x', type: 'Spouse / Common-Law Partner' }] });
  try { await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }), /spouse is already on this case/); assert.equal(other.calls.manifestAdds.length, 0); } finally { other.restore(); }
});

test('the hint: "change the Sub Type" only when another variant of the case type has the member; otherwise "add by hand"', async () => {
  const css = require('../src/services/caseSchemaService');
  const bowp = css.listForCaseType('BOWP')[0];
  const h = harness({ reseed: { created: 0, skipped: 5, failed: 0, pruned: 0 }, caseState: { stage: 'Internal Review', payment: 'Paid', checklistApplied: 'Yes', caseType: 'BOWP', subType: bowp.subType || '' }, shape: shapeOf(codes('BOWP', bowp.subType || '', 5)) });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' });
    assert.equal(r.hint, "This case type's checklist has no documents for a spouse — add any they need by hand.");
    assert.doesNotMatch(r.hint, /change it to the variant/);
  } finally { h.restore(); }
});

test('rows of a retired / renamed variant of the case\'s own Case Type are owned by their Sub Type column (a Sub Type mismatch, or current when it is the case\'s own)', () => {
  const rows = [{ code: 'PGWP-OLD-NAME-PRINCIPAL-APPLICANT-A-001', subType: 'Old Name', status: '' }];
  const s = fam.splitByVariant(rows, { caseType: 'PGWP', subType: 'Single Applicant' });
  assert.equal(s.current, 0); assert.equal(s.stale.length, 1); assert.deepEqual([s.stale[0].owner.caseType, s.stale[0].owner.subType], ['PGWP', 'Old Name']);
  const own = fam.splitByVariant(rows, { caseType: 'PGWP', subType: 'Old Name' });
  assert.equal(own.current, 1, 'the case\'s own (unregistered) variant: current — the re-seed then says there is no automatic checklist');
});

test('a retired variant of the same Case Type → the Sub Type note (press Re-seed), never the Case Type one', async () => {
  const h = harness({ caseState: { stage: 'Internal Review', payment: 'Paid', checklistApplied: 'Yes', caseType: CEC_EE, subType: ACC }, shape: shapeOf([{ code: `${slugUpper(CEC_EE)}-OLD-VARIANT-PRINCIPAL-APPLICANT-A-001`, subType: 'Old Variant', status: '' }]) });
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.deepEqual(r.reseed, { manual: 'subtype', from: 'Old Variant', to: ACC }); } finally { h.restore(); }
});

test('the questionnaire list builder never gives two members one key, in any board order', () => {
  const { buildManifestFromBoard } = require('../src/services/htmlQuestionnaireService');
  const keys = (rows) => buildManifestFromBoard(rows).map((m) => m.key);
  assert.deepEqual(keys([{ role: 'DependentChild', memberKey: 'child-2', name: 'A' }, { role: 'DependentChild', memberKey: '', name: 'B' }]), ['primary', 'child-2', 'child-1']);
  assert.deepEqual(keys([{ role: 'DependentChild', memberKey: '', name: 'B' }, { role: 'DependentChild', memberKey: 'child-2', name: 'A' }]), ['primary', 'child-1', 'child-2'], 'a later row keeps its own board key');
  assert.deepEqual(keys([{ role: 'DependentChild', memberKey: '', name: 'B' }, { role: 'DependentChild', memberKey: 'child-1', name: 'A' }]), ['primary', 'child-2', 'child-1']);
  assert.deepEqual(keys([{ role: 'Spouse', memberKey: '', name: 'S' }, { role: 'Spouse', memberKey: 'spouse', name: 'T' }]), ['primary', 'spouse-2', 'spouse']);
  for (const rows of [[{ role: 'DependentChild', memberKey: 'child-1' }, { role: 'DependentChild', memberKey: 'child-1' }, { role: 'DependentChild', memberKey: '' }]]) {
    const k = keys(rows); assert.equal(new Set(k).size, k.length, k.join(','));
  }
});

test('the checklist read: Template rows are the ones with a numeric Template id; a row added by hand (no id) counts as neither', async () => {
  const mondayApi = require('../src/services/mondayApi');
  const realQuery = mondayApi.query;
  const row = (intake, sub, status) => ({ column_values: [{ id: 'text_mm0zfsp1', text: intake }, { id: 'text_mm17zdy7', text: sub }, { id: 'color_mm0zwgvr', text: status }] });
  mondayApi.query = async () => ({ items_page_by_column_values: { items: [row('code:CANADIAN-X-PRINCIPAL-APPLICANT-A-001', ACC, 'Received'), row('11223344', '', ''), row('', '', ''), row('  ', '', 'Missing')] } });
  try {
    const s = await fam.io.checklistShape('2026-CEC-EE-070');
    assert.equal(s.rows, 4); assert.equal(s.templateRows, 1);
    assert.deepEqual(s.schema, [{ code: 'CANADIAN-X-PRINCIPAL-APPLICANT-A-001', subType: ACC, status: 'Received' }]);
  } finally { mondayApi.query = realQuery; }
});

test('a spouse ON the board but missing from the questionnaire list gets their section (the board key and name), no second row; a spouse on both is still refused', async () => {
  const h = harness({ boardRows: [{ boardType: 'Spouse', memberKey: 'spouse', name: 'Priya Singla' }] });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
    assert.equal(r.manifest, 'completed'); assert.equal(r.key, 'spouse'); assert.equal(r.rowId, '');
    assert.deepEqual(h.calls.manifestAdds.map((a) => [a.key, a.label]), [['spouse', 'Priya Singla']]);
    assert.equal(h.calls.rows.length, 0, 'no second spouse row');
    assert.match(h.calls.notes[0].body, /the member was on the Family Members board already — their questionnaire section is now added/);
    assert.doesNotMatch(h.calls.notes[0].body, /Family Members row created/);
  } finally { h.restore(); }
  const both = harness({ boardRows: [{ boardType: 'Spouse', memberKey: 'spouse', name: 'Priya' }], manifest: [{ key: 'primary' }, { key: 'spouse', type: 'Spouse / Common-Law Partner' }] });
  try { await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }), /spouse is already on this case/); } finally { both.restore(); }
  const ph = harness({ boardRows: [{ boardType: 'Spouse', memberKey: 'spouse', name: 'Spouse (from intake)' }] });
  try { await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.equal(ph.calls.manifestAdds[0].label, undefined, 'a placeholder name never becomes the section label'); } finally { ph.restore(); }
});

test('what the caller (and so the client) is told is the questionnaire\'s own label — never a board placeholder', async () => {
  const h = harness();
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', source: 'client', reseedMode: 'background' });
    assert.equal(r.rowName, 'Child 1 (added by client)'); assert.equal(r.label, 'Child');
  } finally { h.restore(); }
  const created = harness({ manifest: null });
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'client', reseedMode: 'background' }); assert.equal(r.label, 'Spouse'); } finally { created.restore(); }
  const rf = harness({ rowFails: true });
  try {
    await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'client', reseedMode: 'background' }), (e) => e.member && e.member.label === 'Spouse' && !/added by/.test(e.member.label));
  } finally { rf.restore(); }
});

test('a member list that appeared between the read and the create (another writer) gets the member added to it — never a false "created with this member"', async () => {
  const h = harness({ manifest: null, createManifestReturns: [{ key: 'primary', label: 'Primary Applicant' }] });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' });
    assert.equal(r.manifest, 'added');
    assert.deepEqual(h.calls.seq.slice(0, 3), ['manifest-create', 'carry', 'manifest']);
    assert.equal(h.calls.manifestAdds[0].key, 'spouse');
  } finally { h.restore(); }
});

test('background re-seeds stay inside the per-case queue: three quick client adds never run two re-seeds at once', async () => {
  const h = harness({ reseedDelayMs: 20 });
  try {
    const rs = await Promise.all([1, 2, 3].map(() => fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', source: 'client', reseedMode: 'background' })));
    assert.deepEqual(rs.map((r) => r.key), ['child-1', 'child-2', 'child-3']);
    while (fam._inFlight.size) await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.calls.reseeds.length, 3);
    assert.equal(h.calls.maxConcurrentReseeds, 1, 'never two at once');
    // each re-seed saw every member added before it
    assert.deepEqual(h.calls.reseeds.map((x) => x.composition.members.map((mm) => mm.memberKey).join(',')), ['child-1', 'child-1,child-2', 'child-1,child-2,child-3']);
  } finally { h.restore(); }
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
    await settle();   // the queue also waits for each add's re-seed, so it empties a moment after the answer
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
    const { members, created } = await svc.createManifestFromBoard({ clientName: 'K', caseRef: '2026-TEST-902', boardMembers: [
      { role: 'Spouse', name: 'Spouse (added by staff)', memberKey: 'spouse', flags: {} },
      { role: 'DependentChild', name: 'Child 1 (from intake)', memberKey: 'child-1', flags: {} },
      { role: 'DependentChild', name: 'Child 2 (added by client)', memberKey: 'child-2', flags: {} },
      { role: 'DependentChild', name: 'Diya Singla', memberKey: 'child-3', flags: {} } ] });
    assert.deepEqual(members.map((m) => m.label), ['Primary Applicant', 'Spouse', 'Child', 'Child 2', 'Diya Singla']);
    assert.deepEqual(members.map((m) => m.key), ['primary', 'spouse', 'child-1', 'child-2', 'child-3']);
    assert.equal(created, true);
    assert.equal(q.uploads.length, 1);
  } finally { q.restore(); }
  const q2 = qStubs({ manifest: [{ key: 'primary', type: 'Principal Applicant', label: 'Principal Applicant' }, { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Priya' }] });
  try {
    const { members, created } = await svc.createManifestFromBoard({ clientName: 'K', caseRef: '2026-TEST-903', boardMembers: [] });
    assert.deepEqual(members.map((m) => m.key), ['primary', 'spouse'], 'the existing manifest is returned as is');
    assert.equal(created, false, 'another writer\'s list: never reported as created');
    assert.equal(q2.uploads.length, 0);
  } finally { q2.restore(); }
});

/* ───────────────────────── the lead bridge keeps its contract ───────────────────────── */

test('createFromLead: a board that already has ANY row is left alone (a hand-deleted row never comes back, a keyless hand-added row never gets a twin)', async () => {
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
  let board = [{ role: 'DependentChild', name: 'Aarav', memberKey: '', flags: {} }];   // a keyless row staff typed in Monday
  compositionAdapter.readForCase = async () => ({ caseFlags: {}, members: board });
  try {
    assert.equal(await comp.createFromLead({ lead: { hasSpouse: 'Yes', childrenCount: '2' }, caseRef: '2026-TEST-904', cmItemId: '77001' }), 0);
    assert.deepEqual(created, [], 'nothing created next to a curated board');
    board = [];
    const n = await comp.createFromLead({ lead: { hasSpouse: 'Yes', childrenCount: '2' }, caseRef: '2026-TEST-905', cmItemId: '77002' });
    assert.equal(n, 3, 'an empty board gets the intake rows');
    assert.deepEqual(created.map((c) => c.name), ['Spouse (from intake)', 'Child 1 (from intake)', 'Child 2 (from intake)']);
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
    fam.addFamilyMember = async (a) => { calls.push(a); return { ok: true, key: 'child-1', portalType: 'Dependent Child', rowName: 'Child 1 (added by client)', label: 'Child', reseed: { pending: true } }; };
    let res = fakeRes(); await handler({ params: { caseRef: '2026-CEC-EE-070' }, body: { token: 't', memberType: 'Dependent Child' } }, res);
    assert.equal(res.statusCode, 200); assert.deepEqual(res.body, { ok: true, member: { key: 'child-1', type: 'Dependent Child', label: 'Child' } }, 'the client is told the questionnaire label, never the board placeholder');
    assert.deepEqual(calls[0], { caseRef: '2026-CEC-EE-070', cmItemId: '12961158283', clientName: 'Shaveenu Singla', boardType: 'Dependent Child', source: 'client', reseedMode: 'background', caseSubType: 'CEC Accompanying Spouse & Child' });
    fam.addFamilyMember = async () => { const e = new Error('row failed'); e.transient = true; e.manifestAdded = true; e.member = { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Spouse' }; throw e; };
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

/* ───────────────────────── the carry-over of embedded answers ───────────────────────── */

test('carry-over: runs BEFORE anything is written, only for a Spouse / Dependent Child, with the member key and type; its counts reach the result, the note and nothing else', async () => {
  const h = harness({ carry: { copied: 12, total: 20, bySection: { 'Personal Details': 7, 'Marital Status': 5 }, unmapped: [], skippedSharedTable: 0, pct: 60, source: 'primary', target: 'spouse', written: true } });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff', actor: { name: 'G' } });
    assert.equal(h.calls.seq[0], 'carry');
    assert.deepEqual(h.calls.carries, [{ clientName: BASE.clientName, caseRef: BASE.caseRef, itemId: BASE.cmItemId, memberKey: 'spouse', memberType: 'Spouse / Common-Law Partner', memberName: '' }]);
    assert.deepEqual(r.carry, { copied: 12, total: 20, bySection: { 'Personal Details': 7, 'Marital Status': 5 }, unmapped: [], skippedSharedTable: 0, ambiguousDependent: 0, givenName: '', unmatched: false, childNames: [], attributedBlock: false, skipped: '', written: true });
    assert.match(h.calls.notes[0].body, /Copied 12 answers the client had typed for this member inside their own form into the new section \(Personal Details 7, Marital Status 5\)\./);
  } finally { h.restore(); }
  const child = harness({ carry: { copied: 3, total: 9, bySection: { 'Personal Details': 3 }, unmapped: ['Date of Birth'], skippedSharedTable: 2, pct: 33, source: 'primary', target: 'child-1', written: true } });
  try {
    await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', source: 'client', reseedMode: 'background' });
    assert.equal(child.calls.carries[0].memberKey, 'child-1'); assert.equal(child.calls.carries[0].memberType, 'Dependent Child');
    await settle();
    assert.match(child.calls.notes[0].body, /no box in the new section for: Date of Birth \(kept aside\)\. The children&#39;s shared history table in the client&#39;s own form \(2 answers\) was not copied/);
  } finally { child.restore(); }
  for (const boardType of ['Parent', 'Sibling']) {
    const p = harness();
    try { await fam.addFamilyMember({ ...BASE, boardType, source: 'staff' }); assert.equal(p.calls.carries.length, 0, boardType + ': the single-member form embeds no section for them'); } finally { p.restore(); }
  }
});

test('carry-over note: a dual-form main form\'s unattributed dependent block is reported, never silently left behind', async () => {
  const h = harness({ carry: { copied: 0, total: 0, bySection: {}, unmapped: [], skippedSharedTable: 0, ambiguousDependent: 3, written: false, skipped: 'nothing' } });
  try {
    await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' });
    assert.match(h.calls.notes[0].body, /The client&#39;s own form has a &quot;Dependent&quot; block whose name could not be matched to the spouse \(3 answers\) — not copied; it leaves the client&#39;s page now, so check it with the client\./);
  } finally { h.restore(); }
  const kid = harness({ carry: { copied: 0, total: 0, bySection: {}, unmapped: [], skippedSharedTable: 0, ambiguousDependent: 0, givenName: '', unmatched: false, childNames: [], attributedBlock: true, written: false, skipped: 'nothing' } });
  try {
    await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', name: 'Ayaan', source: 'staff' });
    assert.match(kid.calls.notes[0].body, /The &quot;Dependent&quot; block in the client&#39;s own form is the spouse&#39;s \(the name there matches\) — nothing in it for this member\./);
  } finally { kid.restore(); }
});

test('carry-over: the staff-typed name reaches the copy (a child is chosen by it); a name that matches no single child copies nothing and says so', async () => {
  const h = harness({ carry: { copied: 0, total: 0, bySection: {}, unmapped: [], skippedSharedTable: 0, ambiguousDependent: 0, givenName: '', unmatched: true, childNames: ['Aarav', 'Diya'], written: false, skipped: 'unmatched' } });
  try {
    await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', name: 'Kabir Singla', source: 'staff' });
    assert.equal(h.calls.carries[0].memberName, 'Kabir Singla');
    assert.match(h.calls.notes[0].body, /The client&#39;s own form lists children named Aarav, Diya; none matched the name given \(or more than one did\), so nothing was copied into this section\./);
  } finally { h.restore(); }
  const ok = harness({ carry: { copied: 4, total: 9, bySection: { 'Personal Details': 4 }, unmapped: [], skippedSharedTable: 0, ambiguousDependent: 0, givenName: 'Diya', unmatched: false, childNames: ['Aarav', 'Diya'], written: true } });
  try { await fam.addFamilyMember({ ...BASE, boardType: 'Dependent Child', name: 'Diya', source: 'staff' }); assert.match(ok.calls.notes[0].body, /Copied 4 answers the client had typed for Diya inside their own form/); } finally { ok.restore(); }
});

test('carry-over note: an F6 block attributed by name reads so', async () => {
  const h = harness({ carry: { copied: 36, total: 40, bySection: { 'Section 1 — Profile Details': 12 }, unmapped: [], skippedSharedTable: 0, ambiguousDependent: 0, givenName: 'Sabri', unmatched: false, childNames: [], attributedBlock: true, written: true } });
  try { await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', name: 'Mohamed Sabri Rauf', source: 'staff' }); assert.match(h.calls.notes[0].body, /Copied 36 answers the client had typed for Sabri in the &quot;Dependent&quot; block of their own form \(the name there matches\) into the new section/); } finally { h.restore(); }
});

test('carry-over: a storage failure ABORTS the add before any write (transient, retry later); a "client may still be typing" refusal reaches staff as it is', async () => {
  const f = harness({ carryFails: true });
  try {
    await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }), (e) => e.transient === true && /could not be read to copy their answers into the new section/.test(e.message) && /Nothing was changed/.test(e.message));
    assert.deepEqual(f.calls.seq, ['carry']); assert.equal(f.calls.manifestAdds.length, 0); assert.equal(f.calls.rows.length, 0); assert.equal(f.calls.notes.length, 0);
  } finally { f.restore(); }
  const r = harness({ carryRefuses: true });
  try {
    await assert.rejects(fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }), (e) => e.badRequest === true && /may still be typing/.test(e.message));
    assert.deepEqual(r.calls.seq, ['carry']); assert.equal(r.calls.notes.length, 0);
  } finally { r.restore(); }
});

test('carry-over: nothing to copy, or a section that already holds answers → the add goes on; the note says so only in the second case; the switch turns it off', async () => {
  const none = harness();
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.equal(r.carry.written, false); assert.doesNotMatch(none.calls.notes[0].body, /Copied|nothing was copied/); } finally { none.restore(); }
  const has = harness({ carry: { copied: 0, total: 0, bySection: {}, unmapped: [], skippedSharedTable: 0, pct: 0, source: 'primary', target: 'spouse', written: false, skipped: 'has-answers', existing: 4 } });
  try { await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.match(has.calls.notes[0].body, /The new section already holds answers, so nothing was copied over it\./); } finally { has.restore(); }
  const prev = process.env.QUESTIONNAIRE_CARRY_OVER; process.env.QUESTIONNAIRE_CARRY_OVER = '0';
  const off = harness();
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.equal(off.calls.carries.length, 0); assert.equal(r.carry, null); assert.deepEqual(off.calls.seq, ['manifest', 'row', 'reseed']); }
  finally { off.restore(); if (prev === undefined) delete process.env.QUESTIONNAIRE_CARRY_OVER; else process.env.QUESTIONNAIRE_CARRY_OVER = prev; }
});

test('a checklist whose "Applied" flag was reset to No (the old Monday automation) but whose rows exist is an existing checklist: the re-seed runs; with NO rows the add still defers', async () => {
  const flagNo = { stage: 'Internal Review', payment: 'Paid', checklistApplied: 'No', caseType: CEC_EE, subType: ACC };
  const h = harness({ caseState: flagNo });
  try {
    const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' });
    assert.equal(h.calls.reseeds.length, 1); assert.equal(r.reseed.created, 11);
    assert.doesNotMatch(h.calls.notes[0].body, /the checklist has not been created/);
  } finally { h.restore(); }
  const empty = harness({ caseState: flagNo, shape: shapeOf([]) });
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.deepEqual(r.reseed, { deferred: true }); assert.equal(empty.calls.reseeds.length, 0); } finally { empty.restore(); }
  const hand = harness({ caseState: flagNo, shape: { rows: 1, templateRows: 0, schema: [] } });
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.deepEqual(r.reseed, { deferred: true }, 'a row added by hand is not a checklist'); assert.equal(hand.calls.reseeds.length, 0); } finally { hand.restore(); }
  const unread = harness({ caseState: flagNo, shapeFails: true });
  try { const r = await fam.addFamilyMember({ ...BASE, boardType: 'Spouse', source: 'staff' }); assert.deepEqual(r.reseed, { deferred: true }, 'flag No and the rows unreadable: no claim that a checklist exists'); } finally { unread.restore(); }
});

test('the cockpit tells staff what was copied (plain quotes only in the template script)', () => {
  const src = fs.readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8');
  assert.match(src, /var cy = res\.j\.carry \|\| null;/);
  assert.match(src, /Copied ' \+ cy\.copied \+ ' answer\(s\) the client had typed for this member in their own form into the new section\./);
  assert.match(src, /The new section already had answers, so nothing was copied over it\./);
  const server = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.match(server, /app\.post\('\/admin\/questionnaire\/:caseRef\/carry-over'/);
  assert.match(server, /if \(body\.dryRun === false\) return res\.status\(400\)/, 'the route only previews — a real copy happens only inside Add family member');
  assert.doesNotMatch(server, /fallbackFormFile/, 'the copy never records a guessed edition');
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
// default: the checklist (when the board has no family) lists the main applicant only
const run = (items, family, checklistFamily, manifestFamily) => NA.detect({ cases: items.map(NA.parseCase), family: new Map(Object.entries(family || {})),
  checklistFamily: new Map(Object.entries(checklistFamily || Object.fromEntries(Object.keys(family || {}).map((k) => [k, new Set(['Principal Applicant'])])))),
  manifestFamily: new Map(Object.entries(manifestFamily || {})), now: NOW }).filter((e) => e.kind === 'family-missing');

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
  const reads = [], clReads = [];
  const real = { ...NA.io };
  Object.assign(NA.io, {
    readCases: async () => [item({ id: '3001', ref: '2026-CEC-EE-070' }), item({ id: '3002', ref: '2026-CEC-EE-071', subType: 'CEC Single Applicant' }), item({ id: '3003', ref: '2026-X-002', subType: 'Non Express Entry - Accompanying Spouse & Child' }), item({ id: '3004', ref: '2026-X-003', payment: 'Signed (Unpaid)', paidDate: '' })],
    hasChecklist: async () => true, listRootFolders: async () => [], workFoldersPresent: async () => true,
    readDeepNotes: async () => ({ notes: new Map(), failed: [] }), newestChecklistRowAt: async () => 0, postNote: async () => {},
    familyTypes: async (ref) => { reads.push(ref); if (ref === '2026-X-002') throw new Error('503'); return new Set(); },
    checklistMemberTypes: async (ref) => { clReads.push(ref); return new Set(['Principal Applicant']); },
    manifestMemberTypes: async () => new Set(),
  });
  try {
    const snap = await NA.buildSnapshot();
    assert.deepEqual(reads.sort(), ['2026-CEC-EE-070', '2026-X-002'], 'single-applicant and unpaid cases are never read');
    assert.deepEqual(clReads, ['2026-CEC-EE-070'], 'the checklist is read only for a case whose board had no family (and was readable)');
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


test('Summary: a checklist that already lists spouse/child rows (built the old Template way) is NOT flagged when the questionnaire has them; an unread checklist is no claim', () => {
  NA.io.now = () => NOW;
  const empty = { '2026-CEC-EE-070': new Set() };
  const withSpouse = { '2026-CEC-EE-070': new Set(['Spouse / Common-Law Partner']) };
  assert.equal(run([item()], empty, { '2026-CEC-EE-070': new Set(['Principal Applicant', 'Spouse / Common-Law Partner', 'Dependent Child']) }, withSpouse).length, 0);
  assert.equal(run([item()], empty, { '2026-CEC-EE-070': new Set(['Principal Applicant', 'Dependent Child 1']) }, { '2026-CEC-EE-070': new Set(['Dependent Child']) }).length, 0);
  assert.equal(run([item()], empty, { '2026-CEC-EE-070': null }).length, 0, 'unread → no claim');
  assert.equal(run([item()], empty, { '2026-CEC-EE-070': new Set() }).length, 1, 'no checklist rows at all (not built yet) and no family on the board');
  assert.equal(run([item()], empty, { '2026-CEC-EE-070': new Set(['Principal Applicant']) }).length, 1);
});

test('Summary: the checklist lists spouse/child rows but the questionnaire has no spouse/child section → listed with its own wording (the client sees neither); an unread list is no claim', () => {
  NA.io.now = () => NOW;
  const empty = { '2026-CEC-EE-070': new Set() };
  const cl = { '2026-CEC-EE-070': new Set(['Principal Applicant', 'Spouse / Common-Law Partner', 'Dependent Child']) };
  const hit = run([item()], empty, cl, { '2026-CEC-EE-070': new Set() });
  assert.equal(hit.length, 1);
  assert.match(hit[0].why, /the document checklist lists spouse\/child documents, but neither the Family Members board nor the questionnaire has a spouse or child — so the client sees neither the family's questions nor their documents/);
  assert.match(hit[0].todo, /Add family member/); assert.match(hit[0].todo, /the checklist is left as it is/);
  assert.notEqual(run([item({ id: '5001' })], empty, cl, { '2026-CEC-EE-070': new Set() })[0].key, run([item({ id: '5001' })], empty)[0].key, 'its own key: a "Mark handled" note on the other wording never hides this one');
  assert.equal(run([item()], empty, cl, { '2026-CEC-EE-070': new Set(['Sponsor', 'Worker Spouse']) }).length, 1, 'a sponsor / worker spouse section is not the accompanying family');
  assert.equal(run([item()], empty, cl, { '2026-CEC-EE-070': null }).length, 0, 'unread list → no claim');
  assert.equal(run([item()], empty, cl).length, 0, 'not read at all → no claim');
});

test('Summary: the plain alert says only what was read — the questionnaire with a spouse/child section gets its own wording; an unread list makes no questionnaire claim; one key for these', () => {
  NA.io.now = () => NOW;
  const empty = { '2026-CEC-EE-070': new Set() };
  const pa = { '2026-CEC-EE-070': new Set(['Principal Applicant']) };
  const q = run([item({ id: '5002' })], empty, pa, { '2026-CEC-EE-070': new Set(['Dependent Child']) });
  assert.equal(q.length, 1);
  assert.match(q[0].why, /the questionnaire has a spouse\/child section, but the Family Members board and the document checklist have no spouse or child — so the client answers the family's questions but sees none of their documents/);
  assert.match(q[0].todo, /it matches their section and adds their document rows/);
  const unread = run([item({ id: '5002' })], empty, pa, { '2026-CEC-EE-070': null });
  assert.equal(unread.length, 1);
  assert.match(unread[0].why, /so the document checklist covers the main applicant only/); assert.doesNotMatch(unread[0].why, /questionnaire/);
  const none = run([item({ id: '5002' })], empty, pa, { '2026-CEC-EE-070': new Set() });
  assert.match(none[0].why, /so the questionnaire and the document checklist cover the main applicant only/);
  assert.equal(new Set([q[0].key, unread[0].key, none[0].key]).size, 1, 'the same problem (board + checklist lack the family): one key');
});

test('Summary: only a real spouse / dependent child row counts as family on the checklist — "Non Accompanying", "Worker Spouse" and "Sponsor" rows do not', () => {
  NA.io.now = () => NOW;
  const empty = { '2026-CEC-EE-070': new Set() };
  for (const types of [['Principal Applicant', 'Non Accompanying Spouse'], ['Principal Applicant', 'Non Accompanying Child 1'], ['Principal Applicant', 'Worker Spouse'], ['Principal Applicant', 'Sponsor']]) {
    const hit = run([item()], empty, { '2026-CEC-EE-070': new Set(types) });
    assert.equal(hit.length, 1, types.join(' + '));
    assert.match(hit[0].why, /the Family Members board has no spouse or child for this case/, 'the plain wording: the checklist has no family either');
  }
  for (const types of [['Spouse'], ['Spouse / Common-Law Partner'], ['Dependent Child'], ['Dependent Child 2']]) {
    assert.equal(run([item()], empty, { '2026-CEC-EE-070': new Set(types) }, { '2026-CEC-EE-070': new Set(['Spouse / Common-Law Partner']) }).length, 0, types.join(' + '));
  }
});

test('Summary snapshot: the questionnaire list is read for a case whose board lacks the family; a failed read is reported as partial and claims nothing it did not read', async () => {
  NA._resetForTests(); NA.io.now = () => NOW;
  const mReads = [];
  const real = { ...NA.io };
  Object.assign(NA.io, {
    readCases: async () => [item({ id: '3101', ref: '2026-CEC-EE-070', name: 'Shaveenu Singla' }), item({ id: '3102', ref: '2026-CEC-EE-081' }), item({ id: '3103', ref: '2026-CEC-EE-082' }), item({ id: '3104', ref: '2026-CEC-EE-083' })],
    hasChecklist: async () => true, listRootFolders: async () => [], workFoldersPresent: async () => true,
    readDeepNotes: async () => ({ notes: new Map(), failed: [] }), newestChecklistRowAt: async () => 0, postNote: async () => {},
    familyTypes: async (ref) => (ref === '2026-CEC-EE-083' ? new Set(['Spouse']) : new Set()),
    checklistMemberTypes: async (ref) => (ref === '2026-CEC-EE-081' ? new Set(['Principal Applicant']) : new Set(['Principal Applicant', 'Spouse / Common-Law Partner'])),
    manifestMemberTypes: async (ref, clientName) => { mReads.push([ref, clientName]); if (ref === '2026-CEC-EE-082') throw new Error('OneDrive 503'); return new Set(); },
  });
  try {
    const snap = await NA.buildSnapshot();
    assert.deepEqual(mReads.sort(), [['2026-CEC-EE-070', 'Shaveenu Singla'], ['2026-CEC-EE-081', 'Client'], ['2026-CEC-EE-082', 'Client']], 'every case whose board lacks the family and whose checklist was read; EE-083 (family on the board) never');
    assert.deepEqual(snap.entries.filter((e) => e.kind === 'family-missing').map((e) => e.caseRef).sort(), ['2026-CEC-EE-070', '2026-CEC-EE-081']);
    assert.ok(snap.partial.some((p) => /1 case could not be checked for family members/.test(p)));
  } finally { Object.assign(NA.io, real); }
});

test('Summary: the questionnaire list is READ, never seeded or saved', async () => {
  const svc = require('../src/services/htmlQuestionnaireService');
  const realRead = svc.readMembersManifest, realLoad = svc.loadMembers;
  let loads = 0;
  svc.readMembersManifest = async () => null; svc.loadMembers = async () => { loads++; return []; };
  try {
    const types = await NA.io.manifestMemberTypes('2026-CEC-EE-070', 'K');
    assert.ok(types instanceof Set); assert.equal(types.size, 0, 'no list yet = no family sections (the questionnaire shows the board, which has none)');
    svc.readMembersManifest = async () => [{ key: 'primary', type: 'Principal Applicant' }, { key: 'spouse', type: 'Spouse / Common-Law Partner' }];
    assert.deepEqual([...await NA.io.manifestMemberTypes('2026-CEC-EE-070', 'K')], ['Spouse / Common-Law Partner']);
    assert.equal(loads, 0, 'loadMembers (which can seed a list) is never used');
  } finally { svc.readMembersManifest = realRead; svc.loadMembers = realLoad; }
});

test('placeholder names never become a person\'s name: the pre-fill, the sponsor section and the manifest share one rule', () => {
  const { isPlaceholderName } = require('../src/utils/memberNames');
  for (const n of ['Spouse (from intake)', 'Child 1 (from intake)', 'Spouse (added by staff)', 'Child 2 (added by client)', 'child 3 (ADDED BY CLIENT)']) assert.equal(isPlaceholderName(n), true, n);
  for (const n of ['Priya Singla', 'Aarav', 'Spouse of record']) assert.equal(isPlaceholderName(n), false, n);
  const prefillSrc = fs.readFileSync(require.resolve('../config/questionnairePrefillMap.js'), 'utf8');
  assert.match(prefillSrc, /require\('\.\.\/src\/utils\/memberNames'\)/);
  const prefill = require('../config/questionnairePrefillMap');
  const fields = prefill.buildMemberFields({ role: 'Spouse', name: 'Spouse (added by staff)', memberKey: 'spouse', flags: {} });
  assert.ok(!JSON.stringify(fields).includes('added by staff'), 'the placeholder is never pre-filled into a name field');
  const named = prefill.buildMemberFields({ role: 'Spouse', name: 'Priya Singla', memberKey: 'spouse', flags: {} });
  assert.ok(JSON.stringify(named).includes('Priya') || JSON.stringify(named).includes('Singla'), 'a real name still pre-fills');
  assert.match(fs.readFileSync(require.resolve('../src/services/sponsorOnboardingService.js'), 'utf8'), /require\('\.\.\/utils\/memberNames'\)\.isPlaceholderName\(name\)/);
  assert.match(fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8'), /const \{ isPlaceholderName \} = require\('\.\.\/utils\/memberNames'\);/);
  // the type words and the consultant's placeholder are placeholders too; a real name that merely contains one is not
  for (const n of ['Spouse', 'spouse / common-law partner', 'Child 2', 'Dependent Child 1', 'Sponsor', 'Spouse (consultant-set)']) assert.equal(isPlaceholderName(n), true, n);
  for (const n of ['Childs Rebecca', 'Sponsorship Ltd', 'Spouse Priya']) assert.equal(isPlaceholderName(n), false, n);
});
