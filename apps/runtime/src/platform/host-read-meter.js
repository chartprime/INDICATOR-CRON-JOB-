"use strict";

const { isMainThread, BroadcastChannel } = require("node:worker_threads");

const WINDOW_MS = 60_000;
const CHANNEL_NAME = "terminal-l1-l2.host-reads";

function createHostReadMeter({ now = () => Date.now(), windowMs = WINDOW_MS } = {}) {
  const events = [];
  let head = 0;

  function trim() {
    const cutoff = now() - windowMs;
    while (head < events.length && events[head].at <= cutoff) head += 1;
    if (head > 1_024 && head * 2 > events.length) {
      events.splice(0, head);
      head = 0;
    }
  }

  function record(route, status) {
    events.push({ at: now(), route: String(route), rateLimited: status === 429 });
    trim();
  }

  function snapshot() {
    trim();
    const routes = {};
    let requests = 0;
    let rateLimited = 0;
    for (let index = head; index < events.length; index += 1) {
      const event = events[index];
      const entry = routes[event.route] ?? (routes[event.route] = { requests: 0, rateLimited: 0 });
      entry.requests += 1;
      requests += 1;
      if (event.rateLimited) {
        entry.rateLimited += 1;
        rateLimited += 1;
      }
    }
    return { windowMs, requests, rateLimited, routes };
  }

  return Object.freeze({ record, snapshot });
}

function createProcessMeter({ mainThread = isMainThread, Channel = BroadcastChannel, meter = createHostReadMeter() } = {}) {
  let channel = null;

  function open() {
    if (channel !== null) return;
    channel = new Channel(CHANNEL_NAME);
    channel.unref?.();
    if (mainThread) {
      channel.onmessage = (message) => {
        const data = message?.data;
        if (data && typeof data.route === "string") meter.record(data.route, data.status);
      };
    }
  }

  function record(route, status) {
    if (mainThread) {
      open();
      meter.record(route, status);
      return;
    }
    open();
    channel.postMessage({ route: String(route), status: Number.isSafeInteger(status) ? status : null });
  }

  function snapshot() {
    if (mainThread) open();
    return meter.snapshot();
  }

  function close() {
    channel?.close();
    channel = null;
  }

  return Object.freeze({ record, snapshot, close });
}

const hostReadMeter = createProcessMeter();

module.exports = { createHostReadMeter, createProcessMeter, hostReadMeter, WINDOW_MS, CHANNEL_NAME };
