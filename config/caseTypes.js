/**
 * Master Case Type & Sub Type reference.
 * Source: Applications- Subtypes- Document Checklists-Questionnaire.xlsx
 * Confirmed by client: April 2026
 *
 * Structure:
 *   caseType  — label used in "Primary Case Type" dropdown across all boards
 *   subTypes  — labels used in "Case Sub Type" dropdown (empty array = no sub-types)
 *   tbf       — checklist / questionnaire not yet finalised
 */

const CASE_TYPES = [
  { caseType: 'AAIP',                                                          subTypes: ['Express Entry Stream', 'Opportunity Stream', 'Rural Renewal Stream', 'Tourism & Hospitality Stream'] },
  { caseType: 'Addition of Spouse',                                            subTypes: [] },
  { caseType: 'Amendment of Document',                                         subTypes: [], tbf: true },
  { caseType: 'Appeal',                                                         subTypes: [], tbf: true },
  { caseType: 'BCPNP',                                                          subTypes: ['BC PNP+ Company Info'] },
  { caseType: 'BOWP',                                                           subTypes: [] },
  { caseType: 'Canadian Experience Class (EE after ITA)',                       subTypes: ['CEC Accompanying Spouse & Child', 'CEC Single Applicant'] },
  { caseType: 'Canadian Experience Class (Profile Recreation+ITA+Submission)',  subTypes: ['CEC Accompanying Spouse & Child', 'CEC Single Applicant'] },
  { caseType: 'Canadian Experience Class (Profile+ITA+Submission)',             subTypes: ['CEC Accompanying Spouse & Child', 'CEC Single Applicant'] },
  { caseType: 'Child Sponsorship',                                              subTypes: [] },
  { caseType: 'Citizenship',                                                    subTypes: [] },
  { caseType: 'Co-op WP',                                                       subTypes: [] },
  { caseType: 'Concurrent WP',                                                  subTypes: [] },
  { caseType: 'Employer Portal',                                                subTypes: [], tbf: true },
  { caseType: 'ETA',                                                            subTypes: [] },
  { caseType: 'Federal PR',                                                     subTypes: ['Non Express Entry - Accompanying Spouse & Child', 'Non Express Entry - Non Accompanying Spouse'] },
  { caseType: 'Francophone Mobility WP',                                        subTypes: [] },
  { caseType: 'H & C',                                                          subTypes: [], tbf: true },
  { caseType: 'ICAS/WES/IQAS',                                                  subTypes: [], tbf: true },
  { caseType: 'Inland Spousal Sponsorship',                                     subTypes: ['Common Law Partner', 'Marriage'] },
  { caseType: 'Invitation Letter',                                              subTypes: [], tbf: true },
  { caseType: 'LMIA',                                                           subTypes: [], tbf: true },
  { caseType: 'LMIA Based WP',                                                  subTypes: ['Extension (Inside Canada)', 'Inside Canada', 'Outside Canada'] },
  { caseType: 'LMIA Exempt WP',                                                 subTypes: [] },
  { caseType: 'Manitoba PNP',                                                   subTypes: [], tbf: true },
  { caseType: 'Miscellaneous',                                                  subTypes: [] },
  { caseType: 'NB WP Extension',                                                subTypes: [] },
  { caseType: 'Notary',                                                         subTypes: [] },
  { caseType: 'NSNP',                                                           subTypes: [] },
  { caseType: 'OCI / Passport Surrender',                                       subTypes: [], tbf: true },
  { caseType: 'OINP',                                                           subTypes: ['Foreign Worker Stream', 'Human Capital Priorities Stream', 'In-demand Skills Stream', 'International Student Stream', 'Masters Graduate Stream', 'PhD Graduate Stream', 'Skilled Trades Stream'] },
  { caseType: 'Outland Spousal Sponsorship',                                    subTypes: [] },
  { caseType: 'Parents/Grandparents Sponsorship',                               subTypes: [] },
  { caseType: 'PFL',                                                            subTypes: [] },
  { caseType: 'PGWP',                                                           subTypes: ['Extension - Accompanying Spouse/Child', 'Extension - Single Applicant', 'Single Applicant'] },
  { caseType: 'PR Card Renewal',                                                subTypes: [] },
  { caseType: 'PRAA',                                                           subTypes: [], tbf: true },
  { caseType: 'PRTD',                                                           subTypes: [] },
  { caseType: 'RCIP',                                                           subTypes: [], tbf: true },
  { caseType: 'Reconsideration',                                                subTypes: [] },
  { caseType: 'Refugee',                                                        subTypes: [], tbf: true },
  { caseType: 'Refugee WP',                                                     subTypes: [], tbf: true },
  { caseType: 'Renunciation of PR',                                             subTypes: [] },
  { caseType: 'Request Letter',                                                 subTypes: [] },
  { caseType: 'RNIP',                                                           subTypes: [], tbf: true },
  { caseType: 'SCLPC WP',                                                       subTypes: [] },
  { caseType: 'SNIP',                                                           subTypes: [], tbf: true },
  { caseType: 'SOWP',                                                           subTypes: ['Extension (Spouse or Child)', 'Inland - Established Relationship', 'Inland - Non Established Relationship', 'Outland (Spouse or Child)'] },
  { caseType: 'Study Permit',                                                   subTypes: ['Change of Status (Visitor to Student)', 'Dependent Child (Outland)', 'Non SDS - Accompanying Spouse or Child', 'Single Applicant'] },
  { caseType: 'Study Permit Extension',                                         subTypes: ['Accompanying Spouse or Child', 'Single Applicant'] },
  { caseType: 'Supervisa',                                                      subTypes: ['Grandparents', 'Parents'] },
  { caseType: 'TRP',                                                            subTypes: [], tbf: true },
  { caseType: 'TRV',                                                            subTypes: [] },
  { caseType: 'USA Visa',                                                       subTypes: [] },
  { caseType: 'Visitor Record / Extension',                                     subTypes: ['Visitor Extension', 'Visitor Record', 'Visitor Record + Restoration'] },
  { caseType: 'Visitor Visa',                                                   subTypes: ['1-2 Members', '1-3 Members', 'Both Parents', 'Change of Status (Student/Worker to Visitor)', 'Parents & Siblings', 'Single Parent', 'Spousal Sponsorship in Process', 'Spouse'] },
];

// Flat sorted list of all Case Type labels (for dropdown updates)
const CASE_TYPE_LABELS = CASE_TYPES.map((c) => c.caseType).sort();

// Flat sorted list of all unique Sub Type labels across all Case Types
const SUB_TYPE_LABELS = [
  ...new Set(CASE_TYPES.flatMap((c) => c.subTypes)),
].sort();

// Lookup: caseType → subTypes[]
const SUB_TYPES_BY_CASE = Object.fromEntries(
  CASE_TYPES.map((c) => [c.caseType, c.subTypes])
);

module.exports = { CASE_TYPES, CASE_TYPE_LABELS, SUB_TYPE_LABELS, SUB_TYPES_BY_CASE };
