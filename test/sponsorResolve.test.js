'use strict';

// Sponsor onboarding — resolveSponsor is PURE: who the sponsor is, what the
// schema wants from them, and how the questionnaire places them. Driven with
// the REAL schemas (caseSchemaService) and the REAL form map, so a schema or
// form-map edit that moves a case type between modes fails here.

const test   = require('node:test');
const assert = require('node:assert/strict');

const S   = require('../src/services/sponsorOnboardingService');
const reg = require('../src/services/caseSchemaService');
const { resolveMemberTypes, formEmbedsMembers } = require('../config/questionnaireFormMap');

const LEAD = (over = {}) => ({ id: '9001', fullName: 'Aisha Khan', inviterName: 'Faheem Khan', inviterEmail: 'faheem@example.com', ...over });

function resolve(caseType, caseSubType, over = {}) {
  return S.resolveSponsor({
    claimants: [LEAD()], clientEmail: 'aisha@example.com', caseType, caseSubType,
    schema: reg.lookup(caseType, caseSubType),
    memberTypes: resolveMemberTypes(caseType, caseSubType),
    embedsAllMembers: formEmbedsMembers(caseType, caseSubType),
    ...over,
  });
}

// ─── The result table (§1 step 7) ─────────────────────────────────────────────

const OK = [
  // caseType, subType, role, roleLabel, docs, sectionMode, boardType, memberKey, manifestType, isSpouse
  ['SOWP', 'Outland (Spouse or Child)',             'Sponsor', 'Worker Spouse',                 5, 'section',        'Sponsor', 'sponsor', 'Sponsor',                     true],
  ['SOWP', 'Inland - Established Relationship',     'Spouse',  'Worker Spouse',                 4, 'section',        'Spouse',  'spouse',  'Spouse / Common-Law Partner', true],
  ['SOWP', 'Inland - Non Established Relationship', 'Spouse',  'Worker Spouse',                 5, 'section',        'Spouse',  'spouse',  'Spouse / Common-Law Partner', true],
  ['SCLPC WP', '',                                  'Sponsor', 'Sponsoring Spouse',             3, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     true],
  ['Supervisa', 'Parents',                          'Sponsor', 'Sponsor / Inviter (in Canada)', 7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     false],
  ['Supervisa', 'Grandparents',                     'Sponsor', 'Sponsor / Inviter (in Canada)', 7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     false],
  ['Visitor Visa', 'Spouse',                        'Sponsor', 'Inviter (Spouse in Canada)',    7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     true],
  ['Visitor Visa', 'Spousal Sponsorship in Process','Sponsor', 'Inviter (Spouse in Canada)',    7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     true],
  ['Visitor Visa', 'Both Parents',                  'Sponsor', 'Inviter — Child in Canada',     7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     false],
  ['Visitor Visa', 'Single Parent',                 'Sponsor', 'Inviter — Child in Canada',     7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     false],
  ['Visitor Visa', '1-2 Members',                   'Sponsor', 'Inviter (in Canada)',           7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     false],
  ['Visitor Visa', '1-3 Members',                   'Sponsor', 'Inviter (in Canada)',           7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     false],
  ['Visitor Visa', 'Parents & Siblings',            'Sponsor', 'Inviter (in Canada)',           7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     false],
  ['Visitor Record / Extension', 'Visitor Record',  'Sponsor', 'Inviter / Sponsor',             7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     false],
  ['Visitor Record / Extension', 'Visitor Extension','Sponsor','Inviter / Sponsor',             7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                     false],
  ['Visitor Record / Extension', 'Visitor Record + Restoration', 'Sponsor', 'Inviter / Sponsor', 7, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',                  false],
  ['Inland Spousal Sponsorship', 'Marriage',        'Sponsor', 'Sponsor (Canadian/PR Spouse)',  6, 'shared-form',    'Sponsor', 'sponsor', 'Sponsor',                     true],
  ['Inland Spousal Sponsorship', 'Common Law Partner','Sponsor','Sponsor (Canadian/PR Partner)',6, 'shared-form',    'Sponsor', 'sponsor', 'Sponsor',                     true],
  ['Outland Spousal Sponsorship', '',               'Sponsor', 'Sponsor (Canadian/PR Spouse)',  6, 'shared-form',    'Sponsor', 'sponsor', 'Sponsor',                     true],
  ['Parents/Grandparents Sponsorship', '',          'Sponsor', 'Sponsor — Child inside Canada (co-signer)', 5, 'documents-only', 'Sponsor', 'sponsor', 'Sponsor',        false],
];
for (const [ct, st, role, label, docs, mode, boardType, memberKey, manifestType, isSpouse] of OK) {
  test(`${ct} / ${st || '(no sub type)'} → ok: ${role} "${label}", ${docs} docs, ${mode}`, () => {
    const r = resolve(ct, st);
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.equal(r.role, role);
    assert.equal(r.roleLabel, label);
    assert.equal(r.docs.length, docs);
    assert.equal(r.sectionMode, mode);
    assert.equal(r.boardMemberType, boardType);
    assert.equal(r.memberKey, memberKey);
    assert.equal(r.manifestType, manifestType);
    assert.equal(r.sponsorIsSpouse, isSpouse);
    assert.equal(r.name, 'Faheem Khan');
    assert.equal(r.email, 'faheem@example.com');
    assert.equal(r.emailMasked, 'f***@example.com');
    assert.equal(r.leadId, '9001');
    assert.ok(r.docs.every((d) => d.name && d.category), 'every doc carries a name and a category');
  });
}

const NA = [
  ['SOWP', 'Extension (Spouse or Child)'],
  ['NB WP Extension', ''],
  ['Francophone Mobility WP', ''],
  ['Study Permit', 'Non SDS - Accompanying Spouse or Child'],   // includeWhen Sponsor = a funds supporter, not a co-applicant
  ['Study Permit', 'Single Applicant'],
  ['Study Permit', 'Change of Status (Visitor to Student)'],
  ['Canadian Experience Class (EE after ITA)', 'CEC Single Applicant'],
  ['OINP', 'Human Capital Priorities Stream'],
  ['Visitor Visa', 'Change of Status (Student/Worker to Visitor)'],
  ['PGWP', 'Single Applicant'],
  ['TRV', ''],
];
for (const [ct, st] of NA) {
  test(`${ct} / ${st || '(no sub type)'} → not-applicable`, () => {
    const r = resolve(ct, st);
    assert.equal(r.status, 'none');
    assert.equal(r.reason, 'not-applicable');
  });
}

test('every registered schema resolves to ok or not-applicable — never a crash, never an unknown reason', () => {
  for (const { caseType, subType } of reg.listRegistered()) {
    const r = resolve(caseType, subType);
    assert.ok(r.status === 'ok' || r.reason === 'not-applicable', `${caseType}/${subType}: ${JSON.stringify(r)}`);
  }
});

// ─── Identity: the single claiming lead (D1) ──────────────────────────────────

test('0 claimants → no-lead; 2 claimants → shared-case (fail closed, never the first hit)', () => {
  assert.equal(resolve('SOWP', 'Outland (Spouse or Child)', { claimants: [] }).reason, 'no-lead');
  assert.equal(resolve('SOWP', 'Outland (Spouse or Child)', { claimants: null }).reason, 'no-lead');
  const two = resolve('SOWP', 'Outland (Spouse or Child)', { claimants: [LEAD(), LEAD({ id: '9002' })] });
  assert.equal(two.reason, 'shared-case');
  assert.equal(two.claimantCount, 2);
});

test('blank name, "faheem[at]x" and "a b@c.com" → no-inviter', () => {
  assert.equal(resolve('SOWP', 'Outland (Spouse or Child)', { claimants: [LEAD({ inviterName: '  ' })] }).reason, 'no-inviter');
  assert.equal(resolve('SOWP', 'Outland (Spouse or Child)', { claimants: [LEAD({ inviterEmail: 'faheem[at]x' })] }).reason, 'no-inviter');
  assert.equal(resolve('SOWP', 'Outland (Spouse or Child)', { claimants: [LEAD({ inviterEmail: 'a b@c.com' })] }).reason, 'no-inviter');
  assert.equal(resolve('SOWP', 'Outland (Spouse or Child)', { claimants: [LEAD({ inviterEmail: '' })] }).reason, 'no-inviter');
});

test('a U+2060 prefix and a trailing space (the WhatsApp paste) → ok with the CLEAN address', () => {
  const r = resolve('SOWP', 'Outland (Spouse or Child)', { claimants: [LEAD({ inviterName: '⁠Faheem Khan ', inviterEmail: '⁠faheem@example.com ' })] });
  assert.equal(r.status, 'ok');
  assert.equal(r.email, 'faheem@example.com');
  assert.equal(r.name, 'Faheem Khan');
});

test('same address as the client → same-as-client, case-insensitive; skipped when the client email is unknown (null)', () => {
  assert.equal(resolve('SOWP', 'Outland (Spouse or Child)', { clientEmail: 'FAHEEM@Example.com' }).reason, 'same-as-client');
  assert.equal(resolve('SOWP', 'Outland (Spouse or Child)', { clientEmail: null }).status, 'ok');
  assert.equal(resolve('SOWP', 'Outland (Spouse or Child)', { clientEmail: '' }).status, 'ok');
});

test('a case type with no sponsor role is not-applicable even with no lead or no inviter (the cockpit hides the card)', () => {
  assert.equal(resolve('OINP', 'Human Capital Priorities Stream', { claimants: [] }).reason, 'not-applicable');
  assert.equal(resolve('OINP', 'Human Capital Priorities Stream', { claimants: [LEAD({ inviterEmail: '' })] }).reason, 'not-applicable');
});

test('no schema: blank sub type → sub-type-missing; an unknown pair → no-schema', () => {
  assert.equal(resolve('SOWP', '').reason, 'sub-type-missing');
  assert.equal(resolve('SOWP', null).reason, 'sub-type-missing');
  assert.equal(resolve('SOWP', 'Made Up Sub Type').reason, 'no-schema');
});

test('the retainer template (pa vs pa-inviter) plays no part', () => {
  const a = resolve('SOWP', 'Outland (Spouse or Child)', { claimants: [LEAD({ selectedTemplate: 'pa' })] });
  const b = resolve('SOWP', 'Outland (Spouse or Child)', { claimants: [LEAD({ selectedTemplate: 'pa-inviter' })] });
  assert.equal(a.status, 'ok');
  assert.deepEqual(a.docs, b.docs);
});

test('docs exclude includeWhen documents (the name-change affidavit), in schema order', () => {
  const r = resolve('SOWP', 'Inland - Established Relationship');
  assert.ok(!r.docs.some((d) => /affidavit/i.test(d.name)), 'the conditional affidavit is not asked of everyone');
  assert.deepEqual(r.docs.map((d) => d.category), ['Identity', 'Identity', 'Academic', 'Financial']);
  const out = resolve('SOWP', 'Outland (Spouse or Child)');
  assert.deepEqual(out.docs, [
    { name: 'Passport with all stamped pages', category: 'Identity' },
    { name: 'All Permits ever held in Canada', category: 'Other' },
    { name: 'Canadian Education Documents (for each program if studied here)', category: 'Academic' },
    { name: 'Proof/source of Income - Mandatory for Worker Spouse', category: 'Financial' },
    { name: 'Letters, printed text messages, emails, social media conversations and phone records showing regular contact', category: 'Relationship' },
  ]);
});

test('a document with no category reads "Other"', () => {
  const schema = { caseType: 'X', subType: '', roles: [{ role: 'PrincipalApplicant', required: true, documents: [] }, { role: 'Sponsor', label: 'Inviter', required: true, documents: [{ name: 'Thing', code: 'T' }] }] };
  const r = S.resolveSponsor({ claimants: [LEAD()], caseType: 'X', caseSubType: '', schema, memberTypes: [], embedsAllMembers: false });
  assert.deepEqual(r.docs, [{ name: 'Thing', category: 'Other' }]);
  assert.equal(r.sectionMode, 'documents-only');
});

test('an OPTIONAL Sponsor role, a required role of another name, or a Spouse not labelled worker spouse → not-applicable', () => {
  const mk = (roles) => S.resolveSponsor({ claimants: [LEAD()], caseType: 'X', caseSubType: '', schema: { caseType: 'X', subType: '', roles }, memberTypes: ['Sponsor'], embedsAllMembers: false });
  assert.equal(mk([{ role: 'PrincipalApplicant', required: true, documents: [] }, { role: 'Sponsor', includeWhen: { caseFlag: 'supporterIncluded' }, documents: [] }]).reason, 'not-applicable');
  assert.equal(mk([{ role: 'PrincipalApplicant', required: true, documents: [] }, { role: 'WorkerSpouse', required: true, documents: [] }]).reason, 'not-applicable');
  assert.equal(mk([{ role: 'PrincipalApplicant', required: true, documents: [] }, { role: 'Spouse', label: 'Dependent Spouse', required: true, documents: [] }]).reason, 'not-applicable');
  assert.equal(mk([{ role: 'PrincipalApplicant', required: true, documents: [] }, { role: 'Spouse', label: 'Worker Spouse', required: true, documents: [] }]).status, 'ok');
});

test('the section mode follows the form map, not the schema', () => {
  const schema = reg.lookup('SOWP', 'Outland (Spouse or Child)');
  const base = { claimants: [LEAD()], caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', schema };
  assert.equal(S.resolveSponsor({ ...base, memberTypes: ['Worker Spouse', 'Dependent Child'], embedsAllMembers: false }).sectionMode, 'section');
  assert.equal(S.resolveSponsor({ ...base, memberTypes: ['Sponsor'], embedsAllMembers: false }).sectionMode, 'section');
  assert.equal(S.resolveSponsor({ ...base, memberTypes: ['Spouse / Common-Law Partner'], embedsAllMembers: false }).sectionMode, 'documents-only');
  assert.equal(S.resolveSponsor({ ...base, memberTypes: [], embedsAllMembers: false }).sectionMode, 'documents-only');
  assert.equal(S.resolveSponsor({ ...base, memberTypes: ['Sponsor'], embedsAllMembers: true }).sectionMode, 'shared-form');
});

test('a very long inviter name is cut to 80 characters (a Monday item name, an email heading)', () => {
  const r = resolve('SOWP', 'Outland (Spouse or Child)', { claimants: [LEAD({ inviterName: 'A'.repeat(200) })] });
  assert.equal(r.name.length, 80);
});
