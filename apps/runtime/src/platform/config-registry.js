"use strict";

const path = require("node:path");

const PROCESSES = Object.freeze({
  TERMINAL_C: "terminal-c",
  TERMINAL_D: "terminal-d",
  COLLECTOR: "collector",
  DXFEED_COLLECTOR: "dxfeed-collector",
  LIVE_STORAGE: "live-storage",
  HEATMAP_PYRAMID: "heatmap-pyramid",
  ICEBERG_HISTORY: "iceberg-history",
  GATEWAY: "gateway",
  ARCHIVE_QUERY: "archive-query",
  CONVERT: "convert",
  MONITORING: "monitoring",
  OPERATOR: "operator",
  BENCH: "bench",
});

const VALIDATED_PROCESSES = Object.freeze(new Set([
  PROCESSES.TERMINAL_C,
  PROCESSES.COLLECTOR,
  PROCESSES.DXFEED_COLLECTOR,
  PROCESSES.LIVE_STORAGE,
  PROCESSES.GATEWAY,
]));

const PROJECT_PREFIX = /^(?:TT_|L2_|DXFEED_|BINANCE_|VITE_|DENSITY_|RCLONE_CONFIG_TTCONVERT_)/;
const MAX_WIRE_MAGNITUDE = 10_000_000;

const {
  TERMINAL_C, TERMINAL_D, COLLECTOR, DXFEED_COLLECTOR, LIVE_STORAGE, HEATMAP_PYRAMID, ICEBERG_HISTORY, GATEWAY,
  ARCHIVE_QUERY, CONVERT, MONITORING, OPERATOR, BENCH,
} = PROCESSES;
const JS_SERVICES = [TERMINAL_C, COLLECTOR, DXFEED_COLLECTOR, LIVE_STORAGE, GATEWAY];

function entry(name, processes, spec) {
  return Object.freeze({ name, processes: Object.freeze([...processes]), secret: false, ...spec });
}

const CONFIG_REGISTRY = Object.freeze([
  entry("TT_DATA_ROOT", JS_SERVICES, { kind: "absPath", where: "host unit / .env", doc: "Root of captured market data and local stores (default apps/runtime/data)" }),
  entry("TT_LOG_DIR", JS_SERVICES, { kind: "absPath", where: "host unit / .env", doc: "Directory for dated operator log files (default apps/runtime/logs)" }),
  entry("TT_RUNTIME_DIR", JS_SERVICES, { kind: "absPath", where: "host unit / .env", doc: "Directory for runtime state such as the collector health file (default apps/runtime/run)" }),
  entry("TT_NODE_BIN", [TERMINAL_C, TERMINAL_D, OPERATOR], { kind: "path", where: ".env", doc: "Node 24.21.0 executable or its directory; the launcher runs this when the shell's node differs" }),

  entry("TT_LIVE_STORAGE_SERVICE_URL", [TERMINAL_C, BENCH], { kind: "url", where: ".env (layer 1)", doc: "Gateway live-storage base URL, ending in /live-storage" }),
  entry("TT_LIVE_STORAGE_CLIENT_TOKEN", [TERMINAL_C, BENCH], { kind: "text", secret: true, where: ".env (layer 1)", doc: "Your gateway bearer, for warm-up reads" }),
  entry("TT_ARCHIVE_PROXY_URL", [TERMINAL_C, TERMINAL_D, BENCH], { kind: "origin", where: ".env (layer 1)", doc: "Gateway origin that Terminal D proxies /archive to" }),
  entry("TT_LIVE_PROXY_URL", [TERMINAL_C, TERMINAL_D], { kind: "origin", where: ".env", doc: "Local runtime origin for /ws and /health (default http://127.0.0.1:8001); never the host" }),
  entry("VITE_ARCHIVE_CLIENT_TOKEN", [TERMINAL_C, TERMINAL_D, BENCH], { kind: "text", secret: true, where: ".env (layer 1)", doc: "Your gateway bearer, used by the browser for Historical Mode" }),
  entry("VITE_ALLOWED_HOST", [TERMINAL_D], { kind: "text", where: "shell", doc: "Extra host name the Vite dev server accepts (tunnel sharing)" }),
  entry("VITE_BACKEND_WS_URL", [TERMINAL_D], { kind: "text", where: "shell", doc: "Override for the browser's WebSocket URL" }),
  entry("EXTRA_ALLOWED_ORIGIN", [TERMINAL_C], { kind: "origin", where: "shell", doc: "Extra browser origin the runtime accepts (tunnel sharing)" }),

  entry("TT_DXFEED_TOKEN_BROKER_URL", [TERMINAL_C, DXFEED_COLLECTOR, OPERATOR], { kind: "tailscaleOrigin", where: ".env (layer 2) / collect service.env", doc: "dxFeed token broker, an https *.ts.net origin" }),
  entry("TT_DXFEED_TOKEN_TIMEOUT_MS", [TERMINAL_C, DXFEED_COLLECTOR, OPERATOR], { kind: "number", gt: 0, where: ".env", doc: "Deadline for one broker token request (default 30000)" }),
  entry("DXFEED_ENDPOINT", [DXFEED_COLLECTOR, OPERATOR], { kind: "text", where: "set by the token wrapper", doc: "Approved dxLink endpoint, supplied per session by run-with-dxfeed-token" }),
  entry("DXFEED_TEMP_TOKEN", [DXFEED_COLLECTOR, OPERATOR], { kind: "text", secret: true, where: "set by the token wrapper", doc: "Short-lived dxFeed token, supplied per session by run-with-dxfeed-token" }),
  entry("MARKET_DATA_MODE", [DXFEED_COLLECTOR, OPERATOR], { kind: "enum", values: ["realtime", "delayed"], where: "set by the token wrapper", doc: "Feed mode matching DXFEED_ENDPOINT" }),
  entry("DXFEED_TOKEN_EXPIRES_AT", [DXFEED_COLLECTOR, OPERATOR], { kind: "text", where: "set by the token wrapper", doc: "Expiry of DXFEED_TEMP_TOKEN" }),

  entry("TT_VPIN_ENABLED", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 disables VPIN warm-up and live polling (default on)" }),
  entry("BINANCE_TRADE_QUEUE_DEPTH", [TERMINAL_C], { kind: "number", integer: true, gt: 0, where: ".env", doc: "Binance trade queue depth before overflow (default 5000)" }),
  entry("TT_BINANCE_SPOT_WS_BASE_URL", [TERMINAL_C], { kind: "wsOrigin", where: ".env", doc: "Binance spot stream origin (default wss://stream.binance.com); the market-data mirror wss://data-stream.binance.vision:9443 is not geo-blocked. USD-M perpetuals keep their fixed origin" }),
  entry("TT_BINANCE_SPOT_REST_BASE_URL", [TERMINAL_C], { kind: "origin", where: ".env", doc: "Binance spot REST origin for depth snapshots and candle backfill (default https://api.binance.com); the market-data mirror https://data-api.binance.vision is not geo-blocked. USD-M perpetuals keep their fixed origin" }),
  entry("TT_BINANCE_TRANSPORT", [TERMINAL_C], { kind: "enum", values: ["ws", "rest"], where: ".env", doc: "Binance transport: ws streams every trade and depth diff (default); rest polls the spot REST API for 1m candles only, with no tape and no order book, for a host that cannot open a WebSocket" }),
  entry("TT_BINANCE_REST_POLL_MS", [TERMINAL_C], { kind: "number", integer: true, min: 250, where: ".env", doc: "REST transport: milliseconds between polls of a pair's candles (default 1000); the weight budget may lengthen it" }),
  entry("TT_BINANCE_REST_WEIGHT_BUDGET", [TERMINAL_C], { kind: "number", integer: true, min: 100, max: 5000, where: ".env", doc: "REST transport: Binance REQUEST_WEIGHT reserved per minute before each request (default 4000); the exchange limit is 6000, so at most 5000" }),
  entry("L2_MEMORY_DEBUG", [TERMINAL_C], { kind: "flag", where: ".env", doc: "1 logs L2 memory debugging" }),
  entry("L2_ICEBERG", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 turns the Iceberg Detector off (default on): no trackers, no history restore or save, no host fill; the channel still answers with empty pages" }),
  entry("L2_ICEBERG_HISTORY", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 keeps iceberg histories in memory only, never on disk, and asks the host for nothing (default on)" }),
  entry("L2_ICEBERG_STORE_DIR", [TERMINAL_C], { kind: "path", where: ".env", doc: "Directory of the per-instrument iceberg history files (default <data root>/icebergs)" }),
  entry("L2_ICEBERG_STORE_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Seconds between background saves of a dirty iceberg history (default 300)" }),
  entry("L2_ICEBERG_MAX_AGE_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Age after which a settled iceberg leaves the history (default 7 days)" }),
  entry("L2_ICEBERG_HOST_FILL", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 stops asking the host for the iceberg history of the spans this runtime did not watch (default on when the gateway URL and token are set)" }),
  entry("L2_ICEBERG_FILL_DELAY_S", [TERMINAL_C], { kind: "number", min: 0, where: ".env", doc: "Seconds after start before the first host iceberg-history fill; 0 fills at once (default 120)" }),
  entry("L2_ICEBERG_FILL_EVERY_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Seconds between host iceberg-history fills (default 1800)" }),
  entry("L2_EXHAUSTION", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 stops the Exhaustion engines and the Candle Monitor, which shares their timer (default on); the channel still answers with empty pages" }),
  entry("L2_EXHAUSTION_HISTORY", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 keeps exhaustion shades in memory only, never on disk (default on)" }),
  entry("L2_EXHAUSTION_HOST_FILL", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 switches the Exhaustion host read off: no start fill below the live start, no history asks (default on; a host that answers NO_HOST switches it off by itself)" }),
  entry("L2_EXHAUSTION_STORE_DIR", [TERMINAL_C], { kind: "path", where: ".env", doc: "Directory of the per-instrument exhaustion history files (default <data root>/exhaustion)" }),
  entry("L2_EXHAUSTION_STORE_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Seconds between background saves of a dirty exhaustion history (default 300)" }),
  entry("L2_EXHAUSTION_MAX_AGE_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Age after which a judged exhaustion shade leaves the history (default 7 days)" }),
  entry("L2_EXHAUSTION_FILL_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Span of the host's columns a pair reads below its live start before its exhaustion engines go live: the newest hours that hold columns adding up to these seconds, empty hours walked past (default one day; the age cap bounds it)" }),
  entry("L2_EXHAUSTION_FILL_CONCURRENCY", [TERMINAL_C], { kind: "number", integer: true, gt: 0, where: ".env", doc: "Hours of the host's columns the exhaustion history walk reads at once (default 3)" }),
  entry("L2_INITIATIVE", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 stops the Initiative Continuation engines (default on); the channel still answers with empty pages" }),
  entry("L2_INITIATIVE_HISTORY", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 keeps initiative bands in memory only, never on disk (default on)" }),
  entry("L2_INITIATIVE_HOST_FILL", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 switches the Initiative Continuation host read off: no start fill below the live start, no history asks (default on; a host that answers NO_HOST switches it off by itself)" }),
  entry("L2_INITIATIVE_STORE_DIR", [TERMINAL_C], { kind: "path", where: ".env", doc: "Directory of the per-instrument initiative history files (default <data root>/initiative)" }),
  entry("L2_INITIATIVE_STORE_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Seconds between background saves of a dirty initiative history (default 300)" }),
  entry("L2_INITIATIVE_MAX_AGE_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Age after which an initiative band leaves the history, counted from its frozen candle (default 7 days)" }),
  entry("L2_INITIATIVE_FILL_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Span of the host's columns a pair reads below its live start before its initiative engines go live: the newest hours that hold columns adding up to these seconds, empty hours walked past (default one day; the age cap bounds it)" }),
  entry("L2_INITIATIVE_FILL_CONCURRENCY", [TERMINAL_C], { kind: "number", integer: true, gt: 0, where: ".env", doc: "Hours of the host's columns the initiative history walk reads at once (default 3)" }),
  entry("L2_BAND_BP", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "L2 memory band width in basis points of price" }),
  entry("L2_MIN_SLICE_USD", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Smallest resting notional the L2 ledger keeps" }),
  entry("L2_MIN_SLICE_SIZE", [TERMINAL_C], { kind: "number", min: 0, where: ".env", doc: "Smallest resting size the L2 ledger keeps when no quote is known" }),
  entry("L2_HEATMAP_TRACK_ALL", [TERMINAL_C], { kind: "flag", where: ".env", doc: "1 keeps heatmap history for every Binance pair, not only the selected one" }),
  entry("L2_HEATMAP_ROW_BP", [TERMINAL_C, HEATMAP_PYRAMID], { kind: "number", gt: 0, where: ".env", doc: "Heatmap row height in basis points (default 0.5)" }),
  entry("L2_HEATMAP_WINDOW_BP", [TERMINAL_C, HEATMAP_PYRAMID], { kind: "number", gt: 0, where: ".env", doc: "Heatmap half-window around the mid in basis points (default 600)" }),
  entry("L2_HEATMAP_COLUMN_MS", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Recent-tier column width in ms (default 1000)" }),
  entry("L2_HEATMAP_HISTORY_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Seconds of recent tier replayed to a new client (default 1200)" }),
  entry("L2_HEATMAP_DEEP_S", [TERMINAL_C], { kind: "number", min: 0, where: ".env", doc: "Seconds of deep tier; 0 disables it (default 14400)" }),
  entry("L2_HEATMAP_FILL_S", [TERMINAL_C], { kind: "number", min: 0, where: ".env", doc: "Seconds the wall and event histories are filled back from the recording after start, bounded by the store age; 0 disables it (default 86400)" }),
  entry("L2_LANE_WALLS", [TERMINAL_C], { kind: "flag", where: ".env", doc: "Walls on the wider heatmap lanes, tracked in a worker for the pair on screen; 0 disables them (default 1)" }),
  entry("L2_HEATMAP_HISTORY", [TERMINAL_C], { kind: "flag", where: ".env", doc: "The wall and event histories behind the `wall_history` and `l2_event_history` requests: recorded live, stored beside the heatmap store and filled from the recording; 0 keeps them empty and answers the requests with HISTORY_UNAVAILABLE (default 1)" }),
  entry("L2_HEATMAP_DEEP_COLUMN_MS", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Deep-tier column width in ms (default 10000)" }),
  entry("L2_HEATMAP_DEEP_CHUNK_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Seconds per deep-tier rebuild pass (default 1200)" }),
  entry("L2_HEATMAP_COARSE_S", [TERMINAL_C], { kind: "number", min: 0, where: ".env", doc: "Seconds of optional coarse tier; 0 disables it (default 0)" }),
  entry("L2_HEATMAP_COARSE_COLUMN_MS", [TERMINAL_C], { kind: "number", integer: true, gt: 0, where: ".env", doc: "Coarse-tier column width in ms (default 300000; a multiple of the deep width)" }),
  entry("L2_HEATMAP_COARSE_ROWS", [TERMINAL_C], { kind: "number", integer: true, gt: 0, where: ".env", doc: "Fine rows combined into each coarse row (default 40)" }),
  entry("L2_WIRE", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 stops collecting the opt-in L2 channels (`l2_view`, `l2_walls`, `l2_events`, `l2_ladder`); clients that declared them then receive none. Default on. The `liquidity` heatmap is unaffected either way" }),
  entry("L2_HEATMAP_LANES", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 turns off the wider heatmap lanes (default on: crypto to ±7 %, futures and equities to ±3 %; `l2.windowPct` per instrument in `config/market-instruments.json` overrides)" }),
  entry("L2_HEATMAP_STORE", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 stops keeping computed columns on disk (default on)" }),
  entry("L2_HEATMAP_STORE_DIR", [TERMINAL_C], { kind: "path", where: ".env", doc: "Directory of the liquidity store (default <data root>/liquidity)" }),
  entry("L2_HEATMAP_STORE_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Seconds between store writes; a store that has not changed is not rewritten (default 300)" }),
  entry("L2_HEATMAP_STORE_MAX_AGE_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "A stored history older than this is ignored (default 7 days)" }),
  entry("L2_HEATMAP_STORE_MAX_BYTES", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Store size budget before the oldest columns are trimmed (default 48 MiB)" }),
  entry("L2_HEATMAP_LEVEL_MIN_USD", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Resting notional floor for a tracked wall (default 500000)" }),
  entry("L2_HEATMAP_WALL_MULT", [TERMINAL_C], { kind: "number", min: 0, where: ".env", doc: "A wall is at least this many times the typical row (default 3)" }),
  entry("L2_HEATMAP_REF_BP", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Distance from the mid within which the typical row is measured (default 50)" }),
  entry("L2_HEATMAP_WALL_SETTLE_MS", [TERMINAL_C], { kind: "number", integer: true, min: 0, where: ".env", doc: "How long a vanished wall waits for its trades (default 5000)" }),
  entry("L2_HEATMAP_WALL_GAP", [TERMINAL_C], { kind: "number", integer: true, min: 0, where: ".env", doc: "Thinner rows a wall may bridge (default 2)" }),
  entry("L2_HEATMAP_BACKFILL", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 stops rebuilding history from the recording (default on)" }),
  entry("L2_HEATMAP_BACKFILL_MAX_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Most seconds of a gap replayed at fine resolution (default 600)" }),
  entry("L2_HEATMAP_BACKFILL_WORKERS", [TERMINAL_C], { kind: "number", integer: true, gt: 0, where: ".env", doc: "Rebuild passes running at once (default 1)" }),
  entry("L2_HEATMAP_BACKFILL_TIMEOUT_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "A rebuild pass still running after this is stopped (default 300)" }),
  entry("L2_HEATMAP_BACKFILL_ANNOUNCE_S", [TERMINAL_C], { kind: "number", gt: 0, where: ".env", doc: "Most often the selected pair's rebuilt history is replayed to clients, apart from a pass landing (default 60)" }),
  entry("L2_HEATMAP_HISTORY_FLOOR", [TERMINAL_C], { kind: "isoTime", where: ".env", doc: "Nothing older is restored or backfilled" }),
  entry("L2_HEATMAP_DB_PATH", [TERMINAL_C], { kind: "path", where: ".env", doc: "Binance recording the heatmap rebuilds from (default the collector database)" }),
  entry("L2_HEATMAP_DXFEED_DB_PATH", [TERMINAL_C], { kind: "path", where: ".env", doc: "dxFeed recording the heatmap rebuilds from" }),
  entry("L2_HEATMAP_PYRAMID", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 stops reading the host heatmap pyramid for pinned rows and a fast deep warm-up (default on)" }),
  entry("L2_HEATMAP_FUTURE_ROW_TICKS", [TERMINAL_C, HEATMAP_PYRAMID], { kind: "number", integer: true, gt: 0, where: ".env", doc: "Heatmap row width on futures, in ticks (default 1)" }),
  entry("L2_HEATMAP_EQUITY_ROW_TICKS", [TERMINAL_C, HEATMAP_PYRAMID], { kind: "number", integer: true, gt: 0, where: ".env", doc: "Heatmap row width on equities, in ticks (default 1)" }),
  entry("L2_HEATMAP_DXFEED_DIFF_MS", [TERMINAL_C], { kind: "number", integer: true, gt: 0, where: ".env", doc: "Order-event burst gathered before the dxFeed book is diffed, ms (default 250)" }),
  entry("L2_AGGRESSIVE", [TERMINAL_C], { kind: "flag", where: ".env", doc: "0 stops aggressive-order clusters on the wire (default on)" }),
  entry("L2_AGGRESSIVE_PERCENTILE", [TERMINAL_C], { kind: "number", gt: 0, max: 1, where: ".env", doc: "Percentile a cluster must reach before it is sent (default 0.9)" }),
  entry("L2_AGGRESSIVE_FLOOR", [TERMINAL_C], { kind: "number", gt: 0, max: MAX_WIRE_MAGNITUDE, where: ".env", doc: "Fixed reporting floor in base units instead of the percentile" }),
  entry("L2_AGGRESSIVE_MIN", [TERMINAL_C], { kind: "number", min: 0, max: MAX_WIRE_MAGNITUDE, where: ".env", doc: "Floor under the calibrated floor, in base units" }),

  entry("TT_MAX_DB_BYTES", [COLLECTOR, DXFEED_COLLECTOR], { kind: "bytes", where: "collect service.env", doc: "Capture database size limit; capture stops above it" }),
  entry("TT_MIN_FREE_DISK_BYTES", [COLLECTOR, DXFEED_COLLECTOR], { kind: "bytes", where: "collect service.env", doc: "Free-disk reserve; capture stops below it" }),
  entry("TT_COLLECTOR_HEALTH_FILE", [CONVERT], { kind: "path", where: "host unit", doc: "Collector health file the conversion throttle reads" }),

  entry("TT_LIVE_STORAGE_PORT", [LIVE_STORAGE], { kind: "number", integer: true, gt: 0, max: 65_535, where: "live-storage service.env", doc: "Live-storage listen port (default 8003)" }),
  entry("TT_LIVE_STORAGE_HOST", [LIVE_STORAGE], { kind: "text", where: "live-storage service.env", doc: "Live-storage bind address, loopback only" }),
  entry("TT_LIVE_STORAGE_DB_PATH", [LIVE_STORAGE], { kind: "path", where: "live-storage service.env", doc: "Binance capture database read by live-storage" }),
  entry("TT_LIVE_STORAGE_DXFEED_DB_PATH", [LIVE_STORAGE], { kind: "path", where: "live-storage service.env", doc: "dxFeed capture database read by live-storage" }),
  entry("TT_HEATMAP_DIR", [TERMINAL_C, LIVE_STORAGE, HEATMAP_PYRAMID], { kind: "path", where: "host unit / .env", doc: "Heatmap pyramid stores: written by the pyramid, read by live-storage, and by Terminal C when it reads locally (default <data root>/heatmap)" }),
  entry("TT_PYRAMID_BINANCE_DB_PATH", [HEATMAP_PYRAMID], { kind: "path", where: "host unit", doc: "Binance capture database the pyramid replays" }),
  entry("TT_PYRAMID_DXFEED_DB_PATH", [HEATMAP_PYRAMID], { kind: "path", where: "host unit", doc: "dxFeed capture database the pyramid replays" }),
  entry("TT_PYRAMID_RETENTION_DAYS", [HEATMAP_PYRAMID], { kind: "number", gt: 0, where: "host unit", doc: "Days of pyramid kept at every level (default 7)" }),
  entry("TT_PYRAMID_CYCLE_MS", [HEATMAP_PYRAMID], { kind: "number", integer: true, gt: 0, where: "host unit", doc: "Wait between pyramid cycles with nothing to build, ms (default 60000)" }),
  entry("TT_PYRAMID_WINDOWS_PER_CYCLE", [HEATMAP_PYRAMID], { kind: "number", integer: true, gt: 0, where: "host unit", doc: "5 min windows one pair builds before the next pair gets a turn (default 12)" }),
  entry("TT_PYRAMID_WARMUP_MS", [HEATMAP_PYRAMID], { kind: "number", integer: true, gt: 0, where: "host unit", doc: "Replay before each run of windows, so the book near the mid is settled, ms (default 1800000)" }),
  entry("TT_PYRAMID_PAIRS", [HEATMAP_PYRAMID], { kind: "text", where: "host unit", doc: "Comma list of pair keys to build, e.g. binance:PERPETUAL:BTCUSDT (default every catalog pair)" }),
  entry("TT_ICEBERG_HISTORY", [ICEBERG_HISTORY], { kind: "flag", where: "host unit", doc: "0 stops the iceberg history builder at start, exit 2 (default on)" }),
  entry("TT_ICEBERG_DIR", [LIVE_STORAGE, ICEBERG_HISTORY], { kind: "path", where: "host unit", doc: "Iceberg history stores: written by the builder, read by live-storage (default <data root>/iceberg-history)" }),
  entry("TT_ICEBERG_BINANCE_DB_PATH", [ICEBERG_HISTORY], { kind: "path", where: "host unit", doc: "Binance capture database the iceberg builder replays" }),
  entry("TT_ICEBERG_DXFEED_DB_PATH", [ICEBERG_HISTORY], { kind: "path", where: "host unit", doc: "dxFeed capture database the iceberg builder replays" }),
  entry("TT_ICEBERG_RETENTION_DAYS", [ICEBERG_HISTORY], { kind: "number", gt: 0, where: "host unit", doc: "Days of iceberg history kept per pair (default 7)" }),
  entry("TT_ICEBERG_WARMUP_HOURS", [ICEBERG_HISTORY], { kind: "number", gt: 0, where: "host unit", doc: "Hours of Binance replay the builder learns from before the first span it serves (default 24; futures need none)" }),
  entry("TT_ICEBERG_CYCLE_MS", [ICEBERG_HISTORY], { kind: "number", integer: true, gt: 0, where: "host unit", doc: "Wait between builder cycles with nothing to build, ms (default 60000)" }),
  entry("TT_ICEBERG_CHUNKS_PER_CYCLE", [ICEBERG_HISTORY], { kind: "number", integer: true, gt: 0, where: "host unit", doc: "5 min chunks one pair builds before the next pair gets a turn (default 12)" }),
  entry("TT_ICEBERG_PAIRS", [ICEBERG_HISTORY], { kind: "text", where: "host unit", doc: "Comma list of pair keys to build, e.g. binance:PERPETUAL:BTCUSDT (default every catalog pair)" }),
  entry("TT_PYRAMID_HISTORIES", [HEATMAP_PYRAMID], { kind: "flag", where: "host unit", doc: "The wall tracker rides each replay and the pyramid keeps every window's ended walls and folded trade events beside its columns; 0 builds columns only (default 1)" }),
  entry("TT_LIVE_STORAGE_SERVICE_SECRET", [LIVE_STORAGE, GATEWAY, OPERATOR], { kind: "text", secret: true, where: "live-storage and gateway service.env", doc: "Shared secret between the gateway and live-storage" }),
  entry("TT_LIVE_STORAGE_INTERNAL_URL", [GATEWAY, OPERATOR], { kind: "url", where: "gateway service.env", doc: "Internal live-storage URL the gateway relays to" }),
  entry("TT_ARCHIVE_SERVICE_URL", [GATEWAY, OPERATOR], { kind: "url", where: "gateway service.env", doc: "Internal archive-query URL the gateway relays to" }),
  entry("TT_L2_ARCHIVE_SERVICE_URL", [GATEWAY, OPERATOR], { kind: "url", where: "gateway service.env", doc: "Optional loopback historical L2 query URL; absent means L2 requests are refused" }),
  entry("TT_L2_PREVIEW_HOST", [OPERATOR], { kind: "enum", values: ["127.0.0.1", "10.88.0.1"], where: "isolated qualification preview only", doc: "Historical L2 preview bind: loopback by default or the existing private WireGuard interface" }),
  entry("TT_QUERY_SERVICE_SECRET", [GATEWAY, ARCHIVE_QUERY, OPERATOR], { kind: "text", secret: true, where: "gateway and query service.env", doc: "Shared secret between the gateway and archive-query" }),
  entry("TT_ARCHIVE_CLIENT_TOKENS", [GATEWAY, OPERATOR], { kind: "text", secret: true, where: "gateway service.env", doc: "Developer bearers as clientId:secret pairs, comma-separated" }),
  entry("TT_ARCHIVE_GATEWAY_HOST", [GATEWAY], { kind: "text", where: "gateway service.env / unit", doc: "Gateway bind address: loopback, Tailscale or the lab WireGuard address" }),
  entry("TT_ARCHIVE_GATEWAY_PORT", [GATEWAY], { kind: "number", integer: true, gt: 0, max: 65_535, where: "gateway service.env", doc: "Gateway listen port (default 8001)" }),

  entry("TT_QUERY_S3_REGION", [ARCHIVE_QUERY, OPERATOR], { kind: "text", where: "query service.env", doc: "Region of the read-only curated S3 identity" }),
  entry("TT_QUERY_S3_ACCESS_KEY_ID", [ARCHIVE_QUERY, OPERATOR], { kind: "text", secret: true, where: "query service.env", doc: "Read-only curated S3 access key" }),
  entry("TT_QUERY_S3_SECRET_ACCESS_KEY", [ARCHIVE_QUERY, OPERATOR], { kind: "text", secret: true, where: "query service.env", doc: "Read-only curated S3 secret key" }),
  entry("TT_READER_TEMP_DIR", [ARCHIVE_QUERY], { kind: "path", where: "query service.env", doc: "Scratch directory of the archive reader" }),

  entry("databento_key", [CONVERT, OPERATOR], { kind: "text", secret: true, where: "convert service.env / .env (operator)", doc: "Databento API key for raw backfill" }),
  entry("tardis_key", [CONVERT, OPERATOR], { kind: "text", secret: true, where: "convert service.env / .env (operator)", doc: "Tardis API key for raw backfill" }),
  entry("DATABENTO_API_KEY", [OPERATOR], { kind: "text", secret: true, where: ".env (operator)", doc: "Databento key for the entitlement and content probes" }),
  entry("TT_DATABENTO_REMOTE", [CONVERT, OPERATOR], { kind: "text", where: "convert service.env", doc: "rclone remote holding Databento raw files" }),
  entry("TARDIS_BACKFILL_CONCURRENCY", [OPERATOR], { kind: "number", integer: true, gt: 0, where: "shell", doc: "Parallel Tardis downloads" }),
  entry("RCLONE_CONFIG_TTCONVERT_TYPE", [CONVERT, OPERATOR], { kind: "text", where: "convert service.env", doc: "rclone backend type of the conversion identity" }),
  entry("RCLONE_CONFIG_TTCONVERT_PROVIDER", [CONVERT, OPERATOR], { kind: "text", where: "convert service.env", doc: "rclone provider of the conversion identity" }),
  entry("RCLONE_CONFIG_TTCONVERT_REGION", [CONVERT, OPERATOR], { kind: "text", where: "convert service.env", doc: "Region of the conversion S3 identity" }),
  entry("RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID", [CONVERT, OPERATOR], { kind: "text", secret: true, where: "convert service.env", doc: "Conversion S3 access key" }),
  entry("RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY", [CONVERT, OPERATOR], { kind: "text", secret: true, where: "convert service.env", doc: "Conversion S3 secret key" }),
  entry("TT_OPT_ROOT", [CONVERT, OPERATOR], { kind: "absPath", where: "host", doc: "Install root of releases (default /opt/terminal-l1-l2)" }),
  entry("TT_UV_BIN", [CONVERT, OPERATOR], { kind: "path", where: "host", doc: "uv executable used to run conversion jobs" }),
  entry("TT_CONVERT_SCRATCH_BYTES", [CONVERT], { kind: "number", integer: true, gt: 0, where: "backfill unit", doc: "Conversion staging budget in bytes (default 8 GiB)" }),
  entry("TT_CONVERT_FREE_RESERVE_BYTES", [CONVERT], { kind: "number", integer: true, gt: 0, where: "backfill unit", doc: "Conversion free-space floor in bytes (default 1 GiB)" }),
  entry("TT_CONVERT_GLOBAL_RESERVE_BYTES", [CONVERT], { kind: "number", integer: true, gt: 0, where: "backfill unit", doc: "Scratch reserve shared by all conversion workers" }),
  entry("TT_CONVERT_SPILL_BYTES", [CONVERT], { kind: "number", integer: true, gt: 0, where: "backfill unit", doc: "DuckDB spill cap in bytes (default 512 MiB)" }),
  entry("TT_CONVERT_PART_ROWS", [CONVERT], { kind: "number", integer: true, gt: 0, where: "backfill unit", doc: "Maximum rows per output part (default 262144)" }),
  entry("TT_CONVERT_DUCKDB_MEMORY_BYTES", [CONVERT], { kind: "number", integer: true, gt: 0, where: "backfill unit", doc: "Writer DuckDB memory limit in bytes (default 4 GiB)" }),
  entry("TT_CONVERT_FINALIZE_THREADS", [CONVERT], { kind: "number", integer: true, gt: 0, where: "backfill unit", doc: "DuckDB threads for Parquet finalization (default 8)" }),
  entry("TT_CONVERT_BATCH_ROWS", [CONVERT], { kind: "number", integer: true, gt: 0, where: "backfill unit", doc: "Source rows per contract-worker request (default 2048)" }),
  entry("TT_THROTTLE_MAX_PENDING_WRITE_ITEMS", [CONVERT], { kind: "number", integer: true, gt: 0, where: "backfill unit", doc: "Collector write backlog at which conversion pauses" }),
  entry("TT_THROTTLE_MAX_STALENESS_S", [CONVERT], { kind: "number", gt: 0, where: "backfill unit", doc: "Collector health age at which conversion pauses" }),
  entry("TT_THROTTLE_MAX_WRITE_LAG_MS", [CONVERT], { kind: "number", gt: 0, where: "backfill unit", doc: "Collector write lag at which conversion pauses" }),
  entry("TT_THROTTLE_PAUSE_INTERVAL_S", [CONVERT], { kind: "number", gt: 0, where: "backfill unit", doc: "Pause between collector health checks while throttled" }),
  entry("TT_BACKUP_REMOTE", [OPERATOR], { kind: "text", where: "shell", doc: "rclone remote for the manual SQLite backup" }),

  entry("TT_DISK_MIN_FREE_DATA_GIB", [MONITORING], { kind: "number", gt: 0, where: "monitoring.env", doc: "Free-space floor on the data disk, GiB" }),
  entry("TT_DISK_MIN_FREE_ROOT_GIB", [MONITORING], { kind: "number", gt: 0, where: "monitoring.env", doc: "Free-space floor on the root disk, GiB" }),
  entry("TT_ALERT_COMMAND", [MONITORING], { kind: "text", where: "alert env files", doc: "Alert delivery command" }),
  entry("TT_ALERT_WEBHOOK_URL", [MONITORING], { kind: "url", secret: true, where: "alert-webhook.env", doc: "Discord webhook for alerts" }),
  entry("TT_SMTP_HOST", [MONITORING], { kind: "text", where: "alert-email.env", doc: "SMTP host for alert mail" }),
  entry("TT_SMTP_PORT", [MONITORING], { kind: "number", integer: true, gt: 0, max: 65_535, where: "alert-email.env", doc: "SMTP port" }),
  entry("TT_SMTP_TLS", [MONITORING], { kind: "text", where: "alert-email.env", doc: "SMTP TLS mode" }),
  entry("TT_SMTP_USERNAME", [MONITORING], { kind: "text", where: "alert-email.env", doc: "SMTP user" }),
  entry("TT_SMTP_PASSWORD", [MONITORING], { kind: "text", secret: true, where: "alert-email.env", doc: "SMTP password" }),
  entry("TT_ALERT_FROM", [MONITORING], { kind: "text", where: "alert-email.env", doc: "Alert sender address" }),
  entry("TT_ALERT_TO", [MONITORING], { kind: "text", where: "alert-email.env", doc: "Alert recipient address" }),

  entry("TT_A6_RAW_S3_REGION", [OPERATOR], { kind: "text", where: ".env (operator)", doc: "Binance qualification raw identity region" }),
  entry("TT_A6_RAW_S3_ACCESS_KEY_ID", [OPERATOR], { kind: "text", secret: true, where: ".env (operator)", doc: "Binance qualification raw access key" }),
  entry("TT_A6_RAW_S3_SECRET_ACCESS_KEY", [OPERATOR], { kind: "text", secret: true, where: ".env (operator)", doc: "Binance qualification raw secret key" }),
  entry("TT_A6_QUALIFICATION_S3_REGION", [OPERATOR], { kind: "text", where: ".env (operator)", doc: "Binance qualification output identity region" }),
  entry("TT_A6_QUALIFICATION_S3_ACCESS_KEY_ID", [OPERATOR], { kind: "text", secret: true, where: ".env (operator)", doc: "Binance qualification output access key" }),
  entry("TT_A6_QUALIFICATION_S3_SECRET_ACCESS_KEY", [OPERATOR], { kind: "text", secret: true, where: ".env (operator)", doc: "Binance qualification output secret key" }),
  entry("TT_HOST_ADDRESS", [OPERATOR], { kind: "text", where: "operator.env", doc: "Host address for operator tooling" }),
  entry("TT_HOST_SSH_PORT", [OPERATOR], { kind: "number", integer: true, gt: 0, max: 65_535, where: "operator.env", doc: "Host SSH port" }),
  entry("TT_HOST_USERNAME", [OPERATOR], { kind: "text", where: "operator.env", doc: "Host SSH user" }),
  entry("TT_HOST_SSH_KEY_PATH", [OPERATOR], { kind: "path", where: "operator.env", doc: "SSH private key path" }),
  entry("TT_HOST_SSH_HOSTKEY_SHA256", [OPERATOR], { kind: "text", where: "operator.env", doc: "Pinned host key fingerprint" }),
  entry("TT_HOST_PROVIDER", [OPERATOR], { kind: "text", where: "operator.env", doc: "Hosting provider" }),
  entry("TT_HOST_REGION", [OPERATOR], { kind: "text", where: "operator.env", doc: "Hosting region" }),
  entry("TT_SERVER_CONFIG_DIRECTORY", [OPERATOR], { kind: "text", where: "operator.env", doc: "Host configuration directory" }),
  entry("TT_SERVER_CAPTURE_DIRECTORY", [OPERATOR], { kind: "text", where: "operator.env", doc: "Host capture directory" }),
  entry("TT_NODE_EXECUTABLE", [OPERATOR], { kind: "text", where: "operator.env", doc: "Node executable on the host" }),
  entry("TT_ARCHIVE_PROVIDER", [OPERATOR], { kind: "text", where: "operator.env", doc: "Archive storage provider" }),
  entry("TT_ARCHIVE_BUCKET", [OPERATOR], { kind: "text", where: "operator.env", doc: "Archive bucket" }),
  entry("TT_ARCHIVE_REGION", [OPERATOR], { kind: "text", where: "operator.env", doc: "Archive bucket region" }),

  entry("TT_BENCH_LIVE_STORAGE_URL", [BENCH], { kind: "url", where: "shell", doc: "Benchmark live-storage target" }),
  entry("TT_BENCH_ARCHIVE_URL", [BENCH], { kind: "url", where: "shell", doc: "Benchmark archive target" }),
  entry("TT_BENCH_ARCHIVE_TOKEN", [BENCH], { kind: "text", secret: true, where: "shell", doc: "Benchmark bearer" }),
  entry("TT_BENCH_TIMEOUT_MS", [BENCH], { kind: "number", gt: 0, where: "shell", doc: "Benchmark request deadline" }),
  entry("TT_BENCH_HEALTH_URL", [BENCH], { kind: "url", where: "shell", doc: "Benchmark health endpoint" }),
  entry("TT_BENCH_HEALTH_SETTLE_MS", [BENCH], { kind: "number", min: 0, where: "shell", doc: "Settle time before health sampling" }),
  entry("TT_BENCH_CHROME_PATH", [BENCH], { kind: "path", where: "shell", doc: "Chrome executable for browser benchmarks" }),
  entry("TT_ARCHIVE_BENCH_TOKEN", [BENCH], { kind: "text", secret: true, where: "shell", doc: "Bearer for the study cost benchmark" }),
  entry("DENSITY_LIVE_BARS", [BENCH], { kind: "flag", where: "shell", doc: "Indicator density bench: send live candles" }),
  entry("DENSITY_FROZEN", [BENCH], { kind: "flag", where: "shell", doc: "Indicator density bench: frozen screenshot mode" }),
  entry("DENSITY_TF", [BENCH], { kind: "text", where: "shell", doc: "Indicator density bench: timeframe button (for example 15m) to press before the steady phase, so every later phase runs on it" }),
  entry("DENSITY_FROZEN_TF", [BENCH], { kind: "text", where: "shell", doc: "Indicator density bench: timeframe button (for example 15m) to press before the frozen captures" }),
  entry("DENSITY_CAPTURE_DIR", [BENCH], { kind: "path", where: "shell", doc: "Indicator density bench: screenshot directory" }),
  entry("DENSITY_DIST", [BENCH], { kind: "path", where: "shell", doc: "Indicator density bench: built web to serve" }),
  entry("DENSITY_PROFILE_SCENARIOS", [BENCH], { kind: "text", where: "shell", doc: "Indicator density bench: scenarios to profile" }),
  entry("DENSITY_PROFILE_PHASE", [BENCH], { kind: "text", where: "shell", doc: "Indicator density bench: phase to profile" }),
  entry("DENSITY_PROFILE_OUT", [BENCH], { kind: "path", where: "shell", doc: "Indicator density bench: profile output" }),
  entry("DENSITY_ROWS", [BENCH], { kind: "number", integer: true, gt: 0, where: "shell", doc: "Indicator density bench: rows in the synthetic book (default 400)" }),
  entry("DENSITY_HISTORY", [BENCH], { kind: "flag", where: "shell", doc: "Indicator density bench: 0 leaves the history routes and the history phase off (default on)" }),
  entry("DENSITY_HISTORY_LATENCY_MS", [BENCH], { kind: "number", min: 0, where: "shell", doc: "Indicator density bench: delay the mock history routes add to each answer (default 50)" }),
  entry("L2_REPLAY_DROP_WALLS_INCREMENT", [BENCH], { kind: "number", integer: true, min: 0, where: "shell", doc: "L2 client replay bench negative control: drop the Nth live walls increment (0 = none)" }),
]);

const BY_NAME = new Map(CONFIG_REGISTRY.map((item) => [item.name, item]));

function describeExpected(item) {
  switch (item.kind) {
    case "text": return "any text";
    case "flag": return "0 or 1";
    case "enum": return item.values.join(" or ");
    case "bytes": return "a positive whole number of bytes";
    case "absPath": return "an absolute path";
    case "path": return "a path";
    case "isoTime": return "an ISO date-time";
    case "url": return "an absolute http(s) URL";
    case "origin": return "an http(s) origin without path, query or credentials";
    case "wsOrigin": return "a ws(s) origin without path, query or credentials";
    case "tailscaleOrigin": return "an https *.ts.net origin without path, query or credentials";
    case "number": {
      const parts = [item.integer ? "a whole number" : "a number"];
      if (item.gt !== undefined) parts.push(`above ${item.gt}`);
      if (item.min !== undefined) parts.push(`at least ${item.min}`);
      if (item.max !== undefined) parts.push(`at most ${item.max}`);
      return parts.join(", ");
    }
    default: return "a value";
  }
}

function parseHttpUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isBareOrigin(url) {
  return url.username === "" && url.password === "" && url.search === "" && url.hash === ""
    && (url.pathname === "/" || url.pathname === "");
}

function parseWsUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "ws:" || url.protocol === "wss:" ? url : null;
  } catch {
    return null;
  }
}

function valueIsValid(item, raw) {
  const value = raw.trim();
  switch (item.kind) {
    case "text":
    case "path":
      return value.length > 0;
    case "flag":
      return value === "0" || value === "1";
    case "enum":
      return item.values.includes(value);
    case "bytes":
      return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
    case "absPath":
      return path.isAbsolute(value);
    case "isoTime":
      return Number.isFinite(Date.parse(value));
    case "url":
      return parseHttpUrl(value) !== null;
    case "origin": {
      const url = parseHttpUrl(value);
      return url !== null && isBareOrigin(url);
    }
    case "wsOrigin": {
      const url = parseWsUrl(value);
      return url !== null && isBareOrigin(url);
    }
    case "tailscaleOrigin": {
      const url = parseHttpUrl(value);
      return url !== null && url.protocol === "https:" && url.hostname.endsWith(".ts.net")
        && url.hostname.length > ".ts.net".length && isBareOrigin(url);
    }
    case "number": {
      const number = Number(value);
      if (!Number.isFinite(number)) return false;
      if (item.integer && !Number.isSafeInteger(number)) return false;
      if (item.gt !== undefined && !(number > item.gt)) return false;
      if (item.min !== undefined && number < item.min) return false;
      if (item.max !== undefined && number > item.max) return false;
      return true;
    }
    default:
      return false;
  }
}

function validateProcessEnv(processName, env = process.env) {
  if (!Object.values(PROCESSES).includes(processName)) {
    throw new Error(`config: unknown process ${JSON.stringify(processName)}`);
  }
  const errors = [];
  const warnings = [];
  for (const [name, raw] of Object.entries(env)) {
    if (typeof raw !== "string" || raw === "") continue;
    const item = BY_NAME.get(name);
    if (item === undefined) {
      if (PROJECT_PREFIX.test(name)) warnings.push(Object.freeze({ name, problem: "is not a setting any process reads; check the spelling" }));
      continue;
    }
    if (!item.processes.includes(processName)) continue;
    if (!valueIsValid(item, raw)) {
      errors.push(Object.freeze({ name, problem: `must be ${describeExpected(item)}`, secret: item.secret }));
    }
  }
  return Object.freeze({ errors: Object.freeze(errors), warnings: Object.freeze(warnings) });
}

function formatProblems(result) {
  return result.errors.map((error) => `config: ${error.name} ${error.problem}`);
}

function assertProcessEnv(processName, env = process.env, { warn = (line) => console.warn(line) } = {}) {
  const result = validateProcessEnv(processName, env);
  for (const warning of result.warnings) warn(`config: ${warning.name} ${warning.problem}`);
  if (result.errors.length > 0) {
    const error = new Error(formatProblems(result).join("\n"));
    error.code = "CONFIG_INVALID";
    error.configErrors = result.errors;
    throw error;
  }
  return result;
}

function namesForProcess(processName) {
  return CONFIG_REGISTRY.filter((item) => item.processes.includes(processName)).map((item) => item.name);
}

module.exports = {
  CONFIG_REGISTRY,
  PROCESSES,
  VALIDATED_PROCESSES,
  PROJECT_PREFIX,
  MAX_WIRE_MAGNITUDE,
  validateProcessEnv,
  assertProcessEnv,
  formatProblems,
  namesForProcess,
  describeExpected,
  valueIsValid,
};
