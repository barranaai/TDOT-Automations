const mondayApi = require('./mondayApi');
const { templateBoardId } = require('../../config/monday');

// Template Board column IDs
const TEMPLATE_COLS = {
  documentCode:     'text_mm0xprz5',
  caseSubType:      'dropdown_mm204y6w',  // dropdown written by rebuildTemplateBoards.js
  documentCategory: 'dropdown_mm0x41zm',
};

// Template Board group titles → group IDs (sourced from rebuilt Document Checklist Template Board)
const GROUP_MAP = {
  'AAIP':                                                          'group_mm20pzmk',
  'Addition of Spouse':                                            'group_mm20p681',
  'Amendment of Document':                                         'group_mm20kqx8',
  'Appeal':                                                        'group_mm20kkgb',
  'BCPNP':                                                         'group_mm20pk4z',
  'BOWP':                                                          'group_mm20z1tm',
  'Canadian Experience Class (EE after ITA)':                      'group_mm20jxgj',
  'Canadian Experience Class (Profile Recreation+ITA+Submission)': 'group_mm20rprs',
  'Canadian Experience Class (Profile+ITA+Submission)':            'group_mm20npqs',
  'Child Sponsorship':                                             'group_mm20f7ks',
  'Citizenship':                                                   'group_mm20fk69',
  'Co-op WP':                                                      'group_mm209dn7',
  'Concurrent WP':                                                 'group_mm20hga4',
  'ETA':                                                           'group_mm20pn8z',
  'Employer Portal':                                               'group_mm20j3xz',
  'Federal PR':                                                    'group_mm20v0tw',
  'Francophone Mobility WP':                                       'group_mm20zfw7',
  'H & C':                                                         'group_mm204whx',
  'ICAS/WES/IQAS':                                                 'group_mm2032z6',
  'Inland Spousal Sponsorship':                                    'group_mm20gaqa',
  'Invitation Letter':                                             'group_mm20dne6',
  'LMIA':                                                          'group_mm20e45m',
  'LMIA Based WP':                                                 'group_mm203qtg',
  'LMIA Exempt WP':                                                'group_mm20h35m',
  'Manitoba PNP':                                                  'group_mm20wr7c',
  'Miscellaneous':                                                 'group_mm206pay',
  'NB WP Extension':                                               'group_mm20zefz',
  'NSNP':                                                          'group_mm20yspz',
  'Notary':                                                        'group_mm208x0f',
  'OCI / Passport Surrender':                                      'group_mm20vard',
  'OINP':                                                          'group_mm205n4v',
  'Outland Spousal Sponsorship':                                   'group_mm20ark6',
  'PFL':                                                           'group_mm20wze6',
  'PGWP':                                                          'group_mm201tn9',
  'PR Card Renewal':                                               'group_mm20qncv',
  'PRAA':                                                          'group_mm20sk4',
  'PRTD':                                                          'group_mm20905c',
  'Parents/Grandparents Sponsorship':                              'group_mm20cssz',
  'RCIP':                                                          'group_mm20thv5',
  'RNIP':                                                          'group_mm20ydwb',
  'Reconsideration':                                               'group_mm20mcvq',
  'Refugee':                                                       'group_mm20ebkq',
  'Refugee WP':                                                    'group_mm20616',
  'Renunciation of PR':                                            'group_mm20p4n1',
  'Request Letter':                                                'group_mm20z8xw',
  'SCLPC WP':                                                      'group_mm20z5wq',
  'SNIP':                                                          'group_mm20mgtf',
  'SOWP':                                                          'group_mm20rbw2',
  'Study Permit':                                                  'group_mm203je0',
  'Study Permit Extension':                                        'group_mm20k9f8',
  'Supervisa':                                                     'group_mm205fc9',
  'TRP':                                                           'group_mm20c4q8',
  'TRV':                                                           'group_mm20sqwz',
  'USA Visa':                                                      'group_mm20d6yy',
  'Visitor Record / Extension':                                    'group_mm20emfw',
  'Visitor Visa':                                                  'group_mm20tt4n',
};

/**
 * Fetch all template items for a given Primary Case Type.
 * Optionally filters by Case Sub Type if provided.
 *
 * @param {string} primaryCaseType - Must exactly match a Template Board group title
 * @param {string|null} caseSubType - Optional sub-type filter
 * @returns {Promise<Array>} Array of { id, name, documentCode, caseSubType }
 */
async function getTemplateItemsByCaseType(primaryCaseType, caseSubType = null) {
  const groupId = GROUP_MAP[primaryCaseType?.trim()];
  if (!groupId) {
    throw new Error(
      `No template group found for case type "${primaryCaseType}". ` +
      `Available types: ${Object.keys(GROUP_MAP).join(', ')}`
    );
  }

  const data = await mondayApi.query(
    `query getTemplateItems($boardId: ID!, $groupId: String!) {
      boards(ids: [$boardId]) {
        groups(ids: [$groupId]) {
          items_page(limit: 500) {
            items {
              id
              name
              column_values(ids: ["${TEMPLATE_COLS.documentCode}", "${TEMPLATE_COLS.caseSubType}", "${TEMPLATE_COLS.documentCategory}"]) {
                id
                text
              }
            }
          }
        }
      }
    }`,
    { boardId: String(templateBoardId), groupId }
  );

  const items = data?.boards?.[0]?.groups?.[0]?.items_page?.items ?? [];

  const mapped = items.map((item) => {
    const colMap = {};
    for (const col of item.column_values) {
      colMap[col.id] = col.text;
    }
    return {
      id:               item.id,
      name:             item.name,
      documentCode:     colMap[TEMPLATE_COLS.documentCode]     || '',
      caseSubType:      colMap[TEMPLATE_COLS.caseSubType]      || '',
      documentCategory: colMap[TEMPLATE_COLS.documentCategory] || '',
    };
  });

  // Filter by sub type if provided
  if (caseSubType) {
    return mapped.filter(
      (item) =>
        !item.caseSubType ||
        item.caseSubType.trim().toLowerCase() === caseSubType.trim().toLowerCase()
    );
  }

  return mapped;
}

module.exports = { getTemplateItemsByCaseType };
