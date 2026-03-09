/**
 * Updates the "Help Text (Client Facing)" column on existing questionnaire template items.
 * Usage: node src/scripts/updateHelpText.js
 */
require('dotenv').config();
const mondayApi = require('../services/mondayApi');

const BOARD_ID          = '18402113809';
const HELP_TEXT_COL_ID  = 'long_text_mm12df2b';

// ─── Shared help text used across all questionnaires ──────────────────────────

const SHARED_HELP_TEXT = {
  'Family Name (Surname)':                                                            '',
  'Given Name':                                                                       '',
  'Have you ever used any other name?':                                               'If yes, please provide details — Family Name and Given Name.',
  'Other Name – Family Name':                                                         'Provide your alternative family name if applicable.',
  'Other Name – Given Name':                                                          'Provide your alternative given name if applicable.',
  'Country of Citizenship':                                                           '',
  'Current Residence Country':                                                        '',
  'Status in Current Country (Visitor, Student, Worker, Citizen)':                   'Select your current immigration status: Visitor, Student, Worker, or Citizen.',
  'Native Language':                                                                  '',
  'Are you a permanent resident of the US with a valid green card?':                  '',
  'Do you have a valid Language test report?':                                        '',
  'Are you a lawful permanent resident of the US with a valid USCIS number?':         '',
  'First Entry to Canada – Date (DD/MM/YYYY)':                                        'Format: DD/MM/YYYY',
  'First Entry to Canada – Location':                                                 'City or port of entry where you first entered Canada.',
  'First Entry to Canada – Status':                                                   'Your immigration status at the time of first entry (e.g. Visitor, Student, Worker).',
  'Latest Entry to Canada – Date (DD/MM/YYYY)':                                       'Format: DD/MM/YYYY',
  'Latest Entry to Canada – Location':                                                'City or port of entry for your most recent entry to Canada.',
  'Latest Entry to Canada – Status':                                                  'Your immigration status at the time of latest entry (e.g. Visitor, Student, Worker).',
  'Last Application to IRCC – Submission Date':                                       'Date when you last submitted an application to IRCC. Format: DD/MM/YYYY',
  'Last Application to IRCC – Application Type':                                      'Type of application submitted (e.g. Study Permit, Visitor Visa, Work Permit).',
  'Last Application to IRCC – Result (Approved / Refused)':                           'Select: Approved or Refused.',
  'Have you ever flagged poled and entered Canada for yourself or friend or family?':  'If yes, please provide details — Date (DD/MM/YYYY), Location (Border Name), Decision (Approved / Refused).',
  'Flagged Poling – Date (DD/MM/YYYY)':                                               'Format: DD/MM/YYYY',
  'Flagged Poling – Location (Border Name)':                                          'Name of the border crossing location.',
  'Flagged Poling – Decision (Approved / Refused)':                                   'Select: Approved or Refused.',
  'Current Marital Status':                                                           '',
  'Date of Marriage (DD/MM/YYYY)':                                                    'Format: DD/MM/YYYY',
  'Date of Marriage':                                                                 'Format: DD/MM/YYYY',
  "Spouse's Family Name":                                                             '',
  "Spouse's Given Name":                                                              '',
  "Spouse's Date of Birth":                                                           'Format: DD/MM/YYYY',
  'Have you previously been married or in a common-law relationship?':                'If yes, provide details of your previous partner.',
  'Previous Partner – Date of Marriage':                                              'Format: DD/MM/YYYY',
  'Previous Partner – Date of Divorce / Separation':                                  'Format: DD/MM/YYYY',
  'Previous Partner – Family Name':                                                   '',
  'Previous Partner – Given Name':                                                    '',
  'Previous Partner – Date of Birth':                                                 'Format: DD/MM/YYYY',
  'Mobile Number':                                                                    '',
  'Email Address':                                                                    '',
  'Mailing Address':                                                                  '',
  'Residential Address':                                                              '',
  'Education – Start Date (DD/MM/YYYY)':                                              'Format: DD/MM/YYYY. Include the full dates for each period of education.',
  'Education – End Date (DD/MM/YYYY)':                                                'Format: DD/MM/YYYY. Include the full dates for each period of education.',
  'Education – Course / Program Name':                                                'Include College, University or any apprentice training.',
  'Education – Education Institute':                                                  'Include College, University or any apprentice training.',
  'Education – City':                                                                 'City where the education institute is located.',
  'Education – Country':                                                              'Country where the education institute is located.',
  'Employment – Start Date (DD/MM/YYYY)':                                             'Format: DD/MM/YYYY. Include part-time, full-time, foreign work, and self-employment (Uber, Skip, Door-dash, etc.).',
  'Employment – End Date (DD/MM/YYYY)':                                               'Format: DD/MM/YYYY. Include part-time, full-time, foreign work, and self-employment (Uber, Skip, Door-dash, etc.).',
  'Employment – Job Title':                                                           'Include all part-time, full-time, foreign work, and self-employment (Uber, Skip, Door-dash, etc.).',
  'Employment – Company Name':                                                        'Include all part-time, full-time, foreign work, and self-employment (Uber, Skip, Door-dash, etc.).',
  'Employment – City':                                                                'City where the employer is located.',
  'Employment – Country':                                                             'Country where the employer is located.',
  'Have you declared your international experience in any of your previous IRCC applications? (If No, provide explanation)':
                                                                                      'This includes Study Permit, Work Permit, Visitor Visa, PNP, etc. Answer YES or NO. If NO, please provide an explanation.',
  'Have you been convicted of a crime or offence in Canada for which a pardon has not been granted?':
                                                                                      'Answer: Yes or No.',
  'Have you ever committed, been arrested for, been charged with or convicted of any criminal offence in any country?':
                                                                                      'Answer: Yes or No.',
  'Have you made previous claims for refugee protection in Canada or abroad, in any other country, or with the UNHCR?':
                                                                                      'Answer: Yes or No.',
  'Have you been refused refugee status, or an immigrant or permanent resident visa (including CSQ or Provincial Nominee Program) to Canada?':
                                                                                      'Answer: Yes or No.',
  'Have you been refused refugee status, or an immigrant or permanent resident visa or visitor or temporary resident visa, to any country?':
                                                                                      'Answer: Yes or No.',
  'Have you ever been refused a visa or permit to Canada?':                           'Answer: Yes or No.',
  'Have you ever been refused a visa or permit to any other country?':                'Answer: Yes or No.',
  'Have you ever been denied entry or ordered to leave Canada?':                      'Answer: Yes or No.',
  'Have you ever been denied entry or ordered to leave any other country?':           'Answer: Yes or No.',
  'Refusal Details – Date of Refusal':                                                'Format: DD/MM/YYYY',
  'Refusal Details – Visa Type':                                                      'Specify the type of visa that was refused.',
  'Refusal Details – Country':                                                        'Country that issued the refusal.',
  'Refusal Details – Number of Refusals':                                             'Total number of refusals received.',
  'Have you been involved in an act of genocide, a war crime or a crime against humanity?':
                                                                                      'Answer: Yes or No.',
  'Have you used, planned or advocated the use of armed struggle or violence to reach political, religious or social objectives?':
                                                                                      'Answer: Yes or No.',
  'Have you been associated with a group that used or advocates the use of armed struggle or violence?':
                                                                                      'Answer: Yes or No.',
  'Have you been a member of an organization engaged in a pattern of criminal activity?':
                                                                                      'Answer: Yes or No.',
  'Have you been detained, incarcerated, or put in jail?':                            'Answer: Yes or No.',
  'Have you had any serious diseases or physical or mental disorder?':                'Answer: Yes or No.',
  'Statutory Questions – Additional Details (if answered Yes to any above)':          'If you answered Yes to any of the statutory questions above, please provide complete details here.',

  // Visitor Extension – Travel History
  'Travel – Start Date (DD/MM/YYYY)':                                                 'Format: DD/MM/YYYY. Provide travel history for the past 5 years, including your home country.',
  'Travel – End Date (DD/MM/YYYY)':                                                   'Format: DD/MM/YYYY. Provide travel history for the past 5 years, including your home country.',
  'Travel – Status (Student, Visitor, Worker, Citizen, etc.)':                        'Please mention what your immigration status was during this period (Student, Visitor, Worker, Citizen, etc.).',
  'Travel – City':                                                                    'City you were located in during this travel period.',
  'Travel – Country':                                                                 'Country you were located in. Include your home country.',
  'Travel – Purpose of Travelling':                                                   '',
};

// ─── Target groups ─────────────────────────────────────────────────────────────

const TARGET_GROUPS = [
  { groupId: 'group_mm123d40', label: 'Visitor Extension' },  // VVE
  { groupId: 'group_mm12pwz4', label: 'PGWP' },
  { groupId: 'group_mm12xza9', label: 'SOWP' },
  { groupId: 'group_mm12cgfa', label: 'BOWP' },
  { groupId: 'group_mm12v89',  label: 'LMIA' },
  { groupId: 'group_mm12e00c', label: 'Work Permit Extension' },
];

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function getGroupItems(groupId) {
  const data = await mondayApi.query(
    `query getItems($boardId: ID!, $groupId: String!) {
      boards(ids: [$boardId]) {
        groups(ids: [$groupId]) {
          items_page(limit: 500) {
            items { id name }
          }
        }
      }
    }`,
    { boardId: BOARD_ID, groupId }
  );
  return data?.boards?.[0]?.groups?.[0]?.items_page?.items ?? [];
}

async function updateHelpText(itemId, helpText) {
  await mondayApi.query(
    `mutation updateHelpText($boardId: ID!, $itemId: ID!, $colId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $colId, value: $value) {
        id
      }
    }`,
    {
      boardId: BOARD_ID,
      itemId:  String(itemId),
      colId:   HELP_TEXT_COL_ID,
      value:   JSON.stringify({ text: helpText }),
    }
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function processGroup(group) {
  console.log(`\n━━━ ${group.label} ━━━`);
  const items = await getGroupItems(group.groupId);
  console.log(`  Found ${items.length} items`);

  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    const helpText = SHARED_HELP_TEXT[item.name];

    if (helpText === undefined) {
      console.log(`  ⚠ No help text mapping for: "${item.name}"`);
      skipped++;
      continue;
    }

    if (!helpText) {
      skipped++;
      continue; // No help text to set — leave blank
    }

    try {
      await updateHelpText(item.id, helpText);
      console.log(`  ✓ Updated: "${item.name}"`);
      updated++;
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`  ✗ Failed: "${item.name}" — ${err.message}`);
    }
  }

  console.log(`  → Updated: ${updated}, Skipped (no text): ${skipped}`);
}

async function main() {
  console.log('Updating Help Text (Client Facing) for all questionnaire template items...\n');
  for (const group of TARGET_GROUPS) {
    await processGroup(group);
  }
  console.log('\nDone.');
}

main().catch(console.error);
