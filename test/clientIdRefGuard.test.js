'use strict';

// GUARD (review #11, 2026-11-25): a Client ID "CL-2026-00042" must never be
// read as a CASE NUMBER by any of the app's case-ref readers — the info@ email
// filer, the mail stamps, the case Emails tab, the delete-folder guard, the
// case-number allocator (its scans and high-water file), the portal-link
// healer — nor as an Otter recording code. Tested THROUGH the live exported
// functions / constants, so a change to any of those readers that starts
// catching CL- IDs fails here.
//
// And the opposite, which documents why the owner's first idea was turned
// down: "2026-VV-00042" (year first, then letters) IS a case number to every
// one of them — and so is "2026-CL-00042".

const test   = require('node:test');
const assert = require('node:assert/strict');

const { subjectCaseRefs } = require('../src/services/emailLeadsService');
const { buildTagProps }   = require('../src/utils/mailTag');
const caseEmailsRules     = require('../src/services/caseEmailsRules');
const deletion            = require('../src/services/deletionService');
const allocator           = require('../src/services/caseRefAllocator');
const { CURRENT_REF }     = require('../src/services/portalLinkHealService');
const { readTitle }       = require('../src/services/otterMatch');
const { formatClientId, parseClientId } = require('../src/utils/clientId');

const ID = 'CL-2026-00042';
// every place a Client ID could end up next to text the readers scan
const CL_SHAPES = [
  ID, 'cl-2026-00042', 'CL-2026-100000', 'CL2026-00042',
  `Jane Doe - ${ID}`, `Re: ${ID}`, `Fwd: [${ID}] documents`, `Client ${ID} · Jane Doe`,
  `Your client number: ${ID}`, `(${ID})`, `ZZ-TEST Jane (was ${ID})`, `${ID}.txt`,
];
const CASE_SHAPED = ['2026-VV-00042', '2026-CL-00042'];

const stampedRef = (ref) => {
  const { props } = buildTagProps({ caseRef: ref }, 'a@b.co');
  const p = props.find((x) => x.id.endsWith('Name TdotCaseRef'));
  return p ? p.value : '';
};

test('the Client ID helpers make exactly the shape this guard protects', () => {
  assert.equal(formatClientId(2026, 42), ID);
  assert.deepEqual(parseClientId(ID), { n: 42, year: 2026 });
});

test('info@ filer (emailLeadsService.subjectCaseRefs): no CL- ID is a case ref; a case ref beside one still is', () => {
  for (const s of CL_SHAPES) assert.deepEqual(subjectCaseRefs(s), [], s);
  assert.deepEqual(subjectCaseRefs(`Re: ${ID} — 2026-VV-006 · Document Collection`), ['2026-VV-006'], 'only the case ref');
  for (const s of CASE_SHAPED) assert.deepEqual(subjectCaseRefs(s), [s], `${s} IS read as a case number`);
});

test('mail stamps (mailTag.buildTagProps): a CL- ID is never stamped as TdotCaseRef', () => {
  for (const s of CL_SHAPES) assert.equal(stampedRef(s), '', s);
  for (const s of CASE_SHAPED) assert.equal(stampedRef(s), s, s);
});

test('case Emails tab (caseEmailsRules.REF_RE): a CL- ID is not a searchable case ref', () => {
  for (const s of CL_SHAPES) assert.equal(caseEmailsRules.REF_RE.test(s), false, s);
  for (const s of CASE_SHAPED) assert.equal(caseEmailsRules.REF_RE.test(s), true, s);
});

test('careful delete: a folder named "<name> - CL-…" is NOT a case\'s folder, and a CL- ID is not a case number to record', () => {
  for (const s of CL_SHAPES) {
    assert.equal(deletion.CASE_FOLDER_SUFFIX_RE.exec(s), null, s);
    assert.equal(deletion.CASE_REF_RE.test(s), false, s);
  }
  for (const s of CASE_SHAPED) {
    assert.equal(deletion.CASE_FOLDER_SUFFIX_RE.exec(`Jane Doe - ${s}`)[1], s);
    assert.equal(deletion.CASE_REF_RE.test(s), true, s);
  }
});

test('case-number allocator: maxSeq never counts a CL- ID for any prefix, and prefixesIn finds no prefix in one', () => {
  for (const prefix of ['2026-CL-', '2026-VV-', '2026-CEC-EE-']) assert.equal(allocator.maxSeq(CL_SHAPES, prefix), 0, prefix);
  assert.deepEqual([...allocator.prefixesIn(CL_SHAPES)], []);
  assert.equal(allocator.maxSeq(['2026-VV-00042'], '2026-VV-'), 42);
  assert.equal(allocator.maxSeq(['Jane - 2026-CL-00042'], '2026-CL-'), 42, 'year-first IS a case number');
  assert.deepEqual([...allocator.prefixesIn(CASE_SHAPED)].sort(), ['2026-CL-', '2026-VV-']);
  assert.deepEqual(allocator.salvageMarks(`{"${ID}": 42, "CL-2026-": 42}`), {}, 'a damaged high-water file holding one never yields a mark');
});

test('case-number allocator end to end: a CL- ID in a folder name or the ref column moves no case number and adds no mark', async () => {
  const p = require.resolve('../src/services/caseRefAllocator');
  delete require.cache[p];
  const a = require(p);
  a._resetForTests();
  let file = { data: { '2026-VV-': 3 }, etag: 'e1' };
  const writes = [];
  a.io.readMark = async () => ({ data: { ...file.data }, etag: file.etag });
  a.io.writeMark = async (data, etag) => { if (etag !== file.etag) { const e = new Error('x'); e.conflict = true; throw e; } writes.push(data); file = { data: { ...data }, etag: 'e2' }; return {}; };
  a.io.writeBackup = async () => ({});
  a.io.boardRefs = async () => ['2026-VV-003', ID, 'CL-2026-00777'];
  a.io.rootFolderNames = async () => [`Jane Doe - ${ID}`, 'Bo - CL-2026-00900', 'Ada - 2026-VV-002'];
  a.io.refInUse = async () => false;
  const o = [console.log, console.warn]; console.log = console.warn = () => {};
  let r;
  try { r = await a.allocate('2026-VV-'); } finally { [console.log, console.warn] = o; }
  assert.equal(r.ref, '2026-VV-004');
  assert.equal(writes.length, 0, 'nothing to raise: the CL- values hold no case prefix');
  assert.deepEqual(Object.keys(file.data), ['2026-VV-']);
  const audit = await a.audit();
  assert.deepEqual(audit.prefixes.map((x) => x.prefix), ['2026-VV-']);
});

test('portal-link healer (CURRENT_REF): a CL- ID is not a current case ref', () => {
  for (const s of CL_SHAPES) assert.equal(CURRENT_REF.test(s), false, s);
  assert.equal(CURRENT_REF.test('2026-VV-004'), true);
});

test('Otter reader (otterMatch.readTitle): a CL- ID is not a recording code; TD- still is', () => {
  for (const s of CL_SHAPES) assert.equal(readTitle(s).code, '', s);
  assert.equal(readTitle('TD-00042').code, 'TD-00042');
  assert.equal(parseClientId('TD-00042'), null, 'and the Client ID reader refuses a TD- code');
});
