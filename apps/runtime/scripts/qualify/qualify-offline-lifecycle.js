const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");
const { safeRm } = require("../../test/helpers/temp-files");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`offline qualification timed out: ${label}`);
    await pause(25);
  }
}

async function processObservation(dir, watch) {
  const revisionPath = path.join(dir, watch ? "watch-revision.cjs" : "stable-revision.cjs");
  fs.writeFileSync(revisionPath, "module.exports = 1;\n");
  const fixture = path.resolve(__dirname, "../../test/fixtures/offline-serving-process.js");
  const child = spawn(process.execPath, [...(watch ? ["--watch"] : []), fixture], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, W5_FIXTURE_MODE: watch ? "dev" : "start", W5_FIXTURE_DIR: dir, W5_FIXTURE_REVISION_PATH: revisionPath },
  });
  const records = [];
  let text = "";
  let diagnostic = "";
  child.stdout.on("data", (chunk) => {
    text += chunk.toString();
    const lines = text.split(/\r?\n/);
    text = lines.pop().slice(-65536);
    for (const line of lines) {
      const at = line.indexOf("W5_READY ");
      if (at >= 0) records.push(JSON.parse(line.slice(at + 9)));
    }
  });
  child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-4096); });
  let socket;
  let closed = false;
  const frames = [];
  try {
    await until(() => records.length === 1 || child.exitCode !== null, "first serving process");
    assert.equal(records.length, 1, diagnostic);
    const first = records[0];
    const health = await fetch(`http://127.0.0.1:${first.port}/health`).then((res) => res.json());
    assert.equal(health.ready, true);
    socket = new WebSocket(`ws://127.0.0.1:${first.port}/ws`);
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    socket.on("close", () => { closed = true; });
    socket.on("error", () => {});
    await until(() => frames.some((frame) => frame.type === "snapshot"), "initial snapshot");
    const editedAt = new Date().toISOString();
    fs.writeFileSync(revisionPath, "module.exports = 2;\n");
    if (watch) {
      await until(() => records.length >= 2, "watch child replacement");
      await until(() => closed, "old socket withdrawal");
      assert.notEqual(records[1].pid, first.pid);
      assert.notEqual(records[1].runId, first.runId);
      assert.equal(records[1].revision, 2);
      socket = new WebSocket(`ws://127.0.0.1:${records[1].port}/ws`);
      const replacementFrames = [];
      socket.on("message", (data) => replacementFrames.push(JSON.parse(data.toString())));
      socket.on("error", () => {});
      await until(() => replacementFrames.some((frame) => frame.type === "snapshot"), "replacement snapshot");
    } else {
      await pause(1000);
      assert.equal(records.length, 1);
      assert.equal(closed, false);
      assert.equal((await fetch(`http://127.0.0.1:${first.port}/health`).then((res) => res.json())).ready, true);
    }
    const closedOnEdit = closed;
    socket.close();
    await fetch(`http://127.0.0.1:${records.at(-1).controlPort}/stop`).then((res) => res.text());
    return { mode: watch ? "watch" : "stable", editedAt, records, oldSocketClosedOnEdit: closedOnEdit };
  } finally {
    socket?.terminate();
    for (const record of records) {
      try { await fetch(`http://127.0.0.1:${record.controlPort}/stop`, { signal: AbortSignal.timeout(500) }); } catch { void 0; }
    }
    if (child.exitCode === null) child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null, "fixture supervisor exit", 5000);
    for (const record of records) {
      try { process.kill(record.pid, 0); process.kill(record.pid); } catch { void 0; }
    }
  }
}

async function viteObservation(dir) {
  const { createServer, build, preview } = await import("vite");
  const root = path.join(dir, "vite-fixture");
  fs.mkdirSync(root);
  const html = '<html><body><script type="module" src="/main.js"></script></body></html>';
  fs.writeFileSync(path.join(root, "index.html"), html);
  fs.writeFileSync(path.join(root, "main.js"), 'console.log("version-one"); if (import.meta.hot) import.meta.hot.accept();');
  const server = await createServer({ configFile: false, root, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  let socket;
  let previewServer;
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    const messages = [];
    socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${server.config.webSocketToken}`, "vite-hmr");
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    socket.on("error", () => {});
    await until(() => messages.some((message) => message.type === "connected"), "Vite HMR connection");
    await fetch(`http://127.0.0.1:${port}/main.js`);
    fs.writeFileSync(path.join(root, "main.js"), 'console.log("version-two"); if (import.meta.hot) import.meta.hot.accept();');
    await until(() => messages.some((message) => message.type === "update"), "Vite module update");
    fs.writeFileSync(path.join(root, "index.html"), html + "\n<!-- edited -->");
    await until(() => messages.some((message) => message.type === "full-reload"), "Vite document reload");
    socket.close();
    await server.close();
    await build({ configFile: false, root, logLevel: "silent" });
    previewServer = await preview({ configFile: false, root, logLevel: "silent", preview: { host: "127.0.0.1", port: 0 } });
    const previewPort = previewServer.httpServer.address().port;
    const before = await fetch(`http://127.0.0.1:${previewPort}`).then((res) => res.text());
    fs.writeFileSync(path.join(root, "index.html"), "<html>source edited after build</html>");
    const after = await fetch(`http://127.0.0.1:${previewPort}`).then((res) => res.text());
    assert.equal(after, before);
    return { hmrModuleUpdate: true, documentFullReload: true, previewUnchangedBySourceEdit: true };
  } finally {
    socket?.terminate();
    await server.close();
    if (previewServer) await new Promise((resolve) => { previewServer.httpServer.closeAllConnections(); previewServer.httpServer.close(resolve); });
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-w5-lifecycle-"));
  try {
    const watch = await processObservation(dir, true);
    const stable = await processObservation(dir, false);
    const vite = await viteObservation(dir);
    const logFiles = fs.readdirSync(dir).filter((name) => name.endsWith(".log"));
    const logs = logFiles.map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
    assert.ok(logs.includes("lifecycle.stopped"));
    const evidence = { observedAt: new Date().toISOString(), upstream: "injected offline fixtures only", watch, stable, vite, durableLifecycleStop: true };
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("terminal-w5-lifecycle-"));
    assert.equal(safeRm(target, { recursive: true, force: true }), true);
  }
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { main };
