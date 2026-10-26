const PRICE_SUBUNITS_PER_UNIT = 100_000_000;

const PRICE_SUBUNIT_EXPR = "CAST(ROUND(CAST(price AS REAL) * 100000000) AS INTEGER)";

function toPriceSubunits(value, field, moduleName) {
  if (!Number.isFinite(value)) {
    throw new Error(`${moduleName}: ${field} must be a finite number`);
  }
  const scaled = Math.round(value * PRICE_SUBUNITS_PER_UNIT);
  if (!Number.isSafeInteger(scaled)) {
    throw new Error(`${moduleName}: ${field} is outside the representable price range`);
  }
  return scaled;
}

function floorDivExpr(numeratorExpr, divisorParam) {
  return `(((${numeratorExpr}) - ((${numeratorExpr}) % ${divisorParam})) / ${divisorParam}) - ` +
    `(CASE WHEN ((${numeratorExpr}) % ${divisorParam}) < 0 THEN 1 ELSE 0 END)`;
}

function bucketIndexOf(price, originPrice, rowWidth, moduleName) {
  const priceSubunits = toPriceSubunits(price, "price", moduleName);
  const originSubunits = toPriceSubunits(originPrice, "originPrice", moduleName);
  const rowWidthSubunits = toPriceSubunits(rowWidth, "rowWidth", moduleName);
  if (rowWidthSubunits <= 0) {
    throw new Error(`${moduleName}: rowWidth is finer than the representable price grid`);
  }
  return Math.floor((priceSubunits - originSubunits) / rowWidthSubunits);
}

module.exports = {
  PRICE_SUBUNITS_PER_UNIT,
  PRICE_SUBUNIT_EXPR,
  toPriceSubunits,
  floorDivExpr,
  bucketIndexOf,
};
