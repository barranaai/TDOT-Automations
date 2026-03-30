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
 *
 * Returns a map of { [category]: sharingUrl } so each checklist row can be linked
 * to its correct category folder on the Document Checklist Execution Board.
 */

const axios = require('axios');
const { getAccessToken } = require('./microsoftMailService');

const DRIVE_USER   = process.env.MS_FROM_EMAIL || 'noreply@tdotimm.com';
const ROOT_FOLDER  = 'Client Documents';
const GRAPH_BASE   = 'https://graph.microsoft.com/v1.0';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function driveUrl(path) {
  const encoded = encodeURIComponent(path).replace(/%2F/g, '/');
  return `${GRAPH_BASE}/users/${encodeURIComponent(DRIVE_USER)}/drive/root:/${encoded}:`;
}

/**
 * Create a folder at the given OneDrive path if it does not already exist.
 * Uses PUT with conflictBehavior=fail to avoid overwriting; on 409 (already exists),
 * fetches the existing item instead.
 *
 * @param {string} token   - MS Graph access token
 * @param {string} path    - Path relative to drive root, e.g. "Client Documents/Smith - 2026-CIT-001"
 * @returns {Promise<{ id: string, webUrl: string }>}
 */
async function ensureFolder(token, path) {
  const url = driveUrl(path);
  try {
    const res = await axios.put(
      url,
      { folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return { id: res.data.id, webUrl: res.data.webUrl };
  } catch (err) {
    if (err.response?.status === 409) {
      // Folder already exists — fetch it
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { id: res.data.id, webUrl: res.data.webUrl };
    }
    throw err;
  }
}

/**
 * Generate an organisation-scoped edit sharing link for a drive item.
 * Any member of the organisation can open it without individual sharing.
 *
 * @param {string} token   - MS Graph access token
 * @param {string} itemId  - OneDrive item ID
 * @returns {Promise<string>} Sharing URL
 */
async function createOrgLink(token, itemId) {
  const res = await axios.post(
    `${GRAPH_BASE}/users/${encodeURIComponent(DRIVE_USER)}/drive/items/${itemId}/createLink`,
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
 *   categories: string[],   - unique Document Category values from the checklist
 * }} params
 * @returns {Promise<{ [category: string]: string }>} Map of category → sharing URL
 */
async function createClientFolders({ clientName, caseRef, categories }) {
  if (!categories.length) {
    console.warn('[OneDrive] No categories provided — skipping folder creation');
    return {};
  }

  const token = await getAccessToken();

  // Sanitise folder name — remove characters not allowed in OneDrive paths
  const safeName = `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();

  // 1. Ensure root "Client Documents" folder exists
  await ensureFolder(token, ROOT_FOLDER);
  console.log(`[OneDrive] Root folder ready: ${ROOT_FOLDER}`);

  // 2. Ensure client folder exists
  const clientPath = `${ROOT_FOLDER}/${safeName}`;
  await ensureFolder(token, clientPath);
  console.log(`[OneDrive] Client folder ready: ${clientPath}`);

  // 3. Create one subfolder per unique category and generate a sharing link
  const categoryLinks = {};

  for (const category of categories) {
    if (!category) continue;
    const categoryPath = `${clientPath}/${category}`;
    try {
      const { id } = await ensureFolder(token, categoryPath);
      const sharingUrl = await createOrgLink(token, id);
      categoryLinks[category] = sharingUrl;
      console.log(`[OneDrive] ✓ ${category} → ${sharingUrl}`);
    } catch (err) {
      console.error(`[OneDrive] Failed to create folder for category "${category}":`, err.message);
    }

    // Brief pause to avoid Graph API rate limits
    await new Promise(r => setTimeout(r, 150));
  }

  return categoryLinks;
}

module.exports = { createClientFolders };
