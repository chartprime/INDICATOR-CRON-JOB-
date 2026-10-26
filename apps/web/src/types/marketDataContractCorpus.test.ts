import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import corpus from "../test-fixtures/market-data-contract-v1.json";
import { CLIENT_CAPABILITIES, parseServerFrame } from "./frames";

// The set of frame kinds is read off the contract, not typed here, so adding a
// kind to the schema without pinning a producer sample for it fails this test.
// A kind the contract marks with `x-capability` is only ever sent to a browser
// that declared that capability, so it is required here exactly when this
// browser declares it (CLIENT_CAPABILITIES, which the worker sends on connect).
// Declaring a new capability therefore demands a parser and a pinned sample.
type FrameDef = { properties: { type: { const: string } }; "x-capability"?: string };
const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(
  path.resolve(here, "../../../../docs/contracts/ws-frame-contract/v1/ws-frame-contract-v1.schema.json"), "utf8"));
const frameDefs: FrameDef[] = schema.$defs.serverFrame.oneOf
  .map((entry: { $ref: string }) => schema.$defs[entry.$ref.replace("#/$defs/", "")]);
const contractFrameTypes: string[] = frameDefs.map((def) => def.properties.type.const).sort();
const receivableFrameTypes: string[] = frameDefs
  .filter((def) => def["x-capability"] === undefined || CLIENT_CAPABILITIES.includes(def["x-capability"]))
  .map((def) => def.properties.type.const)
  .sort();

describe("immutable Binance/dxFeed market-data contract corpus", () => {
  it("admits every pinned producer frame through the hostile browser boundary, and pins every kind this browser can be sent", () => {
    const parsed = corpus.frames.map((frame) => parseServerFrame(frame));
    expect(parsed.every((frame) => frame !== null)).toBe(true);
    expect(new Set(parsed.map((frame) => frame?.provider))).toEqual(new Set(["BINANCE", "DXFEED"]));
    expect(contractFrameTypes.length).toBeGreaterThanOrEqual(13);
    expect(receivableFrameTypes).toContain("marker_history");
    expect([...new Set(parsed.map((frame) => frame!.type))].sort()).toEqual(receivableFrameTypes);
  });

  it("every contract kind this browser is not sent is gated by a capability it does not declare", () => {
    const withheld = frameDefs.filter((def) => !receivableFrameTypes.includes(def.properties.type.const));
    for (const def of withheld) {
      expect(def["x-capability"]).toEqual(expect.any(String));
      expect(CLIENT_CAPABILITIES).not.toContain(def["x-capability"]);
    }
  });

  it("a marker history page expands to marker frames the marker parser would have produced, with the page's identity", () => {
    const pages = corpus.frames.filter((frame) => frame.type === "marker_history");
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const page of pages) {
      const parsed = parseServerFrame(page);
      expect(parsed?.type).toBe("marker_history");
      if (parsed?.type !== "marker_history") continue;
      expect(parsed.markers).toHaveLength((page as { rows: unknown[] }).rows.length);
      for (const marker of parsed.markers) {
        const { type: _type, reset: _reset, seq: _seq, rows: _rows, ...identity } = page as Record<string, unknown>;
        const asFrame = { type: "marker", ...identity, ts_exchange: marker.ts_exchange, price: marker.price, size: marker.size, side: marker.side, trade_id: marker.trade_id };
        expect(parseServerFrame(asFrame)).toEqual(marker);
      }
    }
  });

  it("rejects identity substitution and schema drift derived from the pinned corpus", () => {
    for (const frame of corpus.frames) {
      expect(parseServerFrame({ ...frame, protocol_drift: true })).toBeNull();
      if (frame.provider === "BINANCE") {
        expect(parseServerFrame({ ...frame, provider: "DXFEED" })).toBeNull();
      } else {
        expect(parseServerFrame({ ...frame, provider: "BINANCE" })).toBeNull();
      }
    }
  });
});
