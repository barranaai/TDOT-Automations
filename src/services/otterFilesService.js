'use strict';

/**
 * Otter notes in OneDrive — READ-ONLY look (Faran 2026-10-28). The firm's Otter
 * account (both consultants share it) has OneDrive connected as
 * noreply@tdotimm.com: "after a meeting, create a new file with your notes in
 * Microsoft OneDrive". Before the app picks those files up, this shows WHERE
 * Otter puts them and WHAT they look like — names, folders, types, sizes, dates.
 * It never opens a file, never writes, never returns a link.
 *
 * Drive: OTTER_DRIVE_USER, else MS_FROM_EMAIL, else noreply@tdotimm.com.
 * Admin: GET /admin/otter/files
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_FOLDERS = 6;

const driveUser = () => String(process.env.OTTER_DRIVE_USER || process.env.MS_FROM_EMAIL || 'noreply@tdotimm.com').trim();

/** The side effects behind one seam (tests replace get). */
const io = {
  /** One Graph GET; a 401 gets one retry with a fresh token. */
  async get(url) {
    const axios = require('axios');
    const mail = require('./microsoftMailService');
    const once = async () => (await axios.get(url, { headers: { Authorization: `Bearer ${await mail.getAccessToken()}` }, timeout: 30000 })).data;
    try { return await once(); } catch (err) {
      if (err.response && err.response.status === 401) { try { mail.invalidateAccessToken(); } catch (_) { /* best-effort */ } return once(); }
      throw err;
    }
  },
};

const ext = (name) => { const m = /\.([a-z0-9]{1,6})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
const brief = (f) => ({
  name: f.name,
  kind: f.folder ? 'folder' : (ext(f.name) || 'file'),
  ...(f.folder ? { items: f.folder.childCount } : { sizeKb: Math.round((f.size || 0) / 1024) }),
  created: f.createdDateTime || '',
  modified: f.lastModifiedDateTime || '',
  folder: String((f.parentReference && f.parentReference.path) || '').replace(/^\/drive\/root:?/, '') || '/',
});
const why = (err) => {
  const st = err && err.response && err.response.status;
  const msg = (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message) || (err && err.message) || 'unknown';
  return st ? `${st}: ${msg}` : msg;
};

/** Where Otter's notes are and what they look like. Never throws. */
async function look() {
  const user = driveUser();
  const base = `${GRAPH}/users/${encodeURIComponent(user)}/drive`;
  const out = { ok: true, drive: user, top: [], otterFolders: [], search: [], newestFiles: [], problems: [] };
  try {
    const d = await io.get(`${base}/root/children?$top=200&$select=name,folder,size,createdDateTime,lastModifiedDateTime,parentReference`);
    out.top = (d.value || []).map(brief);
  } catch (err) {
    out.ok = false; out.problems.push(`the OneDrive of ${user} could not be read (${why(err)})`);
    return out;
  }
  // Folders that look like Otter's, then one level inside them.
  const folders = out.top.filter((f) => f.kind === 'folder' && /otter|meeting|notes|transcript|^apps$/i.test(f.name)).slice(0, MAX_FOLDERS);
  for (const f of folders) {
    try {
      const path = `/${f.name}`;
      const d = await io.get(`${base}/root:${encodeURI(path)}:/children?$top=50&$orderby=lastModifiedDateTime desc&$select=name,folder,size,createdDateTime,lastModifiedDateTime,parentReference`);
      const items = (d.value || []).map(brief);
      const sub = [];
      for (const s of items.filter((x) => x.kind === 'folder').slice(0, 8)) {
        try {
          const dd = await io.get(`${base}/root:${encodeURI(`${path}/${s.name}`)}:/children?$top=20&$orderby=lastModifiedDateTime desc&$select=name,folder,size,createdDateTime,lastModifiedDateTime,parentReference`);
          sub.push({ folder: `${path}/${s.name}`, items: (dd.value || []).map(brief) });
        } catch (err) { out.problems.push(`${path}/${s.name}: ${why(err)}`); }
      }
      out.otterFolders.push({ folder: path, items, inside: sub });
    } catch (err) { out.problems.push(`${f.name}: ${why(err)}`); }
  }
  // Anything named like Otter anywhere in the drive.
  try {
    const d = await io.get(`${base}/root/search(q='otter')?$top=25&$select=name,folder,size,createdDateTime,lastModifiedDateTime,parentReference`);
    out.search = (d.value || []).map(brief);
  } catch (err) { out.problems.push(`search: ${why(err)}`); }
  // The newest files anywhere we looked — what a fresh Otter note would be.
  const all = [...out.top, ...out.otterFolders.flatMap((f) => [...f.items, ...f.inside.flatMap((x) => x.items)]), ...out.search].filter((f) => f.kind !== 'folder');
  const seen = new Set();
  out.newestFiles = all.filter((f) => { const k = `${f.folder}/${f.name}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(b.created).localeCompare(String(a.created))).slice(0, 15);
  return out;
}

/**
 * The deep look: every file in the drive created in the last `days` days, wherever
 * it sits (Graph delta, read-only, capped). For finding where a new Otter note landed.
 */
async function recent({ days = 2, now = Date.now() } = {}) {
  const user = driveUser();
  const since = new Date(now - days * 24 * 3600 * 1000).toISOString();
  const out = { ok: true, drive: user, since, scanned: 0, files: [], problems: [], complete: false };
  let url = `${GRAPH}/users/${encodeURIComponent(user)}/drive/root/delta?$top=500&$select=name,folder,file,size,createdDateTime,lastModifiedDateTime,parentReference,deleted`;
  try {
    for (let page = 0; page < 60 && url; page++) {
      const d = await io.get(url);
      for (const f of d.value || []) {
        out.scanned++;
        if (f.folder || f.deleted || !f.name) continue;
        if (String(f.createdDateTime || '') >= since || String(f.lastModifiedDateTime || '') >= since) out.files.push(brief(f));
      }
      url = d['@odata.nextLink'] || '';
      if (!url) out.complete = true;
    }
  } catch (err) { out.ok = false; out.problems.push(`the drive could not be scanned (${why(err)})`); }
  out.files.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  out.files = out.files.slice(0, 50);
  return out;
}

module.exports = { look, recent, driveUser, io };
