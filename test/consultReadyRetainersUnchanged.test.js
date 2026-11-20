'use strict';

// The Consultations "Ready" column (2026-11-20) and the red "Not paid" mark share code with the Retainers & follow-ups
// page (the pills, the list CSS, the board answer). The promise: the Retainers page does not change at all, and the
// row data sent to the browser gains only the one word `ready` on a Consultations row.
// Checked against a FROZEN COPY made from commit 4e4a63e — the code live before the change
// (test/fixtures/consult-ready-frozen-4e4a63e.json: made-up people; what the table drew and what the board answered).
//
// ONE later change, asked for (Gauri B3, Faran's decision 1, 2026-11-20): a WAIVED fee's reason is seen in the hover
// text of the "Waived" pill on both lists. So, and only so: the shared paidPill adds the reason to a waived pill's
// hover text, and a waived row carries one more word, `paidNote`. The frozen copy is not edited — the difference is
// spelled out below and everything else is still compared character for character.
const WAIVED_TITLE_WAS = 'title="Waived · recorded by Staff Two on 2026-10-30"';
const WAIVED_TITLE_NOW = 'title="Waived · recorded by Staff Two on 2026-10-30 · no reason recorded"';
const PILL_RETURN_WAS = `  return '<span class="pill '+(c.paid==='waived'?'grey':'green')+'" title="'+escHtml(label+who)+'">'+escHtml(label+amt)+'</span>';`;
const PILL_RETURN_NOW = `  /* Waived: the hover text also says why (a waiver made before 2026-11-20 may have no reason). */
  var why=c.paid==='waived'?(c.paidNote?(' · reason: '+c.paidNote):' · no reason recorded'):'';
  return '<span class="pill '+(c.paid==='waived'?'grey':'green')+'" title="'+escHtml(label+who+why)+'">'+escHtml(label+amt)+'</span>';`;

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

test('Retainers & follow-ups page: the table is as before — the same header, the same cells for the same rows (frozen at 4e4a63e) — but for the Waived pill\'s hover text, which now ends with the reason', () => {
  const html = require('../src/routes/adminConsultation').buildRetainersHTML();
  // the header the page starts with, and the one the engine draws from the columns
  assert.equal(html.match(/<thead><tr id="rq-headrow">[\s\S]*?<\/tr><\/thead>/)[0], FX.retHead);
  assert.equal(FX.retHead, '<thead><tr id="rq-headrow"><th>Client</th><th>Case type</th><th>Consultant</th><th>Outcome</th><th>Consult fee</th><th>Retainer fee</th><th>Sent</th><th>Signed</th><th>Paid</th><th>Stage</th><th>Case</th><th></th></tr></thead>');
  // the rows: every cell of every row, as the page's own code draws it today
  const now = retainersTable(html, JSON.parse(JSON.stringify(FX.retRows)));
  // the one difference: the waived row's hover text (the frozen rows carry no reason — they are older waivers)
  assert.equal(FX.retTable.split(WAIVED_TITLE_WAS).length - 1, 1, 'one waived row in the frozen table');
  const wantTable = FX.retTable.replace(WAIVED_TITLE_WAS, WAIVED_TITLE_NOW);
  const got = rowsOf(now.html), want = rowsOf(wantTable), was = rowsOf(FX.retTable);
  assert.equal(got.length, 7);
  got.forEach((cells, i) => { assert.equal(cells.length, 12, 'twelve cells'); assert.deepEqual(cells, want[i], 'row ' + FX.retRows[i].id); });
  assert.equal(now.html, wantTable, 'the whole table body, character for character');
  const changed = []; got.forEach((cells, i) => cells.forEach((c, j) => { if (c !== was[i][j]) changed.push([FX.retRows[i].id, j]); }));
  assert.deepEqual(changed, [['35', 4]], 'against the frozen table exactly one cell differs: the waived row\'s Consult fee');
  assert.equal(got[4][4].replace(/<[^>]+>/g, ''), 'Waived', 'and what the cell SHOWS is the same word');
  // with a reason on the row, the hover text says it (escaped); no other row reads paidNote
  const withWhy = retainersTable(html, JSON.parse(JSON.stringify(FX.retRows)).map((r) => ({ ...r, paidNote: 'family of a "client" <b>' })));
  assert.equal(rowsOf(withWhy.html)[4][4], '<td><span class="pill grey" title="Waived · recorded by Staff Two on 2026-10-30 · reason: family of a &quot;client&quot; &lt;b&gt;">Waived</span></td>');
  rowsOf(withWhy.html).forEach((cells, i) => { if (i !== 4) assert.deepEqual(cells, was[i], 'a row that is not waived never shows a reason: ' + FX.retRows[i].id); });
  assert.deepEqual(now.out, FX.retOut);
  // the Consult fee cell (the fifth): the consultation's own paid pill — and never the Consultations page's red "Not paid"
  assert.deepEqual(got.map((cells) => cells[4].replace(/<[^>]+>/g, '')), ['Paid (app) $226', '—', 'n/a', 'Cash $200', 'Waived', 'Invoice $300', 'Paid in Square $300']);
  assert.ok(!now.html.includes('Not paid') && !now.html.includes('pill red" title'), 'no red "Not paid" on this page — an unpaid consultation is a grey dash here, a direct retainer client "n/a"');
  // the code the two pages share (the pills) and this page's own list code: the same text as before
  const js = firstScript(html);
  assert.ok(FX.fn.paidPill.includes(PILL_RETURN_WAS));
  const fnNow = { ...FX.fn, paidPill: FX.fn.paidPill.replace(PILL_RETURN_WAS, PILL_RETURN_NOW) };   // the frozen pill + the reason in a waived pill's hover text
  for (const name of Object.keys(FX.fn)) assert.equal(pickFn(js, name), fnNow[name], name + (name === 'paidPill' ? ' changed only in the waived hover text' : ' is unchanged'));
  assert.ok(js.includes('function paidPill(c){'));
  // nothing of the Ready column or the red mark is on this page
  for (const gone of ['readyPill', 'c-ready', 'Not sent yet', 'Missing both', 'Missing agreement', 'Missing form', 'Not asked', 'Consultation over', "label: 'Ready'", 'th:nth-child(7)', 'th:nth-child(12)', 'th:nth-child(13)', 'colspan="13"', 'No payment is recorded', 'cq-table', 'consultOnChange', 'rowHtml'])
    assert.ok(!html.includes(gone), 'not on the Retainers page: ' + gone);
  for (const s of ['colspan="12"', '.tbl-wrap table { min-width:1000px; }', "RETAINERS=(d.retainers||[]).concat(d.retained||[]);"]) assert.ok(html.includes(s), s);
  // the Consultations page has the same shared pills word for word (one paidPill for both lists)
  const q = firstScript(require('../src/routes/adminConsultation').buildQueueHTML());
  for (const name of ['escHtml', 'qpill', 'paidPill', 'outcomeCell']) assert.equal(pickFn(q, name), fnNow[name], 'Consultations page, shared: ' + name);
  // its columns: the same twelve, none hidden or added
  const S = require('../src/routes/listSpecs');
  assert.deepEqual(S.retainerListOpts({ outcomes: require('../config/outcomes').OUTCOME_LABELS }).cols.map((c) => c.label), ['Client', 'Case type', 'Consultant', 'Outcome', 'Consult fee', 'Retainer fee', 'Sent', 'Signed', 'Paid', 'Stage', 'Case', '']);
});

test('the board answer (/api/consultations-board): a Consultations row gains only the one word "ready"; Retainers and Retained rows are exactly as before (frozen at 4e4a63e) — but a WAIVED row, on either list, also carries its reason (paidNote)', async () => {
  snap._reset();
  const dash = require('../src/services/dashboardService');
  const restore = [stub(snap.io, 'fetchLeads', async () => JSON.parse(JSON.stringify(FX.leads))), stub(dash, 'fetchAllItems', async () => [])];
  try {
    const now = new Date('2026-11-20T17:00:00Z');
    const answers = { plain: await portal.getConsultationsBoard({ now }), ret: await portal.getConsultationsBoard({ now, withRetained: true }), done: await portal.getConsultationsBoard({ now, withCompleted: true }) };
    let consultRows = 0, otherRows = 0, waivedRows = 0;
    // a waived row carries its reason for the pill's hover text ('' here: the frozen waiver is an older one with none)
    const withReason = (r) => (r.paid === 'waived' ? { ...r, paidNote: '' } : r);
    for (const which of ['plain', 'ret', 'done']) {
      const got = JSON.parse(JSON.stringify(answers[which])), was = FX.board[which];   // as the browser receives it
      delete got.at; delete got.ageMs;
      assert.deepEqual(Object.keys(got), Object.keys(was), which + ': the same parts');
      // the Retainers page's rows (retainers + retained): not one key more, not one value different
      assert.deepEqual(got.retainers, was.retainers.map(withReason), which + ': retainers');
      assert.deepEqual(got.retained, was.retained && was.retained.map(withReason), which + ': retained');
      otherRows += got.retainers.length + (got.retained || []).length;
      for (const r of got.retainers.concat(got.retained || [])) {
        assert.equal('ready' in r, false);
        assert.equal('paidNote' in r, r.paid === 'waived', 'the reason rides on a waived row only: ' + r.id);
        if (r.paid === 'waived') waivedRows++;
      }
      // the Consultations page's rows (upcoming + completed): the old row, plus `ready`
      for (const list of ['consultations', 'completed']) {
        assert.deepEqual((got[list] || []).map((r) => r.id), (was[list] || []).map((r) => r.id), which + ': the same rows in the same order — ' + list);
        (got[list] || []).forEach((row, i) => {
          const { ready, ...rest } = row;
          assert.deepEqual(rest, withReason(was[list][i]), which + ' ' + list + ' ' + row.id + ': everything else as before');
          assert.deepEqual(Object.keys(row).filter((k) => !(k in was[list][i])).sort(), row.paid === 'waived' ? ['paidNote', 'ready'] : ['ready'], 'one new key — two on a waived row');
          if (row.paid === 'waived') waivedRows++;
          assert.ok(typeof ready === 'string' && WORDS.includes(ready), 'one fixed word: ' + ready);
          consultRows++;
        });
      }
      assert.deepEqual([got.stale, got.casesKnown], [was.stale, was.casesKnown]);
    }
    assert.deepEqual([consultRows, otherRows], [21, 13], 'every kind of row was compared');
    assert.equal(waivedRows, 4, 'the waived row was met on both lists (lead 8: three times under Retainers, once under Completed)');
    // the words on these rows: signed + form in (1); sent only (2); booked by hand (3, 4); a fee record that says "No" (5);
    // a direct consultation without the tick (6); completed rows carry a word too — the page shows a dash for them (7, 8, 11)
    const word = Object.fromEntries(answers.done.consultations.concat(answers.done.completed).map((r) => [r.id, r.ready]));
    assert.deepEqual(word, { 1: 'ready', 2: 'both', 3: 'notsent', 4: 'notsent', 5: 'notasked', 6: 'notasked', 7: 'notsent', 8: 'notsent', 11: 'notsent' });
    assert.ok(!JSON.stringify(answers).includes('example.test') && !JSON.stringify(answers).includes('555-0142'), 'a list, not a record: no email, no phone');
    assert.ok(!JSON.stringify(answers).includes('has them already') && !JSON.stringify(answers).includes('packageNote'), 'the staff reason on the fee record does not ride along');
  } finally { restore.forEach((r) => r()); snap._reset(); }
});
