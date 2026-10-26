const APPROVED_HOST = "tools.dxfeed.com";
const APPROVED_ENDPOINTS = new Map([
  ["/dxlink-chartprime", "realtime"],
  ["/dxlink-chartprimedelayed", "delayed"],
]);
const REALTIME_ENDPOINT = `wss://${APPROVED_HOST}/dxlink-chartprime`;
const DELAYED_ENDPOINT = `wss://${APPROVED_HOST}/dxlink-chartprimedelayed`;
const TOKEN_SHAPE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 2048;
const REQUIRED_VARS = ["DXFEED_ENDPOINT", "DXFEED_TEMP_TOKEN", "MARKET_DATA_MODE"];

function isBlank(value) {
  return typeof value !== "string" || value.trim().length === 0;
}

function describeRejectedCategories(url, expectedMode) {
  const problems = [];
  if (url.protocol !== "wss:") problems.push("protocol");
  if (url.host !== APPROVED_HOST) problems.push("host");
  if (!expectedMode) problems.push("path");
  if (url.username !== "" || url.password !== "") problems.push("embedded credentials");
  if (url.search !== "") problems.push("query string");
  if (url.hash !== "") problems.push("fragment");
  return problems.join(", ");
}

function assertApprovedEndpoint(rawEndpoint) {
  let url;
  try {
    url = new URL(rawEndpoint);
  } catch {
    throw new Error("dxfeed-connection-config: invalid DXFEED_ENDPOINT, refusing to connect");
  }
  const expectedMode = APPROVED_ENDPOINTS.get(url.pathname);
  if (
    url.protocol !== "wss:" ||
    url.host !== APPROVED_HOST ||
    !expectedMode ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `dxfeed-connection-config: unapproved DXFEED_ENDPOINT, refusing to connect (mismatched: ${describeRejectedCategories(url, expectedMode)})`,
    );
  }
  return { endpoint: `wss://${APPROVED_HOST}${url.pathname}`, expectedMode };
}

function assertApprovedToken(rawToken) {
  if (typeof rawToken !== "string") {
    throw new Error("dxfeed-connection-config: invalid DXFEED_TEMP_TOKEN shape, refusing to connect");
  }
  if (rawToken.length > MAX_TOKEN_LENGTH || !TOKEN_SHAPE_PATTERN.test(rawToken)) {
    throw new Error("dxfeed-connection-config: invalid DXFEED_TEMP_TOKEN shape, refusing to connect");
  }
  return rawToken;
}

function isApprovedEndpointModePair(endpoint, marketDataMode) {
  return (
    (endpoint === REALTIME_ENDPOINT && marketDataMode === "realtime") ||
    (endpoint === DELAYED_ENDPOINT && marketDataMode === "delayed")
  );
}

function loadDxFeedConfig(environment = process.env) {
  const missing = REQUIRED_VARS.filter((name) => isBlank(environment[name]));
  if (missing.length > 0) {
    throw new Error(`dxfeed-connection-config: missing required config: ${missing.join(", ")}`);
  }
  const approved = assertApprovedEndpoint(environment.DXFEED_ENDPOINT);
  const tempToken = assertApprovedToken(environment.DXFEED_TEMP_TOKEN);
  if (environment.MARKET_DATA_MODE !== approved.expectedMode) {
    throw new Error(
      `dxfeed-connection-config: DXFEED_ENDPOINT and MARKET_DATA_MODE disagree; expected ${approved.expectedMode}`,
    );
  }
  return {
    endpoint: approved.endpoint,
    marketDataMode: approved.expectedMode,
    tempToken,
  };
}

module.exports = {
  loadDxFeedConfig,
  assertApprovedToken,
  isApprovedEndpointModePair,
  REALTIME_ENDPOINT,
  DELAYED_ENDPOINT,
};
