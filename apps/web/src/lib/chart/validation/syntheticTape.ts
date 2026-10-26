import type { BarFrame, Side, TradeFrame } from "../../../types/frames";
import { AggressiveTape } from "../../indicators/aggressive-orders/aggressiveTape";
import { indicatorTicksOf, type IndicatorTicks } from "../indicatorTicks";
import { BINANCE_PERP, MINUTE_MS, barFrame, seeded, tradeFrame, type FixtureIdentity } from "./fixtures";

/**
 * Synthetic tapes for L1 checks. The central fixture is `whaleVersusCrowd`:
 * two tapes that build the same candle, one from a single whale print and one
 * from a hundred small prints. A candle-only tool cannot tell them apart; an
 * L1 tool that claims to must, and that is the baseline comparison the
 * protocol asks for (check 7). The tapes are real `AggressiveTape`s, so the
 * coverage an indicator reads through `ctx.ticks` is what the terminal would
 * report.
 */

/** A print store whose live recording began at `liveSince`, holding `prints`. */
export function tapeOf(prints: readonly TradeFrame[], liveSince = 0): AggressiveTape {
  const tape = new AggressiveTape(() => liveSince);
  tape.reset();
  for (const print of prints) tape.add(print);
  return tape;
}

/** A print store holding only what the server served for the past, above `floor` (0 means served in full). */
export function historyTapeOf(prints: readonly TradeFrame[], floor: number, fromTs: number, toTs: number): AggressiveTape {
  const tape = new AggressiveTape(() => 0);
  tape.reset();
  tape.addHistory([...prints]);
  tape.coverHistory(fromTs, toTs, floor);
  return tape;
}

export function ticksOf(tape: AggressiveTape): IndicatorTicks {
  const ticks = indicatorTicksOf(tape);
  if (ticks === null) throw new Error("a tape always yields a ticks view");
  return ticks;
}

export interface CandleOfOptions {
  identity?: FixtureIdentity;
  intervalMs?: number;
  /** `null` withholds the print count, the one candle field that would tell a whale from a crowd. */
  tradeCount?: number | null;
  closed?: boolean;
}

/** The candle these prints make: OHLC from the price path, volume and sides summed, count as given. */
export function candleOf(prints: readonly TradeFrame[], ts_open: number, options: CandleOfOptions = {}): BarFrame {
  if (prints.length === 0) throw new Error("candleOf: a candle needs at least one print");
  const sorted = [...prints].sort((a, b) => a.ts_exchange - b.ts_exchange);
  let volume = 0;
  let buy = 0;
  let high = -Infinity;
  let low = Infinity;
  for (const print of sorted) {
    volume += print.size;
    if (print.side === "buy") buy += print.size;
    high = Math.max(high, print.price);
    low = Math.min(low, print.price);
  }
  const frame = barFrame(
    ts_open,
    {
      open: sorted[0].price,
      close: sorted[sorted.length - 1].price,
      high,
      low,
      volume,
      buyShare: volume > 0 ? buy / volume : 0,
      tradeCount: options.tradeCount === undefined ? prints.length : options.tradeCount,
    },
    options.identity ?? BINANCE_PERP,
    options.intervalMs ?? MINUTE_MS,
    options.closed ?? true,
  );
  return frame;
}

export interface WhaleVersusCrowdOptions {
  ts_open?: number;
  intervalMs?: number;
  price?: number;
  /** Size of the one whale print; the crowd's prints sum to exactly this. */
  whaleSize?: number;
  crowdCount?: number;
  side?: Side;
  identity?: FixtureIdentity;
  /**
   * Shared small prints along a price path that both tapes contain, so the
   * candle has a body and wicks. The whale and the crowd then print at `price`
   * at the end of the bar.
   */
  pathPrints?: number;
  pathSize?: number;
  seed?: number;
}

export interface WhaleVersusCrowd {
  /** The one large print (plus any shared path prints). */
  whale: TradeFrame[];
  /** `crowdCount` small prints with the same total (plus the same path prints). */
  crowd: TradeFrame[];
  /** The candle both tapes make, with the print count withheld (`trade_count: null`). */
  candle: BarFrame;
  /** The same candle with its honest counts: the only field on which the two tapes differ. */
  whaleCandle: BarFrame;
  crowdCandle: BarFrame;
  whaleTape: AggressiveTape;
  crowdTape: AggressiveTape;
}

export function whaleVersusCrowd(options: WhaleVersusCrowdOptions = {}): WhaleVersusCrowd {
  const ts_open = options.ts_open ?? 1_780_000_000_000;
  const intervalMs = options.intervalMs ?? MINUTE_MS;
  const price = options.price ?? 60_000;
  const whaleSize = options.whaleSize ?? 50;
  const crowdCount = options.crowdCount ?? 100;
  const side = options.side ?? "buy";
  const identity = options.identity ?? BINANCE_PERP;
  const pathPrints = options.pathPrints ?? 0;
  const pathSize = options.pathSize ?? 0.2;
  const random = seeded(options.seed ?? 11);

  const path: TradeFrame[] = [];
  for (let index = 0; index < pathPrints; index += 1) {
    const ts = ts_open + Math.floor(((index + 1) / (pathPrints + 2)) * intervalMs * 0.8);
    const wander = price + (random() - 0.5) * price * 0.001;
    path.push(tradeFrame(ts, Math.round(wander * 100) / 100, pathSize, random() < 0.5 ? "buy" : "sell", identity, `path-${index}`));
  }
  const burstStart = ts_open + Math.floor(intervalMs * 0.85);
  const whale = [...path, tradeFrame(burstStart, price, whaleSize, side, identity, "whale")];
  const crowd = [...path];
  const small = Math.round((whaleSize / crowdCount) * 1e8) / 1e8;
  let remaining = whaleSize;
  for (let index = 0; index < crowdCount; index += 1) {
    const size = index === crowdCount - 1 ? Math.round(remaining * 1e8) / 1e8 : small;
    remaining -= size;
    crowd.push(tradeFrame(burstStart + Math.floor((index * intervalMs * 0.1) / crowdCount), price, size, side, identity, `crowd-${index}`));
  }
  const candleOptions = { identity, intervalMs };
  return {
    whale,
    crowd,
    candle: candleOf(whale, ts_open, { ...candleOptions, tradeCount: null }),
    whaleCandle: candleOf(whale, ts_open, candleOptions),
    crowdCandle: candleOf(crowd, ts_open, candleOptions),
    whaleTape: tapeOf(whale, ts_open),
    crowdTape: tapeOf(crowd, ts_open),
  };
}

export interface BusyTapeOptions {
  printsPerBar?: number;
  /** Fraction of prints that are "large" (ten times the small size). */
  largeShare?: number;
  /** Fraction of prints that are whales (`whaleMultiple` times the small size); rare by default. */
  whaleShare?: number;
  whaleMultiple?: number;
  smallSize?: number;
  identity?: FixtureIdentity;
  seed?: number;
}

/** Prints for every bar of `bars`, inside each bar's window and range, with rare whales: the busy instrument the marker budget is measured on. */
export function busyTapeFor(bars: readonly BarFrame[], options: BusyTapeOptions = {}): Map<number, TradeFrame[]> {
  const printsPerBar = options.printsPerBar ?? 60;
  const largeShare = options.largeShare ?? 0.02;
  const whaleShare = options.whaleShare ?? 0.002;
  const whaleMultiple = options.whaleMultiple ?? 100;
  const smallSize = options.smallSize ?? 0.1;
  const identity = options.identity ?? BINANCE_PERP;
  const random = seeded(options.seed ?? 5);
  const out = new Map<number, TradeFrame[]>();
  for (const bar of bars) {
    const prints: TradeFrame[] = [];
    for (let index = 0; index < printsPerBar; index += 1) {
      const ts = bar.ts_open + Math.floor(((index + 0.5) / printsPerBar) * bar.interval_ms);
      const price = Math.round((bar.low + random() * (bar.high - bar.low)) * 100) / 100;
      const draw = random();
      const size = draw < whaleShare ? smallSize * whaleMultiple : draw < whaleShare + largeShare ? smallSize * 10 : smallSize * (0.5 + random());
      prints.push(tradeFrame(ts, price, Math.round(size * 1e6) / 1e6, random() < 0.5 ? "buy" : "sell", identity, `${bar.ts_open}-${index}`));
    }
    out.set(bar.ts_open, prints);
  }
  return out;
}
