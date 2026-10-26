// The recorded tape the tape tests share: 10,000 BTC-USDT aggregate trades read
// from Binance's public mirror (/api/v3/aggTrades, ten pages of 1,000) on
// 2026-10-26, stored as [aggTradeId, price, quantity, time, buyerIsMaker] rows,
// gzipped. Loaded as trade frames the way browser-direct mode frames them
// (`a` prefix on the aggregate trade id).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { TradeFrame } from "../../types/frames";

type CompactRow = [a: number, p: string, q: string, T: number, m: 0 | 1];

export function loadRecordedTrades(): TradeFrame[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packed = readFileSync(path.join(here, "fixtures/binance-mirror/aggtrades-btcusdt-10k.json.gz"));
  const rows = JSON.parse(gunzipSync(packed).toString("utf8")) as CompactRow[];
  return rows.map(([a, p, q, T, m]) => ({
    type: "trade", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT",
    ts_exchange: T, price: Number(p), size: Number(q), side: m === 1 ? "sell" : "buy", trade_id: `a${a}`,
  }));
}
