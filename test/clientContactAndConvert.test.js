'use strict';

// Gauri's walkthrough (2026-10-08) — two quick fixes (Faran 2026-10-15):
//  1. (Superseded 2026-11-18 by the reply-thread change.) App emails used to say
//     "don't reply — this inbox isn't monitored". Now every client email carries
//     Reply-To: info@tdotimm.com and the highlighted notice asks the client to reply
//     to THIS email (src/utils/clientContact.js); no client email may still say
//     "don't reply" / "isn't monitored" / "not as a reply". The retainer email's
//     second step says "Reply to this email" with the signed copy.
//     The staff-name list says "Melanie", not "Melini".
//  2. "Convert to direct retainer": the lead being converted is never shown as a
//     duplicate of itself ("already exists — merge?"), and stays the one record.
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const SERVICES = path.join(__dirname, '..', 'src', 'services');


test('no client email still says "don\'t reply" / "isn\'t monitored" / "not as a reply"; the client emails use the shared reply notice; the contact is info@tdotimm.com', () => {
  const C = require('../src/utils/clientContact');
  assert.equal(C.CLIENT_CONTACT_EMAIL, 'info@tdotimm.com');
  assert.equal(C.CLIENT_REPLY_TO, 'info@tdotimm.com');
  assert.equal(C.EMAIL_US, 'email us at <a href="mailto:info@tdotimm.com" style="color:inherit">info@tdotimm.com</a>');   // pages only (the client portal)
  assert.equal(C.NO_REPLY, undefined, 'the old "don\'t reply" sentence is gone');
  const offenders = [];
  for (const f of fs.readdirSync(SERVICES).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(SERVICES, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;                                   // comments
      if (/don'?t reply|do not reply to|isn'?t monitored|is not monitored|not monitored|not as a reply|NO_REPLY/i.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], 'every "don\'t reply" line was replaced by the reply notice');
  // every file that sends a client email shows the shared notice (as a template expression)
  for (const f of ['intakeFormService', 'paymentService', 'sponsorOnboardingService', 'consultationFormService', 'retainerCountersignService', 'bookingService',
    'htmlQuestionnaireReviewService', 'emailService', 'consultAgreementService', 'milestonePaymentService', 'chasingLoopService', 'escalationRoutingService',
    'revisionNotificationService', 'missingFieldsEmailService', 'consultationService', 'retainerService2', 'webinarEmailService',
    'docReminderService']) {   // the document reminders: the notice is added outside the template
    const src = fs.readFileSync(path.join(SERVICES, `${f}.js`), 'utf8');
    assert.match(src, /replyNoticeHtml\((?:'(?:items|case|lead)'|resend \? 'case' : 'items')/, f);
  }
  // the retainer email: the signed copy comes back as a reply
  const r2 = fs.readFileSync(path.join(SERVICES, 'retainerService2.js'), 'utf8');
  assert.match(r2, /<b>2\. Reply to this email<\/b> with the signed agreement attached\./);
  assert.doesNotMatch(r2, /Email the signed copy to us/);
});

test('the booking invite email (the one Gauri read out) ends with its own line and the lead notice', () => {
  const src = fs.readFileSync(path.join(SERVICES, 'bookingService.js'), 'utf8');
  const line = src.split('\n').find((l) => /This link is personal to you/.test(l));
  const html = new Function('BRAND', 'require', `return \`${line.trim()}\`;`)({ mutedOnLight: '#6B7280' }, (p) => require(path.join(SERVICES, p)));
  assert.equal(html.replace(/<[^>]+>/g, ''), "This link is personal to you — please don't share it.");
  assert.match(src, /This link is personal to you — please don't share it\.<\/p>\n\s*\$\{require\('\.\.\/utils\/clientContact'\)\.replyNoticeHtml\('lead'/);
});

test('the staff-name list says Melanie (was the "Melini" typo)', () => {
  const src = fs.readFileSync(require.resolve('../config/portalStaff'), 'utf8');   // moved there 2026-10-15 (Add-lead group)
  assert.match(src, /process\.env\.PORTAL_STAFF \|\| 'Gauri,Kamal,Asmita,Prajawal,Melanie,Deeksha,Arpit,Monica,Anna'/);
  assert.ok(!/Melini/.test(src));
});

/** Run the page's own dcRenderMatches against a tiny fake DOM. */
function renderer(convertLeadId) {
  const html = require('../src/routes/adminConsultation').buildRetainersHTML();   // the pop-up is on the Retainers page (2026-11-05)
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
  const fn = js.slice(js.indexOf('function dcRenderMatches(m){'), js.indexOf('/* ── "New application" prefill'));
  const els = { 'dc-matches': { style: {}, innerHTML: '' }, 'dc-profile': { style: {}, innerHTML: 'converting…' } };
  const ctx = new Function('dcEl', 'escHtml', 'init', `var DC_MATCHES=null, DC_CONVERT_LEAD_ID=init; ${fn}; return { render: dcRenderMatches, state: function(){ return { DC_MATCHES: DC_MATCHES, DC_CONVERT_LEAD_ID: DC_CONVERT_LEAD_ID }; } };`)(
    (id) => els[id], (s) => String(s == null ? '' : s), convertLeadId);
  return { ...ctx, els };
}
const SELF = { id: '13300000001', name: 'Asha Client', email: 'a@x.co', sourceChannel: 'Phone' };

test('converting a lead: the lead itself is NOT a duplicate — no "already exists, merge?" panel, the link to this lead stays', () => {
  const r = renderer('13300000001');
  r.render({ leads: [SELF], cases: [], clients: [{ name: 'Asha Client', reasons: ['email'] }] });
  assert.equal(r.els['dc-matches'].style.display, 'none');
  assert.deepEqual(r.state(), { DC_MATCHES: null, DC_CONVERT_LEAD_ID: '13300000001' }, 'still linked; no choice asked');
  assert.equal(r.els['dc-profile'].innerHTML, 'converting…', 'the "converting lead" banner stays');
});

test('converting a lead: another lead or an open case for the same email is shown as a NOTE; the conversion still links this lead', () => {
  const r = renderer('13300000001');
  r.render({ leads: [SELF, { id: '13300000099', name: 'Asha Client', email: 'a@x.co', sourceChannel: 'Website' }], cases: [{ caseRef: '2026-SV-050', name: 'Asha Client', caseStage: 'Document Collection Started' }], clients: [] });
  const box = r.els['dc-matches'];
  assert.equal(box.style.display, 'block');
  assert.match(box.innerHTML, /This email\/phone also appears below — check it is not the same matter\. The conversion keeps lead 13300000001 as the one record\./);
  assert.match(box.innerHTML, /Open case: <a href="\/admin\/case\/2026-SV-050"/);
  assert.match(box.innerHTML, /Another lead: Asha Client/);
  assert.ok(!/dcm-choice|Create a new client anyway/.test(box.innerHTML), 'no radio — nothing to choose, no way to mint a duplicate');
  assert.ok(!/13300000001<\/b>|Link to existing lead/.test(box.innerHTML));
  assert.deepEqual(r.state(), { DC_MATCHES: null, DC_CONVERT_LEAD_ID: '13300000001' });
});

test('not converting (a new walk-in): the duplicate panel and its choice work exactly as before', () => {
  const r = renderer(null);
  r.render({ leads: [SELF], cases: [], clients: [] });
  assert.equal(r.els['dc-matches'].style.display, 'block');
  assert.match(r.els['dc-matches'].innerHTML, /already exists in the system — choose how to proceed/);
  assert.match(r.els['dc-matches'].innerHTML, /value="link:13300000001"/);
  assert.match(r.els['dc-matches'].innerHTML, /Create a new client anyway/);
  assert.ok(r.state().DC_MATCHES);
});
