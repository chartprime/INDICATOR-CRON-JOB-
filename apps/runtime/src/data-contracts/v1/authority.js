"use strict";
const { requireValue, token, timestamp, integer } = require("./exact");
const { validateRecord, hash, FAMILIES } = require("./record");

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function compareInt(a, b) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
function compareRecords(a, b) {
  return compareInt(a.time.eventNs, b.time.eventNs) || compareText(a.source.streamId, b.source.streamId) || compareInt(a.order.position, b.order.position) || compareText(a.family, b.family) || compareText(a.id, b.id);
}
function createAuthorityPolicy(rules) {
  requireValue(Array.isArray(rules), "INVALID_AUTHORITY_RULES");
  const rows = structuredClone(rules);
  for (const r of rows) {
    for (const k of ["instrumentId", "family", "population", "provider", "dataset", "schema", "datasetVersion", "methodVersion", "policyVersion"]) token(r[k]);
    requireValue(FAMILIES.includes(r.family), "INVALID_AUTHORITY_FAMILY");
    timestamp(r.fromNs); timestamp(r.toNs); requireValue(BigInt(r.fromNs) < BigInt(r.toNs), "INVALID_AUTHORITY_INTERVAL");
  }
  for (let i = 0; i < rows.length; i++) for (const b of rows.slice(i + 1)) {
    const a = rows[i];
    if (a.instrumentId === b.instrumentId && a.family === b.family && a.population === b.population) requireValue(BigInt(a.toNs) <= BigInt(b.fromNs) || BigInt(b.toNs) <= BigInt(a.fromNs), "AMBIGUOUS_AUTHORITY");
  }
  return r => {
    validateRecord(r);
    const t = BigInt(r.time.eventNs);
    const rule = rows.find(p => p.instrumentId === r.instrument.id && p.family === r.family && p.population === r.source.population && BigInt(p.fromNs) <= t && t < BigInt(p.toNs));
    requireValue(rule, "NO_AUTHORITY_FOR_INTERVAL");
    const selected = ["provider", "dataset", "schema", "datasetVersion", "methodVersion"].every(k => rule[k] === r.source[k]);
    return { selected, policyVersion: rule.policyVersion };
  };
}
function selectAuthoritative(records, policy, { maxRecords = 10000 } = {}) {
  requireValue(Number.isSafeInteger(maxRecords) && maxRecords > 0 && Array.isArray(records) && records.length <= maxRecords, "BATCH_LIMIT_EXCEEDED");
  const seen = new Map(), selected = [], excluded = [];
  for (const r of records) {
    const choice = policy(r);
    if (!choice.selected) { excluded.push({ id: r.id, reason: "NON_AUTHORITATIVE", policyVersion: choice.policyVersion }); continue; }
    const content = hash(r);
    if (seen.has(r.id)) {
      requireValue(seen.get(r.id) === content, "CONFLICTING_DUPLICATE");
      excluded.push({ id: r.id, reason: "REPEATED_RAW_RECORD", policyVersion: choice.policyVersion }); continue;
    }
    seen.set(r.id, content); selected.push(structuredClone(r));
  }
  return { records: selected.sort(compareRecords), excluded };
}
function createTradeLedger({ maxEntities = 10000 } = {}) {
  requireValue(Number.isSafeInteger(maxEntities) && maxEntities > 0, "INVALID_LEDGER_LIMIT");
  const entries = new Map(); let domain = null, lastPosition = null;
  return {
    apply(r) {
      validateRecord(r); requireValue(r.family === "trade", "TRADE_REQUIRED");
      const currentDomain = JSON.stringify([r.instrument.id, r.source.provider, r.source.dataset, r.source.schema, r.source.population, r.source.datasetVersion, r.source.streamId]);
      requireValue(domain === null || domain === currentDomain, "LEDGER_DOMAIN_MISMATCH");
      integer(r.order.position);
      requireValue(lastPosition === null || BigInt(r.order.position) > lastPosition, "NON_MONOTONIC_CAPTURE_POSITION");
      const key = r.data.entityId, old = entries.get(key);
      if (r.data.action === "NEW") {
        requireValue(!old, "DUPLICATE_ENTITY_REQUIRES_RECONCILIATION");
        requireValue(entries.size < maxEntities, "LEDGER_LIMIT_EXCEEDED");
      } else requireValue(old, "ORPHAN_CORRECTION");
      entries.set(key, r.data.action === "CANCEL" ? { cancelled: true } : structuredClone(r));
      domain = currentDomain; lastPosition = BigInt(r.order.position);
    },
    snapshot() { return [...entries.values()].filter(r => !r.cancelled).map(r => structuredClone(r)); },
  };
}
module.exports = { compareRecords, createAuthorityPolicy, selectAuthoritative, createTradeLedger };
