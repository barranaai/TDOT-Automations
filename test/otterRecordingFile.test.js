'use strict';
// The Zap's Otter recording files (Faran 2026-11-12/14): the pure parser and the read-only check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../src/services/otterRecordingFile');
const O = require('../src/services/otterFilesService');

const SAMPLE = [
  'Otter ID: abcDEF_123', 'Record ID: 2NONN', 'Title: Consultation with Jane Sample', 'Start time: 1794503124', 'Created at: 1794503125',
  'Owner: Sam Consultant', 'Owner email: sam@example.com', 'Guest emails: Jane@Example.com,jane@example.com, other@example.org', 'Guest names: Jane Sample,Other',
  'Meeting link: ', 'Otter link: https://otter.ai/u/abcDEF_123', '',
  'Abstract summary: Short one.', '', 'Summary: Line one', 'Summary: a second line that starts like a label', 'Title: not a new title', '',
  'Outline: [A, B]', '', 'Action items: ', '', 'Transcript: Speaker 1  0:01', 'Outline: said in the meeting', 'Owner: also said', 'bye',
].join('\r\n');

test('parse: 16 parts in order; a label counts only at a line start and only going forward; long parts keep their lines', () => {
  const p = R.parse(SAMPLE);
  assert.deepEqual(p.missing, []);
  assert.equal(p.found.length, 16);
  assert.equal(p.fields.otterId, 'abcDEF_123');
  assert.equal(p.fields.title, 'Consultation with Jane Sample');
  assert.equal(p.fields.meetingLink, '');
  assert.equal(p.fields.summary, 'Line one\nSummary: a second line that starts like a label\nTitle: not a new title');
  assert.equal(p.fields.actionItems, '');
  assert.equal(p.fields.transcript, 'Speaker 1  0:01\nOutline: said in the meeting\nOwner: also said\nbye');
  assert.deepEqual(R.emailsOf(p.fields.guestEmails), ['jane@example.com', 'other@example.org']);
  assert.equal(new Date(R.startMs(p.fields.startTime)).toISOString().slice(0, 10), '2026-11-12');
});

test('parse: missing parts are named, never guessed; junk and empty input do not throw', () => {
  const p = R.parse('Otter ID: x\nTitle: T\nTranscript: hello');
  assert.deepEqual(p.found, ['otterId', 'title', 'transcript']);
  assert.ok(p.missing.includes('summary') && p.missing.includes('guestEmails'));
  assert.equal(R.parse('').found.length, 0);
  assert.equal(R.parse(null).fields.title, '');
  for (const bad of ['', 'soon', '12', '99999999999999', '100']) assert.equal(R.startMs(bad), null, bad);
  assert.deepEqual(R.emailsOf('No data'), []);
});

test('file name: "<start> - <otter id> - <title>.txt"', () => {
  assert.deepEqual(R.nameParts('1794503124 - abcDEF_123 - Consultation with Jane.txt'), { start: '1794503124', otterId: 'abcDEF_123', title: 'Consultation with Jane' });
  assert.deepEqual(R.nameParts('1794503124 - abc - .txt'), { start: '1794503124', otterId: 'abc', title: '' });
  assert.equal(R.nameParts('notes.docx'), null);
});

test('the check: lengths and counts only — no title, name, email, link or text; read-only; admin-only route, never cached', async () => {
  const orig = { get: O.io.get, getText: O.io.getText };
  const urls = [];
  O.io.get = async (url) => { urls.push(url); return { value: [
    { id: 'A1', name: '1794503124 - abcDEF_123 - Consultation with Jane Sample.txt', size: 31000, file: {}, createdDateTime: '2026-11-12T19:00:00Z' },
    { id: 'B2', name: 'random.txt', size: 10, file: {}, createdDateTime: '2026-11-12T18:00:00Z' },
    { id: 'F', name: 'sub', folder: { childCount: 1 } },
  ] }; };
  O.io.getText = async (url) => { urls.push(url); if (url.includes('/B2/')) { const e = new Error('nope'); e.response = { status: 404, data: { error: { message: 'gone' } } }; throw e; } return SAMPLE; };
  try {
    const r = await O.checkRecordings({ max: 5 });
    const out = JSON.stringify(r);
    for (const leak of ['Jane', 'Sample', 'sam@example.com', 'jane@example.com', 'otter.ai/u', 'Speaker', 'Short one', 'abcDEF']) assert.ok(!out.includes(leak), 'never in the answer: ' + leak);
    assert.equal(r.filesInFolder, 2); assert.equal(r.zapNamed, 1); assert.equal(r.checked.length, 2);
    const a = r.checked[0];
    assert.deepEqual([a.nameOk, a.nameMatchesContent, a.guestEmailCount, a.ownerEmailOk, a.startTime, a.missingLabels.length], [true, true, 2, true, '2026-11-12T17:05', 0]);
    assert.equal(a.filled.meetingLink, 0); assert.ok(a.filled.transcript > 10);
    assert.equal(r.checked[1].problem, '404: gone');
    assert.ok(urls[0].includes('/root:/Otter%20Recordings:/children'));
  } finally { O.io.get = orig.get; O.io.getText = orig.getText; }
  const src = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(src, /app\.get\('\/admin\/otter\/recordings-check', async \(req, res\) => \{\s+res\.set\('Cache-Control', 'private, no-store'\);\s+if \(!resolveAdminOrReject\(/);
  const s = fs.readFileSync(path.join(__dirname, '../src/services/otterFilesService.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '../src/services/otterRecordingFile.js'), 'utf8');
  assert.ok(!/axios\.(post|put|patch|delete)/.test(s) && !/console\./.test(s), 'GET only, nothing logged');
});
