const fs = require("node:fs");

const RETRY_ATTEMPTS = 8;
const RETRY_SLEEP_MS = 15;
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Test-only cleanup. On Windows a SQLite file's OS handle is released
// asynchronously after the connection closes, and a background scanner can hold
// it briefly, so an immediate rmSync intermittently throws EPERM. That failure
// is never about the assertion under test -- the file is a temp file the OS
// reclaims regardless -- but it failed the whole suite. See L1L2-V2-016.
function safeRm(target, options = { force: true }) {
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    try {
      fs.rmSync(target, options);
      return true;
    } catch (error) {
      if (!RETRYABLE.has(error?.code)) throw error;
      sleepSync(RETRY_SLEEP_MS);
    }
  }
  return false;
}

module.exports = { safeRm };
