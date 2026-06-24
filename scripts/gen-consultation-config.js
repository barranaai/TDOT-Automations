/**
 * Dev tool — transform the verified merged field map (/tmp/merged-fields.json,
 * from the field-mapping workflow) into config/consultationFormFields.js: the
 * single source of truth for the standalone consultation form AND its Monday
 * board. Adds structured show-if rules, F-block service gating, repeatable-group
 * collapsing, and canonical option lists; excludes the optional file-upload
 * fields from v1 (documents can be emailed).
 *
 *   node scripts/gen-consultation-config.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = '/tmp/merged-fields.json';
const OUT = path.join(__dirname, '..', 'config', 'consultationFormFields.js');

// service → F-block (mirrors intakeFormService.serviceToFBlock)
const FBLOCK_SERVICES = {
  F1: ['Express Entry profile', 'Express Entry ITA and eAPR'],
  F2: ['PNP or OINP'],
  F3: ['Work permit', 'PGWP', 'BOWP', 'Status extension', 'Status restoration'],
  F4: ['Study permit'],
  F5: ['Visitor visa or TRV', 'Visitor record', 'Super Visa'],
  F6: ['Spousal sponsorship', 'Family sponsorship'],
  F7: ['PR card renewal', 'PR travel document', 'Citizenship', 'Residency obligation review', 'Name update or document correction'],
  F8: ['LMIA', 'LMIA exempt work permit', 'Employer portal submission', 'Job offer support', 'Employer compliance support'],
  F9: ['Refusal review'],
  F10: ['ATIP or GCMS notes', 'Webform', 'Passport request or VFS support'],
};

// structured show-if rules (override the prose conditionals from the map)
const SHOW_IF = {
  currentCountry:        { field: 'insideCanada', in: ['No'] },
  entryDate:             { field: 'insideCanada', in: ['Yes'] },
  entryVisa:             { field: 'insideCanada', in: ['Yes'] },
  spouseAccompanying:    { field: 'hasSpouse', in: ['Yes'] },
  spouseConsider:        { field: 'hasSpouse', in: ['Yes'] },
  childrenAccompanying:  { field: 'childrenCount', gt: 0 },
  relativeRelationship:  { field: 'relativesInCanada', in: ['Yes'] },
  statusExpiry:          { field: 'currentStatus', in: ['Visitor', 'Student', 'Worker'] },
  recentExtensionDetails:{ field: 'recentExtension', in: ['Yes'] },
  englishTestType:       { field: 'englishTest', in: ['Yes'] },
  engListening:          { field: 'englishTest', in: ['Yes'] },
  engReading:            { field: 'englishTest', in: ['Yes'] },
  engWriting:            { field: 'englishTest', in: ['Yes'] },
  engSpeaking:           { field: 'englishTest', in: ['Yes'] },
  frListening:           { field: 'frenchTest', in: ['Yes'] },
  frReading:             { field: 'frenchTest', in: ['Yes'] },
  frWriting:             { field: 'frenchTest', in: ['Yes'] },
  frSpeaking:            { field: 'frenchTest', in: ['Yes'] },
  existingFileType:      { field: 'relationshipWithTdot', in: ['Existing client with active application', 'Previous client with completed or inactive application'] },
  deadlineDate:          { field: 'urgentDeadline', in: ['Yes'] },
  deadlineReason:        { field: 'urgentDeadline', in: ['Yes'] },
  restorationDeadline:   { field: 'restorationPeriod', in: ['Yes'] },
  refusalType:           { field: 'recentRefusal', in: ['Yes'] },
  refusalDate:           { field: 'recentRefusal', in: ['Yes'] },
  enforcementDetails:    { anyOf: [{ field: 'removalOrder', in: ['Yes'] }, { field: 'enforcementLetter', in: ['Yes'] }] },
  // nested inside F-blocks
  f1_itaDeadline:        { field: 'f1_hasIta', in: ['Yes'] },
  f1_program:            { field: 'f1_hasIta', in: ['Yes'] },
};

// option-list overrides where the merged map under-specified
const OPTIONS = {
  relationshipWithTdot: ['New inquiry', 'Existing client with active application', 'Previous client with completed or inactive application'],
  whatDoYouWant: ['Book consultation', 'Start new application', 'Request quote', 'Existing file update', 'General information'],
  howHeard: ['Existing client', 'Referral', 'Social media', 'Google', 'Website', 'Walk in', 'Event'],
  deadlineReason: ['ITA deadline', 'Passport request deadline', 'Restoration deadline', 'Status expiry', 'CBSA or removal matter', 'Hearing or appointment', 'PNP deadline', 'Employer deadline', 'School deadline', 'Other'],
  refusalType: ['Visitor visa', 'Study permit', 'Work permit', 'Spousal sponsorship', 'PR application', 'Express Entry', 'PNP', 'Refugee or H and C', 'Other'],
  f9_refusalType: ['Visitor visa', 'Study permit', 'Work permit', 'Spousal sponsorship', 'PR application', 'Express Entry', 'PNP', 'Refugee or H and C', 'Other'],
  currentStatus: ['Visitor', 'Student', 'Worker', 'Permanent Resident', 'Citizen', 'Maintained Status', 'Out of Status', 'Not in Canada', 'Other'],
};

const SERVICE_GROUPS = {
  'Permanent Residence': ['Express Entry profile', 'Express Entry ITA and eAPR', 'PNP or OINP', 'Spousal sponsorship', 'Family sponsorship', 'Caregiver pathway', 'Humanitarian and compassionate', 'PR application review'],
  'Temporary Residence': ['Study permit', 'Work permit', 'PGWP', 'BOWP', 'Visitor visa or TRV', 'Visitor record', 'Super Visa', 'Status extension', 'Status restoration'],
  'After PR Services': ['PR card renewal', 'PR travel document', 'Citizenship', 'Residency obligation review', 'Name update or document correction'],
  'Employer Services': ['LMIA', 'LMIA exempt work permit', 'Employer portal submission', 'Job offer support', 'Employer compliance support'],
  'Other Support': ['Refusal review', 'ATIP or GCMS notes', 'Webform', 'Passport request or VFS support', 'Document review', 'Case strategy consultation', 'Other'],
};

const SECTION_ORDER = [
  'Personal & Contact', 'Family', 'Immigration Status', 'Education', 'Employment',
  'Language', 'Your Relationship With TDOT', 'Service Needed', 'Service-Specific Questions',
  'Urgency', 'Final Notes', 'How You Found Us & Consent',
];

// serviceRequired has ~30 options — a dropdown, not a status column (and its
// board options should match the form's grouped service list).
const MONDAYTYPE = { serviceRequired: 'dropdown' };
OPTIONS.serviceRequired = Object.values(SERVICE_GROUPS).flat();

const merged = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const raw = merged.fields || merged.result.fields;

function blockOf(key) { const m = /^f(\d+)/.exec(key); return m ? ('F' + m[1]) : null; }

const fields = [];
const groups = {}; // education / employment repeatables

for (const f of raw) {
  if (f.type === 'file') continue; // v1: documents emailed, not uploaded
  const m = /^(education|employment)\[N\]\[(\w+)\]$/.exec(f.key);
  if (m) {
    const g = m[1];
    (groups[g] = groups[g] || { group: g, section: f.section, sub: [] }).sub.push({
      key: m[2], label: f.label, type: f.type, options: f.options || [], mondayType: f.mondayType,
    });
    continue;
  }
  const block = blockOf(f.key);
  const out = {
    key: f.key, label: f.label, section: f.section, type: f.type,
    options: OPTIONS[f.key] || f.options || [], required: !!f.required, mondayType: MONDAYTYPE[f.key] || f.mondayType,
  };
  if (block) out.block = block;
  if (SHOW_IF[f.key]) out.showIf = SHOW_IF[f.key];
  fields.push(out);
}

const out =
`/**
 * Consultation form — merged, de-duplicated field config (intake + pre-consult).
 * GENERATED by scripts/gen-consultation-config.js from the verified field map.
 * Single source of truth for the form UI AND the Monday board columns.
 * ${fields.length} fields + ${Object.keys(groups).length} repeatable groups across ${SECTION_ORDER.length} sections.
 */
'use strict';

const SECTION_ORDER = ${JSON.stringify(SECTION_ORDER, null, 2)};
const SERVICE_GROUPS = ${JSON.stringify(SERVICE_GROUPS, null, 2)};
const FBLOCK_SERVICES = ${JSON.stringify(FBLOCK_SERVICES, null, 2)};
const FIELDS = ${JSON.stringify(fields, null, 2)};
const GROUPS = ${JSON.stringify(Object.values(groups), null, 2)};

module.exports = { SECTION_ORDER, SERVICE_GROUPS, FBLOCK_SERVICES, FIELDS, GROUPS };
`;

fs.writeFileSync(OUT, out);
console.log(`Wrote ${path.relative(process.cwd(), OUT)} — ${fields.length} fields, ${Object.keys(groups).length} groups`);
console.log('Sections:', SECTION_ORDER.join(' · '));
console.log('Groups:', Object.keys(groups).map((g) => `${g}(${groups[g].sub.length} cols)`).join(', '));
