"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHistoricalWallIndexWriter } = require("../../../src/indicators/l2-memory/historical-wall-index-writer");

async function main() {
  const configPath = path.resolve(process.argv[2]);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const writer = createHistoricalWallIndexWriter({ ...config, directory: path.join(path.dirname(configPath), "index") });
  let pending = Buffer.alloc(0), rows = 0, peakRss = 0;
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > 8 * 1024 * 1024) throw new Error("wall-index: input frame exceeds admission");
      const batch = JSON.parse(pending.subarray(0, newline).toString("utf8"));
      writer.consume(batch); rows += batch.length;
      pending = pending.subarray(newline + 1);
      if (rows % 10000 < batch.length) {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        const file = path.join(path.dirname(configPath), "progress.json");
        fs.writeFileSync(file + ".tmp", JSON.stringify({ rows, peakRss }));
        fs.renameSync(file + ".tmp", file);
      }
    }
    if (pending.length > 8 * 1024 * 1024) throw new Error("wall-index: input buffer exceeds admission");
  }
  if (pending.length) throw new Error("wall-index: unterminated input");
  const result = writer.finish();
  fs.writeFileSync(path.join(path.dirname(configPath), "index-proof.json"), JSON.stringify({ ...result, peakRss }), { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ rows, samples: result.manifest.samples, manifestSha256: result.manifestSha256 }) + "\n");
}

main().catch((error) => { process.stderr.write(String(error.stack ?? error) + "\n"); process.exitCode = 1; });
