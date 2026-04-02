const mondayApi = require('./mondayApi');
const { clientMasterBoardId } = require('../../config/monday');
const { SUB_TYPES_BY_CASE } = require('../../config/caseTypes');

const CASE_REF_COL      = 'text_mm142s49';
const CASE_TYPE_COL     = 'dropdown_mm0xd1qn';
const SUB_TYPE_HINT_COL = 'text_mm21gw44';

const CASE_TYPE_ABBR = {
  'AAIP':                                                          'AAIP',
  'Addition of Spouse':                                            'AOS',
  'Amendment of Document':                                         'AMD',
  'Appeal':                                                        'APPL',
  'BCPNP':                                                         'BCPNP',
  'BOWP':                                                          'BOWP',
  'Canadian Experience Class (EE after ITA)':                      'CEC-EE',
  'Canadian Experience Class (Profile Recreation+ITA+Submission)': 'CEC-PR',
  'Canadian Experience Class (Profile+ITA+Submission)':            'CEC-PS',
  'Child Sponsorship':                                             'CSP',
  'Citizenship':                                                   'CIT',
  'Co-op WP':                                                      'COWP',
  'Concurrent WP':                                                 'CWP',
  'ETA':                                                           'ETA',
  'Employer Portal':                                               'EP',
  'Federal PR':                                                    'FPR',
  'Francophone Mobility WP':                                       'FMWP',
  'H & C':                                                         'HC',
  'ICAS/WES/IQAS':                                                 'ICAS',
  'Inland Spousal Sponsorship':                                    'ISS',
  'Invitation Letter':                                             'IL',
  'LMIA':                                                          'LMIA',
  'LMIA Based WP':                                                 'LBW',
  'LMIA Exempt WP':                                                'LEW',
  'Manitoba PNP':                                                  'MPNP',
  'Miscellaneous':                                                 'MISC',
  'NB WP Extension':                                               'NBWP',
  'NSNP':                                                          'NSNP',
  'Notary':                                                        'NOT',
  'OCI / Passport Surrender':                                      'OCI',
  'OINP':                                                          'OINP',
  'Outland Spousal Sponsorship':                                   'OSS',
  'PFL':                                                           'PFL',
  'PGWP':                                                          'PGWP',
  'PR Card Renewal':                                               'PCR',
  'PRAA':                                                          'PRAA',
  'PRTD':                                                          'PRTD',
  'Parents/Grandparents Sponsorship':                              'PGP',
  'RCIP':                                                          'RCIP',
  'RNIP':                                                          'RNIP',
  'Reconsideration':                                               'RECON',
  'Refugee':                                                       'REF',
  'Refugee WP':                                                    'RWP',
  'Renunciation of PR':                                            'RPR',
  'Request Letter':                                                'RL',
  'SCLPC WP':                                                      'SCLWP',
  'SNIP':                                                          'SNIP',
  'SOWP':                                                          'SOWP',
  'Study Permit':                                                  'SP',
  'Study Permit Extension':                                        'SPE',
  'Supervisa':                                                     'SV',
  'TRP':                                                           'TRP',
  'TRV':                                                           'TRV',
  'USA Visa':                                                      'UV',
  'Visitor Record / Extension':                                    'VRE',
  'Visitor Visa':                                                  'VV',
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

async function updateSubTypeHint(itemId, caseType) {
  const subTypes = SUB_TYPES_BY_CASE[caseType] || [];
  const hint = subTypes.length
    ? subTypes.join('  |  ')
    : '—  (no sub types for this case type)';

  await mondayApi.query(
    `mutation($itemId: ID!, $boardId: ID!, $value: JSON!) {
       change_column_value(
         item_id:   $itemId,
         board_id:  $boardId,
         column_id: "${SUB_TYPE_HINT_COL}",
         value:     $value
       ) { id }
     }`,
    {
      itemId:  String(itemId),
      boardId: String(clientMasterBoardId),
      value:   JSON.stringify(hint),
    }
  );

  console.log(`[CaseRef] Sub Type hint updated for item ${itemId}: "${hint}"`);
}

async function onCaseTypeSet({ itemId, caseType }) {
  if (!caseType) return;

  // Update the Sub Type hint column immediately so staff see valid options
  await updateSubTypeHint(itemId, caseType).catch(err =>
    console.error('[CaseRef] Error updating sub type hint:', err.message)
  );

  // Only assign a Case Ref if the item doesn't already have one
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
