'use strict';

// The client /documents page groups a case's documents by the member's SHOWN
// name — a schema row's label, a Template row's type, a Super Visa's "Second
// parent" (2026-10-25) — exactly as it always did; a Super Visa's "First
// parent (principal applicant)" and "Second parent" take the place of the
// types they stand for in the pill order and the icons. Every other case
// type's page is what it was.

const test   = require('node:test');
const assert = require('node:assert/strict');

const page = require('../src/routes/documentUploadForm');
const G = page._groupByMemberAndCategory, A = page._aggregateMembersAcrossPhases, I = page._memberIcon;
const it = (id, applicantType, applicantLabel, category = 'Identity') => ({ id, name: 'Passport', status: 'Missing', category, applicantType, applicantLabel, templateRow: applicantLabel === applicantType });

// the live rule (fd35cc9), verbatim — what every other case type must still get
const LIVE_ORDER = ['Principal Applicant', 'Spouse / Common-Law Partner', 'Dependent Child', 'Sponsor', 'Worker Spouse'];
const LIVE_ICONS = { 'Principal Applicant': '👤', 'Spouse / Common-Law Partner': '👫', 'Dependent Child': '👶', 'Sponsor': '🤝', 'Worker Spouse': '💼' };
function liveKeys(items) {
  const m = {};
  items.forEach((i) => { m[i.applicantLabel || i.applicantType || 'Principal Applicant'] = true; });
  return LIVE_ORDER.filter((k) => m[k]).concat(Object.keys(m).filter((k) => !LIVE_ORDER.includes(k)));
}

test('other case types: the member groups, their order and their icons are exactly the live ones (schema labels, indexed children, unknown labels appended in the order they came)', () => {
  const fixtures = [
    [it('1', 'Spouse', 'Spouse / Common-Law Partner'), it('2', 'Dependent Child 1', 'Dependent Child'), it('3', 'Principal Applicant', 'Principal Applicant'), it('4', 'Dependent Child 2', 'Dependent Child 2')],
    [it('1', 'Spouse', 'Dependent Spouse'), it('2', 'Principal Applicant', 'Principal Applicant'), it('3', 'Sponsor', 'Sponsor / Inviter (in Canada)')],
    [it('1', 'Spouse / Common-Law Partner', 'Spouse / Common-Law Partner'), it('2', 'Principal Applicant', 'Principal Applicant'), it('3', 'Worker Spouse', 'Worker Spouse'), it('4', 'Non Accompanying Spouse', 'Non Accompanying Spouse')],
    [it('1', 'Dependent Child 2', 'Dependent Child 2'), it('2', 'Dependent Child 1', 'Dependent Child'), it('3', 'Principal Applicant', 'Principal Applicant')],
    // Visitor Visa (Parents & Siblings): its schema's OWN "Second Parent" label (capital P) keeps its live place after the principal, plain icon
    [it('1', 'Principal Applicant', 'Principal Applicant (Parent)'), it('2', 'Spouse', 'Second Parent'), it('3', 'Sibling 1', 'Sibling'), it('4', 'Sibling 2', 'Sibling 2'), it('5', 'Sponsor', 'Inviter (in Canada)')],
    [it('1', 'Spouse', 'Second Parent'), it('2', 'Principal Applicant', 'Principal Applicant (Parent)')],
    [it('1', '', '')],
  ];
  for (const items of fixtures) {
    const g = G(items);
    assert.deepEqual(g.members.map((m) => m.memberType), liveKeys(items), JSON.stringify(items.map((i) => i.applicantLabel)));
    assert.deepEqual(g.members.map((m) => I(m.memberType)), liveKeys(items).map((k) => LIVE_ICONS[k] || '👤'));
    assert.equal(g.isMultiMember, liveKeys(items).length > 1);
    assert.deepEqual(A([{ phase: '', members: g.members }]).map((m) => m.memberType), liveKeys(items));
  }
});

test('a Super Visa: "First parent (principal applicant)" first, "Second parent" second with the spouse icon, the sponsor after; a schema row and a Template row for the same parent land in ONE group; Grandparents the same', () => {
  const items = [it('1', 'Sponsor', 'Sponsor / Inviter (in Canada)'), it('2', 'Spouse / Common-Law Partner', 'Second parent'), it('3', 'Spouse', 'Second parent'), it('4', 'Principal Applicant', 'First parent (principal applicant)')];
  const g = G(items);
  assert.deepEqual(g.members.map((m) => [m.memberType, m.sections.flatMap((s) => s.items).length]), [['First parent (principal applicant)', 1], ['Second parent', 2], ['Sponsor / Inviter (in Canada)', 1]]);
  assert.deepEqual(g.members.map((m) => I(m.memberType)), ['👤', '👫', '👤']);
  // the Template-built case: plain "Sponsor" is a known type and still sorts after the parents
  assert.deepEqual(G([it('1', 'Sponsor', 'Sponsor'), it('2', 'Spouse / Common-Law Partner', 'Second grandparent'), it('3', 'Principal Applicant', 'First grandparent (principal applicant)')]).members.map((m) => [m.memberType, I(m.memberType)]),
    [['First grandparent (principal applicant)', '👤'], ['Second grandparent', '👫'], ['Sponsor', '🤝']]);
  // across phases the same order holds
  const phases = [{ phase: 'Profile Creation', members: G([it('9', 'Sponsor', 'Sponsor')]).members }, { phase: 'Submission', members: g.members }];
  assert.deepEqual(A(phases).map((m) => m.memberType), ['First parent (principal applicant)', 'Second parent', 'Sponsor', 'Sponsor / Inviter (in Canada)']);
  // the rendered page: the pills in that order, named that way
  const html = page._formPage('2026-SV-004', 'Test Client', g.members, true, [], null);
  const pills = [...html.matchAll(/<span class="pill-label">([\s\S]*?)<\/span>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s*⚠️\s*$/, '').trim());
  assert.deepEqual(pills.slice(0, 3), ['👤 First parent (principal applicant)', '👫 Second parent', '👤 Sponsor / Inviter (in Canada)']);
});
