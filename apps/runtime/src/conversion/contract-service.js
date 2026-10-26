"use strict";

const { mapObservation } = require("../data-contracts/v1/adapters");
const { createIdentityResolver } = require("../data-contracts/v1/identity");
const { timestamp } = require("../data-contracts/v1/exact");

const MAX_BATCH_ROWS = 8192;

function createContractService() {
  let cachedKey = null;
  let cachedResolver = null;

  function resolverFor(mappings) {
    const key = JSON.stringify(mappings);
    if (key !== cachedKey) {
      cachedResolver = createIdentityResolver(mappings);
      cachedKey = key;
    }
    return cachedResolver;
  }

  function handle(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("MALFORMED_REQUEST");
    const { batchId, provider, family, rows, context } = request;
    if (typeof batchId !== "string" || batchId.length === 0) throw new Error("MISSING_BATCH_ID");
    if (typeof provider !== "string" || typeof family !== "string") throw new Error("MISSING_PROVIDER_OR_FAMILY");
    if (!Array.isArray(rows)) throw new Error("ROWS_NOT_ARRAY");
    if (rows.length === 0 || rows.length > MAX_BATCH_ROWS) throw new Error("BATCH_ROW_COUNT");
    if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error("MISSING_CONTEXT");
    if (!Array.isArray(context.mappings)) throw new Error("MISSING_MAPPINGS");
    if (!context.lineage || typeof context.lineage !== "object") throw new Error("MISSING_LINEAGE");
    timestamp(context.ingestNs);

    const resolveIdentity = resolverFor(context.mappings);
    const base = {
      dataset: context.dataset,
      sourceSymbol: context.sourceSymbol,
      population: context.population,
      datasetVersion: context.datasetVersion,
      streamId: context.streamId,
      schema: context.schema,
      ingestNs: context.ingestNs,
      receiveMs: context.receiveMs,
      resolveIdentity,
    };

    const results = rows.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("MALFORMED_ROW_ENTRY");
      if (!entry.row || typeof entry.row !== "object" || Array.isArray(entry.row)) throw new Error("MALFORMED_ROW_ENTRY");
      const position = String(entry.position);
      const lineageRow = entry.lineageRow === undefined ? position : String(entry.lineageRow);
      const outcome = mapObservation(provider, family, entry.row, {
        ...base,
        position,
        lineage: { ...context.lineage, row: lineageRow },
      });
      return outcome.ok ? { ok: true, records: outcome.records } : { ok: false, quarantine: outcome.quarantine };
    });

    return { batchId, results };
  }

  return { handle };
}

module.exports = { createContractService, MAX_BATCH_ROWS };
