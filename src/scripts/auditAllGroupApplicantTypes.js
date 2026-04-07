/**
 * auditAllGroupApplicantTypes.js
 *
 * Scans every Template Board group and reports which ones have ONLY
 * "Principal Applicant" items (no Spouse / Dependent Child items).
 *
 * Run with: node src/scripts/auditAllGroupApplicantTypes.js
 */

require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID    = '18401624183';
const APP_TYPE_COL = 'dropdown_mm261bn6';
const SUBTYPE_COL  = 'dropdown_mm204y6w';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const GROUPS = {
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

async function checkGroup(groupId) {
  const data = await mondayApi.query(
    `query($boardId: ID!, $groupId: String!) {
       boards(ids: [$boardId]) {
         groups(ids: [$groupId]) {
           items_page(limit: 500) {
             items {
               column_values(ids: ["${APP_TYPE_COL}", "${SUBTYPE_COL}"]) { id text }
             }
           }
         }
       }
     }`,
    { boardId: String(BOARD_ID), groupId }
  );

  const items = data?.boards?.[0]?.groups?.[0]?.items_page?.items || [];
  if (!items.length) return null;

  const appTypes = new Set();
  const subTypes = new Set();
  for (const item of items) {
    const at = item.column_values.find(c => c.id === APP_TYPE_COL)?.text?.trim() || 'NONE';
    const st = item.column_values.find(c => c.id === SUBTYPE_COL)?.text?.trim() || '';
    appTypes.add(at);
    if (st) subTypes.add(st);
  }

  const hasSpouse = appTypes.has('Spouse / Common-Law Partner');
  const hasChild  = appTypes.has('Dependent Child');
  const onlyPA    = [...appTypes].every(t => t === 'Principal Applicant' || t === 'NONE');

  return {
    total: items.length,
    appTypes: [...appTypes].sort(),
    subTypes: [...subTypes].sort(),
    hasSpouse,
    hasChild,
    onlyPA,
  };
}

async function main() {
  console.log('Scanning all template groups for missing Spouse / Child items...\n');
  console.log(`${'GROUP'.padEnd(52)} ${'ITEMS'.padEnd(6)} STATUS`);
  console.log('─'.repeat(100));

  const issues = [];

  for (const [name, groupId] of Object.entries(GROUPS)) {
    let result;
    try {
      result = await checkGroup(groupId);
    } catch (err) {
      console.log(`${name.padEnd(52)} ERROR: ${err.message}`);
      await sleep(500);
      continue;
    }

    if (!result) {
      console.log(`${name.padEnd(52)} ${'0'.padEnd(6)} (empty — skip)`);
    } else {
      let status;
      if (result.onlyPA) {
        status = `⚠️  PA ONLY  sub-types: [${result.subTypes.join(', ') || 'none'}]`;
        issues.push({ name, groupId, ...result });
      } else if (result.hasSpouse && result.hasChild) {
        status = `✅ PA + Spouse + Child`;
      } else if (result.hasSpouse) {
        status = `✅ PA + Spouse`;
      } else if (result.hasChild) {
        status = `✅ PA + Child`;
      } else {
        status = `? ${result.appTypes.join(', ')}`;
      }
      console.log(`${name.padEnd(52)} ${String(result.total).padEnd(6)} ${status}`);
    }

    await sleep(220);
  }

  console.log('\n' + '═'.repeat(100));
  if (issues.length === 0) {
    console.log('✅ All groups have correct applicant types — no issues found!');
  } else {
    console.log(`⚠️  ${issues.length} group(s) with PA-only items:\n`);
    for (const g of issues) {
      console.log(`  • ${g.name} (${g.groupId}) — ${g.total} items`);
      console.log(`    Sub-types: ${g.subTypes.join(', ') || '(none)'}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
