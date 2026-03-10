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

const FETCH_COLS = [
  'text_mm0zr7tf',      // Document Code
  'color_mm0zwgvr',     // Document Status
  'lookup_mm0z1chx',    // Required Type (mirror)
  'lookup_mm0zqbvt',    // Document Category (mirror)
  'lookup_mm0zb0p6',    // Blocking Document (mirror)
  'lookup_mm0zj5rt',    // Document Source (mirror)
  'date_mm0zyw0m',      // Last Upload Date
];

/**
 * Fetch all document checklist items for a given case reference.
 */
async function getCaseDocuments(caseRef) {
  const data = await mondayApi.query(
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
  );

  const items = data?.items_page_by_column_values?.items || [];
  if (!items.length) return [];

  return items
    .map((item) => {
      const col = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
      return {
        id:           item.id,
        name:         item.name,
        documentCode: col('text_mm0zr7tf'),
        status:       col('color_mm0zwgvr') || 'Missing',
        requiredType: col('lookup_mm0z1chx') || 'Mandatory',
        category:     col('lookup_mm0zqbvt') || 'General',
        blocking:     col('lookup_mm0zb0p6'),
        source:       col('lookup_mm0zj5rt'),
        lastUpload:   col('date_mm0zyw0m'),
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
