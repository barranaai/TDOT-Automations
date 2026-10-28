'use strict';

// Read-only look at where Otter saves meeting notes in OneDrive (Faran 2026-10-28):
// names, folders, types, sizes, dates — only GETs, never a file's content or link.

const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../src/services/otterFilesService');

const item = (name, extra = {}) => ({ name, size: 2048, createdDateTime: extra.c || '2026-10-28T12:00:00Z', lastModifiedDateTime: '2026-10-28T12:00:00Z', parentReference: { path: extra.p || '/drive/root:' }, ...(extra.folder ? { folder: { childCount: 2 } } : {}), webUrl: 'https://secret', '@microsoft.graph.downloadUrl': 'https://secret2' });

test('lists the top, the Otter-looking folders (one level in), a search, the newest files — GETs only, no links', async () => {
  const urls = [];
  const keep = O.io.get;
  O.io.get = async (url) => {
    urls.push(url);
    if (/root\/children/.test(url)) return { value: [item('Otter', { folder: true }), item('Recordings', { folder: true }), item('stray.txt', { c: '2026-10-01T00:00:00Z' })] };
    if (/root:\/Otter:\/children/.test(url)) return { value: [item('Asha Rao consultation.docx', { p: '/drive/root:/Otter', c: '2026-10-28T14:00:00Z' }), item('2026', { folder: true, p: '/drive/root:/Otter' })] };
    if (/root:\/Otter\/2026:\/children/.test(url)) return { value: [item('Bo Li.pdf', { p: '/drive/root:/Otter/2026', c: '2026-10-27T10:00:00Z' })] };
    if (/search\(q='otter'\)/.test(url)) return { value: [item('Asha Rao consultation.docx', { p: '/drive/root:/Otter', c: '2026-10-28T14:00:00Z' })] };
    throw new Error(`unexpected ${url}`);
  };
  try {
    const r = await O.look();
    assert.equal(r.ok, true);
    assert.equal(r.drive, O.driveUser());
    assert.deepEqual(r.otterFolders.map((f) => f.folder), ['/Otter'], 'Recordings is not an Otter folder');
    assert.deepEqual(r.newestFiles.map((f) => [f.folder, f.name, f.kind]), [['/Otter', 'Asha Rao consultation.docx', 'docx'], ['/Otter/2026', 'Bo Li.pdf', 'pdf'], ['/', 'stray.txt', 'txt']], 'newest first, no duplicates');
    assert.ok(!JSON.stringify(r).includes('secret'), 'no links of any kind');
    assert.ok(urls.every((u) => !/content|createLink|invite|permissions/.test(u)), 'never opens or shares a file');
  } finally { O.io.get = keep; }
});

test('a drive that cannot be read says so (never throws)', async () => {
  const keep = O.io.get;
  O.io.get = async () => { const e = new Error('Forbidden'); e.response = { status: 403, data: { error: { message: 'Access denied' } } }; throw e; };
  try {
    const r = await O.look();
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /could not be read \(403: Access denied\)/);
  } finally { O.io.get = keep; }
});

test('the admin route is admin-only and read-only', () => {
  const s = require('fs').readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(s, /app\.get\('\/admin\/otter\/files', async \(req, res\) => \{\n  if \(!resolveAdminOrReject\(req, res, 'Only an admin can look at the Otter files\.'\)\) return;/);
});
