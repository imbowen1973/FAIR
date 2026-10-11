// A grouping that only repeats the name of the one session inside it.
//
// Reported, with a screenshot: "Week 1 › Foundations of clinical
// teaching › Foundations of clinical teaching" -- the session's title
// twice, because older courses wrapped each session in a grouping of
// its own name. The overview offers to remove those wrappers; the
// sessions must stay exactly where they were, and Undo must bring the
// groupings back. A grouping that is not a mere wrapper is left alone.
//
//   node tests/tidy-check.mjs   (site-shaped build, as create-check.mjs)

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8890/workbench/";
const DECK = ["---", "session: '01'", "title: T", "version: 1.0.0", "---", "",
  "--- slide", "id: s-01", "layout: Full", "title: Opening", "---", ""].join("\n");
const FILES = {
  "course.yaml": [
    "id: ce", "title: Clinical Educator", "structure:",
    "  - title: Week 1", "    children:",
    "      - kind: module", "        title: Foundations of clinical teaching", "        children:",
    "          - block: 01-foundations",
    "  - title: WEEK 2", "    children:",
    "      - kind: module", "        title: Assessment and feedback", "        children:",
    "          - block: 05-feedback",
    "  - title: Week2", "    children: []", "",
  ].join("\n"),
  "blocks/01-foundations/block.yaml": "title: Foundations of clinical teaching\n",
  "blocks/01-foundations/slides.md": DECK,
  "blocks/05-feedback/block.yaml": "title: Feedback that changes practice\n",
  "blocks/05-feedback/slides.md": DECK,
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
await page.waitForSelector(".order-row");

const rail = () => page.evaluate(() => document.getElementById("outline").innerText.replace(/\s+/g, " ").trim());
const before = { offer: await page.evaluate(() => document.querySelector(".tidy-note")?.innerText ?? null), rail: await rail() };
console.log("before:", JSON.stringify(before));
await page.locator(".tidy-note button").click();
await page.waitForTimeout(300);
const after = {
  offer: await page.evaluate(() => document.querySelector(".tidy-note")?.innerText ?? null),
  rail: await rail(),
  dirty: await page.textContent("#dirty"),
};
console.log("after:", JSON.stringify(after));
await page.click("#undo");
await page.waitForTimeout(300);
const undone = { rail: await rail(), offer: await page.evaluate(() => Boolean(document.querySelector(".tidy-note"))) };
console.log("undone:", JSON.stringify(undone));

if (errors.length) console.log("errors:", errors.slice(0, 5));
const twice = (text) => (text.match(/Foundations of clinical teaching/g) || []).length;
const failed =
  errors.length > 0 ||
  !/Foundations of clinical teaching/.test(before.offer ?? "") ||
  // "Assessment and feedback" holds "Feedback that changes practice": a
  // real grouping, not a wrapper, and never offered for removal.
  /Assessment and feedback/.test(before.offer ?? "") ||
  /Week2|WEEK 2|Week 1/.test((before.offer ?? "").split("Remove")[0]) ||
  // The side panel never draws the wrapper: the title once, even before
  // the data is tidied.
  twice(before.rail) !== 1 ||
  after.offer !== null || twice(after.rail) !== 1 ||
  !/Week 1 Foundations of clinical teaching .*WEEK 2 Assessment and feedback Feedback that changes practice Week2/.test(after.rail) ||
  after.dirty !== "1 file changed" ||
  twice(undone.rail) !== 1 || !undone.offer;
console.log(failed ? "FAIL" : "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
