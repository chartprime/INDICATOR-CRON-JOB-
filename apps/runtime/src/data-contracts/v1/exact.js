"use strict";

class ContractError extends Error {
  constructor(code) { super(code); this.name = "ContractError"; this.code = code; }
}
function requireValue(ok, code) { if (!ok) throw new ContractError(code); }
function token(value) {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value, "INVALID_TOKEN");
  return value;
}
function integer(value, signed = false) {
  if (typeof value === "number") {
    requireValue(Number.isSafeInteger(value), "UNSAFE_INTEGER"); value = String(value);
  }
  requireValue(typeof value === "string" && value.length <= 40 && (signed ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/).test(value), "INVALID_INTEGER");
  requireValue(value !== "-0", "INVALID_INTEGER");
  return value;
}
function timestamp(value, unit = "ns") {
  requireValue(["ns", "us", "ms"].includes(unit), "INVALID_TIME_UNIT");
  const n = BigInt(integer(value)) * ({ ns: 1n, us: 1000n, ms: 1000000n }[unit]);
  requireValue(n < 18446744073709551615n, "INVALID_TIMESTAMP");
  return n.toString();
}
function decimal(value) {
  requireValue(typeof value === "string" && value.length <= 128 && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value), "INVALID_DECIMAL");
  const scale = value.includes(".") ? value.length - value.indexOf(".") - 1 : 0;
  requireValue(scale <= 18, "DECIMAL_SCALE_EXCEEDED");
  return { coefficient: integer(BigInt(value.replace(".", "")).toString(), true), scale };
}
function decimalText(value) {
  requireValue(value && Number.isInteger(value.scale) && value.scale >= 0 && value.scale <= 18, "INVALID_DECIMAL_SCALE");
  requireValue(typeof value.coefficient === "string", "CANONICAL_COEFFICIENT_STRING_REQUIRED");
  const n = integer(value.coefficient, true);
  const digits = n.replace("-", "").padStart(value.scale + 1, "0");
  return (n.startsWith("-") ? "-" : "") + (value.scale ? digits.slice(0, -value.scale) + "." + digits.slice(-value.scale) : digits);
}
function compareDecimal(a, b) {
  decimalText(a); decimalText(b);
  const scale = Math.max(a.scale, b.scale);
  const x = BigInt(a.coefficient) * 10n ** BigInt(scale - a.scale);
  const y = BigInt(b.coefficient) * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
function subtractDecimal(a, b) {
  decimalText(a); decimalText(b);
  const scale = Math.max(a.scale, b.scale);
  const x = BigInt(a.coefficient) * 10n ** BigInt(scale - a.scale);
  const y = BigInt(b.coefficient) * 10n ** BigInt(scale - b.scale);
  return { coefficient: (x - y).toString(), scale };
}
function fixed9(value) {
  const n = integer(value, true);
  requireValue(BigInt(n) >= -9223372036854775808n && BigInt(n) < 9223372036854775807n, "INVALID_DBN_PRICE");
  return { coefficient: n, scale: 9 };
}
module.exports = { ContractError, requireValue, token, integer, timestamp, decimal, decimalText, compareDecimal, subtractDecimal, fixed9 };
