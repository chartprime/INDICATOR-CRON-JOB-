#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DOC_ROOTS = [path.join(ROOT, "README.md"), path.join(ROOT, "docs"), path.join(ROOT, "ops", "linux-host", "README.md"), path.join(ROOT, "config", "README.md")];
const errors = [];
const TRANSIENT_ROOTS = new Set(["data", "logs", "run", "backups"].map((name) => path.join("apps", "runtime", name)));

function filesUnder(target, predicate = () => true) {
  if (TRANSIENT_ROOTS.has(path.relative(ROOT, target))) return [];
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return predicate(target) ? [target] : [];
  if (["node_modules", ".git", "releases", ".pytest_cache", ".venv", "__pycache__"].includes(path.basename(target))) return [];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    return entry.isDirectory() ? filesUnder(child, predicate) : (predicate(child) ? [child] : []);
  });
}

const markdownFiles = DOC_ROOTS.flatMap((target) => filesUnder(target, (file) => file.endsWith(".md")));
const packageFiles = filesUnder(ROOT, (file) => path.basename(file) === "package.json" && !file.includes(`${path.sep}node_modules${path.sep}`));
const scripts = new Set(packageFiles.flatMap((file) => Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).scripts ?? {})));
const unitRoot = path.join(ROOT, "ops", "linux-host", "systemd");
const units = new Set(filesUnder(unitRoot).map((file) => path.basename(file)));
const implementationCorpus = filesUnder(ROOT, (file) => {
  const relative = path.relative(ROOT, file);
  if (relative.startsWith(`docs${path.sep}`) || relative.includes(`${path.sep}node_modules${path.sep}`) || relative.startsWith(`.git${path.sep}`)) return false;
  return !/package-lock\.json$/.test(file) && /\.(?:js|cjs|ts|tsx|py|sh|json|service|timer|example|md)$/.test(file);
}).map((file) => {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}).join("\n");

function normalizeUnit(name) {
  if (units.has(name)) return name;
  const at = name.indexOf("@");
  const suffix = name.endsWith(".timer") ? ".timer" : ".service";
  if (at !== -1) return `${name.slice(0, at + 1)}${suffix}`;
  return name;
}

for (const file of markdownFiles) {
  const text = fs.readFileSync(file, "utf8");
  const relative = path.relative(ROOT, file).replaceAll(path.sep, "/");

  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#", 1)[0]);
    if (!target) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) errors.push(`${relative}: broken local link ${raw}`);
  }

  for (const match of text.matchAll(/npm run ([a-zA-Z0-9:._-]+)/g)) {
    if (!scripts.has(match[1])) errors.push(`${relative}: unknown npm script ${match[1]}`);
  }

  for (const match of text.matchAll(/`(terminal-[a-zA-Z0-9@_.-]+\.(?:service|timer))`/g)) {
    const normalized = normalizeUnit(match[1]);
    if (!units.has(normalized)) errors.push(`${relative}: unknown systemd unit ${match[1]}`);
  }

  if (file.endsWith("-evidence.md") && !text.includes("Historical implementation evidence")) {
    errors.push(`${relative}: missing historical-evidence banner`);
  }

  if (relative === "README.md" || relative === "config/README.md" || relative === "ops/linux-host/README.md" || relative.startsWith("docs/operations/")) {
    for (const match of text.matchAll(/\b(?:TT|VITE|L2|DXFEED|RCLONE)_[A-Z0-9_]+\b/g)) {
      if (!implementationCorpus.includes(match[0])) errors.push(`${relative}: undocumented environment variable ${match[0]}`);
    }
  }
}

const forbidden = [
  "archive query contract and its local service are implemented but are not deployed",
  "hosted activation remains deferred",
  "backfill:dxfeed-large-trade-baseline",
  "all 4 dxFeed instruments",
];
for (const phrase of forbidden) {
  for (const file of markdownFiles) {
    if (fs.readFileSync(file, "utf8").toLowerCase().includes(phrase.toLowerCase())) {
      errors.push(`${path.relative(ROOT, file)}: forbidden stale wording: ${phrase}`);
    }
  }
}

const { CONFIG_REGISTRY, describeExpected } = require(path.join(ROOT, "apps", "runtime", "src", "platform", "config-registry.js"));
const configGuidePath = path.join(ROOT, "docs", "operations", "09-configuration.md");
const configGuide = fs.existsSync(configGuidePath) ? fs.readFileSync(configGuidePath, "utf8") : "";
const configRows = new Set(configGuide.split(/\r?\n/).filter((line) => line.startsWith("| `")));
const registered = new Set(CONFIG_REGISTRY.map((item) => item.name));
for (const item of CONFIG_REGISTRY) {
  const row = `| \`${item.name}\` | ${item.processes.join(", ")} | ${describeExpected(item)} | ${item.secret ? "yes" : ""} | ${item.where} | ${item.doc} |`;
  if (!configRows.has(row)) errors.push(`docs/operations/09-configuration.md: row for ${item.name} is missing or differs from config-registry.js`);
}
for (const row of configRows) {
  const name = /^\| `([^`]+)`/.exec(row)[1];
  if (!registered.has(name)) errors.push(`docs/operations/09-configuration.md: ${name} is not in config-registry.js`);
}

for (const file of markdownFiles) {
  const relative = path.relative(ROOT, file).replaceAll(path.sep, "/");
  for (const match of fs.readFileSync(file, "utf8").matchAll(/ops\/linux-host\/scripts\/([A-Za-z0-9_.-]+)/g)) {
    if (!fs.existsSync(path.join(ROOT, "ops", "linux-host", "scripts", match[1]))) errors.push(`${relative}: unknown host script ops/linux-host/scripts/${match[1]}`);
  }
}

const accessGuide = fs.readFileSync(path.join(ROOT, "docs", "operations", "02-developer-access.md"), "utf8");
if (!accessGuide.includes("TT_LIVE_STORAGE_SERVICE_URL=http://10.88.0.1:8001/live-storage")) {
  errors.push("docs/operations/02-developer-access.md: live-storage gateway URL must include /live-storage");
}

if (errors.length) {
  console.error(`Documentation validation failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation validation passed (${markdownFiles.length} Markdown files, ${scripts.size} npm scripts, ${units.size} host units).`);
}
