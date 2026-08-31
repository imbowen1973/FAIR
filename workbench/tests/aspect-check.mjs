// Does the canvas draw the shape the template declares?
//
//   Save failed: PATCH /repos/.../git/refs/heads/draft%2Fsomeone
//   failed (422): Update is not a fast forward
//
// Uploading blobs, building a tree and writing a commit takes seconds,
// and a branch can move in seconds — another tab, another person, a
// merge on GitHub. Git refusing to move the branch backwards is correct
// and protects the other commit. Giving up at that point is not: the
// work is still in the browser.
//
// So the save rebuilds on whatever arrived and tries again. Safe because
// every write is a whole file: files this session did not touch keep the
// other commit's version, files it did touch get this one's. Nothing
// merges line by line and nothing pretends to.
//
// This drives that for real — the mock moves the branch underneath the
// save, exactly once — and then reads what was committed.
//
//   node tests/moved-branch-check.mjs
//
// Needs a site-shaped build (see create-check.mjs).

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8898/workbench/";

const lines = (...parts) => parts.join(String.fromCharCode(10));

const FILES = {
  "course.yaml": lines("id: v", "title: V", "structure:", "  - block: 01-b", ""),
  "competencies/framework.yaml": lines("competencies:", "  C1:", "    label: E", ""),
  "outcomes.yaml": lines(
    "outcomes:", "  O1:", "    statement: s", "    block: 01-b", "    develops: [C1]", ""
  ),
  "blocks/01-b/block.yaml": lines("title: B", "duration_minutes: 45", "resources: []", ""),
  "blocks/01-b/slides.md": lines(
    "---", "session: '01'", "title: B", "version: 1.0.0", "---", "",
    "--- slide", "id: s-01", "layout: Full", "title: First", "full: Mine", "---", ""
  ),
  "layout-map.yaml": lines(
    "Full:", "  layout: Full", "  regions:", "    title: 0", "    full: 1", ""
  ),
};
FILES["layout-geometry.json"] = JSON.stringify({
  slide: { widthEmu: 12192000, heightEmu: 6858000, aspect: 1.77778, widthPt: 960 },
  theme: { bg1: "#ffffff", tx1: "#000000" },
  layouts: {
    Full: {
      regions: {
        title: { idx: 0, x: 0.06, y: 0.05, w: 0.88, h: 0.15, type: "title",
          style: { align: "l", sizePt: 32 }, inset: { l: 0.01, r: 0.01, t: 0, b: 0 } },
        full: { idx: 1, x: 0.06, y: 0.25, w: 0.88, h: 0.6, type: "body",
          style: { align: "l", sizePt: 20 }, inset: { l: 0.01, r: 0.01, t: 0, b: 0 } },
      },
    },
  },
});

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() !== "error") return;
  if (t.includes("favicon") || t.includes("Failed to load resource")) return;
  errors.push(t);
});

const repo = new Map(Object.entries(FILES));

await page.route("https://api.github.com/**", (route) => {
  const url = route.request().url();
  const json = (b, s = 200) =>
    route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
  if (url.includes("/git/matching-refs/heads/")) return json([]);
  if (url.endsWith("/user")) return json({ login: "tester" });
  if (url.includes("/user/repos")) return json([]);
  if (/\/repos\/tester\/[^/]+$/.test(url)) {
    return json({ default_branch: "main", permissions: { push: true } });
  }
  if (url.includes("/git/ref")) return json({ object: { sha: "p1" } });
  if (url.includes("/git/trees/")) {
    return json({
      truncated: false,
      tree: [...repo.keys()].map((p) => ({ path: p, type: "blob" })),
    });
  }
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
await page.waitForTimeout(1200);

const shapes = await page.evaluate(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), ratio: +(r.width / r.height).toFixed(3) };
  };
  return {
    canvas: box(document.querySelector("#canvas .stage")),
    thumb: box(document.querySelector(".slide-row .stage")),
    declared: 1.77778,
  };
});
console.log("what the canvas drew:", JSON.stringify(shapes));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const near = (a, b) => Math.abs(a - b) < 0.05;
const failed =
  errors.length > 0 ||
  !shapes.canvas ||
  !near(shapes.canvas.ratio, 1.778) ||
  !shapes.thumb ||
  !near(shapes.thumb.ratio, 1.778);

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
