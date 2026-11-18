'use strict';

// The reply-thread change (Faran 2026-11-18): clients reply to the app's email itself.
//  - every CLIENT email the app sends through microsoftMailService.sendEmail carries
//    Reply-To: info@tdotimm.com (a code constant — never the EMAIL_REPLY_TO env value);
//    staff-only alerts are untouched (no default Reply-To inside sendEmail);
//  - every client email shows one highlighted notice, in Faran's approved words (3 kinds);
//  - a CASE email's subject ends " — <case ref> · <exact Case Stage>" (Stuck / blank stage
//    left out; no ref → neither), the ref exactly once;
//  - the email reader files a reply on the case its subject names (test/emailLeads.test.js).

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const C = require('../src/utils/clientContact');
const { caseSubject, stripCaseRef, stageShown } = require('../src/utils/clientSubject');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─── caseSubject ─────────────────────────────────────────────────────────────

test('caseSubject: "<text> — <ref> · <exact Case Stage>"; the exact label is kept (never the portal\'s friendly name)', () => {
  assert.equal(caseSubject('Documents still needed', '2026-SPE-016', 'Document Collection Started'), 'Documents still needed — 2026-SPE-016 · Document Collection Started');
  assert.equal(caseSubject('Documents still needed', '2026-SPE-016', 'Internal Review'), 'Documents still needed — 2026-SPE-016 · Internal Review');
  assert.equal(caseSubject('X', '2026-CEC-EE-110', 'Profile Reviewed but not linked'), 'X — 2026-CEC-EE-110 · Profile Reviewed but not linked');
  assert.equal(caseSubject('X', ' 2026-SPE-016 ', '  Application Submitted  '), 'X — 2026-SPE-016 · Application Submitted', 'trimmed');
});

test('caseSubject: the stage is left out when it is Stuck (any case, trimmed) or blank', () => {
  for (const st of ['Stuck', 'stuck', ' STUCK ', '', '   ', null, undefined]) {
    assert.equal(caseSubject('Documents still needed', '2026-SPE-016', st), 'Documents still needed — 2026-SPE-016', JSON.stringify(st));
  }
  assert.equal(stageShown('Stuck'), false); assert.equal(stageShown(''), false); assert.equal(stageShown('Internal Review'), true);
  assert.equal(stageShown('Stuck in review'), true, 'only the exact "Stuck" label is hidden');
});

test('caseSubject: no case ref → no ref and no stage (a stage alone means nothing to the client)', () => {
  for (const ref of ['', '   ', null, undefined]) {
    assert.equal(caseSubject('Your TDOT Immigration payment receipt — Milestone 1', ref, 'Document Collection Started'), 'Your TDOT Immigration payment receipt — Milestone 1', JSON.stringify(ref));
  }
  assert.equal(caseSubject('Final reminder: by 1 Dec — ', '', 'Internal Review'), 'Final reminder: by 1 Dec', 'a blank {CaseRef} leaves no dangling dash');
});

test('caseSubject: a ref already in the base is taken out in every old style, then appended exactly once', () => {
  const R = '2026-SPE-016', S = 'Internal Review';
  const want = (t) => `${t} — ${R} · ${S}`;
  const cases = [
    ['Action Required — Your Super Visa Case Is Ready (2026-SPE-016)', 'Action Required — Your Super Visa Case Is Ready'],
    ['Action Required — Please Update Your Questionnaire (Spouse) (2026-SPE-016)', 'Action Required — Please Update Your Questionnaire (Spouse)'],
    ['Action Required: 3 items need your attention — Case 2026-SPE-016', 'Action Required: 3 items need your attention'],
    ['Important update regarding your case – 2026-SPE-016', 'Important update regarding your case'],
    ['Final Notice — Immediate action required — 2026-SPE-016', 'Final Notice — Immediate action required'],
    ['Information Still Needed for Your Case — 2026-SPE-016', 'Information Still Needed for Your Case'],
    ['Your Client Portal link — 2026-SPE-016', 'Your Client Portal link'],
    ['Reminder: documents for your Super Visa application — 2026-spe-016', 'Reminder: documents for your Super Visa application'],
    ['Second Reminder: Your case 2026-SPE-016 needs your attention', 'Second Reminder: Your case needs your attention'],
    ['Docs — Case ref: 2026-SPE-016', 'Docs'],
    ['Update [Case 2026-SPE-016]', 'Update'],
    ['2026-SPE-016 — Documents', 'Documents'],
    ['Case 2026-SPE-016: Documents', 'Documents'],
    ['A — 2026-SPE-016 — B', 'A — B'],
  ];
  for (const [base, text] of cases) assert.equal(caseSubject(base, R, S), want(text), base);
  // another case's ref (or a longer number) is not this case's ref — left alone
  assert.equal(caseSubject('About 2026-SPE-0160', R, S), want('About 2026-SPE-0160'));
  assert.equal(caseSubject('Showcase 2026-SPE-016', R, S), want('Showcase'), 'the "case" inside a word is not the Case label');
  assert.equal(stripCaseRef('Docs (2026-SPE-016)', ''), 'Docs (2026-SPE-016)', 'no ref given → nothing stripped');
  assert.equal(caseSubject('Line\r\nbreak', R, 'Internal\nReview'), 'Line break — 2026-SPE-016 · Internal Review', 'never a line break in a subject');
});

test('caseSubject: a "#", "ref" or "Ref:" label typed before the ref goes with it (staff-typed / board subjects)', () => {
  const R = '2026-SPE-016', S = 'Internal Review';
  const want = (t) => `${t} — ${R} · ${S}`;
  assert.equal(caseSubject('Documents for case #2026-SPE-016', R, S), want('Documents for case'));
  assert.equal(caseSubject('Your case (ref 2026-SPE-016)', R, S), want('Your case'));
  assert.equal(caseSubject('Docs (Ref: 2026-SPE-016)', R, S), want('Docs'));
  assert.equal(caseSubject('Docs (reference #2026-SPE-016)', R, S), want('Docs'));
  assert.equal(caseSubject('#2026-SPE-016 documents', R, S), want('documents'));
  assert.equal(caseSubject('Case #2026-SPE-016: docs', R, S), want('docs'));
  // "ref" inside a word is not a label
  assert.equal(caseSubject('Preferred 2026-SPE-016', R, S), want('Preferred'));
});

test('caseSubject: a subject already in the new format keeps one ref and one (current) stage', () => {
  const R = '2026-SPE-016';
  // pasted back with the same stage → unchanged
  assert.equal(caseSubject('Docs — 2026-spe-016 · Document Collection Started', R, 'Document Collection Started'), 'Docs — 2026-SPE-016 · Document Collection Started');
  // an old stage is replaced by the stage read now
  assert.equal(caseSubject('Docs — 2026-SPE-016 · Stuck', R, 'Internal Review'), 'Docs — 2026-SPE-016 · Internal Review');
  // now Stuck → the old stage goes and no stage is shown
  assert.equal(caseSubject('Docs — 2026-SPE-016 · Internal Review', R, 'Stuck'), 'Docs — 2026-SPE-016');
  // a "·" with no ref before it is ordinary subject text — kept
  assert.equal(caseSubject('Docs · Super Visa', R, 'Internal Review'), 'Docs · Super Visa — 2026-SPE-016 · Internal Review');
  // the whole subject round-trips
  const once = caseSubject('Documents still needed', R, 'Document Collection Started');
  assert.equal(caseSubject(once, R, 'Document Collection Started'), once);
});

test('escalation emails: the subject gets only the real case ref — never the name fallback (blank ref → base subject, no stage)', () => {
  const src = read('src/services/escalationRoutingService.js');
  assert.match(src, /const subjectRef = col\(CM\.caseRef\);/);
  assert.match(src, /caseSubject\('Important update regarding your case', subjectRef, stageNow\)/);
  assert.doesNotMatch(src, /caseSubject\([^)]*,\s*caseRef\s*,/, 'no subject built from the caseRef that falls back to the item name');
  // what a blank ref gives
  assert.equal(caseSubject('Important update regarding your case', '', 'Internal Review'), 'Important update regarding your case');
});

// ─── The notice ──────────────────────────────────────────────────────────────

test('the three notice texts are Faran\'s approved wording, verbatim; "Important:" is bold; one helper renders all three', () => {
  assert.equal(C.replyNoticeText('items'), 'Important: Please reply directly to this email rather than starting a new one, so that all correspondence stays on your file. Documents should be uploaded through your secure portal link, not sent as attachments. Not providing the items requested, or writing to us in a separate email, may delay your case.');
  assert.equal(C.replyNoticeText('case'), 'Important: If you need to contact us about this email, please reply directly to it rather than starting a new one, so that all correspondence stays on your file. Writing to us in a separate email may delay your case.');
  assert.equal(C.replyNoticeText('lead'), 'Important: If you need to contact us about this email, please reply directly to it rather than starting a new one, so that all correspondence stays on your file. Writing to us in a separate email may delay our response.');
  assert.deepEqual(C.NOTICE_KINDS, ['items', 'case', 'lead']);
  for (const kind of C.NOTICE_KINDS) {
    const html = C.replyNoticeHtml(kind);
    assert.ok(html.includes(`<strong>Important:</strong> ${C.NOTICE_TEXT[kind]}`), kind);
    assert.match(html, /^<table role="presentation"[^>]*>/, `${kind}: a block (a one-cell table — boxes render in Outlook and Gmail)`);
    assert.match(html, /<td bgcolor="#FFF7E0" style="background:#FFF7E0;border:1px solid #E8C96A;border-left:4px solid #C9A84C;/, `${kind}: highlighted with inline styles`);
    assert.doesNotMatch(html, /<p\b|<style|class=/, `${kind}: no paragraph, no stylesheet`);
    assert.equal(html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), C.replyNoticeText(kind));
  }
  assert.match(C.replyNoticeHtml('case', { margin: '16px 0 0' }), /margin:16px 0 0;/);
  assert.match(C.replyNoticeHtml('case', { margin: '0;color:red' }), /margin:20px 0 0;/, 'a bad margin falls back');
  assert.throws(() => C.replyNoticeHtml('other'), /Unknown reply-notice kind/);
  assert.throws(() => C.replyNoticeText(undefined), /Unknown reply-notice kind/);
  assert.equal(C.CLIENT_REPLY_TO, 'info@tdotimm.com');
});

// ─── Every client send site: Reply-To info@ ─────────────────────────────────

/** Every sendEmail( call in src (wrappers and the mail service itself left out), with its argument text. */
function sendSites() {
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) files.push(p); } })(path.join(ROOT, 'src'));
  const out = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel === 'src/services/microsoftMailService.js') continue;
    const src = fs.readFileSync(file, 'utf8');
    const re = /\bsendEmail\s*\(/g; let m;
    while ((m = re.exec(src))) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      if (/sendEmail\s*:\s*(async\s*)?\(/.test(line) || /function\s+sendEmail\s*\(/.test(line)) continue;   // an io wrapper / a local helper's definition
      let i = m.index + m[0].length, depth = 1;
      while (i < src.length && depth) { const c = src[i++]; if (c === '(') depth++; else if (c === ')') depth--; }
      out.push({ file: rel, line: src.slice(0, m.index).split('\n').length, args: src.slice(m.index + m[0].length, i - 1) });
    }
  }
  return out;
}

/** Staff-only senders (alerts to the team) — NOT client emails; exact counts, so a new client send in one of these files is caught. */
const STAFF_ONLY = {
  'src/routes/clientMailRoutes.js': 1,               // the mail-delivery test send (POST /api/test-email; was in server.js)
  'src/services/leadPriorityService.js': 1,          // critical-lead alert
  'src/services/caseTypeRegistryService.js': 1,      // case-type drift alert
  'src/services/consultantPortalService.js': 1,      // outcome-change notice to staff
  'src/services/documensoService.js': 1,             // "retainer signed" staff notice
  'src/services/stageGateService.js': 3,             // stage-gate team emails (its local sendEmail helper)
  'src/services/expiryRiskEngine.js': 1,             // expiry alerts to assigned users
};

test('every CLIENT send site passes replyTo: CLIENT_REPLY_TO (info@); the staff-only senders are an explicit list and are left as they were', () => {
  const sites = sendSites();
  const staff = {}, missing = [];
  for (const s of sites) {
    if (STAFF_ONLY[s.file]) { staff[s.file] = (staff[s.file] || 0) + 1; continue; }
    if (!/replyTo:\s*[^,}\n]*CLIENT_REPLY_TO\b/.test(s.args)) missing.push(`${s.file}:${s.line}`);
  }
  assert.deepEqual(missing, [], 'client send sites without replyTo: CLIENT_REPLY_TO');
  assert.deepEqual(staff, STAFF_ONLY, 'the staff-only senders (exact counts)');
  const client = sites.filter((s) => !STAFF_ONLY[s.file]);
  assert.equal(client.length, 28, `the client send sites (25 live + 3 retired): ${client.map((s) => `${s.file}:${s.line}`).join(', ')}`);
  // no default Reply-To inside sendEmail itself, and no client email reads EMAIL_REPLY_TO
  const mail = read('src/services/microsoftMailService.js');
  assert.doesNotMatch(mail, /CLIENT_REPLY_TO|info@tdotimm\.com/, 'sendEmail sets a Reply-To only when the caller passes one');
  for (const s of client) assert.doesNotMatch(s.args, /EMAIL_REPLY_TO/, `${s.file}:${s.line}`);
  // the old reply-to address is still skipped by the email reader (it is not a person)
  assert.match(read('src/services/emailLeadsService.js'), /process\.env\.EMAIL_REPLY_TO/);
});

// ─── Stage 1 (Faran 2026-11-19): every LIVE client send carries the case stamp ─

/** The 3 retired client senders (no live caller): Reply-To only, NO tag. Found by their own text, not line numbers. */
const RETIRED = [
  ['src/services/consultationService.js', /'Your TDOT Immigration consultation is booked'/],
  ['src/services/paymentService.js', /'Your TDOT Immigration retainer payment link'/],
  ['src/services/chasingLoopService.js', /^\{\s*to:\s+clientEmail,\s*subject,\s*html,\s*replyTo: CLIENT_REPLY_TO,\s*\}$/],   // its one send
];
const isRetired = (site) => RETIRED.some(([f, re]) => f === site.file && re.test(site.args));

/** The tag each live client send passes (design §1.5), per file in source order — the exact text. */
const TAGS = {
  'src/services/emailService.js': ["tag:     { caseRef: client.caseRef, caseItemId: itemId, kind: resend ? 'portal-link' : 'case-ready' }"],
  'src/services/sponsorOnboardingService.js': ["tag: { caseRef: cm.caseRef, caseItemId: cm.itemId, kind: 'sponsor' }"],
  'src/services/htmlQuestionnaireReviewService.js': ["tag:     { caseRef, caseItemId: itemId, kind: 'q-correction' }", "tag:     { caseRef, caseItemId: itemId, kind: 'q-correction' }"],
  'src/services/revisionNotificationService.js': ["tag:     { caseRef: client.caseRef || caseRef, caseItemId: client.itemId, kind: 'revision' }"],
  'src/services/missingFieldsEmailService.js': ["tag:     { caseRef, caseItemId: client.itemId, kind: 'missing-fields' }"],
  'src/services/docReminderService.js': ["tag: { caseRef: overview.caseRef, caseItemId: overview.itemId, kind: 'doc-reminder' }", "tag: { caseRef: row.ref, caseItemId: row.id, kind: 'doc-reminder-auto' }"],
  'src/services/escalationRoutingService.js': ["tag:     { caseRef: subjectRef, caseItemId: itemId, kind: 'escalation' }", "tag:     { caseRef: subjectRef, caseItemId: itemId, kind: 'final-notice' }"],
  'src/services/milestonePaymentService.js': ["tag: { leadId, caseRef: onCase.caseRef, caseItemId: onCase.caseItemId, kind: 'payment-request' }", "tag: { leadId: lead.id, caseRef: onCase.caseRef, caseItemId: onCase.caseItemId, kind: 'receipt' }"],
  'src/services/retainerCountersignService.js': ["tag: { leadId, caseRef: onCase.caseRef, caseItemId: onCase.caseItemId, kind: 'retainer-signed' }"],
  'src/services/intakeFormService.js': ["tag: { leadId, kind: 'intake-ack' }"],
  'src/services/consultationFormService.js': ["tag: { kind: 'consult-form' }"],
  'src/services/bookingService.js': ["tag: { leadId, kind: 'booking-invite' }"],
  'src/services/bookingRemindersService.js': ["tag: { leadId, kind: 'booking-reminder' }"],
  'src/services/webinarEmailService.js': ["tag: { leadId, kind: 'webinar' }"],
  'src/services/consultationService.js': ["tag: { leadId, kind: 'consult-links' }", "tag: { leadId, kind: 'consult-package' }", "tag: { leadId: lead.id, kind: 'consult-reminder' }", "tag: { leadId: lead.id, kind: 'preconsult-chase' }"],
  'src/services/consultAgreementService.js': ["tag: { leadId, kind: 'consult-agreement-signed' }", "tag: { leadId: lead.id, kind: 'consult-agreement' }"],
  'src/services/retainerService2.js': ["tag: { leadId, kind: 'retainer' }"],
};

test('Stage 1: every LIVE client send passes its case stamp (tag:) — exactly the design table; the 3 retired senders and the staff-only senders pass none', () => {
  const sites = sendSites();
  const live = sites.filter((s) => !STAFF_ONLY[s.file] && !isRetired(s));
  const retired = sites.filter(isRetired);
  assert.equal(retired.length, 3, 'the three retired senders are still found by their text');
  assert.equal(live.length, 25, `the live client sends: ${live.map((s) => `${s.file}:${s.line}`).join(', ')}`);
  const got = {};
  for (const s of live) {
    const m = s.args.match(/\btag:\s*\{[^}]*\}/g) || [];
    assert.equal(m.length, 1, `${s.file}:${s.line} passes exactly one tag`);
    (got[s.file] = got[s.file] || []).push(m[0]);
  }
  assert.deepEqual(got, TAGS);
  for (const s of retired) assert.doesNotMatch(s.args, /\btag:/, `${s.file}:${s.line} is retired — no stamp`);
  for (const s of sites.filter((x) => STAFF_ONLY[x.file] && x.file !== 'src/routes/clientMailRoutes.js')) assert.doesNotMatch(s.args, /\btag:|testClientFrom/, `${s.file}:${s.line} is a staff alert — no stamp, no copy`);
  // the test send: a tag ONLY under the explicit "client": true flag
  const t = sites.filter((x) => x.file === 'src/routes/clientMailRoutes.js');
  assert.equal(t.length, 1);
  assert.match(t[0].args, /\.\.\.\(client \? \{ replyTo: require\('\.\.\/utils\/clientContact'\)\.CLIENT_REPLY_TO, tag: \{ kind: 'test' \}, testClientFrom: clientBox \} : \{\}\)/);
  assert.match(read('src/routes/clientMailRoutes.js'), /const client = !!\(req\.body && req\.body\.client === true\);/);
  // every kind is a valid stamp value, and the io wrappers pass the message through untouched
  for (const k of Object.values(TAGS).flat().join(' ').match(/'[a-z0-9-]+'/g)) assert.match(k.slice(1, -1), /^[a-z0-9-]{1,40}$/);
  assert.match(read('src/services/bookingRemindersService.js'), /sendEmail: \(msg\) => require\('\.\/microsoftMailService'\)\.sendEmail\(msg\),/);
  assert.match(read('src/services/docReminderService.js'), /sendEmail: \(msg\) => require\('\.\/microsoftMailService'\)\.sendEmail\(msg\),/);
  assert.match(read('src/services/sponsorOnboardingService.js'), /sendEmail:\s+\(msg\) => mail\.sendEmail\(msg\),/);
  assert.match(read('src/services/webinarEmailService.js'), /sendEmail: \(m\) => require\('\.\/microsoftMailService'\)\.sendEmail\(m\),/);
  // the item ids come from reads the senders already do
  assert.match(read('src/services/revisionNotificationService.js'), /items \{\s*\n\s*id\s*\n\s*name/);
  assert.match(read('src/services/revisionNotificationService.js'), /itemId:\s+item\.id \? String\(item\.id\) : '',/);
  assert.match(read('src/services/missingFieldsEmailService.js'), /items \{\s*\n\s*id name/);
  assert.match(read('src/services/missingFieldsEmailService.js'), /itemId:\s+item\.id \? String\(item\.id\) : '',/);
  assert.match(read('src/services/intakeFormService.js'), /sendIntakeAcknowledgement\(\{ fullName, email: f\.email, leadId \}\)/);
  assert.match(read('src/services/intakeFormService.js'), /async function sendIntakeAcknowledgement\(\{ fullName, email, leadId \}\)/);
});

// ─── The case subjects at the send sites ─────────────────────────────────────

test('the case emails build their subject with caseSubject and the stage read at send time; lead emails keep their subjects', () => {
  const uses = {
    'src/services/emailService.js': /caseSubject\(resend[\s\S]{0,160}client\.caseRef, client\.caseStage\)/,
    'src/services/sponsorOnboardingService.js': /caseSubject\(resend[\s\S]{0,220}s\(caseRef\), s\(caseStage\)\)/,
    'src/services/htmlQuestionnaireReviewService.js': /caseSubject\('Action Required — Please Update Your Questionnaire', caseRef, caseStage\)/,
    'src/services/revisionNotificationService.js': /client\.caseRef \|\| caseRef, client\.caseStage\)/,
    'src/services/missingFieldsEmailService.js': /caseSubject\('Information Still Needed for Your Case', caseRef, client\.caseStage\)/,
    'src/services/docReminderService.js': /caseSubject\(fillTokens\(subject[\s\S]{0,200}caseRef, o\.caseStage\)/,
    'src/services/escalationRoutingService.js': /caseSubject\('Final Notice — Immediate action required', subjectRef, stageNow\)/,
    'src/services/milestonePaymentService.js': /leadCaseSubject\(lead, `Your TDOT Immigration payment receipt — \$\{p\.label\}`/,
    'src/services/retainerCountersignService.js': /leadCaseSubject\(fresh \|\| lead, 'Your fully signed TDOT Immigration retainer agreement'/,
  };
  for (const [f, re] of Object.entries(uses)) assert.match(read(f), re, f);
  // the stage column is read where it was not before (added to the EXISTING read — no new Monday call)
  assert.match(read('src/services/htmlQuestionnaireReviewService.js'), /"\$\{Q_COMPLETION_COL\}",\s*\n\s*"\$\{CM\.caseStage\}"/);
  assert.match(read('src/services/revisionNotificationService.js'), /"text_mm0x6haq",\s*\n\s*"color_mm0x8faa"/);
  assert.match(read('src/services/missingFieldsEmailService.js'), /\[CM_COLS\.clientEmail, CM_COLS\.accessToken, CM_COLS\.caseStage\]/);
  assert.match(read('src/services/emailService.js'), /caseStage:\s+col\(CM_COLS\.caseStage\)/);
  // escalation: the stage the board shows when the email goes (the rule's rewrite first)
  assert.match(read('src/services/escalationRoutingService.js'), /const stageNow = rule\.changeCaseStatus && rule\.changeCaseStatus !== 'No Change' \? rule\.changeCaseStatus : col\(CM\.caseStage\);/);
  // the lead-stage subjects are unchanged (no case yet)
  for (const [f, subj] of [
    ['src/services/intakeFormService.js', "subject: 'We received your inquiry — TDOT Immigration'"],
    ['src/services/bookingService.js', "subject: 'Book your consultation with TDOT Immigration'"],
    ['src/services/webinarEmailService.js', "const SUBJECT = 'Your invitation to the TDOT Immigration webinar'"],
    ['src/services/consultationService.js', "subject: 'Your TDOT Immigration consultation — details, form & agreement'"],
    ['src/services/retainerService2.js', "subject: 'Your TDOT Immigration retainer agreement'"],
  ]) assert.ok(read(f).includes(subj), f);
});

test('leadCaseSubject (case emails addressed through the lead): ref + stage from the case read now; no case, no row or a failed read → the plain subject, logged, never thrown', async () => {
  const cms = require('../src/services/clientMasterService');
  const mondayApi = require('../src/services/mondayApi');
  const keep = { q: mondayApi.query, warn: console.warn };
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    let asked = null;
    mondayApi.query = async (q, v) => { asked = v; return { items: [{ id: '55', name: 'Ana', column_values: [
      { id: 'text_mm142s49', text: '2026-SPE-016' }, { id: 'color_mm0x8faa', text: 'Pre-Onboarding' }, { id: 'text_mm0xw6bp', text: 'a@x.co' },
    ] }] }; };
    assert.equal(await cms.leadCaseSubject({ id: '9', clientMasterItemId: '55' }, 'Your TDOT Immigration payment receipt — Milestone 1'),
      'Your TDOT Immigration payment receipt — Milestone 1 — 2026-SPE-016 · Pre-Onboarding');
    assert.deepEqual(asked, { ids: ['55'] }, 'one item read by its id');
    mondayApi.query = async () => { throw new Error('Monday 500'); };
    assert.equal(await cms.leadCaseSubject({ id: '9', clientMasterItemId: '55' }, 'Receipt', '[Milestone]'), 'Receipt');
    assert.ok(warned.some((w) => /\[Milestone\] case 55 could not be read for lead 9 \(Monday 500\) — sent with the plain subject/.test(w)));
    mondayApi.query = async () => ({ items: [] });
    assert.equal(await cms.leadCaseSubject({ id: '9', clientMasterItemId: '55' }, 'Receipt'), 'Receipt');
    mondayApi.query = async () => { throw new Error('must not read'); };
    assert.equal(await cms.leadCaseSubject({ id: '9', clientMasterItemId: '' }, 'Receipt'), 'Receipt', 'no case yet: no read');
    assert.equal(await cms.leadCaseSubject(null, 'Receipt'), 'Receipt');
  } finally { mondayApi.query = keep.q; console.warn = keep.warn; }
});

test('leadCaseSubject `found` (Stage 1): the case id + ref from the SAME read, for the stamp; no case, no row or a failed read → left empty (stamped with the lead id only); one read either way', async () => {
  const cms = require('../src/services/clientMasterService');
  const mondayApi = require('../src/services/mondayApi');
  const keep = { q: mondayApi.query, warn: console.warn };
  console.warn = () => {};
  try {
    let reads = 0;
    mondayApi.query = async () => { reads++; return { items: [{ id: '55', name: 'Ana', column_values: [{ id: 'text_mm142s49', text: '2026-SPE-016' }, { id: 'color_mm0x8faa', text: 'Pre-Onboarding' }] }] }; };
    let found = {};
    assert.equal(await cms.leadCaseSubject({ id: '9', clientMasterItemId: '55' }, 'Receipt', '[Milestone]', found), 'Receipt — 2026-SPE-016 · Pre-Onboarding');
    assert.deepEqual(found, { caseItemId: '55', caseRef: '2026-SPE-016' });
    assert.equal(reads, 1, 'no second Monday read');
    for (const q of [async () => { throw new Error('Monday 500'); }, async () => ({ items: [] })]) {
      mondayApi.query = q; found = {};
      assert.equal(await cms.leadCaseSubject({ id: '9', clientMasterItemId: '55' }, 'Receipt', '[Milestone]', found), 'Receipt');
      assert.deepEqual(found, {});
    }
    found = {};
    await cms.leadCaseSubject({ id: '9', clientMasterItemId: '' }, 'Receipt', '[Milestone]', found);
    assert.deepEqual(found, {});
  } finally { mondayApi.query = keep.q; console.warn = keep.warn; }
});

test('the payment receipt goes even when the case read fails: plain subject, Reply-To info@, the "case" notice', async () => {
  const mps = require('../src/services/milestonePaymentService');
  const mail = require('../src/services/microsoftMailService');
  const mondayApi = require('../src/services/mondayApi');
  const keep = { send: mail.sendEmail, q: mondayApi.query, env: process.env.PAYMENT_RECEIPT_EMAILS, warn: console.warn };
  const sent = [];
  mail.sendEmail = async (m) => { sent.push(m); };
  mondayApi.query = async () => { throw new Error('Monday 500'); };
  console.warn = () => {};
  process.env.PAYMENT_RECEIPT_EMAILS = '1';
  try {
    const lead = { id: '9', email: 'ana@example.com', fullName: 'Ana Silva', clientMasterItemId: '55' };
    const p = { label: 'Milestone 1', amountCents: 10000, paidCents: 10000, totalCents: 10000, reference: 'R', paidAt: '2026-11-18', settled: true };
    assert.equal(await mps._emailReceipt(lead, p), true, 'a failed case read never blocks the receipt');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, 'Your TDOT Immigration payment receipt — Milestone 1');
    assert.equal(sent[0].replyTo, 'info@tdotimm.com');
    assert.deepEqual(sent[0].tag, { leadId: '9', caseRef: undefined, caseItemId: undefined, kind: 'receipt' }, 'a failed read: stamped with the lead id only');
    assert.ok(sent[0].html.includes(C.replyNoticeHtml('case', { margin: '16px 0 0' })));
    assert.doesNotMatch(sent[0].html, /don't reply|email us at/i);
    // with the case readable: the ref and the exact stage
    mondayApi.query = async () => ({ items: [{ id: '55', name: 'Ana', column_values: [{ id: 'text_mm142s49', text: '2026-SPE-016' }, { id: 'color_mm0x8faa', text: 'Document Collection Started' }] }] });
    await mps._emailReceipt(lead, p);
    assert.equal(sent[1].subject, 'Your TDOT Immigration payment receipt — Milestone 1 — 2026-SPE-016 · Document Collection Started');
    assert.deepEqual(sent[1].tag, { leadId: '9', caseRef: '2026-SPE-016', caseItemId: '55', kind: 'receipt' }, 'the same read gives the case stamp');
    const src = read('src/services/milestonePaymentService.js');
    assert.match(src, /replyNoticeHtml\('case', \{ margin: '16px 0 0' \}\)[\s\S]*replyNoticeHtml\('case', \{ margin: '16px 0 0' \}\)/, 'the e-transfer request and the receipt both carry the "case" notice');
    assert.match(src, /leadCaseSubject\(lead, `Your TDOT Immigration payment — \$\{row\.label\}`/, 'the e-transfer request too');
  } finally {
    mail.sendEmail = keep.send; mondayApi.query = keep.q; console.warn = keep.warn;
    if (keep.env === undefined) delete process.env.PAYMENT_RECEIPT_EMAILS; else process.env.PAYMENT_RECEIPT_EMAILS = keep.env;
  }
});

test('the old no-reply wording is gone from the doc-reminder rules and the Needs-attention to-do', () => {
  const tpl = require('../src/services/docReminderTemplates');
  assert.equal(tpl.tellsToReply, undefined);
  assert.doesNotMatch(read('src/services/docReminderService.js'), /REPLY_REFUSAL|tellsToReply/);
  assert.doesNotMatch(read('src/services/needsAttentionService.js'), /must not tell the client to reply/);
  // the other "bad text" reasons stay
  assert.match(tpl.validate({ subject: '', body: 'no list' }).problems[0], /has no \{MissingList\}/);
});
