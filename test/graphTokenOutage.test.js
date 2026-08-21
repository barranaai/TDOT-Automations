// Guards against the 2026-08-21 Graph token outage class.
//
// What happened: oneDriveService kept its OWN 55-minute token cache wrapped
// around microsoftMailService.getAccessToken (which has its own expires_in
// cache with a 5-minute buffer). The outer cache measured 55 minutes from ITS
// refresh moment, so it could adopt a token already ~54 minutes old and serve
// it for another 55 — a recurring ~49-minute Graph outage every ~2 hours.
// While it lasted, loadFormData swallowed the failures and returned [], so
// every client questionnaire pre-filled BLANK, and one autosave would have
// wholesale-replaced the real saved file.
//
// These tests pin the fix at the source level (same style as
// test/inlineScripts.test.js): no re-introduced cache, retries that
// invalidate the REAL cache, transient errors that surface as 503 (never the
// token-substring 403 guess), and a client engine that freezes server writes
// when saved answers could not be loaded.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('oneDriveService has NO local token cache — single source of truth', () => {
  const src = read('src/services/oneDriveService.js');
  // The stacked-cache variables must stay gone.
  assert.ok(!/let _cachedToken|let _tokenExpiry/.test(src),
    'oneDriveService re-declares its own token cache — the stacked-cache outage bug');
  assert.ok(!/_tokenExpiry\s*=\s*Date\.now\(\)\s*\+\s*55/.test(src),
    'the 55-minute wrapper cache is back');
  // getCachedToken must delegate straight to getAccessToken.
  const fn = src.slice(src.indexOf('async function getCachedToken'), src.indexOf('}', src.indexOf('async function getCachedToken')) + 1);
  assert.match(fn, /return getAccessToken\(\)/,
    'getCachedToken must delegate to getAccessToken (no local caching)');
});

test('401 retries invalidate the REAL (mail-service) cache, not dead local vars', () => {
  const od = read('src/services/oneDriveService.js');
  assert.match(od, /function invalidateToken\(\)/);
  assert.match(od, /invalidateAccessToken\(\)/,
    'invalidateToken must reach into microsoftMailService.invalidateAccessToken');
  // Every 401 branch must call invalidateToken (upload, delete, read).
  const branches = od.split(/status === 401/).length - 1;
  const invalidations = od.split(/invalidateToken\(\)/).length - 1;
  assert.ok(branches >= 3, `expected >=3 401-retry branches, found ${branches}`);
  assert.ok(invalidations >= branches,
    `a 401 branch does not invalidate the token cache (${invalidations} invalidations for ${branches} branches)`);

  const mail = read('src/services/microsoftMailService.js');
  assert.match(mail, /function invalidateAccessToken\(\)/);
  assert.match(mail, /getAccessToken,\s*invalidateAccessToken/,
    'microsoftMailService must export invalidateAccessToken');
});

test('storage failures are tagged transient and loadFormData rethrows them', () => {
  const od = read('src/services/oneDriveService.js');
  assert.match(od, /transient = true/, 'OneDrive read/upload failures must carry err.transient');

  const q = read('src/services/htmlQuestionnaireService.js');
  const fn = q.slice(q.indexOf('async function loadFormData'), q.indexOf('async function saveFormData'));
  assert.ok(!/return \[\];\s*\}\s*\}/.test(fn.slice(fn.indexOf('catch'))),
    'loadFormData catch swallows errors again (returns [])');
  assert.match(fn, /err\.transient = true;\s*\n\s*throw err;/,
    'loadFormData must rethrow read failures as transient');
});

test('routes surface transient failures as 503, never the token-substring 403 guess', () => {
  const r = read('src/routes/htmlQuestionnaireForm.js');
  // Every "includes('token')" classifier must be preceded by a transient check.
  const lines = r.split('\n');
  lines.forEach((line, i) => {
    if (/includes\('token'\)/.test(line)) {
      const window = lines.slice(Math.max(0, i - 4), i).join('\n');
      assert.match(window, /err\.transient/,
        `classifier at line ${i + 1} can misread a Graph "token is expired" outage as a 403 access error`);
    }
  });
  // The /data route must have its own 503 path (the client engine keys off it).
  assert.match(r, /res\.status\(503\)\.json\(\{ error: 'Saved answers are temporarily unavailable/,
    '/data route no longer distinguishes storage outage from access denial');
});

test('client engine freezes server writes when saved answers could not load', () => {
  const q = read('src/services/htmlQuestionnaireService.js');
  assert.match(q, /var _serverLoadFailed = false;/);
  assert.match(q, /function showServerLoadFailedBanner\(\)/);

  // The /data fetch handler must set the flag on BOTH non-ok and network error.
  const prefill = q.slice(q.indexOf('async function prefillMemberSection'), q.indexOf('/* Local backup */'));
  const sets = prefill.split('_serverLoadFailed = true').length - 1;
  assert.ok(sets >= 2, `prefillMemberSection must set _serverLoadFailed on non-ok AND network error (found ${sets})`);

  // doSave and doSubmit must both gate on the flag BEFORE any fetch.
  const doSave = q.slice(q.indexOf('async function doSave'), q.indexOf('async function doSubmit'));
  const gate = doSave.indexOf('if (_serverLoadFailed)');
  assert.ok(gate !== -1 && gate < doSave.indexOf("fetch('/q/"),
    'doSave must refuse server writes while _serverLoadFailed');
  const doSubmit = q.slice(q.indexOf('async function doSubmit'));
  const gate2 = doSubmit.indexOf('if (_serverLoadFailed)');
  assert.ok(gate2 !== -1 && gate2 < doSubmit.indexOf("fetch('/q/"),
    'doSubmit must refuse submission while _serverLoadFailed');

  // localStorage backup must still run before the doSave gate returns.
  assert.ok(doSave.indexOf('backupToLocal()') < gate,
    'local backup must happen even when server saves are frozen');
});
