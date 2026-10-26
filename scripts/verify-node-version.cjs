"use strict";

const REQUIRED = "24.21.0";

if (process.versions.node !== REQUIRED) {
  console.error(`terminal-l1-l2 requires Node ${REQUIRED}; found ${process.versions.node}. Select the version in .nvmrc before running checks.`);
  process.exitCode = 1;
}
