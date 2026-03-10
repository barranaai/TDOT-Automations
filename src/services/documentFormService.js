const axios    = require('axios');
const FormData = require('form-data');
const mondayApi = require('./mondayApi');
const { apiKey } = require('../../config/monday');

const BOARD_ID       = process.env.MONDAY_EXECUTION_BOARD_ID || '18401875593';
const CASE_REF_COL   = 'text_mm0z2cck';
const FILE_COL       = 'file_mm0zf2hd';
const DOC_STATUS_COL = 'color_mm0zwgvr';
const UPLOAD_DATE_COL = 'date_mm0zyw0m';
const REVIEW_REQ_COL  = 'color_mm0z796e';

const TEMPLATE_BOARD_ID = process.env.MONDAY_TEMPLATE_BOARD_ID || '18401624183';

const REVIEW_NOTES_COL = 'long_text_mm0zbpr';

const FETCH_COLS = [
  'text_mm0zr7tf',      // Document Code
  'color_mm0zwgvr',     // Document Status
  'lookup_mm0z1chx',    // Required Type (mirror)
  'lookup_mm0zqbvt',    // Document Category (mirror)
  'lookup_mm0zb0p6',    // Blocking Document (mirror)
  'lookup_mm0zj5rt',    // Document Source (mirror)
  'date_mm0zyw0m',      // Last Upload Date
  REVIEW_NOTES_COL,     // Review Notes (shown to client on Rework Required)
];

/**
 * Fetch all template descriptions keyed by Document Code.
 * Paginates through all template items in one pass.
 */
async function getTemplateDescriptionsByCode() {
  const map    = {};
  let cursor   = null;

  do {
    let data;
    if (cursor) {
      data = await mondayApi.query(
        `query($cursor: String!) {
           boards(ids: ["${TEMPLATE_BOARD_ID}"]) {
             items_page(limit: 200, cursor: $cursor) {
               cursor
               items {
                 column_values(ids: ["text_mm0xprz5","long_text_mm0zmb7j","long_text_mm0z10mg"]) { id text }
               }
             }
           }
         }`,
        { cursor }
      );
    } else {
      data = await mondayApi.query(
        `{
           boards(ids: ["${TEMPLATE_BOARD_ID}"]) {
             items_page(limit: 200) {
               cursor
               items {
                 column_values(ids: ["text_mm0xprz5","long_text_mm0zmb7j","long_text_mm0z10mg"]) { id text }
               }
             }
           }
         }`
      );
    }

    const page = data.boards[0].items_page;
    for (const item of page.items) {
      const col  = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
      const code = col('text_mm0xprz5');
      if (code) {
        map[code] = {
          description:        col('long_text_mm0zmb7j'),
          clientInstructions: col('long_text_mm0z10mg'),
        };
      }
    }
    cursor = page.cursor || null;
  } while (cursor);

  return map;
}

/**
 * Fetch all document checklist items for a given case reference,
 * including Description and Client-Facing Instructions from the Template Board.
 */
async function getCaseDocuments(caseRef) {
  const [execData, templateMap] = await Promise.all([
    mondayApi.query(
      `query($boardId: ID!, $caseRef: String!) {
         items_page_by_column_values(
           limit: 500,
           board_id: $boardId,
           columns: [{ column_id: "${CASE_REF_COL}", column_values: [$caseRef] }]
         ) {
           items {
             id
             name
             column_values(ids: ${JSON.stringify(FETCH_COLS)}) { id text }
           }
         }
       }`,
      { boardId: BOARD_ID, caseRef }
    ),
    getTemplateDescriptionsByCode(),
  ]);

  const items = execData?.items_page_by_column_values?.items || [];
  if (!items.length) return [];

  return items
    .map((item) => {
      const col  = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
      const code = col('text_mm0zr7tf');
      const tmpl = templateMap[code] || {};
      return {
        id:                 item.id,
        name:               item.name,
        documentCode:       code,
        status:             col('color_mm0zwgvr') || 'Missing',
        requiredType:       col('lookup_mm0z1chx') || 'Mandatory',
        category:           col('lookup_mm0zqbvt') || 'General',
        blocking:           col('lookup_mm0zb0p6'),
        source:             col('lookup_mm0zj5rt'),
        lastUpload:         col('date_mm0zyw0m'),
        description:        tmpl.description || '',
        clientInstructions: tmpl.clientInstructions || '',
        reviewNotes:        col(REVIEW_NOTES_COL) || '',
      };
    })
    .sort((a, b) => {
      if (a.category < b.category) return -1;
      if (a.category > b.category) return 1;
      return (a.documentCode || '').localeCompare(b.documentCode || '', undefined, { numeric: true });
    });
}

/**
 * Upload a file buffer to Monday.com's file column for a specific item.
 * Uses Monday's multipart file upload API.
 */
async function uploadFileToMonday(itemId, fileBuffer, originalName, mimeType) {
  const mutation = `
    mutation ($file: File!) {
      add_file_to_column(
        item_id:   "${itemId}",
        column_id: "${FILE_COL}",
        file:      $file
      ) { id }
    }`;

  const form = new FormData();
  form.append('query', mutation);
  form.append('variables[file]', fileBuffer, {
    filename:    originalName,
    contentType: mimeType || 'application/octet-stream',
  });

  const response = await axios.post('https://api.monday.com/v2/file', form, {
    headers: {
      Authorization: apiKey,
      ...form.getHeaders(),
    },
    maxContentLength: Infinity,
    maxBodyLength:    Infinity,
  });

  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors));
  }

  return response.data.data?.add_file_to_column;
}

/**
 * After a successful upload, set Document Status = Received,
 * Last Upload Date = today, Review Required = Yes.
 */
async function markDocumentReceived(itemId) {
  const today     = new Date().toISOString().split('T')[0];
  const colValues = JSON.stringify({
    [DOC_STATUS_COL]:  { label: 'Received' },
    [UPLOAD_DATE_COL]: { date: today },
    [REVIEW_REQ_COL]:  { label: 'Yes' },
  });

  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $colValues: JSON!) {
       change_multiple_column_values(
         board_id:      $boardId,
         item_id:       $itemId,
         column_values: $colValues
       ) { id }
     }`,
    { boardId: BOARD_ID, itemId: String(itemId), colValues }
  );
}

module.exports = { getCaseDocuments, uploadFileToMonday, markDocumentReceived };
