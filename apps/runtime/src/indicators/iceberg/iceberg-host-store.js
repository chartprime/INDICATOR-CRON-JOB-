const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validWireIceberg } = require("./iceberg-history");
const { spanOf, mergeSpans, clipSpansBefore, subtractSpans } = require("./spans");

const SCHEMA_VERSION = "1";
const ICEBERG_RULES_VERSION = 1;
const DEFAULT_PAGE = 500;
const MAX_PAGE = 2_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const PAIR_KEY_PATTERN = /^[A-Za-z0-9:._/-]{1,96}$/;
const SETTLED = new Set(["filled", "pulled", "replaced", "interrupted", "ended"]);
const GAP_REASONS = new Set(["NO_CAPTURE", "BOOK_UNAVAILABLE"]);

function pairFilePath(dir, pairKey) {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("iceberg-host-store: dir is required");
  if (typeof pairKey !== "string" || !PAIR_KEY_PATTERN.test(pairKey)) throw new Error("iceberg-host-store: pairKey is not a valid pair key");
  return path.join(dir, `${pairKey.replace(/[^A-Za-z0-9._-]/g, "_")}.sqlite`);
}

function gapOf(entry) {
  if (!Array.isArray(entry) || entry.length !== 3 || spanOf(entry[0], entry[1]) === null || !GAP_REASONS.has(entry[2])) return null;
  return [entry[0], entry[1], entry[2]];
}

function openIcebergHostStore({ dir, pairKey, readonly = false, rulesVersion = ICEBERG_RULES_VERSION, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, Database = require("better-sqlite3") }) {
  const file = pairFilePath(dir, pairKey);
  if (!Number.isSafeInteger(rulesVersion) || rulesVersion < 1) throw new Error("iceberg-host-store: rulesVersion must be a positive safe integer");
  if (readonly && !fs.existsSync(file)) return null;
  if (!readonly) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(file, readonly ? { readonly: true, fileMustExist: true, timeout: busyTimeoutMs } : { timeout: busyTimeoutMs });
  if (!readonly) {
    db.pragma("journal_mode = DELETE");
    db.pragma("synchronous = FULL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS icebergs (
        id TEXT PRIMARY KEY,
        marked_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        body TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS icebergs_mark ON icebergs (marked_at, id);
    `);
  }
  const selectMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const metaOf = (key, fallback = null) => {
    const row = selectMeta.get(key);
    return row === undefined ? fallback : JSON.parse(row.value);
  };
  let putMeta = null;
  let upsert = null;
  let selectExisting = null;
  let deleteBefore = null;
  let wipe = null;
  if (!readonly) {
    putMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    upsert = db.prepare("INSERT INTO icebergs (id, marked_at, updated_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET marked_at = excluded.marked_at, updated_at = excluded.updated_at, body = excluded.body");
    selectExisting = db.prepare("SELECT updated_at FROM icebergs WHERE id = ?");
    deleteBefore = db.prepare("DELETE FROM icebergs WHERE marked_at < ?");
    wipe = db.transaction(() => {
      db.exec("DELETE FROM icebergs; DELETE FROM meta;");
      putMeta.run("schema", JSON.stringify(SCHEMA_VERSION));
      putMeta.run("rulesVersion", JSON.stringify(rulesVersion));
      putMeta.run("generation", JSON.stringify(crypto.randomBytes(8).toString("hex")));
    });
    const schema = metaOf("schema");
    if (schema === null) wipe();
    else if (schema !== SCHEMA_VERSION) {
      db.close();
      throw new Error(`iceberg-host-store: ${file} has schema ${schema}, expected ${SCHEMA_VERSION}`);
    } else if (metaOf("rulesVersion") !== rulesVersion) wipe();
  }
  const selectPage = db.prepare("SELECT body FROM icebergs WHERE marked_at >= ? AND marked_at < ? AND (marked_at > ? OR (marked_at = ? AND id > ?)) ORDER BY marked_at, id LIMIT ?");
  const countIcebergs = db.prepare("SELECT COUNT(*) AS n FROM icebergs");

  function requireWritable() {
    if (readonly) throw new Error("iceberg-host-store: the store was opened read-only");
  }

  function putSettled(list) {
    requireWritable();
    const outcome = { added: 0, updated: 0, ignored: 0 };
    for (const entry of list) {
      if (!validWireIceberg(entry)) throw new Error("iceberg-host-store: putSettled expects valid wire icebergs");
      if (!SETTLED.has(entry.status)) throw new Error("iceberg-host-store: putSettled expects settled icebergs only");
      const known = selectExisting.get(entry.id);
      if (known !== undefined && known.updated_at >= entry.updatedAt) {
        outcome.ignored += 1;
        continue;
      }
      upsert.run(entry.id, entry.markedAt, entry.updatedAt, JSON.stringify(entry));
      if (known === undefined) outcome.added += 1;
      else outcome.updated += 1;
    }
    return outcome;
  }

  function readPage({ fromTs, toTs, limit = DEFAULT_PAGE, after = null }) {
    if (spanOf(fromTs, toTs) === null) throw new Error("iceberg-host-store: readPage expects an epoch-ms window with from before to");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new Error(`iceberg-host-store: limit must be an integer from 1 to ${MAX_PAGE}`);
    const afterMark = after === null ? -1 : after.markedAt;
    const afterId = after === null ? "" : after.id;
    const rows = selectPage.all(fromTs, toTs, afterMark, afterMark, afterId, limit + 1);
    const page = rows.slice(0, limit).map((row) => JSON.parse(row.body));
    const last = page[page.length - 1];
    return { icebergs: page, next: rows.length > limit ? { markedAt: last.markedAt, id: last.id } : null };
  }

  function checkpoint(next, settled = []) {
    if (next === undefined) {
      return {
        cursor: metaOf("cursor"),
        start: metaOf("start"),
        settledThrough: metaOf("settledThrough"),
        cuts: metaOf("cuts"),
        coverage: metaOf("coverage", []),
        gaps: metaOf("gaps", []),
      };
    }
    requireWritable();
    for (const key of ["cursor", "start", "settledThrough"]) {
      if (next[key] !== null && !Number.isSafeInteger(next[key])) throw new Error(`iceberg-host-store: checkpoint ${key} must be an integer or null`);
    }
    const coverage = mergeSpans((next.coverage ?? []).map(([from, to]) => {
      const span = spanOf(from, to);
      if (span === null) throw new Error("iceberg-host-store: checkpoint coverage must be epoch-ms spans");
      return span;
    }));
    const gaps = (next.gaps ?? []).map((entry) => {
      const gap = gapOf(entry);
      if (gap === null) throw new Error("iceberg-host-store: checkpoint gaps must be [from, to, reason] with a known reason");
      return gap;
    }).sort((a, b) => a[0] - b[0]);
    db.transaction(() => {
      putSettled(settled);
      putMeta.run("cursor", JSON.stringify(next.cursor));
      putMeta.run("start", JSON.stringify(next.start));
      putMeta.run("settledThrough", JSON.stringify(next.settledThrough));
      putMeta.run("cuts", JSON.stringify(next.cuts ?? null));
      putMeta.run("coverage", JSON.stringify(coverage));
      putMeta.run("gaps", JSON.stringify(gaps));
    })();
  }

  function watched() {
    const { coverage, gaps } = checkpoint();
    return subtractSpans(coverage, gaps.map(([from, to]) => [from, to]));
  }

  function prune(beforeTs) {
    requireWritable();
    if (!Number.isSafeInteger(beforeTs) || beforeTs < 0) throw new Error("iceberg-host-store: prune expects an epoch-ms cut");
    let dropped = 0;
    db.transaction(() => {
      dropped = deleteBefore.run(beforeTs).changes;
      const current = checkpoint();
      putMeta.run("coverage", JSON.stringify(clipSpansBefore(current.coverage, beforeTs)));
      putMeta.run("gaps", JSON.stringify(current.gaps.filter(([, to]) => to > beforeTs).map(([from, to, reason]) => [Math.max(from, beforeTs), to, reason])));
      if (current.start !== null && current.start < beforeTs) putMeta.run("start", JSON.stringify(beforeTs));
    })();
    return dropped;
  }

  function stats() {
    const { cursor, settledThrough, gaps } = checkpoint();
    return { icebergs: countIcebergs.get().n, gaps: gaps.length, cursor, settledThrough };
  }

  function close() {
    db.close();
  }

  function readTransaction(fn) {
    return db.transaction(fn)();
  }

  return Object.freeze({
    putSettled,
    readPage,
    readTransaction,
    checkpoint,
    watched,
    prune,
    stats,
    close,
    generation: () => metaOf("generation"),
    rulesVersion: () => metaOf("rulesVersion"),
  });
}

module.exports = { openIcebergHostStore, pairFilePath, ICEBERG_RULES_VERSION, DEFAULT_PAGE, MAX_PAGE, GAP_REASONS };
