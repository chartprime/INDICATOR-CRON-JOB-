'use strict';
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(process.argv[2]);
const req = createRequire(path.join(root, 'package.json'));
const DB = req('better-sqlite3');
const db = new DB(':memory:');
try {
  db.exec('CREATE TABLE proof (id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO proof VALUES (?)').run(1);
  assert.throws(() => db.transaction(() => {
    db.prepare('INSERT INTO proof VALUES (?)').run(2);
    db.prepare('INSERT INTO proof VALUES (?)').run(1);
  })());
  assert.equal(db.prepare('SELECT count(*) AS n FROM proof').get().n, 1);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  const { execFileSync } = require('node:child_process');
  for (const file of ['run-collector.js', 'run-dxfeed-collector.js', 'run-with-dxfeed-token.js']) {
    const p = path.join(root, 'apps/runtime/scripts/collect', file);
    assert(fs.statSync(p).isFile());
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
  }
} finally { db.close(); }
console.log('CANDIDATE_RELEASE_PASS');
