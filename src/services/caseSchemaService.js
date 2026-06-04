/**
 * caseSchemaService — registry of code-defined Case Structure Schemas.
 *
 * Maps (caseType, subType) → a schema module from src/data/caseSchemas/.
 * checklistService consults this at seed time; anything NOT registered here
 * continues to seed from the Monday Template Board exactly as before. This is
 * a strict-add migration — registering a schema is the ONLY thing that moves a
 * case type onto the new path, and even then only when SCHEMA_DRIVEN_SEEDING
 * is enabled (see checklistService).
 *
 * To migrate a (caseType, subType): create src/data/caseSchemas/<name>.js
 * exporting { caseType, subType, roles[], getDocuments? }, then require +
 * register it below.
 */

'use strict';

const supervisaParents      = require('../data/caseSchemas/supervisa-parents.js');
const supervisaGrandparents = require('../data/caseSchemas/supervisa-grandparents.js');
const outlandSpousalMarriage = require('../data/caseSchemas/outland-spousal-sponsorship-marriage.js');
const inlandSpousalMarriage  = require('../data/caseSchemas/inland-spousal-sponsorship-marriage.js');

const REGISTRY = new Map();

function keyOf(caseType, subType) {
  return `${String(caseType || '').trim().toLowerCase()}::${String(subType || '').trim().toLowerCase()}`;
}

function register(schema) {
  if (!schema || !schema.caseType || !schema.subType || !Array.isArray(schema.roles)) {
    throw new Error('Invalid schema — must export caseType, subType, roles[]');
  }
  const k = keyOf(schema.caseType, schema.subType);
  if (REGISTRY.has(k)) {
    throw new Error(`Duplicate schema registered for ${schema.caseType} / ${schema.subType}`);
  }
  REGISTRY.set(k, schema);
}

// ── Registered schemas ───────────────────────────────────────────────────────
register(supervisaParents);
register(supervisaGrandparents);
register(outlandSpousalMarriage);
register(inlandSpousalMarriage);

/** Return the registered schema for (caseType, subType), or null. */
function lookup(caseType, subType) {
  if (!caseType || !subType) return null;
  return REGISTRY.get(keyOf(caseType, subType)) || null;
}

/** List registered (caseType, subType) pairs — for diagnostics/logging. */
function listRegistered() {
  return Array.from(REGISTRY.values()).map((s) => ({ caseType: s.caseType, subType: s.subType }));
}

module.exports = { lookup, listRegistered };
