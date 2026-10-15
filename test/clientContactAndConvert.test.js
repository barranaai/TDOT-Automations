'use strict';

// Gauri's walkthrough (2026-10-08) — two quick fixes (Faran 2026-10-15):
//  1. App emails come from a no-reply mailbox, so none may say "just reply":
//     every client email points at info@tdotimm.com and says replies aren't read.
//     The retainer email's "reply with the signed copy" now says where to send it.
//     The staff-name list says "Melanie", not "Melini".
//  2. "Convert to direct retainer": the lead being converted is never shown as a
//     duplicate of itself ("already exists — merge?"), and stays the one record.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const SERVICES = path.join(__dirname, '..', 'src', 'services');

test('no client email or page tells the client to reply (the sender is a no-reply mailbox); the contact line is info@tdotimm.com', () => {
  const { CLIENT_CONTACT_EMAIL, EMAIL_US, NO_REPLY } = require('../src/utils/clientContact');
  assert.equal(CLIENT_CONTACT_EMAIL, 'info@tdotimm.com');
  assert.equal(EMAIL_US, 'email us at <a href="mailto:info@tdotimm.com" style="color:inherit">info@tdotimm.com</a>');
  assert.equal(NO_REPLY, "Please don't reply to this email — this inbox isn't monitored.");
  const offenders = [];
  for (const f of fs.readdirSync(SERVICES).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(SERVICES, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;                                   // comments
      if (/just reply|simply reply|reply to this email|reply to the email|reply with it attached/i.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], 'every "reply" line was replaced');
  // the files that carried one now use the shared line, as a real template expression
  for (const f of ['intakeFormService', 'paymentService', 'sponsorOnboardingService', 'consultationFormService', 'retainerCountersignService', 'bookingService',
    'htmlQuestionnaireReviewService', 'emailService', 'consultAgreementService', 'milestonePaymentService', 'chasingLoopService', 'escalationRoutingService',
    'revisionNotificationService', 'missingFieldsEmailService', 'consultationService', 'retainerService2', 'clientPortalService']) {
    const src = fs.readFileSync(path.join(SERVICES, `${f}.js`), 'utf8');
    assert.match(src, /\$\{require\('\.\.\/utils\/clientContact'\)\.(EMAIL_US|CLIENT_CONTACT_EMAIL)\}/, f);
  }
  // the retainer email: where the signed copy goes
  const r2 = fs.readFileSync(path.join(SERVICES, 'retainerService2.js'), 'utf8');
  assert.match(r2, /<b>2\. Email the signed copy to us<\/b> at <a href="mailto:\$\{require\('\.\.\/utils\/clientContact'\)\.CLIENT_CONTACT_EMAIL\}">/);
});

test('the booking invite email (the one Gauri read out) renders the new line, not "just reply"', () => {
  const src = fs.readFileSync(path.join(SERVICES, 'bookingService.js'), 'utf8');
  const line = src.split('\n').find((l) => /This link is personal to you/.test(l));
  const html = new Function('BRAND', 'require', `return \`${line.trim()}\`;`)({ mutedOnLight: '#6B7280' }, (p) => require(path.join(SERVICES, p)));
  assert.equal(html.replace(/<[^>]+>/g, ''), "This link is personal to you — please don't share it. Questions? Please email us at info@tdotimm.com. Please don't reply to this email — this inbox isn't monitored.");
});

test('the staff-name list says Melanie (was the "Melini" typo)', () => {
  const src = fs.readFileSync(require.resolve('../config/portalStaff'), 'utf8');   // moved there 2026-10-15 (Add-lead group)
  assert.match(src, /process\.env\.PORTAL_STAFF \|\| 'Gauri,Kamal,Asmita,Prajwal,Melanie,Diksha'/);
  assert.ok(!/Melini/.test(src));
});

/** Run the page's own dcRenderMatches against a tiny fake DOM. */
function renderer(convertLeadId) {
  const html = require('../src/routes/adminConsultation').buildQueueHTML();
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
