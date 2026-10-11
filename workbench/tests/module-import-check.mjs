// Importing a module from Markdown, through the real Import tab: paste
// the documented example, preview it, apply it, see the module's
// groupings and sessions in the rail -- and take it all back with Undo.
//
//   node tests/module-import-check.mjs   (site-shaped build, as create-check.mjs)

import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const BASE = process.env.WB || "http://localhost:8890/workbench/";
const EXAMPLE = readFileSync(new URL("./fixtures/module-example.md", import.meta.url), "utf8");
const FILES = {
  "course.yaml": "id: v\ntitle: V130\nstructure:\n  - block: 01-misuse\n",
  "blocks/01-misuse/block.yaml": "title: Misuse\nduration_minutes: 90\nresources: []\n",
  "blocks/01-misuse/slides.md": [
    "---", "session: '01'", "title: Misuse", "version: 1.0.0", "---", "",
    "--- slide", "id: s-01", "layout: Full", "title: Opening",
    "full:", "  type: ul", "  items:",
    "    - Re-identification from anonymised records",
    "    - Bias nobody audits",
    "notes: |", "  Ask the room.", "---", "",
  ].join(String.fromCharCode(10)),
  "layout-map.yaml": [
    "Full:", "  layout: Full", "  regions:",
    "    title: 0", "    full: 1",
    "Comparison:", "  layout: Comparison", "  regions:",
    "    title: 0", "    left: 1", "    right: 2",
    "Title:", "  layout: Title", "  regions:", "    title: 0", "",
  ].join(String.fromCharCode(10)),
  "layout-geometry.json": "{\"slide\": {\"widthEmu\": 12192000, \"heightEmu\": 6858000, \"aspect\": 1.7778, \"widthPt\": 960.0}, \"theme\": {\"dk1\": \"#000000\", \"lt1\": \"#FFFFFF\", \"accent1\": \"#4F81BD\", \"accent2\": \"#C0504D\", \"accent3\": \"#9BBB59\", \"accent4\": \"#8064A2\", \"accent5\": \"#4BACC6\", \"accent6\": \"#F79646\", \"bg1\": \"#FFFFFF\", \"tx1\": \"#000000\"}, \"layouts\": {\"Full\": {\"layoutName\": \"Full\", \"regions\": {\"title\": {\"idx\": 0, \"x\": 0.06, \"y\": 0.07, \"w\": 0.88, \"h\": 0.15, \"type\": \"title\", \"style\": {\"align\": \"l\", \"sizePt\": 32.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}, \"full\": {\"idx\": 1, \"x\": 0.06, \"y\": 0.27, \"w\": 0.88, \"h\": 0.6, \"type\": \"body\", \"style\": {\"align\": \"l\", \"sizePt\": 20.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}}}, \"Comparison\": {\"layoutName\": \"Comparison\", \"regions\": {\"title\": {\"idx\": 0, \"x\": 0.06, \"y\": 0.07, \"w\": 0.88, \"h\": 0.15, \"type\": \"title\", \"style\": {\"align\": \"l\", \"sizePt\": 32.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}, \"left\": {\"idx\": 1, \"x\": 0.06, \"y\": 0.27, \"w\": 0.42, \"h\": 0.6, \"type\": \"body\", \"style\": {\"align\": \"l\", \"sizePt\": 20.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}, \"right\": {\"idx\": 2, \"x\": 0.52, \"y\": 0.27, \"w\": 0.42, \"h\": 0.6, \"type\": \"body\", \"style\": {\"align\": \"l\", \"sizePt\": 20.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}}}, \"Title\": {\"layoutName\": \"Title\", \"regions\": {\"title\": {\"idx\": 0, \"x\": 0.075, \"y\": 0.31, \"w\": 0.85, \"h\": 0.21, \"type\": \"center_title\", \"style\": {\"align\": \"l\", \"sizePt\": 44.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}}}}}",
};

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));

await page.route("https://api.github.com/**", (route) => {
  const url = route.request().url();
  const json = (b) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (url.endsWith("/user")) return json({ login: "t" });
  if (url.includes("/git/trees/")) {
    return json({
      truncated: false,
      tree: Object.keys(FILES).map((path) => ({ path, type: "blob" })),
    });
  }
  if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
    return json({ default_branch: "main", permissions: { push: true } });
  }
  return json({});
});
await page.route("https://raw.githubusercontent.com/**", (route) => {
  const path = decodeURIComponent(route.request().url().split("/main/")[1] ?? "");
  const body = FILES[path];
  return body === undefined
    ? route.fulfill({ status: 404, body: "" })
    : route.fulfill({ status: 200, contentType: "text/plain", body });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.fill("#pat", "x");
await page.click("#pat-signin");
await page.waitForSelector("#signed-in:not([hidden])", { timeout: 15000 });
await page.fill("#manual-repo", "t/lib");
await page.click("#open-manual");
await page.waitForSelector("#workspace:not([hidden])", { timeout: 15000 });

await page.click(".course-entry .block-head");
await page.locator(".tab", { hasText: "Import" }).click();
await page.fill(".module-import-text", EXAMPLE);
await page.click(".module-import-actions button.primary");
await page.waitForSelector(".module-import-plan");
const preview = await page.evaluate(() => ({
  rows: [...document.querySelectorAll(".module-import-plan tr")].map((r) => r.innerText.split("\t")[0] + " " + r.querySelector(".plan-path").textContent),
  apply: document.querySelector(".module-import-result button.primary")?.textContent,
  dirty: document.getElementById("dirty").textContent,
}));
console.log("preview:", JSON.stringify(preview, null, 1));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

await page.click(".module-import-result button.primary");
await page.waitForTimeout(400);
const applied = await page.evaluate(() => ({
  groupings: [...document.querySelectorAll("#outline .grouping-title")].map((g) => g.textContent),
  sessions: [...document.querySelectorAll("#outline .block:not(.course-entry) .block-head")].map((h) => h.textContent),
  module: document.querySelector("#outline .module-head")?.textContent,
  dirty: document.getElementById("dirty").textContent,
  status: document.getElementById("status").textContent,
}));
console.log("applied:", JSON.stringify(applied));

await page.locator("#status button", { hasText: "Undo import" }).click();
await page.waitForTimeout(300);
const undone = await page.evaluate(() => ({
  groupings: document.querySelectorAll("#outline .grouping").length,
  dirty: document.getElementById("dirty").textContent,
  module: document.querySelector("#outline .module-head")?.textContent,
}));
console.log("undone:", JSON.stringify(undone));

if (errors.length) console.log("errors:", errors.slice(0, 5));
const failed =
  errors.length > 0 ||
  preview.rows.length !== 10 || preview.dirty !== "no changes" || !/Apply 10 changes/.test(preview.apply) ||
  JSON.stringify(applied.groupings) !== JSON.stringify(["Foundations of clinical teaching", "Day 1 — the clinic is not a classroom", "Assessment and feedback"]) ||
  !applied.sessions.includes("The clinic is not a classroom") || !applied.sessions.includes("Feedback that changes practice") ||
  applied.module !== "Clinical Educator" || applied.dirty !== "10 files changed" ||
  undone.groupings !== 0 || undone.dirty !== "no changes" || undone.module !== "V130";
console.log(failed ? "FAIL" : "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
