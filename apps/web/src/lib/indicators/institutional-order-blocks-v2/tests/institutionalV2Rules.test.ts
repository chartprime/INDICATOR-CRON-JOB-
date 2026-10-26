import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTITUTIONAL_V2_SETTINGS,
  HOLE_MS,
  STRONG_HOLD_MS,
  absorbedShare,
  bandRowsFor,
  earnsGuard,
  freshnessOf,
  gradeOf,
  gradeWhileStanding,
  isShownGrade,
  barTouches,
  staysOnChart,
  minSizeFor,
  minSizeOf,
  sizeUnitFor,
  strongSizeFor,
  wallScore,
  wallSizeFor,
  SCORE_STANDING_MS,
  type Wall,
  historyHoursOf,
} from "../institutionalV2Rules";
import { institutionalOrderBlocksV2Indicator } from "../institutionalOrderBlocksV2";
import { INSTITUTIONAL_V2_SETTINGS_SCHEMA } from "../institutionalV2Schema";
import { instrumentKey } from "../../../chart/drawingStore";

const T = 1_700_000_000_000;

function wall(overrides: Partial<Wall> = {}): Wall {
  return { side: "bid", band: 19000, bandRows: 4, startTs: T, resumedTs: T, peak: 500, current: 320, low: 320, eaten: 310, refills: 0, refilled: 0, crossedTs: T + 600_000, atStrongSize: false, reachedStrongSize: false, guarded: false, endTs: null, endReason: null, ...overrides };
}

describe("gradeOf", () => {
  it("is weak until sixty percent of the peak has traded into the wall", () => {
    expect(gradeOf(wall({ crossedTs: null }), T + 3_600_000)).toBe("weak");
  });

  it("is weak while the ten minutes after the crossing are still running, and strong the moment they are up", () => {
    const crossed = T + 600_000;
    expect(gradeOf(wall({ crossedTs: crossed }), crossed + STRONG_HOLD_MS - 1)).toBe("weak");
    expect(gradeOf(wall({ crossedTs: crossed }), crossed + STRONG_HOLD_MS)).toBe("strong");
    expect(gradeOf(wall({ crossedTs: crossed }), crossed + 3_600_000)).toBe("strong");
  });

  it("runs the clock from the crossing, not from the wall's birth", () => {
    // Born an hour ago, crossed a minute ago: not strong, however old the wall is.
    expect(gradeOf(wall({ startTs: T - 3_600_000, crossedTs: T - 60_000 }), T)).toBe("weak");
  });

  it("is never strong once the wall has ended, whatever it earned before", () => {
    expect(gradeOf(wall({ crossedTs: T, endTs: T + 3_600_000 }), T + 7_200_000)).toBe("weak");
  });

  it("is strong on size when the tracker says the wall holds it now, tested or not, and never once ended", () => {
    const untouched = wall({ crossedTs: null, eaten: 0, atStrongSize: true });
    expect(gradeOf(untouched, T)).toBe("strong");
    expect(gradeOf({ ...untouched, atStrongSize: false }, T)).toBe("weak");
    expect(gradeOf({ ...untouched, endTs: T }, T + 1)).toBe("weak");
  });

  it("reads strong on size from what the wall holds, never from its peak", () => {
    // Once 5,000, now 100 and not at size: weak. Never more than 10 but at size now: strong.
    expect(gradeOf(wall({ crossedTs: null, eaten: 0, peak: 5000, current: 100, atStrongSize: false }), T)).toBe("weak");
    expect(gradeOf(wall({ crossedTs: null, eaten: 0, peak: 10, current: 10, atStrongSize: true }), T)).toBe("strong");
  });

  it("holds strong by absorption whatever the wall holds, down to nothing: the size is the chart's business, not the grade's", () => {
    // The trader's rule of 2026-09-20, replacing the wall-size floor of that morning: a tested wall stays strong until a
    // bar closes through it, and the chart stops drawing it only when nothing rests. The ETH perp ask of 2026-09-19 --
    // eaten past its peak of 1,100, standing at 88 -- is strong at 88, and at 1, and at 0.
    const held = T + 600_000 + STRONG_HOLD_MS;
    for (const current of [320, 88, 1, 0]) expect(gradeOf(wall({ peak: 1100, eaten: 1100, current }), held)).toBe("strong");
    expect(gradeWhileStanding(wall({ peak: 1100, eaten: 1100, current: 0 }), held)).toBe("strong");
    // Not before the hold is up, whatever it holds.
    expect(gradeOf(wall({ peak: 1100, eaten: 1100, current: 1100 }), held - 1)).toBe("weak");
  });

  it("keeps a guarded wall strong whatever its size and however its crossing stands, and not once ended", () => {
    const guarded = wall({ guarded: true, crossedTs: null, current: 0, peak: 5000 });
    expect(gradeOf(guarded, T)).toBe("strong");
    expect(gradeOf({ ...guarded, endTs: T }, T + 1)).toBe("weak");
    expect(gradeWhileStanding({ ...guarded, endTs: T }, T)).toBe("strong");
  });
});

describe("earnsGuard", () => {
  it("is earned by a wall that reached the strong size with a quarter of its peak traded into it, and not on a touch", () => {
    // At the strong size with a quarter of its 5,000 peak eaten: guarded. One under a quarter, or a single print: not.
    const bySize = wall({ crossedTs: null, atStrongSize: true, reachedStrongSize: true, peak: 5000, current: 5000, eaten: 1250 });
    expect(earnsGuard(bySize)).toBe(true);
    expect(earnsGuard({ ...bySize, eaten: 1249 })).toBe(false);
    expect(earnsGuard({ ...bySize, eaten: 1 })).toBe(false);
  });

  it("is never earned by crossing and holding alone: strong by absorption is its own door, and the guard is the strong size's", () => {
    // Crossed and held: strong, and not guarded, whatever it holds. The guard's difference is the endings it survives
    // (the window, a long hole), not the grade.
    const crossed = T + 600_000;
    expect(gradeOf(wall({ crossedTs: crossed }), crossed + STRONG_HOLD_MS)).toBe("strong");
    expect(earnsGuard(wall({ crossedTs: crossed }))).toBe(false);
    expect(earnsGuard(wall({ crossedTs: crossed, peak: 1100, eaten: 1100, current: 88 }))).toBe(false);
  });

  it("is earned on the size the wall reached, though the absorbing has since taken it: the two need not hold at once", () => {
    // The ETH perp wall of 2026-09-19: 5,318 at its peak, eaten to 1,900 with 35% of it traded in, at the size no longer.
    const consumed = wall({ crossedTs: null, atStrongSize: false, reachedStrongSize: true, peak: 5318, current: 1900, eaten: 1870 });
    expect(earnsGuard(consumed)).toBe(true);
    // A quarter is still the bar, and a wall that never reached the size earns nothing, at size now or not.
    expect(earnsGuard({ ...consumed, eaten: 1329 })).toBe(false);
    expect(earnsGuard({ ...consumed, reachedStrongSize: false })).toBe(false);
    expect(earnsGuard({ ...consumed, reachedStrongSize: false, atStrongSize: true })).toBe(false);
  });
});

describe("gradeWhileStanding", () => {
  it("is the grade the wall held at a moment, ended or not, so a mitigated wall is drawn as what it was when closed through", () => {
    const ended = wall({ crossedTs: T, endTs: T + STRONG_HOLD_MS + 60_000 });
    expect(gradeOf(ended, T + STRONG_HOLD_MS + 60_000)).toBe("weak");
    expect(gradeWhileStanding(ended, T + STRONG_HOLD_MS + 60_000)).toBe("strong");
    expect(gradeWhileStanding(ended, T + STRONG_HOLD_MS - 1)).toBe("weak");
  });
});

describe("freshnessOf", () => {
  it("is fresh with nothing traded in and tested once anything has, however little", () => {
    expect(freshnessOf(wall({ eaten: 0 }))).toBe("fresh");
    expect(freshnessOf(wall({ eaten: 0.001 }))).toBe("tested");
  });
});

describe("absorbedShare", () => {
  it("is what has traded in over the most the wall held, and nothing over no peak", () => {
    expect(absorbedShare(wall({ eaten: 310, peak: 500 }))).toBeCloseTo(0.62, 6);
    expect(absorbedShare(wall({ eaten: 0, peak: 0 }))).toBe(0);
  });
});

describe("wallScore", () => {
  // The client's ask of 2026-09-20: one number out of 100 on the card in place of the absorbed size, the refills and
  // the age, so the mechanics stay out of sight. Size 40, defence 30, refill 20, standing 10, each a share of its cap.
  const STRONG_SIZE = 200;

  it("gives full marks to a wall at the strong size that ate a quarter of its peak, refilled its peak and stood half an hour", () => {
    expect(wallScore(wall({ current: 200, peak: 400, eaten: 100, refilled: 400, startTs: T - SCORE_STANDING_MS }), STRONG_SIZE, T)).toBe(100);
  });

  it("scores each part as a share of its cap: size against the strong size, defence against a quarter of the peak, refill against the peak, standing against half an hour", () => {
    const bare = wall({ current: 0, peak: 400, eaten: 0, refilled: 0, startTs: T });
    expect(wallScore(bare, STRONG_SIZE, T)).toBe(0);
    expect(wallScore({ ...bare, current: 100 }, STRONG_SIZE, T)).toBe(20);
    expect(wallScore({ ...bare, eaten: 50 }, STRONG_SIZE, T)).toBe(15);
    expect(wallScore({ ...bare, refilled: 100 }, STRONG_SIZE, T)).toBe(5);
    expect(wallScore(bare, STRONG_SIZE, T + SCORE_STANDING_MS / 2)).toBe(5);
    expect(wallScore({ ...bare, current: 100, eaten: 50, refilled: 100 }, STRONG_SIZE, T + SCORE_STANDING_MS / 2)).toBe(45);
  });

  it("caps every part, so a wall twice the strong size that ate itself whole and refilled twice over is still 100", () => {
    expect(wallScore(wall({ current: 400, peak: 400, eaten: 400, refilled: 800, startTs: T - 10 * SCORE_STANDING_MS }), STRONG_SIZE, T)).toBe(100);
    expect(wallScore(wall({ current: 400, peak: 400, eaten: 0, refilled: 0, startTs: T }), STRONG_SIZE, T)).toBe(40);
  });

  it("rounds to a whole number, and reads the age from the level's first birth, not this life", () => {
    // 85 of 200 is 17; 320 of a 1,240 peak is 25.8%, the quarter and more; 31 minutes is the full 10.
    expect(wallScore(wall({ current: 85, peak: 1240, eaten: 320, refilled: 0, startTs: T - 31 * 60_000, resumedTs: T - 60_000 }), STRONG_SIZE, T)).toBe(57);
    // A third of the size is 13.33, a tenth of the age 1: 14.33 reads 14.
    expect(wallScore(wall({ current: 66.67, peak: 400, eaten: 0, refilled: 0, startTs: T - SCORE_STANDING_MS / 10 }), STRONG_SIZE, T)).toBe(14);
  });

  it("scores nothing for size on a book with no strong size, and nothing for defence or refill on no peak", () => {
    expect(wallScore(wall({ current: 500, peak: 400, eaten: 0, refilled: 0, startTs: T }), Infinity, T)).toBe(0);
    expect(wallScore(wall({ current: 0, peak: 0, eaten: 0, refilled: 0, startTs: T }), STRONG_SIZE, T)).toBe(0);
  });

  it("stands at half an hour", () => {
    expect(SCORE_STANDING_MS).toBe(30 * 60_000);
  });
});

describe("strongSizeFor", () => {
  it("gives each instrument the size that makes a wall strong on its own: the trader's numbers, and the typical wall elsewhere", () => {
    expect(strongSizeFor(bn("BTC-USDT", "PERPETUAL"))).toBe(200);
    expect(strongSizeFor(bn("BTC-USDT", "SPOT"))).toBe(80);
    expect(strongSizeFor(bn("ETH-USDT", "PERPETUAL"))).toBe(5000);
    expect(strongSizeFor(bn("ETH-USDT", "SPOT"))).toBe(1200);
    // The December contracts, measured on 2026-09-21 in the first half hour of the cash session: a typical wall of
    // 109 on NQ and 350 on ES, three times September's after the roll; the trader rounded them to 100 and 300.
    expect(strongSizeFor(dx("/NQZ26:XCME", "FUTURE"))).toBe(100);
    expect(strongSizeFor(dx("/MNQZ26:XCME", "FUTURE"))).toBe(100);
    expect(strongSizeFor(dx("/ESZ26:XCME", "FUTURE"))).toBe(300);
    expect(strongSizeFor(dx("AAPL", "EQUITY"))).toBe(10_000);
    expect(strongSizeFor(dx("NVDA", "EQUITY"))).toBe(100_000);
    expect(strongSizeFor(dx("TSLA", "EQUITY"))).toBe(23_000);
  });

  it("leaves an unmeasured pair or future with no such door", () => {
    expect(strongSizeFor(bn("SOL-USDT", "PERPETUAL"))).toBe(Infinity);
    expect(strongSizeFor(dx("/CLU26:XNYM", "FUTURE"))).toBe(Infinity);
  });
});

describe("HOLE_MS", () => {
  it("bridges the gaps the live feeds showed, most under four minutes, and ends walls past ten", () => {
    expect(HOLE_MS).toBe(600_000);
  });
});

// The two shapes of the identity union, built as v1 builds them: no cast, so the build's stricter tsc accepts them.
const dx = (symbol: string, assetClass: "EQUITY" | "FUTURE") => ({ symbol, provider: "DXFEED" as const, assetClass });
const bn = (symbol: string, marketKind: "SPOT" | "PERPETUAL") => ({ symbol, provider: "BINANCE" as const, marketKind });

describe("bandRowsFor", () => {
  it("gives each instrument the width the signal was measured at", () => {
    expect(bandRowsFor(bn("BTC-USDT", "PERPETUAL"))).toBe(4);
    expect(bandRowsFor(bn("BTC-USDT", "SPOT"))).toBe(4);
    expect(bandRowsFor(bn("ETH-USDT", "PERPETUAL"))).toBe(8);
    expect(bandRowsFor(dx("/NQU26:XCME", "FUTURE"))).toBe(12);
    expect(bandRowsFor(dx("/MNQU26:XCME", "FUTURE"))).toBe(12);
    expect(bandRowsFor(dx("/ESU26:XCME", "FUTURE"))).toBe(3);
    expect(bandRowsFor(dx("AAPL", "EQUITY"))).toBe(8);
    expect(bandRowsFor(dx("TSLA", "EQUITY"))).toBe(6);
    expect(bandRowsFor(dx("NVDA", "EQUITY"))).toBe(5);
  });

  it("falls back to four rows on an unmeasured crypto pair and three on an unmeasured future", () => {
    expect(bandRowsFor(bn("SOL-USDT", "PERPETUAL"))).toBe(4);
    expect(bandRowsFor(dx("/CLU26:XNYM", "FUTURE"))).toBe(3);
  });
});

describe("wallSizeFor", () => {
  it("gives each instrument the floor the signal was measured against", () => {
    expect(wallSizeFor(bn("BTC-USDT", "PERPETUAL"))).toBe(50);
    expect(wallSizeFor(bn("BTC-USDT", "SPOT"))).toBe(10);
    expect(wallSizeFor(bn("ETH-USDT", "PERPETUAL"))).toBe(600);
    expect(wallSizeFor(bn("ETH-USDT", "SPOT"))).toBe(180);
    // About a third of the strong size on the December contracts, as elsewhere; 10 stays for a future not measured.
    expect(wallSizeFor(dx("/NQZ26:XCME", "FUTURE"))).toBe(35);
    expect(wallSizeFor(dx("/ESZ26:XCME", "FUTURE"))).toBe(90);
    expect(wallSizeFor(dx("/MESZ26:XCME", "FUTURE"))).toBe(90);
    expect(wallSizeFor(dx("/CLZ26:XNYM", "FUTURE"))).toBe(10);
    expect(wallSizeFor(dx("AAPL", "EQUITY"))).toBe(1000);
  });

  it("falls back to ten on an unmeasured pair or future", () => {
    expect(wallSizeFor(bn("SOL-USDT", "SPOT"))).toBe(10);
    expect(wallSizeFor(dx("/CLU26:XNYM", "FUTURE"))).toBe(10);
  });
});

describe("minSizeFor", () => {
  it("gives each instrument the size under which a wall is not worth the chart, NQ half its strong size and ES its strong size as the trader set them, and an unmeasured one its wall floor", () => {
    expect(minSizeFor(bn("BTC-USDT", "PERPETUAL"))).toBe(150);
    expect(minSizeFor(bn("BTC-USDT", "SPOT"))).toBe(20);
    expect(minSizeFor(bn("ETH-USDT", "PERPETUAL"))).toBe(2400);
    expect(minSizeFor(bn("ETH-USDT", "SPOT"))).toBe(360);
    expect(minSizeFor(dx("/NQZ26:XCME", "FUTURE"))).toBe(50);
    expect(minSizeFor(dx("/ESZ26:XCME", "FUTURE"))).toBe(300);
    expect(minSizeFor(dx("/CLZ26:XNYM", "FUTURE"))).toBe(10);
    expect(minSizeFor(dx("AAPL", "EQUITY"))).toBe(2000);
    expect(minSizeFor(dx("NVDA", "EQUITY"))).toBe(2000);
  });

  it("falls back to the wall floor on an unmeasured pair, so nothing that is a wall is hidden there", () => {
    expect(minSizeFor(bn("SOL-USDT", "PERPETUAL"))).toBe(10);
  });
});

describe("sizeUnitFor", () => {
  it("is the coin on Binance, contracts on the futures and shares on the equities", () => {
    expect(sizeUnitFor(bn("ETH-USDT", "PERPETUAL"))).toBe("ETH");
    expect(sizeUnitFor(bn("BTC-USDT", "SPOT"))).toBe("BTC");
    expect(sizeUnitFor(dx("/NQU26:XCME", "FUTURE"))).toBe("contracts");
    expect(sizeUnitFor(dx("AAPL", "EQUITY"))).toBe("shares");
  });
});

describe("barTouches", () => {
  it("is a bar whose range reaches the band, wick included, edges counting", () => {
    // Band 19000 at four rows of $4: 304,000 to 304,016.
    const w = wall();
    expect(barTouches(w, 4, 304_010, 304_012)).toBe(true);
    expect(barTouches(w, 4, 303_990, 304_000)).toBe(true);
    expect(barTouches(w, 4, 304_016, 304_030)).toBe(true);
    expect(barTouches(w, 4, 303_990, 303_999)).toBe(false);
    expect(barTouches(w, 4, 304_017, 304_030)).toBe(false);
    expect(barTouches(w, 4, 303_000, 305_000)).toBe(true);
  });
});

describe("staysOnChart", () => {
  // The trader's rule of 2026-09-21, after the 15m ETH chart stacked six bid walls a hundred dollars under a price that
  // had run away from them, holding 300 to 1,000 of the 2,400 they once held. A bar on the wall keeps it whatever it
  // holds, down to nothing; a bar away from it keeps it only over the floor.
  it("keeps a strong wall the bar is on while anything rests, and every other wall only at the floor and over, whatever its peak", () => {
    expect(staysOnChart(wall({ current: 1, peak: 5000 }), 150, true, "strong")).toBe(true);
    expect(staysOnChart(wall({ current: 0, peak: 5000 }), 150, true, "strong")).toBe(false);
    expect(staysOnChart(wall({ current: 149, peak: 5000 }), 150, false, "strong")).toBe(false);
    expect(staysOnChart(wall({ current: 150, peak: 150 }), 150, false, "strong")).toBe(true);
    expect(staysOnChart(wall({ current: 149, peak: 5000 }), 150, true, "weak")).toBe(false);
    expect(staysOnChart(wall({ current: 150, peak: 150 }), 150, true, "weak")).toBe(true);
    expect(staysOnChart(wall({ current: 1 }), 0, false, "weak")).toBe(true);
    expect(staysOnChart(wall({ current: 0 }), 0, false, "weak")).toBe(false);
  });
});

describe("minSizeOf", () => {
  const eth = bn("ETH-USDT", "PERPETUAL");
  const btc = bn("BTC-USDT", "PERPETUAL");

  it("is the instrument's own floor until the trader types one for that instrument, and that one never reaches another", () => {
    // The trader, 2026-09-20: "2500 should read 2500 ETH and hide any wall resting smaller than 2500" -- on the ETH perp,
    // and only there: 2,500 BTC on the BTC perp would hide its whole book.
    expect(minSizeOf(DEFAULT_INSTITUTIONAL_V2_SETTINGS, eth)).toBe(2400);
    expect(minSizeOf(DEFAULT_INSTITUTIONAL_V2_SETTINGS, btc)).toBe(150);
    const typed = { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, minSizeByInstrument: { [instrumentKey(eth)]: 2500 } };
    expect(minSizeOf(typed, eth)).toBe(2500);
    expect(minSizeOf(typed, btc)).toBe(150);
    expect(minSizeOf(typed, bn("ETH-USDT", "SPOT"))).toBe(360);
  });

  it("takes the typed floor whatever it is, at the wall size or under it, since the trader chose it", () => {
    expect(minSizeOf({ ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, minSizeByInstrument: { [instrumentKey(eth)]: 1 } }, eth)).toBe(1);
  });
});

describe("the size floor's field", () => {
  const eth = bn("ETH-USDT", "PERPETUAL");

  it("is what the definition hands the panel for the instrument, a custom field on that one key that asks for a replay", () => {
    const fields = institutionalOrderBlocksV2Indicator.settingsFieldsFor?.(eth);
    expect(fields && Object.keys(fields)).toEqual(["minSizeByInstrument"]);
    const field = fields?.minSizeByInstrument;
    expect(field?.kind).toBe("custom");
    expect(field?.kind === "custom" ? [field.key, field.affects] : []).toEqual(["minSizeByInstrument", "recompute"]);
  });

  it("keeps a stored map of positive whole sizes by instrument, and nothing else", () => {
    const field = INSTITUTIONAL_V2_SETTINGS_SCHEMA.find((f) => f.kind === "custom" && f.key === "minSizeByInstrument");
    const valid = field?.kind === "custom" ? field.isValidPersistedValue! : () => false;
    expect(valid({})).toBe(true);
    expect(valid({ [instrumentKey(eth)]: 2500 })).toBe(true);
    expect(valid({ [instrumentKey(eth)]: 2500.5 })).toBe(false);
    expect(valid({ [instrumentKey(eth)]: 0 })).toBe(false);
    expect(valid({ [instrumentKey(eth)]: "2500" })).toBe(false);
    expect(valid([2500])).toBe(false);
    expect(valid(null)).toBe(false);
    expect(valid(2500)).toBe(false);
  });
});

describe("settings", () => {
  const btc = bn("BTC-USDT", "PERPETUAL");

  it("caps the History reach at a week and starts at two days", () => {
    expect(historyHoursOf(DEFAULT_INSTITUTIONAL_V2_SETTINGS)).toBe(48);
    expect(historyHoursOf({ historyHours: 500 })).toBe(168);
    expect(historyHoursOf({ historyHours: 0 })).toBe(0);
    expect(historyHoursOf({ historyHours: Number.NaN })).toBe(48);
    expect(historyHoursOf(undefined)).toBe(48);
  });

  it("offers the trader nothing that changes what a wall is: no width, no sizes, only what is drawn", () => {
    // The sizes and the width are the instrument's, measured on its own book, and the panel does not carry them: the
    // trader's four numeric inputs were dropped on 2026-09-20 at his word, with the long hint under them.
    expect(INSTITUTIONAL_V2_SETTINGS_SCHEMA.map((field) => (field.kind === "staticHint" ? "staticHint" : field.key))).toEqual([
      "source",
      "showWeak",
      "showMitigated",
      "minSizeByInstrument",
      "levelsBy",
      "levelsPerSide",
      "bullishColor",
      "bearishColor",
      "bandThicknessPx",
      "historyHours",
    ]);
    expect(Object.keys(DEFAULT_INSTITUTIONAL_V2_SETTINGS)).toEqual(["source", "showWeak", "showMitigated", "minSizeByInstrument", "levelsBy", "levelsPerSide", "bullishColor", "bearishColor", "bandThicknessPx", "historyHours"]);
    expect(DEFAULT_INSTITUTIONAL_V2_SETTINGS.bandThicknessPx).toBe(24);
    expect(DEFAULT_INSTITUTIONAL_V2_SETTINGS.minSizeByInstrument).toEqual({});
    // The width and the two sizes that make a wall are the instrument's and are not on the panel.
    expect([bandRowsFor(btc), wallSizeFor(btc), strongSizeFor(btc), minSizeFor(btc)]).toEqual([4, 50, 200, 150]);
  });

  it("ranks the levels a side by distance from price, the furthest first, until the trader asks otherwise", () => {
    // His standard settings, 2026-09-20: the outer levels of the book, the ones a move is heading for.
    expect(DEFAULT_INSTITUTIONAL_V2_SETTINGS.levelsBy).toBe("furthest");
    const field = INSTITUTIONAL_V2_SETTINGS_SCHEMA.find((f) => f.kind !== "staticHint" && f.key === "levelsBy");
    expect(field?.kind).toBe("radioGroup");
    expect(field !== undefined && "options" in field ? field.options.map((o) => o.value) : []).toEqual(["nearest", "largest", "furthest"]);
  });

  it("draws four levels a side unless the trader asks for more, or all", () => {
    expect(DEFAULT_INSTITUTIONAL_V2_SETTINGS.levelsPerSide).toBe(4);
  });

  it("hides mitigated walls until the trader asks for them", () => {
    expect(DEFAULT_INSTITUTIONAL_V2_SETTINGS.showMitigated).toBe(false);
  });

  it("draws only strong walls until the trader asks for the weak ones", () => {
    expect(DEFAULT_INSTITUTIONAL_V2_SETTINGS.showWeak).toBe(false);
    expect(isShownGrade("strong", DEFAULT_INSTITUTIONAL_V2_SETTINGS)).toBe(true);
    expect(isShownGrade("weak", DEFAULT_INSTITUTIONAL_V2_SETTINGS)).toBe(false);
    expect(isShownGrade("weak", { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, showWeak: true })).toBe(true);
    expect(isShownGrade("strong", { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, showWeak: true })).toBe(true);
  });

  it("asks for a replay on every field, since this indicator owns no lines for the cosmetic path to repaint", () => {
    // The runtime's cosmetic path walks the record's line colours; a box-drawing indicator has none, so a cosmetic
    // change draws nothing until the next bar. The trader saw that on 2026-09-20: "hide walls under doesn't do anything".
    const affects = new Map(INSTITUTIONAL_V2_SETTINGS_SCHEMA.flatMap((field) => (field.kind === "staticHint" ? [] : [[field.key, field.affects] as const])));
    for (const key of ["showWeak", "showMitigated", "minSizeByInstrument", "levelsBy", "levelsPerSide", "bullishColor", "bearishColor"] as const) expect(affects.get(key)).toBe("recompute");
  });

  it("offers every setting it defines, so none is unreachable from the panel", () => {
    const offered = new Set(INSTITUTIONAL_V2_SETTINGS_SCHEMA.flatMap((field) => (field.kind === "staticHint" ? [] : [field.key])));
    expect(offered).toEqual(new Set(Object.keys(DEFAULT_INSTITUTIONAL_V2_SETTINGS)));
  });
});
