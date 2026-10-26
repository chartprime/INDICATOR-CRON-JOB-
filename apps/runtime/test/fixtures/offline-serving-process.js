// Used only by qualify-offline-lifecycle.js. All upstream I/O is injected.
const http = require("node:http");
const path = require("node:path");
const { createApp } = require("../../src/server/app");
const { start } = require("../../scripts/serve/run-ws-server");
const { createCliLogger } = require("../../src/platform/cli-logger");

class OfflineSocket {
  constructor() {
    this.readyState = 0;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); });
  }
  send(wire) {
    const request = JSON.parse(wire);
    if (request.id) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: request.id, result: null }) }));
  }
  close() { this.readyState = 3; this.onclose?.({}); }
}

async function main() {
  const revision = require(process.env.W5_FIXTURE_REVISION_PATH);
  const logDir = process.env.W5_FIXTURE_DIR;
  const logger = createCliLogger({ name: "offline-serving", logDir, stream: { write() {} } });
  let app;
  const service = start({
    argv: ["8001"], env: { npm_lifecycle_event: process.env.W5_FIXTURE_MODE }, logger,
    createAppImpl: (options) => {
      app = createApp({
        ...options, port: 0, dxfeedBrokerUrl: "", webSocketImpl: OfflineSocket,
        dbPath: path.join(logDir, "absent-binance.sqlite"), dxfeedDbPath: path.join(logDir, "absent-dxfeed.sqlite"), volumeProfileCachePath: ":memory:",
        fetchImpl: async (url) => new Response(JSON.stringify(String(url).includes("klines") ? [] : { lastUpdateId: 100, bids: [], asks: [] })),
      });
      return app;
    },
  });
  await service.ready;
  const control = http.createServer(async (_req, res) => {
    await service.shutdown("offline_fixture_stop");
    res.end("stopped");
    control.close();
  });
  await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
  // Node watch may signal the child; this fixture control listener is also owned.
  process.once("SIGTERM", () => control.close());
  process.once("SIGINT", () => control.close());
  process.stdout.write(`W5_READY ${JSON.stringify({ ...logger.identity, revision, port: app.httpServer.address().port, controlPort: control.address().port })}\n`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
