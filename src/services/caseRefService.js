const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');

const CASE_REF_COL  = 'text_mm142s49';
const CASE_TYPE_COL = 'dropdown_mm0xd1qn';

const CASE_TYPE_ABBR = {
  'AIP':                         'AIP',
  'BOWP':                        'BOWP',
  'Citizenship':                 'CIT',
  'CO-OP WP':                    'COWP',
  'Concurrent WP':               'CWP',
  'EE after ITA':                'EE',
  'ETA':                         'ETA',
  'Federal PR':                  'FPR',
  'Inland Spousal Sponsorship':  'ISS',
  'LMIA':                        'LMIA',
  'LMIA based WP':               'LBW',
  'LMIA exempt WP':              'LEW',
  'Miscellaneous':               'MISC',
  'NSNP':                        'NSNP',
  'OINP':                        'OINP',
  'Outland Spousal Sponsorship': 'OSS',
  'Parents/Grandparents':        'PGP',
  'PGWP':                        'PGWP',
  'PFL':                         'PFL',
  'PR card Renewal':             'PCR',
  'PRTD':                        'PRTD',
  'Reconsideration':             'RECON',
  'Refugee':                     'REF',
  'Refugee WP':                  'RWP',
  'Request Letter':              'RL',
  'Restoration+Visitor Record':  'RSTVR',
  'Restoration+WP':              'RSTWP',
  'SCLPC-WP':                    'SCLWP',
  'SOWP':                        'SOWP',
  'Study Permit':                'SP',
  'Study Permit Ext':            'SPE',
  'Supervisa':                   'SV',
  'TRV':                         'TRV',
  'US Visa':                     'UV',
  'Visitor Extension':           'VE',
  'Visitor Visa':                'VV',
  'Work Permit Ext':             'WPE',
};

async function getAllCaseRefs() {
  let allRefs = [];
  let cursor  = null;

  do {
    let data;
    if (cursor) {
      data = await mondayApi.query(
        `query($cursor: String!) {
           boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200, cursor: $cursor) {
               cursor
               items { column_values(ids: ["${CASE_REF_COL}"]) { text } }
             }
           }
         }`,
        { cursor }
      );
    } else {
      data = await mondayApi.query(
        `{
           boards(ids: ["${clientMasterBoardId}"]) {
             items_page(limit: 200) {
               cursor
               items { column_values(ids: ["${CASE_REF_COL}"]) { text } }
             }
           }
         }`
      );
    }

    const page = data.boards[0].items_page;
    for (const item of page.items) {
      const ref = item.column_values[0]?.text?.trim();
      if (ref) allRefs.push(ref);
    }
    cursor = page.cursor || null;
  } while (cursor);

  return allRefs;
}

async function getItemCaseRef(itemId) {
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) {
         column_values(ids: ["${CASE_REF_COL}"]) { text }
       }
     }`,
    { itemId: String(itemId) }
  );
  return (data.items[0]?.column_values[0]?.text || '').trim();
}

async function generateCaseRef(caseType) {
  const year  = new Date().getFullYear();
  const abbr  = CASE_TYPE_ABBR[caseType] || 'MISC';
  const prefix = `${year}-${abbr}-`;

  const allRefs = await getAllCaseRefs();

  let maxSeq = 0;
  for (const ref of allRefs) {
    if (ref.startsWith(prefix)) {
      const seq = parseInt(ref.slice(prefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  }

  return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
}

async function onCaseTypeSet({ itemId, caseType }) {
  if (!caseType) return;

  // Only assign if the item doesn't already have a case ref
  const existing = await getItemCaseRef(itemId);
  if (existing) {
    console.log(`[CaseRef] Item ${itemId} already has ref "${existing}", skipping`);
    return;
  }

  const caseRef = await generateCaseRef(caseType);

  await mondayApi.query(
    `mutation($itemId: ID!, $boardId: ID!, $value: JSON!) {
       change_column_value(
         item_id:   $itemId,
         board_id:  $boardId,
         column_id: "${CASE_REF_COL}",
         value:     $value
       ) { id }
     }`,
    {
      itemId:  String(itemId),
      boardId: String(clientMasterBoardId),
      value:   JSON.stringify(caseRef),
    }
  );

  console.log(`[CaseRef] Assigned ${caseRef} to item ${itemId}`);
}

module.exports = { onCaseTypeSet, generateCaseRef };
