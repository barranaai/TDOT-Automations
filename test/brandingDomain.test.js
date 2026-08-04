'use strict';

// Custom-domain migration (app.tdotimm.com, 2026-08-04). Every client-facing
// page and email must render the logo from the CURRENT public domain. Eleven
// places used to hardcode the .onrender.com asset URL, so after moving
// RENDER_URL the app served its own branding off the old infrastructure
// domain — invisible while both domains answer, broken the day one is retired.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const SRC = path.join(__dirname, '..', 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('no source file hardcodes the .onrender.com asset URL — the logo follows RENDER_URL', () => {
  const offenders = walk(SRC)
    .filter((f) => fs.readFileSync(f, 'utf8').includes('tdot-automations.onrender.com/assets'))
    .map((f) => path.relative(SRC, f));
  assert.deepEqual(offenders, [],
    `hardcoded asset URL(s) — use the LOGO_URL export from src/branding.js instead: ${offenders.join(', ')}`);
});

test('branding.LOGO_URL follows RENDER_URL, and falls back to the permanent domain', () => {
  const load = (renderUrl) => {
    const prev = process.env.RENDER_URL;
    if (renderUrl === undefined) delete process.env.RENDER_URL; else process.env.RENDER_URL = renderUrl;
    delete require.cache[require.resolve('../src/branding')];
    const { LOGO_URL } = require('../src/branding');
    if (prev === undefined) delete process.env.RENDER_URL; else process.env.RENDER_URL = prev;
    delete require.cache[require.resolve('../src/branding')];
    return LOGO_URL;
  };
  assert.equal(load('https://app.tdotimm.com'), 'https://app.tdotimm.com/assets/tdot-logo.png');
  assert.equal(load(undefined), 'https://tdot-automations.onrender.com/assets/tdot-logo.png',
    'unset RENDER_URL still resolves to a domain that serves the asset');
});

test('a real client-facing page renders the logo from the configured domain (no un-interpolated placeholder)', () => {
  const prev = process.env.RENDER_URL;
  process.env.RENDER_URL = 'https://app.tdotimm.com';
  for (const m of ['../src/branding', '../src/services/documentReviewFormService']) delete require.cache[require.resolve(m)];
  try {
    const svc = require('../src/services/documentReviewFormService');
    const html = svc.buildReviewPage({ caseRef: '2026-XX-001', clientName: 'Test', staffName: 'Staff', items: [], folderLinks: {} });
    assert.ok(!/\$\{LOGO_URL\}/.test(html), 'the placeholder must be interpolated, never emitted literally');
    assert.match(html, /src="https:\/\/app\.tdotimm\.com\/assets\/tdot-logo\.png"/);
  } finally {
    if (prev === undefined) delete process.env.RENDER_URL; else process.env.RENDER_URL = prev;
    for (const m of ['../src/branding', '../src/services/documentReviewFormService']) delete require.cache[require.resolve(m)];
  }
});
