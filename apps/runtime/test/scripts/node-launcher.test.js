const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { launch, resolvePinnedNode } = require("../../../../scripts/node-launcher.cjs");

const LAUNCHER = path.resolve(__dirname, "..", "..", "..", "..", "scripts", "node-launcher.cjs");

function repoRoot({ version = "24.21.0", envLines = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-launcher-"));
  fs.writeFileSync(path.join(root, ".nvmrc"), `${version}\n`);
  if (envLines.length > 0) fs.writeFileSync(path.join(root, ".env"), `${envLines.join("\n")}\n`);
  return root;
}

function fakeStat(files, dirs) {
  return (candidate) => {
    if (dirs.has(candidate)) return { isDirectory: () => true, isFile: () => false };
    if (files.has(candidate)) return { isDirectory: () => false, isFile: () => true };
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  };
}

function fakeProcess() {
  const emitter = new EventEmitter();
  emitter.exitCode = undefined;
  return emitter;
}

function fakeChild() {
  const child = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe("resolvePinnedNode", () => {
  let root;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  test("uses the running Node when it already is the pinned version", () => {
    root = repoRoot();
    const probe = jest.fn();
    expect(resolvePinnedNode({ root, currentVersion: "24.21.0", currentExecutable: "/current/node", probe }))
      .toMatchObject({ executable: "/current/node", source: "current" });
    expect(probe).not.toHaveBeenCalled();
  });

  test("on the wrong Node, picks TT_NODE_BIN from .env when that folder holds the pinned version", () => {
    root = repoRoot({ envLines: ["TT_NODE_BIN=C:\\tmp\\node-v24.21.0-win-x64", "TT_QUERY_S3_SECRET_ACCESS_KEY=not-read"] });
    const dir = "C:\\tmp\\node-v24.21.0-win-x64";
    const exe = path.join(dir, "node.exe");
    const pinned = resolvePinnedNode({
      root, env: {}, platform: "win32", homedir: "C:\\Users\\dev", currentVersion: "25.2.1",
      statImpl: fakeStat(new Set([exe]), new Set([dir])),
      probe: (candidate) => (candidate === exe ? "24.21.0" : null),
    });
    expect(pinned).toMatchObject({ executable: exe, source: "TT_NODE_BIN", version: "24.21.0" });
  });

  test("skips a TT_NODE_BIN of another version and falls through to nvm", () => {
    root = repoRoot();
    const wrong = "/opt/node-25/bin/node";
    const nvm = path.join("/home/dev", ".nvm", "versions", "node", "v24.21.0");
    const nvmExe = path.join(nvm, "bin", "node");
    const pinned = resolvePinnedNode({
      root, env: { TT_NODE_BIN: wrong }, platform: "linux", homedir: "/home/dev", currentVersion: "25.2.1",
      statImpl: fakeStat(new Set([wrong, nvmExe]), new Set([nvm])),
      probe: (candidate) => (candidate === wrong ? "25.2.1" : candidate === nvmExe ? "24.21.0" : null),
    });
    expect(pinned).toMatchObject({ executable: nvmExe, source: "nvm" });
    expect(pinned.tried).toEqual([`TT_NODE_BIN: ${wrong} is Node 25.2.1`]);
  });

  test("reports every place it looked when no pinned Node exists", () => {
    root = repoRoot();
    const pinned = resolvePinnedNode({
      root, env: {}, platform: "linux", homedir: "/home/dev", currentVersion: "25.2.1",
      statImpl: fakeStat(new Set(), new Set()), probe: () => null,
    });
    expect(pinned.executable).toBeNull();
    expect(pinned.tried.map((line) => line.split(":")[0])).toEqual(["nvm", "fnm", "volta"]);
  });
});

describe("launch", () => {
  test("refuses with instructions and never spawns when no pinned Node is found", () => {
    const processImpl = fakeProcess();
    const writes = [];
    const spawnImpl = jest.fn();
    launch(["script.js"], {
      resolve: () => ({ executable: null, version: "24.21.0", currentVersion: "25.2.1", tried: ["nvm: /x not found"] }),
      spawnImpl, processImpl, stderr: { write: (text) => writes.push(text) },
    });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(processImpl.exitCode).toBe(1);
    expect(writes.join("")).toMatch(/needs Node 24\.21\.0; this shell runs Node 25\.2\.1[\s\S]*tried nvm: \/x not found[\s\S]*TT_NODE_BIN/);
  });

  test("runs the arguments on the pinned Node, forwards a POSIX stop signal once and returns the child's exit code", () => {
    const processImpl = fakeProcess();
    const child = fakeChild();
    const spawnImpl = jest.fn(() => child);
    launch(["--watch", "scripts/serve/run-ws-server.js", "8001"], {
      resolve: () => ({ executable: "/pinned/node", version: "24.21.0", tried: [] }),
      spawnImpl, processImpl, platform: "linux",
    });
    expect(spawnImpl).toHaveBeenCalledWith("/pinned/node", ["--watch", "scripts/serve/run-ws-server.js", "8001"], { stdio: "inherit" });
    processImpl.emit("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", 3, null);
    expect(processImpl.exitCode).toBe(3);
    expect(processImpl.listenerCount("SIGINT")).toBe(0);
    expect(processImpl.listenerCount("SIGTERM")).toBe(0);
  });

  test("on Windows it never kills the child on Ctrl-C, which would skip the graceful drain; the child gets Ctrl-C from the console", () => {
    const processImpl = fakeProcess();
    const child = fakeChild();
    launch(["script.js"], {
      resolve: () => ({ executable: "C:\\node\\node.exe", version: "24.21.0", tried: [] }),
      spawnImpl: () => child, processImpl, platform: "win32",
    });
    processImpl.emit("SIGINT");
    processImpl.emit("SIGBREAK");
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("exit", 0, null);
    expect(processImpl.exitCode).toBe(0);
    expect(processImpl.listenerCount("SIGINT")).toBe(0);
  });

  test("end to end: the real launcher runs a script and passes its exit code through", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-launcher-e2e-"));
    try {
      const script = path.join(root, "exit7.js");
      fs.writeFileSync(script, "process.exitCode = 7;\n");
      const result = spawnSync(process.execPath, [LAUNCHER, script], { encoding: "utf8", timeout: 20_000 });
      expect(result.status).toBe(7);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
