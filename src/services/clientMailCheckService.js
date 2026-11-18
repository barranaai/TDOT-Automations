'use strict';

/**
 * Client emails from the office mailbox (Stage 1, Faran 2026-11-19) — the READ-ONLY check behind
 * GET /admin/client-mail/check[?sendId=…] (named admins only; routes/clientMailRoutes.js).
 *
 * After deploy, with the switch still OFF, one test send (POST /api/test-email {"client": true}) goes from
 * the office mailbox; this check then proves Microsoft kept the copy and kept our stamp, before Faran
 * switches client emails on (CLIENT_MAIL_FROM).
 *
 * It answers counts and booleans only — never a subject, an address (the mailbox's DOMAIN is the one address
 * part shown), a body or Graph's error text (it can repeat the query): a failed Graph call is its status code
 * and Graph's short error code. It reads; it never sends, moves or changes anything.
 *
 * The mailbox read: CLIENT_MAIL_FROM when it is set and usable, else the office mailbox the test send uses
 * (mailboxForTest — the same address the client replies go to).
 */

const axios = require('axios');
const mail = require('./microsoftMailService');
const { propId, NAMES } = require('../utils/mailTag');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_TIMEOUT_MS = 15000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const io = {
  token: () => mail.getAccessToken(),
  dropToken: () => mail.invalidateAccessToken(),
  get: (url, headers) => axios.get(url, { headers, timeout: GRAPH_TIMEOUT_MS }),
  now: () => mail.io.now(),
};

/** The mailbox the test send (and this check) uses: the switch's mailbox, else the office mailbox. */
function mailboxForTest() {
  return mail.clientMailbox() || require('../utils/clientContact').CLIENT_REPLY_TO;
}

/** A Graph GET with one retry after a 401 (a revoked / drifted token) — emailLeadsService's pattern. */
async function graphGet(url) {
  const call = async () => io.get(url, { Authorization: `Bearer ${await io.token()}` });
  try { return (await call()).data; }
  catch (err) {
    if (!(err && err.response && err.response.status === 401)) throw err;
    io.dropToken();
    return (await call()).data;
  }
}

/** Status code + Graph's error code only — never its message, never the URL. */
function errorOf(err) {
  const status = (err && err.response && err.response.status) || 0;
  const raw = err && err.response && err.response.data && err.response.data.error && err.response.data.error.code;
  const code = /^[A-Za-z0-9_.-]{1,80}$/.test(String(raw || '')) ? String(raw) : (status ? 'graph-error' : 'no-answer');
  return { status, code };
}

const odataStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * @param {{ sendId?: string }} [opts]
 * @returns {Promise<object>} counts / booleans only
 */
async function check({ sendId = '' } = {}) {
  const setting = String(process.env.CLIENT_MAIL_FROM || '').trim();
  const switchBox = mail.clientMailbox();
  const box = mailboxForTest();
  const st = mail._state();
  const out = {
    ok: false,
    switchOn: !!switchBox,
    settingIgnored: !!setting && !switchBox,
    mailboxRead: switchBox ? 'CLIENT_MAIL_FROM' : 'the test default (switch off)',
    mailboxDomain: box.split('@')[1] || '',
    stampRefusedSinceRestart: !!st.stampRefused,
    sendAsRefusedInLastHour: !!st.sendAsRefusedAt && io.now() - st.sendAsRefusedAt < mail.SEND_AS_PAUSE_MS,
    sentItems: null,
  };
  const base = `${GRAPH}/users/${encodeURIComponent(box)}`;

  try {
    const f = await graphGet(`${base}/mailFolders/sentitems?$select=totalItemCount`);
    out.sentItems = { readable: true, totalItemCount: Number(f && f.totalItemCount) || 0 };
  } catch (err) { out.sentItems = { readable: false, ...errorOf(err) }; }

  const id = String(sendId || '').trim();
  if (id) {
    out.copy = { via: 'unknown here — the test send answered it' };
    if (!UUID_RE.test(id)) {
      out.copy.error = { status: 0, code: 'bad-send-id' };
    } else {
      const filter = `singleValueExtendedProperties/Any(ep: ep/id eq ${odataStr(propId('TdotSendId'))} and ep/value eq ${odataStr(id.toLowerCase())})`;
      try {
        const page = await graphGet(`${base}/mailFolders/sentitems/messages?$filter=${encodeURIComponent(filter)}&$select=id&$top=2`);
        const hits = ((page && page.value) || []).filter((m) => m && m.id);
        out.copy.found = hits.length ? 1 : 0;
        if (hits.length > 1) out.copy.moreThanOne = true;
        if (hits.length) {
          // which of our property NAMES came back on the copy — one documented $expand per name, one at a time
          const back = [];
          const failed = [];
          for (const name of NAMES) {
            try {
              const m = await graphGet(`${base}/messages/${encodeURIComponent(hits[0].id)}?$select=id&$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq ${odataStr(propId(name))})`)}`);
              if (((m && m.singleValueExtendedProperties) || []).some((p) => p && String(p.id || '').toLowerCase() === propId(name).toLowerCase())) back.push(name);
            } catch (err) { failed.push({ name, ...errorOf(err) }); }
          }
          out.copy.propertiesBack = back;
          if (failed.length) out.copy.propertyReadsFailed = failed;
        }
      } catch (err) { out.copy.error = errorOf(err); }
    }
  }
  out.ok = !!(out.sentItems && out.sentItems.readable) && (!out.copy || (!out.copy.error && out.copy.found === 1));
  return out;
}

module.exports = { check, mailboxForTest, io, UUID_RE };
