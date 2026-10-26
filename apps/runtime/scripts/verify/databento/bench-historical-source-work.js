"use strict";

const fs = require("node:fs");
const readline = require("node:readline");
const crypto = require("node:crypto");
const { createProducer } = require("./derive-historical-cme-core");

async function measure(configPath, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000
      || fs.statSync(configPath).size > 65_536) throw new Error("source-work: admission failed");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const producer = createProducer(config);
  const checksum = crypto.createHash("sha256");
  const families = {};
  let rows = 0;
  let key = null;
  const started = performance.now();
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (rows >= count || Buffer.byteLength(line) > 16_384) throw new Error("source-work: excess input");
    const row = JSON.parse(line);
    key = [row.event_ns, row.source_rank, row.stable_position, row.ordinal];
    for (const value of producer.push(row)) {
      families[value.family] = (families[value.family] ?? 0) + 1;
      checksum.update(JSON.stringify(value) + "\n");
    }
    rows += 1;
  }
  if (rows !== count) throw new Error("source-work: missing input");
  return { scope: "trusted-seed source-prefix work only; no checkpoint restore, EOF seal or arbitrary seek proof",
    rows, throughKey: key, families, outputSha256: checksum.digest("hex"), summary: producer.summary(),
    milliseconds: Math.round(performance.now() - started), maxRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) };
}

if (require.main === module) {
  measure(process.argv[2], Number(process.argv[3])).then((value) => {
    process.stdout.write(JSON.stringify(value) + "\n");
  }).catch((error) => {
    process.stdin.destroy();
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { measure };
