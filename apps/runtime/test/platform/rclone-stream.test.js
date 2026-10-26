const { EventEmitter } = require("node:events");
const { Readable, Writable, PassThrough } = require("node:stream");
const { streamToRclone } = require("../../src/platform/rclone-stream");

function fixture({ failWrite = false, closeOnFinish = true } = {}) {
  const child = new EventEmitter();
  child.pid = 123;
  child.stderr = new PassThrough();
  let bytes = 0;
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    bytes += chunk.length;
    done(failWrite ? new Error("broken upload pipe") : null);
  } });
  child.kill = jest.fn(() => { setImmediate(() => child.emit("close", 1)); return true; });
  if (closeOnFinish) child.stdin.on("finish", () => setImmediate(() => child.emit("close", 0)));
  const spawnImpl = jest.fn(() => child);
  return { child, spawnImpl, bytes: () => bytes };
}

test("uses resolved executable and waits for both stream and child completion", async () => {
  const f = fixture({ closeOnFinish: false });
  let completed = false;
  const upload = streamToRclone(Readable.from(["abc", "def"]), "remote:fixture", { rcloneBin: "resolved/rclone", spawnImpl: f.spawnImpl })
    .then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.bytes()).toBe(6);
  expect(completed).toBe(false);
  expect(f.spawnImpl).toHaveBeenCalledWith("resolved/rclone", expect.any(Array), expect.objectContaining({ windowsHide: true }));
  f.child.emit("close", 0);
  await upload;
});

test("broken stdin fails the upload and reaps its child", async () => {
  const f = fixture({ failWrite: true });
  await expect(streamToRclone(Readable.from(["abc"]), "remote:fixture", { rcloneBin: "fixture", spawnImpl: f.spawnImpl })).rejects.toThrow("broken upload pipe");
  expect(f.child.kill).toHaveBeenCalled();
});

test("source failure destroys the pipe and reaps its child", async () => {
  const f = fixture();
  const source = new PassThrough();
  const upload = streamToRclone(source, "remote:fixture", { rcloneBin: "fixture", spawnImpl: f.spawnImpl });
  source.destroy(new Error("provider disconnected"));
  await expect(upload).rejects.toThrow("provider disconnected");
  expect(f.child.stdin.destroyed).toBe(true);
  expect(f.child.kill).toHaveBeenCalled();
});

test("a hung upload expires rather than holding a lane forever", async () => {
  const f = fixture({ closeOnFinish: false });
  await expect(streamToRclone(new PassThrough(), "remote:fixture", { rcloneBin: "fixture", spawnImpl: f.spawnImpl, timeoutMs: 10 })).rejects.toThrow("deadline exceeded");
  expect(f.child.kill).toHaveBeenCalled();
});

test("nonzero close fails with bounded diagnostics", async () => {
  const f = fixture({ closeOnFinish: false });
  const upload = streamToRclone(new PassThrough(), "remote:fixture", { rcloneBin: "fixture", spawnImpl: f.spawnImpl });
  f.child.stderr.write("x".repeat(100_000));
  f.child.emit("close", 7);
  await expect(upload).rejects.toThrow(/^rclone upload exited 7: x{500}$/);
});

test("a synchronous spawn failure also closes the provider stream", async () => {
  const source = new PassThrough();
  await expect(streamToRclone(source, "remote:fixture", { rcloneBin: "fixture", spawnImpl() { throw new Error("spawn failed"); } })).rejects.toThrow("spawn failed");
  expect(source.destroyed).toBe(true);
});

test("failure to confirm child exit is reported after bounded kill escalation", async () => {
  const f = fixture({ closeOnFinish: false });
  f.child.kill.mockImplementation(() => false);
  await expect(streamToRclone(new PassThrough(), "remote:fixture", {
    rcloneBin: "fixture", spawnImpl: f.spawnImpl, timeoutMs: 10, killGraceMs: 10,
  })).rejects.toThrow("child exit unconfirmed (PID 123)");
  expect(f.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
});

test("real local child consumes the whole source and exits before success", async () => {
  let child;
  const { spawn } = require("node:child_process");
  await streamToRclone(Readable.from([Buffer.alloc(100_000)]), "fixture", {
    rcloneBin: "fixture", spawnImpl(_bin, _args, options) {
      child = spawn(process.execPath, ["-e", "let n=0; process.stdin.on('data', c => n+=c.length); process.stdin.on('end', () => {process.exitCode = n===100000 ? 0 : 7;});"], options);
      return child;
    },
  });
  expect(child.exitCode).toBe(0);
});

test("real local child is reaped when a provider stream fails", async () => {
  let child;
  const { spawn } = require("node:child_process");
  const source = new PassThrough();
  const upload = streamToRclone(source, "fixture", {
    rcloneBin: "fixture", spawnImpl(_bin, _args, options) {
      child = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"], options);
      return child;
    },
  });
  source.destroy(new Error("provider stream lost"));
  await expect(upload).rejects.toThrow("provider stream lost");
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});
