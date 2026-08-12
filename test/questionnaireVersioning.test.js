'use strict';

// Questionnaire form versioning (Aug-2026 refresh of forms 1 & 2). Contract:
// NEW cases get the refreshed forms; ANY legacy signal — an explicit legacy
// record, or unrecorded client answers in ANY slot — pins the case to the
// April form it started on. Transient storage failures THROW (fail the
// request) instead of guessing an era, because a wrong guess plus one
// autosave destroys April answers permanently. Saves record the era the
// client was actually served (validated echo), never a server-side guess.

const test   = require('node:test');
const assert = require('node:assert/strict');

const svc      = require('../src/services/htmlQuestionnaireService');
const oneDrive = require('../src/services/oneDriveService');
const { LEGACY_FORM_FILES } = require('../config/questionnaireFormMap');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const AUG1 = '1. Express Entry - PNP - PR Application -  Questionnaire - August 2026.html';
const APR1 = '1. Express Entry - PNP - PR Application -  Questionnaire - April 2025.html';
const AUG2 = '2. Work Permit Application Inside Canada (PGWP -SOWP- BOWP -LMIA - EXTENSION  - Questionnaire - August 2026.html';
const APR2 = '2. Work Permit Application Inside Canada (PGWP -SOWP- BOWP -LMIA - EXTENSION  - Questionnair - April 2025.html';

let CASE_N = 0;
const freshRef = () => `2026-VT-${String(++CASE_N).padStart(3, '0')}`;   // unique per test — the era cache is per case

// byFilename: map substring → JSON payload (or 'THROW'); anything else → null.
async function resolveWith(byFilename, formFiles) {
  const restores = [
    stub(oneDrive, 'readFile', async ({ filename }) => {
      for (const [frag, payload] of Object.entries(byFilename || {})) {
        if (filename.includes(frag)) {
          if (payload === 'THROW') throw new Error('429 too many requests');
          return Buffer.from(JSON.stringify(payload));
        }
      }
      return null;
    }),
  ];
  try {
    return await svc.versionFormFilesForCase({ clientName: 'T', caseRef: freshRef(), formFiles });
  } finally { restores.forEach((r) => r()); }
}

test('the legacy map covers exactly the two refreshed forms', () => {
  assert.deepEqual(LEGACY_FORM_FILES, { [AUG1]: APR1, [AUG2]: APR2 });
});

test('an untouched case gets the refreshed form', async () => {
  const r = await resolveWith({}, { primary: AUG1, additional: null });
  assert.equal(r.primary, AUG1);
});

test('a recorded Aug era stays on the refreshed form', async () => {
  const r = await resolveWith({ '-primary.json': { formFile: AUG1, fields: [{ label: 'x', value: 'y' }] } },
    { primary: AUG1, additional: null });
  assert.equal(r.primary, AUG1);
});

test('THE CONTRACT: unrecorded client answers in ANY slot pin the case to April', async () => {
  // primary slot
  let r = await resolveWith({ '-primary.json': { fields: [{ label: 'Family Name (Surname)', value: 'Sharma' }] } },
    { primary: AUG1, additional: null });
  assert.equal(r.primary, APR1);
  // the primary member's ADDITIONAL slot (F6+F1 family — F6 record says nothing)
  r = await resolveWith({ '-primary-additional.json': { fields: [{ label: 'x', value: 'ans' }] } },
    { primary: '6. something.html', additional: AUG1 });
  assert.equal(r.primary, '6. something.html', 'non-versioned primary untouched');
  assert.equal(r.additional, APR1);
  // the legacy standalone 'additional' slot
  r = await resolveWith({ '-additional.json': { fields: [{ label: 'x', value: 'ans' }] } },
    { primary: AUG2, additional: null });
  assert.equal(r.primary, APR2);
});

test('prefill-seeded values never pin a case to the legacy era', async () => {
  const r = await resolveWith({ '-primary.json': { fields: [
    { label: 'Full Name', value: 'Seeded Client', source: 'prefill' },
    { label: 'Email', value: 'seed@x.com', source: 'prefill' },
  ] } }, { primary: AUG1, additional: null });
  assert.equal(r.primary, AUG1, 'prefill is OURS — a never-opened case is a new-form case');
});

test('legacy plain-array data (pre-JSON-wrapper saves) counts as started-on-April', async () => {
  const restore = stub(oneDrive, 'readFile', async ({ filename }) =>
    filename.includes('-primary.json') ? Buffer.from(JSON.stringify([{ label: 'x', value: 'ans' }])) : null);
  try {
    const r = await svc.versionFormFilesForCase({ clientName: 'T', caseRef: freshRef(), formFiles: { primary: AUG1, additional: null } });
    assert.equal(r.primary, APR1);
  } finally { restore(); }
});

test('legacy CSV-only data counts as started-on-April', async () => {
  const restore = stub(oneDrive, 'readFile', async ({ filename }) =>
    filename.endsWith('.csv') && filename.includes('-primary')
      ? Buffer.from('"Section","Label","Key","Value"\n"S1","Family Name","s1__family-name","Sharma"') : null);
  try {
    const r = await svc.versionFormFilesForCase({ clientName: 'T', caseRef: freshRef(), formFiles: { primary: AUG1, additional: null } });
    assert.equal(r.primary, APR1, 'CSV-era answers are real pre-refresh answers');
  } finally { restore(); }
});

test('a recorded LEGACY era outranks everything (asymmetric harm)', async () => {
  const r = await resolveWith({ '-primary.json': { formFile: APR1, fields: [] } },
    { primary: AUG1, additional: null });
  assert.equal(r.primary, APR1);
});

test('DESTRUCTION GUARD: a transient storage failure THROWS — never a guessed era', async () => {
  // A 429 that guessed "current" would serve the Aug form to a mid-April
  // client; their next autosave then wholesale-replaces the April answers.
  await assert.rejects(
    resolveWith({ '-primary.json': 'THROW' }, { primary: AUG1, additional: null }),
    (e) => e.transient === true && !/token|not found|missing/i.test(e.message),
    'throws a transient error whose message cannot be mistaken for an access denial');
});

test('non-versioned form sets never touch storage', async () => {
  let reads = 0;
  const restore = stub(oneDrive, 'readFile', async () => { reads++; return null; });
  try {
    const r = await svc.versionFormFilesForCase({ clientName: 'T', caseRef: freshRef(), formFiles: { primary: '8. Visitor.html', additional: null } });
    assert.equal(r.primary, '8. Visitor.html');
    assert.equal(reads, 0, 'upload auth on non-versioned cases stays free');
  } finally { restore(); }
});

test('the era is cached per case — a page-load burst costs one resolution', async () => {
  let reads = 0;
  const caseRef = freshRef();
  const restore = stub(oneDrive, 'readFile', async () => { reads++; return null; });
  try {
    await svc.versionFormFilesForCase({ clientName: 'T', caseRef, formFiles: { primary: AUG1, additional: null } });
    const first = reads;
    await svc.versionFormFilesForCase({ clientName: 'T', caseRef, formFiles: { primary: AUG1, additional: null } });
    await svc.versionFormFilesForCase({ clientName: 'T', caseRef, formFiles: { primary: AUG1, additional: null } });
    assert.equal(reads, first, 'repeat resolutions within the TTL are free');
  } finally { restore(); }
});

test('validSaveFormFile: only the exact current or legacy filename for the slot is recordable', () => {
  const ff = { primary: AUG1, additional: null };
  assert.equal(svc.validSaveFormFile(ff, 'primary', AUG1), AUG1, 'echoed current accepted');
  assert.equal(svc.validSaveFormFile(ff, 'primary', APR1), APR1, 'echoed legacy accepted (pre-deploy tab)');
  assert.equal(svc.validSaveFormFile(ff, 'primary', '../../etc/passwd'), '', 'garbage rejected');
  assert.equal(svc.validSaveFormFile(ff, 'primary', '8. Visitor.html'), '', 'wrong slot rejected');
  assert.equal(svc.validSaveFormFile(ff, 'primary', ''), '', 'absent echo records nothing — the data rule decides later');
  // legacy-era-resolved set still accepts the current file echoed from a newer tab
  const legacyResolved = { primary: APR1, additional: null };
  assert.equal(svc.validSaveFormFile(legacyResolved, 'primary', AUG1), AUG1);
});

test('the page embeds the served file and every save echoes it; the server records only the validated echo', () => {
  const s = require('fs').readFileSync(require.resolve('../src/services/htmlQuestionnaireService'), 'utf8');
  assert.match(s, /var FORM_FILE\s+= \$\{JSON\.stringify\(String\(formFile \|\| ''\)\)\};/, 'served file embedded in the page');
  assert.equal((s.match(/formFile:\s*FORM_FILE/g) || []).length >= 1, true, 'client bodies echo it');
  const r = require('fs').readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm'), 'utf8');
  const saveCalls = [...r.matchAll(/svc\.saveFormData\(\{[\s\S]{0,500}?\}\)/g)];
  assert.ok(saveCalls.length >= 3, 'all three save sites found');
  for (const m of saveCalls) assert.match(m[0], /svc\.validSaveFormFile\(formFiles/, 'every save records only the validated echo');
  assert.ok(!/formFile:\s*svc\.formFileForKey\(/.test(r), 'no save-time server guessing remains');
});

test('the staff review route resolves the era (a legacy case reviews against the April form)', () => {
  const r = require('fs').readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm'), 'utf8');
  const i = r.indexOf("router.get('/:caseRef/review'");
  const block = r.slice(i, i + 1600);
  assert.match(block, /versionFormFilesForCase/, 'review uses the era-aware form set');
});

test('formFileForKey routes member and additional keys to the right file', () => {
  const ff = { primary: 'P.html', additional: 'A.html' };
  assert.equal(svc.formFileForKey(ff, 'primary'), 'P.html');
  assert.equal(svc.formFileForKey(ff, 'spouse'), 'P.html');
  assert.equal(svc.formFileForKey(ff, 'additional'), 'A.html');
  assert.equal(svc.formFileForKey(ff, 'spouse-additional'), 'A.html');
});

test('all four form files exist on disk (both eras stay servable)', () => {
  const fs = require('fs');
  const path = require('path');
  const { FORMS_DIR } = require('../config/questionnaireFormMap');
  for (const f of [AUG1, AUG2, APR1, APR2]) {
    assert.ok(fs.existsSync(path.join(FORMS_DIR, f)), `${f} must exist on disk`);
  }
});
