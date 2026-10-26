const { checkConfig } = require("../../../scripts/verify/check-config");

describe("check-config (pre-deploy check of a host env file)", () => {
  test("a valid collector file passes and names the process", () => {
    const { ok, lines } = checkConfig(["collector", "--env-file", "/etc/terminal-l1-l2/collect/service.env"], {
      readFile: () => "TT_MAX_DB_BYTES=429496729600\nTT_MIN_FREE_DISK_BYTES=21474836480\nTT_DXFEED_TOKEN_BROKER_URL=https://broker.tail1.ts.net\n",
    });
    expect(ok).toBe(true);
    expect(lines).toEqual(["ok   collector: every setting it reads is valid in /etc/terminal-l1-l2/collect/service.env"]);
  });

  test("a bad value fails with the setting named and the value withheld", () => {
    const { ok, lines } = checkConfig(["gateway", "--env-file", "gateway.env"], {
      readFile: () => "TT_ARCHIVE_SERVICE_URL=not-a-url-withheld\nTT_QUERY_SERVICE_SECRET=s\nTT_ARCHIVE_GATEWAY_PORTT=8001\n",
    });
    expect(ok).toBe(false);
    expect(lines).toEqual([
      "FAIL TT_ARCHIVE_SERVICE_URL must be an absolute http(s) URL",
      "WARN TT_ARCHIVE_GATEWAY_PORTT is not a setting any process reads; check the spelling",
      "gateway would refuse to start: 1 invalid setting(s)",
    ]);
    expect(lines.join("\n")).not.toContain("not-a-url-withheld");
  });

  test("an unknown process or stray argument is a usage error", () => {
    expect(() => checkConfig(["nobody"])).toThrow(/usage/);
    expect(() => checkConfig(["gateway", "--verbose"])).toThrow(/usage/);
  });
});
