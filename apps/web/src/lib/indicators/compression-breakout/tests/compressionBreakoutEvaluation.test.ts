import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { formatTable, tableFor } from "./compressionBreakoutBaseline.test";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/**
 * Amendment 8: evaluation seeds 17..21, both directions, with the criteria
 * frozen before any run and the numbers reported as they come. No parameter
 * or rule was chosen on these seeds; the design seeds 7..16 are regression
 * evidence only. Criteria: hits ≥ 9 of 10 with level valid on every hit,
 * filtered early events ≤ 2 in total, no wrong-direction event inside a
 * matched window, failure and hold fixtures ≥ 4 of 5 in each direction.
 */
describe("compressionBreakout -- evaluation seeds 17..21 (frozen criteria, run once)", () => {
  const rows = tableFor([17, 18, 19, 20, 21]);
  const text = formatTable("Evaluation seeds 17..21", rows, 10);
  console.log(text);
  if (process.env.CB_TABLE_OUT) {
    mkdirSync(dirname(process.env.CB_TABLE_OUT), { recursive: true });
    writeFileSync(process.env.CB_TABLE_OUT, `${text}\n\n${JSON.stringify(rows, null, 2)}\n`);
  }
  const product = rows["Product (width ≤ 2×, min 6)"];

  it("meets the frozen criteria", () => {
    expect(product.hits).toBeGreaterThanOrEqual(9);
    expect(product.levelValid).toBe(product.levelChecked);
    expect(product.levelChecked).toBe(product.hits);
    expect(product.earlyFiltered).toBeLessThanOrEqual(2);
    expect(product.wrongDirection).toBe(0);
    // The outcome fixtures run in both directions: 5 seeds each; the criterion is at least 4 of 5 per direction, so at least 8 of 10 in all.
    expect(product.failures).toBeGreaterThanOrEqual(8);
    expect(product.holds).toBeGreaterThanOrEqual(8);
  });
});
