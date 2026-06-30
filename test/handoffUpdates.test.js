'use strict';

// Lead → Client Master conversation-history transfer: the pure body-builder that
// turns the lead's Updates thread into attributed, chunked Client Master notes.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildImportedHistoryChunks } = require('../src/services/handoffService');

const upd = (creator, date, body, replies) => ({ creator: creator ? { name: creator } : null, created_at: date, body, replies });

test('empty / missing updates → no chunks', () => {
  assert.deepEqual(buildImportedHistoryChunks([]), []);
  assert.deepEqual(buildImportedHistoryChunks(null), []);
});

test('single update → one note with header, author, date, and body', () => {
  const out = buildImportedHistoryChunks([upd('Shafoli', '2026-06-20T10:00:00Z', 'Called client, very interested.')]);
  assert.equal(out.length, 1);
  assert.match(out[0], /Conversation history imported from the lead record/);
  assert.match(out[0], /\(1 update,/);                 // singular
  assert.match(out[0], /<b>Shafoli<\/b> · 2026-06-20/);
  assert.match(out[0], /Called client, very interested\./);
});

test('order is preserved as passed (caller supplies oldest-first); replies inline', () => {
  const out = buildImportedHistoryChunks([
    upd('Shafoli', '2026-06-20T10:00:00Z', 'First note', [upd('Shermin', '2026-06-20T11:00:00Z', null)].map((r) => ({ creator: { name: 'Shermin' }, created_at: '2026-06-20T11:00:00Z', text_body: 'Agreed, following up.' }))),
    upd('Shermin', '2026-06-21T09:00:00Z', 'Second note'),
  ]);
  assert.equal(out.length, 1);
  const body = out[0];
  assert.ok(body.indexOf('First note') < body.indexOf('Second note'), 'chronological order preserved');
  assert.match(body, /↳ <b>Shermin<\/b> · 2026-06-21.*Agreed, following up\.|↳ <b>Shermin<\/b> · 2026-06-20.*Agreed, following up\./);
  assert.match(body, /\(2 updates,/);                  // plural
});

test('missing creator / date fall back gracefully', () => {
  const out = buildImportedHistoryChunks([upd(null, null, 'Anonymous system note')]);
  assert.match(out[0], /<b>Unknown<\/b><br>/);          // no " · date" when date missing
  assert.ok(!/Unknown<\/b> · /.test(out[0]));
});

test('long threads split into multiple parts, each headed with part N/total', () => {
  const big = (n) => upd('Staff', '2026-06-20T10:00:00Z', 'x'.repeat(4000) + ' note ' + n);
  const out = buildImportedHistoryChunks([big(1), big(2), big(3)], { maxLen: 5000 });
  assert.ok(out.length >= 2, 'splits into multiple notes');
  out.forEach((b, i) => assert.match(b, new RegExp(`part ${i + 1}/${out.length}`)));
  // every original block still present across the parts
  const all = out.join('\n');
  ['note 1', 'note 2', 'note 3'].forEach((m) => assert.match(all, new RegExp(m)));
});
