'use strict';

/**
 * "Not Applicable" documents (2026-10-02) — one place for the facts every page
 * and engine shares, so they can never drift:
 *
 *   - the Document Status label text ("Not Applicable" on the Documents board;
 *     code reads labels, never indexes — keep the text stable, never delete it);
 *   - the reason column (created by scripts/add-doc-not-applicable.js, its id
 *     recorded in src/data/documentsBoard.json);
 *   - the switch DOC_NOT_APPLICABLE: ON = staff can mark/unmark, OFF = the
 *     buttons and routes are gone. Reading an N/A row (skip it in readiness,
 *     show it greyed) is ALWAYS on, so switching off never makes an already
 *     marked row count as missing again.
 *
 * Rules (reviewed 2026-10-02): staff only, a reason is required, the row is
 * never hidden or deleted (the firm must be able to show why a document was
 * not filed), the reason never goes in Review Notes (a note there emails the
 * client), N/A is for "does not exist for this client" — a file received by
 * email is uploaded into the row and reviewed as usual.
 */

const fs   = require('fs');
const path = require('path');
const { torontoTime } = require('../utils/torontoTime');

const LABEL = 'Not Applicable';
const CFG_PATH = path.join(__dirname, '..', 'data', 'documentsBoard.json');

let _cfg;
function config() {
  if (_cfg !== undefined) return _cfg;
  try { _cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (_) { _cfg = null; }
  return _cfg;
}

/** The reason column's id, or '' when the one-off script has not been run. */
function reasonColumnId() {
  const c = config();
  return (c && c.columns && c.columns.notApplicableReason) || '';
}

/** DOC_NOT_APPLICABLE — OFF until "1" / "true", read at call time (same shape as REVIEW_NOTE_REOPENS). */
function isEnabled() {
  const v = String(process.env.DOC_NOT_APPLICABLE || '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** Can staff mark documents right now? Needs the switch AND the reason column. */
function isReady() {
  return isEnabled() && Boolean(reasonColumnId());
}

const isNotApplicable = (status) => String(status || '').trim() === LABEL;

/** What goes in the reason column: the reason, then who and when. One line each. */
function reasonText(reason, staffName, ms = Date.now()) {
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return `${clean(reason)}\n— ${clean(staffName) || 'staff'}, ${torontoTime(ms)} (Toronto)`;
}

/** The reason alone (first line) from the column's text. */
function reasonOnly(text) {
  return String(text || '').split('\n')[0].trim();
}

/** The "— who, when" line from the column's text, or ''. */
function reasonBy(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 1 ? lines[lines.length - 1].replace(/^—\s*/, '') : '';
}

module.exports = { LABEL, isEnabled, isReady, isNotApplicable, reasonColumnId, reasonText, reasonOnly, reasonBy, CFG_PATH,
  _resetConfigForTests: () => { _cfg = undefined; },
  _setConfigForTests:   (cfg) => { _cfg = cfg; } };
