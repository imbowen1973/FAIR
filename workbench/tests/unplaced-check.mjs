// Content in a region the layout has no placeholder for.
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
    Picture: {
      layoutName: "Picture",
      regions: {
        title: { idx: 0, x: 0.06, y: 0.05, w: 0.88, h: 0.15, type: "title",
          style: { align: "l", sizePt: 32 }, inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 } },
        picture: { idx: 1, x: 0.06, y: 0.25, w: 0.6, h: 0.6, type: "picture",
          style: { align: "l", sizePt: 20 }, inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 } },
        caption: { idx: 2, x: 0.7, y: 0.25, w: 0.24, h: 0.6, type: "body",
          style: { align: "l", sizePt: 16 }, inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 } },
      },
    },
  },
};

const lines = (...parts) => parts.join(String.fromCharCode(10));

const FILES = {
  "course.yaml": lines("id: v", "title: V", "structure:", "  - block: 01-b", ""),
  "competencies/framework.yaml": lines("competencies:", "  C1:", "    label: E", ""),
  "outcomes.yaml": lines(
    "outcomes:", "  O1:", "    statement: s", "    block: 01-b", "    develops: [C1]", ""
  ),
  "blocks/01-b/block.yaml": lines("title: B", "duration_minutes: 45", "resources: []", ""),
  // The author's slide, as it sits on the branch: a Picture layout
  // carrying a `full` region, which is what the renderer refuses.
  "blocks/01-b/slides.md": lines(
    "---", "session: '01'", "title: B", "version: 1.0.0", "---", "",
    "--- slide", "id: wp52-25", "layout: Picture", "title: A picture slide",
    "full: Words that have nowhere to go", "---", ""
  ),
  "layout-map.yaml": lines(
    "Picture:", "  layout: Picture", "  regions:",
    "    title: 0", "    picture: 1", "    caption: 2", ""
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

const said = await page.evaluate(() => {
  const note = document.querySelector("#canvas [data-unplaced-regions]");
  return note
    ? { regions: note.dataset.unplacedRegions, text: note.textContent.slice(0, 220) }
    : null;
});
console.log("the slide says:", JSON.stringify(said, null, 1));

const offered = await page.evaluate(() => {
  const b = document.getElementById("fix-unplaced");
  if (!b) return { found: false };
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { found: true, clickable: hit === b || b.contains(hit) };
});
console.log("the way out:", JSON.stringify(offered));

// Move it into the caption, which is where it can go.
await page.click("#fix-unplaced");
await page.waitForSelector(".relayout-panel", { timeout: 8000 });
const choices = await page.evaluate(() =>
  [...document.querySelectorAll(".relayout-panel select")].map((s) => ({
    name: s.name || s.id || "",
    options: [...s.options].map((o) => o.value),
  }))
);
console.log("where it could go:", JSON.stringify(choices));

await page.evaluate(() => {
  const s = document.querySelector(".relayout-panel select");
  s.value = "caption";
  s.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.click(".relayout-panel button.primary");
await page.waitForTimeout(700);

await page.click("#save");
await page.waitForTimeout(2200);
const committed = repo.get("blocks/01-b/slides.md") ?? "";
const after = await page.evaluate(async (text) => {
  const { parseSlides } = await import("./library.js");
  const d = parseSlides(text).slides[0]?.data ?? {};
  return { keys: Object.keys(d), caption: d.caption ?? null, full: d.full ?? null };
}, committed);
console.log("committed:", JSON.stringify(after));

const gone = await page.evaluate(() =>
  Boolean(document.querySelector("#canvas [data-unplaced-regions]"))
);
console.log("still complaining:", gone);

if (errors.length) console.log("errors:", errors.slice(0, 5));

const failed =
  errors.length > 0 ||
  // It has to be said, on the slide, naming the region and the layout.
  !said ||
  said.regions !== "full" ||
  !/Picture/.test(said.text) ||
  !/nothing is lost/i.test(said.text) ||
  // And there has to be a way out of it that is not a text editor.
  !offered.found ||
  !offered.clickable ||
  // The words move, and are still the words.
  after.full !== null ||
  after.caption !== "Words that have nowhere to go" ||
  gone;

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
