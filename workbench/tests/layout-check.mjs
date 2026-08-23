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
  "blocks/01-misuse/slides.md":
    "---\nsession: '01'\ntitle: Misuse\nversion: 1.0.0\n---\n\n" +
    "--- slide\nid: s-01\nlayout: Full\ntitle: Opening\nnotes: |\n  Ask the room.\n---\n",
  "layout-map.yaml":
    "Full:\n  layout: Full\n  regions:\n    title: 0\n    full: 1\n",
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

if (errors.length) console.log("errors:", errors.slice(0, 5));

const failed =
  errors.length > 0 ||
  !wide.beside || wide.below || !wide.onScreen || !wide.hasId || !wide.hasNotes ||
  !narrow.below || narrow.beside || !narrow.hasId || !narrow.hasNotes ||
  !media.found || !media.isIcon || media.text !== "" || !media.drawn || !media.clickable;

console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
