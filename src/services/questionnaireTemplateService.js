const mondayApi = require('./mondayApi');
const { questionnaireTemplateBoardId } = require('../../config/monday');

// Questionnaire Template Board column IDs
const TEMPLATE_COLS = {
  questionCode: 'text_mm1235b5',
  caseSubType:  'dropdown_mm20h84d',
};

// Case type group map (title → group ID) — sourced from rebuilt Questionnaire Template Board
const GROUP_MAP = {
  'AAIP':                                                          'group_mm20sjnv',
  'Addition of Spouse':                                            'group_mm20jq48',
  'Amendment of Document':                                         'group_mm201mmw',
  'Appeal':                                                        'group_mm20t5jp',
  'BCPNP':                                                         'group_mm20d5rn',
  'BOWP':                                                          'group_mm20txp0',
  'Canadian Experience Class (EE after ITA)':                      'group_mm201d6x',
  'Canadian Experience Class (Profile Recreation+ITA+Submission)': 'group_mm203gyt',
  'Canadian Experience Class (Profile+ITA+Submission)':            'group_mm20jyw',
  'Child Sponsorship':                                             'group_mm20rr64',
  'Citizenship':                                                   'group_mm20xxw5',
  'Co-op WP':                                                      'group_mm20c3hw',
  'Concurrent WP':                                                 'group_mm20sxhe',
  'ETA':                                                           'group_mm20pz8',
  'Employer Portal':                                               'group_mm20f7dg',
  'Federal PR':                                                    'group_mm20fm5z',
  'Francophone Mobility WP':                                       'group_mm201r8h',
  'H & C':                                                         'group_mm209z6a',
  'ICAS/WES/IQAS':                                                 'group_mm20ms3j',
  'Inland Spousal Sponsorship':                                    'group_mm20xy8v',
  'Invitation Letter':                                             'group_mm20jbtn',
  'LMIA':                                                          'group_mm205afy',
  'LMIA Based WP':                                                 'group_mm20x7js',
  'LMIA Exempt WP':                                                'group_mm20m302',
  'Manitoba PNP':                                                  'group_mm20dqcn',
  'Miscellaneous':                                                 'group_mm20xmdk',
  'NB WP Extension':                                               'group_mm209bzx',
  'NSNP':                                                          'group_mm20m499',
  'Notary':                                                        'group_mm20wmqy',
  'OCI / Passport Surrender':                                      'group_mm2033w',
  'OINP':                                                          'group_mm2020hr',
  'Outland Spousal Sponsorship':                                   'group_mm20f38v',
  'PFL':                                                           'group_mm20hp1m',
  'PGWP':                                                          'group_mm20y2ee',
  'PR Card Renewal':                                               'group_mm201hzk',
  'PRAA':                                                          'group_mm20hywp',
  'PRTD':                                                          'group_mm20ws1j',
  'Parents/Grandparents Sponsorship':                              'group_mm205fss',
  'RCIP':                                                          'group_mm20pj8x',
  'RNIP':                                                          'group_mm209pvx',
  'Reconsideration':                                               'group_mm20zwea',
  'Refugee':                                                       'group_mm20hx6z',
  'Refugee WP':                                                    'group_mm20b835',
  'Renunciation of PR':                                            'group_mm20awrs',
  'Request Letter':                                                'group_mm203fsb',
  'SCLPC WP':                                                      'group_mm20gjez',
  'SNIP':                                                          'group_mm20g6dt',
  'SOWP':                                                          'group_mm20ja9g',
  'Study Permit':                                                  'group_mm20gqek',
  'Study Permit Extension':                                        'group_mm20xrvj',
  'Supervisa':                                                     'group_mm20dd92',
  'TRP':                                                           'group_mm20cj4h',
  'TRV':                                                           'group_mm2027z7',
  'USA Visa':                                                      'group_mm20gqnz',
  'Visitor Record / Extension':                                    'group_mm20b82n',
  'Visitor Visa':                                                  'group_mm20eet1',
};

/**
 * Fetch all questionnaire template items for a given Primary Case Type.
 *
 * @param {string} primaryCaseType - Must exactly match a template board group title
 * @returns {Promise<Array<{ id, name, questionCode }>>}
 */
/**
 * Fetch all questionnaire template items for a given Primary Case Type.
 * Optionally filters by Case Sub Type if provided:
 *   - Items with no Sub Type set → included for all sub types
 *   - Items with a Sub Type set → included only when it matches
 *
 * @param {string} primaryCaseType
 * @param {string|null} caseSubType
 * @returns {Promise<Array>} Array of { id, name, questionCode, caseSubType }
 */
async function getQuestionnaireItemsByCaseType(primaryCaseType, caseSubType = null) {
  const groupId = GROUP_MAP[primaryCaseType?.trim()];
  if (!groupId) {
    throw new Error(
      `No questionnaire template group found for case type "${primaryCaseType}". ` +
      `Available types: ${Object.keys(GROUP_MAP).join(', ')}`
    );
  }

  const data = await mondayApi.query(
    `query getQuestionnaireTemplateItems($boardId: ID!, $groupId: String!) {
      boards(ids: [$boardId]) {
        groups(ids: [$groupId]) {
          items_page(limit: 500) {
            items {
              id
              name
              column_values(ids: ["${TEMPLATE_COLS.questionCode}", "${TEMPLATE_COLS.caseSubType}"]) {
                id
                text
              }
            }
          }
        }
      }
    }`,
    { boardId: String(questionnaireTemplateBoardId), groupId }
  );

  const items = data?.boards?.[0]?.groups?.[0]?.items_page?.items ?? [];

  const mapped = items.map((item) => {
    const colMap = {};
    for (const col of item.column_values) colMap[col.id] = col.text;
    return {
      id:           item.id,
      name:         item.name,
      questionCode: colMap[TEMPLATE_COLS.questionCode] || '',
      caseSubType:  colMap[TEMPLATE_COLS.caseSubType]  || '',
    };
  });

  if (caseSubType) {
    const normalised = caseSubType.trim().toLowerCase();
    return mapped.filter(
      (item) =>
        !item.caseSubType ||
        item.caseSubType.trim().toLowerCase() === normalised
    );
  }

  return mapped;
}

module.exports = { getQuestionnaireItemsByCaseType };
