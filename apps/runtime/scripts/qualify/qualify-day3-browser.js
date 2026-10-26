#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { WebSocket, WebSocketServer } = require("ws");
const { quantiles } = require("./qualify-day3-pipeline");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const errors = [];
  let id = 0;
  socket.on("message", (wire) => {
    const message = JSON.parse(wire.toString());
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id); clearTimeout(job.timer);
    if (message.error) job.reject(new Error(JSON.stringify(message.error))); else job.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return { socket, errors, async send(method, params = {}) {
    await ready;
    return new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); reject(new Error(`CDP deadline: ${method}`)); }, 15_000);
      pending.set(next, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  } };
}

async function run({ chromePath, durationSeconds = 60, tradesPerPulse = 10, pulseMs = 20, selectionChangeAtSeconds = null }) {
  if (!fs.existsSync(chromePath) || !Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 600) throw new Error("invalid Chrome path or duration");
  if (!Number.isSafeInteger(tradesPerPulse) || tradesPerPulse < 1 || tradesPerPulse > 400 || !Number.isSafeInteger(pulseMs) || pulseMs < 5 || pulseMs > 1_000) {
    throw new Error("invalid trade rate: tradesPerPulse must be 1..400 and pulseMs 5..1000");
  }
  if (selectionChangeAtSeconds !== null && (!Number.isSafeInteger(selectionChangeAtSeconds) || selectionChangeAtSeconds < 1 || selectionChangeAtSeconds >= durationSeconds)) {
    throw new Error("invalid selectionChangeAtSeconds: must be a whole second inside the run");
  }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "w503-chrome-"));
  const dist = path.resolve(__dirname, "../../../web/dist");
  let chrome;
  let devtools;
  let timer;
  let sent = 0;
  let chromeStderr = "";
  let openTime = Math.floor(Date.now() / 60_000) * 60_000;
  let count = 0;
  let identity = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" };
  const timing = { navigatedAtMs: null, connectedAtMs: null, firstTradePublishedAtMs: null, selectionSentAtMs: null, selectionTradeIdFloor: null };
  let selectionTimer = null;
  const bar = (ts, n, closed) => ({ type: "bar", ...identity, ts_open: ts, interval_ms: 60_000,
    open: 100, high: 100, low: 100, close: 100, volume: n, buy_volume: n, trade_count: n, closed });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const target = pathname === "/" ? path.join(dist, "index.html") : path.resolve(dist, `.${pathname}`);
    if (!target.startsWith(`${dist}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); res.end(); return; }
    const extension = path.extname(target);
    res.setHeader("Content-Type", ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml" })[extension] ?? "application/octet-stream");
    fs.createReadStream(target).pipe(res);
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  const initializeSocket = (socket) => {
    const snapshot = { type: "snapshot", ...identity,
      bars: Array.from({ length: 100 }, (_, i) => bar(openTime - (100 - i) * 60_000, 1, true)), trades: [], markers: [] };
    socket.send(JSON.stringify({ type: "selection", ...identity }));
    socket.send(JSON.stringify(snapshot));
    socket.send(JSON.stringify({ type: "health", ...identity, recoveryState: "READY", stale: false }));
    socket.send(JSON.stringify({ type: "book", ...identity, status: "READY", bids: [{ price: 99, size: 3 }], asks: [{ price: 101, size: 2 }], lastUpdateId: 1, stale: false }));
  };
  wss.on("connection", (socket) => {
    if (timing.connectedAtMs === null) timing.connectedAtMs = Date.now();
    socket.on("message", (wire) => { if (JSON.parse(wire.toString()).type === "select") initializeSocket(socket); });
    initializeSocket(socket);
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--window-size=1600,1000", "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", (chunk) => { chromeStderr = `${chromeStderr}${chunk}`.slice(-16_384); });
    let spawnError;
    chrome.once("error", (error) => { spawnError = error; });
    const portFile = path.join(profileDir, "DevToolsActivePort");
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(portFile)) {
      if (spawnError) throw spawnError;
      if (Date.now() > deadline || chrome.exitCode !== null) throw new Error("headless Chrome did not start");
      await sleep(50);
    }
    const debugPort = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
    devtools = cdp(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
    await devtools.send("Page.enable"); await devtools.send("Runtime.enable"); await devtools.send("Performance.enable");
    const browserVersion = await devtools.send("Browser.getVersion");
    await devtools.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.__w503 = { latency: [], observed: 0, newest: 0, longTasks: [], heap: [], firstCommitAtMs: null, floor: null, firstAfterFloorAtMs: null };
      new PerformanceObserver((list) => { for (const e of list.getEntries()) if (window.__w503.longTasks.length < 10000) window.__w503.longTasks.push(e.duration); }).observe({type:'longtask',buffered:true});
      document.addEventListener('DOMContentLoaded', () => {
        new MutationObserver(() => {
          const s = window.__w503;
          const rows = [...document.querySelectorAll('.tape-row[data-trade-id]')].map((row) => ({id:Number(row.dataset.tradeId),ts:Number(row.dataset.eventTime)})).filter((row) => row.id > s.newest).sort((a,b) => a.id-b.id);
          for (const row of rows) {
            s.newest = row.id; s.observed++; if (s.latency.length < 100000) s.latency.push(Date.now()-row.ts);
            if (s.firstCommitAtMs === null) s.firstCommitAtMs = Date.now();
            if (s.floor !== null && s.firstAfterFloorAtMs === null && row.id > s.floor) s.firstAfterFloorAtMs = Date.now();
          }
        }).observe(document.body, {childList:true,subtree:true,attributes:true,attributeFilter:['data-trade-id']});
      });` });
    timing.navigatedAtMs = Date.now();
    await devtools.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
    const connectDeadline = Date.now() + 15_000;
    while (wss.clients.size === 0) { if (Date.now() > connectDeadline) throw new Error("web worker did not connect"); await sleep(50); }
    await sleep(500);
    timer = setInterval(() => {
      const ts = Date.now();
      const nextOpen = Math.floor(ts / 60_000) * 60_000;
      const publish = (frame) => { for (const socket of wss.clients) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); };
      if (timing.firstTradePublishedAtMs === null) timing.firstTradePublishedAtMs = ts;
      if (nextOpen !== openTime) { publish(bar(openTime, count, true)); openTime = nextOpen; count = 0; }
      for (let i = 0; i < tradesPerPulse; i++) {
        sent++; count++;
        publish({ type: "trade", ...identity, trade_id: String(sent), ts_exchange: ts, price: 100, size: 1, side: "buy" });
      }
      publish(bar(openTime, count, false));
    }, pulseMs);
    if (selectionChangeAtSeconds !== null) {
      selectionTimer = setTimeout(() => {
        identity = { provider: "BINANCE", symbol: "ETH-USDT", marketKind: "SPOT" };
        timing.selectionTradeIdFloor = sent;
        timing.selectionSentAtMs = Date.now();
        // Exercise the real Terminal -> React -> worker selection path. The
        // mock server answers the resulting select message in its ordinary
        // socket handler, so a server-pushed selection cannot accidentally
        // masquerade as client selection latency.
        devtools.send("Runtime.evaluate", { expression: `(async () => {
          window.__w503.floor = ${sent};
          const trigger = document.querySelector('[aria-label="Select instrument"]');
          if (!(trigger instanceof HTMLElement)) throw new Error('instrument trigger unavailable');
          trigger.click();
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const option = [...document.querySelectorAll('[role="option"]')].find((node) => node.textContent?.trim() === 'ETH Spot');
          if (!(option instanceof HTMLElement)) throw new Error('ETH Spot option unavailable');
          option.click();
        })()`, awaitPromise: true }).then((result) => {
          if (result.exceptionDetails) devtools.errors.push(`selection interaction failed: ${result.exceptionDetails.text}`);
        }).catch((error) => { devtools.errors.push(`selection interaction failed: ${error.message}`); });
      }, selectionChangeAtSeconds * 1000);
    }
    const memory = [];
    for (let elapsed = 0; elapsed < durationSeconds; elapsed += 5) {
      await sleep(Math.min(5, durationSeconds - elapsed) * 1000);
      const metrics = await devtools.send("Performance.getMetrics");
      const values = Object.fromEntries(metrics.metrics.map((entry) => [entry.name, entry.value]));
      memory.push({ seconds: Math.min(elapsed + 5, durationSeconds), heapUsed: values.JSHeapUsedSize, nodes: values.Nodes, layoutCount: values.LayoutCount, taskDuration: values.TaskDuration });
    }
    clearInterval(timer); timer = null;
    clearTimeout(selectionTimer);
    await sleep(500);
    const observation = await devtools.send("Runtime.evaluate", { expression: "JSON.stringify({...window.__w503, tapeRows:document.querySelectorAll('.tape-row').length, canvases:document.querySelectorAll('canvas').length, selectionTraces:window.__ttSelectionTraces ?? [], performanceEntries:window.__ttPerformanceEntries ?? []})", returnByValue: true });
    const data = JSON.parse(observation.result.value);
    wss.removeAllListeners("connection");
    wss.on("connection", (socket) => socket.close());
    for (const socket of wss.clients) socket.close();
    await sleep(300);
    const withdrawal = await devtools.send("Runtime.evaluate", { expression: "document.querySelectorAll('.tape-row').length", returnByValue: true });
    return { generatedAt: new Date().toISOString(), durationSeconds, sent, observedTapeCommits: data.observed, newestCommittedId: data.newest,
      tapeRows: data.tapeRows, canvases: data.canvases, eventToTapeDomCommitMs: quantiles(data.latency), longTaskMs: quantiles(data.longTasks), memory,
      timing: { ...timing, firstCommitAtMs: data.firstCommitAtMs, firstAfterSelectionAtMs: data.firstAfterFloorAtMs },
      selectionTraces: data.selectionTraces,
      performanceEntries: data.performanceEntries,
      browserProduct: browserVersion.product,
      pageErrors: devtools.errors, tapeRowsAfterDisconnect: withdrawal.result.value,
      pass: data.newest === sent && data.tapeRows <= 100 && data.canvases > 0 && devtools.errors.length === 0 && withdrawal.result.value === 0 };
  } catch (error) {
    const diagnostics = [];
    if (chrome?.exitCode !== null && chrome?.exitCode !== undefined) diagnostics.push(`Chrome exit code: ${chrome.exitCode}`);
    if (chrome?.signalCode !== null && chrome?.signalCode !== undefined) diagnostics.push(`Chrome signal: ${chrome.signalCode}`);
    if (chromeStderr.trim()) diagnostics.push(`Chrome stderr tail:\n${chromeStderr.trim()}`);
    if (diagnostics.length > 0) error.message = `${error.message}\n${diagnostics.join("\n")}`;
    throw error;
  } finally {
    clearInterval(timer);
    clearTimeout(selectionTimer);
    if (devtools) { await devtools.send("Browser.close").catch(() => {}); devtools.socket.close(); }
    if (chrome) {
      const until = Date.now() + 5000;
      while (chrome.exitCode === null && chrome.signalCode === null && Date.now() < until) await sleep(50);
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill();
    }
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (path.dirname(path.resolve(profileDir)) === path.resolve(os.tmpdir()) && path.basename(profileDir).startsWith("w503-chrome-")) {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } else {
      console.error("unsafe fixture cleanup path; directory retained");
    }
  }
}
if (require.main === module) run({ chromePath: process.argv[2], durationSeconds: Number(process.argv[3] ?? 60) }).then((report) => {
  if (process.argv[4]) fs.writeFileSync(process.argv[4], `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  else console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
