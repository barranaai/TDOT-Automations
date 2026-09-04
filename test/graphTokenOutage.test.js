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
// The follow-up review (2026-08-21) found the SAME two patterns living on
// elsewhere: composite save flows whose FIRST Graph hop (ensureFolder) had no
// 401 retry, and two more read-swallow-then-replace files (the member
// manifest and the correction flags). The fix centralizes auth in
// withGraphAuth — every public OneDrive function routes through it — and
// makes every wholesale-replaced JSON file's reader THROW on failure.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('oneDriveService has NO local token cache — single source of truth', () => {
  const src = read('src/services/oneDriveService.js');
  assert.ok(!/let _cachedToken|let _tokenExpiry/.test(src),
    'oneDriveService re-declares its own token cache — the stacked-cache outage bug');
  assert.ok(!/_tokenExpiry\s*=\s*Date\.now\(\)\s*\+\s*55/.test(src),
    'the 55-minute wrapper cache is back');
  const fn = src.slice(src.indexOf('async function getCachedToken'), src.indexOf('}', src.indexOf('async function getCachedToken')) + 1);
  assert.match(fn, /return getAccessToken\(\)/,
    'getCachedToken must delegate to getAccessToken (no local caching)');

  const mail = read('src/services/microsoftMailService.js');
  assert.match(mail, /function invalidateAccessToken\(\)/);
  assert.match(mail, /getAccessToken,\s*invalidateAccessToken/,
    'microsoftMailService must export invalidateAccessToken');
});

test('EVERY public OneDrive function routes through withGraphAuth (401 retry + transient tagging)', () => {
  const src = read('src/services/oneDriveService.js');
  assert.match(src, /async function withGraphAuth\(/);
  assert.match(src, /function tagTransient\(/);
  // The helper must invalidate the REAL cache and retry once on 401.
  const helper = src.slice(src.indexOf('async function withGraphAuth'), src.indexOf('function wrapError'));
  assert.match(helper, /status !== 401\) throw tagTransient/);
  assert.match(helper, /invalidateToken\(\)/);
  // Token-mint failures are transient by definition (both mint sites).
  assert.ok((helper.match(/transient = true/g) || []).length >= 2,
    'withGraphAuth must tag token-mint failures transient');

  // Every exported function that talks to Graph goes through the helper —
  // one usage per public function (14), plus nothing minting tokens directly.
  const usages = (src.match(/withGraphAuth\('/g) || []).length;
  assert.ok(usages >= 14, `expected >=14 withGraphAuth call sites, found ${usages} — a function bypasses the auth/retry layer`);
  const rawMints = (src.match(/await getCachedToken\(\)/g) || []).length;
  assert.ok(rawMints <= 2, `getCachedToken called ${rawMints}× — direct calls outside withGraphAuth re-open the no-retry bug`);

  // wrapError must PRESERVE the transient flag when re-labelling errors.
  const wrap = src.slice(src.indexOf('function wrapError'), src.indexOf('// ─── URL helpers'));
  assert.match(wrap, /wrapped\.transient = true/);
});

test('tagTransient marks storage-side failures and leaves caller mistakes alone', () => {
  // Source-level truth table (the function is not exported).
  const src = read('src/services/oneDriveService.js');
  const fn = src.slice(src.indexOf('function tagTransient'), src.indexOf('async function withGraphAuth'));
  assert.match(fn, /st === undefined/);
  assert.match(fn, /st === 401/);
  assert.match(fn, /st === 429/);
  assert.match(fn, /st >= 500/);
  assert.ok(!/st === 403|st === 404/.test(fn), '403/404 are NOT transient');
});

test('behavioral: a 401 mid-operation mints a fresh token and the retry succeeds', async () => {
  process.env.MS_TENANT_ID = process.env.MS_TENANT_ID || 't';
  process.env.MS_CLIENT_ID = process.env.MS_CLIENT_ID || 'c';
  process.env.MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || 's';

  const axios = require('axios');
  const orig = { get: axios.get, post: axios.post };
  let minted = 0, reads = 0;
  axios.post = async (url) => {
    if (/login\.microsoftonline\.com/.test(url)) {
      minted++;
      return { data: { access_token: `tok-${minted}`, expires_in: 3600 } };
    }
    throw new Error(`unexpected POST ${url}`);
  };
  axios.get = async (url, opts) => {
    reads++;
    if (opts.headers.Authorization === 'Bearer tok-1') {
      const err = new Error('Request failed with status code 401');
      err.response = { status: 401, data: { error: { code: 'InvalidAuthenticationToken', message: 'Lifetime validation failed, the token is expired.' } } };
      throw err;
    }
    return { data: Buffer.from('{"ok":true}') };
  };
  try {
    delete require.cache[require.resolve('../src/services/microsoftMailService')];
    delete require.cache[require.resolve('../src/services/oneDriveService')];
    const od = require('../src/services/oneDriveService');
    const buf = await od.readFile({ clientName: 'T', caseRef: 'R', subfolder: 'S', filename: 'f.json' });
    assert.equal(buf.toString(), '{"ok":true}');
    assert.equal(minted, 2, 'the 401 must mint a FRESH token (invalidate + re-mint)');
    // 3 GETs: the case-folder resolution (401 -> retried) then the file read.
    // Since 2026-09-04 a read resolves the case folder by its reference first,
    // so a renamed client folder cannot silently read as "no file".
    assert.equal(reads, 3, 'exactly one retry of the request that 401d');

    // And a persistent 500 surfaces as a TRANSIENT-tagged wrapped error.
    axios.get = async () => {
      const err = new Error('boom');
      err.response = { status: 503, data: { error: 'ServiceUnavailable' } };
      throw err;
    };
    await assert.rejects(
      od.readFile({ clientName: 'T', caseRef: 'R', subfolder: 'S', filename: 'f.json' }),
      (e) => /OneDrive read failed/.test(e.message) && e.transient === true
    );
  } finally {
    axios.get = orig.get; axios.post = orig.post;
    delete require.cache[require.resolve('../src/services/microsoftMailService')];
    delete require.cache[require.resolve('../src/services/oneDriveService')];
  }
});

test('read-swallow-then-replace is closed on ALL wholesale-replaced questionnaire files', () => {
  const q = read('src/services/htmlQuestionnaireService.js');
  // loadFormData rethrows (the original fix)…
  const lfd = q.slice(q.indexOf('async function loadFormData'), q.indexOf('async function saveFormData'));
  assert.match(lfd, /err\.transient = true;\s*\n\s*throw err;/, 'loadFormData must rethrow read failures as transient');
  // …and loadMembers seeds ONLY when the file is genuinely absent (readFile null),
  // never on a transient failure — the seed path WRITES via saveMembers.
  const lm = q.slice(q.indexOf('async function loadMembers'), q.indexOf('async function saveMembers'));
  assert.match(lm, /err\.transient = true;\s*\n\s*throw err;/, 'loadMembers must rethrow read failures (the seed fallback overwrites the manifest)');
  assert.ok(lm.indexOf('throw err') < lm.indexOf('seedMembersFromBoard'), 'the transient rethrow must come before the seed fallback');

  const rv = read('src/services/htmlQuestionnaireReviewService.js');
  const lf = rv.slice(rv.indexOf('async function loadFlags'), rv.indexOf('async function saveFlags'));
  assert.match(lf, /err\.transient = true;\s*\n\s*throw err;/, 'loadFlags must rethrow (saveFlags wholesale-replaces the file)');
});

test('routes surface transient failures as 503, never the token-substring 403 guess', () => {
  const r = read('src/routes/htmlQuestionnaireForm.js');
  const lines = r.split('\n');
  lines.forEach((line, i) => {
    if (/includes\('token'\)/.test(line)) {
      const window = lines.slice(Math.max(0, i - 4), i).join('\n');
      assert.match(window, /err\.transient/,
        `classifier at line ${i + 1} can misread a Graph "token is expired" outage as a 403 access error`);
    }
  });
  assert.match(r, /res\.status\(503\)\.json\(\{ error: 'Saved answers are temporarily unavailable/,
    '/data route no longer distinguishes storage outage from access denial');
});

test('client engine freezes server writes when saved answers could not load', () => {
  const q = read('src/services/htmlQuestionnaireService.js');
  assert.match(q, /var _serverLoadFailed = false;/);
  assert.match(q, /function showServerLoadFailedBanner\(\)/);

  const prefill = q.slice(q.indexOf('async function prefillMemberSection'), q.indexOf('/* Local backup */'));
  const sets = prefill.split('_serverLoadFailed = true').length - 1;
  assert.ok(sets >= 2, `prefillMemberSection must set _serverLoadFailed on non-ok AND network error (found ${sets})`);

  const doSave = q.slice(q.indexOf('async function doSave'), q.indexOf('async function doSubmit'));
  const gate = doSave.indexOf('if (_serverLoadFailed)');
  assert.ok(gate !== -1 && gate < doSave.indexOf("fetch('/q/"),
    'doSave must refuse server writes while _serverLoadFailed');
  const doSubmit = q.slice(q.indexOf('async function doSubmit'));
  const gate2 = doSubmit.indexOf('if (_serverLoadFailed)');
  assert.ok(gate2 !== -1 && gate2 < doSubmit.indexOf("fetch('/q/"),
    'doSubmit must refuse submission while _serverLoadFailed');
  assert.ok(doSave.indexOf('backupToLocal()') < gate,
    'local backup must happen even when server saves are frozen');

  // The 2026-08-21 review round: no server writes until the initial load
  // SETTLES (a save racing the /data fetch would replace the server file),
  // and the count-based local-vs-server contest must not discard answers
  // typed during a freeze — local-only values overlay the server copy's gaps.
  assert.match(q, /var _serverLoadSettled = false;/);
  assert.match(doSave, /if \(!_serverLoadSettled\)/);
  assert.match(doSubmit, /if \(!_serverLoadSettled\)/);
  assert.match(q, /_serverLoadSettled = true;/);
  assert.match(q, /Restored ' \+ recovered \+ ' locally saved answer/);
  // The single-member call passes FORM_KEY (already suffixed) — the fetch key
  // must not append the suffix again ('primary-additional-additional').
  assert.match(q, /var fullKey = sectionEl \? \(memberKey \+ FORM_KEY_SUFFIX\) : FORM_KEY;/);
});
