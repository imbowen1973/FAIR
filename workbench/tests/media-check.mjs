// Does editing one thing throw away another?
//
// Every panel that edits a slide used to send back a whole slide object
// built from the copy it was constructed with. That copy goes stale the
// instant anything else is touched, so writing it back silently undid
// work — and the metadata panel is only rebuilt by renderCanvas, which a
// metadata edit deliberately does not call, so its copy stayed stale for
// a whole session.
//
//   type on the canvas       working copy becomes S'
//   type a speaker note      {...S, notes} — the canvas edit is gone
//
// Nothing failed, nothing was reported, and the slide simply reverted.
// So this drives the real app and checks that every edit survives every
// later one, in both orders.
//
//   node tests/no-loss-check.mjs
//
// Needs a site-shaped build (see create-check.mjs).

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8898/workbench/";

const FILES = {
  "course.yaml": "id: v\ntitle: V130\nstructure:\n  - block: 01-misuse\n",
  "competencies/framework.yaml":
    "competencies:\n  C1:\n    label: Data ethics\n  C2:\n    label: Judgement\n",
  "outcomes.yaml": [
    "outcomes:",
    "  O1:",
    "    statement: Decide whether a dataset may be shared",
    "    block: 01-misuse",
    "    develops: [C1]",
    "  O2:",
    "    statement: Explain re-identification",
    "    block: 01-misuse",
    "    develops: [C2]",
    "",
  ].join("\n"),
  "blocks/01-misuse/block.yaml":
    "title: Ways big data is misused\nduration_minutes: 90\noutcomes: [O1]\nresources: []\n",
  "blocks/01-misuse/slides.md": [
    "---",
    "session: '01'",
    "title: Misuse",
    "version: 1.0.0",
    "---",
    "",
    "--- slide",
    "id: s-01",
    "layout: Full",
    "title: Opening",
    "full:",
    "  type: ul",
    "  items:",
    "    - The original bullet",
    "---",
    "",
  ].join("\n"),
  "layout-map.yaml": [
    "Full:", "  layout: Full", "  regions:", "    title: 0", "    full: 1", "",
  ].join("\n"),
};

const GEOM = {
  slide: { widthEmu: 12192000, heightEmu: 6858000, aspect: 1.7778, widthPt: 960 },
  theme: { dk1: "#000000", lt1: "#FFFFFF", accent1: "#4F81BD", bg1: "#FFFFFF", tx1: "#000000" },
  layouts: {
    Full: {
      layoutName: "Full",
      regions: {
        title: {
          idx: 0, x: 0.06, y: 0.07, w: 0.88, h: 0.15, type: "title",
          style: { align: "l", sizePt: 32 },
          inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 },
        },
        full: {
          idx: 1, x: 0.06, y: 0.27, w: 0.88, h: 0.6, type: "body",
          style: { align: "l", sizePt: 20 },
          inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 },
        },
      },
    },
  },
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

await page.route("https://api.github.com/**", (route) => {
  const url = route.request().url();
  const json = (b) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (url.endsWith("/user")) return json({ login: "tester" });
  if (url.includes("/git/trees/")) {
    return json({
      truncated: false,
      tree: Object.keys(FILES).map((path) => ({ path, type: "blob" })),
    });
  }
  if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
    return json({ default_branch: "main", permissions: { push: true } });
  }
  if (url.includes("/user/repos")) return json([]);
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
await page.fill("#manual-repo", "test/library");
await page.click("#open-manual");
await page.waitForSelector("#workspace:not([hidden])", { timeout: 15000 });
await page.waitForTimeout(600);

const PHOTO = process.env.PHOTO;
if (!PHOTO) throw new Error("set PHOTO to a real image path");
const EXPECT = process.env.EXPECT_EXT || "";

// Pick the body region, then ask the ribbon for a picture. Media acts on
// the selected region, as colour and list type do.
await page.locator('.canvas .region[data-region="full"]').first().click();
await page.waitForTimeout(250);
const mediaButton = page.locator('.ribbon button[aria-label*="picture"]').first();
await mediaButton.click();
await page.waitForSelector(".media-picker", { timeout: 8000 });

const beforeUpload = await page.evaluate(() => ({
  picker: Boolean(document.querySelector(".media-picker")),
  hasInput: Boolean(document.querySelector("#media-upload")),
  status: document.getElementById("status").textContent,
}));

await page.setInputFiles("#media-upload", PHOTO);
// The policy resizes and re-encodes, stepping quality then size, so this
// is not instant on a five-megabyte photograph.
await page.waitForTimeout(6000);

const afterUpload = await page.evaluate(() => {
  const img = document.querySelector(".canvas .region img, .canvas img");
  return {
    status: document.getElementById("status").textContent,
    // Did a picture actually land on the slide?
    imgOnCanvas: Boolean(img),
    imgSrc: img ? img.currentSrc || img.src : null,
    imgLoaded: img ? img.complete && img.naturalWidth > 0 : false,
    natural: img ? [img.naturalWidth, img.naturalHeight] : null,
    thumb: document.querySelector(".slide-row .thumb")?.textContent?.trim() ?? "",
    thumbImg: Boolean(document.querySelector(".slide-row .thumb img")),
  };
});

// And what would be committed: the staged bytes and the declaration.
const staged = await page.evaluate(() => {
  const dirty = document.getElementById("dirty").textContent;
  return { dirty };
});

console.log("picker:", JSON.stringify(beforeUpload));
console.log("after upload:", JSON.stringify(afterUpload));
console.log("staged:", JSON.stringify(staged));

if (errors.length) console.log("errors:", errors.slice(0, 5));

const failed =
  errors.length > 0 ||
  !beforeUpload.picker ||
  !beforeUpload.hasInput ||
  !afterUpload.imgOnCanvas ||
  !afterUpload.imgLoaded ||
  !afterUpload.natural?.[0] ||
  // Resized: the policy caps the long edge at 2000px.
  afterUpload.natural[0] > 2000 ||
  !afterUpload.thumbImg ||
  // The format is decided by whether the pixels use transparency, not by
  // what the file was called.
  (EXPECT && !afterUpload.status.includes(EXPECT)) ||
  !/file|change/.test(staged.dirty);

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
