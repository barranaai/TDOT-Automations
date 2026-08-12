'use strict';

// OINP redesign (client directive 2026-08-11, materials 2026-08-12): Ontario
// retired every legacy OINP stream (2026-05-30) and replaced them with the
// Workforce Priority Stream. NEW cases may only pick the two WPS pathways;
// EXISTING cases on legacy streams keep their checklist, questionnaire and
// disclaimers untouched. These tests pin both sides of that contract.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const NEW_CLIENT = 'Workforce Priority Stream + CEC Profile (New Client)';
const EXISTING   = 'Workforce Priority Stream (Existing Client)';
const LEGACY = ['Foreign Worker Stream', 'Human Capital Priorities Stream', 'In-demand Skills Stream',
  'International Student Stream', 'Masters Graduate Stream', 'PhD Graduate Stream', 'Skilled Trades Stream'];

test('new OINP cases can only choose the two Workforce Priority Stream pathways', () => {
  const { SUB_TYPES_BY_CASE } = require('../config/caseTypes');
  assert.deepEqual(SUB_TYPES_BY_CASE['OINP'], [NEW_CLIENT, EXISTING]);
  for (const old of LEGACY) {
    assert.ok(!SUB_TYPES_BY_CASE['OINP'].includes(old), `${old} must not be offerable to new clients`);
  }
});

test('checklist schemas: both WPS pathways registered, all 7 legacy streams STILL registered', () => {
  const svc = require('../src/services/caseSchemaService');
  for (const st of [NEW_CLIENT, EXISTING]) {
    const s = svc.lookup('OINP', st);
    assert.ok(s, `${st} schema registered`);
    assert.equal(s.roles.find((r) => r.role === 'PrincipalApplicant').documents.length, 9);
    assert.ok(s.roles.find((r) => r.role === 'Spouse'), 'accompanying spouse/partner role');
    assert.ok(s.roles.find((r) => r.role === 'DependentChild').multipleAllowed, 'children under 18, multiple');
    // The EOI-stage list only — the post-invitation Workforce PDF is deliberately unwired.
    assert.ok(s.roles.every((r) => r.documents.every((d) => d.code && d.name && d.category)), 'well-formed docs');
  }
  for (const old of LEGACY) {
    assert.ok(svc.lookup('OINP', old), `legacy "${old}" schema must STAY registered — existing cases depend on it`);
  }
});

test('questionnaires: WPS pathways get the new forms; legacy and blank sub-types keep F6+F1', () => {
  const { resolveForm } = require('../config/questionnaireFormMap');
  const nc = resolveForm('OINP', NEW_CLIENT);
  assert.match(nc.primary, /^19\. Express Entry Profile Creation \+ EOI OINP/);
  assert.equal(nc.additional, null, 'the dependent section lives inside F19 — no separate member form');
  assert.deepEqual(nc.memberTypes, []);
  const ex = resolveForm('OINP', EXISTING);
  assert.match(ex.primary, /^20\. EOI OINP- Existing Client/);
  assert.equal(ex.additional, null);
  // the two shapes every legacy OINP case can have:
  for (const sub of [...LEGACY, '', null]) {
    const r = resolveForm('OINP', sub);
    assert.match(r.primary, /^6\. Express Entry Profile/, `legacy "${sub}" keeps F6`);
    assert.match(r.additional, /^1\. Express Entry - PNP - PR Application/, 'and F1 as the member form');
  }
});

test('the two new questionnaire FORM FILES exist and are non-trivial HTML', () => {
  const { FORMS_DIR, resolveForm } = require('../config/questionnaireFormMap');
  for (const sub of [NEW_CLIENT, EXISTING]) {
    const file = path.join(FORMS_DIR, resolveForm('OINP', sub).primary);
    assert.ok(fs.existsSync(file), `${path.basename(file)} must exist — the map points at it`);
    const html = fs.readFileSync(file, 'utf8');
    assert.ok(html.length > 3000, 'a real form, not a stub');
    assert.ok(html.includes('form-group'), 'house field markup');
    assert.ok(/<label>/.test(html), 'labelled fields (the engine keys on label text)');
  }
});

test('disclaimers: both WPS keys present, all 7 legacy keys untouched', () => {
  const m = require('../src/data/disclaimerMap.json');
  for (const key of [`OINP|${NEW_CLIENT}`, `OINP|${EXISTING}`]) {
    assert.ok(Array.isArray(m[key]) && m[key].length >= 3, `${key} present`);
    assert.ok(m[key].some((l) => /profile creation/i.test(l)), 'tells the client more docs follow after invitation');
  }
  for (const old of LEGACY) {
    assert.ok(Array.isArray(m[`OINP|${old}`]), `legacy disclaimer "OINP|${old}" must stay`);
  }
});

test('the two schemas differ ONLY in sub-type (same EOI document list per the Excel)', () => {
  const svc = require('../src/services/caseSchemaService');
  const a = svc.lookup('OINP', NEW_CLIENT);
  const b = svc.lookup('OINP', EXISTING);
  const docList = (s) => s.roles.map((r) => `${r.role}:${r.documents.map((d) => d.code).join(',')}`).join(' | ');
  assert.equal(docList(a), docList(b));
});
