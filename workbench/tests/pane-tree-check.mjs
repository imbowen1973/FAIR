// Does the course tree in the PowerPoint pane expand and collapse?
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
      develops: [],
    }))
  ),
  competencies: [],
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

  const before = await state();

  const reachable = await page.evaluate(() => {
    const t = document.querySelector(".twisty:not(.leaf)");
    if (!t) return { found: false };
    const r = t.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      found: true,
      size: [Math.round(r.width), Math.round(r.height)],
      clickable: hit === t || t.contains(hit),
      inTheWay: hit && hit !== t ? hit.className : null,
    };
  });

  // One twisty, twice: open then closed.
  await page.click(".twisty:not(.leaf)");
  await page.waitForTimeout(350);
  const afterOne = await state();
  await page.click(".twisty:not(.leaf)");
  await page.waitForTimeout(350);
  const afterTwo = await state();

  // And one further down, because the path key is positional and a bug
  // in it shows on a child rather than on the root.
  const deepCount = await page.evaluate(
    () => document.querySelectorAll(".twisty:not(.leaf)").length
  );
  let deepOpened = null;
  if (deepCount > 1) {
    await page.evaluate(() => [...document.querySelectorAll(".twisty:not(.leaf)")][1].click());
    await page.waitForTimeout(350);
    deepOpened = await state();
  }

  // The button is pressed here having already opened a twisty by hand,
  // which is the ordinary way to use the tree and exactly the state that
  // used to make it lie: it read "Expand all" and collapsed.
  const label = (await page.textContent("#expand-all")).trim();
  await page.click("#expand-all");
  await page.waitForTimeout(450);
  const expandedAll = await state();
  const afterLabel = (await page.textContent("#expand-all")).trim();
  await page.click("#expand-all");
  await page.waitForTimeout(450);
  const collapsedAll = await state();
  const finalLabel = (await page.textContent("#expand-all")).trim();

  await page.close();

  const first = (s) => s.items[0] ?? {};
  const failed =
    errors.length > 0 ||
    !reachable.found ||
    !reachable.clickable ||
    // One twisty toggles its own item, and changes what is on screen.
    first(before).open === first(afterOne).open ||
    afterOne.rows === before.rows ||
    // ...and puts it back.
    first(afterTwo).open !== first(before).open ||
    afterTwo.rows !== before.rows ||
    // A twisty further down works too.
    (deepCount > 1 && deepOpened.rows <= afterTwo.rows) ||
    // The button must do what it says. Saying "Expand all" and then
    // collapsing is the fault this check exists for.
    label !== "Expand all" ||
    expandedAll.rows <= afterTwo.rows ||
    afterLabel !== "Collapse all" ||
    collapsedAll.rows >= expandedAll.rows ||
    finalLabel !== "Expand all" ||
    // Collapsing leaves the roots open, which is how the pane loads --
    // not an empty panel with nothing to click.
    collapsedAll.rows !== before.rows ||
    collapsedAll.rows === 0;

  return {
    errors,
    problems,
    reachable,
    label,
    afterLabel,
    finalLabel,
    roots: before.items.map((i) => `${i.glyph} ${i.label}`),
    counts: {
      before: before.rows,
      afterOne: afterOne.rows,
      afterTwo: afterTwo.rows,
      deep: deepOpened?.rows ?? null,
      expandedAll: expandedAll.rows,
      collapsedAll: collapsedAll.rows,
    },
    failed,
  };
}

const cases = [
  ["the bundled sample (no course recipe)", await run(null)],
  ["a course recipe, as every library has", await run(WITH_STRUCTURE)],
];

// A library with nothing wrong says nothing; one with an unrenderable
// slide names it, so a deck is never quietly shorter than the library.
const [[, sample], [, course]] = cases;
const problemsWrong =
  sample.problems !== null ||
  !course.problems ||
  !/wp52-25/.test(course.problems) ||
  !/01-intro/.test(course.problems) ||
  !/not listed below/.test(course.problems);

let failed = false;
for (const [name, r] of cases) {
  console.log(`\n--- ${name} ---`);
  console.log("roots:", JSON.stringify(r.roots));
  console.log("twisty:", JSON.stringify(r.reachable));
  console.log("rows:", JSON.stringify(r.counts));
  console.log("problems shown:", JSON.stringify(r.problems));
  console.log(`expand-all: "${r.label}" -> "${r.afterLabel}" -> "${r.finalLabel}"`);
  if (r.errors.length) console.log("errors:", r.errors.slice(0, 4));
  if (r.failed) failed = true;
}
if (problemsWrong) failed = true;

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
