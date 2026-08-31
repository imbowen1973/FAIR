// Ctrl+M adds a slide, the way it does in PowerPoint.
//
// The ribbon's picture button acts on the selected region. Two things
// meant the selection was not what the author thought it was:
//
//   an empty placeholder was not a region. The vacant boxes carried no
//   data-region and no selection handler, so clicking the very thing you
//   want a picture in left the selection on whatever was clicked before.
//
//   the selection outlived its slide. activeRegion was set once and kept
//   for the session, so moving to another slide and pressing the button
//   aimed at a placeholder from the last one — which the new layout may
//   not offer at all, giving the renderer a region it refuses.
//
// Both are silent: the picture lands somewhere real, just not where it
// was asked for. So this reads the committed file, not the canvas.
//
//   node tests/media-target-check.mjs
//
// Needs a site-shaped build (see create-check.mjs).

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8898/workbench/";

const GEOM = {
  slide: { widthEmu: 9144000, heightEmu: 6858000, aspect: 1.33333, widthPt: 720 },
  theme: { bg1: "#FFFFFF", tx1: "#000000", accent1: "#4F81BD" },
  layouts: {
    Comparison: {
      layoutName: "Comparison",
      regions: {
        title: { idx: 0, x: 0.06, y: 0.05, w: 0.88, h: 0.12, type: "title",
          style: { align: "l", sizePt: 32 }, inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 } },
        left: { idx: 1, x: 0.06, y: 0.22, w: 0.42, h: 0.62, type: "object",
          style: { align: "l", sizePt: 20 }, inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 } },
        right: { idx: 2, x: 0.52, y: 0.22, w: 0.42, h: 0.62, type: "object",
          style: { align: "l", sizePt: 20 }, inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 } },
      },
    },
  },
};

const lines = (...parts) => parts.join(String.fromCharCode(10));

const FILES = {
  "course.yaml": lines("id: v", "title: V", "structure:", "  - block: 01-b", ""),
  "competencies/framework.yaml": lines("competencies:", "  C1:", "    label: E", ""),
  "outcomes.yaml": lines("outcomes:", "  O1:", "    statement: s", "    block: 01-b", "    develops: [C1]", ""),
  "blocks/01-b/block.yaml": lines("title: B", "duration_minutes: 45", "resources: []", ""),
  "blocks/01-b/slides.md": lines(
    "---", "session: '01'", "title: B", "version: 1.0.0", "---", "",
    "--- slide", "id: s-01", "layout: Comparison", "title: Two columns",
    "left: Words on the left", "---", ""
  ),
  "layout-map.yaml": lines(
    "Comparison:", "  layout: Comparison", "  regions:",
    "    title: 0", "    left: 1", "    right: 2", ""
  ),
};
FILES["layout-geometry.json"] = JSON.stringify(GEOM);

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() !== "error") return;
  if (t.includes("favicon") || t.includes("Failed to load resource")) return;
  errors.push(t);
});
page.on("response", (r) => {
  // A site-shaped build is easy to get wrong, and a missing module
  // silently unwires every handler on the page.
  if (r.status() === 404 && r.url().startsWith(new URL(BASE).origin)) {
    errors.push(`404: ${r.url()}`);
  }
});

const repo = new Map(Object.entries(FILES));
const blobs = [];

await page.route("https://api.github.com/**", (route) => {
  const req = route.request();
  const url = req.url();
  const method = req.method();
  const body = () => {
    try { return JSON.parse(req.postData() || "{}"); } catch { return {}; }
  };
  const json = (b, s = 200) =>
    route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
  if (url.includes("/git/matching-refs/heads/")) return json([]);
  if (url.endsWith("/user") && method === "GET") return json({ login: "tester" });
  if (url.includes("/user/repos")) return json([]);
  if (/\/repos\/tester\/[^/]+$/.test(url) && method === "GET") {
    return json({ default_branch: "main", permissions: { push: true } });
  }
  if (url.includes("/git/ref")) return method === "GET" ? json({ object: { sha: "p1" } }) : json({});
  if (url.includes("/git/trees/")) {
    return json({ truncated: false, tree: [...repo.keys()].map((p) => ({ path: p, type: "blob" })) });
  }
  if (url.includes("/git/blobs") && method === "POST") {
    blobs.push(body());
    return json({ sha: `b${blobs.length}` });
  }
  if (url.includes("/git/trees") && method === "POST") {
    const t = body();
    t.tree.forEach((e, i) => {
      const blob = blobs[blobs.length - t.tree.length + i];
      if (blob && blob.encoding !== "base64") repo.set(e.path, blob.content ?? "");
    });
    return json({ sha: "t1" });
  }
  if (url.includes("/git/commits") && method === "POST") return json({ sha: "c1" });
  if (url.includes("/git/commits/")) return json({ tree: { sha: "base" } });
  if (url.includes("/branches")) return json([{ name: "main" }]);
  return json({});
});

await page.route("https://raw.githubusercontent.com/**", (route) => {
  const path = decodeURIComponent(route.request().url().split(/\/(?:main|draft[^/]*)\//)[1] ?? "");
  return repo.has(path)
    ? route.fulfill({ status: 200, contentType: "text/plain", body: repo.get(path) })
    : route.fulfill({ status: 404, body: "" });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.fill("#pat", "x");
await page.click("#pat-signin");
await page.waitForSelector("#signed-in:not([hidden])", { timeout: 15000 });
await page.fill("#manual-repo", "tester/v");
await page.click("#open-manual");
await page.waitForSelector("#workspace", { timeout: 15000 });
await page.waitForTimeout(900);

const rail = () =>
  page.evaluate(() => ({
    slides: document.querySelectorAll(".slide-row").length,
    on: [...document.querySelectorAll(".slide-row")].findIndex((r) =>
      r.classList.contains("on")
    ),
  }));

const before = await rail();
console.log("as opened:", JSON.stringify(before));

// Typing on a slide, the way an author would be. PowerPoint adds a
// slide from here and so does this.
await page.click('#canvas .region[data-region="left"]');
await page.waitForTimeout(200);
await page.keyboard.press("Control+m");
await page.waitForTimeout(600);
const afterCanvas = await rail();
console.log("Ctrl+M while editing a placeholder:", JSON.stringify(afterCanvas));

// In a form field it must not fire: the deck changing under the caret
// would take the focus with it.
const field = "#meta input";
await page.click(field);
await page.fill(field, "renamed-slide");
await page.keyboard.press("Control+m");
await page.waitForTimeout(500);
const afterField = await rail();
const fieldValue = await page.inputValue(field);
console.log("Ctrl+M in a text field:", JSON.stringify(afterField), "field:", JSON.stringify(fieldValue));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const failed =
  errors.length > 0 ||
  // One more slide, and it is the one now shown.
  afterCanvas.slides !== before.slides + 1 ||
  afterCanvas.on !== before.on + 1 ||
  // Nothing added from a form field, and what was typed is still there.
  afterField.slides !== afterCanvas.slides ||
  fieldValue !== "renamed-slide";

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
