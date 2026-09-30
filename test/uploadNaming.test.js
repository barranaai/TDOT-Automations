'use strict';

// The name a client checklist upload is stored under:
//   <Document> – <Member> – <YYYY-MM-DD HH-mm> – <client's stem><ext>
// so a re-upload never replaces an earlier copy and a category folder sorts
// by document, member and time. Pure module — no I/O, the clock is passed in.

const test   = require('node:test');
const assert = require('node:assert/strict');

const N = require('../src/utils/uploadNaming');

const AT = new Date('2026-09-30T18:32:00Z');   // 14:32 Toronto (EDT)
const at = (iso) => new Date(iso);

test('(1) the plan\'s examples, exactly', () => {
  assert.equal(N.buildStoredName({ docName: 'Passport', member: 'PA', originalName: 'passport.pdf', now: AT }),
    'Passport – PA – 2026-09-30 14-32 – passport.pdf');
  assert.equal(N.buildStoredName({ docName: 'Passport', member: N.memberSegment({ applicantType: 'Spouse / Common-Law Partner' }), originalName: 'IMG_2231.JPG', now: at('2026-09-30T18:33:00Z') }),
    'Passport – Spouse – 2026-09-30 14-33 – IMG_2231.jpg');
  const child2 = { role: { role: 'DependentChild', label: 'Dependent Child' }, memberIndex: 2 };
  assert.equal(N.buildStoredName({ docName: 'Birth certificate', member: N.memberSegment({ resolved: child2 }), originalName: 'scan.pdf', now: at('2026-09-30T18:35:00Z') }),
    'Birth certificate – Child 2 – 2026-09-30 14-35 – scan.pdf');
  const inviter = { role: { role: 'Sponsor', label: 'Inviter (in Canada)' }, memberIndex: 1 };
  assert.equal(N.buildStoredName({ docName: 'Proof of status in Canada', member: N.memberSegment({ resolved: inviter }), originalName: 'PR card.jpg', now: at('2026-09-30T18:40:00Z') }),
    'Proof of status in Canada – Inviter – 2026-09-30 14-40 – PR card.jpg');
  assert.equal(N.buildStoredName({ docName: 'Proof of language proficiency (IELTS-G/CELPIP-G/PTE Core/TEF Canada/ TCF Canada)', member: 'PA', originalName: 'ielts.pdf', now: at('2026-09-30T18:41:00Z') }),
    'Proof of language proficiency – PA – 2026-09-30 14-41 – ielts.pdf', 'cut before " (" — and the "/" never becomes a sub-folder');
  assert.equal(N.buildStoredName({ docName: 'Employment / Source of Income', member: 'PA', originalName: 'x.pdf', now: AT }),
    'Employment - Source of Income – PA – 2026-09-30 14-32 – x.pdf');
  assert.equal(N.buildStoredName({ docName: 'Employment/ Source of Income', member: 'PA', originalName: 'x.pdf', now: AT }),
    'Employment - Source of Income – PA – 2026-09-30 14-32 – x.pdf', 'the schema\'s own spacing reads the same');
  assert.equal(N.buildStoredName({ docName: 'Passport', member: N.memberSegment({ applicantType: 'Non Accompanying Child 1' }), originalName: 'image.jpeg', now: at('2026-09-30T18:42:00Z') }),
    'Passport – Non-Acc Child 1 – 2026-09-30 14-42 – image.jpeg');
});

test('(2) seg: illegal and control characters gone, whitespace collapsed, edges trimmed, NFC applied', () => {
  assert.equal(N.seg('a*b:c?d"e<f>g'), 'abcdefg');
  assert.equal(N.seg('a\u0000b\u001Fc\u007Fd'), 'abcd');
  assert.equal(N.seg('a\\b|c'), 'a-b-c');
  assert.equal(N.seg('a/b'), 'a - b', '"/" reads as a dash between words');
  assert.equal(N.seg('  a \t\n  b  '), 'a b');
  assert.equal(N.seg(' ..a.b.. '), 'a.b', 'leading/trailing dots and spaces are what Graph would trim — so they go first');
  assert.equal(N.seg('é'), 'é', 'decomposed input is composed (NFC)');
  assert.equal(N.seg(null), '');
  assert.equal(N.seg(undefined), '');
  for (const ch of ['*', ':', '?', '"', '<', '>', '/', '\\', '|']) {
    assert.ok(!N.seg(`x${ch}y`).includes(ch), `${JSON.stringify(ch)} never survives`);
  }
});

test('(3) caps: 201-char document → ≤ 60 at a word boundary; 200-char stem → 40; whole name ≤ 180, stem gives way first; extension rules', () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');   // > 201 chars
  assert.ok(words.length > 201);
  const doc = N.documentSegment(words);
  assert.ok(Array.from(doc).length <= 60, `document ≤ 60 (${doc.length})`);
  assert.ok(!/\S+$/.test(doc) || words.split(' ').includes(doc.split(' ').pop()), 'cut at a word boundary — the last word is whole');
  assert.ok(!doc.endsWith(' ') && !doc.endsWith('-'));

  const stem200 = 's'.repeat(200);
  const n1 = N.buildStoredName({ docName: 'Passport', member: 'PA', originalName: `${stem200}.PDF`, now: AT });
  assert.equal(n1, `Passport – PA – 2026-09-30 14-32 – ${'s'.repeat(40)}.pdf`, 'stem capped at 40, .PDF lower-cased');

  // A 60-char document + 40-char stem + member fits under 180; push the member
  // segment to its cap too and the total still fits without shortening.
  const n2 = N.buildStoredName({ docName: 'D'.repeat(201), member: 'M'.repeat(25), originalName: `${stem200}.pdf`, now: AT });
  assert.ok(Array.from(n2).length <= N.MAX_STORED_NAME);
  assert.equal(N.MAX_STORED_NAME, 180);

  // Force the cap: a long-but-legal document name and a long stem with a long extension
  const n3 = N.buildStoredName({ docName: 'D'.repeat(60), member: 'M'.repeat(25), originalName: `${'s'.repeat(40)}.abcdefghij`, now: AT });
  assert.ok(Array.from(n3).length <= 180);
  assert.ok(n3.endsWith('.abcdefghij'), 'the extension always survives');
  assert.ok(n3.includes('D'.repeat(60)), 'the document is untouched while the stem can still give way');
  assert.ok(n3.includes(`${'s'.repeat(10)}`), 'stem shortened, never below 10');

  assert.equal(N.buildStoredName({ docName: 'Passport', member: 'PA', originalName: 'file.verylongextension', now: AT }),
    'Passport – PA – 2026-09-30 14-32 – file.verylongextension', 'an 11+ char "extension" is not one: it stays part of the stem');
  assert.equal(N.buildStoredName({ docName: 'Passport', member: 'PA', originalName: 'scan.JPEG', now: AT }),
    'Passport – PA – 2026-09-30 14-32 – scan.jpeg');
});

test('(4) empty inputs → Document, PA, file', () => {
  assert.equal(N.documentSegment(''), 'Document');
  assert.equal(N.documentSegment('***'), 'Document');
  assert.equal(N.memberSegment({}), 'PA');
  assert.equal(N.memberSegment({ applicantType: '', applicantLabel: '' }), 'PA');
  assert.equal(N.buildStoredName({ docName: '', member: '', originalName: '', now: AT }), 'Document – PA – 2026-09-30 14-32 – file');
  assert.equal(N.buildStoredName({ docName: 'Passport', member: 'PA', originalName: '   ', now: AT }), 'Passport – PA – 2026-09-30 14-32 – file');
});

test('(5) Toronto stamps: DST and standard time, midnight never reads 24, the date is the Toronto date', () => {
  assert.equal(N.torontoStamp(at('2026-09-30T18:32:00Z')), '2026-09-30 14-32');
  assert.equal(N.torontoStamp(at('2026-01-15T04:59:00Z')), '2026-01-14 23-59', 'EST: the day before');
  assert.equal(N.torontoStamp(at('2026-09-30T04:05:00Z')), '2026-09-30 00-05', 'midnight is 00, never 24');
  assert.equal(N.torontoStamp(at('2026-01-15T05:00:00Z')), '2026-01-15 00-00');
  assert.equal(N.torontoDate(at('2026-09-30T02:30:00Z')), '2026-09-29');
  assert.equal(N.torontoDate(at('2026-09-30T04:00:00Z')), '2026-09-30');
  assert.doesNotMatch(N.torontoStamp(at('2026-11-01T05:30:00Z')), /24-/);
});

test('(6) memberSegment: every schema role key, and the text forms the boards carry', () => {
  const r = (role, label, memberIndex = 1) => N.memberSegment({ resolved: { role: { role, label }, memberIndex } });
  assert.equal(r('PrincipalApplicant', 'Principal Applicant'), 'PA');
  assert.equal(r('Spouse', 'Spouse / Common-Law Partner'), 'Spouse');
  assert.equal(r('DependentChild', 'Dependent Child', 1), 'Child 1');
  assert.equal(r('DependentChild', 'Dependent Child', 3), 'Child 3');
  assert.equal(r('NonAccompanyingSpouse', 'Non-Accompanying Spouse'), 'Non-Acc Spouse');
  assert.equal(r('NonAccompanyingChild', 'Non-Accompanying Child', 2), 'Non-Acc Child 2');
  assert.equal(r('Sponsor', 'Inviter (in Canada)'), 'Inviter');
  assert.equal(r('Sponsor', 'Sponsor / Inviter (in Canada)'), 'Inviter');
  assert.equal(r('Sponsor', 'Sponsor (Canadian/PR Spouse)'), 'Sponsor');
  assert.equal(r('Parent', 'Parent'), 'Parent');
  assert.equal(r('Parent', 'Parent', 2), 'Parent 2', 'two parents\' passports must not share a name');
  assert.equal(r('Sibling', 'Sibling'), 'Sibling');
  assert.equal(r('Guardian', 'Legal Guardian (appointed)'), 'Legal Guardian', 'an unknown role falls back to its sanitised label, capped at 25 on a word boundary');

  const t = (applicantType, applicantLabel) => N.memberSegment({ applicantType, applicantLabel });
  assert.equal(t('Principal Applicant'), 'PA');
  assert.equal(t('Spouse / Common-Law Partner'), 'Spouse');
  assert.equal(t('Dependent Child'), 'Child 1');
  assert.equal(t('Dependent Child 2'), 'Child 2');
  assert.equal(t('Non Accompanying Child 1'), 'Non-Acc Child 1');
  assert.equal(t('Non Accompanying Spouse'), 'Non-Acc Spouse');
  assert.equal(t('Worker Spouse'), 'Worker Spouse');
  assert.equal(t('Sponsor'), 'Sponsor');
  assert.equal(t('Sponsor', 'Inviter (in Canada)'), 'Inviter');
  assert.equal(t('Sponsor', 'Sponsor (Canadian/PR Spouse)'), 'Sponsor');
  assert.equal(t('Sponsor (Canadian/PR Spouse)'), 'Sponsor', '"Spouse" inside a sponsor label does not make it a spouse');
  assert.equal(t('Parent'), 'Parent');
  assert.equal(t('Sibling 2'), 'Sibling 2');
  assert.equal(t('', 'Inviter (in Canada)'), 'Inviter', 'the label is read when the type is blank');
  const odd = t('Some brand new member kind that nobody has heard of: yet?');
  assert.ok(Array.from(odd).length <= 25 && !/[:?]/.test(odd), `unknown → sanitised ≤ 25 (${JSON.stringify(odd)})`);
});

test('(7) the separator is an en dash; no colon anywhere in a built name', () => {
  const n = N.buildStoredName({ docName: 'Scan: Passport', member: 'PA', originalName: 'a:b.pdf', now: AT });
  assert.ok(n.includes(' – '), 'U+2013 present');
  assert.equal(N.SEP, ' – ');
  assert.ok(!n.includes(':'), 'no ":" (illegal on OneDrive — and it keeps "Category:" out of a File: line)');
  assert.equal((n.match(/ – /g) || []).length, 3, 'exactly three separators');
});

test('(8) UPLOAD_UNIQUE_NAMES: OFF until 1/true for this release (the tenant check gates it)', () => {
  const saved = process.env.UPLOAD_UNIQUE_NAMES;
  try {
    delete process.env.UPLOAD_UNIQUE_NAMES; assert.equal(N.isUniqueNamesEnabled(), false, 'unset = OFF');
    process.env.UPLOAD_UNIQUE_NAMES = '1';   assert.equal(N.isUniqueNamesEnabled(), true);
    process.env.UPLOAD_UNIQUE_NAMES = 'true'; assert.equal(N.isUniqueNamesEnabled(), true);
    process.env.UPLOAD_UNIQUE_NAMES = ' TRUE '; assert.equal(N.isUniqueNamesEnabled(), true);
    process.env.UPLOAD_UNIQUE_NAMES = '0';   assert.equal(N.isUniqueNamesEnabled(), false);
    process.env.UPLOAD_UNIQUE_NAMES = 'off'; assert.equal(N.isUniqueNamesEnabled(), false);
    process.env.UPLOAD_UNIQUE_NAMES = 'yes'; assert.equal(N.isUniqueNamesEnabled(), false, 'only 1/true switch it on');
  } finally {
    if (saved === undefined) delete process.env.UPLOAD_UNIQUE_NAMES; else process.env.UPLOAD_UNIQUE_NAMES = saved;
  }
});

test('(9) the re-file tool\'s normFilename leaves a built name unchanged apart from case', () => {
  const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  set('../src/services/oneDriveService', {});
  set('../src/services/mondayApi', { query: async () => ({}) });
  const p = require.resolve('../src/services/documentRefileService');
  delete require.cache[p];
  const refile = require(p);
  const n = N.buildStoredName({ docName: 'Proof of language proficiency (IELTS-G/CELPIP-G)', member: 'Child 2', originalName: 'IMG_2231.JPG', now: AT });
  assert.equal(refile.normFilename(n), n.toLowerCase());
  assert.equal(refile.normFilename(n), 'proof of language proficiency – child 2 – 2026-09-30 14-32 – img_2231.jpg');
});

test('(A3) seg counts by code points and never leaves half a surrogate pair — a cut name still URL-encodes', () => {
  const emoji = 'ab\u{1F600}';                              // 3 code points, 4 code units
  const s = N.seg(emoji.repeat(30), 41);                    // 41 code points = an emoji straddles a code-unit cut
  assert.equal(Array.from(s).length, 41);
  assert.doesNotThrow(() => encodeURIComponent(s));
  assert.ok(s.endsWith('ab'), 'the cut lands on a whole code point');
  // a lone surrogate in the INPUT is dropped rather than stored
  assert.equal(N.seg('x\uD83Dy'), 'xy');
  assert.equal(N.seg('\uDE00xy'), 'xy');
  assert.doesNotThrow(() => encodeURIComponent(N.buildStoredName({ docName: '\u{1F600}'.repeat(70), member: '\u{1F600}'.repeat(30), originalName: `${'\u{1F600}'.repeat(50)}.pdf`, now: AT })));
});
