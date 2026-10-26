import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_CONTRACT_VERSION,
  ARCHIVE_FAMILIES,
  ARCHIVE_PAGE_FIELDS,
  ARCHIVE_QUERY_PATH,
  ARCHIVE_RESTART_HEADER,
} from "./archiveClient";

// W6.10 acceptance: "runtime producer and frontend consumer contract tests agree
// on every supported response/error/status". Python was already bound to the
// schema, and the Node gateway was too, but the browser client -- the consumer
// the criterion actually names -- was bound to nothing. Every constant here was
// a literal that could drift from the contract with all three suites green.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const schema = JSON.parse(readFileSync(
  path.join(repoRoot, "docs/contracts/archive-query/v1/archive-query-v1.schema.json"), "utf8"));
const defs = schema.$defs;

const require = createRequire(import.meta.url);
const route = require(path.join(repoRoot, "apps/runtime/src/server/archive-route.js"));

describe("the browser client against the versioned contract", () => {
  it("speaks the contract version the schema declares", () => {
    expect(ARCHIVE_CONTRACT_VERSION).toBe(defs.response.properties.contractVersion.const);
    expect(ARCHIVE_CONTRACT_VERSION).toBe(defs.request.properties.contractVersion.const);
  });

  it("accepts exactly the families the schema declares", () => {
    expect([...ARCHIVE_FAMILIES].sort()).toEqual([...defs.family.enum].sort());
  });

  it("validates every field of a successful envelope the schema requires", () => {
    // `pointer` is deliberately absent: the client never reads it, and claiming
    // otherwise here would assert coverage it does not have.
    const required = new Set<string>(defs.response.required);
    for (const field of ARCHIVE_PAGE_FIELDS) {
      expect(required.has(field), `${field} is not a required response field`).toBe(true);
    }
    expect([...required].filter((f) => !ARCHIVE_PAGE_FIELDS.includes(f) && f !== "contractVersion"))
      .toEqual(["pointer"]);
  });
});

describe("the browser client against the gateway it actually calls", () => {
  it("posts to the path the gateway serves", () => {
    expect(ARCHIVE_QUERY_PATH).toBe(route.ARCHIVE_QUERY_PATH);
  });

  it("reads the restart header the gateway sets", () => {
    expect(ARCHIVE_RESTART_HEADER).toBe(route.RESTART_HEADER);
  });

  it("agrees with the gateway on the contract version", () => {
    expect(ARCHIVE_CONTRACT_VERSION).toBe(route.CONTRACT_VERSION);
  });

  it("agrees with the gateway on the family set", () => {
    expect([...ARCHIVE_FAMILIES].sort()).toEqual([...route.FAMILIES].sort());
  });

  it("only ever sees restart codes the contract declares", () => {
    const declared = new Set<string>(defs.errorCode.enum);
    for (const code of route.RESTART_CODES) {
      expect(declared.has(code), `${code} is not a declared error code`).toBe(true);
    }
  });

  it("can receive every status the gateway is able to send", () => {
    const statuses = Object.fromEntries(
      Object.entries(defs.httpStatusByError.properties).map(([code, spec]) => [code, (spec as { const: number }).const]));
    expect(route.REFUSAL_STATUS).toEqual(statuses);
    expect(Object.keys(statuses).sort()).toEqual([...defs.errorCode.enum].sort());
  });
});
