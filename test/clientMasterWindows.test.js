'use strict';

// Block 3 (Client Master page): the half-month windows (1–15 / 16–end) and the two
// display-only flags on an Imaginary case. Plan section 4.4–4.5 and test 5.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

const W = require('../src/routes/clientMasterWindows');

test('windowOf: day 15 is the first half, day 16 the second; "end" is the month\'s real last day (28, 29, 30, 31 days)', () => {
  assert.deepEqual(W.windowOf('2026-11-15'), { key: '2026-11-1', label: 'Nov 1–15', start: '2026-11-01', end: '2026-11-15' });
  assert.deepEqual(W.windowOf('2026-11-16'), { key: '2026-11-2', label: 'Nov 16–30', start: '2026-11-16', end: '2026-11-30' });
  assert.deepEqual(W.windowOf('2026-11-01'), W.windowOf('2026-11-09'));
  assert.equal(W.windowOf('2026-02-20').label, 'Feb 16–28');
  assert.equal(W.windowOf('2026-02-28').end, '2026-02-28');
  assert.equal(W.windowOf('2028-02-29').label, 'Feb 16–29', 'a leap year');
  assert.equal(W.windowOf('2026-04-30').label, 'Apr 16–30');
  assert.equal(W.windowOf('2026-12-31').label, 'Dec 16–31');
  assert.equal(W.windowOf('2026-12-31').end, '2026-12-31');
  assert.equal(W.windowOf('2026-11-20T09:00:00Z').key, '2026-11-2', 'a date with a time is read by its day');
  for (const bad of ['', null, undefined, '2026-13-01', 'Nov 3', '26-11-01']) assert.equal(W.windowOf(bad), null, String(bad));
});

test('nextWindow: first half → second half; Dec 16–31 → Jan 1–15 of the next year; takes a key or a window', () => {
  assert.equal(W.nextWindow('2026-11-1').label, 'Nov 16–30');
  assert.equal(W.nextWindow('2026-11-2').label, 'Dec 1–15');
  assert.deepEqual(W.nextWindow('2026-12-2'), { key: '2027-01-1', label: 'Jan 1–15', start: '2027-01-01', end: '2027-01-15' });
  assert.equal(W.nextWindow(W.windowOf('2026-01-20')).label, 'Feb 1–15');
  assert.equal(W.nextWindow('2026-02-1').label, 'Feb 16–28');
  assert.equal(W.nextWindow('junk'), null);
});

test('"today" is the Toronto calendar day — at the midnight edge (04:30 UTC is still yesterday in Toronto), whatever the process time zone', () => {
  assert.equal(W.torontoToday(Date.parse('2026-11-09T04:30:00Z')), '2026-11-08', 'EST: UTC-5');
  assert.equal(W.torontoToday(Date.parse('2026-11-09T05:30:00Z')), '2026-11-09');
  assert.equal(W.torontoToday(Date.parse('2026-07-01T03:30:00Z')), '2026-06-30', 'EDT: UTC-4');
  // the same answer with the process set to another time zone (Intl timeZone, not the machine's clock)
  const { execFileSync } = require('child_process');
  for (const tz of ['Asia/Karachi', 'Pacific/Auckland', 'UTC']) {
    const out = execFileSync(process.execPath, ['-e', "process.stdout.write(require('" + path.resolve(__dirname, '../src/routes/clientMasterWindows').replace(/\\/g, '/') + "').torontoToday(Date.parse('2026-11-09T04:30:00Z')))"], { env: { ...process.env, TZ: tz, NODE_OPTIONS: '' } }).toString();
    assert.equal(out, '2026-11-08', tz);
  }
});

test('the date a row is counted under: Real → Actual Deadline, Imaginary → Internal Deadline (the promise), not recorded → Actual if any — NEVER Hard, Soft or Prep Deadline', () => {
  const sla = { hardDeadline: '2026-11-02', softDeadline: '2026-11-03', prepDeadline: '2026-11-04' };
  assert.equal(W.bucketDate({ ...sla, deadlineType: 'Deadline', actualDeadline: '2026-11-20', promisedDate: '2026-11-05' }), '2026-11-20');
  assert.equal(W.bucketDate({ ...sla, deadlineType: 'Imaginary', actualDeadline: '2026-11-20', promisedDate: '2026-11-05' }), '2026-11-05');
  assert.equal(W.bucketDate({ ...sla, deadlineType: 'Imaginary', actualDeadline: '2026-11-20', promisedDate: '' }), '', 'an Imaginary case with no promise has no date');
  assert.equal(W.bucketDate({ ...sla, deadlineType: '', actualDeadline: '2026-11-20' }), '2026-11-20');
  assert.equal(W.bucketDate({ ...sla, deadlineType: '', actualDeadline: '' }), '', 'the SLA dates are never used');
  assert.equal(W.bucketDate({ ...sla, deadlineType: 'Deadline', actualDeadline: '' }), '');
  assert.deepEqual(['Deadline', 'Imaginary', '', 'Something else'].map((t) => W.typeOf({ deadlineType: t })), ['real', 'imaginary', 'none', 'none']);
  // the module source never names the SLA columns or fields
  const src = fs.readFileSync(require.resolve('../src/routes/clientMasterWindows'), 'utf8');
  for (const bad of ['hardDeadline', 'softDeadline', 'prepDeadline', 'date_mm0x5pqd', 'date_mm0x26t4', 'date_mm0xfgbp']) assert.ok(!src.includes(bad), bad);
});

test('the windows box: this half and the next three, each Real / Imaginary / Not recorded, then Later / Earlier dates / No date', () => {
  const rows = [
    { deadlineType: 'Deadline', actualDeadline: '2026-11-08' },     // now (Nov 1–15)
    { deadlineType: 'Deadline', actualDeadline: '2026-11-15' },     // now
    { deadlineType: 'Imaginary', promisedDate: '2026-11-16' },      // Nov 16–30
    { deadlineType: '', actualDeadline: '2026-12-31' },              // Dec 16–31 (the 4th)
    { deadlineType: 'Deadline', actualDeadline: '2027-01-01' },     // later
    { deadlineType: 'Deadline', actualDeadline: '2026-10-31' },     // earlier
    { deadlineType: '', actualDeadline: '' },                        // no date
    { deadlineType: 'Imaginary', promisedDate: '' },                 // no date
  ];
  const box = W.windowsBox(rows, '2026-11-08');
  assert.deepEqual(box.windows.map((w) => w.label), ['Nov 1–15', 'Nov 16–30', 'Dec 1–15', 'Dec 16–31']);
  assert.deepEqual(box.windows.map((w) => [w.real, w.imaginary, w.none, w.total]), [[2, 0, 0, 2], [0, 1, 0, 1], [0, 0, 0, 0], [0, 0, 1, 1]]);
  assert.deepEqual([box.later, box.earlier, box.noDate], [1, 1, 2]);
  assert.equal(box.windows.reduce((n, w) => n + w.total, 0) + box.later + box.earlier + box.noDate, rows.length, 'every row counted once');
  assert.deepEqual(W.windowsBox([], '2026-12-20').windows.map((w) => w.label), ['Dec 16–31', 'Jan 1–15', 'Jan 16–31', 'Feb 1–15'], 'across the year end');
});

test('"May slide →": Imaginary, promise 0–15 days away, documents known and below 50% — the label names the half AFTER the promise', () => {
  const T = '2026-11-08';
  const row = (o) => ({ deadlineType: 'Imaginary', promisedDate: '2026-11-20', docUploadedPct: 30, ...o });
  const f = W.flagOf(row({}), T);
  assert.equal(f.kind, 'slide');
  assert.equal(f.label, 'May slide → Dec 1–15', 'P = 2026-11-20 is in Nov 16–30; the next half is Dec 1–15');
  assert.match(f.tip, /^Imaginary deadline, promised Nov 20, documents 30% in\. Nothing has been changed — moving it is your decision\.$/);
  assert.equal(W.flagOf(row({ promisedDate: T }), T).kind, 'slide', 'P today: yes');
  assert.equal(W.flagOf(row({ promisedDate: '2026-11-23' }), T).kind, 'slide', '15 days: yes');
  assert.equal(W.flagOf(row({ promisedDate: '2026-11-24' }), T), null, '16 days: no');
  assert.equal(W.flagOf(row({ docUploadedPct: 0 }), T).kind, 'slide', '0% flags (a known 0)');
  assert.equal(W.flagOf(row({ docUploadedPct: 49.6 }), T).kind, 'slide');
  assert.equal(W.flagOf(row({ docUploadedPct: 50 }), T), null, '50% is not below half');
  assert.equal(W.flagOf(row({ docUploadedPct: null }), T), null, 'a blank % never flags (blank is not 0)');
  assert.equal(W.flagOf(row({ docUploadedPct: undefined }), T), null);
  assert.equal(W.flagOf(row({ deadlineType: 'Deadline' }), T), null, 'a Real deadline never slides');
  assert.equal(W.flagOf(row({ deadlineType: '' }), T), null, 'not recorded: no flag');
  assert.equal(W.flagOf(row({ promisedDate: '' }), T), null, 'no promise: no flag');
});

test('"Promise passed": the same case 1–15 days after the promise; older promises show nothing; never both chips', () => {
  const T = '2026-11-08';
  const row = (o) => ({ deadlineType: 'Imaginary', promisedDate: '2026-11-03', docUploadedPct: 30, ...o });
  const f = W.flagOf(row({}), T);
  assert.deepEqual([f.kind, f.label], ['passed', 'Promise passed Nov 3']);
  assert.equal(f.tip, 'Imaginary deadline, promised Nov 3, documents 30% in. Nothing has been changed.');
  assert.equal(W.flagOf(row({ promisedDate: '2026-11-07' }), T).kind, 'passed', '1 day ago');
  assert.equal(W.flagOf(row({ promisedDate: '2026-10-24' }), T).kind, 'passed', '15 days ago');
  assert.equal(W.flagOf(row({ promisedDate: '2026-10-23' }), T), null, '16 days ago: nothing (old rows never nag)');
  assert.equal(W.flagOf(row({ deadlineType: 'Deadline' }), T), null);
  assert.equal(W.flagOf(row({ docUploadedPct: null }), T), null);
  // one value per row: kind is either slide or passed, never both
  for (let d = -20; d <= 20; d++) {
    const day = new Date(Date.UTC(2026, 10, 8 + d)).toISOString().slice(0, 10);
    const got = W.flagOf(row({ promisedDate: day }), T);
    const want = d >= 0 && d <= 15 ? 'slide' : d < 0 && d >= -15 ? 'passed' : null;
    assert.equal(got ? got.kind : null, want, day);
  }
});

test('SPRINT_MODE is the ONE switch and accepts only the built mode: any other value throws when the module loads', () => {
  assert.equal(W.SPRINT_MODE, 'calendar-halves');
  const src = W.clientMasterWindows.toString();
  assert.equal(src.split("var SPRINT_MODE = 'calendar-halves';").length, 2, 'set in one place');
  for (const other of ['from-case-start-14', 'calendar-thirds', '']) {
    const fn = vm.runInNewContext('(' + src.replace("var SPRINT_MODE = 'calendar-halves';", 'var SPRINT_MODE = ' + JSON.stringify(other) + ';') + ')');
    assert.throws(() => fn(), /SPRINT_MODE .* is not built/, other);
  }
  assert.equal([W.SLIDE_DAYS, W.SLIDE_DOCS_BELOW].join(','), '15,50');
});

test('page-script rule: the injected source has no backtick, no dollar-brace, no backslash, and parses on its own', () => {
  const src = W.clientMasterWindows.toString();
  assert.ok(!/[`\\]|\$\{/.test(src));
  new vm.Script('(' + src + ')()');
  // it refers to nothing outside itself: it runs in a bare context
  const api = vm.runInNewContext('(' + src + ')()');
  assert.equal(api.windowOf('2026-11-16').label, 'Nov 16–30');
});
