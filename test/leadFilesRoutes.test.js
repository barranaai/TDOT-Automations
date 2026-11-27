// The lead page's "Attachments" (Faran 2026-11-27) — the two READ-ONLY routes with fakes: the plain-words
// refusals (400 / 404 / 413 / 429 / 503), the exact headers of a file shown in a tab and of a download, the
// log line (lead id + key + who — never a file name), the team-key gate (no Monday sign-in needed), and the
// wiring in server.js. Every name, id and key here is invented.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Writable } = require('node:stream');
const express = require('express');

const routes = require('../src/routes/leadFilesRoutes');
const realSvc = require('../src/services/leadFilesService');

const LEAD = '9000000001';
const KEY = 'ab12cd34ef56ab12cd34ef56';
const STAFF = { id: '42', email: 'staff.one@tdotimm.com', name: 'Staff One', teamIds: [] };
const STORED = '2026-11-04 1432 - Staff One - Test Person passport.pdf';

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined, ended: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.end = (b) => { r.ended = b; return r; };
  return r;
}
/** A writable response with Express's own set (the real Content-Type handling). */
function bytesRes() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  const headers = {};
  Object.assign(w, {
    statusCode: 200, body: undefined, headers, chunks,
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, getHeader: (k) => headers[k.toLowerCase()],
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    set: express.response.set, header: express.response.header, get: express.response.get,
  });
  return w;
}
const req = (params = {}) => ({ params: { leadId: LEAD, key: KEY, ...params }, query: {}, headers: {} });
const PDF = Buffer.from('%PDF-1.4 test bytes');

function fakeService(o = {}) {
  const calls = [];
  return {
    calls,
    listLeadFiles: async (id) => { calls.push(['list', id]); if (o.listThrows) throw new Error(`OneDrive list failed for ${STORED}`); return o.list || { state: 'ok', files: [] }; },
    readLeadFile: async (id, key) => {
      calls.push(['read', id, key]);
      if (o.wait) await o.wait;
      if (o.readThrows) throw new Error(`OneDrive read failed for ${STORED}`);
      return o.file || { buffer: PDF, mime: 'application/pdf', ext: 'pdf', downloadName: 'Test Person passport.pdf', view: 'tab', kind: 'staff' };
    },
  };
}
const deps = (service, staff = null) => ({ service, staff: () => staff });
const quiet = async (fn) => { const keep = { log: console.log, warn: console.warn, error: console.error }; const logs = []; console.log = console.warn = console.error = (...a) => logs.push(a.join(' ')); try { await fn(logs); } finally { Object.assign(console, keep); } return logs; };

/* ══ the list ═════════════════════════════════════════════════════════════════ */

test('list: 200 { state: "ok", files } exactly as the service gives them; never cached', async () => {
  const files = [{ key: KEY, label: 'Refusal letter', kind: 'client', ext: 'pdf', size: 10, modified: '2026-11-01T10:00:00Z', view: 'tab' }];
  const s = fakeService({ list: { state: 'ok', files } });
  const res = fakeRes();
  await routes.list(req(), res, deps(s));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { state: 'ok', files });
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.deepEqual(s.calls, [['list', LEAD]]);
  // no files is still a clean answer; a half look is marked
  let r2 = fakeRes(); await routes.list(req(), r2, deps(fakeService()));
  assert.deepEqual(r2.body, { state: 'ok', files: [] });
  r2 = fakeRes(); await routes.list(req(), r2, deps(fakeService({ list: { state: 'ok', files, partial: true } })));
  assert.deepEqual(r2.body, { state: 'ok', files, partial: true });
});

test('list: "could not check" is still a 200 the page can show — never an empty ok; a service that throws is the same', async () => {
  for (const s of [fakeService({ list: { state: 'unchecked', files: [], reason: 'folder-busy' } }), fakeService({ listThrows: true })]) {
    const res = fakeRes();
    const logs = await quiet(() => routes.list(req(), res, deps(s)));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.state, 'unchecked'); assert.deepEqual(res.body.files, []);
    assert.equal(res.body.message, 'Could not reach the files just now — try again.');
    assert.match(res.body.reason, /^(folder-busy|storage)$/);
    assert.equal(logs.length, 1); assert.match(logs[0], new RegExp(`^\\[LeadFiles\\] lead ${LEAD}: the files could not be checked \\((folder-busy|storage)\\)$`));
    assert.ok(!logs[0].includes('passport'));
  }
});

test('list: a bad lead id → 400 in plain words, nothing read; a lead that is not there → 404', async () => {
  for (const bad of ['12', 'abc', '../1234567', '1234567x', '9'.repeat(21), '']) {
    const s = fakeService(); const res = fakeRes();
    await routes.list(req({ leadId: bad }), res, deps(s));
    assert.equal(res.statusCode, 400, bad); assert.deepEqual(res.body, { error: 'Which client? (bad lead id)' });
    assert.equal(s.calls.length, 0);
  }
  const res = fakeRes();
  await routes.list(req(), res, deps(fakeService({ list: { state: 'not-found', files: [] } })));
  assert.equal(res.statusCode, 404); assert.deepEqual(res.body, { error: 'That client could not be found — refresh the page.' });
});

/* ══ one file ═════════════════════════════════════════════════════════════════ */

test('file shown in a tab: the fixed content type, its length, inline with the safe name, nosniff, a sandbox CSP, never cached — and the bytes', async () => {
  const s = fakeService();
  const res = bytesRes();
  const logs = await quiet(async () => { await routes.file(req(), res, deps(s, STAFF)); await new Promise((r) => res.on('finish', r)); });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.headers, {
    'cache-control': 'private, no-store',
    'content-type': 'application/pdf',
    'content-length': String(PDF.length),
    'content-disposition': 'inline; filename="Test Person passport.pdf"',
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
  });
  assert.ok(Buffer.concat(res.chunks).equals(PDF));
  assert.deepEqual(s.calls, [['read', LEAD, KEY]]);
  assert.deepEqual(logs, [`[LeadFiles] lead ${LEAD}: file ${KEY} opened by Staff One (staff.one@tdotimm.com) (staff, ${PDF.length} bytes)`]);
});

test('a download (heic): attachment, the stricter CSP; pictures keep their own fixed type', async () => {
  const heic = { buffer: Buffer.from('heic-bytes'), mime: 'image/heic', ext: 'heic', downloadName: 'IMG_0042.heic', view: 'download', kind: 'staff' };
  let res = bytesRes();
  await quiet(async () => { await routes.file(req(), res, deps(fakeService({ file: heic }))); await new Promise((r) => res.on('finish', r)); });
  assert.equal(res.headers['content-type'], 'image/heic');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="IMG_0042.heic"');
  assert.equal(res.headers['content-security-policy'], "sandbox; default-src 'none'");
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(Buffer.concat(res.chunks).toString(), 'heic-bytes');
  for (const [mime, name] of [['image/jpeg', 'enforcement-letter.jpg'], ['image/png', 'reference-letter.png'], ['image/webp', 'scan.webp']]) {
    res = bytesRes();
    await quiet(async () => { await routes.file(req(), res, deps(fakeService({ file: { buffer: PDF, mime, ext: name.split('.')[1], downloadName: name, view: 'tab', kind: 'client' } }))); await new Promise((r) => res.on('finish', r)); });
    assert.equal(res.headers['content-type'], mime);
    assert.equal(res.headers['content-disposition'], `inline; filename="${name}"`);
  }
});

test('the save name can never break the header, whatever the service hands over', async () => {
  for (const [given, sent] of [['a"b\r\nSet-Cookie: x=1.pdf', 'abSet-Cookie x1.pdf'], ['', 'attachment.pdf'], [undefined, 'attachment.pdf'], ['جواز.pdf', 'attachment.pdf'], ['....', 'attachment.pdf'], ['scan (2).PDF', 'scan (2).PDF']]) {
    const res = fakeRes();
    await quiet(() => routes.file(req(), res, deps(fakeService({ file: { buffer: PDF, mime: 'application/pdf', ext: 'pdf', downloadName: given, view: 'tab', kind: 'staff' } }))));
    assert.equal(res.headers['content-disposition'], `inline; filename="${sent}"`);
    assert.match(res.headers['content-disposition'], /^inline; filename="[A-Za-z0-9 ._()-]+"$/);
  }
});

test('the log line: lead id + key + who — "team key" without a Monday sign-in; never the file name, never the client name', async () => {
  const file = { buffer: PDF, mime: 'application/pdf', ext: 'pdf', downloadName: 'Test Person passport.pdf', view: 'tab', kind: 'staff' };
  const cases = [
    [null, 'team key'],
    [STAFF, 'Staff One (staff.one@tdotimm.com)'],
    [{ email: 'staff.two@tdotimm.com' }, 'staff.two@tdotimm.com'],
    [{ name: 'Staff\nThree' }, 'Staff Three'],
    [{}, 'team key'],
  ];
  for (const [staff, who] of cases) {
    const res = fakeRes();
    const logs = await quiet(() => routes.file(req(), res, deps(fakeService({ file }), staff)));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(logs, [`[LeadFiles] lead ${LEAD}: file ${KEY} opened by ${who} (staff, ${PDF.length} bytes)`]);
    assert.ok(!/passport|Test Person|\.pdf/.test(logs[0]));
  }
  // a sign-in check that breaks never blocks the open — the team key is the gate
  const res = fakeRes();
  const logs = await quiet(() => routes.file(req(), res, { service: fakeService({ file }), staff: () => { throw new Error('jwt malformed'); } }));
  assert.equal(res.statusCode, 200); assert.match(logs[0], /opened by team key/);
  const res2 = fakeRes();
  await quiet(() => routes.file(req(), res2, { service: fakeService({ file }) }));
  assert.equal(res2.statusCode, 200);
});

test('validation: a bad lead id or a bad key → 400 in plain words before anything is read', async () => {
  for (const bad of ['12', 'abc', '../1234567', '']) {
    const s = fakeService(); const res = fakeRes();
    await routes.file(req({ leadId: bad }), res, deps(s));
    assert.equal(res.statusCode, 400); assert.deepEqual(res.body, { error: 'Which client? (bad lead id)' }); assert.equal(s.calls.length, 0);
  }
  for (const bad of ['refusal-letter.pdf', 'intake-submission.json', '..', '../../x', KEY.toUpperCase(), KEY.slice(0, 15), 'g'.repeat(24), 'a'.repeat(65), `${KEY}.pdf`, `${KEY} `, '']) {
    const s = fakeService(); const res = fakeRes();
    await routes.file(req({ key: bad }), res, deps(s));
    assert.equal(res.statusCode, 400, bad);
    assert.deepEqual(res.body, { error: 'That file link is not valid — close this box and open Attachments again.' });
    assert.equal(s.calls.length, 0); assert.equal(res.headers['cache-control'], 'private, no-store');
  }
  assert.equal(String(routes.LEAD_RE), String(realSvc.LEAD_ID_RE)); assert.equal(String(routes.KEY_RE), String(realSvc.KEY_RE));
});

test('refusals: an unknown key → 404; storage trouble (answered or thrown) → 503; too big → 413 — plain words, no file name in the log', async () => {
  let res = fakeRes();
  let logs = await quiet(() => routes.file(req(), res, deps(fakeService({ file: { refused: 'not-found' } }))));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'That file is not there any more — close this box and open Attachments again.' });
  assert.deepEqual(logs, []);
  for (const s of [fakeService({ file: { refused: 'unchecked', reason: 'storage' } }), fakeService({ readThrows: true }), fakeService({ file: { refused: 'unchecked', reason: 'case-unreadable' } }), fakeService({ file: { buffer: 'not bytes', mime: 'application/pdf' } })]) {
    res = fakeRes();
    logs = await quiet(() => routes.file(req(), res, deps(s)));
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'Could not reach the files just now — try again.' });
    assert.equal(res.ended, undefined, 'no bytes');
    assert.equal(logs.length, 1); assert.match(logs[0], new RegExp(`^\\[LeadFiles\\] lead ${LEAD}: file ${KEY} could not be read \\([a-z-]+\\)$`));
    assert.ok(!logs[0].includes('passport'));
  }
  res = fakeRes();
  await quiet(() => routes.file(req(), res, deps(fakeService({ file: { refused: 'too-big' } }))));
  assert.equal(res.statusCode, 413); assert.match(res.body.error, /too big to open here/);
});

test('hammering: at most 3 files of one lead are read at once → 429 in plain words; the slots come back, also after a failure', async () => {
  assert.equal(routes.MAX_READS_PER_LEAD, 3);
  let open; const wait = new Promise((r) => { open = r; });
  const s = fakeService({ wait });
  const held = [fakeRes(), fakeRes(), fakeRes()];
  const running = held.map((r) => quiet(() => routes.file(req(), r, deps(s))));
  await new Promise((r) => setImmediate(r));
  const refused = fakeRes();
  await routes.file(req(), refused, deps(s));
  assert.equal(refused.statusCode, 429);
  assert.deepEqual(refused.body, { error: 'Too many files are being opened at once — wait a moment and try again.' });
  assert.equal(s.calls.length, 3, 'the fourth read never started');
  // another lead is not held up by this one
  const other = fakeRes();
  await quiet(() => routes.file(req({ leadId: '9000000002' }), other, deps(fakeService())));
  assert.equal(other.statusCode, 200);
  open(); await Promise.all(running);
  assert.ok(held.every((r) => r.statusCode === 200));
  assert.deepEqual(routes._inFlight(), { leads: 0, all: 0 });
  // a read that fails gives its slot back too
  for (let i = 0; i < 5; i++) { const r = fakeRes(); await quiet(() => routes.file(req(), r, deps(fakeService({ readThrows: true })))); assert.equal(r.statusCode, 503); }
  assert.deepEqual(routes._inFlight(), { leads: 0, all: 0 });
  const after = fakeRes();
  await quiet(() => routes.file(req(), after, deps(fakeService())));
  assert.equal(after.statusCode, 200);
});

test('hammering: no more than 8 reads in all, across leads', async () => {
  assert.equal(routes.MAX_READS_IN_ALL, 8);
  let open; const wait = new Promise((r) => { open = r; });
  const s = fakeService({ wait });
  const running = [];
  for (let i = 0; i < 8; i++) running.push(quiet(() => routes.file(req({ leadId: `80000000${10 + i}` }), fakeRes(), deps(s))));
  await new Promise((r) => setImmediate(r));
  const refused = fakeRes();
  await routes.file(req({ leadId: '8000000099' }), refused, deps(s));
  assert.equal(refused.statusCode, 429);
  open(); await Promise.all(running);
  assert.deepEqual(routes._inFlight(), { leads: 0, all: 0 });
});

test('anything unforeseen ends as a plain 500 — a handler never rejects', async () => {
  const boom = { status() { throw new Error('socket gone: Test Person passport.pdf'); }, set() { return this; }, json() { return this; } };
  const res = fakeRes();
  let n = 0; res.set = (k, v) => { if (k === 'Content-Type' && !n++) throw new Error('bad header'); res.headers[k.toLowerCase()] = v; return res; };
  const logs = await quiet(async () => {
    await routes.file(req(), res, deps(fakeService()));
    await routes.list(req({ leadId: 'x' }), boom, deps(fakeService())).catch(() => assert.fail('rejected'));
  });
  assert.equal(res.statusCode, 500); assert.deepEqual(res.body, { error: 'Could not reach the files just now — try again.' });
  assert.ok(logs.every((l) => !/passport|Test Person/.test(l)));
  assert.deepEqual(routes._inFlight(), { leads: 0, all: 0 });
});

/* ══ with the real service behind the route ═══════════════════════════════════ */

test('end to end with fakes for storage only: list → open by key; the archive of the client\'s answers cannot be opened by any key or name', async () => {
  const keep = { ...realSvc.io };
  const reads = [];
  realSvc.io.getLead = async (id) => ({ id, name: 'Test Person', fullName: 'Test Person', clientMasterItemId: '' });
  realSvc.io.folderState = async (lead) => ({ refs: [{ clientName: lead.fullName, caseRef: `LEAD-${lead.id}` }], caseRefKnown: true });
  realSvc.io.listChildren = async () => [
    { name: 'intake-submission.json', size: 900, lastModifiedDateTime: '2026-11-01T10:00:00Z', isFolder: false },
    { name: 'refusal-letter.pdf', size: PDF.length, lastModifiedDateTime: '2026-11-01T10:00:00Z', isFolder: false },
    { name: STORED, size: PDF.length, lastModifiedDateTime: '2026-11-04T19:32:00Z', isFolder: false },
  ];
  realSvc.io.readFile = async (a) => { reads.push(a.filename); return PDF; };
  try {
    const listRes = fakeRes();
    await routes.list(req(), listRes, { staff: () => null });
    assert.equal(listRes.body.state, 'ok');
    assert.deepEqual(listRes.body.files.map((x) => [x.kind, x.label, x.view]), [['client', 'Refusal letter', 'tab'], ['staff', 'Test Person passport.pdf', 'tab']]);
    const logs = await quiet(async () => {
      for (const x of listRes.body.files) {
        const res = bytesRes();
        await routes.file(req({ key: x.key }), res, { staff: () => null });
        await new Promise((r) => res.on('finish', r));
        assert.equal(res.statusCode, 200); assert.equal(res.headers['content-type'], 'application/pdf');
      }
      const gone = fakeRes();
      await routes.file(req({ key: realSvc.keyOf(LEAD, `LEAD-${LEAD}`, 'intake-submission.json') }), gone, { staff: () => null });
      assert.equal(gone.statusCode, 404);
    });
    assert.deepEqual(reads, ['refusal-letter.pdf', STORED]);
    assert.equal(logs.length, 2);
    for (const l of logs) assert.ok(!/passport|Test Person|refusal|\.pdf|1432/.test(l), l);
  } finally { Object.assign(realSvc.io, keep); }
});

/* ══ wiring ═══════════════════════════════════════════════════════════════════ */

test('server.js: the two GET routes sit under /api, after the team-key gate, with tryStaffAuth handed in only for the log; no write route', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const gate = src.indexOf("app.use('/api', requireApiKey);");
  assert.ok(gate > 0);
  for (const line of [
    "app.get('/api/leads/:leadId/files', (req, res) => require('./routes/leadFilesRoutes').list(req, res, { staff: tryStaffAuth }));",
    "app.get('/api/leads/:leadId/files/:key', (req, res) => require('./routes/leadFilesRoutes').file(req, res, { staff: tryStaffAuth }));",
  ]) {
    const at = src.indexOf(line);
    assert.ok(at > gate, line);
  }
  assert.equal((src.match(/'\/api\/leads\/:leadId\/files/g) || []).length, 2);
  assert.ok(!/app\.(post|put|patch|delete|all|use)\('\/api\/leads\/:leadId\/files/.test(src), 'read-only');
  // the gate reads the key from a header only — a key never rides in the URL of a file
  const gateFn = src.slice(src.indexOf('function requireApiKey'), gate);
  assert.ok(/req\.headers\['x-api-key'\]/.test(gateFn) && !/req\.query/.test(gateFn));
  // the route module asks for no sign-in of its own and never takes a file name from the request
  const mod = fs.readFileSync(require.resolve('../src/routes/leadFilesRoutes.js'), 'utf8');
  assert.ok(!/loginUrl|status\(401\)|status\(403\)/.test(mod));
  assert.ok(!/req\.(query|body)/.test(mod), 'only :leadId and :key are read');
  assert.ok(!/STAFF_SESSION_SECRET|jsonwebtoken|jwt\.sign/.test(mod));
});
