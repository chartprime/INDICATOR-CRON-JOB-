const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");
// Hold a real SQLite write lock after reporting, until the thread is terminated.
const db = new Database(workerData.dbPath);
db.exec("BEGIN EXCLUSIVE; INSERT INTO evidence VALUES (1)");
parentPort.postMessage({ ok: true, result: "delivered before exit" });
setInterval(() => {}, 1000);
