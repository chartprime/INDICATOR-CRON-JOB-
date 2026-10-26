const { execFileSync } = require("node:child_process");

function coverageFiles(rcloneBin, target) {
  let raw;
  try {
    raw = execFileSync(rcloneBin, ["lsf", "--recursive", "--files-only", target], {
      encoding: "utf-8", windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    if (error.status === 3) return new Set();
    throw new Error("Historical inventory unavailable; no upload plan can be certified", { cause: error });
  }
  return new Set(raw.split(/\r?\n/).filter(Boolean));
}

module.exports = { coverageFiles };
