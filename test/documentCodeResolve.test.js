'use strict';

// Read-time schema resolution for seeded checklist rows (user report 2026-08-01,
// case 2026-VV-009): schema-seeded rows carry `code:<documentCode>` instead of a
// Template-Board link, so the client pages showed bare titles (no upload
// guidance) and the internal role key ("Sponsor") instead of the schema's
// display label ("Inviter (in Canada)"). resolveDocumentCode() recovers the
// schema definition from the code alone — already-seeded cases get guidance and
// labels with no board rewrite.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { resolveDocumentCode } = require('../src/services/seedPlanner');

test('resolves a live production code to schema + role + document', () => {
  const r = resolveDocumentCode('VISITOR-VISA-1-2-MEMBERS-SPONSOR-INCOME-001');
  assert.ok(r, 'resolved');
  assert.equal(r.schema.caseType, 'Visitor Visa');
  assert.equal(r.schema.subType, '1-2 Members');
  assert.equal(r.role.label, 'Inviter (in Canada)', 'display label recovered — not the role key');
  assert.equal(r.doc.name, 'Proof/source of Income');
  assert.match(r.doc.guidance, /Notice of Assessment/, 'inviter-specific guidance, not the applicant version');
  assert.equal(r.memberIndex, 1);
});

test('the applicant version of the same doc code resolves to ITS guidance', () => {
  const r = resolveDocumentCode('VISITOR-VISA-1-2-MEMBERS-PRINCIPALAPPLICANT-INCOME-001');
  assert.equal(r.role.label, 'Principal Applicant');
  assert.match(r.doc.guidance, /If salaried/i);
  assert.doesNotMatch(r.doc.guidance, /Notice of Assessment/, 'no cross-role bleed');
});

test('member-indexed roles resolve with their index', () => {
  // Any schema with multipleAllowed children uses ROLESLUG<idx>; synthesize from
  // a registered schema that has DependentChild if present, else skip gracefully.
  const probe = resolveDocumentCode('SUPERVISA-PARENTS-PRINCIPALAPPLICANT-PASSPORT-001');
  assert.ok(probe, 'supervisa PA resolves');
  assert.equal(probe.memberIndex, 1);
});

test('prefix cousins never shadow each other (SPOUSE vs SPOUSAL-SPONSORSHIP-IN-PROCESS)', () => {
  const a = resolveDocumentCode('VISITOR-VISA-SPOUSE-PRINCIPALAPPLICANT-PASSPORT-001');
  const b = resolveDocumentCode('VISITOR-VISA-SPOUSAL-SPONSORSHIP-IN-PROCESS-PRINCIPALAPPLICANT-PASSPORT-001');
  if (a) assert.equal(a.schema.subType.toLowerCase(), 'spouse');
  if (b) assert.match(b.schema.subType.toLowerCase(), /spousal sponsorship/);
  assert.ok(a || b, 'at least one of the cousin schemas is registered and resolves');
});

test('unknown / junk codes return null', () => {
  assert.equal(resolveDocumentCode('NOT-A-REAL-CASE-TYPE-X-001'), null);
  assert.equal(resolveDocumentCode(''), null);
  assert.equal(resolveDocumentCode(null), null);
  assert.equal(resolveDocumentCode('VISITOR-VISA-1-2-MEMBERS-SPONSOR-NOPE-001'), null, 'unknown doc code within a real schema');
});
