// One typo must not stop the workbench.
//
// Reported: "can not read a block mapping entry; a multiline key may not
// be an implicit key (22:1)" -- a stray "F" on a line of its own in
// course.yaml, and the whole workbench refused to open. Kept as an
// unsaved draft, it came back on every reload.
//
// What must hold: the library opens with the broken file set aside; the
// banner names the file, the line and what is on it, in plain words; a
// deck whose file will not parse is never offered to Save as an empty
// one; nothing may overwrite a broken file except the fixer; and fixing
// the line brings back what the file holds.
//
//   node tests/broken-check.mjs   (site-shaped build, as create-check.mjs)

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8890/workbench/";
const DECK = ["---", "session: '01'", "title: Misuse", "version: 1.0.0", "---", "",
  "--- slide", "id: s-01", "layout: Full", "title: Opening", "---", ""].join("\n");
const FILES = {
  "course.yaml": [
    "id: v", "title: V130", "structure:",
    "  - title: Week1", "    children:", "      - block: 01-misuse",
    "  - title: Week2", "    children: []",
    "F",
    "  - block: 02-broken", "",
  ].join("\n"),
  "blocks/01-misuse/block.yaml": "title: Misuse\nresources: []\n",
  "blocks/01-misuse/slides.md": DECK,
  "blocks/02-broken/block.yaml": "title: Broken deck\nresources: []\n",
  "blocks/02-broken/slides.md": "---\nsession: [\n---\n\n--- slide\nid: s-01\nlayout: Full\n---\n",
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
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("response", (r) => {
  if (r.status() === 404 && r.url().startsWith(new URL(BASE).origin)) errors.push(`404: ${r.url()}`);
});

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
await page.waitForTimeout(500);

const opened = await page.evaluate(() => ({
  banner: document.getElementById("broken").hidden ? null : document.getElementById("broken").innerText,
  sessions: [...document.querySelectorAll("#outline .block:not(.course-entry) .block-head")].map((h) => h.textContent),
  dirty: document.getElementById("dirty").textContent,
}));
console.log("opened:", JSON.stringify(opened));

// The broken deck: an explanation where the slides would be, not an
// empty canvas -- and still nothing to save.
await page.locator("#outline .block-head", { hasText: "Broken deck" }).click();
await page.waitForTimeout(300);
const brokenDeck = await page.evaluate(() => ({
  says: document.getElementById("document").innerText,
  canvasShown: !document.getElementById("slidesview").hidden,
  dirty: document.getElementById("dirty").textContent,
}));
console.log("broken deck:", JSON.stringify(brokenDeck));

// A structured editor trying to write the broken course.yaml is refused.
await page.click(".course-entry .block-head");
await page.waitForTimeout(300);
const before = await page.evaluate(() => document.getElementById("dirty").textContent);
await page.evaluate(() => {
  const title = [...document.querySelectorAll("input")].find((i) => i.value === "" && /module called/i.test(i.placeholder));
  if (title) { title.value = "Renamed"; title.dispatchEvent(new Event("input", { bubbles: true })); }
});
await page.waitForTimeout(200);
const refused = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  dirty: document.getElementById("dirty").textContent,
}));
console.log("refused:", JSON.stringify(refused));

// Fix it: the bad line is selected; deleting it brings Week1/Week2 back.
await page.locator("#broken button", { hasText: "Fix it" }).first().click();
await page.waitForSelector("#broken .fixer textarea");
const selected = await page.evaluate(() => {
  const a = document.querySelector("#broken .fixer textarea");
  return a.value.slice(a.selectionStart, a.selectionEnd);
});
await page.evaluate(() => {
  const a = document.querySelector("#broken .fixer textarea");
  a.value = a.value.replace("\nF\n", "\n");
  a.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(400);
const fixed = await page.evaluate(() => ({
  banner: document.getElementById("broken").hidden ? null : document.getElementById("broken").innerText,
  groupings: [...document.querySelectorAll("#outline .grouping-title")].map((g) => g.textContent),
  status: document.getElementById("status").textContent,
  dirty: document.getElementById("dirty").textContent,
}));
console.log("selected:", JSON.stringify(selected), "fixed:", JSON.stringify(fixed));

if (errors.length) console.log("errors:", errors.slice(0, 5));
const failed =
  errors.length > 0 ||
  !opened.banner ||
  !/course\.yaml, line 9 \(“F”\): this line isn't in “name: value” form/.test(opened.banner) ||
  !/02-broken\/slides\.md, line 2/.test(opened.banner) ||
  JSON.stringify(opened.sessions.sort()) !== JSON.stringify(["Broken deck", "Misuse"]) ||
  opened.dirty !== "no changes" ||
  !/can't be shown/.test(brokenDeck.says) || brokenDeck.canvasShown || brokenDeck.dirty !== "no changes" ||
  !/Not changed: course\.yaml can't be read yet/.test(refused.status) || refused.dirty !== before ||
  selected !== "F" ||
  !fixed.banner || /course\.yaml/.test(fixed.banner) || !/slides\.md/.test(fixed.banner) ||
  JSON.stringify(fixed.groupings) !== JSON.stringify(["Week1", "Week2"]) ||
  !/reads cleanly again/.test(fixed.status) ||
  fixed.dirty !== "1 file changed";
console.log(failed ? "FAIL" : "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
