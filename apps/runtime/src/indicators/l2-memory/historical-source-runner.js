"use strict";

const { frameProblem } = require("./input-frames");

function createHistoricalSourceRunner({ createEngine, onSegmentEnd = () => {}, pruneEveryMs = 1000 } = {}) {
  if (typeof createEngine !== "function" || typeof onSegmentEnd !== "function") {
    throw new Error("historical-source-runner: createEngine and onSegmentEnd must be functions");
  }
  if (!Number.isSafeInteger(pruneEveryMs) || pruneEveryMs <= 0) {
    throw new Error("historical-source-runner: pruneEveryMs must be a positive safe integer");
  }
  let engine = null;
  let segment = 0;
  let prunedAt = null;

  function applyFrame(frame) {
    engine.apply(frame);
    if (frame.kind !== "book" || frame.status !== "READY") return;
    const at = typeof frame.ts === "number" ? frame.ts : Date.parse(frame.ts);
    if (prunedAt === null || at - prunedAt >= pruneEveryMs) {
      engine.prune(at);
      prunedAt = at;
    }
  }

  function applyTransition(transition) {
    if (!transition || typeof transition.restartEngine !== "boolean" || !Array.isArray(transition.frames)) {
      throw new Error("historical-source-runner: invalid transition");
    }
    if (transition.restartEngine && (typeof transition.reason !== "string" || !transition.reason)) {
      throw new Error("historical-source-runner: a restart needs a reason");
    }
    for (const frame of transition.frames) {
      const problem = frameProblem(frame);
      if (problem) throw new Error(`historical-source-runner: ${problem}`);
    }
    const books = transition.frames.filter((frame) => frame?.kind === "book" && frame.status === "READY");
    if (transition.restartEngine) {
      if (books.length > 1 || transition.frames.length > 2
          || transition.frames.some((frame) => frame.kind !== "gap" && !(frame.kind === "book" && frame.status === "READY"))
          || (transition.frames.length === 2 && (transition.frames[0].kind !== "gap" || transition.frames[1].kind !== "book"))) {
        throw new Error("historical-source-runner: invalid restart frames");
      }
      if (engine) {
        for (const frame of transition.frames) if (frame.kind === "gap") engine.apply(frame);
        onSegmentEnd({ engine, segment, reason: transition.reason, eventUs: transition.eventUs ?? null });
      }
      engine = null;
      prunedAt = null;
      if (books.length) {
        engine = createEngine();
        if (!engine || typeof engine.apply !== "function" || typeof engine.prune !== "function") {
          throw new Error("historical-source-runner: createEngine returned an invalid engine");
        }
        segment += 1;
        for (const frame of transition.frames) if (frame.kind === "book") applyFrame(frame);
      }
    } else {
      if (!engine && transition.frames.length) {
        throw new Error("historical-source-runner: frames require a trusted seed");
      }
      for (const frame of transition.frames) applyFrame(frame);
    }
    return engine;
  }

  function close(reason) {
    if (typeof reason !== "string" || !reason) throw new Error("historical-source-runner: close needs a reason");
    if (!engine) return;
    engine.apply({ kind: "gap", ts: null, cause: reason });
    onSegmentEnd({ engine, segment, reason, eventUs: null });
    engine = null;
    prunedAt = null;
  }

  return Object.freeze({ applyTransition, close, get engine() { return engine; }, get segment() { return segment; } });
}

module.exports = { createHistoricalSourceRunner };
