const fs = require("node:fs");
const path = require("node:path");
const { main, parseStackArgs, stackCommands, viteBinPath, restartDelay, RESTART_BASE_MS, RESTART_MAX_MS, STEADY_MS } = require("../../../scripts/serve/run-stack");

const RUNTIME_DIR = path.resolve(__dirname, "..", "..", "..");
const WEB_DIR = path.resolve(RUNTIME_DIR, "..", "web");

function noopLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), ok: jest.fn() };
}

function fakeChild(pid) {
  const listeners = { exit: [], error: [] };
  return {
    pid,
    kill: jest.fn(),
    on: jest.fn((event, cb) => {
      listeners[event]?.push(cb);
    }),
    emitExit: (code, signal = null) => listeners.exit.forEach((cb) => cb(code, signal)),
  };
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeoutImpl: jest.fn((cb, ms) => {
      const handle = { cb, ms, cleared: false };
      pending.push(handle);
      return handle;
    }),
    clearTimeoutImpl: jest.fn((handle) => {
      if (handle) handle.cleared = true;
    }),
    fire: () => {
      const due = pending.splice(0, pending.length).filter((handle) => !handle.cleared);
      for (const handle of due) handle.cb();
      return due.map((handle) => handle.ms);
    },
  };
}

function fakeProcess() {
  const handlers = {};
  return {
    execPath: "/usr/bin/node",
    exit: jest.fn(),
    on: jest.fn((event, cb) => {
      handlers[event] = cb;
    }),
    off: jest.fn((event) => {
      delete handlers[event];
    }),
    handlers,
  };
}

async function flushAsync(times = 4) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("parseStackArgs", () => {
  test("defaults to the day stack on the usual ports and accepts the few flags the trader needs", () => {
    expect(parseStackArgs([])).toEqual({ port: 8001, vitePort: 8000, symbol: "BTCUSDT", vite: true, collector: true, dxfeedEager: false });
    expect(parseStackArgs(["--no-vite", "--no-collector", "--dxfeed-eager", "--port=8002", "--vite-port=8010", "--symbol=ETHUSDT"])).toEqual({
      port: 8002, vitePort: 8010, symbol: "ETHUSDT", vite: false, collector: false, dxfeedEager: true,
    });
    expect(() => parseStackArgs(["--watch"])).toThrow(/unknown argument --watch/);
    expect(() => parseStackArgs(["--port=0"])).toThrow(/--port must be a port number/);
    expect(() => parseStackArgs(["--vite-port=70000"])).toThrow(/--vite-port must be a port number/);
    expect(() => parseStackArgs(["--symbol="])).toThrow(/--symbol must not be empty/);
  });
});

describe("stackCommands", () => {
  test("names the three processes with the working directories and arguments the README hands out, the runtime picking its own settings from the repo's .env instead of receiving the whole file", () => {
    const commands = stackCommands(parseStackArgs([]), { node: "node.exe", viteBin: "vite.js" });
    expect(commands).toEqual([
      { name: "runtime", cwd: RUNTIME_DIR, command: "node.exe", args: ["scripts/serve/run-ws-server.js", "8001", "BTCUSDT"] },
      { name: "collector", cwd: RUNTIME_DIR, command: "node.exe", args: ["scripts/collect/run-collector.js"] },
      { name: "vite", cwd: WEB_DIR, command: "node.exe", args: ["vite.js", "--port", "8000", "--strictPort"] },
    ]);
    expect(stackCommands(parseStackArgs(["--dxfeed-eager", "--no-collector", "--no-vite"]), { node: "node.exe" })).toEqual([
      { name: "runtime", cwd: RUNTIME_DIR, command: "node.exe", args: ["scripts/serve/run-ws-server.js", "8001", "BTCUSDT", "--dxfeed-eager"] },
    ]);
  });
});

describe("viteBinPath", () => {
  test("finds the installed vite's own bin file through its package manifest, not through an export map that does not list it", () => {
    // The first launch died on ERR_PACKAGE_PATH_NOT_EXPORTED: vite's exports do not cover ./bin/vite.js, so require.resolve cannot reach it.
    const bin = viteBinPath();
    expect(path.basename(bin)).toBe("vite.js");
    expect(fs.existsSync(bin)).toBe(true);
    expect(stackCommands(parseStackArgs([]))[2].args[0]).toBe(bin);
    expect(() => viteBinPath(path.parse(__dirname).root)).toThrow();
  });
});

describe("restartDelay", () => {
  test("doubles from five seconds to a minute while a process keeps dying, and starts over once it has stayed up ten minutes", () => {
    const entry = { backoffMs: RESTART_BASE_MS };
    expect([0, 1_000, 2_000, 3_000, 4_000].map((uptime) => restartDelay(entry, uptime))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
    expect(restartDelay(entry, 5_000)).toBe(RESTART_MAX_MS);
    expect(restartDelay(entry, STEADY_MS)).toBe(RESTART_BASE_MS);
    expect(restartDelay(entry, 0)).toBe(10_000);
  });
});

describe("main", () => {
  test("launches every process, relaunches the one that dies after its backoff, and tears all of them down on a signal", async () => {
    const children = [];
    const spawnImpl = jest.fn((command, args, options) => {
      const child = fakeChild(100 + children.length);
      children.push({ child, command, args, options });
      return child;
    });
    const timers = fakeTimers();
    const processImpl = fakeProcess();
    const logger = noopLogger();
    let clock = 1_000_000;
    const stack = await main({
      argv: [], env: { PATH: "x" }, spawnImpl, logger, now: () => clock, viteBin: "vite.js", processImpl,
      setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    expect(children.map((c) => [c.args.find((arg) => arg.endsWith(".js")), c.options.cwd, c.options.stdio])).toEqual([
      ["scripts/serve/run-ws-server.js", RUNTIME_DIR, "inherit"],
      ["scripts/collect/run-collector.js", RUNTIME_DIR, "inherit"],
      ["vite.js", WEB_DIR, "inherit"],
    ]);
    expect(stack.children().map((c) => c.pid)).toEqual([100, 101, 102]);
    // The collector dies after a minute: back in five seconds, on the same command.
    clock += 60_000;
    children[1].child.emitExit(1, null);
    expect(stack.children()[1].pid).toBeNull();
    expect(timers.fire()).toEqual([5_000]);
    expect(children).toHaveLength(4);
    expect(children[3].args).toEqual(children[1].args);
    expect(stack.children()[1].pid).toBe(103);
    // It dies again at once: ten seconds this time.
    clock += 1_000;
    children[3].child.emitExit(1, null);
    expect(timers.fire()).toEqual([10_000]);
    expect(children).toHaveLength(5);
    // A signal stops everything: every child is told, nothing is relaunched, and the process exits once they are gone.
    processImpl.handlers.SIGINT();
    for (const entry of [children[0], children[2], children[4]]) expect(entry.child.kill).toHaveBeenCalledWith("SIGINT");
    children[0].child.emitExit(null, "SIGINT");
    children[2].child.emitExit(null, "SIGINT");
    expect(processImpl.exit).not.toHaveBeenCalled();
    children[4].child.emitExit(null, "SIGINT");
    await stack.completion;
    expect(processImpl.exit).toHaveBeenCalledWith(130);
    expect(spawnImpl).toHaveBeenCalledTimes(5);
    expect(processImpl.off).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processImpl.off).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  test("a child that will not die is killed after the grace period and the stack still exits", async () => {
    const children = [];
    const spawnImpl = jest.fn(() => {
      const child = fakeChild(200 + children.length);
      children.push(child);
      return child;
    });
    const timers = fakeTimers();
    const processImpl = fakeProcess();
    const stack = await main({ argv: ["--no-vite", "--no-collector"], spawnImpl, logger: noopLogger(), viteBin: "vite.js", processImpl, setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl });
    expect(children).toHaveLength(1);
    processImpl.handlers.SIGTERM();
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(timers.fire()).toEqual([5_000]);
    expect(children[0].kill).toHaveBeenCalledWith("SIGKILL");
    await stack.completion;
    expect(processImpl.exit).toHaveBeenCalledWith(143);
  });

  test("a bad argument is refused before anything is launched", async () => {
    const spawnImpl = jest.fn();
    const processImpl = fakeProcess();
    const logger = noopLogger();
    await main({ argv: ["--watch"], spawnImpl, logger, processImpl });
    await flushAsync();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/unknown argument --watch/));
    expect(processImpl.exit).toHaveBeenCalledWith(1);
  });
});
