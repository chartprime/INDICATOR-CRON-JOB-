import type { TradeFrame, LiquidityPrint } from "../../types/frames";
import { AggressiveTape, MAX_TAPE_PRINTS } from "../indicators/aggressive-orders/aggressiveTape";
import type { HistoricalL2Row } from "./historicalL2Client";
import type { HistoricalBookSecond } from "./historicalL2States";

class HistoricalTape extends AggressiveTape {
  override readonly historical: boolean = true;
}

/** Individual source prints, not the engine's size-attributed wall-trade totals. */
export function historicalPrints(rows: readonly HistoricalL2Row[], seconds: readonly HistoricalBookSecond[],
  instrument: string, derivation: string, cutNs: string) {
  if (rows.length > Math.min(100000, MAX_TAPE_PRINTS)) throw new Error("Historical trades exceed the chart budget; zoom in.");
  const cut = BigInt(cutNs), identity = JSON.parse(instrument) as string[];
  const trades: TradeFrame[] = [], groups = new Map<string, LiquidityPrint[]>(), ids = new Set<string>();
  const byOpen = new Map(seconds.map((second) => [second.openNs, second]));
  let position = -1n, previous = -1n, unknownCount = 0;
  for (const row of rows) {
    const p = row.payload, known = BigInt(row.known_ns);
    if (row.schema !== "historical-l2-print-record/1" || row.instrument_id !== instrument || row.derivation_id !== derivation
        || BigInt(row.append_position) <= position || known < previous || known > cut || p.known_ns !== row.known_ns
        || p.schema !== "historical-l2-source-print/1" || typeof p.event_ns !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(p.event_ns)
        || BigInt(p.event_ns) > known || !["BUY", "SELL", "UNKNOWN"].includes(String(p.side))
        || typeof p.size !== "number" || !Number.isSafeInteger(p.size) || p.size <= 0
        || typeof p.price !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/.test(p.price)
        || typeof p.record_id !== "string" || !(/^[a-f0-9]{64}$/.test(p.record_id)
          || identity[1] === "FUTURE" && /^raw:[a-f0-9]{64}:(0|[1-9][0-9]*)$/.test(p.record_id)
            && p.record_id.split(":")[2] === row.known_key?.[2]) || ids.has(p.record_id)
        || JSON.stringify(row.known_key) !== JSON.stringify(p.known_key)) throw new Error("Historical print identity/order differs.");
    const price = Number(p.price);
    if (!(price > 0) || !Number.isFinite(price)) throw new Error("Historical print price is invalid.");
    ids.add(p.record_id); position = BigInt(row.append_position); previous = known;
    if (p.side === "UNKNOWN") { unknownCount += 1; continue; }
    const event = BigInt(p.event_ns), ts = Number(event / 1000000n), side = p.side === "BUY" ? "buy" : "sell";
    trades.push({ type: "trade", provider: "DATABENTO", assetClass: identity[1] as "FUTURE" | "EQUITY",
      symbol: identity[2], ts_exchange: ts, price, size: p.size, side, trade_id: p.record_id });
    const open = (event / 1000000000n * 1000000000n).toString(), second = byOpen.get(open);
    // A late print never changes the evidence that was available at an earlier column's close.
    if (second?.column !== null && second !== undefined && known <= BigInt(second.knownNs)) {
      const group = groups.get(open) ?? [];
      group.push({ ts, price, size: p.size, side, id: p.record_id }); groups.set(open, group);
    }
  }
  const tape = new HistoricalTape(() => Number(cut / 1000000n));
  tape.reset(trades);
  const withPrints = seconds.map((second) => second.column === null ? second : { ...second, column: {
    ...second.column, prints: groups.get(second.openNs) ?? [], printsFloor: 0,
  } });
  return { tape, seconds: withPrints, unknownCount };
}
