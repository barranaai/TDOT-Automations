'use strict';

// One-time PDF regeneration from the JSON truth files (layout refresh
// 2026-09-02). Admin-driven, dry-run by default; the ONLY write is the PDF
// overwrite. Per-form submission status: exact audit comment → batch comment /
// manifest stamp (single-slot cases only) → draft; the Q Completion "Done"
// column alone is never evidence. Ambiguity never resolves to "submitted".

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const CASE = '2026-ISS-009';
const F = (formKey) => `questionnaire-${CASE}-${formKey}.json`;
const P = (formKey) => `questionnaire-${CASE}-${formKey}.pdf`;
const OLD = '2026-07-01T10:00:00.000Z';
const NOW = Date.parse('2026-09-02T12:00:00.000Z');

function harness({ files, store, manifest, modified = {} }) {
  const uploads = [];
  const fake = {
    listFiles: async () => files.map((name) => ({ name, size: 10, lastModifiedDateTime: modified[name] || OLD })),
    readFile:  async ({ filename }) => {
      if (filename === `questionnaire-members-${CASE}.json`) return manifest ? Buffer.from(typeof manifest === 'string' ? manifest : JSON.stringify(manifest)) : null;
      return store[filename] != null ? Buffer.from(typeof store[filename] === 'string' ? store[filename] : JSON.stringify(store[filename])) : null;
    },
    uploadFile: async (p) => { uploads.push(p); },
  };
  const odPath = require.resolve('../src/services/oneDriveService');
  require.cache[odPath] = { id: odPath, filename: odPath, loaded: true, exports: fake };
  const svcPath = require.resolve('../src/services/questionnairePdfService');
  delete require.cache[svcPath];
  const svc = require(svcPath);
  return { svc, uploads, fake };
}

const answered = (n, extra = {}) => ({ fields: [{ section: 'A › B', label: 'Q', key: 'k', value: `v${n}` }, { section: 'A › B', label: 'Empty', key: 'e', value: '' }], completionPct: 42, savedAt: OLD, formFile: '3. Express Entry - Questionnaire.html', ...extra });
const run = (svc, extra = {}) => svc.regenerateCasePdfs({ clientName: 'Harini Sankar', caseRef: CASE, now: NOW, ...extra });
const byKey = (out) => Object.fromEntries(out.forms.map((f) => [f.formKey, f]));

test('selects only this case\'s form JSONs; skips unanswered / prefill-only / invalid; refresh-existing-only by default; dry-run writes nothing but still BUILDS the PDF', async () => {
  const { svc, uploads } = harness({
    files: [F('primary'), P('primary'), F('primary-flags'), F('spouse-1'), P('spouse-1'), `questionnaire-members-${CASE}.json`, 'email-throttle.json',
            'questionnaire-2026-ISS-0091-primary.json', F('child-1'), P('child-1'), F('child-2'), P('child-2'), F('child-3')],
    store: {
      [F('primary')]:  answered(1),
      [F('spouse-1')]: { fields: [{ section: 'A', label: 'Q', key: 'k', value: '  ' }] },
      [F('child-1')]:  '{not json',
      [F('child-2')]:  { fields: [{ section: 'A', label: 'Q', key: 'prefill__q', value: 'seeded', source: 'prefill' }, { section: 'A', label: 'R', key: 'r', value: 'x', source: 'prefill' }] },
      [F('child-3')]:  answered(3),
    },
    manifest: null,
  });
  const out = await run(svc, { qCompletionStatus: 'Working on it' });
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.forms.map((f) => f.formKey), ['primary', 'spouse-1', 'child-1', 'child-2', 'child-3']);
  const k = byKey(out);
  assert.equal(k.primary.action, 'would-regenerate');
  assert.ok(k.primary.bytes > 1000, 'dry-run builds the PDF so render errors surface');
  assert.equal(k.primary.hadPdf, true);
  assert.equal(k.primary.answered, 1);
  assert.equal(k.primary.formLabel, 'Express Entry', 'label from the recorded formFile');
  assert.equal(k.primary.memberLabel, 'Primary Applicant');
  assert.equal(k.primary.submitted, false); assert.equal(k.primary.submittedVia, 'none');
  assert.equal(k['spouse-1'].reason, 'no-answers');
  assert.equal(k['child-1'].reason, 'invalid-json');
  assert.equal(k['child-2'].reason, 'prefill-only', 'prefill-seeded values are not client answers');
  assert.equal(k['child-3'].reason, 'no-existing-pdf', 'refresh existing PDFs only unless createMissing');
  assert.equal(uploads.length, 0, 'dry-run must not write');

  const created = await run(svc, { qCompletionStatus: '', createMissing: true });
  assert.equal(byKey(created)['child-3'].action, 'would-regenerate');
});

test('decideSubmission matrix: exact comment wins; batch/manifest only for single-slot cases; Done only with no manifest + no Updates; ambiguity is never "submitted"', () => {
  const { svc } = harness({ files: [], store: {}, manifest: null });
  const member = { key: 'spouse-1', label: 'Spouse — Karthik', submittedAt: '2026-08-10T12:00:00.000Z' };
  const ev = svc.parseSubmissionUpdates([
    { body: '📋 Questionnaire Submitted\n\nForm: "Spousal"\nMember: Spouse — Karthik\nCase: X\nCompletion: 90%\nSubmitted: t (Toronto)\n\n🔍 Staff Review Link:\nhttps://app.tdotimm.com/q/2026-ISS-009/review?formKey=spouse-1', createdAt: '2026-08-10T12:01:00.000Z' },
    { body: '📋 Questionnaire Submitted (2 members)\n\nForm: "Spousal"\nCase: X\n\nMembers submitted:\n  • Primary Applicant: 85%\n  • Child — Aanya: 80%\n\nAggregate Q readiness: 82% (2 of 2 members)\nSubmitted: t (Toronto)\n\n🔍 Staff Review Link:\nhttps://app.tdotimm.com/q/2026-ISS-009/review?formKey=primary', createdAt: '2026-08-11T09:00:00.000Z' },
    { body: 'Retainer signed', createdAt: '2026-08-01T00:00:00.000Z' },
  ]);
  assert.deepEqual([...ev.exact.entries()], [['spouse-1', '2026-08-10T12:01:00.000Z']]);
  assert.deepEqual(ev.batches, [{ labels: ['Primary Applicant', 'Child — Aanya'], createdAt: '2026-08-11T09:00:00.000Z' }]);
  assert.equal(ev.count, 2);

  const d = (o) => svc.decideSubmission({ manifestExists: true, hasAdditionalSlot: false, evidence: ev, caseDone: false, savedAt: OLD, ...o });
  // 1. exact per-form comment → submitted with the comment's timestamp, even with an additional slot
  assert.deepEqual(d({ formKey: 'spouse-1', memberKey: 'spouse-1', member, hasAdditionalSlot: true }), { submitted: true, via: 'update-exact', submittedAt: '2026-08-10T12:01:00.000Z' });
  // 2. batch comment naming the member → submitted only when the case has ONE form slot
  assert.equal(d({ formKey: 'primary', memberKey: 'primary', member: { key: 'primary', label: 'Primary Applicant' } }).via, 'update-batch');
  assert.deepEqual(d({ formKey: 'primary', memberKey: 'primary', member: { key: 'primary', label: 'Primary Applicant' }, hasAdditionalSlot: true }), { submitted: false, via: 'ambiguous-batch', uncertain: true });
  // 3. the -additional slot of a member with only an exact comment for the primary slot → not submitted (manifest stamp is per member → ambiguous)
  assert.deepEqual(d({ formKey: 'spouse-1-additional', memberKey: 'spouse-1', member, hasAdditionalSlot: true }), { submitted: false, via: 'ambiguous-manifest', uncertain: true });
  // 4. manifest stamp, no comments at all, single slot → submitted via manifest
  assert.deepEqual(d({ formKey: 'spouse-1', memberKey: 'spouse-1', member, evidence: svc.parseSubmissionUpdates([]) }), { submitted: true, via: 'manifest', submittedAt: '2026-08-10T12:00:00.000Z' });
  // 5. Done column alone is never evidence for a form: with a manifest the unstamped member is a draft; without one → uncertain
  assert.deepEqual(d({ formKey: 'primary', memberKey: 'primary', member: null, manifestExists: false, evidence: null, caseDone: true }), { submitted: false, via: 'ambiguous-done', uncertain: true });
  assert.deepEqual(d({ formKey: 'primary', memberKey: 'primary', member: null, manifestExists: false, evidence: svc.parseSubmissionUpdates([]), caseDone: true }), { submitted: false, via: 'ambiguous-done', uncertain: true });
  assert.equal(d({ formKey: 'primary', memberKey: 'primary', member: { key: 'primary', label: 'Primary Applicant' }, manifestExists: true, evidence: null, caseDone: true }).via, 'draft-despite-done', 'a manifest member without a stamp stays a draft even when the column says Done');
  // comment parsing is anchored on the audit prefix — a staff note mentioning "questionnaire submitted" with a review link is not evidence
  const note = svc.parseSubmissionUpdates([{ body: 'FYI client says questionnaire submitted yesterday, see https://app.tdotimm.com/q/2026-ISS-009/review?formKey=primary', createdAt: 't' }, { body: '  📋 Questionnaire Submitted\n\nForm: "X"\n…/review?formKey=child-1', createdAt: 't2' }]);
  assert.deepEqual([...note.exact.keys()], ['child-1']); assert.equal(note.count, 1);
  // 6. nothing → draft
  assert.deepEqual(d({ formKey: 'child-1', memberKey: 'child-1', member: { key: 'child-1', label: 'Child' }, evidence: null }), { submitted: false, via: 'none' });
  // legacy bare "additional" key normalises to the primary member's additional slot
  assert.deepEqual(svc.splitFormKey('additional'), { formKey: 'primary-additional', memberKey: 'primary', isAdditional: true });
  assert.deepEqual(svc.splitFormKey('spouse-1'), { formKey: 'spouse-1', memberKey: 'spouse-1', isAdditional: false });
});

test('case run: statuses/labels per form; uncertain + orphan + recently-saved forms are skipped, never written', async () => {
  const manifest = { members: [
    { key: 'primary',  label: 'Primary Applicant', submittedAt: '2026-08-10T12:00:00.000Z' },
    { key: 'spouse-1', label: 'Spouse — Karthik' },
  ] };
  const { svc, uploads } = harness({
    files: [F('primary'), P('primary'), F('additional'), P('additional'), F('spouse-1'), P('spouse-1'), F('child-9'), P('child-9'), F('spouse-1-additional'), P('spouse-1-additional')],
    store: { [F('primary')]: answered(1), [F('additional')]: answered(2, { formFile: '' }), [F('spouse-1')]: answered(3), [F('child-9')]: answered(4), [F('spouse-1-additional')]: answered(5, { savedAt: '2026-09-02T11:50:00.000Z' }) },
    manifest,
  });
  const updates = [{ body: '📋 Questionnaire Submitted\n… Staff Review Link:\nhttps://app.tdotimm.com/q/2026-ISS-009/review?formKey=primary', createdAt: '2026-08-10T12:00:30.000Z' }];
  const out = await run(svc, { formFiles: { primary: '1. Spousal - Questionnaire.html', additional: '2. Sponsor Details - Questionnaire - August 2026.html' }, qCompletionStatus: 'Done', updates, dryRun: false });
  assert.equal(out.dryRun, false); assert.equal(out.manifestExists, true); assert.equal(out.hasAdditionalSlot, true);
  assert.deepEqual(out.evidence, { exact: ['primary'], batches: 0, comments: 1 });
  const k = byKey(out);
  assert.equal(k.primary.action, 'regenerated'); assert.equal(k.primary.submitted, true); assert.equal(k.primary.submittedVia, 'update-exact');
  // legacy bare "additional": primary member's additional slot — label from the case's additional file, status ambiguous (stamp is per member) → skipped
  assert.equal(k.additional.memberLabel, 'Primary Applicant');
  assert.equal(k.additional.formLabel, 'Sponsor Details', 'strips the "- Questionnaire - Month Year.html" tail');
  assert.equal(k.additional.action, 'skipped'); assert.equal(k.additional.reason, 'status-uncertain'); assert.equal(k.additional.submittedVia, 'ambiguous-manifest');
  // spouse without a stamp, case column Done → still a DRAFT (Done never overrides an existing manifest)
  assert.equal(k['spouse-1'].action, 'regenerated'); assert.equal(k['spouse-1'].submitted, false); assert.equal(k['spouse-1'].submittedVia, 'draft-despite-done');
  assert.equal(k['spouse-1'].memberLabel, 'Spouse — Karthik');
  assert.equal(k['child-9'].reason, 'orphan-member', 'a member missing from an existing manifest is not rendered');
  assert.equal(k['spouse-1-additional'].reason, 'recently-saved', 'a form saved minutes ago may have a live client on it');
  assert.deepEqual(uploads.map((u) => u.filename), [P('primary'), P('spouse-1')], 'only the two decided forms were written');
  for (const u of uploads) {
    assert.equal(u.category, 'Questionnaire'); assert.equal(u.mimeType, 'application/pdf');
    assert.equal(u.buffer.slice(0, 4).toString(), '%PDF'); assert.equal(u.caseRef, CASE);
  }
});

test('slot count also comes from disk; edited-after-submission, legacy-key collisions, truncated feeds and caller skip-keys are skipped, never written', async () => {
  // (a) manifest stamp + primary.json + primary-additional.json, but the CURRENT form map has no additional slot → both ambiguous
  let h = harness({
    files: [F('primary'), P('primary'), F('primary-additional'), P('primary-additional')],
    store: { [F('primary')]: answered(1), [F('primary-additional')]: answered(2) },
    manifest: { members: [{ key: 'primary', label: 'Primary Applicant', submittedAt: '2026-08-10T12:00:00.000Z' }] },
  });
  let out = await run(h.svc, { formFiles: { primary: '20. Workforce Priority Stream - Questionnaire.html' }, updates: [], dryRun: false });
  assert.equal(out.hasAdditionalSlot, true); assert.equal(out.hasAdditionalSlotSource, 'disk');
  assert.ok(out.forms.every((f) => f.reason === 'status-uncertain' && f.submittedVia === 'ambiguous-manifest'), JSON.stringify(out.forms));
  assert.equal(h.uploads.length, 0);

  // (b) exact comment, but the JSON was saved well AFTER the submission → skipped (the live path labels such saves "In progress")
  h = harness({ files: [F('primary'), P('primary')], store: { [F('primary')]: answered(1, { savedAt: '2026-08-20T09:00:00.000Z' }) }, manifest: { members: [{ key: 'primary', label: 'Primary Applicant', submittedAt: '2026-08-10T12:00:00.000Z' }] } });
  out = await run(h.svc, { updates: [{ body: '📋 Questionnaire Submitted …/review?formKey=primary', createdAt: '2026-08-10T12:00:30.000Z' }], dryRun: false });
  assert.equal(out.forms[0].reason, 'edited-after-submission'); assert.equal(out.forms[0].editedAt, '2026-08-20T09:00:00.000Z'); assert.equal(h.uploads.length, 0);
  // …but a save seconds before the comment (the submit's own save) is fine
  h = harness({ files: [F('primary'), P('primary')], store: { [F('primary')]: answered(1, { savedAt: '2026-08-10T12:00:10.000Z' }) }, manifest: { members: [{ key: 'primary', label: 'Primary Applicant', submittedAt: '2026-08-10T12:00:00.000Z' }] } });
  out = await run(h.svc, { updates: [{ body: '📋 Questionnaire Submitted …/review?formKey=primary', createdAt: '2026-08-10T12:00:30.000Z' }], dryRun: false });
  assert.equal(out.forms[0].action, 'regenerated'); assert.equal(out.forms[0].submitted, true);

  // (c) legacy "additional" AND "primary-additional" both on disk → one comment cannot tell them apart
  h = harness({ files: [F('additional'), P('additional'), F('primary-additional'), P('primary-additional')], store: { [F('additional')]: answered(1), [F('primary-additional')]: answered(2) }, manifest: null });
  out = await run(h.svc, { updates: [{ body: '📋 Questionnaire Submitted …/review?formKey=additional', createdAt: 't' }] });
  assert.ok(out.forms.every((f) => f.reason === 'status-uncertain' && f.submittedVia === 'ambiguous-legacy-key'));

  // (d) the Updates feed was cut at the fetch limit and nothing else vouches for the form → uncertain
  h = harness({ files: [F('primary'), P('primary')], store: { [F('primary')]: answered(1) }, manifest: { members: [{ key: 'primary', label: 'Primary Applicant' }] } });
  out = await run(h.svc, { updates: [], updatesTruncated: true });
  assert.equal(out.forms[0].reason, 'status-uncertain'); assert.equal(out.forms[0].submittedVia, 'updates-truncated'); assert.equal(out.updatesTruncated, true);

  // (e) skipKeys: forms already regenerated by an earlier attempt are not touched again
  h = harness({ files: [F('primary'), P('primary'), F('spouse-1'), P('spouse-1')], store: { [F('primary')]: answered(1), [F('spouse-1')]: answered(2) }, manifest: { members: [{ key: 'primary', label: 'Primary Applicant' }, { key: 'spouse-1', label: 'Spouse' }] } });
  out = await run(h.svc, { updates: [], skipKeys: ['primary'], dryRun: false });
  assert.equal(byKey(out).primary.reason, 'skipped-by-caller'); assert.equal(byKey(out)['spouse-1'].action, 'regenerated');
  assert.deepEqual(h.uploads.map((u) => u.filename), [P('spouse-1')]);
});

test('per-form failures are recorded and the case continues; corrupt manifest aborts the case before any write; transient listing failure propagates', async () => {
  const { svc, uploads, fake } = harness({
    files: [F('primary'), P('primary'), F('spouse-1'), P('spouse-1')],
    store: { [F('primary')]: answered(1), [F('spouse-1')]: answered(2) },
    manifest: { members: [{ key: 'primary', label: 'Primary Applicant' }, { key: 'spouse-1', label: 'Spouse' }] },
  });
  let n = 0;
  fake.uploadFile = async (p) => { n++; if (n === 1) { const e = new Error('OneDrive upload failed: 503'); e.transient = true; throw e; } uploads.push(p); };
  const out = await run(svc, { dryRun: false });
  const k = byKey(out);
  assert.equal(k.primary.action, 'failed'); assert.equal(k.primary.transient, true);
  assert.equal(k['spouse-1'].action, 'regenerated');
  assert.equal(out.failed, 1); assert.equal(out.transientFailures, 1);
  assert.deepEqual(uploads.map((u) => u.filename), [P('spouse-1')]);

  const corrupt = harness({ files: [F('primary'), P('primary')], store: { [F('primary')]: answered(1) }, manifest: '{broken' });
  await assert.rejects(() => run(corrupt.svc, { dryRun: false }), /manifest .* not valid JSON/);
  assert.equal(corrupt.uploads.length, 0);

  const down = harness({ files: [], store: {}, manifest: null });
  down.fake.listFiles = async () => { const e = new Error('OneDrive list failed: 503'); e.transient = true; throw e; };
  await assert.rejects(() => run(down.svc), (e) => e.transient === true);
});

test('endpoint + listFiles + driver pins', () => {
  const server = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');
  const i = server.indexOf("app.post('/admin/questionnaire/:caseRef/regenerate-pdfs'");
  assert.ok(i !== -1, 'route exists');
  const block = server.slice(i, server.indexOf('app.post(', i + 10));
  assert.match(block, /resolveAdminOrReject\(req, res\)/, 'admin-only');
  assert.match(block, /dryRun: dryRun !== false/, 'dry-run unless explicitly false');
  assert.match(block, /createMissing: createMissing === true/);
  assert.match(block, /skipFormVersioning: true/, 'no era-resolver reads');
  assert.match(block, /transientFailures\) return res\.status\(503\)\.json\(\{ \.\.\.result/, 'partial transient failure → 503 with the per-form results');
  assert.doesNotMatch(block, /saveFormData|saveMembers|change_multiple_column_values|loadMembers/, 'never writes JSON / manifest / Monday, never seeds a manifest');

  const od = fs.readFileSync(require.resolve('../src/services/oneDriveService.js'), 'utf8');
  const j = od.indexOf('async function listFiles(');
  const lf = od.slice(j, od.indexOf('\n}\n', j));
  assert.match(lf, /status === 404\) return \[\]/, 'absent folder → []');
  assert.match(lf, /@odata\.nextLink/, 'pages');
  assert.match(lf, /if \(it\.file\)/, 'files only');
  assert.match(od, /readFile, listFiles,/, 'exported');

  const drv = fs.readFileSync(require.resolve('../scripts/regenerate-questionnaire-pdfs.js'), 'utf8');
  assert.match(drv, /dryRun: !WRITE/, 'driver dry-runs unless --write');
  assert.match(drv, /res\.status === 401 \|\| res\.status === 403/, 'aborts on auth failure');
  assert.match(drv, /consecutiveFailures >= 5/, 'aborts on a systemic failure run');
  assert.match(drv, /rows\.length > 1/, 'duplicated case refs are skipped');
  assert.match(drv, /text_body/, 'reads plain-text Update bodies for the submission evidence');
  assert.match(drv, /skipKeys: \[\.\.\.done\.keys\(\)\]/, 'retries pass the already-regenerated forms as skipKeys');
  assert.match(drv, /err\.name === 'TimeoutError'/, 'a client-side timeout is not retried (the server may still be running)');
  assert.match(drv, /regen-report-/, 'a report file is always written');
  assert.match(drv, /parseMiss/, 'parse-health counter');
  assert.match(drv, /updatesTruncated: rawUpdates\.length >= UPDATES_LIMIT/, 'flags a cut Updates feed');
  assert.doesNotMatch(drv, /mutation/, 'driver never mutates Monday');
});
