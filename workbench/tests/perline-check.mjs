// Marking some lines and not others, in one placeholder.
//
// The ribbon carries two triplets of the same three glyphs: one sets the
// whole placeholder, one marks only the lines the selection touches. The
// second worked and was reported as broken three times, because the two
// were labelled "list" and "line" -- four letters each, both starting
// "li" -- on identical buttons thirty pixels apart. Authors pressed the
// first and got the whole box.
//
// So this checks both: that each does its own job, and that they can be
// told apart. It also reads the committed file, because the canvas can
// show a marker the saved deck does not carry.
//
// The file this replaced was a copy of no-loss-check under another name,
// which is how a working feature came to have no test at all.
//
//   node tests/perline-check.mjs
//
// Needs a site-shaped build (see create-check.mjs).

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://127.0.0.1:8898/workbench/";

const FILES = {
  "course.yaml": "id: v\ntitle: V130\nstructure:\n  - block: 01-misuse\n",
  "competencies/framework.yaml": "competencies:\n  C1:\n    label: Ethics\n",
  "outcomes.yaml": "outcomes:\n  O1:\n    statement: s\n    block: 01-misuse\n    develops: [C1]\n",
  "blocks/01-misuse/block.yaml": "title: Misuse\nduration_minutes: 90\nresources: []\n",
  "blocks/01-misuse/slides.md": [
    "---", "session: '01'", "title: Misuse", "version: 1.0.0", "---", "",
    "--- slide", "id: s-01", "layout: Full", "title: Opening",
    "full:", "  type: p", "  text: |-", "    A lead-in line",
    "    The first point", "    The second point", "    A closing line",
    "---", "",
  ].join("\n"),
  "layout-map.yaml": "Full:\n  layout: Full\n  regions:\n    title: 0\n    full: 1\n",
};
FILES["layout-geometry.json"] = JSON.stringify({
  slide: { widthEmu: 9144000, heightEmu: 6858000, aspect: 1.33333, widthPt: 720 },
  theme: { bg1: "#FFFFFF", tx1: "#000000", accent1: "#4F81BD", accent2: "#C0504D" },
  layouts: {
    Full: {
      layoutName: "Full",
      regions: {
        title: { idx: 0, x: 0.06, y: 0.07, w: 0.88, h: 0.15, type: "title",
          style: { align: "l", sizePt: 32 }, inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 } },
        full: { idx: 1, x: 0.06, y: 0.27, w: 0.88, h: 0.6, type: "body",
          style: { align: "l", sizePt: 20 }, inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 } },
      },
    },
  },
});

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

const repo = new Map(Object.entries(FILES));
const blobs = [];
await page.route("https://api.github.com/**", (route) => {
  const req = route.request(); const url = req.url(); const method = req.method();
  const body = () => { try { return JSON.parse(req.postData() || "{}"); } catch { return {}; } };
  const json = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
  if (url.includes("/git/matching-refs/heads/")) return json([]);
  if (url.endsWith("/user") && method === "GET") return json({ login: "tester" });
  if (url.includes("/user/repos")) return json([]);
  if (/\/repos\/tester\/[^/]+$/.test(url) && method === "GET") return json({ default_branch: "main", permissions: { push: true } });
  if (url.includes("/git/ref")) return method === "GET" ? json({ object: { sha: "p1" } }) : json({});
  if (url.includes("/git/trees/")) return json({ truncated: false, tree: [...repo.keys()].map((p) => ({ path: p, type: "blob" })) });
  if (url.includes("/git/blobs") && method === "POST") { blobs.push(body()); return json({ sha: `b${blobs.length}` }); }
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
await page.waitForSelector("#signed-in:not([hidden])");
await page.fill("#manual-repo", "tester/v130");
await page.click("#open-manual");
await page.waitForSelector("#workspace");
await page.waitForTimeout(1200);

const groups = await page.evaluate(() => ({
  labels: [...document.querySelectorAll("#ribbon .ribbon-label")].map((l) => l.textContent),
  list: [...document.querySelectorAll(".mark.list")].map((b) => b.dataset.list),
  line: [...document.querySelectorAll(".mark.line-marker")].map((b) => b.dataset.marker),
  // The two groups must not look the same. A tint an eye catches before
  // it reads the label is the difference.
  tinted: (() => {
    const one = document.querySelector(".mark.list");
    const two = document.querySelector(".mark.line-marker");
    if (!one || !two) return false;
    return getComputedStyle(one).backgroundColor !== getComputedStyle(two).backgroundColor;
  })(),
}));
console.log("ribbon:", JSON.stringify(groups));

/** Click the region for real, then select one line inside it. */
async function selectLine(text) {
  await page.click('#canvas .region[data-region="full"]');
  await page.waitForTimeout(200);
  return page.evaluate((wanted) => {
    const box = document.querySelector('#canvas .region[data-region="full"]');
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    const node = texts.find((t) => t.data.includes(wanted));
    if (!node) return null;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.data.length);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString();
  }, text);
}

const committed = () => repo.get("blocks/01-misuse/slides.md") ?? "";
const regionOf = async () =>
  page.evaluate(async (text) => {
    const { parseSlides } = await import("./library.js");
    return parseSlides(text).slides[0]?.data?.full ?? null;
  }, committed());

// 1. One line, marked on its own.
console.log("selected:", JSON.stringify(await selectLine("The first point")));
await page.click('.mark.line-marker[data-marker="bullet"]');
await page.waitForTimeout(400);
await page.click("#save");
await page.waitForTimeout(1800);
const one = await regionOf();
console.log("after marking one line:", JSON.stringify(one));

// 2. A second line, a different marker. One placeholder, three kinds of
//    line — the thing the whole split exists for.
console.log("selected:", JSON.stringify(await selectLine("The second point")));
await page.click('.mark.line-marker[data-marker="number"]');
await page.waitForTimeout(400);
await page.click("#save");
await page.waitForTimeout(1800);
const two = await regionOf();
console.log("after marking a second:", JSON.stringify(two));

// 3. The other triplet still does its own job: everything, at once.
//    Numbered, not bulleted -- per-line marking has already made the
//    region a `ul`, so asking for `ul` again is correctly a no-op and
//    would prove nothing.
await page.click('#canvas .region[data-region="full"]');
await page.waitForTimeout(200);
await page.click('.mark.list[data-list="ol"]');
await page.waitForTimeout(400);
const said = await page.textContent("#status");
await page.click("#save");
await page.waitForTimeout(1800);
const whole = await regionOf();
console.log("after the whole-box bullet:", JSON.stringify(whole));
console.log("and it said:", JSON.stringify(said));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const markers = (r) => (r?.items ?? []).map((i) => i.marker ?? "none");
const texts = (r) => (r?.items ?? []).map((i) => i.text);

const failed =
  errors.length > 0 ||
  // Told apart by label and by sight.
  !groups.labels.includes("whole box") ||
  !groups.labels.includes("selected lines") ||
  !groups.tinted ||
  // One line marked, the rest untouched.
  JSON.stringify(markers(one)) !== JSON.stringify(["none", "bullet", "none", "none"]) ||
  // Two lines, differently — in one placeholder.
  JSON.stringify(markers(two)) !== JSON.stringify(["none", "bullet", "number", "none"]) ||
  // Nothing was lost along the way.
  JSON.stringify(texts(two)) !==
    JSON.stringify(["A lead-in line", "The first point", "The second point", "A closing line"]) ||
  // The whole-box control still takes the whole box.
  whole?.type !== "ol" ||
  markers(whole).some((m) => m === "number") ||
  // ...and points at the other one, since that is the confusion.
  !/selected lines/.test(said ?? "");

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
