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
// Every Graph call is bounded (axios's default is NO timeout): the e-sign
// capture uploads while holding the lead lock, which Mark paid, Undo and the
// status sync wait on — one hung socket must not keep a client "busy" until
// the next deploy. Uploads get longer: a scanned bundle over a slow link.
const GRAPH_TIMEOUT_MS        = 30000;
const GRAPH_UPLOAD_TIMEOUT_MS = 120000;

// ─── Token handling ───────────────────────────────────────────────────────────

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

/**
 * Tag a terminal Graph failure as `transient` when it is a storage-side
 * problem (no response / 401 / 408 / 429 / 5xx) rather than a caller mistake.
 * Routes use this flag to answer an honest 503 instead of guessing an access
 * error from message substrings (Graph's own "token is expired" text used to
 * trip the includes('token') 403 classifiers).
 */
function tagTransient(err) {
  const st = err.response?.status;
  if (st === undefined || st === 401 || st === 408 || st === 429 || st >= 500) {
    err.transient = true;
  }
  return err;
}

/**
 * Run ONE Graph operation with auth + honest failure semantics: mint (or use
 * the cached) token, and on a 401 — an expired/revoked bearer despite the
 * cache, the 2026-08-21 outage class — invalidate the cache, re-mint, and
 * retry the WHOLE operation exactly once. Operations passed here must be
 * idempotent (ensureFolder/PUT/GET/PATCH/DELETE all are). Terminal failures
 * come back tagged via tagTransient; token-mint failures are transient by
 * definition.
 *
 * EVERY public function in this service must route its Graph calls through
 * this helper — a function that grabs a token and calls axios directly
 * re-opens the class of bugs where the first hop of a composite flow 401s
 * with no retry and the poisoned cache is never invalidated.
 */
async function withGraphAuth(label, fn) {
  let token;
  try {
    token = await getCachedToken();
  } catch (err) {
    err.transient = true;
    throw err;
  }
  try {
    return await fn(token);
  } catch (err) {
    if (err.response?.status !== 401) throw tagTransient(err);
    console.warn(`[OneDrive] 401 on ${label} — invalidating token cache and retrying`);
    invalidateToken();
    let fresh;
    try {
      fresh = await getCachedToken();
    } catch (mintErr) {
      mintErr.transient = true;
      throw mintErr;
    }
    try {
      return await fn(fresh);
    } catch (err2) {
      throw tagTransient(err2);
    }
  }
}

/** Wrap a raw axios/Graph error in a labelled Error, PRESERVING .transient. */
function wrapError(prefix, err) {
  const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  const wrapped = new Error(`${prefix}: ${detail}`);
  if (err.transient === true) wrapped.transient = true;
  if (err.held === true) wrapped.held = true;
  return wrapped;
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

// ─── Core helpers (called INSIDE a withGraphAuth scope with its token) ────────

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
      { headers, timeout: GRAPH_TIMEOUT_MS }
    );
    return { id: res.data.id, webUrl: res.data.webUrl, created: true, createdAt: res.data.createdDateTime || '' };
  } catch (err) {
    if (err.response?.status === 409) {
      // Folder already exists — fetch the existing item
      const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
      const res = await axios.get(itemUrl(fullPath), { headers, timeout: GRAPH_TIMEOUT_MS });
      return { id: res.data.id, webUrl: res.data.webUrl, created: false, createdAt: res.data.createdDateTime || '' };
    }
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[OneDrive] Error creating folder "${folderName}" under "${parentPath || 'root'}": ${detail}`);
    throw err; // raw — the enclosing withGraphAuth handles 401 retry + tagging
  }
}

/**
 * Generate an organisation-scoped edit sharing link for a folder.
 */
async function createOrgLink(token, itemId) {
  const res = await axios.post(
    `${userBase()}/items/${itemId}/createLink`,
    { type: 'edit', scope: 'organization' },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: GRAPH_TIMEOUT_MS }
  );
  return res.data.link.webUrl;
}

/**
 * The four staff working folders every NEW case folder carries (Faran,
 * 2026-10-01). Numbered so they sit at the top of the folder in the order of
 * the submission flow. Staff-only: the app never writes a client upload or one
 * of its own files into them, and the client never sees them.
 *
 * "New" = a case folder CREATED on or after WORK_FOLDERS_SINCE (the hour the
 * feature went live, 2026-09-30 16:00 Toronto), whichever code
 * path minted it (the intake-folder rename, the checklist build, a
 * questionnaire save, a signed agreement, a raw upload). Every touch of such a
 * folder through this service adds whatever is still missing, so an outage at
 * one moment heals on the next touch; a folder that already has all four costs
 * one listing per process and nothing after. Cases from before that date are
 * never touched.
 */
const CASE_WORK_FOLDERS  = ['1-Coordinator-Working', '2-Case-Manager-Draft', '3-AW-Analyst-Final-RCIC', '4-Submitted-IRCC'];
const WORK_FOLDERS_SINCE = Date.parse('2026-09-30T20:00:00Z');   // the feature went live 2026-09-30 16:27 Toronto
const _workFoldersComplete = new Set();   // folder ids seen with all four present (per process)

/** A case folder this feature applies to: created now, or created since the feature went live. */
function isNewCaseFolder(folder) {
  if (!folder) return false;
  if (folder.created) return true;
  const t = Date.parse(folder.createdAt || '');
  return Number.isFinite(t) && t >= WORK_FOLDERS_SINCE;
}

/**
 * Make sure the four working folders exist inside a case folder, addressed by
 * its drive item id (the id survives the rename this runs right after, and a
 * name cache can lag it). ONE listing first, then only the missing folders are
 * created. Each folder is tried even if an earlier one failed; the error thrown
 * at the end names the ones still missing (err.missing) so staff can be told
 * exactly what to add. A 401 escapes so withGraphAuth can refresh the token
 * and retry the whole (idempotent) pass. `created` is everything THIS call
 * made, across that retry; an error carries the same as err.created.
 *
 * @param {{ folderId: string, label?: string, dryRun?: boolean }} p  label = the case reference, for the log;
 *   dryRun = list only, create nothing (the backfill's preview)
 * @returns {Promise<{ created: string[], present: string[], wouldCreate?: string[] }>}
 */
async function ensureCaseWorkFolders({ folderId, label = '', dryRun = false }) {
  if (!folderId) throw new Error('ensureCaseWorkFolders: folderId required');
  // What THIS call made, across withGraphAuth's re-run after a 401: the second
  // pass lists the first pass's folders as already there, and the caller must
  // still hear that this call created them (the backfill's report counts them).
  const made = [];
  try {
    return await withGraphAuth('ensureCaseWorkFolders', async (token) => {
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const have = new Set();   // lower-cased: OneDrive names ignore case, so "1-coordinator-working" IS the folder
      let next = `${userBase()}/items/${encodeURIComponent(folderId)}/children?$select=name,folder&$top=200`;
      while (next) {   // every page: a working folder on page two is still there
        const listing = await axios.get(next, { headers, timeout: GRAPH_TIMEOUT_MS });
        for (const c of (listing.data.value || [])) if (c.folder) have.add(String(c.name).toLowerCase());
        next = listing.data['@odata.nextLink'] || null;
      }
      const isThere = (n) => have.has(n.toLowerCase());
      if (dryRun) {
        return { created: [], present: CASE_WORK_FOLDERS.filter(isThere), wouldCreate: CASE_WORK_FOLDERS.filter((n) => !isThere(n)) };
      }
      const created = [], present = [], missing = [];
      let lastErr = null;
      for (const name of CASE_WORK_FOLDERS) {
        if (isThere(name)) { if (!made.includes(name)) present.push(name); continue; }
        try {
          await axios.post(`${userBase()}/items/${encodeURIComponent(folderId)}/children`,
            { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }, { headers, timeout: GRAPH_TIMEOUT_MS });
          created.push(name); made.push(name);
        } catch (err) {
          if (err.response?.status === 401) throw err;                          // let withGraphAuth retry the whole pass
          if (err.response?.status === 409) { present.push(name); continue; }   // made by someone else meanwhile
          const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
          console.error(`[OneDrive] Could not create working folder "${name}" for ${label || folderId}: ${detail}`);
          missing.push(name); lastErr = err;
        }
      }
      if (created.length) console.log(`[OneDrive] Working folders created for ${label || folderId}: ${created.join(', ')}`);
      if (missing.length) {
        const e = new Error(`working folders not created: ${missing.join(', ')} (${lastErr && lastErr.message})`);
        e.missing = missing; e.cause = lastErr;
        throw tagTransient(e);
      }
      _workFoldersComplete.add(String(folderId));
      return { created: [...made], present };
    });
  } catch (err) {
    if (err && typeof err === 'object' && !Array.isArray(err.created)) err.created = [...made];   // made before the failure
    throw err;
  }
}

/**
 * The step every creator of a case folder runs after ensuring it: add the
 * working folders when the folder is new (see isNewCaseFolder). Never throws
 * except on a 401 (so the enclosing pass can refresh and retry); any other
 * refusal is logged and handed to `onFailed` for the caller that can tell staff.
 */
async function addWorkFoldersIfNew(folder, caseRef, onFailed) {
  if (!isNewCaseFolder(folder) || _workFoldersComplete.has(String(folder.id))) return;
  try {
    await ensureCaseWorkFolders({ folderId: folder.id, label: caseRef });
  } catch (err) {
    if (err.response?.status === 401) throw err;
    console.warn(`[OneDrive] Working folders not created for ${caseRef}: ${err.message}`);
    if (typeof onFailed === 'function') { try { await onFailed(err); } catch (_) { /* the caller's note is best effort */ } }
  }
}

/** The plain-word staff note when the working folders could not be created — one text, used by every caller. */
function workFoldersFailedNoteText(err) {
  const names = (err && Array.isArray(err.missing) && err.missing.length) ? err.missing : CASE_WORK_FOLDERS;
  const reason = String((err && err.cause && err.cause.message) || (err && err.message) || 'OneDrive refused').replace(/[<>]/g, '');
  return `⚠ Could not create the working folder${names.length === 1 ? '' : 's'} ${names.join(', ')} in this client's OneDrive folder — ` +
    `please add ${names.length === 1 ? 'it' : 'them'} by hand. Reason: ${reason}`;
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
async function createClientFolders({ clientName, caseRef, categories, onWorkFoldersFailed }) {
  if (!categories.length) {
    console.warn('[OneDrive] No categories provided — skipping folder creation');
    return {};
  }

  // Resolve first: re-seeding a case whose folder was renamed must reuse that
  // folder, never mint a second one beside it.
  const safeName   = await resolveCaseFolderNameForWrite({ clientName, caseRef });
  const clientPath = `${ROOT_FOLDER}/${safeName}`;

  return withGraphAuth('createClientFolders', async (token) => {
    await ensureFolder(token, null, ROOT_FOLDER);
    console.log(`[OneDrive] Root folder ready: ${ROOT_FOLDER}`);

    const clientFolder = await ensureFolder(token, ROOT_FOLDER, safeName);
    console.log(`[OneDrive] Client folder ready: ${clientPath}`);
    await addWorkFoldersIfNew(clientFolder, caseRef, onWorkFoldersFailed);

    const categoryLinks = {};

    for (const category of categories) {
      if (!category) continue;
      try {
        const { id } = await ensureFolder(token, clientPath, category);
        const sharingUrl = await createOrgLink(token, id);
        categoryLinks[category] = sharingUrl;
        console.log(`[OneDrive] ✓ ${category} → ${sharingUrl}`);
      } catch (err) {
        // Best-effort per category — but a 401 must escape so withGraphAuth
        // can refresh the token and retry the whole (idempotent) flow.
        if (err.response?.status === 401) throw err;
        console.error(`[OneDrive] Failed to create folder for category "${category}": ${err.message}`);
      }
    }

    return categoryLinks;
  });
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
  const safeFile = filename.replace(/[*:"<>?\\|]/g, '').trim() || 'document';

  try {
    // Resolved BEFORE the write, never healed after it: a PUT to a path whose
    // parent is missing can create that parent, which would quietly mint a
    // second folder for this case instead of failing loudly.
    const resolved = await resolveCaseFolderNameForWrite({ clientName, caseRef });
    return await (async (safeName) => {
      const filePath = `${ROOT_FOLDER}/${safeName}/${category}/${safeFile}`;
      const encoded  = filePath.split('/').map(encodeURIComponent).join('/');
      const url      = `${userBase()}/root:/${encoded}:/content`;
      return withGraphAuth('upload', async (token) => {
      const res = await axios.put(url, buffer, {
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': mimeType || 'application/octet-stream',
        },
        maxContentLength: Infinity,
        maxBodyLength:    Infinity,
        timeout:          GRAPH_UPLOAD_TIMEOUT_MS,
      });
      console.log(`[OneDrive] Uploaded → ${res.data.webUrl}`);
      return res.data.webUrl;
    });
    })(resolved);
  } catch (err) {
    console.error(`[OneDrive] Upload failed (${err.response?.status}): ${err.message}`);
    throw wrapError('OneDrive upload failed', err);
  }
}

// A path longer than this is close to Graph's ~400-character limit; measured
// on the DECODED path, which is what the limit is about.
const PATH_WARN_CHARS = 380;

/**
 * Upload a buffer as a NEW file: never replaces. On a same-named file Graph
 * picks a free name ("x 1.pdf") and that name comes back so the caller records
 * the truth, never the name it asked for. "/" is stripped so a document name
 * can never become a sub-folder.
 *
 * Client checklist uploads only. uploadFile above keeps its replace-in-place
 * contract: every file the app itself writes (questionnaire JSON/PDF, signed
 * agreements, sidecars, markers) relies on that plus OneDrive's version history.
 *
 * Two separate auth scopes on purpose: the PUT alone lives in the first, so a
 * 401 retry re-runs only the PUT (a 401 attempt wrote nothing, so the retry
 * cannot make a second copy). The sharing link lives in its own scope — had
 * it shared the PUT's, a 401 on the link would re-PUT under "rename" and mint
 * a spurious duplicate file.
 *
 * @param {{ clientName: string, caseRef: string, category: string, filename: string, buffer: Buffer, mimeType: string }} params
 * @returns {Promise<{ id: string, name: string, webUrl: string, url: string, replaced: boolean }>}
 *   name = the stored name Graph reports; url = org sharing link (webUrl when the link failed);
 *   replaced = Graph answered 200 (a file was overwritten) instead of 201 (created) — must never happen
 */
async function uploadFileAsNew({ clientName, caseRef, category, filename, buffer, mimeType }) {
  const safeFile = String(filename || '').replace(/[*:"<>?\\|/]/g, '').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '') || 'document';
  // Resolved BEFORE the write (as uploadFile): a stale cached name must not
  // mint a second case folder.
  const safeName = await resolveCaseFolderNameForWrite({ clientName, caseRef });
  const filePath = `${ROOT_FOLDER}/${safeName}/${category}/${safeFile}`;
  const encoded  = filePath.split('/').map(encodeURIComponent).join('/');
  const url      = `${userBase()}/root:/${encoded}:/content?@microsoft.graph.conflictBehavior=rename`;
  if (filePath.length > PATH_WARN_CHARS) {
    console.warn(`[OneDrive] path is ${filePath.length} characters (limit ~400): ${filePath}`);
  }

  // Scope 1: the PUT, and only the PUT.
  let put;
  try {
    put = await withGraphAuth('uploadAsNew', (token) => axios.put(url, buffer, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || 'application/octet-stream' },
      maxContentLength: Infinity, maxBodyLength: Infinity, timeout: GRAPH_UPLOAD_TIMEOUT_MS,
    }));
  } catch (err) {
    console.error(`[OneDrive] Upload (as new) failed (${err.response?.status}): ${err.message}`);
    throw wrapError('OneDrive upload failed', err);
  }
  const { id = '', name = safeFile, webUrl = '' } = put.data || {};
  const replaced = put.status === 200;   // a create answers 201
  if (replaced) console.error(`[OneDrive] REPLACED-IN-PLACE ${filePath} — conflictBehavior=rename was not honoured (the earlier copy is in the file's version history)`);
  if (name !== safeFile) console.log(`[OneDrive] stored as "${name}" (renamed on clash from "${safeFile}")`);

  // Scope 2: the org link staff can open (a bare webUrl in the noreply drive is
  // not openable from another staff account). Best effort — the file is saved.
  let link = webUrl;
  if (id) {
    try {
      link = await withGraphAuth('fileLink', (token) => createOrgLink(token, id));
    } catch (err) {
      console.warn(`[OneDrive] Org link failed for ${name} (using webUrl): ${err.message}`);
    }
  }
  console.log(`[OneDrive] Uploaded (as new) → ${filePath}${name !== safeFile ? ` as "${name}"` : ''}`);
  return { id, name, webUrl, url: link, replaced };
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
  const safeFile = filename.replace(/[*:"<>?\\|]/g, '').trim();
  try {
    // A 404 propagates out of `run` so a renamed case folder can be healed;
    // a genuine "file is not there" comes back as null after that retry.
    return await withCaseFolder({ clientName, caseRef }, async (safeName) => {
      const filePath = `${ROOT_FOLDER}/${safeName}/${subfolder}/${safeFile}`;
      const encoded  = filePath.split('/').map(encodeURIComponent).join('/');
      const url      = `${userBase()}/root:/${encoded}:/content`;
      return withGraphAuth('read', async (token) => {
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer', timeout: GRAPH_TIMEOUT_MS });
        return Buffer.from(res.data);
      });
    });
  } catch (err) {
    if (err?.response?.status === 404) return null;   // absent — not an error
    throw wrapError('OneDrive read failed', err);
  }
}

/**
 * List the FILES in a case sub-folder (folders skipped). An absent folder is
 * not an error → []. Pages through @odata.nextLink.
 * @returns {Promise<Array<{ name: string, size: number, lastModifiedDateTime: string }>>}
 */
async function listChildren({ clientName, caseRef, subfolder = '' }) {
  try {
    return await withCaseFolder({ clientName, caseRef }, async (safeName) => {
      const folderPath = [`${ROOT_FOLDER}/${safeName}`, String(subfolder || '').trim()].filter(Boolean).join('/');
      const firstUrl   = `${childrenUrl(folderPath)}?$select=name,size,lastModifiedDateTime,file,folder&$top=200`;
      return withGraphAuth('list', async (token) => {
        const out = [];
        let next = firstUrl;
        while (next) {
          const res = await axios.get(next, { headers: { Authorization: `Bearer ${token}` }, timeout: GRAPH_TIMEOUT_MS });
          for (const it of (res.data?.value || [])) {
            out.push({ name: it.name, size: it.size, lastModifiedDateTime: it.lastModifiedDateTime, isFolder: Boolean(it.folder) });
          }
          next = res.data?.['@odata.nextLink'] || null;
        }
        return out;
      });
    });
  } catch (err) {
    if (err?.response?.status === 404) return [];   // folder absent — not an error
    throw wrapError('OneDrive list failed', err);
  }
}

/** Files only (folders skipped) — the long-standing contract. */
async function listFiles({ clientName, caseRef, subfolder }) {
  const kids = await listChildren({ clientName, caseRef, subfolder });
  return kids.filter((k) => !k.isFolder).map(({ name, size, lastModifiedDateTime }) => ({ name, size, lastModifiedDateTime }));
}

/**
 * Move ONE file between two sub-folders of a case (same drive). The target
 * folder is created if missing; a same-named file there keeps both
 * (conflictBehavior=rename). Never deletes. Returns { webUrl, name } — name is
 * the stored name after the move (differs from filename only on a clash).
 */
async function moveFile({ clientName, caseRef, fromSubfolder, toSubfolder, filename }) {
  const safeName = await resolveCaseFolderNameForWrite({ clientName, caseRef });   // renamed folders still resolve
  const safeFile = filename.replace(/[*:"<>?\\|/]/g, '').trim();
  if (!safeFile || !fromSubfolder || !toSubfolder || fromSubfolder === toSubfolder) throw new Error('moveFile: bad arguments');
  const casePath = `${ROOT_FOLDER}/${safeName}`;
  const srcUrl   = itemUrl(`${casePath}/${fromSubfolder}/${safeFile}`);
  try {
    return await withGraphAuth('move', async (token) => {
      const headers = { Authorization: `Bearer ${token}` };
      const target  = await ensureFolder(token, casePath, toSubfolder);   // existing folder is returned as-is (409 → fetch)
      const res = await axios.patch(srcUrl, { parentReference: { id: target.id }, '@microsoft.graph.conflictBehavior': 'rename' }, { headers, timeout: GRAPH_TIMEOUT_MS });
      return { webUrl: res.data?.webUrl || '', name: res.data?.name || '' };   // name differs from filename if OneDrive renamed on a clash
    });
  } catch (err) {
    throw wrapError('OneDrive move failed', err);
  }
}

// ─── Case-folder resolution ───────────────────────────────────────────────────
//
// Every path is built from "<client name> - <case ref>", so renaming the Monday
// item breaks every read and write for that case - and silently, because a 404
// reads as "no file" / "no files". The case REFERENCE never changes, so it, not
// the name, decides which folder a case owns.
//
// Cost: one root enumeration per case, cached for CASE_FOLDER_TTL_MS. A 404
// against that cached name then costs ONE path-addressed lookup - never another
// root enumeration - which matters because the questionnaire load probes for
// files that legitimately do not exist. Concurrent callers share one lookup.
//
// The driveItem ID is cached alongside the name, because the name alone cannot
// answer "is this still OUR folder": a write can RE-CREATE a folder under the
// old name after a rename (the "resurrection" half of the duplicate-folder
// defect, Gauri 2026-09-04 point 12), and a name-only check would keep
// confirming that impostor while the documents sat elsewhere.
const _caseFolderName = new Map();          // caseRef -> { name|null, id, at }  (null = looked, found nothing)
const _caseFolderInFlight = new Map();      // caseRef -> Promise, so N callers page the root once
const _caseFolderConfirm  = new Map();      // `ref\nname` -> Promise, so a burst of absent-file probes costs one lookup
const _caseFolderFollow   = new Map();      // `ref\nid`   -> Promise, so a burst healing one rename pages the root once
const CASE_FOLDER_TTL_MS     = 10 * 60 * 1000;   // a rename mid-process heals within this
/**
 * Cases whose folder is being REPAIRED right now (caseFolderMergeService):
 * between "the test folder comes off the reference" and "every file is in the
 * real folder", a lookup would land on the real folder and find files missing
 * — a page view then seeds a blank questionnaire there. So while a case is
 * held, every resolution throws a transient error: callers answer 503 "try
 * again shortly" and the client engine freezes its writes. Seconds, once.
 */
const _caseFolderHold = new Map();           // caseRef -> { since, why }
function holdCaseFolder(caseRef, why = 'folder repair in progress') { _caseFolderHold.set(String(caseRef || '').trim(), { since: Date.now(), why }); }
function releaseCaseFolder(caseRef) { _caseFolderHold.delete(String(caseRef || '').trim()); }
function assertNotHeld(ref) {
  const h = _caseFolderHold.get(ref);
  if (!h) return;
  const e = new Error(`case ${ref}: ${h.why} — try again in a minute`);
  e.transient = true; e.held = true;
  throw e;
}
const CASE_FOLDER_MISS_TTL_MS = 30 * 1000;       // a case with no folder yet re-checks soon after setup

/** The folder a case's documents live in: "<client name> - <case ref>", sanitised. */
function caseFolderName({ clientName, caseRef }) {
  return `${clientName} - ${caseRef}`.replace(/[*:"<>?/\\|]/g, '').trim();
}

/**
 * Every root folder whose name ends " - <caseRef>".
 *
 * Returns an ARRAY because a case can end up split: a write made while the name
 * was broken may have created a second, near-empty folder under the new name
 * beside the one holding the documents. Callers must choose deliberately rather
 * than take whichever Graph happens to list first.
 *
 * Read-only. Pages the root listing.
 */
async function findCaseFoldersByRef(caseRef) {
  const ref = String(caseRef || '').trim();
  if (!ref) return [];
  assertNotHeld(ref);
  const suffix = ` - ${ref}`;
  try {
    return await withGraphAuth('foldersByRef', async (token) => {
      const hits = [];
      let next = `${childrenUrl(ROOT_FOLDER)}?$select=id,name,webUrl,folder&$top=200`;
      let firstPage = true;
      while (next) {
        let res;
        try {
          res = await axios.get(next, { headers: { Authorization: `Bearer ${token}` }, timeout: GRAPH_TIMEOUT_MS });
        } catch (err) {
          // Only the FIRST request can mean "the root does not exist yet". A
          // 404 on a continuation is a stale skiptoken, and answering [] there
          // would report a case as folderless on a partial listing - which
          // reads as "no documents" and mints a duplicate on the next write.
          if (err.response?.status === 404 && firstPage) return [];
          throw err;
        }
        firstPage = false;
        for (const it of (res.data?.value || [])) {
          if (it.folder && String(it.name || '').endsWith(suffix)) {
            hits.push({ id: it.id, name: it.name, webUrl: it.webUrl, childCount: it.folder.childCount });
          }
        }
        next = res.data?.['@odata.nextLink'] || null;
      }
      return hits;
    });
  } catch (err) {
    throw wrapError('OneDrive folder-by-ref lookup failed', err);
  }
}

/**
 * READ-ONLY: one root folder under "Client Documents" by its EXACT name, with
 * every file in it and in each of its sub-folders — who created and last
 * changed each file, and when. For looking into a folder the app does NOT
 * resolve a case to (a client's real folder beside a leftover test folder):
 * the case-based listings only ever show the folder the app picks.
 * Returns null when no folder has that name. Never writes.
 *
 * Folders nested inside a sub-folder are listed as `nested` (not descended into) so nothing is invisible.
 * @returns {Promise<null | { folder: {id,name,webUrl,createdAt}, rootFiles: object[], folders: Array<{ id, name, createdAt, files: object[], nested: Array<{id,name}> }> }>}
 */
async function listRootFolderTree(folderName) {
  const safeName = String(folderName || '').replace(/[*:"<>?/\\|]/g, '').trim();
  if (!safeName) return null;
  const SELECT = '$select=id,name,size,file,folder,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy&$top=200';
  const who = (by) => (by && by.user && (by.user.displayName || by.user.email)) || (by && by.application && by.application.displayName) || '';
  const entry = (it) => ({ id: it.id, name: String(it.name || ''), size: it.size, isFolder: Boolean(it.folder), hash: (it.file && it.file.hashes && it.file.hashes.quickXorHash) || '',
    createdAt: it.createdDateTime || '', modifiedAt: it.lastModifiedDateTime || '', createdBy: who(it.createdBy), modifiedBy: who(it.lastModifiedBy) });
  try {
    return await withGraphAuth('listRootFolderTree', async (token) => {
      const headers = { Authorization: `Bearer ${token}` };
      const page = async (firstUrl) => {
        const out = []; let next = firstUrl;
        while (next) {
          const res = await axios.get(next, { headers, timeout: GRAPH_TIMEOUT_MS });
          for (const it of (res.data?.value || [])) out.push(entry(it));
          next = res.data?.['@odata.nextLink'] || null;
        }
        return out;
      };
      let top;
      try {
        top = await axios.get(`${itemUrl(`${ROOT_FOLDER}/${safeName}`)}?$select=id,name,webUrl,createdDateTime`, { headers, timeout: GRAPH_TIMEOUT_MS });
      } catch (err) {
        if (err.response?.status === 404) return null;
        throw err;
      }
      const folder = { id: top.data.id, name: top.data.name, webUrl: top.data.webUrl, createdAt: top.data.createdDateTime || '' };
      const kids = await page(`${userBase()}/items/${encodeURIComponent(folder.id)}/children?${SELECT}`);
      const folders = [];
      for (const k of kids.filter((x) => x.isFolder)) {
        const inside = await page(`${userBase()}/items/${encodeURIComponent(k.id)}/children?${SELECT}`);
        folders.push({ id: k.id, name: k.name, createdAt: k.createdAt, files: inside.filter((x) => !x.isFolder), nested: inside.filter((x) => x.isFolder).map((x) => ({ id: x.id, name: x.name })) });
      }
      return { folder, rootFiles: kids.filter((x) => !x.isFolder), folders };
    });
  } catch (err) {
    throw wrapError('OneDrive folder tree listing failed', err);
  }
}

/**
 * Move ONE item (by id) into a folder (by id). A same-named file there keeps
 * both (conflictBehavior=rename) — nothing is ever replaced or deleted.
 * Returns the stored name after the move (differs only on a clash) and webUrl.
 */
async function moveItemById({ itemId, toFolderId }) {
  if (!itemId || !toFolderId) throw new Error('moveItemById: itemId and toFolderId required');
  try {
    return await withGraphAuth('moveById', async (token) => {
      const res = await axios.patch(`${userBase()}/items/${encodeURIComponent(itemId)}`,
        { parentReference: { id: toFolderId }, '@microsoft.graph.conflictBehavior': 'rename' },
        { headers: { Authorization: `Bearer ${token}` }, timeout: GRAPH_TIMEOUT_MS });
      return { id: res.data?.id || itemId, name: res.data?.name || '', webUrl: res.data?.webUrl || '' };
    });
  } catch (err) {
    throw wrapError('OneDrive move failed', err);
  }
}

/**
 * COPY one item (a file, or a whole folder with everything in it) into a
 * folder, by id. The original is untouched. Graph copies asynchronously: the
 * call answers 202 with a monitor URL, polled (no auth, as Graph specifies)
 * until it reports completed or failed. A same-named item in the target keeps
 * both (conflictBehavior=rename). Returns the copy's id, stored name, webUrl.
 *
 * Once Graph has ACCEPTED the copy, nothing here starts another: a failure
 * after that point (a poll that keeps failing, the job still running at the
 * cap, the final lookup refused) is thrown with err.copyAccepted = true, so a
 * caller can look whether the copy landed instead of copying again. The final
 * lookup runs in its own auth scope, so a 401 there cannot re-run the request.
 */
async function copyItemById({ itemId, toFolderId, name, maxWaitMs = COPY_MAX_WAIT_MS }) {
  if (!itemId || !toFolderId) throw new Error('copyItemById: itemId and toFolderId required');
  let monitor;
  try {
    monitor = await withGraphAuth('copyById', async (token) => {
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const drive = await axios.get(`${userBase()}?$select=id`, { headers, timeout: GRAPH_TIMEOUT_MS });
      const body = { parentReference: { driveId: drive.data.id, id: toFolderId } };
      if (name) body.name = name;
      const res = await axios.post(`${userBase()}/items/${encodeURIComponent(itemId)}/copy?@microsoft.graph.conflictBehavior=rename`, body,
        { headers, timeout: GRAPH_TIMEOUT_MS, validateStatus: (st) => st === 202 });
      const loc = res.headers && (res.headers.location || res.headers.Location);
      if (!loc) throw new Error('copy accepted but no monitor URL came back');
      return loc;
    });
  } catch (err) {
    throw wrapError('OneDrive copy failed', err);
  }
  // From here on the copy is Graph's job: never start it twice.
  const accepted = (err) => { const e = wrapError('OneDrive copy accepted but not confirmed', err); e.copyAccepted = true; e.monitor = monitor; e.transient = true; return e; };
  let resourceId = null;
  const deadline = Date.now() + maxWaitMs;
  let lastPollErr = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, COPY_POLL_MS));
    let d;
    try {
      const st = await axios.get(monitor, { timeout: GRAPH_TIMEOUT_MS, validateStatus: () => true });
      d = st.data || {};
      lastPollErr = null;
    } catch (err) { lastPollErr = err; continue; }   // one bad poll is not a failed copy: keep asking until the cap
    if (d.status === 'completed') { resourceId = d.resourceId; break; }
    if (d.status === 'failed' || d.status === 'deleteFailed') { const e = new Error(`copy failed: ${(d.error && d.error.message) || JSON.stringify(d).slice(0, 200)}`); e.copyFailed = true; throw wrapError('OneDrive copy failed', e); }
  }
  if (!resourceId) throw accepted(lastPollErr || new Error(`copy still not finished after ${Math.round(maxWaitMs / 1000)}s`));
  try {
    return await withGraphAuth('copyById:lookup', async (token) => {
      const item = await axios.get(`${userBase()}/items/${encodeURIComponent(resourceId)}?$select=id,name,webUrl`, { headers: { Authorization: `Bearer ${token}` }, timeout: GRAPH_TIMEOUT_MS });
      return { id: item.data.id, name: item.data.name || '', webUrl: item.data.webUrl || '' };
    });
  } catch (err) {
    const e = accepted(err); e.resourceId = resourceId; throw e;
  }
}
let COPY_MAX_WAIT_MS = 4 * 60 * 1000;   // one copy job (a folder with files takes seconds; SharePoint can queue it for a while)
let COPY_POLL_MS     = 1000;

/** Rename ONE item (by id). conflictBehavior=fail: a folder already called that stops it. */
async function renameItemById({ itemId, newName }) {
  const safe = String(newName || '').replace(/[*:"<>?/\\|]/g, '').trim();
  if (!itemId || !safe) throw new Error('renameItemById: itemId and newName required');
  if (safe !== String(newName).trim()) { const e = new Error(`renameItemById: "${newName}" contains characters OneDrive does not allow`); e.badRequest = true; throw e; }
  try {
    return await withGraphAuth('renameById', async (token) => {
      const res = await axios.patch(`${userBase()}/items/${encodeURIComponent(itemId)}`,
        { name: safe, '@microsoft.graph.conflictBehavior': 'fail' },
        { headers: { Authorization: `Bearer ${token}` }, timeout: GRAPH_TIMEOUT_MS });
      return { id: res.data?.id || itemId, name: res.data?.name || safe, webUrl: res.data?.webUrl || '' };
    });
  } catch (err) {
    throw wrapError('OneDrive rename failed', err);
  }
}

/** Make sure a sub-folder exists inside a folder (by id); the existing one is returned as-is. */
async function ensureSubfolderById({ parentId, name }) {
  const safe = String(name || '').replace(/[*:"<>?/\\|]/g, '').trim();
  if (!parentId || !safe) throw new Error('ensureSubfolderById: parentId and name required');
  try {
    return await withGraphAuth('ensureSubfolderById', async (token) => {
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      try {
        const res = await axios.post(`${userBase()}/items/${encodeURIComponent(parentId)}/children`,
          { name: safe, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }, { headers, timeout: GRAPH_TIMEOUT_MS });
        return { id: res.data.id, name: res.data.name, created: true };
      } catch (err) {
        if (err.response?.status !== 409) throw err;
        const res = await axios.get(`${userBase()}/items/${encodeURIComponent(parentId)}/children?$select=id,name,folder&$top=200`, { headers, timeout: GRAPH_TIMEOUT_MS });
        const hit = (res.data?.value || []).find((c) => c.folder && String(c.name).toLowerCase() === safe.toLowerCase());
        if (!hit) throw err;
        return { id: hit.id, name: hit.name, created: false };
      }
    });
  } catch (err) {
    throw wrapError('OneDrive sub-folder failed', err);
  }
}

/** A staff-openable (organisation) link to an item, by id. */
async function orgLinkById(itemId) {
  if (!itemId) throw new Error('orgLinkById: itemId required');
  try { return await withGraphAuth('orgLinkById', (token) => createOrgLink(token, itemId)); }
  catch (err) { throw wrapError('OneDrive link failed', err); }
}

/**
 * A small JSON file anywhere in the drive (NOT under "Client Documents"), read
 * with its eTag so a later write can refuse to overwrite a newer one.
 * @returns {Promise<null | { data: object, etag: string }>}  null = no such file
 */
async function readJsonFile(path) {
  try {
    return await withGraphAuth('readJsonFile', async (token) => {
      const headers = { Authorization: `Bearer ${token}` };
      let meta;
      try { meta = await axios.get(`${itemUrl(path)}?$select=id,eTag`, { headers, timeout: GRAPH_TIMEOUT_MS }); }
      catch (err) { if (err.response?.status === 404) return null; throw err; }
      const body = await axios.get(`${userBase()}/items/${encodeURIComponent(meta.data.id)}/content`, { headers, timeout: GRAPH_TIMEOUT_MS, responseType: 'text', transformResponse: [(x) => x] });
      let data = {};
      try { data = JSON.parse(String(body.data || '{}')); }
      catch (_) { const e = new Error(`${path} is not valid JSON`); e.corrupt = true; e.etag = meta.data.eTag || ''; e.raw = String(body.data || ''); throw e; }
      return { data, etag: meta.data.eTag || '' };
    });
  } catch (err) {
    if (err.corrupt) throw err;
    throw wrapError('OneDrive JSON read failed', err);
  }
}

/**
 * Write a small JSON file. With `etag`: only if the file is still that
 * version (If-Match) — a newer one makes it throw with err.conflict. Without:
 * only if there is no file yet (If-None-Match: *) — an existing one is a conflict.
 */
async function writeJsonFile(path, data, { etag = '' } = {}) {
  try {
    return await withGraphAuth('writeJsonFile', async (token) => {
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) };
      try {
        const res = await axios.put(`${itemUrl(path)}/content`, JSON.stringify(data, null, 1), { headers, timeout: GRAPH_UPLOAD_TIMEOUT_MS });
        return { etag: res.data?.eTag || '' };
      } catch (err) {
        const st = err.response?.status;
        if (st === 412 || st === 409) { const e = new Error(`${path} changed meanwhile`); e.conflict = true; throw e; }
        throw err;
      }
    });
  } catch (err) {
    if (err.conflict) throw err;
    throw wrapError('OneDrive JSON write failed', err);
  }
}

/** Forget what the process remembers about a case's folder (after a repair renamed or merged folders). */
function forgetCaseFolder(caseRef) {
  const ref = String(caseRef || '').trim();
  _caseFolderName.delete(ref); _caseFolderInFlight.delete(ref);
  for (const k of [..._caseFolderConfirm.keys()]) if (k.startsWith(ref + '\n')) _caseFolderConfirm.delete(k);
  for (const k of [..._caseFolderFollow.keys()])  if (k.startsWith(ref + '\n')) _caseFolderFollow.delete(k);
}

/**
 * EVERY folder directly under "Client Documents": { id, name, childCount,
 * createdAt }. Read-only; pages the whole root listing. Same care as
 * findCaseFoldersByRef: only the FIRST page may answer "no root yet" — a 404
 * on a continuation is a stale skiptoken and must fail the whole listing,
 * never return a partial one (a partial listing would read as "this case has
 * no folder"). Used by the working-folders backfill to match every case to its
 * folder in ONE enumeration instead of one per case.
 */
async function listCaseFoldersInRoot() {
  try {
    return await withGraphAuth('listCaseFoldersInRoot', async (token) => {
      const out = [];
      let next = `${childrenUrl(ROOT_FOLDER)}?$select=id,name,folder,createdDateTime&$top=200`;
      let firstPage = true;
      while (next) {
        let res;
        try {
          res = await axios.get(next, { headers: { Authorization: `Bearer ${token}` }, timeout: GRAPH_TIMEOUT_MS });
        } catch (err) {
          if (err.response?.status === 404 && firstPage) return [];
          throw err;
        }
        firstPage = false;
        for (const it of (res.data?.value || [])) {
          if (it.folder) out.push({ id: it.id, name: String(it.name || ''), childCount: it.folder.childCount, createdAt: it.createdDateTime || '' });
        }
        next = res.data?.['@odata.nextLink'] || null;
      }
      return out;
    });
  } catch (err) {
    throw wrapError('OneDrive root listing failed', err);
  }
}

/**
 * Choose between folders that all carry the case reference. The one holding the
 * documents wins; a tie keeps the shortest name (the original, before a suffix
 * was appended). Always logged - a split case is a data-hygiene problem someone
 * should fix at the source.
 */
/**
 * The lookup that says which folder a case's Monday row links (set once at
 * startup by server.js — caseFolderLinkService.linkedFolderIds). Unset (tests,
 * scripts) = no lookup: the tie-break below decides, exactly as before.
 */
let _linkedFolderLookup = null;
function setCaseFolderLinkLookup(fn) { _linkedFolderLookup = typeof fn === 'function' ? fn : null; }

/**
 * Choose between folders that all carry the case reference: the one the
 * case's Monday row LINKS wins (a leftover test folder beside the client's
 * real one must never win on item count — 2026-10-01); without a usable link,
 * pickCaseFolder's tie-break. Only consulted when there are two or more.
 */
async function chooseCaseFolderWithReason(hits, caseRef) {
  if (hits.length === 1) return { chosen: hits[0], linked: false };
  if (_linkedFolderLookup) {
    try {
      const ids = await _linkedFolderLookup(caseRef);
      // null = the link could not be read (and was never read before): the
      // tie-break's answer is a guess — kept only briefly, then asked again.
      if (ids === null) return { chosen: pickCaseFolder(hits, caseRef), linked: false, uncertain: true };
      const linked = hits.find((h) => ids.includes(h.id));
      if (linked) {
        console.warn(`[OneDrive] case ${caseRef} has ${hits.length} folders: ${hits.map((h) => `"${h.name}"`).join(', ')} - using "${linked.name}", the one the case's Monday row links. Merge them.`);
        return { chosen: linked, linked: true };
      }
    } catch (_) { return { chosen: pickCaseFolder(hits, caseRef), linked: false, uncertain: true }; }
  }
  return { chosen: pickCaseFolder(hits, caseRef), linked: false };
}
async function chooseCaseFolder(hits, caseRef) { return (await chooseCaseFolderWithReason(hits, caseRef)).chosen; }

function pickCaseFolder(hits, caseRef) {
  if (hits.length === 1) return hits[0];
  const sorted = [...hits].sort((a, b) => (b.childCount || 0) - (a.childCount || 0) || a.name.length - b.name.length);
  console.warn(`[OneDrive] case ${caseRef} has ${hits.length} folders: ${hits.map((h) => `"${h.name}" (${h.childCount ?? '?'} items)`).join(', ')} - using "${sorted[0].name}". Merge them.`);
  return sorted[0];
}

/**
 * The single best folder carrying this case reference, or null.
 *
 * A hit SEEDS the name cache: this is the same root enumeration
 * resolveCaseFolderName performs, so the answer is the same fact - and without
 * seeding it, a caller that proves the folder exists can hand the file to
 * uploadFile, which still holds a negative entry from a lookup seconds earlier
 * and writes to the expected-but-absent name instead, minting the duplicate.
 */
async function findCaseFolderByRef(caseRef) {
  const ref = String(caseRef || '').trim();
  assertNotHeld(ref);
  const hits = await findCaseFoldersByRef(ref);
  if (!hits.length) return null;
  // An identity that was FOLLOWED - traced to the driveItem known to hold this
  // case's documents - outranks the name/childCount tie-break, so a lookup
  // cannot hand the next write to an impostor minted beside it. An entry the
  // tie-break itself seeded carries no such authority and must stay
  // correctable, or the FIRST folder to be cached would pin the case forever.
  const live   = liveCaseFolderEntry(ref);
  const known  = (live && live.followed && live.id) ? hits.find((h) => h.id === live.id) : null;
  const choice = known ? { chosen: known, linked: false } : await chooseCaseFolderWithReason(hits, ref);
  const chosen = choice.chosen;
  // Re-affirming keeps the original `at`: renewing it on every lookup would
  // stop even a wrong entry from ever ageing out. A folder chosen because the
  // case's Monday row LINKS it carries the same authority as a followed one —
  // a later lookup whose Monday read fails must not swap it for the tie-break.
  _caseFolderName.set(ref, known
    ? { name: chosen.name, id: chosen.id || '', at: live.at, followed: true }
    : (choice.linked ? { name: chosen.name, id: chosen.id || '', at: Date.now(), followed: true }
                     : { name: chosen.name, id: chosen.id || '', at: Date.now(), ...(choice.uncertain ? { brief: true } : {}) }));
  return chosen;
}

/**
 * The folder name to use for a case. The REFERENCE decides; the expected name
 * is only the fallback for a case whose folder does not exist yet (so creation
 * still works). Cached both ways - a hit for CASE_FOLDER_TTL_MS, a miss for
 * CASE_FOLDER_MISS_TTL_MS so setup's own folder is noticed quickly - and
 * concurrent callers share a single lookup.
 */
function liveCaseFolderEntry(ref) {
  const hit = _caseFolderName.get(ref);
  if (!hit) return null;
  const ttl = (hit.name && !hit.brief) ? CASE_FOLDER_TTL_MS : CASE_FOLDER_MISS_TTL_MS;   // a guess made while the Monday link could not be read: asked again soon
  return (Date.now() - hit.at) < ttl ? hit : null;
}

async function resolveCaseFolderName({ clientName, caseRef }) {
  const ref = String(caseRef || '').trim();
  assertNotHeld(ref);
  const expected = caseFolderName({ clientName, caseRef });
  const hit = liveCaseFolderEntry(ref);
  if (hit) return hit.name || expected;
  const inFlight = _caseFolderInFlight.get(ref);
  if (inFlight) return (await inFlight) || expected;

  const lookup = (async () => {
    const hits = await findCaseFoldersByRef(ref);
    if (!hits.length) { _caseFolderName.set(ref, { name: null, id: '', at: Date.now() }); return null; }
    const { chosen, linked, uncertain } = await chooseCaseFolderWithReason(hits, ref);
    if (chosen.name !== expected) {
      console.warn(`[OneDrive] case ${ref}: documents live in "${chosen.name}" but the client name now yields "${expected}" - using the folder that carries the case reference`);
    }
    // The ID is what identifies the folder later; the name is only how it is addressed today.
    _caseFolderName.set(ref, linked ? { name: chosen.name, id: chosen.id || '', at: Date.now(), followed: true }
                                    : { name: chosen.name, id: chosen.id || '', at: Date.now(), ...(uncertain ? { brief: true } : {}) });
    return chosen.name;
  })();
  _caseFolderInFlight.set(ref, lookup);
  try { return (await lookup) || expected; }
  finally { _caseFolderInFlight.delete(ref); }
}

/**
 * Run a case-folder operation against the RESOLVED folder.
 *
 * The name is resolved up front rather than tried optimistically: a split case
 * has a folder under the expected name too, so a name-first attempt would
 * succeed against the wrong one and never look.
 *
 * A 404 afterwards is ambiguous - the FILE is missing, or the FOLDER was
 * renamed under a cached name - and getting that wrong is expensive in both
 * directions: answering "absent" when the folder moved is the blank-
 * questionnaire class, and re-enumerating the root to be sure taxes every one
 * of the many absent-file probes a questionnaire load makes. So it is settled
 * with evidence, once, cheaply: one path lookup of the cached name, comparing
 * the driveItem ID.
 */
async function withCaseFolder({ clientName, caseRef }, run) {
  const ref = String(caseRef || '').trim();
  assertNotHeld(ref);
  // Read the cache BEFORE resolving: whether the name was already known is a
  // fact, not something to infer afterwards from how long the call took. (It
  // used to be "the entry is at least 1ms old", which a real Graph round-trip
  // always is - so every genuinely absent file re-enumerated the root.)
  const before = liveCaseFolderEntry(ref);
  const name = await resolveCaseFolderName({ clientName, caseRef });
  try {
    return await run(name);
  } catch (err) {
    if (err?.response?.status !== 404) throw err;
    // Resolved in THIS call, or resolved to nothing: the name is as good as it
    // gets and the FILE is simply not there.
    if (!before || !before.name || before.name !== name) throw err;

    // Healing keeps the identity this branch just established. Re-picking a
    // name by case reference alone would hand a split case back to
    // pickCaseFolder, and an impostor minted under the OLD name wears the
    // shorter name - so it wins the tie-break and the documents in the renamed
    // folder become invisible, permanently, because the impostor's id is then
    // what gets cached. The folder we know holds the documents wins.
    const heal = async (why) => {
      dropCaseFolderName(ref, name);           // ...only if nobody else healed it first
      console.warn(`[OneDrive] case ${ref}: ${why} - re-resolving by case reference`);
      const mine = await followKnownFolder(ref, before.id);
      if (mine) {
        if (mine === name) throw err;
        return run(mine);
      }
      // The folder we knew is genuinely gone from the root - fall back to the
      // split-case policy, which is all the evidence left.
      const real = await resolveCaseFolderName({ clientName, caseRef });
      if (real === name) throw err;
      return run(real);
    };

    let stillThere;
    try {
      stillThere = await confirmCaseFolder(ref, name);
    } catch (probeErr) {
      // Cannot tell whether the folder moved. Never answer "the file is absent"
      // on a guess - re-resolve instead, which heals if Graph is healthy and
      // surfaces a real error if it is not.
      return heal(`could not confirm folder "${name}" (${probeErr.message})`);
    }
    // Same folder, same name: the FILE is missing. This is the common case and
    // it costs exactly one extra lookup, shared across a concurrent burst.
    if (stillThere && (!before.id || stillThere.id === before.id)) throw err;

    return heal(stillThere
      ? `folder "${name}" is now a DIFFERENT item (${stillThere.id}) than the one holding the documents (${before.id})`
      : `folder "${name}" no longer exists`);
  }
}

/** Forget a cached name, but only while it is still the one being healed away from. */
function dropCaseFolderName(ref, name) {
  const cur = _caseFolderName.get(ref);
  if (cur && cur.name === name) _caseFolderName.delete(ref);
}

/**
 * Is the case folder still the item we cached, under the name we cached?
 * One path-addressed lookup, shared by every caller asking about the same
 * (reference, name) at the same time - a questionnaire load fires a dozen
 * absent-file probes in parallel and they must not become a dozen lookups.
 */
function confirmCaseFolder(ref, name) {
  const key = `${ref}\n${name}`;
  let pending = _caseFolderConfirm.get(key);
  if (!pending) {
    pending = getClientFolderByName(name).finally(() => _caseFolderConfirm.delete(key));
    _caseFolderConfirm.set(key, pending);
  }
  return pending;
}

/**
 * Follow the folder we KNOW holds this case's documents to whatever it is
 * called now. Returns its name, or '' when that driveItem is gone from the
 * root. Identity beats the name: an impostor minted under the old name wears
 * the SHORTER name, so it would win the split-case tie-break and the real
 * documents would go quiet.
 */
function followKnownFolder(ref, knownId) {
  if (!knownId) return Promise.resolve('');
  // Deduped like every other root-paging lookup here: a burst of reads or
  // uploads all healing the SAME rename must page the root once, not N times.
  const key = `${ref}\n${knownId}`;
  let pending = _caseFolderFollow.get(key);
  if (!pending) {
    pending = (async () => {
      const mine = (await findCaseFoldersByRef(ref)).find((h) => h.id === knownId);
      if (!mine) return '';
      // followed: this identity was traced to the driveItem KNOWN to hold the
      // case's documents. That is what gives it authority over the tie-break.
      _caseFolderName.set(ref, { name: mine.name, id: mine.id, at: Date.now(), followed: true });
      console.log(`[OneDrive] case ${ref}: followed the folder holding the documents to "${mine.name}"`);
      return mine.name;
    })().finally(() => _caseFolderFollow.delete(key));
    _caseFolderFollow.set(key, pending);
  }
  return pending;
}

/**
 * The folder name to WRITE into.
 *
 * A read can afford to be optimistic and heal on the 404. A write cannot: a PUT
 * to a path whose parent is missing CREATES that parent, so a stale cached name
 * does not fail loudly - it quietly mints a second folder for the case, which
 * is the split this whole area exists to prevent. So when the name came from
 * the cache rather than from this call, it costs one confirmation first.
 */
async function resolveCaseFolderNameForWrite({ clientName, caseRef }) {
  const ref = String(caseRef || '').trim();
  assertNotHeld(ref);
  const before = liveCaseFolderEntry(ref);
  const name = await resolveCaseFolderName({ clientName, caseRef });
  // Resolved in THIS call, or resolved to nothing (no folder yet - this write
  // creates it): as fresh as it can be.
  if (!before || !before.name || before.name !== name) return name;

  let stillThere;
  try {
    stillThere = await confirmCaseFolder(ref, name);
  } catch (probeErr) {
    console.warn(`[OneDrive] case ${ref}: could not confirm folder "${name}" before writing (${probeErr.message}) - re-resolving`);
    dropCaseFolderName(ref, name);
    // Identity first, exactly as the mismatch branch below and the read heal do.
    // A probe that could not answer is no reason to hand a split case back to
    // pickCaseFolder, which a non-empty impostor under the OLD name wins.
    return (await followKnownFolder(ref, before.id)) || resolveCaseFolderName({ clientName, caseRef });
  }
  if (stillThere && (!before.id || stillThere.id === before.id)) return name;

  dropCaseFolderName(ref, name);
  console.warn(`[OneDrive] case ${ref}: cached folder "${name}" is no longer the item holding the documents - re-resolving before writing`);
  return (await followKnownFolder(ref, before.id)) || resolveCaseFolderName({ clientName, caseRef });
}

/** Test seam: forget the resolved folder names. */
function _clearCaseFolderCache() { _caseFolderName.clear(); _caseFolderInFlight.clear(); _caseFolderConfirm.clear(); _caseFolderFollow.clear(); }


/**
 * Ensure the client root folder exists in OneDrive.
 * Safe to call before any uploads — will not duplicate folders.
 *
 * @param {{ clientName: string, caseRef: string }} params
 */
async function ensureClientFolder({ clientName, caseRef }) {
  const safeName = await resolveCaseFolderNameForWrite({ clientName, caseRef });   // never duplicate a renamed folder

  await withGraphAuth('ensureClientFolder', async (token) => {
    await ensureFolder(token, null, ROOT_FOLDER);
    const folder = await ensureFolder(token, ROOT_FOLDER, safeName);
    await addWorkFoldersIfNew(folder, caseRef);
  });
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
  const safeName   = await resolveCaseFolderNameForWrite({ clientName, caseRef });   // never duplicate a renamed folder
  const clientPath = `${ROOT_FOLDER}/${safeName}`;

  return withGraphAuth('ensureCategoryFolderLink', async (token) => {
    await ensureFolder(token, null, ROOT_FOLDER);
    const folder = await ensureFolder(token, ROOT_FOLDER, safeName);
    await addWorkFoldersIfNew(folder, caseRef);
    const { id } = await ensureFolder(token, clientPath, category);
    return createOrgLink(token, id);
  });
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
  const safeName = `${fullName} - LEAD-${leadId}`.replace(/[*:"<>?/\\|]/g, '').trim();

  return withGraphAuth('ensureLeadFolder', async (token) => {
    await ensureFolder(token, null, ROOT_FOLDER);
    const { id, webUrl } = await ensureFolder(token, ROOT_FOLDER, safeName);
    console.log(`[OneDrive] Lead folder ready: ${ROOT_FOLDER}/${safeName}`);

    let url = webUrl;
    try {
      url = await createOrgLink(token, id);
    } catch (err) {
      if (err.response?.status === 401) throw err; // let withGraphAuth retry
      console.warn(`[OneDrive] Sharing link failed for lead folder (using webUrl): ${err.message}`);
    }
    return { id, url };
  });
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
  const safeName = String(newName).replace(/[*:"<>?/\\|]/g, '').trim();
  return withGraphAuth('rename', async (token) => {
    const res = await axios.patch(
      `${userBase()}/items/${itemId}`,
      { name: safeName },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: GRAPH_TIMEOUT_MS }
    );
    console.log(`[OneDrive] Renamed item ${itemId} → "${safeName}"`);
    return { id: res.data.id, name: res.data.name, webUrl: res.data.webUrl };
  });
}

/**
 * Look up a folder directly under the client-documents root by its display
 * name. 404 → null (never throws for a missing folder).
 *
 * @param {string} folderName  e.g. "Jane Doe - 2026-VV-009" (will be sanitized)
 * @returns {Promise<{ id: string, name: string, webUrl: string }|null>}
 */
async function getClientFolderByName(folderName) {
  const safeName = String(folderName).replace(/[*:"<>?/\\|]/g, '').trim();
  if (!safeName) return null;
  try {
    return await withGraphAuth('folderLookup', async (token) => {
      try {
        const res = await axios.get(itemUrl(`${ROOT_FOLDER}/${safeName}`), {
          headers: { Authorization: `Bearer ${token}` },
          timeout: GRAPH_TIMEOUT_MS,
        });
        return { id: res.data.id, name: res.data.name, webUrl: res.data.webUrl };
      } catch (err) {
        if (err.response?.status === 404) return null;
        throw err;
      }
    });
  } catch (err) {
    throw wrapError('OneDrive folder lookup failed', err);
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
  try {
    return await withGraphAuth('itemLookup', async (token) => {
      try {
        const res = await axios.get(`${userBase()}/items/${itemId}?$select=id,name,webUrl,parentReference`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: GRAPH_TIMEOUT_MS,
        });
        return {
          id: res.data.id,
          name: res.data.name,
          webUrl: res.data.webUrl,
          parentPath: (res.data.parentReference && res.data.parentReference.path) || '',
        };
      } catch (err) {
        if (err.response?.status === 404) return null;
        throw err;
      }
    });
  } catch (err) {
    throw wrapError('OneDrive item lookup failed', err);
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
async function deleteDriveItem(itemId) {
  try {
    return await withGraphAuth('delete', async (token) => {
      try {
        await axios.delete(`${userBase()}/items/${itemId}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: GRAPH_TIMEOUT_MS,
        });
        console.log(`[OneDrive] Deleted item ${itemId} (moved to recycle bin)`);
        return true;
      } catch (err) {
        if (err.response?.status === 404) return false;
        throw err;
      }
    });
  } catch (err) {
    throw wrapError('OneDrive delete failed', err);
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
  const safeName = await resolveCaseFolderNameForWrite({ clientName, caseRef });   // renamed folders still resolve
  const safeFile = filename.replace(/[*:"<>?\\|]/g, '').trim() || 'document';
  const filePath = `${ROOT_FOLDER}/${safeName}/${category}/${safeFile}`;
  const encoded  = filePath.split('/').map(encodeURIComponent).join('/');

  return withGraphAuth('uploadAndLink', async (token) => {
    const res = await axios.put(`${userBase()}/root:/${encoded}:/content`, buffer, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || 'application/octet-stream' },
      maxContentLength: Infinity, maxBodyLength: Infinity, timeout: GRAPH_UPLOAD_TIMEOUT_MS,
    });
    let url = res.data.webUrl;
    try {
      url = await createOrgLink(token, res.data.id);
    } catch (err) {
      if (err.response?.status === 401) throw err; // let withGraphAuth retry
      console.warn(`[OneDrive] Org link failed for ${safeFile} (using webUrl): ${err.message}`);
    }
    console.log(`[OneDrive] Uploaded + linked → ${filePath}`);
    return { url, webUrl: res.data.webUrl, id: res.data.id };
  });
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
  // Prefer the stored folder id — a driveItem keeps its id when the intake folder
  // is renamed to "{name} - {caseRef}" at handoff, so a post-handoff upload still
  // lands in the right place. Resolve by name only when no id was passed.
  let id = String(folderId || '').trim();
  if (!id) { id = (await ensureLeadFolder({ fullName, leadId })).id; }
  const safeFile = String(filename).replace(/[*:"<>?/\\|]/g, '').trim() || 'file';

  return withGraphAuth('uploadToLeadFolder', async (token) => {
    const res = await axios.put(
      `${userBase()}/items/${id}:/${encodeURIComponent(safeFile)}:/content`,
      buffer,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || 'application/octet-stream' },
        maxContentLength: Infinity, maxBodyLength: Infinity, timeout: GRAPH_UPLOAD_TIMEOUT_MS }
    );
    let url = res.data.webUrl;
    try { url = await createOrgLink(token, res.data.id); }
    catch (err) {
      if (err.response?.status === 401) throw err; // let withGraphAuth retry
      console.warn(`[OneDrive] Org link failed for ${safeFile} (using webUrl): ${err.message}`);
    }
    console.log(`[OneDrive] Uploaded to lead folder → ${safeFile}`);
    return { url, webUrl: res.data.webUrl, id: res.data.id };
  });
}


/**
 * List a stored file's version history (OneDrive/SharePoint keeps versions
 * automatically). Newest first. Returns [] when the file or history is absent.
 *
 * Added 2026-08-19 after an operator action overwrote a client's saved
 * questionnaire: without a recovery path, one bad write is permanent.
 */
async function listFileVersions({ clientName, caseRef, subfolder, filename }) {
  const safeFile = filename.replace(/[*:"<>?\\|]/g, '').trim();
  try {
    // Through withCaseFolder like every other read: swallowing the 404 in here
    // would hide a renamed folder from the heal and report a file that exists
    // as having no history at all.
    return await withCaseFolder({ clientName, caseRef }, async (safeName) => {
      const filePath = `${ROOT_FOLDER}/${safeName}/${subfolder}/${safeFile}`;
      const encoded  = filePath.split('/').map(encodeURIComponent).join('/');
      return withGraphAuth('versionList', async (token) => {
        const res = await axios.get(`${userBase()}/root:/${encoded}:/versions`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: GRAPH_TIMEOUT_MS,
        });
        return (res.data && res.data.value) || [];
      });
    });
  } catch (err) {
    if (err?.response?.status === 404) return [];   // absent — not an error
    throw wrapError('OneDrive version list failed', err);
  }
}

/** Fetch the CONTENT of one historical version (Buffer), or null if absent. */
async function readFileVersion({ clientName, caseRef, subfolder, filename, versionId }) {
  const safeFile = filename.replace(/[*:"<>?\\|]/g, '').trim();
  try {
    return await withCaseFolder({ clientName, caseRef }, async (safeName) => {
      const filePath = `${ROOT_FOLDER}/${safeName}/${subfolder}/${safeFile}`;
      const encoded  = filePath.split('/').map(encodeURIComponent).join('/');
      return withGraphAuth('versionRead', async (token) => {
        const res = await axios.get(
          `${userBase()}/root:/${encoded}:/versions/${encodeURIComponent(versionId)}/content`,
          { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer', timeout: GRAPH_TIMEOUT_MS });
        return Buffer.from(res.data);
      });
    });
  } catch (err) {
    if (err?.response?.status === 404) return null;   // absent — not an error
    throw wrapError('OneDrive version read failed', err);
  }
}

module.exports = {
  createClientFolders, uploadFile, readFile, listFiles, listChildren, moveFile, caseFolderName, findCaseFolderByRef, findCaseFoldersByRef, resolveCaseFolderName, _clearCaseFolderCache, ensureClientFolder, ensureCategoryFolderLink,
  ensureLeadFolder, renameDriveItem, uploadFileAndLink, uploadToLeadFolderAndLink,
  getClientFolderByName, getDriveItemById, deleteDriveItem,
  listFileVersions, readFileVersion,
  uploadFileAsNew,
  ensureCaseWorkFolders, workFoldersFailedNoteText, CASE_WORK_FOLDERS, WORK_FOLDERS_SINCE,
  listCaseFoldersInRoot, pickCaseFolder, chooseCaseFolder, setCaseFolderLinkLookup, listRootFolderTree, readJsonFile, writeJsonFile, moveItemById, copyItemById, renameItemById, ensureSubfolderById, forgetCaseFolder, orgLinkById, holdCaseFolder, releaseCaseFolder,
  _resetWorkFoldersMemo: () => _workFoldersComplete.clear(),
  _workFoldersMemoHas:   (id) => _workFoldersComplete.has(String(id)),
  _seedCaseFolderCacheForTests: (ref, entry) => _caseFolderName.set(String(ref), entry),
  _copyPollForTests: (ms, maxWaitMs) => { COPY_POLL_MS = ms; COPY_MAX_WAIT_MS = maxWaitMs; },
  _caseFolderCacheHasForTests:  (ref) => _caseFolderName.has(String(ref)),
};
