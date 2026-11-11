'use strict';

// Leads "Export" (Faran 2026-11-11): the leads the page is showing, as an Excel file with
// Lead Name, Email, Contact Number, Service, Source/Reference, Referred By, Current Status.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const XLSX   = require('xlsx');

const ex   = require('../src/services/leadExport');
const snap = require('../src/services/leadSnapshot');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function quiet() { const l = console.log, e = console.error; const lines = []; console.log = (...a) => lines.push(a.join(' ')); console.error = (...a) => lines.push(a.join(' ')); return { lines, restore() { console.log = l; console.error = e; } }; }

function lead(id, phone, email) { const l = { id }; Object.defineProperty(l, snap.CONTACT, { value: { phone, email }, enumerable: false }); return l; }
const QUEUE = [
  { id: '11', name: 'Asha  Rao', service: 'Express Entry', source: 'Client Referral', referredBy: 'Bo Li', status: { label: 'Invite sent', at: Date.parse('2026-11-03T15:00:00Z') } },
  { id: '12', name: '=HYPERLINK("http://x")', service: '', source: 'Website', referredBy: '', status: { label: 'Booked', slot: 'Nov 12, 2:00 PM' } },
  { id: '13', name: 'No Contact', service: 'Study Permit', source: '', referredBy: '', status: null },
];
const LEADS = [lead('11', '+1 416-555-0101', 'asha@example.com'), lead('12', '0044 20 7946 0000', ''), lead('13', '', ''), lead('99', '905 555 0000', 'case@example.com')];
function withData(fn) {
  const r = [stub(ex.io, 'queue', async () => QUEUE), stub(ex.io, 'snapshot', async () => LEADS)];
  return Promise.resolve().then(fn).finally(() => r.forEach((x) => x()));
}

test('the seven columns, in the order asked; contact from the server-only copy', async () => {
  await withData(async () => {
    assert.deepEqual(ex.HEADERS, ['Lead Name', 'Email', 'Contact Number', 'Service', 'Source/Reference', 'Referred By', 'Current Status']);
    const rows = await ex.buildRows(['12', '11']);
    assert.deepEqual(rows, [
      ['=HYPERLINK("http://x")', '', '0044 20 7946 0000', '', 'Website', '', 'Booked · Nov 12, 2:00 PM'],
      ['Asha Rao', 'asha@example.com', '+1 416-555-0101', 'Express Entry', 'Client Referral', 'Bo Li', 'Invite sent · Nov 3'],
    ]);
  });
});

test('only rows of the Leads list: unknown ids, non-lead ids, junk and repeats are skipped', async () => {
  await withData(async () => {
    const rows = await ex.buildRows(['99', '11', '11', 'abc', '', null, { id: 11 }, '13', '777']);
    assert.deepEqual(rows.map((r) => r[0]), ['Asha Rao', 'No Contact']);
    assert.deepEqual(rows[1], ['No Contact', '', '', 'Study Permit', '', '', '']);
    assert.deepEqual(await ex.buildRows('11'), []);
    assert.deepEqual(await ex.buildRows(undefined), []);
  });
  assert.equal(ex.cleanIds(Array.from({ length: ex.MAX_ROWS + 50 }, (_, i) => i + 1)).length, ex.MAX_ROWS);
});

test('the Excel file: one sheet, every cell text (a phone keeps its + and zeros, "=" is never a formula)', async () => {
  await withData(async () => {
    const buf = ex.toXlsx(await ex.buildRows(['11', '12']));
    const wb = XLSX.read(buf, { type: 'buffer' });
    assert.deepEqual(wb.SheetNames, ['Leads']);
    const ws = wb.Sheets.Leads;
    assert.deepEqual(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })[0], ex.HEADERS);
    assert.equal(ws.C2.t, 's'); assert.equal(ws.C2.v, '+1 416-555-0101');
    assert.equal(ws.C3.v, '0044 20 7946 0000');
    assert.equal(ws.A3.t, 's'); assert.equal(ws.A3.f, undefined); assert.equal(ws.A3.v, '=HYPERLINK("http://x")');
  });
});

test('a remark names who wrote it, as on the page; an over-long value is cut to fit one Excel cell', () => {
  assert.equal(ex.statusText({ key: 'remark', label: 'Called, no answer', at: Date.parse('2026-11-03T15:00:00Z'), by: 'Melanie' }), 'Called, no answer · Nov 3 · Melanie');
  assert.equal(ex.statusText({ key: 'remark', label: 'Left voicemail', by: 'Soniya' }), 'Left voicemail · Soniya');
  const ws = XLSX.read(ex.toXlsx([['x'.repeat(40000), '', '', '', '', '', '']]), { type: 'buffer' }).Sheets.Leads;
  assert.equal(ws.A2.v.length, 32767);
});

test('file name: the tab made safe, the Toronto day', () => {
  const now = Date.parse('2026-11-12T03:30:00Z');   // still Nov 11 in Toronto
  assert.equal(ex.fileName('Invite sent', now), 'Leads - Invite sent - 2026-11-11.xlsx');
  assert.equal(ex.fileName('1st reminder', now), 'Leads - 1st reminder - 2026-11-11.xlsx');
  assert.equal(ex.fileName('a"; ../x\r\nSet-Cookie: y', now), 'Leads - a x Set Cookie y - 2026-11-11.xlsx');
  assert.equal(ex.fileName('', now), 'Leads - 2026-11-11.xlsx');
});

function fakeRes() {
  const r = { code: 200, headers: {}, body: null, json: null };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (j) => { r.json = j; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

test('the route: a file with no-store; the log line has the count and who — never a name, phone or email', async () => {
  await withData(async () => {
    const q = quiet();
    try {
      const h = ex.httpHandler({ actorOf: () => 'Melanie' });
      const res = fakeRes();
      await h({ body: { ids: ['11', '12', '99'], tab: 'All' }, headers: {} }, res);
      assert.equal(res.code, 200);
      assert.equal(res.headers['Cache-Control'], 'private, no-store');
      assert.match(res.headers['Content-Disposition'], /^attachment; filename="Leads - All - \d{4}-\d\d-\d\d\.xlsx"$/);
      assert.equal(res.headers['X-Export-Rows'], '2');
      assert.ok(Buffer.isBuffer(res.body) && res.body.length > 500);
      assert.deepEqual(q.lines, ['[Leads] export: 2 rows by Melanie']);

      const empty = fakeRes(); await h({ body: { ids: ['99'] }, headers: {} }, empty);
      assert.equal(empty.code, 400);
      const none = fakeRes(); await h({ body: {}, headers: {} }, none);
      assert.equal(none.code, 400);
      const big = fakeRes(); await h({ body: { ids: new Array(ex.MAX_ROWS + 1).fill('x') }, headers: {} }, big);
      assert.equal(big.code, 413);
    } finally { q.restore(); }
  });
});

test('the route: per-IP limit; a failure answers plainly and logs no contact detail', async () => {
  const q = quiet();
  const r = [stub(ex.io, 'queue', async () => { throw new Error('monday down'); }), stub(ex.io, 'snapshot', async () => LEADS)];
  try {
    const h = ex.httpHandler({ limit: (() => { let n = 0; return () => ++n <= 1; })() });
    const a = fakeRes(); await h({ body: { ids: ['11'] }, headers: {} }, a);
    assert.equal(a.code, 503);
    assert.ok(!/@|555/.test(q.lines.join(' ')));
    const b = fakeRes(); await h({ body: { ids: ['11'] }, headers: {} }, b);
    assert.equal(b.code, 429);
  } finally { r.forEach((x) => x()); q.restore(); }
});

test('wiring: the route sits under /api; the page has the button and sends ids only', () => {
  const server = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.match(server, /app\.post\('\/api\/leads\/export', require\('\.\/services\/leadExport'\)\.httpHandler\(/);
  assert.ok(server.indexOf("app.use('/api', requireApiKey)") < server.indexOf("app.post('/api/leads/export'"), 'behind the team key');
  const html = require('../src/routes/adminLeads').buildLeadsQueueHTML();
  assert.match(html, /<button class="btn" id="btn-export" type="button"/);
  assert.match(html, /body:JSON\.stringify\(\{ids:ids,tab:SHOWN_TAB\}\)/);
  // The page's script still parses (it is built inside a Node template literal).
  const scripts = html.match(/<script>[\s\S]*?<\/script>/g) || [];
  assert.ok(scripts.length >= 1);
  for (const sc of scripts) new Function(sc.replace(/^<script>|<\/script>$/g, ''));
});
