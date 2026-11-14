'use strict';
// Otter recordings file themselves on the consultation (Faran 2026-11-14): the run over the folder,
// the entry on the lead, the saved list, the "to match" list and its two buttons, the routes, the
// pages and the privacy rules. Every Monday / OneDrive seam is stubbed (the no-network guard backs
// it). All names, emails, ids and recording text are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const S = require('../src/services/otterReaderService');
const M = require('../src/services/otterMatch');
const U = require('../src/services/updatesService');
const mondayApi = require('../src/services/mondayApi');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const at = (wall) => String(Math.round(M.wallToMs(wall) / 1000));
const NOW = M.wallToMs('2026-11-12 18:00');
const SECRET = ['Priya', 'Example', 'Omar', 'Sample', 'priya.example@example.com', 'omar@example.com', 'TD-12345', 'TD-22222',
  'refugee claim', 'work permit options', 'Speaker 1', 'otter.ai/u/', 'ZZTOPSECRET', 'Consultation with'];

function fileText({ id, title = '', start, summary = 'They talked about work permit options. ZZTOPSECRET ' + 'm'.repeat(300), transcript, abstract = 'Client asked about a refugee claim and next steps.', link }) {
  return [
    `Otter ID: ${id}`, 'Record ID: R1', `Title: ${title}`, `Start time: ${start}`, `Created at: ${start}`,
    'Owner: Shared Account', 'Owner email: office@example.com', 'Guest emails: ', 'Guest names: ', 'Meeting link: ',
    `Otter link: ${link == null ? 'https://otter.ai/u/' + id : link}`, '',
    `Abstract summary: ${abstract}`, '', `Summary: ${summary}`, '', 'Outline: [Intro, Options]', '', 'Action items: Send the checklist', '',
    `Transcript: ${transcript == null ? 'Speaker 1  0:01\nHello and welcome ZZTOPSECRET\nSpeaker 2  34:10\nThank you, goodbye. ' + 't'.repeat(300) : transcript}`,
  ].join('\r\n');
}
const fileOf = (id, start, title = '', n = 1) => ({ id: 'F-' + id, name: `${start} - ${id} - ${title}.txt`, size: 30000, createdDateTime: `2026-11-12T19:0${n}:00Z` });

// the real seams and console, captured ONCE: every world restores to these (a test may build several worlds)
const REAL_IO = { ...S.io };
const REAL_CONSOLE = { log: console.log, warn: console.warn, error: console.error };
const REAL_ENV = process.env.OTTER_READER;

/** A whole stubbed world: the folder, the consultations, the saved list in "OneDrive", the leads' updates in "Monday". */
function world({ files = [], texts = {}, consults = [], folders = {}, state = null } = {}) {
  const w = {
    files, texts, consults, folders, store: state ? { data: JSON.parse(JSON.stringify(state)), etag: 'e0' } : null, etagN: 0,
    posts: [], uploads: [], writes: 0, reads: [], lists: 0, failPost: 0, failRead: new Set(), failWrite: 0, failFiledOn: false, conflictOnce: false,
    // each recording's own trace file (a file apart from the saved list: losing w.store does not lose it), and the leads Monday no longer has
    traces: {}, traceWrites: 0, traceReads: 0, failTraceRead: false, failTraceWrite: false, gone: new Set(),
  };
  const orig = REAL_IO, origEnv = REAL_ENV;
  S.io.now = () => NOW;
  S.io.listFiles = async () => { w.lists++; return w.files; };
  S.io.readFile = async (fileId) => {
    w.reads.push(fileId);
    if (w.failRead.has(fileId)) { const e = new Error('The file "Consultation with Priya Example.txt" could not be found'); e.response = { status: 404 }; throw e; }
    return w.texts[fileId];
  };
  w.names = [];
  S.io.fileName = async (fileId) => { w.names.push(fileId); if (w.failName) throw new Error('The item "Consultation with Priya Example.txt" was not found'); const f = w.files.find((x) => x.id === fileId); return f ? f.name : ''; };
  S.io.consultations = async () => { if (w.failConsults) throw new Error('down'); return w.consults; };
  S.io.readState = async () => (w.store ? { data: JSON.parse(JSON.stringify(w.store.data)), etag: w.store.etag } : null);
  S.io.writeState = async (data, etag) => {
    if (w.failWrite) { w.failWrite--; throw new Error('write failed'); }
    if (w.conflictOnce) { w.conflictOnce = false; w.store = { data: { version: 1, recs: { ot_OTHER: { d: 'dismissed', who: 'Someone', at: 'x' } } }, etag: 'eX' }; const e = new Error('changed'); e.conflict = true; throw e; }
    if ((w.store ? w.store.etag : '') !== etag) { const e = new Error('changed'); e.conflict = true; throw e; }
    w.writes++; w.store = { data: JSON.parse(JSON.stringify(data)), etag: 'e' + (++w.etagN) };
    return { etag: w.store.etag };
  };
  // the lead's own updates are the proof: what was posted is what is read back
  S.io.readTrace = async (otterId) => {
    w.traceReads++;
    if (w.failTraceRead) throw new Error('trace read failed for "Consultation with Priya Example"');
    const t = w.traces[otterId];
    return t ? { data: JSON.parse(JSON.stringify(t.data)), etag: t.etag } : null;
  };
  S.io.writeTrace = async (otterId, data, etag) => {
    if (w.failTraceWrite) throw new Error('trace write failed');
    const cur = w.traces[otterId];
    if ((cur ? cur.etag : '') !== etag) { const e = new Error('changed'); e.conflict = true; throw e; }
    w.traceWrites++; w.traces[otterId] = { data: JSON.parse(JSON.stringify(data)), etag: 't' + (++w.etagN) };
    return { etag: w.traces[otterId].etag };
  };
  S.io.filedOn = async (leadId) => {
    if (w.failFiledOn) throw new Error('Monday down');
    // a lead that was deleted: the same explicit signal updatesService.getOtterFiled gives
    if (w.gone.has(String(leadId))) { const e = new Error('The record was not found.'); e.notFound = true; throw e; }
    const out = { recordings: new Set(), transcripts: new Set() };
    for (const p of w.posts) if (p.leadId === String(leadId)) U.otterRefsIn(p.html, out);
    return out;
  };
  S.io.postEntry = async (leadId, html) => { if (w.failPost) { w.failPost--; throw new Error('create_update failed for Priya Example'); } w.posts.push({ leadId: String(leadId), html }); return { ok: true }; };
  S.io.leadFolder = async (leadId) => ({ folderId: w.folders[String(leadId)] || '', fullName: 'unused' });
  S.io.saveTranscript = async (a) => { if (w.failUpload) throw new Error('upload failed'); w.uploads.push(a); return { url: 'https://example.sharepoint.com/t/' + encodeURIComponent(a.filename) }; };
  const logs = [];
  const cl = REAL_CONSOLE.log, cw = REAL_CONSOLE.warn, ce = REAL_CONSOLE.error;
  console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  w.logs = logs;
  w.mode = (m) => { if (m == null) delete process.env.OTTER_READER; else process.env.OTTER_READER = m; };
  w.restore = () => { Object.assign(S.io, orig); console.log = cl; console.warn = cw; console.error = ce; if (origEnv == null) delete process.env.OTTER_READER; else process.env.OTTER_READER = origEnv; S._reset(); };
  S._reset();
  return w;
}
const CONSULTS = [
  { id: '9100012345', name: 'Priya Example', email: 'priya.example@example.com', bookedSlot: '2026-11-12 14:00', createdAt: '2026-11-01T12:00:00Z', consultant: 'Consultant One' },
  { id: '9100022222', name: 'Omar Sample', email: 'omar@example.com', bookedSlot: '2026-11-12 14:30', createdAt: '2026-11-02T12:00:00Z', consultant: 'Consultant Two' },
];
const START = at('2026-11-12 14:02');
function standard(extra = {}) {
  const files = [fileOf('ot_AAA111', START, 'TD-12345', 1), fileOf('ot_BBB222', START, '', 2), { id: 'X', name: 'holiday list.docx', size: 10, createdDateTime: '2026-11-12T10:00:00Z' }];
  const texts = { 'F-ot_AAA111': fileText({ id: 'ot_AAA111', title: 'TD-12345', start: START }), 'F-ot_BBB222': fileText({ id: 'ot_BBB222', start: START }) };
  return world({ files, texts, consults: CONSULTS, folders: { 9100012345: 'FOLDER1' }, ...extra });
}
// the entries of one kind among what was posted: the summary (it carries the recording's mark) and the transcript ones
const summaries = (w, leadId) => w.posts.filter((p) => p.html.includes('Otter recording ref: ') && (!leadId || p.leadId === String(leadId)));
const leaks = (text, where) => { for (const x of SECRET) assert.ok(!String(text).includes(x), `${where}: must not contain "${x}"`); };

// ── the switch ────────────────────────────────────────────────────────────────
test('the switch: unset / off / anything else = nothing is read; report = the timer does nothing; on = the timer runs', async () => {
  const w = standard();
  try {
    for (const v of [null, '', 'off', 'OFF', 'yes', '1', 'true']) {
      w.mode(v);
      assert.equal(S.mode(), 'off', String(v));
      assert.equal(await S.tick(), null);
      const r = await S.runOnce();
      assert.deepEqual([r.ok, r.mode], [null, 'off']);
      assert.deepEqual(await S.needsList(), { on: false, items: [] });
    }
    assert.deepEqual([w.lists, w.reads.length, w.posts.length, w.writes], [0, 0, 0, 0], 'off: not one read');
    w.mode('report');
    assert.equal(S.mode(), 'report');
    assert.equal(await S.tick(), null, 'report: the timer does nothing');
    assert.equal(w.lists, 0);
    w.mode(' On ');
    assert.equal(S.mode(), 'on');
    assert.equal((await S.tick()).mode, 'on');
    assert.deepEqual([w.posts.length, summaries(w).length], [2, 1], 'the summary, then the short entry that links the stored transcript');
  } finally { w.restore(); }
  const sched = read('src/services/scheduler.js');
  assert.match(sched, /cron\.schedule\('1-59\/10 \* \* \* \*', \(\) =>\s+require\('\.\/otterReaderService'\)\.tick\(\)/, 'every 10 minutes, through tick() (which checks the switch)');
});

// ── report mode ───────────────────────────────────────────────────────────────
test('report mode: files nothing, writes nothing (not even the saved list), and its answer and the logs hold no title, name, email, link or text', async () => {
  const w = standard();
  try {
    w.mode('report');
    const r = await S.runOnce({ mode: 'report' });
    assert.equal(r.ok, true);
    assert.deepEqual([w.posts.length, w.uploads.length, w.writes, w.store], [0, 0, 0, null]);
    assert.deepEqual([r.filesInFolder, r.otherFiles, r.files.length], [3, 1, 2]);
    assert.deepEqual(r.totals, { file: 1, filed: 0, needs: 1, unreadable: 0, failed: 0 });
    const a = r.files.find((f) => f.decision === 'file'), b = r.files.find((f) => f.decision === 'needs');
    assert.deepEqual(Object.keys(a).sort(), ['alreadyOnRecord', 'by', 'candidates', 'created', 'decision', 'reason', 'summaryChars', 'titleHolds', 'titlePresent', 'transcriptChars'].sort());
    assert.deepEqual([a.by, a.titlePresent, a.titleHolds, a.alreadyOnRecord, a.candidates], ['code', true, ['code'], false, 2]);
    assert.ok(a.summaryChars > 300 && a.transcriptChars > 300);
    assert.deepEqual([b.by, b.titlePresent, b.titleHolds, b.reason], ['', false, [], 'No code, email or name was typed as the title']);
    leaks(JSON.stringify(r), 'the preview');
    leaks(w.logs.join('\n'), 'the logs');
    assert.ok(!JSON.stringify(r).includes('ot_AAA111') && !JSON.stringify(r).includes('9100012345'), 'not even the ids');
    // a second preview is the same: nothing was remembered
    assert.deepEqual((await S.runOnce({ mode: 'report' })).totals, r.totals);
    // a file that cannot be read: its problem is a status, never the message (which can quote the title)
    w.failRead.add('F-ot_AAA111');
    const r2 = await S.runOnce({ mode: 'report' });
    assert.deepEqual(r2.files.find((f) => f.decision === 'unreadable'), { created: '2026-11-12T19:01:00Z', decision: 'unreadable', problem: 'status 404' });
    leaks(JSON.stringify(r2), 'the preview with a failure');
  } finally { w.restore(); }
});

// ── on mode: exactly once ─────────────────────────────────────────────────────
test('on mode files a certain match exactly once — across two runs, after a restart, and after the saved list is lost', async () => {
  const w = standard();
  try {
    w.mode('on');
    const r1 = await S.runOnce();
    assert.deepEqual(r1.totals, { file: 1, filed: 1, needs: 1, unreadable: 0, failed: 0 });
    assert.deepEqual([w.posts.length, summaries(w).length], [2, 1], 'ONE summary — and, after it, the short entry that links the stored transcript');
    assert.deepEqual(w.posts.map((p) => p.leadId), ['9100012345', '9100012345']);
    assert.ok(w.posts[1].html.includes('Full transcript (in the client\'s folder): <a href="https://example.sharepoint.com/t/') && w.posts[1].html.endsWith('Otter transcript ref: ot_AAA111'));
    assert.equal(w.uploads.length, 1, 'the transcript went into the client folder');
    assert.deepEqual([w.uploads[0].folderId, w.uploads[0].filename, w.uploads[0].leadId], ['FOLDER1', 'Otter transcript 2026-11-12 ot_AAA111.txt', '9100012345']);
    assert.ok(w.uploads[0].text.includes('Hello and welcome') && w.uploads[0].text.length > 300, 'the whole transcript');
    assert.equal(w.writes, 1, 'the saved list is written once');
    assert.deepEqual(w.store.data.recs.ot_AAA111, { d: 'filed', leadId: '9100012345', by: 'code', at: new Date(NOW).toISOString() });
    assert.deepEqual([w.store.data.recs.ot_BBB222.d, w.store.data.recs.ot_BBB222.reasonKey, w.store.data.recs.ot_BBB222.fileId], ['needs', 'noTitle', 'F-ot_BBB222']);
    leaks(JSON.stringify(w.store.data), 'the saved list (ids and decisions only)');
    leaks(w.logs.join('\n'), 'the logs');

    const r2 = await S.runOnce();
    assert.deepEqual([r2.alreadyDecided, r2.files.length, w.posts.length, w.writes], [2, 0, 2, 1], 'second run: nothing to do, nothing written');
    assert.equal(w.reads.length, 2, 'a decided file is not even opened again');

    S._reset();   // a restart: nothing in memory
    await S.runOnce();
    assert.equal(w.posts.length, 2);

    w.store = null;   // the saved list is lost — the lead's own updates are the proof
    S._reset();
    const r4 = await S.runOnce();
    assert.deepEqual([w.posts.length, w.uploads.length], [2, 1], 'never posted twice, never stored twice');
    assert.deepEqual([r4.totals.filed, r4.files.find((f) => f.filed).alreadyOnRecord], [1, true]);
    assert.equal(w.store.data.recs.ot_AAA111.d, 'filed', 'the saved list is rebuilt from the proof');
  } finally { w.restore(); }
});

test('the Otter files are never changed: the service has no write, move or delete on them, and never logs or returns their text', () => {
  const src = read('src/services/otterReaderService.js') + read('src/services/otterMatch.js') + read('src/utils/recordingCode.js');
  assert.ok(!/axios/.test(src), 'no HTTP of its own: the folder is read through otterFilesService.io (GET only)');
  assert.ok(!/\.(post|put|patch|delete)\(/.test(src.replace(/_view\.delete\(|_busy\.delete\(/g, '')), 'no write verbs');
  const files = read('src/services/otterFilesService.js');
  assert.ok(!/axios\.(post|put|patch|delete)/.test(files));
  for (const m of src.match(/console\.(log|warn|error)\([^\n]*/g) || []) assert.ok(!/title|name\b|email|summary|transcript\b.*\$\{f\.|\.message/.test(m.replace(/the transcript could not go into the client folder/, '')), 'a log line carries counts and ids only: ' + m);
  assert.ok(S.STATE_PATH.startsWith('TDOT System/') && !/Otter Recordings/i.test(S.STATE_PATH), 'the saved list is not in the recordings folder');
  assert.match(read('src/services/emailLeadsService.js'), /readJsonFile\(STATE_PATH\)/, 'the same storage as the email → lead list');
  assert.match(src, /readJsonFile\(STATE_PATH\)/); assert.match(src, /writeJsonFile\(STATE_PATH, data, \{ etag \}\)/);
});

test('one bad file never stops the others; it is tried again on the next runs, a bounded number of times', async () => {
  const w = standard();
  try {
    w.mode('on');
    w.files.unshift({ id: 'F-ot_BAD000', name: `${START} - ot_BAD000 - Priya Example.txt`, size: 100, createdDateTime: '2026-11-12T18:00:00Z' });
    w.files.push({ id: 'F-ot_BIG000', name: `${START} - ot_BIG000 - x.txt`, size: 4 * 1024 * 1024, createdDateTime: '2026-11-12T19:09:00Z' });
    w.files.push({ id: 'F-ot_MIX000', name: `${START} - ot_MIX000 - x.txt`, size: 100, createdDateTime: '2026-11-12T19:09:30Z' });
    w.texts['F-ot_MIX000'] = fileText({ id: 'ot_SOMEONE_ELSE', start: START });
    w.failRead.add('F-ot_BAD000');
    const r = await S.runOnce();
    assert.deepEqual(r.totals, { file: 1, filed: 1, needs: 1, unreadable: 3, failed: 0 });
    assert.deepEqual([w.posts.length, summaries(w).length], [2, 1], 'the good file after the bad one was still filed');
    assert.deepEqual(r.files.filter((f) => f.decision === 'unreadable').map((f) => f.problem), ['status 404', 'TOO_LARGE', 'ID_MISMATCH']);
    assert.ok(!w.reads.includes('F-ot_BIG000'), 'a file over the size cap is never opened');
    assert.deepEqual([w.store.data.recs.ot_BAD000.d, w.store.data.recs.ot_BAD000.tries], ['failed', 1]);
    leaks(JSON.stringify(r) + w.logs.join('\n'), 'the answer and the logs');
    // the file becomes readable: the next run takes it
    w.failRead.clear(); w.texts['F-ot_BAD000'] = fileText({ id: 'ot_BAD000', title: 'Omar Sample', start: at('2026-11-12 15:05') });
    const r2 = await S.runOnce();
    assert.equal(w.store.data.recs.ot_BAD000.d, 'filed');
    assert.deepEqual([w.posts.length, w.posts[2].leadId, r2.totals.filed], [4, '9100022222', 1], 'no folder on that lead: the summary and a transcript entry');
    // one that never becomes readable is given up after MAX_TRIES runs
    for (let i = 0; i < S.MAX_TRIES + 2; i++) await S.runOnce();
    assert.equal(w.store.data.recs.ot_BIG000.tries, S.MAX_TRIES);
    assert.equal((await S.runOnce()).gaveUp, 2);
  } finally { w.restore(); }
});

test('a save that fails is not counted as done: nothing is listed as filed, it is tried again, and after the last try a person takes over', async () => {
  const w = standard();
  try {
    w.mode('on');
    w.failPost = 1;
    const r = await S.runOnce();
    assert.deepEqual([r.totals.filed, r.totals.failed, w.posts.length], [0, 1, 0]);
    assert.equal(w.uploads.length, 0, 'the summary is not on the lead: nothing went into the client\'s folder');
    assert.deepEqual([w.store.data.recs.ot_AAA111.d, w.store.data.recs.ot_AAA111.what], ['failed', 'save']);
    assert.equal(r.files.find((f) => f.filed === false).problem, 'error', 'no message text');
    leaks(JSON.stringify(r) + w.logs.join('\n'), 'the answer and the logs');
    await S.runOnce();
    assert.deepEqual([w.posts.length, summaries(w).length, w.uploads.length, w.store.data.recs.ot_AAA111.d], [2, 1, 1, 'filed']);

    // the lead's updates cannot be read: nothing is posted blind
    const w2 = standard(); w2.mode('on'); w2.failFiledOn = true;
    for (let i = 0; i < S.MAX_TRIES; i++) await S.runOnce();
    assert.equal(w2.posts.length, 0);
    assert.deepEqual([w2.store.data.recs.ot_AAA111.d, w2.store.data.recs.ot_AAA111.reasonKey, w2.store.data.recs.ot_AAA111.candidates[0]], ['needs', 'saveFailed', '9100012345']);
    // the saved list cannot be written: said plainly; the next run posts nothing twice
    const w3 = standard(); w3.mode('on'); w3.failWrite = 1;
    const r3 = await S.runOnce();
    assert.deepEqual([r3.ok, r3.stateSaved, w3.posts.length, w3.store], [false, false, 2, null]);
    await S.runOnce();
    assert.deepEqual([w3.posts.length, w3.store.data.recs.ot_AAA111.d], [2, 'filed']);
    // the board or the saved list cannot be read: nothing is decided at all
    const w4 = standard(); w4.mode('on'); w4.failConsults = true;
    const r4 = await S.runOnce();
    assert.deepEqual([r4.ok, r4.files.length, w4.posts.length, w4.writes], [false, 0, 0, 0]);
    w4.failConsults = false; S.io.readState = async () => { const e = new Error('not JSON'); e.corrupt = true; throw e; };
    assert.deepEqual([(await S.runOnce()).ok, w4.posts.length], [false, 0]);
  } finally { world().restore(); }
});

test('one run at a time: a second caller gets "already running"; a change made to the saved list meanwhile is kept', async () => {
  const w = standard();
  try {
    w.mode('on');
    let release; const gate = new Promise((r) => { release = r; });
    const list = S.io.listFiles;
    S.io.listFiles = async () => { await gate; return list(); };
    const first = S.runOnce();
    const second = await S.runOnce();
    assert.deepEqual([second.ok, second.outcome], [false, 'already running']);
    assert.deepEqual((await S.runOnce({ mode: 'report' })).outcome, 'already running');
    assert.equal(S.status().running, true);
    w.conflictOnce = true;   // someone else wrote the list between this run's read and its write
    release();
    const r = await first;
    assert.equal(r.totals.filed, 1);
    assert.equal(S.status().running, false);
    assert.deepEqual(Object.keys(w.store.data.recs).sort(), ['ot_AAA111', 'ot_BBB222', 'ot_OTHER'], 'the other change survived (read again, edit re-applied)');
    assert.equal((await S.runOnce()).ok, true, 'the lock is released');
  } finally { w.restore(); }
});

// ── the entry on the lead ─────────────────────────────────────────────────────
test('the entry: the Otter heading with the Toronto time and how it was matched, the four parts, the links, the machine line — everything escaped', () => {
  const f = { otterId: 'ot_AAA111', startTime: at('2026-11-12 14:02'), abstractSummary: 'Short <b>one</b> & "two"', summary: 'Line 1\nLine <script>alert(1)</script>', outline: '[A, B]', actionItems: 'No data', transcript: 'x', otterLink: 'https://otter.ai/u/ot_AAA111' };
  const html = S.buildSummaryEntry(f, { by: 'code' });
  assert.ok(html.startsWith(U.OTTER_HEADER + ' — recorded 12 Nov 2026, 2:02 pm (Toronto) · matched by code'), html.slice(0, 120));
  assert.ok(U.isStaffTypedEntry(html), 'the automations that look for marker phrases skip it, like a pasted summary');
  assert.ok(html.includes('<b>In short</b><br>Short &lt;b&gt;one&lt;/b&gt; &amp; &quot;two&quot;'));
  assert.ok(html.includes('<b>Summary</b><br>Line 1<br>Line &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('<b>Outline</b><br>[A, B]'));
  assert.ok(!html.includes('Action items'), 'an empty part ("No data") is left out');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('Recording in Otter: <a href="https://otter.ai/u/ot_AAA111">https://otter.ai/u/ot_AAA111</a>'));
  assert.ok(!html.includes('Full transcript') && !html.includes('Otter transcript ref'), 'the summary never carries the transcript link: the file is stored only after this entry is on the lead');
  assert.equal(S.buildTranscriptLinkEntry(f, 'https://example.sharepoint.com/t/a b"c'), '', 'a link with a space or a quote in it is not a link');
  assert.ok(html.endsWith('Otter recording ref: ot_AAA111'));
  const refs = U.otterRefsIn(html);
  assert.deepEqual([[...refs.recordings], [...refs.transcripts]], [['ot_AAA111'], []]);
  const withT = S.buildSummaryEntry(f, { who: 'Staff [Member]\nX' });
  assert.ok(withT.includes('· assigned by Staff Member X<br>'), 'the name on one line, no brackets');
  // with the transcript stored: a short entry of its own links it and carries the transcript mark (review 2: it is posted after the summary)
  const linkE = S.buildTranscriptLinkEntry(f, 'https://example.sharepoint.com/t/abc');
  assert.ok(linkE.startsWith(U.OTTER_HEADER + ' (transcript) — recorded 12 Nov 2026, 2:02 pm (Toronto)<br>Full transcript (in the client\'s folder): <a href="https://example.sharepoint.com/t/abc">'), linkE.slice(0, 160));
  assert.ok(linkE.endsWith('Otter transcript ref: ot_AAA111') && U.isStaffTypedEntry(linkE));
  assert.deepEqual([[...U.otterRefsIn(linkE).recordings], [...U.otterRefsIn(linkE).transcripts], [...U.otterRefsIn(withT).transcripts]], [[], ['ot_AAA111'], []]);
  // Monday's plain-text copy of the entry still carries the marks
  assert.deepEqual([...U.otterRefsIn(U.htmlToText(withT)).recordings], ['ot_AAA111']);
  // only an https://otter.ai/ address is linked
  for (const bad of ['http://otter.ai/u/x', 'https://otter.ai.evil.example/u/x', 'https://evil.example/otter.ai/', 'javascript:alert(1)', 'https://otter.ai/u/x" onclick="x', 'https://user:pw@otter.ai/u/x', '', 'No data']) {
    assert.equal(S.otterLinkOf(bad), '', bad);
    assert.ok(!S.buildSummaryEntry({ ...f, otterLink: bad }, {}).includes('Recording in Otter'), bad);
  }
  assert.equal(S.otterLinkOf('https://otter.ai/u/abc_DEF-1?utm=x'), 'https://otter.ai/u/abc_DEF-1?utm=x');
  // nothing written by Otter: said so, still marked
  const empty = S.buildSummaryEntry({ otterId: 'ot_AAA111', startTime: 'x' }, { by: 'name' });
  assert.ok(empty.includes('recording time not known · matched by name') && empty.includes('Otter wrote no summary') && empty.endsWith('Otter recording ref: ot_AAA111'));
});

test('the size limit: the written parts stay inside the cap the pasted Otter summary has; the transcript entry holds what one update can', () => {
  const big = { otterId: 'ot_AAA111', startTime: at('2026-11-12 14:02'), abstractSummary: 'A'.repeat(500), summary: 'S'.repeat(30000), outline: 'O'.repeat(30000), actionItems: 'I'.repeat(500), transcript: 'T'.repeat(45000) };
  const html = S.buildSummaryEntry(big, { by: 'code' });
  assert.ok(U.htmlToText(html).length <= U.MAX_OTTER, 'inside MAX_OTTER (' + U.htmlToText(html).length + ')');
  assert.ok(html.includes('(cut here — the full text is in Otter)') && html.includes('A'.repeat(500)) && html.includes('I'.repeat(500)), 'the short parts are whole; the long one says it was cut');
  assert.ok(html.endsWith('Otter recording ref: ot_AAA111'), 'the machine line is never cut off');
  const t = S.buildTranscriptEntry(big);
  assert.ok(t.startsWith(U.OTTER_HEADER + ' (transcript, part 1 of 3) — recorded 12 Nov 2026, 2:02 pm (Toronto)'));
  assert.ok(U.isStaffTypedEntry(t));
  assert.ok(U.htmlToText(t).length <= U.MAX_OTTER);
  assert.ok(t.includes('The rest of the transcript is in Otter.') && t.endsWith('Otter transcript ref: ot_AAA111'));
  const small = S.buildTranscriptEntry({ ...big, transcript: 'Speaker <1>\nhello' });
  assert.ok(small.includes('(transcript, part 1 of 1)') && small.includes('Speaker &lt;1&gt;<br>hello') && !small.includes('The rest of'));
  assert.equal(S.minutesLong('Speaker 1  0:01\nhi\nSpeaker 2  34:40\nbye'), 35);
  assert.equal(S.minutesLong('Speaker 1  1:02:10\nbye'), 62);
  assert.equal(S.minutesLong('no stamps here'), null);
});

test('filing: with a client folder the transcript is stored there and linked; with none (or when the folder fails) it is a second entry — and a retry adds only what is missing', async () => {
  const w = world({ folders: { 9100012345: 'FOLDER1' } });
  try {
    const f = { otterId: 'ot_AAA111', startTime: START, summary: 'Sum', transcript: 'Hello there', otterLink: 'https://otter.ai/u/ot_AAA111' };
    const a = await S.fileOn('9100012345', f, { by: 'code' });
    assert.deepEqual(a, { ok: true, posted: 2, already: false, transcript: 'folder' });
    assert.ok(w.posts[0].html.endsWith('Otter recording ref: ot_AAA111') && !w.posts[0].html.includes('Full transcript'), 'first the summary');
    assert.ok(w.posts[1].html.includes('Full transcript (in the client\'s folder): <a href="https://example.sharepoint.com/t/') && w.posts[1].html.endsWith('Otter transcript ref: ot_AAA111'), 'then the entry that links the stored file');
    assert.deepEqual(await S.fileOn('9100012345', f, { by: 'code' }), { ok: true, posted: 0, already: true, transcript: 'kept' });
    assert.deepEqual([w.posts.length, w.uploads.length], [2, 1], 'a second call adds nothing and uploads nothing');

    const b = await S.fileOn('9100022222', f, { who: 'Staff Member' });
    assert.deepEqual(b, { ok: true, posted: 2, already: false, transcript: 'update' });
    assert.ok(w.posts[2].html.includes('assigned by Staff Member') && !w.posts[2].html.includes('Full transcript'));
    assert.ok(w.posts[3].html.includes('(transcript, part 1 of 1)') && w.posts[3].html.includes('Hello there'));
    assert.equal(w.uploads.length, 1, 'no folder is ever made for it');

    // the summary landed, the transcript entry did not: the retry posts only the transcript
    w.posts.length = 0; w.failPost = 0;
    const post = S.io.postEntry; let n = 0;
    S.io.postEntry = async (id, html) => { if (++n === 2) throw new Error('boom'); return post(id, html); };
    await assert.rejects(S.fileOn('9100033333', f, { by: 'name' }));
    assert.equal(w.posts.length, 1);
    const again = await S.fileOn('9100033333', f, { by: 'name' });
    assert.deepEqual([again.posted, w.posts.length], [1, 2]);
    assert.ok(w.posts[1].html.includes('(transcript, part'));
    S.io.postEntry = post;

    // the folder cannot be written: the transcript is not lost
    w.posts.length = 0; w.failUpload = true;
    const c = await S.fileOn('9100012345', { ...f, otterId: 'ot_CCC333' }, { by: 'code' });
    assert.deepEqual([c.posted, c.transcript], [2, 'update']);
    // no transcript at all: one entry
    assert.deepEqual(await S.fileOn('9100012345', { ...f, otterId: 'ot_DDD444', transcript: '' }, { by: 'code' }), { ok: true, posted: 1, already: false, transcript: 'none' });
    await assert.rejects(S.fileOn('abc', f, {}));
    await assert.rejects(S.fileOn('9100012345', { ...f, otterId: 'bad id!' }, {}));
  } finally { w.restore(); }
});

// ── updatesService: the marks and the single send ─────────────────────────────
test('updatesService: the proof is read from the item\'s own updates (HTML or plain text); the entry is sent ONCE with Monday\'s own retry off', async () => {
  const orig = mondayApi.query;
  const calls = [];
  try {
    mondayApi.query = async (gql, vars, retries) => {
      calls.push({ gql, vars, retries });
      if (/create_update/.test(gql)) return { create_update: { id: '1' } };
      return { items: [{ id: '55', updates: [
        { id: 'u1', body: `${U.OTTER_HEADER} — x<br>Otter recording ref: ot_AAA111<br>Otter transcript ref: ot_AAA111`, text_body: '' },
        { id: 'u2', body: '', text_body: '🎙 Consultation summary (Otter) (transcript, part 1 of 2) hello Otter transcript ref: ot_BBB222' },
        { id: 'u3', body: '<p>an ordinary note</p>', text_body: 'an ordinary note' },
      ] }] };
    };
    const got = await U.getOtterFiled('55');
    assert.deepEqual([[...got.recordings], [...got.transcripts].sort()], [['ot_AAA111'], ['ot_AAA111', 'ot_BBB222']]);
    await assert.rejects(U.getOtterFiled('x'));
    await U.postOtterEntry('55', `${U.OTTER_HEADER} — y`);
    const sent = calls[calls.length - 1];
    assert.deepEqual([sent.vars.i, sent.retries], ['55', 0], 'no automatic re-send: it could store a second copy');
    await assert.rejects(U.postOtterEntry('55', '<b>anything else</b>'), /Not an Otter entry/);
    await assert.rejects(U.postOtterEntry('5 5', U.OTTER_HEADER));
    mondayApi.query = async () => ({ items: [] });
    await assert.rejects(U.getOtterFiled('55'), (e) => e.notFound === true, 'a record that is gone is not "nothing filed"');
  } finally { mondayApi.query = orig; }
});

test('the record page\'s Updates: a filed Otter entry keeps its heading, its line breaks and its links; other entries are read as before', async () => {
  const orig = mondayApi.query;
  const w0 = world();
  try {
    const rec0 = { otterId: 'ot_AAA111', startTime: START, abstractSummary: 'Short one', summary: 'L1\nL2', otterLink: 'https://otter.ai/u/ot_AAA111' };
    const html = S.buildSummaryEntry(rec0, { by: 'code' });
    mondayApi.query = async () => ({ items: [{ updates: [
      { id: '0', body: S.buildTranscriptLinkEntry(rec0, 'https://example.sharepoint.com/t/abc'), text_body: 'collapsed by Monday', created_at: '2026-11-12T20:00:01Z', creator: { name: 'App' }, replies: [] },
      { id: '1', body: html, text_body: 'collapsed by Monday', created_at: '2026-11-12T20:00:00Z', creator: { name: 'App' }, replies: [] },
      { id: '2', body: '<p>Typed <b>note</b></p>', text_body: 'Typed note', created_at: '2026-11-12T19:00:00Z', creator: { name: 'Staff' }, replies: [] },
    ] }] });
    const all = await U.getUpdatesForItem('55');
    assert.deepEqual(all[0].body.split('\n'), ['🎙 Consultation summary (Otter) (transcript) — recorded 12 Nov 2026, 2:02 pm (Toronto)', 'Full transcript (in the client\'s folder): https://example.sharepoint.com/t/abc', 'Otter transcript ref: ot_AAA111'], 'the entry that links the stored transcript');
    const ups = all.slice(1);
    assert.equal(ups[1].body, 'Typed note', 'an ordinary entry: Monday\'s text, unchanged');
    const lines = ups[0].body.split('\n');
    assert.equal(lines[0], '🎙 Consultation summary (Otter) — recorded 12 Nov 2026, 2:02 pm (Toronto) · matched by code');
    assert.ok(lines.includes('In short') && lines.includes('Short one') && lines.includes('L1') && lines.includes('L2'));
    assert.ok(lines.includes('Recording in Otter: https://otter.ai/u/ot_AAA111'));
    assert.ok(!ups[0].body.includes('<'), 'plain text for the page (it is put there with textContent)');
  } finally { mondayApi.query = orig; w0.restore(); }
  // the widget turns the addresses the server NAMED into links — with DOM nodes, never innerHTML (review 2026-11-14: no other address)
  const { UPDATES_WIDGET_JS } = require('../src/routes/updatesWidget');
  const a = UPDATES_WIDGET_JS.indexOf('  function fillBody(node, text, allowed){'), b = UPDATES_WIDGET_JS.indexOf('  function renderOne(');
  assert.ok(a > 0 && b > a);
  const block = UPDATES_WIDGET_JS.slice(a, b);
  assert.ok(!block.includes('innerHTML') && !block.includes('\\') && !block.includes('`'));
  const mk = (tag) => ({ tag, kids: [], appendChild(k) { this.kids.push(k); } });
  const ctx = { document: { createElement: (t) => mk(t), createTextNode: (t) => ({ text: t }) } };
  vm.runInNewContext(block + '\nthis.fillBody = fillBody;', ctx);
  const node = mk('div');
  ctx.fillBody(node, 'Recording in Otter: https://otter.ai/u/abc.\nSee <b>http://plain.example</b> and javascript:alert(1) https:// (https://example.com/a?b=1).', ['https://otter.ai/u/abc']);
  const links = node.kids.filter((k) => k.tag === 'a');
  assert.deepEqual(links.map((l) => [l.href, l.textContent, l.target, l.rel]), [
    ['https://otter.ai/u/abc', 'https://otter.ai/u/abc', '_blank', 'noopener noreferrer'],
  ], 'only the named address is a link — https://example.com/a?b=1 stays text');
  const none = mk('div'); ctx.fillBody(none, 'https://otter.ai/u/abc and https://example.com/a');
  assert.equal(none.kids.filter((k) => k.tag === 'a').length, 0, 'no list of named addresses: no link at all');
  assert.equal(node.kids.map((k) => (k.tag ? k.textContent : k.text)).join(''), 'Recording in Otter: https://otter.ai/u/abc.\nSee <b>http://plain.example</b> and javascript:alert(1) https:// (https://example.com/a?b=1).', 'not one character lost or added');
  const plain = mk('div'); ctx.fillBody(plain, 'no links here'); assert.deepEqual(plain.kids, [{ text: 'no links here' }]);
});

// ── the "to match" list and its two buttons ───────────────────────────────────
const NAMED = { name: 'Staff Member', email: 'staff@example.com', verified: true };
test('the "to match" list: what staff need to recognise the client, the reason in plain words, the suggestions — and nothing while there is nothing', async () => {
  const w = standard();
  try {
    w.mode('on');
    assert.deepEqual(await S.needsList(), { on: true, items: [] });
    await S.runOnce();
    w.texts['F-ot_BBB222'] = fileText({ id: 'ot_BBB222', start: START, title: 'Team catch up', abstract: 'Q'.repeat(450) });
    S._reset();   // after a restart the list is read from the saved list and the file
    const list = await S.needsList();
    assert.equal(list.on, true);
    assert.equal(list.items.length, 1);
    const it = list.items[0];
    assert.deepEqual([it.otterId, it.when, it.minutes, it.title, it.reason, it.fileRead], ['ot_BBB222', '2026-11-12 14:02', 34, 'Team catch up', 'No code, email or name was typed as the title', true]);
    assert.equal(it.snippet, 'Q'.repeat(200), 'the first 200 characters of the summary');
    assert.deepEqual(it.candidates, [
      { id: '9100012345', name: 'Priya Example', bookedSlot: '2026-11-12 14:00', consultant: 'Consultant One', code: 'TD-12345' },
      { id: '9100022222', name: 'Omar Sample', bookedSlot: '2026-11-12 14:30', consultant: 'Consultant Two', code: 'TD-22222' },
    ], 'the consultations booked around the recording, the nearest first — no email');
    assert.ok(!JSON.stringify(list).includes('@example.com') && !JSON.stringify(list).includes('ZZTOPSECRET'), 'no email, no transcript');
    for (const x of list.items) assert.ok(!/\b(API|Zap|state|reader)\b/i.test(x.reason));
    leaks(w.logs.join('\n'), 'the logs');
    // the file cannot be opened: the row still shows, with what the saved list knows
    S._reset(); w.failRead.add('F-ot_BBB222');
    const l2 = await S.needsList();
    assert.deepEqual([l2.items[0].fileRead, l2.items[0].title, l2.items[0].snippet, l2.items[0].candidates.length], [false, '', '', 2]);
  } finally { w.restore(); }
});

test('"Save to this client": a named staff member only; files once ("assigned by …"); refuses unknown recordings and consultations; a second press adds nothing', async () => {
  const w = standard();
  try {
    w.mode('on');
    await S.runOnce();
    const before = w.posts.length;
    const refuse = async (args, status, re) => assert.rejects(S.assign(args), (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.message, re); return true; });
    await refuse({ otterId: 'ot_BBB222', leadId: '9100022222', actor: { name: 'Typed Name', verified: false } }, 401, /Sign in with Monday/);
    await refuse({ otterId: 'ot_BBB222', leadId: '9100022222', actor: null }, 401);
    await refuse({ otterId: 'ot_NOPE999', leadId: '9100022222', actor: NAMED }, 404);
    await refuse({ otterId: '../../x', leadId: '9100022222', actor: NAMED }, 404);
    await refuse({ otterId: 'ot_BBB222', leadId: '9100077777', actor: NAMED }, 404, /consultation was not found/);
    await refuse({ otterId: 'ot_BBB222', leadId: 'abc', actor: NAMED }, 400);
    await refuse({ otterId: 'ot_AAA111', leadId: '9100022222', actor: NAMED }, 409, /already saved on another consultation/);
    assert.equal(w.posts.length, before, 'a refusal posts nothing');

    const r = await S.assign({ otterId: 'ot_BBB222', leadId: '9100022222', actor: NAMED });
    assert.deepEqual([r.ok, r.already, r.transcript], [true, false, 'update']);
    assert.deepEqual(w.posts.slice(before).map((p) => p.leadId), ['9100022222', '9100022222']);
    assert.ok(w.posts[before].html.includes('· assigned by Staff Member<br>') && w.posts[before].html.endsWith('Otter recording ref: ot_BBB222'));
    assert.deepEqual(w.store.data.recs.ot_BBB222, { d: 'filed', leadId: '9100022222', by: 'staff', who: 'Staff Member', at: new Date(NOW).toISOString() });
    assert.deepEqual((await S.needsList()).items, [], 'it left the list');
    // again, the same client: fine, nothing added
    assert.deepEqual(await S.assign({ otterId: 'ot_BBB222', leadId: '9100022222', actor: NAMED }), { ok: true, already: true });
    assert.equal(w.posts.length, before + 2);
    assert.deepEqual([(await S.assign({ otterId: 'ot_AAA111', leadId: '9100012345', actor: NAMED })).already, w.posts.length], [true, before + 2]);
    leaks(w.logs.join('\n'), 'the logs');

    // the consultation already has this recording (the saved list did not know): nothing is added a second time
    const w2 = standard(); w2.mode('on');
    w2.store = { data: { version: 1, recs: { ot_BBB222: { d: 'needs', reasonKey: 'noTitle', candidates: [], firstSeen: NOW, fileId: 'F-ot_BBB222' } } }, etag: 'e0' };
    w2.posts.push({ leadId: '9100022222', html: `${U.OTTER_HEADER}<br>Otter recording ref: ot_BBB222<br>Otter transcript ref: ot_BBB222` });
    const again = await S.assign({ otterId: 'ot_BBB222', leadId: '9100022222', actor: NAMED });
    assert.deepEqual([again.ok, again.already, w2.posts.length, w2.store.data.recs.ot_BBB222.d], [true, true, 1, 'filed']);
    // failures say so in plain words and carry no content; while a save is in flight a second one is refused
    const w3 = standard(); w3.mode('on'); await S.runOnce(); w3.failPost = 5;
    await assert.rejects(S.assign({ otterId: 'ot_BBB222', leadId: '9100022222', actor: NAMED }), (e) => { assert.equal(e.status, 502); leaks(e.message, 'the error'); return true; });
    assert.equal(w3.store.data.recs.ot_BBB222.d, 'needs', 'still on the list');
    S._busy.add('ot_BBB222');
    await assert.rejects(S.assign({ otterId: 'ot_BBB222', leadId: '9100022222', actor: NAMED }), (e) => e.status === 409 && /being saved right now/.test(e.message));
    S._busy.clear();
    w3.mode('off');
    await assert.rejects(S.assign({ otterId: 'ot_BBB222', leadId: '9100022222', actor: NAMED }), (e) => e.status === 409);
  } finally { world().restore(); }
});

test('"Not a consultation": a named staff member; it leaves the list, nothing is posted or deleted; only the admin restore brings it back', async () => {
  const w = standard();
  try {
    w.mode('on');
    await S.runOnce();
    const posts = w.posts.length;
    await assert.rejects(S.dismiss({ otterId: 'ot_BBB222', why: 'x', actor: { name: 'Typed', verified: false } }), (e) => e.status === 401);
    await assert.rejects(S.dismiss({ otterId: 'ot_NOPE999', actor: NAMED }), (e) => e.status === 404);
    await assert.rejects(S.dismiss({ otterId: 'ot_AAA111', actor: NAMED }), (e) => e.status === 409, 'a filed recording is not dismissed');
    assert.deepEqual(await S.dismiss({ otterId: 'ot_BBB222', why: '  team\n meeting ' + 'z'.repeat(300), actor: NAMED }), { ok: true });
    const e = w.store.data.recs.ot_BBB222;
    assert.deepEqual([e.d, e.who, e.at, e.why.length, e.why.startsWith('team meeting z')], ['dismissed', 'Staff Member', new Date(NOW).toISOString(), 200, true]);
    assert.deepEqual((await S.needsList()).items, []);
    assert.deepEqual(await S.dismiss({ otterId: 'ot_BBB222', actor: NAMED }), { ok: true, already: true });
    assert.equal(w.posts.length, posts, 'nothing is posted anywhere');
    await S.runOnce();
    assert.equal(w.store.data.recs.ot_BBB222.d, 'dismissed', 'a later run leaves it alone');
    await assert.rejects(S.assign({ otterId: 'ot_BBB222', leadId: '9100022222', actor: NAMED }), (x) => x.status === 404, 'not on the list any more');

    assert.deepEqual(await S.restore({ otterId: 'ot_BBB222' }), { ok: true, now: 'on the list to match' });
    assert.deepEqual([w.store.data.recs.ot_BBB222.d, w.store.data.recs.ot_BBB222.fileId, (await S.needsList()).items.length], ['needs', 'F-ot_BBB222', 1]);
    await assert.rejects(S.restore({ otterId: 'ot_AAA111' }), (x) => x.status === 409);
    await assert.rejects(S.restore({ otterId: 'ot_NOPE999' }), (x) => x.status === 404);
    // one given up on (or one waiting) is simply read again on the next run
    w.store.data.recs.ot_GONE000 = { d: 'failed', what: 'read', tries: 5 };
    assert.deepEqual(await S.restore({ otterId: 'ot_GONE000' }), { ok: true, now: 'will be read again on the next run' });
    assert.equal(w.store.data.recs.ot_GONE000, undefined);
  } finally { w.restore(); }
});

// ── the routes ────────────────────────────────────────────────────────────────
test('the routes: admin-only preview and restore, the list behind the /api gate, named staff for the two buttons — all "private, no-store"', () => {
  const src = read('src/server.js');
  const NS = String.raw`\s+res\.set\('Cache-Control', 'private, no-store'\);`;
  assert.match(src, new RegExp(String.raw`app\.get\('/admin/otter/reader/preview', async \(req, res\) => \{` + NS + String.raw`\s+if \(!resolveAdminOrReject\(req, res, [^)]*\)\) return;`));
  assert.match(src, /runOnce\(\{ mode: require\('\.\/services\/otterReaderService'\)\.mode\(\) === 'off' \? 'off' : 'report' \}\)/, 'the preview never runs in "on" mode, and reads nothing while switched off');
  assert.match(src, new RegExp(String.raw`app\.post\('/admin/otter/reader/restore/:otterId', async \(req, res\) => \{` + NS + String.raw`\s+if \(!resolveAdminOrReject\(`));
  assert.match(src, new RegExp(String.raw`app\.get\('/api/otter/needs-matching', async \(_req, res\) => \{` + NS));
  for (const what of ['assign', 'dismiss']) {
    assert.match(src, new RegExp(String.raw`app\.post\('/api/otter/needs-matching/:otterId/` + what + String.raw`', express\.json\(\), async \(req, res\) => \{` + NS + String.raw`\s+const actor = otterNamedStaffOrReject\(req, res, '[^']+'\);\s+if \(!actor\) return;`));
  }
  assert.match(src, /function otterNamedStaffOrReject\(req, res, what\) \{\s+const actor = staffActor\(req, ''\);\s+if \(!actor\.verified\) \{ res\.status\(401\)\.json\(\{ error: `Sign in with Monday to \$\{what\} — the shared admin key does not say who you are\.`, loginUrl: '\/q\/auth\/monday' \}\); return null; \}/,
    'the shared key alone is refused, in the app\'s usual words; a typed name is never accepted');
  const gate = src.indexOf("app.use('/api', requireApiKey)"), first = src.indexOf("app.get('/api/otter/needs-matching'");
  assert.ok(gate > 0 && first > gate, 'the /api routes sit behind the key gate, like /api/consultations-board');
  // no route hands an error message of its own making to the page (it could quote a file name)
  const block = src.slice(src.indexOf("app.get('/admin/otter/reader/preview'"), src.indexOf('// ─── Otter API key'));
  assert.ok(!/console\./.test(block), 'the routes log nothing');
  assert.ok(!/err\.message\b(?!\s*:)/.test(block.replace(/err\.status \? err\.message/g, '')), 'only the service\'s own plain refusals (with a status) reach the page');
  // the named-staff rule itself (the pure helper the route uses)
  const { actorFromStaff } = require('../src/utils/staffIdentity');
  assert.equal(actorFromStaff(null, 'Typed Name').verified, false);
  assert.equal(actorFromStaff({ name: 'Staff Member', email: 'staff@example.com' }, '').verified, true);
});

// ── the pages ─────────────────────────────────────────────────────────────────
function scriptsParse(html, page) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html))) { n++; try { new vm.Script(m[1]); } catch (err) { assert.fail(`${page}: emitted <script> #${n} does not parse — ${err.message}`); } }
  assert.ok(n >= 1, page);
  return n;
}

test('the Consultations page: the strip sits above the tabs and is hidden until there is something to match; the code shows under the client\'s name; every script parses', () => {
  const { buildQueueHTML } = require('../src/routes/adminConsultation');
  const html = buildQueueHTML();
  scriptsParse(html, 'consultations');
  const strip = html.indexOf('<section id="om-strip" class="om-strip" hidden'), tabs = html.indexOf('id="cq-tabs"');
  assert.ok(strip > 0 && tabs > strip, 'above the tabs, hidden from the start');
  assert.ok(html.includes('aria-expanded="true" aria-controls="om-body"') && html.includes('Otter recordings to match'));
  assert.ok(html.includes("tdotOtterMatchMount({ rows: function(){ return ALLROWS; }, signIn: '/q/auth/monday?returnTo=%2Fadmin%2Fconsultations' });"));
  assert.ok(html.includes("(c.recCode?'<span class=\"rec-code\""), 'the code under the client\'s name, in the one row builder every tab uses');
  assert.ok(html.includes('.rec-code { display:block; font-size:11px;'));
  assert.ok(html.includes('@media (max-width:760px){ .om-row { grid-template-columns:minmax(0,1fr); } }'), 'one column on a narrow screen');
  // the Leads and Retainers pages are untouched
  const { buildRetainersHTML } = require('../src/routes/adminConsultation');
  assert.ok(!buildRetainersHTML().includes('om-strip') && !buildRetainersHTML().includes('rec-code'));
  assert.ok(!read('src/routes/adminLeads.js').includes('recCode') && !read('src/routes/adminLeads.js').includes('recordingCode'));
});

test('the strip\'s code: template-literal safe, textContent only, keyboard reachable, plain wording — and it works in a page (rows, save, not a consultation)', async () => {
  const { OTTER_MATCH_JS, OTTER_MATCH_CSS, otterMatchHtml } = require('../src/routes/otterMatchWidget');
  for (const [name, text] of [['js', OTTER_MATCH_JS], ['css', OTTER_MATCH_CSS], ['html', otterMatchHtml()]]) {
    assert.ok(!text.includes('`') && !text.includes('${') && !text.includes('\\'), name + ': no backtick, no dollar-brace, no backslash');
  }
  assert.ok(!/innerHTML\s*=\s*[^"]/.test(OTTER_MATCH_JS.replace(/innerHTML = ""/g, '')), 'innerHTML only ever to empty a box');
  // staff-facing words: never "API", "Zap", "state" or "reader"
  const shown = (otterMatchHtml() + ' ' + (OTTER_MATCH_JS.match(/"[^"]*"/g) || []).join(' ')).replace(/X-Api-Key|aria-[a-z]+|"\/api\/[a-z\/-]*"/g, '');   // the header name and the address are not words on screen
  assert.ok(!/\b(API|Zap|state|reader)\b/i.test(shown), 'plain words on screen');
  for (const words of ['Save to this client', 'Not a consultation', 'No title', 'Saving…', 'Choose the client first.', 'Sign in with Monday']) assert.ok(OTTER_MATCH_JS.includes(words), words);
  assert.ok(OTTER_MATCH_JS.includes('tdotDialogNew({ cls: "tdlg-narrow", labelledBy: "om-dlg-title" })'), 'the confirm is the shared pop-up');

  // a small stand-in for the page: enough DOM to mount the strip and press its buttons
  const byId = {};
  function mk(tag) {
    const e = { tag, kids: [], attrs: {}, className: '', hidden: false, disabled: false, value: '', _text: '',
      appendChild(k) { k.parentNode = e; e.kids.push(k); return k; },
      removeChild(k) { e.kids.splice(e.kids.indexOf(k), 1); k.parentNode = null; },
      setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return k in e.attrs ? e.attrs[k] : null; },
      focus() { e.focused = true; },
      querySelector() { const walk = (n) => { for (const k of n.kids || []) { if (k.tag === 'select' || k.tag === 'button') return k; const d = walk(k); if (d) return d; } return null; }; return walk(e); },
      get textContent() { return e._text + e.kids.map((k) => (k.tag ? k.textContent : k.text)).join(''); },
      set textContent(v) { e._text = String(v); e.kids = []; },
      set innerHTML(v) { e._text = ''; e.kids = []; }, get innerHTML() { return ''; },
      get options() { return e.kids; }, get selectedIndex() { return Math.max(0, e.kids.findIndex((k) => k.value === e.value)); },
    };
    Object.defineProperty(e, 'id', { set(v) { e._id = v; byId[v] = e; }, get() { return e._id; } });
    return e;
  }
  for (const id of ['om-strip', 'om-list', 'om-n', 'om-toggle', 'om-body', 'om-top', 'om-hint', 'om-done']) { const e = mk('div'); e.id = id; }
  byId['om-strip'].hidden = true; byId['om-toggle'].attrs['aria-expanded'] = 'true'; byId['om-done'].hidden = true;
  const sent = [];
  const items = [
    { otterId: 'ot_BBB222', when: '2026-11-12 14:02', minutes: 34, title: '', snippet: 'First words of the summary', reason: 'No code, email or name was typed as the title', fileRead: true,
      candidates: [{ id: '9100012345', name: 'Priya Example', bookedSlot: '2026-11-12 14:00', consultant: 'Consultant One', code: 'TD-12345' }] },
    { otterId: 'ot_CCC333', when: '2026-11-11 10:00', minutes: null, title: '<img src=x onerror=alert(1)>', snippet: '', reason: 'Very short recording', fileRead: true, candidates: [] },
  ];
  let answer = { s: 200, j: { ok: true } };
  const ctx = {
    document: { getElementById: (id) => byId[id] || null, createElement: mk, createTextNode: (t) => ({ text: String(t) }) },
    window: {}, Intl, Date, Number, String, JSON, Math, encodeURIComponent, setTimeout: (fn) => fn(), sessionStorage: { getItem: () => null, setItem() {} },
    peekKey: () => 'KEY',
    fetch: async (url, opts) => {
      if (!opts || !opts.method) return { ok: true, json: async () => ({ on: true, items }) };
      sent.push({ url, body: JSON.parse(opts.body), key: opts.headers['X-Api-Key'] });
      return { status: answer.s, json: async () => answer.j };
    },
    tdotDialogNew: () => { const box = mk('div'); ctx.dlg = { box, tryClose() { ctx.dlg.closed = 'cancel'; }, close() { ctx.dlg.closed = 'yes'; } }; return ctx.dlg; },
  };
  vm.runInNewContext(OTTER_MATCH_JS + '\ntdotOtterMatchMount({ rows: function(){ return ROWS; } });', Object.assign(ctx, { ROWS: [{ id: '9100022222', name: 'Omar Sample', bookedSlot: '2026-11-12 15:00', consultant: 'Consultant Two', recCode: 'TD-22222' }] }));
  const tick = () => new Promise((r) => setImmediate(r));
  await tick(); await tick();
  const strip = byId['om-strip'], list = byId['om-list'];
  assert.equal(strip.hidden, false, 'shown once there are rows');
  assert.equal(byId['om-n'].textContent, '(2)');
  assert.equal(list.kids.length, 2);
  const row = list.kids[0], left = row.kids[0], pick = row.kids[1];
  assert.match(left.kids[0].textContent, /Nov\.? 12, 2026, 14:02 · about 34 min$/);
  assert.equal(left.kids[1].textContent, 'No title');
  assert.equal(left.kids[2].textContent, 'First words of the summary');
  assert.equal(list.kids[1].kids[0].kids[1].textContent, '<img src=x onerror=alert(1)>', 'a typed title is text, never markup');
  const [, search, label, sel, acts, msg] = pick.kids;
  assert.equal(label.textContent, 'Client (suggested)');
  assert.equal(sel.kids.length, 1);
  assert.match(sel.kids[0].textContent, /^Priya Example · .*14:00 · TD-12345 · Consultant One$/, 'name, booked time, code, consultant');
  assert.equal(label.htmlFor, sel.id, 'the picker has a label');
  // the search finds any consultation by name or code
  search.value = 'td-222'; search.oninput();
  assert.deepEqual(sel.kids.map((k) => k.value), ['9100022222']);
  search.value = 'nobody'; search.oninput();
  assert.deepEqual(sel.kids.map((k) => [k.value, k.textContent]), [['', 'No consultation with that name']]);
  sel.value = '';
  acts.kids[0].onclick();
  assert.equal(msg.textContent, 'Choose the client first.');
  assert.equal(sent.length, 0, 'nothing is sent without a client');
  search.value = ''; search.oninput(); sel.value = '9100012345';
  // a refusal (not signed in with Monday): the words from the server and a sign-in link; the row stays
  answer = { s: 401, j: { error: 'Sign in with Monday to save an Otter recording to a client — the shared admin key does not say who you are.', loginUrl: '/q/auth/monday' } };
  acts.kids[0].onclick();
  assert.equal(acts.kids[0].disabled, true, 'busy while saving');
  await tick(); await tick();
  assert.deepEqual(sent[0], { url: '/api/otter/needs-matching/ot_BBB222/assign', body: { leadId: '9100012345' }, key: 'KEY' });
  assert.match(msg.textContent, /^Sign in with Monday to save .* Sign in with Monday$/);
  assert.deepEqual([acts.kids[0].disabled, list.kids.length, msg.className], [false, 2, 'om-msg err']);
  // success: the row leaves the list, no reload
  answer = { s: 200, j: { ok: true } };
  acts.kids[0].onclick();
  await tick(); await tick();
  assert.deepEqual([list.kids.length, byId['om-n'].textContent, byId['om-top'].textContent], [1, '(1)', 'Saved to Priya Example.']);
  // "Not a consultation": asks first; Cancel does nothing; Yes sends — and when that empties the list the box STAYS with its message (review 2026-11-14)
  const row2 = list.kids[0], acts2 = row2.kids[1].kids[4];
  acts2.kids[1].onclick();
  assert.equal(ctx.dlg.box.kids[0].textContent, 'Not a consultation?');
  ctx.dlg.box.kids[3].kids[0].onclick();
  assert.deepEqual([ctx.dlg.closed, sent.length], ['cancel', 2]);
  acts2.kids[1].onclick();
  ctx.dlg.box.kids[2].value = 'team meeting';
  ctx.dlg.box.kids[3].kids[1].onclick();
  await tick(); await tick();
  assert.deepEqual(sent[2], { url: '/api/otter/needs-matching/ot_CCC333/dismiss', body: { why: 'team meeting' }, key: 'KEY' });
  assert.deepEqual([list.kids.length, strip.hidden, byId['om-top'].textContent], [0, false, 'Taken off the list.'], 'the last row left: the message is still on screen');
  assert.deepEqual([byId['om-n'].textContent, byId['om-hint'].hidden, byId['om-done'].hidden, byId['om-toggle'].focused], ['(0)', true, false, true], 'the count, "Nothing left to match", and the keyboard focus is not lost');
  // a fresh load that finds nothing hides the box again (and clears the old message)
  items.length = 0;
  ctx.window.tdotOtterMatchReload();
  await tick(); await tick();
  assert.deepEqual([strip.hidden, byId['om-top'].textContent], [true, '']);
  byId['om-body'].hidden = false;
  // the fold: a real button with aria-expanded
  byId['om-toggle'].onclick();
  assert.deepEqual([byId['om-toggle'].attrs['aria-expanded'], byId['om-body'].hidden], ['false', true]);
  // switched off (or nothing to match): the strip never shows
  for (const id of ['om-strip', 'om-list', 'om-n', 'om-toggle', 'om-body', 'om-top']) { const e = mk('div'); e.id = id; }
  byId['om-strip'].hidden = true;
  ctx.fetch = async () => ({ ok: true, json: async () => ({ on: false, items: [] }) });
  vm.runInNewContext(OTTER_MATCH_JS + '\ntdotOtterMatchMount({});', ctx);
  await tick(); await tick();
  assert.equal(byId['om-strip'].hidden, true);
});

test('the consultation record page: the recording code near the client\'s name, with the hint and a copy button; made on the server from the id', () => {
  const { buildDetailHTML } = require('../src/routes/adminConsultation');
  const html = buildDetailHTML('9100012345');
  scriptsParse(html, 'record');
  const name = html.indexOf('id="c-name"'), box = html.indexOf('id="c-code" hidden'), acts = html.indexOf('id="c-acts"');
  assert.ok(name > 0 && box > name && acts > box, 'right under the client\'s name');
  assert.ok(html.includes('<div class="rc-hint">Type this as the Otter recording title before you stop the recording</div>'));
  assert.ok(html.includes('<button type="button" class="rc-copy" id="c-code-copy">Copy</button>'));
  assert.ok(html.includes("document.getElementById('c-code-v').textContent=d.recordingCode||'';") && html.includes('rcBox.hidden=!d.recordingCode;'));
  assert.ok(html.includes('navigator.clipboard.writeText(code)'));
  const portal = read('src/services/consultantPortalService.js');
  assert.match(portal, /recordingCode: require\('\.\.\/utils\/recordingCode'\)\.recordingCode\(lead\.id\)/);
  assert.match(portal, /recCode: require\('\.\.\/utils\/recordingCode'\)\.recordingCode\(l\.id\)/);
  // display only: no column, nothing stored, never on a client page
  assert.ok(!JSON.stringify(require('../src/data/newLeadsBoard.json')).toLowerCase().includes('recordingcode'));
  for (const f of fs.readdirSync(path.join(__dirname, '../src/routes')).filter((x) => /^(client|booking|public|portal|lead|consultationForm|intake)/i.test(x))) {
    assert.ok(!/recordingCode|recCode/.test(read('src/routes/' + f)), f + ': the code is never shown to a client');
  }
});

test('the staff guide: how to record so the notes file themselves, what happens if the title is forgotten — marked as not switched on yet', () => {
  const g = JSON.parse(read('src/staffGuide/guide-data.json'));
  const a = g.howto.find((h) => /record a consultation in Otter so the notes file themselves/i.test(h.q));
  const b = g.howto.find((h) => /forgot to type the code/i.test(h.q));
  assert.ok(a && b);
  assert.equal(a.lane, 'consultant');
  assert.ok(/BEFORE you stop the recording/.test(a.answer) && /Recording code/.test(a.answer) && /Not switched on yet/.test(a.answer));
  assert.ok(/Otter recordings to match/.test(b.answer) && /Save to this client/.test(b.answer) && /Not a consultation/.test(b.answer) && /Not switched on yet/.test(b.answer));
  const auto = g.automatic.find((x) => x.id === 'auto-otter-recordings');
  assert.deepEqual([auto.switch, auto.stage, /^Not switched on yet/.test(auto.setting_note)], ['OTTER_READER', 'consultation', true]);
  const ids = new Set(g.steps.map((s) => s.id));
  for (const h of [a, b]) for (const id of h.step_ids) assert.ok(ids.has(id), id);
  for (const t of [a.answer, b.answer, a.q, b.q, auto.does, auto.name, auto.when, auto.setting_note]) assert.ok(!/\b(API|Zap|state|reader)\b/i.test(t), t.slice(0, 60));
  const raw = read('src/staffGuide/guide-data.json');
  assert.ok(!raw.includes('\n') && raw === JSON.stringify(g).replace(/":/g, '": ').replace(/,"/g, ', "') || JSON.stringify(JSON.parse(raw)) === JSON.stringify(g), 'still one line of JSON');
});

// ══ the review of 2026-11-14: ten findings, each with the scenario that showed it ═════════════════

test('REVIEW 2: a recording already on client A is never filed again on client B — a failed write of the saved list is written again, and a save noted before posting is the trace', async () => {
  const A = '9100012345', B = '9100022222';
  const onB = (w) => w.posts.filter((p) => p.leadId === B && p.html.includes('ot_BBB222')).length;
  // (1) staff save X to A; the update is posted; the saved list cannot be written afterwards
  const w = standard();
  try {
    w.mode('on');
    await S.runOnce();
    assert.equal(w.store.data.recs.ot_BBB222.d, 'needs');
    const post = S.io.postEntry;
    S.io.postEntry = async (l, h) => { const r = await post(l, h); w.failWrite = 99; return r; };   // every write AFTER the post fails
    const r = await S.assign({ otterId: 'ot_BBB222', leadId: A, actor: NAMED });
    assert.deepEqual([r.ok, r.already, r.warning], [true, false, 'Saved. The list may still show it for a few minutes.']);
    const posted = w.posts.length;
    assert.deepEqual([w.store.data.recs.ot_BBB222.d, w.store.data.recs.ot_BBB222.tried], ['needs', [A]], 'the lead was noted on the waiting entry BEFORE anything was posted');
    assert.deepEqual((await S.needsList()).items, [], 'it is on a client: it is not offered again while the saved list is behind');
    // a second person presses Save on client B: refused, nothing posted there
    await assert.rejects(S.assign({ otterId: 'ot_BBB222', leadId: B, actor: NAMED }), (e) => e.status === 409 && /already saved on another consultation/.test(e.message));
    await assert.rejects(S.dismiss({ otterId: 'ot_BBB222', actor: NAMED }), (e) => e.status === 409);
    assert.deepEqual([w.posts.length, onB(w)], [posted, 0]);
    // the same client again: nothing added twice
    assert.equal((await S.assign({ otterId: 'ot_BBB222', leadId: A, actor: NAMED })).already, true);
    assert.equal(w.posts.length, posted);
    // the saved list can be written again: the next run writes what it missed
    w.failWrite = 0;
    await S.runOnce();
    assert.deepEqual([w.store.data.recs.ot_BBB222.d, w.store.data.recs.ot_BBB222.leadId, w.store.data.recs.ot_BBB222.who], ['filed', A, 'Staff Member']);
    assert.equal(w.posts.length, posted);
  } finally { w.restore(); }

  // (1b) the same, and the server RESTARTS before the list could be written: the note on the entry is the trace
  const w2 = standard();
  try {
    w2.mode('on');
    await S.runOnce();
    const post = S.io.postEntry;
    S.io.postEntry = async (l, h) => { const r = await post(l, h); w2.failWrite = 99; return r; };
    await S.assign({ otterId: 'ot_BBB222', leadId: A, actor: NAMED });
    const posted = w2.posts.length;
    S._reset();   // nothing in memory
    assert.equal(w2.store.data.recs.ot_BBB222.d, 'needs', 'the saved list still says "to match"');
    // while the list cannot be written, a save to B posts nothing at all
    await assert.rejects(S.assign({ otterId: 'ot_BBB222', leadId: B, actor: NAMED }), (e) => e.status === 503 && /nothing was added to any client/.test(e.message));
    assert.equal(w2.posts.length, posted);
    w2.failWrite = 0;
    // the lead noted earlier cannot be read: nothing is posted blind
    w2.failFiledOn = true;
    await assert.rejects(S.assign({ otterId: 'ot_BBB222', leadId: B, actor: NAMED }), (e) => e.status === 502 && /nothing was saved/.test(e.message));
    w2.failFiledOn = false; S._reset();
    await assert.rejects(S.assign({ otterId: 'ot_BBB222', leadId: B, actor: NAMED }), (e) => e.status === 409 && /already saved on another consultation/.test(e.message));
    assert.deepEqual([w2.posts.length, onB(w2)], [posted, 0], 'not one update on client B');
    assert.deepEqual([w2.store.data.recs.ot_BBB222.d, w2.store.data.recs.ot_BBB222.leadId, w2.store.data.recs.ot_BBB222.by], ['filed', A, 'found'], 'the saved list is put right from the proof');
    assert.deepEqual((await S.needsList()).items, []);
    leaks(w2.logs.join('\n') + JSON.stringify(w2.store.data), 'the logs and the saved list');
  } finally { w2.restore(); }

  // (1c) after such a restart the next RUN finds it by itself: it leaves the list without anyone pressing anything
  const w3 = standard();
  try {
    w3.mode('on');
    await S.runOnce();
    const post = S.io.postEntry;
    S.io.postEntry = async (l, h) => { const r = await post(l, h); w3.failWrite = 99; return r; };
    await S.assign({ otterId: 'ot_BBB222', leadId: A, actor: NAMED });
    const posted = w3.posts.length;
    S._reset(); w3.failWrite = 0;
    await S.runOnce();
    assert.deepEqual([w3.store.data.recs.ot_BBB222.d, w3.store.data.recs.ot_BBB222.leadId, w3.posts.length], ['filed', A, posted]);
  } finally { w3.restore(); }

  // (2) the saved list is LOST after a staff save: the recording comes back "to match", and still cannot go to another client
  const w4 = standard();
  try {
    w4.mode('on');
    await S.runOnce();
    await S.assign({ otterId: 'ot_BBB222', leadId: A, actor: NAMED });
    const posted = w4.posts.length;
    w4.store = null; S._reset();
    await S.runOnce();
    // (review 2, second round) it does not even come back on the list: the recording's own trace names the lead,
    // and that lead's updates carry the mark — it is filed there again by the run itself
    assert.deepEqual([w4.store.data.recs.ot_BBB222.d, w4.store.data.recs.ot_BBB222.by, (await S.needsList()).items.length], ['filed', 'found', 0]);
    await assert.rejects(S.assign({ otterId: 'ot_BBB222', leadId: B, actor: NAMED }), (e) => e.status === 409);
    assert.deepEqual([w4.posts.length, onB(w4), w4.store.data.recs.ot_BBB222.leadId], [posted, 0, A]);
  } finally { w4.restore(); }

  // (3) filed by itself, the saved list not written, then the booking is moved and another lead with the same
  //     last five digits is booked that day: the next run must not post it on that lead as well
  for (const restart of [true, false]) {
    const w5 = standard();
    try {
      w5.mode('on'); w5.failWrite = 1;
      const r1 = await S.runOnce();
      assert.deepEqual([r1.stateSaved, w5.posts.length, summaries(w5).length, w5.posts[0].leadId, w5.store], [false, 2, 1, A, null]);
      if (restart) S._reset();
      w5.consults = [{ ...CONSULTS[0], bookedSlot: '2026-11-13 14:00' }, CONSULTS[1],
        { id: '9000012345', name: 'Nadia Invented', email: 'nadia@example.org', bookedSlot: '2026-11-12 14:00', createdAt: '2026-11-03T12:00:00Z', consultant: 'Consultant One' }];
      const r2 = await S.runOnce();
      assert.deepEqual(w5.posts.map((p) => p.leadId), [A, A], `restart=${restart}: nothing on the second lead`);
      assert.deepEqual([w5.store.data.recs.ot_AAA111.d, w5.store.data.recs.ot_AAA111.leadId], ['filed', A]);
      if (restart) assert.deepEqual([r2.onAnotherConsultation, r2.totals.filed, r2.files.find((f) => f.onAnotherConsultation).filed], [1, 0, false]);
      leaks(JSON.stringify(r2) + w5.logs.join('\n'), 'the answer and the logs');
    } finally { w5.restore(); }
  }
  // the lead it may already be on cannot be read: nothing is posted; it is tried again
  const w6 = standard();
  try {
    w6.mode('on');
    const filedOn = S.io.filedOn;
    S.io.filedOn = async (l) => { if (String(l) === B) throw new Error('Monday down'); return filedOn(l); };
    const r = await S.runOnce();
    assert.deepEqual([w6.posts.length, r.totals.failed, w6.store.data.recs.ot_AAA111.d], [0, 1, 'failed']);
  } finally { w6.restore(); }
});

test('REVIEW 3: two files with the same Otter id in one run — only the LATER (re-titled) file is acted on, and the other is counted', async () => {
  const files = [fileOf('ot_AAA111', START, 'TD-12345', 1), { ...fileOf('ot_AAA111', START, 'TD-22222', 5), id: 'F2-ot_AAA111' }];
  const texts = { 'F-ot_AAA111': fileText({ id: 'ot_AAA111', title: 'TD-12345', start: START }), 'F2-ot_AAA111': fileText({ id: 'ot_AAA111', title: 'TD-22222', start: START }) };
  for (const order of [files, files.slice().reverse()]) {
    const w = world({ files: order, texts, consults: CONSULTS, folders: { 9100012345: 'FOLDER1' } });
    try {
      w.mode('on');
      const r = await S.runOnce();
      assert.deepEqual([r.duplicates, r.totals.filed, r.files.length], [1, 1, 1]);
      assert.deepEqual(w.reads, ['F2-ot_AAA111'], 'the earlier file is not even opened');
      assert.deepEqual([...new Set(w.posts.map((p) => p.leadId))], ['9100022222'], 'updates on exactly ONE lead — the one the later title names');
      assert.equal(w.uploads.length, 0, 'nothing went into the other client\'s folder');
      assert.deepEqual([Object.keys(w.store.data.recs), w.store.data.recs.ot_AAA111.leadId], [['ot_AAA111'], '9100022222'], 'one entry in the saved list, pointing at that lead');
      const r2 = await S.runOnce();
      assert.deepEqual([r2.duplicates, r2.alreadyDecided, w.posts.length], [1, 1, 2], 'the next run: nothing more (summary + transcript entry, once)');
    } finally { w.restore(); }
  }
  // the preview counts it the same way
  const w = world({ files, texts, consults: CONSULTS });
  try { w.mode('report'); const r = await S.runOnce({ mode: 'report' }); assert.deepEqual([r.duplicates, r.files.length, r.totals.file], [1, 1, 1]); } finally { w.restore(); }
  // identical files, and the lead's updates come back stale: still posted once
  const twin = world({ files: [fileOf('ot_AAA111', START, 'TD-12345', 1), { ...fileOf('ot_AAA111', START, 'TD-12345', 1), id: 'F2-ot_AAA111' }], texts: { ...texts, 'F2-ot_AAA111': texts['F-ot_AAA111'] }, consults: CONSULTS, folders: { 9100012345: 'FOLDER1' } });
  try {
    twin.mode('on');
    S.io.filedOn = async () => ({ recordings: new Set(), transcripts: new Set() });
    const r = await S.runOnce();
    assert.deepEqual([r.duplicates, twin.posts.length, summaries(twin).length, twin.reads.length], [1, 2, 1, 1]);
  } finally { twin.restore(); }
});

test('REVIEW 4: a file that cannot be read after the bounded tries goes on the "to match" list with a plain reason — never given up silently', async () => {
  const files = [fileOf('ot_BAD000', START, 'Priya Example', 1)];
  const w = world({ files, texts: {}, consults: CONSULTS });
  try {
    w.mode('on'); w.failRead.add('F-ot_BAD000');
    for (let i = 1; i < S.MAX_TRIES; i++) {
      await S.runOnce();
      assert.deepEqual([w.store.data.recs.ot_BAD000.d, w.store.data.recs.ot_BAD000.tries], ['failed', i]);
      assert.deepEqual((await S.needsList()).items, [], 'still being tried: not on the list yet');
    }
    const last = await S.runOnce();
    assert.equal(last.totals.unreadable, 1);
    assert.deepEqual(w.store.data.recs.ot_BAD000, { d: 'needs', reasonKey: 'unreadable', candidates: [], tries: S.MAX_TRIES, firstSeen: NOW, fileId: 'F-ot_BAD000' });
    assert.equal(w.reads.length, S.MAX_TRIES);
    const list = await S.needsList();
    assert.equal(list.items.length, 1, 'staff see that the recording exists');
    const it = list.items[0];
    assert.deepEqual([it.otterId, it.fileRead, it.snippet, it.reason], ['ot_BAD000', false, '', 'The recording file could not be opened — look at it in the recordings folder. If it opens later you can choose the client; otherwise press Not a consultation']);
    assert.equal(it.saveable, true, 'it may open later (the read failed in passing): the client can still be chosen');
    assert.deepEqual([it.when, it.title], ['2026-11-12 14:02', 'Priya Example'], 'what the file NAME says is shown: the time and the typed title');
    assert.equal(it.candidates[0].id, '9100012345', 'and it makes the suggestion');
    assert.ok(!/\b(API|Zap|state|reader)\b/i.test(it.reason));
    const reads = w.reads.length;
    // the runs after that do not open the file again, and say how many they have stopped reading
    const after = await S.runOnce();
    assert.deepEqual([after.gaveUp, after.totals.unreadable, after.files.length], [1, 0, 0]);
    assert.equal(w.store.data.recs.ot_BAD000.d, 'needs');
    // Save answers plainly while the file is unreadable; Not a consultation works; restore brings it back as it was
    await assert.rejects(S.assign({ otterId: 'ot_BAD000', leadId: '9100012345', actor: NAMED }), (e) => e.status === 502 && /could not be read just now/.test(e.message) && /Try again in a minute/.test(e.message));
    assert.equal(w.posts.length, 0);
    assert.deepEqual(await S.dismiss({ otterId: 'ot_BAD000', actor: NAMED }), { ok: true });
    assert.deepEqual((await S.needsList()).items, []);
    await S.restore({ otterId: 'ot_BAD000' });
    assert.deepEqual([w.store.data.recs.ot_BAD000.d, w.store.data.recs.ot_BAD000.reasonKey, (await S.needsList()).items.length], ['needs', 'unreadable', 1]);
    // the file becomes readable: a person can save it
    w.failRead.clear(); w.texts['F-ot_BAD000'] = fileText({ id: 'ot_BAD000', title: 'Priya Example', start: START });
    S._reset();
    assert.equal((await S.needsList()).items[0].fileRead, true);
    assert.equal((await S.assign({ otterId: 'ot_BAD000', leadId: '9100012345', actor: NAMED })).ok, true);
    assert.ok(w.reads.length > reads);
    leaks(w.logs.join('\n') + JSON.stringify(w.store.data), 'the logs and the saved list');
  } finally { w.restore(); }
  // the permanent kinds (too large, another recording's id inside) end on the list as well
  const w2 = world({ files: [{ ...fileOf('ot_BIG000', START, 'x', 1), size: 4 * 1024 * 1024 }, fileOf('ot_MIX000', START, 'x', 2)], texts: { 'F-ot_MIX000': fileText({ id: 'ot_SOMEONE_ELSE', start: START }) }, consults: CONSULTS });
  try {
    w2.mode('on');
    for (let i = 0; i < S.MAX_TRIES; i++) await S.runOnce();
    assert.deepEqual((await S.needsList()).items.map((x) => x.otterId).sort(), ['ot_BIG000', 'ot_MIX000']);
  } finally { w2.restore(); }
});

test('REVIEW 5 + 8: the file-name fallback for the title and the start time also reaches the later reads (the list after the cache or a restart, and Save) — the typed title is never in the saved list', async () => {
  const file = fileOf('ot_NAME01', START, 'Zed Unknown chat', 1);
  const mk = () => world({ files: [file], texts: { 'F-ot_NAME01': fileText({ id: 'ot_NAME01', title: '', start: '' }) }, consults: CONSULTS, folders: { 9100012345: 'FOLDER1' } });
  const w = mk();
  try {
    w.mode('on');
    const r = await S.runOnce();
    assert.deepEqual([r.files[0].decision, r.files[0].titlePresent, r.files[0].titleHolds], ['needs', true, ['name']]);
    assert.deepEqual(Object.keys(w.store.data.recs.ot_NAME01).sort(), ['candidates', 'd', 'fileId', 'firstSeen', 'reasonKey'], 'the saved list keeps the file id — not the name, not the title');
    assert.ok(!/Zed|Unknown|chat/.test(JSON.stringify(w.store.data)));
    const shown = (l) => [l.items[0].title, l.items[0].when, l.items[0].fileRead, l.items[0].reason];
    const WANT = ['Zed Unknown chat', '2026-11-12 14:02', true, 'The name in the title matches no consultation booked around the time of the recording'];
    assert.deepEqual(shown(await S.needsList()), WANT, 'straight after the run');
    assert.equal(w.names.length, 0, 'from what the run read: the name is not fetched again');
    // 31 minutes later (the 30-minute memory is over)
    S.io.now = () => NOW + 31 * 60 * 1000;
    const later = await S.needsList();
    assert.deepEqual(shown(later), WANT, 'after the cache');
    assert.deepEqual(w.names, ['F-ot_NAME01'], 'the name was fetched by the file id');
    assert.deepEqual(later.items[0].candidates.map((c) => c.id), ['9100012345', '9100022222'], 'the suggestions still come from the real start time');
    // a restart
    S.io.now = () => NOW; S._reset();
    assert.deepEqual(shown(await S.needsList()), WANT, 'after a restart');
    // Save: the heading carries the time, the transcript file its date
    S._reset();
    await S.assign({ otterId: 'ot_NAME01', leadId: '9100012345', actor: NAMED });
    assert.ok(w.posts[0].html.startsWith(`${U.OTTER_HEADER} — recorded 12 Nov 2026, 2:02 pm (Toronto) · assigned by Staff Member`), w.posts[0].html.slice(0, 120));
    assert.equal(w.uploads[0].filename, 'Otter transcript 2026-11-12 ot_NAME01.txt');
    assert.ok(!/Zed|Unknown|chat/.test(JSON.stringify(w.store.data) + w.logs.join('\n')), 'still not in the saved list, never in the logs');
  } finally { w.restore(); }
  // the name cannot be fetched (or belongs to another recording): the old blanks, never an error — and no text of the failure
  const w2 = mk();
  try {
    w2.mode('on');
    await S.runOnce();
    S._reset(); w2.failName = true;
    const l = await S.needsList();
    assert.deepEqual([l.items[0].title, l.items[0].when, l.items[0].fileRead], ['', '', true]);
    S._reset(); w2.failName = false; w2.files[0] = { ...file, name: `${START} - ot_OTHER99 - Someone Else.txt` };
    assert.deepEqual([(await S.needsList()).items[0].title, (await S.needsList()).items[0].when], ['', ''], 'a name with another Otter id is not used');
    S._reset(); w2.failName = true;
    await S.assign({ otterId: 'ot_NAME01', leadId: '9100012345', actor: NAMED });
    assert.ok(w2.posts[0].html.includes('recording time not known'));
    leaks(w2.logs.join('\n'), 'the logs');
  } finally { w2.restore(); }
  const src = read('src/services/otterReaderService.js');
  assert.ok(!/readRecording\([^\n]*start: '', title: ''/.test(src), 'no later read passes blanks any more');
});

test('REVIEW 6: the folder is listed newest first and never stops silently — a folder larger than one run lists is said in the run result, with the count', async () => {
  const F = require('../src/services/otterFilesService');
  const realGet = F.io.get;
  const TOTAL = S.LIST_PAGES * 200 + 300;
  const all = Array.from({ length: TOTAL }, (_, i) => ({ id: 'F' + i, name: `${1794000000 + i * 600} - ot_N${String(i).padStart(5, '0')} - .txt`, size: 100, createdDateTime: new Date(Date.UTC(2026, 10, 1) + i * 600000).toISOString() }));
  all.splice(3, 0, { id: 'DIR', name: 'old', folder: { childCount: 0 } });
  const calls = [];
  let refuseOrder = false, failCount = false;
  F.io.get = async (url) => {
    calls.push(url);
    if (/\/children\?/.test(url) || /\/next\?/.test(url)) {
      const ordered = /orderby=lastModifiedDateTime%20desc/.test(url) || /ord=1/.test(url);
      if (ordered && refuseOrder) { const e = new Error('Invalid request for "TD-12345 Priya Example.txt"'); e.response = { status: 400 }; throw e; }
      const skip = Number((/skip=(\d+)/.exec(url) || [0, 0])[1]);
      const src = ordered ? all.slice().reverse() : all;   // no order: by name, the OLDEST first
      const next = skip + 200 < src.length ? `https://graph.microsoft.com/v1.0/next?ord=${ordered ? 1 : 0}&skip=${skip + 200}` : undefined;
      return { value: src.slice(skip, skip + 200), ...(next ? { '@odata.nextLink': next } : {}) };
    }
    if (failCount) throw new Error('down');
    return { id: 'FOLDER', folder: { childCount: all.length } };
  };
  try {
    const listed = await REAL_IO.listFiles();
    assert.match(calls[0], /\/children\?\$top=200&\$select=id,name,size,file,folder,createdDateTime&\$orderby=lastModifiedDateTime%20desc$/, 'newest first');
    assert.equal(listed.length, S.LIST_PAGES * 200);
    assert.equal(listed[0].id, 'F' + (TOTAL - 1), 'the NEWEST recording is listed');
    assert.ok(S.LIST_PAGES * 200 >= 5000, 'far more than the old 1,000');
    assert.deepEqual([listed.capped, listed.notListed], [true, 301], 'the 300 oldest files and the folder: counted, not dropped silently');
    assert.ok(!listed.some((f) => f.id === 'DIR'));
    // the folder's own count cannot be read: still said, without a number
    failCount = true;
    const l2 = await REAL_IO.listFiles();
    assert.deepEqual([l2.capped, l2.notListed], [true, null]);
    failCount = false;
    // the drive refuses the order: the listing is read unordered instead (and the cap is still said)
    refuseOrder = true; calls.length = 0;
    const l3 = await REAL_IO.listFiles();
    assert.deepEqual([l3.length, l3.capped, /orderby/.test(calls[1])], [S.LIST_PAGES * 200 - 1, true, false]);
    // a folder that fits: nothing is flagged
    refuseOrder = false; all.length = 450;
    const l4 = await REAL_IO.listFiles();
    assert.deepEqual([l4.length, l4.capped, l4.notListed], [449, undefined, undefined]);
    // any other failure is not swallowed
    F.io.get = async () => { const e = new Error('x'); e.response = { status: 503 }; throw e; };
    await assert.rejects(REAL_IO.listFiles(), (e) => e.response.status === 503);
  } finally { F.io.get = realGet; }

  // the run says it: a flag, the count, the sentence — in 'on' and in the preview, and in the status
  for (const m of ['on', 'report']) {
    const w = standard();
    try {
      w.mode(m);
      w.files = Object.assign(w.files.slice(), { capped: true, notListed: 301 });
      const r = await S.runOnce({ mode: m });
      assert.deepEqual([r.ok, r.listCapped, r.filesNotListed], [true, true, 301]);
      assert.match(r.outcome, /The recordings folder holds more files than one run lists — 301 older file\(s\) were not looked at\.$/);
      assert.deepEqual([S.status().lastRun.listCapped, S.status().lastRun.filesNotListed], [true, 301]);
      assert.ok(w.logs.some((l) => /larger than one run lists: 3 file\(s\) listed, 301 not listed/.test(l)), 'a count-only warning');
      leaks(w.logs.join('\n'), 'the logs');
      w.files = Object.assign(w.files.slice(), { capped: true, notListed: null });
      assert.match((await S.runOnce({ mode: m })).outcome, /some older files were not looked at\.$/);
      w.files = w.files.slice();
      const ok = await S.runOnce({ mode: m });
      assert.deepEqual([ok.listCapped, /more files than/.test(ok.outcome), S.status().lastRun.listCapped], [undefined, false, undefined]);
    } finally { w.restore(); }
  }
});

test('REVIEW 7: only an Otter entry the app filed gets links, and only to otter.ai and the transcript in the client folder — every other entry is plain text, exactly as before', async () => {
  const orig = mondayApi.query;
  const w0 = world({ folders: { 9100012345: 'FOLDER1' } });
  let all;
  try {
    // the app stores one transcript: that upload's own answer is how the firm's file host is known
    await S.fileOn('9100012345', { otterId: 'ot_HOST001', startTime: START, summary: 'Sum', transcript: 'Hello there' }, { by: 'code' });
    const rec0 = { otterId: 'ot_AAA111', startTime: START, abstractSummary: 'Short one',
      summary: 'See https://evil.example/login\nRecording in Otter: https://evil.example/fake\nFull transcript (in the client\'s folder): https://evil.sharepoint.com/x', otterLink: 'https://otter.ai/u/ot_AAA111' };
    mondayApi.query = async () => ({ items: [{ updates: [
      { id: '0', body: S.buildTranscriptLinkEntry(rec0, 'https://example.sharepoint.com/t/abc'), text_body: 'collapsed', created_at: '2026-11-12T20:00:01Z', creator: { name: 'App' }, replies: [] },
      { id: '1', body: S.buildSummaryEntry(rec0, { by: 'code' }), text_body: 'collapsed', created_at: '2026-11-12T20:00:00Z', creator: { name: 'App' }, replies: [] },
      { id: '2', body: '<p>From an email: https://evil.example/login and https://otter.ai/u/zzz</p>', text_body: 'From an email: https://evil.example/login and https://otter.ai/u/zzz', created_at: '2026-11-12T19:00:00Z', creator: { name: 'Staff' }, replies: [] },
      { id: '3', body: S.buildTranscriptEntry({ otterId: 'ot_AAA111', startTime: START, transcript: 'Speaker 1 said https://evil.example/t' }), text_body: 'x', created_at: '2026-11-12T18:00:00Z', creator: { name: 'App' }, replies: [] },
    ] }] });
    all = await U.getUpdatesForItem('55');
  } finally { mondayApi.query = orig; w0.restore(); }
  assert.deepEqual([all[0].otter, all[0].links], [true, ['https://example.sharepoint.com/t/abc']], 'the stored-transcript entry: the one line the app wrote above its machine line, on the firm\'s own host');
  const ups = all.slice(1);
  assert.deepEqual([ups[0].otter, ups[0].links], [true, ['https://otter.ai/u/ot_AAA111']], 'the summary: the line the app wrote above the machine line — nothing from the written parts');
  assert.deepEqual(Object.keys(ups[1]).sort(), ['at', 'body', 'by', 'id', 'origin', 'replies'], 'an ordinary entry is shaped exactly as before');
  assert.equal(ups[1].body, 'From an email: https://evil.example/login and https://otter.ai/u/zzz');
  assert.deepEqual(ups[2].links, [], 'the transcript entry: no link');
  // the reader of those lines, by itself
  const L = U.otterLinksOf;
  assert.deepEqual(L('Recording in Otter: https://otter.ai/u/a\nOtter recording ref: a'), ['https://otter.ai/u/a']);
  for (const bad of ['Recording in Otter: https://otter.ai.evil.example/u/a', 'Recording in Otter: https://evil.example/otter.ai/', 'Recording in Otter: http://otter.ai/u/a', 'Recording in Otter: https://user@otter.ai/u/a',
    'Full transcript (in the client\'s folder): https://evil.example/x.sharepoint.com', 'Full transcript (in the client\'s folder): https://sharepoint.com.evil.example/x', 'See https://otter.ai/u/a']) {
    assert.deepEqual(L(bad + '\nOtter recording ref: a'), [], bad);
    assert.deepEqual(L(bad + '\nOtter transcript ref: a', ['example.sharepoint.com']), [], bad);
  }
  assert.deepEqual(L('Recording in Otter: https://otter.ai/u/a\nsomething else\nmore\nOtter recording ref: a'), [], 'only the line right above the machine line');
  assert.deepEqual(L('Recording in Otter: https://otter.ai/u/a'), [], 'no machine line: no link');
  assert.deepEqual(L('Recording in Otter: https://otter.ai/u/a\nOtter recording ref: a\nEmail ref: 123'), [], 'the machine line must END the entry');
  // the transcript: only on a host the app's own upload returned — never "any *.sharepoint.com"
  const T = 'Full transcript (in the client\'s folder): https://example.sharepoint.com/t/abc\nOtter transcript ref: a';
  assert.deepEqual(L(T, ['example.sharepoint.com']), ['https://example.sharepoint.com/t/abc']);
  assert.deepEqual(L(T, []), [], 'no host known: text, not a link');
  assert.deepEqual(L(T), []);
  assert.deepEqual(L(T, ['other.sharepoint.com']), [], 'another tenant');
  assert.deepEqual(L(T.replace('example.sharepoint.com', 'example.sharepoint.com.evil.example'), ['example.sharepoint.com']), []);
  assert.deepEqual(L(T.replace('https://example', 'https://user@example'), ['example.sharepoint.com']), []);

  // the page: renderOne as the widget emits it
  const { UPDATES_WIDGET_JS } = require('../src/routes/updatesWidget');
  const a = UPDATES_WIDGET_JS.indexOf('  function fmtAt('), b = UPDATES_WIDGET_JS.indexOf('  function render(updates){');
  assert.ok(a > 0 && b > a);
  const mk = (tag) => { const e = { tag, kids: [], appendChild(k) { e.kids.push(k); } }; return e; };
  const ctx = { document: { createElement: (t) => mk(t), createTextNode: (t) => ({ text: t }) } };
  vm.runInNewContext(UPDATES_WIDGET_JS.slice(a, b) + '\nthis.renderOne = renderOne;', ctx);
  const bodyOf = (u) => ctx.renderOne(u, false).kids[1];
  const anchors = (n) => n.kids.filter((k) => k.tag === 'a').map((k) => k.href);
  const plain = bodyOf(ups[1]);
  assert.deepEqual([plain.textContent, plain.kids.length], ['From an email: https://evil.example/login and https://otter.ai/u/zzz', 0], 'not an Otter entry: textContent, not one <a> — not even for an otter.ai address');
  const otter = bodyOf(ups[0]);
  assert.deepEqual(anchors(otter), ['https://otter.ai/u/ot_AAA111'], 'the Otter entry: its own link and no other (three more addresses are in its text)');
  const stored = bodyOf(all[0]);
  assert.deepEqual(anchors(stored), ['https://example.sharepoint.com/t/abc'], 'the stored-transcript entry: the link to the file in the client\'s folder');
  assert.equal(stored.kids.map((k) => (k.tag ? k.textContent : k.text)).join(''), all[0].body);
  assert.equal(otter.kids.map((k) => (k.tag ? k.textContent : k.text)).join(''), ups[0].body, 'not one character lost or added');
  assert.deepEqual(anchors(bodyOf(ups[2])), []);
  assert.equal(bodyOf(ups[2]).textContent, ups[2].body);
  // a made-up entry cannot switch links on by itself: both the mark and the list come from the server's shape
  assert.equal(bodyOf({ body: 'https://otter.ai/u/a', links: ['https://otter.ai/u/a'] }).kids.length, 0);
  assert.equal(bodyOf({ body: 'https://otter.ai/u/a', otter: true }).kids.length, 0);
  assert.ok(/rb\.textContent = r\.body/.test(UPDATES_WIDGET_JS), 'replies stay plain text');
});

/** A small stand-in page for the strip (the same shape the page test above uses). */
function stripPage(items, answer = { s: 200, j: { ok: true } }) {
  const { OTTER_MATCH_JS } = require('../src/routes/otterMatchWidget');
  const byId = {};
  function mk(tag) {
    const e = { tag, kids: [], attrs: {}, className: '', hidden: false, disabled: false, value: '', _text: '',
      appendChild(k) { k.parentNode = e; e.kids.push(k); return k; },
      removeChild(k) { e.kids.splice(e.kids.indexOf(k), 1); k.parentNode = null; },
      setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return k in e.attrs ? e.attrs[k] : null; },
      focus() { e.focused = true; },
      querySelector() { const walk = (n) => { for (const k of n.kids || []) { if (k.tag === 'select' || k.tag === 'button') return k; const d = walk(k); if (d) return d; } return null; }; return walk(e); },
      get textContent() { return e._text + e.kids.map((k) => (k.tag ? k.textContent : k.text)).join(''); },
      set textContent(v) { e._text = String(v); e.kids = []; },
      set innerHTML(v) { e._text = ''; e.kids = []; }, get innerHTML() { return ''; },
      get options() { return e.kids; }, get selectedIndex() { return Math.max(0, e.kids.findIndex((k) => k.value === e.value)); },
    };
    Object.defineProperty(e, 'id', { set(v) { e._id = v; byId[v] = e; }, get() { return e._id; } });
    return e;
  }
  for (const id of ['om-strip', 'om-list', 'om-n', 'om-toggle', 'om-body', 'om-top', 'om-hint', 'om-done']) { const e = mk('div'); e.id = id; }
  byId['om-strip'].hidden = true; byId['om-done'].hidden = true; byId['om-toggle'].attrs['aria-expanded'] = 'true';
  const page = { byId, items, answer, sent: [] };
  const ctx = {
    document: { getElementById: (id) => byId[id] || null, createElement: mk, createTextNode: (t) => ({ text: String(t) }) },
    window: {}, Intl, Date, Number, String, JSON, Math, encodeURIComponent, setTimeout: (fn) => fn(), sessionStorage: { getItem: () => null, setItem() {} },
    peekKey: () => 'KEY',
    fetch: async (url, opts) => {
      if (!opts || !opts.method) return { ok: true, json: async () => ({ on: true, items: page.items }) };
      page.sent.push(url);
      return { status: page.answer.s, json: async () => page.answer.j };
    },
  };
  vm.runInNewContext(OTTER_MATCH_JS + '\ntdotOtterMatchMount({});', ctx);
  page.reload = () => ctx.window.tdotOtterMatchReload();
  page.tick = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
  return page;
}
/** Chooses the suggested client on the first row and presses "Save to this client". */
const pressSave = (page) => { const pick = page.byId['om-list'].kids[0].kids[1]; pick.kids[3].value = '9100012345'; pick.kids[4].kids[0].onclick(); };
const ONE_ITEM = (extra = {}) => ({ otterId: 'ot_BBB222', when: '2026-11-12 14:02', minutes: 34, title: 'Invented title', snippet: 'First words', reason: 'No code, email or name was typed as the title', fileRead: true,
  candidates: [{ id: '9100012345', name: 'Test Person', bookedSlot: '2026-11-12 14:00', consultant: 'Consultant One', code: 'TD-12345' }], ...extra });

test('REVIEW 9: the success message stays on screen when the LAST recording leaves the strip — and a fresh load with nothing hides it again', async () => {
  const p = stripPage([ONE_ITEM()], { s: 200, j: { ok: true, already: true } });
  await p.tick();
  const { byId } = p;
  assert.deepEqual([byId['om-strip'].hidden, byId['om-list'].kids.length, byId['om-hint'].hidden, byId['om-done'].hidden], [false, 1, false, true]);
  pressSave(p);   // Save to this client — the only row
  await p.tick();
  assert.deepEqual(p.sent, ['/api/otter/needs-matching/ot_BBB222/assign']);
  assert.equal(byId['om-list'].kids.length, 0);
  assert.equal(byId['om-strip'].hidden, false, 'the box is still there…');
  assert.equal(byId['om-top'].textContent, 'Saved to Test Person. It was already on that client — nothing was added twice.', '…with the line that says what happened');
  assert.deepEqual([byId['om-n'].textContent, byId['om-hint'].hidden, byId['om-done'].hidden, byId['om-toggle'].focused], ['(0)', true, false, true]);
  // folded when the last row leaves: it opens, or the message would be hidden inside it
  const q = stripPage([ONE_ITEM()]);
  await q.tick();
  q.byId['om-toggle'].onclick();
  assert.equal(q.byId['om-body'].hidden, true);
  pressSave(q);
  await q.tick();
  assert.deepEqual([q.byId['om-strip'].hidden, q.byId['om-body'].hidden, q.byId['om-top'].textContent], [false, false, 'Saved to Test Person.']);
  // a load that finds nothing: hidden, and the old message is gone
  q.items = [];
  q.reload(); await q.tick();
  assert.deepEqual([q.byId['om-strip'].hidden, q.byId['om-top'].textContent], [true, '']);
  // while other rows remain nothing changed: the message shows above them
  const r = stripPage([ONE_ITEM(), ONE_ITEM({ otterId: 'ot_CCC333' })]);
  await r.tick();
  pressSave(r);
  await r.tick();
  assert.deepEqual([r.byId['om-strip'].hidden, r.byId['om-list'].kids.length, r.byId['om-top'].textContent, r.byId['om-done'].hidden], [false, 1, 'Saved to Test Person.', true]);
  const html = require('../src/routes/otterMatchWidget').otterMatchHtml();
  assert.ok(html.includes('id="om-hint"') && html.includes('<p class="om-done" id="om-done" hidden>Nothing left to match.</p>'));
});

test('REVIEW 10: the snippet\'s "…" is decided on the server, and only when text was really cut', async () => {
  const mkWorld = (abstract) => world({ files: [fileOf('ot_BBB222', START, '', 1)], texts: { 'F-ot_BBB222': fileText({ id: 'ot_BBB222', start: START, abstract }) }, consults: CONSULTS });
  const snip = async (abstract) => {
    const w = mkWorld(abstract);
    try { w.mode('on'); await S.runOnce(); const it = (await S.needsList()).items[0]; return [it.snippet, it.snippetCut]; } finally { w.restore(); }
  };
  assert.equal(S.SNIPPET, 200);
  const exact = 'A'.repeat(199) + '.';
  assert.deepEqual(await snip(exact), [exact, false], 'exactly 200 characters, nothing cut: no mark');
  assert.deepEqual(await snip('Short summary.'), ['Short summary.', false]);
  assert.deepEqual(await snip('B'.repeat(450)), ['B'.repeat(200), true], 'cut: the first 200 characters and the mark');
  assert.deepEqual(await snip('C'.repeat(198) + '. And then a lot more was said here.'), ['C'.repeat(198), true], 'a cut that lands on a full stop: the full stop is not shown before the "…"');
  // the page shows what the server decided — it no longer guesses from the length
  const p = stripPage([ONE_ITEM({ snippet: exact }), ONE_ITEM({ otterId: 'ot_CCC333', snippet: 'C'.repeat(198), snippetCut: true }), ONE_ITEM({ otterId: 'ot_DDD444', snippet: 'D'.repeat(250) })]);
  await p.tick();
  const shown = p.byId['om-list'].kids.map((row) => row.kids[0].kids[2].textContent);
  assert.deepEqual(shown, [exact, 'C'.repeat(198) + '…', 'D'.repeat(250)]);
  assert.ok(!/snippet\.length/.test(require('../src/routes/otterMatchWidget').OTTER_MATCH_JS));
});


// ══ the second review of 2026-11-14: nine findings, each with the scenario that showed it ═════════

const DINA = { id: '9100044444', name: 'Dina Invented', email: 'dina@example.org', bookedSlot: '2026-11-10 10:00', createdAt: '2026-11-03T12:00:00Z', consultant: 'Consultant One' };
const A_ID = '9100012345', B_ID = '9100022222';
const waiting = (extra = {}) => ({ version: 1, recs: { ot_BBB222: { d: 'needs', reasonKey: 'noTitle', candidates: [A_ID, B_ID], firstSeen: NOW, fileId: 'F-ot_BBB222', ...extra } } });
const refuses = (p, status, re, not) => assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.message, re); if (not) assert.doesNotMatch(e.message, not); return true; });

test('SECOND REVIEW 1: a deleted lead among the stored suggestions or the started saves counts as "not there" — every other read error still blocks and posts nothing', async () => {
  // a suggestion stored with the entry was deleted since
  const w = standard({ state: waiting({ candidates: [A_ID, '9100099999'] }) });
  try {
    w.mode('on'); w.gone.add('9100099999');
    const r = await S.assign({ otterId: 'ot_BBB222', leadId: A_ID, actor: NAMED });
    assert.deepEqual([r.ok, r.already, summaries(w).length, summaries(w, A_ID).length], [true, false, 1, 1], 'saved, once, on the client chosen');
    assert.equal(w.store.data.recs.ot_BBB222.d, 'filed');
  } finally { w.restore(); }
  // a lead an earlier save was started on (the post failed) was deleted since — the run's own look does not stumble either
  const w2 = standard({ state: waiting({ tried: ['9100088888'] }) });
  try {
    w2.mode('on'); w2.gone.add('9100088888');
    const run = await S.runOnce();
    assert.equal(run.ok, true);
    assert.equal(w2.store.data.recs.ot_BBB222.d, 'needs');
    const r = await S.assign({ otterId: 'ot_BBB222', leadId: B_ID, actor: NAMED });
    assert.deepEqual([r.ok, summaries(w2, B_ID).length], [true, 1]);
  } finally { w2.restore(); }
  // any OTHER error on such a lead (Monday down, a time-out — no notFound signal) still blocks: nothing is posted blind
  for (const err of [new Error('Monday down'), Object.assign(new Error('The record was not found.'), { notFound: 'yes' }), Object.assign(new Error('x'), { response: { status: 404 } })]) {
    const w3 = standard({ state: waiting({ candidates: [A_ID, '9100099999'] }) });
    try {
      w3.mode('on');
      const filedOn = S.io.filedOn;
      S.io.filedOn = async (l) => { if (String(l) === '9100099999') throw err; return filedOn(l); };
      await refuses(S.assign({ otterId: 'ot_BBB222', leadId: A_ID, actor: NAMED }), 502, /could not be checked just now.*nothing was saved/);
      assert.equal(w3.posts.length, 0);
    } finally { w3.restore(); }
  }
  // the lead being SAVED TO is gone: that read stays strict — nothing is posted
  const w4 = standard({ state: waiting() });
  try {
    w4.mode('on'); w4.gone.add(A_ID);
    await refuses(S.assign({ otterId: 'ot_BBB222', leadId: A_ID, actor: NAMED }), 502, /could not be saved to the client/);
    assert.deepEqual([w4.posts.length, w4.uploads.length], [0, 0]);
  } finally { w4.restore(); }
});

test('SECOND REVIEW 2: the saved list is lost after a person saved a recording to a client nobody suggested — the recording\'s own trace still names that client, and it never goes on a second one', async () => {
  const onLeads = (w) => [...new Set(w.posts.filter((p) => p.html.includes('ot_BBB222')).map((p) => p.leadId))];
  const setUp = async () => {
    const w = standard(); w.consults = [...CONSULTS, DINA]; w.mode('on');
    await S.runOnce();
    assert.deepEqual(w.store.data.recs.ot_BBB222.candidates.includes(DINA.id), false, 'Dina is not among the suggestions');
    // the trace is on file BEFORE the first entry is posted
    const post = S.io.postEntry; const seen = [];
    S.io.postEntry = async (l, h) => { seen.push(JSON.stringify((w.traces.ot_BBB222 || {}).data || null)); return post(l, h); };
    await S.assign({ otterId: 'ot_BBB222', leadId: DINA.id, actor: NAMED });
    S.io.postEntry = post;
    assert.ok(seen.length >= 1 && seen.every((t) => t === JSON.stringify({ version: 1, otterId: 'ot_BBB222', leads: [DINA.id], dismissed: false })), 'written before anything was posted');
    assert.deepEqual(onLeads(w), [DINA.id]);
    return w;
  };
  for (const lost of ['gone', 'no recs']) {
    // (a) the next run after the loss: the recording does not come back on the list at all
    const w = await setUp();
    try {
      const posted = w.posts.length;
      w.store = lost === 'gone' ? null : { data: { version: 1 }, etag: 'e99' };
      S._reset();
      const r = await S.runOnce();
      assert.deepEqual([w.store.data.recs.ot_BBB222.d, w.store.data.recs.ot_BBB222.leadId, w.store.data.recs.ot_BBB222.by], ['filed', DINA.id, 'found'], lost);
      assert.equal(r.onAnotherConsultation, 1);
      assert.deepEqual((await S.needsList()).items, []);
      await refuses(S.assign({ otterId: 'ot_BBB222', leadId: A_ID, actor: NAMED }), 409, /already saved on another consultation/);
      assert.deepEqual([w.posts.length, onLeads(w)], [posted, [DINA.id]], 'one client only');
      leaks(JSON.stringify(w.traces) + JSON.stringify(r) + w.logs.join('\n'), 'the trace (ids only), the answer and the logs');
      assert.ok(S.TRACE_DIR.startsWith('TDOT System/') && !/Otter Recordings/i.test(S.TRACE_DIR), 'the trace is in the app\'s own folder, not with the recordings');
    } finally { w.restore(); }
    // (b) the list was rebuilt WITHOUT the lead (Dina could not be read when the run looked): Save reads the trace itself
    const v = await setUp();
    try {
      const posted = v.posts.length;
      v.store = { data: waiting(), etag: 'e99' };   // "to match" again, suggestions Priya and Omar, no note of Dina
      S._reset();
      await refuses(S.assign({ otterId: 'ot_BBB222', leadId: A_ID, actor: NAMED }), 409, /already saved on another consultation/);
      assert.deepEqual([v.posts.length, onLeads(v)], [posted, [DINA.id]]);
      assert.deepEqual([v.store.data.recs.ot_BBB222.d, v.store.data.recs.ot_BBB222.leadId], ['filed', DINA.id], 'the saved list is put right from the proof');
    } finally { v.restore(); }
  }
  // the trace cannot be READ: nothing is posted (Save), nothing is listed or filed (the run) — tried again
  const x = await setUp();
  try {
    const posted = x.posts.length;
    x.store = { data: waiting(), etag: 'e99' }; S._reset(); x.failTraceRead = true;
    await refuses(S.assign({ otterId: 'ot_BBB222', leadId: A_ID, actor: NAMED }), 502, /could not be checked just now.*nothing was saved/);
    await refuses(S.restore({ otterId: 'ot_BBB222' }), 502, /nothing was changed/);
    x.store = null; S._reset();
    const r = await S.runOnce();
    assert.deepEqual([x.posts.length, r.totals.failed, x.store.data.recs.ot_BBB222.d], [posted, 2, 'failed'], 'neither file is decided while its trace cannot be read');
    assert.deepEqual((await S.needsList()).items, []);
    leaks(JSON.stringify(r) + x.logs.join('\n'), 'the answer and the logs');
    x.failTraceRead = false;
    await S.runOnce();
    assert.deepEqual([x.posts.length, x.store.data.recs.ot_BBB222.leadId, x.store.data.recs.ot_AAA111.d], [posted, DINA.id, 'filed']);
  } finally { x.restore(); }
  // the trace cannot be WRITTEN: nothing is posted — by a person or by the run
  const y = standard();
  try {
    y.mode('on'); y.failTraceWrite = true;
    const r = await S.runOnce();
    assert.deepEqual([y.posts.length, y.uploads.length, r.totals.filed, r.totals.failed, y.store.data.recs.ot_AAA111.d], [0, 0, 0, 1, 'failed'], 'the certain match is not filed without its trace');
    await refuses(S.assign({ otterId: 'ot_BBB222', leadId: B_ID, actor: NAMED }), 503, /nothing was added to any client/);
    assert.deepEqual([y.posts.length, y.uploads.length], [0, 0]);
    y.failTraceWrite = false;
    assert.equal((await S.assign({ otterId: 'ot_BBB222', leadId: B_ID, actor: NAMED })).ok, true);
    await S.runOnce();
    assert.deepEqual([summaries(y, B_ID).length, summaries(y, A_ID).length], [1, 1]);
  } finally { y.restore(); }
  // a lead in the trace is ALWAYS read — also past the cap on suggestions, and when a save was started on many leads
  const z = standard({ state: waiting({ tried: Array.from({ length: 10 }, (_, i) => '91000550' + String(i).padStart(2, '0')) }) });
  try {
    z.mode('on');
    z.traces.ot_BBB222 = { data: { version: 1, otterId: 'ot_BBB222', leads: [DINA.id] }, etag: 't0' };
    z.posts.push({ leadId: DINA.id, html: `${U.OTTER_HEADER}<br>Otter recording ref: ot_BBB222` });
    await refuses(S.assign({ otterId: 'ot_BBB222', leadId: A_ID, actor: NAMED }), 409, /already saved on another consultation/);
    assert.equal(z.posts.length, 1);
  } finally { z.restore(); }
  // "Not a consultation" survives the loss too; the admin restore still brings it back
  const d = standard();
  try {
    d.mode('on');
    await S.runOnce();
    await S.dismiss({ otterId: 'ot_BBB222', why: 'team meeting', actor: NAMED });
    assert.equal(d.traces.ot_BBB222.data.dismissed, true);
    d.store = null; S._reset();
    await S.runOnce();
    assert.deepEqual([d.store.data.recs.ot_BBB222.d, (await S.needsList()).items.length], ['dismissed', 0], 'it does not come back on the list');
    assert.deepEqual(await S.restore({ otterId: 'ot_BBB222' }), { ok: true, now: 'on the list to match' });
    assert.deepEqual([d.store.data.recs.ot_BBB222.d, d.traces.ot_BBB222.data.dismissed, (await S.needsList()).items.length], ['needs', false, 1]);
    leaks(JSON.stringify(d.traces), 'the trace');
  } finally { d.restore(); }
});

test('SECOND REVIEW 3: the admin restore never erases a started save — it reads the noted lead first, and keeps the note when the recording is not there', async () => {
  // the post succeeded, every write of the saved list after it failed, the server restarted — then an admin restores
  const w = standard();
  try {
    w.consults = [...CONSULTS, DINA]; w.mode('on');
    await S.runOnce();
    const post = S.io.postEntry;
    S.io.postEntry = async (l, h) => { const r = await post(l, h); w.failWrite = 99; return r; };
    const saved = await S.assign({ otterId: 'ot_BBB222', leadId: DINA.id, actor: NAMED });
    assert.equal(saved.warning, 'Saved. The list may still show it for a few minutes.');
    S.io.postEntry = post;
    assert.deepEqual([w.store.data.recs.ot_BBB222.d, w.store.data.recs.ot_BBB222.tried], ['needs', [DINA.id]]);
    const posted = w.posts.length;
    S._reset(); w.failWrite = 0;
    delete w.traces.ot_BBB222;   // even without the trace file: the note on the entry is enough
    // the noted lead cannot be read: refused, nothing changed
    w.failFiledOn = true;
    await refuses(S.restore({ otterId: 'ot_BBB222' }), 502, /nothing was changed/);
    assert.deepEqual(w.store.data.recs.ot_BBB222.tried, [DINA.id]);
    w.failFiledOn = false;
    await refuses(S.restore({ otterId: 'ot_BBB222' }), 409, /saved on a consultation/);
    assert.deepEqual([w.store.data.recs.ot_BBB222.d, w.store.data.recs.ot_BBB222.leadId, w.store.data.recs.ot_BBB222.by], ['filed', DINA.id, 'found']);
    await S.runOnce();
    await refuses(S.assign({ otterId: 'ot_BBB222', leadId: A_ID, actor: NAMED }), 409, /already saved on another consultation/);
    assert.deepEqual([w.posts.length, [...new Set(w.posts.filter((p) => p.html.includes('ot_BBB222')).map((p) => p.leadId))]], [posted, [DINA.id]], 'the mark is on one lead only');
  } finally { w.restore(); }
  // the save was started but nothing was posted: the restore goes through — and the note stays, through the next run too
  const v = standard();
  try {
    v.consults = [...CONSULTS, DINA]; v.mode('on');
    await S.runOnce();
    v.failPost = 1;
    await refuses(S.assign({ otterId: 'ot_BBB222', leadId: DINA.id, actor: NAMED }), 502);
    delete v.traces.ot_BBB222;
    assert.deepEqual(await S.restore({ otterId: 'ot_BBB222' }), { ok: true, now: 'will be read again on the next run' });
    const e = v.store.data.recs.ot_BBB222;
    assert.deepEqual([e.d, e.tries, e.tried, e.fileId], ['failed', 0, [DINA.id], 'F-ot_BBB222'], 'kept for a fresh read, with the lead the save was started on');
    await S.runOnce();
    assert.deepEqual([v.store.data.recs.ot_BBB222.d, v.store.data.recs.ot_BBB222.tried], ['needs', [DINA.id]], 'the run that re-reads it carries the note over');
    // a dismissed one keeps it as well
    await S.dismiss({ otterId: 'ot_BBB222', actor: NAMED });
    await S.restore({ otterId: 'ot_BBB222' });
    assert.deepEqual([v.store.data.recs.ot_BBB222.d, v.store.data.recs.ot_BBB222.tried], ['needs', [DINA.id]]);
    // one at a time with a save of the same recording
    S._busy.add('ot_BBB222');
    await refuses(S.restore({ otterId: 'ot_BBB222' }), 409, /being saved right now/);
    S._busy.clear();
    // and never while the switch is not on: the saved list is not written
    const writes = v.writes;
    for (const m of ['off', 'report']) { v.mode(m); await refuses(S.restore({ otterId: 'ot_BBB222' }), 409, /not switched on/); }
    assert.equal(v.writes, writes);
  } finally { v.restore(); }
});

test('SECOND REVIEW 4: "report" is read-only — the strip is hidden, Save / Not a consultation / restore refuse, nothing is posted or written; the admin preview still works', async () => {
  const state = waiting(); state.recs.ot_CCC333 = { d: 'needs', reasonKey: 'noTitle', candidates: [A_ID], firstSeen: NOW, fileId: 'F-ot_BBB222' };
  const w = standard({ state });
  try {
    w.mode('report');
    assert.deepEqual(await S.needsList(), { on: false, items: [] });
    await refuses(S.assign({ otterId: 'ot_BBB222', leadId: A_ID, actor: NAMED }), 409, /not switched on/);
    await refuses(S.dismiss({ otterId: 'ot_CCC333', actor: NAMED }), 409, /not switched on/);
    await refuses(S.restore({ otterId: 'ot_CCC333' }), 409, /not switched on/);
    const r = await S.runOnce({ mode: 'report' });
    assert.deepEqual([r.ok, r.mode, r.totals.file], [true, 'report', 1], 'the preview works');
    assert.deepEqual([w.posts.length, w.uploads.length, w.writes, w.traceWrites, w.traceReads], [0, 0, 0, 0, 0], 'not one post, not one write');
    assert.deepEqual(Object.values(w.store.data.recs).map((e) => e.d), ['needs', 'needs'], 'the saved list is as it was');
    // switched on: the same list shows and the buttons work
    w.mode('on');
    assert.equal((await S.needsList()).on, true);
    assert.equal((await S.assign({ otterId: 'ot_BBB222', leadId: A_ID, actor: NAMED })).ok, true);
  } finally { w.restore(); }
});

test('SECOND REVIEW 5: the transcript file is never in a client\'s folder without the recording\'s mark on that lead — the summary is posted first, the file stored after', async () => {
  // staff save X to A: the post fails. Then they save it to B. Nothing of X may be left in A's folder.
  const w = standard({ folders: { [A_ID]: 'FOLDER-A', [B_ID]: 'FOLDER-B' } });
  try {
    w.mode('on');
    await S.runOnce();
    const mine = () => w.uploads.filter((u) => u.filename.includes('ot_BBB222')).map((u) => u.folderId);
    w.failPost = 1;
    await refuses(S.assign({ otterId: 'ot_BBB222', leadId: A_ID, actor: NAMED }), 502, /could not be saved to the client/);
    assert.deepEqual(mine(), [], 'the post failed: nothing was stored in client A\'s folder');
    const r = await S.assign({ otterId: 'ot_BBB222', leadId: B_ID, actor: NAMED });
    assert.deepEqual([r.ok, r.already, r.transcript], [true, false, 'folder']);
    assert.deepEqual(mine(), ['FOLDER-B'], 'stored once, in the folder of the client it was saved to');
    const onB = w.posts.filter((p) => p.leadId === B_ID);
    assert.deepEqual([onB.length, onB[0].html.endsWith('Otter recording ref: ot_BBB222'), onB[1].html.endsWith('Otter transcript ref: ot_BBB222')], [2, true, true]);
    assert.equal(w.posts.filter((p) => p.leadId === A_ID && p.html.includes('ot_BBB222')).length, 0);
  } finally { w.restore(); }
  // the order itself, and the retry: the file is stored only once the summary is on the lead; a failed link entry is
  // posted on the retry (the same file name replaces itself) and the summary is never posted twice
  const v = world({ folders: { [A_ID]: 'FOLDER-A' } });
  try {
    const f = { otterId: 'ot_EEE555', startTime: START, summary: 'Sum', transcript: 'Hello there' };
    const post = S.io.postEntry, save = S.io.saveTranscript; const order = []; let n = 0;
    S.io.postEntry = async (l, h) => { if (++n === 2) { order.push('post fails'); throw new Error('boom'); } order.push(h.includes('Otter recording ref: ') ? 'summary' : 'transcript'); return post(l, h); };
    S.io.saveTranscript = async (a) => { order.push('file'); return save(a); };
    await assert.rejects(S.fileOn(A_ID, f, { by: 'code' }));
    assert.deepEqual(order, ['summary', 'file', 'post fails']);
    assert.deepEqual([summaries(v, A_ID).length, v.uploads.map((u) => u.folderId)], [1, ['FOLDER-A']], 'the file is in the folder of the lead that carries the mark');
    const again = await S.fileOn(A_ID, f, { by: 'code' });
    assert.deepEqual(again, { ok: true, posted: 1, already: false, transcript: 'folder' });
    assert.deepEqual([order.slice(3), summaries(v, A_ID).length, new Set(v.uploads.map((u) => u.filename)).size], [['file', 'transcript'], 1, 1]);
    assert.deepEqual(await S.fileOn(A_ID, f, { by: 'code' }), { ok: true, posted: 0, already: true, transcript: 'kept' });
  } finally { v.restore(); }
});

test('SECOND REVIEW 6: a recording file that can never be opened — Save says so plainly (no "try again"), the row offers only "Not a consultation"; a passing fault keeps the retry wording', async () => {
  const files = [{ ...fileOf('ot_BIG000', START, 'Priya Example', 1), size: 4 * 1024 * 1024 }, fileOf('ot_MIX000', START, 'Priya Example', 2), fileOf('ot_JNK000', START, 'Priya Example', 3), fileOf('ot_BAD000', START, 'Priya Example', 4)];
  const w = world({ files, texts: { 'F-ot_MIX000': fileText({ id: 'ot_SOMEONE_ELSE', start: START }), 'F-ot_JNK000': 'Shopping list\nmilk, bread' }, consults: CONSULTS });
  try {
    w.mode('on'); w.failRead.add('F-ot_BAD000');
    for (let i = 0; i < S.MAX_TRIES; i++) await S.runOnce();
    const recs = w.store.data.recs;
    assert.deepEqual([recs.ot_BIG000.fault, recs.ot_MIX000.fault, recs.ot_JNK000.fault, recs.ot_BAD000.fault], ['TOO_LARGE', 'ID_MISMATCH', 'NOT_A_RECORDING', undefined], 'the kind of fault is kept (a code, never text)');
    for (const restart of [false, true]) {
      if (restart) S._reset();
      const items = (await S.needsList()).items;
      assert.equal(items.length, 4);
      for (const it of items) {
        const dead = it.otterId !== 'ot_BAD000';
        assert.deepEqual([it.saveable, it.candidates.length > 0], [!dead, !dead], it.otterId + ': no client is suggested for a file that cannot be opened');
        assert.equal(/choose the client/.test(it.reason), !dead, it.otterId + ': ' + it.reason);
        assert.ok(/Not a consultation/.test(it.reason) && !/\b(API|Zap|state|reader)\b/i.test(it.reason));
        if (dead) assert.match(it.reason, /cannot be opened, so it cannot be saved to a client from here/);
      }
    }
    for (const id of ['ot_BIG000', 'ot_MIX000', 'ot_JNK000']) {
      for (let press = 0; press < 2; press++) await refuses(S.assign({ otterId: id, leadId: A_ID, actor: NAMED }), 422, /cannot be opened, so it cannot be saved to a client from here/, /try again|just now|in a minute/i);
    }
    assert.ok(!w.reads.includes('F-ot_BIG000'), 'the file over the size cap is never downloaded — not by the list, not by Save');
    await refuses(S.assign({ otterId: 'ot_BAD000', leadId: A_ID, actor: NAMED }), 502, /could not be read just now.*Try again in a minute/);
    assert.deepEqual([w.posts.length, w.uploads.length, w.traceWrites], [0, 0, 0], 'nothing was posted, stored or traced');
    // "Not a consultation" works, and a restore brings the row back as it was
    assert.deepEqual(await S.dismiss({ otterId: 'ot_MIX000', actor: NAMED }), { ok: true });
    assert.equal((await S.needsList()).items.length, 3);
    await S.restore({ otterId: 'ot_MIX000' });
    assert.deepEqual([w.store.data.recs.ot_MIX000.d, w.store.data.recs.ot_MIX000.fault], ['needs', 'ID_MISMATCH']);
    leaks(w.logs.join('\n') + JSON.stringify(w.store.data), 'the logs and the saved list');
  } finally { w.restore(); }
  // the strip: such a row has no picker and no Save button — only "Not a consultation"
  const page = stripPage([ONE_ITEM({ otterId: 'ot_MIX000', snippet: '', fileRead: false, saveable: false, candidates: [], reason: 'The recording file cannot be opened' }), ONE_ITEM({ saveable: true })]);
  await page.tick();
  const [deadRow, liveRow] = page.byId['om-list'].kids;
  const tags = (n) => n.kids.map((k) => k.tag);
  assert.deepEqual(tags(deadRow.kids[1]), ['div', 'div'], 'no search box, no client picker');
  assert.deepEqual(deadRow.kids[1].kids[0].kids.map((k) => k.textContent), ['Not a consultation']);
  assert.equal(deadRow.kids[0].kids[2].textContent, 'This recording file cannot be opened.');
  assert.deepEqual([tags(liveRow.kids[1]), liveRow.kids[1].kids[4].kids.map((k) => k.textContent)], [['label', 'input', 'label', 'select', 'div', 'div'], ['Save to this client', 'Not a consultation']]);
  assert.equal(typeof deadRow.kids[1].kids[0].kids[0].onclick, 'function', 'and that button works');
  assert.equal(page.sent.length, 0);
});

test('SECOND REVIEW 8: an update is an Otter entry only when the app filed it — a note that merely contains the machine line gets no links; a transcript is linked only on the firm\'s own host', async () => {
  const orig = mondayApi.query;
  const { noteHtml } = require('../src/services/emailLeadsService');
  const planted = 'Hello,\nRecording in Otter: https://otter.ai/u/phish\nFull transcript (in the client\'s folder): https://attacker.sharepoint.com/sites/login\nOtter recording ref: abc123';
  const emailNote = noteHtml({ subject: 'Question', receivedDateTime: '2026-11-12T15:00:00Z', from: { emailAddress: { name: 'Outside Sender', address: 'outside@example.net' } }, body: { contentType: 'text', content: planted }, bodyPreview: planted }, { isNewLead: false, box: 'office@example.com' });
  assert.ok(emailNote.includes('Otter recording ref: abc123') && emailNote.includes('attacker.sharepoint.com'), 'the scenario: the sender\'s lines are in the note');
  const rec0 = { otterId: 'ot_AAA111', startTime: START, summary: 'Sum', otterLink: 'https://otter.ai/u/ot_AAA111' };
  const updates = [
    { id: '1', body: emailNote, text_body: 'Email received — the text Monday keeps', created_at: '2026-11-12T20:00:00Z', creator: { name: 'App' }, replies: [] },
    { id: '2', body: '<p>Typed by staff</p><p>Recording in Otter: https://otter.ai/u/x</p><p>Otter recording ref: abc123</p>', text_body: 'Typed by staff …', created_at: '2026-11-12T19:00:00Z', creator: { name: 'Staff' }, replies: [] },
    { id: '3', body: S.buildTranscriptLinkEntry(rec0, 'https://attacker.sharepoint.com/sites/login'), text_body: 'x', created_at: '2026-11-12T18:00:00Z', creator: { name: 'App' }, replies: [] },
    { id: '4', body: S.buildTranscriptLinkEntry(rec0, 'https://example.sharepoint.com/t/abc'), text_body: 'x', created_at: '2026-11-12T17:00:00Z', creator: { name: 'App' }, replies: [] },
    { id: '5', body: `<p>${S.buildSummaryEntry(rec0, { by: 'code' })}</p>`, text_body: 'x', created_at: '2026-11-12T16:00:00Z', creator: { name: 'App' }, replies: [] },
  ];
  const w = world({ folders: { [A_ID]: 'FOLDER1' } });
  try {
    mondayApi.query = async () => ({ items: [{ updates }] });
    // no transcript stored yet: no host is known — not even the firm's own address is a link
    let ups = await U.getUpdatesForItem('55');
    for (const i of [0, 1]) {
      assert.deepEqual(Object.keys(ups[i]).sort(), ['at', 'body', 'by', 'id', 'origin', 'replies'], 'not an Otter entry: shaped as every ordinary update — no otter flag, no links');
      assert.equal(ups[i].body, updates[i].text_body, 'and read from Monday\'s own text, as before');
    }
    assert.deepEqual([ups[2].otter, ups[2].links, ups[3].otter, ups[3].links], [true, [], true, []], 'no trustworthy host known: the address shows as text');
    assert.ok(ups[3].body.includes('Full transcript (in the client\'s folder): https://example.sharepoint.com/t/abc'), 'still readable');
    assert.deepEqual([ups[4].otter, ups[4].links], [true, ['https://otter.ai/u/ot_AAA111']], 'the app\'s own entry (Monday may wrap it in a paragraph)');
    // the app stores a transcript: the host of ITS OWN upload is the only one linked — another tenant never
    await S.fileOn(A_ID, { otterId: 'ot_HOST001', startTime: START, summary: 'Sum', transcript: 'Hello there' }, { by: 'code' });
    assert.deepEqual(await S.transcriptHosts(), ['example.sharepoint.com']);
    ups = await U.getUpdatesForItem('55');
    assert.deepEqual([ups[2].links, ups[3].links], [[], ['https://example.sharepoint.com/t/abc']], 'attacker.sharepoint.com is not the firm');
    assert.equal(ups[0].otter, undefined);
    // the host is kept in the saved list and read back after a restart
    w.mode('on'); w.files = []; w.store = { data: waiting(), etag: 'e0' };
    await S.dismiss({ otterId: 'ot_BBB222', actor: NAMED });
    assert.deepEqual(w.store.data.transcriptHosts, ['example.sharepoint.com']);
    S._reset();
    ups = await U.getUpdatesForItem('55');
    assert.deepEqual([ups[2].links, ups[3].links], [[], ['https://example.sharepoint.com/t/abc']]);
    // a host that is not a plain <name>.sharepoint.com in the saved list is not trusted
    w.store.data.transcriptHosts = ['evil.example', 'x.sharepoint.com.evil.example', 'https://attacker.sharepoint.com'];
    S._reset();
    assert.deepEqual(await S.transcriptHosts(), []);
    // the saved list cannot be read: text, never an error on the Updates box
    S._reset(); S.io.readState = async () => { throw new Error('down'); };
    ups = await U.getUpdatesForItem('55');
    assert.deepEqual([ups.length, ups[3].links], [5, []]);
  } finally { mondayApi.query = orig; w.restore(); }
  assert.equal(U.isFiledOtterEntry({ body: `${U.OTTER_HEADER} — pasted by staff, no machine line` }), false);
  assert.equal(U.isFiledOtterEntry({ body: `x ${U.OTTER_HEADER}<br>Otter recording ref: abc123` }), false, 'the heading must START the entry');
});

test('SECOND REVIEW 9: a recording saved a moment ago never shows once more — the held entry is written before the list is read', async () => {
  const w = standard();
  try {
    w.mode('on');
    await S.runOnce();
    const post = S.io.postEntry;
    S.io.postEntry = async (l, h) => { const r = await post(l, h); w.failWrite = 2; return r; };   // both writes of the "filed" entry fail
    const r = await S.assign({ otterId: 'ot_BBB222', leadId: B_ID, actor: NAMED });
    S.io.postEntry = post;
    assert.deepEqual([r.ok, r.warning, w.store.data.recs.ot_BBB222.d, w.failWrite], [true, 'Saved. The list may still show it for a few minutes.', 'needs', 0]);
    const first = await S.needsList();
    assert.deepEqual([first.items.map((x) => x.otterId), w.store.data.recs.ot_BBB222.d], [[], 'filed'], 'the very first look at the list does not show it');
    assert.deepEqual((await S.needsList()).items, []);
    // and when the write still fails, the row stays hidden all the same
    S._reset(); w.store.data.recs.ot_BBB222 = waiting().recs.ot_BBB222; w.posts.length = 0; delete w.traces.ot_BBB222;
    S.io.postEntry = async (l, h) => { const x = await post(l, h); w.failWrite = 99; return x; };
    await S.assign({ otterId: 'ot_BBB222', leadId: B_ID, actor: NAMED });
    assert.deepEqual((await S.needsList()).items, []);
  } finally { w.restore(); }
});
