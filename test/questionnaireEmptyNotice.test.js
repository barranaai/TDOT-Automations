'use strict';

// An empty questionnaire is not an access problem (Faran 2026-10-30): the staff
// review page and the PDF export show a calm "Nothing to review yet" notice;
// real permission errors keep the 🔒 "Access Denied" page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const svc = require('../src/services/htmlQuestionnaireService');

test('a real error still reads "Access Denied" with the lock', () => {
  const html = svc.buildErrorPage('You are not assigned to this case, so you cannot view it.');
  assert.ok(html.includes('<h1>Access Denied</h1>'));
  assert.ok(html.includes('🔒'));
  assert.ok(html.includes('<title>Access Error</title>'));
});

test('a notice has its own calm heading, no lock, and escapes the heading', () => {
  const html = svc.buildErrorPage('The client has not started the questionnaire yet.', { notice: true, title: 'Nothing to review yet' });
  assert.ok(html.includes('<h1>Nothing to review yet</h1>'));
  assert.ok(!html.includes('Access Denied'));
  assert.ok(!html.includes('🔒'));
  assert.ok(svc.buildErrorPage('x', { notice: true, title: '<b>' }).includes('<h1>&lt;b&gt;</h1>'));
});

test('every empty-questionnaire page uses the notice, never "Access Denied"', () => {
  const src = fs.readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm'), 'utf8');
  for (const t of ['Nothing to review yet', 'No answers yet', 'Nothing to export yet']) assert.ok(src.includes(t), t);
  assert.ok((src.match(/notice: true/g) || []).length >= 3);
  assert.ok(!src.includes('No submitted data found for this case'), 'old wording gone');
  assert.ok(src.includes('Resend portal access email') && src.includes('🏠 Client portal'), 'points staff to the resend button');
  assert.ok(!/The client has not (started|answered)/.test(src), 'never claims the client did nothing — only that no answers were saved');
});
