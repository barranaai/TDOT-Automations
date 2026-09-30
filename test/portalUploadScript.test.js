'use strict';

/**
 * The portal's inline upload script, EXECUTED — not just parsed.
 *
 * The 2026-09 "second upload of a document is not there": the script counted
 * HTTP requests, not picks. Between the files of one multi-file pick nothing
 * is in flight, so once a reload was wanted the page reloaded 600 ms after
 * the pick's FIRST file — files 2..n were aborted mid-body, silently. And a
 * successful pick never reloaded at all (the request counter was settled
 * before the reload was wanted), leaving the row locked.
 *
 * The script is a string inside a Node template literal, so the only proof of
 * what a client gets is to take the EMITTED <script>, run it over a fake DOM
 * with a fetch the test answers in the order it chooses, a virtual clock and
 * a recording window.location.reload — then read the log.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const vm     = require('node:vm');

const { buildPortalPage, clientStage, toClientTimeline } = require('../src/services/clientPortalService');

const A = '11', B = '12';          // Passport (Missing) and Bank statement (Rework Required): both uploadable
const MB = 1024 * 1024;
const RED = '#B42318', AMBER = '#B54708', GREY = '#9AA3AF';
const SAVED_MSG = 'Your file was saved, but our checklist could not be updated just now. Please do not upload it again.';
const BUSY_MSG  = 'The server is busy — please try again in a moment.';

// The fixtures of test/clientPortal.test.js (snap + docSnap), verbatim.
function snap() {
  return {
    clientName: 'Kamalpreet Singh', caseRef: '2026-SP-001', caseType: 'Study Permit', caseSubType: null,
    caseStage: 'Document Collection Started', accessToken: 'tok',
    qReadinessPct: 40, qCompletionStatus: '', docCounts: { total: 4, received: 1, reviewed: 1, rework: 1, missing: 1 },
    reworkDocs: [{ name: 'Bank statement' }], totalMembers: 2, submittedMembers: 1,
    journey: clientStage('Document Collection Started'),
    timeline: toClientTimeline([{ date: '2026-06-01', title: 'Inquiry received', detail: '', kind: 'lead' }]),
    payments: null,
    docItems: [
      { id: '11', name: 'Passport', status: 'Missing', category: 'Identity', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '' },
      { id: '12', name: 'Bank statement', status: 'Rework Required', category: 'Financial', applicantType: 'Principal Applicant', reviewNotes: 'May is missing', clientInstructions: '', lastUpload: '2026-07-13' },
      { id: '13', name: 'IELTS', status: 'Reviewed', category: 'Language', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '2026-07-10' },
    ],
  };
}

function uploadScript() {
  const html = buildPortalPage(snap());
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = blocks.find((s) => s.includes('input[type="file"][data-item]'));
  assert.ok(src, 'the client portal emits the upload script when a row is uploadable');
  return src;
}

function files(n) { return Array.from({ length: n }, (_, k) => ({ name: 'f' + (k + 1) + '.pdf', size: 10 })); }

/**
 * A page for the script to live in: two upload inputs, a state line per row,
 * a fetch that answers only when the test says so, a clock that moves only
 * when the test says so, and a reload that is written down instead of done.
 */
function harness() {
  const log = [];                       // 'POST <row>' and 'RELOAD', in the order they happened
  const calls = [];                     // every fetch: { id, answered, resolve, reject }
  const states = { [A]: { text: '', color: '' }, [B]: { text: '', color: '' } };
  const inputs = {}, labels = {};

  // ── virtual clock ──
  let now = 0, seq = 0; const timers = [];
  const vSetTimeout = (fn, ms) => { const id = ++seq; timers.push({ id, at: now + (Number(ms) || 0), fn }); return id; };
  const vClearTimeout = (id) => { const i = timers.findIndex((t) => t.id === id); if (i !== -1) timers.splice(i, 1); };
  // Promise chains are microtasks: one macrotask turn drains them all. A few
  // turns cost nothing and make the harness indifferent to Node's scheduling.
  async function flush() { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); }
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      await flush();
      const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.at;
      due.fn();
    }
    now = target;
    await flush();
  }

  // ── fake DOM ──
  for (const id of [A, B]) {
    const label = { busy: false, classList: {
      add: (c) => { if (c === 'busy') label.busy = true; },
      remove: (c) => { if (c === 'busy') label.busy = false; },
    } };
    labels[id] = label;
    inputs[id] = {
      files: [], disabled: false, value: '', listeners: {},
      closest: (sel) => (sel === 'label' ? label : null),
      getAttribute: (a) => (a === 'data-item' ? id : null),
      addEventListener(ev, fn) { this.listeners[ev] = fn; },
    };
  }
  const document = {
    querySelectorAll: (sel) => (sel === 'input[type="file"][data-item]' ? [inputs[A], inputs[B]] : []),
    querySelector: (sel) => {
      const m = /^\[data-state="(\w+)"\]$/.exec(sel);
      if (!m || !states[m[1]]) return null;
      const s = states[m[1]];
      return {
        get textContent() { return s.text; }, set textContent(v) { s.text = v; },
        style: { get color() { return s.color; }, set color(v) { s.color = v; } },
      };
    },
  };
  const window = { location: { reload: () => log.push('RELOAD'), pathname: '/client/2026-SP-001' } };
  const fetch = (url, init) => {
    assert.equal(init && init.method, 'POST');
    assert.ok(init.body instanceof FormData, 'the file goes as multipart form data');
    const id = decodeURIComponent(String(url).split('/')[4]);
    log.push('POST ' + id);
    return new Promise((resolve, reject) => { calls.push({ id, answered: false, resolve, reject }); });
  };
  function FormData() { this.parts = []; this.append = (k, f, name) => this.parts.push([k, name]); }

  new Function('document', 'window', 'fetch', 'FormData', 'setTimeout', 'clearTimeout', uploadScript())(
    document, window, fetch, FormData, vSetTimeout, vClearTimeout);

  const h = {
    log, calls, states, inputs, labels, advance, flush,
    posts: () => log.filter((l) => l.startsWith('POST ')).length,
    reloads: () => log.filter((l) => l === 'RELOAD').length,
    open: () => calls.filter((c) => !c.answered),
    locked: (id) => inputs[id].disabled || labels[id].busy,
    async pick(id, what) {
      inputs[id].files = Array.isArray(what) ? what : files(what);
      inputs[id].listeners.change();
      await flush();
    },
    async respond(call, status, body) {
      assert.equal(call.answered, false, 'a request is answered once');
      call.answered = true;
      call.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
      await flush();
    },
    ok: (call) => h.respond(call, 200, { success: true }),
    busy: (call) => h.respond(call, 503, { success: false, retriable: true, error: BUSY_MSG }),
    async garble(call) {                     // an HTML error page where JSON was expected
      call.answered = true;
      call.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('Unexpected token <')) });
      await flush();
    },
    async drop(call) {                       // the connection died
      call.answered = true;
      call.reject(new TypeError('Failed to fetch'));
      await flush();
    },
  };
  return h;
}

// ─── (49) one file on one row ────────────────────────────────────────────────

test('49: one file → one POST, "Uploaded ✓", the row unlocked and cleared, ONE reload 600 ms later', async () => {
  const h = harness();
  await h.pick(A, 1);
  assert.deepEqual(h.log, ['POST 11']);
  assert.equal(h.locked(A), true, 'the row is locked while its file is in flight');
  assert.match(h.states[A].text, /^Uploading f1\.pdf…$/);
  await h.ok(h.calls[0]);
  assert.equal(h.states[A].text, 'Uploaded ✓');
  assert.equal(h.states[A].color, GREY);
  assert.equal(h.locked(A), false, 'a finished row is unlocked (today it stayed locked for good)');
  assert.equal(h.inputs[A].value, '', 'the input is cleared so the same file can be picked again on purpose');
  assert.equal(h.reloads(), 0, 'no reload before the grace');
  await h.advance(599);
  assert.equal(h.reloads(), 0);
  await h.advance(1);
  assert.deepEqual(h.log, ['POST 11', 'RELOAD'], 'the reload the old script never fired (settle() ran before wantReload was set)');
  await h.advance(5000);
  assert.equal(h.reloads(), 1, 'exactly one reload');
});

// ─── (50) three files on one row ─────────────────────────────────────────────

test('50: three files → three POSTs strictly one at a time, then one reload', async () => {
  const h = harness();
  await h.pick(A, 3);
  assert.equal(h.posts(), 1, 'only the first file is sent');
  assert.equal(h.states[A].text, 'Uploading f1.pdf (1 of 3)…');
  await h.ok(h.calls[0]);
  assert.equal(h.posts(), 2, 'the second starts only after the first answered');
  assert.equal(h.open().length, 1);
  assert.equal(h.states[A].text, 'Uploading f2.pdf (2 of 3)…');
  await h.advance(600);
  assert.equal(h.reloads(), 0, 'no reload between the files of one pick — the old script reloaded here');
  await h.ok(h.calls[1]);
  assert.equal(h.posts(), 3);
  await h.ok(h.calls[2]);
  assert.equal(h.states[A].text, 'All 3 files uploaded ✓');
  assert.equal(h.locked(A), false);
  await h.advance(600);
  assert.deepEqual(h.log, ['POST 11', 'POST 11', 'POST 11', 'RELOAD']);
});

// ─── (51) a second pick during the reload grace ──────────────────────────────

test('51: A×1 then B×3 picked inside the grace → the timer is cancelled; all four POSTs precede the single reload, which follows B\'s third answer', async () => {
  const h = harness();
  await h.pick(A, 1);
  await h.ok(h.calls[0]);
  await h.advance(300);                              // inside the 600 ms grace
  assert.equal(h.reloads(), 0);
  await h.pick(B, 3);
  assert.equal(h.posts(), 2, 'B\'s first file went out');
  await h.advance(600);
  assert.equal(h.reloads(), 0, 'A\'s pending reload was cancelled by B\'s pick');
  await h.ok(h.calls[1]);
  await h.advance(600);
  assert.equal(h.reloads(), 0, 'THE bug: the old script reloaded 600 ms after B\'s first file and lost f2 + f3');
  await h.ok(h.calls[2]);
  await h.advance(600);
  assert.equal(h.reloads(), 0);
  await h.ok(h.calls[3]);
  assert.equal(h.states[B].text, 'All 3 files uploaded ✓');
  assert.equal(h.reloads(), 0, 'the reload waits its own grace after the last pick');
  await h.advance(600);
  assert.deepEqual(h.log, ['POST 11', 'POST 12', 'POST 12', 'POST 12', 'RELOAD']);
  await h.advance(5000);
  assert.equal(h.reloads(), 1);
});

// ─── (52) two rows uploading at the same time ────────────────────────────────

test('52: A×2 and B×2 interleaved → four POSTs, one reload after the last of them', async () => {
  const h = harness();
  await h.pick(A, 2);
  await h.pick(B, 2);
  assert.deepEqual(h.log, ['POST 11', 'POST 12'], 'each row sends its first file; rows do not queue behind each other');
  await h.ok(h.calls[0]);                            // A f1 → A f2 starts
  await h.ok(h.calls[1]);                            // B f1 → B f2 starts
  assert.deepEqual(h.log, ['POST 11', 'POST 12', 'POST 11', 'POST 12']);
  await h.ok(h.calls[2]);                            // A finished, B still going
  assert.equal(h.states[A].text, 'All 2 files uploaded ✓');
  assert.equal(h.locked(A), false);
  await h.advance(600);
  assert.equal(h.reloads(), 0, 'A finishing must not reload while B\'s file is mid-body');
  await h.ok(h.calls[3]);
  assert.equal(h.states[B].text, 'All 2 files uploaded ✓');
  await h.advance(600);
  assert.deepEqual(h.log, ['POST 11', 'POST 12', 'POST 11', 'POST 12', 'RELOAD']);
});

// ─── (53) one failure in the middle of a pick ────────────────────────────────

test('53: 200, 400, 200 → the third file is still sent; the red text names the failed file with the FINAL "did upload" count; no reload, ever', async () => {
  const h = harness();
  await h.pick(A, 3);
  await h.ok(h.calls[0]);
  await h.respond(h.calls[1], 400, { success: false, error: 'Not a PDF' });
  assert.equal(h.posts(), 3, 'a failed file does not stop the rest of the pick');
  await h.ok(h.calls[2]);
  assert.equal(h.states[A].text, '"f2.pdf": Not a PDF (2 file(s) did upload)', 'f1 and f3 landed — the count is the truth at the end, not at the moment f2 failed');
  assert.equal(h.states[A].color, RED);
  assert.equal(h.locked(A), false, 'the row is free for another try');
  assert.equal(h.inputs[A].value, '');
  await h.advance(5000);
  assert.equal(h.reloads(), 0, 'a message the client must read stays on screen');
  // A later success on another row: its own row says so, and the page still does not reload.
  await h.pick(B, 1);
  await h.ok(h.calls[3]);
  assert.equal(h.states[B].text, 'Uploaded ✓');
  assert.equal(h.locked(B), false);
  await h.advance(5000);
  assert.equal(h.reloads(), 0, 'the failure text on A would be wiped by a reload');
  assert.equal(h.states[A].text, '"f2.pdf": Not a PDF (2 file(s) did upload)');
});

// ─── (54) the server says busy, then takes the file ──────────────────────────

test('54: 503-503-200 (retriable) → busy text, sent again after 15 s twice, three POSTs for one file, no reload before the third answer', async () => {
  const h = harness();
  await h.pick(A, 1);
  await h.busy(h.calls[0]);
  assert.equal(h.states[A].text, 'The server is busy — "f1.pdf" will be sent again in a moment…');
  assert.equal(h.states[A].color, GREY, 'busy is not an error');
  assert.equal(h.posts(), 1, 'the retry waits');
  assert.equal(h.locked(A), true, 'the row stays locked through the wait');
  await h.advance(14999);
  assert.equal(h.posts(), 1);
  await h.advance(1);
  assert.equal(h.posts(), 2, 'sent again at +15 s');
  await h.busy(h.calls[1]);
  await h.advance(15000);
  assert.equal(h.posts(), 3);
  assert.equal(h.reloads(), 0, 'no reload while the file is still being sent');
  await h.ok(h.calls[2]);
  assert.equal(h.states[A].text, 'Uploaded ✓');
  await h.advance(600);
  assert.deepEqual(h.log, ['POST 11', 'POST 11', 'POST 11', 'RELOAD']);
});

// ─── (55) busy eight times ───────────────────────────────────────────────────

test('55: eight 503s → gives up with the server\'s busy message in red, eight POSTs, no ninth, no reload', async () => {
  const h = harness();
  await h.pick(A, 1);
  for (let i = 0; i < 8; i++) {
    assert.equal(h.posts(), i + 1);
    await h.busy(h.calls[i]);
    if (i < 7) await h.advance(15000);
  }
  assert.equal(h.posts(), 8);
  assert.equal(h.states[A].text, '"f1.pdf": ' + BUSY_MSG);
  assert.equal(h.states[A].color, RED);
  assert.equal(h.locked(A), false);
  await h.advance(120000);
  assert.equal(h.posts(), 8, 'no ninth attempt');
  assert.equal(h.reloads(), 0);
});

// ─── (56) the file landed but the checklist could not be marked ──────────────

test('56: { success:false, saved:true, error } → the server\'s own words in amber, no reload, the row unlocked', async () => {
  const h = harness();
  await h.pick(A, 1);
  await h.respond(h.calls[0], 200, { success: false, saved: true, error: SAVED_MSG });
  assert.equal(h.states[A].text, SAVED_MSG, 'the client reads exactly what the server said');
  assert.equal(h.states[A].color, AMBER, 'amber: not a failure, not a plain success');
  assert.equal(h.locked(A), false);
  assert.equal(h.inputs[A].value, '');
  await h.advance(5000);
  assert.equal(h.reloads(), 0, 'the status line on the page is stale by the server\'s own admission — a reload would show "Missing" for a saved file');
  // In a multi-file pick, one saved-but-unmarked file colours the whole pick amber.
  await h.pick(B, 2);
  await h.ok(h.calls[1]);
  await h.respond(h.calls[2], 200, { success: false, saved: true, error: SAVED_MSG });
  assert.equal(h.states[B].text, SAVED_MSG);
  assert.equal(h.states[B].color, AMBER);
  await h.advance(5000);
  assert.equal(h.reloads(), 0);
  assert.equal(h.states[A].text, SAVED_MSG, 'still on screen');
});

test('56b: saved-but-unmarked on one file and a real failure on another → the failure wins (red) but the saved file is NAMED (or the client re-sends it), still no reload', async () => {
  const h = harness();
  await h.pick(A, 2);
  await h.respond(h.calls[0], 200, { success: false, saved: true, error: SAVED_MSG });
  await h.respond(h.calls[1], 400, { success: false, error: 'Not a PDF' });
  assert.equal(h.states[A].text, '"f2.pdf": Not a PDF (1 file(s) were saved — please do not send those again)');
  assert.equal(h.states[A].color, RED);
  await h.advance(5000);
  assert.equal(h.reloads(), 0);
});

// ─── (57) a file over the limit ──────────────────────────────────────────────

test('57: an over-limit pick → red limit text, nothing sent, no lock; the message stays — a later good pick on another row completes but does not reload (A4)', async () => {
  const h = harness();
  await h.pick(A, [{ name: 'huge.pdf', size: 60 * MB }]);
  assert.equal(h.states[A].text, '"huge.pdf" is 60 MB. The limit is 50 MB per file. Split it into smaller files or scan at a lower quality.');
  assert.equal(h.states[A].color, RED);
  assert.equal(h.posts(), 0, 'nothing is sent');
  assert.equal(h.locked(A), false, 'never locked');
  assert.equal(h.inputs[A].value, '');
  await h.pick(B, 1);
  await h.ok(h.calls[0]);
  assert.equal(h.states[B].text, 'Uploaded ✓');
  assert.equal(h.locked(B), false, 'the over-limit pick left no half-open state behind');
  await h.advance(5000);
  assert.equal(h.reloads(), 0, 'a reload would wipe the limit message the client must act on');
  assert.equal(h.states[A].text, '"huge.pdf" is 60 MB. The limit is 50 MB per file. Split it into smaller files or scan at a lower quality.');
});

test('57b: an over-limit pick during the reload grace cancels the pending reload for good (A4: clearTimeout sits above the size check)', async () => {
  const h = harness();
  await h.pick(A, 1);
  await h.ok(h.calls[0]);
  await h.advance(300);
  await h.pick(B, [{ name: 'huge.pdf', size: 51 * MB }]);
  assert.match(h.states[B].text, /^"huge\.pdf" is 51 MB\. The limit is 50 MB per file\./);
  await h.advance(5000);
  assert.equal(h.reloads(), 0, 'A\'s reload was cancelled by B\'s over-limit pick and is not rescheduled');
  assert.equal(h.states[A].text, 'Uploaded ✓', 'A\'s own row still says what happened');
});

test('57c: source order — the timer is cancelled BEFORE the size check, and the over-limit branch returns BEFORE the pick is counted (no activePicks leak)', () => {
  const src = uploadScript();
  const handler = src.slice(src.indexOf("addEventListener('change'"));
  const cancel = handler.indexOf('clearTimeout(reloadTimer)');
  const limit  = handler.indexOf("The limit is ' + MAX_MB + ' MB per file");
  const count  = handler.indexOf('activePicks++');
  assert.ok(cancel !== -1 && limit !== -1 && count !== -1, 'all three steps are in the change handler');
  assert.ok(cancel < limit, 'clearTimeout above the size check (A4)');
  assert.ok(limit < count, 'the over-limit return happens before activePicks++ — a refused pick can never hold the reload count');
  const limitLine = handler.slice(limit, handler.indexOf('\n', limit));
  assert.match(limitLine, /holdReload = true; return; \}/, 'the over-limit branch holds the reload and returns');
  assert.ok(!limitLine.includes('activePicks'), 'and touches no counter');
});

// ─── (58) the server answered with something that is not JSON, or not at all ─

test('58: a non-JSON reply → the connection message in red, the row unlocked, no reload', async () => {
  const h = harness();
  await h.pick(A, 1);
  await h.garble(h.calls[0]);
  assert.equal(h.states[A].text, '"f1.pdf": Upload failed — please check your connection and try again.');
  assert.equal(h.states[A].color, RED);
  assert.equal(h.locked(A), false);
  await h.advance(5000);
  assert.equal(h.reloads(), 0);
});

test('58b: a dropped connection → the same message; a following retry on the same row works', async () => {
  const h = harness();
  await h.pick(A, 1);
  await h.drop(h.calls[0]);
  assert.equal(h.states[A].text, '"f1.pdf": Upload failed — please check your connection and try again.');
  assert.equal(h.locked(A), false);
  await h.pick(A, 1);
  assert.equal(h.posts(), 2, 'the row accepts a new pick after a failure');
  await h.ok(h.calls[1]);
  assert.equal(h.states[A].text, 'Uploaded ✓');
  await h.advance(5000);
  assert.equal(h.reloads(), 0, 'the earlier failure holds the reload — the client saw a failure on this page and the state line must not vanish under them');
});

// ─── (59) the pinned literals and the inline-JS rules ────────────────────────

test('59: the three literals other suites pin are still in the source; the emitted script obeys the inline-JS rules and parses with hostile values', () => {
  const portal = fs.readFileSync(require.resolve('../src/services/clientPortalService.js'), 'utf8');
  assert.match(portal, /busy: r\.status === 503 && !!j\.retriable/);
  assert.match(portal, /if \(res\.busy && n < 8\)/);
  assert.match(portal, /The limit is ' \+ MAX_MB \+ ' MB per file/);
  assert.match(portal, /saved: !!j\.saved/, 'sendOnce carries the server\'s saved flag');
  assert.doesNotMatch(portal, /var inFlight = 0, wantReload = false;/, 'the request counter is gone');

  const src = uploadScript();
  const body = src.slice(src.indexOf('var activePicks'));
  assert.ok(!body.includes('`'), 'no backtick inside the emitted script');
  assert.ok(!body.includes('${'), 'no ${ inside the emitted script');
  assert.ok(!body.includes('\\'), 'no backslash escape inside the emitted script (the lost-backslash trap)');
  assert.doesNotThrow(() => new vm.Script(src), 'the emitted script parses');

  // The hostile snapshot of test/inlineScripts.test.js: values with </script> and backticks stay inert.
  const hostile = Object.assign(snap(), {
    clientName: 'X</script><script>alert(1)</script>', caseRef: 'R</script>', accessToken: 't</script>',
    docItems: [{ id: '1', name: 'Doc `with` "quotes"\n and newline', status: 'Missing', category: 'C', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '' }],
  });
  const html = buildPortalPage(hostile);
  const scripts = html.match(/<script>[\s\S]*?<\/script>/g) || [];
  assert.equal(scripts.length, 1, 'one script block — a </script> in a value must not split it');
  assert.doesNotThrow(() => new vm.Script(scripts[0].slice('<script>'.length, -'</script>'.length)));
});
