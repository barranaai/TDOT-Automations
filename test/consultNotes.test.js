// Consultation notes (2026-11-10): the box on the consultation record page.
//   - server: POST /api/updates/:id kind "consultNotes" (label, who, limit, escaping, duplicate guard, "(updated)")
//   - page: the card is on the record page, its script parses, and the draft logic runs in a small fake page
//     (fake localStorage, incl. one that throws).
// Offline: Monday is stubbed (the no-network guard backs it).
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');
const fs     = require('node:fs');

const mondayApi = require('../src/services/mondayApi');
const updates   = require('../src/services/updatesService');
const C  = require('../src/routes/adminConsultation');
const CN = require('../src/routes/consultNotesWidget');
const UW = require('../src/routes/updatesWidget');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
function scriptsOf(html) { return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]); }
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// A tiny Monday: create_update stores the body; the read gives text_body the way Monday does (tags stripped, <br> → newline).
function fakeMonday({ readFails = false, hideNew = false, seed = [] } = {}) {
  const store = seed.slice(); const posted = [];
  const textBody = (b) => b.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  let n = 0;
  const query = async (q, v) => {
    if (/create_update/.test(q)) {
      posted.push(v.b); n++;
      if (!hideNew) store.unshift({ id: String(100 + n), text_body: textBody(v.b), created_at: `2026-11-10T10:0${n}:00Z` });
      return { create_update: { id: String(100 + n) } };
    }
    if (readFails) throw new Error('Monday read failed');
    return { items: [{ updates: store.slice() }] };
  };
  return { query, posted, store };
}

/* ── server ── */

test('server: the entry is "[Name] 📝 Consultation notes" + the text, escaped, with line breaks; the result says ok', async () => {
  updates._resetConsultNotesGuard();
  const m = fakeMonday(); const r = stub(mondayApi, 'query', m.query);
  try {
    const out = await updates.postUpdate('123', { body: '  Wants PR <fast> & has a job offer\r\nSpouse: yes  ', staffName: 'Gauri <b>', kind: 'consultNotes' });
    assert.deepEqual(out, { ok: true, updated: false });
    assert.equal(m.posted.length, 1);
    assert.equal(m.posted[0], '<b>[Gauri &lt;b&gt;]</b> 📝 <b>Consultation notes</b><br>Wants PR &lt;fast&gt; &amp; has a job offer<br>Spouse: yes');
    // the header never looks like a Remark or a direct-client Note (other readers key on those)
    assert.ok(!/\[Remark|\[Note/.test(m.posted[0]));
  } finally { r(); }
});

test('server: empty is refused; 20,000 is taken, 20,001 refused with a clear message and nothing posted; a bad id is refused', async () => {
  updates._resetConsultNotesGuard();
  assert.equal(updates.MAX_CONSULT_NOTES, updates.MAX_OTTER, 'the same limit as the Otter summary');
  assert.equal(CN.MAX_CONSULT_NOTES, updates.MAX_CONSULT_NOTES, 'the page and the server share one limit');
  const m = fakeMonday(); const r = stub(mondayApi, 'query', m.query);
  try {
    await assert.rejects(updates.postUpdate('123', { body: '  \n ', staffName: 'G', kind: 'consultNotes' }), (e) => e.badRequest && /Type the consultation notes first/.test(e.message));
    await assert.rejects(updates.postUpdate('123', { body: 'x'.repeat(20001), staffName: 'G', kind: 'consultNotes' }), (e) => e.badRequest && /limited to 20,000 characters — this is 1 over\. Nothing was saved/.test(e.message));
    await assert.rejects(updates.postUpdate('12a', { body: 'x', staffName: 'G', kind: 'consultNotes' }), /Invalid item id/);
    assert.equal(m.posted.length, 0);
    // counted like the page: \r\n is one character, outer blanks do not count
    await updates.postUpdate('123', { body: ' ' + 'ab\r\n'.repeat(6666) + 'xy ', staffName: 'G', kind: 'consultNotes' });   // 6666*3 + 2 = 20,000
    assert.equal(m.posted.length, 1);
    assert.ok(m.posted[0].endsWith('ab<br>xy'), 'posted in full, never cut');
  } finally { r(); }
});

test('server: the same notes again (lost response, retry) make NO second entry — found on the record', async () => {
  updates._resetConsultNotesGuard();
  const m = fakeMonday(); const r = stub(mondayApi, 'query', m.query);
  try {
    await updates.postUpdate('123', { body: 'First notes\nline two', staffName: 'Gauri', kind: 'consultNotes' });
    updates._resetConsultNotesGuard();   // as after a restart: only the record itself can tell
    const again = await updates.postUpdate('123', { body: 'First notes\r\nline   two ', staffName: 'Gauri', kind: 'consultNotes' });
    assert.deepEqual(again, { ok: true, already: true });
    assert.equal(m.posted.length, 1);
    // text with < > & is recognised too
    await updates.postUpdate('555', { body: 'a < b & c > d', staffName: 'G', kind: 'consultNotes' });
    updates._resetConsultNotesGuard();
    assert.equal((await updates.postUpdate('555', { body: 'a < b & c > d', staffName: 'G', kind: 'consultNotes' })).already, true);
  } finally { r(); }
});

test('server: a double click (two saves at once) and a retry before Monday shows the entry both make one entry', async () => {
  updates._resetConsultNotesGuard();
  const m = fakeMonday({ hideNew: true });   // Monday's read never shows the new entry (lag)
  const r = stub(mondayApi, 'query', m.query);
  try {
    const [a, b] = await Promise.all([
      updates.postUpdate('123', { body: 'Same notes', staffName: 'G', kind: 'consultNotes' }),
      updates.postUpdate('123', { body: 'Same notes', staffName: 'G', kind: 'consultNotes' }),
    ]);
    assert.equal(m.posted.length, 1);
    assert.deepEqual([a.already, b.already].sort(), [true, undefined].sort());
    assert.equal((await updates.postUpdate('123', { body: 'Same notes', staffName: 'G', kind: 'consultNotes' })).already, true, 'a moment later');
    assert.equal(m.posted.length, 1);
    // the same words on ANOTHER record are that record's own notes
    await updates.postUpdate('124', { body: 'Same notes', staffName: 'G', kind: 'consultNotes' });
    assert.equal(m.posted.length, 2);
    // and with the read lagging, a different text right after is still headed "(updated)"
    const c = await updates.postUpdate('123', { body: 'Same notes, corrected', staffName: 'G', kind: 'consultNotes' });
    assert.equal(c.updated, true);
    assert.match(m.posted[2], /📝 <b>Consultation notes \(updated\)<\/b><br>Same notes, corrected$/);
  } finally { r(); }
});

test('server: a correction is a NEW entry headed "Consultation notes (updated)" — also when it starts with the same 300 characters', async () => {
  updates._resetConsultNotesGuard();
  const m = fakeMonday(); const r = stub(mondayApi, 'query', m.query);
  try {
    const head = 'y'.repeat(400);
    await updates.postUpdate('123', { body: head + ' first', staffName: 'Gauri', kind: 'consultNotes' });
    updates._resetConsultNotesGuard();
    const out = await updates.postUpdate('123', { body: head + ' corrected', staffName: 'Shafoli', kind: 'consultNotes' });
    assert.deepEqual(out, { ok: true, updated: true });
    assert.equal(m.posted.length, 2);
    assert.ok(m.posted[1].startsWith('<b>[Shafoli]</b> 📝 <b>Consultation notes (updated)</b><br>'));
    // "(updated)" is decided on the server from the record — an Otter summary or a normal update does not count as notes
    updates._resetConsultNotesGuard();
    const m2 = fakeMonday({ seed: [{ id: '1', text_body: '[Gauri] 🎙 Consultation summary (Otter)\nlong summary', created_at: '2026-11-01T00:00:00Z' }, { id: '2', text_body: '[Gauri] we spoke about the Consultation notes', created_at: '2026-11-01T00:00:00Z' }] });
    r(); const r2 = stub(mondayApi, 'query', m2.query);
    try { assert.equal((await updates.postUpdate('9', { body: 'n', staffName: 'G', kind: 'consultNotes' })).updated, false); } finally { r2(); }
  } finally { mondayApi.query === m.query && r(); }
});

test('server: when the earlier entries cannot be read the notes are still saved (a missing entry is worse than a repeat)', async () => {
  updates._resetConsultNotesGuard();
  const m = fakeMonday({ readFails: true }); const r = stub(mondayApi, 'query', m.query);
  const w = stub(console, 'warn', () => {});
  try {
    assert.deepEqual(await updates.postUpdate('123', { body: 'notes', staffName: 'G', kind: 'consultNotes' }), { ok: true, updated: false });
    assert.equal(m.posted.length, 1);
  } finally { r(); w(); }
});

test('server: a failed save is not remembered — the retry posts', async () => {
  updates._resetConsultNotesGuard();
  let fail = true; const posted = [];
  const r = stub(mondayApi, 'query', async (q, v) => { if (/create_update/.test(q)) { if (fail) throw new Error('Monday down'); posted.push(v.b); return {}; } return { items: [{ updates: [] }] }; });
  try {
    await assert.rejects(updates.postUpdate('123', { body: 'notes', staffName: 'G', kind: 'consultNotes' }), /Monday down/);
    fail = false;
    assert.deepEqual(await updates.postUpdate('123', { body: 'notes', staffName: 'G', kind: 'consultNotes' }), { ok: true, updated: false });
    assert.equal(posted.length, 1);
  } finally { r(); }
});

test('server: the saved notes of a record — only notes entries, newest first, with who, "updated" and the text without the heading', async () => {
  const seed = [
    { id: '1', text_body: '[Gauri] 📝 Consultation notes\nfirst\nsecond line', created_at: '2026-11-08T10:00:00Z' },
    { id: '2', text_body: '[Shafoli] 📝 Consultation notes (updated)\ncorrected', created_at: '2026-11-09T10:00:00Z' },
    { id: '3', text_body: '[Gauri] 🎙 Consultation summary (Otter)\nsummary', created_at: '2026-11-09T11:00:00Z' },
    { id: '4', text_body: '📝 [Remark · Gauri] Called the client', created_at: '2026-11-09T12:00:00Z' },
    { id: '5', text_body: '📝 Consultation notes\nno name given', created_at: '2026-11-07T10:00:00Z' },
  ];
  let asked;
  const r = stub(mondayApi, 'query', async (q, v) => { asked = v; return { items: [{ updates: seed }] }; });
  try {
    const notes = await updates.getConsultNotes('123');
    assert.equal(asked.n, 100, 'reads further back than the 50 the thread shows');
    assert.deepEqual(notes, [
      { id: '2', by: 'Shafoli', updated: true, body: 'corrected', at: '2026-11-09T10:00:00Z' },
      { id: '1', by: 'Gauri', updated: false, body: 'first\nsecond line', at: '2026-11-08T10:00:00Z' },
      { id: '5', by: '', updated: false, body: 'no name given', at: '2026-11-07T10:00:00Z' },
    ]);
  } finally { r(); }
});

test('server: square brackets or a line break in the typed name cannot hide the entry from the reader', async () => {
  updates._resetConsultNotesGuard();
  const m = fakeMonday(); const r = stub(mondayApi, 'query', m.query);
  try {
    await updates.postUpdate('123', { body: 'Notes one', staffName: ' Shafoli [RCIC]\n', kind: 'consultNotes' });
    assert.match(m.posted[0], /^<b>\[Shafoli \(RCIC\)\]<\/b> 📝 <b>Consultation notes<\/b><br>Notes one$/);
    const notes = await updates.getConsultNotes('123');
    assert.deepEqual(notes.map((n) => [n.by, n.body]), [['Shafoli (RCIC)', 'Notes one']]);
    updates._resetConsultNotesGuard();   // after a restart the record itself still shows it is there
    assert.equal((await updates.postUpdate('123', { body: 'Notes one', staffName: 'A]', kind: 'consultNotes' })).already, true);
    assert.equal(m.posted.length, 1);
  } finally { r(); }
});

test('server: the repeat is found however Monday hands the text back — breaks as spaces, breaks dropped, entities left in, HTML body only', async () => {
  const text = 'Line one & two\n\nAsked about <PNP>, said "maybe"\nSee https://example.com/a?b=1&c=2';
  const html = (b) => b;   // what was posted
  const shapes = {
    'newlines kept':        (b) => ({ text_body: b.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }),
    'breaks as one space':  (b) => ({ text_body: b.replace(/<br>/g, ' ').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }),
    'breaks dropped':       (b) => ({ text_body: b.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }),
    'entities left in':     (b) => ({ text_body: b.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '') }),
    'text_body empty':      (b) => ({ text_body: '', body: html(b) }),
    'body rewritten':       (b) => ({ text_body: '', body: '<p>' + b.replace(/<b>/g, '<strong>').replace(/<\/b>/g, '</strong>').replace(/<br>/g, '<br/>').replace(/"/g, '&quot;').replace(/(https:[^<\s]+)/, '<a href="$1">$1</a>') + '</p>' }),
  };
  for (const [label, shapeOf] of Object.entries(shapes)) {
    updates._resetConsultNotesGuard();
    const store = []; const posted = [];
    const r = stub(mondayApi, 'query', async (q, v) => {
      if (/create_update/.test(q)) { posted.push(v.b); store.unshift({ id: String(posted.length), created_at: '2026-11-10T10:00:00Z', ...shapeOf(v.b) }); return { create_update: { id: '1' } }; }
      assert.match(q, /text_body body created_at/, 'the read asks for both forms');
      return { items: [{ updates: store.slice() }] };
    });
    try {
      await updates.postUpdate('9', { body: text, staffName: 'Gauri', kind: 'consultNotes' });
      updates._resetConsultNotesGuard();   // restart / after lunch: only the record can tell
      const again = await updates.postUpdate('9', { body: text, staffName: 'Gauri', kind: 'consultNotes' });
      assert.deepEqual(again, { ok: true, already: true }, label);
      assert.equal(posted.length, 1, label);
      const notes = await updates.getConsultNotes('9');
      assert.equal(notes.length, 1, label + ': listed under Saved notes'); assert.equal(notes[0].by, 'Gauri', label);
      assert.ok(!('_keys' in notes[0]));
      // a real correction is still a new entry, headed (updated)
      assert.deepEqual(await updates.postUpdate('9', { body: text + ' — corrected', staffName: 'Gauri', kind: 'consultNotes' }), { ok: true, updated: true }, label);
      assert.match(posted[1], /Consultation notes \(updated\)/, label);
    } finally { r(); }
  }
});

test('server: the save is sent with Monday’s automatic re-send OFF; an unanswered save is looked for on the record before anything is sent again', async () => {
  const timeout = () => Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED', isAxiosError: true });
  const run = async ({ lands, readFailsAfter = false, error = timeout }) => {
    updates._resetConsultNotesGuard({ retryMs: 0 });
    const store = []; let sends = 0, reads = 0; const retriesArg = [];
    const r = stub(mondayApi, 'query', async (q, v, retries) => {
      if (/create_update/.test(q)) {
        sends++; retriesArg.push(retries);
        if (sends === 1) { if (lands) store.unshift({ id: '1', created_at: '2026-11-10T10:00:00Z', text_body: v.b.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '') }); throw error(); }
        store.unshift({ id: String(sends), created_at: '2026-11-10T10:01:00Z', text_body: v.b.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '') });
        return { create_update: { id: String(sends) } };
      }
      reads++; if (readFailsAfter && reads > 1) throw new Error('read failed');
      return { items: [{ updates: store.slice() }] };
    });
    let out, err;
    try { out = await updates.postUpdate('7', { body: 'Long notes', staffName: 'Gauri', kind: 'consultNotes' }); } catch (e) { err = e; } finally { r(); }
    return { out, err, sends, store, retriesArg };
  };
  // Monday stored it but the answer never came: found on the record, NOT sent again
  const a = await run({ lands: true });
  assert.deepEqual(a.out, { ok: true, updated: false }); assert.equal(a.sends, 1); assert.equal(a.store.length, 1);
  assert.deepEqual(a.retriesArg, [0], 'mondayApi must not re-send the mutation by itself');
  // it never arrived: sent once more
  const b = await run({ lands: false });
  assert.deepEqual(b.out, { ok: true, updated: false }); assert.equal(b.sends, 2); assert.equal(b.store.length, 1);
  // unanswered and the record cannot be read: no blind second copy — the save fails and the page keeps the draft
  const c = await run({ lands: true, readFailsAfter: true });
  assert.ok(c.err); assert.equal(c.sends, 1);
  // a 5xx is "unanswered" too; a rate limit is a plain no (nothing stored) and is simply sent again
  const d = await run({ lands: true, error: () => Object.assign(new Error('502'), { response: { status: 502 }, isAxiosError: true }) });
  assert.equal(d.sends, 1); assert.equal(d.store.length, 1);
  const e = await run({ lands: false, error: () => Object.assign(new Error('429'), { response: { status: 429 }, isAxiosError: true }) });
  assert.equal(e.sends, 2); assert.equal(e.store.length, 1);
  // Monday's own refusal (a GraphQL error) is not retried
  const f = await run({ lands: false, error: () => new Error('Item not found') });
  assert.ok(f.err); assert.equal(f.sends, 1);
  updates._resetConsultNotesGuard({ retryMs: 1500 });
});

test('automations never read a marker phrase out of typed notes or an Otter summary', async () => {
  const notesHtml = '<b>[Gauri]</b> 📝 <b>Consultation notes</b><br>Consultation held by phone. Booking invite emailed again for the spouse. Booking reminder 1 of 2 emailed.';
  const notesText = '[Gauri] 📝 Consultation notes\nConsultation held by phone. Booking invite emailed again for the spouse. Booking reminder 1 of 2 emailed.';
  const otterHtml = '<b>[Gauri]</b> 🎙 <b>Consultation summary (Otter)</b><br>Consultation held on Zoom. Booking invite emailed.';
  for (const x of [notesHtml, notesText, otterHtml, '📝 Consultation notes (updated) Consultation held', '[A] 📝 Consultation notesConsultation held']) assert.equal(updates.isStaffTypedEntry(x), true, x);
  for (const x of ['✅ Consultation held — Zoom meeting ended', 'Booking invite emailed to the client', '[Gauri] a normal update about consultation notes', '', null]) assert.equal(updates.isStaffTypedEntry(x), false, String(x));

  // the "set the outcome" reminder: typed notes do not count as "the meeting system recorded it"
  const pc = require('../src/services/postConsultService');
  const now = Date.parse('2026-11-10T20:00:00Z');
  const lead = (ups) => ({ bookedSlot: '2026-11-10 10:00', outcome: '', updates: ups, directConsult: '', consultOption: '' });
  assert.equal(pc.needsNudge(lead([]), now), true, 'the base case does get the reminder');
  assert.equal(pc.needsNudge(lead([notesHtml, otterHtml]), now), true);
  assert.equal(pc.needsNudge(lead(['✅ Consultation held — recorded']), now), false, 'the system note still stops it');

  // the Leads list's Current status
  const ls = require('../src/services/leadStatusService');
  assert.equal(ls.classify(notesText).kind, ''); assert.equal(ls.classify('[G] 🎙 Consultation summary (Otter)\nBooking invite emailed').kind, '');
  assert.equal(ls.classify('Booking invite emailed to the client').kind, 'invite');

  // the booking-reminder clock
  const br = require('../src/services/bookingRemindersService');
  const r = stub(mondayApi, 'query', async () => ({ items: [{ id: '5', state: 'active', updates: [
    { id: '1', created_at: '2026-11-10T10:00:00Z', text_body: notesText, body: notesHtml },
    { id: '2', created_at: '2026-11-09T10:00:00Z', text_body: '', body: otterHtml },
    { id: '3', created_at: '2026-11-08T10:00:00Z', text_body: 'Booking invite emailed to the client', body: '' },
  ] }] }));
  try { assert.deepEqual((await br.io.readNotes('5')).map((n) => n.id), ['3']); } finally { r(); }
});

test('server route: GET ?kind=consultNotes answers the notes; the plain GET and the POST are as before', () => {
  const src = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  assert.ok(src.includes("if (req.query.kind === 'consultNotes') return res.json({ notes: await require('./services/updatesService').getConsultNotes(req.params.itemId) });"));
  assert.ok(src.includes("res.json(await require('./services/updatesService').postUpdate(req.params.itemId, req.body || {}));"));
});

test('server: the Otter summary and a normal update are untouched by the notes kind', async () => {
  const bodies = [];
  const r = stub(mondayApi, 'query', async (q, v) => { bodies.push([q, v.b]); return {}; });
  try {
    await updates.postUpdate('123', { body: 'sum', staffName: 'Gauri', kind: 'otter' });
    await updates.postUpdate('123', { body: 'hello', staffName: 'Gauri' });
    assert.equal(bodies.length, 2, 'no extra read');
    assert.equal(bodies[0][1], '<b>[Gauri]</b> 🎙 <b>Consultation summary (Otter)</b><br>sum');
    assert.equal(bodies[1][1], '<b>[Gauri]</b> hello');
  } finally { r(); }
});

/* ── page output ── */

test('record page: the Consultation notes card is above the two columns, static, not an .actions card; the Otter tick is unchanged', () => {
  for (const d of [C.buildDetailHTML('555'), C.buildDetailHTML('555', { from: 'retainers' })]) {
    const card = d.indexOf('<div class="card cnw-card"');
    assert.ok(card > d.indexOf('id="c-stepper"') && card < d.indexOf('<div class="cols">'), 'first on a phone too');
    for (const s of ['📝 Consultation notes', 'id="cnw-text"', 'id="cnw-draft"', 'id="cnw-count"', 'id="cnw-name"', '>Save notes</button>', 'id="cnw-list"', 'Saved notes',
      "tdotConsultNotesMount({ prefix: 'cnw', itemId: LEAD_ID, updatesPrefix: 'updw' });", 'textarea:focus-visible', '.cnw-text, .cnw-name { font-size:16px; }']) assert.ok(d.includes(s), s);
    assert.ok(!/<textarea id="cnw-text"[^>]*maxlength/.test(d), 'no maxlength: a long paste is never cut — it is refused with a message');
    assert.ok(!/class="card actions[^"]*"[^>]*>\s*<div class="card-t">📝 Consultation notes/.test(d));
    // the Otter option is exactly as it was
    assert.ok(d.includes(UW.updatesWidgetHtml('updw', { otter: true })));
    assert.ok(d.includes('JSON.stringify(otter ? { body: text, staffName: name, kind: "otter" } : { body: text, staffName: name })'));
    for (const src of scriptsOf(d)) new vm.Script(src);
  }
});

test('page script rules: no backticks, no backslashes, saved entries by textContent only', () => {
  assert.ok(!CN.CONSULT_NOTES_JS.includes('`')); assert.ok(!CN.CONSULT_NOTES_JS.includes('\\'));
  new vm.Script(CN.CONSULT_NOTES_JS);
  const uses = CN.CONSULT_NOTES_JS.match(/innerHTML[^;]*;/g) || [];
  assert.ok(uses.length && uses.every((u) => u === 'innerHTML = "";'), 'innerHTML is only ever emptied');
});

// Sign Out, run in a small fake page over a given storage.
function signOutIn(store, { confirm, unsaved } = {}) {
  const { SHARED_AUTH_JS } = require('../src/routes/adminShared');
  const session = { tdot_admin_key: 'k' }; const asked = []; const went = [];
  const localStorage = sharedStorage(store);
  const window = { location: { replace: (u) => went.push(u) } };
  if (confirm !== undefined) window.confirm = (m) => { asked.push(m); return confirm; };
  if (unsaved !== undefined) window.tdotNotesUnsaved = () => unsaved;
  const ctx = { sessionStorage: { get length() { return Object.keys(session).length; }, key: (i) => Object.keys(session)[i], removeItem: (k) => { delete session[k]; }, getItem: (k) => session[k] || null },
    localStorage, window, fetch: () => Promise.resolve(), setTimeout() {}, document: { readyState: 'complete', getElementById: () => null } };
  vm.createContext(ctx);
  vm.runInContext(SHARED_AUTH_JS + '; signOut();', ctx);
  return { session, asked, went, window };
}
const aDraft = (who, t = 'typed notes') => JSON.stringify({ who, d: { t1: { t, at: Date.now(), by: 'Gauri' } } });

test('Sign Out with no unsaved notes asks nothing; it removes nothing but its own things', () => {
  const store = { tdot_staff_name: 'Gauri', tdot_admin_key_keep: 'k' };
  const r = signOutIn(store, { confirm: false });
  assert.equal(r.asked.length, 0);
  assert.equal(r.window.TDOT_SIGNED_OUT, true); assert.equal('tdot_admin_key' in r.session, false);
  assert.deepEqual(Object.keys(store).sort(), ['tdot_signout_at', 'tdot_staff_name']);
  assert.equal(CN.DRAFT_PREFIX, 'tdot_cnotes_'); assert.equal(CN.SIGNOUT_KEY, 'tdot_signout_at');
});

test('Sign Out with unsaved notes on the device ASKS first and names the clients; Cancel changes nothing at all', () => {
  const store = { tdot_cnotes_1: aDraft('Test Client One'), tdot_cnotes_22: aDraft('Test Client Two'), tdot_staff_name: 'Gauri', tdot_admin_key_keep: 'k' };
  const before = JSON.stringify(store);
  const r = signOutIn(store, { confirm: false });
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0], /^Consultation notes for Test Client One, Test Client Two were typed on this device but not saved\. Sign Out removes them for good/);
  assert.match(r.asked[0], /Press Cancel to stay signed in and save them first/);
  assert.equal(JSON.stringify(store), before, 'drafts, the remembered key and the name are untouched');
  assert.equal(r.session.tdot_admin_key, 'k', 'still signed in, so Save notes works');
  assert.equal(r.window.TDOT_SIGNED_OUT, undefined, 'drafts are still kept as you type');
  assert.equal(r.went.length, 0);
});

test('Sign Out → OK removes every notes draft (shared computers), stamps the sign-out for other tabs, and leaves the rest', () => {
  const store = { tdot_cnotes_1: aDraft(''), tdot_cnotes_22: aDraft(''), tdot_cnotes_3: '{oops', tdot_staff_name: 'Gauri', tdot_admin_key_keep: 'k' };
  const r = signOutIn(store, { confirm: true });
  assert.match(r.asked[0], /^Consultation notes for 3 clients were typed/, 'no names known: a count');
  assert.deepEqual(Object.keys(store).sort(), ['tdot_signout_at', 'tdot_staff_name']);
  assert.equal(r.window.TDOT_SIGNED_OUT, true); assert.equal('tdot_admin_key' in r.session, false);
  // more than three clients: three names and "and N more"
  const many = {}; for (let i = 1; i <= 5; i++) many['tdot_cnotes_' + i] = aDraft('Test Client ' + i);
  assert.match(signOutIn(many, { confirm: true }).asked[0], /for Test Client 1, Test Client 2, Test Client 3 and 2 more were typed/);
});

test('Sign Out also asks when a notes box on the page holds text the device could not keep; without a confirm box it still signs out', () => {
  const r = signOutIn({}, { confirm: false, unsaved: true });
  assert.equal(r.asked.length, 1); assert.match(r.asked[0], /^Consultation notes were typed on this device but not saved/);
  assert.equal(r.session.tdot_admin_key, 'k');
  const store = { tdot_cnotes_1: aDraft('X Y') };
  const plain = signOutIn(store);   // no window.confirm at all
  assert.equal(plain.window.TDOT_SIGNED_OUT, true); assert.equal('tdot_cnotes_1' in store, false);
});

/* ── the box itself, run against a small fake page ── */

function fakeEl(id) {
  const l = {};
  return { id, value: '', textContent: '', innerHTML: '', className: '', style: {}, disabled: false, children: [],
    appendChild(c) { this.children.push(c); }, addEventListener(t, f) { (l[t] = l[t] || []).push(f); },
    fire(t, ev) { (l[t] || []).forEach((f) => f(ev || { target: this })); }, focus() { this.focused = true; } };
}

// The record's draft(s) as kept on the device: { who, d: { tab: { t, at, by } } } → the text(s).
function draftsOf(mem, id = '777') { const raw = mem['tdot_cnotes_' + id]; return raw ? Object.values(JSON.parse(raw).d).map((x) => x.t) : []; }
function draftText(mem, id) { const d = draftsOf(mem, id); assert.equal(d.length, 1, 'one draft'); return d[0]; }
// One browser's storage, shared by several open pages ("tabs").
function sharedStorage(mem = {}) {
  return { mem, getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; },
    get length() { return Object.keys(mem).length; }, key: (i) => Object.keys(mem)[i] || null };
}

function page({ storage, respond, itemId = '777', signedOut = false, preset = '' } = {}) {
  const els = {}; const el = (id) => (els[id] = els[id] || fakeEl(id));
  const posts = []; const gets = []; const winL = {}; let reloads = 0;
  const mem = (storage && storage.mem) || {};
  const ls = storage || { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const window = { addEventListener(t, f) { (winL[t] = winL[t] || []).push(f); }, tdotUpdatesReload_updw() { reloads++; }, TDOT_SIGNED_OUT: signedOut };
  const ids = ['cnw-text', 'cnw-save', 'cnw-msg', 'cnw-draft', 'cnw-count', 'cnw-name', 'cnw-list', 'updw-name'];
  const ctx = {
    document: { getElementById: (id) => (ids.includes(id) ? el(id) : null), createElement: () => fakeEl('x') },
    localStorage: ls, window, peekKey: () => 'k', Date, JSON, Number, String, isNaN,
    fetch: (url, o) => {
      if (o && o.method === 'POST') { posts.push({ url, body: JSON.parse(o.body) }); return (respond || (() => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) })))(posts.length); }
      gets.push(url); return Promise.resolve({ json: () => Promise.resolve({ notes: [{ id: '1', by: 'Gauri', updated: true, body: '<b>x</b>', at: '2026-11-09T10:00:00Z' }] }) });
    },
  };
  if (preset) el('cnw-text').value = preset;
  vm.createContext(ctx);
  const mount = () => vm.runInContext(CN.CONSULT_NOTES_JS + '\ntdotConsultNotesMount({ prefix: "cnw", itemId: "' + itemId + '", updatesPrefix: "updw" });', ctx);
  const type = (v) => { el('cnw-text').value = v; el('cnw-text').fire('input'); };
  const leave = () => { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; (winL.beforeunload || []).forEach((f) => f(ev)); return ev.prevented; };
  const win = (t, ev) => (winL[t] || []).forEach((f) => f(ev));
  return { el, posts, gets, mem, mount, type, leave, win, window, reloads: () => reloads, ctx };
}

test('box: the draft is kept as you type, per record, shown with a time; it comes back after a reload; an emptied box removes it', async () => {
  const p = page(); p.mount();
  assert.equal(p.el('cnw-draft').textContent, '');
  p.type('Client wants a work permit');
  assert.equal(draftText(p.mem), 'Client wants a work permit');
  assert.match(p.el('cnw-draft').textContent, /^Draft kept on this device · \S/);
  assert.equal(p.posts.length, 0, 'nothing is sent until Save notes');
  // "reload": a fresh page over the same storage
  p.el('cnw-name').value = 'Gauri'; p.type('Client wants a work permit');
  const again = page({ storage: p.ctx.localStorage }); again.mount();
  assert.equal(again.el('cnw-text').value, 'Client wants a work permit');
  assert.match(again.el('cnw-draft').textContent, /^Draft kept on this device · .* · typed by Gauri — not saved yet$/, 'the line says who typed it');
  // another record never shows it
  const other = page({ storage: p.ctx.localStorage, itemId: '778' }); other.mount();
  assert.equal(other.el('cnw-text').value, '');
  // text already in the box is never overwritten by the draft
  const busy = page({ storage: p.ctx.localStorage, preset: 'already here' }); busy.mount();
  assert.equal(busy.el('cnw-text').value, 'already here');
  p.type('   ');
  assert.equal('tdot_cnotes_777' in p.mem, false);
  assert.equal(p.el('cnw-draft').textContent, '');
  await tick();
  assert.deepEqual(p.gets, ['/api/updates/777?kind=consultNotes'], 'the saved notes are loaded for this record');
});

test('box: Save notes posts once as kind "consultNotes", is disabled while saving, then clears the box and the draft and refreshes both lists', async () => {
  let release;
  const p = page({ respond: () => new Promise((res) => { release = () => res({ status: 200, json: () => Promise.resolve({ ok: true }) }); }) });
  p.mount(); await tick();
  p.el('cnw-name').value = 'Gauri';
  p.type('  Notes line 1\r\nline 2  ');
  p.el('cnw-save').onclick(); p.el('cnw-save').onclick(); p.el('cnw-save').onclick();
  assert.equal(p.posts.length, 1, 'a double click is one save');
  assert.equal(p.el('cnw-save').disabled, true);
  assert.equal(p.el('cnw-msg').textContent, 'Saving…');
  assert.deepEqual(p.posts[0], { url: '/api/updates/777', body: { body: 'Notes line 1\nline 2', staffName: 'Gauri', kind: 'consultNotes' } });
  assert.ok('tdot_cnotes_777' in p.mem, 'the draft stays until the server says yes');
  assert.equal(p.mem.tdot_staff_name, 'Gauri'); assert.equal(p.el('updw-name').value, 'Gauri', 'the Updates name box gets the same name');
  release(); await tick();
  assert.equal(p.el('cnw-text').value, ''); assert.equal('tdot_cnotes_777' in p.mem, false);
  assert.equal(p.el('cnw-msg').textContent, 'Consultation notes saved.');
  assert.equal(p.el('cnw-save').disabled, false);
  assert.equal(p.gets.length, 2); assert.equal(p.reloads(), 1);
  assert.equal(p.leave(), false, 'nothing unsaved: leaving does not ask');
});

test('box: empty text, a missing name and over 20,000 characters are refused on the page with a clear message — nothing is cut', async () => {
  const p = page(); p.mount();
  p.el('cnw-save').onclick();
  assert.equal(p.el('cnw-msg').textContent, 'Type the consultation notes first.');
  p.type('some notes'); p.el('cnw-save').onclick();
  assert.match(p.el('cnw-msg').textContent, /Add your name/); assert.ok(p.el('cnw-name').focused);
  p.el('cnw-name').value = 'Gauri';
  // the counter: silent far from the limit, shown near it, red over it
  assert.equal(p.el('cnw-count').textContent, '');
  p.type('x'.repeat(18000)); assert.equal(p.el('cnw-count').textContent, '18,000 / 20,000 characters');
  p.type('x'.repeat(20000)); assert.equal(p.el('cnw-count').className, 'cnw-count');
  p.type('x'.repeat(20003));
  assert.equal(p.el('cnw-count').textContent, '20,003 / 20,000 — 3 over the limit'); assert.equal(p.el('cnw-count').className, 'cnw-count over');
  p.el('cnw-save').onclick();
  assert.match(p.el('cnw-msg').textContent, /limited to 20,000 characters — this is 3 over\. Nothing was saved/);
  assert.equal(p.posts.length, 0);
  assert.equal(p.el('cnw-text').value.length, 20003, 'the text is left whole');
  assert.equal(draftText(p.mem).length, 20003, 'and whole in the draft');
  p.type(' ' + 'x'.repeat(20000) + '\n'); p.el('cnw-save').onclick(); await tick();
  assert.equal(p.posts.length, 1, 'exactly 20,000 after trimming is taken');
});

test('box: a server refusal or a lost connection keeps the text and the draft; the retry that the server already has counts as saved', async () => {
  const answers = [
    () => Promise.resolve({ status: 400, json: () => Promise.resolve({ error: 'Consultation notes are limited to 20,000 characters.' }) }),
    () => Promise.reject(new Error('offline')),
    () => Promise.resolve({ status: 500, json: () => Promise.reject(new Error('not json')) }),
    () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, already: true }) }),
  ];
  const p = page({ respond: (n) => answers[n - 1]() }); p.mount();
  p.el('cnw-name').value = 'Gauri'; p.type('my notes');
  p.el('cnw-save').onclick(); await tick();
  assert.match(p.el('cnw-msg').textContent, /limited to 20,000 characters\. Your draft is kept on this device\.$/);
  assert.equal(p.el('cnw-text').value, 'my notes'); assert.ok('tdot_cnotes_777' in p.mem); assert.equal(p.el('cnw-save').disabled, false);
  p.el('cnw-save').onclick(); await tick();
  assert.match(p.el('cnw-msg').textContent, /Could not reach the server, so the notes may not be saved\. Your draft is kept on this device\. Press Save notes again \(it will not make a second copy\)/);
  assert.equal(p.el('cnw-text').value, 'my notes'); assert.ok('tdot_cnotes_777' in p.mem); assert.equal(p.el('cnw-save').disabled, false);
  p.el('cnw-save').onclick(); await tick();
  assert.match(p.el('cnw-msg').textContent, /Could not save \(error 500\)\. Your draft is kept/);
  assert.equal(p.el('cnw-text').value, 'my notes');
  p.el('cnw-save').onclick(); await tick();
  assert.match(p.el('cnw-msg').textContent, /already saved — no second copy/);
  assert.equal(p.el('cnw-text').value, ''); assert.equal('tdot_cnotes_777' in p.mem, false);
});

test('box: typing that arrives while a save is running is kept — the box and the draft are not cleared', async () => {
  let release;
  const p = page({ respond: () => new Promise((res) => { release = () => res({ status: 200, json: () => Promise.resolve({ ok: true, updated: true }) }); }) });
  p.mount(); p.el('cnw-name').value = 'Gauri'; p.type('first part');
  p.el('cnw-save').onclick();
  p.type('first part and more');
  release(); await tick();
  assert.equal(p.el('cnw-text').value, 'first part and more');
  assert.equal(draftText(p.mem), 'first part and more');
  assert.match(p.el('cnw-msg').textContent, /^Saved as Consultation notes \(updated\)\. What you typed after pressing Save is still in the box as a draft\.$/);
});

test('box: leaving the page with text in the box asks first and keeps the draft; an empty box does not ask', () => {
  const p = page(); p.mount();
  assert.equal(p.leave(), false);
  p.type('unsaved');
  assert.equal(p.leave(), true);
  assert.equal(draftText(p.mem), 'unsaved');
  // a write that failed while typing is tried again on the way out
  let fail = true; const mem = {};
  const q = page({ storage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { if (fail) throw new Error('full'); mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } } });
  q.mount(); q.type('typed while the device was full');
  assert.match(q.el('cnw-draft').textContent, /could not keep a draft/);
  fail = false;
  assert.equal(q.leave(), true);
  assert.equal(draftText(mem), 'typed while the device was full');
});

test('box: works when the device storage throws on every call — typing, the warning line, saving', async () => {
  const boom = () => { throw new Error('storage blocked'); };
  const p = page({ storage: { getItem: boom, setItem: boom, removeItem: boom } });
  assert.doesNotThrow(() => p.mount());
  assert.doesNotThrow(() => p.type('notes without storage'));
  assert.equal(p.el('cnw-draft').textContent, 'This device could not keep a draft — press Save notes before you leave this page.');
  assert.equal(p.el('cnw-draft').className, 'cnw-draft warn');
  assert.doesNotThrow(() => p.type(''));
  p.type('notes without storage'); p.el('cnw-name').value = 'Gauri';
  assert.equal(p.leave(), true);
  p.el('cnw-save').onclick(); await tick();
  assert.equal(p.posts.length, 1); assert.equal(p.el('cnw-text').value, ''); assert.equal(p.el('cnw-msg').textContent, 'Consultation notes saved.');
  // a broken draft value (not JSON) is ignored
  const q = page({ storage: { getItem: (k) => (k === 'tdot_cnotes_777' ? '{oops' : null), setItem() {}, removeItem() {} } });
  assert.doesNotThrow(() => q.mount()); assert.equal(q.el('cnw-text').value, '');
});

test('box: after Sign Out nothing more is written to the device', () => {
  const p = page({ signedOut: true }); p.mount();
  p.type('typed while the page is leaving');
  assert.equal('tdot_cnotes_777' in p.mem, false);
});

test('box: after Sign Out the page never says the draft is kept, does not ask again on leaving, and a refused save says the truth', async () => {
  const st = sharedStorage();
  const p = page({ storage: st }); p.mount();
  p.el('cnw-name').value = 'Gauri'; p.type('notes typed before Sign Out');
  assert.match(p.el('cnw-draft').textContent, /^Draft kept on this device/);
  // Sign Out → OK on this page: the drafts go, the flag is up, the key is gone
  delete st.mem.tdot_cnotes_777; p.window.TDOT_SIGNED_OUT = true; p.ctx.peekKey = () => null;
  assert.equal(p.leave(), false, 'Sign Out already asked — the browser does not ask a second time');
  assert.equal('tdot_cnotes_777' in st.mem, false, 'and leaving writes nothing back');
  p.type('notes typed before Sign Out and more');
  assert.equal(p.el('cnw-draft').textContent, 'Signed out — what is in the box is no longer kept on this device. Press Save notes to keep it.');
  assert.equal(p.el('cnw-draft').className, 'cnw-draft warn');
  p.el('cnw-save').onclick(); await tick();
  assert.equal(p.posts.length, 0);
  assert.match(p.el('cnw-msg').textContent, /^Saving needs the admin key .* Your draft is NOT kept on this device — copy the text somewhere safe before you leave this page\.$/);
  assert.equal('tdot_cnotes_777' in st.mem, false);
});

test('box: Sign Out in ANOTHER tab stops this tab keeping its draft (also on closing), and the line says so', () => {
  const st = sharedStorage();
  const p = page({ storage: st }); p.mount();
  p.type('open in a second tab');
  // the other tab signs out: drafts removed, the stamp set
  delete st.mem.tdot_cnotes_777; st.mem.tdot_signout_at = '123';
  p.win('storage', { key: 'tdot_signout_at' });
  assert.match(p.el('cnw-draft').textContent, /^Signed out — what is in the box is no longer kept on this device/);
  assert.equal(p.leave(), true, 'the text is not saved: leaving still asks');
  assert.equal('tdot_cnotes_777' in st.mem, false, 'nothing is written back after Sign Out');
  p.type('more'); assert.equal('tdot_cnotes_777' in st.mem, false);
  // a page opened after that sign-out (signed in again) keeps drafts as usual
  const next = page({ storage: st }); next.mount(); next.type('new session');
  assert.equal(draftText(st.mem), 'new session');
});

test('box: the same record open in two tabs — one tab never removes or overwrites the other tab’s draft', () => {
  const st = sharedStorage();
  const t1 = page({ storage: st }); t1.mount();
  const t2 = page({ storage: st }); t2.mount();          // opened while the box was still empty
  t1.type('long notes typed in tab one');
  t2.type('x');
  assert.deepEqual(draftsOf(st.mem).sort(), ['long notes typed in tab one', 'x'], 'both are on the device');
  t2.type('');
  assert.deepEqual(draftsOf(st.mem), ['long notes typed in tab one'], 'emptying tab two removes only its own');
  // tab two saves a short separate note: tab one's draft is still there
  t2.el('cnw-name').value = 'Gauri'; t2.type('short note'); t2.el('cnw-save').onclick();
  return tick().then(() => {
    assert.equal(t2.el('cnw-text').value, '');
    assert.deepEqual(draftsOf(st.mem), ['long notes typed in tab one']);
    // both tabs hold text and the browser restarts: one box, both texts, nothing lost
    t2.type('second thought');
    const back = page({ storage: st }); back.mount();
    assert.equal(back.el('cnw-text').value, 'long notes typed in tab one\n\n----------\n\nsecond thought');
    assert.match(back.el('cnw-draft').textContent, /· from 2 tabs — not saved yet$/);
    // typing there makes it ONE draft again
    back.type(back.el('cnw-text').value + ' edited');
    assert.equal(draftsOf(st.mem).length, 1);
  });
});

test('box: a tab that only shows a brought-back draft never writes it back after it was saved elsewhere, and follows the device', async () => {
  const st = sharedStorage();
  const first = page({ storage: st }); first.mount(); first.el('cnw-name').value = 'Gauri'; first.type('the notes');
  const t1 = page({ storage: st }); t1.mount();
  const t2 = page({ storage: st }); t2.mount();
  assert.equal(t1.el('cnw-text').value, 'the notes'); assert.equal(t2.el('cnw-text').value, 'the notes');
  const kept = st.mem.tdot_cnotes_777;
  assert.equal(t2.leave(), true); assert.equal(st.mem.tdot_cnotes_777, kept, 'leaving writes nothing new');
  // tab one saves: the draft leaves the device
  t1.el('cnw-name').value = 'Gauri'; t1.el('cnw-save').onclick(); await tick();
  assert.equal('tdot_cnotes_777' in st.mem, false);
  // tab two is closed later WITHOUT having heard about it: nothing is put back
  const stale = t2.leave();
  assert.equal(stale, true); assert.equal('tdot_cnotes_777' in st.mem, false, 'the saved text does not come back as a draft');
  // and when it does hear (the browser's storage event), its untouched box is cleared
  t2.win('storage', { key: 'tdot_cnotes_777' });
  assert.equal(t2.el('cnw-text').value, '');
  assert.equal(t2.el('cnw-draft').textContent, 'This draft was saved or removed in another tab.');
  assert.equal(t2.leave(), false);
  // a tab whose text was edited is never cleared by another tab
  const a = page({ storage: st }); a.mount(); a.type('mine');
  const b = page({ storage: st }); b.mount(); b.type('mine, edited here');
  delete st.mem.tdot_cnotes_777; b.win('storage', { key: 'tdot_cnotes_777' });
  assert.equal(b.el('cnw-text').value, 'mine, edited here');
});

test('box: a brought-back draft from another day shows its date; drafts older than 14 days are removed from the device when a record opens', () => {
  const day = 86400000; const now = Date.now();
  const st = sharedStorage({
    tdot_cnotes_777: JSON.stringify({ who: 'A', d: { old: { t: 'three days old', at: now - 3 * day, by: 'Shafoli' } } }),
    tdot_cnotes_888: JSON.stringify({ who: 'B', d: { old: { t: 'stale', at: now - 15 * day, by: '' }, fresh: { t: 'fresh', at: now - day, by: '' } } }),
    tdot_cnotes_999: JSON.stringify({ who: 'C', d: { old: { t: 'very stale', at: now - 40 * day, by: '' } } }),
    tdot_cnotes_1000: '{not json', tdot_staff_name: 'Gauri',
  });
  const p = page({ storage: st }); p.mount();
  assert.equal(p.el('cnw-text').value, 'three days old');
  assert.match(p.el('cnw-draft').textContent, /^Draft kept on this device · .*\d{4}.* · typed by Shafoli — not saved yet$/, 'the date, not only a time');
  assert.deepEqual(Object.keys(st.mem).sort(), ['tdot_cnotes_777', 'tdot_cnotes_888', 'tdot_staff_name']);
  assert.deepEqual(draftsOf(st.mem, '888'), ['fresh']);
  assert.equal(CN.DRAFT_DAYS, 14);
  assert.match(CN.consultNotesHtml('cnw'), /anyone who uses this computer can see the draft\. <b>Sign Out<\/b> removes drafts that were not saved \(it asks first\)/);
});

test('box: saved notes are listed with who / Updated / the text as plain text', async () => {
  const made = [];
  const p = page(); p.ctx.document.createElement = () => { const e = fakeEl('x'); made.push(e); return e; };
  p.mount(); await tick();
  const texts = made.map((e) => e.textContent);
  for (const t of ['Gauri', 'Updated', '<b>x</b>']) assert.ok(texts.includes(t), t);
  assert.ok(made.every((e) => e.innerHTML === ''), 'never innerHTML');
});

/* ── the staff guide ── */

test('guide: the consultation-notes step and how-to, linked from the steps around it; its on-screen words are in the page code', () => {
  const g = JSON.parse(fs.readFileSync(require.resolve('../src/staffGuide/guide-data.json'), 'utf8'));
  const byId = Object.fromEntries(g.steps.map((s) => [s.id, s]));
  const s = byId['consultation-notes-type'];
  assert.ok(s, 'the step');
  assert.deepEqual([s.stage, s.lane, s.switch], ['consultation', 'consultant', '']);
  assert.ok(s.order > byId['consultation-hold'].order && s.order < byId['consultation-outcome-set'].order);
  const ids = (xs) => xs.flatMap((x) => x.step_ids || []);
  for (const id of [...s.related, ...ids(g.howto), ...ids(g.branches)]) assert.ok(byId[id], `step ${id}`);
  for (const id of ['consultation-hold', 'consultation-otter-summary', 'consultation-record-open']) assert.ok(byId[id].related.includes(s.id), id);
  assert.ok(g.howto.some((h) => (h.step_ids || []).includes(s.id)));
  assert.ok(g.branches.find((b) => b.id === 'branch-direct-consultation').step_ids.includes(s.id));
  const src = ['../src/routes/consultNotesWidget.js', '../src/routes/adminConsultation.js']
    .map((p) => fs.readFileSync(require.resolve(p), 'utf8')).join('\n').replace(/<[^<>]*>/g, ' ').replace(/\s+/g, ' ');
  for (const o of s.options.filter((x) => x.exact)) assert.ok(src.includes(o.label), `"${o.label}" is on screen`);
  for (const m of ['Type the consultation notes first.', 'Add your name so the team knows who wrote the notes.', 'These notes were already saved — no second copy was made.', 'Consultation notes saved.']) {
    assert.ok(CN.CONSULT_NOTES_JS.includes(m) && JSON.stringify(s).includes(m), m);
  }
  // every source file the step names exists
  for (const ref of s.source) assert.ok(fs.existsSync(require('node:path').join(__dirname, '..', ref.split(':')[0])), ref);
});
