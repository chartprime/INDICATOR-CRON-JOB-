import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRINT_WINDOW_COLUMNS } from "./frames";

// The window a column's prints may span is one number in three places: the
// runtime's column flow, which decides what a column carries; the wire
// builder and the store loader, which refuse what a column may not carry;
// and this parser, which refuses it again on the browser's side. On
// 2026-09-20 the first two moved and this one did not, and every live frame
// was rejected here -- a reconnect loop on the chart. The browser cannot
// import the runtime, so the number is repeated and this is what keeps the
// copy honest.

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const columnFlow = require(path.join(here, "../../../runtime/src/indicators/passive_liquidity/column-flow.js"));

describe("the print window the browser accepts", () => {
  it("is the window the runtime's column flow produces", () => {
    expect(PRINT_WINDOW_COLUMNS).toBe(columnFlow.PRINT_WINDOW_COLUMNS);
  });
});
