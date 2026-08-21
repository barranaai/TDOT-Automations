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



async function getCachedToken() {
  // NO local cache. This wrapper used to keep tokens for 55 minutes from ITS
  // OWN refresh time while the underlying getAccessToken has its own cache —
  // stacked, it could adopt a token already ~54 minutes old and serve it for
  // another 55: a recurring ~49-minute Graph outage every ~2 hours
  // ("Lifetime validation failed, the token is expired" — found live
  // 2026-08-21, every client questionnaire reading blank). The mail service's
  // cache (expires_in with a 5-minute buffer) is the single source of truth.
  return getAccessToken();
}

/** After a Graph 401, drop the cached token so the retry mints a fresh one. */
function invalidateToken() {
  try { require('./microsoftMailService').invalidateAccessToken(); } catch (_) { /* best-effort */ }
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
async function uploadFile({ clientName, caseRef, category, filename, buffer, mimeType, _retried = false }) {
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
    if (err.response?.status === 401 && !_retried) {
      console.warn('[OneDrive] 401 on upload — invalidating token cache and retrying');
      invalidateToken();
      return uploadFile({ clientName, caseRef, category, filename, buffer, mimeType, _retried: true });
    }
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[OneDrive] Upload failed (${err.response?.status}): ${detail}`);
    const _err1 = new Error(`OneDrive upload failed: ${detail}`); _err1.transient = true; throw _err1;
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
    if (err.response?.status === 401) {
      // Expired/revoked bearer despite the cache — mint a fresh token and
      // retry ONCE (the 2026-08-21 outage class).
      invalidateToken();
      const fresh = await getCachedToken();
      try {
        const res2 = await axios.get(url, { headers: { Authorization: `Bearer ${fresh}` }, responseType: 'arraybuffer' });
        return Buffer.from(res2.data);
      } catch (err2) {
        if (err2.response?.status === 404) return null;
        const d2 = err2.response?.data ? JSON.stringify(err2.response.data) : err2.message;
        const _err2 = new Error(`OneDrive read failed: ${d2}`); _err2.transient = true; throw _err2;
      }
    }
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    const _err3 = new Error(`OneDrive read failed: ${detail}`); _err3.transient = true; throw _err3;
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

/**
 * Ensure a single category subfolder exists under the client root and return
 * an organisation-scoped sharing link.  Used to backfill the Document Folder
 * column on execution items that were created before OneDrive folders existed.
 *
 * @param {{ clientName: string, caseRef: string, category: string }} params
 * @returns {Promise<string>} sharing URL for the category folder
 */
async function ensureCategoryFolderLink({ clientName, caseRef, category }) {
  const token      = await getCachedToken();
  const safeName   = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
  const clientPath = `${ROOT_FOLDER}/${safeName}`;

  await ensureFolder(token, null, ROOT_FOLDER);
  await ensureFolder(token, ROOT_FOLDER, safeName);
  const { id } = await ensureFolder(token, clientPath, category);
  return createOrgLink(token, id);
}

/**
 * Create the client folder at LEAD-INTAKE time, before a case reference exists:
 *   Client Documents/{Full Name} - LEAD-{leadId}
 *
 * The returned driveItem id is persisted on the Lead Board (and carried to the
 * Client Master at handoff) so caseRefService can RENAME this same folder to
 * "{Client Name} - {Case Ref}" the moment the reference is generated — after
 * which every existing path-based lookup in this service resolves to it.
 *
 * @param {{ fullName: string, leadId: string|number }} params
 * @returns {Promise<{ id: string, url: string }>} folder id + staff sharing link
 */
async function ensureLeadFolder({ fullName, leadId }) {
  const token    = await getCachedToken();
  const safeName = `${fullName} - LEAD-${leadId}`.replace(/[*:"<>?/\\|]/g, '').trim();

  await ensureFolder(token, null, ROOT_FOLDER);
  const { id, webUrl } = await ensureFolder(token, ROOT_FOLDER, safeName);
  console.log(`[OneDrive] Lead folder ready: ${ROOT_FOLDER}/${safeName}`);

  let url = webUrl;
  try {
    url = await createOrgLink(token, id);
  } catch (err) {
    console.warn(`[OneDrive] Sharing link failed for lead folder (using webUrl): ${err.message}`);
  }
  return { id, url };
}

/**
 * Rename a drive item by id. Used to rename the intake-stage lead folder to
 * its final "{Client Name} - {Case Ref}" name once the reference is assigned.
 * Throws on failure (callers treat it as non-fatal); a 409 means a folder with
 * the target name already exists — callers log and continue, since the
 * path-based flow will then simply use that existing folder.
 *
 * @param {string} itemId   driveItem id
 * @param {string} newName  desired folder name (will be sanitized)
 * @returns {Promise<{ id: string, name: string, webUrl: string }>}
 */
async function renameDriveItem(itemId, newName) {
  const token    = await getCachedToken();
  const safeName = String(newName).replace(/[*:"<>?/\\|]/g, '').trim();
  const res = await axios.patch(
    `${userBase()}/items/${itemId}`,
    { name: safeName },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  console.log(`[OneDrive] Renamed item ${itemId} → "${safeName}"`);
  return { id: res.data.id, name: res.data.name, webUrl: res.data.webUrl };
}

/**
 * Look up a folder directly under the client-documents root by its display
 * name. 404 → null (never throws for a missing folder).
 *
 * @param {string} folderName  e.g. "Jane Doe - 2026-VV-009" (will be sanitized)
 * @returns {Promise<{ id: string, name: string, webUrl: string }|null>}
 */
async function getClientFolderByName(folderName) {
  const token    = await getCachedToken();
  const safeName = String(folderName).replace(/[*:"<>?/\\|]/g, '').trim();
  if (!safeName) return null;
  try {
    const res = await axios.get(itemUrl(`${ROOT_FOLDER}/${safeName}`), {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { id: res.data.id, name: res.data.name, webUrl: res.data.webUrl };
  } catch (err) {
    if (err.response?.status === 404) return null;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`OneDrive folder lookup failed: ${detail}`);
  }
}

/**
 * Resolve a driveItem by id — name, webUrl and its PARENT PATH (so callers can
 * verify the item really sits under the client-documents root before doing
 * anything destructive with it). 404 → null.
 *
 * @param {string} itemId  driveItem id
 * @returns {Promise<{ id, name, webUrl, parentPath }|null>}
 */
async function getDriveItemById(itemId) {
  const token = await getCachedToken();
  try {
    const res = await axios.get(`${userBase()}/items/${itemId}?$select=id,name,webUrl,parentReference`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return {
      id: res.data.id,
      name: res.data.name,
      webUrl: res.data.webUrl,
      parentPath: (res.data.parentReference && res.data.parentReference.path) || '',
    };
  } catch (err) {
    if (err.response?.status === 404) return null;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`OneDrive item lookup failed: ${detail}`);
  }
}

/**
 * Delete a driveItem (folder + all contents) by id. Graph moves it to the
 * drive's RECYCLE BIN — recoverable there, never a hard delete. 404 is treated
 * as already-gone (returns false); anything else throws.
 *
 * @param {string} itemId  driveItem id
 * @returns {Promise<boolean>} true = deleted now, false = was already gone
 */
async function deleteDriveItem(itemId, _retried = false) {
  const token = await getCachedToken();
  try {
    await axios.delete(`${userBase()}/items/${itemId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`[OneDrive] Deleted item ${itemId} (moved to recycle bin)`);
    return true;
  } catch (err) {
    if (err.response?.status === 404) return false;
    if (err.response?.status === 401 && !_retried) {
      console.log('[OneDrive] Token expired mid-delete, refreshing…');
      invalidateToken();
      return deleteDriveItem(itemId, true);
    }
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`OneDrive delete failed: ${detail}`);
  }
}

/**
 * Upload a file and return an organisation-scoped sharing link to it (plus the
 * raw webUrl/id). Same path semantics as uploadFile; use this when the link
 * goes into a Monday column staff will click — bare webUrls in the noreply
 * drive aren't accessible to other staff accounts, org links are.
 *
 * @returns {Promise<{ url: string, webUrl: string, id: string }>}
 */
async function uploadFileAndLink({ clientName, caseRef, category, filename, buffer, mimeType }) {
  const token    = await getCachedToken();
  const safeName = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
  const safeFile = filename.replace(/[*:"<>?\\|]/g, '').trim() || 'document';
  const filePath = `${ROOT_FOLDER}/${safeName}/${category}/${safeFile}`;
  const encoded  = filePath.split('/').map(encodeURIComponent).join('/');

  const res = await axios.put(`${userBase()}/root:/${encoded}:/content`, buffer, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || 'application/octet-stream' },
    maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  let url = res.data.webUrl;
  try {
    url = await createOrgLink(token, res.data.id);
  } catch (err) {
    console.warn(`[OneDrive] Org link failed for ${safeFile} (using webUrl): ${err.message}`);
  }
  console.log(`[OneDrive] Uploaded + linked → ${filePath}`);
  return { url, webUrl: res.data.webUrl, id: res.data.id };
}

/**
 * Upload a buffer straight into the lead's OneDrive folder (addressed by the
 * folder's item id, so there's no missing-subfolder 404 the path-based upload
 * would hit) and return an organisation-scoped sharing link. Used for the Teams
 * transcript, which we fetch from Graph and store alongside the client's docs.
 *
 * @returns {Promise<{ url: string, webUrl: string, id: string }>}
 */
async function uploadToLeadFolderAndLink({ fullName, leadId, folderId, filename, buffer, mimeType }) {
  const token = await getCachedToken();
  // Prefer the stored folder id — a driveItem keeps its id when the intake folder
  // is renamed to "{name} - {caseRef}" at handoff, so a post-handoff upload still
  // lands in the right place. Resolve by name only when no id was passed.
  let id = String(folderId || '').trim();
  if (!id) { id = (await ensureLeadFolder({ fullName, leadId })).id; }
  const safeFile = String(filename).replace(/[*:"<>?/\\|]/g, '').trim() || 'file';
  const res = await axios.put(
    `${userBase()}/items/${id}:/${encodeURIComponent(safeFile)}:/content`,
    buffer,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || 'application/octet-stream' },
      maxContentLength: Infinity, maxBodyLength: Infinity }
  );
  let url = res.data.webUrl;
  try { url = await createOrgLink(token, res.data.id); }
  catch (err) { console.warn(`[OneDrive] Org link failed for ${safeFile} (using webUrl): ${err.message}`); }
  console.log(`[OneDrive] Uploaded to lead folder → ${safeFile}`);
  return { url, webUrl: res.data.webUrl, id: res.data.id };
}


/**
 * List a stored file's version history (OneDrive/SharePoint keeps versions
 * automatically). Newest first. Returns [] when the file or history is absent.
 *
 * Added 2026-08-19 after an operator action overwrote a client's saved
 * questionnaire: without a recovery path, one bad write is permanent.
 */
async function listFileVersions({ clientName, caseRef, subfolder, filename }) {
  const token    = await getCachedToken();
  const safeName = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
  const safeFile = filename.replace(/[*:"<>?\\|]/g, '').trim();
  const filePath = `${ROOT_FOLDER}/${safeName}/${subfolder}/${safeFile}`;
  const encoded  = filePath.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await axios.get(`${userBase()}/root:/${encoded}:/versions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (res.data && res.data.value) || [];
  } catch (err) {
    if (err.response?.status === 404) return [];
    throw new Error(`OneDrive version list failed: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
  }
}

/** Fetch the CONTENT of one historical version (Buffer), or null if absent. */
async function readFileVersion({ clientName, caseRef, subfolder, filename, versionId }) {
  const token    = await getCachedToken();
  const safeName = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
  const safeFile = filename.replace(/[*:"<>?\\|]/g, '').trim();
  const filePath = `${ROOT_FOLDER}/${safeName}/${subfolder}/${safeFile}`;
  const encoded  = filePath.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await axios.get(
      `${userBase()}/root:/${encoded}:/versions/${encodeURIComponent(versionId)}/content`,
      { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' });
    return Buffer.from(res.data);
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw new Error(`OneDrive version read failed: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
  }
}

module.exports = {
  createClientFolders, uploadFile, readFile, ensureClientFolder, ensureCategoryFolderLink,
  ensureLeadFolder, renameDriveItem, uploadFileAndLink, uploadToLeadFolderAndLink,
  getClientFolderByName, getDriveItemById, deleteDriveItem,
  listFileVersions, readFileVersion,
};
