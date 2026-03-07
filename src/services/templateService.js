const mondayApi = require('./mondayApi');
const { templateBoardId } = require('../../config/monday');

// Template Board column IDs
const TEMPLATE_COLS = {
  documentCode: 'text_mm0xprz5',
  caseSubType: 'text_mm16wrft',
};

// Template Board group titles → group IDs (pre-fetched from board structure)
const GROUP_MAP = {
  'AIP': 'group_mm0xg0bv',
  'BOWP': 'group_mm0xbdm8',
  'Citizenship': 'group_mm0xc6wj',
  'CO-OP WP': 'group_mm0xxvpz',
  'Concurrent WP': 'group_mm0x4sew',
  'EE after ITA': 'group_mm0xdy5f',
  'ETA': 'group_mm0xs8h7',
  'Federal PR': 'group_mm0xv8eb',
  'Inland Spousal Sponsorship': 'group_mm0xdcr1',
  'LMIA': 'group_mm0xk0dj',
  'LMIA based WP': 'group_mm0xwnba',
  'LMIA exempt WP': 'group_mm0xbk4q',
  'Miscellaneous': 'group_mm0x19qp',
  'NSNP': 'group_mm0xahzm',
  'OINP': 'group_mm0xzpy2',
  'Outland Spousal Sponsorship': 'group_mm0xst3z',
  'Parents/Grandparents': 'group_mm0x5bm7',
  'PGWP': 'group_mm0x1rqk',
  'PFL': 'group_mm0xx990',
  'PR Card Renewal': 'group_mm0xwn98',
  'PRTD': 'group_mm0xf6ks',
  'Reconsideration': 'group_mm0xknb2',
  'Refugee': 'group_mm0x1905',
  'Refugee WP': 'group_mm0xddb6',
  'Request Letter': 'group_mm0xbxyj',
  'Restoration+Visitor Record': 'group_mm0xnsbg',
  'Restoration+WP': 'group_mm0xvbqd',
  'SCLPC-WP': 'group_mm0xenpz',
  'SOWP': 'group_mm0xxb0z',
  'Study Permit': 'group_mm0xsge4',
  'Study Permit Extension': 'group_mm0xy7c9',
  'Supervisa': 'group_mm0xw7t2',
  'TRV': 'group_mm0xymf6',
  'US visa': 'group_mm0xjnm4',
  'Visitor Extension': 'group_mm0xrrc0',
  'Visitor Visa': 'group_mm0xcf5e',
  'Work Permit Extension': 'group_mm0xzg9w',
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
              column_values(ids: ["${TEMPLATE_COLS.documentCode}", "${TEMPLATE_COLS.caseSubType}"]) {
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
      id: item.id,
      name: item.name,
      documentCode: colMap[TEMPLATE_COLS.documentCode] || '',
      caseSubType: colMap[TEMPLATE_COLS.caseSubType] || '',
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
