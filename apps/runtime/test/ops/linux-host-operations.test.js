const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "../../../..");
const hostOps = path.join(repositoryRoot, "ops", "linux-host");

function read(...parts) {
  return fs.readFileSync(path.join(hostOps, ...parts), "utf8");
}

describe("linux host operations", () => {
  test("historical L2 uses a separate bounded, loopback-only read service and cache", () => {
    const unit = read("systemd", "terminal-archive-l2-query.service");
    expect(unit).toContain("User=ttquery");
    expect(unit).toContain("--host 127.0.0.1 --port 8004");
    expect(unit).toContain("historical_l2_http.py");
    expect(unit).toContain("ReadWritePaths=/srv/terminal-data/query-cache/l2");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("CPUQuota=200%");
    expect(unit).toContain("MemoryMax=4G");
    expect(read("scripts", "prepare-query-role.sh")).toContain('install -d -o ttquery -g ttquery -m 700 "$root/query-cache/l2"');
    expect(read("systemd", "terminal-archive-gateway.service")).not.toContain("Wants=terminal-archive-l2-query");
  });
  test("historical L2 port is aligned across configuration and distinct from existing services", () => {
    const l2Port = /--port (\d+)/.exec(read("systemd", "terminal-archive-l2-query.service"))?.[1];
    const archivePort = /--port (\d+)/.exec(read("systemd", "terminal-archive-query.service"))?.[1];
    const livePort = /run-live-storage-service\.js (\d+)/.exec(read("systemd", "terminal-live-storage.service"))?.[1];
    const gatewayPort = /run-archive-gateway\.js (\d+)/.exec(read("systemd", "terminal-archive-gateway.service"))?.[1];
    const ports = [l2Port, archivePort, livePort, gatewayPort];
    expect(ports.every((port) => port !== undefined)).toBe(true);
    expect(new Set(ports).size).toBe(ports.length);
    expect(read("config", "gateway.env.example")).toContain(`TT_L2_ARCHIVE_SERVICE_URL=http://127.0.0.1:${l2Port}/query`);
    const entry = fs.readFileSync(path.join(repositoryRoot, "apps/runtime/conversion/historical_l2_http.py"), "utf8");
    expect(entry).toContain(`parser.add_argument("--port", type=int, default=${l2Port})`);
  });
  // The archive gateway shipped without TT_LOG_DIR and died on first start:
  // cli-logger falls back to <runtime root>/logs and tries to create it inside
  // the frozen, read-only release. Every unit whose executable is node needs the
  // log directory pointed at its LogsDirectory instead.
  test("every node-executed unit sends its logs outside the frozen release", () => {
    const unitDir = path.join(hostOps, "systemd");
    const nodeUnits = fs.readdirSync(unitDir)
      .filter((name) => name.endsWith(".service"))
      .filter((name) => {
        const exec = /^ExecStart=(\S+)/m.exec(read("systemd", name));
        return exec !== null && exec[1].endsWith("/node");
      });
    expect(nodeUnits.length).toBeGreaterThan(0);
    const wiring = nodeUnits.map((name) => {
      const unit = read("systemd", name);
      const logDir = /^Environment=TT_LOG_DIR=(\S+)$/m.exec(unit);
      const logsDirectory = /^LogsDirectory=(\S+)$/m.exec(unit);
      return {
        name,
        logDir: logDir === null ? null : logDir[1],
        expected: logsDirectory === null ? null : `/var/log/${logsDirectory[1]}`,
      };
    });
    expect(wiring.filter((u) => u.logDir === null)).toEqual([]);
    expect(wiring.filter((u) => u.expected === null)).toEqual([]);
    expect(wiring.filter((u) => u.logDir !== u.expected)).toEqual([]);
  });

  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

  (asRoot ? test : test.skip)("as root, the frozen-release verifier refuses to run and asks for a service account", () => {
    const result = spawnSync(process.execPath, [
      path.join(hostOps, "scripts", "verify-runtime.cjs"),
      path.join(repositoryRoot, "apps", "runtime"),
    ], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Run as a service account/);
  });

  (asRoot ? test.skip : test)("the frozen-release verifier is rooted at its argument and leaves no caller or temporary artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-host-ops-test-"));
    const cwd = path.join(root, "caller");
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(cwd);
    fs.mkdirSync(tmp);
    try {
      const result = spawnSync(process.execPath, [
        path.join(hostOps, "scripts", "verify-runtime.cjs"),
        path.join(repositoryRoot, "apps", "runtime"),
      ], {
        cwd,
        env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        result: "PASS",
        checks: expect.arrayContaining(["WAL write", "close/reopen persistence"]),
      });
      expect(fs.readdirSync(cwd)).toEqual([]);
      expect(fs.readdirSync(tmp)).toEqual([]);
      expect(fs.readdirSync(path.join(repositoryRoot, "apps", "runtime")).filter((name) => name.startsWith("sqlite-proof-"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the deployment and host configuration enforce the repaired contracts", () => {
    const deploy = read("scripts", "deploy.sh");
    const verifier = read("scripts", "verify-runtime.cjs");
    const checkEnv = read("scripts", "check-service-env.sh");
    const convertEnv = read("config", "convert.env.example");
    const queryEnv = read("config", "query.env.example");
    const monitoringEnv = read("config", "monitoring.env.example");
    const alertEnv = read("config", "alert-email.env.example");
    const alertUnit = read("systemd", "terminal-alert@.service");
    const backfillUnit = read("systemd", "terminal-backfill@.service");
    const queryUnit = read("systemd", "terminal-archive-query.service");
    const gatewayUnit = read("systemd", "terminal-archive-gateway.service");
    const gatewayEnv = read("config", "gateway.env.example");
    const liveStorageUnit = read("systemd", "terminal-live-storage.service");
    const liveStorageEnv = read("config", "live-storage.env.example");
    const queryRole = read("scripts", "prepare-query-role.sh");
    const archiveSources = JSON.parse(read("config", "archive-sources.json"));
    const prepare = read("scripts", "prepare-data-disk.sh");
    const provision = read("scripts", "provision-data-dirs.sh");
    const collectorSlice = read("systemd", "terminal.slice");
    const nodeInstaller = read("scripts", "install-node.sh");
    const installOps = read("scripts", "install-ops.sh");
    const l1Preflight = read("scripts", "run-l1-preflight.sh");

    expect(deploy).toContain('verify-runtime.cjs" "$release"');
    expect(verifier).toContain("process.argv[2]");
    expect(verifier).toContain("os.tmpdir()");
    expect(verifier).toContain("fs.rmSync(dir, { recursive: true, force: true })");
    expect(verifier).not.toContain("process.cwd()");
    for (const key of [
      "RCLONE_CONFIG_TTCONVERT_TYPE=s3",
      "RCLONE_CONFIG_TTCONVERT_PROVIDER=AWS",
      "RCLONE_CONFIG_TTCONVERT_REGION=eu-central-1",
      "RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID=",
      "RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY=",
    ]) expect(convertEnv).toContain(key);
    expect(checkEnv).toContain("RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY");
    for (const key of [
      "TT_QUERY_S3_REGION=eu-central-1",
      "TT_QUERY_S3_ACCESS_KEY_ID=",
      "TT_QUERY_S3_SECRET_ACCESS_KEY=",
      "TT_QUERY_SERVICE_SECRET=",
    ]) expect(queryEnv).toContain(key);
    expect(queryEnv).toContain("supervised and loopback-only");
    expect(queryEnv).not.toContain("does not provide a supervised gateway unit");
    expect(checkEnv).toContain("TT_QUERY_S3_SECRET_ACCESS_KEY");
    expect(checkEnv).toContain("TT_QUERY_SERVICE_SECRET");
    for (const key of [
      "TT_ARCHIVE_SERVICE_URL=http://127.0.0.1:8002/query",
      "TT_QUERY_SERVICE_SECRET=",
      "TT_ARCHIVE_CLIENT_TOKENS=",
    ]) expect(gatewayEnv).toContain(key);
    expect(checkEnv).toContain("required gateway setting is absent");
    // The convert profile must read the file it is given, never the ambient
    // environment: indirect expansion passes an empty file whose values happen
    // to be exported, and fails a correct file inspected from a plain shell.
    expect(checkEnv).toContain('"$file"');
    expect(checkEnv).not.toContain("${!name");
    expect(backfillUnit).toContain("service.env convert");
    expect(backfillUnit).toContain("--phase %i --bucket");
    expect(backfillUnit).not.toContain("--dataset-version w606-%i-v1");
    // A multi-day backfill resumes from its checkpoint, so a transient failure
    // should come back on its own. A rate limit cannot bound that on its own --
    // an attempt lasting longer than window/burst never trips it -- so the exit
    // status is the real bound: 2 permanent, 3 partial, both non-restartable.
    expect(backfillUnit).toContain("Restart=on-failure");
    expect(backfillUnit).not.toContain("Restart=no");
    expect(backfillUnit).toContain("RestartPreventExitStatus=2 3");
    // Parallelism is per symbol and the CLI defaults to one worker, so the pool
    // size only exists if the unit passes it. Measured on ES+NQ over
    // 2025-09-14..18: 1.99x against 4% per-symbol contention. Four workers is
    // not an option -- the preflight capacity gate needs ~1.82 TB for it.
    expect(backfillUnit).toContain("--pool-size 2");
    const window = Number(/StartLimitIntervalSec=(\d+)/.exec(backfillUnit)[1]);
    const burst = Number(/StartLimitBurst=(\d+)/.exec(backfillUnit)[1]);
    expect(window).toBeGreaterThanOrEqual(86400);
    expect(burst).toBeLessThanOrEqual(3);
    const binanceUnit = read("systemd", "terminal-backfill-binance@.service");
    expect(binanceUnit).toContain("--phase %i --bucket");
    expect(binanceUnit).toContain("--curated-prefix curated/binance --staging-root /srv/terminal-data/binance-staging");
    expect(binanceUnit).toContain("--curated-root /srv/terminal-data/curated-binance --catalog-root /srv/terminal-data/curated-binance/_catalog");
    expect(binanceUnit).not.toContain("curated/databento");
    expect(binanceUnit).toContain("--pool-size 4");
    expect(binanceUnit).toContain("RestartPreventExitStatus=2 3");
    expect(binanceUnit).toContain("TT_COLLECTOR_HEALTH_FILE=/run/terminal-l1-l2/collector-health.json");
    expect(binanceUnit).toContain("ReadWritePaths=/srv/terminal-data/binance-staging.sequence.guard");
    expect(installOps).toContain("terminal-backfill-binance@.service");
    expect(provision).toContain('install -d -o ttconvert -g ttconvert -m 700 "$target/binance-staging"');
    expect(provision).toContain('install -d -o ttconvert -g ttconvert -m 700 "$target/curated-binance"');
    expect(provision).toContain('"$target/binance-staging.sequence.guard"');
    expect(monitoringEnv).not.toContain("TT_ALERT_COMMAND=");
    expect(alertEnv).toContain("/etc/terminal-l1-l2/alert-email.env");
    expect(alertUnit).toContain("EnvironmentFile=-/etc/terminal-l1-l2/alert-email.env");
    expect(alertUnit).toContain("alert-optional");
    expect(prepare).toContain('install -d -o ttconvert -g ttconvert -m 700 "$target/curated"');
    expect(prepare).toContain('install -d -o ttconvert -g ttconvert -m 700 "$target/curated-staging"');
    expect(provision).toContain('install -d -o ttconvert -g ttconvert -m 700 "$target/curated"');
    expect(provision).toContain('install -d -o ttconvert -g ttconvert -m 700 "$target/curated-staging"');
    for (const line of ["CPUQuota=800%", "MemoryHigh=24G", "MemoryMax=32G", "TasksMax=512"]) {
      expect(collectorSlice).toContain(line);
    }
    expect(nodeInstaller).toContain("expected_sha256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6");
    expect(nodeInstaller).not.toContain("SHASUMS256.txt");
    expect(installOps).toContain("systemd-analyze verify");
    // A bare template unit is not a queryable name ("terminal-alert@.service is
    // neither a valid invocation ID nor unit name"), so the post-adoption
    // loadability check has to resolve templates through a synthetic instance.
    expect(installOps).toContain("query=${name/@./@probe.}");
    const unitList = installOps.match(/unit_names=\(\n([\s\S]*?)\n\)/);
    expect(unitList).not.toBeNull();
    const installedUnits = unitList[1].trim().split(/\s+/).sort();
    const trackedUnits = fs.readdirSync(path.join(hostOps, "systemd"))
      .filter((name) => /\.(?:service|timer|slice)$/.test(name))
      .sort();
    expect(installedUnits).toEqual(trackedUnits);
    expect(installOps).toContain("OPS_MANIFEST.sha256");
    expect(installOps).toContain("! -name OPS_MANIFEST.sha256");
    expect(installOps).toContain("run the reviewed source copy, not the active ops tree");
    expect(installOps).toContain("systemctl daemon-reload");
    expect(installOps).toContain(".deploy.lock");
    expect(installOps).toContain("status --porcelain -- ops/linux-host");
    expect(installOps).toContain("restore_managed_paths");
    expect(installOps).toContain("restore_active_ops");
    expect(installOps).toContain("installation_committed=1");
    expect(installOps).toContain("JOURNALD_RESTART_REQUIRED=1");
    // The preflight is a separate, bounded read-only gate: it gets the same
    // credential file and service identity but cannot start the L1 unit.
    expect(l1Preflight).toContain("systemd-run");
    expect(l1Preflight).toContain('User=$runtime_user');
    expect(l1Preflight).toContain('EnvironmentFile=$service_env');
    expect(l1Preflight).toContain('ReadWritePaths=$data_root/curated $data_root/curated-staging');
    expect(l1Preflight).toContain("preflight_l1.py");
    expect(l1Preflight).toContain("--expected-commit");
    expect(l1Preflight).not.toContain("systemctl start");
    // In a unit FILE, TimeoutStartSec=0 means "no timeout". As a systemd-run
    // transient property it means literally zero: systemd 249 resolves it to
    // TimeoutStartUSec=0 and kills the job in the same second it starts. The
    // preflight decodes ~110 GB and cannot run under a zero timeout.
    expect(l1Preflight).toContain("TimeoutStartSec=infinity");
    expect(l1Preflight).not.toContain("TimeoutStartSec=0");
    // The preflight writes its temporary source scans into _preflight itself,
    // not only into _preflight/reports. GNU install -d applies -o/-g/-m to the
    // final component only, so provisioning just the reports directory left
    // _preflight owned by root and the ttconvert-run gate could not mkdir in it.
    expect(l1Preflight).toContain('install -d -o "$runtime_user" -g "$runtime_user" -m 700 "$scan_dir"');

    // The query service issues snapshot tokens and signs cursors with
    // process-local state, so a second instance would hand out capabilities the
    // first cannot resolve. Exactly one process, and a bound on handler threads
    // because a threaded HTTP server starts one per connection.
    expect(queryUnit).toContain("Type=simple");
    expect(queryUnit).toContain("User=ttquery");
    expect(queryUnit).toContain("check-service-env.sh /etc/terminal-l1-l2/query/service.env query");
    expect(queryUnit).toContain("TasksMax=");
    expect(queryUnit).toContain("--host 127.0.0.1");
    // Curated data is the service's input, never its output. It writes only to
    // its own cache root, so a read path cannot mutate the archive it serves.
    expect(queryUnit).toContain("ReadOnlyPaths=/srv/terminal-data/curated");
    expect(queryUnit).toContain("ReadOnlyPaths=/srv/terminal-data/query-catalogs");
    expect(queryUnit).toContain("ReadWritePaths=/srv/terminal-data/query-cache");
    expect(queryUnit).toContain("--curated-prefix curated");
    expect(queryUnit).toContain("--sources-file /srv/terminal-data/query-catalogs/archive-sources.json");
    expect(queryUnit).toContain("test -r /srv/terminal-data/query-catalogs/archive-sources.json");
    expect(queryUnit).toContain("test -r /srv/terminal-data/query-catalogs/databento/CURRENT.json");
    expect(queryUnit).toContain("test -r /srv/terminal-data/query-catalogs/binance/CURRENT.json");
    expect(queryUnit).not.toContain("--catalog-root");
    expect(queryUnit).not.toContain("--cache-root");
    expect(queryUnit).not.toMatch(/ReadWritePaths=[^\n]*\/srv\/terminal-data\/curated(\s|$)/);
    expect(queryUnit).not.toMatch(/ReadWritePaths=[^\n]*\/srv\/terminal-data\/query-catalogs(\s|$)/);
    expect(queryUnit).toContain("ProtectSystem=strict");
    expect(queryUnit).toContain("NoNewPrivileges=yes");

    expect(gatewayUnit).toContain("User=ttgateway");
    expect(gatewayUnit).toContain("Group=ttgateway");
    expect(gatewayUnit).toContain("gateway/service.env gateway");
    expect(gatewayUnit).toMatch(/run-archive-gateway\.js 8001$/m);
    expect(gatewayUnit).not.toContain("run-archive-gateway.js 8001 127.0.0.1");
    expect(gatewayUnit).toContain("Environment=TT_ARCHIVE_GATEWAY_HOST=127.0.0.1");
    expect(gatewayUnit).toContain("IPAddressDeny=any");
    expect(gatewayUnit).toContain("IPAddressAllow=localhost");
    expect(gatewayUnit).toContain("IPAddressAllow=100.64.0.0/10");
    expect(gatewayUnit).toContain("IPAddressAllow=10.88.0.0/24");
    expect(gatewayUnit).toContain("InaccessiblePaths=/srv/terminal-data");
    expect(gatewayUnit).toContain("ProtectSystem=strict");
    expect(gatewayUnit).toContain("NoNewPrivileges=yes");
    expect(gatewayUnit).toContain("LogsDirectory=terminal-l1-l2/gateway");

    // Live capture has one writer. The companion service shares that identity
    // only to open the WAL database read-only, is loopback-confined, and must
    // prove that the real database is readable before Node starts.
    expect(liveStorageUnit).toContain("User=ttcollect");
    expect(liveStorageUnit).toContain("Group=ttcollect");
    expect(liveStorageUnit).toContain("live-storage/service.env live-storage");
    expect(liveStorageUnit).toContain("test -r /srv/terminal-data/capture/live/market-data.sqlite");
    expect(liveStorageUnit).toContain("ReadOnlyPaths=/srv/terminal-data/capture");
    expect(liveStorageUnit).toContain("IPAddressDeny=any");
    expect(liveStorageUnit).toContain("IPAddressAllow=localhost");
    expect(liveStorageUnit).toContain("TasksMax=");
    expect(liveStorageUnit).toContain("MemoryMax=");
    expect(liveStorageUnit).toMatch(/run-live-storage-service\.js 8003$/m);
    expect(liveStorageEnv).toContain("TT_LIVE_STORAGE_SERVICE_SECRET=");
    expect(checkEnv).toContain("required live-storage setting is absent");
    expect(gatewayEnv).toContain("TT_LIVE_STORAGE_INTERNAL_URL=http://127.0.0.1:8003");
    expect(gatewayEnv).toContain("TT_LIVE_STORAGE_SERVICE_SECRET=");

    // prepare-data-disk.sh created curated as 0700 ttconvert, so ttquery cannot
    // read the catalog without an explicit grant. The role script is the only
    // thing that closes that gap, and it must not grant write.
    expect(queryRole).toContain("install -d -o ttquery -g ttquery -m 700 \"$root/query-cache\"");
    expect(queryRole).toContain("install -d -o ttquery -g ttquery -m 700 \"$root/query-catalogs\"");
    expect(queryRole).toContain("install -d -o ttquery -g ttquery -m 700 \"$root/query-catalogs/databento\"");
    expect(queryRole).toContain("install -d -o ttquery -g ttquery -m 700 \"$root/query-catalogs/binance\"");
    expect(queryRole).toContain("sources_file=$script_dir/../config/archive-sources.json");
    expect(queryRole).toContain("install -o root -g ttquery -m 640 \"$sources_file\" \"$sources_tmp\"");
    expect(queryRole).toContain("mv -T \"$sources_tmp\" \"$root/query-catalogs/archive-sources.json\"");
    expect(queryRole).toContain("runuser -u ttquery -- test -r \"$root/query-catalogs/archive-sources.json\"");
    expect(queryRole).toContain("setfacl -R -m u:ttquery:rX \"$root/curated\"");
    expect(queryRole).toContain("! runuser -u ttquery -- test -w \"$root/curated\"");
    expect(queryRole).not.toMatch(/setfacl[^\n]*u:ttquery:[^\n]*w/);

    expect(archiveSources).toEqual({
      version: 1,
      sources: [
        {
          name: "databento",
          identities: ["XCME", "XNAS"],
          catalogRoot: "/srv/terminal-data/query-catalogs/databento",
          cacheRoot: "/srv/terminal-data/query-cache/databento",
        },
        {
          name: "binance",
          identities: ["BINANCE"],
          catalogRoot: "/srv/terminal-data/query-catalogs/binance",
          cacheRoot: "/srv/terminal-data/query-cache/binance",
        },
      ],
    });
  });

  // Report 49 P1i: the dxFeed collector moves from manual-start-only to a
  // weekday-scheduled, bounded-restart host service. It must still never
  // auto-start at boot -- only the two timers may start or stop it.
  test("the dxFeed collector is weekday-scheduled with a bounded restart envelope, not boot-persistent", () => {
    const dxfeedUnit = read("systemd", "terminal-dxfeed-collector.service");
    const startTimer = read("systemd", "terminal-dxfeed-collector-start.timer");
    const stopTimer = read("systemd", "terminal-dxfeed-collector-stop.timer");
    const stopService = read("systemd", "terminal-dxfeed-collector-stop.service");
    const checkEnv = read("scripts", "check-service-env.sh");

    expect(dxfeedUnit).toContain("Restart=on-failure");
    expect(dxfeedUnit).toContain("SuccessExitStatus=143");
    expect(dxfeedUnit).not.toContain("Restart=no");
    // Each restart requests a fresh token from the broker, whose rate limit
    // is real (a live HTTP 429 hit on 2026-09-17) -- restarts must be
    // spaced minutes apart, not Binance's 10s, regardless of what its own
    // envelope uses.
    const restartSec = Number(/^RestartSec=(\d+)$/m.exec(dxfeedUnit)[1]);
    const startLimitIntervalSec = Number(/StartLimitIntervalSec=(\d+)/.exec(dxfeedUnit)[1]);
    const startLimitBurst = Number(/StartLimitBurst=(\d+)/.exec(dxfeedUnit)[1]);
    expect(restartSec).toBeGreaterThanOrEqual(120);
    // The burst limit must still be reachable at that spacing -- otherwise
    // the "give up after N failures" backstop can never actually fire.
    expect(startLimitIntervalSec).toBeGreaterThanOrEqual((startLimitBurst - 1) * restartSec);
    // Never enable-able for boot: no [Install] section at all, only the
    // timers may start it.
    expect(dxfeedUnit).not.toMatch(/^\[Install\]$/m);
    expect(dxfeedUnit).not.toMatch(/^WantedBy=/m);
    expect(dxfeedUnit).toContain("check-service-env.sh /etc/terminal-l1-l2/collect/service.env dxfeed");

    expect(checkEnv).toContain("required dxfeed setting is absent");
    expect(checkEnv).toContain("TT_DXFEED_TOKEN_BROKER_URL");

    expect(startTimer).toContain("OnCalendar=Mon *-*-* 00:00:00 UTC");
    expect(startTimer).toContain("Unit=terminal-dxfeed-collector.service");
    expect(startTimer).toContain("Persistent=false");
    expect(startTimer).toContain("[Install]");
    expect(startTimer).toContain("WantedBy=timers.target");

    expect(stopTimer).toContain("OnCalendar=Sat *-*-* 00:00:00 UTC");
    expect(stopTimer).toContain("Unit=terminal-dxfeed-collector-stop.service");
    expect(stopTimer).toContain("Persistent=false");
    expect(stopTimer).toContain("[Install]");
    expect(stopTimer).toContain("WantedBy=timers.target");

    expect(stopService).toContain("Type=oneshot");
    expect(stopService).toContain("ExecStart=/usr/bin/systemctl stop terminal-dxfeed-collector.service");
    // systemctl stop blocks until the target unit's own stop job finishes,
    // so this oneshot's timeout must exceed the collector's TimeoutStopSec
    // or a normal slow graceful shutdown reports here as a false failure.
    const collectorStopTimeoutSec = Number(/TimeoutStopSec=(\d+)/.exec(dxfeedUnit)[1]);
    const stopActionTimeoutSec = Number(/TimeoutStartSec=(\d+)/.exec(stopService)[1]);
    expect(stopActionTimeoutSec).toBeGreaterThan(collectorStopTimeoutSec);
  });
});

// Report 57 W2, FA-10: live-storage reads the collectors' SQLite files, and
// the kernel charges the page cache those reads create to the service's
// cgroup. With MemoryHigh at 512M (process memory about 270 MB) the host
// recorded 4.3 million memory.high events and about 4 % of wall time fully
// stalled on reclaim while idle. The ceiling must leave room for the cache.
describe("live-storage memory envelope (FA-10)", () => {
  const unit = read("systemd", "terminal-live-storage.service");
  const bytes = (value) => {
    const match = /^(\d+)([KMG])?$/.exec(value);
    return Number(match[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2]] ?? 1);
  };
  const setting = (name) => unit.match(new RegExp(`^${name}=(\\S+)$`, "m"))?.[1];

  test("MemoryHigh leaves at least 1.5 GiB above the service's own memory for the database page cache", () => {
    expect(bytes(setting("MemoryHigh"))).toBeGreaterThanOrEqual(2 * 1024 ** 3);
    expect(bytes(setting("MemoryMax"))).toBeGreaterThan(bytes(setting("MemoryHigh")));
  });
});

describe("report 57 W5: rollback selects an existing release the way deploy.sh activates one", () => {
  test("select-release.sh takes the deploy lock, only selects a frozen release under releases/, swaps current atomically, records previous and never deletes", () => {
    const select = read("scripts", "select-release.sh");
    const deploy = read("scripts", "deploy.sh");
    expect(select.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n")).toBe(true);
    expect(select).toContain('test "$(id -u)" = 0');
    expect(select).toContain('exec 9>"$opt_root/.deploy.lock"');
    expect(deploy).toContain('exec 9>"$opt_root/.deploy.lock"');
    expect(select).toContain('"$opt_root"/releases/*) : ;;');
    expect(select).toContain('test -f "$release/RELEASE_METADATA"');
    expect(select).toContain('-not -user root');
    expect(select).toContain('mv -T "$tmp_link" "$opt_root/current"');
    expect(select).toContain('mv -T "$prev_tmp" "$opt_root/previous"');
    expect(select).toContain("Running services keep their code until they are restarted.");
    expect(select).not.toMatch(/\brm -rf\b/);
    expect(select).not.toMatch(/systemctl/);
    expect(select).not.toMatch(/^\s*#(?!!)/m);
  });
});

describe("report 57 FA-12: alerts leave the host and a stalled capture raises one", () => {
  test("the alert unit loads the optional webhook env after the email env, fail-closed on its permissions", () => {
    const alertUnit = read("systemd", "terminal-alert@.service");
    expect(alertUnit.indexOf("EnvironmentFile=-/etc/terminal-l1-l2/alert-webhook.env"))
      .toBeGreaterThan(alertUnit.indexOf("EnvironmentFile=-/etc/terminal-l1-l2/alert-email.env"));
    expect(alertUnit).toContain("check-service-env.sh /etc/terminal-l1-l2/alert-webhook.env alert-optional");
    expect(read("config", "alert-webhook.env.example")).toContain("TT_ALERT_COMMAND=/opt/terminal-l1-l2/ops/scripts/send-alert-webhook.py");
    expect(read("scripts", "send-alert-webhook.py")).toMatch(/parsed\.scheme != 'https'/);
  });

  test("the capture freshness check is installed, scheduled and escalates on failure", () => {
    const unit = read("systemd", "terminal-capture-freshness.service");
    expect(unit).toContain("OnFailure=terminal-alert@%n.service");
    expect(unit).toContain("ExecStart=/opt/terminal-l1-l2/ops/scripts/check-capture-freshness.sh");
    expect(read("systemd", "terminal-capture-freshness.timer")).toContain("OnUnitActiveSec=2min");
    const installer = read("scripts", "install-ops.sh");
    expect(installer).toContain("terminal-capture-freshness.service");
    expect(installer).toContain("terminal-capture-freshness.timer");
    const script = read("scripts", "check-capture-freshness.sh");
    expect(script).toContain('"recoveryAgeMs"');
    expect(script).toContain('"collectorStatus"');
    expect(script).toContain('capture recovery stalled');
  });
});

describe("capture retention and capacity stops", () => {
  test("the retention job runs daily as the capture user on the capture data only, and escalates on failure", () => {
    const unit = read("systemd", "terminal-capture-retention.service");
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("User=ttcollect");
    expect(unit).toContain("OnFailure=terminal-alert@%n.service");
    expect(unit).toContain("RequiresMountsFor=/srv/terminal-data");
    expect(unit).toContain("Environment=TT_DATA_ROOT=/srv/terminal-data/capture");
    expect(unit).toMatch(/^ReadWritePaths=\/srv\/terminal-data\/capture$/m);
    expect(unit).not.toContain("EnvironmentFile=");
    expect(unit).toContain("scripts/maintain/prune-capture-retention.js --target all --days 21 --max-seconds 5400");
    const maxSeconds = Number(/--max-seconds (\d+)/.exec(unit)[1]);
    const timeout = Number(/^TimeoutStartSec=(\d+)$/m.exec(unit)[1]);
    expect(timeout).toBeGreaterThan(maxSeconds);
    const timer = read("systemd", "terminal-capture-retention.timer");
    expect(timer).toContain("OnCalendar=*-*-* 03:30:00 UTC");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=terminal-capture-retention.service");
    const unitList = read("scripts", "install-ops.sh").match(/unit_names=\(\n([\s\S]*?)\n\)/)[1].split("\n").map((line) => line.trim());
    expect(unitList).toEqual(expect.arrayContaining(["terminal-capture-retention.service", "terminal-capture-retention.timer"]));
  });

  test("a collector stopped at its capacity limit is not restarted into the same full database", () => {
    const { CAPACITY_STOP_EXIT_CODE } = require("../../src/storage/collector-capacity-guard");
    for (const name of ["terminal-collector.service", "terminal-dxfeed-collector.service"]) {
      const unit = read("systemd", name);
      expect(unit).toContain("Restart=on-failure");
      expect(unit).toMatch(new RegExp(`^RestartPreventExitStatus=${CAPACITY_STOP_EXIT_CODE}$`, "m"));
      expect(unit).toContain("OnFailure=terminal-alert@%n.service");
    }
  });

  test("the capture export runs before retention, writes only its own state and reads its keys from a systemd credential", () => {
    const unit = read("systemd", "terminal-capture-export.service");
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("User=ttcollect");
    expect(unit).toContain("OnFailure=terminal-alert@%n.service");
    expect(unit).toContain("RequiresMountsFor=/srv/terminal-data");
    expect(unit).toContain("StateDirectory=terminal-l1-l2/capture-export");
    expect(unit).toContain("LoadCredential=s3:/etc/terminal-l1-l2/capture-export/s3.credentials");
    expect(unit).toMatch(/^ReadWritePaths=\/srv\/terminal-data\/capture$/m);
    expect(unit).not.toContain("EnvironmentFile=");
    expect(unit).toContain("conversion/capture_export.py --bucket chartprime-historical-data");
    expect(unit).toContain("--watermark /var/lib/terminal-l1-l2/capture-export/watermark.json");
    expect(unit).toContain("--credentials ${CREDENTIALS_DIRECTORY}/s3");
    const maxSeconds = Number(/--max-seconds (\d+)/.exec(unit)[1]);
    const timeout = Number(/^TimeoutStartSec=(\d+)$/m.exec(unit)[1]);
    expect(timeout).toBeGreaterThan(maxSeconds);
    const timer = read("systemd", "terminal-capture-export.timer");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=terminal-capture-export.service");
    const exportHour = Number(/^OnCalendar=\*-\*-\* (\d\d):\d\d:\d\d UTC$/m.exec(timer)[1]);
    const retentionHour = Number(/^OnCalendar=\*-\*-\* (\d\d):\d\d:\d\d UTC$/m.exec(read("systemd", "terminal-capture-retention.timer"))[1]);
    expect(exportHour * 3600 + maxSeconds).toBeLessThan(retentionHour * 3600);
    const retention = read("systemd", "terminal-capture-retention.service");
    expect(retention).toContain("--export-watermark /var/lib/terminal-l1-l2/capture-export/watermark.json");
    const unitList = read("scripts", "install-ops.sh").match(/unit_names=\(\n([\s\S]*?)\n\)/)[1].split("\n").map((line) => line.trim());
    expect(unitList).toEqual(expect.arrayContaining(["terminal-capture-export.service", "terminal-capture-export.timer"]));
  });
});
