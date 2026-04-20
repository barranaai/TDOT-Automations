/**
 * OneDrive Service
 *
 * Creates per-client folder structures in the noreply@tdotimm.com OneDrive for Business
 * and generates organisation-scoped sharing links for each Document Category subfolder.
 *
 * Folder structure:
 *   OneDrive (noreply@tdotimm.com)
 *   └── Client Documents/
 *       └── {Client Name} - {Case Reference}/
 *           ├── Identity/
 *           ├── Legal/
 *           ├── Medical/
 *           └── (one subfolder per unique Document Category in the checklist)
 */

const axios = require('axios');
const { getAccessToken } = require('./microsoftMailService');

const DRIVE_USER  = process.env.MS_FROM_EMAIL || 'noreply@tdotimm.com';
const ROOT_FOLDER = 'Client Documents';
const GRAPH_BASE  = 'https://graph.microsoft.com/v1.0';

// ─── URL helpers ─────────────────────────────────────────────────────────────

function userBase() {
  return `${GRAPH_BASE}/users/${encodeURIComponent(DRIVE_USER)}/drive`;
}

/** POST target for creating a child inside a given path (or at root if no path). */
function childrenUrl(parentPath) {
  if (!parentPath) return `${userBase()}/root/children`;
  const encoded = parentPath.split('/').map(encodeURIComponent).join('/');
  return `${userBase()}/root:/${encoded}:/children`;
}

/** GET / PATCH target for an item at a given path. */
function itemUrl(path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${userBase()}/root:/${encoded}:`;
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Create a folder inside parentPath (or at drive root if parentPath is null).
 * If the folder already exists (409), fetch and return the existing item.
 */
async function ensureFolder(token, parentPath, folderName) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    const res = await axios.post(
      childrenUrl(parentPath),
      { name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      { headers }
    );
    return { id: res.data.id, webUrl: res.data.webUrl };
  } catch (err) {
    if (err.response?.status === 409) {
      const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
      const res = await axios.get(itemUrl(fullPath), { headers });
      return { id: res.data.id, webUrl: res.data.webUrl };
    }
    // Log the full Graph API error body for diagnosis
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[OneDrive] API error creating "${folderName}" under "${parentPath || 'root'}": ${detail}`);
    throw err;
  }
}

/**
 * Generate an organisation-scoped edit sharing link.
 * Any member of the organisation can open it without individual sharing.
 */
async function createOrgLink(token, itemId) {
  const res = await axios.post(
    `${userBase()}/items/${itemId}/createLink`,
    { type: 'edit', scope: 'organization' },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return res.data.link.webUrl;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create the client folder structure in OneDrive and return a sharing link
 * per Document Category.
 *
 * @param {{
 *   clientName: string,
 *   caseRef:    string,
 *   categories: string[],
 * }} params
 * @returns {Promise<{ [category: string]: string }>}
 */
async function createClientFolders({ clientName, caseRef, categories }) {
  if (!categories.length) {
    console.warn('[OneDrive] No categories provided — skipping folder creation');
    return {};
  }

  let token;
  try {
    console.log('[OneDrive] Acquiring MS Graph access token...');
    token = await getAccessToken();
    console.log('[OneDrive] Token acquired successfully');
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error('[OneDrive] Token acquisition failed:', detail);
    throw err;
  }

  // Sanitise folder name — remove characters not allowed in OneDrive paths
  const safeName   = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
  const clientPath = `${ROOT_FOLDER}/${safeName}`;

  // 1. Ensure root "Client Documents" folder
  await ensureFolder(token, null, ROOT_FOLDER);
  console.log(`[OneDrive] Root folder ready: ${ROOT_FOLDER}`);

  // 2. Ensure client folder
  await ensureFolder(token, ROOT_FOLDER, safeName);
  console.log(`[OneDrive] Client folder ready: ${clientPath}`);

  // 3. Create one subfolder per unique category and generate a sharing link
  const categoryLinks = {};

  for (const category of categories) {
    if (!category) continue;
    try {
      const { id } = await ensureFolder(token, clientPath, category);
      const sharingUrl = await createOrgLink(token, id);
      categoryLinks[category] = sharingUrl;
      console.log(`[OneDrive] ✓ ${category} → ${sharingUrl}`);
    } catch (err) {
      console.error(`[OneDrive] Failed to create folder for category "${category}":`, err.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  return categoryLinks;
}

/**
 * Upload a file buffer into the client's category subfolder in OneDrive.
 * If a file with the same name already exists, OneDrive automatically keeps
 * the previous version in version history (replace behaviour).
 *
 * @param {{
 *   clientName: string,
 *   caseRef:    string,
 *   category:   string,
 *   filename:   string,
 *   buffer:     Buffer,
 *   mimeType:   string,
 * }} params
 * @returns {Promise<string>} webUrl of the uploaded file
 */
async function uploadFile({ clientName, caseRef, category, filename, buffer, mimeType }) {
  const token    = await getAccessToken();
  const safeName = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
  const safeFile = filename.replace(/[*:"<>?\\|]/g, '').trim() || 'document';

  // PUT /drive/root:/{path}/{filename}:/content  → creates or replaces the file
  const filePath = `${ROOT_FOLDER}/${safeName}/${category}/${safeFile}`;
  const encoded  = filePath.split('/').map(encodeURIComponent).join('/');
  const url      = `${userBase()}/root:/${encoded}:/content`;

  try {
    const res = await axios.put(url, buffer, {
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': mimeType || 'application/octet-stream',
      },
      maxContentLength: Infinity,
      maxBodyLength:    Infinity,
    });
    console.log(`[OneDrive] File uploaded → ${res.data.webUrl}`);
    return res.data.webUrl;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[OneDrive] File upload failed (${err.response?.status}): ${detail}`);
    throw new Error(`OneDrive upload failed: ${detail}`);
  }
}

/**
 * Read a file from the client's folder in OneDrive and return its content as a Buffer.
 * Returns null if the file does not exist (404 from Graph API).
 *
 * @param {{
 *   clientName: string,
 *   caseRef:    string,
 *   subfolder:  string,   e.g. 'Questionnaire'
 *   filename:   string,
 * }} params
 * @returns {Promise<Buffer|null>}
 */
async function readFile({ clientName, caseRef, subfolder, filename }) {
  const token    = await getAccessToken();
  const safeName = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
  const safeFile = filename.replace(/[*:"<>?\\|]/g, '').trim();

  const filePath = `${ROOT_FOLDER}/${safeName}/${subfolder}/${safeFile}`;
  const encoded  = filePath.split('/').map(encodeURIComponent).join('/');
  const url      = `${userBase()}/root:/${encoded}:/content`;

  try {
    const res = await axios.get(url, {
      headers:      { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    });
    return Buffer.from(res.data);
  } catch (err) {
    if (err.response?.status === 404) return null;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`OneDrive read failed: ${detail}`);
  }
}

/**
 * Ensure the client root folder exists in OneDrive (creates it if missing).
 * Safe to call before the document-upload flow has run — will not duplicate folders.
 *
 * @param {{ clientName: string, caseRef: string }} params
 */
async function ensureClientFolder({ clientName, caseRef }) {
  const token    = await getAccessToken();
  const safeName = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();

  await ensureFolder(token, null, ROOT_FOLDER);
  await ensureFolder(token, ROOT_FOLDER, safeName);
  console.log(`[OneDrive] Client folder ensured: ${ROOT_FOLDER}/${safeName}`);
}

module.exports = { createClientFolders, uploadFile, readFile, ensureClientFolder };
