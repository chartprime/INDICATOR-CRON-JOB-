"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const access = require("../../../../ops/linux-host/scripts/developer-access.cjs");
const { createArchiveAuth } = require("../../src/server/archive-auth");

const WG = "/etc/wireguard/wg0.conf";
const GATEWAY = "/etc/terminal-l1-l2/gateway/service.env";
const REGISTRY = "/etc/terminal-l1-l2/access/developers.tsv";

function key() {
  return crypto.randomBytes(32).toString("base64");
}

const OWNER_KEY = key();
const SERVER_KEY = key();

const HOST_WG_CONF = [
  "[Interface]",
  "Address = 10.88.0.1/24",
  "ListenPort = 51820",
  "PrivateKey = SERVERPRIVATEKEYSTAYSONTHEHOSTxxxxxxxxxxxxx=",
  "",
  "[Peer]",
  `PublicKey = ${OWNER_KEY}`,
  "AllowedIPs = 10.88.0.2/32",
  "",
].join("\n");

const HOST_GATEWAY_ENV = [
  "TT_ARCHIVE_SERVICE_URL=http://127.0.0.1:8002/query",
  "TT_QUERY_SERVICE_SECRET=service-secret-never-touched-by-this-tool",
  "TT_ARCHIVE_CLIENT_TOKENS=terminal-web:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,operator:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "TT_ARCHIVE_GATEWAY_HOST=10.88.0.1",
  "TT_LIVE_STORAGE_INTERNAL_URL=http://127.0.0.1:8003",
  "TT_LIVE_STORAGE_SERVICE_SECRET=live-secret-never-touched-by-this-tool",
  "",
].join("\n");

function tokensOf(envText) {
  return /^TT_ARCHIVE_CLIENT_TOKENS=(.*)$/m.exec(envText)[1];
}

function fakeSystem(files = {}, overrides = {}) {
  const store = new Map(Object.entries({ [WG]: HOST_WG_CONF, [GATEWAY]: HOST_GATEWAY_ENV, ...files }));
  const log = [];
  const output = [];
  const locks = new Set();
  const system = {
    store,
    log,
    output,
    readFile: (file) => store.get(file) ?? "",
    exists: (file) => store.has(file),
    writeFileAtomic: (file, text) => {
      log.push(["write", file]);
      store.set(file, text);
    },
    backup: (file, stamp) => {
      log.push(["backup", file]);
      store.set(`${file}.bak-${stamp}`, store.get(file));
      return `${file}.bak-${stamp}`;
    },
    lock: (file) => {
      if (locks.has(file)) throw new access.AccessError("lock held");
      locks.add(file);
      return () => locks.delete(file);
    },
    isRoot: () => true,
    serverPublicKey: () => SERVER_KEY,
    handshakes: () => new Map([[OWNER_KEY, 1_790_000_000]]),
    publicAddress: () => "203.0.113.10",
    syncWireGuard: (iface, conf) => log.push(["syncconf", iface, conf]),
    restartGateway: (unit) => log.push(["restart", unit]),
    gatewayReady: async (host, port) => {
      log.push(["ready", host, port]);
      return true;
    },
    probeBearer: async (host, port, secret) => {
      log.push(["probe", host, port]);
      return createArchiveAuth({ clientTokens: tokensOf(store.get(GATEWAY)) }).identify(`Bearer ${secret}`) ? 200 : 401;
    },
    today: () => "2026-09-22",
    stamp: () => "20260922T120000Z",
    out: (text) => output.push(text),
    ...overrides,
  };
  return system;
}

function issueArgs(name, publicKey, ...extra) {
  return ["issue", name, publicKey, ...extra];
}

function printedSecret(output) {
  const text = output.join("\n");
  const match = /one-time secret link: the gateway bearer ---\n(\S+)\n/.exec(text);
  return match ? match[1] : null;
}

describe("developer-access: validation", () => {
  test.each(["A", "a", "sam_x", "1sam", "sam.x", "x".repeat(32)])("refuses the name %p", (name) => {
    expect(() => access.validateName(name)).toThrow(access.AccessError);
  });

  test.each(["sam", "sam-2", "ab"])("accepts the name %p", (name) => {
    expect(access.validateName(name)).toBe(name);
  });

  test("refuses a public key that is not 32 bytes of base64", () => {
    expect(() => access.validatePublicKey("not-a-key")).toThrow(access.AccessError);
    expect(() => access.validatePublicKey(`${key().slice(0, 42)}==`)).toThrow(access.AccessError);
    expect(access.validatePublicKey(OWNER_KEY)).toBe(OWNER_KEY);
  });
});

describe("developer-access: planning an issue", () => {
  const state = { wgConf: HOST_WG_CONF, gatewayEnv: HOST_GATEWAY_ENV, registry: "" };

  test("takes the next free address after the server and the owner's hand-made peer", () => {
    const plan = access.planIssue(state, { name: "sam", publicKey: key(), today: "2026-09-22", secret: "s".repeat(48) });
    expect(plan.address).toBe("10.88.0.3/32");
    expect(plan.clientId).toBe("dev-sam");
    expect(plan.reviewBy).toBe("2026-12-21");
  });

  test("the peer block is appended whole and the hand-made peer is left exactly as it was", () => {
    const publicKey = key();
    const plan = access.planIssue(state, { name: "sam", publicKey, today: "2026-09-22", secret: "s".repeat(48) });
    expect(plan.wgConf.startsWith(HOST_WG_CONF.trimEnd())).toBe(true);
    expect(plan.wgConf.endsWith([
      "# BEGIN developer-access sam",
      "[Peer]",
      `PublicKey = ${publicKey}`,
      "AllowedIPs = 10.88.0.3/32",
      "# END developer-access sam",
      "",
    ].join("\n"))).toBe(true);
    const parsed = access.parseWgConf(plan.wgConf);
    expect(parsed.peers.map((peer) => [peer.allowedIps[0], peer.managedName])).toEqual([["10.88.0.2/32", null], ["10.88.0.3/32", "sam"]]);
  });

  test("only the token line changes, and the gateway's own parser accepts the new bearer as dev-sam", () => {
    const secret = access.generateSecret();
    const plan = access.planIssue(state, { name: "sam", publicKey: key(), today: "2026-09-22", secret });
    const before = HOST_GATEWAY_ENV.split("\n");
    const after = plan.gatewayEnv.split("\n");
    expect(after.filter((line, index) => line !== before[index])).toEqual([
      `TT_ARCHIVE_CLIENT_TOKENS=terminal-web:${"a".repeat(32)},operator:${"b".repeat(32)},dev-sam:${secret}`,
    ]);
    const auth = createArchiveAuth({ clientTokens: tokensOf(plan.gatewayEnv) });
    expect(auth.identify(`Bearer ${secret}`)).toBe("dev-sam");
    expect(auth.identify(`Bearer ${"a".repeat(32)}`)).toBe("terminal-web");
  });

  test("a generated secret is long, random and a valid bearer", () => {
    const first = access.generateSecret();
    expect(first.length).toBeGreaterThanOrEqual(24);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(access.generateSecret()).not.toBe(first);
  });

  test("a quoted token value keeps its quotes", () => {
    const quoted = HOST_GATEWAY_ENV.replace(/^TT_ARCHIVE_CLIENT_TOKENS=(.*)$/m, 'TT_ARCHIVE_CLIENT_TOKENS="$1"');
    const plan = access.planIssue({ ...state, gatewayEnv: quoted }, { name: "sam", publicKey: key(), today: "2026-09-22", secret: "s".repeat(48) });
    expect(plan.gatewayEnv).toMatch(/^TT_ARCHIVE_CLIENT_TOKENS="terminal-web:.*,dev-sam:s{48}"$/m);
  });

  test("CRLF files stay CRLF", () => {
    const crlf = { wgConf: HOST_WG_CONF.replace(/\n/g, "\r\n"), gatewayEnv: HOST_GATEWAY_ENV.replace(/\n/g, "\r\n"), registry: "" };
    const plan = access.planIssue(crlf, { name: "sam", publicKey: key(), today: "2026-09-22", secret: "s".repeat(48) });
    expect(plan.wgConf.replace(/\r\n/g, "")).not.toMatch(/\n/);
    expect(plan.gatewayEnv.replace(/\r\n/g, "")).not.toMatch(/\n/);
  });

  test("refuses an active name, a known key, and an existing token", () => {
    const first = access.planIssue(state, { name: "sam", publicKey: key(), today: "2026-09-22", secret: "s".repeat(48) });
    const next = { wgConf: first.wgConf, gatewayEnv: first.gatewayEnv, registry: first.registry };
    expect(() => access.planIssue(next, { name: "sam", publicKey: key(), today: "2026-09-22", secret: "t".repeat(48) })).toThrow(/already has active access/);
    expect(() => access.planIssue(state, { name: "kim", publicKey: OWNER_KEY, today: "2026-09-22", secret: "t".repeat(48) })).toThrow(/already a peer/);
    const tokenOnly = { ...state, gatewayEnv: first.gatewayEnv };
    expect(() => access.planIssue(tokenOnly, { name: "sam", publicKey: key(), today: "2026-09-22", secret: "t".repeat(48) })).toThrow(/already has a gateway token/);
  });

  test("an explicit review date is validated", () => {
    expect(() => access.planIssue(state, { name: "sam", publicKey: key(), reviewBy: "soon", today: "2026-09-22", secret: "s".repeat(48) })).toThrow(/YYYY-MM-DD/);
    const plan = access.planIssue(state, { name: "sam", publicKey: key(), reviewBy: "2026-10-01", today: "2026-09-22", secret: "s".repeat(48) });
    expect(plan.reviewBy).toBe("2026-10-01");
  });
});

describe("developer-access: planning a revoke", () => {
  function issued(name, base = { wgConf: HOST_WG_CONF, gatewayEnv: HOST_GATEWAY_ENV, registry: "" }) {
    const plan = access.planIssue(base, { name, publicKey: key(), today: "2026-09-22", secret: `${name}${"s".repeat(40)}` });
    return { wgConf: plan.wgConf, gatewayEnv: plan.gatewayEnv, registry: plan.registry };
  }

  test("removes the peer and the token together and leaves everything else as it was", () => {
    const state = issued("sam");
    const plan = access.planRevoke(state, { name: "sam", today: "2026-09-30" });
    expect(plan.peerRemoved).toBe(true);
    expect(plan.tokenRemoved).toBe(true);
    expect(plan.wgConf).toBe(HOST_WG_CONF);
    expect(plan.gatewayEnv).toBe(HOST_GATEWAY_ENV);
    expect(access.parseRegistry(plan.registry)).toEqual([expect.objectContaining({ name: "sam", status: "revoked", revoked_at: "2026-09-30" })]);
  });

  test("revoking one developer leaves another developer's access intact", () => {
    const both = issued("kim", issued("sam"));
    const plan = access.planRevoke(both, { name: "sam", today: "2026-09-30" });
    const peers = access.parseWgConf(plan.wgConf).peers;
    expect(peers.map((peer) => peer.managedName)).toEqual([null, "kim"]);
    expect(access.clientIdsIn(plan.gatewayEnv)).toEqual(["terminal-web", "operator", "dev-kim"]);
  });

  test("an address is never handed out again after its developer is revoked", () => {
    const revoked = access.planRevoke(issued("sam"), { name: "sam", today: "2026-09-30" });
    const again = access.planIssue(
      { wgConf: revoked.wgConf, gatewayEnv: revoked.gatewayEnv, registry: revoked.registry },
      { name: "sam", publicKey: key(), today: "2026-10-01", secret: "n".repeat(48) },
    );
    expect(again.address).toBe("10.88.0.4/32");
  });

  test("a name with nothing to revoke is refused, and hand-made peers are never touched", () => {
    expect(() => access.planRevoke({ wgConf: HOST_WG_CONF, gatewayEnv: HOST_GATEWAY_ENV, registry: "" }, { name: "agha", today: "2026-09-30" })).toThrow(/no developer access/);
  });

  test("a half-written block is refused rather than guessed at", () => {
    const state = issued("sam");
    const broken = { ...state, wgConf: state.wgConf.replace("# END developer-access sam\n", "") };
    expect(() => access.planRevoke(broken, { name: "sam", today: "2026-09-30" })).toThrow(/without its END line/);
  });
});

describe("developer-access: the real system layer", () => {
  test("syncconf gets a private file holding exactly the stripped config, never /dev/stdin, and the file is gone afterwards", () => {
    const calls = [];
    let seen = null;
    const runCommand = (command, args) => {
      calls.push([command, ...args]);
      if (command === "wg-quick") return "stripped-config\n";
      const file = args[2];
      seen = { file, content: fs.readFileSync(file, "utf8"), exists: fs.existsSync(file) };
      return "";
    };
    access.createSystem({ runCommand }).syncWireGuard("wg0", "/etc/wireguard/wg0.conf");
    expect(calls[0]).toEqual(["wg-quick", "strip", "/etc/wireguard/wg0.conf"]);
    expect(calls[1].slice(0, 3)).toEqual(["wg", "syncconf", "wg0"]);
    expect(seen.file).not.toBe("/dev/stdin");
    expect(seen).toMatchObject({ content: "stripped-config\n", exists: true });
    expect(fs.existsSync(seen.file)).toBe(false);
  });

  test("the stripped config, which holds the server private key, is deleted even when syncconf fails", () => {
    let file = null;
    const runCommand = (command, args) => {
      if (command === "wg-quick") return "stripped-config\n";
      file = args[2];
      throw new access.AccessError("wg syncconf failed");
    };
    expect(() => access.createSystem({ runCommand }).syncWireGuard("wg0", "/etc/wireguard/wg0.conf")).toThrow(/syncconf failed/);
    expect(file).not.toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("developer-access: the command", () => {
  test("refuses to run as a normal user", async () => {
    const system = fakeSystem({}, { isRoot: () => false });
    await expect(access.main(issueArgs("sam", key()), system)).rejects.toThrow(/run as root/);
  });

  test("a dry run writes nothing, restarts nothing and prints no bearer", async () => {
    const system = fakeSystem();
    await access.main(["--dry-run", ...issueArgs("sam", key())], system);
    expect(system.log).toEqual([]);
    const text = system.output.join("\n");
    expect(text).toContain("dry run: issue sam as dev-sam at 10.88.0.3/32");
    expect(text).toContain("Endpoint = 203.0.113.10:51820");
    expect(printedSecret(system.output)).toBeNull();
  });

  test("issue backs up, writes, syncs WireGuard, restarts the gateway, waits, probes, then records", async () => {
    const system = fakeSystem();
    await access.main(issueArgs("sam", key()), system);
    expect(system.log.map((entry) => entry.slice(0, 2).join(" "))).toEqual([
      `backup ${WG}`, `write ${WG}`,
      `backup ${GATEWAY}`, `write ${GATEWAY}`,
      "syncconf wg0",
      "restart terminal-archive-gateway.service",
      "ready 10.88.0.1",
      `write ${REGISTRY}`,
      "probe 10.88.0.1",
    ]);
    const secret = printedSecret(system.output);
    expect(secret).not.toBeNull();
    expect(createArchiveAuth({ clientTokens: tokensOf(system.store.get(GATEWAY)) }).identify(`Bearer ${secret}`)).toBe("dev-sam");
    const text = system.output.join("\n");
    expect(text.split(secret)).toHaveLength(2);
    expect(text).toContain(`PublicKey = ${SERVER_KEY}`);
    expect(text).toContain("AllowedIPs = 10.88.0.1/32");
    expect(text).not.toContain("warning");
    expect(access.parseRegistry(system.store.get(REGISTRY))).toEqual([
      expect.objectContaining({ name: "sam", client_id: "dev-sam", address: "10.88.0.3/32", status: "active" }),
    ]);
    expect(system.store.get(REGISTRY)).not.toContain(secret);
  });

  test("a gateway that does not come back restores both files and is restarted on the old ones", async () => {
    const system = fakeSystem({}, { gatewayReady: async () => false });
    await expect(access.main(issueArgs("sam", key()), system)).rejects.toThrow(/did not report ready.*previous files were restored/);
    expect(system.store.get(WG)).toBe(HOST_WG_CONF);
    expect(system.store.get(GATEWAY)).toBe(HOST_GATEWAY_ENV);
    expect(system.store.has(REGISTRY)).toBe(false);
    expect(system.log.filter((entry) => entry[0] === "restart")).toHaveLength(2);
    expect(system.log.filter((entry) => entry[0] === "syncconf")).toHaveLength(2);
  });

  test("a held lock stops a second run before anything is written", async () => {
    const system = fakeSystem();
    const release = system.lock(REGISTRY);
    await expect(access.main(issueArgs("sam", key()), system)).rejects.toThrow(/lock held/);
    release();
    expect(system.log).toEqual([]);
  });

  test("revoke removes both and restarts the gateway; list reports the history and the hand-made peer", async () => {
    const system = fakeSystem();
    await access.main(issueArgs("sam", key()), system);
    system.log.length = 0;
    system.output.length = 0;
    await access.main(["revoke", "sam"], system);
    expect(system.store.get(WG)).toBe(HOST_WG_CONF);
    expect(system.store.get(GATEWAY)).toBe(HOST_GATEWAY_ENV);
    expect(system.log.map((entry) => entry[0])).toEqual(["backup", "write", "backup", "write", "syncconf", "restart", "ready", "write"]);
    system.output.length = 0;
    await access.main(["list"], system);
    const text = system.output.join("\n");
    expect(text).toMatch(/^sam\tdev-sam\t10\.88\.0\.3\/32\trevoked\t2026-09-22\t/m);
    expect(text).toContain("1 peer(s) in /etc/wireguard/wg0.conf are not managed by this tool: 10.88.0.2/32");
  });

  test("note records layer-2 access for an active developer", async () => {
    const system = fakeSystem();
    await access.main(issueArgs("sam", key()), system);
    await access.main(["note", "sam", "tailscale", "broker", "granted", "2026-09-22"], system);
    expect(access.parseRegistry(system.store.get(REGISTRY))[0].note).toBe("tailscale broker granted 2026-09-22");
  });

  test("paths can be pointed at copies", () => {
    const { options } = access.parseArgs(["--wg-conf", "/tmp/wg.conf", "--gateway-env", "/tmp/g.env", "--registry", "/tmp/r.tsv", "--no-apply", "list"]);
    expect(options).toMatchObject({ wgConf: "/tmp/wg.conf", gatewayEnv: "/tmp/g.env", registry: "/tmp/r.tsv", apply: false });
    expect(path.isAbsolute(access.DEFAULTS.registry)).toBe(true);
  });
});
