'use strict';

// Updates thread (staff request 2026-08-19): the Monday "Updates" section on
// every platform detail page — case cockpit merges the case row + linked lead
// rows chronologically; posting writes a [Name]-prefixed Monday update.

const test   = require('node:test');
const assert = require('node:assert/strict');

const svc        = require('../src/services/updatesService');
const mondayApi  = require('../src/services/mondayApi');
const leadSvc    = require('../src/services/leadService');
const htmlQ      = require('../src/services/htmlQuestionnaireService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const upd = (id, at, body, by = 'Barrana AI') => ({ id, created_at: at, text_body: body, creator: { name: by }, replies: [] });

test('getUpdatesForItem shapes the thread and drops empty bodies', async () => {
  const restore = stub(mondayApi, 'query', async () => ({ items: [{ updates: [
    upd('1', '2026-08-19T10:00:00Z', 'note one'),
    upd('2', '2026-08-19T09:00:00Z', '   '),
    { id: '3', created_at: '2026-08-19T08:00:00Z', text_body: 'with reply', creator: { name: 'Kamal' },
      replies: [{ id: '3r', created_at: '2026-08-19T08:30:00Z', text_body: 'reply', creator: { name: 'Deeksha' } }] },
  ] }] }));
  try {
    const t = await svc.getUpdatesForItem('123');
    assert.equal(t.length, 2, 'blank update dropped');
    assert.equal(t[1].replies[0].by, 'Deeksha');
    assert.equal(t[0].origin, 'lead');
  } finally { restore(); }
});

test('getCaseThread merges case + linked lead rows, newest first, tagged by origin', async () => {
  const restore = [
    stub(htmlQ, 'validateAccessForStaff', async () => ({ itemId: '900', clientName: 'Merge Test' })),
    stub(leadSvc, 'findAllByColumnValue', async () => ([{ id: '800' }])),
    stub(mondayApi, 'query', async (q, v) => {
      const id = String((v.id || [])[0]);
      if (id === '900') return { items: [{ updates: [upd('c1', '2026-08-18T10:00:00Z', 'case note')] }] };
      if (id === '800') return { items: [{ updates: [upd('l1', '2026-08-19T10:00:00Z', 'lead note'), upd('l2', '2026-08-17T10:00:00Z', 'older lead note')] }] };
      return { items: [] };
    }),
  ];
  try {
    const t = await svc.getCaseThread('2026-XX-001');
    assert.deepEqual(t.updates.map((u) => u.id), ['l1', 'c1', 'l2'], 'strict chronological merge, newest first');
    assert.deepEqual(t.updates.map((u) => u.origin), ['lead', 'case', 'lead']);
    assert.equal(t.cmItemId, '900');
  } finally { restore.reverse().forEach((r) => r()); }
});

test('postUpdate: [Name] prefix, HTML-escaped body, newline→<br>; validation rejects junk', async () => {
  const posts = [];
  const restore = stub(mondayApi, 'query', async (q, v) => { posts.push(v.b); return { create_update: { id: '1' } }; });
  try {
    await svc.postUpdate('900', { body: 'Called client <today>\nno answer', staffName: 'Melanie' });
    assert.equal(posts[0], '<b>[Melanie]</b> Called client &lt;today&gt;<br>no answer', 'attributed, escaped, line breaks preserved');
    await assert.rejects(svc.postUpdate('900', { body: '   ' }), (e) => e.badRequest);
    await assert.rejects(svc.postUpdate('900', { body: 'x'.repeat(4001) }), (e) => e.badRequest);
    await assert.rejects(svc.postUpdate('abc', { body: 'hi' }), (e) => e.badRequest);
  } finally { restore(); }
});

test('wiring: endpoints exist and all three pages mount the widget AFTER getKey is defined', () => {
  const fs = require('fs');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(server, /app\.get\('\/api\/updates\/:itemId'/);
  assert.match(server, /app\.get\('\/api\/case-updates\/:caseRef'/);
  assert.match(server, /app\.post\('\/api\/updates\/:itemId'/);
  for (const page of ['adminCase', 'adminLeads', 'adminConsultation']) {
    const src = fs.readFileSync(require.resolve(`../src/routes/${page}`), 'utf8');
    const mountAt = src.indexOf('tdotUpdatesMount({');
    assert.ok(mountAt > 0, `${page}: widget mounted`);
    const authBefore = src.lastIndexOf('${SHARED_AUTH_JS}', mountAt);
    assert.ok(authBefore > 0 && authBefore < mountAt, `${page}: getKey must be defined before the mount runs`);
  }
});
