const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLockOwner(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        Number.isSafeInteger(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.token === "string" &&
        parsed.token.length > 0
      ) {
        return { raw, pid: parsed.pid, token: parsed.token };
      }
    } catch {
      void 0;
    }
    const pid = Number.parseInt(raw, 10);
    return { raw, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, token: null };
  } catch {
    return null;
  }
}

const MAX_ACQUIRE_ATTEMPTS = 100;
// A collector creates the lock file and writes its owner in a second step, so
// a lock found empty and this young is being written, not abandoned.
const LOCK_WRITE_GRACE_MS = 1_000;
const LOCK_WRITE_POLL_MS = 25;

function lockAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function createStorageLock({ lockPath, maxAcquireAttempts = MAX_ACQUIRE_ATTEMPTS }) {
  if (typeof lockPath !== "string" || lockPath.length === 0) {
    throw new Error("storage-lock: lockPath must be a non-empty string");
  }
  if (!Number.isSafeInteger(maxAcquireAttempts) || maxAcquireAttempts <= 0) {
    throw new Error("storage-lock: maxAcquireAttempts must be a positive safe integer");
  }
  let held = false;
  let owner = null;

  function acquire() {
    if (held) {
      throw new Error("storage-lock: acquire() called while this lock instance already holds the database");
    }
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const candidate = Object.freeze({ pid: process.pid, token: randomUUID() });
    const serialized = JSON.stringify(candidate);

    for (let attempt = 0; attempt < maxAcquireAttempts; attempt += 1) {
      let fd;
      try {
        fd = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(fd, serialized, "utf8");
        fs.fsyncSync(fd);
        owner = { ...candidate, raw: serialized };
        held = true;
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }

      const existing = readLockOwner(lockPath);
      if (existing === null) continue;
      if (existing.raw === "") {
        const age = lockAgeMs(lockPath);
        if (age !== null && age < LOCK_WRITE_GRACE_MS) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WRITE_POLL_MS);
          continue;
        }
      }
      if (existing.pid !== null && isProcessAlive(existing.pid)) {
        throw new Error(`storage-lock: database already owned by a running collector (PID ${existing.pid})`);
      }

      const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
      try {
        fs.renameSync(lockPath, stalePath);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EEXIST") continue;
        throw error;
      }
      const renamedOwner = readLockOwner(stalePath);
      const stillStale = renamedOwner?.raw === existing.raw;
      if (stillStale) {
        try {
          fs.unlinkSync(stalePath);
        } catch {
          void 0;
        }
      } else {
        try {
          fs.renameSync(stalePath, lockPath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
    throw new Error(
      `storage-lock: gave up acquiring ${lockPath} after ${maxAcquireAttempts} attempts; the lock file exists but its ownership could not be resolved`,
    );
  }

  function release() {
    if (!held) return;
    held = false;
    const current = readLockOwner(lockPath);
    if (current?.raw !== owner?.raw) {
      owner = null;
      return;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      void 0;
    }
    owner = null;
  }

  return Object.freeze({ acquire, release });
}

module.exports = { createStorageLock, MAX_ACQUIRE_ATTEMPTS, LOCK_WRITE_GRACE_MS };
