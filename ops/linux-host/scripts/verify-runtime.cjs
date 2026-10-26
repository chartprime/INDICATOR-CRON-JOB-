'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const release = process.argv[2];
assert.equal(process.argv.length, 3, 'Usage: verify-runtime.cjs <frozen-release>');
assert.equal(typeof release, 'string', 'A frozen release path is required');
const root = fs.realpathSync(release);
assert(fs.statSync(root).isDirectory(), 'Frozen release path must be a directory');
const requireRuntime = createRequire(path.join(root, 'package.json'));
const Database = requireRuntime('better-sqlite3');
if (typeof process.getuid === 'function') {
  assert.notEqual(process.getuid(), 0, 'Run as a service account');
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-runtime-verify-'));
const filename = path.join(dir, 'test.db');
let db;
try {
  db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO events VALUES (?, ?)');
  db.transaction(() => { for (let i = 0; i < 100; i++) insert.run(i, 'fixture'); })();
  assert.throws(() => db.transaction(() => { insert.run(101, 'rollback'); insert.run(0, 'duplicate'); })());
  db.close();
  db = new Database(filename);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 100);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  db.close();
  db = undefined;
} finally {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ result: 'PASS', node: process.version, sqliteModule: requireRuntime('better-sqlite3/package.json').version, checks: ['WAL write', 'transaction rollback', 'close/reopen persistence', 'integrity'], qualificationOnly: true }));
