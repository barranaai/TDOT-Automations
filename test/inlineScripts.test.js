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

// ─── lost-backslash guard (live bug 2026-08-15) ──────────────────────────────
// Inside a Node template literal, `\s` silently emits `s` — the co-signer
// email regex became /^[^s@]+@…/ and rejected every address containing an
// "s"; the month filter's \d{4}-\d{2} became unmatchable. vm-parsing can't
// catch this (the mangled regex is valid JS), so scan every emitted regex
// literal for the tell-tale mangled atoms.
function assertNoMangledRegexes(html, page) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    for (const rx of m[1].match(/\/(?:[^\/\\\n]|\\.)+\/[gimuy]*/g) || []) {
      assert.ok(!/\[\^s@\]|\[\^@s\]|\(d\{|[^\\]d\{\d|\[\^s\]/.test(rx),
        `${page}: regex literal looks like it lost a backslash in the template: ${rx}`);
    }
  }
}

test('emitted page scripts carry no backslash-mangled regex literals', () => {
  const consult = require('../src/routes/adminConsultation');
  assertNoMangledRegexes(consult.buildQueueHTML(), 'consultation queue');
  assertNoMangledRegexes(consult.buildDetailHTML('1'), 'consultation detail');
  const leads = require('../src/routes/adminLeads');
  assertNoMangledRegexes(leads.buildLeadsQueueHTML(), 'leads queue');
  assertNoMangledRegexes(leads.buildLeadDetailHTML('1'), 'lead detail');
  const { buildCockpitHTML } = require('../src/routes/adminCase');
  assertNoMangledRegexes(buildCockpitHTML('2026-XX-000'), 'cockpit');
  // the two repaired regexes, pinned exactly as EMITTED
  const detail = consult.buildDetailHTML('1');
  assert.ok(detail.includes('[^\\s@]+@[^\\s@]+\\.[^\\s@]+'), 'co-signer email regex emits with real \\s');
  const queue = consult.buildQueueHTML();
  assert.ok(queue.includes('(\\d{4}-\\d{2})'), 'month filter emits with real \\d');
});

// ─── questionnaire engines (coverage hole found 2026-08-21) ─────────────────
// buildFormPage/buildReviewFormPage were NEVER parsed here — a raw `\n`
// inside an alert string (single backslash in the template literal) shipped
// to production and killed the ENTIRE client questionnaire engine (no
// prefill, no save, no submit) while every HTTP probe still returned 200.
// Parse the emitted engine for EVERY form file, single- and multi-member,
// plus the staff review engine.

test('questionnaire client engine: emitted scripts parse for every form (single + multi-member)', () => {
  const fs   = require('node:fs');
  const path = require('node:path');
  const { FORMS_DIR } = require('../config/questionnaireFormMap');
  const svc  = require('../src/services/htmlQuestionnaireService');

  const forms = fs.readdirSync(FORMS_DIR).filter((f) => f.endsWith('.html'));
  assert.ok(forms.length >= 15, `expected the full form library, found ${forms.length}`);

  const members = [
    { key: 'primary', label: "O'Hara `x` \"q\"", type: 'Principal Applicant' },
    { key: 'member-2', label: 'Spouse </script>', type: 'Spouse' },
  ];
  for (const formFile of forms) {
    const single = svc.buildFormPage({ formFile, caseRef: '2026-XX-000', token: 'TDOT-x', formKey: 'primary', members: [] });
    assertScriptsParse(single, `client engine [${formFile}]`);
    assertNoMangledRegexes(single, `client engine [${formFile}]`);

    const multi = svc.buildFormPage({ formFile, caseRef: '2026-XX-000', token: 'TDOT-x', formKey: 'primary', members, allowedMemberTypes: ['Spouse', 'Dependent Child'] });
    assertScriptsParse(multi, `client engine multi [${formFile}]`);
  }
});

test('questionnaire review engine + overview: emitted scripts parse', () => {
  const fs   = require('node:fs');
  const { FORMS_DIR } = require('../config/questionnaireFormMap');
  const svc  = require('../src/services/htmlQuestionnaireService');
  const formFile = fs.readdirSync(FORMS_DIR).filter((f) => f.endsWith('.html'))[0];

  const savedFields = [{ section: 'S', label: "L `x` \"q\"\n", key: 'k', value: "v with 'quotes' and </script>" }];
  const review = svc.buildReviewFormPage({
    formFile, caseRef: '2026-XX-000', formKey: 'primary', staffName: "O'Brien",
    savedFields, savedFlags: { k: { note: 'fix </script>' } },
    members: [{ key: 'primary', label: 'PA', type: 'Principal Applicant', fields: savedFields, flags: {} }],
    formKeySuffix: '',
  });
  assertScriptsParse(review, 'review engine');
  assertNoMangledRegexes(review, 'review engine');

  const overview = svc.buildOverviewPage({
    caseRef: '2026-XX-000', token: 'TDOT-x',
    members: [{ key: 'primary', label: 'PA', type: 'Principal Applicant', status: 'In Progress', completionPct: 10 }],
    formFiles: { primary: formFile }, allowedMemberTypes: ['Spouse'],
  });
  assertScriptsParse(overview, 'overview page');
});

// ─── documentReviewFormService (coverage gap found 2026-08-21 staff review) ──
// The /d/:caseRef/review "Full review page" builder emits a client script from
// a template literal but was the only staff builder NOT parse-guarded here — a
// lost backslash or a </script> in a client-supplied filename/note could ship
// silently. Parse it with hostile item data.
test('documentReviewFormService buildReviewPage: emitted script parses, hostile item data stays inert', () => {
  const svc = require('../src/services/documentReviewFormService');
  const items = [{
    id: '1', name: 'Passport </script><img src=x onerror=alert(1)>',
    category: 'Identity', applicantType: 'Principal Applicant',
    applicantLabel: 'PA `x` "q" </script>', status: 'Received',
    reviewNotes: "rework: fix </script> and 'quote'", clientInstructions: '',
    clientReply: 'client said </script>', lastUpload: '2026-08-01',
  }];
  const html = svc.buildReviewPage({
    caseRef: '2026-XX-000', clientName: "O'Hara </script><script>alert(1)</script>",
    staffName: "O'Brien", items, folderLinks: { '1': 'https://x/</script>' },
  });
  assertScriptsParse(html, 'doc review page');
  assertNoMangledRegexes(html, 'doc review page');
  const scripts = html.match(/<script>[\s\S]*?<\/script>/g) || [];
  scripts.forEach((block, i) => {
    const inner = block.replace(/^<script>/, '').replace(/<\/script>$/, '');
    assert.ok(!/<\/script/i.test(inner), `doc review page: block ${i} — a </script> in client data must not terminate the script`);
  });
});
