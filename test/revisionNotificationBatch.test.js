'use strict';

// The 2-minute revision batch: when the same document is queued twice before
// the flush (a Review Note edited twice, or the notes event and the status
// event of one Request Rework), the email carries the newest NON-EMPTY note.
// A5 of the re-upload plan; before it the first text always won.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

// Fakes BEFORE the service loads: it requires the mail and Monday modules at load.
const set = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const sent = [];
set('../src/services/microsoftMailService', { sendEmail: async (m) => { sent.push(m); } });
set('../src/services/mondayApi', {
  query: async () => ({ items_page_by_column_values: { items: [{ name: 'Ada Client', column_values: [
    { id: 'text_mm0xw6bp', text: 'ada@example.com' }, { id: 'text_mm142s49', text: 'R1' }, { id: 'text_mm0x6haq', text: 'tok' },
  ] }] } }),
});

const svc = require('../src/services/revisionNotificationService');

const QUEUE_DIR = path.join(__dirname, '../.queue');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

/**
 * The service arms a real 2-minute timer per case and persists the queue to
 * .queue/ in the repo. Neither belongs in a test: timers are captured (never
 * armed, so the process can exit) and writes under .queue/ are swallowed.
 */
async function withQueueSandbox(fn) {
  const timers = [];
  const real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync };
  global.setTimeout   = (cb) => { const t = { cb, cleared: false }; timers.push(t); return t; };
  global.clearTimeout = (t) => { if (t && typeof t === 'object') t.cleared = true; };
  fs.mkdirSync        = (p, ...a) => (String(p).startsWith(QUEUE_DIR) ? undefined : real.mkdirSync(p, ...a));
  fs.writeFileSync    = (p, ...a) => (String(p).startsWith(QUEUE_DIR) ? undefined : real.writeFileSync(p, ...a));
  try {
    return await fn({
      // fire the one live timer, as the 2-minute batch would
      fire: async () => {
        const live = timers.filter((t) => !t.cleared);
        assert.equal(live.length, 1, 'exactly one armed batch timer');
        live[0].cb();
        await flush();
      },
    });
  } finally {
    global.setTimeout = real.setTimeout; global.clearTimeout = real.clearTimeout;
    fs.mkdirSync = real.mkdirSync; fs.writeFileSync = real.writeFileSync;
  }
}

const rowsIn = (html) => (html.match(/<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">/g) || []).length;

test('queued twice before the flush, second note non-empty → the email carries the second note, once', () =>
  withQueueSandbox(async ({ fire }) => {
    sent.length = 0;
    svc.queueItem('R1', 'Passport', 'first note', 'document');
    svc.queueItem('R1', 'Passport', 'second note', 'document');
    await fire();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'ada@example.com');
    assert.match(sent[0].subject, /1 item needs your attention — Case R1/);
    assert.match(sent[0].html, /second note/);
    assert.ok(!/first note/.test(sent[0].html), 'the older text is gone');
    assert.equal(rowsIn(sent[0].html), 1, 'one row for the document');
  }));

test('queued twice, second note empty → the first note is kept (an empty save never erases what the client must read)', () =>
  withQueueSandbox(async ({ fire }) => {
    sent.length = 0;
    svc.queueItem('R2', 'Passport', 'first note', 'document');
    svc.queueItem('R2', 'Passport', '', 'document');
    await fire();
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /first note/);
    assert.equal(rowsIn(sent[0].html), 1);
  }));

test('different documents in one batch each keep their own note; a questionnaire item is not confused with a document of the same name', () =>
  withQueueSandbox(async ({ fire }) => {
    sent.length = 0;
    svc.queueItem('R3', 'Passport', 'passport note', 'document');
    svc.queueItem('R3', 'Work permit', 'permit note', 'document');
    svc.queueItem('R3', 'Passport', 'question note', 'questionnaire');
    svc.queueItem('R3', 'Passport', 'passport note v2', 'document');
    await fire();
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /3 items need your attention/);
    assert.match(sent[0].html, /passport note v2/);
    assert.match(sent[0].html, /permit note/);
    assert.match(sent[0].html, /question note/);
    assert.ok(!/passport note</.test(sent[0].html), 'the first passport text was replaced');
    assert.equal(rowsIn(sent[0].html), 3);
  }));

test('two same-named rows (one per family member) in one batch are two lines; a second note on the SAME row updates its line; no row id = today\'s by-name rule', () =>
  withQueueSandbox(async ({ fire }) => {
    sent.length = 0;
    svc.queueItem('R4', 'Passport with all stamped pages', 'PA: page 3 missing', 'document', '101');
    svc.queueItem('R4', 'Passport with all stamped pages', 'Spouse: expired', 'document', '102');
    svc.queueItem('R4', 'Passport with all stamped pages', 'PA: pages 3 and 4 missing', 'document', '101');
    svc.queueItem('R4', 'Photo', 'a', 'document');
    svc.queueItem('R4', 'Photo', 'b', 'document');
    await fire();
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /3 items need your attention/);
    assert.match(sent[0].html, /PA: pages 3 and 4 missing/);
    assert.ok(!/PA: page 3 missing</.test(sent[0].html), 'the PA row\'s first text was replaced by its own second note');
    assert.match(sent[0].html, /Spouse: expired/, 'the spouse row keeps its own line');
    assert.match(sent[0].html, />b</);
    assert.equal(rowsIn(sent[0].html), 3);
  }));
