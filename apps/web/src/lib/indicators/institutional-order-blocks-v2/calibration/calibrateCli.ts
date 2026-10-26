import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FrameIdentity } from "../../../../types/frames";
import { bandRowsFor, wallSizeFor } from "../institutionalV2Rules";
import { calibrate, type Calibration } from "./calibrateWalls";
import { decodeStoreColumns, type LiquidityStore } from "./storeColumns";

const INSTRUMENTS: Record<string, { symbol: string } & FrameIdentity> = {
  PERPETUAL_BTCUSDT: { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL" },
  SPOT_BTCUSDT: { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" },
  PERPETUAL_ETHUSDT: { symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" },
  SPOT_ETHUSDT: { symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT" },
  FUTURE_NQU26_XCME: { symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE" },
  FUTURE_ESU26_XCME: { symbol: "/ESU26:XCME", provider: "DXFEED", assetClass: "FUTURE" },
  EQUITY_AAPL: { symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" },
  EQUITY_NVDA: { symbol: "NVDA", provider: "DXFEED", assetClass: "EQUITY" },
  EQUITY_TSLA: { symbol: "TSLA", provider: "DXFEED", assetClass: "EQUITY" },
};

const OPTIONS = { horizonMs: 30 * 60_000, warmUpMs: 10 * 60_000, sampleMs: 60_000 };
const SHARES = [0.25, 0.5, 0.75, 1, 1.5, 2];

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : "-");
const num = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "-");

function row(label: string, size: number, c: Calibration): string {
  return `| ${label} | ${num(size, 0)} | ${c.walls} | ${c.strong} | ${pct(c.reversed, c.strong)} | ${pct(c.broke, c.strong)} | ${pct(c.flat, c.strong)} |`;
}

export function main(dir: string): void {
  const files = new Set(readdirSync(dir));
  console.log(`Institutional Order Blocks v2 calibration over ${dir}`);
  console.log(`Horizon ${OPTIONS.horizonMs / 60_000} min; a strong wall counts as reversed when price is at least the instrument's median ${OPTIONS.horizonMs / 60_000}-minute move in its favour by then.\n`);
  for (const [name, identity] of Object.entries(INSTRUMENTS)) {
    if (!files.has(`${name}.json`)) {
      console.log(`## ${name}: no store\n`);
      continue;
    }
    const store = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as LiquidityStore;
    const { columns, rowWidth, columnMs } = decodeStoreColumns(store);
    const spanH = columns.length > 1 ? (columns[columns.length - 1].ts - columns[0].ts) / 3.6e6 : 0;
    const bandRows = bandRowsFor(identity);
    const wallSize = wallSizeFor(identity);
    const shipped = calibrate(columns, rowWidth, columnMs, { bandRows, wallSize }, OPTIONS);
    console.log(`## ${name}: ${columns.length} columns over ${num(spanH)} h, rows of ${rowWidth}, band ${bandRows} rows, typical move ${num(shipped.typicalMove * 1e4)} bp, baseline ${pct(shipped.baseline, 1)}\n`);
    console.log(`Scales: median band ${num(shipped.typicalBand, 2)}, big band (p95) ${num(shipped.bigBand, 1)}, typical wall (median column-biggest) ${num(shipped.typicalWall, 1)}.`);
    console.log(`Shipped floor ${wallSize} is ${num(wallSize / shipped.typicalBand)}x the median band, ${num(wallSize / shipped.bigBand, 2)}x the big band, ${num(wallSize / shipped.typicalWall, 2)}x the typical wall.\n`);
    console.log("| wall size | size | walls | strong | reversed | broke | flat |");
    console.log("| --- | --- | --- | --- | --- | --- | --- |");
    console.log(row("shipped", wallSize, shipped));
    for (const share of SHARES) {
      const size = share * shipped.typicalWall;
      console.log(row(`${share}x typical wall`, size, calibrate(columns, rowWidth, columnMs, { bandRows, wallSize: size }, OPTIONS)));
    }
    console.log("");
  }
}
