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
const inlandSpousalCommonLaw = require('../data/caseSchemas/inland-spousal-sponsorship-common-law.js');
const parentsGrandparentsSponsorship = require('../data/caseSchemas/parents-grandparents-sponsorship.js');
const visitorVisa12Members   = require('../data/caseSchemas/visitor-visa-1-2-members.js');
const visitorVisa13Members   = require('../data/caseSchemas/visitor-visa-1-3-members.js');

const REGISTRY = new Map();

function keyOf(caseType, subType) {
  return `${String(caseType || '').trim().toLowerCase()}::${String(subType || '').trim().toLowerCase()}`;
}

function register(schema) {
  // subType may legitimately be '' for case types that have no sub-type
  // (PGP, Citizenship, TRV, …). Only caseType and roles[] are mandatory.
  if (!schema || !schema.caseType || typeof schema.subType !== 'string' || !Array.isArray(schema.roles)) {
    throw new Error('Invalid schema — must export caseType, subType (string, may be ""), roles[]');
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
register(inlandSpousalCommonLaw);
register(parentsGrandparentsSponsorship);
register(visitorVisa12Members);
register(visitorVisa13Members);

/**
 * Return the registered schema for (caseType, subType), or null.
 * A null/'' subType is normalised by keyOf, so case types with no sub-type
 * resolve to their '' schema.
 */
function lookup(caseType, subType) {
  if (!caseType) return null;
  return REGISTRY.get(keyOf(caseType, subType)) || null;
}

/** List registered (caseType, subType) pairs — for diagnostics/logging. */
function listRegistered() {
  return Array.from(REGISTRY.values()).map((s) => ({ caseType: s.caseType, subType: s.subType }));
}

module.exports = { lookup, listRegistered };
