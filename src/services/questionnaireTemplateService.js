const mondayApi = require('./mondayApi');
const { questionnaireTemplateBoardId } = require('../../config/monday');

// Questionnaire Template Board column IDs
const TEMPLATE_COLS = {
  questionCode: 'text_mm1235b5',
};

// Case type group map (title → group ID)
const GROUP_MAP = {
  'AIP':                         'group_mm12m7f0',
  'BOWP':                        'group_mm12cgfa',
  'Citizenship':                 'group_mm12kq85',
  'CO-OP WP':                    'group_mm1229a6',
  'Concurrent WP':               'group_mm1256v0',
  'EE after ITA':                'group_mm125mdm',
  'ETA':                         'group_mm121fps',
  'Federal PR':                  'group_mm12e6e0',
  'Inland Spousal Sponsorship':  'group_mm12ep73',
  'LMIA':                        'group_mm12v89',
  'LMIA based WP':               'group_mm12er01',
  'LMIA exempt WP':              'group_mm12s894',
  'Miscellaneous':               'group_mm128jk5',
  'NSNP':                        'group_mm1283re',
  'OINP':                        'group_mm122xzw',
  'Outland Spousal Sponsorship': 'group_mm12pgz2',
  'Parents/Grandparents':        'group_mm12kthv',
  'PGWP':                        'group_mm12pwz4',
  'PFL':                         'group_mm12vhkn',
  'PR Card Renewal':             'group_mm12kg5w',
  'PRTD':                        'group_mm124765',
  'Reconsideration':             'group_mm12j65z',
  'Refugee':                     'group_mm12z9eg',
  'Refugee WP':                  'group_mm123r23',
  'Request Letter':              'group_mm12m9xy',
  'Restoration+Visitor Record':  'group_mm12rxjs',
  'Restoration+WP':              'group_mm12yb75',
  'SCLPC-WP':                    'group_mm127g0g',
  'SOWP':                        'group_mm12xza9',
  'Study Permit':                'group_mm123x60',
  'Study Permit Extension':      'group_mm124nqc',
  'Supervisa':                   'group_mm12ard',
  'TRV':                         'group_mm1244hn',
  'US visa':                     'group_mm126xq6',
  'Visitor Extension':           'group_mm123d40',
  'Visitor Visa':                'group_mm1223sz',
  'Work Permit Extension':       'group_mm12e00c',
};

/**
 * Fetch all questionnaire template items for a given Primary Case Type.
 *
 * @param {string} primaryCaseType - Must exactly match a template board group title
 * @returns {Promise<Array<{ id, name, questionCode }>>}
 */
async function getQuestionnaireItemsByCaseType(primaryCaseType) {
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
              column_values(ids: ["${TEMPLATE_COLS.questionCode}"]) {
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

  return items.map((item) => {
    const qCode = item.column_values.find((c) => c.id === TEMPLATE_COLS.questionCode);
    return {
      id:           item.id,
      name:         item.name,
      questionCode: qCode?.text || '',
    };
  });
}

module.exports = { getQuestionnaireItemsByCaseType };
