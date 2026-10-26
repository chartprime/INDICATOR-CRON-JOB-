#!/usr/bin/env node
// Takes the standard UX screenshots of the running web app (http://127.0.0.1:8000/, or BASE_URL).
// Usage: node screenshot.cjs <outDir> [indicatorLabel=RSI] [dialogIndicatorLabel=Session VWAP]
// Produces: 01-default.png, 02-<indicator>-zoomed-out.png, 03-<indicator>-zoomed-in.png,
// 04-<dialog>-settings-inputs.png, 05-<dialog>-settings-visibility.png (when the dialog has tabs).
// Playwright and Chromium are preinstalled in this container; never run `playwright install`.
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const outDir = process.argv[2];
const indicatorLabel = process.argv[3] ?? "RSI";
const dialogLabel = process.argv[4] ?? "Session VWAP";
if (!outDir) { console.error("outDir required"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

async function addIndicator(page, label) {
  await page.getByRole("button", { name: /Indicators/ }).click();
  await page.getByLabel("Search indicators").fill(label);
  const row = page.locator(".indicators-row").filter({ hasText: label }).first();
  await row.waitFor();
  if ((await row.getAttribute("aria-pressed")) !== "true") await row.click();
  await page.getByRole("button", { name: "Close indicators" }).click();
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(process.env.BASE_URL ?? "http://127.0.0.1:8000/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".chart-mount canvas", { timeout: 30_000 });
  await page.waitForFunction(() => document.body.innerText.includes("LIVE"), null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, "01-default.png") });

  await addIndicator(page, indicatorLabel);
  await page.waitForTimeout(1200);
  const chart = page.locator(".chart-mount").first();
  const box = await chart.boundingBox();
  const cx = box.x + box.width * 0.6, cy = box.y + box.height * 0.4;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 10; i += 1) await page.mouse.wheel(0, 400); // zoom out
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, `02-${slug(indicatorLabel)}-zoomed-out.png`) });
  for (let i = 0; i < 22; i += 1) await page.mouse.wheel(0, -400); // zoom in
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, `03-${slug(indicatorLabel)}-zoomed-in.png`) });

  await addIndicator(page, dialogLabel);
  await page.waitForTimeout(800);
  const legendRow = page.locator(".indicator-legend-row").filter({ hasText: dialogLabel }).first();
  await legendRow.hover();
  await legendRow.getByRole("button", { name: "Indicator settings" }).click();
  await page.waitForSelector(".indicator-settings-modal");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, `04-${slug(dialogLabel)}-settings-inputs.png`) });
  const visibilityTab = page.getByRole("tab", { name: "Visibility" });
  if (await visibilityTab.count()) {
    await visibilityTab.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, `05-${slug(dialogLabel)}-settings-visibility.png`) });
  }
  console.log("legend rows:", await page.locator(".indicator-legend-row").allInnerTexts());
  console.log("status:", (await page.locator(".status-chip").allInnerTexts()).join(" | "));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
