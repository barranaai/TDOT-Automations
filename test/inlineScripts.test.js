'use strict';

/**
 * Inline-script regression guard — the repo's documented outage class.
 *
 * Admin/client pages emit their client JS from Node template literals.
 * `node --check` can NOT see that JS (it's a string), and a stray `\n`
 * inside a quoted string becomes a REAL newline in the emitted script —
 * a SyntaxError that kills the whole page's JS (live outage 2026-06-30:
 * "Loading consultation…" forever).
 *
 * This test extracts every emitted <script> block from every exported page
 * builder and vm-parses it, so a template-literal slip breaks the suite
 * instead of production.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('node:vm');

function assertScriptsParse(html, page, { min = 1 } = {}) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html))) {
    n++;
    try {
      new vm.Script(m[1]);
    } catch (err) {
      assert.fail(`${page}: emitted <script> #${n} does not parse — ${err.message}`);
    }
  }
  assert.ok(n >= min, `${page}: expected at least ${min} <script> block(s), found ${n}`);
}

test('adminCase buildCockpitHTML: emitted scripts parse (incl. hostile caseRef staying inert)', () => {
  const { buildCockpitHTML } = require('../src/routes/adminCase');
  assertScriptsParse(buildCockpitHTML('2026-XX-000'), 'cockpit');
  // The XSS regression: a </script> in caseRef must NOT terminate the block.
  const hostile = buildCockpitHTML('</script><img src=x onerror=alert(1)>');
  assertScriptsParse(hostile, 'cockpit(hostile)');
  assert.ok(!hostile.includes('<img src=x'), 'hostile caseRef never lands raw in the HTML');
});

test('adminLeads queue + detail: emitted scripts parse', () => {
  const { buildLeadsQueueHTML, buildLeadDetailHTML } = require('../src/routes/adminLeads');
  assertScriptsParse(buildLeadsQueueHTML(), 'leads queue');
  assertScriptsParse(buildLeadDetailHTML('12345'), 'lead detail');
});

test('adminConsultation queue + detail: emitted scripts parse', () => {
  const { buildQueueHTML, buildDetailHTML } = require('../src/routes/adminConsultation');
  assertScriptsParse(buildQueueHTML(), 'consultation queue');
  assertScriptsParse(buildDetailHTML('12345'), 'consultation detail');
});

test('clientPortalService buildPortalPage: the upload script parses, hostile values stay inert', () => {
  const { buildPortalPage, clientStage } = require('../src/services/clientPortalService');
  const snap = {
    clientName: 'X</script><script>alert(1)</script>', caseRef: 'R</script>', caseType: 'T', caseSubType: null,
    caseStage: 'Document Collection Started', accessToken: 't</script>',
    qReadinessPct: 10, docCounts: { total: 1, received: 0, reviewed: 0, rework: 0, missing: 1 },
    docItems: [{ id: '1', name: 'Doc `with` "quotes"\n and newline', status: 'Missing', category: 'C', applicantType: 'Principal Applicant', reviewNotes: '', clientInstructions: '', lastUpload: '' }],
    totalMembers: 1, submittedMembers: 0, journey: clientStage('Document Collection Started'),
    timeline: [], payments: null,
  };
  const html = buildPortalPage(snap);
  assertScriptsParse(html, 'client portal');
  const scripts = html.match(/<script>[\s\S]*?<\/script>/g) || [];
  assert.equal(scripts.length, 1, 'hostile </script> in embedded values must not split the script block');
});
