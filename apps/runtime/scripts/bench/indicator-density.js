#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const Module = require("node:module");
const { spawn } = require("node:child_process");
const { WebSocket, WebSocketServer } = require("ws");
const { densityHistory, liveBarFrame, liveColumnFrame, historyColumnsPage, historyWallsPage, seeded } = require("./indicator-density-frames");
const { createHeatmapRoute } = require("../../src/server/heatmap-route");

const WEB_ROOT = path.resolve(__dirname, "../../../web");
const DIST = path.join(WEB_ROOT, "dist");
const FAVORITES_STORAGE_KEY = "terminal.indicators.favorites";
const SCENARIOS = Object.freeze({
  baseline: [],
  bookMap: ["l2BookMap"],
  orderBlocks: ["classicOrderBlocks", "institutionalOrderBlocks", "l1OrderBlocks"],
  wallsV2: ["institutionalOrderBlocksV2"],
  absorption: ["absorptionDetector"],
  heatmap: ["passiveLiquidity"],
  heatmapAbsorption: ["passiveLiquidity", "absorptionDetector"],
  whaleHeatmap: ["whaleLimitOrderHeatmap"],
  all: ["l2BookMap", "classicOrderBlocks", "institutionalOrderBlocks", "l1OrderBlocks", "institutionalOrderBlocksV2", "absorptionDetector", "passiveLiquidity"],
  // Since the session profile merge (#35) this draws one session profile where it
  // drew two (Volume and Delta Profile), so its numbers from before are not like for like.
  everything: ["rsi", "ema", "bollinger", "sma", "largeTradeBubbles", "killzones", "orderFlow", "largeTradeDetector", "deltaDivergence", "sessionVolumeProfile", "sessionDeltaProfile", "vpinCloud", "volumeDeltaProfileOhlc", "pivotPoints", "pivotSupportResistance", "passiveLiquidity", "marketStructure", "swingAlphabetProfile", "aggressiveOrders", "absorptionDetector", "fvgBoxes", "l2SupportResistance", "l2BookMap", "fvgDelta", "classicOrderBlocks", "institutionalOrderBlocks", "institutionalOrderBlocksV2", "l1OrderBlocks"],
});
const LIVE_BAR_PULSE_MS = 250;
const TIMEFRAME_SEQUENCE = Object.freeze(["5m", "15m", "1h", "1m", "15m", "5m", "1m"]);
const FROZEN_HOVER_POINTS = Object.freeze([[0.5, 0.6], [0.66, 0.78], [0.86, 0.5]]);
const FROZEN_SETTLE_MS = 600;
const FROZEN_TICK_OFFSETS_MS = Object.freeze([0, 250, 500, 60_000, 60_250]);
const FROZEN_TICK_GAP_MS = 150;
const BUDGETS = Object.freeze({ steadyLongTaskMaxMs: 100, frameIntervalP95Ms: 33, perIndicatorAddedP95Ms: 8 });
const FULL_GATE_SCENARIOS = Object.freeze(["whaleHeatmap"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function quantiles(values) {
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return { count: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted[sorted.length - 1]) };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function scenarioReadinessIssues(page, favorites) {
  const issues = [];
  if (!page.chartCanvas) issues.push("chart canvas missing");
  if (!page.ohlcReadout) issues.push("candle history not displayed");
  if (!page.liveBadge) issues.push("live feed not ready");
  if (page.indicatorRows !== favorites.length) issues.push(`expected ${favorites.length} indicator rows, found ${page.indicatorRows}`);
  if (page.hiddenIndicatorRows !== 0) issues.push("one or more indicators hidden");
  if (favorites.includes("passiveLiquidity") && !page.liquidityLoaded) issues.push("liquidity history not displayed");
  return issues;
}

function browserParser() {
  const ts = require(path.join(WEB_ROOT, "node_modules/typescript"));
  const file = path.join(WEB_ROOT, "src/types/frames.ts");
  const source = fs.readFileSync(file, "utf8").replace(
    /import marketInstrumentCatalog from "([^"]+)";/,
    (_, spec) => `const marketInstrumentCatalog = require(${JSON.stringify(path.resolve(path.dirname(file), spec))});`,
  );
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = new Module(file);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(compiled, file);
  return loaded.exports.parseServerFrame;
}

function preflight(frames) {
  const parse = browserParser();
  const nowMs = Date.now();
  const rejected = frames.filter((frame) => parse(frame, { nowMs }) === null).map((frame) => frame.type);
  if (rejected.length > 0) throw new Error(`indicator-density: the browser parser rejects ${rejected.length} generated frames (${[...new Set(rejected)].join(", ")})`);
}

function cdp(url) {
  const socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
  const pending = new Map();
  const errors = [];
  let id = 0;
  socket.on("message", (wire) => {
    const message = JSON.parse(wire.toString());
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      errors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 500));
    }
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    if (message.error) job.reject(new Error(JSON.stringify(message.error)));
    else job.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    errors,
    async send(method, params = {}) {
      await ready;
      return new Promise((resolve, reject) => {
        const next = ++id;
        const timer = setTimeout(() => {
          pending.delete(next);
          reject(new Error(`CDP deadline: ${method}`));
        }, 60_000);
        pending.set(next, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: next, method, params }));
      });
    },
  };
}

function sourceResolver(distDir) {
  const consumers = new Map();
  let SourceMapConsumer = null;
  try {
    ({ SourceMapConsumer } = require("source-map-js"));
  } catch {
    return () => null;
  }
  return (url, line, column) => {
    const file = path.join(distDir, "assets", path.basename(url || ""));
    if (!consumers.has(file)) {
      const map = `${file}.map`;
      consumers.set(file, fs.existsSync(map) ? new SourceMapConsumer(JSON.parse(fs.readFileSync(map, "utf8"))) : null);
    }
    const consumer = consumers.get(file);
    if (!consumer) return null;
    const original = consumer.originalPositionFor({ line: line + 1, column });
    if (!original.source) return null;
    const source = original.source.replace(/^.*?(src\/|node_modules\/)/, "$1");
    return `${original.name ?? "?"} ${source}:${original.line}`;
  };
}

function selfTimeTop(profile, limit, resolve = () => null) {
  const byNode = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const intervals = profile.timeDeltas;
  profile.samples.forEach((nodeId, index) => {
    const frame = byNode.get(nodeId).callFrame;
    const key = resolve(frame.url, frame.lineNumber, frame.columnNumber) ?? `${frame.functionName || "(anonymous)"} ${path.basename(frame.url || "")}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (intervals[index] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((sum, value) => sum + value, 0);
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, ms]) => ({ name, ms: round(ms), share: round((100 * ms) / Math.max(total, 1)) }));
}

async function runScenario({ chromePath, name, favorites, history, phases, profile, profilePhase = "hover", profileOut = null, distDir, liveBars = true, frozen = false, captureOut = null, historyRoutes = true, historyLatencyMs = 50 }) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "density-chrome-"));
  const random = seeded(11);
  let chrome;
  let devtools;
  let pulse = null;
  let seq = history.fineSeq;
  let columnTs = history.lastFineTs;
  let tradeId = 0;
  let barPulse = null;
  let liveBar = null;
  let columnsRoute = null;
  let wallsRoute = null;
  const served = {};
  let navigatedAt = null;
  const account = (pathname, status, bytes, ms) => {
    const entry = (served[pathname] ??= { requests: 0, bytes: 0, statuses: {}, latencyMs: [], firstAtMs: null, lastAtMs: null });
    if (navigatedAt !== null) {
      const at = performance.now() - navigatedAt;
      entry.firstAtMs ??= at;
      entry.lastAtMs = at;
    }
    entry.requests += 1;
    entry.bytes += bytes;
    entry.statuses[status] = (entry.statuses[status] ?? 0) + 1;
    entry.latencyMs.push(ms);
  };
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (request.method === "POST" && columnsRoute !== null) {
      const started = performance.now();
      let sentBytes = 0;
      const writeHead = response.writeHead.bind(response);
      response.writeHead = (status, headers, ...rest) => {
        sentBytes = Number(headers?.["content-length"] ?? 0);
        return writeHead(status, headers, ...rest);
      };
      response.once("finish", () => account(pathname, response.statusCode, sentBytes, performance.now() - started));
      if (columnsRoute.handle(request, response) || wallsRoute.handle(request, response)) return;
      response.removeAllListeners("finish");
    }
    const target = pathname === "/" ? path.join(distDir, "index.html") : path.resolve(distDir, `.${pathname}`);
    if (!target.startsWith(`${distDir}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".json": "application/json" };
    response.setHeader("Content-Type", types[path.extname(target)] ?? "application/octet-stream");
    fs.createReadStream(target).pipe(response);
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  const identity = history.identity;
  const initialize = (socket) => {
    socket.send(JSON.stringify({ type: "selection", ...identity }));
    socket.send(JSON.stringify({ type: "snapshot", ...identity, bars: history.bars, trades: [], markers: [] }));
    socket.send(JSON.stringify({ type: "health", ...identity, recoveryState: "READY", stale: false }));
    socket.send(JSON.stringify({ type: "book", ...identity, status: "READY", bids: [{ price: history.mid - 1, size: 3 }], asks: [{ price: history.mid + 1, size: 2 }], lastUpdateId: 1, stale: false }));
    for (const frame of history.liquidityFrames) socket.send(JSON.stringify(frame));
  };
  wss.on("connection", (socket) => {
    socket.on("message", (wire) => {
      let message = null;
      try {
        message = JSON.parse(wire.toString());
      } catch {
        return;
      }
      if (message?.type === "select") initialize(socket);
    });
    initialize(socket);
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    if (historyRoutes) {
      const allowedOrigins = new Set([`http://127.0.0.1:${server.address().port}`]);
      const delayed = (build) => async (_provider, _symbol, _kind, options) => {
        await sleep(historyLatencyMs);
        return build({ history, ...options });
      };
      columnsRoute = createHeatmapRoute({ read: delayed(historyColumnsPage), allowedOrigins, log: () => {} });
      wallsRoute = createHeatmapRoute({ read: delayed(historyWallsPage), allowedOrigins, path: "/heatmap/walls", routeName: "wall-history", log: () => {} });
    }
    chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--window-size=1600,1000", "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    const portFile = path.join(profileDir, "DevToolsActivePort");
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(portFile)) {
      if (Date.now() > deadline || chrome.exitCode !== null) throw new Error("headless Chrome did not start");
      await sleep(50);
    }
    const debugPort = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
    devtools = cdp(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
    await devtools.send("Page.enable");
    await devtools.send("Runtime.enable");
    await devtools.send("Performance.enable");
    await devtools.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      try { localStorage.setItem(${JSON.stringify(FAVORITES_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(favorites))}); } catch {}
      ${frozen ? `Date.now = () => ${history.nowMs};` : ""}
      window.__density = { phase: "load", longTasks: {}, frames: {} };
      const bucket = (store, value) => { const phase = window.__density.phase; (store[phase] ??= []).length < 50000 && store[phase].push(value); };
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) bucket(window.__density.longTasks, entry.duration); }).observe({ type: "longtask", buffered: true });
      let last = null;
      const tick = (now) => { if (last !== null) bucket(window.__density.frames, now - last); last = now; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);` });
    let profileTop = null;
    const startProfile = async () => {
      await devtools.send("Profiler.enable");
      await devtools.send("Profiler.setSamplingInterval", { interval: 200 });
      await devtools.send("Profiler.start");
    };
    const stopProfile = async () => {
      const { profile: cpu } = await devtools.send("Profiler.stop");
      profileTop = selfTimeTop(cpu, 20, sourceResolver(distDir));
      if (profileOut) fs.writeFileSync(path.join(profileOut, `${name}-${profilePhase}.cpuprofile`), JSON.stringify(cpu));
    };
    if (profile && profilePhase === "load") await startProfile();
    navigatedAt = performance.now();
    await devtools.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
    const connectDeadline = Date.now() + 20_000;
    while (wss.clients.size === 0) {
      if (Date.now() > connectDeadline) throw new Error("web worker did not connect");
      await sleep(50);
    }
    if (!frozen) pulse = setInterval(() => {
      columnTs += 1_000;
      seq += 1;
      const frame = liveColumnFrame({ history, ts: columnTs, seq, random });
      const now = Date.now();
      tradeId += 1;
      const trade = { type: "trade", ...identity, trade_id: `t-${tradeId}`, ts_exchange: now, price: history.mid, size: 0.5, side: tradeId % 2 === 0 ? "buy" : "sell" };
      for (const socket of wss.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        socket.send(JSON.stringify(frame));
        socket.send(JSON.stringify(trade));
      }
    }, 1_000);
    if (liveBars && !frozen) {
      barPulse = setInterval(() => {
        const step = liveBarFrame({ history, previous: liveBar, nowMs: Date.now(), random });
        liveBar = step.next;
        for (const socket of wss.clients) {
          if (socket.readyState !== WebSocket.OPEN) continue;
          for (const frame of step.frames) socket.send(JSON.stringify(frame));
        }
      }, LIVE_BAR_PULSE_MS);
    }
    const setPhase = (phase) => devtools.send("Runtime.evaluate", { expression: `window.__density.phase = ${JSON.stringify(phase)}` });
    const busy = async () => {
      const metrics = await devtools.send("Performance.getMetrics");
      return Object.fromEntries(metrics.metrics.map((entry) => [entry.name, entry.value]));
    };
    const taskSeconds = {};
    await sleep(phases.loadSeconds * 1000);
    if (profile && profilePhase === "load") await stopProfile();
    const readinessResult = await devtools.send("Runtime.evaluate", { expression: `JSON.stringify((() => {
      const badge = document.querySelector('.chart-badge');
      const liquidity = [...(badge?.querySelectorAll('.indicator-legend-row') ?? [])]
        .find((row) => row.querySelector('.indicator-legend-label')?.textContent === 'Passive Liquidity Heatmap');
      return {
        chartCanvas: Boolean(document.querySelector('.chart-mount canvas')),
        ohlcReadout: Boolean(document.querySelector('.ohlc-readout')),
        liveBadge: Boolean(badge?.querySelector('.live-tag')),
        indicatorRows: badge?.querySelectorAll('.indicator-legend-row').length ?? 0,
        hiddenIndicatorRows: badge?.querySelectorAll('.indicator-legend-row-hidden').length ?? 0,
        liquidityLoaded: Boolean(liquidity?.querySelector('.indicator-legend-detail')?.textContent?.includes('rows ')),
      };
    })())`, returnByValue: true });
    const pageState = JSON.parse(readinessResult.result.value);
    const readinessIssues = scenarioReadinessIssues(pageState, favorites);
    if (readinessIssues.length > 0) throw new Error(`indicator-density: ${name} is not ready: ${readinessIssues.join('; ')}`);
    const rectResult = await devtools.send("Runtime.evaluate", { expression: "JSON.stringify((document.querySelector('.chart-mount canvas') ?? document.querySelector('canvas')).getBoundingClientRect())", returnByValue: true });
    const rect = JSON.parse(rectResult.result.value);
    if (frozen) {
      const captures = [];
      const capture = async (label) => {
        await sleep(FROZEN_SETTLE_MS);
        const shot = await devtools.send("Page.captureScreenshot", { format: "png", clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } });
        const png = Buffer.from(shot.data, "base64");
        const file = captureOut ? path.join(captureOut, `${name}-${label}.png`) : null;
        if (file) fs.writeFileSync(file, png);
        captures.push({ label, sha256: crypto.createHash("sha256").update(png).digest("hex"), bytes: png.length, file });
      };
      const frozenTimeframe = process.env.DENSITY_FROZEN_TF ?? null;
      if (frozenTimeframe !== null) {
        const clicked = await devtools.send("Runtime.evaluate", { expression: `(() => { const pill = [...document.querySelectorAll('.tf-pill')].find((button) => button.textContent.trim() === ${JSON.stringify(frozenTimeframe)}); if (!pill) return false; pill.click(); return true; })()`, returnByValue: true });
        if (clicked.result.value !== true) throw new Error(`indicator-density: no ${frozenTimeframe} timeframe button`);
        await sleep(FROZEN_SETTLE_MS * 3);
      }
      await capture("load");
      for (const [index, [fx, fy]] of FROZEN_HOVER_POINTS.entries()) {
        await devtools.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + rect.width * fx, y: rect.y + rect.height * fy });
        await capture(`hover-${index + 1}`);
      }
      await devtools.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + rect.width - 2, y: rect.y + 2 });
      await capture("idle");
      if (liveBars) {
        await devtools.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.max(0, rect.x - 20), y: Math.max(0, rect.y - 20) });
        const tickRandom = seeded(99);
        let tickBar = null;
        for (const offsetMs of FROZEN_TICK_OFFSETS_MS) {
          const step = liveBarFrame({ history, previous: tickBar, nowMs: history.nowMs + offsetMs, random: tickRandom });
          tickBar = step.next;
          for (const socket of wss.clients) {
            if (socket.readyState !== WebSocket.OPEN) continue;
            for (const frame of step.frames) socket.send(JSON.stringify(frame));
          }
          await sleep(FROZEN_TICK_GAP_MS);
        }
        await capture("ticked");
        const toggleAll = (label) => devtools.send("Runtime.evaluate", { expression: `for (const button of document.querySelectorAll('.indicator-legend-row .indicator-legend-icon[aria-label="${label}"]')) button.click();` });
        await toggleAll("Hide indicator");
        await sleep(FROZEN_SETTLE_MS);
        await toggleAll("Show indicator");
        await capture("rebuilt");
      }
      return { scenario: name, favorites, frozen: true, captures, pageErrors: devtools.errors };
    }
    const startTimeframe = process.env.DENSITY_TF ?? null;
    if (startTimeframe !== null) {
      const clicked = await devtools.send("Runtime.evaluate", { expression: `(() => { const pill = [...document.querySelectorAll('.tf-pill')].find((button) => button.textContent.trim() === ${JSON.stringify(startTimeframe)}); if (!pill) return false; pill.click(); return true; })()`, returnByValue: true });
      if (clicked.result.value !== true) throw new Error(`indicator-density: no ${startTimeframe} timeframe button`);
      await sleep(3_000);
    }
    if (captureOut) {
      const shot = await devtools.send("Page.captureScreenshot", { format: "png", clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } });
      fs.writeFileSync(path.join(captureOut, `${name}-ready.png`), Buffer.from(shot.data, "base64"));
    }
    await setPhase("steady");
    if (profile && profilePhase === "steady") await startProfile();
    let before = await busy();
    await sleep(phases.steadySeconds * 1000);
    let after = await busy();
    if (profile && profilePhase === "steady") await stopProfile();
    taskSeconds.steady = round((after.TaskDuration - before.TaskDuration) * 1000) / 1000;
    await setPhase("hover");
    if (profile && profilePhase === "hover") await startProfile();
    before = await busy();
    const hoverEnd = Date.now() + phases.hoverSeconds * 1000;
    let step = 0;
    while (Date.now() < hoverEnd) {
      const x = rect.x + 20 + ((step * 7) % Math.max(1, rect.width - 40));
      const y = rect.y + 20 + ((step * 13) % Math.max(1, rect.height - 40));
      await devtools.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      step += 1;
      await sleep(16);
    }
    after = await busy();
    taskSeconds.hover = round((after.TaskDuration - before.TaskDuration) * 1000) / 1000;
    const hoverMoves = step;
    if (profile && profilePhase === "hover") await stopProfile();
    const timeframePhases = [];
    if (phases.timeframeSeconds > 0) {
      if (profile && profilePhase === "timeframe") await startProfile();
      for (const [n, label] of TIMEFRAME_SEQUENCE.entries()) {
        const phase = `tf:${n}:${label}`;
        await setPhase(phase);
        const clicked = await devtools.send("Runtime.evaluate", { expression: `(() => { const pill = [...document.querySelectorAll('.tf-pill')].find((button) => button.textContent.trim() === ${JSON.stringify(label)}); if (!pill) return false; pill.click(); return true; })()`, returnByValue: true });
        if (clicked.result.value !== true) throw new Error(`indicator-density: no ${label} timeframe button`);
        await sleep(phases.timeframeSeconds * 1000);
        timeframePhases.push({ phase, label });
      }
      if (profile && profilePhase === "timeframe") await stopProfile();
    }
    await setPhase("pan");
    before = await busy();
    const panY = rect.y + rect.height / 2;
    await devtools.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x + rect.width * 0.8, y: panY, button: "left", clickCount: 1 });
    for (let n = 0; n <= 60; n += 1) {
      await devtools.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + rect.width * (0.8 - n * 0.01), y: panY, button: "left", buttons: 1 });
      await sleep(16);
    }
    await devtools.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x + rect.width * 0.2, y: panY, button: "left", clickCount: 1 });
    await sleep(phases.panSettleSeconds * 1000);
    after = await busy();
    taskSeconds.pan = round((after.TaskDuration - before.TaskDuration) * 1000) / 1000;
    if (phases.historySeconds > 0 && historyRoutes) {
      await setPhase("history");
      if (profile && profilePhase === "history") await startProfile();
      before = await busy();
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      for (let n = 0; n < 40; n += 1) {
        await devtools.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: centerX, y: centerY, deltaX: 0, deltaY: 240 });
        await sleep(50);
      }
      await sleep(phases.historySeconds * 1000);
      after = await busy();
      taskSeconds.history = round((after.TaskDuration - before.TaskDuration) * 1000) / 1000;
      if (profile && profilePhase === "history") await stopProfile();
    }
    const final = await busy();
    const observed = await devtools.send("Runtime.evaluate", { expression: "JSON.stringify(window.__density)", returnByValue: true });
    const data = JSON.parse(observed.result.value);
    const summary = {};
    for (const phase of ["load", "steady", "hover", "pan", "history"]) {
      if (phase === "history" && !(phases.historySeconds > 0 && historyRoutes)) continue;
      summary[phase] = { longTaskMs: quantiles(data.longTasks[phase] ?? []), frameIntervalMs: quantiles(data.frames[phase] ?? []) };
    }
    const timeframeSwitches = timeframePhases.map(({ phase, label }) => {
      const longTasks = data.longTasks[phase] ?? [];
      return { label, longTaskCount: longTasks.length, longTaskTotalMs: round(longTasks.reduce((sum, value) => sum + value, 0)), longTaskMs: quantiles(longTasks), frameIntervalMs: quantiles(data.frames[phase] ?? []) };
    });
    const routes = Object.fromEntries(Object.entries(served).map(([route, entry]) => [route, { requests: entry.requests, bytes: entry.bytes, statuses: entry.statuses, latencyMs: quantiles(entry.latencyMs), firstRequestMs: entry.firstAtMs === null ? null : round(entry.firstAtMs), lastRequestMs: entry.lastAtMs === null ? null : round(entry.lastAtMs) }]));
    return {
      scenario: name,
      favorites,
      pageState,
      phases: summary,
      mainThreadBusySeconds: taskSeconds,
      hoverMoves,
      heapUsedMb: round(final.JSHeapUsedSize / 1e6),
      domNodes: final.Nodes,
      pageErrors: devtools.errors,
      profileTop,
      ...(timeframeSwitches.length > 0 ? { timeframeSwitches } : {}),
      ...(data.counts ? { counts: data.counts } : {}),
      ...(historyRoutes ? { historyRoutes: { routes, columns: columnsRoute.stats(), walls: wallsRoute.stats() } } : {}),
    };
  } finally {
    clearInterval(pulse);
    clearInterval(barPulse);
    if (devtools) {
      await devtools.send("Browser.close").catch(() => {});
      devtools.socket.close();
    }
    if (chrome) {
      const until = Date.now() + 5_000;
      while (chrome.exitCode === null && chrome.signalCode === null && Date.now() < until) await sleep(50);
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill();
    }
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (path.basename(profileDir).startsWith("density-chrome-")) fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function verdict(results) {
  const baseline = results.find((result) => result.scenario === "baseline");
  const checks = [];
  for (const result of results) {
    const steadyLongest = result.phases.steady.longTaskMs.max ?? 0;
    checks.push({ scenario: result.scenario, check: "steady long task ≤ 100 ms", value: steadyLongest, pass: steadyLongest <= BUDGETS.steadyLongTaskMaxMs });
    for (const phase of ["steady", "hover"]) {
      const p95 = result.phases[phase].frameIntervalMs.p95 ?? Infinity;
      checks.push({ scenario: result.scenario, check: `${phase} frame interval p95 ≤ 33 ms`, value: p95, pass: p95 <= BUDGETS.frameIntervalP95Ms });
      if (baseline && result !== baseline && result.scenario !== "all") {
        const added = p95 - (baseline.phases[phase].frameIntervalMs.p95 ?? 0);
        checks.push({ scenario: result.scenario, check: `${phase} p95 added over baseline ≤ 8 ms`, value: round(added), pass: added <= BUDGETS.perIndicatorAddedP95Ms });
      }
    }
    if (FULL_GATE_SCENARIOS.includes(result.scenario)) {
      for (const phase of ["pan", "history"]) {
        const p95 = result.phases[phase]?.frameIntervalMs.p95 ?? Infinity;
        checks.push({ scenario: result.scenario, check: `${phase} frame interval p95 ≤ 33 ms`, value: p95, pass: p95 <= BUDGETS.frameIntervalP95Ms });
      }
      const switches = result.timeframeSwitches ?? [];
      const worst = switches.length === 0 ? Infinity : Math.max(...switches.map((entry) => entry.frameIntervalMs.p95 ?? Infinity));
      checks.push({ scenario: result.scenario, check: "every timeframe switch frame interval p95 ≤ 33 ms", value: worst, pass: worst <= BUDGETS.frameIntervalP95Ms });
    }
    checks.push({ scenario: result.scenario, check: "no page errors", value: result.pageErrors.length, pass: result.pageErrors.length === 0 });
  }
  return { budgets: BUDGETS, checks, pass: checks.every((check) => check.pass) };
}

async function run({ chromePath, scenarios = Object.keys(SCENARIOS), rows = 400, bars = 10_080, phases = { loadSeconds: 20, steadySeconds: 20, hoverSeconds: 10, panSettleSeconds: 3, historySeconds: 20, timeframeSeconds: 3 }, distDir = DIST, profileScenarios = ["all"], profilePhase = "hover", profileOut = null, liveBars = true, frozen = false, captureOut = null, historyRoutes = true, historyLatencyMs = 50 }) {
  if (!fs.existsSync(chromePath)) throw new Error("indicator-density: Chrome path does not exist");
  if (!fs.existsSync(path.join(distDir, "index.html"))) throw new Error("indicator-density: build the web app first (npm run build)");
  const unknown = scenarios.filter((name) => !Object.hasOwn(SCENARIOS, name));
  if (unknown.length > 0) throw new Error(`indicator-density: unknown scenarios ${unknown.join(", ")}`);
  const history = densityHistory({ nowMs: frozen ? Math.floor(Date.now() / 86_400_000) * 86_400_000 : Date.now(), bars, rows });
  const sample = liveColumnFrame({ history, ts: history.lastFineTs + 1_000, seq: history.fineSeq + 1, rows, random: seeded(1) });
  const barSample = liveBarFrame({ history, previous: null, nowMs: Date.now(), random: seeded(1) }).frames;
  preflight([{ type: "snapshot", ...history.identity, bars: history.bars, trades: [], markers: [] }, ...history.liquidityFrames, sample, ...barSample]);
  const results = [];
  for (const name of scenarios) {
    results.push(await runScenario({ chromePath, name, favorites: SCENARIOS[name], history, phases, profile: profileScenarios.includes(name), profilePhase, profileOut, distDir: path.resolve(distDir), liveBars, frozen, captureOut, historyRoutes: historyRoutes && !frozen, historyLatencyMs }));
  }
  if (frozen) return { generatedAt: new Date().toISOString(), frozen: true, nowMs: history.nowMs, rows, bars, results, pass: results.every((result) => result.pageErrors.length === 0) };
  return { generatedAt: new Date().toISOString(), rows, bars, liveBars, liquidityFrames: history.liquidityFrames.length, phases, results, verdict: verdict(results) };
}

if (require.main === module) {
  const [chromePath, output, only] = process.argv.slice(2);
  const profileScenarios = process.env.DENSITY_PROFILE_SCENARIOS ? process.env.DENSITY_PROFILE_SCENARIOS.split(",") : undefined;
  run({ chromePath, distDir: process.env.DENSITY_DIST ?? DIST, profilePhase: process.env.DENSITY_PROFILE_PHASE ?? "hover", profileOut: process.env.DENSITY_PROFILE_OUT ?? null, liveBars: process.env.DENSITY_LIVE_BARS !== "0", ...(process.env.DENSITY_ROWS ? { rows: Number(process.env.DENSITY_ROWS) } : {}), frozen: process.env.DENSITY_FROZEN === "1", historyRoutes: process.env.DENSITY_HISTORY !== "0", ...(process.env.DENSITY_HISTORY_LATENCY_MS ? { historyLatencyMs: Number(process.env.DENSITY_HISTORY_LATENCY_MS) } : {}), captureOut: process.env.DENSITY_CAPTURE_DIR ?? null, ...(profileScenarios ? { profileScenarios } : {}), ...(only ? { scenarios: only.split(",") } : {}) }).then((report) => {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (output) fs.writeFileSync(output, text, { flag: "wx" });
    else process.stdout.write(text);
    process.exitCode = (report.verdict?.pass ?? report.pass) ? 0 : 1;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { run, verdict, quantiles, scenarioReadinessIssues, sourceResolver, SCENARIOS, BUDGETS };
