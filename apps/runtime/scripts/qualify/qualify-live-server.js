#!/usr/bin/env node

const { WebSocket } = require("ws");

const DEFAULT_WS_URL = "ws://127.0.0.1:8001/ws";
const ORIGIN = "http://localhost:8000";
const TIMEOUT_MS = 30_000;

function resolveEndpoints(wsUrlArg) {
  const wsUrl = wsUrlArg ?? DEFAULT_WS_URL;
  if (typeof wsUrl !== "string" || !/^wss?:\/\//.test(wsUrl)) {
    throw new Error(`qualify-live-server: ws url must start with ws:// or wss://, got "${wsUrl}"`);
  }
  return { wsUrl, httpUrl: new URL("/health", wsUrl.replace(/^ws/, "http")).toString() };
}

function createProbe(name, wsUrl) {
  const frames = [];
  let malformedFrames = 0;
  const client = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } });
  client.on("message", (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {
      malformedFrames += 1;
    }
  });

  const opened = new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });

  async function waitFor(predicate, label, since = 0) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const match = frames.slice(since).find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${name}: timed out waiting for ${label}`);
  }

  return { client, frames, opened, waitFor, malformedFrameCount: () => malformedFrames };
}

async function closeProbe(probe) {
  if (probe.client.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => probe.client.once("close", resolve));
  probe.client.close();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (probe.client.readyState !== WebSocket.CLOSED) probe.client.terminate();
}

async function main() {
  const startedAt = Date.now();
  const { wsUrl, httpUrl } = resolveEndpoints(process.argv[2]);
  const probes = [createProbe("client-1", wsUrl), createProbe("client-2", wsUrl)];
  try {
    await Promise.all(probes.map((probe) => probe.opened));
    const initialSelections = await Promise.all(probes.map((probe) => probe.waitFor(
      (frame) => frame.type === "selection",
      "initial selection",
    )));
    if (initialSelections.some((frame) => frame.provider !== "BINANCE" || frame.symbol !== "BTC-USDT" || frame.marketKind !== "SPOT")) {
      probes[0].client.send(JSON.stringify({ type: "select", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" }));
    }
    await Promise.all(probes.map((probe) => probe.waitFor(
      (frame) => frame.type === "selection" && frame.provider === "BINANCE" && frame.symbol === "BTC-USDT" && frame.marketKind === "SPOT",
      "qualified Binance selection",
    )));
    await Promise.all(probes.map((probe) => probe.waitFor(
      (frame) => frame.type === "trade" && frame.provider === "BINANCE" && frame.symbol === "BTC-USDT",
      "live Binance trade",
    )));

    const dxfeedGeneration = probes.map((probe) => probe.frames.length);
    probes[0].client.send(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }));
    await Promise.all(probes.map((probe, index) => probe.waitFor(
      (frame) => frame.type === "selection" && frame.provider === "DXFEED" && frame.symbol === "AAPL",
      "shared dxFeed selection",
      dxfeedGeneration[index],
    )));
    await Promise.all(probes.map((probe, index) => probe.waitFor(
      (frame) => frame.type === "health" && frame.provider === "DXFEED" && frame.symbol === "AAPL" && frame.recoveryState === "READY",
      "dxFeed READY health",
      dxfeedGeneration[index],
    )));

    const response = await fetch(httpUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`health endpoint returned HTTP ${response.status}`);
    const health = await response.json();
    if (health.ready !== true || health.connections < probes.length || health.dxfeed?.active !== true) {
      throw new Error(`health endpoint did not prove the expected active state: ${JSON.stringify(health)}`);
    }

    const restoreGeneration = probes.map((probe) => probe.frames.length);
    probes[1].client.send(JSON.stringify({ type: "select", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" }));
    await Promise.all(probes.map((probe, index) => probe.waitFor(
      (frame) => frame.type === "selection" && frame.provider === "BINANCE" && frame.symbol === "BTC-USDT",
      "shared Binance restoration",
      restoreGeneration[index],
    )));

    console.log(JSON.stringify({
      ok: true,
      clients: probes.length,
      providersExercised: ["BINANCE", "DXFEED"],
      framesObserved: probes.map((probe) => probe.frames.length),
      malformedFrames: probes.map((probe) => probe.malformedFrameCount()),
      healthReady: health.ready,
      elapsedMs: Date.now() - startedAt,
    }));
  } finally {
    await Promise.all(probes.map(closeProbe));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`live server qualification failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

module.exports = { resolveEndpoints, DEFAULT_WS_URL };
