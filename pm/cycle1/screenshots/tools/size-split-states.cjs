#!/usr/bin/env node
// Captures the Size-Split Delta table states the UX notes list
// (pm/cycle2/ux-notes-size-split-delta.md, section 3) from a running web app
// fed by the fixture server in TAPE=size-split mode. The table changes with
// the live minute, so the script polls the three table rows and saves a
// zoomed-out and a zoomed-in screenshot the first time each state appears,
// for up to MINUTES minutes. Optional DARK=1 switches the chart to the dark
// theme first; DIALOGS=1 also shoots the settings dialog (Inputs with Advanced
// closed and open, both with Fixed size selected, and Visibility);
// CONFLICT=1 switches the conflict circles on before polling.
//
// Usage: BASE_URL=http://127.0.0.1:8010/ MINUTES=6 node size-split-states.cjs <outDir> <prefix>
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const outDir = process.argv[2];
const prefix = process.argv[3] ?? "state";
if (!outDir) { console.error("outDir required"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const LABEL = "Size-Split Delta (large vs small)";
const minutes = Number(process.env.MINUTES ?? 6);
const dark = process.env.DARK === "1";
const dialogs = process.env.DIALOGS === "1";
const conflict = process.env.CONFLICT === "1";
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** The state a table reading belongs to, by the UX notes' list; null when it is not one we collect. */
function stateOf(rows) {
  const [a, b, c] = rows;
  if (c.startsWith("Needs live tape · no feed")) return "05-rest-no-feed";
  if (c.startsWith("Tape live · next bar")) return "01-tape-live-next-bar";
  if (c.startsWith("Learning sizes")) return "02-learning-sizes";
  if (a.startsWith("Need ")) return "03-need-valid-bars";
  if (c.startsWith("Tape ") && c.includes("below")) return "04-tape-share-below";
  if (a.includes("confirms")) return "07-large-confirms";
  if (a.includes("lags")) return "08-large-lags";
  if (a.includes("no extreme") || a === "No extreme") return "06-forming-no-extreme";
  return null;
}

async function tableRows(page) {
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll(".draw-table-overlay td, .draw-table-overlay .draw-table-cell, .draw-table-overlay div")];
    const texts = cells.map((cell) => cell.textContent?.trim() ?? "").filter((text) => text.length > 0);
    return texts.slice(0, 3);
  });
}

async function addIndicator(page) {
  await page.getByRole("button", { name: /Indicators/ }).click();
  await page.getByLabel("Search indicators").fill(LABEL);
  const row = page.locator(".indicators-row").filter({ hasText: LABEL }).first();
  await row.waitFor();
  if ((await row.getAttribute("aria-pressed")) !== "true") await row.click();
  await page.getByRole("button", { name: "Close indicators" }).click();
}

async function openSettings(page) {
  const legendRow = page.locator(".indicator-legend-row").filter({ hasText: LABEL }).first();
  await legendRow.hover();
  await legendRow.getByRole("button", { name: "Indicator settings" }).click();
  await page.waitForSelector(".indicator-settings-modal");
  await page.waitForTimeout(300);
}

async function closeSettings(page) {
  const ok = page.locator(".indicator-settings-modal").getByRole("button", { name: /^Ok$/ });
  if (await ok.count()) await ok.click();
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(process.env.BASE_URL ?? "http://127.0.0.1:8000/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".chart-mount canvas", { timeout: 60_000 });
  await page.waitForFunction(() => document.body.innerText.includes("LIVE"), null, { timeout: 60_000 });
  if (dark) await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await addIndicator(page);
  await page.waitForTimeout(1500);
  if (conflict) {
    await openSettings(page);
    await page.getByRole("tab", { name: "Visibility" }).click();
    await page.getByLabel("Show conflict circles").check();
    await closeSettings(page);
    await page.waitForTimeout(1500);
  }
  const chart = page.locator(".chart-mount").first();
  const box = await chart.boundingBox();
  const cx = box.x + box.width * 0.6;
  const cy = box.y + box.height * 0.4;
  const zoom = async (direction, steps) => {
    await page.mouse.move(cx, cy);
    for (let i = 0; i < steps; i += 1) await page.mouse.wheel(0, direction * 400);
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForTimeout(700);
  };

  if (dialogs) {
    await openSettings(page);
    const tierMode = page.locator(".indicator-settings-modal select").first();
    await tierMode.selectOption({ label: "Fixed size" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `${prefix}-dialog-inputs-advanced-closed.png`) });
    const advanced = page.locator(".indicator-settings-modal").getByText(/^Advanced/).first();
    if (await advanced.count()) { await advanced.click(); await page.waitForTimeout(400); }
    await page.screenshot({ path: path.join(outDir, `${prefix}-dialog-inputs-advanced-open.png`) });
    await page.getByRole("tab", { name: "Visibility" }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `${prefix}-dialog-visibility.png`) });
    await page.getByRole("tab", { name: "Inputs" }).click();
    await tierMode.selectOption({ label: "Largest 2% of prints" });
    await closeSettings(page);
    await page.waitForTimeout(1500);
  }

  const seen = new Set();
  const deadline = Date.now() + minutes * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const rows = await tableRows(page);
    const key = rows.join(" | ");
    if (key !== last) { console.log(new Date().toISOString().slice(11, 19), key); last = key; }
    const state = rows.length === 3 ? stateOf(rows) : null;
    const divergence = rows[1]?.startsWith("Divergence") ? "09-divergence-row" : rows[1]?.startsWith("Conflict") ? "10-conflict-row" : null;
    for (const name of [state, divergence].filter(Boolean)) {
      if (seen.has(name)) continue;
      seen.add(name);
      await zoom(1, 10);
      await page.screenshot({ path: path.join(outDir, `${prefix}-${name}-zoomed-out.png`) });
      await zoom(-1, 22);
      await page.screenshot({ path: path.join(outDir, `${prefix}-${name}-zoomed-in.png`) });
      console.log("saved", name, "rows:", key);
    }
    await page.waitForTimeout(4000);
  }
  console.log("states captured:", [...seen].sort().join(", ") || "none");
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
