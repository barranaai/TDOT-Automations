'use strict';

// On a Super Visa the applicants are the parents: the principal applicant's
// spouse is the SECOND PARENT, the child in Canada the sponsor. The data stays
// what it is (a "Spouse" row, a "Spouse / Common-Law Partner" member, the
// schema's Spouse role); every page now calls it "Second parent" / "First
// parent" (2026-10-25 — staff read "Spouse" as the daughter's husband and
// picked "Parent", which has no Super Visa documents).

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');

const L = require('../src/utils/familyRoleLabels');

test('roleLabel: every vocabulary of "the principal applicant\'s spouse" reads "Second parent" on a Super Visa, the principal "First parent"; others and other case types unchanged', () => {
  for (const ct of ['Supervisa', 'Super Visa', ' super visa ', 'SUPERVISA']) {
    assert.equal(L.roleLabel(ct, 'Spouse'), 'Second parent', ct);
    assert.equal(L.roleLabel(ct, 'Spouse / Common-Law Partner'), 'Second parent');
    assert.equal(L.roleLabel(ct, 'Dependent Spouse (Parent)'), 'Second parent');
    assert.equal(L.roleLabel(ct, 'PrincipalApplicant'), 'First parent (principal applicant)');
    assert.equal(L.roleLabel(ct, 'Principal Applicant'), 'First parent (principal applicant)');
    assert.equal(L.roleLabel(ct, 'Principal Applicant (Parent)'), 'First parent (principal applicant)');
  }
  for (const role of ['Sponsor', 'Sponsor / Inviter (in Canada)', 'Dependent Child', 'Parent', 'Sibling', 'Worker Spouse', 'Non Accompanying Spouse', 'Non-Accompanying Spouse', '', null]) {
    assert.equal(L.roleLabel('Supervisa', role), '', String(role));
  }
  for (const ct of ['Visitor Visa', 'BOWP', 'Canadian Experience Class (EE after ITA)', '', null]) {
    assert.equal(L.roleLabel(ct, 'Spouse'), '', String(ct));
    assert.equal(L.roleLabel(ct, 'PrincipalApplicant'), '');
  }
  assert.equal(L.roleLabelOr('Supervisa', 'Spouse', 'Spouse'), 'Second parent');
  assert.equal(L.roleLabelOr('BOWP', 'Spouse', 'Spouse'), 'Spouse');
});

test('decorateMembers: a badge on the second parent, default labels replaced, a real name kept; other case types untouched', () => {
  const members = [
    { key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' },
    { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Meena Sharma' },
    { key: 'sponsor', type: 'Sponsor', label: 'Mehak' },
  ];
  const d = L.decorateMembers('Supervisa', members);
  assert.deepEqual(d.map((m) => [m.label, m.badge || '']), [['First parent (principal applicant)', ''], ['Meena Sharma', 'Second parent'], ['Mehak', '']]);
  assert.equal(L.decorateMembers('Supervisa', [{ key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Spouse' }])[0].label, 'Second parent', 'the default label too');
  assert.equal(L.decorateMembers('Supervisa', [{ key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Spouse 2' }])[0].label, 'Second parent');
  assert.equal(L.decorateMembers('BOWP', members), members, 'other case types: the same array back');
  assert.equal(L.decorateMembers('Supervisa', null), null);
  assert.equal(members[0].label, 'Primary Applicant', 'never changed in place');
  assert.equal(L.decorateMembers('Supervisa', [{ key: 'primary', type: 'Principal Applicant', label: 'Principal Applicant' }])[0].label, 'First parent (principal applicant)', 'either default spelling of the principal');
});

test('memberTypeOfLabel: exactly the four Super Visa names stand for a type; any other label — the Visitor Visa schema\'s own "Second Parent" above all — stands for nothing', () => {
  assert.equal(L.memberTypeOfLabel('Second parent'), 'Spouse / Common-Law Partner');
  assert.equal(L.memberTypeOfLabel('Second grandparent'), 'Spouse / Common-Law Partner');
  assert.equal(L.memberTypeOfLabel('First parent (principal applicant)'), 'Principal Applicant');
  assert.equal(L.memberTypeOfLabel('First grandparent (principal applicant)'), 'Principal Applicant');
  assert.equal(L.memberTypeOfLabel(' Second parent '), 'Spouse / Common-Law Partner', 'trimmed');
  for (const other of ['Second Parent', 'second parent', 'Second parent 2', 'First parent', 'Principal Applicant (Parent)', 'Spouse', 'Dependent Spouse', '', null, undefined]) {
    assert.equal(L.memberTypeOfLabel(other), '', String(other));
  }
  const vv = require('../src/data/caseSchemas/visitor-visa-parents-siblings');
  assert.equal(vv.roles.find((r) => r.role === 'Spouse').label, 'Second Parent', 'the Visitor Visa label this must never match');
});

test('Grandparents sub type: "Second grandparent" / "First grandparent (principal applicant)" — the helper, the schema, the case page rule', () => {
  assert.equal(L.who('Grandparents'), 'grandparent'); assert.equal(L.who('Parents'), 'parent'); assert.equal(L.who(''), 'parent');
  assert.equal(L.roleLabel('Supervisa', 'Spouse', 'Grandparents'), 'Second grandparent');
  assert.equal(L.roleLabel('Supervisa', 'PrincipalApplicant', 'Grandparents'), 'First grandparent (principal applicant)');
  assert.equal(L.roleLabel('Supervisa', 'Spouse', 'Parents'), 'Second parent');
  assert.equal(L.roleLabelOr('Supervisa', 'Spouse', 'Spouse', 'Grandparents'), 'Second grandparent');
  assert.equal(L.roleLabel('BOWP', 'Spouse', 'Grandparents'), '', 'the sub type never makes a non-Super-Visa special');
  const d = L.decorateMembers('Supervisa', [{ key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Spouse' }, { key: 'primary', type: 'Principal Applicant', label: 'Primary Applicant' }], 'Grandparents');
  assert.deepEqual(d.map((m) => [m.label, m.badge]), [['Second grandparent', 'Second grandparent'], ['First grandparent (principal applicant)', '']]);
  const g = require('../src/data/caseSchemas/supervisa-grandparents');
  assert.deepEqual(['PrincipalApplicant', 'Spouse'].map((r) => g.roles.find((x) => x.role === r).label), ['First grandparent (principal applicant)', 'Second grandparent']);
  const docSvc = require('../src/services/documentFormService');
  assert.equal(docSvc.applicantLabelFor({ intakeId: '18401700001', templateApplicantType: 'Spouse / Common-Law Partner', caseType: 'Supervisa', subType: 'Grandparents' }).applicantLabel, 'Second grandparent');
});

test('the Super Visa checklist schemas carry the display labels; upload file names still use the role, not the label', () => {
  const css = require('../src/services/caseSchemaService');
  const p = css.lookup('Supervisa', 'Parents'), g = css.lookup('Supervisa', 'Grandparents');
  assert.deepEqual(p.roles.map((r) => [r.role, r.label]), [['PrincipalApplicant', 'First parent (principal applicant)'], ['Spouse', 'Second parent'], ['Sponsor', 'Sponsor / Inviter (in Canada)']]);
  assert.deepEqual(g.roles.map((r) => [r.role, r.label]), [['PrincipalApplicant', 'First grandparent (principal applicant)'], ['Spouse', 'Second grandparent'], ['Sponsor', 'Sponsor / Inviter (in Canada)']]);
  const naming = require('../src/utils/uploadNaming');
  const docSvc = require('../src/services/documentFormService');
  const spouse = docSvc.applicantLabelFor({ intakeId: 'code:SUPERVISA-PARENTS-SPOUSE-PASSPORT-001' });
  const pa = docSvc.applicantLabelFor({ intakeId: 'code:SUPERVISA-PARENTS-PRINCIPALAPPLICANT-PASSPORT-001' });
  assert.deepEqual([spouse.applicantLabel, pa.applicantLabel], ['Second parent', 'First parent (principal applicant)'], 'what the client document pages show');
  assert.deepEqual([naming.memberSegment(spouse), naming.memberSegment(pa)], ['Spouse', 'PA'], 'file names unchanged');
  // an older Template-built Super Visa case (2026-SV-004): the row's own type, named for the case type
  assert.equal(docSvc.applicantLabelFor({ intakeId: '18401700001', templateApplicantType: 'Spouse / Common-Law Partner', caseType: 'Supervisa' }).applicantLabel, 'Second parent');
  assert.equal(docSvc.applicantLabelFor({ intakeId: '18401700001', templateApplicantType: 'Spouse / Common-Law Partner', caseType: 'BOWP' }).applicantLabel, 'Spouse / Common-Law Partner');
  assert.equal(docSvc.applicantLabelFor({ intakeId: '18401700001', templateApplicantType: 'Spouse / Common-Law Partner' }).applicantLabel, 'Spouse / Common-Law Partner', 'no case type given: as before');
});

test('the case page: the family card, the add dialog and the questionnaire list say "Second parent" on a Super Visa — the page\'s own rule matches the server helper on every input', () => {
  const html = require('../src/routes/adminCase').buildCockpitHTML('2026-SV-021');
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi).map((s) => s.replace(/^<script[^>]*>|<\/script>$/gi, '')).find((s) => s.includes('function svRole('));
  assert.ok(js, 'the cockpit script defines svRole');
  const a = js.indexOf('var ROLE_LABEL = {'), b = js.indexOf('function statusTag(');
  const ctx = vm.runInNewContext(js.slice(a, b) + '\n;({ svRole, roleName, set: function (ct, st) { CASE_TYPE = ct; CASE_SUB_TYPE = st || \'\'; } })', {});
  const inputs = ['Spouse', 'Spouse / Common-Law Partner', 'PrincipalApplicant', 'Principal Applicant', 'Sponsor', 'DependentChild', 'Parent', 'Worker Spouse', 'Non Accompanying Spouse', ''];
  for (const ct of ['Supervisa', 'Super Visa', 'BOWP', '']) {
    ctx.set(ct);
    for (const r of inputs) assert.equal(ctx.svRole(r), L.roleLabel(ct, r), `${ct} / ${r}`);
  }
  ctx.set('Supervisa');
  assert.equal(ctx.roleName('Spouse'), 'Second parent'); assert.equal(ctx.roleName('PrincipalApplicant'), 'First parent (principal applicant)'); assert.equal(ctx.roleName('DependentChild'), 'Dependent child');
  ctx.set('BOWP'); assert.equal(ctx.roleName('Spouse'), 'Spouse');
  ctx.set('Supervisa', 'Grandparents'); assert.equal(ctx.svRole('Spouse'), 'Second grandparent'); assert.equal(ctx.svRole('Principal Applicant'), L.roleLabel('Supervisa', 'Principal Applicant', 'Grandparents'));
  ctx.set('BOWP', 'Grandparents'); assert.equal(ctx.svRole('Spouse'), '');
  assert.match(js, /CASE_TYPE = d\.caseType \|\| ''; CASE_SUB_TYPE = d\.caseSubType \|\| '';/, 'set from the payload before the family card renders');
  assert.equal((js.match(/escHtml\(m\.badge \|\| m\.type \|\| ''\)/g) || []).length, 2, 'the Summary list AND the Questionnaire tab');
  assert.match(js, /escHtml\(it\.applicantLabel \|\| it\.applicantType\)/, 'the Documents card shows the member as named');
  assert.match(js, /svRole\(j\.memberType\) \|\| String\(j\.memberType \|\| 'a family member'\)\.split\(' \/ '\)\[0\]/, 'the "other add" message');
  assert.match(js, /escHtml\(svRole\(t\) \|\| t\.split\(' \/ '\)\[0\]\)/, 'the add dialog option');
  assert.match(js, /escHtml\(m\.badge \|\| m\.type \|\| ''\)/, 'the questionnaire members list');
  assert.match(require('fs').readFileSync(require.resolve('../src/services/caseCockpitService.js'), 'utf8'), /decorateMembers\(caseType, qMembers, caseSubType\)/);
  // the cockpit's document summary carries the shown name beside the type key
  const { summariseDocuments } = require('../src/services/caseCockpitService');
  const sum = summariseDocuments([
    { id: '1', name: 'Passport', status: 'Pending', category: 'Identity', applicantType: 'Spouse / Common-Law Partner', applicantLabel: 'Second parent' },
    { id: '2', name: 'Passport', status: 'Pending', category: 'Identity', applicantType: 'Principal Applicant', applicantLabel: 'First parent (principal applicant)' },
    { id: '3', name: 'Letter', status: 'Rework', category: 'Other', applicantType: 'Sponsor', applicantLabel: 'Sponsor / Inviter (in Canada)', reworkNote: 'x' },
  ]);
  assert.deepEqual(sum.byMember.map((m) => [m.member, m.applicantType]), [['Second parent', 'Spouse / Common-Law Partner'], ['First parent (principal applicant)', 'Principal Applicant'], ['Sponsor / Inviter (in Canada)', 'Sponsor']].slice().sort((x, y) => sum.byMember.findIndex((m) => m.applicantType === x[1]) - sum.byMember.findIndex((m) => m.applicantType === y[1])));
  assert.ok(sum.byMember.every((m) => m.applicantType !== m.member), 'every member shown by its name, keyed by its type');
  assert.equal(sum.byCategory.flatMap((c) => c.items).find((i) => i.id === '1').applicantLabel, 'Second parent');
  assert.equal(summariseDocuments([{ id: '9', name: 'X', status: 'Pending', applicantType: 'Spouse / Common-Law Partner' }]).byMember[0].member, 'Spouse / Common-Law Partner', 'no label: the type, as before');
});

test('the questionnaire pages: the badge comes from the server on a Super Visa (client and review engines), and the routes decorate the members', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');
  assert.match(src, /typeBadge\.textContent = member\.badge \|\| member\.type\.split\(' \/ '\)\[0\];/);
  assert.match(src, /typeBadge\.textContent = m\.badge \|\| m\.type\.split\(' \/ '\)\[0\];/);
  const route = require('fs').readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm.js'), 'utf8');
  assert.match(route, /members:\s+hasMembers \? require\('\.\.\/utils\/familyRoleLabels'\)\.decorateMembers\(caseType, withStatuses, caseSubType\) : undefined,/);
  assert.match(route, /members:\s+require\('\.\.\/utils\/familyRoleLabels'\)\.decorateMembers\(caseType, allMembersData, caseSubType\),/);
  assert.match(src, /var REVIEW_MEMBERS = \$\{jsEmbed\(isMultiMember \? members\.map\(m => \(\{ key: m\.key, type: m\.type, badge: m\.badge \|\| '', label: m\.label,/, 'the review engine is handed the badge');
  // a Super Visa page with two parents shows the badges
  const svc = require('../src/services/htmlQuestionnaireService');
  const members = L.decorateMembers('Supervisa', [{ key: 'primary', type: 'Principal Applicant', label: 'Principal Applicant' }, { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Meena Sharma' }]);
  const page = svc.buildFormPage({ formFile: '11. Super Visa - Outside  - Questionnaires - April 2025.html', caseRef: 'ZZ-TEST', token: 't', formKey: 'primary', formTitle: 'x', hasAdditionalForm: false, overviewUrl: '', members, allowedMemberTypes: [] });
  assert.match(page, /"badge":"Second parent"/); assert.match(page, /"label":"First parent \(principal applicant\)"/);
  // the staff review page shows the same badge
  const rpage = svc.buildReviewFormPage({ formFile: '11. Super Visa - Outside  - Questionnaires - April 2025.html', caseRef: 'ZZ-TEST', formKey: 'primary', staffName: 'S', savedFields: [], savedFlags: {}, members });
  assert.match(rpage, /"badge":"Second parent"/); assert.match(rpage, /"label":"First parent \(principal applicant\)"/);
  // the emails and notes name the member the same way
  assert.match(route, /decorateMembers\(caseDetails\.caseType, await svc\.loadMembers\(\{ clientName, caseRef \}\), caseDetails\.caseSubType\)/, 'the consolidated correction email');
  assert.match(route, /memberLabel = \(mk === 'primary' && shown === String\(member\.label \|\| ''\)\) \? '' : shown;/, 'the single correction email');
  assert.match(route, /sendCorrectionEmail\(\{\s+caseRef,\s+formKey:\s+key,\s+caseDetails,\s+memberLabel,/);
  assert.match(src, /await markMemberSubmitted\(\{ clientName, caseRef, memberKey \}\);\n[^\n]*\n\s+members = require\('\.\.\/utils\/familyRoleLabels'\)\.decorateMembers\(caseType, await loadMembers\(\{ clientName, caseRef \}\), caseSubType\);/, 'the single-member submission note');
  assert.match(src, /let members = \[\];\n\s+try \{\n\s+members = require\('\.\.\/utils\/familyRoleLabels'\)\.decorateMembers\(caseType, await loadMembers\(\{ clientName, caseRef \}\), caseSubType\);/, 'the all-members submission note');
  assert.match(route, /markSubmitted\(\{ itemId, caseRef, caseType, caseSubType, formKey: key,/); assert.match(route, /itemId, caseRef, caseType, caseSubType, formLabel: formTitle, clientName, formFiles,/);
  assert.match(route, /exportCasePdf\(\{\s+clientName, caseRef, formFiles, formKey, caseType, caseSubType,/, 'the PDF cover');
  const rev = require('../src/services/htmlQuestionnaireReviewService');
  assert.match(require('fs').readFileSync(require.resolve('../src/services/htmlQuestionnaireReviewService.js'), 'utf8'), /const memberLabel = typeof shownLabel === 'string' \? shownLabel\n\s+: memberKey !== 'primary'/);
  assert.ok(rev.sendCorrectionEmail, 'exported');
});

test('the add-member note uses the Super Visa name, the default section label is NOT persisted; other case types as before', async () => {
  const fam = require('../src/services/familyMemberService');
  const real = { ...fam.io };
  const calls = { notes: [], adds: [] };
  fam._recentRows.clear();
  Object.assign(fam.io, {
    carryOver: async () => ({ copied: 0, total: 0, bySection: {}, unmapped: [], skippedSharedTable: 0, pct: 0, source: '', target: '', written: false, skipped: 'nothing' }),
    boardRows: async () => ({ rows: [], members: [] }),
    manifest: async () => [{ key: 'primary', type: 'Principal Applicant' }],
    addManifestMember: async (a) => { calls.adds.push(a); return { key: a.key, type: a.memberType, label: a.label || 'Spouse' }; },
    createManifest: async () => ({ members: [], created: true }),
    checklistShape: async () => ({ schema: ['SUPERVISA-PARENTS-PRINCIPALAPPLICANT-PASSPORT-001'], templateRows: 0 }),
    createRow: async () => 'row-1',
    caseState: async () => ({ stage: 'Document Collection Started', payment: 'Paid', checklistApplied: 'Yes', caseType: 'Supervisa', subType: 'Parents', qStatus: 'Working on it' }),
    migrateOn: () => true,
    reseed: async () => ({ created: 9, skipped: 16, failed: 0, pruned: 0 }),
    postNote: async (itemId, body) => { calls.notes.push(body); },
    now: () => 1_000_000,
  });
  try {
    await fam.addFamilyMember({ caseRef: '2026-SV-099', cmItemId: '1', clientName: 'X', boardType: 'Spouse', source: 'staff', actor: { name: 'Gauri Berde' }, caseType: 'Supervisa', caseSubType: 'Parents' });
    assert.equal(calls.adds[0].label, undefined, 'no name typed: NO label is stored — the pages name the member (a stored "Second parent" is not a placeholder the app recognises)');
    assert.match(calls.notes[0], /👪 <b>Family member added<\/b> — Second parent "Spouse \(added by staff\)"/);
    calls.adds.length = 0; calls.notes.length = 0; fam._recentRows.clear();
    await fam.addFamilyMember({ caseRef: '2026-SV-099', cmItemId: '1', clientName: 'X', boardType: 'Spouse', name: 'Meena Sharma', source: 'staff', actor: { name: 'Gauri Berde' }, caseType: 'Supervisa', caseSubType: 'Parents' });
    assert.equal(calls.adds[0].label, 'Meena Sharma', 'a typed name wins');
    assert.match(calls.notes[0], /— Second parent "Meena Sharma" —/);
    // a second parent already on the case: the refusal says so in the same words
    fam._recentRows.clear();
    fam.io.manifest = async () => [{ key: 'primary', type: 'Principal Applicant' }, { key: 'spouse', type: 'Spouse / Common-Law Partner', label: 'Meena Sharma' }];
    fam.io.boardRows = async () => ({ rows: [{ boardType: 'Spouse', memberKey: 'spouse', name: 'Meena Sharma' }], members: [{ role: 'Spouse', name: 'Meena Sharma', memberKey: 'spouse', flags: {} }] });
    await assert.rejects(fam.addFamilyMember({ caseRef: '2026-SV-098', cmItemId: '2', clientName: 'X', boardType: 'Spouse', source: 'staff', actor: { name: 'G' }, caseType: 'Supervisa', caseSubType: 'Parents' }), /A second parent is already on this case\./);
    fam._recentRows.clear();
    await assert.rejects(fam.addFamilyMember({ caseRef: '2026-SV-097', cmItemId: '3', clientName: 'X', boardType: 'Spouse', source: 'staff', actor: { name: 'G' }, caseType: 'Supervisa', caseSubType: 'Grandparents' }), /A second grandparent is already on this case\./);
    fam._recentRows.clear();
    await assert.rejects(fam.addFamilyMember({ caseRef: '2026-BOWP-097', cmItemId: '4', clientName: 'X', boardType: 'Spouse', source: 'staff', actor: { name: 'G' }, caseType: 'BOWP' }), /A spouse is already on this case\./);
  } finally { Object.assign(fam.io, real); fam._recentRows.clear(); }
  const srv = require('fs').readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.match(srv, /caseType: ctx\.overview\.caseType \|\| '', caseSubType: ctx\.overview\.caseSubType \|\| '',/, 'the cockpit route passes the case type');
  const q = require('fs').readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm.js'), 'utf8');
  assert.match(q, /reseedMode: 'background', caseType: caseType \|\| '', caseSubType: caseSubType \|\| '',/, 'the client route too');
});
