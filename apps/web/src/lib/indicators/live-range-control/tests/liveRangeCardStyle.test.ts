import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../../../../App.css"), "utf8");

function ruleOf(selector: string): { at: number; body: string } {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return { at, body: css.slice(at, css.indexOf("}", at)) };
}

describe("the Live Range Control card in App.css", () => {
  it("the card comes after the Candle Monitor's rules, as wide as the monitor at the medium size and letting the pointer through to the chart", () => {
    const card = ruleOf(".live-range-card");
    expect(card.at).toBeGreaterThan(ruleOf('.candle-monitor[data-stale="true"] .candle-monitor-row').at);
    expect(card.body).toContain("width: calc(236px * var(--lrc-k));");
    expect(card.body).toContain("--lrc-k: 1;");
    expect(card.body).toContain("pointer-events: none;");
  });

  it("the start's line sits tight under the head, in the card's grey sub-line style", () => {
    const since = ruleOf(".live-range-since");
    expect(since.at).toBeGreaterThan(ruleOf(".live-range-card .candle-monitor-head").at);
    expect(since.body).toContain("margin: -2px 0 3px;");
    expect(ruleOf(".live-range-sub").body).toContain("display: block;");
  });

  it("a placed card is positioned on the pane by itself, on layer 4", () => {
    const placed = ruleOf('.live-range-card[data-placed="true"]');
    expect(placed.body).toContain("position: absolute;");
    expect(placed.body).toContain("z-index: 4;");
  });

  it("the grip takes the pointer to move the card, and being the title itself it takes the card's family and size without dropping the title's bold", () => {
    const grip = ruleOf(".live-range-grip");
    expect(grip.body).toContain("pointer-events: auto;");
    expect(grip.body).toContain("cursor: move;");
    expect(grip.body).toContain("touch-action: none;");
    expect(grip.body).toContain("font-family: inherit;");
    expect(grip.body).toContain("font-size: inherit;");
    expect(grip.body).not.toMatch(/\sfont(-weight)?:/);
  });

  it("the card's 236 px include its padding, so it is 236 px wide all told and its head fits", () => {
    expect(ruleOf(".live-range-card").body).toContain("box-sizing: border-box;");
  });

  it("the window is two native sliders on one line, styled no further than the other sliders: both fill one box, the start slider reads from the right, and the end slider is cut at the middle between the handles", () => {
    const box = ruleOf(".live-range-window").body;
    expect(box).toContain("position: relative;");
    expect(box).toContain("height: 16px;");
    expect(box).toContain("margin: 2px;");
    expect(box).toContain("--cut: calc(8px + (var(--from) + var(--to)) / 2 * (100% - 16px));");
    const input = ruleOf('.live-range-window input[type="range"]').body;
    expect(input).toContain("position: absolute;");
    expect(input).toContain("inset: 0;");
    expect(input).toContain("width: 100%;");
    expect(input).toContain("margin: 0;");
    expect(ruleOf(".live-range-window-start").body).toContain("direction: rtl;");
    expect(ruleOf(".live-range-window-end").body).toContain("clip-path: inset(0 0 0 var(--cut));");
    for (const selector of [".live-range-window", '.live-range-window input[type="range"]', ".live-range-window-start", ".live-range-window-end"]) expect(ruleOf(selector).body).not.toContain("appearance");
    expect(css).not.toMatch(/\.live-range-window[^{]*::-(webkit-slider|moz-range)/);
  });

  it("the three mode radios sit side by side and wrap when the dialog is narrow", () => {
    const modes = ruleOf(".live-range-modes").body;
    expect(modes).toContain("display: flex;");
    expect(modes).toContain("flex-wrap: wrap;");
  });

  it("the one delta cell across both columns is centred under them", () => {
    const joined = ruleOf(".live-range-row td.live-range-joined");
    expect(joined.body).toContain("text-align: center;");
    expect(joined.at).toBeGreaterThan(ruleOf(".live-range-value").at);
  });

  it("scales the whole card by its monitor size, one factor small and large set: its width, padding, columns and every font size in it", () => {
    const card = ruleOf(".live-range-card").body;
    expect(card).toContain("padding: calc(6px * var(--lrc-k)) calc(9px * var(--lrc-k)) calc(5px * var(--lrc-k));");
    expect(card).toContain("font-size: calc(9px * var(--lrc-k));");
    const small = ruleOf('.live-range-card[data-size="small"]');
    const large = ruleOf('.live-range-card[data-size="large"]');
    expect([small.body, large.body].map((body) => body.replace(/\s+/g, " ").trim())).toEqual(['.live-range-card[data-size="small"] { --lrc-k: 0.85;', '.live-range-card[data-size="large"] { --lrc-k: 1.25;']);
    expect(Math.min(small.at, large.at)).toBeGreaterThan(ruleOf(".live-range-card").at);
    expect(ruleOf(".live-range-col").body).toContain("width: calc(48px * var(--lrc-k));");
    const fonts: [string, number][] = [[".live-range-head th", 8], [".live-range-label", 9], [".live-range-value", 10], [".live-range-sub", 8], [".live-range-verdict", 13], [".live-range-verdict-z", 12], [".live-range-count", 8]];
    for (const [selector, px] of fonts) expect(ruleOf(selector).body, selector).toContain(`font-size: calc(${px}px * var(--lrc-k));`);
    const rules = [...css.matchAll(/\n(\.live-range[^{]*) \{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(20);
    expect(rules.filter(([, , body]) => /font-size: [0-9.]+px;/.test(body)).map(([, selector]) => selector)).toEqual([]);
  });

  it("puts the count of the big prints on its own line under their size, smaller and not bold, in the colour of the side", () => {
    const count = ruleOf(".live-range-count").body;
    expect(count).toContain("display: block;");
    expect(count).toContain("font-weight: 400;");
    expect(count).not.toContain("color");
    expect(ruleOf(".live-range-count").at).toBeGreaterThan(ruleOf(".live-range-value").at);
  });

  it("the price impact cells take the pointer the card lets through, with a help cursor, and their tip spans the card above its layer, lets the pointer through and scales with the card", () => {
    const hover = ruleOf(".live-range-hover").body;
    expect(hover).toContain("pointer-events: auto;");
    expect(hover).toContain("cursor: help;");
    const tip = ruleOf(".live-range-tip").body;
    for (const line of ["position: absolute;", "left: 0;", "right: 0;", "z-index: 5;", "pointer-events: none;", "padding: calc(6px * var(--lrc-k)) calc(9px * var(--lrc-k));", "font-size: calc(9px * var(--lrc-k));", "white-space: normal;"]) expect(tip, line).toContain(line);
    expect(ruleOf(".live-range-tip-title").body).toContain("font-size: calc(8px * var(--lrc-k));");
    expect(ruleOf(".live-range-tip-title").body).toContain("text-transform: uppercase;");
    expect(ruleOf(".live-range-tip-line").body).toContain("color: #b4b8c0;");
    expect(ruleOf(".live-range-tip-reading").body).toContain("border-top: 1px solid rgba(255, 255, 255, 0.08);");
    expect(ruleOf(".live-range-tip-reading").body).toContain("font-weight: 600;");
  });

  it("the verdict line stands above the table, bigger and bolder than the rows, a rule under it, and its z takes the line's colour", () => {
    const verdict = ruleOf(".live-range-verdict").body;
    for (const line of ["font-size: calc(13px * var(--lrc-k));", "font-weight: 700;", "white-space: nowrap;", "border-bottom: 1px solid rgba(255, 255, 255, 0.08);", "margin: 0 0 3px;", "color: #e6e8ee;"]) expect(verdict, line).toContain(line);
    expect(verdict).not.toContain("border-top");
    const z = ruleOf(".live-range-verdict-z").body;
    expect(z).toContain("font-size: calc(12px * var(--lrc-k));");
    expect(z).toContain("font-weight: 700;");
    expect(z).not.toContain("color");
  });

  it("the loading line sits above the table where the verdict goes, a rule under it, with a small turning ring before the word", () => {
    const loading = ruleOf(".live-range-loading");
    expect(loading.body).toContain("display: flex;");
    expect(loading.body).toContain("align-items: center;");
    expect(loading.body).toContain("gap: calc(5px * var(--lrc-k));");
    expect(loading.body).toContain("margin: 0 0 3px;");
    expect(loading.body).toContain("padding: 2px 0 4px;");
    expect(loading.body).toContain("border-bottom: 1px solid rgba(255, 255, 255, 0.08);");
    expect(loading.body).not.toContain("border-top");
    const spinner = ruleOf(".live-range-spinner");
    expect(spinner.body).toContain("width: calc(9px * var(--lrc-k));");
    expect(spinner.body).toContain("height: calc(9px * var(--lrc-k));");
    expect(spinner.body).toContain("border-radius: 50%;");
    expect(spinner.body).toContain("border: 1.5px solid rgba(255, 255, 255, 0.2);");
    expect(spinner.body).toContain("border-top-color: #e6e8ee;");
    expect(spinner.body).toContain("animation: live-range-spin 0.8s linear infinite;");
    expect(css).toContain("@keyframes live-range-spin");
    expect(spinner.at).toBeGreaterThan(loading.at);
  });

  it("dragging the card by its grip never selects the title's text", () => {
    expect(ruleOf(".live-range-grip").body).toContain("user-select: none;");
  });
});
