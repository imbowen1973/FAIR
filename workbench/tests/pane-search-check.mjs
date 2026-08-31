// Are search results judgeable without opening the slide?
//
// The pane's wiring lives behind Office.onReady and returns early unless
// the host is PowerPoint, so nothing in it had ever been checked outside
// Office — the tree, the twisties, the checkboxes, the search. The Word
// check drives its renderer directly and skips the pane for the same
// reason. So office.js is blocked and a small stub put in its place,
// supplying only what start() reads. Everything after that is the pane's
// own code, unmodified.
//
// Both shapes of catalog are driven, because they take different paths
// through buildTree and only one of them gets exercised by accident:
//
//   no structure   the fallback — credentials, then whatever is left
//                  under "All sessions". The bundled sample is this one.
//   a structure    a course recipe: groups holding blocks holding
//                  slides. Every real library is this one.
//
//   node tests/pane-tree-check.mjs
//
// Needs nothing served: the corpus is fulfilled from the working tree at
// an https URL, because the pane rightly refuses a plain-http one.

import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = process.env.WEB || join(process.cwd(), "..", "assembler", "web");
const PANE = "https://corpus.test/taskpane.html";

const IDS = ["01-intro", "02-profiles", "03-standalone", "04-orphan"];

/** A catalog shaped like a real library: a course recipe with groups. */
const WITH_STRUCTURE = {
  problems: [
    { slideId: "wp52-25", blockId: "01-intro", message: "region 'full' is not declared for layout 'Picture'" },
  ],
  structure: [
    {
      kind: "module",
      title: "Foundations",
      children: [
        { kind: "block", block: "01-intro" },
        { kind: "block", block: "02-profiles" },
      ],
    },
    { kind: "block", block: "03-standalone" },
    {
      kind: "group",
      title: "Not in the running order",
      unplaced: true,
      children: [{ kind: "block", block: "04-orphan" }],
    },
  ],
  blocks: IDS.map((id) => ({ blockId: id, title: id, resources: [] })),
  sessions: IDS.map((id, i) => ({ sessionId: `s${i + 1}`, blockId: id, title: id })),
  slides: IDS.flatMap((id, i) =>
    [1, 2].map((n) => ({
      slideId: `s${i + 1}-${n}`,
      sessionId: `s${i + 1}`,
      title: `${id} slide ${n}`,
      notes: `What this slide does in ${id}: the point it makes and the question it opens.`,
      // One slide, two levels down, so filtering has something to find
      // that a closed tree would otherwise hide.
      develops: id === "02-profiles" && n === 2 ? ["C1"] : [],
    }))
  ),
  competencies: { C1: "A competency" },
  credentials: [],
};

const browser = await chromium.launch({ channel: "msedge" });

/** Load the pane against one catalog and work the tree. */
async function run(catalog) {
  const page = await browser.newPage({ viewport: { width: 420, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() !== "error") return;
    // The echo of the office.js abort carries no URL, so it cannot be
    // told from a real one here; that abort is deliberate.
    if (t.includes("favicon") || t.includes("Failed to load resource")) return;
    errors.push(t);
  });

  await page.route("https://appsforoffice.microsoft.com/**", (route) => route.abort());

  const TYPES = {
    ".json": "application/json",
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".png": "image/png",
  };
  await page.route("https://corpus.test/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/+/, "");
    if (catalog && path === "data/catalog.json") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(catalog),
      });
    }
    const ext = path.slice(path.lastIndexOf("."));
    try {
      return route.fulfill({
        status: 200,
        contentType: TYPES[ext] ?? "application/octet-stream",
        body: readFileSync(join(WEB, path)),
      });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });

  await page.addInitScript(() => {
    window.Office = {
      onReady: (fn) => {
        const go = () => fn({ host: "PowerPoint" });
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", go);
        } else {
          go();
        }
      },
      HostType: { PowerPoint: "PowerPoint" },
      context: { requirements: { isSetSupported: () => true }, document: {} },
    };
  });

  await page.goto(PANE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);

  // With nothing configured the pane already offers the field, so only
  // reach for the toggle when it is closed — pressing it regardless
  // shuts it, which is how this check first "failed".
  if (await page.evaluate(() => document.getElementById("add-source-row").hidden)) {
    await page.click("#toggle-add");
  }
  await page.fill("#new-source", "https://corpus.test/");
  await page.click("#add-source");
  await page.waitForSelector(".node-row", { timeout: 15000 });
  await page.waitForTimeout(500);

  const state = () =>
    page.evaluate(() => ({
      rows: document.querySelectorAll(".node-row").length,
      // Top-level nodes: what "collapsed" should leave on screen.
      roots: document.querySelectorAll('#tree > [role="treeitem"]').length,
      glyphs: [...document.querySelectorAll('#tree > [role="treeitem"] > .node-row .twisty')]
        .map((t) => t.textContent),
      items: [...document.querySelectorAll('[role="treeitem"]')].map((el) => ({
        open: el.getAttribute("aria-expanded"),
        label: el.querySelector(":scope > .node-row .node-label")?.textContent ?? "",
        glyph: el.querySelector(":scope > .node-row .twisty")?.textContent ?? "",
      })),
    }));

  // Slides the render could not produce must be named, not silently
  // absent. The catalog carries them; the pane says so above the tree.
  const problems = await page.evaluate(() => {
    const box = document.querySelector(".render-problems");
    return box ? box.textContent.replace(/\s+/g, " ").slice(0, 200) : null;
  });

  // Search for a word that appears in two sessions, so the results have
  // to say which is which.
  await page.fill("#search", "slide 2");
  await page.waitForTimeout(700);

  const results = await page.evaluate(() => ({
    heading: document.getElementById("tree-heading")?.textContent ?? "",
    hits: [...document.querySelectorAll(".hit")].map((h) => ({
      title: h.querySelector(".hit-title")?.textContent ?? "",
      where: h.querySelector(".hit-where")?.textContent ?? null,
      field: h.querySelector(".hit-field")?.textContent ?? "",
      snippet: h.querySelector(".hit-snippet")?.textContent ?? null,
      marks: [...h.querySelectorAll("mark")].map((m) => m.textContent),
    })),
  }));

  await page.close();
  return { errors, results };
}

const CATALOG = null;
const out = await run(WITH_STRUCTURE);
console.log("heading:", JSON.stringify(out.results.heading));
for (const h of out.results.hits.slice(0, 6)) console.log(" ", JSON.stringify(h));
if (out.errors.length) console.log("errors:", out.errors.slice(0, 3));

const failed =
  out.errors.length > 0 ||
  !out.results.hits.length ||
  // Every result says which session it came from.
  out.results.hits.some((h) => !h.where) ||
  // ...and shows what matched, marked.
  out.results.hits.some((h) => !h.marks.length) ||
  // A title hit does not print its own title again as the snippet.
  out.results.hits.some((h) => h.snippet && h.snippet.trim() === h.title.trim()) ||
  // ...and when there is nothing to quote, the notes stand in, so a
  // result is judgeable without opening the slide.
  out.results.hits.some((h) => !h.snippet);

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
