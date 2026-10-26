import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STREAM_LEVEL_MS } from "../../passive-liquidity/columnHistoryStream";
import { HOST_COLUMN_MS } from "../liveRangeReader";
import { WINDOW_SPAN_MS } from "../liveRangeWindow";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pyramid = (name: string) => require(path.join(here, "../../../../../../runtime/src/indicators/l2-memory/pyramid", name));

describe("the host's bounds, kept in step with the runtime that sets them", () => {
  it("the zone reaches back exactly as far as the host keeps its columns", () => {
    expect(WINDOW_SPAN_MS).toBe(pyramid("pyramid-builder.js").DEFAULT_RETENTION_MS);
  });

  it("the reader takes a host column as long as the host's finest level, the level the history stream asks for", () => {
    expect(HOST_COLUMN_MS).toBe(pyramid("pyramid-levels.js").BASE_LEVEL_MS);
    expect(STREAM_LEVEL_MS).toBe(HOST_COLUMN_MS);
  });
});
