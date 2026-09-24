'use strict';

// Sponsor onboarding — the wiring: the cockpit route and the four automatic
// callers. The service's own behaviour is pinned in sponsorEnsureIo /
// sponsorPlan / sponsorResolve; this file pins WHERE it is called from, in
// what order, and what the route refuses. The server starts on import, so
// its wiring is checked from the source, as paymentUndoRoutes does.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const read = (p) => fs.readFileSync(require.resolve(p), 'utf8');
const SERVER    = read('../src/server.js');
const WEBHOOK   = read('../src/routes/mondayWebhook.js');
const RETAINER  = read('../src/services/retainerService.js');
const CASEREF   = read('../src/services/caseRefService.js');
const CHECKLIST = read('../src/services/checklistService.js');
const PORTAL    = read('../src/routes/clientPortal.js');
const COCKPIT   = read('../src/services/caseCockpitService.js');
const SERVICE   = read('../src/services/sponsorOnboardingService.js');
const PAGE      = read('../src/routes/adminCase.js');

/** The source of one route handler: from its app.post(...) to the next top-level route/comment block. */
function routeWindow(src, marker, len = 6500) {
  const i = src.indexOf(marker);
  assert.ok(i !== -1, `${marker} exists`);
  return src.slice(i, i + len);
}
/** Drop comment-only lines so a pin never matches an explanation. */
const code = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ─── The cockpit route ───────────────────────────────────────────────────────

const ROUTE = "app.post('/admin/case-action/:caseRef/sponsor'";

test('the sponsor route is identity-gated, derives the case server-side and runs the service in staff mode', () => {
  const body = code(routeWindow(SERVER, ROUTE));
  const gate = body.indexOf('resolveCaseForWrite(req, res');
  const call = body.indexOf('ensureSponsor(');
  assert.ok(gate !== -1 && call !== -1 && gate < call, 'the assigned-or-admin gate runs BEFORE the service');
  assert.match(body, /itemId: ctx\.overview\.itemId/, 'the item comes from the resolved case, never the request');
  assert.match(body, /mode: 'staff'/);
  assert.match(body, /trigger: 'staff'/);
  assert.match(body, /actor: staffActor\(req, staffName\)/, 'records who clicked (Monday identity first)');
  assert.doesNotMatch(body, /findByColumnValue\(/, 'D1: never the first-hit lead — the service takes ALL claimants');
  assert.doesNotMatch(body, /clearKeys/, 'a saved inviter never blanks other lead columns');
  assert.doesNotMatch(body, /req\.body\.leadId|body\.leadId/, 'the route body never carries a leadId');
});

test('the sponsor route validates the typed sponsor before anything runs, and only accepts name + email together', () => {
  const body = code(routeWindow(SERVER, ROUTE));
  const validate = body.indexOf('EMAIL_RE.test(email)');
  const call = body.indexOf('ensureSponsor(');
  assert.ok(validate !== -1 && validate < call, 'the email regex runs before the service');
  assert.match(body, /\(name && !email\) \|\| \(!name && email\)[\s\S]{0,80}status\(400\)/, 'a half entry is refused');
  assert.match(body, /doesn’t look right/, 'the wording staff see for a bad address');
  assert.match(body, /name\.length > sponsorOnboarding\.NAME_MAX[\s\S]{0,40}status\(400\)/, 'name capped at the service limit');
  assert.match(body, /stripInvisibles\(/, 'invisible characters are stripped before validation (the U+2060 trap)');
  assert.match(body, /override: \(name && email\) \? \{ name, email \} : undefined/);
});

test('the sponsor route maps the service answers: 409 shared case, 429 cool-down, 503 transient, 502 send failure, 404 no case', () => {
  const body = code(routeWindow(SERVER, ROUTE));
  assert.match(body, /r\.reason === 'shared-case'[\s\S]{0,120}status\(409\)/, 'two client records → 409, fail closed');
  assert.match(body, /client records, so the sponsor can’t be identified safely/);
  assert.match(body, /STAFF_COOLDOWN_MS[\s\S]{0,300}status\(429\)/, 'the per-case cool-down comes from the service constant');
  assert.match(body, /less than a minute ago — try again in/);
  const cooldown = body.indexOf('status(429)');
  const call = body.indexOf('ensureSponsor(');
  assert.ok(cooldown < call, 'the cool-down is checked BEFORE the service runs');
  assert.match(body, /r\.reason === 'transient'[\s\S]{0,400}status\(503\)/);
  assert.match(body, /nothing was changed/, 'a transient failure says so');
  assert.match(body, /catch \(err\) \{[\s\S]{0,300}status\(502\)/, 'a throw from the send → 502');
  assert.match(body, /The email could not be sent — please try again in a moment\./);
  assert.match(body, /r\.reason === 'no-case'[\s\S]{0,40}status\(404\)/);
  assert.match(body, /if \(r\.sent\) SPONSOR_SEND_COOLDOWN\.set\(caseRef, Date\.now\(\)\)/, 'only a real send starts the cool-down');
  assert.match(body, /res\.json\(\{ ok: true, sent: !!r\.sent, to: r\.to/, 'the 200 shape the card reads');
  assert.match(body, /inviterSaved: !!r\.inviterSaved/, 'the card learns whether the typed sponsor was saved');
});

test('the sponsor route never answers 200 for a pass that sent nothing, saved nothing and created nothing', () => {
  const body = code(routeWindow(SERVER, ROUTE, 6500));
  assert.match(body, /r\.reason === 'no-token'[\s\S]{0,300}status\(502\)/, 'no portal link → an error, not "Sponsor added"');
  assert.match(body, /nothing was emailed/);
  assert.match(body, /r\.reason === 'in-progress'[\s\S]{0,40}status\(409\)/);
  assert.match(body, /!\(created\.row \|\| created\.member\) && !r\.inviterSaved[\s\S]{0,80}status\(409\)/, 'not-started with nothing to show → 409');
  assert.match(body, /Nothing was sent — this case is not yet Paid and at Document Collection\. Reload the page\./);
  assert.match(body, /r\.reason === 'inviter-exists'[\s\S]{0,200}status\(409\)/, 'a typed sponsor never replaces one already on file');
  assert.match(body, /already has a sponsor on file/);
  const nonSend = body.indexOf("r.reason === 'no-token'");
  const ok = body.indexOf('res.json({ ok: true');
  assert.ok(nonSend !== -1 && ok !== -1 && nonSend < ok, 'the non-send refusals come before the 200');
});

test('the sponsor route is never env-gated: the cockpit button works while SPONSOR_ONBOARDING is off', () => {
  const body = code(routeWindow(SERVER, ROUTE));
  assert.doesNotMatch(body, /SPONSOR_ONBOARDING|isEnabled\(/);
  // and the service honours that: staff mode skips the switch
  assert.match(code(SERVICE), /mode !== 'staff' && !isEnabled\(\)/);
});

test('the route sits with the other cockpit actions (after the milestone route) and uses the same express.json() parser', () => {
  const ms = SERVER.indexOf("app.post('/admin/case-action/:caseRef/milestone'");
  const sp = SERVER.indexOf(ROUTE);
  assert.ok(ms !== -1 && sp > ms, 'sponsor route follows the milestone route');
  assert.match(routeWindow(SERVER, ROUTE, 120), /express\.json\(\), async \(req, res\)/);
});

// ─── The four automatic callers ──────────────────────────────────────────────

test('webhook: Document Collection Started emails the sponsor right after the client, in onboard mode', () => {
  const src = code(WEBHOOK);
  const dcs = src.indexOf("emailService.sendIntakeEmail(pulseId)");
  assert.ok(dcs !== -1, 'the DCS intake email is where it was');
  const after = src.slice(dcs, dcs + 700);
  assert.match(after, /sponsorOnboardingService'\)\.ensureSponsor\(\{ itemId: pulseId, mode: 'onboard', trigger: 'dcs' \}\)/);
  assert.match(after, /\.catch\(err =>/, 'fire-and-forget with its own catch — a sponsor failure never blocks the checklist seed');
  const seed = after.indexOf('checklistService.onDocumentCollectionStarted');
  assert.ok(seed !== -1 && after.indexOf("trigger: 'dcs'") < seed, 'the sponsor email is not held behind the long checklist seed');
});

test('webhook: a REAL sub-type arrival also (re)tries the sponsor — inside the same newSub !== prevSub guard', () => {
  const src = code(WEBHOOK);
  const i = src.indexOf('CASE_SUB_TYPE_COL_ID) {');
  const branch = src.slice(i, i + 900);
  const guard = branch.indexOf('newSub && newSub !== prevSub');
  const resume = branch.indexOf('resumeSeedingAfterSubType');
  const sponsor = branch.indexOf("ensureSponsor({ itemId: pulseId, mode: 'onboard', trigger: 'sub-type' })");
  assert.ok(guard !== -1 && resume !== -1 && sponsor !== -1);
  assert.ok(guard < resume && resume < sponsor, 'guard → checklist resume → sponsor, all inside the branch');
  // The blank-write / same-value guard closes AFTER the sponsor call.
  const closing = branch.indexOf('\n      }', sponsor);
  assert.ok(closing !== -1 && closing > sponsor, 'the sponsor call is inside the if (newSub && newSub !== prevSub) block');
});

test('webhook: the Client Email correction branch does NOT email the sponsor (spec 2c)', () => {
  const src = code(WEBHOOK);
  const i = src.indexOf('columnId === CLIENT_EMAIL_COL_ID');
  assert.ok(i !== -1);
  const branch = src.slice(i, src.indexOf('columnId ===', i + 10));
  assert.doesNotMatch(branch, /ensureSponsor|sponsorOnboarding/);
});

test('retainerService: the deferred (pre-staged, then paid) branch onboards the sponsor after the client email', () => {
  const src = code(RETAINER);
  const i = src.indexOf('emailService.sendIntakeEmail(itemId)');
  assert.ok(i !== -1);
  const after = src.slice(i, i + 600);
  assert.match(after, /require\('\.\/sponsorOnboardingService'\)\.ensureSponsor\(\{ itemId, mode: 'onboard', trigger: 'retainer-paid' \}\)/, 'lazy require — cycle-safe');
  assert.ok(after.indexOf("trigger: 'retainer-paid'") < after.indexOf('checklistService.onDocumentCollectionStarted'));
  assert.doesNotMatch(src.slice(0, 1200), /sponsorOnboardingService/, 'not a top-level require (the sponsor service reads leads, which read this module)');
});

test('caseRefService: prepare after the family rows and before the stuck-onboarding resume; the resume onboards after the client email', () => {
  const src = code(CASEREF);
  const rows    = src.indexOf('createFamilyRowsForItem');
  const prepare = src.indexOf("mode: 'prepare'");
  const resume  = src.indexOf('resumeOnboardingIfStuck({ itemId, caseRef })');
  assert.ok(rows !== -1 && prepare !== -1 && resume !== -1);
  assert.ok(rows < prepare && prepare < resume, 'D5 needs the intake Spouse row to exist first; the resume must see the sponsor row');
  assert.match(src.slice(prepare - 120, prepare + 160), /ensureSponsor\(\{ itemId, caseRef, mode: 'prepare', trigger: 'case-ref' \}\)[\s\S]{0,10}\)\s*\.catch\(/, 'its own catch — a sponsor failure never stops the resume');
  const fn = src.slice(src.indexOf('async function resumeOnboardingIfStuck'), src.indexOf('async function writePortalLinkForItem'));
  const email = fn.indexOf('emailService.sendIntakeEmail(itemId)');
  const sponsor = fn.indexOf("ensureSponsor({ itemId, caseRef, mode: 'onboard', trigger: 'resume' })");
  const seed = fn.indexOf('checklistService.onDocumentCollectionStarted');
  assert.ok(email !== -1 && sponsor !== -1 && seed !== -1);
  assert.ok(email < sponsor && sponsor < seed, 'client email → sponsor email → awaited checklist seed');
});

test('the places that must NOT email the sponsor stay clean', () => {
  const resume = CHECKLIST.slice(CHECKLIST.indexOf('async function resumeSeedingAfterSubType'), CHECKLIST.indexOf('module.exports'));
  assert.doesNotMatch(resume, /emailService|ensureSponsor|sponsorOnboarding/, 'the checklist resume seeds only (subTypeResume pin)');
  assert.doesNotMatch(CHECKLIST, /sponsorOnboarding/, 'checklistService is untouched');
  const resend = PORTAL.slice(PORTAL.indexOf("router.post('/:caseRef/resend-access'"), PORTAL.indexOf("router.post('/:caseRef/resend-access'") + 2500);
  assert.doesNotMatch(resend, /ensureSponsor|sponsorOnboarding/, 'the client resend-access never re-emails the sponsor');
});

test('the service sends through the mail module reference (stubbable), never a destructured sendEmail', () => {
  assert.match(SERVICE, /const mail\s*=\s*require\('\.\/microsoftMailService'\)/);
  assert.doesNotMatch(SERVICE, /const \{ sendEmail \}/);
  assert.match(SERVICE, /mail\.sendEmail\(/);
  assert.doesNotMatch(SERVICE, /findByColumnValue\(/, 'D1: all claimants, never the first hit');
  assert.doesNotMatch(SERVICE, /clearKeys/);
});

// ─── The cockpit read + the card ─────────────────────────────────────────────

test('the cockpit overview describes the sponsor (with the client name the marker read needs) and degrades to hidden', () => {
  const src = code(COCKPIT);
  const i = src.indexOf("sponsorOnboardingService').describe({");
  assert.ok(i !== -1, 'getCaseOverview calls describe');
  const call = src.slice(i, i + 700);
  assert.match(call, /itemId, caseRef, clientName, caseType, caseSubType/);
  assert.match(call, /clientEmail:\s+cm\._unavailable \? null : cm\.clientEmail/, 'an unreadable Client Master never triggers the same-as-client check');
  assert.match(call, /cmUnavailable: cm\._unavailable === true/);
  assert.match(call, /composition, qMembers/);
  assert.match(call, /\}\)\.catch\(\(e\) => \{[\s\S]{0,160}return \{ available: false \}; \}\)/, 'a failed describe hides the card, never fails the page');
  const extras = src.indexOf('await getLeadExtras(itemId, caseRef)');
  assert.ok(extras !== -1 && extras < i, 'after getLeadExtras, which keeps its first-hit lead for display');
  assert.match(src, /\n\s+sponsor,\n\s+\};/, 'one new top-level key');
});

test('the cockpit card: rendered from d.sponsor, confirm() before the POST, the same header/credentials pattern, then loadCase()', () => {
  const block = PAGE.slice(PAGE.indexOf('function renderSponsor'), PAGE.indexOf('function renderQTab'));
  assert.match(block, /sp\.available === false \|\| sp\.reason === 'not-applicable'[\s\S]{0,60}display = 'none'/, 'hidden for case types with no sponsor');
  assert.match(block, /'\/sponsor'/, 'posts to the sponsor route');
  assert.match(block, /if \(!window\.confirm\(question\)\) return;/, 'asks first');
  assert.match(block, /headers\['X-Api-Key'\] = key/);
  assert.match(block, /credentials: 'same-origin'/);
  assert.match(block, /loadCase\(\);/, 're-reads the case after a success');
  assert.match(block, /Sent to ' \+ \(j\.to \|\| 'the sponsor'\) \+ ' — noted on the case\./);
  assert.match(block, /You are not assigned to this case\./);
  assert.match(block, /Please sign in again\./);
  // the copy states (§4)
  for (const s of ['Not emailed yet', 'Resend sponsor link', 'Send sponsor link', 'Add sponsor now', 'Save sponsor &amp; send link',
    'Emails automatically when Document Collection starts (after payment)', 'Same email address as the client',
    'Send sponsor link anyway', 'No sponsor on file for this case.', 'Set the Case Sub Type first', 'Case data is temporarily unavailable',
    'OneDrive unavailable', 'Last attempt failed — ']) {
    assert.ok(block.includes(s), `card copy present: ${s}`);
  }
  assert.doesNotMatch(block, /\b(he|she|his|her)\b/i, 'names only — no pronoun in anything staff read about the sponsor');
  assert.doesNotMatch(block, /leadId\s*[:=]/, 'the page never sends a leadId');
});

test('the cockpit card says what the server did: "Sponsor added" only when something was created, "saved" when the typed sponsor was saved, never a success for nothing', () => {
  const block = PAGE.slice(PAGE.indexOf('function renderSponsor'), PAGE.indexOf('function renderQTab'));
  assert.match(block, /if \(j\.sent\)[\s\S]{0,200}else if \(made\.row \|\| made\.member\) actMsg\('sp-msg', 'ok', 'Sponsor added — ' \+ spNextStep\(sp, false\)\)/);
  assert.match(block, /else if \(j\.inviterSaved\) actMsg\('sp-msg', 'ok', 'Sponsor saved to the client record — ' \+ spNextStep\(sp, false\)\)/);
  assert.match(block, /else actMsg\('sp-msg', 'info', 'Nothing to send yet — '/);
  assert.match(block, /var j = res\.j, made = j\.created \|\| \{\};/);
});

test('the cockpit card promises an automatic email ONLY while the switch is on (sp.autoEnabled) — otherwise it tells staff to press the button', () => {
  const block = PAGE.slice(PAGE.indexOf('function renderSponsor'), PAGE.indexOf('function renderQTab'));
  const next = block.slice(block.indexOf('function spNextStep'), block.indexOf('function spAction'));
  assert.match(next, /if \(spAutoEmails\(sp\)\) return sentence \? 'The portal email goes out automatically when Document Collection starts\.' : 'the email goes out automatically when Document Collection starts\.';/);
  assert.match(next, /return sentence \? 'Come back and press Send sponsor link once Document Collection starts\.' : 'press Send sponsor link once the case is paid and at Document Collection\.';/);
  // every "automatically" the card prints goes through spNextStep or the autoEnabled pill (the pill ternary spans two lines)
  const lines = block.split('\n');
  lines.forEach((l, i) => { if (/automatically/.test(l)) assert.ok(/spNextStep|spAutoEmails|sp\.autoEnabled/.test((lines[i - 1] || '') + l), `unconditional promise: ${l.trim()}`); });
  assert.match(block, /spAutoEmails\(sp\)\s*\?\s*'<span class="pill grey">Emails automatically when Document Collection starts \(after payment\)<\/span>'\s*:\s*'<span class="pill grey">Not emailed yet — send it from this page once the case is paid and at Document Collection<\/span>'/);
  assert.match(block, /'Add ' \+ sp\.name \+ ' to ' \+ CASE_REF \+ ' now\? ' \+ spNextStep\(sp, true\)/, 'the add dialog');
  assert.match(block, /this creates the questionnaire section only\. ' \+ spNextStep\(sp, true\)/, 'the add hint');
});

test('the cockpit card: before payment a typed sponsor is "Save sponsor" (saved, not emailed); a same-address sponsor gets the not-started state, not "Send sponsor link anyway"', () => {
  const block = PAGE.slice(PAGE.indexOf('function renderSponsor'), PAGE.indexOf('function renderQTab'));
  assert.match(block, /var saveOnly = sp\.sendBlockedReason === 'not-started';/);
  assert.match(block, /\(saveOnly \? 'Save sponsor' : 'Save sponsor &amp; send link'\)/);
  assert.match(block, /The portal link is sent later, once the case is paid and at Document Collection/);
  assert.match(block, /sp\.sendBlockedReason === 'not-started'\s*\?\s*'Save ' \+ name \+ ' \(' \+ email \+ '\) as the sponsor on the client record for ' \+ CASE_REF \+ '\? The portal link is sent later/);
  assert.match(block, /as the sponsor on the client record and email them the portal link for ' \+ CASE_REF \+ '\?'/, 'at Document Collection the save also sends');
  const notStarted = block.indexOf("sp.sendBlockedReason === 'not-started') {");
  const same = block.indexOf("sp.reason === 'same-as-client') {");
  const emailed = block.indexOf('sp.emailedAt) {');
  assert.ok(notStarted !== -1 && same !== -1 && emailed !== -1);
  assert.ok(emailed < notStarted && notStarted < same, 'emailed → not-started → same-as-client: the anyway-button only when a send is possible');
  assert.match(block, /var sameLine = sp\.reason === 'same-as-client' \? '<div class="sp-line sp-dim">Same email address as the client/, 'the same-address fact is still shown in the other states');
  assert.match(block, /btnLabel = sp\.emailedAt \? 'Resend sponsor link' : 'Send sponsor link';\n\s+\} else if \(sp\.emailedAt\)/, 'a failed resend still offers a resend');
});

test('the cockpit card: line 3 agrees with the button beneath it', () => {
  const block = PAGE.slice(PAGE.indexOf('function renderSponsor'), PAGE.indexOf('function renderQTab'));
  assert.match(block, /btnMode === 'add' \? 'not created yet — Add sponsor now creates it \(it is also created with the first send\)'/);
  assert.match(block, /: 'not created yet — it is created with the first send'/);
  const line3 = block.indexOf('Questionnaire section:</span>');
  const decided = block.indexOf("btnLabel = 'Add sponsor now'; btnMode = 'add';");
  assert.ok(decided !== -1 && line3 > decided, 'line 3 is printed after the button is decided');
});

// ─── Round 2 ─────────────────────────────────────────────────────────────────

test('the sponsor route: a failure AFTER the lead or the row was written says what was written (never "nothing was changed"), and the card reloads on it', () => {
  const body = code(routeWindow(SERVER, ROUTE, 6500));
  assert.match(body, /const done = sponsorPartialSentence\(r\);/);
  assert.match(body, /if \(done\) return res\.status\(503\)\.json\(\{ ok: false, error: `\$\{done\}, but the case could not be finished — nothing was emailed\. Try again in a minute\.`, reason: r\.reason, created: r\.created \|\| \{ row: false, member: false \}, inviterSaved: !!r\.inviterSaved \}\);/);
  const partial = body.indexOf('if (done) return res.status(503)');
  const plain = body.indexOf("error: 'Couldn’t read the case just now — nothing was changed.");
  assert.ok(partial !== -1 && plain !== -1 && partial < plain, '"nothing was changed" is answered only when nothing was');
  const helper = code(SERVER.slice(SERVER.indexOf('function sponsorPartialSentence'), SERVER.indexOf('function sponsorPartialSentence') + 600));
  assert.match(helper, /if \(r\.inviterSaved\) parts\.push\('The sponsor was saved to the client record'\);/);
  assert.match(helper, /if \(c\.row \|\| c\.member\) parts\.push\(parts\.length \? 'the questionnaire section was created' : 'The questionnaire section was created'\);/);
  // no-token likewise carries what was created
  assert.match(body, /r\.reason === 'no-token'[\s\S]{0,400}created, inviterSaved: !!r\.inviterSaved \}\);/);
  assert.match(body, /\$\{done \? `\$\{done\}, but no` : 'No'\} portal link could be made for this case just now — nothing was emailed\./);
  // the card: an error answer that names something created → loadCase()
  const block = PAGE.slice(PAGE.indexOf('function renderSponsor'), PAGE.indexOf('function renderQTab'));
  assert.match(block, /var partial = \(res\.j && res\.j\.created\) \|\| \{\};\n\s+if \(partial\.row \|\| partial\.member \|\| \(res\.j && res\.j\.inviterSaved\)\) loadCase\(\);/);
});

test('the sponsor route: "Add sponsor now" / "Save sponsor" send createOnly, the route passes it to the service, and a create-only pass with nothing to add is refused honestly', () => {
  const body = code(routeWindow(SERVER, ROUTE, 6500));
  assert.match(body, /const createOnly = body\.createOnly === true;/);
  assert.match(body, /override: \(name && email\) \? \{ name, email \} : undefined,\n\s+createOnly,\n/, 'passed to ensureSponsor');
  assert.match(body, /r\.reason === 'create-only'[\s\S]{0,40}status\(409\)/);
  assert.match(body, /Nothing to add — the sponsor is already on this case\. Reload the page\./);
  assert.match(code(SERVICE), /createOnly = false \} = \{\}\) \{/, 'the service takes the flag');
  assert.match(code(SERVICE), /\} else if \(createOnly\) \{\n\s+skipReason = 'create-only';/, 'planEnsure: never a send with the flag, whatever the gates or the marker');
  const block = PAGE.slice(PAGE.indexOf('function renderSponsor'), PAGE.indexOf('function renderQTab'));
  assert.match(block, /\} else if \(mode === 'add'\) \{\n\s+payload = \{ createOnly: true \};/, 'Add sponsor now');
  assert.match(block, /if \(sp\.sendBlockedReason === 'not-started'\) payload\.createOnly = true;/, 'Save sponsor (sent later)');
  const sendMode = block.slice(block.indexOf("} else {\n    question = 'Email '"), block.indexOf('if (!window.confirm(question)) return;'));
  assert.doesNotMatch(sendMode, /createOnly/, 'Send sponsor link never carries the flag');
});

test('the cockpit card: a same-address sponsor is never promised the automatic email (the automatic path skips that address), and a replaced sponsor is shown as not emailed', () => {
  const block = PAGE.slice(PAGE.indexOf('function renderSponsor'), PAGE.indexOf('function renderQTab'));
  assert.match(block, /function spAutoEmails\(sp\) \{\n\s+return !!\(sp && sp\.autoEnabled && sp\.reason !== 'same-as-client'\);\n\}/);
  assert.doesNotMatch(block.replace(/function spAutoEmails[\s\S]*?\n\}/, ''), /sp\.autoEnabled/, 'every automatic-email promise goes through spAutoEmails');
  assert.match(block, /var replacedLine = \(sp\.replacedFrom && !sp\.emailedAt\) \? '<div class="sp-line sp-dim">The earlier sponsor email went to ' \+ escHtml\(sp\.replacedFrom\) \+ ' — ' \+ escHtml\(sp\.name\) \+ ' has not been emailed\.<\/div>' : '';/);
  assert.match(block, /html \+= sameLine \+ replacedLine;/);
  assert.doesNotMatch(block, /\b(he|she|his|her)\b/i);
});

test('the case-ref chain and the sponsor onboarding share ONE intake-rows run per case (familyCompositionService in-flight map)', () => {
  const FAM = code(read('../src/services/familyCompositionService.js'));
  const fn = FAM.slice(FAM.indexOf('async function createFamilyRowsForItem'), FAM.indexOf('module.exports'));
  assert.match(fn, /if \(_rowsInFlight\.has\(key\)\) return _rowsInFlight\.get\(key\);/);
  assert.match(fn, /finally \{ _rowsInFlight\.delete\(key\); \}/);
  const svc = code(SERVICE);
  assert.match(svc, /createIntakeRows:\s+\(args\) => require\('\.\/familyCompositionService'\)\.createFamilyRowsForItem\(args\)/);
  const ensure = svc.slice(svc.indexOf('async function ensureSponsor'), svc.indexOf('/* ─────────────────────────────── describe'));
  const intake = ensure.indexOf('io.createIntakeRows(');
  const row = ensure.indexOf('io.createFamilyRow(');
  assert.ok(intake !== -1 && row !== -1 && intake < row, "the intake's rows are asked for BEFORE the sponsor's");
  assert.match(ensure, /if \(plan\.createRow && mode === 'onboard' && !\(\(composition && composition\.members\) \|\| \[\]\)\.length\) \{/, 'only the automatic path, only on an empty board');
});

// ─── Mutation round (2026-09-24): the survivors ──────────────────────────────

test('the sponsor route: the cool-down really guards the 429 — the remainder is computed from the service constant and the last send, and the guard wraps the refusal', () => {
  const body = code(routeWindow(SERVER, ROUTE));
  assert.match(body, /const last = SPONSOR_SEND_COOLDOWN\.get\(caseRef\) \|\| 0;\n\s+const wait = sponsorOnboarding\.STAFF_COOLDOWN_MS - \(Date\.now\(\) - last\);\n\s+if \(wait > 0\) \{\n\s+return res\.status\(429\)/, 'a double-click within the minute is refused, not re-sent');
  assert.match(body, /try again in \$\{Math\.ceil\(wait \/ 1000\)\}s\./, 'the seconds shown are the real remainder');
  assert.equal(require('../src/services/sponsorOnboardingService').STAFF_COOLDOWN_MS, 60 * 1000);
});

test('the cockpit card escapes every server value it prints as HTML — the inviter name is typed on the lead', () => {
  const fn = PAGE.slice(PAGE.indexOf('function renderSponsor'), PAGE.indexOf('function spAutoEmails'));
  assert.ok(fn.length > 500, 'the render function is where it was');
  assert.doesNotMatch(fn, /' \+ sp\.(name|emailMasked|sectionLabel|roleLabel|replacedFrom|lastError|reason|sendBlockedReason)\b/, 'a raw sp.* concatenated into the card HTML');
  for (const f of ['name', 'emailMasked', 'sectionLabel', 'roleLabel', 'replacedFrom']) assert.ok(fn.includes(`escHtml(sp.${f})`), `escHtml(sp.${f}) is how the card prints it`);
  assert.ok(fn.includes('escHtml(String(sp.lastError).slice(0, 80))'), 'the failure reason is escaped too');
  assert.ok(fn.includes('escHtml(spWhen(sp.emailedAt))'));
});
