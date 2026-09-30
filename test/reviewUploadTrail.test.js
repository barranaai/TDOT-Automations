'use strict';

// The staff surfaces of the re-upload fix (plan §3d/§3e, amendments A7, A9, A11):
// the /d review page lists every copy the client uploaded for a row (parsed
// from the "Document Uploaded by Client" notes Monday already holds), a
// Received row with a review note gets a label that makes NO claim about
// which upload the note predates, and the cockpit deep-links to the row.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');

const svc       = require('../src/services/documentReviewFormService');
const mondayApi = require('../src/services/mondayApi');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

// ─── Fixtures: the three note shapes that exist on the boards ───────────────

// New note (documentFormService.postUploadUpdates with UPLOAD_UNIQUE_NAMES on).
const NEW_NOTE =
  '📄 Document Uploaded by Client\n\n' +
  'Document: Passport\n' +
  'File: Passport – PA – 2026-09-30 14-32 – passport 1.pdf\n' +
  'Category: Identity\n' +
  'Case: 2026-CEC-EE-065 (Jane Doe)\n' +
  'For: Principal Applicant\n' +
  'Named by client: passport.pdf\n' +
  'Note: OneDrive added a number to the name because a file with this name already existed — both files are kept.\n' +
  'Uploaded: 2026-09-30, 2:32:10 p.m. (Toronto)\n\n' +
  '🔗 Open this upload: https://tdotimm-my.sharepoint.com/:b:/g/personal/x/abc?e=1\n' +
  '📁 Folder: https://tdotimm-my.sharepoint.com/:f:/g/personal/x/folder\n\n' +
  'Status set to Received — please review.\n\n' +
  '🔎 Review all documents for this case: https://app/d/2026-CEC-EE-065/review';

// Today's note (the fixture shape test/documentRefile.test.js pins) — no link line.
const OLD_NOTE =
  '📄 Document Uploaded by Client\n\nDocument: Passport\nFile: scan passport.pdf\nCategory: General\n' +
  'Case: 2026-SPE-013 (Client)\nUploaded: t (Toronto)\n\nStatus set to Received — please review.';

// A11: Monday can hand the body back without the leading emoji — still an upload note.
const NO_EMOJI_NOTE = 'Document Uploaded by Client\n\nDocument: X\nFile: a b.pdf\nCategory: Identity\nCase: Y';

// A client reply that happens to contain the marker text — never an upload.
const REPLY = '\u2709\ufe0f Client Reply\n\nCase: 2026-CEC-EE-065\n\n"I re-scanned it — Document Uploaded by Client"\n\nPosted from the Document Upload Portal at t (Toronto).';

const NEW_PARSED = {
  storedName:   'Passport – PA – 2026-09-30 14-32 – passport 1.pdf',
  originalName: 'passport.pdf',
  member:       'Principal Applicant',
  url:          'https://tdotimm-my.sharepoint.com/:b:/g/personal/x/abc?e=1',
};

// ─── (45) parseUploadNotes ──────────────────────────────────────────────────

test('parseUploadNotes: the new note yields name, member, original name and link — newlines kept OR collapsed', () => {
  for (const [label, body] of [['kept', NEW_NOTE], ['collapsed', NEW_NOTE.replace(/\n/g, ' ')]]) {
    const [u] = svc.parseUploadNotes([{ id: 'u1', text_body: body, created_at: '2026-09-30T18:32:10Z' }]);
    assert.deepEqual(u, { id: 'u1', createdAt: '2026-09-30T18:32:10Z', ...NEW_PARSED }, `newlines ${label}`);
  }
  // Without the "Note:" line the original name still stops before "Uploaded:".
  const plain = NEW_NOTE.replace(/Note: [^\n]+\n/, '');
  for (const body of [plain, plain.replace(/\n/g, ' ')]) {
    assert.equal(svc.parseUploadNotes([{ id: 'u', text_body: body }])[0].originalName, 'passport.pdf');
  }
});

test('parseUploadNotes: today\'s note → File: as the stored name, url \'\' (no link was ever recorded); the emoji is optional', () => {
  for (const body of [OLD_NOTE, OLD_NOTE.replace(/\n/g, ' ')]) {
    assert.deepEqual(svc.parseUploadNotes([{ id: 'o', text_body: body, created_at: 't1' }]),
      [{ id: 'o', storedName: 'scan passport.pdf', originalName: '', member: '', url: '', createdAt: 't1' }]);
  }
  assert.equal(svc.parseUploadNotes([{ id: 'n', text_body: NO_EMOJI_NOTE }])[0].storedName, 'a b.pdf');
});

test('parseUploadNotes: client replies and other notes are skipped; entries come newest first', () => {
  const updates = [
    { id: 'r',  text_body: REPLY, created_at: '2026-09-30T20:00:00Z' },
    { id: 'o',  text_body: OLD_NOTE, created_at: '2026-09-01T10:00:00Z' },
    { id: 'x',  text_body: '🔄 Rework Requested by Staff\n\nDocument: Passport', created_at: '2026-09-15T10:00:00Z' },
    { id: 'n',  text_body: NEW_NOTE, created_at: '2026-09-30T18:32:10Z' },
    { id: 'e',  text_body: '', created_at: '2026-09-30T19:00:00Z' },
  ];
  const list = svc.parseUploadNotes(updates);
  assert.deepEqual(list.map((u) => u.id), ['n', 'o'], 'only upload notes, newest first');
  assert.deepEqual(svc.parseUploadNotes([]), []);
  assert.deepEqual(svc.parseUploadNotes(undefined), []);
});

// ─── (46) parseReplies unchanged; the route answers replies + uploads from ONE read ──

test('parseReplies: unchanged — quoted reply body, author, newest first; upload notes excluded', () => {
  const updates = [
    { id: 'n', text_body: NEW_NOTE, created_at: '2026-09-30T18:32:10Z', creator: { name: 'TDOT Bot' } },
    { id: 'r1', text_body: REPLY, created_at: '2026-09-30T20:00:00Z', creator: { name: 'Jane' } },
    { id: 'r2', text_body: 'Client Reply\n\nCase: X\n\n"older reply"', created_at: '2026-09-29T20:00:00Z' },
  ];
  assert.deepEqual(svc.parseReplies(updates), [
    { id: 'r1', body: 'I re-scanned it — Document Uploaded by Client', createdAt: '2026-09-30T20:00:00Z', author: 'Jane' },
    { id: 'r2', body: 'older reply', createdAt: '2026-09-29T20:00:00Z', author: 'Client' },
  ]);
});

function fakeItems() {
  return [
    { id: '11', updates: [
      { id: 'r1', text_body: REPLY, created_at: '2026-09-30T20:00:00Z', creator: { name: 'Jane' } },
      { id: 'n1', text_body: NEW_NOTE, created_at: '2026-09-30T18:32:10Z' },
      { id: 'o1', text_body: OLD_NOTE, created_at: '2026-09-01T10:00:00Z' },
    ] },
    { id: '12', updates: [] },
  ];
}

test('getClientReplies keeps its map shape (every row present) and getRowUpdates adds the trail — ONE Monday query each', async () => {
  let calls = 0, vars = null;
  const restore = stub(mondayApi, 'query', async (q, v) => { calls++; vars = v; assert.match(q, /items\(ids: \$ids, limit: \$ilim\)/); return { items: fakeItems() }; });
  try {
    const replies = await svc.getClientReplies(['11', 12]);
    assert.equal(calls, 1);
    assert.deepEqual(vars, { ids: ['11', '12'], limit: 25, ilim: 2 });
    assert.deepEqual(Object.keys(replies), ['11', '12']);
    assert.deepEqual(replies['11'].map((r) => r.id), ['r1']);
    assert.deepEqual(replies['12'], []);

    calls = 0;
    const both = await svc.getRowUpdates(['11', '12']);
    assert.equal(calls, 1, 'replies and uploads come out of the same read');
    assert.deepEqual(both.replies['11'].map((r) => r.id), ['r1']);
    assert.deepEqual(both.uploads['11'].map((u) => u.id), ['n1', 'o1']);
    assert.deepEqual(both.uploads['12'], []);
    assert.deepEqual(await svc.getRowUpdates([]), { replies: {}, uploads: {} });
    assert.equal(calls, 1, 'no ids → no query');
  } finally { restore(); }
});

test('GET /d/:caseRef/review/updates answers { ok, replies, uploads } from ONE mondayApi.query', async () => {
  const router     = require('../src/routes/documentReviewForm');
  const docFormSvc = require('../src/services/documentFormService');
  const layer = router.stack.find((l) => l.route && l.route.path === '/:caseRef/review/updates');
  const handle = layer.route.stack[layer.route.stack.length - 1].handle; // past requireStaffAuth

  const prevAdmins = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 't4@test.local';               // admin viewer → no assignee read
  let calls = 0;
  const restore = [
    stub(mondayApi, 'query', async () => { calls++; return { items: fakeItems() }; }),
    stub(docFormSvc, 'getCaseSummary', async () => ({ clientName: 'Jane', items: [{ id: '11', name: 'Passport' }, { id: '12', name: 'Photo' }] })),
  ];
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  try {
    await handle({ params: { caseRef: '2026-CEC-EE-065' }, staff: { email: 't4@test.local', name: 'T4' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls, 1, 'one Monday read for both lists');
    assert.deepEqual(Object.keys(res.body), ['ok', 'replies', 'uploads']);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.replies['11'].map((r) => r.body), ['I re-scanned it — Document Uploaded by Client']);
    assert.deepEqual(res.body.uploads['11'].map((u) => u.storedName), [NEW_PARSED.storedName, 'scan passport.pdf']);
    assert.deepEqual(res.body.uploads['11'].map((u) => u.url), [NEW_PARSED.url, '']);
    assert.deepEqual(res.body.uploads['12'], []);

    // No checklist rows → both maps empty, nothing read.
    calls = 0;
    restore.push(stub(docFormSvc, 'getCaseSummary', async () => ({ items: [] })));
    const res2 = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await handle({ params: { caseRef: '2026-CEC-EE-065' }, staff: { email: 't4@test.local' } }, res2);
    assert.deepEqual(res2.body, { ok: true, replies: {}, uploads: {} });
    assert.equal(calls, 0);
  } finally {
    restore.forEach((r) => r());
    if (prevAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = prevAdmins;
  }
});

// ─── (47) rowHtml: anchor, slot, the neutral label; the emitted script parses and renders ──

function assertScriptsParse(html, page) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html))) {
    n++;
    try { new vm.Script(m[1]); }
    catch (err) { assert.fail(`${page}: emitted <script> #${n} does not parse — ${err.message}`); }
  }
  assert.ok(n >= 1, `${page}: no <script> block found`);
}

function reviewPage(items) {
  return svc.buildReviewPage({ caseRef: '2026-CEC-EE-065', clientName: 'Jane', staffName: 'S', items, folderLinks: {} });
}
const row = (id, status, reviewNotes = '') => ({ id, name: 'Passport ' + id, category: 'Identity', applicantType: 'Principal Applicant', status, reviewNotes, lastUpload: '2026-09-30' });
// The row's meta cell (name, note, slots) — from its anchor to its status cell.
const rowBlock = (html, id) => {
  const start = html.indexOf(`id="doc-${id}"`);
  assert.ok(start !== -1, `row ${id} carries id="doc-${id}"`);
  const end = html.indexOf('<div class="status-cell">', start);
  assert.ok(end !== -1, `row ${id} has a status cell`);
  return html.slice(start, end);
};

test('rowHtml: every row has id="doc-<id>" and an uploads-slot placed after the review note', () => {
  const html = reviewPage([row('101', 'Received', 'page 2 is blurred'), row('102', 'Missing')]);
  for (const id of ['101', '102']) {
    const block = rowBlock(html, id);
    assert.ok(block.includes(`<div class="uploads-slot" data-item-id="${id}"></div>`), `row ${id} has its uploads-slot`);
    assert.ok(block.includes(`<div class="replies-slot" data-item-id="${id}"></div>`), `row ${id} keeps its replies-slot`);
  }
  const b = rowBlock(html, '101');
  assert.ok(b.indexOf('class="review-notes"') < b.indexOf('class="uploads-slot"'), 'the trail renders BELOW the note, as the label says');
  assert.ok(b.indexOf('class="uploads-slot"') < b.indexOf('class="replies-slot"'), 'trail before replies');
});

test('rowHtml: a Received row with a note gets the neutral label (A7) — no ordering claim, "since" never appears', () => {
  const html = reviewPage([
    row('201', 'Received', 'page 2 is blurred'),
    row('202', 'Reviewed', 'fine'),
    row('203', 'Rework Required', 'redo'),
    row('204', 'Received'),
  ]);
  const NEUTRAL = '📝 Review note on file (row is Received — see the upload trail below):';
  assert.ok(rowBlock(html, '201').includes(`<strong>${NEUTRAL}</strong> page 2 is blurred`), 'Received + note → neutral label');
  assert.ok(rowBlock(html, '202').includes('<strong>📝 Existing review note:</strong> fine'), 'Reviewed keeps today\'s label');
  assert.ok(rowBlock(html, '203').includes('<strong>📝 Existing review note:</strong> redo'), 'Rework Required keeps today\'s label');
  assert.ok(!rowBlock(html, '204').includes('review-notes'), 'no note → no block');
  assert.equal((html.match(/Review note on file/g) || []).length, 1, 'the neutral label appears on the one Received row only');
  for (const m of html.match(/<div class="review-notes">[\s\S]*?<\/div>/g) || []) {
    assert.ok(!/\bsince\b/i.test(m), 'no note label claims what happened "since": ' + m);
  }
  assert.ok(!/uploaded since|Previous rework note/i.test(html), 'the ordering-claiming wording is gone');
});

test('review page script: parses, renders the trail through renderUploads, obeys the inline-JS rules', () => {
  const html = reviewPage([row('301', 'Received', 'n'), row('302', 'Received')]);
  assertScriptsParse(html, 'doc review page');
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  assert.ok(script.includes('renderUploads(data.uploads || {})'), 'the page renders uploads from the same /review/updates answer');
  const a = script.indexOf('function uploadLine'), b = script.indexOf('function showRepliesError');
  assert.ok(a !== -1 && b > a, 'uploadLine + renderUploads are emitted before showRepliesError');
  const block = script.slice(a, b);
  assert.ok(!block.includes('`') && !block.includes('${') && !block.includes('\\'), 'no backtick / ${ / backslash inside the trail block (template-literal traps)');
});

test('renderUploads (executed from the emitted script): link only for https, older copies collapsed, everything escaped', () => {
  const html = reviewPage([row('401', 'Received')]);
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  // escText + fmtWhen + … + renderUploads live between these two markers.
  const src = script.slice(script.indexOf('function escText'), script.indexOf('function showRepliesError'));

  const slot = (id) => ({ attrs: { 'data-item-id': id }, innerHTML: 'stale', getAttribute(k) { return this.attrs[k]; } });
  const slots = { '401': slot('401'), '402': slot('402') };
  const fakeDocument = { querySelectorAll: (sel) => (sel === '.uploads-slot' ? Object.values(slots) : []) };
  const now = Date.now();
  const uploads = {
    '401': [
      { id: 'n', storedName: 'Passport – PA – 2026-09-30 14-32 – passport 1.pdf', originalName: 'passport.pdf', member: 'Principal Applicant', url: 'https://org/x?e=1&y=2', createdAt: new Date(now - 2 * 3600e3).toISOString() },
      { id: 'o', storedName: 'scan passport.pdf', originalName: '', member: '', url: '', createdAt: new Date(now - 3 * 86400e3).toISOString() },
      { id: 'h', storedName: '<img src=x onerror=alert(1)>.pdf', originalName: '"quoted" & <b>', member: '', url: 'javascript:alert(1)', createdAt: '' },
      { id: 's', storedName: 'same.pdf', originalName: 'same.pdf', member: '', url: 'http://plain/insecure', createdAt: 'not a date' },
    ],
    // '402' has no entries → the slot is cleared, nothing rendered
  };
  vm.runInNewContext(src + '\nrenderUploads(UPLOADS);', { document: fakeDocument, Date, UPLOADS: uploads });

  const out = slots['401'].innerHTML;
  assert.ok(out.startsWith('<div class="upload-line">📎 <a href="https://org/x?e=1&amp;y=2" target="_blank" rel="noopener">Passport – PA – 2026-09-30 14-32 – passport 1.pdf</a> · <span class="upload-when">2h ago</span> · <span class="upload-sent">sent as passport.pdf</span></div>'),
    'newest first, linked, when + sent-as: ' + out);
  assert.ok(out.includes('<details class="upload-earlier"><summary>3 earlier ▸</summary>'), 'older copies collapsed with a count');
  assert.ok(out.includes('📎 scan passport.pdf · <span class="upload-when">3d ago</span></div>'), 'an old note: plain name, no link, no sent-as');
  assert.ok(out.includes('📎 &lt;img src=x onerror=alert(1)&gt;.pdf') && !out.includes('<img'), 'stored name escaped');
  assert.ok(out.includes('sent as &quot;quoted&quot; &amp; &lt;b&gt;'), 'original name escaped');
  assert.ok(!out.includes('javascript:') && !out.includes('href="http://'), 'only https URLs become links');
  assert.ok(out.includes('📎 same.pdf</div>'), 'identical stored/original name → no redundant "sent as", no when for an unparsable date');
  assert.equal((out.match(/<a /g) || []).length, 1, 'exactly one hyperlink');
  assert.equal(slots['402'].innerHTML, '', 'a row without uploads renders nothing (stale content cleared)');
});

// ─── (48) cockpit: renderDocRow emits the 📎 Files deep link ────────────────

test('cockpit renderDocRow emits a "📎 Files" link to /d/<ref>/review#doc-<id> and stays inside the inline-JS rules', () => {
  const { buildCockpitHTML } = require('../src/routes/adminCase');
  const html = buildCockpitHTML('2026-CEC-EE-065');
  assertScriptsParse(html, 'cockpit');
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  const a = script.indexOf('function renderDocRow'), b = script.indexOf('function renderDocCat');
  assert.ok(a !== -1 && b > a, 'renderDocRow is emitted');
  const block = script.slice(a, b);
  assert.ok(block.includes("'/review#doc-' + encodeURIComponent(it.id)"), 'the link targets the row anchor on the review page');
  assert.ok(block.includes("encodeURIComponent(CASE_REF) + '/review#doc-'"), 'the link is built from the page\'s CASE_REF');
  assert.ok(block.includes('📎 Files'), 'labelled 📎 Files');
  assert.ok(block.includes('target="_blank" rel="noopener"'), 'opens in a new tab');
  assert.ok(!block.includes('`') && !block.includes('${') && !block.includes('\\'), 'no backtick / ${ / backslash inside renderDocRow');

  // Run the emitted function over a row to pin the exact anchor it produces.
  const fn = script.slice(a, b);
  const out = vm.runInNewContext(
    "function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}\n" +
    'var DOC_DOT = {}; var CASE_REF = "2026-CEC-EE-065";\n' + fn + '\nrenderDocRow(ROW);',
    { ROW: { id: '9001', name: 'Passport', status: 'Received', lastUpload: '2026-09-30', reviewNotes: '' }, encodeURIComponent }
  );
  assert.ok(out.includes('<a class="sbtn" href="/d/2026-CEC-EE-065/review#doc-9001" target="_blank" rel="noopener"'), out);
  assert.ok(out.includes('data-doc-act="reviewed"'), 'the existing inline actions are untouched');
  const noId = vm.runInNewContext(
    "function escHtml(s){return String(s==null?'':s);}\nvar DOC_DOT = {}; var CASE_REF = 'X';\n" + fn + '\nrenderDocRow(ROW);',
    { ROW: { name: 'Passport', status: 'Missing' }, encodeURIComponent }
  );
  assert.ok(!noId.includes('📎 Files'), 'no row id → nothing to link to');
});
