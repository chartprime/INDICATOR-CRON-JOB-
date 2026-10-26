"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { LEVELS_MS, WINDOW_MS, WINDOW_STATES, windowStart, isLevel, packWindow, unpackWindowText } = require("./pyramid-levels");

const SCHEMA_VERSION = "1";
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const GEOMETRY_KEYS = Object.freeze(["tickSize", "clusterTicks", "rowClusters", "windowRows", "sizeDigits", "snapshotDepth", "columnMs", "replayWarmupMs", "rowBp", "windowBp", "referenceBp"]);
const PAIR_KEY_PATTERN = /^[A-Za-z0-9:._/-]{1,96}$/;
const DELETE_LEVELS_SQL = "DELETE FROM levels WHERE level_ms = ? AND window_ts = ?";
const PRUNE_LEVELS_SQL = "DELETE FROM levels WHERE level_ms = ? AND window_ts < ?";
const SIDES = new Set(["bid", "ask"]);
const DEFAULT_WALL_PAGE = 400;
const WALL_OUTCOMES = Object.freeze(["filled", "partial", "hit", "pulled", "moved"]);
const WALL_COLUMNS = "id, start_ts, end_ts, peak, body";

function overlaps(aLo, aSpan, bLo, bSpan) {
  return aLo <= bLo + bSpan - 1 && bLo <= aLo + aSpan - 1;
}

function closestTo(rows, lo, span, targetTs) {
  let best = null;
  for (const row of rows) {
    if (!overlaps(lo, span, row.row_lo, row.span)) continue;
    if (best === null || Math.abs(row.start_ts - targetTs) < Math.abs(best.start_ts - targetTs)) best = row;
  }
  return best;
}

function assertWall(wall, { ended }) {
  if (!wall || typeof wall !== "object" || !SIDES.has(wall.side)) throw new Error("pyramid-store: a wall needs a side of bid or ask");
  if (!Number.isSafeInteger(wall.row) || !Number.isSafeInteger(wall.span) || wall.span < 1) throw new Error("pyramid-store: a wall needs integer row and span");
  if (!Number.isSafeInteger(wall.startTs) || wall.startTs < 0) throw new Error("pyramid-store: a wall needs an integer startTs");
  if (ended ? !Number.isSafeInteger(wall.endTs) || wall.endTs < wall.startTs : wall.endTs !== null && !Number.isSafeInteger(wall.endTs)) throw new Error("pyramid-store: a wall's endTs must be an integer, or null while it stands");
  if (!Number.isFinite(wall.peak) || wall.peak < 0 || !Number.isFinite(wall.size) || wall.size < 0) throw new Error("pyramid-store: a wall needs finite peak and size");
}

function assertEvents(events) {
  if (!events || typeof events !== "object" || !Array.isArray(events.trades) || !Array.isArray(events.wallTrades) || !events.fill || typeof events.fill !== "object") throw new Error("pyramid-store: events must carry trades, wallTrades and fill");
}

function wallOf(row) {
  return { ...JSON.parse(row.body), id: row.id, startTs: row.start_ts, peak: row.peak };
}

function pairFileName(pairKey) {
  if (typeof pairKey !== "string" || !PAIR_KEY_PATTERN.test(pairKey)) throw new Error("pyramid-store: pairKey is not a valid pair key");
  return `${pairKey.replace(/[^A-Za-z0-9._-]/g, "_")}.sqlite`;
}

function pairFilePath(dir, pairKey) {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("pyramid-store: dir is required");
  return path.join(dir, pairFileName(pairKey));
}

function sameGeometry(a, b) {
  if (!a || !b) return false;
  return GEOMETRY_KEYS.every((key) => a[key] === b[key]);
}

function assertWindowTs(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value % WINDOW_MS !== 0) throw new Error("pyramid-store: windowTs must be a window-aligned epoch ms");
}

function openPyramidStore({ dir, pairKey, readonly = false, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, Database = require("better-sqlite3") }) {
  const file = pairFilePath(dir, pairKey);
  if (readonly && !fs.existsSync(file)) return null;
  if (!readonly) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(file, readonly ? { readonly: true, fileMustExist: true, timeout: busyTimeoutMs } : { timeout: busyTimeoutMs });
  if (!readonly) {
    db.pragma("journal_mode = DELETE");
    db.pragma("synchronous = FULL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS windows (
        window_ts INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        columns INTEGER NOT NULL,
        frames INTEGER NOT NULL,
        reason TEXT,
        built_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS levels (
        level_ms INTEGER NOT NULL,
        window_ts INTEGER NOT NULL,
        columns INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        body BLOB NOT NULL,
        PRIMARY KEY (level_ms, window_ts)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS walls (
        id INTEGER PRIMARY KEY,
        window_ts INTEGER NOT NULL,
        side TEXT NOT NULL,
        row_lo INTEGER NOT NULL,
        span INTEGER NOT NULL,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        peak REAL NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS walls_window ON walls (window_ts);
      CREATE INDEX IF NOT EXISTS walls_end ON walls (end_ts, id);
      CREATE INDEX IF NOT EXISTS walls_birth ON walls (side, start_ts);
      CREATE TABLE IF NOT EXISTS events (
        window_ts INTEGER PRIMARY KEY,
        bytes INTEGER NOT NULL,
        body BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS standing (
        id INTEGER PRIMARY KEY,
        until INTEGER NOT NULL,
        tolerance_ms INTEGER NOT NULL,
        side TEXT NOT NULL,
        row_lo INTEGER NOT NULL,
        span INTEGER NOT NULL,
        start_ts INTEGER NOT NULL,
        peak REAL NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS standing_until ON standing (until);
      CREATE INDEX IF NOT EXISTS standing_birth ON standing (side, start_ts);
    `);
    const schema = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
    if (schema === undefined) db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
    else if (schema.value !== SCHEMA_VERSION) {
      db.close();
      throw new Error(`pyramid-store: ${file} has schema ${schema.value}, expected ${SCHEMA_VERSION}`);
    }
  }

  const selectMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const selectWindows = db.prepare("SELECT window_ts AS ts, state, columns, frames, reason, built_at AS builtAt FROM windows WHERE window_ts >= ? AND window_ts < ? ORDER BY window_ts");
  const selectPage = db.prepare(`
    SELECT w.window_ts AS ts, w.state AS state, l.body AS body, l.bytes AS bytes
    FROM windows w LEFT JOIN levels l ON l.level_ms = ? AND l.window_ts = w.window_ts
    WHERE w.window_ts >= ? AND w.window_ts < ?
    ORDER BY w.window_ts
  `);
  const selectEvents = db.prepare("SELECT window_ts AS ts, bytes, body FROM events WHERE window_ts >= ? AND window_ts < ? ORDER BY window_ts");
  const selectHistoryWindows = db.prepare("SELECT window_ts AS ts FROM events WHERE window_ts >= ? AND window_ts < ? ORDER BY window_ts");
  const selectWallsFirst = db.prepare("SELECT id, start_ts, end_ts, peak, body FROM walls WHERE end_ts >= ? AND end_ts < ? ORDER BY end_ts, id LIMIT ?");
  const selectWallsAfter = db.prepare("SELECT id, start_ts, end_ts, peak, body FROM walls WHERE end_ts >= ? AND end_ts < ? AND (end_ts > ? OR (end_ts = ? AND id > ?)) ORDER BY end_ts, id LIMIT ?");
  const filteredWallStatements = new Map();

  function filteredWallStatementsFor(outcomes) {
    const key = outcomes.join(",");
    const held = filteredWallStatements.get(key);
    if (held !== undefined) return held;
    const exempt = outcomes.length === 0 ? "" : ` OR json_extract(body, '$.endedBy') IN (${outcomes.map(() => "?").join(", ")})`;
    const base = `SELECT ${WALL_COLUMNS} FROM walls WHERE end_ts >= ? AND end_ts < ? AND (peak * (row_lo + span / 2.0) * ? >= ?${exempt})`;
    const made = {
      first: db.prepare(`${base} ORDER BY end_ts, id LIMIT ?`),
      after: db.prepare(`${base} AND (end_ts > ? OR (end_ts = ? AND id > ?)) ORDER BY end_ts, id LIMIT ?`),
    };
    filteredWallStatements.set(key, made);
    return made;
  }

  const selectWallsBorn = db.prepare("SELECT id, row_lo, span, start_ts, peak FROM walls WHERE side = ? AND start_ts = ?");
  const selectStandingBorn = db.prepare("SELECT id, row_lo, span, start_ts, peak FROM standing WHERE side = ? AND start_ts = ?");
  const selectWallsNear = db.prepare("SELECT id, row_lo, span, start_ts, peak FROM walls WHERE side = ? AND start_ts > ? AND start_ts BETWEEN ? AND ?");
  const selectStandingNear = db.prepare("SELECT id, row_lo, span, start_ts, peak FROM standing WHERE side = ? AND start_ts > ? AND start_ts BETWEEN ? AND ?");
  const selectSeedsFor = db.prepare("SELECT id, until, row_lo, span, start_ts, peak FROM standing WHERE side = ? AND start_ts < ? AND ? BETWEEN until - tolerance_ms AND until + tolerance_ms");
  const writes = readonly ? null : {
    setMeta: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    putWall: db.prepare("INSERT INTO walls (window_ts, side, row_lo, span, start_ts, end_ts, peak, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    deleteWalls: db.prepare("DELETE FROM walls WHERE window_ts = ?"),
    putEvents: db.prepare("INSERT INTO events (window_ts, bytes, body) VALUES (?, ?, ?) ON CONFLICT(window_ts) DO UPDATE SET bytes = excluded.bytes, body = excluded.body"),
    deleteEvents: db.prepare("DELETE FROM events WHERE window_ts = ?"),
    putStanding: db.prepare("INSERT INTO standing (until, tolerance_ms, side, row_lo, span, start_ts, peak, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    deleteStanding: db.prepare("DELETE FROM standing WHERE until = ?"),
    rebirthWall: db.prepare("UPDATE walls SET start_ts = ?, peak = MAX(peak, ?) WHERE id = ?"),
    rebirthStanding: db.prepare("UPDATE standing SET start_ts = ?, peak = MAX(peak, ?) WHERE id = ?"),
    pruneWalls: db.prepare("DELETE FROM walls WHERE window_ts < ?"),
    pruneEvents: db.prepare("DELETE FROM events WHERE window_ts < ?"),
    pruneStanding: db.prepare("DELETE FROM standing WHERE until < ?"),
    wipeWalls: db.prepare("DELETE FROM walls"),
    wipeEvents: db.prepare("DELETE FROM events"),
    wipeStanding: db.prepare("DELETE FROM standing"),
    putWindow: db.prepare("INSERT INTO windows (window_ts, state, columns, frames, reason, built_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(window_ts) DO UPDATE SET state = excluded.state, columns = excluded.columns, frames = excluded.frames, reason = excluded.reason, built_at = excluded.built_at"),
    deleteLevels: db.prepare(DELETE_LEVELS_SQL),
    putLevel: db.prepare("INSERT INTO levels (level_ms, window_ts, columns, bytes, body) VALUES (?, ?, ?, ?, ?)"),
    pruneWindows: db.prepare("DELETE FROM windows WHERE window_ts < ?"),
    pruneLevels: db.prepare(PRUNE_LEVELS_SQL),
    wipeWindows: db.prepare("DELETE FROM windows"),
    wipeLevels: db.prepare("DELETE FROM levels"),
  };

  function requireWritable() {
    if (writes === null) throw new Error("pyramid-store: opened read-only");
  }

  function geometry() {
    const row = selectMeta.get("geometry");
    return row === undefined ? null : JSON.parse(row.value);
  }

  function generation() {
    return selectMeta.get("generation")?.value ?? null;
  }

  const pinTransaction = writes === null ? null : db.transaction((next) => {
    writes.wipeLevels.run();
    writes.wipeWindows.run();
    writes.wipeWalls.run();
    writes.wipeEvents.run();
    writes.wipeStanding.run();
    writes.setMeta.run("geometry", JSON.stringify(next));
    writes.setMeta.run("generation", crypto.randomUUID());
  });

  function pin(next) {
    requireWritable();
    for (const key of GEOMETRY_KEYS) {
      if (!Number.isFinite(next?.[key])) throw new Error(`pyramid-store: geometry.${key} must be a finite number`);
    }
    const current = geometry();
    if (sameGeometry(current, next)) return false;
    pinTransaction(next);
    return true;
  }

  function propagate(side, lo, span, from, to, peak) {
    for (const wall of selectWallsBorn.all(side, from)) if (overlaps(lo, span, wall.row_lo, wall.span)) writes.rebirthWall.run(to, peak, wall.id);
    for (const row of selectStandingBorn.all(side, from)) {
      if (!overlaps(lo, span, row.row_lo, row.span)) continue;
      writes.rebirthStanding.run(to, peak, row.id);
      propagate(side, row.row_lo, row.span, from, to, peak);
    }
  }

  function rebirthStanding(row, startTs, peak) {
    writes.rebirthStanding.run(startTs, peak, row.id);
    propagate(row.side, row.row_lo, row.span, row.start_ts, startTs, Math.max(peak, row.peak));
  }

  function adoptFromSeeds(side, lo, span, startTs, rebirth) {
    let best = null;
    for (const seed of selectSeedsFor.all(side, startTs, startTs)) {
      if (!overlaps(lo, span, seed.row_lo, seed.span)) continue;
      if (best === null || Math.abs(startTs - seed.until) < Math.abs(startTs - best.until)) best = seed;
    }
    if (best !== null) rebirth(best);
  }

  function storeWall(windowTs, wall) {
    const { lastInsertRowid } = writes.putWall.run(windowTs, wall.side, wall.row, wall.span, wall.startTs, wall.endTs, Math.max(wall.peak, wall.size), JSON.stringify(wall));
    adoptFromSeeds(wall.side, wall.row, wall.span, wall.startTs, (seed) => writes.rebirthWall.run(seed.start_ts, seed.peak, lastInsertRowid));
  }

  function storeStanding(until, toleranceMs, wall) {
    const peak = Math.max(wall.peak, wall.size);
    const { lastInsertRowid } = writes.putStanding.run(until, toleranceMs, wall.side, wall.row, wall.span, wall.startTs, peak, JSON.stringify(wall));
    const row = { id: lastInsertRowid, side: wall.side, row_lo: wall.row, span: wall.span, start_ts: wall.startTs, peak };
    adoptFromSeeds(wall.side, wall.row, wall.span, wall.startTs, (seed) => {
      rebirthStanding(row, seed.start_ts, seed.peak);
      row.start_ts = seed.start_ts;
      row.peak = Math.max(row.peak, seed.peak);
    });
    const bornWall = closestTo(selectWallsNear.all(wall.side, row.start_ts, until - toleranceMs, until + toleranceMs), wall.row, wall.span, until);
    if (bornWall !== null) writes.rebirthWall.run(row.start_ts, row.peak, bornWall.id);
    const bornStanding = closestTo(selectStandingNear.all(wall.side, row.start_ts, until - toleranceMs, until + toleranceMs), wall.row, wall.span, until);
    if (bornStanding !== null) rebirthStanding({ ...bornStanding, side: wall.side }, row.start_ts, row.peak);
  }

  const putTransaction = writes === null ? null : db.transaction((windowTs, record, packed, histories) => {
    for (const levelMs of LEVELS_MS) writes.deleteLevels.run(levelMs, windowTs);
    writes.putWindow.run(windowTs, record.state, record.columns, record.frames, record.reason, record.builtAt);
    for (const entry of packed) writes.putLevel.run(entry.levelMs, windowTs, entry.columns, entry.bytes, entry.body);
    if (histories !== null) writeHistories(windowTs, histories);
  });

  function writeHistories(windowTs, histories) {
    writes.deleteWalls.run(windowTs);
    writes.deleteEvents.run(windowTs);
    if (histories.events !== null) {
      const text = JSON.stringify(histories.events);
      writes.putEvents.run(windowTs, text.length, zlib.gzipSync(Buffer.from(text, "utf8")));
    }
    for (const wall of histories.walls) storeWall(windowTs, wall);
  }

  const historiesTransaction = writes === null ? null : db.transaction(writeHistories);

  const standingTransaction = writes === null ? null : db.transaction((until, toleranceMs, walls) => {
    writes.deleteStanding.run(until);
    for (const wall of walls) storeStanding(until, toleranceMs, wall);
  });

  function putStanding({ until, toleranceMs, walls }) {
    requireWritable();
    if (!Number.isSafeInteger(until) || until < 0) throw new Error("pyramid-store: a hand-over needs the seed time as until");
    if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 0) throw new Error("pyramid-store: toleranceMs must be a non-negative integer");
    if (!Array.isArray(walls)) throw new Error("pyramid-store: a hand-over needs an array of standing walls");
    for (const wall of walls) assertWall(wall, { ended: false });
    standingTransaction(until, toleranceMs, walls);
  }

  function historyWindows(fromTs, toTs) {
    return selectHistoryWindows.all(windowStart(fromTs), toTs).map((row) => row.ts);
  }

  const selectWallSizes = db.prepare("SELECT peak, row_lo, span FROM walls");

  function sizeBands(rowWidth) {
    if (!(rowWidth > 0)) throw new Error("pyramid-store: size bands need the pinned row width");
    const sizes = [];
    for (const row of selectWallSizes.iterate()) sizes.push(row.peak * (row.row_lo + row.span / 2.0) * rowWidth);
    if (sizes.length === 0) return null;
    sizes.sort((a, b) => a - b);
    const at = (share) => sizes[Math.min(sizes.length - 1, Math.floor(share * sizes.length))];
    return { n: sizes.length, p50: at(0.5), p75: at(0.75), p90: at(0.9), p95: at(0.95), p99: at(0.99) };
  }

  function wallRows(fromTs, toTs, limit, after, minUsd, alwaysOutcomes) {
    if (minUsd === undefined) {
      if (alwaysOutcomes !== undefined) throw new Error("pyramid-store: alwaysOutcomes needs minUsd");
      return after === null ? selectWallsFirst.all(fromTs, toTs, limit + 1) : selectWallsAfter.all(fromTs, toTs, after.endTs, after.endTs, after.id, limit + 1);
    }
    if (!Number.isFinite(minUsd) || minUsd < 0) throw new Error("pyramid-store: minUsd must be a non-negative number");
    const outcomes = [...new Set(alwaysOutcomes ?? [])].sort();
    if (outcomes.some((outcome) => !WALL_OUTCOMES.includes(outcome))) throw new Error("pyramid-store: alwaysOutcomes holds an unknown outcome");
    const rowWidth = geometry()?.rowWidth;
    if (!(rowWidth > 0)) return [];
    const statements = filteredWallStatementsFor(outcomes);
    const head = [fromTs, toTs, rowWidth, minUsd, ...outcomes];
    return after === null ? statements.first.all(...head, limit + 1) : statements.after.all(...head, after.endTs, after.endTs, after.id, limit + 1);
  }

  function readWalls({ fromTs, toTs, limit = DEFAULT_WALL_PAGE, after = null, minUsd, alwaysOutcomes }) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("pyramid-store: limit must be a positive integer");
    if (after !== null && (!after || !Number.isSafeInteger(after.endTs) || !Number.isSafeInteger(after.id))) throw new Error("pyramid-store: after must be { endTs, id } or null");
    const rows = wallRows(fromTs, toTs, limit, after, minUsd, alwaysOutcomes);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { walls: page.map(wallOf), next: rows.length > limit ? { endTs: last.end_ts, id: last.id } : null };
  }

  function readEvents({ fromTs, toTs, maxBytes }) {
    const windows = [];
    let bytes = 0;
    let next = null;
    for (const row of selectEvents.iterate(windowStart(fromTs), toTs)) {
      if (windows.length > 0 && bytes + row.bytes > maxBytes) {
        next = row.ts;
        break;
      }
      bytes += row.bytes;
      windows.push({ ts: row.ts, events: JSON.parse(zlib.gunzipSync(row.body).toString("utf8")) });
    }
    return { windows, next };
  }

  function putWindow({ windowTs, state, columns, frames, reason = null, builtAt, levels, walls, events }) {
    requireWritable();
    assertWindowTs(windowTs);
    if (!Object.values(WINDOW_STATES).includes(state)) throw new Error("pyramid-store: state is not a window state");
    if (!Number.isSafeInteger(columns) || columns < 0 || !Number.isSafeInteger(frames) || frames < 0) throw new Error("pyramid-store: columns and frames must be non-negative integers");
    if (!Number.isSafeInteger(builtAt)) throw new Error("pyramid-store: builtAt must be an epoch ms");
    if (!(levels instanceof Map)) throw new Error("pyramid-store: levels must be a Map of level to columns");
    const packed = [];
    for (const [levelMs, levelColumns] of levels) {
      if (!isLevel(levelMs)) throw new Error(`pyramid-store: ${levelMs} is not a pyramid level`);
      if (levelColumns.length === 0) continue;
      for (const column of levelColumns) {
        if (column.ts < windowTs || column.ts >= windowTs + WINDOW_MS || column.ts % levelMs !== 0) throw new Error("pyramid-store: a column lies outside its window or level grid");
      }
      const body = packWindow(levelColumns);
      packed.push({ levelMs, columns: levelColumns.length, bytes: body.length, body });
    }
    putTransaction(windowTs, { state, columns, frames, reason, builtAt }, packed, walls === undefined && events === undefined ? null : checkedHistories(walls, events));
    return packed.reduce((total, entry) => total + entry.bytes, 0);
  }

  function checkedHistories(walls, events) {
    if (!Array.isArray(walls)) throw new Error("pyramid-store: walls must be an array of ended walls");
    for (const wall of walls) assertWall(wall, { ended: true });
    if (events !== null) assertEvents(events);
    return { walls, events };
  }

  function putHistories({ windowTs, walls, events }) {
    requireWritable();
    assertWindowTs(windowTs);
    historiesTransaction(windowTs, checkedHistories(walls, events));
  }

  function windowRecords(fromTs, toTs) {
    return selectWindows.all(windowStart(fromTs), toTs);
  }

  function prune(beforeTs) {
    requireWritable();
    const cutoff = windowStart(beforeTs);
    return db.transaction(() => {
      for (const levelMs of LEVELS_MS) writes.pruneLevels.run(levelMs, cutoff);
      writes.pruneWalls.run(cutoff);
      writes.pruneEvents.run(cutoff);
      writes.pruneStanding.run(cutoff);
      return writes.pruneWindows.run(cutoff).changes;
    })();
  }

  function readPage({ levelMs, fromTs, toTs, maxBytes }) {
    if (!isLevel(levelMs)) throw new Error("pyramid-store: levelMs is not a pyramid level");
    const windows = [];
    let bytes = 0;
    let next = null;
    for (const row of selectPage.iterate(levelMs, windowStart(fromTs), toTs)) {
      const text = row.body === null ? "[]" : unpackWindowText(row.body);
      if (windows.length > 0 && bytes + text.length > maxBytes) {
        next = row.ts;
        break;
      }
      bytes += text.length;
      windows.push({ ts: row.ts, state: row.state, columns: JSON.parse(text) });
    }
    return { windows, next, bytes };
  }

  const selectNewest = db.prepare("SELECT window_ts AS ts FROM windows ORDER BY window_ts DESC LIMIT 1");
  const selectOldest = db.prepare("SELECT window_ts AS ts FROM windows ORDER BY window_ts ASC LIMIT 1");

  function span() {
    const newest = selectNewest.get();
    const oldest = selectOldest.get();
    return { oldest: oldest === undefined ? null : oldest.ts, newest: newest === undefined ? null : newest.ts };
  }

  const snapshotTransaction = db.transaction((options) => ({ geometry: geometry(), generation: generation(), page: readPage(options), span: span() }));

  function snapshotPage(options) {
    return snapshotTransaction(options);
  }

  const snapshotWallsTransaction = db.transaction((options) => ({ geometry: geometry(), generation: generation(), page: readWalls(options), span: span() }));
  const snapshotEventsTransaction = db.transaction((options) => ({ geometry: geometry(), generation: generation(), page: readEvents(options), span: span() }));

  function snapshotWalls(options) {
    return snapshotWallsTransaction(options);
  }

  function snapshotEvents(options) {
    return snapshotEventsTransaction(options);
  }

  function stats() {
    const perLevel = db.prepare("SELECT level_ms AS levelMs, COUNT(*) AS windows, SUM(columns) AS columns, SUM(bytes) AS bytes FROM levels GROUP BY level_ms ORDER BY level_ms").all();
    const range = db.prepare("SELECT COUNT(*) AS windows, MIN(window_ts) AS oldest, MAX(window_ts) AS newest FROM windows").get();
    const states = Object.fromEntries(db.prepare("SELECT state, COUNT(*) AS n FROM windows GROUP BY state").all().map((row) => [row.state, row.n]));
    const histories = db.prepare("SELECT (SELECT COUNT(*) FROM walls) AS walls, (SELECT COUNT(*) FROM events) AS eventWindows, (SELECT COUNT(*) FROM standing) AS standing").get();
    return { file, ...range, states, levels: perLevel, ...histories };
  }

  function close() {
    db.close();
  }

  return Object.freeze({ file, geometry, generation, pin, putWindow, putHistories, putStanding, historyWindows, readWalls, sizeBands, readEvents, snapshotWalls, snapshotEvents, windowRecords, prune, readPage, snapshotPage, span, stats, close });
}

module.exports = { openPyramidStore, pairFileName, pairFilePath, sameGeometry, GEOMETRY_KEYS, SCHEMA_VERSION, LEVELS_MS, DELETE_LEVELS_SQL, PRUNE_LEVELS_SQL, DEFAULT_WALL_PAGE, WALL_OUTCOMES };
