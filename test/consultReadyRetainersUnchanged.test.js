'use strict';

// The Consultations "Ready" column (2026-11-20) and the red "Not paid" mark share code with the Retainers & follow-ups
// page (the pills, the list CSS, the board answer). The promise: the Retainers page does not change at all, and the
// row data sent to the browser gains only the one word `ready` on a Consultations row.
// Checked against a FROZEN COPY made from commit 4e4a63e — the code live before the change
// (test/fixtures/consult-ready-frozen-4e4a63e.json: made-up people; what the table drew and what the board answered).

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');

const FX     = require('./fixtures/consult-ready-frozen-4e4a63e.json');
const snap   = require('../src/services/leadSnapshot');
const portal = require('../src/services/consultantPortalService');
const { WORDS } = require('../src/utils/consultReady');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }
const firstScript = (html) => html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
function pickFn(js, name) { const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let depth = 0, j = js.indexOf('{', i); for (; j < js.length; j++) { if (js[j] === '{') depth++; else if (js[j] === '}' && --depth === 0) break; } return js.slice(i, j + 1); }

/* The Retainers table, drawn by the page's own emitted code (today is 2026-11-20). */
function retainersTable(html, rows) {
  const js = firstScript(html), tb = { innerHTML: '' };
  const ctx = { document: { getElementById: (id) => (id === 'rbody' ? tb : null) }, bindRowClicks() {}, RETAINERS: rows, RET_APART: ['Retained'], TDOT_DEL_SVG: '<svg/>', Intl };
  vm.createContext(ctx);
  vm.runInContext(js.match(/var PAID_LABELS=\{[^}]*\};/)[0] + '\n' + ['escHtml', 'qpill', 'paidPill', 'outcomeCell', 'dParts', 'retCase', 'renderRetainerList'].map((n) => pickFn(js, n)).join('\n') + "\nfunction todayStr(){ return '2026-11-20'; }", ctx);
  const out = ctx.renderRetainerList(rows, 'data', { sel: {} }, { without: () => rows.length });
  return { html: tb.innerHTML, out: JSON.parse(JSON.stringify(out)) };
}
const rowsOf = (tbody) => tbody.split('</tr>').filter(Boolean).map((tr) => tr.split('<td').slice(1).map((c) => '<td' + c));

test('Retainers & follow-ups page: the table is exactly as before — the same header, the same cells for the same rows (frozen at 4e4a63e)', () => {
  const html = require('../src/routes/adminConsultation').buildRetainersHTML();
  // the header the page starts with, and the one the engine draws from the columns
  assert.equal(html.match(/<thead><tr id="rq-headrow">[\s\S]*?<\/tr><\/thead>/)[0], FX.retHead);
  assert.equal(FX.retHead, '<thead><tr id="rq-headrow"><th>Client</th><th>Case type</th><th>Consultant</th><th>Outcome</th><th>Consult fee</th><th>Retainer fee</th><th>Sent</th><th>Signed</th><th>Paid</th><th>Stage</th><th>Case</th><th></th></tr></thead>');
  // the rows: every cell of every row, as the page's own code draws it today
  const now = retainersTable(html, JSON.parse(JSON.stringify(FX.retRows)));
  const got = rowsOf(now.html), want = rowsOf(FX.retTable);
  assert.equal(got.length, 7);
  got.forEach((cells, i) => { assert.equal(cells.length, 12, 'twelve cells'); assert.deepEqual(cells, want[i], 'row ' + FX.retRows[i].id); });
  assert.equal(now.html, FX.retTable, 'the whole table body, character for character');
  assert.deepEqual(now.out, FX.retOut);
  // the Consult fee cell (the fifth): the consultation's own paid pill — and never the Consultations page's red "Not paid"
  assert.deepEqual(got.map((cells) => cells[4].replace(/<[^>]+>/g, '')), ['Paid (app) $226', '—', 'n/a', 'Cash $200', 'Waived', 'Invoice $300', 'Paid in Square $300']);
  assert.ok(!now.html.includes('Not paid') && !now.html.includes('pill red" title'), 'no red "Not paid" on this page — an unpaid consultation is a grey dash here, a direct retainer client "n/a"');
  // the code the two pages share (the pills) and this page's own list code: the same text as before
  const js = firstScript(html);
  for (const name of Object.keys(FX.fn)) assert.equal(pickFn(js, name), FX.fn[name], name + ' is unchanged');
  assert.ok(js.includes('function paidPill(c){'));
  // nothing of the Ready column or the red mark is on this page
  for (const gone of ['readyPill', 'c-ready', 'Not sent yet', 'Missing both', 'Missing agreement', 'Missing form', 'Not asked', 'Consultation over', "label: 'Ready'", 'th:nth-child(7)', 'th:nth-child(12)', 'th:nth-child(13)', 'colspan="13"', 'No payment is recorded', 'cq-table', 'consultOnChange', 'rowHtml'])
    assert.ok(!html.includes(gone), 'not on the Retainers page: ' + gone);
  for (const s of ['colspan="12"', '.tbl-wrap table { min-width:1000px; }', "RETAINERS=(d.retainers||[]).concat(d.retained||[]);"]) assert.ok(html.includes(s), s);
  // the Consultations page still has the shared pills word for word (paidPill and outcomeCell are not touched)
  const q = firstScript(require('../src/routes/adminConsultation').buildQueueHTML());
  for (const name of ['escHtml', 'qpill', 'paidPill', 'outcomeCell']) assert.equal(pickFn(q, name), FX.fn[name], 'Consultations page, shared: ' + name);
  // its columns: the same twelve, none hidden or added
  const S = require('../src/routes/listSpecs');
  assert.deepEqual(S.retainerListOpts({ outcomes: require('../config/outcomes').OUTCOME_LABELS }).cols.map((c) => c.label), ['Client', 'Case type', 'Consultant', 'Outcome', 'Consult fee', 'Retainer fee', 'Sent', 'Signed', 'Paid', 'Stage', 'Case', '']);
});

test('the board answer (/api/consultations-board): a Consultations row gains only the one word "ready"; Retainers and Retained rows are exactly as before (frozen at 4e4a63e)', async () => {
  snap._reset();
  const dash = require('../src/services/dashboardService');
  const restore = [stub(snap.io, 'fetchLeads', async () => JSON.parse(JSON.stringify(FX.leads))), stub(dash, 'fetchAllItems', async () => [])];
  try {
    const now = new Date('2026-11-20T17:00:00Z');
    const answers = { plain: await portal.getConsultationsBoard({ now }), ret: await portal.getConsultationsBoard({ now, withRetained: true }), done: await portal.getConsultationsBoard({ now, withCompleted: true }) };
    let consultRows = 0, otherRows = 0;
    for (const which of ['plain', 'ret', 'done']) {
      const got = JSON.parse(JSON.stringify(answers[which])), was = FX.board[which];   // as the browser receives it
      delete got.at; delete got.ageMs;
      assert.deepEqual(Object.keys(got), Object.keys(was), which + ': the same parts');
      // the Retainers page's rows (retainers + retained): not one key more, not one value different
      assert.deepEqual(got.retainers, was.retainers, which + ': retainers');
      assert.deepEqual(got.retained, was.retained, which + ': retained');
      otherRows += got.retainers.length + (got.retained || []).length;
      for (const r of got.retainers.concat(got.retained || [])) assert.equal('ready' in r, false);
      // the Consultations page's rows (upcoming + completed): the old row, plus `ready`
      for (const list of ['consultations', 'completed']) {
        assert.deepEqual((got[list] || []).map((r) => r.id), (was[list] || []).map((r) => r.id), which + ': the same rows in the same order — ' + list);
        (got[list] || []).forEach((row, i) => {
          const { ready, ...rest } = row;
          assert.deepEqual(rest, was[list][i], which + ' ' + list + ' ' + row.id + ': everything else as before');
          assert.deepEqual(Object.keys(row).filter((k) => !(k in was[list][i])), ['ready'], 'one new key');
          assert.ok(typeof ready === 'string' && WORDS.includes(ready), 'one fixed word: ' + ready);
          consultRows++;
        });
      }
      assert.deepEqual([got.stale, got.casesKnown], [was.stale, was.casesKnown]);
    }
    assert.deepEqual([consultRows, otherRows], [21, 13], 'every kind of row was compared');
    // the words on these rows: signed + form in (1); sent only (2); booked by hand (3, 4); a fee record that says "No" (5);
    // a direct consultation without the tick (6); completed rows carry a word too — the page shows a dash for them (7, 8, 11)
    const word = Object.fromEntries(answers.done.consultations.concat(answers.done.completed).map((r) => [r.id, r.ready]));
    assert.deepEqual(word, { 1: 'ready', 2: 'both', 3: 'notsent', 4: 'notsent', 5: 'notasked', 6: 'notasked', 7: 'notsent', 8: 'notsent', 11: 'notsent' });
    assert.ok(!JSON.stringify(answers).includes('example.test') && !JSON.stringify(answers).includes('555-0142'), 'a list, not a record: no email, no phone');
    assert.ok(!JSON.stringify(answers).includes('has them already') && !JSON.stringify(answers).includes('packageNote'), 'the staff reason on the fee record does not ride along');
  } finally { restore.forEach((r) => r()); snap._reset(); }
});
