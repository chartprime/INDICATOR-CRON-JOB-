import type { IcebergOrder } from "../../../types/frames";
import { formatIcebergSize, icebergTotalOf } from "./icebergSettings";

export interface IcebergHover {
  side: "bid" | "ask";
  kind: IcebergOrder["kind"];
  title: string;
  headline: string;
  detailLine: string;
  whenLine: string;
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
}

function span(ms: number): string {
  if (ms < 1000) return "under a second";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function amount(size: number, unit: string): string {
  const text = formatIcebergSize(size);
  return unit ? `${text} ${unit}` : text;
}

export function describeIceberg(iceberg: IcebergOrder, unit: string): IcebergHover {
  const sideWord = iceberg.side === "bid" ? "bid" : "ask";
  const title = `${iceberg.kind === "native" ? "Native" : "Probable"} iceberg · ${sideWord}`;
  const { total, perOrder, orders } = icebergTotalOf(iceberg);
  const shownPerOrder = formatIcebergSize(perOrder);
  const shownTotal = perOrder > 0 ? Number(shownPerOrder) * orders : total;
  const headline = `Total ${amount(shownTotal, unit)} · ${orders === 1 ? "1 order" : `${orders} orders`} of ${amount(perOrder, unit)}`;
  const traded = `${amount(iceberg.executed, unit)} traded`;
  const detailLine = iceberg.status === "active" ? `${traded} · still refilling` : traded;
  const whenLine = `marked ${clock(iceberg.markedAt)} UTC · ${span(iceberg.updatedAt - iceberg.startedAt)}`;
  return { side: iceberg.side, kind: iceberg.kind, title, headline, detailLine, whenLine };
}
