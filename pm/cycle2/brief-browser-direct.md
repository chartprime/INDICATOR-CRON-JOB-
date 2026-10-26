# Build brief: browser-direct Binance data mode (`browser-binance`)

Branch `build/browser-direct-binance`, 2026-10-26. The web app runs with no
runtime server: the worker reads Binance spot from the browser and feeds the
main thread the canonical frames the runtime would send. Opt-in only:
`VITE_DATA_SOURCE=browser-binance` at build time or `?source=browser-binance`.
With neither, every byte the worker sends and receives is unchanged.

## 1. The seam

`marketDataWorker.ts` creates its socket in `connect()` with `new WebSocket(url)`.
That line becomes `createTransport(url, source)`, exported for tests:

```ts
export interface TransportSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}
export function createTransport(url: string, source: DataSource | undefined): TransportSocket {
  return source === "browser-binance" ? new BrowserBinanceTransport(url) : new WebSocket(url);
}
```

A real `WebSocket` satisfies the interface, so the worker's `ws`, `socketCleanup`
and helper parameters are retyped to `TransportSocket` and nothing else changes:
it still sends `capabilities` then `select`, parses every `event.data` string
with `parseServerFrame`, and reconnects on close. The `start` message gains one
optional field, `source: "browser-binance"`, set by `useMarketData.ts` from
`import.meta.env.VITE_DATA_SOURCE` or `location.search` (`resolveDataSource()`);
the query string wins.

`BrowserBinanceTransport` (`apps/web/src/workers/browserBinanceTransport.ts`)
takes injectable `fetch`, `WebSocket`, clock and timers so tests run offline;
every frame leaves it as a JSON `MessageEvent`, so the worker's parser stays
the gate.

## 2. Frame sequence on selection

The worker sends `{"type":"select",...}` as today. When its `onopen` sends no
selection (first start), the transport selects `BTC-USDT` SPOT, as the runtime
pushes its current pair on connect.

For a Binance SPOT pair:

1. `selection`.
2. REST `GET https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=901`
3. `snapshot`: the rows closed 5 s before the request (at most 900, oldest first),
   each a `bar` with `closed: true` and `reconstructed: true` (REST-sourced, as
   `restKlineRowToBarFrame` marks them), `trades: []`, `markers: []`,
   `vpin_status: "DISABLED"`. No `bar_history`: the parser rejects it on Binance.
4. `health` `READY`, `stale: false`, `reason: "BROWSER_DIRECT"`.
5. `book` `UNAVAILABLE`, `reason: "BROWSER_DIRECT_STREAM_CONNECTING"`.
6. The first unconfirmed row as a forming `bar` (`closed: false`).
7. One combined mirror stream
   `wss://data-stream.binance.vision:9443/stream?streams=btcusdt@kline_1m/btcusdt@trade/btcusdt@depth20@100ms`,
   then `bar`, `trade` and `book` frames as events arrive.

A second `select` ends the session and restarts at step 1.

## 3. Payload to frame mapping

| Binance payload | Frame | Fields |
|---|---|---|
| REST kline row `[t,o,h,l,c,v,T,q,n,V,Q,_]` | `bar` | `ts_open: t`, OHLC and `volume` as numbers, `buy_volume: V`, `trade_count: n`, `closed: true`, `reconstructed: true`, `interval_ms: 60000` |
| `kline` event `k` | `bar` | same from `k.t,o,h,l,c,v,V,n`; `closed: k.x` (forming while false, closed once true); no `reconstructed` |
| `trade` event | `trade` | `ts_exchange: T`, `price: +p`, `size: +q`, `side: m ? "sell" : "buy"`, `trade_id: String(t)` |
| `depth20@100ms` `{lastUpdateId,bids,asks}` | `book` | `status: "READY"`, bids/asks as `{price,size}` numbers (zero sizes dropped), `lastUpdateId`, `stale: false` |
| stream close, or no open within 15 s | `health`, `book` | `RECOVERING`, `stale: true`, `reason: "BROWSER_DIRECT_STREAM_CLOSED"`; a READY book is withdrawn (`book UNAVAILABLE`, same reason); reconnect with 1 s to 30 s backoff; after five failures `UNAVAILABLE`, `reason: "BROWSER_DIRECT_STREAM_UNAVAILABLE"`, retries continue |
| every stream open | `bar`, `health` | REST pages (1,000 klines) from the last confirmed close, each row the next consecutive minute, final only if its minute closed 5 s before the request (the stream's own close wins), until continuous with the stream's first close (held meanwhile, at most 120) or the forming minute; then `READY` if degraded. A missing, malformed, short or failed row keeps `RECOVERING` (`BROWSER_DIRECT_REST_FAILED`), retried from that minute; the edge minute waits for the stream's close or a re-read; a gap past 11,000 minutes, or a minute the exchange keeps omitting, re-reads the snapshot |
| REST failure | `health` | `UNAVAILABLE`, `reason: "BROWSER_DIRECT_REST_FAILED"`, retried with the same backoff |

Identity on every frame: `provider: "BINANCE"`, wire `symbol`, `marketKind`
from the selection. Side and `buy_volume` follow `apps/runtime/src/server/frames.js`.

## 4. Honest answers to client requests

| Request | Answer |
|---|---|
| `aggressive_history` | `complete: false`, `reason: "STORAGE_UNAVAILABLE"`, `trades: []`; the client retries three times |
| `delta_profile` | `complete: false`, `reason: "STORAGE_UNAVAILABLE"`, `pending: 0`, `rows: []` |
| `band_history` | `complete: false`, `reason: "GEOMETRY_UNAVAILABLE"`, row fields `null` |
| `wall_history`, `l2_event_history` | `complete: false`, `reason: "HISTORY_UNAVAILABLE"`, `row_width: null`, empty, `next: null` |
| `profile_config`, `profile_history` | `analytics_status` `PROFILE` `UNAVAILABLE` (the browser withdraws the live profile) |
| `capabilities`, `liquidity_resync`, `l2_resync`, `exhaustion_history`, `initiative_history` | ignored: no reply shape exists; L2 indicators keep their "no frame yet" state |
| `heatmap_history`, `heatmap_walls` | untouched: the fetch fails, stores back off |


## 5. Health reason and the visible notice

`BROWSER_DIRECT` rides on the READY health frame. The status chip in
`Terminal.tsx` appends ` (reason)` to `LIVE` when a READY frame carries one,
the form MainPanel uses for UNAVAILABLE. The runtime sends a reason only with
UNAVAILABLE today, so the default display is unchanged.

## 6. Other instruments

- PERPETUAL: `https://fapi.binance.com/fapi/v1/klines` and
  `wss://fstream.binance.com/stream?streams=...`; there is no mirror. The
  first REST or stream failure gives `health` `UNAVAILABLE`,
  `reason: "BROWSER_DIRECT_PERPETUAL_UNREACHABLE"` (retries continue), no hang.
- dxFeed: `selection`, an empty `snapshot`, then `health` `UNAVAILABLE`,
  `reason: "BROWSER_DIRECT_NO_DXFEED"`.

## 7. Unsupported

No L2 engine, heatmap, walls, icebergs, exhaustion, initiative, candle monitor,
profiles or VPIN; no history past 900 bars; no trades before the page opened;
no marker pool; a 20-level book. This container cannot open WebSockets: the
live stream is verified by tests and the REST-only rendering only.
