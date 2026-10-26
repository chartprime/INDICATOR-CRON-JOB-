#!/usr/bin/env node
"use strict";

const { createContractService } = require("../../src/conversion/contract-service");

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const service = createContractService();

let buffer = Buffer.alloc(0);
let expected = null;

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return { body, header, bytes: Buffer.concat([header, body]) };
}

function fatal(message) {
  try {
    process.stdout.write(frame({ fatal: String(message).slice(0, 4000) }).bytes);
  } catch { void 0; }
  process.stderr.write(`contract-worker: ${message}\n`);
  process.exit(1);
}

function writeResponse(response) {
  const framed = frame(response);
  if (framed.body.length > MAX_FRAME_BYTES) {
    fatal(`response frame ${framed.body.length} exceeds ${MAX_FRAME_BYTES}`);
  }
  process.stdout.write(framed.bytes);
}

function drain() {
  for (;;) {
    if (expected === null) {
      if (buffer.length < 4) return;
      expected = buffer.readUInt32BE(0);
      buffer = buffer.subarray(4);
      if (expected > MAX_FRAME_BYTES) fatal(`request frame ${expected} exceeds ${MAX_FRAME_BYTES}`);
    }
    if (buffer.length < expected) return;
    const body = buffer.subarray(0, expected);
    buffer = buffer.subarray(expected);
    expected = null;

    let request;
    try {
      request = JSON.parse(body.toString("utf8"));
    } catch {
      return fatal("request body was not valid JSON");
    }
    let response;
    try {
      response = service.handle(request);
    } catch (error) {
      return fatal(`batch failed: ${error && error.message ? error.message : String(error)}`);
    }
    writeResponse(response);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
process.stdin.on("end", () => {
  if (buffer.length > 0 || expected !== null) fatal("stdin ended mid-frame");
  process.exit(0);
});
process.stdin.on("error", (error) => fatal(`stdin error: ${error.message}`));
process.stdout.on("error", () => process.exit(1));
