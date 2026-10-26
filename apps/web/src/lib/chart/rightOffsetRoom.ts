import type { IChartApiBase, Time } from "lightweight-charts";

interface Room {
  base: number;
  applied: number | null;
  wanted: Map<object, number>;
}

const rooms = new WeakMap<object, Room>();
const LIVE_EDGE_TOLERANCE_BARS = 0.5;

export function claimRightOffset(chart: IChartApiBase<Time>, owner: object, wanted: number | null, force = false): void {
  const timeScale = chart.timeScale();
  const options = timeScale.options();
  let room = rooms.get(chart);
  if (room === undefined) {
    room = { base: options.rightOffset, applied: null, wanted: new Map() };
    rooms.set(chart, room);
  } else if (room.applied !== null && options.rightOffset !== room.applied) {
    room.base = options.rightOffset;
  }
  if (wanted === null) room.wanted.delete(owner);
  else room.wanted.set(owner, wanted);
  const next = Math.max(room.base, ...room.wanted.values());
  room.applied = next;
  if (next === options.rightOffset && !force) return;
  const followingLive = timeScale.scrollPosition() >= options.rightOffset - LIVE_EDGE_TOLERANCE_BARS;
  const held = followingLive ? null : timeScale.getVisibleLogicalRange();
  timeScale.applyOptions({ rightOffset: next });
  if (held !== null) timeScale.setVisibleLogicalRange(held);
}
