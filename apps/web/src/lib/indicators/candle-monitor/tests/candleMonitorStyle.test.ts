import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../../../../App.css"), "utf8");

function ruleOf(selector: string): { at: number; body: string } {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return { at, body: css.slice(at, css.indexOf("}", at)) };
}

describe("the Candle Monitor's column in App.css", () => {
  it("the monitor modifier comes after the base stack rule it shares a specificity with, so its top and its layer under the hover cards apply", () => {
    const base = ruleOf(".draw-table-overlay-stack");
    const bottom = ruleOf(".draw-table-overlay-stack--bottom");
    const monitor = ruleOf(".draw-table-overlay-stack--monitor");
    expect(bottom.at).toBeGreaterThan(base.at);
    expect(monitor.at).toBeGreaterThan(bottom.at);
    expect(base.body).toContain("z-index: 4;");
    expect(monitor.body).toContain("z-index: 3;");
    expect(monitor.body).toContain("top: 10px;");
    expect(ruleOf(".whale-tooltip").body).toContain("z-index: 4;");
  });

  it("a pinned exhaustion card flips below its click like a whale card", () => {
    expect(ruleOf(".whale-tooltip.exhaustion.below").body).toContain("transform: translate(-50%, 14px);");
  });
});
