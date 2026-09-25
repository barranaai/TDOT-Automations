'use strict';

// Sponsor onboarding — the email the sponsor reads on a phone: exact subjects,
// the SAME portal link the client got, the schema's document list, the one
// questionnaire sentence that applies, no token printed, no pronoun, and
// every value escaped.

const test   = require('node:test');
const assert = require('node:assert/strict');

const S         = require('../src/services/sponsorOnboardingService');
const mondayApi = require('../src/services/mondayApi');
const mail      = require('../src/services/microsoftMailService');
const emailSvc  = require('../src/services/emailService');
const reg       = require('../src/services/caseSchemaService');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const SOWP_DOCS = reg.lookup('SOWP', 'Outland (Spouse or Child)').roles.find((r) => r.role === 'Sponsor').documents
  .filter((d) => !d.includeWhen).map((d) => ({ name: d.name, category: d.category || 'Other' }));

const base = (over = {}) => ({
  variant: 'onboarding', sponsorName: 'Faheem Khan', clientName: 'Aisha Khan', caseRef: '2026-SOWP-017', caseType: 'SOWP',
  roleLabel: 'Worker Spouse', docs: SOWP_DOCS, sectionMode: 'section', sectionLabel: 'Faheem Khan', badge: 'Sponsor',
  portalUrl: 'https://tdot-automations.onrender.com/client/2026-SOWP-017?t=TDOT-abc', ...over,
});

const PRONOUN = /\b(he|she|his|her|him|hers|himself|herself)\b/i;
// Block tags become a space, inline tags (strong/span/a) vanish, entities are undone.
const textOf = (html) => html.replace(/<\/?(p|div|li|ul|td|tr|table|title|br)\b[^>]*>/g, ' ').replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

test('subjects and titles, both variants', () => {
  const on = S.buildSponsorEmail(base());
  assert.equal(on.subject, "Action Required — Your part in Aisha Khan's SOWP application (2026-SOWP-017)");
  assert.equal(on.title, 'Your part in this application — Action Required');
  assert.match(on.html, /<title>Your part in this application — Action Required<\/title>/);
  const re = S.buildSponsorEmail(base({ variant: 'resend' }));
  assert.equal(re.subject, "Your portal link for Aisha Khan's application — 2026-SOWP-017");
  assert.equal(re.title, 'Your portal link');
  assert.match(re.html, /<title>Your portal link<\/title>/);
});

test('the greeting is the sponsor\'s first name; the intro names the client, the case type, the ref and the role', () => {
  const t = textOf(S.buildSponsorEmail(base()).html);
  assert.match(t, /Hi Faheem,/);
  assert.match(t, /Aisha Khan has retained TDOT Immigration for the SOWP application \(case 2026-SOWP-017\), and you are named on it as the Worker Spouse\./);
  assert.match(t, /Some of the documents and answers have to come from you\./);
  // No article before the case type: "for a Inland Spousal Sponsorship application" was the first sentence a sponsor read.
  const iss = textOf(S.buildSponsorEmail(base({ caseType: 'Inland Spousal Sponsorship', sectionMode: 'shared-form' })).html);
  assert.match(iss, /for the Inland Spousal Sponsorship application \(case 2026-SOWP-017\)/);
  assert.doesNotMatch(iss, /for an? Inland/);
  // A documents-only type asks for documents alone — its questionnaire paragraph says there is no section for the sponsor.
  const docsOnly = textOf(S.buildSponsorEmail(base({ caseType: 'Supervisa', sectionMode: 'documents-only' })).html);
  assert.match(docsOnly, /Some of the documents have to come from you\. Here is exactly what we need and where to do it\./);
  assert.doesNotMatch(docsOnly, /documents and answers/);
  assert.match(textOf(S.buildSponsorEmail(base({ sectionMode: 'shared-form' })).html), /documents and answers have to come from you/);
  const r = textOf(S.buildSponsorEmail(base({ variant: 'resend' })).html);
  assert.match(r, /Here is the portal link for Aisha Khan's SOWP application \(case 2026-SOWP-017\) again\. You are named on it as the Worker Spouse\./);
  assert.ok(!/has retained TDOT Immigration/.test(r), 'no onboarding wording on a resend');
});

test('the five SOWP Outland documents, once each, in schema order, each with its category', () => {
  const html = S.buildSponsorEmail(base()).html;
  let last = -1;
  for (const d of SOWP_DOCS) {
    const needle = `${d.name} — <span style="color:#64748b;">${d.category}</span>`;
    const i = html.indexOf(needle);
    assert.ok(i > last, `${d.name} appears after the previous document`);
    assert.equal(html.indexOf(needle, i + 1), -1, `${d.name} appears once`);
    last = i;
  }
  assert.match(textOf(html), /On the portal these are listed under "Worker Spouse"\. Please upload each one against its own line, and leave Aisha's lines to Aisha\./);
});

test('the three questionnaire sentences render exclusively', () => {
  const section = textOf(S.buildSponsorEmail(base({ sectionMode: 'section' })).html);
  const shared  = textOf(S.buildSponsorEmail(base({ sectionMode: 'shared-form' })).html);
  const docsOnly = textOf(S.buildSponsorEmail(base({ sectionMode: 'documents-only' })).html);
  const SECTION = /The questionnaire has a section headed "Faheem Khan" \(marked "Sponsor"\)\. That section is yours\. Aisha completes the rest; please leave those sections as they are\./;
  const SHARED  = /The questionnaire is one form for both of you\. The questions that ask about the sponsor are yours; the rest are Aisha's\. You can fill it in together\./;
  const DOCS    = /There is no questionnaire section for you on this case type — we only need the documents listed above\./;
  assert.match(section, SECTION); assert.ok(!SHARED.test(section) && !DOCS.test(section));
  assert.match(shared, SHARED);   assert.ok(!SECTION.test(shared) && !DOCS.test(shared));
  assert.match(docsOnly, DOCS);   assert.ok(!SECTION.test(docsOnly) && !SHARED.test(docsOnly));
  assert.match(textOf(S.buildSponsorEmail(base({ badge: 'Spouse', sectionLabel: 'Spouse' })).html), /section headed "Spouse" \(marked "Spouse"\)/);
});

test('the case-details box: reference, type, principal applicant, role — and NO Access Token row in either variant', () => {
  for (const variant of ['onboarding', 'resend']) {
    const html = S.buildSponsorEmail(base({ variant })).html;
    assert.ok(!/Access Token<\/td>/.test(html), `${variant}: the token travels in the link only`);
    assert.equal((html.match(/TDOT-abc/g) || []).length, 1, `${variant}: the token appears exactly once — inside the link`);
    assert.match(html, /Principal applicant<\/td>\s*<td[^>]*>Aisha Khan<\/td>/);
    assert.match(html, /Your role<\/td>\s*<td[^>]*>Worker Spouse<\/td>/);
    assert.match(html, /Case Reference<\/td>\s*<td[^>]*>2026-SOWP-017<\/td>/);
    assert.match(html, /href="https:\/\/tdot-automations\.onrender\.com\/client\/2026-SOWP-017\?t=TDOT-abc"/);
    assert.match(html, /Open the case portal →/);
    assert.match(textOf(html), /You and Aisha share one portal for this case\./);
    assert.match(textOf(html), /This is the same portal link Aisha received\./);
    assert.match(textOf(html), /Please do not forward this email\. The link opens Aisha's application as well as your part of it\./);
    assert.match(textOf(html), /reply to this email \(quoting the case reference 2026-SOWP-017\) or contact the assigned consultant\./);
    assert.match(textOf(html), /This email was sent to you because you are named on Aisha Khan's application\./);
  }
});

test('never a pronoun — names only, in every variant and placement', () => {
  for (const variant of ['onboarding', 'resend']) {
    for (const sectionMode of ['section', 'shared-form', 'documents-only']) {
      const html = S.buildSponsorEmail(base({ variant, sectionMode })).html;
      const m = PRONOUN.exec(textOf(html));
      assert.equal(m, null, `${variant}/${sectionMode}: found "${m && m[0]}"`);
    }
  }
});

test('every value is escaped: a </script><b> name cannot break out', () => {
  const html = S.buildSponsorEmail(base({ sponsorName: '</script><b>Faheem', clientName: '<i>Aisha</i> Khan', sectionLabel: '</script><b>Faheem', roleLabel: '<x>', portalUrl: 'https://x/?t="><script>' })).html;
  assert.ok(!/<\/script><b>/.test(html));
  assert.ok(!/<i>Aisha/.test(html));
  assert.ok(!/<x>/.test(html));
  assert.ok(!/"><script>/.test(html));
  assert.match(html, /&lt;\/script&gt;&lt;b&gt;Faheem/);
});

test('a sponsor with no documents in the schema still gets a pointer to the portal list', () => {
  const html = S.buildSponsorEmail(base({ docs: [] })).html;
  assert.match(textOf(html), /The portal lists the documents we need from you under "Worker Spouse"\./);
  assert.ok(!/<li/.test(html.split('Your part of the questionnaire')[0].split('Documents we need from you')[1]));
});

// ─── The link is BYTE-IDENTICAL to the client's ──────────────────────────────

test('the portal link in the sponsor email is the same bytes as in the client\'s intake email (same CM row, same token)', async () => {
  // The client's email, through the real emailService (Monday and Graph stubbed).
  const CM_ROW = { items: [{ name: 'Jasnoor Kaur', column_values: [
    { id: 'text_mm0xw6bp', text: 'jasnoor.k@example.com' },
    { id: 'text_mm142s49', text: '2026-OINP-006' },
    { id: 'dropdown_mm0xd1qn', text: 'OINP' },
    { id: 'text_mm0x6haq', text: 'TDOT-abc' },
    { id: 'color_mm0x8faa', text: 'Document Collection Started' },
    { id: 'color_mm0x9fnn', text: 'Paid' },
  ] }] };
  const sentPa = [];
  const restore = [stub(mondayApi, 'query', async () => CM_ROW), stub(mail, 'sendEmail', async (m) => { sentPa.push(m); })];
  let paHref;
  try {
    await emailSvc.sendIntakeEmail('12652949990');
    paHref = /href="([^"]*\/client\/[^"]*)"/.exec(sentPa[0].html)[1];
  } finally { restore.reverse().forEach((r) => r()); }
  assert.ok(paHref, 'the client email carries a portal link');

  // The sponsor's email, through ensureSponsor with the same case ref + token
  // (the case is typed SOWP so a sponsor exists; the link depends only on ref + token).
  const real = { ...S.io };
  const sentSp = [];
  const prevEnv = process.env.SPONSOR_ONBOARDING;
  process.env.SPONSOR_ONBOARDING = 'true';
  Object.assign(S.io, {
    readCase: async () => ({ itemId: '12652949990', clientName: 'Jasnoor Kaur', caseRef: '2026-OINP-006', caseType: 'SOWP', caseSubType: 'Outland (Spouse or Child)', clientEmail: 'jasnoor.k@example.com', accessToken: 'TDOT-abc', caseStage: 'Document Collection Started', paymentStatus: 'Paid', checklistTemplateApplied: 'No' }),
    findClaimants: async () => [{ id: '1', inviterName: 'Faheem Khan', inviterEmail: 'faheem@example.com', retainerSigned: '2026-09-01', retainerPaid: '2026-09-02' }],
    readComposition: async () => ({ caseFlags: {}, members: [] }),
    readManifest: async () => null,
    createIntakeRows: async () => 0,
    createFamilyRow: async () => '1',
    readMarker: async () => null,
    writeMarker: async () => {},
    sendEmail: async (m) => { sentSp.push(m); },
    postNote: async () => {},
    ensureAccessToken: async () => 'TDOT-abc',
    now: () => Date.now(),
  });
  try {
    const r = await S.ensureSponsor({ itemId: '12652949990', mode: 'onboard', trigger: 'dcs' });
    assert.equal(r.sent, true, JSON.stringify(r));
    const spHref = /href="([^"]*\/client\/[^"]*)"/.exec(sentSp[0].html)[1];
    assert.equal(spHref, paHref);
    assert.equal(sentSp[0].to, 'faheem@example.com');
    assert.equal(sentSp[0].replyTo, emailSvc.EMAIL_REPLY_TO || undefined);
  } finally {
    Object.assign(S.io, real);
    if (prevEnv === undefined) delete process.env.SPONSOR_ONBOARDING; else process.env.SPONSOR_ONBOARDING = prevEnv;
  }
});
