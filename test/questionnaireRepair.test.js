'use strict';

// Surgical questionnaire repair (built for the 2026-08 table-key smear class,
// first used on 2026-ISS-009): patch individual answers by section+label,
// refuse ambiguity, dry-run by default, admin-only endpoint.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyFieldPatches } = require('../src/services/htmlQuestionnaireService');

const F = (section, label, value, key = 'k') => ({ section, label, key, value });

test('applyFieldPatches: exact single match applies; result is a new array', () => {
  const fields = [F('S', 'Full Name — Row 1', 'WRONG'), F('S', 'Full Address — Row 1', 'NO.79 X')];
  const { fields: out, applied, errors } = applyFieldPatches(fields, [
    { section: 'S', label: 'Full Name — Row 1', value: 'HARINI SANKAR' },
  ]);
  assert.equal(errors.length, 0);
  assert.deepEqual(applied, [{ section: 'S', label: 'Full Name — Row 1', from: 'WRONG', to: 'HARINI SANKAR' }]);
  assert.equal(out[0].value, 'HARINI SANKAR');
  assert.equal(fields[0].value, 'WRONG', 'input untouched (pure)');
});

test('applyFieldPatches: zero or multiple matches are refused, never guessed', () => {
  const fields = [F('S', 'DOB', 'a'), F('S', 'DOB', 'b')];
  const r1 = applyFieldPatches(fields, [{ section: 'S', label: 'DOB', value: 'x' }]);
  assert.equal(r1.applied.length, 0);
  assert.match(r1.errors[0].reason, /2 fields match/);
  const r2 = applyFieldPatches(fields, [{ section: 'S', label: 'Nope', value: 'x' }]);
  assert.match(r2.errors[0].reason, /no field matches/);
});

test('applyFieldPatches: expect guards against racing a client save', () => {
  const fields = [F('S', 'Country — Row 1', 'LABORATORY ENGINEER')];
  const bad = applyFieldPatches(fields, [{ section: 'S', label: 'Country — Row 1', value: 'INDIA', expect: 'SOMETHING ELSE' }]);
  assert.equal(bad.applied.length, 0);
  assert.match(bad.errors[0].reason, /does not match expected/);
  const good = applyFieldPatches(fields, [{ section: 'S', label: 'Country — Row 1', value: 'INDIA', expect: 'LABORATORY ENGINEER' }]);
  assert.equal(good.errors.length, 0);
  assert.equal(good.fields[0].value, 'INDIA');
});

test('repair + version-content endpoints are admin/case gated, repair is all-or-nothing', () => {
  const s = require('fs').readFileSync(require.resolve('../src/server'), 'utf8');
  const rIdx = s.indexOf("app.post('/admin/questionnaire/:caseRef/repair'");
  const cIdx = s.indexOf("app.get('/admin/questionnaire/:caseRef/versions/:versionId/content'");
  assert.ok(rIdx > 0 && cIdx > 0);
  const rBlock = s.slice(rIdx, rIdx + 2200);
  const cBlock = s.slice(cIdx, cIdx + 900);
  assert.match(rBlock, /resolveCaseForWrite\(req, res, caseRef\)/);
  assert.match(rBlock, /ctx\.viewer\.isAdmin/, 'repair is admin-only');
  assert.match(rBlock, /dryRun = true/, 'dry-run is the default');
  assert.match(rBlock, /nothing was written/, 'any patch error aborts the whole write');
  assert.match(cBlock, /resolveCaseForWrite\(req, res, caseRef\)/, 'version content read is case-gated');
});
