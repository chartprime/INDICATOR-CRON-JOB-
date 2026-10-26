import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HISTORY_ASK_MAX_MS } from "../aggressiveTape";
import { HISTORY_REASK_MS } from "../columnPrints";

// The longest stretch one aggressive_history request may cover is one number
// in two places: the runtime's handler, which drops a longer request without
// a reply, and the tape, which sizes its asks. The browser cannot import the
// runtime, so the number is repeated and this is what keeps the copy honest.

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const aggressiveHistory = require(path.join(here, "../../../../../../runtime/src/server/aggressive-history.js"));

describe("the longest history ask the tape makes", () => {
  // Measured 2026-09-23 on BTC spot at a 5 BTC floor, windows ending 18 Sept
  // 18:00: the host answered 24 h in 8.1 s (refused, STORAGE_UNAVAILABLE),
  // 12 h in 6.9 s, 6 h in 4.1 s; its limit sits near 8 s and grows tighter
  // with the age of the data. Six hours keeps half that limit in hand.
  it("is never longer than the runtime's aggressive_history handler accepts, and sized to what the host answers on old days", () => {
    expect(HISTORY_ASK_MAX_MS).toBeLessThanOrEqual(aggressiveHistory.MAX_AGGRESSIVE_HISTORY_WINDOW_MS);
    expect(HISTORY_ASK_MAX_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe("the re-ask period", () => {
  it("outlasts the runtime's wait on a host print read, so a slow day is not asked twice while its reply is still due", () => {
    const remoteReader = require(path.join(here, "../../../../../../runtime/src/storage/remote-storage-reader.js"));
    expect(HISTORY_REASK_MS).toBeGreaterThanOrEqual(remoteReader.TIMEOUT_MS_BY_ROUTE["aggressive-prints"] + 5_000);
  });
});
