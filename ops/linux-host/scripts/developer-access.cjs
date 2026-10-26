'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULTS = Object.freeze({
  wgConf: '/etc/wireguard/wg0.conf',
  wgInterface: 'wg0',
  gatewayEnv: '/etc/terminal-l1-l2/gateway/service.env',
  registry: '/etc/terminal-l1-l2/access/developers.tsv',
  gatewayUnit: 'terminal-archive-gateway.service',
  gatewayPort: 8001,
  reviewDays: 90,
});
const TOKENS_VARIABLE = 'TT_ARCHIVE_CLIENT_TOKENS';
const GATEWAY_HOST_VARIABLE = 'TT_ARCHIVE_GATEWAY_HOST';
const CLIENT_PREFIX = 'dev-';
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const REGISTRY_COLUMNS = Object.freeze([
  'name', 'client_id', 'address', 'public_key', 'issued_at', 'review_by', 'status', 'revoked_at', 'note',
]);
const PROBE_BODY = JSON.stringify({
  contractVersion: 'archive-query/1',
  instrumentId: JSON.stringify(['BINANCE', 'SPOT', 'BTCUSDT', 'USDT', 'COIN']),
  family: 'candle_1d',
  from: String(BigInt(Date.UTC(2026, 7, 3)) * 1_000_000n),
  to: String(BigInt(Date.UTC(2026, 7, 6)) * 1_000_000n),
  limit: 1,
});

class AccessError extends Error {}

function beginMarker(name) {
  return `# BEGIN developer-access ${name}`;
}

function endMarker(name) {
  return `# END developer-access ${name}`;
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function validateName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new AccessError('name must be 2-31 characters: a lowercase letter, then lowercase letters, digits or hyphens');
  }
  return name;
}

function validatePublicKey(key) {
  if (typeof key !== 'string' || !PUBLIC_KEY_PATTERN.test(key) || Buffer.from(key, 'base64').length !== 32) {
    throw new AccessError('public key must be a WireGuard public key: 44 base64 characters ending in =');
  }
  return key;
}

function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new AccessError('dates must be YYYY-MM-DD');
  }
  return value;
}

function parseWgConf(text) {
  const result = { interfaceAddress: null, listenPort: null, peers: [] };
  let section = null;
  let managed = null;
  let peer = null;
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    const begin = /^# BEGIN developer-access (\S+)$/.exec(line);
    if (begin) managed = begin[1];
    if (/^# END developer-access \S+$/.test(line)) managed = null;
    if (line === '[Interface]') {
      section = 'interface';
      peer = null;
      continue;
    }
    if (line === '[Peer]') {
      section = 'peer';
      peer = { publicKey: null, allowedIps: [], managedName: managed };
      result.peers.push(peer);
      continue;
    }
    const setting = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line);
    if (!setting) continue;
    const [, key, value] = setting;
    if (section === 'interface' && key === 'Address') result.interfaceAddress = value.split(',')[0].trim();
    if (section === 'interface' && key === 'ListenPort') result.listenPort = Number(value);
    if (section === 'peer' && key === 'PublicKey') peer.publicKey = value.trim();
    if (section === 'peer' && key === 'AllowedIPs') {
      peer.allowedIps.push(...value.split(',').map((entry) => entry.trim()).filter(Boolean));
    }
  }
  return result;
}

function subnetOf(interfaceAddress) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/24$/.exec(interfaceAddress ?? '');
  if (!match) throw new AccessError('wg0.conf [Interface] Address must be an IPv4 /24, for example 10.88.0.1/24');
  return { prefix: `${match[1]}.${match[2]}.${match[3]}`, server: Number(match[4]) };
}

function nextAddress(conf, registryRows) {
  const { prefix, server } = subnetOf(conf.interfaceAddress);
  const used = new Set([server]);
  const hostOf = (cidr) => {
    const match = /^(\d+\.\d+\.\d+)\.(\d+)(?:\/32)?$/.exec(cidr);
    return match && match[1] === prefix ? Number(match[2]) : null;
  };
  for (const peer of conf.peers) for (const cidr of peer.allowedIps) used.add(hostOf(cidr));
  for (const row of registryRows) used.add(hostOf(row.address));
  for (let host = 2; host <= 254; host += 1) {
    if (!used.has(host)) return `${prefix}.${host}/32`;
  }
  throw new AccessError(`no free peer address left in ${prefix}.0/24`);
}

function addPeerBlock(text, { name, publicKey, address }) {
  const eol = eolOf(text);
  const body = text.replace(/(\r?\n)*$/, '');
  const block = [beginMarker(name), '[Peer]', `PublicKey = ${publicKey}`, `AllowedIPs = ${address}`, endMarker(name)];
  return `${body}${eol}${eol}${block.join(eol)}${eol}`;
}

function removePeerBlock(text, name) {
  const eol = eolOf(text);
  const lines = splitLines(text);
  const start = lines.findIndex((line) => line.trim() === beginMarker(name));
  if (start === -1) return { text, removed: false };
  const end = lines.findIndex((line, index) => index > start && line.trim() === endMarker(name));
  if (end === -1) throw new AccessError(`wg0.conf has ${beginMarker(name)} without its END line; fix it by hand`);
  let from = start;
  while (from > 0 && lines[from - 1].trim() === '') from -= 1;
  const kept = [...lines.slice(0, from), ...lines.slice(end + 1)];
  const joined = kept.join(eol).replace(/(\r?\n)*$/, '');
  return { text: `${joined}${eol}`, removed: true };
}

function tokenLine(text) {
  const lines = splitLines(text);
  const indexes = lines
    .map((line, index) => (new RegExp(`^\\s*${TOKENS_VARIABLE}=`).test(line) ? index : -1))
    .filter((index) => index !== -1);
  if (indexes.length !== 1) throw new AccessError(`the gateway env must define ${TOKENS_VARIABLE} exactly once`);
  const index = indexes[0];
  const raw = lines[index].replace(new RegExp(`^\\s*${TOKENS_VARIABLE}=`), '');
  const quote = /^(["'])(.*)\1$/.exec(raw);
  return { lines, index, quote: quote ? quote[1] : '', value: quote ? quote[2] : raw };
}

function parseTokenEntries(value) {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf(':');
    if (separator <= 0) throw new AccessError(`${TOKENS_VARIABLE} holds an entry that is not clientId:secret`);
    return { clientId: entry.slice(0, separator), secret: entry.slice(separator + 1) };
  });
}

function clientIdsIn(text) {
  return parseTokenEntries(tokenLine(text).value).map((entry) => entry.clientId);
}

function writeTokenLine(text, parsed, entries) {
  const eol = eolOf(text);
  const lines = [...parsed.lines];
  const value = entries.map((entry) => `${entry.clientId}:${entry.secret}`).join(',');
  lines[parsed.index] = `${TOKENS_VARIABLE}=${parsed.quote}${value}${parsed.quote}`;
  return lines.join(eol);
}

function addToken(text, clientId, secret) {
  const parsed = tokenLine(text);
  const entries = parseTokenEntries(parsed.value);
  if (entries.some((entry) => entry.clientId === clientId)) throw new AccessError(`${clientId} already has a gateway token`);
  return writeTokenLine(text, parsed, [...entries, { clientId, secret }]);
}

function removeToken(text, clientId) {
  const parsed = tokenLine(text);
  const entries = parseTokenEntries(parsed.value);
  const kept = entries.filter((entry) => entry.clientId !== clientId);
  if (kept.length === entries.length) return { text, removed: false };
  return { text: writeTokenLine(text, parsed, kept), removed: true };
}

function envValue(text, name) {
  for (const line of splitLines(text)) {
    const match = new RegExp(`^\\s*${name}=(.*)$`).exec(line);
    if (match) return match[1].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return null;
}

function parseRegistry(text) {
  if (!text) return [];
  const lines = splitLines(text).filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];
  if (lines[0] !== REGISTRY_COLUMNS.join('\t')) throw new AccessError('the access registry header is not the expected one');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(REGISTRY_COLUMNS.map((column, index) => [column, cells[index] ?? '']));
  });
}

function formatRegistry(rows) {
  const clean = (cell) => String(cell ?? '').replace(/[\t\r\n]/g, ' ');
  return `${[REGISTRY_COLUMNS.join('\t'), ...rows.map((row) => REGISTRY_COLUMNS.map((column) => clean(row[column])).join('\t'))].join('\n')}\n`;
}

function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function planIssue(state, { name, publicKey, reviewBy, note = '', today, secret }) {
  validateName(name);
  validatePublicKey(publicKey);
  const clientId = `${CLIENT_PREFIX}${name}`;
  const rows = parseRegistry(state.registry);
  if (rows.some((row) => row.name === name && row.status === 'active')) throw new AccessError(`${name} already has active access; revoke it first`);
  const conf = parseWgConf(state.wgConf);
  if (conf.peers.some((peer) => peer.publicKey === publicKey)) throw new AccessError('that public key is already a peer on this interface');
  if (conf.peers.some((peer) => peer.managedName === name)) throw new AccessError(`wg0.conf already holds a block for ${name}; revoke it first`);
  if (clientIdsIn(state.gatewayEnv).includes(clientId)) throw new AccessError(`${clientId} already has a gateway token; revoke it first`);
  const address = nextAddress(conf, rows);
  const review = reviewBy === undefined ? addDays(today, DEFAULTS.reviewDays) : validateDate(reviewBy);
  const row = {
    name, client_id: clientId, address, public_key: publicKey, issued_at: today,
    review_by: review, status: 'active', revoked_at: '', note,
  };
  return {
    clientId,
    address,
    reviewBy: review,
    wgConf: addPeerBlock(state.wgConf, { name, publicKey, address }),
    gatewayEnv: addToken(state.gatewayEnv, clientId, secret),
    registry: formatRegistry([...rows, row]),
  };
}

function planRevoke(state, { name, today }) {
  validateName(name);
  const clientId = `${CLIENT_PREFIX}${name}`;
  const rows = parseRegistry(state.registry);
  const peer = removePeerBlock(state.wgConf, name);
  const token = removeToken(state.gatewayEnv, clientId);
  const active = rows.some((row) => row.name === name && row.status === 'active');
  if (!peer.removed && !token.removed && !active) throw new AccessError(`${name} has no developer access to revoke`);
  const updated = rows.map((row) => (row.name === name && row.status === 'active'
    ? { ...row, status: 'revoked', revoked_at: today }
    : row));
  return {
    clientId,
    peerRemoved: peer.removed,
    tokenRemoved: token.removed,
    wgConf: peer.text,
    gatewayEnv: token.text,
    registry: formatRegistry(updated),
  };
}

function planNote(state, { name, note }) {
  validateName(name);
  const rows = parseRegistry(state.registry);
  if (!rows.some((row) => row.name === name && row.status === 'active')) throw new AccessError(`${name} has no active access`);
  return {
    registry: formatRegistry(rows.map((row) => (row.name === name && row.status === 'active' ? { ...row, note } : row))),
  };
}

function tunnelSettings({ address, serverPublicKey, endpoint, gatewayAddress }) {
  return [
    '[Interface]',
    '# keep the PrivateKey line your WireGuard app generated',
    `Address = ${address}`,
    '',
    '[Peer]',
    `PublicKey = ${serverPublicKey}`,
    `Endpoint = ${endpoint}`,
    `AllowedIPs = ${gatewayAddress}/32`,
    'PersistentKeepalive = 25',
  ].join('\n');
}

function generateSecret() {
  return crypto.randomBytes(36).toString('base64url');
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, dryRun: false, apply: true, endpoint: null };
  const positional = [];
  const valued = {
    '--wg-conf': 'wgConf', '--wg-interface': 'wgInterface', '--gateway-env': 'gatewayEnv',
    '--registry': 'registry', '--endpoint': 'endpoint', '--review-by': 'reviewBy', '--note': 'note',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-apply') options.apply = false;
    else if (Object.hasOwn(valued, arg)) {
      if (argv[index + 1] === undefined) throw new AccessError(`${arg} needs a value`);
      options[valued[arg]] = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--')) throw new AccessError(`unknown option ${arg}`);
    else positional.push(arg);
  }
  const [command, ...rest] = positional;
  return { command, rest, options };
}

const USAGE = [
  'usage: developer-access.sh [options] issue <name> <wireguard-public-key> [--review-by YYYY-MM-DD] [--note TEXT]',
  '       developer-access.sh [options] revoke <name>',
  '       developer-access.sh [options] note <name> <text>',
  '       developer-access.sh [options] list',
  'options: --dry-run  --no-apply  --wg-conf PATH  --wg-interface NAME  --gateway-env PATH  --registry PATH  --endpoint HOST:PORT',
].join('\n');

function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', input });
  if (result.error) throw new AccessError(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new AccessError(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function httpRequest({ host, port, method, pathname, headers = {}, body }) {
  return new Promise((resolve) => {
    const request = http.request({ host, port, method, path: pathname, headers, timeout: 5_000 }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve(null));
    if (body) request.write(body);
    request.end();
  });
}

function syncWireGuardWith(runCommand, iface, confPath, tempRoot = os.tmpdir()) {
  const stripped = runCommand('wg-quick', ['strip', confPath]);
  const directory = fs.mkdtempSync(path.join(tempRoot, 'developer-access-'));
  const file = path.join(directory, `${iface}.conf`);
  try {
    fs.writeFileSync(file, stripped, { mode: 0o600 });
    runCommand('wg', ['syncconf', iface, file]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function createSystem({ runCommand = run } = {}) {
  return {
    readFile: (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''),
    exists: (file) => fs.existsSync(file),
    writeFileAtomic(file, text) {
      const directory = path.dirname(file);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const existing = fs.existsSync(file) ? fs.statSync(file) : null;
      const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`);
      fs.writeFileSync(temporary, text, { mode: 0o600 });
      if (existing) {
        fs.chmodSync(temporary, existing.mode & 0o777);
        fs.chownSync(temporary, existing.uid, existing.gid);
      }
      fs.renameSync(temporary, file);
    },
    backup(file, stamp) {
      if (!fs.existsSync(file)) return null;
      const target = `${file}.bak-${stamp}`;
      fs.copyFileSync(file, target);
      fs.chmodSync(target, 0o600);
      return target;
    },
    lock(file) {
      const lockFile = `${file}.lock`;
      fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
      let handle;
      try {
        handle = fs.openSync(lockFile, 'wx', 0o600);
      } catch {
        throw new AccessError(`${lockFile} exists: another developer-access run holds it, or a crashed run left it; remove it only if no run is active`);
      }
      return () => {
        fs.closeSync(handle);
        fs.rmSync(lockFile, { force: true });
      };
    },
    isRoot: () => typeof process.getuid === 'function' && process.getuid() === 0,
    serverPublicKey: (iface) => runCommand('wg', ['show', iface, 'public-key']).trim(),
    handshakes(iface) {
      const out = runCommand('wg', ['show', iface, 'latest-handshakes']);
      return new Map(out.split('\n').filter(Boolean).map((line) => {
        const [key, at] = line.split('\t');
        return [key, Number(at)];
      }));
    },
    publicAddress() {
      const out = runCommand('ip', ['-4', 'route', 'get', '1.1.1.1']);
      const match = /\bsrc (\d+\.\d+\.\d+\.\d+)/.exec(out);
      if (!match) throw new AccessError('cannot work out the public address; pass --endpoint HOST:PORT');
      return match[1];
    },
    syncWireGuard: (iface, confPath) => syncWireGuardWith(runCommand, iface, confPath),
    restartGateway: (unit) => runCommand('systemctl', ['restart', unit]),
    async gatewayReady(host, port, timeoutMs = 30_000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (await httpRequest({ host, port, method: 'GET', pathname: '/health' }) === 200) return true;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return false;
    },
    probeBearer: (host, port, secret) => httpRequest({
      host, port, method: 'POST', pathname: '/archive/query', body: PROBE_BODY,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(PROBE_BODY) },
    }),
    today: () => new Date().toISOString().slice(0, 10),
    stamp: () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'),
    out: (text) => process.stdout.write(`${text}\n`),
  };
}

function describeChange(label, before, after) {
  if (before === after) return `  ${label}: unchanged`;
  const old = new Set(splitLines(before));
  const changed = splitLines(after).filter((line) => !old.has(line)).length;
  return `  ${label}: would change (${changed} new or edited line${changed === 1 ? '' : 's'})`;
}

async function commitChanges(system, options, plan, { restart }) {
  const stamp = system.stamp();
  const state = {
    wgConf: system.readFile(options.wgConf),
    gatewayEnv: system.readFile(options.gatewayEnv),
  };
  const backups = [];
  const touched = [];
  try {
    for (const [file, text, before] of [
      [options.wgConf, plan.wgConf, state.wgConf],
      [options.gatewayEnv, plan.gatewayEnv, state.gatewayEnv],
    ]) {
      if (text === undefined || text === before) continue;
      backups.push(system.backup(file, stamp));
      system.writeFileAtomic(file, text);
      touched.push({ file, before });
    }
    if (options.apply && plan.wgConf !== undefined && plan.wgConf !== state.wgConf) {
      system.syncWireGuard(options.wgInterface, options.wgConf);
    }
    if (options.apply && restart && plan.gatewayEnv !== undefined && plan.gatewayEnv !== state.gatewayEnv) {
      system.restartGateway(options.gatewayUnit);
      const host = envValue(plan.gatewayEnv, GATEWAY_HOST_VARIABLE) || '127.0.0.1';
      if (!await system.gatewayReady(host, options.gatewayPort)) throw new AccessError('the gateway did not report ready within 30 s');
    }
  } catch (error) {
    for (const { file, before } of touched.reverse()) system.writeFileAtomic(file, before);
    if (options.apply) {
      try {
        if (touched.some((entry) => entry.file === options.wgConf)) system.syncWireGuard(options.wgInterface, options.wgConf);
        if (restart && touched.some((entry) => entry.file === options.gatewayEnv)) system.restartGateway(options.gatewayUnit);
      } catch (rollbackError) {
        throw new AccessError(`${error.message}; restoring the previous files succeeded but re-applying them failed: ${rollbackError.message}`);
      }
    }
    throw new AccessError(`${error.message}; the previous files were restored`);
  }
  if (plan.registry !== undefined) system.writeFileAtomic(options.registry, plan.registry);
  return backups.filter(Boolean);
}

async function main(argv, system = createSystem()) {
  const { command, rest, options } = parseArgs(argv);
  if (!['issue', 'revoke', 'note', 'list'].includes(command)) throw new AccessError(USAGE);
  if (!system.isRoot()) throw new AccessError('run as root (sudo): this reads and edits root-only files');
  const state = {
    wgConf: system.readFile(options.wgConf),
    gatewayEnv: system.readFile(options.gatewayEnv),
    registry: system.readFile(options.registry),
  };
  if (!state.wgConf) throw new AccessError(`${options.wgConf} is missing or empty`);
  if (!state.gatewayEnv) throw new AccessError(`${options.gatewayEnv} is missing or empty`);
  const today = system.today();

  if (command === 'list') {
    const rows = parseRegistry(state.registry);
    const handshakes = options.apply ? system.handshakes(options.wgInterface) : new Map();
    system.out(['name\tclient_id\taddress\tstatus\tissued\treview_by\tlast_handshake\tnote',
      ...rows.map((row) => {
        const at = handshakes.get(row.public_key);
        const seen = at ? new Date(at * 1000).toISOString() : 'never';
        return [row.name, row.client_id, row.address, row.status, row.issued_at, row.review_by, row.status === 'active' ? seen : '-', row.note].join('\t');
      })].join('\n'));
    const unmanaged = parseWgConf(state.wgConf).peers.filter((peer) => peer.managedName === null);
    if (unmanaged.length > 0) {
      system.out(`\n${unmanaged.length} peer(s) in ${options.wgConf} are not managed by this tool: ${unmanaged.map((peer) => peer.allowedIps.join(',')).join(' ')}`);
    }
    return 0;
  }

  if (command === 'note') {
    const [name, ...words] = rest;
    if (!name || words.length === 0) throw new AccessError(USAGE);
    const plan = planNote(state, { name, note: words.join(' ') });
    if (options.dryRun) {
      system.out(`dry run: would set the note for ${name}`);
      return 0;
    }
    const release = system.lock(options.registry);
    try {
      system.writeFileAtomic(options.registry, plan.registry);
    } finally {
      release();
    }
    system.out(`note recorded for ${name}`);
    return 0;
  }

  if (command === 'revoke') {
    const [name] = rest;
    if (!name || rest.length !== 1) throw new AccessError(USAGE);
    const plan = planRevoke(state, { name, today });
    if (options.dryRun) {
      system.out([`dry run: revoke ${name} (${plan.clientId})`,
        `  WireGuard peer: ${plan.peerRemoved ? 'would be removed' : 'not found'}`,
        `  gateway token: ${plan.tokenRemoved ? 'would be removed, then the gateway restarted' : 'not found'}`,
        '  registry: would be marked revoked'].join('\n'));
      return 0;
    }
    const release = system.lock(options.registry);
    try {
      await commitChanges(system, options, plan, { restart: true });
    } finally {
      release();
    }
    system.out([`Revoked ${name}: WireGuard peer ${plan.peerRemoved ? 'removed' : 'was not present'}, gateway token ${plan.tokenRemoved ? 'removed' : 'was not present'}.`,
      'Ask them to delete the tunnel and the bearer from their .env.'].join('\n'));
    return 0;
  }

  const [name, publicKey] = rest;
  if (!name || !publicKey || rest.length !== 2) throw new AccessError(USAGE);
  const secret = generateSecret();
  const plan = planIssue(state, { name, publicKey, reviewBy: options.reviewBy, note: options.note ?? '', today, secret });
  const conf = parseWgConf(state.wgConf);
  const gatewayAddress = conf.interfaceAddress.split('/')[0];
  const endpoint = options.endpoint ?? `${system.publicAddress()}:${conf.listenPort ?? 51820}`;
  const serverPublicKey = system.serverPublicKey(options.wgInterface);
  if (options.dryRun) {
    system.out([`dry run: issue ${name} as ${plan.clientId} at ${plan.address}, review by ${plan.reviewBy}`,
      describeChange(options.wgConf, state.wgConf, plan.wgConf),
      describeChange(options.gatewayEnv, state.gatewayEnv, plan.gatewayEnv),
      `  ${options.registry}: would add one row`,
      '  then: wg syncconf (no tunnel drops), restart the gateway, wait for ready, check the new bearer',
      '', 'Tunnel settings the developer would receive:', tunnelSettings({ address: plan.address, serverPublicKey, endpoint, gatewayAddress })].join('\n'));
    return 0;
  }
  const release = system.lock(options.registry);
  try {
    await commitChanges(system, options, plan, { restart: true });
    if (options.apply) {
      const host = envValue(plan.gatewayEnv, GATEWAY_HOST_VARIABLE) || '127.0.0.1';
      const status = await system.probeBearer(host, options.gatewayPort, secret);
      if (status !== 200) {
        system.out(`warning: the new bearer's probe answered ${status ?? 'nothing'}; access is issued, check with npm run doctor from the developer's laptop`);
      }
    }
  } finally {
    release();
  }
  system.out([
    `Issued ${name} (${plan.clientId}) at ${plan.address}, review by ${plan.reviewBy}.`,
    '',
    '--- 1. Send in chat: tunnel settings (not secret) ---',
    tunnelSettings({ address: plan.address, serverPublicKey, endpoint, gatewayAddress }),
    '',
    '--- 2. Send ONLY through a one-time secret link: the gateway bearer ---',
    secret,
    '',
    'This is the only time it is shown; the host keeps it only in the root-only gateway env. They put it in both',
    'VITE_ARCHIVE_CLIENT_TOKEN and TT_LIVE_STORAGE_CLIENT_TOKEN, then run npm run doctor.',
  ].join('\n'));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`developer-access: ${error.message}\n`);
    process.exitCode = error instanceof AccessError ? 2 : 1;
  });
}

module.exports = {
  AccessError,
  createSystem,
  DEFAULTS,
  REGISTRY_COLUMNS,
  validateName,
  validatePublicKey,
  parseWgConf,
  nextAddress,
  addPeerBlock,
  removePeerBlock,
  addToken,
  removeToken,
  clientIdsIn,
  parseRegistry,
  formatRegistry,
  planIssue,
  planRevoke,
  planNote,
  tunnelSettings,
  generateSecret,
  parseArgs,
  main,
};
