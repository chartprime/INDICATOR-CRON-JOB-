#!/usr/bin/env node
"use strict";

const path = require("node:path");
const https = require("node:https");

const HIST_HOST = "hist.databento.com";
const HIST_BASE_PATH = "/v0";

const SCRIPT_DIR = __dirname;
const RUNTIME_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

function loadDatabentoKey(environment = process.env) {
  const key = environment.databento_key || environment.DATABENTO_API_KEY || environment.databento_api_key;
  if (!key) {
    throw new Error("databento_key not set -- run via `node --env-file=../../.env` (see package.json)");
  }
  return key;
}

function authHeader(key) {
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

function httpRequest({ key, method, params = {}, httpMethod = "GET", parseJson = true }) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams(params).toString();
    const useQueryString = httpMethod === "GET";
    const path_ = `${HIST_BASE_PATH}/${method}${useQueryString && query ? `?${query}` : ""}`;
    const bodyText = !useQueryString && query ? query : null;
    const headers = { Authorization: authHeader(key) };
    if (parseJson) headers.Accept = "application/json";
    if (bodyText) headers["Content-Type"] = "application/x-www-form-urlencoded";

    const req = https.request(
      { host: HIST_HOST, path: path_, method: httpMethod, headers, timeout: 180_000 },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          if (!parseJson) {
            resolve({ status: res.statusCode, text: raw });
            return;
          }
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = { raw: raw.slice(0, 2000) };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`request to ${method} timed out`)));
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

function requestJson(key, method, params = {}, { httpMethod = "GET" } = {}) {
  return httpRequest({ key, method, params, httpMethod, parseJson: true });
}

function requestRaw(key, method, params = {}) {
  return httpRequest({ key, method, params, httpMethod: "GET", parseJson: false });
}

function requestStream(key, method, params = {}) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams(params).toString();
    const path_ = `${HIST_BASE_PATH}/${method}${query ? `?${query}` : ""}`;
    const req = https.request(
      { host: HIST_HOST, path: path_, method: "GET", headers: { Authorization: authHeader(key) }, timeout: 600_000 },
      (res) => resolve(res),
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`stream request to ${method} timed out`)));
    req.end();
  });
}

module.exports = {
  HIST_HOST,
  HIST_BASE_PATH,
  RUNTIME_ROOT,
  loadDatabentoKey,
  authHeader,
  requestJson,
  requestRaw,
  requestStream,
};
