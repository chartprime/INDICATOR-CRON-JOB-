import { draw } from "../../chart/draw";
import type { TableHandle } from "../../chart/draw/table";
import type { IndicatorL2 } from "../../chart/indicatorL2";
import type { IndicatorBarCtx, RuntimeIndicatorDef } from "../../chart/indicatorTypes";
import type { L2Channel } from "../../l2/types";

export interface L2StatusRow {
  readonly label: string;
  readonly value: string;
  readonly tone: "good" | "bad" | "neutral";
}

const GOOD = "#26a69a";
const BAD = "#ef5350";
const NEUTRAL = "#d1d4dc";
const CHANNEL_LABELS: ReadonlyArray<readonly [L2Channel, string]> = [
  ["l2_view", "Lanes"],
  ["l2_walls", "Walls"],
  ["l2_events", "Events"],
  ["l2_ladder", "Ladder"],
];

function lag(lastFrameAt: number | null, nowMs: number): string {
  if (lastFrameAt === null) return "no frame yet";
  return `${Math.max(0, Math.round((nowMs - lastFrameAt) / 100) / 10)} s ago`;
}

export function statusRows(l2: IndicatorL2 | undefined, nowMs: number): readonly L2StatusRow[] {
  if (l2 === undefined) return [{ label: "L2 feed", value: "not connected", tone: "bad" }];
  if (l2.availability === "HISTORICAL_UNAVAILABLE") return [{ label: "L2 feed", value: "unavailable in Historical Mode", tone: "neutral" }];
  if (l2.availability === "HISTORICAL") {
    const view = l2.view(0);
    const columns = view?.fine.columns ?? [];
    const trusted = l2.trusted(nowMs);
    const lastTs = l2.status("l2_view").lastTs;
    return Object.freeze([
      { label: "Source", value: "verified historical book states", tone: "neutral" },
      { label: "Book trusted at chart time", value: trusted ? "yes" : "no", tone: trusted ? "good" : "bad" },
      { label: "Depth / sampling", value: "top 10 levels / 1 s close", tone: "neutral" },
      { label: "Trusted columns held", value: String(columns.length), tone: "neutral" },
      { label: "Last recorded second (UTC)", value: lastTs === null ? "none yet" : new Date(lastTs).toISOString(), tone: "neutral" },
      ...CHANNEL_LABELS.filter(([channel]) => channel !== "l2_view").map(([channel, label]): L2StatusRow => ({
        label, value: l2.status(channel).synced ? "available" : "not supplied", tone: "neutral",
      })),
    ] satisfies L2StatusRow[]);
  }
  const segment = l2.segment();
  const rows: L2StatusRow[] = [
    { label: "Walls/events trusted", value: l2.trusted() ? "yes" : "no", tone: l2.trusted() ? "good" : "bad" },
    { label: "Segment", value: segment === null ? "none yet" : `${segment.state} ${segment.id}`, tone: segment?.state !== "LIVE" ? "bad" : l2.trusted() ? "good" : "neutral" },
  ];
  for (const [channel, label] of CHANNEL_LABELS) {
    const status = l2.status(channel);
    const seq = status.seq === null ? "" : ` seq ${status.seq}`;
    rows.push({ label, value: `${status.synced ? "synced" : "untrusted"}${seq}, ${lag(status.lastFrameAt, nowMs)}`, tone: status.synced ? "good" : "bad" });
  }
  const walls = l2.walls();
  const active = walls.filter((wall) => wall.endTs === null).length;
  rows.push({ label: "Walls held", value: `${active} active, ${walls.length - active} ended`, tone: "neutral" });
  const events = l2.events();
  rows.push({ label: "Events held", value: `${events.events.length}, ${events.missed} missed by the cap`, tone: events.missed > 0 ? "bad" : "neutral" });
  const lanes = l2.lanes();
  rows.push({
    label: "Lane coverage",
    value: lanes.length === 0 ? "none yet" : lanes.map((lane) => `${lane.lane}: ${lane.priceLo.toFixed(2)}-${lane.priceHi.toFixed(2)}`).join(" | "),
    tone: "neutral",
  });
  const ladder = l2.ladder();
  rows.push({
    label: "Book held",
    value: ladder === null ? "none yet" : `${ladder.bids.length}x${ladder.asks.length} of ${ladder.depth}, best ${ladder.bids[0]?.[0] ?? "-"} / ${ladder.asks[0]?.[0] ?? "-"}`,
    tone: "neutral",
  });
  return Object.freeze(rows);
}

interface L2FeedStatusState {
  table: TableHandle;
}

export const l2FeedStatusIndicator: RuntimeIndicatorDef<L2FeedStatusState, Record<string, never>> = {
  kind: "runtime",
  id: "l2FeedStatus",
  label: "L2 Feed Status",
  category: "l2",
  defaultSettings: {},
  lines: [],
  placement: { kind: "overlay" },
  readOutput: () => ({}),
  createState(): L2FeedStatusState {
    return { table: draw.table() };
  },
  onBar(ctx: IndicatorBarCtx<L2FeedStatusState, Record<string, never>>): void {
    if (ctx.drawNow === false || (ctx.replaying && ctx.l2?.availability !== "HISTORICAL")) return;
    const rows = statusRows(ctx.l2, ctx.l2?.availability === "HISTORICAL" ? ctx.bar.ts_open + ctx.bar.interval_ms : Date.now());
    rows.forEach((row, index) => {
      ctx.state.table.cell(index, 0, { text: row.label, textColor: NEUTRAL });
      ctx.state.table.cell(index, 1, { text: row.value, textColor: row.tone === "good" ? GOOD : row.tone === "bad" ? BAD : NEUTRAL });
    });
  },
};
