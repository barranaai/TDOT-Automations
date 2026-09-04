'use strict';

// Uploaded filenames arrive as UTF-8 bytes read as latin1 (RFC 7578), so a
// client's "offre d'emploi – 2024.pdf" was stored in OneDrive as mojibake and
// shown that way to staff. decodeUploadFilename repairs it exactly once, and
// only when the repair is provably correct.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const { decodeUploadFilename } = require('../src/utils/uploadFilename');

// mojibake fixtures, built from code points (what multer actually hands us)
const cp = (...codes) => String.fromCharCode(...codes);
const EN_DASH_MOJI = cp(0xE2, 0x80, 0x93);   // U+2013 as latin1-read UTF-8
const RSQUO_MOJI   = cp(0xE2, 0x80, 0x99);   // U+2019
const CCEDIL_MOJI  = cp(0xC3, 0xA7);         // U+00E7
const NBSP_MOJI    = cp(0xC2, 0xA0);         // U+00A0

test('repairs the real mojibake seen in production', () => {
  assert.equal(decodeUploadFilename('Gmail - OINP ' + EN_DASH_MOJI + ' offre d' + RSQUO_MOJI + 'emploi.pdf'),
    'Gmail - OINP – offre d’emploi.pdf');
  assert.equal(decodeUploadFilename('re' + CCEDIL_MOJI + 'u.pdf'), 'reçu.pdf');
  assert.equal(decodeUploadFilename('Apr 1, 2024' + NBSP_MOJI + EN_DASH_MOJI + NBSP_MOJI + 'Apr 15.pdf'),
    'Apr 1, 2024 – Apr 15.pdf');
});

test('leaves alone what it must not touch', () => {
  assert.equal(decodeUploadFilename('passport.pdf'), 'passport.pdf', 'pure ASCII');
  assert.equal(decodeUploadFilename(''), '');
  assert.equal(decodeUploadFilename(null), '');
  assert.equal(decodeUploadFilename(undefined), '');
  // a name that already carries real Unicode (any char above U+00FF)
  assert.equal(decodeUploadFilename('日本語.pdf'), '日本語.pdf');
  assert.equal(decodeUploadFilename('café – 2024.pdf'), 'café – 2024.pdf');
  // a genuine latin1 name: the bytes are not valid UTF-8, so it keeps its form
  assert.equal(decodeUploadFilename('café.pdf'), 'café.pdf');
  assert.equal(decodeUploadFilename('pièce jointe.pdf'), 'pièce jointe.pdf');
});

test('idempotent - a repaired name survives a second pass unchanged', () => {
  const once = decodeUploadFilename('Gmail ' + EN_DASH_MOJI + ' x.pdf');
  assert.equal(decodeUploadFilename(once), once);
  assert.equal(once, 'Gmail – x.pdf');
});

test('the upload path repairs the name ONCE, so the OneDrive file and the audit comment agree', async () => {
  const calls = { uploads: [], updates: [] };
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('../src/services/mondayApi', { query: async (q, vars) => {
    if (q.includes('items_page_by_column_values')) return { items_page_by_column_values: { items: [{ id: '77', name: 'Test Client' }] } };
    if (q.includes('text_mm0zfsp1')) return { items: [{ id: '5', name: 'Job offer', column_values: [
      { id: 'text_mm0zfsp1', text: 'code:X' }, { id: 'lookup_mm0zqbvt', text: '' }, { id: 'text_mm261tka', text: 'Employment' }, { id: 'link_mm1yrnz1', text: 'Employment Folder - https://f/Employment' } ] }] };
    if (q.includes('create_update')) { calls.updates.push(vars.body); return {}; }
    return {};
  } });
  set('../src/services/oneDriveService', { uploadFile: async (p) => { calls.uploads.push(p); return 'https://web/x'; }, ensureCategoryFolderLink: async () => 'https://f/Employment' });
  set('../src/services/caseReadinessService', { calculateForCaseRef: async () => {} });
  const p = require.resolve('../src/services/documentFormService');
  delete require.cache[p];
  const svc = require(p);

  const mangled = 'offre d' + RSQUO_MOJI + 'emploi ' + EN_DASH_MOJI + ' 2024.pdf';
  await svc.uploadFileToOneDrive('5', '2026-OINP-036', Buffer.from('x'), mangled, 'application/pdf');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.uploads[0].filename, 'offre d’emploi – 2024.pdf', 'stored under the repaired name');
  assert.ok(calls.updates.some((b) => String(b).includes('offre d’emploi – 2024.pdf')), 'the audit comment names the same file');
  assert.ok(!calls.updates.some((b) => String(b).includes(EN_DASH_MOJI)), 'no mojibake left in the comment');
});

test('pins: decoded at one choke point; the public intake digest decodes too', () => {
  const svc = fs.readFileSync(require.resolve('../src/services/documentFormService'), 'utf8');
  assert.match(svc, /const originalName = decodeUploadFilename\(rawOriginalName\);/, 'repaired once, at the top of the upload');
  assert.equal((svc.match(/decodeUploadFilename\(/g) || []).length, 1, 'exactly one repair point - never twice');
  const ph = fs.readFileSync(require.resolve('../src/routes/phase2.js'), 'utf8');
  assert.match(ph, /decodeUploadFilename\(file\.originalname\)/, 'rejected-file names shown to staff are readable');
});
