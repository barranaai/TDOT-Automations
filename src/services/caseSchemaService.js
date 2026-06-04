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

const fs   = require('fs');
const path = require('path');

const SCHEMA_DIR = path.join(__dirname, '..', 'data', 'caseSchemas');
const REGISTRY = new Map();

function keyOf(caseType, subType) {
  return `${String(caseType || '').trim().toLowerCase()}::${String(subType || '').trim().toLowerCase()}`;
}

function isValidSchema(schema) {
  return schema && schema.caseType && typeof schema.subType === 'string' && Array.isArray(schema.roles);
}

function register(schema) {
  // subType may legitimately be '' for case types that have no sub-type
  // (PGP, Citizenship, TRV, …). Only caseType and roles[] are mandatory.
  if (!isValidSchema(schema)) {
    throw new Error('Invalid schema — must export caseType, subType (string, may be ""), roles[]');
  }
  const k = keyOf(schema.caseType, schema.subType);
  if (REGISTRY.has(k)) {
    throw new Error(`Duplicate schema registered for ${schema.caseType} / ${schema.subType}`);
  }
  REGISTRY.set(k, schema);
}

/**
 * Auto-load every *.js schema in src/data/caseSchemas/ (top level only — the
 * drafts/ subfolder is ignored). Each file is loaded in its own try/catch so a
 * single malformed or invalid schema logs a warning and is skipped rather than
 * crashing the whole registry (and therefore the server). This is the safety
 * property that lets us add many schemas at once without risk.
 */
function loadAll() {
  let files;
  try {
    files = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.js'));
  } catch (err) {
    console.error(`[caseSchemaService] Could not read schema dir ${SCHEMA_DIR}: ${err.message}`);
    return;
  }
  let ok = 0, skipped = 0;
  for (const file of files) {
    const full = path.join(SCHEMA_DIR, file);
    try {
      const schema = require(full);
      if (!isValidSchema(schema)) {
        console.warn(`[caseSchemaService] Skipping ${file} — not a valid schema shape`);
        skipped++; continue;
      }
      register(schema);
      ok++;
    } catch (err) {
      console.warn(`[caseSchemaService] Skipping ${file} — load error: ${err.message}`);
      skipped++;
    }
  }
  console.log(`[caseSchemaService] Loaded ${ok} schema(s)${skipped ? `, skipped ${skipped}` : ''}.`);
}

loadAll();

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
