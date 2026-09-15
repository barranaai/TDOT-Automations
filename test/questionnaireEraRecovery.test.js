'use strict';

// Era recovery (2026-09-16, case 2026-CEC-EE-077).
//
//   1. Submit now sends the era of the page it was served (single and family
//      submit). Until now a submitted file lost its era record, the next open
//      judged it "unrecorded answers = April", and the April form's first save
//      wiped every August-only answer.
//   2. Unrecorded answers are placed by their OWN labels: August markers with
//      no April marker prove the August form. Anything else stays on April.
//   3. Slots saved against a form WITHOUT April/August editions — the Express
//      Entry profile form (F6) that PNP / Federal PR / CEC-profile cases fill
//      alongside F1 — no longer pin F1 to April.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const svc      = require('../src/services/htmlQuestionnaireService');
const oneDrive = require('../src/services/oneDriveService');
const { LEGACY_FORM_FILES, FORM_EDITION_MARKERS } = require('../config/questionnaireFormMap');

function stub(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

const AUG1 = '1. Express Entry - PNP - PR Application -  Questionnaire - August 2026.html';
const APR1 = '1. Express Entry - PNP - PR Application -  Questionnaire - April 2025.html';
const AUG2 = '2. Work Permit Application Inside Canada (PGWP -SOWP- BOWP -LMIA - EXTENSION  - Questionnaire - August 2026.html';
const APR2 = '2. Work Permit Application Inside Canada (PGWP -SOWP- BOWP -LMIA - EXTENSION  - Questionnair - April 2025.html';
const F6   = '6. Express Entry Profile - PNP Profile Creation - Questionnair - July 2025.html';

let N = 0;
const freshRef = () => `2026-ER-${String(++N).padStart(3, '0')}`;
async function resolveWith(byFilename, formFiles) {
  const restore = stub(oneDrive, 'readFile', async ({ filename }) => {
    for (const [frag, payload] of Object.entries(byFilename || {})) {
      if (filename.includes(frag)) {
        if (payload === 'THROW') throw new Error('429 too many requests');
        return Buffer.from(JSON.stringify(payload));
      }
    }
    return null;
  });
  try { return await svc.versionFormFilesForCase({ clientName: 'T', caseRef: freshRef(), formFiles }); }
  finally { restore(); }
}
const answer = (label, value = 'x') => ({ section: 'S', label, key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), value });

// ─── The markers are pinned to the form files ────────────────────────────────

const FORMS_DIR = path.join(__dirname, '..', 'Questionnair Documents');
function decode(t) {
  return t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&(rsquo|lsquo|#39|apos);/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}
// Normalised exactly as the runtime matcher (_editionLabel) compares: apostrophes
// folded, whitespace collapsed, case ignored — so a label that differs from the
// other edition only in capitals can never pass as a marker.
const norm = (t) => decode(t).replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
function labelTexts(html) {
  const out = new Set();
  for (const tag of ['label', 'th']) {
    for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))) {
      const t = norm(m[1].replace(/<[^>]+>/g, ''));
      if (t) out.add(t);
    }
  }
  return out;
}
function anyTexts(html) {
  const s = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const out = new Set(s.split(/<[^>]+>/).map(norm));
  for (const tag of ['label', 'th', 'td', 'legend', 'span', 'p', 'div', 'option']) {
    for (const m of s.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))) out.add(norm(m[1].replace(/<[^>]+>/g, '')));
  }
  out.delete('');
  return out;
}

test('edition markers are exactly the labels that exist on one edition and appear nowhere in the other', () => {
  assert.deepEqual(Object.keys(FORM_EDITION_MARKERS).sort(), Object.keys(LEGACY_FORM_FILES).sort(), 'every refreshed form has markers');
  for (const [current, legacy] of Object.entries(LEGACY_FORM_FILES)) {
    const cur = fs.readFileSync(path.join(FORMS_DIR, current), 'utf8');
    const leg = fs.readFileSync(path.join(FORMS_DIR, legacy), 'utf8');
    const curAny = anyTexts(cur), legAny = anyTexts(leg);
    const derivedCurrent = [...labelTexts(cur)].filter((t) => !legAny.has(t)).sort();
    const derivedLegacy  = [...labelTexts(leg)].filter((t) => !curAny.has(t)).sort();
    const cfg = (list) => [...new Set(list.map(norm))].sort();
    assert.deepEqual(cfg(FORM_EDITION_MARKERS[current].current), derivedCurrent, `${current}: August markers`);
    assert.deepEqual(cfg(FORM_EDITION_MARKERS[current].legacy), derivedLegacy, `${current}: April markers`);
    assert.equal(cfg(FORM_EDITION_MARKERS[current].current).length, FORM_EDITION_MARKERS[current].current.length, 'no two markers differ only in case');
    assert.ok(derivedCurrent.length > 0, 'the August edition is identifiable');
  }
});

// ─── Unrecorded files are placed by their own labels ──────────────────────────

test('THE PATH: a submitted August file with no era record reopens on the August form', async () => {
  const r = await resolveWith({ '-primary.json': { completionPct: 92, fields: [
    answer('Given Name', 'Dev'),
    answer('NOC Code (if known) — Row 1', ''),
    answer("Father's Family Name at Birth", 'Patel'),
  ] } }, { primary: AUG1, additional: null });
  assert.equal(r.primary, AUG1);
});

test('unrecorded answers typed on the April form still open on April — and so does a file with no marker', async () => {
  let r = await resolveWith({ '-primary.json': { fields: [answer('City & Country — Row 1', 'Jaipur')] } }, { primary: AUG1, additional: null });
  assert.equal(r.primary, APR1);
  r = await resolveWith({ '-primary.json': { fields: [answer('Family Name (Surname)', 'Sharma')] } }, { primary: AUG1, additional: null });
  assert.equal(r.primary, APR1, 'no evidence → the safe April default');
});

test('a file carrying markers of BOTH editions stays on April', async () => {
  const r = await resolveWith({ '-primary.json': { fields: [
    answer('NOC Code (if known) — Row 1', '62020'), answer('City & Country — Row 2', 'Jaipur'),
  ] } }, { primary: AUG1, additional: null });
  assert.equal(r.primary, APR1);
});

test('an explicit April record still outranks August-looking labels', async () => {
  const r = await resolveWith({ '-primary.json': { formFile: APR1, fields: [answer('NOC Code (if known) — Row 1', '62020')] } },
    { primary: AUG1, additional: null });
  assert.equal(r.primary, APR1);
});

test('prefill-only August labels never decide anything (an untouched case is already August)', async () => {
  const r = await resolveWith({ '-primary.json': { fields: [{ ...answer('City & Country — Row 1', 'Jaipur'), source: 'prefill' }] } },
    { primary: AUG1, additional: null });
  assert.equal(r.primary, AUG1);
});

test('labels match through curly apostrophes, extra spaces and row numbers; unknown forms say unknown', () => {
  assert.equal(svc.editionFromLabels([{ label: 'Mother’s   Family Name at Birth' }], AUG1), 'current');
  assert.equal(svc.editionFromLabels([{ label: 'NOC Code (if known) — Row 13' }], AUG1), 'current');
  assert.equal(svc.editionFromLabels([{ label: 'City & Country — Row 12' }], AUG1), 'legacy');
  assert.equal(svc.editionFromLabels([{ label: 'Given Name' }], AUG1), 'unknown');
  assert.equal(svc.editionFromLabels([{ label: 'NOC Code (if known)' }], F6), 'unknown');
  assert.equal(svc.editionFromLabels(null, AUG1), 'unknown');
});

test('the work permit form (F2): August and April files are told apart', async () => {
  let r = await resolveWith({ '-primary.json': { fields: [answer('City (Address with Postal Code) — Row 2', 'Brampton')] } }, { primary: AUG2, additional: null });
  assert.equal(r.primary, AUG2);
  r = await resolveWith({ '-primary.json': { fields: [answer('City — Row 1', 'Brampton')] } }, { primary: AUG2, additional: null });
  assert.equal(r.primary, APR2);
});

// ─── PNP pairing: the profile form (F6) says nothing about F1's era ───────────

test('PNP pairing: answers on the Express Entry profile form never switch F1 to April', async () => {
  const pnp = { primary: F6, additional: AUG1 };
  let r = await resolveWith({ '-primary.json': { formFile: F6, fields: [answer('Family Name', 'Sharma')] } }, pnp);
  assert.equal(r.primary, F6);
  assert.equal(r.additional, AUG1, 'a recorded profile-form file is not an F1 April signal');
  r = await resolveWith({ '-primary.json': { fields: [answer('Family Name', 'Sharma')] } }, pnp);
  assert.equal(r.additional, AUG1, 'nor are unrecorded profile-form answers');
  r = await resolveWith({ '-primary.json': { formFile: F6, fields: [answer('Family Name', 'Sharma')] },
    '-primary-additional.json': { formFile: AUG1, fields: [answer('NOC Code (if known) — Row 1', '62020')] } }, pnp);
  assert.equal(r.additional, AUG1, 'F1 begun on August stays August');
});

test('PNP pairing: F1\'s own April answers still pin F1 to April (slot and member slot)', async () => {
  const pnp = { primary: F6, additional: AUG1 };
  let r = await resolveWith({ '-primary-additional.json': { fields: [answer('City & Country — Row 1', 'Jaipur')] } }, pnp);
  assert.equal(r.additional, APR1);
  r = await resolveWith({
    'questionnaire-members-': { members: [{ key: 'primary' }, { key: 'spouse' }] },
    '-spouse.json': { fields: [answer('Family Name', 'Rao')] },                       // F6 member slot — ignored
    '-spouse-additional.json': { fields: [answer('Current City & Country of Residence — Row 1', 'Jaipur')] },
  }, pnp);
  assert.equal(r.additional, APR1, 'the spouse\'s F1 April answers pin F1');
  r = await resolveWith({
    'questionnaire-members-': { members: [{ key: 'primary' }, { key: 'spouse' }] },
    '-spouse.json': { fields: [answer('Family Name', 'Rao')] },
  }, pnp);
  assert.equal(r.additional, AUG1, 'the spouse\'s profile-form answers do not');
});

test('PNP pairing: a storage blip on the profile-form slot does not fail the page', async () => {
  const r = await resolveWith({ '-primary.json': 'THROW' }, { primary: F6, additional: AUG1 });
  assert.equal(r.additional, AUG1);
});

test('family members: a blip on a profile-form member slot is ignored; on an F1 member slot it fails loudly', async () => {
  const pnp = { primary: F6, additional: AUG1 };
  const manifest = { 'questionnaire-members-': { members: [{ key: 'primary' }, { key: 'spouse' }] } };
  const r = await resolveWith({ ...manifest, '-spouse.json': 'THROW' }, pnp);
  assert.equal(r.additional, AUG1);
  await assert.rejects(resolveWith({ ...manifest, '-spouse-additional.json': 'THROW' }, pnp), (e) => e.transient === true);
});

test('the old standalone additional key on a single-form case stays conservative (no label verdict)', async () => {
  const r = await resolveWith({ '-additional.json': { fields: [answer('NOC Code (if known) — Row 1', '62020')] } }, { primary: AUG1, additional: null });
  assert.equal(r.primary, APR1, 'a slot with no form of its own is never judged by labels');
});

// ─── Round 2: evidence across slots (a child's form hides the marker sections) ─

const familyOf = (...keys) => ({ 'questionnaire-members-': { members: [{ key: 'primary' }, ...keys.map((key) => ({ key }))] } });
const childFields = [answer('Given Name', 'Kid'), answer('Date of Birth (DD/MM/YYYY)', '01/01/2015')];   // no education/employment tables

test('THE FAMILY PATH: a work-permit family with a child, submitted on August, reopens on August', async () => {
  let r = await resolveWith({ ...familyOf('child-1'),
    '-primary.json': { fields: [answer('Given Name', 'Parent'), answer('City (Address with Postal Code) — Row 1', 'Brampton')] },
    '-child-1.json': { fields: childFields },
  }, { primary: AUG2, additional: null });
  assert.equal(r.primary, AUG2, 'the child\'s marker-less file does not outvote the parent\'s August labels');
  r = await resolveWith({ ...familyOf('child-1'),
    '-primary.json': { formFile: AUG2, fields: [answer('Given Name', 'Parent')] },
    '-child-1.json': { fields: childFields },
  }, { primary: AUG2, additional: null });
  assert.equal(r.primary, AUG2, 'an August record with client answers is proof too');
});

test('marker-less answers still pin April without proof — prefill-only records prove nothing', async () => {
  let r = await resolveWith({ ...familyOf('child-1'), '-child-1.json': { fields: childFields } }, { primary: AUG2, additional: null });
  assert.equal(r.primary, APR2, 'no slot proves August');
  r = await resolveWith({ ...familyOf('child-1'),
    '-primary.json': { formFile: AUG2, fields: [{ ...answer('Given Name', 'Seeded'), source: 'prefill' }] },
    '-child-1.json': { fields: childFields },
  }, { primary: AUG2, additional: null });
  assert.equal(r.primary, APR2, 'our own pre-fill is not the client typing on August');
});

test('any April evidence still wins over August proof', async () => {
  const r = await resolveWith({ ...familyOf('child-1'),
    '-primary.json': { fields: [answer('NOC Code (if known) — Row 1', '62020')] },
    '-child-1.json': { fields: [answer('City — Row 1', 'Jaipur')] },
  }, { primary: AUG2, additional: null });
  assert.equal(r.primary, APR2);
});

test('August proof with a marker-less slot AND a failed read still fails loudly', async () => {
  await assert.rejects(resolveWith({ ...familyOf('child-1', 'child-2'),
    '-primary.json': { fields: [answer('NOC Code (if known) — Row 1', '62020')] },
    '-child-1.json': { fields: childFields },
    '-child-2.json': 'THROW',
  }, { primary: AUG2, additional: null }), (e) => e.transient === true);
});

test('a storage blip on an F1 slot still fails loudly (never a guessed era)', async () => {
  await assert.rejects(resolveWith({ '-primary.json': 'THROW' }, { primary: AUG1, additional: null }), (e) => e.transient === true);
});

// ─── Submit sends the era ─────────────────────────────────────────────────────

test('Submit sends the served form edition — the single submit and every member of the family submit', () => {
  const src = fs.readFileSync(require.resolve('../src/services/htmlQuestionnaireService.js'), 'utf8');
  const singleAt = src.indexOf("'/submit', {");
  const single = src.slice(singleAt, src.indexOf('}),', singleAt));
  assert.match(single, /formFile:\s+FORM_FILE/, 'single submit body');
  const pushAt = src.indexOf('memberSubs.push({');
  const push = src.slice(pushAt, src.indexOf('});', pushAt));
  assert.match(push, /formFile:\s+FORM_FILE/, 'each member submission');
  assert.match(src, /members: memberSubs, formFile: FORM_FILE/, 'family submit body');
  const r = fs.readFileSync(require.resolve('../src/routes/htmlQuestionnaireForm.js'), 'utf8');
  assert.match(r, /validSaveFormFile\(formFiles, key, \(req\.body \|\| \{\}\)\.formFile\)/, 'the submit route records the validated echo');
  assert.match(r, /validSaveFormFile\(formFiles, subKey, sub\.formFile \|\| \(req\.body \|\| \{\}\)\.formFile\)/, 'the family submit route too');
});
