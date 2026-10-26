#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { assertBrokerUrl } = require("../../src/providers/dxfeed/token-broker-client");
const { validateProcessEnv, CONFIG_REGISTRY } = require("../../src/platform/config-registry");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const LAUNCHER = path.join(REPOSITORY_ROOT, "scripts", "node-launcher.cjs");
const LIQUIDITY_READ_LIMIT_BYTES = 64 * 1024 * 1024;
const LIQUIDITY_STORE_BUDGET_BYTES = 48 * 1024 * 1024;
const LOCAL_PORTS = Object.freeze([["Terminal D", 8000], ["Terminal C", 8001]]);
const ONBOARDING = "docs/operations/00-developer-onboarding.md";
const PLACEHOLDER = /^<.*>$/;
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_INSTRUMENT_ID = JSON.stringify(["BINANCE", "SPOT", "BTCUSDT", "USDT", "COIN"]);
const PROBE_FROM_MS = Date.UTC(2026, 7, 3);
const PROBE_TO_MS = Date.UTC(2026, 7, 6);
const LIVE_STORAGE_CONTRACT_HEADER = "x-live-storage-contract-version";
const LIVE_STORAGE_CONTRACT = "live-storage/1";
const HOST_DATA_VARIABLES = Object.freeze([
  "TT_ARCHIVE_PROXY_URL",
  "VITE_ARCHIVE_CLIENT_TOKEN",
  "TT_LIVE_STORAGE_SERVICE_URL",
  "TT_LIVE_STORAGE_CLIENT_TOKEN",
]);

const NOT_CONFIGURED = "not configured";
const WORKING = "working";
const BROKEN = "broken";

function value(env, name) {
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

function requiredNode(root = REPOSITORY_ROOT) {
  try {
    return fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "");
  } catch {
    return null;
  }
}

function resolveWithLauncher(env) {
  try {
    return require(LAUNCHER).resolvePinnedNode({ env });
  } catch {
    return null;
  }
}

function checkNode(found, required, pinned = null) {
  if (required === null) return { status: BROKEN, detail: "cannot read .nvmrc from the repository root" };
  if (found === required) return { status: WORKING, detail: `Node ${found}` };
  if (pinned?.executable) {
    return { status: WORKING, detail: `this shell runs Node ${found}; npm start, npm run dev and the web dev server run Node ${required} from ${pinned.source} (${pinned.executable})` };
  }
  return { status: BROKEN, detail: `found Node ${found}, this repository requires ${required} (see .nvmrc); install it or set TT_NODE_BIN in .env to its folder` };
}

function checkConfig(env) {
  const result = validateProcessEnv("terminal-c", env);
  const terminalNames = new Set(CONFIG_REGISTRY.filter((item) => item.processes.includes("terminal-c") || item.processes.includes("terminal-d")).map((item) => item.name));
  const operatorOnly = CONFIG_REGISTRY
    .filter((item) => !terminalNames.has(item.name) && value(env, item.name) !== "")
    .map((item) => item.name);
  const typos = result.warnings.map((warning) => warning.name);
  const notes = [];
  if (operatorOnly.length > 0) notes.push(`Terminal C and D ignore ${operatorOnly.length} operator setting(s) in .env`);
  if (typos.length > 0) notes.push(`unknown setting(s), check the spelling: ${typos.join(", ")}`);
  if (result.errors.length > 0) {
    return broken("configuration", `${result.errors.map((error) => `${error.name} ${error.problem}`).join("; ")} (docs/operations/09-configuration.md)`);
  }
  return { status: WORKING, detail: ["every Terminal C setting is valid", ...notes].join("; ") };
}

function largestLiquidityStore(dir, fsImpl = fs) {
  let largest = null;
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const size = fsImpl.statSync(path.join(dir, entry.name)).size;
    if (largest === null || size > largest.size) largest = { name: entry.name, size };
  }
  return largest;
}

function checkLiquidityStore(dir, fsImpl = fs) {
  const largest = largestLiquidityStore(dir, fsImpl);
  if (largest === null) return { status: NOT_CONFIGURED, detail: "no stored heatmap history yet" };
  const mib = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
  if (largest.size > LIQUIDITY_READ_LIMIT_BYTES) {
    return broken("liquidity store", `${largest.name} is ${mib(largest.size)} MiB, above the ${mib(LIQUIDITY_READ_LIMIT_BYTES)} MiB the runtime will read; it is trimmed at the next save`);
  }
  return { status: WORKING, detail: `largest ${largest.name} ${mib(largest.size)} MiB of the ${mib(LIQUIDITY_STORE_BUDGET_BYTES)} MiB budget` };
}

async function checkPorts(connect, timeoutMs) {
  const states = [];
  for (const [label, port] of LOCAL_PORTS) {
    const probe = await connect("127.0.0.1", port, Math.min(timeoutMs, 1_000));
    states.push(`${label} :${port} ${probe.ok ? "running" : "not running"}`);
  }
  return { status: WORKING, detail: states.join(", ") };
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function parseHttpUrl(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: `${name} is not a valid URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: `${name} must be an http(s) URL` };
  return { url };
}

function connectOnce(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok, reason) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, reason });
    };
    socket.setTimeout(timeoutMs, () => finish(false, "timed out"));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(false, error.code ?? error.message));
  });
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, headers: response.headers, body };
  } catch (error) {
    return { error: controller.signal.aborted ? "timed out" : (error?.cause?.code ?? error?.message ?? String(error)) };
  } finally {
    clearTimeout(timer);
  }
}

function broken(step, detail) {
  return { status: BROKEN, step, detail };
}

function describeAge(ageMs) {
  if (!Number.isSafeInteger(ageMs)) return "no recent recording";
  if (ageMs < 120_000) return `last recorded ${Math.round(ageMs / 1000)} s ago`;
  if (ageMs < 7_200_000) return `last recorded ${Math.round(ageMs / 60_000)} min ago`;
  return `last recorded ${Math.round(ageMs / 3_600_000)} h ago`;
}

async function checkHostData(env, { fetchImpl, connect, now, timeoutMs }) {
  const present = HOST_DATA_VARIABLES.filter((name) => value(env, name) !== "");
  const liveProxy = value(env, "TT_LIVE_PROXY_URL");
  if (liveProxy !== "") {
    const parsed = parseHttpUrl(liveProxy, "TT_LIVE_PROXY_URL");
    if (parsed.error || !isLoopback(parsed.url.hostname)) {
      return broken("configuration", "TT_LIVE_PROXY_URL must be unset or point at this laptop; live ticks never come from the host");
    }
  }
  if (present.length === 0) {
    return { status: NOT_CONFIGURED, detail: `optional; ask the owner for a WireGuard peer and a gateway bearer (${ONBOARDING})` };
  }
  const missing = HOST_DATA_VARIABLES.filter((name) => !present.includes(name));
  if (missing.length > 0) return broken("configuration", `incomplete: set ${missing.join(", ")} as well`);
  const placeholders = HOST_DATA_VARIABLES.filter((name) => PLACEHOLDER.test(value(env, name)));
  if (placeholders.length > 0) return broken("configuration", `${placeholders.join(", ")} still hold the template placeholder`);
  const bearer = value(env, "VITE_ARCHIVE_CLIENT_TOKEN");
  if (bearer !== value(env, "TT_LIVE_STORAGE_CLIENT_TOKEN")) {
    return broken("configuration", "VITE_ARCHIVE_CLIENT_TOKEN and TT_LIVE_STORAGE_CLIENT_TOKEN must hold the same bearer");
  }
  const archive = parseHttpUrl(value(env, "TT_ARCHIVE_PROXY_URL"), "TT_ARCHIVE_PROXY_URL");
  if (archive.error) return broken("configuration", archive.error);
  const liveStorage = parseHttpUrl(value(env, "TT_LIVE_STORAGE_SERVICE_URL"), "TT_LIVE_STORAGE_SERVICE_URL");
  if (liveStorage.error) return broken("configuration", liveStorage.error);
  if (!liveStorage.url.pathname.replace(/\/$/, "").endsWith("/live-storage")) {
    return broken("configuration", "TT_LIVE_STORAGE_SERVICE_URL must end in /live-storage");
  }

  const gateway = archive.url;
  const port = Number(gateway.port || (gateway.protocol === "https:" ? 443 : 80));
  const tcp = await connect(gateway.hostname, port, timeoutMs);
  if (!tcp.ok) {
    return broken("WireGuard", `cannot reach ${gateway.hostname}:${port} (${tcp.reason}); check the tunnel is active and its AllowedIPs include the gateway`);
  }

  const origin = gateway.origin;
  const health = await fetchWithTimeout(fetchImpl, `${origin}/health`, { method: "GET" }, timeoutMs);
  if (health.error) return broken("gateway", `GET /health failed (${health.error})`);
  if (health.status !== 200 || health.body?.ready !== true) {
    const reasons = Array.isArray(health.body?.reasons) ? ` (${health.body.reasons.join(", ")})` : "";
    return broken("gateway", `the gateway answered but is not ready: HTTP ${health.status}${reasons}; tell the owner`);
  }

  const authorization = `Bearer ${bearer}`;
  const query = await fetchWithTimeout(fetchImpl, `${origin}/archive/query`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      contractVersion: "archive-query/1",
      instrumentId: PROBE_INSTRUMENT_ID,
      family: "candle_1d",
      from: String(BigInt(PROBE_FROM_MS) * 1_000_000n),
      to: String(BigInt(PROBE_TO_MS) * 1_000_000n),
      limit: 1,
    }),
  }, timeoutMs);
  if (query.error) return broken("archive", `POST /archive/query failed (${query.error})`);
  if (query.status === 401 || query.status === 403) {
    return broken("bearer", `the gateway refused your bearer (HTTP ${query.status}); check it matches what the owner issued`);
  }
  if (query.status !== 200 || !Array.isArray(query.body?.rows)) {
    const code = typeof query.body?.error === "string" ? ` ${query.body.error}` : "";
    return broken("archive", `the archive answered HTTP ${query.status}${code}; tell the owner`);
  }
  if (query.body.rows.length === 0) {
    return broken("archive", "the archive answered but has no BTCUSDT candle for 2026-08-03, which is published; tell the owner");
  }

  const liveStorageBase = liveStorage.url.href.replace(/\/$/, "");
  const age = await fetchWithTimeout(fetchImpl, `${liveStorageBase}/recording-age`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      [LIVE_STORAGE_CONTRACT_HEADER]: LIVE_STORAGE_CONTRACT,
    },
    body: JSON.stringify({ symbol: "BTCUSDT", marketKind: "SPOT", options: { nowMs: now } }),
  }, timeoutMs);
  if (age.error) return broken("live-storage", `POST /live-storage/recording-age failed (${age.error})`);
  if (age.status === 401 || age.status === 403) {
    return broken("bearer", `the live-storage route refused your bearer (HTTP ${age.status}); check TT_LIVE_STORAGE_CLIENT_TOKEN`);
  }
  if (age.status !== 200 || age.headers?.get?.(LIVE_STORAGE_CONTRACT_HEADER) !== LIVE_STORAGE_CONTRACT
      || typeof age.body?.available !== "boolean") {
    return broken("live-storage", `live-storage answered HTTP ${age.status} without a valid live-storage/1 body; tell the owner`);
  }

  return {
    status: WORKING,
    detail: `archive answered (BTCUSDT candle for 2026-08-03), live-storage answered (BTCUSDT spot ${describeAge(age.body.ageMs)})`,
  };
}

function checkDxFeed(env) {
  const raw = value(env, "TT_DXFEED_TOKEN_BROKER_URL");
  if (raw === "") {
    return { status: NOT_CONFIGURED, detail: `optional; ask the owner for Tailscale access to the dxFeed token broker (${ONBOARDING})` };
  }
  try {
    assertBrokerUrl(raw);
  } catch (error) {
    return broken("configuration", error.message.replace(/^dxfeed-token-broker: /, "TT_DXFEED_TOKEN_BROKER_URL: "));
  }
  return {
    status: WORKING,
    detail: "broker URL set; the broker itself is contacted only when you select a dxFeed instrument, and needs Tailscale up",
  };
}

async function runDoctor({
  env = process.env,
  nodeVersion = process.versions.node,
  required = requiredNode(),
  resolveNode = () => resolveWithLauncher(env),
  liquidityStoreDir = null,
  fetchImpl = globalThis.fetch,
  connect = connectOnce,
  now = Date.now(),
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const node = checkNode(nodeVersion, required, nodeVersion === required ? null : resolveNode());
  const config = checkConfig(env);
  const local = {
    liquidityStore: liquidityStoreDir === null ? { status: NOT_CONFIGURED, detail: "not checked" } : checkLiquidityStore(liquidityStoreDir),
    ports: await checkPorts(connect, timeoutMs),
  };
  const hostData = await checkHostData(env, { fetchImpl, connect, now, timeoutMs });
  const dxfeed = checkDxFeed(env);
  const ok = [node, config, local.liquidityStore, hostData, dxfeed].every((check) => check.status !== BROKEN);
  return { ok, node, config, local, layers: { repository: { status: WORKING, detail: "Live Mode on Binance" }, hostData, dxfeed } };
}

function formatCheck(label, check) {
  const mark = check.status === WORKING ? "ok  " : check.status === BROKEN ? "FAIL" : "--  ";
  const where = check.status === BROKEN && check.step ? `${check.step}: ` : "";
  return `  ${mark} ${label.padEnd(22)} ${check.status === BROKEN ? "" : `${check.status} — `}${where}${check.detail}`;
}

function formatReport(report) {
  return [
    "Terminal-L1-L2 doctor",
    formatCheck("Node", report.node),
    formatCheck("Settings", report.config),
    formatCheck("Heatmap store", report.local.liquidityStore),
    formatCheck("Local terminals", report.local.ports),
    formatCheck("Layer 0 · Repository", report.layers.repository),
    formatCheck("Layer 1 · Host data", report.layers.hostData),
    formatCheck("Layer 2 · dxFeed live", report.layers.dxfeed),
    "",
    report.ok
      ? "Every configured layer works. Unconfigured layers are optional."
      : "A configured layer is broken; the line marked FAIL names where.",
  ].join("\n");
}

async function main() {
  const { DEFAULT_STORE_DIR } = require("../../src/indicators/l2-memory/liquidity-store");
  const report = await runDoctor({ liquidityStoreDir: value(process.env, "L2_HEATMAP_STORE_DIR") || DEFAULT_STORE_DIR });
  process.stdout.write(`${formatReport(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`doctor: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  runDoctor,
  formatReport,
  checkHostData,
  checkDxFeed,
  checkNode,
  checkConfig,
  checkLiquidityStore,
  HOST_DATA_VARIABLES,
  NOT_CONFIGURED,
  WORKING,
  BROKEN,
};
