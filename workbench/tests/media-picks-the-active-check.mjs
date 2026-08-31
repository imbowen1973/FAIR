// With two content placeholders, the click is the only thing that says
// which one. Nothing can be inferred and nothing should be guessed: the
// placeholder that is active is where the picture goes.
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

const regions = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("#canvas .region")].map((r) => ({
      region: r.dataset.region ?? null,
      vacant: r.classList.contains("vacant"),
      active: r.classList.contains("active"),
    }))
  );

console.log("slide 1:", JSON.stringify(await regions()));

/** Which region the media panel says it is for, or null if none is open. */
const panelFor = () =>
  page.evaluate(() => {
    const p = document.querySelector(".media-picker");
    if (!p) return null;
    const m = /Picture for ([a-z0-9-]+)/.exec(p.textContent);
    return m ? m[1] : "(unnamed)";
  });

const closePanel = () =>
  page.evaluate(() => document.querySelector(".media-picker")?.closest("#panels > *")?.remove());

const pressPicture = () =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll("#ribbon button")].find((x) =>
      /picture|video/i.test(x.title || x.getAttribute("aria-label") || "")
    );
    b?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    return Boolean(b);
  });

// 1. A filled region: the picture button follows the click.
await page.click('#canvas .region[data-region="left"]');
await page.waitForTimeout(250);
await pressPicture();
await page.waitForTimeout(350);
const afterLeft = await panelFor();
await closePanel();
console.log("clicked left, pressed the button ->", afterLeft);

// 2. An EMPTY placeholder. This is where a picture is usually wanted,
//    and where the selection used not to go.
const vacantNamed = await page.evaluate(
  () => document.querySelector("#canvas .region.vacant")?.dataset.region ?? null
);
await page.click('#canvas .region[data-region="right"]');
await page.waitForTimeout(400);
const selectedAfterVacant = await page.evaluate(
  () => document.querySelector("#canvas .region.active")?.dataset.region ?? null
);
await closePanel();
await page.waitForTimeout(150);
await pressPicture();
await page.waitForTimeout(350);
const afterVacant = await panelFor();
console.log(
  "empty placeholder named:", vacantNamed,
  "| selected after clicking it:", selectedAfterVacant,
  "| button then aimed at:", afterVacant
);

// Put a real picture in it and read what was committed.
await page.setInputFiles(".media-picker input[type=file]", "tests/fixtures/picture.png");
await page.waitForTimeout(1200);
await closePanel();
await page.click("#save");
await page.waitForTimeout(2200);

const committed = repo.get("blocks/01-b/slides.md") ?? "";
const landed = await page.evaluate(async (text) => {
  const { parseSlides } = await import("./library.js");
  const first = parseSlides(text).slides[0]?.data ?? {};
  return {
    keys: Object.keys(first),
    right: first.right ?? null,
    left: first.left ?? null,
    title: first.title ?? null,
  };
}, committed);
console.log("committed slide 1:", JSON.stringify(landed));

if (errors.length) console.log("errors:", errors.slice(0, 5));

const failed =
  errors.length > 0 ||
  // The button follows an ordinary click.
  afterLeft !== "left" ||
  // An empty placeholder is a placeholder: named, selectable, and the
  // thing the button then acts on.
  vacantNamed !== "right" ||
  selectedAfterVacant !== "right" ||
  afterVacant !== "right" ||
  // ...and the picture is committed to it, not to the region clicked
  // before it.
  !landed.right ||
  typeof landed.left !== "string" ||
  landed.left !== "Words on the left" ||
  // Nothing was written under a name this layout has not got.
  // Nothing was written under a name this layout has not got.
  !landed.keys.every((k) => ["id", "layout", "title", "left", "right"].includes(k));

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
