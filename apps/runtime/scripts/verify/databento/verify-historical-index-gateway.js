"use strict";

const http = require("node:http");
const { randomBytes, createHash } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { createArchiveAuth } = require("../../../src/server/archive-auth");
const { createHistoricalL2Route, CONTRACT_VERSION, PROFILES } = require("../../../src/server/historical-l2-route");

async function main() {
  const viewer = randomBytes(24).toString("hex");
  const route = createHistoricalL2Route({ serviceUrl: "http://127.0.0.1:8004/query",
    serviceSecret: process.env.TT_QUERY_SERVICE_SECRET,
    auth: createArchiveAuth({ clientTokens: `qualification:${viewer}` }), log: () => {} });
  const server = http.createServer((req, res) => { if (!route.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/archive/l2`;
  async function send(request, authenticated = true) {
    return fetch(url, { method: "POST", body: JSON.stringify({ contractVersion: CONTRACT_VERSION, ...request }),
      headers: authenticated ? { authorization: `Bearer ${viewer}` } : {}, signal: AbortSignal.timeout(120000) });
  }
  try {
    if ((await send({ operation: "catalog" }, false)).status !== 401) throw new Error("Unauthenticated request accepted");
    const discovery = await send({ operation: "catalog" });
    if (discovery.status !== 200) throw new Error(`Catalog refused: ${discovery.status}`);
    const catalog = await discovery.json();
    if (catalog.indexes.length !== 8) throw new Error("Four wall and print indexes required");
    const captures = [], metrics = [];
    for (const instrumentId of PROFILES) {
      const date = JSON.parse(instrumentId)[2] === "AAPL" ? "2026-08-03" : "2026-08-05";
      const start = BigInt(Date.parse(`${date}T14:20:00Z`)) * 1000000n;
      const end = start + 15n * 60n * 1000000000n;
      for (const family of ["states", "walls", "prints"]) {
        const query = { snapshotToken: catalog.snapshotToken, instrumentId, date, family,
          from: String(start + 1n), to: String(end + 1n), asOfKey: [String(end), ...Array(3).fill("18446744073709551615")], limit: 10000 };
        const pages = [], timings = [], begun = performance.now();
        let cursor = null;
        do {
          const at = performance.now(), response = await send({ ...query, operation: "page", cursor });
          if (response.status !== 200) throw new Error(`${family} refused: ${response.status}: ${await response.text()}`);
          const page = await response.json();
          timings.push(performance.now() - at);
          cursor = page.nextCursor;
          pages.push({ ...page, snapshotToken: "a".repeat(32) });
          if (pages.length > 128) throw new Error("Page budget exceeded");
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } while (cursor !== null);
        const warmAt = performance.now(), warm = await send({ ...query, operation: "page" });
        if (warm.status !== 200) throw new Error("Warm read failed");
        const warmPage = await warm.json();
        if (JSON.stringify(warmPage.rows) !== JSON.stringify(pages[0].rows)) throw new Error("Warm data differs");
        metrics.push({ instrumentId, family, rows: pages.reduce((n, page) => n + page.rows.length, 0),
          pages: pages.length, totalMs: performance.now() - begun, pageMs: timings, warmFirstPageMs: performance.now() - warmAt,
          requestPacingMs: 1000, bytes: pages.reduce((n, page) => n + Buffer.byteLength(JSON.stringify(page)), 0),
          rowsSha256: createHash("sha256").update(JSON.stringify(pages.flatMap((page) => page.rows))).digest("hex") });
        captures.push({ query: { ...query, snapshotToken: "a".repeat(32) }, pages });
        console.log(JSON.stringify(metrics.at(-1)));
      }
    }
    writeFileSync(process.argv[2], JSON.stringify({ catalog: { ...catalog, snapshotToken: "a".repeat(32) }, captures, metrics }), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ status: "PASS", cases: metrics.length, releaseId: catalog.releaseId }));
  } finally {
    route.dispose(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
