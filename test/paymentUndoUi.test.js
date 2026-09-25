'use strict';

// The shared payment-correction UI (tooltip, row actions, dialogs) and how the
// two payment panels embed it. The UI is presentation only — the server
// enforces every rule — but it must offer the right thing to the right person,
// and it must never let a name inject markup.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');

const { PAYMENT_UI_JS, PAYMENT_UI_CSS } = require('../src/routes/adminShared');

function ui(viewer) {
  const ctx = vm.createContext({ location: { pathname: '/admin/case/2026-OINP-059', search: '', hash: '' }, encodeURIComponent, String, Number, isNaN, Date, Array });
  vm.runInContext(PAYMENT_UI_JS + '\n;this.__ = { tdotPayAuditText, tdotPayAuditHtml, tdotPayRowActions, TDOT_PAY, payWhen };', ctx);
  ctx.__.TDOT_PAY.viewer = viewer || null;
  return ctx.__;
}
const ADMIN   = { signedIn: true,  name: 'Faran', canUndo: true,  adminsConfigured: true, signInUrl: '/q/auth/monday' };
const STAFF   = { signedIn: true,  name: 'Kamalpreet', canUndo: false, adminsConfigured: true, signInUrl: '/q/auth/monday' };
const KEYONLY = { signedIn: false, name: '', canUndo: false, adminsConfigured: true, signInUrl: '/q/auth/monday' };

test('the plain-text rule: the shared UI has no backticks, no dollar-brace, no backslashes', () => {
  for (const [name, text] of [['JS', PAYMENT_UI_JS], ['CSS', PAYMENT_UI_CSS]]) {
    assert.ok(!text.includes('`'), `${name}: backtick`);
    assert.ok(!text.includes('${'), `${name}: dollar-brace`);
    assert.ok(!text.includes('\\'), `${name}: backslash — it is interpolated into template literals`);
  }
  assert.doesNotThrow(() => new Function(PAYMENT_UI_JS));
});

test('tooltip: who marked it and when — and whether the name was only typed', () => {
  const u = ui(ADMIN);
  assert.match(u.tdotPayAuditText({ status: 'paid', markedBy: 'Gauri Berde', markedAt: '2026-09-22T20:59Z', markedVerified: true }), /^Marked paid by Gauri Berde · /);
  assert.match(u.tdotPayAuditText({ status: 'paid', markedBy: 'Kamalpreet', markedAt: '2026-09-22T20:59Z', markedVerified: false }), /Kamalpreet \(name as typed\)/);
  const both = u.tdotPayAuditText({ status: 'paid', markedBy: 'A', markedAt: '', undoneBy: 'Faran', undoneAt: '2026-09-23T15:04Z' });
  assert.equal(both.split(String.fromCharCode(10)).length, 2, 'two lines: the mark and the earlier removal');
  assert.match(u.tdotPayAuditText({ status: 'pending', undoneBy: 'Faran', undoneAt: '' }), /removed by Faran/);
  assert.equal(u.tdotPayAuditText({ status: 'pending' }), '');
  assert.equal(u.tdotPayAuditHtml({ status: 'pending' }), '', 'nothing to say, nothing rendered');
});

test('tooltip escaping: a name can never inject markup', () => {
  const html = ui(ADMIN).tdotPayAuditHtml({ status: 'paid', markedBy: '"><img src=x onerror=alert(1)>', markedAt: '' });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /data-tip="Marked paid by &quot;&gt;&lt;img/);
});

test('row actions: an admin gets Undo…; everyone else gets Flag as wrong', () => {
  const paid = { index: 0, status: 'paid' };
  assert.match(ui(ADMIN).tdotPayRowActions(paid, {}, 'sbtn'), /data-pay-undo="0"[^>]*>Undo…/);
  assert.doesNotMatch(ui(ADMIN).tdotPayRowActions(paid, {}, 'sbtn'), /data-pay-flag/);
  const staff = ui(STAFF).tdotPayRowActions(paid, {}, 'sbtn');
  assert.match(staff, /data-pay-flag="0"[^>]*>Flag as wrong/);
  assert.doesNotMatch(staff, /data-pay-undo/);
  assert.doesNotMatch(staff, /Sign in with Monday/, 'already signed in — just not an admin');
});

test('row actions: someone on the shared key only is offered the Monday sign-in (it could be an admin)', () => {
  const html = ui(KEYONLY).tdotPayRowActions({ index: 1, status: 'paid' }, {}, 'btn');
  assert.match(html, /Flag as wrong/);
  assert.match(html, /href="\/q\/auth\/monday\?returnTo=%2Fadmin%2Fcase%2F2026-OINP-059"/);
  const noAdmins = ui({ ...KEYONLY, adminsConfigured: false }).tdotPayRowActions({ index: 1, status: 'paid' }, {}, 'btn');
  assert.doesNotMatch(noAdmins, /Sign in with Monday/, 'no admins configured: no false promise');
});

test('row actions: the first milestone carrying only a leftover payment date offers "Remove payment date…" to admins', () => {
  assert.match(ui(ADMIN).tdotPayRowActions({ index: 0, status: 'requested' }, { retainerPaid: '2026-09-22' }, 'sbtn'), /data-pay-undo="0"[^>]*>Remove payment date…/);
  assert.equal(ui(STAFF).tdotPayRowActions({ index: 0, status: 'requested' }, { retainerPaid: '2026-09-22' }, 'sbtn'), '');
  assert.equal(ui(ADMIN).tdotPayRowActions({ index: 1, status: 'pending' }, { retainerPaid: '2026-09-22' }, 'sbtn'), '', 'only the first milestone is the retainer payment');
  assert.equal(ui(ADMIN).tdotPayRowActions({ index: 0, status: 'pending' }, { retainerPaid: '' }, 'sbtn'), '');
});

test('row actions are offered only once the viewer is known', () => {
  assert.equal(ui(null).tdotPayRowActions({ index: 0, status: 'paid' }, {}, 'sbtn').includes('Undo'), false);
});

test('the Mark-paid and Undo dialogs label the same figure (row.totalCents) the same way — "scheduled amount, incl. HST"', () => {
  const js = PAYMENT_UI_JS;
  const mark = js.slice(js.indexOf('function tdotOpenMarkPaidModal('), js.indexOf('function renderUndo('));
  const undo = js.slice(js.indexOf('function renderUndo('), js.indexOf('function renderUndo(') + 4000);
  assert.ok(mark.length > 200 && undo.length > 200, 'both dialogs are where they were');
  const LABEL = '<span class="paym-muted">scheduled amount, incl. HST</span>';
  assert.ok(mark.includes("payAmount(m) + ' " + LABEL), 'Mark paid: the amount is the scheduled total incl. HST');
  assert.ok(undo.includes("(Number(p.totalCents||0)/100).toFixed(2)) + ' " + LABEL), 'Undo: the same total, the same words');
  assert.doesNotMatch(undo, /scheduled amount<\/span>/, 'never the bare "scheduled amount" that reads as pre-tax');
});

test('both panels embed the shared module, and Mark paid no longer uses a bare browser prompt', () => {
  const cockpit = require('../src/routes/adminCase').buildCaseHTML ? require('../src/routes/adminCase').buildCaseHTML('2026-OINP-059') : null;
  const fs = require('fs');
  const caseSrc = fs.readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8');
  const consSrc = fs.readFileSync(require.resolve('../src/routes/adminConsultation.js'), 'utf8');
  for (const [name, src] of [['cockpit', caseSrc], ['consultation', consSrc]]) {
    assert.match(src, /\$\{PAYMENT_UI_JS\}/, `${name} embeds the JS`);
    assert.match(src, /\$\{PAYMENT_UI_CSS\}/, `${name} embeds the CSS`);
    assert.match(src, /tdotOpenMarkPaidModal\(/, `${name} opens the Mark-paid dialog`);
    assert.match(src, /tdotPayAuditHtml\(m\)/, `${name} shows the who/when tooltip`);
    assert.match(src, /tdotPayRowActions\(m,/, `${name} offers Undo…/Flag`);
    assert.match(src, /tdotPayBind\(/, `${name} wires them`);
  }
  assert.doesNotMatch(caseSrc, /window\.prompt\('e-Transfer reference/, 'cockpit: no bare prompt');
  assert.doesNotMatch(consSrc, /window\.prompt\('Record the e-transfer payment/, 'consultation: no bare prompt');
  // the consultation undo must not go through doAction (it bounces 401/403 to /admin)
  assert.doesNotMatch(consSrc, /doAction\('undo|doAction\("undo/i);
  if (cockpit) assert.ok(cockpit.length > 0);
});

test('the first milestone can be requested once the retainer is signed, on both panels', () => {
  const fs = require('fs');
  assert.match(fs.readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8'), /m\.status === 'pending' && \(m\.due \|\| \(m\.index === 0 && L\.retainerSigned\)\)/);
  assert.match(fs.readFileSync(require.resolve('../src/routes/adminConsultation.js'), 'utf8'), /m\.status==='pending'&&\(m\.due\|\|\(m\.index===0&&signed\)\)/);
});

test('one payment dialog at a time — a double-click never stacks two', () => {
  const { PAYMENT_UI_JS } = require('../src/routes/adminShared');
  const open = PAYMENT_UI_JS.slice(PAYMENT_UI_JS.indexOf('function payOverlay(){'), PAYMENT_UI_JS.indexOf('function payOverlay(){') + 400);
  assert.match(open, /querySelectorAll\('\.paym-overlay'\)[\s\S]*removeChild/);
});

test('tooltip time is OFFICE time (Toronto) with the zone shown — the same day for every viewer', () => {
  const u = ui(ADMIN);
  assert.equal(u.payWhen('2026-09-23T02:30Z'), 'Sep 22, 2026, 10:30 p.m. EDT', 'late evening in Toronto is still the 22nd');
  assert.match(u.payWhen('2026-12-23T02:30Z'), /EST$/);
  assert.equal(u.payWhen(''), '');
});

test('the shared-key placeholder is not called "a typed name"', () => {
  const t = ui(ADMIN).tdotPayAuditText({ status: 'paid', markedBy: 'Unidentified (shared admin key)', markedAt: '', markedVerified: false });
  assert.doesNotMatch(t, /name as typed/);
});

test('"Remove payment date…" is not offered on a case already Paid — the board is where that starts', () => {
  assert.equal(ui(ADMIN).tdotPayRowActions({ index: 0, status: 'requested' }, { retainerPaid: '2026-09-22', casePaid: true }, 'sbtn'), '');
  const fs = require('fs');
  assert.match(fs.readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8'), /casePaid: d\.paymentStatus === 'Paid'/);
});

test('no e-transfer request button for a retainer already recorded as paid, on both panels', () => {
  const fs = require('fs');
  assert.match(fs.readFileSync(require.resolve('../src/routes/adminCase.js'), 'utf8'), /&& !\(m\.index === 0 && L\.retainerPaid\)\) \{/);
  assert.match(fs.readFileSync(require.resolve('../src/routes/adminConsultation.js'), 'utf8'), /&&!\(m\.index===0&&D\.retainerPaid\)\)\?/);
});

test('dialogs: labelled for screen readers, focus returns to the button, and a finished dialog refreshes however it is closed', () => {
  const js = PAYMENT_UI_JS;
  assert.match(js, /role="dialog" aria-modal="true" aria-labelledby="paym-title"/);
  assert.match(js, /<h3 id="paym-title"/);
  for (const id of ['paym-ref', 'paym-by', 'paym-why', 'paym-confirm']) {
    assert.match(js, new RegExp('<label for="' + id + '"'), 'label for ' + id);
    assert.match(js, new RegExp('id="' + id + '"'), 'input id ' + id);
  }
  assert.match(js, /opener\.focus\(\)/, 'focus goes back to what opened the dialog');
  const overlay = js.slice(js.indexOf('function payOverlay(){'), js.indexOf('function payTitle('));
  assert.match(overlay, /if \(d\.onClose\)/, 'Escape, the backdrop and Done all run the same close — and its refresh');
  assert.equal((js.match(/d\.onClose = o\.onDone \|\| null/g) || []).length, 2, 'set once the undo and once the flag has succeeded');
  assert.match(js, /role="alert"/, 'errors are announced');
  assert.match(js, /at least 10 characters/, 'the reason minimum is stated up front');
});
