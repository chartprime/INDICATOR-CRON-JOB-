const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream");

function streamToRclone(readable, destination, {
  rcloneBin,
  spawnImpl = spawn,
  timeoutMs = 15 * 60_000,
  killGraceMs = 5_000,
} = {}) {
  if (typeof rcloneBin !== "string" || !rcloneBin || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(killGraceMs) || killGraceMs <= 0) {
    readable.destroy();
    return Promise.reject(new Error("rclone upload requires an executable and positive deadlines"));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(rcloneBin, ["rcat", "--s3-no-check-bucket", destination], {
        windowsHide: true, stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (error) {
      readable.destroy(); reject(error); return;
    }
    let stderr = "";
    let failure = null;
    let streamDone = false;
    let childClosed = false;
    let settled = false;
    let forceTimer;
    let reapTimer;
    const deadline = setTimeout(() => fail(new Error("rclone upload deadline exceeded")), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(forceTimer); clearTimeout(reapTimer);
      if (error) reject(error); else resolve();
    }
    function fail(error) {
      if (failure || settled) return;
      failure = error;
      readable.destroy(); child.stdin.destroy();
      if (childClosed) { finish(failure); return; }
      try { child.kill(); } catch { void 0; }
      forceTimer = setTimeout(() => {
        if (childClosed) return;
        try { child.kill("SIGKILL"); } catch { void 0; }
        reapTimer = setTimeout(() => finish(Object.assign(
          new Error(`${failure.message}; upload child exit unconfirmed (PID ${child.pid ?? "unknown"})`),
          { code: "RCLONE_CHILD_EXIT_UNCONFIRMED" },
        )), killGraceMs);
      }, killGraceMs);
    }
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    child.on("error", fail);
    child.on("close", (code) => {
      childClosed = true;
      if (failure) { finish(failure); return; }
      if (code !== 0) { fail(new Error(`rclone upload exited ${code}: ${stderr.slice(-500)}`)); return; }
      if (streamDone) finish();
    });
    pipeline(readable, child.stdin, (error) => {
      streamDone = true;
      if (error) { fail(error); return; }
      if (childClosed) finish(failure);
    });
  });
}

module.exports = { streamToRclone };
