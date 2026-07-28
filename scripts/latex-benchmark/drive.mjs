import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.BENCH_PORT || "8766");
const runs = Number(process.env.BENCH_RUNS || "3");
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS || String(20 * 60 * 1000));
const resultsPath =
  process.env.BENCH_RESULTS_PATH ||
  path.join(process.cwd(), "results.json");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (msg) => console.log("CONSOLE", msg.type(), msg.text()));
page.on("pageerror", (err) => console.log("PAGEERROR", err.message));

const url = `http://127.0.0.1:${port}/run.html?runs=${encodeURIComponent(String(runs))}`;
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const state = await page.evaluate(() => window.__bench);
  if (state && (state.status === "ok" || state.status === "failed")) {
    fs.writeFileSync(resultsPath, JSON.stringify(state, null, 2) + "\n");
    console.log("FINAL", JSON.stringify(state, null, 2));
    await browser.close();
    process.exit(state.status === "ok" ? 0 : 2);
  }
  await page.waitForTimeout(2000);
}

const state = await page.evaluate(() => window.__bench);
fs.writeFileSync(
  resultsPath,
  JSON.stringify({ status: "timeout", state }, null, 2) + "\n"
);
console.log("TIMEOUT");
console.log(JSON.stringify(state, null, 2));
await browser.close();
process.exit(3);
