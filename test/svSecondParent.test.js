'use strict';

// Super Visa: both parents usually apply, but the second parent is on the case
// only when someone adds them — as an accompanying Spouse. On 2026-10-23 none
// of the 21 Super Visa cases had one (2026-SV-021, SV-017, SV-004 named two
// people). The retainer panel now asks, Retain & send double-checks, and the
// Needs-attention list flags a Super Visa named for two people with no Spouse.

const test   = require('node:test');
const assert = require('node:assert/strict');
const vm     = require('vm');
const fs     = require('fs');

const NA = require('../src/services/needsAttentionService');

/* ───────────────────────── the Needs-attention rule ───────────────────────── */

const H = 3600 * 1000, D = 24 * H;
const NOW = Date.parse('2026-10-24T15:00:00Z');
let seq = 0;
function item({ id = String(5000 + (++seq)), name = 'Udhav Raj Sharma & Meena Sharma', createdAgo = 30 * D, ref = '2026-SV-021', caseType = 'Supervisa', subType = 'Parents', stage = 'Document Collection Started', payment = 'Paid', paidDate = '2026-09-29', group = 'group_mm6sykds', groupTitle = 'September  2026' } = {}) {
  const cv = [['text_mm142s49', ref], ['dropdown_mm0xd1qn', caseType], ['dropdown_mm0x4t91', subType], ['color_mm0x8faa', stage], ['color_mm0x9fnn', payment], ['date_mm0xgk76', paidDate], ['multiple_person_mm0xhmgk', ''], ['multiple_person_mm2nhsx1', '']].map(([cid, text]) => ({ id: cid, text, value: null }));
  return { id, name, created_at: new Date(NOW - createdAgo).toISOString(), group: { id: group, title: groupTitle }, column_values: cv, updates: [] };
}
const run = (items, family) => NA.detect({ cases: items.map(NA.parseCase), family: new Map(Object.entries(family || {})), now: NOW }).filter((e) => e.kind === 'sv-second-parent');
const EMPTY = { '2026-SV-021': new Set() };

test('Needs attention: a paid Super Visa named for two people with no Spouse on the board is listed; a Spouse row clears it', () => {
  NA.io.now = () => NOW;
  const r = run([item()], EMPTY);
  assert.equal(r.length, 1);
  assert.match(r[0].why, /named for two people \("Udhav Raj Sharma & Meena Sharma"\), but the Family Members board has no second parent \(Spouse\)/);
  assert.match(r[0].todo, /➕ Add family member" → Spouse/);
  assert.match(r[0].todo, /If only one parent is applying, press Mark handled/);
  assert.ok(r[0].since.startsWith('2026-09-29'));
  assert.equal(run([item()], { '2026-SV-021': new Set(['Spouse']) }).length, 0);
  const parent = run([item()], { '2026-SV-021': new Set(['Parent']) });
  assert.equal(parent.length, 1, 'a "Parent" row is not the second parent…');
  assert.match(parent[0].why, /on the Family Members board as "Parent" — a Super Visa has no documents for that type/);
  assert.match(parent[0].todo, /changed from Parent to Spouse[\s\S]*then flip Re-seed Checklist → Run so their documents are added — adding them again with ➕ Add family member would list the same person twice/, '…the documents step too, and never "add them again"');
  assert.notEqual(parent[0].key, r[0].key, 'its own Mark handled key');
  assert.equal(run([item()], { '2026-SV-021': new Set(['Sponsor', 'Principal Applicant']) }).length, 1);
});

test('Needs attention: the real two-person names count ("&", "and", "/", "+"); a one-person name never does', () => {
  NA.io.now = () => NOW;
  for (const name of ['Sob George and LISSY ISSAC', 'Gurpreet Kaur  & Gurmeet Singh (0401)', 'MOHAMMED ABDUL NOOR / NAHEDA BEGUM', 'Ajay Kumar Sharma/Meena Sharma(2732)', 'Ram + Sita']) {
    assert.equal(run([item({ name })], EMPTY).length, 1, name);
  }
  for (const name of ['Kulwant Kaur', 'Anand Sharma', 'Sandra Kaur', 'Mangalmaya Tandukar']) {
    assert.equal(run([item({ name })], EMPTY).length, 0, name);
  }
});

test('Needs attention: only a live, paid Super Visa past Retainer Confirmed; a legacy-group case counts (SV-017); test / finished / unread / just-paid never', () => {
  NA.io.now = () => NOW;
  assert.equal(run([item({ caseType: 'Super Visa' })], EMPTY).length, 1, 'the spelling with a space');
  assert.equal(run([item({ caseType: 'Visitor Visa' })], EMPTY).length, 0);
  assert.equal(run([item({ payment: 'Signed (Unpaid)', paidDate: '' })], EMPTY).length, 0, 'unpaid: the retainer panel still has its turn');
  for (const stage of ['', 'Not Started', 'Pre-Onboarding', 'Retainer Confirmed']) assert.equal(run([item({ stage })], EMPTY).length, 0, stage || '(blank)');
  for (const stage of ['Internal Review', 'Stuck']) assert.equal(run([item({ stage })], EMPTY).length, 1, stage);
  for (const stage of ['Application Submitted', 'Cancelled', 'Approved']) assert.equal(run([item({ stage })], EMPTY).length, 0, stage);
  assert.equal(run([item({ group: 'group_mm3t4kda', groupTitle: 'Retainers before May 2026' })], EMPTY).length, 1, 'legacy group: still flagged');
  assert.equal(run([item({ group: 'group_mm3842s', groupTitle: 'TEST' })], EMPTY).length, 0);
  assert.equal(run([item()], { '2026-SV-021': null }).length, 0, 'unread → no claim');
  assert.equal(run([item()], {}).length, 0);
  assert.equal(run([item({ paidDate: '2026-10-24' })], EMPTY).length, 0, 'paid today: set-up window');
  assert.equal(run([item({ ref: '' })], EMPTY).length, 0);
});

test('Needs attention snapshot: Super Visa cases named for two people are read from the Family Members board only — never the checklist or the questionnaire; single-name ones are not read', async () => {
  NA._resetForTests(); NA.io.now = () => NOW;
  const reads = [], clReads = [], mfReads = [];
  const real = { ...NA.io };
  Object.assign(NA.io, {
    readCases: async () => [item({ id: '6001', ref: '2026-SV-021' }), item({ id: '6002', ref: '2026-SV-016', name: 'Kulwant Kaur' }), item({ id: '6003', ref: '2026-SV-004', name: 'Gurpreet Kaur & Gurmeet Singh', stage: 'Internal Review' })],
    hasChecklist: async () => true, listRootFolders: async () => [], workFoldersPresent: async () => true,
    readDeepNotes: async () => ({ notes: new Map(), failed: [] }), newestChecklistRowAt: async () => 0, postNote: async () => {},
    familyTypes: async (ref) => { reads.push(ref); return ref === '2026-SV-004' ? new Set(['Spouse']) : new Set(); },
    checklistMemberTypes: async (ref) => { clReads.push(ref); return new Set(); },
    manifestMemberTypes: async (ref) => { mfReads.push(ref); return new Set(); },
    leadBalances: async () => [],
  });
  try {
    const snap = await NA.buildSnapshot();
    assert.deepEqual(reads.sort(), ['2026-SV-004', '2026-SV-021']);
    assert.deepEqual([clReads, mfReads], [[], []]);
    assert.deepEqual(snap.entries.filter((e) => e.kind === 'sv-second-parent').map((e) => e.caseRef), ['2026-SV-021']);
  } finally { Object.assign(NA.io, real); }
});

test('Needs attention: the group has its label and order', () => {
  const src = fs.readFileSync(require.resolve('../src/services/needsAttentionService.js'), 'utf8');
  assert.match(src, /'sv-second-parent':\{ order: 44, severity: 'high', label: 'Super Visa: second parent not on the case as Spouse' \}/);
});

/* ───────────────────────── the retainer panel ───────────────────────── */

const HTML = require('../src/routes/adminConsultation').buildDetailHTML('12345');
const JS = HTML.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi).map((s) => s.replace(/^<script[^>]*>|<\/script>$/gi, '')).find((s) => s.includes('function svSendCheck'));

/** The panel's Super Visa helpers, run against a tiny stand-in for the page. */
function panel({ caseType = 'Supervisa', family = [], signed = false, retained = false, sent = false, locked = false, amend = false } = {}) {
  const a = JS.indexOf('function rpIsSuperVisa(){'), b = JS.indexOf('function feeCentsNow(){');
  assert.ok(a > 0 && b > a);
  const els = { 'rp-casetype': { value: caseType }, 'rp-sv': { style: {} }, 'rp-sv-add': { style: {} }, 'rp-sv-hint': {} };
  // signed = signed (or retained) with the case open — the list has been used; retained = signed, no case yet
  const ctx = { RP_PLAN_CT: caseType, RP_LIST_USED: signed, RP_RETAINED: retained || signed, RP_SENT: sent, RP_LOCKED: locked || sent || retained || signed, RP_AMEND: amend,
    rpEl: (id) => els[id] || null, collectFamily: () => family };
  vm.runInNewContext(JS.slice(a, b), ctx);
  ctx.view = () => { ctx.rpUpdateSvQuestion(); return { shown: els['rp-sv'].style.display !== 'none', add: els['rp-sv-add'].style.display !== 'none', need: /\bneed\b/.test(els['rp-sv-hint'].className), text: els['rp-sv-hint'].textContent }; };
  return ctx;
}
const SP = (name = 'Meena Sharma', acc = true) => ({ type: 'Spouse', name, accompanying: acc });
const PA = (acc = true) => ({ type: 'Parent', name: 'Meena', accompanying: acc });

test('panel: the box sits inside the lockable part of the plan, above the family list; the page script parses; the Super Visa pattern survives the template (\\s, not s); the hint is plain text', () => {
  const fsAt = HTML.indexOf('<fieldset id="rp-lock-fs"'), fsEnd = HTML.indexOf('</fieldset>', fsAt);
  const q = HTML.indexOf('id="rp-sv"'), table = HTML.indexOf('id="family-table"');
  assert.ok(fsAt > 0 && q > fsAt && q < fsEnd && q < table, 'inside #rp-lock-fs, before the family table');
  assert.match(HTML, /<button class="btn" id="rp-sv-add" type="button" style="display:none;margin-top:6px">[\s\S]{0,400}?Add the second parent \(Spouse\)<\/button>/);
  assert.doesNotMatch(HTML, /type="radio" name="rp-sv-both"/, 'no stored answer — the list is the truth');
  assert.doesNotThrow(() => new vm.Script(JS));
  assert.match(JS, /return \/\^super\\s\*visa\$\/i\.test\(String\(ct\)\.trim\(\)\);/);
  assert.match(JS, /window\.confirm\(svMsg\+'\\n\\nOK sends the agreement as it is\. Cancel to change the family list first\.'\)/);
  const upd = JS.slice(JS.indexOf('function rpUpdateSvQuestion(){'), JS.indexOf('function svAddSecondParent(){'));
  assert.match(upd, /hint\.textContent=text;/); assert.doesNotMatch(upd, /innerHTML/, 'a typed name is never markup');
});

test('panel: what the box says for every list, unsigned and editable — the button only when no second parent is listed', () => {
  let v = panel().view();
  assert.deepEqual([v.shown, v.add, v.need], [true, true, true]); assert.match(v.text, /^Only one parent is listed\. If both parents are applying/);
  v = panel({ family: [SP()] }).view();
  assert.deepEqual([v.add, v.need], [false, false]); assert.equal(v.text, 'Second parent listed: Meena Sharma.');
  v = panel({ family: [SP('')] }).view(); assert.equal(v.text, 'Second parent listed: Spouse — no name yet.');
  v = panel({ family: [SP('Meena', false)] }).view(); assert.deepEqual([v.add, v.need], [true, true], 'a Spouse not ticked accompanying is not the second parent');
  v = panel({ family: [SP(), SP('Other')] }).view(); assert.deepEqual([v.add, v.need], [false, true]); assert.match(v.text, /Two Spouse rows are ticked “Accomp\.” — a Super Visa has one second parent\. Remove one\./);
  v = panel({ family: [PA()] }).view(); assert.deepEqual([v.add, v.need], [false, true]); assert.match(v.text, /listed as “Parent”[\s\S]*Change that row’s Type to Spouse/);
  v = panel({ family: [SP(), PA()] }).view(); assert.match(v.text, /if they are the same person, remove the “Parent” row/);
  v = panel({ family: [{ type: 'Dependent Child', name: 'X', accompanying: true }] }).view(); assert.match(v.text, /^Only one parent is listed/);
  v = panel({ caseType: 'BOWP' }).view(); assert.equal(v.shown, false);
  v = panel({ caseType: 'Super Visa' }).view(); assert.equal(v.shown, true, 'the spelling with a space');
});

test('panel: signed with the case open → the list no longer reaches the case: point to the case page (Parent → ask an admin, never add again), no button; sent → press Amend; signed but no case yet → Amend + Save', () => {
  let v = panel({ signed: true }).view();
  assert.deepEqual([v.add, v.need], [false, true]);
  assert.match(v.text, /^The client has signed — this list was read when the case was set up, and changes here no longer reach the case\. If both parents are applying, add the second parent on the case page: Family card → ➕ Add family member → Spouse\.$/);
  v = panel({ signed: true, family: [PA()] }).view();
  assert.match(v.text, /ask an admin to change them to Spouse — do not add them again/); assert.doesNotMatch(v.text, /Add family member/);
  v = panel({ signed: true, family: [SP()] }).view(); assert.deepEqual([v.need, v.add], [false, false]);
  assert.match(v.text, /Check that the case page’s Family card shows the second parent as Spouse \(not “Parent”\) — if they show as Parent, ask an admin to change them; do not add them again\./, 'a row retyped here is still Parent on the case');
  v = panel({ signed: true, family: [SP(), PA()] }).view(); assert.equal(v.need, true); assert.match(v.text, /ask an admin to fix it/);
  v = panel({ signed: true, amend: true }).view(); assert.equal(v.add, false, 'amending a signed plan still never offers the button');
  v = panel({ sent: true }).view(); assert.equal(v.add, false); assert.match(v.text, /^The agreement is sent — press ✎ Amend to change this list \(it reaches the case when the client signs\)\. Only one parent is listed/);
  v = panel({ sent: true, family: [SP()] }).view(); assert.equal(v.need, false); assert.match(v.text, /Second parent listed: Meena Sharma\.$/);
  v = panel({ sent: true, amend: true }).view(); assert.equal(v.add, true); assert.match(v.text, /^Only one parent is listed/);
  v = panel({ retained: true }).view(); assert.match(v.text, /^The client has signed but the case is not open yet — press ✎ Amend, fix the list and Save so the case gets it\. Only one parent is listed/);
  assert.doesNotMatch(v.text, /case page/, 'no case page to point at yet');
  v = panel({ retained: true, family: [SP()] }).view(); assert.equal(v.need, false);
  assert.equal(v.text, 'The client has signed but the case is not open yet — this list reaches the case when it opens. Second parent listed: Meena Sharma.', 'a correct list is never told to amend');
  v = panel({ retained: true, amend: true }).view(); assert.equal(v.add, true); assert.match(v.text, /^The client has signed but the case is not open yet — Only one parent is listed/);
  // the flag: the list counts as used only when the client signed (or was retained) AND the case is open
  assert.match(JS, /RP_LIST_USED = \(_retSigned \|\| _retained\) && _caseOpen;/);
});

test('panel: Retain & send asks on a Super Visa that lists one parent, or a wrong list; never on another case type; Cancel stops before the usual confirm', () => {
  assert.match(panel().svSendCheck(), /lists ONE parent\. Are both parents applying\? If so, Cancel and add the second parent as an accompanying Spouse/);
  assert.equal(panel({ family: [SP()] }).svSendCheck(), '');
  assert.match(panel({ family: [SP('', false)] }).svSendCheck(), /lists ONE parent/);
  assert.match(panel({ family: [PA()] }).svSendCheck(), /Change that row’s Type to Spouse/);
  assert.match(panel({ family: [SP(), SP('B')] }).svSendCheck(), /Two Spouse rows/);
  assert.match(panel({ family: [SP(), PA()] }).svSendCheck(), /remove the “Parent” row/);
  assert.equal(panel({ caseType: 'Visitor Visa' }).svSendCheck(), '');
  assert.equal(panel({ caseType: 'BOWP', family: [PA()] }).svSendCheck(), '');
  const h = JS.slice(JS.indexOf("rpEl('btn-retain-send').onclick=function(){"), JS.indexOf("doAction('retainAndSend', null, confirmMsg);"));
  assert.ok(h.indexOf('inviterGaps()') < h.indexOf('svSendCheck()') && h.indexOf('svSendCheck()') < h.indexOf('var confirmMsg'));
  assert.match(h, /if\(svMsg && !window\.confirm\(svMsg\+'[^']*'\)\)\{[\s\S]*?return;\s*\}/, 'Cancel stops the send');
});

test('panel: kept in step — after the list loads, when the lock state is applied (the signed flag comes after hydration), when the case type changes, on any family edit; the button adds an accompanying Spouse and marks the plan unsaved', () => {
  const hyd = JS.slice(JS.indexOf('function hydrateRetainer('), JS.indexOf('function renderRpWarnings('));
  assert.match(hyd, /rebuildFamily\(d\.familyMembers\|\|\[\]\);\s*rpUpdateSvQuestion\(\);/);
  const lock = JS.slice(JS.indexOf('function applyRetainerLock(){'), JS.indexOf('function startAmend(){'));
  assert.match(lock, /rpUpdateSvQuestion\(\);\s*\/\/ the signed state is known only after hydration/);
  assert.match(JS, /function rpPopulateSubtypes\(\)\{\s*rpUpdateAdFeeVisibility\(\);\s*rpUpdateSvQuestion\(\);/);
  assert.match(JS, /famBody\.addEventListener\('change', rpUpdateSvQuestion\)/);
  assert.match(JS, /famBody\.addEventListener\('click', function\(e\)\{ if\(e\.target&&e\.target\.getAttribute&&e\.target\.getAttribute\('data-rmf'\)\) setTimeout\(rpUpdateSvQuestion,0\); \}\);/, '✕ re-syncs too');
  assert.match(JS, /rpEl\('rp-add-family'\)\.onclick=function\(\)\{ addFamily\(\); rpUpdateSvQuestion\(\); \};/);
  assert.match(JS, /var svAdd=rpEl\('rp-sv-add'\); if\(svAdd\) svAdd\.onclick=svAddSecondParent;/);
  const add = JS.slice(JS.indexOf('function svAddSecondParent(){'), JS.indexOf('function svSendCheck(){'));
  assert.match(add, /^function svAddSecondParent\(\)\{\s*addFamily\(\);/, 'the same row the Add button makes: an accompanying Spouse');
  assert.match(JS, /function addFamily\(\)\{ var tr=document\.createElement\('tr'\); tr\.innerHTML=famRowHtml\(\{type:'Spouse',name:'',accompanying:true\}\);/);
  assert.match(add, /RP_PLAN_SAVED=false; applyRetainerLock\(\);/);
  assert.match(add, /nm\.placeholder='Second parent’s full name'/, 'a placeholder, never a name ("Second parent" would become the person\'s name on the board)');
});
