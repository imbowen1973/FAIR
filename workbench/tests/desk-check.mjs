// Desktop authoring: the picture panel opens beside the slide, and
// unsaved work survives a reload.
//
// Beside: above the slide, the panel pushed the placeholder being filled
// off the screen, so the picture and its hole could not be seen together.
// Measured as geometry -- the panel to the RIGHT of the canvas and on
// screen at a wide window, above it at a narrow one.
//
// Drafts: every edit was held in memory only, so a reload lost the lot.
// Type into the slide, reload, open the same repository: the text must
// be back, and Save still has something to save.
//
//   node tests/desk-check.mjs        (site-shaped build, as create-check.mjs)

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8890/workbench/";
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
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));

await page.route("https://api.github.com/**", (route) => {
  const url = route.request().url();
  const json = (b) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (url.endsWith("/user")) return json({ login: "t" });
  if (url.includes("/user/repos")) return json([]);
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

async function open() {
  await page.goto(BASE, { waitUntil: "networkidle" });
  // Signed in from the first visit: the token is kept on this device.
  if (await page.isVisible("#pat")) {
    await page.fill("#pat", "x");
    await page.click("#pat-signin");
  }
  await page.waitForSelector("#signed-in:not([hidden]), #workspace:not([hidden])", { timeout: 15000 });
  if (await page.isHidden("#workspace")) {
    await page.fill("#manual-repo", "t/lib");
    await page.click("#open-manual");
  }
  await page.waitForSelector("#workspace:not([hidden])", { timeout: 15000 });
  await page.waitForSelector(".canvas .region");
}

await open();

// ---- the picture panel, wide: beside the slide ------------------------
const picker = async () => {
  // Select the body region, then press Picture.
  await page.click(".canvas .region:not([data-region='title'])", { position: { x: 20, y: 20 } }).catch(() => {});
  await page.evaluate(() => {
    const body = [...document.querySelectorAll(".canvas .region")].find(
      (r) => !(r.textContent || "").includes("Opening")
    );
    body?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  await page.dispatchEvent("#insert-media", "mousedown");
  await page.waitForSelector(".media-picker", { timeout: 5000 });
  return page.evaluate(() => {
    const canvas = document.querySelector(".canvas").getBoundingClientRect();
    const panel = document.querySelector(".media-picker").getBoundingClientRect();
    return {
      beside: panel.left >= canvas.right - 2,
      above: panel.bottom <= canvas.top + 2,
      onScreen: panel.width > 0 && panel.top < innerHeight && panel.bottom > 0,
      slideOnScreen: canvas.top < innerHeight && canvas.bottom > 0,
      inSidebar: Boolean(document.querySelector("#side-panels .media-picker")),
    };
  });
};
const wide = await picker();
console.log("1500px picker:", JSON.stringify(wide));
// The close button closes it.
await page.click(".media-close");
const closed = await page.evaluate(() => !document.querySelector(".media-picker"));

await page.setViewportSize({ width: 1000, height: 900 });
await page.waitForTimeout(300);
const narrow = await picker();
console.log("1000px picker:", JSON.stringify(narrow));
await page.click(".media-close");
await page.setViewportSize({ width: 1500, height: 950 });

// ---- a draft survives a reload -----------------------------------------
const MARK = "Typed before the reload";
await page.evaluate((mark) => {
  const title = [...document.querySelectorAll(".canvas .region")].find((r) =>
    (r.textContent || "").includes("Opening")
  );
  title.focus();
  title.textContent = mark;
  title.dispatchEvent(new InputEvent("input", { bubbles: true }));
}, MARK);
await page.waitForTimeout(900); // past the draft's debounce
const dirtyBefore = await page.textContent("#dirty");
await page.reload({ waitUntil: "networkidle" });
await open();
const after = await page.evaluate((mark) => ({
  back: [...document.querySelectorAll(".canvas .region")].some((r) =>
    (r.textContent || "").includes(mark)
  ),
  dirty: document.getElementById("dirty")?.textContent,
  status: document.getElementById("status")?.textContent,
}), MARK);
console.log("draft:", JSON.stringify({ dirtyBefore, ...after }));

if (errors.length) console.log("errors:", errors.slice(0, 5));
const failed =
  errors.length > 0 ||
  !wide.beside || !wide.onScreen || !wide.slideOnScreen || !wide.inSidebar ||
  !closed ||
  narrow.beside || !narrow.above || !narrow.onScreen ||
  !after.back || !/changed/.test(after.dirty || "") || !/Restored/.test(after.status || "");
console.log(failed ? "FAIL" : "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
