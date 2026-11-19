'use strict';

/**
 * The case page's Emails tab (Stage 2a, Faran 2026-11-19): an email's plain text → display segments. PURE.
 *
 *   textSegments(text) → [{ t: 'plain text' } | { u: 'https://…' }]
 *
 * The page builds every node with textContent; only { u } becomes a link (target=_blank, rel=noopener noreferrer),
 * and only http, https and mailto ever do. No HTML, no images.
 *
 * Link secrets are hidden on the SERVER (critique #10) — staff clicking a client's own link would act as the client:
 *  - Microsoft Safe Links (…safelinks.protection.outlook.com/?url=…) are unwrapped first, so the rules below see
 *    the real address.
 *  - ANY address: query values whose name looks like a secret (t, token, key, code, access, sig, signature, auth…)
 *    become "…hidden"; so does a #fragment that carries such a name.
 *  - OUR OWN hosts (BASE_URL, RENDER_URL, app.tdotimm.com, tdot-automations.onrender.com) and DOCUMENSO
 *    (DOCUMENSO_BASE_URL's host, documenso.com and its sub-domains): shown as TEXT, never clickable, with every path
 *    segment, query value and fragment longer than 20 characters hidden — the portal code sits in ?t=, the signing
 *    secret in Documenso's /sign/<secret> path. App copies therefore never carry a live link on the page.
 *  - mailto: keeps the address only (no ?subject / ?body).
 */

const HIDDEN = '…hidden';
const LONG = 20;
const MAX_TEXT = 200000;   // characters of one email shown; the rest is cut with a note
const MAX_LINKS = 2000;

const SECRET_NAMES = new Set([
  't', 'k', 'token', 'key', 'code', 'access', 'sig', 'signature', 'auth', 'pwd', 'pass', 'password', 'secret', 'otp',
  'session', 'sid', 'jwt', 'ticket', 'nonce', 'hash', 'apikey', 'api_key', 'tempauth', 'se', 'sv', 'sp', 'sr', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv',
]);
const SECRET_PART = /token|secret|signature|passw|apikey|api_key|auth|session|credential|access|code|key|sig|otp|ticket/i;
const isSecretName = (name) => { const n = String(name || '').toLowerCase(); return SECRET_NAMES.has(n) || SECRET_PART.test(n); };

const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch (_) { return ''; } };

/** Our own hosts: an app link there can carry a client's portal code. Read at call time. */
function ownHosts() {
  const list = [hostOf(process.env.BASE_URL), hostOf(process.env.RENDER_URL), 'app.tdotimm.com', 'tdot-automations.onrender.com'];
  return [...new Set(list.filter(Boolean))];
}
/** Documenso's hosts: the signing secret sits in the path. */
function documensoHosts() {
  return [...new Set([hostOf(process.env.DOCUMENSO_BASE_URL), 'documenso.com'].filter(Boolean))];
}
const onHost = (host, list, withSubdomains) => list.some((h) => host === h || (withSubdomains && host.endsWith('.' + h)));

/** Safe Links → the address inside (up to 3 layers). Anything unreadable stays as it was. */
function unwrapSafeLinks(raw) {
  let url = String(raw || '');
  for (let i = 0; i < 3; i++) {
    let u;
    try { u = new URL(url); } catch (_) { return url; }
    if (!/(^|\.)safelinks\.protection\.outlook\.com$/i.test(u.hostname)) return url;
    const inner = u.searchParams.get('url');
    if (!inner || !/^(https?:\/\/|mailto:)/i.test(inner)) return url;
    url = inner;
  }
  return url;
}

/** "a=1&t=secret" → "a=1&t=…hidden" (names kept as written; long values hidden too when `long`). */
function hideParams(qs, long) {
  if (!qs) return '';
  return qs.split('&').map((pair) => {
    if (!pair) return pair;
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    let decoded = name;
    try { decoded = decodeURIComponent(name.replace(/\+/g, ' ')); } catch (_) { /* as written */ }
    if (eq === -1) return long && name.length > LONG ? HIDDEN : name;
    if (isSecretName(decoded) || (long && value.length > LONG)) return `${name}=${HIDDEN}`;
    return pair;
  }).join('&');
}

/**
 * One address as shown: { u } (a clickable link, its secrets hidden) or { t } (text only — our own or Documenso's
 * host, or anything that does not parse).
 */
function shownLink(raw) {
  const unwrapped = unwrapSafeLinks(raw);
  if (/^mailto:/i.test(unwrapped)) {
    const addr = unwrapped.slice(7).split('?')[0];
    let plain = addr;
    try { plain = decodeURIComponent(addr); } catch (_) { /* as written */ }
    return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(plain) ? { u: 'mailto:' + plain } : { t: unwrapped };
  }
  let u;
  try { u = new URL(unwrapped); } catch (_) { return { t: unwrapped }; }
  if (!/^https?:$/.test(u.protocol)) return { t: unwrapped };
  const host = u.hostname.toLowerCase();
  const inert = onHost(host, ownHosts(), false) || onHost(host, documensoHosts(), true);
  // the parts as written (URL() would percent-encode "…")
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(unwrapped);
  if (!m) return { t: unwrapped };
  const origin = m[1];
  let path = m[2] || '';
  const query = m[3] ? m[3].slice(1) : '';
  let frag = m[4] ? m[4].slice(1) : '';
  if (inert) path = path.split('/').map((seg) => (seg.length > LONG ? HIDDEN : seg)).join('/');
  const q = hideParams(query, inert);
  if (frag) {
    if (inert && frag.length > LONG) frag = HIDDEN;
    else if (frag.includes('=')) frag = hideParams(frag, inert);
  }
  const shown = origin + path + (m[3] ? '?' + q : '') + (m[4] ? '#' + frag : '');
  return inert ? { t: shown } : { u: shown };
}

/** Trailing punctuation is not part of an address ("see https://x.com/a." / "(https://x.com/a)"). */
function trimTail(url) {
  let u = url;
  for (;;) {
    const last = u.slice(-1);
    if (/[.,;:!?'"]/.test(last)) { u = u.slice(0, -1); continue; }
    if (last === ')' && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) { u = u.slice(0, -1); continue; }
    if (last === ']' && (u.match(/\[/g) || []).length < (u.match(/\]/g) || []).length) { u = u.slice(0, -1); continue; }
    return u;
  }
}

const URL_RE = /\b(?:https?:\/\/|mailto:)[^\s<>"`]+/gi;

/**
 * An email's plain text → [{ t } | { u }]. Adjacent text pieces are joined. A very long text is cut (a note says so).
 * @param {string} text
 * @returns {{ t?: string, u?: string }[]}
 */
function textSegments(text) {
  let s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  let cut = false;
  if (s.length > MAX_TEXT) { s = s.slice(0, MAX_TEXT); cut = true; }
  const out = [];
  const push = (seg) => {
    if (seg.t != null) {
      if (!seg.t) return;
      const prev = out[out.length - 1];
      if (prev && prev.t != null) { prev.t += seg.t; return; }
    }
    out.push(seg);
  };
  let at = 0, links = 0;
  for (const m of s.matchAll(URL_RE)) {
    const raw = trimTail(m[0]);
    if (!raw || links >= MAX_LINKS) continue;
    push({ t: s.slice(at, m.index) });
    push(shownLink(raw));
    links++;
    at = m.index + raw.length;
  }
  push({ t: s.slice(at) });
  if (cut) push({ t: '\n\n… (the rest of this email is not shown — open it in Outlook)' });
  return out;
}

module.exports = { textSegments, shownLink, unwrapSafeLinks, hideParams, isSecretName, ownHosts, documensoHosts, HIDDEN, MAX_TEXT };
