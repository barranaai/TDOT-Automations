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

const FETCH_COLS = [
  'text_mm0zr7tf',         // Document Code
  'color_mm0zwgvr',        // Document Status
  'lookup_mm0z1chx',       // Required Type (mirror)
  'lookup_mm0zqbvt',       // Document Category (mirror)
  'lookup_mm0zb0p6',       // Blocking Document (mirror)
  'lookup_mm0zj5rt',       // Document Source (mirror)
  'date_mm0zyw0m',         // Last Upload Date
  'board_relation_mm0zhagw', // Link to Template Board item
];

const TEMPLATE_COLS = [
  'long_text_mm0zmb7j',  // Description
  'long_text_mm0z10mg',  // Client-Facing Instructions
];

/**
 * Fetch all document checklist items for a given case reference,
 * including Description and Client-Facing Instructions from the Template Board.
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
           column_values(ids: ${JSON.stringify(FETCH_COLS)}) { id text value }
         }
       }
     }`,
    { boardId: BOARD_ID, caseRef }
  );

  const items = data?.items_page_by_column_values?.items || [];
  if (!items.length) return [];

  // Collect linked template item IDs from the board_relation column
  const templateIdMap = {}; // executionItemId → templateItemId
  items.forEach((item) => {
    const relCol = item.column_values.find((c) => c.id === 'board_relation_mm0zhagw');
    if (relCol?.value) {
      try {
        const parsed = JSON.parse(relCol.value);
        const linkedId = (parsed.linkedPulseIds || [])[0];
        if (linkedId) templateIdMap[item.id] = String(linkedId);
      } catch { /* ignore */ }
    }
  });

  // Batch-fetch descriptions from the Template Board
  const templateDescriptions = {};
  const templateIds = Object.values(templateIdMap);
  if (templateIds.length) {
    const tData = await mondayApi.query(
      `query($ids: [ID!]!) {
         items(ids: $ids) {
           id
           column_values(ids: ${JSON.stringify(TEMPLATE_COLS)}) { id text }
         }
       }`,
      { ids: templateIds }
    );
    (tData.items || []).forEach((tItem) => {
      const col = (id) => tItem.column_values.find((c) => c.id === id)?.text?.trim() || '';
      templateDescriptions[String(tItem.id)] = {
        description:          col('long_text_mm0zmb7j'),
        clientInstructions:   col('long_text_mm0z10mg'),
      };
    });
  }

  return items
    .map((item) => {
      const col        = (id) => item.column_values.find((c) => c.id === id)?.text?.trim() || '';
      const templateId = templateIdMap[item.id];
      const tmpl       = templateId ? (templateDescriptions[templateId] || {}) : {};
      return {
        id:                 item.id,
        name:               item.name,
        documentCode:       col('text_mm0zr7tf'),
        status:             col('color_mm0zwgvr') || 'Missing',
        requiredType:       col('lookup_mm0z1chx') || 'Mandatory',
        category:           col('lookup_mm0zqbvt') || 'General',
        blocking:           col('lookup_mm0zb0p6'),
        source:             col('lookup_mm0zj5rt'),
        lastUpload:         col('date_mm0zyw0m'),
        description:        tmpl.description || '',
        clientInstructions: tmpl.clientInstructions || '',
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
