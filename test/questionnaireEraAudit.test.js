'use strict';

// Read-only era audit (step 2 of the 2026-CEC-EE-077 work): the sweep that says
// WHICH cases the April/August flip touched. The endpoint only reads — it must
// never seed a member manifest (loadMembers does) and never write a file.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const svc = require('../src/services/htmlQuestionnaireService');
const { LEGACY_FORM_FILES } = require('../config/questionnaireFormMap');

const AUG1 = '1. Express Entry - PNP - PR Application -  Questionnaire - August 2026.html';
const APR1 = LEGACY_FORM_FILES[AUG1];
const F6   = '6. Express Entry Profile - PNP Profile Creation - Questionnair - July 2025.html';
const slot = (o) => ({ formKey: 'primary', formFile: AUG1, recorded: null, verdict: 'unknown', clientAnswers: 0, keptAside: 0, ...o });

test('a healthy August case raises nothing', () => {
  const f = svc.eraAuditFlags({ forms: { primary: AUG1, additional: null }, resolved: { primary: AUG1, additional: null },
    slots: [slot({ recorded: AUG1, verdict: 'current', clientAnswers: 120 })] });
  assert.deepEqual([f.flipped, f.unrecordedAnswers, f.keptAside, f.severity], [false, 0, 0, 'none']);
  assert.deepEqual(f.slotsWithAnswers, ['primary']);
});

test('answers with no era record are worth watching, even before anything flips', () => {
  const f = svc.eraAuditFlags({ forms: { primary: AUG1, additional: null }, resolved: { primary: AUG1, additional: null },
    slots: [slot({ clientAnswers: 90, verdict: 'current' })] });
  assert.deepEqual([f.flipped, f.unrecordedAnswers, f.severity], [false, 1, 'watch']);
});

test('a case being served April is flagged — and worse when its own labels say August', () => {
  const served = { forms: { primary: AUG1, additional: null }, resolved: { primary: APR1, additional: null } };
  assert.equal(svc.eraAuditFlags({ ...served, slots: [slot({ clientAnswers: 50, verdict: 'legacy' })] }).severity, 'flipped');
  assert.equal(svc.eraAuditFlags({ ...served, slots: [slot({ clientAnswers: 50, verdict: 'current' })] }).severity, 'flipped-wrongly');
});

test('answers already parked in the kept-aside list outrank everything (2026-CEC-EE-077 itself)', () => {
  const f = svc.eraAuditFlags({ forms: { primary: AUG1, additional: null }, resolved: { primary: APR1, additional: null },
    slots: [slot({ recorded: APR1, verdict: 'legacy', clientAnswers: 400, keptAside: 37 })] });
  assert.deepEqual([f.severity, f.keptAside, f.servedEdition], ['answers-parked', 37, APR1]);
});

test('slots of forms without editions (the Express Entry profile form) are ignored', () => {
  const f = svc.eraAuditFlags({ forms: { primary: F6, additional: AUG1 }, resolved: { primary: F6, additional: AUG1 },
    slots: [slot({ formKey: 'primary', formFile: F6, clientAnswers: 200, verdict: 'n/a' }),
            slot({ formKey: 'primary-additional', formFile: AUG1, recorded: AUG1, verdict: 'current', clientAnswers: 10 })] });
  assert.deepEqual([f.flipped, f.unrecordedAnswers, f.severity, f.slotsWithAnswers], [false, 0, 'none', ['primary-additional']]);
  const flip = svc.eraAuditFlags({ forms: { primary: F6, additional: AUG1 }, resolved: { primary: F6, additional: APR1 },
    slots: [slot({ formKey: 'primary-additional', formFile: AUG1, clientAnswers: 10, verdict: 'current' })] });
  assert.equal(flip.severity, 'flipped-wrongly', 'the additional slot counts for the flip too');
});

test('odd input never throws', () => {
  assert.equal(svc.eraAuditFlags({ forms: null, resolved: null, slots: null }).severity, 'none');
  assert.equal(svc.eraAuditFlags({ forms: {}, resolved: {}, slots: [null, {}] }).severity, 'none');
});

test('the endpoint is admin-only and reads only — no manifest seeding, no writes', () => {
  const s = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const i = s.indexOf("app.get('/admin/questionnaire/:caseRef/era-audit'");
  assert.ok(i > 0, 'endpoint exists');
  const block = s.slice(i, s.indexOf('\n});', i));
  assert.match(block, /resolveAdminOrReject\(req, res/, 'admin-only');
  assert.match(block, /validateAccessForStaff\(caseRef, \{ skipFormVersioning: true \}\)/);
  assert.match(block, /questionnaire-members-\$\{caseRef\}\.json/, 'reads the manifest file directly');
  assert.doesNotMatch(block, /loadMembers|seedMembersFromBoard/, 'never the seeding reader');
  assert.doesNotMatch(block, /uploadFile|saveFormData|saveMembers|change_multiple_column_values|create_update/, 'writes nothing');
  assert.match(block, /svc\.eraAuditFlags\(/);
});
