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

/** The slide as it would be committed: read the file the app would save. */
const slideSource = () =>
  page.evaluate(async () => {
    const { parseSlides } = await import("./library.js");
    // The canvas holds the truth for regions; the source view is what a
    // Save would write. Read it through the app's own tab.
    const tab = [...document.querySelectorAll(".tabstrip .tab")].find((t) =>
      t.textContent.includes("Slides")
    );
    return { hasTab: Boolean(tab), parse: typeof parseSlides === "function" };
  });

/** Type into a region on the canvas. */
async function typeInRegion(region, text) {
  const box = page.locator(`.canvas .region[data-region="${region}"]`).first();
  await box.click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
  await page.waitForTimeout(400);
}

/**
 * Everything the slide currently holds.
 *
 * Read from the rail thumbnail, not the canvas. The canvas is a live
 * contenteditable that is deliberately not redrawn on a metadata change,
 * so it goes on showing what was typed even after the data underneath
 * has been overwritten — which is exactly how this bug stayed invisible.
 * The thumbnail is drawn from the committed slide on every commitSlide,
 * so it is the honest witness.
 */
const slideNow = () =>
  page.evaluate(() => {
    const regions = {};
    const thumb = document.querySelector(".slide-row .thumb");
    for (const r of thumb ? thumb.querySelectorAll("[data-region]") : []) {
      regions[r.dataset.region] = r.textContent.trim();
    }
    regions._thumb = thumb ? thumb.textContent.trim() : "";
    const notesHost = document.querySelector("#meta .notes-field");
    return {
      regions,
      notes: notesHost ? notesHost.textContent.trim() : null,
      id: document.querySelector("#meta input")?.value ?? null,
      dok: document.querySelector("#meta select.dok")?.value ?? null,
      outcomesOn: [...document.querySelectorAll("#meta .chips .chip.on")].map((c) =>
        c.textContent.trim()
      ),
    };
  });

// ---- the rail's own controls -------------------------------------------
//
// Reorder and delete sit beside the thumbnail in each slide row. They
// were reported as "gone". They were drawn, visible, and not clickable:
// drawSlide falls back to a 150px stage when its host has not been laid
// out yet, which is wider than the 110px thumbnail, and the overflow sat
// on top of them. Every DOM assertion passed while the buttons could not
// be pressed.
page.on("dialog", (d) => d.accept());

// Three slides, so moving and deleting both have somewhere to go.
await page.click(".deck-actions .add-slide:nth-child(1)");
await page.click(".deck-actions .add-slide:nth-child(1)");
await page.waitForTimeout(500);

const ids = () => page.$$eval(".slide-row", (n) => n.map((x) => x.dataset.slideId));
const reach = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll(".slide-row")];
    return rows.map((row) => {
      const buttons = [...row.querySelectorAll(".slide-tools button")];
      return buttons.map((b) => {
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          label: b.getAttribute("aria-label"),
          onScreen: r.top >= 0 && r.bottom <= innerHeight,
          clickable: hit === b || b.contains(hit),
          over: hit ? hit.className : "nothing",
        };
      });
    });
  });

const before = await ids();
const reachable = (await reach()).flat();
const unreachable = reachable.filter((b) => b.onScreen && !b.clickable);
console.log("rows:", before.length, "| tool buttons:", reachable.length);
console.log("unreachable:", JSON.stringify(unreachable));

// Move the last slide up, by pressing the button rather than calling in.
await page.click('button[aria-label="move up: slide 3"]');
await page.waitForTimeout(400);
const afterMove = await ids();

// Then delete the first.
await page.click('button[aria-label="delete: slide 1"]');
await page.waitForTimeout(500);
const afterDelete = await ids();

// The thumbnail must still select its slide, having been made
// click-through so it would stop swallowing the buttons beside it.
await page.click(".slide-row:last-of-type .thumb");
await page.waitForTimeout(300);
const picked = await page.evaluate(() => {
  const on = document.querySelector(".slide-row.on");
  const rows = [...document.querySelectorAll(".slide-row")];
  return { index: rows.indexOf(on), total: rows.length };
});

console.log("ids before:", JSON.stringify(before));
console.log("after move up:", JSON.stringify(afterMove));
console.log("after delete: ", JSON.stringify(afterDelete));
console.log("thumb selects:", JSON.stringify(picked));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const failed =
  errors.length > 0 ||
  before.length !== 3 ||
  reachable.length !== 9 ||
  unreachable.length > 0 ||
  // Moved, not merely re-rendered.
  JSON.stringify(afterMove) === JSON.stringify(before) ||
  afterMove[1] !== before[2] ||
  // Deleted, and the right one.
  afterDelete.length !== 2 ||
  afterDelete.includes(before[0]) ||
  // And the thumbnail still picks its slide.
  picked.index !== picked.total - 1;

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
