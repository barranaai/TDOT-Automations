/**
 * OneDrive Service
 *
 * Creates per-client folder structures in the noreply@tdotimm.com OneDrive for Business
 * and uploads client documents organised by Document Category.
 *
 * Folder structure:
 *   OneDrive (noreply@tdotimm.com)
 *   └── Client Documents/
 *       └── {Client Name} - {Case Reference}/
 *           ├── Identity/
 *           ├── Legal/
 *           └── (one subfolder per unique Document Category in the checklist)
 */

const axios = require('axios');
const { getAccessToken } = require('./microsoftMailService');

const DRIVE_USER  = process.env.MS_FROM_EMAIL || 'noreply@tdotimm.com';
const ROOT_FOLDER = 'Client Documents';
const GRAPH_BASE  = 'https://graph.microsoft.com/v1.0';

// ─── Token cache ──────────────────────────────────────────────────────────────
// Access tokens are valid for ~60 minutes. We cache for 55 minutes to avoid
// fetching a new token on every upload operation.

let _cachedToken  = null;
let _tokenExpiry  = 0;

async function getCachedToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  _cachedToken = await getAccessToken();
  _tokenExpiry  = Date.now() + 55 * 60 * 1000; // 55 minutes
  console.log('[OneDrive] Access token refreshed');
  return _cachedToken;
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function userBase() {
  return `${GRAPH_BASE}/users/${encodeURIComponent(DRIVE_USER)}/drive`;
}

function childrenUrl(parentPath) {
  if (!parentPath) return `${userBase()}/root/children`;
  const encoded = parentPath.split('/').map(encodeURIComponent).join('/');
  return `${userBase()}/root:/${encoded}:/children`;
}

function itemUrl(path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${userBase()}/root:/${encoded}:`;
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Create a folder at parentPath/folderName.
 * If the folder already exists (409), fetch and return the existing item.
 */
async function ensureFolder(token, parentPath, folderName) {
  const headers = {
    Authorization:  `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  try {
    const res = await axios.post(
      childrenUrl(parentPath),
      { name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      { headers }
    );
    return { id: res.data.id, webUrl: res.data.webUrl };
  } catch (err) {
    if (err.response?.status === 409) {
      // Folder already exists — fetch the existing item
      const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
      const res = await axios.get(itemUrl(fullPath), { headers });
      return { id: res.data.id, webUrl: res.data.webUrl };
    }
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[OneDrive] Error creating folder "${folderName}" under "${parentPath || 'root'}": ${detail}`);
    throw err;
  }
}

/**
 * Generate an organisation-scoped edit sharing link for a folder.
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
 * Create the full client folder structure in OneDrive and return a sharing link
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

  const token = await getCachedToken();

  const safeName   = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
  const clientPath = `${ROOT_FOLDER}/${safeName}`;

  await ensureFolder(token, null, ROOT_FOLDER);
  console.log(`[OneDrive] Root folder ready: ${ROOT_FOLDER}`);

  await ensureFolder(token, ROOT_FOLDER, safeName);
  console.log(`[OneDrive] Client folder ready: ${clientPath}`);

  const categoryLinks = {};

  for (const category of categories) {
    if (!category) continue;
    try {
      const { id } = await ensureFolder(token, clientPath, category);
      const sharingUrl = await createOrgLink(token, id);
      categoryLinks[category] = sharingUrl;
      console.log(`[OneDrive] ✓ ${category} → ${sharingUrl}`);
    } catch (err) {
      console.error(`[OneDrive] Failed to create folder for category "${category}": ${err.message}`);
    }
  }

  return categoryLinks;
}

/**
 * Upload a file buffer to the client's category subfolder in OneDrive.
 * Uses a PUT to the full path — Graph API creates parent folders automatically
 * if they don't exist. Existing files are replaced (version history is kept).
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
  const token    = await getCachedToken();
  const safeName = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
  const safeFile = filename.replace(/[*:"<>?\\|]/g, '').trim() || 'document';

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
    console.log(`[OneDrive] Uploaded → ${res.data.webUrl}`);
    return res.data.webUrl;
  } catch (err) {
    // If token expired mid-operation, invalidate cache and retry once
    if (err.response?.status === 401) {
      console.warn('[OneDrive] 401 on upload — invalidating token cache and retrying');
      _cachedToken = null;
      _tokenExpiry = 0;
      return uploadFile({ clientName, caseRef, category, filename, buffer, mimeType });
    }
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[OneDrive] Upload failed (${err.response?.status}): ${detail}`);
    throw new Error(`OneDrive upload failed: ${detail}`);
  }
}

/**
 * Read a file from the client's OneDrive folder and return it as a Buffer.
 * Returns null if the file does not exist (404).
 *
 * @param {{
 *   clientName: string,
 *   caseRef:    string,
 *   subfolder:  string,
 *   filename:   string,
 * }} params
 * @returns {Promise<Buffer|null>}
 */
async function readFile({ clientName, caseRef, subfolder, filename }) {
  const token    = await getCachedToken();
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
 * Ensure the client root folder exists in OneDrive.
 * Safe to call before any uploads — will not duplicate folders.
 *
 * @param {{ clientName: string, caseRef: string }} params
 */
async function ensureClientFolder({ clientName, caseRef }) {
  const token    = await getCachedToken();
  const safeName = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();

  await ensureFolder(token, null, ROOT_FOLDER);
  await ensureFolder(token, ROOT_FOLDER, safeName);
  console.log(`[OneDrive] Client folder ensured: ${ROOT_FOLDER}/${safeName}`);
}

module.exports = { createClientFolders, uploadFile, readFile, ensureClientFolder };
