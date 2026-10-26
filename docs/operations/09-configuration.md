# Configuration

[Handbook](../README.md) · [Onboarding](00-developer-onboarding.md) ·
[Server runbook](03-server-runbook.md) · [Operator tooling](08-operator-tooling.md)

Every setting the code reads is listed below, with the processes that read it,
the values it accepts, whether it is a secret and where it is set. The list is
generated from `apps/runtime/src/platform/config-registry.js`, and
`npm run docs:check` fails when the two disagree.

## How settings are checked

- **At start.** Terminal C, both collectors, live-storage and the gateway check
  their own settings before they open anything. A setting that is present but
  invalid stops the process with one line per problem, for example
  `config: L2_HEATMAP_DEEP_S must be a number, at least 0`. Values are never
  printed. An empty value counts as unset. A missing gateway or live-storage
  secret still starts the service in its refusing state, reported by `/health`.
- **Likely typos.** A name with a project prefix (`TT_`, `L2_`, `DXFEED_`,
  `BINANCE_`, `VITE_`, `DENSITY_`) that nothing reads is reported as a warning.
- **Before you start.** `npm run doctor` runs the same check on your `.env`.
- **Least privilege.** Terminal C copies only its own settings from the
  repository `.env`, and Terminal D only `VITE_*`, `TT_LIVE_PROXY_URL` and
  `TT_ARCHIVE_PROXY_URL`. Operator keys kept in the same file never reach
  either process. Operator scripts still load the whole file with `--env-file`.
- **Node.** `npm start`, `npm run dev` and the web dev server run through
  `scripts/node-launcher.cjs`. If your shell's Node is not 24.21.0, it runs the
  pinned Node from `TT_NODE_BIN` (in `.env` or the shell), nvm, fnm or volta,
  and refuses to start when none is found.
- **Host.** Python services and host scripts parse their own settings;
  `ops/linux-host/scripts/check-service-env.sh` checks each service file's
  owner, mode and required keys. Before a deploy, check a host file with
  `node apps/runtime/scripts/verify/check-config.js <process> --env-file <file>`.

## Terminal C and D

| Setting | Read by | Accepts | Secret | Set in | Meaning |
|---|---|---|---|---|---|
| `TT_DATA_ROOT` | terminal-c, collector, dxfeed-collector, live-storage, gateway | an absolute path |  | host unit / .env | Root of captured market data and local stores (default apps/runtime/data) |
| `TT_LOG_DIR` | terminal-c, collector, dxfeed-collector, live-storage, gateway | an absolute path |  | host unit / .env | Directory for dated operator log files (default apps/runtime/logs) |
| `TT_RUNTIME_DIR` | terminal-c, collector, dxfeed-collector, live-storage, gateway | an absolute path |  | host unit / .env | Directory for runtime state such as the collector health file (default apps/runtime/run) |
| `TT_NODE_BIN` | terminal-c, terminal-d, operator | a path |  | .env | Node 24.21.0 executable or its directory; the launcher runs this when the shell's node differs |
| `TT_LIVE_STORAGE_SERVICE_URL` | terminal-c, bench | an absolute http(s) URL |  | .env (layer 1) | Gateway live-storage base URL, ending in /live-storage |
| `TT_LIVE_STORAGE_CLIENT_TOKEN` | terminal-c, bench | any text | yes | .env (layer 1) | Your gateway bearer, for warm-up reads |
| `TT_L2_PREVIEW_HOST` | operator | 127.0.0.1 or 10.88.0.1 |  | isolated qualification preview only | Historical L2 preview bind: loopback by default or the existing private WireGuard interface |
| `TT_ARCHIVE_PROXY_URL` | terminal-c, terminal-d, bench | an http(s) origin without path, query or credentials |  | .env (layer 1) | Gateway origin that Terminal D proxies /archive to |
| `TT_LIVE_PROXY_URL` | terminal-c, terminal-d | an http(s) origin without path, query or credentials |  | .env | Local runtime origin for /ws and /health (default http://127.0.0.1:8001); never the host |
| `VITE_ARCHIVE_CLIENT_TOKEN` | terminal-c, terminal-d, bench | any text | yes | .env (layer 1) | Your gateway bearer, used by the browser for Historical Mode |
| `VITE_ALLOWED_HOST` | terminal-d | any text |  | shell | Extra host name the Vite dev server accepts (tunnel sharing) |
| `VITE_BACKEND_WS_URL` | terminal-d | any text |  | shell | Override for the browser's WebSocket URL |
| `EXTRA_ALLOWED_ORIGIN` | terminal-c | an http(s) origin without path, query or credentials |  | shell | Extra browser origin the runtime accepts (tunnel sharing) |
| `TT_DXFEED_TOKEN_BROKER_URL` | terminal-c, dxfeed-collector, operator | an https *.ts.net origin without path, query or credentials |  | .env (layer 2) / collect service.env | dxFeed token broker, an https *.ts.net origin |
| `TT_DXFEED_TOKEN_TIMEOUT_MS` | terminal-c, dxfeed-collector, operator | a number, above 0 |  | .env | Deadline for one broker token request (default 30000) |
| `TT_VPIN_ENABLED` | terminal-c | 0 or 1 |  | .env | 0 disables VPIN warm-up and live polling (default on) |
| `BINANCE_TRADE_QUEUE_DEPTH` | terminal-c | a whole number, above 0 |  | .env | Binance trade queue depth before overflow (default 5000) |
| `TT_BINANCE_SPOT_WS_BASE_URL` | terminal-c | a ws(s) origin without path, query or credentials |  | .env | Binance spot stream origin (default wss://stream.binance.com); the market-data mirror wss://data-stream.binance.vision:9443 is not geo-blocked. USD-M perpetuals keep their fixed origin |
| `TT_BINANCE_SPOT_REST_BASE_URL` | terminal-c | an http(s) origin without path, query or credentials |  | .env | Binance spot REST origin for depth snapshots and candle backfill (default https://api.binance.com); the market-data mirror https://data-api.binance.vision is not geo-blocked. USD-M perpetuals keep their fixed origin |
| `TT_BINANCE_TRANSPORT` | terminal-c | ws or rest |  | .env | Binance transport: ws streams every trade and depth diff (default); rest polls the spot REST API for 1m candles only, with no tape and no order book, for a host that cannot open a WebSocket |
| `TT_BINANCE_REST_POLL_MS` | terminal-c | a whole number, at least 250, at most 20000 |  | .env | REST transport: milliseconds between polls of a pair's candles (default 1000; at most 20000, so at least two polls a minute fall outside the one-second finalisation grace); the weight budget may lengthen it up to that cap |
| `TT_BINANCE_REST_WEIGHT_BUDGET` | terminal-c | a whole number, at least 100, at most 5000 |  | .env | REST transport: Binance REQUEST_WEIGHT reserved per minute before each request (default 4000); the exchange limit is 6000, so at most 5000 |
| `L2_MEMORY_DEBUG` | terminal-c | 0 or 1 |  | .env | 1 logs L2 memory debugging |
| `L2_ICEBERG` | terminal-c | 0 or 1 |  | .env | 0 turns the Iceberg Detector off (default on): no trackers, no history restore or save, no host fill; the channel still answers with empty pages |
| `L2_ICEBERG_HISTORY` | terminal-c | 0 or 1 |  | .env | 0 keeps iceberg histories in memory only, never on disk, and asks the host for nothing (default on) |
| `L2_ICEBERG_STORE_DIR` | terminal-c | a path |  | .env | Directory of the per-instrument iceberg history files (default <data root>/icebergs) |
| `L2_ICEBERG_STORE_S` | terminal-c | a number, above 0 |  | .env | Seconds between background saves of a dirty iceberg history (default 300) |
| `L2_ICEBERG_MAX_AGE_S` | terminal-c | a number, above 0 |  | .env | Age after which a settled iceberg leaves the history (default 7 days) |
| `L2_ICEBERG_HOST_FILL` | terminal-c | 0 or 1 |  | .env | 0 stops asking the host for the iceberg history of the spans this runtime did not watch (default on when the gateway URL and token are set) |
| `L2_ICEBERG_FILL_DELAY_S` | terminal-c | a number, at least 0 |  | .env | Seconds after start before the first host iceberg-history fill; 0 fills at once (default 120) |
| `L2_ICEBERG_FILL_EVERY_S` | terminal-c | a number, above 0 |  | .env | Seconds between host iceberg-history fills (default 1800) |
| `L2_EXHAUSTION` | terminal-c | 0 or 1 |  | .env | 0 stops the Exhaustion engines and the Candle Monitor, which shares their timer (default on); the channel still answers with empty pages |
| `L2_EXHAUSTION_HOST_FILL` | terminal-c | 0 or 1 |  | .env | 0 switches the Exhaustion host read off: no start fill below the live start, no history asks (default on; a host that answers NO_HOST switches it off by itself) |
| `L2_EXHAUSTION_HISTORY` | terminal-c | 0 or 1 |  | .env | 0 keeps exhaustion shades in memory only, never on disk (default on) |
| `L2_EXHAUSTION_STORE_DIR` | terminal-c | a path |  | .env | Directory of the per-instrument exhaustion history files (default <data root>/exhaustion) |
| `L2_EXHAUSTION_STORE_S` | terminal-c | a number, above 0 |  | .env | Seconds between background saves of a dirty exhaustion history (default 300) |
| `L2_EXHAUSTION_MAX_AGE_S` | terminal-c | a number, above 0 |  | .env | Age after which a judged exhaustion shade leaves the history (default 7 days) |
| `L2_EXHAUSTION_FILL_S` | terminal-c | a number, above 0 |  | .env | Span of the host's columns a pair reads below its live start before its exhaustion engines go live: the newest hours that hold columns adding up to these seconds, empty hours walked past (default one day; the age cap bounds it) |
| `L2_EXHAUSTION_FILL_CONCURRENCY` | terminal-c | a whole number, above 0 |  | .env | Hours of the host's columns the exhaustion history walk reads at once (default 3) |
| `L2_INITIATIVE` | terminal-c | 0 or 1 |  | .env | 0 stops the Initiative Continuation engines (default on); the channel still answers with empty pages |
| `L2_INITIATIVE_HISTORY` | terminal-c | 0 or 1 |  | .env | 0 keeps initiative bands in memory only, never on disk (default on) |
| `L2_INITIATIVE_HOST_FILL` | terminal-c | 0 or 1 |  | .env | 0 switches the Initiative Continuation host read off: no start fill below the live start, no history asks (default on; a host that answers NO_HOST switches it off by itself) |
| `L2_INITIATIVE_STORE_DIR` | terminal-c | a path |  | .env | Directory of the per-instrument initiative history files (default <data root>/initiative) |
| `L2_INITIATIVE_STORE_S` | terminal-c | a number, above 0 |  | .env | Seconds between background saves of a dirty initiative history (default 300) |
| `L2_INITIATIVE_MAX_AGE_S` | terminal-c | a number, above 0 |  | .env | Age after which an initiative band leaves the history, counted from its frozen candle (default 7 days) |
| `L2_INITIATIVE_FILL_S` | terminal-c | a number, above 0 |  | .env | Span of the host's columns a pair reads below its live start before its initiative engines go live: the newest hours that hold columns adding up to these seconds, empty hours walked past (default one day; the age cap bounds it) |
| `L2_INITIATIVE_FILL_CONCURRENCY` | terminal-c | a whole number, above 0 |  | .env | Hours of the host's columns the initiative history walk reads at once (default 3) |
| `L2_BAND_BP` | terminal-c | a number, above 0 |  | .env | L2 memory band width in basis points of price |
| `L2_MIN_SLICE_USD` | terminal-c | a number, above 0 |  | .env | Smallest resting notional the L2 ledger keeps |
| `L2_MIN_SLICE_SIZE` | terminal-c | a number, at least 0 |  | .env | Smallest resting size the L2 ledger keeps when no quote is known |
| `L2_HEATMAP_TRACK_ALL` | terminal-c | 0 or 1 |  | .env | 1 keeps heatmap history for every Binance pair, not only the selected one |
| `L2_HEATMAP_ROW_BP` | terminal-c, heatmap-pyramid | a number, above 0 |  | .env | Heatmap row height in basis points (default 0.5) |
| `L2_HEATMAP_WINDOW_BP` | terminal-c, heatmap-pyramid | a number, above 0 |  | .env | Heatmap half-window around the mid in basis points (default 600) |
| `L2_HEATMAP_COLUMN_MS` | terminal-c | a number, above 0 |  | .env | Recent-tier column width in ms (default 1000) |
| `L2_HEATMAP_HISTORY_S` | terminal-c | a number, above 0 |  | .env | Seconds of recent tier replayed to a new client (default 1200) |
| `L2_HEATMAP_DEEP_S` | terminal-c | a number, at least 0 |  | .env | Seconds of deep tier; 0 disables it (default 14400) |
| `L2_HEATMAP_FILL_S` | terminal-c | a number, at least 0 |  | .env | Seconds the wall and event histories are filled back from the recording after start, bounded by the store age; 0 disables it (default 86400) |
| `L2_LANE_WALLS` | terminal-c | 0 or 1 |  | .env | Walls on the wider heatmap lanes, tracked in a worker for the pair on screen; 0 disables them (default 1) |
| `L2_HEATMAP_HISTORY` | terminal-c | 0 or 1 |  | .env | The wall and event histories behind the `wall_history` and `l2_event_history` requests: recorded live, stored beside the heatmap store and filled from the recording; 0 keeps them empty and answers the requests with HISTORY_UNAVAILABLE (default 1) |
| `L2_HEATMAP_DEEP_COLUMN_MS` | terminal-c | a number, above 0 |  | .env | Deep-tier column width in ms (default 10000) |
| `L2_HEATMAP_DEEP_CHUNK_S` | terminal-c | a number, above 0 |  | .env | Seconds per deep-tier rebuild pass (default 1200) |
| `L2_HEATMAP_COARSE_S` | terminal-c | a number, at least 0 |  | .env | Seconds of optional coarse tier; 0 disables it (default 0) |
| `L2_HEATMAP_COARSE_COLUMN_MS` | terminal-c | a whole number, above 0 |  | .env | Coarse-tier column width in ms (default 300000; a multiple of the deep width) |
| `L2_HEATMAP_COARSE_ROWS` | terminal-c | a whole number, above 0 |  | .env | Fine rows combined into each coarse row (default 40) |
| `L2_WIRE` | terminal-c | 0 or 1 |  | .env | 0 stops collecting the opt-in L2 channels (`l2_view`, `l2_walls`, `l2_events`, `l2_ladder`); clients that declared them then receive none. Default on. The `liquidity` heatmap is unaffected either way |
| `L2_HEATMAP_LANES` | terminal-c | 0 or 1 |  | .env | 0 turns off the wider heatmap lanes (default on: crypto to ±7 %, futures and equities to ±3 %; `l2.windowPct` per instrument in `config/market-instruments.json` overrides) |
| `L2_HEATMAP_STORE` | terminal-c | 0 or 1 |  | .env | 0 stops keeping computed columns on disk (default on) |
| `L2_HEATMAP_STORE_DIR` | terminal-c | a path |  | .env | Directory of the liquidity store (default <data root>/liquidity) |
| `L2_HEATMAP_STORE_S` | terminal-c | a number, above 0 |  | .env | Seconds between store writes; a store that has not changed is not rewritten (default 300) |
| `L2_HEATMAP_STORE_MAX_AGE_S` | terminal-c | a number, above 0 |  | .env | A stored history older than this is ignored (default 7 days) |
| `L2_HEATMAP_STORE_MAX_BYTES` | terminal-c | a number, above 0 |  | .env | Store size budget before the oldest columns are trimmed (default 48 MiB) |
| `L2_HEATMAP_LEVEL_MIN_USD` | terminal-c | a number, above 0 |  | .env | Resting notional floor for a tracked wall (default 500000) |
| `L2_HEATMAP_WALL_MULT` | terminal-c | a number, at least 0 |  | .env | A wall is at least this many times the typical row (default 3) |
| `L2_HEATMAP_REF_BP` | terminal-c | a number, above 0 |  | .env | Distance from the mid within which the typical row is measured (default 50) |
| `L2_HEATMAP_WALL_SETTLE_MS` | terminal-c | a whole number, at least 0 |  | .env | How long a vanished wall waits for its trades (default 5000) |
| `L2_HEATMAP_WALL_GAP` | terminal-c | a whole number, at least 0 |  | .env | Thinner rows a wall may bridge (default 2) |
| `L2_HEATMAP_BACKFILL` | terminal-c | 0 or 1 |  | .env | 0 stops rebuilding history from the recording (default on) |
| `L2_HEATMAP_BACKFILL_MAX_S` | terminal-c | a number, above 0 |  | .env | Most seconds of a gap replayed at fine resolution (default 600) |
| `L2_HEATMAP_BACKFILL_WORKERS` | terminal-c | a whole number, above 0 |  | .env | Rebuild passes running at once (default 1) |
| `L2_HEATMAP_BACKFILL_TIMEOUT_S` | terminal-c | a number, above 0 |  | .env | A rebuild pass still running after this is stopped (default 300) |
| `L2_HEATMAP_BACKFILL_ANNOUNCE_S` | terminal-c | a number, above 0 |  | .env | Most often the selected pair's rebuilt history is replayed to clients, apart from a pass landing (default 60) |
| `L2_HEATMAP_HISTORY_FLOOR` | terminal-c | an ISO date-time |  | .env | Nothing older is restored or backfilled |
| `L2_HEATMAP_DB_PATH` | terminal-c | a path |  | .env | Binance recording the heatmap rebuilds from (default the collector database) |
| `L2_HEATMAP_DXFEED_DB_PATH` | terminal-c | a path |  | .env | dxFeed recording the heatmap rebuilds from |
| `L2_HEATMAP_PYRAMID` | terminal-c | 0 or 1 |  | .env | 0 stops reading the host heatmap pyramid for pinned rows and a fast deep warm-up (default on) |
| `L2_HEATMAP_FUTURE_ROW_TICKS` | terminal-c, heatmap-pyramid | a whole number, above 0 |  | .env | Heatmap row width on futures, in ticks (default 1) |
| `L2_HEATMAP_EQUITY_ROW_TICKS` | terminal-c, heatmap-pyramid | a whole number, above 0 |  | .env | Heatmap row width on equities, in ticks (default 1) |
| `L2_HEATMAP_DXFEED_DIFF_MS` | terminal-c | a whole number, above 0 |  | .env | Order-event burst gathered before the dxFeed book is diffed, ms (default 250) |
| `L2_AGGRESSIVE` | terminal-c | 0 or 1 |  | .env | 0 stops aggressive-order clusters on the wire (default on) |
| `L2_AGGRESSIVE_PERCENTILE` | terminal-c | a number, above 0, at most 1 |  | .env | Percentile a cluster must reach before it is sent (default 0.9) |
| `L2_AGGRESSIVE_FLOOR` | terminal-c | a number, above 0, at most 10000000 |  | .env | Fixed reporting floor in base units instead of the percentile |
| `L2_AGGRESSIVE_MIN` | terminal-c | a number, at least 0, at most 10000000 |  | .env | Floor under the calibrated floor, in base units |

### Binance REST transport (`TT_BINANCE_TRANSPORT=rest`)

For a host that cannot open a WebSocket (a cloud container whose proxy refuses
upgrades, a region Binance's primary API blocks). Spot only; set
`TT_BINANCE_SPOT_REST_BASE_URL=https://data-api.binance.vision` beside it when
`api.binance.com` is blocked. Nothing changes while the setting is absent.

**What it serves: 1m candles**, from `/api/v3/klines`, each with open, high,
low, close, volume, taker-buy volume (the sided candle flow) and trade count,
forming and closed. Every `TT_BINANCE_REST_POLL_MS` the previous and the
forming bar are read. Every row is classified by its own open and close time
against the exchange clock as it stood when the request was sent, never by
its position, by the machine clock or by the time of receipt: a bar is final
only when the request left one second or more after its close time on the
exchange (the exchange may build a row before the candle closes, so a row
received after the close is kept forming until a later poll confirms it), and
it is emitted closed exactly once; the forming bar is re-sent only when one of
its seven fields changed; a response from an older poll never overwrites a
newer one. The candle backfill applies the same rule to its pages. The
exchange clock comes from the `exchangeInfo` probe that brings the route up
(`serverTime`) and is re-read from `/api/v3/time` once a minute; a failed
refresh keeps the last offset. After an outage of more than one bar the poller
catches up from the last confirmed close, in pages of up to 1000 candles, at
most 10 pages back to back before it yields for one cadence and continues; the
health reason reads `catching up` until it is current. A page that starts past
the next expected minute does not move the cursor: the exchange is asked again
from the first missing minute, three times, with the reason still `catching
up`; if it never supplies the interval, the cursor moves past it and the reason
reads `history incomplete (N min missing)` for the rest of the session. The
cursor's first request fixes the earliest minute it is responsible for, so a
pause before the first confirmed close is caught up too, never skipped. A
response is an observation of the pair only when it carries an expected
candle (the next one or later, the forming one included); an empty page, or
one holding only candles already confirmed, leaves the cursor where it is,
does not refresh the feed, and keeps it degraded with the reason `awaiting
candles` until the exchange supplies what is expected. The poll interval is
capped at 20 s so that at least two polls a minute fall outside the grace.

**What it does not serve.** There is no tape and no order book. No trade frame
is sent; the book is `UNAVAILABLE` with reason `REST_NO_DEPTH`. Unavailable:
time and sales, Large Trade Bubbles and large-trade markers, aggressive-print
clusters, every `ctx.ticks` and `ctx.trades` indicator (VWAP bands on prints,
tick intensity), VPIN, the DOM, the Passive Liquidity heatmap and its walls,
the L2 memory indicators (liquidity voids, L2 feed status), the Iceberg
Detector, Exhaustion, Initiative Continuation, the `l2_*` channels and
`bandHistory`. Works: candles and every resampled timeframe, `buy_volume` and
`sell_volume` from taker-buy volume (`barSides`), `trade_count`, the candle
backfill and Historical Mode candles, and every candle-only indicator (RSI,
relative volume, structure, volatility, candle flow).

**Health.** The feed's reason reads `Polled spot candles · no tape · no order
book`, with `· rate limited` (a 429 or an IP ban: polling paused for
`Retry-After`), `· poll failed` (the last poll failed or the route is down),
`· catching up`, `· awaiting candles`, `· slow polling (weight budget)` or
`· history incomplete (N min missing)` appended while they apply.
The health frame's state follows the candle feed; the tape and depth feeds
are reported unavailable and do not change that state. `/health` reports
`delivery.transport: "rest"`, the cadence, the weight used and the exchange
clock offset.

**Weight.** The guarantee is this runtime's reserved dispatch budget: every
request reserves its weight before it is sent (klines 2, `exchangeInfo` 20 for
the connect probe and for each tick-size lookup, `time` 1, candle backfill 2
per page), against `TT_BINANCE_REST_WEIGHT_BUDGET` per calendar minute
(default 4000, at most 5000; the exchange limit is 6000). The exchange's own
`x-mbx-used-weight-1m` raises the count when it is higher, and reservations
keep adding on top of it. One gate holds every request, polls, clock refresh,
backfill pages and tick-size lookups alike, during a rate-limit pause or an IP
ban, and a 429 or 418 on any of them pauses all of them. The steady cadence plans on 90 % of the
budget and is lengthened in whole multiples of the poll interval when the
pairs would not fit; the reason then says `slow polling`. The budget is never
exceeded to keep a cadence. One pair at 1 s costs about 121 of 4000 per minute.

**Proxy.** Node's built-in `fetch` ignores `HTTPS_PROXY` unless
`NODE_USE_ENV_PROXY=1` is set (Node 22.21 and later; the project pins 24.21.0).
A custom CA is read from `NODE_EXTRA_CA_CERTS`, not from `SSL_CERT_FILE`. The
stream transport (`ws`) never used a proxy and still does not.

## Collectors

| Setting | Read by | Accepts | Secret | Set in | Meaning |
|---|---|---|---|---|---|
| `DXFEED_ENDPOINT` | dxfeed-collector, operator | any text |  | set by the token wrapper | Approved dxLink endpoint, supplied per session by run-with-dxfeed-token |
| `DXFEED_TEMP_TOKEN` | dxfeed-collector, operator | any text | yes | set by the token wrapper | Short-lived dxFeed token, supplied per session by run-with-dxfeed-token |
| `MARKET_DATA_MODE` | dxfeed-collector, operator | realtime or delayed |  | set by the token wrapper | Feed mode matching DXFEED_ENDPOINT |
| `DXFEED_TOKEN_EXPIRES_AT` | dxfeed-collector, operator | any text |  | set by the token wrapper | Expiry of DXFEED_TEMP_TOKEN |
| `TT_MAX_DB_BYTES` | collector, dxfeed-collector | a positive whole number of bytes |  | collect service.env | Capture database size limit; capture stops above it |
| `TT_MIN_FREE_DISK_BYTES` | collector, dxfeed-collector | a positive whole number of bytes |  | collect service.env | Free-disk reserve; capture stops below it |

## Live-storage and gateway

| Setting | Read by | Accepts | Secret | Set in | Meaning |
|---|---|---|---|---|---|
| `TT_LIVE_STORAGE_PORT` | live-storage | a whole number, above 0, at most 65535 |  | live-storage service.env | Live-storage listen port (default 8003) |
| `TT_LIVE_STORAGE_HOST` | live-storage | any text |  | live-storage service.env | Live-storage bind address, loopback only |
| `TT_LIVE_STORAGE_DB_PATH` | live-storage | a path |  | live-storage service.env | Binance capture database read by live-storage |
| `TT_LIVE_STORAGE_DXFEED_DB_PATH` | live-storage | a path |  | live-storage service.env | dxFeed capture database read by live-storage |
| `TT_HEATMAP_DIR` | terminal-c, live-storage, heatmap-pyramid | a path |  | host unit / .env | Heatmap pyramid stores: written by the pyramid, read by live-storage, and by Terminal C when it reads locally (default <data root>/heatmap) |
| `TT_PYRAMID_BINANCE_DB_PATH` | heatmap-pyramid | a path |  | host unit | Binance capture database the pyramid replays |
| `TT_PYRAMID_DXFEED_DB_PATH` | heatmap-pyramid | a path |  | host unit | dxFeed capture database the pyramid replays |
| `TT_PYRAMID_RETENTION_DAYS` | heatmap-pyramid | a number, above 0 |  | host unit | Days of pyramid kept at every level (default 7) |
| `TT_PYRAMID_CYCLE_MS` | heatmap-pyramid | a whole number, above 0 |  | host unit | Wait between pyramid cycles with nothing to build, ms (default 60000) |
| `TT_PYRAMID_WINDOWS_PER_CYCLE` | heatmap-pyramid | a whole number, above 0 |  | host unit | 5 min windows one pair builds before the next pair gets a turn (default 12) |
| `TT_PYRAMID_WARMUP_MS` | heatmap-pyramid | a whole number, above 0 |  | host unit | Replay before each run of windows, so the book near the mid is settled, ms (default 1800000) |
| `TT_PYRAMID_PAIRS` | heatmap-pyramid | any text |  | host unit | Comma list of pair keys to build, e.g. binance:PERPETUAL:BTCUSDT (default every catalog pair) |
| `TT_ICEBERG_HISTORY` | iceberg-history | 0 or 1 |  | host unit | 0 stops the iceberg history builder at start, exit 2 (default on) |
| `TT_ICEBERG_DIR` | live-storage, iceberg-history | a path |  | host unit | Iceberg history stores: written by the builder, read by live-storage (default <data root>/iceberg-history) |
| `TT_ICEBERG_BINANCE_DB_PATH` | iceberg-history | a path |  | host unit | Binance capture database the iceberg builder replays |
| `TT_ICEBERG_DXFEED_DB_PATH` | iceberg-history | a path |  | host unit | dxFeed capture database the iceberg builder replays |
| `TT_ICEBERG_RETENTION_DAYS` | iceberg-history | a number, above 0 |  | host unit | Days of iceberg history kept per pair (default 7) |
| `TT_ICEBERG_WARMUP_HOURS` | iceberg-history | a number, above 0 |  | host unit | Hours of Binance replay the builder learns from before the first span it serves (default 24; futures need none) |
| `TT_ICEBERG_CYCLE_MS` | iceberg-history | a whole number, above 0 |  | host unit | Wait between builder cycles with nothing to build, ms (default 60000) |
| `TT_ICEBERG_CHUNKS_PER_CYCLE` | iceberg-history | a whole number, above 0 |  | host unit | 5 min chunks one pair builds before the next pair gets a turn (default 12) |
| `TT_ICEBERG_PAIRS` | iceberg-history | any text |  | host unit | Comma list of pair keys to build, e.g. binance:PERPETUAL:BTCUSDT (default every catalog pair) |
| `TT_PYRAMID_HISTORIES` | heatmap-pyramid | 0 or 1 |  | host unit | The wall tracker rides each replay and the pyramid keeps every window's ended walls and folded trade events beside its columns; 0 builds columns only (default 1) |
| `TT_LIVE_STORAGE_SERVICE_SECRET` | live-storage, gateway, operator | any text | yes | live-storage and gateway service.env | Shared secret between the gateway and live-storage |
| `TT_LIVE_STORAGE_INTERNAL_URL` | gateway, operator | an absolute http(s) URL |  | gateway service.env | Internal live-storage URL the gateway relays to |
| `TT_ARCHIVE_SERVICE_URL` | gateway, operator | an absolute http(s) URL |  | gateway service.env | Internal archive-query URL the gateway relays to |
| `TT_L2_ARCHIVE_SERVICE_URL` | gateway, operator | an absolute http(s) URL |  | gateway service.env | Optional loopback historical L2 query URL; absent means L2 requests are refused |
| `TT_QUERY_SERVICE_SECRET` | gateway, archive-query, operator | any text | yes | gateway and query service.env | Shared secret between the gateway and archive-query |
| `TT_ARCHIVE_CLIENT_TOKENS` | gateway, operator | any text | yes | gateway service.env | Developer bearers as clientId:secret pairs, comma-separated |
| `TT_ARCHIVE_GATEWAY_HOST` | gateway | any text |  | gateway service.env / unit | Gateway bind address: loopback, Tailscale or the lab WireGuard address |
| `TT_ARCHIVE_GATEWAY_PORT` | gateway | a whole number, above 0, at most 65535 |  | gateway service.env | Gateway listen port (default 8001) |

## Archive query and conversion (Python)

| Setting | Read by | Accepts | Secret | Set in | Meaning |
|---|---|---|---|---|---|
| `TT_COLLECTOR_HEALTH_FILE` | convert | a path |  | host unit | Collector health file the conversion throttle reads |
| `TT_QUERY_S3_REGION` | archive-query, operator | any text |  | query service.env | Region of the read-only curated S3 identity |
| `TT_QUERY_S3_ACCESS_KEY_ID` | archive-query, operator | any text | yes | query service.env | Read-only curated S3 access key |
| `TT_QUERY_S3_SECRET_ACCESS_KEY` | archive-query, operator | any text | yes | query service.env | Read-only curated S3 secret key |
| `TT_READER_TEMP_DIR` | archive-query | a path |  | query service.env | Scratch directory of the archive reader |
| `databento_key` | convert, operator | any text | yes | convert service.env / .env (operator) | Databento API key for raw backfill |
| `tardis_key` | convert, operator | any text | yes | convert service.env / .env (operator) | Tardis API key for raw backfill |
| `TT_DATABENTO_REMOTE` | convert, operator | any text |  | convert service.env | rclone remote holding Databento raw files |
| `RCLONE_CONFIG_TTCONVERT_TYPE` | convert, operator | any text |  | convert service.env | rclone backend type of the conversion identity |
| `RCLONE_CONFIG_TTCONVERT_PROVIDER` | convert, operator | any text |  | convert service.env | rclone provider of the conversion identity |
| `RCLONE_CONFIG_TTCONVERT_REGION` | convert, operator | any text |  | convert service.env | Region of the conversion S3 identity |
| `RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID` | convert, operator | any text | yes | convert service.env | Conversion S3 access key |
| `RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY` | convert, operator | any text | yes | convert service.env | Conversion S3 secret key |
| `TT_OPT_ROOT` | convert, operator | an absolute path |  | host | Install root of releases (default /opt/terminal-l1-l2) |
| `TT_UV_BIN` | convert, operator | a path |  | host | uv executable used to run conversion jobs |
| `TT_CONVERT_SCRATCH_BYTES` | convert | a whole number, above 0 |  | backfill unit | Conversion staging budget in bytes (default 8 GiB) |
| `TT_CONVERT_FREE_RESERVE_BYTES` | convert | a whole number, above 0 |  | backfill unit | Conversion free-space floor in bytes (default 1 GiB) |
| `TT_CONVERT_GLOBAL_RESERVE_BYTES` | convert | a whole number, above 0 |  | backfill unit | Scratch reserve shared by all conversion workers |
| `TT_CONVERT_SPILL_BYTES` | convert | a whole number, above 0 |  | backfill unit | DuckDB spill cap in bytes (default 512 MiB) |
| `TT_CONVERT_PART_ROWS` | convert | a whole number, above 0 |  | backfill unit | Maximum rows per output part (default 262144) |
| `TT_CONVERT_DUCKDB_MEMORY_BYTES` | convert | a whole number, above 0 |  | backfill unit | Writer DuckDB memory limit in bytes (default 4 GiB) |
| `TT_CONVERT_FINALIZE_THREADS` | convert | a whole number, above 0 |  | backfill unit | DuckDB threads for Parquet finalization (default 8) |
| `TT_CONVERT_BATCH_ROWS` | convert | a whole number, above 0 |  | backfill unit | Source rows per contract-worker request (default 2048) |
| `TT_THROTTLE_MAX_PENDING_WRITE_ITEMS` | convert | a whole number, above 0 |  | backfill unit | Collector write backlog at which conversion pauses |
| `TT_THROTTLE_MAX_STALENESS_S` | convert | a number, above 0 |  | backfill unit | Collector health age at which conversion pauses |
| `TT_THROTTLE_MAX_WRITE_LAG_MS` | convert | a number, above 0 |  | backfill unit | Collector write lag at which conversion pauses |
| `TT_THROTTLE_PAUSE_INTERVAL_S` | convert | a number, above 0 |  | backfill unit | Pause between collector health checks while throttled |

## Monitoring and alerts

| Setting | Read by | Accepts | Secret | Set in | Meaning |
|---|---|---|---|---|---|
| `TT_DISK_MIN_FREE_DATA_GIB` | monitoring | a number, above 0 |  | monitoring.env | Free-space floor on the data disk, GiB |
| `TT_DISK_MIN_FREE_ROOT_GIB` | monitoring | a number, above 0 |  | monitoring.env | Free-space floor on the root disk, GiB |
| `TT_ALERT_COMMAND` | monitoring | any text |  | alert env files | Alert delivery command |
| `TT_ALERT_WEBHOOK_URL` | monitoring | an absolute http(s) URL | yes | alert-webhook.env | Discord webhook for alerts |
| `TT_SMTP_HOST` | monitoring | any text |  | alert-email.env | SMTP host for alert mail |
| `TT_SMTP_PORT` | monitoring | a whole number, above 0, at most 65535 |  | alert-email.env | SMTP port |
| `TT_SMTP_TLS` | monitoring | any text |  | alert-email.env | SMTP TLS mode |
| `TT_SMTP_USERNAME` | monitoring | any text |  | alert-email.env | SMTP user |
| `TT_SMTP_PASSWORD` | monitoring | any text | yes | alert-email.env | SMTP password |
| `TT_ALERT_FROM` | monitoring | any text |  | alert-email.env | Alert sender address |
| `TT_ALERT_TO` | monitoring | any text |  | alert-email.env | Alert recipient address |

## Operator tooling

| Setting | Read by | Accepts | Secret | Set in | Meaning |
|---|---|---|---|---|---|
| `DATABENTO_API_KEY` | operator | any text | yes | .env (operator) | Databento key for the entitlement and content probes |
| `TARDIS_BACKFILL_CONCURRENCY` | operator | a whole number, above 0 |  | shell | Parallel Tardis downloads |
| `TT_BACKUP_REMOTE` | operator | any text |  | shell | rclone remote for the manual SQLite backup |
| `TT_A6_RAW_S3_REGION` | operator | any text |  | .env (operator) | Binance qualification raw identity region |
| `TT_A6_RAW_S3_ACCESS_KEY_ID` | operator | any text | yes | .env (operator) | Binance qualification raw access key |
| `TT_A6_RAW_S3_SECRET_ACCESS_KEY` | operator | any text | yes | .env (operator) | Binance qualification raw secret key |
| `TT_A6_QUALIFICATION_S3_REGION` | operator | any text |  | .env (operator) | Binance qualification output identity region |
| `TT_A6_QUALIFICATION_S3_ACCESS_KEY_ID` | operator | any text | yes | .env (operator) | Binance qualification output access key |
| `TT_A6_QUALIFICATION_S3_SECRET_ACCESS_KEY` | operator | any text | yes | .env (operator) | Binance qualification output secret key |
| `TT_HOST_ADDRESS` | operator | any text |  | operator.env | Host address for operator tooling |
| `TT_HOST_SSH_PORT` | operator | a whole number, above 0, at most 65535 |  | operator.env | Host SSH port |
| `TT_HOST_USERNAME` | operator | any text |  | operator.env | Host SSH user |
| `TT_HOST_SSH_KEY_PATH` | operator | a path |  | operator.env | SSH private key path |
| `TT_HOST_SSH_HOSTKEY_SHA256` | operator | any text |  | operator.env | Pinned host key fingerprint |
| `TT_HOST_PROVIDER` | operator | any text |  | operator.env | Hosting provider |
| `TT_HOST_REGION` | operator | any text |  | operator.env | Hosting region |
| `TT_SERVER_CONFIG_DIRECTORY` | operator | any text |  | operator.env | Host configuration directory |
| `TT_SERVER_CAPTURE_DIRECTORY` | operator | any text |  | operator.env | Host capture directory |
| `TT_NODE_EXECUTABLE` | operator | any text |  | operator.env | Node executable on the host |
| `TT_ARCHIVE_PROVIDER` | operator | any text |  | operator.env | Archive storage provider |
| `TT_ARCHIVE_BUCKET` | operator | any text |  | operator.env | Archive bucket |
| `TT_ARCHIVE_REGION` | operator | any text |  | operator.env | Archive bucket region |

## Benchmarks

| Setting | Read by | Accepts | Secret | Set in | Meaning |
|---|---|---|---|---|---|
| `TT_BENCH_LIVE_STORAGE_URL` | bench | an absolute http(s) URL |  | shell | Benchmark live-storage target |
| `TT_BENCH_ARCHIVE_URL` | bench | an absolute http(s) URL |  | shell | Benchmark archive target |
| `TT_BENCH_ARCHIVE_TOKEN` | bench | any text | yes | shell | Benchmark bearer |
| `TT_BENCH_TIMEOUT_MS` | bench | a number, above 0 |  | shell | Benchmark request deadline |
| `TT_BENCH_HEALTH_URL` | bench | an absolute http(s) URL |  | shell | Benchmark health endpoint |
| `TT_BENCH_HEALTH_SETTLE_MS` | bench | a number, at least 0 |  | shell | Settle time before health sampling |
| `TT_BENCH_CHROME_PATH` | bench | a path |  | shell | Chrome executable for browser benchmarks |
| `TT_ARCHIVE_BENCH_TOKEN` | bench | any text | yes | shell | Bearer for the study cost benchmark |
| `DENSITY_LIVE_BARS` | bench | 0 or 1 |  | shell | Indicator density bench: send live candles |
| `DENSITY_FROZEN` | bench | 0 or 1 |  | shell | Indicator density bench: frozen screenshot mode |
| `DENSITY_TF` | bench | any text |  | shell | Indicator density bench: timeframe button (for example 15m) to press before the steady phase, so every later phase runs on it |
| `DENSITY_FROZEN_TF` | bench | any text |  | shell | Indicator density bench: timeframe button (for example 15m) to press before the frozen captures |
| `DENSITY_CAPTURE_DIR` | bench | a path |  | shell | Indicator density bench: screenshot directory |
| `DENSITY_DIST` | bench | a path |  | shell | Indicator density bench: built web to serve |
| `DENSITY_PROFILE_SCENARIOS` | bench | any text |  | shell | Indicator density bench: scenarios to profile |
| `DENSITY_PROFILE_PHASE` | bench | any text |  | shell | Indicator density bench: phase to profile |
| `DENSITY_PROFILE_OUT` | bench | a path |  | shell | Indicator density bench: profile output |
| `DENSITY_ROWS` | bench | a whole number, above 0 |  | shell | Indicator density bench: rows in the synthetic book (default 400) |
| `DENSITY_HISTORY` | bench | 0 or 1 |  | shell | Indicator density bench: 0 leaves the history routes and the history phase off (default on) |
| `DENSITY_HISTORY_LATENCY_MS` | bench | a number, at least 0 |  | shell | Indicator density bench: delay the mock history routes add to each answer (default 50) |
| `L2_REPLAY_DROP_WALLS_INCREMENT` | bench | a whole number, at least 0 |  | shell | L2 client replay bench negative control: drop the Nth live walls increment (0 = none) |
