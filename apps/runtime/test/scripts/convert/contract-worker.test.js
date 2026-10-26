"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const WORKER = path.join(__dirname, "..", "..", "..", "scripts", "convert", "contract-worker.js");

const T = "1788807187569123456";
const aapl = { venue: "XNAS", market: "EQUITY", symbol: "AAPL", currency: "USD", sizeUnit: "SHARE", contract: null };
const request = {
  batchId: "b1", provider: "DATABENTO", family: "mbp",
  rows: [{ row: { instrument_id: "38", publisher_id: "1", ts_event: T, ts_recv: "1788807187569123500", sequence: "42", action: "T", side: "B", price: "195123456789", size: "10", flags: "0", bid_px_00: "195120000000", bid_sz_00: "5", ask_px_00: "195130000000", ask_sz_00: "7" }, position: 0 }],
  context: {
    mappings: [{ provider: "DATABENTO", dataset: "XNAS.ITCH", sourceSymbol: "38", fromNs: "0", toNs: "18446744073709551614", instrument: aapl, mappingVersion: "fixture/1", reference: "fixture://identity" }],
    dataset: "XNAS.ITCH", sourceSymbol: "38", population: "XNAS.ITCH:mbp-1", datasetVersion: "v1", streamId: "stream/1", schema: "mbp-1", ingestNs: T, lineage: { object: "s3://raw/x.dbn.zst", sha256: "a".repeat(64) },
  },
};

function frameOf(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function parseFrames(buf) {
  const out = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32BE(off);
    off += 4;
    if (off + len > buf.length) break;
    out.push(JSON.parse(buf.subarray(off, off + len).toString("utf8")));
    off += len;
  }
  return out;
}

function run(stdinBuf) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
    child.stdin.end(stdinBuf);
  });
}

describe("contract-worker (framed stdio)", () => {
  test("round-trips a framed batch and exits 0", async () => {
    const r = await run(frameOf(request));
    expect(r.code).toBe(0);
    const frames = parseFrames(r.stdout);
    expect(frames).toHaveLength(1);
    expect(frames[0].batchId).toBe("b1");
    expect(frames[0].results[0].ok).toBe(true);
    expect(frames[0].results[0].records.map((x) => x.family)).toEqual(["trade", "quote"]);
  });

  test("processes two frames on one stdin in order", async () => {
    const r = await run(Buffer.concat([frameOf(request), frameOf({ ...request, batchId: "b2" })]));
    expect(r.code).toBe(0);
    const frames = parseFrames(r.stdout);
    expect(frames.map((f) => f.batchId)).toEqual(["b1", "b2"]);
  });

  test("an oversized request-frame header is fatal", async () => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(32 * 1024 * 1024, 0);
    const r = await run(header);
    expect(r.code).toBe(1);
    const frames = parseFrames(r.stdout);
    expect(frames[0].fatal).toMatch(/exceeds/);
  });

  test("stdin ending mid-frame is fatal", async () => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(100, 0);
    const r = await run(Buffer.concat([header, Buffer.from("short")]));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/mid-frame/);
  });

  test("a malformed request body is fatal, not a silent skip", async () => {
    const body = Buffer.from("{not json", "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length, 0);
    const r = await run(Buffer.concat([header, body]));
    expect(r.code).toBe(1);
    expect(parseFrames(r.stdout)[0].fatal).toMatch(/JSON/);
  });
});
