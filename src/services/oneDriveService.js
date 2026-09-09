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

  // Resolve first: re-seeding a case whose folder was renamed must reuse that
  // folder, never mint a second one beside it.
  const safeName   = await resolveCaseFolderNameForWrite({ clientName, caseRef });
  const clientPath = `${ROOT_FOLDER}/${safeName}`;

  return withGraphAuth('createClientFolders', async (token) => {
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
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' });
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
          const res = await axios.get(next, { headers: { Authorization: `Bearer ${token}` } });
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
      const res = await axios.patch(srcUrl, { parentReference: { id: target.id }, '@microsoft.graph.conflictBehavior': 'rename' }, { headers });
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
  const suffix = ` - ${ref}`;
  try {
    return await withGraphAuth('foldersByRef', async (token) => {
      const hits = [];
      let next = `${childrenUrl(ROOT_FOLDER)}?$select=id,name,webUrl,folder&$top=200`;
      let firstPage = true;
      while (next) {
        let res;
        try {
          res = await axios.get(next, { headers: { Authorization: `Bearer ${token}` } });
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
 * Choose between folders that all carry the case reference. The one holding the
 * documents wins; a tie keeps the shortest name (the original, before a suffix
 * was appended). Always logged - a split case is a data-hygiene problem someone
 * should fix at the source.
 */
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
  const hits = await findCaseFoldersByRef(ref);
  if (!hits.length) return null;
  // An identity that was FOLLOWED - traced to the driveItem known to hold this
  // case's documents - outranks the name/childCount tie-break, so a lookup
  // cannot hand the next write to an impostor minted beside it. An entry the
  // tie-break itself seeded carries no such authority and must stay
  // correctable, or the FIRST folder to be cached would pin the case forever.
  const live   = liveCaseFolderEntry(ref);
  const known  = (live && live.followed && live.id) ? hits.find((h) => h.id === live.id) : null;
  const chosen = known || pickCaseFolder(hits, ref);
  // Re-affirming keeps the original `at`: renewing it on every lookup would
  // stop even a wrong entry from ever ageing out.
  _caseFolderName.set(ref, known
    ? { name: chosen.name, id: chosen.id || '', at: live.at, followed: true }
    : { name: chosen.name, id: chosen.id || '', at: Date.now() });
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
  const ttl = hit.name ? CASE_FOLDER_TTL_MS : CASE_FOLDER_MISS_TTL_MS;
  return (Date.now() - hit.at) < ttl ? hit : null;
}

async function resolveCaseFolderName({ clientName, caseRef }) {
  const ref = String(caseRef || '').trim();
  const expected = caseFolderName({ clientName, caseRef });
  const hit = liveCaseFolderEntry(ref);
  if (hit) return hit.name || expected;
  const inFlight = _caseFolderInFlight.get(ref);
  if (inFlight) return (await inFlight) || expected;

  const lookup = (async () => {
    const hits = await findCaseFoldersByRef(ref);
    if (!hits.length) { _caseFolderName.set(ref, { name: null, id: '', at: Date.now() }); return null; }
    const chosen = pickCaseFolder(hits, ref);
    if (chosen.name !== expected) {
      console.warn(`[OneDrive] case ${ref}: documents live in "${chosen.name}" but the client name now yields "${expected}" - using the folder that carries the case reference`);
    }
    // The ID is what identifies the folder later; the name is only how it is addressed today.
    _caseFolderName.set(ref, { name: chosen.name, id: chosen.id || '', at: Date.now() });
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
    await ensureFolder(token, ROOT_FOLDER, safeName);
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
    await ensureFolder(token, ROOT_FOLDER, safeName);
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
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
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
      maxContentLength: Infinity, maxBodyLength: Infinity,
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
        maxContentLength: Infinity, maxBodyLength: Infinity }
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
          { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' });
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
};
