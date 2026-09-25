'use strict';

// Ship review (2026-09-25): the lead lock is held across a Documenso download
// and a OneDrive upload, and three flows every case relies on (Mark paid, the
// sync's Paid upgrade, activation) now wait on it. So every hop under the lock
// must be bounded, the callers must share one give-up budget, and "busy" must
// say what is known. Source pins — the calls themselves are stubbed out of
// every test by the no-network guard.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const read = (p) => fs.readFileSync(require.resolve(p), 'utf8');
const ONEDRIVE  = read('../src/services/oneDriveService.js');
const DOCUMENSO = read('../src/services/documensoService.js');
const MUTEX     = read('../src/services/leadMutex.js');
const MILESTONE = read('../src/services/milestonePaymentService.js');
const UNDO      = read('../src/services/paymentUndoService.js');
const RECON     = read('../src/services/retainerStatusReconciler.js');
const PAYMENT   = read('../src/services/paymentService.js');
const SPONSOR   = read('../src/services/sponsorOnboardingService.js');

test('every Graph call in oneDriveService carries a timeout — uploads 120 s, everything else 30 s', () => {
  assert.match(ONEDRIVE, /const GRAPH_TIMEOUT_MS\s+= 30000;/);
  assert.match(ONEDRIVE, /const GRAPH_UPLOAD_TIMEOUT_MS = 120000;/);
  const calls   = (ONEDRIVE.match(/axios\.(get|post|put|patch|delete)\(/g) || []).length;
  const bounded = (ONEDRIVE.match(/timeout:\s*GRAPH_(UPLOAD_)?TIMEOUT_MS/g) || []).length;
  assert.ok(calls >= 16, `the call sites are still there (${calls})`);
  assert.equal(bounded, calls, 'one timeout per axios call — a new call site without one fails here');
  const uploads = (ONEDRIVE.match(/axios\.put\(/g) || []).length;
  const longOnes = (ONEDRIVE.match(/timeout:\s*GRAPH_UPLOAD_TIMEOUT_MS/g) || []).length;
  assert.equal(longOnes, uploads, 'every PUT (upload) gets the longer budget, nothing else does');
  assert.doesNotMatch(ONEDRIVE, /timeout:\s*\d/, 'no ad-hoc numbers — the two constants only');
});

test('the Documenso fetch is bounded with an AbortSignal — the capture calls it under the lead lock', () => {
  assert.match(DOCUMENSO, /await fetch\(`\$\{c\.baseUrl\}\$\{path\}`, \{ method, headers, body, signal: AbortSignal\.timeout\(60_000\) \}\)/);
  assert.equal((DOCUMENSO.match(/\bfetch\(/g) || []).length, 1, 'one HTTP helper — every Documenso call goes through it');
});

test('one give-up budget: LEAD_LOCK_WAIT_MS from leadMutex is what Mark paid, Undo and the sync wait', () => {
  assert.match(MUTEX, /const LEAD_LOCK_WAIT_MS = 20000;/);
  assert.match(MUTEX, /module\.exports = \{[^}]*LEAD_LOCK_WAIT_MS[^}]*\}/);
  assert.match(MILESTONE, /const MARK_LOCK_WAIT_MS = require\('\.\/leadMutex'\)\.LEAD_LOCK_WAIT_MS;/);
  assert.match(RECON, /const SYNC_LOCK_WAIT_MS = require\('\.\/leadMutex'\)\.LEAD_LOCK_WAIT_MS;/);
  assert.match(UNDO, /const \{ LEAD_LOCK_WAIT_MS \} = require\('\.\/leadMutex'\);/);
  for (const [name, src] of [['milestone', MILESTONE], ['reconciler', RECON], ['undo', UNDO]]) {
    assert.doesNotMatch(src, /LOCK_WAIT_MS = 20000/, `${name}: no private copy of the number`);
  }
});

test('the constants sit where they are read: MARK_LOCK_WAIT_MS above markMilestonePaid’s JSDoc, ADVANCE_LOCK_WAIT_MS above advanceCaseToPaid', () => {
  const mark = MILESTONE.indexOf('const MARK_LOCK_WAIT_MS');
  const doc  = MILESTONE.indexOf('Manually reconcile milestone `index` as paid');
  const fn   = MILESTONE.indexOf('async function markMilestonePaid(');
  assert.ok(mark > 0 && doc > mark && fn > doc, 'constant, then the JSDoc, then the function');

  const adv    = PAYMENT.indexOf('const ADVANCE_LOCK_WAIT_MS = 60000;');
  const advFn  = PAYMENT.indexOf('async function advanceCaseToPaid(');
  const advUse = PAYMENT.indexOf('withLeadLockOrSkip(lead.id, ADVANCE_LOCK_WAIT_MS');
  assert.ok(adv > 0 && advFn > adv && advUse > advFn, 'declared before the function that reads it');
  assert.equal((PAYMENT.match(/ADVANCE_LOCK_WAIT_MS = /g) || []).length, 1);
});

test('"busy" says what is known — five writers hold this lock, not only a signature', () => {
  const wording = /Another change to this client’s record is in progress \(a signature, a payment or the status sync\)\./;
  assert.match(MILESTONE, wording);
  assert.match(UNDO, wording);
  assert.doesNotMatch(MILESTONE, /a signature is being processed/);
  assert.doesNotMatch(UNDO, /a signature is being processed/);
  assert.match(UNDO, /Nothing was changed — try again in a minute\./);
  assert.match(MILESTONE, /Nothing was recorded — try again in a minute\./);
});

test('one Toronto formatter for the notes: utils/torontoTime, re-exported by the sponsor service, used by the undo record', () => {
  const { torontoTime } = require('../src/utils/torontoTime');
  assert.equal(torontoTime(Date.parse('2026-09-24T02:30:00Z')), '23 Sep 2026, 10:30 pm');
  assert.equal(torontoTime(Date.parse('2026-01-15T17:05:00Z')), '15 Jan 2026, 12:05 pm', 'EST in January');
  assert.equal(torontoTime('nope'), '');
  assert.equal(require('../src/services/sponsorOnboardingService').torontoTime, torontoTime, 'the same function, not a copy');
  assert.match(SPONSOR, /const \{ torontoTime \} = require\('\.\.\/utils\/torontoTime'\);/);
  assert.doesNotMatch(SPONSOR, /function torontoTime\(/, 'no second implementation');
  assert.match(UNDO, /const \{ torontoTime \} = require\('\.\.\/utils\/torontoTime'\);/);
  assert.match(UNDO, /const when = `\$\{torontoTime\(Date\.parse\(io\.nowIso\(\)\)\)\} \(Toronto\)`;/);
  assert.doesNotMatch(UNDO, /nowIso\(\)\.slice\(0, 10\)/, 'never the UTC calendar date in a note');
});
