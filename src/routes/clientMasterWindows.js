'use strict';

/**
 * The Client Master page's half-month windows (team meeting 2026-11-05: deadlines in
 * sprints of 1–15 / 16–end of the month) and the two display-only flags on an
 * Imaginary case ("May slide →", "Promise passed").
 *
 * Plain browser JavaScript injected with Function#toString (like listCore): the one
 * function below refers to nothing outside itself. Node requires this file for the
 * tests, and calling it at load means a wrong SPRINT_MODE throws here too.
 *
 * Rules (block 3 plan, section 4.4–4.5):
 *   - "Today" is the Toronto calendar day, whatever the browser's time zone.
 *   - The date a row is counted under: Real → Actual Deadline; Imaginary → Internal
 *     Deadline (the promise); not recorded → Actual Deadline if there is one.
 *     NEVER Hard, Soft or Prep Deadline (SLA outputs, not the client's deadline).
 *   - Both flags: Imaginary, a promise date, and Documents Uploaded % KNOWN and below
 *     SLIDE_DOCS_BELOW (a blank % is not 0 and never flags). "May slide" when the
 *     promise is 0–SLIDE_DAYS days away; "Promise passed" when it was 1–SLIDE_DAYS days
 *     ago; older promises show nothing. Nothing is ever written, moved or emailed.
 */

/* eslint-disable no-var */
function clientMasterWindows() {
  /* The ONE switch for the sprint windows (Gauri to confirm). Only 'calendar-halves' is built.
     The other design — 14 days from each case's start — needs Gauri's answer on which start date
     counts (retain date, Stage Start Date or case start); building it = a new branch in windowOf
     and nextWindow, then this constant. Any value not built throws, so a flipped switch can never
     quietly put every row under "No date". */
  var SPRINT_MODE = 'calendar-halves';
  var BUILT_MODES = ['calendar-halves'];
  if (BUILT_MODES.indexOf(SPRINT_MODE) < 0) throw new Error('clientMasterWindows: SPRINT_MODE "' + SPRINT_MODE + '" is not built');
  var SLIDE_DAYS = 15;          // how near (or how lately passed) a promise must be to show a flag
  var SLIDE_DOCS_BELOW = 50;    // Documents Uploaded % below this = "documents not yet in"
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var TYPE_REAL = 'Deadline', TYPE_IMAGINARY = 'Imaginary';   // the Deadline Type labels (deadlineService TYPE_REAL / TYPE_IMAGINARY)

  function s(v) { return String(v == null ? '' : v).trim(); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  /** 'YYYY-MM-DD' → [y, m, d] numbers, or null. */
  function parts(day) {
    var p = s(day).slice(0, 10).split('-');
    if (p.length !== 3 || p[0].length !== 4 || p[1].length !== 2 || p[2].length !== 2) return null;
    var y = Number(p[0]), m = Number(p[1]), d = Number(p[2]);
    if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    return [y, m, d];
  }
  function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  /** The Toronto calendar day for a time (ms or Date) — the same rule as the list engine's torontoToday. */
  function torontoToday(now) { return new Date(now == null ? Date.now() : now).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); }
  /** Whole days from a to b (both 'YYYY-MM-DD'); b later = positive. */
  function daysBetween(a, b) {
    var x = parts(a), y = parts(b);
    if (!x || !y) return null;
    return Math.round((Date.UTC(y[0], y[1] - 1, y[2]) - Date.UTC(x[0], x[1] - 1, x[2])) / 86400000);
  }
  function shortDay(day) { var p = parts(day); return p ? MONTHS[p[1] - 1] + ' ' + p[2] : ''; }
  function make(y, m, half) {
    var end = half === 1 ? 15 : lastDay(y, m);
    var mon = MONTHS[m - 1];
    return { key: y + '-' + pad(m) + '-' + half, label: mon + ' ' + (half === 1 ? '1–15' : '16–' + end),
      start: y + '-' + pad(m) + '-' + (half === 1 ? '01' : '16'), end: y + '-' + pad(m) + '-' + pad(end) };
  }
  /** The half-month a day falls in: { key: '2026-11-1', label: 'Nov 1–15', start, end } — end is the month's real last day. */
  function windowOf(day) {
    var p = parts(day);
    if (!p) return null;
    return make(p[0], p[1], p[2] <= 15 ? 1 : 2);
  }
  /** The half after a window (by its key, or the window itself): Dec 16–31 → Jan 1–15 of the next year. */
  function nextWindow(w) {
    var key = w && typeof w === 'object' ? w.key : s(w);
    var p = key.split('-');
    if (p.length !== 3) return null;
    var y = Number(p[0]), m = Number(p[1]), h = Number(p[2]);
    if (!(y > 1900 && m >= 1 && m <= 12 && (h === 1 || h === 2))) return null;
    if (h === 1) return make(y, m, 2);
    return m === 12 ? make(y + 1, 1, 1) : make(y, m + 1, 1);
  }
  /** 'real' | 'imaginary' | 'none' (Not recorded), from the Deadline Type text. */
  function typeOf(r) {
    var t = s(r && r.deadlineType);
    return t === TYPE_REAL ? 'real' : t === TYPE_IMAGINARY ? 'imaginary' : 'none';
  }
  /** The date a row is counted under ('' = no date). Never Hard / Soft / Prep Deadline. */
  function bucketDate(r) {
    var t = typeOf(r), a = parts(r && r.actualDeadline) ? s(r.actualDeadline).slice(0, 10) : '', p = parts(r && r.promisedDate) ? s(r.promisedDate).slice(0, 10) : '';
    if (t === 'imaginary') return p;
    return a;   // Real, and Not recorded with an Actual Deadline
  }
  /**
   * The windows box: this half-month and the next three, each split by type, then Later / Earlier dates / No date.
   * rows: the rows on screen. today: 'YYYY-MM-DD' (Toronto).
   */
  function windowsBox(rows, today) {
    var w = windowOf(today);
    if (!w) return null;
    var list = [w];
    while (list.length < 4) list.push(nextWindow(list[list.length - 1]));
    var box = list.map(function (x) { return { key: x.key, label: x.label, start: x.start, end: x.end, real: 0, imaginary: 0, none: 0, total: 0 }; });
    var later = 0, earlier = 0, noDate = 0;
    (rows || []).forEach(function (r) {
      var d = bucketDate(r);
      if (!d) { noDate++; return; }
      if (d < box[0].start) { earlier++; return; }
      if (d > box[box.length - 1].end) { later++; return; }
      for (var i = 0; i < box.length; i++) {
        if (d >= box[i].start && d <= box[i].end) { box[i][typeOf(r)]++; box[i].total++; return; }
      }
    });
    return { windows: box, later: later, earlier: earlier, noDate: noDate };
  }
  /**
   * The flag on a row, or null: { kind: 'slide', label: 'May slide → Dec 1–15', tip } or { kind: 'passed', label: 'Promise passed Nov 3', tip }.
   * Display only: nothing is written, moved or emailed.
   */
  function flagOf(r, today) {
    if (typeOf(r) !== 'imaginary') return null;                      // a Real deadline never slides
    var p = parts(r.promisedDate) ? s(r.promisedDate).slice(0, 10) : '';
    if (!p) return null;
    var pct = r.docUploadedPct;
    if (typeof pct !== 'number' || !isFinite(pct) || pct >= SLIDE_DOCS_BELOW) return null;   // blank % is not 0: never flags
    var days = daysBetween(today, p);
    if (days === null) return null;
    var base = 'Imaginary deadline, promised ' + shortDay(p) + ', documents ' + Math.round(pct) + '% in. Nothing has been changed';
    if (days >= 0 && days <= SLIDE_DAYS) {
      var nx = nextWindow(windowOf(p));
      return { kind: 'slide', label: 'May slide → ' + nx.label, tip: base + ' — moving it is your decision.' };
    }
    if (days < 0 && days >= -SLIDE_DAYS) return { kind: 'passed', label: 'Promise passed ' + shortDay(p), tip: base + '.' };
    return null;   // older promises (and ones further off) show nothing — old rows never nag
  }

  return { SPRINT_MODE: SPRINT_MODE, SLIDE_DAYS: SLIDE_DAYS, SLIDE_DOCS_BELOW: SLIDE_DOCS_BELOW, windowOf: windowOf, nextWindow: nextWindow,
    torontoToday: torontoToday, daysBetween: daysBetween, shortDay: shortDay, typeOf: typeOf, bucketDate: bucketDate, windowsBox: windowsBox, flagOf: flagOf };
}

module.exports = Object.assign({ clientMasterWindows: clientMasterWindows }, clientMasterWindows());
