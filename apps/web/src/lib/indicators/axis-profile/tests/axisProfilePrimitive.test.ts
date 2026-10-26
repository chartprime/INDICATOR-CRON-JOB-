// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { SeriesAttachedParameter, Time } from "lightweight-charts";
import { AxisProfilePrimitive, EASE_SHARE, EDGE_GAP_PX, NEIGHBOUR_GAP_PX, type AxisProfileBar, type AxisProfileFrame, type AxisProfileSource } from "../axisProfilePrimitive";

interface Source extends AxisProfileSource {
  rows: number[];
}

const SETTINGS = { widthShare: 0.12 };

class Profile extends AxisProfilePrimitive<Source, AxisProfileBar, { widthShare: number }> {
  changed = 0;
  framed = 0;
  reserve = 0;
  edgeGap = 0;
  factor = 1;

  constructor() {
    super({ ...SETTINGS }, () => []);
  }

  protected override _sourceChanged(): void {
    this.changed += 1;
  }

  protected override _framed(): void {
    this.framed += 1;
  }

  protected override _reservePx(): number {
    return this.reserve;
  }

  protected override _barEdgeGapPx(): number {
    return this.edgeGap;
  }

  protected override _anchorPrice(source: Source): number | undefined {
    return source.rows.at(-1);
  }

  protected _factor(): number {
    return this.factor;
  }

  protected _place(source: Source, _factor: number, yOf: (price: number) => number | null, _height: number): AxisProfileBar[] {
    return source.rows.map((price, index) => ({ index, yTop: (yOf(price + 1) ?? 0), yBottom: yOf(price) ?? 0, share: 1 }));
  }

  protected _targetWidth(_bar: AxisProfileBar, roomPx: number): number {
    return roomPx;
  }

  protected _markerIndex(): number | null {
    return 7;
  }

  protected _shareBounds(): readonly [number, number] {
    return [0.05, 0.6];
  }

  drawBars(): void {}

  drawLabels(): void {}
}

function fakeChart(candleX = 600) {
  const options = { rightOffset: 0, barSpacing: 10 };
  const applied: number[] = [];
  const timeScale = {
    options: () => options,
    width: () => 1_000,
    applyOptions: (next: { rightOffset: number }) => {
      applied.push(next.rightOffset);
      options.rightOffset = next.rightOffset;
    },
    scrollPosition: () => options.rightOffset,
    timeToIndex: () => 5,
    logicalToCoordinate: () => candleX,
  };
  const series = {
    priceToCoordinate: (price: number) => 500 - price * 10,
    data: () => [{ time: 5 }],
  };
  const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }), options: () => ({ layout: {} }) };
  const param = { chart, series, requestUpdate: () => {} } as unknown as SeriesAttachedParameter<Time>;
  return { param, applied };
}

describe("an axis profile's width for the profile beside it", () => {
  let profile: Profile | null = null;

  afterEach(() => {
    profile?.detached();
    profile = null;
  });

  it("is its reach plus what it keeps for its own neighbour before a frame exists, and what the frame drew after", () => {
    profile = new Profile();
    expect(profile.widthPx(1_000)).toBe(120 + EDGE_GAP_PX);
    profile.setNeighbour({ widthPx: () => 140, resize: () => {} });
    expect(profile.widthPx(1_000)).toBe(120 + 140 + NEIGHBOUR_GAP_PX + EDGE_GAP_PX);
    const frame: AxisProfileFrame<AxisProfileBar> = { bars: [], widths: new Map(), flash: new Map(), lastIndex: null, candleRight: 600, barSpacing: 10, intervalMs: 60_000, right: 900, reach: 150, rowPx: 10, width: 1_000, height: 500 };
    profile.frame = frame;
    expect(profile.widthPx(1_000)).toBe(250);
  });
});

describe("the two resize lines", () => {
  it("are always drawn unless a profile says otherwise, and the hovered one is drawn either way", () => {
    const profile = new Profile();
    expect(profile.handlesShown()).toEqual({ edge: true, base: true });
    profile.setHandleHover("edge");
    expect(profile.handlesShown()).toEqual({ edge: true, base: true });
    profile.detached();
  });
});

describe("what a profile brings to the shared drawing", () => {
  let profile: Profile | null = null;

  afterEach(() => {
    profile?.detached();
    profile = null;
  });

  it("hears about a new source, frames its bars with its own room and marker, and reports each frame", () => {
    const { param } = fakeChart();
    profile = new Profile();
    profile.attached(param);
    const source: Source = { version: 1, rowWidth: 1, rows: [10, 11] };
    profile.setSource(source);
    expect(profile.changed).toBe(1);
    profile.setSource(source);
    expect(profile.changed).toBe(1);
    profile.updateAllViews();
    const frame = profile.frame!;
    expect(profile.framed).toBe(1);
    expect(frame.lastIndex).toBe(7);
    expect(frame.right).toBe(1_000 - EDGE_GAP_PX);
    expect(frame.candleRight).toBe(605);
    expect(frame.reach).toBe(120);
    expect(frame.rowPx).toBe(10);
    expect(frame.bars.map((bar) => bar.index)).toEqual([0, 1]);
    expect([...frame.widths.values()].every((width) => width > 0 && width <= 120)).toBe(true);
    profile.factor = 2;
    profile.setNeighbour({ widthPx: () => 140, resize: () => {} });
    profile.updateAllViews();
    expect(profile.frame!.rowPx).toBe(20);
    expect(profile.frame!.right).toBe(1_000 - EDGE_GAP_PX - 140 - NEIGHBOUR_GAP_PX);
  });

  it("slides each bar towards its width a share per frame until it lands", () => {
    const { param } = fakeChart();
    profile = new Profile();
    profile.attached(param);
    profile.setSource({ version: 1, rowWidth: 1, rows: [10] });
    profile.updateAllViews();
    expect(profile.frame!.widths.get(0)).toBeCloseTo(120 * EASE_SHARE, 6);
    profile.updateAllViews();
    expect(profile.frame!.widths.get(0)).toBeCloseTo(120 * EASE_SHARE + (120 - 120 * EASE_SHARE) * EASE_SHARE, 6);
    for (let i = 0; i < 40; i += 1) profile.updateAllViews();
    expect(profile.frame!.widths.get(0)).toBe(120);
  });

  it("keeps the room it reserves and the gap before its bars out of the bars' reach", () => {
    const { param, applied } = fakeChart(870);
    profile = new Profile();
    profile.reserve = 14;
    profile.edgeGap = 12;
    profile.attached(param);
    profile.setSource({ version: 1, rowWidth: 1, rows: [10] });
    expect(applied.at(-1)).toBe(Math.ceil((120 + EDGE_GAP_PX + NEIGHBOUR_GAP_PX + 14) / 10));
    for (let i = 0; i < 40; i += 1) profile.updateAllViews();
    const frame = profile.frame!;
    expect(frame.reach).toBe(1_000 - EDGE_GAP_PX - 875 - NEIGHBOUR_GAP_PX - 14);
    expect(frame.widths.get(0)).toBe(frame.reach - 12);
  });
});

describe("two axis profiles on one chart", () => {
  it("hand the chart back its own right offset once both are off, whichever turns off first", () => {
    for (const firstOff of ["inner", "outer"] as const) {
      const { param, applied } = fakeChart();
      const inner = new Profile();
      const outer = new Profile();
      inner.attached(param);
      outer.attached(param);
      inner.setSource({ version: 1, rowWidth: 1, rows: [10] });
      outer.setNeighbour({ widthPx: () => 140, resize: () => {} });
      outer.setSource({ version: 1, rowWidth: 1, rows: [10] });
      inner.setNeighbour(null);
      expect(applied.at(-1)).toBeGreaterThan(0);
      const [a, b] = firstOff === "inner" ? [inner, outer] : [outer, inner];
      a.setSource(null);
      b.setNeighbour(null);
      b.setSource(null);
      expect(applied.at(-1)).toBe(0);
      inner.detached();
      outer.detached();
    }
  });
});
