'use strict';

// Pre-invite consultant override (Melanie's call, 2026-08-17): staff see the
// auto-routing suggestion on the lead page and can pin Shafoli/Shermin before
// the booking invite goes out; the booking page, slot search, fee lines and
// payment reconcile all honor the pin (resolveConsultant), falling back to
// auto-routing when nothing is pinned. "Document review" is no longer offered
// on either public form.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');

const { validateAction } = require('../src/services/consultantPortalService');
const routing = require('../config/consultantRouting');

test('setConsultant validation: exact registry names or clear-to-auto only', () => {
  for (const c of Object.values(routing.CONSULTANTS)) {
    assert.deepEqual(validateAction('setConsultant', c.name), { ok: true, normalized: c.name });
  }
  assert.deepEqual(validateAction('setConsultant', ''), { ok: true, normalized: '' }, 'empty = back to auto-routing');
  assert.equal(validateAction('setConsultant', 'Dr Nobody').ok, false);
  assert.equal(validateAction('setConsultant', 'shafoli kapur').ok, false, 'case-sensitive exact match — no near-miss pins');
});

test('resolveConsultant honors the pin and falls back to routing', () => {
  // Routing-agnostic: whatever routeConsultant would pick, the pin overrides it
  // in BOTH directions, and unpinned always equals routeConsultant's own result.
  const leads = [{ crsScore: '520' }, { urgent: 'Yes', serviceRequired: 'PR pathways' }, {}];
  for (const lead of leads) {
    assert.equal(routing.resolveConsultant(lead).key, routing.routeConsultant(lead).key, 'unpinned = auto-routing');
    for (const c of Object.values(routing.CONSULTANTS)) {
      assert.equal(routing.resolveConsultant({ ...lead, assignedConsultant: c.name }).key, c.key,
        'the pin beats every routing signal');
    }
  }
});

test('every live booking surface resolves via the pin (no raw routeConsultant left)', () => {
  const phase2 = fs.readFileSync(require.resolve('../src/routes/phase2'), 'utf8');
  assert.equal((phase2.match(/routing\.routeConsultant\(/g) || []).length, 0, 'booking page + POST /book honor the pin');
  assert.ok((phase2.match(/routing\.resolveConsultant\(lead\)/g) || []).length >= 2);
  const booking = fs.readFileSync(require.resolve('../src/services/bookingService'), 'utf8');
  assert.equal((booking.match(/routing\.routeConsultant\(/g) || []).length, 0, 'reconcile + invite fee lines honor the pin');
});

test('lead detail exposes the suggestion + pickable names; UI pins on change AND before send', () => {
  const svc = fs.readFileSync(require.resolve('../src/services/consultantPortalService'), 'utf8');
  assert.match(svc, /routedConsultant:/);
  assert.match(svc, /consultants: \(\(\) =>/);
  assert.match(svc, /Already booked — the consultation is on the assigned consultant/, 'pin refused after booking');
  const page = fs.readFileSync(require.resolve('../src/routes/adminLeads'), 'utf8');
  assert.match(page, /id="inv-consultant"/);
  assert.match(page, /action:'setConsultant',value:cs\.value/, 'persist on change');
  assert.match(page, /Pin first \(post-confirm\), then send/, 'what is on screen at send time is what gets pinned');
});

test('"Document review" removed from BOTH public form service lists (board labels untouched)', () => {
  const intake = fs.readFileSync(require.resolve('../src/services/intakeFormService'), 'utf8');
  const intakeList = intake.slice(intake.indexOf("'Other Support': ["), intake.indexOf("'Other Support': [") + 400);
  assert.ok(!/['"]Document review['"]/.test(intakeList), 'intake form no longer offers it');
  const consult = require('../config/consultationFormFields');
  const flat = JSON.stringify(consult);
  // Exactly ONE benign occurrence survives: the f4_need question "Application
  // filing / Document review / Both" — a different concept from the removed
  // "Other Support" SERVICE. Both service pickers are clean.
  assert.equal((flat.match(/Document review/g) || []).length, 1, 'only the f4_need wording remains');
  assert.ok(!JSON.stringify(consult.SERVICE_GROUPS).includes('Document review'), 'service groups are clean');
});
