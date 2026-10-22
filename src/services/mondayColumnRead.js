'use strict';

/**
 * Reading Monday "connect boards" (board_relation) and mirror (lookup) cells.
 *
 * Monday returns `text` AND `value` as null for these column types in every API
 * version it still serves (2025-04 … 2026-10, checked 2026-10-22; the app sends
 * no API-Version header and gets the "current" one). The data is only in the
 * typed fragments below — put them in the column_values selection:
 *
 *   column_values(ids:["board_relation_…"]){ id ${RELATION_FIELDS} }
 *
 * Writes are unaffected: { item_ids: [...] } still sets a link cell (and
 * replaces the whole set — so never write one without reading it first).
 */

const RELATION_FIELDS = '... on BoardRelationValue { linked_item_ids display_value }';
const MIRROR_FIELDS   = '... on MirrorValue { display_value }';

/**
 * The item ids a link cell holds, as strings — or NULL when the cell did not
 * come back in a readable shape. Null is not "empty": a caller about to write
 * the cell must stop rather than replace links it could not see.
 */
function linkedIds(col) {
  if (!col) return null;
  if (Array.isArray(col.linked_item_ids)) return col.linked_item_ids.map(String);
  // the shape older API versions used (value JSON) — kept as a fallback
  try {
    const v = JSON.parse(col.value || 'null');
    if (v && Array.isArray(v.linkedPulseIds)) return v.linkedPulseIds.map((x) => String(x.linkedPulseId));
  } catch (_) { /* unreadable */ }
  return null;
}

/** A mirror (or link) cell's shown text — '' when empty or unreadable. */
function displayValue(col) {
  if (!col) return '';
  if (typeof col.display_value === 'string') return col.display_value;
  return String(col.text || '');
}

module.exports = { RELATION_FIELDS, MIRROR_FIELDS, linkedIds, displayValue };
