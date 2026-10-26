"use strict";

const MAX_ICEBERG_ID_LENGTH = 96;
const ICEBERG_KINDS = Object.freeze(["native", "probable"]);
const ICEBERG_CONFIDENCES = Object.freeze(["certain", "strong", "probable", "weak"]);
const ICEBERG_SIDES = Object.freeze(["bid", "ask"]);
const ICEBERG_STATUSES = Object.freeze(["active", "filled", "pulled", "replaced", "interrupted", "ended"]);
const ICEBERG_ORIGINS = Object.freeze(["runtime", "host"]);

module.exports = { MAX_ICEBERG_ID_LENGTH, ICEBERG_KINDS, ICEBERG_CONFIDENCES, ICEBERG_SIDES, ICEBERG_STATUSES, ICEBERG_ORIGINS };
