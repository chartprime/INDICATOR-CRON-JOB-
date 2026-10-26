#!/usr/bin/env node
"use strict";

const https = require("node:https");

const DATASETS_HOST = "datasets.tardis.dev";
const DATASETS_BASE_PATH = "/v1";
const MAX_ATTEMPTS = 10;
const MAX_REDIRECTS = 3;
const HEADERS_DEADLINE_MS = 120_000;

function pad(n) {
  return String(n).padStart(2, "0");
}

function buildPath({ exchange, dataType, date, symbol }) {
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const upperSymbol = symbol.replace(/\/|:/g, "-").toUpperCase();
  return `${DATASETS_BASE_PATH}/${exchange}/${dataType}/${year}/${month}/${day}/${encodeURIComponent(upperSymbol)}.csv.gz`;
}

function requestOnce(urlObj, headers, { requestImpl = https.request, headerDeadlineMs = HEADERS_DEADLINE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = requestImpl(
      { host: urlObj.hostname, path: `${urlObj.pathname}${urlObj.search}`, method: "GET", headers, timeout: headerDeadlineMs },
      (res) => { clearTimeout(deadline); resolve(res); },
    );
    const deadline = setTimeout(
      () => req.destroy(new Error(`request to ${urlObj.href} exceeded the ${headerDeadlineMs}ms header deadline`)),
      headerDeadlineMs,
    );
    req.on("error", (error) => { clearTimeout(deadline); reject(error); });
    req.on("timeout", () => req.destroy(new Error(`request to ${urlObj.href} timed out`)));
    req.end();
  });
}

async function requestStream(apiKey, urlPath, opts = {}) {
  let urlObj = new URL(`https://${DATASETS_HOST}${urlPath}`);
  let headers = { Authorization: `Bearer ${apiKey}` };
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const res = await requestOnce(urlObj, headers, opts);
    const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
    if (!isRedirect) return res;
    res.resume();
    urlObj = new URL(res.headers.location, urlObj);
    headers = {};
  }
  throw new Error(`too many redirects for ${urlPath}`);
}

class HttpStatusError extends Error {
  constructor(status, urlPath) {
    super(`HTTP ${status} for ${urlPath}`);
    this.status = status;
    this.urlPath = urlPath;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(apiKey, target, { onRetry, sleepImpl = sleep, ...requestOpts } = {}) {
  const urlPath = buildPath(target);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let res;
    try {
      res = await requestStream(apiKey, urlPath, requestOpts);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw error;
      const waitMs = Math.min(2 ** attempt * 1000, 120_000) + Math.random() * 500;
      onRetry?.({ attempt, maxAttempts: MAX_ATTEMPTS, urlPath, reason: error.message, statusCode: null, waitMs });
      await sleepImpl(waitMs);
      continue;
    }
    if (res.statusCode === 200) return res;
    res.resume();
    const nonRetryable = res.statusCode === 400 || res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404;
    if (nonRetryable || attempt >= MAX_ATTEMPTS) throw new HttpStatusError(res.statusCode, urlPath);
    const waitMs = res.statusCode === 429 ? 60_000 : Math.min(2 ** attempt * 1000, 120_000) + Math.random() * 500;
    onRetry?.({ attempt, maxAttempts: MAX_ATTEMPTS, urlPath, reason: `HTTP ${res.statusCode}`, statusCode: res.statusCode, waitMs });
    await sleepImpl(waitMs);
  }
}

module.exports = { DATASETS_HOST, DATASETS_BASE_PATH, HEADERS_DEADLINE_MS, MAX_ATTEMPTS, buildPath, requestStream, fetchWithRetry, HttpStatusError };
