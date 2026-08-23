// Is the slide's detail beside the slide, or under it?
//
// The rule that was supposed to do this had been dead for some time:
// .meta sat inside the #slidesview wrapper, so it was a grandchild of
// .editor and the grid-column it was given applied to nothing. It looked
// right in the stylesheet and rendered below the fold.
//
// So measure geometry, not stylesheets: is the panel to the RIGHT of the
// canvas, and is it on screen.
//
//   node tests/layout-check.mjs
//
// Needs the same site-shaped build as create-check.mjs.

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
page.on("response", (r) => {
  if (r.status() === 404 && r.url().startsWith(new URL(BASE).origin)) {
    errors.push(`404: ${r.url()}`);
  }
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

const where = () =>
  page.evaluate(() => {
    const canvas = document.querySelector(".canvas").getBoundingClientRect();
    const meta = document.getElementById("meta").getBoundingClientRect();
    const id = document.querySelector("#meta input");
    const notes = document.querySelector("#meta .notes");
    const seen = (r) => r.width > 0 && r.top < innerHeight && r.bottom > 0;
    return {
      beside: meta.left >= canvas.right - 2,
      below: meta.top >= canvas.bottom - 2,
      metaTop: Math.round(meta.top),
      canvasBottom: Math.round(canvas.bottom),
      // Both must actually be rendered, not merely present.
      // Rendered, not necessarily in view: stacked under the slide it is
      // legitimately below the fold, which is the whole point of beside.
      hasId: Boolean(id) && id.getBoundingClientRect().width > 0,
      hasNotes: Boolean(notes) && notes.getBoundingClientRect().width > 0,
      onScreen: seen(meta),
    };
  });

const wide = await where();
console.log("1500px:", JSON.stringify(wide));

await page.setViewportSize({ width: 1150, height: 950 });
await page.waitForTimeout(300);
const narrow = await where();
console.log("1150px:", JSON.stringify(narrow));

// The media button must be an icon, not a box-drawing character.
await page.setViewportSize({ width: 1500, height: 950 });
await page.waitForTimeout(300);
const media = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".ribbon button")].find((x) =>
    (x.getAttribute("aria-label") || "").includes("picture")
  );
  if (!b) return { found: false };
  const svg = b.querySelector("svg.icon");
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    found: true,
    isIcon: Boolean(svg),
    // Nothing left over from the character it replaced.
    text: b.textContent.trim(),
    drawn: svg ? svg.getBBox().width > 8 && svg.getBBox().height > 6 : false,
    clickable: hit === b || b.contains(hit),
  };
});
console.log("media button:", JSON.stringify(media));

// ---- changing a layout must not lose the content -----------------------
//
// Full has `full`; Comparison does not. The old code kept the `full:` key,
// the canvas stopped drawing it, and the renderer refuses an unknown
// region -- so the words vanished and the deck would not build.
const regionText = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".canvas .region")]
      .map((r) => r.textContent.trim())
      .filter(Boolean)
  );

const before = await regionText();
await page.selectOption(".ribbon select.layout", "Comparison");
await page.waitForTimeout(400);
const asked = await page.evaluate(() => {
  const panel = document.querySelector(".relayout-panel");
  if (!panel) return { shown: false };
  const r = panel.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
  return {
    shown: true,
    onScreen: r.top >= 0 && r.top < innerHeight,
    inFront: panel.contains(hit),
    // It has to name the region and say where it would go.
    says: panel.textContent.includes("full"),
    target: panel.querySelector("select")?.value,
  };
});
await page.click(".relayout-panel .primary");
await page.waitForTimeout(400);
const after = await regionText();
console.log("layout change asked:", JSON.stringify(asked));
console.log("regions before:", JSON.stringify(before), "after:", JSON.stringify(after));

// ---- undo ---------------------------------------------------------------
const undoButton = await page.evaluate(() => {
  const b = document.getElementById("undo");
  if (!b) return { found: false };
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { found: true, enabled: !b.disabled, clickable: hit === b || b.contains(hit) };
});
await page.click("#undo");
await page.waitForTimeout(400);
const undone = {
  layout: await page.evaluate(() => document.querySelector(".ribbon select.layout")?.value),
  regions: await regionText(),
};
console.log("undo button:", JSON.stringify(undoButton));
console.log("after undo:", JSON.stringify(undone));

// ---- where the token is kept is a choice, and it is honoured ----------
const store = await page.evaluate(() => {
  const KEY = "fair.wb.token";
  const box = document.getElementById("pat-persist");
  const read = () => ({
    session: sessionStorage.getItem(KEY),
    local: localStorage.getItem(KEY),
  });
  const off = read();
  // Turn it on: the token must move to disk, not be copied to it.
  box.checked = true;
  box.dispatchEvent(new Event("change"));
  const on = read();
  // And back off again: the copy on disk has to go immediately.
  box.checked = false;
  box.dispatchEvent(new Event("change"));
  const back = read();
  return { off, on, back };
});
console.log("token store:", JSON.stringify(store));

if (errors.length) console.log("errors:", errors.slice(0, 5));

const failed =
  errors.length > 0 ||
  !wide.beside || wide.below || !wide.onScreen || !wide.hasId || !wide.hasNotes ||
  !narrow.below || narrow.beside || !narrow.hasId || !narrow.hasNotes ||
  !media.found || !media.isIcon || media.text !== "" || !media.drawn || !media.clickable ||
  !asked.shown || !asked.onScreen || !asked.inFront || !asked.says ||
  asked.target !== "left" ||
  // Nothing was lost. The new layout may add an empty region of its own,
  // which is why this is containment rather than equality.
  !before.every((text) => after.includes(text)) ||
  !undoButton.found || !undoButton.enabled || !undoButton.clickable ||
  // Session only by default; on disk when asked; nowhere stale after.
  !store.off.session || store.off.local ||
  !store.on.local || store.on.session ||
  !store.back.session || store.back.local ||
  undone.layout !== "Full" ||
  !before.every((text) => undone.regions.includes(text)) ||
  // Undo put the deck back as it was, not merely close to it.
  undone.regions.length !== before.length;

console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
