"use strict";

const fs = require("node:fs");
const path = require("node:path");

// W6.10. The same bounds are now written in three places -- the schema, the
// Python archive service, and the Node gateway -- and until this file existed
// nothing compared them. The repository has been bitten by exactly that twice:
// ws-frame-contract-limits.test.js exists because the wire limits were
// hardcoded three times over, and W6.09's audit found a `cacheLimits` block a
// schema rewrite had silently deleted, unnoticed because nothing read it.
//
// The failure is asymmetric, which is what makes it easy to make. If the
// gateway admits a larger page than the service does, the service refuses and
// the user sees errors; if the gateway admits a smaller one, nothing visibly
// breaks. A mistake dangerous in only one direction is the kind that ships.
//
// The two apps cannot share a module -- apps/web builds from its own workspace
// and the Python service is a different language entirely -- so an enforced
// invariant stands in for the shared constant that is not available.

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCHEMA_PATH = path.join(
  REPO_ROOT, "docs", "contracts", "archive-query", "v1", "archive-query-v1.schema.json",
);
const PYTHON_HTTP_PATH = path.join(
  REPO_ROOT, "apps", "runtime", "conversion", "archive_http.py",
);

const route = require("../../src/server/archive-route");

function defs() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")).$defs;
}

function consts(name) {
  return Object.fromEntries(
    Object.entries(defs()[name].properties).map(([key, spec]) => [key, spec.const]),
  );
}

function pythonConstant(name) {
  const source = fs.readFileSync(PYTHON_HTTP_PATH, "utf8");
  const match = new RegExp(`^${name}\\s*=\\s*([^\\n#]+)$`, "m").exec(source);
  return match ? match[1].trim() : null;
}

describe("archive query contract limits", () => {
  it("binds the gateway's request bounds to the schema", () => {
    const limits = consts("httpLimits");
    const limit = defs().limit;

    expect(route.MAX_REQUEST_BYTES).toBe(limits.maxRequestBytes);
    expect(route.MAX_LIMIT).toBe(limit.maximum);
    expect(route.MIN_LIMIT).toBe(limit.minimum);
    expect(route.MAX_INSTRUMENT_ID_LENGTH).toBe(defs().instrumentId.maxLength);
    expect(route.MAX_CURSOR_LENGTH).toBe(defs().cursor.maxLength);
    expect(route.MAX_POINTER_TOKEN_LENGTH).toBe(defs().pointerToken.maxLength);
    expect(route.MAX_SCAN_BYTES).toBe(defs().scanBytes.maximum);
    expect(route.MAX_UPSTREAM_RESPONSE_BYTES).toBe(consts("readerLimits").maxFrameBytes);
  });

  it("binds the gateway's family set to the schema", () => {
    expect([...route.FAMILIES].sort()).toEqual([...defs().family.enum].sort());
  });

  it("binds the gateway's contract version to the schema", () => {
    expect(route.CONTRACT_VERSION).toBe(defs().request.properties.contractVersion.const);
    expect(route.CONTRACT_VERSION).toBe(defs().response.properties.contractVersion.const);
  });

  it("keeps the gateway's successful-envelope surface equal to the schema", () => {
    expect([...route.SUCCESS_RESPONSE_FIELDS].sort())
      .toEqual(Object.keys(defs().response.properties).sort());
  });

  it("binds the gateway's admission limits to the schema", () => {
    const admission = consts("admissionLimits");

    expect(route.DEFAULT_MAX_CONCURRENT).toBe(admission.maxConcurrentReads);
    expect(route.DEFAULT_MAX_QUEUED).toBe(admission.maxQueued);
    expect(route.DEFAULT_MAX_QUEUE_WAIT_MS).toBe(admission.maxQueueWaitMs);
    expect(route.DEFAULT_RATE_LIMIT.max).toBe(admission.rateLimitMax);
    expect(route.DEFAULT_RATE_LIMIT.windowMs).toBe(admission.rateLimitWindowMs);
  });

  it("keeps the gateway at least as strict as the service it protects", () => {
    // The outer gate must refuse before the inner one has to. If the gateway
    // admitted more than the service, the service's own admission would become
    // the thing that refuses -- after a round trip that has already been paid
    // for, and with the refusal attributed to the wrong layer.
    const admission = consts("admissionLimits");

    expect(route.DEFAULT_MAX_CONCURRENT).toBeLessThanOrEqual(admission.maxConcurrentReads);
  });

  it("names only error codes the contract declares", () => {
    const declared = new Set(defs().errorCode.enum);
    const emitted = [
      "MALFORMED_REQUEST", "UNAUTHORIZED", "OVERLOADED",
      "READER_UNAVAILABLE", "CANCELLED", "INVALID_WINDOW", "UNSUPPORTED_FAMILY",
      ...route.RESTART_CODES,
    ];

    for (const code of emitted) expect(declared.has(code)).toBe(true);
  });

  it("binds every gateway error status to the contract authority", () => {
    const statuses = consts("httpStatusByError");

    expect(route.REFUSAL_STATUS).toEqual(statuses);
  });

  it("treats exactly the process-local capabilities as restart signals", () => {
    // Snapshot tokens and cursor signatures are the only things a service
    // restart invalidates. Marking anything else as a restart would tell the
    // browser to silently retry a query that will fail again.
    expect([...route.RESTART_CODES].sort()).toEqual(["CURSOR_MALFORMED", "POINTER_TOKEN_INVALID"]);
  });

  it("agrees with the Python service on the headers that carry identity", () => {
    // The gateway proves itself with one header and passes the identity it
    // resolved in another. A rename on either side silently turns every request
    // into an UNAUTHORIZED refusal, which looks like a credential problem and
    // is not one.
    expect(pythonConstant("SERVICE_SECRET_HEADER")).toBe('"x-archive-service-secret"');
    expect(pythonConstant("CLIENT_HEADER")).toBe('"x-archive-client"');

    const gatewaySource = fs.readFileSync(
      path.join(REPO_ROOT, "apps", "runtime", "src", "server", "archive-route.js"), "utf8");
    expect(gatewaySource).toContain('"x-archive-service-secret": serviceSecret');
    expect(gatewaySource).toContain('"x-archive-client": clientId');
  });

  it("agrees with the Python service on the request body bound", () => {
    const limits = consts("httpLimits");

    expect(pythonConstant("MAX_REQUEST_BYTES")).toBe("64 * 1024");
    expect(64 * 1024).toBe(limits.maxRequestBytes);
    expect(route.MAX_REQUEST_BYTES).toBe(limits.maxRequestBytes);
  });
});
