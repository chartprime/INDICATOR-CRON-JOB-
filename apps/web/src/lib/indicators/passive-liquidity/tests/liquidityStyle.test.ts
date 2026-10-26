import { describe, expect, it } from "vitest";
import { liquidityStyleFor } from "../liquidityStyle";
import { AGE_ALPHA_MIN, LEVEL_MATURE_MS, ageFactor, cryptoAlpha, cryptoHoverWords, cryptoLiquidityStyle, cryptoPaintFloor, cryptoSaturation } from "../cryptoLiquidityStyle";
import { AAPL_PARAMS, aaplLiquidityStyle } from "../aaplLiquidityStyle";
import { TSLA_PARAMS, tslaLiquidityStyle } from "../tslaLiquidityStyle";
import { BTC_PARAMS, BTC_PERP_PARAMS, btcLiquidityStyle, btcPerpLiquidityStyle } from "../btcLiquidityStyle";
import { ETH_PARAMS, ETH_PERP_PARAMS, ethLiquidityStyle, ethPerpLiquidityStyle } from "../ethLiquidityStyle";
import { INDEX_DEFAULTS, createIndexStyle, indexAlphaWith, indexLiquidityStyle, indexPaintFloorWith, indexSaturationWith, indexTypicalRow } from "../indexLiquidityStyle";
import { bandMaxSizes, bandSizes } from "../liquidityGrid";
import { ES_PARAMS, esLiquidityStyle } from "../esLiquidityStyle";
import { NQ_PARAMS, nqLiquidityStyle } from "../nqLiquidityStyle";
import { BAND_MIN_SHARE, DEFAULT_LIQUIDITY_SETTINGS, LIQUIDITY_GAMMA, bandSpan } from "../liquiditySettings";

const column = (reference?: number, median?: number, ceiling?: number) => ({ ts: 0, lo: 0, hi: 0, bid: new Float64Array(1), ask: new Float64Array(1), ...(reference === undefined ? {} : { reference }), ...(median === undefined ? {} : { median }), ...(ceiling === undefined ? {} : { ceiling }) });
const auto = { settings: DEFAULT_LIQUIDITY_SETTINGS, clusterRows: 2, ladderMax: 73, reference: 6 };
// In fixed mode the layout's reference is the trader's size on the rows drawn: the size itself on the finest lane, twice it on rows twice as wide.
const fixed = { ...auto, reference: 10, settings: { ...DEFAULT_LIQUIDITY_SETTINGS, scaleMode: "fixed" as const, scaleSize: 10 } };
const fixedWideRows = { ...fixed, reference: 20 };
const FULL = Math.min(1, 0.6 * 1.6) * 255;

describe("liquidityStyleFor", () => {
  it("gives BTC, ETH, ES and NQ each their own file, and falls back to the shared crypto and index styles", () => {
    // Spot and perp share a pair's style: same wire symbol, same book shape, one set of settings; BTC perp has its own since 2026-09-11.
    expect(liquidityStyleFor("BINANCE", "BTC-USDT")).toBe(btcLiquidityStyle);
    expect(liquidityStyleFor("BINANCE", "BTC-USDT", "SPOT")).toBe(btcLiquidityStyle);
    expect(liquidityStyleFor("BINANCE", "BTC-USDT", "PERPETUAL")).toBe(btcPerpLiquidityStyle);
    expect(liquidityStyleFor("BINANCE", "ETH-USDT", "PERPETUAL")).toBe(ethPerpLiquidityStyle);
    expect(liquidityStyleFor("BINANCE", "ETH-USDT", "SPOT")).toBe(ethLiquidityStyle);
    // ETH perp, the trader's standard of 2026-09-11: five rows a band (about 65 cents), a quiet zone of sixteen, nothing under 1,000 ETH.
    expect(ethPerpLiquidityStyle.market).toBe("crypto");
    expect(ethPerpLiquidityStyle.defaultSettings).toMatchObject({ clusterRows: 5, quietBands: 16, minBandSize: 1_000, showPulled: true, levelFilter: "all", scaleMode: "auto" });
    expect(ETH_PERP_PARAMS.settings).toEqual({ clusterRows: 5, quietBands: 16, minBandSize: 1_000, showPulled: true });
    expect(ethPerpLiquidityStyle.name).not.toBe(ethLiquidityStyle.name);
    // BTC perp, the trader's standard of 2026-09-11: ten rows a band (about $40), a quiet zone of seven, nothing under 100 BTC.
    expect(btcPerpLiquidityStyle.market).toBe("crypto");
    expect(btcPerpLiquidityStyle.defaultSettings).toMatchObject({ clusterRows: 10, quietBands: 7, minBandSize: 100, showPulled: true, levelFilter: "all", scaleMode: "auto" });
    expect(BTC_PERP_PARAMS.settings).toEqual({ clusterRows: 10, quietBands: 7, minBandSize: 100, showPulled: true });
    expect(btcPerpLiquidityStyle.name).not.toBe(btcLiquidityStyle.name);
    expect(liquidityStyleFor("BINANCE", "ETH-USDT")).toBe(ethLiquidityStyle);
    // A pair with no file of its own, and anything unrecognised, falls back.
    expect(liquidityStyleFor("BINANCE", "SOL-USDT")).toBe(cryptoLiquidityStyle);
    expect(liquidityStyleFor("BINANCE", "BTCUSDT")).toBe(cryptoLiquidityStyle); // not a wire symbol
    expect(liquidityStyleFor(undefined)).toBe(cryptoLiquidityStyle);
    expect(btcLiquidityStyle.market).toBe("crypto");
    expect(ethLiquidityStyle.market).toBe("crypto");
    expect(liquidityStyleFor("DXFEED", "/ESU26:XCME")).toBe(esLiquidityStyle);
    expect(liquidityStyleFor("DXFEED", "/MESZ26:XCME")).toBe(esLiquidityStyle);
    expect(liquidityStyleFor("DXFEED", "/NQU26:XCME")).toBe(nqLiquidityStyle);
    expect(liquidityStyleFor("DXFEED", "/MNQU26:XCME")).toBe(nqLiquidityStyle);
    // AAPL has its own file since 2026-09-11; the other equities stay on the shared index style.
    expect(liquidityStyleFor("DXFEED", "AAPL")).toBe(aaplLiquidityStyle);
    expect(liquidityStyleFor("DXFEED", "TSLA")).toBe(tslaLiquidityStyle);
    expect(liquidityStyleFor("DXFEED", "NVDA")).toBe(indexLiquidityStyle);
    // AAPL, the trader's standard: eight ticks a band, a quiet zone of sixteen, nothing under 800 shares.
    expect(aaplLiquidityStyle.defaultSettings).toMatchObject({ clusterRows: 8, quietBands: 16, minBandSize: 800, showPulled: true, levelFilter: "all", scaleMode: "auto" });
    expect(AAPL_PARAMS.settings).toEqual({ clusterRows: 8, quietBands: 16, minBandSize: 800, showPulled: true });
    // TSLA, the trader's standard: six ticks a band, a quiet zone of sixteen, nothing under 2,000 shares.
    expect(tslaLiquidityStyle.defaultSettings).toMatchObject({ clusterRows: 6, quietBands: 16, minBandSize: 2_000, showPulled: true, levelFilter: "all", scaleMode: "auto" });
    expect(TSLA_PARAMS.settings).toEqual({ clusterRows: 6, quietBands: 16, minBandSize: 2_000, showPulled: true });
    expect(liquidityStyleFor("DXFEED", "/RTYU26:XCME")).toBe(indexLiquidityStyle);
    expect(liquidityStyleFor("DXFEED")).toBe(indexLiquidityStyle);
    expect([esLiquidityStyle.name, nqLiquidityStyle.name, indexLiquidityStyle.name, cryptoLiquidityStyle.name, btcLiquidityStyle.name, ethLiquidityStyle.name]).toEqual(["es", "nq", "index", "crypto", "btc", "eth"]);
  });
});

describe("default settings per market", () => {
  it("gives each market what it starts from: BTC's bands, one tick on an index, the trader's own NQ", () => {
    // The fallback is the shared default, untouched.
    expect(cryptoLiquidityStyle.defaultSettings).toEqual(DEFAULT_LIQUIDITY_SETTINGS);
    // BTC spot, the trader's standard of 2026-09-11: three rows a band (about $12), a quiet zone of a hundred, nothing under 8 BTC.
    expect(btcLiquidityStyle.defaultSettings).toMatchObject({ clusterRows: 3, quietBands: 100, minBandSize: 8, showPulled: true, levelFilter: "all", scaleMode: "auto" });
    expect(BTC_PARAMS.settings).toEqual({ clusterRows: 3, quietBands: 100, minBandSize: 8, showPulled: true });
    // The two crypto pairs keep their own bands: three rows on BTC (about $12), four on ETH (about $0.50).
    expect(btcLiquidityStyle.defaultSettings.clusterRows).not.toBe(ethLiquidityStyle.defaultSettings.clusterRows);
    expect(btcLiquidityStyle.defaultSettings.quietBands).not.toBe(ethLiquidityStyle.defaultSettings.quietBands);
    // ETH spot, the trader's standard of 2026-09-11: ten rows a band (about $1.30), a quiet zone of sixteen, nothing under 10 ETH.
    expect(ethLiquidityStyle.defaultSettings).toMatchObject({ clusterRows: 10, quietBands: 16, minBandSize: 10, showPulled: true, levelFilter: "all", scaleMode: "auto" });
    expect(ETH_PARAMS.settings).toEqual({ clusterRows: 10, quietBands: 16, minBandSize: 10, showPulled: true });
    expect(ethLiquidityStyle.defaultSettings.bidColor).toBe(DEFAULT_LIQUIDITY_SETTINGS.bidColor);
    // An index row is a tick, so a band starts at one; nothing else moves.
    expect(indexLiquidityStyle.defaultSettings).toMatchObject({ clusterRows: 1, quietBands: 16, minBandSize: 0 });
    // ES, as the trader set it: one tick, nothing under twenty contracts, pulled levels shown.
    expect(esLiquidityStyle.defaultSettings).toMatchObject({ clusterRows: 3, quietBands: 16, minBandSize: 50, showPulled: true, levelFilter: "all", scaleMode: "auto" });
    expect(ES_PARAMS.settings).toEqual({ clusterRows: 3, quietBands: 16, minBandSize: 50, showPulled: true });
    // The two futures keep their own numbers: ES reads three ticks and hides anything under fifty, NQ twelve ticks and twenty.
    expect(esLiquidityStyle.defaultSettings.minBandSize).not.toBe(nqLiquidityStyle.defaultSettings.minBandSize);
    // NQ, the trader's standard of 2026-09-11: twelve ticks a band, nothing under twenty contracts.
    expect(nqLiquidityStyle.defaultSettings).toMatchObject({ clusterRows: 12, quietBands: 16, minBandSize: 20, levelFilter: "all", showPulled: true, scaleMode: "auto" });
    expect(NQ_PARAMS.settings).toEqual({ clusterRows: 12, quietBands: 16, minBandSize: 20, showPulled: true });
    // The rest of the shared defaults come through untouched.
    expect(nqLiquidityStyle.defaultSettings.bidColor).toBe(DEFAULT_LIQUIDITY_SETTINGS.bidColor);
    expect(nqLiquidityStyle.defaultSettings.maxOpacity).toBe(DEFAULT_LIQUIDITY_SETTINGS.maxOpacity);
    // Every style carries one, so "Reset to default" always has somewhere to go.
    for (const style of [cryptoLiquidityStyle, btcLiquidityStyle, btcPerpLiquidityStyle, ethLiquidityStyle, ethPerpLiquidityStyle, esLiquidityStyle, nqLiquidityStyle, aaplLiquidityStyle, tslaLiquidityStyle, indexLiquidityStyle]) {
      expect(style.defaultSettings.clusterRows).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("crypto style (as it was)", () => {
  it("draws every crypto pair the same way: BTC and ETH differ only in where their settings start", () => {
    for (const style of [btcLiquidityStyle, btcPerpLiquidityStyle, ethLiquidityStyle, ethPerpLiquidityStyle]) {
      for (const key of ["bandSizes", "typicalBand", "paintFloor", "saturationAt", "wallSize", "alphaOf", "ageFactor", "bandSpan", "ladderText", "hoverWords", "ladderNumbers", "market"] as const) {
        expect(String(style[key])).toBe(String(cryptoLiquidityStyle[key]));
      }
      expect(style.defaultSettings).not.toEqual(cryptoLiquidityStyle.defaultSettings);
    }
  });


  it("sums the rows of a band and takes the typical band as the median row times the cluster", () => {
    expect(cryptoLiquidityStyle.bandSizes).toBe(bandSizes);
    expect(cryptoLiquidityStyle.typicalBand(column(40, 8), auto)).toBe(16);
    expect(cryptoLiquidityStyle.typicalBand(column(40), auto)).toBe(40); // no median: half the reference, times two rows
    expect(cryptoLiquidityStyle.typicalBand(column(), auto)).toBe(6);
  });

  it("paints from the heat-floor share of the typical row, per row of the band, as it always did", () => {
    expect(cryptoPaintFloor(column(6), auto)).toBeCloseTo(0.4 * 6 * 2);
    expect(cryptoPaintFloor(column(40, 20), auto)).toBeCloseTo(0.4 * 40 * 2); // the median plays no part
    expect(cryptoPaintFloor(column(), auto)).toBeCloseTo(0.4 * 6 * 2); // no column reference: the live one
    expect(cryptoPaintFloor(column(40), fixed)).toBeCloseTo(0.4 * 10 * 2);
    expect(cryptoPaintFloor(column(40), fixedWideRows)).toBeCloseTo(0.4 * 20 * 2);
    expect(cryptoLiquidityStyle.paintFloor).toBe(cryptoPaintFloor);
  });

  it("colours against the largest level in view, or half the typical band when that is larger", () => {
    expect(cryptoSaturation(column(6), auto)).toBe(73);
    expect(cryptoSaturation(column(6), { ...auto, ladderMax: 0, reference: 100 })).toBe(100);
    // The column's own reference plays no part here: the scale is live.
    expect(cryptoSaturation(column(999), auto)).toBe(73);
    expect(cryptoSaturation(column(6), fixed)).toBe(20);
    expect(cryptoSaturation(column(6), fixedWideRows)).toBe(40);
  });

  it("darkens a run from 80% at birth to full at fifteen minutes", () => {
    expect(ageFactor(0)).toBe(AGE_ALPHA_MIN);
    expect(ageFactor(LEVEL_MATURE_MS / 2)).toBeCloseTo(AGE_ALPHA_MIN + (1 - AGE_ALPHA_MIN) / 2);
    expect(ageFactor(LEVEL_MATURE_MS)).toBe(1);
    expect(ageFactor(10 * LEVEL_MATURE_MS)).toBe(1);
    expect(ageFactor(-5)).toBe(AGE_ALPHA_MIN);
    expect(cryptoLiquidityStyle.ageFactor(0)).toBe(AGE_ALPHA_MIN);
  });

  it("brightens as size^gamma under the opacity setting, ignores floor and median, and thickens a band with size from a quarter of its row", () => {
    expect(cryptoAlpha(1, DEFAULT_LIQUIDITY_SETTINGS)).toBeCloseTo(0.6 * 255);
    expect(cryptoAlpha(0.5, DEFAULT_LIQUIDITY_SETTINGS)).toBeCloseTo(0.6 * 255 * 0.5 ** LIQUIDITY_GAMMA);
    expect(cryptoAlpha(0, DEFAULT_LIQUIDITY_SETTINGS)).toBe(0);
    const context = { settings: DEFAULT_LIQUIDITY_SETTINGS, paint: 5, saturation: 73, median: 8 };
    expect(cryptoLiquidityStyle.alphaOf(36.5, context)).toBeCloseTo(cryptoAlpha(0.5, DEFAULT_LIQUIDITY_SETTINGS));
    expect(cryptoLiquidityStyle.alphaOf(36.5, { ...context, paint: 30, median: 30 })).toBeCloseTo(cryptoAlpha(0.5, DEFAULT_LIQUIDITY_SETTINGS));
    expect(cryptoLiquidityStyle.alphaOf(200, context)).toBeCloseTo(0.6 * 255);
    expect(cryptoLiquidityStyle.bandSpan(0, 20)).toEqual({ offset: Math.floor((20 - 20 * BAND_MIN_SHARE) / 2), size: 20 * BAND_MIN_SHARE });
    expect(cryptoLiquidityStyle.bandSpan(1, 20)).toEqual({ offset: 0, size: 20 });
  });

  it("puts coins beside the axis and size, peak and unit in the tooltip", () => {
    expect(cryptoLiquidityStyle.ladderNumbers).toBe(true);
    expect(cryptoLiquidityStyle.ladderText(73, "BTC")).toBe("73.0");
    expect(cryptoLiquidityStyle.ladderText(0.4237, "BTC")).toBe("0.42");
    expect(cryptoHoverWords(73, 80, "BTC")).toEqual({ label: "73.0 BTC", peakLabel: "80.0", detail: "" });
    expect(cryptoHoverWords(73, 73, "BTC")).toEqual({ label: "73.0 BTC", peakLabel: "", detail: "" });
    expect(cryptoHoverWords(0, 0, "BTC")).toEqual({ label: "", peakLabel: "", detail: "" });
  });
});

describe("index machinery (dxFeed futures and equities)", () => {
  it("paints only what stands above typical: the higher of the heat floor, 1.25x the median row and 0.6x the 95th percentile", () => {
    const floor = indexPaintFloorWith(INDEX_DEFAULTS);
    expect(INDEX_DEFAULTS.typicalFloorMultiple).toBe(1.25);
    expect(INDEX_DEFAULTS.referenceFloorShare).toBe(0.6);
    // ES as measured (p95 50, median 25), one row per band: 1.25 x 25 = 31.25 beats 0.6 x 50 = 30 and 0.4 x 50 = 20.
    expect(floor(column(50, 25), { ...auto, clusterRows: 1 })).toBeCloseTo(31.25);
    // NQ as measured (p95 7, median 2): 0.6 x 7 = 4.2 beats 1.25 x 2 = 2.5.
    expect(floor(column(7, 2), { ...auto, clusterRows: 1 })).toBeCloseTo(4.2);
    // The cluster plays no part: a band is read by its biggest row.
    expect(floor(column(7, 2), auto)).toBeCloseTo(4.2);
    expect(floor(column(7, 2), { ...auto, clusterRows: 8 })).toBeCloseTo(4.2);
    // No median on the column: half the reference stands in; no reference: the live one.
    expect(floor(column(50), { ...auto, clusterRows: 1 })).toBeCloseTo(Math.max(20, 1.25 * 25, 30));
    expect(floor(column(), { ...auto, clusterRows: 1 })).toBeCloseTo(Math.max(0.4 * 6, 1.25 * 3, 0.6 * 6));
    // A fixed scale is the trader's own yardstick and keeps the plain heat floor, per row.
    expect(floor(column(50, 25), fixed)).toBeCloseTo(0.4 * 10);
    expect(floor(column(50, 25), fixedWideRows)).toBeCloseTo(0.4 * 20);
    expect(indexLiquidityStyle.paintFloor(column(50, 25), { ...auto, clusterRows: 1 })).toBeCloseTo(31.25);
  });

  it("tops the colour out at the column's ceiling, the biggest row near price smoothed over half an hour, never under the server's wall threshold; a fixed scale is the trader's size", () => {
    const saturation = indexSaturationWith(INDEX_DEFAULTS);
    // NQ as measured 2026-10-11: 95th percentile 10, the biggest row near price about 60 in the day session.
    expect(saturation(column(10, 2, 60), auto)).toBe(60);
    expect(saturation(column(10, 2, 60), { ...auto, clusterRows: 8, ladderMax: 5000 })).toBe(60);
    // A column whose ceiling has not caught up with its own book (the first columns after a reset) reads the threshold.
    expect(saturation(column(47, 25, 20), auto)).toBeCloseTo(70.5);
    // A column without a ceiling (an older store) reads the threshold, as before.
    expect(saturation(column(47, 25), auto)).toBeCloseTo(70.5);
    expect(saturation(column(), auto)).toBeCloseTo(9);
    expect(saturation(column(0, 0, 0), auto)).toBeCloseTo(9);
    expect(saturation(column(40, 20, 300), fixed)).toBe(10);
    expect(saturation(column(40, 20, 300), fixedWideRows)).toBe(20);
    expect(indexLiquidityStyle.saturationAt(column(10, 2, 60), auto)).toBe(60);
  });

  it("reads a band by its biggest row and anchors on the typical row", () => {
    expect(indexLiquidityStyle.bandSizes).toBe(bandMaxSizes);
    expect(indexTypicalRow(column(40, 8), auto)).toBe(8);
    expect(indexTypicalRow(column(40), auto)).toBe(20);
    expect(indexTypicalRow(column(), auto)).toBe(3);
    expect(indexLiquidityStyle.typicalBand(column(40, 8), { ...auto, clusterRows: 8 })).toBe(8);
  });

  it("shades a level by its share of the ceiling, size^gamma like crypto, and thickens it from a quarter of its row to the whole row", () => {
    const alpha = indexAlphaWith(INDEX_DEFAULTS);
    const settings = DEFAULT_LIQUIDITY_SETTINGS;
    expect(INDEX_DEFAULTS.rampGamma).toBe(LIQUIDITY_GAMMA);
    // NQ as measured: floor 6, ceiling 60: a 30-lot is half the ceiling, a 60-lot the ceiling, a 150-lot no darker.
    const nq = { settings, paint: 6, saturation: 60, median: 2 };
    expect(alpha(0, nq)).toBe(0);
    expect(alpha(-5, nq)).toBe(0);
    expect(alpha(30, nq) / FULL).toBeCloseTo(0.5 ** LIQUIDITY_GAMMA);
    expect(alpha(60, nq) / FULL).toBeCloseTo(1);
    expect(alpha(150, nq) / FULL).toBeCloseTo(1);
    expect(alpha(20, nq)).toBeLessThan(alpha(30, nq));
    expect(alpha(30, nq)).toBeLessThan(alpha(50, nq));
    // The floor and the typical band say what is drawn, never how dark.
    expect(alpha(30, { ...nq, paint: 20, median: 25 })).toBe(alpha(30, nq));
    // The boost never pushes past opaque; no ceiling, nothing drawn.
    expect(alpha(1000, { ...nq, settings: { ...settings, maxOpacity: 0.9 } })).toBe(255);
    expect(alpha(30, { ...nq, saturation: 0 })).toBe(0);
    expect(indexLiquidityStyle.bandSpan).toBe(bandSpan);
    expect(indexLiquidityStyle.bandSpan(0, 20)).toEqual({ offset: Math.floor((20 - 20 * BAND_MIN_SHARE) / 2), size: 20 * BAND_MIN_SHARE });
    expect(indexLiquidityStyle.bandSpan(0.5, 20)).toEqual(bandSpan(0.5, 20));
    expect(indexLiquidityStyle.bandSpan(1, 20)).toEqual({ offset: 0, size: 20 });
  });

  it("never ages a cell, and counts contracts or shares on the axis and in the tooltip", () => {
    expect(indexLiquidityStyle.ageFactor(0)).toBe(1);
    expect(indexLiquidityStyle.ageFactor(60 * 60_000)).toBe(1);
    expect(indexLiquidityStyle.ladderNumbers).toBe(true);
    expect(indexLiquidityStyle.ladderText(96, "contracts")).toBe("96");
    expect(indexLiquidityStyle.ladderText(7.4, "contracts")).toBe("7");
    expect(indexLiquidityStyle.ladderText(12_500, "shares")).toBe("12.5k");
    expect(indexLiquidityStyle.ladderText(0, "shares")).toBe("");
    expect(indexLiquidityStyle.hoverWords(96, 103, "contracts")).toEqual({ label: "96 contracts", peakLabel: "103", detail: "" });
    expect(indexLiquidityStyle.hoverWords(96, 96, "contracts")).toEqual({ label: "96 contracts", peakLabel: "", detail: "" });
    expect(indexLiquidityStyle.hoverWords(0, 0, "shares")).toEqual({ label: "", peakLabel: "", detail: "" });
    for (const style of [esLiquidityStyle, nqLiquidityStyle, aaplLiquidityStyle, tslaLiquidityStyle]) {
      expect(style.ladderNumbers).toBe(true);
      expect(style.ladderText(42, "contracts")).toBe("42");
    }
    const custom = createIndexStyle({ ...INDEX_DEFAULTS, name: "custom", rampGamma: 1 });
    expect(custom.name).toBe("custom");
    expect(custom.alphaOf(30, { settings: DEFAULT_LIQUIDITY_SETTINGS, paint: 6, saturation: 60, median: 2 }) / FULL).toBeCloseTo(0.5);
  });
});

describe("ES and NQ tunings", () => {
  it("every index instrument shades the same way; the files differ in the trader's settings and the absorption wall", () => {
    expect(ES_PARAMS).toMatchObject({ name: "es", saturationMultiple: 1.5, monsterMultiple: 2 });
    expect(NQ_PARAMS).toMatchObject({ name: "nq", saturationMultiple: 1.5, monsterMultiple: 4 });
    for (const params of [ES_PARAMS, NQ_PARAMS, AAPL_PARAMS, TSLA_PARAMS]) {
      expect(params.rampGamma).toBe(INDEX_DEFAULTS.rampGamma);
      expect(params.opacityBoost).toBe(INDEX_DEFAULTS.opacityBoost);
      expect(Object.keys(params).sort()).toEqual(Object.keys(INDEX_DEFAULTS).sort());
    }
    const settings = DEFAULT_LIQUIDITY_SETTINGS;
    // ES as measured 2026-10-11: 95th percentile 53 in the day, the biggest row near price about 170.
    const es = { settings, paint: 37.6, saturation: 170, median: 48 };
    expect(esLiquidityStyle.alphaOf(85, es) / FULL).toBeCloseTo(0.5 ** LIQUIDITY_GAMMA);
    expect(esLiquidityStyle.alphaOf(170, es) / FULL).toBeCloseTo(1);
    expect(esLiquidityStyle.alphaOf(85, es)).toBe(nqLiquidityStyle.alphaOf(85, es));
    expect(esLiquidityStyle.saturationAt(column(53, 24, 170), auto)).toBe(170);
    expect(nqLiquidityStyle.saturationAt(column(10, 2, 60), auto)).toBe(60);
  });
});

describe("the wall size an absorption is measured against", () => {
  it("names the wall size an absorption is measured against: the full-dark row on an index book, the paint floor on crypto", () => {
    // An index book shows a tenth of what trades: only its full-dark row (the monster multiple of the wall threshold)
    // is a wall. ES: 2 x 1.5 x 47; NQ: 4 x 1.5 x 47; the generic index 4 x 1.5 x 10. Crypto paints most of what rests
    // and its paint floor is the wall, the same function.
    expect(esLiquidityStyle.wallSize(column(47, 25), auto)).toBeCloseTo(141);
    expect(nqLiquidityStyle.wallSize(column(47, 25), auto)).toBeCloseTo(282);
    expect(createIndexStyle(INDEX_DEFAULTS).wallSize(column(10), auto)).toBeCloseTo(60);
    expect(createIndexStyle(INDEX_DEFAULTS).wallSize(column(10), { ...auto, settings: { ...auto.settings, scaleMode: "fixed", scaleSize: 30 }, reference: 30 })).toBeCloseTo(120);
    expect(cryptoLiquidityStyle.wallSize).toBe(cryptoPaintFloor);
    expect(btcPerpLiquidityStyle.wallSize(column(50), { ...auto, clusterRows: 10, reference: 50 })).toBe(btcPerpLiquidityStyle.paintFloor(column(50), { ...auto, clusterRows: 10, reference: 50 }));
  });
});
