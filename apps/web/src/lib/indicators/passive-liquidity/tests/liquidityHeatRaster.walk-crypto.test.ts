import { describe, it } from "vitest";
import { walk } from "./heatRasterWalk";

// One flavour per file, so the two walks run on separate workers.
describe("the raster keeps the very picture a fresh paint makes", () => {
  for (const history of [false, true]) {
    for (const ratio of [1, 1.25, 2]) {
      it(`through a random walk of pans, zooms, price moves, live columns, candle closes, ledger fates and settings (crypto, history ${history}, pixel ratio ${ratio})`, () => {
        for (const seed of [1, 2]) walk("crypto", history, ratio, seed, 30);
      }, 120_000);
    }
  }
});
