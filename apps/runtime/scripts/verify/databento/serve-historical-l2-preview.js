"use strict";

const http = require("node:http");
const { createArchiveAuth } = require("../../../src/server/archive-auth");
const { createHistoricalL2Route } = require("../../../src/server/historical-l2-route");

const auth = createArchiveAuth();
if (auth.clientCount < 1 || !process.env.TT_QUERY_SERVICE_SECRET) throw new Error("Protected preview credentials required");
const route = createHistoricalL2Route({ auth, serviceUrl: "http://127.0.0.1:8004/query",
  serviceSecret: process.env.TT_QUERY_SERVICE_SECRET, log: () => {} });
const server = http.createServer((request, response) => {
  if (route.handle(request, response)) return;
  if (request.url === "/health" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"isolated-preview"}'); return;
  }
  if (!["/archive/query", "/archive/study"].includes(request.url) || request.method !== "POST") {
    response.writeHead(404); response.end(); return;
  }
  if (auth.identify(request.headers.authorization) === null) { response.writeHead(401); response.end(); request.resume(); return; }
  let bytes = 0;
  const upstream = http.request({ host: "10.88.0.1", port: 8001, path: request.url, method: "POST",
    headers: { authorization: request.headers.authorization, "content-type": "application/json" } }, (reply) => {
    response.writeHead(reply.statusCode, { "content-type": "application/json", "cache-control": "no-store" });
    reply.on("error", () => response.destroy()); reply.pipe(response);
  });
  upstream.setTimeout(120000, () => upstream.destroy());
  upstream.on("error", () => { if (!response.headersSent) { response.writeHead(502); response.end(); } else response.destroy(); });
  request.on("data", (chunk) => { bytes += chunk.length; if (bytes > 65536) { upstream.destroy(); response.destroy(); } });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
});
const listenHost = process.env.TT_L2_PREVIEW_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "10.88.0.1"].includes(listenHost)) throw new Error("Preview requires loopback or the existing private VPN interface");
server.listen(8005, listenHost, () => console.log(`Historical L2 isolated preview listening on ${listenHost}:8005`));
function stop() { route.dispose(); server.closeAllConnections(); server.close(() => process.exit(0)); }
process.once("SIGTERM", stop); process.once("SIGINT", stop);
