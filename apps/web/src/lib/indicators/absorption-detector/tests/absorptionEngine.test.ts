import { describe, expect, it } from "vitest";
import { bandMaxSizes } from "../../passive-liquidity/liquidityGrid";
import type { BandTrackerState, BarClose } from "../../institutional-order-blocks-v2/bandTracker";
import type { Wall } from "../../institutional-order-blocks-v2/institutionalV2Rules";
import { ABSORPTION_ENGINE_VERSION, AbsorptionTracker, TRAIL_MAX, detectAbsorption, printKey, readPrint, type AbsorptionPrint, type AbsorptionRecord, type ColumnFeed } from "../absorptionEngine";
import { ASKED_MULTIPLES, ASKED_PERCENTS, type AbsorptionRules } from "../absorptionSettings";
import { BAND, BAND_MID, REFERENCE, ROW, RULES, STEP, T, col, feedOf, tape, type Col } from "./absorptionFixtures";

// The fixture: a BTC-perp-like book, rows of $4, bands of four rows summed, a wall from 50, a typical level of 10 on
// every column. An attack is recorded once all of the resting size and five times the typical level (50) have traded
// into the wall (the fixture's own record gate; the app's is the sliders' lowest numbers, half and three); the rules in hand read the records: a sphere at the same numbers here,
// the strong ring at twice. Two quiet minutes end an attack. Ten-second columns, the width the walls are read at.
const at = (ts: number) => Math.round((ts - T) / STEP);
const read = (records: readonly AbsorptionRecord[], rules: AbsorptionRules = RULES): AbsorptionPrint[] => records.map((record) => readPrint(record, rules)).filter((print): print is AbsorptionPrint => print !== null);
const prints = (feed: ColumnFeed, rowWidth: number, rules: AbsorptionRules, nowMs: number, closes: readonly BarClose[] = []): AbsorptionPrint[] => read(detectAbsorption(feed, rowWidth, rules, nowMs, closes), rules);
const brief = (list: readonly AbsorptionPrint[]) => list.map((print) => [at(print.ts), print.share, print.resting, print.absorbed]);

describe("detectAbsorption", () => {
  it("records the attack at the column the sells into the wall reach all of what it held when the attack began and five times the book's typical level, and reads a sphere there at once, held", () => {
    // The wall stands at 200 from the first column. Column 3: 160 sold into it (four fifths, short); column 4: 80 more,
    // 240 in all, over the 200 resting and over 5 x 10. Resting is read in the column before the first sell, column 2:
    // 200. The record is made at column 4, at the band's mid, with the column in its trail; the sphere reads there and
    // then: nothing waits for a hold.
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 160 }, { wall: 20, sell: 80 }, { wall: 20 }];
    const columns = tape(specs, 20);
    expect(detectAbsorption(feedOf(columns.slice(0, 4)), ROW, RULES, T + 3 * STEP + 1)).toEqual([]);
    const records = detectAbsorption(feedOf(columns.slice(0, 5)), ROW, RULES, T + 4 * STEP + 1);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      key: `bid:${BAND}:4:${T + 3 * STEP}`,
      side: "bid",
      band: BAND,
      rows: 4,
      ts: T + 4 * STEP,
      attackTs: T + 3 * STEP,
      shown: 200, resting: 200,
      absorbed: 240,
      yardstick: REFERENCE,
      refills: 0,
      price: BAND_MID,
      trail: [{ ts: T + 4 * STEP, absorbed: 240, current: 20, refills: 0 }],
      latest: { ts: T + 4 * STEP, absorbed: 240, current: 20, refills: 0 },
      endTs: null,
      endReason: null,
    });
    expect(printKey(records[0])).toBe(records[0].key);
    expect(readPrint(records[0], RULES)).toEqual({
      key: `bid:${BAND}:4:${T + 3 * STEP}`,
      side: "bid",
      band: BAND,
      rows: 4,
      ts: T + 4 * STEP,
      attackTs: T + 3 * STEP,
      share: 1,
      strong: false,
      shown: 200, resting: 200,
      absorbed: 240,
      yardstick: REFERENCE,
      current: 20,
      refills: 0,
      price: BAND_MID,
      judgedAt: T + 4 * STEP,
      held: true,
      broken: false,
    });
    expect(detectAbsorption(feedOf(columns), ROW, RULES, T + 19 * STEP + 1)).toEqual(records);
  });

  it("records at the sliders' lowest numbers whatever numbers are in hand, so the same records read under any setting: at 300% the record is there and the sphere is not", () => {
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 160 }, { wall: 20, sell: 80 }, { wall: 20 }];
    const stricter: AbsorptionRules = { ...RULES, absorbedPercent: 300, strongPercent: 500, absorbedMultiple: 50 };
    const records = detectAbsorption(feedOf(tape(specs, 20)), ROW, stricter, T + 19 * STEP + 1);
    expect(records).toEqual(detectAbsorption(feedOf(tape(specs, 20)), ROW, RULES, T + 19 * STEP + 1));
    expect(records).toHaveLength(1);
    expect(read(records, stricter)).toEqual([]);
    expect(read(records)).toHaveLength(1);
  });

  it("records nothing short of all the wall held: four fifths of 200 is never recorded, however far over the lowest multiple it is and whatever the numbers in hand say", () => {
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 160 }, { wall: 40 }];
    expect(detectAbsorption(feedOf(tape(specs, 20)), ROW, RULES, T + 19 * STEP + 1)).toEqual([]);
    expect(detectAbsorption(feedOf(tape(specs, 20)), ROW, { ...RULES, absorbedPercent: 50, absorbedMultiple: 1 }, T + 19 * STEP + 1)).toEqual([]);
  });

  it("records nothing under five times the book's typical level: 60 into a wall of 60 is all of it but under 5 x 13, whatever the multiple in hand; at a level of 10 the same 60 is over 5 x 10 and recorded", () => {
    // 300 for two columns, quietly down to 60 (not pulled), then 60 sold: all of the 60 resting (over the heatmap's wall
    // size of 50, so what the band showed stands) but under 5 x 13 = 65, so the multiple is the condition that binds.
    // The multiple in hand cannot lower the record gate. At a level of 10 the gate asks 50 and the attack is recorded.
    const specs: Col[] = [{ wall: 300 }, { wall: 300 }, { wall: 60 }, { wall: 60 }, { wall: 5, sell: 60 }, { wall: 5 }];
    const level = (reference: number) => tape(specs, 20).map((column) => ({ ...column, reference }));
    expect(detectAbsorption(feedOf(level(13)), ROW, RULES, T + 19 * STEP + 1)).toEqual([]);
    expect(detectAbsorption(feedOf(level(13)), ROW, { ...RULES, absorbedMultiple: 1 }, T + 19 * STEP + 1)).toEqual([]);
    expect(brief(prints(feedOf(level(10)), ROW, RULES, T + 19 * STEP + 1))).toEqual([[4, 1, 60, 60]]);
  });

  it("reads the typical level from the column of the attack's first hit, and from the feed when the column carries none", () => {
    // The level is 10 when the attack begins at column 3 and 100 by column 4, where 240 has gone in: 240 is over 5 x 10,
    // the yardstick of the attack, not 5 x 100. Without a level on the columns the feed's own stands in: 50 asks 250.
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 160, reference: 10 }, { wall: 20, sell: 80, reference: 100 }, { wall: 20, reference: 100 }];
    const records = detectAbsorption(feedOf(tape(specs, 20)), ROW, RULES, T + 19 * STEP + 1);
    expect(records.map((record) => [at(record.ts), record.yardstick])).toEqual([[4, 10]]);
    const bare = tape(specs, 20).map((column) => ({ ...column, reference: undefined }));
    expect(detectAbsorption({ ...feedOf(bare), reference: 50 }, ROW, RULES, T + 19 * STEP + 1)).toEqual([]);
    expect(detectAbsorption({ ...feedOf(bare), reference: 10 }, ROW, RULES, T + 19 * STEP + 1).map((record) => record.yardstick)).toEqual([10]);
  });

  it("measures an attack against the heatmap's wall size when the band showed less, and keeps what it showed: a band down to 20 under a wall size of 50 is judged as 50", () => {
    // A wall of 200 thinned to 20 (a tenth of its peak, not pulled), then 60 sold: against the 20 shown that is three
    // times the wall, but a thin book shows a tenth of what trades, so the wall is read as the heatmap's wall size, 50,
    // and 60 is 120% of it. The record keeps both numbers; the hover says what was shown. With a wall size under what
    // the band showed, the shown size stands (NQ 2026-10-07: walls showing 12 to 20 contracts took 100 to 500 each, and
    // 500% of 17 is 85, under five yardsticks, so the percent sliders never bit).
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 20 }, { wall: 20 }, { wall: 5, sell: 60 }, { wall: 5 }];
    const records = detectAbsorption(feedOf(tape(specs, 20)), ROW, RULES, T + 19 * STEP + 1);
    expect(records.map((record) => [at(record.ts), record.shown, record.resting, record.absorbed])).toEqual([[4, 20, 50, 60]]);
    expect(readPrint(records[0], RULES)).toMatchObject({ shown: 20, resting: 50, absorbed: 60, share: 1 });
    expect(readPrint(records[0], { ...RULES, absorbedPercent: 150, strongPercent: 300 })).toBeNull();
    const thin = detectAbsorption(feedOf(tape(specs, 20)), ROW, { ...RULES, wallSize: () => 10 }, T + 19 * STEP + 1);
    expect(thin.map((record) => [record.shown, record.resting])).toEqual([[20, 20]]);
    expect(readPrint(thin[0], { ...RULES, absorbedPercent: 150, strongPercent: 300 })).toMatchObject({ shown: 20, resting: 20, share: 1.5 });
  });

  it("records only while something of the wall still rests: eaten to nothing the record waits, back with a size, however small, it is made with what the wall holds then", () => {
    // 200 of 200 sold at column 3, the band empty: all of it and more, but nothing left to absorb. Column 4 it holds 5
    // again with 10 more sold: recorded there, holding 5, 210 absorbed. An iceberg shows a few lots while it absorbs,
    // so the heatmap's floor is not asked of it here, only of the wall when it opened.
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 0, sell: 200 }, { wall: 5, sell: 10 }, { wall: 5 }];
    const list = prints(feedOf(tape(specs, 20)), ROW, RULES, T + 19 * STEP + 1);
    expect(list.map((print) => [at(print.ts), print.absorbed, print.current])).toEqual([[4, 210, 5]]);
  });

  it("records with the price at or inside the wall's band, never through it: the record waits for the next column where the mid is back on the wall's side of its far edge", () => {
    // 240 sold at column 3 with the mid inside the band (a wall eaten row by row holds the rest): recorded there. Through
    // the band and never back: nothing; the fixture's `mid: 64` reads as a column mid of exactly the band's bottom, which
    // is through, not inside. Through at column 3 and back inside at column 4: recorded at column 4. Bands are forty
    // dollars on the perp and the price trades inside a holding wall; the near edge lost those columns and read the
    // sell-offs as nothing (BTC perp 2026-10-07, 5 bid spheres to 9 ask; the far edge 11 to 12).
    const inside: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240, mid: 88 }, { wall: 40, mid: 100 }, { wall: 40 }];
    expect(prints(feedOf(tape(inside, 20)), ROW, RULES, T + 19 * STEP + 1).map((print) => [at(print.ts), print.absorbed])).toEqual([[3, 240]]);
    const through: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240, mid: 64 }, { wall: 40, mid: 64 }];
    expect(detectAbsorption(feedOf(tape(through, 20)), ROW, RULES, T + 19 * STEP + 1)).toEqual([]);
    const back: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240, mid: 64 }, { wall: 40, mid: 88 }, { wall: 40 }];
    expect(prints(feedOf(tape(back, 20)), ROW, RULES, T + 19 * STEP + 1).map((print) => [at(print.ts), print.absorbed])).toEqual([[4, 240]]);
  });

  it("keeps in its trail the first column each number a slider can ask for is met at, never moving or dropping a kept entry, and the newest reading in latest", () => {
    // Resting 200 and a level of 10: the sliders ask for 100, 120 ... 1,000 (50-500% of the wall) and 30, 40 ... 2,000
    // (3-200 times the level). Recorded at column 3 with 240. Column 4: 245, short of the next ask, 250, so only latest
    // moves; column 5: 255, past it, an entry; column 6: 258, latest only; column 7: 308, past 260 to 300, one entry.
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40, sell: 5 }, { wall: 40, sell: 10 }, { wall: 40, sell: 3 }, { wall: 40, sell: 50 }, { wall: 40 }];
    const [record] = detectAbsorption(feedOf(tape(specs, 24)), ROW, RULES, T + 23 * STEP + 1);
    expect(record.trail.map((entry) => [at(entry.ts), entry.absorbed])).toEqual([[3, 240], [5, 255], [7, 308]]);
    expect(record.latest).toEqual({ ts: T + 7 * STEP, absorbed: 308, current: 40, refills: 0 });
    // 25 times the level (250) reads at column 5; 26 times (260) and 150% (300) at column 7; 160% (320) nowhere yet.
    expect(read([record], { ...RULES, absorbedMultiple: 25 }).map((print) => at(print.ts))).toEqual([5]);
    expect(read([record], { ...RULES, absorbedMultiple: 26 }).map((print) => at(print.ts))).toEqual([7]);
    expect(read([record], { ...RULES, absorbedPercent: 150 }).map((print) => at(print.ts))).toEqual([7]);
    expect(read([record], { ...RULES, absorbedPercent: 160 })).toEqual([]);
    // A hit with the mid through the band adds no entry; the next column with the mid back inside the band carries the flow since.
    const through: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40, sell: 50, mid: 64 }, { wall: 40, mid: 88 }, { wall: 40 }];
    expect(detectAbsorption(feedOf(tape(through, 12)), ROW, RULES, T + 11 * STEP + 1).map((entry) => entry.trail.map((step) => [at(step.ts), step.absorbed]))).toEqual([[[3, 240], [5, 290]]]);
  });

  it("reads every setting the sliders can make at the first column whose eating reaches it, from the update that reads that column on (PR #48 review)", () => {
    // At the app's record gate, the sliders' lowest numbers: one attack fed a column at a time, its sells big and small,
    // some with the mid through the band, on a level of 37, so the shares of the wall and the multiples of the level ask
    // for different sizes. Every reading the record takes passes through latest, so the true column for a setting is the
    // first of them that reaches it. All 46 shares x 198 multiples are read after every column.
    const gate: AbsorptionRules = { ...RULES, recordPercent: ASKED_PERCENTS[0], recordMultiple: ASKED_MULTIPLES[0] };
    const sizes = [0, 1, 2, 5, 9, 13, 20, 35, 60, 120];
    const specs: Col[] = [{ wall: 200, reference: 37 }, { wall: 200, reference: 37 }, { wall: 200, reference: 37 }, { wall: 40, sell: 240, reference: 37 }, ...Array.from({ length: 80 }, (_, i): Col => ({ wall: 40, sell: sizes[(i * 7) % 10], mid: i % 11 === 5 ? 64 : 100, reference: 37 }))];
    const columns = tape(specs);
    const tracker = new AbsorptionTracker();
    const readings: { ts: number; absorbed: number }[] = [];
    const wrong: string[] = [];
    let checked = 0;
    for (let n = 4; n <= columns.length; n += 1) {
      const [record] = tracker.update(feedOf(columns.slice(0, n)), ROW, gate, T + (n - 1) * STEP + 1);
      if (readings.length === 0 || readings[readings.length - 1].ts !== record.latest.ts) readings.push(record.latest);
      for (const percent of ASKED_PERCENTS) {
        for (const multiple of ASKED_MULTIPLES) {
          const need = Math.max((percent / 100) * record.resting, multiple * record.yardstick);
          const want = readings.find((reading) => reading.absorbed >= need)?.ts ?? null;
          const got = readPrint(record, { ...gate, absorbedPercent: percent, absorbedMultiple: multiple })?.ts ?? null;
          if (got !== want) wrong.push(`column ${n - 1} at ${percent}% ${multiple}x: ${got === null ? "none" : at(got)} for ${want === null ? "none" : at(want)}`);
          checked += 1;
        }
      }
    }
    expect(at(readings[readings.length - 1].ts)).toBeGreaterThan(70);
    expect(readings[readings.length - 1].absorbed).toBeGreaterThan(1000);
    expect(checked).toBe((columns.length - 3) * ASKED_PERCENTS.length * ASKED_MULTIPLES.length);
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it("keeps at most the record's first column and one for each number a slider can ask for, under a cap of 256 the sliders never reach; past the last ask only latest moves", () => {
    expect(ASKED_PERCENTS).toHaveLength(46);
    expect(ASKED_MULTIPLES).toHaveLength(198);
    expect(TRAIL_MAX).toBe(256);
    expect(1 + ASKED_PERCENTS.length + ASKED_MULTIPLES.length).toBeLessThan(TRAIL_MAX);
    // Three percent more every column from 240: the last ask is 2,000, two hundred times the level; the trail's last
    // entry is the first column past it, and latest moves on alone.
    const growth = (count: number): Col[] => Array.from({ length: count }, (_, i) => ({ wall: 40, sell: 240 * 1.03 ** i * 0.03 }));
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, ...growth(120), { wall: 40 }];
    const [record] = detectAbsorption(feedOf(tape(specs)), ROW, RULES, T + specs.length * STEP);
    expect(record.trail[record.trail.length - 1].absorbed).toBeGreaterThanOrEqual(2000);
    expect(record.trail[record.trail.length - 2].absorbed).toBeLessThan(2000);
    expect(at(record.latest.ts)).toBe(123);
    // Asks a percent apart all the way up, closer than the eating grows: the cap holds the trail at 256.
    const dense: AbsorptionRules = { ...RULES, askedPercents: [], askedMultiples: Array.from({ length: 900 }, (_, i) => 24 * 1.01 ** (i + 1)) };
    const long: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, ...growth(300), { wall: 40 }];
    const [capped] = detectAbsorption(feedOf(tape(long)), ROW, dense, T + long.length * STEP);
    expect(capped.trail).toHaveLength(TRAIL_MAX);
  });

  it("never moves a sphere once drawn, however long the attack goes on: a wall showing a thousand eaten twenty a column reads at the default numbers at column 102, where the eating reached twice the wall, from that column on (PR #48 review)", () => {
    // Agha's reproduction, at the app's record gate (half the wall, three levels): recorded at column 27 with 500, so
    // the old trail of sixty-four slots was full by column 90 and its last slot moved on with every column: this sphere
    // was drawn at 104, then 109, 119, 129 and 142.
    const specs: Col[] = [{ wall: 1000 }, { wall: 1000 }, { wall: 1000 }, ...Array.from({ length: 141 }, () => ({ wall: 1000, sell: 20 }))];
    const columns = tape(specs);
    const gate: AbsorptionRules = { ...RULES, recordPercent: 50, recordMultiple: 3 };
    const defaults: AbsorptionRules = { ...gate, absorbedPercent: 200, strongPercent: 300, absorbedMultiple: 40 };
    const tracker = new AbsorptionTracker();
    const drawn: (number | null)[] = [];
    for (let n = 96; n <= columns.length; n += 1) {
      const sphere = read(tracker.update(feedOf(columns.slice(0, n)), ROW, gate, T + (n - 1) * STEP + 1), defaults)[0];
      drawn.push(sphere === undefined ? null : at(sphere.ts));
    }
    expect(drawn.slice(0, 7)).toEqual([null, null, null, null, null, null, null]);
    expect(new Set(drawn.slice(7))).toEqual(new Set([102]));
    expect(drawn.slice(7)).toHaveLength(columns.length - 102);
  });

  it("draws a setting met by a small print at its own column at once, and keeps it there while the attack drips on for an hour, after a hole, and when a bar closes through the wall and it opens again (PR #48 review)", () => {
    // At the app's record gate and the default numbers: a wall of 100, 55 at column 3 (the record), 399 at column 4, 401
    // at column 5 -- past 400, forty times the level, by two. A trail of two-percent steps kept no entry at column 5:
    // it drew nothing until the attack ended and then drew the attack's last reading, or nothing when that end was lost.
    const gate: AbsorptionRules = { ...RULES, recordPercent: 50, recordMultiple: 3 };
    const defaults: AbsorptionRules = { ...gate, absorbedPercent: 200, strongPercent: 300, absorbedMultiple: 40 };
    const start: Col[] = [{ wall: 100 }, { wall: 100 }, { wall: 100 }, { wall: 100, sell: 55 }, { wall: 100, sell: 344 }, { wall: 100, sell: 2 }];
    const drawnAt = (columns: ReturnType<typeof tape>, closes: readonly BarClose[] = []) => {
      const tracker = new AbsorptionTracker();
      const drawn: (number | null)[] = [];
      for (let n = 5; n <= columns.length; n += 1) {
        const sphere = read(tracker.update(feedOf(columns.slice(0, n)), ROW, gate, columns[n - 1].ts + 1, closes), defaults)[0];
        drawn.push(sphere === undefined ? null : at(sphere.ts));
      }
      return drawn;
    };
    const fromFive = (columns: readonly unknown[]) => [null, ...Array.from({ length: columns.length - 5 }, () => 5)];
    const drip = tape([...start, ...Array.from({ length: 360 }, (_, i): Col => ({ wall: 100, sell: i % 10 === 9 ? 0.01 : 0 }))]);
    expect(drawnAt(drip)).toEqual(fromFive(drip));
    const hole = [...tape(start), ...Array.from({ length: 20 }, (_, i) => col(T + 5 * STEP + 660_000 + i * STEP, { wall: 100 }))];
    expect(drawnAt(hole)).toEqual(fromFive(hole));
    const closes: BarClose[] = [{ ts: T + 6 * STEP, row: 15 }];
    const reopened = tape([...start, ...Array.from({ length: 20 }, (): Col => ({ wall: 100 }))]);
    expect(drawnAt(reopened, closes)).toEqual(fromFive(reopened));
    expect(read(detectAbsorption(feedOf(reopened), ROW, gate, reopened[reopened.length - 1].ts + 1, closes), defaults).map((print) => [at(print.ts), print.broken])).toEqual([[5, true]]);
  });

  it("opens no attack without a typical level: a wall of 60 taking 150 on a book whose level is 0 records nothing, the same attack on a level of 10 is recorded (PR #48 review)", () => {
    // A level of 0 (a host column after a gap, the live grid before its reference warms up) would turn off the "x the
    // book's level" condition and judge the attack on the share of the wall alone.
    const specs: Col[] = [{ wall: 60 }, { wall: 60 }, { wall: 60 }, { wall: 5, sell: 150 }, { wall: 5 }];
    const level = (reference: number) => tape(specs, 20).map((column) => ({ ...column, reference }));
    expect(detectAbsorption(feedOf(level(0)), ROW, RULES, T + 19 * STEP + 1)).toEqual([]);
    expect(detectAbsorption({ ...feedOf(level(0)), reference: 0 }, ROW, RULES, T + 19 * STEP + 1)).toEqual([]);
    expect(detectAbsorption(feedOf(level(10)), ROW, RULES, T + 19 * STEP + 1).map((record) => [at(record.ts), record.yardstick])).toEqual([[3, 10]]);
  });

  it("reads the strong ring from the same record when the eating reaches twice the resting size in the same attack: one sphere an attack, at the first column, darker, carrying the flow since", () => {
    // 240 (120%) at column 4, then 200 more at column 8: 440 of 200 is 220%, the strong ring on the same sphere. Column
    // 12 another 100: the sphere's flow grows to 540, no new sphere; what the wall held at the sphere stays its column's.
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40 }, { wall: 40 }, { wall: 40 }, { wall: 30, sell: 200 }, { wall: 30 }, { wall: 30 }, { wall: 30 }, { wall: 20, sell: 100 }, { wall: 20 }];
    const columns = tape(specs, 30);
    const first = prints(feedOf(columns.slice(0, 6)), ROW, RULES, T + 5 * STEP + 1);
    expect(first.map((print) => [at(print.ts), print.share, print.strong, print.absorbed, print.current])).toEqual([[4, 1, false, 240, 40]]);
    const strong = prints(feedOf(columns.slice(0, 10)), ROW, RULES, T + 9 * STEP + 1);
    expect(strong.map((print) => [at(print.ts), print.share, print.strong, print.absorbed, print.current, print.key])).toEqual([[4, 2, true, 440, 40, first[0].key]]);
    const later = prints(feedOf(columns), ROW, RULES, T + 29 * STEP + 1);
    expect(later.map((print) => [at(print.ts), print.share, print.strong, print.absorbed, print.current])).toEqual([[4, 2, true, 540, 40]]);
    // Both shares at once read the strong ring straight away.
    const atOnce = prints(feedOf(tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 20, sell: 440 }, { wall: 20 }], 20)), ROW, RULES, T + 19 * STEP + 1);
    expect(atOnce.map((print) => [at(print.ts), print.share, print.strong])).toEqual([[3, 2, true]]);
    // The strong ring also needs twice the minimum absorbed (2 x 5 x the level): at a level of 50 that is 500, and 440 into a wall of 200 is 220% but not strong.
    const level = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 20, sell: 440 }, { wall: 20 }], 20).map((column) => ({ ...column, reference: 50 }));
    const small = prints(feedOf(level), ROW, RULES, T + 19 * STEP + 1);
    expect(small.map((print) => [at(print.ts), print.share, print.strong, print.absorbed])).toEqual([[3, 1, false, 440]]);
  });

  it("prints on a thin book only once the wall has absorbed twice what it held and forty times the level: refilled while eaten", () => {
    // The index rule at the shipped defaults, on a level of 2: a wall of 200 eaten 60, refilled, eaten 140, refilled, eaten
    // 150, refilled, eaten 100: 450 absorbed against 200 resting -- past twice at the last hit, not before; 450 is past
    // 40 x 2 too. Two refills by the tracker's rule. Then 150 more: 600, three times the wall, the strong ring.
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 140, sell: 60 }, { wall: 200 }, { wall: 60, sell: 140 }, { wall: 200 }, { wall: 50, sell: 150 }, { wall: 200 }, { wall: 100, sell: 100 }, { wall: 200 }, { wall: 50, sell: 150 }, { wall: 50 }];
    const thin: AbsorptionRules = { ...RULES, absorbedPercent: 200, strongPercent: 300, absorbedMultiple: 40 };
    const columns = tape(specs, 30).map((column) => ({ ...column, reference: 2 }));
    expect(prints(feedOf(columns.slice(0, 10)), ROW, thin, T + 9 * STEP + 1)).toEqual([]);
    const list = prints(feedOf(columns.slice(0, 12)), ROW, thin, T + 11 * STEP + 1);
    expect(list.map((print) => [at(print.ts), print.share, print.resting, print.absorbed, print.refills])).toEqual([[10, 2, 200, 450, 2]]);
    const strong = prints(feedOf(columns), ROW, thin, T + 29 * STEP + 1);
    expect(strong.map((print) => [at(print.ts), print.share, print.strong, print.resting, print.absorbed])).toEqual([[10, 3, true, 200, 600]]);
    // The record was made at column 6, where the eating reached all of the wall, and holds the hit columns since: the defaults read it from column 10.
    const [record] = detectAbsorption(feedOf(columns), ROW, thin, T + 29 * STEP + 1);
    expect(record.trail.map((entry) => [at(entry.ts), entry.absorbed, entry.refills])).toEqual([[6, 200, 0], [8, 350, 1], [10, 450, 2], [12, 600, 3]]);
    // A higher level asks more: at 12 the 450 are short of 480 and only the 600 prints; the strong ring would need 720 there (one and a half times 480), so it is the plain sphere.
    expect(brief(prints(feedOf(columns.map((column) => ({ ...column, reference: 12 }))), ROW, thin, T + 29 * STEP + 1))).toEqual([[12, 2, 200, 600]]);
  });

  it("reads the resting size afresh at each attack: a wall hit small at birth and hit again two quiet minutes later, grown, is judged against what it held then", () => {
    // 60 at birth, 20 sold (a third), then quiet and grown to 200, and at column 16 -- two minutes after the last sell --
    // 240 sold: a new attack, resting 200, absorbed 240.
    const specs: Col[] = [{ wall: 60 }, { wall: 60 }, { wall: 60 }, { wall: 40, sell: 20 }, { wall: 40 }, { wall: 120 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40 }];
    expect(brief(prints(feedOf(tape(specs, 34)), ROW, RULES, T + 33 * STEP + 1))).toEqual([[16, 1, 200, 240]]);
  });

  it("ends an attack after two minutes without an opposing print: the next sells begin another, with its own resting size and its own sphere", () => {
    // 240 into 200 at column 4, printed. Quiet to column 16, the wall at 40. 50 sold at column 17 is all of the wall
    // (read as the heatmap's 50, it shows 40) and the level's 50: a second sphere for this attack, not the strong
    // ring (that needs 400 on the first). One life would have read 290 of 200 on the first sphere.
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40 }, { wall: 40 }, { wall: 40 }, { wall: 40 }, { wall: 40 }, { wall: 40 }, { wall: 40 }, { wall: 40 }, { wall: 40 }, { wall: 40 }, { wall: 40 }, { wall: 40 }, { wall: 10, sell: 50 }, { wall: 10 }];
    expect(brief(prints(feedOf(tape(specs, 36)), ROW, RULES, T + 35 * STEP + 1))).toEqual([[4, 1, 200, 240], [17, 1, 50, 50]]);
  });

  it("keeps sells inside the quiet spell in the same attack, and sells a full quiet spell after the last in a new one", () => {
    // 150 into 200 at column 4 (75%). 50 more at column 15, 110 seconds on: the same attack, 200 of 200, recorded at
    // column 15. Moved to column 16, 120 seconds on: a new attack against the 80 the wall holds, 50 is short, nothing.
    const same: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 80, sell: 150 }, ...Array.from({ length: 10 }, () => ({ wall: 80 })), { wall: 30, sell: 50 }, { wall: 30 }];
    const apart: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 80, sell: 150 }, ...Array.from({ length: 11 }, () => ({ wall: 80 })), { wall: 30, sell: 50 }, { wall: 30 }];
    expect(brief(prints(feedOf(tape(same, 34)), ROW, RULES, T + 33 * STEP + 1))).toEqual([[15, 1, 200, 200]]);
    expect(detectAbsorption(feedOf(tape(apart, 34)), ROW, RULES, T + 33 * STEP + 1)).toEqual([]);
    // A shorter quiet spell in the rules ends the attack sooner: at 100 seconds the second sells at column 15 are a new attack.
    expect(detectAbsorption(feedOf(tape(same, 34)), ROW, { ...RULES, quietMs: 100_000 }, T + 33 * STEP + 1)).toEqual([]);
    // The spell runs from the last print, not the first: 70 at column 4, 70 at column 14, 70 at column 25 -- 210 seconds
    // from the first, 110 from the second -- are one attack, 210 of 200 at column 25.
    const drip: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 130, sell: 70 }, ...Array.from({ length: 9 }, () => ({ wall: 130 })), { wall: 60, sell: 70 }, ...Array.from({ length: 10 }, () => ({ wall: 60 })), { wall: 20, sell: 70 }, { wall: 20 }];
    expect(brief(prints(feedOf(tape(drip, 44)), ROW, RULES, T + 43 * STEP + 1))).toEqual([[25, 1, 200, 210]]);
  });

  it("marks the sphere broken, and keeps it, when a bar later closes through its wall", () => {
    // Recorded at column 4. A bar closes under the band at T + 60 s: the wall ends, the record carries the end, the
    // sphere stays and reads as broken. Nothing that happens to the wall afterwards takes a sphere off.
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40 }, { wall: 40 }, { wall: 0, mid: 64 }];
    const columns = tape(specs, 30);
    const closes: BarClose[] = [{ ts: T + 6 * STEP, row: 15 }];
    expect(prints(feedOf(columns.slice(0, 6)), ROW, RULES, T + 5 * STEP + 1, closes).map((print) => print.broken)).toEqual([false]);
    const after = detectAbsorption(feedOf(columns), ROW, RULES, T + 29 * STEP + 1, closes);
    expect(after.map((record) => [at(record.ts), record.endTs, record.endReason])).toEqual([[4, T + 6 * STEP, "closed"]]);
    expect(read(after, RULES).map((print) => [at(print.ts), print.absorbed, print.broken, print.held])).toEqual([[4, 240, true, true]]);
    // Without the close the wall stands on, empty; price through it does not break the sphere either.
    expect(prints(feedOf(columns), ROW, RULES, T + 29 * STEP + 1).map((print) => [at(print.ts), print.broken])).toEqual([[4, false]]);
    // A close through the wall later than the break window (three minutes here) is the market moving on, not the sphere breaking: the record carries the end, the reading says not broken.
    const long = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, ...Array.from({ length: 24 }, () => ({ wall: 40 })), { wall: 0, mid: 64 }], 30);
    const late = detectAbsorption(feedOf(long), ROW, RULES, T + 29 * STEP + 1, [{ ts: T + 4 * STEP + RULES.breakWindowMs + STEP, row: 15 }]);
    expect(late.map((record) => [at(record.ts), record.endReason])).toEqual([[4, "closed"]]);
    expect(read(late, RULES).map((print) => [at(print.ts), print.broken])).toEqual([[4, false]]);
  });

  it("marks the sphere broken when its wall is pulled, and leaves one whose wall ended in a hole or at the window's edge", () => {
    // The tracker never pulls a traded-into wall, so the pull is put on the wall by hand: the engine reads the end reason.
    const tracker = new AbsorptionTracker();
    const columns = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40 }, { wall: 0 }], 8);
    expect(read(tracker.update(feedOf(columns.slice(0, 6)), ROW, RULES, T + 5 * STEP + 1)).map((print) => print.broken)).toEqual([false]);
    const state = (tracker as unknown as { _state: BandTrackerState })._state;
    const wall = state.open.get(`bid:${BAND}`) as Wall;
    state.open.delete(`bid:${BAND}`);
    state.memory.set(`bid:${BAND}`, Object.assign(wall, { endTs: T + 5 * STEP, endReason: "pulled" as const }));
    const pulled = tracker.update(feedOf(columns.slice(0, 7)), ROW, RULES, T + 6 * STEP + 1);
    expect(pulled.map((record) => [at(record.ts), record.endTs, record.endReason])).toEqual([[4, T + 5 * STEP, "pulled"]]);
    expect(read(pulled).map((print) => [at(print.ts), print.broken])).toEqual([[4, true]]);
    // A hole in the columns ends the wall without breaking the sphere: the record says the wall ended some other way.
    // (A wall of 100, under the tracker's strong size of three floors: at 200 the eaten wall is guarded and outlives a hole.)
    const gap = 11 * 60_000;
    const thin = tape([{ wall: 100 }, { wall: 100 }, { wall: 100 }, { wall: 100 }, { wall: 20, sell: 120 }, { wall: 20 }], 6);
    const holed = [...thin, ...tape([{ wall: 0 }], 3).map((column) => ({ ...column, ts: column.ts + 6 * STEP + gap }))];
    const inHole = detectAbsorption(feedOf(holed), ROW, RULES, holed[holed.length - 1].ts + 1);
    expect(inHole.map((record) => [at(record.ts), record.endTs, record.endReason])).toEqual([[4, T + 5 * STEP, "other"]]);
    expect(read(inHole).map((print) => [at(print.ts), print.broken])).toEqual([[4, false]]);
  });

  it("never prints on a pulled wall, and a wall back after a pull is a new life with its own resting size", () => {
    // 200 for three columns, then pulled to 10 with nothing traded in: gone. Back at 200 at column 8; hit for 240 at
    // column 12: one sphere, resting 200, read in the new life.
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 10 }, { wall: 10 }, { wall: 10 }, { wall: 10 }, { wall: 10 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40 }];
    const list = prints(feedOf(tape(specs, 30)), ROW, RULES, T + 29 * STEP + 1);
    expect(list.map((print) => [at(print.ts), print.resting, print.absorbed, print.refills])).toEqual([[12, 200, 240, 1]]);
  });

  it("starts a new life when a wall comes back from a gap in the columns: its own resting size, its own count, though the tracker keeps its history", () => {
    // 120 sold into a wall of 200 (60%). Eleven minutes of no columns: the tracker ends the wall in the hole and brings it
    // back with its 120 eaten when the band is at size again -- at 300 now. 200 more sold is two thirds of 300, not the
    // 160% the life total would say against 200; 110 more makes 310, over the 300, and prints with the new life's numbers.
    const before = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 80, sell: 120 }, { wall: 80 }], 5);
    const gap = 11 * 60_000;
    const after = tape([{ wall: 300 }, { wall: 300 }, { wall: 300 }, { wall: 100, sell: 200 }, { wall: 100 }, { wall: 100 }, { wall: 40, sell: 110 }, { wall: 40 }], 30).map((column) => ({ ...column, ts: column.ts + 5 * STEP + gap }));
    const columns = [...before, ...after];
    expect(detectAbsorption(feedOf(columns.slice(0, 5 + 5)), ROW, RULES, columns[9].ts + 1)).toEqual([]);
    const list = prints(feedOf(columns), ROW, RULES, columns[columns.length - 1].ts + 1);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ts: after[6].ts, shown: 300, resting: 300, absorbed: 310, share: 1 });
  });

  it("counts absorption from the column after the wall opened, so the sweep that made it is not credited", () => {
    const specs: Col[] = [{ wall: 200, sell: 320 }, { wall: 200 }, { wall: 200 }, { wall: 200 }];
    expect(detectAbsorption(feedOf(tape(specs, 30)), ROW, RULES, T + 29 * STEP + 1)).toEqual([]);
  });

  it("meets the chart's bars: a bar closing through the wall ends its life, and orders there again are a new wall with a fresh count", () => {
    // 120 sold at column 3 (60%, short). A bar closes under the band at T + 50 s. The band still holds 200 after, so a new
    // wall is born there; 160 more at column 8 is 80% of its own resting size, not the 140% one life would have reached.
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 80, sell: 120 }, { wall: 80 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 160 }, { wall: 40 }];
    const closes: BarClose[] = [{ ts: T + 5 * STEP, row: 15 }];
    expect(detectAbsorption(feedOf(tape(specs, 30)), ROW, RULES, T + 29 * STEP + 1, closes)).toEqual([]);
    expect(prints(feedOf(tape(specs, 30)), ROW, RULES, T + 29 * STEP + 1, [])).toMatchObject([{ ts: T + 8 * STEP, absorbed: 280, shown: 200, resting: 200 }]);
  });

  it("opens a wall only at the column's floor, read the rules' way: a band of four rows of 50 is 200 summed and 50 by its biggest row", () => {
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40 }];
    const columns = tape(specs, 20);
    expect(detectAbsorption(feedOf(columns), ROW, { ...RULES, wallFloor: () => 250 }, T + 19 * STEP + 1)).toEqual([]);
    expect(detectAbsorption(feedOf(columns), ROW, { ...RULES, wallFloor: () => 100 }, T + 19 * STEP + 1)).toHaveLength(1);
    const byRow: AbsorptionRules = { ...RULES, bandSize: (column, side, band) => bandMaxSizes(column, band, 4)[side] };
    expect(detectAbsorption(feedOf(columns), ROW, { ...byRow, wallFloor: () => 60 }, T + 19 * STEP + 1)).toEqual([]);
    // Against a resting 50 the 240 are the strong ring at once.
    expect(brief(prints(feedOf(columns), ROW, { ...byRow, wallFloor: () => 30 }, T + 19 * STEP + 1))).toEqual([[3, 2, 50, 240]]);
  });

  it("prints nothing without a positive row width or a band", () => {
    const specs: Col[] = [{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40 }];
    expect(detectAbsorption(feedOf(tape(specs, 30)), 0, RULES, T + 29 * STEP + 1)).toEqual([]);
    expect(detectAbsorption(feedOf(tape(specs, 30)), ROW, { ...RULES, bandRows: 0 }, T + 29 * STEP + 1)).toEqual([]);
  });

  it("is the sixth engine: the browser's history store is keyed on it, so hours judged with the old trail are never read back", () => {
    expect(ABSORPTION_ENGINE_VERSION).toBe(6);
  });
});

describe("readPrint", () => {
  // One attack's record: made at T with 240 of 200 resting, grown to 440 four columns on and 540 eight columns on.
  const trailed = (over: Partial<AbsorptionRecord> = {}): AbsorptionRecord => ({
    key: "bid:5:4:0", side: "bid", band: 5, rows: 4, ts: T, attackTs: T - STEP, shown: 200, resting: 200, absorbed: 540, yardstick: 10, refills: 1, price: BAND_MID,
    trail: [{ ts: T, absorbed: 240, current: 40, refills: 0 }, { ts: T + 4 * STEP, absorbed: 440, current: 30, refills: 1 }, { ts: T + 8 * STEP, absorbed: 540, current: 20, refills: 1 }],
    latest: { ts: T + 8 * STEP, absorbed: 540, current: 20, refills: 1 },
    endTs: null, endReason: null, ...over,
  });

  it("reads the sphere at the first entry of the trail that reaches the numbers in hand, holding what the wall held there, with the record's whole flow; nothing when no entry does", () => {
    expect(readPrint(trailed(), RULES)).toEqual({ key: "bid:5:4:0", side: "bid", band: 5, rows: 4, ts: T, attackTs: T - STEP, share: 2, strong: true, shown: 200, resting: 200, absorbed: 540, yardstick: 10, current: 40, refills: 1, price: BAND_MID, judgedAt: T, held: true, broken: false });
    // Twice the wall: the second entry, where 440 clears 400; 500 x the typical level, 500: the third.
    expect(readPrint(trailed(), { ...RULES, absorbedPercent: 200 })).toMatchObject({ ts: T + 4 * STEP, judgedAt: T + 4 * STEP, current: 30, absorbed: 540, share: 2, strong: true });
    expect(readPrint(trailed(), { ...RULES, absorbedMultiple: 50 })).toMatchObject({ ts: T + 8 * STEP, current: 20, share: 1, strong: false });
    // Three times the wall, or sixty times the level, is more than the attack ever absorbed: no sphere at those numbers.
    expect(readPrint(trailed(), { ...RULES, absorbedPercent: 300 })).toBeNull();
    expect(readPrint(trailed(), { ...RULES, absorbedMultiple: 60 })).toBeNull();
    expect(readPrint(trailed({ trail: [{ ts: T, absorbed: 200, current: 40, refills: 0 }] }), { ...RULES, absorbedPercent: 110 })).toBeNull();
  });

  it("reads the strong ring from the newest reading, at the strong share of the wall and the same ratio over the minimum absorbed, even before a kept entry reaches it", () => {
    const two = [{ ts: T, absorbed: 240, current: 40, refills: 0 }, { ts: T + 4 * STEP, absorbed: 440, current: 30, refills: 1 }];
    expect(readPrint(trailed({ trail: two, latest: two[1] }), RULES)).toMatchObject({ ts: T, strong: true, share: 2 });
    const short = [{ ts: T, absorbed: 240, current: 40, refills: 0 }, { ts: T + 4 * STEP, absorbed: 399, current: 30, refills: 1 }];
    expect(readPrint(trailed({ trail: short, latest: short[1] }), RULES)).toMatchObject({ ts: T, strong: false, share: 1 });
    // The newest reading is past twice the wall although no kept entry is yet: the ring is read from it.
    expect(readPrint(trailed({ trail: [two[0]], latest: { ts: T + 5 * STEP, absorbed: 410, current: 30, refills: 1 } }), RULES)).toMatchObject({ ts: T, strong: true, share: 2 });
    expect(readPrint(trailed(), { ...RULES, absorbedPercent: 200, strongPercent: 300 })).toMatchObject({ ts: T + 4 * STEP, strong: false, share: 2 });
    expect(readPrint(trailed(), { ...RULES, absorbedPercent: 200, strongPercent: 270 })).toMatchObject({ ts: T + 4 * STEP, strong: true, share: 2.7 });
    // At a level of 60 the strong ring needs 600 (2 x 5 x 60), and 540 is 270% of the wall but not strong.
    expect(readPrint(trailed({ yardstick: 60 }), RULES)).toMatchObject({ ts: T + 4 * STEP, strong: false, share: 1 });
  });

  it("reads broken from the record's end: a wall closed through or pulled within the break window of the sphere's own column, never one that ended some other way or stands", () => {
    expect(readPrint(trailed({ endTs: T + 2 * STEP, endReason: "closed" }), RULES)?.broken).toBe(true);
    expect(readPrint(trailed({ endTs: T + STEP, endReason: "pulled" }), RULES)?.broken).toBe(true);
    expect(readPrint(trailed({ endTs: T + STEP, endReason: "other" }), RULES)?.broken).toBe(false);
    expect(readPrint(trailed(), RULES)?.broken).toBe(false);
    expect(readPrint(trailed({ endTs: T + RULES.breakWindowMs, endReason: "closed" }), RULES)?.broken).toBe(true);
    expect(readPrint(trailed({ endTs: T + RULES.breakWindowMs + 1, endReason: "closed" }), RULES)?.broken).toBe(false);
    // The window runs from the column the numbers in hand read the sphere at: 200 s after the first entry is past it, 160 s after the second is inside it.
    const ended = trailed({ endTs: T + 20 * STEP, endReason: "closed" });
    expect(readPrint(ended, RULES)?.broken).toBe(false);
    expect(readPrint(ended, { ...RULES, absorbedPercent: 200 })?.broken).toBe(true);
  });
});

describe("AbsorptionTracker", () => {
  // A long stretch: three lives of the wall, sells in bursts and in drips, price wandering over, into and under it.
  const specs: Col[] = [];
  for (let i = 0; i < 240; i += 1) {
    const life = Math.floor(i / 80);
    const j = i % 80;
    const wall = j < 4 ? 240 : j < 40 ? Math.max(30, 240 - j * 5) : j < 48 ? 8 : j < 60 ? 200 : Math.max(0, 200 - (j - 60) * 12);
    const sell = j >= 4 && j < 40 && j % 3 === 1 ? 15 + (j % 5) * 3 : j >= 60 && j % 2 === 0 ? 24 : 0;
    const mid = life === 1 && j >= 20 && j < 30 ? 64 : j % 7 === 6 ? 104 : 100 + (j % 4) * 4;
    specs.push({ wall, sell, mid });
  }
  const columns = tape(specs);
  const closes: BarClose[] = Array.from({ length: 40 }, (_, k) => ({ ts: T + (k + 1) * 6 * STEP, row: k === 2 || k === 3 || k === 12 || k === 22 || k === 23 ? 15 : 26 }));

  it("gives what the one-shot engine gives, fed column by column with time passing, closes and all", () => {
    const tracker = new AbsorptionTracker();
    let last: AbsorptionRecord[] = [];
    for (let i = 1; i <= columns.length; i += 1) {
      if (i % 2 !== 0 && i !== columns.length) continue;
      const now = T + (i - 1) * STEP + 1;
      last = tracker.update(feedOf(columns.slice(0, i)), ROW, RULES, now, closes);
      expect(last).toEqual(detectAbsorption(feedOf(columns.slice(0, i)), ROW, RULES, now, closes));
    }
    expect(last.length).toBeGreaterThanOrEqual(2);
    expect(read(last).some((print) => print.broken)).toBe(true);
    expect(read(last).some((print) => !print.broken)).toBe(true);
    expect(new Set(last.map((record) => record.key)).size).toBe(last.length);
    // A new epoch is a new book: read from the start, the same answer -- and a second new epoch in the same moment too,
    // inside the band tracker's own five-second gate on starting over, which this engine does not lean on for an epoch.
    expect(tracker.update(feedOf(columns, 2), ROW, RULES, T + 240 * STEP, closes)).toEqual(detectAbsorption(feedOf(columns, 2), ROW, RULES, T + 240 * STEP, closes));
    const third = tracker.update(feedOf(columns.slice(0, 78), 3), ROW, RULES, T + 240 * STEP, closes);
    expect(third).toEqual(detectAbsorption(feedOf(columns.slice(0, 78), 3), ROW, RULES, T + 240 * STEP, closes));
    expect(third).toHaveLength(1);
  });

  it("keeps its records when the rule's numbers or the break window change, reading them anew at once, and starts over on the quiet spell or the wall key", () => {
    const tracker = new AbsorptionTracker();
    const now = T + 240 * STEP;
    const records = tracker.update(feedOf(columns), ROW, RULES, now, closes);
    expect(records.length).toBeGreaterThanOrEqual(2);
    // Nothing fed, other numbers: the records come back as they were, no column read again; the reading is the numbers'.
    const stricter: AbsorptionRules = { ...RULES, absorbedPercent: 300, strongPercent: 500, absorbedMultiple: 20, breakWindowMs: 60_000 };
    expect(tracker.update(feedOf([]), ROW, stricter, now, closes)).toEqual(records);
    expect(read(records, stricter).length).toBeLessThan(read(records).length);
    expect(tracker.update(feedOf([]), ROW, { ...RULES, quietMs: 100_000 }, now, closes)).toEqual([]);
    // A shorter quiet spell: sells 110 seconds apart are one attack and print, two attacks and nothing at 100 seconds.
    const spaced = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 80, sell: 150 }, ...Array.from({ length: 10 }, () => ({ wall: 80 })), { wall: 30, sell: 50 }, { wall: 30 }], 34);
    const wide = new AbsorptionTracker();
    expect(wide.update(feedOf(spaced), ROW, RULES, T + 33 * STEP + 1)).toHaveLength(1);
    // The heatmap settings that make the wall floor are part of the rules: another wall key alone starts over (nothing fed, nothing back).
    expect(wide.update(feedOf([]), ROW, { ...RULES, wallKey: "other" }, T + 33 * STEP + 1)).toEqual([]);
    expect(wide.update(feedOf(spaced), ROW, { ...RULES, wallKey: "other", wallFloor: () => 250 }, T + 33 * STEP + 1)).toEqual([]);
    expect(wide.update(feedOf(spaced), ROW, RULES, T + 33 * STEP + 1)).toHaveLength(1);
    expect(wide.update(feedOf(spaced), ROW, { ...RULES, quietMs: 100_000 }, T + 33 * STEP + 1)).toEqual([]);
  });

  it("does not carry wall state or spheres into another instrument with the same numerical rules", () => {
    const tracker = new AbsorptionTracker();
    const first = tape([{ wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 200 }, { wall: 40, sell: 240 }, { wall: 40 }], 20);
    expect(tracker.update(feedOf(first), ROW, RULES, T + 200_000)).toHaveLength(1);
    expect(tracker.update(feedOf([]), ROW, { ...RULES, instrument: "BINANCE:PERPETUAL:ETH-USDT" }, T + 200_001)).toEqual([]);
  });

  it("keeps the spheres it printed when the tier slides forward, and reads no column twice", () => {
    // Sixty columns in view, sliding by seven: the first life's spheres are printed before their columns drop off the
    // tier, and stay; the whole thing equals one read over everything.
    const tracker = new AbsorptionTracker();
    let last: AbsorptionRecord[] = [];
    let keep = 60;
    for (; keep <= columns.length; keep += 7) {
      const window = columns.slice(Math.max(0, keep - 60), keep);
      last = tracker.update(feedOf(window), ROW, RULES, window[window.length - 1].ts + 1, closes);
    }
    const everything = detectAbsorption(feedOf(columns.slice(0, keep - 7)), ROW, RULES, columns[keep - 8].ts + 1, closes);
    expect(last.map((record) => record.key)).toEqual(everything.map((record) => record.key));
    expect(last.some((record) => record.ts < columns[keep - 68].ts)).toBe(true);
  });

  it("starts the read over when a deep tier lands behind the clock, and prints each sphere once", () => {
    // First the fine tier alone from column 100 on; then the deep tier arrives covering columns 0..99 at the same width.
    // The tracker restarts from the book's real start; the spheres from the first hundred columns appear, the later ones
    // are not doubled.
    const tracker = new AbsorptionTracker();
    const late = columns.slice(100);
    tracker.update(feedOf(late), ROW, RULES, late[late.length - 1].ts + 1, closes);
    const withDeep: ColumnFeed = { epoch: 1, deep: { columns: columns.slice(0, 100), columnMs: STEP }, fine: { columns: late, columnMs: STEP } };
    const now = late[late.length - 1].ts + 10_000;
    const records = tracker.update(withDeep, ROW, RULES, now, closes);
    expect(records).toEqual(detectAbsorption(withDeep, ROW, RULES, now, closes));
    expect(new Set(records.map((record) => record.key)).size).toBe(records.length);
    expect(records.some((record) => record.ts < columns[100].ts)).toBe(true);
  });

  it("reads the deep tier alone when the fine tier is empty, as the live chart feeds it", () => {
    const tracker = new AbsorptionTracker();
    const deepOnly: ColumnFeed = { epoch: 1, deep: { columns: columns.slice(0, 120), columnMs: STEP }, fine: { columns: [], columnMs: 1_000 } };
    const records = tracker.update(deepOnly, ROW, RULES, columns[119].ts + STEP, closes);
    expect(records).toEqual(detectAbsorption(feedOf(columns.slice(0, 120)), ROW, RULES, columns[119].ts + STEP, closes));
    expect(records.length).toBeGreaterThan(0);
  });
});
