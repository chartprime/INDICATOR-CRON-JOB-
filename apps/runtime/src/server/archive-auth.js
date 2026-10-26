"use strict";

const crypto = require("node:crypto");

const MIN_TOKEN_LENGTH = 24;
const MAX_AUTHORIZATION_LENGTH = 4096;
const MAX_CLIENT_ID_LENGTH = 128;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN68_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function isToken68(value) {
  return typeof value === "string" && TOKEN68_PATTERN.test(value);
}

function parseClientTokens(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw !== "string") throw new Error("archive-auth: client tokens must be a string");
  const entries = [];
  const seen = new Set();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) throw new Error("archive-auth: each client token must be clientId:secret");
    const clientId = trimmed.slice(0, separator);
    const secret = trimmed.slice(separator + 1);
    if (!CLIENT_ID_PATTERN.test(clientId) || clientId.length > MAX_CLIENT_ID_LENGTH) {
      throw new Error("archive-auth: clientId must be a short printable identifier");
    }
    if (secret.length < MIN_TOKEN_LENGTH) {
      throw new Error(`archive-auth: token for ${clientId} is shorter than ${MIN_TOKEN_LENGTH} characters`);
    }
    if (!isToken68(secret)) {
      throw new Error(`archive-auth: token for ${clientId} contains characters a bearer credential cannot carry`);
    }
    if (seen.has(clientId)) throw new Error(`archive-auth: duplicate clientId ${clientId}`);
    seen.add(clientId);
    entries.push({ clientId, hash: digest(secret) });
  }
  return entries;
}

function bearerToken(authorization) {
  if (typeof authorization !== "string") return null;
  if (authorization.length > MAX_AUTHORIZATION_LENGTH) return null;
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return isToken68(token) ? token : null;
}

function createArchiveAuth({ clientTokens = process.env.TT_ARCHIVE_CLIENT_TOKENS } = {}) {
  const entries = parseClientTokens(clientTokens);

  function identify(authorization) {
    const token = bearerToken(authorization);
    if (token === null || entries.length === 0) return null;
    const presented = digest(token);
    let matched = null;
    for (const entry of entries) {
      if (crypto.timingSafeEqual(presented, entry.hash)) matched = entry.clientId;
    }
    return matched;
  }

  return Object.freeze({ identify, clientCount: entries.length });
}

module.exports = {
  createArchiveAuth,
  parseClientTokens,
  bearerToken,
  MIN_TOKEN_LENGTH,
  MAX_AUTHORIZATION_LENGTH,
  MAX_CLIENT_ID_LENGTH,
};
