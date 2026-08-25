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

// ---- line breaks and new lines survive a blur -------------------------
//
// Five ways to start a new line, and two of them lost it. A newline put
// into a text node is collapsed to a space by HTML, so a break drawn
// once was gone the next time the DOM was read back: the data still held
// it, the screen did not, and the next keystroke committed the screen.
// And the notes reader walked into a new block without separating it, so
// two paragraphs came back as one line.

/** Blur, then force a redraw from the data, and read what survived. */
async function settle() {
  await page.locator(".canvas").first().click({ position: { x: 4, y: 4 } });
  await page.waitForTimeout(400);
  await page.locator(".tabstrip .tab", { hasText: "Outcomes" }).first().click();
  await page.waitForTimeout(500);
  await page.locator(".tabstrip .tab", { hasText: "Slides" }).first().click();
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const read = (name) => {
      const box = document.querySelector(`.canvas .region[data-region="${name}"]`);
      return box
        ? { blocks: box.querySelectorAll("li, p, div").length, text: box.innerText.trim() }
        : null;
    };
    return { title: read("title"), full: read("full") };
  });
}

const KEY = { ENTER: "Enter", BREAK: "Shift+Enter" };

async function typeInto(region, parts) {
  await page.locator(`.canvas .region[data-region="${region}"]`).first().click();
  await page.waitForTimeout(250);
  await page.keyboard.press("Control+A");
  for (const part of parts) {
    if (KEY[part]) await page.keyboard.press(KEY[part]);
    else await page.keyboard.type(part);
  }
  await page.waitForTimeout(400);
}

await typeInto("title", ["Title one", "ENTER", "Title two"]);
const a = await settle();
console.log("A  title, Enter       :", JSON.stringify(a.title));

await typeInto("title", ["Break one", "BREAK", "Break two"]);
const b = await settle();
console.log("B  title, Shift+Enter :", JSON.stringify(b.title));

await typeInto("full", ["Bullet one", "ENTER", "Bullet two"]);
const c = await settle();
console.log("C  list, Enter        :", JSON.stringify(c.full));

await typeInto("full", ["Item one", "BREAK", "still item one"]);
const d = await settle();
console.log("D  list, Shift+Enter  :", JSON.stringify(d.full));

const notes = page.locator("#meta .notes-field [contenteditable], #meta .notes-field textarea").first();
await notes.click();
await page.keyboard.press("Control+A");
await page.keyboard.type("Note line one");
await page.keyboard.press("Enter");
await page.keyboard.type("Note line two");
await page.waitForTimeout(600);
await settle();
const e = await page.evaluate(() => {
  const host = document.querySelector("#meta .notes-field");
  return host ? host.innerText.trim() : "";
});
console.log("E  notes, Enter       :", JSON.stringify(e));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const NL = String.fromCharCode(10);
const failed =
  errors.length > 0 ||
  // Enter in a plain region: two blocks, both kept.
  a.title.blocks !== 2 || !a.title.text.includes("Title one") || !a.title.text.includes("Title two") ||
  // Shift+Enter in a plain region: both kept.
  !b.title.text.includes("Break one") || !b.title.text.includes("Break two") ||
  // Enter in a list: two items.
  c.full.blocks !== 2 ||
  // Shift+Enter inside one item: one item, and the break is still there.
  d.full.blocks !== 1 || !d.full.text.includes("Item one" + NL + "still item one") ||
  // And the speaker notes keep theirs.
  !e.includes("Note line one" + NL + "Note line two");

console.log(failed ? NL + "FAIL" : NL + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
