'use strict';
// The "Submission Ready" email must name a Case Stage the Monday board really has.
// The board has "Application Submitted" and no stage called "Submitted" (read 2026-11-26).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Submission Ready email asks for "Application Submitted", not "Submitted"', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'stageGateService.js'), 'utf8');
  assert.match(src, /update the Case Stage in Monday\.com to <strong>Application Submitted<\/strong>/);
  assert.doesNotMatch(src, /<strong>Submitted<\/strong>/);
});

test('the staff guide no longer says the email asks for "Submitted"', () => {
  const g = fs.readFileSync(path.join(__dirname, '..', 'src', 'staffGuide', 'guide-data.json'), 'utf8');
  assert.doesNotMatch(g, /email (says|calls it|tells the team to set) ['\\"]*Submitted/);
  assert.match(g, /then set Case Stage to \\"Application Submitted\\"\./);
});
